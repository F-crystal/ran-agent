import { coreError } from '../coreErrors.mjs';
import { assertKeyedContentHashToken } from '../coreHashToken.mjs';
import {
  providerAttemptOperationDigest,
  providerEpochOperationDigest,
  providerEpochTransitionOperationDigest,
} from '../packageB/packageBOperationDigest.mjs';
import {
  appendPackageBReceipt,
  assertNonNegativeInteger,
  assertPackageBOperationKey,
  assertPackageBReceipt,
  findPackageBReceipt,
  findPackageBReceiptByOperationKey,
  frozen,
  packageBReceiptEventId,
  readVerifiedConversationIdentity,
} from './packageBRepositorySupport.mjs';

const EPOCH_KIND = 'provider_epoch_created';
const REBUILD_KIND = 'provider_epoch_rebuild_metadata';
const TRANSITION_KIND = 'provider_epoch_transitioned';
const ATTEMPT_KIND = 'provider_attempt_recorded';
const ATTEMPT_DETAILS_KIND = 'provider_attempt_details';
const ATTEMPT_COMPLETION_KIND = 'provider_attempt_completed';
const EPOCH_STATES = new Set(['active', 'tainted', 'rotating', 'closed']);
const TAINT_STATES = new Set(['clean', 'suspect', 'tainted']);
const ALLOWED_TRANSITIONS = new Set([
  'active:tainted', 'active:rotating', 'active:closed',
  'tainted:rotating', 'tainted:closed',
  'rotating:active', 'rotating:tainted', 'rotating:closed',
]);

function epochScope(conversationId, exchangeId, epochId) {
  return `provider_epoch:${conversationId}:${exchangeId}:${epochId}`;
}

function stateFromSourceKind(sourceKind, prefix) {
  if (!sourceKind.startsWith(prefix)) {
    throw coreError('CORE_OPERATION_RECEIPT_INTEGRITY', 'provider receipt lacks typed state');
  }
  return sourceKind.slice(prefix.length).split(':');
}

function assertEpochState(state, taintState) {
  const compatible = (state === 'active' && taintState === 'clean')
    || (state === 'tainted' && taintState === 'tainted')
    || (state === 'rotating' && taintState === 'suspect')
    || state === 'closed';
  if (!EPOCH_STATES.has(state) || !TAINT_STATES.has(taintState) || !compatible) {
    throw coreError('CORE_PROVIDER_STATE_TRANSITION_INVALID', 'provider epoch state and taint state are incompatible');
  }
}

function bindingState(epochState) {
  if (epochState === 'closed') return 'closed';
  if (epochState === 'rotating') return 'rotating';
  return 'active';
}

function epochResult(get, receipt, disposition) {
  const epoch = get('SELECT * FROM provider_epoch WHERE provider_epoch_id=? AND conversation_id=?',
    receipt.correlation_id, receipt.conversation_id);
  if (!epoch) throw coreError('CORE_OPERATION_RECEIPT_INTEGRITY', 'provider epoch result is missing');
  const [state, taintState] = stateFromSourceKind(receipt.source_kind, 'package_b_provider_epoch_created:');
  return frozen({
    disposition,
    resultId: receipt.journal_event_id,
    journalSequence: Number(receipt.sequence_no),
    providerEpoch: frozen({
      ...epoch, state, taint_state: taintState, revision: 0,
      closed_at: state === 'closed' ? receipt.created_at : null,
    }),
    operationDigest: receipt.source_ref,
  });
}

function transitionResult(get, receipt, disposition) {
  const epoch = get('SELECT * FROM provider_epoch WHERE provider_epoch_id=? AND conversation_id=?',
    receipt.correlation_id, receipt.conversation_id);
  if (!epoch) throw coreError('CORE_OPERATION_RECEIPT_INTEGRITY', 'provider transition result is missing');
  const [, state, taintState] = stateFromSourceKind(receipt.source_kind, 'package_b_provider_epoch_transition:');
  return frozen({
    disposition,
    resultId: receipt.journal_event_id,
    journalSequence: Number(receipt.sequence_no),
    providerEpoch: frozen({
      ...epoch, state, taint_state: taintState, revision: Number(receipt.revision),
      closed_at: state === 'closed' ? receipt.created_at : null,
    }),
    operationDigest: receipt.source_ref,
  });
}

function attemptResult(receipt, disposition) {
  return frozen({
    disposition,
    resultId: receipt.journal_event_id,
    journalSequence: Number(receipt.sequence_no),
    providerEpochId: receipt.correlation_id,
    attemptNumber: Number(receipt.revision),
    operationDigest: receipt.source_ref,
  });
}

function appendTypedJournal(run, get, {
  eventId, eventType, ownerId = null, conversationId, exchangeId, actorRef = null,
  originRef, sourceKind, sourceRef, revision = 0, causationId, correlationId, createdAt,
}) {
  run(`INSERT INTO journal_event(
    journal_event_id,event_type,owner_id,conversation_id,exchange_id,actor_ref,
    origin_ref,source_kind,source_ref,revision,causation_id,correlation_id,created_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, eventId, eventType, ownerId, conversationId, exchangeId,
  actorRef, originRef, sourceKind, sourceRef, revision, causationId, correlationId, createdAt);
  return get('SELECT * FROM journal_event WHERE journal_event_id=?', eventId);
}

export function createPackageBProviderRepository({ get, run }) {
  return frozen({
    createEpoch(input) {
      assertPackageBOperationKey(input.operationKey);
      for (const value of [input.snapshotHashToken, input.capabilitySnapshotHashToken, input.upstreamHandleHashToken]) {
        assertKeyedContentHashToken(value);
      }
      const epochState = input.epochState ?? 'active';
      const taintState = input.taintState ?? 'clean';
      assertEpochState(epochState, taintState);
      const digest = providerEpochOperationDigest(input);
      const operationScope = epochScope(input.conversationId, input.exchangeId, input.providerEpochId);
      const elsewhere = findPackageBReceiptByOperationKey(get, EPOCH_KIND, input.operationKey);
      if (elsewhere && (elsewhere.conversation_id !== input.conversationId || elsewhere.exchange_id !== input.exchangeId
        || elsewhere.correlation_id !== input.providerEpochId)) {
        throw coreError('CORE_OPERATION_KEY_CONFLICT', 'provider epoch operation key targets another scope');
      }
      const prior = findPackageBReceipt(get, EPOCH_KIND, input.operationKey, operationScope);
      if (prior) {
        assertPackageBReceipt(prior, digest, 'provider epoch');
        return epochResult(get, prior, 'already_applied');
      }
      const exchange = get('SELECT * FROM exchange WHERE exchange_id=? AND conversation_id=?', input.exchangeId, input.conversationId);
      const source = get(`SELECT turn.active_revision_id, revision.revision FROM semantic_turn turn
        JOIN turn_revision revision ON revision.turn_revision_id=turn.active_revision_id
        WHERE turn.semantic_turn_id=? AND turn.exchange_id=? AND turn.conversation_id=? AND turn.role='user'`,
      input.sourceTurnId, input.exchangeId, input.conversationId);
      if (!exchange || exchange.root_instruction_turn_id !== input.sourceTurnId || !source
        || source.active_revision_id !== input.sourceRevisionId || Number(source.revision) !== input.sourceRevision) {
        throw coreError('CORE_PROVIDER_SOURCE_INVALID', 'provider epoch requires the adopted user source revision');
      }
      if (get('SELECT 1 AS found FROM provider_epoch WHERE provider_epoch_id=?', input.providerEpochId)) {
        throw coreError('CORE_OPERATION_KEY_CONFLICT', 'provider epoch identity is already used');
      }
      run(`INSERT INTO provider_epoch(
        provider_epoch_id,conversation_id,provider,model,state,taint_state,committed_event_cursor,
        active_speculative_work_run_id,soul_revision_id,capability_snapshot_ref,canonical_snapshot_ref,
        snapshot_hash_token,revision,created_at,closed_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)`,
      input.providerEpochId, input.conversationId, input.provider, input.model, epochState, taintState,
      input.committedEventCursor ?? null, null, input.soulRevisionId ?? null, input.capabilitySnapshotRef,
      input.canonicalSnapshotRef, input.snapshotHashToken, input.createdAt,
      epochState === 'closed' ? input.createdAt : null);
      const epochBindingState = bindingState(epochState);
      run(`INSERT INTO provider_epoch_binding(
        provider_epoch_binding_id,provider_epoch_id,provider,upstream_handle,handle_hash_token,state,revision,created_at,closed_at
      ) VALUES (?,?,?,?,?,?,0,?,?)`, input.bindingId, input.providerEpochId, input.provider,
      input.upstreamHandle, input.upstreamHandleHashToken, epochBindingState, input.createdAt,
      epochBindingState === 'closed' ? input.createdAt : null);
      const receipt = appendPackageBReceipt(run, get, {
        kind: EPOCH_KIND, operationKey: input.operationKey, operationScope, operationDigest: digest,
        resultId: input.providerEpochId, conversationId: input.conversationId, exchangeId: input.exchangeId,
        actorRef: input.sourceTurnId, revision: input.sourceRevision, causationId: input.sourceRevisionId,
        sourceKind: `package_b_provider_epoch_created:${epochState}:${taintState}`, createdAt: input.createdAt,
      });
      run(`INSERT INTO journal_payload(
        journal_payload_id,journal_event_id,storage_kind,payload_ref,content_hash_token,sensitivity,retention_class,created_at
      ) VALUES (?,?,'external_ref',?,?,'normal','canonical',?)`, `${receipt.journal_event_id}:capability`,
      receipt.journal_event_id, input.capabilitySnapshotRef, input.capabilitySnapshotHashToken, input.createdAt);
      appendTypedJournal(run, get, {
        eventId: `${receipt.journal_event_id}:rebuild`, eventType: `package_b_${REBUILD_KIND}`,
        conversationId: input.conversationId, exchangeId: input.exchangeId, actorRef: input.bindingId,
        originRef: input.requestIdentity, sourceKind: `package_b_provider_binding:${input.upstreamBindingKind}`,
        sourceRef: digest, revision: 0, causationId: receipt.journal_event_id,
        correlationId: input.providerEpochId, createdAt: input.createdAt,
      });
      return epochResult(get, receipt, 'applied');
    },

    transitionEpoch(input) {
      assertPackageBOperationKey(input.operationKey);
      assertNonNegativeInteger(input.expectedRevision, 'provider epoch expected revision');
      assertEpochState(input.nextState, input.taintState);
      const digest = providerEpochTransitionOperationDigest(input);
      const operationScope = epochScope(input.conversationId, input.exchangeId, input.providerEpochId);
      const elsewhere = findPackageBReceiptByOperationKey(get, TRANSITION_KIND, input.operationKey);
      if (elsewhere && (elsewhere.conversation_id !== input.conversationId || elsewhere.exchange_id !== input.exchangeId
        || elsewhere.correlation_id !== input.providerEpochId)) {
        throw coreError('CORE_OPERATION_KEY_CONFLICT', 'provider transition operation key targets another scope');
      }
      const prior = findPackageBReceipt(get, TRANSITION_KIND, input.operationKey, operationScope);
      if (prior) {
        assertPackageBReceipt(prior, digest, 'provider transition');
        return transitionResult(get, prior, 'already_applied');
      }
      const epoch = get('SELECT * FROM provider_epoch WHERE provider_epoch_id=? AND conversation_id=?',
        input.providerEpochId, input.conversationId);
      const created = get('SELECT * FROM journal_event WHERE event_type=? AND correlation_id=? AND exchange_id=?',
        `package_b_${EPOCH_KIND}`, input.providerEpochId, input.exchangeId);
      if (!epoch || !created) throw coreError('CORE_PROVIDER_SOURCE_INVALID', 'provider epoch scope is invalid');
      if (epoch.state !== input.expectedCurrentState || Number(epoch.revision) !== input.expectedRevision) {
        throw coreError('CORE_PROVIDER_STATE_CONFLICT', 'provider epoch state or revision is stale');
      }
      if (!ALLOWED_TRANSITIONS.has(`${epoch.state}:${input.nextState}`)) {
        throw coreError('CORE_PROVIDER_STATE_TRANSITION_INVALID', 'provider epoch transition is not allowed');
      }
      const nextRevision = input.expectedRevision + 1;
      const closedAt = input.nextState === 'closed' ? input.updatedAt : null;
      const updated = run(`UPDATE provider_epoch SET state=?,taint_state=?,revision=?,closed_at=?
        WHERE provider_epoch_id=? AND conversation_id=? AND state=? AND revision=?`, input.nextState,
      input.taintState, nextRevision, closedAt, input.providerEpochId, input.conversationId,
      input.expectedCurrentState, input.expectedRevision);
      if (updated.changes !== 1) throw coreError('CORE_PROVIDER_STATE_CONFLICT', 'provider epoch transition lost its fence');
      run(`UPDATE provider_epoch_binding SET state=?,revision=?,closed_at=?
        WHERE provider_epoch_id=? AND revision=?`, bindingState(input.nextState), nextRevision, closedAt,
      input.providerEpochId, input.expectedRevision);
      const receipt = appendPackageBReceipt(run, get, {
        kind: TRANSITION_KIND, operationKey: input.operationKey, operationScope, operationDigest: digest,
        resultId: input.providerEpochId, conversationId: input.conversationId, exchangeId: input.exchangeId,
        actorRef: created.actor_ref, revision: nextRevision, causationId: created.journal_event_id,
        sourceKind: `package_b_provider_epoch_transition:${input.expectedCurrentState}:${input.nextState}:${input.taintState}`,
        createdAt: input.updatedAt,
      });
      return transitionResult(get, receipt, 'applied');
    },

    appendAttempt(input) {
      assertPackageBOperationKey(input.operationKey);
      assertNonNegativeInteger(input.attemptNumber, 'provider attempt number');
      if (input.attemptNumber < 1) throw coreError('CORE_PROVIDER_ATTEMPT_INVALID', 'provider attempt starts at one');
      assertKeyedContentHashToken(input.snapshotHashToken);
      assertKeyedContentHashToken(input.metadataHashToken);
      const epoch = get('SELECT * FROM provider_epoch WHERE provider_epoch_id=? AND conversation_id=?', input.epochId, input.conversationId);
      const sourceReceipt = get('SELECT * FROM journal_event WHERE event_type=? AND correlation_id=?',
        `package_b_${EPOCH_KIND}`, input.epochId);
      if (!epoch || !sourceReceipt || sourceReceipt.exchange_id !== input.exchangeId
        || sourceReceipt.actor_ref !== input.sourceTurnId || Number(sourceReceipt.revision) !== input.sourceRevision
        || epoch.canonical_snapshot_ref !== input.snapshotRef || epoch.snapshot_hash_token !== input.snapshotHashToken) {
        throw coreError('CORE_PROVIDER_SOURCE_INVALID', 'provider attempt differs from immutable epoch binding');
      }
      const capability = get('SELECT * FROM journal_payload WHERE journal_event_id=?', sourceReceipt.journal_event_id);
      const digest = providerAttemptOperationDigest({
        ...input, provider: epoch.provider, model: epoch.model,
        capabilitySnapshotRef: capability?.payload_ref ?? null,
        capabilitySnapshotHashToken: capability?.content_hash_token ?? null,
      });
      const operationScope = epochScope(input.conversationId, input.exchangeId, input.epochId);
      const elsewhere = findPackageBReceiptByOperationKey(get, ATTEMPT_KIND, input.operationKey);
      if (elsewhere && (elsewhere.conversation_id !== input.conversationId || elsewhere.exchange_id !== input.exchangeId
        || elsewhere.correlation_id !== input.epochId)) {
        throw coreError('CORE_OPERATION_KEY_CONFLICT', 'provider attempt key targets another scope');
      }
      const prior = findPackageBReceipt(get, ATTEMPT_KIND, input.operationKey, operationScope);
      if (prior) {
        assertPackageBReceipt(prior, digest, 'provider attempt');
        return attemptResult(prior, 'already_applied');
      }
      if (!['active', 'tainted'].includes(epoch.state)) {
        throw coreError('CORE_PROVIDER_STATE_TRANSITION_INVALID', 'provider attempt cannot append to a rotating or closed epoch');
      }
      const count = get('SELECT count(*) AS count FROM journal_event WHERE event_type=? AND correlation_id=?',
        `package_b_${ATTEMPT_KIND}`, input.epochId);
      if (input.attemptNumber !== Number(count.count) + 1) {
        throw coreError('CORE_PROVIDER_ATTEMPT_INVALID', 'provider attempt must be the next immutable attempt number');
      }
      const receipt = appendPackageBReceipt(run, get, {
        kind: ATTEMPT_KIND, operationKey: input.operationKey, operationScope, operationDigest: digest,
        resultId: input.epochId, conversationId: input.conversationId, exchangeId: input.exchangeId,
        actorRef: input.sourceTurnId, revision: input.attemptNumber, causationId: sourceReceipt.journal_event_id,
        sourceKind: 'package_b_provider_attempt', createdAt: input.startedAt,
      });
      run(`INSERT INTO journal_payload(
        journal_payload_id,journal_event_id,storage_kind,payload_ref,content_hash_token,sensitivity,retention_class,created_at
      ) VALUES (?,?,'external_ref',?,?,'normal','diagnostic',?)`, `${receipt.journal_event_id}:metadata`,
      receipt.journal_event_id, input.metadataRef, input.metadataHashToken, input.completedAt ?? input.startedAt);
      appendTypedJournal(run, get, {
        eventId: `${receipt.journal_event_id}:details`, eventType: `package_b_${ATTEMPT_DETAILS_KIND}`,
        conversationId: input.conversationId, exchangeId: input.exchangeId,
        actorRef: input.resultClass, originRef: input.requestId,
        sourceKind: `package_b_provider_attempt_error:${input.errorClass ?? 'none'}`,
        sourceRef: digest, revision: input.attemptNumber, causationId: receipt.journal_event_id,
        correlationId: input.epochId, createdAt: input.startedAt,
      });
      if (input.completedAt !== null && input.completedAt !== undefined) {
        appendTypedJournal(run, get, {
          eventId: `${receipt.journal_event_id}:completed`, eventType: `package_b_${ATTEMPT_COMPLETION_KIND}`,
          conversationId: input.conversationId, exchangeId: input.exchangeId,
          originRef: input.requestId, sourceKind: 'package_b_provider_attempt_completed', sourceRef: digest,
          revision: input.attemptNumber, causationId: receipt.journal_event_id,
          correlationId: input.epochId, createdAt: input.completedAt,
        });
      }
      return attemptResult(receipt, 'applied');
    },
  });
}

function verified(read, input) {
  return readVerifiedConversationIdentity(read, input.identity, input.conversationId);
}

function epochRead(read, conversationId, exchangeId, epochId) {
  const row = read(`SELECT epoch.*, receipt.actor_ref AS source_turn_id,
    receipt.revision AS source_revision, receipt.causation_id AS source_revision_id,
    capability.payload_ref AS capability_snapshot_ref, capability.content_hash_token AS capability_snapshot_hash_token,
    rebuild.actor_ref AS provider_epoch_binding_id, binding.provider AS binding_provider,
    binding.handle_hash_token AS upstream_handle_hash_token, rebuild.origin_ref AS request_identity,
    rebuild.source_kind AS upstream_binding_source
    FROM provider_epoch epoch JOIN journal_event receipt ON receipt.correlation_id=epoch.provider_epoch_id
    JOIN journal_event rebuild ON rebuild.correlation_id=epoch.provider_epoch_id
    LEFT JOIN journal_payload capability ON capability.journal_event_id=receipt.journal_event_id
    LEFT JOIN provider_epoch_binding binding ON binding.provider_epoch_id=epoch.provider_epoch_id
    WHERE epoch.provider_epoch_id=? AND epoch.conversation_id=? AND receipt.event_type=?
      AND receipt.exchange_id=? AND rebuild.event_type=?`, epochId, conversationId,
  `package_b_${EPOCH_KIND}`, exchangeId, `package_b_${REBUILD_KIND}`);
  if (!row) return undefined;
  const prefix = 'package_b_provider_binding:';
  return frozen({ ...row, upstream_binding_kind: row.upstream_binding_source.startsWith(prefix)
    ? row.upstream_binding_source.slice(prefix.length) : undefined });
}

function attemptsRead(all, conversationId, exchangeId, epochId) {
  return all(`SELECT receipt.*, receipt.revision AS attempt_number,
    details.origin_ref AS request_identity, details.actor_ref AS result_class,
    CASE WHEN details.source_kind='package_b_provider_attempt_error:none' THEN NULL
      ELSE substr(details.source_kind,length('package_b_provider_attempt_error:')+1) END AS error_class,
    details.created_at AS started_at, completion.created_at AS completed_at,
    epoch.canonical_snapshot_ref AS source_snapshot_ref,
    epoch.snapshot_hash_token AS source_snapshot_hash_token,
    epoch_receipt.actor_ref AS source_turn_id, epoch_receipt.revision AS source_revision,
    epoch_receipt.causation_id AS source_revision_id,
    payload.payload_ref AS metadata_ref, payload.content_hash_token AS metadata_hash_token
    FROM journal_event receipt JOIN journal_event details ON details.causation_id=receipt.journal_event_id
    JOIN provider_epoch epoch ON epoch.provider_epoch_id=receipt.correlation_id
    JOIN journal_event epoch_receipt ON epoch_receipt.event_type='package_b_provider_epoch_created'
      AND epoch_receipt.correlation_id=epoch.provider_epoch_id
    LEFT JOIN journal_event completion ON completion.event_type='package_b_provider_attempt_completed'
      AND completion.causation_id=receipt.journal_event_id
    LEFT JOIN journal_payload payload ON payload.journal_event_id=receipt.journal_event_id
    WHERE receipt.event_type=? AND details.event_type=? AND receipt.correlation_id=?
      AND receipt.conversation_id=? AND receipt.exchange_id=? ORDER BY receipt.revision,receipt.sequence_no`,
  `package_b_${ATTEMPT_KIND}`, `package_b_${ATTEMPT_DETAILS_KIND}`, epochId, conversationId, exchangeId);
}

export function createPackageBProviderReader({ read, all }) {
  const receipt = (input, kind) => verified(read, input) && read(`SELECT * FROM journal_event
    WHERE journal_event_id=? AND event_type=? AND conversation_id=? AND exchange_id=?
      AND correlation_id=? AND source_ref=?`, packageBReceiptEventId(kind, input.operationKey,
    epochScope(input.conversationId, input.exchangeId, input.epochId)), `package_b_${kind}`,
  input.conversationId, input.exchangeId, input.epochId, input.operationDigest);
  return frozen({
    epoch: (input) => verified(read, input)
      && epochRead(read, input.conversationId, input.exchangeId, input.epochId),
    epochReceipt: (input) => receipt(input, EPOCH_KIND),
    transitionReceipt: (input) => receipt(input, TRANSITION_KIND),
    attempts: (input) => verified(read, input)
      ? attemptsRead(all, input.conversationId, input.exchangeId, input.epochId) : [],
    attemptReceipt: (input) => {
      if (!verified(read, input)) return undefined;
      return read(`SELECT receipt.*, details.origin_ref AS request_identity,
        details.actor_ref AS result_class,
        CASE WHEN details.source_kind='package_b_provider_attempt_error:none' THEN NULL
          ELSE substr(details.source_kind,length('package_b_provider_attempt_error:')+1) END AS error_class,
        details.created_at AS started_at, completion.created_at AS completed_at,
        epoch.canonical_snapshot_ref AS source_snapshot_ref,
        epoch.snapshot_hash_token AS source_snapshot_hash_token,
        epoch_receipt.actor_ref AS source_turn_id, epoch_receipt.revision AS source_revision,
        epoch_receipt.causation_id AS source_revision_id
        FROM journal_event receipt JOIN journal_event details ON details.causation_id=receipt.journal_event_id
        JOIN provider_epoch epoch ON epoch.provider_epoch_id=receipt.correlation_id
        JOIN journal_event epoch_receipt ON epoch_receipt.event_type='package_b_provider_epoch_created'
          AND epoch_receipt.correlation_id=epoch.provider_epoch_id
        LEFT JOIN journal_event completion ON completion.event_type='package_b_provider_attempt_completed'
          AND completion.causation_id=receipt.journal_event_id
        WHERE receipt.journal_event_id=? AND receipt.event_type=? AND receipt.conversation_id=?
          AND receipt.exchange_id=? AND receipt.correlation_id=? AND receipt.source_ref=?`,
      packageBReceiptEventId(ATTEMPT_KIND, input.operationKey,
        epochScope(input.conversationId, input.exchangeId, input.epochId)), `package_b_${ATTEMPT_KIND}`,
      input.conversationId, input.exchangeId, input.epochId, input.operationDigest);
    },
    rebuildMetadata: (input) => {
      if (!verified(read, input)) return undefined;
      const epoch = epochRead(read, input.conversationId, input.exchangeId, input.epochId);
      if (!epoch) return undefined;
      const created = read('SELECT * FROM journal_event WHERE event_type=? AND correlation_id=? AND exchange_id=?',
        `package_b_${EPOCH_KIND}`, input.epochId, input.exchangeId);
      const transitions = all(`SELECT * FROM journal_event WHERE event_type=? AND correlation_id=?
        AND conversation_id=? AND exchange_id=? ORDER BY revision,sequence_no`, `package_b_${TRANSITION_KIND}`,
      input.epochId, input.conversationId, input.exchangeId);
      const [initialState, initialTaint] = stateFromSourceKind(created.source_kind, 'package_b_provider_epoch_created:');
      const stateHistory = [{
        resulting_state: initialState, taint_state: initialTaint, revision: 0,
        operation_key: created.origin_ref, operation_digest: created.source_ref,
        receipt_id: created.journal_event_id, created_at: created.created_at,
      }, ...transitions.map((event) => {
        const [, state, taintState] = stateFromSourceKind(event.source_kind, 'package_b_provider_epoch_transition:');
        return {
          resulting_state: state, taint_state: taintState, revision: Number(event.revision),
          operation_key: event.origin_ref, operation_digest: event.source_ref,
          receipt_id: event.journal_event_id, created_at: event.created_at,
        };
      })];
      return frozen({ epoch, stateHistory: frozen(stateHistory.map(frozen)),
        attempts: frozen(attemptsRead(all, input.conversationId, input.exchangeId, input.epochId).map(frozen)) });
    },
  });
}
