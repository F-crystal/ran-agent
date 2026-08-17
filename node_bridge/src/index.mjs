/**
 * Minimal Node bridge runner for forwarding WeChat messages to Hermes Gateway.
 */

import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createOutboundServer,
  createProactiveBot,
  getOutboundServerConfig,
  resolveWeixinAccountConfig,
} from './outboundServer.mjs';
import { startDesktopProxyServer } from './desktopProxyServer.mjs';
import { startCoReadingWebServer } from './coReading/webServer.mjs';
import { sendFeishuReply, startFeishuBridge } from './feishuBridge.mjs';
import { handleIncomingMessage } from './channelHub.mjs';
import { runDueExternalMcpActivities } from './externalMcp/activityRunner.mjs';
import { callExternalMcpTool } from './externalMcp/executor.mjs';
import { createExternalMcpAutonomyRuntime } from './externalMcp/runtime.mjs';
import { createReplyBackend } from './replyBackend.mjs';
import { createDurableOutbox } from './durableOutbox.mjs';
import { bindCoreChannelHub, openCommittedCoreRuntime } from './core/coreRuntime.mjs';
import { createCoreRuntimeComposition } from './core/coreRuntimeComposition.mjs';
import { createCoreExternalMcpHandler } from './core/coreExternalMcpHandler.mjs';
import { createCoreExternalNotificationService } from './core/coreExternalNotificationService.mjs';
import {
  createOfficialOmbreToolCaller,
  createOmbreProjectionService,
} from './core/ombreProjectionService.mjs';
import { createAttentionValve } from './attentionValve.mjs';
import { handleWeChatTextMessage, summarizeWeChatRequestShape } from './wechatBridge.mjs';
import { extractLegacyWechatMediaMarker, extractRanMediaMarker } from './replyMediaMarkers.mjs';
import { resolveStickerAsset } from './stickerCatalog.mjs';
import {
  getCheckinRange,
  resolveStateDir,
  setCheckinRange,
} from './runtimeState.mjs';

const MERGED_REQUEST_NOTICE = '（已合并到下一条统一处理）';

let weixinSdkPromise = null;

async function loadWeixinSdk() {
  if (!weixinSdkPromise) {
    weixinSdkPromise = import('../vendor/weixin-agent-sdk/dist/index.mjs');
  }
  return weixinSdkPromise;
}

function normalizeIncomingRequest(request) {
  // Normalize media to always be an array (weixin-agent-sdk sends single object)
  let normalizedMedia = request.media;
  if (normalizedMedia && !Array.isArray(normalizedMedia)) {
    normalizedMedia = [normalizedMedia];
  }
  return {
    text: request.text,
    conversationId: request.conversationId,
    imageUrl: request.imageUrl,
    imageUrls: request.imageUrls,
    media: normalizedMedia,
    message: request.message,
    payload: request.payload,
    content: request.content,
    conversation: request.conversation,
    id: request.id || request.messageId || request.message?.id || request.payload?.id || '',
  };
}

export function parseCheckinCommand(text) {
  const raw = String(text || '').trim();
  if (!raw.startsWith('/checkin')) {
    return null;
  }
  const parts = raw.split(/\s+/).filter(Boolean);
  if (parts.length === 2 && ['on', 'off'].includes(parts[1].toLowerCase())) {
    return { enabled: parts[1].toLowerCase() === 'on' };
  }
  if (parts.length !== 3) {
    return { error: '用法：/checkin on|off，或 /checkin <最小分钟> <最大分钟>' };
  }
  const minMinutes = Number(parts[1]);
  const maxMinutes = Number(parts[2]);
  if (!Number.isFinite(minMinutes) || !Number.isFinite(maxMinutes)) {
    return { error: '参数必须是数字分钟，例如 /checkin 20 90' };
  }
  if (minMinutes < 20 || maxMinutes < 20) {
    return { error: '主动陪伴间隔不能短于 20 分钟。' };
  }
  if (maxMinutes < minMinutes) {
    return { error: '最大分钟必须大于或等于最小分钟。' };
  }
  return { minMinutes: Math.floor(minMinutes), maxMinutes: Math.floor(maxMinutes) };
}

export class InboundMergeCoordinator {
  constructor({ windowMs = 1000 } = {}) {
    this._windowMs = Math.max(100, Number(windowMs) || 1000);
    this._sessions = new Map();
  }

  async enqueue(request, handler) {
    const conversationId = String(request.conversationId || '').trim();
    const key = conversationId || '__unknown__';
    const hasMedia = requestContainsMedia(request);
    let session = this._sessions.get(key);
    if (!session) {
      session = {
        items: [],
        waiters: [],
        timer: null,
        running: false,
      };
      this._sessions.set(key, session);
    }

    return new Promise((resolve, reject) => {
      session.items.push(request);
      session.waiters.push({ resolve, reject });
      const shouldFlushNow = hasMedia || session.items.some((item) => requestContainsMedia(item));
      if (session.timer) {
        clearTimeout(session.timer);
      }
      session.timer = setTimeout(() => {
        this._flushSession(key, handler).catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          while (session.waiters.length > 0) {
            session.waiters.shift().reject(new Error(message));
          }
        });
      }, shouldFlushNow ? 0 : this._windowMs);
    });
  }

  async _flushSession(key, handler) {
    const session = this._sessions.get(key);
    if (!session || session.running || session.items.length === 0) {
      return;
    }
    session.running = true;
    if (session.timer) {
      clearTimeout(session.timer);
      session.timer = null;
    }
    const items = session.items.splice(0, session.items.length);
    const waiters = session.waiters.splice(0, session.waiters.length);
    try {
      const mergedRequest = mergeRequests(items);
      const response = await handler(mergedRequest);
      for (let index = 0; index < waiters.length; index += 1) {
        if (waiters.length === 1 || index === waiters.length - 1) {
          waiters[index].resolve(response);
        } else {
          waiters[index].resolve({ text: MERGED_REQUEST_NOTICE });
        }
      }
    } catch (error) {
      for (const waiter of waiters) {
        waiter.reject(error);
      }
    } finally {
      session.running = false;
      if (session.items.length > 0) {
        const nextDelay = session.items.some((item) => requestContainsMedia(item))
          ? 0
          : this._windowMs;
        session.timer = setTimeout(() => {
          this._flushSession(key, handler).catch(() => {});
        }, nextDelay);
      } else {
        this._sessions.delete(key);
      }
    }
  }
}

export function mergeRequests(items) {
  const latest = items[items.length - 1] || {};
  const messageBatch = [];
  const mergedText = items
    .map((item, index) => {
      const text = String(item?.text || '').trim();
      if (text) {
        messageBatch.push({
          index: index + 1,
          text,
        });
      }
      return text;
    })
    .filter(Boolean)
    .join('\n');
  const mergedImageUrls = [];
  const mergedMedia = [];
  for (const item of items) {
    const urls = Array.isArray(item?.imageUrls) ? item.imageUrls : [];
    for (const url of urls) {
      const normalized = String(url || '').trim();
      if (normalized && !mergedImageUrls.includes(normalized)) {
        mergedImageUrls.push(normalized);
      }
    }
    const singleImage = String(item?.imageUrl || '').trim();
    if (singleImage && !mergedImageUrls.includes(singleImage)) {
      mergedImageUrls.push(singleImage);
    }
    const mediaItems = Array.isArray(item?.media) ? item.media : item?.media ? [item.media] : [];
    for (const media of mediaItems) {
      const normalizedMedia = normalizeMediaItem(media);
      if (!normalizedMedia) {
        continue;
      }
      if (!mergedMedia.some((existing) => sameMediaItem(existing, normalizedMedia))) {
        mergedMedia.push(normalizedMedia);
      }
    }
  }
  return {
    ...latest,
    text: mergedText || String(latest.text || ''),
    messageBatch,
    imageUrls: mergedImageUrls,
    imageUrl: '',
    media: mergedMedia,
  };
}

function normalizeMediaItem(media) {
  if (!media || typeof media !== 'object' || Array.isArray(media)) {
    return null;
  }
  const filePath = typeof media.filePath === 'string' ? media.filePath.trim() : '';
  if (!filePath) {
    return null;
  }
  return {
    filePath,
    mimeType: typeof media.mimeType === 'string' ? media.mimeType.trim().toLowerCase() : '',
    type: typeof media.type === 'string' ? media.type.trim().toLowerCase() : '',
  };
}

function sameMediaItem(left, right) {
  return left.filePath === right.filePath && left.mimeType === right.mimeType && left.type === right.type;
}

function requestContainsMedia(request) {
  if (!request || typeof request !== 'object') {
    return false;
  }
  if (String(request.imageUrl || '').trim()) {
    return true;
  }
  if (Array.isArray(request.imageUrls) && request.imageUrls.some((url) => String(url || '').trim())) {
    return true;
  }
  return Array.isArray(request.media) && request.media.length > 0;
}

function splitReplyTextIntoSegments(text) {
  const normalized = String(text || '').trim();
  if (!normalized) {
    return [];
  }
  return normalized
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeFollowUpTexts(messages) {
  if (!Array.isArray(messages)) {
    return [];
  }
  const normalized = [];
  for (const message of messages) {
    for (const segment of splitReplyTextIntoSegments(message)) {
      normalized.push(segment);
    }
  }
  return normalized;
}

function normalizeChatReplyResult(replyResult, options = {}) {
  const explicitFollowUps = normalizeFollowUpTexts(replyResult?.followUpMessages);
  const mediaFromMarker = extractTrustedReplyMediaMarker(replyResult?.replyText, options);
  const primaryText = mediaFromMarker
    ? mediaFromMarker.text
    : String(replyResult?.replyText || '').trim();
  return {
    replyText: primaryText,
    followUpMessages: explicitFollowUps,
    media: normalizeReplyMediaForWeixinSdk(replyResult?.media || mediaFromMarker?.media, options),
  };
}

function extractTrustedReplyMediaMarker(text) {
  const ranMedia = extractRanMediaMarker(text);
  if (ranMedia) {
    if (!ranMedia.mediaIntent) {
      return { text: ranMedia.text, media: null };
    }
    return { text: ranMedia.text, media: ranMedia.mediaIntent };
  }
  return extractLegacyWechatMediaMarker(text);
}

function normalizeReplyMediaForWeixinSdk(media, { env = process.env, logger = console } = {}) {
  if (!media || typeof media !== 'object' || Array.isArray(media)) {
    return null;
  }
  if (media.source === 'sticker_catalog' && media.kind === 'sticker') {
    const stickerId = typeof media.stickerId === 'string' ? media.stickerId.trim() : '';
    if (!stickerId) {
      return null;
    }
    try {
      const asset = resolveStickerAsset(stickerId, { env });
      const mime = String(asset.mime || '').trim().toLowerCase();
      const type = mime.startsWith('image/') ? 'image' : 'file';
      return {
        type,
        url: asset.filePath,
        fileName: asset.fileName,
      };
    } catch {
      logger.warn?.('[node-bridge] sticker media unavailable; sending text only');
      return null;
    }
  }
  const type = typeof media.type === 'string' ? media.type.trim().toLowerCase() : '';
  const url = typeof media.url === 'string' ? media.url.trim() : '';
  const fileName = typeof media.fileName === 'string' ? media.fileName.trim() : '';
  if (!type || !url) {
    return null;
  }
  if (type === 'audio') {
    return fileName ? { type: 'file', url, fileName } : { type: 'file', url };
  }
  if (!['image', 'video', 'file'].includes(type)) {
    return null;
  }
  return fileName ? { type, url, fileName } : { type, url };
}

export function formatPendingMessagesForReply(messages) {
  void messages;
  return '';
}

export function isExternalMcpActivityRunnerEnabled(env = process.env) {
  if (String(env.HERMES_PROACTIVE_EVENTS_ENABLED || 'true').trim().toLowerCase() === 'false') {
    return false;
  }
  if (String(env.EXTERNAL_MCP_ACTIVITY_RUNNER_ENABLED || 'true').trim().toLowerCase() === 'false') {
    return false;
  }
  if (String(env.EXTERNAL_MCP_SYSTEM_QUEUE_ENABLED || 'true').trim().toLowerCase() === 'false') {
    return false;
  }
  if (String(env.HERMES_PROACTIVE_EXTERNAL_MCP_ENABLED || 'true').trim().toLowerCase() === 'false') {
    return false;
  }
  return true;
}

// The autonomy runtime owns sessions, capabilities, policy and receipts. This
// adapter is deliberately only the final provider call boundary.
export function createExternalMcpRuntimeTransport({ env = process.env, executor = callExternalMcpTool } = {}) {
  return Object.freeze({
    async call(request = {}) {
      const manifest = request.manifest && typeof request.manifest === 'object' ? request.manifest : null;
      const toolName = String(request.toolName || '').trim();
      if (!manifest || !toolName) {
        return { ok: false, error_code: 'EXTERNAL_MCP_RUNTIME_TRANSPORT_INVALID' };
      }
      return await executor({
        ...manifest,
        toolName,
        arguments: request.arguments && typeof request.arguments === 'object' ? request.arguments : {},
        upstreamSessionId: String(request.upstreamSessionId || ''),
      }, { env, signal: request.signal });
    },
  });
}

// Checkpoints are already receipt-backed by the supervisor; this is only the
// shared reply-release and durable-delivery boundary. It never re-invokes an
// MCP tool or treats an adapter handoff as a confirmed send without a receipt.
export async function submitExternalMcpCheckpoint({
  candidate,
  context,
  replyBackend,
  outbox,
  sendWechat,
  sendFeishu = sendFeishuReply,
  env = process.env,
} = {}) {
  if (!replyBackend || typeof replyBackend.releaseExternalCheckpoint !== 'function'
    || !outbox || typeof outbox.deliver !== 'function' || !context?.notifyTarget) return { skipped: true };
  const released = await replyBackend.releaseExternalCheckpoint({ candidate, context });
  const target = context.notifyTarget;
  const text = String(released?.replyText || '').trim();
  if (!text || released?.suppressSend === true) return { skipped: true };
  const operationKey = `external-checkpoint:${context.activityId}:${context.checkpointDigest}`;
  return await outbox.deliver({
    operationKey,
    jobResultKey: `external-job:${context.activityId}:${context.checkpointDigest}`,
    route: { adapterKey: target.platform, destinationRef: `conversation:${shortDigest(target.conversationId)}` },
    text,
    attachments: [],
    idempotent: false,
    maxAttempts: 1,
  }, {
    send: async () => {
      if (target.platform === 'feishu') {
        const receipt = await sendFeishu({
          target: { conversation_id: target.conversationId, sender_id: target.senderId }, text, env,
        });
        return { textStatus: 'sent', attachments: [], adapterReceiptRef: receipt?.adapterReceiptRef || 'feishu:checkpoint' };
      }
      if (target.platform === 'wechat' && typeof sendWechat === 'function') {
        await sendWechat(text);
        return { textStatus: 'ambiguous', attachments: [], adapterReceiptRef: `wechat:checkpoint-${shortDigest(operationKey)}` };
      }
      return { textStatus: 'failed', attachments: [], adapterReceiptRef: `checkpoint:unsupported-${shortDigest(operationKey)}`, knownFailure: true };
    },
  });
}

export function startExternalMcpActivityRunnerLoop({
  env = process.env,
  logger = console,
  intervalMs,
  channelHub = handleIncomingMessage,
  runDueImpl = runDueExternalMcpActivities,
  sendText,
} = {}) {
  if (!isExternalMcpActivityRunnerEnabled(env)) {
    return { enabled: false, tick: async () => ({ skipped: true, reason: 'disabled' }), stop() {} };
  }
  let running = false;
  const actualIntervalMs = Math.min(Math.max(Number(intervalMs || env.EXTERNAL_MCP_ACTIVITY_TICK_MS || 60_000), 5_000), 15 * 60_000);
  const sendTextImpl = sendText || ((target, text) => sendExternalMcpActivityText(target, text, { env }));
  const tick = async () => {
    if (running) return { skipped: true, reason: 'already_running' };
    running = true;
    try {
      return await runDueImpl({
        env,
        logger,
        channelHub,
        sendText: sendTextImpl,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn?.(`[external-mcp-activity] runner tick failed: ${message}`);
      return { skipped: true, reason: 'tick_failed' };
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => {
    tick().catch(() => {});
  }, actualIntervalMs);
  timer.unref?.();
  return {
    enabled: true,
    tick,
    stop() {
      clearInterval(timer);
    },
  };
}

async function sendExternalMcpActivityText(target = {}, text = '', { env = process.env } = {}) {
  if (target.platform === 'wechat' && typeof env.sendFollowUpMessages === 'function') {
    await env.sendFollowUpMessages([text]);
    return;
  }
  if (target.platform === 'feishu') {
    await sendFeishuReply({
      target: {
        conversation_id: target.conversationId,
        sender_id: target.senderId,
      },
      text,
      env,
    });
    return;
  }
  throw new Error('unsupported external MCP activity target');
}

export function buildAgent({ logger, env, channelHub = handleIncomingMessage }) {
  const mergeWindowMs = Number(env.NODE_BRIDGE_MERGE_WINDOW_MS || '1200');
  const mergeCoordinator = new InboundMergeCoordinator({ windowMs: mergeWindowMs });
  const followUpDelayMs = Number(env.NODE_BRIDGE_FOLLOW_UP_DELAY_MS || '800');
  const sendFollowUpMessages = typeof env.sendFollowUpMessages === 'function'
    ? env.sendFollowUpMessages
    : null;
  const handleMessageImpl = typeof env.handleWeChatTextMessage === 'function'
    ? env.handleWeChatTextMessage
    : handleWeChatTextMessage;

  async function deliverQueuedMessages(messages, request) {
    const normalizedMessages = normalizeFollowUpTexts(messages);
    if (normalizedMessages.length === 0) {
      return;
    }
    if (!sendFollowUpMessages || !env.durableOutbox || typeof env.durableOutbox.deliver !== 'function') {
      logger.warn?.('[node-bridge] follow-up skipped because a durable WeChat delivery boundary is unavailable');
      return;
    }
    for (const [index, text] of normalizedMessages.entries()) {
      const operationKey = stableFollowUpOperationKey(request, index, text);
      const destinationRef = `conversation:${shortDigest(request?.conversationId || request?.conversation_id || '')}`;
      try {
        await env.durableOutbox.deliver({
          operationKey,
          route: { adapterKey: 'wechat', destinationRef },
          text,
          attachments: [],
          idempotent: false,
          maxAttempts: 1,
        }, {
          send: async () => {
            await sendFollowUpMessages([text]);
            return {
              textStatus: 'ambiguous',
              attachments: [],
              adapterReceiptRef: `wechat:unknown-${shortDigest(operationKey)}`,
            };
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn?.(`[node-bridge] durable follow-up send failed: ${message}`);
      }
    }
  }

  async function flushPendingOutboundQueue() {
    logger.info?.('[node-bridge] legacy pending proactive outbound queue retired; not flushing');
  }

  async function buildReplyResult(mergedRequest) {
    return normalizeChatReplyResult(await handleMessageImpl(mergedRequest, {
      logger,
      env,
      backend: env.replyBackend,
      channelHub,
      returnResult: true,
    }), { env, logger });
  }

  function scheduleFollowUps(followUps, request) {
    setTimeout(() => {
      flushPendingOutboundQueue().catch(() => {});
      if (followUps.length > 0) {
        setTimeout(() => {
          deliverQueuedMessages(followUps, request).catch(() => {});
        }, Math.max(0, followUpDelayMs));
      }
    }, 0);
  }

  function buildResponsePayload(replyResult) {
    const responsePayload = {};
    if (replyResult.replyText) {
      responsePayload.text = replyResult.replyText;
    }
    if (replyResult.media && typeof replyResult.media === 'object') {
      logger.log?.(`[node-bridge] outgoing media type=${replyResult.media.type || ''} fileName=${replyResult.media.fileName || ''}`);
      responsePayload.media = replyResult.media;
    }
    return responsePayload;
  }

  return {
    async chat(request) {
      logger.log(
        '[node-bridge] incoming request shape %s',
        JSON.stringify(summarizeWeChatRequestShape(request))
      );
      const normalizedRequest = normalizeIncomingRequest(request);
      const checkinCommand = parseCheckinCommand(normalizedRequest.text);
      if (checkinCommand) {
        if (checkinCommand.error) {
          return { text: checkinCommand.error };
        }
        const saved = setCheckinRange(
          checkinCommand.enabled === undefined
            ? checkinCommand
            : { ...getCheckinRange(env), enabled: checkinCommand.enabled },
          env,
        );
        if (checkinCommand.enabled !== undefined) {
          return { text: saved.enabled ? '主动陪伴已开启。' : '主动陪伴已停止。' };
        }
        return {
          text: `已更新随机轮询范围：最小 ${saved.minMinutes} 分钟，最大 ${saved.maxMinutes} 分钟。`,
        };
      }

      return mergeCoordinator.enqueue(normalizedRequest, async (mergedRequest) => {
        const replyResult = await buildReplyResult(mergedRequest);
        scheduleFollowUps(replyResult.followUpMessages, mergedRequest);
        return buildResponsePayload(replyResult);
      });
    },
  };
}

function stableFollowUpOperationKey(request = {}, index, text) {
  const source = String(
    request.id
    || request.messageId
    || request.message?.id
    || request.payload?.id
    || `${request.conversationId || request.conversation_id || ''}:${request.text || ''}`,
  );
  return `follow-up:wechat:${shortDigest(`${source}:${index}:${text}`)}`;
}

function shortDigest(value) {
  return createHash('sha256').update(String(value || ''), 'utf8').digest('hex').slice(0, 32);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function redactProxyUrlForLog(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    parsed.username = '';
    parsed.password = '';
    parsed.hash = '';
    if (parsed.search) {
      parsed.search = '?redacted';
    }
    return parsed.toString();
  } catch {
    return '[configured]';
  }
}

async function configureProxyIfPresent() {
  const proxyUrl = String(
    process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY || ''
  ).trim();
  if (!proxyUrl) {
    return;
  }
  try {
    const { ProxyAgent, setGlobalDispatcher } = await import('undici');
    setGlobalDispatcher(new ProxyAgent(proxyUrl));
    console.log(`[node-bridge] using outbound proxy ${redactProxyUrlForLog(proxyUrl)}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[node-bridge] failed to enable proxy dispatcher: ${message}`);
  }
}

function isLoginAbortError(error) {
  if (!(error instanceof Error)) {
    return false;
  }
  const text = `${error.name}: ${error.message}`;
  return text.includes('AbortError') || text.includes('This operation was aborted');
}

export function isTransientWeixinStartError(error) {
  if (!(error instanceof Error)) {
    return false;
  }
  const text = `${error.name}: ${error.message}`.toLowerCase();
  return (
    text.includes('fetch failed') ||
    text.includes('network') ||
    text.includes('socket') ||
    text.includes('timeout') ||
    text.includes('ssl') ||
    text.includes('econnreset') ||
    text.includes('etimedout') ||
    text.includes('eai_again')
  );
}

export function shouldRetryWeixinStartAttempt(attempt, maxRetries) {
  if (maxRetries <= 0) {
    return true;
  }
  return attempt <= maxRetries;
}

async function loginWithRetry() {
  const { login } = await loadWeixinSdk();
  const maxRetries = Number(process.env.WEIXIN_LOGIN_MAX_RETRIES || '5');
  const retryDelayMs = Number(process.env.WEIXIN_LOGIN_RETRY_DELAY_MS || '1500');
  let attempt = 0;
  while (true) {
    attempt += 1;
    try {
      await login();
      if (attempt > 1) {
        console.log(`[node-bridge] login succeeded on retry attempt=${attempt}`);
      }
      return;
    } catch (error) {
      if (!isLoginAbortError(error) || attempt >= maxRetries) {
        throw error;
      }
      console.warn(
        `[node-bridge] login aborted attempt=${attempt}/${maxRetries}, retrying in ${retryDelayMs}ms`
      );
      await sleep(retryDelayMs);
    }
  }
}

async function ensureWeixinAccountReady() {
  const forceLogin = String(process.env.WEIXIN_FORCE_LOGIN || '').toLowerCase() === 'true';
  if (!forceLogin) {
    try {
      const existing = resolveWeixinAccountConfig(process.env);
      console.log(`[node-bridge] reusing existing weixin account accountId=${existing.accountId}`);
      return existing;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[node-bridge] no reusable weixin login found, fallback to QR login: ${message}`);
    }
  }

  await loginWithRetry();
  return resolveWeixinAccountConfig(process.env);
}

function resetSyncBufferIfNeeded(accountId) {
  const shouldReset = String(process.env.WEIXIN_RESET_SYNC_ON_START || 'true').toLowerCase() === 'true';
  if (!shouldReset) {
    return;
  }
  try {
    const stateDir = resolveStateDir(process.env);
    const syncPath = path.join(stateDir, 'openclaw-weixin', 'accounts', `${accountId}.sync.json`);
    if (fs.existsSync(syncPath)) {
      fs.rmSync(syncPath, { force: true });
      console.log(`[node-bridge] reset stale weixin sync buffer file=${syncPath}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[node-bridge] failed to reset weixin sync buffer: ${message}`);
  }
}

async function verifyWeixinReachability() {
  const skipPreflight = String(process.env.WEIXIN_SKIP_PREFLIGHT || 'false').toLowerCase() === 'true';
  if (skipPreflight) {
    console.log('[node-bridge] skip weixin preflight by WEIXIN_SKIP_PREFLIGHT=true');
    return { ok: true, skipped: true };
  }
  const required = String(process.env.WEIXIN_PREFLIGHT_REQUIRED || 'false').toLowerCase() === 'true';
  const timeoutMs = Number(process.env.WEIXIN_PREFLIGHT_TIMEOUT_MS || '8000');
  const endpoint = 'https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: 'GET',
      signal: controller.signal,
    });
    console.log(`[node-bridge] weixin preflight status=${response.status}`);
    return { ok: true, status: response.status };
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    const errorText = `weixin preflight failed endpoint=${endpoint} timeoutMs=${timeoutMs} error=${message}`;
    if (required) {
      throw new Error(errorText);
    }
    console.warn(`[node-bridge] ${errorText}; continuing because WEIXIN_PREFLIGHT_REQUIRED=false`);
    return { ok: false, error: errorText };
  } finally {
    clearTimeout(timer);
  }
}

async function startWithRetry(agent, weixinAccountConfig) {
  const { start } = await loadWeixinSdk();
  const maxRetries = Number(process.env.WEIXIN_START_MAX_RETRIES || '0');
  const retryDelayMs = Number(process.env.WEIXIN_START_RETRY_DELAY_MS || '5000');
  let attempt = 0;
  while (true) {
    attempt += 1;
    try {
      await start(agent, { accountId: weixinAccountConfig.accountId });
      return;
    } catch (error) {
      const message = error instanceof Error ? error.stack || error.message : String(error);
      if (!isTransientWeixinStartError(error) || !shouldRetryWeixinStartAttempt(attempt, maxRetries)) {
        throw error;
      }
      const maxRetryText = maxRetries <= 0 ? 'infinite' : String(maxRetries);
      console.warn(
        `[node-bridge] weixin start transient error attempt=${attempt}/${maxRetryText} retryInMs=${retryDelayMs} error=${message}`
      );
      await sleep(retryDelayMs);
    }
  }
}

async function main() {
  await configureProxyIfPresent();
  const s12IngressQuiesced = process.env.RAN_AGENT_S12_INGRESS_QUIESCED === 'true';
  const weixinAccountConfig = s12IngressQuiesced ? null : await ensureWeixinAccountReady();
  if (weixinAccountConfig) {
    resetSyncBufferIfNeeded(weixinAccountConfig.accountId);
    await verifyWeixinReachability();
  }
  const proactiveBot = s12IngressQuiesced ? {
    async sendMessage() { throw new Error('S12 quiescence forbids Weixin delivery'); },
  } : await createProactiveBot(process.env);
  const runtimeEnv = {
    ...process.env,
    async sendStructuredMessage(payload) {
      await proactiveBot.sendMessage(payload);
    },
    async sendFollowUpMessages(messages) {
      for (const text of messages) {
        await proactiveBot.sendMessage(text);
        if (messages.length > 1) {
          await sleep(Number(process.env.NODE_BRIDGE_FOLLOW_UP_DELAY_MS || '800'));
        }
      }
    },
  };
  const durableOutbox = createDurableOutbox({ env: runtimeEnv });
  runtimeEnv.durableOutbox = durableOutbox;
  await durableOutbox.recover();
  const coreRuntime = await openCommittedCoreRuntime(runtimeEnv);
  const channelHub = bindCoreChannelHub(handleIncomingMessage, coreRuntime);
  let coreExternalMcp = null;
  const externalMcpRuntime = createExternalMcpAutonomyRuntime({
    env: runtimeEnv,
    logger: console,
    transport: createExternalMcpRuntimeTransport({ env: runtimeEnv }),
    submitCandidate: (candidate, context) => coreRuntime
      ? coreExternalMcp.submitCandidate(candidate, context)
      : submitExternalMcpCheckpoint({
        candidate,
        context,
        replyBackend: runtimeEnv.replyBackend,
        outbox: durableOutbox,
        sendWechat: (text) => proactiveBot.sendMessage(text),
        env: runtimeEnv,
      }),
  });
  if (coreRuntime) {
    const attentionValve = createAttentionValve({
      statePath: path.join(resolveStateDir(runtimeEnv), 'attention', 'delayed.json'),
    });
    coreExternalMcp = createCoreExternalMcpHandler({
      core: coreRuntime.core, runtime: externalMcpRuntime, hashContent: coreRuntime.hashContent,
      attentionValve,
      notificationService: createCoreExternalNotificationService({ core: coreRuntime.core }),
    });
  }
  const ombreProjection = coreRuntime ? createOmbreProjectionService({
    core: coreRuntime.core,
    hashContent: coreRuntime.hashContent,
    callTool: createOfficialOmbreToolCaller({
      url: runtimeEnv.OMBRE_BRAIN_MCP_URL || runtimeEnv.PERSONAL_AGENT_OMBRE_MCP_URL || 'http://127.0.0.1:18001/mcp',
      timeoutMs: Number(runtimeEnv.PERSONAL_AGENT_OMBRE_TIMEOUT_MS || 10_000),
    }),
  }) : null;
  runtimeEnv.replyBackend = createReplyBackend({
    env: runtimeEnv,
    logger: console,
    activityFacade: externalMcpRuntime.facade,
    personalLearningProjector: ombreProjection?.projectPersonalLearningReceipt,
  });
  const coreWorkRuntime = createCoreRuntimeComposition({
    runtime: coreRuntime, channelHub, externalPollHandler: coreExternalMcp?.handler,
    attentionFlushHandler: coreExternalMcp?.attentionFlushHandler, externalMcpRuntime,
    env: runtimeEnv, logger: console,
  });
  if (s12IngressQuiesced) {
    if (!coreWorkRuntime) throw new Error('S12 quiescence requires committed Core worker authority');
    coreWorkRuntime.start();
    console.log('[node-bridge] S12 ingress quiesced; Core worker active');
    await new Promise((resolve) => {
      process.once('SIGTERM', resolve);
      process.once('SIGINT', resolve);
    });
    await coreWorkRuntime.stop();
    await coreRuntime.core.close();
    return;
  }
  const agent = buildAgent({
    logger: console,
    env: runtimeEnv,
    channelHub,
  });
  const outboundConfig = getOutboundServerConfig(process.env);
  const outboundServer = createOutboundServer({
    bot: proactiveBot, logger: console, env: runtimeEnv, channelHub, coreRuntime,
  });
  const feishuBridge = startFeishuBridge({ env: runtimeEnv, logger: console, outbox: durableOutbox, channelHub });
  const desktopProxyServer = startDesktopProxyServer({ env: runtimeEnv, logger: console, outbox: durableOutbox, channelHub });
  const coReadingWebServer = startCoReadingWebServer({ env: process.env, logger: console });
  if (!coreRuntime) await externalMcpRuntime.start();
  coreWorkRuntime?.start();

  await new Promise((resolve, reject) => {
    outboundServer.once('error', reject);
    outboundServer.listen(outboundConfig.port, outboundConfig.host, resolve);
  });
  console.log(
    `[node-bridge] outbound server started host=${outboundConfig.host} port=${outboundConfig.port}`
  );

  try {
    await startWithRetry(agent, weixinAccountConfig);
  } finally {
    externalMcpRuntime.stop();
    await coreWorkRuntime?.stop();
    feishuBridge?.stop?.();
    await new Promise((resolve) => coReadingWebServer?.close ? coReadingWebServer.close(resolve) : resolve());
    await new Promise((resolve) => desktopProxyServer?.close ? desktopProxyServer.close(resolve) : resolve());
    await new Promise((resolve) => outboundServer.close(resolve));
    await coreRuntime?.core.close();
  }
}

const currentFile = fileURLToPath(import.meta.url);
const entryScript = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (entryScript && path.resolve(currentFile) === entryScript) {
  main().catch((error) => {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
