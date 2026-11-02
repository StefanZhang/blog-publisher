import {test} from 'node:test';import assert from 'node:assert/strict';import {sourceStage} from '../scripts/source-stage.mjs';
const sha='a'.repeat(40);
test('shared source discovery selects the exact reviewed workflow for each target',async()=>{
 const previous=process.env.BUILD_RUN_ID;process.env.BUILD_RUN_ID='latest';
 try{for(const file of ['deploy.yml','build-production.yml']){
  const policy={sourceRepo:'StefanZhang/stefans_blog',controllerRepo:'StefanZhang/blog-publisher',branch:'main',sourceWorkflow:'.github/workflows/'+file};const calls=[];
  const run={id:1,status:'completed',conclusion:'success',head_branch:'main',event:'push',path:policy.sourceWorkflow,head_repository:{full_name:policy.sourceRepo},head_sha:sha};
  const stage=sourceStage({policy,root:'/tmp',readToken:'test',ownToken:'test',request:async url=>{calls.push(url);if(url.endsWith('/branches/main'))return Response.json({commit:{sha}});assert.ok(url.includes('/actions/workflows/'+file+'/runs?'));return Response.json({workflow_runs:[run]});}});
  assert.equal((await stage.currentRun()).path,policy.sourceWorkflow);assert.equal(calls.length,2);
 }}finally{if(previous===undefined)delete process.env.BUILD_RUN_ID;else process.env.BUILD_RUN_ID=previous;}
});
