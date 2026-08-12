import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  InboundMergeCoordinator,
  createExternalMcpRuntimeTransport,
  formatPendingMessagesForReply,
  isTransientWeixinStartError,
  mergeRequests,
  parseCheckinCommand,
  buildAgent,
  isExternalMcpActivityRunnerEnabled,
  redactProxyUrlForLog,
  submitExternalMcpCheckpoint,
  shouldRetryWeixinStartAttempt,
  startExternalMcpActivityRunnerLoop,
} from '../src/index.mjs';
import {
  appendPendingOutboundMessage,
  drainPendingOutboundMessages,
} from '../src/runtimeState.mjs';
import { createDurableOutbox } from '../src/durableOutbox.mjs';
import { createIsolatedTestEnv } from './helpers/isolatedState.mjs';

const INDEX_SOURCE = fs.readFileSync(new URL('../src/index.mjs', import.meta.url), 'utf8');

test('main injects the shared runtime env into the outbound control server', () => {
  assert.match(INDEX_SOURCE, /createOutboundServer\(\{[\s\S]*?bot: proactiveBot, logger: console, env: runtimeEnv, channelHub, coreRuntime,[\s\S]*?\}\)/);
});

test('main creates and recovers one shared durable outbox before wiring live channel entries', () => {
  assert.match(INDEX_SOURCE, /const durableOutbox = createDurableOutbox\(\{ env: runtimeEnv \}\)/);
  assert.match(INDEX_SOURCE, /runtimeEnv\.durableOutbox = durableOutbox/);
  assert.match(INDEX_SOURCE, /await durableOutbox\.recover\(\)/);
  assert.match(INDEX_SOURCE, /const coreRuntime = await openCommittedCoreRuntime\(runtimeEnv\)/);
  assert.match(INDEX_SOURCE, /const channelHub = bindCoreChannelHub\(handleIncomingMessage, coreRuntime\)/);
  assert.match(INDEX_SOURCE, /const coreWorkRuntime = createCoreRuntimeComposition\(\{/);
  assert.match(INDEX_SOURCE, /coreWorkRuntime\?\.start\(\)/);
  assert.match(INDEX_SOURCE, /await coreWorkRuntime\?\.stop\(\)/);
  assert.match(INDEX_SOURCE, /startFeishuBridge\(\{ env: runtimeEnv, logger: console, outbox: durableOutbox, channelHub \}\)/);
  assert.match(INDEX_SOURCE, /startDesktopProxyServer\(\{ env: runtimeEnv, logger: console, outbox: durableOutbox, channelHub \}\)/);
  assert.doesNotMatch(INDEX_SOURCE, /ombreCompatRuntime/);
});

test('S12 quiescence starts only the committed Core worker before reopening ingress', () => {
  assert.match(INDEX_SOURCE, /RAN_AGENT_S12_INGRESS_QUIESCED === 'true'/);
  assert.match(INDEX_SOURCE, /if \(s12IngressQuiesced\) \{[\s\S]*?coreWorkRuntime\.start\(\)[\s\S]*?await coreWorkRuntime\.stop\(\)[\s\S]*?return;/);
  const quiesced = INDEX_SOURCE.indexOf('if (s12IngressQuiesced) {');
  for (const ingress of ['buildAgent({', 'startFeishuBridge({', 'startDesktopProxyServer({', 'startWithRetry(agent']) {
    assert.ok(INDEX_SOURCE.indexOf(ingress, quiesced) > quiesced, `${ingress} must remain after the quiesced return`);
  }
});

test('main starts the v2 external MCP runtime instead of the legacy activity runner loop', () => {
  assert.match(INDEX_SOURCE, /createExternalMcpAutonomyRuntime\(\{\s*env: runtimeEnv,/);
  assert.match(INDEX_SOURCE, /transport: createExternalMcpRuntimeTransport\(\{ env: runtimeEnv \}\)/);
  assert.match(INDEX_SOURCE, /if \(!coreRuntime\) await externalMcpRuntime\.start\(\)/);
  assert.match(INDEX_SOURCE, /submitCandidate: \(candidate, context\) => coreRuntime\s*\? coreExternalMcp\.submitCandidate\(candidate, context\)\s*: submitExternalMcpCheckpoint\(\{/);
  assert.match(INDEX_SOURCE, /coreExternalMcp = createCoreExternalMcpHandler\(\{/);
  assert.match(INDEX_SOURCE, /externalPollHandler: coreExternalMcp\?\.handler/);
  assert.match(INDEX_SOURCE, /externalMcpRuntime\.stop\(\)/);
  assert.doesNotMatch(INDEX_SOURCE, /const activityRunner = startExternalMcpActivityRunnerLoop\(/);
});

test('Core owner attention defaults available without desktop telemetry or a second channel policy', () => {
  assert.match(INDEX_SOURCE, /const attentionValve = createAttentionValve\(\{\s*statePath: path\.join\(resolveStateDir\(runtimeEnv\), 'attention', 'delayed\.json'\),\s*\}\)/);
  assert.doesNotMatch(INDEX_SOURCE, /createDesktopPresenceProvider|presence\.json|\/v1\/presence/i);
  assert.doesNotMatch(INDEX_SOURCE, /telegram/i);
});

test('runtime provider transport forwards only the selected manifest tool call after the bridge has authorized it', async () => {
  let received = null;
  const transport = createExternalMcpRuntimeTransport({
    env: { TEST_ONLY: '1' },
    executor: async (input, options) => {
      received = { input, options };
      return { ok: true, result: { content: [{ type: 'text', text: 'ok' }] } };
    },
  });

  const result = await transport.call({
    manifest: { id: 'configured-safe-mcp', transport: 'streamable-http', url: 'https://mcp.example.test/rpc' },
    toolName: 'advance',
    arguments: { step: 'north' },
    upstreamSessionId: 'bridge-private-upstream-session',
  });
  assert.equal(result.ok, true);
  assert.equal(received.input.toolName, 'advance');
  assert.deepEqual(received.input.arguments, { step: 'north' });
  assert.equal(received.input.upstreamSessionId, 'bridge-private-upstream-session');
  assert.equal(received.options.env.TEST_ONLY, '1');
});

test('runtime provider transport forwards the activity abort signal to the real executor', async () => {
  let received = null;
  const controller = new AbortController();
  const transport = createExternalMcpRuntimeTransport({
    executor: async (_input, options) => {
      received = options;
      return { ok: true };
    },
  });

  await transport.call({
    manifest: { id: 'configured-safe-mcp', transport: 'streamable-http', url: 'https://mcp.example.test/rpc' },
    toolName: 'advance',
    arguments: {},
    signal: controller.signal,
  });

  assert.equal(received.signal, controller.signal);
});

test('external checkpoint uses the reply release gate before one durable outbox delivery', async () => {
  const deliveries = [];
  const result = await submitExternalMcpCheckpoint({
    candidate: { status: 'ready' },
    context: {
      activityId: 'autonomy_checkpoint_1', checkpointDigest: 'a'.repeat(64), revision: 2,
      notifyTarget: { platform: 'feishu', channelType: 'dm', conversationId: 'conversation-1', senderId: 'sender-1' },
    },
    replyBackend: {
      async releaseExternalCheckpoint(input) {
        assert.equal(input.context.activityId, 'autonomy_checkpoint_1');
        return { replyText: 'A verified checkpoint.', suppressSend: false };
      },
    },
    outbox: {
      async deliver(input, options) {
        deliveries.push(input);
        assert.deepEqual(await options.send(), {
          textStatus: 'sent', attachments: [], adapterReceiptRef: 'feishu:checkpoint',
        });
        return { delivery: 'sent' };
      },
    },
    sendFeishu: async () => ({ adapterReceiptRef: 'feishu:checkpoint' }),
  });

  assert.equal(result.delivery, 'sent');
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].operationKey, `external-checkpoint:autonomy_checkpoint_1:${'a'.repeat(64)}`);
});

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

test('buildAgent resolves sticker catalog media to WeChat SDK image payload', async (t) => {
  const isolatedEnv = createIsolatedTestEnv(t, {}, 'wechat-sticker-send-');
  const stateDir = isolatedEnv.RAN_AGENT_STATE_DIR;
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
      ...isolatedEnv,
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

test('buildAgent extracts RAN_MEDIA sticker marker at WeChat SDK boundary', async (t) => {
  const isolatedEnv = createIsolatedTestEnv(t, {}, 'wechat-sticker-marker-');
  const stateDir = isolatedEnv.RAN_AGENT_STATE_DIR;
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
      ...isolatedEnv,
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

test('buildAgent safely drops unresolved sticker media without exposing local paths', async (t) => {
  const logs = [];
  const isolatedEnv = createIsolatedTestEnv(t, {}, 'wechat-sticker-missing-');
  const agent = buildAgent({
    logger: {
      log(...args) { logs.push(args.join(' ')); },
      warn(...args) { logs.push(args.join(' ')); },
      error(...args) { logs.push(args.join(' ')); },
    },
    env: {
      ...isolatedEnv,
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

test('buildAgent routes WeChat follow-ups through the shared outbox as ambiguous when the SDK has no receipt contract', async (t) => {
  const env = createIsolatedTestEnv(t, { NODE_BRIDGE_MERGE_WINDOW_MS: '0', NODE_BRIDGE_FOLLOW_UP_DELAY_MS: '0' }, 'follow-up-outbox-');
  const outbox = createDurableOutbox({ env });
  const sent = [];
  const agent = buildAgent({
    logger: { log() {}, warn() {}, error() {} },
    env: {
      ...env,
      durableOutbox: outbox,
      async handleWeChatTextMessage() {
        return { replyText: '主回复', followUpMessages: ['后续消息'] };
      },
      async sendFollowUpMessages(messages) {
        sent.push(...messages);
      },
    },
  });

  const response = await agent.chat({ text: 'hello', conversationId: 'wx-follow-up' });
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.deepEqual(response, { text: '主回复' });
  assert.deepEqual(sent, ['后续消息']);
  assert.equal(outbox.list().length, 1);
  assert.equal(outbox.list()[0].delivery, 'ambiguous');
  assert.equal(outbox.list()[0].timelineProjection, 'pending');
});

test('buildAgent waits for a durable final reply instead of racing a quick ack', async () => {
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

  let settled = false;
  const resultPromise = agent.chat({
    text: '需要很久',
    conversationId: 'wx-slow-ack',
    media: [{ filePath: '/tmp/test.png', type: 'image', mimeType: 'image/png' }],
  }).then((value) => {
    settled = true;
    return value;
  });
  for (let attempt = 0; attempt < 30 && typeof resolveReply !== 'function'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(typeof resolveReply, 'function');
  assert.equal(settled, false);

  resolveReply({ replyText: '最终结果', followUpMessages: [] });
  const result = await resultPromise;

  assert.deepEqual(result, { text: '最终结果' });
  assert.deepEqual(finalMessages, []);
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

test('buildAgent does not flush pending proactive messages even if legacy proactive delivery is enabled', async (t) => {
  const isolatedEnv = createIsolatedTestEnv(t, {}, 'node-bridge-pending-disabled-');
  const env = {
    ...isolatedEnv,
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
