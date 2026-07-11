import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

import { appendJsonLine, readJsonState, writeJsonAtomic } from './atomicState.mjs';
import { resolveStateDir } from './runtimeState.mjs';

const VALID_STATUSES = new Set(['pending', 'confirmed', 'cancelled', 'expired', 'executed', 'failed']);
const VALID_TRANSITIONS = new Map([
  ['pending', new Set(['confirmed', 'cancelled', 'expired'])],
  ['confirmed', new Set(['executed', 'failed'])],
]);

export function getPendingActionConfig(env = process.env) {
  return {
    enabled: String(env.HERMES_ACTION_PENDING_ENABLED || 'true').trim().toLowerCase() !== 'false',
    ttlMinutes: normalizePositiveInt(env.HERMES_ACTION_PENDING_TTL_MINUTES, 30),
  };
}

export function createPendingAction(input = {}, options = {}) {
  const env = options.env || process.env;
  const now = normalizeDate(options.now) || new Date();
  const ttlMinutes = normalizePositiveInt(options.ttlMinutes, getPendingActionConfig(env).ttlMinutes);
  const sanitizedPayload = sanitizePayload(input.sanitizedPayload || {});
  const actorContext = sanitizeActorContext(options.actorContext, input);
  const action = {
    schemaVersion: 2,
    actionId: sanitizeId(input.actionId || `act_${randomUUID().replace(/-/g, '').slice(0, 18)}`),
    requestId: sanitizeId(input.requestId || ''),
    channel: sanitizeShort(input.channel || ''),
    conversationIdHash: hashShort(input.conversationId || input.conversation_id || ''),
    profile: sanitizeShort(input.profile || ''),
    actorKey: actorContext.actorKey,
    owner: actorContext.owner,
    platform: actorContext.platform,
    conversationKey: actorContext.conversationKey,
    actionType: sanitizeShort(input.actionType || ''),
    summary: sanitizeSummary(input.summary || ''),
    status: 'pending',
    requiredConfirmation: input.requiredConfirmation !== false,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMinutes * 60 * 1000).toISOString(),
    revision: 1,
    sanitizedPayload,
    evidence: sanitizeEvidence(input.evidence || []),
  };
  action.actionDigest = hashShort(JSON.stringify([
    action.actionType,
    action.sanitizedPayload,
    action.channel,
    action.conversationIdHash,
  ]));
  appendActionEvent(action, env);
  writeIndex(upsertAction(readIndex(env), action), env);
  return action;
}

export function listPendingActions(options = {}) {
  const env = options.env || process.env;
  return readIndex(env);
}

export function findLatestPendingAction({ channel = '', conversationId = '' } = {}, options = {}) {
  const env = options.env || process.env;
  const now = normalizeDate(options.now) || new Date();
  expirePendingActions({ env, now });
  const conversationIdHash = hashShort(conversationId);
  const matches = readIndex(env)
    .filter((item) => item.status === 'pending')
    .filter((item) => item.channel === sanitizeShort(channel))
    .filter((item) => item.conversationIdHash === conversationIdHash)
    .filter((item) => matchesActor(item, options.actorContext))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return matches[0] || null;
}

export function findPendingActionsForConversation({ channel = '', conversationId = '' } = {}, options = {}) {
  const env = options.env || process.env;
  const now = normalizeDate(options.now) || new Date();
  expirePendingActions({ env, now });
  const conversationIdHash = hashShort(conversationId);
  return readIndex(env)
    .filter((item) => item.status === 'pending')
    .filter((item) => item.channel === sanitizeShort(channel))
    .filter((item) => item.conversationIdHash === conversationIdHash)
    .filter((item) => matchesActor(item, options.actorContext))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export function confirmPendingAction(actionId, options = {}) {
  return updatePendingActionStatus(actionId, 'confirmed', options);
}

export function cancelPendingAction(actionId, options = {}) {
  return updatePendingActionStatus(actionId, 'cancelled', options);
}

export function markPendingActionExecuted(actionId, evidence = [], options = {}) {
  return updatePendingActionStatus(actionId, 'executed', { ...options, evidence });
}

export function markPendingActionFailed(actionId, evidence = [], options = {}) {
  return updatePendingActionStatus(actionId, 'failed', { ...options, evidence });
}

export function expirePendingActions(options = {}) {
  const env = options.env || process.env;
  const now = normalizeDate(options.now) || new Date();
  const actions = readIndex(env);
  let changed = false;
  const updated = actions.map((action) => {
    if (action.status !== 'pending') return action;
    const expiresMs = Date.parse(action.expiresAt);
    if (Number.isFinite(expiresMs) && expiresMs <= now.getTime()) {
      changed = true;
      const expired = {
        ...action,
        status: 'expired',
        revision: normalizeRevision(action.revision) + 1,
        updatedAt: now.toISOString(),
      };
      appendActionEvent(expired, env);
      return expired;
    }
    return action;
  });
  if (changed) writeIndex(updated, env);
  return updated;
}

function updatePendingActionStatus(actionId, status, options = {}) {
  if (!VALID_STATUSES.has(status)) throw new Error(`invalid pending action status: ${status}`);
  const env = options.env || process.env;
  const now = normalizeDate(options.now) || new Date();
  const actions = readIndex(env);
  const index = actions.findIndex((item) => item.actionId === sanitizeId(actionId));
  if (index < 0) return null;
  const current = actions[index];
  if (options.expectedRevision !== undefined && Number(options.expectedRevision) !== normalizeRevision(current.revision)) {
    throw pendingActionError('PENDING_ACTION_STALE_REVISION', 'pending action revision changed');
  }
  if (!matchesActor(current, options.actorContext)) {
    throw pendingActionError('PENDING_ACTION_ACTOR_MISMATCH', 'pending action belongs to another actor');
  }
  if (!VALID_TRANSITIONS.get(current.status)?.has(status)) {
    throw pendingActionError('PENDING_ACTION_INVALID_TRANSITION', `cannot transition ${current.status} to ${status}`);
  }
  const updated = {
    ...current,
    status,
    updatedAt: now.toISOString(),
    revision: normalizeRevision(current.revision) + 1,
    evidence: sanitizeEvidence(options.evidence || current.evidence || []),
  };
  actions[index] = updated;
  appendActionEvent(updated, env);
  writeIndex(actions, env);
  return updated;
}

function paths(env) {
  const root = path.join(resolveStateDir(env), 'action_contract');
  return {
    root,
    jsonl: path.join(root, 'pending_actions.jsonl'),
    index: path.join(root, 'pending_actions_index.json'),
  };
}

function readIndex(env) {
  return readJsonState(paths(env).index, {
    validate: isPendingActionIndex,
    missingValue: [],
    critical: true,
  });
}

function writeIndex(actions, env) {
  writeJsonAtomic(paths(env).index, actions, { validate: isPendingActionIndex });
}

function appendActionEvent(action, env) {
  appendJsonLine(paths(env).jsonl, action, { validate: isPendingActionRecord });
}

function isPendingActionIndex(value) {
  return Array.isArray(value) && value.every(isPendingActionRecord);
}

function isPendingActionRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (!sanitizeId(value.actionId) || !VALID_STATUSES.has(String(value.status || ''))) return false;
  if (value.schemaVersion === undefined) return true;
  return value.schemaVersion === 2
    && Boolean(sanitizeShort(value.actorKey))
    && typeof value.owner === 'boolean'
    && Boolean(sanitizeShort(value.platform))
    && Boolean(sanitizeShort(value.conversationKey))
    && /^[a-f0-9]{16}$/.test(String(value.actionDigest || ''))
    && Number.isInteger(value.revision)
    && value.revision >= 1;
}

function upsertAction(actions, action) {
  const next = actions.filter((item) => item.actionId !== action.actionId);
  next.push(action);
  return next;
}

function sanitizePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};
  const sanitized = {};
  if (payload.serverId || payload.server_id) {
    sanitized.serverId = sanitizeShort(payload.serverId || payload.server_id);
  }
  if (payload.toolId || payload.tool_id || payload.toolName || payload.tool_name) {
    sanitized.toolId = sanitizeShort(payload.toolId || payload.tool_id || payload.toolName || payload.tool_name);
  }
  if (payload.actionFamily || payload.action_family) {
    sanitized.actionFamily = sanitizeShort(payload.actionFamily || payload.action_family);
  }
  if (payload.watchScope || payload.watch_scope) {
    sanitized.watchScope = sanitizeShort(payload.watchScope || payload.watch_scope);
  }
  if (payload.grantId || payload.grant_id) {
    sanitized.grantId = sanitizeShort(payload.grantId || payload.grant_id);
  }
  if (payload.evidenceId || payload.evidence_id) {
    sanitized.evidenceId = sanitizeShort(payload.evidenceId || payload.evidence_id);
  }
  if (payload.arguments && typeof payload.arguments === 'object' && !Array.isArray(payload.arguments)) {
    sanitized.argumentsHash = hashShort(JSON.stringify(payload.arguments));
  }
  if (Array.isArray(payload.tags)) {
    sanitized.tags = payload.tags.map(sanitizeShort).filter(Boolean).slice(0, 8);
  }
  if (payload.actionTarget) {
    sanitized.actionTarget = sanitizeShort(payload.actionTarget);
  }
  if (payload.stickerId) {
    sanitized.stickerId = sanitizeShort(payload.stickerId);
  }
  const mediaRefs = normalizeMediaRefs(payload.media || payload.mediaRefs || payload.items);
  if (mediaRefs.length > 0) sanitized.mediaRefs = mediaRefs;
  if (payload.recipient) sanitized.recipientHash = hashShort(payload.recipient);
  if (payload.contentRef) sanitized.contentRefHash = hashShort(payload.contentRef);
  return sanitized;
}

function sanitizeActorContext(context, input) {
  if (context && typeof context === 'object' && !Array.isArray(context)) {
    const actorKey = sanitizeShort(context.actorKey);
    const platform = sanitizeShort(context.platform || input.channel).toLowerCase();
    const conversationKey = sanitizeShort(context.conversationKey);
    if (actorKey && platform && conversationKey) {
      return { actorKey, owner: context.owner === true, platform, conversationKey };
    }
  }
  const platform = sanitizeShort(input.channel || 'unknown').toLowerCase() || 'unknown';
  const conversationHash = hashShort(input.conversationId || input.conversation_id || '');
  return {
    actorKey: `legacy:${platform}:${conversationHash}`,
    owner: false,
    platform,
    conversationKey: `${platform}:legacy:${conversationHash}`,
  };
}

function matchesActor(action, actorContext) {
  if (!actorContext) return true;
  const actorKey = sanitizeShort(actorContext.actorKey);
  return Boolean(actorKey && action.actorKey && action.actorKey === actorKey);
}

function normalizeRevision(value) {
  return Number.isInteger(value) && value >= 1 ? value : 1;
}

function normalizeMediaRefs(items) {
  const list = Array.isArray(items) ? items : items ? [items] : [];
  return list
    .map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
      const ref = item.ref || item.mediaRef || item.assetId || item.id || item.filePath || item.local_path || item.localPath || '';
      const refHash = hashOptional(ref);
      if (!refHash) return null;
      return {
        refHash,
        type: sanitizeShort(item.type || item.mimeType || item.mime_type || ''),
      };
    })
    .filter(Boolean)
    .slice(0, 5);
}

function sanitizeEvidence(evidence) {
  const list = Array.isArray(evidence) ? evidence : [];
  return list
    .map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
      return {
        type: sanitizeShort(item.type || ''),
        status: sanitizeShort(item.status || ''),
        result_id_hash: sanitizeShort(item.result_id_hash || item.resultIdHash || ''),
        error_code: sanitizeShort(item.error_code || item.errorCode || ''),
      };
    })
    .filter(Boolean)
    .slice(0, 10);
}

function sanitizeSummary(value) {
  return sanitizeShort(value).slice(0, 160);
}

function sanitizeId(value) {
  return sanitizeShort(value).replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 80);
}

function sanitizeShort(value) {
  return String(value || '').trim().replace(/[\r\n\t]/g, ' ').slice(0, 120);
}

function hashOptional(value) {
  const text = String(value || '').trim();
  return text ? hashShort(text) : '';
}

function hashShort(value) {
  return createHash('sha256').update(String(value || ''), 'utf8').digest('hex').slice(0, 16);
}

function normalizePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeDate(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (value) {
    const parsed = Date.parse(String(value));
    if (Number.isFinite(parsed)) return new Date(parsed);
  }
  return null;
}

function pendingActionError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
