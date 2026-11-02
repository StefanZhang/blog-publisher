import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import policy from '../policy.json' with {type:'json'};
import {digest, rootHash} from '../scripts/release/files.mjs';
import {publicReceipt} from '../scripts/receipt.mjs';
import {handoffPayload, loadHandoff, publishHandoff, validateHandoff} from '../scripts/cn-handoff.mjs';
import {MANIFEST_PATH, LIMITS, validateManifest} from '../scripts/lib/delivery-manifest.mjs';

function fixture() {
  const content=Buffer.from('private site fixture, never in public metadata');
  const controls=Object.fromEntries(['_headers','_redirects','_worker.js','_routes.json'].map(name=>[name,Buffer.from('approved '+name)]));
  const files={'index.html':{bytes:content.length,sha256:digest(content)}};
  const manifest={schema:1,canonicalOrigin:'https://stefanzhang.com',publicationOrigin:'https://stefanzhang.cn',
    headersSHA256:digest(controls._headers),files,routing:{redirects:[],attachments:[],queries:[]}};
  const record={schema:1,sourceCommit:'a'.repeat(40),config:structuredClone(policy.config),migrationGaps:[],files:{...files}};
  for(const[name,bytes]of Object.entries(controls))record.files[name]={bytes:bytes.length,sha256:digest(bytes)};
  const p={...policy,controlHashes:Object.fromEntries(Object.entries(controls).map(([name,bytes])=>[name,digest(bytes)]))};
  const env={GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:policy.controllerRepo,GITHUB_REF:'refs/heads/main',
    GITHUB_WORKFLOW_REF:policy.controllerRepo+'/.github/workflows/publish-preview.yml@refs/heads/main',GITHUB_EVENT_NAME:'workflow_dispatch',
    GITHUB_SHA:'b'.repeat(40),GITHUB_RUN_ID:'456',GITHUB_RUN_ATTEMPT:'2',SOURCE_RUN:'123',EXPECTED_COMMIT:record.sourceCommit,
    DEPLOYMENT_URL:'https://1234abcd.stefanzhang-com.pages.dev/',DEPLOYMENT_ID:'deployment-id'};
  const alias={passed:true,kind:'remote',scope:'static',base:policy.previewOrigin,failures:[],filesChecked:2,legacyUrlsChecked:1,verifiedAt:'2026-11-02T12:00:00.000Z'};
  const fixed={...alias,base:'https://1234abcd.stefanzhang-com.pages.dev'};
  const f={record,policy:p,env,alias,fixed,legacyCount:1,content,controls,manifest};
  f.seal=()=>{
    f.manifestBytes=Buffer.from(JSON.stringify(f.manifest,null,2)+'\n');
    record.files[MANIFEST_PATH.slice(1)]={bytes:f.manifestBytes.length,sha256:digest(f.manifestBytes)};
    record.artifactHash=rootHash(record.files);env.EXPECTED_HASH=record.artifactHash;alias.releaseHash=record.artifactHash;fixed.releaseHash=record.artifactHash;
    f.receipt=publicReceipt(record,alias,env,fixed);
  };
  f.seal();return f;
}

test('CN handoff contains only exact public metadata, stable identities and manifest digest',()=>{
  const f=fixture(), payload=handoffPayload(f);
  assert.equal(payload.deploymentURL,'https://1234abcd.stefanzhang-com.pages.dev');
  assert.equal(payload.controllerAttempt,2);assert.equal(payload.controllerCommit,f.env.GITHUB_SHA);
  assert.equal(payload.sourceCommit,f.record.sourceCommit);assert.equal(payload.sourceRun,'123');
  assert.deepEqual(payload.manifest,{path:MANIFEST_PATH,bytes:f.manifestBytes.length,sha256:digest(f.manifestBytes)});
  assert.deepEqual(Object.keys(payload).sort(),['schema','artifactHash','sourceCommit','sourceRun','controllerRun','controllerAttempt','controllerCommit','deploymentURL','manifest','publicationOrigin','canonicalOrigin'].sort());
  assert.ok(!JSON.stringify(payload).includes(f.content.toString()));assert.ok(!JSON.stringify(payload).includes('index.html'));
  assert.equal(f.receipt.schema,2);assert.ok(!Object.hasOwn(f.receipt,'manifest')); // old preview receipt remains compatible
});

test('handoff rejects wrong workflow/attempt/main context and stale or incomplete evidence',()=>{
  for(const changes of [{GITHUB_REF:'refs/heads/other'},{GITHUB_SHA:'bad'},{GITHUB_RUN_ATTEMPT:'0'},{GITHUB_RUN_ATTEMPT:'9007199254740992'},
    {GITHUB_WORKFLOW_REF:policy.controllerRepo+'/.github/workflows/other.yml@refs/heads/main'},
    {GITHUB_REPOSITORY:'other/repo'},{GITHUB_EVENT_NAME:'pull_request'},{EXPECTED_COMMIT:'c'.repeat(40)},{EXPECTED_HASH:'c'.repeat(64)}]) {
    const f=fixture();Object.assign(f.env,changes);assert.throws(()=>handoffPayload(f));
  }
  for(const mutate of [f=>{f.fixed.passed=false;},f=>{f.fixed.base=policy.previewOrigin;},f=>{f.receipt.controllerRun='999';},
    f=>{f.fixed.releaseHash='c'.repeat(64);},f=>{f.alias.filesChecked=f.fixed.filesChecked=1;f.receipt=publicReceipt(f.record,f.alias,f.env,f.fixed);},
    f=>{f.legacyCount=2;},f=>{f.record.config.publicationOrigin='https://stefanzhang.com';}]) {
    const f=fixture();mutate(f);assert.throws(()=>handoffPayload(f));
  }
});

test('manifest must be bounded, structured and exactly cover sealed downloadable files and headers',()=>{
  for(const mutate of [f=>{f.manifestBytes=Buffer.from('tampered');},f=>{f.manifestBytes=Buffer.alloc(LIMITS.manifestBytes+1);},
    f=>{f.manifest.headersSHA256='c'.repeat(64);f.seal();},
    f=>{f.manifest.files.extra={bytes:0,sha256:digest(Buffer.alloc(0))};f.seal();},
    f=>{f.manifest.files['index.html']={bytes:1,sha256:'c'.repeat(64)};f.seal();},
    f=>{f.manifest.routing.redirects=[{source:'/old/',target:'https://evil.invalid/',status:301}];f.seal();},
    f=>{f.manifest.sourceFiles={'private.md':'do not publish'};f.seal();}]) {
    const f=fixture();mutate(f);assert.throws(()=>handoffPayload(f));
  }
  const f=fixture();assert.equal(validateManifest(f.manifest),f.manifest);
  for(const field of ['sourceRun','controllerRun','artifactHash']){const p=handoffPayload(f);p[field]=[p[field]];assert.throws(()=>validateHandoff(p));}
  for(const update of [{deploymentURL:policy.previewOrigin},{deploymentURL:'https://1234abcd.stefanzhang-com.pages.dev/path'},
    {controllerAttempt:1.5},{manifest:{path:'https://evil.invalid/',bytes:1,sha256:'a'.repeat(64)}},{extra:'private'}])assert.throws(()=>validateHandoff({...handoffPayload(f),...update}));
});

test('handoff reads an actual sealed site and fails after bytes change',async t=>{
  const f=fixture(), root=await fs.mkdtemp(path.join(os.tmpdir(),'publisher-cn-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));const release=path.join(root,'release');await fs.mkdir(path.join(release,'site/_delivery'),{recursive:true});
  await fs.writeFile(path.join(release,'site/index.html'),f.content);
  for(const[name,bytes]of Object.entries(f.controls))await fs.writeFile(path.join(release,'site',name),bytes);
  await fs.writeFile(path.join(release,'site',MANIFEST_PATH.slice(1)),f.manifestBytes);
  // inventory serializes paths in sorted order; seal metadata must be identical.
  // Explicit lexical ordering matches walk(), including underscore paths.
  f.record.files=Object.fromEntries(Object.entries(f.record.files).sort(([a],[b])=>a<b?-1:a>b?1:0));
  for(const[name,value]of [['release/release.json',f.record],['release/legacy-urls.json',[{url:'/',target:'/'}]],
    ['verified-alias.json',f.alias],['verified-fixed.json',f.fixed],['preview-receipt.json',f.receipt]])await fs.writeFile(path.join(root,name),JSON.stringify(value));
  assert.deepEqual(await loadHandoff(root,f.policy,f.env),handoffPayload(f));
  await fs.appendFile(path.join(release,'site/index.html'),'changed');await assert.rejects(loadHandoff(root,f.policy,f.env),/modified since sealing/);
});

test('GitHub cn-pilot ledger accepts app:null, and failed status never returns success',async()=>{
  const p=handoffPayload(fixture()),calls=[];
  const api=async(endpoint,body)=>{calls.push({endpoint,body});return endpoint==='deployments'?{id:77,sha:p.controllerCommit,ref:p.controllerCommit,environment:'cn-pilot',payload:body.payload,app:null}:{state:'success'};};
  assert.equal(await publishHandoff(api,p),77);assert.equal(calls.length,2);
  assert.equal(calls[0].body.ref,p.controllerCommit);assert.equal(calls[0].body.auto_merge,false);assert.deepEqual(calls[0].body.required_contexts,[]);
  assert.equal(calls[1].body.state,'success');assert.equal(calls[1].body.auto_inactive,false);
  assert.match(calls[1].body.description,/wait for completed\/success/);
  await assert.rejects(publishHandoff(async(endpoint,body)=>{if(endpoint!=='deployments')throw Error('status unavailable');return {id:77,sha:p.controllerCommit,ref:p.controllerCommit,environment:'cn-pilot',payload:body.payload};},p),/status unavailable/);
  await assert.rejects(publishHandoff(async(endpoint,body)=>endpoint==='deployments'?{id:77,sha:p.controllerCommit,ref:p.controllerCommit,environment:'cn-pilot',payload:body.payload}:{state:'error'},p),/did not confirm/);
  await assert.rejects(publishHandoff(async()=>({id:77,sha:'c'.repeat(40),environment:'cn-pilot',payload:p}),p),/identity mismatch/);
});

test('workflow approval names .cn and handoff runs after preview receipt upload',async()=>{
  const workflow=await fs.readFile(new URL('../.github/workflows/publish-preview.yml',import.meta.url),'utf8');
  assert.match(workflow,/run-name: Preview then update public \.cn/);
  assert.ok(workflow.indexOf('run: node scripts/cn-handoff.mjs')>workflow.indexOf('name: preview-receipt-${{ github.run_id }}'));
  assert.ok(workflow.indexOf('run: node scripts/cn-handoff.mjs')<workflow.indexOf('name: Record preview result'));
  assert.ok(!workflow.includes('environment: cn-pilot'));assert.ok(!workflow.includes('contents: write'));
  const controller=await fs.readFile(new URL('../scripts/controller.mjs',import.meta.url),'utf8');assert.match(controller,/Approval permits updating the public https:\/\/stefanzhang\.cn/);
});
