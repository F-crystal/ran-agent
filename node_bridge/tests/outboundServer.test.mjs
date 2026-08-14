import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import {
  createOutboundServer,
  getOutboundServerConfig,
  handleEnvironmentSensorRequest,
  handleCoreReminderRegisterRequest,
  handleExternalMcpSystemQueueRequest,
  handleHermesLiteSoftResetControlRequest,
  handleOutboundRequest,
  handleProactiveEventRequest,
  handleScheduledAiDigestControlRequest,
  handleScheduledAiDigestRequest,
  resolveStateDir,
} from '../src/outboundServer.mjs';
import {
  isTrustedHermesTaskScopedMessage,
  isTrustedInformationalReportTask,
} from '../src/hermesTaskScope.mjs';
import { runHermesLiteSoftReset } from '../src/hermesSessionMaintenance.mjs';
import {
  addExternalMcpWatch,
  recordExternalMcpNotification,
} from '../src/externalMcp/watchlist.mjs';
import { appendExternalMcpEvidence } from '../src/externalMcp/evidenceLog.mjs';
import { registerTestCleanup } from './helpers/isolatedState.mjs';
import {
  appendPendingOutboundMessage,
  drainPendingOutboundMessages,
  setFeishuHomeDmTarget,
  setProactiveDispatchState,
} from '../src/runtimeState.mjs';
import { createIsolatedTestEnv } from './helpers/isolatedState.mjs';

const PROJECT_ROOT = path.resolve(new URL('../..', import.meta.url).pathname);

function tempEnv(t, extra = {}, prefix = 'outbound-server-') {
  return createIsolatedTestEnv(t, {
    PERSONAL_AGENT_PROACTIVE_ENABLED: 'true',
    HERMES_PROACTIVE_EVENTS_ENABLED: 'true',
    HERMES_PROACTIVE_REMINDERS_ENABLED: 'true',
    HERMES_PROACTIVE_EXTERNAL_MCP_ENABLED: 'true',
    ...extra,
  }, prefix);
}

test('getOutboundServerConfig reads host and port from environment', () => {
  const config = getOutboundServerConfig({
    NODE_BRIDGE_OUTBOUND_HOST: '127.0.0.2',
    NODE_BRIDGE_OUTBOUND_PORT: '9901',
    PERSONAL_AGENT_WECHAT_ACCOUNT_ID: 'personal_agent',
  });

  assert.equal(config.host, '127.0.0.2');
  assert.equal(config.port, 9901);
  assert.equal(config.accountId, 'personal_agent');
});

test('Core reminder control route is authenticated and unavailable before Core cutover', async (t) => {
  const env = tempEnv(t, { RAN_AGENT_INTERNAL_CONTROL_SECRET: 'owner-control-secret' });
  const base = {
    env, method: 'POST', url: '/internal/core/reminders/register',
    remoteAddress: '127.0.0.1', bodyText: JSON.stringify({ todoId: 7, scheduledFor: '2026-08-09 15:00:00' }),
  };
  assert.equal((await handleCoreReminderRegisterRequest({ ...base, headers: {} })).status, 401);
  const unavailable = await handleCoreReminderRegisterRequest({
    ...base, headers: { authorization: 'Bearer owner-control-secret' },
  });
  assert.deepEqual(unavailable, { status: 503, payload: { ok: false, error: 'core_runtime_unavailable' } });
});

test('Hermes lite reset control route is exact, loopback-only, and bearer-authenticated', async (t) => {
  const env = tempEnv(t, {
    RAN_AGENT_INTERNAL_CONTROL_SECRET: 'owner-control-secret',
    HERMES_LITE_SOFT_RESET_ENABLED: 'true',
    HERMES_LITE_SOFT_RESET_DRY_RUN: 'false',
  }, 'soft-reset-control-auth-');
  const base = {
    env,
    method: 'POST',
    url: '/control/hermes-lite-soft-reset',
    headers: { authorization: 'Bearer owner-control-secret' },
    remoteAddress: '127.0.0.1',
    bodyText: JSON.stringify({ action: 'status' }),
  };

  assert.equal((await handleHermesLiteSoftResetControlRequest({ ...base, url: '/control/hermes-lite-soft-reset/' })).status, 404);
  assert.equal((await handleHermesLiteSoftResetControlRequest({ ...base, method: 'GET' })).status, 404);
  assert.equal((await handleHermesLiteSoftResetControlRequest({ ...base, remoteAddress: '192.0.2.8' })).status, 403);
  assert.equal((await handleHermesLiteSoftResetControlRequest({ ...base, headers: {} })).status, 401);
  assert.equal((await handleHermesLiteSoftResetControlRequest({
    ...base,
    headers: { authorization: 'Bearer wrong-secret' },
  })).status, 401);

  const accepted = await handleHermesLiteSoftResetControlRequest(base);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.payload.ok, true);
  assert.equal(accepted.payload.revision, 0);
});

test('Hermes lite reset control route requires revision and maps stale CAS to conflict', async (t) => {
  const env = tempEnv(t, {
    RAN_AGENT_INTERNAL_CONTROL_SECRET: 'owner-control-secret',
    HERMES_LITE_SOFT_RESET_ENABLED: 'true',
    HERMES_LITE_SOFT_RESET_DRY_RUN: 'false',
  }, 'soft-reset-control-cas-');
  const request = (payload) => handleHermesLiteSoftResetControlRequest({
    env,
    method: 'POST',
    url: '/control/hermes-lite-soft-reset',
    headers: { authorization: 'Bearer owner-control-secret' },
    remoteAddress: '::ffff:127.0.0.1',
    bodyText: JSON.stringify(payload),
  });

  assert.equal((await request({ action: 'apply' })).status, 428);
  runHermesLiteSoftReset({ action: 'apply', expectedRevision: 0, env, timelineRecords: [], now: new Date('2026-06-14T00:00:00Z') });
  const stale = await request({ action: 'rollback-last', expectedRevision: 0 });
  assert.equal(stale.status, 409);
  assert.equal(stale.payload.error, 'stale_revision');
  assert.equal(stale.payload.currentRevision, 1);
});

test('createOutboundServer wires the exact reset route with its injected runtime env', async (t) => {
  const env = tempEnv(t, {
    RAN_AGENT_INTERNAL_CONTROL_SECRET: 'wired-control-secret',
    HERMES_LITE_SOFT_RESET_ENABLED: 'true',
    HERMES_LITE_SOFT_RESET_DRY_RUN: 'false',
  }, 'soft-reset-control-wiring-');
  const server = createOutboundServer({ bot: {}, logger: { error() {} }, env });
  const request = new EventEmitter();
  request.method = 'POST';
  request.url = '/control/hermes-lite-soft-reset';
  request.headers = { authorization: 'Bearer wired-control-secret' };
  request.socket = { remoteAddress: '127.0.0.1' };
  const result = await new Promise((resolve) => {
    const response = {
      status: 0,
      writeHead(status) { this.status = status; },
      end(body) { resolve({ status: this.status, payload: JSON.parse(body) }); },
    };
    server.emit('request', request, response);
    request.emit('data', JSON.stringify({ action: 'status' }));
    request.emit('end');
  });
  assert.equal(result.status, 200);
  assert.equal(result.payload.revision, 0);
});

test('handleEnvironmentSensorRequest accepts Sensor Logger payload with path token', async (t) => {
  const env = tempEnv(t, {
    ENVIRONMENT_SENSOR_INGEST_TOKEN: 'secret-token',
  }, 'environment-ingest-');
  const result = await handleEnvironmentSensorRequest({
    env,
    method: 'POST',
    url: '/environment/sensorlogger/secret-token',
    bodyText: JSON.stringify({
      messageId: 1,
      sessionId: 'session-a',
      deviceId: 'phone-a',
      payload: [
        {
          name: 'battery',
          time: 1710000001000000000,
          values: { batteryLevel: 0.42, batteryState: 'charging', lowPowerMode: false },
        },
      ],
    }),
  });

  assert.equal(result.status, 200);
  assert.equal(result.payload.ok, true);
  assert.equal(result.payload.readings, 1);
  const latestPath = path.join(env.RAN_AGENT_STATE_DIR, 'environment', 'latest.json');
  const latest = JSON.parse(fs.readFileSync(latestPath, 'utf8'));
  assert.equal(latest.battery.percent, 42);
  assert.equal(latest.battery.state, 'charging');
});

test('handleEnvironmentSensorRequest rejects missing or wrong token', async (t) => {
  const env = tempEnv(t, {
    ENVIRONMENT_SENSOR_INGEST_TOKEN: 'secret-token',
  }, 'environment-ingest-');
  const result = await handleEnvironmentSensorRequest({
    env,
    method: 'POST',
    url: '/environment/sensorlogger/wrong',
    bodyText: '{}',
  });

  assert.equal(result.status, 403);
  assert.equal(result.payload.error, 'forbidden');
});

test('handleOutboundRequest rejects retired text-only proactive messages', async () => {
  let sendCalled = false;
  const result = await handleOutboundRequest({
    bot: {
      async sendMessage() {
        sendCalled = true;
      },
    },
    logger: {
      info() {},
      warn() {},
      error() {},
    },
    method: 'POST',
    url: '/outbound/send',
    bodyText: JSON.stringify({ text: '你刚提到下午要改论文提纲，进展到哪一步了？' }),
  });

  assert.equal(result.status, 200);
  assert.equal(result.payload.ok, true);
  assert.equal(result.payload.dropped, true);
  assert.equal(result.payload.reason, 'legacy_checkin_route_retired');
  assert.equal(sendCalled, false);
});

test('handleScheduledAiDigestRequest routes digest through existing Feishu DM flow', async (t) => {
  const templatePath = path.join(PROJECT_ROOT, 'src/personal_agent/prompts/ai_daily_digest_report.md');
  assert.equal(fs.existsSync(templatePath), true);

  const env = tempEnv(t, {
    FEISHU_LARK_CLI_BIN: 'lark-cli',
    FEISHU_LARK_CLI_IDENTITY: 'bot',
  }, 'scheduled-digest-');
  setFeishuHomeDmTarget(
    {
      platform: 'feishu',
      channel_type: 'dm',
      conversation_id: 'oc-home',
      sender_id: 'ou-home',
    },
    env
  );

  let channelMessage = null;
  const calls = [];
  let clockTick = 0;
  const result = await handleScheduledAiDigestRequest({
    logger: { info() {}, warn() {}, error() {}, log() {} },
    env,
    bodyText: JSON.stringify({ facts: '今日 AI 事实材料' }),
    channelHub: async (message) => {
      channelMessage = message;
      return { replyText: '给陛下呈上今日 AI 日报' };
    },
    execFileImpl: async (bin, args) => {
      calls.push({ bin, args });
      return { stdout: '{"ok":true}' };
    },
    nowImpl: () => new Date(Date.parse('2026-08-05T00:00:00.000Z') + (clockTick++ * 1000)),
  });

  assert.equal(result.status, 200);
  assert.equal(result.payload.ok, true);
  assert.equal(result.payload.delivery_status, 'sent');
  assert.match(result.payload.outbox_id, /^outbox_[a-f0-9]{32}$/);
  assert.equal(channelMessage.platform, 'feishu');
  assert.equal(channelMessage.channel_type, 'dm');
  assert.equal(channelMessage.conversation_id, 'oc-home');
  assert.equal(channelMessage.sender_id, 'ou-home');
  assert.equal(channelMessage.route_hint, 'scheduled_ai_daily_digest');
  assert.equal(isTrustedInformationalReportTask(channelMessage), true);
  assert.match(channelMessage.text, /今日 AI 事实材料/);
  assert.match(channelMessage.text, /标题、来源、正文/);
  assert.match(channelMessage.text, /50-200/);
  assert.match(channelMessage.text, /报道式自然段/);
  assert.match(channelMessage.text, /不要使用“看点\/意义\/适合\/今日信号”/);
  assert.doesNotMatch(channelMessage.text, /\{facts\}/);
  assert.doesNotMatch(channelMessage.text, /发生了什么 \+ 为什么值得看/);
  assert.equal(calls[0].bin, 'lark-cli');
  assert.equal(calls[0].args.includes('--user-id'), true);
  assert.equal(calls[0].args.includes('ou-home'), true);
  const outboxState = JSON.parse(fs.readFileSync(
    path.join(resolveStateDir(env), 'core', 'durable-outbox.json'),
    'utf8'
  ));
  const outboxItem = outboxState.items.find((item) => item.outboxId === result.payload.outbox_id);
  assert.ok(Date.parse(outboxItem.sendStartedAt) > Date.parse(outboxItem.createdAt));
  assert.ok(Date.parse(outboxItem.deliveryCommittedAt) > Date.parse(outboxItem.sendStartedAt));
});

test('manual AI digest uses its operation scope to send one digest body exactly once', async (t) => {
  const env = tempEnv(t, {
    FEISHU_LARK_CLI_BIN: 'lark-cli',
    FEISHU_LARK_CLI_IDENTITY: 'bot',
  }, 'manual-digest-once-');
  setFeishuHomeDmTarget({
    platform: 'feishu',
    channel_type: 'dm',
    conversation_id: 'oc-home',
    sender_id: 'ou-home',
  }, env);
  const operationId = `op_${'a'.repeat(32)}`;
  let taskGenerations = 0;
  const sends = [];
  const input = {
    logger: { info() {}, warn() {}, error() {}, log() {} },
    env,
    bodyText: JSON.stringify({ facts: '仅用于手动补发的已验证事实', mode: 'manual', operation_id: operationId }),
    channelHub: async (message) => {
      taskGenerations += 1;
      assert.equal(message.route_hint, 'manual_ai_daily_digest');
      assert.equal(isTrustedInformationalReportTask(message), true);
      return { replyText: '日报正文只发送一次' };
    },
    execFileImpl: async (bin, args) => {
      sends.push({ bin, args });
      return { stdout: '{"ok":true}' };
    },
    nowImpl: () => new Date('2026-07-12T09:00:00.000Z'),
  };

  const first = await handleScheduledAiDigestRequest(input);
  const second = await handleScheduledAiDigestRequest(input);

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(first.payload.delivery_status, 'sent');
  assert.equal(second.payload.delivery_status, 'sent');
  assert.equal(first.payload.outbox_id, second.payload.outbox_id);
  assert.equal(sends.length, 1);
  assert.equal(taskGenerations, 2);
});

test('scheduled AI digest control route is loopback and bearer authenticated before it can create trusted provenance', async (t) => {
  const env = tempEnv(t, {
    RAN_AGENT_INTERNAL_CONTROL_SECRET: 'digest-control-secret',
    FEISHU_LARK_CLI_BIN: 'lark-cli',
    FEISHU_LARK_CLI_IDENTITY: 'bot',
  }, 'scheduled-digest-control-');
  setFeishuHomeDmTarget({
    platform: 'feishu', channel_type: 'dm', conversation_id: 'oc-home', sender_id: 'ou-home',
  }, env);
  let channelMessage = null;
  const request = (overrides = {}) => handleScheduledAiDigestControlRequest({
    env,
    logger: { info() {}, warn() {}, error() {}, log() {} },
    method: 'POST',
    url: '/scheduled/ai-daily-digest',
    headers: { authorization: 'Bearer digest-control-secret' },
    remoteAddress: '127.0.0.1',
    bodyText: JSON.stringify({ facts: '已验证的日报事实' }),
    channelHub: async (message) => {
      channelMessage = message;
      return { replyText: '日报正文' };
    },
    execFileImpl: async () => ({ stdout: '{"ok":true}' }),
    ...overrides,
  });

  assert.equal((await request({ headers: {} })).status, 401);
  assert.equal((await request({ headers: { authorization: 'Bearer wrong-secret' } })).status, 401);
  assert.equal((await request({ remoteAddress: '192.0.2.8' })).status, 403);
  assert.equal(channelMessage, null);

  const accepted = await request();
  assert.equal(accepted.status, 200);
  assert.equal(isTrustedInformationalReportTask(channelMessage), true);
});

test('handleExternalMcpSystemQueueRequest is disabled by default and does not call Hermes', async () => {
  let channelCalled = false;
  const result = await handleExternalMcpSystemQueueRequest({
    env: {},
    bodyText: JSON.stringify({
      serverId: 'forum.example',
      watchScope: 'thread:forum.example/123',
      topicKey: 'thread:forum.example/123',
      reason: 'watched forum thread changed',
      deliverability: 'notify_allowed',
    }),
    channelHub: async () => {
      channelCalled = true;
    },
  });

  assert.equal(result.status, 200);
  assert.equal(result.payload.ok, true);
  assert.equal(result.payload.dropped, true);
  assert.equal(result.payload.reason, 'proactive_events_disabled');
  assert.equal(channelCalled, false);
});

test('handleExternalMcpSystemQueueRequest requires the external MCP gateway gate too', async () => {
  let channelCalled = false;
  const result = await handleExternalMcpSystemQueueRequest({
    env: {
      HERMES_PROACTIVE_EVENTS_ENABLED: 'true',
      HERMES_PROACTIVE_EXTERNAL_MCP_ENABLED: 'true',
      EXTERNAL_MCP_SYSTEM_QUEUE_ENABLED: 'true',
    },
    bodyText: JSON.stringify({
      serverId: 'forum.example',
      watchScope: 'thread:forum.example/123',
      topicKey: 'thread:forum.example/123',
      reason: 'watched forum thread changed',
      deliverability: 'notify_allowed',
    }),
    channelHub: async () => {
      channelCalled = true;
    },
  });

  assert.equal(result.status, 200);
  assert.equal(result.payload.ok, true);
  assert.equal(result.payload.dropped, true);
  assert.equal(result.payload.reason, 'external_mcp_gateway_disabled');
  assert.equal(channelCalled, false);
});

test('handleExternalMcpSystemQueueRequest drops unregistered watch scopes', async (t) => {
  const env = tempEnv(t, {
    HERMES_PROACTIVE_EVENTS_ENABLED: 'true',
    HERMES_PROACTIVE_EXTERNAL_MCP_ENABLED: 'true',
    EXTERNAL_MCP_GATEWAY_ENABLED: 'true',
    EXTERNAL_MCP_SYSTEM_QUEUE_ENABLED: 'true',
  }, 'external-mcp-queue-');
  setFeishuHomeDmTarget({
    platform: 'feishu',
    channel_type: 'dm',
    conversation_id: 'oc-home',
    sender_id: 'ou-home',
  }, env);

  let channelCalled = false;
  const result = await handleExternalMcpSystemQueueRequest({
    env,
    bodyText: JSON.stringify({
      globalUserId: 'ou-home',
      serverId: 'forum.example',
      watchScope: 'thread:forum.example/123',
      topicKey: 'thread:forum.example/123',
      reason: 'watched forum thread changed',
      deliverability: 'notify_allowed',
    }),
    channelHub: async () => {
      channelCalled = true;
    },
  });

  assert.equal(result.status, 200);
  assert.equal(result.payload.ok, true);
  assert.equal(result.payload.dropped, true);
  assert.equal(result.payload.reason, 'watch_not_registered');
  assert.equal(channelCalled, false);
});

test('handleExternalMcpSystemQueueRequest routes registered watches as synthetic Hermes turns', async (t) => {
  const env = tempEnv(t, {
    HERMES_PROACTIVE_EVENTS_ENABLED: 'true',
    HERMES_PROACTIVE_EXTERNAL_MCP_ENABLED: 'true',
    EXTERNAL_MCP_GATEWAY_ENABLED: 'true',
    EXTERNAL_MCP_SYSTEM_QUEUE_ENABLED: 'true',
    FEISHU_LARK_CLI_BIN: 'lark-cli',
    FEISHU_LARK_CLI_IDENTITY: 'bot',
  }, 'external-mcp-queue-');
  setFeishuHomeDmTarget({
    platform: 'feishu',
    channel_type: 'dm',
    conversation_id: 'oc-home',
    sender_id: 'ou-home',
  }, env);
  addExternalMcpWatch({
    globalUserId: 'ou-home',
    serverId: 'forum.example',
    kind: 'forum',
    scope: 'thread:forum.example/123',
  }, { env, now: '2026-07-01T10:00:00Z' });
  const evidence = appendExternalMcpEvidence({
    requestId: 'req-watch-event-1',
    globalUserId: 'ou-home',
    serverId: 'forum.example',
    toolName: 'forum.read_thread',
    watchScope: 'thread:forum.example/123',
    tier: 'T1',
    sessionMode: 'observe',
    trigger: 'proactive',
    decision: 'allow',
    result: { ok: true },
  }, { env, now: '2026-07-01T11:59:00Z' });

  let channelMessage = null;
  const calls = [];
  const result = await handleExternalMcpSystemQueueRequest({
    logger: { info() {}, warn() {}, error() {}, log() {} },
    env,
    bodyText: JSON.stringify({
      id: 'watch-event-1',
      globalUserId: 'ou-home',
      serverId: 'forum.example',
      watchScope: 'thread:forum.example/123',
      topicKey: 'thread:forum.example/123',
      reason: 'watched forum thread changed',
      evidenceRefs: [evidence.evidence_ref],
      deliverability: 'notify_allowed',
      allowedCapabilityTiers: ['T1', 'T2'],
      now: '2026-07-01T12:00:00Z',
    }),
    nowImpl: () => new Date('2026-07-01T12:00:00Z'),
    channelHub: async (message, options) => {
      channelMessage = message;
      await options.adapter.sendReply({
        target: {
          channel_type: 'dm',
          conversation_id: message.conversation_id,
          sender_id: message.sender_id,
        },
        text: JSON.stringify({
          action: 'notify',
          message: '你关注的帖子有一条直接回复。',
          evidence_refs: [evidence.evidence_ref],
          why_now: 'watched thread received a direct reply',
        }),
        message,
      });
      return {
        replyText: JSON.stringify({
          action: 'notify',
          message: '你关注的帖子有一条直接回复。',
          evidence_refs: [evidence.evidence_ref],
          why_now: 'watched thread received a direct reply',
        }),
        suppressSend: false,
      };
    },
    execFileImpl: async (bin, args) => {
      calls.push({ bin, args });
      return { stdout: '{"ok":true}' };
    },
  });

  assert.equal(result.status, 200);
  assert.equal(result.payload.ok, true);
  assert.equal(result.payload.notified, true);
  assert.equal(channelMessage.platform, 'feishu');
  assert.equal(channelMessage.route_hint, 'external_mcp_system_queue');
  assert.equal(isTrustedHermesTaskScopedMessage(channelMessage), true);
  assert.match(channelMessage.text, /watched forum thread changed/);
  assert.match(channelMessage.text, new RegExp(`evidence_refs: ${evidence.evidence_ref}`));
  assert.match(channelMessage.text, /allowed_capability_tiers: T1,T2/);
  assert.equal(calls[0].bin, 'lark-cli');
  assert.equal(calls[0].args.includes('--user-id'), true);
  assert.equal(calls[0].args.includes('ou-home'), true);
});

test('handleExternalMcpSystemQueueRequest rejects caller-supplied untrusted evidence refs', async (t) => {
  const env = tempEnv(t, {
    HERMES_PROACTIVE_EVENTS_ENABLED: 'true',
    HERMES_PROACTIVE_EXTERNAL_MCP_ENABLED: 'true',
    EXTERNAL_MCP_GATEWAY_ENABLED: 'true',
    EXTERNAL_MCP_SYSTEM_QUEUE_ENABLED: 'true',
  }, 'external-mcp-queue-');
  setFeishuHomeDmTarget({
    platform: 'feishu',
    channel_type: 'dm',
    conversation_id: 'oc-home',
    sender_id: 'ou-home',
  }, env);
  addExternalMcpWatch({
    globalUserId: 'ou-home',
    serverId: 'forum.example',
    kind: 'forum',
    scope: 'thread:forum.example/123',
  }, { env, now: '2026-07-01T10:00:00Z' });

  let channelCalled = false;
  const result = await handleExternalMcpSystemQueueRequest({
    env,
    nowImpl: () => new Date('2026-07-01T12:00:00Z'),
    bodyText: JSON.stringify({
      id: 'watch-event-spoofed',
      globalUserId: 'ou-home',
      serverId: 'forum.example',
      watchScope: 'thread:forum.example/123',
      reason: 'watched forum thread changed',
      evidenceRefs: ['external_mcp_evidence:spoofed'],
      deliverability: 'notify_allowed',
      allowedCapabilityTiers: ['T1', 'T2'],
    }),
    channelHub: async () => {
      channelCalled = true;
    },
  });

  assert.equal(result.status, 200);
  assert.equal(result.payload.ok, true);
  assert.equal(result.payload.dropped, true);
  assert.equal(result.payload.reason, 'evidence_not_trusted');
  assert.equal(channelCalled, false);
});

test('handleExternalMcpSystemQueueRequest rate limits notify events before Hermes is called', async (t) => {
  const env = tempEnv(t, {
    HERMES_PROACTIVE_EVENTS_ENABLED: 'true',
    HERMES_PROACTIVE_EXTERNAL_MCP_ENABLED: 'true',
    EXTERNAL_MCP_GATEWAY_ENABLED: 'true',
    EXTERNAL_MCP_SYSTEM_QUEUE_ENABLED: 'true',
  }, 'external-mcp-queue-');
  setFeishuHomeDmTarget({
    platform: 'feishu',
    channel_type: 'dm',
    conversation_id: 'oc-home',
    sender_id: 'ou-home',
  }, env);
  addExternalMcpWatch({
    globalUserId: 'ou-home',
    serverId: 'forum.example',
    kind: 'forum',
    scope: 'thread:forum.example/123',
  }, { env, now: '2026-07-01T10:00:00Z' });
  const evidence = appendExternalMcpEvidence({
    requestId: 'req-budget-1',
    globalUserId: 'ou-home',
    serverId: 'forum.example',
    toolName: 'forum.read_thread',
    watchScope: 'thread:forum.example/123',
    tier: 'T1',
    sessionMode: 'observe',
    trigger: 'proactive',
    decision: 'allow',
    result: { ok: true },
  }, { env, now: '2026-07-01T11:59:00Z' });
  recordExternalMcpNotification({
    globalUserId: 'ou-home',
    serverId: 'forum.example',
    topicKey: 'thread:forum.example/old',
    now: '2026-07-01T09:00:00Z',
  }, { env });

  let channelCalled = false;
  const result = await handleExternalMcpSystemQueueRequest({
    env,
    bodyText: JSON.stringify({
      globalUserId: 'ou-home',
      serverId: 'forum.example',
      watchScope: 'thread:forum.example/123',
      topicKey: 'thread:forum.example/123',
      reason: 'watched forum thread changed',
      evidenceRefs: [evidence.evidence_ref],
      deliverability: 'notify_allowed',
      now: '2026-07-01T12:00:00Z',
    }),
    nowImpl: () => new Date('2026-07-01T12:00:00Z'),
    channelHub: async () => {
      channelCalled = true;
    },
  });

  assert.equal(result.status, 200);
  assert.equal(result.payload.ok, true);
  assert.equal(result.payload.dropped, true);
  assert.equal(result.payload.reason, 'global_daily_budget_exhausted');
  assert.equal(channelCalled, false);
});

test('handleExternalMcpSystemQueueRequest ignores caller-supplied time and topic for budgets', async (t) => {
  const env = tempEnv(t, {
    HERMES_PROACTIVE_EVENTS_ENABLED: 'true',
    HERMES_PROACTIVE_EXTERNAL_MCP_ENABLED: 'true',
    EXTERNAL_MCP_GATEWAY_ENABLED: 'true',
    EXTERNAL_MCP_SYSTEM_QUEUE_ENABLED: 'true',
  }, 'external-mcp-queue-');
  setFeishuHomeDmTarget({
    platform: 'feishu',
    channel_type: 'dm',
    conversation_id: 'oc-home',
    sender_id: 'ou-home',
  }, env);
  addExternalMcpWatch({
    globalUserId: 'ou-home',
    serverId: 'forum.example',
    kind: 'forum',
    scope: 'thread:forum.example/123',
  }, { env, now: '2026-07-01T10:00:00Z' });
  const evidence = appendExternalMcpEvidence({
    requestId: 'req-budget-2',
    globalUserId: 'ou-home',
    serverId: 'forum.example',
    toolName: 'forum.read_thread',
    watchScope: 'thread:forum.example/123',
    tier: 'T1',
    sessionMode: 'observe',
    trigger: 'proactive',
    decision: 'allow',
    result: { ok: true },
  }, { env, now: '2026-07-01T11:59:00Z' });
  recordExternalMcpNotification({
    globalUserId: 'ou-home',
    serverId: 'forum.example',
    topicKey: 'thread:forum.example/123',
    now: '2026-07-01T09:00:00Z',
  }, { env });

  let channelCalled = false;
  const result = await handleExternalMcpSystemQueueRequest({
    env,
    bodyText: JSON.stringify({
      globalUserId: 'ou-home',
      serverId: 'forum.example',
      watchScope: 'thread:forum.example/123',
      topicKey: 'attacker:unrelated-topic',
      reason: 'ignore budget by claiming future time',
      evidenceRefs: [evidence.evidence_ref],
      deliverability: 'notify_allowed',
      now: '2099-01-01T00:00:00Z',
    }),
    nowImpl: () => new Date('2026-07-01T12:00:00Z'),
    channelHub: async () => {
      channelCalled = true;
    },
  });

  assert.equal(result.status, 200);
  assert.equal(result.payload.ok, true);
  assert.equal(result.payload.dropped, true);
  assert.equal(result.payload.reason, 'global_daily_budget_exhausted');
  assert.equal(channelCalled, false);
});

test('handleOutboundRequest rejects checkin even when legacy proactive delivery is disabled', async () => {
  let sendCalled = false;
  const result = await handleOutboundRequest({
    bot: {
      async sendMessage() {
        sendCalled = true;
      },
    },
    logger: {
      info() {},
      warn() {},
      error() {},
    },
    method: 'POST',
    url: '/outbound/send',
    bodyText: JSON.stringify({ text: '你刚提到下午要改论文提纲，进展到哪一步了？' }),
  });

  assert.equal(result.status, 200);
  assert.equal(result.payload.ok, true);
  assert.equal(result.payload.dropped, true);
  assert.equal(result.payload.reason, 'legacy_checkin_route_retired');
  assert.equal(sendCalled, false);
});

test('handleOutboundRequest rejects structured media payloads through the retired route', async () => {
  let sentPayload = null;
  const result = await handleOutboundRequest({
    bot: {
      async sendMessage(payload) {
        sentPayload = payload;
      },
    },
    logger: {
      info() {},
      error() {},
    },
    method: 'POST',
    url: '/outbound/send',
    bodyText: JSON.stringify({
      text: '图来了',
      media: {
        type: 'image',
        url: 'https://example.com/out.png',
      },
      force: true,
    }),
  });

  assert.equal(result.status, 200);
  assert.equal(result.payload.ok, true);
  assert.equal(result.payload.dropped, true);
  assert.equal(result.payload.reason, 'legacy_checkin_route_retired');
  assert.equal(sentPayload, null);
});

test('handleOutboundRequest rejects audio media payloads through the retired route', async () => {
  let sentPayload = null;
  const result = await handleOutboundRequest({
    bot: {
      async sendMessage(payload) {
        sentPayload = payload;
      },
    },
    logger: {
      info() {},
      error() {},
    },
    method: 'POST',
    url: '/outbound/send',
    bodyText: JSON.stringify({
      text: '语音来了',
      media: {
        type: 'audio',
        url: '/tmp/reply.wav',
      },
      force: true,
    }),
  });

  assert.equal(result.status, 200);
  assert.equal(result.payload.ok, true);
  assert.equal(result.payload.dropped, true);
  assert.equal(result.payload.reason, 'legacy_checkin_route_retired');
  assert.equal(sentPayload, null);
});

test('handleOutboundRequest rejects paragraph-delimited media captions through the retired route', async () => {
  {
    const sentPayloads = [];
    const result = await handleOutboundRequest({
      bot: {
        async sendMessage(payload) {
          sentPayloads.push(payload);
        },
      },
      logger: {
        info() {},
        error() {},
      },
      method: 'POST',
      url: '/outbound/send',
      bodyText: JSON.stringify({
        text: '第一段\n\n第二段\n\n第三段',
        media: {
          type: 'image',
          url: 'https://example.com/out.png',
        },
        force: true,
      }),
    });

    assert.equal(result.status, 200);
    assert.equal(result.payload.ok, true);
    assert.equal(result.payload.dropped, true);
    assert.equal(result.payload.reason, 'legacy_checkin_route_retired');
    assert.deepEqual(sentPayloads, []);
  }
});

test('handleOutboundRequest does not send or queue failed retired media sends', async () => {
  let sendCalled = false;
  const result = await handleOutboundRequest({
    bot: {
      async sendMessage() {
        sendCalled = true;
        throw new Error('context expired');
      },
    },
    logger: {
      info() {},
      error() {},
    },
    method: 'POST',
    url: '/outbound/send',
    bodyText: JSON.stringify({
      text: '图来了',
      media: { type: 'image', url: 'https://example.com/out.png' },
      force: true,
    }),
  });

  assert.equal(result.status, 200);
  assert.equal(result.payload.ok, true);
  assert.equal(result.payload.dropped, true);
  assert.equal(result.payload.reason, 'legacy_checkin_route_retired');
  assert.equal(sendCalled, false);
});

test('handleOutboundRequest rejects low-value proactive text through the retired route', async () => {
  let sendCalled = false;
  const result = await handleOutboundRequest({
    bot: {
      async sendMessage() {
        sendCalled = true;
      },
    },
    logger: {
      info() {},
      warn() {},
      error() {},
    },
    method: 'POST',
    url: '/outbound/send',
    bodyText: JSON.stringify({ text: '刚想到你最近挺忙的，今天还顺吗。' }),
  });

  assert.equal(result.status, 200);
  assert.equal(result.payload.ok, true);
  assert.equal(result.payload.dropped, true);
  assert.equal(result.payload.reason, 'legacy_checkin_route_retired');
  assert.equal(sendCalled, false);
});

test('handleProactiveEventRequest sends reminder events through Hermes egress', async (t) => {
  const env = tempEnv(t, {
    HERMES_PROACTIVE_EVENTS_ENABLED: 'true',
    HERMES_PROACTIVE_REMINDERS_ENABLED: 'true',
    FEISHU_LARK_CLI_BIN: 'lark-cli',
    FEISHU_LARK_CLI_IDENTITY: 'bot',
  }, 'proactive-event-');
  setFeishuHomeDmTarget({
    platform: 'feishu',
    channel_type: 'dm',
    conversation_id: 'oc-home',
    sender_id: 'ou-home',
  }, env);

  let channelMessage = null;
  const calls = [];
  const result = await handleProactiveEventRequest({
    env,
    logger: { info() {}, warn() {}, error() {}, log() {} },
    nowImpl: () => new Date('2026-07-01T09:10:00+08:00'),
    bodyText: JSON.stringify({
      event_id: 'reminder-1',
      kind: 'reminder',
      global_user_id: 'ou-home',
      channel: 'feishu',
      watch_scope: 'todo:1',
      reason: 'Explicit reminder is due: 去单位',
      evidence_refs: ['todo:1'],
      dedupe_key: 'reminder:1:20260701T090000',
      created_at: '2026-07-01T09:00:00+08:00',
      expires_at: '2026-07-01T10:00:00+08:00',
      deliverability: 'notify_allowed',
      allowed_capability_tiers: ['T0'],
      quiet_policy: 'ignore_for_explicit_reminder',
      budget_class: 'reminder',
    }),
    channelHub: async (message, options) => {
      channelMessage = message;
      await options.adapter.sendReply({
        target: {
          channel_type: 'dm',
          conversation_id: message.conversation_id,
          sender_id: message.sender_id,
        },
        text: JSON.stringify({
          action: 'notify',
          message: '提醒一下：去单位',
          evidence_refs: ['todo:1'],
          why_now: 'explicit todo reminder is due now',
        }),
        message,
      });
      return {
        replyText: JSON.stringify({
          action: 'notify',
          message: '提醒一下：去单位',
          evidence_refs: ['todo:1'],
          why_now: 'explicit todo reminder is due now',
        }),
      };
    },
    execFileImpl: async (bin, args) => {
      calls.push({ bin, args });
      return { stdout: '{"ok":true}' };
    },
  });

  assert.equal(result.status, 200);
  assert.equal(isTrustedHermesTaskScopedMessage(channelMessage), true);
  assert.equal(result.payload.ok, true);
  assert.equal(result.payload.status, 'sent');
  assert.equal(result.payload.notified, true);
  assert.equal(channelMessage.route_hint, 'hermes_proactive_event');
  assert.match(channelMessage.text, /Explicit reminder is due/);
  assert.equal(calls[0].bin, 'lark-cli');
  assert.equal(calls[0].args.includes('提醒一下：去单位'), true);

  let secondChannelCalled = false;
  const duplicate = await handleProactiveEventRequest({
    env,
    logger: { info() {}, warn() {}, error() {}, log() {} },
    nowImpl: () => new Date('2026-07-01T09:11:00+08:00'),
    bodyText: JSON.stringify({
      event_id: 'reminder-1',
      kind: 'reminder',
      global_user_id: 'ou-home',
      channel: 'feishu',
      watch_scope: 'todo:1',
      reason: 'Explicit reminder is due: 去单位',
      evidence_refs: ['todo:1'],
      dedupe_key: 'reminder:1:20260701T090000',
      created_at: '2026-07-01T09:00:00+08:00',
      expires_at: '2026-07-01T10:00:00+08:00',
      deliverability: 'notify_allowed',
      allowed_capability_tiers: ['T0'],
      quiet_policy: 'ignore_for_explicit_reminder',
      budget_class: 'reminder',
    }),
    channelHub: async () => {
      secondChannelCalled = true;
    },
  });

  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.payload.ok, true);
  assert.equal(duplicate.payload.dropped, true);
  assert.equal(duplicate.payload.reason, 'event_already_sent');
  assert.equal(secondChannelCalled, false);
});

test('handleProactiveEventRequest drops reminder events when reminder delivery is disabled', async (t) => {
  const env = tempEnv(t, {
    HERMES_PROACTIVE_EVENTS_ENABLED: 'true',
    HERMES_PROACTIVE_REMINDERS_ENABLED: 'false',
  }, 'proactive-event-');
  setFeishuHomeDmTarget({
    platform: 'feishu',
    channel_type: 'dm',
    conversation_id: 'oc-home',
    sender_id: 'ou-home',
  }, env);

  let channelCalled = false;
  const result = await handleProactiveEventRequest({
    env,
    bodyText: JSON.stringify({
      event_id: 'reminder-1',
      kind: 'reminder',
      global_user_id: 'ou-home',
      channel: 'feishu',
      watch_scope: 'todo:1',
      reason: 'Explicit reminder is due: 去单位',
      evidence_refs: ['todo:1'],
      dedupe_key: 'reminder:1:20260701T090000',
      created_at: '2026-07-01T09:00:00+08:00',
      expires_at: '2026-07-01T10:00:00+08:00',
      deliverability: 'notify_allowed',
      allowed_capability_tiers: ['T0'],
      quiet_policy: 'ignore_for_explicit_reminder',
      budget_class: 'reminder',
    }),
    channelHub: async () => {
      channelCalled = true;
    },
  });

  assert.equal(result.status, 200);
  assert.equal(result.payload.ok, true);
  assert.equal(result.payload.dropped, true);
  assert.equal(result.payload.reason, 'reminder_delivery_disabled');
  assert.equal(channelCalled, false);
});

test('handleProactiveEventRequest rejects external events without the dedicated trusted queue', async (t) => {
  const env = tempEnv(t, {
    HERMES_PROACTIVE_EVENTS_ENABLED: 'true',
    HERMES_PROACTIVE_EXTERNAL_MCP_ENABLED: 'true',
  }, 'proactive-event-');
  setFeishuHomeDmTarget({
    platform: 'feishu',
    channel_type: 'dm',
    conversation_id: 'oc-home',
    sender_id: 'ou-home',
  }, env);

  let channelCalled = false;
  const result = await handleProactiveEventRequest({
    env,
    bodyText: JSON.stringify({
      event_id: 'fake-external-1',
      kind: 'forum_watch',
      global_user_id: 'ou-home',
      channel: 'feishu',
      watch_scope: 'thread:forum.example/123',
      reason: 'Caller claims a forum thread changed',
      evidence_refs: ['external_mcp_evidence:fake'],
      dedupe_key: 'thread:forum.example/123',
      created_at: '2026-07-01T09:00:00+08:00',
      expires_at: '2026-07-01T10:00:00+08:00',
      deliverability: 'notify_allowed',
      allowed_capability_tiers: ['T1', 'T2'],
      budget_class: 'external_mcp',
    }),
    channelHub: async () => {
      channelCalled = true;
    },
  });

  assert.equal(result.status, 200);
  assert.equal(result.payload.ok, true);
  assert.equal(result.payload.dropped, true);
  assert.equal(result.payload.reason, 'proactive_event_kind_requires_dedicated_pipeline');
  assert.equal(channelCalled, false);
});

test('handleOutboundRequest does not drain stale pending proactive messages during retired media route calls', async (t) => {
  const env = tempEnv(t, { PERSONAL_AGENT_REMINDER_DELIVERY_ENABLED: 'false' });
  appendPendingOutboundMessage({ text: '提醒一下：交房租', reason: 'send_failed:context expired' }, env);

  {
    const sentPayloads = [];
    const result = await handleOutboundRequest({
      bot: {
        async sendMessage(payload) {
          sentPayloads.push(payload);
        },
      },
      logger: {
        info() {},
        warn() {},
        error() {},
      },
      method: 'POST',
      url: '/outbound/send',
      bodyText: JSON.stringify({
        text: '图来了',
        media: { type: 'image', url: 'https://example.com/out.png' },
        force: true,
      }),
    });

    assert.equal(result.status, 200);
    assert.equal(result.payload.ok, true);
    assert.equal(result.payload.dropped, true);
    assert.equal(result.payload.reason, 'legacy_checkin_route_retired');
    assert.deepEqual(sentPayloads, []);
    assert.equal(drainPendingOutboundMessages(10, env).length, 1);
  }
});

test('handleOutboundRequest does not queue retired text proactive messages when cooldown is active', async (t) => {
  const env = tempEnv(t, {
    NODE_BRIDGE_OUTBOUND_RETRY_DELAY_MS: '1000',
  });
  setProactiveDispatchState({ nextAllowedAt: '2999-01-01T00:00:00.000Z' }, env);

  {
    const result = await handleOutboundRequest({
      bot: {
        async sendMessage() {
          throw new Error('should not send while cooldown is active');
        },
      },
      logger: {
        info() {},
        error() {},
      },
      method: 'POST',
      url: '/outbound/send',
      bodyText: JSON.stringify({ text: '稍后再提醒我一次' }),
    });

    assert.equal(result.status, 200);
    assert.equal(result.payload.dropped, true);
    assert.equal(result.payload.reason, 'legacy_checkin_route_retired');

    const earlyDrain = drainPendingOutboundMessages(10, env, Date.parse('2000-01-01T00:00:00.000Z'));
    assert.equal(earlyDrain.length, 0);

    const lateDrain = drainPendingOutboundMessages(10, env, Date.parse('3000-01-01T00:00:00.000Z'));
    assert.equal(lateDrain.length, 0);
  }
});

test('resolveStateDir defaults to project-local state directory', () => {
  const resolved = resolveStateDir({});
  assert.equal(resolved, path.join(PROJECT_ROOT, '.ran_agent_state'));
});

test('resolveStateDir rejects paths outside project workspace', () => {
  assert.throws(
    () => resolveStateDir({ RAN_AGENT_STATE_DIR: path.dirname(PROJECT_ROOT) }),
    /must stay inside project workspace/
  );
});

test('resolveStateDir accepts an external test root only with all three guards', (t) => {
  const externalStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ran-agent-state-guard-'));
  registerTestCleanup(t, () => fs.rmSync(externalStateDir, { recursive: true, force: true }));

  assert.equal(resolveStateDir({
    NODE_ENV: 'test',
    RAN_AGENT_ALLOW_TEST_STATE_DIR: '1',
    RAN_AGENT_STATE_DIR: externalStateDir,
  }), fs.realpathSync(externalStateDir));

  assert.throws(
    () => resolveStateDir({
      RAN_AGENT_ALLOW_TEST_STATE_DIR: '1',
      RAN_AGENT_STATE_DIR: externalStateDir,
    }),
    /must stay inside project workspace/
  );
  assert.throws(
    () => resolveStateDir({
      NODE_ENV: 'test',
      RAN_AGENT_STATE_DIR: externalStateDir,
    }),
    /test state guard/
  );
});

test('resolveStateDir rejects checkout and symlink escapes in test mode', (t) => {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ran-agent-state-escape-'));
  const linkedStateDir = path.join(testRoot, 'linked-state');
  fs.symlinkSync(PROJECT_ROOT, linkedStateDir, 'dir');
  registerTestCleanup(t, () => fs.rmSync(testRoot, { recursive: true, force: true }));
  const guardedEnv = {
    NODE_ENV: 'test',
    RAN_AGENT_ALLOW_TEST_STATE_DIR: '1',
  };

  assert.throws(
    () => resolveStateDir({
      ...guardedEnv,
      RAN_AGENT_STATE_DIR: path.join(PROJECT_ROOT, '.ran_agent_state'),
    }),
    /OS temporary directory/
  );
  assert.throws(
    () => resolveStateDir({
      ...guardedEnv,
      RAN_AGENT_STATE_DIR: linkedStateDir,
    }),
    /OS temporary directory/
  );
});
