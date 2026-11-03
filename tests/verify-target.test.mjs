import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {inventory,rootHash,atomicJson} from '../scripts/release/files.mjs';
import {verificationTarget} from '../scripts/release/target-policy.mjs';
const config={schema:1,canonicalOrigin:'https://stefanzhang.com',publicationOrigin:'https://stefanzhang.cn',pagesProject:'stefanzhang-com',productionBranch:'main',likesApi:'off',artalkServer:'off',beaconToken:'',wranglerVersion:'4.45.0'};
const cli=fileURLToPath(new URL('../scripts/release/verify.mjs',import.meta.url));
const cn='https://stefanzhang.cn',com='https://stefanzhang.com',preview='https://fixture.stefanzhang-com.pages.dev';

// This preload intercepts every fetch. Any unplanned URL fails; no live services are used.
const mockModule=`
import fs from 'node:fs';
const s=JSON.parse(fs.readFileSync(process.env.VERIFY_MOCK_SCENARIO,'utf8'));
globalThis.fetch=async(input,options={})=>{
 const u=new URL(input);fs.appendFileSync(process.env.VERIFY_MOCK_CALLS,JSON.stringify({url:u.href,method:options.method||'GET',origin:new Headers(options.headers).get('origin')})+'\\n');
 if(u.hostname==='likes.stefanzhang.com'){
  if(s.serviceFailure==='health')return new Response('{}',{status:503});
  if(u.pathname==='/health')return Response.json({ok:true,schema:'atomic-views-v1'});
  const origin=new Headers(options.headers).get('origin');
  return Response.json({'21':4},{headers:{'access-control-allow-origin':s.serviceFailure==='cors'?'https://stefanzhang.com':origin}});
 }
 if(u.hostname==='comments.stefanzhang.com')return new Response('/* fixture */',{headers:{'content-type':'text/javascript'}});
 if(u.origin!==s.base)throw Error('Unplanned request: '+u.href);
 if(u.pathname==='/healthz')return new Response(s.healthBody??'ok fixture\\n',{status:s.healthStatus??200,headers:{location:'/'}});
 if(u.pathname.startsWith('/__release_missing_'))return new Response('missing',{status:404});
 if(u.pathname==='/'&&u.search){
  const rule=s.queries.find(q=>q.url===u.pathname+u.search);
  if(rule)return s.queryNoRedirect?new Response('wrong HTTP 200'):new Response('',{status:301,headers:{location:s.crossOrigin?'https://evil.invalid/':rule.target}});
 }
 if(u.pathname==='/old/')return new Response('',{status:301,headers:{location:'/current/'}});
 if(u.pathname==='/')return new Response('sealed fixture',{headers:{'content-type':'text/html','content-security-policy':"img-src 'self' data:; object-src 'none'",'x-content-type-options':'nosniff'}});
 if(u.pathname==='/current/'||/^\\/post-\\d+\\/$/.test(u.pathname))return new Response('<h1>Fixture</h1>');
 throw Error('Unplanned request: '+u.href);
};
`;
async function fixture(t){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'verify-target-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 await fs.mkdir(path.join(dir,'site'));await fs.writeFile(path.join(dir,'site/index.html'),'sealed fixture');
 const files=await inventory(path.join(dir,'site'));const record={schema:1,artifactHash:rootHash(files),files,config,migrationGaps:[],contentIds:['21']};
 const queries=Array.from({length:389},(_,i)=>({url:'/?p='+(i+1),target:'/post-'+(i+1)+'/'}));
 await atomicJson(path.join(dir,'legacy-urls.json'),[{url:'/old/',target:'/current/'}]);await atomicJson(path.join(dir,'query-urls.json'),queries);
 const preload=path.join(dir,'mock.mjs');await fs.writeFile(preload,mockModule);
 async function run({base=cn,config:cfg=config,full=false,local=false,...scenario}={}){
  await atomicJson(path.join(dir,'release.json'),{...record,config:cfg});
  const calls=path.join(dir,'calls.jsonl'),sc=path.join(dir,'scenario.json');await fs.writeFile(calls,'');await atomicJson(sc,{base,queries,...scenario});
  const result=spawnSync(process.execPath,['--import',preload,cli,dir,'--base',base,...(full?['--full']:[]),...(local?['--local']:[])],{encoding:'utf8',timeout:15000,env:{...process.env,VERIFY_MOCK_CALLS:calls,VERIFY_MOCK_SCENARIO:sc}});
  const receipt=JSON.parse(await fs.readFile(path.join(dir,local?'verified-local.json':full?'verified-full.json':'verified-static.json'),'utf8'));
  return {result,receipt,calls:(await fs.readFile(calls,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line))};
 }
 return {run};
}

test('target policy permits only sealed publication, reviewed Pages and explicit loopback',()=>{
 assert.deepEqual(verificationTarget(cn,config).queries,true);assert.equal(verificationTarget(cn,config).health,true);
 assert.equal(verificationTarget(preview,config).kind,'pages');assert.equal(verificationTarget('https://stefanzhang-com.pages.dev',config).kind,'pages');
 assert.equal(verificationTarget('http://127.0.0.1:4330',config,{local:true}).kind,'local');
 const old={...config};delete old.publicationOrigin;assert.equal(verificationTarget(com,old).queries,true);assert.equal(verificationTarget(preview,old).kind,'pages');assert.throws(()=>verificationTarget(cn,old));
 for(const input of [com,'https://www.stefanzhang.cn','http://stefanzhang.cn','https://user:secret@stefanzhang.cn','https://stefanzhang.cn:443','https://stefanzhang.cn:8443','https://stefanzhang.cn/path','https://stefanzhang.cn/?x=1','https://stefanzhang.cn/#x','https://stefanzhang.cn.evil.invalid','https://evil.invalid','https://fake.stefanzhang-com.pages.dev.evil.invalid','https://deep.fake.stefanzhang-com.pages.dev','https://stefanzhang.cn/../','file:///tmp'])assert.throws(()=>verificationTarget(input,config),input);
 assert.throws(()=>verificationTarget(cn,config,{local:true}));
 for(const override of [{publicationOrigin:'https://evil.invalid'},{publicationOrigin:undefined},{canonicalOrigin:cn},{pagesProject:'other'},{extra:'unreviewed'},{likesApi:'http://localhost:8787'}])assert.throws(()=>verificationTarget(cn,{...config,...override}));
});

test('CN HTTP verifies every query and health without adding health to sealed file count or requiring noindex',async t=>{
 const f=await fixture(t);const r=await f.run();assert.equal(r.result.status,0,r.result.stderr);assert.equal(r.receipt.filesChecked,1);assert.equal(r.receipt.legacyUrlsChecked,390);assert.equal(r.receipt.passed,true);
 assert.equal(r.calls.filter(c=>new URL(c.url).search).length,389);const health=r.calls.filter(c=>new URL(c.url).pathname==='/healthz');assert.equal(health.length,1);assert.equal(health[0].method,'GET');
 assert.ok(r.receipt.timing.resourcesMs>=0);assert.ok(r.receipt.timing.legacyMs>=0);
 assert.equal(r.receipt.timing.slowResources.length,1);assert.equal(r.receipt.timing.slowResources[0].url,'/');
 assert.equal(r.receipt.timing.slowResources[0].bytes,Buffer.byteLength('sealed fixture'));
 assert.ok(r.receipt.timing.slowResources[0].ttfbMs>=0);
});

test('old canonical publication still verifies queries while Pages and local omit host-only queries/health',async t=>{
 const f=await fixture(t);const old={...config};delete old.publicationOrigin;
 for(const options of [{base:com,config:old},{base:com,config:{...config,publicationOrigin:com}},{base:preview},{base:'http://127.0.0.1:4330',local:true}]){
  const r=await f.run(options);assert.equal(r.result.status,0,r.result.stderr);assert.equal(r.receipt.legacyUrlsChecked,options.base===com?390:1);assert.equal(r.calls.some(c=>new URL(c.url).pathname==='/healthz'),false);
 }
});

test('CN health rejects missing, redirected, malformed and oversized readiness responses',async t=>{
 const f=await fixture(t);
 for(const options of [{healthStatus:404},{healthStatus:301},{healthStatus:503},{healthBody:'OK fixture'},{healthBody:'ok'},{healthBody:'ok '+'x'.repeat(1024)}]){
  const r=await f.run(options);assert.equal(r.result.status,1);assert.ok(r.receipt.failures.some(x=>x.url==='/healthz'));assert.equal(r.receipt.passed,false);
 }
});

test('CN full verification retains Worker readiness and both canonical/publication CORS requirements',async t=>{
 const f=await fixture(t);const cfg={...config,likesApi:'https://likes.stefanzhang.com',artalkServer:'https://comments.stefanzhang.com'};
 for(const serviceFailure of ['health','cors']){const r=await f.run({config:cfg,full:true,serviceFailure});assert.equal(r.result.status,1);assert.ok(r.receipt.failures.some(x=>x.url===cfg.likesApi));}
 const good=await f.run({config:cfg,full:true});assert.equal(good.result.status,0,good.result.stderr);assert.deepEqual(good.receipt.services,['likes/read/CORS/schema','artalk-assets']);
 assert.deepEqual([...new Set(good.calls.filter(c=>new URL(c.url).pathname.startsWith('/api/')).map(c=>c.origin))].sort(),[cn,com].sort());
 const staticOnly=await f.run({config:cfg,serviceFailure:'health'});assert.equal(staticOnly.result.status,0);assert.equal(staticOnly.calls.some(c=>new URL(c.url).hostname==='likes.stefanzhang.com'),false);
});

test('query HTTP 200 without a redirect and offsite redirect cannot produce a successful receipt',async t=>{
 const f=await fixture(t);
 for(const options of [{queryNoRedirect:true},{crossOrigin:true}]){const r=await f.run(options);assert.equal(r.result.status,1);assert.equal(r.receipt.passed,false);assert.equal(r.receipt.failures.length,389);assert.equal(r.calls.some(c=>new URL(c.url).hostname==='evil.invalid'),false);}
});
