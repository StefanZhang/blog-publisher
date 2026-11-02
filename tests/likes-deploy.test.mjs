import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {WORKFLOW,SOURCE_FILES,sha,canonicalIds,idsHash,assertSuperset,assertLikesPolicy,assertContext,assertSourceBytes,activeVersion,versionIds,workerConfig,parseUploadedVersion,stageApprovedSource,prepareWorker,stageLikesPackage,publishWorker,verifyReadiness} from '../scripts/likes-deploy.mjs';

const databaseId='11111111-1111-4111-8111-111111111111';
const oldVersion='22222222-2222-4222-8222-222222222222',newVersion='33333333-3333-4333-8333-333333333333';
const oldDeployment='44444444-4444-4444-8444-444444444444',newDeployment='55555555-5555-4555-8555-555555555555';
const origins=['https://stefanzhang.com','https://stefanzhang.cn','https://release-preview.stefanzhang-com.pages.dev'];
const sourceBytes=[Buffer.from("import ids from './known-ids.js'; export default {fetch(){return new Response(ids.length)}};"),Buffer.from('CREATE TABLE example(id TEXT);')];
const policy={schema:1,workerName:'sfz-likes',databaseName:'sfz-likes',databaseId,compatibilityDate:'2025-01-01',wranglerVersion:'4.45.0',allowedOrigins:origins,sourceHashes:Object.fromEntries(SOURCE_FILES.map((p,i)=>[p,sha(sourceBytes[i])])),baselineIds:['21'],baselineIdsSHA256:idsHash(['21'])};
const context={GITHUB_ACTIONS:'true',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_REPOSITORY:'StefanZhang/blog-publisher',GITHUB_REF:'refs/heads/main',GITHUB_WORKFLOW_REF:WORKFLOW,GITHUB_SHA:'a'.repeat(40),GITHUB_RUN_ID:'456',GITHUB_RUN_ATTEMPT:'1',GITHUB_JOB:'publish',LIKES_ENVIRONMENT:'preview'};
const deployment=(version=oldVersion,id=oldDeployment)=>({deployments:[{id,strategy:'percentage',versions:[{version_id:version,percentage:100}]}]});
const version=(id=oldVersion,ids=['21'])=>({id,resources:{bindings:[{name:'SALT',type:'secret_text'},{name:'DB',type:'d1',id:databaseId},{name:'ALLOWED_ORIGIN',type:'plain_text',text:origins.join(',')},{name:'KNOWN_IDS_JSON',type:'plain_text',text:JSON.stringify(canonicalIds(ids))},{name:'KNOWN_IDS_SHA256',type:'plain_text',text:idsHash(ids)}]}});
test('dedicated main dispatch context, exact Node and reviewed initialized policy are mandatory',()=>{
 assert.doesNotThrow(()=>assertContext(context,'publish','24.22.2'));
 for(const [key,value] of Object.entries({GITHUB_ACTIONS:'false',GITHUB_EVENT_NAME:'schedule',GITHUB_REPOSITORY:'evil/repo',GITHUB_REF:'refs/heads/topic',GITHUB_WORKFLOW_REF:WORKFLOW.replace('deploy-likes','publish-preview'),GITHUB_SHA:'main',GITHUB_RUN_ID:'0',GITHUB_RUN_ATTEMPT:'0',GITHUB_JOB:'inspect',LIKES_ENVIRONMENT:'other'})) assert.throws(()=>assertContext({...context,[key]:value},'publish','24.22.2'),key);
 assert.throws(()=>assertContext(context,'publish','26.9.0'));
 assert.deepEqual(assertLikesPolicy(policy),policy);
 for(const change of [{databaseId:null},{databaseId:'REPLACE_WITH_YOUR_D1_ID'},{workerName:'uptimeflare'},{databaseName:'uptimeflare_d1'},{wranglerVersion:'latest'},{baselineIdsSHA256:'0'.repeat(64)},{allowedOrigins:['https://evil']},{extra:true},{sourceHashes:{...policy.sourceHashes,unexpected:'a'.repeat(64)}}]) assert.throws(()=>assertLikesPolicy({...policy,...change}));
});
test('ID data is canonical, unique, bounded and must preserve baseline and deployed additions',()=>{
 assert.deepEqual(canonicalIds(['note-16','21']),['21','note-16']);
 for(const ids of [[],['21','21'],[21],['../../x'],['0'],['x\n'],['21";eval(1)'],null]) assert.throws(()=>canonicalIds(ids));
 assert.throws(()=>assertSuperset(['21'],['21','22']));
 assert.doesNotThrow(()=>assertSuperset(['21','22'],['21']));
});
test('only individually pinned Worker and schema bytes may enter preparation',()=>{
 SOURCE_FILES.forEach((p,i)=>assert.doesNotThrow(()=>assertSourceBytes(p,sourceBytes[i],policy)));
 assert.throws(()=>assertSourceBytes(SOURCE_FILES[0],Buffer.from('unreviewed'),policy));
 assert.throws(()=>assertSourceBytes('workers/likes/package.json',sourceBytes[0],policy));
});
test('active version and secret, database, origins and ID evidence fail closed',()=>{
 assert.equal(activeVersion(deployment()).versionId,oldVersion);
 for(const data of [{}, {deployments:[]}, {deployments:[{...deployment().deployments[0],versions:[{version_id:oldVersion,percentage:50},{version_id:newVersion,percentage:50}]}]}]) assert.throws(()=>activeVersion(data));
 assert.deepEqual(versionIds(version(),oldVersion,policy),['21']);
 for(const name of ['SALT','DB','ALLOWED_ORIGIN','KNOWN_IDS_JSON','KNOWN_IDS_SHA256']) {
  const v=version();v.resources.bindings=v.resources.bindings.filter(b=>b.name!==name);assert.throws(()=>versionIds(v,oldVersion,policy),name);
 }
 for(const [name,changes] of [['SALT',{type:'plain_text'}],['DB',{id:newVersion}],['KNOWN_IDS_SHA256',{text:'0'.repeat(64)}],['KNOWN_IDS_JSON',{text:'["21","21"]'}],['ALLOWED_ORIGIN',{text:'https://other'}]]) {
  const v=version();Object.assign(v.resources.bindings.find(b=>b.name===name),changes);assert.throws(()=>versionIds(v,oldVersion,policy));
 }
 const duplicate=version();duplicate.resources.bindings.push({name:'SALT',type:'secret_text'});assert.throws(()=>versionIds(duplicate,oldVersion,policy));
 const unexpected=version();unexpected.resources.bindings.push({name:'EXTRA_DB',type:'d1',id:newVersion});assert.throws(()=>versionIds(unexpected,oldVersion,policy));
 assert.throws(()=>versionIds(version(),newVersion,policy));
});
test('generated config has no secret, schema, routes, triggers, assets or source build command',()=>{
 const config=workerConfig(policy,['21','22']);
 assert.deepEqual(Object.keys(config).sort(),['compatibility_date','d1_databases','main','name','vars']);
 assert.equal(config.d1_databases[0].database_id,databaseId);
 assert.deepEqual(Object.keys(config.vars).sort(),['ALLOWED_ORIGIN','KNOWN_IDS_JSON','KNOWN_IDS_SHA256']);
 assert.equal(parseUploadedVersion('Worker Version ID: '+newVersion+'\n'),newVersion);
 for(const output of ['', 'Worker Version ID: bad','Worker Version ID: '+newVersion+'\nWorker Version ID: '+oldVersion]) assert.throws(()=>parseUploadedVersion(output));
});
test('trusted controller stage receives exact current source run; source drift and failed CI stop staging',async()=>{
 const sourcePolicy={sourceRepo:'StefanZhang/stefans_blog',sourceWorkflow:'.github/workflows/deploy.yml',branch:'main'};
 const run={id:123,head_sha:'b'.repeat(40),status:'completed',conclusion:'success',head_branch:'main',path:sourcePolicy.sourceWorkflow,event:'push',head_repository:{full_name:sourcePolicy.sourceRepo}};
 const record={artifactHash:'c'.repeat(64),sourceCommit:run.head_sha,contentIds:['21']};
 let staged=0,drift=false;
 const api=async endpoint=>endpoint==='branches/main'?{commit:{sha:drift&&staged?'d'.repeat(40):run.head_sha}}:run;
 const options={env:{BUILD_RUN_ID:'123',EXPECTED_HASH:record.artifactHash},sourcePolicy,api,root:'/unused',stage:async env=>{assert.equal(env.EXPECTED_COMMIT,run.head_sha);assert.equal(env.BUILD_RUN_ID,'123');staged++;},seal:async()=>record};
 assert.equal((await stageApprovedSource(options)).run.id,123);
 staged=0;drift=true;await assert.rejects(()=>stageApprovedSource(options),/changed/);
 drift=false;staged=0;run.conclusion='failure';await assert.rejects(()=>stageApprovedSource(options),/successful/);assert.equal(staged,0);
 run.conclusion='success';await assert.rejects(()=>stageApprovedSource({...options,env:{BUILD_RUN_ID:'123',EXPECTED_COMMIT:'e'.repeat(40)}}),/changed/);
 await assert.rejects(()=>stageApprovedSource({...options,stage:async()=>{throw Error('private archive rejected');}}),/archive rejected/);
 await assert.rejects(()=>stageApprovedSource({...options,seal:async()=>({...record,artifactHash:'x'})}),/identity/);
});
test('preparation writes only pinned code, generated IDs and trusted config, never a private script or schema',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'likes-prepare-'));
 const run={head_sha:'b'.repeat(40)};const api=async endpoint=>{
  const i=SOURCE_FILES.findIndex(p=>endpoint==='contents/'+p+'?ref='+run.head_sha);assert.ok(i>=0);
  return {type:'file',path:SOURCE_FILES[i],encoding:'base64',size:sourceBytes[i].length,content:sourceBytes[i].toString('base64')};
 };
 try {
  const result=await prepareWorker({root,record:{contentIds:['22','21']},run,api,policy});
  assert.deepEqual(await fs.readdir(result.worker),['src','wrangler.json']);
  assert.equal(await fs.readFile(path.join(result.worker,'src/known-ids.js'),'utf8'),'export default ["21","22"];\n');
  assert.deepEqual(await fs.readFile(path.join(result.worker,'src/index.js')),sourceBytes[0]);
  assert.deepEqual(result.schemaBytes,sourceBytes[1]);
  await assert.rejects(()=>prepareWorker({root:path.join(root,'bad'),record:{contentIds:['21']},run,policy,api:async endpoint=>({...await api(endpoint),content:Buffer.from('evil').toString('base64')})}),/Unreviewed/);
 } finally {await fs.rm(root,{recursive:true,force:true});}
});
test('bootstrap staging API reuses CI and seal verification and returns schema bytes without applying them',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'likes-bootstrap-'));
 const sourcePolicy={sourceRepo:'StefanZhang/stefans_blog',sourceWorkflow:'.github/workflows/deploy.yml',branch:'main'};
 const run={id:123,head_sha:'b'.repeat(40),status:'completed',conclusion:'success',head_branch:'main',path:sourcePolicy.sourceWorkflow,event:'push',head_repository:{full_name:sourcePolicy.sourceRepo}};
 const record={artifactHash:'c'.repeat(64),sourceCommit:run.head_sha,contentIds:['21']};let staged=0;
 const api=async endpoint=>{
  if(endpoint==='branches/main')return {commit:{sha:run.head_sha}};
  if(endpoint==='actions/runs/123')return run;
  const i=SOURCE_FILES.findIndex(p=>endpoint==='contents/'+p+'?ref='+run.head_sha);assert.ok(i>=0);
  return {type:'file',path:SOURCE_FILES[i],encoding:'base64',size:sourceBytes[i].length,content:sourceBytes[i].toString('base64')};
 };
 try {
  const prepared=await stageLikesPackage({env:{BUILD_RUN_ID:'123'},sourcePolicy,api,root,policy,stage:async()=>{staged++;},seal:async()=>record});
  assert.equal(staged,1);assert.deepEqual(prepared.schemaBytes,sourceBytes[1]);assert.deepEqual(prepared.record,record);
  assert.deepEqual(await fs.readdir(prepared.worker),['src','wrangler.json']);
 } finally {await fs.rm(root,{recursive:true,force:true});}
});
function harness() {
 let current=oldVersion, reads=0; const calls=[],verified=[];
 const options={policy,ids:['21','22'],worker:'/fixture',verify:async ids=>verified.push(ids),cf:async endpoint=>{
  if(endpoint==='deployments'){reads++;return deployment(current,current===oldVersion?oldDeployment:newDeployment);}
  if(endpoint==='versions/'+oldVersion)return version(oldVersion,['21']);
  if(endpoint==='versions/'+newVersion)return version(newVersion,['21','22']);
  throw Error('Unexpected endpoint');
 },wrangler:async args=>{calls.push(args);if(args[1]==='upload')return 'Worker Version ID: '+newVersion+'\n';assert.equal(args[1],'deploy');current=args[2].split('@')[0];return '';}};
 return {options,calls,verified,get reads(){return reads;}};
}
test('successful flow uploads and verifies before promotion, preserves triggers and records exact version',async()=>{
 const h=harness();const result=await publishWorker(h.options);
 assert.equal(result.workerVersion,newVersion);assert.equal(result.idsSHA256,idsHash(['21','22']));
 assert.deepEqual(h.calls.map(c=>c.slice(0,2)),[['versions','upload'],['versions','deploy']]);
 assert.ok(h.calls[0].includes('--experimental-auto-create=false'));
 assert.equal(h.calls[1][2],newVersion+'@100%');assert.deepEqual(h.verified,[['21'],['21','22']]);
 assert.equal(h.reads,4);
});
test('a maintainer version change during successful HTTP acceptance prevents a success receipt',async()=>{
 const h=harness(),base=h.options.cf;let changed=false;
 h.options.verify=async ids=>{if(ids.length===2)changed=true;};
 h.options.cf=async endpoint=>changed&&endpoint==='deployments'
  ? deployment('66666666-6666-4666-8666-666666666666',newDeployment)
  : base(endpoint);
 await assert.rejects(()=>publishWorker(h.options),/active version changed; automatic rollback refused/);
 assert.equal(h.calls.length,2);
});
test('missing metadata, missing SALT, removing deployed additions or failed prehealth never uploads',async()=>{
 for(const kind of ['metadata','salt','remove','health']) {
  const h=harness(),base=h.options.cf;
  h.options.cf=async endpoint=>{const out=await base(endpoint);if(endpoint.startsWith('versions/')) {
   if(kind==='metadata')out.resources.bindings=out.resources.bindings.filter(b=>b.name!=='KNOWN_IDS_JSON');
   if(kind==='salt')out.resources.bindings=out.resources.bindings.filter(b=>b.name!=='SALT');
   if(kind==='remove')return version(oldVersion,['21','23']);
  }return out;};
  if(kind==='health')h.options.verify=async()=>{throw Error('not ready');};
  await assert.rejects(()=>publishWorker(h.options));assert.equal(h.calls.length,0,kind);
 }
});
test('upload verification, concurrent deployment and source drift stop before traffic promotion',async()=>{
 for(const kind of ['salt','ids','race','source','upload']) {
  const h=harness(),base=h.options.cf;
  h.options.cf=async endpoint=>{
   if(kind==='race'&&endpoint==='deployments'&&h.calls.length)return deployment(oldVersion,newDeployment);
   const out=await base(endpoint);
   if(endpoint==='versions/'+newVersion&&kind==='salt')out.resources.bindings=out.resources.bindings.filter(b=>b.name!=='SALT');
   if(endpoint==='versions/'+newVersion&&kind==='ids')return version(newVersion,['21']);
   return out;
  };
  if(kind==='source')h.options.beforePromote=async()=>{throw Error('source changed');};
  if(kind==='upload')h.options.wrangler=async args=>{h.calls.push(args);throw Error('upload failed');};
  await assert.rejects(()=>publishWorker(h.options));assert.equal(h.calls.length,1,kind);
 }
});
test('postpromotion readiness failure restores previous version and rechecks its IDs and HTTP acceptance',async()=>{
 const h=harness();let count=0;h.options.verify=async()=>{if(++count===2)throw Error('postcheck failed');};
 await assert.rejects(()=>publishWorker(h.options),/previous version restored and read acceptance passed/);
 assert.equal(h.calls.length,3);assert.equal(h.calls[2][2],oldVersion+'@100%');assert.equal(count,3);
 assert.ok(h.calls.every(args=>args[0]==='versions'));
});
test('a transient postpromotion state read failure also recovers only its own active version',async()=>{
 const h=harness(),base=h.options.cf;let injected=false;
 h.options.cf=async endpoint=>{if(endpoint==='deployments'&&h.calls.length===2&&!injected){injected=true;throw Error('read failed');}return base(endpoint);};
 await assert.rejects(()=>publishWorker(h.options),/previous version restored/);assert.equal(h.calls.length,3);
 assert.deepEqual(h.verified,[['21'],['21']]);
});
test('rollback never overwrites a concurrent maintainer deployment, including a race during ID checks',async()=>{
 for(const when of ['initial','compare']) {
  const h=harness(),base=h.options.cf;let failed=false,recoveryReads=0;
  h.options.verify=async ids=>{if(ids.length===2){failed=true;throw Error('postcheck failed');}};
  h.options.cf=async endpoint=>{
   if(failed&&endpoint==='deployments') {
    recoveryReads++;
    if(when==='initial'||recoveryReads===2)return deployment('66666666-6666-4666-8666-666666666666',newDeployment);
   }
   return base(endpoint);
  };
  await assert.rejects(()=>publishWorker(h.options),/rollback refused|rollback failed or was refused/);
  assert.equal(h.calls.length,2,when);
 }
});
test('rollback command, ID evidence and rollback HTTP failures have a distinct failure outcome',async()=>{
 for(const kind of ['command','ids','http','unreadable']) {
  const h=harness(),base=h.options.cf,command=h.options.wrangler;let failed=false;
  h.options.verify=async ids=>{if(ids.length===2){failed=true;throw Error('postcheck failed');}if(failed&&kind==='http')throw Error('old health failed');};
  h.options.cf=async endpoint=>{
   if(failed&&kind==='unreadable'&&endpoint==='deployments')throw Error('no reliable active state');
   if(failed&&kind==='ids'&&endpoint==='versions/'+oldVersion)return version(oldVersion,['21','23']);
   return base(endpoint);
  };
  h.options.wrangler=async args=>{if(kind==='command'&&args[2]===oldVersion+'@100%'){h.calls.push(args);throw Error('rollback command failed');}return command(args);};
  await assert.rejects(()=>publishWorker(h.options),/rollback failed or was refused|rollback cannot verify active state/);
  assert.equal(h.calls.length,kind==='ids'||kind==='unreadable'?2:3,kind);
 }
});
test('acceptance uses only GET, rejects redirects, tests every ID on both APIs and exact CORS',async()=>{
 const calls=[];const request=async(url,options)=>{
  calls.push(url);assert.equal(options.method,undefined);assert.equal(options.redirect,'error');
  const target=new URL(url);const body=target.pathname==='/health'?{ok:true,schema:'atomic-views-v1'}:Object.fromEntries(target.searchParams.get('ids').split(',').map(id=>[id,0]));
  return Response.json(body,{headers:{'Access-Control-Allow-Origin':options.headers.Origin}});
 };
 await verifyReadiness(['21','22'],request);assert.equal(calls.length,9);
 for(const response of [Response.json({ok:true},{status:200}),new Response(null,{status:302})]) await assert.rejects(()=>verifyReadiness(['21'],async()=>response),/acceptance/);
 await assert.rejects(()=>verifyReadiness(['21'],async(_url,options)=>Response.json({ok:false},{headers:{'Access-Control-Allow-Origin':options.headers.Origin}})),/schema/);
 await assert.rejects(()=>verifyReadiness(['21'],async(_url,options)=>new Response('private error body',{headers:{'Access-Control-Allow-Origin':options.headers.Origin}})),error=>!error.message.includes('private error body')&&/valid JSON/.test(error.message));
});
test('workflow confines the dedicated token to human-approved publication and uploads only metadata',async()=>{
 const workflow=await fs.readFile(new URL('../.github/workflows/deploy-likes.yml',import.meta.url),'utf8');
 const [inspect,publish]=workflow.split('\n  publish:\n');
 assert.ok(inspect.includes('workflow_dispatch:'));assert.ok(!workflow.includes('schedule:'));
 assert.ok(!inspect.includes('CLOUDFLARE_LIKES_API_TOKEN'));
 assert.ok(publish.includes('name: preview'));assert.ok(publish.includes('LIKES_ENVIRONMENT: preview'));
 assert.ok(publish.includes('EXPECTED_IDS_HASH:'));assert.ok(publish.includes('EXPECTED_COMMIT:'));assert.ok(publish.includes('EXPECTED_HASH:'));
 assert.ok(publish.includes('path: .work/likes-receipt.json'));
 assert.ok(!workflow.includes('CLOUDFLARE_API_TOKEN'));assert.ok(!workflow.includes('d1 execute'));
 assert.equal((workflow.match(/node-version: '24.22.2'/g)||[]).length,2);
 for(const line of workflow.split('\n').filter(line=>line.includes('uses:'))) assert.match(line,/@[a-f0-9]{40}(?: |$)/);
});
