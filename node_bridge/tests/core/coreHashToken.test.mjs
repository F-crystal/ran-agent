import assert from 'node:assert/strict';
import test from 'node:test';

import { formatKeyedContentHashToken, isKeyedContentHashToken } from '../../src/core/coreHashToken.mjs';
import { openCoreDatabase } from '../../src/core/coreDb.mjs';
import { createTempCore, openTestInspector } from './helpers/testCoreInspector.mjs';

const DIGEST = 'a'.repeat(64);
const VALID = `hmac-sha256:v1:content-key-1:${DIGEST}`;
const AT = '2026-07-16T00:00:00.000Z';

test('keyed content hash helper emits exactly one canonical representation', () => {
  assert.equal(formatKeyedContentHashToken({ keyId: 'content-key-1', digest: DIGEST }), VALID);
  assert.equal(isKeyedContentHashToken(VALID), true);
  for (const invalid of [
    DIGEST,
    `sha256:${DIGEST}`,
    `hmac-sha256:v1::${DIGEST}`,
    `hmac-sha256:v1:${'k'.repeat(65)}:${DIGEST}`,
    `hmac-sha256:v1:bad key:${DIGEST}`,
    `hmac-sha256:v1:key:${'A'.repeat(64)}`,
    `hmac-sha256:v1:key:${'g'.repeat(64)}`,
    `hmac-sha256:v1:key:${'a'.repeat(63)}`,
    `hmac-sha256:v1:key:${DIGEST}:extra`,
    ` hmac-sha256:v1:key:${DIGEST}`,
  ]) assert.equal(isKeyedContentHashToken(invalid), false, invalid);
  assert.throws(() => formatKeyedContentHashToken({ keyId: 'bad:key', digest: DIGEST }), { code: 'CORE_HASH_TOKEN_INVALID' });
});

test('schema and typed ingress reject noncanonical tokens while accepting helper output', async (t) => {
  const { dbPath } = createTempCore(t, 'hermes-core-hash-');
  const core = openCoreDatabase({ dbPath });
  core.migrate();
  await core.writer.write((tx) => tx.ingress.append({
    ingressEventId: 'valid', sourceInstanceId: 'desktop', platform: 'desktop',
    nativeEventIdTrust: 'absent', idempotencyDisposition: 'internal_only',
    payloadHashToken: VALID, receivedAt: AT, createdAt: AT,
  }));
  await assert.rejects(core.writer.write((tx) => tx.ingress.append({
    ingressEventId: 'invalid', sourceInstanceId: 'desktop', platform: 'desktop',
    nativeEventIdTrust: 'absent', idempotencyDisposition: 'internal_only',
    payloadHashToken: DIGEST, receivedAt: AT, createdAt: AT,
  })), { code: 'CORE_HASH_TOKEN_INVALID' });
  assert.equal(core.reader.ingressEventCount(), 1);
  await core.close();

  const db = openTestInspector(dbPath, { readOnly: false });
  for (const [table, column] of [
    ['journal_payload', 'content_hash_token'],
    ['ingress_event', 'payload_hash_token'],
    ['turn_revision', 'content_hash_token'],
    ['provider_epoch', 'snapshot_hash_token'],
    ['provider_epoch_binding', 'handle_hash_token'],
    ['effect_receipt', 'content_hash_token'],
  ]) {
    const sql = db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?").get(table).sql;
    assert.match(sql, new RegExp(`${column}[\\s\\S]+hmac-sha256:v1:`), `${table}.${column}`);
  }
  db.prepare(`INSERT INTO journal_event(
    journal_event_id,event_type,origin_ref,source_kind,source_ref,revision,created_at
  ) VALUES ('j1','test','fixture','test','fixture',0,?)`).run(AT);
  for (const invalid of ['', DIGEST, `sha256:${DIGEST}`, `hmac-sha256:v1:key:${'A'.repeat(64)}`]) {
    assert.throws(() => db.prepare(`INSERT INTO journal_payload(
      journal_payload_id,journal_event_id,storage_kind,payload_ref,content_hash_token,
      sensitivity,retention_class,created_at
    ) VALUES (?, 'j1','encrypted_blob','blob',?,'normal','canonical',?)`).run(`bad-${invalid.length}`, invalid, AT));
  }
  db.prepare(`INSERT INTO journal_payload(
    journal_payload_id,journal_event_id,storage_kind,payload_ref,content_hash_token,
    sensitivity,retention_class,created_at
  ) VALUES ('good','j1','encrypted_blob','blob',?,'normal','canonical',?)`).run(VALID, AT);
  assert.equal(db.prepare('SELECT count(*) AS count FROM journal_payload').get().count, 1);
  db.close();
});
