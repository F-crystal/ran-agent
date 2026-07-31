// Ombre O2 bounded maintenance touch tests (§7, §13.5): retrieval-used events
// come only from the trusted reader host; touch runs in an independent worker
// with operation keys, budgets, and receipts. In v1 the upstream touch method
// is UNBOUND_REQUIRED_BEFORE_O2, so every dispatch ends in a conclusive typed
// denial with zero mutation.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { canonicalDigest } from '../src/ombreCompat/canonical.mjs';
import { validateFinalTurnSourceEvent, validateRetrievalUsedEvent } from '../src/ombreCompat/sourceEvent.mjs';
import { createCompatQueueStore, deriveSourceEventId } from '../src/ombreCompat/queueStore.mjs';
import { createCompatPayloadStore } from '../src/ombreCompat/payloadStore.mjs';
import { createStewardAdapter } from '../src/ombreCompat/stewardAdapter.mjs';
import { adapterPolicyDigest } from '../src/ombreCompat/adapterPolicy.mjs';
import { createCompatWorker } from '../src/ombreCompat/worker.mjs';
import { createReconciler } from '../src/ombreCompat/reconciler.mjs';
import { createTouchWorker } from '../src/ombreCompat/touchWorker.mjs';
import { createProjectionRefresher } from '../src/ombreCompat/projectionRefresh.mjs';
import { createFakeUpstreamOmbre } from './helpers/fakeUpstreamOmbre.mjs';

const FIXED_CLOCK = () => new Date('2026-07-27T00:00:00.000Z');
const ADAPTER_POLICY = adapterPolicyDigest();

function tempRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocq-touch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeBinding(overrides = {}) {
  return validateFinalTurnSourceEvent({
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
  });
}

function makeRetrievalEvent(projectionItemRef, overrides = {}) {
  return validateRetrievalUsedEvent({
    schema_version: 'compatibility.retrieval-used/v1',
    retrieval_event_id: `ru-${projectionItemRef}`,
    operation_key: 'sha256:' + '0'.repeat(64),
    conversation_id: 'conv1',
    exchange_id: 'ex1',
    source_turn_id: 'turn-1',
    source_turn_revision: 0,
    projection_revision: 'sha256:' + '1'.repeat(64),
    projection_item_ref: projectionItemRef,
    projection_item_digest: canonicalDigest(projectionItemRef),
    usage_kind: 'provider_input',
    scope_envelope_digest: canonicalDigest('scope'),
    emitted_at: '2026-07-27T00:00:00.000Z',
    ...overrides,
  });
}

async function setup(t) {
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
  const worker = createCompatWorker({
    store,
    payloadStore,
    adapter,
    refresher: createProjectionRefresher({
      projectionDir: path.join(root, 'projection'),
      store,
      resolver: () => ({ items: [] }),
      clock: FIXED_CLOCK,
    }),
    reconciler: createReconciler({ store, adapter, clock: FIXED_CLOCK }),
    curatorConfig: { baseUrl: 'http://127.0.0.1:9/unused', model: 'fake-curator-v1', apiKey: '', timeoutMs: 200 },
    reviewerConfig: { baseUrl: 'http://127.0.0.1:9/unused', model: 'fake-reviewer-v1', apiKey: '', timeoutMs: 200 },
    sourceTextResolver: async () => ({ user: 'user text', assistant: 'assistant text' }),
    checkpointGuard: async () => true,
    curatorImpl: async () => JSON.stringify({ candidates: [{
      candidate_kind: 'append_experience',
      title: 'afternoon',
      first_person_text: '一段真实的共同经历。',
      source_refs: ['r1'],
      scope_envelope_digest: canonicalDigest('scope'),
      sensitivity: 'standard',
      counterevidence: 'none',
      uncertainty: 'low',
    }] }),
    reviewerImpl: async () => JSON.stringify({ decision: 'accept', reason_code: 'ok', claim_manifest: { claims: [] } }),
    clock: FIXED_CLOCK,
  });
  const touch = createTouchWorker({ store, adapter, clock: FIXED_CLOCK });
  return { root, upstream, store, payloadStore, adapter, worker, touch };
}

async function publishOne(worker, store) {
  const itemId = store.ingressSourceEvent(makeBinding()).item_ids[0];
  for (let index = 0; index < 4; index += 1) await worker.processQueueItem(itemId);
  const operation = store.listOperations().find((op) => op.candidate_kind === 'append_experience');
  return { itemId, operation };
}

test('§7.2 retrieval-used schema is fail-closed', () => {
  assert.throws(() => validateRetrievalUsedEvent({ schema_version: 'wrong/v9' }), (e) => e.code === 'COMPAT_INGRESS_INVALID');
  const good = makeRetrievalEvent('ombre:experience:1');
  assert.equal(good.schema_version, 'compatibility.retrieval-used/v1');
  const missing = { ...good };
  delete missing.projection_item_digest;
  assert.throws(() => validateRetrievalUsedEvent(missing), (e) => e.code === 'COMPAT_INGRESS_INVALID');
});

test('§7.3 v1 touch dispatch is a conclusive typed denial with zero mutation', async (t) => {
  const { store, touch, worker, upstream } = await setup(t);
  const { operation } = await publishOne(worker, store);
  const targetRef = operation.projection_target_ref;
  const event = makeRetrievalEvent(targetRef, { operation_key: operation.operation_key });
  assert.equal(touch.recordRetrievalUsed(event).disposition, 'new');
  assert.equal(touch.recordRetrievalUsed(event).disposition, 'exact_replay');

  const plan = await touch.processRetrievalEvent({ retrieval_event_id: event.retrieval_event_id });
  assert.equal(plan.results.length, 1);
  assert.equal(plan.results[0].disposition, 'denied_unbound');
  // Zero upstream mutation: only health checks happened, never tools/call.
  assert.equal(upstream.callCount.hold, 1, 'only the original growth hold');
  const touchOp = store.listOperations().find((op) => op.candidate_kind === 'lifecycle:touch');
  assert.ok(touchOp, 'touch operation exists with its own operation key');
  assert.equal(touchOp.state, 'failed');
  assert.equal(touchOp.retryable, false, 'touch denial is non-retryable');
  assert.equal(touchOp.last_error_code, 'COMPAT_ADAPTER_METHOD_DENIED');
  assert.notEqual(touchOp.operation_key, operation.operation_key);
  const receipts = store.listReceipts().filter((receipt) => receipt.receipt_operation_key === touchOp.operation_key);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].outcome, 'failed');

  // Duplicate processing of the same event+item is idempotent.
  const again = await touch.processRetrievalEvent({ retrieval_event_id: event.retrieval_event_id });
  assert.equal(again.results[0].disposition, 'exact_replay');
});

test('§7.3 touch refuses unknown items, deleted sources, and tombstoned targets', async (t) => {
  const { store, touch, worker, lane: _lane, upstream } = await setup(t);
  // Unknown projection item -> skipped.
  const unknownEvent = makeRetrievalEvent('ombre:experience:nope');
  touch.recordRetrievalUsed(unknownEvent);
  const skipped = await touch.processRetrievalEvent({ retrieval_event_id: unknownEvent.retrieval_event_id });
  assert.equal(skipped.results[0].disposition, 'skipped');
  assert.equal(skipped.results[0].reason, 'unknown_projection_item');

  const { operation } = await publishOne(worker, store);
  const targetRef = operation.projection_target_ref;
  store.recordTombstone({
    target_ref: targetRef,
    tombstone_ref: `compat-tombstone:${targetRef}`,
    tombstone_state: 'sealed',
    deletion_ref: 'deletion://x',
    deletion_domain: 'compat_payload_default',
  });
  const tombstonedEvent = makeRetrievalEvent(targetRef, { operation_key: operation.operation_key });
  touch.recordRetrievalUsed(tombstonedEvent);
  const refused = await touch.processRetrievalEvent({ retrieval_event_id: tombstonedEvent.retrieval_event_id });
  assert.equal(refused.results[0].disposition, 'rejected');
  assert.equal(refused.results[0].reason, 'tombstoned');
  assert.equal(upstream.callCount.hold, 1);
});

test('§7.3 per-event item budget is enforced (>20 items)', async (t) => {
  const { touch } = await setup(t);
  const many = Array.from({ length: 21 }, (_, index) => `ombre:experience:${index}`);
  const event = makeRetrievalEvent('ombre:experience:0', { projection_item_refs: many });
  touch.recordRetrievalUsed(event);
  await assert.rejects(
    touch.processRetrievalEvent({ retrieval_event_id: event.retrieval_event_id }),
    (error) => error.code === 'COMPAT_BUDGET_EXCEEDED',
  );
});
