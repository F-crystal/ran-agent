// Exhaustive, default-deny transition relations for the compatibility queue.
// Source: v0.2 §9.3.3 (queue item), §9.3.4 (adapter attempt), §9.3.5 (restart
// recovery), §9.3.6 (lifecycle interrupt), §9.3.7 (terminality), §9.3.8
// (migration). Anything not listed here is ILLEGAL and must be rejected with
// COMPAT_ILLEGAL_TRANSITION plus a `compat.illegal-transition/v1` audit event.

import {
  ADAPTER_ATTEMPT_STATES,
  MIGRATION_STATES,
  QUEUE_ITEM_STATES,
  compatError,
} from './constants.mjs';
import { canonicalDigest } from './canonical.mjs';

// from -> array of { to, guard }. Guards are typed labels; the queue store
// must supply matching typed evidence before the transition is appended.
export const ITEM_TRANSITIONS = Object.freeze({
  received: Object.freeze([
    { to: 'curating', guard: 'curator_invocation' },
    { to: 'withdrawn', guard: 'lifecycle_predispatch' },
    { to: 'superseded', guard: 'lifecycle_predispatch' },
    { to: 'fenced', guard: 'fence_revision' },
    { to: 'voided', guard: 'owner_void' },
  ]),
  curating: Object.freeze([
    { to: 'reviewing', guard: 'curator_result' },
    { to: 'rejected', guard: 'typed_reject' },
    { to: 'withdrawn', guard: 'lifecycle_predispatch' },
    { to: 'superseded', guard: 'lifecycle_predispatch' },
    { to: 'fenced', guard: 'fence_revision' },
    { to: 'voided', guard: 'owner_void' },
  ]),
  reviewing: Object.freeze([
    { to: 'gate_pending', guard: 'reviewer_result' },
    { to: 'rejected', guard: 'typed_reject' },
    { to: 'withdrawn', guard: 'lifecycle_predispatch' },
    { to: 'superseded', guard: 'lifecycle_predispatch' },
    { to: 'fenced', guard: 'fence_revision' },
    { to: 'voided', guard: 'owner_void' },
  ]),
  gate_pending: Object.freeze([
    { to: 'authorized', guard: 'gate_authorized' },
    { to: 'rejected', guard: 'typed_reject' },
    { to: 'withdrawn', guard: 'lifecycle_predispatch' },
    { to: 'superseded', guard: 'lifecycle_predispatch' },
    { to: 'fenced', guard: 'fence_revision' },
    { to: 'voided', guard: 'owner_void' },
  ]),
  authorized: Object.freeze([
    { to: 'dispatching', guard: 'dispatch_intent_committed' },
    { to: 'deleting', guard: 'lifecycle_delete_intent' },
    { to: 'withdrawn', guard: 'lifecycle_predispatch' },
    { to: 'superseded', guard: 'lifecycle_predispatch' },
    { to: 'fenced', guard: 'fence_revision' },
    { to: 'voided', guard: 'owner_void' },
  ]),
  dispatching: Object.freeze([
    { to: 'published', guard: 'conclusive_succeeded_receipt' },
    { to: 'failed', guard: 'conclusive_failed_receipt' },
    { to: 'ambiguous', guard: 'outcome_unprovable' },
    { to: 'reconciling', guard: 'reconciliation' },
    { to: 'suppressed', guard: 'lifecycle_receipt' },
    { to: 'tombstoned', guard: 'lifecycle_receipt' },
    { to: 'fenced', guard: 'fence_revision' },
  ]),
  published: Object.freeze([]),
  failed: Object.freeze([
    { to: 'dispatching', guard: 'retryable_new_attempt' },
    { to: 'fenced', guard: 'fence_revision' },
  ]),
  ambiguous: Object.freeze([
    { to: 'reconciling', guard: 'reconciliation' },
    { to: 'fenced', guard: 'fence_revision' },
  ]),
  reconciling: Object.freeze([
    { to: 'published', guard: 'conclusive_succeeded_receipt' },
    { to: 'failed', guard: 'conclusive_failed_receipt' },
    { to: 'ambiguous', guard: 'reconciliation' },
    { to: 'suppressed', guard: 'lifecycle_receipt' },
    { to: 'tombstoned', guard: 'lifecycle_receipt' },
    { to: 'fenced', guard: 'fence_revision' },
  ]),
  rejected: Object.freeze([]),
  withdrawn: Object.freeze([]),
  superseded: Object.freeze([]),
  suppressed: Object.freeze([]),
  tombstoned: Object.freeze([]),
  deleting: Object.freeze([
    { to: 'deleted', guard: 'cascade_conclusive' },
    { to: 'failed', guard: 'conclusive_failed_receipt' },
    { to: 'ambiguous', guard: 'outcome_unprovable' },
    { to: 'reconciling', guard: 'reconciliation' },
    { to: 'fenced', guard: 'fence_revision' },
  ]),
  deleted: Object.freeze([]),
  fenced: Object.freeze([
    { to: 'voided', guard: 'owner_void' },
  ]),
  voided: Object.freeze([]),
});

export const TERMINAL_ITEM_STATES = Object.freeze([
  'published',
  'rejected',
  'withdrawn',
  'superseded',
  'suppressed',
  'tombstoned',
  'deleted',
  'voided',
]);

// §9.3.4 adapter attempt relation.
export const ATTEMPT_TRANSITIONS = Object.freeze({
  not_started: Object.freeze([
    { to: 'dispatching', guard: 'dispatch_intent_committed' },
  ]),
  dispatching: Object.freeze([
    { to: 'succeeded', guard: 'conclusive_succeeded_receipt' },
    { to: 'failed', guard: 'conclusive_failed_receipt' },
    { to: 'ambiguous', guard: 'outcome_unprovable' },
    { to: 'reconciling', guard: 'reconciliation' },
    { to: 'superseded-by-source-revision', guard: 'source_revision_changed_before_dispatch' },
  ]),
  'superseded-by-source-revision': Object.freeze([]),
  succeeded: Object.freeze([]),
  failed: Object.freeze([]),
  ambiguous: Object.freeze([
    { to: 'reconciling', guard: 'reconciliation' },
  ]),
  reconciling: Object.freeze([
    { to: 'succeeded', guard: 'conclusive_succeeded_receipt' },
    { to: 'failed', guard: 'conclusive_failed_receipt' },
    { to: 'ambiguous', guard: 'reconciliation' },
  ]),
});

export const TERMINAL_ATTEMPT_STATES = Object.freeze([
  'superseded-by-source-revision',
  'succeeded',
  'failed',
]);

// §9.3.8 migration relation.
export const MIGRATION_TRANSITIONS = Object.freeze({
  not_selected: Object.freeze([
    { to: 'migration_pending', guard: 'frozen_cursor_selected' },
    { to: 'migration_voided', guard: 'owner_void' },
  ]),
  migration_pending: Object.freeze([
    { to: 'migrating', guard: 'core_staging_transaction' },
    { to: 'migration_voided', guard: 'owner_void' },
  ]),
  migrating: Object.freeze([
    { to: 'migrated', guard: 'core_ownership_committed' },
    { to: 'migration_failed', guard: 'typed_migration_failure' },
  ]),
  migration_failed: Object.freeze([
    { to: 'migration_pending', guard: 'migration_retry' },
    { to: 'migration_voided', guard: 'owner_void' },
  ]),
  migrated: Object.freeze([]),
  migration_voided: Object.freeze([]),
});

export const TERMINAL_MIGRATION_STATES = Object.freeze(['migrated', 'migration_voided']);

function findTransition(table, from, to) {
  const edges = table[from];
  if (!edges) return null;
  return edges.find((edge) => edge.to === to) || null;
}

export function isTerminalItemState(state) {
  return TERMINAL_ITEM_STATES.includes(state);
}

// Validates a requested transition against the frozen relation. On violation
// throws COMPAT_ILLEGAL_TRANSITION; the store appends the audit event.
export function assertItemTransition({ from, to, guard }) {
  const edge = findTransition(ITEM_TRANSITIONS, from, to);
  if (!edge) {
    throw compatError(
      'COMPAT_ILLEGAL_TRANSITION',
      `illegal queue item transition ${from} -> ${to}`,
    );
  }
  if (edge.guard !== guard) {
    throw compatError(
      'COMPAT_ILLEGAL_TRANSITION',
      `queue item transition ${from} -> ${to} requires guard ${edge.guard}, got ${guard}`,
    );
  }
  return edge;
}

export function assertAttemptTransition({ from, to, guard }) {
  const edge = findTransition(ATTEMPT_TRANSITIONS, from, to);
  if (!edge) {
    throw compatError(
      'COMPAT_ILLEGAL_TRANSITION',
      `illegal adapter attempt transition ${from} -> ${to}`,
    );
  }
  if (edge.guard !== guard) {
    throw compatError(
      'COMPAT_ILLEGAL_TRANSITION',
      `adapter attempt transition ${from} -> ${to} requires guard ${edge.guard}, got ${guard}`,
    );
  }
  return edge;
}

export function assertMigrationTransition({ from, to, guard }) {
  const edge = findTransition(MIGRATION_TRANSITIONS, from, to);
  if (!edge) {
    throw compatError(
      'COMPAT_ILLEGAL_TRANSITION',
      `illegal migration transition ${from} -> ${to}`,
    );
  }
  if (edge.guard !== guard) {
    throw compatError(
      'COMPAT_ILLEGAL_TRANSITION',
      `migration transition ${from} -> ${to} requires guard ${edge.guard}, got ${guard}`,
    );
  }
  return edge;
}

// Explicitly forbidden transitions named by §9.3.7; kept as data so tests can
// prove each one is rejected.
export const EXPLICITLY_FORBIDDEN_TRANSITIONS = Object.freeze([
  { from: 'published', to: 'authorized' },
  { from: 'withdrawn', to: 'authorized' },
  { from: 'ambiguous', to: 'authorized' },
]);

// §9.3.5 restart recovery: durable evidence -> required inference.
export function classifyRestartAttempt({
  hasDispatchIntent,
  hasSucceededReceipt,
  hasFailedReceipt,
  hasNotStartedEvidence,
}) {
  if (!hasDispatchIntent) return 'not_started';
  if (hasSucceededReceipt) return 'succeeded';
  if (hasFailedReceipt) return 'failed';
  if (hasNotStartedEvidence) return 'failed';
  return 'ambiguous';
}

// §9.3.6 lifecycle interrupt classification. `arrival` is the item's current
// queue_item_state when a source lifecycle event lands.
export function classifyLifecycleInterrupt({
  itemState,
  hasDispatchIntent,
  hasSucceededReceipt,
  migrationState,
}) {
  if (migrationState === 'migrated') return 'handoff_to_core';
  if (itemState === 'deleted') return 'reject_late';
  if (['received', 'curating', 'reviewing', 'gate_pending', 'authorized'].includes(itemState) && !hasDispatchIntent) {
    return 'fence_candidate';
  }
  if (itemState === 'dispatching') return 'classify_effect_first';
  if (['ambiguous', 'reconciling'].includes(itemState)) return 'continue_reconciliation_suppressed_read';
  if (hasSucceededReceipt && itemState === 'published') return 'compensate_via_lifecycle_lane';
  if (['failed', 'rejected', 'withdrawn', 'superseded', 'voided'].includes(itemState)) {
    return 'update_lifecycle_metadata_only';
  }
  if (itemState === 'published') return 'compensate_via_lifecycle_lane';
  return 'update_lifecycle_metadata_only';
}

// Aggregate queue_item_state for an item whose operations move independently
// (reviewer `split` yields multiple operations under one item). Typed and
// auditable: the item never advances past what its operations prove. While
// any operation has moved past `authorized` but the batch is not yet all
// terminal, the item stays `dispatching` (work in flight) — it must never
// fall back to `authorized` (§9.3.7).
export function aggregateItemStateFromOperations(operationStates) {
  const states = operationStates.filter(Boolean);
  if (states.length === 0) throw compatError('COMPAT_AGGREGATE_UNCLASSIFIED', 'child set is empty');
  const derived = aggregateOutcome(states);
  // The old queue item state remains an execution cursor. Rich mixed outcomes
  // live only in the child-ledger-derived materialization below.
  if (derived === 'reconciling' && !states.includes('reconciling')) return 'ambiguous';
  if (derived === 'authorized' && states.some((state) => state === 'published')) return 'dispatching';
  if (derived === 'partially_published' || derived === 'failed_with_cancellation') return 'failed';
  if (derived === 'cancellation_mixed') return 'voided';
  return derived;
}

const LIFECYCLE_OUTCOMES = new Set([
  'withdrawn', 'suppressed', 'superseded', 'tombstoned', 'deleted', 'fenced', 'voided',
]);
const CHILD_OPERATION_OUTCOMES = new Set([
  'active', 'authorized', 'dispatching', 'published', 'rejected', 'failed',
  'failed_receipt', 'ambiguous', 'reconciling',
]);

function aggregateOutcome(states) {
  if (states.some((state) => ['ambiguous', 'reconciling'].includes(state))) return 'reconciling';
  if (states.some((state) => ['authorized', 'dispatching', 'active'].includes(state))) {
    return states.some((state) => state === 'dispatching') ? 'dispatching' : 'authorized';
  }
  if (states.every((state) => state === 'published')) return 'published';
  if (states.some((state) => state === 'published')) return 'partially_published';
  if (states.every((state) => state === 'rejected')) return 'rejected';
  if (states.every((state) => ['rejected', 'failed', 'failed_receipt'].includes(state))
    && states.some((state) => ['failed', 'failed_receipt'].includes(state))) return 'failed';
  if (states.every((state) => LIFECYCLE_OUTCOMES.has(state))) {
    return new Set(states).size === 1 ? states[0] : 'cancellation_mixed';
  }
  if (states.every((state) => LIFECYCLE_OUTCOMES.has(state)
      || ['rejected', 'failed', 'failed_receipt'].includes(state))
    && states.some((state) => LIFECYCLE_OUTCOMES.has(state))) return 'failed_with_cancellation';
  throw compatError('COMPAT_AGGREGATE_UNCLASSIFIED', 'child outcomes cannot be classified');
}

export function computeChildSetDigest(children) {
  if (!Array.isArray(children) || children.length === 0) {
    throw compatError('COMPAT_AGGREGATE_UNCLASSIFIED', 'child set is empty');
  }
  const records = children.map(strictChildRecord);
  records.sort((left, right) => Buffer.compare(
    Buffer.from(left.child_operation_id, 'utf8'),
    Buffer.from(right.child_operation_id, 'utf8'),
  ));
  for (let index = 1; index < records.length; index += 1) {
    if (records[index].child_operation_id === records[index - 1].child_operation_id) {
      throw compatError('COMPAT_DUPLICATE_CHILD_OPERATION_ID', 'duplicate child operation id');
    }
  }
  return Object.freeze({ records: Object.freeze(records), digest: canonicalDigest(records) });
}

export function deriveSplitAggregate({ queue_item_id, children, materialized_at }) {
  if (typeof queue_item_id !== 'string' || !queue_item_id
    || typeof materialized_at !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(materialized_at)
    || !Number.isFinite(Date.parse(materialized_at))) {
    throw compatError('COMPAT_AGGREGATE_UNCLASSIFIED', 'split aggregate identity invalid');
  }
  const { records, digest } = computeChildSetDigest(children);
  const aggregate_state = aggregateOutcome(records.map(
    (record) => record.lifecycle_state ?? record.operation_state,
  ));
  return Object.freeze({
    schema_version: 'compat-split-aggregate-materialization/1',
    queue_item_id,
    child_set_digest: digest,
    child_count: records.length,
    aggregate_state,
    aggregate_algorithm_version: 'ombre-split-aggregate/6',
    materialized_at,
  });
}

export function verifySplitAggregate(materialization, children) {
  const keys = [
    'schema_version', 'queue_item_id', 'child_set_digest', 'child_count',
    'aggregate_state', 'aggregate_algorithm_version', 'materialized_at',
  ];
  if (!materialization || typeof materialization !== 'object' || Array.isArray(materialization)
    || JSON.stringify(Object.keys(materialization).sort()) !== JSON.stringify(keys.sort())
    || materialization.schema_version !== 'compat-split-aggregate-materialization/1') {
    throw compatError('COMPAT_AGGREGATE_UNCLASSIFIED', 'split aggregate materialization invalid');
  }
  const rebuilt = deriveSplitAggregate({
    queue_item_id: materialization.queue_item_id,
    children,
    materialized_at: materialization.materialized_at,
  });
  for (const key of ['child_set_digest', 'child_count', 'aggregate_state', 'aggregate_algorithm_version']) {
    if (rebuilt[key] !== materialization[key]) {
      throw compatError('COMPAT_AGGREGATE_UNCLASSIFIED', `split aggregate ${key} mismatch`);
    }
  }
  return rebuilt;
}

function strictChildRecord(child) {
  const keys = [
    'child_operation_id',
    'operation_state',
    'latest_attempt_number',
    'latest_receipt_digest',
    'lifecycle_state',
    'lifecycle_revision',
  ];
  if (!child || typeof child !== 'object' || Array.isArray(child)
    || JSON.stringify(Object.keys(child).sort()) !== JSON.stringify([...keys].sort())
    || typeof child.child_operation_id !== 'string' || !child.child_operation_id
    || typeof child.operation_state !== 'string' || !CHILD_OPERATION_OUTCOMES.has(child.operation_state)
    || (child.latest_attempt_number !== null
      && (!Number.isInteger(child.latest_attempt_number) || child.latest_attempt_number < 1))
    || (child.latest_receipt_digest !== null
      && !/^sha256:[a-f0-9]{64}$/.test(child.latest_receipt_digest))
    || (child.lifecycle_state === null) !== (child.lifecycle_revision === null)
    || (child.lifecycle_state !== null && (typeof child.lifecycle_state !== 'string'
      || !LIFECYCLE_OUTCOMES.has(child.lifecycle_state)
      || !Number.isInteger(child.lifecycle_revision) || child.lifecycle_revision < 0))) {
    throw compatError('COMPAT_AGGREGATE_UNCLASSIFIED', 'child digest record invalid');
  }
  return Object.freeze({ ...child });
}

export function knownItemState(state) {
  return QUEUE_ITEM_STATES.includes(state);
}

export function knownAttemptState(state) {
  return ADAPTER_ATTEMPT_STATES.includes(state);
}

export function knownMigrationState(state) {
  return MIGRATION_STATES.includes(state);
}
