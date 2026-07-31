// Ombre O2 Stewarded Growth Compatibility — frozen contract constants.
// Sole authority: hermes_ombre_stewarded_growth_compatibility_calibration_v0.2.md
// (protocol id `ombre-stewarded-growth-compatibility/2`). This layer is
// pre-Gate-5, non-authoritative, projection-only, and disabled by default.

import { OMBRE_UPSTREAM_COMMIT } from '../ombreRecallPolicy.mjs';

export const COMPAT_PROTOCOL_ID = 'ombre-stewarded-growth-compatibility/6';
export const COMPAT_SOURCE_EVENT_SCHEMA = 'compatibility.final-turn/v1';
export const COMPAT_RETRIEVAL_EVENT_SCHEMA = 'compatibility.retrieval-used/v1';
export const COMPAT_ILLEGAL_TRANSITION_EVENT = 'compat.illegal-transition/v1';
export const COMPAT_LOG_SCHEMA_VERSION = 1;

// §4.2 presentation states (delivery observation only; never semantic truth).
export const PRESENTATION_STATES = Object.freeze([
  'not_presented',
  'queued',
  'handed_off',
  'presented',
  'failed',
  'ambiguous',
  'withdrawn',
]);

// §4.2 / §9.3.1 source lifecycle states.
export const SOURCE_LIFECYCLE_STATES = Object.freeze([
  'current',
  'superseded',
  'withdrawn',
  'suppressed',
  'deleting',
  'deleted',
]);

// §9.3.1 queue item states (canonical v0.1 names kept; no accepted/ready aliases).
export const QUEUE_ITEM_STATES = Object.freeze([
  'received',
  'curating',
  'reviewing',
  'gate_pending',
  'authorized',
  'dispatching',
  'published',
  'failed',
  'ambiguous',
  'reconciling',
  'rejected',
  'superseded',
  'withdrawn',
  'suppressed',
  'tombstoned',
  'deleting',
  'deleted',
  'fenced',
  'voided',
]);

// §9.3.1 adapter attempt states.
export const ADAPTER_ATTEMPT_STATES = Object.freeze([
  'not_started',
  'dispatching',
  'superseded-by-source-revision',
  'succeeded',
  'failed',
  'ambiguous',
  'reconciling',
]);

// §9.3.1 migration states.
export const MIGRATION_STATES = Object.freeze([
  'not_selected',
  'migration_pending',
  'migrating',
  'migration_failed',
  'migrated',
  'migration_voided',
]);

// §9.3.1 revision refresh states.
export const REVISION_REFRESH_STATES = Object.freeze([
  'not_required',
  'pending',
  'building',
  'published',
  'failed',
]);

// §5.2 reviewer decisions.
export const REVIEWER_DECISIONS = Object.freeze([
  'accept',
  'revise',
  'split',
  'reject',
]);

// §5.3 deterministic gate decisions.
export const GATE_DECISIONS = Object.freeze([
  'authorized',
  'rejected',
  'deferred',
  'conflict',
  'tombstoned',
  'fenced',
]);

// §5.5 receipt outcomes.
export const RECEIPT_OUTCOMES = Object.freeze([
  'succeeded',
  'failed',
  'ambiguous',
]);

// §6.1 v1 automatic stewarded-growth candidate allowlist.
export const CANDIDATE_KINDS = Object.freeze([
  'append_experience',
  'append_association',
  'append_low_impact_preference_observation',
  'append_i_observation_candidate',
  'append_correction_or_supersession_observation',
  'bounded_retrieval_touch',
]);

// Candidate kinds a model-driven Curator may propose (touch is maintenance-only).
export const MODEL_CANDIDATE_KINDS = Object.freeze(
  CANDIDATE_KINDS.filter((kind) => kind !== 'bounded_retrieval_touch'),
);

// §6.2 automatic stewarded-growth denylist (typed forbidden classes).
export const FORBIDDEN_CLASSES = Object.freeze([
  'delete',
  'overwrite',
  'merge_history',
  'hard_anchor',
  'canon_promotion',
  'active_i_activation',
  'relationship_mutation',
  'permission_mutation',
  'grant_mutation',
  'soul_mutation',
  'current_fact_mutation',
  'task_state_mutation',
  'action_completion_without_trusted_receipt',
]);

// Claim kinds used in the reviewer-issued typed claim manifest (§4.4).
export const CLAIM_KINDS = Object.freeze([
  'experience',
  'association',
  'preference_observation',
  'i_observation_candidate',
  'correction_observation',
  'action_completion',
]);

// §6.3 growth budget v1 (frozen ceilings; implementation may go lower).
export const BUDGET_PROFILE_VERSION = 'compat-budget/v1';
export const BUDGET_PROFILE_V1 = Object.freeze({
  version: BUDGET_PROFILE_VERSION,
  max_authorized_candidates_per_source_event: 3,
  max_candidate_payload_utf8_bytes: 4096,
  max_candidate_source_refs: 16,
  max_i_observation_candidates_per_source_event: 1,
  max_retryable_mutation_attempts_per_source_event: 1,
  ambiguous_auto_retry: 0,
});

// §7.3 bounded maintenance touch limits v1.
export const TOUCH_LIMITS_V1 = Object.freeze({
  max_success_per_retrieval_event_and_item: 1,
  item_cooldown_ms: 24 * 60 * 60 * 1000,
  max_items_per_retrieval_event: 20,
});

// Sensitivity ladder; gate forbids downgrade (§5.3).
export const SENSITIVITY_LEVELS = Object.freeze([
  'public',
  'standard',
  'personal',
  'sensitive',
  'sealed',
]);

// Queue item classes. Growth items come from the model pipeline; lifecycle,
// touch, and deletion items are trusted-lane only (§8.2, §7.3).
export const QUEUE_ITEM_CLASSES = Object.freeze([
  'growth',
  'lifecycle',
  'touch',
  'deletion',
]);

// Lifecycle operations of the trusted lane (§8.2).
export const LIFECYCLE_OPERATIONS = Object.freeze([
  'withdraw',
  'suppress',
  'supersede',
  'tombstone',
  'total_delete',
]);

// §9.5.5 unmapped field policy classes.
export const MAPPING_CLASSES = Object.freeze([
  'REQUIRED',
  'AUDIT_ONLY',
  'DERIVABLE',
  'DISCARDABLE',
  'FORBIDDEN_TO_DROP',
]);

// Stable error codes (bounded error code set, §3.2).
export const COMPAT_ERROR_CODES = Object.freeze([
  'COMPAT_ILLEGAL_TRANSITION',
  'COMPATIBILITY_WRITER_FENCED',
  'COMPAT_INGRESS_CONFLICT',
  'COMPAT_INGRESS_INVALID',
  'COMPAT_SOURCE_STALE',
  'COMPAT_SOURCE_NOT_CURRENT',
  'COMPAT_STALE_SOURCE_REVISION',
  'COMPAT_PAYLOAD_UNRESOLVABLE',
  'COMPAT_RUNTIME_INACTIVE',
  'COMPAT_CONFIG_INCOMPLETE',
  'COMPAT_REGISTRY_WRITER_EPOCH_CONFLICT',
  'COMPAT_REGISTRY_CORRUPT',
  'COMPAT_DELETION_AUTHORITY_INVALID',
  'COMPAT_DUPLICATE_CHILD_OPERATION_ID',
  'COMPAT_AGGREGATE_UNCLASSIFIED',
  'STEWARD_SOURCE_TOTAL_DELETE_UNSUPPORTED',
  'COMPAT_CANDIDATE_INVALID',
  'COMPAT_CURATOR_UNAVAILABLE',
  'COMPAT_CURATOR_MALFORMED',
  'COMPAT_REVIEWER_UNAVAILABLE',
  'COMPAT_REVIEWER_MALFORMED',
  'COMPAT_GATE_REJECTED',
  'COMPAT_GATE_CONFLICT',
  'COMPAT_BUDGET_EXCEEDED',
  'COMPAT_ADAPTER_METHOD_DENIED',
  'COMPAT_ADAPTER_UPSTREAM_DRIFT',
  'COMPAT_ADAPTER_UPSTREAM_UNAVAILABLE',
  'COMPAT_RECEIPT_INVALID',
  'COMPAT_AMBIGUOUS_REQUIRES_RECONCILIATION',
  'COMPAT_RETRY_NOT_ALLOWED',
  'COMPAT_LIFECYCLE_REJECTED',
  'COMPAT_TOMBSTONED',
  'COMPAT_DELETED',
  'COMPAT_PAYLOAD_ERASED',
  'COMPAT_PROJECTION_INVALID',
  'COMPAT_PROJECTION_REVISION_MISMATCH',
  'COMPAT_MAPPING_INCOMPLETE',
  'COMPAT_MAPPING_UNKNOWN_FIELD',
  'COMPAT_MIGRATION_CONFLICT',
  'COMPAT_STORE_CORRUPT',
  'COMPAT_STORE_BUSY',
  'COMPAT_DISABLED',
]);

// Adapter identity and pinned upstream (§5.4). The upstream commit is the
// single pin already frozen by O1 recall policy; O2 does not re-pin.
export const COMPAT_ADAPTER_ID = 'ombre-steward-adapter';
export const COMPAT_ADAPTER_VERSION = '1.0.0-local';
export const COMPAT_UPSTREAM_VERSION = OMBRE_UPSTREAM_COMMIT;
export const COMPAT_GATE_POLICY_VERSION = 'compat-gate/v1';
export const COMPAT_CURATOR_PROTOCOL_VERSION = 'compat-curator/v1';
export const COMPAT_REVIEWER_PROTOCOL_VERSION = 'compat-reviewer/v1';
export const COMPAT_EMITTER_ID = 'node-final-gate-compat-emitter';
export const COMPAT_EMITTER_VERSION = '1.0.0-local';
export const COMPAT_AUTHORITY_OWNER = 'legacy_final_truth';

// Projection target: the only v1 target is the local Ombre projection domain.
export const COMPAT_PROJECTION_TARGETS = Object.freeze([
  'ombre_local_projection',
]);

// Default deletion domain for compatibility payloads (erasable, §3.4).
export const COMPAT_DELETION_DOMAINS = Object.freeze([
  'compat_payload_default',
]);

export function isCompatErrorCode(code) {
  return COMPAT_ERROR_CODES.includes(String(code || ''));
}

export function compatError(code, message, cause) {
  const error = new Error(message || code, cause ? { cause } : undefined);
  error.code = COMPAT_ERROR_CODES.includes(code) ? code : 'COMPAT_STORE_CORRUPT';
  return error;
}
