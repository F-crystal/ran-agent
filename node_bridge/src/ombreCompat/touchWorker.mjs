// Bounded maintenance touch worker (§7.2, §7.3). Touch is consumed from
// trusted retrieval-used events by an independent worker — never inside a
// read request. In v1 the upstream touch method is UNBOUND_REQUIRED_BEFORE_O2,
// so every touch dispatch ends in a conclusive typed method-deny receipt
// (zero mutation); budgets, operation keys, and receipts are still exercised
// so the maintenance path is fully auditable before the method is ever bound.

import { canonicalDigest } from './canonical.mjs';
import { TOUCH_LIMITS_V1, compatError } from './constants.mjs';

export function createTouchWorker({ store, adapter, clock = () => new Date(), limits = TOUCH_LIMITS_V1 }) {
  function nowMs() {
    const value = clock();
    return (value instanceof Date ? value : new Date(value)).getTime();
  }

  // Records a trusted retrieval-used event (idempotent on retrieval_event_id).
  function recordRetrievalUsed(retrievalEvent) {
    return store.recordRetrievalUsed(retrievalEvent);
  }

  // Processes the touch plan for one recorded retrieval-used event. Returns a
  // per-item report; each touch is its own operation with its own receipt.
  async function processRetrievalEvent({ retrieval_event_id }) {
    const view = store.exportView();
    const record = view.retrievalEvents.find((entry) => entry.retrieval_event_id === retrieval_event_id);
    if (!record) {
      throw compatError('COMPAT_INGRESS_INVALID', `unknown retrieval event ${retrieval_event_id}`);
    }
    const itemRefs = touchTargets(record);
    if (itemRefs.length > limits.max_items_per_retrieval_event) {
      throw compatError('COMPAT_BUDGET_EXCEEDED', 'retrieval event exceeds per-event touch budget');
    }
    const results = [];
    for (const itemRef of itemRefs) {
      results.push(await processOneTouch({ record, itemRef, view }));
    }
    return { retrieval_event_id, results };
  }

  function touchTargets(record) {
    const refs = [];
    if (record.projection_item_ref) refs.push(record.projection_item_ref);
    if (Array.isArray(record.projection_item_refs)) refs.push(...record.projection_item_refs);
    return Array.from(new Set(refs.filter(Boolean)));
  }

  async function processOneTouch({ record, itemRef, view }) {
    // Idempotency: a prior operation for (retrieval event, item) replays.
    const prior = priorTouch(record.retrieval_event_id, itemRef, view);
    if (prior) {
      return { item_ref: itemRef, disposition: 'exact_replay', operation_id: prior.operation_id };
    }
    // Budget: one successful touch per (event, item); per-item 24h cooldown.
    if (hasSuccessfulTouch(record.retrieval_event_id, itemRef, view)) {
      return { item_ref: itemRef, disposition: 'skipped', reason: 'already_touched_for_event' };
    }
    if (withinCooldown(itemRef, view)) {
      return { item_ref: itemRef, disposition: 'skipped', reason: 'item_cooldown' };
    }
    // Lifecycle: deleted / withdrawn / suppressed sources refuse touch.
    const producer = producingOperation(itemRef, view);
    if (!producer) {
      return { item_ref: itemRef, disposition: 'skipped', reason: 'unknown_projection_item' };
    }
    const source = view.sources.find((entry) => entry.event_id === producer.source_event_id);
    if (!source || source.lifecycle_state !== 'current') {
      return { item_ref: itemRef, disposition: 'rejected', reason: 'source_not_current' };
    }
    if (view.tombstones.some((entry) => entry.target_ref === itemRef)) {
      return { item_ref: itemRef, disposition: 'rejected', reason: 'tombstoned' };
    }

    const created = store.createLifecycleItem({
      item_class: 'touch',
      lifecycle_operation: null,
      target_operation_id: producer.operation_id,
      method_identifier: 'bounded_retrieval_touch',
      retryable: false,
      key_material_extra: { retrieval_event_id: record.retrieval_event_id, projection_item_ref: itemRef },
    });
    if (created.disposition === 'exact_replay') {
      return { item_ref: itemRef, disposition: 'exact_replay', operation_id: created.operation.operation_id };
    }
    store.registerTouch({
      retrieval_event_id: record.retrieval_event_id,
      projection_item_ref: itemRef,
      operation_id: created.operation.operation_id,
    });

    const operation = created.operation;
    const requestDigest = canonicalDigest({
      method_identifier: 'bounded_retrieval_touch',
      operation_key: operation.operation_key,
      projection_item_ref: itemRef,
      retrieval_event_id: record.retrieval_event_id,
    });
    const attempt = store.createDispatchIntent({
      operation_id: operation.operation_id,
      method_identifier: 'bounded_retrieval_touch',
      adapter_request_digest: requestDigest,
    });
    try {
      const receipt = await adapter.invokeGrowth({
        operation,
        attempt,
        methodIdentifier: 'bounded_retrieval_touch',
        payloadBody: null,
      });
      store.recordReceipt({ operation_id: operation.operation_id, receipt });
      return { item_ref: itemRef, disposition: receipt.outcome, operation_id: operation.operation_id };
    } catch (error) {
      if (error?.code === 'COMPAT_ADAPTER_METHOD_DENIED') {
        // v1 frozen posture: touch is UNBOUND; typed conclusive denial, zero
        // mutation, non-retryable.
        const receipt = denyReceipt({ operation, attempt, errorCode: error.code });
        store.recordReceipt({ operation_id: operation.operation_id, receipt });
        return { item_ref: itemRef, disposition: 'denied_unbound', operation_id: operation.operation_id };
      }
      const receipt = ambiguousReceipt({ operation, attempt });
      store.recordReceipt({ operation_id: operation.operation_id, receipt });
      return { item_ref: itemRef, disposition: 'ambiguous', operation_id: operation.operation_id };
    }
  }

  function priorTouch(retrievalEventId, itemRef, view) {
    return view.operations.find((operation) => operation.candidate_kind === 'lifecycle:touch'
      && operation.touch_retrieval_event_id === retrievalEventId
      && operation.touch_projection_item_ref === itemRef) || null;
  }

  function hasSuccessfulTouch(retrievalEventId, itemRef, view) {
    return view.operations.some((operation) => operation.candidate_kind === 'lifecycle:touch'
      && operation.touch_retrieval_event_id === retrievalEventId
      && operation.touch_projection_item_ref === itemRef
      && operation.state === 'published');
  }

  function withinCooldown(itemRef, view) {
    const cutoff = nowMs() - limits.item_cooldown_ms;
    return view.receipts.some((receipt) => receipt.outcome === 'succeeded'
      && receipt.touch_projection_item_ref === itemRef
      && Date.parse(receipt.issued_at) > cutoff);
  }

  function producingOperation(itemRef, view) {
    return view.operations.find((operation) => operation.state === 'published'
      && operation.projection_target_ref === itemRef) || null;
  }

  function denyReceipt({ operation, attempt, errorCode }) {
    return baseReceipt({ operation, attempt, outcome: 'failed', errorCode });
  }

  function ambiguousReceipt({ operation, attempt }) {
    return {
      ...baseReceipt({ operation, attempt, outcome: 'ambiguous', errorCode: null }),
      ambiguous_reason_code: 'adapter_observation_unknown',
    };
  }

  function baseReceipt({ operation, attempt, outcome, errorCode }) {
    const issuedAt = new Date(nowMs()).toISOString();
    return {
      receipt_id: `ocq_rcpt_touch_${operation.operation_key.slice(-16)}_${attempt.attempt_number}`,
      receipt_operation_key: operation.operation_key,
      receipt_attempt_id: attempt.attempt_id,
      outcome,
      source_event_id: operation.source_event_id,
      source_revision: operation.source_revision,
      source_event_digest: operation.source_event_digest,
      candidate_payload_ref: operation.candidate_payload_ref,
      candidate_payload_digest: operation.candidate_payload_digest,
      projection_kind: 'bounded_retrieval_touch',
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
      response_digest: canonicalDigest({ touch_observation: outcome, error: errorCode }),
      idempotency_disposition: 'new',
      receipt_adapter_id: operation.adapter_id,
      receipt_adapter_version: operation.adapter_version,
      receipt_upstream_version: operation.upstream_version,
      issued_at: issuedAt,
      issuer_id: 'steward-touch-worker',
      ambiguous_reason_code: null,
      error_code: errorCode,
      touch_projection_item_ref: operation.touch_projection_item_ref || null,
      touch_retrieval_event_id: operation.touch_retrieval_event_id || null,
    };
  }

  return { recordRetrievalUsed, processRetrievalEvent };
}
