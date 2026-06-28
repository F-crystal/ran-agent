import { createReplyBackend } from './replyBackend.mjs';
import {
  getGlobalUserId,
  getHermesSessionId,
  getHermesSessionKey,
  getStableConversationKey,
  shortHash,
} from './identityMap.mjs';
import {
  appendTurn,
  buildContinuityNote,
  getActiveTopicContext,
  getGlobalRecentHistory,
  getGlobalTimelineConfig,
  getLocalRecentHistory,
} from './globalTimeline.mjs';

export async function handleIncomingMessage(normalizedMessage = {}, options = {}) {
  const env = options.env || process.env;
  const logger = options.logger || console;
  const message = normalizeIncomingMessage(normalizedMessage);
  const globalUserId = getGlobalUserId(message, { env });
  const timelineConfig = getGlobalTimelineConfig(env);
  const timelineNow = Number(message.created_at || Date.now());
  const localRecent = getLocalRecentHistory({
    timelinePath: timelineConfig.timelinePath,
    platform: message.platform,
    conversation_id: message.conversation_id,
    global_user_id: globalUserId,
    limit: Number(env.HERMES_RECENT_TEXT_TURNS || 10) * 2,
    charBudget: Number(env.HERMES_RECENT_TEXT_CHAR_BUDGET || 6000),
    now: timelineNow,
    maxAgeHours: timelineConfig.continuityFreshnessHours,
  });
  const requestPriorMessages = normalizePriorMessages(message.prior_messages);
  const localRecentForHermes = [...localRecent, ...requestPriorMessages]
    .slice(-Math.max(2, Number(env.HERMES_RECENT_TEXT_TURNS || 10) * 2));
  const globalRecent = getGlobalRecentHistory({
    timelinePath: timelineConfig.timelinePath,
    global_user_id: globalUserId,
    limit: Number(env.HERMES_GLOBAL_RECENT_TURNS || timelineConfig.globalRecentTurns) * 2,
    charBudget: Number(env.HERMES_GLOBAL_RECENT_CHAR_BUDGET || timelineConfig.globalRecentCharBudget),
    now: timelineNow,
    maxAgeHours: timelineConfig.continuityFreshnessHours,
  });
  const activeTopicContext = getActiveTopicContext({
    timelinePath: timelineConfig.timelinePath,
    global_user_id: globalUserId,
    charBudget: Number(env.HERMES_ACTIVE_TOPIC_CHAR_BUDGET || timelineConfig.activeTopicCharBudget),
    now: timelineNow,
    freshnessHours: timelineConfig.continuityFreshnessHours,
  });
  const activeTopic = activeTopicContext.activeTopic;
  const staleContext = activeTopicContext.staleContext;
  const continuityNote = buildContinuityNote({ message, localRecent: localRecentForHermes, globalRecent, activeTopic, staleContext });

  safeAppendTurn({
    timelinePath: timelineConfig.timelinePath,
    id: message.id,
    global_user_id: globalUserId,
    platform: message.platform,
    channel_type: message.channel_type,
    conversation_id: message.conversation_id,
    sender_id: message.sender_id,
    role: 'user',
    text: message.text,
    media_summary: summarizeMedia(message.media),
    source_message_id: message.id,
    created_at: message.created_at,
    tags: inferTags(message),
  }, logger);

  logger.log?.('[channel-hub] incoming_message', JSON.stringify({
    platform: message.platform,
    channel_type: message.channel_type,
    conversation_id_hash: shortHash(message.conversation_id),
    sender_id_hash: shortHash(message.sender_id),
    global_user_id_hash: shortHash(globalUserId),
  }));

  const backend = options.replyBackend || createReplyBackend({
    env,
    logger,
    fetchImpl: options.fetchImpl,
    execImpl: options.execImpl,
    ingestImpl: options.ingestImpl,
    tempDir: options.tempDir,
    chatImpl: options.chatImpl,
    actionRepairImpl: options.actionRepairImpl,
    pendingActionExecutorImpl: options.pendingActionExecutorImpl,
  });
  const backendMessage = {
    ...message,
    global_user_id: globalUserId,
    stable_conversation_key: getStableConversationKey(message),
    hermes_session_id: getHermesSessionId(message),
    hermes_session_key: getHermesSessionKey(globalUserId),
    recent_local_history: localRecentForHermes,
    recent_global_history: globalRecent,
    active_topic: activeTopic,
    stale_context: staleContext,
    continuity_note: continuityNote,
  };
  const response = await backend.getReply(backendMessage, {
    fetchImpl: options.fetchImpl,
    execFileImpl: options.execFileImpl,
    mediaContextOptions: options.mediaContextOptions,
  });

  safeAppendTurn({
    timelinePath: timelineConfig.timelinePath,
    id: `${message.id || Date.now()}-assistant`,
    global_user_id: globalUserId,
    platform: message.platform,
    channel_type: message.channel_type,
    conversation_id: message.conversation_id,
    sender_id: 'assistant',
    role: 'assistant',
    text: response.replyText || '',
    media_summary: summarizeReplyMedia(response.media),
    source_message_id: message.id,
    created_at: Date.now(),
    tags: inferTags(message),
  }, logger);

  if (options.adapter?.sendReply) {
    await options.adapter.sendReply({
      target: buildReplyTarget(message),
      text: response.replyText || '',
      media: response.media || null,
      message,
    });
  }
  return response;
}

function safeAppendTurn(turn, logger) {
  try {
    return appendTurn(turn);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger?.warn?.(`[channel-hub] timeline append skipped: ${message}`);
    return null;
  }
}

export function normalizeIncomingMessage(input = {}) {
  const platform = normalizePlatform(input.platform);
  const channelType = String(input.channel_type || input.channelType || (platform === 'desktop' ? 'desktop' : 'dm')).trim().toLowerCase();
  const conversationId = firstNonEmptyString(input.conversation_id, input.conversationId, input.sender_id, input.senderId) || `${platform}:unknown`;
  const senderId = firstNonEmptyString(input.sender_id, input.senderId, input.client_id, conversationId) || 'unknown';
  return {
    id: firstNonEmptyString(input.id, input.message_id, input.messageId) || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    platform,
    channel_type: ['dm', 'group', 'desktop'].includes(channelType) ? channelType : 'dm',
    conversation_id: conversationId,
    sender_id: senderId,
    sender_display_name: String(input.sender_display_name || input.senderDisplayName || '').trim() || undefined,
    text: String(input.text || '').trim(),
    media: normalizeMedia(input.media),
    raw_event_meta: input.raw_event_meta && typeof input.raw_event_meta === 'object' ? input.raw_event_meta : {},
    prior_messages: Array.isArray(input.prior_messages) ? input.prior_messages : [],
    route_hint: String(input.route_hint || '').trim(),
    message_batch: Array.isArray(input.message_batch) ? input.message_batch : [],
    image_urls: Array.isArray(input.image_urls) ? input.image_urls : [],
    created_at: Number(input.created_at || Date.now()),
  };
}

function normalizeMedia(media) {
  const items = Array.isArray(media) ? media : media ? [media] : [];
  return items.map((item) => {
    if (!item || typeof item !== 'object') return null;
    return {
      type: String(item.type || '').trim().toLowerCase() || 'file',
      url: String(item.url || '').trim() || undefined,
      local_path: String(item.local_path || item.localPath || item.filePath || '').trim() || undefined,
      filePath: String(item.filePath || item.local_path || item.localPath || '').trim() || undefined,
      mime_type: String(item.mime_type || item.mimeType || '').trim().toLowerCase() || undefined,
      mimeType: String(item.mimeType || item.mime_type || '').trim().toLowerCase() || undefined,
      filename: String(item.filename || item.fileName || '').trim() || undefined,
      size_bytes: Number.isFinite(Number(item.size_bytes || item.sizeBytes)) ? Number(item.size_bytes || item.sizeBytes) : undefined,
      platform_media_id: String(item.platform_media_id || item.media_id || '').trim() || undefined,
    };
  }).filter(Boolean);
}

function normalizePriorMessages(messages = []) {
  if (!Array.isArray(messages)) return [];
  return messages.map((message) => {
    const role = message?.role === 'assistant' ? 'assistant' : message?.role === 'user' ? 'user' : '';
    const content = String(message?.content || '').trim();
    return role && content ? { role, content } : null;
  }).filter(Boolean);
}

function summarizeMedia(media = []) {
  if (!Array.isArray(media) || media.length === 0) return '';
  return media.map((item) => [item.type, item.filename, item.mime_type].filter(Boolean).join(':')).join(', ');
}

function summarizeReplyMedia(media = null) {
  if (!media || typeof media !== 'object' || Array.isArray(media)) return '';
  if (media.source === 'sticker_catalog' && media.kind === 'sticker') {
    return JSON.stringify({
      source: 'sticker_catalog',
      kind: 'sticker',
      stickerId: String(media.stickerId || '').trim(),
      mime: String(media.mime || '').trim(),
      fileName: String(media.fileName || '').trim(),
    });
  }
  return JSON.stringify({
    type: String(media.type || '').trim(),
    source: String(media.source || '').trim() || undefined,
    kind: String(media.kind || '').trim() || undefined,
    fileName: String(media.fileName || media.filename || '').trim() || undefined,
  });
}

function inferTags(message = {}) {
  const tags = [message.platform].filter(Boolean);
  if (/xhslink\.com|xiaohongshu\.com|xhs\.com/i.test(message.text)) tags.push('xhs');
  if (Array.isArray(message.media) && message.media.length > 0) tags.push('media');
  if (/debug|调试|systemctl|journalctl|lark-cli|npm test/i.test(message.text)) tags.push('debug');
  return [...new Set(tags)];
}

function buildReplyTarget(message) {
  return {
    platform: message.platform,
    channel_type: message.channel_type,
    conversation_id: message.conversation_id,
    sender_id: message.sender_id,
  };
}

function normalizePlatform(platform) {
  const value = String(platform || '').trim().toLowerCase();
  return ['wechat', 'feishu', 'desktop'].includes(value) ? value : 'wechat';
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) return text;
  }
  return '';
}
