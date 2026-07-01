const TIERS = new Set(['T0', 'T1', 'T2', 'T3', 'T4', 'T5']);
const PROFILE_RANK = {
  lite: 1,
  full: 2,
  owner_full: 3,
};
const TRUSTED_POLICY_AUTH = Symbol('trustedExternalMcpPolicyAuthorization');

export function trustExternalMcpScopedGrant(grant = {}) {
  return markTrustedPolicyAuth(grant, 'scoped_grant');
}

export function trustExternalMcpPendingAction(action = {}) {
  return markTrustedPolicyAuth(action, 'pending_action');
}

export function evaluateExternalMcpPolicy(input = {}) {
  const tool = input.tool && typeof input.tool === 'object' && !Array.isArray(input.tool) ? input.tool : {};
  const profile = normalizeProfile(input.profile);
  const sessionMode = normalizeSessionMode(input.sessionMode);
  const trigger = normalizeTrigger(input.trigger);
  const missingClassification = !tool.tier || !tool.profileScope;
  if (missingClassification) {
    return deny('missing_tool_classification', { profile, sessionMode, trigger });
  }

  const tier = normalizeTier(tool.tier);
  const requiredProfile = normalizeProfile(tool.profileScope);
  const serverId = sanitizeShort(tool.serverId || tool.server_id || '');
  const toolName = sanitizeShort(tool.name || tool.toolName || '');

  if (PROFILE_RANK[profile] < PROFILE_RANK[requiredProfile]) {
    return deny('profile_scope_denied', { profile, requiredProfile, sessionMode, trigger, tier });
  }

  if (trigger === 'proactive' && (sessionMode === 'write' || isSideEffectTier(tier))) {
    return deny('proactive_write_denied', { profile, requiredProfile, sessionMode, trigger, tier });
  }
  if (trigger === 'proactive' && tool.proactiveAllowed !== true) {
    return deny('proactive_tool_denied', { profile, requiredProfile, sessionMode, trigger, tier });
  }
  if (trigger === 'proactive' && tier === 'T2' && input.watchlistMatched !== true) {
    return deny('proactive_requires_watchlist', { profile, requiredProfile, sessionMode, trigger, tier });
  }

  const grant = evaluateScopedGrant(input.scopedGrant, { now: input.now, serverId, toolName, sessionMode });
  if (grant.status === 'expired') {
    return deny('scoped_grant_expired', { profile, requiredProfile, sessionMode, trigger, tier });
  }
  if (grant.status === 'invalid') {
    return deny('scoped_grant_invalid', { profile, requiredProfile, sessionMode, trigger, tier });
  }

  if (tier === 'T5') {
    if (grant.ok) {
      return allow({ profile, requiredProfile, sessionMode, trigger, tier, scopedGrantId: grant.grantId, requiredEvidence: sideEffectEvidence() });
    }
    return deny('t5_requires_scoped_grant', { profile, requiredProfile, sessionMode, trigger, tier });
  }

  if (tier === 'T4') {
    if (grant.ok) {
      return allow({ profile, requiredProfile, sessionMode, trigger, tier, scopedGrantId: grant.grantId, requiredEvidence: sideEffectEvidence() });
    }
    if (isConfirmedPendingAction(input.pendingAction, { serverId, toolName, now: input.now })) {
      return allow({ profile, requiredProfile, sessionMode, trigger, tier, requiredEvidence: sideEffectEvidence() });
    }
    return {
      ...deny('pending_confirmation_required', { profile, requiredProfile, sessionMode, trigger, tier }),
      decision: 'confirmation_required',
      requiresPendingAction: true,
      pendingActionType: externalPendingActionType(toolName),
    };
  }

  return allow({ profile, requiredProfile, sessionMode, trigger, tier, requiredEvidence: readEvidenceForTier(tier) });
}

export function normalizeTier(value) {
  const normalized = String(value || '').trim().toUpperCase();
  return TIERS.has(normalized) ? normalized : 'T5';
}

export function normalizeProfile(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(PROFILE_RANK, normalized) ? normalized : 'lite';
}

export function isSideEffectTier(tier) {
  const normalized = normalizeTier(tier);
  return normalized === 'T4' || normalized === 'T5';
}

function evaluateScopedGrant(grant, { now, serverId, toolName, sessionMode } = {}) {
  if (!grant || typeof grant !== 'object' || Array.isArray(grant)) return { ok: false, status: 'missing' };
  if (grant[TRUSTED_POLICY_AUTH] !== 'scoped_grant') return { ok: false, status: 'untrusted' };
  const grantId = sanitizeShort(grant.grantId || grant.grant_id || '');
  const expiresAt = Date.parse(String(grant.expiresAt || grant.expires_at || ''));
  const nowMs = normalizeDate(now).getTime();
  if (!grantId || !Number.isFinite(expiresAt)) {
    return { ok: false, status: 'invalid' };
  }
  if (Number.isFinite(expiresAt) && expiresAt <= nowMs) {
    return { ok: false, status: 'expired' };
  }
  if (sanitizeShort(grant.serverId || grant.server_id || '') !== serverId) return { ok: false, status: 'server_mismatch' };
  if (sanitizeShort(grant.toolName || grant.tool_name || '') !== toolName) return { ok: false, status: 'tool_mismatch' };
  if (normalizeSessionMode(grant.mode || grant.sessionMode) !== sessionMode) return { ok: false, status: 'mode_mismatch' };
  return { ok: true, status: 'valid', grantId };
}

function isConfirmedPendingAction(action, { serverId, toolName, now } = {}) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) return false;
  if (action[TRUSTED_POLICY_AUTH] !== 'pending_action') return false;
  if (!sanitizeShort(action.actionId || action.action_id || '')) return false;
  if (String(action.status || '').trim().toLowerCase() !== 'confirmed') return false;
  const expiresAt = Date.parse(String(action.expiresAt || action.expires_at || ''));
  if (!Number.isFinite(expiresAt) || expiresAt <= normalizeDate(now).getTime()) return false;
  const actionType = sanitizeShort(action.actionType || action.action_type || '');
  if (!actionType || !['external_mcp_write', externalPendingActionType(toolName)].includes(actionType)) return false;
  const payload = action.sanitizedPayload && typeof action.sanitizedPayload === 'object' && !Array.isArray(action.sanitizedPayload)
    ? action.sanitizedPayload
    : {};
  const actionServerId = sanitizeShort(action.serverId || action.server_id || payload.serverId || payload.server_id || '');
  const actionToolName = sanitizeShort(action.toolName || action.tool_name || payload.toolId || payload.tool_id || payload.toolName || payload.tool_name || '');
  if (actionServerId !== serverId) return false;
  if (actionToolName !== toolName) return false;
  return true;
}

function markTrustedPolicyAuth(input, kind) {
  const output = input && typeof input === 'object' && !Array.isArray(input) ? { ...input } : {};
  Object.defineProperty(output, TRUSTED_POLICY_AUTH, {
    value: kind,
    enumerable: false,
    configurable: false,
  });
  return output;
}

function allow(details = {}) {
  return {
    allowed: true,
    decision: 'allow',
    reason: 'policy_pass',
    requiresPendingAction: false,
    requiredEvidence: Array.isArray(details.requiredEvidence) ? details.requiredEvidence : [],
    ...details,
  };
}

function deny(reason, details = {}) {
  return {
    allowed: false,
    decision: 'deny',
    reason,
    requiresPendingAction: false,
    requiredEvidence: [],
    ...details,
  };
}

function sideEffectEvidence() {
  return ['authorization', 'external_mcp_tool_result'];
}

function readEvidenceForTier(tier) {
  return ['T1', 'T2'].includes(normalizeTier(tier)) ? ['external_mcp_tool_result'] : [];
}

function externalPendingActionType(toolName) {
  if (/forum\.submit_reply|forum\.comment/i.test(toolName)) return 'forum_comment';
  if (/forum\.post/i.test(toolName)) return 'forum_post';
  if (/forum\.react|forum\.like/i.test(toolName)) return 'forum_react';
  if (/forum\.follow/i.test(toolName)) return 'forum_follow';
  if (/game\.act|game\.submit_move/i.test(toolName)) return 'game_submit_move';
  if (/game\.trade/i.test(toolName)) return 'game_trade';
  if (/game\.spend/i.test(toolName)) return 'game_spend_resource';
  return 'external_mcp_write';
}

function normalizeTrigger(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'proactive' ? 'proactive' : 'user_turn';
}

function normalizeSessionMode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return ['observe', 'interactive', 'write'].includes(normalized) ? normalized : 'observe';
}

function normalizeDate(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? new Date(parsed) : new Date();
}

function sanitizeShort(value) {
  return String(value || '').trim().replace(/[\r\n\t]/g, ' ').slice(0, 120);
}
