import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';

process.env.HERMES_SEMANTIC_VERIFIER_TEST_BYPASS = 'true';

import { createReplyBackend } from '../src/replyBackend.mjs';
import { createFeishuDocumentWriteExecutorAdapter } from '../src/feishuMinutesDocumentClient.mjs';
import { createIsolatedTestEnv } from './helpers/isolatedState.mjs';

const CONTENT = '<title>DLM 学习笔记</title><heading1>直观理解</heading1><p>自回归像逐字写作，扩散语言模型像反复修改整段草稿。</p>';
const OWNER_MESSAGE = {
  id: 'owner-message-dlm-1',
  text: '调研网页后整理成飞书云文档，标题 DLM 学习笔记，放到 AI学习 文件夹',
  sender_id: 'owner',
  conversation_id: 'owner-conversation',
  channel: 'wechat',
  trusted_actor_context: {
    actorKey: 'actor:wechat:owner:0001',
    owner: true,
    platform: 'wechat',
    conversationKey: 'wechat:dm:conversation',
  },
};

function env(t) {
  return createIsolatedTestEnv(t, { HERMES_ACTION_GATE_ENABLED: 'true', HERMES_ACTION_GATE_MODE: 'enforce' }, 'document-write-');
}

function request(requestRef = 'document-write-1') {
  return {
    requestRef,
    actionType: 'document.write',
    scope: {
      provider: 'feishu',
      operation: 'create',
      target: { folderTitle: 'AI学习', documentTitle: 'DLM 学习笔记' },
      contentXml: CONTENT,
      sourceRefs: ['web:https://example.test/dlm'],
    },
  };
}

function response(action = request()) {
  return {
    reply_envelope: {
      schemaVersion: 1,
      message: '正在写入。',
      actionRequests: [action],
      activityRequest: null,
      claims: [],
      commitments: [],
    },
  };
}

function successfulExec(calls) {
  return async (_command, args) => {
    calls.push(args);
    const base = { ok: true, identity: 'user' };
    if (args[0] === 'drive') return { stdout: JSON.stringify({ ...base, data: { results: [{ result_meta: { token: 'folder_ai' } }] } }) };
    if (args[1] === '+create') return { stdout: JSON.stringify({ ...base, data: { document: { document_id: 'doc_dlm' } } }) };
    if (args[1] === '+fetch') return { stdout: JSON.stringify({ ...base, data: { content: CONTENT } }) };
    throw new Error('unexpected lark-cli call');
  };
}

test('Web learning note becomes one hash-bound Feishu document and restart replays its durable receipt', async (t) => {
  const runtimeEnv = env(t);
  const calls = [];
  const options = {
    env: runtimeEnv,
    execFileImpl: successfulExec(calls),
    hermesImpl: async () => response(),
    ingestImpl: async () => ({ ok: true }),
    logger: { log() {}, warn() {} },
  };
  const first = await createReplyBackend(options).getReply(OWNER_MESSAGE);
  const replay = await createReplyBackend(options).getReply(OWNER_MESSAGE);
  const changedRequest = request('document-write-changed');
  changedRequest.scope.contentXml = CONTENT.replace('反复修改整段草稿', '一次生成整段草稿');
  const conflict = await createReplyBackend({
    ...options,
    hermesImpl: async () => response(changedRequest),
  }).getReply(OWNER_MESSAGE);

  assert.equal(first.replyText, '云文档已写入并通过回读确认。');
  assert.equal(first.source, 'bridge_feishu_document_write');
  assert.equal(replay.replyText, first.replyText);
  assert.equal(conflict.replyText, '同一请求的文档内容发生变化，未再次写入。');
  assert.deepEqual(calls.map((args) => args.slice(0, 2)), [
    ['drive', '+search'],
    ['docs', '+create'],
    ['docs', '+fetch'],
  ]);

  const state = JSON.parse(fs.readFileSync(`${runtimeEnv.RAN_AGENT_STATE_DIR}/core/operation-ledger.json`, 'utf8'));
  assert.equal(state.operations.length, 1);
  const operation = state.operations[0];
  const hash = `sha256:${createHash('sha256').update(CONTENT, 'utf8').digest('hex')}`;
  assert.equal(operation.actionType, 'document.write');
  assert.equal(operation.scope.provider, 'feishu');
  assert.deepEqual(operation.scope.target, { documentTitle: 'DLM 学习笔记', folderTitle: 'AI学习' });
  assert.equal(operation.scope.content.hash, hash);
  assert.equal(operation.scope.content.ref, `inline:${hash}`);
  assert.match(operation.scope.causationRef, /^source:sha256:[a-f0-9]{64}$/);
  assert.equal(operation.payloadRef, `inline:${hash}`);
  assert.equal(operation.state, 'completed');
  assert.equal(operation.status, 'succeeded');
  assert.match(operation.effectDigest, /^sha256:[a-f0-9]{64}$/);
});

test('a non-Minutes recipe mismatch receives one internal replan and then uses document.write', async (t) => {
  const calls = [];
  const inputs = [];
  let attempt = 0;
  const backend = createReplyBackend({
    env: env(t),
    execFileImpl: successfulExec(calls),
    hermesImpl: async (input) => {
      inputs.push(input);
      attempt += 1;
      if (attempt === 1) {
        return response({
          requestRef: 'wrong-recipe',
          actionType: 'feishu.minutes_to_doc',
          scope: { minuteTitle: 'DLM', folderTitle: 'AI学习', documentTitle: 'DLM 学习笔记', contentXml: CONTENT },
        });
      }
      return response(request('corrected-recipe'));
    },
    ingestImpl: async () => ({ ok: true }),
    logger: { log() {}, warn() {} },
  });

  const result = await backend.getReply(OWNER_MESSAGE);
  assert.equal(result.replyText, '云文档已写入并通过回读确认。');
  assert.equal(inputs.length, 2);
  assert.match(inputs[1].continuity_note, /NODE_ACTION_REPLAN/);
  assert.match(inputs[1].continuity_note, /Do not repeat research or call tools/);
  assert.equal(calls.filter((args) => args[1] === '+create').length, 1);
});

test('document acknowledgements separate pre-execution rejection, readback failure, and ambiguous dispatch', async (t) => {
  const rejectedCalls = [];
  const rejected = createReplyBackend({
    env: env(t), execFileImpl: successfulExec(rejectedCalls),
    hermesImpl: async () => response(), ingestImpl: async () => ({ ok: true }), logger: { log() {}, warn() {} },
  });
  const rejectedResult = await rejected.getReply({ ...OWNER_MESSAGE, text: '整理成飞书云文档，但我没有指定目标文件夹' });
  assert.equal(rejectedResult.replyText, '文档写入在执行前被拒绝，未创建或修改文档。');
  assert.equal(rejectedCalls.length, 0);

  const readbackCalls = [];
  const readback = createReplyBackend({
    env: env(t),
    execFileImpl: async (_command, args) => {
      readbackCalls.push(args);
      const base = { ok: true, identity: 'user' };
      if (args[0] === 'drive') return { stdout: JSON.stringify({ ...base, data: { results: [{ result_meta: { token: 'folder_ai' } }] } }) };
      if (args[1] === '+create') return { stdout: JSON.stringify({ ...base, data: { document: { document_id: 'doc_bad_readback' } } }) };
      return { stdout: JSON.stringify({ ...base, data: { content: '<title>别的文档</title>' } }) };
    },
    hermesImpl: async () => response(), ingestImpl: async () => ({ ok: true }), logger: { log() {}, warn() {} },
  });
  const readbackResult = await readback.getReply(OWNER_MESSAGE);
  assert.equal(readbackResult.replyText, '文档操作已执行，但回读校验失败，暂不确认内容完成。');

  const timeoutEnv = env(t);
  let createAttempts = 0;
  const timeoutOptions = {
    env: timeoutEnv,
    execFileImpl: async (_command, args) => {
      const base = { ok: true, identity: 'user' };
      if (args[0] === 'drive') return { stdout: JSON.stringify({ ...base, data: { results: [{ result_meta: { token: 'folder_ai' } }] } }) };
      if (args[1] === '+create') {
        createAttempts += 1;
        throw Object.assign(new Error('unknown result'), { code: 'ETIMEDOUT' });
      }
      throw new Error('fetch must not run');
    },
    hermesImpl: async () => response(), ingestImpl: async () => ({ ok: true }), logger: { log() {}, warn() {} },
  };
  const ambiguous = await createReplyBackend(timeoutOptions).getReply(OWNER_MESSAGE);
  const ambiguousReplay = await createReplyBackend(timeoutOptions).getReply(OWNER_MESSAGE);
  assert.equal(ambiguous.replyText, '文档写入结果不确定；为避免重复创建，不会自动重试。');
  assert.equal(ambiguousReplay.replyText, ambiguous.replyText);
  assert.equal(createAttempts, 1);
});

test('update keeps its exact document target and CLI shape inside the Feishu adapter', async () => {
  const calls = [];
  const hash = `sha256:${createHash('sha256').update(CONTENT, 'utf8').digest('hex')}`;
  const adapter = createFeishuDocumentWriteExecutorAdapter({
    execFileImpl: async (_command, args) => {
      calls.push(args);
      const base = { ok: true, identity: 'user' };
      if (args[1] === '+update') return { stdout: JSON.stringify({ ...base, data: { updated: true } }) };
      if (args[1] === '+fetch') return { stdout: JSON.stringify({ ...base, data: { content: CONTENT } }) };
      throw new Error('unexpected lark-cli call');
    },
  });
  const result = await adapter.execute({ operation: {
    operationId: 'op_document_update_123456',
    actionType: 'document.write',
    payloadRef: `inline:${hash}`,
    scope: {
      provider: 'feishu', operation: 'update',
      target: { documentId: 'doc_dlm_123', documentTitle: 'DLM 学习笔记' },
      content: { format: 'docx_xml', ref: `inline:${hash}`, hash, body: CONTENT },
    },
  } });
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(calls.map((args) => args.slice(0, 2)), [['docs', '+update'], ['docs', '+fetch']]);
  assert.equal(calls[0].includes('doc_dlm_123'), true);
});
