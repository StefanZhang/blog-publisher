import fs from 'node:fs/promises';import path from 'node:path';import {spawnSync} from 'node:child_process';
import {downloadArchive} from './archive-source.mjs';
import {readProtection,verifyControllerChecks} from './protection.mjs';
import {assertRun,assertRecord,assertProtection,assertSourceFile} from './policy.mjs';import {checkSeal} from './release/files.mjs';
const policy=JSON.parse(await fs.readFile(new URL('../policy.json',import.meta.url),'utf8'));
const command=process.argv[2], root=path.resolve('.work');
const readToken=process.env.SOURCE_READ_TOKEN, ownToken=process.env.GH_TOKEN;
async function api(endpoint,own=false,body){
 const token=own?ownToken:readToken;if(!token)throw Error('Missing '+(own?'controller GitHub token':'SOURCE_READ_TOKEN'));
 const r=await fetch('https://api.github.com/repos/'+(own?policy.controllerRepo:policy.sourceRepo)+'/'+endpoint,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000)});
 if(!r.ok)throw Error('GitHub API '+r.status+' at '+endpoint.split('?')[0]);return r.json();
}
async function emit(data){
 if(process.env.GITHUB_OUTPUT)for(const[k,v]of Object.entries(data))await fs.appendFile(process.env.GITHUB_OUTPUT,k+'='+v+'\n');
 console.log(JSON.stringify(data));
}
async function protect(){
 if(process.env.GITHUB_REPOSITORY!==policy.controllerRepo||process.env.GITHUB_REF!=='refs/heads/main')throw Error('Publishing runs only on controller main');
 assertProtection(await readProtection(ownToken,policy.controllerRepo),await api('environments/preview',true),policy,process.env.GITHUB_SHA);
 if(command!=='finish')await verifyControllerChecks(ownToken,policy.controllerRepo,process.env.GITHUB_SHA);
}
async function currentRun(){
 const main=(await api('branches/main')).commit.sha;
 const selected=process.env.BUILD_RUN_ID||'latest';
 if(selected!=='latest'&&!/^\d+$/.test(selected))throw Error('Invalid build run ID');
 const run=selected==='latest'?(await api('actions/workflows/deploy.yml/runs?branch=main&status=success&per_page=30')).workflow_runs.find(r=>r.head_sha===main&&['push','workflow_dispatch'].includes(r.event)):await api('actions/runs/'+selected);
 if(!run)return null;assertRun(run,main,policy);return run;
}
async function download(run){
 for(const name of Object.keys(policy.sourceFileHashes)){const file=await api('contents/'+name+'?ref='+run.head_sha);if(file.encoding!=='base64')throw Error('Unexpected source file response');assertSourceFile(name,Buffer.from(file.content,'base64'),policy);}

 const archived=await downloadArchive(run,api,readToken,root);
 const archive=path.join(root,'artifact.zip');
 const release=path.join(root,'release');const child=spawnSync('python3',['scripts/unpack.py',archive,release],{encoding:'utf8'});if(child.status!==0)throw Error('Safe extraction failed: '+child.stderr.slice(-1500));
 const record=await checkSeal(release);const expected=process.env.EXPECTED_HASH||archived.artifactHash;
 if(record.artifactHash!==archived.artifactHash)throw Error('Archived artifact seal mismatch');
 if(!/^[a-f0-9]{64}$/.test(expected))throw Error('Invalid artifact hash');assertRecord(record,policy,run.head_sha,expected);
 const local=JSON.parse(await fs.readFile(path.join(release,'verified-local.json'),'utf8'));
 if(!local.passed||local.kind!=='local'||local.scope!=='static'||local.releaseHash!==record.artifactHash||local.failures?.length!==0)throw Error('Missing successful CI loopback acceptance');
 for(const name of ['legacy-urls.json','query-urls.json'])for(const item of JSON.parse(await fs.readFile(path.join(release,name),'utf8'))){
  for(const value of [item.url,item.target]){const url=new URL(value,policy.previewOrigin);if(!value.startsWith('/')||value.startsWith('//')||value.includes('\\')||url.origin!==policy.previewOrigin)throw Error('Unsafe legacy verification URL');}
 }
 return {record,release};
}
async function summary(text){if(process.env.GITHUB_STEP_SUMMARY)await fs.appendFile(process.env.GITHUB_STEP_SUMMARY,text+'\n');}
async function main(){
 await protect();
 if(command==='finish'){
  const id=process.env.LEDGER_ID;if(!/^\d+$/.test(id||''))return;
  const success=process.env.PUBLISH_RESULT==='success';
  await api('deployments/'+id+'/statuses',true,{state:success?'success':'failure',environment_url:policy.previewOrigin,log_url:process.env.RUN_URL,description:success?'Sealed preview and all static checks passed':'Preview failed or cancelled; inspect run logs'});
  return;
 }
 const run=await currentRun();if(!run){await summary('No successful CI build for current source main. Nothing deployed.');await emit({eligible:false});return;}
 if(command==='inspect'){
  const prior=await api('deployments?environment=preview-request&per_page=100',true);
  const duplicate=prior.find(d=>{const p=typeof d.payload==='string'?JSON.parse(d.payload):d.payload;return String(p?.source_run_id)===String(run.id);});
  if(duplicate&&process.env.RETRY!=='true'){await summary('Build '+run.id+' already requested. No duplicate deployment. Use explicit retry after checking prior run.');await emit({eligible:false});return;}
 }
 const {record}=await download(run);
 if(command==='inspect'){
  const ledger=await api('deployments',true,{ref:process.env.GITHUB_SHA,environment:'preview-request',auto_merge:false,required_contexts:[],transient_environment:true,payload:{source_run_id:String(run.id),source_commit:run.head_sha,artifact_hash:record.artifactHash},description:'Approve sealed blog preview '+run.id});
  await api('deployments/'+ledger.id+'/statuses',true,{state:'queued',log_url:process.env.RUN_URL,description:'Awaiting human preview environment approval'});
  await emit({eligible:true,build_run_id:run.id,source_commit:run.head_sha,artifact_hash:record.artifactHash,ledger_id:ledger.id});
  await summary('## Ready for human preview approval\n\nSource run: https://github.com/'+policy.sourceRepo+'/actions/runs/'+run.id+'\n\nCommit: `'+run.head_sha+'`\n\nArtifact SHA256: `'+record.artifactHash+'`\n\nTarget: '+policy.previewOrigin+'\n\nOnly preview will be updated. No rebuild, production deployment, DNS, D1 or independent Worker changes. CI local acceptance is not remote acceptance.');
 }else if(command==='stage'){
  if(process.env.EXPECTED_COMMIT!==run.head_sha)throw Error('Source main changed after inspection; create a new request');
  await summary('Re-downloaded and checked the exact approved artifact.');
 }else throw Error('Unknown command');
}
try{await main();}catch(error){console.error(error.message);process.exitCode=1;}
