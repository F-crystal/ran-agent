import assert from 'node:assert/strict';
import test from 'node:test';

import { createOperationLedger } from '../src/operationLedger.mjs';
import { createTrustedExecutorAdapters } from '../src/trustedExecutorAdapters.mjs';
import { createIsolatedTestEnv } from './helpers/isolatedState.mjs';

let personalLearningClient = {};
try {
  personalLearningClient = await import('../src/personalLearningClient.mjs');
} catch {}

const ACTION_TYPES = [
  'memory.remember',
  'memory.correct',
  'memory.forget',
  'memory.query',
];
const ENV = {
  PYTHON_BACKEND_BASE_URL: 'http://127.0.0.2:9876/',
  RAN_AGENT_INTERNAL_CONTROL_SECRET: 'owner-control-secret',
  PERSONAL_LEARNING_CLIENT_TIMEOUT_MS: '2500',
};

function operation(actionType = 'memory.remember', suffix = '1') {
  return {
    operationId: `op_${suffix.padStart(32, '0')}`,
    actorKey: 'actor:must-not-cross-boundary',
    actionType,
    scope: { subjectKey: 'reply:structure', statement: '先给结果' },
    scopeDigest: `sha256:${'a'.repeat(64)}`,
    nonce: `nonce_${'b'.repeat(32)}`,
    privateCapability: `opc_${'c'.repeat(64)}`,
  };
}

function responseFor(operationValue, overrides = {}) {
  return {
    ok: true,
    authenticated: true,
    operationId: operationValue.operationId,
    effectId: `learning:${operationValue.actionType}:effect-1`,
    result: { actionType: operationValue.actionType, records: [] },
    ...overrides,
  };
}

function jsonResponse(payload, ok = true, status = 200) {
  return {
    ok,
    status,
    async json() { return payload; },
  };
}

test('exports one frozen trusted-executor adapter for the exact personal-learning actions', () => {
  assert.equal(typeof personalLearningClient.createPersonalLearningExecutorAdapter, 'function');
  const adapter = personalLearningClient.createPersonalLearningExecutorAdapter({
    env: ENV,
    fetchImpl: async () => jsonResponse({}),
  });
  assert.deepEqual(adapter.actionTypes, ACTION_TYPES);
  assert.equal(Object.isFrozen(adapter.actionTypes), true);
  assert.equal(adapter.issuer, 'bridge:python-personal-learning-adapter');
  assert.equal(adapter.evidenceType, 'personal_learning_result');
  assert.equal(adapter.boundary, 'authenticated_private');
  assert.equal(typeof adapter.execute, 'function');
  assert.equal(typeof adapter.validateResult, 'function');
  assert.equal(typeof adapter.normalizeResult, 'function');
  assert.equal(Object.isFrozen(adapter), true);
});

test('posts only operationId, actionType, and scope to the exact authenticated loopback route', async () => {
  const captured = [];
  const adapter = personalLearningClient.createPersonalLearningExecutorAdapter({
    env: ENV,
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      captured.push({ url, init, body });
      return jsonResponse(responseFor(body));
    },
  });

  for (let index = 0; index < ACTION_TYPES.length; index += 1) {
    const operationValue = operation(ACTION_TYPES[index], String(index + 1));
    const result = await adapter.execute({ operation: operationValue });
    assert.deepEqual(result, responseFor(operationValue));
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.result), true);
  }

  for (const call of captured) {
    assert.equal(call.url, 'http://127.0.0.2:9876/internal/personal-learning/actions');
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.headers.Authorization, 'Bearer owner-control-secret');
    assert.equal(call.init.headers['Content-Type'], 'application/json');
    assert.deepEqual(Object.keys(call.body), ['operationId', 'actionType', 'scope']);
    assert.equal('actorKey' in call.body, false);
    assert.equal('nonce' in call.body, false);
    assert.equal('privateCapability' in call.body, false);
  }
});

test('integrates with trustedExecutorAdapters and signs succeeded or failed canonical effects', async (t) => {
  const env = createIsolatedTestEnv(t, ENV);
  const ledger = createOperationLedger({ env });
  let backendOk = true;
  const adapter = personalLearningClient.createPersonalLearningExecutorAdapter({
    env,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      return jsonResponse(responseFor(body, {
        ok: backendOk,
        effectId: backendOk ? 'learning:remember:stable-1' : 'learning:forget:failed-1',
        result: backendOk ? { learningId: 'learn_12345678' } : { errorCode: 'not_found' },
      }));
    },
  });
  const executors = createTrustedExecutorAdapters({ ledger, adapters: [adapter] });

  const remember = ledger.mint({
    request: { requestRef: 'a1', actionType: 'memory.remember', scope: { subjectKey: 'reply:structure' } },
    actorContext: { actorKey: 'actor:owner:abc' },
  });
  const success = await executors.execute(remember);
  assert.equal(success.status, 'succeeded');
  assert.equal(success.issuer, adapter.issuer);
  assert.equal(success.evidenceType, adapter.evidenceType);

  backendOk = false;
  const forget = ledger.mint({
    request: { requestRef: 'a2', actionType: 'memory.forget', scope: { subjectKey: 'reply:structure' } },
    actorContext: { actorKey: 'actor:owner:abc' },
  });
  const failure = await executors.execute(forget);
  assert.equal(failure.status, 'failed');
  assert.equal(executors.verifyReceipt(failure, {
    operationId: forget.operationId,
    status: 'succeeded',
    evidenceType: adapter.evidenceType,
  }).ok, false);
});

test('rejects missing secret, non-loopback bases, base paths, and unsupported actions before fetch', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return jsonResponse({});
  };
  for (const env of [
    { ...ENV, RAN_AGENT_INTERNAL_CONTROL_SECRET: '' },
    { ...ENV, PYTHON_BACKEND_BASE_URL: 'https://learning.example.com' },
    { ...ENV, PYTHON_BACKEND_BASE_URL: 'http://localhost:8787' },
    { ...ENV, PYTHON_BACKEND_BASE_URL: 'http://127.0.0.1:8787/base' },
  ]) {
    assert.throws(
      () => personalLearningClient.createPersonalLearningExecutorAdapter({ env, fetchImpl }),
      (error) => error?.code === 'PERSONAL_LEARNING_ADAPTER_CONFIG',
    );
  }
  const adapter = personalLearningClient.createPersonalLearningExecutorAdapter({ env: ENV, fetchImpl });
  await assert.rejects(
    adapter.execute({ operation: operation('memory.unsupported') }),
    (error) => error?.code === 'PERSONAL_LEARNING_ACTION_INVALID',
  );
  assert.equal(calls, 0);
});

test('strictly rejects widened, unauthenticated, mismatched, or malformed executor responses', async () => {
  const operationValue = operation();
  const invalidPayloads = [
    { ...responseFor(operationValue), extra: true },
    { ...responseFor(operationValue), authenticated: false },
    { ...responseFor(operationValue), operationId: `op_${'f'.repeat(32)}` },
    { ...responseFor(operationValue), effectId: '/private/effect' },
    { ...responseFor(operationValue), result: ['not-an-object'] },
    { ...responseFor(operationValue), ok: 'true' },
  ];
  for (const payload of invalidPayloads) {
    const adapter = personalLearningClient.createPersonalLearningExecutorAdapter({
      env: ENV,
      fetchImpl: async () => jsonResponse(payload),
    });
    await assert.rejects(
      adapter.execute({ operation: operationValue }),
      (error) => error?.code === 'PERSONAL_LEARNING_RESPONSE_INVALID',
    );
    assert.equal(adapter.validateResult(payload, operationValue), false);
  }
});

test('errors never echo response bodies, bearer secrets, fetch errors, or private paths', async () => {
  const privateText = 'Bearer owner-control-secret /private/runtime/path';
  const cases = [
    async () => jsonResponse({ error: privateText }, false, 503),
    async () => jsonResponse(responseFor(operation()), true, 503),
    async () => Object.defineProperty({}, 'ok', { get() { throw new Error(privateText); } }),
    async () => ({ ok: true, status: 200, async json() { throw new Error(privateText); } }),
    async () => { throw new Error(privateText); },
    async () => jsonResponse({ ...responseFor(operation()), result: privateText }),
  ];
  for (const fetchImpl of cases) {
    const adapter = personalLearningClient.createPersonalLearningExecutorAdapter({ env: ENV, fetchImpl });
    await assert.rejects(adapter.execute({ operation: operation() }), (error) => {
      assert.doesNotMatch(error.message, /owner-control-secret|private\/runtime|Bearer/);
      assert.match(error.code, /^PERSONAL_LEARNING_/);
      return true;
    });
  }
});

test('rejects non-JSON or oversized scopes without making a request', async () => {
  let calls = 0;
  const adapter = personalLearningClient.createPersonalLearningExecutorAdapter({
    env: ENV,
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({});
    },
  });
  await assert.rejects(
    adapter.execute({ operation: { ...operation(), scope: { callback: () => true } } }),
    (error) => error?.code === 'PERSONAL_LEARNING_SCOPE_INVALID',
  );
  await assert.rejects(
    adapter.execute({ operation: { ...operation(), scope: { statement: 'x'.repeat(20_000) } } }),
    (error) => error?.code === 'PERSONAL_LEARNING_SCOPE_INVALID',
  );
  assert.equal(calls, 0);
});

test('uses the supported Node 22.13+ runtime floor for this suite', () => {
  const [major, minor] = process.versions.node.split('.').map(Number);
  assert.equal(major > 22 || (major === 22 && minor >= 13), true);
});
