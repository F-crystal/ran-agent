import { ensureConversationMediaContext } from './mediaContextStore.mjs';
import { handleSocialReaderMcpRequest } from './socialReaderMcpServer.mjs';
import { handleStickerCatalogMcpRequest } from './stickerCatalogMcpServer.mjs';

const REPAIRABLE_INTENTS = new Set(['social_read', 'media_read', 'sticker_send', 'media_generate']);
const HIGH_RISK_INTENTS = new Set(['memory_write', 'external_send', 'destructive_update']);

export async function repairActionContract({
  contract = {},
  message = {},
  response = {},
  finalReply = '',
  maxAttempts = 1,
  repairImpl = null,
  env = process.env,
  logger = console,
} = {}) {
  const plan = planRepairAction({ contract, message, finalReply, maxAttempts });
  if (!plan.shouldRepair) {
    return normalizeRepairResult({
      attempted: false,
      repairType: plan.repairType,
      status: plan.status,
      error_code: plan.errorCode,
    });
  }

  try {
    const raw = repairImpl
      ? await repairImpl(plan)
      : await executeDefaultRepair(plan, { message, response, finalReply, env, logger });
    return normalizeRepairResult({
      attempted: true,
      repairType: plan.repairType,
      ...raw,
    });
  } catch (error) {
    logger?.warn?.(`[hermes-action-repair] failed type=${plan.repairType} error=${sanitizeCode(error?.code || error?.message || 'REPAIR_FAILED')}`);
    return normalizeRepairResult({
      attempted: true,
      repairType: plan.repairType,
      ok: false,
      status: 'failed',
      error_code: 'REPAIR_EXCEPTION',
    });
  }
}

export function planRepairAction({ contract = {}, message = {}, finalReply = '', maxAttempts = 1 } = {}) {
  const intent = String(contract.intent || 'none');
  const repairType = intent;
  if (Number(maxAttempts) <= 0) {
    return { shouldRepair: false, repairType, status: 'max_attempts_exceeded', errorCode: 'MAX_ATTEMPTS_EXCEEDED' };
  }
  if (isScheduledOrDigestMessage(message) && intent === 'sticker_send') {
    return { shouldRepair: false, repairType, status: 'skipped', errorCode: 'SCHEDULED_DIGEST_REPAIR_SKIPPED' };
  }
  if (HIGH_RISK_INTENTS.has(intent)) {
    return { shouldRepair: false, repairType, status: 'blocked_high_risk', errorCode: 'HIGH_RISK_REPAIR_BLOCKED' };
  }
  if (!REPAIRABLE_INTENTS.has(intent)) {
    return { shouldRepair: false, repairType, status: 'skipped', errorCode: 'NO_REPAIR_FOR_INTENT' };
  }
  if (!hasActionClaim(contract)) {
    return { shouldRepair: false, repairType, status: 'skipped', errorCode: 'NO_ACTION_CLAIM' };
  }
  return {
    shouldRepair: true,
    repairType,
    intent,
    requestId: String(contract.request_id || ''),
    finalClaims: Array.isArray(contract.final_claims) ? [...contract.final_claims] : [],
    missingEvidence: Array.isArray(contract.missing_evidence) ? [...contract.missing_evidence] : [],
    messageHint: buildMessageHint(message, finalReply),
  };
}

async function executeDefaultRepair(plan, context) {
  if (plan.repairType === 'social_read') {
    return await repairSocialRead(context);
  }
  if (plan.repairType === 'media_read') {
    return await repairMediaRead(context);
  }
  if (plan.repairType === 'sticker_send') {
    return await repairStickerSend(context);
  }
  if (plan.repairType === 'media_generate') {
    return repairMediaGenerate(context);
  }
  return { ok: false, status: 'failed', error_code: 'UNSUPPORTED_REPAIR_TYPE' };
}

async function repairSocialRead({ message, env, logger }) {
  const url = extractFirstUrlLocal(message.text);
  if (!url) {
    return { ok: false, status: 'failed', error_code: 'SOCIAL_REPAIR_NO_URL' };
  }
  const result = await handleSocialReaderMcpRequest(
    {
      method: 'tools/call',
      params: {
        name: 'read_social_post_deep',
        arguments: {
          url,
          include_comments: false,
          include_media: true,
          media_detail: 'standard',
          max_media_assets: 20,
        },
      },
    },
    { env, logger }
  );
  const payload = result?.structuredContent || {};
  const coverage = summarizeSocialMediaCoverage(payload);
  const partial = payload.partial_success === true
    || payload.partialSuccess === true
    || payload.status === 'partial_success'
    || coverage.partial === true;
  const ok = result?.isError !== true && payload.ok !== false;
  if (!ok && !partial) {
    return {
      ok: false,
      status: 'failed',
      error_code: sanitizeCode(payload.error_code || payload.errorCode || 'SOCIAL_REPAIR_FAILED'),
      toolResult: {
        toolName: 'mcp_social_reader_read_social_post_deep',
        ok: false,
        error_code: payload.error_code || payload.errorCode || 'SOCIAL_REPAIR_FAILED',
      },
    };
  }
  return {
    ok: true,
    status: partial ? 'partial_success' : 'success',
    repairedReply: buildSocialRepairReply(payload, partial),
    toolResult: {
      toolName: 'mcp_social_reader_read_social_post_deep',
      ok: !partial,
      partial_success: partial,
      artifact_id: payload.artifact_id || payload.artifactId || payload.note_id || payload.id || '',
      error_code: payload.error_code || payload.errorCode || '',
      total_media_count: coverage.totalMediaCount,
      analyzed_media_count: coverage.analyzedMediaCount,
      successful_media_count: coverage.successfulMediaCount,
      partial_failures_count: coverage.partialFailuresCount,
      truncated_by_max_assets: coverage.truncatedByMaxAssets,
      warnings: coverage.warnings,
    },
  };
}

async function repairMediaRead({ message, env, logger }) {
  const result = await ensureConversationMediaContext({
    sender_id: message.sender_id,
    conversation_id: message.conversation_id || message.conversationId,
    media: message.media,
    image_urls: message.image_urls,
  }, { env, logger });
  const artifact = Array.isArray(result?.artifacts)
    ? result.artifacts.find((item) => item?.ok !== false)
    : null;
  if (!artifact) {
    return { ok: false, status: 'failed', error_code: 'MEDIA_REPAIR_NO_ARTIFACT' };
  }
  const summary = compactUserText(artifact.summary || artifact.ocr_text || artifact.transcript || '');
  return {
    ok: true,
    status: 'success',
    repairedReply: summary ? `我现在读到了媒体内容：${summary}` : '我现在读到了这个媒体内容，但可用摘要比较有限。',
    media: {
      type: artifact.type || 'file',
      artifact_id: artifact.id,
      source: 'media_reader',
      kind: 'analysis',
    },
    toolResult: {
      toolName: `media_reader.${artifact.analyzer || 'analyze'}`,
      ok: true,
      artifact_id: artifact.id,
    },
  };
}

async function repairStickerSend({ message, env }) {
  const query = inferStickerQuery(message.text);
  const pick = await handleStickerCatalogMcpRequest(
    { method: 'tools/call', params: { name: 'sticker_pick', arguments: { query, limit: 1 } } },
    { env }
  );
  const candidate = pick?.structuredContent?.candidates?.[0];
  if (!candidate?.stickerId) {
    return { ok: false, status: 'failed', error_code: pick?.structuredContent?.error_code || 'STICKER_REPAIR_NO_CANDIDATE' };
  }
  const attach = await handleStickerCatalogMcpRequest(
    { method: 'tools/call', params: { name: 'sticker_attach', arguments: { stickerId: candidate.stickerId, caption: '给你一张' } } },
    { env }
  );
  const marker = String(attach?.structuredContent?.marker || '').trim();
  if (!marker) {
    return { ok: false, status: 'failed', error_code: attach?.structuredContent?.error_code || 'STICKER_REPAIR_ATTACH_FAILED' };
  }
  return {
    ok: true,
    status: 'success',
    marker,
    repairedReply: `给你一张\n${marker}`,
    toolResult: {
      toolName: 'sticker_attach',
      ok: true,
      artifact_id: candidate.stickerId,
    },
  };
}

function repairMediaGenerate({ response }) {
  const media = findGeneratedMediaCandidate(response);
  if (!media?.type || !media?.url) {
    return { ok: false, status: 'failed', error_code: 'GENERATION_REPAIR_NO_ARTIFACT' };
  }
  const marker = `WECHAT_MEDIA: ${JSON.stringify({
    source: 'media_generation_mcp',
    kind: media.kind || media.type,
    type: media.type,
    url: media.url,
    fileName: media.fileName || media.filename || undefined,
    model: media.model || '',
  })}`;
  return {
    ok: true,
    status: 'success',
    marker,
    repairedReply: `生成结果已准备好。\n${marker}`,
    media,
    toolResult: {
      toolName: 'media_generation.attach_existing',
      ok: true,
      artifact_id: media.artifact_id || media.artifactId || media.id || media.url,
    },
  };
}

function normalizeRepairResult(result = {}) {
  const status = normalizeStatus(result.status, result.ok);
  const toolResults = [
    ...normalizeToolResults(result.toolResults),
    ...normalizeToolResults(result.toolResult ? [result.toolResult] : []),
  ];
  return {
    repairAttempted: result.attempted === true,
    repairType: sanitizeCode(result.repairType || result.type || ''),
    repairStatus: status,
    ok: status === 'success' || status === 'partial_success',
    repairedReply: String(result.repairedReply || ''),
    marker: String(result.marker || ''),
    media: result.media && typeof result.media === 'object' && !Array.isArray(result.media) ? result.media : null,
    toolResults,
    repairEvidenceAdded: summarizeRepairEvidence({ marker: result.marker, media: result.media, toolResults }),
    repairErrorCode: sanitizeCode(result.error_code || result.errorCode || result.error || ''),
  };
}

function normalizeToolResults(items) {
  return Array.isArray(items)
    ? items.filter((item) => item && typeof item === 'object' && !Array.isArray(item))
    : [];
}

function normalizeStatus(status, ok) {
  const text = String(status || '').trim().toLowerCase();
  if (['success', 'partial_success', 'failed', 'blocked_high_risk', 'max_attempts_exceeded', 'skipped'].includes(text)) {
    return text;
  }
  if (ok === true) return 'success';
  if (ok === false) return 'failed';
  return 'skipped';
}

function summarizeRepairEvidence({ marker, media, toolResults }) {
  const evidence = [];
  if (marker) evidence.push('marker');
  if (media && typeof media === 'object') evidence.push('artifact');
  if (Array.isArray(toolResults) && toolResults.length > 0) evidence.push('tool_result');
  return [...new Set(evidence)];
}

function hasActionClaim(contract = {}) {
  return Array.isArray(contract.final_claims) && contract.final_claims.length > 0;
}

function isScheduledOrDigestMessage(message = {}) {
  const hint = `${message.route_hint || ''} ${message.source || ''} ${message.kind || ''}`.toLowerCase();
  return message.is_scheduled === true || /scheduled|digest|nightly/.test(hint);
}

function buildMessageHint(message = {}, finalReply = '') {
  const text = `${message.text || ''} ${finalReply || ''}`;
  if (/表情包|贴纸|sticker/i.test(text)) return 'sticker';
  if (/小红书|xhs|xiaohongshu/i.test(text)) return 'xhs';
  if (/bilibili|b站/i.test(text)) return 'bilibili';
  if (/图片|图|截图/i.test(text)) return 'image';
  if (/视频/i.test(text)) return 'video';
  if (/音频|语音/i.test(text)) return 'audio';
  return '';
}

function extractFirstUrlLocal(text = '') {
  const match = String(text || '').match(/https?:\/\/[^\s"'<>【】「」《》，。！？、；：]+/i);
  return match ? match[0] : '';
}

function inferStickerQuery(text = '') {
  if (/安慰|摸摸|难过|委屈|累/.test(text)) return '安慰';
  if (/喜欢|可爱|爱/.test(text)) return '喜欢';
  if (/鼓励|加油|冲/.test(text)) return '鼓励';
  if (/开心|哈哈|笑/.test(text)) return '开心';
  return '开心';
}

function buildSocialRepairReply(payload = {}, partial = false) {
  if (partial) {
    return '我读到了一部分内容，但有些媒体或细节没有成功获取。';
  }
  const summary = compactUserText(
    payload.summary
    || payload.abstract
    || payload.desc
    || payload.description
    || payload.title
    || payload.post_text
    || payload.note_text
    || payload.text
    || ''
  );
  return summary ? `我现在读取到了这个链接内容：${summary}` : '我现在读取到了这个链接内容，可以基于读取结果继续整理。';
}

function summarizeSocialMediaCoverage(payload = {}) {
  const mediaAnalysis = payload.media_analysis && typeof payload.media_analysis === 'object' && !Array.isArray(payload.media_analysis)
    ? payload.media_analysis
    : {};
  const totalMediaCount = normalizeOptionalNonNegativeInt(
    firstDefined(payload.total_media_count, payload.totalMediaCount, payload.media_count, payload.mediaCount)
  );
  const analyzedMediaCount = normalizeOptionalNonNegativeInt(
    firstDefined(
      payload.analyzed_media_count,
      payload.analyzedMediaCount,
      payload.successful_media_count,
      payload.successfulMediaCount
    )
  );
  const successfulMediaCount = normalizeOptionalNonNegativeInt(
    firstDefined(
      payload.successful_media_count,
      payload.successfulMediaCount,
      Array.isArray(mediaAnalysis.items) ? mediaAnalysis.items.length : undefined,
      payload.analyzed_media_count,
      payload.analyzedMediaCount
    )
  );
  const partialFailuresCount = normalizeOptionalNonNegativeInt(
    firstDefined(
      payload.partial_failures_count,
      payload.partialFailuresCount,
      Array.isArray(mediaAnalysis.partial_failures) ? mediaAnalysis.partial_failures.length : undefined
    )
  ) || 0;
  const warnings = [
    ...normalizeWarningCodes(payload.warnings),
    ...normalizeWarningCodes(mediaAnalysis.warnings),
  ];
  const truncatedByMaxAssets = payload.truncated_by_max_assets === true || payload.truncatedByMaxAssets === true;
  const effectiveMediaCount = successfulMediaCount ?? analyzedMediaCount;
  return {
    totalMediaCount,
    analyzedMediaCount,
    successfulMediaCount,
    partialFailuresCount,
    truncatedByMaxAssets,
    warnings,
    partial: mediaAnalysis.partial === true
      || truncatedByMaxAssets
      || partialFailuresCount > 0
      || (totalMediaCount !== null && effectiveMediaCount !== null && totalMediaCount > effectiveMediaCount)
      || (analyzedMediaCount !== null && successfulMediaCount !== null && analyzedMediaCount > successfulMediaCount)
      || warnings.some((item) => /TIMEOUT|TRUNCATED|PARTIAL/i.test(item)),
  };
}

function findGeneratedMediaCandidate(response = {}) {
  const candidates = [
    response.generated_media,
    response.generation_result?.media,
    response.media_generation_result?.media,
    response.artifact?.media,
  ];
  return candidates.find((item) => item && typeof item === 'object' && !Array.isArray(item) && item.url && item.type) || null;
}

function compactUserText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220);
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
      if (typeof item === 'string') return sanitizeCode(item);
      if (item && typeof item === 'object') return sanitizeCode(item.code || item.error_code || item.errorCode);
      return '';
    }).filter(Boolean).slice(0, 8)
    : [];
}

function sanitizeCode(value) {
  return String(value || '').trim().replace(/[^A-Z0-9_.:-]/gi, '_').slice(0, 80);
}
