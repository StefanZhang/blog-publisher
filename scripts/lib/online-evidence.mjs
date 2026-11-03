import {assertControllerRun} from '../verify-cn.mjs';
import {validateHandoff} from '../cn-handoff.mjs';

// Select only targets actually authorized by a completed, verified handoff.
// A maintenance CN handoff never proves a paired COM publication.
export function onlineEvidence(run,trusted,paired){
 const id=String(run?.id??'');assertControllerRun(run,id);
 if(trusted?.skipped)throw Error('No-op publication has no online targets');
 assertControllerRun(trusted?.run,id);
 if(trusted.run.head_sha!==run.head_sha||trusted.run.run_attempt!==run.run_attempt)throw Error('Controller changed before online acceptance');
 const p=validateHandoff(trusted.payload);
 if(p.controllerRun!==id||p.controllerCommit!==run.head_sha||p.controllerAttempt!==run.run_attempt)throw Error('Handoff/controller mismatch');
 const plan={sourceCommit:p.sourceCommit,cnRun:p.sourceRun,cnHash:p.artifactHash};
 if(run.path.split('@')[0]==='.github/workflows/publish-preview.yml'){
  if(paired!==undefined)throw Error('Maintenance handoff cannot claim paired publication');
  return {...plan,scope:'maintenance-cn-online'};
 }
 const e=paired;
 if(e?.schema!==1||!e.passed||e.status!=='pages-verified-cn-handoff-ready'||e.controllerRun!==id||e.controllerCommit!==run.head_sha||e.controllerAttempt!==run.run_attempt||e.sourceCommit!==p.sourceCommit||e.cnRun!==p.sourceRun||e.cnHash!==p.artifactHash||!/^[1-9]\d*$/.test(e.comRun||'')||!/^[a-f0-9]{64}$/.test(e.comHash||'')||!['https://stefanzhang.com','https://stefanzhang-com.pages.dev'].includes(e.comBase))throw Error('Paired publication proof mismatch');
 return {...plan,scope:'dual-online',comRun:e.comRun,comHash:e.comHash,comBase:e.comBase};
}
