import test from 'node:test';
import assert from 'node:assert/strict';

import { getQuickAckConfig } from '../src/quickAck.mjs';

test('quick ack default text is a neutral processing notice', () => {
  assert.deepEqual(getQuickAckConfig({
    NODE_BRIDGE_QUICK_ACK_ENABLED: 'true',
    NODE_BRIDGE_QUICK_ACK_TIMEOUT_MS: '20',
  }), {
    enabled: true,
    timeoutMs: 20,
    ackText: '收到，正在处理。',
  });
});

test('quick ack empty custom text falls back to neutral notice', () => {
  assert.equal(getQuickAckConfig({
    NODE_BRIDGE_QUICK_ACK_ENABLED: 'true',
    NODE_BRIDGE_QUICK_ACK_TIMEOUT_MS: '20',
    NODE_BRIDGE_QUICK_ACK_TEXT: '   ',
  }).ackText, '收到，正在处理。');
});
