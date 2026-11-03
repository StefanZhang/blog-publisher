// A finite transfer budget, separate from the complete target/workflow budget.
// The floor covers connection latency; sealed bytes add time at 16 KiB/s.
export function resourceTimeoutMs(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Invalid sealed resource size');
  return Math.min(180_000, 20_000 + Math.ceil(bytes / 16_384) * 1000);
}

export async function forEachConcurrent(items, limit, visit) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid concurrency limit');
  let next = 0;
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, async () => {
    while (next < items.length) {
      const index = next++;
      await visit(items[index], index);
    }
  }));
}
