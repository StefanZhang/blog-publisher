import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {validateHandoff} from './cn-handoff.mjs';
import {validateManifest, MANIFEST_PATH, LIMITS} from './lib/delivery-manifest.mjs';
import {verifyTargetHealth} from './release/target-policy.mjs';
import {digest} from './release/files.mjs';

const REPO='StefanZhang/blog-publisher', CN='https://stefanzhang.cn';
const WORKFLOW='.github/workflows/publish-preview.yml';
const API='https://api.github.com/repos/'+REPO+'/';
const ID=/^[1-9]\d*$/, SHA=/^[a-f0-9]{40}$/;
function json(bytes){try{return JSON.parse(bytes.toString('utf8'));}catch{throw Error('Malformed JSON response');}}
const bot=value=>value?.creator?.login==='github-actions[bot]' && value.creator.id===41898282 && value.creator.type==='Bot' &&
  (!value.performed_via_github_app || value.performed_via_github_app.slug==='github-actions');
export function assertControllerRun(run,id){
  if(!ID.test(id)||String(run?.id)!==id||run.status!=='completed'||run.conclusion!=='success'||
    !Number.isSafeInteger(run.run_attempt)||run.run_attempt<1||run.head_branch!=='main'||!SHA.test(run.head_sha||'')||
    ![WORKFLOW,'.github/workflows/publish-content.yml'].includes(run.path?.split('@')[0])||run.repository?.full_name!==REPO||run.head_repository?.full_name!==REPO||
    !['schedule','workflow_dispatch'].includes(run.event))throw Error('Controller run identity/complete success mismatch');
  return run;
}
async function bounded(response,limit){
  if(response.status!==200){await response.body?.cancel();throw Error('HTTP '+response.status);}
  if(!response.body)throw Error('Empty HTTP response');
  const chunks=[];let size=0;const reader=response.body.getReader();
  for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;
    if(size>limit){await reader.cancel();throw Error('Response exceeds expected size');}chunks.push(Buffer.from(value));}
  return Buffer.concat(chunks);
}
export async function trustedHandoff(api,id){
  if(!ID.test(id))throw Error('A concrete positive controller run ID is required');
  const run=assertControllerRun(await api('actions/runs/'+id),id);
  const jobs=await api('actions/runs/'+id+'/attempts/'+run.run_attempt+'/jobs?per_page=100');
  const publish=jobs.jobs?.filter(job=>job.name==='publish');
  if(!Array.isArray(publish)||publish.length!==1||publish[0].status!=='completed')throw Error('Cannot identify completed publish job');
  if(publish[0].conclusion==='skipped')return {run,skipped:true};
  if(publish[0].conclusion!=='success')throw Error('Publish job did not succeed');
  // Bound manual historical lookups; no arbitrary URL or unbounded pagination.
  let deployment;
  for(let page=1;page<=3&&!deployment;page++){
    const entries=await api('deployments?environment=cn-pilot&sha='+run.head_sha+'&per_page=100&page='+page);
    if(!Array.isArray(entries)||entries.length>100)throw Error('Invalid deployment listing');
    for(const entry of entries){const p=typeof entry.payload==='string'?json(Buffer.from(entry.payload)):entry.payload;
      if(p?.controllerRun===id&&p?.controllerAttempt===run.run_attempt){deployment={...entry,payload:p};break;}}
    if(entries.length<100)break;
  }
  if(!deployment)throw Error('No CN handoff for this exact controller attempt');
  const p=validateHandoff(deployment.payload);
  if(!Number.isSafeInteger(deployment.id)||deployment.id<1||!bot(deployment)||deployment.environment!=='cn-pilot'||
    deployment.sha!==run.head_sha||deployment.ref!==run.head_sha||p.controllerCommit!==run.head_sha)throw Error('Untrusted CN deployment identity');
  const statuses=await api('deployments/'+deployment.id+'/statuses?per_page=1');
  const status=statuses?.[0];
  if(!Array.isArray(statuses)||statuses.length!==1||!bot(status)||status.state!=='success'||status.environment_url!==CN||
    status.log_url!=='https://github.com/'+REPO+'/actions/runs/'+id+'/attempts/'+run.run_attempt)throw Error('Untrusted CN handoff success status');
  return {run,payload:p,deploymentID:deployment.id};
}

export async function verifyCN({controllerRun,api,policy,request=fetch,now=Date.now,sleep=delay,waitMs=15*60000,pollMs=30000}){
  const receipt={schema:1,scope:'installation-identity',base:CN,controllerRun:ID.test(controllerRun||'')?controllerRun:null,status:'failed',passed:false,
    manifestMatched:false,filesChecked:0,legacyUrlsChecked:0,healthChecked:false,wwwRedirectsChecked:0,failures:[]};
  let phase='controller';
  try{
    if(waitMs<0||waitMs>15*60000||pollMs<=0)throw Error('Invalid bounded wait policy');
    const trusted=await trustedHandoff(api,controllerRun);
    receipt.controllerAttempt=trusted.run.run_attempt;receipt.controllerCommit=trusted.run.head_sha;
    if(trusted.skipped){receipt.status='not-applicable';receipt.passed=null;receipt.verifiedAt=new Date(now()).toISOString();return receipt;}
    const p=trusted.payload;Object.assign(receipt,{sourceRun:p.sourceRun,sourceCommit:p.sourceCommit,artifactHash:p.artifactHash,
      deploymentID:trusted.deploymentID,deploymentURL:p.deploymentURL,manifest:p.manifest});
    if(policy.controllerRepo!==REPO||policy.config?.publicationOrigin!==CN||policy.config?.canonicalOrigin!=='https://stefanzhang.com')throw Error('Unreviewed CN verification policy');
    phase='manifest';let bytes,reason='Manifest has not been installed';const deadline=now()+waitMs;
    for(;;){
      try{
        const response=await request(CN+MANIFEST_PATH,{method:'GET',redirect:'manual',cache:'no-store',headers:{'Cache-Control':'no-cache'},signal:AbortSignal.timeout(20000)});
        const candidate=await bounded(response,p.manifest.bytes);
        if(candidate.length!==p.manifest.bytes||digest(candidate)!==p.manifest.sha256)throw Error('Installed manifest SHA/bytes differ');
        if(!response.headers.get('content-type')?.includes('application/json'))throw Error('Manifest MIME mismatch');
        bytes=candidate;break;
      }catch(error){reason=error.message;}
      if(now()>=deadline)throw Error('CN installation deadline exceeded: '+reason);
      await sleep(Math.min(pollMs,deadline-now()));
    }
    const manifest=validateManifest(json(bytes));
    if(manifest.headersSHA256!==policy.controlHashes?._headers)throw Error('Manifest header profile differs from reviewed policy');
    receipt.manifestMatched=true;
    // The manifest alone cannot prove Nginx serves the matching homepage.
    phase='homepage';const home=manifest.files['index.html'];
    if(!home||home.bytes>LIMITS.fileBytes)throw Error('Manifest lacks a bounded homepage');
    const response=await request(CN+'/',{method:'GET',redirect:'manual',cache:'no-store',signal:AbortSignal.timeout(20000)});
    const body=await bounded(response,home.bytes);
    if(body.length!==home.bytes||digest(body)!==home.sha256||!response.headers.get('content-type')?.includes('text/html'))throw Error('Installed homepage SHA/bytes/MIME differ');
    receipt.filesChecked=1;
    phase='healthz';await verifyTargetHealth({health:true,base:new URL(CN)},request);receipt.healthChecked=true;
    phase='www';
    for(const route of ['/','/701/?cn_install_check=1']){
      const response=await request('https://www.stefanzhang.cn'+route,{method:'GET',redirect:'manual',signal:AbortSignal.timeout(15000)});
      await response.body?.cancel();
      if(![301,308].includes(response.status)||response.headers.get('location')!==CN+route)throw Error('WWW must permanently redirect to apex preserving path/query');
      receipt.wwwRedirectsChecked++;
    }
    phase='controller-recheck';const finalRun=assertControllerRun(await api('actions/runs/'+controllerRun),controllerRun);
    if(finalRun.run_attempt!==trusted.run.run_attempt||finalRun.head_sha!==trusted.run.head_sha)throw Error('Controller run changed after installation verification');
    receipt.status='verified';receipt.passed=true;
  }catch(error){receipt.failures.push({check:phase,error:error.message});}
  receipt.verifiedAt=new Date(now()).toISOString();return receipt;
}

async function main(){
  const env=process.env;
  if(env.GITHUB_REPOSITORY!==REPO||env.GITHUB_REF!=='refs/heads/main'||!['workflow_run','workflow_dispatch'].includes(env.GITHUB_EVENT_NAME)||
    env.GITHUB_WORKFLOW_REF!==REPO+'/.github/workflows/verify-cn.yml@refs/heads/main')throw Error('CN verifier runs only from its trusted main workflow');
  if(!env.GH_TOKEN)throw Error('Missing read-only workflow token');
  const policy=json(await fs.readFile(new URL('../policy.json',import.meta.url)));
  const api=async endpoint=>{
    if(!/^(?:actions\/runs\/[1-9]\d*(?:\/attempts\/[1-9]\d*\/jobs\?per_page=100)?|deployments(?:\?environment=cn-pilot&sha=[a-f0-9]{40}&per_page=100&page=[1-3]|\/[1-9]\d*\/statuses\?per_page=1))$/.test(endpoint))throw Error('Unreviewed read-only API endpoint');
    // Public deployment metadata needs no additional GITHUB_TOKEN permission.
    const headers={Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28',...(endpoint.startsWith('actions/')?{Authorization:'Bearer '+env.GH_TOKEN}:{})};
    return json(await bounded(await fetch(API+endpoint,{headers,redirect:'manual',signal:AbortSignal.timeout(20000)}),2*1024*1024));
  };
  const receipt=await verifyCN({controllerRun:env.CONTROLLER_RUN||'',api,policy});
  await fs.mkdir('.work',{recursive:true});await fs.writeFile('.work/cn-installation-identity.json',JSON.stringify(receipt,null,2)+'\n');
  console.log(JSON.stringify(receipt));
  if(env.GITHUB_STEP_SUMMARY)await fs.appendFile(env.GITHUB_STEP_SUMMARY,
    '\n## CN installation identity: '+receipt.status+'\n\n'+
    'Controller run '+receipt.controllerRun+'. Manifest identity, one homepage, healthz and www redirect only; not full file/route/service acceptance. '+
    'This read-only check never deploys or rolls back. Failed or not-yet-installed results require inspection of the receiver.\n');
  if(receipt.passed===false)process.exitCode=1;
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  try{await main();}catch(error){console.error(error.message);process.exitCode=1;}
}
