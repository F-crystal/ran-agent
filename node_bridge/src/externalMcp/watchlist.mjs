import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { resolveStateDir } from '../runtimeState.mjs';

export function addExternalMcpWatch(input = {}, options = {}) {
  const env = options.env || process.env;
  const globalUserId = sanitizeIdentity(input.globalUserId || input.global_user_id || '');
  const serverId = sanitizeIdentity(input.serverId || input.server_id || '');
  const kind = sanitizeKind(input.kind || '');
  const scope = sanitizeScope(input.scope || '');
  if (!globalUserId || !serverId || !kind || !scope || !isSafeScope(scope)) {
    return errorResult('invalid watch scope', 'EXTERNAL_MCP_INVALID_WATCH_SCOPE');
  }
  const now = normalizeDate(options.now || input.now) || new Date();
  const watch = {
    ok: true,
    watchId: `watch_${hashShort(`${globalUserId}:${serverId}:${kind}:${scope}`)}`,
    globalUserId,
    serverId,
    kind,
    scope,
    notify: input.notify !== false,
    createdAt: now.toISOString(),
  };
  writeJson(paths(env).watches, upsertById(readWatches(env), watch, 'watchId'));
  return watch;
}

export function listExternalMcpWatches(options = {}) {
  return readWatches(options.env || process.env);
}

export function removeExternalMcpWatch(watchId, options = {}) {
  const env = options.env || process.env;
  const id = sanitizeIdentity(watchId);
  const watches = readWatches(env);
  const next = watches.filter((item) => item.watchId !== id);
  writeJson(paths(env).watches, next);
  return { ok: next.length !== watches.length, watchId: id };
}

export function checkExternalMcpRateBudget(input = {}, options = {}) {
  const env = options.env || process.env;
  const now = normalizeDate(input.now || options.now) || new Date();
  const globalUserId = sanitizeIdentity(input.globalUserId || input.global_user_id || '');
  const serverId = sanitizeIdentity(input.serverId || input.server_id || '');
  const topicKey = sanitizeScope(input.topicKey || input.topic_key || '');
  if (!globalUserId || !serverId || !topicKey) {
    return { allowed: false, reason: 'invalid_rate_scope' };
  }
  const events = readEvents(env);
  const sameUserEvents = events.filter((item) => item.globalUserId === globalUserId);
  const sameDay = dayKey(now);
  if (sameUserEvents.some((item) => dayKey(item.createdAt) === sameDay)) {
    return { allowed: false, reason: 'global_daily_budget_exhausted' };
  }
  const weekStartMs = now.getTime() - 7 * 24 * 60 * 60 * 1000;
  const serverWeekCount = sameUserEvents.filter((item) => item.serverId === serverId && Date.parse(item.createdAt) >= weekStartMs).length;
  if (serverWeekCount >= 3) {
    return { allowed: false, reason: 'server_weekly_budget_exhausted' };
  }
  const topicCooldownMs = now.getTime() - 24 * 60 * 60 * 1000;
  if (sameUserEvents.some((item) => item.topicKey === topicKey && Date.parse(item.createdAt) > topicCooldownMs)) {
    return { allowed: false, reason: 'topic_cooldown_active' };
  }
  return { allowed: true, reason: 'budget_available' };
}

export function recordExternalMcpNotification(input = {}, options = {}) {
  const env = options.env || process.env;
  const now = normalizeDate(input.now || options.now) || new Date();
  const event = {
    eventId: `notify_${hashShort(`${input.globalUserId}:${input.serverId}:${input.topicKey}:${now.toISOString()}`)}`,
    globalUserId: sanitizeIdentity(input.globalUserId || input.global_user_id || ''),
    serverId: sanitizeIdentity(input.serverId || input.server_id || ''),
    topicKey: sanitizeScope(input.topicKey || input.topic_key || ''),
    createdAt: now.toISOString(),
  };
  writeJson(paths(env).events, [...readEvents(env), event].slice(-500));
  return event;
}

export function reserveExternalMcpNotification(input = {}, options = {}) {
  const env = options.env || process.env;
  const now = normalizeDate(input.now || options.now) || new Date();
  const budget = checkExternalMcpRateBudget({ ...input, now }, { env });
  if (!budget.allowed) {
    return budget;
  }
  const event = recordExternalMcpNotification({ ...input, now }, { env });
  return { allowed: true, reason: 'budget_reserved', event };
}

function paths(env) {
  const root = path.join(resolveStateDir(env), 'external_mcp');
  return {
    root,
    watches: path.join(root, 'watchlist.json'),
    events: path.join(root, 'notification-events.json'),
  };
}

function readWatches(env) {
  return readJson(paths(env).watches);
}

function readEvents(env) {
  return readJson(paths(env).events);
}

function readJson(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item === 'object') : [];
  } catch {
    return [];
  }
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function upsertById(items, item, key) {
  return [...items.filter((existing) => existing[key] !== item[key]), item];
}

function isSafeScope(scope) {
  return /^[a-z][a-z0-9_.-]*:[a-zA-Z0-9_.:/-]+$/.test(scope)
    && !/(cookie|token|secret|sessionid|authorization|sessdata)/i.test(scope);
}

function sanitizeKind(value) {
  const text = String(value || '').trim().toLowerCase();
  return ['forum', 'game', 'browser', 'api'].includes(text) ? text : '';
}

function sanitizeScope(value) {
  return String(value || '').trim().replace(/[\r\n\t]/g, ' ').replace(/[^a-zA-Z0-9_.:/-]/g, '').slice(0, 180);
}

function sanitizeIdentity(value) {
  return String(value || '').trim().replace(/[\r\n\t]/g, ' ').replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 120);
}

function dayKey(value) {
  const date = normalizeDate(value) || new Date(0);
  return date.toISOString().slice(0, 10);
}

function normalizeDate(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? new Date(parsed) : null;
}

function hashShort(value) {
  return createHash('sha256').update(String(value || ''), 'utf8').digest('hex').slice(0, 16);
}

function errorResult(error, errorCode) {
  return { ok: false, error, error_code: errorCode };
}
