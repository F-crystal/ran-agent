import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { readJsonState, writeJsonAtomic } from '../atomicState.mjs';
import { resolveStateDir } from '../runtimeState.mjs';


const SCHEMA_VERSION = 1;
const TERMINAL_STATUSES = new Set(['completed', 'stopped', 'expired']);
const VALID_STATUSES = new Set(['active', 'paused', 'blocked', ...TERMINAL_STATUSES]);
const VALID_DOMAINS = new Set(['game', 'forum', 'embodied', 'other']);
const MUTABLE_FIELDS = new Set(['status', 'checkpoint', 'pendingOperation', 'nextWake', 'notifyTarget', 'coreJobReceipt']);
const MAX_LEASE_MS = 5 * 60 * 1000;


export function createExternalMcpActivityStore(options = {}) {
  const env = options.env || process.env;
  const statePath = options.statePath || path.join(resolveStateDir(env), 'external_mcp', 'activities.json');

  function readState(readOptions = {}) {
    const now = normalizeNow(readOptions.now || options.now);
    assertNoUnrecoveredQuarantine(statePath);
    const state = readJsonState(statePath, {
      validate: (value) => isActivityState(value) || isLegacyState(value),
      missingValue: emptyState(),
      critical: true,
    });
    if (!isLegacyState(state)) return state;
    if (readOptions.lockHeld !== true) {
      const lock = acquireMutationLock(statePath);
      if (!lock) throw storeException('activity store is busy', 'EXTERNAL_MCP_ACTIVITY_STORE_BUSY');
      try {
        return readState({ ...readOptions, now, lockHeld: true });
      } finally {
        releaseMutationLock(lock);
      }
    }
    const migrated = migrateLegacyState(state, now);
    writeJsonAtomic(statePath, migrated, { validate: isActivityState });
    return migrated;
  }

  function writeState(state) {
    writeJsonAtomic(statePath, state, { validate: isActivityState });
  }

  function mutate(mutator, mutationOptions = {}) {
    const lock = acquireMutationLock(statePath);
    if (!lock) return error('activity store is busy', 'EXTERNAL_MCP_ACTIVITY_STORE_BUSY');
    try {
      const now = normalizeNow(mutationOptions.now || options.now);
      const state = readState({ now, lockHeld: true });
      const result = mutator(state, now);
      if (!result?.ok || !result.state) return result?.result || error('activity mutation failed', 'EXTERNAL_MCP_ACTIVITY_MUTATION_FAILED');
      writeState(result.state);
      return result.result;
    } finally {
      releaseMutationLock(lock);
    }
  }

  return {
    statePath,

    list(readOptions = {}) {
      return clone(readState(readOptions).activities);
    },

    get(activityId, readOptions = {}) {
      const id = cleanId(activityId);
      const activity = readState(readOptions).activities.find((item) => item.activityId === id);
      return activity ? clone(activity) : null;
    },

    create(input = {}, createOptions = {}) {
      return mutate((state, now) => {
        const activity = normalizeNewActivity(input, now);
        if (!activity) return noWrite(error('activity record is invalid', 'EXTERNAL_MCP_ACTIVITY_INVALID'));
        if (state.activities.some((item) => item.activityId === activity.activityId)) {
          return noWrite(error('activity already exists', 'EXTERNAL_MCP_ACTIVITY_EXISTS'));
        }
        const next = nextState(state, [...state.activities, activity], now);
        return writeResult(next, { ok: true, activity: clone(activity) });
      }, createOptions);
    },

    compareAndSwap(activityId, input = {}) {
      return mutate((state, now) => commitPatch(state, activityId, input, now), input);
    },

    adjustScope(activityId, input = {}) {
      return mutate((state, now) => {
        const found = findActivity(state, activityId);
        if (!found) return noWrite(error('activity not found', 'EXTERNAL_MCP_ACTIVITY_NOT_FOUND'));
        const { activity, index } = found;
        const terminalError = rejectTerminal(activity);
        if (terminalError) return noWrite(terminalError);
        const stale = rejectStale(activity, input.expectedRevision);
        if (stale) return noWrite(stale);
        if (activity.leaseUntil && Date.parse(activity.leaseUntil) > now.getTime()
          && activity.leaseOwner !== cleanId(input.leaseOwner)) {
          return noWrite(error('activity lease owner does not match', 'EXTERNAL_MCP_ACTIVITY_LEASE_OWNER_MISMATCH'));
        }
        const newScope = normalizeScope(input.newScope);
        const suppliedRisk = Object.hasOwn(input, 'newRisk') ? normalizeRisk(input.newRisk) : activity.risk;
        if (!newScope || !suppliedRisk || !deepEqual(suppliedRisk, activity.risk)
          || !isEqualOrNarrowerScope(activity.scope, newScope)) {
          return noWrite(error(
            'activity scope widening requires a boundary',
            'EXTERNAL_MCP_ACTIVITY_SCOPE_WIDENING_REQUIRES_BOUNDARY',
          ));
        }
        if (deepEqual(activity.scope, newScope)) {
          return noWrite({ ok: true, idempotent: true, activity: clone(activity) });
        }
        const updated = withRevision(activity, { scope: newScope }, now);
        const activities = replaceAt(state.activities, index, updated);
        return writeResult(nextState(state, activities, now), { ok: true, idempotent: false, activity: clone(updated) });
      }, input);
    },

    acquireLease(activityId, input = {}) {
      return mutate((state, now) => {
        const found = findActivity(state, activityId);
        if (!found) return noWrite(error('activity not found', 'EXTERNAL_MCP_ACTIVITY_NOT_FOUND'));
        const { activity, index } = found;
        const terminalError = rejectTerminal(activity);
        if (terminalError) return noWrite(terminalError);
        if (activity.status !== 'active') {
          return noWrite(error('activity is not active', 'EXTERNAL_MCP_ACTIVITY_NOT_ACTIVE'));
        }
        const stale = rejectStale(activity, input.expectedRevision);
        if (stale) return noWrite(stale);
        const leaseOwner = cleanId(input.leaseOwner);
        if (!leaseOwner) return noWrite(error('lease owner is required', 'EXTERNAL_MCP_ACTIVITY_LEASE_OWNER_REQUIRED'));
        if (activity.leaseUntil && Date.parse(activity.leaseUntil) > now.getTime()
          && activity.leaseOwner !== leaseOwner) {
          return noWrite(error('activity lease is held', 'EXTERNAL_MCP_ACTIVITY_LEASE_HELD'));
        }
        const leaseMs = Math.min(positiveInt(input.leaseMs, 30_000), MAX_LEASE_MS);
        const updated = withRevision(activity, {
          leaseOwner,
          leaseUntil: new Date(now.getTime() + leaseMs).toISOString(),
        }, now);
        const activities = replaceAt(state.activities, index, updated);
        return writeResult(nextState(state, activities, now), { ok: true, activity: clone(updated) });
      }, input);
    },

    releaseLease(activityId, input = {}) {
      return mutate((state, now) => {
        const found = findActivity(state, activityId);
        if (!found) return noWrite(error('activity not found', 'EXTERNAL_MCP_ACTIVITY_NOT_FOUND'));
        const { activity, index } = found;
        const terminalError = rejectTerminal(activity);
        if (terminalError) return noWrite(terminalError);
        const stale = rejectStale(activity, input.expectedRevision);
        if (stale) return noWrite(stale);
        if (!activity.leaseOwner || activity.leaseOwner !== cleanId(input.leaseOwner)) {
          return noWrite(error('activity lease owner does not match', 'EXTERNAL_MCP_ACTIVITY_LEASE_OWNER_MISMATCH'));
        }
        const updated = withRevision(activity, { leaseOwner: null, leaseUntil: null }, now);
        const activities = replaceAt(state.activities, index, updated);
        return writeResult(nextState(state, activities, now), { ok: true, activity: clone(updated) });
      }, input);
    },

    commitCallback(activityId, input = {}) {
      return mutate((state, now) => {
        const found = findActivity(state, activityId);
        if (!found) return noWrite(error('activity not found', 'EXTERNAL_MCP_ACTIVITY_NOT_FOUND'));
        const { activity } = found;
        const terminalError = rejectTerminal(activity);
        if (terminalError) return noWrite(terminalError);
        const stale = rejectStale(activity, input.expectedRevision);
        if (stale) return noWrite(stale);
        if (!activity.leaseOwner || activity.leaseOwner !== cleanId(input.leaseOwner)) {
          return noWrite(error('activity lease owner does not match', 'EXTERNAL_MCP_ACTIVITY_LEASE_OWNER_MISMATCH'));
        }
        if (!activity.leaseUntil || Date.parse(activity.leaseUntil) <= now.getTime()) {
          return noWrite(error('activity lease expired', 'EXTERNAL_MCP_ACTIVITY_LEASE_EXPIRED'));
        }
        return commitPatch(state, activityId, { ...input, leaseOwner: input.leaseOwner }, now);
      }, input);
    },

    stop(activityId, input = {}) {
      return mutate((state, now) => {
        const found = findActivity(state, activityId);
        if (!found) return noWrite(error('activity not found', 'EXTERNAL_MCP_ACTIVITY_NOT_FOUND'));
        const { activity, index } = found;
        if (activity.status === 'stopped') return noWrite(error('activity is stopped', 'EXTERNAL_MCP_ACTIVITY_STOPPED'));
        if (TERMINAL_STATUSES.has(activity.status)) {
          return noWrite(error('activity is terminal', 'EXTERNAL_MCP_ACTIVITY_TERMINAL'));
        }
        const stale = rejectStale(activity, input.expectedRevision);
        if (stale) return noWrite(stale);
        const timestamps = { ...activity.timestamps, stoppedAt: now.toISOString() };
        const updated = withRevision(activity, {
          status: 'stopped',
          pendingOperation: null,
          nextWake: null,
          leaseOwner: null,
          leaseUntil: null,
          timestamps,
        }, now);
        const activities = replaceAt(state.activities, index, updated);
        return writeResult(nextState(state, activities, now), { ok: true, activity: clone(updated) });
      }, input);
    },

    // Owner-wide cancellation is deliberately a store transaction rather than
    // a loop of `stop()` calls. A process crash or sibling writer therefore
    // leaves either every matching unfinished record untouched or every one
    // stopped in the same atomic state replacement.
    stopAllForActor(input = {}) {
      return mutate((state, now) => {
        const actorKey = cleanId(input.actorKey);
        if (!actorKey) return noWrite(error('activity actor is required', 'EXTERNAL_MCP_ACTIVITY_ACTOR_REQUIRED'));
        const matched = state.activities
          .map((activity, index) => ({ activity, index }))
          .filter(({ activity }) => activity.actor.key === actorKey && !TERMINAL_STATUSES.has(activity.status));
        if (matched.length === 0) {
          return noWrite(error('no unfinished activities matched actor', 'EXTERNAL_MCP_ACTIVITY_STOP_ALL_NO_MATCH'));
        }
        const activityIds = matched.map(({ activity }) => activity.activityId).sort();
        const transactionId = `stopall_${crypto.createHash('sha256').update(JSON.stringify({
          actorKey,
          activityIds,
          committedAt: now.toISOString(),
        })).digest('hex').slice(0, 32)}`;
        const activities = state.activities.map((activity) => {
          if (activity.actor.key !== actorKey || TERMINAL_STATUSES.has(activity.status)) return activity;
          const timestamps = { ...activity.timestamps, stoppedAt: now.toISOString() };
          return withRevision(activity, {
            status: 'stopped',
            pendingOperation: null,
            nextWake: null,
            leaseOwner: null,
            leaseUntil: null,
            timestamps,
          }, now);
        });
        return writeResult(nextState(state, activities, now), {
          ok: true,
          activities: clone(activities.filter((activity) => activity.actor.key === actorKey && activityIds.includes(activity.activityId))),
          aggregate: {
            transactionId,
            actorKey,
            activityIds,
            committedAt: now.toISOString(),
          },
        });
      }, input);
    },

    // The supervisor reaches this method only after checking an opaque,
    // bridge-issued owner-boundary approval. Keeping the scope/risk adoption
    // together with reactivation prevents a crash from persisting a widened
    // authority while leaving the activity paused (or vice versa).
    resumeWithApprovedBoundary(activityId, input = {}) {
      return mutate((state, now) => {
        const found = findActivity(state, activityId);
        if (!found) return noWrite(error('activity not found', 'EXTERNAL_MCP_ACTIVITY_NOT_FOUND'));
        const { activity, index } = found;
        if (activity.status !== 'paused') {
          return noWrite(error('activity is not paused', 'EXTERNAL_MCP_ACTIVITY_NOT_PAUSED'));
        }
        const stale = rejectStale(activity, input.expectedRevision);
        if (stale) return noWrite(stale);
        const actorKey = cleanId(input.actorKey);
        if (!actorKey || activity.actor.key !== actorKey) {
          return noWrite(error('activity actor does not match', 'EXTERNAL_MCP_ACTIVITY_ACTOR_MISMATCH'));
        }
        const scope = normalizeScope(input.newScope);
        const risk = normalizeRisk(input.newRisk);
        if (!scope || !risk) return noWrite(error('approved boundary data is invalid', 'EXTERNAL_MCP_ACTIVITY_BOUNDARY_INVALID'));
        const nextWake = normalizeNullableIso(input.nextWake) || now.toISOString();
        const checkpoint = normalizeCheckpoint({
          ...activity.checkpoint,
          summary: cleanText(input.summary || '', 1_000),
          terminal: false,
          updatedAt: now.toISOString(),
        }, now, false);
        if (!checkpoint) return noWrite(error('approved boundary checkpoint is invalid', 'EXTERNAL_MCP_ACTIVITY_BOUNDARY_INVALID'));
        const updated = withRevision(activity, {
          scope,
          risk,
          status: 'active',
          checkpoint,
          pendingOperation: null,
          nextWake,
          leaseOwner: null,
          leaseUntil: null,
        }, now);
        const activities = replaceAt(state.activities, index, updated);
        return writeResult(nextState(state, activities, now), { ok: true, activity: clone(updated) });
      }, input);
    },
  };
}


function commitPatch(state, activityId, input, now) {
  const found = findActivity(state, activityId);
  if (!found) return noWrite(error('activity not found', 'EXTERNAL_MCP_ACTIVITY_NOT_FOUND'));
  const { activity, index } = found;
  const patch = input.patch && typeof input.patch === 'object' ? input.patch : {};
  const terminalError = rejectTerminal(activity);
  // The Core receipt is an append-only reconciliation record.  Terminal
  // activities may update it, but cannot regain any executable field.
  if (terminalError && Object.keys(patch).some((key) => key !== 'coreJobReceipt')) return noWrite(terminalError);
  const stale = rejectStale(activity, input.expectedRevision);
  if (stale) return noWrite(stale);
  if (activity.leaseUntil && Date.parse(activity.leaseUntil) > now.getTime()
    && activity.leaseOwner !== cleanId(input.leaseOwner)) {
    return noWrite(error('activity lease owner does not match', 'EXTERNAL_MCP_ACTIVITY_LEASE_OWNER_MISMATCH'));
  }
  if (Object.keys(patch).some((key) => !MUTABLE_FIELDS.has(key))) {
    return noWrite(error('activity patch contains immutable fields', 'EXTERNAL_MCP_ACTIVITY_IMMUTABLE_FIELD'));
  }
  const normalizedPatch = normalizeMutablePatch(activity, patch, now);
  if (!normalizedPatch) return noWrite(error('activity patch is invalid', 'EXTERNAL_MCP_ACTIVITY_INVALID_PATCH'));
  const updated = withRevision(activity, normalizedPatch, now);
  const activities = replaceAt(state.activities, index, updated);
  return writeResult(nextState(state, activities, now), { ok: true, activity: clone(updated) });
}


function normalizeNewActivity(input, now) {
  const activityId = cleanId(input.activityId);
  const actor = normalizeActor(input.actor);
  const domain = cleanId(input.domain).toLowerCase();
  const driverId = cleanId(input.driverId);
  const goal = normalizeGoal(input.goal);
  const scope = normalizeScope(input.scope);
  const risk = normalizeRisk(input.risk);
  const status = cleanId(input.status || 'active').toLowerCase();
  const checkpoint = normalizeCheckpoint(input.checkpoint || {}, now, true);
  const pendingOperation = normalizePendingOperation(input.pendingOperation);
  const nextWake = normalizeNullableIso(input.nextWake);
  const notifyTarget = normalizeNotifyTarget(input.notifyTarget);
  const coreJobReceipt = normalizeCoreJobReceipt(input.coreJobReceipt);
  if (!activityId || !actor || !VALID_DOMAINS.has(domain) || !driverId || !goal || !scope || !risk
    || !VALID_STATUSES.has(status) || !checkpoint || pendingOperation === undefined
    || nextWake === undefined || notifyTarget === undefined || coreJobReceipt === undefined) return null;
  if (TERMINAL_STATUSES.has(status) && (pendingOperation !== null || nextWake !== null)) return null;
  if (status === 'completed' && checkpoint.terminal !== true) return null;
  const nowIso = now.toISOString();
  return {
    activityId,
    actor,
    domain,
    driverId,
    goal,
    scope,
    risk,
    status,
    checkpoint,
    pendingOperation,
    nextWake,
    revision: 1,
    leaseOwner: null,
    leaseUntil: null,
    notifyTarget,
    coreJobReceipt,
    timestamps: {
      createdAt: nowIso,
      updatedAt: nowIso,
      startedAt: nowIso,
      stoppedAt: status === 'stopped' ? nowIso : null,
      completedAt: status === 'completed' ? nowIso : null,
    },
  };
}


function normalizeMutablePatch(activity, patch, now) {
  const normalized = {};
  if (Object.hasOwn(patch, 'status')) {
    const status = cleanId(patch.status).toLowerCase();
    if (!VALID_STATUSES.has(status)) return null;
    normalized.status = status;
    if (status === 'stopped') normalized.timestamps = { ...activity.timestamps, stoppedAt: now.toISOString() };
    if (status === 'completed') normalized.timestamps = { ...activity.timestamps, completedAt: now.toISOString() };
    if (TERMINAL_STATUSES.has(status)) {
      normalized.pendingOperation = null;
      normalized.nextWake = null;
      normalized.leaseOwner = null;
      normalized.leaseUntil = null;
    }
  }
  if (Object.hasOwn(patch, 'checkpoint')) {
    normalized.checkpoint = normalizeCheckpoint(patch.checkpoint, now, false);
    if (!normalized.checkpoint) return null;
  }
  if (Object.hasOwn(patch, 'pendingOperation')) {
    normalized.pendingOperation = normalizePendingOperation(patch.pendingOperation);
    if (normalized.pendingOperation === undefined) return null;
  }
  if (Object.hasOwn(patch, 'nextWake')) {
    normalized.nextWake = normalizeNullableIso(patch.nextWake);
    if (normalized.nextWake === undefined) return null;
  }
  if (Object.hasOwn(patch, 'notifyTarget')) {
    normalized.notifyTarget = normalizeNotifyTarget(patch.notifyTarget);
    if (normalized.notifyTarget === undefined) return null;
  }
  if (Object.hasOwn(patch, 'coreJobReceipt')) {
    normalized.coreJobReceipt = normalizeCoreJobReceipt(patch.coreJobReceipt);
    if (normalized.coreJobReceipt === undefined) return null;
  }
  return normalized;
}


function migrateLegacyState(value, now) {
  const records = Array.isArray(value) ? value : value.activities;
  const activities = records.map((legacy) => migrateLegacyActivity(legacy, now));
  return { schemaVersion: SCHEMA_VERSION, activities, updatedAt: now.toISOString() };
}


function migrateLegacyActivity(legacy, now) {
  const sourceStatus = cleanId(legacy.status).toLowerCase();
  const status = TERMINAL_STATUSES.has(sourceStatus) ? sourceStatus : 'paused';
  const createdAt = normalizeNullableIso(legacy.createdAt) || now.toISOString();
  const updatedAt = normalizeNullableIso(legacy.updatedAt) || now.toISOString();
  const domain = legacy.kind === 'game_play' ? 'game' : legacy.kind === 'forum_read' ? 'forum' : 'other';
  const actorSource = cleanId(legacy.actorKey || legacy.globalUserId || 'legacy-actor');
  const serverId = cleanId(legacy.serverId || 'legacy-server');
  return {
    activityId: cleanId(legacy.activityId),
    actor: { key: crypto.createHash('sha256').update(actorSource).digest('hex'), kind: 'legacy' },
    domain,
    driverId: 'generic-mcp-adapter',
    goal: {
      text: 'Migrated legacy activity',
      constraints: ['requires supervisor scope and risk revalidation before resume'],
    },
    scope: {
      serverId,
      resourceId: cleanText(legacy.watchScope || '', 240),
      parameters: {},
    },
    risk: { envelopeId: 'legacy-constrained', allowedEffects: [], boundaryGrants: [] },
    status,
    checkpoint: { stateDigest: '', summary: '', terminal: status === 'completed', evidenceRefs: [], updatedAt: null },
    pendingOperation: null,
    nextWake: null,
    revision: positiveInt(legacy.revision, 1),
    leaseOwner: null,
    leaseUntil: null,
    notifyTarget: normalizeNotifyTarget(legacy.notifyTarget) || null,
    timestamps: {
      createdAt,
      updatedAt,
      startedAt: createdAt,
      stoppedAt: status === 'stopped' ? updatedAt : null,
      completedAt: status === 'completed' ? updatedAt : null,
    },
  };
}


function isActivityState(value) {
  return exactObject(value, ['schemaVersion', 'activities', 'updatedAt'])
    && value.schemaVersion === SCHEMA_VERSION
    && Array.isArray(value.activities)
    && value.activities.every(isActivity)
    && isNullableIso(value.updatedAt);
}


function isLegacyState(value) {
  if (Array.isArray(value)) return value.every(isLegacyActivity);
  return exactObject(value, ['activities']) && Array.isArray(value.activities) && value.activities.every(isLegacyActivity);
}


function isLegacyActivity(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && cleanId(value.activityId)
    && cleanId(value.status)
    && (!value.globalUserId || typeof value.globalUserId === 'string')
    && (!value.serverId || typeof value.serverId === 'string'));
}


function isActivity(value) {
  return (exactObject(value, [
    'activityId', 'actor', 'domain', 'driverId', 'goal', 'scope', 'risk', 'status', 'checkpoint',
    'pendingOperation', 'nextWake', 'revision', 'leaseOwner', 'leaseUntil', 'notifyTarget', 'timestamps',
  ]) || exactObject(value, [
    'activityId', 'actor', 'domain', 'driverId', 'goal', 'scope', 'risk', 'status', 'checkpoint',
    'pendingOperation', 'nextWake', 'revision', 'leaseOwner', 'leaseUntil', 'notifyTarget', 'coreJobReceipt', 'timestamps',
  ]))
    && Boolean(cleanId(value.activityId))
    && isActor(value.actor)
    && VALID_DOMAINS.has(value.domain)
    && Boolean(cleanId(value.driverId))
    && isGoal(value.goal)
    && isScope(value.scope)
    && isRisk(value.risk)
    && VALID_STATUSES.has(value.status)
    && isCheckpoint(value.checkpoint)
    && isPendingOperation(value.pendingOperation)
    && isNullableIso(value.nextWake)
    && Number.isInteger(value.revision) && value.revision > 0
    && ((value.leaseOwner === null && value.leaseUntil === null)
      || (Boolean(cleanId(value.leaseOwner)) && isIso(value.leaseUntil)))
    && isNotifyTarget(value.notifyTarget)
    && (!Object.hasOwn(value, 'coreJobReceipt') || isCoreJobReceipt(value.coreJobReceipt))
    && isTimestamps(value.timestamps)
    && (!TERMINAL_STATUSES.has(value.status)
      || (value.pendingOperation === null && value.nextWake === null && value.leaseOwner === null && value.leaseUntil === null))
    && (value.status !== 'completed' || value.checkpoint.terminal === true);
}


function isActor(value) {
  return exactObject(value, ['key', 'kind']) && Boolean(cleanId(value.key)) && Boolean(cleanId(value.kind));
}


function isGoal(value) {
  return exactObject(value, ['text', 'constraints'])
    && Boolean(cleanText(value.text, 2_000))
    && stringArray(value.constraints, 50, 500);
}


function isScope(value) {
  return exactObject(value, ['serverId', 'resourceId', 'parameters'])
    && Boolean(cleanId(value.serverId))
    && typeof value.resourceId === 'string'
    && isBoundedJsonObject(value.parameters);
}


function isRisk(value) {
  return exactObject(value, ['envelopeId', 'allowedEffects', 'boundaryGrants'])
    && Boolean(cleanId(value.envelopeId))
    && stringArray(value.allowedEffects, 50, 120)
    && stringArray(value.boundaryGrants, 50, 200);
}


function isCheckpoint(value) {
  return exactObject(value, ['stateDigest', 'summary', 'terminal', 'evidenceRefs', 'updatedAt'])
    && typeof value.stateDigest === 'string'
    && typeof value.summary === 'string'
    && value.summary.length <= 2_000
    && typeof value.terminal === 'boolean'
    && stringArray(value.evidenceRefs, 100, 240)
    && isNullableIso(value.updatedAt);
}


function isPendingOperation(value) {
  const legacy = exactObject(value, ['operationId', 'actionId', 'effect', 'status', 'startedAt', 'updatedAt']);
  return value === null || ((legacy || exactObject(value, ['operationId', 'actionId', 'toolName', 'effect', 'arguments', 'sessionId', 'status', 'startedAt', 'updatedAt']))
    && Boolean(cleanId(value.operationId))
    && Boolean(cleanId(value.actionId))
    && (legacy || Boolean(cleanId(value.toolName)))
    && Boolean(cleanId(value.effect))
    && (legacy || isBoundedJsonObject(value.arguments))
    && (legacy || Boolean(cleanId(value.sessionId)))
    && Boolean(cleanId(value.status))
    && isIso(value.startedAt)
    && isIso(value.updatedAt));
}


function isNotifyTarget(value) {
  return value === null || (exactObject(value, ['platform', 'channelType', 'conversationId', 'senderId'])
    && Boolean(cleanId(value.platform))
    && Boolean(cleanId(value.channelType))
    && Boolean(cleanText(value.conversationId, 240))
    && Boolean(cleanText(value.senderId, 240)));
}


function isCoreJobReceipt(value) {
  return value === null || (exactObject(value, [
    'jobId', 'actorKey', 'goalDigest', 'status', 'nextRunAt', 'terminalStates',
  ])
    && Boolean(cleanId(value.jobId))
    && Boolean(cleanId(value.actorKey))
    && /^[a-f0-9]{64}$/.test(String(value.goalDigest || ''))
    && ['active', 'completed', 'blocked', 'stopped', 'expired'].includes(value.status)
    && isIso(value.nextRunAt)
    && Array.isArray(value.terminalStates)
    && value.terminalStates.length === 4
    && value.terminalStates.every((item, index) => item === ['completed', 'blocked', 'stopped', 'expired'][index]));
}


function isTimestamps(value) {
  return exactObject(value, ['createdAt', 'updatedAt', 'startedAt', 'stoppedAt', 'completedAt'])
    && isIso(value.createdAt) && isIso(value.updatedAt) && isIso(value.startedAt)
    && isNullableIso(value.stoppedAt) && isNullableIso(value.completedAt);
}


function normalizeActor(value) {
  if (!value || typeof value !== 'object') return null;
  const actor = { key: cleanId(value.key || value.actorKey), kind: cleanId(value.kind || 'owner') };
  return isActor(actor) ? actor : null;
}


function normalizeGoal(value) {
  const goal = {
    text: cleanText(value?.text, 2_000),
    constraints: normalizeStringArray(value?.constraints, 50, 500),
  };
  return isGoal(goal) ? goal : null;
}


function normalizeScope(value) {
  const scope = {
    serverId: cleanId(value?.serverId),
    resourceId: cleanText(value?.resourceId, 240),
    parameters: boundedJsonObject(value?.parameters || {}),
  };
  return isScope(scope) ? scope : null;
}


function normalizeRisk(value) {
  const risk = {
    envelopeId: cleanId(value?.envelopeId),
    allowedEffects: normalizeStringArray(value?.allowedEffects, 50, 120),
    boundaryGrants: normalizeStringArray(value?.boundaryGrants, 50, 200),
  };
  return isRisk(risk) ? risk : null;
}


function normalizeCheckpoint(value, now, allowNullTimestamp) {
  const updatedAt = normalizeNullableIso(value?.updatedAt);
  if (updatedAt === undefined || (!allowNullTimestamp && updatedAt === null)) return null;
  const checkpoint = {
    stateDigest: cleanText(value?.stateDigest, 240),
    summary: cleanText(value?.summary, 2_000),
    terminal: value?.terminal === true,
    evidenceRefs: normalizeStringArray(value?.evidenceRefs, 100, 240),
    updatedAt: updatedAt === null && !allowNullTimestamp ? now.toISOString() : updatedAt,
  };
  return isCheckpoint(checkpoint) ? checkpoint : null;
}


function normalizePendingOperation(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== 'object') return undefined;
  const legacy = !Object.hasOwn(value, 'toolName') && !Object.hasOwn(value, 'arguments') && !Object.hasOwn(value, 'sessionId');
  const operation = {
    operationId: cleanId(value.operationId),
    actionId: cleanId(value.actionId),
    toolName: cleanId(value.toolName),
    effect: cleanId(value.effect),
    arguments: boundedJsonObject(value.arguments || {}),
    sessionId: cleanId(value.sessionId),
    status: cleanId(value.status),
    startedAt: normalizeNullableIso(value.startedAt),
    updatedAt: normalizeNullableIso(value.updatedAt),
  };
  if (legacy) {
    const legacyOperation = {
      operationId: operation.operationId, actionId: operation.actionId, effect: operation.effect,
      status: operation.status, startedAt: operation.startedAt, updatedAt: operation.updatedAt,
    };
    return isPendingOperation(legacyOperation) ? legacyOperation : undefined;
  }
  return isPendingOperation(operation) ? operation : undefined;
}


function normalizeNotifyTarget(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== 'object') return undefined;
  const target = {
    platform: cleanId(value.platform),
    channelType: cleanId(value.channelType || value.channel_type),
    conversationId: cleanText(value.conversationId || value.conversation_id, 240),
    senderId: cleanText(value.senderId || value.sender_id, 240),
  };
  return isNotifyTarget(target) ? target : undefined;
}


function normalizeCoreJobReceipt(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== 'object') return undefined;
  const receipt = {
    jobId: cleanId(value.jobId),
    actorKey: cleanId(value.actorKey),
    goalDigest: String(value.goalDigest || ''),
    status: cleanId(value.status),
    nextRunAt: normalizeNullableIso(value.nextRunAt),
    terminalStates: Array.isArray(value.terminalStates) ? [...value.terminalStates] : [],
  };
  return isCoreJobReceipt(receipt) ? receipt : undefined;
}


function withRevision(activity, patch, now) {
  const timestamps = patch.timestamps || activity.timestamps;
  return {
    ...activity,
    ...patch,
    revision: activity.revision + 1,
    timestamps: { ...timestamps, updatedAt: now.toISOString() },
  };
}


function nextState(state, activities, now) {
  return { schemaVersion: SCHEMA_VERSION, activities, updatedAt: now.toISOString() };
}


function emptyState() {
  return { schemaVersion: SCHEMA_VERSION, activities: [], updatedAt: null };
}


function findActivity(state, activityId) {
  const id = cleanId(activityId);
  const index = state.activities.findIndex((item) => item.activityId === id);
  return index < 0 ? null : { activity: state.activities[index], index };
}


function rejectStale(activity, expectedRevision) {
  if (!Number.isInteger(expectedRevision) || activity.revision !== expectedRevision) {
    return {
      ...error('activity revision is stale', 'EXTERNAL_MCP_ACTIVITY_STALE_REVISION'),
      currentRevision: activity.revision,
    };
  }
  return null;
}


function rejectTerminal(activity) {
  if (activity.status === 'stopped') return error('activity is stopped', 'EXTERNAL_MCP_ACTIVITY_STOPPED');
  if (TERMINAL_STATUSES.has(activity.status)) return error('activity is terminal', 'EXTERNAL_MCP_ACTIVITY_TERMINAL');
  return null;
}


function replaceAt(items, index, value) {
  const copy = [...items];
  copy[index] = value;
  return copy;
}


function writeResult(state, result) {
  return { ok: true, state, result };
}


function noWrite(result) {
  return { ok: false, result };
}


function error(message, code) {
  return { ok: false, error: message, error_code: code };
}


function storeException(message, code) {
  const exception = new Error(message);
  exception.code = code;
  return exception;
}


function normalizeNow(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  if (!Number.isFinite(date.getTime())) throw new TypeError('now must be a valid date');
  return date;
}


function normalizeNullableIso(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}


function isIso(value) {
  return typeof value === 'string' && normalizeNullableIso(value) === value;
}


function isNullableIso(value) {
  return value === null || isIso(value);
}


function cleanId(value) {
  return String(value || '').trim().replace(/[\r\n\t]/g, '').replace(/[^a-zA-Z0-9_.:@/-]/g, '').slice(0, 240);
}


function cleanText(value, maxChars) {
  return String(value || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, maxChars);
}


function normalizeStringArray(value, maxItems, maxChars) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, maxItems).map((item) => cleanText(item, maxChars)).filter(Boolean);
}


function stringArray(value, maxItems, maxChars) {
  return Array.isArray(value) && value.length <= maxItems
    && value.every((item) => typeof item === 'string' && item.length > 0 && item.length <= maxChars);
}


function boundedJsonObject(value) {
  try {
    const text = JSON.stringify(value);
    if (!text || Buffer.byteLength(text, 'utf8') > 16_384) return {};
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}


function isBoundedJsonObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8') <= 16_384;
  } catch {
    return false;
  }
}


function exactObject(value, keys) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key)));
}


function isEqualOrNarrowerScope(current, candidate) {
  return current.serverId === candidate.serverId
    && current.resourceId === candidate.resourceId
    && isEqualOrNarrowerValue(current.parameters, candidate.parameters);
}


function isEqualOrNarrowerValue(current, candidate) {
  if (Array.isArray(current) || Array.isArray(candidate)) {
    if (!Array.isArray(current) || !Array.isArray(candidate) || candidate.length > current.length) return false;
    return candidate.every((item) => current.some((existing) => deepEqual(existing, item)));
  }
  if (current && candidate && typeof current === 'object' && typeof candidate === 'object') {
    const currentKeys = Object.keys(current).sort();
    const candidateKeys = Object.keys(candidate).sort();
    return deepEqual(currentKeys, candidateKeys)
      && currentKeys.every((key) => isEqualOrNarrowerValue(current[key], candidate[key]));
  }
  return Object.is(current, candidate);
}


function deepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}


function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}


function clone(value) {
  return JSON.parse(JSON.stringify(value));
}


function assertNoUnrecoveredQuarantine(target) {
  if (fs.existsSync(target)) return;
  let entries;
  try {
    entries = fs.readdirSync(path.dirname(target));
  } catch (cause) {
    if (cause?.code === 'ENOENT') return;
    throw cause;
  }
  if (!entries.some((entry) => entry.startsWith(`${path.basename(target)}.corrupt-`))) return;
  const stateError = new Error('critical activity state is quarantined and requires recovery');
  stateError.code = 'RAN_AGENT_STATE_CORRUPT';
  throw stateError;
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
  } catch (cause) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
      try { fs.rmSync(lockPath, { force: true }); } catch {}
    }
    if (cause?.code === 'EEXIST') return null;
    throw cause;
  }
}


function releaseMutationLock(lock) {
  try { fs.closeSync(lock.descriptor); } finally { fs.rmSync(lock.lockPath, { force: true }); }
}
