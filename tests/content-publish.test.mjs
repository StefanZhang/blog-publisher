import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {publicationSequence} from '../scripts/content-publish.mjs';
import {assertAutoEnvironment} from '../scripts/content-policy.mjs';
const phases=['likes','comPreview','cnPreview','services','comProduction','cnHandoff'];
test('paired deployment orders ID readiness and both previews before promotion; handoff last',async()=>{
 const seen=[],states=[];await publicationSequence(Object.fromEntries(phases.map(n=>[n,async()=>{seen.push(n);} ])),n=>states.push(n));assert.deepEqual(seen,phases);assert.deepEqual(states,phases);
});
test('any gate failure stops every subsequent mutation and identifies partial completion',async()=>{
 for(let fail=0;fail<phases.length;fail++){
  const seen=[];let phase;
  const tasks=Object.fromEntries(phases.map((n,i)=>[n,async()=>{seen.push(n);if(i===fail)throw Error('injected failure');}]));
  await assert.rejects(publicationSequence(tasks,n=>phase=n),/injected/);assert.deepEqual(seen,phases.slice(0,fail+1));assert.equal(phase,phases[fail]);
 }
});
test('auto credentials require exact current controller and main-only environment',()=>{
 const commit='a'.repeat(40),branch={commit:{sha:commit},protected:true,protection:{enabled:true,required_status_checks:{enforcement_level:'everyone',checks:[{context:'check',app_id:15368}]}},protectionRule:{pattern:'main',allowsForcePushes:false,allowsDeletions:false,requiredApprovingReviewCount:0,requiredStatusCheckContexts:['check']}};
 const env={name:'content-auto',can_admins_bypass:false,deployment_branch_policy:{protected_branches:true,custom_branch_policies:false},protection_rules:[{type:'branch_policy'}]};
 assert.doesNotThrow(()=>assertAutoEnvironment(branch,env,commit));
 for(const update of [{name:'preview'},{can_admins_bypass:true},{deployment_branch_policy:{protected_branches:false}},{protection_rules:[{type:'required_reviewers'}]}])assert.throws(()=>assertAutoEnvironment(branch,{...env,...update},commit));
 assert.throws(()=>assertAutoEnvironment(branch,env,'b'.repeat(40)));assert.throws(()=>assertAutoEnvironment({...branch,protected:false},env,commit));
});
test('content automation does not remove maintenance human approval or place secrets in source',async()=>{
 for(const file of ['publish-preview.yml','publish-production.yml','deploy-likes.yml']){
  const s=await fs.readFile(new URL('../.github/workflows/'+file,import.meta.url),'utf8');assert.match(s,/environment:\s+(?:name:\s+)?preview/g);assert.doesNotMatch(s,/environment: content-auto/);
 }
 const bootstrap=await fs.readFile(new URL('../.github/workflows/bootstrap-content-secrets.yml',import.meta.url),'utf8');assert.match(bootstrap,/environment:\s+(?:name:\s+)?preview/g);assert.match(bootstrap,/path: .work\/content-secrets.encrypted.json/);assert.doesNotMatch(bootstrap,/contents: write|actions: write/);
 const auto=await fs.readFile(new URL('../.github/workflows/publish-content.yml',import.meta.url),'utf8');assert.match(auto,/environment: content-auto/);assert.match(auto,/group: blog-pages-preview/);assert.doesNotMatch(auto,/pull_request_target|contents: write/);
});
