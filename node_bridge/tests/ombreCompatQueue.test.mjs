// Exhaustive unit tests for the Ombre O2 compatibility queue store.
// Contract: local_archive/docs/design/long_term_design/
//   hermes_ombre_stewarded_growth_compatibility_calibration_v0.2.md
// Primary clauses: §4.3 (ingress revisions), §5.5 (receipts), §6.3 (budget),
// §9.2 (operation key), §9.3.1–§9.3.9 (state machines, recovery, lifecycle,
// migration, negative tests), §10.3/§13.7 (fence), §13.6 (queue/restart/
// deletion acceptance). Fixture shapes mirror .tmp-scratch/ocq-smoke.mjs.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalDigest, isSha256Digest } from '../src/ombreCompat/canonical.mjs';
import {
  ADAPTER_ATTEMPT_STATES,
  MIGRATION_STATES,
  QUEUE_ITEM_STATES,
  REVISION_REFRESH_STATES,
  SOURCE_LIFECYCLE_STATES,
} from '../src/ombreCompat/constants.mjs';
import {
  computeOperationKey,
  createCompatQueueStore,
  deriveSourceEventId,
} from '../src/ombreCompat/queueStore.mjs';
import { validateFinalTurnSourceEvent } from '../src/ombreCompat/sourceEvent.mjs';
import {
  ATTEMPT_TRANSITIONS,
  EXPLICITLY_FORBIDDEN_TRANSITIONS,
  ITEM_TRANSITIONS,
  MIGRATION_TRANSITIONS,
  TERMINAL_ATTEMPT_STATES,
  TERMINAL_ITEM_STATES,
  TERMINAL_MIGRATION_STATES,
  assertAttemptTransition,
  assertItemTransition,
  assertMigrationTransition,
} from '../src/ombreCompat/stateMachine.mjs';

const ADAPTER_POLICY = canonicalDigest('adapter-policy-v1');
const FIXED_CLOCK = () => new Date('2026-01-15T12:00:00.000Z');

let sequence = 0;
function unique(label) {
  sequence += 1;
  return `${label}-${sequence}`;
}

// ------------------------------------------------------------ fixtures --

function tempRoot(t) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ocq-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function openStore(t, dir) {
  const store = createCompatQueueStore({
    dir,
    clock: FIXED_CLOCK,
    adapterPolicyDigest: ADAPTER_POLICY,
  });
  t.after(() => {
    try { store.close(); } catch {}
  });
  store.open();
  return store;
}

function bindingFor(exchangeId, overrides = {}) {
  return validateFinalTurnSourceEvent({
    schema_version: 'compatibility.final-turn/v1',
    event_id: deriveSourceEventId({ platform: 'wechat', conversation_id: 'conv1', exchange_id: exchangeId }),
    source_revision: 0,
    conversation_id: 'conv1',
    exchange_id: exchangeId,
    user_final_payload_ref: `global-timeline://turn/conv1/${exchangeId}/user`,
    user_final_payload_revision: 0,
    user_final_payload_digest: canonicalDigest('user text'),
    assistant_final_payload_ref: `global-timeline://turn/conv1/${exchangeId}/assistant`,
    assistant_final_payload_revision: 0,
    assistant_final_payload_digest: canonicalDigest('assistant text'),
    final_content_digest: canonicalDigest('user+assistant'),
    scope_envelope_ref: 'scope://conv1',
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
    emitted_at: '2026-01-15T11:59:00.000Z',
    ...overrides,
  });
}

function curatorInvocation() {
  return {
    curator_invocation_id: unique('cur'), curator_invocation_ref: unique('cur-ref'),
    curator_model_id: 'fake-model', curator_model_version: '0',
    curator_protocol_version: 'compat-curator/v1', curator_input_digest: canonicalDigest('in'),
    tool_inventory_digest: canonicalDigest([]),
  };
}

function reviewerInvocation() {
  return {
    reviewer_invocation_id: unique('rev'), reviewer_invocation_ref: unique('rev-ref'),
    reviewer_model_id: 'fake-model', reviewer_model_version: '0',
    reviewer_protocol_version: 'compat-reviewer/v1', reviewer_input_digest: canonicalDigest('rin'),
    tool_inventory_digest: canonicalDigest([]),
  };
}

function candidate(suffix, digest) {
  return {
    candidate_id: `cand-${suffix}`, candidate_kind: 'append_experience',
    candidate_payload_ref: `compat-payload:${suffix.repeat(64)}`,
    candidate_payload_digest: digest,
    candidate_source_refs: ['ref-a'], projection_target: 'ombre_local_projection',
    deletion_domain: 'compat_payload_default',
  };
}

function gateProvenance() {
  return {
    gate_policy_version: 'compat-gate/v1', gate_input_digest: canonicalDigest('gin'),
    gate_decision: 'authorized', gate_reason_code: 'ok', forbidden_class_result: 'none',
    budget_profile_version: 'compat-budget/v1', budget_result: 'within_budget',
    adapter_policy_digest: ADAPTER_POLICY,
  };
}

function expectCompatError(fn, code) {
  let error = null;
  try {
    fn();
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, `expected ${code} to be thrown`);
  assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
  return error;
}

// Drives an item through received -> curating -> reviewing -> gate_pending ->
// authorized; returns the authorized operations (gate output).
function driveToAuthorized(store, itemId, cand) {
  store.startCurator({ queue_item_id: itemId, invocation: curatorInvocation() });
  store.completeCurator({ queue_item_id: itemId, curator_output_digest: canonicalDigest('out'), candidates: [cand] });
  store.startReviewer({ queue_item_id: itemId, invocation: reviewerInvocation() });
  store.completeReviewer({
    queue_item_id: itemId, decision: 'accept', reviewer_revision: 0,
    reviewer_output_digest: canonicalDigest('rout'), final_candidates: [cand],
  });
  return store.applyGateDecision({
    queue_item_id: itemId,
    gate_provenance: gateProvenance(),
    decisions: [{ candidate: cand, decision: 'authorized' }],
    item_outcome: 'authorized',
  });
}

// Drives an item to an arbitrary pre-dispatch state.
function driveItemTo(store, itemId, cand, targetState) {
  if (targetState === 'received') return null;
  store.startCurator({ queue_item_id: itemId, invocation: curatorInvocation() });
  if (targetState === 'curating') return null;
  store.completeCurator({ queue_item_id: itemId, curator_output_digest: canonicalDigest('out'), candidates: [cand] });
  store.startReviewer({ queue_item_id: itemId, invocation: reviewerInvocation() });
  store.completeReviewer({
    queue_item_id: itemId, decision: 'accept', reviewer_revision: 0,
    reviewer_output_digest: canonicalDigest('rout'), final_candidates: [cand],
  });
  if (targetState === 'gate_pending') return null;
  return driveToAuthorizedFromGate(store, itemId, cand);
}

function driveToAuthorizedFromGate(store, itemId, cand) {
  return store.applyGateDecision({
    queue_item_id: itemId,
    gate_provenance: gateProvenance(),
    decisions: [{ candidate: cand, decision: 'authorized' }],
    item_outcome: 'authorized',
  });
}

// Full happy path up to a committed dispatch intent. Returns all handles.
function driveToDispatching(store, exchangeId) {
  const binding = bindingFor(exchangeId);
  const ingress = store.ingressSourceEvent(binding);
  const itemId = ingress.item_ids[0];
  const cand = candidate(exchangeId, canonicalDigest(`payload-${exchangeId}`));
  const ops = driveToAuthorized(store, itemId, cand);
  const operation = ops[0].operation;
  const attempt = store.createDispatchIntent({
    operation_id: operation.operation_id,
    method_identifier: 'append_experience',
    adapter_request_digest: canonicalDigest(`req-${exchangeId}`),
  });
  return { binding, itemId, cand, operation, attempt };
}

function makeReceipt(operation, attempt, overrides = {}) {
  const id = unique('rcpt');
  return {
    receipt_id: id,
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
    target_projection_ref: 'ombre://item/1',
    target_revision_before: 0,
    target_revision_after: 1,
    upstream_evidence_ref: 'up-ev-1',
    response_digest: canonicalDigest(`resp-${id}`),
    idempotency_disposition: 'new',
    error_code: null,
    receipt_adapter_id: operation.adapter_id,
    receipt_adapter_version: operation.adapter_version,
    receipt_upstream_version: operation.upstream_version,
    issued_at: '2026-01-15T12:00:01.000Z',
    issuer_id: 'steward-adapter',
    ambiguous_reason_code: null,
    ...overrides,
  };
}

function makeFailedReceipt(operation, attempt, overrides = {}) {
  return makeReceipt(operation, attempt, {
    outcome: 'failed',
    error_code: 'COMPAT_ADAPTER_UPSTREAM_UNAVAILABLE',
    target_projection_ref: null,
    target_revision_before: null,
    target_revision_after: null,
    upstream_evidence_ref: null,
    idempotency_disposition: 'none',
    ...overrides,
  });
}

// ------------------------------------------------------- §9.3.1 schema --

test('§9.3.1 正交状态字段枚举与合同冻结列表一致', () => {
  assert.deepEqual(QUEUE_ITEM_STATES, [
    'received', 'curating', 'reviewing', 'gate_pending', 'authorized',
    'dispatching', 'published', 'failed', 'ambiguous', 'reconciling',
    'rejected', 'superseded', 'withdrawn', 'suppressed', 'tombstoned',
    'deleting', 'deleted', 'fenced', 'voided',
  ]);
  assert.deepEqual(ADAPTER_ATTEMPT_STATES, [
    'not_started', 'dispatching', 'superseded-by-source-revision',
    'succeeded', 'failed', 'ambiguous', 'reconciling',
  ]);
  assert.deepEqual(SOURCE_LIFECYCLE_STATES, [
    'current', 'superseded', 'withdrawn', 'suppressed', 'deleting', 'deleted',
  ]);
  assert.deepEqual(MIGRATION_STATES, [
    'not_selected', 'migration_pending', 'migrating', 'migration_failed', 'migrated', 'migration_voided',
  ]);
  assert.deepEqual(REVISION_REFRESH_STATES, [
    'not_required', 'pending', 'building', 'published', 'failed',
  ]);
});

// ------------------------------------------- §9.3.3/4/8 structural -----

test('§9.3.3 ITEM_TRANSITIONS 结构:每个合同状态都有表项且 TERMINAL 状态无出边', () => {
  assert.deepEqual(
    Object.keys(ITEM_TRANSITIONS).sort(),
    [...QUEUE_ITEM_STATES].sort(),
    'every §9.3.1 queue item state must have a transition table entry',
  );
  // §9.3.3 Terminal column: TERM states are exactly these eight (failed is
  // COND, fenced is non-terminal for migration).
  assert.deepEqual([...TERMINAL_ITEM_STATES].sort(), [
    'deleted', 'published', 'rejected', 'superseded', 'suppressed', 'tombstoned', 'voided', 'withdrawn',
  ]);
  for (const state of TERMINAL_ITEM_STATES) {
    assert.equal(ITEM_TRANSITIONS[state].length, 0, `terminal state ${state} must have no outgoing edge`);
  }
  assert.deepEqual(Object.keys(ATTEMPT_TRANSITIONS).sort(), [...ADAPTER_ATTEMPT_STATES].sort());
  for (const state of TERMINAL_ATTEMPT_STATES) {
    assert.equal(ATTEMPT_TRANSITIONS[state].length, 0, `terminal attempt state ${state} must have no outgoing edge`);
  }
  assert.deepEqual(Object.keys(MIGRATION_TRANSITIONS).sort(), [...MIGRATION_STATES].sort());
  for (const state of TERMINAL_MIGRATION_STATES) {
    assert.equal(MIGRATION_TRANSITIONS[state].length, 0, `terminal migration state ${state} must have no outgoing edge`);
  }
});

test('§9.3.3/§9.3.4/§9.3.8 转移关系 default-deny 穷举(全状态交叉积)', () => {
  const PROBE_GUARDS = [
    undefined, 'curator_invocation', 'curator_result', 'reviewer_result',
    'gate_authorized', 'typed_reject', 'dispatch_intent_committed',
    'conclusive_succeeded_receipt', 'conclusive_failed_receipt',
    'outcome_unprovable', 'reconciliation', 'retryable_new_attempt',
    'lifecycle_predispatch', 'lifecycle_receipt', 'lifecycle_delete_intent',
    'cascade_conclusive', 'fence_revision', 'owner_void',
  ];
  const exhaustive = (table, states, assertFn) => {
    for (const from of states) {
      for (const to of states) {
        const edge = (table[from] || []).find((entry) => entry.to === to);
        if (edge) {
          assert.doesNotThrow(() => assertFn({ from, to, guard: edge.guard }), `${from}->${to} with its guard must be legal`);
          expectCompatError(
            () => assertFn({ from, to, guard: 'nonexistent_guard' }),
            'COMPAT_ILLEGAL_TRANSITION',
          );
        } else {
          for (const guard of PROBE_GUARDS) {
            expectCompatError(
              () => assertFn({ from, to, guard }),
              'COMPAT_ILLEGAL_TRANSITION',
            );
          }
        }
      }
    }
  };
  exhaustive(ITEM_TRANSITIONS, QUEUE_ITEM_STATES, assertItemTransition);
  exhaustive(ATTEMPT_TRANSITIONS, ADAPTER_ATTEMPT_STATES, assertAttemptTransition);
  exhaustive(MIGRATION_TRANSITIONS, MIGRATION_STATES, assertMigrationTransition);
});

test('§9.3.3/§9.3.4 具名非法转移逐一拒绝', () => {
  const guards = [undefined, 'gate_authorized', 'conclusive_succeeded_receipt', 'dispatch_intent_committed', 'lifecycle_predispatch'];
  const cases = [
    ['received', 'authorized'], // 禁止跳过 curator/reviewer/gate
    ['received', 'dispatching'],
    ['curating', 'dispatching'], // reviewing 行:禁止直接 dispatch
    ['gate_pending', 'published'],
    ['authorized', 'published'], // 禁止 published 无 receipt
    ['published', 'authorized'], // §9.3.7 明确禁止
    ['withdrawn', 'authorized'], // §9.3.7 明确禁止
    ['ambiguous', 'authorized'], // §9.3.7 明确禁止
  ];
  for (const [from, to] of cases) {
    for (const guard of guards) {
      expectCompatError(
        () => assertItemTransition({ from, to, guard }),
        'COMPAT_ILLEGAL_TRANSITION',
      );
    }
  }
  // rejected 是 TERM:到任何状态(含自身)都非法。
  for (const to of QUEUE_ITEM_STATES) {
    expectCompatError(
      () => assertItemTransition({ from: 'rejected', to, guard: 'owner_void' }),
      'COMPAT_ILLEGAL_TRANSITION',
    );
  }
  // §9.3.7:failed attempt 不得在同一 attempt 上重新 dispatch(retry 只能新建 attempt)。
  expectCompatError(
    () => assertAttemptTransition({ from: 'failed', to: 'dispatching', guard: 'retryable_new_attempt' }),
    'COMPAT_ILLEGAL_TRANSITION',
  );
  // §9.3.7:succeeded attempt 不得产生任何新 attempt 状态。
  for (const to of ADAPTER_ATTEMPT_STATES) {
    expectCompatError(
      () => assertAttemptTransition({ from: 'succeeded', to, guard: 'conclusive_succeeded_receipt' }),
      'COMPAT_ILLEGAL_TRANSITION',
    );
  }
});

test('§9.3.2/§9.3.3 store 级非法尝试:拒绝、原状态不变、留 compat.illegal-transition/v1 审计', (t) => {
  const root = tempRoot(t);
  const store = openStore(t, path.join(root, 'q'));
  const binding = bindingFor('ex-audit');
  const itemId = store.ingressSourceEvent(binding).item_ids[0];
  const cand = candidate('audit', canonicalDigest('payload-audit'));

  const auditCount = () => store.exportView().illegalTransitions.length;
  const lastAudit = () => store.exportView().illegalTransitions.at(-1);

  // received item: reviewer 不得启动。
  let before = auditCount();
  expectCompatError(
    () => store.startReviewer({ queue_item_id: itemId, invocation: reviewerInvocation() }),
    'COMPAT_ILLEGAL_TRANSITION',
  );
  assert.equal(auditCount(), before + 1);
  assert.equal(lastAudit().from, 'received');
  assert.equal(lastAudit().requested_to, 'reviewing');
  assert.equal(lastAudit().event_schema ?? 'compat.illegal-transition/v1', 'compat.illegal-transition/v1');
  assert.equal(store.getItem(itemId).queue_item_state, 'received');

  // received item: gate 不得评估(即 received→authorized 被拦截)。
  before = auditCount();
  expectCompatError(
    () => store.applyGateDecision({
      queue_item_id: itemId,
      gate_provenance: gateProvenance(),
      decisions: [{ candidate: cand, decision: 'authorized' }],
      item_outcome: 'authorized',
    }),
    'COMPAT_ILLEGAL_TRANSITION',
  );
  assert.equal(auditCount(), before + 1);
  assert.equal(lastAudit().from, 'received');
  assert.equal(lastAudit().owner, 'deterministic_gate');
  assert.equal(store.getItem(itemId).queue_item_state, 'received');

  // dispatching operation:重复 worker 不得二次调用(§9.3.3 dispatching 行)。
  const ops = driveToAuthorized(store, itemId, cand);
  const operation = ops[0].operation;
  store.createDispatchIntent({
    operation_id: operation.operation_id,
    method_identifier: 'append_experience',
    adapter_request_digest: canonicalDigest('req-audit'),
  });
  before = auditCount();
  expectCompatError(
    () => store.createDispatchIntent({
      operation_id: operation.operation_id,
      method_identifier: 'append_experience',
      adapter_request_digest: canonicalDigest('req-audit-2'),
    }),
    'COMPAT_ILLEGAL_TRANSITION',
  );
  assert.equal(auditCount(), before + 1);
  assert.equal(lastAudit().from, 'dispatching');
  assert.equal(lastAudit().requested_to, 'dispatching');
  assert.equal(lastAudit().operation_key, operation.operation_key);
  assert.equal(store.getOperation(operation.operation_id).state, 'dispatching');

  // rejected item:任何后续转移被拒(以 gate 评估为例),状态保持 rejected。
  const binding2 = bindingFor('ex-audit-rejected');
  const itemId2 = store.ingressSourceEvent(binding2).item_ids[0];
  store.startCurator({ queue_item_id: itemId2, invocation: curatorInvocation() });
  store.failCurator({ queue_item_id: itemId2, error_code: 'COMPAT_CURATOR_MALFORMED' });
  assert.equal(store.getItem(itemId2).queue_item_state, 'rejected');
  before = auditCount();
  expectCompatError(
    () => store.applyGateDecision({
      queue_item_id: itemId2,
      gate_provenance: gateProvenance(),
      decisions: [],
      item_outcome: 'rejected',
    }),
    'COMPAT_ILLEGAL_TRANSITION',
  );
  assert.equal(auditCount(), before + 1);
  assert.equal(store.getItem(itemId2).queue_item_state, 'rejected');
});

// ------------------------------------------------------------ ingress ---

test('§4.3/§9.3.3 ingress:新事件 → disposition=new 且 item 进入 received', (t) => {
  const root = tempRoot(t);
  const store = openStore(t, path.join(root, 'q'));
  const ingress = store.ingressSourceEvent(bindingFor('ex-new'));
  assert.equal(ingress.disposition, 'new');
  assert.equal(ingress.item_ids.length, 1);
  const item = store.getItem(ingress.item_ids[0]);
  assert.equal(item.queue_item_state, 'received');
  assert.equal(item.migration_state, 'not_selected');
  assert.equal(item.revision_refresh_state, 'not_required');
  assert.equal(item.source_lifecycle_state, 'current');
});

test('§4.3 ingress:完全相同事件 → exact_replay,不新增 item(§9.3.3 received 行)', (t) => {
  const root = tempRoot(t);
  const store = openStore(t, path.join(root, 'q'));
  const binding = bindingFor('ex-replay');
  const first = store.ingressSourceEvent(binding);
  const replay = store.ingressSourceEvent(binding);
  assert.equal(replay.disposition, 'exact_replay');
  assert.deepEqual(replay.item_ids, first.item_ids);
  assert.equal(store.listItems().length, 1);
  assert.equal(store.listEvents({ type: 'source_ingress' }).length, 1);
});

test('§4.3 ingress:同 event_id+revision 不同 digest → COMPAT_INGRESS_CONFLICT', (t) => {
  const root = tempRoot(t);
  const store = openStore(t, path.join(root, 'q'));
  const binding = bindingFor('ex-conflict');
  store.ingressSourceEvent(binding);
  const tampered = bindingFor('ex-conflict', {
    assistant_final_payload_digest: canonicalDigest('tampered assistant'),
  });
  expectCompatError(() => store.ingressSourceEvent(tampered), 'COMPAT_INGRESS_CONFLICT');
  assert.equal(store.listItems().length, 1);
});

test('§4.3 ingress:低于 current 的 revision → COMPAT_SOURCE_STALE', (t) => {
  const root = tempRoot(t);
  const store = openStore(t, path.join(root, 'q'));
  store.ingressSourceEvent(bindingFor('ex-stale'));
  store.ingressSourceEvent(bindingFor('ex-stale', {
    source_revision: 2,
    user_final_payload_digest: canonicalDigest('user text v2'),
    final_content_digest: canonicalDigest('user+assistant v2'),
  }));
  assert.equal(store.getSource(deriveSourceEventId({ platform: 'wechat', conversation_id: 'conv1', exchange_id: 'ex-stale' })).current_revision, 2);
  // revision 1 从未见过且低于 current=2。
  expectCompatError(
    () => store.ingressSourceEvent(bindingFor('ex-stale', { source_revision: 1 })),
    'COMPAT_SOURCE_STALE',
  );
});

test('§4.3 ingress:presentation-only 更高 revision(同 final_content_digest)→ presentation_revision 不新增 item', (t) => {
  const root = tempRoot(t);
  const store = openStore(t, path.join(root, 'q'));
  const eventId = deriveSourceEventId({ platform: 'wechat', conversation_id: 'conv1', exchange_id: 'ex-presentation' });
  const first = store.ingressSourceEvent(bindingFor('ex-presentation'));
  const presentation = store.ingressSourceEvent(bindingFor('ex-presentation', {
    source_revision: 1,
    presentation_state: 'presented',
    delivery_observation_ref: 'del://obs/1',
    delivery_observation_digest: canonicalDigest('obs-1'),
  }));
  assert.equal(presentation.disposition, 'presentation_revision');
  assert.equal(store.listItems().length, 1, 'presentation revision must not start a new journey');
  assert.ok(!presentation.item_ids.some((id) => id !== first.item_ids[0]), 'no new item id may appear');
  const source = store.getSource(eventId);
  assert.equal(source.current_revision, 1);
  assert.equal(source.revisions.length, 2);
});

test('§4.3 ingress:内容变化的更高 revision → 新 item', (t) => {
  const root = tempRoot(t);
  const store = openStore(t, path.join(root, 'q'));
  const first = store.ingressSourceEvent(bindingFor('ex-content'));
  const advanced = store.ingressSourceEvent(bindingFor('ex-content', {
    source_revision: 1,
    user_final_payload_digest: canonicalDigest('user text v2'),
    final_content_digest: canonicalDigest('user+assistant v2'),
  }));
  assert.equal(advanced.disposition, 'new');
  assert.notEqual(advanced.item_ids[0], first.item_ids[0]);
  assert.equal(store.listItems().length, 2);
});

// --------------------------------------- §9.3.5 dispatch intent first --

test('§9.3.5 dispatch-intent-before-effect:intent 先持久化,committed_seq 为日志 seq', (t) => {
  const root = tempRoot(t);
  const store = openStore(t, path.join(root, 'q'));
  const { itemId, operation, attempt } = driveToDispatching(store, 'ex-intent');
  assert.equal(attempt.adapter_attempt_state, 'dispatching');
  assert.equal(attempt.attempt_number, 1);
  assert.ok(isSha256Digest(attempt.dispatch_intent_digest));
  const intentEvents = store.listEvents({ type: 'dispatch_intent_committed' });
  assert.equal(intentEvents.length, 1);
  assert.equal(attempt.dispatch_intent_committed_seq, intentEvents[0].seq);
  const attemptEvents = store.listEvents({ type: 'attempt_created' });
  assert.ok(attemptEvents[0].seq < intentEvents[0].seq, 'attempt exists before the intent commits');
  assert.equal(store.listEvents({ type: 'receipt_recorded' }).length, 0, 'no effect evidence may precede intent');
  assert.equal(store.getOperation(operation.operation_id).state, 'dispatching');
  assert.equal(store.getItem(itemId).queue_item_state, 'dispatching');
});

test('§9.3.5 authorized 无 durable intent 崩溃重开:仍 authorized,不推断已调用 adapter', (t) => {
  const root = tempRoot(t);
  const dir = path.join(root, 'q');
  let operationId;
  {
    const store = openStore(t, dir);
    const binding = bindingFor('ex-no-intent');
    const itemId = store.ingressSourceEvent(binding).item_ids[0];
    const cand = candidate('no-intent', canonicalDigest('payload-no-intent'));
    const ops = driveToAuthorized(store, itemId, cand);
    operationId = ops[0].operation.operation_id;
    store.close();
  }
  const reopened = openStore(t, dir);
  const operation = reopened.getOperation(operationId);
  assert.equal(operation.state, 'authorized');
  assert.equal(operation.attempt_count, 0);
  assert.equal(reopened.listAttempts().length, 0, 'no intent => no attempt may be inferred');
  assert.equal(reopened.listEvents({ type: 'recovery_classification' }).length, 0);
  // worker 仍可按正常 CAS 创建 intent。
  const attempt = reopened.createDispatchIntent({
    operation_id: operationId,
    method_identifier: 'append_experience',
    adapter_request_digest: canonicalDigest('req-after-reopen'),
  });
  assert.equal(attempt.adapter_attempt_state, 'dispatching');
});

// --------------------------------------- §9.3.5 crash recovery table ---

test('§9.3.5/§9.3.9 intent 后无 receipt 崩溃重开 → ambiguous + last_error_code,adapter 调用数不增', (t) => {
  const root = tempRoot(t);
  const dir = path.join(root, 'q');
  let operationId; let attemptId; let seqBefore;
  {
    const store = openStore(t, dir);
    const { operation, attempt } = driveToDispatching(store, 'ex-crash-ambiguous');
    operationId = operation.operation_id;
    attemptId = attempt.attempt_id;
    seqBefore = store.logHead().seq;
    store.close();
  }
  const reopened = openStore(t, dir);
  const operation = reopened.getOperation(operationId);
  assert.equal(operation.state, 'ambiguous');
  assert.equal(operation.last_error_code, 'COMPAT_AMBIGUOUS_REQUIRES_RECONCILIATION');
  const attempt = reopened.getAttempt(attemptId);
  assert.equal(attempt.adapter_attempt_state, 'ambiguous');
  assert.equal(reopened.listAttempts().length, 1, 'recovery must not create attempts (adapter invocation count unchanged)');
  const item = reopened.listItems().find((entry) => entry.operation_ids.includes(operationId));
  assert.equal(item.queue_item_state, 'ambiguous');
  const recoveries = reopened.listEvents({ type: 'recovery_classification' });
  assert.equal(recoveries.length, 1);
  assert.equal(reopened.logHead().seq, seqBefore + 1, 'recovery appends exactly the classification event');
});

test('§9.3.5/§9.3.9 intent+succeeded receipt 已持久化:重开 published 且不重投,refresh=pending', (t) => {
  const root = tempRoot(t);
  const dir = path.join(root, 'q');
  let operationId; let attemptId; let itemId; let seqBefore;
  {
    const store = openStore(t, dir);
    const handles = driveToDispatching(store, 'ex-crash-published');
    operationId = handles.operation.operation_id;
    attemptId = handles.attempt.attempt_id;
    itemId = handles.itemId;
    store.recordReceipt({
      operation_id: operationId,
      receipt: makeReceipt(handles.operation, handles.attempt),
    });
    seqBefore = store.logHead().seq;
    store.close();
  }
  const reopened = openStore(t, dir);
  const operation = reopened.getOperation(operationId);
  assert.equal(operation.state, 'published');
  assert.equal(operation.attempt_count, 1, 'materialized view yields to durable receipt; no redispatch');
  assert.equal(reopened.getAttempt(attemptId).adapter_attempt_state, 'succeeded');
  const item = reopened.getItem(itemId);
  assert.equal(item.queue_item_state, 'published');
  assert.equal(item.revision_refresh_state, 'pending');
  assert.equal(reopened.listReceipts().length, 1);
  assert.equal(reopened.listEvents({ type: 'recovery_classification' }).length, 0);
  assert.equal(reopened.logHead().seq, seqBefore, 'reopen must not append or redispatch anything');
});

test('§9.3.5/§9.3.9 intent+failed receipt 已持久化:重开 failed,retryability 保留且不覆盖 attempt', (t) => {
  const root = tempRoot(t);
  const dir = path.join(root, 'q');
  let operationId; let attemptId; let itemId;
  {
    const store = openStore(t, dir);
    const handles = driveToDispatching(store, 'ex-crash-failed');
    operationId = handles.operation.operation_id;
    attemptId = handles.attempt.attempt_id;
    itemId = handles.itemId;
    store.recordReceipt({
      operation_id: operationId,
      receipt: makeFailedReceipt(handles.operation, handles.attempt),
    });
    store.close();
  }
  const reopened = openStore(t, dir);
  const operation = reopened.getOperation(operationId);
  assert.equal(operation.state, 'failed');
  assert.equal(operation.retryable, true, 'retryability must survive restart');
  assert.equal(operation.last_error_code, 'COMPAT_ADAPTER_UPSTREAM_UNAVAILABLE');
  assert.equal(reopened.getAttempt(attemptId).adapter_attempt_state, 'failed');
  assert.equal(reopened.getAttempt(attemptId).failed_at, '2026-01-15T12:00:01.000Z');
  assert.equal(reopened.getItem(itemId).queue_item_state, 'failed');
  assert.equal(reopened.listAttempts().length, 1);
  assert.equal(reopened.listReceipts().length, 1);
});

test('§9.3.9/§13.6 published refresh building 崩溃重开 → 回 pending,item 仍 published 不重投', (t) => {
  const root = tempRoot(t);
  const dir = path.join(root, 'q');
  let operationId; let itemId;
  {
    const store = openStore(t, dir);
    const handles = driveToDispatching(store, 'ex-refresh-crash');
    operationId = handles.operation.operation_id;
    itemId = handles.itemId;
    store.recordReceipt({
      operation_id: operationId,
      receipt: makeReceipt(handles.operation, handles.attempt),
    });
    store.setRefreshState({ queue_item_id: itemId, revision_refresh_state: 'building' });
    assert.equal(store.getItem(itemId).revision_refresh_state, 'building');
    store.close();
  }
  const reopened = openStore(t, dir);
  const item = reopened.getItem(itemId);
  assert.equal(item.queue_item_state, 'published', 'refresh crash must not regress effect truth');
  assert.equal(item.revision_refresh_state, 'pending', 'building lease never survives a restart');
  assert.equal(reopened.getOperation(operationId).state, 'published');
  assert.equal(reopened.listAttempts().length, 1, 'projection is not redispatched');
});

// ------------------------------------------------------------ receipts ---

test('§5.5/§9.5.2 receipt:succeeded 缺 target_projection_ref/upstream_evidence_ref → COMPAT_RECEIPT_INVALID', (t) => {
  const root = tempRoot(t);
  const store = openStore(t, path.join(root, 'q'));
  const { operation, attempt } = driveToDispatching(store, 'ex-receipt-missing');
  expectCompatError(
    () => store.recordReceipt({
      operation_id: operation.operation_id,
      receipt: makeReceipt(operation, attempt, { target_projection_ref: null }),
    }),
    'COMPAT_RECEIPT_INVALID',
  );
  expectCompatError(
    () => store.recordReceipt({
      operation_id: operation.operation_id,
      receipt: makeReceipt(operation, attempt, { upstream_evidence_ref: null }),
    }),
    'COMPAT_RECEIPT_INVALID',
  );
  assert.equal(store.getOperation(operation.operation_id).state, 'dispatching');
  assert.equal(store.listReceipts().length, 0);
});

test('§5.5 receipt:绑定字段任一不匹配 → COMPAT_RECEIPT_INVALID', (t) => {
  const root = tempRoot(t);
  const store = openStore(t, path.join(root, 'q'));
  const { operation, attempt } = driveToDispatching(store, 'ex-receipt-binding');
  const mismatches = [
    ['receipt_operation_key', canonicalDigest('wrong-key')],
    ['source_revision', operation.source_revision + 1],
    ['source_event_digest', canonicalDigest('wrong-source-digest')],
    ['adapter_version', '0.0.0-bogus'],
    ['upstream_version', 'bogus-upstream-version'],
    ['request_digest', canonicalDigest('wrong-request')],
  ];
  for (const [field, value] of mismatches) {
    const error = expectCompatError(
      () => store.recordReceipt({
        operation_id: operation.operation_id,
        receipt: makeReceipt(operation, attempt, { [field]: value }),
      }),
      'COMPAT_RECEIPT_INVALID',
    );
    assert.match(error.message, /receipt binding mismatch/);
    assert.equal(store.getOperation(operation.operation_id).state, 'dispatching', `${field} mismatch must leave state untouched`);
  }
  assert.equal(store.listReceipts().length, 0);
  // 正确绑定的 receipt 仍被接受。
  const ok = store.recordReceipt({ operation_id: operation.operation_id, receipt: makeReceipt(operation, attempt) });
  assert.equal(ok.disposition, 'new');
  assert.equal(store.getOperation(operation.operation_id).state, 'published');
});

test('§5.5 receipt:同 attempt 同内容 → exact_replay;不同内容 → 抛错', (t) => {
  const root = tempRoot(t);
  const store = openStore(t, path.join(root, 'q'));
  const { operation, attempt } = driveToDispatching(store, 'ex-receipt-replay');
  const receipt = makeReceipt(operation, attempt);
  const first = store.recordReceipt({ operation_id: operation.operation_id, receipt });
  assert.equal(first.disposition, 'new');
  const replay = store.recordReceipt({ operation_id: operation.operation_id, receipt: { ...receipt } });
  assert.equal(replay.disposition, 'exact_replay');
  assert.equal(store.listReceipts().length, 1);
  expectCompatError(
    () => store.recordReceipt({
      operation_id: operation.operation_id,
      receipt: makeReceipt(operation, attempt, {
        receipt_id: unique('rcpt-conflict'),
        response_digest: canonicalDigest('different-response'),
      }),
    }),
    'COMPAT_RECEIPT_INVALID',
  );
  assert.equal(store.listReceipts().length, 1);
  assert.equal(store.getOperation(operation.operation_id).state, 'published');
});

// --------------------------------------------------------------- retry ---

test('§9.3.4/§9.3.9 retry:retryable failed → 新 attempt(number+1、新 id),operation_key 不变,历史完整保留', (t) => {
  const root = tempRoot(t);
  const store = openStore(t, path.join(root, 'q'));
  const { itemId, operation, attempt } = driveToDispatching(store, 'ex-retry');
  store.recordReceipt({
    operation_id: operation.operation_id,
    receipt: makeFailedReceipt(operation, attempt),
  });
  const failed = store.getOperation(operation.operation_id);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.terminal_at, null, 'retryable failed is not terminal');

  const retry = store.createRetryDispatch({
    operation_id: operation.operation_id,
    method_identifier: 'append_experience',
    adapter_request_digest: canonicalDigest('req-retry-envelope'),
  });
  assert.equal(retry.attempt_number, 2);
  assert.notEqual(retry.attempt_id, attempt.attempt_id);
  assert.equal(retry.adapter_attempt_state, 'dispatching');
  const current = store.getOperation(operation.operation_id);
  assert.equal(current.state, 'dispatching');
  assert.equal(current.operation_key, operation.operation_key, 'same logical operation keeps the key forever');
  assert.equal(current.attempt_count, 2);
  assert.equal(current.candidate_payload_digest, operation.candidate_payload_digest, 'semantic payload digest must not change on retry');
  // request digest 可因 approved retry envelope 变化;其余绑定不变。
  assert.notEqual(retry.adapter_request_digest, attempt.adapter_request_digest);
  assert.notEqual(retry.dispatch_intent_digest, attempt.dispatch_intent_digest);
  assert.equal(retry.adapter_policy_digest, attempt.adapter_policy_digest);
  assert.equal(retry.upstream_version, attempt.upstream_version);
  // 旧 attempt 与旧 receipt 完整保留,不被覆盖。
  const oldAttempt = store.getAttempt(attempt.attempt_id);
  assert.equal(oldAttempt.adapter_attempt_state, 'failed');
  assert.equal(oldAttempt.failed_at, '2026-01-15T12:00:01.000Z');
  assert.equal(store.receiptsForAttempt(attempt.attempt_id).length, 1);
  assert.equal(store.listReceipts().length, 1);
  assert.equal(store.getItem(itemId).queue_item_state, 'dispatching');
});

test('§9.3.4/§9.3.9 ambiguous:retry 抛 COMPAT_RETRY_NOT_ALLOWED,重复 mutation 调度被拒', (t) => {
  const root = tempRoot(t);
  const dir = path.join(root, 'q');
  let operationId;
  {
    const store = openStore(t, dir);
    const { operation } = driveToDispatching(store, 'ex-ambiguous-retry');
    operationId = operation.operation_id;
    store.close();
  }
  const reopened = openStore(t, dir);
  assert.equal(reopened.getOperation(operationId).state, 'ambiguous');
  expectCompatError(
    () => reopened.createRetryDispatch({
      operation_id: operationId,
      method_identifier: 'append_experience',
      adapter_request_digest: canonicalDigest('req-ambiguous-retry'),
    }),
    'COMPAT_RETRY_NOT_ALLOWED',
  );
  // ambiguous 后重复调度:mutation dispatch 被拒且留审计(§9.3.9)。
  const before = reopened.exportView().illegalTransitions.length;
  expectCompatError(
    () => reopened.createDispatchIntent({
      operation_id: operationId,
      method_identifier: 'append_experience',
      adapter_request_digest: canonicalDigest('req-ambiguous-dispatch'),
    }),
    'COMPAT_ILLEGAL_TRANSITION',
  );
  assert.equal(reopened.exportView().illegalTransitions.length, before + 1);
  assert.equal(reopened.getOperation(operationId).state, 'ambiguous');
  assert.equal(reopened.listAttempts().length, 1, 'no new mutation attempt may be created from ambiguous');
});

test('§6.3 retry 预算:max_retryable_mutation_attempts_per_source_event=1,第二次 retry → COMPAT_BUDGET_EXCEEDED', (t) => {
  const root = tempRoot(t);
  const store = openStore(t, path.join(root, 'q'));
  assert.equal(store.budgetProfile.max_retryable_mutation_attempts_per_source_event, 1);
  const { operation, attempt } = driveToDispatching(store, 'ex-budget');
  store.recordReceipt({
    operation_id: operation.operation_id,
    receipt: makeFailedReceipt(operation, attempt),
  });
  const attempt2 = store.createRetryDispatch({
    operation_id: operation.operation_id,
    method_identifier: 'append_experience',
    adapter_request_digest: canonicalDigest('req-budget-retry'),
  });
  store.recordReceipt({
    operation_id: operation.operation_id,
    receipt: makeFailedReceipt(store.getOperation(operation.operation_id), attempt2),
  });
  assert.equal(store.getOperation(operation.operation_id).state, 'failed');
  expectCompatError(
    () => store.createRetryDispatch({
      operation_id: operation.operation_id,
      method_identifier: 'append_experience',
      adapter_request_digest: canonicalDigest('req-budget-retry-2'),
    }),
    'COMPAT_BUDGET_EXCEEDED',
  );
  assert.equal(store.listAttempts().length, 2, 'budget denial must not create an attempt');
});

test('§9.3.4/§9.3.9 non-retryable failed:不产生新 attempt,item 保持终态 failed', (t) => {
  const root = tempRoot(t);
  const store = openStore(t, path.join(root, 'q'));
  const { operation, attempt } = driveToDispatching(store, 'ex-nonretry-target');
  store.recordReceipt({
    operation_id: operation.operation_id,
    receipt: makeReceipt(operation, attempt),
  });
  // 以 retryable=false 的 lifecycle operation 制造 non-retryable failed。
  const lifecycle = store.createLifecycleItem({
    item_class: 'lifecycle',
    lifecycle_operation: 'suppress',
    target_operation_id: operation.operation_id,
    method_identifier: 'suppress_item',
    retryable: false,
  });
  const lifecycleOp = lifecycle.operation;
  const lifecycleAttempt = store.createDispatchIntent({
    operation_id: lifecycleOp.operation_id,
    method_identifier: 'suppress_item',
    adapter_request_digest: canonicalDigest('req-suppress'),
  });
  store.recordReceipt({
    operation_id: lifecycleOp.operation_id,
    receipt: makeFailedReceipt(lifecycleOp, lifecycleAttempt),
  });
  const failed = store.getOperation(lifecycleOp.operation_id);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.retryable, false);
  assert.ok(failed.terminal_at, 'non-retryable failed is terminal');
  expectCompatError(
    () => store.createRetryDispatch({
      operation_id: lifecycleOp.operation_id,
      method_identifier: 'suppress_item',
      adapter_request_digest: canonicalDigest('req-suppress-retry'),
    }),
    'COMPAT_RETRY_NOT_ALLOWED',
  );
  assert.equal(store.listAttempts().filter((entry) => entry.operation_id === lifecycleOp.operation_id).length, 1);
});

// ------------------------------------------------------ reconciliation ---

test('§9.3.3/§9.3.4 reconciliation:ambiguous → reconciling → succeeded receipt → published + refresh pending', (t) => {
  const root = tempRoot(t);
  const dir = path.join(root, 'q');
  let operationId; let attemptId; let itemId;
  {
    const store = openStore(t, dir);
    const handles = driveToDispatching(store, 'ex-reconcile-success');
    operationId = handles.operation.operation_id;
    attemptId = handles.attempt.attempt_id;
    itemId = handles.itemId;
    store.close();
  }
  const reopened = openStore(t, dir);
  assert.equal(reopened.getOperation(operationId).state, 'ambiguous');
  reopened.startReconciliation({
    operation_id: operationId,
    attempt_id: attemptId,
    reconciliation_operation_id: 'recon-op-1',
  });
  assert.equal(reopened.getOperation(operationId).state, 'reconciling');
  assert.equal(reopened.getAttempt(attemptId).adapter_attempt_state, 'reconciling');
  assert.equal(reopened.getItem(itemId).queue_item_state, 'reconciling');
  const operation = reopened.getOperation(operationId);
  const attempt = reopened.getAttempt(attemptId);
  const result = reopened.recordReceipt({
    operation_id: operationId,
    receipt: makeReceipt(operation, attempt),
  });
  assert.equal(result.disposition, 'new');
  assert.equal(reopened.getOperation(operationId).state, 'published');
  assert.equal(reopened.getAttempt(attemptId).adapter_attempt_state, 'succeeded');
  const item = reopened.getItem(itemId);
  assert.equal(item.queue_item_state, 'published');
  assert.equal(item.revision_refresh_state, 'pending');
});

test('§9.3.3 reconciliation:reconciling 中收到 ambiguous 观察 → 回 ambiguous', (t) => {
  const root = tempRoot(t);
  const dir = path.join(root, 'q');
  let operationId; let attemptId; let itemId;
  {
    const store = openStore(t, dir);
    const handles = driveToDispatching(store, 'ex-reconcile-ambiguous');
    operationId = handles.operation.operation_id;
    attemptId = handles.attempt.attempt_id;
    itemId = handles.itemId;
    store.close();
  }
  const reopened = openStore(t, dir);
  reopened.startReconciliation({
    operation_id: operationId,
    attempt_id: attemptId,
    reconciliation_operation_id: 'recon-op-2',
  });
  const operation = reopened.getOperation(operationId);
  const attempt = reopened.getAttempt(attemptId);
  reopened.recordReceipt({
    operation_id: operationId,
    receipt: makeReceipt(operation, attempt, {
      outcome: 'ambiguous',
      ambiguous_reason_code: 'transport_unknown',
      target_projection_ref: null,
      target_revision_before: null,
      target_revision_after: null,
      upstream_evidence_ref: null,
      idempotency_disposition: 'unknown',
    }),
  });
  assert.equal(reopened.getOperation(operationId).state, 'ambiguous');
  assert.equal(reopened.getAttempt(attemptId).adapter_attempt_state, 'ambiguous');
  assert.equal(reopened.getItem(itemId).queue_item_state, 'ambiguous');
  assert.equal(reopened.getOperation(operationId).last_error_code, 'COMPAT_AMBIGUOUS_REQUIRES_RECONCILIATION');
});

test('§9.3.3 reconciliation:非 ambiguous/reconciling 状态 startReconciliation → 抛错', (t) => {
  const root = tempRoot(t);
  const store = openStore(t, path.join(root, 'q'));
  const binding = bindingFor('ex-reconcile-denied');
  const itemId = store.ingressSourceEvent(binding).item_ids[0];
  const cand = candidate('reconcile-denied', canonicalDigest('payload-reconcile-denied'));
  const ops = driveToAuthorized(store, itemId, cand);
  const operation = ops[0].operation;
  expectCompatError(
    () => store.startReconciliation({
      operation_id: operation.operation_id,
      attempt_id: 'ocq_att_nonexistent',
      reconciliation_operation_id: 'recon-op-3',
    }),
    'COMPAT_AMBIGUOUS_REQUIRES_RECONCILIATION',
  );
  assert.equal(store.getOperation(operation.operation_id).state, 'authorized');
});

// ------------------------------------------------- §9.3.6 lifecycle -----

test('§9.3.6 lifecycle interrupt:withdraw/supersede 在 received/curating/gate_pending/authorized → 终态', async (t) => {
  const states = ['received', 'curating', 'gate_pending', 'authorized'];
  const kinds = [
    ['withdraw', 'withdrawn'],
    ['supersede', 'superseded'],
  ];
  for (const [kind, expected] of kinds) {
    for (const state of states) {
      await t.test(`${kind} at ${state} → item ${expected}`, (t2) => {
        const root = tempRoot(t2);
        const store = openStore(t2, path.join(root, 'q'));
        const exchange = unique(`ex-${kind}-${state}`);
        const binding = bindingFor(exchange);
        const itemId = store.ingressSourceEvent(binding).item_ids[0];
        const cand = candidate(exchange, canonicalDigest(`payload-${exchange}`));
        driveItemTo(store, itemId, cand, state);
        assert.equal(store.getItem(itemId).queue_item_state, state);
        const result = store.applySourceLifecycle({
          event_id: binding.event_id,
          kind,
          ref: `${kind}://ref/1`,
          revision: 1,
        });
        const item = store.getItem(itemId);
        assert.equal(item.queue_item_state, expected);
        assert.ok(item.terminal_at, `${expected} is a terminal business state`);
        assert.equal(item.source_lifecycle_state, expected);
        assert.ok(
          result.item_transitions.some((entry) => entry.queue_item_id === itemId && entry.to === expected),
        );
        if (state === 'authorized') {
          // 迟到 worker 拒绝:item 已终态,dispatch 尝试必须抛错。
          const ops = store.listOperations().filter((entry) => entry.queue_item_id === itemId);
          assert.equal(ops.length, 1);
          expectCompatError(
            () => store.createDispatchIntent({
              operation_id: ops[0].operation_id,
              method_identifier: 'append_experience',
              adapter_request_digest: canonicalDigest('req-late'),
            }),
            'COMPAT_SOURCE_NOT_CURRENT',
          );
          assert.equal(store.getItem(itemId).queue_item_state, expected);
        }
      });
    }
  }
});

test('§9.3.6/§13.6 source 进入 deleted 后 dispatch → COMPAT_DELETED/COMPAT_SOURCE_NOT_CURRENT', (t) => {
  const root = tempRoot(t);
  const store = openStore(t, path.join(root, 'q'));
  const binding = bindingFor('ex-deleted');
  const itemId = store.ingressSourceEvent(binding).item_ids[0];
  const cand = candidate('deleted', canonicalDigest('payload-deleted'));
  const ops = driveToAuthorized(store, itemId, cand);
  const operation = ops[0].operation;
  store.applySourceLifecycle({
    event_id: binding.event_id,
    kind: 'total_delete',
    ref: 'delete://ref/1',
    revision: 1,
  });
  assert.equal(store.getSource(binding.event_id).lifecycle_state, 'deleted');
  let error = null;
  try {
    store.createDispatchIntent({
      operation_id: operation.operation_id,
      method_identifier: 'append_experience',
      adapter_request_digest: canonicalDigest('req-after-delete'),
    });
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, 'dispatch after delete must throw');
  assert.ok(
    ['COMPAT_DELETED', 'COMPAT_SOURCE_NOT_CURRENT'].includes(error.code),
    `expected COMPAT_DELETED/COMPAT_SOURCE_NOT_CURRENT, got ${error.code}`,
  );
  assert.equal(store.listAttempts().length, 0);
});

test('§9.3.6 applySourceLifecycle 重复应用同 ref+revision → 幂等,不重复转移', (t) => {
  const root = tempRoot(t);
  const store = openStore(t, path.join(root, 'q'));
  const binding = bindingFor('ex-lifecycle-idem');
  const itemId = store.ingressSourceEvent(binding).item_ids[0];
  const args = { event_id: binding.event_id, kind: 'withdraw', ref: 'withdraw://ref/1', revision: 1 };
  const first = store.applySourceLifecycle(args);
  assert.equal(first.item_transitions.length, 1);
  const second = store.applySourceLifecycle(args);
  assert.deepEqual(second.item_transitions, [], 're-applying the same lifecycle event must not re-transition');
  assert.equal(store.getItem(itemId).queue_item_state, 'withdrawn');
  const transitions = store.listEvents({ type: 'source_lifecycle' })
    .flatMap((entry) => entry.item_transitions || [])
    .filter((entry) => entry.queue_item_id === itemId);
  assert.equal(transitions.length, 1, 'exactly one durable item transition exists');
});

test('§9.3.6/§13.6 total delete 覆盖 ambiguous in-flight item:先分类 effect,不得假装未发生', (t) => {
  const root = tempRoot(t);
  const dir = path.join(root, 'q');
  let itemId; let bindingEventId;
  {
    const store = openStore(t, dir);
    const handles = driveToDispatching(store, 'ex-delete-ambiguous');
    itemId = handles.itemId;
    bindingEventId = handles.binding.event_id;
    store.close();
  }
  const reopened = openStore(t, dir);
  assert.equal(reopened.getItem(itemId).queue_item_state, 'ambiguous');
  const result = reopened.applySourceLifecycle({
    event_id: bindingEventId,
    kind: 'total_delete',
    ref: 'delete://ref/2',
    revision: 2,
  });
  assert.ok(result.pending_classification.includes(itemId), 'in-flight effect must finish classification first');
  assert.deepEqual(result.item_transitions, []);
  assert.equal(reopened.getItem(itemId).queue_item_state, 'ambiguous', 'lifecycle event must not erase effect truth');
  assert.equal(reopened.getSource(bindingEventId).lifecycle_state, 'deleted');
});

// ---------------------------------------------------------------- fence ---

test('§10.3/§13.7 fence:非终态 item/operation → fenced;published 不受影响;ingress/dispatch 拒绝;幂等', (t) => {
  const root = tempRoot(t);
  const store = openStore(t, path.join(root, 'q'));
  // item A:published(终态)。
  const published = driveToDispatching(store, 'ex-fence-published');
  store.recordReceipt({
    operation_id: published.operation.operation_id,
    receipt: makeReceipt(published.operation, published.attempt),
  });
  // item B:authorized(非终态)。
  const bindingB = bindingFor('ex-fence-authorized');
  const itemB = store.ingressSourceEvent(bindingB).item_ids[0];
  const candB = candidate('fence-b', canonicalDigest('payload-fence-b'));
  const opsB = driveToAuthorized(store, itemB, candB);
  const operationB = opsB[0].operation;

  const fence = store.activateFence({
    fence_revision: 7,
    frozen_queue_cursor: 'qc://cursor/7',
    frozen_source_cursor: 'sc://cursor/7',
  });
  assert.equal(fence.fence_revision, 7);
  assert.equal(store.getItem(itemB).queue_item_state, 'fenced');
  assert.equal(store.getOperation(operationB.operation_id).state, 'fenced');
  assert.equal(store.getItem(published.itemId).queue_item_state, 'published', 'published effect truth is untouched by fence');
  assert.equal(store.getOperation(published.operation.operation_id).state, 'published');

  expectCompatError(
    () => store.ingressSourceEvent(bindingFor('ex-fence-late')),
    'COMPATIBILITY_WRITER_FENCED',
  );
  expectCompatError(
    () => store.createDispatchIntent({
      operation_id: operationB.operation_id,
      method_identifier: 'append_experience',
      adapter_request_digest: canonicalDigest('req-fenced'),
    }),
    'COMPATIBILITY_WRITER_FENCED',
  );
  // 幂等:重复 activateFence 不追加事件。
  const seqBefore = store.logHead().seq;
  const again = store.activateFence({ fence_revision: 8, frozen_queue_cursor: 'qc://8', frozen_source_cursor: 'sc://8' });
  assert.equal(again.fence_revision, 7, 'existing fence is returned, not replaced');
  assert.equal(store.logHead().seq, seqBefore);
});

// ------------------------------------------------------------ migration ---

test('§9.3.8 migration:not_selected→migration_pending→migrating→(failed→pending)→migrated 且不可逆', (t) => {
  const root = tempRoot(t);
  const store = openStore(t, path.join(root, 'q'));
  const itemId = store.ingressSourceEvent(bindingFor('ex-migration')).item_ids[0];
  assert.equal(store.getItem(itemId).migration_state, 'not_selected');
  store.transitionMigration({ queue_item_id: itemId, to: 'migration_pending', guard: 'frozen_cursor_selected' });
  assert.equal(store.getItem(itemId).migration_state, 'migration_pending');
  store.transitionMigration({ queue_item_id: itemId, to: 'migrating', guard: 'core_staging_transaction' });
  assert.equal(store.getItem(itemId).migration_state, 'migrating');
  // retryable failure path:migrating→migration_failed→migration_pending→migrating。
  store.transitionMigration({ queue_item_id: itemId, to: 'migration_failed', guard: 'typed_migration_failure' });
  store.transitionMigration({ queue_item_id: itemId, to: 'migration_pending', guard: 'migration_retry' });
  store.transitionMigration({ queue_item_id: itemId, to: 'migrating', guard: 'core_staging_transaction' });
  store.transitionMigration({ queue_item_id: itemId, to: 'migrated', guard: 'core_ownership_committed' });
  assert.equal(store.getItem(itemId).migration_state, 'migrated');
  // migrated 是终态:任何后继(含 retry)非法,状态不变。
  expectCompatError(
    () => store.transitionMigration({ queue_item_id: itemId, to: 'migration_pending', guard: 'migration_retry' }),
    'COMPAT_ILLEGAL_TRANSITION',
  );
  assert.equal(store.getItem(itemId).migration_state, 'migrated');
});

test('§9.3.8 migration:not_selected→migrated 非法,原状态不变', (t) => {
  const root = tempRoot(t);
  const store = openStore(t, path.join(root, 'q'));
  const itemId = store.ingressSourceEvent(bindingFor('ex-migration-illegal')).item_ids[0];
  expectCompatError(
    () => store.transitionMigration({ queue_item_id: itemId, to: 'migrated', guard: 'core_ownership_committed' }),
    'COMPAT_ILLEGAL_TRANSITION',
  );
  assert.equal(store.getItem(itemId).migration_state, 'not_selected');
});

// ----------------------------------------------------------------- void ---

test('§9.3.3 void:received item 无 effect → voided 终态', (t) => {
  const root = tempRoot(t);
  const store = openStore(t, path.join(root, 'q'));
  const itemId = store.ingressSourceEvent(bindingFor('ex-void-received')).item_ids[0];
  store.voidItem({ queue_item_id: itemId, disposal_record: { owner: 'owner-1', reason: 'test_void', ref: 'disposal://1' } });
  const item = store.getItem(itemId);
  assert.equal(item.queue_item_state, 'voided');
  assert.ok(item.terminal_at);
});

test('§9.3.3 void:rejected 是 TERM 且不在 voided predecessors 中 → COMPAT_ILLEGAL_TRANSITION', (t) => {
  const root = tempRoot(t);
  const store = openStore(t, path.join(root, 'q'));
  const itemId = store.ingressSourceEvent(bindingFor('ex-void-rejected')).item_ids[0];
  store.startCurator({ queue_item_id: itemId, invocation: curatorInvocation() });
  store.failCurator({ queue_item_id: itemId, error_code: 'COMPAT_CURATOR_MALFORMED' });
  assert.equal(store.getItem(itemId).queue_item_state, 'rejected');
  expectCompatError(
    () => store.voidItem({ queue_item_id: itemId, disposal_record: { owner: 'owner-1', reason: 'test_void' } }),
    'COMPAT_ILLEGAL_TRANSITION',
  );
  assert.equal(store.getItem(itemId).queue_item_state, 'rejected');
});

test('§9.3.3/§9.3.8 void:有 published/ambiguous effect → COMPAT_MIGRATION_CONFLICT', async (t) => {
  await t.test('published effect', (t2) => {
    const root = tempRoot(t2);
    const store = openStore(t2, path.join(root, 'q'));
    const { itemId, operation, attempt } = driveToDispatching(store, 'ex-void-published');
    store.recordReceipt({ operation_id: operation.operation_id, receipt: makeReceipt(operation, attempt) });
    expectCompatError(
      () => store.voidItem({ queue_item_id: itemId, disposal_record: { owner: 'owner-1', reason: 'test_void' } }),
      'COMPAT_MIGRATION_CONFLICT',
    );
    assert.equal(store.getItem(itemId).queue_item_state, 'published');
  });
  await t.test('ambiguous effect', (t2) => {
    const root = tempRoot(t2);
    const dir = path.join(root, 'q');
    let itemId;
    {
      const store = openStore(t2, dir);
      const handles = driveToDispatching(store, 'ex-void-ambiguous');
      itemId = handles.itemId;
      store.close();
    }
    const reopened = openStore(t2, dir);
    assert.equal(reopened.getItem(itemId).queue_item_state, 'ambiguous');
    expectCompatError(
      () => reopened.voidItem({ queue_item_id: itemId, disposal_record: { owner: 'owner-1', reason: 'test_void' } }),
      'COMPAT_MIGRATION_CONFLICT',
    );
    assert.equal(reopened.getItem(itemId).queue_item_state, 'ambiguous');
  });
});

test('§9.3.3 void:fenced item 无 effect → voided(migration void 路径)', (t) => {
  const root = tempRoot(t);
  const store = openStore(t, path.join(root, 'q'));
  const itemId = store.ingressSourceEvent(bindingFor('ex-void-fenced')).item_ids[0];
  store.activateFence({ fence_revision: 1, frozen_queue_cursor: 'qc://1', frozen_source_cursor: 'sc://1' });
  assert.equal(store.getItem(itemId).queue_item_state, 'fenced');
  store.voidItem({ queue_item_id: itemId, disposal_record: { owner: 'owner-1', reason: 'cutover_void', ref: 'disposal://2' } });
  const item = store.getItem(itemId);
  assert.equal(item.queue_item_state, 'voided');
  assert.ok(item.terminal_at);
});

// --------------------------------------------------- event log durability ---

test('§3.4/§13.6 事件日志:尾部撕写(torn write)重开自动截断且状态完整', (t) => {
  const root = tempRoot(t);
  const dir = path.join(root, 'q');
  const logPath = path.join(dir, 'queue-events.jsonl');
  let itemId; let seqBefore;
  {
    const store = openStore(t, dir);
    itemId = store.ingressSourceEvent(bindingFor('ex-torn')).item_ids[0];
    store.startCurator({ queue_item_id: itemId, invocation: curatorInvocation() });
    seqBefore = store.logHead().seq;
    store.close();
  }
  // 模拟崩溃撕写:半行 JSON,无换行。
  fs.appendFileSync(logPath, '{"schema_version":1,"seq":99,"type":"receipt_recorded"');
  const reopened = openStore(t, dir);
  const item = reopened.getItem(itemId);
  assert.equal(item.queue_item_state, 'curating', 'durable prefix survives torn tail truncation');
  assert.equal(reopened.logHead().seq, seqBefore);
  const text = fs.readFileSync(logPath, 'utf8');
  assert.ok(text.endsWith('}\n'), 'torn tail is truncated from the durable log');
  const lines = text.trimEnd().split('\n');
  assert.equal(lines.length, seqBefore);
  for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));
});

test('§3.4 事件日志:中间篡改一行 → COMPAT_STORE_CORRUPT 且 quarantine', (t) => {
  const root = tempRoot(t);
  const dir = path.join(root, 'q');
  const logPath = path.join(dir, 'queue-events.jsonl');
  let itemId;
  {
    const store = openStore(t, dir);
    itemId = store.ingressSourceEvent(bindingFor('ex-corrupt')).item_ids[0];
    store.startCurator({ queue_item_id: itemId, invocation: curatorInvocation() });
    store.completeCurator({ queue_item_id: itemId, curator_output_digest: canonicalDigest('out'), candidates: [] });
    store.close();
  }
  // 篡改中间一行(非尾部):任一字符变化都会破坏 hash chain。
  const lines = fs.readFileSync(logPath, 'utf8').trimEnd().split('\n');
  assert.ok(lines.length >= 3);
  const target = lines[1];
  const mid = Math.floor(target.length / 2);
  lines[1] = target.slice(0, mid) + (target[mid] === 'A' ? 'B' : 'A') + target.slice(mid + 1);
  fs.writeFileSync(logPath, `${lines.join('\n')}\n`);
  const store = createCompatQueueStore({ dir, clock: FIXED_CLOCK, adapterPolicyDigest: ADAPTER_POLICY });
  t.after(() => {
    try { store.close(); } catch {}
  });
  expectCompatError(() => store.open(), 'COMPAT_STORE_CORRUPT');
  assert.equal(fs.existsSync(logPath), false, 'corrupt log is moved out of the way');
  const quarantined = fs.readdirSync(dir).filter((name) => name.startsWith('queue-events.jsonl.corrupt-'));
  assert.equal(quarantined.length, 1, 'exactly one quarantined copy exists');
});

test('§3.4 store 双开同一目录:第二个实例 → COMPAT_STORE_BUSY', (t) => {
  const root = tempRoot(t);
  const dir = path.join(root, 'q');
  const first = openStore(t, dir);
  first.ingressSourceEvent(bindingFor('ex-busy'));
  const second = createCompatQueueStore({ dir, clock: FIXED_CLOCK, adapterPolicyDigest: ADAPTER_POLICY });
  t.after(() => {
    try { second.close(); } catch {}
  });
  expectCompatError(() => second.open(), 'COMPAT_STORE_BUSY');
});

// -------------------------------------------------------- operation key ---

test('§9.2 operation key:确定性;任一绑定字段变化 key 变化', () => {
  const material = {
    source_event_id: 'ocq_src_test',
    source_revision: 0,
    candidate_kind: 'append_experience',
    candidate_payload_digest: canonicalDigest('payload'),
    projection_target: 'ombre_local_projection',
    scope_envelope_digest: canonicalDigest('scope'),
    deletion_domain: 'compat_payload_default',
    adapter_policy_digest: ADAPTER_POLICY,
  };
  const key = computeOperationKey(material);
  assert.ok(isSha256Digest(key));
  assert.equal(computeOperationKey(material), key);
  assert.equal(computeOperationKey({ ...material }), key);
  for (const field of Object.keys(material)) {
    const varied = { ...material, [field]: field === 'source_revision' ? 1 : `${material[field]}-x` };
    assert.notEqual(computeOperationKey(varied), key, `changing ${field} must change the operation key`);
  }
});

// -------------------------------------------- §9.3.7 forbidden list -----

test('§9.3.7 EXPLICITLY_FORBIDDEN_TRANSITIONS 三条逐一直接调 assertItemTransition 拒绝', () => {
  assert.deepEqual(
    EXPLICITLY_FORBIDDEN_TRANSITIONS.map(({ from, to }) => `${from}->${to}`).sort(),
    ['ambiguous->authorized', 'published->authorized', 'withdrawn->authorized'],
  );
  for (const { from, to } of EXPLICITLY_FORBIDDEN_TRANSITIONS) {
    for (const guard of [undefined, 'gate_authorized', 'conclusive_succeeded_receipt', 'lifecycle_predispatch', 'retryable_new_attempt']) {
      expectCompatError(
        () => assertItemTransition({ from, to, guard }),
        'COMPAT_ILLEGAL_TRANSITION',
      );
    }
  }
});

// -------------------------------------------------------------- §13.6 ----

test('§13.6 tombstone 阻止迟到 dispatch(阻止复活)', (t) => {
  const root = tempRoot(t);
  const store = openStore(t, path.join(root, 'q'));
  const binding = bindingFor('ex-tombstone');
  const itemId = store.ingressSourceEvent(binding).item_ids[0];
  const cand = candidate('tombstone', canonicalDigest('payload-tombstone'));
  const ops = driveToAuthorized(store, itemId, cand);
  const operation = ops[0].operation;
  store.recordTombstone({
    target_ref: cand.candidate_payload_ref,
    tombstone_ref: 'tombstone://ref/1',
    tombstone_state: 'active',
    deletion_domain: 'compat_payload_default',
  });
  expectCompatError(
    () => store.createDispatchIntent({
      operation_id: operation.operation_id,
      method_identifier: 'append_experience',
      adapter_request_digest: canonicalDigest('req-tombstoned'),
    }),
    'COMPAT_TOMBSTONED',
  );
  assert.equal(store.getOperation(operation.operation_id).state, 'authorized');
  assert.equal(store.listAttempts().length, 0);
});
