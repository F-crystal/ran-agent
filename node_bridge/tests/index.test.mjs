import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  InboundMergeCoordinator,
  formatPendingMessagesForReply,
  isTransientWeixinStartError,
  mergeRequests,
  parseCheckinCommand,
  buildAgent,
  isExternalMcpActivityRunnerEnabled,
  redactProxyUrlForLog,
  shouldRetryWeixinStartAttempt,
  startExternalMcpActivityRunnerLoop,
} from '../src/index.mjs';
import {
  appendPendingOutboundMessage,
  drainPendingOutboundMessages,
} from '../src/runtimeState.mjs';

const PROJECT_ROOT = path.resolve(new URL('../..', import.meta.url).pathname);

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

test('redactProxyUrlForLog removes credentials and query parameters', () => {
  assert.equal(
    redactProxyUrlForLog('http://user:pass@example.com:8080/proxy?token=secret'),
    'http://example.com:8080/proxy?redacted'
  );
  assert.equal(
    redactProxyUrlForLog('socks5://user:pass@127.0.0.1:1080'),
    'socks5://127.0.0.1:1080'
  );
  assert.equal(redactProxyUrlForLog('not a url with secret'), '[configured]');
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
          replyText: '好的，已生成语音。\nWECHAT_MEDIA: {"source":"media_generation_mcp","kind":"speech","type":"audio","url":"/opt/ran_agent/.ran_agent_state/generated/wechat-audio.wav","fileName":"wechat-audio.wav","model":"qwen3-omni-flash"}',
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
      url: '/opt/ran_agent/.ran_agent_state/generated/wechat-audio.wav',
      fileName: 'wechat-audio.wav',
    },
  });
});

test('buildAgent resolves sticker catalog media to WeChat SDK image payload', async () => {
  const stateDir = fs.mkdtempSync(path.join(PROJECT_ROOT, '.ran_agent_state', 'wechat-sticker-send-'));
  const assetsDir = path.join(stateDir, 'stickers', 'assets');
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.writeFileSync(path.join(assetsDir, 'stk_001.png'), 'fake png bytes');
  fs.writeFileSync(path.join(stateDir, 'stickers', 'index.json'), JSON.stringify({
    stk_001: {
      stickerId: 'stk_001',
      fileName: 'stk_001.png',
      mime: 'image/png',
      tags: ['ok'],
      source: 'manual',
    },
  }));
  fs.writeFileSync(path.join(stateDir, 'stickers', 'tags.json'), '{}');
  fs.writeFileSync(path.join(stateDir, 'stickers', 'hashes.json'), '{}');

  const agent = buildAgent({
    logger: { log() {}, warn() {}, error() {} },
    env: {
      RAN_AGENT_STATE_DIR: stateDir,
      NODE_BRIDGE_MERGE_WINDOW_MS: '10',
      async handleWeChatTextMessage() {
        return {
          replyText: '给你一张',
          followUpMessages: [],
          media: {
            source: 'sticker_catalog',
            kind: 'sticker',
            stickerId: 'stk_001',
            mime: 'image/png',
            fileName: 'ignored.png',
            filePath: '/untrusted/ignored.png',
          },
        };
      },
    },
  });

  const result = await agent.chat({
    text: '发个贴纸',
    conversationId: 'wx-sticker',
  });

  assert.deepEqual(result, {
    text: '给你一张',
    media: {
      type: 'image',
      url: path.join(assetsDir, 'stk_001.png'),
      fileName: 'stk_001.png',
    },
  });
});

test('buildAgent extracts RAN_MEDIA sticker marker at WeChat SDK boundary', async () => {
  const stateDir = fs.mkdtempSync(path.join(PROJECT_ROOT, '.ran_agent_state', 'wechat-sticker-marker-'));
  const assetsDir = path.join(stateDir, 'stickers', 'assets');
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.writeFileSync(path.join(assetsDir, 'stk_001.jpg'), 'fake jpg bytes');
  fs.writeFileSync(path.join(stateDir, 'stickers', 'index.json'), JSON.stringify({
    stk_001: {
      stickerId: 'stk_001',
      fileName: 'stk_001.jpg',
      mime: 'image/jpeg',
      tags: ['ok'],
      source: 'manual',
    },
  }));
  fs.writeFileSync(path.join(stateDir, 'stickers', 'tags.json'), '{}');
  fs.writeFileSync(path.join(stateDir, 'stickers', 'hashes.json'), '{}');

  const agent = buildAgent({
    logger: { log() {}, warn() {}, error() {} },
    env: {
      RAN_AGENT_STATE_DIR: stateDir,
      NODE_BRIDGE_MERGE_WINDOW_MS: '10',
      async handleWeChatTextMessage() {
        return {
          replyText: '太可爱了\nRAN_MEDIA: {"source":"sticker_catalog","kind":"sticker","stickerId":"stk_001","caption":"喜欢"}',
          followUpMessages: [],
          media: null,
        };
      },
    },
  });

  const result = await agent.chat({
    text: '发个贴纸',
    conversationId: 'wx-sticker-marker',
  });

  assert.deepEqual(result, {
    text: '太可爱了',
    media: {
      type: 'image',
      url: path.join(assetsDir, 'stk_001.jpg'),
      fileName: 'stk_001.jpg',
    },
  });
});

test('buildAgent safely drops unresolved sticker media without exposing local paths', async () => {
  const logs = [];
  const agent = buildAgent({
    logger: {
      log(...args) { logs.push(args.join(' ')); },
      warn(...args) { logs.push(args.join(' ')); },
      error(...args) { logs.push(args.join(' ')); },
    },
    env: {
      RAN_AGENT_STATE_DIR: fs.mkdtempSync(path.join(PROJECT_ROOT, '.ran_agent_state', 'wechat-sticker-missing-')),
      NODE_BRIDGE_MERGE_WINDOW_MS: '10',
      async handleWeChatTextMessage() {
        return {
          replyText: '只发文字',
          followUpMessages: [],
          media: {
            source: 'sticker_catalog',
            kind: 'sticker',
            stickerId: 'stk_missing',
            mime: 'image/png',
            fileName: 'secret.png',
            filePath: '/private/secret/sticker.png',
          },
        };
      },
    },
  });

  const result = await agent.chat({
    text: '发个不存在的贴纸',
    conversationId: 'wx-sticker-missing',
  });

  assert.deepEqual(result, { text: '只发文字' });
  assert.equal(logs.join('\n').includes('/private/secret/sticker.png'), false);
});

test('buildAgent keeps legacy WECHAT_MEDIA image marker compatible', async () => {
  const agent = buildAgent({
    logger: { log() {}, warn() {}, error() {} },
    env: {
      NODE_BRIDGE_MERGE_WINDOW_MS: '10',
      async handleWeChatTextMessage() {
        return {
          replyText: '图给你了。\nWECHAT_MEDIA: {"source":"media_generation_mcp","type":"image","url":"https://example.com/legacy.png","fileName":"legacy.png"}',
          followUpMessages: [],
          media: null,
        };
      },
    },
  });

  const result = await agent.chat({
    text: '旧图',
    conversationId: 'wx-legacy-image-marker',
  });

  assert.deepEqual(result, {
    text: '图给你了。',
    media: {
      type: 'image',
      url: 'https://example.com/legacy.png',
      fileName: 'legacy.png',
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

test('buildAgent quick-acks slow replies and sends final text asynchronously', async () => {
  let resolveReply;
  const finalMessages = [];
  const agent = buildAgent({
    logger: { log() {}, warn() {}, error() {} },
    env: {
      NODE_BRIDGE_MERGE_WINDOW_MS: '0',
      NODE_BRIDGE_QUICK_ACK_ENABLED: 'true',
      NODE_BRIDGE_QUICK_ACK_TIMEOUT_MS: '20',
      NODE_BRIDGE_QUICK_ACK_TEXT: '处理中，稍后发结果。',
      handleWeChatTextMessage: async () => await new Promise((resolve) => {
        resolveReply = resolve;
      }),
      sendFollowUpMessages: async (messages) => {
        finalMessages.push(...messages);
      },
    },
  });

  const result = await agent.chat({
    text: '需要很久',
    conversationId: 'wx-slow-ack',
  });
  assert.deepEqual(result, { text: '处理中，稍后发结果。' });

  resolveReply({ replyText: '最终结果', followUpMessages: [] });
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.deepEqual(finalMessages, ['最终结果']);
});

test('buildAgent does not quick-ack fast replies', async () => {
  const finalMessages = [];
  const agent = buildAgent({
    logger: { log() {}, warn() {}, error() {} },
    env: {
      NODE_BRIDGE_MERGE_WINDOW_MS: '0',
      NODE_BRIDGE_QUICK_ACK_ENABLED: 'true',
      NODE_BRIDGE_QUICK_ACK_TIMEOUT_MS: '100',
      async handleWeChatTextMessage() {
        return { replyText: '马上好', followUpMessages: [] };
      },
      sendFollowUpMessages: async (messages) => {
        finalMessages.push(...messages);
      },
    },
  });

  const result = await agent.chat({
    text: '快问',
    conversationId: 'wx-fast-no-ack',
  });

  assert.deepEqual(result, { text: '马上好' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(finalMessages, []);
});

test('buildAgent does not flush pending proactive messages even if legacy proactive delivery is enabled', async () => {
  const stateBaseDir = path.join(PROJECT_ROOT, '.ran_agent_state');
  fs.mkdirSync(stateBaseDir, { recursive: true });
  const stateDir = fs.mkdtempSync(path.join(stateBaseDir, 'node-bridge-pending-disabled-'));
  const env = {
    RAN_AGENT_STATE_DIR: stateDir,
    PERSONAL_AGENT_PROACTIVE_ENABLED: 'true',
    NODE_BRIDGE_MERGE_WINDOW_MS: '10',
    async handleWeChatTextMessage() {
      return {
        replyText: '正常回复',
        followUpMessages: [],
      };
    },
    async sendFollowUpMessages() {
      throw new Error('should not send disabled proactive pending messages');
    },
  };
  appendPendingOutboundMessage({
    text: '你刚提到下午要改论文提纲，进展到哪一步了？',
    reason: 'checkin_cooldown_not_reached',
  }, env);
  let followUpSendCalled = false;
  env.sendFollowUpMessages = async () => {
    followUpSendCalled = true;
    throw new Error('should not send disabled proactive pending messages');
  };

  const agent = buildAgent({
    logger: { log() {}, warn() {}, error() {} },
    env,
  });

  const result = await agent.chat({
    text: '你好',
    conversationId: 'wx-pending-disabled',
  });
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.deepEqual(result, { text: '正常回复' });
  assert.equal(followUpSendCalled, false);
  assert.equal(drainPendingOutboundMessages(10, env).length, 1);
});

test('external MCP activity runner loop is gated and delivers through adapter callback', async () => {
  assert.equal(isExternalMcpActivityRunnerEnabled({
    EXTERNAL_MCP_ACTIVITY_RUNNER_ENABLED: 'false',
  }), false);
  assert.equal(isExternalMcpActivityRunnerEnabled({
    HERMES_PROACTIVE_EVENTS_ENABLED: 'false',
    EXTERNAL_MCP_ACTIVITY_RUNNER_ENABLED: 'true',
    EXTERNAL_MCP_SYSTEM_QUEUE_ENABLED: 'true',
    HERMES_PROACTIVE_EXTERNAL_MCP_ENABLED: 'true',
  }), false);
  assert.equal(isExternalMcpActivityRunnerEnabled({
    HERMES_PROACTIVE_EVENTS_ENABLED: 'true',
    EXTERNAL_MCP_ACTIVITY_RUNNER_ENABLED: 'true',
    EXTERNAL_MCP_SYSTEM_QUEUE_ENABLED: 'true',
    HERMES_PROACTIVE_EXTERNAL_MCP_ENABLED: 'true',
  }), true);

  let invoked = 0;
  const sent = [];
  const loop = startExternalMcpActivityRunnerLoop({
    env: {
      HERMES_PROACTIVE_EVENTS_ENABLED: 'true',
      EXTERNAL_MCP_ACTIVITY_RUNNER_ENABLED: 'true',
      EXTERNAL_MCP_SYSTEM_QUEUE_ENABLED: 'true',
      HERMES_PROACTIVE_EXTERNAL_MCP_ENABLED: 'true',
    },
    logger: { warn() {}, log() {} },
    intervalMs: 10_000,
    runDueImpl: async ({ sendText }) => {
      invoked += 1;
      await sendText({ platform: 'wechat' }, 'done');
      return { processed: 1, sent: 1 };
    },
    sendText: async (target, text) => {
      sent.push({ target, text });
    },
  });

  await loop.tick();
  loop.stop();

  assert.equal(invoked, 1);
  assert.deepEqual(sent, [{ target: { platform: 'wechat' }, text: 'done' }]);
});
