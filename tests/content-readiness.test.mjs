import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';
import {cloudflareRead,main} from '../scripts/content-readiness.mjs';
test('credential integration uses GET only and rejects HTTP/provider errors',async()=>{
 const request=async(url,options)=>{assert.equal(options.method,'GET');assert.equal(options.body,undefined);return new Response(JSON.stringify({success:true,result:{ok:true}}));};
 assert.deepEqual(await cloudflareRead('https://example.invalid','synthetic',request),{ok:true});
 for(const response of [new Response('{}',{status:403}),new Response('{"success":false}')])await assert.rejects(cloudflareRead('https://example.invalid','synthetic',async()=>response),/failed/);
});
test('readiness cannot be invoked as the publishing job; it has no deployment write implementation',async()=>{
 await assert.rejects(main({}),/context/);
 const code=await fs.readFile(new URL('../scripts/content-readiness.mjs',import.meta.url),'utf8');assert.doesNotMatch(code,/publishWorker|publishHandoff|pages.*deploy|wrangler|method:'POST'|method:'PUT'/);
});
