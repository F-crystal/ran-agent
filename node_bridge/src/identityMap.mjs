import fs from 'node:fs';
import { createHash } from 'node:crypto';

const DEFAULT_GLOBAL_USER_ID = 'user:ran';

export function getIdentityMapConfig(env = process.env) {
  return {
    defaultGlobalUserId: String(env.RAN_AGENT_DEFAULT_GLOBAL_USER_ID || DEFAULT_GLOBAL_USER_ID).trim() || DEFAULT_GLOBAL_USER_ID,
    identityMapPath: String(env.RAN_AGENT_IDENTITY_MAP_PATH || '/opt/ran_agent/.ran_agent_state/identity-map.json').trim(),
  };
}

export function getGlobalUserId(normalizedMessage = {}, options = {}) {
  const env = options.env || process.env;
  const config = getIdentityMapConfig(env);
  const map = options.identityMap || readIdentityMap(config.identityMapPath);
  const key = getAccountBindingKey(normalizedMessage);
  return map?.bindings?.[key] || map?.default_global_user_id || config.defaultGlobalUserId;
}

export function getAccountBindingKey(normalizedMessage = {}) {
  const platform = normalizePlatform(normalizedMessage.platform);
  const id = firstNonEmptyString(
    normalizedMessage.sender_id,
    normalizedMessage.senderId,
    normalizedMessage.client_id,
    normalizedMessage.conversation_id,
  ) || 'unknown';
  return `${platform}:${shortHash(id)}`;
}

export function getStableConversationKey(normalizedMessage = {}) {
  const platform = normalizePlatform(normalizedMessage.platform);
  const channelType = String(normalizedMessage.channel_type || normalizedMessage.channelType || platform).trim().toLowerCase() || platform;
  const conversationId = firstNonEmptyString(normalizedMessage.conversation_id, normalizedMessage.conversationId, normalizedMessage.sender_id) || 'unknown';
  return `${platform}:${channelType}:${conversationId}`;
}

export function getHermesSessionId(normalizedMessage = {}) {
  const platform = normalizePlatform(normalizedMessage.platform);
  const channelType = String(normalizedMessage.channel_type || normalizedMessage.channelType || '').trim().toLowerCase();
  if (platform === 'feishu' && channelType === 'dm') {
    const senderId = firstNonEmptyString(normalizedMessage.sender_id, normalizedMessage.conversation_id) || 'unknown';
    return `ran-agent-feishu-dm-${shortHash(senderId)}`;
  }
  if (platform === 'feishu' && channelType === 'group') {
    const conversationId = firstNonEmptyString(normalizedMessage.conversation_id) || 'unknown';
    const senderId = firstNonEmptyString(normalizedMessage.sender_id) || 'unknown';
    return `ran-agent-feishu-group-${shortHash(`${conversationId}:${senderId}`)}`;
  }
  if (platform === 'desktop') {
    const clientId = firstNonEmptyString(normalizedMessage.sender_id, normalizedMessage.client_id, normalizedMessage.conversation_id) || 'desktop-local';
    return `ran-agent-desktop-${shortHash(clientId)}`;
  }
  const conversationId = firstNonEmptyString(normalizedMessage.conversation_id, normalizedMessage.sender_id) || 'unknown';
  return `ran-agent-wechat-${shortHash(conversationId)}`;
}

export function getHermesSessionKey(globalUserId = DEFAULT_GLOBAL_USER_ID) {
  const id = String(globalUserId || DEFAULT_GLOBAL_USER_ID).trim() || DEFAULT_GLOBAL_USER_ID;
  return `ran-agent-memory-${shortHash(id)}`;
}

export function shortHash(value) {
  return createHash('sha256').update(String(value || '')).digest('hex').slice(0, 16);
}

function readIdentityMap(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
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
