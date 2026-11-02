import test from 'node:test';import assert from 'node:assert/strict';
import {contentChange,codeIdentity,assertContentTree,assertMergeApproval,assertPair,assertAutoContext,assertRemoteCoverage} from '../scripts/content-policy.mjs';
const sha=c=>c.repeat(40),hash=c=>c.repeat(64);
const file=(path,c='a',mode='100644')=>({path,sha:sha(c),mode,type:'blob'});
const tree=files=>({truncated:false,tree:files});
const base=tree([file('package.json'),file('src/content/posts/701.md'),file('assets/uploads/2025/01/a.jpg')]);
const policy={baselineCommit:sha('b'),codeTreeSHA256:codeIdentity(base),merger:'StefanZhang',mergerId:10293941};
const run={id:1,run_attempt:1,head_sha:sha('c')};
const proof=()=>({schema:1,sourceRepo:'StefanZhang/stefans_blog',sourceCommit:run.head_sha,sourceRun:'1',sourceAttempt:1,boundaryCommit:policy.baselineCommit,chain:[{commit:sha('c'),parent:sha('b'),pr:20,mergedAt:'2026-11-02T00:00:00Z',merger:{login:'StefanZhang',id:10293941,type:'User'},files:[{filename:'src/content/posts/701.md',status:'modified'}]}]});
test('content tree permits edited text and new raster sources, never source code',()=>{
 const next=tree([file('package.json'),file('src/content/posts/701.md','d'),file('assets/uploads/2025/01/a.jpg'),file('assets/uploads/2026/11/new.webp')]);
 assert.doesNotThrow(()=>assertContentTree(base,next,policy));
 for(const path of ['src/pages/index.astro','.github/workflows/deploy.yml','package-lock.json','assets/uploads/payload.svg'])assert.throws(()=>assertContentTree(base,tree([...next.tree,file(path)]),policy));
 assert.throws(()=>assertContentTree(base,tree([...base.tree.slice(1)]),policy));
});
test('historical routes/images, symlinks, executable uploads and truncated trees fail closed',()=>{
 for(const next of [tree(base.tree.slice(0,2)),tree([base.tree[0],base.tree[1],file('assets/uploads/2025/01/a.jpg','e')]),tree([...base.tree,file('assets/uploads/x.png','a','120000')]),tree([...base.tree,file('src/content/posts/9999.md','a','100755')]),{...base,truncated:true}])assert.throws(()=>assertContentTree(base,next,policy));
 for(const f of [{filename:'src/content/posts/701.md',status:'removed'},{filename:'assets/uploads/x.png',status:'modified'},{filename:'src/content/posts/701.md',status:'renamed',previous_filename:'src/content/posts/99.md'}])assert.equal(contentChange(f),false);
});
test('only the exact human merge chain and CI run authorize content publishing',()=>{
 assert.doesNotThrow(()=>assertMergeApproval(proof(),run,policy));
 for(const mutate of [p=>p.chain[0].merger.id++,p=>p.chain[0].merger.type='Bot',p=>p.chain[0].parent=sha('e'),p=>p.sourceAttempt++,p=>p.chain[0].files.push({filename:'scripts/publish.mjs',status:'added'}),p=>p.chain=[],p=>p.boundaryCommit=sha('f')]){const p=proof();mutate(p);assert.throws(()=>assertMergeApproval(p,run,policy));}
});
test('coalesced merges must form an unbroken approved first-parent chain',()=>{
 const p=proof();p.chain[0].parent=sha('d');p.chain.push({...p.chain[0],commit:sha('d'),parent:sha('b'),pr:19});assert.doesNotThrow(()=>assertMergeApproval(p,run,policy));
 p.chain[1].merger={login:'other',id:5,type:'User'};assert.throws(()=>assertMergeApproval(p,run,policy));
});
test('paired packages require one source and identical ID sets',()=>{
 const cn={sourceCommit:sha('a'),contentIds:['701','note-01'],config:{publicationOrigin:'https://stefanzhang.cn'}};
 const com={...cn,contentIds:['note-01','701'],config:{publicationOrigin:'https://stefanzhang.com'}};assert.doesNotThrow(()=>assertPair(cn,com));assert.throws(()=>assertPair(cn,{...com,sourceCommit:sha('b')}));assert.throws(()=>assertPair(cn,{...com,contentIds:['701']}));
});
test('automatic entry rejects arbitrary workflows, branches and events',()=>{
 const env={GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:'StefanZhang/blog-publisher',GITHUB_REF:'refs/heads/main',GITHUB_WORKFLOW_REF:'StefanZhang/blog-publisher/.github/workflows/publish-content.yml@refs/heads/main',GITHUB_EVENT_NAME:'schedule',GITHUB_SHA:sha('a'),GITHUB_RUN_ID:'5',GITHUB_JOB:'publish'};assert.doesNotThrow(()=>assertAutoContext(env));for(const [k,v] of [['GITHUB_REF','refs/heads/evil'],['GITHUB_EVENT_NAME','pull_request'],['GITHUB_JOB','other'],['GITHUB_WORKFLOW_REF','elsewhere']])assert.throws(()=>assertAutoContext({...env,[k]:v}));
});
test('remote acceptance must cover exact bytes and historical route count',()=>{
 const record={artifactHash:hash('a'),files:{'index.html':{},'_worker.js':{},'_routes.json':{}}};const base='https://stefanzhang.cn';const p={passed:true,kind:'remote',base,releaseHash:record.artifactHash,failures:[],filesChecked:1,legacyUrlsChecked:728,verifiedAt:new Date().toISOString()};assert.doesNotThrow(()=>assertRemoteCoverage(p,record,base,728));for(const update of [{filesChecked:0},{legacyUrlsChecked:1},{failures:['x']},{releaseHash:hash('b')},{verifiedAt:'2000-01-01'}])assert.throws(()=>assertRemoteCoverage({...p,...update},record,base,728));
});
