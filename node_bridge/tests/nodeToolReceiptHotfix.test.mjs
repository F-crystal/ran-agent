import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { createReplyBackend } from '../src/replyBackend.mjs';
import { createOperationLedger } from '../src/operationLedger.mjs';
import { createFeishuActionExecutorAdapter } from '../src/feishuActionExecutor.mjs';
import { createTrustedExecutorAdapters } from '../src/trustedExecutorAdapters.mjs';
import { handleIncomingMessage } from '../src/channelHub.mjs';
import { bootstrapOwnerBinding } from '../src/identityMap.mjs';
import { sendChatToHermesGateway } from '../src/hermesGatewayClient.mjs';
import { createIsolatedTestEnv } from './helpers/isolatedState.mjs';

const OWNER = Object.freeze({
  actorKey: 'actor:owner:receipt-hotfix',
  owner: true,
  platform: 'feishu',
  conversationKey: 'owner:receipt-hotfix',
});

const SEND_SCOPE = Object.freeze({
  operationKey: 'send-report-2026-07-20',
  target: { type: 'chat', id: 'oc_target_12345678' },
  arguments: { text: '日报正文', identity: 'bot' },
  expectedEffect: 'external_send',
});

function actionEnvelope({ message = '我会陪你把这件事收好。日报已经发送。', scope = SEND_SCOPE, actionType = 'feishu.message.send', extra = {} } = {}) {
  return {
    reply_envelope: {
      schemaVersion: 1,
      message,
      actionRequests: [{ requestRef: 'send-report', actionType, scope, ...extra }],
      activityRequest: null,
      claims: [],
      commitments: [],
    },
  };
}

function message(platform = 'feishu', overrides = {}) {
  return {
    id: `${platform}-message-1`,
    text: '请把日报正文发送到 oc_target_12345678',
    sender_id: 'owner',
    conversation_id: `${platform}-conversation`,
    platform,
    trusted_actor_context: { ...OWNER, platform, conversationKey: `${platform}:conversation` },
    ...overrides,
  };
}

function backendWithCli(t, cliImpl, { hermesImpl, env: envOverrides = {}, now } = {}) {
  const env = createIsolatedTestEnv(t, {
    HERMES_ACTION_GATE_MODE: 'enforce',
    ...envOverrides,
  }, 'node-tool-receipt-');
  const ledger = createOperationLedger({ env, ...(now ? { now } : {}) });
  const executors = createTrustedExecutorAdapters({
    ledger,
    adapters: [createFeishuActionExecutorAdapter({ env, execFileImpl: cliImpl })],
    ...(now ? { now } : {}),
  });
  const backend = createReplyBackend({
    env,
    operationLedger: ledger,
    trustedActionExecutors: executors,
    hermesImpl: hermesImpl || (async () => actionEnvelope()),
    ingestImpl: async () => ({ ok: true }),
    logger: { log() {}, warn() {} },
  });
  return { backend, env, ledger };
}

function successCli(calls) {
  return async (bin, args) => {
    calls.push({ bin, args });
    return { stdout: JSON.stringify({ message_id: 'om_result_123', chat_id: 'oc_target_12345678' }), stderr: '' };
  };
}

test('Feishu and WeChat ingress share one Node receipt contract and confirm a successful action', async (t) => {
  for (const platform of ['feishu', 'wechat']) {
    const calls = [];
    const { backend } = backendWithCli(t, successCli(calls));
    const result = await backend.getReply(message(platform));
    assert.equal(calls.length, 1, platform);
    assert.equal(result.replyText, '我会陪你把这件事收好。\n\n飞书消息已发送。', platform);
    assert.equal(result.actionOutcomes[0].status, 'succeeded', platform);
    assert.equal(result.actionOutcomes[0].retryable, false, platform);
  }
});

test('business failure never confirms success', async (t) => {
  const calls = [];
  const { backend } = backendWithCli(t, async (bin, args) => {
    calls.push({ bin, args });
    return { stdout: JSON.stringify({ ok: false, error: { code: 230001 } }), stderr: '' };
  });
  const result = await backend.getReply(message());
  assert.equal(calls.length, 1);
  assert.equal(result.replyText, '我会陪你把这件事收好。\n\n飞书消息发送失败。');
  assert.equal(result.actionOutcomes[0].status, 'failed');
  assert.equal(result.actionOutcomes[0].retryable, true);
});

test('explicit message business error wins over a stale message id', async (t) => {
  const { backend } = backendWithCli(t, async () => ({
    stdout: JSON.stringify({ code: 230001, data: { message_id: 'om_stale' } }), stderr: '',
  }));
  const result = await backend.getReply(message());
  assert.equal(result.actionOutcomes[0].status, 'failed');
  assert.equal(result.replyText, '我会陪你把这件事收好。\n\n飞书消息发送失败。');
});

test('post-dispatch timeout is ambiguous and exact replay does not call Lark again', async (t) => {
  let calls = 0;
  const { backend } = backendWithCli(t, async () => {
    calls += 1;
    const error = new Error('timed out');
    error.code = 'ETIMEDOUT';
    error.killed = true;
    throw error;
  });
  const first = await backend.getReply(message());
  const second = await backend.getReply(message());
  assert.equal(calls, 1);
  assert.equal(first.replyText, '我会陪你把这件事收好。\n\n发送请求已经发出，但当前无法确认是否送达。');
  assert.equal(second.replyText, first.replyText);
  assert.equal(second.actionOutcomes[0].replayed, true);
  assert.equal(second.actionOutcomes[0].status, 'ambiguous');
});

test('ambiguous outcome cannot be retried by changing the model operation key', async (t) => {
  let calls = 0;
  let turn = 0;
  const { backend } = backendWithCli(t, async () => {
    calls += 1;
    const error = new Error('response lost after dispatch'); error.code = 'ECONNRESET'; throw error;
  }, {
    hermesImpl: async () => actionEnvelope({
      scope: { ...SEND_SCOPE, operationKey: turn++ === 0 ? 'model-key-one' : 'model-key-two' },
    }),
  });
  await backend.getReply(message());
  const second = await backend.getReply(message('feishu', {
    id: 'feishu-message-status',
    text: '刚才发送成功了吗？',
    conversation_id: 'oc_target_12345678',
  }));
  assert.equal(calls, 1);
  assert.deepEqual(second.actionOutcomes, []);
  assert.equal(second.replyText, '我会陪你把这件事收好。\n\n发送请求已经发出，但当前无法确认是否送达。');
});

test('a succeeded action may run again only after an explicit new resend instruction', async (t) => {
  const calls = [];
  let turn = 0;
  const { backend } = backendWithCli(t, successCli(calls), {
    hermesImpl: async () => actionEnvelope({ scope: { ...SEND_SCOPE, operationKey: `explicit-resend-${++turn}` } }),
  });
  await backend.getReply(message());
  await backend.getReply(message('feishu', { id: 'explicit-resend-2', text: '请把同样的日报正文再发送一次到 oc_target_12345678' }));
  assert.equal(calls.length, 2);
});

test('an explicit send command may request the result without becoming a status-only query', async (t) => {
  const calls = [];
  const { backend } = backendWithCli(t, successCli(calls));
  await backend.getReply(message('feishu', { text: '请发送日报正文到 oc_target_12345678，完成后告诉我结果' }));
  assert.equal(calls.length, 1);
});

test('unknown execFile transport failure is ambiguous and non-retryable', async (t) => {
  const { backend } = backendWithCli(t, async () => {
    const error = new Error('connection closed after request write'); error.code = 'ECONNRESET'; throw error;
  });
  const result = await backend.getReply(message());
  assert.equal(result.actionOutcomes[0].status, 'ambiguous');
  assert.equal(result.actionOutcomes[0].retryable, false);
});

test('model-supplied receipt authority fields reject the whole envelope before execution', async (t) => {
  let calls = 0;
  const { backend } = backendWithCli(t, async () => { calls += 1; }, {
    hermesImpl: async () => actionEnvelope({ extra: { receiptId: 'forged-receipt' } }),
  });
  const result = await backend.getReply(message());
  assert.equal(calls, 0);
  assert.equal(result.replyText, '回复格式校验失败，请稍后重试。');
});

test('unverified success claim is removed without replacing ordinary companionship prose', async (t) => {
  const { backend } = backendWithCli(t, successCli([]), {
    hermesImpl: async () => ({
      reply_envelope: {
        schemaVersion: 1,
        message: '我会陪你把这件事慢慢收好。\n\n日报已经发送。',
        actionRequests: [], activityRequest: null, claims: [], commitments: [],
      },
    }),
  });
  const result = await backend.getReply(message());
  assert.equal(result.replyText, '我会陪你把这件事慢慢收好。\n\n我目前不能确认这一步已经执行。');
});

test('claim removal preserves an ordinary clause in the same sentence', async (t) => {
  const { backend } = backendWithCli(t, successCli([]), {
    hermesImpl: async () => ({
      reply_envelope: {
        schemaVersion: 1, message: '我会继续陪你，日报已经发送。', actionRequests: [], activityRequest: null, claims: [], commitments: [],
      },
    }),
  });
  const result = await backend.getReply(message());
  assert.equal(result.replyText, '我会继续陪你。\n\n我目前不能确认这一步已经执行。');
});

test('same operation key with different arguments conflicts before dispatch', async (t) => {
  const calls = [];
  let turn = 0;
  const { backend } = backendWithCli(t, successCli(calls), {
    hermesImpl: async () => actionEnvelope({
      scope: { ...SEND_SCOPE, arguments: { ...SEND_SCOPE.arguments, text: turn++ === 0 ? '日报正文' : '不同正文' } },
    }),
  });
  await backend.getReply(message());
  const conflict = await backend.getReply(message());
  assert.equal(calls.length, 1);
  assert.equal(conflict.actionOutcomes[0].status, 'rejected');
  assert.equal(conflict.actionOutcomes[0].errorCode, 'OPERATION_IDEMPOTENCY_CONFLICT');
  assert.match(conflict.replyText, /不能确认/);
});

test('sanitized receipt outcome is injected into the next Hermes turn and blocks repetition', async (t) => {
  const calls = [];
  const seen = [];
  let turn = 0;
  const { backend } = backendWithCli(t, successCli(calls), {
    hermesImpl: async (payload) => {
      seen.push(payload);
      turn += 1;
      return turn === 1
        ? actionEnvelope()
        : { reply_envelope: { schemaVersion: 1, message: '我知道日报已发送，不再重复发送。', actionRequests: [], activityRequest: null, claims: [], commitments: [] } };
    },
  });
  await backend.getReply(message());
  const second = await backend.getReply(message('feishu', { id: 'feishu-message-2', text: '刚才那一步怎么样了？' }));
  assert.equal(calls.length, 1);
  assert.equal(second.replyText, '我知道日报已发送，不再重复发送。');
  assert.deepEqual(seen[1].action_outcomes, [{
    actionType: 'feishu.message.send', target: 'chat:d2f5176c76382258', status: 'succeeded',
    summary: '飞书消息已发送。', confirmedAt: seen[1].action_outcomes[0].confirmedAt, retryable: false,
  }]);
  assert.match(seen[1].action_outcomes[0].confirmedAt, /^2026-|^2027-/);
  assert.equal(JSON.stringify(seen[1]).includes('日报正文'), false);
  assert.equal(JSON.stringify(seen[1]).includes('om_result_123'), false);
});

test('an old success does not authorize an unrelated new success claim', async (t) => {
  let turn = 0;
  const { backend } = backendWithCli(t, successCli([]), {
    hermesImpl: async () => ++turn === 1
      ? actionEnvelope()
      : { reply_envelope: { schemaVersion: 1, message: '另一条通知已经发送。', actionRequests: [], activityRequest: null, claims: [], commitments: [] } },
  });
  await backend.getReply(message());
  const result = await backend.getReply(message('feishu', { id: 'new-send', text: '请处理另一条通知' }));
  assert.equal(result.replyText, '我目前不能确认这一步已经执行。');
});

test('the latest failed send outcome cannot be overwritten by an older success', async (t) => {
  let cliCall = 0;
  let turn = 0;
  const { backend } = backendWithCli(t, async () => {
    cliCall += 1;
    return cliCall === 1
      ? { stdout: JSON.stringify({ message_id: 'om_old_success' }), stderr: '' }
      : { stdout: JSON.stringify({ ok: false, code: 230001 }), stderr: '' };
  }, {
    hermesImpl: async () => {
      turn += 1;
      if (turn <= 2) return actionEnvelope({ scope: { ...SEND_SCOPE, operationKey: `send-${turn}`, arguments: { text: `日报正文${turn}` } } });
      return { reply_envelope: { schemaVersion: 1, message: '刚才已经发送。', actionRequests: [], activityRequest: null, claims: [], commitments: [] } };
    },
  });
  await backend.getReply(message());
  await backend.getReply(message('feishu', { id: 'send-two', text: '请发送日报正文2到 oc_target_12345678' }));
  const status = await backend.getReply(message('feishu', { id: 'send-status', text: '刚才发送成功了吗？' }));
  assert.equal(cliCall, 2);
  assert.equal(status.replyText, '飞书消息发送失败。');
});

test('a status question reuses the latest failed receipt instead of becoming unverified', async (t) => {
  let calls = 0;
  let turn = 0;
  const { backend } = backendWithCli(t, async () => {
    calls += 1;
    return { stdout: JSON.stringify({ ok: false, code: 230001 }), stderr: '' };
  }, {
    hermesImpl: async () => actionEnvelope({ scope: { ...SEND_SCOPE, operationKey: `failed-status-${++turn}` } }),
  });
  await backend.getReply(message());
  const status = await backend.getReply(message('feishu', {
    id: 'failed-status-query', text: '刚才发送成功了吗？', conversation_id: 'oc_target_12345678',
  }));
  assert.equal(calls, 1);
  assert.deepEqual(status.actionOutcomes, []);
  assert.equal(status.replyText, '我会陪你把这件事收好。\n\n飞书消息发送失败。');
});

test('next-turn claim that contradicts a succeeded receipt is corrected by the final gate', async (t) => {
  const calls = [];
  let turn = 0;
  const { backend } = backendWithCli(t, successCli(calls), {
    hermesImpl: async () => {
      turn += 1;
      return turn === 1
        ? actionEnvelope()
        : { reply_envelope: { schemaVersion: 1, message: '我还在陪你处理。\n\n刚才没有发送成功。', actionRequests: [], activityRequest: null, claims: [], commitments: [] } };
    },
  });
  await backend.getReply(message());
  const second = await backend.getReply(message('feishu', { id: 'feishu-message-2', text: '刚才发送成功了吗？' }));
  assert.equal(calls.length, 1);
  assert.equal(second.replyText, '我还在陪你处理。\n\n飞书消息已发送。');
});

test('ambiguous continuity prevents a later automatic replay', async (t) => {
  let calls = 0;
  let turn = 0;
  const seen = [];
  const { backend } = backendWithCli(t, async () => {
    calls += 1;
    const error = new Error('timeout'); error.code = 'ETIMEDOUT'; error.killed = true; throw error;
  }, {
    hermesImpl: async (payload) => {
      seen.push(payload);
      turn += 1;
      return turn === 1
        ? actionEnvelope({ message: '已经发送。' })
        : { reply_envelope: { schemaVersion: 1, message: '这一步结果仍然未知，我不会自动重试。', actionRequests: [], activityRequest: null, claims: [], commitments: [] } };
    },
  });
  await backend.getReply(message());
  const second = await backend.getReply(message('feishu', { id: 'feishu-message-2', text: '继续' }));
  assert.equal(calls, 1);
  assert.equal(seen[1].action_outcomes[0].status, 'ambiguous');
  assert.equal(second.actionOutcomes.length, 0);
});

test('document update uses the same receipt path and never persists content or raw CLI result', async (t) => {
  const calls = [];
  const secretContent = '<p>private-report-body</p>';
  const scope = {
    operationKey: 'update-report-2026-07-20',
    target: { type: 'document', id: 'doccnTarget12345678' },
    arguments: { command: 'append', content: secretContent, identity: 'user' },
    expectedEffect: 'persistent_update',
  };
  const { backend, ledger } = backendWithCli(t, async (bin, args) => {
    calls.push({ bin, args });
    return { stdout: JSON.stringify({ ok: true, data: { result: 'success', updated_blocks_count: 1, raw: 'private-raw-result' } }), stderr: '' };
  }, {
    hermesImpl: async () => actionEnvelope({ message: '文档已经更新。', actionType: 'feishu.document.update', scope }),
  });
  const result = await backend.getReply(message('wechat', { text: '请更新文档 doccnTarget12345678，追加日报内容' }));
  assert.equal(result.replyText, '飞书文档已更新。');
  assert.deepEqual(calls[0].args.slice(0, 6), ['docs', '+update', '--api-version', 'v2', '--doc', 'doccnTarget12345678']);
  const persisted = fs.readFileSync(ledger.target, 'utf8');
  assert.equal(persisted.includes(secretContent), false);
  assert.equal(persisted.includes('private-raw-result'), false);
});

test('unsupported document command is rejected before execFile dispatch', async (t) => {
  let calls = 0;
  const scope = {
    operationKey: 'unsupported-doc-command', target: { type: 'document', id: 'doccnTarget12345678' },
    arguments: { command: 'overwrite', content: 'replace everything' }, expectedEffect: 'persistent_update',
  };
  const { backend } = backendWithCli(t, async () => { calls += 1; }, {
    hermesImpl: async () => actionEnvelope({ message: '文档已更新。', actionType: 'feishu.document.update', scope }),
  });
  const result = await backend.getReply(message('wechat', { text: '请更新文档 doccnTarget12345678' }));
  assert.equal(calls, 0);
  assert.equal(result.actionOutcomes[0].status, 'rejected');
  assert.equal(result.actionOutcomes[0].retryable, false);
});

test('indeterminate document business JSON is ambiguous', async (t) => {
  const scope = {
    operationKey: 'indeterminate-doc-result', target: { type: 'document', id: 'doccnTarget12345678' },
    arguments: { command: 'append', content: 'one line' }, expectedEffect: 'persistent_update',
  };
  const { backend } = backendWithCli(t, async () => ({ stdout: JSON.stringify({ ok: true, data: {} }), stderr: '' }), {
    hermesImpl: async () => actionEnvelope({ message: '文档已更新。', actionType: 'feishu.document.update', scope }),
  });
  const result = await backend.getReply(message('wechat', { text: '请更新文档 doccnTarget12345678，追加一行' }));
  assert.equal(result.actionOutcomes[0].status, 'ambiguous');
  assert.equal(result.actionOutcomes[0].retryable, false);
});

test('daily report dispatch timeout is ambiguous, visible, continuous, and non-replayable', async (t) => {
  const env = createIsolatedTestEnv(t, {
    HERMES_ACTION_GATE_MODE: 'enforce',
    RAN_AGENT_INTERNAL_CONTROL_SECRET: 'test-control-secret',
    PYTHON_BACKEND_BASE_URL: 'http://127.0.0.1:8787',
  }, 'daily-receipt-');
  let calls = 0;
  const backend = createReplyBackend({
    env,
    fetchImpl: async () => {
      calls += 1;
      const error = new Error('unknown failure after fetch started'); error.code = 'EPIPE'; throw error;
    },
    hermesImpl: async () => actionEnvelope({
      message: '今日日报已补发。',
      actionType: 'ai_daily_digest.send',
      scope: { operationKey: 'daily-2026-07-20', mode: 'manual', date: 'current_local_date' },
    }),
    ingestImpl: async () => ({ ok: true }),
    logger: { log() {}, warn() {} },
  });
  const input = message('feishu', { text: '请重新补发今日日报' });
  const first = await backend.getReply(input);
  const second = await backend.getReply(input);
  assert.equal(calls, 1);
  assert.equal(first.replyText, '日报发送请求已经发出，但当前无法确认是否送达。');
  assert.equal(first.actionOutcomes[0].status, 'ambiguous');
  assert.equal(second.actionOutcomes[0].replayed, true);
});

test('ambiguous daily outcome cannot be retried with a new model key on a status question', async (t) => {
  const env = createIsolatedTestEnv(t, {
    HERMES_ACTION_GATE_MODE: 'enforce', RAN_AGENT_INTERNAL_CONTROL_SECRET: 'test-control-secret',
    PYTHON_BACKEND_BASE_URL: 'http://127.0.0.1:8787',
  }, 'daily-cross-key-');
  let fetchCalls = 0;
  let turn = 0;
  const backend = createReplyBackend({
    env,
    fetchImpl: async () => { fetchCalls += 1; const error = new Error('lost response'); error.code = 'EPIPE'; throw error; },
    hermesImpl: async () => actionEnvelope({
      actionType: 'ai_daily_digest.send', message: '今日日报已补发。',
      scope: { operationKey: `daily-ambiguous-${++turn}`, mode: 'manual', date: 'current_local_date' },
    }),
    ingestImpl: async () => ({ ok: true }), logger: { log() {}, warn() {} },
  });
  await backend.getReply(message('feishu', { text: '请重新补发今日日报' }));
  const status = await backend.getReply(message('feishu', { id: 'daily-status', text: '刚才日报发送成功了吗？' }));
  assert.equal(fetchCalls, 1);
  assert.deepEqual(status.actionOutcomes, []);
  assert.equal(status.replyText, '日报发送请求已经发出，但当前无法确认是否送达。');
});

test('an ambiguous daily outcome does not block a new natural day', async (t) => {
  const env = createIsolatedTestEnv(t, {
    HERMES_ACTION_GATE_MODE: 'enforce', RAN_AGENT_INTERNAL_CONTROL_SECRET: 'test-control-secret',
    PYTHON_BACKEND_BASE_URL: 'http://127.0.0.1:8787',
  }, 'daily-cross-day-');
  let fetchCalls = 0;
  let turn = 0;
  let nowMs = Date.parse('2026-07-20T02:00:00.000Z');
  const backend = createReplyBackend({
    env,
    now: () => new Date(nowMs),
    fetchImpl: async () => { fetchCalls += 1; const error = new Error('lost response'); error.code = 'EPIPE'; throw error; },
    hermesImpl: async () => actionEnvelope({
      actionType: 'ai_daily_digest.send', message: '今日日报已补发。',
      scope: { operationKey: `daily-day-${++turn}`, mode: 'manual', date: 'current_local_date' },
    }),
    ingestImpl: async () => ({ ok: true }), logger: { log() {}, warn() {} },
  });
  await backend.getReply(message('feishu', { text: '请重新补发今日日报', created_at: '2026-07-20T02:00:00.000Z' }));
  nowMs = Date.parse('2026-07-21T02:00:00.000Z');
  await backend.getReply(message('feishu', { id: 'daily-next-day', text: '请重新补发今日日报', created_at: '2026-07-21T02:00:00.000Z' }));
  assert.equal(fetchCalls, 2);
});

test('distinct daily operation keys are not collapsed by Feishu equivalence matching', async (t) => {
  const env = createIsolatedTestEnv(t, {
    HERMES_ACTION_GATE_MODE: 'enforce', RAN_AGENT_INTERNAL_CONTROL_SECRET: 'test-control-secret',
    PYTHON_BACKEND_BASE_URL: 'http://127.0.0.1:8787',
  }, 'daily-distinct-');
  let fetchCalls = 0;
  let turn = 0;
  const backend = createReplyBackend({
    env,
    fetchImpl: async (_url, init) => {
      fetchCalls += 1;
      const body = JSON.parse(init.body);
      return { ok: true, async json() { return { ok: true, authenticated: true, operationId: body.operationId, effectId: `daily:${fetchCalls}` }; } };
    },
    hermesImpl: async () => actionEnvelope({
      actionType: 'ai_daily_digest.send', message: '今日日报已补发。',
      scope: { operationKey: `daily-${++turn}`, mode: 'manual', date: 'current_local_date' },
    }),
    ingestImpl: async () => ({ ok: true }), logger: { log() {}, warn() {} },
  });
  const input = message('feishu', { text: '请重新补发今日日报' });
  await backend.getReply(input);
  await backend.getReply({ ...input, id: 'daily-new-operation', text: '请再补发一次今日日报' });
  assert.equal(fetchCalls, 2);
});

test('daily report multi-action reply preserves ordinary text and every receipt outcome', async (t) => {
  const env = createIsolatedTestEnv(t, {
    HERMES_ACTION_GATE_MODE: 'enforce', RAN_AGENT_INTERNAL_CONTROL_SECRET: 'test-control-secret',
    PYTHON_BACKEND_BASE_URL: 'http://127.0.0.1:8787',
  }, 'daily-multi-action-');
  const docScope = {
    operationKey: 'daily-doc-update', target: { type: 'document', id: 'doccnTarget12345678' },
    arguments: { command: 'append', content: '新增日报条目' }, expectedEffect: 'persistent_update',
  };
  const backend = createReplyBackend({
    env,
    execFileImpl: async () => ({ stdout: JSON.stringify({ ok: true, data: { result: 'success', updated_blocks_count: 1 } }), stderr: '' }),
    fetchImpl: async () => ({ ok: false, async json() { return { ok: false, error: 'delivery failed' }; } }),
    hermesImpl: async () => ({ reply_envelope: {
      schemaVersion: 1, message: '我会继续陪你处理。文档已更新，日报已发送。',
      actionRequests: [
        { requestRef: 'doc-update', actionType: 'feishu.document.update', scope: docScope },
        { requestRef: 'daily-send', actionType: 'ai_daily_digest.send', scope: { operationKey: 'daily-send', mode: 'manual', date: 'current_local_date' } },
      ], activityRequest: null, claims: [], commitments: [],
    } }),
    ingestImpl: async () => ({ ok: true }), logger: { log() {}, warn() {} },
  });
  const result = await backend.getReply(message('wechat', { text: '请补充文档 doccnTarget12345678，然后发送今日日报' }));
  assert.equal(result.replyText, '我会继续陪你处理。\n\n飞书文档已更新。\n\n日报生成或发送失败，未确认送达。');
  assert.deepEqual(result.actionOutcomes.map((item) => item.status), ['succeeded', 'failed']);
});

test('pre-dispatch rejection is visible in next-turn controlled continuity', async (t) => {
  const seen = [];
  let turn = 0;
  const { backend } = backendWithCli(t, successCli([]), {
    hermesImpl: async (payload) => {
      seen.push(payload);
      return ++turn === 1 ? actionEnvelope() : { reply_envelope: { schemaVersion: 1, message: '我不能确认已执行。', actionRequests: [], activityRequest: null, claims: [], commitments: [] } };
    },
  });
  const denied = message('wechat', { trusted_actor_context: { ...OWNER, owner: false, platform: 'wechat', conversationKey: 'wechat:conversation' } });
  await backend.getReply(denied);
  await backend.getReply({ ...denied, id: 'denied-turn-2', text: '刚才结果怎么样？' });
  assert.equal(seen[1].action_outcomes[0].status, 'rejected');
  assert.equal(seen[1].action_outcomes[0].retryable, false);
  assert.equal(JSON.stringify(seen[1]).includes('日报正文'), false);
});

test('full and lite prompts share effect ownership while read-only tools remain configured', async () => {
  const prompts = [];
  const fetchImpl = async (url, init = {}) => {
    if (String(url).endsWith('/models')) return { ok: true };
    prompts.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ schemaVersion: 1, message: 'ok', actionRequests: [], activityRequest: null, claims: [], commitments: [] }) } }] }) };
  };
  for (const capabilityMode of ['lite', 'full']) {
    await sendChatToHermesGateway({ text: 'hello', platform: 'wechat' }, {
      fetchImpl,
      logger: { log() {}, warn() {} },
      config: {
        mode: 'api', capabilityMode, baseUrl: 'http://127.0.0.1:8642/v1', liteBaseUrl: 'http://127.0.0.1:8642/v1', fullBaseUrl: 'http://127.0.0.1:8643/v1',
        profile: 'ran-assistant', liteProfile: 'ran-assistant-lite', fullProfile: 'ran-assistant', provider: 'deepseek', model: 'test', token: '', timeoutSeconds: 5,
        sessionContinuityEnabled: false, contextInjectionMode: 'slim', recentTextTurns: 0, recentTextCharBudget: 0, globalRecentTurns: 0, globalRecentCharBudget: 0,
        activeTopicCharBudget: 0, continuityCharBudget: 0, environmentContextEnabled: false, cacheFriendlyHistoryEnabled: false,
      },
    });
  }
  for (const prompt of prompts) {
    assert.match(prompt.messages[0].content, /Never execute persistent or external effects with internal tools/);
    assert.match(prompt.messages[0].content, /feishu\.message\.send/);
  }
  const full = fs.readFileSync(new URL('../../hermes/profile/config.yaml', import.meta.url), 'utf8');
  const lite = fs.readFileSync(new URL('../../hermes/profile/config.lite.yaml', import.meta.url), 'utf8');
  assert.match(full, /disabled_tools:[\s\S]*- terminal/);
  assert.match(full, /platform_toolsets:[\s\S]*?- terminal/);
  for (const config of [full, lite]) {
    for (const tool of ['sticker_save_from_inbox', 'sticker_update', 'sticker_delete']) assert.match(config, new RegExp(`disabled_tools:[\\s\\S]*- ${tool}`));
  }
  assert.match(full, /disabled_tools:[\s\S]*- file/);
  for (const config of [full, lite]) assert.match(config, /mcp-search_hub/);
});

test('ChannelHub parity keeps receipt logic out of frontend adapters', async (t) => {
  for (const platform of ['feishu', 'wechat']) {
    const calls = [];
    const { backend, env } = backendWithCli(t, successCli(calls));
    env.RAN_AGENT_IDENTITY_MAP_PATH = path.join(env.RAN_AGENT_STATE_DIR, 'identity-map.json');
    bootstrapOwnerBinding({
      trustedIdentity: { platform, senderId: 'owner', globalUserId: 'user:ran', provenance: 'test' },
      env,
    });
    const sent = [];
    const result = await handleIncomingMessage({
      id: `${platform}-hub-1`, platform, channel_type: 'dm', conversation_id: `${platform}-conversation`, sender_id: 'owner',
      text: '请把日报正文发送到 oc_target_12345678', created_at: Date.now(),
    }, {
      env,
      replyBackend: backend,
      adapter: { sendReply: async (value) => { sent.push(value); } },
      logger: { log() {}, warn() {} },
    });
    assert.equal(calls.length, 1, platform);
    assert.equal(sent[0].text, result.replyText, platform);
  }
});
