// Trusted publisher only. Downloaded Worker code is compiled only after exact SHA approval.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {assertRun} from './policy.mjs';
import {checkSeal} from './release/files.mjs';

export const WORKFLOW = 'StefanZhang/blog-publisher/.github/workflows/deploy-likes.yml@refs/heads/main';
export const SOURCE_FILES = ['workers/likes/src/index.js', 'workers/likes/schema.sql'];
export const sha = value => createHash('sha256').update(value).digest('hex');
const HEX = /^[a-f0-9]{64}$/, COMMIT = /^[a-f0-9]{40}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ORIGINS = ['https://stefanzhang.com', 'https://stefanzhang.cn', 'https://release-preview.stefanzhang-com.pages.dev'];
function exact(value, keys) { return value && !Array.isArray(value) && Object.keys(value).sort().join('|') === [...keys].sort().join('|'); }
export function canonicalIds(ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 1000 || ids.some(id => typeof id !== 'string' || !/^(?:[1-9][0-9]{0,19}|note-[0-9]{2,10})$/.test(id)) || new Set(ids).size !== ids.length) throw Error('Invalid content ID set');
  const sorted = [...ids].sort();
  if (Buffer.byteLength(JSON.stringify(sorted)) > 5000) throw Error('ID metadata exceeds binding limit');
  return sorted;
}
export const idsHash = ids => sha(JSON.stringify(canonicalIds(ids)));
export function assertSuperset(next, previous) {
  const available = new Set(canonicalIds(next));
  if (canonicalIds(previous).some(id => !available.has(id))) throw Error('Refusing to delete previously deployed IDs');
}
export function assertLikesPolicy(p) {
  if (!exact(p, ['schema','workerName','databaseName','databaseId','compatibilityDate','wranglerVersion','allowedOrigins','sourceHashes','baselineIds','baselineIdsSHA256']) || p.schema !== 1 || p.workerName !== 'sfz-likes' || p.databaseName !== 'sfz-likes' || !UUID.test(p.databaseId || '') || p.compatibilityDate !== '2025-01-01' || p.wranglerVersion !== '4.45.0' || JSON.stringify(p.allowedOrigins) !== JSON.stringify(ORIGINS) || !exact(p.sourceHashes, SOURCE_FILES) || Object.values(p.sourceHashes).some(hash => !HEX.test(hash)) || idsHash(p.baselineIds) !== p.baselineIdsSHA256) throw Error('Likes policy is invalid or maintainer bootstrap is incomplete');
  return p;
}
export function assertContext(env, mode, nodeVersion = process.versions.node) {
  if (!['inspect','publish'].includes(mode) || nodeVersion !== '24.22.2' || env.GITHUB_ACTIONS !== 'true' || env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || env.GITHUB_REPOSITORY !== 'StefanZhang/blog-publisher' || env.GITHUB_REF !== 'refs/heads/main' || env.GITHUB_WORKFLOW_REF !== WORKFLOW || !COMMIT.test(env.GITHUB_SHA || '') || !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID || '') || !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ATTEMPT || '') || env.GITHUB_JOB !== mode || (mode === 'publish' && env.LIKES_ENVIRONMENT !== 'preview')) throw Error('Likes publishing requires this exact main dispatch workflow and protected preview job');
}
export function assertSourceBytes(name, bytes, p) {
  if (!SOURCE_FILES.includes(name) || !Buffer.isBuffer(bytes) || bytes.length > 256 * 1024 || sha(bytes) !== p.sourceHashes[name]) throw Error('Unreviewed likes source bytes: '+name);
}
export function activeVersion(deployments) {
  const latest = deployments?.deployments?.[0];
  if (!UUID.test(latest?.id || '') || latest.strategy !== 'percentage' || latest.versions?.length !== 1 || latest.versions[0].percentage !== 100 || !UUID.test(latest.versions[0].version_id || '')) throw Error('Existing Worker must have one unambiguous active version');
  return {deploymentId: latest.id, versionId: latest.versions[0].version_id};
}
export function versionIds(version, versionId, p) {
  const bindings = version?.resources?.bindings;
  const expectedNames = ['ALLOWED_ORIGIN','DB','KNOWN_IDS_JSON','KNOWN_IDS_SHA256','SALT'];
  if (version?.id !== versionId || !Array.isArray(bindings) || bindings.map(b => b.name).sort().join('|') !== expectedNames.join('|')) throw Error('Invalid or unreviewed Worker version binding set');
  const binding = name => bindings.find(b => b.name === name);
  if (binding('SALT')?.type !== 'secret_text' || binding('DB')?.type !== 'd1' || binding('DB').id !== p.databaseId) throw Error('Existing stable SALT or exact D1 binding is missing');
  if (binding('ALLOWED_ORIGIN')?.type !== 'plain_text' || binding('ALLOWED_ORIGIN').text !== p.allowedOrigins.join(',')) throw Error('Worker origins differ from reviewed policy');
  if (binding('KNOWN_IDS_JSON')?.type !== 'plain_text' || binding('KNOWN_IDS_SHA256')?.type !== 'plain_text') throw Error('Missing deployed ID metadata; maintainer bootstrap required');
  let decoded;
  try { decoded = JSON.parse(binding('KNOWN_IDS_JSON').text); } catch { throw Error('Deployed ID metadata is not valid JSON'); }
  const ids = canonicalIds(decoded);
  if (JSON.stringify(ids) !== binding('KNOWN_IDS_JSON').text || idsHash(ids) !== binding('KNOWN_IDS_SHA256').text) throw Error('Deployed ID metadata hash mismatch');
  assertSuperset(ids, p.baselineIds);
  return ids;
}
export function workerConfig(p, ids) {
  return {name:p.workerName, main:'src/index.js', compatibility_date:p.compatibilityDate,
    d1_databases:[{binding:'DB', database_name:p.databaseName, database_id:p.databaseId}],
    vars:{ALLOWED_ORIGIN:p.allowedOrigins.join(','), KNOWN_IDS_JSON:JSON.stringify(canonicalIds(ids)), KNOWN_IDS_SHA256:idsHash(ids)}};
}
export function parseUploadedVersion(output) {
  const matches = [...output.matchAll(/^Worker Version ID:\s*([a-f0-9-]+)\s*$/gm)];
  if (matches.length !== 1 || !UUID.test(matches[0][1])) throw Error('Wrangler did not return one valid uploaded version ID');
  return matches[0][1];
}
function execute(program, args, options = {}) {
  const result = spawnSync(program, args, {encoding:'utf8', timeout:600000, maxBuffer:2*1024*1024, ...options});
  // Never echo child output: it may contain bindings, private paths or provider responses.
  if (result.error || result.status !== 0) throw Error('Trusted command failed: '+path.basename(program));
  return result.stdout;
}
export async function stageApprovedSource({env, sourcePolicy, api, root, stage = async stageEnv => {
  execute(process.execPath, ['scripts/controller.mjs','stage'], {env:stageEnv});
}, seal = checkSeal}) {
  const main = (await api('branches/main')).commit?.sha;
  const selected = env.BUILD_RUN_ID || 'latest';
  if (selected !== 'latest' && !/^[1-9][0-9]*$/.test(selected)) throw Error('Invalid source run ID');
  const run = selected === 'latest'
    ? (await api('actions/workflows/deploy.yml/runs?branch=main&status=success&per_page=30')).workflow_runs?.find(r => r.head_sha === main && ['push','workflow_dispatch'].includes(r.event))
    : await api('actions/runs/'+selected);
  if (!run || !COMMIT.test(main || '') || !Number.isSafeInteger(run.id) || run.id < 1) throw Error('No successful current-main source run');
  assertRun(run, main, sourcePolicy);
  if (env.EXPECTED_COMMIT && env.EXPECTED_COMMIT !== main) throw Error('Source main changed after approval request');
  await stage({...env, BUILD_RUN_ID:String(run.id), EXPECTED_COMMIT:main});
  const record = await seal(path.join(root,'release'));
  if (record.sourceCommit !== main || !HEX.test(record.artifactHash || '') || (env.EXPECTED_HASH && record.artifactHash !== env.EXPECTED_HASH)) throw Error('Staged source identity mismatch');
  // The trusted controller stage proves main protection, completed CI, privateRelease,
  // archive digest, seal, static acceptance and reviewed policy. It never runs artifact code.
  if ((await api('branches/main')).commit?.sha !== main) throw Error('Source main changed during staging');
  return {record, run};
}
export async function prepareWorker({root, record, run, api, policy}) {
  assertLikesPolicy(policy);
  const ids = canonicalIds(record.contentIds); assertSuperset(ids, policy.baselineIds);
  const worker = path.join(root,'likes-worker'); await fs.mkdir(path.join(worker,'src'), {recursive:true, mode:0o700});
  let schemaBytes;
  for (const name of SOURCE_FILES) {
    const file = await api('contents/'+name+'?ref='+run.head_sha);
    if (file?.type !== 'file' || file.path !== name || file.encoding !== 'base64' || typeof file.content !== 'string' || file.size > 256*1024) throw Error('Invalid pinned source response');
    const bytes = Buffer.from(file.content,'base64'); assertSourceBytes(name,bytes,policy);
    // schema is reviewed and hashed, but never copied to executable work or applied here.
    if (name.endsWith('/index.js')) await fs.writeFile(path.join(worker,'src/index.js'),bytes,{mode:0o600,flag:'wx'});
    else schemaBytes = bytes;
  }
  await fs.writeFile(path.join(worker,'src/known-ids.js'),'export default '+JSON.stringify(ids)+';\n',{mode:0o600,flag:'wx'});
  await fs.writeFile(path.join(worker,'wrangler.json'),JSON.stringify(workerConfig(policy,ids),null,2)+'\n',{mode:0o600,flag:'wx'});
  return {worker,ids,schemaBytes};
}
// Also available to a separately reviewed, maintainer-only bootstrap entry point.
// This stages source bytes only; the caller must prove its own fixed GitHub identity.
// schemaBytes is returned for that caller's one-time migration, never executed here.
export async function stageLikesPackage(options) {
  assertLikesPolicy(options.policy);
  const staged = await stageApprovedSource(options);
  return {...staged,...await prepareWorker({...options,...staged})};
}
export async function publishWorker({policy, ids, worker, cf, wrangler, verify, beforePromote = async () => {}}) {
  const before = activeVersion(await cf('deployments'));
  const deployedIds = versionIds(await cf('versions/'+before.versionId),before.versionId,policy);
  assertSuperset(ids,deployedIds);
  // Read-only health proves the existing SALT meets the Worker's minimum and schema exists.
  await verify(deployedIds);
  const common = ['--config',path.join(worker,'wrangler.json')];
  const uploaded = parseUploadedVersion(await wrangler(['versions','upload',...common,'--experimental-auto-create=false','--message','Reviewed sealed source; IDs '+idsHash(ids)]));
  const uploadedIds = versionIds(await cf('versions/'+uploaded),uploaded,policy);
  if (idsHash(uploadedIds) !== idsHash(ids)) throw Error('Uploaded version ID set mismatch');
  await beforePromote();
  const rechecked = activeVersion(await cf('deployments'));
  if (rechecked.deploymentId !== before.deploymentId || rechecked.versionId !== before.versionId) throw Error('Worker changed while uploading; refusing to overwrite');
  try {
    await wrangler(['versions','deploy',uploaded+'@100%',...common,'--yes']);
    const after = activeVersion(await cf('deployments'));
    if (after.versionId !== uploaded) throw Error('Published Worker version could not be confirmed');
    if (idsHash(versionIds(await cf('versions/'+after.versionId),after.versionId,policy)) !== idsHash(ids)) throw Error('Published IDs could not be confirmed');
    await verify(ids);
    return {workerVersion:uploaded,deploymentId:after.deploymentId,previousVersion:before.versionId,idsSHA256:idsHash(ids),idCount:ids.length};
  } catch (failure) {
    let current;
    try { current = activeVersion(await cf('deployments')); }
    catch { throw Error('Worker publication failed; rollback cannot verify active state; maintainer inspection required', {cause:failure}); }
    if (current.versionId === before.versionId) throw Error('Worker publication failed; previous version remains active', {cause:failure});
    if (current.versionId !== uploaded) throw Error('Worker publication failed; active version changed; automatic rollback refused', {cause:failure});
    try {
      if (idsHash(versionIds(await cf('versions/'+uploaded),uploaded,policy)) !== idsHash(ids) || idsHash(versionIds(await cf('versions/'+before.versionId),before.versionId,policy)) !== idsHash(deployedIds)) throw Error('Rollback ID identity changed');
      const compared = activeVersion(await cf('deployments'));
      if (compared.deploymentId !== current.deploymentId || compared.versionId !== uploaded) throw Error('Active deployment changed before rollback; refusing overwrite');
      await wrangler(['versions','deploy',before.versionId+'@100%',...common,'--yes']);
      const restored = activeVersion(await cf('deployments'));
      if (restored.versionId !== before.versionId || idsHash(versionIds(await cf('versions/'+restored.versionId),restored.versionId,policy)) !== idsHash(deployedIds)) throw Error('Previous Worker version could not be confirmed');
      await verify(deployedIds);
      const accepted = activeVersion(await cf('deployments'));
      if (accepted.deploymentId !== restored.deploymentId || accepted.versionId !== before.versionId) throw Error('Active deployment changed during rollback acceptance');
    } catch {
      throw Error('Worker publication failed and rollback failed or was refused; maintainer inspection required', {cause:failure});
    }
    throw Error('Worker publication failed; previous version restored and read acceptance passed', {cause:failure});
  }
}
async function jsonRequest(url, headers, request = fetch) {
  const response = await request(url,{headers,redirect:'error',signal:AbortSignal.timeout(30000)});
  if (!response.ok) throw Error('Read-only provider HTTP '+response.status);
  const text = await response.text(); if (text.length > 2*1024*1024) throw Error('Provider response too large');
  try { return JSON.parse(text); } catch { throw Error('Provider evidence is not valid JSON'); }
}
export async function verifyReadiness(ids, request = fetch) {
  for (const origin of ORIGINS) {
    for (const route of ['/health', ...['likes','views'].flatMap(endpoint => Array.from({length:Math.ceil(ids.length/100)},(_,i) => '/api/'+endpoint+'?ids='+encodeURIComponent(ids.slice(i*100,i*100+100).join(','))))]) {
      const response = await request('https://likes.stefanzhang.com'+route,{headers:{Origin:origin},redirect:'error',signal:AbortSignal.timeout(15000)});
      if (response.status !== 200 || response.headers.get('access-control-allow-origin') !== origin) throw Error('Worker read-only health/CORS acceptance failed');
      let body; try { body = await response.json(); } catch { throw Error('Worker acceptance response is not valid JSON'); }
      if (route === '/health') { if (body?.ok !== true || body.schema !== 'atomic-views-v1') throw Error('Existing schema/SALT is not ready'); }
      else for (const id of new URL('https://likes.stefanzhang.com'+route).searchParams.get('ids').split(',')) if (!Number.isSafeInteger(body?.[id]) || body[id] < 0) throw Error('Worker ID read acceptance failed');
    }
  }
}
export async function main(env = process.env) {
  const mode = process.argv[2]; assertContext(env,mode);
  const policy = assertLikesPolicy(JSON.parse(await fs.readFile(new URL('../likes-policy.json',import.meta.url),'utf8')));
  const sourcePolicy = JSON.parse(await fs.readFile(new URL('../policy.json',import.meta.url),'utf8'));
  if (!env.SOURCE_READ_TOKEN || !env.GH_TOKEN) throw Error('Missing GitHub read/protection credentials');
  if (mode === 'publish' && (!COMMIT.test(env.EXPECTED_COMMIT || '') || !HEX.test(env.EXPECTED_HASH || '') || !HEX.test(env.EXPECTED_IDS_HASH || '') || !/^[1-9][0-9]*$/.test(env.BUILD_RUN_ID || ''))) throw Error('Missing exact human-reviewed source receipt');
  const api = endpoint => jsonRequest('https://api.github.com/repos/'+sourcePolicy.sourceRepo+'/'+endpoint,{Authorization:'Bearer '+env.SOURCE_READ_TOKEN,Accept:'application/vnd.github+json'});
  const root = path.resolve('.work');
  const {record,run,worker,ids} = await stageLikesPackage({env,sourcePolicy,api,root,policy});
  const receipt = {schema:1,sourceRun:String(run.id),sourceCommit:run.head_sha,artifactHash:record.artifactHash,idsSHA256:idsHash(ids),idCount:ids.length,controllerCommit:env.GITHUB_SHA,controllerRun:env.GITHUB_RUN_ID};
  if (mode === 'inspect') {
    if (env.GITHUB_OUTPUT) for (const [key,value] of Object.entries(receipt)) await fs.appendFile(env.GITHUB_OUTPUT,key+'='+value+'\n');
    if (env.GITHUB_STEP_SUMMARY) await fs.appendFile(env.GITHUB_STEP_SUMMARY,'Approve independent sfz-likes code/ID update only.\n\nSource run '+receipt.sourceRun+'; commit '+receipt.sourceCommit+'; sealed artifact '+receipt.artifactHash+'; ID count '+ids.length+'; ID SHA256 '+receipt.idsSHA256+'.\n\nNo schema, SALT, DNS, Pages or .com publication changes.\n');
  } else {
    if (env.EXPECTED_IDS_HASH !== receipt.idsSHA256) throw Error('Content IDs changed after approval request');
    if (!/^[a-f0-9]{32}$/.test(env.CLOUDFLARE_ACCOUNT_ID || '') || !env.CLOUDFLARE_LIKES_API_TOKEN) throw Error('Missing dedicated Worker token or account');
    const cf = async endpoint => {
      const body = await jsonRequest('https://api.cloudflare.com/client/v4/accounts/'+env.CLOUDFLARE_ACCOUNT_ID+'/workers/scripts/sfz-likes/'+endpoint,{Authorization:'Bearer '+env.CLOUDFLARE_LIKES_API_TOKEN});
      if (body.success !== true) throw Error('Cloudflare read-only evidence failed'); return body.result;
    };
    const wrangler = async args => execute('npx',['--yes','wrangler@4.45.0',...args],{cwd:worker,env:{PATH:env.PATH,HOME:env.HOME,CI:'true',NO_COLOR:'1',WRANGLER_SEND_METRICS:'false',WRANGLER_LOG_PATH:path.join(root,'likes-wrangler-private.log'),CLOUDFLARE_API_TOKEN:env.CLOUDFLARE_LIKES_API_TOKEN,CLOUDFLARE_ACCOUNT_ID:env.CLOUDFLARE_ACCOUNT_ID}});
    const result = await publishWorker({policy,ids,worker,cf,wrangler,verify:verifyReadiness,beforePromote:async () => {
      if ((await api('branches/main')).commit?.sha !== run.head_sha) throw Error('Source main changed before promotion');
    }});
    await fs.writeFile(path.join(root,'likes-receipt.json'),JSON.stringify({...receipt,...result},null,2)+'\n',{mode:0o600,flag:'wx'});
    console.log(JSON.stringify({...receipt,...result}));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {console.error(error.message);process.exitCode=1;});
