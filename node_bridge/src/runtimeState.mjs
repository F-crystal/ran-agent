import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_STATE_DIR = path.join(PROJECT_ROOT, '.ran_agent_state');
const RUNTIME_DIR_NAME = 'node-bridge-runtime';
const CHECKIN_RANGE_FILE = 'checkin-range.json';
const PROACTIVE_DISPATCH_FILE = 'proactive-dispatch.json';
const PENDING_OUTBOUND_FILE = 'pending-outbound.json';
const FEISHU_HOME_DM_TARGET_FILE = 'feishu-home-dm-target.json';
const MAX_PENDING_OUTBOUND_MESSAGES = 50;

function assertWithinProject(absolutePath) {
  const normalizedProject = path.resolve(PROJECT_ROOT);
  const normalizedTarget = path.resolve(absolutePath);
  if (normalizedTarget === normalizedProject) {
    return;
  }
  const projectPrefix = normalizedProject.endsWith(path.sep)
    ? normalizedProject
    : `${normalizedProject}${path.sep}`;
  if (!normalizedTarget.startsWith(projectPrefix)) {
    throw new Error(
      `RAN_AGENT_STATE_DIR must stay inside project workspace: ${normalizedProject}`
    );
  }
}

function isWithin(rootPath, targetPath) {
  return targetPath === rootPath || targetPath.startsWith(`${rootPath}${path.sep}`);
}

function assertTestStateDir(absolutePath, env) {
  if (String(env.RAN_AGENT_ALLOW_TEST_STATE_DIR || '') !== '1') {
    throw new Error('external test state requires the explicit test state guard');
  }
  let canonicalTarget;
  let canonicalTmp;
  try {
    canonicalTarget = fs.realpathSync(absolutePath);
    canonicalTmp = fs.realpathSync(os.tmpdir());
  } catch {
    throw new Error('external test state must already exist under the OS temporary directory');
  }
  if (!isWithin(canonicalTmp, canonicalTarget)) {
    throw new Error(`external test state must stay inside the OS temporary directory: ${canonicalTmp}`);
  }
  return canonicalTarget;
}

export function resolveStateDir(env = process.env) {
  const rawStateDir = (env.RAN_AGENT_STATE_DIR || env.CLAWDBOT_STATE_DIR || DEFAULT_STATE_DIR).trim();
  const resolvedStateDir = path.isAbsolute(rawStateDir)
    ? path.resolve(rawStateDir)
    : path.resolve(PROJECT_ROOT, rawStateDir);
  if (String(env.NODE_ENV || '') === 'test') {
    return assertTestStateDir(resolvedStateDir, env);
  }
  assertWithinProject(resolvedStateDir);
  return resolvedStateDir;
}

function resolveRuntimeDir(env = process.env) {
  const dir = path.join(resolveStateDir(env), RUNTIME_DIR_NAME);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function resolveRuntimePath(filename, env = process.env) {
  return path.join(resolveRuntimeDir(env), filename);
}

function readJsonFile(filePath, fallbackValue) {
  if (!fs.existsSync(filePath)) {
    return fallbackValue;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return fallbackValue;
  }
}

function writeJsonFile(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8');
}

function normalizePositiveInt(raw, fallbackValue) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    return fallbackValue;
  }
  return Math.floor(value);
}

function normalizeIsoTimestamp(raw) {
  const text = String(raw || '').trim();
  if (!text) {
    return '';
  }
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) {
    return '';
  }
  return new Date(parsed).toISOString();
}

export function getCheckinRange(env = process.env) {
  const filePath = resolveRuntimePath(CHECKIN_RANGE_FILE, env);
  const payload = readJsonFile(filePath, {});
  const minMinutes = Math.max(20, normalizePositiveInt(payload.minMinutes, 20));
  const maxMinutes = Math.max(20, normalizePositiveInt(payload.maxMinutes, 90));
  const enabled = payload.enabled !== false;
  if (maxMinutes < minMinutes) {
    return { minMinutes: maxMinutes, maxMinutes: minMinutes, enabled };
  }
  return { minMinutes, maxMinutes, enabled };
}

export function setCheckinRange({ minMinutes, maxMinutes, enabled = true }, env = process.env) {
  const normalizedMin = Math.max(20, normalizePositiveInt(minMinutes, 20));
  const normalizedMax = Math.max(20, normalizePositiveInt(maxMinutes, 90));
  const finalMin = Math.min(normalizedMin, normalizedMax);
  const finalMax = Math.max(normalizedMin, normalizedMax);
  const payload = {
    minMinutes: finalMin,
    maxMinutes: finalMax,
    enabled: enabled !== false,
    updatedAt: new Date().toISOString(),
  };
  writeJsonFile(resolveRuntimePath(CHECKIN_RANGE_FILE, env), payload);
  return payload;
}

export function getProactiveDispatchState(env = process.env) {
  const payload = readJsonFile(resolveRuntimePath(PROACTIVE_DISPATCH_FILE, env), {});
  return {
    nextAllowedAt: typeof payload.nextAllowedAt === 'string' ? payload.nextAllowedAt : '',
    updatedAt: typeof payload.updatedAt === 'string' ? payload.updatedAt : '',
  };
}

export function setProactiveDispatchState({ nextAllowedAt }, env = process.env) {
  const payload = {
    nextAllowedAt: String(nextAllowedAt || '').trim(),
    updatedAt: new Date().toISOString(),
  };
  writeJsonFile(resolveRuntimePath(PROACTIVE_DISPATCH_FILE, env), payload);
  return payload;
}

export function appendPendingOutboundMessage({ text, reason = '', nextAttemptAt = '' }, env = process.env) {
  const filePath = resolveRuntimePath(PENDING_OUTBOUND_FILE, env);
  const payload = readJsonFile(filePath, { messages: [] });
  const existing = Array.isArray(payload.messages) ? payload.messages : [];
  const normalizedText = String(text || '').trim().replace(/\s+/g, ' ');
  if (!normalizedText) {
    return;
  }
  const normalizedReason = String(reason || '').trim();
  const normalizedNextAttemptAt = normalizeIsoTimestamp(nextAttemptAt);
  const nowIso = new Date().toISOString();
  const nextMessages = [...existing];
  const last = nextMessages.length > 0 ? nextMessages[nextMessages.length - 1] : null;
  if (last && String(last.text || '').trim() === normalizedText) {
    const currentRepeat = Number(last.repeatCount);
    last.repeatCount = Number.isFinite(currentRepeat) && currentRepeat > 0
      ? Math.floor(currentRepeat) + 1
      : 2;
    last.updatedAt = nowIso;
    if (normalizedReason && !String(last.reason || '').trim()) {
      last.reason = normalizedReason;
    }
    if (normalizedNextAttemptAt) {
      const lastNextAttemptAt = normalizeIsoTimestamp(last.nextAttemptAt);
      if (!lastNextAttemptAt || Date.parse(normalizedNextAttemptAt) > Date.parse(lastNextAttemptAt)) {
        last.nextAttemptAt = normalizedNextAttemptAt;
      }
    }
  } else {
    nextMessages.push({
      text: normalizedText,
      reason: normalizedReason,
      createdAt: nowIso,
      repeatCount: 1,
      nextAttemptAt: normalizedNextAttemptAt,
    });
  }
  const boundedMessages = nextMessages.slice(-MAX_PENDING_OUTBOUND_MESSAGES);
  writeJsonFile(filePath, { messages: boundedMessages, updatedAt: nowIso });
}

export function drainPendingOutboundMessages(limit = 10, env = process.env, now = Date.now()) {
  const normalizedLimit = normalizePositiveInt(limit, 10);
  const filePath = resolveRuntimePath(PENDING_OUTBOUND_FILE, env);
  const payload = readJsonFile(filePath, { messages: [] });
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const drained = [];
  const remaining = [];
  for (const message of messages) {
    if (drained.length >= normalizedLimit) {
      remaining.push(message);
      continue;
    }
    const nextAttemptAt = normalizeIsoTimestamp(message?.nextAttemptAt || message?.createdAt);
    if (nextAttemptAt && Date.parse(nextAttemptAt) > now) {
      remaining.push(message);
      continue;
    }
    drained.push(message);
  }
  writeJsonFile(filePath, { messages: remaining, updatedAt: new Date().toISOString() });
  return drained;
}

export function setFeishuHomeDmTarget(target = {}, env = process.env) {
  const normalized = normalizeFeishuHomeDmTarget(target);
  if (!normalized) {
    return null;
  }
  writeJsonFile(resolveRuntimePath(FEISHU_HOME_DM_TARGET_FILE, env), {
    ...normalized,
    updatedAt: new Date().toISOString(),
  });
  return normalized;
}

export function getFeishuHomeDmTarget(env = process.env) {
  const payload = readJsonFile(resolveRuntimePath(FEISHU_HOME_DM_TARGET_FILE, env), {});
  return normalizeFeishuHomeDmTarget(payload);
}

function normalizeFeishuHomeDmTarget(target = {}) {
  const platform = String(target.platform || 'feishu').trim().toLowerCase();
  const channelType = String(target.channel_type || target.channelType || 'dm').trim().toLowerCase();
  const conversationId = String(target.conversation_id || target.conversationId || '').trim();
  const senderId = String(target.sender_id || target.senderId || target.open_id || target.user_id || '').trim();
  if (platform !== 'feishu' || channelType !== 'dm' || !conversationId || !senderId) {
    return null;
  }
  return {
    platform: 'feishu',
    channel_type: 'dm',
    conversation_id: conversationId,
    sender_id: senderId,
  };
}
