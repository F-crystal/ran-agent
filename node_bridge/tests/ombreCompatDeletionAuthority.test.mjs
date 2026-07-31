import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createHash,
  createHmac,
  generateKeyPairSync,
  sign,
} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { canonicalDigest } from '../src/ombreCompat/canonical.mjs';
import { createSourceDeletionReceiptVerifier } from '../src/ombreCompat/deletionReceiptVerifier.mjs';

const NOW = new Date('2026-07-30T12:00:00.000Z');

function keyFixture() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ format: 'der', type: 'spki' });
  const raw = der.subarray(-32);
  return {
    publicKey,
    privateKey,
    raw,
    keyId: `sha256:${createHash('sha256').update(raw).digest('hex')}`,
  };
}

function registryFor(key) {
  return {
    schema_version: 'ran-agent-source-deletion-ed25519-key-registry/v1',
    registry_revision: 1,
    current: {
      key_id: key.keyId,
      public_key_raw_base64url: key.raw.toString('base64url'),
      activated_at: '2026-07-01T00:00:00.000Z',
    },
    previous: null,
    updated_at: '2026-07-30T00:00:00.000Z',
  };
}

function unsignedReceipt(keyId) {
  return {
    receipt_version: 'ran-agent-source-deletion-receipt/v1',
    receipt_id: `csdr_${'1'.repeat(32)}`,
    source_record_ref: 'durable-outbox://item/outbox-1',
    source_owner: 'core.durable-outbox',
    source_event_id: `ocq_src_${'2'.repeat(32)}`,
    source_revision: 7,
    source_event_digest: `sha256:${'3'.repeat(64)}`,
    source_payload_digest: `sha256:${'4'.repeat(64)}`,
    deletion_revision: 11,
    deletion_disposition: 'deleted',
    deleted_at: '2026-07-30T10:00:00.000Z',
    key_id: keyId,
  };
}

function signReceipt(material, privateKey) {
  const receiptDigest = canonicalDigest(material);
  const signatureMaterial = Buffer.from(
    `ran-agent-source-deletion-receipt/v1\n${receiptDigest}`,
    'utf8',
  );
  return {
    ...material,
    receipt_digest: receiptDigest,
    signature: sign(null, signatureMaterial, privateKey).toString('base64url'),
  };
}

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ombre-ed25519-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const core = keyFixture();
  const registry = registryFor(core);
  const registryPath = path.join(root, 'ed25519-key-registry.v1.json');
  fs.writeFileSync(registryPath, `${JSON.stringify(registry)}\n`, { mode: 0o644 });
  fs.chmodSync(registryPath, 0o644);
  const expected = unsignedReceipt(core.keyId);
  const verifier = createSourceDeletionReceiptVerifier({
    registryPath,
    expectedRegistryDigest: canonicalDigest(registry),
    expectedUid: process.getuid?.() ?? 0,
    expectedGid: process.getgid?.(),
    resolveSource: async () => ({ status: 'typed_unresolvable' }),
    clock: () => NOW,
  });
  return { root, core, registry, registryPath, expected, verifier };
}

test('Core fixture Ed25519 receipt verifies with exact source bindings and typed-unresolvable proof', async (t) => {
  const { core, expected, verifier } = setup(t);
  const receipt = signReceipt(expected, core.privateKey);
  const result = await verifier.verifyReceipt(receipt, expected);
  assert.equal(result.status, 'verified');
  assert.equal(result.key_id, core.keyId);
});

test('HMAC and an O2-generated Ed25519 key are both rejected', async (t) => {
  const { core, expected, verifier } = setup(t);
  const digest = canonicalDigest(expected);
  const hmac = {
    ...expected,
    receipt_digest: digest,
    signature: createHmac('sha256', 'not-a-core-key')
      .update(`ran-agent-source-deletion-receipt/v1\n${digest}`)
      .digest('base64url'),
  };
  await assert.rejects(verifier.verifyReceipt(hmac, expected), authorityError);

  const rogue = keyFixture();
  const selfSigned = signReceipt(expected, rogue.privateKey);
  await assert.rejects(verifier.verifyReceipt(selfSigned, expected), authorityError);
  assert.notEqual(rogue.keyId, core.keyId);
});

test('unknown key, registry drift, source binding drift, and resolvable source fail closed', async (t) => {
  const { core, registry, registryPath, expected, verifier } = setup(t);
  const unknown = signReceipt({ ...expected, key_id: `sha256:${'9'.repeat(64)}` }, core.privateKey);
  await assert.rejects(verifier.verifyReceipt(unknown, expected), authorityError);

  const bound = signReceipt(expected, core.privateKey);
  await assert.rejects(
    verifier.verifyReceipt(bound, { ...expected, source_revision: expected.source_revision + 1 }),
    authorityError,
  );

  fs.writeFileSync(registryPath, `${JSON.stringify({ ...registry, registry_revision: 2 })}\n`);
  await assert.rejects(verifier.verifyReceipt(bound, expected), authorityError);

  const resolvableVerifier = createSourceDeletionReceiptVerifier({
    registryPath,
    expectedRegistryDigest: canonicalDigest({ ...registry, registry_revision: 2 }),
    expectedUid: process.getuid?.() ?? 0,
    expectedGid: process.getgid?.(),
    resolveSource: async () => ({ status: 'resolved' }),
    clock: () => NOW,
  });
  await assert.rejects(resolvableVerifier.verifyReceipt(bound, expected), authorityError);
});

test('previous key window is exactly 30 days and cannot be extended', (t) => {
  const { registryPath } = setup(t);
  const current = keyFixture();
  const previous = keyFixture();
  const registry = registryFor(current);
  registry.previous = {
    key_id: previous.keyId,
    public_key_raw_base64url: previous.raw.toString('base64url'),
    activated_at: '2026-06-01T00:00:00.000Z',
    retired_at: '2026-07-01T00:00:00.000Z',
    verify_until: '2026-08-01T00:00:00.000Z',
  };
  fs.writeFileSync(registryPath, `${JSON.stringify(registry)}\n`);
  const verifier = createSourceDeletionReceiptVerifier({
    registryPath,
    expectedRegistryDigest: canonicalDigest(registry),
    expectedUid: process.getuid?.() ?? 0,
    expectedGid: process.getgid?.(),
    resolveSource: async () => ({ status: 'typed_unresolvable' }),
  });
  assert.throws(() => verifier.loadRegistry(), authorityError);
});

test('O2 verifier source has no private-key loader or signing capability', () => {
  const source = fs.readFileSync(
    new URL('../src/ombreCompat/deletionReceiptVerifier.mjs', import.meta.url),
    'utf8',
  );
  assert.equal(/\bcreatePrivateKey\b|\bgenerateKeyPair\b|\bsign\s*\(/.test(source), false);
});

function authorityError(error) {
  return error?.code === 'COMPAT_DELETION_AUTHORITY_INVALID';
}
