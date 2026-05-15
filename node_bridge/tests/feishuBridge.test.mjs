import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createFeishuBridgeState,
  isUnsupportedFeishuIdentityError,
  normalizeFeishuMessage,
  parseFeishuEvent,
  redactFeishuMeta,
  sendFeishuReply,
  startFeishuBridge,
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

test('normalizeFeishuMessage accepts flat lark-cli event with plain string content', () => {
  const normalized = normalizeFeishuMessage({
    type: 'im.message.receive_v1',
    chat_type: 'p2p',
    message_type: 'text',
    sender_id: 'ou_9cff56d4db20fec883afa07c06c23ad0',
    chat_id: 'oc_df014a032d9d11d230c3011cb602ef40',
    content: '入口测试',
  });

  assert.equal(normalized.channel_type, 'dm');
  assert.equal(normalized.conversation_id, 'oc_df014a032d9d11d230c3011cb602ef40');
  assert.equal(normalized.sender_id, 'ou_9cff56d4db20fec883afa07c06c23ad0');
  assert.equal(normalized.text, '入口测试');
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
    target: { channel_type: 'dm', sender_id: 'ou-secret', source_message_id: 'om-source' },
    text: '回复文本',
    execFileImpl: async (bin, args) => {
      calls.push({ bin, args });
      return { stdout: '{"ok":true}' };
    },
    env: { FEISHU_LARK_CLI_BIN: 'lark-cli', FEISHU_LARK_CLI_IDENTITY: 'bot' },
  });

  assert.equal(calls[0].bin, 'lark-cli');
  assert.deepEqual(calls[0].args.slice(0, 4), ['im', '+messages-send', '--as', 'bot']);
  assert.equal(calls[0].args.includes('--user-id'), true);
  assert.equal(calls[0].args.includes('ou-secret'), true);
  assert.equal(calls[0].args.includes('--text'), true);
  assert.equal(calls[0].args.includes('回复文本'), true);
  assert.equal(calls[0].args.includes('--receive-id-type'), false);
  assert.equal(calls[0].args.includes('--idempotency-key'), true);
});

test('sendFeishuReply sends group replies by chat id with explicit idempotency key', async () => {
  const calls = [];
  await sendFeishuReply({
    target: { channel_type: 'group', conversation_id: 'oc-group', idempotency_key: 'reply-once' },
    text: '群回复',
    execFileImpl: async (bin, args) => {
      calls.push({ bin, args });
      return { stdout: '{"ok":true}' };
    },
    env: { FEISHU_LARK_CLI_BIN: 'lark-cli' },
  });

  assert.equal(calls[0].args.includes('--chat-id'), true);
  assert.equal(calls[0].args.includes('oc-group'), true);
  assert.equal(calls[0].args.at(calls[0].args.indexOf('--idempotency-key') + 1), 'reply-once');
});

test('startFeishuBridge consumes events as bot by default', () => {
  const calls = [];
  const fakeChild = {
    stdout: { on() {} },
    stderr: { on() {} },
    on() {},
    kill() {},
  };
  const bridge = startFeishuBridge({
    env: { FEISHU_BRIDGE_ENABLED: 'true', FEISHU_LARK_CLI_BIN: 'lark-cli' },
    spawnImpl: (bin, args, opts) => {
      calls.push({ bin, args, opts });
      return fakeChild;
    },
    logger: { info() {}, warn() {}, error() {}, log() {} },
  });
  bridge.stop();

  assert.equal(calls[0].bin, 'lark-cli');
  assert.deepEqual(calls[0].args, ['event', 'consume', 'im.message.receive_v1', '--as', 'bot']);
  assert.deepEqual(calls[0].opts.stdio, ['pipe', 'pipe', 'pipe']);
});

test('Feishu user identity event consume error is recognized', () => {
  const error = 'resolved identity "user" is not supported, this command only supports: bot';
  assert.equal(isUnsupportedFeishuIdentityError(error), true);
});

test('redactFeishuMeta hashes raw ids', () => {
  const redacted = redactFeishuMeta({ message_id: 'om-secret', chat_id: 'oc-secret', user_id: 'u-secret' });
  const text = JSON.stringify(redacted);
  assert.equal(text.includes('u-secret'), false);
  assert.match(redacted.user_id_hash, /^[a-f0-9]{16}$/);
});
