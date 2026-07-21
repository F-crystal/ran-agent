import { createHash } from 'node:crypto';
import { loadActionCompatibilityRegistry } from './actionCompatibilityRegistry.mjs';
import { isTrustedInformationalReportTask } from './hermesTaskScope.mjs';

const VALID_GATE_MODES = new Set(['observe', 'enforce', 'repair']);
const TRUSTED_ACTION_EVIDENCE = Symbol('trustedActionEvidence');

export function trustExternalMcpToolResult(result = {}) {
  return markTrustedActionEvidence({ type: 'external_mcp_tool_result', ...result }, 'external_mcp_tool_result');
}

export function trustMcpToolResult(result = {}, source = '') {
  const trustedSource = String(source || result.source || '').trim();
  if (!['social_reader', 'search_hub', 'media_reader', 'media_generation'].includes(trustedSource)) {
    throw new Error('trusted MCP tool result source is invalid');
  }
  return markTrustedActionEvidence({ ...result, source: trustedSource }, 'mcp_tool_result');
}

export function trustExternalMcpAuthorizationEvidence(result = {}) {
  return markTrustedActionEvidence({ type: 'authorization', ...result }, 'external_mcp_authorization');
}

export function trustActionReceiptEvidence(result = {}) {
  const type = String(result?.type || '').trim();
  if (!['save_result', 'outbound_result'].includes(type)) {
    throw new Error('trusted action receipt evidence type is invalid');
  }
  return markTrustedActionEvidence({ ...result, type }, 'action_receipt_result');
}

export function getActionGateConfig(env = process.env) {
  const mode = String(env.HERMES_ACTION_GATE_MODE || 'observe').trim().toLowerCase();
  return {
    enabled: String(env.HERMES_ACTION_GATE_ENABLED || 'true').trim().toLowerCase() !== 'false',
    mode: VALID_GATE_MODES.has(mode) ? mode : 'observe',
    maxRepairAttempts: normalizeNonNegativeInt(env.HERMES_ACTION_GATE_MAX_REPAIR_ATTEMPTS, 1),
  };
}

export function evaluateActionContract({
  requestId = '',
  channel = '',
  conversationId = '',
  profile = '',
  message = {},
  response = {},
  actionRequests = [],
  toolResults = [],
  actionOutcomes = [],
  config = getActionGateConfig(),
} = {}) {
  const observedEvidence = collectObservedEvidence({ response, toolResults });
  const declaredActionTypes = normalizeDeclaredActionTypes(actionRequests);
  const compatibility = declaredActionTypes.length > 0 ? null : detectCompatibilityAction(observedEvidence);
  const intent = declaredActionTypes.length > 0 ? 'typed_action' : compatibility?.action || 'none';
  const requiredEvidence = declaredActionTypes.length > 0 ? ['action_receipt'] : requiredEvidenceForIntent(intent);
  const informationalReportTask = isTrustedInformationalReportTask(message);
  const finalClaims = informationalReportTask ? [] : detectFinalClaims(response?.reply_text || response?.replyText || '');
  const hasRequiredEvidence = requiredEvidence.length === 0 || hasEvidenceForIntent(intent, observedEvidence, declaredActionTypes);
  const missingEvidence = hasRequiredEvidence ? [] : missingEvidenceForIntent(intent, observedEvidence, declaredActionTypes);
  const partialSuccessDetected = hasPartialSuccessEvidence(observedEvidence);
  const gateDecision = hasRequiredEvidence ? 'pass' : (finalClaims.length > 0 ? 'missing_evidence' : 'no_claim');

  return {
    request_id: sanitizeId(requestId),
    channel: sanitizeShortString(channel || message.channel || message.platform || ''),
    conversation_id_hash: hashShort(conversationId || message.conversation_id || message.conversationId || message.sender_id || ''),
    profile: sanitizeShortString(profile || response.profile || response.model || ''),
    contract_source: declaredActionTypes.length > 0 ? 'typed_action_request' : compatibility ? 'protected_compatibility' : 'no_action',
    declared_action_types: declaredActionTypes,
    executed_action_types: observedEvidence.filter((item) => item.receipt_status).map((item) => item.action_type).filter(Boolean),
    compatibility_action: compatibility?.action || '',
    compatibility_signal_source: compatibility?.source || '',
    informational_report_task: informationalReportTask,
    action_claim_detection_skipped: informationalReportTask,
    gate_mode: config?.enabled === false ? 'disabled' : sanitizeShortString(config?.mode || 'observe'),
    intent,
    required_evidence: requiredEvidence,
    observed_evidence: observedEvidence,
    final_claims: finalClaims,
    original_claim_types: finalClaims,
    gate_decision: gateDecision,
    rewrite_reason: '',
    evidence_satisfied: hasRequiredEvidence,
    missing_evidence: missingEvidence,
    partial_success_detected: partialSuccessDetected,
    continuity_outcomes: sanitizeContinuityOutcomes(actionOutcomes),
    continuity_reference: isContinuityReference(message?.text),
    repair_attempted: false,
    final_action: config?.enabled === false ? 'disabled' : 'observe_only',
  };
}

export function evaluateActionGate({
  contract = {},
  finalReply = '',
  mode = contract.gate_mode || 'observe',
} = {}) {
  const normalizedMode = VALID_GATE_MODES.has(String(mode || '').trim().toLowerCase())
    ? String(mode || '').trim().toLowerCase()
    : 'observe';
  const text = String(finalReply || '');
  const intent = contract.intent || 'none';
  const claims = Array.isArray(contract.final_claims) ? contract.final_claims : [];
  const evidence = Array.isArray(contract.observed_evidence) ? contract.observed_evidence : [];
  const evidenceSatisfied = hasEvidenceForIntent(intent, evidence, contract.declared_action_types || []);
  const missingEvidence = evidenceSatisfied ? [] : missingEvidenceForIntent(intent, evidence, contract.declared_action_types || []);
  const partialSuccessDetected = hasPartialSuccessEvidence(evidence);
  const typedReceipts = evidence.filter((item) => item.receipt_status && contract.declared_action_types?.includes(item.action_type));
  const continuitySupportsClaim = contract.continuity_reference === true
    && continuitySupportsClaims(contract.continuity_outcomes, claims);
  const continuityCorrection = contract.continuity_reference === true
    ? continuityCorrectionForClaims(contract.continuity_outcomes, claims)
    : '';
  const reasons = [];
  let shouldRewrite = false;
  let rewrittenText = text;

  if (contract.gate_mode === 'disabled') {
    return buildGateResult({
      shouldRewrite: false,
      rewrittenText: text,
      gateDecision: 'disabled',
      finalAction: 'disabled',
      evidenceSatisfied,
      missingEvidence,
      partialSuccessDetected,
      reasons,
      contract,
    });
  }

  if (normalizedMode === 'observe') {
    return buildGateResult({
      shouldRewrite: false,
      rewrittenText: text,
      gateDecision: 'observe_only',
      finalAction: 'observe_only',
      evidenceSatisfied,
      missingEvidence,
      partialSuccessDetected,
      reasons,
      contract,
    });
  }

  const actionClaimed = hasActionClaimForIntent(intent, claims);
  const successClaims = claims.filter((claim) => !['external_not_sent', 'state_not_changed', 'full_failure'].includes(claim));
  const unverifiedSuccessClaim = intent === 'none' && successClaims.length > 0 && !continuitySupportsClaim;
  const partialClaimMismatch = partialSuccessDetected && hasPartialMismatchClaim(claims);
  const failedOutboundSuccessClaim = intent === 'external_send' && hasFailedOutboundEvidence(evidence) && claims.includes('external_sent');

  if (continuityCorrection) {
    shouldRewrite = true;
    reasons.push('continuity_outcome_conflict');
    rewrittenText = rewriteActionClaims(text, [continuityCorrection]);
  } else if (intent === 'typed_action' && typedReceipts.length === 0 && actionClaimed) {
    shouldRewrite = true;
    reasons.push('typed_action_receipt_missing');
    rewrittenText = rewriteActionClaims(text, ['我目前不能确认这一步已经执行。']);
  } else if (intent === 'typed_action' && typedOutcomeContradictsClaims(typedReceipts, claims)) {
    shouldRewrite = true;
    reasons.push('typed_action_outcome_mismatch');
    rewrittenText = rewriteActionClaims(text, typedReceipts.map((item) => item.result_summary).filter(Boolean));
  } else if (unverifiedSuccessClaim) {
    shouldRewrite = true;
    reasons.push('unverified_success_claim');
    rewrittenText = successClaims.some((claim) => ['external_sent', 'state_changed', 'external_mcp_action_done'].includes(claim))
      ? rewriteActionClaims(text, ['我目前不能确认这一步已经执行。'])
      : '尚未收到可验证的执行结果，暂不确认已完成。';
  } else if (partialClaimMismatch) {
    shouldRewrite = true;
    reasons.push('partial_success_claim_mismatch');
    rewrittenText = partialRewriteForIntent(intent);
  } else if (failedOutboundSuccessClaim) {
    shouldRewrite = true;
    reasons.push('outbound_failed_success_claim');
    rewrittenText = '发送结果显示失败，未发送给外部对象。';
  } else if (!evidenceSatisfied && actionClaimed) {
    shouldRewrite = true;
    reasons.push('missing_required_evidence');
    rewrittenText = missingEvidenceRewriteForIntent(intent);
  }

  let finalAction = shouldRewrite ? 'safe_rewrite' : 'pass_through';
  if (normalizedMode === 'repair') {
    if (shouldRewrite) {
      reasons.push('repair_deferred');
      finalAction = 'deferred_repair';
    } else {
      finalAction = 'pass_through';
    }
  }

  return buildGateResult({
    shouldRewrite,
    rewrittenText,
    gateDecision: shouldRewrite ? 'rewrite' : 'pass',
    finalAction,
    evidenceSatisfied,
    missingEvidence,
    partialSuccessDetected,
    reasons,
    contract,
  });
}

export function applyActionGateTelemetry(contract = {}, gate = {}, repair = {}) {
  return {
    ...contract,
    gate_decision: gate.gateDecision || contract.gate_decision || '',
    rewrite_reason: Array.isArray(gate.reasons) ? gate.reasons.join(',') : '',
    original_claim_types: Array.isArray(contract.final_claims) ? contract.final_claims : [],
    final_claims: Array.isArray(contract.final_claims) ? contract.final_claims : [],
    final_action: gate.finalAction || contract.final_action || '',
    evidence_satisfied: Boolean(gate.evidenceSatisfied),
    missing_evidence: Array.isArray(gate.missingEvidence) ? gate.missingEvidence : [],
    partial_success_detected: Boolean(gate.partialSuccessDetected),
    repair_attempted: Boolean(repair.repairAttempted),
    repair_type: sanitizeShortString(repair.repairType || ''),
    repair_status: sanitizeShortString(repair.repairStatus || (repair.repairAttempted ? 'failed' : 'skipped')),
    repair_evidence_added: Array.isArray(repair.repairEvidenceAdded) ? repair.repairEvidenceAdded.map((item) => sanitizeShortString(item)) : [],
    repair_error_code: sanitizeShortString(repair.repairErrorCode || ''),
    repair_trigger_source: sanitizeShortString(repair.repairTriggerSource || 'none'),
    repair_session_scope: sanitizeShortString(repair.repairSessionScope || 'none'),
    repair_attempt_count: Number.isInteger(repair.repairAttemptCount) ? repair.repairAttemptCount : 0,
    repair_recursive_blocked: repair.repairRecursiveBlocked !== false,
    pending_action_id: sanitizeShortString(contract.pending_action_id || ''),
    pending_action_type: sanitizeShortString(contract.pending_action_type || ''),
    pending_action_status: sanitizeShortString(contract.pending_action_status || ''),
    confirmation_detected: Boolean(contract.confirmation_detected),
    confirmation_result: sanitizeShortString(contract.confirmation_result || ''),
    execution_status: sanitizeShortString(contract.execution_status || ''),
    execution_evidence_added: Array.isArray(contract.execution_evidence_added)
      ? contract.execution_evidence_added.map((item) => sanitizeShortString(item))
      : [],
  };
}

export function logActionContract(result = {}, logger = console) {
  logger?.log?.(`[hermes-action-contract] ${JSON.stringify(result)}`);
}

function normalizeDeclaredActionTypes(actionRequests) {
  if (!Array.isArray(actionRequests)) return [];
  return [...new Set(actionRequests.map((item) => sanitizeShortString(item?.actionType)).filter(Boolean))];
}

function detectCompatibilityAction(evidence = []) {
  const registry = loadActionCompatibilityRegistry();
  if (hasEvidenceForIntent('external_mcp_write', evidence)) return { action: 'external_mcp_write', source: 'external_mcp' };
  for (const action of Object.keys(registry.actions)) {
    if (action === 'external_mcp_write') continue;
    if (hasEvidenceForIntent(action, evidence)) {
      const source = evidence.find((item) => item.source)?.source || evidence.find((item) => item.type === 'marker')?.summary?.source || '';
      return { action, source: sanitizeShortString(source) };
    }
  }
  return null;
}

function requiredEvidenceForIntent(intent) {
  switch (intent) {
    case 'social_read':
      return ['tool_result'];
    case 'media_read':
      return ['artifact'];
    case 'sticker_send':
      return ['RAN_MEDIA'];
    case 'media_generate':
      return ['WECHAT_MEDIA', 'RAN_MEDIA', 'artifact'];
    case 'memory_write':
      return ['save_result'];
    case 'external_send':
      return ['authorization', 'outbound_result'];
    case 'external_mcp_read':
      return ['external_mcp_tool_result'];
    case 'external_mcp_write':
      return ['authorization', 'external_mcp_tool_result'];
    default:
      return [];
  }
}

function collectObservedEvidence({ response = {}, toolResults = [] } = {}) {
  const evidence = [];
  const replyText = String(response.reply_text || response.replyText || '');
  evidence.push(...extractMarkerEvidence(replyText));
  if (response.media && typeof response.media === 'object' && !Array.isArray(response.media)) {
    evidence.push(summarizeMediaEvidence(response.media));
  }
  if (normalizeMediaItems(response.inbound_media || response.inboundMedia).length > 0) {
    evidence.push({ type: 'inbound_media', status: 'present', source: 'bridge' });
  }
  if (response.save_result?.[TRUSTED_ACTION_EVIDENCE] === 'action_receipt_result') {
    evidence.push(summarizeStateResult('save_result', response.save_result));
  }
  if (response.outbound_result?.[TRUSTED_ACTION_EVIDENCE] === 'action_receipt_result') {
    evidence.push(summarizeStateResult('outbound_result', response.outbound_result));
  }
  for (const toolResult of Array.isArray(toolResults) ? toolResults : []) {
    const summary = summarizeToolResult(toolResult);
    if (summary) evidence.push(summary);
  }
  return evidence.filter(Boolean);
}

function hasEvidenceForIntent(intent, evidence = [], declaredActionTypes = []) {
  if (intent === 'none') return true;
  if (intent === 'typed_action') {
    return declaredActionTypes.length > 0 && declaredActionTypes.every((actionType) => (
      evidence.some((item) => item.action_type === actionType && item.receipt_status)
    ));
  }
  if (intent === 'social_read') {
    return evidence.some((item) => item.type === 'tool_result' && ['social_reader', 'search_hub'].includes(item.source) && ['success', 'partial_success'].includes(item.status));
  }
  if (intent === 'media_read') {
    return evidence.some((item) => item.type === 'inbound_media')
      || evidence.some((item) => item.type === 'tool_result' && item.source === 'media_reader' && ['success', 'partial_success'].includes(item.status));
  }
  if (intent === 'sticker_send') {
    return evidence.some((item) => item.type === 'marker' && item.marker === 'RAN_MEDIA' && item.summary?.source === 'sticker_catalog' && item.summary?.kind === 'sticker' && item.summary?.stickerId);
  }
  if (intent === 'media_generate') {
    return evidence.some((item) => item.type === 'marker' && item.status === 'present' && ['WECHAT_MEDIA', 'RAN_MEDIA'].includes(item.marker) && ['media_generation', 'media_generation_mcp'].includes(item.summary?.source))
      || evidence.some((item) => item.type === 'tool_result' && item.source === 'media_generation' && item.status === 'success')
      || evidence.some((item) => item.type === 'artifact' && item.source === 'media_generation');
  }
  if (intent === 'memory_write') {
    return evidence.some((item) => item.type === 'save_result' || (item.type === 'tool_result' && item.status === 'success'));
  }
  if (intent === 'external_send') {
    return evidence.some((item) => (item.type === 'outbound_result' && item.status === 'success') || (item.type === 'tool_result' && item.status === 'success'));
  }
  if (intent === 'external_mcp_read') {
    return evidence.some((item) => item.type === 'external_mcp_tool_result' && ['success', 'partial_success'].includes(item.status));
  }
  if (intent === 'external_mcp_write') {
    return evidence.some((item) => item.type === 'authorization' && item.status === 'present')
      && evidence.some((item) => item.type === 'external_mcp_tool_result' && item.status === 'success');
  }
  return false;
}

function detectFinalClaims(replyText = '') {
  const text = String(replyText || '');
  const claims = [];
  const partialReadClaim = /读到.*一部分|一部分.*读到|部分.*(?:成功|内容)|有些.*(?:没有成功|失败)|还有些.*(?:没有成功|失败)/.test(text);
  if (!partialReadClaim && /读到了|读到.*(?:全文|正文|原文|内容)|(?:看完|读完|读过|读取了)|(?:全文|原文|正文|内容)\s*(?:是|如下)|帖子说|笔记说|文章说|核心观点是/.test(text)) {
    claims.push('read_complete');
  }
  if (/图片里|图里|视频里|音频里|截图里|画面里|我看到/.test(text)) {
    claims.push('media_described');
  }
  if (/发.*(?:表情包|贴纸)|给你.*(?:表情包|贴纸)|表情包.*(?:来了|给你)/.test(text)) {
    claims.push('sticker_sent');
  }
  if (/(?:生成|画|语音).*(?:好了|完成|发你|给你)|已经.*(?:生成|发出)/.test(text)) {
    claims.push('media_generated');
  }
  if (/已保存|已经保存|保存好了|记住了|已更新|已经更新|已删除|删除好了/.test(text)) {
    claims.push('state_changed');
  }
  if (/已发送|已经发送|发送成功|已经发出|已补发|已经补发|转发好了/.test(text)) {
    claims.push('external_sent');
  }
  if (/未发送|没有发送|没发出|发送失败|无法确认.*送达/.test(text)) {
    claims.push('external_not_sent');
  }
  if (/未更新|没有更新|更新失败|无法确认.*更新/.test(text)) {
    claims.push('state_not_changed');
  }
  if (/(已经|已).*(?:评论|回复|发帖|点赞|关注|提交|走棋|下棋|交易|保存|删除|操作).*(?:成功|完成|好了)|(?:评论|回复|发帖|点赞|关注|提交|走棋|下棋|交易|操作)成功/.test(text)) {
    claims.push('external_mcp_action_done');
  }
  if (/完全失败|所有.*失败|所有路.*堵住|完全没读到/.test(text)) {
    claims.push('full_failure');
  }
  return [...new Set(claims)];
}

function buildGateResult({
  shouldRewrite,
  rewrittenText,
  gateDecision,
  finalAction,
  evidenceSatisfied,
  missingEvidence,
  partialSuccessDetected,
  reasons,
  contract,
}) {
  return {
    shouldRewrite: Boolean(shouldRewrite),
    rewrittenText: String(rewrittenText || ''),
    gateDecision,
    finalAction,
    reasons: Array.isArray(reasons) ? reasons : [],
    sanitizedEvidenceSummary: Array.isArray(contract.observed_evidence) ? contract.observed_evidence : [],
    evidenceSatisfied: Boolean(evidenceSatisfied),
    missingEvidence: Array.isArray(missingEvidence) ? missingEvidence : [],
    partialSuccessDetected: Boolean(partialSuccessDetected),
  };
}

function hasActionClaimForIntent(intent, claims = []) {
  if (intent === 'typed_action') return claims.some((claim) => ['state_changed', 'external_sent', 'external_mcp_action_done'].includes(claim));
  if (intent === 'social_read') return claims.includes('read_complete');
  if (intent === 'media_read') return claims.includes('media_described');
  if (intent === 'sticker_send') return claims.includes('sticker_sent');
  if (intent === 'media_generate') return claims.includes('media_generated');
  if (intent === 'memory_write') return claims.includes('state_changed');
  if (intent === 'external_send') return claims.includes('external_sent');
  if (intent === 'external_mcp_read') return claims.includes('read_complete');
  if (intent === 'external_mcp_write') return claims.includes('external_mcp_action_done') || claims.includes('state_changed') || claims.includes('external_sent');
  return false;
}

function typedOutcomeContradictsClaims(receipts = [], claims = []) {
  if (claims.includes('external_sent')) {
    const outbound = receipts.filter((item) => ['feishu.message.send', 'ai_daily_digest.send'].includes(item.action_type));
    if (outbound.length === 0 || !outbound.some((item) => item.receipt_status === 'succeeded')) return true;
  }
  if (claims.includes('state_changed')) {
    const writes = receipts.filter((item) => item.action_type === 'feishu.document.update' || String(item.action_type || '').startsWith('memory.'));
    if (writes.length === 0 || !writes.some((item) => item.receipt_status === 'succeeded')) return true;
  }
  return false;
}

function hasPartialMismatchClaim(claims = []) {
  return claims.includes('read_complete') || claims.includes('media_described') || claims.includes('full_failure');
}

function hasPartialSuccessEvidence(evidence = []) {
  return evidence.some((item) => item?.status === 'partial_success');
}

function hasFailedOutboundEvidence(evidence = []) {
  return evidence.some((item) => item?.type === 'outbound_result' && item?.status === 'failure');
}

function missingEvidenceForIntent(intent, evidence = [], declaredActionTypes = []) {
  if (hasEvidenceForIntent(intent, evidence, declaredActionTypes)) return [];
  if (intent === 'typed_action') return ['action_receipt'];
  return requiredEvidenceForIntent(intent);
}

function rewriteActionClaims(value, summaries = []) {
  const claimPattern = /(?:已经|已)(?:成功)?(?:发送|发出|补发|更新|修改|保存|写入)|(?:发送|更新|保存)(?:成功|完成|好了|失败)|(?:未|没有|没)(?:发送|发出|更新|修改|保存|写入)|无法确认.*(?:送达|更新)/;
  const ordinary = String(value || '').trim()
    .split(/(?<=[。！？.!])\s*|\n+/)
    .map((sentence) => {
      const item = sentence.trim();
      const terminal = /[。！？.!]$/.test(item) ? item.slice(-1) : '';
      const body = terminal ? item.slice(0, -1) : item;
      const kept = body.split(/[，,；;]/).map((part) => part.trim()).filter((part) => part && !claimPattern.test(part));
      return kept.length > 0 ? `${kept.join('，')}${terminal}` : '';
    })
    .filter(Boolean)
    .join('\n\n');
  return [ordinary, ...summaries.map((item) => sanitizeOutcomeSummary(item)).filter(Boolean)].filter(Boolean).join('\n\n');
}

function continuityCorrectionForClaims(outcomes = [], claims = []) {
  if (!Array.isArray(outcomes) || outcomes.length === 0) return '';
  if (claims.includes('external_not_sent')) {
    const latest = outcomes.find((item) => item.action_type === 'feishu.message.send');
    return latest?.status === 'succeeded' ? latest.result_summary || '' : '';
  }
  if (claims.includes('state_not_changed')) {
    const latest = outcomes.find((item) => item.action_type === 'feishu.document.update');
    return latest?.status === 'succeeded' ? latest.result_summary || '' : '';
  }
  if (claims.includes('external_sent')) {
    const latest = outcomes.find((item) => ['feishu.message.send', 'ai_daily_digest.send'].includes(item.action_type));
    return latest && latest.status !== 'succeeded' ? latest.result_summary || '' : '';
  }
  if (claims.includes('state_changed')) {
    const latest = outcomes.find((item) => item.action_type === 'feishu.document.update');
    return latest && latest.status !== 'succeeded' ? latest.result_summary || '' : '';
  }
  return '';
}

function continuitySupportsClaims(outcomes = [], claims = []) {
  if (!Array.isArray(outcomes) || outcomes.length === 0 || claims.length === 0) return false;
  if (claims.includes('external_sent')) {
    return outcomes.find((item) => item.action_type === 'feishu.message.send')?.status === 'succeeded';
  }
  if (claims.includes('state_changed')) {
    return outcomes.find((item) => item.action_type === 'feishu.document.update')?.status === 'succeeded';
  }
  return false;
}

function isContinuityReference(value) {
  return /(?:刚才|之前|那一步|上一步|结果|状态|是否|有没有|成功了吗|送达了吗|怎么样|怎么了)/.test(String(value || ''));
}

function sanitizeContinuityOutcomes(items) {
  return (Array.isArray(items) ? items : []).slice(0, 8).map((item) => ({
    action_type: sanitizeShortString(item?.actionType),
    target: sanitizeShortString(item?.target),
    status: ['succeeded', 'failed', 'partial', 'ambiguous', 'rejected'].includes(String(item?.status || '')) ? String(item.status) : 'rejected',
    result_summary: sanitizeOutcomeSummary(item?.summary),
    confirmed_at: sanitizeShortString(item?.confirmedAt),
    retryable: item?.retryable === true,
  }));
}

function sanitizeOutcomeSummary(value) {
  return redactSecrets(String(value || '').trim().replace(/[\r\n\t]/g, ' ')).slice(0, 500);
}

function missingEvidenceRewriteForIntent(intent) {
  switch (intent) {
    case 'social_read':
      return '链接内容未成功读取，未生成正文判断。可以重试，或发送截图/正文。';
    case 'media_read':
      return '媒体内容未成功读取，未生成内容描述。';
    case 'sticker_send':
      return '收到这个表情包请求。';
    case 'media_generate':
      return '生成结果尚未返回，暂未发送成品。';
    case 'memory_write':
      return '保存结果尚未返回，未写入长期记忆。';
    case 'external_send':
      return '发送结果尚未确认，未发送给外部对象。';
    case 'external_mcp_read':
      return '外部内容未成功读取，未生成内容判断。';
    case 'external_mcp_write':
      return '外部操作结果尚未确认，未执行外部写入。';
    default:
      return '';
  }
}

function partialRewriteForIntent(intent) {
  if (intent === 'media_read') {
    return '已读取到部分媒体内容，但还有些细节没有成功获取。';
  }
  return '已读取到部分内容，但有些媒体或细节没有成功获取。';
}

function extractMarkerEvidence(text = '') {
  const evidence = [];
  const markerPattern = /^(RAN_MEDIA|WECHAT_MEDIA):\s*(\{.*\})\s*$/gim;
  let match;
  while ((match = markerPattern.exec(String(text || ''))) !== null) {
    const marker = match[1];
    const parsed = parseJsonObject(match[2]);
    evidence.push({
      type: 'marker',
      marker,
      status: parsed ? 'present' : 'invalid_json',
      summary: marker === 'RAN_MEDIA' ? summarizeRanMedia(parsed) : summarizeWechatMedia(parsed),
    });
  }
  return evidence;
}

function summarizeRanMedia(payload) {
  if (!payload) return {};
  return {
    source: sanitizeShortString(payload.source),
    kind: sanitizeShortString(payload.kind),
    stickerId: sanitizeShortString(payload.stickerId),
  };
}

function summarizeWechatMedia(payload) {
  if (!payload) return {};
  return {
    source: sanitizeShortString(payload.source),
    kind: sanitizeShortString(payload.kind),
    type: sanitizeShortString(payload.type),
    fileName: sanitizeFileName(payload.fileName || payload.filename),
  };
}

function summarizeMediaEvidence(media = {}) {
  return {
    type: 'artifact',
    status: 'present',
    source: sanitizeShortString(media.source),
    kind: sanitizeShortString(media.kind),
    media_type: sanitizeShortString(media.type || media.media_type),
    artifact_id_hash: hashOptional(media.artifact_id || media.artifactId || media.id || media.url || media.filePath),
    fileName: sanitizeFileName(media.fileName || media.filename),
  };
}

function summarizeToolResult(result = {}) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  if (['save_result', 'outbound_result'].includes(result.type)) {
    if (result[TRUSTED_ACTION_EVIDENCE] !== 'action_receipt_result') return null;
    return summarizeStateResult(result.type, result);
  }
  if (result.type === 'authorization') {
    return summarizeTrustedAuthorization(result);
  }
  if (result.type === 'external_mcp_tool_result' || result.external_mcp === true || result.externalMcp === true) {
    if (result[TRUSTED_ACTION_EVIDENCE] !== 'external_mcp_tool_result') return null;
    return summarizeExternalMcpToolResult(result);
  }
  if (result[TRUSTED_ACTION_EVIDENCE] !== 'mcp_tool_result') return null;
  const ok = result.ok === true || result.status === 'success';
  const coverage = summarizeMediaCoverage(result);
  const partial = result.partial_success === true
    || result.partialSuccess === true
    || result.status === 'partial_success'
    || coverage.partial === true;
  const summary = {
    type: 'tool_result',
    tool: sanitizeShortString(result.toolName || result.tool_name || result.name),
    status: partial ? 'partial_success' : ok ? 'success' : 'failure',
    artifact_id_hash: hashOptional(result.artifact_id || result.artifactId || result.id),
    error_code: sanitizeShortString(result.error_code || result.errorCode || result.code),
    source: sanitizeShortString(result.source),
  };
  if (coverage.totalMediaCount !== null) summary.total_media_count = coverage.totalMediaCount;
  if (coverage.analyzedMediaCount !== null) summary.analyzed_media_count = coverage.analyzedMediaCount;
  if (coverage.successfulMediaCount !== null) summary.successful_media_count = coverage.successfulMediaCount;
  if (coverage.partialFailuresCount > 0) summary.partial_failures_count = coverage.partialFailuresCount;
  if (coverage.truncatedByMaxAssets) summary.truncated_by_max_assets = true;
  if (coverage.warnings.length > 0) summary.warnings = coverage.warnings;
  return summary;
}

function summarizeExternalMcpToolResult(result = {}) {
  const ok = result.ok === true || result.status === 'success';
  const partial = result.partial_success === true || result.partialSuccess === true || result.status === 'partial_success';
  return {
    type: 'external_mcp_tool_result',
    server_id: sanitizeShortString(result.serverId || result.server_id),
    tool: sanitizeShortString(result.toolName || result.tool_name || result.name),
    tier: sanitizeShortString(result.tier || ''),
    status: partial ? 'partial_success' : ok ? 'success' : 'failure',
    result_id_hash: hashOptional(result.resultId || result.result_id || result.artifact_id || result.artifactId || result.id),
    error_code: sanitizeShortString(result.error_code || result.errorCode || result.code),
  };
}

function summarizeTrustedAuthorization(result = {}) {
  if (result[TRUSTED_ACTION_EVIDENCE] !== 'external_mcp_authorization') return null;
  return {
    type: 'authorization',
    status: 'present',
    source: sanitizeShortString(result.source || 'external_mcp_pending'),
    result_id_hash: hashOptional(result.actionId || result.action_id || result.grantId || result.grant_id || result.id),
  };
}

function summarizeMediaCoverage(result = {}) {
  const mediaAnalysis = result.media_analysis && typeof result.media_analysis === 'object' && !Array.isArray(result.media_analysis)
    ? result.media_analysis
    : result.mediaAnalysis && typeof result.mediaAnalysis === 'object' && !Array.isArray(result.mediaAnalysis)
      ? result.mediaAnalysis
      : {};
  const totalMediaCount = normalizeOptionalNonNegativeInt(
    firstDefined(result.total_media_count, result.totalMediaCount, result.media_count, result.mediaCount)
  );
  const analyzedMediaCount = normalizeOptionalNonNegativeInt(
    firstDefined(
      result.analyzed_media_count,
      result.analyzedMediaCount,
      result.successful_media_count,
      result.successfulMediaCount
    )
  );
  const successfulMediaCount = normalizeOptionalNonNegativeInt(
    firstDefined(
      result.successful_media_count,
      result.successfulMediaCount,
      Array.isArray(mediaAnalysis.items) ? mediaAnalysis.items.length : undefined,
      result.analyzed_media_count,
      result.analyzedMediaCount
    )
  );
  const partialFailuresCount = normalizeOptionalNonNegativeInt(
    firstDefined(
      result.partial_failures_count,
      result.partialFailuresCount,
      Array.isArray(result.partial_failures) ? result.partial_failures.length : undefined,
      Array.isArray(mediaAnalysis.partial_failures) ? mediaAnalysis.partial_failures.length : undefined
    )
  ) || 0;
  const warnings = [
    ...normalizeWarningCodes(result.warnings),
    ...normalizeWarningCodes(mediaAnalysis.warnings),
  ];
  const truncatedByMaxAssets = result.truncated_by_max_assets === true || result.truncatedByMaxAssets === true;
  const effectiveMediaCount = successfulMediaCount ?? analyzedMediaCount;
  const coverageShortfall = totalMediaCount !== null && effectiveMediaCount !== null && totalMediaCount > effectiveMediaCount;
  const submittedShortfall = analyzedMediaCount !== null && successfulMediaCount !== null && analyzedMediaCount > successfulMediaCount;
  const analysisPartial = mediaAnalysis.partial === true || mediaAnalysis.partial_success === true || mediaAnalysis.partialSuccess === true;
  const timeoutWarning = warnings.some((item) => /TIMEOUT|TRUNCATED|PARTIAL/i.test(item));
  return {
    totalMediaCount,
    analyzedMediaCount,
    successfulMediaCount,
    partialFailuresCount,
    warnings,
    truncatedByMaxAssets,
    partial: coverageShortfall || submittedShortfall || analysisPartial || partialFailuresCount > 0 || truncatedByMaxAssets || timeoutWarning,
  };
}

function summarizeStateResult(type, result = {}) {
  return {
    type,
    status: result.ok === true || result.status === 'success' ? 'success' : 'failure',
    receipt_status: ['succeeded', 'failed', 'partial', 'ambiguous', 'rejected'].includes(String(result.receipt_status || ''))
      ? String(result.receipt_status)
      : result.ok === true ? 'succeeded' : 'failed',
    action_type: sanitizeShortString(result.action_type || result.actionType),
    result_summary: sanitizeOutcomeSummary(result.result_summary || result.resultSummary),
    target: sanitizeShortString(result.target),
    retryable: result.retryable === true,
    result_id_hash: hashOptional(result.action_id || result.actionId || result.id || result.message_id || result.messageId),
    error_code: sanitizeShortString(result.error_code || result.errorCode || result.code),
  };
}

function parseJsonObject(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeMediaItems(media) {
  if (!media) return [];
  return Array.isArray(media) ? media.filter((item) => item && typeof item === 'object') : [media].filter(Boolean);
}

function normalizeStringArray(items) {
  return Array.isArray(items) ? items.filter((item) => typeof item === 'string' && item.trim()) : [];
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function normalizeOptionalNonNegativeInt(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function normalizeWarningCodes(items) {
  return Array.isArray(items)
    ? items.map((item) => {
      if (typeof item === 'string') return sanitizeShortString(item);
      if (item && typeof item === 'object') return sanitizeShortString(item.code || item.error_code || item.errorCode);
      return '';
    }).filter(Boolean).slice(0, 8)
    : [];
}

function hasUrl(text) {
  return /https?:\/\/[^\s"'<>【】「」《》，。！？、；：]+/i.test(String(text || ''));
}

function sanitizeId(value) {
  return sanitizeShortString(value || '').replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 80);
}

function sanitizeShortString(value) {
  return redactSecrets(String(value || '').trim().replace(/[\r\n\t]/g, ' ')).slice(0, 120);
}

function sanitizeFileName(value) {
  return String(value || '').trim().split(/[\\/]/).pop().replace(/[\r\n\t]/g, ' ').slice(0, 120);
}

function hashOptional(value) {
  const text = String(value || '').trim();
  return text ? hashShort(text) : '';
}

function hashShort(value) {
  return createHash('sha256').update(String(value || ''), 'utf8').digest('hex').slice(0, 16);
}

function markTrustedActionEvidence(input, kind) {
  const output = input && typeof input === 'object' && !Array.isArray(input) ? { ...input } : {};
  Object.defineProperty(output, TRUSTED_ACTION_EVIDENCE, {
    value: kind,
    enumerable: false,
    configurable: false,
  });
  return output;
}

function redactSecrets(value) {
  return String(value || '')
    .replace(/authorization\s*:\s*bearer\s+\S+/gi, 'authorization=[redacted]')
    .replace(/\b(api[_-]?key|token|secret|password|sessdata)\s*[:=]\s*[^ ,;}]+/gi, '$1=[redacted]')
    .replace(/cookie\s*=\s*[^ ]+/gi, 'cookie=[redacted]')
    .replace(/session[-_\w]*\s*=\s*[^ ]+/gi, 'session=[redacted]')
    .replace(/sk-[a-z0-9_-]{8,}/gi, '[redacted-secret]')
    .replace(/xox[baprs]-[a-z0-9_-]+/gi, '[redacted-secret]');
}

function normalizeNonNegativeInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
