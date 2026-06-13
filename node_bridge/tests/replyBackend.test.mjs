import test from 'node:test';
import assert from 'node:assert/strict';

import { createReplyBackend, getReplyBackendConfig } from '../src/replyBackend.mjs';

test('getReplyBackendConfig returns hermes config', () => {
  const config = getReplyBackendConfig({
    NODE_BRIDGE_FALLBACK_TEXT: 'fallback',
  });

  assert.equal(config.replyBackend, 'hermes');
  assert.equal(config.fallbackText, 'fallback');
  assert.equal(getReplyBackendConfig({}).replyBackend, 'hermes');
});

test('createReplyBackend defaults to Hermes reply backend', async () => {
  let ingestPayload = null;
  let hermesPayload = null;
  const backend = createReplyBackend({
    hermesImpl: async (payload) => {
      hermesPayload = payload;
      return {
        reply_text: 'hermes reply',
        follow_up_messages: [],
        media: null,
        model: 'deepseek-v4-flash',
      };
    },
    ingestImpl: async (payload) => {
      ingestPayload = payload;
      return { ok: true };
    },
    logger: { log() {}, warn() {} },
  });

  const response = await backend.getReply({
    text: '你好',
    sender_id: 'conv-hermes-default',
    channel: 'wechat',
  });

  assert.equal(hermesPayload?.sender_id, 'conv-hermes-default');
  assert.equal(ingestPayload?.source, 'hermes');
  assert.equal(response.replyText, 'hermes reply');
  assert.equal(response.source, 'hermes');
});

test('createReplyBackend passes route_hint and media to Hermes', async () => {
  let ingestPayload = null;
  let chatPayload = null;
  const backend = createReplyBackend({
    hermesImpl: async (payload) => {
      chatPayload = payload;
      return {
        reply_text: 'hermes reply',
        follow_up_messages: ['第二条'],
        media: {
          type: 'image',
          url: 'https://example.com/out.png',
        },
        model: 'deepseek-v4-flash',
      };
    },
    ingestImpl: async (payload) => {
      ingestPayload = payload;
      return { ok: true };
    },
    logger: { log() {}, warn() {} },
  });

  const response = await backend.getReply({
    text: '你好',
    sender_id: 'conv-1',
    channel: 'wechat',
    route_hint: 'web_search',
    message_batch: [{ index: 1, text: '你好' }, { index: 2, text: '再补一句' }],
    image_urls: ['https://example.com/cat.png'],
    media: [
      {
        filePath: '/tmp/from-media.png',
        mimeType: 'image/png',
        type: 'image',
      },
    ],
  });

  assert.equal(response.replyText, 'hermes reply');
  assert.deepEqual(response.followUpMessages, ['第二条']);
  assert.deepEqual(response.media, {
    type: 'image',
    url: 'https://example.com/out.png',
  });
  assert.equal(response.source, 'hermes');
  assert.equal(ingestPayload?.source, 'hermes');
  assert.equal(chatPayload?.route_hint, 'web_search');
  assert.deepEqual(chatPayload?.message_batch, [{ index: 1, text: '你好' }, { index: 2, text: '再补一句' }]);
  assert.deepEqual(chatPayload?.media, [
    {
      filePath: '/tmp/from-media.png',
      mimeType: 'image/png',
      type: 'image',
    },
  ]);
  assert.deepEqual(ingestPayload?.image_urls, ['https://example.com/cat.png']);
  assert.deepEqual(ingestPayload?.media, [
    {
      filePath: '/tmp/from-media.png',
      mimeType: 'image/png',
      type: 'image',
    },
  ]);
});

test('createReplyBackend passes inbound media to Hermes', async () => {
  let hermesPayload = null;
  const backend = createReplyBackend({
    hermesImpl: async (payload) => {
      hermesPayload = payload;
      return {
        reply_text: 'MiMo 已分析截图',
        follow_up_messages: [],
        media: null,
        model: 'deepseek-v4-flash',
      };
    },
    ingestImpl: async () => ({ ok: true }),
    logger: { log() {}, warn() {} },
  });

  const response = await backend.getReply({
    text: '帮我用 MiMo 看下这张截图',
    sender_id: 'conv-agent-media',
    channel: 'wechat',
    media: [
      {
        filePath: '/opt/ran_agent/debug/wechat/inbound/screenshot.png',
        mimeType: 'image/png',
        type: 'image',
      },
    ],
  });

  assert.equal(hermesPayload?.sender_id, 'conv-agent-media');
  assert.deepEqual(hermesPayload?.media, [
    {
      filePath: '/opt/ran_agent/debug/wechat/inbound/screenshot.png',
      mimeType: 'image/png',
      type: 'image',
    },
  ]);
  assert.equal(response.replyText, 'MiMo 已分析截图');
});

test('createReplyBackend turns trusted MCP media markers into WeChat image media', async () => {
  const backend = createReplyBackend({
    hermesImpl: async () => ({
      reply_text: '图给你了。\n\nWECHAT_MEDIA: {"source":"media_generation_mcp","type":"image","url":"https://example.com/generated-cat.png","model":"qwen-image"}',
      follow_up_messages: [],
      media: null,
      model: 'deepseek-v4-flash',
    }),
    ingestImpl: async () => ({ ok: true }),
    logger: { log() {}, warn() {} },
  });

  const response = await backend.getReply({
    text: '帮我画一只戴帽子的猫',
    sender_id: 'conv-image-markdown',
    channel: 'wechat',
  });

  assert.equal(response.replyText, '图给你了。');
  assert.deepEqual(response.media, {
    type: 'image',
    url: 'https://example.com/generated-cat.png',
  });
});

test('createReplyBackend turns trusted MCP audio markers into WeChat audio media', async () => {
  const backend = createReplyBackend({
    hermesImpl: async () => ({
      reply_text: '语音好了。\n\nWECHAT_MEDIA: {"source":"media_generation_mcp","type":"audio","url":"/tmp/wechat-audio.wav","fileName":"wechat-audio.wav","model":"qwen3-omni-flash"}',
      follow_up_messages: [],
      media: null,
      model: 'deepseek-v4-flash',
    }),
    ingestImpl: async () => ({ ok: true }),
    logger: { log() {}, warn() {} },
  });

  const response = await backend.getReply({
    text: '请用语音读一句晚上早点休息',
    sender_id: 'conv-audio-marker',
    channel: 'wechat',
  });

  assert.equal(response.replyText, '语音好了。');
  assert.deepEqual(response.media, {
    type: 'audio',
    url: '/tmp/wechat-audio.wav',
    fileName: 'wechat-audio.wav',
  });
});

test('createReplyBackend resolves RAN_MEDIA sticker catalog markers by stickerId', async () => {
  const calls = [];
  const backend = createReplyBackend({
    hermesImpl: async () => ({
      reply_text: '太可爱了\n\nRAN_MEDIA: {"source":"sticker_catalog","kind":"sticker","stickerId":"stk_001","caption":"喜欢"}',
      follow_up_messages: [],
      media: null,
      model: 'deepseek-v4-flash',
    }),
    resolveStickerAssetImpl: (stickerId) => {
      calls.push(stickerId);
      return {
        stickerId,
        tags: ['喜欢'],
        desc: '心动贴纸',
        mime: 'image/png',
        fileName: 'stk_001.png',
        filePath: '/private/server/stickers/assets/stk_001.png',
      };
    },
    ingestImpl: async () => ({ ok: true }),
    logger: { log() {}, warn() {} },
  });

  const response = await backend.getReply({
    text: '发个贴纸',
    sender_id: 'conv-sticker-marker',
    channel: 'wechat',
  });

  assert.deepEqual(calls, ['stk_001']);
  assert.equal(response.replyText, '太可爱了');
  assert.deepEqual(response.media, {
    source: 'sticker_catalog',
    kind: 'sticker',
    stickerId: 'stk_001',
    mime: 'image/png',
    fileName: 'stk_001.png',
    filePath: '/private/server/stickers/assets/stk_001.png',
    caption: '喜欢',
  });
});

test('createReplyBackend uses RAN_MEDIA caption as visible text when marker is the only text', async () => {
  const backend = createReplyBackend({
    hermesImpl: async () => ({
      reply_text: 'RAN_MEDIA: {"source":"sticker_catalog","kind":"sticker","stickerId":"stk_001","caption":"给你一张"}',
      follow_up_messages: [],
      media: null,
      model: 'deepseek-v4-flash',
    }),
    resolveStickerAssetImpl: () => ({
      stickerId: 'stk_001',
      mime: 'image/gif',
      fileName: 'stk_001.gif',
      filePath: '/private/server/stickers/assets/stk_001.gif',
    }),
    ingestImpl: async () => ({ ok: true }),
    logger: { log() {}, warn() {} },
  });

  const response = await backend.getReply({
    text: '贴纸',
    sender_id: 'conv-sticker-caption',
    channel: 'wechat',
  });

  assert.equal(response.replyText, '给你一张');
  assert.equal(response.media.filePath, '/private/server/stickers/assets/stk_001.gif');
});

test('createReplyBackend rejects RAN_MEDIA markers with unknown source', async () => {
  let resolveCalled = false;
  const backend = createReplyBackend({
    hermesImpl: async () => ({
      reply_text: '别显示 marker\nRAN_MEDIA: {"source":"other","kind":"sticker","stickerId":"stk_001"}',
      follow_up_messages: [],
      media: null,
      model: 'deepseek-v4-flash',
    }),
    resolveStickerAssetImpl: () => {
      resolveCalled = true;
      throw new Error('should not resolve unknown source');
    },
    ingestImpl: async () => ({ ok: true }),
    logger: { log() {}, warn() {} },
  });

  const response = await backend.getReply({
    text: '贴纸',
    sender_id: 'conv-sticker-unknown-source',
    channel: 'wechat',
  });

  assert.equal(resolveCalled, false);
  assert.equal(response.replyText, '别显示 marker');
  assert.equal(response.media, null);
});

test('createReplyBackend logs sanitized RAN_MEDIA marker metadata for unsupported kind', async () => {
  let resolveCalled = false;
  const warnings = [];
  const backend = createReplyBackend({
    hermesImpl: async () => ({
      reply_text: '先发文字\nRAN_MEDIA: {"source":"sticker_catalog","kind":"image","stickerId":"stk_001","caption":"测试","note":"用户原文不应进入日志"}',
      follow_up_messages: [],
      media: null,
      model: 'deepseek-v4-flash',
    }),
    resolveStickerAssetImpl: () => {
      resolveCalled = true;
      throw new Error('should not resolve unsupported kind');
    },
    ingestImpl: async () => ({ ok: true }),
    logger: { log() {}, warn(message) { warnings.push(String(message)); } },
  });

  const response = await backend.getReply({
    text: '贴纸',
    sender_id: 'conv-sticker-unsupported-kind',
    channel: 'wechat',
  });

  assert.equal(resolveCalled, false);
  assert.equal(response.replyText, '先发文字');
  assert.equal(response.media, null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /RAN_MEDIA_UNSUPPORTED_KIND/);
  assert.match(warnings[0], /"source":"sticker_catalog"/);
  assert.match(warnings[0], /"kind":"image"/);
  assert.match(warnings[0], /"hasStickerId":true/);
  assert.doesNotMatch(warnings[0], /用户原文不应进入日志/);
});

test('createReplyBackend rejects RAN_MEDIA markers that include path-like fields', async () => {
  let resolveCalled = false;
  const backend = createReplyBackend({
    hermesImpl: async () => ({
      reply_text: '安全起见不发\nRAN_MEDIA: {"source":"sticker_catalog","kind":"sticker","stickerId":"stk_001","filePath":"/private/server/stickers/assets/stk_001.png"}',
      follow_up_messages: [],
      media: null,
      model: 'deepseek-v4-flash',
    }),
    resolveStickerAssetImpl: () => {
      resolveCalled = true;
      throw new Error('should not resolve marker with filePath');
    },
    ingestImpl: async () => ({ ok: true }),
    logger: { log() {}, warn() {} },
  });

  const response = await backend.getReply({
    text: '贴纸',
    sender_id: 'conv-sticker-path-reject',
    channel: 'wechat',
  });

  assert.equal(resolveCalled, false);
  assert.equal(response.replyText, '安全起见不发');
  assert.equal(response.media, null);
});

test('createReplyBackend rejects RAN_MEDIA markers with nested path-like fields', async () => {
  let resolveCalled = false;
  const backend = createReplyBackend({
    hermesImpl: async () => ({
      reply_text: '还是只发文字\nRAN_MEDIA: {"source":"sticker_catalog","kind":"sticker","stickerId":"stk_001","asset":{"url":"https://example.com/sticker.gif"}}',
      follow_up_messages: [],
      media: null,
      model: 'deepseek-v4-flash',
    }),
    resolveStickerAssetImpl: () => {
      resolveCalled = true;
      throw new Error('should not resolve marker with nested url');
    },
    ingestImpl: async () => ({ ok: true }),
    logger: { log() {}, warn() {} },
  });

  const response = await backend.getReply({
    text: '贴纸',
    sender_id: 'conv-sticker-nested-path-reject',
    channel: 'wechat',
  });

  assert.equal(resolveCalled, false);
  assert.equal(response.replyText, '还是只发文字');
  assert.equal(response.media, null);
});

test('createReplyBackend does not treat arbitrary markdown images as generated WeChat media', async () => {
  const backend = createReplyBackend({
    hermesImpl: async () => ({
      reply_text: '这是外部图片。\n\n![cat](https://image.pollinations.ai/prompt/cat)',
      follow_up_messages: [],
      media: null,
      model: 'deepseek-v4-flash',
    }),
    ingestImpl: async () => ({ ok: true }),
    logger: { log() {}, warn() {} },
  });

  const response = await backend.getReply({
    text: '帮我画猫',
    sender_id: 'conv-external-markdown',
    channel: 'wechat',
  });

  assert.equal(response.replyText, '这是外部图片。\n\n![cat](https://image.pollinations.ai/prompt/cat)');
  assert.equal(response.media, null);
});
