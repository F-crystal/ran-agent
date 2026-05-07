import test from 'node:test';
import assert from 'node:assert/strict';

import {
  InboundMergeCoordinator,
  formatPendingMessagesForReply,
  isTransientWeixinStartError,
  mergeRequests,
  parseCheckinCommand,
  buildAgent,
  shouldRetryWeixinStartAttempt,
} from '../src/index.mjs';

test('shouldRetryWeixinStartAttempt treats non-positive max retries as infinite', () => {
  assert.equal(shouldRetryWeixinStartAttempt(1, 0), true);
  assert.equal(shouldRetryWeixinStartAttempt(50, 0), true);
  assert.equal(shouldRetryWeixinStartAttempt(1, -1), true);
});

test('shouldRetryWeixinStartAttempt enforces bounded retries when max retries is positive', () => {
  assert.equal(shouldRetryWeixinStartAttempt(1, 2), true);
  assert.equal(shouldRetryWeixinStartAttempt(2, 2), true);
  assert.equal(shouldRetryWeixinStartAttempt(3, 2), false);
});

test('isTransientWeixinStartError matches common TLS/network fetch failure signals', () => {
  assert.equal(isTransientWeixinStartError(new Error('TypeError: fetch failed')), true);
  assert.equal(isTransientWeixinStartError(new Error('ECONNRESET by peer')), true);
  assert.equal(isTransientWeixinStartError(new Error('SSL handshake failed')), true);
  assert.equal(isTransientWeixinStartError(new Error('invalid token')), false);
});

test('parseCheckinCommand validates command shape', () => {
  assert.deepEqual(parseCheckinCommand('/checkin 20 90'), { minMinutes: 20, maxMinutes: 90 });
  assert.match(parseCheckinCommand('/checkin a 90').error, /参数必须是数字/);
  assert.equal(parseCheckinCommand('hello'), null);
});

test('mergeRequests combines fragmented user text into one request', () => {
  const merged = mergeRequests([
    { text: '我先去拿快递', conversationId: 'wx-1', imageUrls: [] },
    { text: '然后 20 分钟后回来', conversationId: 'wx-1', imageUrls: [] },
  ]);
  assert.equal(merged.text, '我先去拿快递\n然后 20 分钟后回来');
  assert.equal(merged.conversationId, 'wx-1');
  assert.deepEqual(merged.messageBatch, [
    { index: 1, text: '我先去拿快递' },
    { index: 2, text: '然后 20 分钟后回来' },
  ]);
});

test('mergeRequests preserves structured media across merged items', () => {
  const merged = mergeRequests([
    {
      text: '',
      conversationId: 'wx-2',
      imageUrls: [],
      media: [
        {
          filePath: '/tmp/old.png',
          mimeType: 'image/png',
          type: 'image',
        },
      ],
    },
    {
      text: '',
      conversationId: 'wx-2',
      imageUrls: [],
      media: [
        {
          filePath: '/tmp/new.m4a',
          mimeType: 'audio/mp4',
          type: 'audio',
        },
      ],
    },
  ]);

  assert.deepEqual(merged.media, [
    {
      filePath: '/tmp/old.png',
      mimeType: 'image/png',
      type: 'image',
    },
    {
      filePath: '/tmp/new.m4a',
      mimeType: 'audio/mp4',
      type: 'audio',
    },
  ]);
});

test('InboundMergeCoordinator flushes media requests immediately', async () => {
  const coordinator = new InboundMergeCoordinator({ windowMs: 200 });
  let mergedRequest = null;

  const handler = async (request) => {
    mergedRequest = request;
    return { text: 'ok' };
  };

  const first = coordinator.enqueue(
    { text: '先说一句', conversationId: 'wx-media-flush' },
    handler
  );
  const second = coordinator.enqueue(
    {
      text: '',
      conversationId: 'wx-media-flush',
      media: [
        {
          filePath: '/tmp/from-media.png',
          mimeType: 'image/png',
          type: 'image',
        },
      ],
    },
    handler
  );

  const timeout = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('media flush timed out')), 500);
  });

  const [firstResult, secondResult] = await Promise.race([Promise.all([first, second]), timeout]);

  assert.match(String(firstResult.text || ''), /已合并/);
  assert.deepEqual(secondResult, { text: 'ok' });
  assert.equal(mergedRequest.text, '先说一句');
  assert.deepEqual(mergedRequest.media, [
    {
      filePath: '/tmp/from-media.png',
      mimeType: 'image/png',
      type: 'image',
    },
  ]);
});

test('buildAgent returns structured media response without breaking text replies', async () => {
  const agent = buildAgent({
    logger: { log() {}, warn() {}, error() {} },
    env: {
      NODE_BRIDGE_MERGE_WINDOW_MS: '10',
      async handleWeChatTextMessage() {
        return {
          replyText: '图给你了',
          followUpMessages: [],
          media: {
            type: 'image',
            url: 'https://example.com/out.png',
          },
        };
      },
    },
  });

  const result = await agent.chat({
    text: '给我来张图',
    conversationId: 'wx-media',
  });

  assert.deepEqual(result, {
    text: '图给你了',
    media: {
      type: 'image',
      url: 'https://example.com/out.png',
    },
  });
});

test('buildAgent maps generated audio replies to SDK-compatible file media', async () => {
  let structuredSendCount = 0;
  const agent = buildAgent({
    logger: { log() {}, warn() {}, error() {} },
    env: {
      NODE_BRIDGE_MERGE_WINDOW_MS: '10',
      async handleWeChatTextMessage() {
        return {
          replyText: '语音好了',
          followUpMessages: [],
          media: {
            type: 'audio',
            url: '/tmp/reply.wav',
            fileName: 'reply.wav',
          },
        };
      },
      async sendStructuredMessage() {
        structuredSendCount += 1;
      },
    },
  });

  const result = await agent.chat({
    text: '/speak hi',
    conversationId: 'wx-audio',
  });

  assert.equal(structuredSendCount, 0);
  assert.deepEqual(result, {
    text: '语音好了',
    media: {
      type: 'file',
      url: '/tmp/reply.wav',
      fileName: 'reply.wav',
    },
  });
});

test('buildAgent extracts trusted audio media marker at WeChat SDK boundary', async () => {
  const agent = buildAgent({
    logger: { log() {}, warn() {}, error() {} },
    env: {
      NODE_BRIDGE_MERGE_WINDOW_MS: '10',
      async handleWeChatTextMessage() {
        return {
          replyText: '好的，已生成语音。\nWECHAT_MEDIA: {"source":"media_generation_mcp","kind":"speech","type":"audio","url":"/opt/ran_agent/.openclaw_state/generated/wechat-audio.wav","fileName":"wechat-audio.wav","model":"qwen3-omni-flash"}',
          followUpMessages: [],
          media: null,
        };
      },
    },
  });

  const result = await agent.chat({
    text: '生成语音',
    conversationId: 'wx-audio-marker-boundary',
  });

  assert.deepEqual(result, {
    text: '好的，已生成语音。',
    media: {
      type: 'file',
      url: '/opt/ran_agent/.openclaw_state/generated/wechat-audio.wav',
      fileName: 'wechat-audio.wav',
    },
  });
});

test('buildAgent keeps paragraph-separated replies in the synchronous response', async () => {
  let followUps = null;
  const agent = buildAgent({
    logger: { log() {}, warn() {}, error() {} },
    env: {
      NODE_BRIDGE_MERGE_WINDOW_MS: '10',
      NODE_BRIDGE_FOLLOW_UP_DELAY_MS: '0',
      async handleWeChatTextMessage() {
        return {
          replyText: '第一段\n\n第二段\n\n第三段',
          followUpMessages: [],
        };
      },
      async sendFollowUpMessages(messages) {
        followUps = messages;
      },
    },
  });

  const result = await agent.chat({
    text: '分段回复',
    conversationId: 'wx-segmented',
  });

  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.deepEqual(result, { text: '第一段\n\n第二段\n\n第三段' });
  assert.deepEqual(followUps, null);
});
