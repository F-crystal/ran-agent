// compatibility.final-turn/v1 and compatibility.retrieval-used/v1 schemas (§4).
// The source event is the only queue ingress; it is produced mechanically by
// the trusted emitter from an already-fixed final gate result. Validation is
// fail-closed: anything malformed never enters the queue.

import { canonicalDigest, isSha256Digest } from './canonical.mjs';
import {
  COMPAT_SOURCE_EVENT_SCHEMA,
  COMPAT_RETRIEVAL_EVENT_SCHEMA,
  PRESENTATION_STATES,
  SENSITIVITY_LEVELS,
  SOURCE_LIFECYCLE_STATES,
  compatError,
} from './constants.mjs';

const FINAL_TURN_REQUIRED_STRINGS = [
  'schema_version',
  'event_id',
  'conversation_id',
  'exchange_id',
  'user_final_payload_ref',
  'user_final_payload_digest',
  'assistant_final_payload_ref',
  'assistant_final_payload_digest',
  'final_content_digest',
  'scope_envelope_ref',
  'scope_envelope_digest',
  'sensitivity',
  'presentation_state',
  'trusted_action_receipts_digest',
  'lifecycle_state',
  'source_gate_receipt_ref',
  'emitter_id',
  'emitter_version',
  'emitted_at',
];

const FINAL_TURN_NULLABLE_STRINGS = [
  'delivery_observation_ref',
  'delivery_observation_digest',
  'supersedes_event_id',
  'withdrawal_ref',
  'supersession_ref',
  'deletion_ref',
];

const FINAL_TURN_REVISION_INTEGERS = [
  'source_revision',
  'user_final_payload_revision',
  'assistant_final_payload_revision',
];

const FINAL_TURN_NULLABLE_INTEGERS = [
  'withdrawal_revision',
  'supersession_revision',
  'deletion_revision',
];

export function computeSourceEventDigest(event) {
  const { source_event_digest: _ignored, ...material } = event;
  return canonicalDigest(material);
}

// Validates and freezes a final-turn source event. Returns a defensive copy
// including a verified source_event_digest.
export function validateFinalTurnSourceEvent(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw compatError('COMPAT_INGRESS_INVALID', 'source event must be an object');
  }
  const event = { ...input };
  if (event.schema_version !== COMPAT_SOURCE_EVENT_SCHEMA) {
    throw compatError('COMPAT_INGRESS_INVALID', `unknown source event schema ${event.schema_version}`);
  }
  for (const field of FINAL_TURN_REQUIRED_STRINGS) {
    if (typeof event[field] !== 'string' || event[field].length === 0) {
      throw compatError('COMPAT_INGRESS_INVALID', `source event missing ${field}`);
    }
  }
  for (const field of FINAL_TURN_NULLABLE_STRINGS) {
    if (event[field] === undefined || event[field] === null) event[field] = null;
    if (event[field] !== null && typeof event[field] !== 'string') {
      throw compatError('COMPAT_INGRESS_INVALID', `source event ${field} must be a string or null`);
    }
  }
  for (const field of FINAL_TURN_REVISION_INTEGERS) {
    if (!Number.isInteger(event[field]) || event[field] < 0) {
      throw compatError('COMPAT_INGRESS_INVALID', `source event ${field} must be a non-negative integer`);
    }
  }
  for (const field of FINAL_TURN_NULLABLE_INTEGERS) {
    if (event[field] === undefined || event[field] === null) event[field] = null;
    if (event[field] !== null && (!Number.isInteger(event[field]) || event[field] < 0)) {
      throw compatError('COMPAT_INGRESS_INVALID', `source event ${field} must be a non-negative integer or null`);
    }
  }
  if (!PRESENTATION_STATES.includes(event.presentation_state)) {
    throw compatError('COMPAT_INGRESS_INVALID', `unknown presentation_state ${event.presentation_state}`);
  }
  if (!SOURCE_LIFECYCLE_STATES.includes(event.lifecycle_state)) {
    throw compatError('COMPAT_INGRESS_INVALID', `unknown lifecycle_state ${event.lifecycle_state}`);
  }
  if (!SENSITIVITY_LEVELS.includes(event.sensitivity)) {
    throw compatError('COMPAT_INGRESS_INVALID', `unknown sensitivity ${event.sensitivity}`);
  }
  if (!Array.isArray(event.trusted_action_receipt_refs)) {
    throw compatError('COMPAT_INGRESS_INVALID', 'trusted_action_receipt_refs must be an array');
  }
  event.trusted_action_receipt_refs = event.trusted_action_receipt_refs.map((ref) => {
    if (typeof ref !== 'string' || !ref) {
      throw compatError('COMPAT_INGRESS_INVALID', 'trusted_action_receipt_refs entries must be strings');
    }
    return ref;
  });
  for (const field of [
    'user_final_payload_digest',
    'assistant_final_payload_digest',
    'final_content_digest',
    'scope_envelope_digest',
    'trusted_action_receipts_digest',
  ]) {
    if (!isSha256Digest(event[field])) {
      throw compatError('COMPAT_INGRESS_INVALID', `source event ${field} must be a sha256 digest`);
    }
  }
  if ((event.delivery_observation_ref === null) !== (event.delivery_observation_digest === null)
    || (event.delivery_observation_digest !== null && !isSha256Digest(event.delivery_observation_digest))) {
    throw compatError('COMPAT_INGRESS_INVALID', 'delivery observation binding is invalid');
  }
  const terminalPresentation = ['presented', 'failed', 'ambiguous'].includes(event.presentation_state);
  if (terminalPresentation !== (event.delivery_observation_ref !== null)) {
    throw compatError('COMPAT_INGRESS_INVALID', 'terminal presentation state requires exactly one observation');
  }
  if (!Number.isFinite(Date.parse(event.emitted_at))) {
    throw compatError('COMPAT_INGRESS_INVALID', 'emitted_at must be a valid timestamp');
  }
  const digest = computeSourceEventDigest(event);
  if (event.source_event_digest !== undefined && event.source_event_digest !== digest) {
    throw compatError('COMPAT_INGRESS_INVALID', 'source_event_digest mismatch');
  }
  event.source_event_digest = digest;
  return deepFreeze(event);
}

// compatibility.retrieval-used/v1 (§7.2): emitted only by the trusted context
// assembler / reader host when a projection item actually entered provider
// input or a bounded tool result.
export function validateRetrievalUsedEvent(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw compatError('COMPAT_INGRESS_INVALID', 'retrieval-used event must be an object');
  }
  const event = { ...input };
  if (event.schema_version !== COMPAT_RETRIEVAL_EVENT_SCHEMA) {
    throw compatError('COMPAT_INGRESS_INVALID', `unknown retrieval-used schema ${event.schema_version}`);
  }
  for (const field of [
    'retrieval_event_id',
    'operation_key',
    'conversation_id',
    'exchange_id',
    'projection_revision',
    'projection_item_ref',
    'projection_item_digest',
    'usage_kind',
    'scope_envelope_digest',
    'emitted_at',
  ]) {
    if (typeof event[field] !== 'string' || event[field].length === 0) {
      throw compatError('COMPAT_INGRESS_INVALID', `retrieval-used event missing ${field}`);
    }
  }
  if (!Number.isInteger(event.source_turn_revision) || event.source_turn_revision < 0) {
    throw compatError('COMPAT_INGRESS_INVALID', 'source_turn_revision must be a non-negative integer');
  }
  if (typeof event.source_turn_id !== 'string' || !event.source_turn_id) {
    throw compatError('COMPAT_INGRESS_INVALID', 'retrieval-used event missing source_turn_id');
  }
  if (!Number.isFinite(Date.parse(event.emitted_at))) {
    throw compatError('COMPAT_INGRESS_INVALID', 'emitted_at must be a valid timestamp');
  }
  return deepFreeze(event);
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}
