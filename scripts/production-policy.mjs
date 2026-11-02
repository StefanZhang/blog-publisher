import {deploymentOrigin} from './receipt.mjs';
export function assertProductionContext(env){
 if(env.GITHUB_REPOSITORY!=='StefanZhang/blog-publisher'||env.GITHUB_REF!=='refs/heads/main'||env.GITHUB_WORKFLOW_REF!=='StefanZhang/blog-publisher/.github/workflows/publish-production.yml@refs/heads/main'||!/^\d+$/.test(env.GITHUB_RUN_ID||'')||!/^\d+$/.test(env.GITHUB_RUN_ATTEMPT||'')||!/^[a-f0-9]{40}$/.test(env.GITHUB_SHA||''))throw Error('Production runs only in the reviewed protected-main workflow');
}
export function assertProductionProof(proof,record,env,now=Date.now()){
 assertProductionContext(env);
 if(record.config.publicationOrigin!=='https://stefanzhang.com'||record.config.canonicalOrigin!==record.config.publicationOrigin||record.migrationGaps.length)throw Error('Only a complete canonical production package may be promoted');
 if(proof?.schema!==1||proof.kind!=='production-preview'||proof.sourceRun!==env.BUILD_RUN_ID||proof.sourceCommit!==record.sourceCommit||proof.artifactHash!==record.artifactHash||proof.controllerRun!==env.GITHUB_RUN_ID||proof.controllerAttempt!==env.GITHUB_RUN_ATTEMPT||proof.controllerCommit!==env.GITHUB_SHA)throw Error('Production preview identity mismatch');
 const files=Object.keys(record.files).filter(n=>!['_headers','_redirects','_worker.js','_routes.json'].includes(n)).length;
 for(const [r,base] of [[proof.fixed,deploymentOrigin(proof.deploymentURL)],[proof.alias,'https://release-preview.stefanzhang-com.pages.dev']]){
  const age=now-Date.parse(r?.verifiedAt);
  if(!r?.passed||r.kind!=='remote'||r.scope!=='static'||r.releaseHash!==record.artifactHash||r.base!==base||r.failures?.length!==0||r.filesChecked!==files||!Number.isInteger(r.legacyUrlsChecked)||r.legacyUrlsChecked<1||!Number.isFinite(age)||age<0||age>24*3600000)throw Error('Missing fresh complete production preview evidence');
 }
 if(proof.fixed.legacyUrlsChecked!==proof.alias.legacyUrlsChecked)throw Error('Preview coverage mismatch');
}
