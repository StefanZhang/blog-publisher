import {test} from 'node:test';
import assert from 'node:assert/strict';
import {latestArchivedRun} from '../scripts/candidate-run.mjs';
const sha = 'a'.repeat(40);
const base = {sourceRepo:'StefanZhang/stefans_blog',branch:'main'};
const run = (id,policy,event='push') => ({id,head_sha:sha,head_branch:'main',status:'completed',conclusion:'success',event,path:policy.sourceWorkflow,head_repository:{full_name:base.sourceRepo}});
const jobs = conclusion => ({total_count:2,jobs:[{name:'build',status:'completed',conclusion:'success'},{name:'archive',status:'completed',conclusion}]});

for (const workflow of ['deploy.yml','build-production.yml']) {
  test(workflow + ': skips newer test-only success and selects archived same-commit candidate',async()=>{
    const policy={...base,sourceWorkflow:'.github/workflows/'+workflow};
    const api=async path=>path.includes('/runs?')?{workflow_runs:[run(3,policy),run(2,policy,'workflow_dispatch'),run(1,policy)]}:jobs(path.includes('/3/')?'skipped':'success');
    assert.equal((await latestArchivedRun(api,policy,sha)).id,2);
  });
  test(workflow + ': test-only, failed or incomplete archive is never a candidate',async()=>{
    const policy={...base,sourceWorkflow:'.github/workflows/'+workflow};
    for(const conclusion of ['skipped','failure','cancelled']) {
      const api=async path=>path.includes('/runs?')?{workflow_runs:[run(1,policy)]}:jobs(conclusion);
      assert.equal(await latestArchivedRun(api,policy,sha),null);
    }
    const api=async path=>path.includes('/runs?')?{workflow_runs:[run(1,policy)]}:{total_count:2,jobs:[]};
    await assert.rejects(()=>latestArchivedRun(api,policy,sha),/Incomplete/);
  });
}
test('listing errors and foreign/current-main identity failures remain visible',async()=>{
  const policy={...base,sourceWorkflow:'.github/workflows/deploy.yml'};
  await assert.rejects(()=>latestArchivedRun(async()=>{throw Error('GitHub API 403');},policy,sha),/403/);
  await assert.rejects(()=>latestArchivedRun(async()=>({workflow_runs:[{...run(1,policy),path:'.github/workflows/evil.yml'}]}),policy,sha),/successful/);
  assert.equal(await latestArchivedRun(async()=>({workflow_runs:[{...run(1,policy),head_sha:'b'.repeat(40)}]}),policy,sha),null);
});
