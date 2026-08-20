import path from 'node:path';
import { fetch as undiciFetch, ProxyAgent } from 'undici';

import { readJsonState, writeJsonAtomic } from './atomicState.mjs';
import { handleIncomingMessage } from './channelHub.mjs';
import { getIdentityBinding, shortHash } from './identityMap.mjs';
import { resolveStateDir } from './runtimeState.mjs';

const DEFAULT_API_BASE_URL = 'https://api.telegram.org';
const DEFAULT_POLL_TIMEOUT_SECONDS = 25;
const DEFAULT_MAX_BACKOFF_MS = 30_000;
const DEFAULT_API_DEADLINE_MS = 30_000;

export function getTelegramConfig(env = process.env) {
  const token = String(env.TELEGRAM_BOT_TOKEN || '').trim();
  const ownerUserId = normalizeTelegramId(env.TELEGRAM_OWNER_USER_ID);
  const ownerChatId = normalizeTelegramId(env.TELEGRAM_OWNER_CHAT_ID);
  const proxyUrl = String(env.TELEGRAM_PROXY_URL || '').trim();
  return Object.freeze({
    enabled: String(env.TELEGRAM_BRIDGE_ENABLED || 'false').trim().toLowerCase() === 'true',
    token,
    ownerUserId,
    ownerChatId,
    proxyUrl,
    pollTimeoutSeconds: DEFAULT_POLL_TIMEOUT_SECONDS,
    maxBackoffMs: DEFAULT_MAX_BACKOFF_MS,
    offsetPath: path.join(resolveStateDir(env), 'telegram', 'update-offset.json'),
  });
}

export function normalizeTelegramUpdate(update = {}, { config = {}, identityResolver = getIdentityBinding, env = process.env } = {}) {
  const message = update?.message;
  const from = message?.from;
  const chat = message?.chat;
  if (!message || typeof message !== 'object' || !from || typeof from !== 'object' || !chat || typeof chat !== 'object') {
    return { ok: false, reason: 'malformed_update' };
  }
  if (from.is_bot !== false || chat.type !== 'private') return { ok: false, reason: 'owner_private_chat_required' };
  const senderId = normalizeTelegramId(from.id);
  const conversationId = normalizeTelegramId(chat.id);
  if (!senderId || !conversationId) return { ok: false, reason: 'telegram_identity_missing' };
  const updateIdValue = Number(update.update_id);
  const messageIdValue = Number(message.message_id);
  const updateId = Number.isSafeInteger(updateIdValue) && updateIdValue >= 0 ? updateIdValue : null;
  const messageId = Number.isSafeInteger(messageIdValue) && messageIdValue >= 1 ? messageIdValue : null;
  if (updateId === null || messageId === null) return { ok: false, reason: 'malformed_update' };
  if (!config.ownerUserId || !config.ownerChatId) return { ok: false, reason: 'owner_binding_required' };
  if (senderId !== config.ownerUserId || conversationId !== config.ownerChatId) {
    return { ok: false, reason: 'owner_not_allowlisted' };
  }
  const identity = identityResolver({ platform: 'telegram', sender_id: senderId }, { env });
  if (identity?.bindingVersion !== 2 || identity.platform !== 'telegram' || identity.owner !== true) {
    return { ok: false, reason: 'owner_unverified' };
  }
  const hasUnsupportedMedia = Object.keys(message).some((key) => (
    ['photo', 'audio', 'video', 'document', 'voice', 'animation', 'sticker', 'location', 'contact', 'venue'].includes(key)
  ));
  if (hasUnsupportedMedia) return { ok: false, reason: 'unsupported_media' };
  const text = typeof message.text === 'string' ? message.text.trim() : '';
  if (!text) return { ok: false, reason: 'text_required' };
  const messageDate = Number(message.date);
  if (!Number.isSafeInteger(messageDate) || messageDate <= 0) {
    return { ok: false, reason: 'timestamp_required' };
  }
  const createdAt = messageDate * 1000;
  return {
    ok: true,
    message: {
      id: `telegram:${shortHash(updateId)}`,
      platform: 'telegram',
      channel_type: 'dm',
      conversation_id: conversationId,
      sender_id: senderId,
      text,
      media: [],
      raw_event_meta: {
        update_id_hash: shortHash(updateId),
        message_id_hash: shortHash(messageId),
        conversation_id_hash: shortHash(conversationId),
        sender_id_hash: shortHash(senderId),
      },
      created_at: createdAt,
    },
  };
}

export function createTelegramOffsetStore({ offsetPath, fsState = {} } = {}) {
  const target = String(offsetPath || '').trim();
  if (!target) throw telegramError('TELEGRAM_OFFSET_PATH_REQUIRED', 'Telegram update offset path is required');
  const validate = (value) => value?.schemaVersion === 1
    && Number.isSafeInteger(value.offset) && value.offset >= 0;
  const read = () => readJsonState(target, {
    validate,
    missingValue: { schemaVersion: 1, offset: 0 },
    critical: true,
    ...fsState,
  });
  const write = (offset) => {
    if (!Number.isSafeInteger(offset) || offset < 0) throw telegramError('TELEGRAM_OFFSET_INVALID', 'Telegram update offset is invalid');
    return writeJsonAtomic(target, { schemaVersion: 1, offset }, { validate, ...fsState });
  };
  return Object.freeze({
    get: () => read().offset,
    acknowledge: (updateId) => write(Number(updateId) + 1),
  });
}

export function createTelegramSendAdapter({ env = process.env, fetchImpl = undiciFetch, dispatcher: providedDispatcher, lifecycleSignal } = {}) {
  const config = getTelegramConfig(env);
  if (config.proxyUrl && !providedDispatcher) {
    throw telegramError('TELEGRAM_PROXY_DISPATCHER_REQUIRED', 'Telegram proxy dispatcher is unavailable');
  }
  const api = createTelegramApi({ config, fetchImpl, dispatcher: providedDispatcher });
  return Object.freeze({
    async sendReply({ target = {}, text = '', media = null } = {}) {
      if (media) return knownFailure('telegram:unsupported-media', 'unsupported_media');
      const chatId = normalizeTelegramId(target.conversation_id || target.conversationId || config.ownerChatId);
      if (!chatId || (config.ownerChatId && chatId !== config.ownerChatId)) return knownFailure('telegram:owner-binding-mismatch', 'owner_binding_mismatch');
      try {
        return await sendTelegramText({ chatId, text, api, signal: requestSignal(lifecycleSignal, DEFAULT_API_DEADLINE_MS) });
      } catch (error) {
        if (error?.knownFailure === true) return knownFailure(`telegram:known-failure:${error.code || 'api'}`, error.code || 'api_failure');
        throw error;
      }
    },
  });
}

export async function startTelegramBridge({
  env = process.env,
  logger = console,
  fetchImpl = undiciFetch,
  channelHub = handleIncomingMessage,
  outbox,
  identityResolver = getIdentityBinding,
  offsetPath,
} = {}) {
  const config = getTelegramConfig(env);
  if (!config.enabled) return Object.freeze({ enabled: false, stop: async () => {} });
  assertTelegramConfig(config);
  const identity = identityResolver({ platform: 'telegram', sender_id: config.ownerUserId }, { env });
  if (identity?.bindingVersion !== 2 || identity.platform !== 'telegram' || identity.owner !== true) {
    throw telegramError('TELEGRAM_OWNER_IDENTITY_REQUIRED', 'Telegram owner identity binding is unavailable');
  }
  const abortController = new AbortController();
  const dispatcher = createTelegramDispatcher(config.proxyUrl);
  const api = createTelegramApi({ config, fetchImpl, dispatcher });
  const offset = createTelegramOffsetStore({ offsetPath: offsetPath || config.offsetPath });
  const adapter = createTelegramSendAdapter({ env, fetchImpl, dispatcher, lifecycleSignal: abortController.signal });
  let stopped = false;
  let loopPromise;
  let backoffMs = 1000;
  let webhookReady = false;

  const processUpdate = async (update) => {
    const normalized = normalizeTelegramUpdate(update, { config, identityResolver, env });
    if (!normalized.ok) {
      logger.info?.(`[telegram-bridge] update_dropped reason=${normalized.reason}`);
      return;
    }
    await channelHub(normalized.message, {
      env,
      logger,
      outbox,
      adapter,
      fetchImpl,
    });
  };

  const run = async () => {
    while (!stopped) {
      try {
        if (!webhookReady) {
          const webhook = await api.call('getWebhookInfo', {}, requestSignal(abortController.signal, DEFAULT_API_DEADLINE_MS));
          if (stopped) break;
          if (String(webhook?.url || '').trim()) {
            logger.warn?.('[telegram-bridge] stopped reason=TELEGRAM_WEBHOOK_CONFIGURED');
            break;
          }
          webhookReady = true;
        }
        const updates = await api.call('getUpdates', {
          offset: offset.get(),
          timeout: config.pollTimeoutSeconds,
          allowed_updates: ['message'],
        }, requestSignal(abortController.signal, (config.pollTimeoutSeconds + 5) * 1000));
        for (const update of Array.isArray(updates) ? updates : []) {
          if (stopped) break;
          await processUpdate(update);
          if (Number.isSafeInteger(Number(update?.update_id))) offset.acknowledge(Number(update.update_id));
        }
        backoffMs = 1000;
      } catch (error) {
        if (stopped || error?.name === 'AbortError') break;
        logger.warn?.(`[telegram-bridge] poll_failed reason=${error?.code || 'transport'}`);
        await abortableDelay(Math.min(error?.retryAfterMs || backoffMs, config.maxBackoffMs), abortController.signal);
        backoffMs = Math.min(backoffMs * 2, config.maxBackoffMs);
      }
    }
  };
  loopPromise = run();
  loopPromise.catch((error) => logger.error?.(`[telegram-bridge] stopped reason=${error?.code || 'poll_loop_failed'}`));
  return Object.freeze({
    enabled: true,
    async stop() {
      if (stopped) return;
      stopped = true;
      abortController.abort();
      await loopPromise;
      await dispatcher?.close?.();
    },
  });
}

function assertTelegramConfig(config) {
  if (!config.token || /\s/.test(config.token)) throw telegramError('TELEGRAM_BOT_TOKEN_REQUIRED', 'Telegram bot token is unavailable');
  if (!config.ownerUserId || !config.ownerChatId) throw telegramError('TELEGRAM_OWNER_BINDING_REQUIRED', 'Telegram owner user and private chat are required');
}

function createTelegramDispatcher(proxyUrl) {
  const value = String(proxyUrl || '').trim();
  if (!value) return undefined;
  try {
    const protocol = new URL(value).protocol;
    if (!['http:', 'https:'].includes(protocol)) throw new Error('unsupported proxy protocol');
    return new ProxyAgent(value);
  } catch {
    throw telegramError('TELEGRAM_PROXY_INVALID', 'Telegram proxy URL is invalid');
  }
}

function createTelegramApi({ config, fetchImpl, dispatcher }) {
  const call = async (method, body, signal) => {
    const request = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    };
    if (dispatcher) request.dispatcher = dispatcher;
    let response;
    try {
      response = await fetchImpl(`${DEFAULT_API_BASE_URL}/bot${config.token}/${method}`, request);
    } catch {
      if (config.proxyUrl) throw telegramError('TELEGRAM_PROXY_UNREACHABLE', 'Telegram proxy request failed');
      throw telegramError('TELEGRAM_TRANSPORT_FAILED', 'Telegram transport request failed');
    }
    let payload = null;
    try { payload = await response.json(); } catch { payload = null; }
    if (!response.ok || payload?.ok !== true) {
      const error = telegramError(`TELEGRAM_API_${response.status || 'ERROR'}`, 'Telegram Bot API request failed');
      const retryAfterSeconds = Number(payload?.parameters?.retry_after);
      error.retryAfterMs = Number.isSafeInteger(retryAfterSeconds) && retryAfterSeconds > 0
        ? boundedInteger(retryAfterSeconds * 1000, 1000, 1000, 120_000)
        : 1000;
      error.knownFailure = response.status >= 400 && response.status < 500 && response.status !== 429;
      throw error;
    }
    return payload.result;
  };
  return Object.freeze({ call });
}

async function sendTelegramText({ chatId, text, api, signal }) {
  const normalizedText = String(text || '').trim();
  if (!normalizedText) return { textStatus: 'not_requested', attachments: [], adapterReceiptRef: 'telegram:no-text' };
  if (normalizedText.length > 4096) return knownFailure('telegram:text-too-long', 'text_too_long');
  const result = await api.call('sendMessage', {
    chat_id: chatId,
    text: normalizedText,
  }, signal);
  const messageId = Number(result?.message_id);
  if (!Number.isSafeInteger(messageId) || messageId < 1) throw telegramError('TELEGRAM_RESULT_INVALID', 'Telegram send result is invalid');
  return { textStatus: 'sent', attachments: [], adapterReceiptRef: `telegram:message:${shortHash(messageId)}` };
}

function knownFailure(receipt, code) {
  return { textStatus: 'failed', attachments: [], knownFailure: true, adapterReceiptRef: receipt, errorClass: code };
}

function normalizeTelegramId(value) {
  const text = String(value ?? '').trim();
  return /^-?\d+$/.test(text) ? text : '';
}

function boundedInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, min), max) : fallback;
}

function abortableDelay(milliseconds, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const timer = setTimeout(resolve, Math.max(0, milliseconds));
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

function requestSignal(parent, deadlineMs) {
  const deadline = AbortSignal.timeout(deadlineMs);
  return parent ? AbortSignal.any([parent, deadline]) : deadline;
}

function telegramError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
