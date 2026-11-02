import {test}from'node:test';import assert from'node:assert/strict';import fs from'node:fs/promises';
import {assertRun,assertRecord,assertProtection,assertSourceFile,assertBranchProtection,assertControllerChecks}from'../scripts/policy.mjs';
const p=JSON.parse(await fs.readFile(new URL('../policy.json',import.meta.url),'utf8'));const sha='a'.repeat(40),hash='b'.repeat(64);
test('rejects PR, foreign workflow/repo, failed and stale builds',()=>{
 const run={status:'completed',conclusion:'success',head_branch:'main',event:'push',path:p.sourceWorkflow,head_repository:{full_name:p.sourceRepo},head_sha:sha};assert.doesNotThrow(()=>assertRun(run,sha,p));
 for(const x of [{event:'pull_request'},{head_branch:'feature'},{conclusion:'failure'},{head_sha:'c'.repeat(40)},{head_repository:{full_name:'attacker/repo'}},{path:'.github/workflows/arbitrary.yml'}])assert.throws(()=>assertRun({...run,...x},sha,p));
});
test('cannot retarget Pages or replace executable controls under cover of a valid seal',()=>{
 const record={sourceCommit:sha,artifactHash:hash,migrationGaps:[],config:p.config,files:Object.fromEntries(Object.entries(p.controlHashes).map(([n,h])=>[n,{sha256:h}]))};assert.doesNotThrow(()=>assertRecord(record,p,sha,hash));
 for(const x of [{config:{...p.config,pagesProject:'another-project'}},{migrationGaps:['missing image']},{sourceCommit:'c'.repeat(40)},{files:{...record.files,'_worker.js':{sha256:'bad'}}},{files:{...record.files,'functions/x.js':{sha256:'bad'}}}])assert.throws(()=>assertRecord({...record,...x},p,sha,hash));
});
const protectedBranch=()=>({protected:true,commit:{sha},protection:{enabled:true,required_status_checks:{enforcement_level:'everyone',checks:[{context:'check',app_id:15368}]}},protectionRule:{pattern:'main',allowsForcePushes:false,allowsDeletions:false,requiredStatusCheckContexts:['check'],requiredApprovingReviewCount:0}});
const protectedEnvironment=()=>({can_admins_bypass:false,deployment_branch_policy:{protected_branches:true,custom_branch_policies:false},protection_rules:[{type:'required_reviewers',reviewers:[{type:'User',reviewer:{login:p.reviewer,type:'User'}}]}]});
test('protection is more than a protected flag and cannot lose visible invariants',()=>{
 const branch=protectedBranch();assert.doesNotThrow(()=>assertBranchProtection(branch));
 assert.throws(()=>assertBranchProtection({protected:true,commit:{sha}}));
 for(const change of [{pattern:'another-branch'},{allowsForcePushes:true},{allowsDeletions:true},{requiredStatusCheckContexts:[]},{requiredApprovingReviewCount:null}])assert.throws(()=>assertBranchProtection({...branch,protectionRule:{...branch.protectionRule,...change}}));
 for(const checks of [{enforcement_level:'non_admins',checks:[{context:'check',app_id:15368}]},{enforcement_level:'everyone',checks:[]},{enforcement_level:'everyone',checks:[{context:'check',app_id:999}]}])assert.throws(()=>assertBranchProtection({...branch,protection:{enabled:true,required_status_checks:checks}}));
});
test('human approval requires the exact allowed user set and protected branches only',()=>{
 const branch=protectedBranch(),env=protectedEnvironment();assert.doesNotThrow(()=>assertProtection(branch,env,p,sha));
 for(const change of [{protection_rules:[]},{can_admins_bypass:true},{deployment_branch_policy:{protected_branches:true,custom_branch_policies:true}},{protection_rules:[{type:'required_reviewers',reviewers:[...env.protection_rules[0].reviewers,{type:'User',reviewer:{login:'daily-agent-bot',type:'User'}}]}]},{protection_rules:[{type:'required_reviewers',reviewers:[{type:'Team',reviewer:{login:p.reviewer,type:'Team'}}]}]}])assert.throws(()=>assertProtection(branch,{...env,...change},p,sha));
 assert.throws(()=>assertProtection(branch,env,p,'c'.repeat(40)));
});

test('toolchain changes cannot silently replace cached immutable assets',()=>{assert.throws(()=>assertSourceFile('scripts/optimize-images.mjs',Buffer.from('changed'),p),/toolchain changed/);});


import {readProtection,verifyControllerChecks} from '../scripts/protection.mjs';
test('GraphQL/REST permission, partial-data and raced-ref failures stop verification',async()=>{
 const branch=protectedBranch();const good={data:{repository:{ref:{target:{oid:sha},refUpdateRule:branch.protectionRule}}}};
 const request=(payload,rest=branch)=>async(url)=>({ok:true,status:200,json:async()=>url.endsWith('/graphql')?payload:rest});
 assert.deepEqual(await readProtection('test-token','StefanZhang/blog-publisher',request(good)),branch);
 await assert.rejects(readProtection('test-token','StefanZhang/blog-publisher',request({...good,errors:[{message:'Resource not accessible by integration'}]})),/incomplete/);
 await assert.rejects(readProtection('test-token','StefanZhang/blog-publisher',request({data:{repository:{ref:null}}})),/Missing/);
 await assert.rejects(readProtection('test-token','StefanZhang/blog-publisher',async()=>({ok:false,status:403})),/HTTP 403/);
 await assert.rejects(readProtection('test-token','StefanZhang/blog-publisher',request(good,{...branch,commit:{sha:'c'.repeat(40)}})),/changed/);
});
test('publication requires successful GitHub Actions check on the exact controller commit',async()=>{
 const run={name:'check',app:{id:15368},head_sha:sha,status:'completed',conclusion:'success'};
 assert.doesNotThrow(()=>assertControllerChecks({check_runs:[run]},sha));
 for(const change of [{app:{id:999}},{head_sha:'c'.repeat(40)},{name:'unrelated'},{status:'in_progress'},{conclusion:'failure'},{conclusion:'skipped'}])assert.throws(()=>assertControllerChecks({check_runs:[{...run,...change}]},sha));
 assert.throws(()=>assertControllerChecks({check_runs:[]},sha));
 await verifyControllerChecks('test-token','StefanZhang/blog-publisher',sha,async()=>({ok:true,json:async()=>({check_runs:[run]})}));
 await assert.rejects(verifyControllerChecks('test-token','StefanZhang/blog-publisher',sha,async()=>({ok:false,status:403})),/HTTP 403/);
});
