import fs from 'node:fs/promises';import path from 'node:path';import {spawnSync} from 'node:child_process';
import {sourceStage} from './source-stage.mjs';
import {readProtection,verifyControllerChecks} from './protection.mjs';
import {assertRun,assertRecord,assertProtection,assertSourceFile} from './policy.mjs';import {checkSeal} from './release/files.mjs';
const policy=JSON.parse(await fs.readFile(new URL('../policy.json',import.meta.url),'utf8'));
const command=process.argv[2], root=path.resolve('.work');
const readToken=process.env.SOURCE_READ_TOKEN, ownToken=process.env.GH_TOKEN;
const {api,currentRun,download}=sourceStage({policy,root,readToken,ownToken});
async function emit(data){
 if(process.env.GITHUB_OUTPUT)for(const[k,v]of Object.entries(data))await fs.appendFile(process.env.GITHUB_OUTPUT,k+'='+v+'\n');
 console.log(JSON.stringify(data));
}
async function protect(){
 if(process.env.GITHUB_REPOSITORY!==policy.controllerRepo||process.env.GITHUB_REF!=='refs/heads/main')throw Error('Publishing runs only on controller main');
 assertProtection(await readProtection(ownToken,policy.controllerRepo),await api('environments/preview',true),policy,process.env.GITHUB_SHA);
 if(command!=='finish')await verifyControllerChecks(ownToken,policy.controllerRepo,process.env.GITHUB_SHA);
}
async function summary(text){if(process.env.GITHUB_STEP_SUMMARY)await fs.appendFile(process.env.GITHUB_STEP_SUMMARY,text+'\n');}
async function main(){
 await protect();
 if(command==='finish'){
  const id=process.env.LEDGER_ID;if(!/^\d+$/.test(id||''))return;
  const success=process.env.PUBLISH_RESULT==='success';
  await api('deployments/'+id+'/statuses',true,{state:success?'success':'failure',environment_url:policy.previewOrigin,log_url:process.env.RUN_URL,description:success?'Preview verified and CN handoff issued; VPS awaits completed run':'Preview failed or cancelled; inspect run logs'});
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
  const ledger=await api('deployments',true,{ref:process.env.GITHUB_SHA,environment:'preview-request',auto_merge:false,required_contexts:[],transient_environment:true,payload:{source_run_id:String(run.id),source_commit:run.head_sha,artifact_hash:record.artifactHash},description:'Approve preview and public .cn delivery '+run.id});
  await api('deployments/'+ledger.id+'/statuses',true,{state:'queued',log_url:process.env.RUN_URL,description:'Awaiting human preview environment approval'});
  await emit({eligible:true,build_run_id:run.id,source_commit:run.head_sha,artifact_hash:record.artifactHash,ledger_id:ledger.id});
  await summary('## Approval: preview verification then public .cn update\n\nSource run: https://github.com/'+policy.sourceRepo+'/actions/runs/'+run.id+'\n\nCommit: `'+run.head_sha+'`\n\nArtifact SHA256: `'+record.artifactHash+'`\n\nTarget: '+policy.previewOrigin+'\n\nApproval permits updating the public https://stefanzhang.cn site after fixed and alias preview verification. The Hong Kong consumer acts only after this entire controller run completes successfully and independently verifies the files. No rebuild, .com/DNS/D1/independent Worker changes. CI local acceptance is not remote acceptance; a handoff is not proof the VPS installed it.');
 }else if(command==='stage'){
  if(process.env.EXPECTED_COMMIT!==run.head_sha)throw Error('Source main changed after inspection; create a new request');
  await summary('Re-downloaded and checked the exact approved artifact.');
 }else throw Error('Unknown command');
}
try{await main();}catch(error){console.error(error.message);process.exitCode=1;}
