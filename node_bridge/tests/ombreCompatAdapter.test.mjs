import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GROWTH_METHOD_MANIFEST,
  LIFECYCLE_METHOD_MANIFEST,
  adapterPolicyDigest,
  resolveGrowthMethod,
  resolveLifecycleMethod,
} from '../src/ombreCompat/adapterPolicy.mjs';
import { canonicalDigest } from '../src/ombreCompat/canonical.mjs';
import { createStewardAdapter } from '../src/ombreCompat/stewardAdapter.mjs';
import { createFakeUpstreamOmbre } from './helpers/fakeUpstreamOmbre.mjs';

function operation(overrides = {}) {
  return {
    operation_id: 'ocq_op_0123456789abcdef01234567',
    operation_key: canonicalDigest('operation'),
    source_event_id: 'ocq_src_0123456789abcdef0123456789abcdef',
    source_revision: 3,
    source_event_digest: canonicalDigest('source'),
    candidate_payload_ref: 'compat-payload:test',
    candidate_payload_digest: canonicalDigest('payload'),
    projection_target: 'ombre_local_projection',
    scope_envelope_digest: canonicalDigest('scope'),
    sensitivity: 'standard',
    deletion_domain: 'compat_payload_default',
    adapter_policy_digest: adapterPolicyDigest(),
    ...overrides,
  };
}

async function fixture(t) {
  const server = createFakeUpstreamOmbre();
  await server.start();
  t.after(() => server.close());
  return {
    server,
    adapter: createStewardAdapter({
      ...server.adapterOptions(),
      timeoutMs: 80,
    }),
  };
}

test('policy exposes only five append methods plus suppress/tombstone and typed unsupported total_delete', () => {
  assert.deepEqual(GROWTH_METHOD_MANIFEST.map((row) => row.steward_method), [
    'append_experience',
    'append_association',
    'append_low_impact_preference_observation',
    'append_i_observation_candidate',
    'append_correction_or_supersession_observation',
  ]);
  assert.deepEqual(LIFECYCLE_METHOD_MANIFEST.map((row) => [row.steward_method, row.disposition]), [
    ['suppress', 'allow'],
    ['tombstone', 'allow'],
    ['total_delete', 'typed_unsupported'],
  ]);
  assert.equal(resolveGrowthMethod('hold'), null);
  assert.equal(resolveLifecycleMethod('release'), null);
});

test('authenticated health proves the four-part patched identity', async (t) => {
  const { adapter, server } = await fixture(t);
  assert.deepEqual(await adapter.verifyUpstreamVersion(), server.identity);
});

test('five append methods use the loopback Steward API and return normalized receipts', async (t) => {
  const { adapter, server } = await fixture(t);
  const methods = GROWTH_METHOD_MANIFEST.map((row) => row.internal_method);
  for (const [index, method] of methods.entries()) {
    const op = operation({
      operation_id: `ocq_op_${String(index).padStart(24, '0')}`,
      operation_key: canonicalDigest(method),
      endpoint_refs: [
        'ombre-steward://target/experience/left',
        'ombre-steward://target/experience/right',
      ],
      supersedes_target_ref: 'ombre-steward://target/experience/left',
    });
    const prepared = adapter.prepareGrowthRequest({
      operation: op,
      attemptNumber: 1,
      methodIdentifier: method,
      payloadBody: `body-${method}`,
    });
    const receipt = await adapter.invokeGrowth({
      operation: op,
      attempt: { attempt_id: `ocq_attempt_${String(index).padStart(24, '0')}`, attempt_number: 1 },
      methodIdentifier: method,
      payloadBody: `body-${method}`,
      prepared,
    });
    assert.equal(receipt.outcome, 'succeeded');
    assert.equal(receipt.receipt_operation_key, op.operation_key);
    assert.match(receipt.target_projection_ref, /^ombre-steward:\/\/target\//);
  }
  assert.equal(server.callCount.mutate_applied, 5);
  assert.equal(server.requests.some((request) => ['hold', 'release'].includes(request.method)), false);
});

test('unknown method fails closed before network and total_delete stays typed unsupported', async (t) => {
  const { adapter, server } = await fixture(t);
  assert.throws(() => adapter.prepareGrowthRequest({
    operation: operation(),
    attemptNumber: 1,
    methodIdentifier: 'hold',
    payloadBody: 'x',
  }), { code: 'COMPAT_ADAPTER_METHOD_DENIED' });
  assert.equal(server.callCount.mutate, 0);

  const op = operation({
    lifecycle_operation: 'total_delete',
    lifecycle_ref: 'compat-lifecycle://event/delete/revision/1',
    expected_revision: 1,
    cascade_manifest_digest: canonicalDigest('cascade'),
  });
  const prepared = adapter.prepareLifecycleRequest({
    operation: op,
    attemptNumber: 1,
    methodIdentifier: 'total_delete_projection',
    targetRefs: ['ombre-steward://target/experience/left'],
  });
  const receipt = await adapter.invokeLifecycle({
    operation: op,
    attempt: { attempt_id: 'ocq_attempt_0123456789abcdef01234567', attempt_number: 1 },
    methodIdentifier: 'total_delete_projection',
    targetRefs: ['ombre-steward://target/experience/left'],
    prepared,
  });
  assert.equal(receipt.outcome, 'failed');
  assert.equal(receipt.error_code, 'STEWARD_SOURCE_TOTAL_DELETE_UNSUPPORTED');
});

test('identity drift and malformed transport fail closed', async (t) => {
  const { adapter, server } = await fixture(t);
  server.setMode('drift');
  await assert.rejects(adapter.verifyUpstreamVersion(), { code: 'COMPAT_ADAPTER_UPSTREAM_DRIFT' });
  server.setMode('health_garbage');
  await assert.rejects(adapter.verifyUpstreamVersion(), { code: 'COMPAT_ADAPTER_UPSTREAM_UNAVAILABLE' });
});
