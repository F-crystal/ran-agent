import { spawn, execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { handleIncomingMessage } from './channelHub.mjs';
import { shortHash } from './identityMap.mjs';

const execFile = promisify(execFileCallback);

export function parseFeishuEvent(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  return JSON.parse(text);
}

export function normalizeFeishuMessage(event = {}) {
  const body = event.event || event;
  const message = body.message || body;
  const sender = body.sender || {};
  const senderId = sender.sender_id || sender;
  const userId = firstNonEmptyString(
    senderId.user_id,
    senderId.open_id,
    senderId.union_id,
    sender.user_id,
    sender.open_id,
    message.sender_id,
    body.sender_id
  );
  const chatId = firstNonEmptyString(message.chat_id, message.open_chat_id, message.chatId, body.chat_id, userId);
  const chatType = String(message.chat_type || message.chatType || '').trim().toLowerCase();
  const channelType = chatType === 'group' || chatType === 'chat' ? 'group' : 'dm';
  const text = extractFeishuText(message.content);
  const messageId = firstNonEmptyString(message.message_id, message.messageId, event.uuid);
  return {
    id: messageId || `${Date.now()}-${shortHash(text)}`,
    message_id: messageId,
    platform: 'feishu',
    channel_type: channelType,
    conversation_id: chatId,
    sender_id: userId || 'unknown',
    text,
    media: [],
    raw_event_meta: redactFeishuMeta({
      message_id: messageId,
      chat_id: chatId,
      user_id: userId,
      chat_type: chatType,
    }),
    created_at: Number(message.create_time || message.createTime || Date.now()),
  };
}

export function createFeishuBridgeState({ maxSeen = 1000 } = {}) {
  const seen = new Set();
  return {
    markSeen(messageId) {
      const id = String(messageId || '').trim();
      if (!id) return true;
      if (seen.has(id)) return false;
      seen.add(id);
      if (seen.size > maxSeen) {
        const first = seen.values().next().value;
        if (first) seen.delete(first);
      }
      return true;
    },
  };
}

export async function sendFeishuReply({ target = {}, text = '', execFileImpl = execFile, env = process.env } = {}) {
  const bin = String(env.FEISHU_LARK_CLI_BIN || 'lark-cli').trim() || 'lark-cli';
  const identity = normalizeLarkCliIdentity(env.FEISHU_LARK_CLI_IDENTITY);
  const channelType = String(target.channel_type || '').trim().toLowerCase();
  const receiveId = channelType === 'group'
    ? firstNonEmptyString(target.chat_id, target.conversation_id)
    : firstNonEmptyString(target.user_id, target.sender_id, target.open_id);
  const receiveFlag = channelType === 'group' ? '--chat-id' : '--user-id';
  const idempotencySource = firstNonEmptyString(
    target.idempotency_key,
    target.idempotencyKey,
    target.source_message_id,
    target.message_id,
    target.id
  );
  const idempotencyKey = idempotencySource
    ? (target.idempotency_key || target.idempotencyKey || `ran-agent-feishu-${shortHash(idempotencySource)}`)
    : '';
  const args = [
    'im',
    '+messages-send',
    '--as',
    identity,
    receiveFlag,
    receiveId,
    '--text',
    String(text || ''),
  ];
  if (idempotencyKey) {
    args.push('--idempotency-key', idempotencyKey);
  }
  await execFileImpl(bin, args, {
    timeout: Math.max(1000, Number(env.FEISHU_SEND_TIMEOUT_SECONDS || 30) * 1000),
  });
  return { ok: true, receive_id_type: channelType === 'group' ? 'chat_id' : 'user_id', receive_id_hash: shortHash(receiveId) };
}

export function startFeishuBridge(options = {}) {
  const env = options.env || process.env;
  const logger = options.logger || console;
  if (String(env.FEISHU_BRIDGE_ENABLED || 'false').toLowerCase() !== 'true') {
    logger.info?.('[feishu-bridge] disabled');
    return { stop() {} };
  }
  const state = createFeishuBridgeState();
  const bin = String(env.FEISHU_LARK_CLI_BIN || 'lark-cli').trim() || 'lark-cli';
  const identity = normalizeLarkCliIdentity(env.FEISHU_LARK_CLI_IDENTITY);
  const eventName = String(env.FEISHU_EVENT_NAME || 'im.message.receive_v1').trim();
  let stopped = false;
  let child = null;
  let restarts = 0;
  const maxRestarts = Math.max(0, Number(env.FEISHU_BRIDGE_MAX_RESTARTS || 10));

  const start = () => {
    if (stopped || restarts > maxRestarts) return;
    child = (options.spawnImpl || spawn)(bin, ['event', 'consume', eventName, '--as', identity], { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout?.on('data', (chunk) => {
      for (const line of String(chunk || '').split('\n').filter(Boolean)) {
        handleFeishuEventLine(line, { state, logger, env, channelHub: options.channelHub }).catch((error) => {
          logger.error?.('[feishu-bridge] error', redactError(error));
        });
      }
    });
    child.stderr?.on('data', (chunk) => {
      const message = String(chunk || '').trim();
      if (isUnsupportedFeishuIdentityError(message)) {
        logger.error?.('[feishu-bridge] identity_error', message);
      } else {
        logger.warn?.('[feishu-bridge] stderr', message);
      }
    });
    child.on?.('exit', () => {
      if (!stopped) {
        restarts += 1;
        setTimeout(start, Math.max(100, Number(env.FEISHU_BRIDGE_POLL_INTERVAL_MS || 1000)));
      }
    });
  };
  start();
  return {
    stop() {
      stopped = true;
      child?.kill?.();
    },
  };
}

async function handleFeishuEventLine(line, { state, logger, env, channelHub }) {
  const parsed = parseFeishuEvent(line);
  const normalized = normalizeFeishuMessage(parsed);
  logger.log?.('[feishu-bridge] event_received', JSON.stringify(normalized.raw_event_meta));
  if (!state.markSeen(normalized.message_id)) return;
  logger.log?.('[feishu-bridge] normalized_message', JSON.stringify({
    message_id_hash: shortHash(normalized.message_id),
    conversation_id_hash: shortHash(normalized.conversation_id),
    sender_id_hash: shortHash(normalized.sender_id),
  }));
  const handler = channelHub || handleIncomingMessage;
  await handler(normalized, {
    env,
    logger,
    adapter: {
      async sendReply({ target, text, message }) {
        await sendFeishuReply({
          target: { ...target, source_message_id: message?.id || message?.message_id },
          text,
          env,
        });
        logger.log?.('[feishu-bridge] reply_sent', JSON.stringify({
          conversation_id_hash: shortHash(target.conversation_id),
        }));
      },
    },
  });
}

export function isUnsupportedFeishuIdentityError(error) {
  const text = error instanceof Error ? error.message : String(error || '');
  return /resolved identity "user" is not supported, this command only supports: bot/i.test(text);
}

export function redactFeishuMeta(meta = {}) {
  const output = {};
  for (const [key, value] of Object.entries(meta || {})) {
    if (/_id$|id$/i.test(key)) {
      output[`${key}_hash`] = shortHash(value);
    } else {
      output[key] = value;
    }
  }
  return output;
}

function extractFeishuText(content) {
  if (content && typeof content === 'object') {
    if (typeof content.text === 'string') return content.text;
    if (Array.isArray(content.content)) {
      return content.content.flatMap((line) => Array.isArray(line) ? line : [line])
        .map((part) => part?.text || '')
        .join('');
    }
    return '';
  }
  if (typeof content !== 'string') return '';
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed.text === 'string') return parsed.text;
    if (Array.isArray(parsed.content)) {
      return parsed.content.flatMap((line) => Array.isArray(line) ? line : [line])
        .map((part) => part?.text || '')
        .join('');
    }
  } catch {
    return content;
  }
  return content;
}

function normalizeLarkCliIdentity(value) {
  const identity = String(value || 'bot').trim().toLowerCase();
  return ['bot', 'user', 'auto'].includes(identity) ? identity : 'bot';
}

function redactError(error) {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/(token|secret|authorization|cookie)=([^\s&]+)/ig, '$1=[redacted]');
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) return text;
  }
  return '';
}
