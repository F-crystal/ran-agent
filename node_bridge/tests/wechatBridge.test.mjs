import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createInboundMessageBuffer,
  handleWeChatTextMessage,
  mapWeChatMessageToBridgeRequest,
  sanitizeReplyText,
  summarizeWeChatRequestShape,
} from '../src/wechatBridge.mjs';
import { createDurableOutbox } from '../src/durableOutbox.mjs';
import { createIsolatedTestEnv, createOwnerBoundTestEnv, registerTestCleanup } from './helpers/isolatedState.mjs';

function ownerEnv(t, senderId, overrides = {}, prefix = 'wechat-owner-') {
  return createOwnerBoundTestEnv(t, { platform: 'wechat', senderId, overrides, prefix });
}

function pngBytes() {
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d,
  ]);
}

test('mapWeChatMessageToBridgeRequest extracts text and conversation id', () => {
  const payload = mapWeChatMessageToBridgeRequest({
    text: '今天有点累',
    conversationId: 'wx-user-1',
  });

  assert.deepEqual(payload, {
    text: '今天有点累',
    sender_id: 'wx-user-1',
    conversation_id: 'wx-user-1',
    channel: 'wechat',
    image_urls: [],
    route_hint: '',
  });
});

test('mapWeChatMessageToBridgeRequest extracts image urls for vision routing', () => {
  const payload = mapWeChatMessageToBridgeRequest({
    text: '',
    imageUrls: ['https://example.com/cat.png'],
    conversationId: 'wx-user-image',
  });

  assert.deepEqual(payload, {
    text: '',
    sender_id: 'wx-user-image',
    conversation_id: 'wx-user-image',
    channel: 'wechat',
    image_urls: ['https://example.com/cat.png'],
    route_hint: 'vision_understand',
  });
});

test('mapWeChatMessageToBridgeRequest extracts nested image fields', () => {
  const payload = mapWeChatMessageToBridgeRequest({
    text: '',
    conversationId: 'wx-user-image-nested',
    media: {
      filePath: '/tmp/from-media.png',
      mimeType: 'image/png',
      type: 'image',
    },
  });

  assert.deepEqual(payload, {
    text: '',
    sender_id: 'wx-user-image-nested',
    conversation_id: 'wx-user-image-nested',
    channel: 'wechat',
    image_urls: [],
    media: [
      {
        filePath: '/tmp/from-media.png',
        mimeType: 'image/png',
        type: 'image',
      },
    ],
    route_hint: 'vision_understand',
  });
});

test('mapWeChatMessageToBridgeRequest preserves merged message batch', () => {
  const payload = mapWeChatMessageToBridgeRequest({
    text: '先说第一句\n第二句',
    conversationId: 'wx-user-batch',
    messageBatch: [
      { index: 1, text: '先说第一句' },
      { index: 2, text: '第二句' },
    ],
  });

  assert.deepEqual(payload.message_batch, [
    { index: 1, text: '先说第一句' },
    { index: 2, text: '第二句' },
  ]);
});

test('mapWeChatMessageToBridgeRequest preserves audio media metadata', () => {
  const payload = mapWeChatMessageToBridgeRequest({
    text: '',
    conversationId: 'wx-user-audio',
    media: {
      filePath: '/tmp/from-media.m4a',
      mimeType: 'audio/mp4',
      type: 'audio',
    },
  });

  assert.deepEqual(payload.media, [
    {
      filePath: '/tmp/from-media.m4a',
      mimeType: 'audio/mp4',
      type: 'audio',
    },
  ]);
  assert.equal(payload.route_hint, '');
});

test('mapWeChatMessageToBridgeRequest treats video media as vision input', () => {
  const payload = mapWeChatMessageToBridgeRequest({
    text: '',
    conversationId: 'wx-user-video',
    media: {
      filePath: '/tmp/from-media.mp4',
      mimeType: 'video/mp4',
      type: 'video',
    },
  });

  assert.deepEqual(payload.media, [
    {
      filePath: '/tmp/from-media.mp4',
      mimeType: 'video/mp4',
      type: 'video',
    },
  ]);
  assert.equal(payload.route_hint, 'vision_understand');
});

test('handleWeChatTextMessage copies Weixin SDK temp inbound media into trusted state dir', async (t) => {
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weixin-agent-media-inbound-'));
  registerTestCleanup(t, () => fs.rmSync(sourceDir, { recursive: true, force: true }));
  const sourcePath = path.join(sourceDir, '1781414034446-9e518805.bin');
  fs.writeFileSync(sourcePath, pngBytes());
  const isolatedEnv = ownerEnv(t, 'wx-user-sdk-media', {}, 'wechat-inbound-');
  const stateDir = isolatedEnv.RAN_AGENT_STATE_DIR;
  let receivedPayload = null;

  const reply = await handleWeChatTextMessage(
    {
      text: '看一下这张图',
      conversationId: 'wx-user-sdk-media',
      media: {
        filePath: sourcePath,
        mimeType: 'image/png',
        type: 'image',
      },
    },
    {
      env: {
        ...isolatedEnv,
        WEIXIN_SDK_INBOUND_MEDIA_DIRS: sourceDir,
      },
      logger: { info() {}, warn() {}, error() {}, log() {} },
      backend: {
        async getReply(payload) {
          receivedPayload = payload;
          return { replyText: '已处理。' };
        },
      },
    }
  );

  assert.equal(reply, '已处理。');
  assert.equal(receivedPayload.media.length, 1);
  const copiedPath = receivedPayload.media[0].filePath;
  assert.notEqual(copiedPath, sourcePath);
  assert.equal(path.dirname(copiedPath), path.join(stateDir, 'wechat', 'inbound'));
  assert.deepEqual(fs.readFileSync(copiedPath), pngBytes());
  assert.equal(receivedPayload.media[0].mimeType, 'image/png');
  assert.equal(receivedPayload.media[0].type, 'image');
});

test('summarizeWeChatRequestShape reports nested candidate paths without content', () => {
  const summary = summarizeWeChatRequestShape({
    text: '',
    conversationId: 'wx-user-shape',
    media: {
      filePath: '/tmp/from-media.png',
      mimeType: 'image/png',
      type: 'image',
    },
  });

  assert.deepEqual(summary.topLevelKeys, ['conversationId', 'media', 'text']);
  assert.deepEqual(summary.nestedObjectKeys.media, ['filePath', 'mimeType', 'type']);
  assert.deepEqual(summary.fieldPresence.filePathPaths, ['request.media.filePath']);
});

test('handleWeChatTextMessage returns python reply text', async (t) => {
  const reply = await handleWeChatTextMessage(
    {
      text: '晚上早点睡',
      conversationId: 'wx-user-2',
    },
    {
      env: ownerEnv(t, 'wx-user-2'),
      fallbackText: 'fallback text',
      logger: {
        info() {},
        warn() {},
        error() {},
      },
      backend: {
        async getReply() {
          return { replyText: '收到。这是本地占位回复：晚上早点睡' };
        },
      },
    }
  );

  assert.equal(reply, '收到。这是本地占位回复：晚上早点睡');
});

test('handleWeChatTextMessage can return structured reply metadata', async (t) => {
  const result = await handleWeChatTextMessage(
    {
      text: '分两条发给我',
      conversationId: 'wx-user-structured',
    },
    {
      env: ownerEnv(t, 'wx-user-structured'),
      returnResult: true,
      logger: {
        info() {},
        warn() {},
        error() {},
      },
      backend: {
        async getReply() {
          return {
            replyText: '第一条',
            followUpMessages: ['第二条'],
            media: {
              type: 'image',
              url: 'https://example.com/out.png',
            },
          };
        },
      },
    }
  );

  assert.deepEqual(result, {
    replyText: '第一条',
    followUpMessages: ['第二条'],
    media: {
      type: 'image',
      url: 'https://example.com/out.png',
    },
  });
});

test('handleWeChatTextMessage injects the shared runtime outbox into the channel path', async () => {
  const outbox = { name: 'shared-outbox' };
  let channelOptions = null;
  const result = await handleWeChatTextMessage({ text: 'hello', conversationId: 'wx-outbox' }, {
    env: { NODE_BRIDGE_SANITIZE_META_LEAK: 'true', durableOutbox: outbox },
    logger: { info() {}, warn() {}, error() {} },
    channelHub: async (_message, options) => {
      channelOptions = options;
      return { replyText: '正常回复', followUpMessages: [], media: null };
    },
    returnResult: true,
  });

  assert.equal(channelOptions.outbox, outbox);
  assert.equal(typeof channelOptions.adapter?.sendReply, 'function');
  assert.deepEqual(
    await channelOptions.adapter.sendReply({ text: '正常回复' }),
    {
      textStatus: 'ambiguous',
      attachments: [],
      adapterReceiptRef: 'wechat:sdk-response-boundary',
    },
  );
  assert.equal(result.replyText, '正常回复');
});

test('WeChat SDK response delivery is durably recorded as ambiguous without a send bypass', async (t) => {
  const env = ownerEnv(t, 'wx-durable', {}, 'wechat-outbox-');
  const outbox = createDurableOutbox({ env });
  const result = await handleWeChatTextMessage({ text: 'hello', conversationId: 'wx-durable' }, {
    env: { ...env, durableOutbox: outbox },
    buffer: createInboundMessageBuffer(),
    logger: { info() {}, warn() {}, error() {}, log() {} },
    backend: {
      async getReply() {
        return { replyText: '等 SDK 发出', followUpMessages: [], media: null };
      },
    },
    returnResult: true,
  });

  assert.equal(result.replyText, '等 SDK 发出');
  assert.equal(outbox.list().length, 1);
  assert.equal(outbox.list()[0].delivery, 'ambiguous');
  assert.equal(outbox.list()[0].timelineProjection, 'pending');
});

test('a valid WeChat inbound fallback is recorded by the outbox instead of escaping through a direct send', async (t) => {
  const env = ownerEnv(t, 'wx-fallback', {}, 'wechat-fallback-outbox-');
  const outbox = createDurableOutbox({ env });
  const reply = await handleWeChatTextMessage({ text: 'hello', conversationId: 'wx-fallback' }, {
    env: { ...env, durableOutbox: outbox },
    buffer: createInboundMessageBuffer(),
    fallbackText: '桥接失败，请稍后再试。',
    logger: { info() {}, warn() {}, error() {}, log() {} },
    backend: { async getReply() { throw new Error('backend unavailable'); } },
  });

  assert.equal(reply, '桥接失败，请稍后再试。');
  assert.equal(outbox.list().length, 1);
  assert.equal(outbox.list()[0].text, reply);
  assert.equal(outbox.list()[0].delivery, 'ambiguous');
  assert.equal(outbox.list()[0].timelineProjection, 'pending');
});

test('a valid WeChat fallback refuses delivery when the runtime outbox is absent', async (t) => {
  let backendCalled = false;
  const reply = await handleWeChatTextMessage({ text: 'hello', conversationId: 'wx-no-outbox' }, {
    env: ownerEnv(t, 'wx-no-outbox'),
    buffer: createInboundMessageBuffer(),
    fallbackText: '桥接失败，请稍后再试。',
    logger: { info() {}, warn() {}, error() {}, log() {} },
    backend: { async getReply() { backendCalled = true; throw new Error('backend unavailable'); } },
  });

  assert.equal(reply, '');
  assert.equal(backendCalled, true);
});

test('handleWeChatTextMessage holds image-only message in buffer', async () => {
  const buffer = createInboundMessageBuffer({ pendingMediaTtlMs: 600000 });
  let backendCalled = false;
  const reply = await handleWeChatTextMessage(
    {
      text: '',
      media: {
        filePath: '/tmp/from-media.png',
        mimeType: 'image/png',
        type: 'image',
      },
      conversationId: 'wx-user-image-only',
    },
    {
      fallbackText: 'fallback text',
      buffer,
      logger: {
        info() {},
        warn() {},
        error() {},
        log() {},
      },
      backend: {
        async getReply() {
          backendCalled = true;
          return { replyText: '这是图片内容。' };
        },
      },
    }
  );

  // Media-only message should be held, not forwarded
  assert.equal(reply, '');
  assert.equal(backendCalled, false);
  const stats = buffer.getStats();
  assert.equal(stats.entries.length, 1);
  assert.equal(stats.entries[0].pendingCount, 1);
  buffer.clear();
});

test('handleWeChatTextMessage merges held image with subsequent text-ref', async (t) => {
  const buffer = createInboundMessageBuffer({ pendingMediaTtlMs: 600000 });
  const env = ownerEnv(t, 'wx-user-merge');
  let receivedPayload;

  // First: image-only (held)
  const holdReply = await handleWeChatTextMessage(
    {
      env,
      text: '',
      media: {
        filePath: '/tmp/from-media.png',
        mimeType: 'image/png',
        type: 'image',
      },
      conversationId: 'wx-user-merge',
    },
    {
      env,
      buffer,
      logger: { info() {}, warn() {}, error() {}, log() {} },
      backend: {
        async getReply(payload) {
          receivedPayload = payload;
          return { replyText: '已分析。' };
        },
      },
    }
  );
  assert.equal(holdReply, '');

  // Then: text-ref (merges with held media)
  const mergeReply = await handleWeChatTextMessage(
    {
      text: '用 mimo 读一下',
      conversationId: 'wx-user-merge',
    },
    {
      env,
      buffer,
      logger: { info() {}, warn() {}, error() {}, log() {} },
      backend: {
        async getReply(payload) {
          receivedPayload = payload;
          return { replyText: '图片内容是...' };
        },
      },
    }
  );

  assert.equal(mergeReply, '图片内容是...');
  assert.ok(receivedPayload.media);
  assert.equal(receivedPayload.media.length, 1);
  assert.equal(receivedPayload.media[0].filePath, '/tmp/from-media.png');
  buffer.clear();
});

test('handleWeChatTextMessage holds audio-only message in buffer', async () => {
  const buffer = createInboundMessageBuffer({ pendingMediaTtlMs: 600000 });
  let backendCalled = false;
  const reply = await handleWeChatTextMessage(
    {
      text: '',
      conversationId: 'wx-user-audio-only',
      media: {
        filePath: '/tmp/from-media.m4a',
        mimeType: 'audio/mp4',
        type: 'audio',
      },
    },
    {
      fallbackText: 'fallback text',
      buffer,
      logger: {
        info() {},
        warn() {},
        error() {},
        log() {},
      },
      backend: {
        async getReply() {
          backendCalled = true;
          return { replyText: '收到音频。' };
        },
      },
    }
  );

  assert.equal(reply, '');
  assert.equal(backendCalled, false);
  buffer.clear();
});

test('handleWeChatTextMessage returns a durably recorded fallback when python call fails', async (t) => {
  const env = ownerEnv(t, 'wx-user-3', {}, 'wechat-python-fallback-');
  const outbox = createDurableOutbox({ env });
  const reply = await handleWeChatTextMessage(
    {
      text: '你好',
      conversationId: 'wx-user-3',
    },
    {
      env: { ...env, durableOutbox: outbox },
      buffer: createInboundMessageBuffer(),
      fallbackText: '桥接失败，请稍后再试。',
      logger: {
        info() {},
        warn() {},
        error() {},
      },
      backend: {
        async getReply() {
          throw new Error('network down');
        },
      },
    }
  );

  assert.equal(reply, '桥接失败，请稍后再试。');
  assert.equal(outbox.list()[0].delivery, 'ambiguous');
});

test('handleWeChatTextMessage ignores fully empty payload', async () => {
  const reply = await handleWeChatTextMessage(
    {
      text: '   ',
      conversationId: 'wx-user-4',
    },
    {
      fallbackText: '桥接失败，请稍后再试。',
      logger: {
        info() {},
        warn() {},
        error() {},
      },
    }
  );

  assert.equal(reply, '暂未收到可处理的消息内容。');
});

test('sanitizeReplyText strips leaked tool payload wrappers', () => {
  const cleaned = sanitizeReplyText(
    '```json\n{"recipient_name":"functions.exec_command","parameters":{"cmd":"ls"}}\n```\n已处理完成。'
  );
  assert.equal(cleaned, '已处理完成。');
});
