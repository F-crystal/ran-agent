import test from 'node:test';
import assert from 'node:assert/strict';

const modelOverridesModule = await import('../../node_modules/openclaw/dist/model-overrides-DTy0-qnF.js');
const mergeSessionEntryForStore = modelOverridesModule.m;

test('fresh session store writes do not retain stale runtime model metadata', {
  skip: typeof mergeSessionEntryForStore !== 'function'
    ? 'installed OpenClaw build does not expose mergeSessionEntryForStore test hook'
    : false,
}, () => {
  const previousEntry = {
    sessionId: 'old-session',
    model: 'qwen3.5-plus',
    modelProvider: 'qwen',
    liveModelSwitchPending: true,
    cliSessionIds: ['cli-123'],
    providerOverride: 'claude_code',
    modelOverride: 'glm-5',
    updatedAt: 1,
  };

  const sessionEntry = {
    sessionId: 'new-session',
    providerOverride: 'claude_code',
    modelOverride: 'glm-5',
    updatedAt: 2,
  };

  const merged = mergeSessionEntryForStore(previousEntry, sessionEntry, true);

  assert.equal(merged.sessionId, 'new-session');
  assert.equal(merged.providerOverride, 'claude_code');
  assert.equal(merged.modelOverride, 'glm-5');
  assert.equal('model' in merged, false);
  assert.equal('modelProvider' in merged, false);
  assert.equal('liveModelSwitchPending' in merged, false);
  assert.equal('cliSessionIds' in merged, false);
});
