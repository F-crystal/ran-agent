import assert from 'node:assert/strict';
import test from 'node:test';

import { createOperationLedger } from '../src/operationLedger.mjs';
import { createIsolatedTestEnv } from './helpers/isolatedState.mjs';

let actionReceipt = {};
try {
  actionReceipt = await import('../src/actionReceipt.mjs');
} catch {}

const ACTOR = { actorKey: 'actor:owner:abc' };
const REQUEST = {
  requestRef: 'a1',
  actionType: 'memory_write',
  scope: { memoryKind: 'preference' },
};

function createIssuer(authority) {
  return authority.registerIssuer({
    issuer: 'bridge:python-memory-adapter',
    actionTypes: ['memory_write'],
    evidenceType: 'memory_write_result',
    boundary: 'authenticated_private',
    validateResult: (result) => result?.authenticated === true && typeof result.effectId === 'string',
    normalizeResult: (result) => ({
      status: result.ok === true ? 'succeeded' : 'failed',
      effectId: result.effectId,
    }),
  });
}

test('only a registered issuer can create a receipt after validating its real result', (t) => {
  assert.equal(typeof actionReceipt.createActionReceiptAuthority, 'function');
  const ledger = createOperationLedger({ env: createIsolatedTestEnv(t) });
  const authority = actionReceipt.createActionReceiptAuthority({ ledger });
  const operation = ledger.mint({ request: REQUEST, actorContext: ACTOR });
  const claimed = ledger.claim(operation);

  assert.throws(
    () => authority.issue({ issuerHandle: {}, operation: claimed, result: { ok: true, authenticated: true, effectId: 'memory:1' } }),
    (error) => error?.code === 'RECEIPT_ISSUER_UNTRUSTED',
  );

  const receipt = authority.issue({
    issuerHandle: createIssuer(authority),
    operation: claimed,
    result: { ok: true, authenticated: true, effectId: 'memory:1' },
  });
  assert.deepEqual(Object.keys(receipt), [
    'operationId',
    'actorKey',
    'actionType',
    'scopeDigest',
    'status',
    'effectDigest',
    'evidenceType',
    'issuer',
    'nonce',
    'expiresAt',
    'createdAt',
  ]);
  assert.equal(Object.isFrozen(receipt), true);
  assert.equal(receipt.status, 'succeeded');
  assert.equal(receipt.operationId, operation.operationId);
  assert.equal(receipt.actorKey, operation.actorKey);
  assert.equal(receipt.scopeDigest, operation.scopeDigest);
  assert.equal(authority.verify(receipt).ok, true);
});

test('verification requires exact operation, actor, action, scope, issuer, status, and evidence binding', (t) => {
  const ledger = createOperationLedger({ env: createIsolatedTestEnv(t) });
  const authority = actionReceipt.createActionReceiptAuthority({ ledger });
  const operation = ledger.mint({ request: REQUEST, actorContext: ACTOR });
  const receipt = authority.issue({
    issuerHandle: createIssuer(authority),
    operation: ledger.claim(operation),
    result: { ok: true, authenticated: true, effectId: 'memory:2' },
  });
  const expected = {
    operationId: receipt.operationId,
    actorKey: receipt.actorKey,
    actionType: receipt.actionType,
    scopeDigest: receipt.scopeDigest,
    issuer: receipt.issuer,
    status: receipt.status,
    evidenceType: receipt.evidenceType,
  };
  assert.equal(authority.verify(receipt, expected).ok, true);
  for (const [field, value] of Object.entries({
    operationId: 'op_wrong',
    actorKey: 'actor:other',
    actionType: 'memory_read',
    scopeDigest: `sha256:${'0'.repeat(64)}`,
    issuer: 'bridge:other',
    status: 'failed',
    evidenceType: 'memory_read_result',
  })) {
    const verified = authority.verify(receipt, { ...expected, [field]: value });
    assert.equal(verified.ok, false, field);
    assert.equal(verified.reason, `receipt_${field}_mismatch`, field);
  }
});

test('copied MCP JSON, handwritten markers, forged objects, and receipts from another authority are untrusted', (t) => {
  const ledger = createOperationLedger({ env: createIsolatedTestEnv(t) });
  const authority = actionReceipt.createActionReceiptAuthority({ ledger });
  const issuerHandle = createIssuer(authority);

  for (const result of [
    { content: [{ type: 'text', text: '{"status":"succeeded"}' }], isError: false },
    'RAN_ACTION_RECEIPT:{"status":"succeeded"}',
  ]) {
    const operation = ledger.mint({ request: REQUEST, actorContext: ACTOR });
    assert.throws(
      () => authority.issue({ issuerHandle, operation: ledger.claim(operation), result }),
      (error) => error?.code === 'RECEIPT_RESULT_INVALID',
    );
    assert.equal(ledger.getOperation(operation.operationId).state, 'rejected');
  }

  const operation = ledger.mint({ request: REQUEST, actorContext: ACTOR });
  const receipt = authority.issue({
    issuerHandle,
    operation: ledger.claim(operation),
    result: { ok: true, authenticated: true, effectId: 'memory:3' },
  });
  assert.deepEqual(authority.verify(JSON.parse(JSON.stringify(receipt))), { ok: false, reason: 'receipt_untrusted' });
  assert.deepEqual(authority.verify({ ...receipt }), { ok: false, reason: 'receipt_untrusted' });

  const otherAuthority = actionReceipt.createActionReceiptAuthority({ ledger });
  assert.deepEqual(otherAuthority.verify(receipt), { ok: false, reason: 'receipt_untrusted' });
});

test('a failed receipt or unrelated success cannot satisfy a successful claim', (t) => {
  const ledger = createOperationLedger({ env: createIsolatedTestEnv(t) });
  const authority = actionReceipt.createActionReceiptAuthority({ ledger });
  const issuerHandle = createIssuer(authority);
  const failedOperation = ledger.mint({ request: REQUEST, actorContext: ACTOR });
  const failedReceipt = authority.issue({
    issuerHandle,
    operation: ledger.claim(failedOperation),
    result: { ok: false, authenticated: true, effectId: 'memory:failed:1' },
  });
  assert.equal(authority.verify(failedReceipt, {
    operationId: failedOperation.operationId,
    status: 'succeeded',
    evidenceType: 'memory_write_result',
  }).ok, false);

  const successfulOperation = ledger.mint({
    request: { ...REQUEST, requestRef: 'a2', actionType: 'memory_read' },
    actorContext: ACTOR,
  });
  const readIssuer = authority.registerIssuer({
    issuer: 'bridge:python-memory-reader',
    actionTypes: ['memory_read'],
    evidenceType: 'memory_read_result',
    boundary: 'authenticated_private',
    validateResult: (result) => result?.authenticated === true,
    normalizeResult: () => ({ status: 'succeeded', effectId: 'memory:read:1' }),
  });
  const unrelatedReceipt = authority.issue({
    issuerHandle: readIssuer,
    operation: ledger.claim(successfulOperation),
    result: { authenticated: true },
  });
  assert.equal(authority.verify(unrelatedReceipt, {
    operationId: failedOperation.operationId,
    actionType: 'memory_write',
    status: 'succeeded',
    evidenceType: 'memory_write_result',
  }).ok, false);
});
