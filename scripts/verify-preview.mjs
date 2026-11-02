import fs from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {deploymentOrigin} from './receipt.mjs';
const fixed = deploymentOrigin(process.env.DEPLOYMENT_URL);
const alias = 'https://release-preview.stefanzhang-com.pages.dev';
for (const [name, origin] of [['fixed', fixed], ['alias', alias]]) {
  const result = spawnSync(process.execPath, ['scripts/release/verify.mjs', '.work/release', '--base', origin], {stdio:'inherit'});
  if (result.status !== 0) throw Error(name + ' deployment verification failed; no success receipt issued');
  const response = await fetch(origin + '/', {redirect:'manual', signal:AbortSignal.timeout(20000)});
  if (response.status !== 200 || !response.headers.get('x-robots-tag')?.split(/[,\s]+/).includes('noindex')) throw Error(name + ' preview must be HTTP 200 and noindex');
  await response.body?.cancel();
  await fs.rename('.work/release/verified-static.json', '.work/verified-' + name + '.json');
}
