/**
 * Local-only outbound server for proactive messages sent from the Python scheduler.
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';

import { handleIncomingMessage } from './channelHub.mjs';
import { createTrustedBridgeInformationalReportTask } from './hermesTaskScope.mjs';
import { saveSensorLoggerMessage } from './environmentSense.mjs';
import {
  buildExternalMcpSyntheticTurn,
  evaluateExternalMcpSystemQueueEgress,
} from './externalMcp/systemQueue.mjs';
import {
  commitExternalMcpNotificationReservation,
  listExternalMcpWatches,
  releaseExternalMcpNotificationReservation,
  reserveExternalMcpNotification,
} from './externalMcp/watchlist.mjs';
import { verifyExternalMcpEvidenceRefs } from './externalMcp/evidenceLog.mjs';
import { sendFeishuReply } from './feishuBridge.mjs';
import { runHermesLiteSoftReset } from './hermesSessionMaintenance.mjs';
import { createDurableOutbox } from './durableOutbox.mjs';
import { createCoreReminderService } from './core/coreReminderService.mjs';
import { legacyReminderInstant } from './core/coreScheduleMigration.mjs';
import {
  presentationTarget,
  resolveActiveOwnerPresentationBinding,
} from './core/ownerPresentationBinding.mjs';
import {
  commitProactiveEventDelivery,
  releaseProactiveEventDelivery,
  reserveProactiveEventDelivery,
} from './proactiveEventLedger.mjs';
import {
  buildProactiveSyntheticTurn,
  evaluateProactiveAdmission,
  evaluateProactiveEgress,
  isTruthyEnv,
  normalizeProactiveEvent,
} from './proactiveEvents.mjs';
import {
  getFeishuHomeDmTarget,
  resolveStateDir,
} from './runtimeState.mjs';
export { resolveStateDir } from './runtimeState.mjs';

const HERMES_LITE_SOFT_RESET_CONTROL_ROUTE = '/control/hermes-lite-soft-reset';
const AI_DAILY_DIGEST_CONTROL_ROUTE = '/scheduled/ai-daily-digest';
const CORE_REMINDER_REGISTER_ROUTE = '/internal/core/reminders/register';
const PROACTIVE_EVENT_CONTROL_ROUTE = '/proactive/event';

function normalizeAccountId(raw) {
  return String(raw).trim().toLowerCase().replace(/[@.]/g, '-');
}

function resolveAccountIndexPath(env = process.env) {
  return path.join(resolveStateDir(env), 'openclaw-weixin', 'accounts.json');
}

function resolveAccountPath(accountId, env = process.env) {
  return path.join(resolveStateDir(env), 'openclaw-weixin', 'accounts', `${accountId}.json`);
}

function readJsonFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

export function getOutboundServerConfig(env = process.env) {
  return {
    host: env.NODE_BRIDGE_OUTBOUND_HOST || '127.0.0.1',
    port: Number(env.NODE_BRIDGE_OUTBOUND_PORT || '8791'),
    accountId: env.PERSONAL_AGENT_WECHAT_ACCOUNT_ID || '',
  };
}

export function resolveWeixinAccountConfig(env = process.env) {
  const outboundConfig = getOutboundServerConfig(env);
  let accountId = outboundConfig.accountId.trim();

  if (!accountId) {
    const indexedAccounts = readJsonFile(resolveAccountIndexPath(env));
    if (!Array.isArray(indexedAccounts) || indexedAccounts.length === 0) {
      throw new Error('没有可用的微信账号索引，请先运行 login');
    }
    accountId = String(indexedAccounts[0]);
  }

  const normalizedAccountId = normalizeAccountId(accountId);
  const accountData = readJsonFile(resolveAccountPath(normalizedAccountId, env));
  if (!accountData || typeof accountData.token !== 'string' || !accountData.token.trim()) {
    throw new Error(`账号 ${normalizedAccountId} 未配置 token，请先运行 login`);
  }
  if (typeof accountData.userId !== 'string' || !accountData.userId.trim()) {
    throw new Error(`账号 ${normalizedAccountId} 缺少 userId，请重新运行 login`);
  }

  return {
    accountId: normalizedAccountId,
    baseUrl: typeof accountData.baseUrl === 'string' && accountData.baseUrl.trim()
      ? accountData.baseUrl.trim()
      : 'https://ilinkai.weixin.qq.com',
    cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c',
    token: accountData.token.trim(),
    userId: accountData.userId.trim(),
  };
}

let weixinSdkPromise = null;

async function loadWeixinSdk() {
  if (!weixinSdkPromise) {
    weixinSdkPromise = import('../vendor/weixin-agent-sdk/dist/index.mjs');
  }
  return weixinSdkPromise;
}

export async function createProactiveBot(env = process.env) {
  const { Bot } = await loadWeixinSdk();
  return new Bot(resolveWeixinAccountConfig(env));
}

export async function handleHermesLiteSoftResetControlRequest({
  env = process.env,
  method,
  url,
  headers = {},
  remoteAddress = '',
  bodyText = '',
} = {}) {
  const denial = internalControlAccessDenial({ env, method, url, headers, remoteAddress, route: HERMES_LITE_SOFT_RESET_CONTROL_ROUTE });
  if (denial) return denial;

  let payload;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    return { status: 400, payload: { ok: false, error: 'invalid_json' } };
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { status: 400, payload: { ok: false, error: 'invalid_request' } };
  }
  const action = String(payload.action || '').trim().toLowerCase();
  if (!['status', 'apply', 'dry-run', 'rollback-last'].includes(action)) {
    return { status: 400, payload: { ok: false, error: 'unknown_action' } };
  }
  if (['apply', 'rollback-last'].includes(action)
    && (!Number.isInteger(payload.expectedRevision) || payload.expectedRevision < 0)) {
    return { status: 428, payload: { ok: false, error: 'revision_required' } };
  }

  try {
    const result = runHermesLiteSoftReset({
      action,
      expectedRevision: payload.expectedRevision,
      env,
      reason: sanitizeControlReason(payload.reason || action),
    });
    if (result.error === 'stale_revision') return { status: 409, payload: result };
    if (result.ok === false) return { status: 400, payload: result };
    return { status: 200, payload: result };
  } catch {
    return { status: 500, payload: { ok: false, error: 'soft_reset_state_unavailable' } };
  }
}

export async function handleScheduledAiDigestControlRequest({
  env = process.env,
  method,
  url,
  headers = {},
  remoteAddress = '',
  ...options
} = {}) {
  const denial = internalControlAccessDenial({ env, method, url, headers, remoteAddress, route: AI_DAILY_DIGEST_CONTROL_ROUTE });
  if (denial) return denial;
  return handleScheduledAiDigestRequest({ env, ...options });
}

export async function handleOutboundRequest({ bot, logger = console, method, url, bodyText }) {
  if (method !== 'POST' || url !== '/outbound/send') {
    return {
      status: 404,
      payload: { error: 'route not found' },
    };
  }

  let payload;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    return {
      status: 400,
      payload: { error: 'request body must be valid JSON' },
    };
  }

  const normalizedText = typeof payload.text === 'string' ? payload.text.trim() : '';
  const normalizedMedia = normalizeOutboundMediaPayload(payload.media);

  if (!normalizedText && !normalizedMedia) {
    return {
      status: 400,
      payload: { error: "one of 'text' or 'media' must be provided" },
    };
  }
  const messageKind = typeof payload.kind === 'string' ? payload.kind.trim().toLowerCase() : 'checkin';
  if (messageKind === 'reminder') {
    logger.warn?.('legacy reminder outbound dropped; use /proactive/event');
    return {
      status: 200,
      payload: { ok: true, dropped: true, reason: 'legacy_reminder_route_retired' },
    };
  }
  logger.warn?.('legacy proactive outbound dropped; use /proactive/event');
  return {
    status: 200,
    payload: { ok: true, dropped: true, reason: 'legacy_checkin_route_retired' },
  };
}

export async function handleEnvironmentSensorRequest({
  env = process.env,
  method,
  url,
  bodyText,
} = {}) {
  const configuredToken = String(env.ENVIRONMENT_SENSOR_INGEST_TOKEN || '').trim();
  if (!configuredToken) {
    return {
      status: 403,
      payload: { error: 'forbidden' },
    };
  }
  let parsed;
  try {
    parsed = new URL(String(url || ''), 'http://127.0.0.1');
  } catch {
    return {
      status: 404,
      payload: { error: 'route not found' },
    };
  }
  const match = parsed.pathname.match(/^\/environment\/sensorlogger\/([^/]+)$/);
  if (method !== 'POST' || !match) {
    return {
      status: 404,
      payload: { error: 'route not found' },
    };
  }
  const suppliedToken = decodeURIComponent(match[1] || '') || parsed.searchParams.get('token') || '';
  if (suppliedToken !== configuredToken) {
    return {
      status: 403,
      payload: { error: 'forbidden' },
    };
  }
  let payload;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    return {
      status: 400,
      payload: { error: 'request body must be valid JSON' },
    };
  }
  const result = saveSensorLoggerMessage(payload, { env });
  if (result.ok !== true) {
    return {
      status: 400,
      payload: { error: result.error || 'invalid sensor payload' },
    };
  }
  return {
    status: 200,
    payload: { ok: true, readings: result.readings },
  };
}

export async function handleScheduledAiDigestRequest({
  logger = console,
  env = process.env,
  bodyText = '',
  channelHub = handleIncomingMessage,
  execFileImpl,
  nowImpl,
} = {}) {
  let payload;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    return {
      status: 400,
      payload: { error: 'request body must be valid JSON' },
    };
  }

  const prompt = typeof payload.prompt === 'string' ? payload.prompt.trim() : '';
  if (!prompt) {
    return {
      status: 400,
      payload: { error: "field 'prompt' must be a non-empty string" },
    };
  }

  const digestDate = typeof payload.date === 'string' ? payload.date.trim() : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(digestDate)) {
    return {
      status: 400,
      payload: { error: "field 'date' must be YYYY-MM-DD" },
    };
  }

  const target = getFeishuHomeDmTarget(env);
  if (!target) {
    logger.warn?.('scheduled AI daily digest skipped because Feishu home DM target is missing');
    return {
      status: 200,
      payload: { ok: true, skipped: true, reason: 'feishu_home_dm_target_missing' },
    };
  }

  const mode = payload.mode === 'manual' ? 'manual' : 'scheduled';
  const runtimeNow = typeof nowImpl === 'function' ? nowImpl() : new Date();
  const operationId = String(payload.operation_id || '').trim();
  if (mode === 'manual' && !/^op_[a-f0-9]{32}$/.test(operationId)) return { status: 400, payload: { error: 'manual digest operation is invalid' } };
  const idempotencyKey = mode === 'manual' ? operationId : `ran-agent-ai-daily-digest-${runtimeNow.toISOString().slice(0, 10)}`;
  const message = createTrustedBridgeInformationalReportTask({
    id: idempotencyKey,
    message_id: idempotencyKey,
    platform: 'feishu',
    channel_type: 'dm',
    conversation_id: target.conversation_id,
    sender_id: target.sender_id,
    text: prompt,
    media: [],
    created_at: runtimeNow.getTime(),
  }, mode === 'manual' ? 'manual_ai_daily_digest' : 'scheduled_ai_daily_digest');

  const response = await channelHub(message, {
    env,
    logger,
  });
  const replyText = String(response?.replyText || '').trim();
  if (!replyText) {
    return { status: 503, payload: { ok: false, reason: 'digest_reply_empty' } };
  }
  if (!replyText.includes(digestDate)) {
    logger.warn?.('scheduled AI daily digest reply rejected because the target date is missing');
    return { status: 503, payload: { ok: false, reason: 'digest_date_missing' } };
  }
  const outbox = createDurableOutbox({ env, now: nowImpl });
  const outboxItem = await outbox.deliver({
    operationKey: `${mode}:${idempotencyKey}`,
    jobResultKey: `job-result:${idempotencyKey}`,
    route: {
      adapterKey: 'feishu',
      destinationRef: `conversation:${createHash('sha256').update(String(target.conversation_id)).digest('hex').slice(0, 16)}`,
    },
    text: replyText,
    attachments: [],
    idempotent: true,
    maxAttempts: 2,
  }, {
    send: async ({ outboxId }) => {
      await sendFeishuReply({
        target: {
          ...target,
          source_message_id: outboxId,
        },
        text: replyText,
        env,
        execFileImpl,
      });
      return {
        textStatus: 'sent',
        attachments: [],
        adapterReceiptRef: `feishu:${createHash('sha256').update(outboxId).digest('hex').slice(0, 24)}`,
      };
    },
  });

  return {
    status: 200,
    payload: {
      ok: true,
      reply_length: replyText.length,
      delivery_status: outboxItem.delivery,
      outbox_id: outboxItem.outboxId,
      digest_kind: 'ai_daily_digest',
      digest_date: digestDate,
    },
  };
}

export async function handleProactiveEventRequest({
  logger = console,
  env = process.env,
  bodyText = '',
  channelHub = handleIncomingMessage,
  outbox,
  nowImpl,
  coreRuntime,
  sendWechat,
} = {}) {
  let payload;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    return {
      status: 400,
      payload: { error: 'request body must be valid JSON' },
    };
  }

  const target = resolveVisibleProactiveTarget({ coreRuntime, expectedRevision: payload.binding_revision });
  if (!target) {
    logger.warn?.('proactive event skipped because active owner presentation binding is missing or stale');
    return {
      status: 200,
      payload: { ok: true, skipped: true, reason: 'owner_presentation_binding_missing' },
    };
  }
  if (!outbox || typeof outbox.deliver !== 'function') {
    return {
      status: 200,
      payload: { ok: true, skipped: true, reason: 'durable_outbox_unavailable' },
    };
  }

  const normalized = normalizeProactiveEvent(payload, {
    globalUserId: target.sender_id,
    channel: target.platform,
  });
  if (!normalized.ok) {
    return {
      status: 400,
      payload: { error: normalized.error || 'invalid_proactive_event' },
    };
  }
  const event = normalized.event;
  const endpointScope = evaluateDirectProactiveEventScope(event);
  if (!endpointScope.accepted) {
    return {
      status: 200,
      payload: { ok: true, dropped: true, reason: endpointScope.reason },
    };
  }
  if (event.kind === 'reminder' && !isReminderDeliveryEnabled(env)) {
    return {
      status: 200,
      payload: { ok: true, dropped: true, reason: 'reminder_delivery_disabled' },
    };
  }

  const runtimeNow = typeof nowImpl === 'function' ? nowImpl() : new Date();
  const admission = evaluateProactiveAdmission(event, { env, now: runtimeNow });
  if (!admission.accepted) {
    return {
      status: 200,
      payload: { ok: true, dropped: true, reason: admission.reason },
    };
  }
  const reservation = reserveProactiveEventDelivery(event, { env, now: runtimeNow });
  if (!reservation.allowed) {
    return {
      status: 200,
      payload: { ok: true, dropped: true, reason: reservation.reason },
    };
  }

  let adapterSent = false;
  let egressReason = '';
  const message = buildProactiveSyntheticTurn(event, {
    platform: target.platform,
    channel_type: target.channel_type,
    conversation_id: target.conversation_id,
    sender_id: target.sender_id,
  });

  let response;
  try {
    response = await channelHub(message, {
      env,
      logger,
      outbox,
      adapter: {
        async sendReply({ text, message: sourceMessage }) {
          const egress = evaluateProactiveEgress({ event, replyText: text, env });
          egressReason = egress.reason;
          if (!egress.send) {
            return { textStatus: 'not_requested', attachments: [] };
          }
          if (typeof sendWechat !== 'function') throw new Error('WeChat presentation adapter is unavailable');
          return sendWechat({
            target: {
              ...target,
              source_message_id: sourceMessage?.id || sourceMessage?.message_id || event.event_id,
            },
            text: egress.message,
            env,
          });
        },
      },
    });
  } catch (error) {
    releaseProactiveEventDelivery(reservation.record.reservationId, { env, now: typeof nowImpl === 'function' ? nowImpl() : new Date() });
    const messageText = error instanceof Error ? error.message : String(error);
    logger.error?.(`proactive event failed: ${messageText}`);
    return {
      status: 200,
      payload: { ok: true, dropped: true, reason: 'send_failed' },
    };
  }
  const terminal = response?.durableDelivery || response?.coreDelivery;
  adapterSent = terminal?.delivery === 'sent' || terminal?.state === 'sent';
  if (adapterSent) {
    commitProactiveEventDelivery(reservation.record.reservationId, { env, now: typeof nowImpl === 'function' ? nowImpl() : new Date() });
  }
  if (!adapterSent) {
    releaseProactiveEventDelivery(reservation.record.reservationId, { env, now: typeof nowImpl === 'function' ? nowImpl() : new Date() });
  }

  return {
    status: 200,
    payload: {
      ok: true,
      event_id: event.event_id,
      status: adapterSent ? 'sent' : 'suppressed',
      notified: adapterSent,
      reason: adapterSent ? 'sent' : (egressReason || response?.suppressReason || 'not_notified'),
      reply_length: String(response?.replyText || '').length,
    },
  };
}

export async function handleProactiveEventControlRequest({
  env = process.env,
  method,
  url,
  headers = {},
  remoteAddress = '',
  ...options
} = {}) {
  const denial = internalControlAccessDenial({
    env, method, url, headers, remoteAddress, route: PROACTIVE_EVENT_CONTROL_ROUTE,
  });
  if (denial) return denial;
  return handleProactiveEventRequest({ env, ...options });
}

export async function handleExternalMcpSystemQueueRequest({
  logger = console,
  env = process.env,
  bodyText = '',
  channelHub = handleIncomingMessage,
  outbox,
  nowImpl,
  coreRuntime,
  sendWechat,
} = {}) {
  const queueGate = getExternalMcpSystemQueueGate(env);
  if (!queueGate.enabled) {
    return {
      status: 200,
      payload: { ok: true, dropped: true, reason: queueGate.reason },
    };
  }

  let payload;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    return {
      status: 400,
      payload: { error: 'request body must be valid JSON' },
    };
  }

  const target = resolveVisibleProactiveTarget({ coreRuntime, expectedRevision: payload.binding_revision });
  if (!target) {
    logger.warn?.('external MCP system queue skipped because active owner presentation binding is missing or stale');
    return {
      status: 200,
      payload: { ok: true, skipped: true, reason: 'owner_presentation_binding_missing' },
    };
  }
  if (!outbox || typeof outbox.deliver !== 'function') {
    return {
      status: 200,
      payload: { ok: true, skipped: true, reason: 'durable_outbox_unavailable' },
    };
  }

  const globalUserId = sanitizeExternalMcpIdentity(
    payload.globalUserId || payload.global_user_id || target.sender_id
  );
  const serverId = sanitizeExternalMcpIdentity(payload.serverId || payload.server_id || '');
  const watchScope = sanitizeExternalMcpScope(payload.watchScope || payload.watch_scope || '');
  const topicKey = watchScope;
  if (!globalUserId || !serverId || !watchScope || !topicKey) {
    return {
      status: 400,
      payload: { error: 'globalUserId, serverId, watchScope, and topicKey are required' },
    };
  }

  const watch = listExternalMcpWatches({ env }).find((item) => (
    item.globalUserId === globalUserId
    && item.serverId === serverId
    && item.scope === watchScope
  ));
  if (!watch) {
    return {
      status: 200,
      payload: { ok: true, dropped: true, reason: 'watch_not_registered' },
    };
  }

  const deliverability = normalizeExternalMcpDeliverability(payload.deliverability);
  const notifyAllowed = deliverability === 'notify_allowed' && watch.notify !== false;
  const runtimeNow = typeof nowImpl === 'function' ? nowImpl() : new Date();
  if (deliverability === 'notify_allowed' && watch.notify === false) {
    return {
      status: 200,
      payload: { ok: true, dropped: true, reason: 'watch_notifications_disabled' },
    };
  }
  const idempotencyKey = sanitizeExternalMcpIdentity(payload.id || payload.eventId || payload.event_id)
    || `external-mcp-${Date.now()}`;
  const evidenceRefs = normalizeExternalMcpEvidenceRefs(payload.evidenceRefs || payload.evidence_refs);
  const allowedCapabilityTiers = allowedExternalMcpEvidenceTiersForWatch(watch);
  let trustedEvidenceRefs = evidenceRefs;
  if (notifyAllowed) {
    const evidence = verifyExternalMcpEvidenceRefs({
      refs: evidenceRefs,
      globalUserId,
      serverId,
      watchScope,
      allowedCapabilityTiers,
    }, { env, now: runtimeNow });
    if (!evidence.ok) {
      return {
        status: 200,
        payload: { ok: true, dropped: true, reason: evidence.reason },
      };
    }
    trustedEvidenceRefs = evidence.trustedRefs;
  }
  const proactiveEvent = normalizeProactiveEvent(payload, {
    eventId: idempotencyKey,
    kind: externalMcpWatchKindToEventKind(watch.kind),
    globalUserId,
    channel: target.platform,
    watchScope,
    reason: payload.reason,
    evidenceRefs: trustedEvidenceRefs,
    dedupeKey: watchScope,
    deliverability,
    allowedCapabilityTiers,
    budgetClass: 'external_mcp',
  });
  if (!proactiveEvent.ok) {
    return {
      status: 400,
      payload: { error: proactiveEvent.error || 'invalid_proactive_event' },
    };
  }
  const event = proactiveEvent.event;
  const admission = evaluateProactiveAdmission(event, { env, now: runtimeNow });
  if (!admission.accepted) {
    return {
      status: 200,
      payload: { ok: true, dropped: true, reason: admission.reason },
    };
  }
  let reservation = null;
  if (notifyAllowed) {
    reservation = reserveExternalMcpNotification({
      globalUserId,
      serverId,
      topicKey,
    }, { env, now: runtimeNow });
    if (!reservation.allowed) {
      return {
        status: 200,
        payload: { ok: true, dropped: true, reason: reservation.reason },
      };
    }
  }

  let adapterSent = false;
  let egressReason = '';
  const message = buildExternalMcpSyntheticTurn({
    id: idempotencyKey,
    proactiveEvent: event,
    platform: target.platform,
    conversationId: target.conversation_id,
    senderId: target.sender_id,
  });

  let response;
  try {
    response = await channelHub(message, {
      env,
      logger,
      outbox,
      adapter: {
        async sendReply({ text, message: sourceMessage }) {
          const egress = evaluateExternalMcpSystemQueueEgress({ event, replyText: text, env });
          egressReason = egress.reason;
          if (!notifyAllowed || !egress.send) {
            return { textStatus: 'not_requested', attachments: [] };
          }
          if (typeof sendWechat !== 'function') throw new Error('WeChat presentation adapter is unavailable');
          return sendWechat({
            target: {
              ...target,
              source_message_id: sourceMessage?.id || sourceMessage?.message_id || idempotencyKey,
            },
            text: egress.message,
            env,
          });
        },
      },
    });
  } catch (error) {
    if (reservation?.event?.reservationId) {
      releaseExternalMcpNotificationReservation(reservation.event.reservationId, { env });
    }
    const messageText = error instanceof Error ? error.message : String(error);
    logger.error?.(`external MCP system queue failed: ${messageText}`);
    return {
      status: 200,
      payload: { ok: true, dropped: true, reason: 'send_failed' },
    };
  }
  const terminal = response?.durableDelivery || response?.coreDelivery;
  adapterSent = terminal?.delivery === 'sent' || terminal?.state === 'sent';
  if (adapterSent && reservation?.event?.reservationId) {
    commitExternalMcpNotificationReservation(reservation.event.reservationId, { env, now: typeof nowImpl === 'function' ? nowImpl() : new Date() });
  }
  if (!adapterSent && reservation?.event?.reservationId) {
    releaseExternalMcpNotificationReservation(reservation.event.reservationId, { env });
  }

  return {
    status: 200,
    payload: {
      ok: true,
      event_id: event.event_id,
      status: adapterSent ? 'sent' : 'suppressed',
      notified: adapterSent,
      reason: adapterSent ? 'sent' : (egressReason || response?.suppressReason || 'not_notified'),
      reply_length: String(response?.replyText || '').length,
    },
  };
}

function evaluateDirectProactiveEventScope(event) {
  if (event.kind === 'reminder') {
    return { accepted: true, reason: 'accepted' };
  }
  if (event.kind === 'companion'
    && event.watch_scope.startsWith('personal-learning:')
    && event.dedupe_key === event.watch_scope
    && event.evidence_refs.includes(event.watch_scope)
    && event.deliverability === 'notify_allowed') {
    return { accepted: true, reason: 'accepted' };
  }
  return {
    accepted: false,
    reason: 'proactive_event_kind_requires_dedicated_pipeline',
  };
}

function isReminderDeliveryEnabled(env = process.env) {
  const newValue = String(env.HERMES_PROACTIVE_REMINDERS_ENABLED || '').trim();
  if (newValue) {
    return isTruthyEnv(newValue);
  }
  return isTruthyEnv(env.PERSONAL_AGENT_REMINDER_DELIVERY_ENABLED);
}

function getExternalMcpSystemQueueGate(env = process.env) {
  if (!isTruthyEnv(env.HERMES_PROACTIVE_EVENTS_ENABLED)) {
    return { enabled: false, reason: 'proactive_events_disabled' };
  }
  if (!isTruthyEnv(env.HERMES_PROACTIVE_EXTERNAL_MCP_ENABLED)) {
    return { enabled: false, reason: 'proactive_external_mcp_disabled' };
  }
  if (!isTruthyEnv(env.EXTERNAL_MCP_SYSTEM_QUEUE_ENABLED)) {
    return { enabled: false, reason: 'external_mcp_system_queue_disabled' };
  }
  if (!isTruthyEnv(env.EXTERNAL_MCP_GATEWAY_ENABLED)) {
    return { enabled: false, reason: 'external_mcp_gateway_disabled' };
  }
  return { enabled: true, reason: '' };
}

function normalizeOutboundMediaPayload(media) {
  if (!media || typeof media !== 'object' || Array.isArray(media)) {
    return null;
  }
  const type = typeof media.type === 'string' ? media.type.trim().toLowerCase() : '';
  const url = typeof media.url === 'string' ? media.url.trim() : '';
  const fileName = typeof media.fileName === 'string' ? media.fileName.trim() : '';
  if (!type || !url) {
    return null;
  }
  if (!['image', 'video', 'file', 'audio'].includes(type)) {
    return null;
  }
  return fileName ? { type, url, fileName } : { type, url };
}

export function createOutboundServer({
  bot, logger = console, env = process.env, coreRuntime = null, channelHub = handleIncomingMessage,
  outbox, sendWechat,
} = {}) {
  return http.createServer(async (request, response) => {
    let rawBody = '';
    request.on('data', (chunk) => {
      rawBody += chunk;
    });

    request.on('end', async () => {
      let result;
      if (request.method === 'POST' && request.url === HERMES_LITE_SOFT_RESET_CONTROL_ROUTE) {
        result = await handleHermesLiteSoftResetControlRequest({
          env,
          method: request.method,
          url: request.url,
          headers: request.headers,
          remoteAddress: request.socket.remoteAddress,
          bodyText: rawBody,
        });
      } else if (request.method === 'POST' && request.url === AI_DAILY_DIGEST_CONTROL_ROUTE) {
        result = await handleScheduledAiDigestControlRequest({
          logger,
          env,
          method: request.method,
          url: request.url,
          headers: request.headers,
          remoteAddress: request.socket.remoteAddress,
          bodyText: rawBody,
          channelHub,
        });
      } else if (request.method === 'POST' && request.url === CORE_REMINDER_REGISTER_ROUTE) {
        result = await handleCoreReminderRegisterRequest({
          coreRuntime, env, method: request.method, url: request.url,
          headers: request.headers, remoteAddress: request.socket.remoteAddress, bodyText: rawBody,
        });
      } else if (request.method === 'POST' && request.url === PROACTIVE_EVENT_CONTROL_ROUTE) {
        result = await handleProactiveEventControlRequest({
          logger, env, method: request.method, url: request.url,
          headers: request.headers, remoteAddress: request.socket.remoteAddress, bodyText: rawBody,
          channelHub, outbox, coreRuntime, sendWechat,
        });
      } else if (request.method === 'POST' && request.url === '/external-mcp/system-queue') {
        result = await handleExternalMcpSystemQueueRequest({
          logger, env, bodyText: rawBody, channelHub, outbox, coreRuntime, sendWechat,
        });
      } else if (String(request.url || '').startsWith('/environment/sensorlogger/')) {
        result = await handleEnvironmentSensorRequest({
          env,
          method: request.method,
          url: request.url,
          bodyText: rawBody,
        });
      } else {
        result = await handleOutboundRequest({
          bot,
          logger,
          method: request.method,
          url: request.url,
          bodyText: rawBody,
        });
      }
      response.writeHead(result.status, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(result.payload));
    });
  });
}

export async function handleCoreReminderRegisterRequest({
  coreRuntime, env = process.env, method, url, headers, remoteAddress, bodyText,
} = {}) {
  const denied = internalControlAccessDenial({
    env, method, url, headers, remoteAddress, route: CORE_REMINDER_REGISTER_ROUTE,
  });
  if (denied) return denied;
  if (!coreRuntime?.core) return { status: 503, payload: { ok: false, error: 'core_runtime_unavailable' } };
  let body;
  try {
    body = JSON.parse(bodyText || '{}');
    const scheduledFor = legacyReminderInstant(body.scheduledFor);
    if (!scheduledFor) throw new Error('invalid reminder time');
    const result = await createCoreReminderService({ core: coreRuntime.core }).register({
      todoId: body.todoId, scheduledFor,
    });
    return { status: 200, payload: { ok: true, ...result } };
  } catch (error) {
    return { status: 400, payload: { ok: false, error: error?.code || 'invalid_core_reminder' } };
  }
}

function firstHeader(headers, name) {
  const value = headers?.[name] ?? headers?.[String(name).toLowerCase()];
  return Array.isArray(value) ? String(value[0] || '') : String(value || '');
}

function bearerToken(value) {
  const match = String(value || '').match(/^Bearer ([^\s]+)$/);
  return match ? match[1] : '';
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''));
  const rightBuffer = Buffer.from(String(right || ''));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function isLoopbackAddress(value) {
  const address = String(value || '').trim().toLowerCase().split('%')[0];
  if (address === '::1') return true;
  const ipv4 = address.startsWith('::ffff:') ? address.slice(7) : address;
  return /^127(?:\.\d{1,3}){3}$/.test(ipv4)
    && ipv4.split('.').every((part) => Number(part) >= 0 && Number(part) <= 255);
}

function internalControlAccessDenial({ env, method, url, headers, remoteAddress, route }) {
  if (method !== 'POST' || url !== route) return { status: 404, payload: { error: 'route not found' } };
  if (!isLoopbackAddress(remoteAddress)) return { status: 403, payload: { ok: false, error: 'loopback_required' } };
  const expectedSecret = String(env.RAN_AGENT_INTERNAL_CONTROL_SECRET || '');
  if (!expectedSecret) return { status: 503, payload: { ok: false, error: 'control_secret_unavailable' } };
  const suppliedSecret = bearerToken(firstHeader(headers, 'authorization'));
  if (!safeEqual(suppliedSecret, expectedSecret)) return { status: 401, payload: { ok: false, error: 'unauthorized' } };
  return null;
}

function sanitizeControlReason(value) {
  return String(value || '').trim().replace(/[\r\n\t]/g, ' ').slice(0, 80) || 'control';
}

function normalizeExternalMcpDeliverability(value) {
  const text = String(value || '').trim().toLowerCase();
  return ['silent_only', 'draft_allowed', 'notify_allowed'].includes(text) ? text : 'silent_only';
}

function externalMcpWatchKindToEventKind(value) {
  const text = String(value || '').trim().toLowerCase();
  if (text === 'game') return 'game_activity';
  if (text === 'forum') return 'forum_watch';
  return 'external_mcp';
}

function allowedExternalMcpEvidenceTiersForWatch(watch = {}) {
  const kind = String(watch.kind || '').trim().toLowerCase();
  if (kind === 'game') {
    return ['T3'];
  }
  return ['T1', 'T2'];
}

function normalizeExternalMcpEvidenceRefs(values) {
  const list = Array.isArray(values) ? values : values ? [values] : [];
  return Array.from(new Set(
    list
      .map((item) => sanitizeExternalMcpScope(item))
      .filter(Boolean)
  )).slice(0, 20);
}

function sanitizeExternalMcpIdentity(value) {
  return String(value || '')
    .trim()
    .replace(/[\r\n\t]/g, ' ')
    .replace(/[^a-zA-Z0-9_.:-]/g, '')
    .slice(0, 120);
}

function sanitizeExternalMcpScope(value) {
  return String(value || '')
    .trim()
    .replace(/[\r\n\t]/g, ' ')
    .replace(/[^a-zA-Z0-9_.:/-]/g, '')
    .slice(0, 180);
}

function resolveVisibleProactiveTarget({ coreRuntime, expectedRevision } = {}) {
  if (!coreRuntime?.core) return null;
  try {
    return presentationTarget(resolveActiveOwnerPresentationBinding(coreRuntime.core, { expectedRevision }));
  } catch {
    return null;
  }
}
