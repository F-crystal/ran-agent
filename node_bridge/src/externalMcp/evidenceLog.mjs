import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { resolveStateDir } from '../runtimeState.mjs';

export function sanitizeExternalMcpEvidence(input = {}, options = {}) {
  const now = normalizeDate(options.now || input.now) || new Date();
  return {
    timestamp: now.toISOString(),
    request_id: sanitizeId(input.requestId || input.request_id || ''),
    global_user_id: sanitizeIdentity(input.globalUserId || input.global_user_id || ''),
    server_id: sanitizeIdentity(input.serverId || input.server_id || ''),
    tool_id: sanitizeIdentity(input.toolName || input.tool_id || input.toolId || ''),
    tier: sanitizeTier(input.tier || ''),
    session_mode: sanitizeMode(input.sessionMode || input.session_mode || ''),
    trigger: sanitizeTrigger(input.trigger || ''),
    decision: sanitizeDecision(input.decision || ''),
    status: sanitizeStatus(input.status || input.result?.status || (input.result?.ok === true ? 'success' : '')),
    result_id_hash: hashOptional(input.resultId || input.result_id || input.artifactId || input.artifact_id || ''),
    error_code: sanitizeId(input.errorCode || input.error_code || (input.error ? 'EXTERNAL_MCP_TOOL_ERROR' : '')),
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

function evidencePath(env) {
  return path.join(resolveStateDir(env), 'external_mcp', 'evidence.jsonl');
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
  return ['user_turn', 'proactive', 'pending_confirmation', 'repair'].includes(text) ? text : 'user_turn';
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

function hashOptional(value) {
  const text = String(value || '').trim();
  return text ? createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16) : '';
}

function normalizeDate(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? new Date(parsed) : null;
}
