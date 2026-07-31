// Ombre O2 Gate 5 sunset dry-run contract tests (§10, §9.5.6, §13.7).
// The sunset transaction is exercised end-to-end against a fixture Core sink:
// fence, frozen cursors, drain classification, operation-key preservation,
// ambiguous-as-reconciliation, zero-dual-write proof, migrated marker, and
// the §10.7 failure split. No Core writer is ever activated.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { canonicalDigest } from '../src/ombreCompat/canonical.mjs';
import { validateFinalTurnSourceEvent } from '../src/ombreCompat/sourceEvent.mjs';
import { createCompatQueueStore, deriveSourceEventId } from '../src/ombreCompat/queueStore.mjs';
import { adapterPolicyDigest } from '../src/ombreCompat/adapterPolicy.mjs';
import { createGate5Sunset } from '../src/ombreCompat/sunset.mjs';
import * as migrationMapping from '../src/ombreCompat/migrationMapping.mjs';

const FIXED_CLOCK = () => new Date('2026-07-27T00:00:00.000Z');
const ADAPTER_POLICY = adapterPolicyDigest();

function tempRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocq-sunset-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeBinding(exchange, overrides = {}) {
  return validateFinalTurnSourceEvent({
    schema_version: 'compatibility.final-turn/v1',
    event_id: deriveSourceEventId({ platform: 'wechat', conversation_id: 'conv1', exchange_id: exchange }),
    source_revision: 0,
    conversation_id: 'conv1',
    exchange_id: exchange,
    user_final_payload_ref: `global-timeline://turn/conv1/${exchange}/user`,
    user_final_payload_revision: 0,
    user_final_payload_digest: canonicalDigest(`user:${exchange}`),
    assistant_final_payload_ref: `global-timeline://turn/conv1/${exchange}/assistant`,
    assistant_final_payload_revision: 0,
    assistant_final_payload_digest: canonicalDigest(`assistant:${exchange}`),
    final_content_digest: canonicalDigest(`final:${exchange}`),
    scope_envelope_ref: 'scope://wechat/conv1',
    scope_envelope_digest: canonicalDigest('scope'),
    sensitivity: 'standard',
    presentation_state: 'not_presented',
    delivery_observation_ref: null,
    delivery_observation_digest: null,
    trusted_action_receipt_refs: [],
    trusted_action_receipts_digest: canonicalDigest([]),
    lifecycle_state: 'current',
    supersedes_event_id: null,
    withdrawal_ref: null,
    withdrawal_revision: null,
    supersession_ref: null,
    supersession_revision: null,
    deletion_ref: null,
    deletion_revision: null,
    source_gate_receipt_ref: 'gate-evidence://local/1',
    emitter_id: 'node-final-gate-compat-emitter',
    emitter_version: '1.0.0-local',
    emitted_at: '2026-07-26T23:59:59.000Z',
    ...overrides,
  });
}

function candidate(suffix) {
  return {
    candidate_id: `cand-${suffix}`,
    candidate_kind: 'append_experience',
    candidate_payload_ref: `compat-payload:${suffix.padEnd(64, '0').slice(0, 64)}`,
    candidate_payload_digest: canonicalDigest(`payload:${suffix}`),
    candidate_source_refs: [],
    projection_target: 'ombre_local_projection',
    deletion_domain: 'compat_payload_default',
  };
}

function driveToAuthorized(store, itemId, cand) {
  store.startCurator({
    queue_item_id: itemId,
    invocation: {
      curator_invocation_id: `cur-${itemId}`,
      curator_invocation_ref: 'ref',
      curator_model_id: 'm',
      curator_model_version: 'm',
      curator_protocol_version: 'compat-curator/v1',
      curator_input_digest: canonicalDigest('in'),
      tool_inventory_digest: canonicalDigest([]),
    },
  });
  store.completeCurator({ queue_item_id: itemId, curator_output_digest: canonicalDigest('out'), candidates: [cand] });
  store.startReviewer({
    queue_item_id: itemId,
    invocation: {
      reviewer_invocation_id: `rev-${itemId}`,
      reviewer_invocation_ref: 'ref',
      reviewer_model_id: 'm',
      reviewer_model_version: 'm',
      reviewer_protocol_version: 'compat-reviewer/v1',
      reviewer_input_digest: canonicalDigest('rin'),
      tool_inventory_digest: canonicalDigest([]),
    },
  });
  store.completeReviewer({
    queue_item_id: itemId,
    decision: 'accept',
    reviewer_revision: 0,
    reviewer_output_digest: canonicalDigest('rout'),
    final_candidates: [cand],
  });
  return store.applyGateDecision({
    queue_item_id: itemId,
    gate_provenance: {
      gate_policy_version: 'compat-gate/v1',
      gate_input_digest: canonicalDigest('gin'),
      gate_decision: 'authorized',
      gate_reason_code: 'ok',
      forbidden_class_result: 'none',
      budget_profile_version: 'compat-budget/v1',
      budget_result: 'within_budget',
      adapter_policy_digest: ADAPTER_POLICY,
    },
    decisions: [{ candidate: cand, decision: 'authorized' }],
    item_outcome: 'authorized',
  });
}

function successReceipt(operation, attempt, overrides = {}) {
  return {
    receipt_id: `rcpt-${operation.operation_id}`,
    receipt_operation_key: operation.operation_key,
    receipt_attempt_id: attempt.attempt_id,
    outcome: 'succeeded',
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
    target_projection_ref: `ombre:experience:${operation.operation_id}`,
    target_revision_before: 0,
    target_revision_after: 1,
    upstream_evidence_ref: 'ev-1',
    response_digest: canonicalDigest('resp'),
    idempotency_disposition: 'new',
    receipt_adapter_id: operation.adapter_id,
    receipt_adapter_version: operation.adapter_version,
    receipt_upstream_version: operation.upstream_version,
    issued_at: '2026-07-27T00:00:01.000Z',
    issuer_id: 'steward-adapter',
    ambiguous_reason_code: null,
    ...overrides,
  };
}

// Builds a fixture queue holding: published, failed(retryable), ambiguous,
// authorized (no intent), rejected, withdrawn items.
function buildFixture(t) {
  const root = tempRoot(t);
  const store = createCompatQueueStore({
    dir: path.join(root, 'queue'),
    clock: FIXED_CLOCK,
    adapterPolicyDigest: ADAPTER_POLICY,
  });
  store.open();
  t.after(() => { try { store.close(); } catch {} });

  // published
  const publishedItem = store.ingressSourceEvent(makeBinding('ex-published')).item_ids[0];
  const publishedOp = driveToAuthorized(store, publishedItem, candidate('pub'))[0].operation;
  const publishedAttempt = store.createDispatchIntent({
    operation_id: publishedOp.operation_id,
    method_identifier: 'append_experience',
    adapter_request_digest: canonicalDigest('req-pub'),
  });
  store.recordReceipt({
    operation_id: publishedOp.operation_id,
    receipt: successReceipt(publishedOp, publishedAttempt),
  });

  // failed (retryable)
  const failedItem = store.ingressSourceEvent(makeBinding('ex-failed')).item_ids[0];
  const failedOp = driveToAuthorized(store, failedItem, candidate('fail'))[0].operation;
  const failedAttempt = store.createDispatchIntent({
    operation_id: failedOp.operation_id,
    method_identifier: 'append_experience',
    adapter_request_digest: canonicalDigest('req-fail'),
  });
  store.recordReceipt({
    operation_id: failedOp.operation_id,
    receipt: successReceipt(failedOp, failedAttempt, {
      receipt_id: 'rcpt-failed-1',
      outcome: 'failed',
      target_projection_ref: null,
      target_revision_before: null,
      target_revision_after: null,
      upstream_evidence_ref: null,
      error_code: 'upstream_unavailable',
    }),
  });

  // ambiguous
  const ambiguousItem = store.ingressSourceEvent(makeBinding('ex-ambiguous')).item_ids[0];
  const ambiguousOp = driveToAuthorized(store, ambiguousItem, candidate('amb'))[0].operation;
  const ambiguousAttempt = store.createDispatchIntent({
    operation_id: ambiguousOp.operation_id,
    method_identifier: 'append_experience',
    adapter_request_digest: canonicalDigest('req-amb'),
  });
  store.recordReceipt({
    operation_id: ambiguousOp.operation_id,
    receipt: successReceipt(ambiguousOp, ambiguousAttempt, {
      receipt_id: 'rcpt-ambiguous-1',
      outcome: 'ambiguous',
      target_projection_ref: null,
      target_revision_before: null,
      target_revision_after: null,
      upstream_evidence_ref: null,
      ambiguous_reason_code: 'timeout',
    }),
  });

  // authorized, never dispatched
  const authorizedItem = store.ingressSourceEvent(makeBinding('ex-authorized')).item_ids[0];
  const authorizedOp = driveToAuthorized(store, authorizedItem, candidate('auth'))[0].operation;

  // rejected (curator failure after the invocation started)
  const rejectedItem = store.ingressSourceEvent(makeBinding('ex-rejected')).item_ids[0];
  store.startCurator({
    queue_item_id: rejectedItem,
    invocation: {
      curator_invocation_id: `cur-${rejectedItem}`,
      curator_invocation_ref: 'ref',
      curator_model_id: 'm',
      curator_model_version: 'm',
      curator_protocol_version: 'compat-curator/v1',
      curator_input_digest: canonicalDigest('in'),
      tool_inventory_digest: canonicalDigest([]),
    },
  });
  store.failCurator({ queue_item_id: rejectedItem, error_code: 'COMPAT_CURATOR_UNAVAILABLE' });

  // withdrawn
  const withdrawnItem = store.ingressSourceEvent(makeBinding('ex-withdrawn')).item_ids[0];
  store.applySourceLifecycle({
    event_id: deriveSourceEventId({ platform: 'wechat', conversation_id: 'conv1', exchange_id: 'ex-withdrawn' }),
    kind: 'withdraw',
    ref: 'withdrawal://1',
    revision: 1,
  });

  return { root, store, keys: { publishedOp, failedOp, ambiguousOp, authorizedOp } };
}

test('§10.2/§13.7 sunset dry-run: fence, drain, key preservation, validation, marker', (t) => {
  const { store, keys } = buildFixture(t);
  const sunset = createGate5Sunset({ store, mapping: migrationMapping, clock: FIXED_CLOCK });
  const coreSink = { ledger: [], outbox: [], receipts: [], reconciliation: [], lifecycle: [], activated: false, write_count: 0 };
  const result = sunset.runSunsetDryRun({ cutover_id: 'cutover-fixture-1', coreSink });

  // Fence active and durable.
  assert.ok(store.fence, 'fence persisted');
  assert.equal(result.fence.frozen_queue_cursor, store.fence.frozen_queue_cursor);

  // Drain classification per §10.4 (items are fenced by classification time,
  // so match by the operations' owning items).
  const classes = Object.fromEntries(result.plan.map((entry) => [entry.queue_item_id, entry.classification]));
  const items = store.listItems();
  const byClass = (state) => items.find((item) => item.queue_item_state === state);
  assert.equal(classes[keys.publishedOp.queue_item_id], 'migrate_committed');
  assert.equal(classes[keys.failedOp.queue_item_id], 'migrate_failed_attempt');
  assert.equal(classes[keys.ambiguousOp.queue_item_id], 'reconciliation_required');
  assert.equal(classes[keys.authorizedOp.queue_item_id], 'migrate_outbox');
  assert.equal(classes[byClass('rejected').queue_item_id], 'audit_or_void');
  assert.equal(classes[byClass('withdrawn').queue_item_id], 'migrate_lifecycle');

  // Operation keys preserved verbatim in the Core sink (§10.2 step 8).
  const outboxKeys = coreSink.outbox.map((row) => row.operation_key);
  assert.ok(outboxKeys.includes(keys.failedOp.operation_key));
  assert.ok(outboxKeys.includes(keys.ambiguousOp.operation_key) === false, 'ambiguous never re-queued for dispatch');
  assert.ok(coreSink.reconciliation.some((row) => row.operation_keys.includes(keys.ambiguousOp.operation_key)));
  assert.ok(coreSink.ledger.some((row) => row.operation_keys.includes(keys.publishedOp.operation_key)));
  assert.ok(coreSink.receipts.some((receipt) => receipt.receipt_operation_key === keys.publishedOp.operation_key));

  // Validation + zero-dual-write proof.
  assert.equal(result.validation.passed, true, JSON.stringify(result.validation));
  assert.equal(result.validation.mutation_invocation_count, 0);
  assert.equal(result.validation.compat_dispatch_after_fence, 0);
  assert.equal(result.zero_dual_write_proof.proven, true);

  // Migrated marker carries every §10.6 field.
  for (const field of [
    'schema_version', 'cutover_id', 'compatibility_queue_id', 'frozen_source_cursor',
    'frozen_queue_cursor', 'migrated_count', 'voided_count', 'ambiguous_count',
    'operation_key_set_digest', 'receipt_set_digest', 'core_ledger_cursor',
    'core_outbox_cursor', 'compatibility_fence_revision', 'core_activation_revision',
    'zero_dual_write_evidence_ref', 'completed_at',
  ]) {
    assert.ok(result.marker[field] !== undefined && result.marker[field] !== null, `marker missing ${field}`);
  }
  assert.ok(result.retired_marker.retired);

  // Migration states are terminal per §9.3.8.
  for (const item of store.listItems()) {
    assert.ok(['migrated', 'migration_voided'].includes(item.migration_state),
      `item ${item.queue_item_id} migration_state=${item.migration_state}`);
  }
  // Migrated is irreversible.
  const migrated = store.listItems().find((item) => item.migration_state === 'migrated');
  assert.throws(
    () => store.transitionMigration({ queue_item_id: migrated.queue_item_id, to: 'migration_pending', guard: 'migration_retry' }),
    (error) => error.code === 'COMPAT_ILLEGAL_TRANSITION',
  );

  // Post-fence ingress and dispatch are refused (§10.3).
  assert.throws(
    () => store.ingressSourceEvent(makeBinding('ex-after-fence')),
    (error) => error.code === 'COMPATIBILITY_WRITER_FENCED',
  );
  assert.throws(
    () => store.createDispatchIntent({
      operation_id: keys.failedOp.operation_id,
      method_identifier: 'append_experience',
      adapter_request_digest: canonicalDigest('req-late'),
    }),
    (error) => ['COMPATIBILITY_WRITER_FENCED', 'COMPAT_ILLEGAL_TRANSITION'].includes(error.code),
  );
});

test('§10.5/#25 zero-dual-write proof fails closed when a post-fence dispatch exists', (t) => {
  const { store } = buildFixture(t);
  const sunset = createGate5Sunset({ store, mapping: migrationMapping, clock: FIXED_CLOCK });
  const coreSink = { ledger: [], outbox: [], receipts: [], reconciliation: [], lifecycle: [] };
  const realScanner = store.listEvents;
  const result = sunset.runSunsetDryRun({
    cutover_id: 'cutover-fixture-2',
    coreSink,
    listEventsImpl: (query) => {
      const real = realScanner(query);
      if (query.type !== 'dispatch_intent_committed') return real;
      // Simulate a compatibility dispatch leaking into the fenced window.
      return [...real, { seq: 9999, type: 'dispatch_intent_committed', operation_id: 'fake' }];
    },
  });
  assert.equal(result.validation.compat_dispatch_after_fence, 1);
  assert.equal(result.validation.passed, false);
  assert.equal(result.zero_dual_write_proof.proven, false);
});

test('§10.3 fence is durable across restart; retired writer stays retired', (t) => {
  const { root, store } = buildFixture(t);
  const sunset = createGate5Sunset({ store, mapping: migrationMapping, clock: FIXED_CLOCK });
  sunset.runSunsetDryRun({
    cutover_id: 'cutover-fixture-3',
    coreSink: { ledger: [], outbox: [], receipts: [], reconciliation: [], lifecycle: [] },
  });
  store.close();

  const reopened = createCompatQueueStore({
    dir: path.join(root, 'queue'),
    clock: FIXED_CLOCK,
    adapterPolicyDigest: ADAPTER_POLICY,
  });
  reopened.open();
  t.after(() => { try { reopened.close(); } catch {} });
  assert.ok(reopened.fence, 'fence survives restart');
  assert.throws(
    () => reopened.ingressSourceEvent(makeBinding('ex-after-restart')),
    (error) => error.code === 'COMPATIBILITY_WRITER_FENCED',
  );
  const item = reopened.listItems().find((candidateItem) => candidateItem.migration_state === 'migrated');
  assert.ok(item, 'migration states survive restart');
});

test('§10.7 cutover failure split: zero Core writes resumable; after first Core write never', (t) => {
  const { store } = buildFixture(t);
  const sunset = createGate5Sunset({ store, mapping: migrationMapping, clock: FIXED_CLOCK });
  const before = sunset.evaluateCutoverFailure({ coreWriteCount: 0 });
  assert.equal(before.compat_resumable, true);
  assert.equal(before.fence_retained, true);
  const after = sunset.evaluateCutoverFailure({ coreWriteCount: 1 });
  assert.equal(after.compat_resumable, false);
  assert.equal(after.fence_retained, true);
});
