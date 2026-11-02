import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import sourceDefaults from '../policy.json' with {type:'json'};
import likesDefaults from '../likes-policy.json' with {type:'json'};
import {digest,rootHash} from '../scripts/release/files.mjs';
import {idsHash,SOURCE_FILES} from '../scripts/likes-deploy.mjs';
import {assertLocalController,newPrivateDestination,stageBootstrap} from '../scripts/likes-bootstrap-stage.mjs';
const SOURCE='StefanZhang/stefans_blog',CONTROLLER='StefanZhang/blog-publisher';

async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'likes-stage-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const sourceCommit='a'.repeat(40),controllerCommit='b'.repeat(40),html=Buffer.from('<h1>sealed fixture</h1>');
 const files={'index.html':{bytes:html.length,sha256:digest(html)}};
 const record={schema:1,sourceCommit,artifactHash:rootHash(files),config:sourceDefaults.config,migrationGaps:[],contentIds:['22','21'],files};
 const local={passed:true,kind:'local',scope:'static',releaseHash:record.artifactHash,failures:[]};
 const bytes={[SOURCE_FILES[0]]:Buffer.from("import ids from './known-ids.js'; export default {fetch(){return new Response(ids.length)}};"),
  [SOURCE_FILES[1]]:Buffer.from('CREATE TABLE sample(id TEXT);'),'package.json':Buffer.from('{"name":"fixture"}')};
 const policy={...structuredClone(likesDefaults),baselineIds:['21'],baselineIdsSHA256:idsHash(['21']),sourceHashes:Object.fromEntries(SOURCE_FILES.map(name=>[name,digest(bytes[name])]))};
 const sourcePolicy={...structuredClone(sourceDefaults),controlHashes:{},sourceFileHashes:{'package.json':digest(bytes['package.json'])}};
 const zip=path.join(root,'fixture.zip');
 function makeZip(){
  const program="import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1],'w') as z:\n z.writestr('site/index.html',sys.argv[2])\n z.writestr('release.json',sys.argv[3])\n z.writestr('verified-local.json',sys.argv[4])\n z.writestr('legacy-urls.json','[]')\n z.writestr('query-urls.json','[]')";
  assert.equal(spawnSync('python3',['-c',program,zip,html.toString(),JSON.stringify(record),JSON.stringify(local)]).status,0);
 }
 makeZip();const zipBytes=await fs.readFile(zip);
 const meta={schema:1,sourceRepo:SOURCE,sourceRun:'123',sourceAttempt:2,sourceCommit,artifactHash:record.artifactHash,zipBytes:zipBytes.length,zipSHA:digest(zipBytes),assetName:'sealed-123.zip'};
 const run={id:123,run_attempt:2,head_sha:sourceCommit,head_branch:'main',event:'push',path:'.github/workflows/deploy.yml',status:'completed',conclusion:'success',head_repository:{full_name:SOURCE}};
 const release={id:99,draft:false,prerelease:true,tag_name:'sealed-123-2',target_commitish:sourceCommit};
 const f={root,sourceCommit,controllerCommit,record,local,bytes,policy,sourcePolicy,meta,run,release,zipBytes,main:sourceCommit,downloads:[],reads:[],mainReads:0};
 f.api=async(endpoint,repo=SOURCE)=>{
  f.reads.push({endpoint,repo});
  if(repo===CONTROLLER&&endpoint==='branches/main')return {commit:{sha:f.controllerCommit}};
  if(endpoint==='branches/main'){f.mainReads++;return {commit:{sha:f.drift&&f.mainReads>1?'d'.repeat(40):f.main}};}
  if(endpoint==='actions/runs/123')return f.run;
  if(endpoint==='')return {full_name:SOURCE,private:!f.public};
  if(endpoint==='releases/tags/sealed-123-2')return f.release;
  if(endpoint==='git/ref/tags/sealed-123-2')return {object:{type:'commit',sha:f.tagCommit||sourceCommit}};
  if(endpoint==='releases/99/assets?per_page=100')return [{id:1,name:'archive.json',state:'uploaded',size:Buffer.byteLength(JSON.stringify(f.meta))},
    {id:2,name:'sealed-123.zip',state:'uploaded',size:f.zipBytes.length,digest:'sha256:'+digest(zipBytes)}];
  if(endpoint.startsWith('contents/')){
   const name=endpoint.slice(9).split('?')[0],body=f.bytes[name];
   return {type:'file',path:name,encoding:'base64',size:body.length,content:body.toString('base64')};
  }
  throw Error('Unexpected read-only fixture API '+endpoint);
 };
 f.download=async(asset,destination)=>{f.downloads.push(asset.id);await fs.writeFile(destination,asset.id===1?JSON.stringify(f.meta):f.zipBytes,{mode:0o600,flag:'wx'});};
 f.options=()=>({destination:path.join(root,'staged'),sourceRun:'123',sourceCommit,artifactHash:record.artifactHash,controllerCommit,sourcePolicy,policy,api:f.api,download:f.download});
 return f;
}

test('local controller must be clean exact successful main; Actions context is never synthesized',()=>{
 const commit='a'.repeat(40),local={commit,dirty:false},remote={commit:{sha:commit}};
 const checks={check_runs:[{name:'check',app:{id:15368},head_sha:commit,status:'completed',conclusion:'success'}]};
 assertLocalController(local,remote,checks,{env:{},nodeVersion:'24.22.2'});
 for(const bad of [{commit:'b'.repeat(40),dirty:false},{commit,dirty:true}])assert.throws(()=>assertLocalController(bad,remote,checks,{env:{},nodeVersion:'24.22.2'}));
 for(const env of [{GITHUB_ACTIONS:'true'},{GITHUB_WORKFLOW_REF:'spoofed'}])assert.throws(()=>assertLocalController(local,remote,checks,{env,nodeVersion:'24.22.2'}));
 assert.throws(()=>assertLocalController(local,remote,checks,{env:{},nodeVersion:'26.0.0'}));
 assert.throws(()=>assertLocalController(local,remote,{check_runs:[]},{env:{},nodeVersion:'24.22.2'}));
});

test('actual private ZIP is safely restored and stages only pinned Worker/IDs/SQL with no public route or secret',async t=>{
 const f=await fixture(t),result=await stageBootstrap(f.options());
 assert.equal(result.deployed,false);assert.equal(result.remoteStateVerified,false);assert.equal(result.sourceAttempt,2);assert.equal(result.idCount,2);
 const dir=result.directory,config=JSON.parse(await fs.readFile(path.join(dir,result.configPath),'utf8'));
 assert.equal(config.workers_dev,false);assert.equal(config.preview_urls,false);assert.deepEqual(config.triggers,{crons:['17 * * * *']});
 assert.equal(config.d1_databases[0].database_id,f.policy.databaseId);assert.equal(config.vars.KNOWN_IDS_JSON,'["21","22"]');
 assert.equal(config.vars.KNOWN_IDS_SHA256,idsHash(['21','22']));assert.ok(!Object.hasOwn(config,'routes'));assert.ok(!Object.hasOwn(config.vars,'SALT'));
 assert.equal(await fs.readFile(path.join(dir,result.schemaPath),'utf8'),f.bytes[SOURCE_FILES[1]].toString());
 assert.equal((await fs.stat(dir)).mode&0o777,0o700);assert.equal((await fs.stat(path.join(dir,result.configPath))).mode&0o777,0o600);
 assert.equal(JSON.parse(await fs.readFile(path.join(dir,'bootstrap-receipt.json'),'utf8')).artifactHash,f.record.artifactHash);
 assert.deepEqual(f.downloads,[1,2]);assert.ok(f.reads.every(r=>!r.endpoint.includes('cloudflare')));
 await assert.rejects(stageBootstrap(f.options()),/already exists/);
});

test('wrong current main, unfinished/full CI, repository and moved tag cannot produce a ready directory',async t=>{
 for(const mutate of [f=>f.main='c'.repeat(40),f=>f.run.status='in_progress',f=>f.run.conclusion='failure',
  f=>f.run.event='pull_request',f=>f.run.head_branch='topic',f=>f.public=true,f=>f.tagCommit='c'.repeat(40)]){
  const f=await fixture(t);mutate(f);await assert.rejects(stageBootstrap(f.options()));
  await assert.rejects(fs.access(path.join(f.root,'staged','bootstrap-receipt.json')));
 }
});

test('wrong archive identity/hash, tampered ZIP, unreviewed source and main race fail closed without ready receipt',async t=>{
 for(const mutate of [f=>f.release.draft=true,f=>f.release.target_commitish='c'.repeat(40),f=>f.meta.sourceAttempt=1,
  f=>f.meta.artifactHash='c'.repeat(64),f=>f.zipBytes=Buffer.alloc(f.zipBytes.length),
  f=>f.bytes[SOURCE_FILES[0]]=Buffer.from('unreviewed code'),f=>f.bytes['package.json']=Buffer.from('{}'),f=>f.drift=true]){
  const f=await fixture(t);mutate(f);await assert.rejects(stageBootstrap(f.options()));
  await assert.rejects(fs.access(path.join(f.root,'staged','bootstrap-receipt.json')));
 }
 const f=await fixture(t);await assert.rejects(stageBootstrap({...f.options(),artifactHash:'c'.repeat(64)}),/artifact mismatch/);
});

test('staging refuses relative/existing/symlink destinations, sync folders and Git ancestors',async t=>{
 const f=await fixture(t);await assert.rejects(newPrivateDestination('relative'),/absolute/);
 await assert.rejects(newPrivateDestination(f.root),/already exists/);
 const repo=path.join(f.root,'repo');await fs.mkdir(repo);await fs.writeFile(path.join(repo,'.git'),'gitdir: elsewhere');
 await assert.rejects(newPrivateDestination(path.join(repo,'staged')),/outside Git/);
 const link=path.join(f.root,'alias');await fs.symlink(repo,link,'dir');await assert.rejects(newPrivateDestination(path.join(link,'staged')),/outside Git/);
 const existing=path.join(f.root,'existing');await fs.symlink('/tmp',existing,'dir');await assert.rejects(newPrivateDestination(existing),/already exists/);
 await assert.rejects(newPrivateDestination(path.join(os.homedir(),'unwanted-bootstrap')),/system temporary/);
});
