/**
 * Local-only outbound server for proactive messages sent from the Python scheduler.
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import {
  appendPendingOutboundMessage,
  drainPendingOutboundMessages,
  getCheckinRange,
  getProactiveDispatchState,
  resolveStateDir,
  setProactiveDispatchState,
} from './runtimeState.mjs';
export { resolveStateDir } from './runtimeState.mjs';

const DEFAULT_OUTBOUND_RETRY_DELAY_MS = 5 * 60 * 1000;
const DEFAULT_OUTBOUND_SEGMENT_DELAY_MS = 800;

function normalizeAccountId(raw) {
  return String(raw).trim().toLowerCase().replace(/[@.]/g, '-');
}

function resolveAccountIndexPath(env = process.env) {
  return path.join(resolveStateDir(env), 'ran-agent-weixin', 'accounts.json');
}

function resolveCompatAccountIndexPath(env = process.env) {
  return path.join(resolveStateDir(env), 'openclaw-weixin', 'accounts.json');
}

function resolveNestedLegacyAccountIndexPath(env = process.env) {
  return path.join(resolveStateDir(env), '.openclaw_state', 'openclaw-weixin', 'accounts.json');
}

function resolveAccountPath(accountId, env = process.env) {
  return path.join(resolveStateDir(env), 'ran-agent-weixin', 'accounts', `${accountId}.json`);
}

function resolveCompatAccountPath(accountId, env = process.env) {
  return path.join(resolveStateDir(env), 'openclaw-weixin', 'accounts', `${accountId}.json`);
}

function resolveNestedLegacyAccountPath(accountId, env = process.env) {
  return path.join(resolveStateDir(env), '.openclaw_state', 'openclaw-weixin', 'accounts', `${accountId}.json`);
}

function resolveVendorStateDirs(env = process.env) {
  const stateDir = resolveStateDir(env);
  const dirs = [
    stateDir,
    path.join(stateDir, '.openclaw_state'),
  ];
  const vendorStateDir = String(env.OPENCLAW_STATE_DIR || env.CLAWDBOT_STATE_DIR || '').trim();
  if (vendorStateDir) {
    dirs.push(path.isAbsolute(vendorStateDir) ? path.resolve(vendorStateDir) : path.resolve(process.cwd(), vendorStateDir));
  }
  return [...new Set(dirs)];
}

function resolveVendorAccountIndexPaths(env = process.env) {
  return resolveVendorStateDirs(env).map((dir) => path.join(dir, 'openclaw-weixin', 'accounts.json'));
}

function resolveVendorAccountPaths(accountId, env = process.env) {
  return resolveVendorStateDirs(env).map((dir) => path.join(dir, 'openclaw-weixin', 'accounts', `${accountId}.json`));
}

function readJsonFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function readFirstJsonFile(filePaths) {
  for (const filePath of filePaths) {
    const payload = readJsonFile(filePath);
    if (payload !== null) {
      return payload;
    }
  }
  return null;
}

function readWeixinAccountData(accountId, env = process.env) {
  const candidates = [
    readJsonFile(resolveAccountPath(accountId, env)),
    ...resolveVendorAccountPaths(accountId, env).map((filePath) => readJsonFile(filePath)),
  ].filter(Boolean);
  return candidates.find((item) => typeof item.token === 'string' && item.token.trim()) || candidates[0] || null;
}

function writeJsonFile(filePath, payload, mode = 0o600) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8');
  try {
    fs.chmodSync(filePath, mode);
  } catch {}
}

export function getOutboundServerConfig(env = process.env) {
  return {
    host: env.NODE_BRIDGE_OUTBOUND_HOST || '127.0.0.1',
    port: Number(env.NODE_BRIDGE_OUTBOUND_PORT || '8791'),
    accountId: env.PERSONAL_AGENT_WECHAT_ACCOUNT_ID || '',
  };
}

function toIsoAfterMinutes(minutes) {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

function randomIntInRange(min, max) {
  const safeMin = Math.max(1, Math.floor(min));
  const safeMax = Math.max(safeMin, Math.floor(max));
  return Math.floor(Math.random() * (safeMax - safeMin + 1)) + safeMin;
}

function getOutboundRetryDelayMs(env = process.env) {
  const raw = Number(env.NODE_BRIDGE_OUTBOUND_RETRY_DELAY_MS || DEFAULT_OUTBOUND_RETRY_DELAY_MS);
  if (!Number.isFinite(raw) || raw < 1000) {
    return DEFAULT_OUTBOUND_RETRY_DELAY_MS;
  }
  return Math.floor(raw);
}

function getOutboundSegmentDelayMs(env = process.env) {
  const raw = Number(env.NODE_BRIDGE_OUTBOUND_SEGMENT_DELAY_MS || DEFAULT_OUTBOUND_SEGMENT_DELAY_MS);
  if (!Number.isFinite(raw) || raw < 0) {
    return DEFAULT_OUTBOUND_SEGMENT_DELAY_MS;
  }
  return Math.floor(raw);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isDispatchBlockedNow(env = process.env) {
  const state = getProactiveDispatchState(env);
  if (!state.nextAllowedAt) {
    return false;
  }
  const nextAllowedAtMs = Date.parse(state.nextAllowedAt);
  if (!Number.isFinite(nextAllowedAtMs)) {
    return false;
  }
  return Date.now() < nextAllowedAtMs;
}

function isLowValueProactiveText(text) {
  const normalized = String(text || '').trim().replace(/\s+/g, '');
  if (!normalized) {
    return true;
  }
  const blockedPatterns = [
    /刚想到你最近挺忙的[，,。]?今天还顺吗[。？?]?$/,
    /^这条消息会被缓存[。！!]?$/,
  ];
  return blockedPatterns.some((pattern) => pattern.test(normalized));
}

function splitTextSegments(text) {
  const normalized = String(text || '').trim();
  if (!normalized) {
    return [];
  }
  return normalized
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeFollowUpMessages(messages) {
  if (!Array.isArray(messages)) {
    return [];
  }
  const flattened = [];
  for (const message of messages) {
    for (const segment of splitTextSegments(message)) {
      flattened.push(segment);
    }
  }
  return flattened;
}

function toIsoAfterMs(delayMs) {
  return new Date(Date.now() + Math.max(0, Math.floor(delayMs))).toISOString();
}

function buildOutboundSequence(payload) {
  const textSegments = splitTextSegments(payload.text);
  const explicitFollowUps = normalizeFollowUpMessages(payload.follow_up_messages);
  const allSegments = textSegments.length > 1
    ? [textSegments[0], ...textSegments.slice(1), ...explicitFollowUps]
    : [textSegments[0] || '', ...explicitFollowUps];
  const primaryText = String(allSegments.shift() || '').trim();
  return {
    primaryText,
    followUpMessages: allSegments,
  };
}

async function sendOutboundSequence(bot, payload, env = process.env) {
  const media = normalizeOutboundMediaPayload(payload.media);
  const { primaryText, followUpMessages } = buildOutboundSequence(payload);
  const segmentDelayMs = getOutboundSegmentDelayMs(env);

  if (!primaryText && !media) {
    throw new Error("one of 'text' or 'media' must be provided");
  }

  if (!followUpMessages.length) {
    await bot.sendMessage(buildBotMessagePayload({ text: primaryText, media }));
    return;
  }

  const firstPayload = media
    ? buildBotMessagePayload({ text: primaryText, media })
    : primaryText;
  await bot.sendMessage(firstPayload);

  for (const followUp of followUpMessages) {
    if (segmentDelayMs > 0) {
      await sleep(segmentDelayMs);
    }
    await bot.sendMessage(followUp);
  }
}

function queueOutboundRetry(payload, env = process.env, reason = 'send_failed') {
  const retryDelayMs = getOutboundRetryDelayMs(env);
  appendPendingOutboundMessage(
    {
      text: payload.text || '[media]',
      reason,
      nextAttemptAt: toIsoAfterMs(retryDelayMs),
    },
    env
  );
}

export function resolveWeixinAccountConfig(env = process.env) {
  const outboundConfig = getOutboundServerConfig(env);
  let accountId = outboundConfig.accountId.trim();

  if (!accountId) {
    const indexedAccounts = readFirstJsonFile([
      resolveAccountIndexPath(env),
      ...resolveVendorAccountIndexPaths(env),
    ]);
    if (!Array.isArray(indexedAccounts) || indexedAccounts.length === 0) {
      throw new Error('没有可用的微信账号索引，请先运行 login');
    }
    accountId = String(indexedAccounts[0]);
  }

  const normalizedAccountId = normalizeAccountId(accountId);
  const accountData = readWeixinAccountData(normalizedAccountId, env);
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

export function syncWeixinAccountConfigForVendorSdk(accountConfig, env = process.env) {
  const accountId = normalizeAccountId(accountConfig?.accountId || '');
  const token = String(accountConfig?.token || '').trim();
  const userId = String(accountConfig?.userId || '').trim();
  if (!accountId || !token || !userId) {
    return;
  }

  const payload = {
    token,
    savedAt: new Date().toISOString(),
    baseUrl: String(accountConfig.baseUrl || '').trim() || 'https://ilinkai.weixin.qq.com',
    userId,
  };
  for (const indexPath of resolveVendorAccountIndexPaths(env)) {
    writeJsonFile(indexPath, [accountId]);
  }
  for (const accountPath of resolveVendorAccountPaths(accountId, env)) {
    writeJsonFile(accountPath, payload);
  }
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
  if (normalizedText && isLowValueProactiveText(normalizedText)) {
    logger.warn?.('proactive outbound dropped by low-value text guard');
    return {
      status: 200,
      payload: { ok: true, dropped: true, reason: 'low_value_proactive_text' },
    };
  }
  const forceSend = payload.force === true;
  const messageKind = typeof payload.kind === 'string' ? payload.kind.trim().toLowerCase() : 'checkin';
  if (messageKind !== 'reminder' && !forceSend && !isProactiveDeliveryEnabled(process.env)) {
    logger.warn?.('proactive outbound dropped because proactive delivery is disabled');
    return {
      status: 200,
      payload: { ok: true, dropped: true, reason: 'proactive_delivery_disabled' },
    };
  }
  if (messageKind === 'reminder' && !isReminderDeliveryEnabled(process.env)) {
    logger.warn?.('reminder outbound dropped because reminder delivery is disabled');
    return {
      status: 200,
      payload: { ok: true, dropped: true, reason: 'reminder_delivery_disabled' },
    };
  }
  const bypassCooldown = messageKind === 'reminder';
  if (!forceSend && !bypassCooldown && isDispatchBlockedNow(process.env)) {
    appendPendingOutboundMessage(
      {
        text: normalizedText || '[media]',
        reason: 'checkin_cooldown_not_reached',
        nextAttemptAt: getProactiveDispatchState(process.env).nextAllowedAt || toIsoAfterMs(getOutboundRetryDelayMs(process.env)),
      },
      process.env
    );
    logger.info?.('proactive outbound queued by checkin cooldown');
    return {
      status: 200,
      payload: { ok: true, queued: true, reason: 'checkin_cooldown_not_reached' },
    };
  }

  try {
    const pendingMessages = drainPendingOutboundMessages(1, process.env);
    if (pendingMessages.length > 0) {
      const pendingText = String(pendingMessages[0]?.text || '').trim();
      if (!isReminderDeliveryEnabled(process.env) && isReminderLikeText(pendingText)) {
        logger.warn?.('pending reminder outbound dropped because reminder delivery is disabled');
      } else {
        try {
          await sendOutboundSequence(bot, { text: pendingText, media: null }, process.env);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          appendPendingOutboundMessage(
            {
              text: pendingText || '[media]',
              reason: `send_failed:${message}`,
              nextAttemptAt: toIsoAfterMs(getOutboundRetryDelayMs(process.env)),
            },
            process.env
          );
          throw error;
        }
      }
    }
    await sendOutboundSequence(
      bot,
      {
        text: normalizedText,
        media: normalizedMedia,
        follow_up_messages: payload.follow_up_messages,
      },
      process.env
    );
    const checkinRange = getCheckinRange(process.env);
    const nextDelayMinutes = randomIntInRange(checkinRange.minMinutes, checkinRange.maxMinutes);
    setProactiveDispatchState(
      { nextAllowedAt: toIsoAfterMinutes(nextDelayMinutes) },
      process.env
    );
    logger.info?.(`proactive outbound message sent text=${normalizedText || '[media-only]'}`);
    return {
      status: 200,
      payload: { ok: true, nextCheckinInMinutes: nextDelayMinutes },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    queueOutboundRetry(
      {
        text: normalizedText || '[media]',
      },
      process.env,
      `send_failed:${message}`
    );
    logger.error?.(`proactive outbound send failed and queued: ${message}`);
    return {
      status: 200,
      payload: { ok: true, queued: true, reason: 'send_failed' },
    };
  }
}

function isProactiveDeliveryEnabled(env = process.env) {
  return ['1', 'true', 'yes', 'on'].includes(
    String(env.PERSONAL_AGENT_PROACTIVE_ENABLED || 'false').trim().toLowerCase()
  );
}

function isReminderDeliveryEnabled(env = process.env) {
  return ['1', 'true', 'yes', 'on'].includes(
    String(env.PERSONAL_AGENT_REMINDER_DELIVERY_ENABLED || 'false').trim().toLowerCase()
  );
}

function isReminderLikeText(text) {
  return /^提醒一下[：:]/.test(String(text || '').trim());
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

function buildBotMessagePayload({ text = '', media = null } = {}) {
  if (media && text) {
    return { text, media };
  }
  if (media) {
    return { media };
  }
  return text;
}

export function createOutboundServer({ bot, logger = console } = {}) {
  return http.createServer(async (request, response) => {
    let rawBody = '';
    request.on('data', (chunk) => {
      rawBody += chunk;
    });

    request.on('end', async () => {
      const result = await handleOutboundRequest({
        bot,
        logger,
        method: request.method,
        url: request.url,
        bodyText: rawBody,
      });
      response.writeHead(result.status, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(result.payload));
    });
  });
}
