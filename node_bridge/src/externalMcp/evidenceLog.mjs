import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { resolveStateDir } from '../runtimeState.mjs';

export function sanitizeExternalMcpEvidence(input = {}, options = {}) {
  const now = normalizeDate(options.now || input.now) || new Date();
  const event = {
    timestamp: now.toISOString(),
    request_id: sanitizeId(input.requestId || input.request_id || ''),
    global_user_id: sanitizeIdentity(input.globalUserId || input.global_user_id || ''),
    server_id: sanitizeIdentity(input.serverId || input.server_id || ''),
    tool_id: sanitizeIdentity(input.toolName || input.tool_id || input.toolId || ''),
    watch_scope: sanitizeScope(input.watchScope || input.watch_scope || input.scope || input.topicKey || input.topic_key || ''),
    tier: sanitizeTier(input.tier || ''),
    session_mode: sanitizeMode(input.sessionMode || input.session_mode || ''),
    trigger: sanitizeTrigger(input.trigger || ''),
    decision: sanitizeDecision(input.decision || ''),
    status: sanitizeStatus(input.status || input.result?.status || (input.result?.ok === true ? 'success' : '')),
    result_id_hash: hashOptional(input.resultId || input.result_id || input.artifactId || input.artifact_id || ''),
    error_code: sanitizeId(input.errorCode || input.error_code || (input.error ? 'EXTERNAL_MCP_TOOL_ERROR' : '')),
  };
  return {
    ...event,
    evidence_ref: buildExternalMcpEvidenceRef(event),
  };
}

export function appendExternalMcpEvidence(input = {}, options = {}) {
  const env = options.env || process.env;
  const event = sanitizeExternalMcpEvidence(input, options);
  const target = evidencePath(env);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.appendFileSync(target, `${JSON.stringify(event)}\n`, 'utf8');
  return event;
}

export function listExternalMcpEvidence(options = {}) {
  const env = options.env || process.env;
  try {
    return fs.readFileSync(evidencePath(env), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((item) => item && typeof item === 'object');
  } catch {
    return [];
  }
}

export function verifyExternalMcpEvidenceRefs(input = {}, options = {}) {
  const env = options.env || process.env;
  const now = normalizeDate(options.now || input.now) || new Date();
  const refs = normalizeEvidenceRefs(input.refs || input.evidenceRefs || input.evidence_refs || []);
  if (refs.length === 0) {
    return { ok: false, reason: 'evidence_required', trustedRefs: [] };
  }
  const globalUserId = sanitizeIdentity(input.globalUserId || input.global_user_id || '');
  const serverId = sanitizeIdentity(input.serverId || input.server_id || '');
  const watchScope = sanitizeScope(input.watchScope || input.watch_scope || '');
  const allowedTiers = normalizeAllowedTiers(input.allowedCapabilityTiers || input.allowed_capability_tiers || []);
  if (!globalUserId || !serverId || !watchScope) {
    return { ok: false, reason: 'evidence_scope_required', trustedRefs: [] };
  }
  if (allowedTiers.length === 0) {
    return { ok: false, reason: 'evidence_tier_scope_required', trustedRefs: [] };
  }
  const maxAgeMs = normalizePositiveMs(input.maxAgeMs || input.max_age_ms, 24 * 60 * 60 * 1000);
  const evidenceByRef = new Map(
    listExternalMcpEvidence({ env }).map((item) => [String(item.evidence_ref || '').trim(), item])
  );
  const trustedRefs = [];
  for (const ref of refs) {
    const item = evidenceByRef.get(ref);
    if (!item) {
      return { ok: false, reason: 'evidence_not_trusted', trustedRefs };
    }
    const timestampMs = Date.parse(String(item.timestamp || ''));
    if (!Number.isFinite(timestampMs) || now.getTime() - timestampMs > maxAgeMs || timestampMs - now.getTime() > 5 * 60 * 1000) {
      return { ok: false, reason: 'evidence_stale', trustedRefs };
    }
    if (item.global_user_id !== globalUserId) {
      return { ok: false, reason: 'evidence_user_mismatch', trustedRefs };
    }
    if (item.server_id !== serverId) {
      return { ok: false, reason: 'evidence_server_mismatch', trustedRefs };
    }
    if (!item.watch_scope || item.watch_scope !== watchScope) {
      return { ok: false, reason: 'evidence_scope_mismatch', trustedRefs };
    }
    if (!['allow', 'allowed'].includes(String(item.decision || '').trim().toLowerCase())) {
      return { ok: false, reason: 'evidence_not_allowed', trustedRefs };
    }
    if (!['success', 'partial_success'].includes(String(item.status || '').trim().toLowerCase())) {
      return { ok: false, reason: 'evidence_not_successful', trustedRefs };
    }
    const tier = String(item.tier || '').trim().toUpperCase();
    if (!tier || !allowedTiers.includes(tier)) {
      return { ok: false, reason: 'evidence_tier_not_allowed', trustedRefs };
    }
    trustedRefs.push(ref);
  }
  return { ok: true, reason: 'evidence_trusted', trustedRefs };
}

function evidencePath(env) {
  return path.join(resolveStateDir(env), 'external_mcp', 'evidence.jsonl');
}

function buildExternalMcpEvidenceRef(event = {}) {
  const material = [
    event.timestamp,
    event.request_id,
    event.global_user_id,
    event.server_id,
    event.tool_id,
    event.watch_scope,
    event.result_id_hash,
    event.status,
  ].join('|');
  return `external_mcp_evidence:${createHash('sha256').update(material, 'utf8').digest('hex').slice(0, 16)}`;
}

function sanitizeTier(value) {
  const text = sanitizeId(value).toUpperCase();
  return /^T[0-5]$/.test(text) ? text : '';
}

function sanitizeMode(value) {
  const text = sanitizeId(value).toLowerCase();
  return ['observe', 'interactive', 'write'].includes(text) ? text : '';
}

function sanitizeTrigger(value) {
  const text = sanitizeId(value).toLowerCase();
  return ['user_turn', 'proactive', 'activity', 'pending_confirmation', 'repair'].includes(text) ? text : 'user_turn';
}

function sanitizeDecision(value) {
  const text = sanitizeId(value).toLowerCase();
  return ['allowed', 'allow', 'denied', 'deny', 'confirmation_required', 'failed', 'timed_out'].includes(text)
    ? text
    : '';
}

function sanitizeStatus(value) {
  const text = sanitizeId(value).toLowerCase();
  return ['success', 'partial_success', 'failed', 'timed_out', 'denied'].includes(text) ? text : '';
}

function sanitizeIdentity(value) {
  return String(value || '').trim().replace(/[\r\n\t]/g, ' ').replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 120);
}

function sanitizeId(value) {
  return String(value || '').trim().replace(/[\r\n\t]/g, ' ').replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 120);
}

function sanitizeScope(value) {
  return String(value || '').trim().replace(/[\r\n\t]/g, ' ').replace(/[^a-zA-Z0-9_.:/-]/g, '').slice(0, 180);
}

function normalizeEvidenceRefs(values) {
  const list = Array.isArray(values) ? values : values ? [values] : [];
  return Array.from(new Set(
    list
      .map((item) => String(item || '').trim().replace(/[\r\n\t]/g, ' ').replace(/[^a-zA-Z0-9_.:/-]/g, '').slice(0, 180))
      .filter(Boolean)
  ));
}

function normalizeAllowedTiers(values) {
  const list = Array.isArray(values) ? values : values ? [values] : [];
  return Array.from(new Set(
    list
      .map((item) => String(item || '').trim().toUpperCase())
      .filter((item) => /^T[0-5]$/.test(item))
  ));
}

function normalizePositiveMs(value, fallback) {
  const raw = Number(value);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

function hashOptional(value) {
  const text = String(value || '').trim();
  return text ? createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16) : '';
}

function normalizeDate(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? new Date(parsed) : null;
}
