import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execute} from '../scripts/likes-deploy.mjs';
test('whole-command timeout is distinguishable and raw child output stays private',()=>{
 assert.throws(()=>execute(process.execPath,['-e','setTimeout(()=>{},1000)'],{timeout:25}),/whole command timed out/);
 assert.throws(()=>execute(process.execPath,['-e',"console.log('PRIVATE_PROVIDER_RESPONSE');console.error('SECRET_BINDING');process.exit(3)"]),error=>/exit 3/.test(error.message)&&!error.message.includes('PRIVATE_PROVIDER_RESPONSE')&&!error.message.includes('SECRET_BINDING'));
});
