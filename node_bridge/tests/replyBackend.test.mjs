import test from 'node:test';
import assert from 'node:assert/strict';

import { createReplyBackend, getReplyBackendConfig } from '../src/replyBackend.mjs';

test('getReplyBackendConfig reads reply backend settings', () => {
  const config = getReplyBackendConfig({
    NODE_BRIDGE_FALLBACK_TEXT: 'fallback',
    NODE_BRIDGE_OPENCLAW_REPLY_MODE: 'http',
  });

  assert.equal(config.fallbackText, 'fallback');
  assert.equal(config.openclawReplyMode, 'http');
  assert.equal(getReplyBackendConfig({}).openclawReplyMode, 'agent');
});

test('createReplyBackend uses openclaw chat path', async () => {
  let ingestPayload = null;
  let chatPayload = null;
  const backend = createReplyBackend({
    chatImpl: async (payload) => {
      chatPayload = payload;
      return {
        reply_text: 'openclaw reply',
        follow_up_messages: ['第二条'],
        media: {
          type: 'image',
          url: 'https://example.com/out.png',
        },
        model: 'openclaw/default',
      };
    },
    ingestImpl: async (payload) => {
      ingestPayload = payload;
      return { ok: true };
    },
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

  assert.equal(response.replyText, 'openclaw reply');
  assert.deepEqual(response.followUpMessages, ['第二条']);
  assert.deepEqual(response.media, {
    type: 'image',
    url: 'https://example.com/out.png',
  });
  assert.equal(response.source, 'openclaw');
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

test('createReplyBackend defaults to OpenClaw agent runtime for WeChat replies', async () => {
  let agentPayload = null;
  const backend = createReplyBackend({
    agentImpl: async (payload) => {
      agentPayload = payload;
      return {
        reply_text: '图好了。\n\nWECHAT_MEDIA: {"source":"media_generation_mcp","type":"image","url":"https://example.com/agent-image.png","model":"qwen-image"}',
        follow_up_messages: [],
        media: null,
        model: 'openclaw/agent',
      };
    },
    ingestImpl: async () => ({ ok: true }),
    logger: { log() {}, warn() {} },
  });

  const response = await backend.getReply({
    text: '帮我画一只边牧',
    sender_id: 'conv-agent-runtime',
    channel: 'wechat',
  });

  assert.equal(agentPayload?.sender_id, 'conv-agent-runtime');
  assert.equal(response.replyText, '图好了。');
  assert.deepEqual(response.media, {
    type: 'image',
    url: 'https://example.com/agent-image.png',
  });
});

test('createReplyBackend turns trusted MCP media markers into WeChat image media', async () => {
  const backend = createReplyBackend({
    chatImpl: async () => ({
      reply_text: '图给你了。\n\nWECHAT_MEDIA: {"source":"media_generation_mcp","type":"image","url":"https://example.com/generated-cat.png","model":"qwen-image"}',
      follow_up_messages: [],
      media: null,
      model: 'openclaw/default',
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
    chatImpl: async () => ({
      reply_text: '语音好了。\n\nWECHAT_MEDIA: {"source":"media_generation_mcp","type":"audio","url":"/tmp/wechat-audio.wav","fileName":"wechat-audio.wav","model":"qwen3-omni-flash"}',
      follow_up_messages: [],
      media: null,
      model: 'openclaw/default',
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

test('createReplyBackend does not treat arbitrary markdown images as generated WeChat media', async () => {
  const backend = createReplyBackend({
    chatImpl: async () => ({
      reply_text: '这是外部图片。\n\n![cat](https://image.pollinations.ai/prompt/cat)',
      follow_up_messages: [],
      media: null,
      model: 'openclaw/default',
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
