import fs from 'node:fs/promises';import path from 'node:path';
import {atomicJson,checkSeal,digest} from './files.mjs';
import {hasLocalImagePolicy} from '../lib/image-refs.mjs';
import {verificationTarget,verifyTargetHealth} from './target-policy.mjs';
const release=path.resolve(process.argv[2]||'');const baseIndex=process.argv.indexOf('--base');
if(!process.argv[2]||baseIndex<0)throw new Error('Usage: npm run release:verify -- <release-directory> --base <https-origin> [--full] [--local]');
const full=process.argv.includes('--full'),local=process.argv.includes('--local');
const record=await checkSeal(release);
const target=verificationTarget(process.argv[baseIndex+1],record.config,{local});
const {base}=target;
if(full&&record.migrationGaps.length)throw new Error('Full release blocked by migration gaps: '+record.migrationGaps.join('; '));
const failures=[];let checked=0,next=0;
const urls=Object.entries(record.files).filter(([name])=>!['_headers','_redirects','_worker.js','_routes.json'].includes(name));
const encodePath=name=>name.split('/').map(encodeURIComponent).join('/');
const mimeFor=name=>/\.(png|jpe?g|webp|avif|gif)$/i.test(name)?'image/':name.endsWith('.css')?'text/css':name.endsWith('.js')?'javascript':name.endsWith('.html')?'text/html':null;
await Promise.all(Array.from({length:6},async()=>{while(next<urls.length){
 const [name,meta]=urls[next++];
 const route=name==='index.html'?'/':name.endsWith('/index.html')?'/'+encodePath(name.slice(0,-10)):'/'+encodePath(name.endsWith('.html')?name.slice(0,-5):name);
 try{
  const r=await fetch(new URL(route,base),{redirect:'manual',signal:AbortSignal.timeout(20000)});
  if(r.status!==200)throw new Error('HTTP '+r.status);
  if(!hasLocalImagePolicy(r.headers.get('content-security-policy')))throw new Error('Missing or permissive local-only image CSP');
  const chunks=[];let received=0;const reader=r.body.getReader();while(true){const {value,done}=await reader.read();if(done)break;received+=value.length;if(received>meta.bytes){await reader.cancel();throw new Error('Published body exceeds sealed size: expected '+meta.bytes+' bytes, received at least '+received);}chunks.push(Buffer.from(value));}const bytes=Buffer.concat(chunks);const actualHash=digest(bytes);if(bytes.length!==meta.bytes||actualHash!==meta.sha256)throw new Error('Published bytes differ from sealed artifact: expected '+meta.bytes+' bytes sha256='+meta.sha256+'; received '+bytes.length+' bytes sha256='+actualHash);
  const mime=mimeFor(name);if(mime&&!r.headers.get('content-type')?.includes(mime))throw new Error('Unexpected Content-Type');
  if(!local){
   if(r.headers.get('x-content-type-options')!=='nosniff')throw new Error('Missing nosniff');
   if(/^(?:_astro|images\/opt)\//.test(name)&&!(/immutable/.test(r.headers.get('cache-control')||'')&&/max-age=31536000/.test(r.headers.get('cache-control')||'')))throw new Error('Missing immutable asset cache policy');
  }
 }catch(error){failures.push({url:route,error:error.message});}
 checked++;if(checked%500===0)console.log('verified files',checked,'/',urls.length);
}}));
const cases=JSON.parse(await fs.readFile(path.join(release,'legacy-urls.json'),'utf8'));
// .com Zone redirects and .cn local routing must both cover historical queries.
// Pages preview and the development server do not implement these host rules.
if(target.queries)cases.push(...JSON.parse(await fs.readFile(path.join(release,'query-urls.json'),'utf8')));
for(const c of cases){
 let url=new URL(c.url,base),response;const seen=new Set();let redirects=0;
 try{
  for(let hop=0;hop<10;hop++){
   if(seen.has(url.href))throw new Error('Redirect loop');seen.add(url.href);
   response=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(15000)});
   if(![301,302,303,307,308].includes(response.status))break;
   redirects++;const location=response.headers.get('location');await response.body?.cancel();url=new URL(location,url);
   if(url.origin!==base.origin)throw new Error('Unexpected cross-origin redirect');
  }
  if(c.url.includes('?')&&redirects===0)throw new Error('Legacy query did not redirect');
  if(response.status!==200||decodeURIComponent(url.pathname+url.hash)!==decodeURIComponent(c.target))throw new Error('Unexpected final destination/status: '+response.status+' '+url.pathname+url.hash);
  if(url.hash){if(!(await response.text()).includes('id="'+decodeURIComponent(url.hash.slice(1))+'"'))throw new Error('Missing legacy fragment');}
  else await response.body?.cancel();
 }catch(error){failures.push({url:c.url,error:error.message});}
}
try{const r=await fetch(new URL('/__release_missing_'+record.artifactHash.slice(0,12),base),{redirect:'manual'});if(r.status!==404)throw new Error('Missing page does not return 404');await r.body?.cancel();}catch(error){failures.push({url:'missing-page',error:error.message});}
try{await verifyTargetHealth(target);}catch(error){failures.push({url:'/healthz',error:error.message});}
const services=[];
if(full){
 const origins=[...new Set([record.config.canonicalOrigin,base.origin])];
 const headers={Origin:record.config.canonicalOrigin};
 if(record.config.likesApi!=='off')try{
  const health=await fetch(record.config.likesApi+'/health',{headers,signal:AbortSignal.timeout(15000)});const data=await health.json();
  if(!health.ok||!data.ok||data.schema!=='atomic-views-v1')throw new Error('Worker schema/readiness mismatch');
  for(const origin of origins)for(const endpoint of ['likes','views'])for(let i=0;i<record.contentIds.length;i+=100){const ids=record.contentIds.slice(i,i+100);const r=await fetch(record.config.likesApi+'/api/'+endpoint+'?ids='+encodeURIComponent(ids.join(',')),{headers:{Origin:origin},signal:AbortSignal.timeout(15000)});const data=await r.json();if(!r.ok||ids.some(id=>typeof data[id]!=='number')||r.headers.get('access-control-allow-origin')!==origin)throw new Error('Worker ID list/read/CORS check failed; deploy current known-ids before new pages');}
  services.push('likes/read/CORS/schema');
 }catch(error){failures.push({url:record.config.likesApi,error:error.message});}
 if(record.config.artalkServer!=='off')try{
  const r=await fetch(record.config.artalkServer+'/dist/artalk.js',{headers,signal:AbortSignal.timeout(15000)});
  if(!r.ok||!r.headers.get('content-type')?.includes('javascript'))throw new Error('Artalk JS unavailable or wrong MIME');
  await r.body?.cancel();services.push('artalk-assets');
 }catch(error){failures.push({url:record.config.artalkServer,error:error.message});}
}
const receipt={schema:1,kind:local?'local':'remote',scope:full?'full':'static',releaseHash:record.artifactHash,base:base.origin,verifiedAt:new Date().toISOString(),filesChecked:checked,legacyUrlsChecked:cases.length,services,failures,passed:!failures.length};
const file=path.join(release,local?'verified-local.json':full?'verified-full.json':'verified-static.json');await atomicJson(file,receipt);
console.log('files',checked,'legacy URLs',cases.length,'failures',failures.length,'scope',receipt.scope,'kind',receipt.kind);
for(const f of failures.slice(0,20))console.error(f.url,f.error);
if(failures.length)process.exitCode=1;
