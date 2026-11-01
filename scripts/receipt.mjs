import fs from 'node:fs/promises';import{checkSeal}from'./release/files.mjs';
export function publicReceipt(record,verified,environment){
 const origin='https://release-preview.stefanzhang-com.pages.dev';
 const deployment=new URL(environment.DEPLOYMENT_URL);
 if(deployment.protocol!=='https:'||!/^[a-f0-9]{8,32}\.stefanzhang-com\.pages\.dev$/.test(deployment.hostname)||deployment.pathname!=='/'||deployment.search||deployment.hash)throw Error('Unexpected immutable deployment URL');
 if(!verified.passed||verified.kind!=='remote'||verified.scope!=='static'||verified.base!==origin||verified.releaseHash!==record.artifactHash||record.artifactHash!==environment.EXPECTED_HASH||verified.failures?.length)throw Error('No successful matching remote evidence');
 if(!/^\d+$/.test(environment.SOURCE_RUN||'')||!/^\d+$/.test(environment.GITHUB_RUN_ID||'')||!/^[a-f0-9]{40}$/.test(record.sourceCommit||''))throw Error('Invalid evidence identity');
 return {schema:1,sourceRepo:'StefanZhang/stefans_blog',sourceRun:environment.SOURCE_RUN,sourceCommit:record.sourceCommit,artifactHash:record.artifactHash,controllerRepo:'StefanZhang/blog-publisher',controllerCommit:environment.GITHUB_SHA,controllerRun:environment.GITHUB_RUN_ID,deploymentURL:deployment.href,deploymentID:environment.DEPLOYMENT_ID||null,previewOrigin:origin,verifiedAt:verified.verifiedAt,scope:'static',filesChecked:verified.filesChecked,legacyUrlsChecked:verified.legacyUrlsChecked,passed:true};
}
if(process.argv[1]&&import.meta.url.endsWith('/'+process.argv[1].split('/').at(-1))){
 const record=await checkSeal('.work/release');const verified=JSON.parse(await fs.readFile('.work/release/verified-static.json','utf8'));const receipt=publicReceipt(record,verified,process.env);await fs.writeFile('.work/preview-receipt.json',JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt));
 if(process.env.GITHUB_STEP_SUMMARY)await fs.appendFile(process.env.GITHUB_STEP_SUMMARY,'\n## Verified deployment\n\n'+receipt.deploymentURL+'\n\nArtifact `'+receipt.artifactHash+'`; '+receipt.filesChecked+' files, '+receipt.legacyUrlsChecked+' historical routes; 0 failures. The metadata-only receipt is retained for 90 days; it is not a backup of the private release package.\n');
}
