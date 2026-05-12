/**
 * Minimal Node bridge runner for forwarding WeChat messages to OpenClaw Gateway.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createOutboundServer,
  createProactiveBot,
  getOutboundServerConfig,
  resolveWeixinAccountConfig,
} from './outboundServer.mjs';
import { handleWeChatTextMessage, summarizeWeChatRequestShape } from './wechatBridge.mjs';
import {
  appendPendingOutboundMessage,
  drainPendingOutboundMessages,
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
  };
}

export function parseCheckinCommand(text) {
  const raw = String(text || '').trim();
  if (!raw.startsWith('/checkin')) {
    return null;
  }
  const parts = raw.split(/\s+/).filter(Boolean);
  if (parts.length !== 3) {
    return { error: '用法：/checkin <最小分钟> <最大分钟>，例如 /checkin 20 90' };
  }
  const minMinutes = Number(parts[1]);
  const maxMinutes = Number(parts[2]);
  if (!Number.isFinite(minMinutes) || !Number.isFinite(maxMinutes)) {
    return { error: '参数必须是数字分钟，例如 /checkin 20 90' };
  }
  if (minMinutes <= 0 || maxMinutes <= 0) {
    return { error: '分钟必须大于 0。' };
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

function isProactiveDeliveryEnabled(env = process.env) {
  const value = String(env.PERSONAL_AGENT_PROACTIVE_ENABLED || 'false').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(value);
}

function normalizeChatReplyResult(replyResult) {
  const explicitFollowUps = normalizeFollowUpTexts(replyResult?.followUpMessages);
  const mediaFromMarker = extractTrustedReplyMediaMarker(replyResult?.replyText);
  const primaryText = mediaFromMarker
    ? mediaFromMarker.text
    : String(replyResult?.replyText || '').trim();
  return {
    replyText: primaryText,
    followUpMessages: explicitFollowUps,
    media: normalizeReplyMediaForWeixinSdk(replyResult?.media || mediaFromMarker?.media),
  };
}

function extractTrustedReplyMediaMarker(text) {
  const raw = String(text || '');
  const markerPattern = /^WECHAT_MEDIA:\s*(\{.*\})\s*$/im;
  const match = raw.match(markerPattern);
  if (!match?.[1]) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return null;
  }
  if (parsed?.source !== 'media_generation_mcp') {
    return null;
  }
  const type = typeof parsed.type === 'string' ? parsed.type.trim().toLowerCase() : '';
  const url = typeof parsed.url === 'string' ? parsed.url.trim() : '';
  const fileName = typeof parsed.fileName === 'string' ? parsed.fileName.trim() : '';
  if (!type || !url) {
    return null;
  }
  return {
    text: raw
      .replace(markerPattern, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
    media: fileName ? { type, url, fileName } : { type, url },
  };
}

function normalizeReplyMediaForWeixinSdk(media) {
  if (!media || typeof media !== 'object' || Array.isArray(media)) {
    return null;
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

export function buildAgent({ logger, env }) {
  const mergeWindowMs = Number(env.NODE_BRIDGE_MERGE_WINDOW_MS || '1200');
  const mergeCoordinator = new InboundMergeCoordinator({ windowMs: mergeWindowMs });
  const followUpDelayMs = Number(env.NODE_BRIDGE_FOLLOW_UP_DELAY_MS || '800');
  const sendFollowUpMessages = typeof env.sendFollowUpMessages === 'function'
    ? env.sendFollowUpMessages
    : null;
  const handleMessageImpl = typeof env.handleWeChatTextMessage === 'function'
    ? env.handleWeChatTextMessage
    : handleWeChatTextMessage;

  async function deliverQueuedMessages(messages) {
    const normalizedMessages = normalizeFollowUpTexts(messages);
    if (!sendFollowUpMessages || normalizedMessages.length === 0) {
      return;
    }
    try {
      await sendFollowUpMessages(normalizedMessages);
    } catch (error) {
      for (const text of normalizedMessages) {
        appendPendingOutboundMessage({ text, reason: 'chat_follow_up_send_failed' }, env);
      }
      const message = error instanceof Error ? error.message : String(error);
      logger.warn?.(`[node-bridge] failed to send queued follow-up messages: ${message}`);
    }
  }

  async function flushPendingOutboundQueue() {
    if (!isProactiveDeliveryEnabled(env)) {
      logger.info?.('[node-bridge] pending proactive outbound queue held because proactive delivery is disabled');
      return;
    }
    const drained = drainPendingOutboundMessages(8, env)
      .map((item) => String(item?.text || '').trim())
      .filter(Boolean);
    if (drained.length === 0) {
      return;
    }
    await deliverQueuedMessages(drained);
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
        const saved = setCheckinRange(checkinCommand, env);
        return {
          text: `已更新随机轮询范围：最小 ${saved.minMinutes} 分钟，最大 ${saved.maxMinutes} 分钟。`,
        };
      }

      return mergeCoordinator.enqueue(normalizedRequest, async (mergedRequest) => {
        const replyResult = normalizeChatReplyResult(await handleMessageImpl(mergedRequest, {
          logger,
          env,
          returnResult: true,
        }));
        const followUps = replyResult.followUpMessages;
        setTimeout(() => {
          flushPendingOutboundQueue().catch(() => {});
          if (followUps.length > 0) {
            setTimeout(() => {
              deliverQueuedMessages(followUps).catch(() => {});
            }, Math.max(0, followUpDelayMs));
          }
        }, 0);
        const responsePayload = {};
        if (replyResult.replyText) {
          responsePayload.text = replyResult.replyText;
        }
        if (replyResult.media && typeof replyResult.media === 'object') {
          logger.log?.(`[node-bridge] outgoing media type=${replyResult.media.type || ''} url=${replyResult.media.url || ''}`);
          responsePayload.media = replyResult.media;
        }
        return responsePayload;
      });
    },
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    console.log(`[node-bridge] using outbound proxy ${proxyUrl}`);
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
  const weixinAccountConfig = await ensureWeixinAccountReady();
  resetSyncBufferIfNeeded(weixinAccountConfig.accountId);
  await verifyWeixinReachability();
  const proactiveBot = await createProactiveBot(process.env);
  const agent = buildAgent({
    logger: console,
    env: {
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
    },
  });
  const outboundConfig = getOutboundServerConfig(process.env);
  const outboundServer = createOutboundServer({ bot: proactiveBot, logger: console });

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
    await new Promise((resolve) => outboundServer.close(resolve));
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
