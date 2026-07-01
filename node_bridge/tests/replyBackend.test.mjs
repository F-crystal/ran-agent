import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createReplyBackend, getReplyBackendConfig } from '../src/replyBackend.mjs';
import {
  getTrustedExternalMcpActivityGrant,
  startExternalMcpActivity,
} from '../src/externalMcp/activityRunner.mjs';
import { getEnvironmentPrivacyMode } from '../src/environmentSense.mjs';
import { createPendingAction, listPendingActions } from '../src/pendingActionState.mjs';
import { listStickers, saveStickersFromInbox } from '../src/stickerCatalog.mjs';

function tempStateEnv(extra = {}) {
  const base = path.join(process.cwd(), '.ran_agent_state', 'test-reply-pending');
  fs.mkdirSync(base, { recursive: true });
  return {
    RAN_AGENT_STATE_DIR: fs.mkdtempSync(path.join(base, 'case-')),
    HERMES_ACTION_GATE_ENABLED: 'true',
    HERMES_ACTION_GATE_MODE: 'repair',
    HERMES_ACTION_PENDING_ENABLED: 'true',
    HERMES_ACTION_PENDING_TTL_MINUTES: '30',
    ...extra,
  };
}

function pngBytes() {
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d,
  ]);
}

function writeTrustedInboxFile(env, name = 'candidate.png') {
  const inboxDir = path.join(env.RAN_AGENT_STATE_DIR, 'wechat', 'inbound');
  fs.mkdirSync(inboxDir, { recursive: true });
  const filePath = path.join(inboxDir, name);
  fs.writeFileSync(filePath, pngBytes());
  env.STICKER_INBOX_ALLOWED_DIRS = inboxDir;
  env.STICKER_CATALOG_ALLOW_RUNTIME_SAVE = 'true';
  return filePath;
}

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

test('createReplyBackend suppresses silent external MCP synthetic turns', async () => {
  const backend = createReplyBackend({
    env: {
      HERMES_ACTION_GATE_ENABLED: 'true',
      HERMES_ACTION_GATE_MODE: 'observe',
    },
    hermesImpl: async () => ({
      reply_text: 'silent',
      follow_up_messages: [],
      media: null,
    }),
    ingestImpl: async () => ({ ok: true }),
    logger: { log() {}, warn() {} },
  });

  const response = await backend.getReply({
    text: 'system wake',
    sender_id: 'conv-silent',
    conversation_id: 'conv-silent',
    channel: 'feishu',
    route_hint: 'external_mcp_system_queue',
  });

  assert.equal(response.replyText, '');
  assert.equal(response.suppressSend, true);
  assert.equal(response.suppressReason, 'silent');
});

test('createReplyBackend suppresses remember external MCP synthetic turns without sending JSON', async () => {
  const backend = createReplyBackend({
    env: {
      HERMES_ACTION_GATE_ENABLED: 'true',
      HERMES_ACTION_GATE_MODE: 'observe',
    },
    hermesImpl: async () => ({
      reply_text: '{"action":"remember","note":"quietly store this"}',
      follow_up_messages: [],
      media: null,
    }),
    ingestImpl: async () => ({ ok: true }),
    logger: { log() {}, warn() {} },
  });

  const response = await backend.getReply({
    text: 'system wake',
    sender_id: 'conv-remember',
    conversation_id: 'conv-remember',
    channel: 'feishu',
    route_hint: 'external_mcp_system_queue',
  });

  assert.equal(response.replyText, '');
  assert.equal(response.suppressSend, true);
  assert.equal(response.suppressReason, 'remember');
});

test('createReplyBackend does not suppress literal silent in normal chat', async () => {
  const backend = createReplyBackend({
    env: {
      HERMES_ACTION_GATE_ENABLED: 'true',
      HERMES_ACTION_GATE_MODE: 'observe',
    },
    hermesImpl: async () => ({
      reply_text: 'silent',
      follow_up_messages: [],
      media: null,
    }),
    ingestImpl: async () => ({ ok: true }),
    logger: { log() {}, warn() {} },
  });

  const response = await backend.getReply({
    text: 'say silent',
    sender_id: 'conv-normal-silent',
    conversation_id: 'conv-normal-silent',
    channel: 'feishu',
  });

  assert.equal(response.replyText, 'silent');
  assert.equal(response.suppressSend, false);
});

test('createReplyBackend forwards stale continuity context to Hermes', async () => {
  let hermesPayload = null;
  const backend = createReplyBackend({
    hermesImpl: async (payload) => {
      hermesPayload = payload;
      return {
        reply_text: 'ok',
        follow_up_messages: [],
        media: null,
      };
    },
    ingestImpl: async () => ({ ok: true }),
    logger: { log() {}, warn() {} },
  });

  await backend.getReply({
    text: '今天天气不错',
    sender_id: 'conv-stale-context',
    conversation_id: 'conv-stale-context',
    channel: 'wechat',
    stale_context: '我换了新电脑，正在迁移资料',
  });

  assert.equal(hermesPayload?.stale_context, '我换了新电脑，正在迁移资料');
});

test('createReplyBackend handles explicit environment privacy mode toggles before Hermes', async () => {
  const env = tempStateEnv({ HERMES_ENVIRONMENT_CONTEXT_ENABLED: 'true' });
  let hermesCalled = false;
  const backend = createReplyBackend({
    env,
    hermesImpl: async () => {
      hermesCalled = true;
      return { reply_text: 'should not call hermes', follow_up_messages: [], media: null };
    },
    ingestImpl: async () => ({ ok: true }),
    logger: { log() {}, warn() {} },
  });

  const enabled = await backend.getReply({
    text: '打开隐私模式',
    sender_id: 'conv-env-privacy',
    conversation_id: 'conv-env-privacy',
    channel: 'wechat',
  });

  assert.equal(hermesCalled, false);
  assert.match(enabled.replyText, /隐私模式已打开/);
  assert.equal(getEnvironmentPrivacyMode(env).enabled, true);

  const disabled = await backend.getReply({
    text: '恢复环境感知',
    sender_id: 'conv-env-privacy',
    conversation_id: 'conv-env-privacy',
    channel: 'wechat',
  });

  assert.match(disabled.replyText, /环境感知已恢复/);
  assert.equal(getEnvironmentPrivacyMode(env).enabled, false);
});

test('createReplyBackend stops external MCP activities by global user before asking Hermes to summarize', async () => {
  const env = tempStateEnv();
  const activity = startExternalMcpActivity({
    globalUserId: 'user:ran',
    serverId: 'cedartoy-games',
    kind: 'game_play',
    now: '2026-07-02T10:00:00Z',
  }, { env });
  let hermesPayload = null;
  const backend = createReplyBackend({
    env,
    hermesImpl: async (payload) => {
      hermesPayload = payload;
      return {
        reply_text: '好，我已经停下这局了。',
        follow_up_messages: [],
        media: null,
      };
    },
    ingestImpl: async () => ({ ok: true }),
    nowImpl: () => new Date('2026-07-02T10:05:00Z'),
    logger: { log() {}, warn() {} },
  });

  const response = await backend.getReply({
    text: '停下这局',
    sender_id: 'conv-stop-mcp',
    conversation_id: 'conv-stop-mcp',
    channel: 'wechat',
    platform: 'wechat',
    global_user_id: 'user:ran',
  });

  assert.equal(response.replyText, '好，我已经停下这局了。');
  assert.equal(hermesPayload.route_hint, 'external_mcp_stop');
  assert.match(hermesPayload.text, /stopped_activity_ids:/);
  assert.match(hermesPayload.text, new RegExp(activity.activityId));
  assert.equal(getTrustedExternalMcpActivityGrant(activity.activityId, {
    env,
    globalUserId: 'user:ran',
    serverId: 'cedartoy-games',
    now: '2026-07-02T10:06:00Z',
  }), null);
});

test('createReplyBackend logs action contract telemetry in observe mode without changing reply', async () => {
  const logs = [];
  const backend = createReplyBackend({
    env: {
      HERMES_ACTION_GATE_ENABLED: 'true',
      HERMES_ACTION_GATE_MODE: 'observe',
      HERMES_ACTION_GATE_MAX_REPAIR_ATTEMPTS: '1',
    },
    hermesImpl: async () => ({
      reply_text: '我读到了，这篇小红书主要说旅行。',
      follow_up_messages: [],
      media: null,
      model: 'deepseek-v4-flash',
    }),
    ingestImpl: async () => ({ ok: true }),
    logger: { log(message) { logs.push(String(message)); }, warn() {} },
  });

  const response = await backend.getReply({
    text: '帮我读一下 http://xhslink.com/o/abc123',
    sender_id: 'conv-action-contract',
    conversation_id: 'conv-action-contract',
    channel: 'wechat',
  }, { requestId: 'req-action-contract' });

  assert.equal(response.replyText, '我读到了，这篇小红书主要说旅行。');
  const line = logs.find((item) => item.startsWith('[hermes-action-contract] '));
  assert.ok(line, 'expected action contract log line');
  const payload = JSON.parse(line.replace('[hermes-action-contract] ', ''));
  assert.equal(payload.request_id, 'req-action-contract');
  assert.equal(payload.channel, 'wechat');
  assert.match(payload.conversation_id_hash, /^[a-f0-9]{16}$/);
  assert.equal(payload.gate_mode, 'observe');
  assert.equal(payload.intent, 'social_read');
  assert.deepEqual(payload.required_evidence, ['tool_result']);
  assert.deepEqual(payload.observed_evidence, []);
  assert.deepEqual(payload.final_claims, ['read_complete']);
  assert.equal(payload.gate_decision, 'observe_only');
  assert.equal(payload.evidence_satisfied, false);
  assert.deepEqual(payload.missing_evidence, ['tool_result']);
  assert.equal(payload.repair_attempted, false);
  assert.equal(payload.final_action, 'observe_only');
  assert.equal(line.includes('abc123'), false);
  assert.equal(line.includes('旅行'), false);
});

test('createReplyBackend enforces safe rewrite before returning unsupported social read claims', async () => {
  const logs = [];
  const backend = createReplyBackend({
    env: {
      HERMES_ACTION_GATE_ENABLED: 'true',
      HERMES_ACTION_GATE_MODE: 'enforce',
      HERMES_ACTION_GATE_MAX_REPAIR_ATTEMPTS: '1',
    },
    hermesImpl: async () => ({
      reply_text: '我已经完整读完了，这篇小红书主要说旅行。',
      follow_up_messages: [],
      media: null,
      model: 'deepseek-v4-flash',
    }),
    ingestImpl: async () => ({ ok: true }),
    logger: { log(message) { logs.push(String(message)); }, warn() {} },
  });

  const response = await backend.getReply({
    text: '帮我读一下 http://xhslink.com/o/abc123',
    sender_id: 'conv-action-enforce',
    conversation_id: 'conv-action-enforce',
    channel: 'wechat',
  }, { requestId: 'req-action-enforce' });

  assert.equal(response.replyText, '我现在还没有成功读取到这个链接的内容，所以不能直接判断里面写了什么。可以再试一次，或者你把截图/正文发我。');
  const line = logs.find((item) => item.startsWith('[hermes-action-contract] '));
  assert.ok(line, 'expected action contract log line');
  const payload = JSON.parse(line.replace('[hermes-action-contract] ', ''));
  assert.equal(payload.gate_mode, 'enforce');
  assert.equal(payload.gate_decision, 'rewrite');
  assert.equal(payload.final_action, 'safe_rewrite');
  assert.equal(payload.rewrite_reason, 'missing_required_evidence');
  assert.deepEqual(payload.original_claim_types, ['read_complete']);
  assert.equal(line.includes('abc123'), false);
  assert.equal(line.includes('旅行'), false);
});

test('createReplyBackend repair mode repairs social read evidence once and keeps repaired reply', async () => {
  const logs = [];
  const repairCalls = [];
  const backend = createReplyBackend({
    env: {
      HERMES_ACTION_GATE_ENABLED: 'true',
      HERMES_ACTION_GATE_MODE: 'repair',
      HERMES_ACTION_GATE_MAX_REPAIR_ATTEMPTS: '1',
    },
    hermesImpl: async () => ({
      reply_text: '我已经完整读完了，这篇小红书主要说旅行。',
      follow_up_messages: [],
      media: null,
      model: 'deepseek-v4-flash',
    }),
    actionRepairImpl: async (plan) => {
      repairCalls.push(plan);
      return {
        ok: true,
        status: 'success',
        repairedReply: '我现在读取到了这个链接内容：它在讲旅行规划。',
        toolResult: {
          toolName: 'mcp_social_reader_read_social_post_deep',
          ok: true,
          artifact_id: 'social-artifact-private',
        },
      };
    },
    ingestImpl: async () => ({ ok: true }),
    logger: { log(message) { logs.push(String(message)); }, warn() {} },
  });

  const response = await backend.getReply({
    text: '帮我读一下 http://xhslink.com/o/abc123',
    sender_id: 'conv-action-repair-social',
    conversation_id: 'conv-action-repair-social',
    channel: 'wechat',
  }, { requestId: 'req-action-repair-social' });

  assert.equal(repairCalls.length, 1);
  assert.equal(repairCalls[0].repairType, 'social_read');
  assert.equal(response.replyText, '我现在读取到了这个链接内容：它在讲旅行规划。');
  const line = logs.find((item) => item.startsWith('[hermes-action-contract] '));
  const payload = JSON.parse(line.replace('[hermes-action-contract] ', ''));
  assert.equal(payload.gate_mode, 'repair');
  assert.equal(payload.repair_attempted, true);
  assert.equal(payload.repair_type, 'social_read');
  assert.equal(payload.repair_status, 'success');
  assert.equal(payload.final_action, 'repair_success');
  assert.equal(payload.evidence_satisfied, true);
  assert.equal(line.includes('abc123'), false);
  assert.equal(line.includes('social-artifact-private'), false);
});

test('createReplyBackend repair mode can repair social claims returned through Hermes gateway client', async () => {
  const repairCalls = [];
  const backend = createReplyBackend({
    env: {
      HERMES_API_BASE_URL: 'http://127.0.0.1:8642/v1',
      HERMES_API_KEY: 'token',
      HERMES_REPLY_MODE: 'api',
      HERMES_ACTION_GATE_ENABLED: 'true',
      HERMES_ACTION_GATE_MODE: 'repair',
      HERMES_ACTION_GATE_MAX_REPAIR_ATTEMPTS: '1',
      XHS_TOKEN_CACHE_PATH: '/tmp/missing-xhs-cache-for-repair-gateway.json',
      RAN_AGENT_CONTEXT_SIZE_LOG: '0',
    },
    actionRepairImpl: async (plan) => {
      repairCalls.push(plan);
      return {
        ok: true,
        status: 'success',
        repairedReply: '我现在读取到了这个链接内容：它在讲旅行规划。',
        toolResult: {
          toolName: 'mcp_social_reader_read_social_post_deep',
          ok: true,
          artifact_id: 'social-artifact-private',
        },
      };
    },
    ingestImpl: async () => ({ ok: true }),
    logger: { log() {}, warn() {} },
  });

  const response = await backend.getReply({
    text: '帮我读一下 http://xhslink.com/o/abc123',
    sender_id: 'conv-action-repair-social-gateway',
    conversation_id: 'conv-action-repair-social-gateway',
    channel: 'wechat',
  }, {
    requestId: 'req-action-repair-social-gateway',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async json() {
        return { choices: [{ message: { content: '我已经完整读完了，这篇小红书主要说旅行。' } }] };
      },
      async text() {
        return '';
      },
    }),
  });

  assert.equal(repairCalls.length, 1);
  assert.equal(repairCalls[0].repairType, 'social_read');
  assert.equal(response.replyText, '我现在读取到了这个链接内容：它在讲旅行规划。');
});

test('createReplyBackend repair mode safe rewrites when social repair fails', async () => {
  const logs = [];
  const backend = createReplyBackend({
    env: {
      HERMES_ACTION_GATE_ENABLED: 'true',
      HERMES_ACTION_GATE_MODE: 'repair',
      HERMES_ACTION_GATE_MAX_REPAIR_ATTEMPTS: '1',
    },
    hermesImpl: async () => ({
      reply_text: '我已经完整读完了，这篇小红书主要说旅行。',
      follow_up_messages: [],
      media: null,
      model: 'deepseek-v4-flash',
    }),
    actionRepairImpl: async () => ({ ok: false, status: 'failed', error_code: 'READER_FAILED' }),
    ingestImpl: async () => ({ ok: true }),
    logger: { log(message) { logs.push(String(message)); }, warn() {} },
  });

  const response = await backend.getReply({
    text: '帮我读一下 http://xhslink.com/o/abc123',
    sender_id: 'conv-action-repair-social-fail',
    channel: 'wechat',
  }, { requestId: 'req-action-repair-social-fail' });

  assert.equal(response.replyText, '我现在还没有成功读取到这个链接的内容，所以不能直接判断里面写了什么。可以再试一次，或者你把截图/正文发我。');
  const line = logs.find((item) => item.startsWith('[hermes-action-contract] '));
  const payload = JSON.parse(line.replace('[hermes-action-contract] ', ''));
  assert.equal(payload.repair_attempted, true);
  assert.equal(payload.repair_status, 'failed');
  assert.equal(payload.repair_error_code, 'READER_FAILED');
  assert.equal(payload.final_action, 'repair_failed_safe_rewrite');
});

test('createReplyBackend repair mode keeps partial social repair honest', async () => {
  const backend = createReplyBackend({
    env: {
      HERMES_ACTION_GATE_ENABLED: 'true',
      HERMES_ACTION_GATE_MODE: 'repair',
      HERMES_ACTION_GATE_MAX_REPAIR_ATTEMPTS: '1',
    },
    hermesImpl: async () => ({
      reply_text: '我已经完整读完了，这篇小红书主要说旅行。',
      follow_up_messages: [],
      media: null,
      model: 'deepseek-v4-flash',
    }),
    actionRepairImpl: async () => ({
      ok: true,
      status: 'partial_success',
      toolResult: {
        toolName: 'mcp_social_reader_read_social_post_deep',
        partial_success: true,
        error_code: 'XHS_PARTIAL',
        media_analysis: { merged_summary: '前三张图已经读到：图中展示了路线、预算和注意事项。' },
      },
    }),
    ingestImpl: async () => ({ ok: true }),
    logger: { log() {}, warn() {} },
  });

  const response = await backend.getReply({
    text: '帮我读一下 http://xhslink.com/o/abc123',
    sender_id: 'conv-action-repair-social-partial',
    channel: 'wechat',
  });

  assert.equal(response.replyText, '我读到了一部分内容：前三张图已经读到：图中展示了路线、预算和注意事项。但有些媒体或细节没有成功获取。');
});

test('createReplyBackend repair mode downgrades complete reply when repaired XHS media coverage is partial', async () => {
  const backend = createReplyBackend({
    env: {
      HERMES_ACTION_GATE_ENABLED: 'true',
      HERMES_ACTION_GATE_MODE: 'repair',
      HERMES_ACTION_GATE_MAX_REPAIR_ATTEMPTS: '1',
    },
    hermesImpl: async () => ({
      reply_text: '我已经完整读完了，这篇小红书主要说旅行。',
      follow_up_messages: [],
      media: null,
      model: 'deepseek-v4-flash',
    }),
    actionRepairImpl: async () => ({
      ok: true,
      status: 'success',
      repairedReply: '我已经完整读完了，五张图都看完了。',
      toolResult: {
        toolName: 'mcp_social_reader_read_social_post_deep',
        ok: true,
        total_media_count: 5,
        analyzed_media_count: 5,
        successful_media_count: 1,
        media_analysis: { partial: true, items: [{}], partial_failures: [{ asset_id: 'xhs-2', error_code: 'DOWNLOAD_TIMEOUT' }] },
      },
    }),
    ingestImpl: async () => ({ ok: true }),
    logger: { log() {}, warn() {} },
  });

  const response = await backend.getReply({
    text: '帮我读一下 http://xhslink.com/o/abc123',
    sender_id: 'conv-action-repair-social-partial-coverage',
    channel: 'wechat',
  });

  assert.equal(response.replyText, '我读到了一部分内容，但有些媒体或细节没有成功获取。');
});

test('createReplyBackend repair mode repairs media read through artifact evidence', async () => {
  const repairCalls = [];
  const backend = createReplyBackend({
    env: {
      HERMES_ACTION_GATE_ENABLED: 'true',
      HERMES_ACTION_GATE_MODE: 'repair',
      HERMES_ACTION_GATE_MAX_REPAIR_ATTEMPTS: '1',
    },
    hermesImpl: async () => ({
      reply_text: '我看到图片里是一张合同截图。',
      follow_up_messages: [],
      media: null,
      model: 'deepseek-v4-flash',
    }),
    actionRepairImpl: async (plan) => {
      repairCalls.push(plan);
      return {
        ok: true,
        status: 'success',
        repairedReply: '我现在读到了媒体内容：这是一张合同截图。',
        media: { type: 'image', artifact_id: 'media-artifact-private' },
        toolResult: { toolName: 'media_reader.analyze_image', ok: true, artifact_id: 'media-artifact-private' },
      };
    },
    ingestImpl: async () => ({ ok: true }),
    logger: { log() {}, warn() {} },
  });

  const response = await backend.getReply({
    text: '看下这张图',
    sender_id: 'conv-action-repair-media',
    channel: 'wechat',
    media: [{ filePath: '/opt/ran_agent/debug/wechat/inbound/private.png', mimeType: 'image/png', type: 'image' }],
  });

  assert.equal(repairCalls.length, 1);
  assert.equal(repairCalls[0].repairType, 'media_read');
  assert.equal(response.replyText, '我现在读到了媒体内容：这是一张合同截图。');
  assert.equal(response.media, null);
});

test('createReplyBackend repair mode repairs missing sticker marker and resolves media', async () => {
  const logs = [];
  const backend = createReplyBackend({
    env: {
      HERMES_ACTION_GATE_ENABLED: 'true',
      HERMES_ACTION_GATE_MODE: 'repair',
      HERMES_ACTION_GATE_MAX_REPAIR_ATTEMPTS: '1',
    },
    hermesImpl: async () => ({
      reply_text: '给你发一个表情包～',
      follow_up_messages: [],
      media: null,
      model: 'deepseek-v4-flash',
    }),
    actionRepairImpl: async () => ({
      ok: true,
      status: 'success',
      repairedReply: '给你一张\nRAN_MEDIA: {"source":"sticker_catalog","kind":"sticker","stickerId":"stk_001","caption":"测试"}',
      marker: 'RAN_MEDIA: {"source":"sticker_catalog","kind":"sticker","stickerId":"stk_001","caption":"测试"}',
      toolResult: { toolName: 'sticker_attach', ok: true, artifact_id: 'stk_001' },
    }),
    resolveStickerAssetImpl: () => ({
      stickerId: 'stk_001',
      mime: 'image/gif',
      fileName: 'stk_001.gif',
      filePath: '/private/server/stickers/assets/stk_001.gif',
    }),
    ingestImpl: async () => ({ ok: true }),
    logger: { log(message) { logs.push(String(message)); }, warn() {} },
  });

  const response = await backend.getReply({
    text: '来个表情包',
    sender_id: 'conv-action-repair-sticker',
    channel: 'wechat',
  }, { requestId: 'req-action-repair-sticker' });

  assert.equal(response.replyText, '给你一张');
  assert.equal(response.media?.stickerId, 'stk_001');
  const line = logs.find((item) => item.startsWith('[hermes-action-contract] '));
  const payload = JSON.parse(line.replace('[hermes-action-contract] ', ''));
  assert.equal(payload.repair_type, 'sticker_send');
  assert.equal(payload.repair_status, 'success');
  assert.equal(payload.final_action, 'repair_success');
  assert.equal(line.includes('/private/server'), false);
});

test('createReplyBackend repair mode can attach existing generated media marker', async () => {
  const logs = [];
  const backend = createReplyBackend({
    env: {
      HERMES_ACTION_GATE_ENABLED: 'true',
      HERMES_ACTION_GATE_MODE: 'repair',
      HERMES_ACTION_GATE_MAX_REPAIR_ATTEMPTS: '1',
    },
    hermesImpl: async () => ({
      reply_text: '图片已经生成好了，发你了。',
      follow_up_messages: [],
      media: null,
      model: 'deepseek-v4-flash',
    }),
    actionRepairImpl: async () => ({
      ok: true,
      status: 'success',
      repairedReply: '生成结果已准备好。\nWECHAT_MEDIA: {"source":"media_generation_mcp","type":"image","url":"https://example.com/generated.png","fileName":"generated.png"}',
      marker: 'WECHAT_MEDIA: {"source":"media_generation_mcp","type":"image","url":"https://example.com/generated.png","fileName":"generated.png"}',
      toolResult: { toolName: 'media_generation.attach_existing', ok: true, artifact_id: 'generated-artifact-private' },
    }),
    ingestImpl: async () => ({ ok: true }),
    logger: { log(message) { logs.push(String(message)); }, warn() {} },
  });

  const response = await backend.getReply({
    text: '生成一张猫图',
    sender_id: 'conv-action-repair-generate',
    channel: 'wechat',
  }, { requestId: 'req-action-repair-generate' });

  assert.equal(response.replyText, '生成结果已准备好。');
  assert.deepEqual(response.media, {
    type: 'image',
    url: 'https://example.com/generated.png',
    fileName: 'generated.png',
  });
  const line = logs.find((item) => item.startsWith('[hermes-action-contract] '));
  const payload = JSON.parse(line.replace('[hermes-action-contract] ', ''));
  assert.equal(payload.repair_type, 'media_generate');
  assert.equal(payload.repair_status, 'success');
  assert.equal(payload.final_action, 'repair_success');
  assert.equal(line.includes('generated-artifact-private'), false);
});

test('createReplyBackend repair mode does not fake generated media when repair has no artifact', async () => {
  const backend = createReplyBackend({
    env: {
      HERMES_ACTION_GATE_ENABLED: 'true',
      HERMES_ACTION_GATE_MODE: 'repair',
      HERMES_ACTION_GATE_MAX_REPAIR_ATTEMPTS: '1',
    },
    hermesImpl: async () => ({
      reply_text: '图片已经生成好了，发你了。',
      follow_up_messages: [],
      media: null,
      model: 'deepseek-v4-flash',
    }),
    actionRepairImpl: async () => ({ ok: false, status: 'failed', error_code: 'GENERATION_REPAIR_NO_ARTIFACT' }),
    ingestImpl: async () => ({ ok: true }),
    logger: { log() {}, warn() {} },
  });

  const response = await backend.getReply({
    text: '生成一张猫图',
    sender_id: 'conv-action-repair-generate-fail',
    channel: 'wechat',
  });

  assert.equal(response.replyText, '这次没有拿到可发送的生成结果，所以我不能说已经生成好了。');
  assert.equal(response.media, null);
});

test('createReplyBackend repair mode downgrades when sticker repair fails', async () => {
  const backend = createReplyBackend({
    env: {
      HERMES_ACTION_GATE_ENABLED: 'true',
      HERMES_ACTION_GATE_MODE: 'repair',
      HERMES_ACTION_GATE_MAX_REPAIR_ATTEMPTS: '1',
    },
    hermesImpl: async () => ({
      reply_text: '给你发一个表情包～',
      follow_up_messages: [],
      media: null,
      model: 'deepseek-v4-flash',
    }),
    actionRepairImpl: async () => ({ ok: false, status: 'failed', error_code: 'STICKER_NOT_FOUND' }),
    ingestImpl: async () => ({ ok: true }),
    logger: { log() {}, warn() {} },
  });

  const response = await backend.getReply({
    text: '来个表情包',
    sender_id: 'conv-action-repair-sticker-fail',
    channel: 'wechat',
  });

  assert.equal(response.replyText, '哈哈我懂你意思～');
  assert.equal(response.media, null);
});

test('createReplyBackend repair mode routes explicit memory writes through pending executor', async () => {
  const logs = [];
  const executions = [];
  const backend = createReplyBackend({
    env: {
      HERMES_ACTION_GATE_ENABLED: 'true',
      HERMES_ACTION_GATE_MODE: 'repair',
      HERMES_ACTION_GATE_MAX_REPAIR_ATTEMPTS: '1',
    },
    hermesImpl: async () => ({
      reply_text: '已经保存好了。',
      follow_up_messages: [],
      media: null,
      model: 'deepseek-v4-flash',
    }),
    pendingActionExecutorImpl: async (action) => {
      executions.push(action);
      return {
        ok: true,
        replyText: '已记住。',
        evidence: [{ type: 'save_result', status: 'success', result_id_hash: 'memoryhash' }],
      };
    },
    ingestImpl: async () => ({ ok: true }),
    logger: { log(message) { logs.push(String(message)); }, warn() {} },
  });

  const response = await backend.getReply({
    text: '记住这个偏好',
    sender_id: 'conv-action-repair-memory',
    channel: 'wechat',
  });

  assert.equal(executions.length, 1);
  assert.equal(response.replyText, '已记住。');
  const line = logs.find((item) => item.startsWith('[hermes-action-contract] '));
  const payload = JSON.parse(line.replace('[hermes-action-contract] ', ''));
  assert.equal(payload.pending_action_type, 'memory_write');
  assert.equal(payload.execution_status, 'success');
  assert.equal(payload.final_action, 'executed_with_evidence');
});

test('createReplyBackend repair mode creates pending for external sends without direct confirmation', async () => {
  const logs = [];
  let executed = false;
  const backend = createReplyBackend({
    env: {
      HERMES_ACTION_GATE_ENABLED: 'true',
      HERMES_ACTION_GATE_MODE: 'repair',
      HERMES_ACTION_GATE_MAX_REPAIR_ATTEMPTS: '1',
    },
    hermesImpl: async () => ({
      reply_text: '已经发送成功。',
      follow_up_messages: [],
      media: null,
      model: 'deepseek-v4-flash',
    }),
    pendingActionExecutorImpl: async () => {
      executed = true;
      return { ok: true };
    },
    ingestImpl: async () => ({ ok: true }),
    logger: { log(message) { logs.push(String(message)); }, warn() {} },
  });

  const response = await backend.getReply({
    text: '把这段话发给张三',
    sender_id: 'conv-action-repair-external',
    channel: 'wechat',
  });

  assert.equal(executed, false);
  assert.match(response.replyText, /确认发送/);
  const line = logs.find((item) => item.startsWith('[hermes-action-contract] '));
  const payload = JSON.parse(line.replace('[hermes-action-contract] ', ''));
  assert.equal(payload.pending_action_type, 'external_send');
  assert.equal(payload.pending_action_status, 'pending');
  assert.equal(payload.final_action, 'pending_confirmation');
});

test('createReplyBackend observe and enforce modes never call repair', async () => {
  for (const mode of ['observe', 'enforce']) {
    let repairCalled = false;
    const backend = createReplyBackend({
      env: {
        HERMES_ACTION_GATE_ENABLED: 'true',
        HERMES_ACTION_GATE_MODE: mode,
        HERMES_ACTION_GATE_MAX_REPAIR_ATTEMPTS: '1',
      },
      hermesImpl: async () => ({
        reply_text: '我已经完整读完了，这篇小红书主要说旅行。',
        follow_up_messages: [],
        media: null,
        model: 'deepseek-v4-flash',
      }),
      actionRepairImpl: async () => {
        repairCalled = true;
        return { ok: true };
      },
      ingestImpl: async () => ({ ok: true }),
      logger: { log() {}, warn() {} },
    });

    await backend.getReply({
      text: '帮我读一下 http://xhslink.com/o/abc123',
      sender_id: `conv-action-no-repair-${mode}`,
      channel: 'wechat',
    });

    assert.equal(repairCalled, false);
  }
});

test('createReplyBackend repair mode respects max repair attempts', async () => {
  let repairCalled = false;
  const backend = createReplyBackend({
    env: {
      HERMES_ACTION_GATE_ENABLED: 'true',
      HERMES_ACTION_GATE_MODE: 'repair',
      HERMES_ACTION_GATE_MAX_REPAIR_ATTEMPTS: '0',
    },
    hermesImpl: async () => ({
      reply_text: '我已经完整读完了，这篇小红书主要说旅行。',
      follow_up_messages: [],
      media: null,
      model: 'deepseek-v4-flash',
    }),
    actionRepairImpl: async () => {
      repairCalled = true;
      return { ok: true };
    },
    ingestImpl: async () => ({ ok: true }),
    logger: { log() {}, warn() {} },
  });

  const response = await backend.getReply({
    text: '帮我读一下 http://xhslink.com/o/abc123',
    sender_id: 'conv-action-repair-max-zero',
    channel: 'wechat',
  });

  assert.equal(repairCalled, false);
  assert.equal(response.replyText, '我现在还没有成功读取到这个链接的内容，所以不能直接判断里面写了什么。可以再试一次，或者你把截图/正文发我。');
});

test('createReplyBackend directly executes explicitly authorized sticker save', async () => {
  const env = tempStateEnv();
  const executions = [];
  let hermesCalled = false;
  const backend = createReplyBackend({
    env,
    hermesImpl: async () => {
      hermesCalled = true;
      return { reply_text: 'should not call hermes', follow_up_messages: [], media: null };
    },
    pendingActionExecutorImpl: async (action) => {
      executions.push(action);
      return {
        ok: true,
        status: 'success',
        evidence: [{ type: 'save_result', status: 'success', result_id_hash: 'savedhash' }],
        replyText: '已保存到表情包库。',
      };
    },
    ingestImpl: async () => ({ ok: true }),
    logger: { log() {}, warn() {} },
  });

  const response = await backend.getReply({
    text: '保存这个为表情包，标签：开心',
    sender_id: 'conv-pending-sticker-direct',
    conversation_id: 'conv-pending-sticker-direct',
    channel: 'wechat',
    media: [{ filePath: '/tmp/not-persisted.png', mimeType: 'image/png', type: 'image' }],
  }, { requestId: 'req-pending-sticker-direct' });

  assert.equal(hermesCalled, false);
  assert.equal(executions.length, 1);
  assert.equal(executions[0].actionType, 'sticker_save');
  assert.equal(JSON.stringify(executions[0]).includes('/tmp/not-persisted'), false);
  assert.equal(response.replyText, '已保存到表情包库。');
});

test('createReplyBackend default executor saves explicit trusted sticker media', async () => {
  const env = tempStateEnv();
  const filePath = writeTrustedInboxFile(env);
  const backend = createReplyBackend({
    env,
    hermesImpl: async () => ({ reply_text: 'should not call hermes', follow_up_messages: [], media: null }),
    ingestImpl: async () => ({ ok: true }),
    logger: { log() {}, warn() {} },
  });

  const response = await backend.getReply({
    text: '保存这个为表情包，标签：开心',
    sender_id: 'conv-default-sticker-save',
    conversation_id: 'conv-default-sticker-save',
    channel: 'wechat',
    media: [{ filePath, mimeType: 'image/png', type: 'image' }],
  }, { requestId: 'req-default-sticker-save' });

  assert.equal(response.replyText, '已保存到表情包库。');
  const stickers = listStickers({}, { env });
  assert.equal(stickers.length, 1);
  assert.deepEqual(stickers[0].tags, ['开心']);
  assert.equal(JSON.stringify(listPendingActions({ env })).includes(filePath), false);
});

test('createReplyBackend default executor deletes explicit sticker id only', async () => {
  const env = tempStateEnv();
  const filePath = writeTrustedInboxFile(env, 'delete-me.png');
  await saveStickersFromInbox({ items: [{ filePath, tags: ['旧'] }] }, { env });
  assert.equal(listStickers({}, { env }).length, 1);
  let hermesCalled = false;
  const backend = createReplyBackend({
    env,
    hermesImpl: async () => {
      hermesCalled = true;
      return { reply_text: 'should not call hermes', follow_up_messages: [], media: null };
    },
    ingestImpl: async () => ({ ok: true }),
    logger: { log() {}, warn() {} },
  });

  const response = await backend.getReply({
    text: '删除 stk_001 表情包',
    sender_id: 'conv-default-sticker-delete',
    conversation_id: 'conv-default-sticker-delete',
    channel: 'wechat',
  }, { requestId: 'req-default-sticker-delete' });

  assert.equal(hermesCalled, false);
  assert.equal(response.replyText, '已删除这个表情包。');
  assert.equal(listStickers({}, { env }).length, 0);
});

test('createReplyBackend refuses sticker delete without a clear sticker id', async () => {
  const env = tempStateEnv();
  let executed = false;
  const backend = createReplyBackend({
    env,
    hermesImpl: async () => ({ reply_text: 'should not call hermes', follow_up_messages: [], media: null }),
    pendingActionExecutorImpl: async () => {
      executed = true;
      return { ok: true };
    },
    ingestImpl: async () => ({ ok: true }),
    logger: { log() {}, warn() {} },
  });

  const response = await backend.getReply({
    text: '删掉这个表情包',
    sender_id: 'conv-pending-sticker-delete',
    conversation_id: 'conv-pending-sticker-delete',
    channel: 'wechat',
  }, { requestId: 'req-pending-sticker-delete' });

  assert.equal(executed, false);
  assert.match(response.replyText, /确认删除/);
  assert.equal(listPendingActions({ env })[0].actionType, 'sticker_delete');
});

test('createReplyBackend creates pending action for ambiguous sticker save', async () => {
  const env = tempStateEnv();
  let executed = false;
  const backend = createReplyBackend({
    env,
    hermesImpl: async () => ({ reply_text: '这张确实很好笑。', follow_up_messages: [], media: null }),
    pendingActionExecutorImpl: async () => {
      executed = true;
      return { ok: true };
    },
    ingestImpl: async () => ({ ok: true }),
    logger: { log() {}, warn() {} },
  });

  const response = await backend.getReply({
    text: '这个可以当表情包',
    sender_id: 'conv-pending-sticker',
    conversation_id: 'conv-pending-sticker',
    channel: 'wechat',
    media: [{ filePath: '/tmp/private.png', mimeType: 'image/png', type: 'image' }],
  }, { requestId: 'req-pending-sticker' });

  assert.equal(executed, false);
  assert.match(response.replyText, /确认保存/);
  const actions = listPendingActions({ env });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].actionType, 'sticker_save');
  assert.equal(actions[0].status, 'pending');
  assert.equal(JSON.stringify(actions).includes('/tmp/private.png'), false);
});

test('createReplyBackend confirms pending action in same conversation and executes once', async () => {
  const env = tempStateEnv();
  const pending = createPendingAction({
    requestId: 'req-existing-pending',
    channel: 'wechat',
    conversationId: 'conv-confirm-pending',
    profile: 'ran-assistant-lite',
    actionType: 'sticker_save',
    summary: '保存表情包',
    sanitizedPayload: { tags: ['开心'], media: [{ ref: 'media-ref-private', type: 'image' }] },
  }, { env });
  let hermesCalled = false;
  const executions = [];
  const backend = createReplyBackend({
    env,
    hermesImpl: async () => {
      hermesCalled = true;
      return { reply_text: 'should not call hermes', follow_up_messages: [], media: null };
    },
    pendingActionExecutorImpl: async (action) => {
      executions.push(action);
      return { ok: true, status: 'success', replyText: '已确认并执行。' };
    },
    ingestImpl: async () => ({ ok: true }),
    logger: { log() {}, warn() {} },
  });

  const response = await backend.getReply({
    text: '确认保存',
    sender_id: 'conv-confirm-pending',
    conversation_id: 'conv-confirm-pending',
    channel: 'wechat',
  }, { requestId: 'req-confirm-pending' });

  assert.equal(hermesCalled, false);
  assert.equal(executions.length, 1);
  assert.equal(executions[0].actionId, pending.actionId);
  assert.equal(response.replyText, '已确认并执行。');
  assert.equal(listPendingActions({ env }).find((item) => item.actionId === pending.actionId).status, 'executed');
});

test('createReplyBackend cancels pending action without executing', async () => {
  const env = tempStateEnv();
  const pending = createPendingAction({
    requestId: 'req-cancel-pending',
    channel: 'wechat',
    conversationId: 'conv-cancel-pending',
    actionType: 'external_send',
    summary: '发送消息',
  }, { env });
  let executed = false;
  const backend = createReplyBackend({
    env,
    hermesImpl: async () => ({ reply_text: 'should not call hermes', follow_up_messages: [], media: null }),
    pendingActionExecutorImpl: async () => {
      executed = true;
      return { ok: true };
    },
    ingestImpl: async () => ({ ok: true }),
    logger: { log() {}, warn() {} },
  });

  const response = await backend.getReply({
    text: '取消',
    sender_id: 'conv-cancel-pending',
    conversation_id: 'conv-cancel-pending',
    channel: 'wechat',
  });

  assert.equal(executed, false);
  assert.match(response.replyText, /已取消/);
  assert.equal(listPendingActions({ env }).find((item) => item.actionId === pending.actionId).status, 'cancelled');
});

test('createReplyBackend refuses expired and multiple pending confirmations', async () => {
  const env = tempStateEnv({ HERMES_ACTION_PENDING_TTL_MINUTES: '1' });
  createPendingAction({
    requestId: 'req-expired',
    channel: 'wechat',
    conversationId: 'conv-expired-pending',
    actionType: 'memory_write',
    summary: '记忆',
  }, { env, ttlMinutes: 1, now: new Date('2026-06-14T04:00:00.000Z') });
  const expiredBackend = createReplyBackend({
    env,
    hermesImpl: async () => ({ reply_text: '普通回复', follow_up_messages: [], media: null }),
    ingestImpl: async () => ({ ok: true }),
    nowImpl: () => new Date('2026-06-14T04:02:00.000Z'),
    logger: { log() {}, warn() {} },
  });

  const expired = await expiredBackend.getReply({
    text: '确认',
    sender_id: 'conv-expired-pending',
    conversation_id: 'conv-expired-pending',
    channel: 'wechat',
  });
  assert.match(expired.replyText, /确认项已经过期/);

  createPendingAction({
    requestId: 'req-multi-a',
    channel: 'wechat',
    conversationId: 'conv-multi-pending',
    actionType: 'memory_write',
    summary: '记忆 A',
  }, { env });
  createPendingAction({
    requestId: 'req-multi-b',
    channel: 'wechat',
    conversationId: 'conv-multi-pending',
    actionType: 'external_send',
    summary: '发送 B',
  }, { env });
  const multiBackend = createReplyBackend({
    env,
    hermesImpl: async () => ({ reply_text: 'should not call hermes', follow_up_messages: [], media: null }),
    ingestImpl: async () => ({ ok: true }),
    logger: { log() {}, warn() {} },
  });
  const multi = await multiBackend.getReply({
    text: '确认',
    sender_id: 'conv-multi-pending',
    conversation_id: 'conv-multi-pending',
    channel: 'wechat',
  });
  assert.match(multi.replyText, /有多个待确认操作/);
});

test('createReplyBackend does not execute high risk actions in observe or enforce modes', async () => {
  for (const mode of ['observe', 'enforce']) {
    const env = tempStateEnv({ HERMES_ACTION_GATE_MODE: mode });
    let executed = false;
    const backend = createReplyBackend({
      env,
      hermesImpl: async () => ({ reply_text: '已保存。', follow_up_messages: [], media: null, model: 'deepseek-v4-flash' }),
      pendingActionExecutorImpl: async () => {
        executed = true;
        return { ok: true };
      },
      ingestImpl: async () => ({ ok: true }),
      logger: { log() {}, warn() {} },
    });

    await backend.getReply({
      text: '记住这个偏好',
      sender_id: `conv-pending-mode-${mode}`,
      channel: 'wechat',
    });

    assert.equal(executed, false);
  }
});

test('createReplyBackend does not execute existing pending confirmations in observe or enforce modes', async () => {
  for (const mode of ['observe', 'enforce']) {
    const env = tempStateEnv({ HERMES_ACTION_GATE_MODE: mode });
    createPendingAction({
      requestId: `req-existing-${mode}`,
      channel: 'wechat',
      conversationId: `conv-existing-${mode}`,
      actionType: 'external_send',
      summary: '发送消息',
    }, { env });
    let executed = false;
    const backend = createReplyBackend({
      env,
      hermesImpl: async () => ({ reply_text: 'should not call hermes', follow_up_messages: [], media: null }),
      pendingActionExecutorImpl: async () => {
        executed = true;
        return { ok: true };
      },
      ingestImpl: async () => ({ ok: true }),
      logger: { log() {}, warn() {} },
    });

    const response = await backend.getReply({
      text: '确认',
      sender_id: `conv-existing-${mode}`,
      conversation_id: `conv-existing-${mode}`,
      channel: 'wechat',
    });

    assert.equal(executed, false);
    assert.match(response.replyText, /没有启用/);
  }
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

test('createReplyBackend enforce mode preserves valid sticker marker media', async () => {
  const logs = [];
  const backend = createReplyBackend({
    env: {
      HERMES_ACTION_GATE_ENABLED: 'true',
      HERMES_ACTION_GATE_MODE: 'enforce',
      HERMES_ACTION_GATE_MAX_REPAIR_ATTEMPTS: '1',
    },
    hermesImpl: async () => ({
      reply_text: '给你一张\n\nRAN_MEDIA: {"source":"sticker_catalog","kind":"sticker","stickerId":"stk_001","caption":"测试"}',
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
    logger: { log(message) { logs.push(String(message)); }, warn() {} },
  });

  const response = await backend.getReply({
    text: '来个表情包',
    sender_id: 'conv-sticker-enforce-pass',
    channel: 'wechat',
  }, { requestId: 'req-sticker-enforce-pass' });

  assert.equal(response.replyText, '给你一张');
  assert.equal(response.media?.stickerId, 'stk_001');
  const line = logs.find((item) => item.startsWith('[hermes-action-contract] '));
  const payload = JSON.parse(line.replace('[hermes-action-contract] ', ''));
  assert.equal(payload.gate_decision, 'pass');
  assert.equal(payload.final_action, 'pass_through');
  assert.equal(payload.evidence_satisfied, true);
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
