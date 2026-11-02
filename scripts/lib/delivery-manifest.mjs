// Independently reviewed validation copied from the source delivery manifest format.
// Never import or execute helpers from a downloaded site package.
export const MANIFEST_PATH = '/_delivery/manifest.json';
export const CONTROL_FILES = ['_headers','_redirects','_worker.js','_routes.json'];
export const LIMITS = {manifestBytes:8*1024*1024,files:19995,fileBytes:25*1024*1024,totalBytes:450*1024*1024};
const ORIGIN='https://stefanzhang.com';
const exactKeys=(value,keys)=>value && typeof value==='object' && !Array.isArray(value) && Object.keys(value).sort().join(',')===[...keys].sort().join(',');

export function assertFilePath(name){
 if(typeof name!=='string'||!name||name.length>4096||name.startsWith('/')||/[\\\x00-\x1f\x7f]/.test(name)||name.split('/').some(p=>!p||p==='.'||p==='..'||p.startsWith('.'))||CONTROL_FILES.includes(name)||name===MANIFEST_PATH.slice(1)||/\.(?:pending|stage|previous)-/.test(name)||/^(?:src|scripts|tests|migration|assets|node_modules)\//.test(name)||/^(?:release|source-files|verified-[^/]+)\.json$/.test(name))throw Error('Unsafe or private delivery file path');
}
export function fileRoute(name){
 assertFilePath(name);
 const encode=s=>s.split('/').map(encodeURIComponent).join('/');
 return name==='index.html'?'/':name.endsWith('/index.html')?'/'+encode(name.slice(0,-10)):'/'+encode(name.endsWith('.html')?name.slice(0,-5):name);
}
function assertRoute(value,{fragment=false}={}){
 if(typeof value!=='string'||value.length>4096||!value.startsWith('/')||value.startsWith('//')||/[\\\x00-\x1f\x7f]/.test(value)||value.includes('?')||(!fragment&&value.includes('#')))throw Error('Unsafe delivery route');
 let decoded;try{decoded=decodeURIComponent(value.split('#')[0]);}catch{throw Error('Malformed route encoding');}
 if(/[\\\x00-\x1f\x7f]/.test(decodeURIComponent(value))||decoded.split('/').some(p=>p==='.'||p==='..')||decoded.startsWith('//'))throw Error('Unsafe decoded delivery route');
 if(new URL(value,ORIGIN).origin!==ORIGIN)throw Error('External delivery route');
}
function assertRedirect(rule){
 if(!exactKeys(rule,['source','target','status'])||rule.status!==301)throw Error('Unsupported delivery redirect rule');
 assertRoute(rule.source);assertRoute(rule.target,{fragment:true});
 const tokens=rule.source.match(/:[A-Za-z]\w*|\*/g)||[];
 if(tokens.some(t=>![':page',':slug','*'].includes(t))||new Set(tokens).size!==tokens.length||rule.source.replace(/:page|:slug/g,'').includes(':'))throw Error('Unsupported delivery capture');
 const names=tokens.map(t=>t==='*'?'splat':t.slice(1));
 for(const token of rule.target.match(/:[A-Za-z]\w*/g)||[])if(!names.includes(token.slice(1)))throw Error('Unbound delivery target capture');
 if(rule.target.includes('*')||rule.target.replace(/:page|:slug|:splat/g,'').includes(':'))throw Error('Unsupported delivery target');
}
export function validateManifest(manifest){
 if(!exactKeys(manifest,['schema','canonicalOrigin','publicationOrigin','headersSHA256','files','routing'])||manifest.schema!==1||manifest.canonicalOrigin!==ORIGIN||manifest.publicationOrigin!=='https://stefanzhang.cn'||!/^[a-f0-9]{64}$/.test(manifest.headersSHA256))throw Error('Invalid delivery manifest identity');
 if(!manifest.files||typeof manifest.files!=='object'||Array.isArray(manifest.files))throw Error('Invalid delivery files');
 const entries=Object.entries(manifest.files);if(!entries.length||entries.length>LIMITS.files)throw Error('Delivery file count limit');
 let total=0;const routes=new Set();
 for(const[name,meta]of entries){assertFilePath(name);if(!exactKeys(meta,['bytes','sha256'])||!Number.isSafeInteger(meta.bytes)||meta.bytes<0||meta.bytes>LIMITS.fileBytes||!/^[a-f0-9]{64}$/.test(meta.sha256))throw Error('Invalid delivery file identity');total+=meta.bytes;const route=fileRoute(name);if(routes.has(route))throw Error('Duplicate downloadable delivery route');routes.add(route);}
 if(total>LIMITS.totalBytes)throw Error('Delivery total byte limit');
 const r=manifest.routing;if(!exactKeys(r,['redirects','attachments','queries'])||!Array.isArray(r.redirects)||r.redirects.length>2100||!Array.isArray(r.attachments)||r.attachments.length>2000||!Array.isArray(r.queries)||r.queries.length>5000)throw Error('Invalid delivery routing');
 const sources=new Set();for(const rule of r.redirects){assertRedirect(rule);if(sources.has(rule.source))throw Error('Duplicate delivery redirect');sources.add(rule.source);}
 const attachments=new Set();for(const rule of r.attachments){if(!exactKeys(rule,['path','target']))throw Error('Invalid attachment route');assertRoute(rule.path);assertRoute(rule.target,{fragment:true});if(rule.path.endsWith('/')||attachments.has(rule.path))throw Error('Duplicate/uncanonical attachment path');attachments.add(rule.path);}
 const queries=new Set();let previous=-1;for(const rule of r.queries){const order=['p','page_id','attachment_id'].indexOf(rule.parameter);if(!exactKeys(rule,['parameter','value','target','status'])||order<previous||order<0||rule.status!==301||!/^\d+$/.test(rule.value))throw Error('Invalid query route');previous=order;assertRoute(rule.target,{fragment:true});const key=rule.parameter+'='+rule.value;if(queries.has(key))throw Error('Duplicate query route');queries.add(key);}
 if(Buffer.byteLength(JSON.stringify(manifest,null,2)+'\n')>LIMITS.manifestBytes)throw Error('Delivery manifest byte limit');
 return manifest;
}
