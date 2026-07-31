// Pipeline orchestrator (§5): drives one queue item through
// received -> curating -> reviewing -> gate_pending -> authorized
// -> dispatching -> published/failed/ambiguous -> reconciling -> refresh.
// Every stage re-binds event id, revision, digests, scope, sensitivity,
// operation key, and protocol versions; any binding mismatch fails closed
// (§5: no "write anyway"). The orchestrator owns no semantic judgment — the
// Curator/Reviewer are tool-less model calls, the gate is deterministic.

import { buildCuratorEnvelope, runCuratorInvocation } from './curator.mjs';
import { buildReviewerEnvelope, runReviewerInvocation } from './reviewer.mjs';
import { evaluatePublicationGate } from './gate.mjs';
import { canonicalDigest, newId, utf8ByteLength } from './canonical.mjs';
import {
  BUDGET_PROFILE_V1,
  COMPAT_GATE_POLICY_VERSION,
  COMPAT_UPSTREAM_VERSION,
} from './constants.mjs';

// Typed retry policy: only these bounded error classes may schedule a new
// attempt (budget permitting). Ambiguous outcomes never retry (§5.5, §6.3).
const RETRYABLE_ERROR_CODES = new Set([
  'observed_not_applied',
  'upstream_unavailable',
  'upstream_temporary',
  'upstream_error',
]);

// Adapter-thrown typed errors that prove the upstream request never started
// (§9.3.5 row 4): version drift, method deny, invalid candidate, and a failed
// pre-dispatch health check all happen before any mutation invocation, so the
// conclusive outcome is failed — never ambiguous.
const PRE_EFFECT_FAILURE_CODES = new Map([
  ['COMPAT_ADAPTER_METHOD_DENIED', 'COMPAT_ADAPTER_METHOD_DENIED'],
  ['COMPAT_ADAPTER_UPSTREAM_DRIFT', 'COMPAT_ADAPTER_UPSTREAM_DRIFT'],
  ['COMPAT_CANDIDATE_INVALID', 'COMPAT_CANDIDATE_INVALID'],
  ['COMPAT_ADAPTER_UPSTREAM_UNAVAILABLE', 'upstream_unavailable'],
]);

export function createCompatWorker({
  store,
  payloadStore,
  adapter,
  refresher = null,
  reconciler = null,
  curatorConfig,
  reviewerConfig,
  sourceTextResolver,
  curatorImpl = null,
  reviewerImpl = null,
  checkpointGuard,
  itemEligible = () => true,
  beforeCheckpoint = null,
  afterCheckpoint = null,
  clock = () => new Date(),
  budgetProfile = BUDGET_PROFILE_V1,
  gatePolicyVersion = COMPAT_GATE_POLICY_VERSION,
  upstreamVersion = COMPAT_UPSTREAM_VERSION,
}) {
  if (typeof checkpointGuard !== 'function') {
    throw new Error('compat worker requires a source checkpoint guard');
  }
  function now() {
    const value = clock();
    return (value instanceof Date ? value : new Date(value)).toISOString();
  }

  // Drives one item as far as its current state allows. Returns a typed
  // progress report; callers may loop until `progress === false`.
  async function processQueueItem(queue_item_id) {
    const item = store.getItem(queue_item_id);
    switch (item.queue_item_state) {
      case 'received':
      case 'curating':
        return runCuratorStage(item);
      case 'reviewing':
        return runReviewerStage(item);
      case 'gate_pending':
        return runGateStage(item);
      case 'authorized':
        return runDispatchStage(item);
      case 'failed':
        return runRetryStage(item);
      case 'ambiguous':
        return runReconcileStage(item);
      case 'published':
        return runRefreshStage(item);
      default:
        return { queue_item_id, progress: false, state: item.queue_item_state };
    }
  }

  // Processes every non-terminal item once (deterministic order).
  async function runPending() {
    const items = store.listItems()
      .filter((item) => ['received', 'curating', 'reviewing', 'gate_pending', 'authorized', 'failed', 'ambiguous', 'published']
        .includes(item.queue_item_state))
      .filter((item) => itemEligible(item))
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    const reports = [];
    for (const item of items) {
      if (item.queue_item_state === 'published') {
        const fresh = store.getItem(item.queue_item_id);
        if (['pending', 'failed'].includes(fresh.revision_refresh_state)) {
          reports.push(await runRefreshStage(fresh));
        }
        continue;
      }
      if (item.queue_item_state === 'failed') {
        const fresh = store.getItem(item.queue_item_id);
        reports.push(await runRetryStage(fresh));
        continue;
      }
      reports.push(await processQueueItem(item.queue_item_id));
    }
    return reports;
  }

  // ------------------------------------------------------------- curator --
  async function runCuratorStage(item) {
    await guard('C1', item);
    const source = store.getSource(item.source_event_id);
    const binding = source.revisions.find((revision) => revision.source_revision === item.source_revision)
      || source.revisions[source.revisions.length - 1];
    const texts = await sourceTextResolver({ binding });
    const envelope = buildCuratorEnvelope({
      sourceEvent: binding,
      payloadTexts: texts,
      maxPayloadChars: budgetProfile.max_candidate_payload_utf8_bytes,
    });
    // The tool-less invocation runs first; its returned provenance (real
    // invocation id, empty-tool digest, input digest) is what the queue
    // records. A crash mid-call leaves the item at received/curating and the
    // next run re-invokes with a fresh invocation id (§9.3.3).
    const result = await runCuratorInvocation({
      envelope,
      config: curatorConfig,
      curatorImpl,
      clock,
    });
    store.startCurator({
      queue_item_id: item.queue_item_id,
      invocation: result.invocation,
    });
    if (result.status !== 'completed') {
      const errorCode = result.status === 'timeout' ? 'COMPAT_CURATOR_UNAVAILABLE'
        : result.status === 'malformed' ? 'COMPAT_CURATOR_MALFORMED'
          : 'COMPAT_CURATOR_UNAVAILABLE';
      store.failCurator({
        queue_item_id: item.queue_item_id,
        error_code: errorCode,
        output_digest: result.output_digest || null,
      });
      return { queue_item_id: item.queue_item_id, progress: true, stage: 'curator', outcome: result.status };
    }
    const candidates = [];
    for (const [index, raw] of (result.candidates || []).entries()) {
      const stored = payloadStore.put({
        kind: raw.candidate_kind,
        body: raw.first_person_text,
        deletion_domain: 'compat_payload_default',
        created_at: now(),
        owner_item: item.queue_item_id,
        source_ref: binding.event_id,
      });
      store.recordPayloadStored({
        ref: stored.ref,
        digest: stored.digest,
        deletion_domain: 'compat_payload_default',
      });
      candidates.push({
        candidate_id: newId('ocq_cand'),
        candidate_kind: raw.candidate_kind,
        title: typeof raw.title === 'string' ? raw.title : '',
        candidate_payload_ref: stored.ref,
        candidate_payload_digest: stored.digest,
        candidate_payload_bytes: utf8ByteLength(raw.first_person_text),
        candidate_source_refs: Array.isArray(raw.source_refs) ? raw.source_refs : [],
        curator_candidate_payload_digest: stored.digest,
        candidate_claim_manifest_ref: null,
        claim_manifest: null,
        projection_target: 'ombre_local_projection',
        deletion_domain: 'compat_payload_default',
        scope_envelope_digest: binding.scope_envelope_digest,
        sensitivity: raw.sensitivity || binding.sensitivity,
        counterevidence: raw.counterevidence || null,
        uncertainty: raw.uncertainty || null,
        supersedes_operation_id: null,
        ordinal: index,
      });
    }
    store.completeCurator({
      queue_item_id: item.queue_item_id,
      curator_output_digest: result.output_digest,
      candidates,
    });
    return { queue_item_id: item.queue_item_id, progress: true, stage: 'curator', outcome: 'completed', candidates: candidates.length };
  }

  // ------------------------------------------------------------ reviewer --
  async function runReviewerStage(item) {
    await guard('C2', item);
    const source = store.getSource(item.source_event_id);
    const binding = source.revisions.find((revision) => revision.source_revision === item.source_revision)
      || source.revisions[source.revisions.length - 1];
    // The Reviewer receives model-shaped candidates (title + first-person
    // text), never the queue's internal record internals or Curator's private
    // reasoning (§5.2).
    const reviewerCandidates = item.candidates.map((candidate) => ({
      candidate_kind: candidate.candidate_kind,
      title: candidate.title || '',
      first_person_text: payloadStore.get(candidate.candidate_payload_ref).body,
      source_refs: candidate.candidate_source_refs || [],
      scope_envelope_digest: candidate.scope_envelope_digest,
      sensitivity: candidate.sensitivity,
      counterevidence: candidate.counterevidence || null,
      uncertainty: candidate.uncertainty || null,
    }));
    const payloadTexts = Object.fromEntries(item.candidates.map((candidate) => [
      candidate.candidate_id,
      payloadStore.get(candidate.candidate_payload_ref).body,
    ]));
    const envelope = buildReviewerEnvelope({
      sourceEvent: binding,
      candidates: reviewerCandidates,
      payloadTexts,
    });
    const result = await runReviewerInvocation({
      envelope,
      config: reviewerConfig,
      reviewerImpl,
      clock,
    });
    store.startReviewer({
      queue_item_id: item.queue_item_id,
      invocation: result.invocation,
    });
    if (result.status !== 'completed') {
      const errorCode = result.status === 'malformed' ? 'COMPAT_REVIEWER_MALFORMED' : 'COMPAT_REVIEWER_UNAVAILABLE';
      store.completeReviewer({
        queue_item_id: item.queue_item_id,
        decision: 'reject',
        reviewer_revision: 0,
        reviewer_output_digest: result.output_digest || null,
        final_candidates: [],
        reason_code: errorCode,
      });
      return { queue_item_id: item.queue_item_id, progress: true, stage: 'reviewer', outcome: result.status };
    }
    const finalCandidates = [];
    const rawFinals = result.decision === 'accept' ? item.candidates : result.final_candidates;
    for (const [index, raw] of rawFinals.entries()) {
      if (result.decision === 'accept') {
        finalCandidates.push({
          ...raw,
          claim_manifest: result.claim_manifest || raw.claim_manifest || null,
        });
        continue;
      }
      const stored = payloadStore.put({
        kind: raw.candidate_kind,
        body: raw.first_person_text,
        deletion_domain: 'compat_payload_default',
        created_at: now(),
        owner_item: item.queue_item_id,
        source_ref: binding.event_id,
      });
      store.recordPayloadStored({
        ref: stored.ref,
        digest: stored.digest,
        deletion_domain: 'compat_payload_default',
      });
      finalCandidates.push({
        candidate_id: newId('ocq_cand'),
        candidate_kind: raw.candidate_kind,
        title: typeof raw.title === 'string' ? raw.title : '',
        candidate_payload_ref: stored.ref,
        candidate_payload_digest: stored.digest,
        candidate_payload_bytes: utf8ByteLength(raw.first_person_text),
        candidate_source_refs: Array.isArray(raw.source_refs) ? raw.source_refs : [],
        curator_candidate_payload_digest: item.candidates[index]?.candidate_payload_digest || stored.digest,
        candidate_claim_manifest_ref: null,
        claim_manifest: result.claim_manifest || null,
        projection_target: 'ombre_local_projection',
        deletion_domain: 'compat_payload_default',
        scope_envelope_digest: binding.scope_envelope_digest,
        sensitivity: raw.sensitivity || binding.sensitivity,
        supersedes_operation_id: null,
        ordinal: index,
      });
    }
    store.completeReviewer({
      queue_item_id: item.queue_item_id,
      decision: result.decision,
      reviewer_revision: result.reviewer_revision,
      reviewer_output_digest: result.output_digest,
      final_candidates: finalCandidates,
      reason_code: result.reason_code || null,
    });
    return { queue_item_id: item.queue_item_id, progress: true, stage: 'reviewer', outcome: result.decision };
  }

  // ----------------------------------------------------------------- gate --
  // Maps store-canonical candidate records into the gate's typed view (the
  // gate is pure and never sees payload bodies, §5.3).
  function gateCandidateView(candidate) {
    const manifest = candidate.claim_manifest;
    const claims = Array.isArray(manifest) ? manifest : Array.isArray(manifest?.claims) ? manifest.claims : [];
    return {
      candidate_id: candidate.candidate_id,
      candidate_kind: candidate.candidate_kind,
      candidate_payload_ref: candidate.candidate_payload_ref,
      candidate_payload_digest: candidate.candidate_payload_digest,
      curator_candidate_payload_digest: candidate.curator_candidate_payload_digest || candidate.candidate_payload_digest,
      projection_target: candidate.projection_target,
      deletion_domain: candidate.deletion_domain,
      scope_envelope_digest: candidate.scope_envelope_digest,
      sensitivity: candidate.sensitivity,
      payload_bytes: candidate.candidate_payload_bytes,
      source_refs: candidate.candidate_source_refs || [],
      claim_manifest: claims,
      supersedes_operation_id: candidate.supersedes_operation_id || null,
    };
  }

  async function runGateStage(item) {
    await guard('C3', item);
    const source = store.getSource(item.source_event_id);
    const binding = source.revisions.find((revision) => revision.source_revision === item.source_revision)
      || source.revisions[source.revisions.length - 1];
    const currentBinding = source.revisions.find((revision) => revision.source_revision === source.current_revision)
      || binding;
    const view = store.exportView();
    const growthOperations = view.operations.filter((operation) => operation.source_event_id === item.source_event_id
      && !operation.lifecycle_operation
      && operation.candidate_kind !== 'lifecycle:touch');
    const gateStoreView = {
      fence: view.fence,
      adapter_policy_digest: store.adapterPolicyDigest,
      current_revision_binding: currentBinding
        ? {
            source_revision: currentBinding.source_revision,
            source_event_digest: currentBinding.source_event_digest,
            final_content_digest: currentBinding.final_content_digest,
            lifecycle_state: currentBinding.lifecycle_state,
          }
        : null,
      tombstone: view.tombstones.find((tombstone) => item.candidates.some(
        (candidate) => candidate.candidate_payload_ref === tombstone.target_ref,
      )) || null,
      prior_authorized_count: growthOperations.filter((operation) => !['failed', 'fenced'].includes(operation.state)).length,
      prior_authorized_i_observation_count: growthOperations.filter(
        (operation) => operation.candidate_kind === 'append_i_observation_candidate'
          && !['failed', 'fenced'].includes(operation.state),
      ).length,
    };
    const evaluation = evaluatePublicationGate({
      item,
      candidates: item.candidates.map(gateCandidateView),
      source: {
        ...source,
        source_revision: item.source_revision,
        source_event_digest: item.source_event_digest,
      },
      binding,
      storeView: gateStoreView,
      budgetProfile,
      adapterPolicyDigest: store.adapterPolicyDigest,
      upstreamVersion,
      gatePolicyVersion,
      clock,
    });
    const decisions = evaluation.decisions.map((decision) => ({
      candidate: decision.candidate,
      decision: decision.decision,
      reason_code: decision.reason_code,
    }));
    const operations = store.applyGateDecision({
      queue_item_id: item.queue_item_id,
      gate_provenance: evaluation.gate_provenance,
      decisions,
      item_outcome: evaluation.item_outcome,
      next_attempt_at: evaluation.next_attempt_at || null,
    });
    return {
      queue_item_id: item.queue_item_id,
      progress: true,
      stage: 'gate',
      item_outcome: evaluation.item_outcome,
      authorized: operations.length,
    };
  }

  // ------------------------------------------------------------- dispatch --
  async function runDispatchStage(item) {
    const results = [];
    for (const operationId of item.operation_ids) {
      const operation = store.getOperation(operationId);
      if (operation.state !== 'authorized') continue;
      results.push(await dispatchOperation({ operation, attemptNumber: 1 }));
    }
    return { queue_item_id: item.queue_item_id, progress: results.length > 0, stage: 'dispatch', results };
  }

  async function runRetryStage(item) {
    const results = [];
    for (const operationId of item.operation_ids) {
      const operation = store.getOperation(operationId);
      if (operation.state !== 'failed' || !operation.retryable) continue;
      if (!RETRYABLE_ERROR_CODES.has(operation.last_error_code || '')) continue;
      results.push(await dispatchOperation({
        operation,
        attemptNumber: operation.attempt_count + 1,
        retry: true,
      }));
    }
    return { queue_item_id: item.queue_item_id, progress: results.length > 0, stage: 'retry', results };
  }

  async function dispatchOperation({ operation, attemptNumber, retry = false }) {
    const item = store.getItem(operation.queue_item_id);
    await guard('C4', item, operation);
    const payloadBody = operation.candidate_payload_ref
      ? payloadStore.get(operation.candidate_payload_ref).body
      : null;
    const prepared = adapter.prepareGrowthRequest({
      operation,
      attemptNumber,
      methodIdentifier: operation.candidate_kind,
      payloadBody,
    });
    const attempt = retry
      ? store.createRetryDispatch({
        operation_id: operation.operation_id,
        method_identifier: operation.candidate_kind,
        adapter_request_digest: prepared.request_digest,
      })
      : store.createDispatchIntent({
        operation_id: operation.operation_id,
        method_identifier: operation.candidate_kind,
        adapter_request_digest: prepared.request_digest,
        expected_source_revision: operation.source_revision,
      });
    try {
      await guard('C5', item, operation, attempt);
    } catch (error) {
      if (error?.code === 'COMPAT_STALE_SOURCE_REVISION') {
        store.markAttemptSourceSuperseded({ attempt_id: attempt.attempt_id });
      }
      throw error;
    }
    let receipt;
    try {
      receipt = await adapter.invokeGrowth({
        operation,
        attempt,
        methodIdentifier: operation.candidate_kind,
        payloadBody,
        prepared,
      });
    } catch (error) {
      const errorCode = PRE_EFFECT_FAILURE_CODES.get(error?.code);
      if (!errorCode) throw error;
      receipt = preEffectFailureReceipt({ operation, attempt, errorCode });
    }
    store.recordReceipt({ operation_id: operation.operation_id, receipt });
    return { operation_id: operation.operation_id, outcome: receipt.outcome, receipt_id: receipt.receipt_id };
  }

  // Conclusive pre-effect failure: the adapter proved the mutation request
  // never reached the upstream, so failed (not ambiguous) is the only honest
  // outcome. Retryability flows from the typed error code (§9.3.4).
  function preEffectFailureReceipt({ operation, attempt, errorCode }) {
    const issuedAt = now();
    return {
      receipt_id: newId('ocq_rcpt'),
      receipt_operation_key: operation.operation_key,
      receipt_attempt_id: attempt.attempt_id,
      outcome: 'failed',
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
      response_digest: canonicalDigest({ pre_effect_failure: errorCode, attempt_id: attempt.attempt_id }),
      idempotency_disposition: 'new',
      receipt_adapter_id: operation.adapter_id,
      receipt_adapter_version: operation.adapter_version,
      receipt_upstream_version: operation.upstream_version,
      issued_at: issuedAt,
      issuer_id: 'steward-adapter',
      ambiguous_reason_code: null,
      error_code: errorCode,
    };
  }

  // ------------------------------------------------------------ reconcile --
  async function runReconcileStage(item) {
    if (!reconciler) return { queue_item_id: item.queue_item_id, progress: false, stage: 'reconcile', reason: 'no_reconciler' };
    const results = [];
    for (const operationId of item.operation_ids) {
      const operation = store.getOperation(operationId);
      if (!['ambiguous', 'reconciling'].includes(operation.state)) continue;
      await guard('C6', item, operation);
      results.push(await reconciler.reconcileOperation({ operation_id: operation.operation_id }));
    }
    return { queue_item_id: item.queue_item_id, progress: results.length > 0, stage: 'reconcile', results };
  }

  // -------------------------------------------------------------- refresh --
  async function runRefreshStage(item) {
    if (!refresher) return { queue_item_id: item.queue_item_id, progress: false, stage: 'refresh', reason: 'no_refresher' };
    const fresh = store.getItem(item.queue_item_id);
    if (!['pending', 'failed'].includes(fresh.revision_refresh_state)) {
      return { queue_item_id: item.queue_item_id, progress: false, stage: 'refresh', reason: 'not_required' };
    }
    const lastReceipt = fresh.operation_ids
      .map((id) => store.getOperation(id))
      .map((operation) => operation.projection_receipt_ref)
      .filter(Boolean)
      .pop();
    await guard('C7', fresh);
    const result = await refresher.refresh({
      queue_item_id: item.queue_item_id,
      reason: 'projection_succeeded',
      last_projection_receipt_id: lastReceipt || null,
      source_cursor: store.logHead().digest,
    });
    return { queue_item_id: item.queue_item_id, progress: true, stage: 'refresh', result: result?.status || 'unknown' };
  }

  return { processQueueItem, runPending };

  async function guard(checkpoint, item, operation = null, attempt = null) {
    if (typeof beforeCheckpoint === 'function') {
      await beforeCheckpoint({ checkpoint, item, operation, attempt });
    }
    const result = await checkpointGuard({
      checkpoint,
      expected_source_revision: item.expected_source_revision ?? item.source_revision,
      item: store.getItem(item.queue_item_id),
      operation,
      attempt,
    });
    if (typeof afterCheckpoint === 'function') {
      await afterCheckpoint({ checkpoint, item, operation, attempt });
    }
    return result;
  }
}
