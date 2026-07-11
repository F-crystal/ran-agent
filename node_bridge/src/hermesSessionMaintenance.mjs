import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readJsonState, writeJsonAtomic } from './atomicState.mjs';
import { resolveStateDir } from './runtimeState.mjs';
import { readTimelineRecords, sanitizeTimelineText } from './globalTimeline.mjs';

const DEFAULT_STATE_FILE = 'hermes/session_maintenance.json';
const DEFAULT_DIGEST_DIR = 'hermes/digests';
const DEFAULT_MAX_DIGEST_CHARS = 1200;
const DEFAULT_KEEP_LAST_N = 4;
const DIGEST_ARRAY_KEYS = [
  'open_threads',
  'pending_commitments',
  'active_preferences',
  'recent_artifacts',
  'do_not_carry',
];

export function getHermesLiteSoftResetConfig(env = process.env) {
  const stateDir = resolveStateDir(env);
  return {
    enabled: String(env.HERMES_LITE_SOFT_RESET_ENABLED || 'false').trim().toLowerCase() === 'true',
    dryRun: String(env.HERMES_LITE_SOFT_RESET_DRY_RUN || 'true').trim().toLowerCase() !== 'false',
    maxDigestChars: normalizePositiveInt(env.HERMES_LITE_SOFT_RESET_MAX_DIGEST_CHARS, DEFAULT_MAX_DIGEST_CHARS),
    keepLastN: normalizePositiveInt(env.HERMES_LITE_SOFT_RESET_KEEP_LAST_N, DEFAULT_KEEP_LAST_N),
    stateFile: resolveStatePath(env.HERMES_LITE_SOFT_RESET_STATE_FILE, DEFAULT_STATE_FILE, stateDir),
    digestDir: resolveStatePath(env.HERMES_LITE_SOFT_RESET_DIGEST_DIR, DEFAULT_DIGEST_DIR, stateDir),
    timelinePath: String(env.RAN_AGENT_GLOBAL_TIMELINE_PATH || '').trim(),
  };
}

export function runHermesLiteSoftReset({
  action = 'status',
  expectedRevision,
  env = process.env,
  timelineRecords,
  now = new Date(),
  reason = 'manual',
} = {}) {
  const config = getHermesLiteSoftResetConfig(env);
  const normalizedAction = String(action || 'status').trim().toLowerCase();
  const state = readHermesLiteMaintenanceState(config);
  if (!config.enabled) {
    return { ok: true, skipped: true, reason: 'disabled', action: normalizedAction, revision: state.revision };
  }
  if (normalizedAction === 'status') {
    return buildStatusResult(config, state);
  }
  if (normalizedAction === 'rollback-last') {
    const conflict = compareRevision(state.revision, expectedRevision);
    if (conflict) return conflict;
    return rollbackLastLiteSession({ config, state, now });
  }
  if (normalizedAction !== 'apply' && normalizedAction !== 'dry-run') {
    return { ok: false, error: 'unknown_action', action: normalizedAction };
  }

  const conflict = compareRevision(state.revision, expectedRevision);
  if (conflict) return conflict;
  const records = Array.isArray(timelineRecords)
    ? timelineRecords
    : readTimelineRecords({ timelinePath: config.timelinePath, limit: Math.max(1, config.keepLastN * 4) });
  const digest = buildHermesLiteContinuityDigest({
    records,
    maxChars: config.maxDigestChars,
    keepLastN: config.keepLastN,
    now,
    sourceSessionNonce: state.currentSessionNonce || 'default-lite-session',
  });
  const newSessionNonce = buildSessionNonce({ now, oldSessionNonce: state.currentSessionNonce, digestId: digest.digestId, reason });
  const oldSessionIdHash = hashShort(state.currentSessionNonce || 'default-lite-session');
  const newSessionIdHash = hashShort(newSessionNonce);
  const dryRun = normalizedAction === 'dry-run' || config.dryRun;

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      wouldRotate: true,
      digest,
      oldSessionIdHash,
      newSessionIdHash,
    };
  }

  const resetAt = toIso(now);
  fs.mkdirSync(config.digestDir, { recursive: true });
  writeJsonFile(path.join(config.digestDir, `${digest.digestId}.json`), digest);
  const nextState = {
    version: 1,
    revision: state.revision + 1,
    profile: 'lite',
    currentSessionNonce: newSessionNonce,
    previousSessionNonce: state.currentSessionNonce || '',
    pendingDigestId: digest.digestId,
    lastReset: {
      resetAt,
      oldSessionIdHash,
      newSessionIdHash,
      digestId: digest.digestId,
      reason: String(reason || 'manual').trim() || 'manual',
    },
    digests: [
      {
        digestId: digest.digestId,
        path: path.join(config.digestDir, `${digest.digestId}.json`),
        createdAt: resetAt,
        consumed: false,
        consumedAt: '',
      },
      ...normalizeDigestMetadata(state.digests).slice(0, 19),
    ],
    rollbackStack: [
      {
        fromSessionNonce: newSessionNonce,
        toSessionNonce: state.currentSessionNonce || '',
        digestId: digest.digestId,
        createdAt: resetAt,
      },
      ...normalizeRollbackStack(state.rollbackStack).slice(0, 9),
    ],
  };
  writeJsonFile(config.stateFile, nextState, { validate: isMaintenanceState });
  return {
    ok: true,
    applied: true,
    digest,
    oldSessionIdHash,
    newSessionIdHash,
    newSessionNonce,
    resetAt,
    revision: nextState.revision,
  };
}

export function buildHermesLiteContinuityDigest({
  records = [],
  maxChars = DEFAULT_MAX_DIGEST_CHARS,
  keepLastN = DEFAULT_KEEP_LAST_N,
  now = new Date(),
  sourceSessionNonce = 'default-lite-session',
} = {}) {
  const date = toIso(now).slice(0, 10);
  const selected = Array.isArray(records)
    ? records.slice(-Math.max(1, Number(keepLastN) || DEFAULT_KEEP_LAST_N) * 2)
    : [];
  const digest = {
    date,
    profile: 'lite',
    sourceSessionIdHash: hashShort(sourceSessionNonce || 'default-lite-session'),
    digestId: '',
    open_threads: [],
    pending_commitments: [],
    active_preferences: [],
    recent_artifacts: [],
    do_not_carry: [],
  };
  for (const record of selected) {
    const text = sanitizeDigestLine(record?.text_summary || record?.media_summary || record?.text || '');
    if (!text) continue;
    addDigestLine(digest, classifyDigestLine(text), text);
  }
  digest.digestId = hashShort(`${date}:${digest.sourceSessionIdHash}:${JSON.stringify(DIGEST_ARRAY_KEYS.map((key) => digest[key]))}`);
  return boundDigest(digest, maxChars);
}

export function readHermesLiteMaintenanceState(configOrEnv = process.env) {
  const config = configOrEnv.stateFile ? configOrEnv : getHermesLiteSoftResetConfig(configOrEnv);
  const payload = readJsonFile(config.stateFile, {}, {
    critical: true,
    validate: isMaintenanceState,
  });
  return {
    version: Number(payload.version) || 1,
    revision: normalizeRevision(payload.revision),
    profile: payload.profile === 'lite' ? 'lite' : 'lite',
    currentSessionNonce: String(payload.currentSessionNonce || ''),
    previousSessionNonce: String(payload.previousSessionNonce || ''),
    pendingDigestId: String(payload.pendingDigestId || ''),
    lastReset: payload.lastReset && typeof payload.lastReset === 'object' ? payload.lastReset : {},
    digests: normalizeDigestMetadata(payload.digests),
    rollbackStack: normalizeRollbackStack(payload.rollbackStack),
  };
}

export function getLiteSessionNonce(config = {}) {
  if (config.softResetEnabled !== true) return '';
  return readHermesLiteMaintenanceState({
    stateFile: config.softResetStateFile,
    digestDir: config.softResetDigestDir,
  }).currentSessionNonce;
}

export function getPendingLiteResumeDigest(config = {}) {
  if (config.softResetEnabled !== true) return null;
  const state = readHermesLiteMaintenanceState({
    stateFile: config.softResetStateFile,
    digestDir: config.softResetDigestDir,
  });
  const pendingDigestId = String(state.pendingDigestId || '').trim();
  if (!pendingDigestId) return null;
  const meta = state.digests.find((item) => item.digestId === pendingDigestId);
  if (meta?.consumed === true) return null;
  const digestPath = meta?.path || path.join(config.softResetDigestDir, `${pendingDigestId}.json`);
  const digest = readJsonFile(digestPath, null);
  if (!digest || typeof digest !== 'object') return null;
  return {
    digestId: pendingDigestId,
    digest,
    text: buildDigestPromptText(digest, config.softResetMaxDigestChars || DEFAULT_MAX_DIGEST_CHARS),
  };
}

export function markLiteResumeDigestConsumed(config = {}, digestId = '', now = new Date()) {
  if (config.softResetEnabled !== true || !digestId) return false;
  const stateConfig = {
    stateFile: config.softResetStateFile,
    digestDir: config.softResetDigestDir,
  };
  const state = readHermesLiteMaintenanceState(stateConfig);
  let changed = false;
  const digests = state.digests.map((item) => {
    if (item.digestId !== digestId) return item;
    changed = true;
    return { ...item, consumed: true, consumedAt: toIso(now) };
  });
  if (!changed) return false;
  writeJsonFile(stateConfig.stateFile, {
    ...state,
    revision: state.revision + 1,
    pendingDigestId: state.pendingDigestId === digestId ? '' : state.pendingDigestId,
    digests,
  }, { validate: isMaintenanceState });
  return true;
}

export function buildDigestPromptText(digest = {}, maxChars = DEFAULT_MAX_DIGEST_CHARS) {
  const safeDigest = {};
  for (const key of ['date', 'profile', 'sourceSessionIdHash', 'digestId', ...DIGEST_ARRAY_KEYS]) {
    safeDigest[key] = Array.isArray(digest[key])
      ? digest[key].map((item) => sanitizeDigestLine(item)).filter(Boolean).slice(0, 5)
      : String(digest[key] || '');
  }
  return clipText(`daily_digest: ${JSON.stringify(safeDigest)}`, maxChars);
}

function rollbackLastLiteSession({ config, state = readHermesLiteMaintenanceState(config), now = new Date() } = {}) {
  const [last, ...rest] = state.rollbackStack;
  if (!last) {
    return { ok: true, rolledBack: false, reason: 'no_rollback_entry' };
  }
  if (config.dryRun) {
    return {
      ok: true,
      dryRun: true,
      wouldRollback: true,
      currentSessionIdHash: hashShort(state.currentSessionNonce || 'default-lite-session'),
      restoredSessionIdHash: hashShort(last.toSessionNonce || 'default-lite-session'),
    };
  }
  const nextState = {
    ...state,
    revision: state.revision + 1,
    currentSessionNonce: String(last.toSessionNonce || ''),
    previousSessionNonce: '',
    rollbackStack: rest,
    lastRollback: {
      rolledBackAt: toIso(now),
      fromSessionIdHash: hashShort(state.currentSessionNonce || 'default-lite-session'),
      restoredSessionIdHash: hashShort(last.toSessionNonce || 'default-lite-session'),
      digestId: String(last.digestId || ''),
    },
  };
  writeJsonFile(config.stateFile, nextState, { validate: isMaintenanceState });
  return {
    ok: true,
    rolledBack: true,
    restoredSessionIdHash: nextState.lastRollback.restoredSessionIdHash,
    revision: nextState.revision,
  };
}

function buildStatusResult(config = {}, state = readHermesLiteMaintenanceState(config)) {
  return {
    ok: true,
    enabled: true,
    dryRun: config.dryRun,
    revision: state.revision,
    currentSessionIdHash: hashShort(state.currentSessionNonce || 'default-lite-session'),
    pendingDigestId: state.pendingDigestId || '',
    pendingDigestConsumed: state.pendingDigestId
      ? state.digests.find((item) => item.digestId === state.pendingDigestId)?.consumed === true
      : false,
    lastReset: sanitizeStatusObject(state.lastReset),
  };
}

function classifyDigestLine(text) {
  if (/已结束|不用继续|不要继续|别再|closed|done/i.test(text)) return 'do_not_carry';
  if (/偏好|不要|别|保持|默认|喜欢|称|风格|省\s*token|slim|rich|resume/i.test(text)) return 'active_preferences';
  if (/artifact|node_bridge\/|docs\/|scripts\/|\.mjs|\.md|commit|PR|部署|文档/i.test(text)) return 'recent_artifacts';
  if (/pending|todo|承诺|我会|臣会|稍后|明天|继续观察|follow/i.test(text)) return 'pending_commitments';
  if (/继续|排查|未完成|下一步|review|rollback|测试|修复|上线|观察/i.test(text)) return 'open_threads';
  return 'open_threads';
}

function addDigestLine(digest, key, text) {
  const listKey = DIGEST_ARRAY_KEYS.includes(key) ? key : 'open_threads';
  const list = digest[listKey];
  if (list.length >= 5 || list.includes(text)) return;
  list.push(text);
}

function boundDigest(digest, maxChars) {
  const limit = Math.max(200, Number(maxChars) || DEFAULT_MAX_DIGEST_CHARS);
  const bounded = {
    ...digest,
    open_threads: [...digest.open_threads],
    pending_commitments: [...digest.pending_commitments],
    active_preferences: [...digest.active_preferences],
    recent_artifacts: [...digest.recent_artifacts],
    do_not_carry: [...digest.do_not_carry],
  };
  for (const key of DIGEST_ARRAY_KEYS) {
    bounded[key] = bounded[key].slice(0, 5).map((item) => clipText(item, 140));
  }
  while (JSON.stringify(bounded).length > limit) {
    const key = DIGEST_ARRAY_KEYS.find((candidate) => bounded[candidate].length > 0);
    if (!key) break;
    bounded[key].pop();
  }
  return bounded;
}

function sanitizeDigestLine(value) {
  const text = sanitizeTimelineText(value, 180)
    .replace(/\b(token|cookie|authorization|xsec_token|api_key)=([^\s&]+)/ig, '$1=[redacted]')
    .replace(/\/(?:opt|Users|private|var|tmp)\/[^\s]+/g, '[path]');
  return clipText(text, 180);
}

function normalizeDigestMetadata(value) {
  return Array.isArray(value)
    ? value.map((item) => ({
        digestId: String(item?.digestId || ''),
        path: String(item?.path || ''),
        createdAt: String(item?.createdAt || ''),
        consumed: item?.consumed === true,
        consumedAt: String(item?.consumedAt || ''),
      })).filter((item) => item.digestId)
    : [];
}

function normalizeRollbackStack(value) {
  return Array.isArray(value)
    ? value.map((item) => ({
        fromSessionNonce: String(item?.fromSessionNonce || ''),
        toSessionNonce: String(item?.toSessionNonce || ''),
        digestId: String(item?.digestId || ''),
        createdAt: String(item?.createdAt || ''),
      })).filter((item) => item.fromSessionNonce || item.toSessionNonce)
    : [];
}

function resolveStatePath(rawValue, fallback, stateDir) {
  const raw = String(rawValue || fallback).trim();
  const relative = raw.replace(/^\.ran_agent_state[\\/]/, '');
  const target = path.isAbsolute(relative) ? relative : path.join(stateDir, relative);
  const normalizedStateDir = path.resolve(stateDir);
  const normalizedTarget = path.resolve(target);
  const prefix = normalizedStateDir.endsWith(path.sep) ? normalizedStateDir : `${normalizedStateDir}${path.sep}`;
  if (normalizedTarget !== normalizedStateDir && !normalizedTarget.startsWith(prefix)) {
    throw new Error('Hermes lite soft reset paths must stay inside runtime state dir');
  }
  return normalizedTarget;
}

function readJsonFile(filePath, fallbackValue, options = {}) {
  if (!filePath) return fallbackValue;
  return readJsonState(filePath, {
    missingValue: fallbackValue,
    critical: options.critical === true,
    validate: options.validate || isJsonObject,
  });
}

function writeJsonFile(filePath, payload, options = {}) {
  writeJsonAtomic(filePath, payload, { validate: options.validate || isJsonObject });
}

function isJsonObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isMaintenanceState(value) {
  return isJsonObject(value)
    && Number(value.version) === 1
    && (value.revision === undefined || (Number.isInteger(value.revision) && value.revision >= 0))
    && String(value.profile || '') === 'lite'
    && Array.isArray(value.digests || [])
    && Array.isArray(value.rollbackStack || []);
}

function compareRevision(currentRevision, expectedRevision) {
  if (expectedRevision === undefined || expectedRevision === null || expectedRevision === '') return null;
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    return { ok: false, error: 'invalid_revision', currentRevision };
  }
  if (expectedRevision !== currentRevision) {
    return { ok: false, error: 'stale_revision', expectedRevision, currentRevision };
  }
  return null;
}

function normalizeRevision(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function buildSessionNonce({ now, oldSessionNonce = '', digestId = '', reason = '' } = {}) {
  return `lite-${toIso(now).slice(0, 10).replace(/-/g, '')}-${hashShort(`${oldSessionNonce}:${digestId}:${reason}:${toIso(now)}`)}`;
}

function sanitizeStatusObject(value) {
  if (!value || typeof value !== 'object') return {};
  return {
    resetAt: String(value.resetAt || ''),
    oldSessionIdHash: String(value.oldSessionIdHash || ''),
    newSessionIdHash: String(value.newSessionIdHash || ''),
    digestId: String(value.digestId || ''),
    reason: String(value.reason || ''),
  };
}

function normalizePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function hashShort(value) {
  return createHash('sha256').update(String(value || '')).digest('hex').slice(0, 16);
}

function toIso(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function clipText(text, maxChars) {
  const limit = Math.max(1, Number(maxChars) || 1);
  const value = String(text || '');
  if (value.length <= limit) return value;
  return limit === 1 ? '…' : `${value.slice(0, limit - 1)}…`;
}
