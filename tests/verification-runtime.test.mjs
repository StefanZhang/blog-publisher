import test from 'node:test';
import assert from 'node:assert/strict';
import {resourceTimeoutMs, forEachConcurrent} from '../scripts/lib/verification-runtime.mjs';

test('resource deadlines follow sealed size and retain finite bounds', () => {
  assert.equal(resourceTimeoutMs(0), 20_000);
  assert.equal(resourceTimeoutMs(16_384), 21_000);
  assert.equal(resourceTimeoutMs(1_297_394), 100_000);
  assert.equal(resourceTimeoutMs(25 * 1024 * 1024), 180_000);
  for (const invalid of [-1, NaN, Infinity, 1.5, '10']) {
    assert.throws(() => resourceTimeoutMs(invalid), /Invalid sealed/);
  }
});

test('bounded parallel historical checks visit every case exactly once', async () => {
  const items = Array.from({length: 1117}, (_, i) => i);
  const visited = [], seen = new Set();
  let active = 0, peak = 0;
  await forEachConcurrent(items, 6, async value => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(seen.has(value), false);
    seen.add(value); visited.push(value); active--;
  });
  assert.equal(peak, 6);
  assert.equal(active, 0);
  assert.deepEqual(visited.sort((a, b) => a - b), items);
});

test('empty input makes no requests; request errors cannot become success', async () => {
  await forEachConcurrent([], 6, () => assert.fail('Unexpected request'));
  await assert.rejects(forEachConcurrent([1], 6, async () => { throw new Error('Network failure'); }), /Network failure/);
  await assert.rejects(forEachConcurrent([1], 0, () => {}), /Invalid concurrency/);
});
