import fs from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {assertBranchProtection, assertControllerChecks} from './policy.mjs';

// Full branchProtectionRule / REST /protection require Administration:read,
// which GITHUB_TOKEN cannot request. CI exercises the documented non-admin
// view with its real contents:read token; do not invent unavailable fields.
export const protectionQuery = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    ref(qualifiedName: "refs/heads/main") {
      target { oid }
      refUpdateRule {
        pattern allowsForcePushes allowsDeletions
        requiredApprovingReviewCount requiredStatusCheckContexts
      }
    }
  }
}`;

function headers(token) {
  if (!token) throw Error('Missing controller GitHub token for protection check');
  return {Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json'};
}
function validateRepository(repository) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository || '')) throw Error('Invalid controller repository');
}
export async function readProtection(token, repository, request = fetch) {
  validateRepository(repository);
  const [owner, name] = repository.split('/');
  const response = await request('https://api.github.com/graphql', {
    method: 'POST', headers: {...headers(token), 'Content-Type': 'application/json'},
    body: JSON.stringify({query: protectionQuery, variables: {owner, name}}),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw Error('Protection query HTTP ' + response.status);
  const payload = await response.json();
  if (payload.errors?.length) throw Error('Protection query incomplete; cannot prove viewer-visible branch policy');
  const ref = payload.data?.repository?.ref;
  if (!/^[a-f0-9]{40}$/.test(ref?.target?.oid || '') || !ref?.refUpdateRule) throw Error('Missing effective main viewer protection rule');
  const branchResponse = await request('https://api.github.com/repos/' + repository + '/branches/main', {headers: headers(token), signal: AbortSignal.timeout(30000)});
  if (!branchResponse.ok) throw Error('Branch status policy HTTP ' + branchResponse.status);
  const branch = await branchResponse.json();
  if (branch.commit?.sha !== ref.target.oid) throw Error('Controller main changed while reading protection; retry with a fresh run');
  return {protected: branch.protected, commit: {sha: ref.target.oid}, protection: branch.protection, protectionRule: ref.refUpdateRule};
}

// Run this at publication time, not in the check job currently being tested.
// It enforces a successful trusted check on the exact executing main commit,
// regardless of whether the admin-only strict-updates flag can be observed.
export async function verifyControllerChecks(token, repository, commit, request = fetch) {
  validateRepository(repository);
  if (!/^[a-f0-9]{40}$/.test(commit || '')) throw Error('Invalid controller commit');
  const response = await request('https://api.github.com/repos/' + repository + '/commits/' + commit + '/check-runs?check_name=check&filter=latest&per_page=100', {headers: headers(token), signal: AbortSignal.timeout(30000)});
  if (!response.ok) throw Error('Controller CI check HTTP ' + response.status);
  assertControllerChecks(await response.json(), commit);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const policy = JSON.parse(await fs.readFile(new URL('../policy.json', import.meta.url), 'utf8'));
  assertBranchProtection(await readProtection(process.env.GH_TOKEN, policy.controllerRepo));
  console.log('Live viewer-visible main guard verified: trusted check enforced for everyone; no force/delete. Admin-only strict/bypass settings still require owner audit.');
}
