/**
 * Reply backend selector for Hermes chat mainline.
 */

import { createHash } from 'node:crypto';

import { getBackendIngestConfig, ingestExchangeToBackend } from './backendIngestClient.mjs';
import { shouldSuppressSystemQueueReply } from './externalMcp/systemQueue.mjs';
import {
  applyActionGateTelemetry,
  evaluateActionContract,
  evaluateActionGate,
  getActionGateConfig,
  logActionContract,
  trustActionReceiptEvidence,
} from './actionContract.mjs';
import { repairActionContract } from './actionRepair.mjs';
import { getHermesGatewayConfig, sendChatToHermesGateway } from './hermesGatewayClient.mjs';
import { detectEnvironmentPrivacyCommand, privacyConfirmation } from './environmentSense.mjs';
import { applyEgressPrivacyGate } from './egressPrivacyGate.mjs';
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
import { normalizeReplyEnvelope } from './replyEnvelope.mjs';
import { getSemanticVerifierConfig, verifySemanticClaims } from './semanticClaimVerifier.mjs';
import { isTrustedInformationalReportTask } from './hermesTaskScope.mjs';
import { createOperationLedger } from './operationLedger.mjs';
import { createCoreDurableJobExecutor } from './coreDurableJobExecutor.mjs';
import { createTrustedExecutorAdapters } from './trustedExecutorAdapters.mjs';
import { createPersonalLearningExecutorAdapter } from './personalLearningClient.mjs';
import { createAiDailyDigestExecutorAdapter } from './aiDailyDigestClient.mjs';
import { createFeishuActionExecutorAdapter } from './feishuActionExecutor.mjs';
import {
  deleteStickers,
  resolveStickerAsset,
  saveStickersFromInbox,
  updateStickers,
} from './stickerCatalog.mjs';

const pendingActionRuntimePayloads = new Map();
const DEFAULT_PENDING_EXECUTOR_ACTIONS = new Set(['sticker_save', 'sticker_delete', 'sticker_update']);

export function getReplyBackendConfig(env = process.env) {
  return {
    replyBackend: 'hermes',
    fallbackText: env.NODE_BRIDGE_FALLBACK_TEXT || '暂时无法连接到 personal agent，请稍后再试。',
  };
}

export function createReplyBackend(options = {}) {
  const env = options.env || process.env;
  const config = getReplyBackendConfig(env);
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const operationLedger = options.operationLedger || createOperationLedger({ env, now });
  const configuredExecutorAdapters = Array.isArray(options.trustedExecutorAdapterConfigs)
    ? [...options.trustedExecutorAdapterConfigs]
    : [];
  if (!options.trustedActionExecutors) {
    configuredExecutorAdapters.push(createFeishuActionExecutorAdapter({
      env,
      execFileImpl: options.execFileImpl,
    }));
  }
  if (!options.trustedActionExecutors && String(env.RAN_AGENT_INTERNAL_CONTROL_SECRET || '').trim()) {
    configuredExecutorAdapters.push(createPersonalLearningExecutorAdapter({
      env,
      fetchImpl: options.fetchImpl || globalThis.fetch,
    }));
    configuredExecutorAdapters.push(createAiDailyDigestExecutorAdapter({ env, fetchImpl: options.fetchImpl || globalThis.fetch }));
  }
  const trustedActionExecutors = options.trustedActionExecutors || createTrustedExecutorAdapters({
    ledger: operationLedger,
    adapters: configuredExecutorAdapters,
    now,
  });
  const coreDurableJobExecutor = options.coreDurableJobExecutor || createCoreDurableJobExecutor({
    env,
    fetchImpl: options.fetchImpl || globalThis.fetch,
    createJob: options.createDurableJobImpl,
  });
  const activityFacade = options.activityFacade || null;

  return {
    async getReply(message, backendOptions = {}) {
      const gatewayConfig = backendOptions.hermesConfig || getHermesGatewayConfig(env);
      const chatImpl = options.hermesImpl || options.chatImpl || sendChatToHermesGateway;
      const requestId = sanitizeRequestId(backendOptions.requestId || message.request_id || createRequestId());
      const operationDate = nodeLocalDate(now());
      const actorContext = trustedActorContext(message.trusted_actor_context);
      const conversationDigest = actorContext ? digestValue(actorContext.conversationKey) : '';
      const priorActionOutcomes = actorContext && typeof operationLedger.listRecentOutcomes === 'function'
        ? operationLedger.listRecentOutcomes({ actorKey: actorContext.actorKey, conversationDigest })
        : [];
      const environmentPrivacyCommand = detectEnvironmentPrivacyCommand(message.text);
      if (environmentPrivacyCommand) {
        return {
          replyText: privacyConfirmation(environmentPrivacyCommand, { env }),
          followUpMessages: [],
          media: null,
          source: 'bridge_environment_privacy',
        };
      }
      if (detectExternalMcpStopCommand(message.text)) {
        const stopped = await stopAutonomyActivityFromNaturalCommand({
          text: message.text,
          requestId,
          actorContext: trustedActorContext(message.trusted_actor_context),
          activityFacade,
        });
        if (stopped) {
          return {
            replyText: stopped,
            followUpMessages: [],
            media: null,
            source: 'bridge_external_activity_stop',
          };
        }
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
          source: pendingOutcome.source || 'bridge_pending_action',
        };
      }
      let response = await chatImpl(
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
          action_outcomes: priorActionOutcomes,
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

      let replyEnvelope;
      let excludeFromHistory = false;
      try {
        replyEnvelope = normalizeReplyEnvelope(response);
        response = {
          ...response,
          reply_text: replyEnvelope.message,
          follow_up_messages: [],
        };
      } catch (error) {
        loggerFor(options).warn?.(`reply envelope rejected code=${String(error?.code || 'REPLY_ENVELOPE_INVALID')}`);
        replyEnvelope = normalizeReplyEnvelope({ reply_text: '回复格式校验失败，请稍后重试。' });
        response = {
          ...response,
          reply_text: replyEnvelope.message,
          follow_up_messages: [],
          media: null,
        };
        excludeFromHistory = true;
      }
      const informationalReportPolicy = restrictInformationalReportEnvelope(replyEnvelope, message);
      replyEnvelope = informationalReportPolicy.envelope;
      replyEnvelope = suppressUnrequestedEffectfulActionRequests(replyEnvelope, message.text);

      const actionExecution = await executeEnvelopeActionRequests({
        actionRequests: replyEnvelope.actionRequests,
        actorContext,
        currentMessage: message,
        requestId,
        conversationDigest,
        platform: message.platform || message.channel || 'wechat',
        operationLedger,
        trustedActionExecutors,
        coreDurableJobExecutor,
        operationDate,
      });
      let activityExecution = await executeEnvelopeActivityRequest({
        activityRequest: replyEnvelope.activityRequest,
        actorContext: trustedActorContext(message.trusted_actor_context),
        activityFacade,
        currentMessage: message,
      });
      if (!replyEnvelope.activityRequest) {
        activityExecution = await repairMissingExternalActivityCommitment({
          commitments: replyEnvelope.commitments,
          actorContext: trustedActorContext(message.trusted_actor_context),
          activityFacade,
          currentMessage: message,
          fallback: activityExecution,
        });
      }
      const durableReceiptSummaries = [...actionExecution.receiptSummaries, ...activityExecution.receiptSummaries];
      const commitmentBlocked = replyEnvelope.commitments.length > 0
        && !commitmentsHaveMatchingActiveReceipts(replyEnvelope.commitments, durableReceiptSummaries);
      const learningPromotionDenied = actionExecution.receiptSummaries.some((receipt) => (
        ['memory.remember', 'memory.correct'].includes(receipt?.actionType)
        && receipt?.errorCode === 'ACTION_NOT_GROUNDED'
      ));
      const nodeActionAcknowledgement = buildNodeActionAcknowledgement(response.reply_text, actionExecution.receiptSummaries);
      const coreAcknowledgement = commitmentBlocked
        ? ''
        : bridgeOwnedCoreAcknowledgement(replyEnvelope.commitments, durableReceiptSummaries);
      if (commitmentBlocked) {
        response = { ...response, reply_text: '这项后续工作尚未启动。', follow_up_messages: [] };
      } else if (learningPromotionDenied) {
        response = { ...response, reply_text: '保存结果尚未返回，未写入长期记忆。', follow_up_messages: [] };
      } else if (coreAcknowledgement) {
        response = { ...response, reply_text: coreAcknowledgement, follow_up_messages: [] };
      } else if (nodeActionAcknowledgement) {
        response = { ...response, reply_text: nodeActionAcknowledgement, follow_up_messages: [] };
      }

      const logger = options.logger || console;
      const mediaFromMarker = extractTrustedMediaMarker(response.reply_text, {
        resolveStickerAssetImpl: options.resolveStickerAssetImpl || resolveStickerAsset,
        env,
        logger,
      });
      const responseMedia = response.media && typeof response.media === 'object'
        ? response.media
        : mediaFromMarker?.media || null;
      let responseText = mediaFromMarker
        ? mediaFromMarker.text
        : response.reply_text;

      let finalReplyText = responseText;
      let finalResponseMedia = responseMedia;
      let responseSource = commitmentBlocked
        ? 'bridge_commitment_guard'
        : learningPromotionDenied
          ? 'bridge_learning_intent_guard'
        : actionExecution.receiptSummaries.some((item) => item?.actionType === 'ai_daily_digest.send')
          ? 'bridge_ai_daily_digest'
        : coreAcknowledgement
          ? 'bridge_core_job_ack'
          : 'hermes';
      if (actionGateConfig.enabled) {
        let rawContractReplyText = response.reply_text;
        let contract = evaluateActionContract({
          requestId,
          channel: message.platform || message.channel || 'wechat',
          conversationId: message.conversation_id || message.conversationId || message.sender_id,
          profile: gatewayConfig.profile || response.profile || response.model || '',
          message,
          response: { ...response, media: finalResponseMedia, reply_text: rawContractReplyText },
          actionRequests: replyEnvelope.actionRequests,
          toolResults: actionExecution.evidence,
          actionOutcomes: priorActionOutcomes,
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
            responseSource = 'bridge_action_repair';
            rawContractReplyText = buildRepairedContractReply(rawContractReplyText, repair);
            const repairedMediaMarker = extractTrustedMediaMarker(rawContractReplyText, {
              resolveStickerAssetImpl: options.resolveStickerAssetImpl || resolveStickerAsset,
              env,
              logger,
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
              actionRequests: replyEnvelope.actionRequests,
              toolResults: [...actionExecution.evidence, ...repair.toolResults],
              actionOutcomes: priorActionOutcomes,
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
          responseSource = 'bridge_action_gate';
        } else {
          finalReplyText = responseText;
        }
        logActionContract(applyActionGateTelemetry(contract, gate, repair), options.logger || console);
      }

      let finalFollowUpMessages = normalizeFollowUpMessages(response.follow_up_messages);
      if (actionGateConfig.enabled && finalFollowUpMessages.length > 0) {
        const gatedFollowUps = [];
        for (const followUpText of finalFollowUpMessages) {
          const followContract = evaluateActionContract({
            requestId,
            channel: message.platform || message.channel || 'wechat',
            conversationId: message.conversation_id || message.conversationId || message.sender_id,
            profile: gatewayConfig.profile || response.profile || response.model || '',
            message,
            response: { ...response, media: finalResponseMedia, reply_text: followUpText },
            actionRequests: replyEnvelope.actionRequests,
            toolResults: actionExecution.evidence,
            actionOutcomes: priorActionOutcomes,
            config: actionGateConfig,
          });
          const followGate = evaluateActionGate({
            contract: followContract,
            finalReply: followUpText,
            mode: actionGateConfig.mode === 'observe' ? 'observe' : 'enforce',
          });
          if (followGate.shouldRewrite) {
            responseSource = 'bridge_action_gate';
            gatedFollowUps.push(followGate.rewrittenText);
          } else {
            gatedFollowUps.push(followUpText);
          }
          logActionContract(applyActionGateTelemetry(followContract, followGate, { repairAttempted: false, repairStatus: 'skipped' }), logger);
        }
        finalFollowUpMessages = gatedFollowUps;
      }

      const semanticResult = await verifySemanticClaims({
        // A rejected commitment is removed before the semantic observer sees
        // the reply.  The observer may detect prose, but it never receives a
        // declaration which the bridge declined to bind to a durable receipt.
        envelope: {
          ...replyEnvelope,
          message: finalReplyText,
          commitments: commitmentBlocked ? [] : replyEnvelope.commitments,
        },
        receiptSummaries: durableReceiptSummaries,
        config: backendOptions.semanticVerifierConfig || getSemanticVerifierConfig(env),
        verifierImpl: options.semanticVerifierImpl,
        fetchImpl: backendOptions.fetchImpl,
      });
      finalReplyText = semanticResult.releaseText;
      excludeFromHistory = excludeFromHistory || semanticResult.excludeFromHistory === true;

      const privacyResult = applyEgressPrivacyGate(finalReplyText, {
        technicalDiagnostics: backendOptions.technicalDiagnostics === true,
      });
      finalReplyText = privacyResult.text;
      excludeFromHistory = excludeFromHistory || privacyResult.excludeFromHistory === true;

      const suppression = shouldSuppressSystemQueueReply({
        routeHint: message.route_hint || '',
        replyText: finalReplyText,
      });
      const visibleReplyText = suppression.suppress ? '' : finalReplyText;
      const visibleFollowUpMessages = suppression.suppress ? [] : finalFollowUpMessages;
      const visibleMedia = suppression.suppress ? null : finalResponseMedia;
      logInformationalReportPolicy({
        policy: informationalReportPolicy,
        routeHint: message.route_hint,
        bodyReleased: !suppression.suppress && Boolean(visibleReplyText),
        logger,
      });

      let backendProjection = null;
      if (!excludeFromHistory && !suppression.suppress) {
        const projectIngest = async ({ outboxId = '', replyText = '' } = {}) => ingestVisibleExchange({
          message,
          replyText: String(replyText || visibleReplyText),
          source: responseSource,
          media: normalizeMediaItems(message.media),
          imageUrls: Array.isArray(message.image_urls)
            ? message.image_urls.filter((item) => typeof item === 'string' && item.trim())
            : [],
          ingestConfig: backendOptions.ingestConfig || getBackendIngestConfig(env),
          ingestImpl: options.ingestImpl || ingestExchangeToBackend,
          fetchImpl: backendOptions.fetchImpl,
          logger,
          eventId: outboxId,
        });
        if (backendOptions.deferIngest === true) {
          backendProjection = projectIngest;
        } else {
          await projectIngest();
        }
      }

      return {
        replyText: visibleReplyText,
        followUpMessages: visibleFollowUpMessages,
        media: visibleMedia,
        source: responseSource,
        suppressSend: suppression.suppress,
        suppressReason: suppression.reason,
        excludeFromHistory,
        backendProjection,
        actionOutcomes: actionExecution.publicOutcomes,
      };
    },
    async releaseExternalCheckpoint({ candidate, context } = {}, backendOptions = {}) {
      const message = checkpointCandidateText(candidate);
      if (!message || !context?.notifyTarget) {
        return { replyText: '', followUpMessages: [], media: null, source: 'external_checkpoint', suppressSend: true, excludeFromHistory: true };
      }
      const semanticResult = await verifySemanticClaims({
        envelope: {
          message,
          claims: candidate?.claim ? [{ type: String(candidate.claim) }] : [],
          commitments: [],
        },
        receiptSummaries: (Array.isArray(candidate?.receipts) ? candidate.receipts : []).map((receipt) => ({
          actionType: 'external.checkpoint',
          outcome: String(receipt?.outcome || ''),
          status: String(receipt?.outcome || ''),
        })),
        config: backendOptions.semanticVerifierConfig || getSemanticVerifierConfig(env),
        verifierImpl: options.semanticVerifierImpl,
        fetchImpl: backendOptions.fetchImpl,
      });
      const privacyResult = applyEgressPrivacyGate(semanticResult.releaseText, {
        technicalDiagnostics: backendOptions.technicalDiagnostics === true,
      });
      return {
        replyText: privacyResult.text,
        followUpMessages: [],
        media: null,
        source: 'external_checkpoint',
        suppressSend: false,
        excludeFromHistory: semanticResult.excludeFromHistory === true || privacyResult.excludeFromHistory === true,
      };
    },
    config,
  };
}

function checkpointCandidateText(candidate) {
  if (candidate?.kind !== 'core_external_activity_narration_candidate' || candidate.status !== 'ready') return '';
  return (Array.isArray(candidate.facts) ? candidate.facts : [])
    .map((fact) => String(fact?.summary || '').trim())
    .filter(Boolean)
    .slice(0, 3)
    .join('\n');
}

function loggerFor(options = {}) {
  return options.logger || console;
}

function restrictInformationalReportEnvelope(envelope, message = {}) {
  const informationalReportTask = isTrustedInformationalReportTask(message);
  if (!informationalReportTask) {
    return Object.freeze({ informationalReportTask: false, prohibitedFields: Object.freeze([]), envelope });
  }
  const prohibitedFields = [
    ...(envelope.actionRequests.length > 0 ? ['actionRequests'] : []),
    ...(envelope.activityRequest ? ['activityRequest'] : []),
    ...(envelope.commitments.length > 0 ? ['commitments'] : []),
  ];
  return Object.freeze({
    informationalReportTask: true,
    prohibitedFields: Object.freeze(prohibitedFields),
    envelope: Object.freeze({
      ...envelope,
      actionRequests: Object.freeze([]),
      activityRequest: null,
      commitments: Object.freeze([]),
    }),
  });
}

function suppressUnrequestedEffectfulActionRequests(envelope, userText) {
  if (!Array.isArray(envelope?.actionRequests) || envelope.actionRequests.length === 0) return envelope;
  const filtered = envelope.actionRequests.filter((request) => (
    !['feishu.message.send', 'feishu.document.update', 'ai_daily_digest.send'].includes(String(request?.actionType || ''))
    || hasFreshExecutionIntent(userText, request.actionType)
  ));
  if (filtered.length === envelope.actionRequests.length) return envelope;
  return Object.freeze({ ...envelope, actionRequests: Object.freeze(filtered) });
}

function hasFreshExecutionIntent(value, actionType) {
  const text = String(value || '').trim();
  if (!text || hasNegatedExecutionIntent(text) || (hasMetaDiscussionIntent(text) && !hasExplicitMetaExecutionOverride(text))) return false;
  if (actionType === 'feishu.document.update') {
    return /(?:请|麻烦|现在|立即|再|重新).{0,40}(?:更新|修改|补充|追加|写入)/.test(text)
      || /^\s*帮我.{0,40}(?:更新|修改|补充|追加|写入)/.test(text)
      || /(?:更新|修改|补充|追加|写入).{0,16}(?:一下|一遍|一次)/.test(text);
  }
  if (actionType === 'ai_daily_digest.send') {
    return /(?:日报|简报|摘要)/.test(text)
      && /(?:请|帮我|麻烦|现在|立即|再|重新|补发|重发).{0,40}(?:发|发送|补发|重发)|(?:发|发送|补发|重发).{0,20}(?:日报|简报|摘要)/.test(text);
  }
  return /(?:请|麻烦|现在|立即|再|重新|补发|重发).{0,40}(?:发|发送|发出|转发|补发|重发)/.test(text)
    || /^\s*帮我.{0,40}(?:发|发送|发出|转发|补发|重发)/.test(text)
    || /(?:再|重新)(?:发|发送|补发|重发).{0,12}(?:一次|一遍)?/.test(text)
    || /(?:发送|发出|转发|补发|重发).{0,16}(?:一下|一遍|一次)/.test(text);
}

function hasNegatedExecutionIntent(text) {
  return /(?:不是|并非).{0,20}(?:让|要|叫)?.{0,12}(?:再|重新)?(?:执行|发送|发出|发|更新|修改|补发|重发)/.test(text)
    || /(?:不要|别|无需|不用).{0,16}(?:再|重新)?(?:执行|发送|发出|发|更新|修改|补发|重发)/.test(text);
}

function hasMetaDiscussionIntent(text) {
  const actionVerb = /(?:执行|发送|发出|补发|重发|发(?!现)|更新|修改|补充|追加|写入)/;
  if (/[？?]/.test(text) && actionVerb.test(text)) return true;
  return /(?:为什么|为何|怎么会|怎么就|怎么把|解释(?:一下)?|说明(?:一下)?)/.test(text)
    || /(?:告诉我|说清楚).{0,24}(?:什么|哪些|为何|为什么|怎么)/.test(text)
    || /(?:什么|哪些|谁|哪里|哪儿|哪个|几次|多少).{0,20}(?:发送|发出|补发|重发|发(?!现)|更新|修改|执行)/.test(text)
    || /(?:发送|发出|补发|重发|发(?!现)|更新|修改|执行).{0,20}(?:什么|哪些|谁|哪里|哪儿|哪个|几次|多少)/.test(text)
    || /(?:发送|发出|补发|重发|发(?!现)|更新|修改|执行).{0,20}(?:(?:了)?[吗么呢]|了没|没有)[？?]?$/.test(text);
}

function hasExplicitMetaExecutionOverride(text) {
  return /(?:^|[，。！？；,;.!?])\s*(?:(?:请|麻烦|帮我|现在|立即).{0,8})?(?:再|重新|补发|重发).{0,12}(?:发|发送|发出|补发|重发|更新|修改|补充|追加|写入|执行)/.test(text);
}

function logInformationalReportPolicy({ policy, routeHint, bodyReleased, logger }) {
  if (!policy?.informationalReportTask) return;
  logger?.log?.(`[hermes-informational-report] ${JSON.stringify({
    route_hint: String(routeHint || '').trim(),
    informational_report_task: true,
    action_claim_detection_skipped: true,
    prohibited_action_fields_detected: policy.prohibitedFields,
    prohibited_action_fields_dropped: policy.prohibitedFields,
    informational_report_body_released: bodyReleased === true,
  })}`);
}

function trustedActorContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const actorKey = String(value.actorKey || '').trim();
  const platform = String(value.platform || '').trim();
  const conversationKey = String(value.conversationKey || '').trim();
  if (!actorKey || !platform || !conversationKey) return null;
  return Object.freeze({
    actorKey,
    owner: value.owner === true,
    platform,
    conversationKey,
  });
}

async function executeEnvelopeActionRequests({
  actionRequests = [],
  actorContext,
  currentMessage,
  requestId,
  conversationDigest,
  platform,
  operationLedger,
  trustedActionExecutors,
  coreDurableJobExecutor,
  operationDate,
}) {
  const receiptSummaries = [];
  const evidence = [];
  for (const request of actionRequests) {
    if (coreDurableJobExecutor?.supports?.(request.actionType)) {
      const result = await executeCoreDurableJobRequest({
        request,
        actorContext,
        currentMessage,
        coreDurableJobExecutor,
      });
      receiptSummaries.push(result.receiptSummary);
      continue;
    }
    if (!actorContext?.owner) {
      const summary = rejectedActionSummary(request.actionType, 'ACTOR_NOT_AUTHORIZED');
      recordRejectedContinuity(operationLedger, { request, actorContext, requestId, conversationDigest, platform, code: 'ACTOR_NOT_AUTHORIZED', summary });
      receiptSummaries.push({
        requestRef: request.requestRef,
        actionType: request.actionType,
        outcome: 'denied',
        status: 'rejected',
        errorCode: 'ACTOR_NOT_AUTHORIZED',
        summary,
        retryable: false,
      });
      continue;
    }
    let grounded;
    let dispatchStarted = false;
    try {
      grounded = groundActionRequest(request, currentMessage, { operationDate });
    } catch (error) {
      const errorCode = sanitizeExecutionCode(error?.code || 'ACTION_NOT_GROUNDED');
      const summary = rejectedActionSummary(request.actionType, errorCode);
      recordRejectedContinuity(operationLedger, { request, actorContext, requestId, conversationDigest, platform, code: errorCode, summary });
      receiptSummaries.push({
        requestRef: request.requestRef,
        actionType: request.actionType,
        outcome: 'denied',
        status: 'rejected',
        errorCode,
        summary,
        retryable: false,
      });
      continue;
    }
    const groundedRequest = grounded?.request || grounded;
    const privatePayload = grounded?.privatePayload;
    if (!trustedActionExecutors.supports(groundedRequest.actionType)) {
      const summary = rejectedActionSummary(request.actionType, 'EXECUTOR_UNSUPPORTED');
      recordRejectedContinuity(operationLedger, { request, actorContext, requestId, conversationDigest, platform, code: 'EXECUTOR_UNSUPPORTED', summary });
      receiptSummaries.push({
        requestRef: request.requestRef,
        actionType: request.actionType,
        outcome: 'unsupported',
        status: 'rejected',
        errorCode: 'EXECUTOR_UNSUPPORTED',
        summary,
        retryable: false,
      });
      continue;
    }
    try {
      const operationKey = String(request.scope?.operationKey || request.requestRef || '').trim();
      const idempotencyDigest = digestValue(`${conversationDigest}:${request.actionType}:${operationKey}`);
      const equivalent = typeof operationLedger.findEquivalentOutcome === 'function'
        ? operationLedger.findEquivalentOutcome({
          actorKey: actorContext.actorKey,
          conversationDigest,
          actionType: groundedRequest.actionType,
          scope: groundedRequest.scope,
        })
        : null;
      if (equivalent && (['partial', 'ambiguous'].includes(equivalent.status)
        || grounded?.statusQuestion === true)) {
        const replayed = replayedOperationSummary(request, equivalent);
        receiptSummaries.push(replayed);
        if (replayed.receiptVerified) evidence.push(trustedReceiptEvidence(replayed, equivalent.operationId));
        continue;
      }
      if (grounded?.statusQuestion === true) throw actionExecutionError('ACTION_NOT_GROUNDED');
      const reserved = typeof operationLedger.reserve === 'function'
        ? operationLedger.reserve({
          request: groundedRequest,
          actorContext,
          binding: {
            idempotencyDigest,
            conversationDigest,
            requestId,
            platform,
            attempt: 1,
            capability: groundedRequest.actionType,
          },
        })
        : { replayed: false, operation: operationLedger.mint({ request: groundedRequest, actorContext }) };
      const operation = reserved.operation;
      if (reserved.replayed) {
        const replayed = replayedOperationSummary(request, operation);
        receiptSummaries.push(replayed);
        if (replayed.receiptVerified) evidence.push(trustedReceiptEvidence(replayed, operation.operationId));
        continue;
      }
      dispatchStarted = true;
      const receipt = await trustedActionExecutors.execute(operation, { payload: privatePayload });
      const verified = trustedActionExecutors.verifyReceipt(receipt, {
        operationId: operation.operationId,
        actorKey: operation.actorKey,
        actionType: operation.actionType,
        scopeDigest: operation.scopeDigest,
        issuer: receipt.issuer,
        status: receipt.status,
        evidenceType: receipt.evidenceType,
        requestId,
        conversationDigest,
        platform,
        attempt: 1,
        capability: groundedRequest.actionType,
        idempotencyDigest,
      });
      if (verified.ok !== true) throw actionExecutionError('RECEIPT_VERIFICATION_FAILED');
      const succeeded = receipt.status === 'succeeded';
      receiptSummaries.push({
        requestRef: request.requestRef,
        actionType: request.actionType,
        outcome: succeeded ? 'applied' : receipt.status,
        status: receipt.status,
        effectDigest: receipt.effectDigest,
        summary: receipt.summary || defaultOutcomeSummary(request.actionType, receipt.status),
        target: receipt.target || String(groundedRequest.scope?.target || ''),
        retryable: receipt.retryable === true,
        receiptVerified: true,
        replayed: false,
      });
      evidence.push(trustedReceiptEvidence(receiptSummaries.at(-1), receipt.operationId));
    } catch (error) {
      const errorCode = sanitizeExecutionCode(error?.code || 'EXECUTOR_FAILED');
      const status = dispatchStarted ? 'ambiguous' : 'rejected';
      const summary = status === 'ambiguous'
        ? defaultOutcomeSummary(request.actionType, 'ambiguous')
        : rejectedActionSummary(request.actionType, errorCode);
      if (!dispatchStarted) {
        recordRejectedContinuity(operationLedger, { request, actorContext, requestId, conversationDigest, platform, code: errorCode, summary });
      }
      receiptSummaries.push({
        requestRef: request.requestRef,
        actionType: request.actionType,
        outcome: 'unverified',
        status,
        errorCode,
        summary,
        retryable: false,
        receiptVerified: false,
      });
    }
  }
  return Object.freeze({
    receiptSummaries: Object.freeze(receiptSummaries.map((item) => Object.freeze(item))),
    evidence: Object.freeze(evidence),
    publicOutcomes: Object.freeze(receiptSummaries
      .filter((item) => ['feishu.message.send', 'feishu.document.update', 'ai_daily_digest.send'].includes(item.actionType))
      .map((item) => Object.freeze({
        actionType: item.actionType,
        target: String(item.target || ''),
        status: item.status,
        summary: String(item.summary || defaultOutcomeSummary(item.actionType, item.status)),
        retryable: item.retryable === true,
        replayed: item.replayed === true,
        ...(item.errorCode ? { errorCode: item.errorCode } : {}),
      }))),
  });
}

async function executeCoreDurableJobRequest({ request, actorContext, currentMessage, coreDurableJobExecutor }) {
  if (!actorContext?.owner) {
    return {
      receiptSummary: {
        requestRef: request.requestRef,
        actionType: request.actionType,
        outcome: 'denied',
        status: 'failed',
        errorCode: 'ACTOR_NOT_AUTHORIZED',
      },
    };
  }
  try {
    const result = await coreDurableJobExecutor.execute({ request, actorContext, currentMessage });
    const receipt = result?.receipt;
    if (result?.ok !== true || !isActiveDurableReceipt(receipt, { requestRef: request.requestRef, actionType: request.actionType, actorKey: actorContext.actorKey })) {
      return {
        receiptSummary: {
          requestRef: request.requestRef,
          actionType: request.actionType,
          outcome: 'failed',
          status: 'failed',
          errorCode: sanitizeExecutionCode(result?.reason || 'CORE_JOB_RECEIPT_INVALID'),
        },
      };
    }
    return {
      receiptSummary: {
        requestRef: request.requestRef,
        actionType: request.actionType,
        outcome: 'applied',
        status: 'active',
        effectDigest: receipt.goalDigest,
        durableActive: true,
      },
    };
  } catch {
    return {
      receiptSummary: {
        requestRef: request.requestRef,
        actionType: request.actionType,
        outcome: 'failed',
        status: 'failed',
        errorCode: 'CORE_JOB_CREATE_FAILED',
      },
    };
  }
}

async function executeEnvelopeActivityRequest({ activityRequest, actorContext, activityFacade, currentMessage = {} }) {
  if (!activityRequest) return Object.freeze({ receiptSummaries: Object.freeze([]) });
  const requestRef = String(activityRequest.requestRef || '').trim();
  if (!actorContext?.owner) {
    return Object.freeze({ receiptSummaries: Object.freeze([Object.freeze({
      requestRef,
      actionType: 'external.activity',
      outcome: 'denied',
      status: 'failed',
      errorCode: 'ACTOR_NOT_AUTHORIZED',
    })]) });
  }
  if (!activityFacade || typeof activityFacade.handle !== 'function') {
    return Object.freeze({ receiptSummaries: Object.freeze([Object.freeze({
      requestRef,
      actionType: 'external.activity',
      outcome: 'unsupported',
      status: 'failed',
      errorCode: 'EXTERNAL_ACTIVITY_UNAVAILABLE',
    })]) });
  }
  try {
    const result = await activityFacade.handle(activityRequest, actorContext);
    const receipt = result?.receipt;
    if (receipt && typeof activityFacade.bindNotifyTarget === 'function') {
      await activityFacade.bindNotifyTarget({
        receipt,
        actorContext,
        target: {
          platform: String(currentMessage.platform || currentMessage.channel || '').trim(),
          channelType: String(currentMessage.channel_type || currentMessage.channelType || 'dm').trim(),
          conversationId: String(currentMessage.conversation_id || currentMessage.conversationId || currentMessage.sender_id || '').trim(),
          senderId: String(currentMessage.sender_id || currentMessage.senderId || '').trim(),
        },
      });
    }
    return Object.freeze({ receiptSummaries: Object.freeze([Object.freeze({
      requestRef,
      actionType: 'external.activity',
      outcome: receipt ? 'applied' : String(result?.action || 'noop'),
      status: receipt && isActiveDurableReceipt(receipt, { actorKey: actorContext.actorKey }) ? 'active' : 'noop',
      effectDigest: receipt?.goalDigest || '',
      ...(receipt && isActiveDurableReceipt(receipt, { actorKey: actorContext.actorKey }) ? { durableActive: true } : {}),
    })]) });
  } catch (error) {
    return Object.freeze({ receiptSummaries: Object.freeze([Object.freeze({
      requestRef,
      actionType: 'external.activity',
      outcome: 'failed',
      status: 'failed',
      errorCode: sanitizeExecutionCode(error?.code || 'EXTERNAL_ACTIVITY_FAILED'),
    })]) });
  }
}

async function repairMissingExternalActivityCommitment({ commitments, actorContext, activityFacade, currentMessage = {}, fallback }) {
  const matching = (Array.isArray(commitments) ? commitments : [])
    .filter((commitment) => commitment?.type === 'external_continue' && String(commitment?.requestRef || '').trim());
  if (matching.length !== 1 || !actorContext?.owner || typeof activityFacade?.repairStart !== 'function') return fallback;
  const commitment = matching[0];
  const requestRef = String(commitment.requestRef).trim();
  try {
    const result = await activityFacade.repairStart({
      requestRef,
      commitment: Object.freeze({ type: commitment.type, requestRef }),
      actorContext,
      currentMessage: Object.freeze({ text: String(currentMessage.text || '') }),
    });
    const receipt = result?.receipt;
    return Object.freeze({ receiptSummaries: Object.freeze([Object.freeze({
      requestRef,
      actionType: 'external.activity',
      outcome: receipt ? 'applied' : String(result?.action || 'noop'),
      status: receipt && isActiveDurableReceipt(receipt, { actorKey: actorContext.actorKey }) ? 'active' : 'noop',
      effectDigest: receipt?.goalDigest || '',
      ...(receipt && isActiveDurableReceipt(receipt, { actorKey: actorContext.actorKey }) ? { durableActive: true } : {}),
    })]) });
  } catch (error) {
    return Object.freeze({ receiptSummaries: Object.freeze([Object.freeze({
      requestRef,
      actionType: 'external.activity',
      outcome: 'failed',
      status: 'failed',
      errorCode: sanitizeExecutionCode(error?.code || 'EXTERNAL_ACTIVITY_REPAIR_FAILED'),
    })]) });
  }
}

function commitmentsHaveMatchingActiveReceipts(commitments, receiptSummaries) {
  return commitments.every((commitment) => {
    const requestRef = String(commitment?.requestRef || '').trim();
    return requestRef.length > 0 && receiptSummaries.some((receipt) => (
      receipt?.durableActive === true
      && receipt.requestRef === requestRef
      && receipt.outcome === 'applied'
      && receipt.status === 'active'
    ));
  });
}

function bridgeOwnedCoreAcknowledgement(commitments, receiptSummaries) {
  const acknowledgements = {
    'core.memory-maintenance': '已安排记忆维护。',
    'core.reflection': '已安排聊天复盘。',
    'core.night-cycle': '已安排夜间整理。',
  };
  for (const commitment of commitments) {
    const requestRef = String(commitment?.requestRef || '').trim();
    const receipt = receiptSummaries.find((item) => (
      item?.requestRef === requestRef
      && item?.durableActive === true
      && item?.outcome === 'applied'
      && item?.status === 'active'
      && Object.hasOwn(acknowledgements, item?.actionType)
    ));
    if (receipt) return acknowledgements[receipt.actionType];
  }
  return '';
}

function isActiveDurableReceipt(receipt, expected = {}) {
  if (!receipt || typeof receipt !== 'object') return false;
  if (String(receipt.status || '') !== 'active'
    || !/^[A-Za-z0-9_.:-]{8,160}$/.test(String(receipt.jobId || ''))
    || !/^[a-f0-9]{32,128}$/.test(String(receipt.goalDigest || ''))) return false;
  return Object.entries(expected).every(([field, value]) => value === undefined || receipt[field] === value);
}

function groundActionRequest(request, message = {}, { operationDate } = {}) {
  const actionType = String(request.actionType || '');
  if (actionType === 'ai_daily_digest.send') {
    const scope = request.scope && typeof request.scope === 'object' && !Array.isArray(request.scope) ? request.scope : {};
    const userText = String(message.text || '');
    if (!/(日报|简报|摘要)/.test(userText) || !/(发|补发|重发|重新|再)/.test(userText) || scope.mode !== 'manual') throw actionExecutionError('ACTION_NOT_GROUNDED');
    if (!['current_local_date', 'today'].includes(String(scope.date || 'current_local_date'))) throw actionExecutionError('ACTION_NOT_GROUNDED');
    return {
      request: { ...request, scope: { mode: 'manual', date: 'current_local_date', operationDate } },
      statusQuestion: isExecutionStatusQuestion(userText),
    };
  }
  if (['feishu.message.send', 'feishu.document.update'].includes(actionType)) {
    return groundFeishuActionRequest(request, message);
  }
  if (!actionType.startsWith('memory.')) return request;
  const scope = request.scope && typeof request.scope === 'object' && !Array.isArray(request.scope)
    ? request.scope
    : {};
  const userText = String(message.text || '');
  if (['memory.remember', 'memory.correct'].includes(actionType)) {
    if (!hasExplicitMemoryIntent(userText, actionType)) {
      throw actionExecutionError('ACTION_NOT_GROUNDED');
    }
    const statement = String(scope.statement || '').trim();
    const normalizedStatement = normalizeGroundingText(statement);
    const normalizedUserText = normalizeGroundingText(userText);
    if (normalizedStatement.length < 2 || !normalizedUserText.includes(normalizedStatement)) {
      throw actionExecutionError('ACTION_NOT_GROUNDED');
    }
    const kind = actionType === 'memory.correct'
      ? 'correction'
      : ['preference', 'relationship', 'routine', 'operating_lesson'].includes(String(scope.kind || ''))
        ? String(scope.kind)
        : 'preference';
    return {
      ...request,
      scope: {
        kind,
        subject_key: String(scope.subject_key || scope.subjectKey || '').trim(),
        statement,
        evidence_digest: createHash('sha256').update(userText, 'utf8').digest('hex'),
        confidence: 1,
      },
    };
  }
  if (actionType === 'memory.forget') {
    if (!/(?:忘记|别再记|不要记|删除).*(?:记忆|偏好|这个|它)?|forget/i.test(userText)) {
      throw actionExecutionError('ACTION_NOT_GROUNDED');
    }
    return {
      ...request,
      scope: { subject_key: String(scope.subject_key || scope.subjectKey || '').trim() },
    };
  }
  if (actionType === 'memory.query') {
    if (!/(?:记得|记住了什么|你.*(?:记忆|了解)|remember)/i.test(userText)) {
      throw actionExecutionError('ACTION_NOT_GROUNDED');
    }
    return {
      ...request,
      scope: {
        subject_prefix: String(scope.subject_prefix || scope.subjectPrefix || '').trim(),
        limit: Math.max(1, Math.min(20, Number.parseInt(String(scope.limit || 5), 10) || 5)),
      },
    };
  }
  throw actionExecutionError('ACTION_NOT_GROUNDED');
}

function groundFeishuActionRequest(request, message = {}) {
  const scope = request.scope && typeof request.scope === 'object' && !Array.isArray(request.scope) ? request.scope : {};
  const target = scope.target && typeof scope.target === 'object' && !Array.isArray(scope.target) ? scope.target : {};
  const args = scope.arguments && typeof scope.arguments === 'object' && !Array.isArray(scope.arguments) ? scope.arguments : {};
  const actionType = String(request.actionType || '');
  const operationKey = String(scope.operationKey || request.requestRef || '').trim();
  const targetId = String(target.id || '').trim();
  const targetType = String(target.type || '').trim();
  const userText = String(message.text || '');
  const currentFeishuTarget = String(message.platform || message.channel || '') === 'feishu'
    && String(message.conversation_id || message.conversationId || '') === targetId;
  if (!operationKey || !targetId || (!userText.includes(targetId) && !currentFeishuTarget)) throw actionExecutionError('ACTION_NOT_GROUNDED');

  let privatePayload;
  if (actionType === 'feishu.message.send') {
    if (scope.expectedEffect !== 'external_send' || !/(?:发|发送|转发|补发|重发)/.test(userText) || !['chat', 'user'].includes(targetType)) {
      throw actionExecutionError('ACTION_NOT_GROUNDED');
    }
    const text = String(args.text || '').trim();
    if (!text || text.length > 16_000) throw actionExecutionError('ACTION_NOT_GROUNDED');
    privatePayload = {
      actionType,
      targetType,
      targetId,
      text,
      identity: 'bot',
    };
  } else {
    if (scope.expectedEffect !== 'persistent_update' || !/(?:更新|修改|补充|追加|写入)/.test(userText) || targetType !== 'document') {
      throw actionExecutionError('ACTION_NOT_GROUNDED');
    }
    privatePayload = {
      actionType,
      targetId,
      command: String(args.command || ''),
      content: args.content === undefined ? undefined : String(args.content),
      pattern: args.pattern === undefined ? undefined : String(args.pattern),
      blockId: args.blockId === undefined ? undefined : String(args.blockId),
      docFormat: args.docFormat === undefined ? undefined : String(args.docFormat),
      identity: 'user',
    };
  }
  const argumentsDigest = digestValue(JSON.stringify({ target, arguments: args, expectedEffect: scope.expectedEffect }));
  privatePayload.argumentsDigest = argumentsDigest;
  return {
    request: {
      requestRef: request.requestRef,
      actionType,
      scope: {
        operationKey,
        target: `${targetType}:${digestValue(targetId).slice(-16)}`,
        argumentsDigest,
        expectedEffect: scope.expectedEffect,
      },
    },
    privatePayload: Object.freeze(privatePayload),
    statusQuestion: isExecutionStatusQuestion(userText),
  };
}

function replayedOperationSummary(request, operation) {
  const completed = operation?.state === 'completed';
  const rejected = operation?.state === 'rejected';
  const status = completed ? operation.status : rejected ? 'rejected' : 'ambiguous';
  return {
    requestRef: request.requestRef,
    actionType: request.actionType,
    outcome: completed && status === 'succeeded' ? 'applied' : status,
    status,
    effectDigest: String(operation?.effectDigest || ''),
    summary: String(operation?.summary || defaultOutcomeSummary(request.actionType, status)),
    target: String(operation?.target || operation?.scope?.target || ''),
    retryable: completed ? operation?.retryable === true : rejected,
    receiptVerified: completed,
    replayed: true,
    ...(operation?.rejectionCode ? { errorCode: operation.rejectionCode } : {}),
  };
}

function trustedReceiptEvidence(summary, operationId) {
  const succeeded = summary.status === 'succeeded';
  return trustActionReceiptEvidence({
    type: actionEvidenceType(summary.actionType),
    ok: succeeded,
    status: succeeded ? 'success' : summary.status,
    receipt_status: summary.status,
    action_type: summary.actionType,
    action_id: operationId,
    result_summary: summary.summary,
    target: summary.target,
    retryable: summary.retryable === true,
    error_code: succeeded ? '' : `EXECUTOR_${String(summary.status || 'FAILED').toUpperCase()}`,
  });
}

function buildNodeActionAcknowledgement(originalReply, receiptSummaries) {
  const outcomes = (Array.isArray(receiptSummaries) ? receiptSummaries : [])
    .filter((item) => ['feishu.message.send', 'feishu.document.update', 'ai_daily_digest.send'].includes(item?.actionType));
  if (outcomes.length === 0) return '';
  const ordinary = stripActionClaimClauses(originalReply);
  const summaries = outcomes.map((item) => String(item.summary || defaultOutcomeSummary(item.actionType, item.status))).filter(Boolean);
  return [ordinary, ...summaries].filter(Boolean).join('\n\n');
}

function stripActionClaimClauses(value) {
  const parts = String(value || '').trim().split(/(?<=[。！？.!])\s*|\n+/).map((item) => item.trim()).filter(Boolean);
  const claim = /(?:已经|已)(?:成功)?(?:发送|发出|补发|更新|修改|保存|写入)|(?:发送|更新|保存)(?:成功|完成|好了)/;
  return parts.map((sentence) => {
    const terminal = /[。！？.!]$/.test(sentence) ? sentence.slice(-1) : '';
    const body = terminal ? sentence.slice(0, -1) : sentence;
    const kept = body.split(/[，,；;]/).map((item) => item.trim()).filter((item) => item && !claim.test(item));
    return kept.length > 0 ? `${kept.join('，')}${terminal}` : '';
  }).filter(Boolean).join('\n\n');
}

function defaultOutcomeSummary(actionType, status) {
  if (actionType === 'feishu.message.send') {
    if (status === 'succeeded') return '飞书消息已发送。';
    if (status === 'ambiguous') return '发送请求已经发出，但当前无法确认是否送达。';
    if (status === 'failed') return '飞书消息发送失败。';
  }
  if (actionType === 'feishu.document.update') {
    if (status === 'succeeded') return '飞书文档已更新。';
    if (status === 'ambiguous') return '文档更新请求已经发出，但当前无法确认最终结果。';
    if (status === 'failed') return '飞书文档更新失败。';
  }
  if (actionType === 'ai_daily_digest.send') {
    if (status === 'succeeded') return '今日日报已补发。';
    if (status === 'ambiguous') return '日报发送请求已经发出，但当前无法确认是否送达。';
    if (status === 'rejected') return '我目前不能确认日报发送已经执行。';
    return '日报生成或发送失败，未确认送达。';
  }
  return '我目前不能确认这一步已经执行。';
}

function isExecutionStatusQuestion(value) {
  const text = String(value || '');
  const explicitEffect = /(?:请|帮我|麻烦|把|再|重新|重发|补发).{0,40}(?:发送|发出|转发|更新|修改|补充|追加|写入)/.test(text)
    || /(?:发送|发出|转发|更新|修改|补充|追加|写入).{0,20}(?:一下|一遍|一次)/.test(text);
  return !explicitEffect && /(?:刚才|之前|那一步|结果|状态|是否|有没有|成功了吗|送达了吗|怎么样|怎么了)|[吗么]\s*[？?]?$/.test(text);
}

function nodeLocalDate(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw actionExecutionError('ACTION_NOT_GROUNDED');
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date).reduce((result, item) => ({ ...result, [item.type]: item.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function rejectedActionSummary(actionType, code) {
  if (code === 'EXECUTOR_UNSUPPORTED') return '这一步当前不受 Node 执行器支持，未执行。';
  if (code === 'ACTOR_NOT_AUTHORIZED') return '这一步未获授权，未执行。';
  return actionType === 'ai_daily_digest.send'
    ? '我目前不能确认日报发送已经执行。'
    : '我目前不能确认这一步已经执行。';
}

function recordRejectedContinuity(operationLedger, { request, actorContext, requestId, conversationDigest, platform, code, summary }) {
  if (typeof operationLedger?.recordRejectedOutcome !== 'function' || !actorContext?.actorKey) return;
  try {
    operationLedger.recordRejectedOutcome({
      requestRef: request.requestRef,
      actionType: request.actionType,
      actorContext,
      binding: { conversationDigest, requestId, platform, attempt: 1, capability: request.actionType },
      code,
      summary,
      retryable: false,
    });
  } catch {
    // A rejected continuity projection must never make the reply path fail open.
  }
}

function hasExplicitMemoryIntent(userText, actionType) {
  const text = String(userText || '');
  if (actionType === 'memory.correct') {
    return /(?:更正|纠正|改正|修正|改成|correct)/i.test(text);
  }
  return /(?:记住|记下|记录|保存|存下|存起来|remember|save)/i.test(text);
}

function normalizeGroundingText(value) {
  return String(value || '').toLowerCase().replace(/[\s，。！？、；：,.!?;:'"“”‘’（）()\[\]{}]/g, '');
}

function actionEvidenceType(actionType) {
  return /(?:^|[._:-])(?:send|post|submit|publish|reply)(?:$|[._:-])/i.test(String(actionType || ''))
    ? 'outbound_result'
    : 'save_result';
}

function digestValue(value) {
  return `sha256:${createHash('sha256').update(String(value || ''), 'utf8').digest('hex')}`;
}

function sanitizeExecutionCode(value) {
  return String(value || 'EXECUTOR_FAILED').toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 80);
}

function actionExecutionError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function normalizeFollowUpMessages(items) {
  return (Array.isArray(items) ? items : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean);
}

async function ingestVisibleExchange({
  message,
  replyText,
  source,
  media,
  imageUrls,
  ingestConfig,
  ingestImpl,
  fetchImpl,
  logger,
  eventId = '',
}) {
  const ingestPayload = {
    channel: message.platform || message.channel || 'wechat',
    sender_id: message.sender_id,
    conversation_id: message.conversation_id || message.conversationId || message.sender_id,
    global_user_id: message.global_user_id || '',
    user_text: message.text,
    reply_text: replyText,
    source,
    image_urls: Array.isArray(imageUrls) ? imageUrls : [],
    media: normalizeMediaItems(media),
    event_id: String(eventId || '').trim(),
  };
  logger.log?.(`[ingest] sender_id_hash=${hashForLog(ingestPayload.sender_id)} text_length=${ingestPayload.user_text?.length || 0} image_urls_count=${ingestPayload.image_urls?.length || 0} media_count=${ingestPayload.media?.length || 0}`);
  if (ingestPayload.media?.length > 0) {
    logger.log?.(`[ingest] media items: ${JSON.stringify(ingestPayload.media.map(m => ({ type: m.type, mimeType: m.mimeType })))}`);
  }
  try {
    await ingestImpl(ingestPayload, {
      config: ingestConfig,
      fetchImpl,
    });
    logger.log?.('[ingest] success');
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    logger.warn?.(`backend ingest skipped: ${messageText}`);
  }
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
  const actorContext = trustedActorContext(message.trusted_actor_context);
  const confirmation = detectConfirmationCommand(message.text);
  const pendingActions = findPendingActionsForConversation(
    { channel, conversationId },
    { env, now, ...(actorContext ? { actorContext } : {}) },
  );

  if (confirmation && pendingActions.length === 0) {
    return { replyText: '确认项已过期或已处理，未执行。', source: 'bridge_pending_action' };
  }
  if (confirmation && pendingActions.length > 1) {
    return { replyText: '存在多个待确认操作，请说明要确认哪一个。', source: 'bridge_pending_action' };
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
      return { replyText: '当前未启用确认执行，操作未执行。', source: 'bridge_pending_action' };
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
      actorContext,
    });
  }

  if (mode !== 'repair' || isScheduledOrDigestMessage(message)) {
    return null;
  }
  const candidate = detectPendingActionCandidate(message);
  if (!candidate) {
    return null;
  }
  if (actorContext && actorContext.owner !== true) {
    return { replyText: '当前身份未获授权执行这项操作，操作未执行。', source: 'bridge_pending_action' };
  }
  if (!canExecutePendingAction(candidate.actionType, options)) {
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
      replyText: execution.replyText || (execution.ok ? '已完成。' : '执行结果显示失败，未执行。'),
      media: execution.media || null,
      source: 'bridge_pending_action',
    };
  }

  const pending = createPendingAction(actionInput, {
    env,
    now,
    ttlMinutes: pendingConfig.ttlMinutes,
    ...(actorContext ? { actorContext } : {}),
  });
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
  return { replyText: confirmationPromptForAction(pending), source: 'bridge_pending_action' };
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
  actorContext,
}) {
  if (confirmation === 'cancel') {
    const cancelled = cancelPendingAction(action.actionId, {
      env,
      now,
      expectedRevision: action.revision,
      ...(actorContext ? { actorContext } : {}),
    });
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
    return { replyText: '已取消，操作未执行。', source: 'bridge_pending_action' };
  }

  const confirmed = confirmPendingAction(action.actionId, {
    env,
    now,
    expectedRevision: action.revision,
    ...(actorContext ? { actorContext } : {}),
  });
  const execution = await executePendingAction(confirmed || action, { options, env, message });
  if (execution.ok) {
    markPendingActionExecuted(action.actionId, execution.evidence, {
      env,
      now,
      expectedRevision: confirmed?.revision,
      ...(actorContext ? { actorContext } : {}),
    });
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
    return {
      replyText: execution.replyText || '已确认并执行。',
      media: execution.media || null,
      source: 'bridge_pending_action',
    };
  }
  markPendingActionFailed(action.actionId, execution.evidence, {
    env,
    now,
    expectedRevision: confirmed?.revision,
    ...(actorContext ? { actorContext } : {}),
  });
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
  return {
    replyText: execution.replyText || '执行结果显示失败，未执行。',
    source: 'bridge_pending_action',
  };
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

function canExecutePendingAction(actionType, options = {}) {
  if (typeof options.pendingActionExecutorImpl === 'function') return true;
  return DEFAULT_PENDING_EXECUTOR_ACTIONS.has(actionType);
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
      replyText: '执行结果显示失败，未执行。',
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
        replyText: '未拿到可安全保存的原始图片，未保存。',
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
        replyText: '未明确指定要删除的表情包编号，未删除。',
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
        replyText: '未明确指定要更新的表情包编号，未更新。',
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
    replyText: '没有可用执行通道，未执行。',
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
    return '是否保存这张图到表情包库？回复“确认保存”即可。';
  }
  if (action.actionType === 'external_send') {
    return '这会向外部对象发送内容。回复“确认发送”后执行，回复“取消”不发送。';
  }
  if (action.actionType === 'sticker_delete') {
    return '是否删除这个表情包？回复“确认删除”即可。';
  }
  if (action.actionType === 'sticker_update') {
    return '是否更新这个表情包？回复“确认”即可。';
  }
  return '这个操作需要确认。回复“确认”后执行。';
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

async function stopAutonomyActivityFromNaturalCommand({ text, requestId, actorContext, activityFacade }) {
  if (!actorContext?.owner || !activityFacade || typeof activityFacade.handle !== 'function') return null;
  try {
    const result = await activityFacade.handle({
      requestRef: `stop_${String(requestId || '').replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 64) || 'activity'}`,
      command: 'stop',
      goal: String(text || '').trim(),
    }, actorContext);
    if (result?.action === 'clarify') return String(result.message || '我找到了多个进行中的目标，请说明要停止哪一个。');
    if (result?.action === 'stopped' || result?.action === 'stopped_all') return '已经停止这项外部活动。';
    if (result?.action === 'noop') return '当前没有可停止的外部活动。';
  } catch {
    return '外部活动未能停止，已保持原状。';
  }
  return null;
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
