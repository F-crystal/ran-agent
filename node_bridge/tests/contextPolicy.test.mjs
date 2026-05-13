import test from 'node:test';
import assert from 'node:assert/strict';
import { getContextPolicyConfig } from '../src/contextPolicy.mjs';

test('getContextPolicyConfig uses generic ran-agent defaults', () => {
  assert.deepEqual(getContextPolicyConfig({}), {
    contextPolicyMode: 'compact',
    maxMediaArtifacts: 3,
    enableContextSizeLog: true,
  });
});

test('getContextPolicyConfig reads RAN_AGENT_* variables', () => {
  assert.deepEqual(
    getContextPolicyConfig({
      RAN_AGENT_CONTEXT_POLICY: 'legacy',
      RAN_AGENT_MAX_MEDIA_ARTIFACTS: '5',
      RAN_AGENT_CONTEXT_SIZE_LOG: '0',
    }),
    {
      contextPolicyMode: 'legacy',
      maxMediaArtifacts: 5,
      enableContextSizeLog: false,
    },
  );
});

test('getContextPolicyConfig keeps OPENCLAW_* as legacy fallback', () => {
  assert.deepEqual(
    getContextPolicyConfig({
      OPENCLAW_CONTEXT_POLICY: 'legacy',
      OPENCLAW_MAX_MEDIA_ARTIFACTS: '2',
      OPENCLAW_CONTEXT_SIZE_LOG: 'false',
    }),
    {
      contextPolicyMode: 'legacy',
      maxMediaArtifacts: 2,
      enableContextSizeLog: false,
    },
  );
});

test('getContextPolicyConfig gives RAN_AGENT_* precedence over OPENCLAW_*', () => {
  assert.deepEqual(
    getContextPolicyConfig({
      RAN_AGENT_CONTEXT_POLICY: 'compact',
      RAN_AGENT_MAX_MEDIA_ARTIFACTS: '4',
      RAN_AGENT_CONTEXT_SIZE_LOG: 'yes',
      OPENCLAW_CONTEXT_POLICY: 'legacy',
      OPENCLAW_MAX_MEDIA_ARTIFACTS: '2',
      OPENCLAW_CONTEXT_SIZE_LOG: '0',
    }),
    {
      contextPolicyMode: 'compact',
      maxMediaArtifacts: 4,
      enableContextSizeLog: true,
    },
  );
});

test('getContextPolicyConfig falls back to default media artifact cap on invalid values', () => {
  assert.equal(
    getContextPolicyConfig({ RAN_AGENT_MAX_MEDIA_ARTIFACTS: '0' }).maxMediaArtifacts,
    3,
  );
  assert.equal(
    getContextPolicyConfig({ RAN_AGENT_MAX_MEDIA_ARTIFACTS: 'not-a-number' }).maxMediaArtifacts,
    3,
  );
});
