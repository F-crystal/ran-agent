import assert from 'node:assert/strict';
import test from 'node:test';

let actionRequest = {};
try {
  actionRequest = await import('../src/actionRequest.mjs');
} catch {}

test('normalizes only the model-visible action declaration', () => {
  assert.equal(typeof actionRequest.normalizeActionRequest, 'function');
  const request = actionRequest.normalizeActionRequest({
    requestRef: 'a1',
    actionType: 'memory_write',
    scope: { subject: 'theme', memoryKind: 'preference' },
    payloadRef: 'payload:7',
    requestedAuthorizationBasis: 'explicit_current_turn',
  });

  assert.deepEqual(request, {
    requestRef: 'a1',
    actionType: 'memory_write',
    scope: { memoryKind: 'preference', subject: 'theme' },
    payloadRef: 'payload:7',
    requestedAuthorizationBasis: 'explicit_current_turn',
  });
  assert.equal(Object.isFrozen(request), true);
  assert.equal(Object.isFrozen(request.scope), true);
});

test('requestRef is correlation only and does not affect the scope digest', () => {
  assert.equal(typeof actionRequest.digestActionScope, 'function');
  const left = actionRequest.digestActionScope({ b: 2, a: { z: true, y: 'x' } });
  const right = actionRequest.digestActionScope({ a: { y: 'x', z: true }, b: 2 });
  assert.match(left, /^sha256:[a-f0-9]{64}$/);
  assert.equal(left, right);
});

test('rejects model-supplied authority, receipt, identity, and private operation fields', () => {
  assert.equal(typeof actionRequest.normalizeActionRequest, 'function');
  for (const field of [
    'operationId',
    'actorKey',
    'scopeDigest',
    'nonce',
    'expiresAt',
    'capability',
    'issuer',
    'evidenceType',
    'status',
    'receipt',
    'consentDecision',
    'authorized',
  ]) {
    assert.throws(
      () => actionRequest.normalizeActionRequest({
        requestRef: 'a1',
        actionType: 'memory_write',
        scope: {},
        [field]: 'model-value',
      }),
      (error) => error?.code === 'ACTION_REQUEST_PRIVATE_FIELD',
      field,
    );
  }
});

test('rejects unknown fields and unbounded scope values', () => {
  assert.throws(
    () => actionRequest.normalizeActionRequest({ requestRef: 'a1', actionType: 'memory_write', surprise: true }),
    (error) => error?.code === 'ACTION_REQUEST_UNKNOWN_FIELD',
  );
  assert.throws(
    () => actionRequest.normalizeActionRequest({
      requestRef: 'a1',
      actionType: 'memory_write',
      scope: { callback: () => true },
    }),
    (error) => error?.code === 'ACTION_REQUEST_INVALID',
  );
});
