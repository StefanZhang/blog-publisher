import fs from 'node:fs/promises';import{checkSeal}from'./release/files.mjs';
export function deploymentOrigin(value){
 const deployment=new URL(value);
 if(deployment.protocol!=='https:'||!/^[a-f0-9]{8,32}\.stefanzhang-com\.pages\.dev$/.test(deployment.hostname)||deployment.port||deployment.username||deployment.password||deployment.pathname!=='/'||deployment.search||deployment.hash)throw Error('Unexpected immutable deployment URL');
 return deployment.origin;
}
export function publicReceipt(record,verified,environment,fixed){
 const origin='https://release-preview.stefanzhang-com.pages.dev';
 const deployment=new URL(deploymentOrigin(environment.DEPLOYMENT_URL));
 for(const [proof,base] of [[verified,origin],[fixed,deployment.origin]]){
  if(!proof?.passed||proof.kind!=='remote'||proof.scope!=='static'||proof.base!==base||proof.releaseHash!==record.artifactHash||record.artifactHash!==environment.EXPECTED_HASH||proof.failures?.length!==0||!Number.isInteger(proof.filesChecked)||proof.filesChecked<1||!Number.isInteger(proof.legacyUrlsChecked)||proof.legacyUrlsChecked<1)throw Error('No successful matching remote evidence');
 }
 if(verified.filesChecked!==fixed.filesChecked||verified.legacyUrlsChecked!==fixed.legacyUrlsChecked)throw Error('Fixed and alias verification coverage differs');
 if(!/^\d+$/.test(environment.SOURCE_RUN||'')||!/^\d+$/.test(environment.GITHUB_RUN_ID||'')||!/^[a-f0-9]{40}$/.test(record.sourceCommit||''))throw Error('Invalid evidence identity');
 return {schema:2,sourceRepo:'StefanZhang/stefans_blog',sourceRun:environment.SOURCE_RUN,sourceCommit:record.sourceCommit,artifactHash:record.artifactHash,controllerRepo:'StefanZhang/blog-publisher',controllerCommit:environment.GITHUB_SHA,controllerRun:environment.GITHUB_RUN_ID,deploymentURL:deployment.href,deploymentID:environment.DEPLOYMENT_ID||null,previewOrigin:origin,verifiedAt:verified.verifiedAt,fixedVerifiedAt:fixed.verifiedAt,scope:'static',filesChecked:verified.filesChecked,legacyUrlsChecked:verified.legacyUrlsChecked,passed:true};
}
if(process.argv[1]&&import.meta.url.endsWith('/'+process.argv[1].split('/').at(-1))){
 const record=await checkSeal('.work/release');const verified=JSON.parse(await fs.readFile('.work/verified-alias.json','utf8'));const fixed=JSON.parse(await fs.readFile('.work/verified-fixed.json','utf8'));const receipt=publicReceipt(record,verified,process.env,fixed);await fs.writeFile('.work/preview-receipt.json',JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt));
 if(process.env.GITHUB_STEP_SUMMARY)await fs.appendFile(process.env.GITHUB_STEP_SUMMARY,'\n## Verified deployment\n\n'+receipt.deploymentURL+'\n\nArtifact `'+receipt.artifactHash+'`; '+receipt.filesChecked+' files, '+receipt.legacyUrlsChecked+' historical routes; 0 failures. The metadata-only receipt is retained for 90 days; it is not a backup of the private release package.\n');
}
