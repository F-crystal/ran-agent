import test from 'node:test';
import assert from 'node:assert/strict';

import {
  QUEUE_ITEM_STATES,
  ADAPTER_ATTEMPT_STATES,
  MIGRATION_STATES,
  REVISION_REFRESH_STATES,
  SOURCE_LIFECYCLE_STATES,
  MAPPING_CLASSES,
} from '../src/ombreCompat/constants.mjs';
import { canonicalDigest } from '../src/ombreCompat/canonical.mjs';
import {
  CANONICAL_FIELD_INVENTORY,
  MAPPING_REGISTRY,
  MAPPING_INTEGRITY_REPORT,
  STATE_MAPPING,
  registryRowsForField,
  validateMappingIntegrity,
  classifyField,
  mapItemStateToCore,
  mapMigrationStateToCore,
  mapAttemptStateToCore,
  mapSourceLifecycleToCore,
  mapRefreshStateToCore,
  assertNoUnknownEnum,
  dryRunMigration,
} from '../src/ombreCompat/migrationMapping.mjs';

// ---------------------------------------------------------------------------
// Fixture: queueStore.exportView()-shaped view with one published item, one
// ambiguous item, and full attempts/receipts/snapshots/tombstones/migration.
// Only §9.3.1 inventory field names are used (strict field-level checking).
// ---------------------------------------------------------------------------

const OP_KEY_PUBLISHED = canonicalDigest('operation-key-published');
const OP_KEY_AMBIGUOUS = canonicalDigest('operation-key-ambiguous');
const SRC_DIGEST = canonicalDigest('source-event');
const SCOPE_DIGEST = canonicalDigest('scope-envelope');
const POLICY_DIGEST = canonicalDigest('adapter-policy');

function makeFixtureView() {
  return {
    fence: { active: true, revision: 4 }, // runtime metadata; not a migrated record section
    sources: [
      {
        schema_version: 'compatibility.final-turn/v1',
        event_id: 'ocq_src_1',
        conversation_id: 'conv-1',
        exchange_id: 'ex-1',
        source_revision: 3,
        source_event_digest: SRC_DIGEST,
        user_final_payload_ref: 'payload://user-1',
        user_final_payload_revision: 1,
        user_final_payload_digest: canonicalDigest('user-payload'),
        assistant_final_payload_ref: 'payload://assistant-1',
        assistant_final_payload_revision: 1,
        assistant_final_payload_digest: canonicalDigest('assistant-payload'),
        final_content_digest: canonicalDigest('final-content'),
        scope_envelope_ref: 'scope://env-1',
        scope_envelope_digest: SCOPE_DIGEST,
        sensitivity: 'standard',
        presentation_state: 'presented',
        trusted_action_receipt_refs: [],
        trusted_action_receipts_digest: canonicalDigest('action-receipt-set'),
        source_gate_receipt_ref: 'receipt://final-gate-1',
        emitter_id: 'node-final-gate-compat-emitter',
        emitter_version: '1.0.0-local',
        emitted_at: '2026-07-27T00:00:00.000Z',
        lifecycle_state: 'current',
      },
    ],
    items: [
      {
        queue_item_id: 'ocq_item_pub',
        operation_id: 'ocq_op_pub',
        operation_key: OP_KEY_PUBLISHED,
        queue_item_state: 'published',
        source_lifecycle_state: 'current',
        migration_state: 'not_selected',
        revision_refresh_state: 'published',
      },
      {
        queue_item_id: 'ocq_item_amb',
        operation_id: 'ocq_op_amb',
        operation_key: OP_KEY_AMBIGUOUS,
        queue_item_state: 'ambiguous',
        source_lifecycle_state: 'current',
        migration_state: 'not_selected',
        revision_refresh_state: 'not_required',
      },
    ],
    operations: [
      {
        queue_item_id: 'ocq_item_pub',
        operation_id: 'ocq_op_pub',
        operation_key: OP_KEY_PUBLISHED,
        source_event_id: 'ocq_src_1',
        source_revision: 3,
        source_event_digest: SRC_DIGEST,
        candidate_id: 'ocq_cand_1',
        authority_owner: 'legacy_final_truth',
        projection_target: 'ombre_local_projection',
        scope_envelope_ref: 'scope://env-1',
        scope_envelope_digest: SCOPE_DIGEST,
        sensitivity: 'standard',
        deletion_domain: 'compat_payload_default',
        queue_item_state: 'published',
        source_lifecycle_state: 'current',
        migration_state: 'not_selected',
        revision_refresh_state: 'published',
        retryable: false,
        attempt_count: 1,
        projection_receipt_ref: 'ocq_rcpt_pub',
        projection_revision: 7,
        created_at: '2026-07-27T00:01:00.000Z',
        updated_at: '2026-07-27T00:02:00.000Z',
        terminal_at: '2026-07-27T00:02:00.000Z',
      },
      {
        queue_item_id: 'ocq_item_amb',
        operation_id: 'ocq_op_amb',
        operation_key: OP_KEY_AMBIGUOUS,
        source_event_id: 'ocq_src_1',
        source_revision: 3,
        source_event_digest: SRC_DIGEST,
        candidate_id: 'ocq_cand_2',
        authority_owner: 'legacy_final_truth',
        projection_target: 'ombre_local_projection',
        scope_envelope_ref: 'scope://env-1',
        scope_envelope_digest: SCOPE_DIGEST,
        sensitivity: 'standard',
        deletion_domain: 'compat_payload_default',
        queue_item_state: 'ambiguous',
        source_lifecycle_state: 'current',
        migration_state: 'not_selected',
        revision_refresh_state: 'not_required',
        retryable: false,
        attempt_count: 1,
        // FORBIDDEN_TO_DROP but contract-nullable ("exact nullable ref"/
        // "exact nullable revision"): null is legal here, dropping is not.
        projection_receipt_ref: null,
        projection_revision: null,
        created_at: '2026-07-27T00:03:00.000Z',
        updated_at: '2026-07-27T00:04:00.000Z',
      },
    ],
    attempts: [
      {
        dispatch_intent_id: 'ocq_intent_pub',
        dispatch_intent_digest: canonicalDigest('intent-pub'),
        dispatch_intent_committed_seq: 11,
        attempt_id: 'ocq_att_pub_1',
        attempt_number: 1,
        adapter_attempt_state: 'succeeded',
        attempt_retryable: false,
        adapter_request_digest: canonicalDigest('request-pub'),
        adapter_id: 'ombre-steward-adapter',
        adapter_version: '1.0.0-local',
        adapter_policy_digest: POLICY_DIGEST,
        upstream_version: 'ombre-upstream@abc123',
        method_identifier: 'ombre.append_experience',
        attempt_created_at: '2026-07-27T00:01:30.000Z',
        attempt_updated_at: '2026-07-27T00:01:59.000Z',
        attempt_succeeded_at: '2026-07-27T00:01:59.000Z',
        operation_id: 'ocq_op_pub',
        queue_item_id: 'ocq_item_pub',
      },
      {
        dispatch_intent_id: 'ocq_intent_amb',
        dispatch_intent_digest: canonicalDigest('intent-amb'),
        dispatch_intent_committed_seq: 12,
        attempt_id: 'ocq_att_amb_1',
        attempt_number: 1,
        adapter_attempt_state: 'ambiguous',
        attempt_retryable: false,
        adapter_request_digest: canonicalDigest('request-amb'),
        adapter_id: 'ombre-steward-adapter',
        adapter_version: '1.0.0-local',
        adapter_policy_digest: POLICY_DIGEST,
        upstream_version: 'ombre-upstream@abc123',
        method_identifier: 'ombre.append_experience',
        attempt_created_at: '2026-07-27T00:03:30.000Z',
        attempt_updated_at: '2026-07-27T00:04:00.000Z',
        operation_id: 'ocq_op_amb',
        queue_item_id: 'ocq_item_amb',
      },
    ],
    receipts: [
      {
        receipt_id: 'ocq_rcpt_pub',
        receipt_operation_key: OP_KEY_PUBLISHED,
        receipt_attempt_id: 'ocq_att_pub_1',
        outcome: 'succeeded',
        target_projection_ref: 'ombre://experience/1',
        target_revision_before: 6,
        target_revision_after: 7,
        upstream_evidence_ref: 'evidence://upstream-1',
        response_digest: canonicalDigest('response-pub'),
        idempotency_disposition: 'new',
        receipt_adapter_id: 'ombre-steward-adapter',
        receipt_adapter_version: '1.0.0-local',
        receipt_upstream_version: 'ombre-upstream@abc123',
        issued_at: '2026-07-27T00:01:59.500Z',
        issuer_id: 'ombre-steward-adapter',
      },
      {
        receipt_id: 'ocq_rcpt_amb',
        receipt_operation_key: OP_KEY_AMBIGUOUS,
        receipt_attempt_id: 'ocq_att_amb_1',
        outcome: 'ambiguous',
        upstream_evidence_ref: 'evidence://upstream-2',
        response_digest: canonicalDigest('response-amb'),
        idempotency_disposition: 'new',
        receipt_adapter_id: 'ombre-steward-adapter',
        receipt_adapter_version: '1.0.0-local',
        receipt_upstream_version: 'ombre-upstream@abc123',
        issued_at: '2026-07-27T00:04:00.500Z',
        issuer_id: 'ombre-steward-adapter',
        ambiguous_reason_code: 'upstream_timeout_no_evidence',
        reconciliation_state: 'required',
        reconciliation_operation_id: 'ocq_recon_1',
        reconciliation_evidence_refs: ['evidence://upstream-2'],
        reconciliation_evidence_digest: canonicalDigest('recon-evidence-set'),
        reconciled_at: null,
      },
    ],
    snapshots: [
      {
        snapshot_id: 'ocq_snap_1',
        projection_revision: 7,
        snapshot_content_digest: canonicalDigest('snapshot-content'),
        snapshot_source_cursor: 'cursor://source/3',
        last_projection_receipt_id: 'ocq_rcpt_pub',
        snapshot_adapter_policy_digest: POLICY_DIGEST,
        snapshot_upstream_version: 'ombre-upstream@abc123',
        revision_refresh_state: 'published',
        snapshot_created_at: '2026-07-27T00:02:10.000Z',
      },
    ],
    tombstones: [
      {
        tombstone_ref: 'tombstone://op-old',
        tombstone_state: 'sealed',
        delete_state: 'none',
        payload_deletion_state: 'pending',
        payload_deleted_at: null,
      },
    ],
    migration: [
      {
        migration_state: 'not_selected',
        cutover_id: 'cutover_gate5_1',
        migration_manifest_entry_id: 'manifest_entry_1',
        frozen_queue_cursor: 'cursor://queue/9',
        frozen_source_cursor: 'cursor://source/9',
        retired_writer_epoch: 4,
      },
    ],
  };
}

function expectCompatError(code, fn, pattern) {
  assert.throws(fn, (error) => {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
}

function rowsOf(table) {
  return MAPPING_REGISTRY.filter((entry) => entry.table === table);
}

// ---------------------------------------------------------------------------
// 1. Registry ↔ inventory integrity (module-load self-check + fresh call).
//    Transcription-verified exact numbers:
//      inventory_field_count = 153 (11 records, cross-record duplicates counted)
//      distinct_field_count  = 143 (10 fields repeat across records)
//      mapping_row_count     = 161 (34+29+20+31+21+26 across §9.4.2–§9.5.3)
// ---------------------------------------------------------------------------

test('integrity: full coverage, exact transcribed counts, no unmapped fields', () => {
  const report = validateMappingIntegrity();
  assert.equal(report.coverage_pct, 100);
  assert.deepEqual(report.unmapped, []);
  // Exact transcription numbers (see comment above).
  assert.equal(report.inventory_field_count, 153);
  assert.equal(report.distinct_field_count, 143);
  assert.equal(report.mapping_row_count, 161);
  console.log(
    `[mapping-integrity] inventory_field_count=${report.inventory_field_count}`
      + ` distinct_field_count=${report.distinct_field_count}`
      + ` mapping_row_count=${report.mapping_row_count}`
      + ` coverage_pct=${report.coverage_pct}`,
  );
  // Module-load self-check ran the same validation at import time.
  assert.deepEqual(report, MAPPING_INTEGRITY_REPORT);
});

test('integrity: inventory record shapes and per-record field counts', () => {
  assert.deepEqual(Object.keys(CANONICAL_FIELD_INVENTORY), [
    'compat_source_binding',
    'compat_candidate',
    'compat_curator_provenance',
    'compat_reviewer_provenance',
    'compat_gate_provenance',
    'compat_operation',
    'compat_projection_attempt',
    'compat_projection_receipt',
    'compat_revision_snapshot',
    'compat_migration_record',
    'compat_lifecycle_event',
  ]);
  const counts = Object.fromEntries(
    Object.entries(CANONICAL_FIELD_INVENTORY).map(([record, fields]) => [record, fields.length]),
  );
  assert.deepEqual(counts, {
    compat_source_binding: 33,
    compat_candidate: 6,
    compat_curator_provenance: 7,
    compat_reviewer_provenance: 9,
    compat_gate_provenance: 7,
    compat_operation: 27,
    compat_projection_attempt: 17,
    compat_projection_receipt: 21,
    compat_revision_snapshot: 9,
    compat_migration_record: 11,
    compat_lifecycle_event: 6,
  });
  assert.equal(CANONICAL_FIELD_INVENTORY.compat_source_binding[0], 'schema_version');
  assert.equal(CANONICAL_FIELD_INVENTORY.compat_source_binding.at(-1), 'deletion_revision');
  assert.equal(CANONICAL_FIELD_INVENTORY.compat_lifecycle_event[0], 'supersedes_operation_id');
  assert.equal(CANONICAL_FIELD_INVENTORY.compat_lifecycle_event.at(-1), 'payload_deleted_at');
});

// ---------------------------------------------------------------------------
// 2. Transcription fidelity: first/last row of each of the six mapping tables
//    plus the contract-specified spot checks, verbatim against the contract.
// ---------------------------------------------------------------------------

test('transcription fidelity: per-table row counts and first/last rows verbatim', () => {
  assert.equal(rowsOf('9.4.2').length, 34);
  assert.equal(rowsOf('9.4.3').length, 29);
  assert.equal(rowsOf('9.4.4').length, 20);
  assert.equal(rowsOf('9.5.1').length, 31);
  assert.equal(rowsOf('9.5.2').length, 21);
  assert.equal(rowsOf('9.5.3').length, 26);

  assert.deepEqual(rowsOf('9.4.2')[0], {
    table: '9.4.2', field: 'schema_version', target: 'publication_source_binding.compat_schema_version',
    conversion: 'exact copy', fidelity: 'L', validation: 'allowlisted literal',
    unmapped_disposition: 'AUDIT_ONLY', cutover_effect: '选择 importer decoder',
  });
  assert.deepEqual(rowsOf('9.4.2').at(-1), {
    table: '9.4.2', field: 'deletion_revision', target: 'publication_lifecycle.deletion_revision',
    conversion: 'exact integer', fidelity: 'L', validation: 'monotonic/current',
    unmapped_disposition: 'FORBIDDEN_TO_DROP', cutover_effect: 'erasure fence',
  });
  assert.deepEqual(rowsOf('9.4.3')[0], {
    table: '9.4.3', field: 'candidate_id', target: 'publication_candidate.candidate_id',
    conversion: 'exact opaque copy', fidelity: 'L', validation: 'unique within source revision',
    unmapped_disposition: 'REQUIRED', cutover_effect: 'candidate identity',
  });
  assert.deepEqual(rowsOf('9.4.3').at(-1), {
    table: '9.4.3', field: 'budget_result', target: 'publication_gate_record.budget_result',
    conversion: 'exact typed counters/decision', fidelity: 'L', validation: 'recompute from typed records',
    unmapped_disposition: 'REQUIRED', cutover_effect: 'authorization bound',
  });
  assert.deepEqual(rowsOf('9.4.4')[0], {
    table: '9.4.4', field: 'operation_id', target: 'publication_ledger.compat_source_operation_id',
    conversion: 'exact copy；Core publication id另生成并反向记录', fidelity: 'L', validation: 'one-to-one manifest',
    unmapped_disposition: 'FORBIDDEN_TO_DROP', cutover_effect: 'migration identity',
  });
  assert.deepEqual(rowsOf('9.4.4').at(-1), {
    table: '9.4.4', field: 'terminal_at', target: 'publication_ledger.terminal_at',
    conversion: 'exact nullable instant', fidelity: 'L', validation: 'terminality consistency',
    unmapped_disposition: 'REQUIRED', cutover_effect: 'retention',
  });
  assert.deepEqual(rowsOf('9.5.1')[0], {
    table: '9.5.1', field: 'queue_item_id', target: 'projection_outbox.compat_source_item_id',
    conversion: 'exact copy', fidelity: 'L', validation: 'manifest one-to-one',
    unmapped_disposition: 'FORBIDDEN_TO_DROP', cutover_effect: 'queue identity',
  });
  assert.deepEqual(rowsOf('9.5.1').at(-1), {
    table: '9.5.1', field: 'attempt_failed_at', target: 'projection_attempt.failed_at',
    conversion: 'exact nullable instant', fidelity: 'L', validation: 'failed-only',
    unmapped_disposition: 'REQUIRED', cutover_effect: 'failure time',
  });
  assert.deepEqual(rowsOf('9.5.2')[0], {
    table: '9.5.2', field: 'receipt_id', target: 'projection_receipt.receipt_id',
    conversion: 'exact copy', fidelity: 'L', validation: 'unique + attempt binding',
    unmapped_disposition: 'FORBIDDEN_TO_DROP', cutover_effect: 'effect identity',
  });
  assert.deepEqual(rowsOf('9.5.2').at(-1), {
    table: '9.5.2', field: 'reconciled_at', target: 'projection_reconciliation.reconciled_at',
    conversion: 'exact nullable instant', fidelity: 'L', validation: 'state/order',
    unmapped_disposition: 'REQUIRED', cutover_effect: 'audit',
  });
  assert.deepEqual(rowsOf('9.5.3')[0], {
    table: '9.5.3', field: 'snapshot_id', target: 'projection_snapshot.snapshot_id',
    conversion: 'exact copy', fidelity: 'L', validation: 'unique',
    unmapped_disposition: 'REQUIRED', cutover_effect: 'snapshot identity',
  });
  assert.deepEqual(rowsOf('9.5.3').at(-1), {
    table: '9.5.3', field: 'typed_disposal_record_ref', target: 'compatibility_migration_record.disposal_record_ref',
    conversion: 'exact ref', fidelity: 'L', validation: 'owner/reason/no-effect proof',
    unmapped_disposition: 'REQUIRED', cutover_effect: 'rejected/voided disposal',
  });
});

test('transcription fidelity: contract-specified spot checks', () => {
  // §9.4.4: operation_key → publication_ledger.operation_key, FORBIDDEN_TO_DROP, 不得重算.
  const ledgerKey = rowsOf('9.4.4').find((entry) => entry.field === 'operation_key');
  assert.equal(ledgerKey.target, 'publication_ledger.operation_key');
  assert.equal(ledgerKey.conversion, 'exact bytes/string；不得重算');
  assert.equal(ledgerKey.unmapped_disposition, 'FORBIDDEN_TO_DROP');
  // §9.5.1 keeps its own operation_key row (multi-row field, contract as written).
  const outboxKey = rowsOf('9.5.1').find((entry) => entry.field === 'operation_key');
  assert.equal(outboxKey.target, 'projection_outbox.operation_key');
  assert.equal(outboxKey.unmapped_disposition, 'FORBIDDEN_TO_DROP');
  // §9.5.2: ambiguous_reason_code → projection_reconciliation.ambiguous_reason_code.
  const reason = rowsOf('9.5.2').find((entry) => entry.field === 'ambiguous_reason_code');
  assert.equal(reason.target, 'projection_reconciliation.ambiguous_reason_code');
  assert.equal(reason.conversion, 'exact typed code');
  assert.equal(reason.unmapped_disposition, 'FORBIDDEN_TO_DROP');
  assert.equal(reason.cutover_effect, 'blocks retry');
  // Every row disposition is a valid §9.5.5 class; fidelity is L or D.
  for (const entry of MAPPING_REGISTRY) {
    assert.ok(MAPPING_CLASSES.includes(entry.unmapped_disposition), `${entry.field} disposition`);
    assert.ok(entry.fidelity === 'L' || entry.fidelity === 'D', `${entry.field} fidelity`);
  }
});

test('classifyField: strictest disposition wins; unknown fails closed REQUIRED_UNKNOWN', () => {
  assert.equal(classifyField('operation_key'), 'FORBIDDEN_TO_DROP');
  // Verbatim contract variance across targets resolves to the strictest class.
  assert.equal(classifyField('source_event_id'), 'FORBIDDEN_TO_DROP');
  assert.equal(classifyField('supersedes_operation_id'), 'FORBIDDEN_TO_DROP');
  assert.equal(classifyField('attempt_count'), 'DERIVABLE');
  assert.equal(classifyField('emitter_id'), 'AUDIT_ONLY');
  assert.equal(classifyField('conversation_id'), 'REQUIRED');
  // §9.5.5: schema field not in the registry → REQUIRED_UNKNOWN, fail closed.
  assert.equal(classifyField('metadata'), 'REQUIRED_UNKNOWN');
  assert.equal(classifyField('totally_unknown_field'), 'REQUIRED_UNKNOWN');
});

// ---------------------------------------------------------------------------
// 3. Dry-run: published + ambiguous items with full evidence chain.
// ---------------------------------------------------------------------------

test('dry-run: 100% coverage, reconciliation-required import, zero Core mutation', () => {
  const view = makeFixtureView();
  const { coreTarget, report } = dryRunMigration({ view, coreTarget: {} });

  // (iii) coverage report.
  assert.equal(report.coverage_pct, 100);
  assert.deepEqual(report.unknown_fields, []);
  assert.equal(report.records_processed, 12); // 1 source + 2 items + 2 ops + 2 attempts + 2 receipts + 1 snapshot + 1 tombstone + 1 migration
  assert.equal(report.fields_total, report.fields_mapped);
  assert.ok(report.fields_total > 0);
  assert.deepEqual(coreTarget.report, report);
  console.log(
    `[dry-run] records_processed=${report.records_processed}`
      + ` fields_mapped=${report.fields_mapped}/${report.fields_total}`
      + ` coverage_pct=${report.coverage_pct}`
      + ` reconciliation_required=${coreTarget.reconciliation_required_items.join(',')}`,
  );

  // (iv) ambiguous item imports as reconciliation-required; no Core mutation.
  const ambiguousImport = coreTarget.item_imports.ocq_item_amb;
  assert.equal(ambiguousImport.classification, 'reconciliation_required');
  assert.equal(ambiguousImport.reconciliation_required, true);
  assert.equal(ambiguousImport.core_import_result, 'Core reconciliation-required');
  const publishedImport = coreTarget.item_imports.ocq_item_pub;
  assert.equal(publishedImport.classification, 'ledger_committed');
  assert.equal(publishedImport.reconciliation_required, false);
  assert.ok(coreTarget.reconciliation_required_items.includes('ocq_item_amb'));
  assert.ok(!coreTarget.reconciliation_required_items.includes('ocq_item_pub'));
  assert.equal(coreTarget.mutation_invocation_count, 0);

  // (v) operation_key preserved verbatim on both ledger and outbox targets.
  const pubOpRow = coreTarget.rows.find((entry) => entry.section === 'operations' && entry.index === 0);
  assert.equal(pubOpRow.mapped['publication_ledger.operation_key'], OP_KEY_PUBLISHED);
  assert.equal(pubOpRow.mapped['projection_outbox.operation_key'], OP_KEY_PUBLISHED);
  const ambReceiptRow = coreTarget.rows.find((entry) => entry.section === 'receipts' && entry.index === 1);
  assert.equal(ambReceiptRow.mapped['projection_receipt.operation_key'], OP_KEY_AMBIGUOUS);

  // (vi) attempt_count rebuilt by the DERIVABLE formula equals stored value.
  assert.equal(pubOpRow.mapped['projection_outbox.attempt_count'], 1);
  const ambOpRow = coreTarget.rows.find((entry) => entry.section === 'operations' && entry.index === 1);
  assert.equal(ambOpRow.mapped['projection_outbox.attempt_count'], 1);

  // State fields converted through §9.5.4 tables, not copied blindly.
  assert.equal(
    pubOpRow.mapped['publication_ledger.imported_item_state'].classification,
    'ledger_committed',
  );
  assert.equal(
    ambOpRow.mapped['projection_outbox.import_state'].classification,
    'reconciliation_required',
  );
  assert.equal(ambOpRow.mapped['compatibility_migration_record.state'], 'not yet in frozen migration manifest');
});

// ---------------------------------------------------------------------------
// 4. Fail-closed behavior.
// ---------------------------------------------------------------------------

test('fail-closed: unknown record field → COMPAT_MAPPING_UNKNOWN_FIELD', () => {
  const view = makeFixtureView();
  view.items[0].mystery_field = 'x';
  expectCompatError('COMPAT_MAPPING_UNKNOWN_FIELD', () => dryRunMigration({ view, coreTarget: {} }), /mystery_field/);
});

test('fail-closed: unknown enum state → COMPAT_MAPPING_INCOMPLETE', () => {
  const view = makeFixtureView();
  view.items[0].queue_item_state = 'half_published';
  expectCompatError('COMPAT_MAPPING_INCOMPLETE', () => assertNoUnknownEnum({ view }), /queue_item_state/);
  expectCompatError('COMPAT_MAPPING_INCOMPLETE', () => dryRunMigration({ view, coreTarget: {} }), /queue_item_state/);

  const badOutcome = makeFixtureView();
  badOutcome.receipts[0].outcome = 'maybe';
  expectCompatError('COMPAT_MAPPING_INCOMPLETE', () => assertNoUnknownEnum({ view: badOutcome }), /outcome/);

  // The good fixture passes enum validation.
  assert.equal(assertNoUnknownEnum({ view: makeFixtureView() }), true);
});

test('fail-closed: nulled FORBIDDEN_TO_DROP field → error', () => {
  const view = makeFixtureView();
  view.operations[0].operation_key = null; // FORBIDDEN_TO_DROP, conversion is not nullable
  expectCompatError('COMPAT_MAPPING_INCOMPLETE', () => dryRunMigration({ view, coreTarget: {} }), /FORBIDDEN_TO_DROP/);

  const view2 = makeFixtureView();
  view2.operations[0].source_event_digest = null;
  expectCompatError('COMPAT_MAPPING_INCOMPLETE', () => dryRunMigration({ view: view2, coreTarget: {} }), /FORBIDDEN_TO_DROP/);
});

test('fail-closed: attempt_count must equal DERIVABLE attempts-row count', () => {
  const view = makeFixtureView();
  view.operations[0].attempt_count = 5; // only 1 attempt row exists
  expectCompatError('COMPAT_MAPPING_INCOMPLETE', () => dryRunMigration({ view, coreTarget: {} }), /attempt_count/);
});

// ---------------------------------------------------------------------------
// 5. State mapping coverage: every compat state has a Core mapping; ambiguous
//    / reconciling / dispatching-without-receipt never map to plain
//    failed/succeeded/pending.
// ---------------------------------------------------------------------------

test('state mapping: every queue item state maps; ambiguous/reconciling are reconciliation-required', () => {
  for (const state of QUEUE_ITEM_STATES) {
    const result = mapItemStateToCore(state);
    assert.ok(result.core_import_result, `${state} must have a §9.5.4 mapping`);
    assert.ok(result.classification, `${state} must have a classification`);
  }
  for (const state of ['ambiguous', 'reconciling']) {
    const result = mapItemStateToCore(state);
    assert.equal(result.classification, 'reconciliation_required', `${state} classification`);
    assert.equal(result.reconciliation_required, true);
    assert.ok(!['failed', 'succeeded', 'pending'].includes(result.core_import_result));
  }
  // dispatching without a conclusive receipt → reconciliation-required, never ordinary pending.
  const noReceipt = mapItemStateToCore('dispatching');
  assert.equal(noReceipt.classification, 'reconciliation_required');
  assert.equal(noReceipt.core_import_result, '`projection_reconciliation.state=required`');
  // dispatching with conclusive receipts keeps effect truth.
  assert.equal(mapItemStateToCore('dispatching', { receipt_outcome: 'succeeded' }).classification, 'ledger_committed');
  assert.equal(mapItemStateToCore('dispatching', { receipt_outcome: 'failed' }).classification, 'typed_failed_attempt');
  // published + refresh pending/failed stays ledger committed (effect truth ≠ read availability).
  const refreshVariant = mapItemStateToCore('published', { refresh_state: 'failed' });
  assert.equal(refreshVariant.classification, 'ledger_committed');
  assert.match(refreshVariant.core_import_result, /refresh/);
  // Unknown states and historical aliases are rejected (constants keep canonical names only).
  expectCompatError('COMPAT_MAPPING_INCOMPLETE', () => mapItemStateToCore('bogus'));
  expectCompatError('COMPAT_MAPPING_INCOMPLETE', () => mapItemStateToCore('accepted'));
  expectCompatError('COMPAT_MAPPING_INCOMPLETE', () => mapItemStateToCore('ready'));
});

test('state mapping: attempt / lifecycle / refresh / migration tables cover all frozen enums', () => {
  assert.equal(STATE_MAPPING.item.length, 28);
  assert.equal(STATE_MAPPING.attempt.length, 7);
  assert.equal(STATE_MAPPING.source_lifecycle.length, 6);
  assert.equal(STATE_MAPPING.revision_refresh.length, 5);

  for (const state of ADAPTER_ATTEMPT_STATES) {
    assert.ok(mapAttemptStateToCore(state).core_state, `${state} attempt mapping`);
  }
  assert.equal(mapAttemptStateToCore('dispatching').reconciliation_required, true);
  assert.equal(mapAttemptStateToCore('dispatching').core_state, 'reconciliation_required');
  assert.equal(mapAttemptStateToCore('ambiguous').reconciliation_required, true);
  assert.equal(mapAttemptStateToCore('ambiguous').core_state, 'ambiguous');
  assert.match(mapAttemptStateToCore('ambiguous').cutover_rule, /不转换为 failed/);
  assert.equal(mapAttemptStateToCore('succeeded').core_state, 'succeeded');
  assert.equal(mapAttemptStateToCore('superseded-by-source-revision').core_state, 'superseded-by-source-revision');
  assert.equal(mapAttemptStateToCore('reconciling').reconciliation_required, true);
  expectCompatError('COMPAT_MAPPING_INCOMPLETE', () => mapAttemptStateToCore('bogus'));

  for (const state of SOURCE_LIFECYCLE_STATES) {
    assert.ok(mapSourceLifecycleToCore(state).core_state, `${state} lifecycle mapping`);
  }
  assert.equal(mapSourceLifecycleToCore('deleting').core_state, 'deleting/reconciliation_required');
  assert.equal(mapSourceLifecycleToCore('withdrawn').core_state, 'withdrawn/cancelled');
  expectCompatError('COMPAT_MAPPING_INCOMPLETE', () => mapSourceLifecycleToCore('bogus'));

  for (const state of REVISION_REFRESH_STATES) {
    assert.ok(mapRefreshStateToCore(state).core_state, `${state} refresh mapping`);
  }
  assert.equal(mapRefreshStateToCore('building').core_state, 'pending');
  assert.equal(mapRefreshStateToCore('failed').core_state, 'failed_retryable_by_refresh_policy');
  expectCompatError('COMPAT_MAPPING_INCOMPLETE', () => mapRefreshStateToCore('bogus'));

  for (const state of MIGRATION_STATES) {
    assert.ok(mapMigrationStateToCore(state).core_import_result, `${state} migration mapping`);
  }
  assert.equal(mapMigrationStateToCore('migrated').classification, 'migration_migrated');
  expectCompatError('COMPAT_MAPPING_INCOMPLETE', () => mapMigrationStateToCore('bogus'));
});

test('registry index: multi-row fields keep every contract row (table-distinguished)', () => {
  assert.equal(registryRowsForField('operation_key').length, 2); // §9.4.4 ledger + §9.5.1 outbox
  assert.equal(registryRowsForField('queue_item_state').length, 2);
  assert.equal(registryRowsForField('attempt_count').length, 1);
  assert.equal(registryRowsForField('unknown').length, 0);
});
