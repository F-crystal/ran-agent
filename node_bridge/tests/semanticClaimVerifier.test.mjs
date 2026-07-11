import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getSemanticVerifierConfig,
  verifySemanticClaims,
} from '../src/semanticClaimVerifier.mjs';

const envelope = {
  schemaVersion: 1,
  message: '已经替你保存好了。',
  actionRequests: [],
  activityRequest: null,
  claims: [{ type: 'memory_saved', requestRef: 'save-1' }],
  commitments: [],
};

test('node test runtime exposes its isolated execution marker', () => {
  assert.equal(process.env.NODE_TEST_CONTEXT, 'child-v8');
});

test('verifier receives only final text, declaration types, and sanitized receipts', async () => {
  let captured;
  const result = await verifySemanticClaims({
    envelope,
    receiptSummaries: [{ requestRef: 'save-1', outcome: 'applied', privateToken: 'nope' }],
    config: { enabled: true, timeoutMs: 100, maxRewriteChars: 240 },
    verifierImpl: async (input) => {
      captured = input;
      return { supported: true, unsupportedClaims: [], rewrite: '' };
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(captured).sort(), ['declarationTypes', 'message', 'receiptSummaries']);
  assert.deepEqual(captured.declarationTypes, ['claim:memory_saved']);
  assert.deepEqual(captured.receiptSummaries, [{ requestRef: 'save-1', outcome: 'applied' }]);
  assert.equal(JSON.stringify(captured).includes('privateToken'), false);
});

test('unsupported arbitrary paraphrase gets at most one bounded rewrite', async () => {
  const result = await verifySemanticClaims({
    envelope: { ...envelope, message: '妥了，已经牢牢记下来了。' },
    receiptSummaries: [{ requestRef: 'save-1', outcome: 'failed' }],
    config: { enabled: true, timeoutMs: 100, maxRewriteChars: 40 },
    verifierImpl: async () => ({
      supported: false,
      unsupportedClaims: ['memory_saved'],
      rewrite: '保存没有成功，我没有把它当作已经保存。这个尾巴必须被截断。',
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'rewritten');
  assert.ok(result.releaseText.length <= 40);
  assert.deepEqual(result.unsupportedClaims, ['memory_saved']);
});

test('timeout, bad JSON, and verifier disagreement fail to one neutral notice', async () => {
  for (const verifierImpl of [
    async () => await new Promise(() => {}),
    async () => 'not json',
    async () => ({ supported: true, unsupportedClaims: ['memory_saved'], rewrite: '' }),
  ]) {
    const result = await verifySemanticClaims({
      envelope,
      receiptSummaries: [],
      config: { enabled: true, timeoutMs: 5, maxRewriteChars: 200 },
      verifierImpl,
    });
    assert.equal(result.ok, false);
    assert.equal(result.releaseText, '回复核验暂时失败，请稍后重试。');
    assert.equal(result.excludeFromHistory, true);
  }
});

test('enforcement refuses an incomplete provider contract', () => {
  const config = getSemanticVerifierConfig({
    HERMES_SEMANTIC_VERIFIER_ENABLED: 'true',
  });
  assert.equal(config.enabled, false);
  assert.equal(config.blockedReason, 'config_incomplete');
});

test('ordinary chat is releasable when it declares no claim or future commitment', async () => {
  const result = await verifySemanticClaims({
    envelope: { message: '我们继续聊。', claims: [], commitments: [] },
    config: getSemanticVerifierConfig({}),
  });

  assert.deepEqual(result, {
    ok: true,
    status: 'not_required',
    releaseText: '我们继续聊。',
    unsupportedClaims: [],
    excludeFromHistory: false,
  });
});

test('a real openai-compatible verifier contract enables enforcement without a mock preflight flag', () => {
  const config = getSemanticVerifierConfig({
    HERMES_SEMANTIC_VERIFIER_ENABLED: 'true',
    HERMES_SEMANTIC_VERIFIER_PROVIDER: 'openai-compatible',
    HERMES_SEMANTIC_VERIFIER_BASE_URL: 'http://127.0.0.1:8800/v1',
    HERMES_SEMANTIC_VERIFIER_MODEL: 'semantic-checker',
  });

  assert.equal(config.enabled, true);
  assert.equal(config.blockedReason, '');
  assert.equal(config.provider, 'openai-compatible');
});

test('missing verifier configuration fails closed instead of releasing Hermes text', async () => {
  const result = await verifySemanticClaims({
    envelope,
    config: getSemanticVerifierConfig({}),
  });

  assert.equal(result.ok, false);
  assert.equal(result.releaseText, '回复核验暂时失败，请稍后重试。');
  assert.equal(result.excludeFromHistory, true);
});

test('only an explicit test-only verifier bypass may release unverified text', async () => {
  const result = await verifySemanticClaims({
    envelope,
    config: {
      enabled: false,
      testOnlyBypass: true,
      testRuntime: true,
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'test_bypass');
  assert.equal(result.releaseText, envelope.message);
});

test('test-state paths still fail closed until the test bypass is explicitly enabled', async () => {
  const result = await verifySemanticClaims({
    envelope,
    config: getSemanticVerifierConfig({
      NODE_ENV: 'test',
      RAN_AGENT_ALLOW_TEST_STATE_DIR: '1',
      NODE_TEST_CONTEXT: 'child-v8',
    }),
  });

  assert.equal(result.ok, false);
});
