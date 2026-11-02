import{test}from'node:test';import assert from'node:assert/strict';import fs from'node:fs/promises';import os from'node:os';import path from'node:path';import{createHash}from'node:crypto';
import{assertArchive,downloadArchive}from'../scripts/archive-source.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const run={id:123,run_attempt:2,head_sha:'a'.repeat(40)},release={id:9,draft:false,prerelease:true,tag_name:'sealed-123-2',target_commitish:run.head_sha};const zip=Buffer.from('fixture zip bytes');const meta={schema:1,sourceRepo:'StefanZhang/stefans_blog',sourceRun:'123',sourceAttempt:2,sourceCommit:run.head_sha,artifactHash:'b'.repeat(64),zipBytes:zip.length,zipSHA:sha(zip),assetName:'sealed-123.zip'};
test('archive must be published, exact source attempt, commit and bounded size',()=>{
 assert.doesNotThrow(()=>assertArchive(meta,run,release));
 for(const change of [{sourceAttempt:1},{sourceCommit:'c'.repeat(40)},{zipBytes:Infinity},{zipBytes:300*1024*1024},{assetName:'../x'},{sourceRun:'other'}])assert.throws(()=>assertArchive({...meta,...change},run,release));
 for(const change of [{draft:true},{target_commitish:'main'},{tag_name:'sealed-123-1'}])assert.throws(()=>assertArchive(meta,run,{...release,...change}));
});
test('download verified private release ZIP without forwarding token to signed storage',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'archive-source-'));const json=Buffer.from(JSON.stringify(meta));
 const assets=[{id:1,state:'uploaded',name:'archive.json',size:json.length,digest:'sha256:'+sha(json)},{id:2,state:'uploaded',name:meta.assetName,size:zip.length,digest:'sha256:'+sha(zip)}];
 const api=async endpoint=>endpoint===''?{full_name:meta.sourceRepo,private:true}:endpoint.startsWith('releases/tags/')?release:endpoint.startsWith('git/ref/')?{object:{type:'commit',sha:run.head_sha}}:assets;
 let corrupted=false,evil=false;
 const request=async(url,options)=>{
  if(url.startsWith('https://api.github.com/')){assert.equal(options.headers.Authorization,'Bearer test-token');if(url.endsWith('/1'))return new Response(json);return new Response(null,{status:302,headers:{location:evil?'https://evil.invalid/data':'https://release-assets.githubusercontent.com/download'}});}
  assert.equal(options.headers,undefined);assert.equal(options.redirect,'error');return new Response(corrupted?Buffer.alloc(zip.length):zip);
 };
 try{
  assert.deepEqual(await downloadArchive(run,api,'test-token',path.join(root,'valid'),request),meta);
  assert.deepEqual(await fs.readFile(path.join(root,'valid/artifact.zip')),zip);
  corrupted=true;await assert.rejects(()=>downloadArchive(run,api,'test-token',path.join(root,'bad'),request),/digest/);
  corrupted=false;evil=true;await assert.rejects(()=>downloadArchive(run,api,'test-token',path.join(root,'evil'),request),/host/);
  await assert.rejects(()=>downloadArchive(run,async()=>({full_name:meta.sourceRepo,private:false}),'test-token',path.join(root,'public'),request),/private/);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
