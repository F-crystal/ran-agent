// Trusted lifecycle governance lane (§8.2, §8.3, §9.3.6). Fully separated
// from the model pipeline: it never invokes Curator/Reviewer, is never
// exposed to models, uses its own adapter allowlist, and re-checks lifecycle
// before every dispatch so withdrawn/suppressed/superseded/deleted content
// is never resurrected by late workers.

import { canonicalDigest, newId } from './canonical.mjs';
import { compatError } from './constants.mjs';

// Trusted lifecycle kind -> compensating adapter operation for already
// published effects. Correction of content is expressed by the new source
// revision's own ADD-only journey; the lane only removes visibility.
const COMPENSATION_BY_KIND = Object.freeze({
  withdraw: 'suppress',
  supersede: 'suppress',
  suppress: 'suppress',
  tombstone: 'tombstone',
});

export function createLifecycleLane({ store, payloadStore, adapter, clock = () => new Date() }) {
  function now() {
    const value = clock();
    return (value instanceof Date ? value : new Date(value)).toISOString();
  }

  // Entry point for trusted source lifecycle events. Returns a typed report.
  async function handleSourceLifecycle({ eventId, kind, ref, revision }) {
    if (kind === 'total_delete') {
      return {
        status: 'typed_unsupported',
        error_code: 'STEWARD_SOURCE_TOTAL_DELETE_UNSUPPORTED',
        item_transitions: [],
        pending_classification: [],
        compensations: [],
        cascade: null,
      };
    }
    const report = store.applySourceLifecycle({ event_id: eventId, kind, ref, revision });

    // 1. Pre-dispatch items were fenced: erase their candidate payloads.
    for (const transition of report.item_transitions) {
      await eraseItemPayloads(transition.queue_item_id, ref);
    }

    // 2. Published effects need compensating lifecycle operations.
    const compensations = [];
    for (const queueItemId of report.needs_compensation) {
      const compensation = await compensate({
        queueItemId,
        lifecycleOperation: COMPENSATION_BY_KIND[kind],
        deletionRef: ref,
      });
      compensations.push(compensation);
    }

    return {
      item_transitions: report.item_transitions,
      pending_classification: report.pending_classification,
      compensations,
      cascade: null,
    };
  }

  async function compatibilityDelete({ eventId, deletionRef, lifecycleRevision }) {
    const view = store.exportView();
    const ownedItems = view.items.filter((item) => item.source_event_id === eventId);
    const tombstonedTargets = [];
    for (const item of ownedItems) {
      const published = item.operation_ids
        .map((operationId) => store.getOperation(operationId))
        .filter((operation) => operation.state === 'published' && operation.projection_target_ref);
      if (published.length) {
        const compensation = await compensate({
          queueItemId: item.queue_item_id,
          lifecycleOperation: 'tombstone',
          deletionRef,
        });
        if (compensation.results.some((result) => result.disposition !== 'succeeded'
          && result.disposition !== 'exact_replay')) {
          throw compatError('COMPAT_STORE_CORRUPT', 'compatibility target tombstone failed');
        }
      }
      for (const operation of published) {
        store.recordTombstone({
          target_ref: operation.projection_target_ref,
          tombstone_ref: `compat-tombstone:${operation.projection_target_ref}`,
          tombstone_state: 'sealed',
          deletion_ref: deletionRef,
          deletion_domain: operation.deletion_domain,
        });
        tombstonedTargets.push(operation.projection_target_ref);
      }
      if (published.length) {
        store.setRefreshState({
          queue_item_id: item.queue_item_id,
          revision_refresh_state: 'pending',
        });
      }
    }
    const erasedPayloads = [];
    const artifactRefs = [];
    for (const item of ownedItems) {
      const result = payloadStore.compatibilityDelete({
        owner_item: item.queue_item_id,
        lifecycle_revision: lifecycleRevision,
      });
      for (const ref of result.deleted_refs) {
        store.recordPayloadErased({ ref, deletion_ref: deletionRef, removed: true });
        erasedPayloads.push(ref);
      }
      artifactRefs.push(...result.invalidated_artifact_refs);
    }
    return Object.freeze({
      status: 'compatibility_deleted',
      event_id: eventId,
      lifecycle_revision: lifecycleRevision,
      erased_payload_refs: [...new Set(erasedPayloads)],
      invalidated_artifact_refs: [...new Set(artifactRefs)],
      tombstoned_target_refs: [...new Set(tombstonedTargets)],
      registry_digest: payloadStore.registryDigest(),
    });
  }

  // Creates and dispatches one compensating lifecycle operation against the
  // published operation of the given (published) queue item.
  async function compensate({ queueItemId, lifecycleOperation, deletionRef }) {
    const item = store.getItem(queueItemId);
    const published = item.operation_ids
      .map((id) => store.getOperation(id))
      .filter((operation) => operation.state === 'published');
    const results = [];
    for (const target of published) {
      const created = store.createLifecycleItem({
        item_class: 'lifecycle',
        lifecycle_operation: lifecycleOperation,
        target_operation_id: target.operation_id,
        method_identifier: `${lifecycleOperation}_projection`,
        lifecycle_ref: deletionRef,
        expected_revision: target.projection_receipt_ref
          ? store.getReceipt(target.projection_receipt_ref)?.target_revision_after
          : null,
      });
      if (created.disposition === 'exact_replay') {
        results.push({ disposition: 'exact_replay', operation_id: created.operation.operation_id });
        continue;
      }
      const dispatch = await dispatchLifecycleOperation({
        operation_id: created.operation.operation_id,
        targetRefs: target.projection_target_ref ? [target.projection_target_ref] : [],
        deletionRef,
      });
      results.push(dispatch);
    }
    return { queue_item_id: queueItemId, lifecycle_operation: lifecycleOperation, results };
  }

  // Dispatches a lifecycle operation with durable intent -> adapter -> receipt.
  async function dispatchLifecycleOperation({ operation_id, targetRefs, deletionRef }) {
    const operation = store.getOperation(operation_id);
    // The intent must bind the adapter's canonical request digest, exactly
    // like the growth lane (§9.3.5 intent-before-effect).
    const prepared = adapter.prepareLifecycleRequest({
      operation,
      attemptNumber: 1,
      methodIdentifier: operation.method_identifier,
      targetRefs,
    });
    const attempt = store.createDispatchIntent({
      operation_id,
      method_identifier: operation.method_identifier,
      adapter_request_digest: prepared.request_digest,
    });
    try {
      const receipt = await adapter.invokeLifecycle({
        operation,
        attempt,
        methodIdentifier: operation.method_identifier,
        targetRefs,
        prepared,
      });
      store.recordReceipt({ operation_id, receipt });
      return { disposition: receipt.outcome, operation_id, receipt_id: receipt.receipt_id };
    } catch (error) {
      // Method-deny and drift are conclusive pre-effect failures; anything
      // else is an ambiguous observation, never an auto-retry.
      const outcome = ['COMPAT_ADAPTER_METHOD_DENIED', 'COMPAT_ADAPTER_UPSTREAM_DRIFT'].includes(error?.code)
        ? 'failed'
        : 'ambiguous';
      const receipt = buildLocalObservationReceipt({
        operation,
        attempt,
        outcome,
        errorCode: error?.code || 'COMPAT_ADAPTER_UPSTREAM_UNAVAILABLE',
      });
      store.recordReceipt({ operation_id, receipt });
      return { disposition: outcome, operation_id, receipt_id: receipt.receipt_id };
    }
  }

  async function eraseItemPayloads(queueItemId, deletionRef) {
    const item = store.getItem(queueItemId);
    for (const candidate of item.candidates || []) {
      if (candidate.candidate_payload_ref) {
        await erasePayload(candidate.candidate_payload_ref, deletionRef);
      }
    }
  }

  async function erasePayload(ref, deletionRef) {
    if (!ref) return;
    const removed = payloadStore.erase(ref);
    store.recordPayloadErased({ ref, deletion_ref: deletionRef || null, removed });
  }

  // A late worker rechecks lifecycle before executing any queued operation;
  // deleted or tombstoned sources hard-refuse (§8.3 no-resurrection).
  function assertOperationExecutable(operation_id) {
    const operation = store.getOperation(operation_id);
    const source = store.getSource(operation.source_event_id);
    if (['deleting', 'deleted'].includes(source.lifecycle_state)) {
      throw compatError('COMPAT_DELETED', 'source is deleted; late operation refused');
    }
    if (source.lifecycle_state !== 'current') {
      throw compatError('COMPAT_SOURCE_NOT_CURRENT', `source lifecycle is ${source.lifecycle_state}`);
    }
    return true;
  }

  function buildLocalObservationReceipt({ operation, attempt, outcome, errorCode }) {
    const issuedAt = now();
    return {
      receipt_id: newId('ocq_rcpt'),
      receipt_operation_key: operation.operation_key,
      receipt_attempt_id: attempt.attempt_id,
      outcome,
      source_event_id: operation.source_event_id,
      source_revision: operation.source_revision,
      source_event_digest: operation.source_event_digest,
      candidate_payload_ref: operation.candidate_payload_ref,
      candidate_payload_digest: operation.candidate_payload_digest,
      projection_kind: operation.candidate_kind,
      projection_target: operation.projection_target,
      adapter_id: operation.adapter_id,
      adapter_version: operation.adapter_version,
      adapter_policy_digest: operation.adapter_policy_digest,
      upstream_version: operation.upstream_version,
      request_digest: attempt.adapter_request_digest,
      target_projection_ref: null,
      target_revision_before: null,
      target_revision_after: null,
      upstream_evidence_ref: null,
      response_digest: canonicalDigest({ local_observation: errorCode, attempt_id: attempt.attempt_id }),
      idempotency_disposition: 'new',
      receipt_adapter_id: operation.adapter_id,
      receipt_adapter_version: operation.adapter_version,
      receipt_upstream_version: operation.upstream_version,
      issued_at: issuedAt,
      issuer_id: 'steward-lifecycle-lane',
      ambiguous_reason_code: outcome === 'ambiguous' ? 'adapter_observation_unknown' : null,
      error_code: outcome === 'failed' ? errorCode : null,
    };
  }

  return {
    handleSourceLifecycle,
    compatibilityDelete,
    dispatchLifecycleOperation,
    assertOperationExecutable,
  };
}
