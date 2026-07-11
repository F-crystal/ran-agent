import { createHash } from 'node:crypto';

const ALLOWED_BOUNDARIES = new Set([
  'bridge_owned',
  'authenticated_private',
  'verified_runtime_trace',
  'durable_outbox',
  'internal_broker',
]);
const RECEIPT_STATUSES = new Set(['succeeded', 'failed', 'partial', 'ambiguous']);
const BINDING_FIELDS = [
  'operationId',
  'actorKey',
  'actionType',
  'scopeDigest',
  'issuer',
  'status',
  'evidenceType',
];

export function createActionReceiptAuthority({ ledger, now = () => new Date() } = {}) {
  if (!ledger || typeof ledger.complete !== 'function' || typeof ledger.getOperation !== 'function') {
    throw receiptError('RECEIPT_AUTHORITY_INVALID', 'operation ledger is required');
  }
  const registrations = new WeakMap();
  const registeredIssuers = new Set();
  const trustedReceipts = new WeakMap();

  function registerIssuer(config = {}) {
    const issuer = boundedIdentifier(config.issuer, 'issuer');
    if (registeredIssuers.has(issuer)) throw receiptError('RECEIPT_ISSUER_DUPLICATE', 'receipt issuer is already registered');
    const boundary = boundedIdentifier(config.boundary, 'boundary');
    if (!ALLOWED_BOUNDARIES.has(boundary)) {
      throw receiptError('RECEIPT_BOUNDARY_UNTRUSTED', 'receipt issuer boundary is not trusted');
    }
    if (!Array.isArray(config.actionTypes) || config.actionTypes.length === 0) {
      throw receiptError('RECEIPT_ISSUER_INVALID', 'receipt issuer action types are required');
    }
    const actionTypes = new Set(config.actionTypes.map((item) => boundedIdentifier(item, 'actionType')));
    const evidenceType = boundedIdentifier(config.evidenceType, 'evidenceType');
    if (typeof config.validateResult !== 'function' || typeof config.normalizeResult !== 'function') {
      throw receiptError('RECEIPT_ISSUER_INVALID', 'receipt issuer must validate and normalize its result');
    }
    const handle = Object.freeze(Object.create(null));
    registrations.set(handle, Object.freeze({
      issuer,
      actionTypes,
      evidenceType,
      boundary,
      validateResult: config.validateResult,
      normalizeResult: config.normalizeResult,
    }));
    registeredIssuers.add(issuer);
    return handle;
  }

  function issue({ issuerHandle, operation, result } = {}) {
    const registration = registrations.get(issuerHandle);
    if (!registration) throw receiptError('RECEIPT_ISSUER_UNTRUSTED', 'receipt issuer is not registered');
    assertExecutingOperation(ledger, operation);
    if (!registration.actionTypes.has(operation.actionType)) {
      rejectSafely(ledger, operation.operationId, 'issuer_action_mismatch');
      throw receiptError('RECEIPT_ISSUER_MISMATCH', 'receipt issuer does not own this action');
    }

    let canonicalResult;
    try {
      if (!isPlainObject(result) || registration.validateResult(result, operation) !== true) {
        throw new Error('executor result validation failed');
      }
      canonicalResult = registration.normalizeResult(result, operation);
      assertCanonicalResult(canonicalResult);
    } catch (cause) {
      rejectSafely(ledger, operation.operationId, 'invalid_executor_result');
      throw receiptError('RECEIPT_RESULT_INVALID', 'executor result is not trusted', cause);
    }

    const createdAt = currentDate(now).toISOString();
    const effectDigest = digest(canonicalResult.effectId);
    const receipt = Object.freeze({
      operationId: operation.operationId,
      actorKey: operation.actorKey,
      actionType: operation.actionType,
      scopeDigest: operation.scopeDigest,
      status: canonicalResult.status,
      effectDigest,
      evidenceType: registration.evidenceType,
      issuer: registration.issuer,
      nonce: operation.nonce,
      expiresAt: operation.expiresAt,
      createdAt,
    });
    ledger.complete({
      operationId: receipt.operationId,
      actorKey: receipt.actorKey,
      actionType: receipt.actionType,
      scopeDigest: receipt.scopeDigest,
      nonce: receipt.nonce,
      status: receipt.status,
      issuer: receipt.issuer,
      evidenceType: receipt.evidenceType,
      effectDigest: receipt.effectDigest,
    });
    trustedReceipts.set(receipt, fingerprint(receipt));
    return receipt;
  }

  function verify(receipt, expected = {}) {
    const trustedFingerprint = receipt && typeof receipt === 'object' ? trustedReceipts.get(receipt) : null;
    if (!trustedFingerprint || !Object.isFrozen(receipt) || fingerprint(receipt) !== trustedFingerprint) {
      return { ok: false, reason: 'receipt_untrusted' };
    }
    const operation = ledger.getOperation(receipt.operationId);
    if (!operation || operation.state !== 'completed') return { ok: false, reason: 'receipt_operation_untrusted' };
    const ledgerBindings = {
      operationId: operation.operationId,
      actorKey: operation.actorKey,
      actionType: operation.actionType,
      scopeDigest: operation.scopeDigest,
      issuer: operation.issuer,
      status: operation.status,
      evidenceType: operation.evidenceType,
      effectDigest: operation.effectDigest,
      nonce: operation.nonce,
      expiresAt: operation.expiresAt,
    };
    for (const [field, value] of Object.entries(ledgerBindings)) {
      if (receipt[field] !== value) return { ok: false, reason: `receipt_${field}_mismatch` };
    }
    for (const field of BINDING_FIELDS) {
      if (expected[field] !== undefined && receipt[field] !== expected[field]) {
        return { ok: false, reason: `receipt_${field}_mismatch` };
      }
    }
    return { ok: true, reason: 'receipt_trusted', receipt };
  }

  return Object.freeze({ registerIssuer, issue, verify });
}

function assertExecutingOperation(ledger, operation) {
  if (!operation || typeof operation !== 'object') throw receiptError('RECEIPT_OPERATION_INVALID', 'claimed operation is required');
  const registered = ledger.getOperation(operation.operationId);
  if (!registered || registered.state !== 'executing') {
    throw receiptError('RECEIPT_OPERATION_INVALID', 'operation is not executing');
  }
  for (const field of ['operationId', 'actorKey', 'actionType', 'scopeDigest', 'nonce', 'expiresAt']) {
    if (registered[field] !== operation[field]) {
      throw receiptError('RECEIPT_OPERATION_INVALID', `operation ${field} does not match`);
    }
  }
}

function assertCanonicalResult(result) {
  if (!isPlainObject(result)) throw new Error('normalized result must be an object');
  const keys = Object.keys(result).sort();
  if (keys.length !== 2 || keys[0] !== 'effectId' || keys[1] !== 'status') {
    throw new Error('normalized result must contain only status and effectId');
  }
  if (!RECEIPT_STATUSES.has(result.status)) throw new Error('normalized result status is invalid');
  boundedIdentifier(result.effectId, 'effectId', 240);
}

function rejectSafely(ledger, operationId, code) {
  try {
    ledger.reject({ operationId, code });
  } catch {}
}

function fingerprint(receipt) {
  return JSON.stringify([
    receipt.operationId,
    receipt.actorKey,
    receipt.actionType,
    receipt.scopeDigest,
    receipt.status,
    receipt.effectDigest,
    receipt.evidenceType,
    receipt.issuer,
    receipt.nonce,
    receipt.expiresAt,
    receipt.createdAt,
  ]);
}

function digest(value) {
  return `sha256:${createHash('sha256').update(String(value), 'utf8').digest('hex')}`;
}

function boundedIdentifier(value, name, maxLength = 180) {
  const text = String(value || '').trim();
  if (!text || text.length > maxLength || /[\r\n\t\0]/.test(text)) {
    throw receiptError('RECEIPT_ISSUER_INVALID', `${name} is invalid`);
  }
  return text;
}

function currentDate(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw receiptError('RECEIPT_CLOCK_INVALID', 'receipt clock is invalid');
  return date;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function receiptError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}
