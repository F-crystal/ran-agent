// Compatibility queue store (§3, §9). Append-only typed events are the only
// truth; the materialized view below is rebuilt by folding them. The store is
// pre-Gate-5, non-authoritative, projection-only: it cannot answer Canon,
// read-your-write, current Relationship / active I / Soul, or final truth.
//
// Transaction rule (§9.3.2): every transition runs as validate (state machine
// relation + entry guard + bindings + writer epoch) -> append typed event ->
// fsync -> apply to the view. Multi-record logical steps are expressed as a
// single self-contained event so a crash can never split them.

import fs from 'node:fs';
import path from 'node:path';

import { readJsonState, writeJsonAtomic } from '../atomicState.mjs';
import { canonicalDigest, deepFreezeClone, derivedId, newId } from './canonical.mjs';
import { createCompatEventLog } from './eventLog.mjs';
import {
  BUDGET_PROFILE_V1,
  COMPAT_ADAPTER_ID,
  COMPAT_ADAPTER_VERSION,
  COMPAT_AUTHORITY_OWNER,
  COMPAT_ERROR_CODES,
  COMPAT_GATE_POLICY_VERSION,
  COMPAT_ILLEGAL_TRANSITION_EVENT,
  COMPAT_PROTOCOL_ID,
  COMPAT_UPSTREAM_VERSION,
  compatError,
} from './constants.mjs';
import {
  aggregateItemStateFromOperations,
  assertAttemptTransition,
  assertItemTransition,
  assertMigrationTransition,
  classifyLifecycleInterrupt,
  classifyRestartAttempt,
  isTerminalItemState,
} from './stateMachine.mjs';

const STORE_VIEW_EVENT_TYPES = Object.freeze([
  'source_ingress',
  'source_revision',
  'source_lifecycle',
  'curator_started',
  'curator_completed',
  'curator_failed',
  'reviewer_started',
  'reviewer_completed',
  'gate_evaluated',
  'operation_authorized',
  'dispatch_intent_committed',
  'attempt_created',
  'attempt_source_superseded',
  'receipt_recorded',
  'reconciliation_started',
  'reconciliation_evidence',
  'refresh_state',
  'lifecycle_item_created',
  'payload_stored',
  'payload_erased',
  'tombstone_recorded',
  'fence_activated',
  'migration_transition',
  'item_voided',
  'recovery_classification',
  'illegal_transition',
  'retrieval_used_recorded',
  'snapshot_recorded',
]);

export function createCompatQueueStore({
  dir,
  clock = () => new Date(),
  budgetProfile = BUDGET_PROFILE_V1,
  adapterPolicyDigest,
  gatePolicyVersion = COMPAT_GATE_POLICY_VERSION,
}) {
  const root = String(dir);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const log = createCompatEventLog({
    logPath: path.join(root, 'queue-events.jsonl'),
    lockPath: path.join(root, 'queue-events.jsonl.lock'),
  });
  const writerPath = path.join(root, 'writer.json');

  const view = {
    fence: null,
    sources: new Map(),
    items: new Map(),
    operations: new Map(),
    operationsByKey: new Map(),
    attempts: new Map(),
    receipts: new Map(),
    snapshots: new Map(),
    tombstones: new Map(),
    retrievalEvents: new Map(),
    illegalTransitions: [],
    payloadIndex: new Map(), // ref -> { digest, deletion_domain, state: 'stored'|'erased' }
  };

  const RECEIPT_OUTCOME_SET = new Set(['succeeded', 'failed', 'ambiguous']);

  let entries = [];
  let epoch = 0;
  let opened = false;

  function now() {
    const value = clock();
    const date = value instanceof Date ? value : new Date(value);
    return date.toISOString();
  }

  // ---------------------------------------------------------------- open --
  function open() {
    if (opened) return;
    log.acquireWriterLock();
    try {
      const read = log.readAll();
      entries = read.entries;
      for (const entry of entries) apply(entry);
      epoch = bumpWriterEpoch();
      opened = true;
      recoverAfterOpen();
    } catch (error) {
      log.releaseWriterLock();
      throw error;
    }
  }

  function close() {
    log.releaseWriterLock();
    opened = false;
  }

  function bumpWriterEpoch() {
    const existing = readJsonState(writerPath, { missingValue: { epoch: 0 }, critical: false });
    const next = Number.isInteger(existing?.epoch) ? existing.epoch + 1 : 1;
    writeJsonAtomic(writerPath, { epoch: next, opened_at: now() });
    return next;
  }

  function assertOpened() {
    if (!opened) throw compatError('COMPAT_STORE_BUSY', 'compatibility queue store is not open');
  }

  // ------------------------------------------------------------- append --
  function appendEvent(type, body) {
    const entry = log.append({
      entries,
      type,
      at: now(),
      body: { writer_epoch: epoch, ...body },
    });
    entries.push(entry);
    apply(entry);
    return entry;
  }

  // -------------------------------------------------------------- fold --
  function apply(entry) {
    // Event bodies are spread into the log entry itself (see eventLog.append),
    // so the entry doubles as its own body.
    const body = entry;
    switch (entry.type) {
      case 'source_ingress': return applySourceIngress(entry, body);
      case 'source_revision': return applySourceRevision(entry, body);
      case 'source_lifecycle': return applySourceLifecycleEvent(entry, body);
      case 'curator_started': return applyCuratorStarted(entry, body);
      case 'curator_completed': return applyCuratorCompleted(entry, body);
      case 'curator_failed': return applyCuratorFailed(entry, body);
      case 'reviewer_started': return applyReviewerStarted(entry, body);
      case 'reviewer_completed': return applyReviewerCompleted(entry, body);
      case 'gate_evaluated': return applyGateEvaluated(entry, body);
      case 'operation_authorized': return applyOperationAuthorized(entry, body);
      case 'dispatch_intent_committed': return applyDispatchIntent(entry, body);
      case 'attempt_created': return applyAttemptCreated(entry, body);
      case 'attempt_source_superseded': return applyAttemptSourceSuperseded(entry, body);
      case 'receipt_recorded': return applyReceiptRecorded(entry, body);
      case 'reconciliation_started': return applyReconciliationStarted(entry, body);
      case 'reconciliation_evidence': return; // evidence refs carried by receipt
      case 'refresh_state': return applyRefreshState(entry, body);
      case 'lifecycle_item_created': return applyLifecycleItemCreated(entry, body);
      case 'payload_stored': return applyPayloadStored(entry, body);
      case 'payload_erased': return applyPayloadErased(entry, body);
      case 'tombstone_recorded': return applyTombstone(entry, body);
      case 'fence_activated': return applyFence(entry, body);
      case 'migration_transition': return applyMigrationTransition(entry, body);
      case 'item_voided': return applyItemVoided(entry, body);
      case 'recovery_classification': return applyRecoveryClassification(entry, body);
      case 'illegal_transition': return applyIllegalTransition(entry, body);
      case 'retrieval_used_recorded': return applyRetrievalUsed(entry, body);
      case 'snapshot_recorded': return applySnapshotRecorded(entry, body);
      default:
        throw compatError('COMPAT_STORE_CORRUPT', `unknown event type ${entry.type}`);
    }
  }

  // --------------------------------------------------------- reducers --
  function applySourceIngress(entry, body) {
    const binding = body.binding;
    let source = view.sources.get(binding.event_id);
    if (!source) {
      source = {
        event_id: binding.event_id,
        current_revision: binding.source_revision,
        revisions: new Map(),
        lifecycle_state: binding.lifecycle_state,
        supersedes_event_id: binding.supersedes_event_id || null,
        withdrawal_ref: null,
        withdrawal_revision: null,
        supersession_ref: null,
        supersession_revision: null,
        deletion_ref: null,
        deletion_revision: null,
      };
      view.sources.set(binding.event_id, source);
    }
    source.revisions.set(binding.source_revision, binding);
    if (binding.source_revision > source.current_revision) {
      source.current_revision = binding.source_revision;
    }
    if (body.item) {
      view.items.set(body.item.queue_item_id, body.item);
    }
  }

  function applySourceRevision(entry, body) {
    const source = mustSource(body.event_id);
    source.revisions.set(body.binding.source_revision, body.binding);
    if (body.binding.source_revision > source.current_revision) {
      source.current_revision = body.binding.source_revision;
    }
    for (const item of view.items.values()) {
      if (item.source_event_id !== body.event_id || item.queue_item_state !== 'received') continue;
      const prior = source.revisions.get(item.source_revision);
      if (prior?.final_content_digest !== body.binding.final_content_digest) continue;
      item.source_revision = body.binding.source_revision;
      item.expected_source_revision = body.binding.source_revision;
      item.source_event_digest = body.binding.source_event_digest;
      item.source_lifecycle_state = body.binding.lifecycle_state;
      item.updated_at = entry.at;
    }
  }

  function applySourceLifecycleEvent(entry, body) {
    const source = mustSource(body.event_id);
    source.lifecycle_state = body.lifecycle_state;
    if (body.withdrawal_ref) {
      source.withdrawal_ref = body.withdrawal_ref;
      source.withdrawal_revision = body.withdrawal_revision;
    }
    if (body.supersession_ref) {
      source.supersession_ref = body.supersession_ref;
      source.supersession_revision = body.supersession_revision;
    }
    if (body.deletion_ref) {
      source.deletion_ref = body.deletion_ref;
      source.deletion_revision = body.deletion_revision;
    }
    for (const item of view.items.values()) {
      if (item.source_event_id === body.event_id) {
        item.source_lifecycle_state = body.lifecycle_state;
      }
    }
    for (const itemTransition of body.item_transitions || []) {
      const item = mustItem(itemTransition.queue_item_id);
      transitionItem(item, itemTransition.to, itemTransition.guard, entry);
      if (itemTransition.to === 'withdrawn' || itemTransition.to === 'superseded') {
        item.terminal_at = item.terminal_at || entry.at;
      }
    }
  }

  function applyCuratorStarted(entry, body) {
    const item = mustItem(body.queue_item_id);
    if (item.queue_item_state === 'received') {
      transitionItem(item, 'curating', 'curator_invocation', entry);
    } else if (item.queue_item_state !== 'curating') {
      // §9.3.3: after a restart the curator may be rerun with a NEW
      // invocation id (never reusing private output); any other state is
      // illegal.
      throw compatError('COMPAT_ILLEGAL_TRANSITION', `curator cannot start from ${item.queue_item_state}`);
    }
    item.curator = {
      curator_invocation_id: body.invocation.curator_invocation_id,
      curator_invocation_ref: body.invocation.curator_invocation_ref,
      curator_model_id: body.invocation.curator_model_id,
      curator_model_version: body.invocation.curator_model_version,
      curator_protocol_version: body.invocation.curator_protocol_version,
      curator_input_digest: body.invocation.curator_input_digest,
      curator_output_digest: null,
      tool_inventory_digest: body.invocation.tool_inventory_digest,
      started_at: entry.at,
    };
  }

  function applyCuratorCompleted(entry, body) {
    const item = mustItem(body.queue_item_id);
    transitionItem(item, 'reviewing', 'curator_result', entry);
    item.curator.curator_output_digest = body.curator_output_digest;
    item.candidates = body.candidates;
  }

  function applyCuratorFailed(entry, body) {
    const item = mustItem(body.queue_item_id);
    transitionItem(item, 'rejected', 'typed_reject', entry);
    item.reject_stage = 'curator';
    item.reject_reason = body.error_code;
    item.last_error_code = body.error_code;
    item.terminal_at = entry.at;
    if (item.curator) item.curator.curator_output_digest = body.output_digest || null;
  }

  function applyReviewerStarted(entry, body) {
    const item = mustItem(body.queue_item_id);
    if (item.queue_item_state !== 'reviewing') {
      throw compatError('COMPAT_ILLEGAL_TRANSITION', `reviewer cannot start from ${item.queue_item_state}`);
    }
    item.reviewer = {
      reviewer_invocation_id: body.invocation.reviewer_invocation_id,
      reviewer_invocation_ref: body.invocation.reviewer_invocation_ref,
      reviewer_model_id: body.invocation.reviewer_model_id,
      reviewer_model_version: body.invocation.reviewer_model_version,
      reviewer_protocol_version: body.invocation.reviewer_protocol_version,
      reviewer_input_digest: body.invocation.reviewer_input_digest,
      tool_inventory_digest: body.invocation.tool_inventory_digest,
      reviewer_decision: null,
      reviewer_revision: null,
      reviewer_output_digest: null,
      started_at: entry.at,
    };
  }

  function applyReviewerCompleted(entry, body) {
    const item = mustItem(body.queue_item_id);
    if (body.decision === 'reject') {
      transitionItem(item, 'rejected', 'typed_reject', entry);
      item.reject_stage = 'reviewer';
      item.reject_reason = body.reason_code || 'reviewer_reject';
      item.terminal_at = entry.at;
    } else {
      transitionItem(item, 'gate_pending', 'reviewer_result', entry);
    }
    item.reviewer.reviewer_decision = body.decision;
    item.reviewer.reviewer_revision = body.reviewer_revision;
    item.reviewer.reviewer_output_digest = body.reviewer_output_digest;
    item.candidates = body.final_candidates;
  }

  function applyGateEvaluated(entry, body) {
    const item = mustItem(body.queue_item_id);
    item.gate = body.gate_provenance;
    const anyAuthorized = (body.decisions || []).some((decision) => decision.decision === 'authorized');
    if (body.item_outcome === 'authorized' && anyAuthorized) {
      transitionItem(item, 'authorized', 'gate_authorized', entry);
    } else if (body.item_outcome === 'rejected') {
      transitionItem(item, 'rejected', 'typed_reject', entry);
      item.reject_stage = 'gate';
      item.reject_reason = body.gate_provenance?.gate_reason_code || 'gate_rejected';
      item.last_error_code = 'COMPAT_GATE_REJECTED';
      item.terminal_at = entry.at;
    } else if (body.item_outcome === 'fenced') {
      transitionItem(item, 'fenced', 'fence_revision', entry);
    } else if (body.item_outcome === 'deferred') {
      item.next_attempt_at = body.next_attempt_at || null;
    }
  }

  function applyOperationAuthorized(entry, body) {
    const operation = body.operation;
    view.operations.set(operation.operation_id, operation);
    view.operationsByKey.set(operation.operation_key, operation.operation_id);
    const item = mustItem(operation.queue_item_id);
    item.operation_ids.push(operation.operation_id);
  }

  function applyDispatchIntent(entry, body) {
    const operation = mustOperation(body.operation_id);
    const attempt = mustAttempt(body.attempt_id);
    assertAttemptTransition({
      from: attempt.adapter_attempt_state,
      to: 'dispatching',
      guard: 'dispatch_intent_committed',
    });
    attempt.adapter_attempt_state = 'dispatching';
    attempt.dispatch_intent_id = body.intent.dispatch_intent_id;
    attempt.dispatch_intent_digest = body.intent.dispatch_intent_digest;
    attempt.dispatch_intent_committed_seq = entry.seq;
    attempt.adapter_request_digest = body.intent.adapter_request_digest;
    attempt.method_identifier = body.intent.method_identifier;
    attempt.updated_at = entry.at;
    if (operation.lifecycle_operation === 'total_delete') {
      transitionOperation(operation, 'deleting', 'lifecycle_delete_intent', entry);
    } else {
      const guard = operation.state === 'failed' ? 'retryable_new_attempt' : 'dispatch_intent_committed';
      transitionOperation(operation, 'dispatching', guard, entry);
    }
    reduceItemFromOperations(operation.queue_item_id, entry);
  }

  function applyAttemptCreated(entry, body) {
    const operation = mustOperation(body.operation_id);
    operation.attempt_ids.push(body.attempt.attempt_id);
    operation.attempt_count = operation.attempt_ids.length;
    view.attempts.set(body.attempt.attempt_id, body.attempt);
  }

  function applyAttemptSourceSuperseded(entry, body) {
    const attempt = mustAttempt(body.attempt_id);
    const operation = mustOperation(attempt.operation_id);
    const item = mustItem(operation.queue_item_id);
    if (attempt.adapter_attempt_state !== 'dispatching') {
      throw compatError('COMPAT_ILLEGAL_TRANSITION', 'only an undispatched durable intent may be source-superseded');
    }
    attempt.adapter_attempt_state = 'superseded-by-source-revision';
    attempt.attempt_retryable = false;
    attempt.updated_at = entry.at;
    operation.state = 'superseded';
    operation.retryable = false;
    operation.last_error_code = 'COMPAT_STALE_SOURCE_REVISION';
    operation.updated_at = entry.at;
    item.queue_item_state = 'superseded';
    item.retryable = false;
    item.last_error_code = 'COMPAT_STALE_SOURCE_REVISION';
    item.terminal_at = entry.at;
    item.updated_at = entry.at;
  }

  function applyReceiptRecorded(entry, body) {
    const receipt = body.receipt;
    view.receipts.set(receipt.receipt_id, receipt);
    const operation = mustOperation(body.operation_id);
    const attempt = mustAttempt(receipt.receipt_attempt_id);
    const fromAttempt = attempt.adapter_attempt_state;
    const fromOperation = operation.state;
    const guardByOutcome = {
      succeeded: 'conclusive_succeeded_receipt',
      failed: 'conclusive_failed_receipt',
      ambiguous: fromAttempt === 'reconciling' ? 'reconciliation' : 'outcome_unprovable',
    };
    const guard = guardByOutcome[receipt.outcome];
    if (!guard) throw compatError('COMPAT_RECEIPT_INVALID', `unknown receipt outcome ${receipt.outcome}`);
    const attemptTarget = receipt.outcome;
    assertAttemptTransition({ from: fromAttempt, to: attemptTarget, guard });
    attempt.adapter_attempt_state = attemptTarget;
    attempt.updated_at = entry.at;
    if (receipt.outcome === 'succeeded') attempt.succeeded_at = receipt.issued_at;
    if (receipt.outcome === 'failed') attempt.failed_at = receipt.issued_at;

    const operationTarget = receiptOperationTarget(operation, receipt.outcome, fromOperation);
    const operationGuard = receiptOperationGuard(operation, receipt.outcome, fromOperation, guard);
    transitionOperation(operation, operationTarget, operationGuard, entry);
    operation.projection_receipt_ref = receipt.receipt_id;
    if (receipt.outcome === 'succeeded') {
      operation.projection_target_ref = receipt.target_projection_ref;
      operation.terminal_at = entry.at;
      const item = mustItem(operation.queue_item_id);
      if (item.revision_refresh_state === 'not_required') item.revision_refresh_state = 'pending';
    }
    if (receipt.outcome === 'failed') {
      operation.last_error_code = receipt.error_code || null;
      if (!operation.retryable) operation.terminal_at = entry.at;
    }
    if (receipt.outcome === 'ambiguous') {
      operation.last_error_code = 'COMPAT_AMBIGUOUS_REQUIRES_RECONCILIATION';
    }
    reduceItemFromOperations(operation.queue_item_id, entry);
  }

  // Lifecycle operations reduce to their own terminal states (§9.3.3 note:
  // suppressed/tombstoned/deleting/deleted are separate trusted lifecycle
  // items; the original growth item keeps its published effect truth).
  function receiptOperationTarget(operation, outcome, fromOperation) {
    if (operation.lifecycle_operation) {
      if (outcome === 'succeeded') {
        if (operation.lifecycle_operation === 'suppress') return 'suppressed';
        if (operation.lifecycle_operation === 'tombstone') return 'tombstoned';
        if (operation.lifecycle_operation === 'total_delete') return 'deleted';
        return 'published';
      }
      return outcome; // failed | ambiguous
    }
    if (outcome === 'succeeded') return 'published';
    return outcome; // failed | ambiguous
  }

  function receiptOperationGuard(operation, outcome, fromOperation, attemptGuard) {
    if (operation.lifecycle_operation && outcome === 'succeeded') {
      if (operation.lifecycle_operation === 'total_delete') return 'cascade_conclusive';
      if (['suppress', 'tombstone'].includes(operation.lifecycle_operation)) return 'lifecycle_receipt';
    }
    if (outcome === 'ambiguous' && fromOperation === 'reconciling') return 'reconciliation';
    return attemptGuard;
  }

  function applyReconciliationStarted(entry, body) {
    const operation = mustOperation(body.operation_id);
    const attempt = mustAttempt(body.attempt_id);
    assertAttemptTransition({ from: attempt.adapter_attempt_state, to: 'reconciling', guard: 'reconciliation' });
    attempt.adapter_attempt_state = 'reconciling';
    attempt.updated_at = entry.at;
    transitionOperation(operation, 'reconciling', 'reconciliation', entry);
    operation.reconciliation_operation_id = body.reconciliation_operation_id;
    reduceItemFromOperations(operation.queue_item_id, entry);
  }

  function applyRefreshState(entry, body) {
    const item = mustItem(body.queue_item_id);
    item.revision_refresh_state = body.revision_refresh_state;
    if (body.projection_revision) {
      item.projection_revision = body.projection_revision;
      for (const operationId of item.operation_ids) {
        const operation = view.operations.get(operationId);
        if (operation && operation.state === 'published') {
          operation.projection_revision = body.projection_revision;
        }
      }
    }
    item.updated_at = entry.at;
  }

  function applyLifecycleItemCreated(entry, body) {
    view.items.set(body.item.queue_item_id, body.item);
    const operation = body.operation;
    view.operations.set(operation.operation_id, operation);
    view.operationsByKey.set(operation.operation_key, operation.operation_id);
  }

  function applyPayloadStored(entry, body) {
    view.payloadIndex.set(body.ref, {
      digest: body.digest,
      deletion_domain: body.deletion_domain,
      state: 'stored',
      stored_at: entry.at,
    });
  }

  function applyPayloadErased(entry, body) {
    const record = view.payloadIndex.get(body.ref);
    if (record) {
      record.state = 'erased';
      record.erased_at = entry.at;
      record.deletion_ref = body.deletion_ref || null;
    } else {
      view.payloadIndex.set(body.ref, {
        digest: body.digest || null,
        deletion_domain: body.deletion_domain || null,
        state: 'erased',
        erased_at: entry.at,
        deletion_ref: body.deletion_ref || null,
      });
    }
  }

  function applyTombstone(entry, body) {
    view.tombstones.set(body.target_ref, {
      target_ref: body.target_ref,
      tombstone_ref: body.tombstone_ref,
      tombstone_state: body.tombstone_state,
      deletion_ref: body.deletion_ref || null,
      deletion_domain: body.deletion_domain || null,
      recorded_at: entry.at,
    });
  }

  function applyFence(entry, body) {
    view.fence = {
      fence_revision: body.fence_revision,
      frozen_queue_cursor: body.frozen_queue_cursor,
      frozen_source_cursor: body.frozen_source_cursor,
      activated_at: entry.at,
    };
    for (const item of view.items.values()) {
      if (!isTerminalItemState(item.queue_item_state) && item.queue_item_state !== 'fenced') {
        transitionItem(item, 'fenced', 'fence_revision', entry);
      }
    }
    for (const operation of view.operations.values()) {
      if (!isTerminalItemState(operation.state) && operation.state !== 'fenced') {
        transitionOperation(operation, 'fenced', 'fence_revision', entry);
      }
    }
  }

  function applyMigrationTransition(entry, body) {
    const item = mustItem(body.queue_item_id);
    assertMigrationTransition({ from: item.migration_state, to: body.to, guard: body.guard });
    item.migration_state = body.to;
    item.migration_record = { ...(item.migration_record || {}), ...(body.record || {}) };
    item.updated_at = entry.at;
  }

  function applyItemVoided(entry, body) {
    const item = mustItem(body.queue_item_id);
    transitionItem(item, 'voided', 'owner_void', entry);
    item.terminal_at = entry.at;
    item.void_record = body.disposal_record;
  }

  function applyRecoveryClassification(entry, body) {
    const operation = mustOperation(body.operation_id);
    const attempt = mustAttempt(body.attempt_id);
    if (body.classification === 'ambiguous') {
      if (!['dispatching', 'reconciling'].includes(attempt.adapter_attempt_state)) return;
      const attemptGuard = attempt.adapter_attempt_state === 'reconciling' ? 'reconciliation' : 'outcome_unprovable';
      assertAttemptTransition({
        from: attempt.adapter_attempt_state,
        to: 'ambiguous',
        guard: attemptGuard,
      });
      attempt.adapter_attempt_state = 'ambiguous';
      attempt.updated_at = entry.at;
      if (['dispatching', 'reconciling'].includes(operation.state)) {
        const operationGuard = operation.state === 'reconciling' ? 'reconciliation' : 'outcome_unprovable';
        transitionOperation(operation, 'ambiguous', operationGuard, entry);
      }
      operation.last_error_code = 'COMPAT_AMBIGUOUS_REQUIRES_RECONCILIATION';
      reduceItemFromOperations(operation.queue_item_id, entry);
    }
  }

  function applyIllegalTransition(entry, body) {
    view.illegalTransitions.push({
      at: entry.at,
      from: body.from,
      requested_to: body.requested_to,
      owner: body.owner,
      operation_key: body.operation_key || null,
      attempt_id: body.attempt_id || null,
      reason: body.reason,
      writer_epoch: body.writer_epoch,
    });
  }

  function applyRetrievalUsed(entry, body) {
    view.retrievalEvents.set(body.retrieval_event.retrieval_event_id, {
      ...body.retrieval_event,
      recorded_at: entry.at,
      touches: [],
    });
  }

  function applySnapshotRecorded(entry, body) {
    view.snapshots.set(body.snapshot.snapshot_id, body.snapshot);
  }

  // ------------------------------------------------------- transitions --
  function transitionItem(item, to, guard, entry) {
    assertItemTransition({ from: item.queue_item_state, to, guard });
    item.queue_item_state = to;
    item.updated_at = entry.at;
  }

  function transitionOperation(operation, to, guard, entry) {
    assertItemTransition({ from: operation.state, to, guard });
    operation.state = to;
    operation.updated_at = entry.at;
  }

  function reduceItemFromOperations(queueItemId, entry) {
    const item = mustItem(queueItemId);
    if (['received', 'curating', 'reviewing', 'gate_pending'].includes(item.queue_item_state)) return;
    if (isTerminalItemState(item.queue_item_state) || item.queue_item_state === 'fenced') return;
    const states = item.operation_ids
      .map((id) => view.operations.get(id))
      .filter(Boolean)
      .map((operation) => operation.state);
    const aggregate = aggregateItemStateFromOperations(states);
    if (!aggregate || aggregate === item.queue_item_state) return;
    // Aggregate movement is receipt-driven; validate against the relation.
    transitionItem(item, aggregate, aggregateGuard(item.queue_item_state, aggregate), entry);
    if (isTerminalItemState(aggregate)) item.terminal_at = entry.at;
  }

  function aggregateGuard(from, to) {
    if (to === 'published') return 'conclusive_succeeded_receipt';
    if (to === 'failed') return 'conclusive_failed_receipt';
    if (to === 'ambiguous') return from === 'reconciling' ? 'reconciliation' : 'outcome_unprovable';
    if (to === 'reconciling') return 'reconciliation';
    if (to === 'dispatching') return from === 'failed' ? 'retryable_new_attempt' : 'dispatch_intent_committed';
    if (to === 'authorized') return 'gate_authorized';
    if (to === 'deleting') return 'lifecycle_delete_intent';
    if (to === 'deleted') return 'cascade_conclusive';
    if (to === 'suppressed' || to === 'tombstoned') return 'lifecycle_receipt';
    return 'reconciliation';
  }

  // ------------------------------------------------------------ guards --
  function recordIllegal({ from, requestedTo, owner, operationKey, attemptId, reason }) {
    appendEvent('illegal_transition', {
      event_schema: COMPAT_ILLEGAL_TRANSITION_EVENT,
      from,
      requested_to: requestedTo,
      owner,
      operation_key: operationKey || null,
      attempt_id: attemptId || null,
      reason,
    });
  }

  function assertNotFenced() {
    if (view.fence) {
      throw compatError('COMPATIBILITY_WRITER_FENCED', 'compatibility writer is fenced');
    }
  }

  function assertSourceCurrentForDispatch(operation) {
    const source = mustSource(operation.source_event_id);
    if (source.lifecycle_state !== 'current') {
      throw compatError('COMPAT_SOURCE_NOT_CURRENT', `source lifecycle is ${source.lifecycle_state}`);
    }
    const current = source.revisions.get(source.current_revision);
    if (!current) throw compatError('COMPAT_SOURCE_STALE', 'source binding missing current revision');
    if (current.final_content_digest !== operation.final_content_digest) {
      throw compatError('COMPAT_SOURCE_STALE', 'source content advanced past operation binding');
    }
    if (current.lifecycle_state !== 'current') {
      throw compatError('COMPAT_SOURCE_NOT_CURRENT', 'source lifecycle is not current');
    }
  }

  // ------------------------------------------------------------- ingress --
  function ingressSourceEvent(binding, { itemClass = 'growth' } = {}) {
    assertOpened();
    assertNotFenced();
    const source = view.sources.get(binding.event_id);
    if (source) {
      const existing = source.revisions.get(binding.source_revision);
      if (existing) {
        if (existing.source_event_digest === binding.source_event_digest) {
          return {
            disposition: 'exact_replay',
            event_id: binding.event_id,
            source_revision: binding.source_revision,
            item_ids: itemsForSource(binding.event_id, binding.source_revision),
          };
        }
        throw compatError(
          'COMPAT_INGRESS_CONFLICT',
          `source event ${binding.event_id} revision ${binding.source_revision} digest conflict`,
        );
      }
      if (binding.source_revision < source.current_revision) {
        throw compatError('COMPAT_SOURCE_STALE', `source revision ${binding.source_revision} is stale`);
      }
    }

    const currentBinding = source ? source.revisions.get(source.current_revision) : null;
    const contentChanged = !currentBinding
      || currentBinding.final_content_digest !== binding.final_content_digest
      || binding.lifecycle_state !== 'current';

    if (source && !contentChanged) {
      // Presentation/delivery-only revision: update binding, no new journey
      // (§4.3 — delivery observation never rewrites final semantic content).
      appendEvent('source_revision', { event_id: binding.event_id, binding });
      return {
        disposition: 'presentation_revision',
        event_id: binding.event_id,
        source_revision: binding.source_revision,
        item_ids: itemsForSource(binding.event_id, source.current_revision),
      };
    }

    const queue_item_id = newId('ocq_item');
    const item = {
      queue_item_id,
      item_class: itemClass,
      source_event_id: binding.event_id,
      source_revision: binding.source_revision,
      expected_source_revision: binding.source_revision,
      source_event_digest: binding.source_event_digest,
      queue_item_state: 'received',
      source_lifecycle_state: binding.lifecycle_state,
      migration_state: 'not_selected',
      revision_refresh_state: 'not_required',
      retryable: true,
      next_attempt_at: null,
      supersedes_operation_id: null,
      last_error_code: null,
      created_at: now(),
      updated_at: now(),
      terminal_at: null,
      candidates: [],
      curator: null,
      reviewer: null,
      gate: null,
      operation_ids: [],
      reject_stage: null,
      reject_reason: null,
    };
    appendEvent('source_ingress', { binding, item });
    return {
      disposition: 'new',
      event_id: binding.event_id,
      source_revision: binding.source_revision,
      item_ids: [queue_item_id],
    };
  }

  // ----------------------------------------------- source lifecycle lane --
  // Applies a trusted source lifecycle event. Returns the typed effect so the
  // lifecycle lane can spawn compensation operations where required (§9.3.6).
  function applySourceLifecycle({ event_id, kind, ref, revision, tombstone = null }) {
    assertOpened();
    const source = mustSource(event_id);
    const lifecycleByKind = {
      withdraw: 'withdrawn',
      supersede: 'superseded',
      suppress: 'suppressed',
      tombstone: 'deleting',
      total_delete: 'deleted',
    };
    const lifecycleState = lifecycleByKind[kind];
    if (!lifecycleState) throw compatError('COMPAT_LIFECYCLE_REJECTED', `unknown lifecycle kind ${kind}`);

    const itemTransitions = [];
    const needsCompensation = [];
    const pendingClassification = [];
    // Idempotent lifecycle arrivals: once a source is deleted (or already in
    // the requested state), further events are audit-only — no transitions,
    // no new compensation, and never a resurrection (§8.3, §9.3.6).
    const lifecycleReplay = source.lifecycle_state === 'deleted'
      || source.lifecycle_state === lifecycleState;
    if (!lifecycleReplay) {
      for (const item of view.items.values()) {
        if (item.source_event_id !== event_id) continue;
        if (!['growth', 'touch'].includes(item.item_class)) continue;
        const hasSucceededReceipt = item.operation_ids
          .map((id) => view.operations.get(id))
          .some((operation) => operation && operation.state === 'published');
        const hasDispatchIntent = item.operation_ids
          .map((id) => view.operations.get(id))
          .some((operation) => operation && ['dispatching', 'ambiguous', 'reconciling'].includes(operation.state));
        const action = classifyLifecycleInterrupt({
          itemState: item.queue_item_state,
          hasDispatchIntent,
          hasSucceededReceipt,
          migrationState: item.migration_state,
        });
        if (action === 'fence_candidate') {
          const to = kind === 'supersede' ? 'superseded' : 'withdrawn';
          itemTransitions.push({ queue_item_id: item.queue_item_id, to, guard: 'lifecycle_predispatch' });
        } else if (action === 'compensate_via_lifecycle_lane') {
          needsCompensation.push(item.queue_item_id);
        } else if (action === 'classify_effect_first' || action === 'continue_reconciliation_suppressed_read') {
          // In-flight effects are never declared absent; classification or
          // reconciliation finishes first, then the lifecycle lane compensates.
          pendingClassification.push(item.queue_item_id);
        }
      }
    }

    appendEvent('source_lifecycle', {
      event_id,
      lifecycle_state: lifecycleState,
      kind,
      withdrawal_ref: kind === 'withdraw' ? ref : null,
      withdrawal_revision: kind === 'withdraw' ? revision : null,
      supersession_ref: kind === 'supersede' ? ref : null,
      supersession_revision: kind === 'supersede' ? revision : null,
      deletion_ref: ['tombstone', 'total_delete'].includes(kind) ? ref : null,
      deletion_revision: ['tombstone', 'total_delete'].includes(kind) ? revision : null,
      item_transitions: itemTransitions,
    });
    if (tombstone) {
      appendEvent('tombstone_recorded', tombstone);
    }
    return {
      item_transitions: itemTransitions,
      needs_compensation: needsCompensation,
      pending_classification: pendingClassification,
    };
  }

  // ------------------------------------------------------ curator/reviewer --
  function startCurator({ queue_item_id, invocation }) {
    assertOpened();
    const item = mustItem(queue_item_id);
    assertItemTransition({ from: item.queue_item_state, to: 'curating', guard: 'curator_invocation' });
    appendEvent('curator_started', { queue_item_id, invocation });
  }

  function completeCurator({ queue_item_id, curator_output_digest, candidates }) {
    assertOpened();
    const item = mustItem(queue_item_id);
    assertItemTransition({ from: item.queue_item_state, to: 'reviewing', guard: 'curator_result' });
    appendEvent('curator_completed', { queue_item_id, curator_output_digest, candidates });
  }

  function failCurator({ queue_item_id, error_code, output_digest = null }) {
    assertOpened();
    if (!COMPAT_ERROR_CODES.includes(error_code)) {
      throw compatError('COMPAT_INGRESS_INVALID', `unbounded curator error code ${error_code}`);
    }
    appendEvent('curator_failed', { queue_item_id, error_code, output_digest });
  }

  function startReviewer({ queue_item_id, invocation }) {
    assertOpened();
    const item = mustItem(queue_item_id);
    if (item.queue_item_state !== 'reviewing') {
      recordIllegal({
        from: item.queue_item_state,
        requestedTo: 'reviewing',
        owner: 'reviewer_orchestrator',
        reason: 'reviewer start outside reviewing state',
      });
      throw compatError('COMPAT_ILLEGAL_TRANSITION', `reviewer cannot start from ${item.queue_item_state}`);
    }
    appendEvent('reviewer_started', { queue_item_id, invocation });
  }

  function completeReviewer({ queue_item_id, decision, reviewer_revision, reviewer_output_digest, final_candidates, reason_code = null }) {
    assertOpened();
    appendEvent('reviewer_completed', {
      queue_item_id,
      decision,
      reviewer_revision,
      reviewer_output_digest,
      final_candidates,
      reason_code,
    });
  }

  // ------------------------------------------------------------------ gate --
  function applyGateDecision({ queue_item_id, gate_provenance, decisions, item_outcome, next_attempt_at = null }) {
    assertOpened();
    const item = mustItem(queue_item_id);
    if (item.queue_item_state !== 'gate_pending') {
      recordIllegal({
        from: item.queue_item_state,
        requestedTo: 'gate_pending',
        owner: 'deterministic_gate',
        reason: 'gate evaluation outside gate_pending',
      });
      throw compatError('COMPAT_ILLEGAL_TRANSITION', `gate cannot evaluate from ${item.queue_item_state}`);
    }
    appendEvent('gate_evaluated', { queue_item_id, gate_provenance, decisions, item_outcome, next_attempt_at });
    const authorizedOperations = [];
    for (const decision of decisions) {
      if (decision.decision !== 'authorized') continue;
      const operation = buildOperation(item, decision.candidate, gate_provenance);
      const existingId = view.operationsByKey.get(operation.operation_key);
      if (existingId) {
        const existing = view.operations.get(existingId);
        if (existing.candidate_payload_digest === operation.candidate_payload_digest) {
          authorizedOperations.push({ disposition: 'exact_replay', operation: deepFreezeClone(existing) });
          continue;
        }
        recordIllegal({
          from: 'gate_pending',
          requestedTo: 'authorized',
          owner: 'deterministic_gate',
          operationKey: operation.operation_key,
          reason: 'same operation key with different digest',
        });
        throw compatError('COMPAT_GATE_CONFLICT', 'same operation key with different candidate digest');
      }
      appendEvent('operation_authorized', { operation });
      authorizedOperations.push({ disposition: 'new', operation: deepFreezeClone(view.operations.get(operation.operation_id)) });
    }
    return authorizedOperations;
  }

  function buildOperation(item, candidate, gateProvenance) {
    const source = mustSource(item.source_event_id);
    const binding = source.revisions.get(item.source_revision);
    const operation_key = computeOperationKey({
      source_event_id: item.source_event_id,
      source_revision: item.source_revision,
      candidate_kind: candidate.candidate_kind,
      candidate_payload_digest: candidate.candidate_payload_digest,
      projection_target: candidate.projection_target,
      scope_envelope_digest: binding.scope_envelope_digest,
      deletion_domain: candidate.deletion_domain,
      adapter_policy_digest: gateProvenance.adapter_policy_digest,
    });
    const timestamp = now();
    return {
      operation_id: newId('ocq_op'),
      queue_item_id: item.queue_item_id,
      operation_key,
      source_event_id: item.source_event_id,
      source_revision: item.source_revision,
      source_event_digest: item.source_event_digest,
      final_content_digest: binding.final_content_digest,
      candidate_id: candidate.candidate_id,
      candidate_kind: candidate.candidate_kind,
      candidate_payload_ref: candidate.candidate_payload_ref,
      candidate_payload_digest: candidate.candidate_payload_digest,
      authority_owner: COMPAT_AUTHORITY_OWNER,
      projection_target: candidate.projection_target,
      scope_envelope_ref: binding.scope_envelope_ref,
      scope_envelope_digest: binding.scope_envelope_digest,
      sensitivity: binding.sensitivity,
      deletion_domain: candidate.deletion_domain,
      adapter_id: COMPAT_ADAPTER_ID,
      adapter_version: COMPAT_ADAPTER_VERSION,
      adapter_policy_digest: gateProvenance.adapter_policy_digest,
      upstream_version: COMPAT_UPSTREAM_VERSION,
      state: 'authorized',
      retryable: true,
      attempt_count: 0,
      attempt_ids: [],
      next_attempt_at: null,
      projection_receipt_ref: null,
      projection_revision: null,
      supersedes_operation_id: candidate.supersedes_operation_id || null,
      last_error_code: null,
      created_at: timestamp,
      updated_at: timestamp,
      terminal_at: null,
    };
  }

  // -------------------------------------------------------------- dispatch --
  function createDispatchIntent({
    operation_id,
    method_identifier,
    adapter_request_digest,
    expected_source_revision = null,
  }) {
    assertOpened();
    assertNotFenced();
    const operation = mustOperation(operation_id);
    if (operation.state !== 'authorized') {
      recordIllegal({
        from: operation.state,
        requestedTo: 'dispatching',
        owner: 'dispatcher',
        operationKey: operation.operation_key,
        reason: 'dispatch intent outside authorized',
      });
      throw compatError('COMPAT_ILLEGAL_TRANSITION', `cannot dispatch from ${operation.state}`);
    }
    // Growth dispatches require a current, untombstoned source. Trusted
    // lifecycle operations (suppress/tombstone/total_delete) run precisely
    // because the source is no longer current, so the growth-only checks do
    // not apply to them (§8.2).
    if (!operation.lifecycle_operation) {
      const source = mustSource(operation.source_event_id);
      const expected = expected_source_revision ?? operation.source_revision;
      if (expected !== operation.source_revision || source.current_revision !== expected) {
        throw compatError('COMPAT_STALE_SOURCE_REVISION', 'source changed before durable intent append');
      }
      assertSourceCurrentForDispatch(operation);
      assertNotTombstoned(operation);
    }
    const attempt = newAttempt(operation, 1, true);
    appendEvent('attempt_created', { operation_id, attempt });
    const intent = {
      dispatch_intent_id: newId('ocq_intent'),
      dispatch_intent_digest: null,
      adapter_request_digest,
      method_identifier,
    };
    intent.dispatch_intent_digest = canonicalDigest({
      protocol_id: COMPAT_PROTOCOL_ID,
      operation_key: operation.operation_key,
      attempt_id: attempt.attempt_id,
      attempt_number: attempt.attempt_number,
      source_event_id: operation.source_event_id,
      source_revision: operation.source_revision,
      source_event_digest: operation.source_event_digest,
      candidate_payload_digest: operation.candidate_payload_digest,
      adapter_id: operation.adapter_id,
      adapter_version: operation.adapter_version,
      adapter_policy_digest: operation.adapter_policy_digest,
      upstream_version: operation.upstream_version,
      method_identifier,
      adapter_request_digest,
    });
    appendEvent('dispatch_intent_committed', { operation_id, attempt_id: attempt.attempt_id, intent });
    return deepFreezeClone(view.attempts.get(attempt.attempt_id));
  }

  function createRetryDispatch({ operation_id, method_identifier, adapter_request_digest }) {
    assertOpened();
    assertNotFenced();
    const operation = mustOperation(operation_id);
    if (operation.state !== 'failed' || !operation.retryable) {
      throw compatError('COMPAT_RETRY_NOT_ALLOWED', 'retry requires conclusive failed retryable operation');
    }
    if (!operation.lifecycle_operation) {
      assertSourceCurrentForDispatch(operation);
      assertNotTombstoned(operation);
    }
    assertRetryBudget(operation);
    const attempt = newAttempt(operation, operation.attempt_ids.length + 1, true);
    appendEvent('attempt_created', { operation_id, attempt });
    // failed -> dispatching with a brand new attempt; old attempt untouched.
    assertItemTransition({ from: 'failed', to: 'dispatching', guard: 'retryable_new_attempt' });
    const intent = {
      dispatch_intent_id: newId('ocq_intent'),
      dispatch_intent_digest: null,
      adapter_request_digest,
      method_identifier,
    };
    intent.dispatch_intent_digest = canonicalDigest({
      protocol_id: COMPAT_PROTOCOL_ID,
      operation_key: operation.operation_key,
      attempt_id: attempt.attempt_id,
      attempt_number: attempt.attempt_number,
      source_event_id: operation.source_event_id,
      source_revision: operation.source_revision,
      source_event_digest: operation.source_event_digest,
      candidate_payload_digest: operation.candidate_payload_digest,
      adapter_id: operation.adapter_id,
      adapter_version: operation.adapter_version,
      adapter_policy_digest: operation.adapter_policy_digest,
      upstream_version: operation.upstream_version,
      method_identifier,
      adapter_request_digest,
    });
    appendEvent('dispatch_intent_committed', { operation_id, attempt_id: attempt.attempt_id, intent });
    return deepFreezeClone(view.attempts.get(attempt.attempt_id));
  }

  function newAttempt(operation, attemptNumber, retryable) {
    const timestamp = now();
    return {
      attempt_id: newId('ocq_attempt'),
      operation_id: operation.operation_id,
      attempt_number: attemptNumber,
      adapter_attempt_state: 'not_started',
      attempt_retryable: retryable,
      dispatch_intent_id: null,
      dispatch_intent_digest: null,
      dispatch_intent_committed_seq: null,
      adapter_request_digest: null,
      adapter_id: operation.adapter_id,
      adapter_version: operation.adapter_version,
      adapter_policy_digest: operation.adapter_policy_digest,
      upstream_version: operation.upstream_version,
      method_identifier: null,
      created_at: timestamp,
      updated_at: timestamp,
      succeeded_at: null,
      failed_at: null,
    };
  }

  function assertRetryBudget(operation) {
    const item = mustItem(operation.queue_item_id);
    let retriesUsed = 0;
    for (const candidateItem of itemsForSourceRecords(item.source_event_id)) {
      for (const opId of candidateItem.operation_ids) {
        const op = view.operations.get(opId);
        if (op) retriesUsed += Math.max(0, op.attempt_ids.length - 1);
      }
    }
    if (retriesUsed >= budgetProfile.max_retryable_mutation_attempts_per_source_event) {
      throw compatError('COMPAT_BUDGET_EXCEEDED', 'retryable mutation attempt budget exhausted for source event');
    }
  }

  function markAttemptSourceSuperseded({ attempt_id }) {
    assertOpened();
    appendEvent('attempt_source_superseded', { attempt_id });
    return deepFreezeClone(mustAttempt(attempt_id));
  }

  function assertNotTombstoned(operation) {
    if (view.tombstones.has(operation.projection_target_ref || operation.candidate_payload_ref)) {
      throw compatError('COMPAT_TOMBSTONED', 'projection target is tombstoned');
    }
    const source = view.sources.get(operation.source_event_id);
    if (source && ['deleting', 'deleted'].includes(source.lifecycle_state)) {
      throw compatError('COMPAT_DELETED', 'source is deleted');
    }
  }

  // -------------------------------------------------------------- receipt --
  // Accepts receipts in the §5.5 logical naming (operation_key, attempt_id,
  // adapter_id, ...) and persists the canonical §9.3.1 inventory naming
  // (receipt_operation_key, receipt_attempt_id, receipt_adapter_id, ...).
  function normalizeReceiptShape(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw compatError('COMPAT_RECEIPT_INVALID', 'receipt must be an object');
    }
    const receipt = { ...raw };
    const aliases = [
      ['receipt_operation_key', 'operation_key'],
      ['receipt_attempt_id', 'attempt_id'],
      ['receipt_adapter_id', 'adapter_id'],
      ['receipt_adapter_version', 'adapter_version'],
      ['receipt_upstream_version', 'upstream_version'],
    ];
    for (const [canonical, alias] of aliases) {
      if (receipt[canonical] === undefined && receipt[alias] !== undefined) {
        receipt[canonical] = receipt[alias];
      }
    }
    for (const field of ['receipt_id', 'receipt_operation_key', 'receipt_attempt_id', 'outcome', 'issued_at', 'issuer_id']) {
      if (typeof receipt[field] !== 'string' || !receipt[field]) {
        throw compatError('COMPAT_RECEIPT_INVALID', `receipt missing ${field}`);
      }
    }
    if (!RECEIPT_OUTCOME_SET.has(receipt.outcome)) {
      throw compatError('COMPAT_RECEIPT_INVALID', `unknown receipt outcome ${receipt.outcome}`);
    }
    return receipt;
  }

  function recordReceipt({ operation_id, receipt: rawReceipt }) {
    assertOpened();
    const receipt = normalizeReceiptShape(rawReceipt);
    const operation = mustOperation(operation_id);
    const attempt = mustAttempt(receipt.receipt_attempt_id);
    if (attempt.operation_id !== operation_id) {
      throw compatError('COMPAT_RECEIPT_INVALID', 'receipt attempt does not belong to operation');
    }
    // Idempotency: an exact replay (same canonical content, any receipt_id)
    // returns the durable receipt. A conclusive receipt after ambiguous
    // observations is the legal reconciliation reduction (§5.5, §9.3.4);
    // anything conflicting with an already conclusive receipt is rejected.
    const prior = [];
    let exactMatch = null;
    for (const existing of view.receipts.values()) {
      if (existing.receipt_operation_key === receipt.receipt_operation_key
        && existing.receipt_attempt_id === receipt.receipt_attempt_id) {
        prior.push(existing);
        if (receiptContentDigest(existing) === receiptContentDigest(receipt)) {
          exactMatch = existing;
        }
      }
    }
    if (exactMatch) {
      return { disposition: 'exact_replay', receipt: deepFreezeClone(exactMatch) };
    }
    if (prior.some((existing) => existing.outcome !== 'ambiguous')) {
      throw compatError('COMPAT_RECEIPT_INVALID', 'conflicting receipt for same attempt');
    }
    validateReceiptBindings(operation, attempt, receipt);
    appendEvent('receipt_recorded', { operation_id, receipt });
    return { disposition: 'new', receipt: deepFreezeClone(view.receipts.get(receipt.receipt_id)) };
  }

  function receiptContentDigest(receipt) {
    const { receipt_id: _ignored, ...material } = receipt;
    return canonicalDigest(material);
  }

  function validateReceiptBindings(operation, attempt, receipt) {
    const mismatches = [];
    if (receipt.receipt_operation_key !== operation.operation_key) mismatches.push('operation_key');
    if (receipt.source_event_id !== operation.source_event_id) mismatches.push('source_event_id');
    if (receipt.source_revision !== operation.source_revision) mismatches.push('source_revision');
    if (receipt.source_event_digest !== operation.source_event_digest) mismatches.push('source_event_digest');
    if (receipt.candidate_payload_ref !== operation.candidate_payload_ref) mismatches.push('candidate_payload_ref');
    if (receipt.candidate_payload_digest !== operation.candidate_payload_digest) mismatches.push('candidate_payload_digest');
    if (receipt.adapter_id !== operation.adapter_id) mismatches.push('adapter_id');
    if (receipt.adapter_version !== operation.adapter_version) mismatches.push('adapter_version');
    if (receipt.adapter_policy_digest !== operation.adapter_policy_digest) mismatches.push('adapter_policy_digest');
    if (receipt.upstream_version !== operation.upstream_version) mismatches.push('upstream_version');
    if (attempt.adapter_request_digest && receipt.request_digest !== attempt.adapter_request_digest) {
      mismatches.push('request_digest');
    }
    if (receipt.outcome === 'succeeded') {
      if (!receipt.target_projection_ref) mismatches.push('target_projection_ref');
      if (!receipt.upstream_evidence_ref) mismatches.push('upstream_evidence_ref');
      if (!Number.isInteger(receipt.target_revision_before) || !Number.isInteger(receipt.target_revision_after)) {
        mismatches.push('target_revision');
      }
    }
    if (mismatches.length > 0) {
      throw compatError('COMPAT_RECEIPT_INVALID', `receipt binding mismatch: ${mismatches.join(', ')}`);
    }
  }

  // -------------------------------------------------------- reconciliation --
  function startReconciliation({ operation_id, attempt_id, reconciliation_operation_id }) {
    assertOpened();
    const operation = mustOperation(operation_id);
    if (!['ambiguous', 'reconciling'].includes(operation.state)) {
      throw compatError(
        'COMPAT_AMBIGUOUS_REQUIRES_RECONCILIATION',
        `reconciliation only allowed from ambiguous/reconciling, got ${operation.state}`,
      );
    }
    const attempt = mustAttempt(attempt_id);
    if (operation.state === 'ambiguous') {
      appendEvent('reconciliation_started', { operation_id, attempt_id, reconciliation_operation_id });
    }
    return { operation_id, reconciliation_operation_id };
  }

  function recordReconciliationEvidence({ operation_id, evidence_refs, evidence_digest }) {
    assertOpened();
    appendEvent('reconciliation_evidence', { operation_id, evidence_refs, evidence_digest });
  }

  // --------------------------------------------------------------- refresh --
  function setRefreshState({ queue_item_id, revision_refresh_state, projection_revision = null }) {
    assertOpened();
    appendEvent('refresh_state', { queue_item_id, revision_refresh_state, projection_revision });
  }

  function recordSnapshot(snapshot) {
    assertOpened();
    appendEvent('snapshot_recorded', { snapshot });
  }

  // -------------------------------------------------------- lifecycle items --
  function createLifecycleItem({
    item_class,
    lifecycle_operation,
    target_operation_id,
    method_identifier,
    lifecycle_ref = null,
    expected_revision = null,
    deletion_domain,
    retryable = true,
    key_material_extra = null,
  }) {
    assertOpened();
    const target = mustOperation(target_operation_id);
    const queue_item_id = newId('ocq_item');
    const timestamp = now();
    const candidateDigest = canonicalDigest({
      lifecycle_operation,
      target_operation_key: target.operation_key,
      target_projection_ref: target.projection_target_ref || null,
      lifecycle_ref,
      expected_revision,
      key_material_extra,
    });
    // Idempotent: the same lifecycle operation on the same target replays to
    // the existing item instead of duplicating compensation.
    const existingKey = computeOperationKey({
      source_event_id: target.source_event_id,
      source_revision: target.source_revision,
      candidate_kind: `lifecycle:${item_class}`,
      candidate_payload_digest: candidateDigest,
      projection_target: target.projection_target,
      scope_envelope_digest: target.scope_envelope_digest,
      deletion_domain: deletion_domain || target.deletion_domain,
      adapter_policy_digest: adapterPolicyDigest,
    });
    const existingOperationId = view.operationsByKey.get(existingKey);
    if (existingOperationId) {
      const existingOperation = view.operations.get(existingOperationId);
      return {
        disposition: 'exact_replay',
        item: deepFreezeClone(view.items.get(existingOperation.queue_item_id)),
        operation: deepFreezeClone(existingOperation),
      };
    }
    const item = {
      queue_item_id,
      item_class,
      source_event_id: target.source_event_id,
      source_revision: target.source_revision,
      source_event_digest: target.source_event_digest,
      queue_item_state: 'authorized',
      source_lifecycle_state: mustSource(target.source_event_id).lifecycle_state,
      migration_state: 'not_selected',
      revision_refresh_state: 'not_required',
      retryable: true,
      next_attempt_at: null,
      supersedes_operation_id: target_operation_id,
      last_error_code: null,
      created_at: timestamp,
      updated_at: timestamp,
      terminal_at: null,
      candidates: [],
      curator: null,
      reviewer: null,
      gate: null,
      operation_ids: [],
      reject_stage: null,
      reject_reason: null,
    };
    const operation = {
      ...buildSkeletonOperation(item, target, candidateDigest, deletion_domain || target.deletion_domain, retryable),
      lifecycle_operation,
      method_identifier,
      lifecycle_ref,
      expected_revision,
      supersedes_operation_id: target_operation_id,
    };
    if (key_material_extra?.retrieval_event_id) {
      operation.touch_retrieval_event_id = key_material_extra.retrieval_event_id;
    }
    if (key_material_extra?.projection_item_ref) {
      operation.touch_projection_item_ref = key_material_extra.projection_item_ref;
    }
    item.operation_ids = [operation.operation_id];
    appendEvent('lifecycle_item_created', { item, operation });
    return {
      disposition: 'new',
      item: deepFreezeClone(view.items.get(queue_item_id)),
      operation: deepFreezeClone(view.operations.get(operation.operation_id)),
    };
  }

  function buildSkeletonOperation(item, target, candidateDigest, deletionDomain, retryable = true) {
    const timestamp = now();
    const operation_key = computeOperationKey({
      source_event_id: item.source_event_id,
      source_revision: item.source_revision,
      candidate_kind: `lifecycle:${item.item_class}`,
      candidate_payload_digest: candidateDigest,
      projection_target: target.projection_target,
      scope_envelope_digest: target.scope_envelope_digest,
      deletion_domain: deletionDomain,
      adapter_policy_digest: adapterPolicyDigest,
    });
    return {
      operation_id: newId('ocq_op'),
      queue_item_id: item.queue_item_id,
      operation_key,
      source_event_id: item.source_event_id,
      source_revision: item.source_revision,
      source_event_digest: item.source_event_digest,
      final_content_digest: target.final_content_digest,
      candidate_id: `lifecycle:${item.queue_item_id}`,
      candidate_kind: `lifecycle:${item.item_class}`,
      candidate_payload_ref: null,
      candidate_payload_digest: candidateDigest,
      authority_owner: COMPAT_AUTHORITY_OWNER,
      projection_target: target.projection_target,
      scope_envelope_ref: target.scope_envelope_ref,
      scope_envelope_digest: target.scope_envelope_digest,
      sensitivity: target.sensitivity,
      deletion_domain: deletionDomain,
      adapter_id: COMPAT_ADAPTER_ID,
      adapter_version: COMPAT_ADAPTER_VERSION,
      adapter_policy_digest: adapterPolicyDigest,
      upstream_version: COMPAT_UPSTREAM_VERSION,
      state: 'authorized',
      retryable,
      attempt_count: 0,
      attempt_ids: [],
      next_attempt_at: null,
      projection_receipt_ref: null,
      projection_revision: null,
      supersedes_operation_id: item.supersedes_operation_id,
      last_error_code: null,
      created_at: timestamp,
      updated_at: timestamp,
      terminal_at: null,
    };
  }

  function recordPayloadStored({ ref, digest, deletion_domain }) {
    assertOpened();
    appendEvent('payload_stored', { ref, digest, deletion_domain });
  }

  function recordPayloadErased({ ref, digest = null, deletion_domain = null, deletion_ref = null }) {
    assertOpened();
    appendEvent('payload_erased', { ref, digest, deletion_domain, deletion_ref });
  }

  function recordTombstone(tombstone) {
    assertOpened();
    appendEvent('tombstone_recorded', tombstone);
  }

  // ----------------------------------------------------------------- fence --
  function activateFence({ fence_revision, frozen_queue_cursor, frozen_source_cursor }) {
    assertOpened();
    if (view.fence) return deepFreezeClone(view.fence);
    appendEvent('fence_activated', { fence_revision, frozen_queue_cursor, frozen_source_cursor });
    return deepFreezeClone(view.fence);
  }

  function transitionMigration({ queue_item_id, to, guard, record = {} }) {
    assertOpened();
    appendEvent('migration_transition', { queue_item_id, to, guard, record });
  }

  function voidItem({ queue_item_id, disposal_record }) {
    assertOpened();
    const item = mustItem(queue_item_id);
    const hasEffect = item.operation_ids
      .map((id) => view.operations.get(id))
      .some((operation) => operation && ['published', 'ambiguous', 'reconciling'].includes(operation.state));
    if (hasEffect) {
      throw compatError('COMPAT_MIGRATION_CONFLICT', 'cannot void an item with succeeded or ambiguous effect');
    }
    appendEvent('item_voided', { queue_item_id, disposal_record });
  }

  // -------------------------------------------------------- retrieval used --
  function recordRetrievalUsed(retrievalEvent) {
    assertOpened();
    const existing = view.retrievalEvents.get(retrievalEvent.retrieval_event_id);
    if (existing) return { disposition: 'exact_replay' };
    appendEvent('retrieval_used_recorded', { retrieval_event: retrievalEvent });
    return { disposition: 'new' };
  }

  function registerTouch({ retrieval_event_id, projection_item_ref, operation_id }) {
    const record = view.retrievalEvents.get(retrieval_event_id);
    if (record) record.touches.push({ projection_item_ref, operation_id });
  }

  // ------------------------------------------------------------ recovery --
  function recoverAfterOpen() {
    // §9.3.5: materialized state always yields to durable receipt/evidence.
    for (const attempt of Array.from(view.attempts.values())) {
      if (attempt.adapter_attempt_state !== 'dispatching') continue;
      const receipts = receiptsForAttempt(attempt.attempt_id);
      const classification = classifyRestartAttempt({
        hasDispatchIntent: Boolean(attempt.dispatch_intent_id),
        hasSucceededReceipt: receipts.some((receipt) => receipt.outcome === 'succeeded'),
        hasFailedReceipt: receipts.some((receipt) => receipt.outcome === 'failed'),
        hasNotStartedEvidence: false,
      });
      if (classification === 'ambiguous') {
        appendEvent('recovery_classification', {
          operation_id: attempt.operation_id,
          attempt_id: attempt.attempt_id,
          classification: 'ambiguous',
          reason: 'dispatch intent without conclusive receipt at restart',
        });
      }
    }
    // A refresh lease (`building`) never survives a restart; the refresh is
    // idempotently re-scheduled from its succeeded receipt.
    for (const item of view.items.values()) {
      if (item.revision_refresh_state === 'building') {
        appendEvent('refresh_state', { queue_item_id: item.queue_item_id, revision_refresh_state: 'pending' });
      }
    }
  }

  // -------------------------------------------------------------- readers --
  function mustSource(eventId) {
    const source = view.sources.get(eventId);
    if (!source) throw compatError('COMPAT_INGRESS_INVALID', `unknown source event ${eventId}`);
    return source;
  }

  function mustItem(queueItemId) {
    const item = view.items.get(queueItemId);
    if (!item) throw compatError('COMPAT_INGRESS_INVALID', `unknown queue item ${queueItemId}`);
    return item;
  }

  function mustOperation(operationId) {
    const operation = view.operations.get(operationId);
    if (!operation) throw compatError('COMPAT_INGRESS_INVALID', `unknown operation ${operationId}`);
    return operation;
  }

  function mustAttempt(attemptId) {
    const attempt = view.attempts.get(attemptId);
    if (!attempt) throw compatError('COMPAT_INGRESS_INVALID', `unknown attempt ${attemptId}`);
    return attempt;
  }

  function itemsForSource(eventId, revision) {
    return Array.from(view.items.values())
      .filter((item) => item.source_event_id === eventId && (revision === undefined || item.source_revision === revision))
      .map((item) => item.queue_item_id);
  }

  function itemsForSourceRecords(eventId) {
    return Array.from(view.items.values()).filter((item) => item.source_event_id === eventId);
  }

  function receiptsForAttempt(attemptId) {
    return Array.from(view.receipts.values()).filter((receipt) => receipt.receipt_attempt_id === attemptId);
  }

  function exportView() {
    return deepFreezeClone({
      fence: view.fence,
      sources: Array.from(view.sources.values()).map((source) => ({
        ...source,
        revisions: Array.from(source.revisions.values()),
      })),
      items: Array.from(view.items.values()),
      operations: Array.from(view.operations.values()),
      attempts: Array.from(view.attempts.values()),
      receipts: Array.from(view.receipts.values()),
      snapshots: Array.from(view.snapshots.values()),
      tombstones: Array.from(view.tombstones.values()),
      retrievalEvents: Array.from(view.retrievalEvents.values()),
      illegalTransitions: view.illegalTransitions,
      payloadIndex: Array.from(view.payloadIndex.entries()).map(([ref, record]) => ({ ref, ...record })),
      writer_epoch: epoch,
      log_head: log.head(entries),
    });
  }

  return {
    open,
    close,
    root,
    get epoch() { return epoch; },
    get fence() { return view.fence ? deepFreezeClone(view.fence) : null; },
    budgetProfile,
    adapterPolicyDigest,
    gatePolicyVersion,
    ingressSourceEvent,
    applySourceLifecycle,
    startCurator,
    completeCurator,
    failCurator,
    startReviewer,
    completeReviewer,
    applyGateDecision,
    createDispatchIntent,
    createRetryDispatch,
    markAttemptSourceSuperseded,
    recordReceipt,
    startReconciliation,
    recordReconciliationEvidence,
    setRefreshState,
    recordSnapshot,
    createLifecycleItem,
    recordPayloadStored,
    recordPayloadErased,
    recordTombstone,
    activateFence,
    transitionMigration,
    voidItem,
    recordRetrievalUsed,
    registerTouch,
    recordIllegalTransition: recordIllegal,
    getItem: (id) => deepFreezeClone(mustItem(id)),
    getOperation: (id) => deepFreezeClone(mustOperation(id)),
    getAttempt: (id) => deepFreezeClone(mustAttempt(id)),
    getReceipt: (id) => {
      const receipt = view.receipts.get(id);
      if (!receipt) throw compatError('COMPAT_INGRESS_INVALID', `unknown receipt ${id}`);
      return deepFreezeClone(receipt);
    },
    getSource: (id) => {
      const source = mustSource(id);
      return deepFreezeClone({ ...source, revisions: Array.from(source.revisions.values()) });
    },
    getOperationByKey: (key) => {
      const id = view.operationsByKey.get(key);
      return id ? deepFreezeClone(view.operations.get(id)) : null;
    },
    listItems: () => Array.from(view.items.values()).map((item) => deepFreezeClone(item)),
    listOperations: () => Array.from(view.operations.values()).map((operation) => deepFreezeClone(operation)),
    listAttempts: () => Array.from(view.attempts.values()).map((attempt) => deepFreezeClone(attempt)),
    listReceipts: () => Array.from(view.receipts.values()).map((receipt) => deepFreezeClone(receipt)),
    receiptsForAttempt,
    listEvents: ({ afterSeq = 0, type = null } = {}) => entries
      .filter((entry) => entry.seq > afterSeq && (!type || entry.type === type))
      .map((entry) => deepFreezeClone(entry)),
    exportView,
    logHead: () => log.head(entries),
  };
}

export function computeOperationKey({
  source_event_id,
  source_revision,
  candidate_kind,
  candidate_payload_digest,
  projection_target,
  scope_envelope_digest,
  deletion_domain,
  adapter_policy_digest,
}) {
  return canonicalDigest({
    protocol_id: COMPAT_PROTOCOL_ID,
    source_event_id,
    source_revision,
    candidate_kind,
    candidate_payload_digest,
    projection_target,
    scope_envelope_digest,
    deletion_domain,
    adapter_policy_digest,
  });
}

export function deriveSourceEventId({ platform, conversation_id, exchange_id }) {
  return derivedId('ocq_src', { platform, conversation_id, exchange_id });
}
