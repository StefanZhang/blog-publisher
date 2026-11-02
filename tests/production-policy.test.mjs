import {test} from 'node:test';import assert from 'node:assert/strict';
import {assertProductionContext,assertProductionProof} from '../scripts/production-policy.mjs';
const now=Date.now(),hash='a'.repeat(64),commit='b'.repeat(40),controller='c'.repeat(40);
const env={GITHUB_REPOSITORY:'StefanZhang/blog-publisher',GITHUB_REF:'refs/heads/main',GITHUB_WORKFLOW_REF:'StefanZhang/blog-publisher/.github/workflows/publish-production.yml@refs/heads/main',GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'1',GITHUB_SHA:controller,BUILD_RUN_ID:'456'};
const record={config:{publicationOrigin:'https://stefanzhang.com',canonicalOrigin:'https://stefanzhang.com'},migrationGaps:[],sourceCommit:commit,artifactHash:hash,files:{'index.html':{},'_headers':{}}};
const r=base=>({passed:true,kind:'remote',scope:'static',base,releaseHash:hash,failures:[],filesChecked:1,legacyUrlsChecked:728,verifiedAt:new Date(now).toISOString()});
const proof=()=>({schema:1,kind:'production-preview',sourceRun:'456',sourceCommit:commit,artifactHash:hash,controllerRun:'123',controllerAttempt:'1',controllerCommit:controller,deploymentURL:'https://12345678.stefanzhang-com.pages.dev',fixed:r('https://12345678.stefanzhang-com.pages.dev'),alias:r('https://release-preview.stefanzhang-com.pages.dev')});
test('production promotion binds target, exact source/run/attempt, coverage and freshness',()=>{
 assert.doesNotThrow(()=>assertProductionProof(proof(),record,env,now));
 for(const [key,value] of [['sourceRun','1'],['sourceCommit',controller],['controllerRun','1'],['controllerAttempt','2'],['controllerCommit',commit],['artifactHash',controller],['deploymentURL','https://evil.invalid']])assert.throws(()=>assertProductionProof({...proof(),[key]:value},record,env,now));
 for(const override of [{config:{...record.config,publicationOrigin:'https://stefanzhang.cn'}},{migrationGaps:['missing image']}])assert.throws(()=>assertProductionProof(proof(),{...record,...override},env,now));
 for(const override of [{passed:false},{scope:'full'},{filesChecked:0},{legacyUrlsChecked:0},{failures:[{}]},{base:'https://stefanzhang.com'},{verifiedAt:new Date(now-86400001).toISOString()},{verifiedAt:new Date(now+1000).toISOString()}]){const p=proof();p.fixed={...p.fixed,...override};assert.throws(()=>assertProductionProof(p,record,env,now));}
});
test('preview and PR workflows cannot impersonate production context',()=>{
 for(const override of [{GITHUB_REF:'refs/pull/9/merge'},{GITHUB_WORKFLOW_REF:env.GITHUB_WORKFLOW_REF.replace('publish-production','publish-preview')},{GITHUB_REPOSITORY:'evil/repo'}])assert.throws(()=>assertProductionContext({...env,...override}));
});
