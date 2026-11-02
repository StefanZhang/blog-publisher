import fs from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {assertBranchProtection} from './policy.mjs';

// REST /branches/main/protection needs Administration:read, which GITHUB_TOKEN
// cannot request. The PR check exercises this exact GraphQL query with the
// workflow's contents:read token, rather than relying on an owner's CLI token.
export const protectionQuery = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    ref(qualifiedName: "refs/heads/main") {
      target { oid }
      branchProtectionRule {
        pattern isAdminEnforced allowsForcePushes allowsDeletions
        requiresStatusChecks requiresStrictStatusChecks
        requiredStatusChecks { context app { databaseId } }
        requiresApprovingReviews requiredApprovingReviewCount
        bypassPullRequestAllowances(first: 100) { totalCount }
        bypassForcePushAllowances(first: 100) { totalCount }
      }
    }
  }
}`;

export async function readProtection(token, repository, request = fetch) {
  if (!token) throw Error('Missing controller GitHub token for protection check');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository || '')) throw Error('Invalid controller repository');
  const [owner, name] = repository.split('/');
  const response = await request('https://api.github.com/graphql', {
    method: 'POST',
    headers: {Authorization: 'Bearer ' + token, 'Content-Type': 'application/json'},
    body: JSON.stringify({query: protectionQuery, variables: {owner, name}}),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw Error('Protection query HTTP ' + response.status);
  const payload = await response.json();
  if (payload.errors?.length) throw Error('Protection query incomplete; cannot prove branch policy');
  const ref = payload.data?.repository?.ref;
  if (!/^[a-f0-9]{40}$/.test(ref?.target?.oid || '') || !ref?.branchProtectionRule) {
    throw Error('Missing effective main protection rule');
  }
  return {protected: true, commit: {sha: ref.target.oid}, protectionRule: ref.branchProtectionRule};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const policy = JSON.parse(await fs.readFile(new URL('../policy.json', import.meta.url), 'utf8'));
  assertBranchProtection(await readProtection(process.env.GH_TOKEN, policy.controllerRepo));
  console.log('Live main protection verified using workflow token: CI, strict updates, admins, PR and no bypass/force/delete');
}
