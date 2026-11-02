import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {checkSeal,atomicJson} from './release/files.mjs';
import {assertRecord} from './policy.mjs';
import {assertHandoffContext} from './cn-handoff.mjs';
import {readCommentPageKeys,verifyServices} from './services.mjs';

export async function runServices({root=path.resolve('.work'),policy,env=process.env,fetchImpl=fetch}) {
  assertHandoffContext(env);
  const release=path.join(root,'release'),record=await checkSeal(release);
  assertRecord(record,policy,env.EXPECTED_COMMIT,env.EXPECTED_HASH);
  const pageKeys=await readCommentPageKeys(release,record);
  const receipt=await verifyServices({record,policy,env,pageKeys,fetchImpl});
  await atomicJson(path.join(root,'services-receipt.json'),receipt);
  return receipt;
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url) {
  try {
    const policy=JSON.parse(await fs.readFile(new URL('../policy.json',import.meta.url),'utf8'));
    const receipt=await runServices({policy});
    console.log(JSON.stringify(receipt));
    if(!receipt.passed)process.exitCode=1;
  } catch { console.error('Service readiness check failed before producing a valid receipt');process.exitCode=1; }
}
