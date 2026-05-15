import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createFeishuBridgeState,
  normalizeFeishuMessage,
  parseFeishuEvent,
  redactFeishuMeta,
  sendFeishuReply,
} from '../src/feishuBridge.mjs';

test('parseFeishuEvent parses lark-cli NDJSON event line', () => {
  const event = parseFeishuEvent('{"schema":"2.0","event":{"message":{"message_id":"om_1","chat_id":"oc_1","chat_type":"p2p","content":"{\\"text\\":\\"你是谁\\"}"},"sender":{"sender_id":{"open_id":"ou_1","user_id":"u_1"}}}}');
  assert.equal(event.event.message.message_id, 'om_1');
});

test('normalizeFeishuMessage maps DM event to normalized schema', () => {
  const normalized = normalizeFeishuMessage({
    event: {
      message: {
        message_id: 'om-dm',
        chat_id: 'oc-dm',
        chat_type: 'p2p',
        create_time: '1710000000000',
        content: '{"text":"你是谁"}',
      },
      sender: { sender_id: { open_id: 'ou-secret', user_id: 'u-secret' }, sender_type: 'user' },
    },
  });

  assert.equal(normalized.platform, 'feishu');
  assert.equal(normalized.channel_type, 'dm');
  assert.equal(normalized.conversation_id, 'oc-dm');
  assert.equal(normalized.sender_id, 'u-secret');
  assert.equal(normalized.text, '你是谁');
  assert.equal(JSON.stringify(normalized.raw_event_meta).includes('u-secret'), false);
});

test('normalizeFeishuMessage maps group event to normalized schema', () => {
  const normalized = normalizeFeishuMessage({
    event: {
      message: {
        message_id: 'om-group',
        chat_id: 'oc-group',
        chat_type: 'group',
        content: '{"text":"群里问一句"}',
      },
      sender: { sender_id: { open_id: 'ou-user' } },
    },
  });

  assert.equal(normalized.channel_type, 'group');
  assert.equal(normalized.conversation_id, 'oc-group');
});

test('feishu bridge state dedupes message ids', () => {
  const state = createFeishuBridgeState();
  assert.equal(state.markSeen('om-1'), true);
  assert.equal(state.markSeen('om-1'), false);
});

test('sendFeishuReply constructs lark-cli send command', async () => {
  const calls = [];
  await sendFeishuReply({
    target: { channel_type: 'dm', user_id: 'u-secret' },
    text: '回复文本',
    execFileImpl: async (bin, args) => {
      calls.push({ bin, args });
      return { stdout: '{"ok":true}' };
    },
    env: { FEISHU_LARK_CLI_BIN: 'lark-cli' },
  });

  assert.equal(calls[0].bin, 'lark-cli');
  assert.equal(calls[0].args.includes('im'), true);
  assert.equal(calls[0].args.includes('+messages-send'), true);
  assert.equal(calls[0].args.includes('回复文本'), true);
});

test('redactFeishuMeta hashes raw ids', () => {
  const redacted = redactFeishuMeta({ message_id: 'om-secret', chat_id: 'oc-secret', user_id: 'u-secret' });
  const text = JSON.stringify(redacted);
  assert.equal(text.includes('u-secret'), false);
  assert.match(redacted.user_id_hash, /^[a-f0-9]{16}$/);
});
