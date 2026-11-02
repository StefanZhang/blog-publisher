import fs from 'node:fs/promises';import path from 'node:path';import {spawnSync} from 'node:child_process';
import {downloadArchive} from './archive-source.mjs';
import {assertRun,assertRecord,assertSourceFile} from './policy.mjs';import {checkSeal} from './release/files.mjs';
export function sourceStage({policy,root,readToken,ownToken,request=fetch}){
async function api(endpoint,own=false,body){
 const token=own?ownToken:readToken;if(!token)throw Error('Missing '+(own?'controller GitHub token':'SOURCE_READ_TOKEN'));
 const r=await request('https://api.github.com/repos/'+(own?policy.controllerRepo:policy.sourceRepo)+(endpoint?'/'+endpoint:''),{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000)});
 if(!r.ok)throw Error('GitHub API '+r.status+' at '+endpoint.split('?')[0]);return r.json();
}
async function currentRun(){
 const main=(await api('branches/main')).commit.sha;
 const selected=process.env.BUILD_RUN_ID||'latest';
 if(selected!=='latest'&&!/^\d+$/.test(selected))throw Error('Invalid build run ID');
 const run=selected==='latest'?(await api('actions/workflows/'+encodeURIComponent(policy.sourceWorkflow.split('/').at(-1))+'/runs?branch=main&status=success&per_page=30')).workflow_runs.find(r=>r.head_sha===main&&['push','workflow_dispatch'].includes(r.event)):await api('actions/runs/'+selected);
 if(!run)return null;assertRun(run,main,policy);return run;
}
async function download(run){
 for(const name of Object.keys(policy.sourceFileHashes)){const file=await api('contents/'+name+'?ref='+run.head_sha);if(file.encoding!=='base64')throw Error('Unexpected source file response');assertSourceFile(name,Buffer.from(file.content,'base64'),policy);}

 const archived=await downloadArchive(run,api,readToken,root,request);
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
return {api,currentRun,download};
}
