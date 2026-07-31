// Deterministic publication gate (§5.3) for the Ombre O2 compatibility layer.
//
// The gate does NOT understand natural language: it uses no word lists, no
// regular expressions over content, no sentiment or intent classifiers, and
// no LLM simulators. It never reads candidate payload bodies — payloads live
// behind opaque refs in the payload store and never enter this module; only
// digests, declared byte counts, and typed flags are inspected. Every check
// is a mechanical comparison over frozen contract fields: schema and protocol
// versions, digest bindings, source lifecycle and fence state, scope and
// sensitivity ladders, typed forbidden-class flags, reviewer binding, pinned
// adapter identity, and the versioned growth budget (§6.3). Identical typed
// input always yields identical output and an identical gate_input_digest.
//
// The result is shaped for queueStore.applyGateDecision({ queue_item_id,
// gate_provenance, decisions, item_outcome, next_attempt_at }): each decision
// is { candidate, decision, reason_code }, and an authorized candidate carries
// exactly the fields buildOperation consumes (candidate_id, candidate_kind,
// candidate_payload_ref, candidate_payload_digest, projection_target,
// deletion_domain, supersedes_operation_id). The function is pure: it mutates
// nothing, touches no I/O, and returns a deep-frozen result.
//
// storeView is a plain typed snapshot (no live store required):
// {
//   fence: null | { fence_revision, ... },
//   adapter_policy_digest: string,                 // pinned store policy digest
//   current_revision_binding: null | { source_revision, source_event_digest,
//                                      final_content_digest, lifecycle_state },
//   tombstone: null | { tombstone_ref, ... },      // tombstone for this source
//   prior_authorized_count: number,                // authorized in earlier gate
//   prior_authorized_i_observation_count: number,  // passes of this source event
// }

import {
  canonicalDigest,
  deepFreezeClone,
  isSha256Digest,
} from './canonical.mjs';
import {
  CLAIM_KINDS,
  COMPAT_CURATOR_PROTOCOL_VERSION,
  COMPAT_DELETION_DOMAINS,
  COMPAT_PROJECTION_TARGETS,
  COMPAT_REVIEWER_PROTOCOL_VERSION,
  COMPAT_UPSTREAM_VERSION,
  MODEL_CANDIDATE_KINDS,
  SENSITIVITY_LEVELS,
} from './constants.mjs';

// Implementation-local retry delay for budget-deferred items. The contract
// freezes the budget ceilings (§6.3) but no deferral delay; this value is a
// v1 choice and is not part of the frozen contract.
export const GATE_DEFERRED_RETRY_DELAY_MS = 60 * 1000;

// Reviewer decisions the gate can bind (§5.2). `reject` never reaches the
// gate: the queue item is already terminal at the reviewer stage.
const GATE_REVIEWER_DECISIONS = Object.freeze(['accept', 'revise', 'split']);

// §9.3.1 provenance fields the gate requires on every queue item.
const CURATOR_STRING_FIELDS = Object.freeze([
  'curator_invocation_id',
  'curator_invocation_ref',
  'curator_model_id',
  'curator_model_version',
]);
const CURATOR_DIGEST_FIELDS = Object.freeze([
  'curator_input_digest',
  'curator_output_digest',
]);
const REVIEWER_STRING_FIELDS = Object.freeze([
  'reviewer_invocation_id',
  'reviewer_invocation_ref',
  'reviewer_model_id',
  'reviewer_model_version',
]);
const REVIEWER_DIGEST_FIELDS = Object.freeze([
  'reviewer_input_digest',
  'reviewer_output_digest',
]);

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Typed input views: exactly the fields the gate is allowed to read. Payload
// bodies, claim prose, or any other natural-language content attached to the
// records is neither read nor copied into decisions or the audit digest.
// ---------------------------------------------------------------------------

function typedClaimView(claim) {
  const record = isRecord(claim) ? claim : {};
  return {
    claim_kind: record.claim_kind ?? null,
    forbidden_classes: Array.isArray(record.forbidden_classes) ? [...record.forbidden_classes] : null,
    receipt_refs: Array.isArray(record.receipt_refs) ? [...record.receipt_refs] : null,
  };
}

function typedCandidateView(candidate) {
  const record = isRecord(candidate) ? candidate : {};
  return {
    candidate_id: record.candidate_id ?? null,
    candidate_kind: record.candidate_kind ?? null,
    candidate_payload_ref: record.candidate_payload_ref ?? null,
    candidate_payload_digest: record.candidate_payload_digest ?? null,
    curator_candidate_payload_digest: record.curator_candidate_payload_digest ?? null,
    projection_target: record.projection_target ?? null,
    deletion_domain: record.deletion_domain ?? null,
    scope_envelope_digest: record.scope_envelope_digest ?? null,
    sensitivity: record.sensitivity ?? null,
    payload_bytes: record.payload_bytes ?? null,
    source_refs: Array.isArray(record.source_refs) ? [...record.source_refs] : null,
    claim_manifest: Array.isArray(record.claim_manifest) ? record.claim_manifest.map(typedClaimView) : null,
    supersedes_operation_id: record.supersedes_operation_id ?? null,
  };
}

function typedItemView(item) {
  const record = isRecord(item) ? item : {};
  const curator = isRecord(record.curator) ? record.curator : null;
  const reviewer = isRecord(record.reviewer) ? record.reviewer : null;
  return {
    queue_item_id: record.queue_item_id ?? null,
    item_class: record.item_class ?? null,
    source_event_id: record.source_event_id ?? null,
    source_revision: record.source_revision ?? null,
    source_event_digest: record.source_event_digest ?? null,
    curator: curator
      ? {
          curator_invocation_id: curator.curator_invocation_id ?? null,
          curator_invocation_ref: curator.curator_invocation_ref ?? null,
          curator_model_id: curator.curator_model_id ?? null,
          curator_model_version: curator.curator_model_version ?? null,
          curator_protocol_version: curator.curator_protocol_version ?? null,
          curator_input_digest: curator.curator_input_digest ?? null,
          curator_output_digest: curator.curator_output_digest ?? null,
        }
      : null,
    reviewer: reviewer
      ? {
          reviewer_invocation_id: reviewer.reviewer_invocation_id ?? null,
          reviewer_invocation_ref: reviewer.reviewer_invocation_ref ?? null,
          reviewer_model_id: reviewer.reviewer_model_id ?? null,
          reviewer_model_version: reviewer.reviewer_model_version ?? null,
          reviewer_protocol_version: reviewer.reviewer_protocol_version ?? null,
          reviewer_input_digest: reviewer.reviewer_input_digest ?? null,
          reviewer_decision: reviewer.reviewer_decision ?? null,
          reviewer_revision: reviewer.reviewer_revision ?? null,
          reviewer_output_digest: reviewer.reviewer_output_digest ?? null,
        }
      : null,
  };
}

function typedSourceView(source) {
  const record = isRecord(source) ? source : {};
  return {
    event_id: record.event_id ?? null,
    source_revision: record.source_revision ?? null,
    source_event_digest: record.source_event_digest ?? null,
    final_content_digest: record.final_content_digest ?? null,
    scope_envelope_digest: record.scope_envelope_digest ?? null,
    sensitivity: record.sensitivity ?? null,
    lifecycle_state: record.lifecycle_state ?? null,
  };
}

function typedBindingView(binding) {
  const record = isRecord(binding) ? binding : {};
  return {
    event_id: record.event_id ?? null,
    source_revision: record.source_revision ?? null,
    source_event_digest: record.source_event_digest ?? null,
    final_content_digest: record.final_content_digest ?? null,
    scope_envelope_digest: record.scope_envelope_digest ?? null,
    sensitivity: record.sensitivity ?? null,
    lifecycle_state: record.lifecycle_state ?? null,
    trusted_action_receipt_refs: Array.isArray(record.trusted_action_receipt_refs)
      ? [...record.trusted_action_receipt_refs]
      : null,
  };
}

function typedStoreView(view, priorAuthorized, priorI) {
  const current = isRecord(view.current_revision_binding) ? view.current_revision_binding : null;
  return {
    fence: view.fence ?? null,
    adapter_policy_digest: view.adapter_policy_digest ?? null,
    current_revision_binding: current
      ? {
          source_revision: current.source_revision ?? null,
          source_event_digest: current.source_event_digest ?? null,
          final_content_digest: current.final_content_digest ?? null,
          lifecycle_state: current.lifecycle_state ?? null,
        }
      : null,
    tombstone: view.tombstone ?? null,
    prior_authorized_count: priorAuthorized,
    prior_authorized_i_observation_count: priorI,
  };
}

// The candidate record echoed into a decision carries only the typed fields
// the queue store consumes; payload content is never copied (§3.4).
function decisionCandidate(candidate) {
  const record = isRecord(candidate) ? candidate : {};
  return {
    candidate_id: record.candidate_id ?? null,
    candidate_kind: record.candidate_kind ?? null,
    candidate_payload_ref: record.candidate_payload_ref ?? null,
    candidate_payload_digest: record.candidate_payload_digest ?? null,
    projection_target: record.projection_target ?? null,
    deletion_domain: record.deletion_domain ?? null,
    supersedes_operation_id: record.supersedes_operation_id ?? null,
  };
}

// ------------------------------------------------------------- item-level --

function isValidBudgetProfile(profile) {
  if (!isRecord(profile)) return false;
  if (!isNonEmptyString(profile.version)) return false;
  return [
    'max_authorized_candidates_per_source_event',
    'max_candidate_payload_utf8_bytes',
    'max_candidate_source_refs',
    'max_i_observation_candidates_per_source_event',
  ].every((field) => Number.isInteger(profile[field]) && profile[field] > 0);
}

// §9.3.1 provenance completeness, protocol version pins, and reviewer binding
// (accept keeps curator digests; revise/split requires a first revision).
function checkProvenance(item) {
  if (!isRecord(item)) return 'provenance_incomplete';
  const curator = item.curator;
  if (!isRecord(curator)) return 'provenance_incomplete';
  for (const field of CURATOR_STRING_FIELDS) {
    if (!isNonEmptyString(curator[field])) return 'provenance_incomplete';
  }
  for (const field of CURATOR_DIGEST_FIELDS) {
    if (!isSha256Digest(curator[field])) return 'provenance_incomplete';
  }
  if (curator.curator_protocol_version !== COMPAT_CURATOR_PROTOCOL_VERSION) {
    return 'protocol_version_mismatch';
  }
  const reviewer = item.reviewer;
  if (!isRecord(reviewer)) return 'provenance_incomplete';
  for (const field of REVIEWER_STRING_FIELDS) {
    if (!isNonEmptyString(reviewer[field])) return 'provenance_incomplete';
  }
  for (const field of REVIEWER_DIGEST_FIELDS) {
    if (!isSha256Digest(reviewer[field])) return 'provenance_incomplete';
  }
  if (reviewer.reviewer_protocol_version !== COMPAT_REVIEWER_PROTOCOL_VERSION) {
    return 'protocol_version_mismatch';
  }
  if (!GATE_REVIEWER_DECISIONS.includes(reviewer.reviewer_decision)) {
    return 'reviewer_decision_invalid';
  }
  if (!isNonNegativeInteger(reviewer.reviewer_revision)) {
    return 'provenance_incomplete';
  }
  if (['revise', 'split'].includes(reviewer.reviewer_decision) && reviewer.reviewer_revision < 1) {
    return 'reviewer_binding_mismatch';
  }
  return null;
}

// The item, the source event record, and the stored binding must name the
// same event, revision, and digest; any mismatch fails closed (§5).
function checkSourceBinding(item, source, binding) {
  if (!isRecord(item) || !isRecord(source) || !isRecord(binding)) {
    return 'source_digest_mismatch';
  }
  if (!isNonEmptyString(item.queue_item_id)) return 'source_digest_mismatch';
  if (!isSha256Digest(binding.source_event_digest)) return 'source_digest_mismatch';
  if (!isSha256Digest(binding.final_content_digest)) return 'source_digest_mismatch';
  if (!isSha256Digest(binding.scope_envelope_digest)) return 'source_digest_mismatch';
  if (!SENSITIVITY_LEVELS.includes(binding.sensitivity)) return 'source_digest_mismatch';
  if (item.source_event_id !== binding.event_id) return 'source_digest_mismatch';
  if (source.event_id !== binding.event_id) return 'source_digest_mismatch';
  if (item.source_revision !== binding.source_revision) return 'source_digest_mismatch';
  if (source.source_revision !== binding.source_revision) return 'source_digest_mismatch';
  if (item.source_event_digest !== binding.source_event_digest) return 'source_digest_mismatch';
  if (source.source_event_digest !== binding.source_event_digest) return 'source_digest_mismatch';
  return null;
}

// Source-level failures reject (or tombstone/fence) every candidate at once.
// Evaluation order is fixed so the outcome is deterministic.
function detectItemFailure({ item, source, binding, view, budgetProfile, adapterPolicyDigest, upstreamVersion, candidateCount }) {
  if (view.fence) {
    return { decision: 'fenced', reason_code: 'fenced', item_outcome: 'fenced', budget_result: 'within_budget' };
  }
  if (adapterPolicyDigest !== view.adapter_policy_digest || upstreamVersion !== COMPAT_UPSTREAM_VERSION) {
    return { decision: 'rejected', reason_code: 'adapter_policy_mismatch', item_outcome: 'rejected', budget_result: 'within_budget' };
  }
  if (!isValidBudgetProfile(budgetProfile)) {
    return { decision: 'rejected', reason_code: 'budget_profile_invalid', item_outcome: 'rejected', budget_result: 'rejected_budget' };
  }
  const provenanceFailure = checkProvenance(item);
  if (provenanceFailure) {
    return { decision: 'rejected', reason_code: provenanceFailure, item_outcome: 'rejected', budget_result: 'within_budget' };
  }
  const bindingFailure = checkSourceBinding(item, source, binding);
  if (bindingFailure) {
    return { decision: 'rejected', reason_code: bindingFailure, item_outcome: 'rejected', budget_result: 'within_budget' };
  }
  if (view.tombstone || ['deleting', 'deleted'].includes(binding.lifecycle_state)) {
    return {
      decision: 'tombstoned',
      reason_code: 'source_tombstoned',
      item_outcome: 'rejected',
      budget_result: 'within_budget',
      gate_decision: 'tombstoned',
    };
  }
  if (binding.lifecycle_state !== 'current') {
    return { decision: 'rejected', reason_code: 'source_not_current', item_outcome: 'rejected', budget_result: 'within_budget' };
  }
  const current = isRecord(view.current_revision_binding) ? view.current_revision_binding : null;
  if (current && current.final_content_digest !== binding.final_content_digest) {
    return { decision: 'rejected', reason_code: 'source_stale', item_outcome: 'rejected', budget_result: 'within_budget' };
  }
  if (candidateCount === 0) {
    return { decision: 'rejected', reason_code: 'no_candidates', item_outcome: 'rejected', budget_result: 'within_budget' };
  }
  return null;
}

// --------------------------------------------------------- candidate-level --

// Returns the rejection reason for the first failing mechanical check, or
// null when the candidate is provisionally authorized.
function checkCandidate(candidate, binding, budgetProfile, reviewerDecision) {
  if (!isRecord(candidate)) return 'candidate_schema_invalid';
  if (!isNonEmptyString(candidate.candidate_id)) return 'candidate_schema_invalid';
  if (!isNonEmptyString(candidate.candidate_payload_ref)) return 'candidate_schema_invalid';
  if (!COMPAT_PROJECTION_TARGETS.includes(candidate.projection_target)) return 'candidate_schema_invalid';
  if (!COMPAT_DELETION_DOMAINS.includes(candidate.deletion_domain)) return 'candidate_schema_invalid';
  if (!isNonNegativeInteger(candidate.payload_bytes)) return 'candidate_schema_invalid';
  if (!Array.isArray(candidate.source_refs) || !candidate.source_refs.every(isNonEmptyString)) {
    return 'candidate_schema_invalid';
  }
  if (!isSha256Digest(candidate.scope_envelope_digest)) return 'candidate_schema_invalid';
  if (!SENSITIVITY_LEVELS.includes(candidate.sensitivity)) return 'candidate_schema_invalid';
  if (!isSha256Digest(candidate.curator_candidate_payload_digest)) return 'candidate_schema_invalid';
  if (!Array.isArray(candidate.claim_manifest)) return 'candidate_schema_invalid';
  for (const claim of candidate.claim_manifest) {
    if (!isRecord(claim)) return 'candidate_schema_invalid';
    if (!CLAIM_KINDS.includes(claim.claim_kind)) return 'candidate_schema_invalid';
    if (!Array.isArray(claim.forbidden_classes) || !claim.forbidden_classes.every(isNonEmptyString)) {
      return 'candidate_schema_invalid';
    }
    if (
      claim.receipt_refs !== undefined
      && (!Array.isArray(claim.receipt_refs) || !claim.receipt_refs.every(isNonEmptyString))
    ) {
      return 'candidate_schema_invalid';
    }
  }

  if (!MODEL_CANDIDATE_KINDS.includes(candidate.candidate_kind)) return 'candidate_kind_not_allowed';
  if (!isSha256Digest(candidate.candidate_payload_digest)) return 'candidate_digest_invalid';
  if (candidate.payload_bytes > budgetProfile.max_candidate_payload_utf8_bytes) {
    return 'candidate_payload_too_large';
  }
  if (candidate.source_refs.length > budgetProfile.max_candidate_source_refs) {
    return 'candidate_source_refs_exceeded';
  }
  if (candidate.scope_envelope_digest !== binding.scope_envelope_digest) return 'scope_mismatch';
  if (
    SENSITIVITY_LEVELS.indexOf(candidate.sensitivity) < SENSITIVITY_LEVELS.indexOf(binding.sensitivity)
  ) {
    return 'sensitivity_downgrade';
  }
  for (const claim of candidate.claim_manifest) {
    if (claim.forbidden_classes.length > 0) return `forbidden_class:${claim.forbidden_classes[0]}`;
  }
  const trustedRefs = Array.isArray(binding.trusted_action_receipt_refs) ? binding.trusted_action_receipt_refs : [];
  for (const claim of candidate.claim_manifest) {
    if (claim.claim_kind !== 'action_completion') continue;
    const receiptRefs = claim.receipt_refs || [];
    if (receiptRefs.length === 0 || !receiptRefs.every((ref) => trustedRefs.includes(ref))) {
      return 'action_completion_without_trusted_receipt';
    }
  }
  // Reviewer binding (§5.2): accept leaves the curator payload digest
  // untouched; revise/split carry a new digest with reviewer_revision >= 1
  // (enforced at the item level in checkProvenance).
  if (
    reviewerDecision === 'accept'
    && candidate.candidate_payload_digest !== candidate.curator_candidate_payload_digest
  ) {
    return 'reviewer_binding_mismatch';
  }
  return null;
}

// Idempotency / operation-key replay within one batch (§5.3): candidates
// with identical operation-key material map to the same operation key, so
// only the first occurrence may proceed.
function applyConflictDedupe(decisions) {
  const seen = new Set();
  for (const entry of decisions) {
    if (entry.decision !== 'authorized') continue;
    const candidate = entry.candidate;
    const key = [
      candidate.candidate_kind,
      candidate.candidate_payload_digest,
      candidate.projection_target,
      candidate.deletion_domain,
    ].join('\n');
    if (seen.has(key)) {
      entry.decision = 'conflict';
      entry.reason_code = 'operation_key_replay';
    } else {
      seen.add(key);
    }
  }
}

// §6.3 growth budget, counted over earlier gate passes of the same source
// event (prior_*) plus this batch in deterministic candidate order.
function applyBudgetCaps(decisions, { budgetProfile, priorAuthorized, priorI }) {
  let authorizedCount = priorAuthorized;
  let iObservationCount = priorI;
  let anyDeferred = false;
  let anyBudgetRejected = false;
  for (const entry of decisions) {
    if (entry.decision !== 'authorized') continue;
    if (entry.candidate.candidate_kind === 'append_i_observation_candidate') {
      if (iObservationCount >= budgetProfile.max_i_observation_candidates_per_source_event) {
        entry.decision = 'rejected';
        entry.reason_code = 'budget_i_observation_exceeded';
        anyBudgetRejected = true;
        continue;
      }
      iObservationCount += 1;
    }
    if (authorizedCount >= budgetProfile.max_authorized_candidates_per_source_event) {
      entry.decision = 'deferred';
      entry.reason_code = 'budget_deferred';
      anyDeferred = true;
      continue;
    }
    authorizedCount += 1;
  }
  if (anyDeferred) return 'deferred_budget';
  if (anyBudgetRejected) return 'rejected_budget';
  return 'within_budget';
}

function collectForbiddenClasses(candidateList) {
  const found = new Set();
  for (const candidate of candidateList) {
    const claims = isRecord(candidate) && Array.isArray(candidate.claim_manifest) ? candidate.claim_manifest : [];
    for (const claim of claims) {
      const classes = isRecord(claim) && Array.isArray(claim.forbidden_classes) ? claim.forbidden_classes : [];
      for (const forbiddenClass of classes) {
        if (isNonEmptyString(forbiddenClass)) found.add(forbiddenClass);
      }
    }
  }
  return found.size === 0 ? 'none' : [...found].sort().join(',');
}

// ------------------------------------------------------------------ entry --

export function evaluatePublicationGate({
  item,
  candidates,
  source,
  binding,
  storeView,
  budgetProfile,
  adapterPolicyDigest,
  upstreamVersion,
  gatePolicyVersion,
  clock = () => new Date(),
} = {}) {
  const clockValue = clock();
  const evaluatedDate = clockValue instanceof Date ? clockValue : new Date(clockValue);
  if (!Number.isFinite(evaluatedDate.getTime())) {
    throw new TypeError('gate clock must return a valid time');
  }
  const evaluatedAt = evaluatedDate.toISOString();

  const candidateList = Array.isArray(candidates) ? candidates : [];
  const view = isRecord(storeView) ? storeView : {};
  const priorAuthorized = isNonNegativeInteger(view.prior_authorized_count) ? view.prior_authorized_count : 0;
  const priorI = isNonNegativeInteger(view.prior_authorized_i_observation_count)
    ? view.prior_authorized_i_observation_count
    : 0;

  // Audit digest over every typed input that can influence the outcome,
  // including the injected clock reading that backs next_attempt_at.
  const gateInputDigest = canonicalDigest({
    item: typedItemView(item),
    candidates: candidateList.map(typedCandidateView),
    source: typedSourceView(source),
    binding: typedBindingView(binding),
    store_view: typedStoreView(view, priorAuthorized, priorI),
    budget_profile: budgetProfile ?? null,
    adapter_policy_digest: adapterPolicyDigest ?? null,
    upstream_version: upstreamVersion ?? null,
    gate_policy_version: gatePolicyVersion ?? null,
    evaluated_at: evaluatedAt,
  });

  const itemFailure = detectItemFailure({
    item,
    source,
    binding,
    view,
    budgetProfile,
    adapterPolicyDigest,
    upstreamVersion,
    candidateCount: candidateList.length,
  });

  let decisions;
  let budgetResult;
  if (itemFailure) {
    decisions = candidateList.map((candidate) => ({
      candidate: decisionCandidate(candidate),
      decision: itemFailure.decision,
      reason_code: itemFailure.reason_code,
    }));
    budgetResult = itemFailure.budget_result;
  } else {
    const reviewerDecision = item.reviewer.reviewer_decision;
    decisions = candidateList.map((candidate) => {
      const failure = checkCandidate(candidate, binding, budgetProfile, reviewerDecision);
      return {
        candidate: decisionCandidate(candidate),
        decision: failure ? 'rejected' : 'authorized',
        reason_code: failure || 'ok',
      };
    });
    applyConflictDedupe(decisions);
    budgetResult = applyBudgetCaps(decisions, { budgetProfile, priorAuthorized, priorI });
  }

  const anyAuthorized = decisions.some((entry) => entry.decision === 'authorized');
  const anyDeferred = decisions.some((entry) => entry.decision === 'deferred');
  // Mixed batches proceed: authorized candidates dispatch now; deferred
  // candidates stay recorded as deferred gate decisions (budget ceilings are
  // per source event, so a later deterministic pass reaches the same
  // outcome). The item only defers as a whole when nothing was authorized.
  const itemOutcome = itemFailure
    ? itemFailure.item_outcome
    : anyAuthorized
      ? 'authorized'
      : anyDeferred
        ? 'deferred'
        : 'rejected';
  const gateReasonCode = itemFailure
    ? itemFailure.reason_code
    : anyAuthorized
      ? (anyDeferred ? 'ok_with_budget_deferred' : 'ok')
      : anyDeferred
        ? 'budget_deferred'
        : decisions[0]?.reason_code || 'no_candidates';
  const nextAttemptAt = itemOutcome === 'deferred'
    ? new Date(evaluatedDate.getTime() + GATE_DEFERRED_RETRY_DELAY_MS).toISOString()
    : null;

  const gateProvenance = {
    gate_policy_version: gatePolicyVersion ?? null,
    gate_input_digest: gateInputDigest,
    gate_decision: itemFailure?.gate_decision || itemOutcome,
    gate_reason_code: gateReasonCode,
    forbidden_class_result: collectForbiddenClasses(candidateList),
    budget_profile_version: isNonEmptyString(budgetProfile?.version) ? budgetProfile.version : null,
    budget_result: budgetResult,
    adapter_policy_digest: adapterPolicyDigest ?? null,
  };

  return deepFreezeClone({
    decisions,
    item_outcome: itemOutcome,
    gate_provenance: gateProvenance,
    next_attempt_at: nextAttemptAt,
  });
}
