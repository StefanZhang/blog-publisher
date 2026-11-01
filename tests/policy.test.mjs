import {test}from'node:test';import assert from'node:assert/strict';import fs from'node:fs/promises';
import {assertRun,assertRecord,assertProtection}from'../scripts/policy.mjs';
const p=JSON.parse(await fs.readFile(new URL('../policy.json',import.meta.url),'utf8'));const sha='a'.repeat(40),hash='b'.repeat(64);
test('rejects PR, foreign workflow/repo, failed and stale builds',()=>{
 const run={status:'completed',conclusion:'success',head_branch:'main',event:'push',path:p.sourceWorkflow,head_repository:{full_name:p.sourceRepo},head_sha:sha};assert.doesNotThrow(()=>assertRun(run,sha,p));
 for(const x of [{event:'pull_request'},{head_branch:'feature'},{conclusion:'failure'},{head_sha:'c'.repeat(40)},{head_repository:{full_name:'attacker/repo'}},{path:'.github/workflows/arbitrary.yml'}])assert.throws(()=>assertRun({...run,...x},sha,p));
});
test('cannot retarget Pages or replace executable controls under cover of a valid seal',()=>{
 const record={sourceCommit:sha,artifactHash:hash,migrationGaps:[],config:p.config,files:Object.fromEntries(Object.entries(p.controlHashes).map(([n,h])=>[n,{sha256:h}]))};assert.doesNotThrow(()=>assertRecord(record,p,sha,hash));
 for(const x of [{config:{...p.config,pagesProject:'another-project'}},{migrationGaps:['missing image']},{sourceCommit:'c'.repeat(40)},{files:{...record.files,'_worker.js':{sha256:'bad'}}},{files:{...record.files,'functions/x.js':{sha256:'bad'}}}])assert.throws(()=>assertRecord({...record,...x},p,sha,hash));
});
test('human approval and protected controller branch cannot be replaced by manual dispatch',()=>{
 const branch={protected:true},env={deployment_branch_policy:{protected_branches:true},protection_rules:[{type:'required_reviewers',reviewers:[{reviewer:{login:p.reviewer}}]}]};assert.doesNotThrow(()=>assertProtection(branch,env,p));assert.throws(()=>assertProtection({protected:false},env,p));assert.throws(()=>assertProtection(branch,{...env,protection_rules:[]},p));
});
