/**
 * Thin bridge layer that maps WeChat text messages into internal bridge requests.
 */

import { createReplyBackend } from './replyBackend.mjs';

export function mapWeChatMessageToBridgeRequest(message) {
  const imageUrls = extractImageUrlsFromWeChatRequest(message);
  const media = extractMediaAttachmentsFromWeChatRequest(message);

  const payload = {
    text: extractTextFromWeChatRequest(message),
    sender_id: extractConversationIdFromWeChatRequest(message),
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
  const payload = mapWeChatMessageToBridgeRequest(message);

  const mediaCount = Array.isArray(payload.media) ? payload.media.length : 0;
  if (!payload.text.trim() && payload.image_urls.length === 0 && mediaCount === 0) {
    logger.info?.('ignoring empty wechat message');
    return '我暂时还没收到可处理的消息内容。';
  }

  if (!payload.sender_id.trim()) {
    logger.warn?.('wechat message missing sender id, returning fallback text');
    return options.fallbackText || '暂时无法连接到 personal agent，请稍后再试。';
  }

  try {
    logger.info?.(`handling wechat message sender_id=${payload.sender_id} channel=${payload.channel}`);
    const response = await backend.getReply(payload, {
      fetchImpl: options.fetchImpl,
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
  return '我刚才执行任务时出现了异常输出，我会继续处理并给你干净结论。';
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

export function extractMediaAttachmentsFromWeChatRequest(request) {
  const candidates = [
    getValueByPath(request, ['media']),
    getValueByPath(request, ['message', 'media']),
    getValueByPath(request, ['payload', 'media']),
    getValueByPath(request, ['content', 'media']),
  ];

  const normalized = [];
  for (const candidate of candidates) {
    const items = Array.isArray(candidate) ? candidate : (candidate ? [candidate] : []);
    for (const item of normalizeMediaCandidate(items)) {
      if (!normalized.some((existing) => areSameMediaAttachment(existing, item))) {
        normalized.push(item);
      }
    }
  }
  return normalized;
}

function normalizeMediaCandidate(candidate) {
  if (!candidate) {
    return [];
  }
  if (Array.isArray(candidate)) {
    return candidate.flatMap((item) => normalizeMediaCandidate(item));
  }
  if (typeof candidate !== 'object') {
    return [];
  }

  const filePath = typeof candidate.filePath === 'string' ? candidate.filePath.trim() : '';
  if (!filePath) {
    return [];
  }

  const mimeType = typeof candidate.mimeType === 'string' ? candidate.mimeType.trim().toLowerCase() : '';
  const type = typeof candidate.type === 'string' ? candidate.type.trim().toLowerCase() : '';
  return [
    {
      filePath,
      mimeType,
      type,
    },
  ];
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
