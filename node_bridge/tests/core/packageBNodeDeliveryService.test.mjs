import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { handleIncomingMessage } from '../../src/channelHub.mjs';
import { commitCoreCutover } from '../../src/core/coreCutover.mjs';
import { openCoreDatabase } from '../../src/core/coreDb.mjs';
import { seedCoreSystemSchedules } from '../../src/core/coreSystemSchedules.mjs';
import {
  createCoreContentHasher,
  deliverNodeTextThroughCore,
} from '../../src/core/packageB/packageBNodeDeliveryService.mjs';
import { readTimelineRecords } from '../../src/globalTimeline.mjs';
import { getAccountBindingKey, getHermesSessionId, shortHash } from '../../src/identityMap.mjs';
import { createIsolatedTestEnv } from '../helpers/isolatedState.mjs';
import { createTempCore, openTestInspector, rowCount } from './helpers/testCoreInspector.mjs';

function identityEnv(t, message, { owner = true } = {}) {
  const env = createIsolatedTestEnv(t, {}, 'ran-agent-core-node-s7-');
  env.RAN_AGENT_GLOBAL_TIMELINE_PATH = path.join(env.RAN_AGENT_STATE_DIR, 'timeline.jsonl');
  env.RAN_AGENT_IDENTITY_MAP_PATH = path.join(env.RAN_AGENT_STATE_DIR, 'identity-map.json');
  const key = getAccountBindingKey(message);
  fs.writeFileSync(env.RAN_AGENT_IDENTITY_MAP_PATH, JSON.stringify({
    schemaVersion: 2,
    bindings: {
      [key]: {
        platform: message.platform,
        senderHash: key.split(':')[1],
        globalUserId: 'user:ran',
        owner,
        provenance: 's7_synthetic_owner',
        createdAt: '2026-08-08T00:00:00.000Z',
      },
    },
  }));
  return env;
}

function quietLogger() {
  return { log() {}, warn() {}, error() {}, info() {} };
}

test('ChannelHub binding namespace coexists with the cutover system-owner binding and replays once', async (t) => {
  const message = {
    id: 'wechat-post-s12-binding', platform: 'wechat', conversation_id: 'wechat-owner-dm',
    stable_conversation_key: 'wechat:dm:owner', text: '验证绑定命名空间',
    created_at: Date.parse('2026-08-13T11:07:11.000Z'),
  };
  const ownerId = 'user:ran';
  const actorRef = 'wechat:owner:verified';
  const routeKey = createHash('sha256').update(`${message.platform}\u0000${message.conversation_id}`).digest('hex').slice(0, 32);
  const conversationKey = createHash('sha256').update(`${ownerId}\u0000${message.stable_conversation_key}`).digest('hex').slice(0, 32);
  const conversationId = `conversation:wechat:${conversationKey}`;
  const oldGenericBindingId = `binding:${routeKey}`;
  const { dbPath } = createTempCore(t, 'hermes-core-node-post-s12-binding-');
  const core = openCoreDatabase({ dbPath });
  core.migrate();
  await commitCoreCutover({
    core,
    input: {
      ownerId, authorizationRef: 'owner-approval:s12:test',
      watermark: '2026-08-13T11:00:00.000Z', committedAt: '2026-08-13T11:01:00.000Z',
      candidateSha: 'a'.repeat(40), migrationSnapshotDigest: `sha256:${'b'.repeat(64)}`,
      scheduleManifestDigest: `sha256:${'c'.repeat(64)}`,
      visibleBindingDigest: `sha256:${'d'.repeat(64)}`,
      ambiguousOutboxDisposition: 'terminal_no_resend', pendingOutboundDisposition: 'suppress',
    },
    apply: (tx) => seedCoreSystemSchedules(tx, {
      manifest: {
        timeZone: 'Asia/Shanghai',
        schedules: [{
          id: 'visible-owner', source: 'test', title: 'Visible owner schedule',
          taskKind: 'scheduled_instruction', visible: true, payloadRef: 'system-task:visible-owner',
          recurrence: { kind: 'daily', time: '20:00:00' },
        }],
      },
      ownerId, watermark: '2026-08-13T11:00:00.000Z', createdAt: '2026-08-13T11:01:00.000Z',
      visibleBinding: {
        conversationId, canonicalConversationKey: conversationId, actorRef,
        platform: 'wechat', sourceInstanceId: 'node-channel-hub:wechat',
        platformConversationBinding: `wechat:conversation:${routeKey}`,
        bindingId: oldGenericBindingId, destinationKind: 'user', destinationRef: 'system-owner-destination',
      },
    }),
  });
  let inspector = openTestInspector(dbPath);
  const systemBindingBefore = inspector.prepare('SELECT * FROM presentation_binding WHERE presentation_binding_id=?').get(oldGenericBindingId);
  inspector.close();

  let effects = 0;
  const input = {
    core, message, globalUserId: ownerId, actorContext: { owner: true, actorKey: actorRef },
    response: { replyText: '命名空间修复完成。', provider: 'hermes', model: 'test' },
    hashContent: createCoreContentHasher({ keyId: 'post-s12-test-key', key: 'post-s12-test-secret' }),
  };
  const first = await deliverNodeTextThroughCore({
    ...input,
    send: async () => {
      effects += 1;
      return { textStatus: 'sent', adapterReceiptRef: 'wechat:test:sent' };
    },
  });
  assert.equal(first.exchange.bindingId, `binding:channel-hub:v1:${routeKey}`);
  assert.notEqual(first.exchange.bindingId, oldGenericBindingId);
  assert.equal(first.delivery.state, 'sent');
  const replay = await deliverNodeTextThroughCore({
    ...input,
    send: async () => { throw new Error('terminal outbox must not resend'); },
  });
  assert.equal(replay.delivery.effectAttempted, false);
  assert.equal(effects, 1);
  await core.close();

  inspector = openTestInspector(dbPath);
  assert.deepEqual(
    inspector.prepare('SELECT * FROM presentation_binding WHERE presentation_binding_id=?').get(oldGenericBindingId),
    systemBindingBefore,
  );
  const bindings = inspector.prepare('SELECT presentation_binding_id,conversation_id,adapter_metadata_json FROM presentation_binding ORDER BY presentation_binding_id').all();
  assert.equal(bindings.length, 2);
  assert.ok(bindings.every((binding) => binding.conversation_id === conversationId));
  assert.deepEqual(bindings.map((binding) => JSON.parse(binding.adapter_metadata_json).protocol).sort(),
    ['channel-hub', 'core-system-schedule']);
  assert.equal(inspector.prepare("SELECT count(*) AS count FROM semantic_turn WHERE role='assistant'").get().count, 1);
  assert.equal(inspector.prepare('SELECT count(*) AS count FROM presentation_outbox').get().count, 1);
  assert.equal(inspector.prepare('SELECT state FROM presentation_outbox').get().state, 'sent');
  inspector.close();
});

test('synthetic Feishu text crosses Node and Core once across concurrency, reopen, and replay', async (t) => {
  const message = {
    id: 'feishu-s7-message-1',
    platform: 'feishu',
    channel_type: 'dm',
    conversation_id: 'feishu-s7-conversation',
    sender_id: 'feishu-s7-owner',
    text: '请给我一句本地 S7 回执',
    created_at: Date.parse('2026-08-08T00:00:00.000Z'),
  };
  const env = identityEnv(t, message);
  const { dbPath } = createTempCore(t, 'hermes-core-node-s7-');
  const hashContent = createCoreContentHasher({ keyId: 's7-test-key', key: 's7-test-secret' });
  let core = openCoreDatabase({ dbPath });
  core.migrate();
  let effects = 0;
  let releaseSend;
  let markSendStarted;
  const sendStarted = new Promise((resolve) => { markSendStarted = resolve; });
  const sendGate = new Promise((resolve) => { releaseSend = resolve; });
  const options = {
    env,
    core,
    coreContentHasher: hashContent,
    logger: quietLogger(),
    replyBackend: {
      async getReply() {
        return {
          replyText: 'S7 本地闭环已收到。',
          followUpMessages: [],
          media: null,
          source: 'hermes',
          provider: 'synthetic-provider',
          model: 'synthetic-model',
        };
      },
    },
    adapter: {
      async sendReply(payload) {
        effects += 1;
        assert.equal(payload.text, 'S7 本地闭环已收到。');
        markSendStarted();
        await sendGate;
        return { textStatus: 'sent', attachments: [], adapterReceiptRef: 'feishu:synthetic:s7:sent' };
      },
    },
  };

  const first = handleIncomingMessage(message, options);
  await sendStarted;
  const concurrent = handleIncomingMessage(message, options);
  releaseSend();
  const [firstResult, concurrentResult] = await Promise.all([first, concurrent]);
  assert.equal(firstResult.coreDelivery.state, 'sent');
  assert.equal(concurrentResult.coreDelivery.state, 'sent');
  assert.equal(effects, 1);
  assert.deepEqual(
    readTimelineRecords({ timelinePath: env.RAN_AGENT_GLOBAL_TIMELINE_PATH }).map((item) => item.role),
    ['user', 'assistant'],
  );

  await core.close();
  core = openCoreDatabase({ dbPath });
  const replay = await handleIncomingMessage(message, {
    ...options,
    core,
    adapter: { async sendReply() { throw new Error('terminal Core outbox must not resend'); } },
  });
  assert.deepEqual(replay.coreDelivery, {
    disposition: 'terminal',
    state: 'sent',
    effectAttempted: false,
    outboxId: replay.coreDelivery.outboxId,
  });
  assert.equal(effects, 1);
  await core.close();

  const inspector = openTestInspector(dbPath);
  assert.equal(rowCount(inspector, 'conversation'), 1);
  assert.equal(rowCount(inspector, 'ingress_event'), 1);
  assert.equal(rowCount(inspector, 'exchange'), 1);
  assert.equal(rowCount(inspector, 'provider_epoch'), 1);
  assert.equal(rowCount(inspector, 'semantic_turn'), 2);
  assert.equal(rowCount(inspector, 'presentation_outbox'), 1);
  assert.equal(inspector.prepare('SELECT state FROM presentation_outbox').get().state, 'sent');
  assert.equal(inspector.prepare(`SELECT count(*) AS count FROM journal_event
    WHERE event_type='package_b_provider_attempt_recorded'`).get().count, 1);
  assert.equal(inspector.prepare(`SELECT count(*) AS count FROM journal_event
    WHERE event_type='package_b_presentation_result_recorded'`).get().count, 1);
  inspector.close();
});

test('verified WeChat normal ingress commits one provider attempt, final, outbox, and adapter effect', async (t) => {
  const message = {
    id: 'wechat-owner-normal-1', platform: 'wechat', channel_type: 'dm',
    conversation_id: 'wechat-owner-conversation', sender_id: 'wechat-owner',
    text: '验证多前端 owner 路径', created_at: Date.parse('2026-08-14T00:00:00.000Z'),
  };
  const env = identityEnv(t, message);
  const { dbPath } = createTempCore(t, 'hermes-core-node-wechat-owner-');
  const core = openCoreDatabase({ dbPath });
  core.migrate();
  let providerAttempts = 0;
  let adapterEffects = 0;
  const result = await handleIncomingMessage(message, {
    env,
    core,
    coreContentHasher: createCoreContentHasher({ keyId: 'wechat-owner-key', key: 'wechat-owner-secret' }),
    logger: quietLogger(),
    replyBackend: {
      async getReply(input) {
        providerAttempts += 1;
        assert.equal(input.trusted_actor_context.owner, true);
        assert.equal(input.trusted_frontend_context.currentFrontend, 'wechat');
        return { replyText: 'WeChat owner 已验证。', media: null, provider: 'synthetic', model: 'test' };
      },
    },
    adapter: {
      async sendReply() {
        adapterEffects += 1;
        return { textStatus: 'sent', attachments: [], adapterReceiptRef: 'wechat:test:owner' };
      },
    },
  });
  assert.equal(result.coreDelivery.state, 'sent');
  assert.equal(providerAttempts, 1);
  assert.equal(adapterEffects, 1);
  await core.close();

  const inspector = openTestInspector(dbPath);
  assert.equal(rowCount(inspector, 'ingress_event'), 1);
  assert.equal(inspector.prepare("SELECT count(*) AS count FROM semantic_turn WHERE role='assistant'").get().count, 1);
  assert.equal(rowCount(inspector, 'presentation_outbox'), 1);
  assert.equal(inspector.prepare(`SELECT count(*) AS count FROM journal_event
    WHERE event_type='package_b_provider_attempt_recorded'`).get().count, 1);
  inspector.close();
});

test('Telegram owner ingress crosses the real Core repositories once', async (t) => {
  const message = {
    id: 'telegram-owner-core-red-1', platform: 'telegram', channel_type: 'dm',
    conversation_id: 'telegram-owner-conversation', sender_id: 'telegram-owner',
    stable_conversation_key: 'telegram:dm:telegram-owner',
    text: 'Core red test', created_at: Date.parse('2026-08-20T00:00:00.000Z'),
  };
  const env = identityEnv(t, message);
  const { dbPath } = createTempCore(t, 'hermes-core-node-telegram-red-');
  let core = openCoreDatabase({ dbPath });
  core.migrate();
  let adapterEffects = 0;
  const result = await handleIncomingMessage(message, {
    env,
    core,
    coreContentHasher: createCoreContentHasher({ keyId: 'telegram-red-key', key: 'telegram-red-secret' }),
    logger: quietLogger(),
    replyBackend: { async getReply() { return { replyText: 'Core red response', media: null, provider: 'synthetic', model: 'test' }; } },
    adapter: { async sendReply() { adapterEffects += 1; return { textStatus: 'sent', adapterReceiptRef: `telegram:message:${shortHash(987654321)}` }; } },
  });
  assert.equal(result.coreDelivery.state, 'sent');
  assert.equal(adapterEffects, 1);
  await core.close();

  core = openCoreDatabase({ dbPath });
  core.migrate();
  const replay = await handleIncomingMessage(message, {
    env,
    core,
    coreContentHasher: createCoreContentHasher({ keyId: 'telegram-red-key', key: 'telegram-red-secret' }),
    logger: quietLogger(),
    replyBackend: { async getReply() { return { replyText: 'Core red response', media: null, provider: 'synthetic', model: 'test' }; } },
    adapter: { async sendReply() { throw new Error('replay must not resend'); } },
  });
  assert.equal(replay.coreDelivery.state, 'sent');
  assert.equal(replay.coreDelivery.effectAttempted, false);
  assert.equal(adapterEffects, 1);
  await core.close();

  const inspector = openTestInspector(dbPath);
  assert.equal(rowCount(inspector, 'conversation'), 1);
  assert.equal(inspector.prepare("SELECT count(*) AS count FROM journal_event WHERE event_type='package_b_conversation_identity_bound'").get().count, 1);
  assert.equal(rowCount(inspector, 'ingress_event'), 1);
  assert.equal(inspector.prepare("SELECT count(*) AS count FROM journal_event WHERE event_type='package_b_ingress_committed'").get().count, 1);
  assert.equal(rowCount(inspector, 'exchange'), 1);
  assert.equal(rowCount(inspector, 'provider_epoch'), 1);
  assert.equal(inspector.prepare("SELECT count(*) AS count FROM semantic_turn WHERE role='assistant'").get().count, 1);
  assert.equal(rowCount(inspector, 'presentation_outbox'), 1);
  assert.equal(inspector.prepare("SELECT count(*) AS count FROM journal_event WHERE event_type='package_b_provider_attempt_recorded'").get().count, 1);
  assert.equal(inspector.prepare("SELECT count(*) AS count FROM journal_event WHERE event_type='package_b_final_semantic_committed'").get().count, 1);
  assert.equal(inspector.prepare("SELECT count(*) AS count FROM journal_event WHERE event_type='package_b_presentation_result_recorded'").get().count, 1);
  assert.equal(inspector.prepare('SELECT owner_id FROM conversation').get().owner_id, 'user:ran');
  const receiptPayload = inspector.prepare(`SELECT payload.payload_ref FROM journal_payload payload
    JOIN journal_event event ON event.journal_event_id=payload.journal_event_id
    WHERE event.event_type='package_b_presentation_result_recorded'`).get().payload_ref;
  assert.match(receiptPayload, /^telegram:message:[a-f0-9]{16}$/);
  assert.notEqual(receiptPayload, 'telegram:message:987654321');
  assert.notEqual(getHermesSessionId(message), getHermesSessionId({ ...message, platform: 'wechat' }));
  assert.match(getHermesSessionId(message), /^ran-agent-telegram-/);
});

test('local Core wiring rejects a non-owner before any Core fact or adapter effect', async (t) => {
  const message = {
    id: 'feishu-s7-non-owner', platform: 'feishu', channel_type: 'dm',
    conversation_id: 'feishu-s7-conversation', sender_id: 'feishu-s7-guest',
    text: '不应写入 Core', created_at: Date.parse('2026-08-08T01:00:00.000Z'),
  };
  const env = identityEnv(t, message, { owner: false });
  const { dbPath } = createTempCore(t, 'hermes-core-node-s7-non-owner-');
  const core = openCoreDatabase({ dbPath });
  core.migrate();
  let effects = 0;
  let providerAttempts = 0;
  const result = await handleIncomingMessage(message, {
    env,
    core,
    coreContentHasher: createCoreContentHasher({ keyId: 's7-test-key', key: 's7-test-secret' }),
    logger: quietLogger(),
    replyBackend: { async getReply() { providerAttempts += 1; return { replyText: '不应发送', media: null }; } },
    adapter: { async sendReply() { effects += 1; } },
  });
  assert.equal(result.suppressReason, 'owner_unverified');
  assert.equal(providerAttempts, 0);
  assert.equal(effects, 0);
  assert.equal(core.reader.journalEventCount(), 0);
  assert.equal(core.reader.ingressEventCount(), 0);
  await core.close();
});

test('unknown adapter outcome becomes durable ambiguous and never resends after reopen', async (t) => {
  const message = {
    id: 'feishu-s7-ambiguous', platform: 'feishu', channel_type: 'dm',
    conversation_id: 'feishu-s7-conversation', sender_id: 'feishu-s7-owner',
    text: '制造一个未知回执', created_at: Date.parse('2026-08-08T02:00:00.000Z'),
  };
  const env = identityEnv(t, message);
  const { dbPath } = createTempCore(t, 'hermes-core-node-s7-ambiguous-');
  const hashContent = createCoreContentHasher({ keyId: 's7-test-key', key: 's7-test-secret' });
  let core = openCoreDatabase({ dbPath });
  core.migrate();
  let effects = 0;
  const common = {
    env,
    coreContentHasher: hashContent,
    logger: quietLogger(),
    replyBackend: { async getReply() { return { replyText: '未知是否送达', media: null }; } },
  };
  const first = await handleIncomingMessage(message, {
    ...common,
    core,
    adapter: { async sendReply() { effects += 1; return {}; } },
  });
  assert.equal(first.coreDelivery.state, 'ambiguous');
  assert.equal(effects, 1);
  await core.close();

  core = openCoreDatabase({ dbPath });
  const replay = await handleIncomingMessage(message, {
    ...common,
    core,
    adapter: { async sendReply() { throw new Error('ambiguous Core outbox must not resend'); } },
  });
  assert.equal(replay.coreDelivery.state, 'ambiguous');
  assert.equal(replay.coreDelivery.effectAttempted, false);
  assert.equal(effects, 1);
  await core.close();
});

test('adapter exception becomes a terminal ambiguous receipt instead of a stranded dispatch', async (t) => {
  const message = {
    id: 'feishu-s7-adapter-exception', platform: 'feishu', channel_type: 'dm',
    conversation_id: 'feishu-s7-conversation', sender_id: 'feishu-s7-owner',
    text: '制造一个适配器异常', created_at: Date.parse('2026-08-08T03:00:00.000Z'),
  };
  const env = identityEnv(t, message);
  const { dbPath } = createTempCore(t, 'hermes-core-node-s7-exception-');
  const core = openCoreDatabase({ dbPath });
  core.migrate();
  const result = await handleIncomingMessage(message, {
    env,
    core,
    coreContentHasher: createCoreContentHasher({ keyId: 's7-test-key', key: 's7-test-secret' }),
    logger: quietLogger(),
    replyBackend: { async getReply() { return { replyText: '异常结果', media: null }; } },
    adapter: { async sendReply() { throw new Error('synthetic adapter failure'); } },
  });
  assert.equal(result.coreDelivery.state, 'ambiguous');
  assert.equal(result.coreDelivery.effectAttempted, true);
  await core.close();
  const inspector = openTestInspector(dbPath);
  assert.equal(inspector.prepare('SELECT state FROM presentation_outbox').get().state, 'ambiguous');
  assert.equal(inspector.prepare(`SELECT count(*) AS count FROM journal_event
    WHERE event_type='package_b_presentation_result_recorded'`).get().count, 1);
  inspector.close();
});
