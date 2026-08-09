import assert from 'node:assert/strict';
import test from 'node:test';

import { createCoreWorkRunRuntime } from '../../src/core/coreWorkRunRuntime.mjs';

test('executor polling never overlaps and stops cleanly', async () => {
  let active = 0;
  let peak = 0;
  let calls = 0;
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const runtime = createCoreWorkRunRuntime({
    intervalMs: 250,
    worker: { async runOnce() { calls += 1; active += 1; peak = Math.max(peak, active); await blocked; active -= 1; } },
  });
  runtime.start();
  runtime.start();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(calls, 1);
  release();
  await runtime.stop();
  assert.equal(peak, 1);
});
