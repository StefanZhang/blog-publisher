import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';
import {digest,rootHash} from '../scripts/release/files.mjs';import {restoreArchive} from '../scripts/restore.mjs';
test('recover exact archived data; reject tampering, wrong identity and existing destinations',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'restore-test-'));
 try{
  const html=Buffer.from('<h1>sealed</h1>'),files={'index.html':{bytes:html.length,sha256:digest(html)}};
  const record={schema:1,sourceCommit:'a'.repeat(40),artifactHash:rootHash(files),files};
  const zip=path.join(root,'sealed-123.zip');
  const program="import sys,zipfile,json\nwith zipfile.ZipFile(sys.argv[1],'w') as z:\n z.writestr('site/index.html','<h1>sealed</h1>')\n z.writestr('release.json',sys.argv[2])\n z.writestr('legacy-urls.json','[]')\n z.writestr('query-urls.json','[]')";
  assert.equal(spawnSync('python3',['-c',program,zip,JSON.stringify(record)]).status,0);
  const bytes=await fs.readFile(zip),meta={schema:1,sourceRepo:'StefanZhang/stefans_blog',sourceRun:'123',sourceAttempt:1,sourceCommit:record.sourceCommit,artifactHash:record.artifactHash,zipBytes:bytes.length,zipSHA:digest(bytes),assetName:'sealed-123.zip'};
  const write=()=>fs.writeFile(path.join(root,'archive.json'),JSON.stringify(meta));await write();
  const dest=path.join(root,'restored');const result=await restoreArchive(root,dest,record.artifactHash);assert.equal(result.deployed,false);assert.equal(result.files,1);assert.equal((await fs.stat(dest)).mode & 0o777,0o700);assert.equal((await fs.stat(path.join(dest,'site/index.html'))).mode & 0o777,0o600);assert.equal(await fs.readFile(path.join(dest,'site/index.html'),'utf8'),html.toString());
  await assert.rejects(()=>restoreArchive(root,dest,record.artifactHash),/destination must not exist/);
  await assert.rejects(()=>restoreArchive(root,path.join(root,'wrong-hash'),'f'.repeat(64)),/identity/);
  meta.sourceCommit='b'.repeat(40);await write();await assert.rejects(()=>restoreArchive(root,path.join(root,'wrong-commit'),record.artifactHash),/identity mismatch/);
  meta.sourceCommit=record.sourceCommit;await write();await fs.writeFile(zip,Buffer.alloc(bytes.length));await assert.rejects(()=>restoreArchive(root,path.join(root,'tampered'),record.artifactHash),/digest/);
  // A symlinked parent must not sneak the private archive into another repo.
  const repo=path.join(root,'another-checkout');await fs.mkdir(repo);await fs.writeFile(path.join(repo,'.git'),'gitdir: elsewhere');
  const alias=path.join(root,'checkout-link');await fs.symlink(repo,alias,'dir');
  await assert.rejects(()=>restoreArchive(root,path.join(alias,'release'),record.artifactHash),/outside Git/);
  await assert.rejects(()=>restoreArchive(root,path.join(process.cwd(),'private-restore'),record.artifactHash),/outside the controller/);
  await fs.rename(path.join(root,'archive.json'),path.join(root,'metadata-real.json'));
  await fs.symlink(path.join(root,'metadata-real.json'),path.join(root,'archive.json'));
  await assert.rejects(()=>restoreArchive(root,path.join(root,'symlink-metadata'),record.artifactHash),/metadata file/);
  await fs.unlink(path.join(root,'archive.json'));await write();
  meta.assetName='../elsewhere';await write();await assert.rejects(()=>restoreArchive(root,path.join(root,'unsafe'),record.artifactHash),/identity/);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('refuse auxiliary URL changes even if the site seal still matches',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'restore-urls-test-'));
 try{
  const html=Buffer.from('<h1>sealed</h1>'),files={'index.html':{bytes:html.length,sha256:digest(html)}};
  const record={schema:1,sourceCommit:'a'.repeat(40),artifactHash:rootHash(files),files};
  const zip=path.join(root,'sealed-123.zip');
  const program="import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1],'w') as z:\n z.writestr('site/index.html','<h1>sealed</h1>')\n z.writestr('release.json',sys.argv[2])\n z.writestr('legacy-urls.json','[{\"url\":\"https://internal.invalid/\",\"target\":\"/\"}]')\n z.writestr('query-urls.json','[]')";
  assert.equal(spawnSync('python3',['-c',program,zip,JSON.stringify(record)]).status,0);
  const bytes=await fs.readFile(zip);
  await fs.writeFile(path.join(root,'archive.json'),JSON.stringify({schema:1,sourceRepo:'StefanZhang/stefans_blog',sourceRun:'123',sourceAttempt:1,sourceCommit:record.sourceCommit,artifactHash:record.artifactHash,zipBytes:bytes.length,zipSHA:digest(bytes),assetName:'sealed-123.zip'}));
  await assert.rejects(()=>restoreArchive(root,path.join(root,'unsafe-links'),record.artifactHash),/Unsafe archived verification URL/);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
