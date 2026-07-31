// Ombre O2 Stewarded Growth Compatibility — Gate 5 migration readiness:
// field-level mapping registry + dry-run validation.
//
// Sole authority: hermes_ombre_stewarded_growth_compatibility_calibration_v0.2.md
// §9.3.1 (canonical logical compatibility field inventory), §9.4.2–§9.4.4
// (publication ledger mapping), §9.5.1–§9.5.3 (projection outbox mapping),
// §9.5.4 (state mapping), §9.5.5 (unmapped field policy), §9.5.6 (Gate 5
// migration validation), §9.5.7 (migration failure).
//
// This module is pre-Gate-5 migration READINESS only: it never activates the
// Core writer, never performs a real migration, and never mutates the compat
// store. dryRunMigration() runs against a queueStore.exportView()-shaped
// fixture view and a plain-object collector.

import {
  MAPPING_CLASSES,
  QUEUE_ITEM_STATES,
  ADAPTER_ATTEMPT_STATES,
  MIGRATION_STATES,
  REVISION_REFRESH_STATES,
  SOURCE_LIFECYCLE_STATES,
  RECEIPT_OUTCOMES,
  REVIEWER_DECISIONS,
  GATE_DECISIONS,
  PRESENTATION_STATES,
  SENSITIVITY_LEVELS,
  compatError,
} from './constants.mjs';

// §9.3.1 canonical logical compatibility field inventory — verbatim
// transcription (11 records, field order preserved). Physical Schema may
// normalize into separate tables but must not omit these fields nor add
// persisted fields not classified by §9.4–§9.5.
export const CANONICAL_FIELD_INVENTORY = Object.freeze({
  compat_source_binding: Object.freeze([
    'schema_version', 'event_id', 'conversation_id', 'exchange_id',
    'source_revision', 'source_event_digest',
    'user_final_payload_ref', 'user_final_payload_revision', 'user_final_payload_digest',
    'assistant_final_payload_ref', 'assistant_final_payload_revision', 'assistant_final_payload_digest',
    'final_content_digest', 'scope_envelope_ref', 'scope_envelope_digest', 'sensitivity',
    'presentation_state', 'delivery_observation_ref', 'delivery_observation_digest',
    'trusted_action_receipt_refs', 'trusted_action_receipts_digest',
    'source_gate_receipt_ref', 'emitter_id', 'emitter_version', 'emitted_at',
    'lifecycle_state', 'supersedes_event_id',
    'withdrawal_ref', 'withdrawal_revision',
    'supersession_ref', 'supersession_revision',
    'deletion_ref', 'deletion_revision',
  ]),
  compat_candidate: Object.freeze([
    'candidate_id', 'candidate_kind', 'candidate_payload_ref', 'candidate_payload_digest',
    'candidate_claim_manifest_ref', 'candidate_source_refs',
  ]),
  compat_curator_provenance: Object.freeze([
    'curator_invocation_id', 'curator_invocation_ref', 'curator_model_id',
    'curator_model_version', 'curator_protocol_version',
    'curator_input_digest', 'curator_output_digest',
  ]),
  compat_reviewer_provenance: Object.freeze([
    'reviewer_invocation_id', 'reviewer_invocation_ref', 'reviewer_model_id',
    'reviewer_model_version', 'reviewer_protocol_version',
    'reviewer_input_digest', 'reviewer_decision', 'reviewer_revision', 'reviewer_output_digest',
  ]),
  compat_gate_provenance: Object.freeze([
    'gate_policy_version', 'gate_input_digest', 'gate_decision', 'gate_reason_code',
    'forbidden_class_result', 'budget_profile_version', 'budget_result',
  ]),
  compat_operation: Object.freeze([
    'queue_item_id', 'operation_id', 'operation_key',
    'source_event_id', 'source_revision', 'source_event_digest', 'candidate_id',
    'authority_owner', 'projection_target', 'scope_envelope_ref', 'scope_envelope_digest',
    'sensitivity', 'deletion_domain', 'queue_item_state', 'source_lifecycle_state',
    'migration_state', 'revision_refresh_state', 'retryable', 'attempt_count',
    'next_attempt_at', 'projection_receipt_ref', 'projection_revision',
    'supersedes_operation_id', 'last_error_code', 'created_at', 'updated_at', 'terminal_at',
  ]),
  compat_projection_attempt: Object.freeze([
    'dispatch_intent_id', 'dispatch_intent_digest', 'dispatch_intent_committed_seq',
    'attempt_id', 'attempt_number', 'adapter_attempt_state', 'attempt_retryable',
    'adapter_request_digest', 'adapter_id', 'adapter_version', 'adapter_policy_digest',
    'upstream_version', 'method_identifier',
    'attempt_created_at', 'attempt_updated_at', 'attempt_succeeded_at', 'attempt_failed_at',
  ]),
  compat_projection_receipt: Object.freeze([
    'receipt_id', 'receipt_operation_key', 'receipt_attempt_id', 'outcome',
    'target_projection_ref', 'target_revision_before', 'target_revision_after',
    'upstream_evidence_ref', 'response_digest', 'idempotency_disposition',
    'receipt_adapter_id', 'receipt_adapter_version', 'receipt_upstream_version',
    'issued_at', 'issuer_id', 'ambiguous_reason_code',
    'reconciliation_state', 'reconciliation_operation_id',
    'reconciliation_evidence_refs', 'reconciliation_evidence_digest', 'reconciled_at',
  ]),
  compat_revision_snapshot: Object.freeze([
    'snapshot_id', 'projection_revision', 'snapshot_content_digest', 'snapshot_source_cursor',
    'last_projection_receipt_id', 'snapshot_adapter_policy_digest',
    'snapshot_upstream_version', 'revision_refresh_state', 'snapshot_created_at',
  ]),
  compat_migration_record: Object.freeze([
    'migration_state', 'cutover_id', 'migration_manifest_entry_id',
    'migrated_ledger_id', 'migrated_outbox_id',
    'frozen_queue_cursor', 'frozen_source_cursor', 'retired_writer_epoch',
    'migrated_at', 'migrated_marker_ref', 'typed_disposal_record_ref',
  ]),
  compat_lifecycle_event: Object.freeze([
    'supersedes_operation_id', 'tombstone_ref', 'tombstone_state',
    'delete_state', 'payload_deletion_state', 'payload_deleted_at',
  ]),
});

function row(table, field, target, conversion, fidelity, validation, unmapped_disposition, cutover_effect) {
  return Object.freeze({
    table, field, target, conversion, fidelity, validation, unmapped_disposition, cutover_effect,
  });
}

// §9.4.2–§9.5.3 mapping tables — verbatim row-by-row transcription. A field
// appearing in several contract tables (e.g. `operation_key` in §9.4.4 ledger
// and §9.5.1 outbox) is kept as multiple rows distinguished by `table`; this
// mirrors the contract as written. Fidelity: L=lossless, D=derivable by
// versioned canonical formula. unmapped_disposition ∈ MAPPING_CLASSES (§9.5.5).
export const MAPPING_REGISTRY = Object.freeze([
  // ---- §9.4.2 Source identity mapping (34 rows) ----
  row('9.4.2', 'schema_version', 'publication_source_binding.compat_schema_version', 'exact copy', 'L', 'allowlisted literal', 'AUDIT_ONLY', '选择 importer decoder'),
  row('9.4.2', 'event_id', 'publication_source_binding.compat_event_id', 'exact opaque copy', 'L', 'unique source event', 'FORBIDDEN_TO_DROP', 'source identity'),
  row('9.4.2', 'source_event_id', 'publication_ledger.source_event_id', 'exact opaque copy；必须等于 bound `event_id`', 'L', 'equality + unique binding', 'FORBIDDEN_TO_DROP', 'ledger parent identity'),
  row('9.4.2', 'conversation_id', 'publication_source_binding.conversation_id', 'exact canonical id', 'L', 'source ref lookup equality', 'REQUIRED', 'scope/binding'),
  row('9.4.2', 'exchange_id', 'publication_source_binding.exchange_id', 'exact canonical id', 'L', 'source ref lookup equality', 'REQUIRED', 'exchange parent'),
  row('9.4.2', 'source_revision', 'publication_ledger.source_revision', 'exact integer', 'L', 'monotonic + source equality', 'FORBIDDEN_TO_DROP', 'stale-work rejection'),
  row('9.4.2', 'source_event_digest', 'publication_ledger.source_event_digest', 'exact digest bytes/algorithm', 'L', 'recompute equality', 'FORBIDDEN_TO_DROP', 'parent integrity'),
  row('9.4.2', 'user_final_payload_ref', 'publication_source_binding.user_payload_ref', 'exact opaque ref', 'L', 'resolvable or typed deleted', 'REQUIRED', 'source retrieval only'),
  row('9.4.2', 'user_final_payload_revision', 'publication_source_binding.user_payload_revision', 'exact integer', 'L', 'ref revision equality', 'REQUIRED', 'content binding'),
  row('9.4.2', 'user_final_payload_digest', 'publication_source_binding.user_payload_digest', 'exact digest', 'L', 'ref digest equality', 'REQUIRED', 'content binding'),
  row('9.4.2', 'assistant_final_payload_ref', 'publication_source_binding.assistant_payload_ref', 'exact opaque ref', 'L', 'resolvable or typed deleted', 'REQUIRED', 'source retrieval only'),
  row('9.4.2', 'assistant_final_payload_revision', 'publication_source_binding.assistant_payload_revision', 'exact integer', 'L', 'ref revision equality', 'REQUIRED', 'content binding'),
  row('9.4.2', 'assistant_final_payload_digest', 'publication_source_binding.assistant_payload_digest', 'exact digest', 'L', 'ref digest equality', 'REQUIRED', 'content binding'),
  row('9.4.2', 'final_content_digest', 'publication_source_binding.final_content_digest', 'exact canonical combined digest', 'L', 'recompute from adopted refs when present', 'FORBIDDEN_TO_DROP', 'final-content integrity'),
  row('9.4.2', 'scope_envelope_ref', 'publication_ledger.scope_envelope_ref', 'exact opaque ref', 'L', 'resolver equality', 'REQUIRED', 'scope authority'),
  row('9.4.2', 'scope_envelope_digest', 'publication_ledger.scope_envelope_digest', 'exact digest', 'L', 'recompute equality', 'FORBIDDEN_TO_DROP', 'scope integrity'),
  row('9.4.2', 'sensitivity', 'publication_ledger.sensitivity', 'enum-preserving conversion only', 'L', 'no downgrade', 'REQUIRED', 'policy enforcement'),
  row('9.4.2', 'presentation_state', 'publication_source_binding.presentation_state', 'exact enum mapping', 'L', 'enum + revision check', 'REQUIRED', 'presentation observation；非effect truth'),
  row('9.4.2', 'delivery_observation_ref', 'publication_source_binding.delivery_observation_ref', 'exact nullable ref', 'L', 'digest/ref consistency', 'AUDIT_ONLY', 'delivery audit'),
  row('9.4.2', 'delivery_observation_digest', 'publication_source_binding.delivery_observation_digest', 'exact nullable digest', 'L', 'recompute if ref present', 'AUDIT_ONLY', 'delivery audit'),
  row('9.4.2', 'trusted_action_receipt_refs', 'publication_ledger.action_receipt_parents[]', 'stable-order set copy', 'L', 'every parent valid/same scope', 'FORBIDDEN_TO_DROP', 'action-claim eligibility'),
  row('9.4.2', 'trusted_action_receipts_digest', 'publication_ledger.action_receipt_parent_set_digest', 'exact set digest', 'L', 'recompute equality', 'FORBIDDEN_TO_DROP', 'parent-set integrity'),
  row('9.4.2', 'source_gate_receipt_ref', 'publication_source_binding.final_gate_receipt_ref', 'exact ref', 'L', 'trusted issuer/digest', 'REQUIRED', 'proves source seam'),
  row('9.4.2', 'emitter_id', 'publication_source_binding.emitter_id', 'exact id', 'L', 'allowlisted trusted runtime', 'AUDIT_ONLY', 'provenance'),
  row('9.4.2', 'emitter_version', 'publication_source_binding.emitter_version', 'exact version', 'L', 'version decoder exists', 'AUDIT_ONLY', 'provenance'),
  row('9.4.2', 'emitted_at', 'publication_source_binding.emitted_at', 'timestamp normalization preserving instant', 'L', 'canonical UTC equality', 'AUDIT_ONLY', 'ordering/audit'),
  row('9.4.2', 'lifecycle_state', 'publication_ledger.source_lifecycle_state', 'state table §9.5.4', 'L', 'lifecycle sequence valid', 'FORBIDDEN_TO_DROP', 'cancellation/tombstone'),
  row('9.4.2', 'supersedes_event_id', 'publication_ledger.supersedes_source_event_id', 'exact nullable id', 'L', 'target exists or typed deleted', 'REQUIRED', 'supersession edge'),
  row('9.4.2', 'withdrawal_ref', 'publication_lifecycle.withdrawal_ref', 'exact typed event ref', 'L', 'source lifecycle equality', 'FORBIDDEN_TO_DROP', 'cancel/suppress'),
  row('9.4.2', 'withdrawal_revision', 'publication_lifecycle.withdrawal_revision', 'exact integer', 'L', 'monotonic/current', 'FORBIDDEN_TO_DROP', 'stale-work fence'),
  row('9.4.2', 'supersession_ref', 'publication_lifecycle.supersession_ref', 'exact typed event ref', 'L', 'graph target exists', 'FORBIDDEN_TO_DROP', 'invalidation'),
  row('9.4.2', 'supersession_revision', 'publication_lifecycle.supersession_revision', 'exact integer', 'L', 'graph acyclic/current', 'FORBIDDEN_TO_DROP', 'invalidation order'),
  row('9.4.2', 'deletion_ref', 'publication_lifecycle.deletion_ref', 'exact typed event ref', 'L', 'deletion-domain equality', 'FORBIDDEN_TO_DROP', 'erasure authority'),
  row('9.4.2', 'deletion_revision', 'publication_lifecycle.deletion_revision', 'exact integer', 'L', 'monotonic/current', 'FORBIDDEN_TO_DROP', 'erasure fence'),
  // ---- §9.4.3 Candidate and provenance mapping (29 rows) ----
  row('9.4.3', 'candidate_id', 'publication_candidate.candidate_id', 'exact opaque copy', 'L', 'unique within source revision', 'REQUIRED', 'candidate identity'),
  row('9.4.3', 'candidate_kind', 'publication_candidate.kind', 'exact allowlisted enum', 'L', 'v1 allowlist', 'REQUIRED', 'projection class'),
  row('9.4.3', 'candidate_payload_ref', 'publication_candidate.payload_ref', 'exact erasable ref', 'L', 'ref/deletion state consistent', 'REQUIRED', 'outbox input'),
  row('9.4.3', 'candidate_payload_digest', 'publication_candidate.payload_digest', 'exact digest', 'L', 'recompute when payload exists', 'FORBIDDEN_TO_DROP', 'content integrity'),
  row('9.4.3', 'candidate_claim_manifest_ref', 'publication_candidate.claim_manifest_ref', 'exact typed ref', 'L', 'candidate digest binding', 'REQUIRED', 'action/forbidden-class checks'),
  row('9.4.3', 'candidate_source_refs', 'publication_candidate.source_refs[]', 'stable-order copy', 'L', 'all refs scope-valid', 'REQUIRED', 'provenance'),
  row('9.4.3', 'curator_invocation_id', 'publication_review_record.curator_invocation_id', 'exact copy', 'L', 'unique invocation', 'AUDIT_ONLY', 'semantic audit'),
  row('9.4.3', 'curator_invocation_ref', 'publication_review_record.curator_invocation_ref', 'exact durable ref', 'L', 'id/ref consistency', 'AUDIT_ONLY', 'semantic audit'),
  row('9.4.3', 'curator_model_id', 'publication_review_record.curator_model_id', 'exact copy', 'L', 'non-empty', 'AUDIT_ONLY', 'reproducibility'),
  row('9.4.3', 'curator_model_version', 'publication_review_record.curator_model_version', 'exact copy', 'L', 'version present', 'AUDIT_ONLY', 'reproducibility'),
  row('9.4.3', 'curator_protocol_version', 'publication_review_record.curator_protocol_version', 'exact copy', 'L', 'decoder retained', 'REQUIRED', 'provenance semantics'),
  row('9.4.3', 'curator_input_digest', 'publication_review_record.curator_input_digest', 'exact digest', 'L', 'recompute envelope digest', 'REQUIRED', 'input binding'),
  row('9.4.3', 'curator_output_digest', 'publication_review_record.curator_output_digest', 'exact digest', 'L', 'candidate/ref binding', 'REQUIRED', 'output binding'),
  row('9.4.3', 'reviewer_invocation_id', 'publication_review_record.reviewer_invocation_id', 'exact copy', 'L', 'distinct from curator', 'AUDIT_ONLY', 'independence proof'),
  row('9.4.3', 'reviewer_invocation_ref', 'publication_review_record.reviewer_invocation_ref', 'exact durable ref', 'L', 'id/ref consistency', 'AUDIT_ONLY', 'independence proof'),
  row('9.4.3', 'reviewer_model_id', 'publication_review_record.reviewer_model_id', 'exact copy', 'L', 'non-empty', 'AUDIT_ONLY', 'reproducibility'),
  row('9.4.3', 'reviewer_model_version', 'publication_review_record.reviewer_model_version', 'exact copy', 'L', 'version present', 'AUDIT_ONLY', 'reproducibility'),
  row('9.4.3', 'reviewer_protocol_version', 'publication_review_record.reviewer_protocol_version', 'exact copy', 'L', 'decoder retained', 'REQUIRED', 'decision semantics'),
  row('9.4.3', 'reviewer_input_digest', 'publication_review_record.reviewer_input_digest', 'exact digest', 'L', 'source+candidate binding', 'REQUIRED', 'input integrity'),
  row('9.4.3', 'reviewer_decision', 'publication_review_record.reviewer_decision', 'exact enum', 'L', 'accept/revise/split/reject', 'REQUIRED', 'publication eligibility'),
  row('9.4.3', 'reviewer_revision', 'publication_review_record.reviewer_revision', 'exact integer/ref', 'L', 'revised candidate linkage', 'REQUIRED', 'revision chain'),
  row('9.4.3', 'reviewer_output_digest', 'publication_review_record.reviewer_output_digest', 'exact digest', 'L', 'decision/output equality', 'REQUIRED', 'output integrity'),
  row('9.4.3', 'gate_policy_version', 'publication_gate_record.policy_version', 'exact version', 'L', 'approved version', 'REQUIRED', 'mechanical policy'),
  row('9.4.3', 'gate_input_digest', 'publication_gate_record.input_digest', 'exact digest', 'L', 'recompute typed inputs', 'REQUIRED', 'gate integrity'),
  row('9.4.3', 'gate_decision', 'publication_gate_record.decision', 'exact enum', 'L', 'state/decision consistency', 'REQUIRED', 'outbox authorization'),
  row('9.4.3', 'gate_reason_code', 'publication_gate_record.reason_code', 'exact typed code', 'L', 'allowlisted', 'REQUIRED', 'deterministic audit'),
  row('9.4.3', 'forbidden_class_result', 'publication_gate_record.forbidden_class_result', 'exact bitset/typed enum', 'L', 'no unknown bits', 'REQUIRED', 'deny enforcement'),
  row('9.4.3', 'budget_profile_version', 'publication_gate_record.budget_profile_version', 'exact version', 'L', 'approved profile', 'REQUIRED', 'budget semantics'),
  row('9.4.3', 'budget_result', 'publication_gate_record.budget_result', 'exact typed counters/decision', 'L', 'recompute from typed records', 'REQUIRED', 'authorization bound'),
  // ---- §9.4.4 Publication operation mapping (20 rows) ----
  row('9.4.4', 'operation_id', 'publication_ledger.compat_source_operation_id', 'exact copy；Core publication id另生成并反向记录', 'L', 'one-to-one manifest', 'FORBIDDEN_TO_DROP', 'migration identity'),
  row('9.4.4', 'operation_key', 'publication_ledger.operation_key', 'exact bytes/string；不得重算', 'L', 'global uniqueness + digest equality', 'FORBIDDEN_TO_DROP', 'idempotency'),
  row('9.4.4', 'authority_owner', 'publication_ledger.authority_owner', 'literal `legacy_final_truth` import classification', 'L', 'allowlisted non-Core source class', 'REQUIRED', '防止误称 Core Journal'),
  row('9.4.4', 'projection_target', 'publication_ledger.projection_target', 'exact typed target', 'L', 'target allowlist', 'REQUIRED', 'outbox routing'),
  row('9.4.4', 'scope_envelope_ref', 'publication_ledger.scope_envelope_ref', 'exact copy', 'L', 'resolver equality', 'REQUIRED', 'scope parent'),
  row('9.4.4', 'scope_envelope_digest', 'publication_ledger.scope_envelope_digest', 'exact copy', 'L', 'recompute equality', 'FORBIDDEN_TO_DROP', 'scope integrity'),
  row('9.4.4', 'sensitivity', 'publication_ledger.sensitivity', 'exact/no downgrade', 'L', 'policy check', 'REQUIRED', 'sensitivity'),
  row('9.4.4', 'deletion_domain', 'publication_ledger.deletion_domain', 'exact typed id', 'L', 'payload/domain consistency', 'FORBIDDEN_TO_DROP', 'erasure'),
  row('9.4.4', 'queue_item_state', 'publication_ledger.imported_item_state', '§9.5.4 exact mapping', 'L', 'transition history replay', 'FORBIDDEN_TO_DROP', 'import classification'),
  row('9.4.4', 'source_lifecycle_state', 'publication_ledger.source_lifecycle_state', '§9.5.4', 'L', 'lifecycle replay', 'FORBIDDEN_TO_DROP', 'current validity'),
  row('9.4.4', 'revision_refresh_state', 'publication_ledger.projection_refresh_state', 'exact enum mapping', 'L', 'snapshot/receipt consistency', 'REQUIRED', 'read availability'),
  row('9.4.4', 'retryable', 'publication_ledger.retry_policy_snapshot.retryable', 'exact boolean', 'L', 'attempt policy check', 'REQUIRED', 'retry eligibility'),
  row('9.4.4', 'next_attempt_at', 'projection_outbox.next_attempt_at', 'timestamp preserving instant', 'L', 'only with retryable failed', 'REQUIRED', 'scheduling'),
  row('9.4.4', 'projection_receipt_ref', 'publication_ledger.committed_receipt_ref', 'exact nullable ref', 'L', 'state requires/forbids receipt', 'FORBIDDEN_TO_DROP', 'effect truth'),
  row('9.4.4', 'projection_revision', 'publication_ledger.projection_revision', 'exact nullable revision', 'L', 'receipt/snapshot equality', 'FORBIDDEN_TO_DROP', 'reader revision'),
  row('9.4.4', 'supersedes_operation_id', 'publication_ledger.supersedes_operation_id', 'exact id edge', 'L', 'target/import mapping exists', 'REQUIRED', 'correction/lifecycle'),
  row('9.4.4', 'last_error_code', 'publication_ledger.last_typed_error_code', 'exact allowlisted code', 'L', 'code/state consistency', 'AUDIT_ONLY', 'diagnosis only'),
  row('9.4.4', 'created_at', 'publication_ledger.created_at', 'instant-preserving normalization', 'L', 'timestamp parse/order', 'REQUIRED', 'ordering'),
  row('9.4.4', 'updated_at', 'publication_ledger.imported_updated_at', 'instant-preserving normalization', 'L', '>= created_at', 'AUDIT_ONLY', 'audit'),
  row('9.4.4', 'terminal_at', 'publication_ledger.terminal_at', 'exact nullable instant', 'L', 'terminality consistency', 'REQUIRED', 'retention'),
  // ---- §9.5.1 Outbox and attempt field mapping (31 rows) ----
  row('9.5.1', 'queue_item_id', 'projection_outbox.compat_source_item_id', 'exact copy', 'L', 'manifest one-to-one', 'FORBIDDEN_TO_DROP', 'queue identity'),
  row('9.5.1', 'operation_id', 'projection_outbox.compat_source_operation_id', 'exact copy', 'L', 'ledger/outbox equality', 'FORBIDDEN_TO_DROP', 'operation identity'),
  row('9.5.1', 'operation_key', 'projection_outbox.operation_key', 'exact copy；不得重算', 'L', 'unique + ledger equality', 'FORBIDDEN_TO_DROP', 'idempotency'),
  row('9.5.1', 'source_event_id', 'projection_outbox.source_event_id', 'exact copy', 'L', 'ledger equality', 'REQUIRED', 'parent'),
  row('9.5.1', 'source_revision', 'projection_outbox.source_revision', 'exact integer', 'L', 'ledger equality/current check', 'FORBIDDEN_TO_DROP', 'stale rejection'),
  row('9.5.1', 'source_event_digest', 'projection_outbox.source_event_digest', 'exact digest', 'L', 'ledger/source equality', 'FORBIDDEN_TO_DROP', 'integrity'),
  row('9.5.1', 'candidate_id', 'projection_outbox.candidate_id', 'exact copy', 'L', 'candidate exists', 'REQUIRED', 'payload binding'),
  row('9.5.1', 'candidate_payload_ref', 'projection_outbox.payload_ref', 'exact erasable ref', 'L', 'deletion-state consistency', 'REQUIRED', 'dispatch input'),
  row('9.5.1', 'candidate_payload_digest', 'projection_outbox.payload_digest', 'exact digest', 'L', 'recompute/equality', 'FORBIDDEN_TO_DROP', 'dispatch integrity'),
  row('9.5.1', 'projection_target', 'projection_outbox.target', 'exact typed target', 'L', 'allowlisted', 'REQUIRED', 'routing'),
  row('9.5.1', 'queue_item_state', 'projection_outbox.import_state', '§9.5.4', 'L', 'history replay', 'FORBIDDEN_TO_DROP', 'dispatch eligibility'),
  row('9.5.1', 'attempt_count', 'projection_outbox.attempt_count', 'derive as count of preserved `projection_attempt` rows', 'D', 'count equality', 'DERIVABLE', 'scheduling/audit'),
  row('9.5.1', 'retryable', 'projection_outbox.retryable', 'exact boolean', 'L', 'policy snapshot equality', 'REQUIRED', 'retry scheduling'),
  row('9.5.1', 'next_attempt_at', 'projection_outbox.next_attempt_at', 'exact instant', 'L', 'only retryable failed', 'REQUIRED', 'scheduling'),
  row('9.5.1', 'dispatch_intent_id', 'projection_attempt.dispatch_intent_id', 'exact copy', 'L', 'unique per attempt', 'FORBIDDEN_TO_DROP', 'crash proof'),
  row('9.5.1', 'dispatch_intent_digest', 'projection_attempt.dispatch_intent_digest', 'exact digest', 'L', 'recompute typed intent', 'FORBIDDEN_TO_DROP', 'crash proof'),
  row('9.5.1', 'dispatch_intent_committed_seq', 'projection_attempt.intent_commit_sequence', 'exact monotonic value', 'L', 'queue log proof', 'REQUIRED', 'before-effect ordering'),
  row('9.5.1', 'attempt_id', 'projection_attempt.attempt_id', 'exact copy', 'L', 'unique globally/operation', 'FORBIDDEN_TO_DROP', 'attempt identity'),
  row('9.5.1', 'attempt_number', 'projection_attempt.attempt_number', 'exact integer', 'L', 'contiguous, starts at 1', 'FORBIDDEN_TO_DROP', 'history order'),
  row('9.5.1', 'adapter_attempt_state', 'projection_attempt.state', 'exact state mapping', 'L', 'transition replay', 'FORBIDDEN_TO_DROP', 'effect/retry truth'),
  row('9.5.1', 'attempt_retryable', 'projection_attempt.retryable', 'exact boolean', 'L', 'failed-only policy', 'REQUIRED', 'retry eligibility'),
  row('9.5.1', 'adapter_request_digest', 'projection_attempt.request_digest', 'exact digest', 'L', 'intent equality', 'FORBIDDEN_TO_DROP', 'request identity'),
  row('9.5.1', 'adapter_id', 'projection_attempt.adapter_id', 'exact copy', 'L', 'allowlisted adapter', 'REQUIRED', 'executor provenance'),
  row('9.5.1', 'adapter_version', 'projection_attempt.adapter_version', 'exact version', 'L', 'binary/manifest evidence', 'FORBIDDEN_TO_DROP', 'behavior pin'),
  row('9.5.1', 'adapter_policy_digest', 'projection_attempt.adapter_policy_digest', 'exact digest', 'L', 'reviewed manifest equality', 'FORBIDDEN_TO_DROP', 'capability pin'),
  row('9.5.1', 'upstream_version', 'projection_attempt.upstream_version', 'exact commit/version', 'L', 'pinned exact version', 'FORBIDDEN_TO_DROP', 'upstream pin'),
  row('9.5.1', 'method_identifier', 'projection_attempt.method_identifier', 'exact internal + upstream method pair', 'L', 'reviewed method table equality', 'REQUIRED', 'effect class'),
  row('9.5.1', 'attempt_created_at', 'projection_attempt.created_at', 'instant-preserving', 'L', 'order check', 'REQUIRED', 'history'),
  row('9.5.1', 'attempt_updated_at', 'projection_attempt.updated_at', 'instant-preserving', 'L', '>= created_at', 'AUDIT_ONLY', 'audit'),
  row('9.5.1', 'attempt_succeeded_at', 'projection_attempt.succeeded_at', 'exact nullable instant', 'L', 'succeeded-only', 'REQUIRED', 'effect time'),
  row('9.5.1', 'attempt_failed_at', 'projection_attempt.failed_at', 'exact nullable instant', 'L', 'failed-only', 'REQUIRED', 'failure time'),
  // ---- §9.5.2 Receipt and effect-truth mapping (21 rows) ----
  row('9.5.2', 'receipt_id', 'projection_receipt.receipt_id', 'exact copy', 'L', 'unique + attempt binding', 'FORBIDDEN_TO_DROP', 'effect identity'),
  row('9.5.2', 'receipt_operation_key', 'projection_receipt.operation_key', 'exact copy', 'L', 'outbox equality', 'FORBIDDEN_TO_DROP', 'idempotency'),
  row('9.5.2', 'receipt_attempt_id', 'projection_receipt.attempt_id', 'exact copy', 'L', 'attempt exists', 'FORBIDDEN_TO_DROP', 'attempt binding'),
  row('9.5.2', 'outcome', 'projection_receipt.effect_state', 'exact `succeeded/failed/ambiguous`', 'L', 'evidence/state consistency', 'FORBIDDEN_TO_DROP', 'effect truth'),
  row('9.5.2', 'target_projection_ref', 'projection_receipt.projection_result_ref', 'exact nullable ref', 'L', 'required for succeeded', 'REQUIRED', 'target identity'),
  row('9.5.2', 'target_revision_before', 'projection_receipt.target_revision_before', 'exact revision', 'L', 'target evidence equality', 'REQUIRED', 'effect delta'),
  row('9.5.2', 'target_revision_after', 'projection_receipt.target_revision_after', 'exact revision', 'L', 'succeeded monotonicity', 'FORBIDDEN_TO_DROP', 'effect revision'),
  row('9.5.2', 'upstream_evidence_ref', 'projection_receipt.upstream_evidence_ref', 'exact durable ref', 'L', 'issuer/target/digest check', 'FORBIDDEN_TO_DROP', 'conclusive evidence'),
  row('9.5.2', 'response_digest', 'projection_receipt.response_digest', 'exact digest of bounded response envelope', 'L', 'recompute from evidence', 'REQUIRED', 'receipt integrity'),
  row('9.5.2', 'idempotency_disposition', 'projection_receipt.idempotency_disposition', 'exact enum `new/exact_replay/conflict`', 'L', 'key/digest consistency', 'REQUIRED', 'replay handling'),
  row('9.5.2', 'receipt_adapter_id', 'projection_receipt.adapter_id', 'exact id', 'L', 'attempt equality', 'FORBIDDEN_TO_DROP', 'executor identity'),
  row('9.5.2', 'receipt_adapter_version', 'projection_receipt.adapter_version', 'exact version', 'L', 'attempt equality', 'FORBIDDEN_TO_DROP', 'executor pin'),
  row('9.5.2', 'receipt_upstream_version', 'projection_receipt.upstream_version', 'exact version', 'L', 'attempt equality', 'FORBIDDEN_TO_DROP', 'upstream pin'),
  row('9.5.2', 'issued_at', 'projection_receipt.issued_at', 'instant-preserving', 'L', 'trusted clock/order', 'REQUIRED', 'effect ordering'),
  row('9.5.2', 'issuer_id', 'projection_receipt.issuer_id', 'exact trusted issuer', 'L', 'allowlist/signature if applicable', 'REQUIRED', 'trust'),
  row('9.5.2', 'ambiguous_reason_code', 'projection_reconciliation.ambiguous_reason_code', 'exact typed code', 'L', 'ambiguous-only', 'FORBIDDEN_TO_DROP', 'blocks retry'),
  row('9.5.2', 'reconciliation_state', 'projection_reconciliation.state', 'exact enum', 'L', 'transition replay', 'FORBIDDEN_TO_DROP', 'ownership'),
  row('9.5.2', 'reconciliation_operation_id', 'projection_reconciliation.operation_id', 'exact copy', 'L', 'original key/attempt binding', 'REQUIRED', 'reconciliation identity'),
  row('9.5.2', 'reconciliation_evidence_refs', 'projection_reconciliation.evidence_refs[]', 'stable-order exact refs', 'L', 'conclusive/ambiguous reducer validation', 'FORBIDDEN_TO_DROP', 'outcome proof'),
  row('9.5.2', 'reconciliation_evidence_digest', 'projection_reconciliation.evidence_set_digest', 'exact set digest', 'L', 'recompute equality', 'FORBIDDEN_TO_DROP', 'evidence integrity'),
  row('9.5.2', 'reconciled_at', 'projection_reconciliation.reconciled_at', 'exact nullable instant', 'L', 'state/order', 'REQUIRED', 'audit'),
  // ---- §9.5.3 Revision snapshot and migration/lifecycle mapping (26 rows) ----
  row('9.5.3', 'snapshot_id', 'projection_snapshot.snapshot_id', 'exact copy', 'L', 'unique', 'REQUIRED', 'snapshot identity'),
  row('9.5.3', 'projection_revision', 'projection_snapshot.projection_revision', 'exact revision', 'L', 'receipt/manifest equality', 'FORBIDDEN_TO_DROP', 'Lite/Full parity'),
  row('9.5.3', 'snapshot_content_digest', 'projection_snapshot.content_digest', 'exact digest', 'L', 'recompute snapshot when payload exists', 'REQUIRED', 'integrity'),
  row('9.5.3', 'snapshot_source_cursor', 'projection_snapshot.source_cursor', 'exact cursor', 'L', 'manifest equality', 'REQUIRED', 'coverage'),
  row('9.5.3', 'last_projection_receipt_id', 'projection_snapshot.last_receipt_id', 'exact ref', 'L', 'receipt exists', 'FORBIDDEN_TO_DROP', 'effect boundary'),
  row('9.5.3', 'snapshot_adapter_policy_digest', 'projection_snapshot.adapter_policy_digest', 'exact digest', 'L', 'attempt/manifest equality', 'REQUIRED', 'policy provenance'),
  row('9.5.3', 'snapshot_upstream_version', 'projection_snapshot.upstream_version', 'exact version', 'L', 'receipt equality', 'FORBIDDEN_TO_DROP', 'upstream provenance'),
  row('9.5.3', 'revision_refresh_state', 'projection_snapshot.refresh_state', 'exact enum', 'L', 'receipt/snapshot consistency', 'REQUIRED', 'availability truth'),
  row('9.5.3', 'snapshot_created_at', 'projection_snapshot.created_at', 'instant-preserving', 'L', 'order', 'AUDIT_ONLY', 'audit'),
  row('9.5.3', 'migration_state', 'compatibility_migration_record.state', '§9.3.8 exact state', 'L', 'transition replay', 'FORBIDDEN_TO_DROP', 'ownership handoff'),
  row('9.5.3', 'cutover_id', 'compatibility_migration_record.cutover_id', 'exact copy', 'L', 'manifest equality', 'REQUIRED', 'transaction identity'),
  row('9.5.3', 'migration_manifest_entry_id', 'compatibility_migration_record.manifest_entry_id', 'exact copy', 'L', 'deterministic manifest membership', 'REQUIRED', 'row identity'),
  row('9.5.3', 'migrated_ledger_id', 'compatibility_migration_record.core_ledger_id', 'exact Core id', 'L', 'target row equality', 'FORBIDDEN_TO_DROP', 'handoff proof'),
  row('9.5.3', 'migrated_outbox_id', 'compatibility_migration_record.core_outbox_id', 'exact nullable Core id', 'L', 'state mapping determines presence', 'FORBIDDEN_TO_DROP', 'scheduler handoff'),
  row('9.5.3', 'frozen_queue_cursor', 'compatibility_migration_record.frozen_queue_cursor', 'exact opaque cursor', 'L', 'global marker equality', 'FORBIDDEN_TO_DROP', 'selection boundary'),
  row('9.5.3', 'frozen_source_cursor', 'compatibility_migration_record.frozen_source_cursor', 'exact opaque cursor', 'L', 'global marker equality', 'FORBIDDEN_TO_DROP', 'ingress boundary'),
  row('9.5.3', 'retired_writer_epoch', 'compatibility_migration_record.retired_writer_epoch', 'exact epoch', 'L', 'writer lease/fence proof', 'FORBIDDEN_TO_DROP', 'old-writer rejection'),
  row('9.5.3', 'migrated_at', 'compatibility_migration_record.migrated_at', 'exact instant', 'L', 'Core commit order', 'REQUIRED', 'handoff time'),
  row('9.5.3', 'migrated_marker_ref', 'compatibility_migration_record.marker_ref', 'exact ref', 'L', 'checksum/signature', 'FORBIDDEN_TO_DROP', 'immutable marker'),
  row('9.5.3', 'supersedes_operation_id', 'publication_lifecycle.supersedes_operation_id', 'exact copy', 'L', 'graph validity', 'FORBIDDEN_TO_DROP', 'lifecycle edge'),
  row('9.5.3', 'tombstone_ref', 'publication_lifecycle.tombstone_ref', 'exact typed ref', 'L', 'lifecycle target equality', 'FORBIDDEN_TO_DROP', 'non-revival'),
  row('9.5.3', 'tombstone_state', 'publication_lifecycle.tombstone_state', 'exact enum', 'L', 'payload absent where required', 'FORBIDDEN_TO_DROP', 'non-revival'),
  row('9.5.3', 'delete_state', 'publication_lifecycle.delete_state', 'exact enum', 'L', 'cascade evidence', 'FORBIDDEN_TO_DROP', 'deletion'),
  row('9.5.3', 'payload_deletion_state', 'publication_payload.deletion_state', 'exact enum', 'L', 'ref/storage consistency', 'FORBIDDEN_TO_DROP', 'erasure'),
  row('9.5.3', 'payload_deleted_at', 'publication_payload.deleted_at', 'exact nullable instant', 'L', 'deleted-only', 'REQUIRED', 'retention proof'),
  row('9.5.3', 'typed_disposal_record_ref', 'compatibility_migration_record.disposal_record_ref', 'exact ref', 'L', 'owner/reason/no-effect proof', 'REQUIRED', 'rejected/voided disposal'),
]);

function stateRow(compat_state, core_import_result, mandatory_effect, classification, extra = {}) {
  return Object.freeze({
    compat_state,
    aliases: Object.freeze(extra.aliases || []),
    condition: extra.condition ? Object.freeze(extra.condition) : null,
    core_import_result,
    mandatory_effect,
    // `classification` is derived (not contract text): a machine-checkable
    // bucket for the verbatim core_import_result, so validators can assert
    // reconciliation-required semantics without parsing natural language.
    classification,
    reconciliation_required: classification === 'reconciliation_required',
  });
}

// §9.5.4 Compatibility-to-Core state mapping — verbatim transcription of the
// four state tables. Aliases in parentheses (`accepted`, `ready`) are recorded
// as written but are NOT canonical queue item states (constants.mjs keeps v0.1
// canonical names only) and are never accepted as input.
export const STATE_MAPPING = Object.freeze({
  // Queue item + migration state table (28 rows).
  item: Object.freeze([
    stateRow('received', 'ledger audit + Core ingress-stage work；无 mutation outbox', 'source binding保留；不得猜为 authorized', 'stage_work', { aliases: ['accepted'] }),
    stateRow('curating', 'ledger audit + Core curator-stage work；无 mutation outbox', 'Curator provenance保留', 'stage_work'),
    stateRow('reviewing', 'ledger audit + Core reviewer-stage work；无 mutation outbox', 'Reviewer provenance保留', 'stage_work'),
    stateRow('gate_pending', 'ledger audit + Core gate-stage work；无 mutation outbox', 'gate typed input保留；不得猜为 authorized', 'stage_work'),
    stateRow('authorized', '`projection_outbox.state=pending`', '原 operation key；attempt 尚无 intent', 'outbox_pending', { aliases: ['ready'] }),
    stateRow('dispatching', 'ledger committed + receipt；outbox completed', '不重投', 'ledger_committed', { condition: { receipt_outcome: 'succeeded' } }),
    stateRow('dispatching', 'typed failed attempt', '保留 retryability', 'typed_failed_attempt', { condition: { receipt_outcome: 'failed' } }),
    stateRow('dispatching', '`projection_reconciliation.state=required`', '不能映射 ordinary pending', 'reconciliation_required', { condition: { receipt_outcome: null } }),
    stateRow('ambiguous', 'Core reconciliation-required', '不能映射 failed；不能重发', 'reconciliation_required'),
    stateRow('reconciling', 'Core reconciliation operation，保留原 key/attempt', '只读 evidence；不创建 mutation', 'reconciliation_required'),
    stateRow('failed', 'typed failed attempt + `retryable` snapshot', 'retryable 时由 Core 创建新 attempt；旧 attempt不变', 'typed_failed_attempt'),
    stateRow('published', '`publication_ledger.state=committed` + completed outbox + receipt', 'receipt/evidence/projection revision preserved', 'ledger_committed'),
    stateRow('published', 'ledger committed；snapshot refresh pending/failed', 'effect truth 与 read availability 分离', 'ledger_committed', { condition: { refresh_states: ['pending', 'building', 'failed'] } }),
    stateRow('withdrawn', 'cancelled lifecycle state；无 outbox effect', 'payload按 deletion domain处理', 'lifecycle_cancelled'),
    stateRow('superseded', 'superseded/cancelled lifecycle state', 'supersession edge preserved', 'lifecycle_superseded'),
    stateRow('suppressed', 'Core lifecycle suppression committed', '原 published receipt保留；不可见性生效', 'lifecycle_suppressed'),
    stateRow('tombstoned', 'Core lifecycle tombstone committed', 'tombstone与非复活约束保留', 'lifecycle_tombstoned'),
    stateRow('deleted', 'Core deletion committed', '正文不迁移；仅保留合规 tombstone', 'lifecycle_deleted'),
    stateRow('deleting', 'deletion reconciliation/pending lifecycle operation', '不当普通 growth pending', 'deletion_reconciliation'),
    stateRow('rejected', 'audit-only；无 outbox effect', '按 retention保留，或 owner typed disposal', 'audit_only'),
    stateRow('fenced', 'compatibility-dispatch-ineligible', '仅 migration/lifecycle/reconciliation', 'dispatch_ineligible'),
    stateRow('voided', 'typed disposed；无 outbox effect', '必须证明无 succeeded/ambiguous effect', 'disposed'),
    stateRow('not_selected', 'not yet in frozen migration manifest', 'Gate 5 不能 activation，直到被选入或 typed void', 'migration_not_selected'),
    stateRow('migration_pending', 'migration transaction pending', 'compatibility writer仍 fenced', 'migration_pending'),
    stateRow('migrating', 'Core staged import，不得 active dispatch', 'restart幂等继续', 'migration_staged'),
    stateRow('migration_failed', 'blocked migration', 'Gate 5 不得继续', 'migration_blocked'),
    stateRow('migrated', 'immutable migrated marker + Core single-source ownership', '旧 writer 永久拒绝', 'migration_migrated'),
    stateRow('migration_voided', 'typed disposal marker', '仅无 effect item可用', 'migration_voided'),
  ]),
  // Attempt state 逐状态映射 (v0.7 adds source-revision supersession).
  attempt: Object.freeze([
    Object.freeze({ compat_state: 'not_started', core_target: '`projection_attempt.state=not_started`', cutover_rule: '只有 item authorized 时可形成 pending outbox', core_state: 'not_started', reconciliation_required: false }),
    Object.freeze({ compat_state: 'dispatching', core_target: '`projection_reconciliation.state=required`，除非已有 conclusive receipt', cutover_rule: '不作为普通 dispatching/pending 重发', core_state: 'reconciliation_required', reconciliation_required: true }),
    Object.freeze({ compat_state: 'superseded-by-source-revision', core_target: '`projection_attempt.state=superseded-by-source-revision`', cutover_rule: 'terminal non-failed；不得重发或转换为 failed', core_state: 'superseded-by-source-revision', reconciliation_required: false }),
    Object.freeze({ compat_state: 'succeeded', core_target: '`projection_attempt.state=succeeded` + receipt', cutover_rule: 'Core 不得创建新 attempt', core_state: 'succeeded', reconciliation_required: false }),
    Object.freeze({ compat_state: 'failed', core_target: '`projection_attempt.state=failed`', cutover_rule: 'retryability 原样保留', core_state: 'failed', reconciliation_required: false }),
    Object.freeze({ compat_state: 'ambiguous', core_target: '`projection_attempt.state=ambiguous` + reconciliation required', cutover_rule: '不转换为 failed', core_state: 'ambiguous', reconciliation_required: true }),
    Object.freeze({ compat_state: 'reconciling', core_target: '`projection_attempt.state=reconciling`', cutover_rule: '保留原 attempt/key，只继续 evidence reconciliation', core_state: 'reconciling', reconciliation_required: true }),
  ]),
  // Source lifecycle state 逐状态映射 (6 rows).
  source_lifecycle: Object.freeze([
    Object.freeze({ compat_state: 'current', core_state: 'current', core_target: '`publication_ledger.source_lifecycle_state=current`', cutover_rule: '仍须通过 source revision equality' }),
    Object.freeze({ compat_state: 'superseded', core_state: 'superseded', core_target: 'superseded', cutover_rule: 'supersession edge与新 revision必须存在' }),
    Object.freeze({ compat_state: 'withdrawn', core_state: 'withdrawn/cancelled', core_target: 'withdrawn/cancelled', cutover_rule: '阻止 pending dispatch' }),
    Object.freeze({ compat_state: 'suppressed', core_state: 'suppressed', core_target: 'suppressed', cutover_rule: 'target从 current views/recall移除' }),
    Object.freeze({ compat_state: 'deleting', core_state: 'deleting/reconciliation_required', core_target: 'deleting/reconciliation_required', cutover_rule: '不得当作普通 pending' }),
    Object.freeze({ compat_state: 'deleted', core_state: 'deleted/tombstoned', core_target: 'deleted/tombstoned', cutover_rule: '正文不迁移、迟到任务拒绝' }),
  ]),
  // Revision refresh state 逐状态映射 (5 rows).
  revision_refresh: Object.freeze([
    Object.freeze({ compat_state: 'not_required', core_state: 'not_required', cutover_rule: '无 succeeded projection或无 reader-visible变化' }),
    Object.freeze({ compat_state: 'pending', core_state: 'pending', cutover_rule: 'effect receipt 已保留；只调度 refresh' }),
    Object.freeze({ compat_state: 'building', core_state: 'pending', core_target: '`pending` + imported build audit', cutover_rule: '丢弃临时 build lease，按同 receipt/revision幂等重建' }),
    Object.freeze({ compat_state: 'published', core_state: 'published', cutover_rule: 'snapshot id/revision/digest完整保留' }),
    Object.freeze({ compat_state: 'failed', core_state: 'failed_retryable_by_refresh_policy', cutover_rule: '只重试 refresh，不重投 projection effect' }),
  ]),
});

function noStateMapping(kind, state) {
  return compatError('COMPAT_MAPPING_INCOMPLETE', `no §9.5.4 ${kind} state mapping for "${state}"`);
}

// §9.5.4 item-state lookup. `context.receipt_outcome` ('succeeded'|'failed')
// selects the conclusive-receipt dispatching rows; without a conclusive
// receipt `dispatching` defaults to the reconciliation-required row (fail
// safe — never ordinary pending/failed). `context.refresh_state` selects the
// published + refresh-pending/failed variant. ambiguous/reconciling ALWAYS
// return reconciliation-required class results, never failed/succeeded/pending.
export function mapItemStateToCore(state, context = {}) {
  const name = String(state || '');
  const rows = STATE_MAPPING.item.filter((entry) => entry.compat_state === name);
  if (rows.length === 0) throw noStateMapping('item', name);
  if (name === 'dispatching') {
    const outcome = context.receipt_outcome === 'succeeded' || context.receipt_outcome === 'failed'
      ? context.receipt_outcome
      : null;
    return rows.find((entry) => entry.condition && entry.condition.receipt_outcome === outcome);
  }
  if (name === 'published') {
    const refresh = String(context.refresh_state || '');
    const variant = rows.find((entry) => entry.condition && entry.condition.refresh_states
      && entry.condition.refresh_states.includes(refresh));
    return variant || rows.find((entry) => entry.condition === null);
  }
  return rows.find((entry) => entry.condition === null) || rows[0];
}

// §9.5.4 migration-state rows live in the item table (not_selected …
// migration_voided); exposed separately for caller clarity.
export function mapMigrationStateToCore(state) {
  const name = String(state || '');
  if (!MIGRATION_STATES.includes(name)) throw noStateMapping('migration', name);
  return mapItemStateToCore(name);
}

// §9.5.4 attempt-state lookup. `dispatching` maps to reconciliation-required
// (never re-dispatched as ordinary dispatching/pending); `ambiguous` is never
// converted to failed.
export function mapAttemptStateToCore(state) {
  const name = String(state || '');
  const entry = STATE_MAPPING.attempt.find((candidate) => candidate.compat_state === name);
  if (!entry) throw noStateMapping('attempt', name);
  return entry;
}

// §9.5.4 source-lifecycle lookup. `deleting` maps to
// deleting/reconciliation_required — never ordinary pending.
export function mapSourceLifecycleToCore(state) {
  const name = String(state || '');
  const entry = STATE_MAPPING.source_lifecycle.find((candidate) => candidate.compat_state === name);
  if (!entry) throw noStateMapping('source lifecycle', name);
  return entry;
}

// §9.5.4 revision-refresh lookup. `building` degrades to pending + imported
// build audit; `failed` maps to failed_retryable_by_refresh_policy (refresh
// retry only, never a projection-effect re-dispatch).
export function mapRefreshStateToCore(state) {
  const name = String(state || '');
  const entry = STATE_MAPPING.revision_refresh.find((candidate) => candidate.compat_state === name);
  if (!entry) throw noStateMapping('revision refresh', name);
  return entry;
}

// ---------------------------------------------------------------------------
// Registry indexes and integrity validation
// ---------------------------------------------------------------------------

const REGISTRY_TABLES = Object.freeze(['9.4.2', '9.4.3', '9.4.4', '9.5.1', '9.5.2', '9.5.3']);
const FIDELITY_VALUES = Object.freeze(['L', 'D']);

function registryRowsByField() {
  const index = new Map();
  for (const entry of MAPPING_REGISTRY) {
    if (!index.has(entry.field)) index.set(entry.field, []);
    index.get(entry.field).push(entry);
  }
  return index;
}

const ROWS_BY_FIELD = registryRowsByField();

export function registryRowsForField(field) {
  return ROWS_BY_FIELD.get(String(field || '')) || [];
}

// Fail-closed strictness order (§9.5.5): when the contract assigns the same
// field different dispositions on different targets (verbatim variance, e.g.
// `source_event_id` → publication_ledger FORBIDDEN_TO_DROP vs
// projection_outbox REQUIRED; `supersedes_operation_id` → publication_ledger
// REQUIRED vs publication_lifecycle FORBIDDEN_TO_DROP), the strictest class
// wins for classification purposes.
const DISPOSITION_STRICTNESS = Object.freeze([
  'DISCARDABLE', 'AUDIT_ONLY', 'DERIVABLE', 'REQUIRED', 'FORBIDDEN_TO_DROP',
]);

// §9.5.5: a field that exists in the real schema but not in this registry
// defaults to REQUIRED_UNKNOWN and fails closed; only a later calibration may
// reclassify it AUDIT_ONLY/DERIVABLE/DISCARDABLE. Never stuff into metadata.
export function classifyField(field) {
  const rows = registryRowsForField(field);
  if (rows.length === 0) return 'REQUIRED_UNKNOWN';
  let strictest = 'DISCARDABLE';
  for (const entry of rows) {
    if (DISPOSITION_STRICTNESS.indexOf(entry.unmapped_disposition)
      > DISPOSITION_STRICTNESS.indexOf(strictest)) {
      strictest = entry.unmapped_disposition;
    }
  }
  return strictest;
}

function inventoryEntries() {
  const entries = [];
  for (const [record, fields] of Object.entries(CANONICAL_FIELD_INVENTORY)) {
    for (const field of fields) entries.push({ record, field });
  }
  return entries;
}

// Mapping completeness self-check (§9.3.1 + §9.5.5):
// (a) every inventory field occurrence has ≥ 1 registry row, and rows that
//     share the same (field, target) pair must agree on disposition;
// (b) every registry row has disposition ∈ MAPPING_CLASSES, fidelity ∈ L/D,
//     and a known §9.4.2–§9.5.3 table id;
// (c) the registry carries no field outside the §9.3.1 inventory
//     (→ COMPAT_MAPPING_UNKNOWN_FIELD);
// (d) returns the coverage report.
export function validateMappingIntegrity() {
  const entries = inventoryEntries();
  const distinctFields = new Set(entries.map((entry) => entry.field));
  const perRecordSeen = new Set();
  for (const { record, field } of entries) {
    const key = `${record}.${field}`;
    if (perRecordSeen.has(key)) {
      throw compatError('COMPAT_MAPPING_INCOMPLETE', `duplicate inventory field ${key}`);
    }
    perRecordSeen.add(key);
    const rows = registryRowsForField(field);
    if (rows.length === 0) {
      throw compatError('COMPAT_MAPPING_INCOMPLETE', `inventory field ${key} has no §9.4.2–§9.5.3 registry row`);
    }
    const dispositionByTarget = new Map();
    for (const entry of rows) {
      const prior = dispositionByTarget.get(entry.target);
      if (prior && prior !== entry.unmapped_disposition) {
        throw compatError(
          'COMPAT_MAPPING_INCOMPLETE',
          `field ${field} target ${entry.target} has conflicting dispositions ${prior} vs ${entry.unmapped_disposition}`,
        );
      }
      dispositionByTarget.set(entry.target, entry.unmapped_disposition);
    }
  }
  for (const entry of MAPPING_REGISTRY) {
    if (!REGISTRY_TABLES.includes(entry.table)) {
      throw compatError('COMPAT_MAPPING_INCOMPLETE', `registry row ${entry.field} has unknown table ${entry.table}`);
    }
    if (!MAPPING_CLASSES.includes(entry.unmapped_disposition)) {
      throw compatError('COMPAT_MAPPING_INCOMPLETE', `registry row ${entry.field} (${entry.table}) has invalid disposition ${entry.unmapped_disposition}`);
    }
    if (!FIDELITY_VALUES.includes(entry.fidelity)) {
      throw compatError('COMPAT_MAPPING_INCOMPLETE', `registry row ${entry.field} (${entry.table}) has invalid fidelity ${entry.fidelity}`);
    }
    if (!distinctFields.has(entry.field)) {
      throw compatError('COMPAT_MAPPING_UNKNOWN_FIELD', `registry row ${entry.field} (${entry.table}) is not in the §9.3.1 inventory`);
    }
  }
  const unmapped = entries
    .filter(({ field }) => registryRowsForField(field).length === 0)
    .map(({ record, field }) => `${record}.${field}`);
  const covered = entries.length - unmapped.length;
  const coverage_pct = entries.length === 0 ? 100 : Math.round((covered / entries.length) * 10000) / 100;
  return Object.freeze({
    inventory_field_count: entries.length,
    distinct_field_count: distinctFields.size,
    mapping_row_count: MAPPING_REGISTRY.length,
    coverage_pct,
    unmapped: Object.freeze(unmapped),
  });
}

// Module-load self-check: importing this module proves registry↔inventory
// integrity once; a broken transcription fails loud at import time.
export const MAPPING_INTEGRITY_REPORT = validateMappingIntegrity();

// ---------------------------------------------------------------------------
// Enum validation (constants.mjs frozen enum sets)
// ---------------------------------------------------------------------------

// Enum-typed fields validated against the frozen constants enum sets.
// `reconciliation_state`, `tombstone_state`, `delete_state` and
// `payload_deletion_state` have no frozen enum set in constants.mjs, so they
// are not enum-gated here (their mapping rows still apply verbatim).
const ENUM_FIELD_SETS = Object.freeze({
  queue_item_state: QUEUE_ITEM_STATES,
  adapter_attempt_state: ADAPTER_ATTEMPT_STATES,
  migration_state: MIGRATION_STATES,
  revision_refresh_state: REVISION_REFRESH_STATES,
  lifecycle_state: SOURCE_LIFECYCLE_STATES,
  source_lifecycle_state: SOURCE_LIFECYCLE_STATES,
  outcome: RECEIPT_OUTCOMES,
  reviewer_decision: REVIEWER_DECISIONS,
  gate_decision: GATE_DECISIONS,
  presentation_state: PRESENTATION_STATES,
  sensitivity: SENSITIVITY_LEVELS,
});

const VIEW_SECTIONS = Object.freeze([
  'sources', 'items', 'operations', 'attempts', 'receipts', 'snapshots', 'tombstones', 'migration',
]);

function sectionRecords(view, section) {
  const value = view[section];
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

// Every state/lifecycle/decision/outcome enum appearing in the view must be a
// member of the frozen constants enum sets; anything else is an unknown enum
// and fails closed with COMPAT_MAPPING_INCOMPLETE.
export function assertNoUnknownEnum({ view } = {}) {
  if (!view || typeof view !== 'object') {
    throw compatError('COMPAT_MAPPING_INCOMPLETE', 'enum validation requires a view object');
  }
  for (const section of VIEW_SECTIONS) {
    const records = sectionRecords(view, section);
    records.forEach((record, index) => {
      if (!record || typeof record !== 'object' || Array.isArray(record)) {
        throw compatError('COMPAT_MAPPING_INCOMPLETE', `${section}[${index}] is not a record object`);
      }
      for (const [field, allowed] of Object.entries(ENUM_FIELD_SETS)) {
        const value = record[field];
        if (value === undefined || value === null) continue;
        if (!allowed.includes(value)) {
          throw compatError(
            'COMPAT_MAPPING_INCOMPLETE',
            `unknown enum ${section}[${index}].${field}="${value}" (not in frozen constants set)`,
          );
        }
      }
    });
  }
  return true;
}

// ---------------------------------------------------------------------------
// Dry-run migration (no Core writer activation, no real migration)
// ---------------------------------------------------------------------------

function isNullableRow(entry) {
  // The contract marks legitimately nullable conversions with "nullable"
  // (e.g. projection_receipt_ref "exact nullable ref", projection_revision
  // "exact nullable revision", migrated_outbox_id "exact nullable Core id").
  return entry.conversion.includes('nullable');
}

function deriveAttemptCount(record, attempts) {
  return attempts.filter((attempt) => (
    (record.operation_id !== undefined && attempt.operation_id === record.operation_id)
    || (record.queue_item_id !== undefined && attempt.queue_item_id === record.queue_item_id)
  )).length;
}

function importContextFor(record, view) {
  const context = {};
  if (record.revision_refresh_state !== undefined) context.refresh_state = record.revision_refresh_state;
  if (record.queue_item_state === 'dispatching') {
    const receipts = sectionRecords(view, 'receipts').filter(
      (receipt) => receipt.receipt_operation_key === record.operation_key,
    );
    if (receipts.some((receipt) => receipt.outcome === 'succeeded')) context.receipt_outcome = 'succeeded';
    else if (receipts.some((receipt) => receipt.outcome === 'failed')) context.receipt_outcome = 'failed';
  }
  return context;
}

function convertFieldValue(entry, value, context) {
  switch (entry.field) {
    case 'queue_item_state': {
      const result = mapItemStateToCore(value, importContextFor(context.record, context.view));
      return Object.freeze({ imported_state: result.core_import_result, classification: result.classification });
    }
    case 'adapter_attempt_state':
      return mapAttemptStateToCore(value).core_state;
    case 'lifecycle_state':
    case 'source_lifecycle_state':
      return mapSourceLifecycleToCore(value).core_state;
    case 'revision_refresh_state':
      return mapRefreshStateToCore(value).core_state;
    case 'migration_state':
      return mapMigrationStateToCore(value).core_import_result;
    case 'attempt_count': {
      // DERIVABLE (§9.5.1): rebuild as count of preserved projection_attempt
      // rows and verify count equality with the stored value.
      const derived = deriveAttemptCount(context.record, context.attempts);
      if (derived !== value) {
        throw compatError(
          'COMPAT_MAPPING_INCOMPLETE',
          `attempt_count mismatch on ${context.section}[${context.index}]: stored ${value} vs derived ${derived} (§9.5.1 count equality)`,
        );
      }
      return derived;
    }
    default:
      // Exact-copy family: identity conversion. operation_key in particular
      // is preserved verbatim and never recomputed (§9.4.4/§9.5.1 不得重算).
      return value;
  }
}

// Dry-run a fixture view (queueStore.exportView() shape) against the registry,
// converting every field of every record into `coreTarget` (plain-object
// collector). Fail-closed rules:
//  (i)   a record field outside the registry/inventory → COMPAT_MAPPING_UNKNOWN_FIELD;
//  (ii)  a FORBIDDEN_TO_DROP field nulled (undefined, or null where the
//        contract conversion is not "nullable") → COMPAT_MAPPING_INCOMPLETE;
//  (iii) returns a coverage report {records_processed, fields_mapped,
//        fields_total, coverage_pct: 100, unknown_fields: []};
//  (iv)  item queue_item_state ambiguous/reconciling (or dispatching without
//        a conclusive receipt) → coreTarget import result is
//        reconciliation-required and coreTarget.mutation_invocation_count === 0;
//  (v)   operation_key is asserted preserved verbatim on every mapped target;
//  (vi)  attempt_count is rebuilt via the DERIVABLE formula (attempts row
//        count) and must equal the stored value.
export function dryRunMigration({ view, coreTarget } = {}) {
  if (!view || typeof view !== 'object') {
    throw compatError('COMPAT_MAPPING_INCOMPLETE', 'dry-run requires a fixture view object');
  }
  const target = coreTarget && typeof coreTarget === 'object' ? coreTarget : {};
  if (!Array.isArray(target.rows)) target.rows = [];
  if (!target.item_imports || typeof target.item_imports !== 'object' || Array.isArray(target.item_imports)) {
    target.item_imports = {};
  }
  if (!Array.isArray(target.reconciliation_required_items)) target.reconciliation_required_items = [];
  // The Core writer is never activated by a dry run; this counter exists only
  // to prove no Core mutation invocation happened (§9.5.6 rule 6).
  target.mutation_invocation_count = 0;

  assertNoUnknownEnum({ view });

  const attempts = sectionRecords(view, 'attempts');
  let records_processed = 0;
  let fields_mapped = 0;
  let fields_total = 0;
  const unknown_fields = [];

  for (const section of VIEW_SECTIONS) {
    const records = sectionRecords(view, section);
    records.forEach((record, index) => {
      if (!record || typeof record !== 'object' || Array.isArray(record)) {
        throw compatError('COMPAT_MAPPING_INCOMPLETE', `${section}[${index}] is not a record object`);
      }
      records_processed += 1;
      const mapped = {};
      for (const [field, value] of Object.entries(record)) {
        if (value === undefined) continue; // absent field, not a nulled one
        fields_total += 1;
        const rows = registryRowsForField(field);
        if (rows.length === 0) {
          unknown_fields.push(`${section}[${index}].${field}`);
          throw compatError(
            'COMPAT_MAPPING_UNKNOWN_FIELD',
            `unmapped field ${section}[${index}].${field}: not in the §9.4.2–§9.5.3 registry (§9.5.5 REQUIRED_UNKNOWN, fail closed)`,
          );
        }
        // FORBIDDEN_TO_DROP forbids dropping/collapsing/forced-nulling (§9.5.5).
        // A genuinely nullable field ("exact nullable ref/revision") may carry
        // a typed null; nullability is evaluated across this field's rows so
        // context-bound rows (e.g. snapshot projection_revision) do not leak
        // non-nullability into nullable operation fields (§9.4.4 vs §9.5.3).
        const forbidsDrop = rows.some((entry) => entry.unmapped_disposition === 'FORBIDDEN_TO_DROP');
        const anyNullableRow = rows.some((entry) => isNullableRow(entry));
        if (forbidsDrop && value === null && !anyNullableRow) {
          throw compatError(
            'COMPAT_MAPPING_INCOMPLETE',
            `FORBIDDEN_TO_DROP field ${section}[${index}].${field} must not be nulled/collapsed (§9.5.5/§9.5.7)`,
          );
        }
        for (const entry of rows) {
          const converted = convertFieldValue(entry, value, {
            record, section, index, view, attempts,
          });
          if (entry.target.endsWith('.operation_key') && converted !== value) {
            throw compatError(
              'COMPAT_MAPPING_INCOMPLETE',
              `operation_key must be preserved verbatim on ${entry.target} (不得重算)`,
            );
          }
          mapped[entry.target] = converted;
        }
        fields_mapped += 1;
      }
      const entryRecord = { section, index, mapped };
      if ((section === 'items' || section === 'operations') && record.queue_item_state !== undefined) {
        const importResult = mapItemStateToCore(record.queue_item_state, importContextFor(record, view));
        entryRecord.import_result = importResult;
        const key = record.queue_item_id ?? record.operation_id ?? `${section}[${index}]`;
        target.item_imports[key] = importResult;
        if (importResult.reconciliation_required || importResult.classification === 'reconciliation_required') {
          if (!target.reconciliation_required_items.includes(key)) {
            target.reconciliation_required_items.push(key);
          }
        }
      }
      target.rows.push(entryRecord);
    });
  }

  if (target.mutation_invocation_count !== 0) {
    throw compatError('COMPAT_MAPPING_INCOMPLETE', 'dry run must never invoke a Core mutation (§9.5.6 rule 6)');
  }

  const report = Object.freeze({
    records_processed,
    fields_mapped,
    fields_total,
    coverage_pct: fields_total === 0 ? 100 : Math.round(((fields_total - unknown_fields.length) / fields_total) * 10000) / 100,
    unknown_fields: Object.freeze(unknown_fields.slice()),
  });
  target.report = report;
  return Object.freeze({ coreTarget: target, report });
}
