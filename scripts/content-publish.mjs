// Trusted controller: source archives are data, never executable publication scripts.
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {sourceStage} from './source-stage.mjs';
import {readProtection,verifyControllerChecks} from './protection.mjs';
import {assertAutoContext,assertAutoEnvironment,assertContentTree,assertMergeApproval,assertPair,assertRemoteCoverage} from './content-policy.mjs';
import {canonicalIds,assertLikesPolicy,prepareWorker,publishWorker,verifyReadiness,execute} from './likes-deploy.mjs';
import {readCommentPageKeys,verifyServices} from './services.mjs';
import {publicReceipt,deploymentOrigin} from './receipt.mjs';
import {handoffPayload,publishHandoff} from './cn-handoff.mjs';
import {MANIFEST_PATH} from './lib/delivery-manifest.mjs';
import {atomicJson} from './release/files.mjs';
const REPO='StefanZhang/blog-publisher';
const readJSON=file=>fs.readFile(file,'utf8').then(JSON.parse);
const policyFile=name=>readJSON(new URL('../'+name,import.meta.url));
async function summary(env,text){if(env.GITHUB_STEP_SUMMARY)await fs.appendFile(env.GITHUB_STEP_SUMMARY,text+'\n');}
async function output(env,data){if(env.GITHUB_OUTPUT)for(const[k,v]of Object.entries(data))await fs.appendFile(env.GITHUB_OUTPUT,k+'='+v+'\n');}
// Keep ordering testable without Cloudflare credentials or a real publication.
export async function publicationSequence(steps,onPhase=()=>{}) {
  for(const name of ['likes','comPreview','cnPreview','services','comProduction','cnHandoff']) {
    onPhase(name);await steps[name]();
  }
}
export async function main(env=process.env) {
  assertAutoContext(env);
  const mode=process.argv[2];if(!['inspect','publish'].includes(mode)||env.GITHUB_JOB!==mode)throw Error('Invalid auto publication mode');
  const config=await policyFile('content-policy.json');
  if(!config.enabled){await summary(env,'Content automation is staged but NOT enabled. No deployment.');await output(env,{eligible:false});return;}
  if(config.schema!==1||!['https://stefanzhang-com.pages.dev','https://stefanzhang.com'].includes(config.comVerificationBase)||!/^[a-f0-9]{40}$/.test(config.baselineCommit)||!/^[a-f0-9]{64}$/.test(config.codeTreeSHA256)||config.merger!=='StefanZhang'||config.mergerId!==10293941)throw Error('Unreviewed content policy');
  const policies={cn:await policyFile('policy.json'),com:await policyFile('policy.production.json')};
  const stages=Object.fromEntries(Object.entries(policies).map(([target,policy])=>[target,sourceStage({policy,root:path.resolve('.work',target),readToken:env.SOURCE_READ_TOKEN,ownToken:env.GH_TOKEN})]));
  const api=stages.cn.api;
  async function protect(){assertAutoEnvironment(await readProtection(env.GH_TOKEN,REPO),await api('environments/content-auto',true),env.GITHUB_SHA);await verifyControllerChecks(env.GH_TOKEN,REPO,env.GITHUB_SHA);}
  await protect();
  const sourceCommit=(await api('branches/main')).commit.sha;
  if(sourceCommit===config.baselineCommit){await summary(env,'Reviewed baseline itself is not a new content PR. Nothing deployed.');await output(env,{eligible:false});return;}
  if(mode==='publish'&&sourceCommit!==env.EXPECTED_SOURCE)throw Error('Source changed since inspection');
  async function tree(commit){const c=await api('git/commits/'+commit);if(c.sha!==commit||!/^[a-f0-9]{40}$/.test(c.tree?.sha||''))throw Error('Invalid Git tree identity');const t=await api('git/trees/'+c.tree.sha+'?recursive=1');if(t.sha!==c.tree.sha)throw Error('Git tree mismatch');return t;}
  const [baseline,current]=await Promise.all([tree(config.baselineCommit),tree(sourceCommit)]);
  try{assertContentTree(baseline,current,config);}catch(error){if(mode==='publish')throw error;await summary(env,'Automatic publication blocked: '+error.message);await output(env,{eligible:false});return;}
  const runs={cn:await stages.cn.currentRun(),com:await stages.com.currentRun()};
  if(!runs.cn||!runs.com){if(mode==='publish')throw Error('Both target builds must remain successful');await summary(env,'Waiting for both current-main CI builds and private archives.');await output(env,{eligible:false});return;}
  if(runs.cn.head_sha!==sourceCommit||runs.com.head_sha!==sourceCommit)throw Error('Build targets do not match the same main');
  const prior=await api('deployments?environment=dual-request&per_page=100',true);
  const duplicate=prior.find(d=>{const p=typeof d.payload==='string'?JSON.parse(d.payload):d.payload;return p?.sourceCommit===sourceCommit;});
  if(mode==='inspect'&&duplicate&&env.RETRY!=='true'){await summary(env,'This source commit already has a publication attempt. Check its final online result; explicit retry required after failure.');await output(env,{eligible:false});return;}
  const packages={};
  for(const target of ['cn','com']) {
    packages[target]=await stages[target].download(runs[target]);
    assertMergeApproval(await readJSON(path.join(packages[target].release,'reports/merge-approval.json')),runs[target],config);
  }
  assertPair(packages.cn.record,packages.com.record);
  const identity={sourceCommit,cnRun:String(runs.cn.id),comRun:String(runs.com.id),cnHash:packages.cn.record.artifactHash,comHash:packages.com.record.artifactHash};
  if(mode==='inspect') {
    const ledger=await api('deployments',true,{ref:env.GITHUB_SHA,environment:'dual-request',auto_merge:false,required_contexts:[],transient_environment:true,payload:identity,description:'Human-merged content: paired builds awaiting automated acceptance'});
    await api('deployments/'+ledger.id+'/statuses',true,{state:'queued',log_url:'https://github.com/'+REPO+'/actions/runs/'+env.GITHUB_RUN_ID,description:'Content/tree/merge provenance checked; publication pending'});
    await output(env,{eligible:true,...identity,ledgerId:ledger.id});
    await summary(env,'Human-merged content accepted. Source '+sourceCommit+'. Two sealed target packages; no rebuild.');return;
  }
  if(env.CN_HASH!==identity.cnHash||env.COM_HASH!==identity.comHash||env.CN_RUN!==identity.cnRun||env.COM_RUN!==identity.comRun)throw Error('Inspected paired package identity changed');
  if(!/^[a-f0-9]{32}$/.test(env.CLOUDFLARE_ACCOUNT_ID||'')||!env.CLOUDFLARE_API_TOKEN||!env.CLOUDFLARE_LIKES_API_TOKEN)throw Error('Missing content-auto environment credentials');
  const receipt={schema:1,controllerRun:env.GITHUB_RUN_ID,controllerAttempt:Number(env.GITHUB_RUN_ATTEMPT),controllerCommit:env.GITHUB_SHA,...identity,comBase:config.comVerificationBase,status:'started',passed:false,targets:{},failures:[]};
  await fs.mkdir('.work',{recursive:true});
  let phase='likes';
  async function recheck(){await protect();if((await api('branches/main')).commit.sha!==sourceCommit)throw Error('Source main advanced; refusing stale promotion');}
  function wrangler(args,cwd,token){return execute('npx',['--yes','wrangler@4.45.0',...args],{cwd,env:{PATH:env.PATH,HOME:env.HOME,CI:'true',NO_COLOR:'1',WRANGLER_SEND_METRICS:'false',WRANGLER_LOG_PATH:path.resolve('.work/wrangler-private.log'),CLOUDFLARE_API_TOKEN:token,CLOUDFLARE_ACCOUNT_ID:env.CLOUDFLARE_ACCOUNT_ID}});}
  async function upload(target,branch){await recheck();const out=wrangler(['pages','deploy',packages[target].release+'/site','--project-name=stefanzhang-com','--branch='+branch,'--commit-hash='+sourceCommit,'--commit-message=Source-CI-'+runs[target].id],process.cwd(),env.CLOUDFLARE_API_TOKEN);const matches=[...new Set(out.match(/https:\/\/[a-f0-9]{8,32}\.stefanzhang-com\.pages\.dev/g)||[])];if(matches.length!==1)throw Error('Cannot identify fixed Pages deployment');return deploymentOrigin(matches[0]);}
  async function verify(target,base,full=false){execute(process.execPath,['scripts/release/verify.mjs',packages[target].release,'--base',base,...(full?['--full']:[])]);const p=await readJSON(path.join(packages[target].release,full?'verified-full.json':'verified-static.json'));assertRemoteCoverage(p,packages[target].record,base,(await readJSON(path.join(packages[target].release,'legacy-urls.json'))).length+(base===packages[target].record.config.publicationOrigin?(await readJSON(path.join(packages[target].release,'query-urls.json'))).length:0));return p;}
  async function preview(target){const fixedURL=await upload(target,'release-preview');const fixed=await verify(target,fixedURL),alias=await verify(target,policies[target].previewOrigin);for(const base of [fixedURL,alias.base]){const r=await fetch(base+'/',{redirect:'manual',signal:AbortSignal.timeout(20000)});await r.body?.cancel();if(r.status!==200||!r.headers.get('x-robots-tag')?.split(/[,\s]+/).includes('noindex'))throw Error('Preview indexing guard failed');}return {fixedURL,fixed,alias};}
  try {
    let cnPreview,cnEnv,servicesReceipt,pageKeys;
    await publicationSequence({
    likes:async()=>{
    const likesPolicy=assertLikesPolicy(await policyFile('likes-policy.json'));
    const worker=await prepareWorker({root:path.resolve('.work'),record:packages.cn.record,run:runs.cn,api,policy:likesPolicy});
    const cf=async endpoint=>{const response=await fetch('https://api.cloudflare.com/client/v4/accounts/'+env.CLOUDFLARE_ACCOUNT_ID+'/workers/scripts/sfz-likes/'+endpoint,{headers:{Authorization:'Bearer '+env.CLOUDFLARE_LIKES_API_TOKEN},signal:AbortSignal.timeout(30000)});if(!response.ok)throw Error('Worker API HTTP '+response.status);const b=await response.json();if(b.success!==true)throw Error('Worker API failed');return b.result;};
    receipt.likes=await publishWorker({policy:likesPolicy,ids:canonicalIds(packages.cn.record.contentIds),worker:worker.worker,cf,wrangler:args=>wrangler(args,worker.worker,env.CLOUDFLARE_LIKES_API_TOKEN),verify:verifyReadiness,beforePromote:recheck,skipUnchanged:true});
    },
    comPreview:async()=>{receipt.targets.comPreview=await preview('com');},
    cnPreview:async()=>{cnPreview=await preview('cn');receipt.targets.cnPreview=cnPreview;
    cnEnv={...env,SOURCE_RUN:identity.cnRun,EXPECTED_COMMIT:sourceCommit,EXPECTED_HASH:identity.cnHash,DEPLOYMENT_URL:cnPreview.fixedURL};
    },
    services:async()=>{pageKeys=await readCommentPageKeys(packages.cn.release,packages.cn.record);
    servicesReceipt=await verifyServices({record:packages.cn.record,policy:policies.cn,env:cnEnv,pageKeys});
    if(!servicesReceipt.passed)throw Error('Independent services failed');receipt.services=servicesReceipt;
    },
    comProduction:async()=>{const productionURL=await upload('com','main');
    receipt.targets.com={deploymentURL:productionURL,fixed:await verify('com',productionURL),project:await verify('com','https://stefanzhang-com.pages.dev')};
    if(config.comVerificationBase==='https://stefanzhang.com')receipt.targets.com.formal=await verify('com',config.comVerificationBase,true);
    },
    cnHandoff:async()=>{await recheck();
    const publicProof=publicReceipt(packages.cn.record,cnPreview.alias,cnEnv,cnPreview.fixed);
    const handoff=handoffPayload({record:packages.cn.record,alias:cnPreview.alias,fixed:cnPreview.fixed,receipt:publicProof,servicesReceipt,pageKeys,
      manifestBytes:await fs.readFile(path.join(packages.cn.release,'site',MANIFEST_PATH.slice(1))),legacyCount:(await readJSON(path.join(packages.cn.release,'legacy-urls.json'))).length,policy:policies.cn,env:cnEnv});
    receipt.cnDeploymentID=await publishHandoff((endpoint,body)=>api(endpoint,true,body),handoff);
    }
    },name=>{phase=name;});
    receipt.status='pages-verified-cn-handoff-ready';receipt.passed=true;
    await summary(env,'Pages target verified; CN handoff ready. This is NOT yet dual-site online success. The independent post-run verifier waits for VPS installation, then checks both sites. COM verification base: '+config.comVerificationBase);
  }catch(error){receipt.status='failed';receipt.failures.push({phase,error:error.message});await summary(env,'Publication failed at '+phase+'. Partial publication is possible; inspect the receipt. No DNS, SQL, SALT or history deletion.');throw error;}
  finally {
    await atomicJson('.work/dual-publication.json',receipt);
    if(/^\d+$/.test(env.LEDGER_ID||''))await api('deployments/'+env.LEDGER_ID+'/statuses',true,{state:receipt.passed?'in_progress':'failure',log_url:'https://github.com/'+REPO+'/actions/runs/'+env.GITHUB_RUN_ID,description:receipt.passed?'Pages verified; waiting for independent CN installation/online checks':'Publication failed; possible partial update; inspect receipt'});
  }
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)main().catch(e=>{console.error(e.message);process.exitCode=1;});
