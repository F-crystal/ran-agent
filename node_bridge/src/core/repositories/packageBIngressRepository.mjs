import { coreError } from '../coreErrors.mjs';
import { assertKeyedContentHashToken } from '../coreHashToken.mjs';
import {
  assemblyIntentOperationDigest,
  ingressAssemblyProcessingOperationDigest,
  ingressOperationDigest,
} from '../packageB/packageBOperationDigest.mjs';
import {
  appendPackageBReceipt,
  decodePackageBTypedReceipt,
  encodePackageBTypedReceipt,
  assertNonEmptyString,
  assertPackageBOperationKey,
  assertPackageBReceipt,
  findPackageBReceipt,
  findPackageBReceiptByOperationKey,
  frozen,
  packageBReceiptEventId,
  readVerifiedConversationIdentity,
} from './packageBRepositorySupport.mjs';

const RECEIPT_KIND = 'ingress_committed';
const INTENT_KIND = 'assembly_intent';
const PROCESSING_KIND = 'ingress_assembly_processing';
const PART_KINDS = new Set(['text', 'image', 'audio', 'quote', 'edit', 'withdrawal', 'other']);
const REFERENCE_KINDS = new Set(['none', 'explicit', 'deferred', 'quote', 'anchor', 'mutation_target']);
const MUTATION_KINDS = new Set(['create', 'edit', 'withdrawal', 'retry']);
const METADATA_KEYS = new Set(['mediaKind', 'mimeType', 'sizeBytes', 'width', 'height', 'durationMs']);
const INTENT_FIELDS = [
  'ingressEventId', 'ingressResultId', 'ingressDisposition', 'processingOperationKey',
  'conversationId', 'canonicalConversationKey', 'ownerId', 'actorRef',
  'platform', 'sourceInstanceId', 'platformConversationBinding', 'nativeEventId', 'nativeEventIdTrust',
  'partKind', 'sequenceNo', 'payloadRef', 'payloadHashToken', 'payloadSize', 'referenceKind',
  'explicitReference', 'deferredReference', 'targetIngressId', 'targetNativeEventId', 'anchorKind',
  'anchorLang', 'partMetadataCanonical', 'mutationKind', 'mutationTargetIngressId',
  'mutationTargetNativeEventId', 'retryCausation', 'receivedAt', 'vendorEventTime', 'operationKey',
  'causationId', 'correlationId', 'createdAt',
];
const PROCESSING_FIELDS = [
  'conversationId', 'ingressEventId', 'intentId', 'processingRevision', 'expectedState', 'processingState',
  'assemblyId', 'partId', 'operationKey', 'causationId', 'createdAt',
];

function processingScope(ingressEventId) { return `assembly_processing:${ingressEventId}`; }
function intentScope(canonicalConversationKey) { return `assembly_intent:${canonicalConversationKey}`; }

function canonicalMetadata(metadata = {}) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw coreError('CORE_ASSEMBLY_INTENT_METADATA_INVALID', 'assembly intent metadata must be an object');
  }
  const entries = Object.entries(metadata).sort(([left], [right]) => left.localeCompare(right));
  for (const [key, value] of entries) {
    const stringValid = key === 'mimeType'
      ? typeof value === 'string' && /^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/.test(value)
      : key === 'mediaKind' ? typeof value === 'string' && /^[A-Za-z0-9._:-]{1,100}$/.test(value) : true;
    if (!METADATA_KEYS.has(key) || !stringValid || (key !== 'mediaKind' && key !== 'mimeType'
      && (!Number.isSafeInteger(value) || value < 0))) {
      throw coreError('CORE_ASSEMBLY_INTENT_METADATA_INVALID', 'assembly intent metadata contains a non-allowlisted value');
    }
  }
  return JSON.stringify(Object.fromEntries(entries));
}

function assertOpaqueReference(value, field, { nullable = true } = {}) {
  if (value === null || value === undefined) {
    if (nullable) return null;
    throw coreError('CORE_ASSEMBLY_INTENT_REFERENCE_INVALID', `${field} is required`);
  }
  if (typeof value !== 'string' || value.length < 1 || value.length > 500 || /[\s\u0000-\u001f]/.test(value)
    || value.startsWith('/') || value.startsWith('~') || /^file:/i.test(value) || /^[A-Za-z]:[\\/]/.test(value)) {
    throw coreError('CORE_ASSEMBLY_INTENT_REFERENCE_INVALID', `${field} must be an opaque non-content reference`);
  }
  return value;
}

function intentFromReceipt(receipt) {
  const value = decodePackageBTypedReceipt(receipt.source_kind, INTENT_KIND, INTENT_FIELDS);
  assertPackageBReceipt(receipt, assemblyIntentOperationDigest(value), 'assembly intent');
  return frozen({
    ...value,
    partMetadata: JSON.parse(value.partMetadataCanonical),
    resultId: receipt.journal_event_id,
    journalSequence: Number(receipt.sequence_no),
    operationDigest: receipt.source_ref,
  });
}

function processingFromReceipt(receipt) {
  const value = decodePackageBTypedReceipt(receipt.source_kind, PROCESSING_KIND, PROCESSING_FIELDS);
  assertPackageBReceipt(receipt, ingressAssemblyProcessingOperationDigest(value), 'ingress assembly processing');
  return frozen({
    ...value,
    state: value.processingState,
    resultId: receipt.journal_event_id,
    journalSequence: Number(receipt.sequence_no),
    operationDigest: receipt.source_ref,
  });
}

function result(receipt, disposition) {
  return frozen({
    disposition,
    resultId: receipt.journal_event_id,
    journalSequence: Number(receipt.sequence_no),
    ingressEventId: receipt.correlation_id,
    operationDigest: receipt.source_ref,
  });
}

function currentProcessingReceipt(get, ingressEventId) {
  return get(`SELECT * FROM journal_event WHERE event_type=? AND correlation_id=?
    ORDER BY sequence_no DESC LIMIT 1`, `package_b_${PROCESSING_KIND}`, ingressEventId);
}

function currentProcessingResult(get, ingressEventId) {
  const receipt = currentProcessingReceipt(get, ingressEventId);
  return receipt ? processingFromReceipt(receipt) : undefined;
}

function appendProcessingResult(get, run, input) {
  const digest = ingressAssemblyProcessingOperationDigest(input);
  const elsewhere = findPackageBReceiptByOperationKey(get, PROCESSING_KIND, input.operationKey);
  if (elsewhere && elsewhere.correlation_id !== input.ingressEventId) {
    throw coreError('CORE_OPERATION_KEY_CONFLICT', 'processing operation key targets another ingress');
  }
  const prior = findPackageBReceipt(get, PROCESSING_KIND, input.operationKey, processingScope(input.ingressEventId));
  if (prior) {
    assertPackageBReceipt(prior, digest, 'ingress assembly processing');
    return processingFromReceipt(prior);
  }
  const sourceKind = encodePackageBTypedReceipt(PROCESSING_KIND,
    PROCESSING_FIELDS.map((field) => [field, input[field]]));
  const receipt = appendPackageBReceipt(run, get, {
    kind: PROCESSING_KIND, operationKey: input.operationKey,
    operationScope: processingScope(input.ingressEventId), operationDigest: digest,
    resultId: input.ingressEventId, ownerId: input.ownerId, conversationId: input.conversationId,
    actorRef: input.actorRef, revision: input.processingRevision, causationId: input.intentId,
    correlationId: input.ingressEventId, sourceKind, createdAt: input.createdAt,
  });
  return processingFromReceipt(receipt);
}

export function transitionPackageBAssemblyProcessing({ get, run }, input) {
  if (!readVerifiedConversationIdentity(get, input.identity)) {
    throw coreError('CORE_INGRESS_PROCESSING_SCOPE_CONFLICT', 'processing transition requires a verified Conversation identity');
  }
  assertPackageBOperationKey(input.operationKey);
  const intentReceipt = get(`SELECT * FROM journal_event WHERE journal_event_id=? AND event_type=?
    AND conversation_id=? AND correlation_id=?`, input.intentId, `package_b_${INTENT_KIND}`,
  input.identity.conversationId, input.ingressEventId);
  if (!intentReceipt) throw coreError('CORE_INGRESS_PROCESSING_SCOPE_CONFLICT', 'processing intent parent is invalid');
  const prior = findPackageBReceipt(get, PROCESSING_KIND, input.operationKey, processingScope(input.ingressEventId));
  if (prior) {
    const priorValue = decodePackageBTypedReceipt(prior.source_kind, PROCESSING_KIND, PROCESSING_FIELDS);
    const replayDigest = ingressAssemblyProcessingOperationDigest({
      ...priorValue,
      expectedState: input.expectedState,
      processingState: input.nextState,
      assemblyId: input.assemblyId ?? null,
      partId: input.partId ?? null,
      causationId: input.causationId,
      createdAt: input.createdAt,
    });
    assertPackageBReceipt(prior, replayDigest, 'ingress assembly processing');
    return processingFromReceipt(prior);
  }
  const current = currentProcessingResult(get, input.ingressEventId);
  if (!current || current.state !== input.expectedState) {
    throw coreError('CORE_INGRESS_PROCESSING_STALE', 'processing state changed');
  }
  const allowed = current.state === 'pending'
    ? new Set(['assembled', 'deferred', 'rejected', 'terminal'])
    : current.state === 'deferred' ? new Set(['assembled', 'rejected', 'terminal']) : new Set();
  if (!allowed.has(input.nextState)) {
    throw coreError('CORE_INGRESS_PROCESSING_TRANSITION_INVALID', 'processing state transition is invalid');
  }
  if (input.nextState === 'assembled') {
    const part = get(`SELECT part.* FROM turn_assembly_part part JOIN turn_assembly assembly
      ON assembly.turn_assembly_id=part.turn_assembly_id
      WHERE part.turn_assembly_part_id=? AND part.turn_assembly_id=? AND part.ingress_event_id=?
        AND assembly.conversation_id=?`, input.partId, input.assemblyId, input.ingressEventId,
    input.identity.conversationId);
    if (!part) throw coreError('CORE_INGRESS_PROCESSING_SCOPE_CONFLICT', 'assembled processing requires its persisted part');
  }
  return appendProcessingResult(get, run, {
    conversationId: input.identity.conversationId, ingressEventId: input.ingressEventId,
    intentId: input.intentId, processingRevision: current.processingRevision + 1,
    expectedState: input.expectedState, processingState: input.nextState,
    assemblyId: input.assemblyId ?? null, partId: input.partId ?? null,
    operationKey: input.operationKey, causationId: input.causationId,
    createdAt: input.createdAt, ownerId: input.identity.ownerId, actorRef: input.identity.actorRef,
  });
}

export function createPackageBIngressRepository({ get, run }) {
  function commit(input) {
      assertPackageBOperationKey(input.operationKey);
      for (const [field, value] of [
        ['ingressEventId', input.ingressEventId], ['platform', input.platform],
        ['sourceInstanceId', input.sourceInstanceId], ['ownerId', input.ownerId],
        ['actorRef', input.actorRef], ['platformConversationBinding', input.platformConversationBinding],
        ['canonicalConversationKey', input.canonicalConversationKey], ['receivedAt', input.receivedAt],
        ['createdAt', input.createdAt], ['mutationKind', input.mutationKind],
      ]) assertNonEmptyString(value, field);
      assertKeyedContentHashToken(input.payloadHashToken);
      const digest = ingressOperationDigest(input);
      const operationScope = `ingress:${input.canonicalConversationKey}`;
      const priorElsewhere = findPackageBReceiptByOperationKey(get, RECEIPT_KIND, input.operationKey);
      if (priorElsewhere && priorElsewhere.causation_id !== input.canonicalConversationKey) {
        throw coreError('CORE_OPERATION_KEY_CONFLICT', 'ingress operation key targets another Conversation scope');
      }
      const priorOperation = findPackageBReceipt(get, RECEIPT_KIND, input.operationKey, operationScope);
      if (priorOperation) {
        assertPackageBReceipt(priorOperation, digest, 'ingress');
        return result(priorOperation, 'already_applied');
      }

      const nativeEventId = input.nativeEventId ?? null;
      const trusted = input.nativeEventIdTrust === 'trusted';
      const untrusted = input.nativeEventIdTrust === 'untrusted';
      const absent = input.nativeEventIdTrust === 'absent';
      if ((trusted || untrusted) && (typeof nativeEventId !== 'string' || !nativeEventId.trim())) {
        throw coreError('CORE_INGRESS_TRUST_INVALID', 'trusted and untrusted native event IDs require a value');
      }
      if (absent && nativeEventId !== null) {
        throw coreError('CORE_INGRESS_TRUST_INVALID', 'absent native event ID must be null');
      }
      if (!trusted && !untrusted && !absent) {
        throw coreError('CORE_INGRESS_TRUST_INVALID', 'native event ID trust is invalid');
      }

      if (trusted) {
        const existing = get(`SELECT * FROM ingress_event
          WHERE source_instance_id=? AND platform=? AND native_event_id=?
            AND native_event_id_trust='trusted'`,
        input.sourceInstanceId, input.platform, nativeEventId);
        if (existing) {
        const receipt = get(`SELECT * FROM journal_event
            WHERE event_type=? AND correlation_id=?`, `package_b_${RECEIPT_KIND}`, existing.ingress_event_id);
          if (!receipt) throw coreError('CORE_OPERATION_RECEIPT_INTEGRITY', 'trusted ingress receipt is missing');
          const comparable = ingressOperationDigest({ ...input, operationKey: receipt.origin_ref });
          assertPackageBReceipt(receipt, comparable, 'trusted ingress');
          return result(receipt, 'duplicate_native');
        }
      }

      run(`INSERT INTO ingress_event(
        ingress_event_id,source_instance_id,platform,native_event_id,native_event_id_trust,
        idempotency_disposition,conversation_hint,payload_ref,payload_hash_token,state,
        revision,received_at,created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,'received',0,?,?)`,
      input.ingressEventId, input.sourceInstanceId, input.platform, nativeEventId,
      input.nativeEventIdTrust, trusted ? 'native_exact' : 'internal_only',
      input.canonicalConversationKey, input.payloadRef, input.payloadHashToken,
      input.receivedAt, input.createdAt);
      const receipt = appendPackageBReceipt(run, get, {
        kind: RECEIPT_KIND, operationKey: input.operationKey, operationDigest: digest,
        resultId: input.ingressEventId, ownerId: input.ownerId, actorRef: input.actorRef,
        causationId: input.canonicalConversationKey, operationScope, createdAt: input.createdAt,
      });
      return result(receipt, 'applied');
  }

  function appendProcessing(input) {
    return appendProcessingResult(get, run, input);
  }

  function compositeIntentResult(receipt) {
    const intentResult = intentFromReceipt(receipt);
    const ingressReceipt = get('SELECT * FROM journal_event WHERE journal_event_id=?', intentResult.ingressResultId);
    const processingReceipt = get(`SELECT * FROM journal_event WHERE journal_event_id=? AND event_type=?
      AND conversation_id=? AND correlation_id=? AND causation_id=?`,
    packageBReceiptEventId(PROCESSING_KIND, intentResult.processingOperationKey,
      processingScope(intentResult.ingressEventId)),
    `package_b_${PROCESSING_KIND}`, intentResult.conversationId, intentResult.ingressEventId, receipt.journal_event_id);
    if (!ingressReceipt || !processingReceipt) {
      throw coreError('CORE_OPERATION_RECEIPT_INTEGRITY', 'assembly intent first result snapshot is incomplete');
    }
    return frozen({
      ingress: result(ingressReceipt, intentResult.ingressDisposition),
      intent: intentResult,
      processing: processingFromReceipt(processingReceipt),
    });
  }

  return frozen({
    commit,

    commitWithAssemblyIntent({ identity, ingress, intent }) {
      if (!readVerifiedConversationIdentity(get, identity)) {
        throw coreError('CORE_CONVERSATION_IDENTITY_CONFLICT', 'assembly intent requires a verified Conversation identity');
      }
      for (const field of ['ownerId', 'actorRef', 'platform', 'sourceInstanceId', 'platformConversationBinding', 'canonicalConversationKey']) {
        const identityField = field === 'canonicalConversationKey' ? field : field;
        if (ingress[field] !== identity[identityField]) {
          throw coreError('CORE_ASSEMBLY_INTENT_SCOPE_CONFLICT', 'ingress and Conversation identity differ');
        }
      }
      assertPackageBOperationKey(intent.operationKey);
      assertPackageBOperationKey(intent.processingOperationKey);
      if (!PART_KINDS.has(intent.partKind) || !Number.isSafeInteger(intent.sequenceNo) || intent.sequenceNo < 1
        || !Number.isSafeInteger(intent.payloadSize) || intent.payloadSize < 0
        || !REFERENCE_KINDS.has(intent.referenceKind) || !MUTATION_KINDS.has(ingress.mutationKind)) {
        throw coreError('CORE_ASSEMBLY_INTENT_INVALID', 'assembly intent kind, order, size, or reference kind is invalid');
      }
      for (const field of ['causationId', 'correlationId', 'createdAt']) assertNonEmptyString(intent[field], field);
      for (const [field, value] of [
        ['payloadRef', ingress.payloadRef], ['explicitReference', intent.explicitReference],
        ['deferredReference', intent.deferredReference], ['targetIngressId', intent.targetIngressId],
        ['targetNativeEventId', intent.targetNativeEventId], ['mutationTargetIngressId', intent.mutationTargetIngressId],
        ['mutationTargetNativeEventId', ingress.mutationTargetNativeEventId], ['retryCausation', intent.retryCausation ?? ingress.retryOf],
      ]) assertOpaqueReference(value, field);
      if (intent.referenceKind === 'explicit') assertOpaqueReference(intent.explicitReference, 'explicitReference', { nullable: false });
      if (intent.referenceKind === 'deferred') assertOpaqueReference(intent.deferredReference, 'deferredReference', { nullable: false });
      if (intent.anchorKind !== null && intent.anchorKind !== undefined
        && !['quote', 'reply', 'caption', 'thread', 'mutation'].includes(intent.anchorKind)) {
        throw coreError('CORE_ASSEMBLY_INTENT_REFERENCE_INVALID', 'anchorKind is invalid');
      }
      if (intent.anchorLang !== null && intent.anchorLang !== undefined
        && (typeof intent.anchorLang !== 'string' || !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(intent.anchorLang))) {
        throw coreError('CORE_ASSEMBLY_INTENT_REFERENCE_INVALID', 'anchorLang is invalid');
      }
      const partMetadataCanonical = canonicalMetadata(intent.partMetadata);
      const ingressResult = commit(ingress);
      const storedIngress = get('SELECT * FROM ingress_event WHERE ingress_event_id=?', ingressResult.ingressEventId);
      const ingressReceipt = get('SELECT * FROM journal_event WHERE journal_event_id=?', ingressResult.resultId);
      if (!storedIngress || !ingressReceipt || ingressReceipt.correlation_id !== storedIngress.ingress_event_id) {
        throw coreError('CORE_OPERATION_RECEIPT_INTEGRITY', 'assembly intent ingress result is incomplete');
      }
      const value = {
        ingressEventId: storedIngress.ingress_event_id, ingressResultId: ingressReceipt.journal_event_id,
        ingressDisposition: ingressResult.disposition, processingOperationKey: intent.processingOperationKey,
        conversationId: identity.conversationId, canonicalConversationKey: identity.canonicalConversationKey,
        ownerId: identity.ownerId, actorRef: identity.actorRef, platform: identity.platform,
        sourceInstanceId: identity.sourceInstanceId, platformConversationBinding: identity.platformConversationBinding,
        nativeEventId: storedIngress.native_event_id, nativeEventIdTrust: storedIngress.native_event_id_trust,
        partKind: intent.partKind, sequenceNo: intent.sequenceNo, payloadRef: storedIngress.payload_ref,
        payloadHashToken: storedIngress.payload_hash_token, payloadSize: intent.payloadSize,
        referenceKind: intent.referenceKind, explicitReference: intent.explicitReference ?? null,
        deferredReference: intent.deferredReference ?? null, targetIngressId: intent.targetIngressId ?? null,
        targetNativeEventId: intent.targetNativeEventId ?? null, anchorKind: intent.anchorKind ?? null,
        anchorLang: intent.anchorLang ?? null, partMetadataCanonical, mutationKind: ingress.mutationKind,
        mutationTargetIngressId: intent.mutationTargetIngressId ?? null,
        mutationTargetNativeEventId: ingress.mutationTargetNativeEventId ?? null,
        retryCausation: intent.retryCausation ?? ingress.retryOf ?? null, receivedAt: storedIngress.received_at,
        vendorEventTime: ingress.vendorEventTime ?? null, operationKey: intent.operationKey,
        causationId: intent.causationId, correlationId: intent.correlationId, createdAt: intent.createdAt,
      };
      const operationScope = intentScope(identity.canonicalConversationKey);
      const priorElsewhere = findPackageBReceiptByOperationKey(get, INTENT_KIND, intent.operationKey);
      if (priorElsewhere && priorElsewhere.conversation_id !== identity.conversationId) {
        throw coreError('CORE_OPERATION_KEY_CONFLICT', 'assembly intent operation key targets another Conversation');
      }
      const prior = findPackageBReceipt(get, INTENT_KIND, intent.operationKey, operationScope);
      const priorForIngress = get(`SELECT * FROM journal_event WHERE event_type=? AND correlation_id=?`,
        `package_b_${INTENT_KIND}`, storedIngress.ingress_event_id);
      if (prior || priorForIngress) {
        const authoritative = prior || priorForIngress;
        const firstValue = decodePackageBTypedReceipt(authoritative.source_kind, INTENT_KIND, INTENT_FIELDS);
        assertPackageBReceipt(authoritative, assemblyIntentOperationDigest({
          ...value, ingressDisposition: firstValue.ingressDisposition,
        }), 'assembly intent');
        if (authoritative.origin_ref !== intent.operationKey) {
          throw coreError('CORE_OPERATION_KEY_CONFLICT', 'ingress is already bound to another assembly intent');
        }
        return compositeIntentResult(authoritative);
      }
      const digest = assemblyIntentOperationDigest(value);
      const sourceKind = encodePackageBTypedReceipt(INTENT_KIND, INTENT_FIELDS.map((field) => [field, value[field]]));
      const receipt = appendPackageBReceipt(run, get, {
        kind: INTENT_KIND, operationKey: intent.operationKey, operationScope, operationDigest: digest,
        resultId: storedIngress.ingress_event_id, ownerId: identity.ownerId, conversationId: identity.conversationId,
        actorRef: identity.actorRef, causationId: ingressReceipt.journal_event_id,
        correlationId: storedIngress.ingress_event_id, sourceKind, createdAt: intent.createdAt,
      });
      appendProcessing({
        conversationId: identity.conversationId, ingressEventId: storedIngress.ingress_event_id,
        intentId: receipt.journal_event_id, processingRevision: 0, expectedState: null,
        processingState: 'pending', assemblyId: null, partId: null,
        operationKey: intent.processingOperationKey, causationId: receipt.journal_event_id,
        createdAt: intent.createdAt, ownerId: identity.ownerId, actorRef: identity.actorRef,
      });
      return compositeIntentResult(receipt);
    },

    transitionAssemblyProcessing(input) {
      return transitionPackageBAssemblyProcessing({ get, run }, input);
    },
  });
}

export function createPackageBIngressReader({ read, all }) {
  const verifiedIntent = (identity, receipt) => {
    if (!receipt || !readVerifiedConversationIdentity(read, identity, receipt.conversation_id)
      || receipt.owner_id !== identity.ownerId || receipt.actor_ref !== identity.actorRef) return undefined;
    const intent = intentFromReceipt(receipt);
    const ingress = read('SELECT * FROM ingress_event WHERE ingress_event_id=?', intent.ingressEventId);
    const ingressResult = read('SELECT * FROM journal_event WHERE journal_event_id=?', intent.ingressResultId);
    if (intent.canonicalConversationKey !== identity.canonicalConversationKey
      || intent.platform !== identity.platform || intent.sourceInstanceId !== identity.sourceInstanceId
      || intent.platformConversationBinding !== identity.platformConversationBinding
      || receipt.correlation_id !== intent.ingressEventId || receipt.causation_id !== intent.ingressResultId
      || !ingress || !ingressResult || ingressResult.correlation_id !== ingress.ingress_event_id
      || ingress.source_instance_id !== intent.sourceInstanceId || ingress.platform !== intent.platform
      || ingress.native_event_id !== intent.nativeEventId || ingress.native_event_id_trust !== intent.nativeEventIdTrust
      || ingress.payload_ref !== intent.payloadRef || ingress.payload_hash_token !== intent.payloadHashToken
      || ingress.received_at !== intent.receivedAt) return undefined;
    return intent;
  };
  const processingByIngress = (identity, ingressEventId) => {
    if (!readVerifiedConversationIdentity(read, identity)) return undefined;
    const receipt = read(`SELECT * FROM journal_event WHERE event_type=? AND conversation_id=?
      AND correlation_id=? ORDER BY sequence_no DESC LIMIT 1`, `package_b_${PROCESSING_KIND}`,
    identity.conversationId, ingressEventId);
    return receipt ? processingFromReceipt(receipt) : undefined;
  };
  return frozen({
    byId: ({ identity, ingressEventId }) => readVerifiedConversationIdentity(read, identity) && read(`SELECT ingress.* FROM ingress_event ingress
      JOIN journal_event receipt ON receipt.correlation_id=ingress.ingress_event_id
      WHERE ingress.ingress_event_id=? AND receipt.event_type=? AND receipt.owner_id=?
        AND receipt.causation_id=?`, ingressEventId, `package_b_${RECEIPT_KIND}`, identity.ownerId, identity.canonicalConversationKey),
    byTrustedNativeScope: ({ identity, sourceInstanceId, platform, nativeEventId }) => readVerifiedConversationIdentity(read, identity) && read(`SELECT ingress.* FROM ingress_event ingress
      JOIN journal_event receipt ON receipt.correlation_id=ingress.ingress_event_id
      WHERE ingress.source_instance_id=? AND ingress.platform=? AND ingress.native_event_id=?
        AND ingress.native_event_id_trust='trusted' AND receipt.event_type=? AND receipt.owner_id=?
        AND receipt.causation_id=?`, sourceInstanceId, platform, nativeEventId,
    `package_b_${RECEIPT_KIND}`, identity.ownerId, identity.canonicalConversationKey),
    byOperation: ({ identity, operationKey, operationDigest }) => readVerifiedConversationIdentity(read, identity) && read(`SELECT * FROM journal_event
      WHERE journal_event_id=? AND event_type=? AND source_ref=?`,
    packageBReceiptEventId(RECEIPT_KIND, operationKey, `ingress:${identity.canonicalConversationKey}`),
    `package_b_${RECEIPT_KIND}`, operationDigest),
    assemblyIntentByIngress: ({ identity, ingressEventId }) => verifiedIntent(identity, read(`SELECT * FROM journal_event
      WHERE event_type=? AND conversation_id=? AND correlation_id=? ORDER BY sequence_no LIMIT 1`,
    `package_b_${INTENT_KIND}`, identity?.conversationId, ingressEventId)),
    assemblyIntentByOperation: ({ identity, operationKey, operationDigest }) => verifiedIntent(identity, read(`SELECT * FROM journal_event
      WHERE journal_event_id=? AND event_type=? AND conversation_id=? AND source_ref=?`,
    packageBReceiptEventId(INTENT_KIND, operationKey, intentScope(identity?.canonicalConversationKey)),
    `package_b_${INTENT_KIND}`, identity?.conversationId, operationDigest)),
    assemblyProcessingByIngress: ({ identity, ingressEventId }) => processingByIngress(identity, ingressEventId),
    pendingAssemblyWork: ({ identity }) => {
      if (!readVerifiedConversationIdentity(read, identity)) return [];
      return all(`SELECT intent.*, ingress.received_at FROM journal_event intent JOIN ingress_event ingress
        ON ingress.ingress_event_id=intent.correlation_id
        WHERE intent.event_type=? AND intent.conversation_id=?
        ORDER BY ingress.received_at,intent.sequence_no,ingress.ingress_event_id`,
      `package_b_${INTENT_KIND}`, identity.conversationId).flatMap((receipt) => {
        const intent = verifiedIntent(identity, receipt);
        if (!intent) return [];
        const processing = processingByIngress(identity, intent.ingressEventId);
        const parts = all(`SELECT part.* FROM turn_assembly_part part JOIN turn_assembly assembly
          ON assembly.turn_assembly_id=part.turn_assembly_id
          WHERE part.ingress_event_id=? AND assembly.conversation_id=?
          ORDER BY part.created_at,part.turn_assembly_id,part.sequence_no,part.turn_assembly_part_id`,
        intent.ingressEventId, identity.conversationId);
        if (parts.length > 1) {
          throw coreError('CORE_INGRESS_ASSEMBLY_PART_CONFLICT', 'ingress is bound to multiple assembly parts');
        }
        const part = parts[0] ?? null;
        if (processing?.state === 'assembled' && !part) {
          throw coreError('CORE_INGRESS_PROCESSING_INCONSISTENT', 'assembled processing has no persisted part');
        }
        const workDisposition = !processing ? 'processing_missing'
          : processing.state === 'pending' ? (part ? 'part_written_processing_pending' : 'pending_without_part')
            : processing.state === 'deferred' ? 'deferred' : null;
        if (!workDisposition) return [];
        const ingress = read('SELECT * FROM ingress_event WHERE ingress_event_id=?', intent.ingressEventId);
        const ingressResult = read('SELECT * FROM journal_event WHERE journal_event_id=?', intent.ingressResultId);
        return [frozen({ identity, ingress, ingressResult, intent, processing: processing ?? null,
          part, workDisposition })];
      });
    },
  });
}
