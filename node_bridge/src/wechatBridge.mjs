/**
 * Thin bridge layer that maps WeChat text messages into internal bridge requests.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { createReplyBackend } from './replyBackend.mjs';
import { handleIncomingMessage } from './channelHub.mjs';
import { createInboundMessageBuffer } from './inboundMessageBuffer.mjs';
import { resolveStateDir } from './runtimeState.mjs';

export { createInboundMessageBuffer } from './inboundMessageBuffer.mjs';

let _defaultBuffer = null;

function getDefaultBuffer(env, logger) {
  if (!_defaultBuffer) {
    _defaultBuffer = createInboundMessageBuffer({
      logger,
      mediaReplyGraceMs: Number(env?.WECHAT_MEDIA_REPLY_GRACE_MS || 12000),
      textRefWaitMs: Number(env?.WECHAT_TEXT_REF_WAIT_MS || 8000),
      pendingMediaTtlMs: Number(env?.WECHAT_PENDING_MEDIA_TTL_MS || 600000),
      mediaOnlyIdleReply: String(env?.WECHAT_MEDIA_ONLY_IDLE_REPLY || 'false').toLowerCase() === 'true',
    });
  }
  return _defaultBuffer;
}

const DEFAULT_WEIXIN_SDK_INBOUND_MEDIA_DIR = '/tmp/weixin-agent/media/inbound';

export function mapWeChatMessageToBridgeRequest(message, options = {}) {
  const env = options.env || process.env;
  const logger = options.logger || console;
  const imageUrls = extractImageUrlsFromWeChatRequest(message);
  const media = extractMediaAttachmentsFromWeChatRequest(message, { env, logger });

  const payload = {
    text: extractTextFromWeChatRequest(message),
    sender_id: extractConversationIdFromWeChatRequest(message),
    conversation_id: extractConversationIdFromWeChatRequest(message),
    channel: 'wechat',
    image_urls: imageUrls,
    route_hint: hasVisualAttachment(imageUrls, media) ? 'vision_understand' : '',
  };
  const messageBatch = extractMessageBatchFromWeChatRequest(message);
  if (messageBatch.length > 0) {
    payload.message_batch = messageBatch;
  }

  if (media.length > 0) {
    payload.media = media;
  }

  return payload;
}

export async function handleWeChatTextMessage(message, options = {}) {
  const logger = options.logger || console;
  const backend = options.backend || createReplyBackend({
    env: options.env,
    logger,
    fetchImpl: options.fetchImpl,
    execImpl: options.execImpl,
    ingestImpl: options.ingestImpl,
    tempDir: options.tempDir,
    chatImpl: options.chatImpl,
  });
  const payload = mapWeChatMessageToBridgeRequest(message, {
    env: options.env,
    logger,
  });

  const mediaCount = Array.isArray(payload.media) ? payload.media.length : 0;
  if (!payload.text.trim() && payload.image_urls.length === 0 && mediaCount === 0) {
    logger.info?.('ignoring empty wechat message');
    return '暂未收到可处理的消息内容。';
  }

  if (!payload.sender_id.trim()) {
    logger.warn?.('wechat message missing sender id, returning fallback text');
    return options.fallbackText || '暂时无法连接到 personal agent，请稍后再试。';
  }

  // Turn aggregation: buffer media-only messages, merge with text-ref
  const buffer = options.buffer || getDefaultBuffer(options.env, logger);
  const buffered = await buffer.processInbound(payload);
  if (buffered.action === 'hold') {
    logger.log?.(`[buffer] media held sender=${payload.sender_id} pending=${buffered.pendingMediaCount || 0}`);
    return '';
  }
  const mergedPayload = buffered.payload;

  try {
    const mediaMerged = Array.isArray(mergedPayload.media) ? mergedPayload.media.length : 0;
    logger.info?.(`handling wechat message sender_id=${mergedPayload.sender_id} channel=${mergedPayload.channel} media_merged=${mediaMerged}`);
    const response = await handleIncomingMessage(normalizeWechatMessage(mergedPayload), {
      env: options.env,
      logger,
      replyBackend: backend,
      fetchImpl: options.fetchImpl,
      mediaContextOptions: options.mediaContextOptions,
    });
    const replyText = sanitizeReplyText(response.replyText, {
      enabled: String(options.env?.NODE_BRIDGE_SANITIZE_META_LEAK || 'true').toLowerCase() !== 'false',
    });
    const result = {
      replyText,
      followUpMessages: Array.isArray(response.followUpMessages) ? response.followUpMessages : [],
      media: response.media && typeof response.media === 'object' ? response.media : null,
    };
    if (options.returnResult === true) {
      return result;
    }
    return result.replyText;
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    logger.error?.(`reply backend failed: ${messageText}`);
    return options.fallbackText || '暂时无法连接到 personal agent，请稍后再试。';
  }
}

export function normalizeWechatMessage(payload = {}) {
  return {
    id: payload.id || payload.message_id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    platform: 'wechat',
    channel_type: 'dm',
    conversation_id: payload.conversation_id || payload.sender_id,
    sender_id: payload.sender_id,
    text: payload.text || '',
    image_urls: Array.isArray(payload.image_urls) ? payload.image_urls : [],
    media: Array.isArray(payload.media)
      ? payload.media.map((item) => ({
        type: item.type || '',
        local_path: item.filePath || item.local_path || '',
        mime_type: item.mimeType || item.mime_type || '',
      }))
      : [],
    route_hint: payload.route_hint || '',
    message_batch: Array.isArray(payload.message_batch) ? payload.message_batch : [],
    created_at: Date.now(),
  };
}

function extractMessageBatchFromWeChatRequest(request) {
  const candidate = getValueByPath(request, ['messageBatch']);
  if (!Array.isArray(candidate)) {
    return [];
  }
  return candidate
    .map((item, index) => ({
      index: Number.isFinite(Number(item?.index)) ? Number(item.index) : index + 1,
      text: typeof item?.text === 'string' ? item.text.trim() : '',
    }))
    .filter((item) => item.text);
}

export function sanitizeReplyText(rawText, options = {}) {
  const text = String(rawText || '').trim();
  const enabled = options.enabled !== false;
  if (!enabled || !text) {
    return text;
  }

  const hasInternalLeakHint = (
    /"recipient_name"\s*:\s*"functions\./i.test(text) ||
    /(?:^|\n)\s*apply_patch\b/i.test(text) ||
    /<analysis>/i.test(text) ||
    /tool[_ -]?(?:call|result|use)/i.test(text)
  );
  if (!hasInternalLeakHint) {
    return text;
  }

  const strippedCodeFences = text.replace(/```[\s\S]*?```/g, '').trim();
  const strippedJsonBlob = strippedCodeFences.replace(/^\s*[\[{][\s\S]*[\]}]\s*$/g, '').trim();
  const strippedMetaLines = strippedJsonBlob
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (line) =>
        line &&
        !/^recipient_name\s*:/i.test(line) &&
        !/^parameters\s*:/i.test(line) &&
        !/^tool(?:_use|_call|_result)?\s*:/i.test(line)
    )
    .join('\n')
    .trim();
  if (strippedMetaLines) {
    return strippedMetaLines;
  }
  return '刚才执行任务时出现了异常输出，后续会继续处理并给出干净结论。';
}

export function extractTextFromWeChatRequest(request) {
  return firstNonEmptyString(
    getValueByPath(request, ['text']),
    getValueByPath(request, ['message', 'text']),
    getValueByPath(request, ['payload', 'text']),
    getValueByPath(request, ['content', 'text']),
  );
}

export function extractConversationIdFromWeChatRequest(request) {
  return firstNonEmptyString(
    getValueByPath(request, ['conversationId']),
    getValueByPath(request, ['message', 'conversationId']),
    getValueByPath(request, ['payload', 'conversationId']),
    getValueByPath(request, ['conversation', 'id']),
  );
}

export function extractImageUrlsFromWeChatRequest(request) {
  const candidates = [
    getValueByPath(request, ['imageUrls']),
    getValueByPath(request, ['imageUrl']),
    getValueByPath(request, ['message', 'imageUrls']),
    getValueByPath(request, ['message', 'imageUrl']),
    getValueByPath(request, ['payload', 'imageUrls']),
    getValueByPath(request, ['payload', 'imageUrl']),
    getValueByPath(request, ['content', 'imageUrls']),
    getValueByPath(request, ['content', 'imageUrl']),
  ];

  const normalized = [];
  for (const candidate of candidates) {
    for (const url of normalizeImageCandidate(candidate)) {
      if (!normalized.includes(url)) {
        normalized.push(url);
      }
    }
  }
  return normalized;
}

export function extractMediaAttachmentsFromWeChatRequest(request, options = {}) {
  const env = options.env || process.env;
  const logger = options.logger || console;
  const candidates = [
    getValueByPath(request, ['media']),
    getValueByPath(request, ['message', 'media']),
    getValueByPath(request, ['message', 'attachments']),
    getValueByPath(request, ['payload', 'media']),
    getValueByPath(request, ['payload', 'attachments']),
    getValueByPath(request, ['content', 'media']),
    getValueByPath(request, ['content', 'attachments']),
    getValueByPath(request, ['message', 'content', 'media']),
    getValueByPath(request, ['message', 'content', 'attachments']),
  ];

  const normalized = [];
  for (const candidate of candidates) {
    const items = Array.isArray(candidate) ? candidate : (candidate ? [candidate] : []);
    for (const item of normalizeMediaCandidate(items, { env, logger })) {
      if (!normalized.some((existing) => areSameMediaAttachment(existing, item))) {
        normalized.push(item);
      }
    }
  }
  return normalized;
}

function normalizeMediaCandidate(candidate, options = {}) {
  if (!candidate) {
    return [];
  }
  if (Array.isArray(candidate)) {
    return candidate.flatMap((item) => normalizeMediaCandidate(item, options));
  }
  if (typeof candidate !== 'object') {
    return [];
  }

  // Try multiple field names for file path
  let filePath = '';
  for (const key of ['filePath', 'path', 'localPath', 'file_path', 'url', 'fileUrl']) {
    const val = candidate[key];
    if (typeof val === 'string' && val.trim()) {
      filePath = val.trim();
      break;
    }
  }
  if (!filePath) {
    return [];
  }

  // Try multiple field names for mime type
  let mimeType = '';
  for (const key of ['mimeType', 'mime_type', 'mime', 'contentType', 'content_type']) {
    const val = candidate[key];
    if (typeof val === 'string' && val.trim()) {
      mimeType = val.trim().toLowerCase();
      break;
    }
  }

  // Try multiple field names for type
  let type = '';
  for (const key of ['type', 'mediaType', 'media_type', 'kind']) {
    const val = candidate[key];
    if (typeof val === 'string' && val.trim()) {
      type = val.trim().toLowerCase();
      break;
    }
  }

  return [
    materializeWeixinSdkInboundMedia({
      filePath,
      mimeType,
      type,
    }, options),
  ];
}

function materializeWeixinSdkInboundMedia(media, options = {}) {
  const env = options.env || process.env;
  const sourcePath = String(media.filePath || '').trim();
  if (!sourcePath || !path.isAbsolute(sourcePath) || isRemoteMediaPath(sourcePath)) {
    return media;
  }
  const resolvedSource = path.resolve(sourcePath);
  if (!weixinSdkInboundSourceDirs(env).some((dir) => isPathInsideDirectory(resolvedSource, dir))) {
    return media;
  }

  try {
    const stat = fs.statSync(resolvedSource);
    if (!stat.isFile()) {
      return media;
    }
    const targetDir = path.join(resolveStateDir(env), 'wechat', 'inbound');
    fs.mkdirSync(targetDir, { recursive: true });
    const targetPath = path.join(targetDir, safeInboundMediaFilename(resolvedSource, media.mimeType));
    fs.copyFileSync(resolvedSource, targetPath);
    return {
      ...media,
      filePath: targetPath,
    };
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'copy_failed';
    options.logger?.warn?.(`[wechat-bridge] inbound media materialize skipped reason=${code}`);
    return media;
  }
}

function weixinSdkInboundSourceDirs(env = process.env) {
  const configured = String(env.WEIXIN_SDK_INBOUND_MEDIA_DIRS || env.WECHAT_SDK_INBOUND_MEDIA_DIRS || '')
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  const entries = configured.length > 0 ? configured : [DEFAULT_WEIXIN_SDK_INBOUND_MEDIA_DIR];
  return entries.map((entry) => path.resolve(entry));
}

function isPathInsideDirectory(filePath, directory) {
  const resolvedFile = path.resolve(filePath);
  const resolvedDirectory = path.resolve(directory);
  const prefix = resolvedDirectory.endsWith(path.sep) ? resolvedDirectory : `${resolvedDirectory}${path.sep}`;
  return resolvedFile === resolvedDirectory || resolvedFile.startsWith(prefix);
}

function isRemoteMediaPath(value) {
  return /^https?:\/\//i.test(String(value || '').trim());
}

function safeInboundMediaFilename(sourcePath, mimeType = '') {
  const ext = safeMediaExtension(sourcePath, mimeType);
  const basename = path.basename(sourcePath, path.extname(sourcePath))
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 64) || 'media';
  const nonce = crypto.randomBytes(4).toString('hex');
  return `${Date.now()}-${nonce}-${basename}${ext}`;
}

function safeMediaExtension(sourcePath, mimeType = '') {
  const sourceExt = path.extname(sourcePath).toLowerCase().replace(/[^a-z0-9.]/g, '');
  if (sourceExt && sourceExt.length <= 12) {
    return sourceExt;
  }
  const normalizedMime = String(mimeType || '').trim().toLowerCase();
  if (normalizedMime.includes('png')) return '.png';
  if (normalizedMime.includes('jpeg') || normalizedMime.includes('jpg')) return '.jpg';
  if (normalizedMime.includes('webp')) return '.webp';
  if (normalizedMime.includes('gif')) return '.gif';
  if (normalizedMime.includes('mp4')) return '.mp4';
  if (normalizedMime.includes('wav')) return '.wav';
  if (normalizedMime.includes('mpeg')) return '.mp3';
  return '.bin';
}

function areSameMediaAttachment(left, right) {
  return (
    left.filePath === right.filePath &&
    left.mimeType === right.mimeType &&
    left.type === right.type
  );
}

function hasVisualAttachment(imageUrls, media) {
  if (Array.isArray(imageUrls) && imageUrls.length > 0) {
    return true;
  }
  return Array.isArray(media) && media.some((item) => isImageMedia(item) || isVideoMedia(item));
}

function isImageMedia(media) {
  if (!media || typeof media !== 'object') {
    return false;
  }
  if (typeof media.mimeType === 'string' && media.mimeType.startsWith('image/')) {
    return true;
  }
  if (typeof media.type === 'string') {
    const normalizedType = media.type.trim().toLowerCase();
    return normalizedType === 'image' || normalizedType === 'pic' || normalizedType === 'photo';
  }
  return false;
}

function isVideoMedia(media) {
  if (!media || typeof media !== 'object') {
    return false;
  }
  if (typeof media.mimeType === 'string' && media.mimeType.startsWith('video/')) {
    return true;
  }
  if (typeof media.type === 'string') {
    const normalizedType = media.type.trim().toLowerCase();
    return normalizedType === 'video' || normalizedType === 'movie' || normalizedType === 'clip';
  }
  return false;
}

function normalizeImageCandidate(candidate) {
  if (typeof candidate === 'string' && candidate.trim() !== '') {
    return [candidate.trim()];
  }
  if (!Array.isArray(candidate)) {
    return [];
  }
  return candidate.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim());
}

function firstNonEmptyString(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') {
      return candidate;
    }
  }
  return '';
}

function getValueByPath(root, path) {
  let current = root;
  for (const part of path) {
    if (!current || typeof current !== 'object' || !(part in current)) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

/**
 * Summarize WeChat request shape for debugging.
 * @param {any} request
 * @returns {{
 *   topLevelKeys: string[],
 *   nestedObjectKeys: Record<string, string[]>,
 *   fieldPresence: { filePathPaths: string[] }
 * }}
 */
export function summarizeWeChatRequestShape(request) {
  const topLevelKeys = listObjectKeys(request);
  const nestedObjectKeys = {};
  const fieldPresence = {
    filePathPaths: [],
  };
  for (const key of topLevelKeys) {
    const value = request?.[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      nestedObjectKeys[key] = listObjectKeys(value);
      collectFieldPresence(value, [`request.${key}`], fieldPresence);
    }
    if (Array.isArray(value) && value.length > 0 && value[0] && typeof value[0] === 'object') {
      nestedObjectKeys[`${key}[0]`] = listObjectKeys(value[0]);
      collectFieldPresence(value[0], [`request.${key}[0]`], fieldPresence);
    }
  }
  return { topLevelKeys, nestedObjectKeys, fieldPresence };
}

function listObjectKeys(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [];
  }
  return Object.keys(value).sort();
}

function collectFieldPresence(value, pathParts, fieldPresence) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return;
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    const nextPath = [...pathParts, key];
    if (key === 'filePath' && typeof nestedValue === 'string' && nestedValue.trim()) {
      fieldPresence.filePathPaths.push(nextPath.join('.'));
    }
    if (nestedValue && typeof nestedValue === 'object') {
      if (Array.isArray(nestedValue)) {
        nestedValue.forEach((item, index) => {
          collectFieldPresence(item, [...nextPath, String(index)], fieldPresence);
        });
      } else {
        collectFieldPresence(nestedValue, nextPath, fieldPresence);
      }
    }
  }
}
