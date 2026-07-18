import { coreError } from '../coreErrors.mjs';
import {
  assemblyActivePartSetDigest,
  assemblyPartReferenceOperationDigest,
  assemblyReferenceAwareActivePartSetDigest,
  assemblyLifecycleOperationDigest,
  assemblyPartOperationDigest,
  assemblySealOperationDigest,
} from '../packageB/packageBOperationDigest.mjs';
import {
  appendPackageBReceipt,
  conversationIdentityFromReceipt,
  decodePackageBTypedReceipt,
  encodePackageBTypedReceipt,
  assertNonEmptyString,
  assertNonNegativeInteger,
  assertPackageBOperationKey,
  assertPackageBReceipt,
  findPackageBReceipt,
  findPackageBReceiptByOperationKey,
  frozen,
  packageBReceiptEventId,
  readVerifiedConversationIdentity,
} from './packageBRepositorySupport.mjs';
import { transitionPackageBAssemblyProcessing } from './packageBIngressRepository.mjs';

const PART_KINDS = new Set(['text', 'image', 'audio', 'quote', 'edit', 'withdrawal', 'other']);
const RECEIPT_KINDS = new Set([
  'assembly_created', 'assembly_part_appended', 'assembly_part_superseded', 'assembly_part_withdrawn',
  'assembly_quiet_deadline_updated', 'assembly_sealing_started', 'assembly_sealed',
  'assembly_rejected', 'assembly_interrupted',
]);
const OTHER_METADATA_KEYS = new Set(['mediaKind', 'mimeType', 'sizeBytes']);
const REFERENCE_KIND = 'assembly_part_reference';
const REFERENCE_KINDS = new Set(['explicit', 'deferred', 'quote', 'anchor', 'mutation_target']);
const REFERENCE_STATES = new Set(['unresolved', 'resolved', 'superseded', 'withdrawn']);
const REFERENCE_FIELDS = [
  'conversationId', 'canonicalConversationKey', 'ownerId', 'actorRef', 'platform', 'sourceInstanceId',
  'platformConversationBinding', 'assemblyId', 'partId', 'sourceIngressId', 'referenceRevision',
  'assemblyExpectedRevision', 'assemblyResultRevision', 'expectedState', 'referenceKind', 'referenceState',
  'targetIngressId', 'targetNativeEventId', 'targetNativeEventTrust',
  'targetPartId', 'anchorKind', 'anchorLang', 'operationKey', 'causationId', 'correlationId', 'createdAt',
];

function scope(assemblyId) {
  return `assembly:${assemblyId}`;
}

function referenceScope(assemblyId, partId) { return `assembly_reference:${assemblyId}:${partId}`; }

function referenceFromReceipt(receipt) {
  const value = decodePackageBTypedReceipt(receipt.source_kind, REFERENCE_KIND, REFERENCE_FIELDS);
  assertPackageBReceipt(receipt, assemblyPartReferenceOperationDigest({
    ...value,
    operationKey: value.operationKey,
    sourceIngressId: value.sourceIngressId,
  }), 'assembly part reference');
  return frozen({
    ...value,
    kind: value.referenceKind,
    state: value.referenceState,
    resultId: receipt.journal_event_id,
    journalSequence: Number(receipt.sequence_no),
    operationDigest: receipt.source_ref,
  });
}

function assertReferenceScalar(value, field, { nullable = true } = {}) {
  if (value === null || value === undefined) {
    if (nullable) return;
    throw coreError('CORE_ASSEMBLY_REFERENCE_INVALID', `${field} is required`);
  }
  if (typeof value !== 'string' || value.length < 1 || value.length > 500 || /[\s\u0000-\u001f]/.test(value)
    || value.startsWith('/') || value.startsWith('~') || /^file:/i.test(value) || /^[A-Za-z]:[\\/]/.test(value)) {
    throw coreError('CORE_ASSEMBLY_REFERENCE_INVALID', `${field} must be an opaque non-content reference`);
  }
}

function validateOtherMetadata(partKind, metadata) {
  if (partKind !== 'other') {
    if (metadata !== undefined) throw coreError('CORE_ASSEMBLY_PART_METADATA_INVALID', 'metadata is only accepted for other parts');
    return;
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw coreError('CORE_ASSEMBLY_PART_METADATA_INVALID', 'other part requires typed metadata');
  }
  for (const [key, value] of Object.entries(metadata)) {
    if (!OTHER_METADATA_KEYS.has(key)
      || (key === 'sizeBytes' ? !Number.isSafeInteger(value) || value < 0 : typeof value !== 'string')) {
      throw coreError('CORE_ASSEMBLY_PART_METADATA_INVALID', 'other part metadata contains a non-allowlisted value');
    }
  }
}

function assemblyResult(get, receipt, disposition) {
  const assembly = get('SELECT * FROM turn_assembly WHERE turn_assembly_id=?', receipt.correlation_id);
  if (!assembly) throw coreError('CORE_OPERATION_RECEIPT_INTEGRITY', 'assembly result is missing');
  return frozen({
    disposition,
    resultId: receipt.journal_event_id,
    journalSequence: Number(receipt.sequence_no),
    assemblyId: assembly.turn_assembly_id,
    revision: Number(receipt.revision),
    operationDigest: receipt.source_ref,
  });
}

function partStateResult(get, receipt, disposition) {
  const part = get('SELECT * FROM turn_assembly_part WHERE turn_assembly_part_id=?', receipt.correlation_id);
  if (!part) throw coreError('CORE_OPERATION_RECEIPT_INTEGRITY', 'assembly part state result is missing');
  const assembly = get('SELECT * FROM turn_assembly WHERE turn_assembly_id=?', part.turn_assembly_id);
  if (!assembly) throw coreError('CORE_OPERATION_RECEIPT_INTEGRITY', 'assembly part parent is missing');
  return frozen({ disposition, resultId: receipt.journal_event_id,
    journalSequence: Number(receipt.sequence_no), operationDigest: receipt.source_ref,
    assemblyId: assembly.turn_assembly_id, revision: Number(receipt.revision), assembly, part });
}

function assertOperationScope(get, kind, input, operationScope) {
  const elsewhere = findPackageBReceiptByOperationKey(get, kind, input.operationKey);
  if (elsewhere && elsewhere.correlation_id !== input.assemblyId) {
    const part = get('SELECT turn_assembly_id FROM turn_assembly_part WHERE turn_assembly_part_id=?', elsewhere.correlation_id);
    if (part?.turn_assembly_id !== input.assemblyId) {
      throw coreError('CORE_OPERATION_KEY_CONFLICT', `${kind} operation key targets another assembly`);
    }
  }
  const prior = findPackageBReceipt(get, kind, input.operationKey, operationScope);
  return prior;
}

export function createPackageBAssemblyRepository({ get, all, run }) {
  function currentReference(partId) {
    const receipt = get(`SELECT * FROM journal_event WHERE event_type=? AND correlation_id=?
      ORDER BY sequence_no DESC LIMIT 1`, `package_b_${REFERENCE_KIND}`, partId);
    return receipt ? referenceFromReceipt(receipt) : undefined;
  }

  function validateReferenceTarget(identity, reference) {
    if (!REFERENCE_KINDS.has(reference.kind) || !REFERENCE_STATES.has(reference.state)) {
      throw coreError('CORE_ASSEMBLY_REFERENCE_INVALID', 'reference kind or state is invalid');
    }
    for (const [field, value] of [
      ['targetIngressId', reference.targetIngressId], ['targetNativeEventId', reference.targetNativeEventId],
      ['targetPartId', reference.targetPartId], ['causationId', reference.causationId],
      ['correlationId', reference.correlationId],
    ]) assertReferenceScalar(value, field, { nullable: !['causationId', 'correlationId'].includes(field) });
    if (reference.anchorKind !== null && reference.anchorKind !== undefined
      && !['quote', 'reply', 'caption', 'thread', 'mutation'].includes(reference.anchorKind)) {
      throw coreError('CORE_ASSEMBLY_REFERENCE_INVALID', 'reference anchorKind is invalid');
    }
    if (reference.anchorLang !== null && reference.anchorLang !== undefined
      && (typeof reference.anchorLang !== 'string' || !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(reference.anchorLang))) {
      throw coreError('CORE_ASSEMBLY_REFERENCE_INVALID', 'reference anchorLang is invalid');
    }
    const ingressById = reference.targetIngressId ? get(`SELECT * FROM ingress_event
      WHERE ingress_event_id=? AND conversation_hint=? AND source_instance_id=? AND platform=?`,
    reference.targetIngressId, identity.canonicalConversationKey, identity.sourceInstanceId, identity.platform) : undefined;
    const ingressByNative = reference.targetNativeEventId ? get(`SELECT * FROM ingress_event
      WHERE native_event_id=? AND native_event_id_trust='trusted' AND conversation_hint=?
        AND source_instance_id=? AND platform=?`, reference.targetNativeEventId,
    identity.canonicalConversationKey, identity.sourceInstanceId, identity.platform) : undefined;
    const targetPart = reference.targetPartId ? get(`SELECT part.*, ingress.native_event_id,
        ingress.native_event_id_trust, ingress.source_instance_id, ingress.platform, ingress.conversation_hint
      FROM turn_assembly_part part JOIN turn_assembly assembly
        ON assembly.turn_assembly_id=part.turn_assembly_id
      JOIN ingress_event ingress ON ingress.ingress_event_id=part.ingress_event_id
      WHERE part.turn_assembly_part_id=? AND assembly.conversation_id=?`, reference.targetPartId,
    identity.conversationId) : undefined;

    if (reference.state === 'resolved' && ((!reference.targetIngressId && !reference.targetNativeEventId
      && !reference.targetPartId) || (reference.targetIngressId && !ingressById)
      || (reference.targetNativeEventId && !ingressByNative) || (reference.targetPartId && !targetPart))) {
      throw coreError('CORE_ASSEMBLY_REFERENCE_SCOPE_CONFLICT', 'resolved reference target is missing or outside the trusted Conversation scope');
    }
    const actualTargets = [ingressById?.ingress_event_id, ingressByNative?.ingress_event_id,
      targetPart?.ingress_event_id].filter(Boolean);
    if (new Set(actualTargets).size > 1) {
      throw coreError('CORE_ASSEMBLY_REFERENCE_TARGET_CONFLICT', 'reference target identifiers do not identify one ingress');
    }
    const targetIngress = ingressById ?? ingressByNative
      ?? (targetPart ? get('SELECT * FROM ingress_event WHERE ingress_event_id=?', targetPart.ingress_event_id) : undefined);
    if (targetIngress && (targetIngress.conversation_hint !== identity.canonicalConversationKey
      || targetIngress.source_instance_id !== identity.sourceInstanceId || targetIngress.platform !== identity.platform)) {
      throw coreError('CORE_ASSEMBLY_REFERENCE_SCOPE_CONFLICT', 'reference target is outside the Conversation scope');
    }
    return {
      ...reference,
      targetIngressId: targetIngress?.ingress_event_id ?? reference.targetIngressId ?? null,
      targetNativeEventId: targetIngress?.native_event_id ?? reference.targetNativeEventId ?? null,
      targetNativeEventTrust: targetIngress?.native_event_id_trust
        ?? (reference.targetNativeEventId ? 'trusted' : null),
      targetPartId: reference.targetPartId ?? null,
    };
  }

  function appendReference({ identity, assembly, part, reference, referenceRevision,
    assemblyExpectedRevision, assemblyResultRevision, expectedState }) {
    if (!readVerifiedConversationIdentity(get, identity, assembly.conversation_id)) {
      throw coreError('CORE_ASSEMBLY_REFERENCE_SCOPE_CONFLICT', 'reference requires a verified Conversation identity');
    }
    assertPackageBOperationKey(reference.operationKey);
    for (const field of ['causationId', 'correlationId', 'createdAt']) assertNonEmptyString(reference[field], field);
    const operationScope = referenceScope(assembly.turn_assembly_id, part.turn_assembly_part_id);
    const elsewhere = findPackageBReceiptByOperationKey(get, REFERENCE_KIND, reference.operationKey);
    if (elsewhere && (elsewhere.conversation_id !== identity.conversationId
      || elsewhere.correlation_id !== part.turn_assembly_part_id)) {
      throw coreError('CORE_OPERATION_KEY_CONFLICT', 'reference operation key targets another parent');
    }
    const prior = findPackageBReceipt(get, REFERENCE_KIND, reference.operationKey, operationScope);
    let normalizedReference;
    try {
      normalizedReference = validateReferenceTarget(identity, reference);
    } catch (error) {
      if (prior && error?.code === 'CORE_ASSEMBLY_REFERENCE_TARGET_CONFLICT') {
        throw coreError('CORE_OPERATION_KEY_CONFLICT', 'reference operation key has different target semantics');
      }
      throw error;
    }
    const value = {
      conversationId: identity.conversationId, canonicalConversationKey: identity.canonicalConversationKey,
      ownerId: identity.ownerId, actorRef: identity.actorRef, platform: identity.platform,
      sourceInstanceId: identity.sourceInstanceId,
      platformConversationBinding: identity.platformConversationBinding,
      assemblyId: assembly.turn_assembly_id, partId: part.turn_assembly_part_id,
      sourceIngressId: part.ingress_event_id, referenceRevision, assemblyExpectedRevision,
      assemblyResultRevision, expectedState,
      referenceKind: normalizedReference.kind, referenceState: normalizedReference.state,
      targetIngressId: normalizedReference.targetIngressId,
      targetNativeEventId: normalizedReference.targetNativeEventId,
      targetNativeEventTrust: normalizedReference.targetNativeEventTrust,
      targetPartId: normalizedReference.targetPartId, anchorKind: normalizedReference.anchorKind ?? null,
      anchorLang: normalizedReference.anchorLang ?? null, operationKey: normalizedReference.operationKey,
      causationId: normalizedReference.causationId, correlationId: normalizedReference.correlationId,
      createdAt: normalizedReference.createdAt,
    };
    const digest = assemblyPartReferenceOperationDigest({
      ...value, operationKey: reference.operationKey, sourceIngressId: part.ingress_event_id,
    });
    if (prior) {
      assertPackageBReceipt(prior, digest, 'assembly part reference');
      return referenceFromReceipt(prior);
    }
    const sourceKind = encodePackageBTypedReceipt(REFERENCE_KIND,
      REFERENCE_FIELDS.map((field) => [field, value[field]]));
    const receipt = appendPackageBReceipt(run, get, {
      kind: REFERENCE_KIND, operationKey: reference.operationKey, operationScope,
      operationDigest: digest, resultId: part.turn_assembly_part_id, ownerId: identity.ownerId,
      conversationId: identity.conversationId, actorRef: identity.actorRef, revision: referenceRevision,
      causationId: part.ingress_event_id, correlationId: part.turn_assembly_part_id,
      sourceKind, createdAt: reference.createdAt,
    });
    return referenceFromReceipt(receipt);
  }

  function appendLifecycleReceipt(kind, input, assembly, operationKind, disposition = null) {
    assertPackageBOperationKey(input.operationKey);
    const digest = assemblyLifecycleOperationDigest({
      ...input, operationKind, conversationId: assembly.conversation_id,
      expectedRevision: input.expectedRevision ?? input.expectedAssemblyRevision ?? 0,
      hardDeadline: assembly.hard_deadline, disposition,
    });
    const operationScope = scope(assembly.turn_assembly_id);
    const prior = assertOperationScope(get, kind, input, operationScope);
    if (prior) {
      assertPackageBReceipt(prior, digest, `assembly ${operationKind}`);
      return { prior, digest, operationScope };
    }
    return { prior: null, digest, operationScope };
  }

  function activePartSet(assembly, expectedRevision) {
    const parts = all(`SELECT part.*, ingress.source_instance_id, ingress.platform,
        ingress.native_event_id, ingress.native_event_id_trust, ingress.payload_hash_token,
        receipt.source_ref AS part_semantic_digest
      FROM turn_assembly_part part
      JOIN ingress_event ingress ON ingress.ingress_event_id=part.ingress_event_id
      JOIN journal_event receipt ON receipt.event_type='package_b_assembly_part_appended'
        AND receipt.correlation_id=part.turn_assembly_part_id
      WHERE part.turn_assembly_id=? AND part.state='active'
      ORDER BY part.sequence_no, part.ingress_event_id, part.turn_assembly_part_id`, assembly.turn_assembly_id);
    const mapped = parts.map((part) => {
      const reference = currentReference(part.turn_assembly_part_id);
      return ({
        sequenceNo: Number(part.sequence_no), ingressEventId: part.ingress_event_id,
        partId: part.turn_assembly_part_id, partKind: part.part_kind, payloadRef: part.payload_ref,
        payloadHashToken: part.payload_hash_token, anchorRef: null, referenceRef: null,
        disposition: part.state,
        ingressIdentity: `${part.source_instance_id}\u0000${part.platform}\u0000${part.native_event_id_trust}\u0000${part.native_event_id ?? ''}`,
        partSemanticDigest: part.part_semantic_digest,
        referenceKind: reference?.kind ?? 'none', referenceState: reference?.state ?? 'none',
        targetIngressId: reference?.targetIngressId ?? null,
        targetNativeEventId: reference?.targetNativeEventId ?? null,
        targetNativeEventTrust: reference?.targetNativeEventTrust ?? null,
        targetPartId: reference?.targetPartId ?? null, anchorKind: reference?.anchorKind ?? null,
        anchorLang: reference?.anchorLang ?? null,
        referenceSemanticDigest: reference?.operationDigest ?? null,
      });
    });
    return mapped.some((part) => part.referenceKind !== 'none')
      ? assemblyReferenceAwareActivePartSetDigest({
        assemblyId: assembly.turn_assembly_id, assemblyRevision: expectedRevision, parts: mapped,
      }) : assemblyActivePartSetDigest({
      assemblyId: assembly.turn_assembly_id,
      assemblyRevision: expectedRevision,
      parts: mapped,
    });
  }

  function changePartState(input, state) {
    const assembly = get('SELECT * FROM turn_assembly WHERE turn_assembly_id=?', input.assemblyId);
    if (!assembly) throw coreError('CORE_ASSEMBLY_NOT_OPEN', 'assembly cannot change parts');
    const { prior, digest, operationScope } = appendLifecycleReceipt(
      `assembly_part_${state}`, input, assembly, state, state,
    );
    if (prior) return partStateResult(get, prior, 'already_applied');
    if (!['open', 'sealing'].includes(assembly.state)) throw coreError('CORE_ASSEMBLY_NOT_OPEN', 'assembly cannot change parts');
    const part = get('SELECT * FROM turn_assembly_part WHERE turn_assembly_part_id=? AND turn_assembly_id=?', input.partId, input.assemblyId);
    if (!part) throw coreError('CORE_ASSEMBLY_PART_NOT_FOUND', 'assembly part does not exist');
    const updated = run(`UPDATE turn_assembly SET revision=revision+1,updated_at=?
      WHERE turn_assembly_id=? AND revision=? AND state IN ('open','sealing')`, input.updatedAt,
    input.assemblyId, input.expectedAssemblyRevision);
    if (updated.changes !== 1) return null;
    run(`UPDATE turn_assembly_part SET state=? WHERE turn_assembly_part_id=? AND state='active'`, state, input.partId);
    const receipt = appendPackageBReceipt(run, get, {
      kind: `assembly_part_${state}`, operationKey: input.operationKey, operationScope, operationDigest: digest,
      resultId: input.partId, conversationId: assembly.conversation_id, revision: Number(assembly.revision) + 1,
      causationId: input.partId, createdAt: input.updatedAt,
    });
    return partStateResult(get, receipt, 'applied');
  }

  let appendPartOperation;
  return frozen({
    create(input) {
      for (const [field, value] of [
        ['assemblyId', input.assemblyId], ['conversationId', input.conversationId],
        ['quietDeadline', input.quietDeadline], ['hardDeadline', input.hardDeadline], ['createdAt', input.createdAt],
      ]) assertNonEmptyString(value, field);
      assertPackageBOperationKey(input.operationKey);
      if (input.quietDeadline > input.hardDeadline) {
        throw coreError('CORE_ASSEMBLY_DEADLINE_INVALID', 'quiet deadline cannot exceed hard deadline');
      }
      const existing = get('SELECT * FROM turn_assembly WHERE turn_assembly_id=?', input.assemblyId);
      if (existing) {
        const receipt = findPackageBReceipt(get, 'assembly_created', input.operationKey, scope(input.assemblyId));
        if (!receipt) throw coreError('CORE_OPERATION_KEY_CONFLICT', 'assembly identity is already used');
        const digest = assemblyLifecycleOperationDigest({ ...input, operationKind: 'create', expectedRevision: 0 });
        assertPackageBReceipt(receipt, digest, 'assembly create');
        return assemblyResult(get, receipt, 'already_applied');
      }
      run(`INSERT INTO turn_assembly(
        turn_assembly_id,conversation_id,state,quiet_deadline,hard_deadline,revision,created_at,updated_at,sealed_at
      ) VALUES (?,?,'open',?,?,0,?,?,NULL)`, input.assemblyId, input.conversationId,
      input.quietDeadline, input.hardDeadline, input.createdAt, input.createdAt);
      const assembly = get('SELECT * FROM turn_assembly WHERE turn_assembly_id=?', input.assemblyId);
      const digest = assemblyLifecycleOperationDigest({ ...input, operationKind: 'create', expectedRevision: 0 });
      const receipt = appendPackageBReceipt(run, get, {
        kind: 'assembly_created', operationKey: input.operationKey, operationScope: scope(input.assemblyId),
        operationDigest: digest, resultId: input.assemblyId, conversationId: input.conversationId,
        revision: 0, createdAt: input.createdAt,
      });
      return assemblyResult(get, receipt, 'applied');
    },

    appendPart: (appendPartOperation = (input) => {
      assertPackageBOperationKey(input.operationKey);
      assertNonNegativeInteger(input.expectedAssemblyRevision, 'expected assembly revision');
      assertNonNegativeInteger(input.sequenceNo, 'part sequence');
      assertNonNegativeInteger(input.sourceRevision, 'part source revision');
      if (input.sequenceNo < 1 || !PART_KINDS.has(input.partKind)) {
        throw coreError('CORE_ASSEMBLY_PART_INVALID', 'assembly part kind or sequence is invalid');
      }
      validateOtherMetadata(input.partKind, input.otherMetadata);
      if (input.identity) assertReferenceScalar(input.payloadRef, 'payloadRef', { nullable: false });
      const assembly = get('SELECT * FROM turn_assembly WHERE turn_assembly_id=?', input.assemblyId);
      if (!assembly) throw coreError('CORE_ASSEMBLY_NOT_OPEN', 'assembly cannot accept a new part');
      const ingress = get('SELECT * FROM ingress_event WHERE ingress_event_id=?', input.ingressEventId);
      if (!ingress || ingress.conversation_hint !== assembly.conversation_id) {
        throw coreError('CORE_ASSEMBLY_PARENT_CONFLICT', 'part ingress and assembly Conversation differ');
      }
      const digest = assemblyPartOperationDigest({ ...input, payloadHashToken: ingress.payload_hash_token });
      const prior = assertOperationScope(get, 'assembly_part_appended', input, scope(input.assemblyId));
      if (prior) {
        assertPackageBReceipt(prior, digest, 'assembly part');
        const part = get('SELECT * FROM turn_assembly_part WHERE turn_assembly_part_id=?', prior.correlation_id);
        if (!part) throw coreError('CORE_OPERATION_RECEIPT_INTEGRITY', 'assembly part result is missing');
        const existingReference = currentReference(part.turn_assembly_part_id);
        if (Boolean(input.reference) !== Boolean(existingReference)) {
          throw coreError('CORE_OPERATION_KEY_CONFLICT', 'assembly part replay changes persisted reference semantics');
        }
        const reference = input.reference ? appendReference({
          identity: input.identity, assembly, part,
          reference: input.reference, referenceRevision: 0,
          assemblyExpectedRevision: input.expectedAssemblyRevision,
          assemblyResultRevision: input.expectedAssemblyRevision + 1, expectedState: null,
        }) : undefined;
        return frozen({ disposition: 'already_applied', assembly, part, resultId: prior.journal_event_id,
          journalSequence: Number(prior.sequence_no), operationDigest: prior.source_ref, reference });
      }
      if (assembly.state !== 'open') throw coreError('CORE_ASSEMBLY_NOT_OPEN', 'assembly cannot accept a new part');
      const existing = get(`SELECT * FROM turn_assembly_part
        WHERE turn_assembly_id=? AND ingress_event_id=? AND source_revision=?`,
      input.assemblyId, input.ingressEventId, input.sourceRevision);
      if (existing) throw coreError('CORE_OPERATION_KEY_CONFLICT', 'assembly ingress/source revision is already bound');
      const parent = run(`UPDATE turn_assembly SET revision=revision+1,updated_at=?
        WHERE turn_assembly_id=? AND revision=? AND state='open'`, input.createdAt,
      input.assemblyId, input.expectedAssemblyRevision);
      if (parent.changes !== 1) return null;
      run(`INSERT INTO turn_assembly_part(
        turn_assembly_part_id,turn_assembly_id,ingress_event_id,part_kind,sequence_no,payload_ref,source_revision,state,created_at
      ) VALUES (?,?,?,?,?,?,?,'active',?)`, input.partId, input.assemblyId, input.ingressEventId,
      input.partKind, input.sequenceNo, input.payloadRef, input.sourceRevision, input.createdAt);
      const receipt = appendPackageBReceipt(run, get, {
        kind: 'assembly_part_appended', operationKey: input.operationKey, operationScope: scope(input.assemblyId),
        operationDigest: digest, resultId: input.partId, conversationId: assembly.conversation_id,
        revision: input.sourceRevision, causationId: input.ingressEventId, createdAt: input.createdAt,
      });
      if (input.reference && !['unresolved', 'resolved'].includes(input.reference.state)) {
        throw coreError('CORE_ASSEMBLY_REFERENCE_INVALID', 'initial reference state must be unresolved or resolved');
      }
      const persistedPart = get('SELECT * FROM turn_assembly_part WHERE turn_assembly_part_id=?', input.partId);
      const reference = input.reference ? appendReference({
        identity: input.identity, assembly, part: persistedPart,
        reference: input.reference, referenceRevision: 0,
        assemblyExpectedRevision: input.expectedAssemblyRevision,
        assemblyResultRevision: input.expectedAssemblyRevision + 1, expectedState: null,
      }) : undefined;
      return frozen({
        disposition: 'applied', resultId: receipt.journal_event_id,
        journalSequence: Number(receipt.sequence_no), operationDigest: receipt.source_ref,
        assembly: get('SELECT * FROM turn_assembly WHERE turn_assembly_id=?', input.assemblyId),
        part: persistedPart, reference,
      });
    }),

    appendPartWithProcessing(input) {
      const { processing: processingInput, ...partInput } = input;
      if (!processingInput || !['assembled', 'deferred', 'rejected'].includes(processingInput.nextState)) {
        throw coreError('CORE_INGRESS_PROCESSING_TRANSITION_INVALID', 'composite part processing state is invalid');
      }
      const partResult = appendPartOperation(partInput);
      if (!partResult) return null;
      const processing = transitionPackageBAssemblyProcessing({ get, run }, {
        identity: input.identity, operationKey: processingInput.operationKey,
        ingressEventId: input.ingressEventId, intentId: processingInput.intentId,
        expectedState: processingInput.expectedState, nextState: processingInput.nextState,
        assemblyId: input.assemblyId, partId: input.partId, causationId: partResult.resultId,
        createdAt: processingInput.createdAt,
      });
      const stablePart = frozen({
        disposition: 'applied', resultId: partResult.resultId,
        journalSequence: partResult.journalSequence, operationDigest: partResult.operationDigest,
        assemblyId: input.assemblyId, assemblyRevision: input.expectedAssemblyRevision + 1,
        partId: input.partId, ingressEventId: input.ingressEventId, partKind: input.partKind,
        sequenceNo: input.sequenceNo, sourceRevision: input.sourceRevision, payloadRef: input.payloadRef,
      });
      return frozen({
        disposition: processing.state, resultId: processing.resultId,
        journalSequence: processing.journalSequence, part: stablePart,
        reference: partResult.reference ?? null, processing,
      });
    },

    transitionReference(input) {
      if (!readVerifiedConversationIdentity(get, input.identity)) {
        throw coreError('CORE_ASSEMBLY_REFERENCE_SCOPE_CONFLICT', 'reference transition requires a verified Conversation identity');
      }
      assertPackageBOperationKey(input.operationKey);
      const assembly = get('SELECT * FROM turn_assembly WHERE turn_assembly_id=? AND conversation_id=?',
        input.assemblyId, input.identity.conversationId);
      const part = get('SELECT * FROM turn_assembly_part WHERE turn_assembly_part_id=? AND turn_assembly_id=?',
        input.partId, input.assemblyId);
      if (!assembly || !part) throw coreError('CORE_ASSEMBLY_REFERENCE_SCOPE_CONFLICT', 'reference parent is invalid');
      assertNonNegativeInteger(input.expectedAssemblyRevision, 'expected assembly revision');
      const prior = findPackageBReceipt(get, REFERENCE_KIND, input.operationKey,
        referenceScope(input.assemblyId, input.partId));
      if (prior) {
        const priorValue = referenceFromReceipt(prior);
        return appendReference({
          identity: input.identity, assembly, part,
          reference: {
            operationKey: input.operationKey, kind: priorValue.kind, state: input.nextState,
            targetIngressId: input.targetIngressId ?? priorValue.targetIngressId,
            targetNativeEventId: input.targetNativeEventId ?? priorValue.targetNativeEventId,
            targetPartId: input.targetPartId ?? priorValue.targetPartId,
            anchorKind: input.anchorKind ?? priorValue.anchorKind,
            anchorLang: input.anchorLang ?? priorValue.anchorLang, causationId: input.causationId,
            correlationId: priorValue.correlationId, createdAt: input.createdAt,
          },
          referenceRevision: priorValue.referenceRevision,
          assemblyExpectedRevision: input.expectedAssemblyRevision,
          assemblyResultRevision: input.expectedAssemblyRevision + 1,
          expectedState: input.expectedState,
        });
      }
      if (assembly.state !== 'open') {
        throw coreError('CORE_ASSEMBLY_REFERENCE_TERMINAL', 'reference state is frozen once assembly sealing starts');
      }
      if (Number(assembly.revision) !== input.expectedAssemblyRevision) {
        throw coreError('CORE_ASSEMBLY_REFERENCE_STALE', 'assembly revision changed before reference transition');
      }
      const current = currentReference(input.partId);
      if (!current || current.state !== input.expectedState) {
        throw coreError('CORE_ASSEMBLY_REFERENCE_STALE', 'reference state changed');
      }
      const allowed = current.state === 'unresolved'
        ? new Set(['resolved', 'superseded', 'withdrawn'])
        : current.state === 'resolved' ? new Set(['superseded', 'withdrawn']) : new Set();
      if (!allowed.has(input.nextState)) {
        throw coreError('CORE_ASSEMBLY_REFERENCE_TRANSITION_INVALID', 'reference state transition is invalid');
      }
      const updated = run(`UPDATE turn_assembly SET revision=revision+1,updated_at=?
        WHERE turn_assembly_id=? AND conversation_id=? AND revision=? AND state='open'`,
      input.createdAt, input.assemblyId, input.identity.conversationId, input.expectedAssemblyRevision);
      if (updated.changes !== 1) {
        throw coreError('CORE_ASSEMBLY_REFERENCE_STALE', 'assembly changed before reference transition commit');
      }
      return appendReference({
        identity: input.identity, assembly, part,
        reference: {
          operationKey: input.operationKey, kind: current.kind, state: input.nextState,
          targetIngressId: input.targetIngressId ?? current.targetIngressId,
          targetNativeEventId: input.targetNativeEventId ?? current.targetNativeEventId,
          targetPartId: input.targetPartId ?? current.targetPartId,
          anchorKind: input.anchorKind ?? current.anchorKind, anchorLang: input.anchorLang ?? current.anchorLang,
          causationId: input.causationId, correlationId: current.correlationId, createdAt: input.createdAt,
        },
        referenceRevision: current.referenceRevision + 1,
        assemblyExpectedRevision: input.expectedAssemblyRevision,
        assemblyResultRevision: input.expectedAssemblyRevision + 1,
        expectedState: input.expectedState,
      });
    },

    supersedePart: (input) => changePartState(input, 'superseded'),
    withdrawPart: (input) => changePartState(input, 'withdrawn'),

    updateQuietDeadline(input) {
      assertPackageBOperationKey(input.operationKey);
      const assembly = get('SELECT * FROM turn_assembly WHERE turn_assembly_id=?', input.assemblyId);
      if (!assembly) throw coreError('CORE_ASSEMBLY_NOT_OPEN', 'assembly is not open');
      const { prior, digest, operationScope } = appendLifecycleReceipt('assembly_quiet_deadline_updated', input, assembly, 'quiet_deadline');
      if (prior) return assemblyResult(get, prior, 'already_applied');
      if (assembly.state !== 'open') throw coreError('CORE_ASSEMBLY_NOT_OPEN', 'assembly is not open');
      if (input.quietDeadline < assembly.quiet_deadline || input.quietDeadline > assembly.hard_deadline) {
        throw coreError('CORE_ASSEMBLY_DEADLINE_INVALID', 'quiet deadline must advance without exceeding hard deadline');
      }
      if (Number(assembly.revision) !== input.expectedRevision) return null;
      if (input.quietDeadline === assembly.quiet_deadline) {
        return frozen({ disposition: 'already_current', assemblyId: input.assemblyId, revision: Number(assembly.revision) });
      }
      const updated = run(`UPDATE turn_assembly SET quiet_deadline=?,revision=revision+1,updated_at=?
        WHERE turn_assembly_id=? AND revision=? AND state='open'`, input.quietDeadline, input.updatedAt, input.assemblyId, input.expectedRevision);
      if (updated.changes !== 1) return null;
      const receipt = appendPackageBReceipt(run, get, {
        kind: 'assembly_quiet_deadline_updated', operationKey: input.operationKey, operationScope, operationDigest: digest,
        resultId: input.assemblyId, conversationId: assembly.conversation_id, revision: Number(assembly.revision) + 1, createdAt: input.updatedAt,
      });
      return assemblyResult(get, receipt, 'applied');
    },

    beginSealing(input) {
      const assembly = get('SELECT * FROM turn_assembly WHERE turn_assembly_id=?', input.assemblyId);
      if (!assembly) throw coreError('CORE_ASSEMBLY_NOT_OPEN', 'assembly is not open');
      const { prior, digest, operationScope } = appendLifecycleReceipt('assembly_sealing_started', input, assembly, 'begin_sealing');
      if (prior) return assemblyResult(get, prior, 'already_applied');
      if (assembly.state !== 'open') throw coreError('CORE_ASSEMBLY_NOT_OPEN', 'assembly is not open');
      const updated = run(`UPDATE turn_assembly SET state='sealing',revision=revision+1,updated_at=?
        WHERE turn_assembly_id=? AND revision=? AND state='open'`, input.updatedAt, input.assemblyId, input.expectedRevision);
      if (updated.changes !== 1) return null;
      const receipt = appendPackageBReceipt(run, get, {
        kind: 'assembly_sealing_started', operationKey: input.operationKey, operationScope, operationDigest: digest,
        resultId: input.assemblyId, conversationId: assembly.conversation_id, revision: Number(assembly.revision) + 1, createdAt: input.updatedAt,
      });
      return assemblyResult(get, receipt, 'applied');
    },

    seal(input) {
      assertPackageBOperationKey(input.operationKey);
      const operationScope = scope(input.assemblyId);
      const prior = assertOperationScope(get, 'assembly_sealed', input, operationScope);
      if (prior) {
        const prefix = 'package_b_assembly_sealed:';
        if (!prior.source_kind.startsWith(prefix)) {
          throw coreError('CORE_OPERATION_RECEIPT_INTEGRITY', 'assembly seal receipt lacks its authoritative part digest');
        }
        const activePartSetDigest = prior.source_kind.slice(prefix.length);
        if (input.expectedActivePartSetDigest !== undefined && input.expectedActivePartSetDigest !== activePartSetDigest) {
          throw coreError('CORE_ASSEMBLY_SEAL_DIGEST_CONFLICT', 'expected active part digest differs from the first sealed part set');
        }
        const digest = assemblySealOperationDigest({ ...input, activePartSetDigest });
        assertPackageBReceipt(prior, digest, 'assembly seal');
        return assemblyResult(get, prior, 'already_applied');
      }
      const assembly = get('SELECT * FROM turn_assembly WHERE turn_assembly_id=? AND conversation_id=?', input.assemblyId, input.conversationId);
      if (!assembly) throw coreError('CORE_ASSEMBLY_NOT_FOUND', 'assembly is missing');
      const actualDigest = activePartSet(assembly, input.expectedRevision);
      if (input.expectedActivePartSetDigest !== undefined && input.expectedActivePartSetDigest !== actualDigest) {
        throw coreError('CORE_ASSEMBLY_SEAL_DIGEST_CONFLICT', 'expected active part digest differs from persisted active parts');
      }
      const digest = assemblySealOperationDigest({ ...input, activePartSetDigest: actualDigest });
      if (assembly.state !== 'sealing') throw coreError('CORE_ASSEMBLY_NOT_SEALING', 'assembly must be sealing before seal');
      const updated = run(`UPDATE turn_assembly SET state='sealed',revision=revision+1,sealed_at=?,updated_at=?
        WHERE turn_assembly_id=? AND conversation_id=? AND revision=? AND state='sealing'`, input.sealedAt, input.sealedAt,
      input.assemblyId, input.conversationId, input.expectedRevision);
      if (updated.changes !== 1) return null;
      const receipt = appendPackageBReceipt(run, get, {
        kind: 'assembly_sealed', operationKey: input.operationKey, operationScope, operationDigest: digest,
        resultId: input.assemblyId, conversationId: input.conversationId, revision: input.expectedRevision + 1, createdAt: input.sealedAt,
        sourceKind: `package_b_assembly_sealed:${actualDigest}`,
      });
      return assemblyResult(get, receipt, 'applied');
    },

    reject(input) {
      const assembly = get('SELECT * FROM turn_assembly WHERE turn_assembly_id=?', input.assemblyId);
      if (!assembly) throw coreError('CORE_ASSEMBLY_NOT_OPEN', 'assembly cannot be rejected');
      const { prior, digest, operationScope } = appendLifecycleReceipt('assembly_rejected', input, assembly, 'reject', 'rejected');
      if (prior) return assemblyResult(get, prior, 'already_applied');
      if (!['open', 'sealing'].includes(assembly.state)) throw coreError('CORE_ASSEMBLY_NOT_OPEN', 'assembly cannot be rejected');
      const updated = run(`UPDATE turn_assembly SET state='rejected',revision=revision+1,updated_at=?
        WHERE turn_assembly_id=? AND revision=? AND state IN ('open','sealing')`, input.updatedAt, input.assemblyId, input.expectedRevision);
      if (updated.changes !== 1) return null;
      const receipt = appendPackageBReceipt(run, get, {
        kind: 'assembly_rejected', operationKey: input.operationKey, operationScope, operationDigest: digest,
        resultId: input.assemblyId, conversationId: assembly.conversation_id, revision: Number(assembly.revision) + 1, createdAt: input.updatedAt,
      });
      return assemblyResult(get, receipt, 'applied');
    },

    interrupt(input) {
      const assembly = get('SELECT * FROM turn_assembly WHERE turn_assembly_id=?', input.assemblyId);
      if (!assembly) throw coreError('CORE_ASSEMBLY_NOT_OPEN', 'assembly cannot be interrupted');
      const { prior, digest, operationScope } = appendLifecycleReceipt('assembly_interrupted', input, assembly, 'interrupt', 'interrupted');
      if (prior) return assemblyResult(get, prior, 'already_applied');
      if (!['open', 'sealing'].includes(assembly.state)) throw coreError('CORE_ASSEMBLY_NOT_OPEN', 'assembly cannot be interrupted');
      const updated = run(`UPDATE turn_assembly SET state='rejected',revision=revision+1,updated_at=?
        WHERE turn_assembly_id=? AND revision=? AND state IN ('open','sealing')`, input.updatedAt, input.assemblyId, input.expectedRevision);
      if (updated.changes !== 1) return null;
      const receipt = appendPackageBReceipt(run, get, {
        kind: 'assembly_interrupted', operationKey: input.operationKey, operationScope, operationDigest: digest,
        resultId: input.assemblyId, conversationId: assembly.conversation_id, revision: Number(assembly.revision) + 1, createdAt: input.updatedAt,
      });
      return assemblyResult(get, receipt, 'applied');
    },
  });
}

export function createPackageBAssemblyReader({ read, all }) {
  const uniquePartByIngress = (conversationId, ingressEventId) => {
    const parts = all(`SELECT part.* FROM turn_assembly_part part JOIN turn_assembly assembly
      ON assembly.turn_assembly_id=part.turn_assembly_id
      WHERE part.ingress_event_id=? AND assembly.conversation_id=?
      ORDER BY part.created_at,part.turn_assembly_id,part.sequence_no,part.turn_assembly_part_id`,
    ingressEventId, conversationId);
    if (parts.length > 1) {
      throw coreError('CORE_INGRESS_ASSEMBLY_PART_CONFLICT', 'ingress is bound to multiple assembly parts');
    }
    return parts[0];
  };
  const currentReference = (partId) => {
    const receipt = read(`SELECT * FROM journal_event WHERE event_type=? AND correlation_id=?
      ORDER BY sequence_no DESC LIMIT 1`, `package_b_${REFERENCE_KIND}`, partId);
    return receipt ? referenceFromReceipt(receipt) : undefined;
  };
  const activePartSetDigest = ({ identity, conversationId, assemblyId, expectedRevision }) => {
    if (!readVerifiedConversationIdentity(read, identity, conversationId)) return undefined;
    const assembly = read('SELECT * FROM turn_assembly WHERE turn_assembly_id=? AND conversation_id=?', assemblyId, conversationId);
    if (!assembly) return undefined;
    const parts = all(`SELECT part.*, ingress.source_instance_id, ingress.platform, ingress.native_event_id,
      ingress.native_event_id_trust, ingress.payload_hash_token, receipt.source_ref AS part_semantic_digest
      FROM turn_assembly_part part JOIN ingress_event ingress ON ingress.ingress_event_id=part.ingress_event_id
      JOIN journal_event receipt ON receipt.event_type='package_b_assembly_part_appended' AND receipt.correlation_id=part.turn_assembly_part_id
      WHERE part.turn_assembly_id=? AND part.state='active' ORDER BY part.sequence_no,part.ingress_event_id,part.turn_assembly_part_id`, assemblyId);
    const mapped = parts.map((part) => {
      const reference = currentReference(part.turn_assembly_part_id);
      return {
        sequenceNo: Number(part.sequence_no), ingressEventId: part.ingress_event_id, partId: part.turn_assembly_part_id,
        partKind: part.part_kind, payloadRef: part.payload_ref, payloadHashToken: part.payload_hash_token,
        anchorRef: null, referenceRef: null, disposition: part.state,
        ingressIdentity: `${part.source_instance_id}\u0000${part.platform}\u0000${part.native_event_id_trust}\u0000${part.native_event_id ?? ''}`,
        partSemanticDigest: part.part_semantic_digest,
        referenceKind: reference?.kind ?? 'none', referenceState: reference?.state ?? 'none',
        targetIngressId: reference?.targetIngressId ?? null,
        targetNativeEventId: reference?.targetNativeEventId ?? null,
        targetNativeEventTrust: reference?.targetNativeEventTrust ?? null,
        targetPartId: reference?.targetPartId ?? null, anchorKind: reference?.anchorKind ?? null,
        anchorLang: reference?.anchorLang ?? null, referenceSemanticDigest: reference?.operationDigest ?? null,
      };
    });
    return mapped.some((part) => part.referenceKind !== 'none')
      ? assemblyReferenceAwareActivePartSetDigest({ assemblyId, assemblyRevision: expectedRevision, parts: mapped })
      : assemblyActivePartSetDigest({ assemblyId, assemblyRevision: expectedRevision, parts: mapped });
  };
  return frozen({
    byId: ({ identity, conversationId, assemblyId }) => readVerifiedConversationIdentity(read, identity, conversationId)
      && read(`SELECT * FROM turn_assembly WHERE turn_assembly_id=? AND conversation_id=?`, assemblyId, conversationId),
    parts: ({ identity, conversationId, assemblyId }) => readVerifiedConversationIdentity(read, identity, conversationId) ? all(`SELECT part.* FROM turn_assembly_part part
      JOIN turn_assembly assembly ON assembly.turn_assembly_id=part.turn_assembly_id
      WHERE part.turn_assembly_id=? AND assembly.conversation_id=? ORDER BY part.sequence_no,part.ingress_event_id,part.turn_assembly_part_id`, assemblyId, conversationId) : [],
    dueBefore: ({ identity, conversationId, at }) => readVerifiedConversationIdentity(read, identity, conversationId) ? all(`SELECT * FROM turn_assembly
      WHERE conversation_id=? AND state IN ('open','sealing') AND (quiet_deadline<=? OR hard_deadline<=?)
      ORDER BY hard_deadline,quiet_deadline,turn_assembly_id`, conversationId, at, at) : [],
    openRecent: ({ identity, conversationId, since, at }) => readVerifiedConversationIdentity(read, identity, conversationId) ? all(`SELECT * FROM turn_assembly
      WHERE conversation_id=? AND state='open' AND updated_at>=? AND updated_at<=?
      ORDER BY updated_at DESC,created_at DESC,turn_assembly_id`, conversationId, since, at) : [],
    partByIngress: ({ identity, conversationId, ingressEventId }) => readVerifiedConversationIdentity(read, identity, conversationId)
      ? uniquePartByIngress(conversationId, ingressEventId) : undefined,
    referenceTarget: ({ identity, conversationId, targetIngressId, targetNativeEventId }) => {
      if (!readVerifiedConversationIdentity(read, identity, conversationId)) return undefined;
      const byId = targetIngressId ? read(`SELECT * FROM ingress_event WHERE ingress_event_id=? AND conversation_hint=?
        AND source_instance_id=? AND platform=?`, targetIngressId, identity.canonicalConversationKey,
      identity.sourceInstanceId, identity.platform) : undefined;
      const byNative = targetNativeEventId ? read(`SELECT * FROM ingress_event WHERE native_event_id=? AND native_event_id_trust='trusted'
        AND conversation_hint=? AND source_instance_id=? AND platform=?
        ORDER BY received_at,ingress_event_id LIMIT 1`, targetNativeEventId, identity.canonicalConversationKey,
      identity.sourceInstanceId, identity.platform) : undefined;
      if (targetIngressId && targetNativeEventId && byId?.ingress_event_id !== byNative?.ingress_event_id) return undefined;
      const ingress = byId ?? byNative;
      if (!ingress) return undefined;
      const part = uniquePartByIngress(conversationId, ingress.ingress_event_id);
      return frozen({ ingress, part: part ?? null });
    },
    deferredAssociations: ({ identity, conversationId, assemblyId }) => {
      if (!readVerifiedConversationIdentity(read, identity, conversationId)) return [];
      const receipts = all(`SELECT receipt.* FROM journal_event receipt JOIN turn_assembly_part part
        ON part.turn_assembly_part_id=receipt.correlation_id JOIN turn_assembly assembly
        ON assembly.turn_assembly_id=part.turn_assembly_id
        WHERE receipt.event_type=? AND assembly.conversation_id=?
          AND (? IS NULL OR assembly.turn_assembly_id=?)
        ORDER BY part.sequence_no,part.turn_assembly_part_id,receipt.sequence_no`,
      `package_b_${REFERENCE_KIND}`, conversationId, assemblyId ?? null, assemblyId ?? null);
      const grouped = new Map();
      for (const receipt of receipts) {
        const reference = referenceFromReceipt(receipt);
        if (reference.kind !== 'deferred') continue;
        const history = grouped.get(reference.partId) ?? [];
        history.push(reference);
        grouped.set(reference.partId, history);
      }
      return [...grouped.entries()].map(([partId, history]) => frozen({
        partId, history: Object.freeze(history), current: history.at(-1),
      }));
    },
    dueWork: ({ at, identity } = {}) => {
      const rows = all(`SELECT assembly.*, identity.journal_event_id AS identity_receipt_id
        FROM turn_assembly assembly JOIN journal_event identity
          ON identity.conversation_id=assembly.conversation_id
          AND identity.event_type='package_b_conversation_identity_bound'
        WHERE assembly.state IN ('open','sealing') AND (assembly.quiet_deadline<=? OR assembly.hard_deadline<=?)
        ORDER BY assembly.hard_deadline,assembly.quiet_deadline,assembly.turn_assembly_id`, at, at);
      return rows.flatMap((row) => {
        const receipt = read('SELECT * FROM journal_event WHERE journal_event_id=?', row.identity_receipt_id);
        const storedIdentity = conversationIdentityFromReceipt(receipt);
        if (identity && !readVerifiedConversationIdentity(read, identity, row.conversation_id)) return [];
        const { identity_receipt_id: ignored, ...assembly } = row;
        return [frozen({ identity: storedIdentity, assembly: frozen(assembly) })];
      });
    },
    activePartSetDigest,
    sealReceipt: ({ identity, conversationId, assemblyId, operationKey, operationDigest }) => readVerifiedConversationIdentity(read, identity, conversationId)
      && read(`SELECT * FROM journal_event
      WHERE journal_event_id=? AND event_type=? AND conversation_id=? AND correlation_id=? AND source_ref=?`,
    packageBReceiptEventId('assembly_sealed', operationKey, scope(assemblyId)), 'package_b_assembly_sealed',
    conversationId, assemblyId, operationDigest),
    operationReceipt: ({ identity, conversationId, assemblyId, resultId = assemblyId, kind, operationKey, operationDigest }) => {
      if (!RECEIPT_KINDS.has(kind) || !readVerifiedConversationIdentity(read, identity, conversationId)) return undefined;
      return read(`SELECT * FROM journal_event WHERE journal_event_id=? AND event_type=? AND conversation_id=?
        AND correlation_id=? AND source_ref=?`, packageBReceiptEventId(kind, operationKey, scope(assemblyId)),
      `package_b_${kind}`, conversationId, resultId, operationDigest);
    },
  });
}
