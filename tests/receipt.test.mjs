import{test}from'node:test';import assert from'node:assert/strict';import{publicReceipt}from'../scripts/receipt.mjs';
test('public evidence includes identity/counts but no artifact content or credentials',()=>{
 const record={sourceCommit:'a'.repeat(40),artifactHash:'b'.repeat(64),files:{secret:'not public'},config:{token:'never public'}};
 const env={DEPLOYMENT_URL:'https://4294e64f.stefanzhang-com.pages.dev',SOURCE_RUN:'123',GITHUB_RUN_ID:'456',EXPECTED_HASH:record.artifactHash};
 const proof={passed:true,kind:'remote',scope:'static',base:'https://release-preview.stefanzhang-com.pages.dev',releaseHash:record.artifactHash,failures:[],filesChecked:3290,legacyUrlsChecked:728};
 const result=publicReceipt(record,proof,env);assert.equal(result.filesChecked,3290);assert.ok(!JSON.stringify(result).includes('not public'));assert.ok(!('config'in result));assert.throws(()=>publicReceipt(record,{...proof,passed:false},env));assert.throws(()=>publicReceipt(record,proof,{...env,DEPLOYMENT_URL:'https://evil.invalid/'}));
});
