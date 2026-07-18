import { coreError } from '../coreErrors.mjs';
import {
  assemblyActivePartSetDigest,
  assemblyLifecycleOperationDigest,
  assemblyPartOperationDigest,
  assemblySealOperationDigest,
} from '../packageB/packageBOperationDigest.mjs';
import {
  appendPackageBReceipt,
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

const PART_KINDS = new Set(['text', 'image', 'audio', 'quote', 'edit', 'withdrawal', 'other']);
const RECEIPT_KINDS = new Set([
  'assembly_created', 'assembly_part_appended', 'assembly_part_superseded', 'assembly_part_withdrawn',
  'assembly_quiet_deadline_updated', 'assembly_sealing_started', 'assembly_sealed',
  'assembly_rejected', 'assembly_interrupted',
]);
const OTHER_METADATA_KEYS = new Set(['mediaKind', 'mimeType', 'sizeBytes']);

function scope(assemblyId) {
  return `assembly:${assemblyId}`;
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
    return assemblyActivePartSetDigest({
      assemblyId: assembly.turn_assembly_id,
      assemblyRevision: expectedRevision,
      parts: parts.map((part) => ({
        sequenceNo: Number(part.sequence_no), ingressEventId: part.ingress_event_id,
        partId: part.turn_assembly_part_id, partKind: part.part_kind, payloadRef: part.payload_ref,
        payloadHashToken: part.payload_hash_token, anchorRef: null, referenceRef: null,
        disposition: part.state,
        ingressIdentity: `${part.source_instance_id}\u0000${part.platform}\u0000${part.native_event_id_trust}\u0000${part.native_event_id ?? ''}`,
        partSemanticDigest: part.part_semantic_digest,
      })),
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

    appendPart(input) {
      assertPackageBOperationKey(input.operationKey);
      assertNonNegativeInteger(input.expectedAssemblyRevision, 'expected assembly revision');
      assertNonNegativeInteger(input.sequenceNo, 'part sequence');
      assertNonNegativeInteger(input.sourceRevision, 'part source revision');
      if (input.sequenceNo < 1 || !PART_KINDS.has(input.partKind)) {
        throw coreError('CORE_ASSEMBLY_PART_INVALID', 'assembly part kind or sequence is invalid');
      }
      validateOtherMetadata(input.partKind, input.otherMetadata);
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
        return frozen({ disposition: 'already_applied', assembly, part, resultId: prior.journal_event_id,
          journalSequence: Number(prior.sequence_no), operationDigest: prior.source_ref });
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
      return frozen({
        disposition: 'applied', resultId: receipt.journal_event_id,
        journalSequence: Number(receipt.sequence_no), operationDigest: receipt.source_ref,
        assembly: get('SELECT * FROM turn_assembly WHERE turn_assembly_id=?', input.assemblyId),
        part: get('SELECT * FROM turn_assembly_part WHERE turn_assembly_part_id=?', input.partId),
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
  const activePartSetDigest = ({ identity, conversationId, assemblyId, expectedRevision }) => {
    if (!readVerifiedConversationIdentity(read, identity, conversationId)) return undefined;
    const assembly = read('SELECT * FROM turn_assembly WHERE turn_assembly_id=? AND conversation_id=?', assemblyId, conversationId);
    if (!assembly) return undefined;
    const parts = all(`SELECT part.*, ingress.source_instance_id, ingress.platform, ingress.native_event_id,
      ingress.native_event_id_trust, ingress.payload_hash_token, receipt.source_ref AS part_semantic_digest
      FROM turn_assembly_part part JOIN ingress_event ingress ON ingress.ingress_event_id=part.ingress_event_id
      JOIN journal_event receipt ON receipt.event_type='package_b_assembly_part_appended' AND receipt.correlation_id=part.turn_assembly_part_id
      WHERE part.turn_assembly_id=? AND part.state='active' ORDER BY part.sequence_no,part.ingress_event_id,part.turn_assembly_part_id`, assemblyId);
    return assemblyActivePartSetDigest({ assemblyId, assemblyRevision: expectedRevision, parts: parts.map((part) => ({
      sequenceNo: Number(part.sequence_no), ingressEventId: part.ingress_event_id, partId: part.turn_assembly_part_id,
      partKind: part.part_kind, payloadRef: part.payload_ref, payloadHashToken: part.payload_hash_token,
      anchorRef: null, referenceRef: null, disposition: part.state,
      ingressIdentity: `${part.source_instance_id}\u0000${part.platform}\u0000${part.native_event_id_trust}\u0000${part.native_event_id ?? ''}`,
      partSemanticDigest: part.part_semantic_digest,
    })) });
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
