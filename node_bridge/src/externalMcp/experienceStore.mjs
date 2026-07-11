import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { appendJsonLine, quarantineCorruptState, writeFileAtomic, writeJsonAtomic } from '../atomicState.mjs';
import { resolveStateDir } from '../runtimeState.mjs';

const SCHEMA_VERSION = 1;
const RECORD_KEYS = [
  'domain', 'driverId', 'driverVersion', 'goalClass', 'scopeClass',
  'observationDigest', 'actionId', 'outcome', 'effectDigest', 'evidenceDigests', 'createdAt',
];
const DOMAINS = new Set(['game', 'forum', 'browser', 'api', 'embodied', 'other']);
const OUTCOMES = new Set(['progress', 'no_progress', 'failed', 'blocked', 'completed']);

export function appendExternalMcpExperience(input = {}, options = {}) {
  const normalized = normalizeExperience(input);
  if (!normalized.ok) return normalized;
  const env = options.env || process.env;
  const paths = experiencePaths(env);
  const lock = acquireMutationLock(paths.log);
  if (!lock) throw storeError('external MCP experience store is busy', 'EXTERNAL_MCP_EXPERIENCE_STORE_BUSY');
  try {
    assertNoUnrecoveredQuarantine(paths.log);
    const existing = readExperienceLog(paths.log);
    if (existing.incompleteTail) writeFileAtomic(paths.log, existing.validText);
    const contradiction = findContradiction(existing.records, normalized.record);
    if (contradiction?.duplicate) return { accepted: true, duplicate: true, record: contradiction.record };
    if (contradiction) return { accepted: false, reason: 'contradictory_experience' };
    appendJsonLine(paths.log, normalized.record, { validate: isExternalMcpExperience });
    writeJsonAtomic(paths.index, makeIndex([...existing.records, normalized.record]), { validate: isExperienceIndex });
    return { accepted: true, duplicate: false, record: normalized.record };
  } finally {
    releaseMutationLock(lock);
  }
}

export function listExternalMcpExperiences(options = {}) {
  const paths = experiencePaths(options.env || process.env);
  assertNoUnrecoveredQuarantine(paths.log);
  return readExperienceLog(paths.log).records;
}

export function getProvenExternalMcpExperiences(query = {}, options = {}) {
  return rankExternalMcpExperiences(listExternalMcpExperiences(options), query);
}

export function rankExternalMcpExperiences(records, query = {}) {
  const filter = normalizeQuery(query);
  if (!filter) return [];
  const legalActions = legalActionIds(query.legalActions || query.legal_actions);
  if (legalActions.size === 0) return [];
  const groups = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    if (!isExternalMcpExperience(record)
      || record.domain !== filter.domain
      || record.driverId !== filter.driverId
      || record.driverVersion !== filter.driverVersion
      || record.goalClass !== filter.goalClass
      || record.scopeClass !== filter.scopeClass
      || record.observationDigest !== filter.observationDigest
      || !legalActions.has(record.actionId)) continue;
    const group = groups.get(record.actionId) || { progress: 0, failed: 0, latest: record };
    if (record.outcome === 'progress' || record.outcome === 'completed') group.progress += 1;
    else group.failed += 1;
    if (Date.parse(record.createdAt) > Date.parse(group.latest.createdAt)) group.latest = record;
    groups.set(record.actionId, group);
  }
  const maxResults = boundedPositiveInt(query.maxResults || query.max_results, 8, 8);
  return Object.freeze([...groups.entries()]
    .filter(([, group]) => group.progress > group.failed)
    .map(([actionId, group]) => Object.freeze({
      proven: true,
      actionId,
      outcome: group.latest.outcome,
      score: group.progress - group.failed,
    }))
    .sort((left, right) => right.score - left.score || left.actionId.localeCompare(right.actionId))
    .slice(0, maxResults));
}

export function isExternalMcpExperience(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const expected = ['actionId', 'createdAt', 'domain', 'driverId', 'driverVersion', 'effectDigest', 'evidenceDigests', 'experienceId', 'goalClass', 'observationDigest', 'outcome', 'scopeClass'].sort();
  if (keys.length !== expected.length || !keys.every((key, index) => key === expected[index])) return false;
  return /^exp_[a-f0-9]{16}$/.test(value.experienceId)
    && DOMAINS.has(value.domain)
    && safeIdentifier(value.driverId, 120)
    && digest(value.driverVersion)
    && safeIdentifier(value.goalClass, 120)
    && safeIdentifier(value.scopeClass, 180)
    && digest(value.observationDigest)
    && safeIdentifier(value.actionId, 160)
    && OUTCOMES.has(value.outcome)
    && digest(value.effectDigest)
    && Array.isArray(value.evidenceDigests) && value.evidenceDigests.length > 0 && value.evidenceDigests.length <= 20
    && value.evidenceDigests.every(digest)
    && Number.isFinite(Date.parse(value.createdAt));
}

function normalizeExperience(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { accepted: false, reason: 'invalid_experience' };
  if (Object.keys(input).some((key) => !RECORD_KEYS.includes(key))) return { accepted: false, reason: 'private_or_unknown_field' };
  const record = {
    domain: String(input.domain || '').trim().toLowerCase(),
    driverId: String(input.driverId || '').trim(),
    driverVersion: String(input.driverVersion || '').trim().toLowerCase(),
    goalClass: String(input.goalClass || '').trim(),
    scopeClass: String(input.scopeClass || '').trim(),
    observationDigest: String(input.observationDigest || '').trim().toLowerCase(),
    actionId: String(input.actionId || '').trim(),
    outcome: String(input.outcome || '').trim().toLowerCase(),
    effectDigest: String(input.effectDigest || '').trim().toLowerCase(),
    evidenceDigests: uniqueStrings(input.evidenceDigests).map((item) => item.toLowerCase()),
    createdAt: normalizeTimestamp(input.createdAt),
  };
  if (record.evidenceDigests.length === 0) return { accepted: false, reason: 'evidence_required' };
  if (!DOMAINS.has(record.domain)
    || !safeIdentifier(record.driverId, 120)
    || !digest(record.driverVersion)
    || !safeIdentifier(record.goalClass, 120)
    || !safeIdentifier(record.scopeClass, 180)
    || !digest(record.observationDigest)
    || !safeIdentifier(record.actionId, 160)
    || !OUTCOMES.has(record.outcome)
    || !digest(record.effectDigest)
    || record.evidenceDigests.length > 20
    || !record.evidenceDigests.every(digest)
    || !record.createdAt) return { accepted: false, reason: 'invalid_experience' };
  record.experienceId = `exp_${shortHash(JSON.stringify(record))}`;
  return { ok: true, record: Object.freeze(record) };
}

function findContradiction(records, candidate) {
  const key = observationActionKey(candidate);
  for (const record of records) {
    if (observationActionKey(record) !== key) continue;
    if (record.outcome !== candidate.outcome || record.effectDigest !== candidate.effectDigest) return { duplicate: false };
    if (sameEvidence(record.evidenceDigests, candidate.evidenceDigests)) return { duplicate: true, record };
  }
  return null;
}

function makeIndex(records) {
  const activeByStrategy = {};
  for (const record of records) {
    const key = shortHash([record.domain, record.driverId, record.driverVersion, record.goalClass, record.scopeClass, record.actionId].join('|'));
    const active = activeByStrategy[key];
    if (!active || Date.parse(record.createdAt) >= Date.parse(active.createdAt)) activeByStrategy[key] = record;
  }
  return { schemaVersion: SCHEMA_VERSION, updatedAt: new Date().toISOString(), activeByStrategy };
}

function isExperienceIndex(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && value.schemaVersion === SCHEMA_VERSION
    && Number.isFinite(Date.parse(value.updatedAt))
    && value.activeByStrategy && typeof value.activeByStrategy === 'object' && !Array.isArray(value.activeByStrategy)
    && Object.entries(value.activeByStrategy).every(([key, record]) => /^[a-f0-9]{16}$/.test(key) && isExternalMcpExperience(record));
}

function experiencePaths(env) {
  const root = path.join(resolveStateDir(env), 'external_mcp');
  return { log: path.join(root, 'experiences.jsonl'), index: path.join(root, 'experiences-index.json') };
}

function readExperienceLog(target) {
  let text;
  try { text = fs.readFileSync(target, 'utf8'); } catch (error) {
    if (error?.code === 'ENOENT') return { records: [], validText: '', incompleteTail: false };
    throw error;
  }
  if (!text) return { records: [], validText: '', incompleteTail: false };
  const finalNewline = text.endsWith('\n');
  const lines = text.split('\n');
  if (finalNewline) lines.pop();
  const records = [];
  const validLines = [];
  for (let index = 0; index < lines.length; index += 1) {
    try {
      const record = JSON.parse(lines[index]);
      if (!isExternalMcpExperience(record)) return quarantineExperienceLog(target, 'invalid-experience-record');
      records.push(record);
      validLines.push(lines[index]);
    } catch (error) {
      if (index === lines.length - 1 && !finalNewline && incompleteJsonTail(lines[index], error)) {
        return { records, validText: validLines.length ? `${validLines.join('\n')}\n` : '', incompleteTail: true };
      }
      return quarantineExperienceLog(target, 'invalid-jsonl');
    }
  }
  return { records, validText: text, incompleteTail: false };
}

function normalizeQuery(input) {
  const result = {
    domain: String(input.domain || '').trim().toLowerCase(),
    driverId: String(input.driverId || '').trim(),
    driverVersion: String(input.driverVersion || '').trim().toLowerCase(),
    goalClass: String(input.goalClass || '').trim(),
    scopeClass: String(input.scopeClass || '').trim(),
    observationDigest: String(input.observationDigest || '').trim().toLowerCase(),
  };
  return DOMAINS.has(result.domain)
    && safeIdentifier(result.driverId, 120)
    && digest(result.driverVersion)
    && safeIdentifier(result.goalClass, 120)
    && safeIdentifier(result.scopeClass, 180)
    && digest(result.observationDigest) ? result : null;
}

function legalActionIds(actions) {
  const ids = new Set();
  for (const action of Array.isArray(actions) ? actions : []) {
    if (typeof action === 'string' && safeIdentifier(action, 160)) ids.add(action);
    else if (action?.availability === 'available' && action?.unsafe !== true && safeIdentifier(action.actionId, 160)) ids.add(action.actionId);
  }
  return ids;
}

function safeIdentifier(value, limit) {
  const text = String(value || '');
  return text.length > 0 && text.length <= limit && /^[a-zA-Z][a-zA-Z0-9_.:/-]*$/.test(text)
    && !/(cookie|token|secret|password|authorization|bearer|sessdata|sessionid)/i.test(text);
}

function digest(value) { return /^[a-f0-9]{16,128}$/.test(String(value || '')); }
function uniqueStrings(value) { return Array.from(new Set((Array.isArray(value) ? value : []).map((item) => String(item || '').trim()).filter(Boolean))); }
function normalizeTimestamp(value) { const ms = Date.parse(String(value || '')); return Number.isFinite(ms) ? new Date(ms).toISOString() : ''; }
function shortHash(value) { return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16); }
function observationActionKey(record) { return [record.domain, record.driverId, record.driverVersion, record.goalClass, record.scopeClass, record.observationDigest, record.actionId].join('|'); }
function sameEvidence(left, right) { return left.length === right.length && left.every((value, index) => value === right[index]); }
function boundedPositiveInt(value, fallback, ceiling) { const number = Number(value); return Number.isInteger(number) && number > 0 ? Math.min(number, ceiling) : fallback; }

function incompleteJsonTail(line, error) {
  if (!String(line || '').trimStart().startsWith('{')) return false;
  const message = String(error?.message || '');
  return /unexpected end|end of json input/i.test(message) || Number(message.match(/position\s+(\d+)/i)?.[1]) >= String(line).length - 1;
}

function quarantineExperienceLog(target, reason) {
  try { quarantineCorruptState(target, reason); } catch (cause) { throw storeError('external MCP experience log is invalid and could not be quarantined', 'RAN_AGENT_STATE_CORRUPT', cause); }
  throw storeError('external MCP experience log is invalid and was quarantined', 'RAN_AGENT_STATE_CORRUPT');
}

function assertNoUnrecoveredQuarantine(target) {
  if (fs.existsSync(target)) return;
  let entries;
  try { entries = fs.readdirSync(path.dirname(target)); } catch (error) { if (error?.code === 'ENOENT') return; throw error; }
  if (entries.some((entry) => entry.startsWith(`${path.basename(target)}.corrupt-`))) throw storeError('external MCP experience log is quarantined and requires recovery', 'RAN_AGENT_STATE_CORRUPT');
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
    if (descriptor !== undefined) { try { fs.closeSync(descriptor); } catch {} try { fs.rmSync(lockPath, { force: true }); } catch {} }
    if (error?.code === 'EEXIST') return null;
    throw error;
  }
}

function releaseMutationLock(lock) { try { fs.closeSync(lock.descriptor); } finally { fs.rmSync(lock.lockPath, { force: true }); } }
function storeError(message, code, cause) { const error = new Error(message, cause ? { cause } : undefined); error.code = code; return error; }
