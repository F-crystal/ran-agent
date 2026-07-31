import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { adapterPolicyDigest } from '../src/ombreCompat/adapterPolicy.mjs';
import { canonicalDigest } from '../src/ombreCompat/canonical.mjs';

const url = process.env.OMBRE_PATCHED_PROCESS_URL || '';
const tokenFile = process.env.RAN_AGENT_STEWARD_TOKEN_FILE || '';
const identityFile = process.env.RAN_AGENT_STEWARD_IDENTITY_FILE || '';

test('real patched Ombre process satisfies Steward API v1 contract', {
  skip: !url || !tokenFile || !identityFile,
}, async () => {
  const tokenInfo = fs.lstatSync(tokenFile);
  assert.equal(tokenInfo.isFile() && !tokenInfo.isSymbolicLink(), true);
  assert.equal(tokenInfo.mode & 0o777, 0o600);
  assert.equal(tokenInfo.uid, process.getuid());
  assert.equal(tokenInfo.gid, process.getgid());
  const token = fs.readFileSync(tokenFile, 'ascii').trim();
  const identity = JSON.parse(fs.readFileSync(identityFile, 'utf8'));

  const health = await call('health', { method: 'GET' });
  assert.equal(health.status, 200);
  assert.deepEqual(health.body, {
    status: 'ok',
    schema_version: 'ombre.steward-api/1',
    ...identity,
  });

  const targets = [];
  for (const [index, method] of [
    'append_experience',
    'append_association',
    'append_low_impact_preference_observation',
    'append_i_observation_candidate',
    'append_correction_or_supersession_observation',
  ].entries()) {
    const params = {
      append_experience: { body: 'real patched process experience' },
      append_association: {
        body: 'real patched process association',
        endpoint_refs: targets.length
          ? [targets[0], targets[0]]
          : ['ombre-steward://target/experience/bootstrap', 'ombre-steward://target/experience/bootstrap'],
      },
      append_low_impact_preference_observation: { body: 'preference observation', non_current: true },
      append_i_observation_candidate: { body: 'i observation candidate', candidate_only: true },
      append_correction_or_supersession_observation: {
        body: 'correction observation',
        supersedes_target_ref: targets[0] || 'ombre-steward://target/experience/bootstrap',
      },
    }[method];
    const envelope = requestEnvelope(method, index + 1, params);
    const result = await call('mutate', { body: envelope });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.outcome, 'succeeded');
    assert.deepEqual(pickIdentity(result.body), identity);
    targets.push(result.body.target.target_ref);

    const replay = await call('mutate', { body: envelope });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.idempotency, 'exact_replay');
  }

  const reconcileEnvelope = requestEnvelope('reconcile_operation', 9, {
      operation_key: canonicalDigest('patched-operation-1'),
    }, canonicalDigest('patched-operation-1'));
  reconcileEnvelope.source.candidate_payload_digest = canonicalDigest('payload-1');
  const reconcile = await call('reconcile', {
    body: reconcileEnvelope,
  });
  assert.equal(reconcile.status, 200);
  assert.equal(reconcile.body.outcome, 'succeeded');

  for (const method of ['suppress', 'tombstone']) {
    const target = method === 'suppress' ? targets[0] : targets[1];
    const expected = method === 'suppress' ? 1 : 1;
    const result = await call('mutate', {
      body: requestEnvelope(method, method === 'suppress' ? 10 : 11, {
        target_ref: target,
        lifecycle_ref: `compat-lifecycle://event/${method}/revision/1`,
        expected_revision: expected,
      }),
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
  }

  const unsupported = await call('mutate', {
    body: requestEnvelope('total_delete', 12, {
      target_ref: targets[2],
      lifecycle_ref: 'compat-lifecycle://event/delete/revision/1',
      expected_revision: 1,
      cascade_manifest_digest: canonicalDigest('cascade'),
      source_deletion_receipt: null,
    }),
  });
  assert.equal(unsupported.status, 501);
  assert.equal(unsupported.body.error.code, 'STEWARD_SOURCE_TOTAL_DELETE_UNSUPPORTED');

  const unknownField = requestEnvelope('append_experience', 13, { body: 'denied' });
  unknownField.params.extra = true;
  assert.equal((await call('mutate', { body: unknownField })).status, 400);
  const unknownMethod = requestEnvelope('hold', 14, { body: 'denied' });
  assert.equal((await call('mutate', { body: unknownMethod })).status, 400);
  const wrongVersion = requestEnvelope('append_experience', 15, { body: 'denied' });
  wrongVersion.schema_version = 'ombre.steward-api/999';
  assert.equal((await call('mutate', { body: wrongVersion })).status, 400);

  function call(path, options = {}) {
    return fetch(`${url.replace(/\/+$/, '')}/${path}`, {
      method: options.method || 'POST',
      headers: {
        'X-Ran-Agent-Steward-Token': token,
        ...(options.body ? { 'content-type': 'application/json' } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    }).then(async (response) => ({ status: response.status, body: await response.json() }));
  }
});

function requestEnvelope(method, number, params, operationKey = canonicalDigest(`patched-operation-${number}`)) {
  return {
    schema_version: 'ombre.steward-api/1',
    method,
    operation_key: operationKey,
    idempotency_key: `${operationKey}:${number}`,
    attempt: {
      attempt_id: `ocq_attempt_${String(number).padStart(24, '0')}`,
      attempt_number: number,
    },
    source: {
      compat_protocol_id: 'ombre-stewarded-growth-compatibility/6',
      source_event_id: 'ocq_src_0123456789abcdef0123456789abcdef',
      source_revision: 1,
      source_event_digest: canonicalDigest('source'),
      candidate_payload_digest: canonicalDigest(`payload-${number}`),
      scope_envelope_digest: canonicalDigest('scope'),
      sensitivity: 'standard',
      deletion_domain: 'compat_payload_default',
      adapter_policy_digest: adapterPolicyDigest(),
    },
    params,
    meta: {
      adapter_id: 'ran-agent-ombre-steward-adapter',
      adapter_version: '1.0.0',
      issued_at: '2026-07-30T00:00:00.000Z',
    },
  };
}

function pickIdentity(value) {
  return {
    base_upstream_commit: value.base_upstream_commit,
    patch_manifest_sha256: value.patch_manifest_sha256,
    api_schema_sha256: value.api_schema_sha256,
    effective_source_tree_sha256: value.effective_source_tree_sha256,
  };
}
