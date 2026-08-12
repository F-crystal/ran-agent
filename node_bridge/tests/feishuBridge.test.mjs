import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  createFeishuBridgeState,
  handleFeishuEventLine,
  isUnsupportedFeishuIdentityError,
  normalizeFeishuMessage,
  parseFeishuEvent,
  redactFeishuMeta,
  sendFeishuMediaReply,
  sendFeishuReply,
  startFeishuBridge,
} from '../src/feishuBridge.mjs';
import { handleIncomingMessage } from '../src/channelHub.mjs';
import { createDurableOutbox } from '../src/durableOutbox.mjs';
import { readTimelineRecords } from '../src/globalTimeline.mjs';
import { createIsolatedTestEnv } from './helpers/isolatedState.mjs';
import { getFeishuHomeDmTarget } from '../src/runtimeState.mjs';

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

test('normalizeFeishuMessage extracts image media resource candidates without local paths', () => {
  const normalized = normalizeFeishuMessage({
    event: {
      message: {
        message_id: 'om-image',
        chat_id: 'oc-image',
        chat_type: 'p2p',
        message_type: 'image',
        content: '{"image_key":"img_v3_secret"}',
      },
      sender: { sender_id: { open_id: 'ou-user' } },
    },
  });

  assert.deepEqual(normalized.media, []);
  assert.deepEqual(normalized.media_resources, [
    {
      messageId: 'om-image',
      fileKey: 'img_v3_secret',
      resourceType: 'image',
      fileName: '',
      mimeType: 'image/png',
      mediaType: 'image',
    },
  ]);
  assert.doesNotMatch(JSON.stringify(normalized), /filePath|local_path/);
});

test('normalizeFeishuMessage extracts file media resource candidates with filename metadata', () => {
  const normalized = normalizeFeishuMessage({
    message_id: 'om-file',
    chat_id: 'oc-file',
    chat_type: 'p2p',
    msg_type: 'file',
    content: '{"file_key":"file_v3_secret","file_name":"funny.gif"}',
    sender_id: 'ou-file',
  });

  assert.deepEqual(normalized.media_resources, [
    {
      messageId: 'om-file',
      fileKey: 'file_v3_secret',
      resourceType: 'file',
      fileName: 'funny.gif',
      mimeType: 'image/gif',
      mediaType: 'image',
    },
  ]);
});

test('feishu bridge state dedupes message ids', () => {
  const state = createFeishuBridgeState();
  assert.equal(state.markSeen('om-1'), true);
  assert.equal(state.markSeen('om-1'), false);
});

test('handleFeishuEventLine records latest DM target for scheduled digests', async (t) => {
  const env = createIsolatedTestEnv(t, {}, 'feishu-target-');
  {
    const state = createFeishuBridgeState();
    await handleFeishuEventLine(
      '{"schema":"2.0","event":{"message":{"message_id":"om-dm-target","chat_id":"oc-dm-target","chat_type":"p2p","content":"{\\"text\\":\\"绑定日报\\"}"},"sender":{"sender_id":{"open_id":"ou-target"}}}}',
      {
        state,
        logger: { log() {}, warn() {}, error() {} },
        env,
        channelHub: async () => ({ replyText: 'ok' }),
      }
    );

    assert.deepEqual(getFeishuHomeDmTarget(env), {
      platform: 'feishu',
      channel_type: 'dm',
      conversation_id: 'oc-dm-target',
      sender_id: 'ou-target',
    });
  }
});

test('sendFeishuReply constructs lark-cli send command', async () => {
  const calls = [];
  await sendFeishuReply({
    target: { channel_type: 'dm', sender_id: 'ou-secret', source_message_id: 'om-source' },
    text: '回复文本',
    execFileImpl: async (bin, args, options) => {
      calls.push({ bin, args, options });
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
    execFileImpl: async (bin, args, options) => {
      calls.push({ bin, args, options });
      return { stdout: '{"ok":true}' };
    },
    env: { FEISHU_LARK_CLI_BIN: 'lark-cli' },
  });

  assert.equal(calls[0].args.includes('--chat-id'), true);
  assert.equal(calls[0].args.includes('oc-group'), true);
  assert.equal(calls[0].args.at(calls[0].args.indexOf('--idempotency-key') + 1), 'reply-once');
});

test('sendFeishuReply rejects an empty recipient before invoking lark-cli', async () => {
  let calls = 0;
  await assert.rejects(sendFeishuReply({
    target: { channel_type: 'dm' },
    text: 'must not send',
    execFileImpl: async () => { calls += 1; },
  }), /feishu recipient is required/);
  assert.equal(calls, 0);
});

function createTempStickerCatalog(t, name, entry = {}) {
  const env = createIsolatedTestEnv(t, {}, name);
  const stateDir = env.RAN_AGENT_STATE_DIR;
  const assetsDir = path.join(stateDir, 'stickers', 'assets');
  fs.mkdirSync(assetsDir, { recursive: true });
  const fileName = entry.fileName || 'stk_001.png';
  fs.writeFileSync(path.join(assetsDir, fileName), entry.bytes || 'fake sticker bytes');
  fs.writeFileSync(path.join(stateDir, 'stickers', 'index.json'), JSON.stringify({
    stk_001: {
      stickerId: 'stk_001',
      fileName,
      mime: entry.mime || 'image/png',
      tags: ['ok'],
      source: 'manual',
    },
  }));
  fs.writeFileSync(path.join(stateDir, 'stickers', 'tags.json'), '{}');
  fs.writeFileSync(path.join(stateDir, 'stickers', 'hashes.json'), '{}');
  return { env, stateDir, assetsDir, filePath: path.join(assetsDir, fileName), fileName };
}

test('sendFeishuMediaReply sends text first and image sticker with lark-cli image flag', async (t) => {
  const catalog = createTempStickerCatalog(t, 'feishu-sticker-image-');
  const calls = [];

  const result = await sendFeishuMediaReply({
    target: { channel_type: 'dm', sender_id: 'ou-secret', source_message_id: 'om-source' },
    text: '先给你文字',
    media: {
      source: 'sticker_catalog',
      kind: 'sticker',
      stickerId: 'stk_001',
      filePath: '/untrusted/ignored.png',
    },
    execFileImpl: async (bin, args, options) => {
      calls.push({ bin, args, options });
      return { stdout: '{"ok":true}' };
    },
    env: {
      ...catalog.env,
      FEISHU_LARK_CLI_BIN: 'lark-cli',
      FEISHU_LARK_CLI_IDENTITY: 'bot',
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.media_sent, true);
  assert.equal(result.media_method, 'image');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].args.includes('--text'), true);
  assert.equal(calls[0].args.includes('先给你文字'), true);
  assert.equal(calls[1].bin, 'lark-cli');
  assert.deepEqual(calls[1].args.slice(0, 4), ['im', '+messages-send', '--as', 'bot']);
  assert.equal(calls[1].args.includes('--image'), true);
  assert.equal(calls[1].args.at(calls[1].args.indexOf('--image') + 1), catalog.fileName);
  assert.equal(calls[1].args.includes('--file'), false);
  assert.equal(calls[1].args.includes('/untrusted/ignored.png'), false);
  assert.equal(calls[1].options.cwd, catalog.assetsDir);
  assert.equal(path.isAbsolute(calls[1].args.at(calls[1].args.indexOf('--image') + 1)), false);
});

test('sendFeishuMediaReply falls back to file when image send fails', async (t) => {
  const catalog = createTempStickerCatalog(t, 'feishu-sticker-fallback-');
  const calls = [];

  const result = await sendFeishuMediaReply({
    target: { channel_type: 'group', conversation_id: 'oc-group', source_message_id: 'om-source' },
    media: {
      source: 'sticker_catalog',
      kind: 'sticker',
      stickerId: 'stk_001',
    },
    execFileImpl: async (bin, args, options) => {
      calls.push({ bin, args, options });
      if (args.includes('--image')) {
        throw new Error(`upload failed for ${catalog.filePath}`);
      }
      return { stdout: '{"ok":true}' };
    },
    env: { ...catalog.env, FEISHU_LARK_CLI_BIN: 'lark-cli' },
  });

  assert.equal(result.ok, true);
  assert.equal(result.media_method, 'file');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].args.includes('--image'), true);
  assert.equal(calls[1].args.includes('--file'), true);
  assert.equal(calls[0].args.at(calls[0].args.indexOf('--image') + 1), catalog.fileName);
  assert.equal(calls[1].args.at(calls[1].args.indexOf('--file') + 1), catalog.fileName);
  assert.equal(calls[0].options.cwd, catalog.assetsDir);
  assert.equal(calls[1].options.cwd, catalog.assetsDir);
  assert.equal(JSON.stringify(result).includes(catalog.filePath), false);
});

test('sendFeishuMediaReply returns text-only result without media command when media is absent', async () => {
  const calls = [];

  const result = await sendFeishuMediaReply({
    target: { channel_type: 'dm', sender_id: 'ou-secret' },
    text: '只有文字',
    media: null,
    execFileImpl: async (bin, args) => {
      calls.push({ bin, args });
      return { stdout: '{"ok":true}' };
    },
    env: { FEISHU_LARK_CLI_BIN: 'lark-cli' },
  });

  assert.equal(result.ok, true);
  assert.equal(result.media_sent, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.includes('--text'), true);
  assert.equal(calls[0].args.includes('--image'), false);
  assert.equal(calls[0].args.includes('--file'), false);
});

test('sendFeishuMediaReply sanitizes sticker resolve failures', async (t) => {
  const secretPath = '/private/secret/sticker.png';
  const env = createIsolatedTestEnv(t, {}, 'feishu-sticker-missing-');

  await assert.rejects(
    () => sendFeishuMediaReply({
      target: { channel_type: 'dm', sender_id: 'ou-secret' },
      media: {
        source: 'sticker_catalog',
        kind: 'sticker',
        stickerId: 'stk_missing',
        filePath: secretPath,
      },
      execFileImpl: async () => {
        throw new Error('should not send unresolved sticker');
      },
      env,
    }),
    (error) => {
      assert.equal(String(error.message).includes(secretPath), false);
      assert.match(error.message, /sticker media unavailable/);
      return true;
    }
  );
});

test('handleFeishuEventLine sends media replies through media sender', async (t) => {
  const catalog = createTempStickerCatalog(t, 'feishu-event-sticker-');
  const calls = [];

  {
    const state = createFeishuBridgeState();
    await handleFeishuEventLine(
      '{"schema":"2.0","event":{"message":{"message_id":"om-media-event","chat_id":"oc-media-event","chat_type":"p2p","content":"{\\"text\\":\\"贴纸\\"}"},"sender":{"sender_id":{"open_id":"ou-media-event"}}}}',
      {
        state,
        logger: { log() {}, warn() {}, error() {} },
        env: {
          ...catalog.env,
          FEISHU_LARK_CLI_BIN: 'lark-cli',
          execFileImpl: async (bin, args) => {
            calls.push({ bin, args });
            return { stdout: '{"ok":true}' };
          },
        },
        channelHub: async (normalized, options) => {
          await options.adapter.sendReply({
            target: {
              channel_type: normalized.channel_type,
              conversation_id: normalized.conversation_id,
              sender_id: normalized.sender_id,
            },
            text: '贴纸来了',
            media: {
              source: 'sticker_catalog',
              kind: 'sticker',
              stickerId: 'stk_001',
            },
            message: normalized,
          });
        },
      }
    );

    assert.equal(calls.length, 2);
    assert.equal(calls[0].args.includes('--text'), true);
    assert.equal(calls[1].args.includes('--image'), true);
  }
});

test('handleFeishuEventLine injects the shared outbox and returns a typed receipt for a successful text send', async (t) => {
  const env = createIsolatedTestEnv(t, {}, 'feishu-outbox-entry-');
  const outbox = { name: 'shared-outbox' };
  let receivedOutbox = null;
  let receipt = null;
  await handleFeishuEventLine(
    '{"schema":"2.0","event":{"message":{"message_id":"om-outbox-entry","chat_id":"oc-outbox-entry","chat_type":"p2p","content":"{\\"text\\":\\"hello\\"}"},"sender":{"sender_id":{"open_id":"ou-outbox-entry"}}}}',
    {
      state: createFeishuBridgeState(),
      logger: { log() {}, warn() {}, error() {} },
      env: { ...env, FEISHU_LARK_CLI_BIN: 'lark-cli' },
      outbox,
      execFileImpl: async () => ({ stdout: '{"ok":true}' }),
      channelHub: async (normalized, options) => {
        receivedOutbox = options.outbox;
        receipt = await options.adapter.sendReply({
          target: { conversation_id: normalized.conversation_id, sender_id: normalized.sender_id },
          text: '已送达',
          media: null,
          message: normalized,
        });
      },
    },
  );

  assert.equal(receivedOutbox, outbox);
  assert.equal(receipt.textStatus, 'sent');
  assert.deepEqual(receipt.attachments, []);
  assert.match(receipt.adapterReceiptRef, /^feishu:/);
});

test('Feishu text entry commits timeline and backend ingest only after its real CLI send succeeds', async (t) => {
  const isolated = createIsolatedTestEnv(t, { FEISHU_LARK_CLI_BIN: 'lark-cli' }, 'feishu-outbox-live-');
  const env = { ...isolated, RAN_AGENT_GLOBAL_TIMELINE_PATH: path.join(isolated.RAN_AGENT_STATE_DIR, 'timeline.jsonl') };
  const outbox = createDurableOutbox({ env });
  const ingested = [];
  await handleFeishuEventLine(
    '{"schema":"2.0","event":{"message":{"message_id":"om-outbox-live","chat_id":"oc-outbox-live","chat_type":"p2p","content":"{\\"text\\":\\"hello\\"}"},"sender":{"sender_id":{"open_id":"ou-outbox-live"}}}}',
    {
      state: createFeishuBridgeState(),
      logger: { log() {}, warn() {}, error() {} },
      env,
      outbox,
      execFileImpl: async () => ({ stdout: '{"ok":true}' }),
      channelHub: (message, options) => handleIncomingMessage(message, {
        ...options,
        replyBackend: {
          async getReply(_message, backendOptions) {
            assert.equal(backendOptions.deferIngest, true);
            return {
              replyText: '已送达',
              followUpMessages: [],
              media: null,
              backendProjection: async ({ outboxId }) => ingested.push(outboxId),
            };
          },
        },
      }),
    },
  );

  const [item] = outbox.list();
  assert.equal(item.delivery, 'sent');
  assert.equal(item.timelineProjection, 'committed');
  assert.equal(item.backendProjection, 'committed');
  assert.deepEqual(ingested, [item.outboxId]);
  assert.deepEqual(readTimelineRecords({ timelinePath: env.RAN_AGENT_GLOBAL_TIMELINE_PATH }).map((entry) => entry.role), ['user', 'assistant']);
});

test('Feishu text entry leaves delivery ambiguous and projects nothing when the CLI send faults', async (t) => {
  const isolated = createIsolatedTestEnv(t, { FEISHU_LARK_CLI_BIN: 'lark-cli' }, 'feishu-outbox-fault-');
  const env = { ...isolated, RAN_AGENT_GLOBAL_TIMELINE_PATH: path.join(isolated.RAN_AGENT_STATE_DIR, 'timeline.jsonl') };
  const outbox = createDurableOutbox({ env });
  let ingested = false;
  await assert.rejects(handleFeishuEventLine(
    '{"schema":"2.0","event":{"message":{"message_id":"om-outbox-fault","chat_id":"oc-outbox-fault","chat_type":"p2p","content":"{\\"text\\":\\"hello\\"}"},"sender":{"sender_id":{"open_id":"ou-outbox-fault"}}}}',
    {
      state: createFeishuBridgeState(),
      logger: { log() {}, warn() {}, error() {} },
      env,
      outbox,
      execFileImpl: async () => { throw new Error('cli unavailable'); },
      channelHub: (message, options) => handleIncomingMessage(message, {
        ...options,
        replyBackend: {
          async getReply() {
            return {
              replyText: '不会伪造送达',
              followUpMessages: [],
              media: null,
              backendProjection: async () => { ingested = true; },
            };
          },
        },
      }),
    },
  ));
  await outbox.recover();

  assert.equal(outbox.list()[0].delivery, 'ambiguous');
  assert.equal(outbox.list()[0].timelineProjection, 'pending');
  assert.equal(outbox.list()[0].backendProjection, 'pending');
  assert.equal(ingested, false);
  assert.deepEqual(readTimelineRecords({ timelinePath: env.RAN_AGENT_GLOBAL_TIMELINE_PATH }).map((entry) => entry.role), ['user']);
});

test('handleFeishuEventLine waits for the final reply without a timeout ack race', async (t) => {
  const env = createIsolatedTestEnv(t, {}, 'feishu-quick-ack-');
  let resolveBackend;
  const calls = [];

  {
    const state = createFeishuBridgeState();
    const processing = handleFeishuEventLine(
      '{"schema":"2.0","event":{"message":{"message_id":"om-quick-ack","chat_id":"oc-quick-ack","chat_type":"p2p","content":"{\\"text\\":\\"慢任务\\"}"},"sender":{"sender_id":{"open_id":"ou-quick-ack"}}}}',
      {
        state,
        logger: { log() {}, warn() {}, error() {} },
        env: {
          ...env,
          FEISHU_LARK_CLI_BIN: 'lark-cli',
          NODE_BRIDGE_QUICK_ACK_ENABLED: 'true',
          NODE_BRIDGE_QUICK_ACK_TIMEOUT_MS: '20',
          NODE_BRIDGE_QUICK_ACK_TEXT: '处理中，稍后发结果。',
        },
        execFileImpl: async (bin, args, options) => {
          calls.push({ bin, args, options });
          return { stdout: '{"ok":true}' };
        },
        channelHub: async (normalized, options) => {
          await new Promise((resolve) => {
            resolveBackend = resolve;
          });
          await options.adapter.sendReply({
            target: {
              channel_type: normalized.channel_type,
              conversation_id: normalized.conversation_id,
              sender_id: normalized.sender_id,
            },
            text: '最终结果',
            message: normalized,
          });
        },
      }
    );

    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(calls.length, 0);
    resolveBackend();
    await processing;

    assert.equal(calls.length, 1);
    assert.equal(calls[0].args.includes('最终结果'), true);
    const idempotencyKey = calls[0].args.at(calls[0].args.indexOf('--idempotency-key') + 1);
    assert.match(idempotencyKey, /^ran-agent-feishu-/);
  }
});

test('handleFeishuEventLine downloads inbound image resources and injects save candidates', async (t) => {
  const env = createIsolatedTestEnv(t, {}, 'feishu-inbound-');
  const calls = [];
  let received;

  {
    const state = createFeishuBridgeState();
    await handleFeishuEventLine(
      '{"schema":"2.0","event":{"message":{"message_id":"om-inbound-image","chat_id":"oc-inbound-image","chat_type":"p2p","message_type":"image","content":"{\\"image_key\\":\\"img_v3_secret\\"}"},"sender":{"sender_id":{"open_id":"ou-inbound-image"}}}}',
      {
        state,
        logger: { log() {}, warn() {}, error() {} },
        env: { ...env, FEISHU_LARK_CLI_BIN: 'lark-cli', FEISHU_LARK_CLI_IDENTITY: 'bot' },
        execFileImpl: async (bin, args, options) => {
          calls.push({ bin, args, options });
          fs.writeFileSync(path.join(options.cwd, args.at(args.indexOf('--output') + 1)), Buffer.from([1, 2, 3]));
          return { stdout: 'ok' };
        },
        channelHub: async (normalized) => {
          received = normalized;
        },
      }
    );

    assert.equal(calls[0].bin, 'lark-cli');
    assert.deepEqual(calls[0].args.slice(0, 2), ['im', '+messages-resources-download']);
    assert.equal(calls[0].args.includes('--message-id'), true);
    assert.equal(calls[0].args.at(calls[0].args.indexOf('--message-id') + 1), 'om-inbound-image');
    assert.equal(calls[0].args.at(calls[0].args.indexOf('--file-key') + 1), 'img_v3_secret');
    assert.equal(calls[0].args.at(calls[0].args.indexOf('--type') + 1), 'image');
    assert.equal(calls[0].args.at(calls[0].args.indexOf('--as') + 1), 'bot');
    assert.equal(path.isAbsolute(calls[0].args.at(calls[0].args.indexOf('--output') + 1)), false);
    assert.match(calls[0].options.cwd, /feishu\/inbound$/);
    assert.equal(received.media.length, 1);
    assert.equal(received.media[0].mimeType, 'image/png');
    assert.equal(received.media[0].type, 'image');
    assert.match(received.media[0].filePath, /feishu\/inbound/);
    assert.equal(JSON.stringify(received.raw_event_meta).includes(received.media[0].filePath), false);
  }
});

test('handleFeishuEventLine warns when inbound media download fails without hiding text events', async (t) => {
  const env = createIsolatedTestEnv(t, {}, 'feishu-inbound-fail-');
  const warnings = [];
  let received;

  {
    const state = createFeishuBridgeState();
    await handleFeishuEventLine(
      '{"schema":"2.0","event":{"message":{"message_id":"om-inbound-fail","chat_id":"oc-inbound-fail","chat_type":"p2p","message_type":"file","content":"{\\"file_key\\":\\"file_v3_secret\\",\\"file_name\\":\\"notes.txt\\"}"},"sender":{"sender_id":{"open_id":"ou-inbound-fail"}}}}',
      {
        state,
        logger: { log() {}, warn(message, meta) { warnings.push({ message, meta }); }, error() {} },
        env: { ...env, FEISHU_LARK_CLI_BIN: 'lark-cli' },
        execFileImpl: async () => {
          throw new Error('/private/token/path failed');
        },
        channelHub: async (normalized) => {
          received = normalized;
        },
      }
    );

    assert.deepEqual(received.media, []);
    assert.equal(received.raw_event_meta.media_warnings[0].code, 'FEISHU_MEDIA_DOWNLOAD_FAILED');
    assert.equal(JSON.stringify(received.raw_event_meta).includes('/private/token/path'), false);
    assert.equal(warnings.length, 1);
    assert.equal(JSON.stringify(warnings).includes('/private/token/path'), false);
  }
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
