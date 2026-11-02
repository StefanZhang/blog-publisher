// Manual, read-only integration test for credentials and both private archives.
import fs from 'node:fs/promises';import path from 'node:path';import {pathToFileURL} from 'node:url';
import {sourceStage} from './source-stage.mjs';
import {readProtection,verifyControllerChecks} from './protection.mjs';
import {AUTO_WORKFLOW,assertAutoEnvironment,assertContentTree,assertPair,assertMergeApproval} from './content-policy.mjs';
import {assertLikesPolicy,activeVersion,versionIds,verifyReadiness} from './likes-deploy.mjs';
export async function cloudflareRead(url,token,request=fetch){
 const r=await request(url,{method:'GET',headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(30000)});
 if(!r.ok)throw Error('Read-only Cloudflare check failed: HTTP '+r.status);const b=await r.json();if(b.success!==true)throw Error('Read-only Cloudflare response failed');return b.result;
}
export function assertReadinessApproval(proof,run,config){
 if(run.head_sha!==config.baselineCommit)return assertMergeApproval(proof,run,config);
 if(proof?.schema!==1||proof.sourceRepo!=='StefanZhang/stefans_blog'||proof.sourceCommit!==run.head_sha||proof.sourceRun!==String(run.id)||proof.sourceAttempt!==run.run_attempt||proof.boundaryCommit!==config.baselineCommit||!Array.isArray(proof.chain)||proof.chain.length!==0)throw Error('Missing exact baseline merge evidence');
}
export async function main(env=process.env){
 if(env.GITHUB_ACTIONS!=='true'||env.GITHUB_REPOSITORY!=='StefanZhang/blog-publisher'||env.GITHUB_REF!=='refs/heads/main'||env.GITHUB_WORKFLOW_REF!==AUTO_WORKFLOW||env.GITHUB_EVENT_NAME!=='workflow_dispatch'||env.GITHUB_JOB!=='readiness')throw Error('Exact manual readiness context required');
 const read=name=>fs.readFile(name,'utf8').then(JSON.parse),config=await read('content-policy.json'),packages={};
 const policies={cn:await read('policy.json'),com:await read('policy.production.json')};
 const stages=Object.fromEntries(Object.entries(policies).map(([k,policy])=>[k,sourceStage({policy,root:path.resolve('.work/readiness-'+k),readToken:env.SOURCE_READ_TOKEN,ownToken:env.GH_TOKEN})]));
 const api=stages.cn.api;
 assertAutoEnvironment(await readProtection(env.GH_TOKEN,env.GITHUB_REPOSITORY),await api('environments/content-auto',true),env.GITHUB_SHA);await verifyControllerChecks(env.GH_TOKEN,env.GITHUB_REPOSITORY,env.GITHUB_SHA);
 const sourceCommit=(await api('branches/main')).commit.sha;
 const tree=sha=>api('git/trees/'+sha+'?recursive=1');assertContentTree(await tree(config.baselineCommit),await tree(sourceCommit),config);
 for(const target of ['cn','com']){const run=await stages[target].currentRun();if(!run||run.head_sha!==sourceCommit)throw Error('Both main builds and archives must succeed');packages[target]=await stages[target].download(run);assertReadinessApproval(await read(path.join(packages[target].release,'reports/merge-approval.json')),run,config);}
 assertPair(packages.cn.record,packages.com.record);
 if(!/^[a-f0-9]{32}$/.test(env.CLOUDFLARE_ACCOUNT_ID||'')||!env.CLOUDFLARE_API_TOKEN||!env.CLOUDFLARE_LIKES_API_TOKEN)throw Error('Missing auto credentials');
 const base='https://api.cloudflare.com/client/v4/accounts/'+env.CLOUDFLARE_ACCOUNT_ID;
 const project=await cloudflareRead(base+'/pages/projects/stefanzhang-com',env.CLOUDFLARE_API_TOKEN);if(project.name!=='stefanzhang-com'||project.production_branch!=='main')throw Error('Wrong Pages project/branch');
 const worker=base+'/workers/scripts/sfz-likes/';
 const version=activeVersion(await cloudflareRead(worker+'deployments',env.CLOUDFLARE_LIKES_API_TOKEN));
 const ids=versionIds(await cloudflareRead(worker+'versions/'+version.versionId,env.CLOUDFLARE_LIKES_API_TOKEN),version.versionId,assertLikesPolicy(await read('likes-policy.json')));await verifyReadiness(ids);
 if((await api('branches/main')).commit.sha!==sourceCommit)throw Error('Source changed during readiness');
 const proof={schema:1,scope:'read-only-content-readiness',passed:true,sourceCommit,controllerCommit:env.GITHUB_SHA,cnHash:packages.cn.record.artifactHash,comHash:packages.com.record.artifactHash,existingWorkerIds:ids.length,pagesProject:project.name,mutations:0};
 await fs.mkdir('.work',{recursive:true});await fs.writeFile('.work/content-readiness.json',JSON.stringify(proof,null,2)+'\n');
 if(env.GITHUB_STEP_SUMMARY)await fs.appendFile(env.GITHUB_STEP_SUMMARY,'Read-only integration passed: both private archives, exact policy, Pages project and Worker version/health. Zero deployment or DNS writes. This is not an end-to-end content publication.\n');
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)main().catch(e=>{console.error(e.message);process.exitCode=1;});
