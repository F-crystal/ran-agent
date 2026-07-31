// Ombre O2 trusted lifecycle lane tests (§8, §9.3.6, §12.16/22, §13.6):
// withdraw / supersede / suppress / tombstone / total-delete run through a
// deterministic trusted lane separated from the model pipeline; deleted or
// withdrawn content is never resurrected by late workers.

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
import { createProjectionRefresher } from '../src/ombreCompat/projectionRefresh.mjs';
import { createFakeUpstreamOmbre } from './helpers/fakeUpstreamOmbre.mjs';

const FIXED_CLOCK = () => new Date('2026-07-27T00:00:00.000Z');
const ADAPTER_POLICY = adapterPolicyDigest();

function tempRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocq-lifecycle-'));
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

async function setup(t, { upstreamMode = 'normal' } = {}) {
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
    timeoutMs: 300,
  });
  const resolver = () => ({ items: [] });
  const refresher = createProjectionRefresher({
    projectionDir: path.join(root, 'projection'),
    store,
    resolver,
    clock: FIXED_CLOCK,
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
  const lane = createLifecycleLane({ store, payloadStore, adapter, clock: FIXED_CLOCK });
  return { root, upstream, store, payloadStore, adapter, worker, lane };
}

async function driveStages(worker, itemId, count) {
  for (let index = 0; index < count; index += 1) await worker.processQueueItem(itemId);
}

test('§8.2/#16 withdraw at gate_pending: item withdrawn, candidate payload erased, zero mutation', async (t) => {
  const { store, payloadStore, worker, lane, upstream } = await setup(t);
  const binding = makeBinding();
  const itemId = store.ingressSourceEvent(binding).item_ids[0];
  await driveStages(worker, itemId, 2); // curator + reviewer -> gate_pending
  const candidateRef = store.getItem(itemId).candidates[0].candidate_payload_ref;
  assert.ok(payloadStore.has(candidateRef));

  const report = await lane.handleSourceLifecycle({
    eventId: binding.event_id,
    kind: 'withdraw',
    ref: 'withdrawal://1',
    revision: 1,
  });
  assert.equal(report.item_transitions.length, 1);
  const item = store.getItem(itemId);
  assert.equal(item.queue_item_state, 'withdrawn');
  assert.equal(store.getSource(binding.event_id).lifecycle_state, 'withdrawn');
  assert.throws(() => payloadStore.get(candidateRef), (error) => error.code === 'COMPAT_PAYLOAD_ERASED');
  assert.equal(upstream.callCount.hold, 0);
  // A late worker pass is a terminal no-op; nothing is resurrected (§8.3).
  const late = await worker.processQueueItem(itemId);
  assert.equal(late.progress, false);
  assert.equal(store.getItem(itemId).queue_item_state, 'withdrawn');
  assert.equal(store.listAttempts().length, 0);
});

test('§8.2/#16 supersede at authorized: item superseded, payload erased', async (t) => {
  const { store, payloadStore, worker, lane } = await setup(t);
  const binding = makeBinding();
  const itemId = store.ingressSourceEvent(binding).item_ids[0];
  await driveStages(worker, itemId, 3); // -> authorized
  const candidateRef = store.getItem(itemId).candidates[0].candidate_payload_ref;
  await lane.handleSourceLifecycle({
    eventId: binding.event_id,
    kind: 'supersede',
    ref: 'supersession://1',
    revision: 1,
  });
  assert.equal(store.getItem(itemId).queue_item_state, 'superseded');
  assert.throws(() => payloadStore.get(candidateRef), (error) => error.code === 'COMPAT_PAYLOAD_ERASED');
});

test('§8.2/§9.3.3 suppress after publish: compensation lifecycle item; original keeps published truth', async (t) => {
  const { store, worker, lane, upstream } = await setup(t);
  const binding = makeBinding();
  const itemId = store.ingressSourceEvent(binding).item_ids[0];
  await driveStages(worker, itemId, 4); // -> published
  const growthItem = store.getItem(itemId);
  assert.equal(growthItem.queue_item_state, 'published');
  const growthOp = store.listOperations().find((operation) => operation.candidate_kind === 'append_experience');

  const report = await lane.handleSourceLifecycle({
    eventId: binding.event_id,
    kind: 'suppress',
    ref: 'suppression://1',
    revision: 1,
  });
  assert.equal(report.compensations.length, 1);
  assert.equal(upstream.callCount.release_applied, 1);

  const items = store.listItems();
  const lifecycleItem = items.find((item) => item.item_class === 'lifecycle');
  assert.ok(lifecycleItem, 'compensation lifecycle item exists');
  assert.equal(lifecycleItem.queue_item_state, 'suppressed');
  assert.equal(lifecycleItem.supersedes_operation_id, growthOp.operation_id);
  // The original growth item permanently keeps its published effect truth.
  assert.equal(store.getItem(itemId).queue_item_state, 'published');
  assert.equal(store.getSource(binding.event_id).lifecycle_state, 'suppressed');
  // Lifecycle receipts are real receipts bound to the lifecycle operation.
  const lifecycleReceipts = store.listReceipts().filter((receipt) => receipt.receipt_operation_key !== growthOp.operation_key);
  assert.equal(lifecycleReceipts.length, 1);
  assert.equal(lifecycleReceipts[0].outcome, 'succeeded');
});

test('v0.7 total_delete is typed unsupported with zero local or upstream mutation', async (t) => {
  const { store, payloadStore, worker, lane, upstream } = await setup(t);
  const binding = makeBinding();
  const itemId = store.ingressSourceEvent(binding).item_ids[0];
  await driveStages(worker, itemId, 4); // -> published
  const growthOp = store.listOperations().find((operation) => operation.candidate_kind === 'append_experience');
  const candidateRef = growthOp.candidate_payload_ref;
  const targetRef = growthOp.projection_target_ref;

  const report = await lane.handleSourceLifecycle({
    eventId: binding.event_id,
    kind: 'total_delete',
    ref: 'deletion://1',
    revision: 1,
  });
  assert.equal(report.status, 'typed_unsupported');
  assert.equal(report.error_code, 'STEWARD_SOURCE_TOTAL_DELETE_UNSUPPORTED');
  assert.equal(store.getSource(binding.event_id).lifecycle_state, 'current');
  assert.equal(payloadStore.has(candidateRef), true);
  assert.equal(store.getItem(itemId).queue_item_state, 'published');
  assert.equal(store.exportView().tombstones.length, 0);
  assert.equal(store.listItems().some((item) => item.item_class === 'deletion'), false);
  assert.equal(upstream.callCount.release_applied, 0);
  assert.ok(targetRef);
});

test('v0.7 compatibility_delete tombstones O2 targets, erases owned body, and cannot resurrect', async (t) => {
  const { store, payloadStore, worker, lane } = await setup(t);
  const binding = makeBinding();
  const itemId = store.ingressSourceEvent(binding).item_ids[0];
  await driveStages(worker, itemId, 4);
  const growthOp = store.listOperations().find((operation) => operation.candidate_kind === 'append_experience');
  const report = await lane.compatibilityDelete({
    eventId: binding.event_id,
    deletionRef: 'compatibility-delete://2',
    lifecycleRevision: 2,
  });
  assert.equal(report.status, 'compatibility_deleted');
  assert.ok(report.erased_payload_refs.includes(growthOp.candidate_payload_ref));
  assert.ok(report.tombstoned_target_refs.includes(growthOp.projection_target_ref));
  assert.throws(
    () => payloadStore.get(growthOp.candidate_payload_ref),
    (error) => error.code === 'COMPAT_PAYLOAD_ERASED',
  );
  assert.ok(store.exportView().tombstones.some((entry) => entry.target_ref === growthOp.projection_target_ref));
  await worker.processQueueItem(itemId);
  assert.equal(payloadStore.has(growthOp.candidate_payload_ref), false);
});

test('compatibility_delete fails closed before erasing body when target tombstone is ambiguous', async (t) => {
  const { store, worker, lane, upstream } = await setup(t, { upstreamMode: 'error' });
  const binding = makeBinding();
  const itemId = store.ingressSourceEvent(binding).item_ids[0];
  upstream.setMode('normal');
  await driveStages(worker, itemId, 4); // -> published normally
  upstream.setMode('error');
  const growthOp = store.listOperations().find((operation) => operation.candidate_kind === 'append_experience');
  await assert.rejects(lane.compatibilityDelete({
    eventId: binding.event_id,
    deletionRef: 'compatibility-delete://3',
    lifecycleRevision: 3,
  }), (error) => error.code === 'COMPAT_STORE_CORRUPT');
  assert.equal(store.getSource(binding.event_id).lifecycle_state, 'current');
  assert.equal(lane.assertOperationExecutable(growthOp.operation_id), true);
});

test('§5.4/§8.2 unknown lifecycle adapter method is denied before any network call', async (t) => {
  const { adapter } = await setup(t);
  assert.throws(
    () => adapter.invokeLifecycle({
      operation: { operation_key: 'k' },
      attempt: { attempt_id: 'a', attempt_number: 1 },
      methodIdentifier: 'delete_everything_now',
      targetRefs: ['x'],
    }),
    (error) => error.code === 'COMPAT_ADAPTER_METHOD_DENIED',
  );
});
