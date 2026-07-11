import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { createIsolatedTestEnv } from './helpers/isolatedState.mjs';

let operationLedger = {};
try {
  operationLedger = await import('../src/operationLedger.mjs');
} catch {}

const REQUEST = {
  requestRef: 'a1',
  actionType: 'memory_write',
  scope: { memoryKind: 'preference', subject: 'theme' },
  payloadRef: 'payload:7',
};
const ACTOR = { actorKey: 'actor:owner:abc', owner: true, platform: 'wechat' };

test('mints private runtime authority and persists only its digest atomically', (t) => {
  assert.equal(typeof operationLedger.createOperationLedger, 'function');
  const env = createIsolatedTestEnv(t);
  const ledger = operationLedger.createOperationLedger({
    env,
    now: () => new Date('2026-07-10T10:00:00.000Z'),
  });
  const operation = ledger.mint({ request: REQUEST, actorContext: ACTOR, ttlMs: 60_000 });

  assert.match(operation.operationId, /^op_[a-f0-9]{32}$/);
  assert.match(operation.nonce, /^nonce_[a-f0-9]{32}$/);
  assert.match(operation.privateCapability, /^opc_[a-f0-9]{64}$/);
  assert.equal(operation.actorKey, ACTOR.actorKey);
  assert.equal(operation.actionType, REQUEST.actionType);
  assert.match(operation.scopeDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(operation.createdAt, '2026-07-10T10:00:00.000Z');
  assert.equal(operation.expiresAt, '2026-07-10T10:01:00.000Z');

  const persistedText = fs.readFileSync(path.join(env.RAN_AGENT_STATE_DIR, 'core', 'operation-ledger.json'), 'utf8');
  assert.equal(persistedText.includes(operation.privateCapability), false);
  const persisted = JSON.parse(persistedText);
  assert.equal(persisted.schemaVersion, 1);
  assert.equal(persisted.operations[0].capabilityDigest.startsWith('sha256:'), true);
  assert.equal(persisted.operations[0].state, 'pending');
});

test('claims a capability once with exact actor, action, scope, and nonce binding', (t) => {
  const env = createIsolatedTestEnv(t);
  const ledger = operationLedger.createOperationLedger({ env });
  const operation = ledger.mint({ request: REQUEST, actorContext: ACTOR });

  const claimed = ledger.claim(operation);
  assert.equal(claimed.state, 'executing');
  assert.equal(claimed.operationId, operation.operationId);
  assert.throws(() => ledger.claim(operation), (error) => error?.code === 'OPERATION_REPLAY');
});

test('rejects expired and forged capabilities before execution', (t) => {
  const env = createIsolatedTestEnv(t);
  let now = new Date('2026-07-10T10:00:00.000Z');
  const ledger = operationLedger.createOperationLedger({ env, now: () => now });
  const expired = ledger.mint({ request: REQUEST, actorContext: ACTOR, ttlMs: 1_000 });
  now = new Date('2026-07-10T10:00:02.000Z');
  assert.throws(() => ledger.claim(expired), (error) => error?.code === 'OPERATION_EXPIRED');

  now = new Date('2026-07-10T10:00:03.000Z');
  const live = ledger.mint({ request: REQUEST, actorContext: ACTOR, ttlMs: 60_000 });
  assert.throws(
    () => ledger.claim({ ...live, privateCapability: `opc_${'0'.repeat(64)}` }),
    (error) => error?.code === 'OPERATION_CAPABILITY_INVALID',
  );
});

test('rejects a capability copied onto the wrong actor, action, scope, or nonce', (t) => {
  const env = createIsolatedTestEnv(t);
  const ledger = operationLedger.createOperationLedger({ env });
  const mutations = [
    { actorKey: 'actor:other' },
    { actionType: 'memory_read' },
    { scopeDigest: `sha256:${'0'.repeat(64)}` },
    { nonce: `nonce_${'0'.repeat(32)}` },
  ];
  for (const mutation of mutations) {
    const operation = ledger.mint({ request: REQUEST, actorContext: ACTOR });
    assert.throws(
      () => ledger.claim({ ...operation, ...mutation }),
      (error) => error?.code === 'OPERATION_BINDING_MISMATCH',
      JSON.stringify(mutation),
    );
  }
});

test('completes only a claimed operation with exact receipt bindings', (t) => {
  const env = createIsolatedTestEnv(t);
  const ledger = operationLedger.createOperationLedger({ env });
  let operation = ledger.mint({ request: REQUEST, actorContext: ACTOR });
  assert.throws(
    () => ledger.complete({ operationId: operation.operationId, status: 'succeeded' }),
    (error) => error?.code === 'OPERATION_NOT_EXECUTING',
  );

  for (const missingField of ['actorKey', 'actionType', 'scopeDigest', 'nonce']) {
    operation = ledger.mint({ request: REQUEST, actorContext: ACTOR });
    ledger.claim(operation);
    const incomplete = {
      operationId: operation.operationId,
      actorKey: operation.actorKey,
      actionType: operation.actionType,
      scopeDigest: operation.scopeDigest,
      nonce: operation.nonce,
      status: 'succeeded',
      issuer: 'bridge:python-memory-adapter',
      evidenceType: 'memory_write_result',
      effectDigest: `sha256:${'a'.repeat(64)}`,
    };
    delete incomplete[missingField];
    assert.throws(
      () => ledger.complete(incomplete),
      (error) => error?.code === 'OPERATION_BINDING_MISMATCH',
      missingField,
    );
  }

  operation = ledger.mint({ request: REQUEST, actorContext: ACTOR });
  ledger.claim(operation);
  const completed = ledger.complete({
    operationId: operation.operationId,
    actorKey: operation.actorKey,
    actionType: operation.actionType,
    scopeDigest: operation.scopeDigest,
    nonce: operation.nonce,
    status: 'succeeded',
    issuer: 'bridge:python-memory-adapter',
    evidenceType: 'memory_write_result',
    effectDigest: `sha256:${'a'.repeat(64)}`,
  });
  assert.equal(completed.state, 'completed');
  assert.equal(completed.status, 'succeeded');
  assert.throws(
    () => ledger.complete({ ...completed }),
    (error) => error?.code === 'OPERATION_NOT_EXECUTING',
  );
});

test('treats a persisted scope that no longer matches its digest as corrupt critical state', (t) => {
  const env = createIsolatedTestEnv(t);
  const ledger = operationLedger.createOperationLedger({ env });
  const operation = ledger.mint({ request: REQUEST, actorContext: ACTOR });
  const persisted = JSON.parse(fs.readFileSync(ledger.target, 'utf8'));
  persisted.operations[0].scope.subject = 'tampered';
  fs.writeFileSync(ledger.target, `${JSON.stringify(persisted)}\n`, 'utf8');

  assert.throws(
    () => ledger.getOperation(operation.operationId),
    (error) => error?.code === 'RAN_AGENT_STATE_CORRUPT',
  );
});
