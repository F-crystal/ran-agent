import { normalizeActionRequest } from './actionRequest.mjs';

const ENVELOPE_FIELDS = new Set([
  'schemaVersion',
  'message',
  'actionRequests',
  'activityRequest',
  'claims',
  'commitments',
]);
const DECLARATION_FIELDS = new Set(['type', 'requestRef', 'text']);

export function normalizeReplyEnvelope(response) {
  if (!isPlainObject(response)) throw envelopeError('REPLY_ENVELOPE_INVALID', 'reply must be an object');
  const explicit = response.reply_envelope ?? response.replyEnvelope;
  if (explicit !== undefined) return normalizeExplicitEnvelope(explicit);

  const message = collapseReplyFragments(
    response.reply_text ?? response.replyText ?? response.message ?? '',
    response.follow_up_messages ?? response.followUpMessages ?? [],
  );
  return deepFreeze({
    schemaVersion: 1,
    message,
    actionRequests: normalizeActionRequests(response.action_requests ?? response.actionRequests ?? []),
    activityRequest: normalizeActivityRequest(response.activity_request ?? response.activityRequest ?? null),
    claims: normalizeDeclarations(response.claims ?? [], 'claims'),
    commitments: normalizeDeclarations(response.commitments ?? [], 'commitments'),
  });
}

function normalizeExplicitEnvelope(input) {
  if (!isPlainObject(input)) throw envelopeError('REPLY_ENVELOPE_INVALID', 'explicit envelope must be an object');
  if (!Object.hasOwn(input, 'schemaVersion')) {
    throw envelopeError('REPLY_ENVELOPE_VERSION_REQUIRED', 'explicit envelope requires schemaVersion');
  }
  if (input.schemaVersion !== 1) {
    throw envelopeError('REPLY_ENVELOPE_VERSION_UNSUPPORTED', 'unsupported reply envelope version');
  }
  for (const key of Object.keys(input)) {
    if (!ENVELOPE_FIELDS.has(key)) throw envelopeError('REPLY_ENVELOPE_INVALID', `unknown envelope field: ${key}`);
  }
  if (!Object.hasOwn(input, 'message')) throw envelopeError('REPLY_ENVELOPE_INVALID', 'message is required');
  return deepFreeze({
    schemaVersion: 1,
    message: boundedText(input.message, 'message', 32_000, true),
    actionRequests: normalizeActionRequests(input.actionRequests ?? []),
    activityRequest: normalizeActivityRequest(input.activityRequest ?? null),
    claims: normalizeDeclarations(input.claims ?? [], 'claims'),
    commitments: normalizeDeclarations(input.commitments ?? [], 'commitments'),
  });
}

function collapseReplyFragments(message, followUps) {
  const first = boundedText(message, 'message', 32_000, true);
  if (!Array.isArray(followUps) || followUps.length > 16) {
    throw envelopeError('REPLY_ENVELOPE_INVALID', 'follow-up messages must be a bounded array');
  }
  const fragments = [first, ...followUps.map((item) => boundedText(item, 'follow-up message', 8_000, true))]
    .map((item) => item.trim())
    .filter(Boolean);
  const collapsed = fragments.join('\n\n');
  if (collapsed.length > 32_000) throw envelopeError('REPLY_ENVELOPE_INVALID', 'collapsed message is too large');
  return collapsed;
}

function normalizeActionRequests(items) {
  if (!Array.isArray(items) || items.length > 16) {
    throw envelopeError('REPLY_ENVELOPE_INVALID', 'actionRequests must be a bounded array');
  }
  const normalized = items.map((item) => normalizeActionRequest(item));
  const requestRefs = new Set();
  for (const item of normalized) {
    if (requestRefs.has(item.requestRef)) {
      throw envelopeError('REPLY_ENVELOPE_INVALID', 'action requestRef values must be unique');
    }
    requestRefs.add(item.requestRef);
  }
  return normalized;
}

function normalizeDeclarations(items, label) {
  if (!Array.isArray(items) || items.length > 32) {
    throw envelopeError('REPLY_ENVELOPE_INVALID', `${label} must be a bounded array`);
  }
  return items.map((item) => {
    if (!isPlainObject(item)) throw envelopeError('REPLY_ENVELOPE_INVALID', `${label} items must be objects`);
    for (const key of Object.keys(item)) {
      if (!DECLARATION_FIELDS.has(key)) throw envelopeError('REPLY_ENVELOPE_INVALID', `unknown ${label} field: ${key}`);
    }
    const result = { type: identifier(item.type, `${label} type`, 120) };
    if (item.requestRef !== undefined) result.requestRef = identifier(item.requestRef, 'requestRef', 80);
    if (item.text !== undefined) result.text = boundedText(item.text, `${label} text`, 1_000, false);
    return result;
  });
}

function normalizeActivityRequest(value) {
  if (value === null || value === undefined) return null;
  if (!isPlainObject(value)) throw envelopeError('REPLY_ENVELOPE_INVALID', 'activityRequest must be an object or null');
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, 'utf8') > 8_192 || containsUnsafeObjectKey(value, 0)) {
    throw envelopeError('REPLY_ENVELOPE_INVALID', 'activityRequest is invalid');
  }
  return JSON.parse(encoded);
}

function containsUnsafeObjectKey(value, depth) {
  if (depth > 6) return true;
  if (Array.isArray(value)) return value.length > 64 || value.some((item) => containsUnsafeObjectKey(item, depth + 1));
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, item]) => (
    !key || key.length > 120 || ['__proto__', 'prototype', 'constructor'].includes(key)
      || containsUnsafeObjectKey(item, depth + 1)
  ));
}

function identifier(value, label, maxLength) {
  const text = boundedText(value, label, maxLength, false);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(text)) {
    throw envelopeError('REPLY_ENVELOPE_INVALID', `${label} is invalid`);
  }
  return text;
}

function boundedText(value, label, maxLength, allowEmpty) {
  if (typeof value !== 'string') throw envelopeError('REPLY_ENVELOPE_INVALID', `${label} must be a string`);
  const text = value.trim();
  if ((!allowEmpty && !text) || text.length > maxLength || text.includes('\0')) {
    throw envelopeError('REPLY_ENVELOPE_INVALID', `${label} is invalid`);
  }
  return text;
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

function envelopeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
