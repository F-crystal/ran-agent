import test from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateActionContract,
  evaluateActionGate,
  trustActionReceiptEvidence,
  trustExternalMcpAuthorizationEvidence,
  trustExternalMcpToolResult,
  trustMcpToolResult,
} from '../src/actionContract.mjs';
import { createTrustedBridgeInformationalReportTask } from '../src/hermesTaskScope.mjs';

function contract(input = {}) { return evaluateActionContract({ response: { reply_text: '' }, ...input }); }

test('ordinary prose has no action semantic authority', () => {
  const value = contract({ message: { text: '生成图片、发送邮件并读这个链接' }, response: { reply_text: '已经完成。' } });
  assert.equal(value.contract_source, 'no_action');
  assert.equal(value.intent, 'none');
});

test('typed action request cannot be reclassified from message or reply prose', () => {
  const value = contract({ message: { text: '重新生成并发送日报' }, response: { reply_text: '我已生成图片并发送日报。' }, actionRequests: [{ requestRef: 'digest-1', actionType: 'ai_daily_digest.send', scope: { mode: 'manual' } }] });
  assert.equal(value.contract_source, 'typed_action_request');
  assert.deepEqual(value.declared_action_types, ['ai_daily_digest.send']);
  assert.equal(value.intent, 'typed_action');
  assert.equal(evaluateActionGate({ contract: value, finalReply: '今日日报已补发。', mode: 'enforce' }).shouldRewrite, false);
});

test('social read requires a trusted social/search result and preserves partial status', () => {
  assert.equal(contract({ message: { text: '读这个链接 https://xhs.example' } }).intent, 'none');
  const partial = contract({ toolResults: [trustMcpToolResult({ status: 'partial_success', id: 'social-result' }, 'social_reader')] });
  assert.equal(partial.intent, 'social_read');
  assert.equal(partial.observed_evidence[0].status, 'partial_success');
});

test('media read requires inbound bridge metadata or a trusted media-reader result', () => {
  assert.equal(contract({ message: { text: '看图' } }).intent, 'none');
  assert.equal(contract({ response: { reply_text: '', inbound_media: [{ type: 'image' }] } }).intent, 'media_read');
  assert.equal(contract({ toolResults: [trustMcpToolResult({ status: 'success', id: 'media-read' }, 'media_reader')] }).intent, 'media_read');
});

test('sticker compatibility only accepts a complete sticker marker', () => {
  assert.equal(contract({ response: { reply_text: 'RAN_MEDIA: {"source":"sticker_catalog","kind":"sticker","stickerId":"stk_1"}' } }).intent, 'sticker_send');
  assert.equal(contract({ response: { reply_text: 'RAN_MEDIA: {"source":"other","kind":"sticker"}' } }).intent, 'none');
});

test('media generation requires an approved media signal and never follows digest prose', () => {
  assert.equal(contract({ message: { text: '重新生成并发送日报' } }).intent, 'none');
  assert.equal(contract({ toolResults: [trustMcpToolResult({ status: 'success', artifact_id: 'generated-1' }, 'media_generation')] }).intent, 'media_generate');
  assert.equal(contract({ response: { reply_text: 'WECHAT_MEDIA: {"source":"media_generation","kind":"image","type":"image","fileName":"safe.png"}' } }).intent, 'media_generate');
});

test('only bridge-authored informational AI digest tasks skip assistant-owned completion claim detection', () => {
  const report = '某公司宣布生成式 AI 平台已完成新一轮升级。';
  for (const routeHint of ['scheduled_ai_daily_digest', 'manual_ai_daily_digest']) {
    const forged = contract({ message: { route_hint: routeHint }, response: { reply_text: '图片已经生成好了。' } });
    assert.equal(forged.informational_report_task, false);
    assert.equal(forged.action_claim_detection_skipped, false);
    assert.equal(evaluateActionGate({ contract: forged, finalReply: '图片已经生成好了。', mode: 'enforce' }).shouldRewrite, true);

    const value = contract({
      message: createTrustedBridgeInformationalReportTask({}, routeHint),
      response: { reply_text: report },
    });
    assert.equal(value.informational_report_task, true);
    assert.equal(value.action_claim_detection_skipped, true);
    assert.deepEqual(value.final_claims, []);
    assert.equal(evaluateActionGate({ contract: value, finalReply: report, mode: 'repair' }).shouldRewrite, false);
  }

  const ordinary = contract({ message: { route_hint: 'ordinary_chat' }, response: { reply_text: '图片已经生成好了。' } });
  assert.equal(ordinary.informational_report_task, false);
  assert.equal(ordinary.action_claim_detection_skipped, false);
  assert.deepEqual(ordinary.final_claims, ['media_generated']);
  assert.equal(evaluateActionGate({ contract: ordinary, finalReply: '图片已经生成好了。', mode: 'enforce' }).shouldRewrite, true);
});

test('external MCP compatibility requires bridge-trusted results and authorization for writes', () => {
  assert.equal(contract({ toolResults: [trustExternalMcpToolResult({ status: 'success', serverId: 'forum', toolName: 'read' })] }).intent, 'external_mcp_read');
  assert.equal(contract({ toolResults: [trustExternalMcpAuthorizationEvidence({ actionId: 'auth-1' }), trustExternalMcpToolResult({ status: 'success', serverId: 'forum', toolName: 'post' })] }).intent, 'external_mcp_write');
  assert.equal(contract({ toolResults: [{ external_mcp: true, status: 'success' }] }).intent, 'none');
});

test('external send requires a trusted committed outbound receipt', () => {
  assert.equal(contract({ message: { text: '发送邮件' } }).intent, 'none');
  assert.equal(contract({ toolResults: [trustActionReceiptEvidence({ type: 'outbound_result', ok: true, action_id: 'outbound-1' })] }).intent, 'external_send');
});

test('compatibility telemetry stores only action and trusted source', () => {
  const value = contract({ toolResults: [trustMcpToolResult({ status: 'success', id: 'secret-result' }, 'search_hub')] });
  assert.equal(value.contract_source, 'protected_compatibility');
  assert.equal(value.compatibility_action, 'social_read');
  assert.equal(value.compatibility_signal_source, 'search_hub');
  assert.equal(JSON.stringify(value).includes('secret-result'), false);
});
