import {createHash} from 'node:crypto';
import {assertBranchProtection} from './policy.mjs';
export const AUTO_WORKFLOW='StefanZhang/blog-publisher/.github/workflows/publish-content.yml@refs/heads/main';
export const SOURCE='StefanZhang/stefans_blog';
const SHA=/^[a-f0-9]{40}$/;
export const contentPath=p=>typeof p==='string'&&(/^src\/content\/posts\/[1-9]\d*\.md$/.test(p)||/^src\/content\/notes\/note-\d+\.md$/.test(p)||/^assets\/uploads\/(?:[A-Za-z0-9_\-]+\/)*[^/\\\x00-\x1f]+\.(?:png|jpe?g|webp|avif|gif)$/i.test(p));
export const contentChange=f=>contentPath(f.filename)&&!f.previous_filename&&(f.status==='added'||(f.status==='modified'&&f.filename.startsWith('src/content/')));
export function treeEntries(tree) {
  if(!tree||tree.truncated!==false||!Array.isArray(tree.tree)||!tree.tree.length)throw Error('Incomplete source tree');
  const files=tree.tree.filter(f=>f.type!=='tree');
  if(new Set(files.map(f=>f.path)).size!==files.length)throw Error('Duplicate source tree path');
  for(const f of files)if(!SHA.test(f.sha||'')||typeof f.path!=='string'||f.path.startsWith('/')||f.path.split('/').some(v=>!v||v==='.'||v==='..')||f.path.includes('\\')||/[\x00-\x1f]/.test(f.path)||f.type!=='blob'||!['100644','100755'].includes(f.mode)||(contentPath(f.path)&&f.mode!=='100644'))throw Error('Unsafe source tree entry');
  return files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
}
export function codeIdentity(tree) {
  return createHash('sha256').update(JSON.stringify(treeEntries(tree).filter(f=>!contentPath(f.path)).map(({path,mode,sha})=>[path,mode,sha]))).digest('hex');
}
export function assertContentTree(baseline,current,policy) {
  if(codeIdentity(baseline)!==policy.codeTreeSHA256||codeIdentity(current)!==policy.codeTreeSHA256)throw Error('Code/configuration changed; maintenance review required');
  const next=new Map(treeEntries(current).map(f=>[f.path,f]));
  for(const f of treeEntries(baseline).filter(f=>contentPath(f.path))) {
    if(!next.has(f.path))throw Error('Historical content/image deleted');
    if(f.path.startsWith('assets/')&&next.get(f.path).sha!==f.sha)throw Error('Historical source image replaced');
  }
}
export function assertMergeApproval(proof,run,policy) {
  if(proof?.schema!==1||proof.sourceRepo!==SOURCE||proof.sourceCommit!==run.head_sha||proof.sourceRun!==String(run.id)||proof.sourceAttempt!==run.run_attempt||proof.boundaryCommit!==policy.baselineCommit||!Array.isArray(proof.chain)||!proof.chain.length||proof.chain.length>50)throw Error('Missing matching human-merge evidence');
  let current=run.head_sha;const seen=new Set();
  for(const link of proof.chain) {
    if(link.commit!==current||!SHA.test(link.parent||'')||seen.has(link.commit)||!Number.isSafeInteger(link.pr)||link.pr<1||!Number.isFinite(Date.parse(link.mergedAt))||link.merger?.login!==policy.merger||link.merger.id!==policy.mergerId||link.merger.type!=='User'||!Array.isArray(link.files)||!link.files.length||link.files.length>500||new Set(link.files.map(f=>f.filename)).size!==link.files.length||!link.files.every(contentChange))throw Error('Every intervening content change must be merged by the designated human');
    seen.add(link.commit);current=link.parent;
  }
  if(current!==policy.baselineCommit)throw Error('Unreviewed history between baseline and content PR');
}
export function assertAutoEnvironment(branch,environment,commit) {
  assertBranchProtection(branch);
  if(branch.commit?.sha!==commit||environment?.name!=='content-auto'||environment.can_admins_bypass!==false||environment.deployment_branch_policy?.protected_branches!==true||environment.deployment_branch_policy?.custom_branch_policies!==false||environment.protection_rules?.some(r=>r.type!=='branch_policy'))throw Error('Automatic content credentials require the protected main-only content-auto environment');
}
export function assertAutoContext(env) {
  if(env.GITHUB_ACTIONS!=='true'||env.GITHUB_REPOSITORY!=='StefanZhang/blog-publisher'||env.GITHUB_REF!=='refs/heads/main'||env.GITHUB_WORKFLOW_REF!==AUTO_WORKFLOW||!['schedule','workflow_dispatch'].includes(env.GITHUB_EVENT_NAME)||!SHA.test(env.GITHUB_SHA||'')||!/^\d+$/.test(env.GITHUB_RUN_ID||'')||!['inspect','publish'].includes(env.GITHUB_JOB))throw Error('Automatic publication requires its exact protected workflow');
}
export function assertPair(cn,com) {
  if(cn.sourceCommit!==com.sourceCommit||JSON.stringify([...cn.contentIds].sort())!==JSON.stringify([...com.contentIds].sort())||cn.config.publicationOrigin!=='https://stefanzhang.cn'||com.config.publicationOrigin!=='https://stefanzhang.com')throw Error('CN and COM packages must represent the same source commit and content IDs');
}
export function assertRemoteCoverage(proof,record,base,legacyCount) {
  const expected=Object.keys(record.files).filter(n=>!['_worker.js','_routes.json'].includes(n)).length;
  if(!proof?.passed||proof.kind!=='remote'||proof.base!==base||proof.releaseHash!==record.artifactHash||proof.failures?.length!==0||proof.filesChecked!==expected||proof.legacyUrlsChecked!==legacyCount||legacyCount<1||!Number.isFinite(Date.parse(proof.verifiedAt))||Date.parse(proof.verifiedAt)>Date.now()||Date.now()-Date.parse(proof.verifiedAt)>15*60000)throw Error('Incomplete or stale remote acceptance');
}
