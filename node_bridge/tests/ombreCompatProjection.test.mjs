import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalDigest, sha256Digest } from '../src/ombreCompat/canonical.mjs';
import {
  COMPAT_ADAPTER_ID,
  COMPAT_ADAPTER_VERSION,
  COMPAT_UPSTREAM_VERSION,
} from '../src/ombreCompat/constants.mjs';
import {
  createProjectionRefresher,
  readForMode,
  readVerifiedProjection,
} from '../src/ombreCompat/projectionRefresh.mjs';
import { createCompatQueueStore } from '../src/ombreCompat/queueStore.mjs';

const ADAPTER_POLICY_DIGEST = canonicalDigest({ adapter_policy: 'test-policy/v1' });
const WRONG_POLICY_DIGEST = canonicalDigest({ adapter_policy: 'other-policy/v9' });

function makeTickClock(start = '2026-07-27T00:00:00.000Z') {
  let tick = 0;
  const base = Date.parse(start);
  return () => new Date(base + (tick++) * 1000);
}

function makeWorld(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ombre-compat-projection-'));
  const queueDir = path.join(directory, 'queue');
  const projectionDir = path.join(directory, 'projection');
  const store = createCompatQueueStore({
    dir: queueDir,
    clock: makeTickClock(),
    adapterPolicyDigest: ADAPTER_POLICY_DIGEST,
  });
  store.open();
  t.after(() => {
    try { store.close(); } catch { /* already closed */ }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, queueDir, projectionDir, store };
}

// Drive one growth queue item through the whole pipeline until a succeeded
// receipt makes it published with revision_refresh_state=pending.
function driveToPublished(store, { suffix = '1' } = {}) {
  const binding = {
    event_id: `ocq_src_test${suffix}`,
    source_revision: 1,
    source_event_digest: canonicalDigest({ kind: 'final-turn', suffix }),
    lifecycle_state: 'current',
    supersedes_event_id: null,
    final_content_digest: canonicalDigest({ final_content: suffix }),
    scope_envelope_ref: `scope:test:${suffix}`,
    scope_envelope_digest: canonicalDigest({ scope: suffix }),
    sensitivity: 'personal',
  };
  const ingress = store.ingressSourceEvent(binding);
  const queue_item_id = ingress.item_ids[0];
  const stateAfterIngress = store.getItem(queue_item_id).revision_refresh_state;

  store.startCurator({
    queue_item_id,
    invocation: {
      curator_invocation_id: `cur-inv-${suffix}`,
      curator_invocation_ref: `curator://inv/${suffix}`,
      curator_model_id: 'curator-double',
      curator_model_version: '1.0.0',
      curator_protocol_version: 'compat-curator/v1',
      curator_input_digest: canonicalDigest({ curator_input: suffix }),
      tool_inventory_digest: canonicalDigest([]),
    },
  });
  const candidates = [{
    candidate_id: `cand-${suffix}`,
    candidate_kind: 'append_experience',
    candidate_payload_ref: `payload:${suffix}`,
    candidate_payload_digest: canonicalDigest({ payload: suffix }),
    projection_target: 'ombre_local_projection',
    deletion_domain: 'compat_payload_default',
    supersedes_operation_id: null,
  }];
  store.completeCurator({
    queue_item_id,
    curator_output_digest: canonicalDigest({ curator_output: suffix }),
    candidates,
  });
  store.startReviewer({
    queue_item_id,
    invocation: {
      reviewer_invocation_id: `rev-inv-${suffix}`,
      reviewer_invocation_ref: `reviewer://inv/${suffix}`,
      reviewer_model_id: 'reviewer-double',
      reviewer_model_version: '1.0.0',
      reviewer_protocol_version: 'compat-reviewer/v1',
      reviewer_input_digest: canonicalDigest({ reviewer_input: suffix }),
      tool_inventory_digest: canonicalDigest([]),
    },
  });
  store.completeReviewer({
    queue_item_id,
    decision: 'accept',
    reviewer_revision: 1,
    reviewer_output_digest: canonicalDigest({ reviewer_output: suffix }),
    final_candidates: candidates,
  });
  const authorized = store.applyGateDecision({
    queue_item_id,
    gate_provenance: {
      gate_policy_version: 'compat-gate/v1',
      adapter_policy_digest: ADAPTER_POLICY_DIGEST,
      gate_reason_code: null,
      evaluator_id: 'gate-double',
    },
    decisions: [{ decision: 'authorized', candidate: candidates[0] }],
    item_outcome: 'authorized',
  });
  const operation = authorized[0].operation;
  const adapter_request_digest = canonicalDigest({ adapter_request: suffix });
  const attempt = store.createDispatchIntent({
    operation_id: operation.operation_id,
    method_identifier: 'append_experience',
    adapter_request_digest,
  });
  const receipt = {
    receipt_id: `rcpt-${suffix}`,
    receipt_operation_key: operation.operation_key,
    receipt_attempt_id: attempt.attempt_id,
    source_event_id: binding.event_id,
    source_revision: binding.source_revision,
    source_event_digest: binding.source_event_digest,
    candidate_payload_ref: candidates[0].candidate_payload_ref,
    candidate_payload_digest: candidates[0].candidate_payload_digest,
    projection_kind: 'append_experience',
    projection_target: 'ombre_local_projection',
    adapter_id: COMPAT_ADAPTER_ID,
    adapter_version: COMPAT_ADAPTER_VERSION,
    adapter_policy_digest: ADAPTER_POLICY_DIGEST,
    upstream_version: COMPAT_UPSTREAM_VERSION,
    request_digest: adapter_request_digest,
    outcome: 'succeeded',
    target_projection_ref: `ombre://item/${suffix}`,
    target_revision_before: 0,
    target_revision_after: 1,
    upstream_evidence_ref: `evidence://${suffix}`,
    issued_at: new Date().toISOString(),
    issuer_id: 'test-double',
  };
  store.recordReceipt({ operation_id: operation.operation_id, receipt });
  const stateAfterReceipt = store.getItem(queue_item_id).revision_refresh_state;
  return { queue_item_id, operation, attempt, receipt, stateAfterIngress, stateAfterReceipt };
}

function fakeResolver(items) {
  const calls = [];
  const resolver = (context) => {
    calls.push(context);
    return { items };
  };
  resolver.calls = calls;
  return resolver;
}

function failingResolver(error) {
  return () => {
    throw error;
  };
}

// Intentionally unsorted input; the snapshot must order items by item_ref.
function sampleItems(tag) {
  return [
    {
      item_ref: 'ombre://item/2',
      item_digest: canonicalDigest({ item: `${tag}:2` }),
      source_operation_key: canonicalDigest({ op: `${tag}:2` }),
      layer: 'experience',
      body: { text: `second ${tag}` },
    },
    {
      item_ref: 'ombre://item/1',
      item_digest: canonicalDigest({ item: `${tag}:1` }),
      source_operation_key: canonicalDigest({ op: `${tag}:1` }),
      layer: 'experience',
      body: { text: `first ${tag}` },
    },
  ];
}

function readLogEntries(queueDir) {
  return fs.readFileSync(path.join(queueDir, 'queue-events.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function revisionPath(projectionDir, projectionRevision) {
  return path.join(projectionDir, 'revisions', `${projectionRevision.slice('sha256:'.length)}.json`);
}

function currentManifestPath(projectionDir) {
  const pointer = JSON.parse(fs.readFileSync(path.join(projectionDir, 'pointer.json'), 'utf8'));
  return path.join(projectionDir, 'manifests', pointer.manifest_file);
}

function flipOneByte(target) {
  const buffer = fs.readFileSync(target);
  const index = Math.floor(buffer.length / 2);
  buffer[index] ^= 0x01; // eslint-disable-line no-bitwise
  fs.writeFileSync(target, buffer);
}

function publishOne(world, { queueItemId, receiptId, cursor, items }) {
  const resolver = fakeResolver(items);
  const refresher = createProjectionRefresher({
    projectionDir: world.projectionDir,
    store: world.store,
    resolver,
    clock: makeTickClock(),
  });
  const result = refresher.refresh({
    queue_item_id: queueItemId,
    reason: 'receipt_succeeded',
    last_projection_receipt_id: receiptId,
    source_cursor: cursor,
  });
  return { resolver, refresher, result };
}

test('refresh publishes an immutable verified graph and advances refresh state', (t) => {
  const world = makeWorld(t);
  const { queueDir, projectionDir, store } = world;
  const driven = driveToPublished(store);
  assert.equal(driven.stateAfterIngress, 'not_required');
  assert.equal(driven.stateAfterReceipt, 'pending');

  const { result } = publishOne(world, {
    queueItemId: driven.queue_item_id,
    receiptId: driven.receipt.receipt_id,
    cursor: 'cursor:1',
    items: sampleItems('a'),
  });
  assert.equal(result.status, 'published');
  assert.match(result.projection_revision, /^sha256:[0-9a-f]{64}$/);

  // File graph: pointer -> manifest -> revision, all durable and regular.
  const pointerPath = path.join(projectionDir, 'pointer.json');
  const pointer = JSON.parse(fs.readFileSync(pointerPath, 'utf8'));
  assert.equal(pointer.schema_version, 'compat-projection-pointer/v1');
  assert.match(pointer.manifest_file, /^[0-9a-f]{64}\.json$/);
  const manifestPath = path.join(projectionDir, 'manifests', pointer.manifest_file);
  const revision = revisionPath(projectionDir, result.projection_revision);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  // §5.6 minimal manifest field set, all present.
  for (const field of [
    'projection_revision',
    'content_digest',
    'source_cursor',
    'last_projection_receipt_id',
    'adapter_policy_digest',
    'upstream_version',
    'created_at',
  ]) {
    assert.ok(Object.hasOwn(manifest, field), `manifest missing §5.6 field ${field}`);
  }
  assert.equal(manifest.projection_revision, result.projection_revision);
  assert.equal(manifest.revision_file, path.basename(revision));
  assert.equal(manifest.last_projection_receipt_id, driven.receipt.receipt_id);
  assert.equal(manifest.adapter_policy_digest, ADAPTER_POLICY_DIGEST);
  assert.equal(manifest.upstream_version, COMPAT_UPSTREAM_VERSION);

  const snapshot = JSON.parse(fs.readFileSync(revision, 'utf8'));
  assert.equal(snapshot.schema_version, 'compat-projection/v1');
  assert.equal(snapshot.projection_revision, result.projection_revision);
  assert.deepEqual(
    snapshot.items.map((item) => item.item_ref),
    ['ombre://item/1', 'ombre://item/2'],
  );

  // Store integration: building -> published, snapshot recorded, operation
  // gains the projection revision.
  const item = store.getItem(driven.queue_item_id);
  assert.equal(item.revision_refresh_state, 'published');
  assert.equal(item.projection_revision, result.projection_revision);
  assert.equal(
    store.getOperation(driven.operation.operation_id).projection_revision,
    result.projection_revision,
  );
  const snapshots = store.exportView().snapshots;
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].projection_revision, result.projection_revision);
  const refreshEvents = readLogEntries(queueDir).filter((entry) => entry.type === 'refresh_state');
  assert.deepEqual(
    refreshEvents.map((entry) => entry.revision_refresh_state),
    ['building', 'published'],
  );

  // File permissions match the O1 projection discipline.
  assert.equal(fs.statSync(pointerPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(manifestPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(revision).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(projectionDir, 'revisions')).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(projectionDir, 'manifests')).mode & 0o777, 0o700);

  // Both modes read the same verified revision.
  const lite = readForMode({ projectionDir, mode: 'lite' });
  const full = readForMode({ projectionDir, mode: 'full' });
  assert.equal(lite.status, 'ok');
  assert.equal(full.status, 'ok');
  assert.equal(lite.projection_revision, result.projection_revision);
  assert.equal(lite.projection_revision, full.projection_revision);
  assert.deepEqual(lite.snapshot, full.snapshot);
});

test('a second refresh publishes a new revision without touching old immutable files', (t) => {
  const world = makeWorld(t);
  const { projectionDir } = world;
  const driven = driveToPublished(world.store);
  const first = publishOne(world, {
    queueItemId: driven.queue_item_id,
    receiptId: driven.receipt.receipt_id,
    cursor: 'cursor:1',
    items: sampleItems('a'),
  });
  assert.equal(first.result.status, 'published');
  const firstManifestPath = currentManifestPath(projectionDir);
  const firstRevisionPath = revisionPath(projectionDir, first.result.projection_revision);
  const firstManifestBytes = fs.readFileSync(firstManifestPath);
  const firstRevisionBytes = fs.readFileSync(firstRevisionPath);

  const second = publishOne(world, {
    queueItemId: driven.queue_item_id,
    receiptId: driven.receipt.receipt_id,
    cursor: 'cursor:2',
    items: sampleItems('b'),
  });
  assert.equal(second.result.status, 'published');
  assert.notEqual(second.result.projection_revision, first.result.projection_revision);

  // New revision + manifest files exist; old files are byte-identical.
  const secondManifestPath = currentManifestPath(projectionDir);
  assert.notEqual(secondManifestPath, firstManifestPath);
  assert.ok(fs.existsSync(revisionPath(projectionDir, second.result.projection_revision)));
  assert.ok(firstManifestBytes.equals(fs.readFileSync(firstManifestPath)));
  assert.ok(firstRevisionBytes.equals(fs.readFileSync(firstRevisionPath)));

  // Readers now land on the second verified revision.
  const lite = readForMode({ projectionDir, mode: 'lite' });
  assert.equal(lite.status, 'ok');
  assert.equal(lite.projection_revision, second.result.projection_revision);
});

test('refresh performs a pure read: no store mutation beyond refresh_state and snapshot events', (t) => {
  const world = makeWorld(t);
  const { queueDir } = world;
  const driven = driveToPublished(world.store);
  const before = readLogEntries(queueDir).map((entry) => entry.type);

  const resolver = fakeResolver(sampleItems('a'));
  const refresher = createProjectionRefresher({
    projectionDir: world.projectionDir,
    store: world.store,
    resolver,
    clock: makeTickClock(),
  });
  const result = refresher.refresh({
    queue_item_id: driven.queue_item_id,
    reason: 'receipt_succeeded',
    last_projection_receipt_id: driven.receipt.receipt_id,
    source_cursor: 'cursor:1',
  });
  assert.equal(result.status, 'published');

  // The resolver was invoked exactly once, as a context-only pure read.
  assert.equal(resolver.calls.length, 1);
  assert.deepEqual(resolver.calls[0], {
    queue_item_id: driven.queue_item_id,
    reason: 'receipt_succeeded',
    last_projection_receipt_id: driven.receipt.receipt_id,
    source_cursor: 'cursor:1',
  });

  // Nothing else touched the queue: the only appended event types are the
  // refresh lane's own refresh_state / snapshot_recorded.
  const after = readLogEntries(queueDir).map((entry) => entry.type);
  const appended = after.slice(before.length);
  assert.deepEqual([...new Set(appended)].sort(), ['refresh_state', 'snapshot_recorded']);

  // The snapshot content is exactly the resolved items, canonically sorted.
  assert.deepEqual(
    result.snapshot.items.map((item) => item.item_ref),
    ['ombre://item/1', 'ombre://item/2'],
  );
});

test('resolver failure marks the refresh failed without throwing and writes no graph files', (t) => {
  const world = makeWorld(t);
  const driven = driveToPublished(world.store);
  const refresher = createProjectionRefresher({
    projectionDir: world.projectionDir,
    store: world.store,
    resolver: failingResolver(new Error('resolver exploded')),
    clock: makeTickClock(),
  });
  const result = refresher.refresh({
    queue_item_id: driven.queue_item_id,
    reason: 'receipt_succeeded',
    last_projection_receipt_id: driven.receipt.receipt_id,
    source_cursor: 'cursor:1',
  });
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /resolver exploded/);
  assert.equal(world.store.getItem(driven.queue_item_id).revision_refresh_state, 'failed');
  const refreshEvents = readLogEntries(world.queueDir).filter((entry) => entry.type === 'refresh_state');
  assert.deepEqual(
    refreshEvents.map((entry) => entry.revision_refresh_state),
    ['building', 'failed'],
  );
  assert.ok(!fs.existsSync(path.join(world.projectionDir, 'pointer.json')));
});

test('fault before pointer swap keeps the old pointer and both modes keep reading the old revision', (t) => {
  const world = makeWorld(t);
  const { projectionDir } = world;
  const driven = driveToPublished(world.store);
  const first = publishOne(world, {
    queueItemId: driven.queue_item_id,
    receiptId: driven.receipt.receipt_id,
    cursor: 'cursor:1',
    items: sampleItems('a'),
  });
  assert.equal(first.result.status, 'published');
  const pointerPath = path.join(projectionDir, 'pointer.json');
  const pointerBefore = fs.readFileSync(pointerPath, 'utf8');
  assert.equal(readForMode({ projectionDir, mode: 'lite' }).projection_revision, first.result.projection_revision);

  const crashing = createProjectionRefresher({
    projectionDir,
    store: world.store,
    resolver: fakeResolver(sampleItems('b')),
    clock: makeTickClock(),
    faultInjector(stage) {
      if (stage === 'before_pointer_swap') throw new Error('injected crash');
    },
  });
  const failed = crashing.refresh({
    queue_item_id: driven.queue_item_id,
    reason: 'receipt_succeeded',
    last_projection_receipt_id: driven.receipt.receipt_id,
    source_cursor: 'cursor:2',
  });
  assert.equal(failed.status, 'failed');
  assert.match(failed.reason, /injected crash/);
  assert.equal(world.store.getItem(driven.queue_item_id).revision_refresh_state, 'failed');

  // The pointer never swapped; Lite and Full both still read the old verified
  // revision with status ok (no fallback needed, no split).
  assert.equal(fs.readFileSync(pointerPath, 'utf8'), pointerBefore);
  const lite = readForMode({ projectionDir, mode: 'lite' });
  const full = readForMode({ projectionDir, mode: 'full' });
  assert.equal(lite.status, 'ok');
  assert.equal(full.status, 'ok');
  assert.equal(lite.projection_revision, first.result.projection_revision);
  assert.equal(lite.projection_revision, full.projection_revision);
});

test('corrupt current snapshot falls back to the last verified common revision in both modes; '
  + 'corrupting last_verified omits in both', (t) => {
  const world = makeWorld(t);
  const { projectionDir } = world;
  const driven = driveToPublished(world.store);
  const first = publishOne(world, {
    queueItemId: driven.queue_item_id,
    receiptId: driven.receipt.receipt_id,
    cursor: 'cursor:1',
    items: sampleItems('a'),
  });
  assert.equal(first.result.status, 'published');
  // Successful read pins v1 as the last verified common revision.
  assert.equal(readForMode({ projectionDir, mode: 'lite' }).status, 'ok');

  const second = publishOne(world, {
    queueItemId: driven.queue_item_id,
    receiptId: driven.receipt.receipt_id,
    cursor: 'cursor:2',
    items: sampleItems('b'),
  });
  assert.equal(second.result.status, 'published');
  // No successful read of v2 yet: last_verified still points at v1.

  flipOneByte(revisionPath(projectionDir, second.result.projection_revision));
  const lite = readForMode({ projectionDir, mode: 'lite' });
  const full = readForMode({ projectionDir, mode: 'full' });
  assert.equal(lite.status, 'fallback');
  assert.equal(full.status, 'fallback');
  assert.equal(lite.projection_revision, first.result.projection_revision);
  assert.equal(lite.projection_revision, full.projection_revision);
  assert.deepEqual(lite.snapshot, full.snapshot);

  // Corrupt the fallback bookkeeping too: both modes omit Ombre together.
  fs.writeFileSync(path.join(projectionDir, 'last_verified.json'), '{corrupt');
  const liteOmit = readForMode({ projectionDir, mode: 'lite' });
  const fullOmit = readForMode({ projectionDir, mode: 'full' });
  assert.equal(liteOmit.status, 'omit');
  assert.equal(fullOmit.status, 'omit');
});

test('tampered manifest is rejected by the digest chain and both modes fall back together', (t) => {
  const world = makeWorld(t);
  const { projectionDir } = world;
  const driven = driveToPublished(world.store);
  const first = publishOne(world, {
    queueItemId: driven.queue_item_id,
    receiptId: driven.receipt.receipt_id,
    cursor: 'cursor:1',
    items: sampleItems('a'),
  });
  assert.equal(readForMode({ projectionDir, mode: 'full' }).status, 'ok');
  const second = publishOne(world, {
    queueItemId: driven.queue_item_id,
    receiptId: driven.receipt.receipt_id,
    cursor: 'cursor:2',
    items: sampleItems('b'),
  });
  assert.equal(second.result.status, 'published');

  flipOneByte(currentManifestPath(projectionDir));
  const verified = readVerifiedProjection({ projectionDir });
  assert.equal(verified.status, 'invalid');
  assert.match(verified.reason, /manifest_digest_mismatch/);
  for (const mode of ['lite', 'full']) {
    const result = readForMode({ projectionDir, mode });
    assert.equal(result.status, 'fallback');
    assert.equal(result.projection_revision, first.result.projection_revision);
  }
});

test('adapter/upstream pin drift fails closed in both modes', (t) => {
  const world = makeWorld(t);
  const { projectionDir } = world;
  const driven = driveToPublished(world.store);
  const first = publishOne(world, {
    queueItemId: driven.queue_item_id,
    receiptId: driven.receipt.receipt_id,
    cursor: 'cursor:1',
    items: sampleItems('a'),
  });
  assert.equal(first.result.status, 'published');
  const pins = {
    expectedAdapterPolicyDigest: ADAPTER_POLICY_DIGEST,
    expectedUpstreamVersion: COMPAT_UPSTREAM_VERSION,
  };
  assert.equal(readForMode({ projectionDir, mode: 'lite', ...pins }).status, 'ok');

  // Pin drift: the reader is pinned to a different adapter policy than the
  // projection was built with. The fallback path enforces the same pins, so
  // both modes omit instead of silently consuming drifted content.
  for (const mode of ['lite', 'full']) {
    const drifted = readForMode({
      projectionDir,
      mode,
      expectedAdapterPolicyDigest: WRONG_POLICY_DIGEST,
      expectedUpstreamVersion: COMPAT_UPSTREAM_VERSION,
    });
    assert.equal(drifted.status, 'omit');
  }
  const upstreamDrift = readVerifiedProjection({
    projectionDir,
    expectedUpstreamVersion: 'deadbeef'.repeat(8),
  });
  assert.equal(upstreamDrift.status, 'invalid');
  assert.match(upstreamDrift.reason, /upstream_version_pin_mismatch/);

  // A correctly pinned read still succeeds afterwards; the failed drifted
  // reads did not corrupt any state.
  const recovered = readForMode({ projectionDir, mode: 'full', ...pins });
  assert.equal(recovered.status, 'ok');
  assert.equal(recovered.projection_revision, first.result.projection_revision);
});

test('a pointer to an unverified manifest never advances one mode ahead of the other', (t) => {
  const world = makeWorld(t);
  const { projectionDir } = world;
  const driven = driveToPublished(world.store);
  const first = publishOne(world, {
    queueItemId: driven.queue_item_id,
    receiptId: driven.receipt.receipt_id,
    cursor: 'cursor:1',
    items: sampleItems('a'),
  });
  assert.equal(readForMode({ projectionDir, mode: 'lite' }).status, 'ok');
  const second = publishOne(world, {
    queueItemId: driven.queue_item_id,
    receiptId: driven.receipt.receipt_id,
    cursor: 'cursor:2',
    items: sampleItems('b'),
  });
  assert.equal(second.result.status, 'published');

  // Simulate an unverified writer: pointer references the new manifest but
  // with a digest that was never verified against it.
  const pointerPath = path.join(projectionDir, 'pointer.json');
  const pointer = JSON.parse(fs.readFileSync(pointerPath, 'utf8'));
  fs.writeFileSync(pointerPath, `${JSON.stringify({
    ...pointer,
    manifest_digest: sha256Digest('never-verified'),
  }, null, 2)}\n`);

  const lite = readForMode({ projectionDir, mode: 'lite' });
  const full = readForMode({ projectionDir, mode: 'full' });
  assert.equal(lite.status, 'fallback');
  assert.equal(full.status, 'fallback');
  assert.equal(lite.projection_revision, first.result.projection_revision);
  assert.equal(lite.projection_revision, full.projection_revision);

  // Without a verifiable last common revision both sides omit, never split.
  fs.writeFileSync(path.join(projectionDir, 'last_verified.json'), '{corrupt');
  assert.equal(readForMode({ projectionDir, mode: 'lite' }).status, 'omit');
  assert.equal(readForMode({ projectionDir, mode: 'full' }).status, 'omit');
});

test('missing projection graph omits Ombre in both modes instead of throwing', (t) => {
  const world = makeWorld(t);
  const { projectionDir } = world;
  const verified = readVerifiedProjection({ projectionDir });
  assert.equal(verified.status, 'invalid');
  const lite = readForMode({ projectionDir, mode: 'lite' });
  const full = readForMode({ projectionDir, mode: 'full' });
  assert.equal(lite.status, 'omit');
  assert.equal(full.status, 'omit');
});
