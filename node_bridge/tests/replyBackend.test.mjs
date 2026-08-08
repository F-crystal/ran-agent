import test from 'node:test';
import assert from 'node:assert/strict';

// This suite uses deterministic local Hermes doubles; it explicitly opts out
// of the network verifier so assertions can isolate reply-pipeline behavior.
process.env.HERMES_SEMANTIC_VERIFIER_TEST_BYPASS = 'true';
import fs from 'node:fs';
import path from 'node:path';

import { createReplyBackend, getReplyBackendConfig } from '../src/replyBackend.mjs';
import { getEnvironmentPrivacyMode } from '../src/environmentSense.mjs';
import { createPendingAction, listPendingActions } from '../src/pendingActionState.mjs';
import { createOperationLedger } from '../src/operationLedger.mjs';
import { createTrustedExecutorAdapters } from '../src/trustedExecutorAdapters.mjs';
import { listStickers, saveStickersFromInbox } from '../src/stickerCatalog.mjs';
import { createIsolatedTestEnv } from './helpers/isolatedState.mjs';
import { createTrustedBridgeInformationalReportTask } from '../src/hermesTaskScope.mjs';
import { createFeishuMinutesDocumentExecutorAdapter } from '../src/feishuMinutesDocumentClient.mjs';

function tempStateEnv(t, extra = {}) {
  return createIsolatedTestEnv(t, {
    HERMES_ACTION_GATE_ENABLED: 'true',
    HERMES_ACTION_GATE_MODE: 'repair',
    HERMES_ACTION_PENDING_ENABLED: 'true',
    HERMES_ACTION_PENDING_TTL_MINUTES: '30',
    ...extra,
  }, 'reply-backend-');
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

test('manual AI daily digest uses a typed owner action and never enters media compatibility', async (t) => {
  const env = tempStateEnv(t, { RAN_AGENT_INTERNAL_CONTROL_SECRET: 'internal-secret', PYTHON_BACKEND_BASE_URL: 'http://127.0.0.1:8787' });
  const requests = [];
  const backend = createReplyBackend({
    env,
    fetchImpl: async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return { ok: true, status: 200, async json() { return { ok: true, authenticated: true, operationId: requests[0].operationId, effectId: 'ai-daily-digest:outbox-1', result: { delivery_status: 'sent' } }; } };
    },
    hermesImpl: async () => ({ reply_envelope: { schemaVersion: 1, message: '正在补发。', actionRequests: [{ requestRef: 'digest-1', actionType: 'ai_daily_digest.send', scope: { mode: 'manual', date: 'current_local_date' } }], activityRequest: null, claims: [], commitments: [] } }),
    ingestImpl: async () => ({ ok: true }), logger: { log() {}, warn() {} },
  });
  const result = await backend.getReply({ text: '请重新发送今日日报', sender_id: 'owner', conversation_id: 'home', platform: 'feishu', trusted_actor_context: { actorKey: 'actor:owner', owner: true, platform: 'feishu', conversationKey: 'feishu:home' } });
  assert.equal(result.replyText, '今日日报已补发。');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].actionType, 'ai_daily_digest.send');
  assert.deepEqual(requests[0].scope, { mode: 'manual', date: 'current_local_date' });
});

test('informational AI digest drops prohibited envelope actions before execution and releases the report body', async (t) => {
  const env = tempStateEnv(t);
  const calls = { trustedExecutor: 0, coreJob: 0, activity: 0, activityRepair: 0 };
  const logs = [];
  const semanticInputs = [];
  const backend = createReplyBackend({
    env,
    trustedActionExecutors: {
      supports() { calls.trustedExecutor += 1; return true; },
      async execute() { calls.trustedExecutor += 1; throw new Error('must not execute'); },
      verifyReceipt() { return { ok: false }; },
    },
    coreDurableJobExecutor: {
      supports(actionType) { return actionType === 'core.reflection'; },
      async execute() {
        calls.coreJob += 1;
        return { ok: true, receipt: { requestRef: 'core-1', actionType: 'core.reflection', jobId: 'job_digest_123456', actorKey: 'actor:owner', goalDigest: 'a'.repeat(64), status: 'active' } };
      },
    },
    activityFacade: {
      async handle() { calls.activity += 1; throw new Error('must not execute'); },
      async repairStart() { calls.activityRepair += 1; throw new Error('must not repair'); },
    },
    hermesImpl: async () => ({
      reply_envelope: {
        schemaVersion: 1,
        message: '某公司宣布生成式 AI 平台已完成新一轮升级。',
        actionRequests: [
          { requestRef: 'sticker-1', actionType: 'sticker_save', scope: { candidate: 'digest' } },
          { requestRef: 'core-1', actionType: 'core.reflection', scope: {} },
        ],
        activityRequest: { requestRef: 'activity-1', command: 'start_or_resume', goal: '继续外部活动', environmentHint: 'game' },
        claims: [{ type: 'reported_fact' }],
        commitments: [{ type: 'external_continue', requestRef: 'activity-1' }],
      },
    }),
    semanticVerifierImpl: async (input) => {
      semanticInputs.push(input);
      return { supported: true, unsupportedClaims: [], rewrite: '' };
    },
    ingestImpl: async () => ({ ok: true }),
    logger: { log(line) { logs.push(line); }, warn() {} },
  });

  const result = await backend.getReply(createTrustedBridgeInformationalReportTask({
    text: '根据这些 AI 新闻写日报。', route_hint: 'scheduled_ai_daily_digest', sender_id: 'owner', conversation_id: 'home', platform: 'feishu',
    trusted_actor_context: { actorKey: 'actor:owner', owner: true, platform: 'feishu', conversationKey: 'feishu:home' },
  }, 'scheduled_ai_daily_digest'), { semanticVerifierConfig: { enabled: true, timeoutMs: 100, maxRewriteChars: 600 } });

  assert.equal(result.replyText, '某公司宣布生成式 AI 平台已完成新一轮升级。');
  assert.deepEqual(calls, { trustedExecutor: 0, coreJob: 0, activity: 0, activityRepair: 0 });
  assert.deepEqual(listPendingActions({ env }), []);
  assert.equal(semanticInputs.length, 1);
  assert.deepEqual(semanticInputs[0].declarationTypes, ['claim:reported_fact']);
  const telemetryLine = logs.find((line) => line.startsWith('[hermes-informational-report] '));
  const telemetry = JSON.parse(telemetryLine.replace('[hermes-informational-report] ', ''));
  assert.equal(telemetry.route_hint, 'scheduled_ai_daily_digest');
  assert.equal(telemetry.action_claim_detection_skipped, true);
  assert.deepEqual(telemetry.prohibited_action_fields_dropped, ['actionRequests', 'activityRequest', 'commitments']);
  assert.equal(telemetry.informational_report_body_released, true);
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

test('createReplyBackend defers backend ingest until a durable outbox projection supplies its event id', async () => {
  const ingested = [];
  const backend = createReplyBackend({
    hermesImpl: async () => ({ reply_text: 'durable reply', follow_up_messages: [], media: null }),
    ingestImpl: async (payload) => {
      ingested.push(payload);
      return { ok: true };
    },
    logger: { log() {}, warn() {} },
  });

  const response = await backend.getReply({
    text: 'hello',
    sender_id: 'sender-1',
    conversation_id: 'conversation-1',
    platform: 'wechat',
  }, { deferIngest: true });

  assert.deepEqual(ingested, []);
  assert.equal(typeof response.backendProjection, 'function');
  await response.backendProjection({
    outboxId: 'outbox_0123456789abcdef0123456789abcdef',
    replyText: 'persisted durable reply',
  });
  assert.equal(ingested.length, 1);
  assert.equal(ingested[0].event_id, 'outbox_0123456789abcdef0123456789abcdef');
  assert.equal(ingested[0].reply_text, 'persisted durable reply');
});

test('createReplyBackend commits an envelope activity request through the bridge-owned facade', async () => {
  const calls = [];
  const backend = createReplyBackend({
    activityFacade: {
      async handle(request, actorContext) {
        calls.push({ request, actorContext });
        return {
          ok: true,
          requestRef: request.requestRef,
          action: 'started',
          receipt: {
            jobId: 'job_external_1',
            actorKey: actorContext.actorKey,
            goalDigest: 'a'.repeat(64),
            status: 'active',
          },
        };
      },
    },
    hermesImpl: async () => ({
      reply_envelope: {
        schemaVersion: 1,
        message: '好的，我会继续推进。',
        actionRequests: [],
        activityRequest: {
          requestRef: 'activity-1',
          command: 'start_or_resume',
          goal: '继续玩这个游戏直到第一关结束',
          environmentHint: 'game',
          preferences: { cadence: 'milestone' },
        },
        claims: [],
        commitments: [],
      },
    }),
    ingestImpl: async () => ({ ok: true }),
    logger: { log() {}, warn() {} },
  });

  await backend.getReply({
    text: '继续玩这个游戏直到第一关结束',
    sender_id: 'activity-owner',
    channel: 'wechat',
    trusted_actor_context: {
      actorKey: 'actor:owner',
      owner: true,
      platform: 'wechat',
      conversationKey: 'conversation:owner',
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].request.requestRef, 'activity-1');
  assert.equal(calls[0].actorContext.actorKey, 'actor:owner');
  assert.equal(calls[0].actorContext.owner, true);
});

test('createReplyBackend binds a started activity to the bridge-derived reply destination', async () => {
  const bindings = [];
  const backend = createReplyBackend({
    activityFacade: {
      async handle(_request, actorContext) {
        return {
          receipt: { jobId: 'autonomy_checkpoint_1', actorKey: actorContext.actorKey, goalDigest: 'a'.repeat(64), status: 'active' },
        };
      },
      async bindNotifyTarget(input) { bindings.push(input); return { ok: true }; },
    },
    hermesImpl: async () => ({
      reply_envelope: {
        schemaVersion: 1, message: '我会继续。', actionRequests: [],
        activityRequest: { requestRef: 'checkpoint-target', command: 'start_or_resume', goal: '继续玩这个游戏', environmentHint: 'game' },
        claims: [], commitments: [],
      },
    }),
    ingestImpl: async () => ({ ok: true }),
    logger: { log() {}, warn() {} },
  });

  await backend.getReply({
    text: '继续玩这个游戏', sender_id: 'sender-1', conversation_id: 'conversation-1', channel_type: 'dm', platform: 'wechat',
    trusted_actor_context: { actorKey: 'actor:owner', owner: true, platform: 'wechat', conversationKey: 'conversation:owner' },
  });

  assert.deepEqual(bindings, [{
    receipt: { jobId: 'autonomy_checkpoint_1', actorKey: 'actor:owner', goalDigest: 'a'.repeat(64), status: 'active' },
    actorContext: { actorKey: 'actor:owner', owner: true, platform: 'wechat', conversationKey: 'conversation:owner' },
    target: { platform: 'wechat', channelType: 'dm', conversationId: 'conversation-1', senderId: 'sender-1' },
  }]);
});

test('createReplyBackend releases an external checkpoint through semantic verification and privacy before delivery', async () => {
  const verifierInputs = [];
  const backend = createReplyBackend({
    semanticVerifierImpl: async (input) => {
      verifierInputs.push(input);
      return { supported: false, unsupportedClaims: ['claim:completed'], rewrite: '我已记录这次进展。' };
    },
  });

  const result = await backend.releaseExternalCheckpoint({
    candidate: {
      kind: 'core_external_activity_narration_candidate', status: 'ready', claim: 'completed',
      facts: [{ summary: 'Reached the next safe checkpoint.' }],
      receipts: [{ effect: 'terminal', outcome: 'completed', terminal: true, summary: 'Reached the next safe checkpoint.' }],
    },
    context: { activityId: 'autonomy_checkpoint_1', checkpointDigest: 'a'.repeat(64), notifyTarget: { platform: 'wechat', channelType: 'dm', conversationId: 'conversation-1', senderId: 'sender-1' }, revision: 2 },
  }, { semanticVerifierConfig: { enabled: true, timeoutMs: 100, maxRewriteChars: 600 } });

  assert.equal(verifierInputs.length, 1);
  assert.equal(result.replyText, '我已记录这次进展。');
  assert.equal(result.source, 'external_checkpoint');
  assert.equal(result.suppressSend, false);
});

test('createReplyBackend removes a declared future commitment when no durable activity receipt exists', async () => {
  const backend = createReplyBackend({
    hermesImpl: async () => ({
      reply_envelope: {
        schemaVersion: 1, message: '我会继续推进。', actionRequests: [], activityRequest: null,
        claims: [], commitments: [{ type: 'external_continue' }],
      },
    }),
    ingestImpl: async () => ({ ok: true }),
    logger: { log() {}, warn() {} },
  });

  const result = await backend.getReply({ text: '继续吧', sender_id: 'owner', conversation_id: 'owner', channel: 'wechat' });

  assert.equal(result.replyText, '这项后续工作尚未启动。');
  assert.equal(result.source, 'bridge_commitment_guard');
});

test('createReplyBackend performs one bounded bridge-side external start repair only through an existing standing-consent facade', async () => {
  const repairs = [];
  const backend = createReplyBackend({
    activityFacade: {
      async repairStart(input) {
        repairs.push(input);
        return {
          receipt: {
            jobId: 'job_external_repair_1', actorKey: input.actorContext.actorKey,
            goalDigest: 'a'.repeat(64), status: 'active', nextRunAt: '2026-07-11T00:00:00.000Z',
            terminalStates: ['completed', 'blocked', 'stopped', 'expired'],
          },
        };
      },
    },
    hermesImpl: async () => ({
      reply_envelope: {
        schemaVersion: 1, message: '我会继续推进。', actionRequests: [], activityRequest: null,
        claims: [], commitments: [{ type: 'external_continue', requestRef: 'external-repair-1' }],
      },
    }),
    ingestImpl: async () => ({ ok: true }), logger: { log() {}, warn() {} },
  });

  const result = await backend.getReply({
    text: '把当前已经授权的游戏继续完成', sender_id: 'owner', conversation_id: 'owner-conversation', channel: 'wechat',
    trusted_actor_context: { actorKey: 'actor:owner:0001', owner: true, platform: 'wechat', conversationKey: 'wechat:dm:owner' },
  });

  assert.equal(repairs.length, 1);
  assert.equal(repairs[0].requestRef, 'external-repair-1');
  assert.equal(repairs[0].commitment.type, 'external_continue');
  assert.equal(repairs[0].currentMessage.text, '把当前已经授权的游戏继续完成');
  assert.equal(result.replyText, '我会继续推进。');
  assert.equal(result.source, 'hermes');
});

test('createReplyBackend does not repair a future external commitment without a standing-consent facade', async () => {
  const backend = createReplyBackend({
    hermesImpl: async () => ({
      reply_envelope: {
        schemaVersion: 1, message: '我会继续推进。', actionRequests: [], activityRequest: null,
        claims: [], commitments: [{ type: 'external_continue', requestRef: 'external-no-consent' }],
      },
    }),
    ingestImpl: async () => ({ ok: true }), logger: { log() {}, warn() {} },
  });
  const result = await backend.getReply({
    text: '继续吧', sender_id: 'owner', conversation_id: 'owner', channel: 'wechat',
    trusted_actor_context: { actorKey: 'actor:owner:0001', owner: true, platform: 'wechat', conversationKey: 'wechat:dm:owner' },
  });
  assert.equal(result.source, 'bridge_commitment_guard');
  assert.equal(result.replyText, '这项后续工作尚未启动。');
});

test('createReplyBackend runs only an allowlisted Core durable request before releasing its matching commitment', async () => {
  const calls = [];
  const backend = createReplyBackend({
    coreDurableJobExecutor: {
      supports: (actionType) => actionType === 'core.reflection',
      async execute({ request, actorContext }) {
        calls.push({ request, actorContext });
        return {
          ok: true,
          receipt: {
            requestRef: request.requestRef, actionType: request.actionType,
            jobId: 'job_1234567890abcdef', actorKey: actorContext.actorKey,
            goalDigest: 'a'.repeat(64), status: 'active', nextRunAt: '2026-07-11T00:00:00.000Z',
          },
        };
      },
    },
    hermesImpl: async () => ({
      reply_envelope: {
        schemaVersion: 1, message: '我会在之后复盘这次聊天。', activityRequest: null,
        actionRequests: [{ requestRef: 'core-reflect-1', actionType: 'core.reflection', scope: {} }],
        claims: [], commitments: [{ type: 'continue_later', requestRef: 'core-reflect-1' }],
      },
    }),
    ingestImpl: async () => ({ ok: true }), logger: { log() {}, warn() {} },
  });

  const result = await backend.getReply({
    text: '之后帮我复盘一下', sender_id: 'owner', conversation_id: 'owner-conversation', channel: 'wechat',
    trusted_actor_context: { actorKey: 'actor:owner:0001', owner: true, platform: 'wechat', conversationKey: 'wechat:dm:owner' },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].request.actionType, 'core.reflection');
  assert.equal(result.replyText, '已安排聊天复盘。');
  assert.equal(result.source, 'bridge_core_job_ack');
});

test('createReplyBackend does not release a commitment for a forged or cross-reference durable receipt', async () => {
  const backend = createReplyBackend({
    activityFacade: {
      async handle(_request, actorContext) {
        return { receipt: { jobId: 'job_external_1', actorKey: actorContext.actorKey, goalDigest: 'a'.repeat(64), status: 'active' } };
      },
    },
    hermesImpl: async () => ({
      reply_envelope: {
        schemaVersion: 1, message: '我会继续推进。', actionRequests: [],
        activityRequest: { requestRef: 'external-real', command: 'start_or_resume', goal: '继续玩这个游戏', environmentHint: 'game' },
        claims: [], commitments: [{ type: 'continue_later', requestRef: 'external-forged' }],
      },
    }),
    ingestImpl: async () => ({ ok: true }), logger: { log() {}, warn() {} },
  });

  const result = await backend.getReply({
    text: '继续玩', sender_id: 'owner', conversation_id: 'owner-conversation', channel: 'wechat',
    trusted_actor_context: { actorKey: 'actor:owner:0001', owner: true, platform: 'wechat', conversationKey: 'wechat:dm:owner' },
  });

  assert.equal(result.replyText, '这项后续工作尚未启动。');
  assert.equal(result.source, 'bridge_commitment_guard');
});

test('createReplyBackend never promises a Core job after its private client fails', async () => {
  let calls = 0;
  const backend = createReplyBackend({
    coreDurableJobExecutor: {
      supports: (actionType) => actionType === 'core.night-cycle',
      async execute() { calls += 1; return { ok: false, reason: 'CORE_JOB_CREATE_FAILED', receipt: null }; },
    },
    hermesImpl: async () => ({
      reply_envelope: {
        schemaVersion: 1, message: '我明天会整理好。', activityRequest: null,
        actionRequests: [{ requestRef: 'core-night-1', actionType: 'core.night-cycle', scope: {} }],
        claims: [], commitments: [{ type: 'continue_later', requestRef: 'core-night-1' }],
      },
    }),
    ingestImpl: async () => ({ ok: true }), logger: { log() {}, warn() {} },
  });

  const result = await backend.getReply({
    text: '明天再整理', sender_id: 'owner', conversation_id: 'owner-conversation', channel: 'wechat',
    trusted_actor_context: { actorKey: 'actor:owner:0001', owner: true, platform: 'wechat', conversationKey: 'wechat:dm:owner' },
  });

  assert.equal(calls, 1);
  assert.equal(result.replyText, '这项后续工作尚未启动。');
  assert.equal(result.source, 'bridge_commitment_guard');
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

test('createReplyBackend handles explicit environment privacy mode toggles before Hermes', async (t) => {
  const env = tempStateEnv(t, { HERMES_ENVIRONMENT_CONTEXT_ENABLED: 'true' });
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

test('createReplyBackend routes a natural stop command only through the v2 activity facade', async (t) => {
  const env = tempStateEnv(t);
  let hermesCalled = false;
  const calls = [];
  const backend = createReplyBackend({
    env,
    hermesImpl: async () => {
      hermesCalled = true;
      return { reply_text: 'should not run', follow_up_messages: [], media: null };
    },
    activityFacade: {
      async handle(request, actor) {
        calls.push({ request, actor });
        return { action: 'stopped', receipt: { status: 'stopped' } };
      },
    },
    ingestImpl: async () => ({ ok: true }),
    logger: { log() {}, warn() {} },
  });

  const response = await backend.getReply({
    text: '停下这局',
    sender_id: 'conv-stop-mcp',
    conversation_id: 'conv-stop-mcp',
    channel: 'wechat',
    platform: 'wechat',
    trusted_actor_context: {
      actorKey: 'actor:owner:stop', conversationKey: 'conversation:wechat:stop', platform: 'wechat', owner: true,
    },
  });

  assert.equal(response.replyText, '已经停止这项外部活动。');
  assert.equal(response.source, 'bridge_external_activity_stop');
  assert.equal(hermesCalled, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].request.command, 'stop');
  assert.equal(calls[0].request.goal, '停下这局');
  assert.equal(Object.hasOwn(calls[0].request, 'globalUserId'), false);
});

function unverifiedClaimBackend(replyText, options = {}) {
  return createReplyBackend({
    env: { HERMES_ACTION_GATE_ENABLED: "true", HERMES_ACTION_GATE_MODE: options.mode || "enforce" },
    hermesImpl: async () => ({ reply_text: replyText, follow_up_messages: options.followUps || [], media: options.media || null, model: "test" }),
    actionRepairImpl: options.actionRepairImpl,
    resolveStickerAssetImpl: options.resolveStickerAssetImpl,
    ingestImpl: async () => ({ ok: true }), logger: options.logger || { log() {}, warn() {} },
  });
}

test("replyBackend records a claim-only gate without assigning an action type", async () => {
  const logs = [];
  const response = await unverifiedClaimBackend("我已经完整读完了。", { mode: "observe", logger: { log(value) { logs.push(String(value)); }, warn() {} } }).getReply({ text: "普通聊天", sender_id: "claim-log", channel: "wechat" });
  assert.equal(response.replyText, "我已经完整读完了。");
  const payload = JSON.parse(logs.find((line) => line.startsWith("[hermes-action-contract] ")).replace("[hermes-action-contract] ", ""));
  assert.equal(payload.contract_source, "no_action");
  assert.equal(payload.intent, "none");
});

test("URL prose is claim-only and is safely rewritten without a social repair", async () => {
  let repaired = false;
  const response = await unverifiedClaimBackend("我已经完整读完链接了。", { mode: "repair", actionRepairImpl: async () => { repaired = true; return { ok: true, status: "success" }; } }).getReply({ text: "https://xhslink.com/o/a", sender_id: "claim-url", channel: "wechat" });
  assert.equal(repaired, false);
  assert.equal(response.replyText, "尚未收到可验证的执行结果，暂不确认已完成。");
});

test("collapsed fragments remain one claim-only assistant turn", async () => {
  const backend = createReplyBackend({ env: { HERMES_ACTION_GATE_ENABLED: "true", HERMES_ACTION_GATE_MODE: "enforce" }, hermesImpl: async () => ({ reply_text: "普通说明", follow_up_messages: ["已经完整读完链接了。"] }), ingestImpl: async () => ({ ok: true }), logger: { log() {}, warn() {} } });
  const response = await backend.getReply({ text: "链接", sender_id: "claim-fragment", channel: "wechat" });
  assert.equal(response.replyText, "尚未收到可验证的执行结果，暂不确认已完成。");
  assert.deepEqual(response.followUpMessages, []);
});

test("social repair is forbidden when Hermes omitted a trusted result", async () => {
  let repaired = false;
  await unverifiedClaimBackend("我已经完整读完了。", { mode: "repair", actionRepairImpl: async () => { repaired = true; return { ok: true, status: "success" }; } }).getReply({ text: "读这个链接", sender_id: "no-social-repair", channel: "wechat" });
  assert.equal(repaired, false);
});

test("gateway-originated claim does not create a repair request", async (t) => {
  let repaired = false;
  const backend = createReplyBackend({ env: tempStateEnv(t, { HERMES_API_BASE_URL: "http://127.0.0.1:8642/v1", HERMES_API_KEY: "token", HERMES_REPLY_MODE: "api", HERMES_ACTION_GATE_ENABLED: "true", HERMES_ACTION_GATE_MODE: "repair" }), actionRepairImpl: async () => { repaired = true; return { ok: true, status: "success" }; }, ingestImpl: async () => ({ ok: true }), logger: { log() {}, warn() {} } });
  await backend.getReply({ text: "读链接", sender_id: "gateway-claim", channel: "wechat" }, { fetchImpl: async () => ({ ok: true, status: 200, async json() { return { choices: [{ message: { content: "我已经完整读完了。" } }] }; }, async text() { return ""; } }) });
  assert.equal(repaired, false);
});

test("claim-only failures do not invoke a default social reader", async () => {
  const response = await unverifiedClaimBackend("我已经完整读完了。", { mode: "repair" }).getReply({ text: "https://xhslink.com/o/b", sender_id: "no-default-reader", channel: "wechat" });
  assert.equal(response.source, "bridge_action_gate");
});

test("partial social wording is not upgraded to a complete claim", async () => {
  const response = await unverifiedClaimBackend("只读取到部分内容。", { mode: "enforce" }).getReply({ text: "链接", sender_id: "partial-social", channel: "wechat" });
  assert.equal(response.replyText, "只读取到部分内容。");
});

test("trusted compatibility partial handling stays in action-contract evidence tests", async () => {
  const response = await unverifiedClaimBackend("有些内容没有成功获取。", { mode: "enforce" }).getReply({ text: "链接", sender_id: "partial-evidence", channel: "wechat" });
  assert.equal(response.replyText, "有些内容没有成功获取。");
});

test("media prose without a trusted result is claim-only", async () => {
  const response = await unverifiedClaimBackend("我看到图片里是一张合同。", { mode: "repair" }).getReply({ text: "看图", sender_id: "media-claim", channel: "wechat", media: [{ type: "image" }] });
  assert.equal(response.replyText, "尚未收到可验证的执行结果，暂不确认已完成。");
});

test("valid sticker marker passes compatibility without a repair", async () => {
  const response = await unverifiedClaimBackend("给你一张\nRAN_MEDIA: {\"source\":\"sticker_catalog\",\"kind\":\"sticker\",\"stickerId\":\"stk_001\"}", { mode: "repair", resolveStickerAssetImpl: () => ({ stickerId: "stk_001", mime: "image/gif", fileName: "stk.gif", filePath: "/tmp/stk.gif" }) }).getReply({ text: "表情", sender_id: "sticker-marker", channel: "wechat" });
  assert.equal(response.replyText, "给你一张");
});

test("media generated prose without marker is safely rewritten", async () => {
  const response = await unverifiedClaimBackend("图片已经生成好了。", { mode: "repair" }).getReply({ text: "生成一张猫图", sender_id: "media-missing", channel: "wechat" });
  assert.equal(response.replyText, "尚未收到可验证的执行结果，暂不确认已完成。");
});

test("trusted WECHAT_MEDIA marker passes compatibility without a new generation", async () => {
  const response = await unverifiedClaimBackend("生成结果已准备好。\nWECHAT_MEDIA: {\"source\":\"media_generation_mcp\",\"kind\":\"image\",\"type\":\"image\",\"url\":\"https://example.test/safe.png\",\"fileName\":\"safe.png\"}", { mode: "repair" }).getReply({ text: "生成一张猫图", sender_id: "media-marker", channel: "wechat" });
  assert.equal(response.replyText, "生成结果已准备好。");
});

test("sticker prose without RAN_MEDIA is safely rewritten", async () => {
  const response = await unverifiedClaimBackend("给你发一个表情包。", { mode: "repair" }).getReply({ text: "表情", sender_id: "sticker-missing", channel: "wechat" });
  assert.equal(response.replyText, "尚未收到可验证的执行结果，暂不确认已完成。");
});

test("repair max-attempt setting cannot re-enable text-derived repair", async () => {
  let repaired = false;
  const response = await unverifiedClaimBackend("我已经完整读完了。", { mode: "repair", actionRepairImpl: async () => { repaired = true; return { ok: true, status: "success" }; } }).getReply({ text: "读链接", sender_id: "repair-max", channel: "wechat" });
  assert.equal(repaired, false);
  assert.equal(response.source, "bridge_action_gate");
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

test('createReplyBackend issues and verifies a real receipt before preserving a save claim', async (t) => {
  const env = tempStateEnv(t, { HERMES_ACTION_GATE_MODE: 'enforce' });
  const ledger = createOperationLedger({ env });
  let executedOperationId = '';
  const executors = createTrustedExecutorAdapters({
    ledger,
    adapters: [{
      issuer: 'bridge:python-personal-learning',
      actionTypes: ['memory.remember'],
      evidenceType: 'personal_learning_result',
      boundary: 'authenticated_private',
      async execute({ operation }) {
        executedOperationId = operation.operationId;
        return {
          authenticated: true,
          operationId: operation.operationId,
          ok: true,
          effectId: 'learning:reply:tone',
        };
      },
      validateResult: (result, operation) => (
        result?.authenticated === true
        && result.operationId === operation.operationId
        && typeof result.effectId === 'string'
      ),
      normalizeResult: (result) => ({ status: result.ok ? 'succeeded' : 'failed', effectId: result.effectId }),
    }],
  });
  const backend = createReplyBackend({
    env,
    operationLedger: ledger,
    trustedActionExecutors: executors,
    hermesImpl: async () => ({
      reply_text: '已经替你保存好了。',
      action_requests: [{
        requestRef: 'remember-1',
        actionType: 'memory.remember',
        scope: { subject_key: 'reply:tone', statement: '先说结论' },
      }],
      claims: [{ type: 'memory_saved', requestRef: 'remember-1' }],
    }),
    ingestImpl: async () => ({ ok: true }),
    logger: { log() {}, warn() {} },
  });

  const response = await backend.getReply({
    text: '记住这个偏好：先说结论',
    sender_id: 'owner',
    conversation_id: 'owner-conversation',
    channel: 'wechat',
    trusted_actor_context: {
      actorKey: 'actor:wechat:owner:0001',
      owner: true,
      platform: 'wechat',
      conversationKey: 'wechat:dm:conversation',
    },
  });

  assert.equal(response.replyText, '已经替你保存好了。');
  assert.match(executedOperationId, /^op_/);
  assert.equal(ledger.getOperation(executedOperationId).state, 'completed');
});

test('existing Feishu Minutes transcript becomes one read-back cloud document', async (t) => {
  const env = tempStateEnv(t, {
    HERMES_ACTION_GATE_MODE: 'enforce',
    FEISHU_LARK_CLI_IDENTITY: 'user',
  });
  const calls = [];
  const execFileImpl = async (_command, args) => {
    calls.push(args);
    const identity = { ok: true, identity: 'user' };
    if (args[0] === 'minutes') return { stdout: JSON.stringify({ ...identity, data: { items: [{ token: 'minute1' }] } }) };
    if (args[0] === 'drive') return { stdout: JSON.stringify({ ...identity, data: { results: [{ result_meta: { token: 'folder1' } }] } }) };
    if (args[1] === '+create') return { stdout: JSON.stringify({ ...identity, data: { document: { document_id: 'doc1' } } }) };
    if (args[1] === '+fetch') return { stdout: JSON.stringify({ ...identity, data: { content: '<title>个人成长｜录音整理</title><p>已回读。</p>' } }) };
    throw new Error('unexpected lark-cli call');
  };
  const backend = createReplyBackend({
    env,
    execFileImpl,
    hermesImpl: async () => ({
      reply_envelope: {
        schemaVersion: 1,
        message: '正在整理。',
        actionRequests: [{
          requestRef: 'minutes-doc-1',
          actionType: 'feishu.minutes_to_doc',
          scope: {
            minuteTitle: '个人成长',
            folderTitle: '中海油',
            documentTitle: '个人成长｜录音整理',
            contentXml: '<title>个人成长｜录音整理</title><callout emoji="💡" background-color="light-blue"><p>整理摘要</p></callout>',
          },
        }],
        activityRequest: null,
        claims: [],
        commitments: [],
      },
    }),
    ingestImpl: async () => ({ ok: true }),
    logger: { log() {}, warn() {} },
  });

  const response = await backend.getReply({
    text: '把妙记里的个人成长录音稿整理成云文档，放到中海油文件夹',
    sender_id: 'owner',
    conversation_id: 'owner-conversation',
    channel: 'wechat',
    trusted_actor_context: {
      actorKey: 'actor:wechat:owner:0001',
      owner: true,
      platform: 'wechat',
      conversationKey: 'wechat:dm:conversation',
    },
  });

  assert.equal(response.replyText, '已整理成云文档并放入目标文件夹。');
  assert.equal(response.source, 'bridge_feishu_minutes_document');
  assert.deepEqual(calls.map((args) => args.slice(0, 2)), [
    ['minutes', '+search'],
    ['drive', '+search'],
    ['docs', '+create'],
    ['docs', '+fetch'],
  ]);
});

test('Feishu Minutes document action rejects non-DocxXML wrappers before lark-cli', async () => {
  let calls = 0;
  const adapter = createFeishuMinutesDocumentExecutorAdapter({
    execFileImpl: async () => { calls += 1; },
  });
  await assert.rejects(adapter.execute({ operation: {
    operationId: 'op_minutes_invalid',
    actionType: 'feishu.minutes_to_doc',
    scope: {
      minuteTitle: '个人成长',
      folderTitle: '中海油',
      documentTitle: '个人成长｜录音整理',
      contentXml: '<root><title>个人成长｜录音整理</title><content><p>整理摘要</p></content></root>',
    },
  } }), { code: 'FEISHU_MINUTES_DOCUMENT_CONTENT_INVALID' });
  assert.equal(calls, 0);
});

test('createReplyBackend grounds personal learning in the trusted user turn before execution', async (t) => {
  const env = tempStateEnv(t, { HERMES_ACTION_GATE_MODE: 'enforce' });
  const ledger = createOperationLedger({ env });
  let calls = 0;
  const executors = createTrustedExecutorAdapters({
    ledger,
    adapters: [{
      issuer: 'bridge:python-personal-learning',
      actionTypes: ['memory.remember'],
      evidenceType: 'personal_learning_result',
      boundary: 'authenticated_private',
      async execute({ operation }) {
        calls += 1;
        return { authenticated: true, operationId: operation.operationId, ok: true, effectId: 'learning:forged' };
      },
      validateResult: () => true,
      normalizeResult: (result) => ({ status: 'succeeded', effectId: result.effectId }),
    }],
  });
  const backend = createReplyBackend({
    env,
    operationLedger: ledger,
    trustedActionExecutors: executors,
    hermesImpl: async () => ({
      reply_text: '已保存。',
      action_requests: [{
        requestRef: 'remember-forged',
        actionType: 'memory.remember',
        scope: { subject_key: 'medical:diagnosis', statement: '用户患有严重疾病' },
      }],
    }),
    ingestImpl: async () => ({ ok: true }),
    logger: { log() {}, warn() {} },
  });

  const response = await backend.getReply({
    text: '记住我喜欢先说结论',
    sender_id: 'owner',
    conversation_id: 'owner-conversation',
    channel: 'wechat',
    trusted_actor_context: {
      actorKey: 'actor:wechat:owner:0001',
      owner: true,
      platform: 'wechat',
      conversationKey: 'wechat:dm:conversation',
    },
  });

  assert.equal(calls, 0);
  assert.equal(response.replyText, '保存结果尚未返回，未写入长期记忆。');
});

test('createReplyBackend requires an explicit current-turn memory intent before direct learning promotion', async (t) => {
  const env = tempStateEnv(t, { HERMES_ACTION_GATE_MODE: 'enforce' });
  const ledger = createOperationLedger({ env });
  let calls = 0;
  const executors = createTrustedExecutorAdapters({
    ledger,
    adapters: [{
      issuer: 'bridge:python-personal-learning', actionTypes: ['memory.remember'],
      evidenceType: 'personal_learning_result', boundary: 'authenticated_private',
      async execute({ operation }) {
        calls += 1;
        return { authenticated: true, operationId: operation.operationId, ok: true, effectId: 'learning:one-off' };
      },
      validateResult: () => true,
      normalizeResult: (result) => ({ status: 'succeeded', effectId: result.effectId }),
    }],
  });
  const backend = createReplyBackend({
    env, operationLedger: ledger, trustedActionExecutors: executors,
    hermesImpl: async () => ({
      reply_text: '已保存。',
      action_requests: [{
        requestRef: 'remember-one-off', actionType: 'memory.remember',
        scope: { subject_key: 'reply:style', statement: '我喜欢先说结论' },
      }],
    }),
    ingestImpl: async () => ({ ok: true }), logger: { log() {}, warn() {} },
  });

  const response = await backend.getReply({
    text: '我喜欢先说结论。', sender_id: 'owner', conversation_id: 'owner-conversation', channel: 'wechat',
    trusted_actor_context: { actorKey: 'actor:wechat:owner:0001', owner: true, platform: 'wechat', conversationKey: 'wechat:dm:conversation' },
  });

  assert.equal(calls, 0);
  assert.equal(response.replyText, '保存结果尚未返回，未写入长期记忆。');
});

test('createReplyBackend replaces model future-work prose with a bridge-owned Core job acknowledgement', async () => {
  const backend = createReplyBackend({
    coreDurableJobExecutor: {
      supports: (actionType) => actionType === 'core.reflection',
      async execute({ request, actorContext }) {
        return { ok: true, receipt: {
          requestRef: request.requestRef, actionType: request.actionType,
          jobId: 'job_1234567890abcdef', actorKey: actorContext.actorKey,
          goalDigest: 'a'.repeat(64), status: 'active', nextRunAt: '2026-07-11T00:00:00.000Z',
        } };
      },
    },
    hermesImpl: async () => ({
      reply_envelope: {
        schemaVersion: 1, message: '我会在你睡着后把所有问题都解决。', activityRequest: null,
        actionRequests: [{ requestRef: 'core-ack-1', actionType: 'core.reflection', scope: {} }],
        claims: [], commitments: [{ type: 'continue_later', requestRef: 'core-ack-1' }],
      },
    }),
    ingestImpl: async () => ({ ok: true }), logger: { log() {}, warn() {} },
  });

  const result = await backend.getReply({
    text: '之后复盘一下', sender_id: 'owner', conversation_id: 'owner-conversation', channel: 'wechat',
    trusted_actor_context: { actorKey: 'actor:owner:0001', owner: true, platform: 'wechat', conversationKey: 'wechat:dm:owner' },
  });

  assert.equal(result.replyText, '已安排聊天复盘。');
  assert.equal(result.source, 'bridge_core_job_ack');
});

test('createReplyBackend lets Hermes handle high risk text when no pending executor exists', async (t) => {
  for (const { text, reply } of [
    { text: '现在发送给张三', reply: '我可以帮你整理内容，但没有发送。' },
    { text: '记住这个偏好', reply: '我会留意这个偏好。' },
  ]) {
    const env = tempStateEnv(t);
    let hermesCalled = false;
    const backend = createReplyBackend({
      env,
      hermesImpl: async () => {
        hermesCalled = true;
        return {
          reply_text: reply,
          follow_up_messages: [],
          media: null,
          model: 'deepseek-v4-flash',
        };
      },
      ingestImpl: async () => ({ ok: true }),
      logger: { log() {}, warn() {} },
    });

    const response = await backend.getReply({
      text,
      sender_id: `conv-no-pending-executor-${text.length}`,
      channel: 'wechat',
    });

    assert.equal(hermesCalled, true);
    assert.equal(response.replyText, reply);
    assert.equal(response.source, 'hermes');
    assert.equal(listPendingActions({ env }).length, 0);
  }
});

test('createReplyBackend repair mode creates pending for external sends without direct confirmation', async (t) => {
  const logs = [];
  let executed = false;
  const env = tempStateEnv(t, { HERMES_ACTION_GATE_MAX_REPAIR_ATTEMPTS: '1' });
  const backend = createReplyBackend({
    env,
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
  assert.equal(response.source, 'bridge_pending_action');
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
  assert.equal(response.replyText, '尚未收到可验证的执行结果，暂不确认已完成。');
  assert.equal(response.source, 'bridge_action_gate');
});

test('createReplyBackend directly executes explicitly authorized sticker save', async (t) => {
  const env = tempStateEnv(t);
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

test('createReplyBackend default executor saves explicit trusted sticker media', async (t) => {
  const env = tempStateEnv(t);
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

test('createReplyBackend default executor deletes explicit sticker id only', async (t) => {
  const env = tempStateEnv(t);
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

test('createReplyBackend refuses sticker delete without a clear sticker id', async (t) => {
  const env = tempStateEnv(t);
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

test('createReplyBackend creates pending action for ambiguous sticker save', async (t) => {
  const env = tempStateEnv(t);
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

test('createReplyBackend confirms pending action in same conversation and executes once', async (t) => {
  const env = tempStateEnv(t);
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

test('createReplyBackend cancels pending action without executing', async (t) => {
  const env = tempStateEnv(t);
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

test('createReplyBackend refuses expired and multiple pending confirmations', async (t) => {
  const env = tempStateEnv(t, { HERMES_ACTION_PENDING_TTL_MINUTES: '1' });
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
  assert.match(expired.replyText, /确认项已过期/);

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
  assert.match(multi.replyText, /存在多个待确认操作/);
});

test('createReplyBackend does not execute high risk actions in observe or enforce modes', async (t) => {
  for (const mode of ['observe', 'enforce']) {
    const env = tempStateEnv(t, { HERMES_ACTION_GATE_MODE: mode });
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

test('createReplyBackend does not execute existing pending confirmations in observe or enforce modes', async (t) => {
  for (const mode of ['observe', 'enforce']) {
    const env = tempStateEnv(t, { HERMES_ACTION_GATE_MODE: mode });
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
    assert.match(response.replyText, /未启用/);
    assert.equal(response.source, 'bridge_pending_action');
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

  assert.equal(response.replyText, 'hermes reply\n\n第二条');
  assert.deepEqual(response.followUpMessages, []);
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
