import assert from 'node:assert/strict';
import test from 'node:test';

import { createDurableOutbox } from '../src/durableOutbox.mjs';
import { createIsolatedTestEnv } from './helpers/isolatedState.mjs';

test('core release journey commits a typed send before any user-visible projections', async (t) => {
  const outbox = createDurableOutbox({ env: createIsolatedTestEnv(t) });
  const item = await outbox.deliver({
    operationKey: 'release-journey:core:reply',
    jobResultKey: 'release-journey:core:result',
    route: { adapterKey: 'fixture', destinationRef: 'owner' },
    text: '已完成当前步骤。',
    attachments: [],
    idempotent: true,
    maxAttempts: 1,
  }, {
    send: async () => ({
      textStatus: 'sent',
      attachments: [],
      adapterReceiptRef: 'fixture-receipt:core-1',
    }),
  });

  assert.equal(item.delivery, 'sent');
  assert.equal(item.timelineProjection, 'pending');
  assert.equal(item.backendProjection, 'pending');

  const projected = [];
  await outbox.projectPending({
    timeline: async (entry) => projected.push(['timeline', entry]),
    backend: async (entry) => projected.push(['backend', entry]),
  });
  assert.equal(projected.length, 2);
  for (const [, entry] of projected) {
    assert.equal(entry.text, '已完成当前步骤。');
    assert.equal('operationKey' in entry, false);
    assert.equal('adapterReceiptRef' in entry, false);
  }
});
