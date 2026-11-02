import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';
import {cloudflareRead,main,assertReadinessApproval} from '../scripts/content-readiness.mjs';
test('credential integration uses GET only and rejects HTTP/provider errors',async()=>{
 const request=async(url,options)=>{assert.equal(options.method,'GET');assert.equal(options.body,undefined);return new Response(JSON.stringify({success:true,result:{ok:true}}));};
 assert.deepEqual(await cloudflareRead('https://example.invalid','synthetic',request),{ok:true});
 for(const response of [new Response('{}',{status:403}),new Response('{"success":false}')])await assert.rejects(cloudflareRead('https://example.invalid','synthetic',async()=>response),/failed/);
});
test('readiness cannot be invoked as the publishing job; it has no deployment write implementation',async()=>{
 await assert.rejects(main({}),/context/);
 const code=await fs.readFile(new URL('../scripts/content-readiness.mjs',import.meta.url),'utf8');assert.doesNotMatch(code,/publishWorker|publishHandoff|pages.*deploy|wrangler|method:'POST'|method:'PUT'/);
});

test('baseline readiness verifies actual main CI merge evidence without granting publication',()=>{
 const sha='a'.repeat(40),run={id:8,run_attempt:1,head_sha:sha},config={baselineCommit:sha};
 const proof={schema:1,sourceRepo:'StefanZhang/stefans_blog',sourceCommit:sha,sourceRun:'8',sourceAttempt:1,boundaryCommit:sha,chain:[]};
 assert.doesNotThrow(()=>assertReadinessApproval(proof,run,config));
 for(const change of [{sourceAttempt:2},{sourceRun:'9'},{boundaryCommit:'b'.repeat(40)},{chain:[{}]}])assert.throws(()=>assertReadinessApproval({...proof,...change},run,config));
});
