import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { readJsonState, writeJsonAtomic } from '../atomicState.mjs';
import { resolveStateDir } from '../runtimeState.mjs';

const WATCH_SCHEMA_VERSION = 1;
const EVENT_SCHEMA_VERSION = 1;

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
  return mutateWatches(env, (watches) => ({
    watches: upsertById(watches, watch, 'watchId'),
    result: watch,
  }));
}

export function listExternalMcpWatches(options = {}) {
  return readWatches(options.env || process.env);
}

export function removeExternalMcpWatch(watchId, options = {}) {
  const env = options.env || process.env;
  const id = sanitizeIdentity(watchId);
  return mutateWatches(env, (watches) => {
    const next = watches.filter((item) => item.watchId !== id);
    return {
      watches: next,
      result: { ok: next.length !== watches.length, watchId: id },
    };
  });
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
  const events = readActiveEvents(env, now);
  return rateBudgetForEvents(events, { globalUserId, serverId, topicKey, now });
}

function rateBudgetForEvents(events, { globalUserId, serverId, topicKey, now }) {
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
    reservationId: `reservation_${hashShort(`${input.globalUserId}:${input.serverId}:${input.topicKey}:${now.toISOString()}:sent`)}`,
    globalUserId: sanitizeIdentity(input.globalUserId || input.global_user_id || ''),
    serverId: sanitizeIdentity(input.serverId || input.server_id || ''),
    topicKey: sanitizeScope(input.topicKey || input.topic_key || ''),
    createdAt: now.toISOString(),
    status: 'sent',
  };
  return mutateEvents(env, (events) => ({
    events: [...events, event].slice(-500),
    result: event,
  }));
}

export function reserveExternalMcpNotification(input = {}, options = {}) {
  const env = options.env || process.env;
  const now = normalizeDate(input.now || options.now) || new Date();
  const globalUserId = sanitizeIdentity(input.globalUserId || input.global_user_id || '');
  const serverId = sanitizeIdentity(input.serverId || input.server_id || '');
  const topicKey = sanitizeScope(input.topicKey || input.topic_key || '');
  if (!globalUserId || !serverId || !topicKey) return { allowed: false, reason: 'invalid_rate_scope' };
  return mutateEvents(env, (events) => {
    const budget = rateBudgetForEvents(readActiveEventsFrom(events, now), { globalUserId, serverId, topicKey, now });
    if (!budget.allowed) return { events, result: budget, changed: false };
    const event = {
      eventId: `notify_${hashShort(`${globalUserId}:${serverId}:${topicKey}:${now.toISOString()}`)}`,
      reservationId: `reservation_${hashShort(`${globalUserId}:${serverId}:${topicKey}:${now.toISOString()}:reserved`)}`,
      globalUserId,
      serverId,
      topicKey,
      createdAt: now.toISOString(),
      reserveExpiresAt: new Date(now.getTime() + 10 * 60 * 1000).toISOString(),
      status: 'reserved',
    };
    return { events: [...events, event].slice(-500), result: { allowed: true, reason: 'budget_reserved', event } };
  });
}

export function commitExternalMcpNotificationReservation(reservationId, options = {}) {
  const env = options.env || process.env;
  const now = normalizeDate(options.now) || new Date();
  const id = sanitizeIdentity(reservationId);
  return mutateEvents(env, (events) => {
    let committed = null;
    const next = events.map((item) => {
      if (item?.reservationId !== id && item?.eventId !== id) return item;
      committed = { ...item, status: 'sent', sentAt: now.toISOString() };
      return committed;
    });
    return { events: next.slice(-500), result: committed, changed: Boolean(committed) };
  });
}

export function releaseExternalMcpNotificationReservation(reservationId, options = {}) {
  const env = options.env || process.env;
  const id = sanitizeIdentity(reservationId);
  return mutateEvents(env, (events) => {
    const next = events.filter((item) => item?.reservationId !== id && item?.eventId !== id);
    return {
      events: next.slice(-500),
      result: { ok: next.length !== events.length, reservationId: id },
      changed: next.length !== events.length,
    };
  });
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
  return readCollection(paths(env).watches, 'watches', isWatchState, isLegacyWatches, watchState, env);
}

function readEvents(env) {
  return readCollection(paths(env).events, 'events', isEventState, isLegacyEvents, eventState, env);
}

function readActiveEvents(env, now) {
  return readActiveEventsFrom(readEvents(env), now);
}

function readActiveEventsFrom(events, now) {
  const nowMs = now.getTime();
  return events.filter((item) => {
    const status = String(item.status || 'sent').trim().toLowerCase();
    if (status === 'released' || status === 'failed') return false;
    if (status === 'reserved') {
      const expiresMs = Date.parse(String(item.reserveExpiresAt || ''));
      return Number.isFinite(expiresMs) && expiresMs >= nowMs;
    }
    return status === 'sent' || status === '';
  });
}

function readCollection(filePath, key, validateState, validateLegacy, makeState, env, options = {}) {
  assertNoUnrecoveredQuarantine(filePath);
  const state = readJsonState(filePath, {
    validate: (value) => validateState(value) || validateLegacy(value),
    missingValue: makeState([], 0),
    critical: true,
  });
  if (!Array.isArray(state)) return state[key];
  if (options.lockHeld === true) {
    const migrated = makeState(state, 1);
    writeJsonAtomic(filePath, migrated, { validate: validateState });
    return migrated[key];
  }
  const lock = acquireMutationLock(filePath);
  if (!lock) throw watchStoreError('external MCP state is busy', 'EXTERNAL_MCP_WATCH_STORE_BUSY');
  try {
    return readCollection(filePath, key, validateState, validateLegacy, makeState, env, { lockHeld: true });
  } finally {
    releaseMutationLock(lock);
  }
}

function mutateWatches(env, mutator) {
  return mutateCollection(paths(env).watches, 'watches', isWatchState, isLegacyWatches, watchState, env, mutator);
}

function mutateEvents(env, mutator) {
  return mutateCollection(paths(env).events, 'events', isEventState, isLegacyEvents, eventState, env, mutator);
}

function mutateCollection(filePath, key, validateState, validateLegacy, makeState, env, mutator) {
  const lock = acquireMutationLock(filePath);
  if (!lock) throw watchStoreError('external MCP state is busy', 'EXTERNAL_MCP_WATCH_STORE_BUSY');
  try {
    const values = readCollection(filePath, key, validateState, validateLegacy, makeState, env, { lockHeld: true });
    const mutation = mutator(values);
    if (mutation.changed !== false) {
      writeJsonAtomic(filePath, makeState(mutation[key], Date.now()), { validate: validateState });
    }
    return mutation.result;
  } finally {
    releaseMutationLock(lock);
  }
}

function watchState(watches, revision) {
  return { schemaVersion: WATCH_SCHEMA_VERSION, revision: validRevision(revision), watches: Array.isArray(watches) ? watches : [] };
}

function eventState(events, revision) {
  return { schemaVersion: EVENT_SCHEMA_VERSION, revision: validRevision(revision), events: Array.isArray(events) ? events : [] };
}

function validRevision(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function isWatchState(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && value.schemaVersion === WATCH_SCHEMA_VERSION && validRevision(value.revision) === value.revision
    && Array.isArray(value.watches) && value.watches.every(isWatch);
}

function isEventState(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && value.schemaVersion === EVENT_SCHEMA_VERSION && validRevision(value.revision) === value.revision
    && Array.isArray(value.events) && value.events.every(isNotificationEvent);
}

function isLegacyWatches(value) { return Array.isArray(value) && value.every(isWatch); }
function isLegacyEvents(value) { return Array.isArray(value) && value.every(isNotificationEvent); }

function isWatch(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && /^watch_[a-f0-9]{16}$/.test(String(value.watchId || ''))
    && typeof value.globalUserId === 'string' && Boolean(value.globalUserId)
    && typeof value.serverId === 'string' && Boolean(value.serverId)
    && ['forum', 'game', 'browser', 'api', 'embodied', 'other'].includes(value.kind)
    && typeof value.scope === 'string' && isSafeScope(value.scope)
    && typeof value.notify === 'boolean' && Number.isFinite(Date.parse(String(value.createdAt || '')));
}

function isNotificationEvent(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && /^notify_[a-f0-9]{16}$/.test(String(value.eventId || ''))
    && /^reservation_[a-f0-9]{16}$/.test(String(value.reservationId || ''))
    && typeof value.globalUserId === 'string' && Boolean(value.globalUserId)
    && typeof value.serverId === 'string' && Boolean(value.serverId)
    && typeof value.topicKey === 'string' && Boolean(value.topicKey)
    && Number.isFinite(Date.parse(String(value.createdAt || '')))
    && ['reserved', 'sent', 'released', 'failed'].includes(String(value.status || ''))
    && (!Object.hasOwn(value, 'reserveExpiresAt') || Number.isFinite(Date.parse(String(value.reserveExpiresAt))))
    && (!Object.hasOwn(value, 'sentAt') || Number.isFinite(Date.parse(String(value.sentAt))));
}

function assertNoUnrecoveredQuarantine(target) {
  if (fs.existsSync(target)) return;
  let entries;
  try { entries = fs.readdirSync(path.dirname(target)); } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (!entries.some((entry) => entry.startsWith(`${path.basename(target)}.corrupt-`))) return;
  throw watchStoreError('external MCP state is quarantined and requires recovery', 'RAN_AGENT_STATE_CORRUPT');
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

function watchStoreError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
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
  return ['forum', 'game', 'browser', 'api', 'embodied', 'other'].includes(text) ? text : '';
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
