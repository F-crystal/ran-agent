/**
 * Reply backend selector for Hermes chat mainline.
 */

import { getBackendIngestConfig, ingestExchangeToBackend } from './backendIngestClient.mjs';
import { stopExternalMcpActivitiesByUser } from './externalMcp/activityRunner.mjs';
import { shouldSuppressSystemQueueReply } from './externalMcp/systemQueue.mjs';
import {
  applyActionGateTelemetry,
  evaluateActionContract,
  evaluateActionGate,
  getActionGateConfig,
  logActionContract,
} from './actionContract.mjs';
import { repairActionContract } from './actionRepair.mjs';
import { getHermesGatewayConfig, sendChatToHermesGateway } from './hermesGatewayClient.mjs';
import { detectEnvironmentPrivacyCommand, privacyConfirmation } from './environmentSense.mjs';
import {
  cancelPendingAction,
  confirmPendingAction,
  createPendingAction,
  findPendingActionsForConversation,
  getPendingActionConfig,
  markPendingActionExecuted,
  markPendingActionFailed,
} from './pendingActionState.mjs';
import { extractLegacyWechatMediaMarker, extractRanMediaMarker } from './replyMediaMarkers.mjs';
import {
  deleteStickers,
  resolveStickerAsset,
  saveStickersFromInbox,
  updateStickers,
} from './stickerCatalog.mjs';

const pendingActionRuntimePayloads = new Map();

export function getReplyBackendConfig(env = process.env) {
  return {
    replyBackend: 'hermes',
    fallbackText: env.NODE_BRIDGE_FALLBACK_TEXT || '暂时无法连接到 personal agent，请稍后再试。',
  };
}

export function createReplyBackend(options = {}) {
  const env = options.env || process.env;
  const config = getReplyBackendConfig(env);

  return {
    async getReply(message, backendOptions = {}) {
      const gatewayConfig = backendOptions.hermesConfig || getHermesGatewayConfig(env);
      const chatImpl = options.hermesImpl || options.chatImpl || sendChatToHermesGateway;
      const requestId = sanitizeRequestId(backendOptions.requestId || message.request_id || createRequestId());
      const environmentPrivacyCommand = detectEnvironmentPrivacyCommand(message.text);
      if (environmentPrivacyCommand) {
        return {
          replyText: privacyConfirmation(environmentPrivacyCommand, { env }),
          followUpMessages: [],
          media: null,
          source: 'hermes',
        };
      }
      if (detectExternalMcpStopCommand(message.text)) {
        const stopped = stopExternalMcpActivitiesByUser(message.global_user_id || '', {
          env,
          now: typeof options.nowImpl === 'function' ? options.nowImpl() : new Date(),
          reason: 'user_stop_command',
        });
        message = {
          ...message,
          route_hint: 'external_mcp_stop',
          text: buildExternalMcpStopPrompt({
            originalText: message.text,
            stoppedActivityIds: stopped.stoppedActivityIds,
          }),
        };
      }
      const actionGateConfig = getActionGateConfig(env);
      const pendingConfig = getPendingActionConfig(env);
      const pendingOutcome = pendingConfig.enabled
        ? await handlePendingActionBeforeHermes({
          message,
          requestId,
          gatewayConfig,
          actionGateConfig,
          pendingConfig,
          options,
          env,
        })
        : null;
      if (pendingOutcome) {
        return {
          replyText: pendingOutcome.replyText,
          followUpMessages: [],
          media: pendingOutcome.media || null,
          source: 'hermes',
        };
      }
      const response = await chatImpl(
        {
          text: message.text,
          sender_id: message.sender_id,
          conversation_id: message.conversation_id || message.conversationId || message.sender_id,
          channel: message.platform || message.channel || 'wechat',
          platform: message.platform || message.channel || 'wechat',
          channel_type: message.channel_type || '',
          global_user_id: message.global_user_id || '',
          stable_conversation_key: message.stable_conversation_key || '',
          hermes_session_id: message.hermes_session_id || '',
          hermes_session_key: message.hermes_session_key || '',
          recent_local_history: Array.isArray(message.recent_local_history) ? message.recent_local_history : [],
          recent_global_history: Array.isArray(message.recent_global_history) ? message.recent_global_history : [],
          active_topic: message.active_topic || '',
          stale_context: message.stale_context || '',
          continuity_note: message.continuity_note || '',
          route_hint: message.route_hint || '',
          message_batch: Array.isArray(message.message_batch) ? message.message_batch : [],
          prior_messages: Array.isArray(message.prior_messages) ? message.prior_messages : [],
          image_urls: Array.isArray(message.image_urls) ? message.image_urls : [],
          media: normalizeMediaItems(message.media),
        },
        {
          config: gatewayConfig,
          fetchImpl: backendOptions.fetchImpl,
          execFileImpl: backendOptions.execFileImpl,
          env,
          logger: options.logger || console,
          mediaContextOptions: backendOptions.mediaContextOptions,
          requestId,
        }
      );

      const ingestConfig = backendOptions.ingestConfig || getBackendIngestConfig(env);
      const ingest = options.ingestImpl || ingestExchangeToBackend;
      const ingestPayload = {
        channel: message.platform || message.channel || 'wechat',
        sender_id: message.sender_id,
        conversation_id: message.conversation_id || message.conversationId || message.sender_id,
        global_user_id: message.global_user_id || '',
        user_text: message.text,
        reply_text: response.reply_text,
        source: 'hermes',
        image_urls: Array.isArray(message.image_urls)
          ? message.image_urls.filter((item) => typeof item === 'string' && item.trim())
          : [],
        media: normalizeMediaItems(message.media),
      };
      // Debug log for multimedia sync
      const logger = options.logger || console;
      logger.log?.(`[ingest] sender_id_hash=${hashForLog(ingestPayload.sender_id)} text_length=${ingestPayload.user_text?.length || 0} image_urls_count=${ingestPayload.image_urls?.length || 0} media_count=${ingestPayload.media?.length || 0}`);
      if (ingestPayload.media?.length > 0) {
        logger.log?.(`[ingest] media items: ${JSON.stringify(ingestPayload.media.map(m => ({ type: m.type, mimeType: m.mimeType })))}`);
      }
      try {
        await ingest(ingestPayload, {
          config: ingestConfig,
          fetchImpl: backendOptions.fetchImpl,
        });
        logger.log?.(`[ingest] success`);
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error);
        logger.warn?.(`backend ingest skipped: ${messageText}`);
      }

      const mediaFromMarker = extractTrustedMediaMarker(response.reply_text, {
        resolveStickerAssetImpl: options.resolveStickerAssetImpl || resolveStickerAsset,
        env,
        logger: options.logger || console,
      });
      const responseMedia = response.media && typeof response.media === 'object'
        ? response.media
        : mediaFromMarker?.media || null;
      let responseText = mediaFromMarker
        ? mediaFromMarker.text
        : response.reply_text;

      let finalReplyText = responseText;
      let finalResponseMedia = responseMedia;
      if (actionGateConfig.enabled) {
        let rawContractReplyText = response.reply_text;
        let contract = evaluateActionContract({
          requestId,
          channel: message.platform || message.channel || 'wechat',
          conversationId: message.conversation_id || message.conversationId || message.sender_id,
          profile: gatewayConfig.profile || response.profile || response.model || '',
          message,
          response: { ...response, media: finalResponseMedia, reply_text: rawContractReplyText },
          config: actionGateConfig,
        });
        let gate = evaluateActionGate({
          contract,
          finalReply: responseText,
          mode: actionGateConfig.mode,
        });
        let repair = { repairAttempted: false, repairStatus: 'skipped' };
        if (actionGateConfig.mode === 'repair' && gate.shouldRewrite) {
          repair = await repairActionContract({
            contract,
            message,
            response: { ...response, media: finalResponseMedia },
            finalReply: responseText,
            maxAttempts: actionGateConfig.maxRepairAttempts,
            repairImpl: options.actionRepairImpl,
            env,
            logger: options.logger || console,
          });
          if (repair.ok) {
            rawContractReplyText = buildRepairedContractReply(rawContractReplyText, repair);
            const repairedMediaMarker = extractTrustedMediaMarker(rawContractReplyText, {
              resolveStickerAssetImpl: options.resolveStickerAssetImpl || resolveStickerAsset,
              env,
              logger: options.logger || console,
            });
            const contractRepairMedia = repair.media || repairedMediaMarker?.media || finalResponseMedia;
            finalResponseMedia = repairedMediaMarker?.media || (isOutboundRepairMedia(repair.media) ? repair.media : null) || finalResponseMedia;
            responseText = repairedMediaMarker ? repairedMediaMarker.text : (repair.repairedReply || responseText);
            contract = evaluateActionContract({
              requestId,
              channel: message.platform || message.channel || 'wechat',
              conversationId: message.conversation_id || message.conversationId || message.sender_id,
              profile: gatewayConfig.profile || response.profile || response.model || '',
              message,
              response: { ...response, media: contractRepairMedia, reply_text: rawContractReplyText },
              toolResults: repair.toolResults,
              config: actionGateConfig,
            });
            gate = evaluateActionGate({
              contract,
              finalReply: responseText,
              mode: 'enforce',
            });
            gate = {
              ...gate,
              finalAction: gate.shouldRewrite ? 'repair_failed_safe_rewrite' : 'repair_success',
            };
          } else {
            gate = {
              ...gate,
              finalAction: repair.repairStatus === 'blocked_high_risk'
                ? 'repair_skipped_high_risk'
                : repair.repairStatus === 'max_attempts_exceeded'
                  ? 'safe_rewrite'
                  : 'repair_failed_safe_rewrite',
            };
          }
        }
        if (gate.shouldRewrite) {
          finalReplyText = gate.rewrittenText;
        } else {
          finalReplyText = responseText;
        }
        logActionContract(applyActionGateTelemetry(contract, gate, repair), options.logger || console);
      }

      const suppression = shouldSuppressSystemQueueReply({
        routeHint: message.route_hint || '',
        replyText: finalReplyText,
      });

      return {
        replyText: suppression.suppress ? '' : finalReplyText,
        followUpMessages: Array.isArray(response.follow_up_messages) ? response.follow_up_messages : [],
        media: suppression.suppress ? null : finalResponseMedia,
        source: 'hermes',
        suppressSend: suppression.suppress,
        suppressReason: suppression.reason,
      };
    },
    config,
  };
}

async function handlePendingActionBeforeHermes({
  message,
  requestId,
  gatewayConfig,
  actionGateConfig,
  pendingConfig,
  options,
  env,
}) {
  const mode = actionGateConfig.mode;
  const channel = message.platform || message.channel || 'wechat';
  const conversationId = message.conversation_id || message.conversationId || message.sender_id;
  const logger = options.logger || console;
  const now = typeof options.nowImpl === 'function' ? options.nowImpl() : new Date();
  const confirmation = detectConfirmationCommand(message.text);
  const pendingActions = findPendingActionsForConversation({ channel, conversationId }, { env, now });

  if (confirmation && pendingActions.length === 0) {
    return { replyText: '这个确认项已经过期或已经处理了，我不会执行它。' };
  }
  if (confirmation && pendingActions.length > 1) {
    return { replyText: '这里有多个待确认操作，请说清楚要确认哪一个。' };
  }
  if (confirmation && pendingActions.length === 1) {
    if (mode !== 'repair') {
      logPendingActionTelemetry({
        requestId,
        channel,
        conversationId,
        profile: gatewayConfig.profile,
        action: pendingActions[0],
        pendingStatus: pendingActions[0].status,
        confirmationDetected: true,
        confirmationResult: confirmation,
        finalAction: 'blocked_high_risk',
      }, logger);
      return { replyText: '当前确认执行没有启用，所以我不会执行这个操作。' };
    }
    return await handlePendingConfirmation({
      confirmation,
      action: pendingActions[0],
      message,
      requestId,
      gatewayConfig,
      channel,
      conversationId,
      options,
      env,
      now,
      logger,
    });
  }

  if (mode !== 'repair' || isScheduledOrDigestMessage(message)) {
    return null;
  }
  const candidate = detectPendingActionCandidate(message);
  if (!candidate) {
    return null;
  }
  const actionInput = buildPendingActionInput({
    candidate,
    message,
    requestId,
    channel,
    conversationId,
    profile: gatewayConfig.profile,
  });
  if (candidate.authorization === 'explicit') {
    const action = {
      ...actionInput,
      actionId: `act_direct_${requestId}`.replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 80),
      status: 'confirmed',
    };
    rememberRuntimePendingPayload(action.actionId, candidate.sanitizedPayload);
    const execution = await executePendingAction(action, { options, env, message });
    logPendingActionTelemetry({
      requestId,
      channel,
      conversationId,
      profile: gatewayConfig.profile,
      action,
      pendingStatus: execution.ok ? 'executed' : 'failed',
      confirmationDetected: false,
      confirmationResult: 'explicit_authorization',
      executionStatus: execution.ok ? 'success' : 'failed',
      executionEvidenceAdded: execution.evidence,
      finalAction: execution.ok ? 'executed_with_evidence' : 'execution_failed_safe_rewrite',
    }, logger);
    return {
      replyText: execution.replyText || (execution.ok ? '已完成。' : '执行没有成功，所以我不能说已经完成了。'),
      media: execution.media || null,
    };
  }

  const pending = createPendingAction(actionInput, { env, now, ttlMinutes: pendingConfig.ttlMinutes });
  rememberRuntimePendingPayload(pending.actionId, candidate.sanitizedPayload);
  logPendingActionTelemetry({
    requestId,
    channel,
    conversationId,
    profile: gatewayConfig.profile,
    action: pending,
    pendingStatus: 'pending',
    confirmationDetected: false,
    confirmationResult: '',
    finalAction: 'pending_confirmation',
  }, logger);
  return { replyText: confirmationPromptForAction(pending) };
}

async function handlePendingConfirmation({
  confirmation,
  action,
  message,
  requestId,
  gatewayConfig,
  channel,
  conversationId,
  options,
  env,
  now,
  logger,
}) {
  if (confirmation === 'cancel') {
    const cancelled = cancelPendingAction(action.actionId, { env, now });
    logPendingActionTelemetry({
      requestId,
      channel,
      conversationId,
      profile: gatewayConfig.profile,
      action,
      pendingStatus: cancelled?.status || 'cancelled',
      confirmationDetected: true,
      confirmationResult: 'cancelled',
      finalAction: 'confirmation_cancelled',
    }, logger);
    return { replyText: '已取消，我不会执行这个操作。' };
  }

  const confirmed = confirmPendingAction(action.actionId, { env, now });
  const execution = await executePendingAction(confirmed || action, { options, env, message });
  if (execution.ok) {
    markPendingActionExecuted(action.actionId, execution.evidence, { env, now });
    logPendingActionTelemetry({
      requestId,
      channel,
      conversationId,
      profile: gatewayConfig.profile,
      action,
      pendingStatus: 'executed',
      confirmationDetected: true,
      confirmationResult: 'confirmed',
      executionStatus: 'success',
      executionEvidenceAdded: execution.evidence,
      finalAction: 'confirmed_executed',
    }, logger);
    return { replyText: execution.replyText || '已确认并执行。', media: execution.media || null };
  }
  markPendingActionFailed(action.actionId, execution.evidence, { env, now });
  logPendingActionTelemetry({
    requestId,
    channel,
    conversationId,
    profile: gatewayConfig.profile,
    action,
    pendingStatus: 'failed',
    confirmationDetected: true,
    confirmationResult: 'confirmed',
    executionStatus: 'failed',
    executionEvidenceAdded: execution.evidence,
    finalAction: 'execution_failed_safe_rewrite',
  }, logger);
  return { replyText: execution.replyText || '执行没有成功，所以我不能说已经完成了。' };
}

function detectPendingActionCandidate(message = {}) {
  const text = String(message.text || '');
  const hasMedia = normalizeMediaItems(message.media).length > 0 || (Array.isArray(message.image_urls) && message.image_urls.length > 0);
  if (hasMedia && /(?:保存|加入|添加).*(?:表情包|贴纸)|(?:表情包|贴纸).*(?:保存|加入|添加)/.test(text)) {
    return {
      actionType: 'sticker_save',
      authorization: 'explicit',
      summary: '保存表情包',
      sanitizedPayload: { tags: extractTags(text), media: normalizeMediaItems(message.media) },
    };
  }
  if (hasMedia && /(?:可以|适合|能不能|要不要).*(?:表情包|贴纸)|(?:表情包|贴纸).*(?:不错|可以|好笑)/.test(text)) {
    return {
      actionType: 'sticker_save',
      authorization: 'pending',
      summary: '保存表情包',
      sanitizedPayload: { tags: extractTags(text), media: normalizeMediaItems(message.media) },
    };
  }
  if (/(?:删除|删掉|移除).*(?:表情包|贴纸)|(?:表情包|贴纸).*(?:删除|删掉|移除)/.test(text)) {
    return {
      actionType: 'sticker_delete',
      authorization: extractStickerId(text) ? 'explicit' : 'pending',
      summary: '删除表情包',
      sanitizedPayload: { stickerId: extractStickerId(text), actionTarget: 'sticker_delete' },
    };
  }
  if (/(?:更新|修改).*(?:表情包|贴纸)|(?:表情包|贴纸).*(?:更新|修改)/.test(text)) {
    return {
      actionType: 'sticker_update',
      authorization: extractStickerId(text) ? 'explicit' : 'pending',
      summary: '更新表情包',
      sanitizedPayload: { stickerId: extractStickerId(text), tags: extractTags(text), actionTarget: 'sticker_update' },
    };
  }
  if (/记住这个|以后记得|保存.*(?:记忆|偏好)|长期记忆/.test(text)) {
    return {
      actionType: 'memory_write',
      authorization: 'explicit',
      summary: '保存记忆',
      sanitizedPayload: { actionTarget: 'memory' },
    };
  }
  if (/(?:发给|发送给|现在发送|直接转发|发吧)/.test(text)) {
    return {
      actionType: 'external_send',
      authorization: /现在发送|直接转发|发吧/.test(text) ? 'explicit' : 'pending',
      summary: '外发消息',
      sanitizedPayload: { actionTarget: 'external_send' },
    };
  }
  return null;
}

function buildPendingActionInput({ candidate, requestId, channel, conversationId, profile }) {
  return {
    requestId,
    channel,
    conversationId,
    profile,
    actionType: candidate.actionType,
    summary: candidate.summary,
    status: 'pending',
    requiredConfirmation: candidate.authorization !== 'explicit',
    sanitizedPayload: sanitizePendingPayloadForExecutor(candidate.sanitizedPayload || {}),
  };
}

function sanitizePendingPayloadForExecutor(payload = {}) {
  const sanitized = {};
  if (Array.isArray(payload.tags)) {
    sanitized.tags = payload.tags.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 8);
  }
  if (payload.actionTarget) {
    sanitized.actionTarget = String(payload.actionTarget || '').trim().slice(0, 120);
  }
  if (payload.stickerId) {
    sanitized.stickerId = String(payload.stickerId || '').trim().slice(0, 80);
  }
  const mediaItems = Array.isArray(payload.media) ? payload.media : payload.media ? [payload.media] : [];
  const mediaRefs = mediaItems
    .map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
      const ref = item.ref || item.mediaRef || item.assetId || item.id || item.filePath || item.local_path || item.localPath || '';
      const refHash = ref ? hashForLog(ref) : '';
      if (!refHash) return null;
      return {
        refHash,
        type: String(item.type || item.mimeType || item.mime_type || '').trim().slice(0, 120),
      };
    })
    .filter(Boolean)
    .slice(0, 5);
  if (mediaRefs.length > 0) {
    sanitized.mediaRefs = mediaRefs;
  }
  return sanitized;
}

async function executePendingAction(action, { options, env, message }) {
  try {
    const executor = typeof options.pendingActionExecutorImpl === 'function'
      ? options.pendingActionExecutorImpl
      : executeConfirmedAction;
    const result = await executor(action, {
      env,
      message,
      runtimePayload: takeRuntimePendingPayload(action.actionId),
    });
    const ok = result?.ok !== false && result?.status !== 'failed';
    return {
      ok,
      replyText: String(result?.replyText || ''),
      media: result?.media || null,
      evidence: sanitizeExecutionEvidence(result?.evidence || [{
        type: resultEvidenceType(action.actionType),
        status: ok ? 'success' : 'failure',
        result_id_hash: result?.result_id_hash || '',
        error_code: result?.error_code || '',
      }]),
    };
  } catch {
    return {
      ok: false,
      replyText: '执行没有成功，所以我不能说已经完成了。',
      evidence: [{ type: resultEvidenceType(action.actionType), status: 'failure', error_code: 'PENDING_EXECUTION_EXCEPTION' }],
    };
  }
}

async function executeConfirmedAction(action, { env, message, runtimePayload } = {}) {
  if (action.actionType === 'sticker_save') {
    const media = resolveActionMedia(runtimePayload, message);
    if (media.length === 0) {
      return {
        ok: false,
        replyText: '我没有拿到可安全保存的原始图片，所以没有保存。',
        evidence: [{ type: 'save_result', status: 'failure', error_code: 'STICKER_SAVE_MEDIA_UNAVAILABLE' }],
      };
    }
    const items = media.map((item) => ({
      filePath: item.filePath,
      tags: Array.isArray(action.sanitizedPayload?.tags) ? action.sanitizedPayload.tags : [],
      source: normalizeActionSource(item.source || message?.platform || message?.channel || ''),
    }));
    const result = await saveStickersFromInbox({ items }, { env });
    const saved = Array.isArray(result.saved) ? result.saved : [];
    const duplicates = Array.isArray(result.duplicates) ? result.duplicates : [];
    const first = saved[0] || duplicates[0] || null;
    return {
      ok: saved.length > 0 || duplicates.length > 0,
      replyText: saved.length > 0 ? '已保存到表情包库。' : '这张已经在表情包库里了。',
      evidence: [{
        type: 'save_result',
        status: saved.length > 0 || duplicates.length > 0 ? 'success' : 'failure',
        result_id_hash: first?.stickerId ? hashForLog(first.stickerId) : '',
        error_code: '',
      }],
    };
  }
  if (action.actionType === 'sticker_delete') {
    const stickerId = String(action.sanitizedPayload?.stickerId || '').trim();
    if (!stickerId) {
      return {
        ok: false,
        replyText: '我没有明确拿到要删除的表情包编号，所以没有删除。',
        evidence: [{ type: 'delete_result', status: 'failure', error_code: 'STICKER_DELETE_TARGET_MISSING' }],
      };
    }
    const result = deleteStickers({ items: [{ stickerId }], hardDelete: false }, { env });
    const deleted = Array.isArray(result.deleted) ? result.deleted : [];
    return {
      ok: deleted.length > 0,
      replyText: deleted.length > 0 ? '已删除这个表情包。' : '没有找到可删除的这个表情包。',
      evidence: [{
        type: 'delete_result',
        status: deleted.length > 0 ? 'success' : 'failure',
        result_id_hash: deleted[0] ? hashForLog(deleted[0]) : '',
        error_code: deleted.length > 0 ? '' : 'STICKER_NOT_FOUND',
      }],
    };
  }
  if (action.actionType === 'sticker_update') {
    const stickerId = String(action.sanitizedPayload?.stickerId || '').trim();
    if (!stickerId) {
      return {
        ok: false,
        replyText: '我没有明确拿到要更新的表情包编号，所以没有更新。',
        evidence: [{ type: 'save_result', status: 'failure', error_code: 'STICKER_UPDATE_TARGET_MISSING' }],
      };
    }
    const result = updateStickers({
      items: [{
        stickerId,
        tags: Array.isArray(action.sanitizedPayload?.tags) ? action.sanitizedPayload.tags : undefined,
      }],
    }, { env });
    const updated = Array.isArray(result.updated) ? result.updated : [];
    return {
      ok: updated.length > 0,
      replyText: updated.length > 0 ? '已更新这个表情包。' : '没有找到可更新的这个表情包。',
      evidence: [{
        type: 'save_result',
        status: updated.length > 0 ? 'success' : 'failure',
        result_id_hash: updated[0]?.stickerId ? hashForLog(updated[0].stickerId) : '',
        error_code: updated.length > 0 ? '' : 'STICKER_NOT_FOUND',
      }],
    };
  }
  return {
    ok: false,
    replyText: '这个操作需要更明确的安全执行接口；我没有执行，也不会假装已经完成。',
    evidence: [{ type: resultEvidenceType(action.actionType), status: 'failure', error_code: 'PENDING_EXECUTOR_UNAVAILABLE' }],
  };
}

function rememberRuntimePendingPayload(actionId, payload = {}) {
  const id = String(actionId || '').trim();
  if (!id) return;
  const media = normalizeMediaItems(payload.media);
  if (media.length === 0) return;
  pendingActionRuntimePayloads.set(id, { media });
  if (pendingActionRuntimePayloads.size > 200) {
    const firstKey = pendingActionRuntimePayloads.keys().next().value;
    pendingActionRuntimePayloads.delete(firstKey);
  }
}

function takeRuntimePendingPayload(actionId) {
  const id = String(actionId || '').trim();
  if (!id) return null;
  const payload = pendingActionRuntimePayloads.get(id) || null;
  pendingActionRuntimePayloads.delete(id);
  return payload;
}

function resolveActionMedia(runtimePayload, message = {}) {
  const fromRuntime = normalizeMediaItems(runtimePayload?.media);
  if (fromRuntime.length > 0) return fromRuntime;
  return normalizeMediaItems(message.media);
}

function normalizeActionSource(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'wechat' || normalized === 'feishu') return normalized;
  return 'manual';
}

function sanitizeExecutionEvidence(evidence = []) {
  return (Array.isArray(evidence) ? evidence : [])
    .map((item) => ({
      type: String(item?.type || ''),
      status: String(item?.status || ''),
      result_id_hash: String(item?.result_id_hash || item?.resultIdHash || '').slice(0, 80),
      error_code: String(item?.error_code || item?.errorCode || '').slice(0, 80),
    }))
    .filter((item) => item.type || item.status);
}

function resultEvidenceType(actionType) {
  if (actionType === 'sticker_delete') return 'delete_result';
  return actionType === 'external_send' ? 'outbound_result' : 'save_result';
}

function confirmationPromptForAction(action = {}) {
  if (action.actionType === 'sticker_save') {
    return '要不要我把这张图保存到表情包库？你回“确认保存”就行。';
  }
  if (action.actionType === 'external_send') {
    return '要我现在发送这条内容吗？你回“确认发送”就行。';
  }
  if (action.actionType === 'sticker_delete') {
    return '要删除这个表情包吗？你回“确认删除”就行。';
  }
  if (action.actionType === 'sticker_update') {
    return '要更新这个表情包吗？你回“确认”就行。';
  }
  return '这个操作需要确认。你回“确认”我再执行。';
}

function detectConfirmationCommand(text = '') {
  const normalized = String(text || '').trim();
  if (/^(取消|算了|不用了|别保存|别发|不删了)$/i.test(normalized)) return 'cancel';
  if (/^(确认|是的|可以|保存|确认保存|发吧|删除吧|确认删除|就这样|确认发送)$/i.test(normalized)) return 'confirm';
  return '';
}

function detectExternalMcpStopCommand(text = '') {
  const normalized = String(text || '').trim();
  return /^(停下这局|别玩了|结束\s*MCP\s*活动|停止\s*MCP|结束游戏|停下游戏|不要继续玩|stop\s+mcp|stop\s+this\s+game)$/i.test(normalized);
}

function buildExternalMcpStopPrompt({ originalText = '', stoppedActivityIds = [] } = {}) {
  return [
    '[External MCP stop event]',
    `user_text: ${String(originalText || '').trim().slice(0, 120)}`,
    `stopped_activity_ids: ${(Array.isArray(stoppedActivityIds) ? stoppedActivityIds : []).join(',') || 'none'}`,
    'Hermes must not continue playing or browsing external MCP now. Briefly acknowledge the stop and summarize what changed if the activity context is available.',
  ].join('\n');
}

function isScheduledOrDigestMessage(message = {}) {
  const hint = `${message.route_hint || ''} ${message.source || ''} ${message.kind || ''}`.toLowerCase();
  return message.is_scheduled === true || /scheduled|digest|nightly/.test(hint);
}

function extractTags(text = '') {
  const match = String(text || '').match(/标签[:：]\s*([^，。；;\n]+)/);
  if (!match) return [];
  return match[1].split(/[、,\s]+/).map((item) => item.trim()).filter(Boolean).slice(0, 8);
}

function extractStickerId(text = '') {
  const match = String(text || '').match(/\bstk_?\d+\b/i);
  return match ? match[0].replace(/^stk(\d+)$/i, 'stk_$1') : '';
}

function logPendingActionTelemetry({
  requestId,
  channel,
  conversationId,
  profile,
  action,
  pendingStatus = '',
  confirmationDetected = false,
  confirmationResult = '',
  executionStatus = '',
  executionEvidenceAdded = [],
  finalAction = '',
}, logger = console) {
  logActionContract({
    request_id: sanitizeRequestId(requestId),
    channel: String(channel || '').trim(),
    conversation_id_hash: hashForLog(conversationId),
    profile: String(profile || '').trim(),
    gate_mode: 'repair',
    intent: action?.actionType === 'external_send' ? 'external_send' : 'memory_write',
    required_evidence: [],
    observed_evidence: [],
    final_claims: [],
    original_claim_types: [],
    gate_decision: finalAction === 'pending_confirmation' ? 'pending' : 'pass',
    rewrite_reason: '',
    evidence_satisfied: executionStatus === 'success',
    missing_evidence: [],
    partial_success_detected: false,
    repair_attempted: false,
    repair_type: '',
    repair_status: '',
    repair_evidence_added: [],
    repair_error_code: '',
    pending_action_id: String(action?.actionId || ''),
    pending_action_type: String(action?.actionType || ''),
    pending_action_status: String(pendingStatus || action?.status || ''),
    confirmation_detected: Boolean(confirmationDetected),
    confirmation_result: String(confirmationResult || ''),
    execution_status: String(executionStatus || ''),
    execution_evidence_added: sanitizeExecutionEvidence(executionEvidenceAdded).map((item) => item.type).filter(Boolean),
    final_action: finalAction,
  }, logger);
}

function extractTrustedMediaMarker(text, options = {}) {
  const ranMedia = extractRanMediaMarker(text);
  if (ranMedia) {
    if (!ranMedia.mediaIntent) {
      if (ranMedia.errorCode) {
        options.logger?.warn?.(`RAN_MEDIA marker rejected: ${ranMedia.errorCode} ${formatRanMediaMarkerMeta(ranMedia.markerMeta)}`);
      }
      return { text: ranMedia.text, media: null };
    }
    try {
      const asset = options.resolveStickerAssetImpl(ranMedia.mediaIntent.stickerId, { env: options.env });
      return {
        text: ranMedia.text,
        media: {
          source: 'sticker_catalog',
          kind: 'sticker',
          stickerId: ranMedia.mediaIntent.stickerId,
          mime: asset.mime,
          fileName: asset.fileName,
          filePath: asset.filePath,
          caption: ranMedia.mediaIntent.caption,
        },
      };
    } catch {
      options.logger?.warn?.('RAN_MEDIA sticker resolve failed');
      return { text: ranMedia.text, media: null };
    }
  }

  return extractLegacyWechatMediaMarker(text);
}

function buildRepairedContractReply(originalReply, repair = {}) {
  const repaired = String(repair.repairedReply || '').trim();
  const marker = String(repair.marker || '').trim();
  if (repaired && marker && !repaired.includes(marker)) {
    return `${repaired}\n${marker}`;
  }
  if (repaired) {
    return repaired;
  }
  if (marker && !String(originalReply || '').includes(marker)) {
    return `${String(originalReply || '').trim()}\n${marker}`.trim();
  }
  return String(originalReply || '');
}

function isOutboundRepairMedia(media) {
  if (!media || typeof media !== 'object' || Array.isArray(media)) {
    return false;
  }
  if (media.source === 'sticker_catalog' && media.kind === 'sticker') {
    return true;
  }
  return typeof media.url === 'string' && media.url.trim() && ['image', 'audio', 'video', 'file'].includes(String(media.type || '').trim().toLowerCase());
}

function formatRanMediaMarkerMeta(markerMeta) {
  if (!markerMeta || typeof markerMeta !== 'object' || Array.isArray(markerMeta)) {
    return '{}';
  }
  return JSON.stringify({
    source: String(markerMeta.source || ''),
    kind: String(markerMeta.kind || ''),
    hasStickerId: Boolean(markerMeta.hasStickerId),
    hasCaption: Boolean(markerMeta.hasCaption),
    keys: Array.isArray(markerMeta.keys) ? markerMeta.keys.map((key) => String(key).slice(0, 40)) : [],
  });
}

function normalizeMediaItems(media) {
  if (!media) {
    return [];
  }
  const items = Array.isArray(media) ? media : [media];
  return items
    .map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return null;
      }
      const filePath = typeof item.filePath === 'string' ? item.filePath.trim() : (typeof item.local_path === 'string' ? item.local_path.trim() : '');
      if (!filePath) {
        return null;
      }
      return {
        filePath,
        mimeType: typeof item.mimeType === 'string' ? item.mimeType.trim().toLowerCase() : (typeof item.mime_type === 'string' ? item.mime_type.trim().toLowerCase() : ''),
        type: typeof item.type === 'string' ? item.type.trim().toLowerCase() : '',
      };
    })
    .filter(Boolean);
}

function hashForLog(value) {
  let hash = 0;
  const text = String(value || '');
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(16);
}

function createRequestId() {
  return `rb-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function sanitizeRequestId(value) {
  return String(value || '').trim().replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 80) || createRequestId();
}
