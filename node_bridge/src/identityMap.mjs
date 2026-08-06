import { createHash } from 'node:crypto';
import { readJsonState, writeJsonAtomic } from './atomicState.mjs';

const DEFAULT_GLOBAL_USER_ID = 'user:ran';

export function getIdentityMapConfig(env = process.env) {
  return {
    defaultGlobalUserId: String(env.RAN_AGENT_DEFAULT_GLOBAL_USER_ID || DEFAULT_GLOBAL_USER_ID).trim() || DEFAULT_GLOBAL_USER_ID,
    identityMapPath: String(env.RAN_AGENT_IDENTITY_MAP_PATH || '/opt/ran_agent/.ran_agent_state/identity-map.json').trim(),
  };
}

export function getGlobalUserId(normalizedMessage = {}, options = {}) {
  return getIdentityBinding(normalizedMessage, options).globalUserId;
}

export function getIdentityBinding(normalizedMessage = {}, options = {}) {
  const env = options.env || process.env;
  const config = getIdentityMapConfig(env);
  const map = options.identityMap || readIdentityMap(config.identityMapPath);
  const key = getAccountBindingKey(normalizedMessage);
  const candidate = map?.bindings?.[key];
  const senderHash = key.split(':')[1] || shortHash('unknown');
  const platform = normalizePlatform(normalizedMessage.platform);
  if (map?.schemaVersion === 2 && isValidVersionedBinding(candidate, { platform, senderHash })) {
    return Object.freeze({
      bindingVersion: 2,
      platform,
      senderHash,
      globalUserId: candidate.globalUserId,
      owner: candidate.owner === true,
      provenance: candidate.provenance,
      createdAt: candidate.createdAt,
    });
  }
  const legacyGlobalUserId = typeof candidate === 'string' && candidate.trim()
    ? candidate.trim()
    : typeof map?.default_global_user_id === 'string' && map.default_global_user_id.trim()
      ? map.default_global_user_id.trim()
      : config.defaultGlobalUserId;
  return Object.freeze({
    bindingVersion: 1,
    platform,
    senderHash,
    globalUserId: legacyGlobalUserId,
    owner: false,
    provenance: candidate ? 'legacy_binding' : 'fallback',
    createdAt: '',
  });
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

export function getHermesSessionKey(stableConversationKey = DEFAULT_GLOBAL_USER_ID) {
  const id = String(stableConversationKey || DEFAULT_GLOBAL_USER_ID).trim() || DEFAULT_GLOBAL_USER_ID;
  return `ran-agent-memory-${shortHash(id)}`;
}

export function deriveTrustedActorContext(normalizedMessage = {}, options = {}) {
  const binding = getIdentityBinding(normalizedMessage, options);
  const platform = normalizePlatform(normalizedMessage.platform);
  const channelType = normalizeChannelType(
    normalizedMessage.channel_type || normalizedMessage.channelType || platform,
    platform,
  );
  const conversationId = firstNonEmptyString(
    normalizedMessage.conversation_id,
    normalizedMessage.conversationId,
    normalizedMessage.sender_id,
  ) || 'unknown';
  const receivedAt = normalizeTimestamp(options.receivedAt || normalizedMessage.received_at || new Date());
  const messageId = firstNonEmptyString(
    normalizedMessage.message_id,
    normalizedMessage.messageId,
    normalizedMessage.source_message_id,
  ) || `${conversationId}:${receivedAt}:${String(normalizedMessage.text || '').slice(0, 512)}`;
  return Object.freeze({
    actorKey: `actor:${platform}:${binding.senderHash}:${shortHash(binding.globalUserId)}`,
    owner: binding.owner,
    platform,
    channelType,
    conversationKey: `${platform}:${channelType}:${shortHash(conversationId)}`,
    messageKey: `${platform}:${shortHash(messageId)}`,
    receivedAt,
  });
}

export function validateOwnerBindingPreflight(options = {}) {
  const env = options.env || process.env;
  const config = getIdentityMapConfig(env);
  const map = options.identityMap || readIdentityMap(config.identityMapPath);
  let ownerBindingCount = 0;
  if (map?.schemaVersion === 2 && map.bindings && typeof map.bindings === 'object' && !Array.isArray(map.bindings)) {
    for (const [key, candidate] of Object.entries(map.bindings)) {
      const [platform, senderHash] = String(key).split(':');
      if (candidate?.owner === true && isValidVersionedBinding(candidate, { platform, senderHash })) {
        ownerBindingCount += 1;
      }
    }
  }
  return ownerBindingCount > 0
    ? { ok: true, ownerBindingCount }
    : { ok: false, ownerBindingCount: 0, blocker: 'owner_binding_required' };
}

export function bootstrapOwnerBinding({ trustedIdentity, env = process.env, now = new Date() } = {}) {
  const identity = trustedIdentity && typeof trustedIdentity === 'object' ? trustedIdentity : {};
  const platform = normalizePlatform(identity.platform);
  const senderId = firstNonEmptyString(identity.senderId, identity.sender_id);
  const globalUserId = String(identity.globalUserId || identity.global_user_id || '').trim();
  const provenance = String(identity.provenance || '').trim();
  const createdAt = normalizeTimestamp(now);
  if (!senderId || !globalUserId || globalUserId.length > 180 || !provenance || provenance.length > 120) {
    const error = new Error('trusted owner identity is incomplete');
    error.code = 'OWNER_BOOTSTRAP_IDENTITY_REQUIRED';
    throw error;
  }
  const config = getIdentityMapConfig(env);
  const state = readJsonState(config.identityMapPath, {
    validate: isBootstrapIdentityMap,
    missingValue: { schemaVersion: 2, bindings: {} },
    critical: true,
  });
  const key = getAccountBindingKey({ platform, sender_id: senderId });
  const binding = {
    platform,
    senderHash: key.split(':')[1],
    globalUserId,
    owner: true,
    provenance,
    createdAt,
  };
  const next = {
    schemaVersion: 2,
    bindings: { ...state.bindings, [key]: binding },
  };
  writeJsonAtomic(config.identityMapPath, next, { validate: isBootstrapIdentityMap, mode: 0o600 });
  return validateOwnerBindingPreflight({ env, identityMap: next });
}

export function shortHash(value) {
  return createHash('sha256').update(String(value || '')).digest('hex').slice(0, 16);
}

function readIdentityMap(filePath) {
  if (!filePath) return null;
  return readJsonState(filePath, {
    validate: isValidIdentityMap,
    missingValue: null,
    critical: true,
  });
}

function normalizePlatform(platform) {
  const value = String(platform || '').trim().toLowerCase();
  return ['wechat', 'feishu', 'desktop'].includes(value) ? value : 'wechat';
}

function normalizeChannelType(value, fallback) {
  const normalized = String(value || '').trim().toLowerCase();
  return /^[a-z0-9_-]{1,40}$/.test(normalized) ? normalized : fallback;
}

function normalizeTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('invalid trusted actor timestamp');
  return date.toISOString();
}

function isValidVersionedBinding(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value.platform !== expected.platform || value.senderHash !== expected.senderHash) return false;
  if (!/^[a-f0-9]{16}$/.test(String(value.senderHash || ''))) return false;
  if (typeof value.globalUserId !== 'string' || !value.globalUserId.trim() || value.globalUserId.length > 180) return false;
  if (typeof value.owner !== 'boolean') return false;
  if (typeof value.provenance !== 'string' || !value.provenance.trim() || value.provenance.length > 120) return false;
  return Number.isFinite(Date.parse(value.createdAt));
}

function isBootstrapIdentityMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 2
    || !value.bindings || typeof value.bindings !== 'object' || Array.isArray(value.bindings)) return false;
  return Object.entries(value.bindings).every(([key, candidate]) => {
    const binding = parseBindingKey(key);
    return binding && (isValidLegacyBinding(candidate) || isValidVersionedBinding(candidate, binding));
  });
}

function isValidIdentityMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value.schemaVersion === 2) return isBootstrapIdentityMap(value);
  if (Object.hasOwn(value, 'schemaVersion')) return false;
  const hasBindings = Object.hasOwn(value, 'bindings');
  const hasDefault = Object.hasOwn(value, 'default_global_user_id');
  if (!hasBindings && !hasDefault) return false;
  if (hasDefault && !isValidLegacyBinding(value.default_global_user_id)) return false;
  if (!hasBindings) return true;
  if (!value.bindings || typeof value.bindings !== 'object' || Array.isArray(value.bindings)) return false;
  return Object.entries(value.bindings).every(([key, candidate]) => {
    const binding = parseBindingKey(key);
    return binding && (isValidLegacyBinding(candidate) || isValidVersionedBinding(candidate, binding));
  });
}

function parseBindingKey(value) {
  const parts = String(value || '').split(':');
  if (parts.length !== 2) return null;
  const [platform, senderHash] = parts;
  if (!['wechat', 'feishu', 'desktop'].includes(platform) || !/^[a-f0-9]{16}$/.test(senderHash)) return null;
  return { platform, senderHash };
}

function isValidLegacyBinding(value) {
  return typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 180;
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) return text;
  }
  return '';
}
