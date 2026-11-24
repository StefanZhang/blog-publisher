import {isDeepStrictEqual} from 'node:util';
import {assertMergeApproval,contentChange,treeEntries} from './content-policy.mjs';

const CHAPTER_COMMIT='f5d2e9c746fc53bec4763d365fa16a8f055b255b';
const PREVIOUS_BASELINE='124e8c20e38a6a8607b6ac264ad7e21e998cac60';
// Exact files reviewed for the archive transport and local content-merge change.
// The production website, articles, images and independent services stay pinned.
const migrationFiles=new Set([
  '.github/workflows/build-production.yml','.github/workflows/deploy.yml',
  '.github/actions/check-sealed-site/action.yml','scripts/release/release-zip.py',
  'scripts/release/archive.mjs','scripts/lib/release-archive.mjs','scripts/release/content-approval.mjs',
  'scripts/release/fetch-artifact.mjs','scripts/release/read-private-build.mjs','scripts/release/github.mjs','scripts/release/report.mjs',
  'scripts/release/merge-content.mjs','tests/content-approval.test.mjs','tests/merge-content.test.mjs',
  'tests/release-archive.test.mjs','tests/workflows/workflow-storage.test.mjs',
  'AGENTS.md','docs/CONTENT-PUBLICATION.md','docs/GITHUB-SETUP.md','docs/RELEASE-PLAYBOOK.md',
]);

export function isChapterMigration(config,commit) {
  return /^[a-f0-9]{40}$/.test(commit) && config.chapterMigrationCommit===commit && config.baselineCommit===commit;
}

function changes(before,after) {
  const files=tree=>new Map(treeEntries(tree).map(file=>[file.path,file.mode+':'+file.sha]));
  const old=files(before),current=files(after);
  return [...new Set([...old.keys(),...current.keys()])].sort()
    .filter(name=>old.get(name)!==current.get(name))
    .map(filename=>({filename,status:!old.has(filename)?'added':!current.has(filename)?'removed':'modified'}));
}

export async function originalChapterChanges({api,readTree,currentTree,config,commit}) {
  if(!isChapterMigration(config,commit))throw Error('Unpinned chapter migration');
  const [now,approved,previousTree,approvedTree]=await Promise.all([
    api('git/commits/'+commit),api('git/commits/'+CHAPTER_COMMIT),readTree(PREVIOUS_BASELINE),readTree(CHAPTER_COMMIT),
  ]);
  if(now.sha!==commit||now.parents?.[0]?.sha!==CHAPTER_COMMIT||approved.sha!==CHAPTER_COMMIT||approved.parents?.[0]?.sha!==PREVIOUS_BASELINE)throw Error('Wrong chapter migration ancestry');
  const maintenance=changes(approvedTree,currentTree);
  if(!maintenance.length||maintenance.some(f=>!migrationFiles.has(f.filename)))throw Error('Migration changed a site input outside the reviewed release files');
  const original=changes(previousTree,approvedTree);
  if(original.length!==111||!original.every(f=>f.status==='added'&&contentChange(f)))throw Error('Unexpected original chapter changes');
  return original;
}

export function assertOriginalChapterApproval(receipt,run,config,files) {
  if(!isChapterMigration(config,run.head_sha)||receipt?.candidateCommit!==run.head_sha)throw Error('Chapter receipt does not match the current candidate');
  assertMergeApproval(receipt.approval,{...run,head_sha:CHAPTER_COMMIT},{...config,baselineCommit:PREVIOUS_BASELINE});
  const [merge]=receipt.approval.chain;
  if(receipt.approval.chain.length!==1||merge.pr!==20)throw Error('Expected original PR 20 approval');
  const reported=[...merge.files].sort((a,b)=>a.filename<b.filename?-1:1);
  if(!isDeepStrictEqual(reported,files))throw Error('Chapter PR files differ from the Git trees');
}
