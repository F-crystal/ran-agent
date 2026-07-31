// Unit tests for the deterministic publication gate (§5.3, §6, §13.3).
// All fixtures are plain typed records — no live queue store is involved;
// storeView is a plain-object snapshot by contract.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { deepFreezeClone, sha256Digest } from '../src/ombreCompat/canonical.mjs';
import {
  BUDGET_PROFILE_V1,
  COMPAT_CURATOR_PROTOCOL_VERSION,
  COMPAT_GATE_POLICY_VERSION,
  COMPAT_REVIEWER_PROTOCOL_VERSION,
  COMPAT_UPSTREAM_VERSION,
} from '../src/ombreCompat/constants.mjs';
import {
  evaluatePublicationGate,
  GATE_DEFERRED_RETRY_DELAY_MS,
} from '../src/ombreCompat/gate.mjs';

const POLICY_DIGEST = sha256Digest('adapter-policy/v1');
const FIXED_NOW = new Date('2026-02-03T04:05:06.000Z');
const fixedClock = () => new Date(FIXED_NOW.getTime());

function makeSource(overrides = {}) {
  return {
    event_id: 'evt_1',
    source_revision: 1,
    source_event_digest: sha256Digest('source-event/1'),
    final_content_digest: sha256Digest('final-content/1'),
    scope_envelope_digest: sha256Digest('scope/1'),
    sensitivity: 'personal',
    lifecycle_state: 'current',
    ...overrides,
  };
}

function makeBinding(overrides = {}) {
  const source = makeSource();
  return {
    event_id: source.event_id,
    source_revision: source.source_revision,
    source_event_digest: source.source_event_digest,
    final_content_digest: source.final_content_digest,
    scope_envelope_digest: source.scope_envelope_digest,
    sensitivity: source.sensitivity,
    lifecycle_state: 'current',
    trusted_action_receipt_refs: ['rcpt_trusted_1'],
    ...overrides,
  };
}

function makeCurator(overrides = {}) {
  return {
    curator_invocation_id: 'cur_inv_1',
    curator_invocation_ref: 'cur_ref_1',
    curator_model_id: 'curator-model',
    curator_model_version: '1.0.0',
    curator_protocol_version: COMPAT_CURATOR_PROTOCOL_VERSION,
    curator_input_digest: sha256Digest('curator-input'),
    curator_output_digest: sha256Digest('curator-output'),
    ...overrides,
  };
}

function makeReviewer(overrides = {}) {
  return {
    reviewer_invocation_id: 'rev_inv_1',
    reviewer_invocation_ref: 'rev_ref_1',
    reviewer_model_id: 'reviewer-model',
    reviewer_model_version: '1.0.0',
    reviewer_protocol_version: COMPAT_REVIEWER_PROTOCOL_VERSION,
    reviewer_input_digest: sha256Digest('reviewer-input'),
    reviewer_decision: 'accept',
    reviewer_revision: 0,
    reviewer_output_digest: sha256Digest('reviewer-output'),
    ...overrides,
  };
}

function makeItem(overrides = {}) {
  const source = makeSource();
  return {
    queue_item_id: 'ocq_item_1',
    item_class: 'growth',
    source_event_id: source.event_id,
    source_revision: source.source_revision,
    source_event_digest: source.source_event_digest,
    curator: makeCurator(),
    reviewer: makeReviewer(),
    ...overrides,
  };
}

let candidateSeq = 0;
function makeCandidate(overrides = {}) {
  candidateSeq += 1;
  const digest = sha256Digest(`payload/${candidateSeq}`);
  return {
    candidate_id: `cand_${candidateSeq}`,
    candidate_kind: 'append_experience',
    candidate_payload_ref: `ocq_payload_${candidateSeq}`,
    candidate_payload_digest: digest,
    curator_candidate_payload_digest: digest,
    projection_target: 'ombre_local_projection',
    deletion_domain: 'compat_payload_default',
    scope_envelope_digest: makeBinding().scope_envelope_digest,
    sensitivity: 'personal',
    payload_bytes: 128,
    source_refs: ['ref_1'],
    claim_manifest: [{ claim_kind: 'experience', forbidden_classes: [], receipt_refs: [] }],
    ...overrides,
  };
}

function makeStoreView(overrides = {}) {
  const source = makeSource();
  return {
    fence: null,
    adapter_policy_digest: POLICY_DIGEST,
    current_revision_binding: {
      source_revision: source.source_revision,
      source_event_digest: source.source_event_digest,
      final_content_digest: source.final_content_digest,
      lifecycle_state: 'current',
    },
    tombstone: null,
    prior_authorized_count: 0,
    prior_authorized_i_observation_count: 0,
    ...overrides,
  };
}

function makeArgs(overrides = {}) {
  return {
    item: makeItem(),
    candidates: [makeCandidate()],
    source: makeSource(),
    binding: makeBinding(),
    storeView: makeStoreView(),
    budgetProfile: BUDGET_PROFILE_V1,
    adapterPolicyDigest: POLICY_DIGEST,
    upstreamVersion: COMPAT_UPSTREAM_VERSION,
    gatePolicyVersion: COMPAT_GATE_POLICY_VERSION,
    clock: fixedClock,
    ...overrides,
  };
}

test('authorizes a well-formed candidate and emits full gate provenance', () => {
  const result = evaluatePublicationGate(makeArgs());
  assert.equal(result.item_outcome, 'authorized');
  assert.equal(result.next_attempt_at, null);
  assert.equal(result.decisions.length, 1);
  assert.equal(result.decisions[0].decision, 'authorized');
  assert.equal(result.decisions[0].reason_code, 'ok');

  // queueStore.buildOperation consumes exactly these candidate fields.
  assert.deepEqual(
    Object.keys(result.decisions[0].candidate).sort(),
    [
      'candidate_id',
      'candidate_kind',
      'candidate_payload_digest',
      'candidate_payload_ref',
      'deletion_domain',
      'projection_target',
      'supersedes_operation_id',
    ],
  );

  const provenance = result.gate_provenance;
  assert.equal(provenance.gate_policy_version, COMPAT_GATE_POLICY_VERSION);
  assert.match(provenance.gate_input_digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(provenance.gate_decision, 'authorized');
  assert.equal(provenance.gate_reason_code, 'ok');
  assert.equal(provenance.forbidden_class_result, 'none');
  assert.equal(provenance.budget_profile_version, BUDGET_PROFILE_V1.version);
  assert.equal(provenance.budget_result, 'within_budget');
  assert.equal(provenance.adapter_policy_digest, POLICY_DIGEST);
});

test('rejects candidate kinds outside the model allowlist', () => {
  for (const kind of ['bounded_retrieval_touch', 'delete_everything']) {
    const result = evaluatePublicationGate(makeArgs({ candidates: [makeCandidate({ candidate_kind: kind })] }));
    assert.equal(result.decisions[0].decision, 'rejected', kind);
    assert.equal(result.decisions[0].reason_code, 'candidate_kind_not_allowed', kind);
    assert.equal(result.item_outcome, 'rejected', kind);
  }
});

test('enforces the 4096 UTF-8 byte payload ceiling', () => {
  const atCeiling = evaluatePublicationGate(makeArgs({ candidates: [makeCandidate({ payload_bytes: 4096 })] }));
  assert.equal(atCeiling.decisions[0].decision, 'authorized');

  const overCeiling = evaluatePublicationGate(makeArgs({ candidates: [makeCandidate({ payload_bytes: 4097 })] }));
  assert.equal(overCeiling.decisions[0].decision, 'rejected');
  assert.equal(overCeiling.decisions[0].reason_code, 'candidate_payload_too_large');
});

test('enforces the 16 source-ref ceiling', () => {
  const refs = (count) => Array.from({ length: count }, (_, index) => `ref_${index}`);
  const atCeiling = evaluatePublicationGate(makeArgs({ candidates: [makeCandidate({ source_refs: refs(16) })] }));
  assert.equal(atCeiling.decisions[0].decision, 'authorized');

  const overCeiling = evaluatePublicationGate(makeArgs({ candidates: [makeCandidate({ source_refs: refs(17) })] }));
  assert.equal(overCeiling.decisions[0].decision, 'rejected');
  assert.equal(overCeiling.decisions[0].reason_code, 'candidate_source_refs_exceeded');
});

test('forbids sensitivity downgrade but allows equal or higher levels', () => {
  const binding = makeBinding({ sensitivity: 'sensitive' });
  const source = makeSource({ sensitivity: 'sensitive' });

  const downgrade = evaluatePublicationGate(makeArgs({
    binding,
    source,
    candidates: [makeCandidate({ sensitivity: 'standard' })],
  }));
  assert.equal(downgrade.decisions[0].decision, 'rejected');
  assert.equal(downgrade.decisions[0].reason_code, 'sensitivity_downgrade');

  const equal = evaluatePublicationGate(makeArgs({
    binding,
    source,
    candidates: [makeCandidate({ sensitivity: 'sensitive' })],
  }));
  assert.equal(equal.decisions[0].decision, 'authorized');

  const upgrade = evaluatePublicationGate(makeArgs({
    binding,
    source,
    candidates: [makeCandidate({ sensitivity: 'sealed' })],
  }));
  assert.equal(upgrade.decisions[0].decision, 'authorized');
});

test('rejects scope envelope mismatch', () => {
  const result = evaluatePublicationGate(makeArgs({
    candidates: [makeCandidate({ scope_envelope_digest: sha256Digest('other-scope') })],
  }));
  assert.equal(result.decisions[0].decision, 'rejected');
  assert.equal(result.decisions[0].reason_code, 'scope_mismatch');
});

test('rejects typed forbidden classes and reports the class in the reason', () => {
  const candidate = makeCandidate({
    claim_manifest: [
      { claim_kind: 'experience', forbidden_classes: [], receipt_refs: [] },
      { claim_kind: 'preference_observation', forbidden_classes: ['canon_promotion'], receipt_refs: [] },
    ],
  });
  const result = evaluatePublicationGate(makeArgs({ candidates: [candidate] }));
  assert.equal(result.decisions[0].decision, 'rejected');
  assert.equal(result.decisions[0].reason_code, 'forbidden_class:canon_promotion');
  assert.equal(result.gate_provenance.forbidden_class_result, 'canon_promotion');
  assert.equal(result.item_outcome, 'rejected');
});

test('requires trusted receipts for action_completion claims (§4.4)', () => {
  const actionClaim = (receiptRefs) => ({ claim_kind: 'action_completion', forbidden_classes: [], receipt_refs: receiptRefs });

  const noReceipt = evaluatePublicationGate(makeArgs({
    candidates: [makeCandidate({ claim_manifest: [actionClaim([])] })],
  }));
  assert.equal(noReceipt.decisions[0].decision, 'rejected');
  assert.equal(noReceipt.decisions[0].reason_code, 'action_completion_without_trusted_receipt');

  const untrusted = evaluatePublicationGate(makeArgs({
    candidates: [makeCandidate({ claim_manifest: [actionClaim(['rcpt_forged'])] })],
  }));
  assert.equal(untrusted.decisions[0].decision, 'rejected');
  assert.equal(untrusted.decisions[0].reason_code, 'action_completion_without_trusted_receipt');

  const trusted = evaluatePublicationGate(makeArgs({
    candidates: [makeCandidate({ claim_manifest: [actionClaim(['rcpt_trusted_1'])] })],
  }));
  assert.equal(trusted.decisions[0].decision, 'authorized');
});

test('rejects when curator or reviewer provenance is incomplete', () => {
  const noReviewer = evaluatePublicationGate(makeArgs({ item: makeItem({ reviewer: null }) }));
  assert.equal(noReviewer.decisions[0].decision, 'rejected');
  assert.equal(noReviewer.decisions[0].reason_code, 'provenance_incomplete');
  assert.equal(noReviewer.item_outcome, 'rejected');
  assert.equal(noReviewer.gate_provenance.gate_reason_code, 'provenance_incomplete');

  const noCuratorOutput = evaluatePublicationGate(makeArgs({
    item: makeItem({ curator: makeCurator({ curator_output_digest: null }) }),
  }));
  assert.equal(noCuratorOutput.decisions[0].decision, 'rejected');
  assert.equal(noCuratorOutput.decisions[0].reason_code, 'provenance_incomplete');
});

test('rejects curator/reviewer protocol version mismatches', () => {
  const badCurator = evaluatePublicationGate(makeArgs({
    item: makeItem({ curator: makeCurator({ curator_protocol_version: 'compat-curator/v0' }) }),
  }));
  assert.equal(badCurator.decisions[0].reason_code, 'protocol_version_mismatch');

  const badReviewer = evaluatePublicationGate(makeArgs({
    item: makeItem({ reviewer: makeReviewer({ reviewer_protocol_version: 'compat-reviewer/v0' }) }),
  }));
  assert.equal(badReviewer.decisions[0].reason_code, 'protocol_version_mismatch');
});

test('enforces reviewer decision and digest binding (§5.2)', () => {
  const rejectDecision = evaluatePublicationGate(makeArgs({
    item: makeItem({ reviewer: makeReviewer({ reviewer_decision: 'reject' }) }),
  }));
  assert.equal(rejectDecision.decisions[0].decision, 'rejected');
  assert.equal(rejectDecision.decisions[0].reason_code, 'reviewer_decision_invalid');

  // accept must keep the curator payload digest unchanged.
  const changedDigest = evaluatePublicationGate(makeArgs({
    candidates: [makeCandidate({ curator_candidate_payload_digest: sha256Digest('curator-original') })],
  }));
  assert.equal(changedDigest.decisions[0].decision, 'rejected');
  assert.equal(changedDigest.decisions[0].reason_code, 'reviewer_binding_mismatch');

  // revise produces a new digest and requires reviewer_revision = 1.
  const revisedDigest = sha256Digest('revised-payload');
  const reviseOk = evaluatePublicationGate(makeArgs({
    item: makeItem({ reviewer: makeReviewer({ reviewer_decision: 'revise', reviewer_revision: 1 }) }),
    candidates: [makeCandidate({
      candidate_payload_digest: revisedDigest,
      curator_candidate_payload_digest: sha256Digest('curator-original'),
    })],
  }));
  assert.equal(reviseOk.decisions[0].decision, 'authorized');

  const reviseNoRevision = evaluatePublicationGate(makeArgs({
    item: makeItem({ reviewer: makeReviewer({ reviewer_decision: 'revise', reviewer_revision: 0 }) }),
    candidates: [makeCandidate({
      candidate_payload_digest: revisedDigest,
      curator_candidate_payload_digest: sha256Digest('curator-original'),
    })],
  }));
  assert.equal(reviseNoRevision.decisions[0].decision, 'rejected');
  assert.equal(reviseNoRevision.decisions[0].reason_code, 'reviewer_binding_mismatch');
});

test('rejects source binding digest mismatches', () => {
  const result = evaluatePublicationGate(makeArgs({
    item: makeItem({ source_event_digest: sha256Digest('forged-source') }),
  }));
  assert.equal(result.decisions[0].decision, 'rejected');
  assert.equal(result.decisions[0].reason_code, 'source_digest_mismatch');
  assert.equal(result.item_outcome, 'rejected');
});

test('rejects stale source content replaced by a newer revision', () => {
  const storeView = makeStoreView({
    current_revision_binding: {
      source_revision: 2,
      source_event_digest: sha256Digest('source-event/2'),
      final_content_digest: sha256Digest('final-content/2'),
      lifecycle_state: 'current',
    },
  });
  const result = evaluatePublicationGate(makeArgs({ storeView }));
  assert.equal(result.decisions[0].decision, 'rejected');
  assert.equal(result.decisions[0].reason_code, 'source_stale');
  assert.equal(result.item_outcome, 'rejected');
});

test('blocks publication on withdrawn/suppressed source lifecycle', () => {
  for (const lifecycleState of ['withdrawn', 'suppressed', 'superseded']) {
    const result = evaluatePublicationGate(makeArgs({
      binding: makeBinding({ lifecycle_state: lifecycleState }),
    }));
    assert.equal(result.decisions[0].decision, 'rejected', lifecycleState);
    assert.equal(result.decisions[0].reason_code, 'source_not_current', lifecycleState);
    assert.equal(result.item_outcome, 'rejected', lifecycleState);
  }
});

test('tombstones candidates on deleted source or recorded tombstone', () => {
  const deleted = evaluatePublicationGate(makeArgs({
    binding: makeBinding({ lifecycle_state: 'deleted' }),
  }));
  assert.equal(deleted.decisions[0].decision, 'tombstoned');
  assert.equal(deleted.decisions[0].reason_code, 'source_tombstoned');
  assert.equal(deleted.item_outcome, 'rejected');
  assert.equal(deleted.gate_provenance.gate_decision, 'tombstoned');
  assert.equal(deleted.gate_provenance.gate_reason_code, 'source_tombstoned');

  const tombstoned = evaluatePublicationGate(makeArgs({
    storeView: makeStoreView({ tombstone: { tombstone_ref: 'ocq_tomb_1', tombstone_state: 'recorded' } }),
  }));
  assert.equal(tombstoned.decisions[0].decision, 'tombstoned');
  assert.equal(tombstoned.decisions[0].reason_code, 'source_tombstoned');
});

test('defers candidates beyond the authorized-per-source-event budget', () => {
  const candidates = [makeCandidate(), makeCandidate(), makeCandidate(), makeCandidate()];
  const result = evaluatePublicationGate(makeArgs({ candidates }));
  assert.deepEqual(
    result.decisions.map((entry) => entry.decision),
    ['authorized', 'authorized', 'authorized', 'deferred'],
  );
  assert.equal(result.decisions[3].reason_code, 'budget_deferred');
  // Mixed batch semantics: the three in-budget candidates proceed; the
  // surplus stays a deferred decision. Since the §6.3 ceiling is per source
  // event, a later deterministic pass reaches the same outcome, so the item
  // must not hold back authorized work.
  assert.equal(result.item_outcome, 'authorized');
  assert.equal(result.gate_provenance.budget_result, 'deferred_budget');
  assert.equal(result.gate_provenance.gate_reason_code, 'ok_with_budget_deferred');
  assert.equal(result.next_attempt_at, null);

  // Authorizations from an earlier gate pass of the same source event count.
  const priorFull = evaluatePublicationGate(makeArgs({
    candidates: [makeCandidate()],
    storeView: makeStoreView({ prior_authorized_count: 3 }),
  }));
  assert.equal(priorFull.decisions[0].decision, 'deferred');
  assert.equal(priorFull.item_outcome, 'deferred');
});

test('rejects surplus i-observation candidates beyond the budget of one', () => {
  const iCandidate = () => makeCandidate({
    candidate_kind: 'append_i_observation_candidate',
    claim_manifest: [{ claim_kind: 'i_observation_candidate', forbidden_classes: [], receipt_refs: [] }],
  });
  const result = evaluatePublicationGate(makeArgs({ candidates: [iCandidate(), iCandidate()] }));
  assert.deepEqual(
    result.decisions.map((entry) => entry.decision),
    ['authorized', 'rejected'],
  );
  assert.equal(result.decisions[1].reason_code, 'budget_i_observation_exceeded');
  assert.equal(result.item_outcome, 'authorized');
  assert.equal(result.gate_provenance.budget_result, 'rejected_budget');
});

test('rejects everything on adapter policy or upstream version drift', () => {
  const badPolicy = evaluatePublicationGate(makeArgs({ adapterPolicyDigest: sha256Digest('other-policy') }));
  assert.equal(badPolicy.decisions[0].decision, 'rejected');
  assert.equal(badPolicy.decisions[0].reason_code, 'adapter_policy_mismatch');
  assert.equal(badPolicy.item_outcome, 'rejected');
  assert.equal(badPolicy.gate_provenance.gate_reason_code, 'adapter_policy_mismatch');

  const badUpstream = evaluatePublicationGate(makeArgs({ upstreamVersion: 'deadbeef'.repeat(8) }));
  assert.equal(badUpstream.decisions[0].decision, 'rejected');
  assert.equal(badUpstream.decisions[0].reason_code, 'adapter_policy_mismatch');
});

test('rejects everything when the budget profile is missing or unbounded', () => {
  const missing = evaluatePublicationGate(makeArgs({ budgetProfile: null }));
  assert.equal(missing.decisions[0].decision, 'rejected');
  assert.equal(missing.decisions[0].reason_code, 'budget_profile_invalid');
  assert.equal(missing.gate_provenance.budget_result, 'rejected_budget');

  const unbounded = evaluatePublicationGate(makeArgs({
    budgetProfile: { ...BUDGET_PROFILE_V1, max_authorized_candidates_per_source_event: Number.POSITIVE_INFINITY },
  }));
  assert.equal(unbounded.decisions[0].decision, 'rejected');
  assert.equal(unbounded.decisions[0].reason_code, 'budget_profile_invalid');
});

test('fences every candidate when the store fence is active', () => {
  const result = evaluatePublicationGate(makeArgs({
    storeView: makeStoreView({
      fence: { fence_revision: 7, frozen_queue_cursor: 42, frozen_source_cursor: 9, activated_at: FIXED_NOW.toISOString() },
    }),
  }));
  assert.equal(result.decisions[0].decision, 'fenced');
  assert.equal(result.decisions[0].reason_code, 'fenced');
  assert.equal(result.item_outcome, 'fenced');
  assert.equal(result.gate_provenance.gate_decision, 'fenced');
  assert.equal(result.gate_provenance.gate_reason_code, 'fenced');
  assert.equal(result.next_attempt_at, null);
});

test('marks batch-internal operation key replays as conflict', () => {
  const duplicate = makeCandidate();
  const result = evaluatePublicationGate(makeArgs({
    candidates: [duplicate, { ...duplicate }],
  }));
  assert.deepEqual(
    result.decisions.map((entry) => entry.decision),
    ['authorized', 'conflict'],
  );
  assert.equal(result.decisions[1].reason_code, 'operation_key_replay');
  assert.equal(result.item_outcome, 'authorized');
});

test('is deterministic: identical typed input replays to identical output', () => {
  // Four candidates exercise the deferred path so next_attempt_at (clock
  // derived) is part of the replayed output as well.
  const args = makeArgs({ candidates: [makeCandidate(), makeCandidate(), makeCandidate(), makeCandidate()] });
  const first = evaluatePublicationGate(args);
  const second = evaluatePublicationGate(args);
  assert.equal(first.gate_provenance.gate_input_digest, second.gate_provenance.gate_input_digest);
  assert.deepEqual(first, second);

  // A structurally equal deep copy (not the same references) replays too.
  const copy = {
    ...args,
    item: deepFreezeClone(args.item),
    candidates: deepFreezeClone(args.candidates),
    source: deepFreezeClone(args.source),
    binding: deepFreezeClone(args.binding),
    storeView: deepFreezeClone(args.storeView),
    budgetProfile: deepFreezeClone(args.budgetProfile),
  };
  const third = evaluatePublicationGate(copy);
  assert.equal(third.gate_provenance.gate_input_digest, first.gate_provenance.gate_input_digest);
  assert.deepEqual(third, first);
});

test('never inspects payload content: source has no payload store access and decisions ignore bodies', () => {
  const gateSource = fs.readFileSync(new URL('../src/ombreCompat/gate.mjs', import.meta.url), 'utf8');
  assert.ok(!gateSource.includes('payloadStore'), 'gate must not import the payload store');
  assert.ok(!gateSource.includes('node:fs'), 'gate must not touch the filesystem');

  const benign = makeArgs({
    candidates: [makeCandidate({ body: 'a quiet walk in the park' })],
  });
  const hostile = makeArgs({
    candidates: [makeCandidate({ body: 'password token suicide bomb delete overwrite merge_history' })],
  });
  // Same candidate id/digest material: only the natural-language body differs.
  hostile.candidates[0].candidate_id = benign.candidates[0].candidate_id;
  hostile.candidates[0].candidate_payload_ref = benign.candidates[0].candidate_payload_ref;
  hostile.candidates[0].candidate_payload_digest = benign.candidates[0].candidate_payload_digest;
  hostile.candidates[0].curator_candidate_payload_digest = benign.candidates[0].curator_candidate_payload_digest;

  const benignResult = evaluatePublicationGate(benign);
  const hostileResult = evaluatePublicationGate(hostile);
  assert.equal(hostileResult.decisions[0].decision, benignResult.decisions[0].decision);
  assert.equal(hostileResult.decisions[0].reason_code, benignResult.decisions[0].reason_code);
  assert.equal(hostileResult.gate_provenance.gate_input_digest, benignResult.gate_provenance.gate_input_digest);
  assert.ok(!('body' in benignResult.decisions[0].candidate), 'decisions never copy payload bodies');
});

test('is pure: deep-frozen inputs are accepted and never mutated', () => {
  const args = makeArgs({ candidates: [makeCandidate(), makeCandidate()] });
  const frozen = {
    ...args,
    item: deepFreezeClone(args.item),
    candidates: deepFreezeClone(args.candidates),
    source: deepFreezeClone(args.source),
    binding: deepFreezeClone(args.binding),
    storeView: deepFreezeClone(args.storeView),
    budgetProfile: deepFreezeClone(args.budgetProfile),
  };
  const snapshot = deepFreezeClone({
    item: frozen.item,
    candidates: frozen.candidates,
    source: frozen.source,
    binding: frozen.binding,
    storeView: frozen.storeView,
  });
  const result = evaluatePublicationGate(frozen);
  assert.equal(result.item_outcome, 'authorized');
  assert.deepEqual(
    {
      item: frozen.item,
      candidates: frozen.candidates,
      source: frozen.source,
      binding: frozen.binding,
      storeView: frozen.storeView,
    },
    snapshot,
  );
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.decisions));
  assert.ok(Object.isFrozen(result.gate_provenance));
});
