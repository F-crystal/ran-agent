// Trusted reconciler (§5.5, §9.3.4–§9.3.6). Ambiguous mutation outcomes are
// never retried blindly: the reconciler performs read-only evidence queries
// through the pinned adapter reconciliation method and reduces the attempt to
// succeeded / failed via a conclusive receipt, or records an explicit
// ambiguous observation when evidence stays inconclusive. It never mutates.

import { canonicalDigest, newId } from './canonical.mjs';
import { compatError } from './constants.mjs';

export function createReconciler({ store, adapter, clock = () => new Date() }) {
  function now() {
    const value = clock();
    return (value instanceof Date ? value : new Date(value)).toISOString();
  }

  // Drives one ambiguous operation through reconciliation. Returns a typed
  // disposition: 'observed_applied' | 'observed_not_applied' | 'unknown'.
  async function reconcileOperation({ operation_id }) {
    const operation = store.getOperation(operation_id);
    if (!['ambiguous', 'reconciling'].includes(operation.state)) {
      throw compatError(
        'COMPAT_AMBIGUOUS_REQUIRES_RECONCILIATION',
        `operation ${operation_id} is ${operation.state}, not ambiguous`,
      );
    }
    const attempts = store.listAttempts().filter((attempt) => attempt.operation_id === operation_id);
    const attempt = attempts[attempts.length - 1];
    if (!attempt) throw compatError('COMPAT_STORE_CORRUPT', 'ambiguous operation without attempt');
    const reconciliation_operation_id = newId('ocq_recon');
    store.startReconciliation({
      operation_id,
      attempt_id: attempt.attempt_id,
      reconciliation_operation_id,
    });

    const observation = await adapter.reconcile({
      operation,
      attempt,
      methodIdentifier: attempt.method_identifier,
    });
    const evidenceRefs = Array.isArray(observation?.evidence_refs) ? observation.evidence_refs : [];
    const evidenceDigest = canonicalDigest({
      reconciliation_operation_id,
      disposition: observation?.disposition || 'unknown',
      evidence_refs: evidenceRefs,
    });
    store.recordReconciliationEvidence({
      operation_id,
      evidence_refs: evidenceRefs,
      evidence_digest: evidenceDigest,
    });

    if (observation?.disposition === 'observed_applied') {
      const receipt = buildReceipt({
        operation,
        attempt,
        outcome: 'succeeded',
        observation,
        evidenceDigest,
        reconciliation_operation_id,
        issuedAt: now(),
      });
      store.recordReceipt({ operation_id, receipt });
      return { disposition: 'observed_applied', receipt_id: receipt.receipt_id };
    }
    if (observation?.disposition === 'observed_not_applied') {
      const receipt = buildReceipt({
        operation,
        attempt,
        outcome: 'failed',
        observation,
        evidenceDigest,
        reconciliation_operation_id,
        issuedAt: now(),
      });
      store.recordReceipt({ operation_id, receipt });
      return { disposition: 'observed_not_applied', receipt_id: receipt.receipt_id };
    }
    // Still unknown: record an explicit ambiguous observation (§5.5) and fall
    // back to ambiguous; the operation never auto-retries.
    const receipt = buildReceipt({
      operation,
      attempt,
      outcome: 'ambiguous',
      observation: { disposition: 'unknown', ambiguous_reason_code: 'reconciliation_inconclusive' },
      evidenceDigest,
      reconciliation_operation_id,
      issuedAt: now(),
    });
    store.recordReceipt({ operation_id, receipt });
    return { disposition: 'unknown', receipt_id: receipt.receipt_id };
  }

  function buildReceipt({
    operation,
    attempt,
    outcome,
    observation,
    evidenceDigest,
    reconciliation_operation_id,
    issuedAt,
  }) {
    const base = {
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
      response_digest: evidenceDigest,
      idempotency_disposition: 'new',
      receipt_adapter_id: operation.adapter_id,
      receipt_adapter_version: operation.adapter_version,
      receipt_upstream_version: operation.upstream_version,
      issued_at: issuedAt,
      issuer_id: 'steward-reconciler',
      reconciliation_operation_id,
      reconciliation_evidence_refs: observation.evidence_refs || [],
      reconciliation_evidence_digest: evidenceDigest,
      reconciled_at: issuedAt,
    };
    if (outcome === 'succeeded') {
      return {
        ...base,
        target_projection_ref: observation.target_projection_ref,
        target_revision_before: observation.target_revision_before,
        target_revision_after: observation.target_revision_after,
        upstream_evidence_ref: observation.upstream_evidence_ref,
        ambiguous_reason_code: null,
        error_code: null,
      };
    }
    if (outcome === 'failed') {
      return {
        ...base,
        target_projection_ref: null,
        target_revision_before: observation.target_revision_before ?? null,
        target_revision_after: null,
        upstream_evidence_ref: observation.upstream_evidence_ref || null,
        ambiguous_reason_code: null,
        error_code: 'observed_not_applied',
      };
    }
    return {
      ...base,
      target_projection_ref: null,
      target_revision_before: null,
      target_revision_after: null,
      upstream_evidence_ref: null,
      ambiguous_reason_code: observation.ambiguous_reason_code || 'reconciliation_inconclusive',
      error_code: null,
    };
  }

  return { reconcileOperation };
}
