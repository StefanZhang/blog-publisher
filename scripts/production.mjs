import fs from 'node:fs/promises';import path from 'node:path';import {spawnSync} from 'node:child_process';
import {sourceStage} from './source-stage.mjs';import {readProtection,verifyControllerChecks} from './protection.mjs';import {assertProtection} from './policy.mjs';import {assertProductionContext,assertProductionProof} from './production-policy.mjs';import {checkSeal,atomicJson} from './release/files.mjs';import {readCommentPageKeys,verifyServices} from './services.mjs';import {deploymentOrigin} from './receipt.mjs';
const policy=JSON.parse(await fs.readFile(new URL('../policy.production.json',import.meta.url),'utf8'));
const command=process.argv[2],env=process.env,root=path.resolve('.work');
const {api,currentRun,download}=sourceStage({policy,root,readToken:env.SOURCE_READ_TOKEN,ownToken:env.GH_TOKEN});
async function summary(text){if(env.GITHUB_STEP_SUMMARY)await fs.appendFile(env.GITHUB_STEP_SUMMARY,text+'\n');}
async function protect(){
 assertProductionContext(env);
 const branch=await readProtection(env.GH_TOKEN,policy.controllerRepo);
 for(const name of ['preview','production'])assertProtection(branch,await api('environments/'+name,true),policy,env.GITHUB_SHA);
 await verifyControllerChecks(env.GH_TOKEN,policy.controllerRepo,env.GITHUB_SHA);
}
async function serviceProof(record){
 const proof=await verifyServices({record,policy,env:{...env,SOURCE_RUN:env.BUILD_RUN_ID},pageKeys:await readCommentPageKeys(path.join(root,'release'),record)});
 await atomicJson(path.join(root,'services-receipt.json'),proof);if(!proof.passed)throw Error('Independent services are not ready');
}
async function verify(base,full=false){
 const result=spawnSync(process.execPath,['scripts/release/verify.mjs',path.join(root,'release'),'--base',base,...(full?['--full']:[])],{stdio:'inherit'});
 if(result.status!==0)throw Error('Remote verification failed: '+base);
 return JSON.parse(await fs.readFile(path.join(root,'release',full?'verified-full.json':'verified-static.json'),'utf8'));
}
async function main(){
 if(!['inspect','stage-preview','record-preview','stage-production','verify-project','verify-domain'].includes(command))throw Error('Unknown production command');
 await protect();
 if(['inspect','stage-preview','stage-production','verify-domain'].includes(command)){
  const run=await currentRun();if(!run)throw Error('No successful current-main production build');
  const {record}=await download(run);
  if(command==='inspect'){
   if(env.GITHUB_OUTPUT)await fs.appendFile(env.GITHUB_OUTPUT,`build_run_id=${run.id}\nsource_commit=${run.head_sha}\nartifact_hash=${record.artifactHash}\n`);
   await summary(`## .com candidate — approval does not change DNS\nSource CI: https://github.com/${policy.sourceRepo}/actions/runs/${run.id}\nCommit: ${run.head_sha}\nArtifact: ${record.artifactHash}\nFirst approval uploads only preview. Second production approval uploads the SAME package to Pages main. Domain cutover is separate. .cn delivery is untouched.`);return;
  }
  if(record.sourceCommit!==env.EXPECTED_COMMIT||record.artifactHash!==env.EXPECTED_HASH)throw Error('Approved source identity changed');
  if(command==='stage-production'){
   const proof=JSON.parse(await fs.readFile('.proof/production-preview-proof.json','utf8'));assertProductionProof(proof,record,env);
   await serviceProof(record);
  }
  if(command==='verify-domain'){
   const proof=await verify('https://stefanzhang.com',true);await serviceProof(record);
   const response=await fetch('https://stefanzhang.com/',{redirect:'manual',signal:AbortSignal.timeout(20000)});
   if(response.status!==200||/noindex/i.test(response.headers.get('x-robots-tag')||''))throw Error('Production homepage status/indexing failed');await response.body?.cancel();
   await atomicJson('.work/production-domain-receipt.json',proof);await summary('Formal .com full HTTP acceptance passed for '+record.artifactHash);
  }
  return;
 }
 const record=await checkSeal('.work/release');
 if(command==='record-preview'){
  await serviceProof(record);
  const proof={schema:1,kind:'production-preview',sourceRun:env.BUILD_RUN_ID,sourceCommit:record.sourceCommit,artifactHash:record.artifactHash,controllerRun:env.GITHUB_RUN_ID,controllerAttempt:env.GITHUB_RUN_ATTEMPT,controllerCommit:env.GITHUB_SHA,deploymentURL:env.DEPLOYMENT_URL,fixed:JSON.parse(await fs.readFile('.work/verified-fixed.json')),alias:JSON.parse(await fs.readFile('.work/verified-alias.json'))};
  assertProductionProof(proof,record,env);await atomicJson('.work/production-preview-proof.json',proof);await summary('Preview verified; production approval promotes this exact artifact: '+record.artifactHash);
 }else{
  const fixed=deploymentOrigin(env.DEPLOYMENT_URL),alias='https://stefanzhang-com.pages.dev';const a=await verify(fixed),b=await verify(alias);
  await atomicJson('.work/production-project-receipt.json',{schema:1,scope:'pages-production-project-not-custom-domain',artifactHash:record.artifactHash,sourceCommit:record.sourceCommit,deploymentURL:fixed,deploymentID:env.DEPLOYMENT_ID,controllerRun:env.GITHUB_RUN_ID,fixed:a,alias:b,passed:true});
  await summary('Pages production project bytes verified. This does NOT claim stefanzhang.com DNS has switched or formal-domain acceptance has passed. Artifact: '+record.artifactHash);
 }
}
try{await main();}catch(error){console.error(error.message);process.exitCode=1;}
