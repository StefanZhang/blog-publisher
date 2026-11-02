import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import policy from '../policy.json' with {type:'json'};
import {verifyServices,assertServicesReceipt,readCommentPageKeys,SERVICE_RECEIPT_MAX_AGE_MS} from '../scripts/services.mjs';

function fixture() {
  return {record:{artifactHash:'a'.repeat(64),sourceCommit:'b'.repeat(40),config:structuredClone(policy.config),
    contentIds:[...Array.from({length:101},(_,i)=>String(i+1)),'note-16']},policy,
    env:{SOURCE_RUN:'123',GITHUB_RUN_ID:'456',GITHUB_RUN_ATTEMPT:'2',GITHUB_SHA:'c'.repeat(40)},
    pageKeys:['/105/','/notes/#note-16'],now:()=>Date.parse('2026-11-02T12:00:00Z')};
}
function response(data,origin,options={}) {
  return new Response(JSON.stringify(data),{status:options.status??200,
    headers:{'content-type':'application/json','access-control-allow-origin':origin,vary:'Origin',...options.headers}});
}
function server(calls=[],mutate=()=>{}) {
  return async(url,options)=>{
    const u=new URL(url),origin=options.headers.Origin;
    calls.push({url:String(url),...options});
    const overridden=mutate(u,origin,options);if(overridden)return overridden;
    if(u.pathname==='/health')return response({ok:true,schema:'atomic-views-v1'},origin);
    if(u.pathname==='/api/likes'||u.pathname==='/api/views')return response(Object.fromEntries(u.searchParams.get('ids').split(',').map(id=>[id,0])),origin);
    if(u.pathname==='/api/v2/conf')return response({version:{app:'artalk',version:'2.10.1'},frontend_conf:{}},origin);
    if(u.pathname==='/api/v2/comments')return response({comments:[{id:41,rid:0,visible:true,page_key:u.searchParams.get('page_key'),site_name:'stefanzhang.com',
      content:'private comment body',email:'do-not-publish@example.test'}],count:1,roots_count:1,
      page:{key:u.searchParams.get('page_key'),site_name:'stefanzhang.com'}},origin);
    throw Error('Unexpected request');
  };
}

test('full sealed IDs are batched for both Worker counters; real Artalk config/pages cover all three exact origins',async()=>{
  const f=fixture(),calls=[],r=await verifyServices({...f,fetchImpl:server(calls)});
  assert.equal(r.passed,true);assert.deepEqual(r.checks,{workerHealth:3,workerCounts:12,artalkConfig:3,artalkPages:6});
  assertServicesReceipt(r,{...f,now:f.now()});assert.equal(calls.length,24);
  for(const c of calls){assert.equal(c.method,'GET');assert.equal(c.redirect,'error');assert.equal(c.credentials,'omit');assert.ok(c.signal);}
  for(const origin of r.origins)for(const endpoint of ['likes','views']) {
    const ids=calls.filter(c=>new URL(c.url).pathname==='/api/'+endpoint&&c.headers.Origin===origin)
      .flatMap(c=>new URL(c.url).searchParams.get('ids').split(','));
    assert.deepEqual(ids.sort(),[...f.record.contentIds].sort());
  }
  assert.ok(!JSON.stringify(r).includes('private comment'));assert.ok(!JSON.stringify(r).includes('do-not-publish'));
  const pageCalls=calls.filter(c=>c.url.includes('/api/v2/comments'));
  assert.ok(pageCalls.some(c=>new URL(c.url).searchParams.get('page_key')==='/notes/#note-16'));
  assert.ok(!calls.some(c=>c.url.includes('/pages/fetch')||c.url.includes('/dist/')));
});

test('network errors, unknown/missing IDs, bad counts and schema, wrong CORS, and JS-only responses fail closed without response content',async()=>{
  const mutations=[
    ()=>{throw Error('private backend error do-not-publish@example.test');},
    (u,o)=>u.pathname==='/health'?response({ok:false,schema:null},o):null,
    (u,o)=>u.pathname==='/api/likes'?response({error:'unknown id'},o,{status:400}):null,
    (u,o)=>u.pathname==='/api/views'?response({},o):null,
    (u,o)=>u.pathname==='/api/likes'?response(Object.fromEntries(u.searchParams.get('ids').split(',').map(id=>[id,-1])),o):null,
    (u,o)=>o==='https://stefanzhang.cn'?response({},'*'):null,
    (u,o)=>response({},o,{headers:{vary:'Accept-Encoding'}}),
    (u,o)=>response({},o,{headers:{'content-type':'text/javascript'}}),
    (u,o)=>new Response('{invalid',{headers:{'content-type':'application/json','access-control-allow-origin':o,vary:'Origin'}}),
    (u,o)=>response({secret:'x'.repeat(1024*1024)},o),
    (u,o)=>response({},o,{status:503}),
  ];
  for(const mutate of mutations) {
    const r=await verifyServices({...fixture(),fetchImpl:server([],mutate)});
    assert.equal(r.passed,false);assert.equal(r.failures.length,1);
    assert.ok(!JSON.stringify(r).includes('do-not-publish'));assert.ok(!JSON.stringify(r).includes('private backend'));
  }
});

test('Artalk must answer actual matching site/page and the pinned API version, not a nominal HTTP 200',async()=>{
  for(const mutate of [
    (u,o)=>u.pathname.endsWith('/conf')?response({version:{app:'artalk',version:'2.9.1'},frontend_conf:{}},o):null,
    (u,o)=>u.pathname.endsWith('/conf')?response({msg:'not configured'},o):null,
    (u,o)=>u.pathname.endsWith('/comments')?response({err_no_site:true,msg:'private detail'},o,{status:404}):null,
    (u,o)=>u.pathname.endsWith('/comments')?response({comments:[],count:0,roots_count:0,page:{key:'/wrong/',site_name:'stefanzhang.com'}},o):null,
    (u,o)=>u.pathname.endsWith('/comments')?response({comments:[],count:0,roots_count:0,page:{key:u.searchParams.get('page_key'),site_name:'other-site'}},o):null,
    (u,o)=>u.pathname.endsWith('/comments')?response({comments:[],count:'0',roots_count:0,page:{key:u.searchParams.get('page_key'),site_name:'stefanzhang.com'}},o):null,
  ])assert.equal((await verifyServices({...fixture(),fetchImpl:server([],mutate)})).passed,false);
});

test('Artalk flat limit=1 accepts a selected reply plus its invisible direct parent, including deeper threads',async()=>{
  for (const parentRid of [0,39]) {
    const calls=[];
    const fetchImpl=server(calls,(u,o)=>{
      if(!u.pathname.endsWith('/comments'))return;
      const page_key=u.searchParams.get('page_key'),site_name='stefanzhang.com';
      return response({comments:[
        {id:42,rid:41,visible:true,page_key,site_name,is_pinned:true,content:'synthetic private text'},
        {id:41,rid:parentRid,visible:false,page_key,site_name,email:'synthetic-private@example.test'},
      ],count:parentRid?3:2,roots_count:1,page:{key:page_key,site_name}},o);
    });
    const r=await verifyServices({...fixture(),fetchImpl});
    assert.equal(r.passed,true);assert.equal(r.checks.artalkPages,6);
    for(const {url} of calls.filter(c=>c.url.includes('/api/v2/comments'))) {
      const q=new URL(url).searchParams;assert.equal(q.get('limit'),'1');assert.equal(q.get('flat_mode'),'true');
    }
    assert.ok(!JSON.stringify(r).includes('synthetic private'));assert.ok(!JSON.stringify(r).includes('synthetic-private'));
  }
});

test('Artalk flat replies reject unrelated, duplicate, cross-page or malformed rows without leaking content',async()=>{
  const cases=[
    c=>c[1].id=43,
    c=>c[1].visible=true,
    c=>c[0].visible=false,
    c=>delete c[0].visible,
    c=>c[0].visible='true',
    c=>c[1].visible='false',
    c=>c[1].id=c[0].id,
    c=>c[0].id='42',
    c=>c[1].id=0,
    c=>c[0].id=Number.MAX_SAFE_INTEGER+1,
    c=>c[0].rid=-1,
    c=>c[1].rid='0',
    c=>c[1].page_key='/different/',
    c=>c[0].site_name='other-site',
    c=>c.push({...c[1],id:40,rid:0}), // Grandparents are not appended by v2.10.1.
    c=>c.splice(0,1), // An invisible parent without the selected comment is invalid.
    c=>c.splice(0,c.length,{content:'synthetic private text'}),
  ];
  for(const mutate of cases) {
    const fetchImpl=server([],(u,o)=>{
      if(!u.pathname.endsWith('/comments'))return;
      const page_key=u.searchParams.get('page_key'),site_name='stefanzhang.com';
      const comments=[{id:42,rid:41,visible:true,page_key,site_name},{id:41,rid:40,visible:false,page_key,site_name}];
      mutate(comments);
      return response({comments,count:3,roots_count:1,page:{key:page_key,site_name}},o);
    });
    const r=await verifyServices({...fixture(),fetchImpl});
    assert.equal(r.passed,false);assert.equal(r.failures[0].code,'artalk-page');
    assert.ok(!JSON.stringify(r).includes('synthetic private'));
  }
});

test('receipt rejects another package, source, IDs, page keys, config, controller context, incomplete coverage and time travel',async()=>{
  const f=fixture(),r=await verifyServices({...f,fetchImpl:server()});
  for(const mutate of [
    p=>p.artifactHash='d'.repeat(64),p=>p.sourceCommit='d'.repeat(40),p=>p.sourceRun='999',p=>p.controllerRun='999',
    p=>p.controllerAttempt++,p=>p.controllerCommit='d'.repeat(40),p=>p.configSHA256='d'.repeat(64),
    p=>p.contentIds.count--,p=>p.contentIds.sha256='d'.repeat(64),p=>p.pageKeys.sha256='d'.repeat(64),
    p=>p.origins[1]='https://evil.invalid',p=>p.endpoints.likes='https://evil.invalid',
    p=>p.checks.artalkPages--,p=>p.passed=false,p=>p.failures.push({code:'failed'}),p=>p.untrusted='extra',
    p=>p.startedAt=new Date(f.now()-SERVICE_RECEIPT_MAX_AGE_MS-1).toISOString(),
    p=>p.verifiedAt=new Date(f.now()+1).toISOString(),p=>p.startedAt='invalid',
  ]) {const p=structuredClone(r);mutate(p);assert.throws(()=>assertServicesReceipt(p,{...f,now:f.now()}));}
  assert.throws(()=>assertServicesReceipt(undefined,{...f,now:f.now()}));
  for(const update of [{contentIds:['105','105']},{contentIds:['../105']},{config:{...f.record.config,likesApi:'https://other.invalid'}}])
    await assert.rejects(verifyServices({...f,record:{...f.record,...update},fetchImpl:server()}));
});

test('page keys come from sealed section attributes, retaining note fragments and rejecting template drift',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'service-pages-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.mkdir(path.join(root,'site'));
  await fs.writeFile(path.join(root,'site/index.html'),'<section data-comments data-page-key="/105/"></section><section data-page-key="/notes/#note-16" data-comments></section>');
  const record={files:{'index.html':{}}};
  assert.deepEqual(await readCommentPageKeys(root,record),['/105/','/notes/#note-16']);
  await fs.writeFile(path.join(root,'site/index.html'),'<section data-comments></section>');
  await assert.rejects(readCommentPageKeys(root,record),/Missing/);
  await assert.rejects(readCommentPageKeys(root,{files:{'../secret.html':{}}}),/Unsafe/);
});

test('workflow requires a fresh service receipt before handoff with no new service secrets',async()=>{
  const s=await fs.readFile(new URL('../.github/workflows/publish-preview.yml',import.meta.url),'utf8');
  assert.ok(s.indexOf('run: node scripts/verify-services.mjs')<s.indexOf('run: node scripts/cn-handoff.mjs'));
  assert.match(s,/path: \.work\/services-receipt.json/);
  assert.ok(!/secrets\.(?:ARTALK|WORKER|D1)/.test(s));
});

test('each request has an effective timeout and the verifier stops rather than hanging',async()=>{
  const f=fixture();let calls=0;
  const fetchImpl=(_url,{signal})=>new Promise((_,reject)=>{
    calls++;signal.addEventListener('abort',()=>reject(Error('private timeout detail')),{once:true});
    // Keep the test loop alive until AbortSignal.timeout fires (its timer is unrefed).
    const timer=setTimeout(()=>reject(Error('timeout did not abort')),200);
    signal.addEventListener('abort',()=>clearTimeout(timer),{once:true});
  });
  const r=await verifyServices({...f,fetchImpl,timeoutMs:5});
  assert.equal(calls,1);assert.equal(r.passed,false);assert.equal(r.failures[0].code,'network-or-timeout');
  assert.ok(!JSON.stringify(r).includes('private timeout'));
});
