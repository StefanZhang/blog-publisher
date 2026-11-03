import {MAX_ARCHIVE_BYTES} from './lib/archive-limits.mjs';
// Recover a private archived package as data. This command never uploads it.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {checkSeal} from './release/files.mjs';
export async function restoreArchive(directory, destination, expectedHash) {
  if (!path.isAbsolute(directory) || !path.isAbsolute(destination) || !/^[a-f0-9]{64}$/.test(expectedHash || '')) throw Error('Use absolute directories and a trusted receipt artifact hash');
  const parent=await fs.realpath(path.dirname(destination));
  const resolvedDestination=path.join(parent,path.basename(destination));
  const controller=await fs.realpath(fileURLToPath(new URL('../',import.meta.url)));
  const cwd=await fs.realpath(process.cwd());
  if([controller,cwd].some(root=>resolvedDestination===root||resolvedDestination.startsWith(root+path.sep)))throw Error('Restore outside the controller and current working tree');
  // Also refuse another Git checkout, including a worktree .git file. Resolve
  // the existing parent first so a symlink cannot hide that destination.
  for(let dir=parent;;dir=path.dirname(dir)){
    try{await fs.lstat(path.join(dir,'.git'));throw Error('Restore outside Git working trees');}
    catch(error){if(error.code!=='ENOENT')throw error;}
    if(dir===path.dirname(dir))break;
  }
  try{await fs.lstat(resolvedDestination);throw Error('Restore destination must not exist');}
  catch(error){if(error.code!=='ENOENT')throw error;}
  const metadataFile=path.join(directory,'archive.json');const metadataStat=await fs.lstat(metadataFile);
  if(!metadataStat.isFile()||metadataStat.size>8192)throw Error('Invalid archive metadata file');
  const meta=JSON.parse(await fs.readFile(metadataFile,'utf8'));
  if(meta.schema!==1||meta.sourceRepo!=='StefanZhang/stefans_blog'||!/^\d+$/.test(meta.sourceRun)||!Number.isSafeInteger(meta.sourceAttempt)||meta.sourceAttempt<1||!/^[a-f0-9]{40}$/.test(meta.sourceCommit)||meta.artifactHash!==expectedHash||!Number.isSafeInteger(meta.zipBytes)||meta.zipBytes<1||meta.zipBytes>MAX_ARCHIVE_BYTES||!/^[a-f0-9]{64}$/.test(meta.zipSHA)||meta.assetName!=='sealed-'+meta.sourceRun+'.zip')throw Error('Invalid archive identity');
  const zip=path.join(directory,meta.assetName);const stat=await fs.lstat(zip);
  if(!stat.isFile()||stat.size!==meta.zipBytes)throw Error('Archive size/type mismatch');
  const hash=createHash('sha256');for await(const chunk of createReadStream(zip))hash.update(chunk);
  if(hash.digest('hex')!==meta.zipSHA)throw Error('Archive digest mismatch');
  // Child extraction inherits restrictive permissions; never expose a private
  // package to other local users just because its parent is a shared /tmp.
  const previousMask=process.umask(0o077);let child;
  try{child=spawnSync('python3',[fileURLToPath(new URL('./unpack.py',import.meta.url)),zip,resolvedDestination],{encoding:'utf8',timeout:180000});}
  finally{process.umask(previousMask);}
  if(child.error)throw Error('Safe restore failed: '+child.error.message);
  if(child.status!==0)throw Error('Safe restore failed: '+(child.stderr||'').slice(-1000));
  const record=await checkSeal(resolvedDestination);
  if(record.artifactHash!==expectedHash||record.sourceCommit!==meta.sourceCommit)throw Error('Restored seal/source identity mismatch');
  // These auxiliary lists are outside the site root hash. Do not let a later
  // local/remote verifier use a restored package as an arbitrary URL fetcher.
  const origin='https://stefanzhang.com';
  for(const name of ['legacy-urls.json','query-urls.json']){
    const cases=JSON.parse(await fs.readFile(path.join(resolvedDestination,name),'utf8'));
    if(!Array.isArray(cases)||cases.length>12000)throw Error('Invalid archived verification cases');
    for(const item of cases)for(const value of [item?.url,item?.target]){
      if(typeof value!=='string'||!value.startsWith('/')||value.startsWith('//')||value.includes('\\')||/[\x00-\x1f]/.test(value)||new URL(value,origin).origin!==origin)throw Error('Unsafe archived verification URL');
    }
  }
  return {sourceRun:meta.sourceRun,sourceAttempt:meta.sourceAttempt,sourceCommit:meta.sourceCommit,artifactHash:record.artifactHash,files:Object.keys(record.files).length,directory:resolvedDestination,deployed:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{console.log(JSON.stringify(await restoreArchive(...process.argv.slice(2)),null,2));}catch(error){console.error(error.message);process.exitCode=1;}
}
