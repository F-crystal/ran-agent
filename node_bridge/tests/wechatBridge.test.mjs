import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createInboundMessageBuffer,
  handleWeChatTextMessage,
  mapWeChatMessageToBridgeRequest,
  sanitizeReplyText,
  summarizeWeChatRequestShape,
} from '../src/wechatBridge.mjs';

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

test('handleWeChatTextMessage returns python reply text', async () => {
  const reply = await handleWeChatTextMessage(
    {
      text: '晚上早点睡',
      conversationId: 'wx-user-2',
    },
    {
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

test('handleWeChatTextMessage can return structured reply metadata', async () => {
  const result = await handleWeChatTextMessage(
    {
      text: '分两条发给我',
      conversationId: 'wx-user-structured',
    },
    {
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

test('handleWeChatTextMessage merges held image with subsequent text-ref', async () => {
  const buffer = createInboundMessageBuffer({ pendingMediaTtlMs: 600000 });
  let receivedPayload;

  // First: image-only (held)
  const holdReply = await handleWeChatTextMessage(
    {
      text: '',
      media: {
        filePath: '/tmp/from-media.png',
        mimeType: 'image/png',
        type: 'image',
      },
      conversationId: 'wx-user-merge',
    },
    {
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

test('handleWeChatTextMessage returns fallback when python call fails', async () => {
  const reply = await handleWeChatTextMessage(
    {
      text: '你好',
      conversationId: 'wx-user-3',
    },
    {
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

  assert.equal(reply, '我暂时还没收到可处理的消息内容。');
});

test('sanitizeReplyText strips leaked tool payload wrappers', () => {
  const cleaned = sanitizeReplyText(
    '```json\n{"recipient_name":"functions.exec_command","parameters":{"cmd":"ls"}}\n```\n已处理完成。'
  );
  assert.equal(cleaned, '已处理完成。');
});
