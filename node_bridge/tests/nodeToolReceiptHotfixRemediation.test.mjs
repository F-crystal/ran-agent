import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createFeishuActionExecutorAdapter } from '../src/feishuActionExecutor.mjs';
import { createAiDailyDigestExecutorAdapter } from '../src/aiDailyDigestClient.mjs';
import { createOperationLedger } from '../src/operationLedger.mjs';
import { createReplyBackend } from '../src/replyBackend.mjs';
import { createTrustedExecutorAdapters } from '../src/trustedExecutorAdapters.mjs';
import { createIsolatedTestEnv } from './helpers/isolatedState.mjs';

const MESSAGE_OPERATION = Object.freeze({
  operationId: 'op_remediation_message',
  actionType: 'feishu.message.send',
  idempotencyDigest: `sha256:${'a'.repeat(64)}`,
  scope: { argumentsDigest: `sha256:${'b'.repeat(64)}` },
});

const MESSAGE_PAYLOAD = Object.freeze({
  actionType: 'feishu.message.send',
  argumentsDigest: MESSAGE_OPERATION.scope.argumentsDigest,
  targetType: 'chat',
  targetId: 'oc_remediation_target',
  text: 'sanitized test body',
});

const DOCUMENT_OPERATION = Object.freeze({
  operationId: 'op_remediation_document',
  actionType: 'feishu.document.update',
  idempotencyDigest: `sha256:${'c'.repeat(64)}`,
  scope: { argumentsDigest: `sha256:${'d'.repeat(64)}` },
});

const DOCUMENT_PAYLOAD = Object.freeze({
  actionType: 'feishu.document.update',
  argumentsDigest: DOCUMENT_OPERATION.scope.argumentsDigest,
  targetId: 'doccnRemediationTarget',
  command: 'append',
  content: 'sanitized test content',
});

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function executeCli(resultOrError, { operation = MESSAGE_OPERATION, payload = MESSAGE_PAYLOAD } = {}) {
  const execFileImpl = async () => {
    if (resultOrError instanceof Error) throw resultOrError;
    return resultOrError;
  };
  const adapter = createFeishuActionExecutorAdapter({ env: {}, execFileImpl });
  return adapter.execute({ operation, payload });
}

function transportError(message, fields) {
  return Object.assign(new Error(message), fields);
}

function actionEnvelope(message, actionRequests = []) {
  return {
    reply_envelope: {
      schemaVersion: 1,
      message,
      actionRequests,
      activityRequest: null,
      claims: [],
      commitments: [],
    },
  };
}

function staleSendRequest(operationKey = 'stale-meta-send') {
  return {
    requestRef: 'stale-send',
    actionType: 'feishu.message.send',
    scope: {
      operationKey,
      target: { type: 'chat', id: 'oc_meta_target' },
      arguments: { text: 'stale private body', identity: 'bot' },
      expectedEffect: 'external_send',
    },
  };
}

function staleDocumentRequest(operationKey = 'stale-meta-document') {
  return {
    requestRef: 'stale-document',
    actionType: 'feishu.document.update',
    scope: {
      operationKey,
      target: { type: 'document', id: 'oc_meta_target' },
      arguments: { command: 'append', content: 'stale private content' },
      expectedEffect: 'persistent_update',
    },
  };
}

function ownerMessage(text, overrides = {}) {
  return {
    id: 'meta-turn',
    text,
    sender_id: 'owner',
    conversation_id: 'oc_meta_target',
    platform: 'feishu',
    trusted_actor_context: {
      actorKey: 'actor:owner:meta-remediation',
      owner: true,
      platform: 'feishu',
      conversationKey: 'feishu:oc_meta_target',
    },
    ...overrides,
  };
}

function operationCount(ledger) {
  if (!fs.existsSync(ledger.target)) return 0;
  return JSON.parse(fs.readFileSync(ledger.target, 'utf8')).operations.length;
}

function createMetaBackend(t, hermesImpl) {
  const env = createIsolatedTestEnv(t, { HERMES_ACTION_GATE_MODE: 'enforce' }, 'node-receipt-meta-');
  const ledger = createOperationLedger({ env });
  let executorCalls = 0;
  const adapter = createFeishuActionExecutorAdapter({
    env,
    execFileImpl: async () => {
      executorCalls += 1;
      return { stdout: JSON.stringify({ message_id: 'om_meta_unexpected' }), stderr: '' };
    },
  });
  const trustedActionExecutors = createTrustedExecutorAdapters({ ledger, adapters: [adapter] });
  const backend = createReplyBackend({
    env,
    operationLedger: ledger,
    trustedActionExecutors,
    hermesImpl,
    ingestImpl: async () => ({ ok: true }),
    logger: { log() {}, warn() {} },
  });
  return { backend, ledger, getExecutorCalls: () => executorCalls };
}

function createDailyBackend(t, {
  now,
  env: suppliedEnv,
  operationKey = () => 'daily-current-day',
  fetchCounter = { value: 0 },
} = {}) {
  const env = suppliedEnv || createIsolatedTestEnv(t, {
    HERMES_ACTION_GATE_MODE: 'enforce',
    RAN_AGENT_INTERNAL_CONTROL_SECRET: 'test-control-secret',
    PYTHON_BACKEND_BASE_URL: 'http://127.0.0.1:8787',
  }, 'node-receipt-daily-date-');
  const ledgerNow = () => new Date('2026-07-20T00:00:00.000Z');
  const ledger = createOperationLedger({ env, now: ledgerNow });
  const fetchImpl = async (_url, init) => {
    fetchCounter.value += 1;
    const body = JSON.parse(init.body);
    return {
      ok: true,
      async json() {
        return {
          ok: true,
          authenticated: true,
          operationId: body.operationId,
          effectId: `daily-effect-${fetchCounter.value}`,
        };
      },
    };
  };
  const trustedActionExecutors = createTrustedExecutorAdapters({
    ledger,
    now: ledgerNow,
    adapters: [createAiDailyDigestExecutorAdapter({ env, fetchImpl })],
  });
  let turn = 0;
  const backend = createReplyBackend({
    env,
    now,
    operationLedger: ledger,
    trustedActionExecutors,
    hermesImpl: async () => actionEnvelope('今日日报已补发。', [{
      requestRef: 'daily-current-day',
      actionType: 'ai_daily_digest.send',
      scope: { operationKey: operationKey(turn++), mode: 'manual', date: 'current_local_date' },
    }]),
    ingestImpl: async () => ({ ok: true }),
    logger: { log() {}, warn() {} },
  });
  return { backend, env, ledger, fetchCounter };
}

function dailyMessage(platform, overrides = {}) {
  return ownerMessage('请重新补发今日日报', {
    id: `${platform}-daily-date`,
    platform,
    conversation_id: `${platform}-daily-conversation`,
    created_at: '2000-01-01T00:00:00.000Z',
    trusted_actor_context: {
      actorKey: 'actor:owner:daily-date',
      owner: true,
      platform,
      conversationKey: `${platform}:daily-date`,
    },
    ...overrides,
  });
}

function dailyOperations(ledger) {
  if (!fs.existsSync(ledger.target)) return [];
  return JSON.parse(fs.readFileSync(ledger.target, 'utf8')).operations
    .filter((item) => item.actionType === 'ai_daily_digest.send');
}

function topLevelYamlList(text, key) {
  const lines = text.split(/\r?\n/);
  const start = lines.indexOf(`${key}:`);
  assert.notEqual(start, -1, `missing ${key}`);
  const values = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\S/.test(lines[index])) break;
    const match = lines[index].match(/^  - (.+)$/);
    if (match) values.push(match[1]);
  }
  return values;
}

function platformToolset(text, platform) {
  const lines = text.split(/\r?\n/);
  const section = lines.indexOf('platform_toolsets:');
  const start = lines.findIndex((line, index) => index > section && line === `  ${platform}:`);
  assert.notEqual(start, -1, `missing platform_toolsets.${platform}`);
  const values = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\S/.test(lines[index]) || /^  \S/.test(lines[index])) break;
    const match = lines[index].match(/^    - (.+)$/);
    if (match) values.push(match[1]);
  }
  return values;
}

test('NRH-B02 structured stderr business failure overrides stdout success evidence', async () => {
  const result = await executeCli({
    stdout: JSON.stringify({ message_id: 'om_stale_success_marker' }),
    stderr: JSON.stringify({ ok: false, code: 230001, error: 'business failure' }),
    exitCode: 0,
    dispatched: true,
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.retryable, true);
  assert.equal(JSON.stringify(result).includes('om_stale_success_marker'), false);
  assert.equal(JSON.stringify(result).includes('business failure'), false);
});

test('NRH-B01 an expired raw receipt cannot unlock a visible success claim', async (t) => {
  let nowMs = Date.parse('2026-07-20T00:00:00.000Z');
  const now = () => new Date(nowMs);
  const env = createIsolatedTestEnv(t, { HERMES_ACTION_GATE_MODE: 'enforce' }, 'node-receipt-expired-visible-');
  const ledger = createOperationLedger({ env, now });
  const baseExecutors = createTrustedExecutorAdapters({
    ledger,
    now,
    adapters: [createFeishuActionExecutorAdapter({
      env,
      execFileImpl: async () => ({ stdout: JSON.stringify({ message_id: 'om_expired' }), stderr: '' }),
    })],
  });
  const expiringExecutors = {
    supports: (actionType) => baseExecutors.supports(actionType),
    async execute(operation, options) {
      const receipt = await baseExecutors.execute(operation, options);
      nowMs = Date.parse(receipt.expiresAt);
      return receipt;
    },
    verifyReceipt: (receipt, expected) => baseExecutors.verifyReceipt(receipt, expected),
  };
  const backend = createReplyBackend({
    env,
    now,
    operationLedger: ledger,
    trustedActionExecutors: expiringExecutors,
    hermesImpl: async () => actionEnvelope('我会继续陪你。日报已经发送。', [staleSendRequest('expired-visible')]),
    ingestImpl: async () => ({ ok: true }),
    logger: { log() {}, warn() {} },
  });
  const result = await backend.getReply(ownerMessage('请发送日报'));
  assert.equal(result.replyText.includes('已经发送'), false);
  assert.match(result.replyText, /无法确认|不能确认/);
  assert.equal(result.actionOutcomes[0].status, 'ambiguous');
  const persisted = dailyOperations({ target: ledger.target });
  assert.equal(JSON.parse(fs.readFileSync(ledger.target, 'utf8')).operations[0].status, 'succeeded');
  assert.equal(persisted.length, 0);
});

test('NRH-B02 stderr warning does not defeat valid stdout success evidence', async () => {
  const result = await executeCli({
    stdout: JSON.stringify({ message_id: 'om_valid' }),
    stderr: 'warning: using cached DNS result',
    exitCode: 0,
    dispatched: true,
  });
  assert.equal(result.status, 'succeeded');
});

test('NRH-B02 explicit stderr failure semantics override residual success evidence', async () => {
  const result = await executeCli({
    stdout: JSON.stringify({ message_id: 'om_residual_plain_error' }),
    stderr: 'ERROR: permission denied by Feishu',
    exitCode: 0,
    dispatched: true,
  });
  assert.equal(result.status, 'failed');
});

test('NRH-B02 nonzero exit distinguishes business failure from residual success', async () => {
  const businessFailure = await executeCli(transportError('exit 2', {
    code: 2,
    exitCode: 2,
    stdout: JSON.stringify({ ok: false, code: 230001 }),
    stderr: '',
    dispatched: true,
  }));
  assert.equal(businessFailure.status, 'failed');

  const residualSuccess = await executeCli(transportError('exit 2 after output', {
    code: 2,
    exitCode: 2,
    stdout: JSON.stringify({ message_id: 'om_residual' }),
    stderr: '',
    dispatched: true,
  }));
  assert.equal(residualSuccess.status, 'ambiguous');
  assert.equal(residualSuccess.retryable, false);
});

test('NRH-B02 signal and timeout use the dispatch boundary', async () => {
  for (const fields of [
    { signal: 'SIGTERM', dispatched: false },
    { code: 'ETIMEDOUT', timedOut: true, dispatched: false },
  ]) {
    const result = await executeCli(transportError('before dispatch', fields));
    assert.equal(result.status, 'failed');
    assert.equal(result.retryable, true);
  }
  for (const fields of [
    { signal: 'SIGTERM', dispatched: true },
    { code: 'ETIMEDOUT', timedOut: true, dispatched: true },
  ]) {
    const result = await executeCli(transportError('after dispatch', fields));
    assert.equal(result.status, 'ambiguous');
    assert.equal(result.retryable, false);
  }
});

test('NRH-B02 explicit dispatch evidence overrides transport-code heuristics', async () => {
  const notDispatched = await executeCli({
    stdout: JSON.stringify({ message_id: 'om_impossible_predispatch' }),
    stderr: '',
    exitCode: 0,
    dispatched: false,
  });
  assert.equal(notDispatched.status, 'failed');

  const dispatchedPermissionError = await executeCli(transportError('permission response after dispatch', {
    code: 'EACCES',
    dispatched: true,
  }));
  assert.equal(dispatchedPermissionError.status, 'ambiguous');
});

test('NRH-B02 malformed evidence and duplicate success callbacks never produce success', async () => {
  const malformedStdout = await executeCli({ stdout: '{not-json', stderr: '', exitCode: 0, dispatched: true });
  assert.equal(malformedStdout.status, 'ambiguous');

  const harmlessMalformedStderr = await executeCli({
    stdout: JSON.stringify({ message_id: 'om_valid_warning' }),
    stderr: '{ordinary malformed warning',
    exitCode: 0,
    dispatched: true,
  });
  assert.equal(harmlessMalformedStderr.status, 'succeeded');

  const duplicateCallback = await executeCli({
    stdout: `${JSON.stringify({ message_id: 'om_one' })}\n${JSON.stringify({ message_id: 'om_two' })}`,
    stderr: '',
    exitCode: 0,
    dispatched: true,
  });
  assert.notEqual(duplicateCallback.status, 'succeeded');
});

test('NRH-B02 partial document result and transport-success business failure never succeed', async () => {
  const partial = await executeCli({
    stdout: JSON.stringify({ ok: true, data: { result: 'partial_success', updated_blocks_count: 1 } }),
    stderr: '',
    exitCode: 0,
    dispatched: true,
  }, { operation: DOCUMENT_OPERATION, payload: DOCUMENT_PAYLOAD });
  assert.equal(partial.status, 'partial');

  const businessFailure = await executeCli({
    stdout: JSON.stringify({ ok: true, data: { result: 'success', updated_blocks_count: 1 } }),
    stderr: JSON.stringify({ success: false, code: 230001, error: { message: 'denied' } }),
    exitCode: 0,
    dispatched: true,
  }, { operation: DOCUMENT_OPERATION, payload: DOCUMENT_PAYLOAD });
  assert.equal(businessFailure.status, 'failed');
});

test('UNRESOLVED_ACTION_GATE_MUST_NOT_RETRIGGER_ON_META_DISCUSSION', async (t) => {
  for (const phrase of ['你为什么这么说？', 'Node 抽了什么标识？', '我说的不是让你再执行。']) {
    const seen = [];
    let turn = 0;
    const explanation = `系统解释：${phrase} Node 只把可验证回执当作执行事实。`;
    const { backend, ledger, getExecutorCalls } = createMetaBackend(t, async (payload) => {
      seen.push(payload);
      turn += 1;
      if (turn === 1) return actionEnvelope('我会继续帮你核对。日报已经补发。');
      if (turn === 2) return actionEnvelope(explanation, [staleSendRequest(`stale-${turn}`)]);
      return actionEnvelope('上下文没有新增执行结果。');
    });

    const first = await backend.getReply(ownerMessage('刚才那条日报怎么样了？', { id: `${phrase}-1` }));
    assert.match(first.replyText, /我会继续帮你核对/);
    assert.match(first.replyText, /不能确认/);
    const before = operationCount(ledger);
    const second = await backend.getReply(ownerMessage(phrase, { id: `${phrase}-2` }));
    assert.equal(second.replyText, explanation, phrase);
    assert.deepEqual(second.actionOutcomes, [], phrase);
    assert.equal(getExecutorCalls(), 0, phrase);
    assert.equal(operationCount(ledger), before, phrase);

    await backend.getReply(ownerMessage('继续解释', { id: `${phrase}-3` }));
    assert.deepEqual(seen[2].action_outcomes, [], phrase);
  }
});

test('NRH-B03 status and meta questions skip stale action requests without outcomes', async (t) => {
  for (const phrase of [
    '刚才发成功了吗',
    '为什么没发',
    '你为什么把日报发送了？',
    '告诉我你把什么发送了？',
    '你把日报发送给谁了？',
    '你帮我发送了什么？',
    '帮我发送了吗？',
    '帮我发了吗？',
    '帮我发给谁了？',
    '帮我发送了几次？',
    '帮我发送了没有？',
    '请问发送了几次？',
    '现在发送的是哪一条？',
  ]) {
    const { backend, ledger, getExecutorCalls } = createMetaBackend(t, async () => actionEnvelope(
      '这是对系统行为的解释。',
      [staleSendRequest(`status-${phrase}`)],
    ));
    const before = operationCount(ledger);
    const result = await backend.getReply(ownerMessage(phrase));
    assert.equal(result.replyText, '这是对系统行为的解释。', phrase);
    assert.deepEqual(result.actionOutcomes, [], phrase);
    assert.equal(getExecutorCalls(), 0, phrase);
    assert.equal(operationCount(ledger), before, phrase);
  }
});

test('NRH-B03 document meta query cannot trigger a stale update request', async (t) => {
  for (const phrase of [
    '你把文档 oc_meta_target 更新了哪些内容？',
    '帮我更新文档 oc_meta_target 了吗？',
    '帮我更新文档 oc_meta_target 了多少内容？',
    '请问文档 oc_meta_target 更新的是哪一份？',
  ]) {
    const { backend, ledger, getExecutorCalls } = createMetaBackend(t, async () => actionEnvelope(
      '这是对文档变更的解释。',
      [staleDocumentRequest()],
    ));
    const before = operationCount(ledger);
    const result = await backend.getReply(ownerMessage(phrase));
    assert.equal(result.replyText, '这是对文档变更的解释。', phrase);
    assert.deepEqual(result.actionOutcomes, [], phrase);
    assert.equal(getExecutorCalls(), 0, phrase);
    assert.equal(operationCount(ledger), before, phrase);
  }
});

test('NRH-B03 explicit fresh resend instructions still enter the controlled action path', async (t) => {
  for (const phrase of ['再发一次', '请重新发送', '为什么没发？请重新发送', '为什么没发？再发一次']) {
    const { backend, getExecutorCalls } = createMetaBackend(t, async () => actionEnvelope(
      '我会按新指令处理。已经发送。',
      [staleSendRequest(`fresh-${phrase}`)],
    ));
    const result = await backend.getReply(ownerMessage(phrase));
    assert.equal(getExecutorCalls(), 1, phrase);
    assert.equal(result.actionOutcomes[0].status, 'succeeded', phrase);
  }
});

test('NRH-B04 operationDate comes from one injected Node clock read in Asia/Shanghai', async (t) => {
  let clockCalls = 0;
  const instants = [
    new Date('2026-07-19T16:30:00.000Z'),
    new Date('2026-07-20T16:30:00.000Z'),
  ];
  const { backend, ledger } = createDailyBackend(t, { now: () => instants[Math.min(clockCalls++, 1)] });
  await backend.getReply(dailyMessage('feishu'), { hermesConfig: { profile: 'ran-assistant' } });
  assert.equal(clockCalls, 1);
  assert.equal(dailyOperations(ledger)[0].scope.operationDate, '2026-07-20');
});

test('NRH-B04 Feishu/WeChat and Full/Lite ignore inbound timestamps for the same Node date', async (t) => {
  for (const [platform, profile] of [['feishu', 'ran-assistant'], ['wechat', 'ran-assistant-lite']]) {
    const { backend, ledger } = createDailyBackend(t, { now: () => new Date('2026-07-19T16:30:00.000Z') });
    await backend.getReply(dailyMessage(platform), { hermesConfig: { profile } });
    assert.equal(dailyOperations(ledger)[0].scope.operationDate, '2026-07-20', `${platform}/${profile}`);
  }
});

test('NRH-B04 UTC day change inside one Shanghai day remains an exact replay', async (t) => {
  let nowMs = Date.parse('2026-07-20T23:30:00.000Z');
  const { backend, ledger, fetchCounter } = createDailyBackend(t, { now: () => new Date(nowMs) });
  const input = dailyMessage('feishu');
  await backend.getReply(input, { hermesConfig: { profile: 'ran-assistant' } });
  nowMs = Date.parse('2026-07-21T00:30:00.000Z');
  const replay = await backend.getReply({ ...input, id: 'utc-next-day' }, { hermesConfig: { profile: 'ran-assistant-lite' } });
  assert.equal(fetchCounter.value, 1);
  assert.equal(replay.actionOutcomes[0].replayed, true);
  assert.deepEqual(dailyOperations(ledger).map((item) => item.scope.operationDate), ['2026-07-21']);
});

test('NRH-B04 Shanghai midnight permits a new operation on the next local day', async (t) => {
  let nowMs = Date.parse('2026-07-20T15:59:59.999Z');
  const { backend, ledger, fetchCounter } = createDailyBackend(t, {
    now: () => new Date(nowMs),
    operationKey: (turn) => `daily-shanghai-day-${turn}`,
  });
  const input = dailyMessage('wechat');
  await backend.getReply(input);
  nowMs = Date.parse('2026-07-20T16:00:00.000Z');
  await backend.getReply({ ...input, id: 'shanghai-next-day' });
  assert.equal(fetchCounter.value, 2);
  assert.deepEqual(dailyOperations(ledger).map((item) => item.scope.operationDate), ['2026-07-20', '2026-07-21']);
});

test('NRH-B04 reopened ledger still recognizes the persisted current-day operation', async (t) => {
  const now = () => new Date('2026-07-20T03:00:00.000Z');
  const fetchCounter = { value: 0 };
  const first = createDailyBackend(t, { now, fetchCounter });
  const input = dailyMessage('feishu');
  await first.backend.getReply(input);
  const reopened = createDailyBackend(t, { now, env: first.env, fetchCounter });
  const replay = await reopened.backend.getReply({ ...input, id: 'reopened-same-day' });
  assert.equal(fetchCounter.value, 1);
  assert.equal(replay.actionOutcomes[0].replayed, true);
  assert.deepEqual(dailyOperations(reopened.ledger).map((item) => item.scope.operationDate), ['2026-07-20']);
});

test('NRH-B05 actual generated Full/Lite configs retain effect containment across regeneration', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'node-receipt-runtime-config-'));
  const fullHome = path.join(root, 'full');
  const liteHome = path.join(root, 'lite');
  fs.mkdirSync(path.join(fullHome, 'profiles', 'ran-assistant'), { recursive: true });
  fs.mkdirSync(path.join(liteHome, 'profiles', 'ran-assistant-lite'), { recursive: true });
  fs.copyFileSync(
    path.join(REPO_ROOT, 'hermes/profile/config.yaml'),
    path.join(fullHome, 'profiles', 'ran-assistant', 'config.yaml'),
  );

  const script = [
    'set -euo pipefail',
    'source "$1"',
    'write_lite_runtime_config',
    'write_full_runtime_config',
    'write_lite_runtime_config',
    'write_full_runtime_config',
  ].join('\n');
  execFileSync('bash', ['-c', script, 'runtime-config-test', path.join(REPO_ROOT, 'scripts/apply-hermes-runtime-split.sh')], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      RAN_AGENT_REPO_ROOT: REPO_ROOT,
      RAN_AGENT_NO_SUDO: '1',
      RAN_AGENT_RUNTIME_USER: 'ran-agent-nonexistent-test-user',
      HERMES_HOME: fullHome,
      HERMES_LITE_HOME: liteHome,
      OBSIDIAN_MEMORY_MCP_ENABLED: 'true',
      OMBRE_BRAIN_ENABLED: 'false',
      OMBRE_BRAIN_MCP_ENABLED: 'false',
    },
    stdio: 'pipe',
  });

  const configs = {
    full: fs.readFileSync(path.join(fullHome, 'config.yaml'), 'utf8'),
    lite: fs.readFileSync(path.join(liteHome, 'config.yaml'), 'utf8'),
  };
  const containedEffects = ['terminal', 'file', 'sticker_save_from_inbox', 'sticker_update', 'sticker_delete'];
  for (const [profile, config] of Object.entries(configs)) {
    const disabled = topLevelYamlList(config, 'disabled_tools');
    for (const tool of containedEffects) assert.equal(disabled.includes(tool), true, `${profile}:${tool}`);
    for (const platform of ['cli', 'gateway']) {
      const toolset = platformToolset(config, platform);
      assert.equal(toolset.includes('terminal'), false, `${profile}:${platform}:terminal`);
      assert.equal(toolset.includes('file'), false, `${profile}:${platform}:file`);
      assert.equal(toolset.some((tool) => /lark|feishu/i.test(tool)), false, `${profile}:${platform}:lark`);
      for (const readOnly of ['mcp-search_hub', 'mcp-sticker_catalog', 'mcp-personal_memory']) {
        assert.equal(toolset.includes(readOnly), true, `${profile}:${platform}:${readOnly}`);
      }
    }
    assert.match(config, /^  sticker_catalog:/m, `${profile}:sticker catalog retained`);
  }
  assert.deepEqual(
    containedEffects.filter((tool) => topLevelYamlList(configs.full, 'disabled_tools').includes(tool)),
    containedEffects.filter((tool) => topLevelYamlList(configs.lite, 'disabled_tools').includes(tool)),
  );
});
