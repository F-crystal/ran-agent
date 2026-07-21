import { createHash, randomBytes as nodeRandomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';

import { readJsonState, writeJsonAtomic } from './atomicState.mjs';
import { digestActionScope, normalizeActionRequest } from './actionRequest.mjs';
import { resolveStateDir } from './runtimeState.mjs';

const SCHEMA_VERSION = 1;
const DEFAULT_TTL_MS = 5 * 60_000;
const MAX_TTL_MS = 15 * 60_000;
const RECEIPT_STATUSES = new Set(['succeeded', 'failed', 'partial', 'ambiguous', 'rejected']);
const OPERATION_STATES = new Set(['pending', 'executing', 'completed', 'rejected']);

export function createOperationLedger(options = {}) {
  const env = options.env || process.env;
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const randomBytes = typeof options.randomBytes === 'function' ? options.randomBytes : nodeRandomBytes;
  const target = options.path || path.join(resolveStateDir(env), 'core', 'operation-ledger.json');

  function mint({ request, actorContext, ttlMs = DEFAULT_TTL_MS, binding = {} } = {}) {
    const normalizedRequest = normalizeActionRequest(request);
    const actorKey = boundedIdentity(actorContext?.actorKey, 'actorKey');
    const createdAt = currentDate(now).toISOString();
    const lifetime = normalizeTtl(ttlMs);
    const operationId = `op_${randomHex(randomBytes, 16)}`;
    const nonce = `nonce_${randomHex(randomBytes, 16)}`;
    const privateCapability = `opc_${randomHex(randomBytes, 32)}`;
    const scopeDigest = digestActionScope(normalizedRequest.scope);
    const record = {
      operationId,
      requestRef: normalizedRequest.requestRef,
      actorKey,
      actionType: normalizedRequest.actionType,
      scope: normalizedRequest.scope,
      scopeDigest,
      nonce,
      capabilityDigest: digest(privateCapability),
      state: 'pending',
      createdAt,
      expiresAt: new Date(Date.parse(createdAt) + lifetime).toISOString(),
      ...normalizeOperationBinding(binding),
    };
    if (normalizedRequest.payloadRef !== undefined) record.payloadRef = normalizedRequest.payloadRef;
    if (normalizedRequest.requestedAuthorizationBasis !== undefined) {
      record.requestedAuthorizationBasis = normalizedRequest.requestedAuthorizationBasis;
    }
    const state = load();
    state.operations.push(record);
    save(state);
    return deepFreeze({
      ...publicOperation(record),
      privateCapability,
    });
  }

  function reserve({ request, actorContext, ttlMs = DEFAULT_TTL_MS, binding = {} } = {}) {
    const normalizedRequest = normalizeActionRequest(request);
    const actorKey = boundedIdentity(actorContext?.actorKey, 'actorKey');
    const normalizedBinding = normalizeOperationBinding(binding, { requireIdempotency: true });
    const scopeDigest = digestActionScope(normalizedRequest.scope);
    const existing = load().operations.find((item) => (
      item.actorKey === actorKey && item.idempotencyDigest === normalizedBinding.idempotencyDigest
    ));
    if (existing) {
      if (existing.actionType !== normalizedRequest.actionType || existing.scopeDigest !== scopeDigest) {
        throw operationError('OPERATION_IDEMPOTENCY_CONFLICT', 'operation key was already used with different arguments');
      }
      return deepFreeze({ replayed: true, operation: publicOperation(existing) });
    }
    return deepFreeze({
      replayed: false,
      operation: mint({ request: normalizedRequest, actorContext, ttlMs, binding: normalizedBinding }),
    });
  }

  function claim(candidate = {}) {
    if (!candidate || typeof candidate !== 'object') throw operationError('OPERATION_INVALID', 'operation capability is required');
    const state = load();
    const record = state.operations.find((item) => item.operationId === candidate.operationId);
    if (!record) throw operationError('OPERATION_NOT_FOUND', 'operation was not registered');
    if (record.state !== 'pending') throw operationError('OPERATION_REPLAY', 'operation capability is single-use');
    if (currentDate(now).getTime() >= Date.parse(record.expiresAt)) {
      record.state = 'rejected';
      record.rejectionCode = 'expired';
      record.completedAt = currentDate(now).toISOString();
      save(state);
      throw operationError('OPERATION_EXPIRED', 'operation capability expired');
    }
    if (!sameCapability(record.capabilityDigest, candidate.privateCapability)) {
      throw operationError('OPERATION_CAPABILITY_INVALID', 'operation capability is invalid');
    }
    for (const field of ['actorKey', 'actionType', 'scopeDigest', 'nonce']) {
      if (candidate[field] !== record[field]) {
        throw operationError('OPERATION_BINDING_MISMATCH', `operation ${field} does not match`);
      }
    }
    record.state = 'executing';
    record.capabilityConsumedAt = currentDate(now).toISOString();
    save(state);
    return deepFreeze(publicOperation(record));
  }

  function complete(binding = {}) {
    const state = load();
    const record = state.operations.find((item) => item.operationId === binding.operationId);
    if (!record) throw operationError('OPERATION_NOT_FOUND', 'operation was not registered');
    if (record.state !== 'executing') throw operationError('OPERATION_NOT_EXECUTING', 'operation is not executing');
    const status = boundedChoice(binding.status, RECEIPT_STATUSES, 'status');
    const issuer = boundedIdentity(binding.issuer, 'issuer');
    const evidenceType = boundedIdentity(binding.evidenceType, 'evidenceType');
    const effectDigest = String(binding.effectDigest || '');
    if (!/^sha256:[a-f0-9]{64}$/.test(effectDigest)) {
      throw operationError('OPERATION_INVALID', 'effectDigest is invalid');
    }
    for (const field of ['actorKey', 'actionType', 'scopeDigest', 'nonce']) {
      if (binding[field] !== record[field]) {
        throw operationError('OPERATION_BINDING_MISMATCH', `operation ${field} does not match`);
      }
    }
    Object.assign(record, {
      state: 'completed',
      status,
      issuer,
      evidenceType,
      effectDigest,
      completedAt: currentDate(now).toISOString(),
      ...normalizeOutcome(binding),
    });
    save(state);
    return deepFreeze(publicOperation(record));
  }

  function reject({ operationId, code = 'invalid_executor_result', summary = '', target = '', retryable = true } = {}) {
    const state = load();
    const record = state.operations.find((item) => item.operationId === operationId);
    if (!record) throw operationError('OPERATION_NOT_FOUND', 'operation was not registered');
    if (record.state !== 'executing') throw operationError('OPERATION_NOT_EXECUTING', 'operation is not executing');
    record.state = 'rejected';
    record.rejectionCode = boundedIdentity(code, 'rejectionCode');
    record.status = 'rejected';
    Object.assign(record, normalizeOutcome({ summary, target, retryable }));
    record.completedAt = currentDate(now).toISOString();
    save(state);
    return deepFreeze(publicOperation(record));
  }

  function getOperation(operationId) {
    const record = load().operations.find((item) => item.operationId === operationId);
    return record ? deepFreeze(publicOperation(record)) : null;
  }

  function listRecentOutcomes({ actorKey, conversationDigest, limit = 8 } = {}) {
    const actor = boundedIdentity(actorKey, 'actorKey');
    const conversation = boundedDigest(conversationDigest, 'conversationDigest');
    const boundedLimit = Math.max(1, Math.min(32, Number(limit) || 8));
    return deepFreeze(load().operations
      .filter((item) => item.actorKey === actor
        && item.conversationDigest === conversation
        && ['completed', 'rejected'].includes(item.state)
        && item.summary)
      .slice(-boundedLimit)
      .reverse()
      .map((item) => ({
        actionType: item.actionType,
        target: item.target || '',
        status: item.state === 'rejected' ? 'rejected' : item.status,
        summary: item.summary,
        confirmedAt: item.completedAt,
        retryable: item.retryable === true,
      })));
  }

  function findEquivalentOutcome({ actorKey, conversationDigest, actionType, scope } = {}) {
    const actor = boundedIdentity(actorKey, 'actorKey');
    const conversation = boundedDigest(conversationDigest, 'conversationDigest');
    const candidate = scope && typeof scope === 'object' ? scope : {};
    const feishuComparable = [candidate.target, candidate.argumentsDigest, candidate.expectedEffect]
      .every((item) => typeof item === 'string' && item);
    const dailyComparable = actionType === 'ai_daily_digest.send'
      && candidate.mode === 'manual' && candidate.date === 'current_local_date'
      && /^\d{4}-\d{2}-\d{2}$/.test(String(candidate.operationDate || ''));
    if (!feishuComparable && !dailyComparable) return null;
    const record = load().operations.findLast((item) => item.actorKey === actor
      && item.conversationDigest === conversation
      && item.actionType === actionType
      && ['completed', 'rejected'].includes(item.state)
      && (feishuComparable
        ? item.scope?.target === candidate.target
          && item.scope?.argumentsDigest === candidate.argumentsDigest
          && item.scope?.expectedEffect === candidate.expectedEffect
        : item.scope?.mode === candidate.mode
          && item.scope?.date === candidate.date
          && item.scope?.operationDate === candidate.operationDate));
    return record ? deepFreeze(publicOperation(record)) : null;
  }

  function recordRejectedOutcome({ requestRef, actionType, actorContext, binding = {}, code, summary, target = '', retryable = false } = {}) {
    const operation = mint({
      request: { requestRef, actionType, scope: {} },
      actorContext,
      binding,
    });
    claim(operation);
    return reject({ operationId: operation.operationId, code, summary, target, retryable });
  }

  function load() {
    return readJsonState(target, {
      validate: validateLedgerState,
      missingValue: { schemaVersion: SCHEMA_VERSION, operations: [] },
      critical: true,
    });
  }

  function save(state) {
    writeJsonAtomic(target, state, { validate: validateLedgerState });
  }

  return Object.freeze({ target, mint, reserve, claim, complete, reject, getOperation, listRecentOutcomes, findEquivalentOutcome, recordRejectedOutcome });
}

function publicOperation(record) {
  const { capabilityDigest: _capabilityDigest, ...operation } = record;
  return structuredClone(operation);
}

function validateLedgerState(value) {
  if (!value || value.schemaVersion !== SCHEMA_VERSION || !Array.isArray(value.operations)) return false;
  const ids = new Set();
  for (const item of value.operations) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    if (!/^op_[a-f0-9]{32}$/.test(String(item.operationId || '')) || ids.has(item.operationId)) return false;
    ids.add(item.operationId);
    if (!item.requestRef || !item.actorKey || !item.actionType || !/^sha256:[a-f0-9]{64}$/.test(String(item.scopeDigest || ''))) return false;
    try {
      if (digestActionScope(item.scope) !== item.scopeDigest) return false;
    } catch {
      return false;
    }
    if (!/^nonce_[a-f0-9]{32}$/.test(String(item.nonce || ''))) return false;
    if (!/^sha256:[a-f0-9]{64}$/.test(String(item.capabilityDigest || ''))) return false;
    if (!OPERATION_STATES.has(item.state)) return false;
    if (!Number.isFinite(Date.parse(item.createdAt)) || !Number.isFinite(Date.parse(item.expiresAt))) return false;
    if (item.state === 'completed') {
      if (!RECEIPT_STATUSES.has(item.status) || !item.issuer || !item.evidenceType) return false;
      if (!/^sha256:[a-f0-9]{64}$/.test(String(item.effectDigest || ''))) return false;
    }
    if (item.idempotencyDigest !== undefined && !/^sha256:[a-f0-9]{64}$/.test(String(item.idempotencyDigest))) return false;
    if (item.conversationDigest !== undefined && !/^sha256:[a-f0-9]{64}$/.test(String(item.conversationDigest))) return false;
    if (item.requestId !== undefined && !item.requestId) return false;
    if (item.attempt !== undefined && (!Number.isInteger(item.attempt) || item.attempt < 1)) return false;
    if (item.summary !== undefined && (typeof item.summary !== 'string' || item.summary.length > 500)) return false;
    if (item.target !== undefined && (typeof item.target !== 'string' || item.target.length > 180)) return false;
    if (item.retryable !== undefined && typeof item.retryable !== 'boolean') return false;
  }
  return true;
}

function normalizeOperationBinding(value = {}, { requireIdempotency = false } = {}) {
  const output = {};
  if (value.idempotencyDigest !== undefined || requireIdempotency) {
    output.idempotencyDigest = boundedDigest(value.idempotencyDigest, 'idempotencyDigest');
  }
  if (value.conversationDigest !== undefined) output.conversationDigest = boundedDigest(value.conversationDigest, 'conversationDigest');
  if (value.requestId !== undefined) output.requestId = boundedIdentity(value.requestId, 'requestId');
  if (value.platform !== undefined) output.platform = boundedIdentity(value.platform, 'platform');
  if (value.capability !== undefined) output.capability = boundedIdentity(value.capability, 'capability');
  if (value.attempt !== undefined) {
    const attempt = Number(value.attempt);
    if (!Number.isInteger(attempt) || attempt < 1 || attempt > 100) throw operationError('OPERATION_INVALID', 'attempt is invalid');
    output.attempt = attempt;
  }
  return output;
}

function normalizeOutcome(value = {}) {
  const output = {};
  if (value.summary !== undefined && String(value.summary || '').trim()) output.summary = boundedText(value.summary, 'summary', 500);
  if (value.target !== undefined && String(value.target || '').trim()) output.target = boundedText(value.target, 'target', 180);
  if (value.retryable !== undefined) output.retryable = value.retryable === true;
  return output;
}

function boundedDigest(value, name) {
  const text = String(value || '');
  if (!/^sha256:[a-f0-9]{64}$/.test(text)) throw operationError('OPERATION_INVALID', `${name} is invalid`);
  return text;
}

function boundedText(value, name, maxLength) {
  const text = String(value || '').trim();
  if (!text || text.length > maxLength || /[\r\n\t\0]/.test(text)) throw operationError('OPERATION_INVALID', `${name} is invalid`);
  return text;
}

function sameCapability(expectedDigest, capability) {
  const actualDigest = digest(String(capability || ''));
  const left = Buffer.from(expectedDigest, 'utf8');
  const right = Buffer.from(actualDigest, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

function digest(value) {
  return `sha256:${createHash('sha256').update(String(value), 'utf8').digest('hex')}`;
}

function randomHex(randomBytes, length) {
  const value = randomBytes(length);
  if (!Buffer.isBuffer(value) || value.length !== length) {
    throw operationError('OPERATION_RANDOM_INVALID', 'secure random source returned invalid bytes');
  }
  return value.toString('hex');
}

function currentDate(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw operationError('OPERATION_CLOCK_INVALID', 'operation clock is invalid');
  return date;
}

function normalizeTtl(value) {
  const ttl = Number(value);
  if (!Number.isFinite(ttl) || ttl < 1_000 || ttl > MAX_TTL_MS) {
    throw operationError('OPERATION_INVALID', 'operation ttl is invalid');
  }
  return Math.floor(ttl);
}

function boundedIdentity(value, name) {
  const text = String(value || '').trim();
  if (!text || text.length > 180 || /[\r\n\t\0]/.test(text)) {
    throw operationError('OPERATION_INVALID', `${name} is invalid`);
  }
  return text;
}

function boundedChoice(value, allowed, name) {
  const text = boundedIdentity(value, name);
  if (!allowed.has(text)) throw operationError('OPERATION_INVALID', `${name} is invalid`);
  return text;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

function operationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
