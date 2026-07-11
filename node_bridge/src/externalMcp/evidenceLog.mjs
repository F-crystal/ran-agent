import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  appendJsonLine,
  quarantineCorruptState,
  writeFileAtomic,
} from '../atomicState.mjs';
import { resolveStateDir } from '../runtimeState.mjs';

const EVIDENCE_SCHEMA_VERSION = 1;

export function sanitizeExternalMcpEvidence(input = {}, options = {}) {
  const now = normalizeDate(options.now || input.now) || new Date();
  const event = {
    schema_version: EVIDENCE_SCHEMA_VERSION,
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
  const lock = acquireMutationLock(target);
  if (!lock) throw evidenceError('external MCP evidence log is busy', 'EXTERNAL_MCP_EVIDENCE_STORE_BUSY');
  try {
    assertNoUnrecoveredQuarantine(target);
    const existing = readEvidenceFile(target);
    if (existing.incompleteTail) {
      writeFileAtomic(target, existing.validText);
    }
    appendJsonLine(target, event, { validate: isEvidenceEvent });
    return event;
  } finally {
    releaseMutationLock(lock);
  }
}

export function listExternalMcpEvidence(options = {}) {
  const env = options.env || process.env;
  const target = evidencePath(env);
  assertNoUnrecoveredQuarantine(target);
  return readEvidenceFile(target).events;
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

function readEvidenceFile(target) {
  let text;
  try {
    text = fs.readFileSync(target, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { events: [], validText: '', incompleteTail: false };
    throw error;
  }
  if (!text) return { events: [], validText: '', incompleteTail: false };
  const hasFinalNewline = text.endsWith('\n');
  const lines = text.split('\n');
  if (hasFinalNewline) lines.pop();
  const events = [];
  const validLines = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) return quarantineEvidence(target, 'blank-jsonl-line');
    try {
      const value = JSON.parse(line);
      if (!isEvidenceEvent(value)) return quarantineEvidence(target, 'invalid-evidence-record');
      events.push(value);
      validLines.push(line);
    } catch (error) {
      const finalTail = index === lines.length - 1 && !hasFinalNewline && isIncompleteJsonTail(line, error);
      if (finalTail) {
        return {
          events,
          validText: validLines.length > 0 ? `${validLines.join('\n')}\n` : '',
          incompleteTail: true,
        };
      }
      return quarantineEvidence(target, 'invalid-jsonl');
    }
  }
  return { events, validText: text, incompleteTail: false };
}

function isIncompleteJsonTail(line, error) {
  if (!String(line || '').trimStart().startsWith('{')) return false;
  const message = String(error?.message || '');
  if (/unexpected end|end of json input/i.test(message)) return true;
  const match = message.match(/position\s+(\d+)/i);
  return Boolean(match) && Number(match[1]) >= String(line).length - 1;
}

function quarantineEvidence(target, reason) {
  try {
    quarantineCorruptState(target, reason);
  } catch (cause) {
    throw evidenceError('external MCP evidence log is invalid and could not be quarantined', 'RAN_AGENT_STATE_CORRUPT', cause);
  }
  throw evidenceError('external MCP evidence log is invalid and was quarantined', 'RAN_AGENT_STATE_CORRUPT');
}

function isEvidenceEvent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (Object.hasOwn(value, 'schema_version') && value.schema_version !== EVIDENCE_SCHEMA_VERSION) return false;
  const stringFields = [
    'timestamp', 'request_id', 'global_user_id', 'server_id', 'tool_id', 'watch_scope',
    'tier', 'session_mode', 'trigger', 'decision', 'status', 'result_id_hash', 'error_code', 'evidence_ref',
  ];
  if (!stringFields.every((key) => typeof value[key] === 'string')) return false;
  if (!Number.isFinite(Date.parse(value.timestamp))) return false;
  if (value.tier && !/^T[0-5]$/.test(value.tier)) return false;
  if (value.session_mode && !['observe', 'interactive', 'write'].includes(value.session_mode)) return false;
  if (!['user_turn', 'proactive', 'activity', 'pending_confirmation', 'repair'].includes(value.trigger)) return false;
  if (value.decision && !['allowed', 'allow', 'denied', 'deny', 'confirmation_required', 'failed', 'timed_out'].includes(value.decision)) return false;
  if (value.status && !['success', 'partial_success', 'failed', 'timed_out', 'denied'].includes(value.status)) return false;
  if (value.result_id_hash && !/^[a-f0-9]{16}$/.test(value.result_id_hash)) return false;
  return value.evidence_ref === buildExternalMcpEvidenceRef(value);
}

function assertNoUnrecoveredQuarantine(target) {
  if (fs.existsSync(target)) return;
  let entries;
  try { entries = fs.readdirSync(path.dirname(target)); } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (!entries.some((entry) => entry.startsWith(`${path.basename(target)}.corrupt-`))) return;
  throw evidenceError('external MCP evidence log is quarantined and requires recovery', 'RAN_AGENT_STATE_CORRUPT');
}

function acquireMutationLock(target) {
  const lockPath = `${target}.lock`;
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  let descriptor;
  try {
    descriptor = fs.openSync(lockPath, 'wx', 0o600);
    fs.writeFileSync(descriptor, `${process.pid}\n`, 'utf8');
    fs.fsyncSync(descriptor);
    return { descriptor, lockPath };
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
      try { fs.rmSync(lockPath, { force: true }); } catch {}
    }
    if (error?.code === 'EEXIST') return null;
    throw error;
  }
}

function releaseMutationLock(lock) {
  try { fs.closeSync(lock.descriptor); } finally { fs.rmSync(lock.lockPath, { force: true }); }
}

function evidenceError(message, code, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
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
