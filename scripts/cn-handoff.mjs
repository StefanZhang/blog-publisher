import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {checkSeal, digest} from './release/files.mjs';
import {assertRecord, assertProtection} from './policy.mjs';
import {readProtection, verifyControllerChecks} from './protection.mjs';
import {publicReceipt, deploymentOrigin} from './receipt.mjs';
import {validateManifest, MANIFEST_PATH, CONTROL_FILES, LIMITS} from './lib/delivery-manifest.mjs';
import {assertServicesReceipt, readCommentPageKeys} from './services.mjs';

const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[1-9]\d*$/;
const CONTROLLER = 'StefanZhang/blog-publisher';
const PUBLICATION = 'https://stefanzhang.cn';
const CANONICAL = 'https://stefanzhang.com';
const WORKFLOW = '.github/workflows/publish-preview.yml';
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...keys].sort().join(',');

export function assertHandoffContext(env) {
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REPOSITORY !== CONTROLLER ||
      env.GITHUB_REF !== 'refs/heads/main' || env.GITHUB_WORKFLOW_REF !== CONTROLLER+'/'+WORKFLOW+'@refs/heads/main' ||
      !['schedule', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME) || !SHA.test(env.GITHUB_SHA || '') ||
      !ID.test(env.GITHUB_RUN_ID || '') || !ID.test(env.GITHUB_RUN_ATTEMPT || '') ||
      !Number.isSafeInteger(Number(env.GITHUB_RUN_ATTEMPT)) || !ID.test(env.SOURCE_RUN || '') ||
      !SHA.test(env.EXPECTED_COMMIT || '') || !HASH.test(env.EXPECTED_HASH || '')) {
    throw Error('CN handoff requires the approved controller main workflow identity');
  }
}

export function validateHandoff(payload) {
  if (!exactKeys(payload, ['schema','artifactHash','sourceCommit','sourceRun','controllerRun','controllerAttempt',
    'controllerCommit','deploymentURL','manifest','publicationOrigin','canonicalOrigin']) || payload.schema !== 1 ||
    typeof payload.artifactHash !== 'string' || !HASH.test(payload.artifactHash) ||
    typeof payload.sourceCommit !== 'string' || !SHA.test(payload.sourceCommit) ||
    typeof payload.controllerCommit !== 'string' || !SHA.test(payload.controllerCommit) ||
    typeof payload.sourceRun !== 'string' || !ID.test(payload.sourceRun) ||
    typeof payload.controllerRun !== 'string' || !ID.test(payload.controllerRun) ||
    !Number.isSafeInteger(payload.controllerAttempt) || payload.controllerAttempt < 1 ||
    payload.publicationOrigin !== PUBLICATION || payload.canonicalOrigin !== CANONICAL ||
    !exactKeys(payload.manifest, ['path','bytes','sha256']) || payload.manifest.path !== MANIFEST_PATH ||
    !Number.isSafeInteger(payload.manifest.bytes) || payload.manifest.bytes < 1 ||
    payload.manifest.bytes > LIMITS.manifestBytes || typeof payload.manifest.sha256 !== 'string' || !HASH.test(payload.manifest.sha256)) throw Error('Invalid CN handoff metadata');
  if (payload.deploymentURL !== deploymentOrigin(payload.deploymentURL)) throw Error('CN handoff requires a normalized fixed deployment origin');
  return payload;
}

export function handoffPayload({record, alias, fixed, receipt, servicesReceipt, pageKeys, manifestBytes, legacyCount, policy, env}) {
  assertHandoffContext(env);
  assertRecord(record, policy, env.EXPECTED_COMMIT, env.EXPECTED_HASH);
  if (policy.controllerRepo !== CONTROLLER || record.config.publicationOrigin !== PUBLICATION ||
      record.config.canonicalOrigin !== CANONICAL) throw Error('CN publication policy mismatch');
  assertServicesReceipt(servicesReceipt, {record, policy, env, pageKeys});
  const expectedReceipt = publicReceipt(record, alias, env, fixed);
  if (!isDeepStrictEqual(receipt, expectedReceipt)) throw Error('Stored preview receipt differs from verified fixed/alias evidence');
  const downloadable = Object.entries(record.files).filter(([name]) => !CONTROL_FILES.includes(name));
  if (!Number.isSafeInteger(legacyCount) || legacyCount < 1 ||
      alias.filesChecked !== downloadable.length || fixed.filesChecked !== downloadable.length ||
      alias.legacyUrlsChecked !== legacyCount || fixed.legacyUrlsChecked !== legacyCount) throw Error('Incomplete CN handoff verification coverage');
  const identity = record.files[MANIFEST_PATH.slice(1)];
  if (!identity || !Buffer.isBuffer(manifestBytes) || manifestBytes.length < 1 || manifestBytes.length > LIMITS.manifestBytes ||
      manifestBytes.length !== identity.bytes || digest(manifestBytes) !== identity.sha256) throw Error('Delivery manifest does not match the sealed bytes');
  const manifest = validateManifest(JSON.parse(manifestBytes.toString('utf8')));
  const expectedFiles = Object.fromEntries(downloadable.filter(([name]) => name !== MANIFEST_PATH.slice(1)));
  if (!isDeepStrictEqual(manifest.files, expectedFiles) || manifest.headersSHA256 !== record.files._headers?.sha256) throw Error('Delivery manifest differs from the sealed file inventory or headers');
  return validateHandoff({schema:1, artifactHash:record.artifactHash, sourceCommit:record.sourceCommit,
    sourceRun:env.SOURCE_RUN, controllerRun:env.GITHUB_RUN_ID, controllerAttempt:Number(env.GITHUB_RUN_ATTEMPT),
    controllerCommit:env.GITHUB_SHA, deploymentURL:deploymentOrigin(env.DEPLOYMENT_URL),
    manifest:{path:MANIFEST_PATH, bytes:identity.bytes, sha256:identity.sha256},
    publicationOrigin:PUBLICATION, canonicalOrigin:CANONICAL});
}

export async function loadHandoff(root, policy, env) {
  assertHandoffContext(env);
  const release = path.join(root, 'release');
  const record = await checkSeal(release);
  const read = name => fs.readFile(path.join(root, name), 'utf8').then(JSON.parse);
  const identity = record.files[MANIFEST_PATH.slice(1)];
  if (!identity || identity.bytes < 1 || identity.bytes > LIMITS.manifestBytes) throw Error('Missing or oversized delivery manifest');
  const [alias, fixed, receipt, servicesReceipt, pageKeys, manifestBytes, legacy] = await Promise.all([
    read('verified-alias.json'), read('verified-fixed.json'), read('preview-receipt.json'),
    read('services-receipt.json'), readCommentPageKeys(release, record),
    fs.readFile(path.join(release, 'site', MANIFEST_PATH.slice(1))), read('release/legacy-urls.json')]);
  if (!Array.isArray(legacy)) throw Error('Invalid legacy verification inventory');
  return handoffPayload({record, alias, fixed, receipt, servicesReceipt, pageKeys, manifestBytes, legacyCount:legacy.length, policy, env});
}

export async function publishHandoff(api, payload) {
  validateHandoff(payload);
  const deployment = await api('deployments', {ref:payload.controllerCommit, environment:'cn-pilot',
    auto_merge:false, required_contexts:[], transient_environment:false, production_environment:false,
    description:'Verified static package ready for CN pull after this workflow succeeds', payload});
  // GitHub's manually created Deployment may have app:null. Trust the workflow
  // run identity at the consumer, never an assumed GitHub App on this ledger.
  const echoed = typeof deployment.payload === 'string' ? JSON.parse(deployment.payload) : deployment.payload;
  if (!Number.isSafeInteger(deployment.id) || deployment.id < 1 || deployment.sha !== payload.controllerCommit || deployment.ref !== payload.controllerCommit ||
      deployment.environment !== 'cn-pilot' || !isDeepStrictEqual(echoed, payload)) throw Error('GitHub CN deployment identity mismatch');
  const status = await api('deployments/'+deployment.id+'/statuses', {state:'success', environment_url:PUBLICATION,
    log_url:'https://github.com/'+CONTROLLER+'/actions/runs/'+payload.controllerRun+'/attempts/'+payload.controllerAttempt,
    auto_inactive:false, description:'Handoff ready; consumer must wait for completed/success workflow and verify installed bytes'});
  if (status.state !== 'success') throw Error('GitHub did not confirm CN handoff success status');
  return deployment.id;
}

async function main() {
  const env = process.env;
  assertHandoffContext(env);
  if (!env.GH_TOKEN) throw Error('Missing controller GitHub token');
  const policy = JSON.parse(await fs.readFile(new URL('../policy.json', import.meta.url), 'utf8'));
  const api = async (endpoint, body) => {
    const response = await fetch('https://api.github.com/repos/'+CONTROLLER+'/'+endpoint, {
      method:body ? 'POST' : 'GET', headers:{Authorization:'Bearer '+env.GH_TOKEN, Accept:'application/vnd.github+json',
        'X-GitHub-Api-Version':'2022-11-28', ...(body ? {'Content-Type':'application/json'} : {})},
      ...(body ? {body:JSON.stringify(body)} : {}), signal:AbortSignal.timeout(30000)});
    if (!response.ok) throw Error('GitHub API '+response.status+' at '+endpoint);
    return response.json();
  };
  assertProtection(await readProtection(env.GH_TOKEN, CONTROLLER), await api('environments/preview'), policy, env.GITHUB_SHA);
  await verifyControllerChecks(env.GH_TOKEN, CONTROLLER, env.GITHUB_SHA);
  const payload = await loadHandoff(path.resolve('.work'), policy, env);
  const deploymentID = await publishHandoff(api, payload);
  // Metadata only: no files, content, credentials or private archive locations.
  await fs.writeFile('.work/cn-handoff.json', JSON.stringify(payload, null, 2)+'\n');
  console.log(JSON.stringify({deploymentID, ...payload}));
  if (env.GITHUB_STEP_SUMMARY) await fs.appendFile(env.GITHUB_STEP_SUMMARY,
    '\n## CN handoff issued (not VPS installation evidence)\n\nDeployment '+deploymentID+'; artifact `'+payload.artifactHash+'`.\n\n'+
    'The Hong Kong consumer must wait for this entire workflow to finish successfully, match its attempt/commit/main/workflow identity, '+
    'then download the sealed static files and verify the .cn installation. No .com/DNS/independent service change.\n');
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { await main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
