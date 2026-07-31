// Ombre O2 restart / crash-recovery tests at pipeline level (§9.3.5, §9.3.9,
// §12.7-10, §13.6): durable intent-before-effect, materialized state always
// yields to durable receipts, and no crash ever causes a double mutation.

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
import { createProjectionRefresher } from '../src/ombreCompat/projectionRefresh.mjs';
import { createFakeUpstreamOmbre } from './helpers/fakeUpstreamOmbre.mjs';

const FIXED_CLOCK = () => new Date('2026-07-27T00:00:00.000Z');
const ADAPTER_POLICY = adapterPolicyDigest();

function tempRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocq-recovery-'));
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

async function makeStack(t, root, upstream) {
  const store = createCompatQueueStore({
    dir: path.join(root, 'queue'),
    clock: FIXED_CLOCK,
    adapterPolicyDigest: ADAPTER_POLICY,
  });
  store.open();
  const payloadStore = createCompatPayloadStore({ dir: path.join(root, 'payloads') });
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
  return { store, payloadStore, adapter, worker };
}

test('§12.7 crash before durable intent: item stays authorized and dispatches cleanly after restart', async (t) => {
  const root = tempRoot(t);
  const upstream = createFakeUpstreamOmbre();
  await upstream.start();
  t.after(async () => upstream.close());

  let itemId;
  let operationId;
  {
    const { store, payloadStore, worker } = await makeStack(t, root, upstream);
    itemId = store.ingressSourceEvent(makeBinding()).item_ids[0];
    await worker.processQueueItem(itemId);
    await worker.processQueueItem(itemId);
    await worker.processQueueItem(itemId); // gate -> authorized
    operationId = store.getItem(itemId).operation_ids[0];
    assert.equal(store.getItem(itemId).queue_item_state, 'authorized');
    store.close(); // simulated crash before any dispatch intent
    payloadStore.close();
  }
  {
    const { store, payloadStore, worker } = await makeStack(t, root, upstream);
    t.after(() => { try { store.close(); } catch {} });
    // Restart inference: no durable intent -> still authorized, never
    // inferred as dispatched (§9.3.5 row 1).
    assert.equal(store.getItem(itemId).queue_item_state, 'authorized');
    assert.equal(store.listAttempts().length, 0);
    await worker.processQueueItem(itemId);
    assert.equal(store.getItem(itemId).queue_item_state, 'published');
    assert.equal(upstream.callCount.hold_applied, 1);
  }
});

test('§12.8/§9.3.9 crash after durable intent, before adapter effect: ambiguous, adapter count does not grow', async (t) => {
  const root = tempRoot(t);
  const upstream = createFakeUpstreamOmbre();
  await upstream.start();
  t.after(async () => upstream.close());

  let itemId;
  let operationId;
  {
    const { store, payloadStore, worker, adapter } = await makeStack(t, root, upstream);
    itemId = store.ingressSourceEvent(makeBinding()).item_ids[0];
    await worker.processQueueItem(itemId);
    await worker.processQueueItem(itemId);
    await worker.processQueueItem(itemId);
    // Commit the durable intent, then "crash" before the adapter is invoked.
    const operation = store.getItem(itemId).operation_ids[0];
    operationId = operation;
    const prepared = adapter.prepareGrowthRequest({
      operation: store.getOperation(operationId),
      attemptNumber: 1,
      methodIdentifier: 'append_experience',
      payloadBody: '一段真实的共同经历。',
    });
    store.createDispatchIntent({
      operation_id: operationId,
      method_identifier: 'append_experience',
      adapter_request_digest: prepared.request_digest,
    });
    store.close();
    payloadStore.close();
  }
  {
    const { store, adapter } = await makeStack(t, root, upstream);
    t.after(() => { try { store.close(); } catch {} });
    const item = store.getItem(itemId);
    assert.equal(item.queue_item_state, 'ambiguous');
    const attempt = store.listAttempts()[0];
    assert.equal(attempt.adapter_attempt_state, 'ambiguous');
    assert.equal(upstream.callCount.hold, 0, 'adapter was never invoked before the crash');

    // Reconciliation is the only way forward; it must not re-dispatch.
    const reconciler = createReconciler({ store, adapter, clock: FIXED_CLOCK });
    const outcome = await reconciler.reconcileOperation({ operation_id: operationId });
    assert.equal(outcome.disposition, 'observed_not_applied');
    assert.equal(upstream.callCount.hold, 0, 'reconciliation is read-only');
    assert.equal(store.getOperation(operationId).state, 'failed');
  }
});

test('§12.10 ambiguous restart stays ambiguous; a second restart never replays the mutation', async (t) => {
  const root = tempRoot(t);
  const upstream = createFakeUpstreamOmbre();
  await upstream.start();
  t.after(async () => upstream.close());
  upstream.setMode('drop');

  let itemId;
  let requestsAtCrash;
  {
    const { store, payloadStore, worker } = await makeStack(t, root, upstream);
    itemId = store.ingressSourceEvent(makeBinding()).item_ids[0];
    await worker.processQueueItem(itemId);
    await worker.processQueueItem(itemId);
    await worker.processQueueItem(itemId);
    await worker.processQueueItem(itemId); // dispatch -> drop -> ambiguous
    assert.equal(store.getItem(itemId).queue_item_state, 'ambiguous');
    requestsAtCrash = upstream.requests.length;
    store.close();
    payloadStore.close();
  }
  {
    const { store, payloadStore } = await makeStack(t, root, upstream);
    // First restart: ambiguous persists (§9.3.7).
    assert.equal(store.getItem(itemId).queue_item_state, 'ambiguous');
    store.close();
    payloadStore.close();
  }
  {
    const { store } = await makeStack(t, root, upstream);
    t.after(() => { try { store.close(); } catch {} });
    assert.equal(store.getItem(itemId).queue_item_state, 'ambiguous');
    const attempts = store.listAttempts();
    assert.equal(attempts.length, 1, 'restart never creates a new mutation attempt');
    assert.equal(
      upstream.requests.length,
      requestsAtCrash,
      'no new upstream call of any kind happened across the restarts',
    );
  }
});

test('§9.3.5 receipt persisted but view not updated: restart restores published, never redispatches', async (t) => {
  const root = tempRoot(t);
  const upstream = createFakeUpstreamOmbre();
  await upstream.start();
  t.after(async () => upstream.close());

  let itemId;
  {
    const { store, payloadStore, worker } = await makeStack(t, root, upstream);
    itemId = store.ingressSourceEvent(makeBinding()).item_ids[0];
    await worker.processQueueItem(itemId);
    await worker.processQueueItem(itemId);
    await worker.processQueueItem(itemId);
    await worker.processQueueItem(itemId); // dispatch + receipt persisted
    assert.equal(store.getItem(itemId).queue_item_state, 'published');
    store.close(); // "crash" with the materialized view already durable in the log
    payloadStore.close();
  }
  {
    const { store, payloadStore, worker } = await makeStack(t, root, upstream);
    t.after(() => { try { store.close(); } catch {} });
    const item = store.getItem(itemId);
    assert.equal(item.queue_item_state, 'published');
    assert.equal(item.revision_refresh_state, 'pending', 'refresh resumes independently');
    assert.equal(upstream.callCount.hold_applied, 1);
    await worker.processQueueItem(itemId); // refresh resumes
    assert.equal(store.getItem(itemId).revision_refresh_state, 'published');
    assert.equal(upstream.callCount.hold_applied, 1, 'no re-dispatch after restart');
  }
});

test('§9.3.5 refresh building lease never survives restart', async (t) => {
  const root = tempRoot(t);
  const upstream = createFakeUpstreamOmbre();
  await upstream.start();
  t.after(async () => upstream.close());

  let itemId;
  {
    const { store, payloadStore, worker } = await makeStack(t, root, upstream);
    itemId = store.ingressSourceEvent(makeBinding()).item_ids[0];
    await worker.processQueueItem(itemId);
    await worker.processQueueItem(itemId);
    await worker.processQueueItem(itemId);
    await worker.processQueueItem(itemId);
    store.setRefreshState({ queue_item_id: itemId, revision_refresh_state: 'building' });
    store.close(); // crash mid-build
    payloadStore.close();
  }
  {
    const { store } = await makeStack(t, root, upstream);
    t.after(() => { try { store.close(); } catch {} });
    assert.equal(store.getItem(itemId).revision_refresh_state, 'pending', 'building lease discarded at restart');
  }
});
