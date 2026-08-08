import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { handleIncomingMessage } from '../../src/channelHub.mjs';
import { openCoreDatabase } from '../../src/core/coreDb.mjs';
import { createCoreContentHasher } from '../../src/core/packageB/packageBNodeDeliveryService.mjs';
import { readTimelineRecords } from '../../src/globalTimeline.mjs';
import { getAccountBindingKey } from '../../src/identityMap.mjs';
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
  await assert.rejects(handleIncomingMessage(message, {
    env,
    core,
    coreContentHasher: createCoreContentHasher({ keyId: 's7-test-key', key: 's7-test-secret' }),
    logger: quietLogger(),
    replyBackend: { async getReply() { return { replyText: '不应发送', media: null }; } },
    adapter: { async sendReply() { effects += 1; } },
  }), { code: 'CORE_NODE_ACTOR_UNAUTHORIZED' });
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
