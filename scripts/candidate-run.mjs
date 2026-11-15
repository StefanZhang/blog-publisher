import {assertRun} from './policy.mjs';

// Ordinary push/PR checks can succeed without uploading a release candidate.
// Use successful archive jobs to identify candidates; downloadArchive still
// verifies the private Release, tag, exact attempt, hashes and sealed contents.
export async function latestArchivedRun(api, policy, main) {
  const file = encodeURIComponent(policy.sourceWorkflow.split('/').at(-1));
  const response = await api('actions/workflows/' + file + '/runs?branch=main&status=success&per_page=30');
  if (!Array.isArray(response.workflow_runs)) throw Error('Invalid workflow run listing');
  for (const run of response.workflow_runs) {
    if (run.head_sha !== main || !['push', 'workflow_dispatch'].includes(run.event)) continue;
    assertRun(run, main, policy);
    if (!Number.isSafeInteger(run.id) || run.id < 1) throw Error('Invalid candidate run ID');
    const result = await api('actions/runs/' + run.id + '/jobs?filter=latest&per_page=100');
    if (!Array.isArray(result.jobs) || result.total_count !== result.jobs.length || result.jobs.length >= 100) throw Error('Incomplete candidate job listing');
    const archives = result.jobs.filter(job => job.name === 'archive');
    if (archives.length > 1) throw Error('Ambiguous candidate archive job');
    if (archives.length === 1 && archives[0].status === 'completed' && archives[0].conclusion === 'success') return run;
  }
  return null;
}
