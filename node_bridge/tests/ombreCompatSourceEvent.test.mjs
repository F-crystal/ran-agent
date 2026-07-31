import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { canonicalDigest, isSha256Digest } from '../src/ombreCompat/canonical.mjs';
import { buildCompatFinalTurnEvent } from '../src/ombreCompat/emitter.mjs';
import { computeSourceEventDigest, validateFinalTurnSourceEvent } from '../src/ombreCompat/sourceEvent.mjs';

const EMITTER_MODULE_URL = pathToFileURL(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'ombreCompat', 'emitter.mjs'),
).href;

function validInput(overrides = {}) {
  return {
    platform: 'wechat',
    conversationId: 'conv-1',
    exchangeId: 'ex-1',
    userText: '用户最终文本',
    assistantText: '助手最终文本',
    scopeEnvelope: {
      actor: 'user:ran',
      platform: 'wechat',
      conversation_id: 'conv-1',
      channel_type: 'dm',
      visibility: 'private',
      valid_from: '2026-07-27T00:00:00.000Z',
    },
    sensitivity: 'personal',
    trustedActionReceiptRefs: [],
    sourceGateReceiptRef: canonicalDigest('gate-evidence'),
    emittedAt: '2026-07-27T00:00:00.000Z',
    ...overrides,
  };
}

function expectIngressInvalid(fn, pattern) {
  assert.throws(fn, (error) => {
    assert.equal(error.code, 'COMPAT_INGRESS_INVALID');
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
}

test('a well-formed final-turn event validates and binds stable digests', () => {
  const event = buildCompatFinalTurnEvent(validInput());
  assert.equal(event.schema_version, 'compatibility.final-turn/v1');
  assert.equal(event.presentation_state, 'not_presented');
  assert.equal(event.lifecycle_state, 'current');
  for (const field of [
    'user_final_payload_digest',
    'assistant_final_payload_digest',
    'final_content_digest',
    'scope_envelope_digest',
    'trusted_action_receipts_digest',
    'source_event_digest',
  ]) {
    assert.ok(isSha256Digest(event[field]), `${field} must be a sha256 digest`);
  }
  // The combined digest commits to exactly the two adopted payload digests.
  assert.equal(
    event.final_content_digest,
    canonicalDigest({
      user_final_payload_digest: event.user_final_payload_digest,
      assistant_final_payload_digest: event.assistant_final_payload_digest,
    }),
  );
  // Validation is deterministic and idempotent over an already-valid event.
  const revalidated = validateFinalTurnSourceEvent(event);
  assert.equal(revalidated.source_event_digest, event.source_event_digest);
  assert.equal(computeSourceEventDigest(event), event.source_event_digest);
});

test('source event digest and event id are stable across processes', () => {
  const local = buildCompatFinalTurnEvent(validInput());
  const script = `import { buildCompatFinalTurnEvent } from ${JSON.stringify(EMITTER_MODULE_URL)};\n`
    + 'const event = buildCompatFinalTurnEvent(JSON.parse(process.argv[1]));\n'
    + 'console.log(JSON.stringify({ event_id: event.event_id, digest: event.source_event_digest }));';
  const out = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', script, JSON.stringify(validInput())],
    { encoding: 'utf8' },
  );
  const remote = JSON.parse(out.trim());
  assert.equal(remote.event_id, local.event_id);
  assert.equal(remote.digest, local.source_event_digest);
});

test('missing required fields are rejected fail-closed', () => {
  const event = buildCompatFinalTurnEvent(validInput());
  for (const field of ['conversation_id', 'exchange_id', 'sensitivity', 'emitted_at', 'source_gate_receipt_ref']) {
    const broken = { ...event, [field]: '' };
    expectIngressInvalid(() => validateFinalTurnSourceEvent(broken), new RegExp(field));
  }
  const missing = { ...event };
  delete missing.scope_envelope_digest;
  expectIngressInvalid(() => validateFinalTurnSourceEvent(missing), /scope_envelope_digest/);
});

test('unknown schema_version is rejected fail-closed', () => {
  expectIngressInvalid(
    () => buildCompatFinalTurnEvent(validInput()) && validateFinalTurnSourceEvent({
      ...buildCompatFinalTurnEvent(validInput()),
      schema_version: 'compatibility.final-turn/v2',
    }),
    /unknown source event schema/,
  );
});

test('unknown enum values are rejected fail-closed', () => {
  const event = buildCompatFinalTurnEvent(validInput());
  expectIngressInvalid(
    () => validateFinalTurnSourceEvent({ ...event, presentation_state: 'delivered' }),
    /presentation_state/,
  );
  expectIngressInvalid(
    () => validateFinalTurnSourceEvent({ ...event, lifecycle_state: 'archived' }),
    /lifecycle_state/,
  );
  expectIngressInvalid(
    () => validateFinalTurnSourceEvent({ ...event, sensitivity: 'topsecret' }),
    /sensitivity/,
  );
});

test('non-sha256 digests are rejected fail-closed', () => {
  const event = buildCompatFinalTurnEvent(validInput());
  expectIngressInvalid(
    () => validateFinalTurnSourceEvent({ ...event, user_final_payload_digest: 'md5:abc' }),
    /user_final_payload_digest/,
  );
  expectIngressInvalid(
    () => validateFinalTurnSourceEvent({ ...event, trusted_action_receipts_digest: 'sha256:nothex' }),
    /trusted_action_receipts_digest/,
  );
});

test('a tampered event with a stale source_event_digest is rejected fail-closed', () => {
  const event = buildCompatFinalTurnEvent(validInput());
  const tampered = { ...event, emitted_at: '2026-07-28T00:00:00.000Z' };
  expectIngressInvalid(() => validateFinalTurnSourceEvent(tampered), /source_event_digest mismatch/);
});

test('negative or non-integer revisions are rejected fail-closed', () => {
  const event = buildCompatFinalTurnEvent(validInput());
  expectIngressInvalid(
    () => validateFinalTurnSourceEvent({ ...event, source_revision: -1 }),
    /source_revision/,
  );
  expectIngressInvalid(
    () => validateFinalTurnSourceEvent({ ...event, source_revision: 0.5 }),
    /source_revision/,
  );
});
