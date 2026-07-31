import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { handleIncomingMessage } from '../src/channelHub.mjs';
import { createDurableOutbox } from '../src/durableOutbox.mjs';
import { createIsolatedTestEnv } from './helpers/isolatedState.mjs';
import { getOmbreCompatConfig } from '../src/ombreCompat/config.mjs';
import { buildCompatFinalTurnEvent, createCompatEmitter } from '../src/ombreCompat/emitter.mjs';
import { maybeEmitCompatFinalTurn } from '../src/ombreCompat/emitterSeam.mjs';
import { createCompatQueueStore, deriveSourceEventId } from '../src/ombreCompat/queueStore.mjs';

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const QUEUE_STORE_MODULE_URL = pathToFileURL(path.join(SRC_ROOT, 'ombreCompat', 'queueStore.mjs')).href;

const FIXED_NOW = new Date('2026-07-27T00:00:00.000Z');
const SILENT_LOGGER = { log() {}, warn() {}, error() {}, info() {} };

function compatEnv(t) {
  const env = createIsolatedTestEnv(t, {}, 'ran-agent-ombre-compat-');
  return {
    ...env,
    OMBRE_COMPAT_ENABLED: 'true',
    OMBRE_COMPAT_TEST_MODE: 'true',
    OMBRE_COMPAT_STATE_DIR: path.join(env.RAN_AGENT_STATE_DIR, 'ombre_compat'),
  };
}

function openStore(env) {
  const store = createCompatQueueStore({ dir: getOmbreCompatConfig(env).queueDir });
  store.open();
  return store;
}

function emitterInput(overrides = {}) {
  return {
    platform: 'wechat',
    conversationId: 'conv-1',
    exchangeId: 'ex-1',
    userText: '用户说的最后一句话',
    assistantText: '助手 gated 后的最终回复',
    scopeEnvelope: {
      actor: 'user:ran',
      platform: 'wechat',
      conversation_id: 'conv-1',
      channel_type: 'dm',
      visibility: 'private',
      valid_from: FIXED_NOW.toISOString(),
    },
    sensitivity: 'personal',
    trustedActionReceiptRefs: [],
    presentationState: 'not_presented',
    lifecycleState: 'current',
    responseSource: 'hermes',
    suppressSend: false,
    ...overrides,
  };
}

function readLogEntries(env) {
  const logPath = path.join(getOmbreCompatConfig(env).queueDir, 'queue-events.jsonl');
  return fs.readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test('the legacy reply path cannot create an unowned compatibility queue', async (t) => {
  const env = compatEnv(t);
  const config = getOmbreCompatConfig(env);
  const queueLog = path.join(config.queueDir, 'queue-events.jsonl');
  const gateEvidence = path.join(config.stateDir, 'gate-evidence.jsonl');

  await handleIncomingMessage({
    id: 'wx-emit-order-1',
    platform: 'wechat',
    channel_type: 'dm',
    conversation_id: 'wx-conv-order',
    sender_id: 'wx-user',
    text: '顺序断言',
    created_at: 1000,
  }, {
    env,
    logger: SILENT_LOGGER,
    replyBackend: {
      async getReply() {
        // Inside the final gate: no source event and no gate evidence may
        // exist yet — emission happens strictly after this resolves.
        assert.equal(fs.existsSync(queueLog), false);
        assert.equal(fs.existsSync(gateEvidence), false);
        return { replyText: 'gated 回复', followUpMessages: [], media: null };
      },
    },
  });

  assert.equal(fs.existsSync(queueLog), false);
  assert.equal(fs.existsSync(gateEvidence), false);
});

test('event id is stable across processes for the same final turn', () => {
  const local = buildCompatFinalTurnEvent({
    ...emitterInput(),
    sourceGateReceiptRef: 'sha256:' + '0'.repeat(64),
    emittedAt: FIXED_NOW.toISOString(),
  });
  const script = `import { deriveSourceEventId } from ${JSON.stringify(QUEUE_STORE_MODULE_URL)};\n`
    + 'console.log(deriveSourceEventId(JSON.parse(process.argv[1])));';
  const remote = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', script, JSON.stringify({
      platform: 'wechat',
      conversation_id: 'conv-1',
      exchange_id: 'ex-1',
    })],
    { encoding: 'utf8' },
  ).trim();
  assert.equal(local.event_id, remote);
  assert.equal(local.event_id, deriveSourceEventId({
    platform: 'wechat',
    conversation_id: 'conv-1',
    exchange_id: 'ex-1',
  }));
});

test('re-emitting the same final turn is an exact replay with no duplicate journey', (t) => {
  const env = compatEnv(t);
  const store = openStore(env);
  const emitter = createCompatEmitter({ env, store, clock: () => FIXED_NOW });

  const first = emitter.emitFinalTurn(emitterInput());
  assert.equal(first.disposition, 'new');
  assert.equal(first.item_ids.length, 1);

  const second = emitter.emitFinalTurn(emitterInput());
  assert.equal(second.disposition, 'exact_replay');
  assert.deepEqual(second.item_ids, first.item_ids);
  assert.equal(store.listItems().length, 1);
  store.close();
});

test('edit produces a higher source revision and supersede interrupts the old journey', (t) => {
  const env = compatEnv(t);
  const store = openStore(env);
  const emitter = createCompatEmitter({ env, store, clock: () => FIXED_NOW });

  const original = emitter.emitFinalTurn(emitterInput());
  const edited = emitter.emitFinalTurn(emitterInput({
    sourceRevision: 1,
    assistantText: '助手 gated 后的最终回复（编辑后）',
  }));
  assert.equal(edited.disposition, 'new');
  assert.notDeepEqual(edited.item_ids, original.item_ids);

  const source = store.getSource(original.event_id);
  assert.equal(source.current_revision, 1);
  assert.equal(source.revisions.length, 2);

  const effect = emitter.emitLifecycle({
    eventId: original.event_id,
    kind: 'supersede',
    ref: 'supersession://test/1',
    revision: 1,
  });
  assert.equal(effect.item_transitions.length, 2);
  assert.equal(store.getItem(original.item_ids[0]).queue_item_state, 'superseded');
  assert.equal(store.getItem(edited.item_ids[0]).queue_item_state, 'superseded');
  assert.equal(store.getSource(original.event_id).lifecycle_state, 'superseded');
  store.close();
});

test('the emitter performs no memory-meaning classification (structural)', () => {
  const allowedImports = new Set([
    'node:path',
    '../atomicState.mjs',
    './canonical.mjs',
    './config.mjs',
    './constants.mjs',
    './queueStore.mjs',
    './sourceEvent.mjs',
    './emitter.mjs',
  ]);
  for (const file of ['emitter.mjs', 'emitterSeam.mjs']) {
    const source = fs.readFileSync(path.join(SRC_ROOT, 'ombreCompat', file), 'utf8');
    const specifiers = [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]);
    for (const specifier of specifiers) {
      assert.ok(allowedImports.has(specifier), `${file} imports unexpected module ${specifier}`);
    }
    // No NLP / keyword-table / sentiment machinery may ever appear here.
    // (Comments are stripped first: the mandated header declaration names
    // the prohibited behaviours in order to disclaim them.)
    const codeOnly = source.replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(codeOnly, /nlp|sentiment|keyword|分词|情绪|浪漫/i);
  }
});

test('the seam is completely inert when the layer is not enabled', async (t) => {
  const env = createIsolatedTestEnv(t, {}, 'ran-agent-ombre-off-');
  const response = await handleIncomingMessage({
    id: 'wx-compat-off-1',
    platform: 'wechat',
    channel_type: 'dm',
    conversation_id: 'wx-conv-off',
    sender_id: 'wx-user',
    text: '默认关闭',
    created_at: 1000,
  }, {
    env,
    logger: SILENT_LOGGER,
    replyBackend: { async getReply() { return { replyText: '普通回复', followUpMessages: [], media: null }; } },
  });

  assert.equal(response.replyText, '普通回复');
  assert.equal(fs.existsSync(getOmbreCompatConfig(env).stateDir), false);
});

test('enabled config without an active runtime creates no unowned queue before durable delivery', async (t) => {
  const env = compatEnv(t);
  const config = getOmbreCompatConfig(env);
  const outbox = createDurableOutbox({ env });
  let ingressBeforeDeliver = null;
  // channelHub only consumes deliver/list; delegate so we can observe the
  // compat ingress state at the moment durable presentation starts.
  const outboxFacade = {
    reserve: (operation) => outbox.reserve(operation),
    deliver: (operation, hooks) => {
      ingressBeforeDeliver = fs.existsSync(path.join(config.queueDir, 'queue-events.jsonl'));
      return outbox.deliver(operation, hooks);
    },
    list: () => outbox.list(),
  };

  await handleIncomingMessage({
    id: 'wx-compat-on-1',
    platform: 'wechat',
    channel_type: 'dm',
    conversation_id: 'wx-conv-on',
    sender_id: 'wx-user',
    text: '启用后的消息',
    created_at: 1000,
  }, {
    env,
    outbox: outboxFacade,
    logger: SILENT_LOGGER,
    replyBackend: { async getReply() { return { replyText: '启用后的回复', followUpMessages: [], media: null }; } },
    adapter: {
      async sendReply() {
        return { textStatus: 'sent', attachments: [], adapterReceiptRef: 'wechat:test:compat' };
      },
    },
  });

  assert.equal(ingressBeforeDeliver, false);
  assert.equal(fs.existsSync(path.join(config.queueDir, 'queue-events.jsonl')), false);
});

test('inactive runtime does not create queue or evidence copies of final text', async (t) => {
  const env = compatEnv(t);
  const config = getOmbreCompatConfig(env);
  const userText = '这是用户的私密原文 SENTINEL-USER';
  const assistantText = '这是助手的私密回复 SENTINEL-ASSISTANT';

  await handleIncomingMessage({
    id: 'wx-compat-payload-1',
    platform: 'wechat',
    channel_type: 'dm',
    conversation_id: 'wx-conv-payload',
    sender_id: 'wx-user',
    text: userText,
    created_at: 1000,
  }, {
    env,
    logger: SILENT_LOGGER,
    replyBackend: { async getReply() { return { replyText: assistantText, followUpMessages: [], media: null }; } },
  });

  assert.equal(fs.existsSync(path.join(config.queueDir, 'queue-events.jsonl')), false);
  assert.equal(fs.existsSync(path.join(config.stateDir, 'gate-evidence.jsonl')), false);
});

test('the seam is inert without the formal runtime owner', async (t) => {
  const env = compatEnv(t);
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => { warnings.push(String(message)); };
  try {
    const result = await maybeEmitCompatFinalTurn({
      env,
      message: { id: 'ex-x', platform: 'wechat', channel_type: 'dm', conversation_id: 'conv-x', sender_id: 'wx-user', text: 'x' },
      normalizedMessage: { id: 'ex-x', platform: 'wechat', channel_type: 'dm', conversation_id: 'conv-x', sender_id: 'wx-user', text: 'x' },
      response: { replyText: 'y' },
      storeFactory: () => { throw new Error('simulated store failure'); },
    });
    assert.equal(result, null);
    assert.equal(warnings.length, 0);

    const inactive = await maybeEmitCompatFinalTurn({
      env: { ...env, OMBRE_COMPAT_ENABLED: 'false' },
      message: {},
      normalizedMessage: {},
      response: {},
      storeFactory: () => { throw new Error('must not be called when inactive'); },
    });
    assert.equal(inactive, null);
  } finally {
    console.warn = originalWarn;
  }
});
