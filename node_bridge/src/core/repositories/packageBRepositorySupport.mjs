import { createHash } from 'node:crypto';

import { coreError } from '../coreErrors.mjs';
import { assertOperationSemanticDigest } from '../coreOperationDigest.mjs';

const OPERATION_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;
const TYPED_RECEIPT_PREFIX = 'package_b_typed_receipt:';

export function assertPackageBOperationKey(value) {
  if (typeof value !== 'string' || !OPERATION_KEY_PATTERN.test(value)) {
    throw coreError('CORE_OPERATION_KEY_INVALID', 'Package B operation key is invalid');
  }
  return value;
}

export function assertNonEmptyString(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw coreError('CORE_TYPED_INPUT_INVALID', `${field} must be a non-empty string`);
  }
  return value;
}

export function assertNonNegativeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw coreError('CORE_AUTHORITY_INTEGER_INVALID', `${field} must be a non-negative safe integer`);
  }
  return value;
}

export function packageBReceiptEventId(kind, operationKey, operationScope = 'global') {
  assertNonEmptyString(kind, 'receipt kind');
  assertPackageBOperationKey(operationKey);
  assertNonEmptyString(operationScope, 'receipt operation scope');
  const keyDigest = createHash('sha256').update(`${operationScope}\u0000${operationKey}`, 'utf8').digest('hex');
  return `package-b:${kind}:${keyDigest}`;
}

export function findPackageBReceipt(get, kind, operationKey, operationScope = 'global') {
  return get(`SELECT * FROM journal_event
    WHERE journal_event_id=? AND event_type=?`,
  packageBReceiptEventId(kind, operationKey, operationScope), `package_b_${kind}`);
}

export function findPackageBReceiptByOperationKey(get, kind, operationKey) {
  return get(`SELECT * FROM journal_event WHERE event_type=? AND origin_ref=?`,
    `package_b_${kind}`, operationKey);
}

export function assertPackageBReceipt(receipt, operationDigest, label) {
  assertOperationSemanticDigest(operationDigest);
  if (receipt.source_ref !== operationDigest) {
    throw coreError('CORE_OPERATION_KEY_CONFLICT', `${label} operation key has different semantics`);
  }
  return receipt;
}

export function appendPackageBReceipt(run, get, {
  kind, operationKey, operationDigest, resultId, createdAt,
  operationScope = 'global',
  ownerId = null, conversationId = null, exchangeId = null, actorRef = null,
  revision = 0, causationId = null, correlationId = resultId, sourceKind = 'package_b_operation',
}) {
  const eventId = packageBReceiptEventId(kind, operationKey, operationScope);
  run(`INSERT INTO journal_event(
    journal_event_id,event_type,owner_id,conversation_id,exchange_id,actor_ref,
    origin_ref,source_kind,source_ref,revision,causation_id,correlation_id,created_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  eventId, `package_b_${kind}`, ownerId, conversationId, exchangeId, actorRef,
  operationKey, sourceKind, assertOperationSemanticDigest(operationDigest),
  revision, causationId, correlationId, createdAt);
  return get('SELECT * FROM journal_event WHERE journal_event_id=?', eventId);
}

export function readVerifiedConversationIdentity(read, expected, conversationId = expected?.conversationId) {
  if (!expected || expected.conversationId !== conversationId
    || typeof expected.identityReceiptId !== 'string' || typeof expected.canonicalConversationKey !== 'string'
    || typeof expected.ownerId !== 'string' || typeof expected.actorRef !== 'string'
    || typeof expected.platform !== 'string' || typeof expected.sourceInstanceId !== 'string'
    || typeof expected.platformConversationBinding !== 'string'
    || !Number.isSafeInteger(expected.identityRevision) || typeof expected.operationDigest !== 'string') return undefined;
  const eventId = packageBReceiptEventId('conversation_identity_bound', expected.canonicalConversationKey, 'conversation_identity');
  if (expected.identityReceiptId !== eventId) return undefined;
  return read(`SELECT * FROM journal_event WHERE journal_event_id=? AND event_type=?
      AND conversation_id=? AND owner_id=? AND actor_ref=? AND origin_ref=? AND source_kind=?
      AND causation_id=? AND correlation_id=? AND revision=? AND source_ref=?`,
  eventId, 'package_b_conversation_identity_bound', expected.conversationId, expected.ownerId,
  expected.actorRef, expected.canonicalConversationKey, `package_b_conversation_identity:${expected.platform}`,
  expected.sourceInstanceId, expected.platformConversationBinding, expected.identityRevision, expected.operationDigest);
}

export function encodePackageBTypedReceipt(kind, entries) {
  assertNonEmptyString(kind, 'typed receipt kind');
  if (!Array.isArray(entries) || entries.some((entry) => !Array.isArray(entry) || entry.length !== 2
    || typeof entry[0] !== 'string')) {
    throw coreError('CORE_TYPED_RECEIPT_INVALID', 'typed receipt fields are invalid');
  }
  const canonical = JSON.stringify([['receipt_schema', `${kind}:v1`], ...entries]);
  return `${TYPED_RECEIPT_PREFIX}${kind}:v1:${Buffer.from(canonical, 'utf8').toString('base64url')}`;
}

export function decodePackageBTypedReceipt(sourceKind, kind, fieldNames) {
  const prefix = `${TYPED_RECEIPT_PREFIX}${kind}:v1:`;
  if (typeof sourceKind !== 'string' || !sourceKind.startsWith(prefix)) {
    throw coreError('CORE_OPERATION_RECEIPT_INTEGRITY', `${kind} typed receipt encoding is missing`);
  }
  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(sourceKind.slice(prefix.length), 'base64url').toString('utf8'));
  } catch (error) {
    throw coreError('CORE_OPERATION_RECEIPT_INTEGRITY', `${kind} typed receipt encoding is invalid`, error);
  }
  if (!Array.isArray(decoded) || decoded.length !== fieldNames.length + 1
    || decoded[0]?.[0] !== 'receipt_schema' || decoded[0]?.[1] !== `${kind}:v1`) {
    throw coreError('CORE_OPERATION_RECEIPT_INTEGRITY', `${kind} typed receipt schema is invalid`);
  }
  const result = {};
  for (let index = 0; index < fieldNames.length; index += 1) {
    const entry = decoded[index + 1];
    if (!Array.isArray(entry) || entry.length !== 2 || entry[0] !== fieldNames[index]) {
      throw coreError('CORE_OPERATION_RECEIPT_INTEGRITY', `${kind} typed receipt field order is invalid`);
    }
    result[fieldNames[index]] = entry[1];
  }
  return result;
}

export function conversationIdentityFromReceipt(receipt) {
  const prefix = 'package_b_conversation_identity:';
  if (!receipt?.source_kind?.startsWith(prefix) || !receipt.conversation_id || !receipt.owner_id
    || !receipt.actor_ref || !receipt.origin_ref || !receipt.causation_id || !receipt.correlation_id) {
    throw coreError('CORE_OPERATION_RECEIPT_INTEGRITY', 'Conversation identity receipt is incomplete');
  }
  return frozen({
    identityRevision: Number(receipt.revision), canonicalConversationKey: receipt.origin_ref,
    identityReceiptId: receipt.journal_event_id, journalSequence: Number(receipt.sequence_no),
    conversationId: receipt.conversation_id, ownerId: receipt.owner_id, actorRef: receipt.actor_ref,
    platform: receipt.source_kind.slice(prefix.length), sourceInstanceId: receipt.causation_id,
    platformConversationBinding: receipt.correlation_id, operationDigest: receipt.source_ref,
    createdAt: receipt.created_at,
  });
}

export function frozen(value) {
  return Object.freeze(value);
}
