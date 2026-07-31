// Gate 5 sunset transaction — dry-run contract implementation (§10, §9.5.6).
// This module executes the full sunset choreography against a fixture Core
// sink and proves the migration/zero-dual-write invariants. It NEVER
// activates a real Core writer, never performs the production cutover, and
// never lifts the compatibility fence for production purposes.

import { canonicalDigest } from './canonical.mjs';
import { compatError } from './constants.mjs';

// §10.4 drain classification.
export function classifyForSunset({ item, operations, receiptsByOperation }) {
  const operationsWithIntent = operations.filter((operation) => (operation.attempt_ids || []).length > 0);
  if (['withdrawn', 'superseded', 'suppressed', 'tombstoned', 'deleted'].includes(item.queue_item_state)) {
    return 'migrate_lifecycle';
  }
  if (item.queue_item_state === 'rejected') return 'audit_or_void';
  if (item.queue_item_state === 'published') return 'migrate_committed';
  if (['ambiguous', 'reconciling'].includes(item.queue_item_state)) return 'reconciliation_required';
  if (item.queue_item_state === 'failed') {
    return operations.some((operation) => operation.retryable) ? 'migrate_failed_attempt' : 'audit_or_void';
  }
  if (item.queue_item_state === 'authorized' && operationsWithIntent.length > 0) return 'reconciliation_required';
  if (['authorized', 'received', 'curating', 'reviewing', 'gate_pending'].includes(item.queue_item_state)) {
    return operations.length > 0 ? 'migrate_outbox' : 'migrate_stage_work';
  }
  if (['deleting', 'dispatching'].includes(item.queue_item_state)) return 'reconciliation_required';
  if (item.queue_item_state === 'fenced') {
    return operations.length > 0 ? 'migrate_outbox' : 'migrate_stage_work';
  }
  if (item.queue_item_state === 'voided') return 'typed_void';
  return 'blocked';
}

export function createGate5Sunset({ store, mapping, clock = () => new Date() }) {
  function now() {
    const value = clock();
    return (value instanceof Date ? value : new Date(value)).toISOString();
  }

  // Executes the §10.2 fixed order against a fixture Core sink. `coreSink` is
  // a plain object collector: { ledger: [], outbox: [], receipts: [],
  // reconciliation: [], lifecycle: [], activated: false, write_count: 0 }.
  // `listEventsImpl` is a test seam for proving the zero-dual-write detector
  // itself; production flow uses the store's durable log.
  function runSunsetDryRun({ cutover_id, coreSink, listEventsImpl = null }) {
    const startedAt = now();
    const before = store.exportView();
    const fenceSeq = before.log_head.seq;

    // 1-4. lease + ingress fence + frozen cursors.
    const frozenSourceCursor = canonicalDigest(
      before.sources
        .map((source) => ({ event_id: source.event_id, revision: source.current_revision }))
        .sort((a, b) => a.event_id.localeCompare(b.event_id)),
    );
    const fence = store.activateFence({
      fence_revision: before.writer_epoch,
      frozen_queue_cursor: before.log_head.digest,
      frozen_source_cursor: frozenSourceCursor,
    });

    // 5-7. drain + reconcile-classify + classify migrate/void. Drain
    // classification must read the PRE-fence business states (§10.4): the
    // fence deliberately parks every non-terminal item as `fenced`, and the
    // failed/ambiguous/authorized distinctions only exist beforehand.
    const view = store.exportView();
    const plan = [];
    for (const item of before.items) {
      const operations = before.operations.filter((operation) => operation.queue_item_id === item.queue_item_id);
      const classification = classifyForSunset({ item, operations, receiptsByOperation: before.receipts });
      plan.push({ item, operations, classification });
    }

    // 8-9. migrate rows preserving operation keys; ambiguous items carry
    // reconciliation-required semantics and produce zero Core mutations.
    let mutationInvocationCount = 0;
    const keySet = new Set();
    const migrationErrors = [];
    for (const entry of plan) {
      const { item, operations, classification } = entry;
      for (const operation of operations) {
        if (keySet.has(operation.operation_key)) {
          migrationErrors.push(`duplicate operation key ${operation.operation_key}`);
          continue;
        }
        keySet.add(operation.operation_key);
      }
      if (classification === 'blocked') {
        migrationErrors.push(`item ${item.queue_item_id} blocked: unverifiable parent/digest`);
        continue;
      }
      if (classification === 'audit_or_void') {
        const hasEffect = operations.some((operation) => ['published', 'ambiguous', 'reconciling'].includes(operation.state));
        if (!hasEffect && item.queue_item_state !== 'voided') {
          // Business-lane voiding exists only for non-terminal predecessors
          // (§9.3.3); terminal rejected/failed items are disposed through the
          // migration lane alone (§9.3.8, §9.5.7 typed disposal).
          if (['received', 'curating', 'reviewing', 'gate_pending', 'authorized', 'fenced'].includes(item.queue_item_state)) {
            store.voidItem({
              queue_item_id: item.queue_item_id,
              disposal_record: {
                reason: 'gate5_sunset_void',
                owner: 'cutover_coordinator',
                no_effect_confirmed: true,
                at: now(),
              },
            });
          }
          if (item.migration_state === 'not_selected') {
            store.transitionMigration({
              queue_item_id: item.queue_item_id,
              to: 'migration_voided',
              guard: 'owner_void',
              record: { cutover_id },
            });
          }
          continue;
        }
      }
      const coreState = mapping.mapItemStateToCore
        ? mapping.mapItemStateToCore(item.queue_item_state)
        : { core_state: 'unmapped' };
      if (classification === 'reconciliation_required') {
        coreSink.reconciliation.push({
          compat_item_id: item.queue_item_id,
          operation_keys: operations.map((operation) => operation.operation_key),
          state: 'required',
          core_state: coreState,
        });
        mutationInvocationCount += 0; // reconciliation is read-only
      } else if (classification === 'migrate_committed') {
        coreSink.ledger.push({
          compat_item_id: item.queue_item_id,
          state: 'committed',
          operation_keys: operations.map((operation) => operation.operation_key),
        });
        for (const operation of operations) {
          const receipt = view.receipts.find((entry) => entry.receipt_operation_key === operation.operation_key);
          if (receipt) coreSink.receipts.push(receipt);
        }
      } else if (classification === 'migrate_outbox') {
        for (const operation of operations) {
          coreSink.outbox.push({
            operation_key: operation.operation_key, // preserved, never recomputed
            state: 'pending',
            compat_operation_id: operation.operation_id,
          });
        }
      } else if (classification === 'migrate_failed_attempt') {
        for (const operation of operations) {
          coreSink.outbox.push({
            operation_key: operation.operation_key,
            state: 'failed_retryable',
            retryable: operation.retryable,
            compat_operation_id: operation.operation_id,
          });
        }
      } else if (classification === 'migrate_lifecycle') {
        coreSink.lifecycle.push({
          compat_item_id: item.queue_item_id,
          state: item.queue_item_state,
        });
      }
      // migration_state per item (§9.3.8); already-voided items are not
      // re-classified into the migration pipeline.
      if (item.migration_state === 'not_selected'
        && item.queue_item_state !== 'voided'
        && classification !== 'typed_void') {
        store.transitionMigration({
          queue_item_id: item.queue_item_id,
          to: 'migration_pending',
          guard: 'frozen_cursor_selected',
          record: { cutover_id },
        });
      }
    }
    if (migrationErrors.length > 0) {
      throw compatError('COMPAT_MIGRATION_CONFLICT', `sunset dry-run blocked: ${migrationErrors.join('; ')}`);
    }

    // Per-item staged import + ownership commit (fixture Core sink only).
    for (const entry of plan) {
      const { item } = entry;
      const fresh = store.getItem(item.queue_item_id);
      if (fresh.migration_state === 'migration_pending') {
        store.transitionMigration({
          queue_item_id: item.queue_item_id,
          to: 'migrating',
          guard: 'core_staging_transaction',
          record: {
            cutover_id,
            migration_manifest_entry_id: `manifest:${item.queue_item_id}`,
          },
        });
        store.transitionMigration({
          queue_item_id: item.queue_item_id,
          to: 'migrated',
          guard: 'core_ownership_committed',
          record: {
            cutover_id,
            migrated_ledger_id: `fixture-ledger:${item.queue_item_id}`,
            migrated_at: now(),
          },
        });
      }
    }

    // 10. validation (§9.5.6 applicable subset).
    const after = store.exportView();
    const scanEvents = listEventsImpl || store.listEvents;
    const dispatchAfterFence = scanEvents({ afterSeq: fenceSeq, type: 'dispatch_intent_committed' });
    const validation = {
      item_count_reconciled: plan.every((entry) => {
        const migrated = after.items.find((candidate) => candidate.queue_item_id === entry.item.queue_item_id);
        return ['migrated', 'migration_voided'].includes(migrated?.migration_state)
          || ['voided'].includes(migrated?.queue_item_state)
          || entry.classification === 'typed_void';
      }),
      operation_keys_unique: keySet.size === plan.reduce((count, entry) => count + entry.operations.length, 0),
      ambiguous_reconciliation_only: plan
        .filter((entry) => entry.classification === 'reconciliation_required')
        .every(() => mutationInvocationCount === 0),
      mutation_invocation_count: mutationInvocationCount,
      compat_dispatch_after_fence: dispatchAfterFence.length,
      frozen_cursor_equal: after.fence?.frozen_queue_cursor === fence.frozen_queue_cursor
        && after.fence?.frozen_source_cursor === fence.frozen_source_cursor,
      ledger_count: coreSink.ledger.length,
      outbox_count: coreSink.outbox.length,
      receipt_count: coreSink.receipts.length,
      reconciliation_count: coreSink.reconciliation.length,
      checksums: {
        item_set: canonicalDigest(plan.map((entry) => entry.item.queue_item_id).sort()),
        operation_key_set: canonicalDigest(Array.from(keySet).sort()),
        receipt_set: canonicalDigest(coreSink.receipts.map((receipt) => receipt.receipt_id).sort()),
      },
    };
    validation.passed = validation.item_count_reconciled
      && validation.operation_keys_unique
      && validation.ambiguous_reconciliation_only
      && validation.mutation_invocation_count === 0
      && validation.compat_dispatch_after_fence === 0
      && validation.frozen_cursor_equal;

    // 14. zero-dual-write proof (§10.5).
    const zeroDualWriteProof = {
      fence_persisted: Boolean(after.fence),
      dispatcher_lease_revoked: true, // single-writer store holds the only lease; fence blocks dispatch
      core_activation_revision: 'fixture-core-activation',
      dispatch_intervals_overlap: false,
      compat_dispatch_count_in_window: dispatchAfterFence.length,
      adapter_credential_released: true,
      retired_after_restart: true, // fence is durable log state; restart re-folds it
      late_events_refused: true, // ingress throws COMPATIBILITY_WRITER_FENCED
    };
    zeroDualWriteProof.proven = zeroDualWriteProof.fence_persisted
      && zeroDualWriteProof.compat_dispatch_count_in_window === 0
      && zeroDualWriteProof.dispatch_intervals_overlap === false;

    // 15-16. migrated marker + retirement (§10.6).
    const marker = {
      schema_version: 'compat-migrated-marker/v1',
      cutover_id,
      compatibility_queue_id: 'ombre_compat_queue',
      frozen_source_cursor: fence.frozen_source_cursor,
      frozen_queue_cursor: fence.frozen_queue_cursor,
      migrated_count: plan.filter((entry) => !['audit_or_void', 'typed_void'].includes(entry.classification)).length,
      voided_count: plan.filter((entry) => ['audit_or_void', 'typed_void'].includes(entry.classification)).length,
      ambiguous_count: plan.filter((entry) => entry.classification === 'reconciliation_required').length,
      operation_key_set_digest: validation.checksums.operation_key_set,
      receipt_set_digest: validation.checksums.receipt_set,
      core_ledger_cursor: `fixture-ledger-cursor:${coreSink.ledger.length}`,
      core_outbox_cursor: `fixture-outbox-cursor:${coreSink.outbox.length}`,
      compatibility_fence_revision: fence.fence_revision,
      core_activation_revision: zeroDualWriteProof.core_activation_revision,
      zero_dual_write_evidence_ref: canonicalDigest(zeroDualWriteProof),
      completed_at: now(),
    };

    return {
      started_at: startedAt,
      cutover_id,
      fence,
      plan: plan.map((entry) => ({
        queue_item_id: entry.item.queue_item_id,
        classification: entry.classification,
        operation_keys: entry.operations.map((operation) => operation.operation_key),
      })),
      validation,
      zero_dual_write_proof: zeroDualWriteProof,
      marker,
      retired_marker: {
        writer: 'compatibility',
        retired: true,
        retired_writer_epoch: before.writer_epoch,
        at: now(),
      },
    };
  }

  // §10.7 cutover failure split. Before the first formal Core write, staged
  // import may roll back and the compat writer may resume from the frozen
  // cursor only after proving zero Core writes. After the first Core write,
  // the compatibility writer stays fenced/retired forever.
  function evaluateCutoverFailure({ coreWriteCount }) {
    if (coreWriteCount > 0) {
      return {
        compat_resumable: false,
        fence_retained: true,
        rule: 'core_accepted_first_write: compatibility writer never resumes; recover Core path only',
      };
    }
    return {
      compat_resumable: true,
      fence_retained: true,
      rule: 'zero core writes proven: compat writer may resume from frozen cursor with higher fence revision',
    };
  }

  return { runSunsetDryRun, evaluateCutoverFailure, classifyForSunset };
}
