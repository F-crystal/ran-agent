import { createHash } from 'node:crypto';

const VALID_GATE_MODES = new Set(['observe', 'enforce', 'repair']);
const TRUSTED_ACTION_EVIDENCE = Symbol('trustedActionEvidence');

export function trustExternalMcpToolResult(result = {}) {
  return markTrustedActionEvidence(result, 'external_mcp_tool_result');
}

export function trustExternalMcpAuthorizationEvidence(result = {}) {
  return markTrustedActionEvidence({ type: 'authorization', ...result }, 'external_mcp_authorization');
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
  toolResults = [],
  config = getActionGateConfig(),
} = {}) {
  const intent = detectActionIntent(message, response);
  const requiredEvidence = requiredEvidenceForIntent(intent);
  const observedEvidence = collectObservedEvidence({ response, toolResults });
  const finalClaims = detectFinalClaims(response?.reply_text || response?.replyText || '');
  const hasRequiredEvidence = requiredEvidence.length === 0 || hasEvidenceForIntent(intent, observedEvidence);
  const missingEvidence = hasRequiredEvidence ? [] : missingEvidenceForIntent(intent, observedEvidence);
  const partialSuccessDetected = hasPartialSuccessEvidence(observedEvidence);
  const gateDecision = hasRequiredEvidence ? 'pass' : (finalClaims.length > 0 ? 'missing_evidence' : 'no_claim');

  return {
    request_id: sanitizeId(requestId),
    channel: sanitizeShortString(channel || message.channel || message.platform || ''),
    conversation_id_hash: hashShort(conversationId || message.conversation_id || message.conversationId || message.sender_id || ''),
    profile: sanitizeShortString(profile || response.profile || response.model || ''),
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
  const evidenceSatisfied = hasEvidenceForIntent(intent, evidence);
  const missingEvidence = evidenceSatisfied ? [] : missingEvidenceForIntent(intent, evidence);
  const partialSuccessDetected = hasPartialSuccessEvidence(evidence);
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
  const partialClaimMismatch = partialSuccessDetected && hasPartialMismatchClaim(claims);
  const failedOutboundSuccessClaim = intent === 'external_send' && hasFailedOutboundEvidence(evidence) && claims.includes('external_sent');

  if (partialClaimMismatch) {
    shouldRewrite = true;
    reasons.push('partial_success_claim_mismatch');
    rewrittenText = partialRewriteForIntent(intent);
  } else if (failedOutboundSuccessClaim) {
    shouldRewrite = true;
    reasons.push('outbound_failed_success_claim');
    rewrittenText = '发送结果显示失败，已取消完成态表述。';
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

function detectActionIntent(message = {}, response = {}) {
  const text = `${message.text || ''}\n${response.reply_text || response.replyText || ''}`;
  const routeHint = `${message.route_hint || ''}\n${response.route_hint || ''}`;
  const hasMedia = normalizeMediaItems(message.media).length > 0 || normalizeStringArray(message.image_urls).length > 0;
  const externalMcpSignal = /external[_ -]?mcp|外部\s*MCP/i.test(`${text}\n${routeHint}`);

  if (externalMcpSignal) {
    if (/(评论|回复|发帖|点赞|关注|提交|走棋|下棋|交易|购买|转账|删除|保存|post|comment|like|follow|submit|move|trade|delete|purchase|buy)/i.test(text)) {
      return 'external_mcp_write';
    }
    return 'external_mcp_read';
  }

  if (/(发邮件|发送邮件|转发|批量外发|发给|发送给|外发)|send email/i.test(text)) {
    return 'external_send';
  }
  if (/记住|保存.*(?:记忆|偏好)|长期记忆|保存这个为表情包|加入表情包|批注|写入/.test(text)) {
    return 'memory_write';
  }
  if (/表情包|贴纸|\bsticker\b|RAN_MEDIA/i.test(text)) {
    return 'sticker_send';
  }
  if (/(?:生成|做|画).*(?:图片|图|语音|视频)|朗读|发(?:图|语音)|WECHAT_MEDIA/.test(text)) {
    return 'media_generate';
  }
  if (hasMedia || /看(?:下|看)?.*(?:图|图片|视频|文件)|听.*(?:音频|语音)|分析.*(?:视频|图片|截图)|读.*文件|图片里|图里/.test(text)) {
    return 'media_read';
  }
  if (hasUrl(text) || /读(?:一下|这个|链接)|看(?:一下|这个链接)|总结(?:一下|这个)|小红书|公众号|B站|bilibili|xhslink|xiaohongshu/i.test(text)) {
    return 'social_read';
  }
  return 'none';
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
  if (response.save_result && typeof response.save_result === 'object' && !Array.isArray(response.save_result)) {
    evidence.push(summarizeStateResult('save_result', response.save_result));
  }
  if (response.outbound_result && typeof response.outbound_result === 'object' && !Array.isArray(response.outbound_result)) {
    evidence.push(summarizeStateResult('outbound_result', response.outbound_result));
  }
  for (const toolResult of Array.isArray(toolResults) ? toolResults : []) {
    const summary = summarizeToolResult(toolResult);
    if (summary) evidence.push(summary);
  }
  return evidence.filter(Boolean);
}

function hasEvidenceForIntent(intent, evidence = []) {
  if (intent === 'none') return true;
  if (intent === 'social_read') {
    return evidence.some((item) => item.type === 'tool_result' && ['success', 'partial_success'].includes(item.status));
  }
  if (intent === 'media_read') {
    return evidence.some((item) => item.type === 'artifact' || (item.type === 'tool_result' && ['success', 'partial_success'].includes(item.status)));
  }
  if (intent === 'sticker_send') {
    return evidence.some((item) => item.type === 'marker' && item.marker === 'RAN_MEDIA' && item.summary?.source === 'sticker_catalog' && item.summary?.kind === 'sticker' && item.summary?.stickerId);
  }
  if (intent === 'media_generate') {
    return evidence.some((item) => item.type === 'marker' && item.status === 'present' && ['WECHAT_MEDIA', 'RAN_MEDIA'].includes(item.marker))
      || evidence.some((item) => item.type === 'artifact');
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
  if (/已发送|已经发送|发送成功|已经发出|转发好了/.test(text)) {
    claims.push('external_sent');
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

function hasPartialMismatchClaim(claims = []) {
  return claims.includes('read_complete') || claims.includes('media_described') || claims.includes('full_failure');
}

function hasPartialSuccessEvidence(evidence = []) {
  return evidence.some((item) => item?.status === 'partial_success');
}

function hasFailedOutboundEvidence(evidence = []) {
  return evidence.some((item) => item?.type === 'outbound_result' && item?.status === 'failure');
}

function missingEvidenceForIntent(intent, evidence = []) {
  if (hasEvidenceForIntent(intent, evidence)) return [];
  return requiredEvidenceForIntent(intent);
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
      return '生成结果尚未返回，已取消完成态表述。';
    case 'memory_write':
      return '保存结果尚未返回，已取消完成态表述。';
    case 'external_send':
      return '发送结果尚未确认，已取消完成态表述。';
    case 'external_mcp_read':
      return '外部内容未成功读取，未生成内容判断。';
    case 'external_mcp_write':
      return '外部操作结果尚未确认，已取消完成态表述。';
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
  if (result.type === 'authorization') {
    return summarizeTrustedAuthorization(result);
  }
  if (result.type === 'external_mcp_tool_result' || result.external_mcp === true || result.externalMcp === true) {
    if (result[TRUSTED_ACTION_EVIDENCE] !== 'external_mcp_tool_result') return null;
    return summarizeExternalMcpToolResult(result);
  }
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
