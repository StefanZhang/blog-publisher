import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {digest} from '../scripts/release/files.mjs';
import {assertControllerRun,trustedHandoff,verifyCN} from '../scripts/verify-cn.mjs';

function fixture(){
 const home=Buffer.from('<h1>private fixture homepage bytes</h1>'), calls=[];
 const manifest={schema:1,canonicalOrigin:'https://stefanzhang.com',publicationOrigin:'https://stefanzhang.cn',headersSHA256:'a'.repeat(64),
  files:{'index.html':{bytes:home.length,sha256:digest(home)}},routing:{redirects:[],attachments:[],queries:[]}};
 const bytes=Buffer.from(JSON.stringify(manifest));
 const payload={schema:1,artifactHash:'b'.repeat(64),sourceCommit:'c'.repeat(40),sourceRun:'123',controllerRun:'456',controllerAttempt:2,
  controllerCommit:'d'.repeat(40),deploymentURL:'https://1234abcd.stefanzhang-com.pages.dev',manifest:{path:'/_delivery/manifest.json',bytes:bytes.length,sha256:digest(bytes)},publicationOrigin:manifest.publicationOrigin,canonicalOrigin:manifest.canonicalOrigin};
 const creator={login:'github-actions[bot]',id:41898282,type:'Bot'};
 const run={id:456,run_attempt:2,status:'completed',conclusion:'success',head_sha:payload.controllerCommit,head_branch:'main',path:'.github/workflows/publish-preview.yml',repository:{full_name:'StefanZhang/blog-publisher'},head_repository:{full_name:'StefanZhang/blog-publisher'},event:'workflow_dispatch'};
 const deployment={id:77,environment:'cn-pilot',sha:run.head_sha,ref:run.head_sha,creator,payload};
 const status={state:'success',creator,environment_url:'https://stefanzhang.cn',log_url:'https://github.com/StefanZhang/blog-publisher/actions/runs/456/attempts/2'};
 const publish={name:'publish',status:'completed',conclusion:'success'};
 let clock=0,runReads=0,polls=0;
 const f={home,manifest,bytes,payload,run,deployment,status,publish,calls,policy:{controllerRepo:'StefanZhang/blog-publisher',config:{publicationOrigin:manifest.publicationOrigin,canonicalOrigin:manifest.canonicalOrigin},controlHashes:{_headers:manifest.headersSHA256}}};
 f.api=async endpoint=>{
  calls.push({api:endpoint});
  if(endpoint==='actions/runs/456'){runReads++;return f.changedAttempt&&runReads>1?{...run,run_attempt:3}:run;}
  if(endpoint.includes('/jobs?'))return {jobs:[publish]};
  if(endpoint.startsWith('deployments?'))return f.noHandoff?[]:[deployment];
  if(endpoint==='deployments/77/statuses?per_page=1')return [status];
  throw Error('Unexpected API read');
 };
 f.request=async(url,options)=>{
  url=String(url);calls.push({url,method:options.method,redirect:options.redirect});
  if(url==='https://stefanzhang.cn/_delivery/manifest.json'){
   polls++;return new Response(f.staleForever||(f.staleOnce&&polls===1)?'old':f.bytes,{headers:{'content-type':'application/json'}});
  }
  if(url==='https://stefanzhang.cn/')return new Response(f.badHome?'changed':home,{headers:{'content-type':'text/html'}});
  if(url==='https://stefanzhang.cn/healthz')return new Response(f.badHealth?'bad':'ok fixture');
  if(url.startsWith('https://www.stefanzhang.cn/'))return new Response('',{status:301,headers:{location:f.badWWW?'https://evil.invalid/':url.replace('https://www.stefanzhang.cn','https://stefanzhang.cn')}});
  throw Error('Unexpected external request');
 };
 f.audit=()=>verifyCN({controllerRun:'456',api:f.api,policy:f.policy,request:f.request,now:()=>clock,sleep:async ms=>{clock+=ms;},waitMs:60,pollMs:30});
 return f;
}

test('CN identity waits for matching manifest then verifies homepage/health/www and rechecks completed controller',async()=>{
 const f=fixture();f.staleOnce=true;const r=await f.audit();assert.equal(r.passed,true);assert.equal(r.scope,'installation-identity');
 assert.equal(r.manifestMatched,true);assert.equal(r.filesChecked,1);assert.equal(r.legacyUrlsChecked,0);assert.equal(r.healthChecked,true);assert.equal(r.wwwRedirectsChecked,2);
 assert.equal(f.calls.filter(c=>c.url?.endsWith('/manifest.json')).length,2);assert.equal(f.calls.filter(c=>c.api==='actions/runs/456').length,2);
 assert.equal(f.calls.some(c=>c.url?.includes('pages.dev')),false);assert.equal(f.calls.filter(c=>c.url).every(c=>c.method==='GET'&&c.redirect==='manual'),true);
 assert.ok(!JSON.stringify(r).includes(f.home.toString()));assert.ok(!JSON.stringify(r).includes('index.html'));
});

test('successful no-op controller run is not an installation pass or missing-deployment alarm',async()=>{
 const f=fixture();f.publish.conclusion='skipped';const r=await f.audit();assert.equal(r.status,'not-applicable');assert.equal(r.passed,null);assert.equal(r.filesChecked,0);assert.equal(f.calls.some(c=>c.url),false);
});

test('untrusted controller, attempt, bot, status and deployment are rejected before requesting CN',async()=>{
 for(const mutate of [f=>{f.run.conclusion='failure';},f=>{f.run.status='in_progress';},f=>{f.run.event='pull_request';},f=>{f.run.head_branch='other';},f=>{f.run.head_repository.full_name='evil/repo';},f=>{f.run.path='.github/workflows/other.yml';},f=>{f.payload.controllerAttempt=1;},f=>{f.deployment.ref='main';},f=>{f.deployment.creator={login:'github-actions[bot]',type:'Bot',id:1};},f=>{f.status.log_url='https://github.com/evil';},f=>{f.status.state='failure';},f=>{f.payload.deploymentURL='https://evil.invalid';},f=>{f.noHandoff=true;}]){
  const f=fixture();mutate(f);const r=await f.audit();assert.equal(r.passed,false);assert.equal(f.calls.some(c=>c.url),false);assert.equal(r.failures[0].check,'controller');
 }
 const f=fixture();await assert.rejects(trustedHandoff(f.api,'latest'),/concrete/);assert.throws(()=>assertControllerRun(f.run,'456/../1'));
 const invalid=await verifyCN({controllerRun:'accidentally pasted private text',api:f.api,policy:f.policy,request:f.request});assert.equal(invalid.controllerRun,null);assert.ok(!JSON.stringify(invalid).includes('accidentally pasted'));assert.equal(f.calls.length,0);
});

test('a healthy old site times out if manifest is not this approved version',async()=>{
 const f=fixture();f.staleForever=true;const r=await f.audit();assert.equal(r.passed,false);assert.equal(r.manifestMatched,false);assert.equal(r.filesChecked,0);assert.equal(r.failures[0].check,'manifest');assert.match(r.failures[0].error,/deadline/);
 assert.equal(f.calls.filter(c=>c.url?.endsWith('/manifest.json')).length,3);assert.equal(f.calls.some(c=>c.url?.endsWith('/healthz')),false);
});

test('matching manifest cannot hide stale homepage, bad health/www or a later controller attempt',async()=>{
 for(const [flag,check] of [['badHome','homepage'],['badHealth','healthz'],['badWWW','www'],['changedAttempt','controller-recheck']]){
  const f=fixture();f[flag]=true;const r=await f.audit();assert.equal(r.passed,false);assert.equal(r.failures[0].check,check);assert.equal(f.calls.some(c=>c.url?.startsWith('https://evil.invalid')),false);
 }
 const f=fixture();f.policy.controlHashes._headers='f'.repeat(64);const r=await f.audit();assert.equal(r.passed,false);assert.equal(r.failures[0].check,'manifest');
});

test('workflow is read-only, main-only, independently triggered and retains only metadata receipt',async()=>{
 const workflow=await fs.readFile(new URL('../.github/workflows/verify-cn.yml',import.meta.url),'utf8');
 assert.match(workflow,/workflows: \[publish-sealed-preview, publish-content-dual\]/);assert.match(workflow,/types: \[completed\]/);assert.match(workflow,/timeout-minutes: 40/);
 assert.match(workflow,/contents: read\n  actions: read/);assert.ok(!/: write|environment:|CLOUDFLARE_|SSH/.test(workflow));assert.match(workflow,/SOURCE_READ_TOKEN/);
 assert.match(workflow,/ref: main/);assert.match(workflow,/path: \.work\/cn-installation-identity\.json/);
});
