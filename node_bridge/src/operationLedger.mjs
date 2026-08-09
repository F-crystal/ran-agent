import { createHash, randomBytes as nodeRandomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';

import { readJsonState, writeJsonAtomic } from './atomicState.mjs';
import { digestActionScope, normalizeActionRequest } from './actionRequest.mjs';
import { resolveStateDir } from './runtimeState.mjs';

const SCHEMA_VERSION = 1;
const DEFAULT_TTL_MS = 5 * 60_000;
const MAX_TTL_MS = 15 * 60_000;
const RECEIPT_STATUSES = new Set(['succeeded', 'failed', 'partial', 'ambiguous']);
const OPERATION_STATES = new Set(['pending', 'executing', 'completed', 'rejected']);

export function createOperationLedger(options = {}) {
  const env = options.env || process.env;
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const randomBytes = typeof options.randomBytes === 'function' ? options.randomBytes : nodeRandomBytes;
  const target = options.path || path.join(resolveStateDir(env), 'core', 'operation-ledger.json');

  function mint({ request, actorContext, ttlMs = DEFAULT_TTL_MS } = {}) {
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
    });
    save(state);
    return deepFreeze(publicOperation(record));
  }

  function reject({ operationId, code = 'invalid_executor_result' } = {}) {
    const state = load();
    const record = state.operations.find((item) => item.operationId === operationId);
    if (!record) throw operationError('OPERATION_NOT_FOUND', 'operation was not registered');
    if (record.state !== 'executing') throw operationError('OPERATION_NOT_EXECUTING', 'operation is not executing');
    record.state = 'rejected';
    record.rejectionCode = boundedIdentity(code, 'rejectionCode');
    record.completedAt = currentDate(now).toISOString();
    save(state);
    return deepFreeze(publicOperation(record));
  }

  function getOperation(operationId) {
    const record = load().operations.find((item) => item.operationId === operationId);
    return record ? deepFreeze(publicOperation(record)) : null;
  }

  function findByCausation({ request, actorContext } = {}) {
    const normalizedRequest = normalizeActionRequest(request);
    const actorKey = boundedIdentity(actorContext?.actorKey, 'actorKey');
    const causationRef = String(normalizedRequest.scope?.causationRef || '');
    if (!causationRef) throw operationError('OPERATION_INVALID', 'causationRef is required');
    const record = load().operations.findLast((item) => (
      item.actorKey === actorKey
      && item.actionType === normalizedRequest.actionType
      && item.scope?.causationRef === causationRef
    ));
    return record ? deepFreeze(publicOperation(record)) : null;
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

  return Object.freeze({ target, mint, claim, complete, reject, getOperation, findByCausation });
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
  }
  return true;
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
