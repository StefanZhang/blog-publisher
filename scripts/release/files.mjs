import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export async function walk(dir) {
  const files=[];
  for(const entry of await fs.readdir(dir,{withFileTypes:true})) {
    if(entry.name==='.DS_Store'||entry.name.startsWith('._'))continue;
    const full=path.join(dir,entry.name);
    if(entry.isSymbolicLink())throw new Error('Symlink forbidden in release inputs: '+full);
    if(entry.isDirectory())files.push(...await walk(full));else if(entry.isFile())files.push(full);
  }
  return files.sort();
}
export function safeRelative(url) {
  const decoded=decodeURIComponent(new URL(url,'https://stefanzhang.com').pathname);
  const rel=decoded.replace(/^\//,'');
  if(!rel||rel.split('/').some(p=>p==='..'||p==='.')||rel.includes('\\')||/[\x00-\x1f]/.test(rel))throw new Error('Unsafe asset path: '+url);
  return rel;
}
export async function atomicJson(file,value) {
  await fs.mkdir(path.dirname(file),{recursive:true});const temp=file+'.pending-'+process.pid;
  await fs.writeFile(temp,JSON.stringify(value,null,2)+'\n');await fs.rename(temp,file);
}
export function skipDerivedInput(rel){return /^(?:public\/images\/opt|public\/og)(?: [1-9]\d*)?(?:\/|$)/.test(rel)||/\.stage-|\.previous-|\.pending/.test(rel)||rel.endsWith('/.dev-likes.json');}
export async function inventory(dir) {
 const out={};
 for(const file of await walk(dir)) {
  const rel=path.relative(dir,file).split(path.sep).join('/');
  if(/(?:^|\/)(?:index|404) [1-9]\d*\.html$|^_astro\/.* [1-9]\d*\.(?:js|css)$|^(?:images\/opt|og) [1-9]\d*\//.test(rel))throw new Error('Duplicate generated release path: '+rel);
  const bytes=await fs.readFile(file);
  if(bytes.length>25*1024*1024)throw new Error('Pages file exceeds 25 MiB: '+rel);
  if(/(^|\/)\.env(?:\.|$)|(?:^|\/)(?:id_rsa|id_ed25519|credentials[^/]*\.json)$|\.(?:pem|key|sql|sqlite|db|php|sh)$/i.test(rel))throw new Error('Secret-like release file: '+rel);
  out[rel]={bytes:bytes.length,sha256:digest(bytes)};
 }
 if(Object.keys(out).length>20000)throw new Error('Pages release exceeds 20000 files');
 return out;
}
export function rootHash(files) {return digest(JSON.stringify(Object.entries(files).sort(([a],[b])=>a < b ? -1 : a > b ? 1 : 0)));}
export async function checkSeal(release) {
 const record=JSON.parse(await fs.readFile(path.join(release,'release.json'),'utf8'));
 if(record.schema!==1)throw new Error('Unsupported release schema');
 const files=await inventory(path.join(release,'site'));const hash=rootHash(files);
 if(hash!==record.artifactHash||JSON.stringify(files)!==JSON.stringify(record.files))throw new Error('Release modified since sealing; prepare a new release');
 return record;
}
