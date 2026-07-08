import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { resolveStateDir } from '../runtimeState.mjs';
import {
  evaluateProactiveAdmission,
  evaluateProactiveEgress,
  normalizeProactiveEvent,
} from '../proactiveEvents.mjs';
import { listExternalMcpEvidence } from './evidenceLog.mjs';
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
  const background = normalizeBoolean(input.background || input.runInBackground || input.run_in_background);
  let globalUserId = sanitizeIdentity(input.globalUserId || input.global_user_id || '');
  let notifyTarget = null;
  if (background) {
    const token = sanitizeIdentity(input.activityTargetToken || input.activity_target_token || '');
    if (!token) {
      return errorResult('activity target token is required', 'EXTERNAL_MCP_ACTIVITY_TARGET_TOKEN_REQUIRED');
    }
    const target = consumeExternalMcpActivityTargetToken(token, { env, now });
    if (!target.ok) return target;
    globalUserId = target.globalUserId;
    notifyTarget = target.target;
  }
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
    background,
    watchScope: sanitizeScope(input.watchScope || input.watch_scope || input.topicKey || input.topic_key || ''),
    notifyTarget,
    sessionId: session.sessionId,
    sessionMode: session.mode || 'interactive',
    allowedToolPattern: sanitizePattern(input.allowedToolPattern || input.allowed_tool_pattern || defaultToolPattern(kind)),
    budget: {
      maxMinutes,
      maxCalls: Math.min(normalizePositiveInt(input.maxCalls || input.max_calls, 80), 500),
      maxShares: Math.min(normalizeNonNegativeInt(firstDefined(input.maxShares, input.max_shares), 5), 50),
      callsUsed: 0,
      sharesUsed: 0,
    },
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + maxMinutes * 60 * 1000).toISOString(),
    nextRunAt: background ? now.toISOString() : '',
    runCount: 0,
  };
  writeActivities(upsertById(readActivities(env), activity, 'activityId'), env);
  return activity;
}

export function createExternalMcpActivityTargetToken(input = {}, options = {}) {
  const env = options.env || process.env;
  const now = normalizeDate(input.now || options.now) || new Date();
  const globalUserId = sanitizeIdentity(input.globalUserId || input.global_user_id || '');
  const target = sanitizeNotifyTarget(input);
  if (!globalUserId || !target) {
    return errorResult('invalid activity target', 'EXTERNAL_MCP_ACTIVITY_TARGET_INVALID');
  }
  const ttlMinutes = Math.min(normalizePositiveInt(input.ttlMinutes || input.ttl_minutes, 30), 60);
  const token = {
    ok: true,
    token: `acttarget_${randomBytes(18).toString('hex')}`,
    status: 'active',
    globalUserId,
    target,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMinutes * 60 * 1000).toISOString(),
  };
  writeTargetTokens(upsertById(readTargetTokens(env), token, 'token'), env);
  return token;
}

export function consumeExternalMcpActivityTargetToken(tokenValue, options = {}) {
  const env = options.env || process.env;
  const now = normalizeDate(options.now) || new Date();
  const tokenText = sanitizeIdentity(tokenValue);
  const tokens = readTargetTokens(env);
  const index = tokens.findIndex((item) => item.token === tokenText);
  if (index < 0 || tokens[index].status !== 'active') {
    return errorResult('activity target token not found', 'EXTERNAL_MCP_ACTIVITY_TARGET_TOKEN_INVALID');
  }
  const token = tokens[index];
  if (isExpired(token, now)) {
    tokens[index] = { ...token, status: 'expired', updatedAt: now.toISOString() };
    writeTargetTokens(tokens, env);
    return errorResult('activity target token expired', 'EXTERNAL_MCP_ACTIVITY_TARGET_TOKEN_EXPIRED');
  }
  tokens[index] = { ...token, status: 'consumed', consumedAt: now.toISOString(), updatedAt: now.toISOString() };
  writeTargetTokens(tokens, env);
  return { ok: true, globalUserId: token.globalUserId, target: token.target };
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

export function getActiveExternalMcpActivity(activityId, options = {}) {
  const activity = getActiveActivity(activityId, options);
  return activity ? { ...activity } : null;
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
      `watch_scope: ${sanitizeScope(activity.watchScope || '')}`,
      `kind: ${normalizeKind(activity.kind) || 'game_play'}`,
      `reason: ${sanitizeText(event.reason || 'activity_tick')}`,
      `budget_calls: ${Number(activity.budget?.callsUsed || 0)}/${Number(activity.budget?.maxCalls || 0)}`,
      'Hermes must decide the next game/read action herself, using mcp_call with the activity_id/watch_scope when a tool call is needed.',
      'A user-visible notify requires trusted external_mcp_evidence refs from successful activity calls; otherwise reply with silent.',
    ].join('\n'),
  };
}

export async function runDueExternalMcpActivities({
  env = process.env,
  now,
  channelHub,
  logger = console,
  sendText,
} = {}) {
  const runtimeNow = normalizeDate(now) || new Date();
  const activities = readActivities(env);
  const results = [];
  let sent = 0;
  let processed = 0;
  for (const activity of activities) {
    if (!isDueBackgroundActivity(activity, runtimeNow)) continue;
    processed += 1;
    const result = await runSingleActivityTick(activity, {
      env,
      now: runtimeNow,
      channelHub,
      logger,
      sendText,
    });
    if (result.sent) sent += 1;
    results.push(result);
  }
  return { ok: true, processed, sent, results };
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
    targetTokens: path.join(root, 'activity_target_tokens.json'),
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

function readTargetTokens(env) {
  try {
    const parsed = JSON.parse(fs.readFileSync(paths(env).targetTokens, 'utf8'));
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item === 'object') : [];
  } catch {
    return [];
  }
}

function writeTargetTokens(tokens, env) {
  const target = paths(env).targetTokens;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(tokens, null, 2)}\n`, 'utf8');
}

function upsertById(items, item, key) {
  return [...items.filter((existing) => existing[key] !== item[key]), item];
}

async function runSingleActivityTick(activity, options = {}) {
  const env = options.env || process.env;
  const now = options.now || new Date();
  const evidenceRefs = trustedActivityEvidenceRefs(activity, { env, now });
  const event = normalizeProactiveEvent({
    event_id: `${activity.activityId}:${Number(activity.runCount || 0) + 1}`,
    kind: activity.kind === 'forum_read' ? 'forum_watch' : 'game_activity',
    global_user_id: activity.globalUserId,
    channel: activity.notifyTarget?.platform || 'wechat',
    watch_scope: activity.watchScope,
    reason: 'external MCP background activity tick',
    evidence_refs: evidenceRefs,
    dedupe_key: `${activity.activityId}:${Number(activity.runCount || 0) + 1}`,
    deliverability: 'notify_allowed',
    allowed_capability_tiers: ['T3'],
    budget_class: 'external_mcp',
    expires_at: activity.expiresAt,
  }).event;
  if (!hasActivityShareBudget(activity)) {
    reasonAfterEarlyExit(activity, options, 'activity_share_budget_exhausted');
    return { activityId: activity.activityId, sent: false, reason: 'activity_share_budget_exhausted' };
  }
  const preAdmission = evaluateProactiveAdmission(event, { env, now });
  if (!preAdmission.accepted && preAdmission.reason !== 'evidence_required') {
    reasonAfterEarlyExit(activity, options, preAdmission.reason);
    return { activityId: activity.activityId, sent: false, reason: preAdmission.reason };
  }
  let sent = false;
  let reason = 'not_notified';
  const message = buildActivityIncomingMessage(activity, now);
  try {
    const response = await options.channelHub?.(message, {
      env,
      logger: options.logger,
      adapter: {
        async sendReply({ text }) {
          if (sent) {
            reason = 'already_sent';
            return;
          }
          if (!hasActivityShareBudget(activity)) {
            reason = 'activity_share_budget_exhausted';
            return;
          }
          const admission = evaluateProactiveAdmission(event, { env, now });
          if (!admission.accepted) {
            reason = admission.reason;
            return;
          }
          const egress = evaluateProactiveEgress({ event, replyText: text, env });
          reason = egress.reason;
          if (!egress.send) return;
          await deliverActivityNotification(activity.notifyTarget, egress.message, options);
          sent = true;
          reason = 'sent';
        },
      },
    });
    if (!sent && response?.suppressReason) reason = response.suppressReason;
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    options.logger?.warn?.(`[external-mcp-activity] tick failed: ${messageText}`);
    reason = 'tick_failed';
  }
  updateActivityAfterTick(activity, { env, now, sent, reason });
  return { activityId: activity.activityId, sent, reason };
}

function reasonAfterEarlyExit(activity, options, reason) {
  updateActivityAfterTick(activity, {
    env: options.env || process.env,
    now: options.now || new Date(),
    sent: false,
    reason,
  });
}

function buildActivityIncomingMessage(activity = {}, now = new Date()) {
  const target = activity.notifyTarget || {};
  return {
    ...buildExternalMcpActivitySyntheticTurn(activity, { reason: 'activity_tick' }),
    id: `${activity.activityId}-${Number(activity.runCount || 0) + 1}`,
    message_id: `${activity.activityId}-${Number(activity.runCount || 0) + 1}`,
    platform: target.platform || 'wechat',
    channel_type: target.channelType || 'dm',
    conversation_id: target.conversationId || '',
    sender_id: target.senderId || '',
    created_at: now.getTime(),
  };
}

async function deliverActivityNotification(target = {}, text = '', options = {}) {
  if (typeof options.sendText === 'function') {
    await options.sendText(target, text);
    return;
  }
  if (target.platform === 'wechat' && typeof options.env?.sendFollowUpMessages === 'function') {
    await options.env.sendFollowUpMessages([text]);
    return;
  }
  throw new Error('activity notification sender unavailable');
}

function updateActivityAfterTick(activity, { env, now, sent, reason }) {
  const activities = readActivities(env);
  const index = activities.findIndex((item) => item.activityId === activity.activityId);
  if (index < 0) return;
  const activityAfterShare = sent
    ? {
        ...activity,
        budget: {
          ...activity.budget,
          sharesUsed: Number(activity.budget?.sharesUsed || 0) + 1,
        },
      }
    : activity;
  const shouldStop = sent || isExpired(activity, now) || reason === 'activity_share_budget_exhausted';
  const next = shouldStop
    ? stopActivityRecord(activityAfterShare, now, sent ? 'notified' : (isExpired(activity, now) ? 'activity_expired' : reason))
    : {
        ...activity,
        runCount: Number(activity.runCount || 0) + 1,
        lastRunAt: now.toISOString(),
        lastRunReason: sanitizeText(reason),
        nextRunAt: new Date(now.getTime() + activityTickMs(env)).toISOString(),
        updatedAt: now.toISOString(),
      };
  activities[index] = next;
  writeActivities(activities, env);
}

function hasActivityShareBudget(activity = {}) {
  return Number(activity.budget?.sharesUsed || 0) < Number(activity.budget?.maxShares || 0);
}

function isDueBackgroundActivity(activity, now) {
  if (activity?.status !== 'active' || activity.background !== true || !activity.notifyTarget) return false;
  if (isExpired(activity, now)) return false;
  const nextRunMs = Date.parse(String(activity.nextRunAt || activity.createdAt || ''));
  return !Number.isFinite(nextRunMs) || nextRunMs <= now.getTime();
}

function trustedActivityEvidenceRefs(activity = {}, options = {}) {
  const env = options.env || process.env;
  const now = normalizeDate(options.now) || new Date();
  return listExternalMcpEvidence({ env })
    .filter((item) => item.global_user_id === activity.globalUserId)
    .filter((item) => item.server_id === activity.serverId)
    .filter((item) => !activity.watchScope || item.watch_scope === activity.watchScope)
    .filter((item) => ['allow', 'allowed'].includes(String(item.decision || '').toLowerCase()))
    .filter((item) => ['success', 'partial_success'].includes(String(item.status || '').toLowerCase()))
    .filter((item) => {
      const ts = Date.parse(String(item.timestamp || ''));
      return Number.isFinite(ts) && Math.abs(now.getTime() - ts) <= 24 * 60 * 60 * 1000;
    })
    .map((item) => String(item.evidence_ref || '').trim())
    .filter(Boolean)
    .slice(-10);
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

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function normalizeDate(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? new Date(parsed) : null;
}

function normalizeBoolean(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function activityTickMs(env = process.env) {
  return Math.min(Math.max(normalizePositiveInt(env.EXTERNAL_MCP_ACTIVITY_TICK_MS, 60_000), 5_000), 15 * 60_000);
}

function sanitizeNotifyTarget(input = {}) {
  const platform = sanitizePlatform(input.platform || input.channel || '');
  const conversationId = sanitizeIdentity(input.conversationId || input.conversation_id || '');
  const senderId = sanitizeIdentity(input.senderId || input.sender_id || '');
  if (!platform || !conversationId || !senderId) return null;
  return {
    platform,
    channelType: sanitizeChannelType(input.channelType || input.channel_type || 'dm'),
    conversationId,
    senderId,
  };
}

function sanitizeIdentity(value) {
  return String(value || '').trim().replace(/[\r\n\t]/g, ' ').replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 120);
}

function sanitizeScope(value) {
  return String(value || '').trim().replace(/[\r\n\t]/g, ' ').replace(/[^a-zA-Z0-9_.:/-]/g, '').slice(0, 180);
}

function sanitizePlatform(value) {
  const text = String(value || '').trim().toLowerCase();
  return ['wechat', 'feishu', 'desktop'].includes(text) ? text : '';
}

function sanitizeChannelType(value) {
  const text = String(value || '').trim().toLowerCase();
  return ['dm', 'group', 'desktop'].includes(text) ? text : 'dm';
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
