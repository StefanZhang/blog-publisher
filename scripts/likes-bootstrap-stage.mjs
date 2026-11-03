import {MAX_ARCHIVE_BYTES} from './lib/archive-limits.mjs';
// Maintainer-only local staging. No Cloudflare calls, deploy commands or secret generation.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawn,spawnSync} from 'node:child_process';
import {assertRun,assertRecord,assertSourceFile,assertControllerChecks} from './policy.mjs';
import {assertArchive} from './archive-source.mjs';
import {restoreArchive} from './restore.mjs';
import {checkSeal,digest} from './release/files.mjs';
import {assertLikesPolicy,prepareWorker,workerConfig,idsHash} from './likes-deploy.mjs';

const SOURCE='StefanZhang/stefans_blog',CONTROLLER='StefanZhang/blog-publisher';
const COMMIT=/^[a-f0-9]{40}$/,HASH=/^[a-f0-9]{64}$/,ID=/^[1-9]\d*$/;
const CONTROLLER_ROOT=fileURLToPath(new URL('../',import.meta.url));
function command(program,args,options={}) {
 const result=spawnSync(program,args,{encoding:'utf8',timeout:60000,maxBuffer:2*1024*1024,...options});
 if(result.error||result.status!==0)throw Error('Read-only local/provider command failed: '+path.basename(program));
 return result.stdout;
}
export function assertLocalController(local,remote,checks,{env=process.env,nodeVersion=process.versions.node}={}) {
 if(env.GITHUB_ACTIONS==='true'||env.GITHUB_WORKFLOW_REF||nodeVersion!=='24.22.2'||
    !COMMIT.test(local?.commit||'')||local.dirty!==false||local.commit!==remote?.commit?.sha)
   throw Error('Bootstrap staging requires a clean current-main local controller and exact Node; no fabricated Actions context');
 assertControllerChecks(checks,local.commit);
}
export async function newPrivateDestination(destination) {
 if(typeof destination!=='string'||!path.isAbsolute(destination)||/[\x00-\x1f]/.test(destination))throw Error('Use a new absolute staging directory outside Git');
 const parent=await fs.realpath(path.dirname(destination));
 const resolved=path.join(parent,path.basename(destination));
 const tempRoots=[...new Set(await Promise.all([os.tmpdir(),'/tmp'].map(dir=>fs.realpath(dir))))];
 if(!tempRoots.some(dir=>parent===dir||parent.startsWith(dir+path.sep)))throw Error('Bootstrap staging must use the system temporary directory, never a desktop/sync directory');
 for(let dir=parent;;dir=path.dirname(dir)){
  try{await fs.lstat(path.join(dir,'.git'));throw Error('Bootstrap staging must stay outside Git working trees');}
  catch(error){if(error.code!=='ENOENT')throw error;}
  if(dir===path.dirname(dir))break;
 }
 try{await fs.lstat(resolved);throw Error('Bootstrap staging destination already exists; never resume or overwrite it');}
 catch(error){if(error.code!=='ENOENT')throw error;}
 return resolved;
}
function validAsset(asset,maxBytes) {
 if(!Number.isSafeInteger(asset?.id)||asset.id<1||asset.state!=='uploaded'||!Number.isSafeInteger(asset.size)||asset.size<1||asset.size>maxBytes)
  throw Error('Invalid private archive asset');
}
async function validateDownload(file,asset) {
 const stat=await fs.lstat(file);
 if(!stat.isFile()||stat.size!==asset.size)throw Error('Downloaded archive asset size/type mismatch');
 if(asset.digest){
  const {createHash}=await import('node:crypto'),{createReadStream}=await import('node:fs');
  const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);
  if(asset.digest!=='sha256:'+hash.digest('hex'))throw Error('Downloaded archive asset digest mismatch');
 }
}
export async function stageBootstrap({destination,sourceRun,sourceCommit,artifactHash,controllerCommit,sourcePolicy,policy,api,download}) {
 if(typeof sourceRun!=='string'||!ID.test(sourceRun)||!COMMIT.test(sourceCommit||'')||!HASH.test(artifactHash||'')||!COMMIT.test(controllerCommit||''))throw Error('Use exact source run, commit, artifact hash and controller commit');
 if(sourcePolicy.sourceRepo!==SOURCE||sourcePolicy.controllerRepo!==CONTROLLER)throw Error('Unexpected bootstrap repository policy');
 assertLikesPolicy(policy);
 const root=await newPrivateDestination(destination);
 const main=(await api('branches/main')).commit?.sha;
 const run=await api('actions/runs/'+sourceRun);
 assertRun(run,main,sourcePolicy);
 if(main!==sourceCommit||!Number.isSafeInteger(run.id)||String(run.id)!==sourceRun||!Number.isSafeInteger(run.run_attempt)||run.run_attempt<1)throw Error('Bootstrap source identity mismatch');
 const repository=await api('');if(repository.full_name!==SOURCE||repository.private!==true)throw Error('Bootstrap source archive must remain private');
 const tag='sealed-'+run.id+'-'+run.run_attempt;
 const release=await api('releases/tags/'+tag);
 const ref=await api('git/ref/tags/'+tag);
 if(ref.object?.type!=='commit'||ref.object.sha!==sourceCommit)throw Error('Private archive tag moved');
 const assets=await api('releases/'+release.id+'/assets?per_page=100');
 if(!Array.isArray(assets)||assets.length!==2||new Set(assets.map(a=>a.name)).size!==2)throw Error('Unexpected private archive asset set');
 const metadata=assets.find(a=>a.name==='archive.json'),zip=assets.find(a=>a.name==='sealed-'+run.id+'.zip');
 validAsset(metadata,16384);validAsset(zip,MAX_ARCHIVE_BYTES);
 // Check the pinned toolchain too; do not relax the normal package policy for bootstrap.
 for(const name of Object.keys(sourcePolicy.sourceFileHashes)){
  const file=await api('contents/'+name+'?ref='+sourceCommit);
  if(file?.type!=='file'||file.path!==name||file.encoding!=='base64'||typeof file.content!=='string'||file.size>2*1024*1024)throw Error('Invalid pinned source file response');
  assertSourceFile(name,Buffer.from(file.content,'base64'),sourcePolicy);
 }
 await fs.mkdir(root,{mode:0o700});
 const archive=path.join(root,'archive');await fs.mkdir(archive,{mode:0o700});
 const metadataPath=path.join(archive,'archive.json');
 await download(metadata,metadataPath);await validateDownload(metadataPath,metadata);
 const meta=JSON.parse(await fs.readFile(metadataPath,'utf8'));assertArchive(meta,run,release);
 if(meta.artifactHash!==artifactHash||zip.size!==meta.zipBytes)throw Error('Selected bootstrap artifact mismatch');
 const zipPath=path.join(archive,meta.assetName);await download(zip,zipPath);await validateDownload(zipPath,zip);
 const restored=path.join(root,'release');await restoreArchive(archive,restored,artifactHash);
 const record=await checkSeal(restored);assertRecord(record,sourcePolicy,sourceCommit,artifactHash);
 const local=JSON.parse(await fs.readFile(path.join(restored,'verified-local.json'),'utf8'));
 if(local.passed!==true||local.kind!=='local'||local.scope!=='static'||local.releaseHash!==artifactHash||!Array.isArray(local.failures)||local.failures.length)throw Error('Missing successful sealed local acceptance');
 const {worker,ids,schemaBytes}=await prepareWorker({root,record,run,api,policy});
 const config={...workerConfig(policy,ids),workers_dev:false,preview_urls:false,triggers:{crons:['17 * * * *']}};
 const configBytes=Buffer.from(JSON.stringify(config,null,2)+'\n');
 await fs.writeFile(path.join(worker,'schema.sql'),schemaBytes,{mode:0o600,flag:'wx'});
 await fs.writeFile(path.join(worker,'wrangler.bootstrap.json'),configBytes,{mode:0o600,flag:'wx'});
 if((await api('branches/main')).commit?.sha!==sourceCommit||
    (await api('branches/main',CONTROLLER)).commit?.sha!==controllerCommit)throw Error('Source or controller main changed during staging; no ready receipt issued');
 const receipt={schema:1,scope:'maintainer-bootstrap-staging',deployed:false,remoteStateVerified:false,
  stagedAt:new Date().toISOString(),controllerCommit,sourceRun,sourceAttempt:run.run_attempt,sourceCommit,artifactHash,
  worker:policy.workerName,databaseId:policy.databaseId,idCount:ids.length,idsSHA256:idsHash(ids),
  sourceHashes:policy.sourceHashes,bootstrapConfigSHA256:digest(configBytes),cron:'17 * * * *',
  workerDirectory:'likes-worker',configPath:'likes-worker/wrangler.bootstrap.json',schemaPath:'likes-worker/schema.sql'};
 await fs.writeFile(path.join(root,'bootstrap-receipt.json'),JSON.stringify(receipt,null,2)+'\n',{mode:0o600,flag:'wx'});
 return {directory:root,...receipt};
}

// Use gh's existing authentication without reading/exporting its token. Every
// request is GET to an exact approved repository; binary downloads are bounded.
export async function ghDownload(asset,destination) {
 const file=await fs.open(destination,'wx',0o600);
 const child=spawn('gh',['api','--method','GET','-H','Accept: application/octet-stream','repos/'+SOURCE+'/releases/assets/'+asset.id],{stdio:['ignore','pipe','ignore']});
 const exited=new Promise(resolve=>{child.once('error',()=>resolve(-1));child.once('close',resolve);});
 const timer=setTimeout(()=>child.kill('SIGKILL'),180000);let bytes=0;
 try{
  for await(const chunk of child.stdout){bytes+=chunk.length;if(bytes>asset.size)throw Error('Private archive download exceeded approved size');await file.write(chunk);}
  if(await exited!==0||bytes!==asset.size)throw Error('Private archive download failed');
 }finally{clearTimeout(timer);child.kill();await file.close();}
}
async function main() {
 const [sourceRun,sourceCommit,artifactHash,destination,...extra]=process.argv.slice(2);
 if(extra.length||!destination)throw Error('Usage: likes-bootstrap-stage.mjs <source-run> <source-commit> <artifact-sha256> <new-absolute-directory>');
 const api=async(endpoint,repo=SOURCE)=>{
  if(![SOURCE,CONTROLLER].includes(repo))throw Error('Unapproved repository');
  try{return JSON.parse(command('gh',['api','--method','GET','repos/'+repo+(endpoint?'/'+endpoint:'')]));}
  catch{throw Error('Read-only GitHub evidence unavailable');}
 };
 const local={commit:command('git',['-C',CONTROLLER_ROOT,'rev-parse','HEAD']).trim(),
  dirty:command('git',['-C',CONTROLLER_ROOT,'status','--porcelain','--untracked-files=normal']).trim()!==''};
 const remote=await api('branches/main',CONTROLLER);
 assertLocalController(local,remote,await api('commits/'+remote.commit?.sha+'/check-runs',CONTROLLER));
 const sourcePolicy=JSON.parse(await fs.readFile(new URL('../policy.json',import.meta.url),'utf8'));
 const policy=JSON.parse(await fs.readFile(new URL('../likes-policy.json',import.meta.url),'utf8'));
 const receipt=await stageBootstrap({destination,sourceRun,sourceCommit,artifactHash,controllerCommit:local.commit,sourcePolicy,policy,api,download:ghDownload});
 console.log(JSON.stringify(receipt,null,2));
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
 try{await main();}catch(error){console.error(error.message);process.exitCode=1;}
}
