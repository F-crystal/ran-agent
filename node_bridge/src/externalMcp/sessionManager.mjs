import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { resolveStateDir } from '../runtimeState.mjs';

const VALID_MODES = new Set(['observe', 'interactive', 'write']);

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
  writeSessions(upsertSession(readSessions(env), session), env);
  return session;
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
  const sessions = readSessions(env);
  const index = sessions.findIndex((item) => item.sessionId === sanitizeSessionId(sessionId));
  if (index < 0) return null;
  const session = sessions[index];
  if (expectedUser && session.globalUserId !== expectedUser) return null;
  if (expectedServer && session.serverId !== expectedServer) return null;
  const closed = { ...session, status: 'closed', closedAt: now.toISOString() };
  sessions[index] = closed;
  writeSessions(sessions, env);
  return closed;
}

export function updateExternalMcpSession(sessionId, patch = {}, options = {}) {
  const env = options.env || process.env;
  const now = normalizeDate(options.now) || new Date();
  const expectedUser = sanitizeIdentity(options.globalUserId || options.global_user_id || '');
  const expectedServer = sanitizeIdentity(options.serverId || options.server_id || '');
  const sessions = readSessions(env);
  const index = sessions.findIndex((item) => item.sessionId === sanitizeSessionId(sessionId));
  if (index < 0) return null;
  const session = sessions[index];
  if (session.status !== 'active' || isExpired(session, now)) return null;
  if (expectedUser && session.globalUserId !== expectedUser) return null;
  if (expectedServer && session.serverId !== expectedServer) return null;
  const upstreamSessionId = sanitizeUpstreamSessionId(patch.upstreamSessionId || patch.upstream_session_id || '');
  const updated = {
    ...session,
    ...(upstreamSessionId ? { upstreamSessionId } : {}),
    updatedAt: now.toISOString(),
  };
  sessions[index] = updated;
  writeSessions(sessions, env);
  return updated;
}

function paths(env) {
  const root = path.join(resolveStateDir(env), 'external_mcp');
  return {
    root,
    sessions: path.join(root, 'sessions.json'),
  };
}

function readSessions(env) {
  try {
    const parsed = JSON.parse(fs.readFileSync(paths(env).sessions, 'utf8'));
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item === 'object') : [];
  } catch {
    return [];
  }
}

function writeSessions(sessions, env) {
  const target = paths(env).sessions;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(sessions, null, 2)}\n`, 'utf8');
}

function upsertSession(sessions, session) {
  return [...sessions.filter((item) => item.sessionId !== session.sessionId), session];
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
