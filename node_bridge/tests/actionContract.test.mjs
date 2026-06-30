import test from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateActionContract,
  evaluateActionGate,
  getActionGateConfig,
} from '../src/actionContract.mjs';

test('action contract classifies ordinary chat as none and does not require evidence', () => {
  const result = evaluateActionContract({
    requestId: 'req-chat',
    message: { text: '你好呀', channel: 'wechat', conversation_id: 'conv-a' },
    response: { reply_text: '你好' },
    config: { enabled: true, mode: 'observe', maxRepairAttempts: 1 },
  });

  assert.equal(result.intent, 'none');
  assert.deepEqual(result.required_evidence, []);
  assert.deepEqual(result.observed_evidence, []);
  assert.equal(result.gate_decision, 'pass');
  assert.equal(result.final_action, 'observe_only');
});

test('action contract classifies social links and records read claims without user text', () => {
  const result = evaluateActionContract({
    requestId: 'req-social',
    channel: 'wechat',
    conversationId: 'https://secret.example/should-not-leak',
    profile: 'ran-assistant-lite',
    message: {
      text: '帮我读一下 http://xhslink.com/o/abc123 里面写了什么',
      channel: 'wechat',
      conversation_id: 'conv-social',
    },
    response: { reply_text: '我读到了，这篇小红书主要说旅行。' },
    config: { enabled: true, mode: 'observe', maxRepairAttempts: 1 },
  });

  const serialized = JSON.stringify(result);
  assert.equal(result.intent, 'social_read');
  assert.ok(result.required_evidence.includes('tool_result'));
  assert.ok(result.final_claims.includes('read_complete'));
  assert.equal(result.gate_decision, 'missing_evidence');
  assert.equal(serialized.includes('abc123'), false);
  assert.equal(serialized.includes('旅行'), false);
  assert.equal(serialized.includes('https://secret.example'), false);
  assert.match(result.conversation_id_hash, /^[a-f0-9]{16}$/);
});

test('action contract does not classify partial social read wording as complete', () => {
  const result = evaluateActionContract({
    requestId: 'req-social-partial',
    channel: 'wechat',
    message: {
      text: '帮我读一下 http://xhslink.com/o/abc123',
      channel: 'wechat',
      conversation_id: 'conv-social-partial',
    },
    response: { reply_text: '我读到了一部分内容：前三张图已经读到。但有些媒体或细节没有成功获取。' },
    toolResults: [
      {
        toolName: 'mcp_social_reader_read_social_post_deep',
        partial_success: true,
        media_analysis: { merged_summary: '前三张图已经读到。' },
      },
    ],
    config: { enabled: true, mode: 'repair', maxRepairAttempts: 1 },
  });

  assert.equal(result.intent, 'social_read');
  assert.equal(result.partial_success_detected, true);
  assert.equal(result.final_claims.includes('read_complete'), false);
  assert.equal(result.gate_decision, 'pass');
});

test('action contract classifies inbound media as media_read and records media artifact evidence', () => {
  const result = evaluateActionContract({
    requestId: 'req-media',
    message: {
      text: '看下这张图',
      channel: 'wechat',
      conversation_id: 'conv-media',
      media: [{ filePath: '/opt/ran_agent/debug/wechat/inbound/private.png', mimeType: 'image/png', type: 'image' }],
    },
    response: { reply_text: '图片里是一个截图。', media: { type: 'image', artifact_id: 'media_artifact_123' } },
    config: { enabled: true, mode: 'observe', maxRepairAttempts: 1 },
  });

  const serialized = JSON.stringify(result);
  assert.equal(result.intent, 'media_read');
  assert.ok(result.required_evidence.includes('artifact'));
  assert.ok(result.observed_evidence.some((item) => item.type === 'artifact' && item.status === 'present'));
  assert.ok(result.final_claims.includes('media_described'));
  assert.equal(serialized.includes('/opt/ran_agent'), false);
  assert.equal(serialized.includes('private.png'), false);
});

test('action contract records sanitized RAN_MEDIA and WECHAT_MEDIA marker evidence', () => {
  const result = evaluateActionContract({
    requestId: 'req-marker',
    message: { text: '来个表情包', channel: 'wechat', conversation_id: 'conv-marker' },
    response: {
      reply_text: [
        '给你',
        'RAN_MEDIA: {"source":"sticker_catalog","kind":"sticker","stickerId":"stk_001","caption":"秘密原文"}',
        'WECHAT_MEDIA: {"source":"media_generation_mcp","type":"image","url":"/private/generated.png","fileName":"cat.png"}',
      ].join('\n'),
    },
    config: { enabled: true, mode: 'observe', maxRepairAttempts: 1 },
  });

  const ran = result.observed_evidence.find((item) => item.type === 'marker' && item.marker === 'RAN_MEDIA');
  const wechat = result.observed_evidence.find((item) => item.type === 'marker' && item.marker === 'WECHAT_MEDIA');
  const serialized = JSON.stringify(result);

  assert.equal(result.intent, 'sticker_send');
  assert.deepEqual(ran.summary, {
    source: 'sticker_catalog',
    kind: 'sticker',
    stickerId: 'stk_001',
  });
  assert.deepEqual(wechat.summary, {
    source: 'media_generation_mcp',
    kind: '',
    type: 'image',
    fileName: 'cat.png',
  });
  assert.equal(serialized.includes('/private/generated.png'), false);
  assert.equal(serialized.includes('秘密原文'), false);
});

test('action contract records sanitized tool result evidence', () => {
  const result = evaluateActionContract({
    requestId: 'req-tool',
    message: { text: '总结 https://example.com/a', channel: 'wechat', conversation_id: 'conv-tool' },
    response: { reply_text: '读到了一部分。' },
    toolResults: [
      {
        toolName: 'mcp_social_reader_read_social_post_deep',
        ok: true,
        partial_success: true,
        artifact_id: 'artifact-private-id',
        error_code: 'XHS_PARTIAL',
        raw_text: '不要进入日志的用户原文',
      },
    ],
    config: { enabled: true, mode: 'observe', maxRepairAttempts: 1 },
  });

  const toolEvidence = result.observed_evidence.find((item) => item.type === 'tool_result');
  const serialized = JSON.stringify(result);
  assert.equal(result.intent, 'social_read');
  assert.equal(toolEvidence.tool, 'mcp_social_reader_read_social_post_deep');
  assert.equal(toolEvidence.status, 'partial_success');
  assert.match(toolEvidence.artifact_id_hash, /^[a-f0-9]{16}$/);
  assert.equal(toolEvidence.error_code, 'XHS_PARTIAL');
  assert.equal(serialized.includes('artifact-private-id'), false);
  assert.equal(serialized.includes('用户原文'), false);
});

test('action contract classifies media generation and records WECHAT_MEDIA evidence', () => {
  const result = evaluateActionContract({
    requestId: 'req-generate',
    message: { text: '帮我生成一张猫图', channel: 'wechat', conversation_id: 'conv-generate' },
    response: {
      reply_text: '生成好了\nWECHAT_MEDIA: {"source":"media_generation_mcp","type":"image","url":"/opt/ran_agent/private/cat.png","fileName":"cat.png"}',
    },
    config: { enabled: true, mode: 'observe', maxRepairAttempts: 1 },
  });

  assert.equal(result.intent, 'media_generate');
  assert.deepEqual(result.required_evidence, ['WECHAT_MEDIA', 'RAN_MEDIA', 'artifact']);
  assert.ok(result.observed_evidence.some((item) => item.type === 'marker' && item.marker === 'WECHAT_MEDIA'));
  assert.ok(result.final_claims.includes('media_generated'));
  assert.equal(JSON.stringify(result).includes('/opt/ran_agent'), false);
});

test('action contract classifies memory writes and records save result evidence', () => {
  const result = evaluateActionContract({
    requestId: 'req-save',
    message: { text: '记住这个偏好', channel: 'wechat', conversation_id: 'conv-save' },
    response: {
      reply_text: '已保存。',
      save_result: { ok: true, action_id: 'private-save-action-id', target: '/opt/ran_agent/vault/raw/private.md' },
    },
    config: { enabled: true, mode: 'observe', maxRepairAttempts: 1 },
  });

  const saveEvidence = result.observed_evidence.find((item) => item.type === 'save_result');
  const serialized = JSON.stringify(result);
  assert.equal(result.intent, 'memory_write');
  assert.deepEqual(result.required_evidence, ['save_result']);
  assert.equal(saveEvidence.status, 'success');
  assert.match(saveEvidence.result_id_hash, /^[a-f0-9]{16}$/);
  assert.ok(result.final_claims.includes('state_changed'));
  assert.equal(serialized.includes('private-save-action-id'), false);
  assert.equal(serialized.includes('/opt/ran_agent'), false);
});

test('action gate config defaults to enabled observe mode', () => {
  assert.deepEqual(getActionGateConfig({}), {
    enabled: true,
    mode: 'observe',
    maxRepairAttempts: 1,
  });
  assert.deepEqual(getActionGateConfig({
    HERMES_ACTION_GATE_ENABLED: 'false',
    HERMES_ACTION_GATE_MODE: 'repair',
    HERMES_ACTION_GATE_MAX_REPAIR_ATTEMPTS: '3',
  }), {
    enabled: false,
    mode: 'repair',
    maxRepairAttempts: 3,
  });
});

test('observe mode does not rewrite unsupported action claims', () => {
  const contract = evaluateActionContract({
    requestId: 'req-observe',
    message: { text: '帮我读一下 http://xhslink.com/o/abc123', channel: 'wechat', conversation_id: 'conv-observe' },
    response: { reply_text: '我已经完整读完了，内容主要讲旅行。' },
    config: { enabled: true, mode: 'observe', maxRepairAttempts: 1 },
  });

  const gate = evaluateActionGate({
    contract,
    finalReply: '我已经完整读完了，内容主要讲旅行。',
    mode: 'observe',
  });

  assert.equal(gate.shouldRewrite, false);
  assert.equal(gate.rewrittenText, '我已经完整读完了，内容主要讲旅行。');
  assert.equal(gate.gateDecision, 'observe_only');
  assert.equal(gate.finalAction, 'observe_only');
});

test('enforce mode rewrites social read claims without evidence', () => {
  const contract = evaluateActionContract({
    requestId: 'req-social-enforce',
    message: { text: '总结一下 http://xhslink.com/o/abc123', channel: 'wechat', conversation_id: 'conv-social-enforce' },
    response: { reply_text: '我看完这篇笔记了，它的核心观点是旅行规划。' },
    config: { enabled: true, mode: 'enforce', maxRepairAttempts: 1 },
  });

  const gate = evaluateActionGate({
    contract,
    finalReply: '我看完这篇笔记了，它的核心观点是旅行规划。',
    mode: 'enforce',
  });

  assert.equal(gate.shouldRewrite, true);
  assert.equal(gate.rewrittenText, '我现在还没有成功读取到这个链接的内容，所以不能直接判断里面写了什么。可以再试一次，或者你把截图/正文发我。');
  assert.equal(gate.gateDecision, 'rewrite');
  assert.equal(gate.finalAction, 'safe_rewrite');
  assert.deepEqual(gate.reasons, ['missing_required_evidence']);
  assert.deepEqual(gate.missingEvidence, ['tool_result']);
  assert.equal(gate.evidenceSatisfied, false);
});

test('enforce mode rewrites partial social reads without claiming total failure', () => {
  const contract = evaluateActionContract({
    requestId: 'req-social-partial',
    message: { text: '总结一下 http://xhslink.com/o/abc123', channel: 'wechat', conversation_id: 'conv-social-partial' },
    response: { reply_text: '完全没读到，所有内容都失败了。' },
    toolResults: [{ toolName: 'mcp_social_reader_read_social_post_deep', partial_success: true, error_code: 'XHS_PARTIAL' }],
    config: { enabled: true, mode: 'enforce', maxRepairAttempts: 1 },
  });

  const gate = evaluateActionGate({
    contract,
    finalReply: '完全没读到，所有内容都失败了。',
    mode: 'enforce',
  });

  assert.equal(gate.shouldRewrite, true);
  assert.equal(gate.rewrittenText, '我读到了一部分内容，但有些媒体或细节没有成功获取。');
  assert.equal(gate.partialSuccessDetected, true);
  assert.deepEqual(gate.reasons, ['partial_success_claim_mismatch']);
});

test('enforce mode rewrites complete social read claims when media coverage is partial', () => {
  const contract = evaluateActionContract({
    requestId: 'req-social-partial-coverage',
    message: { text: '总结一下 http://xhslink.com/o/abc123', channel: 'wechat', conversation_id: 'conv-social-partial-coverage' },
    response: { reply_text: '我已经完整读完了，五张图都看完了。' },
    toolResults: [{
      toolName: 'mcp_social_reader_read_social_post_deep',
      ok: true,
      total_media_count: 5,
      analyzed_media_count: 5,
      successful_media_count: 1,
      media_analysis: { partial: true, items: [{}], partial_failures: [{ asset_id: 'xhs-2', error_code: 'DOWNLOAD_TIMEOUT' }] },
    }],
    config: { enabled: true, mode: 'enforce', maxRepairAttempts: 1 },
  });

  const gate = evaluateActionGate({
    contract,
    finalReply: '我已经完整读完了，五张图都看完了。',
    mode: 'enforce',
  });

  assert.equal(contract.observed_evidence[0].status, 'partial_success');
  assert.equal(contract.observed_evidence[0].total_media_count, 5);
  assert.equal(contract.observed_evidence[0].analyzed_media_count, 5);
  assert.equal(contract.observed_evidence[0].successful_media_count, 1);
  assert.equal(gate.shouldRewrite, true);
  assert.equal(gate.rewrittenText, '我读到了一部分内容，但有些媒体或细节没有成功获取。');
  assert.deepEqual(gate.reasons, ['partial_success_claim_mismatch']);
});

test('enforce mode rewrites media read claims without artifact evidence', () => {
  const contract = evaluateActionContract({
    requestId: 'req-media-enforce',
    message: { text: '看下这张图', channel: 'wechat', conversation_id: 'conv-media-enforce' },
    response: { reply_text: '我看到图片里有一张合同截图。' },
    config: { enabled: true, mode: 'enforce', maxRepairAttempts: 1 },
  });

  const gate = evaluateActionGate({
    contract,
    finalReply: '我看到图片里有一张合同截图。',
    mode: 'enforce',
  });

  assert.equal(gate.shouldRewrite, true);
  assert.equal(gate.rewrittenText, '我这边没有成功读取到这个媒体内容，不能直接描述里面是什么。');
});

test('enforce mode rewrites sticker claims without valid RAN_MEDIA evidence', () => {
  const contract = evaluateActionContract({
    requestId: 'req-sticker-enforce',
    message: { text: '来个表情包', channel: 'wechat', conversation_id: 'conv-sticker-enforce' },
    response: { reply_text: '给你发一个表情包～' },
    config: { enabled: true, mode: 'enforce', maxRepairAttempts: 1 },
  });

  const gate = evaluateActionGate({
    contract,
    finalReply: '给你发一个表情包～',
    mode: 'enforce',
  });

  assert.equal(gate.shouldRewrite, true);
  assert.equal(gate.rewrittenText, '哈哈我懂你意思～');
});

test('enforce mode preserves valid sticker markers', () => {
  const reply = '给你\nRAN_MEDIA: {"source":"sticker_catalog","kind":"sticker","stickerId":"stk_001","caption":"测试"}';
  const contract = evaluateActionContract({
    requestId: 'req-sticker-pass',
    message: { text: '来个表情包', channel: 'wechat', conversation_id: 'conv-sticker-pass' },
    response: { reply_text: reply },
    config: { enabled: true, mode: 'enforce', maxRepairAttempts: 1 },
  });

  const gate = evaluateActionGate({
    contract,
    finalReply: reply,
    mode: 'enforce',
  });

  assert.equal(gate.shouldRewrite, false);
  assert.equal(gate.rewrittenText, reply);
  assert.equal(gate.gateDecision, 'pass');
  assert.equal(gate.finalAction, 'pass_through');
});

test('enforce mode rewrites media generation claims without marker or artifact', () => {
  const contract = evaluateActionContract({
    requestId: 'req-generate-enforce',
    message: { text: '生成一张猫图', channel: 'wechat', conversation_id: 'conv-generate-enforce' },
    response: { reply_text: '图片已经生成好了，发你了。' },
    config: { enabled: true, mode: 'enforce', maxRepairAttempts: 1 },
  });

  const gate = evaluateActionGate({
    contract,
    finalReply: '图片已经生成好了，发你了。',
    mode: 'enforce',
  });

  assert.equal(gate.shouldRewrite, true);
  assert.equal(gate.rewrittenText, '这次没有拿到可发送的生成结果，所以我不能说已经生成好了。');
});

test('enforce mode preserves WECHAT_MEDIA generation evidence', () => {
  const reply = '图片好了\nWECHAT_MEDIA: {"source":"media_generation_mcp","type":"image","url":"/private/cat.png","fileName":"cat.png"}';
  const contract = evaluateActionContract({
    requestId: 'req-generate-pass',
    message: { text: '生成一张猫图', channel: 'wechat', conversation_id: 'conv-generate-pass' },
    response: { reply_text: reply },
    config: { enabled: true, mode: 'enforce', maxRepairAttempts: 1 },
  });

  const gate = evaluateActionGate({
    contract,
    finalReply: reply,
    mode: 'enforce',
  });

  assert.equal(gate.shouldRewrite, false);
  assert.equal(gate.rewrittenText, reply);
});

test('enforce mode rewrites memory write claims without save result', () => {
  const contract = evaluateActionContract({
    requestId: 'req-memory-enforce',
    message: { text: '记住这个偏好', channel: 'wechat', conversation_id: 'conv-memory-enforce' },
    response: { reply_text: '已经保存好了。' },
    config: { enabled: true, mode: 'enforce', maxRepairAttempts: 1 },
  });

  const gate = evaluateActionGate({
    contract,
    finalReply: '已经保存好了。',
    mode: 'enforce',
  });

  assert.equal(gate.shouldRewrite, true);
  assert.equal(gate.rewrittenText, '我现在还没有完成保存，所以不能说已经保存好了。');
});

test('enforce mode preserves memory write with save result', () => {
  const contract = evaluateActionContract({
    requestId: 'req-memory-pass',
    message: { text: '记住这个偏好', channel: 'wechat', conversation_id: 'conv-memory-pass' },
    response: { reply_text: '已保存。', save_result: { ok: true, action_id: 'saved-private' } },
    config: { enabled: true, mode: 'enforce', maxRepairAttempts: 1 },
  });

  const gate = evaluateActionGate({
    contract,
    finalReply: '已保存。',
    mode: 'enforce',
  });

  assert.equal(gate.shouldRewrite, false);
  assert.equal(gate.gateDecision, 'pass');
});

test('enforce mode rewrites external send claims without outbound success', () => {
  const contract = evaluateActionContract({
    requestId: 'req-external-enforce',
    message: { text: '把这段话发给张三', channel: 'wechat', conversation_id: 'conv-external-enforce' },
    response: { reply_text: '已经发送成功。' },
    config: { enabled: true, mode: 'enforce', maxRepairAttempts: 1 },
  });

  const gate = evaluateActionGate({
    contract,
    finalReply: '已经发送成功。',
    mode: 'enforce',
  });

  assert.equal(gate.shouldRewrite, true);
  assert.equal(gate.rewrittenText, '我现在还没有确认发送成功，所以不能说已经发出去了。');
});

test('enforce mode rewrites failed outbound success claims', () => {
  const contract = evaluateActionContract({
    requestId: 'req-external-failed',
    message: { text: '把这段话发给张三', channel: 'wechat', conversation_id: 'conv-external-failed' },
    response: { reply_text: '已经发送成功。', outbound_result: { ok: false, error_code: 'ADAPTER_FAILED' } },
    config: { enabled: true, mode: 'enforce', maxRepairAttempts: 1 },
  });

  const gate = evaluateActionGate({
    contract,
    finalReply: '已经发送成功。',
    mode: 'enforce',
  });

  assert.equal(gate.shouldRewrite, true);
  assert.equal(gate.rewrittenText, '发送没有成功，我现在不能说已经发出去了。');
});

test('enforce mode leaves ordinary chat unchanged', () => {
  const contract = evaluateActionContract({
    requestId: 'req-none-enforce',
    message: { text: '今天有点累', channel: 'wechat', conversation_id: 'conv-none-enforce' },
    response: { reply_text: '那就先慢一点。' },
    config: { enabled: true, mode: 'enforce', maxRepairAttempts: 1 },
  });

  const gate = evaluateActionGate({
    contract,
    finalReply: '那就先慢一点。',
    mode: 'enforce',
  });

  assert.equal(gate.shouldRewrite, false);
  assert.equal(gate.rewrittenText, '那就先慢一点。');
});

test('safe rewrite avoids internal process tokens and absolute paths', () => {
  const contract = evaluateActionContract({
    requestId: 'req-safe-text',
    message: { text: '生成一张猫图', channel: 'wechat', conversation_id: 'conv-safe-text' },
    response: { reply_text: '生成好了，文件在 /opt/ran_agent/private/cat.png，token=secret。' },
    config: { enabled: true, mode: 'enforce', maxRepairAttempts: 1 },
  });

  const gate = evaluateActionGate({
    contract,
    finalReply: '生成好了，文件在 /opt/ran_agent/private/cat.png，token=secret。',
    mode: 'enforce',
  });

  assert.equal(gate.shouldRewrite, true);
  assert.equal(/Action Gate|observed evidence|token|\/opt\/ran_agent/i.test(gate.rewrittenText), false);
});

test('invalid sticker marker is not accepted as evidence', () => {
  const reply = '给你发个表情包\nRAN_MEDIA: {"source":"sticker_catalog","kind":"image","stickerId":"stk_001"}';
  const contract = evaluateActionContract({
    requestId: 'req-invalid-marker',
    message: { text: '来个表情包', channel: 'wechat', conversation_id: 'conv-invalid-marker' },
    response: { reply_text: reply },
    config: { enabled: true, mode: 'enforce', maxRepairAttempts: 1 },
  });

  const gate = evaluateActionGate({
    contract,
    finalReply: reply,
    mode: 'enforce',
  });

  assert.equal(contract.observed_evidence.some((item) => item.summary?.kind === 'sticker'), false);
  assert.equal(gate.shouldRewrite, true);
});

test('repair mode currently defers repair and applies enforce rewrite', () => {
  const contract = evaluateActionContract({
    requestId: 'req-repair-deferred',
    message: { text: '总结一下 http://xhslink.com/o/abc123', channel: 'wechat', conversation_id: 'conv-repair-deferred' },
    response: { reply_text: '我读完了，内容是旅行。' },
    config: { enabled: true, mode: 'repair', maxRepairAttempts: 1 },
  });

  const gate = evaluateActionGate({
    contract,
    finalReply: '我读完了，内容是旅行。',
    mode: 'repair',
  });

  assert.equal(gate.shouldRewrite, true);
  assert.equal(gate.finalAction, 'deferred_repair');
  assert.deepEqual(gate.reasons, ['missing_required_evidence', 'repair_deferred']);
});
