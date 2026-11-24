import test from 'node:test';
import assert from 'node:assert/strict';
import {isChapterMigration,originalChapterChanges,assertOriginalChapterApproval} from '../scripts/chapter-migration.mjs';

const commit='a'.repeat(40), chapter='f5d2e9c746fc53bec4763d365fa16a8f055b255b', previous='124e8c20e38a6a8607b6ac264ad7e21e998cac60';
const config={baselineCommit:commit,chapterMigrationCommit:commit,merger:'StefanZhang',mergerId:10293941};
const run={id:123,run_attempt:2,head_sha:commit};
const file=(path,sha=commit)=>({path,type:'blob',mode:'100644',sha});
const tree=paths=>({truncated:false,tree:paths});
const previousTree=tree([file('src/pages/index.astro')]);
const articles=Array.from({length:7},(_,i)=>file('src/content/posts/'+(3000+i)+'.md'));
const pictures=Array.from({length:104},(_,i)=>file('assets/uploads/testing/'+i+'.png'));
const approvedTree=tree([...previousTree.tree,...articles,...pictures]);
const fixture=()=>({commit,config,currentTree:tree([...approvedTree.tree,file('scripts/release/archive.mjs')]),
  api:async endpoint=>endpoint==='git/commits/'+commit?{sha:commit,parents:[{sha:chapter}]}:{sha:chapter,parents:[{sha:previous}]},
  readTree:async sha=>sha===previous?previousTree:approvedTree});
function receipt(files) {
  return {candidateCommit:commit,approval:{schema:1,sourceRepo:'StefanZhang/stefans_blog',sourceCommit:chapter,sourceRun:String(run.id),
    sourceAttempt:2,boundaryCommit:previous,chain:[{commit:chapter,parent:previous,pr:20,mergedAt:'2026-11-24T04:25:53Z',
      merger:{login:'StefanZhang',id:10293941,type:'User'},files}]}};
}

test('only the pinned migration may publish the approved Git tree and separately bound CI proofs',async()=>{
  assert.equal(isChapterMigration({baselineCommit:commit},commit),false);
  assert.equal(isChapterMigration({...config,baselineCommit:chapter},chapter),false);
  const files=await originalChapterChanges(fixture());
  const proof=receipt([...files].reverse());
  assert.doesNotThrow(()=>assertOriginalChapterApproval(proof,run,config,files));
  for(const mutate of [r=>r.candidateCommit=chapter,r=>r.approval.sourceAttempt++,r=>r.approval.sourceRun='124',
    r=>r.approval.chain[0].pr=21,r=>r.approval.chain[0].merger.id++,r=>r.approval.chain[0].files.pop(),
    r=>r.approval.chain[0].files[0].filename='src/content/posts/999999.md']) {
    const changed=structuredClone(proof);mutate(changed);
    assert.throws(()=>assertOriginalChapterApproval(changed,run,config,files));
  }
});
test('a modified chapter, service, site file, image, previous base or sibling merge cannot ride the archive migration',async()=>{
  for(const changed of ['src/pages/index.astro',articles[0].path,pictures[0].path,'deploy/nginx.conf','scripts/release/verify.mjs']){
    const params=fixture();
    params.currentTree=tree([...params.currentTree.tree.filter(f=>f.path!==changed),file(changed,previous)]);
    await assert.rejects(()=>originalChapterChanges(params),/site input/);
  }
  const params=fixture();params.api=async()=>({sha:commit,parents:[{sha:previous}]});
  await assert.rejects(()=>originalChapterChanges(params),/ancestry/);
  const missing=fixture();
  missing.readTree=async sha=>sha===previous?tree([...previousTree.tree,articles[0]]):approvedTree;
  await assert.rejects(()=>originalChapterChanges(missing),/original chapter changes/);
});
