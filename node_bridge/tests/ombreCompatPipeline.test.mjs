// Ombre O2 end-to-end pipeline tests (§5, §12, §13): source event -> queue ->
// tool-less Curator/Reviewer -> deterministic gate -> pinned adapter -> receipt
// -> projection refresh -> Lite/Full common revision. Uses the real fake
// upstream MCP transport (HTTP JSON-RPC), never mocks at the function level
// for the adapter path, and never touches real external services.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { canonicalDigest } from '../src/ombreCompat/canonical.mjs';
import { validateFinalTurnSourceEvent } from '../src/ombreCompat/sourceEvent.mjs';
import { createCompatQueueStore, deriveSourceEventId } from '../src/ombreCompat/queueStore.mjs';
import { createCompatPayloadStore } from '../src/ombreCompat/payloadStore.mjs';
import { createStewardAdapter } from '../src/ombreCompat/stewardAdapter.mjs';
import { adapterPolicyDigest } from '../src/ombreCompat/adapterPolicy.mjs';
import { createCompatWorker } from '../src/ombreCompat/worker.mjs';
import { createReconciler } from '../src/ombreCompat/reconciler.mjs';
import { createLifecycleLane } from '../src/ombreCompat/lifecycleLane.mjs';
import { createProjectionRefresher, readForMode } from '../src/ombreCompat/projectionRefresh.mjs';
import { createFakeUpstreamOmbre } from './helpers/fakeUpstreamOmbre.mjs';

const FIXED_CLOCK = () => new Date('2026-07-27T00:00:00.000Z');
const ADAPTER_POLICY = adapterPolicyDigest();

function tempRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocq-pipeline-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeBinding(overrides = {}) {
  const event = {
    schema_version: 'compatibility.final-turn/v1',
    event_id: deriveSourceEventId({ platform: 'wechat', conversation_id: 'conv1', exchange_id: 'ex1' }),
    source_revision: 0,
    conversation_id: 'conv1',
    exchange_id: 'ex1',
    user_final_payload_ref: 'global-timeline://turn/conv1/ex1/user',
    user_final_payload_revision: 0,
    user_final_payload_digest: canonicalDigest('user text'),
    assistant_final_payload_ref: 'global-timeline://turn/conv1/ex1/assistant',
    assistant_final_payload_revision: 0,
    assistant_final_payload_digest: canonicalDigest('assistant text'),
    final_content_digest: canonicalDigest({ u: 1, a: 1 }),
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
  };
  return validateFinalTurnSourceEvent(event);
}

function experienceCandidate(overrides = {}) {
  return {
    candidate_kind: 'append_experience',
    title: 'A real afternoon',
    first_person_text: '我今天和用户一起调试了队列状态机，很踏实。',
    source_refs: ['global-timeline://turn/conv1/ex1/user'],
    scope_envelope_digest: canonicalDigest('scope'),
    sensitivity: 'standard',
    counterevidence: 'none observed',
    uncertainty: 'low',
    ...overrides,
  };
}

function curatorJson(candidates) {
  return JSON.stringify({ candidates });
}

function reviewerJson(overrides = {}) {
  return JSON.stringify({
    decision: 'accept',
    reason_code: 'grounded',
    claim_manifest: { claims: [] },
    ...overrides,
  });
}

async function setup(t, { curatorImpl, reviewerImpl, upstreamMode = 'normal', adapterTimeoutMs = 300 } = {}) {
  const root = tempRoot(t);
  const upstream = createFakeUpstreamOmbre();
  await upstream.start();
  t.after(async () => upstream.close());
  upstream.setMode(upstreamMode);

  const store = createCompatQueueStore({
    dir: path.join(root, 'queue'),
    clock: FIXED_CLOCK,
    adapterPolicyDigest: ADAPTER_POLICY,
  });
  store.open();
  t.after(() => { try { store.close(); } catch {} });

  const payloadStore = createCompatPayloadStore({ dir: path.join(root, 'payloads') });
  t.after(() => payloadStore.close());
  const adapter = createStewardAdapter({
    ...upstream.adapterOptions(),
    timeoutMs: adapterTimeoutMs,
  });
  const resolver = () => ({
    items: store.exportView().operations
      .filter((operation) => operation.state === 'published' && operation.projection_target_ref)
      .map((operation) => ({
        item_ref: operation.projection_target_ref,
        item_digest: canonicalDigest(operation.projection_target_ref),
        source_operation_key: operation.operation_key,
        layer: 'experience',
        body: 'projection-item',
      })),
  });
  const refresher = createProjectionRefresher({
    projectionDir: path.join(root, 'projection'),
    store,
    resolver,
    clock: FIXED_CLOCK,
  });
  const reconciler = createReconciler({ store, adapter, clock: FIXED_CLOCK });
  const lane = createLifecycleLane({ store, payloadStore, adapter, clock: FIXED_CLOCK });
  const worker = createCompatWorker({
    store,
    payloadStore,
    adapter,
    refresher,
    reconciler,
    curatorConfig: { baseUrl: 'http://127.0.0.1:9/unused', model: 'fake-curator-v1', apiKey: '', timeoutMs: 200 },
    reviewerConfig: { baseUrl: 'http://127.0.0.1:9/unused', model: 'fake-reviewer-v1', apiKey: '', timeoutMs: 200 },
    sourceTextResolver: async () => ({ user: 'user text', assistant: 'assistant text' }),
    checkpointGuard: async () => true,
    curatorImpl: curatorImpl || (async () => curatorJson([experienceCandidate()])),
    reviewerImpl: reviewerImpl || (async () => reviewerJson()),
    clock: FIXED_CLOCK,
  });
  return { root, upstream, store, payloadStore, adapter, refresher, reconciler, lane, worker };
}

async function driveToTerminal(worker, store, itemId, maxRounds = 8) {
  for (let round = 0; round < maxRounds; round += 1) {
    await worker.processQueueItem(itemId);
    const state = store.getItem(itemId).queue_item_state;
    if (['published', 'rejected', 'withdrawn', 'superseded', 'failed'].includes(state)) {
      const item = store.getItem(itemId);
      if (state === 'published' && ['pending', 'failed'].includes(item.revision_refresh_state)) continue;
      if (state === 'failed') {
        const ops = item.operation_ids.map((id) => store.getOperation(id));
        if (ops.some((operation) => operation.retryable && operation.state === 'failed')) continue;
      }
      return item;
    }
  }
  return store.getItem(itemId);
}

test('§5/§13 happy path: full pipeline reaches published + verified common revision', async (t) => {
  const { store, worker, upstream, refresher } = await setup(t);
  const ingress = store.ingressSourceEvent(makeBinding());
  const itemId = ingress.item_ids[0];
  const item = await driveToTerminal(worker, store, itemId);

  assert.equal(item.queue_item_state, 'published');
  assert.equal(item.revision_refresh_state, 'published');
  assert.ok(item.projection_revision.startsWith('sha256:'));

  const operations = store.listOperations();
  assert.equal(operations.length, 1);
  assert.equal(operations[0].state, 'published');
  assert.ok(operations[0].projection_target_ref.startsWith('ombre-steward://target/experience/'));
  assert.equal(upstream.callCount.hold, 1);
  assert.equal(upstream.callCount.hold_applied, 1);

  const receipts = store.listReceipts();
  assert.equal(receipts.length, 1);
  const receipt = receipts[0];
  assert.equal(receipt.outcome, 'succeeded');
  assert.equal(receipt.receipt_operation_key, operations[0].operation_key);
  assert.equal(receipt.adapter_policy_digest, ADAPTER_POLICY);
  assert.equal(receipt.upstream_version, operations[0].upstream_version);
  assert.ok(receipt.upstream_evidence_ref);

  // Lite and Full consume the same verified revision (§5.6).
  const liteRead = await readForMode({
    projectionDir: refresher.projectionDir,
    mode: 'lite',
    expectedAdapterPolicyDigest: ADAPTER_POLICY,
  });
  const fullRead = await readForMode({
    projectionDir: refresher.projectionDir,
    mode: 'full',
    expectedAdapterPolicyDigest: ADAPTER_POLICY,
  });
  assert.equal(liteRead.status, 'ok');
  assert.equal(fullRead.status, 'ok');
  assert.equal(liteRead.projection_revision, fullRead.projection_revision);
  assert.equal(liteRead.projection_revision, item.projection_revision);

  // Provenance chain: curator and reviewer invocations are independent and
  // carry empty tool inventories (§5.1/§5.2).
  assert.ok(item.curator.curator_invocation_id);
  assert.ok(item.reviewer.reviewer_invocation_id);
  assert.notEqual(item.curator.curator_invocation_id, item.reviewer.reviewer_invocation_id);
  assert.equal(item.curator.tool_inventory_digest, canonicalDigest([]));
  assert.equal(item.reviewer.tool_inventory_digest, canonicalDigest([]));
  assert.equal(item.gate.gate_decision, 'authorized');
});

test('§12.1/§9.2 source event duplicate submission is an exact replay with zero extra mutation', async (t) => {
  const { store, worker, upstream } = await setup(t);
  const binding = makeBinding();
  const first = store.ingressSourceEvent(binding);
  const second = store.ingressSourceEvent(binding);
  assert.equal(second.disposition, 'exact_replay');
  assert.deepEqual(second.item_ids, first.item_ids);
  await driveToTerminal(worker, store, first.item_ids[0]);
  const third = store.ingressSourceEvent(binding);
  assert.equal(third.disposition, 'exact_replay');
  assert.equal(upstream.callCount.hold_applied, 1);
  assert.equal(store.listItems().length, 1);
});

test('§12.2 Curator timeout -> item rejected, zero mutation, zero upstream calls', async (t) => {
  const never = () => new Promise(() => {});
  const { store, worker, upstream } = await setup(t, { curatorImpl: never });
  const ingress = store.ingressSourceEvent(makeBinding());
  const item = await driveToTerminal(worker, store, ingress.item_ids[0]);
  assert.equal(item.queue_item_state, 'rejected');
  assert.equal(item.reject_stage, 'curator');
  assert.equal(item.last_error_code, 'COMPAT_CURATOR_UNAVAILABLE');
  assert.equal(upstream.callCount.hold, 0);
  assert.equal(store.listOperations().length, 0);
});

test('§12.3 Reviewer malformed -> rejected, zero mutation', async (t) => {
  const { store, worker, upstream } = await setup(t, {
    reviewerImpl: async () => 'this is not json',
  });
  const ingress = store.ingressSourceEvent(makeBinding());
  const item = await driveToTerminal(worker, store, ingress.item_ids[0]);
  assert.equal(item.queue_item_state, 'rejected');
  assert.equal(item.reject_stage, 'reviewer');
  assert.equal(upstream.callCount.hold, 0);
});

test('§12.4 Reviewer rejects fabricated experience -> zero projection', async (t) => {
  const { store, worker, upstream } = await setup(t, {
    reviewerImpl: async () => reviewerJson({ decision: 'reject', reason_code: 'fabricated_experience' }),
  });
  const ingress = store.ingressSourceEvent(makeBinding());
  const item = await driveToTerminal(worker, store, ingress.item_ids[0]);
  assert.equal(item.queue_item_state, 'rejected');
  assert.equal(item.reviewer.reviewer_decision, 'reject');
  assert.equal(upstream.callCount.hold, 0);
});

test('§12.5/§4.4 action completion claim without trusted receipt parent is gate-rejected', async (t) => {
  const { store, worker, upstream } = await setup(t, {
    reviewerImpl: async () => reviewerJson({
      claim_manifest: {
        claims: [{
          claim_kind: 'action_completion',
          requires_trusted_receipt: true,
          receipt_refs: ['rcpt-foreign-not-in-source'],
          forbidden_classes: [],
          outcome: 'succeeded',
        }],
      },
    }),
  });
  const ingress = store.ingressSourceEvent(makeBinding());
  const item = await driveToTerminal(worker, store, ingress.item_ids[0]);
  assert.equal(item.queue_item_state, 'rejected');
  assert.equal(item.reject_stage, 'gate');
  assert.equal(item.gate.gate_decision, 'rejected');
  assert.match(item.gate.gate_reason_code, /action_completion_without_trusted_receipt/);
  assert.equal(upstream.callCount.hold, 0);
});

test('§6.3 budget: 4 candidates -> 3 authorized, item deferred, 4th not dispatched', async (t) => {
  const candidates = [0, 1, 2, 3].map((index) => experienceCandidate({
    title: `experience ${index}`,
    first_person_text: `经历 ${index}：各不相同的内容 ${'　'.repeat(index + 1)}`,
  }));
  const { store, worker, upstream } = await setup(t, {
    curatorImpl: async () => curatorJson(candidates),
  });
  const ingress = store.ingressSourceEvent(makeBinding());
  const itemId = ingress.item_ids[0];
  await worker.processQueueItem(itemId); // curator
  await worker.processQueueItem(itemId); // reviewer
  await worker.processQueueItem(itemId); // gate: 3 authorized, 1 deferred
  const item = store.getItem(itemId);
  // Mixed batch proceeds: the three authorized candidates dispatch now; the
  // fourth stays a deferred gate decision (§6.3 ceilings are per source
  // event, so a later deterministic pass reaches the same outcome).
  assert.equal(item.queue_item_state, 'authorized');
  assert.equal(item.gate.budget_result, 'deferred_budget');
  assert.equal(item.operation_ids.length, 3);
  // The three authorized operations dispatch and publish.
  await worker.processQueueItem(itemId);
  for (const operationId of item.operation_ids) {
    assert.equal(store.getOperation(operationId).state, 'published');
  }
  assert.equal(upstream.callCount.hold_applied, 3);
});

test('§12.2/#9 dispatch after dispatch-intent crash: ambiguous, no auto retry, reconcile observed_applied', async (t) => {
  const { store, worker, upstream, reconciler } = await setup(t, { upstreamMode: 'drop' });
  const ingress = store.ingressSourceEvent(makeBinding());
  const itemId = ingress.item_ids[0];
  await worker.processQueueItem(itemId); // curator
  await worker.processQueueItem(itemId); // reviewer
  await worker.processQueueItem(itemId); // gate
  await worker.processQueueItem(itemId); // dispatch -> timeout -> ambiguous
  let item = store.getItem(itemId);
  assert.equal(item.queue_item_state, 'ambiguous');
  const operation = store.listOperations()[0];
  assert.equal(operation.state, 'ambiguous');
  assert.equal(operation.last_error_code, 'COMPAT_AMBIGUOUS_REQUIRES_RECONCILIATION');
  assert.equal(operation.attempt_count, 1, 'ambiguous must not auto-retry (§6.3)');

  // The mutation secretly landed upstream (the timeout was one-sided).
  upstream.setMode('normal');

  const outcome = await reconciler.reconcileOperation({ operation_id: operation.operation_id });
  assert.equal(outcome.disposition, 'observed_applied');
  item = store.getItem(itemId);
  assert.equal(item.queue_item_state, 'published');
  assert.equal(store.getOperation(operation.operation_id).state, 'published');
  assert.equal(upstream.callCount.hold_applied, 1, 'reconciliation must not re-apply');
  const receipts = store.listReceipts().filter((receipt) => receipt.receipt_operation_key === operation.operation_key);
  assert.equal(receipts.at(-1).outcome, 'succeeded');
  assert.equal(receipts.at(-1).issuer_id, 'steward-reconciler');
});

test('§12.11/#12 reconcile observed_not_applied -> failed, retry creates a new attempt', async (t) => {
  const { store, worker, upstream, reconciler } = await setup(t, { upstreamMode: 'drop_before_apply' });
  const ingress = store.ingressSourceEvent(makeBinding());
  const itemId = ingress.item_ids[0];
  await worker.processQueueItem(itemId);
  await worker.processQueueItem(itemId);
  await worker.processQueueItem(itemId);
  await worker.processQueueItem(itemId); // ambiguous
  const operation = store.listOperations()[0];
  upstream.setMode('normal');
  const outcome = await reconciler.reconcileOperation({ operation_id: operation.operation_id });
  assert.equal(outcome.disposition, 'observed_not_applied');
  assert.equal(store.getOperation(operation.operation_id).state, 'failed');

  // Retry policy: failed + retryable + budget -> one new attempt (§9.3.4).
  await worker.processQueueItem(itemId); // retry stage
  const after = store.getOperation(operation.operation_id);
  assert.equal(after.state, 'published');
  assert.equal(after.attempt_count, 2);
  const attempts = store.listAttempts().filter((attempt) => attempt.operation_id === operation.operation_id);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].adapter_attempt_state, 'failed');
  assert.equal(attempts[1].adapter_attempt_state, 'succeeded');
  assert.equal(upstream.callCount.hold_applied, 1);
  // A third attempt is budget-forbidden (§6.3: one retryable attempt per source event).
  await assert.rejects(
    async () => {
      store.createRetryDispatch({
        operation_id: operation.operation_id,
        method_identifier: 'append_experience',
        adapter_request_digest: canonicalDigest('req-3'),
      });
    },
    (error) => error.code === 'COMPAT_RETRY_NOT_ALLOWED' || error.code === 'COMPAT_BUDGET_EXCEEDED'
      || error.code === 'COMPAT_ILLEGAL_TRANSITION',
  );
});

test('§13.4/#21 upstream version drift fails closed before any mutation', async (t) => {
  const { store, worker, upstream } = await setup(t, { upstreamMode: 'drift' });
  const ingress = store.ingressSourceEvent(makeBinding());
  const itemId = ingress.item_ids[0];
  await worker.processQueueItem(itemId);
  await worker.processQueueItem(itemId);
  await worker.processQueueItem(itemId);
  await worker.processQueueItem(itemId); // dispatch -> drift -> failed
  const operation = store.listOperations()[0];
  assert.equal(operation.state, 'failed');
  assert.equal(operation.last_error_code, 'COMPAT_ADAPTER_UPSTREAM_DRIFT');
  assert.equal(upstream.callCount.hold, 0, 'drift must stop before tools/call');
  // Drift is not in the retryable class: the worker never schedules a retry.
  await worker.processQueueItem(itemId);
  assert.equal(store.getOperation(operation.operation_id).attempt_count, 1);
});

test('§9.2/#14 same key different content is a conflict failure, not a retry', async (t) => {
  const { store, worker, upstream } = await setup(t, { upstreamMode: 'conflict' });
  const ingress = store.ingressSourceEvent(makeBinding());
  const itemId = ingress.item_ids[0];
  await worker.processQueueItem(itemId);
  await worker.processQueueItem(itemId);
  await worker.processQueueItem(itemId);
  await worker.processQueueItem(itemId);
  const operation = store.listOperations()[0];
  assert.equal(operation.state, 'failed');
  assert.equal(operation.last_error_code, 'STEWARD_IDEMPOTENCY_CONFLICT');
  assert.equal(operation.attempt_count, 1);
});

test('§4.3/#15 stale source revision blocks a late dispatch', async (t) => {
  const { store, worker } = await setup(t);
  const binding = makeBinding();
  const ingress = store.ingressSourceEvent(binding);
  const itemId = ingress.item_ids[0];
  await worker.processQueueItem(itemId);
  await worker.processQueueItem(itemId);
  await worker.processQueueItem(itemId); // gate -> authorized
  const operation = store.listOperations()[0];

  // A content-changing revision supersedes the old journey.
  const revised = makeBinding({
    source_revision: 1,
    assistant_final_payload_digest: canonicalDigest('assistant text edited'),
    final_content_digest: canonicalDigest({ u: 1, a: 2 }),
    supersedes_event_id: binding.event_id,
  });
  store.ingressSourceEvent(revised);
  store.applySourceLifecycle({
    event_id: binding.event_id,
    kind: 'supersede',
    ref: 'supersession://rev/1',
    revision: 1,
  });
  assert.equal(store.getItem(itemId).queue_item_state, 'superseded');
  await assert.rejects(
    async () => {
      store.createDispatchIntent({
        operation_id: operation.operation_id,
        method_identifier: 'append_experience',
        adapter_request_digest: canonicalDigest('req-stale'),
      });
    },
    (error) => [
      'COMPAT_ILLEGAL_TRANSITION',
      'COMPAT_SOURCE_STALE',
      'COMPAT_STALE_SOURCE_REVISION',
      'COMPAT_SOURCE_NOT_CURRENT',
    ].includes(error.code),
  );
});

test('§5.6/#17 projection refresh crash keeps published truth; refresh retries independently', async (t) => {
  const root = tempRoot(t);
  const upstream = createFakeUpstreamOmbre();
  await upstream.start();
  t.after(async () => upstream.close());
  const store = createCompatQueueStore({
    dir: path.join(root, 'queue'),
    clock: FIXED_CLOCK,
    adapterPolicyDigest: ADAPTER_POLICY,
  });
  store.open();
  t.after(() => { try { store.close(); } catch {} });
  const payloadStore = createCompatPayloadStore({ dir: path.join(root, 'payloads') });
  t.after(() => payloadStore.close());
  const adapter = createStewardAdapter({
    ...upstream.adapterOptions(),
    timeoutMs: 300,
  });
  const resolver = () => ({
    items: store.exportView().operations
      .filter((operation) => operation.state === 'published' && operation.projection_target_ref)
      .map((operation) => ({
        item_ref: operation.projection_target_ref,
        item_digest: canonicalDigest(operation.projection_target_ref),
        source_operation_key: operation.operation_key,
        layer: 'experience',
        body: 'projection-item',
      })),
  });
  let failNextSwap = true;
  const refresher = createProjectionRefresher({
    projectionDir: path.join(root, 'projection'),
    store,
    resolver,
    clock: FIXED_CLOCK,
    faultInjector: (stage) => {
      if (stage === 'before_pointer_swap' && failNextSwap) {
        failNextSwap = false;
        throw new Error('injected swap failure');
      }
    },
  });
  const worker = createCompatWorker({
    store,
    payloadStore,
    adapter,
    refresher,
    reconciler: createReconciler({ store, adapter, clock: FIXED_CLOCK }),
    curatorConfig: { baseUrl: 'http://127.0.0.1:9/unused', model: 'fake-curator-v1', apiKey: '', timeoutMs: 200 },
    reviewerConfig: { baseUrl: 'http://127.0.0.1:9/unused', model: 'fake-reviewer-v1', apiKey: '', timeoutMs: 200 },
    sourceTextResolver: async () => ({ user: 'user text', assistant: 'assistant text' }),
    checkpointGuard: async () => true,
    curatorImpl: async () => curatorJson([experienceCandidate()]),
    reviewerImpl: async () => reviewerJson(),
    clock: FIXED_CLOCK,
  });

  const ingress = store.ingressSourceEvent(makeBinding());
  const itemId = ingress.item_ids[0];
  // Drive stage by stage: curator -> reviewer -> gate -> dispatch -> refresh
  // (injected failure) -> refresh (retry succeeds).
  await worker.processQueueItem(itemId);
  await worker.processQueueItem(itemId);
  await worker.processQueueItem(itemId);
  await worker.processQueueItem(itemId);
  assert.equal(store.getItem(itemId).queue_item_state, 'published');
  await worker.processQueueItem(itemId); // refresh: injected swap failure
  let item = store.getItem(itemId);
  // Effect truth stands even though the first pointer swap failed (§9.3.1:
  // published + refresh failed must not roll back to dispatching/failed).
  assert.equal(item.queue_item_state, 'published');
  assert.equal(item.revision_refresh_state, 'failed');

  await worker.processQueueItem(itemId); // refresh retry
  item = store.getItem(itemId);
  assert.equal(item.revision_refresh_state, 'published');
  assert.ok(item.projection_revision.startsWith('sha256:'));
});

test('§5.5 transport garbage never signs a receipt (200 with non-JSON body)', async (t) => {
  const { store, worker, upstream } = await setup(t, { upstreamMode: 'garbage' });
  const ingress = store.ingressSourceEvent(makeBinding());
  const itemId = ingress.item_ids[0];
  await worker.processQueueItem(itemId);
  await worker.processQueueItem(itemId);
  await worker.processQueueItem(itemId);
  await worker.processQueueItem(itemId);
  const operation = store.listOperations()[0];
  assert.equal(operation.state, 'ambiguous');
  const receipts = store.listReceipts();
  assert.equal(receipts[0].outcome, 'ambiguous');
  assert.equal(receipts[0].ambiguous_reason_code, 'malformed_response');
  assert.equal(upstream.callCount.hold, 0);
});
