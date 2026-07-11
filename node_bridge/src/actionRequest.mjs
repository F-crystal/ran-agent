import { createHash } from 'node:crypto';

const ALLOWED_FIELDS = new Set([
  'requestRef',
  'actionType',
  'scope',
  'payloadRef',
  'requestedAuthorizationBasis',
]);
const PRIVATE_FIELDS = new Set([
  'operationid',
  'actorkey',
  'scopedigest',
  'nonce',
  'expiresat',
  'createdat',
  'capability',
  'privatecapability',
  'executorcapability',
  'issuer',
  'evidencetype',
  'effectdigest',
  'status',
  'receipt',
  'consentdecision',
  'authorized',
  'authorizationdecision',
  'policytier',
]);
const MAX_SCOPE_BYTES = 8_192;

export function normalizeActionRequest(input) {
  if (!isPlainObject(input)) throw actionRequestError('ACTION_REQUEST_INVALID', 'action request must be an object');
  for (const key of Object.keys(input)) {
    if (PRIVATE_FIELDS.has(normalizeFieldName(key))) {
      throw actionRequestError('ACTION_REQUEST_PRIVATE_FIELD', `model cannot supply private field: ${key}`);
    }
    if (!ALLOWED_FIELDS.has(key)) {
      throw actionRequestError('ACTION_REQUEST_UNKNOWN_FIELD', `unknown action request field: ${key}`);
    }
  }

  const requestRef = boundedIdentifier(input.requestRef, 'requestRef', 80);
  const actionType = boundedIdentifier(input.actionType, 'actionType', 120);
  const scope = normalizeJson(input.scope ?? {}, 0);
  if (!isPlainObject(scope)) throw actionRequestError('ACTION_REQUEST_INVALID', 'scope must be an object');
  if (Buffer.byteLength(JSON.stringify(scope), 'utf8') > MAX_SCOPE_BYTES) {
    throw actionRequestError('ACTION_REQUEST_INVALID', 'scope is too large');
  }

  const request = { requestRef, actionType, scope };
  if (input.payloadRef !== undefined) request.payloadRef = boundedText(input.payloadRef, 'payloadRef', 240);
  if (input.requestedAuthorizationBasis !== undefined) {
    request.requestedAuthorizationBasis = boundedIdentifier(
      input.requestedAuthorizationBasis,
      'requestedAuthorizationBasis',
      80,
    );
  }
  return deepFreeze(request);
}

export function digestActionScope(scope) {
  const normalized = normalizeJson(scope ?? {}, 0);
  if (!isPlainObject(normalized)) throw actionRequestError('ACTION_REQUEST_INVALID', 'scope must be an object');
  const encoded = JSON.stringify(normalized);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_SCOPE_BYTES) {
    throw actionRequestError('ACTION_REQUEST_INVALID', 'scope is too large');
  }
  return `sha256:${createHash('sha256').update(encoded, 'utf8').digest('hex')}`;
}

function normalizeJson(value, depth) {
  if (depth > 6) throw actionRequestError('ACTION_REQUEST_INVALID', 'scope is too deeply nested');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw actionRequestError('ACTION_REQUEST_INVALID', 'scope numbers must be finite');
    return value;
  }
  if (typeof value === 'string') return boundedText(value, 'scope value', 2_048);
  if (Array.isArray(value)) {
    if (value.length > 64) throw actionRequestError('ACTION_REQUEST_INVALID', 'scope array is too large');
    return value.map((item) => normalizeJson(item, depth + 1));
  }
  if (!isPlainObject(value)) throw actionRequestError('ACTION_REQUEST_INVALID', 'scope contains an unsupported value');
  const keys = Object.keys(value).sort();
  if (keys.length > 64) throw actionRequestError('ACTION_REQUEST_INVALID', 'scope object is too large');
  const output = {};
  for (const key of keys) {
    if (!key || key.length > 120 || ['__proto__', 'prototype', 'constructor'].includes(key)) {
      throw actionRequestError('ACTION_REQUEST_INVALID', 'scope contains an invalid key');
    }
    output[key] = normalizeJson(value[key], depth + 1);
  }
  return output;
}

function boundedIdentifier(value, name, maxLength) {
  const text = boundedText(value, name, maxLength);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(text)) {
    throw actionRequestError('ACTION_REQUEST_INVALID', `${name} is invalid`);
  }
  return text;
}

function boundedText(value, name, maxLength) {
  if (typeof value !== 'string') throw actionRequestError('ACTION_REQUEST_INVALID', `${name} must be a string`);
  const text = value.trim();
  if (!text || text.length > maxLength || /[\r\n\t\0]/.test(text)) {
    throw actionRequestError('ACTION_REQUEST_INVALID', `${name} is invalid`);
  }
  return text;
}

function normalizeFieldName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

function actionRequestError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
