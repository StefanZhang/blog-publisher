import fs from 'node:fs/promises';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {digest} from './release/files.mjs';

export const SERVICE_RECEIPT_MAX_AGE_MS = 15 * 60 * 1000;
const VERSION = '2.10.1';
const ORIGINS = ['https://stefanzhang.com','https://stefanzhang.cn','https://release-preview.stefanzhang-com.pages.dev'];
const ENDPOINTS = {likes:'https://likes.stefanzhang.com',artalk:'https://comments.stefanzhang.com'};
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const sameKeys = (value, keys) => object(value) && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());
const count = value => Number.isSafeInteger(value) && value >= 0;
const identity = values => ({count:values.length,sha256:digest(JSON.stringify(values))});
const unique = values => [...new Set(values)].sort();

export function serviceInventory(record, policy, pageKeys) {
  if (record.config?.canonicalOrigin !== ORIGINS[0] || record.config.publicationOrigin !== ORIGINS[1] ||
      policy.previewOrigin !== ORIGINS[2] || record.config.likesApi !== ENDPOINTS.likes || record.config.artalkServer !== ENDPOINTS.artalk)
    throw Error('Services require the exact reviewed publication and service origins');
  if (!Array.isArray(record.contentIds) || !record.contentIds.length || record.contentIds.length > 20000 ||
      record.contentIds.some(id => typeof id !== 'string' || !/^(?:[1-9]\d*|note-\d+)$/.test(id)) ||
      new Set(record.contentIds).size !== record.contentIds.length) throw Error('Invalid sealed content IDs');
  if (!Array.isArray(pageKeys) || !pageKeys.length || pageKeys.length > 20000 ||
      pageKeys.some(key => typeof key !== 'string' || !/^\/(?:[A-Za-z0-9_-]+\/)*(?:#[A-Za-z0-9_-]+)?$/.test(key)))
    throw Error('Invalid sealed comment page keys');
  return {ids:unique(record.contentIds),pageKeys:unique(pageKeys),origins:[...ORIGINS],endpoints:{...ENDPOINTS}};
}

// Read data, never import or execute anything from the sealed site. The current
// template emits quoted attributes on section elements; fail closed on drift.
export async function readCommentPageKeys(release, record) {
  const keys=[];
  for (const name of Object.keys(record.files).filter(name => name.endsWith('.html'))) {
    if (name.startsWith('/') || name.split('/').some(part => part === '..') || name.includes('\\')) throw Error('Unsafe sealed HTML path');
    const html=await fs.readFile(path.join(release,'site',name),'utf8');
    for (const tag of html.matchAll(/<section\b[^>]*>/gi)) {
      if (!/\sdata-comments(?:\s|=|>)/.test(tag[0])) continue;
      const match=tag[0].match(/\sdata-page-key=(?:"([^"]*)"|'([^']*)')/);
      if (!match) throw Error('Missing sealed comment page key');
      keys.push(match[1] ?? match[2]);
    }
  }
  return unique(keys);
}

function binding(record, policy, env, pageKeys) {
  const inventory=serviceInventory(record,policy,pageKeys);
  return {schema:1,scope:'read-only-services',artifactHash:record.artifactHash,sourceCommit:record.sourceCommit,
    sourceRun:env.SOURCE_RUN,controllerRun:env.GITHUB_RUN_ID,controllerAttempt:Number(env.GITHUB_RUN_ATTEMPT),controllerCommit:env.GITHUB_SHA,
    configSHA256:digest(JSON.stringify(record.config)),contentIds:identity(inventory.ids),pageKeys:identity(inventory.pageKeys),
    origins:inventory.origins,endpoints:inventory.endpoints,artalkVersion:VERSION};
}
function expectedChecks(inventory) {
  return {workerHealth:3,workerCounts:3*2*Math.ceil(inventory.ids.length/100),artalkConfig:3,artalkPages:3*inventory.pageKeys.length};
}

function validCommentList(comments, pageKey) {
  if (!Array.isArray(comments)) return false;
  const ids=new Set();
  for (const comment of comments) {
    if (!object(comment) || !Number.isSafeInteger(comment.id) || comment.id<1 || ids.has(comment.id) ||
        !count(comment.rid) || typeof comment.visible!=='boolean' ||
        comment.page_key!==pageKey || comment.site_name!=='stefanzhang.com') return false;
    ids.add(comment.id);
  }
  // Artalk 2.10.1 applies limit=1 before adding a missing direct parent in
  // flat mode. CookComment marks the selected row visible; only the appended
  // parent is invisible. This is not recursive and pinned rows only affect sort.
  const selected=comments.filter(comment=>comment.visible);
  if (!comments.length) return true;
  if (selected.length!==1) return false;
  return comments.every(comment=>comment.visible || comment.id===selected[0].rid);
}

export function assertServicesReceipt(receipt, {record,policy,env,pageKeys,now=Date.now()}) {
  const expected=binding(record,policy,env,pageKeys);
  if (!sameKeys(receipt,[...Object.keys(expected),'startedAt','verifiedAt','passed','checks','failures']) ||
      Object.entries(expected).some(([key,value])=>!isDeepStrictEqual(receipt[key],value)) ||
      receipt.passed !== true || !isDeepStrictEqual(receipt.failures,[]) ||
      !isDeepStrictEqual(receipt.checks,expectedChecks(serviceInventory(record,policy,pageKeys)))) throw Error('Services receipt identity or coverage mismatch');
  const start=Date.parse(receipt.startedAt),end=Date.parse(receipt.verifiedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start>end || end>now || now-start>SERVICE_RECEIPT_MAX_AGE_MS)
    throw Error('Services receipt is expired or has invalid timestamps');
  return receipt;
}

class ServiceError extends Error { constructor(code) { super(code); this.code=code; } }
async function readJSON(fetchImpl, url, origin, timeoutMs) {
  let response;
  try { response=await fetchImpl(url,{method:'GET',redirect:'error',cache:'no-store',credentials:'omit',
    headers:{Accept:'application/json',Origin:origin},signal:AbortSignal.timeout(timeoutMs)}); }
  catch { throw new ServiceError('network-or-timeout'); }
  if (response.status !== 200) throw new ServiceError('http-'+response.status);
  if (response.headers.get('access-control-allow-origin') !== origin) throw new ServiceError('cors-origin');
  if (!/(?:^|,)\s*origin\s*(?:,|$)/i.test(response.headers.get('vary') || '')) throw new ServiceError('cors-vary');
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) throw new ServiceError('json-content-type');
  const reader=response.body?.getReader();
  if (!reader) throw new ServiceError('empty-body');
  let size=0;const chunks=[];
  try {
    while(true) { const {done,value}=await reader.read();if(done)break;size+=value.length;
      if(size>1024*1024){await reader.cancel();throw new ServiceError('body-limit');}chunks.push(value); }
  } catch(error) { throw error instanceof ServiceError ? error : new ServiceError('network-or-timeout'); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ServiceError('invalid-json'); }
}

export async function verifyServices({record,policy,env,pageKeys,fetchImpl=fetch,now=()=>Date.now(),timeoutMs=10000}) {
  const inventory=serviceInventory(record,policy,pageKeys),started=now();
  const receipt={...binding(record,policy,env,pageKeys),startedAt:new Date(started).toISOString(),verifiedAt:null,passed:false,
    checks:{workerHealth:0,workerCounts:0,artalkConfig:0,artalkPages:0},failures:[]};
  let check='worker-health',origin=ORIGINS[0];
  const read=url=>{
    if(now()-started>5*60*1000)throw new ServiceError('total-time-limit');
    return readJSON(fetchImpl,url,origin,timeoutMs);
  };
  try {
    for (origin of inventory.origins) {
      check='worker-health';
      const health=await read(ENDPOINTS.likes+'/health');
      if(!object(health)||health.ok!==true||health.schema!=='atomic-views-v1')throw new ServiceError('worker-schema');
      receipt.checks.workerHealth++;
      for(const endpoint of ['likes','views'])for(let i=0;i<inventory.ids.length;i+=100) {
        check='worker-'+endpoint;const ids=inventory.ids.slice(i,i+100);
        const values=await read(ENDPOINTS.likes+'/api/'+endpoint+'?ids='+encodeURIComponent(ids.join(',')));
        if(!sameKeys(values,ids)||ids.some(id=>!count(values[id])))throw new ServiceError('worker-counts-or-missing-id');
        receipt.checks.workerCounts++;
      }
      check='artalk-config';
      const conf=await read(ENDPOINTS.artalk+'/api/v2/conf');
      if(!object(conf)||conf.version?.app!=='artalk'||conf.version.version!==VERSION||!object(conf.frontend_conf))throw new ServiceError('artalk-config');
      receipt.checks.artalkConfig++;
      // v2.10.1 comment_list.go uses FindPage; absent pages are constructed but
      // never saved. Do not use /pages/fetch, which creates pages/increments PV.
      for(const pageKey of inventory.pageKeys) {
        check='artalk-page';
        const query=new URLSearchParams({site_name:'stefanzhang.com',page_key:pageKey,limit:'1',flat_mode:'true'});
        const data=await read(ENDPOINTS.artalk+'/api/v2/comments?'+query);
        if(!object(data)||!validCommentList(data.comments,pageKey)||!count(data.count)||!count(data.roots_count)||
           data.count<data.comments.length||data.roots_count>data.count||data.page?.key!==pageKey||data.page?.site_name!=='stefanzhang.com')
          throw new ServiceError('artalk-page');
        receipt.checks.artalkPages++;
      }
    }
    receipt.passed=true;
  } catch(error) {
    // Never retain response bodies, comments, names, mail addresses or arbitrary
    // exception messages from the network in this public controller's logs.
    receipt.failures.push({check,origin,code:error instanceof ServiceError?error.code:'invalid-response'});
  }
  receipt.verifiedAt=new Date(now()).toISOString();
  return receipt;
}
