/**
 * Local-only outbound server for proactive messages sent from the Python scheduler.
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { handleIncomingMessage } from './channelHub.mjs';
import { sendFeishuReply } from './feishuBridge.mjs';
import {
  appendPendingOutboundMessage,
  drainPendingOutboundMessages,
  getCheckinRange,
  getFeishuHomeDmTarget,
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

export async function handleScheduledAiDigestRequest({
  logger = console,
  env = process.env,
  bodyText = '',
  channelHub = handleIncomingMessage,
  execFileImpl,
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

  const facts = String(payload.facts || '').trim();
  if (!facts) {
    return {
      status: 400,
      payload: { error: "field 'facts' must be a non-empty string" },
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

  const idempotencyKey = `ran-agent-ai-daily-digest-${new Date().toISOString().slice(0, 10)}`;
  const message = {
    id: idempotencyKey,
    message_id: idempotencyKey,
    platform: 'feishu',
    channel_type: 'dm',
    conversation_id: target.conversation_id,
    sender_id: target.sender_id,
    route_hint: 'scheduled_ai_daily_digest',
    text: buildScheduledAiDigestPrompt(facts),
    media: [],
    created_at: Date.now(),
  };

  const response = await channelHub(message, {
    env,
    logger,
    adapter: {
      async sendReply({ target: replyTarget, text, message: sourceMessage }) {
        await sendFeishuReply({
          target: {
            ...replyTarget,
            source_message_id: sourceMessage?.id || sourceMessage?.message_id || idempotencyKey,
          },
          text,
          env,
          execFileImpl,
        });
      },
    },
  });

  return {
    status: 200,
    payload: { ok: true, reply_length: String(response?.replyText || '').length },
  };
}

function buildScheduledAiDigestPrompt(facts) {
  if (String(facts || '').includes('[AIHOT/Search Hub 事实材料]')) {
    return String(facts || '').trim();
  }
  return [
    '这是用户订阅的每日 10:00 AI 日报任务。',
    '请只基于下面事实材料写一条适合飞书私聊阅读的中文 AI 日报。',
    '偏好开头像“给陛下呈上今日 AI 日报”，但不要逐字死板套模板。',
    '优先突出最重要事件；可以自然分组、改名、合并或省略空栏目。',
    '每条尽量包含“发生了什么 + 为什么值得看”。',
    '不要问候、不要追问、不要安排后续主动消息，不要解释内部机制。',
    '',
    '[事实材料]',
    facts,
  ].join('\n');
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
      const result = request.method === 'POST' && request.url === '/scheduled/ai-daily-digest'
        ? await handleScheduledAiDigestRequest({ logger, env: process.env, bodyText: rawBody })
        : await handleOutboundRequest({
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
