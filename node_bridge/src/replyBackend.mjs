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
import {
  createTrustedBridgeTask,
  isTrustedHermesTaskScopedMessage,
  isTrustedInformationalReportTask,
  preserveTrustedBridgeTaskProvenance,
} from './hermesTaskScope.mjs';
import { normalizePlatform } from './identityMap.mjs';
import { createOperationLedger } from './operationLedger.mjs';
import { digestActionScope } from './actionRequest.mjs';
import { createCoreDurableJobExecutor } from './coreDurableJobExecutor.mjs';
import { createTrustedExecutorAdapters } from './trustedExecutorAdapters.mjs';
import { createPersonalLearningExecutorAdapter } from './personalLearningClient.mjs';
import { createAiDailyDigestExecutorAdapter } from './aiDailyDigestClient.mjs';
import { createTodoExecutorAdapter, normalizeTodoCreateScope } from './todoClient.mjs';
import {
  createFeishuCalendarExecutorAdapter,
  normalizeFeishuCalendarCreateScope,
} from './feishuCalendarClient.mjs';
import {
  createFeishuDocumentWriteExecutorAdapter,
  createFeishuMinutesDocumentExecutorAdapter,
} from './feishuMinutesDocumentClient.mjs';
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
  const operationLedger = options.operationLedger || createOperationLedger({ env });
  const configuredExecutorAdapters = Array.isArray(options.trustedExecutorAdapterConfigs)
    ? [...options.trustedExecutorAdapterConfigs]
    : [];
  if (!options.trustedActionExecutors && String(env.RAN_AGENT_INTERNAL_CONTROL_SECRET || '').trim()) {
    configuredExecutorAdapters.push(createTodoExecutorAdapter({
      env,
      fetchImpl: options.fetchImpl || globalThis.fetch,
    }));
    configuredExecutorAdapters.push(createPersonalLearningExecutorAdapter({
      env,
      fetchImpl: options.fetchImpl || globalThis.fetch,
    }));
    configuredExecutorAdapters.push(createAiDailyDigestExecutorAdapter({ env, fetchImpl: options.fetchImpl || globalThis.fetch }));
  }
  if (!options.trustedActionExecutors) {
    configuredExecutorAdapters.push(createFeishuCalendarExecutorAdapter({
      env,
      execFileImpl: options.execFileImpl,
    }));
    configuredExecutorAdapters.push(createFeishuMinutesDocumentExecutorAdapter({
      env,
      execFileImpl: options.execFileImpl,
    }));
    configuredExecutorAdapters.push(createFeishuDocumentWriteExecutorAdapter({
      env,
      execFileImpl: options.execFileImpl,
    }));
  }
  const trustedActionExecutors = options.trustedActionExecutors || createTrustedExecutorAdapters({
    ledger: operationLedger,
    adapters: configuredExecutorAdapters,
  });
  const coreDurableJobExecutor = options.coreDurableJobExecutor || createCoreDurableJobExecutor({
    env,
    fetchImpl: options.fetchImpl || globalThis.fetch,
    createJob: options.createDurableJobImpl,
  });
  const activityFacade = options.activityFacade || null;

  return {
    async getReply(message, backendOptions = {}) {
      const platform = normalizePlatform(message.platform || message.channel);
      message = preserveTrustedBridgeTaskProvenance(message, { ...message, platform, channel: platform });
      const gatewayConfig = backendOptions.hermesConfig || getHermesGatewayConfig(env);
      const chatImpl = options.hermesImpl || options.chatImpl || sendChatToHermesGateway;
      const requestId = sanitizeRequestId(backendOptions.requestId || message.request_id || createRequestId());
      const taskScoped = isTrustedHermesTaskScopedMessage(message);
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
      const hermesInput = preserveTrustedBridgeTaskProvenance(message, {
        text: message.text,
        sender_id: message.sender_id,
        conversation_id: message.conversation_id || message.conversationId || message.sender_id,
        channel: message.platform,
        platform: message.platform,
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
        trusted_frontend_context: trustedFrontendContext(message.trusted_frontend_context, platform),
      });
      const hermesOptions = {
        config: gatewayConfig,
        fetchImpl: backendOptions.fetchImpl,
        execFileImpl: backendOptions.execFileImpl,
        env,
        logger: options.logger || console,
        mediaContextOptions: backendOptions.mediaContextOptions,
        requestId,
      };
      let response = await chatImpl(hermesInput, hermesOptions);

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
      if (response?.envelope_error_code === 'HERMES_PRIVATE_REPLY_ENVELOPE_INVALID'
        && hasCalendarCreateIntent(message.text)
        && !/(?:待办|todo)/i.test(String(message.text || ''))) {
        try {
          const replanned = await chatImpl({
            ...hermesInput,
            continuity_note: [
              hermesInput.continuity_note,
              'NODE_ACTION_REPLAN: The previous reply envelope failed strict validation. Return exactly one feishu.calendar.create actionRequest whose scope contains only title, date (YYYY-MM-DD), startTime/endTime (HH:MM) and reminderMinutes (integer). Never use schedule.create; never add id, actor, authorization, receipt, effect, reminderTime or reminderAt fields; the bridge owns timezone, IDs and verification. Do not call tools.',
            ].filter(Boolean).join('\n'),
          }, hermesOptions);
          const replannedRequest = extractCalendarReplanRequest(replanned);
          replyEnvelope = Object.freeze({
            ...replyEnvelope,
            actionRequests: Object.freeze([replannedRequest]),
          });
        } catch (error) {
          loggerFor(options).warn?.(`calendar action replan rejected code=${String(error?.code || 'ACTION_REPLAN_FAILED')}`);
          replyEnvelope = Object.freeze({ ...replyEnvelope, actionRequests: Object.freeze([]) });
        }
      }
      if (hasFeishuMinutesToDocIntent(message.text)
        && replyEnvelope.actionRequests.length === 0
        && replyEnvelope.activityRequest === null
        && replyEnvelope.commitments.length === 0
        && replyEnvelope.claims.length === 0) {
        try {
          const replanInstruction = 'NODE_ACTION_REPLAN: The previous Feishu Minutes reply provided no valid executable action request. Read the existing transcript again if needed, but do not create a document with a tool. Return exactly one actionRequest with only requestRef, actionType "feishu.minutes_to_doc", and scope. Scope must contain only minuteTitle, folderTitle, documentTitle, and a single-line rootless text-only contentXml under 1800 characters. Never add id, actor, authorization, receipt, effect, or private fields; the bridge creates and verifies the document.';
          const replanned = await chatImpl(createTrustedBridgeTask({
            ...hermesInput,
            id: `${message.id || requestId}:minutes-action-replan`,
            message_id: `${message.id || requestId}:minutes-action-replan`,
            text: [hermesInput.text, replanInstruction].filter(Boolean).join('\n'),
            route_hint: 'action_gate_repair',
            continuity_note: '',
          }, 'action_gate_repair'), hermesOptions);
          const replannedRequest = extractMinutesReplanRequest(replanned);
          replyEnvelope = Object.freeze({
            ...replyEnvelope,
            actionRequests: Object.freeze([replannedRequest]),
          });
        } catch (error) {
          loggerFor(options).warn?.(`Minutes action replan rejected code=${String(error?.code || 'ACTION_REPLAN_FAILED')}`);
          replyEnvelope = Object.freeze({ ...replyEnvelope, actionRequests: Object.freeze([]) });
        }
      }
      const informationalReportPolicy = restrictInformationalReportEnvelope(replyEnvelope, message);
      replyEnvelope = informationalReportPolicy.envelope;

      let actionExecution = await executeEnvelopeActionRequests({
        actionRequests: replyEnvelope.actionRequests,
        actorContext: trustedActorContext(message.trusted_actor_context),
        currentMessage: message,
        operationLedger,
        trustedActionExecutors,
        coreDurableJobExecutor,
        todoTimeZone: env.HERMES_ENVIRONMENT_TIMEZONE || 'Asia/Shanghai',
      });
      if (shouldReplanDocumentAction(replyEnvelope, actionExecution)) {
        try {
          const replanned = await chatImpl({
            ...hermesInput,
            continuity_note: [
              hermesInput.continuity_note,
              'NODE_ACTION_REPLAN: The previous Feishu action type described a Minutes recipe, but the owner requested a non-Minutes document. Reuse the gathered content and return one document.write actionRequest using the documented Feishu schema. Do not repeat research or call tools.',
            ].filter(Boolean).join('\n'),
          }, hermesOptions);
          const replannedRequest = extractDocumentReplanRequest(replanned);
          actionExecution = await executeEnvelopeActionRequests({
            actionRequests: [replannedRequest],
            actorContext: trustedActorContext(message.trusted_actor_context),
            currentMessage: message,
            operationLedger,
            trustedActionExecutors,
            coreDurableJobExecutor,
            todoTimeZone: env.HERMES_ENVIRONMENT_TIMEZONE || 'Asia/Shanghai',
          });
          replyEnvelope = Object.freeze({
            ...replyEnvelope,
            actionRequests: Object.freeze([replannedRequest]),
          });
        } catch (error) {
          loggerFor(options).warn?.(`document action replan rejected code=${String(error?.code || 'ACTION_REPLAN_FAILED')}`);
          actionExecution = rejectedDocumentReplanExecution(replyEnvelope.actionRequests[0]);
          replyEnvelope = Object.freeze({ ...replyEnvelope, actionRequests: Object.freeze([]) });
        }
      }
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
      const digestReceipt = actionExecution.receiptSummaries.find((receipt) => receipt?.actionType === 'ai_daily_digest.send');
      const digestAcknowledgement = digestReceipt?.status === 'succeeded'
        ? /^\d{4}-\d{2}-\d{2}$/.test(digestReceipt.digestDate)
          ? `${digestReceipt.digestDate} 日报已补发。`
          : '今日日报已补发。'
        : digestReceipt ? '日报生成或发送失败，未确认送达。' : '';
      const feishuDocumentAcknowledgement = buildFeishuDocumentAcknowledgement(actionExecution.receiptSummaries);
      const feishuCalendarAcknowledgement = buildFeishuCalendarAcknowledgement(actionExecution.receiptSummaries);
      const todoAcknowledgement = buildTodoAcknowledgement(actionExecution.receiptSummaries);
      const coreAcknowledgement = commitmentBlocked
        ? ''
        : bridgeOwnedCoreAcknowledgement(replyEnvelope.commitments, durableReceiptSummaries);
      if (commitmentBlocked) {
        response = { ...response, reply_text: '这项后续工作尚未启动。', follow_up_messages: [] };
      } else if (learningPromotionDenied) {
        response = { ...response, reply_text: '保存结果尚未返回，未写入长期记忆。', follow_up_messages: [] };
      } else if (todoAcknowledgement.text) {
        response = { ...response, reply_text: todoAcknowledgement.text, follow_up_messages: [] };
      } else if (coreAcknowledgement) {
        response = { ...response, reply_text: coreAcknowledgement, follow_up_messages: [] };
      } else if (digestAcknowledgement) {
        response = { ...response, reply_text: digestAcknowledgement, follow_up_messages: [] };
      } else if (feishuCalendarAcknowledgement.text) {
        response = { ...response, reply_text: feishuCalendarAcknowledgement.text, follow_up_messages: [] };
      } else if (feishuDocumentAcknowledgement.text) {
        response = { ...response, reply_text: feishuDocumentAcknowledgement.text, follow_up_messages: [] };
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
        : todoAcknowledgement.text
          ? todoAcknowledgement.source
        : digestAcknowledgement
          ? 'bridge_ai_daily_digest'
        : feishuCalendarAcknowledgement.text
          ? feishuCalendarAcknowledgement.source
        : feishuDocumentAcknowledgement.text
          ? feishuDocumentAcknowledgement.source
        : coreAcknowledgement
          ? 'bridge_core_job_ack'
          : 'hermes';
      if (actionGateConfig.enabled) {
        let rawContractReplyText = response.reply_text;
        let contract = evaluateActionContract({
          requestId,
          channel: message.platform,
          conversationId: message.conversation_id || message.conversationId || message.sender_id,
          profile: gatewayConfig.profile || response.profile || response.model || '',
          message,
          response: { ...response, media: finalResponseMedia, reply_text: rawContractReplyText },
          actionRequests: replyEnvelope.actionRequests,
          toolResults: actionExecution.evidence,
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
              channel: message.platform,
              conversationId: message.conversation_id || message.conversationId || message.sender_id,
              profile: gatewayConfig.profile || response.profile || response.model || '',
              message,
              response: { ...response, media: contractRepairMedia, reply_text: rawContractReplyText },
              actionRequests: replyEnvelope.actionRequests,
              toolResults: [...actionExecution.evidence, ...repair.toolResults],
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
            channel: message.platform,
            conversationId: message.conversation_id || message.conversationId || message.sender_id,
            profile: gatewayConfig.profile || response.profile || response.model || '',
            message,
            response: { ...response, media: finalResponseMedia, reply_text: followUpText },
            actionRequests: replyEnvelope.actionRequests,
            toolResults: actionExecution.evidence,
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
      if (!taskScoped && !excludeFromHistory && !suppression.suppress) {
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
        provider: 'hermes',
        model: String(gatewayConfig.profile || response.profile || response.model || 'unspecified'),
        suppressSend: suppression.suppress,
        suppressReason: suppression.reason,
        excludeFromHistory,
        backendProjection,
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

function trustedFrontendContext(value, expectedPlatform) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const currentFrontend = normalizePlatform(value.currentFrontend);
  const currentChannelType = String(value.currentChannelType || '').trim().toLowerCase();
  if (currentFrontend !== expectedPlatform || !['dm', 'group', 'desktop'].includes(currentChannelType)) return null;
  return Object.freeze({
    currentFrontend,
    currentChannelType,
    ownerVerified: value.ownerVerified === true,
  });
}

function shouldReplanDocumentAction(envelope, actionExecution) {
  return envelope?.actionRequests?.length === 1
    && !envelope.activityRequest
    && envelope.commitments?.length === 0
    && actionExecution?.receiptSummaries?.length === 1
    && actionExecution.receiptSummaries[0]?.outcome === 'needs_replan';
}

function extractDocumentReplanRequest(candidate) {
  const envelope = normalizeReplyEnvelope(candidate);
  if (envelope.actionRequests.length !== 1
    || envelope.actionRequests[0]?.actionType !== 'document.write'
    || envelope.activityRequest !== null
    || envelope.commitments.length !== 0
    || envelope.claims.length !== 0) {
    throw actionExecutionError('DOCUMENT_REPLAN_INVALID');
  }
  return envelope.actionRequests[0];
}

function extractCalendarReplanRequest(candidate) {
  const envelope = normalizeReplyEnvelope(candidate);
  if (envelope.actionRequests.length !== 1
    || envelope.actionRequests[0]?.actionType !== 'feishu.calendar.create'
    || envelope.activityRequest !== null
    || envelope.commitments.length !== 0
    || envelope.claims.length !== 0) {
    throw actionExecutionError('CALENDAR_REPLAN_INVALID');
  }
  return envelope.actionRequests[0];
}

function extractMinutesReplanRequest(candidate) {
  const envelope = normalizeReplyEnvelope(candidate);
  if (envelope.actionRequests.length !== 1
    || envelope.actionRequests[0]?.actionType !== 'feishu.minutes_to_doc'
    || envelope.activityRequest !== null
    || envelope.commitments.length !== 0
    || envelope.claims.length !== 0) {
    throw actionExecutionError('MINUTES_REPLAN_INVALID');
  }
  return envelope.actionRequests[0];
}

function rejectedDocumentReplanExecution(originalRequest) {
  return Object.freeze({
    receiptSummaries: Object.freeze([Object.freeze({
      requestRef: String(originalRequest?.requestRef || 'document-replan'),
      actionType: 'document.write',
      outcome: 'denied',
      status: 'failed',
      errorCode: 'ACTION_NOT_GROUNDED',
    })]),
    evidence: Object.freeze([]),
  });
}

async function executeEnvelopeActionRequests({
  actionRequests = [],
  actorContext,
  currentMessage,
  operationLedger,
  trustedActionExecutors,
  coreDurableJobExecutor,
  todoTimeZone = 'Asia/Shanghai',
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
      receiptSummaries.push({
        requestRef: request.requestRef,
        actionType: request.actionType,
        outcome: 'denied',
        status: 'failed',
        errorCode: 'ACTOR_NOT_AUTHORIZED',
      });
      continue;
    }
    let groundedRequest;
    try {
      groundedRequest = groundActionRequest(request, currentMessage, { todoTimeZone });
    } catch (error) {
      const needsReplan = error?.code === 'ACTION_NEEDS_REPLAN';
      receiptSummaries.push({
        requestRef: request.requestRef,
        actionType: request.actionType,
        outcome: needsReplan ? 'needs_replan' : 'denied',
        status: 'failed',
        errorCode: sanitizeExecutionCode(error?.code || 'ACTION_NOT_GROUNDED'),
      });
      continue;
    }
    if (!trustedActionExecutors.supports(groundedRequest.actionType)) {
      receiptSummaries.push({
        requestRef: request.requestRef,
        actionType: request.actionType,
        outcome: 'unsupported',
        status: 'failed',
        errorCode: 'EXECUTOR_UNSUPPORTED',
      });
      continue;
    }
    try {
      if (groundedRequest.actionType === 'document.write' && typeof operationLedger.findByCausation === 'function') {
        const prior = operationLedger.findByCausation({ request: groundedRequest, actorContext });
        if (prior) {
          if (prior.scopeDigest !== digestActionScope(groundedRequest.scope)) {
            receiptSummaries.push({
              requestRef: request.requestRef,
              actionType: request.actionType,
              outcome: 'denied',
              status: 'failed',
              errorCode: 'DOCUMENT_REPLAY_CONFLICT',
              replayed: true,
            });
            continue;
          }
          receiptSummaries.push(replayedDocumentWriteSummary(request, prior));
          continue;
        }
      }
      const operation = operationLedger.mint({ request: groundedRequest, actorContext });
      const receipt = await trustedActionExecutors.execute(operation);
      const verified = trustedActionExecutors.verifyReceipt(receipt, {
        operationId: operation.operationId,
        actorKey: operation.actorKey,
        actionType: operation.actionType,
        scopeDigest: operation.scopeDigest,
        issuer: receipt.issuer,
        status: receipt.status,
        evidenceType: receipt.evidenceType,
      });
      if (verified.ok !== true) throw actionExecutionError('RECEIPT_VERIFICATION_FAILED');
      const succeeded = receipt.status === 'succeeded';
      receiptSummaries.push({
        requestRef: request.requestRef,
        actionType: request.actionType,
        outcome: succeeded ? 'applied' : receipt.status,
        status: receipt.status,
        effectDigest: receipt.effectDigest,
        ...(request.actionType === 'todo.create' && succeeded
          ? { todo: normalizeTodoCreateScope(request.scope, { timeZone: todoTimeZone }) }
          : {}),
        ...(request.actionType === 'feishu.calendar.create' && succeeded
          ? { calendar: normalizeFeishuCalendarCreateScope(request.scope, { timeZone: todoTimeZone }) }
          : {}),
        ...(request.actionType === 'ai_daily_digest.send' && succeeded
          ? { digestDate: String(request.scope?.date || '') }
          : {}),
        ...(request.actionType === 'document.write' && receipt.status === 'ambiguous'
          ? { errorCode: 'DOCUMENT_OUTCOME_AMBIGUOUS' }
          : request.actionType === 'document.write' && receipt.status === 'failed'
            ? { errorCode: 'DOCUMENT_READBACK_FAILED' }
            : {}),
      });
      evidence.push(trustActionReceiptEvidence({
        type: actionEvidenceType(request.actionType),
        ok: succeeded,
        status: succeeded ? 'success' : 'failure',
        action_id: receipt.operationId,
        error_code: succeeded ? '' : `EXECUTOR_${receipt.status.toUpperCase()}`,
      }));
    } catch (error) {
      receiptSummaries.push({
        requestRef: request.requestRef,
        actionType: request.actionType,
        outcome: 'failed',
        status: 'failed',
        errorCode: sanitizeExecutionCode(error?.cause?.code || error?.code || 'EXECUTOR_FAILED'),
      });
    }
  }
  return Object.freeze({
    receiptSummaries: Object.freeze(receiptSummaries.map((item) => Object.freeze(item))),
    evidence: Object.freeze(evidence),
  });
}

function replayedDocumentWriteSummary(request, operation) {
  if (operation.state === 'completed') {
    const status = String(operation.status || 'ambiguous');
    return {
      requestRef: request.requestRef,
      actionType: request.actionType,
      outcome: status === 'succeeded' ? 'applied' : status,
      status,
      effectDigest: String(operation.effectDigest || ''),
      replayed: true,
      ...(status === 'ambiguous'
        ? { errorCode: 'DOCUMENT_OUTCOME_AMBIGUOUS' }
        : status === 'failed'
          ? { errorCode: 'DOCUMENT_READBACK_FAILED' }
          : {}),
    };
  }
  if (operation.state === 'rejected') {
    return {
      requestRef: request.requestRef,
      actionType: request.actionType,
      outcome: 'failed',
      status: 'failed',
      errorCode: 'DOCUMENT_EXECUTION_FAILED',
      replayed: true,
    };
  }
  return {
    requestRef: request.requestRef,
    actionType: request.actionType,
    outcome: 'ambiguous',
    status: 'ambiguous',
    errorCode: 'DOCUMENT_OUTCOME_AMBIGUOUS',
    replayed: true,
  };
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

function buildFeishuDocumentAcknowledgement(receiptSummaries = []) {
  const receipt = receiptSummaries.find((item) => ['document.write', 'feishu.minutes_to_doc'].includes(item?.actionType));
  if (!receipt) return { text: '', source: '' };
  const source = receipt.actionType === 'document.write'
    ? 'bridge_feishu_document_write'
    : 'bridge_feishu_minutes_document';
  if (receipt.status === 'succeeded') {
    return {
      text: receipt.actionType === 'document.write'
        ? '云文档已写入并通过回读确认。'
        : '已整理成云文档并放入目标文件夹。',
      source,
    };
  }
  if (receipt.outcome === 'needs_replan') {
    return { text: '文档请求的执行类型仍未匹配，尚未执行。', source };
  }
  if (receipt.status === 'ambiguous' || receipt.errorCode === 'DOCUMENT_OUTCOME_AMBIGUOUS') {
    return { text: '文档写入结果不确定；为避免重复创建，不会自动重试。', source };
  }
  if (receipt.errorCode === 'DOCUMENT_READBACK_FAILED') {
    return { text: '文档操作已执行，但回读校验失败，暂不确认内容完成。', source };
  }
  if (receipt.errorCode === 'FEISHU_FOLDER_MATCH_AMBIGUOUS') {
    return { text: '目标文件夹未能唯一匹配，未执行文档写入。', source };
  }
  if (['ACTION_NOT_GROUNDED', 'ACTOR_NOT_AUTHORIZED'].includes(receipt.errorCode)) {
    return { text: '文档写入在执行前被拒绝，未创建或修改文档。', source };
  }
  if (receipt.errorCode === 'DOCUMENT_REPLAY_CONFLICT') {
    return { text: '同一请求的文档内容发生变化，未再次写入。', source };
  }
  return { text: '文档写入执行失败，未确认已创建或修改。', source };
}

function buildTodoAcknowledgement(receiptSummaries = []) {
  const receipt = receiptSummaries.find((item) => item?.actionType === 'todo.create');
  if (!receipt) return { text: '', source: '' };
  if (receipt.status !== 'succeeded' || !receipt.todo) {
    return { text: '提醒创建失败，未确认已保存。', source: 'bridge_todo_create' };
  }
  const { title, date, startTime, endTime, reminderAt } = receipt.todo;
  return {
    text: `已创建待办“${title}”：${date} ${startTime}–${endTime}，将在 ${reminderAt.slice(0, 16)} 提醒。`,
    source: 'bridge_todo_create',
  };
}

function buildFeishuCalendarAcknowledgement(receiptSummaries = []) {
  const receipt = receiptSummaries.find((item) => item?.actionType === 'feishu.calendar.create');
  if (!receipt) return { text: '', source: '' };
  if (receipt.status !== 'succeeded' || !receipt.calendar) {
    return { text: '飞书日程创建或校验失败，未确认已写入日历。', source: 'bridge_feishu_calendar_create' };
  }
  const { title, date, startTime, endTime, reminderMinutes } = receipt.calendar;
  return {
    text: `已写入飞书日历并校验：“${title}”，${date} ${startTime}–${endTime}，提前 ${reminderMinutes} 分钟提醒。`,
    source: 'bridge_feishu_calendar_create',
  };
}

function isActiveDurableReceipt(receipt, expected = {}) {
  if (!receipt || typeof receipt !== 'object') return false;
  if (String(receipt.status || '') !== 'active'
    || !/^[A-Za-z0-9_.:-]{8,160}$/.test(String(receipt.jobId || ''))
    || !/^[a-f0-9]{32,128}$/.test(String(receipt.goalDigest || ''))) return false;
  return Object.entries(expected).every(([field, value]) => value === undefined || receipt[field] === value);
}

function groundActionRequest(request, message = {}, { todoTimeZone = 'Asia/Shanghai' } = {}) {
  const actionType = String(request.actionType || '');
  if (actionType === 'todo.create') {
    const userText = String(message.text || '');
    if (!/(?:提醒|待办|remind|todo)/i.test(userText)
      || (hasCalendarCreateIntent(userText) && !/(?:待办|todo)/i.test(userText))) {
      throw actionExecutionError('ACTION_NOT_GROUNDED');
    }
    const scope = normalizeTodoCreateScope(request.scope, { timeZone: todoTimeZone });
    return {
      ...request,
      scope: {
        title: scope.title,
        date: scope.date,
        startTime: scope.startTime,
        endTime: scope.endTime,
        reminderMinutes: scope.reminderMinutes,
      },
    };
  }
  if (actionType === 'feishu.calendar.create') {
    const userText = String(message.text || '');
    if (!hasCalendarCreateIntent(userText)) {
      throw actionExecutionError('ACTION_NOT_GROUNDED');
    }
    const scope = normalizeFeishuCalendarCreateScope(request.scope, { timeZone: todoTimeZone });
    return {
      ...request,
      scope: {
        title: scope.title, date: scope.date, startTime: scope.startTime,
        endTime: scope.endTime, reminderMinutes: scope.reminderMinutes,
      },
    };
  }
  if (actionType === 'feishu.minutes_to_doc') {
    const scope = request.scope && typeof request.scope === 'object' && !Array.isArray(request.scope) ? request.scope : {};
    const userText = String(message.text || '');
    const minuteTitle = String(scope.minuteTitle || '').trim();
    const folderTitle = String(scope.folderTitle || '').trim();
    if (!/(?:妙记|录音稿|文字稿|录音转文字)/.test(userText)) {
      if (/(?:飞书|云文档|文档)/.test(userText)
        && /(?:网页|博客|论文|文章|资料|笔记|总结|整理)/.test(userText)) {
        throw actionExecutionError('ACTION_NEEDS_REPLAN');
      }
      throw actionExecutionError('ACTION_NOT_GROUNDED');
    }
    if (!/(?:云文档|文档)/.test(userText)
      || !minuteTitle || !folderTitle
      || !normalizeGroundingText(userText).includes(normalizeGroundingText(minuteTitle))
      || !normalizeGroundingText(userText).includes(normalizeGroundingText(folderTitle))) {
      throw actionExecutionError('ACTION_NOT_GROUNDED');
    }
    return {
      ...request,
      scope: {
        minuteTitle,
        folderTitle,
        documentTitle: String(scope.documentTitle || '').trim(),
        contentXml: String(scope.contentXml || '').trim(),
      },
    };
  }
  if (actionType === 'document.write') {
    return groundDocumentWriteRequest(request, message);
  }
  if (actionType === 'ai_daily_digest.send') {
    const scope = request.scope && typeof request.scope === 'object' && !Array.isArray(request.scope) ? request.scope : {};
    const userText = String(message.text || '');
    if (!/(日报|简报|摘要)/.test(userText) || !/(发|补发|重发|重新|再)/.test(userText) || scope.mode !== 'manual') throw actionExecutionError('ACTION_NOT_GROUNDED');
    const requestedDate = String(scope.date || 'current_local_date');
    if (!['current_local_date', 'today'].includes(requestedDate) && !/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) {
      throw actionExecutionError('ACTION_NOT_GROUNDED');
    }
    return { ...request, scope: { mode: 'manual', date: requestedDate } };
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
    const expectedKeys = actionType === 'memory.remember'
      ? 'kind|statement|subject_key'
      : 'statement|subject_key';
    if (Object.keys(scope).sort().join('|') !== expectedKeys) {
      throw actionExecutionError('ACTION_NOT_GROUNDED');
    }
    const statement = String(scope.statement || '').trim();
    const normalizedStatement = normalizeGroundingText(statement);
    const normalizedUserText = normalizeGroundingText(userText);
    if (normalizedStatement.length < 2 || !normalizedUserText.includes(normalizedStatement)) {
      throw actionExecutionError('ACTION_NOT_GROUNDED');
    }
    const kind = actionType === 'memory.correct' ? 'correction' : String(scope.kind || '');
    const subjectKey = normalizeMemorySubjectKey(scope.subject_key, kind);
    return {
      ...request,
      scope: {
        kind,
        subject_key: subjectKey,
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
    if (Object.keys(scope).sort().join('|') !== 'subject_key') throw actionExecutionError('ACTION_NOT_GROUNDED');
    return {
      ...request,
      scope: { subject_key: normalizeMemorySubjectKey(scope.subject_key, 'correction') },
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

function hasCalendarCreateIntent(value) {
  return /(?:加到|加入|写进).*(?:日程|日历)|(?:建|创建|新建).*(?:日程|日历)|(?:我|本人).*(?:有.{0,20}(?:活动|安排)|要参加)|\d{1,2}(?::|点)\d{0,2}.{0,60}(?:活动|安排)/i.test(String(value || ''));
}

function hasFeishuMinutesToDocIntent(value) {
  const text = String(value || '');
  return /(?:妙记|录音稿|文字稿|录音转文字)/.test(text)
    && /(?:云文档|文档)/.test(text);
}

function groundDocumentWriteRequest(request, message = {}) {
  const scope = request.scope && typeof request.scope === 'object' && !Array.isArray(request.scope) ? request.scope : {};
  const target = scope.target && typeof scope.target === 'object' && !Array.isArray(scope.target) ? scope.target : {};
  const userText = String(message.text || '');
  const operation = String(scope.operation || '');
  const provider = String(scope.provider || '');
  const documentTitle = String(target.documentTitle || '').trim();
  const contentXml = String(scope.contentXml || '').trim();
  const sourceMessageId = String(message.id || message.message_id || message.request_id || '').trim();
  if (provider !== 'feishu'
    || !['create', 'update'].includes(operation)
    || !/(?:飞书|云文档|文档)/.test(userText)
    || !documentTitle
    || !sourceMessageId) {
    throw actionExecutionError('ACTION_NOT_GROUNDED');
  }
  const groundedTarget = operation === 'create'
    ? { folderTitle: String(target.folderTitle || '').trim(), documentTitle }
    : { documentId: String(target.documentId || '').trim(), documentTitle };
  const exactTarget = operation === 'create' ? groundedTarget.folderTitle : groundedTarget.documentId;
  if (!exactTarget
    || !normalizeGroundingText(userText).includes(normalizeGroundingText(exactTarget))) {
    throw actionExecutionError('ACTION_NOT_GROUNDED');
  }
  validateDocumentContent(contentXml, documentTitle);
  const sourceRefs = normalizeDocumentSourceRefs(scope.sourceRefs);
  const hash = `sha256:${createHash('sha256').update(contentXml, 'utf8').digest('hex')}`;
  const contentRef = `inline:${hash}`;
  const causationRef = `source:sha256:${createHash('sha256').update(sourceMessageId, 'utf8').digest('hex')}`;
  return {
    ...request,
    payloadRef: contentRef,
    scope: {
      provider,
      operation,
      target: groundedTarget,
      content: { format: 'docx_xml', ref: contentRef, hash, body: contentXml },
      causationRef,
      ...(sourceRefs.length ? { sourceRefs } : {}),
    },
  };
}

function normalizeDocumentSourceRefs(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 16) throw actionExecutionError('ACTION_NOT_GROUNDED');
  return value.map((item) => {
    const ref = String(item || '').trim();
    if (!ref || ref.length > 240 || /[\r\n\t\0]/.test(ref)) throw actionExecutionError('ACTION_NOT_GROUNDED');
    return ref;
  });
}

function validateDocumentContent(contentXml, documentTitle) {
  if (contentXml.length < 40
    || contentXml.length > 2_000
    || Buffer.byteLength(contentXml, 'utf8') > 7_000
    || contentXml.includes('\0')
    || /<\/?(?:root|content)\b|<(?:img|source|whiteboard|sheet|task|chat_card)\b/i.test(contentXml)) {
    throw actionExecutionError('ACTION_NOT_GROUNDED');
  }
  const escapedTitle = documentTitle.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  if (!contentXml.includes(`<title>${escapedTitle}</title>`)) throw actionExecutionError('ACTION_NOT_GROUNDED');
}

function normalizeMemorySubjectKey(value, kind) {
  const subjectKey = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_.-]*:[a-z0-9][a-z0-9_.:-]*$/.test(subjectKey) || subjectKey.length > 120) {
    throw actionExecutionError('ACTION_NOT_GROUNDED');
  }
  const prefix = subjectKey.split(':', 1)[0];
  const preferencePrefixes = ['communication', 'environment', 'food', 'hobby', 'preference', 'reply', 'style'];
  if ((kind === 'routine' && prefix !== 'routine')
    || (kind === 'relationship' && !['person', 'relationship'].includes(prefix))
    || (kind === 'operating_lesson' && !['operating', 'reply_rule'].includes(prefix))
    || (kind === 'preference' && !preferencePrefixes.includes(prefix))
    || !['preference', 'relationship', 'routine', 'operating_lesson', 'correction'].includes(kind)) {
    throw actionExecutionError('ACTION_NOT_GROUNDED');
  }
  return subjectKey;
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
    channel: message.platform,
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
  const channel = message.platform;
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
