import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';
import {onlineEvidence} from '../scripts/lib/online-evidence.mjs';
function fixture(paired=false){
 const run={id:456,run_attempt:2,status:'completed',conclusion:'success',head_sha:'d'.repeat(40),head_branch:'main',path:'.github/workflows/'+(paired?'publish-content.yml':'publish-preview.yml'),repository:{full_name:'StefanZhang/blog-publisher'},head_repository:{full_name:'StefanZhang/blog-publisher'},event:'workflow_dispatch'};
 const payload={schema:1,artifactHash:'b'.repeat(64),sourceCommit:'c'.repeat(40),sourceRun:'123',controllerRun:'456',controllerAttempt:2,controllerCommit:run.head_sha,deploymentURL:'https://1234abcd.stefanzhang-com.pages.dev',manifest:{path:'/_delivery/manifest.json',bytes:100,sha256:'a'.repeat(64)},publicationOrigin:'https://stefanzhang.cn',canonicalOrigin:'https://stefanzhang.com'};
 const trusted={run:structuredClone(run),payload};
 const proof={schema:1,passed:true,status:'pages-verified-cn-handoff-ready',controllerRun:'456',controllerCommit:run.head_sha,controllerAttempt:2,sourceCommit:payload.sourceCommit,cnRun:'123',cnHash:payload.artifactHash,comRun:'124',comHash:'e'.repeat(64),comBase:'https://stefanzhang.com'};
 return {run,trusted,proof};
}
test('maintenance plan requires exact completed handoff and proves CN only',()=>{
 const f=fixture(),p=onlineEvidence(f.run,f.trusted);
 assert.deepEqual(p,{sourceCommit:'c'.repeat(40),cnRun:'123',cnHash:'b'.repeat(64),scope:'maintenance-cn-online'});
 assert.equal('comRun' in p,false);assert.equal('comBase' in p,false);
 assert.throws(()=>onlineEvidence(f.run,f.trusted,f.proof),/cannot claim paired/);
});
test('unfinished, failed, wrong workflow and changed controller/handoff fail closed',()=>{
 for(const mutate of [f=>f.run.status='in_progress',f=>f.run.conclusion='failure',f=>f.run.path='.github/workflows/other.yml',f=>f.trusted.run.run_attempt++,f=>f.trusted.run.head_sha='f'.repeat(40),f=>f.trusted.payload.controllerRun='789',f=>f.trusted.payload.controllerCommit='f'.repeat(40),f=>f.trusted.payload.controllerAttempt=1,f=>f.trusted.payload.sourceRun='latest',f=>f.trusted.payload.deploymentURL='https://evil.invalid',f=>f.trusted.skipped=true]){
  const f=fixture();mutate(f);assert.throws(()=>onlineEvidence(f.run,f.trusted));
 }
});
test('paired plan retains matching COM/CN identity and rejects forged coverage claims',()=>{
 const f=fixture(true),p=onlineEvidence(f.run,f.trusted,f.proof);
 assert.equal(p.scope,'dual-online');assert.equal(p.comRun,'124');assert.equal(p.comBase,'https://stefanzhang.com');
 for(const patch of [{passed:false},{controllerAttempt:1},{sourceCommit:'f'.repeat(40)},{cnRun:'125'},{cnHash:'f'.repeat(64)},{comRun:'latest'},{comHash:'bad'},{comBase:'https://evil.invalid'}])assert.throws(()=>onlineEvidence(f.run,f.trusted,{...f.proof,...patch}));
 assert.throws(()=>onlineEvidence(f.run,f.trusted));
});
test('formal COM recheck remains unattended read-only with metadata diagnostics',async()=>{
 const workflow=await fs.readFile(new URL('../.github/workflows/publish-production.yml',import.meta.url),'utf8');
 const job=workflow.split('\n  verify-domain:\n')[1];assert.ok(job);
 assert.doesNotMatch(job,/CLOUDFLARE|apiToken:|pages deploy|wrangler-action|environment:|\bwrite\b/);
 assert.match(job,/production-project-alias-recheck\.json/);assert.match(job,/if: always\(\)/);
});
