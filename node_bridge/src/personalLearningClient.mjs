const ACTION_TYPES = Object.freeze([
  'memory.remember',
  'memory.correct',
  'memory.forget',
  'memory.query',
]);
const ACTION_TYPE_SET = new Set(ACTION_TYPES);
const RESPONSE_KEYS = ['authenticated', 'effectId', 'ok', 'operationId', 'result'];
const OPERATION_ID = /^op_[a-f0-9]{32}$/;
const EFFECT_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,179}$/;
const MAX_SCOPE_BYTES = 8_192;
const MAX_RESULT_BYTES = 32_768;

export function createPersonalLearningExecutorAdapter({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const baseUrl = privateBaseUrl(env.PYTHON_BACKEND_BASE_URL || 'http://127.0.0.1:8787');
  const secret = String(env.RAN_AGENT_INTERNAL_CONTROL_SECRET || '');
  const timeoutMs = positiveInt(env.PERSONAL_LEARNING_CLIENT_TIMEOUT_MS, 5_000);
  if (!secret || /\s/.test(secret) || typeof fetchImpl !== 'function') {
    throw adapterError('PERSONAL_LEARNING_ADAPTER_CONFIG', 'personal learning adapter configuration is invalid');
  }

  async function execute({ operation, signal } = {}) {
    const body = normalizeOperation(operation);
    let response;
    try {
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      response = await fetchImpl(`${baseUrl}/internal/personal-learning/actions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secret}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: requestSignal,
      });
    } catch {
      throw adapterError('PERSONAL_LEARNING_REQUEST_FAILED', 'personal learning adapter request failed');
    }
    let responseOk;
    let responseStatus;
    try {
      responseStatus = Number(response?.status) || 0;
      responseOk = response?.ok === true && responseStatus >= 200 && responseStatus < 300;
    } catch {
      throw adapterError('PERSONAL_LEARNING_RESPONSE_INVALID', 'personal learning adapter response is invalid');
    }
    if (!responseOk) {
      throw adapterError(
        'PERSONAL_LEARNING_HTTP_REJECTED',
        `personal learning adapter rejected request (HTTP ${responseStatus})`,
      );
    }
    let payload;
    try {
      payload = await response.json();
      return normalizeResponse(payload, body.operationId);
    } catch (error) {
      if (error?.code === 'PERSONAL_LEARNING_RESPONSE_INVALID') throw error;
      throw adapterError('PERSONAL_LEARNING_RESPONSE_INVALID', 'personal learning adapter response is invalid');
    }
  }

  function validateResult(value, operation) {
    try {
      normalizeResponse(value, normalizeOperation(operation).operationId);
      return true;
    } catch {
      return false;
    }
  }

  function normalizeResult(value) {
    return {
      status: value.ok === true ? 'succeeded' : 'failed',
      effectId: value.effectId,
    };
  }

  return Object.freeze({
    issuer: 'bridge:python-personal-learning-adapter',
    actionTypes: ACTION_TYPES,
    evidenceType: 'personal_learning_result',
    boundary: 'authenticated_private',
    execute,
    validateResult,
    normalizeResult,
  });
}

function normalizeOperation(value) {
  if (!isPlainObject(value) || !OPERATION_ID.test(String(value.operationId || ''))) {
    throw adapterError('PERSONAL_LEARNING_ACTION_INVALID', 'personal learning action is invalid');
  }
  const actionType = String(value.actionType || '');
  if (!ACTION_TYPE_SET.has(actionType)) {
    throw adapterError('PERSONAL_LEARNING_ACTION_INVALID', 'personal learning action is invalid');
  }
  let scope;
  try {
    scope = normalizeJson(value.scope, 0);
    if (!isPlainObject(scope) || Buffer.byteLength(JSON.stringify(scope), 'utf8') > MAX_SCOPE_BYTES) throw new Error('invalid');
  } catch {
    throw adapterError('PERSONAL_LEARNING_SCOPE_INVALID', 'personal learning scope is invalid');
  }
  return { operationId: value.operationId, actionType, scope };
}

function normalizeResponse(value, operationId) {
  try {
    if (!isPlainObject(value) || Object.keys(value).sort().join('|') !== RESPONSE_KEYS.join('|')) throw new Error('invalid');
    if (typeof value.ok !== 'boolean' || value.authenticated !== true || value.operationId !== operationId) throw new Error('invalid');
    if (!EFFECT_ID.test(String(value.effectId || '')) || !isPlainObject(value.result)) throw new Error('invalid');
    const result = normalizeJson(value.result, 0);
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_RESULT_BYTES) throw new Error('invalid');
    return deepFreeze({
      ok: value.ok,
      authenticated: true,
      operationId,
      effectId: value.effectId,
      result,
    });
  } catch {
    throw adapterError('PERSONAL_LEARNING_RESPONSE_INVALID', 'personal learning adapter response is invalid');
  }
}

function normalizeJson(value, depth) {
  if (depth > 7) throw new Error('invalid');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('invalid');
    return value;
  }
  if (typeof value === 'string') {
    if (value.length > 8_192 || /\0/.test(value)) throw new Error('invalid');
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 128) throw new Error('invalid');
    return value.map((item) => normalizeJson(item, depth + 1));
  }
  if (!isPlainObject(value)) throw new Error('invalid');
  const keys = Object.keys(value).sort();
  if (keys.length > 128) throw new Error('invalid');
  const output = {};
  for (const key of keys) {
    if (!key || key.length > 160 || ['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('invalid');
    output[key] = normalizeJson(value[key], depth + 1);
  }
  return output;
}

function privateBaseUrl(value) {
  try {
    const url = new URL(String(value || ''));
    const hostname = url.hostname.toLowerCase();
    const parts = hostname.split('.');
    const loopbackV4 = parts.length === 4
      && parts[0] === '127'
      && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
    const loopbackV6 = hostname === '[::1]' || hostname === '::1';
    if (
      url.protocol !== 'http:'
      || url.username
      || url.password
      || url.search
      || url.hash
      || !['', '/'].includes(url.pathname)
      || (!loopbackV4 && !loopbackV6)
    ) throw new Error('invalid');
    return url.origin;
  } catch {
    throw adapterError('PERSONAL_LEARNING_ADAPTER_CONFIG', 'personal learning adapter configuration is invalid');
  }
}

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 && number <= 60_000 ? number : fallback;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function adapterError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
