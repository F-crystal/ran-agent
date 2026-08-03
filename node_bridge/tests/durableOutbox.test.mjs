import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';

import { createIsolatedTestEnv } from './helpers/isolatedState.mjs';

let durableOutbox = {};
try {
  durableOutbox = await import('../src/durableOutbox.mjs');
} catch {}

function request(operationKey = 'operation:reply:1', overrides = {}) {
  return {
    operationKey,
    jobResultKey: `job-result:${operationKey}`,
    route: { adapterKey: 'wechat', destinationRef: 'conversation:owner' },
    text: '已经整理好了。',
    attachments: [{ type: 'image', ref: 'media:image-1' }],
    idempotent: true,
    maxAttempts: 2,
    ...overrides,
  };
}

function sentResult(overrides = {}) {
  return {
    textStatus: 'sent',
    attachments: [{ ref: 'media:image-1', status: 'sent' }],
    adapterReceiptRef: 'adapter-receipt:1',
    ...overrides,
  };
}

function failAt(stage) {
  let failed = false;
  return async (current) => {
    if (!failed && current === stage) {
      failed = true;
      throw Object.assign(new Error(`fault:${stage}`), { code: 'TEST_FAULT' });
    }
  };
}

test('reserves one stable outbox item with text and typed attachments stored separately', (t) => {
  assert.equal(typeof durableOutbox.createDurableOutbox, 'function');
  const env = createIsolatedTestEnv(t);
  const outbox = durableOutbox.createDurableOutbox({
    env,
    now: () => new Date('2026-07-10T10:00:00.000Z'),
  });
  const item = outbox.reserve(request());

  assert.match(item.outboxId, /^outbox_[a-f0-9]{32}$/);
  assert.equal(item.operationKey, 'operation:reply:1');
  assert.equal(item.delivery, 'reserved');
  assert.equal(item.revision, 0);
  assert.equal(item.timelineProjection, 'pending');
  assert.equal(item.backendProjection, 'pending');
  assert.equal(item.text, '已经整理好了。');
  assert.deepEqual(item.attachments, [{ type: 'image', ref: 'media:image-1' }]);
  assert.equal(item.createdAt, '2026-07-10T10:00:00.000Z');

  const duplicate = outbox.reserve(request());
  assert.equal(duplicate.outboxId, item.outboxId);
  assert.equal(duplicate.revision, 0);
  assert.throws(
    () => outbox.reserve(request('operation:reply:1', { text: 'changed' })),
    (error) => error?.code === 'OUTBOX_OPERATION_CONFLICT',
  );

  const persisted = JSON.parse(fs.readFileSync(outbox.target, 'utf8'));
  assert.equal(persisted.schemaVersion, 1);
  assert.equal(persisted.items[0].text, item.text);
  assert.deepEqual(persisted.items[0].attachments, item.attachments);
});

test('rejects raw media markers, runtime paths, remote attachment URLs, and untyped attachments', (t) => {
  const outbox = durableOutbox.createDurableOutbox({ env: createIsolatedTestEnv(t) });
  for (const invalid of [
    request('operation:invalid:marker', { text: 'RAN_MEDIA:{"path":"x"}' }),
    request('operation:invalid:path', { text: '见 /Users/example/private.png' }),
    request('operation:invalid:url', { attachments: [{ type: 'image', ref: 'https://example.com/private.png' }] }),
    request('operation:invalid:type', { attachments: [{ type: 'blob', ref: 'media:image-1' }] }),
  ]) {
    assert.throws(() => outbox.reserve(invalid), (error) => error?.code === 'OUTBOX_CONTENT_INVALID');
  }
});

test('enforces revision CAS through reserved, sending, terminal, and projection commits', async (t) => {
  const outbox = durableOutbox.createDurableOutbox({ env: createIsolatedTestEnv(t) });
  const reserved = outbox.reserve(request());
  const sending = outbox.startSend(reserved.outboxId, { expectedRevision: 0 });
  assert.equal(sending.delivery, 'sending');
  assert.equal(sending.revision, 1);
  assert.equal(sending.attemptCount, 1);
  assert.throws(
    () => outbox.startSend(reserved.outboxId, { expectedRevision: 0 }),
    (error) => error?.code === 'OUTBOX_STALE_REVISION',
  );

  const sent = outbox.completeSend(reserved.outboxId, {
    expectedRevision: 1,
    result: sentResult(),
  });
  assert.equal(sent.delivery, 'sent');
  assert.equal(sent.revision, 2);
  assert.equal(sent.adapterResult.textStatus, 'sent');
  assert.equal(sent.adapterResult.attachments[0].status, 'sent');

  const projected = [];
  await outbox.projectPending({
    timeline: async (entry) => projected.push(['timeline', entry]),
    backend: async (entry) => projected.push(['backend', entry]),
  });
  const current = outbox.get(reserved.outboxId);
  assert.equal(current.timelineProjection, 'committed');
  assert.equal(current.backendProjection, 'committed');
  assert.equal(current.revision, 4);
  assert.equal(projected.length, 2);
  assert.equal(projected[0][1].outboxId, reserved.outboxId);
  assert.equal(projected[0][1].text, request().text);
  assert.deepEqual(projected[0][1].attachments, [{ type: 'image', ref: 'media:image-1' }]);
  assert.equal('operationKey' in projected[0][1], false);
  assert.throws(
    () => outbox.commitProjection(reserved.outboxId, 'timeline', { expectedRevision: 2 }),
    (error) => error?.code === 'OUTBOX_STALE_REVISION',
  );
});

test('requires typed results for every requested component so text-only success cannot prove media sent', (t) => {
  const outbox = durableOutbox.createDurableOutbox({ env: createIsolatedTestEnv(t) });
  const item = outbox.reserve(request());
  const sending = outbox.startSend(item.outboxId, { expectedRevision: item.revision });
  assert.throws(
    () => outbox.completeSend(item.outboxId, {
      expectedRevision: sending.revision,
      result: { textStatus: 'sent', attachments: [], adapterReceiptRef: 'adapter:1' },
    }),
    (error) => error?.code === 'OUTBOX_ADAPTER_RESULT_INVALID',
  );
  assert.equal(outbox.get(item.outboxId).delivery, 'sending');
});

test('marks a mixed component result ambiguous and never projects it as sent', async (t) => {
  const outbox = durableOutbox.createDurableOutbox({ env: createIsolatedTestEnv(t) });
  const item = outbox.reserve(request('operation:mixed-components'));
  const sending = outbox.startSend(item.outboxId, { expectedRevision: item.revision });
  const completed = outbox.completeSend(item.outboxId, {
    expectedRevision: sending.revision,
    result: sentResult({ attachments: [{ ref: 'media:image-1', status: 'failed' }] }),
  });

  assert.equal(completed.delivery, 'ambiguous');
  await outbox.projectPending({
    timeline: async () => assert.fail('mixed delivery must not project timeline'),
    backend: async () => assert.fail('mixed delivery must not project backend'),
  });
  assert.equal(outbox.get(item.outboxId).timelineProjection, 'pending');
  assert.equal(outbox.get(item.outboxId).backendProjection, 'pending');
});

test('binds one durable job result to at most one outbox across restart', (t) => {
  const env = createIsolatedTestEnv(t);
  const first = durableOutbox.createDurableOutbox({ env });
  const item = first.reserve(request('operation:job:one', { jobResultKey: 'job-result:final:1' }));
  const restarted = durableOutbox.createDurableOutbox({ env });
  assert.equal(restarted.reserve(request('operation:job:one', { jobResultKey: 'job-result:final:1' })).outboxId, item.outboxId);
  assert.throws(
    () => restarted.reserve(request('operation:job:two', { jobResultKey: 'job-result:final:1' })),
    (error) => error?.code === 'OUTBOX_JOB_RESULT_CONFLICT',
  );
});

test('retries only known failed idempotent delivery and never retries ambiguous or non-idempotent delivery', async (t) => {
  const env = createIsolatedTestEnv(t);
  const outbox = durableOutbox.createDurableOutbox({ env });
  let calls = 0;
  const failedInput = request('operation:retry:known');
  const failed = await outbox.deliver(failedInput, {
    send: async () => {
      calls += 1;
      return {
        textStatus: 'failed',
        attachments: [{ ref: 'media:image-1', status: 'failed' }],
        knownFailure: true,
        adapterReceiptRef: 'adapter:failed:1',
      };
    },
  });
  assert.equal(failed.delivery, 'failed');
  const retried = await outbox.deliver(failedInput, { retry: true, send: async () => {
    calls += 1;
    return sentResult({ adapterReceiptRef: 'adapter:sent:2' });
  } });
  assert.equal(retried.delivery, 'sent');
  assert.equal(calls, 2);

  const nonIdempotent = outbox.reserve(request('operation:retry:no', { idempotent: false, maxAttempts: 1 }));
  const nonIdempotentSending = outbox.startSend(nonIdempotent.outboxId, { expectedRevision: nonIdempotent.revision });
  outbox.completeSend(nonIdempotent.outboxId, {
    expectedRevision: nonIdempotentSending.revision,
    result: {
      textStatus: 'failed',
      attachments: [{ ref: 'media:image-1', status: 'failed' }],
      knownFailure: true,
      adapterReceiptRef: 'adapter:failed:no',
    },
  });
  assert.throws(
    () => outbox.retryFailed(nonIdempotent.outboxId, { expectedRevision: 2 }),
    (error) => error?.code === 'OUTBOX_RETRY_DENIED',
  );

  const ambiguous = outbox.reserve(request('operation:retry:ambiguous'));
  const ambiguousSending = outbox.startSend(ambiguous.outboxId, { expectedRevision: ambiguous.revision });
  outbox.completeSend(ambiguous.outboxId, {
    expectedRevision: ambiguousSending.revision,
    result: {
      textStatus: 'ambiguous',
      attachments: [{ ref: 'media:image-1', status: 'ambiguous' }],
      adapterReceiptRef: 'adapter:ambiguous:1',
    },
  });
  assert.throws(
    () => outbox.retryFailed(ambiguous.outboxId, { expectedRevision: 2 }),
    (error) => error?.code === 'OUTBOX_RETRY_DENIED',
  );
});

test('faults around reserve, send start, adapter return, and sent commit recover without blind resend', async (t) => {
  for (const stage of ['before_reserve', 'after_reserve', 'after_send_start', 'after_adapter_return', 'after_sent_commit']) {
    const env = createIsolatedTestEnv(t, {}, `outbox-${stage}-`);
    const outbox = durableOutbox.createDurableOutbox({ env });
    const input = request(`operation:fault:${stage}`, { jobResultKey: `job-result:fault:${stage}` });
    let sends = 0;
    await assert.rejects(
      outbox.deliver(input, {
        injectFault: failAt(stage),
        send: async () => {
          sends += 1;
          return sentResult({ adapterReceiptRef: `adapter:${stage}` });
        },
      }),
      (error) => error?.code === 'TEST_FAULT',
      stage,
    );
    const afterCrash = outbox.list()[0] || null;
    if (stage === 'before_reserve') assert.equal(afterCrash, null);
    if (stage === 'after_reserve') assert.equal(afterCrash.delivery, 'reserved');
    if (['after_send_start', 'after_adapter_return'].includes(stage)) assert.equal(afterCrash.delivery, 'sending');
    if (stage === 'after_sent_commit') assert.equal(afterCrash.delivery, 'sent');

    const projected = new Set();
    const restarted = durableOutbox.createDurableOutbox({ env });
    for (let pass = 0; pass < 2; pass += 1) {
      await restarted.recover({
        timeline: async ({ outboxId }) => projected.add(`timeline:${outboxId}`),
        backend: async ({ outboxId }) => projected.add(`backend:${outboxId}`),
      });
    }
    const recovered = restarted.list()[0] || null;
    if (['after_send_start', 'after_adapter_return'].includes(stage)) {
      assert.equal(recovered.delivery, 'ambiguous');
      assert.equal(projected.size, 0);
    }
    if (stage === 'after_sent_commit') {
      assert.equal(recovered.delivery, 'sent');
      assert.equal(recovered.timelineProjection, 'committed');
      assert.equal(recovered.backendProjection, 'committed');
      assert.equal(projected.size, 2);
    }
    assert.equal(sends, ['after_adapter_return', 'after_sent_commit'].includes(stage) ? 1 : 0, stage);
  }
});

test('projection and restart faults replay only projections with the same outbox id', async (t) => {
  const env = createIsolatedTestEnv(t);
  const outbox = durableOutbox.createDurableOutbox({ env });
  const input = request('operation:projection:fault', { jobResultKey: 'job-result:projection:fault' });
  let sends = 0;
  await assert.rejects(outbox.deliver(input, {
    injectFault: failAt('after_sent_commit'),
    send: async () => {
      sends += 1;
      return sentResult();
    },
  }), (error) => error?.code === 'TEST_FAULT');

  const effects = new Set();
  const timelineCalls = [];
  const callbacks = {
    timeline: async ({ outboxId }) => {
      timelineCalls.push(outboxId);
      effects.add(`timeline:${outboxId}`);
    },
    backend: async ({ outboxId }) => effects.add(`backend:${outboxId}`),
  };
  const restarted = durableOutbox.createDurableOutbox({ env });
  await assert.rejects(
    restarted.recover({ ...callbacks, injectFault: failAt('after_timeline_projection') }),
    (error) => error?.code === 'TEST_FAULT',
  );
  assert.equal(restarted.list()[0].timelineProjection, 'pending');
  await restarted.recover(callbacks);
  await restarted.recover(callbacks);
  assert.equal(timelineCalls.length, 2);
  assert.equal(new Set(timelineCalls).size, 1);
  assert.equal(effects.size, 2);
  assert.equal(sends, 1);

  const second = request('operation:projection:backend', { jobResultKey: 'job-result:projection:backend' });
  await assert.rejects(outbox.deliver(second, {
    injectFault: failAt('after_sent_commit'),
    send: async () => sentResult({ adapterReceiptRef: 'adapter:backend' }),
  }), (error) => error?.code === 'TEST_FAULT');
  await assert.rejects(
    restarted.recover({ ...callbacks, injectFault: failAt('after_backend_projection') }),
    (error) => error?.code === 'TEST_FAULT',
  );
  const backendPending = restarted.list().find((item) => item.operationKey === second.operationKey);
  assert.equal(backendPending.timelineProjection, 'committed');
  assert.equal(backendPending.backendProjection, 'pending');
  await restarted.recover(callbacks);
  await restarted.recover(callbacks);
  assert.equal(restarted.get(backendPending.outboxId).backendProjection, 'committed');

  const third = request('operation:projection:restart', { jobResultKey: 'job-result:projection:restart' });
  await assert.rejects(outbox.deliver(third, {
    injectFault: failAt('after_sent_commit'),
    send: async () => sentResult({ adapterReceiptRef: 'adapter:restart' }),
  }), (error) => error?.code === 'TEST_FAULT');
  await assert.rejects(
    restarted.recover({ ...callbacks, injectFault: failAt('after_restart_recovery') }),
    (error) => error?.code === 'TEST_FAULT',
  );
  assert.equal(restarted.list().find((item) => item.operationKey === third.operationKey).timelineProjection, 'pending');
  await restarted.recover(callbacks);
  await restarted.recover(callbacks);
});

test('uses the supported Node 22.19+ runtime floor for this suite', () => {
  const [major, minor] = process.versions.node.split('.').map(Number);
  assert.equal(major > 22 || (major === 22 && minor >= 19), true);
});

test('legacy O1 terminal items are adopted with immutable terminal observation without changing their content digest', async (t) => {
  const env = createIsolatedTestEnv(t);
  const outbox = durableOutbox.createDurableOutbox({ env });
  const input = request('operation:legacy:sent');
  const sent = await outbox.deliver(input, { send: async () => sentResult() });
  const state = JSON.parse(fs.readFileSync(outbox.target, 'utf8'));
  const item = state.items[0];
  delete item.platform;
  delete item.conversation_id;
  delete item.exchange_id;
  delete item.delivery_terminal_revision;
  delete item.delivery_terminal_receipt_id;
  delete item.deliveryTerminalReceipts;
  const legacyContent = {
    operationKey: item.operationKey,
    jobResultKey: item.jobResultKey,
    route: item.route,
    text: item.text,
    attachments: item.attachments,
    idempotent: item.idempotent,
    maxAttempts: item.maxAttempts,
  };
  item.contentDigest = `sha256:${createHash('sha256').update(JSON.stringify(legacyContent)).digest('hex')}`;
  fs.writeFileSync(outbox.target, `${JSON.stringify(state)}\n`);

  const restarted = durableOutbox.createDurableOutbox({ env });
  const adopted = restarted.get(sent.outboxId);
  assert.equal(adopted.platform, 'wechat');
  assert.equal(adopted.conversation_id, input.route.destinationRef);
  assert.equal(adopted.exchange_id, input.operationKey);
  assert.equal(adopted.delivery_terminal_revision, 1);
  assert.match(adopted.delivery_terminal_receipt_id, /^dtr_[a-f0-9]{32}$/);
  assert.equal(restarted.getTerminalReceipt(adopted.delivery_terminal_receipt_id).delivery, 'sent');
  assert.equal(restarted.reserve(input).contentDigest, item.contentDigest);
});
