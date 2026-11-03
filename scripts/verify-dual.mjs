// Runs after the publishing run completes, so the HK receiver cannot deadlock on this check.
import fs from 'node:fs/promises';import path from 'node:path';
import {sourceStage} from './source-stage.mjs';
import {trustedHandoff} from './verify-cn.mjs';
import {assertRun} from './policy.mjs';
import {assertPair,assertRemoteCoverage} from './content-policy.mjs';
import {execute} from './likes-deploy.mjs';
import {readCommentPageKeys,verifyServices} from './services.mjs';
import {atomicJson} from './release/files.mjs';
import {onlineEvidence} from './lib/online-evidence.mjs';
const env=process.env,repo='StefanZhang/blog-publisher';
async function main(){
  if(env.GITHUB_REPOSITORY!==repo||env.GITHUB_REF!=='refs/heads/main'||env.GITHUB_WORKFLOW_REF!==repo+'/.github/workflows/verify-cn.yml@refs/heads/main'||!['workflow_run','workflow_dispatch'].includes(env.GITHUB_EVENT_NAME)||!/^\d+$/.test(env.CONTROLLER_RUN||''))throw Error('Untrusted online verifier context');
  const policies={cn:JSON.parse(await fs.readFile('policy.json')),com:JSON.parse(await fs.readFile('policy.production.json'))};
  const stages=Object.fromEntries(Object.entries(policies).map(([target,policy])=>[target,sourceStage({policy,root:path.resolve('.work/online-'+target),readToken:env.SOURCE_READ_TOKEN,ownToken:env.GH_TOKEN})]));
  const own=endpoint=>stages.cn.api(endpoint,true);
  const run=await own('actions/runs/'+env.CONTROLLER_RUN);
  const trusted=await trustedHandoff(own,env.CONTROLLER_RUN);
  if(trusted.skipped)return;
  const result={schema:1,scope:run.path?.split('@')[0]==='.github/workflows/publish-preview.yml'?'maintenance-cn-online':'dual-online',controllerRun:env.CONTROLLER_RUN,sourceCommit:trusted.payload.sourceCommit,passed:false,targets:{},failures:[]};
  try{
    let paired;
    if(run.path?.split('@')[0]==='.github/workflows/publish-content.yml'){
      execute('gh',['run','download',env.CONTROLLER_RUN,'--repo',repo,'--name','dual-publication','--dir','.work/dual-proof']);
      paired=JSON.parse(await fs.readFile('.work/dual-proof/dual-publication.json'));
    }
    const evidence=onlineEvidence(run,trusted,paired);
    const packages={};
    for(const target of evidence.comRun?['cn','com']:['cn']) {
      if(!/^\d+$/.test(evidence[target+'Run']||'')||!/^[a-f0-9]{64}$/.test(evidence[target+'Hash']||''))throw Error('Invalid paired source identity');
      const sourceRun=await stages[target].api('actions/runs/'+evidence[target+'Run']);
      assertRun(sourceRun,evidence.sourceCommit,policies[target]);
      packages[target]=await stages[target].download(sourceRun);
      if(packages[target].record.artifactHash!==evidence[target+'Hash'])throw Error('Online package identity changed');
    }
    if(packages.com)assertPair(packages.cn.record,packages.com.record);
    else if(packages.cn.record.config.publicationOrigin!=='https://stefanzhang.cn')throw Error('Maintenance package is not CN');
    for(const target of evidence.comRun?['com','cn']:['cn']) {
      const base=target==='cn'?'https://stefanzhang.cn':evidence.comBase;
      const full=target==='cn'||base==='https://stefanzhang.com';
      // CN checks every file and legacy route over the real overseas path. The
      // command budget is distinct from the bounded, size-aware request deadlines.
      const timeout=target==='cn'?25*60*1000:10*60*1000;
      const started=Date.now();
      result.targetAttempts??={};
      result.targetAttempts[target]={startedAt:new Date(started).toISOString(),timeoutMs:timeout};
      try {
        execute(process.execPath,['scripts/release/verify.mjs',packages[target].release,'--base',base,...(full?['--full']:[])],{timeout});
      } finally {
        result.targetAttempts[target].durationMs=Date.now()-started;
        // Preserve the verifier's metadata even on nonzero exit; never expose
        // arbitrary child output, package HTML or provider credentials.
        try { result.targets[target]=JSON.parse(await fs.readFile(path.join(packages[target].release,full?'verified-full.json':'verified-static.json'))); }
        catch(error) { if(error.code!=='ENOENT')throw error; }
      }
      const proof=result.targets[target];
      assertRemoteCoverage(proof,packages[target].record,base,JSON.parse(await fs.readFile(path.join(packages[target].release,'legacy-urls.json'))).length+(base===packages[target].record.config.publicationOrigin?JSON.parse(await fs.readFile(path.join(packages[target].release,'query-urls.json'))).length:0));
    }
    const record=packages.cn.record;
    const services=await verifyServices({record,policy:policies.cn,env:{...env,SOURCE_RUN:evidence.cnRun},pageKeys:await readCommentPageKeys(packages.cn.release,record)});
    if(!services.passed)throw Error('Online independent services failed');
    result.services=services;result.passed=true;
    result.formalCOMVerified=evidence.comBase==='https://stefanzhang.com';
  }catch(e){result.failures.push({error:e.message});throw e;}
  finally{
    await atomicJson('.work/dual-online.json',result);
    if(env.GITHUB_STEP_SUMMARY)await fs.appendFile(env.GITHUB_STEP_SUMMARY,'\n## '+(result.scope==='dual-online'?'Paired':'CN maintenance')+' online acceptance: '+(result.passed?'passed':'FAILED')+'\n\nSource '+result.sourceCommit+'. Formal COM verified: '+(result.formalCOMVerified===true)+'. Inspect the per-target receipt; Pages project acceptance is not DNS cutover. No automatic website rollback was performed.\n');
  }
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
