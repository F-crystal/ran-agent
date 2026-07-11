import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { readJsonState, writeJsonAtomic } from '../atomicState.mjs';
import { resolveStateDir } from '../runtimeState.mjs';

const VALID_MODES = new Set(['observe', 'interactive', 'write']);
const SESSION_SCHEMA_VERSION = 1;

export function openExternalMcpSession(input = {}, options = {}) {
  const env = options.env || process.env;
  const now = normalizeDate(input.now || options.now) || new Date();
  const mode = normalizeMode(input.mode || input.sessionMode);
  const trigger = String(input.trigger || '').trim().toLowerCase();
  if (trigger === 'proactive' && mode === 'write') {
    return errorResult('proactive write sessions are denied', 'EXTERNAL_MCP_PROACTIVE_WRITE_SESSION_DENIED');
  }
  const globalUserId = sanitizeIdentity(input.globalUserId || input.global_user_id || '');
  const serverId = sanitizeIdentity(input.serverId || input.server_id || '');
  if (!globalUserId || !serverId) {
    return errorResult('global user id and server id are required', 'EXTERNAL_MCP_SESSION_SCOPE_REQUIRED');
  }
  const sessionId = `extmcp_${randomBytes(12).toString('hex')}`;
  const ttlMinutes = normalizePositiveInt(input.ttlMinutes || input.ttl_minutes || options.ttlMinutes, 30);
  const session = {
    ok: true,
    sessionId,
    sessionKey: `${globalUserId}:${serverId}:${mode}:${sessionId}`,
    globalUserId,
    serverId,
    mode,
    status: 'active',
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMinutes * 60 * 1000).toISOString(),
  };
  return mutateSessions(env, (sessions) => ({
    sessions: upsertSession(sessions, session),
    result: session,
  }));
}

export function getExternalMcpSession(sessionId, options = {}) {
  const env = options.env || process.env;
  const now = normalizeDate(options.now) || new Date();
  const expectedUser = sanitizeIdentity(options.globalUserId || options.global_user_id || '');
  const expectedServer = sanitizeIdentity(options.serverId || options.server_id || '');
  const session = readSessions(env).find((item) => item.sessionId === sanitizeSessionId(sessionId));
  if (!session || session.status !== 'active') return null;
  if (isExpired(session, now)) return null;
  if (expectedUser && session.globalUserId !== expectedUser) return null;
  if (expectedServer && session.serverId !== expectedServer) return null;
  return session;
}

export function listExternalMcpSessions(options = {}) {
  const env = options.env || process.env;
  const now = normalizeDate(options.now) || new Date();
  return readSessions(env).filter((session) => session.status === 'active' && !isExpired(session, now));
}

export function closeExternalMcpSession(sessionId, options = {}) {
  const env = options.env || process.env;
  const now = normalizeDate(options.now) || new Date();
  const expectedUser = sanitizeIdentity(options.globalUserId || options.global_user_id || '');
  const expectedServer = sanitizeIdentity(options.serverId || options.server_id || '');
  return mutateSessions(env, (sessions) => {
    const index = sessions.findIndex((item) => item.sessionId === sanitizeSessionId(sessionId));
    if (index < 0) return { sessions, result: null, changed: false };
    const session = sessions[index];
    if (expectedUser && session.globalUserId !== expectedUser) return { sessions, result: null, changed: false };
    if (expectedServer && session.serverId !== expectedServer) return { sessions, result: null, changed: false };
    const closed = { ...session, status: 'closed', closedAt: now.toISOString() };
    return { sessions: replaceAt(sessions, index, closed), result: closed };
  });
}

export function updateExternalMcpSession(sessionId, patch = {}, options = {}) {
  const env = options.env || process.env;
  const now = normalizeDate(options.now) || new Date();
  const expectedUser = sanitizeIdentity(options.globalUserId || options.global_user_id || '');
  const expectedServer = sanitizeIdentity(options.serverId || options.server_id || '');
  return mutateSessions(env, (sessions) => {
    const index = sessions.findIndex((item) => item.sessionId === sanitizeSessionId(sessionId));
    if (index < 0) return { sessions, result: null, changed: false };
    const session = sessions[index];
    if (session.status !== 'active' || isExpired(session, now)) return { sessions, result: null, changed: false };
    if (expectedUser && session.globalUserId !== expectedUser) return { sessions, result: null, changed: false };
    if (expectedServer && session.serverId !== expectedServer) return { sessions, result: null, changed: false };
    const upstreamSessionId = sanitizeUpstreamSessionId(patch.upstreamSessionId || patch.upstream_session_id || '');
    const updated = {
      ...session,
      ...(upstreamSessionId ? { upstreamSessionId } : {}),
      updatedAt: now.toISOString(),
    };
    return { sessions: replaceAt(sessions, index, updated), result: updated };
  });
}

function paths(env) {
  const root = path.join(resolveStateDir(env), 'external_mcp');
  return {
    root,
    sessions: path.join(root, 'sessions.json'),
  };
}

function readSessions(env, options = {}) {
  const target = paths(env).sessions;
  assertNoUnrecoveredQuarantine(target);
  const state = readJsonState(target, {
    validate: (value) => isSessionState(value) || isLegacySessions(value),
    missingValue: emptySessionState(),
    critical: true,
  });
  if (!Array.isArray(state)) return state.sessions;
  if (options.lockHeld === true) {
    const migrated = sessionState(state, 1);
    writeJsonAtomic(target, migrated, { validate: isSessionState });
    return migrated.sessions;
  }
  const lock = acquireMutationLock(target);
  if (!lock) throw sessionStoreError('external MCP session store is busy', 'EXTERNAL_MCP_SESSION_STORE_BUSY');
  try {
    return readSessions(env, { lockHeld: true });
  } finally {
    releaseMutationLock(lock);
  }
}

function mutateSessions(env, mutator) {
  const target = paths(env).sessions;
  const lock = acquireMutationLock(target);
  if (!lock) throw sessionStoreError('external MCP session store is busy', 'EXTERNAL_MCP_SESSION_STORE_BUSY');
  try {
    const sessions = readSessions(env, { lockHeld: true });
    const mutation = mutator(sessions);
    if (mutation.changed !== false) {
      writeJsonAtomic(target, sessionState(mutation.sessions, Date.now()), { validate: isSessionState });
    }
    return mutation.result;
  } finally {
    releaseMutationLock(lock);
  }
}

function upsertSession(sessions, session) {
  return [...sessions.filter((item) => item.sessionId !== session.sessionId), session];
}

function replaceAt(items, index, value) {
  return [...items.slice(0, index), value, ...items.slice(index + 1)];
}

function emptySessionState() {
  return sessionState([], 0);
}

function sessionState(sessions, revision) {
  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    revision: Number.isInteger(revision) && revision >= 0 ? revision : 0,
    sessions: Array.isArray(sessions) ? sessions : [],
  };
}

function isSessionState(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && value.schemaVersion === SESSION_SCHEMA_VERSION
    && Number.isInteger(value.revision) && value.revision >= 0
    && Array.isArray(value.sessions) && value.sessions.every(isSession);
}

function isLegacySessions(value) {
  return Array.isArray(value) && value.every(isSession);
}

function isSession(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && /^extmcp_[a-f0-9]{24}$/.test(String(value.sessionId || ''))
    && typeof value.sessionKey === 'string' && Boolean(value.sessionKey)
    && typeof value.globalUserId === 'string' && Boolean(value.globalUserId)
    && typeof value.serverId === 'string' && Boolean(value.serverId)
    && VALID_MODES.has(value.mode) && ['active', 'closed'].includes(value.status)
    && Number.isFinite(Date.parse(String(value.createdAt || '')))
    && Number.isFinite(Date.parse(String(value.expiresAt || '')))
    && (!Object.hasOwn(value, 'upstreamSessionId') || typeof value.upstreamSessionId === 'string')
    && (!Object.hasOwn(value, 'updatedAt') || Number.isFinite(Date.parse(String(value.updatedAt))))
    && (!Object.hasOwn(value, 'closedAt') || Number.isFinite(Date.parse(String(value.closedAt))));
}

function assertNoUnrecoveredQuarantine(target) {
  if (fs.existsSync(target)) return;
  let entries;
  try { entries = fs.readdirSync(path.dirname(target)); } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (!entries.some((entry) => entry.startsWith(`${path.basename(target)}.corrupt-`))) return;
  throw sessionStoreError('external MCP session state is quarantined and requires recovery', 'RAN_AGENT_STATE_CORRUPT');
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

function sessionStoreError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isExpired(session, now) {
  const expiresMs = Date.parse(String(session.expiresAt || ''));
  return Number.isFinite(expiresMs) && expiresMs <= now.getTime();
}

function errorResult(error, errorCode) {
  return { ok: false, error, error_code: errorCode };
}

function normalizeMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  return VALID_MODES.has(mode) ? mode : 'observe';
}

function normalizeDate(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? new Date(parsed) : null;
}

function normalizePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sanitizeSessionId(value) {
  return String(value || '').trim().replace(/[^a-zA-Z0-9_:-]/g, '').slice(0, 80);
}

function sanitizeIdentity(value) {
  return String(value || '').trim().replace(/[\r\n\t]/g, ' ').replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 120);
}

function sanitizeUpstreamSessionId(value) {
  return String(value || '').trim().replace(/[\r\n\t]/g, '').replace(/[^a-zA-Z0-9_.:/=-]/g, '').slice(0, 240);
}
