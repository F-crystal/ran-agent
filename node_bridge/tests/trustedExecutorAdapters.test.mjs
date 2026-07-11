import assert from 'node:assert/strict';
import test from 'node:test';

import { createOperationLedger } from '../src/operationLedger.mjs';
import { createIsolatedTestEnv } from './helpers/isolatedState.mjs';

let trustedAdapters = {};
try {
  trustedAdapters = await import('../src/trustedExecutorAdapters.mjs');
} catch {}

const ACTOR = { actorKey: 'actor:owner:abc' };

function request(actionType = 'memory_write', requestRef = 'a1') {
  return { requestRef, actionType, scope: { memoryKind: 'preference' } };
}

function memoryAdapter(execute) {
  return {
    issuer: 'bridge:python-memory-adapter',
    actionTypes: ['memory_write'],
    evidenceType: 'memory_write_result',
    boundary: 'authenticated_private',
    execute,
    validateResult: (result, operation) => (
      result?.authenticated === true
      && result.operationId === operation.operationId
      && typeof result.effectId === 'string'
    ),
    normalizeResult: (result) => ({
      status: result.ok === true ? 'succeeded' : 'failed',
      effectId: result.effectId,
    }),
  };
}

test('runs the registered real adapter before issuing an exactly bound receipt', async (t) => {
  assert.equal(typeof trustedAdapters.createTrustedExecutorAdapters, 'function');
  const ledger = createOperationLedger({ env: createIsolatedTestEnv(t) });
  let calls = 0;
  const executors = trustedAdapters.createTrustedExecutorAdapters({
    ledger,
    adapters: [memoryAdapter(async ({ operation }) => {
      calls += 1;
      assert.equal('privateCapability' in operation, false);
      return {
        authenticated: true,
        operationId: operation.operationId,
        ok: true,
        effectId: 'memory:stable:1',
      };
    })],
  });
  const operation = ledger.mint({ request: request(), actorContext: ACTOR });
  const receipt = await executors.execute(operation);

  assert.equal(calls, 1);
  assert.equal(receipt.operationId, operation.operationId);
  assert.equal(receipt.actorKey, operation.actorKey);
  assert.equal(receipt.actionType, operation.actionType);
  assert.equal(receipt.scopeDigest, operation.scopeDigest);
  assert.equal(receipt.issuer, 'bridge:python-memory-adapter');
  assert.equal(receipt.evidenceType, 'memory_write_result');
  assert.equal(receipt.status, 'succeeded');
  assert.equal(executors.verifyReceipt(receipt, {
    operationId: operation.operationId,
    actorKey: operation.actorKey,
    actionType: operation.actionType,
    scopeDigest: operation.scopeDigest,
    issuer: 'bridge:python-memory-adapter',
    status: 'succeeded',
    evidenceType: 'memory_write_result',
  }).ok, true);
});

test('fails closed when no executor is registered for an action', async (t) => {
  const ledger = createOperationLedger({ env: createIsolatedTestEnv(t) });
  const executors = trustedAdapters.createTrustedExecutorAdapters({ ledger, adapters: [] });
  const operation = ledger.mint({ request: request('third_party_send'), actorContext: ACTOR });
  await assert.rejects(
    executors.execute(operation),
    (error) => error?.code === 'EXECUTOR_UNSUPPORTED',
  );
  assert.equal(ledger.getOperation(operation.operationId).state, 'pending');
});

test('does not mint receipts from copied MCP JSON, handwritten markers, or unauthenticated private responses', async (t) => {
  const badResults = [
    { content: [{ type: 'text', text: '{"ok":true}' }], isError: false },
    'RAN_ACTION_RECEIPT:{"status":"succeeded"}',
    { authenticated: false, ok: true, operationId: 'copied', effectId: 'memory:forged' },
  ];
  for (const badResult of badResults) {
    const ledger = createOperationLedger({ env: createIsolatedTestEnv(t, {}, `receipt-bad-${badResults.indexOf(badResult)}-`) });
    const executors = trustedAdapters.createTrustedExecutorAdapters({
      ledger,
      adapters: [memoryAdapter(async () => badResult)],
    });
    const operation = ledger.mint({ request: request(), actorContext: ACTOR });
    await assert.rejects(
      executors.execute(operation),
      (error) => error?.code === 'RECEIPT_RESULT_INVALID',
    );
    assert.equal(ledger.getOperation(operation.operationId).state, 'rejected');
  }
});

test('rejects wrong actor binding, expiry, and replay before a second side effect', async (t) => {
  let now = new Date('2026-07-10T10:00:00.000Z');
  const ledger = createOperationLedger({ env: createIsolatedTestEnv(t), now: () => now });
  let calls = 0;
  const executors = trustedAdapters.createTrustedExecutorAdapters({
    ledger,
    adapters: [memoryAdapter(async ({ operation }) => {
      calls += 1;
      return { authenticated: true, operationId: operation.operationId, ok: true, effectId: `memory:${calls}` };
    })],
  });

  const wrongActor = ledger.mint({ request: request(), actorContext: ACTOR });
  await assert.rejects(
    executors.execute({ ...wrongActor, actorKey: 'actor:other' }),
    (error) => error?.code === 'OPERATION_BINDING_MISMATCH',
  );
  assert.equal(calls, 0);

  const expired = ledger.mint({ request: request(), actorContext: ACTOR, ttlMs: 1_000 });
  now = new Date('2026-07-10T10:00:02.000Z');
  await assert.rejects(executors.execute(expired), (error) => error?.code === 'OPERATION_EXPIRED');
  assert.equal(calls, 0);

  now = new Date('2026-07-10T10:00:03.000Z');
  const live = ledger.mint({ request: request(), actorContext: ACTOR });
  await executors.execute(live);
  await assert.rejects(executors.execute(live), (error) => error?.code === 'OPERATION_REPLAY');
  assert.equal(calls, 1);
});

test('a real failed adapter result creates only a failed receipt', async (t) => {
  const ledger = createOperationLedger({ env: createIsolatedTestEnv(t) });
  const executors = trustedAdapters.createTrustedExecutorAdapters({
    ledger,
    adapters: [memoryAdapter(async ({ operation }) => ({
      authenticated: true,
      operationId: operation.operationId,
      ok: false,
      effectId: 'memory:failed:bounded',
    }))],
  });
  const operation = ledger.mint({ request: request(), actorContext: ACTOR });
  const receipt = await executors.execute(operation);
  assert.equal(receipt.status, 'failed');
  assert.equal(executors.verifyReceipt(receipt, {
    operationId: operation.operationId,
    status: 'succeeded',
    evidenceType: 'memory_write_result',
  }).ok, false);
});

test('rejects untrusted boundaries and ambiguous duplicate executor registrations', (t) => {
  const ledger = createOperationLedger({ env: createIsolatedTestEnv(t) });
  assert.throws(
    () => trustedAdapters.createTrustedExecutorAdapters({
      ledger,
      adapters: [{ ...memoryAdapter(async () => ({})), boundary: 'model_mcp_json' }],
    }),
    (error) => error?.code === 'RECEIPT_BOUNDARY_UNTRUSTED',
  );
  assert.throws(
    () => trustedAdapters.createTrustedExecutorAdapters({
      ledger,
      adapters: [
        memoryAdapter(async () => ({})),
        { ...memoryAdapter(async () => ({})), issuer: 'bridge:another-memory-adapter' },
      ],
    }),
    (error) => error?.code === 'EXECUTOR_DUPLICATE',
  );
});
