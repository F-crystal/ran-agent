import { coreError } from '../coreErrors.mjs';
import { assertKeyedContentHashToken } from '../coreHashToken.mjs';
import {
  projectorClaimOperationDigest,
  workRunFenceOperationDigest,
} from '../coreOperationDigest.mjs';
import { createPackageBIngressRepository } from './packageBIngressRepository.mjs';
import { createPackageBAssemblyRepository } from './packageBAssemblyRepository.mjs';
import { createPackageBProviderRepository } from './packageBProviderRepository.mjs';
import { createPackageBTurnRepository } from './packageBTurnRepository.mjs';
import { createPackageBPresentationRepositories } from './packageBPresentationRepository.mjs';

function freezeNamespace(methods) {
  return Object.freeze(methods);
}

function assertAuthorityInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw coreError('CORE_AUTHORITY_INTEGER_INVALID', `${field} must be a non-negative safe integer`);
  }
  return value;
}

function assertFenceOperationKey(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 200
    || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw coreError('CORE_FENCE_OPERATION_KEY_INVALID', 'fence rotation operation key is invalid');
  }
  return value;
}

function assertMatchingOperation(prior, digest, label) {
  if (prior.operation_semantic_digest !== digest) {
    throw coreError('CORE_OPERATION_KEY_CONFLICT', `${label} operation key has different semantics`);
  }
}

function workRunRotationResult(prior, disposition) {
  if (!prior.resulting_state || !prior.operation_semantic_digest) {
    throw coreError('CORE_OPERATION_RECEIPT_INTEGRITY', 'Work Run rotation receipt is incomplete');
  }
  return Object.freeze({
    work_run_id: prior.work_run_id,
    state: prior.resulting_state,
    revision: prior.new_revision,
    fence_token: prior.new_fence,
    old_revision: prior.old_revision,
    old_fence: prior.old_fence,
    reason_code: prior.reason_code,
    causation_id: prior.causation_id,
    operation_key: prior.operation_key,
    operation_semantic_digest: prior.operation_semantic_digest,
    committed_at: prior.committed_at,
    disposition,
    audit_id: prior.fence_id,
  });
}

function projectionClaimResult({ get, prior, disposition }) {
  const cursor = get('SELECT * FROM projector_cursor WHERE projector_cursor_id=?', prior.projector_cursor_id);
  const outbox = get('SELECT * FROM projection_outbox WHERE projection_outbox_id=?', prior.claimed_projection_outbox_id);
  if (!cursor || !outbox
    || outbox.source_event_id !== prior.result_source_event_id
    || Number(outbox.source_sequence) !== Number(prior.result_source_sequence)
    || outbox.source_entity_type !== prior.result_source_entity_type
    || outbox.source_entity_id !== prior.result_source_entity_id
    || Number(outbox.source_revision) !== Number(prior.result_source_revision)) {
    throw coreError('CORE_OPERATION_RECEIPT_INTEGRITY', 'projector claim receipt result is missing or inconsistent');
  }
  return Object.freeze({
    disposition,
    operation_semantic_digest: prior.operation_semantic_digest,
    committed_at: prior.committed_at,
    audit_id: prior.fence_id,
    cursor: Object.freeze({
      projector_cursor_id: cursor.projector_cursor_id,
      projector_id: cursor.projector_id,
      target_scope: cursor.target_scope,
      revision: prior.new_revision,
      fence_token: prior.new_fence,
      lease_owner: prior.resulting_lease_owner,
      lease_until: prior.resulting_lease_until,
      fence_reason_code: prior.reason_code,
      fence_causation_id: prior.causation_id,
      fence_operation_key: prior.operation_key,
      fence_operation_digest: prior.operation_semantic_digest,
      fence_result_outbox_id: prior.claimed_projection_outbox_id,
      fence_committed_at: prior.committed_at,
    }),
    outbox: Object.freeze({
      projection_outbox_id: prior.claimed_projection_outbox_id,
      projector_id: outbox.projector_id,
      target_scope: outbox.target_scope,
      source_sequence: prior.result_source_sequence,
      source_event_id: prior.result_source_event_id,
      source_entity_type: prior.result_source_entity_type,
      source_entity_id: prior.result_source_entity_id,
      source_revision: prior.result_source_revision,
      state: prior.resulting_state,
      revision: prior.resulting_outbox_revision,
      fence_token: prior.resulting_outbox_fence,
      lease_owner: prior.resulting_lease_owner,
      lease_until: prior.resulting_lease_until,
    }),
  });
}

export function createCoreTransactionFacade({ assertActive, prepare }) {
  if (typeof assertActive !== 'function' || typeof prepare !== 'function') {
    throw coreError('CORE_TRANSACTION_AUTHORITY_REQUIRED', 'transaction authority is required');
  }

  const statement = (sql) => {
    assertActive();
    return prepare(sql);
  };
  const get = (sql, ...params) => statement(sql).get(...params);
  const run = (sql, ...params) => statement(sql).run(...params);
  const all = (sql, ...params) => statement(sql).all(...params);

  const packageBIngress = createPackageBIngressRepository({ get, run });
  const packageBAssembly = createPackageBAssemblyRepository({ get, all, run });
  const packageBTurn = createPackageBTurnRepository({ get, run });
  const packageBProvider = createPackageBProviderRepository({ get, run });
  const packageBPresentationParts = createPackageBPresentationRepositories({
    get, all, run,
  });
  const packageBFinal = packageBPresentationParts.finalRepository;
  const packageBPresentation = packageBPresentationParts.presentationRepository;

  const journal = freezeNamespace({
    append(input) {
      run(`INSERT INTO journal_event(
        journal_event_id, event_type, owner_id, conversation_id, exchange_id, activity_id,
        actor_ref, origin_ref, source_kind, source_ref, revision, causation_id,
        correlation_id, created_at, invalidated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.eventId, input.eventType, input.ownerId ?? null, input.conversationId ?? null,
      input.exchangeId ?? null, input.activityId ?? null, input.actorRef ?? null,
      input.originRef, input.sourceKind, input.sourceRef, input.revision ?? 0,
      input.causationId ?? null, input.correlationId ?? null, input.createdAt,
      input.invalidatedAt ?? null);
      return get('SELECT * FROM journal_event WHERE journal_event_id=?', input.eventId);
    },
    appendPayload(input) {
      run(`INSERT INTO journal_payload(
        journal_payload_id, journal_event_id, storage_kind, payload_ref,
        content_hash_token, sensitivity, retention_class, expires_at,
        erased_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.payloadId, input.eventId, input.storageKind, input.payloadRef,
      assertKeyedContentHashToken(input.contentHashToken), input.sensitivity,
      input.retentionClass, input.expiresAt ?? null, input.erasedAt ?? null,
      input.createdAt);
      return get('SELECT * FROM journal_payload WHERE journal_payload_id=?', input.payloadId);
    },
  });

  const ingress = freezeNamespace({
    append(input) {
      const nativeId = input.nativeEventId ?? null;
      const validTrusted = input.nativeEventIdTrust === 'trusted'
        && typeof nativeId === 'string' && nativeId.trim().length > 0
        && input.idempotencyDisposition === 'native_exact';
      const validUntrusted = input.nativeEventIdTrust === 'untrusted'
        && typeof nativeId === 'string' && nativeId.trim().length > 0
        && input.idempotencyDisposition === 'internal_only';
      const validAbsent = input.nativeEventIdTrust === 'absent' && nativeId === null
        && input.idempotencyDisposition === 'internal_only';
      if (!validTrusted && !validUntrusted && !validAbsent) {
        throw coreError('CORE_INGRESS_TRUST_INVALID', 'native event ID and trust disposition are inconsistent');
      }
      const params = [
        input.ingressEventId, input.sourceInstanceId, input.platform,
        nativeId, input.nativeEventIdTrust,
        input.idempotencyDisposition, input.conversationHint ?? null,
        input.payloadRef ?? null,
        assertKeyedContentHashToken(input.payloadHashToken ?? null, { nullable: true }),
        input.state ?? 'received', input.revision ?? 0,
        input.receivedAt, input.createdAt,
      ];
      if (input.nativeEventIdTrust === 'trusted') {
        run(`INSERT OR IGNORE INTO ingress_event(
          ingress_event_id, source_instance_id, platform, native_event_id,
          native_event_id_trust, idempotency_disposition, conversation_hint,
          payload_ref, payload_hash_token, state, revision, received_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, ...params);
        const existing = get(`SELECT * FROM ingress_event
          WHERE source_instance_id=? AND platform=? AND native_event_id=?
            AND native_event_id_trust='trusted'`,
        input.sourceInstanceId, input.platform, input.nativeEventId);
        if (!existing) throw coreError('CORE_INGRESS_IDEMPOTENCY_FAILED', 'trusted ingress event was not persisted');
        return Object.freeze({ row: existing, disposition: existing.ingress_event_id === input.ingressEventId ? 'inserted' : 'duplicate' });
      }
      run(`INSERT INTO ingress_event(
        ingress_event_id, source_instance_id, platform, native_event_id,
        native_event_id_trust, idempotency_disposition, conversation_hint,
        payload_ref, payload_hash_token, state, revision, received_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, ...params);
      return Object.freeze({ row: get('SELECT * FROM ingress_event WHERE ingress_event_id=?', input.ingressEventId), disposition: 'inserted' });
    },
  });

  const tombstones = freezeNamespace({
    append(input) {
      run(`INSERT INTO payload_tombstone(
        tombstone_id, subject_type, subject_id, subject_revision,
        supersedes_tombstone_id, reason_code, source_event_id, source_revision,
        causation_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.tombstoneId, input.subjectType, input.subjectId, input.subjectRevision,
      input.supersedesTombstoneId ?? null, input.reasonCode, input.sourceEventId,
      input.sourceRevision, input.causationId, input.createdAt);
      return get('SELECT * FROM payload_tombstone WHERE tombstone_id=?', input.tombstoneId);
    },
  });

  const publications = freezeNamespace({
    append(input) {
      run(`INSERT INTO publication_ledger(
        publication_id, operation_scope, operation_key, subject_type, subject_id,
        subject_revision, target, disposition, source_event_id, source_revision,
        causation_id, receipt_ref, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.publicationId, input.operationScope, input.operationKey,
      input.subjectType, input.subjectId, input.subjectRevision, input.target,
      input.disposition, input.sourceEventId, input.sourceRevision,
      input.causationId, input.receiptRef ?? null, input.createdAt);
      return get('SELECT * FROM publication_ledger WHERE publication_id=?', input.publicationId);
    },
  });

  const effects = freezeNamespace({
    appendEvidenceReceipt(input) {
      run(`INSERT INTO effect_receipt(
        effect_receipt_id, effect_attempt_id, outcome, evidence_type, issuer_ref,
        operation_digest, receipt_ref, content_hash_token, source_event_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.receiptId, input.effectAttemptId, input.outcome, input.evidenceType,
      input.issuerRef, input.operationDigest, input.receiptRef,
      assertKeyedContentHashToken(input.contentHashToken), input.sourceEventId, input.createdAt);
      return get('SELECT * FROM effect_receipt WHERE effect_receipt_id=?', input.receiptId);
    },
  });

  const projections = freezeNamespace({
    createCursor(input) {
      run(`INSERT OR IGNORE INTO projector_cursor(
        projector_cursor_id, projector_id, target_scope, committed_source_sequence,
        revision, fence_token, created_at, updated_at
      ) VALUES (?, ?, ?, NULL, 0, 0, ?, ?)`,
      input.cursorId, input.projectorId, input.targetScope, input.createdAt, input.createdAt);
      const cursor = get('SELECT * FROM projector_cursor WHERE projector_id=? AND target_scope=?', input.projectorId, input.targetScope);
      if (cursor.projector_cursor_id !== input.cursorId && input.requireNew) {
        throw coreError('CORE_CURSOR_SCOPE_CONFLICT', 'projector cursor scope already exists');
      }
      return cursor;
    },

    reserve(input) {
      const source = get('SELECT sequence_no, revision FROM journal_event WHERE journal_event_id=?', input.sourceEventId);
      if (!source || Number(source.revision) !== input.sourceRevision) {
        throw coreError('CORE_PROJECTION_SOURCE_STALE', 'projection source event revision is missing or stale');
      }
      run(`INSERT OR IGNORE INTO projection_outbox(
        projection_outbox_id, operation_scope, operation_key, projector_id,
        target_scope, source_sequence, source_event_id, source_entity_type,
        source_entity_id, source_revision, payload_ref, state, revision,
        attempt_count, fence_token, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, 0, 0, ?, ?)`,
      input.outboxId, input.operationScope, input.operationKey, input.projectorId,
      input.targetScope, source.sequence_no, input.sourceEventId,
      input.sourceEntityType ?? 'journal_event',
      input.sourceEntityId ?? input.sourceEventId, input.sourceRevision,
      input.payloadRef ?? null, input.createdAt, input.createdAt);
      const existing = get('SELECT * FROM projection_outbox WHERE operation_scope=? AND operation_key=?', input.operationScope, input.operationKey);
      if (!existing || existing.projector_id !== input.projectorId
        || existing.target_scope !== input.targetScope
        || existing.source_event_id !== input.sourceEventId
        || existing.source_entity_type !== (input.sourceEntityType ?? 'journal_event')
        || existing.source_entity_id !== (input.sourceEntityId ?? input.sourceEventId)
        || Number(existing.source_revision) !== input.sourceRevision
        || existing.payload_ref !== (input.payloadRef ?? null)) {
        throw coreError('CORE_OPERATION_KEY_CONFLICT', 'projection operation key has different content or scope');
      }
      return existing;
    },

    claim(input) {
      const operationKey = assertFenceOperationKey(input.rotationOperationKey);
      assertAuthorityInteger(input.expectedCursorRevision, 'expected cursor revision');
      assertAuthorityInteger(input.expectedCursorFence, 'expected cursor fence');
      assertAuthorityInteger(input.expectedOutboxRevision, 'expected outbox revision');
      const cursor = get('SELECT * FROM projector_cursor WHERE projector_cursor_id=?', input.cursorId);
      const requestedOutbox = get('SELECT * FROM projection_outbox WHERE projection_outbox_id=?', input.outboxId);
      const prior = get(`SELECT * FROM fence
        WHERE domain='projector_cursor' AND projector_cursor_id=? AND operation_key=?`,
      input.cursorId, operationKey);
      if (!cursor || !requestedOutbox) {
        if (prior) throw coreError('CORE_OPERATION_KEY_CONFLICT', 'projector claim target differs from the committed operation');
        return null;
      }
      const operationDigest = projectorClaimOperationDigest(input, { cursor, outbox: requestedOutbox });
      if (prior) {
        assertMatchingOperation(prior, operationDigest, 'projector claim');
        return projectionClaimResult({ get, prior, disposition: 'already_applied' });
      }
      const cursorUpdate = run(`UPDATE projector_cursor
        SET lease_owner=?, lease_until=?, fence_token=fence_token+1,
            revision=revision+1, fence_reason_code='projection_claim',
            fence_causation_id=(
              SELECT source_event_id FROM projection_outbox WHERE projection_outbox_id=?
            ),
            fence_operation_key=?, fence_operation_digest=?, fence_result_outbox_id=?,
            fence_committed_at=?, updated_at=?
        WHERE projector_cursor_id=? AND revision=? AND fence_token=?
          AND lease_owner IS NULL AND lease_until IS NULL`,
      input.leaseOwner, input.leaseUntil, input.outboxId,
      operationKey, operationDigest, input.outboxId, input.updatedAt, input.updatedAt, input.cursorId,
      input.expectedCursorRevision, input.expectedCursorFence);
      if (cursorUpdate.changes !== 1) return null;
      const updatedCursor = get('SELECT * FROM projector_cursor WHERE projector_cursor_id=?', input.cursorId);
      const outboxUpdate = run(`UPDATE projection_outbox
        SET state='reserved', lease_owner=?, lease_until=?, fence_token=?,
            revision=revision+1, updated_at=?
        WHERE projection_outbox_id=? AND projector_id=? AND target_scope=?
          AND state IN ('pending','failed') AND revision=?`,
      input.leaseOwner, input.leaseUntil, BigInt(updatedCursor.fence_token), input.updatedAt,
      input.outboxId, updatedCursor.projector_id, updatedCursor.target_scope, input.expectedOutboxRevision);
      if (outboxUpdate.changes !== 1) {
        throw coreError('CORE_PROJECTION_RESERVATION_STALE', 'projection reservation became stale');
      }
      const audit = get(`SELECT * FROM fence
        WHERE domain='projector_cursor' AND projector_cursor_id=? AND operation_key=?`,
      input.cursorId, operationKey);
      if (!audit) throw coreError('CORE_OPERATION_RECEIPT_INTEGRITY', 'projector claim receipt was not committed');
      return projectionClaimResult({ get, prior: audit, disposition: 'applied' });
    },

    recordFailure(input) {
      const outbox = get('SELECT * FROM projection_outbox WHERE projection_outbox_id=?', input.outboxId);
      if (!outbox || outbox.state !== 'reserved' || outbox.lease_owner !== input.leaseOwner
        || Number(outbox.fence_token) !== input.fenceToken || Number(outbox.revision) !== input.expectedOutboxRevision) {
        return null;
      }
      const cursorUpdate = run(`UPDATE projector_cursor
        SET lease_owner=NULL, lease_until=NULL, revision=revision+1, updated_at=?
        WHERE projector_cursor_id=? AND revision=? AND fence_token=? AND lease_owner=?`,
      input.updatedAt, input.cursorId, input.expectedCursorRevision,
      input.fenceToken, input.leaseOwner);
      if (cursorUpdate.changes !== 1) return null;
      run(`UPDATE projection_outbox
        SET state='failed', lease_owner=NULL, lease_until=NULL,
            attempt_count=attempt_count+1, revision=revision+1,
            next_attempt_at=?, updated_at=?
        WHERE projection_outbox_id=? AND revision=? AND fence_token=? AND lease_owner=?`,
      input.nextAttemptAt ?? null, input.updatedAt, input.outboxId,
      input.expectedOutboxRevision, input.fenceToken, input.leaseOwner);
      return get('SELECT * FROM projector_cursor WHERE projector_cursor_id=?', input.cursorId);
    },

    commitCursor(input) {
      const cursor = get('SELECT * FROM projector_cursor WHERE projector_cursor_id=?', input.cursorId);
      const outbox = get('SELECT * FROM projection_outbox WHERE projection_outbox_id=?', input.outboxId);
      if (!cursor || !outbox) return null;
      if (outbox.state === 'completed'
        && Number(cursor.committed_source_sequence) === Number(outbox.source_sequence)) {
        return Object.freeze({ disposition: 'already_committed', cursor, outbox });
      }
      if (outbox.state !== 'reserved' || outbox.lease_owner !== input.leaseOwner
        || Number(outbox.fence_token) !== input.fenceToken
        || Number(outbox.revision) !== input.expectedOutboxRevision
        || cursor.lease_owner !== input.leaseOwner
        || Number(cursor.fence_token) !== input.fenceToken
        || Number(cursor.revision) !== input.expectedCursorRevision) return null;
      if (cursor.committed_source_sequence !== null
        && Number(outbox.source_sequence) < Number(cursor.committed_source_sequence)) {
        throw coreError('CORE_CURSOR_REGRESSION', 'projector cursor cannot move backwards');
      }
      const source = get(`SELECT sequence_no, revision, invalidated_at FROM journal_event
        WHERE journal_event_id=? AND sequence_no=?`, outbox.source_event_id, outbox.source_sequence);
      const tombstone = get(`SELECT tombstone_id FROM payload_tombstone
        WHERE subject_type=? AND subject_id=?
        ORDER BY created_at DESC LIMIT 1`,
      outbox.source_entity_type, outbox.source_entity_id);
      if (!source || Number(source.revision) !== Number(outbox.source_revision)
        || source.invalidated_at !== null || tombstone) {
        const cursorRelease = run(`UPDATE projector_cursor
          SET lease_owner=NULL, lease_until=NULL, revision=revision+1, updated_at=?
          WHERE projector_cursor_id=? AND revision=? AND fence_token=? AND lease_owner=?`,
        input.updatedAt, input.cursorId, input.expectedCursorRevision,
        input.fenceToken, input.leaseOwner);
        if (cursorRelease.changes !== 1) return null;
        const staleUpdate = run(`UPDATE projection_outbox
          SET state='stale', lease_owner=NULL, lease_until=NULL,
              revision=revision+1, updated_at=?
          WHERE projection_outbox_id=? AND revision=? AND fence_token=? AND lease_owner=?`,
        input.updatedAt, input.outboxId, input.expectedOutboxRevision,
        input.fenceToken, input.leaseOwner);
        if (staleUpdate.changes !== 1) {
          throw coreError('CORE_PROJECTION_RESERVATION_STALE', 'stale source disposition lost its reservation');
        }
        return Object.freeze({
          disposition: 'stale_source',
          cursor: get('SELECT * FROM projector_cursor WHERE projector_cursor_id=?', input.cursorId),
          outbox: get('SELECT * FROM projection_outbox WHERE projection_outbox_id=?', input.outboxId),
        });
      }
      const cursorUpdate = run(`UPDATE projector_cursor
        SET committed_source_sequence=?, lease_owner=NULL, lease_until=NULL,
            revision=revision+1, updated_at=?
        WHERE projector_cursor_id=? AND revision=? AND fence_token=? AND lease_owner=?`,
      outbox.source_sequence, input.updatedAt, input.cursorId,
      input.expectedCursorRevision, input.fenceToken, input.leaseOwner);
      if (cursorUpdate.changes !== 1) return null;
      const outboxUpdate = run(`UPDATE projection_outbox
        SET state='completed', lease_owner=NULL, lease_until=NULL,
            attempt_count=attempt_count+1, revision=revision+1, updated_at=?
        WHERE projection_outbox_id=? AND revision=? AND fence_token=? AND lease_owner=?`,
      input.updatedAt, input.outboxId, input.expectedOutboxRevision,
      input.fenceToken, input.leaseOwner);
      if (outboxUpdate.changes !== 1) throw coreError('CORE_PROJECTION_RESERVATION_STALE', 'projection completion became stale');
      return Object.freeze({
        disposition: 'committed',
        cursor: get('SELECT * FROM projector_cursor WHERE projector_cursor_id=?', input.cursorId),
        outbox: get('SELECT * FROM projection_outbox WHERE projection_outbox_id=?', input.outboxId),
      });
    },
  });

  const revisions = freezeNamespace({
    compareAndSetWorkRunState(input) {
      const result = run(`UPDATE work_run
        SET state=?, revision=revision+1, updated_at=?
        WHERE work_run_id=? AND revision=? AND fence_token=?`,
      input.nextState, input.updatedAt, input.workRunId,
      input.expectedRevision, input.expectedFence);
      return result.changes === 1
        ? get('SELECT * FROM work_run WHERE work_run_id=?', input.workRunId)
        : null;
    },
    rotateWorkRunFence(input) {
      const operationKey = assertFenceOperationKey(input.rotationOperationKey);
      assertAuthorityInteger(input.expectedRevision, 'expected Work Run revision');
      assertAuthorityInteger(input.expectedFence, 'expected Work Run fence');
      assertAuthorityInteger(input.nextFence, 'next Work Run fence');
      if (input.nextFence !== input.expectedFence + 1) {
        throw coreError('CORE_FENCE_STEP_INVALID', 'new Work Run fence must equal the previous fence plus one');
      }
      const operationDigest = workRunFenceOperationDigest(input);
      const prior = get(`SELECT * FROM fence
        WHERE domain='work_run' AND work_run_id=? AND operation_key=?`,
      input.workRunId, operationKey);
      if (prior) {
        assertMatchingOperation(prior, operationDigest, 'Work Run fence rotation');
        return workRunRotationResult(prior, 'already_applied');
      }
      const result = run(`UPDATE work_run
        SET state=?, revision=revision+1, fence_token=?,
            fence_reason_code=?, fence_causation_id=?,
            fence_operation_key=?, fence_operation_digest=?, fence_committed_at=?, updated_at=?
        WHERE work_run_id=? AND revision=? AND fence_token=?`,
      input.nextState, BigInt(input.nextFence), input.reasonCode,
      input.sourceEventId, operationKey, operationDigest, input.updatedAt, input.updatedAt, input.workRunId,
      input.expectedRevision, input.expectedFence);
      if (result.changes !== 1) return null;
      const audit = get(`SELECT * FROM fence
        WHERE domain='work_run' AND work_run_id=? AND operation_key=?`,
      input.workRunId, operationKey);
      if (!audit) throw coreError('CORE_OPERATION_RECEIPT_INTEGRITY', 'Work Run rotation receipt was not committed');
      return workRunRotationResult(audit, 'applied');
    },
  });

  const soul = freezeNamespace({
    createIdentity(input) {
      run(`INSERT INTO living_identity(
        identity_id, owner_id, name, state, revision, created_at, updated_at
      ) VALUES (?, ?, ?, 'active', 0, ?, ?)`,
      input.identityId, input.ownerId, input.name, input.createdAt, input.createdAt);
      return get('SELECT * FROM living_identity WHERE identity_id=?', input.identityId);
    },
    createDraft(input) {
      run(`INSERT INTO soul_revision(
        soul_revision_id, identity_id, parent_revision_id, state, content_ref,
        content_hash, compiler_version, revision, state_revision,
        state_causation_event_id, created_at
      ) VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, 0, ?, ?)`,
      input.soulRevisionId, input.identityId, input.parentRevisionId ?? null,
      input.contentRef, input.contentHash, input.compilerVersion ?? null,
      input.revision, input.causationEventId, input.createdAt);
      return get('SELECT * FROM soul_revision WHERE soul_revision_id=?', input.soulRevisionId);
    },
    validate(input) {
      const result = run(`UPDATE soul_revision
        SET state='validated', state_revision=state_revision+1,
            state_causation_event_id=?, validated_at=?
        WHERE soul_revision_id=? AND identity_id=? AND state='draft' AND state_revision=?`,
      input.causationEventId, input.validatedAt, input.soulRevisionId,
      input.identityId, input.expectedStateRevision);
      return result.changes === 1 ? get('SELECT * FROM soul_revision WHERE soul_revision_id=?', input.soulRevisionId) : null;
    },
    beginActivation(input) {
      const result = run(`UPDATE soul_revision
        SET state='activating', state_revision=state_revision+1,
            state_causation_event_id=?
        WHERE soul_revision_id=? AND identity_id=? AND state='validated' AND state_revision=?`,
      input.causationEventId, input.soulRevisionId, input.identityId,
      input.expectedStateRevision);
      return result.changes === 1 ? get('SELECT * FROM soul_revision WHERE soul_revision_id=?', input.soulRevisionId) : null;
    },
    returnActivationToValidated(input) {
      const result = run(`UPDATE soul_revision
        SET state='validated', activation_receipt_id=NULL,
            state_revision=state_revision+1, state_causation_event_id=?
        WHERE soul_revision_id=? AND identity_id=? AND state='activating' AND state_revision=?`,
      input.causationEventId, input.soulRevisionId, input.identityId,
      input.expectedStateRevision);
      return result.changes === 1 ? get('SELECT * FROM soul_revision WHERE soul_revision_id=?', input.soulRevisionId) : null;
    },
    appendActivationReceipt(input) {
      run(`INSERT INTO soul_change_receipt(
        soul_change_receipt_id, identity_id, trigger_event_id, old_soul_revision_id,
        new_soul_revision_id, expected_hash, actual_hash, outcome,
        invalidates_receipt_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.receiptId, input.identityId, input.triggerEventId,
      input.oldSoulRevisionId ?? null, input.newSoulRevisionId,
      input.expectedHash, input.actualHash, input.outcome,
      input.invalidatesReceiptId ?? null, input.createdAt);
      return get('SELECT * FROM soul_change_receipt WHERE soul_change_receipt_id=?', input.receiptId);
    },
    activateWithReceipt(input) {
      const identity = get('SELECT * FROM living_identity WHERE identity_id=?', input.identityId);
      if (!identity || Number(identity.revision) !== input.expectedIdentityRevision
        || (identity.active_soul_revision_id ?? null) !== (input.oldSoulRevisionId ?? null)) return null;
      if (input.oldSoulRevisionId) {
        const oldUpdate = run(`UPDATE soul_revision
          SET state='superseded', state_revision=state_revision+1,
              state_causation_event_id=?, superseded_at=?,
              active_pointer_identity_id=NULL, active_pointer_soul_revision_id=NULL
          WHERE soul_revision_id=? AND identity_id=? AND state='active'`,
        input.causationEventId, input.activatedAt, input.oldSoulRevisionId, input.identityId);
        if (oldUpdate.changes !== 1) return null;
      }
      const revisionUpdate = run(`UPDATE soul_revision
        SET state='active', activation_receipt_id=?, state_revision=state_revision+1,
            state_causation_event_id=?, activated_at=?,
            active_pointer_identity_id=?, active_pointer_soul_revision_id=?
        WHERE soul_revision_id=? AND identity_id=? AND state='activating'
          AND state_revision=?`,
      input.receiptId, input.causationEventId, input.activatedAt,
      input.identityId, input.soulRevisionId,
      input.soulRevisionId, input.identityId, input.expectedSoulStateRevision);
      if (revisionUpdate.changes !== 1) {
        throw coreError('CORE_SOUL_ACTIVATION_STALE', 'Soul activation became stale after supersede preparation');
      }
      const pointerUpdate = run(`UPDATE living_identity
        SET active_soul_revision_id=?, revision=revision+1, updated_at=?
        WHERE identity_id=? AND revision=?`,
      input.soulRevisionId, input.activatedAt, input.identityId,
      input.expectedIdentityRevision);
      if (pointerUpdate.changes !== 1) throw coreError('CORE_SOUL_POINTER_STALE', 'Living Soul active pointer became stale');
      return Object.freeze({
        identity: get('SELECT * FROM living_identity WHERE identity_id=?', input.identityId),
        revision: get('SELECT * FROM soul_revision WHERE soul_revision_id=?', input.soulRevisionId),
      });
    },
    revokeActive(input) {
      const identity = get('SELECT * FROM living_identity WHERE identity_id=?', input.identityId);
      const revision = get('SELECT * FROM soul_revision WHERE soul_revision_id=? AND identity_id=?', input.soulRevisionId, input.identityId);
      if (!identity || !revision
        || Number(identity.revision) !== input.expectedIdentityRevision
        || identity.active_soul_revision_id !== input.soulRevisionId
        || revision.state !== 'active'
        || Number(revision.state_revision) !== input.expectedSoulStateRevision) {
        throw coreError('CORE_SOUL_REVOKE_STALE', 'active Soul revoke preconditions are stale');
      }
      const revisionUpdate = run(`UPDATE soul_revision
        SET state='revoked', state_revision=state_revision+1,
            state_causation_event_id=?, revoked_at=?,
            active_pointer_identity_id=NULL, active_pointer_soul_revision_id=NULL
        WHERE soul_revision_id=? AND identity_id=? AND state='active' AND state_revision=?`,
      input.causationEventId, input.revokedAt, input.soulRevisionId,
      input.identityId, input.expectedSoulStateRevision);
      if (revisionUpdate.changes !== 1) throw coreError('CORE_SOUL_REVOKE_STALE', 'active Soul revision changed during revoke');
      const pointerUpdate = run(`UPDATE living_identity
        SET active_soul_revision_id=NULL, revision=revision+1, updated_at=?
        WHERE identity_id=? AND revision=? AND active_soul_revision_id=?`,
      input.revokedAt, input.identityId, input.expectedIdentityRevision, input.soulRevisionId);
      if (pointerUpdate.changes !== 1) throw coreError('CORE_SOUL_REVOKE_STALE', 'Living Soul pointer changed during revoke');
      return Object.freeze({
        identity: get('SELECT * FROM living_identity WHERE identity_id=?', input.identityId),
        revision: get('SELECT * FROM soul_revision WHERE soul_revision_id=?', input.soulRevisionId),
      });
    },
  });

  return Object.freeze({
    journal, ingress, tombstones, publications, effects, projections, revisions, soul,
    packageBIngress, packageBAssembly, packageBTurn, packageBProvider,
    packageBFinal, packageBPresentation,
  });
}
