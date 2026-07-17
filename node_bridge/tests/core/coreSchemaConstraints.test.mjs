import assert from 'node:assert/strict';
import test from 'node:test';

import { openCoreDatabase } from '../../src/core/coreDb.mjs';
import { CORE_TABLES } from '../../src/core/coreSchema.mjs';
import { createTempCore, openTestInspector } from './helpers/testCoreInspector.mjs';

const AT = '2026-07-16T00:00:00.000Z';
const TOKEN = `hmac-sha256:v1:test-key:${'a'.repeat(64)}`;

async function migratedPath(t) {
  const { dbPath } = createTempCore(t, 'hermes-core-schema-');
  const core = openCoreDatabase({ dbPath });
  core.migrate();
  await core.close();
  return dbPath;
}

function insertEvent(db, id) {
  db.prepare(`INSERT INTO journal_event(
    journal_event_id,event_type,origin_ref,source_kind,source_ref,revision,created_at
  ) VALUES (?, 'test', 'fixture', 'test', 'fixture', 0, ?)`).run(id, AT);
}

function seedSoul(db) {
  insertEvent(db, 'soul-event');
  db.prepare(`INSERT INTO living_identity(
    identity_id,owner_id,name,state,revision,created_at,updated_at
  ) VALUES ('identity','owner','Hermes','active',0,?,?)`).run(AT, AT);
  db.prepare(`INSERT INTO soul_revision(
    soul_revision_id,identity_id,state,content_ref,content_hash,revision,
    state_revision,state_causation_event_id,created_at
  ) VALUES ('soul','identity','draft','profile:v1','hash',1,0,'soul-event',?)`).run(AT);
}

test('every declared state column has a closed CHECK and no Canon FK cascades evidence', async (t) => {
  const dbPath = await migratedPath(t);
  const db = openTestInspector(dbPath);
  for (const table of CORE_TABLES) {
    const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table).sql;
    if (/\bstate\s+TEXT\b/i.test(sql)) assert.match(sql, /CHECK\s*\([^)]*state\s+IN\s*\(/is, `${table}.state lacks enum CHECK`);
    for (const fk of db.prepare(`PRAGMA foreign_key_list(${table})`).all()) {
      assert.notEqual(String(fk.on_delete).toUpperCase(), 'CASCADE', `${table} cascades evidence`);
    }
  }
  db.close();
});

test('negative revisions, fences, attempts and invalid terminal combinations are rejected', async (t) => {
  const dbPath = await migratedPath(t);
  const db = openTestInspector(dbPath, { readOnly: false });
  assert.throws(() => db.prepare(`INSERT INTO work_run(
    work_run_id,attempt_no,execution_epoch_id,state,revision,fence_token,
    contract_revision,created_at,updated_at
  ) VALUES ('bad',0,'epoch','queued',-1,-1,0,?,?)`).run(AT, AT));
  assert.throws(() => db.prepare(`INSERT INTO work_run(
    work_run_id,attempt_no,execution_epoch_id,state,revision,fence_token,
    contract_revision,created_at,updated_at
  ) VALUES ('terminal',1,'epoch','completed',0,0,0,?,?)`).run(AT, AT));
  assert.throws(() => db.prepare(`INSERT INTO ingress_event(
    ingress_event_id,source_instance_id,platform,native_event_id,native_event_id_trust,
    idempotency_disposition,state,revision,received_at,created_at
  ) VALUES ('bad-ingress','fixture','wechat',NULL,'trusted','native_exact','received',0,?,?)`).run(AT, AT));
  assert.throws(() => db.prepare(`INSERT INTO effect_receipt(
    effect_receipt_id,effect_attempt_id,outcome,evidence_type,issuer_ref,
    operation_digest,receipt_ref,content_hash_token,source_event_id,created_at
  ) VALUES ('r','missing','confirmed','adapter_receipt','issuer','digest','ref','token','missing',?)`).run(AT));
  db.close();
});

test('append-oriented ledgers, tombstones and receipts reject UPDATE and DELETE', async (t) => {
  const dbPath = await migratedPath(t);
  const db = openTestInspector(dbPath, { readOnly: false });
  insertEvent(db, 'j1');
  db.prepare(`INSERT INTO payload_tombstone VALUES (
    't1','journal_event','j1',0,NULL,'forget','j1',0,'j1',?
  )`).run(AT);
  db.prepare(`INSERT INTO publication_ledger VALUES (
    'p1','scope','key','journal_event','j1',0,'target','requested','j1',0,'j1',NULL,?
  )`).run(AT);
  assert.throws(() => db.prepare("UPDATE payload_tombstone SET reason_code='other' WHERE tombstone_id='t1'").run());
  assert.throws(() => db.prepare("DELETE FROM payload_tombstone WHERE tombstone_id='t1'").run());
  assert.throws(() => db.prepare("UPDATE publication_ledger SET disposition='failed' WHERE publication_id='p1'").run());
  assert.throws(() => db.prepare("DELETE FROM publication_ledger WHERE publication_id='p1'").run());
  assert.equal(db.prepare('SELECT count(*) AS count FROM payload_tombstone').get().count, 1);
  assert.equal(db.prepare('SELECT count(*) AS count FROM publication_ledger').get().count, 1);
  db.close();
});

test('journal payload rejects a declared raw SHA token and preserves erasable payload boundary', async (t) => {
  const dbPath = await migratedPath(t);
  const db = openTestInspector(dbPath, { readOnly: false });
  insertEvent(db, 'j1');
  assert.throws(() => db.prepare(`INSERT INTO journal_payload(
    journal_payload_id,journal_event_id,storage_kind,payload_ref,content_hash_token,
    sensitivity,retention_class,created_at
  ) VALUES ('payload','j1','encrypted_blob','blob:1','sha256:abc','sensitive','canonical',?)`).run(AT));
  db.prepare(`INSERT INTO journal_payload(
    journal_payload_id,journal_event_id,storage_kind,payload_ref,content_hash_token,
    sensitivity,retention_class,created_at
  ) VALUES ('payload','j1','encrypted_blob','blob:1',?,'sensitive','canonical',?)`).run(TOKEN, AT);
  assert.equal(db.prepare('SELECT count(*) AS count FROM journal_payload').get().count, 1);
  db.close();
});

test('semantic active revision and conversation foreground pointers cannot cross parents', async (t) => {
  const dbPath = await migratedPath(t);
  const db = openTestInspector(dbPath, { readOnly: false });
  insertEvent(db, 'j1');
  for (const id of ['c1', 'c2']) db.prepare(`INSERT INTO conversation(
    conversation_id,owner_id,state,revision,created_at,updated_at
  ) VALUES (?,?,'active',0,?,?)`).run(id, `owner-${id}`, AT, AT);
  for (const [exchange, conversation] of [['e1', 'c1'], ['e2', 'c2']]) db.prepare(`INSERT INTO exchange(
    exchange_id,conversation_id,state,priority,revision,created_at,updated_at
  ) VALUES (?,?,'open','normal',0,?,?)`).run(exchange, conversation, AT, AT);
  for (const [turn, conversation, exchange] of [['t1', 'c1', 'e1'], ['t2', 'c2', 'e2']]) {
    db.prepare(`INSERT INTO semantic_turn(
      semantic_turn_id,conversation_id,exchange_id,actor_ref,role,commit_state,visibility,created_at
    ) VALUES (?,?,?,'user','user','committed','visible',?)`).run(turn, conversation, exchange, AT);
    db.prepare(`INSERT INTO turn_revision(
      turn_revision_id,semantic_turn_id,revision,change_kind,payload_ref,
      content_hash_token,source_event_id,created_at
    ) VALUES (?,?,1,'initial','payload',?,'j1',?)`).run(`r-${turn}`, turn, TOKEN, AT);
  }
  db.prepare("UPDATE semantic_turn SET active_revision_id='r-t1' WHERE semantic_turn_id='t1'").run();
  assert.throws(() => db.prepare("UPDATE semantic_turn SET active_revision_id='r-t2' WHERE semantic_turn_id='t1'").run());
  assert.throws(() => db.prepare("UPDATE conversation SET foreground_exchange_id='e2' WHERE conversation_id='c1'").run());
  db.close();
});

test('Soul schema rejects direct active, illegal transitions and receipt mutation', async (t) => {
  const dbPath = await migratedPath(t);
  const db = openTestInspector(dbPath, { readOnly: false });
  seedSoul(db);
  assert.throws(() => db.prepare(`INSERT INTO soul_revision(
    soul_revision_id,identity_id,state,content_ref,content_hash,revision,
    state_revision,state_causation_event_id,created_at
  ) VALUES ('direct','identity','active','profile','hash',2,0,'soul-event',?)`).run(AT));
  assert.throws(() => db.prepare("UPDATE soul_revision SET state='active' WHERE soul_revision_id='soul'").run());
  db.prepare("UPDATE soul_revision SET state='validated',state_revision=1,validated_at=? WHERE soul_revision_id='soul'").run(AT);
  db.prepare("UPDATE soul_revision SET state='activating',state_revision=2 WHERE soul_revision_id='soul'").run();
  assert.throws(() => db.prepare("UPDATE soul_revision SET state='active' WHERE soul_revision_id='soul'").run());
  assert.throws(() => db.prepare(`INSERT INTO soul_change_receipt(
    soul_change_receipt_id,identity_id,trigger_event_id,old_soul_revision_id,
    new_soul_revision_id,expected_hash,actual_hash,outcome,created_at
  ) VALUES ('mismatch','identity','soul-event',NULL,'soul','hash','other','success',?)`).run(AT));
  db.prepare(`INSERT INTO soul_change_receipt(
    soul_change_receipt_id,identity_id,trigger_event_id,old_soul_revision_id,
    new_soul_revision_id,expected_hash,actual_hash,outcome,created_at
  ) VALUES ('failed','identity','soul-event',NULL,'soul','hash','hash','failed',?)`).run(AT);
  assert.throws(() => db.prepare("UPDATE soul_revision SET state='active',activation_receipt_id='failed' WHERE soul_revision_id='soul'").run());
  assert.throws(() => db.prepare("UPDATE soul_change_receipt SET outcome='success' WHERE soul_change_receipt_id='failed'").run());
  assert.throws(() => db.prepare("DELETE FROM soul_change_receipt WHERE soul_change_receipt_id='failed'").run());
  assert.equal(db.prepare('SELECT count(*) AS count FROM soul_change_receipt').get().count, 1);
  db.close();
});

test('typed Soul activation succeeds atomically and a mid-transaction failure preserves old active', async (t) => {
  const { dbPath } = createTempCore(t, 'hermes-core-soul-');
  const core = openCoreDatabase({ dbPath });
  core.migrate();
  await core.writer.write((tx) => {
    insertSoulEvent(tx, 'event-1');
    tx.soul.createIdentity({ identityId: 'identity', ownerId: 'owner', name: 'Hermes', createdAt: AT });
    tx.soul.createDraft({ soulRevisionId: 'soul-1', identityId: 'identity', contentRef: 'profile:1', contentHash: 'hash-1', revision: 1, causationEventId: 'event-1', createdAt: AT });
    tx.soul.validate({ soulRevisionId: 'soul-1', identityId: 'identity', expectedStateRevision: 0, causationEventId: 'event-1', validatedAt: AT });
    tx.soul.beginActivation({ soulRevisionId: 'soul-1', identityId: 'identity', expectedStateRevision: 1, causationEventId: 'event-1' });
    tx.soul.appendActivationReceipt({ receiptId: 'receipt-1', identityId: 'identity', triggerEventId: 'event-1', newSoulRevisionId: 'soul-1', expectedHash: 'hash-1', actualHash: 'hash-1', outcome: 'success', createdAt: AT });
    tx.soul.activateWithReceipt({ identityId: 'identity', soulRevisionId: 'soul-1', receiptId: 'receipt-1', expectedIdentityRevision: 0, expectedSoulStateRevision: 2, causationEventId: 'event-1', activatedAt: AT });
  });
  assert.equal(core.reader.livingIdentity('identity').active_soul_revision_id, 'soul-1');
  await assert.rejects(core.writer.write((tx) => tx.soul.revokeActive({
    identityId: 'identity', soulRevisionId: 'soul-1', expectedIdentityRevision: 99,
    expectedSoulStateRevision: 3, causationEventId: 'event-1', revokedAt: AT,
  })), { code: 'CORE_SOUL_REVOKE_STALE' });
  assert.equal(core.reader.livingIdentity('identity').active_soul_revision_id, 'soul-1');
  assert.equal(core.reader.soulRevision('soul-1').state, 'active');
  await assert.rejects(core.writer.write((tx) => {
    insertSoulEvent(tx, 'event-2');
    tx.soul.createDraft({ soulRevisionId: 'soul-2', identityId: 'identity', parentRevisionId: 'soul-1', contentRef: 'profile:2', contentHash: 'hash-2', revision: 2, causationEventId: 'event-2', createdAt: AT });
    tx.soul.validate({ soulRevisionId: 'soul-2', identityId: 'identity', expectedStateRevision: 0, causationEventId: 'event-2', validatedAt: AT });
    tx.soul.beginActivation({ soulRevisionId: 'soul-2', identityId: 'identity', expectedStateRevision: 1, causationEventId: 'event-2' });
    tx.soul.activateWithReceipt({ identityId: 'identity', oldSoulRevisionId: 'soul-1', soulRevisionId: 'soul-2', receiptId: 'missing', expectedIdentityRevision: 1, expectedSoulStateRevision: 2, causationEventId: 'event-2', activatedAt: AT });
  }));
  assert.equal(core.reader.livingIdentity('identity').active_soul_revision_id, 'soul-1');
  assert.equal(core.reader.soulRevision('soul-1').state, 'active');
  assert.equal(core.reader.soulRevision('soul-2'), undefined);
  await core.writer.write((tx) => {
    insertSoulEvent(tx, 'event-2');
    tx.soul.createDraft({ soulRevisionId: 'soul-2', identityId: 'identity', parentRevisionId: 'soul-1', contentRef: 'profile:2', contentHash: 'hash-2', revision: 2, causationEventId: 'event-2', createdAt: AT });
    tx.soul.validate({ soulRevisionId: 'soul-2', identityId: 'identity', expectedStateRevision: 0, causationEventId: 'event-2', validatedAt: AT });
    tx.soul.beginActivation({ soulRevisionId: 'soul-2', identityId: 'identity', expectedStateRevision: 1, causationEventId: 'event-2' });
    tx.soul.appendActivationReceipt({ receiptId: 'receipt-2', identityId: 'identity', triggerEventId: 'event-2', oldSoulRevisionId: 'soul-1', newSoulRevisionId: 'soul-2', expectedHash: 'hash-2', actualHash: 'hash-2', outcome: 'success', createdAt: AT });
    tx.soul.activateWithReceipt({ identityId: 'identity', oldSoulRevisionId: 'soul-1', soulRevisionId: 'soul-2', receiptId: 'receipt-2', expectedIdentityRevision: 1, expectedSoulStateRevision: 2, causationEventId: 'event-2', activatedAt: AT });
  });
  assert.equal(core.reader.livingIdentity('identity').active_soul_revision_id, 'soul-2');
  assert.equal(core.reader.soulRevision('soul-1').state, 'superseded');
  assert.equal(core.reader.soulRevision('soul-2').state, 'active');
  await core.writer.write((tx) => tx.soul.revokeActive({
    identityId: 'identity', soulRevisionId: 'soul-2', expectedIdentityRevision: 2,
    expectedSoulStateRevision: 3, causationEventId: 'event-2', revokedAt: AT,
  }));
  assert.equal(core.reader.livingIdentity('identity').active_soul_revision_id, null);
  assert.equal(core.reader.soulRevision('soul-2').state, 'revoked');
  await core.close();
});

function insertSoulEvent(tx, id) {
  tx.journal.append({ eventId: id, eventType: 'soul_activation', originRef: 'fixture', sourceKind: 'test', sourceRef: 'fixture', createdAt: AT });
}

test('active pointer rejects non-active and different-identity revisions; one active Soul per identity', async (t) => {
  const dbPath = await migratedPath(t);
  const db = openTestInspector(dbPath, { readOnly: false });
  insertEvent(db, 'event');
  for (const [identity, owner] of [['i1', 'o1'], ['i2', 'o2']]) db.prepare(`INSERT INTO living_identity(
    identity_id,owner_id,name,state,revision,created_at,updated_at
  ) VALUES (?,?,'Hermes','active',0,?,?)`).run(identity, owner, AT, AT);
  db.prepare(`INSERT INTO soul_revision(
    soul_revision_id,identity_id,state,content_ref,content_hash,revision,state_revision,state_causation_event_id,created_at
  ) VALUES ('draft','i1','draft','ref','hash',1,0,'event',?)`).run(AT);
  assert.throws(() => db.prepare("UPDATE living_identity SET active_soul_revision_id='draft' WHERE identity_id='i1'").run());
  assert.throws(() => db.prepare("UPDATE living_identity SET active_soul_revision_id='draft' WHERE identity_id='i2'").run());
  for (const [soul, revision, hash] of [['s1', 2, 'h1'], ['s2', 3, 'h2']]) {
    db.prepare(`INSERT INTO soul_revision(
      soul_revision_id,identity_id,state,content_ref,content_hash,revision,state_revision,state_causation_event_id,created_at
    ) VALUES (?,'i1','draft','ref',?, ?,0,'event',?)`).run(soul, hash, revision, AT);
    db.prepare("UPDATE soul_revision SET state='validated',state_revision=1,validated_at=? WHERE soul_revision_id=?").run(AT, soul);
    db.prepare("UPDATE soul_revision SET state='activating',state_revision=2 WHERE soul_revision_id=?").run(soul);
    db.prepare(`INSERT INTO soul_change_receipt(
      soul_change_receipt_id,identity_id,trigger_event_id,old_soul_revision_id,
      new_soul_revision_id,expected_hash,actual_hash,outcome,created_at
    ) VALUES (?,?, 'event',NULL,?,?,?,'success',?)`).run(
      `receipt-${soul}`, 'i1', soul, hash, hash, AT,
    );
  }
  db.exec('BEGIN IMMEDIATE');
  db.prepare(`UPDATE soul_revision SET state='active',state_revision=3,
    activation_receipt_id='receipt-s1',activated_at=?,
    active_pointer_identity_id='i1',active_pointer_soul_revision_id='s1'
    WHERE soul_revision_id='s1'`).run(AT);
  db.prepare("UPDATE living_identity SET active_soul_revision_id='s1',revision=1,updated_at=? WHERE identity_id='i1'").run(AT);
  db.exec('COMMIT');
  assert.throws(() => db.prepare("UPDATE living_identity SET active_soul_revision_id=NULL WHERE identity_id='i1'").run());
  assert.throws(() => db.prepare("UPDATE soul_revision SET state='revoked',state_revision=4 WHERE soul_revision_id='s1'").run());
  assert.throws(() => db.prepare("DELETE FROM living_identity WHERE identity_id='i1'").run());
  assert.throws(() => db.prepare(`INSERT OR REPLACE INTO living_identity(
    identity_id,owner_id,name,state,revision,created_at,updated_at
  ) VALUES ('i1','o1','Replacement','active',2,?,?)`).run(AT, AT));
  assert.throws(() => db.prepare(`INSERT INTO soul_change_receipt(
    soul_change_receipt_id,identity_id,trigger_event_id,old_soul_revision_id,
    new_soul_revision_id,expected_hash,actual_hash,outcome,invalidates_receipt_id,created_at
  ) VALUES ('invalidate-s1','i1','event','s1','s1','h1','h1','invalidated','receipt-s1',?)`).run(AT));
  assert.throws(() => db.prepare(`UPDATE soul_revision SET state='active',state_revision=3,
    activation_receipt_id='receipt-s2',activated_at=?,
    active_pointer_identity_id='i1',active_pointer_soul_revision_id='s2'
    WHERE soul_revision_id='s2'`).run(AT));
  assert.equal(db.prepare("SELECT count(*) AS count FROM soul_revision WHERE identity_id='i1' AND state='active'").get().count, 1);
  db.close();
});
