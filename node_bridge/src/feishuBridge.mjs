import { spawn, execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { handleIncomingMessage } from './channelHub.mjs';
import { shortHash } from './identityMap.mjs';
import { getQuickAckConfig, quickAckDelay } from './quickAck.mjs';
import { resolveStateDir, setFeishuHomeDmTarget } from './runtimeState.mjs';
import { resolveStickerAsset } from './stickerCatalog.mjs';

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
  const messageType = String(message.message_type || message.msg_type || body.message_type || body.msg_type || '').trim().toLowerCase();
  const mediaResources = extractFeishuMediaResources({
    content: message.content,
    messageId,
    messageType,
  });
  return {
    id: messageId || `${Date.now()}-${shortHash(text)}`,
    message_id: messageId,
    platform: 'feishu',
    channel_type: channelType,
    conversation_id: chatId,
    sender_id: userId || 'unknown',
    text,
    media: [],
    media_resources: mediaResources,
    raw_event_meta: redactFeishuMeta({
      message_id: messageId,
      chat_id: chatId,
      user_id: userId,
      chat_type: chatType,
      media_resource_count: mediaResources.length,
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
  const sendTarget = buildLarkCliSendTarget(target, env);
  const args = buildLarkCliSendArgs({
    sendTarget,
    contentFlag: '--text',
    contentValue: String(text || ''),
  });
  await execFileImpl(bin, args, {
    timeout: Math.max(1000, Number(env.FEISHU_SEND_TIMEOUT_SECONDS || 30) * 1000),
  });
  return {
    ok: true,
    receive_id_type: sendTarget.receiveIdType,
    receive_id_hash: shortHash(sendTarget.receiveId),
  };
}

export async function sendFeishuMediaReply({
  target = {},
  media = null,
  text = '',
  execFileImpl = execFile,
  env = process.env,
} = {}) {
  const textValue = String(text || '').trim();
  const textResult = textValue
    ? await sendFeishuReply({ target, text: textValue, execFileImpl, env })
    : null;
  if (!media || typeof media !== 'object' || Array.isArray(media)) {
    return {
      ok: true,
      text_sent: Boolean(textResult),
      media_sent: false,
      receive_id_type: textResult?.receive_id_type || buildLarkCliSendTarget(target, env).receiveIdType,
      receive_id_hash: textResult?.receive_id_hash || shortHash(buildLarkCliSendTarget(target, env).receiveId),
    };
  }

  const asset = resolveStickerMediaForSend(media, env);
  const bin = String(env.FEISHU_LARK_CLI_BIN || 'lark-cli').trim() || 'lark-cli';
  const sendTarget = buildLarkCliSendTarget(target, env, { idempotencySuffix: 'media' });
  const timeout = Math.max(1000, Number(env.FEISHU_SEND_TIMEOUT_SECONDS || 30) * 1000);
  const isImage = String(asset.mime || '').trim().toLowerCase().startsWith('image/');
  const mediaCwd = path.dirname(asset.filePath);
  const mediaFileName = path.basename(asset.filePath);
  let mediaMethod = isImage ? 'image' : 'file';

  if (isImage) {
    try {
      await execFileImpl(bin, buildLarkCliSendArgs({
        sendTarget,
        contentFlag: '--image',
        contentValue: mediaFileName,
      }), { timeout, cwd: mediaCwd });
      return buildFeishuMediaResult({ sendTarget, textResult, mediaMethod: 'image' });
    } catch {
      mediaMethod = 'file';
    }
  }

  try {
    await execFileImpl(bin, buildLarkCliSendArgs({
      sendTarget,
      contentFlag: '--file',
      contentValue: mediaFileName,
    }), { timeout, cwd: mediaCwd });
  } catch {
    throw new Error('feishu media send failed');
  }
  return buildFeishuMediaResult({ sendTarget, textResult, mediaMethod });
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

export async function handleFeishuEventLine(line, { state, logger, env, channelHub, execFileImpl }) {
  const parsed = parseFeishuEvent(line);
  const normalized = normalizeFeishuMessage(parsed);
  const effectiveExecFileImpl = typeof execFileImpl === 'function'
    ? execFileImpl
    : (typeof env?.execFileImpl === 'function' ? env.execFileImpl : execFile);
  logger.log?.('[feishu-bridge] event_received', JSON.stringify(normalized.raw_event_meta));
  if (!state.markSeen(normalized.message_id)) return;
  if (normalized.channel_type === 'dm') {
    const saved = setFeishuHomeDmTarget(normalized, env);
    if (saved) {
      logger.log?.('[feishu-bridge] home_dm_target_recorded', JSON.stringify({
        conversation_id_hash: shortHash(saved.conversation_id),
        sender_id_hash: shortHash(saved.sender_id),
      }));
    }
  }
  const handler = channelHub || handleIncomingMessage;
  const quickAckConfig = getQuickAckConfig(env, 'feishu');
  let gateFinalSend = false;
  let releaseFinalSend = () => {};
  let finalSendGate = Promise.resolve();
  const processMessage = async () => {
    normalized.media = await downloadFeishuInboundMedia(normalized, {
      env,
      logger,
      execFileImpl: effectiveExecFileImpl,
    });
    logger.log?.('[feishu-bridge] normalized_message', JSON.stringify({
      message_id_hash: shortHash(normalized.message_id),
      conversation_id_hash: shortHash(normalized.conversation_id),
      sender_id_hash: shortHash(normalized.sender_id),
      media_count: Array.isArray(normalized.media) ? normalized.media.length : 0,
    }));
    await handler(normalized, {
      env,
      logger,
      adapter: {
        async sendReply({ target, text, media, message }) {
          if (gateFinalSend) {
            await finalSendGate;
          }
          const sendOptions = {
            target: { ...target, source_message_id: message?.id || message?.message_id },
            text,
            env,
            execFileImpl: effectiveExecFileImpl,
          };
          if (media) {
            await sendFeishuMediaReply({ ...sendOptions, media });
          } else {
            await sendFeishuReply(sendOptions);
          }
          logger.log?.('[feishu-bridge] reply_sent', JSON.stringify({
            conversation_id_hash: shortHash(target.conversation_id),
            media_sent: Boolean(media),
          }));
        },
      },
    });
  };
  if (!quickAckConfig.enabled) {
    await processMessage();
    return;
  }
  const processPromise = processMessage();
  const winner = await Promise.race([
    processPromise.then(() => 'done'),
    quickAckDelay(quickAckConfig.timeoutMs).then(() => 'timeout'),
  ]);
  if (winner === 'done') return;
  finalSendGate = new Promise((resolve) => {
    releaseFinalSend = resolve;
  });
  gateFinalSend = true;
  processPromise.catch((error) => {
    logger.warn?.('[feishu-bridge] async final reply failed', redactError(error));
  });
  try {
    await sendFeishuReply({
      target: {
        channel_type: normalized.channel_type,
        conversation_id: normalized.conversation_id,
        sender_id: normalized.sender_id,
        source_message_id: `${normalized.id || normalized.message_id || Date.now()}:quick_ack`,
      },
      text: quickAckConfig.ackText,
      env,
      execFileImpl: effectiveExecFileImpl,
    });
  } finally {
    releaseFinalSend();
  }
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

function parseFeishuContent(content) {
  if (content && typeof content === 'object' && !Array.isArray(content)) {
    return content;
  }
  if (typeof content !== 'string') {
    return {};
  }
  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function extractFeishuMediaResources({ content, messageId, messageType }) {
  const parsed = parseFeishuContent(content);
  const normalizedType = String(messageType || '').trim().toLowerCase();
  const resources = [];
  const imageKey = firstNonEmptyString(parsed.image_key, parsed.imageKey);
  if (imageKey || normalizedType === 'image') {
    const fileKey = imageKey || firstNonEmptyString(parsed.file_key, parsed.fileKey);
    if (fileKey && messageId) {
      resources.push(buildFeishuMediaResource({
        messageId,
        fileKey,
        resourceType: 'image',
        fileName: firstNonEmptyString(parsed.file_name, parsed.fileName, parsed.name),
      }));
    }
  }

  const fileKey = firstNonEmptyString(parsed.file_key, parsed.fileKey);
  if (fileKey && normalizedType === 'file' && messageId) {
    resources.push(buildFeishuMediaResource({
      messageId,
      fileKey,
      resourceType: 'file',
      fileName: firstNonEmptyString(parsed.file_name, parsed.fileName, parsed.name),
    }));
  }
  return dedupeFeishuResources(resources);
}

function buildFeishuMediaResource({ messageId, fileKey, resourceType, fileName }) {
  const safeFileName = sanitizeFeishuFileName(fileName);
  const mimeType = inferFeishuMimeType({ resourceType, fileName: safeFileName, fileKey });
  return {
    messageId,
    fileKey,
    resourceType,
    fileName: safeFileName,
    mimeType,
    mediaType: mimeType.startsWith('image/') ? 'image' : resourceType,
  };
}

function dedupeFeishuResources(resources) {
  const seen = new Set();
  const output = [];
  for (const resource of resources) {
    const key = `${resource.messageId}:${resource.fileKey}:${resource.resourceType}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(resource);
  }
  return output;
}

async function downloadFeishuInboundMedia(normalized, { env = process.env, logger = console, execFileImpl = execFile } = {}) {
  const resources = Array.isArray(normalized.media_resources) ? normalized.media_resources : [];
  if (resources.length === 0) {
    return [];
  }
  const inboundDir = path.join(resolveStateDir(env), 'feishu', 'inbound');
  fs.mkdirSync(inboundDir, { recursive: true });
  const bin = String(env.FEISHU_LARK_CLI_BIN || 'lark-cli').trim() || 'lark-cli';
  const identity = normalizeLarkCliIdentity(env.FEISHU_LARK_CLI_IDENTITY);
  const timeout = Math.max(1000, Number(env.FEISHU_DOWNLOAD_TIMEOUT_SECONDS || env.FEISHU_SEND_TIMEOUT_SECONDS || 30) * 1000);
  const media = [];
  const warnings = [];

  for (const resource of resources.slice(0, 10)) {
    const output = buildFeishuInboundOutputName(resource);
    const outputPath = path.join(inboundDir, output);
    try {
      await execFileImpl(bin, [
        'im',
        '+messages-resources-download',
        '--message-id',
        resource.messageId,
        '--file-key',
        resource.fileKey,
        '--type',
        resource.resourceType,
        '--output',
        output,
        '--as',
        identity,
      ], { cwd: inboundDir, timeout });
      if (!fs.existsSync(outputPath)) {
        throw new Error('download command did not create output file');
      }
      media.push({
        filePath: outputPath,
        mimeType: resource.mimeType,
        type: resource.mediaType,
      });
    } catch {
      const warning = {
        code: 'FEISHU_MEDIA_DOWNLOAD_FAILED',
        resource_type: resource.resourceType,
        file_key_hash: shortHash(resource.fileKey),
      };
      warnings.push(warning);
      logger.warn?.('[feishu-bridge] inbound_media_download_failed', JSON.stringify(warning));
    }
  }
  if (warnings.length > 0) {
    normalized.raw_event_meta = {
      ...(normalized.raw_event_meta || {}),
      media_warnings: warnings,
    };
  }
  return media;
}

function buildFeishuInboundOutputName(resource) {
  const extension = path.extname(resource.fileName || '').replace(/^\./, '').toLowerCase()
    || extensionForMime(resource.mimeType)
    || (resource.resourceType === 'image' ? 'png' : 'bin');
  return `feishu-${shortHash(resource.messageId)}-${shortHash(resource.fileKey)}.${extension}`;
}

function sanitizeFeishuFileName(value) {
  const base = path.basename(String(value || '').trim());
  return base.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
}

function inferFeishuMimeType({ resourceType, fileName, fileKey }) {
  const ext = path.extname(fileName || fileKey || '').toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  if (resourceType === 'image') return 'image/png';
  return 'application/octet-stream';
}

function extensionForMime(mimeType) {
  const mime = String(mimeType || '').toLowerCase();
  if (mime === 'image/png') return 'png';
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/gif') return 'gif';
  if (mime === 'image/webp') return 'webp';
  return '';
}

function normalizeLarkCliIdentity(value) {
  const identity = String(value || 'bot').trim().toLowerCase();
  return ['bot', 'user', 'auto'].includes(identity) ? identity : 'bot';
}

function buildLarkCliSendTarget(target = {}, env = process.env, { idempotencySuffix = '' } = {}) {
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
  const explicitIdempotency = target.idempotency_key || target.idempotencyKey || '';
  const idempotencyKey = explicitIdempotency
    ? [explicitIdempotency, idempotencySuffix].filter(Boolean).join('-')
    : (idempotencySource
        ? `ran-agent-feishu-${shortHash([idempotencySource, idempotencySuffix].filter(Boolean).join(':'))}`
        : '');
  return {
    identity,
    receiveId,
    receiveFlag,
    receiveIdType: channelType === 'group' ? 'chat_id' : 'user_id',
    idempotencyKey,
  };
}

function buildLarkCliSendArgs({ sendTarget, contentFlag, contentValue }) {
  const args = [
    'im',
    '+messages-send',
    '--as',
    sendTarget.identity,
    sendTarget.receiveFlag,
    sendTarget.receiveId,
    contentFlag,
    contentValue,
  ];
  if (sendTarget.idempotencyKey) {
    args.push('--idempotency-key', sendTarget.idempotencyKey);
  }
  return args;
}

function resolveStickerMediaForSend(media, env = process.env) {
  if (media.source !== 'sticker_catalog' || media.kind !== 'sticker') {
    throw new Error('unsupported feishu media');
  }
  const stickerId = firstNonEmptyString(media.stickerId);
  if (!stickerId) {
    throw new Error('sticker media unavailable');
  }
  try {
    return resolveStickerAsset(stickerId, { env });
  } catch {
    throw new Error('sticker media unavailable');
  }
}

function buildFeishuMediaResult({ sendTarget, textResult, mediaMethod }) {
  return {
    ok: true,
    text_sent: Boolean(textResult),
    media_sent: true,
    media_method: mediaMethod,
    receive_id_type: sendTarget.receiveIdType,
    receive_id_hash: shortHash(sendTarget.receiveId),
  };
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
