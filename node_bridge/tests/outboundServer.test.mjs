import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  getOutboundServerConfig,
  handleEnvironmentSensorRequest,
  handleExternalMcpSystemQueueRequest,
  handleOutboundRequest,
  handleProactiveEventRequest,
  handleScheduledAiDigestRequest,
  resolveStateDir,
} from '../src/outboundServer.mjs';
import {
  addExternalMcpWatch,
  recordExternalMcpNotification,
} from '../src/externalMcp/watchlist.mjs';
import { appendExternalMcpEvidence } from '../src/externalMcp/evidenceLog.mjs';
import {
  appendPendingOutboundMessage,
  drainPendingOutboundMessages,
  setFeishuHomeDmTarget,
  setProactiveDispatchState,
} from '../src/runtimeState.mjs';

const PROJECT_ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const ORIGINAL_PROACTIVE_ENABLED = process.env.PERSONAL_AGENT_PROACTIVE_ENABLED;
const ORIGINAL_PROACTIVE_EVENTS_ENABLED = process.env.HERMES_PROACTIVE_EVENTS_ENABLED;
const ORIGINAL_PROACTIVE_REMINDERS_ENABLED = process.env.HERMES_PROACTIVE_REMINDERS_ENABLED;
const ORIGINAL_PROACTIVE_EXTERNAL_MCP_ENABLED = process.env.HERMES_PROACTIVE_EXTERNAL_MCP_ENABLED;

test.beforeEach(() => {
  process.env.PERSONAL_AGENT_PROACTIVE_ENABLED = 'true';
  process.env.HERMES_PROACTIVE_EVENTS_ENABLED = 'true';
  process.env.HERMES_PROACTIVE_REMINDERS_ENABLED = 'true';
  process.env.HERMES_PROACTIVE_EXTERNAL_MCP_ENABLED = 'true';
});

test.afterEach(() => {
  if (ORIGINAL_PROACTIVE_ENABLED === undefined) {
    delete process.env.PERSONAL_AGENT_PROACTIVE_ENABLED;
  } else {
    process.env.PERSONAL_AGENT_PROACTIVE_ENABLED = ORIGINAL_PROACTIVE_ENABLED;
  }
  if (ORIGINAL_PROACTIVE_EVENTS_ENABLED === undefined) {
    delete process.env.HERMES_PROACTIVE_EVENTS_ENABLED;
  } else {
    process.env.HERMES_PROACTIVE_EVENTS_ENABLED = ORIGINAL_PROACTIVE_EVENTS_ENABLED;
  }
  if (ORIGINAL_PROACTIVE_REMINDERS_ENABLED === undefined) {
    delete process.env.HERMES_PROACTIVE_REMINDERS_ENABLED;
  } else {
    process.env.HERMES_PROACTIVE_REMINDERS_ENABLED = ORIGINAL_PROACTIVE_REMINDERS_ENABLED;
  }
  if (ORIGINAL_PROACTIVE_EXTERNAL_MCP_ENABLED === undefined) {
    delete process.env.HERMES_PROACTIVE_EXTERNAL_MCP_ENABLED;
  } else {
    process.env.HERMES_PROACTIVE_EXTERNAL_MCP_ENABLED = ORIGINAL_PROACTIVE_EXTERNAL_MCP_ENABLED;
  }
});

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

test('handleEnvironmentSensorRequest accepts Sensor Logger payload with path token', async () => {
  const env = {
    RAN_AGENT_STATE_DIR: fs.mkdtempSync(path.join(PROJECT_ROOT, '.ran_agent_state', 'test-env-ingest-')),
    ENVIRONMENT_SENSOR_INGEST_TOKEN: 'secret-token',
  };
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

test('handleEnvironmentSensorRequest rejects missing or wrong token', async () => {
  const env = {
    RAN_AGENT_STATE_DIR: fs.mkdtempSync(path.join(PROJECT_ROOT, '.ran_agent_state', 'test-env-ingest-')),
    ENVIRONMENT_SENSOR_INGEST_TOKEN: 'secret-token',
  };
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

test('handleScheduledAiDigestRequest routes digest through existing Feishu DM flow', async () => {
  const templatePath = path.join(PROJECT_ROOT, 'src/personal_agent/prompts/ai_daily_digest_report.md');
  assert.equal(fs.existsSync(templatePath), true);

  const stateBaseDir = path.join(PROJECT_ROOT, '.ran_agent_state');
  fs.mkdirSync(stateBaseDir, { recursive: true });
  const tempStateDir = fs.mkdtempSync(path.join(stateBaseDir, 'scheduled-digest-'));
  const env = {
    ...process.env,
    RAN_AGENT_STATE_DIR: tempStateDir,
    FEISHU_LARK_CLI_BIN: 'lark-cli',
    FEISHU_LARK_CLI_IDENTITY: 'bot',
  };
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
  const result = await handleScheduledAiDigestRequest({
    logger: { info() {}, warn() {}, error() {}, log() {} },
    env,
    bodyText: JSON.stringify({ facts: '今日 AI 事实材料' }),
    channelHub: async (message, options) => {
      channelMessage = message;
      await options.adapter.sendReply({
        target: {
          channel_type: 'dm',
          conversation_id: message.conversation_id,
          sender_id: message.sender_id,
        },
        text: '给陛下呈上今日 AI 日报',
        message,
      });
      return { replyText: '给陛下呈上今日 AI 日报' };
    },
    execFileImpl: async (bin, args) => {
      calls.push({ bin, args });
      return { stdout: '{"ok":true}' };
    },
  });

  assert.equal(result.status, 200);
  assert.equal(result.payload.ok, true);
  assert.equal(channelMessage.platform, 'feishu');
  assert.equal(channelMessage.channel_type, 'dm');
  assert.equal(channelMessage.conversation_id, 'oc-home');
  assert.equal(channelMessage.sender_id, 'ou-home');
  assert.equal(channelMessage.route_hint, 'scheduled_ai_daily_digest');
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

test('handleExternalMcpSystemQueueRequest drops unregistered watch scopes', async () => {
  const env = {
    RAN_AGENT_STATE_DIR: fs.mkdtempSync(path.join(PROJECT_ROOT, '.ran_agent_state', 'external-mcp-queue-')),
    HERMES_PROACTIVE_EVENTS_ENABLED: 'true',
    HERMES_PROACTIVE_EXTERNAL_MCP_ENABLED: 'true',
    EXTERNAL_MCP_GATEWAY_ENABLED: 'true',
    EXTERNAL_MCP_SYSTEM_QUEUE_ENABLED: 'true',
  };
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

test('handleExternalMcpSystemQueueRequest routes registered watches as synthetic Hermes turns', async () => {
  const env = {
    RAN_AGENT_STATE_DIR: fs.mkdtempSync(path.join(PROJECT_ROOT, '.ran_agent_state', 'external-mcp-queue-')),
    HERMES_PROACTIVE_EVENTS_ENABLED: 'true',
    HERMES_PROACTIVE_EXTERNAL_MCP_ENABLED: 'true',
    EXTERNAL_MCP_GATEWAY_ENABLED: 'true',
    EXTERNAL_MCP_SYSTEM_QUEUE_ENABLED: 'true',
    FEISHU_LARK_CLI_BIN: 'lark-cli',
    FEISHU_LARK_CLI_IDENTITY: 'bot',
  };
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
  assert.match(channelMessage.text, /watched forum thread changed/);
  assert.match(channelMessage.text, new RegExp(`evidence_refs: ${evidence.evidence_ref}`));
  assert.match(channelMessage.text, /allowed_capability_tiers: T1,T2/);
  assert.equal(calls[0].bin, 'lark-cli');
  assert.equal(calls[0].args.includes('--user-id'), true);
  assert.equal(calls[0].args.includes('ou-home'), true);
});

test('handleExternalMcpSystemQueueRequest rejects caller-supplied untrusted evidence refs', async () => {
  const env = {
    RAN_AGENT_STATE_DIR: fs.mkdtempSync(path.join(PROJECT_ROOT, '.ran_agent_state', 'external-mcp-queue-')),
    HERMES_PROACTIVE_EVENTS_ENABLED: 'true',
    HERMES_PROACTIVE_EXTERNAL_MCP_ENABLED: 'true',
    EXTERNAL_MCP_GATEWAY_ENABLED: 'true',
    EXTERNAL_MCP_SYSTEM_QUEUE_ENABLED: 'true',
  };
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

test('handleExternalMcpSystemQueueRequest rate limits notify events before Hermes is called', async () => {
  const env = {
    RAN_AGENT_STATE_DIR: fs.mkdtempSync(path.join(PROJECT_ROOT, '.ran_agent_state', 'external-mcp-queue-')),
    HERMES_PROACTIVE_EVENTS_ENABLED: 'true',
    HERMES_PROACTIVE_EXTERNAL_MCP_ENABLED: 'true',
    EXTERNAL_MCP_GATEWAY_ENABLED: 'true',
    EXTERNAL_MCP_SYSTEM_QUEUE_ENABLED: 'true',
  };
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

test('handleExternalMcpSystemQueueRequest ignores caller-supplied time and topic for budgets', async () => {
  const env = {
    RAN_AGENT_STATE_DIR: fs.mkdtempSync(path.join(PROJECT_ROOT, '.ran_agent_state', 'external-mcp-queue-')),
    HERMES_PROACTIVE_EVENTS_ENABLED: 'true',
    HERMES_PROACTIVE_EXTERNAL_MCP_ENABLED: 'true',
    EXTERNAL_MCP_GATEWAY_ENABLED: 'true',
    EXTERNAL_MCP_SYSTEM_QUEUE_ENABLED: 'true',
  };
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
  process.env.PERSONAL_AGENT_PROACTIVE_ENABLED = 'false';
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
  const stateBaseDir = path.join(PROJECT_ROOT, '.ran_agent_state');
  fs.mkdirSync(stateBaseDir, { recursive: true });
  const tempStateDir = fs.mkdtempSync(path.join(stateBaseDir, 'node-bridge-outbound-'));
  const previousDelay = process.env.NODE_BRIDGE_OUTBOUND_SEGMENT_DELAY_MS;
  const previousStateDir = process.env.RAN_AGENT_STATE_DIR;
  process.env.NODE_BRIDGE_OUTBOUND_SEGMENT_DELAY_MS = '0';
  process.env.RAN_AGENT_STATE_DIR = tempStateDir;

  try {
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
  } finally {
    if (previousDelay === undefined) {
      delete process.env.NODE_BRIDGE_OUTBOUND_SEGMENT_DELAY_MS;
    } else {
      process.env.NODE_BRIDGE_OUTBOUND_SEGMENT_DELAY_MS = previousDelay;
    }
    if (previousStateDir === undefined) {
      delete process.env.RAN_AGENT_STATE_DIR;
    } else {
      process.env.RAN_AGENT_STATE_DIR = previousStateDir;
    }
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

test('handleProactiveEventRequest sends reminder events through Hermes egress', async () => {
  const env = {
    RAN_AGENT_STATE_DIR: fs.mkdtempSync(path.join(PROJECT_ROOT, '.ran_agent_state', 'proactive-event-')),
    HERMES_PROACTIVE_EVENTS_ENABLED: 'true',
    HERMES_PROACTIVE_REMINDERS_ENABLED: 'true',
    FEISHU_LARK_CLI_BIN: 'lark-cli',
    FEISHU_LARK_CLI_IDENTITY: 'bot',
  };
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

test('handleProactiveEventRequest drops reminder events when reminder delivery is disabled', async () => {
  const env = {
    RAN_AGENT_STATE_DIR: fs.mkdtempSync(path.join(PROJECT_ROOT, '.ran_agent_state', 'proactive-event-')),
    HERMES_PROACTIVE_EVENTS_ENABLED: 'true',
    HERMES_PROACTIVE_REMINDERS_ENABLED: 'false',
  };
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

test('handleProactiveEventRequest rejects external events without the dedicated trusted queue', async () => {
  const env = {
    RAN_AGENT_STATE_DIR: fs.mkdtempSync(path.join(PROJECT_ROOT, '.ran_agent_state', 'proactive-event-')),
    HERMES_PROACTIVE_EVENTS_ENABLED: 'true',
    HERMES_PROACTIVE_EXTERNAL_MCP_ENABLED: 'true',
  };
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

test('handleOutboundRequest does not drain stale pending proactive messages during retired media route calls', async () => {
  const stateBaseDir = path.join(PROJECT_ROOT, '.ran_agent_state');
  fs.mkdirSync(stateBaseDir, { recursive: true });
  const tempStateDir = fs.mkdtempSync(path.join(stateBaseDir, 'node-bridge-outbound-'));
  const previousStateDir = process.env.RAN_AGENT_STATE_DIR;
  const previousReminderDelivery = process.env.PERSONAL_AGENT_REMINDER_DELIVERY_ENABLED;
  process.env.RAN_AGENT_STATE_DIR = tempStateDir;
  process.env.PERSONAL_AGENT_REMINDER_DELIVERY_ENABLED = 'false';
  appendPendingOutboundMessage({ text: '提醒一下：交房租', reason: 'send_failed:context expired' }, process.env);

  try {
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
    assert.equal(drainPendingOutboundMessages(10, process.env).length, 1);
  } finally {
    if (previousStateDir === undefined) {
      delete process.env.RAN_AGENT_STATE_DIR;
    } else {
      process.env.RAN_AGENT_STATE_DIR = previousStateDir;
    }
    if (previousReminderDelivery === undefined) {
      delete process.env.PERSONAL_AGENT_REMINDER_DELIVERY_ENABLED;
    } else {
      process.env.PERSONAL_AGENT_REMINDER_DELIVERY_ENABLED = previousReminderDelivery;
    }
  }
});

test('handleOutboundRequest does not queue retired text proactive messages when cooldown is active', async () => {
  const stateBaseDir = path.join(PROJECT_ROOT, '.ran_agent_state');
  fs.mkdirSync(stateBaseDir, { recursive: true });
  const tempStateDir = fs.mkdtempSync(path.join(stateBaseDir, 'node-bridge-outbound-'));
  const env = {
    RAN_AGENT_STATE_DIR: tempStateDir,
    NODE_BRIDGE_OUTBOUND_RETRY_DELAY_MS: '1000',
  };
  const previousStateDir = process.env.RAN_AGENT_STATE_DIR;
  const previousRetryDelay = process.env.NODE_BRIDGE_OUTBOUND_RETRY_DELAY_MS;
  process.env.RAN_AGENT_STATE_DIR = env.RAN_AGENT_STATE_DIR;
  process.env.NODE_BRIDGE_OUTBOUND_RETRY_DELAY_MS = env.NODE_BRIDGE_OUTBOUND_RETRY_DELAY_MS;
  setProactiveDispatchState({ nextAllowedAt: '2999-01-01T00:00:00.000Z' }, env);

  try {
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
  } finally {
    if (previousStateDir === undefined) {
      delete process.env.RAN_AGENT_STATE_DIR;
    } else {
      process.env.RAN_AGENT_STATE_DIR = previousStateDir;
    }
    if (previousRetryDelay === undefined) {
      delete process.env.NODE_BRIDGE_OUTBOUND_RETRY_DELAY_MS;
    } else {
      process.env.NODE_BRIDGE_OUTBOUND_RETRY_DELAY_MS = previousRetryDelay;
    }
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
