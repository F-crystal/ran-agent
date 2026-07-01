import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { resolveStateDir } from '../runtimeState.mjs';
import { trustExternalMcpScopedGrant } from './policy.mjs';
import {
  closeExternalMcpSession,
  getExternalMcpSession,
  openExternalMcpSession,
} from './sessionManager.mjs';

const abortControllers = new Map();

export function startExternalMcpActivity(input = {}, options = {}) {
  const env = options.env || process.env;
  const now = normalizeDate(input.now || options.now) || new Date();
  const globalUserId = sanitizeIdentity(input.globalUserId || input.global_user_id || '');
  const serverId = sanitizeIdentity(input.serverId || input.server_id || '');
  const kind = normalizeKind(input.kind);
  if (!globalUserId || !serverId || !kind) {
    return errorResult('invalid activity scope', 'EXTERNAL_MCP_INVALID_ACTIVITY_SCOPE');
  }
  const maxMinutes = Math.min(normalizePositiveInt(input.maxMinutes || input.max_minutes, 30), 240);
  const session = input.sessionId
    ? { sessionId: sanitizeIdentity(input.sessionId), mode: 'interactive' }
    : openExternalMcpSession({
        globalUserId,
        serverId,
        mode: 'interactive',
        trigger: 'user_turn',
        ttlMinutes: maxMinutes,
        now,
      }, { env, now });
  if (session.ok === false) return session;
  const activity = {
    ok: true,
    activityId: `actmcp_${randomBytes(12).toString('hex')}`,
    grantId: `grant_${randomBytes(12).toString('hex')}`,
    globalUserId,
    serverId,
    kind,
    status: 'active',
    sessionId: session.sessionId,
    sessionMode: session.mode || 'interactive',
    allowedToolPattern: sanitizePattern(input.allowedToolPattern || input.allowed_tool_pattern || defaultToolPattern(kind)),
    budget: {
      maxMinutes,
      maxCalls: Math.min(normalizePositiveInt(input.maxCalls || input.max_calls, 80), 500),
      maxShares: Math.min(normalizeNonNegativeInt(input.maxShares || input.max_shares, 5), 50),
      callsUsed: 0,
      sharesUsed: 0,
    },
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + maxMinutes * 60 * 1000).toISOString(),
  };
  writeActivities(upsertById(readActivities(env), activity, 'activityId'), env);
  return activity;
}

export function getTrustedExternalMcpActivityGrant(activityId, options = {}) {
  const activity = getActiveActivity(activityId, options);
  if (!activity) return null;
  return trustExternalMcpScopedGrant({
    grantId: activity.grantId,
    kind: activity.kind,
    serverId: activity.serverId,
    mode: activity.sessionMode || 'interactive',
    allowedToolPattern: activity.allowedToolPattern,
    expiresAt: activity.expiresAt,
  });
}

export function consumeExternalMcpActivityCall(activityId, options = {}) {
  const env = options.env || process.env;
  const now = normalizeDate(options.now) || new Date();
  const activities = readActivities(env);
  const index = activities.findIndex((item) => item.activityId === sanitizeIdentity(activityId));
  if (index < 0 || activities[index].status !== 'active') {
    return { allowed: false, reason: 'activity_not_active' };
  }
  const activity = activities[index];
  if (isExpired(activity, now)) {
    activities[index] = stopActivityRecord(activity, now, 'activity_expired');
    writeActivities(activities, env);
    return { allowed: false, reason: 'activity_expired' };
  }
  if (Number(activity.budget?.callsUsed || 0) >= Number(activity.budget?.maxCalls || 0)) {
    activities[index] = stopActivityRecord(activity, now, 'activity_call_budget_exhausted');
    writeActivities(activities, env);
    return { allowed: false, reason: 'activity_call_budget_exhausted' };
  }
  const next = {
    ...activity,
    budget: {
      ...activity.budget,
      callsUsed: Number(activity.budget?.callsUsed || 0) + 1,
    },
    updatedAt: now.toISOString(),
  };
  activities[index] = next;
  writeActivities(activities, env);
  return { allowed: true, reason: 'activity_budget_available', activity: next };
}

export function stopExternalMcpActivitiesByUser(globalUserId, options = {}) {
  const env = options.env || process.env;
  const now = normalizeDate(options.now) || new Date();
  const userId = sanitizeIdentity(globalUserId);
  const activities = readActivities(env);
  const stoppedActivityIds = [];
  const next = activities.map((activity) => {
    if (activity.globalUserId !== userId || activity.status !== 'active') return activity;
    stoppedActivityIds.push(activity.activityId);
    closeExternalMcpSession(activity.sessionId, {
      env,
      globalUserId: activity.globalUserId,
      serverId: activity.serverId,
      now,
    });
    return stopActivityRecord(activity, now, options.reason || 'user_stop');
  });
  writeActivities(next, env);
  abortRuntimeControllers({ globalUserId: userId, activityIds: stoppedActivityIds });
  return { ok: true, stoppedActivityIds };
}

export function registerExternalMcpAbortController(scope = {}, controller, options = {}) {
  if (!controller || typeof controller.abort !== 'function') return () => {};
  const env = options.env || process.env;
  const globalUserId = sanitizeIdentity(scope.globalUserId || scope.global_user_id || '');
  const serverId = sanitizeIdentity(scope.serverId || scope.server_id || '');
  const activityId = sanitizeIdentity(scope.activityId || scope.activity_id || '');
  const sessionId = sanitizeIdentity(scope.sessionId || scope.session_id || '');
  const key = `abort_${randomBytes(8).toString('hex')}`;
  const pollMs = Math.min(normalizePositiveInt(options.pollMs || options.poll_ms, 250), 5_000);
  const item = {
    globalUserId,
    serverId,
    activityId,
    sessionId,
    controller,
    timer: null,
  };
  item.timer = setInterval(() => {
    if (controller.signal?.aborted) {
      unregisterAbortController(key);
      return;
    }
    if (activityId && !getActiveActivity(activityId, { env, globalUserId, serverId })) {
      abortController(item);
      unregisterAbortController(key);
      return;
    }
    if (sessionId && !getExternalMcpSession(sessionId, { env, globalUserId, serverId })) {
      abortController(item);
      unregisterAbortController(key);
    }
  }, pollMs);
  item.timer.unref?.();
  abortControllers.set(key, item);
  return () => unregisterAbortController(key);
}

export function buildExternalMcpActivitySyntheticTurn(activity = {}, event = {}) {
  return {
    route_hint: 'external_mcp_activity',
    text: [
      '[External MCP activity turn]',
      `activity_id: ${sanitizeIdentity(activity.activityId || '')}`,
      `server_id: ${sanitizeIdentity(activity.serverId || '')}`,
      `kind: ${normalizeKind(activity.kind) || 'game_play'}`,
      `reason: ${sanitizeText(event.reason || 'activity_tick')}`,
      `budget_calls: ${Number(activity.budget?.callsUsed || 0)}/${Number(activity.budget?.maxCalls || 0)}`,
      'Hermes must decide the next game/read action herself, or stay silent/share a short update if useful.',
    ].join('\n'),
  };
}

function getActiveActivity(activityId, options = {}) {
  const env = options.env || process.env;
  const now = normalizeDate(options.now) || new Date();
  const expectedUser = sanitizeIdentity(options.globalUserId || options.global_user_id || '');
  const expectedServer = sanitizeIdentity(options.serverId || options.server_id || '');
  const activity = readActivities(env).find((item) => item.activityId === sanitizeIdentity(activityId));
  if (!activity || activity.status !== 'active' || isExpired(activity, now)) return null;
  if (expectedUser && activity.globalUserId !== expectedUser) return null;
  if (expectedServer && activity.serverId !== expectedServer) return null;
  return activity;
}

function abortRuntimeControllers({ globalUserId, activityIds }) {
  const activitySet = new Set(activityIds);
  for (const [key, item] of abortControllers.entries()) {
    if (item.globalUserId !== globalUserId && !activitySet.has(item.activityId)) continue;
    abortController(item);
    unregisterAbortController(key);
  }
}

function abortController(item) {
  try {
    item.controller.abort();
  } catch {
    // Abort is best-effort; persisted grant revocation is the hard stop.
  }
}

function unregisterAbortController(key) {
  const item = abortControllers.get(key);
  if (item?.timer) clearInterval(item.timer);
  abortControllers.delete(key);
}

function paths(env) {
  const root = path.join(resolveStateDir(env), 'external_mcp');
  return {
    activities: path.join(root, 'activities.json'),
  };
}

function readActivities(env) {
  try {
    const parsed = JSON.parse(fs.readFileSync(paths(env).activities, 'utf8'));
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item === 'object') : [];
  } catch {
    return [];
  }
}

function writeActivities(activities, env) {
  const target = paths(env).activities;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(activities, null, 2)}\n`, 'utf8');
}

function upsertById(items, item, key) {
  return [...items.filter((existing) => existing[key] !== item[key]), item];
}

function stopActivityRecord(activity, now, reason) {
  return {
    ...activity,
    status: 'stopped',
    stopReason: sanitizeText(reason),
    stoppedAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

function isExpired(activity, now) {
  const expiresMs = Date.parse(String(activity.expiresAt || ''));
  return Number.isFinite(expiresMs) && expiresMs <= now.getTime();
}

function defaultToolPattern(kind) {
  if (kind === 'forum_read') return '^forum\\.(read|search|list|get|fetch)';
  return '^(game|ecosystem)\\.';
}

function normalizeKind(value) {
  const text = String(value || '').trim().toLowerCase();
  return ['game_play', 'forum_read'].includes(text) ? text : '';
}

function normalizePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeNonNegativeInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function normalizeDate(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? new Date(parsed) : null;
}

function sanitizeIdentity(value) {
  return String(value || '').trim().replace(/[\r\n\t]/g, ' ').replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 120);
}

function sanitizePattern(value) {
  return String(value || '').trim().replace(/[\r\n\t]/g, ' ').slice(0, 160);
}

function sanitizeText(value) {
  return String(value || '').trim().replace(/[\r\n\t]/g, ' ').slice(0, 160);
}

function errorResult(error, errorCode) {
  return { ok: false, error, error_code: errorCode };
}
