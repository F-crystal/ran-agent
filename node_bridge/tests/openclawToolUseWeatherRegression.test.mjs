import test from 'node:test';
import assert from 'node:assert/strict';

const compactModule = await import('../../node_modules/openclaw/dist/compact-CMxQKbp-.js');
const {
  __testOnlyResolveLiveToolResultMaxChars,
  __testOnlyShouldSuppressAssistantVisibleOutput,
} = compactModule;

const hasCompactTestHooks =
  typeof __testOnlyResolveLiveToolResultMaxChars === 'function'
  && typeof __testOnlyShouldSuppressAssistantVisibleOutput === 'function';

test('web search tool results use a tighter live context cap', {
  skip: !hasCompactTestHooks
    ? 'installed OpenClaw build does not expose compact test hooks'
    : false,
}, () => {
  const message = {
    role: 'toolResult',
    toolName: 'web_search',
    content: [{ type: 'text', text: 'x'.repeat(14000) }],
  };

  assert.equal(__testOnlyResolveLiveToolResultMaxChars(message, 40000), 6000);
});

test('non-web tool results keep the fallback live context cap', {
  skip: !hasCompactTestHooks
    ? 'installed OpenClaw build does not expose compact test hooks'
    : false,
}, () => {
  const message = {
    role: 'toolResult',
    toolName: 'read',
    content: [{ type: 'text', text: 'x'.repeat(14000) }],
  };

  assert.equal(__testOnlyResolveLiveToolResultMaxChars(message, 40000), 40000);
});

test('toolUse assistant turns suppress visible output', {
  skip: !hasCompactTestHooks
    ? 'installed OpenClaw build does not expose compact test hooks'
    : false,
}, () => {
  const message = {
    role: 'assistant',
    stopReason: 'toolUse',
    content: [
      { type: 'text', text: '我需要重新搜索今天的北京天气。' },
      { type: 'toolCall', id: 'call_1', name: 'web_search', arguments: { query: '北京今天天气' } },
    ],
  };

  assert.equal(__testOnlyShouldSuppressAssistantVisibleOutput(message), true);
});

test('final assistant replies stay visible', {
  skip: !hasCompactTestHooks
    ? 'installed OpenClaw build does not expose compact test hooks'
    : false,
}, () => {
  const message = {
    role: 'assistant',
    stopReason: 'stop',
    content: [{ type: 'text', text: '北京今天晴，14 到 25 度。' }],
  };

  assert.equal(__testOnlyShouldSuppressAssistantVisibleOutput(message), false);
});
