import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
const repo='StefanZhang/stefans_blog';
export function assertArchive(record,run,release){
 const tag='sealed-'+run.id+'-'+run.run_attempt;
 if(release?.draft!==false||release.prerelease!==true||release.tag_name!==tag||release.target_commitish!==run.head_sha)throw Error('Missing published private archive for this run attempt');
 if(record?.schema!==1||record.sourceRepo!==repo||record.sourceRun!==String(run.id)||record.sourceAttempt!==run.run_attempt||record.sourceCommit!==run.head_sha||!/^[a-f0-9]{64}$/.test(record.artifactHash||'')||!/^[a-f0-9]{64}$/.test(record.zipSHA||'')||!Number.isSafeInteger(record.zipBytes)||record.zipBytes<1||record.zipBytes>250*1024*1024||record.assetName!=='sealed-'+run.id+'.zip')throw Error('Archive identity mismatch');
}
export async function downloadArchive(run,api,token,root,request=fetch){
 const tag='sealed-'+run.id+'-'+run.run_attempt;
 if(!/^\d+$/.test(String(run.id))||!Number.isSafeInteger(run.run_attempt)||run.run_attempt<1)throw Error('Invalid archive run');
 const destination=await api('');if(destination.full_name!==repo||destination.private!==true)throw Error('Source archive must remain private');
 const release=await api('releases/tags/'+tag);
 const ref=await api('git/ref/tags/'+tag);if(ref.object?.type!=='commit'||ref.object.sha!==run.head_sha)throw Error('Archive tag moved');
 const assets=await api('releases/'+release.id+'/assets?per_page=100');
 if(assets.length!==2||new Set(assets.map(a=>a.name)).size!==2)throw Error('Unexpected private archive asset set');
 async function retrieve(asset,maxBytes,file){
  if(!/^\d+$/.test(String(asset?.id))||asset.state!=='uploaded'||!Number.isSafeInteger(asset.size)||asset.size<1||asset.size>maxBytes)throw Error('Invalid archive asset');
  let response=await request('https://api.github.com/repos/'+repo+'/releases/assets/'+asset.id,{headers:{Authorization:'Bearer '+token,Accept:'application/octet-stream'},redirect:'manual',signal:AbortSignal.timeout(30000)});
  if(response.status===302){
   const url=new URL(response.headers.get('location'));
   if(url.protocol!=='https:'||url.username||url.password||url.port||!(url.hostname==='release-assets.githubusercontent.com'||url.hostname.endsWith('.blob.core.windows.net')))throw Error('Unexpected archive download host');
   response=await request(url.href,{redirect:'error',signal:AbortSignal.timeout(180000)});
  }
  if(response.status!==200||!response.body)throw Error('Archive download HTTP '+response.status);
  const hash=createHash('sha256');let size=0;const chunks=[];const out=file?await fs.open(file,'wx',0o600):null;
  try{for await(const chunk of response.body){size+=chunk.length;if(size>asset.size)throw Error('Archive download exceeds size');hash.update(chunk);if(out)await out.write(chunk);else chunks.push(Buffer.from(chunk));}}finally{await out?.close();}
  const sha=hash.digest('hex');if(size!==asset.size||(asset.digest&&asset.digest!=='sha256:'+sha))throw Error('Archive asset size/digest mismatch');
  return {sha,size,body:file?null:Buffer.concat(chunks)};
 }
 const metadata=assets.find(a=>a.name==='archive.json');const record=JSON.parse((await retrieve(metadata,16384)).body.toString('utf8'));assertArchive(record,run,release);
 const zip=assets.find(a=>a.name===record.assetName);if(zip?.size!==record.zipBytes)throw Error('Archive ZIP size mismatch');
 await fs.mkdir(root,{recursive:true});const downloaded=await retrieve(zip,250*1024*1024,path.join(root,'artifact.zip'));
 if(downloaded.sha!==record.zipSHA)throw Error('Archive ZIP SHA mismatch');
 await fs.writeFile(path.join(root,'archive.json'),JSON.stringify(record,null,2)+'\n',{mode:0o600});
 return record;
}
