import {createHash} from 'node:crypto';
import path from 'node:path';
export function assertRun(run,main,policy){
 if(run.status!=='completed'||run.conclusion!=='success'||run.head_branch!==policy.branch||!['push','workflow_dispatch'].includes(run.event)||run.path?.split('@')[0]!==policy.sourceWorkflow||run.head_repository?.full_name!==policy.sourceRepo||run.head_sha!==main)throw Error('Only a successful current-main build is accepted');
}
export function assertRecord(record,policy,commit,hash){
 if(record.sourceCommit!==commit||record.artifactHash!==hash||record.migrationGaps?.length!==0||JSON.stringify(record.config)!==JSON.stringify(policy.config))throw Error('Source/hash/config/migration policy mismatch');
 for(const [name,sha256]of Object.entries(policy.controlHashes))if(record.files[name]?.sha256!==sha256)throw Error('Control file changed; review controller policy before deploying: '+name);
 for(const name of Object.keys(record.files))if(name.split('/').some(s=>s.startsWith('.'))||/(^|\/)(functions|wrangler\.jsonc?|wrangler\.toml|package\.json|node_modules)(\/|$)/.test(name))throw Error('Unexpected executable/config path in site');
}
export function assertBranchProtection(branch){
 const rule=branch?.protectionRule,checks=branch?.protection?.required_status_checks;
 if(branch?.protected!==true||branch.protection?.enabled!==true||rule?.pattern!=='main'||rule.allowsForcePushes!==false||rule.allowsDeletions!==false||!Number.isInteger(rule.requiredApprovingReviewCount)||rule.requiredApprovingReviewCount<0||!rule.requiredStatusCheckContexts?.includes('check')||checks?.enforcement_level!=='everyone'||!checks.checks?.some(check=>check.context==='check'&&check.app_id===15368))throw Error('Controller main must enforce the trusted check for everyone and deny force/delete');
}
export function assertControllerChecks(payload,commit){
 if(!payload?.check_runs?.some(run=>run.name==='check'&&run.app?.id===15368&&run.head_sha===commit&&run.status==='completed'&&run.conclusion==='success'))throw Error('Executing controller main commit must have a successful trusted check');
}
export function assertProtection(branch,environment,policy,controllerCommit){
 assertBranchProtection(branch);
 const reviewerRules=environment?.protection_rules?.filter(r=>r.type==='required_reviewers')||[];
 const reviewers=reviewerRules.length===1?reviewerRules[0].reviewers:[];
 if(environment?.can_admins_bypass!==false||(controllerCommit&&branch.commit?.sha!==controllerCommit)||environment.deployment_branch_policy?.protected_branches!==true||environment.deployment_branch_policy?.custom_branch_policies!==false||reviewers?.length!==1||reviewers[0].type!=='User'||reviewers[0].reviewer?.type!=='User'||reviewers[0].reviewer?.login!==policy.reviewer)throw Error('Controller branch and exact human approval must be enforced before publishing');
}
export function destination(root,name){const resolved=path.resolve(root,name);if(!resolved.startsWith(path.resolve(root)+path.sep))throw Error('Unsafe destination');return resolved;}

export function assertSourceFile(name,bytes,policy){if(createHash('sha256').update(bytes).digest('hex')!==policy.sourceFileHashes[name])throw Error('Source build toolchain changed; review cache compatibility and policy: '+name);}
