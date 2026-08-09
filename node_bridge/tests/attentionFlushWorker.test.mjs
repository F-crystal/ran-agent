import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { createAttentionFlushWorker } from '../src/attentionFlushWorker.mjs';
import { createAttentionValve } from '../src/attentionValve.mjs';
import { createIsolatedTestEnv } from './helpers/isolatedState.mjs';

test('Core-owned attention flush uses the stable fingerprint and retains unconfirmed candidates', async (t) => {
  const env = createIsolatedTestEnv(t, {}, 'attention-flush-owner-');
  let presence = 'gaming';
  const valve = createAttentionValve({
    statePath: path.join(env.RAN_AGENT_STATE_DIR, 'attention', 'delayed.json'),
    presenceProvider: () => presence,
  });
  valve.evaluate({ contentClass: 'timely', fingerprint: 'forum:topic:1', summary: 'one' });
  valve.evaluate({ contentClass: 'timely', fingerprint: 'forum:topic:2', summary: 'two' });
  presence = 'available';
  const attempts = [];
  const worker = createAttentionFlushWorker({
    valve,
    deliver: async (candidate, authority) => {
      attempts.push(authority.idempotencyKey);
      return { state: candidate.fingerprint.endsWith(':1') ? 'scheduled' : 'failed' };
    },
  });
  assert.deepEqual(await worker.run(), { candidates: 2, delivered: 1 });
  assert.deepEqual(attempts, ['forum:topic:1', 'forum:topic:2']);
  assert.equal(valve.flush().length, 1);
});
