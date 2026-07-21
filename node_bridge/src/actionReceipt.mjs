import { createHash } from 'node:crypto';

const ALLOWED_BOUNDARIES = new Set([
  'bridge_owned',
  'authenticated_private',
  'verified_runtime_trace',
  'durable_outbox',
  'internal_broker',
]);
const RECEIPT_STATUSES = new Set(['succeeded', 'failed', 'partial', 'ambiguous', 'rejected']);
const BINDING_FIELDS = [
  'operationId',
  'actorKey',
  'actionType',
  'scopeDigest',
  'issuer',
  'status',
  'evidenceType',
  'requestId',
  'conversationDigest',
  'platform',
  'attempt',
  'capability',
  'idempotencyDigest',
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
      ...copyOperationBindings(operation),
      ...copyOutcome(canonicalResult),
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
      summary: receipt.summary,
      target: receipt.target,
      retryable: receipt.retryable,
    });
    trustedReceipts.set(receipt, fingerprint(receipt));
    return receipt;
  }

  function verify(receipt, expected = {}) {
    const trustedFingerprint = receipt && typeof receipt === 'object' ? trustedReceipts.get(receipt) : null;
    if (!trustedFingerprint || !Object.isFrozen(receipt) || fingerprint(receipt) !== trustedFingerprint) {
      return { ok: false, reason: 'receipt_untrusted' };
    }
    const expiresAt = Date.parse(receipt.expiresAt);
    if (!Number.isFinite(expiresAt) || currentDate(now).getTime() >= expiresAt) {
      return { ok: false, reason: 'receipt_expired' };
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
      ...copyOperationBindings(operation),
      ...copyOutcome(operation),
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
  const allowed = new Set(['effectId', 'status', 'summary', 'target', 'retryable']);
  if (Object.keys(result).some((key) => !allowed.has(key)) || !Object.hasOwn(result, 'effectId') || !Object.hasOwn(result, 'status')) {
    throw new Error('normalized result contains invalid fields');
  }
  if (!RECEIPT_STATUSES.has(result.status)) throw new Error('normalized result status is invalid');
  boundedIdentifier(result.effectId, 'effectId', 240);
  if (result.summary !== undefined) boundedText(result.summary, 'summary', 500);
  if (result.target !== undefined) boundedText(result.target, 'target', 180);
  if (result.retryable !== undefined && typeof result.retryable !== 'boolean') throw new Error('normalized retryable is invalid');
}

function copyOperationBindings(operation) {
  const output = {};
  for (const field of ['requestId', 'conversationDigest', 'platform', 'attempt', 'capability', 'idempotencyDigest']) {
    if (operation[field] !== undefined) output[field] = operation[field];
  }
  return output;
}

function copyOutcome(result) {
  const output = {};
  for (const field of ['summary', 'target', 'retryable']) {
    if (result[field] !== undefined) output[field] = result[field];
  }
  return output;
}

function boundedText(value, name, maxLength) {
  const text = String(value || '').trim();
  if (!text || text.length > maxLength || /[\r\n\t\0]/.test(text)) throw new Error(`${name} is invalid`);
  return text;
}

function rejectSafely(ledger, operationId, code) {
  try {
    ledger.reject({ operationId, code, summary: '我目前不能确认这一步已经执行。', retryable: false });
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
    receipt.requestId,
    receipt.conversationDigest,
    receipt.platform,
    receipt.attempt,
    receipt.capability,
    receipt.idempotencyDigest,
    receipt.summary,
    receipt.target,
    receipt.retryable,
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
