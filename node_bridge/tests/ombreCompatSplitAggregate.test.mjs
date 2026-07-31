import test from 'node:test';
import assert from 'node:assert/strict';

import { canonicalDigest } from '../src/ombreCompat/canonical.mjs';
import {
  computeChildSetDigest,
  deriveSplitAggregate,
  verifySplitAggregate,
} from '../src/ombreCompat/stateMachine.mjs';

const AT = '2026-07-30T00:00:00.000Z';

function child(id, operationState, overrides = {}) {
  return {
    child_operation_id: id,
    operation_state: operationState,
    latest_attempt_number: null,
    latest_receipt_digest: null,
    lifecycle_state: null,
    lifecycle_revision: null,
    ...overrides,
  };
}

test('child-set digest is invariant across permutations and uses raw UTF-8 byte order', () => {
  const children = [child('é', 'published'), child('Z', 'published'), child('a', 'published')];
  const first = computeChildSetDigest(children);
  const second = computeChildSetDigest([children[2], children[0], children[1]]);
  assert.equal(first.digest, second.digest);
  assert.deepEqual(first.records.map((record) => record.child_operation_id), ['Z', 'a', 'é']);
  assert.equal(first.digest, canonicalDigest(first.records));
});

test('six child keys are mandatory, explicit null is preserved, and duplicate IDs are rejected', () => {
  const record = child('op-1', 'authorized');
  assert.deepEqual(Object.keys(computeChildSetDigest([record]).records[0]).sort(), [
    'child_operation_id', 'latest_attempt_number', 'latest_receipt_digest',
    'lifecycle_revision', 'lifecycle_state', 'operation_state',
  ]);
  assert.equal(computeChildSetDigest([record]).records[0].latest_attempt_number, null);
  assert.throws(
    () => computeChildSetDigest([record, { ...record, operation_state: 'published' }]),
    (error) => error.code === 'COMPAT_DUPLICATE_CHILD_OPERATION_ID',
  );
  const missing = { ...record };
  delete missing.latest_receipt_digest;
  assert.throws(
    () => computeChildSetDigest([missing]),
    (error) => error.code === 'COMPAT_AGGREGATE_UNCLASSIFIED',
  );
});

test('aggregate is published only when every child is published; mixed terminal outcome is partial', () => {
  const published = deriveSplitAggregate({
    queue_item_id: 'item-1',
    children: [child('a', 'published'), child('b', 'published')],
    materialized_at: AT,
  });
  assert.equal(published.aggregate_state, 'published');
  const mixed = deriveSplitAggregate({
    queue_item_id: 'item-1',
    children: [child('a', 'published'), child('b', 'failed'), child('c', 'rejected')],
    materialized_at: AT,
  });
  assert.equal(mixed.aggregate_state, 'partially_published');
});

test('ambiguous/reconciling and typed lifecycle mixtures cannot be masked by successful children', () => {
  const uncertain = deriveSplitAggregate({
    queue_item_id: 'item-2',
    children: [child('a', 'published'), child('b', 'ambiguous')],
    materialized_at: AT,
  });
  assert.equal(uncertain.aggregate_state, 'reconciling');
  const lifecycle = deriveSplitAggregate({
    queue_item_id: 'item-2',
    children: [
      child('a', 'published', { lifecycle_state: 'withdrawn', lifecycle_revision: 2 }),
      child('b', 'published', { lifecycle_state: 'suppressed', lifecycle_revision: 3 }),
    ],
    materialized_at: AT,
  });
  assert.equal(lifecycle.aggregate_state, 'cancellation_mixed');
});

test('materialized view is verified from the child ledger and rejects stale digest/count/version', () => {
  const children = [child('a', 'published'), child('b', 'published')];
  const materialized = deriveSplitAggregate({
    queue_item_id: 'item-3',
    children,
    materialized_at: AT,
  });
  assert.deepEqual(verifySplitAggregate(materialized, children), materialized);
  for (const patch of [
    { child_set_digest: `sha256:${'0'.repeat(64)}` },
    { child_count: 3 },
    { aggregate_algorithm_version: 'old' },
  ]) {
    assert.throws(
      () => verifySplitAggregate({ ...materialized, ...patch }, children),
      (error) => error.code === 'COMPAT_AGGREGATE_UNCLASSIFIED',
    );
  }
  assert.throws(
    () => verifySplitAggregate({ ...materialized, extra: null }, children),
    (error) => error.code === 'COMPAT_AGGREGATE_UNCLASSIFIED',
  );
});
