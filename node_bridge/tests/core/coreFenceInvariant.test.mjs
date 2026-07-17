import assert from 'node:assert/strict';
import test from 'node:test';

import { openCoreDatabase } from '../../src/core/coreDb.mjs';
import { createTempCore, openTestInspector } from './helpers/testCoreInspector.mjs';

const AT = '2026-07-16T00:00:00.000Z';
const LATER = '2026-07-16T00:01:00.000Z';
const TOKEN = `hmac-sha256:v1:test-key:${'a'.repeat(64)}`;
const OPERATION_DIGEST = `sha256:v1:${'b'.repeat(64)}`;
const FENCE_TABLES = [
  'maintenance_outbox',
  'presentation_outbox',
  'projection_outbox',
  'projector_cursor',
  'work_run',
  'lease',
  'work_checkpoint',
  'effect_attempt',
];

async function migratedPath(t) {
  const { dbPath } = createTempCore(t, 'hermes-core-fence-');
  const core = openCoreDatabase({ dbPath });
  core.migrate();
  await core.close();
  return dbPath;
}

function insertEvent(db, id = 'fence-event') {
  db.prepare(`INSERT INTO journal_event(
    journal_event_id,event_type,origin_ref,source_kind,source_ref,revision,created_at
  ) VALUES (?,'test','fixture','test','fixture',0,?)`).run(id, AT);
}

function insertRun(db, id = 'run') {
  db.prepare(`INSERT INTO work_run(
    work_run_id,attempt_no,execution_epoch_id,state,revision,fence_token,
    contract_revision,created_at,updated_at
  ) VALUES (?,1,'epoch','queued',0,0,0,?,?)`).run(id, AT, AT);
}

function insertPresentationFixture(db) {
  insertEvent(db, 'presentation-event');
  db.prepare(`INSERT INTO conversation(
    conversation_id,owner_id,state,revision,created_at,updated_at
  ) VALUES ('conversation','owner','active',0,?,?)`).run(AT, AT);
  db.prepare(`INSERT INTO exchange(
    exchange_id,conversation_id,state,priority,revision,created_at,updated_at
  ) VALUES ('exchange','conversation','open','normal',0,?,?)`).run(AT, AT);
  db.prepare(`INSERT INTO semantic_turn(
    semantic_turn_id,conversation_id,exchange_id,actor_ref,role,commit_state,visibility,created_at
  ) VALUES ('turn','conversation','exchange','assistant','assistant','committed','visible',?)`).run(AT);
  db.prepare(`INSERT INTO turn_revision(
    turn_revision_id,semantic_turn_id,revision,change_kind,payload_ref,
    content_hash_token,source_event_id,created_at
  ) VALUES ('turn-r1','turn',1,'initial','payload',?,'presentation-event',?)`).run(TOKEN, AT);
  db.prepare(`INSERT INTO presentation_binding(
    presentation_binding_id,conversation_id,source_instance_id,platform,destination_ref,
    state,revision,created_at,updated_at
  ) VALUES ('binding','conversation','desktop:local','desktop','owner',
    'active',0,?,?)`).run(AT, AT);
  db.prepare(`INSERT INTO presentation_outbox(
    presentation_outbox_id,operation_scope,operation_key,conversation_id,
    semantic_turn_id,source_revision,presentation_binding_id,target,payload_ref,
    state,revision,fence_token,created_at,updated_at
  ) VALUES ('presentation','presentation:owner','turn:1','conversation',
    'turn',1,'binding','desktop','payload','pending',0,0,?,?)`).run(AT, AT);
}

function rotateRunSql(db, {
  id = 'run',
  oldFence,
  oldRevision,
  newFence = oldFence + 1,
  newRevision = oldRevision + 1,
  reason = 'lease_rotated',
  causationId = 'fence-event',
  operationKey = `run:${newFence}`,
  at = LATER,
} = {}) {
  return db.prepare(`UPDATE work_run
    SET fence_token=?, revision=?, fence_reason_code=?,
        fence_causation_id=?, fence_operation_key=?, fence_operation_digest=?,
        fence_committed_at=?, updated_at=?
    WHERE work_run_id=? AND fence_token=? AND revision=?`).run(
    BigInt(newFence), BigInt(newRevision), reason, causationId, operationKey,
    OPERATION_DIGEST, at, at,
    id, BigInt(oldFence), BigInt(oldRevision),
  );
}

test('Work Run direct SQL rejects non-step, uncoupled and non-integer fence or revision values', async (t) => {
  const dbPath = await migratedPath(t);
  const db = openTestInspector(dbPath, { readOnly: false });
  insertEvent(db);
  insertRun(db);

  const invalid = [
    ['decrease', 'UPDATE work_run SET fence_token=-1 WHERE work_run_id=?', ['run']],
    ['jump', 'UPDATE work_run SET fence_token=99 WHERE work_run_id=?', ['run']],
    ['fractional fence', 'UPDATE work_run SET fence_token=4.5 WHERE work_run_id=?', ['run']],
    ['null fence', 'UPDATE work_run SET fence_token=NULL WHERE work_run_id=?', ['run']],
    ['fence without revision', `UPDATE work_run SET fence_token=1,
      fence_reason_code='lease_rotated',fence_causation_id='fence-event',
      fence_operation_key='run:1',fence_committed_at=? WHERE work_run_id=?`, [LATER, 'run']],
    ['revision jump', `UPDATE work_run SET fence_token=1,revision=2,
      fence_reason_code='lease_rotated',fence_causation_id='fence-event',
      fence_operation_key='run:1',fence_committed_at=? WHERE work_run_id=?`, [LATER, 'run']],
    ['fractional revision', 'UPDATE work_run SET revision=4.5 WHERE work_run_id=?', ['run']],
    ['null revision', 'UPDATE work_run SET revision=NULL WHERE work_run_id=?', ['run']],
  ];
  for (const [label, sql, params] of invalid) {
    assert.throws(() => db.prepare(sql).run(...params), undefined, label);
    assert.deepEqual(
      { ...db.prepare("SELECT revision,fence_token FROM work_run WHERE work_run_id='run'").get() },
      { revision: 0, fence_token: 0 },
      label,
    );
    assert.equal(db.prepare('SELECT count(*) AS count FROM fence').get().count, 0, label);
  }

  const ordinary = db.prepare("UPDATE work_run SET state='running',revision=1 WHERE work_run_id='run'").run();
  assert.equal(ordinary.changes, 1);
  assert.deepEqual(
    { ...db.prepare("SELECT state,revision,fence_token FROM work_run WHERE work_run_id='run'").get() },
    { state: 'running', revision: 1, fence_token: 0 },
  );
  assert.equal(db.prepare('SELECT count(*) AS count FROM fence').get().count, 0);
  db.close();
});

test('every committed Work Run rotation creates exactly one immutable matching audit', async (t) => {
  const dbPath = await migratedPath(t);
  const db = openTestInspector(dbPath, { readOnly: false });
  insertEvent(db);
  insertRun(db);

  assert.throws(() => db.prepare(`INSERT INTO fence(
    fence_id,domain,work_run_id,old_fence,new_fence,old_revision,new_revision,
    reason_code,causation_id,operation_key,committed_at
  ) VALUES ('forged','work_run','run',0,1,0,1,
    'lease_rotated','fence-event','run:1',?)`).run(LATER));
  assert.equal(rotateRunSql(db, { oldFence: 0, oldRevision: 0 }).changes, 1);
  const audit = { ...db.prepare('SELECT * FROM fence').get() };
  assert.deepEqual({
    domain: audit.domain,
    workRunId: audit.work_run_id,
    cursorId: audit.projector_cursor_id,
    oldFence: audit.old_fence,
    newFence: audit.new_fence,
    oldRevision: audit.old_revision,
    newRevision: audit.new_revision,
    reason: audit.reason_code,
    causationId: audit.causation_id,
    committedAt: audit.committed_at,
  }, {
    domain: 'work_run',
    workRunId: 'run',
    cursorId: null,
    oldFence: 0,
    newFence: 1,
    oldRevision: 0,
    newRevision: 1,
    reason: 'lease_rotated',
    causationId: 'fence-event',
    committedAt: LATER,
  });
  assert.throws(() => db.prepare("UPDATE fence SET reason_code='stop'").run());
  assert.throws(() => db.prepare('DELETE FROM fence').run());

  assert.equal(rotateRunSql(db, { oldFence: 0, oldRevision: 0 }).changes, 0);
  assert.equal(db.prepare('SELECT count(*) AS count FROM fence').get().count, 1);

  assert.throws(() => rotateRunSql(db, {
    oldFence: 1, oldRevision: 1, reason: 'free text is forbidden',
  }));
  assert.deepEqual(
    { ...db.prepare("SELECT revision,fence_token FROM work_run WHERE work_run_id='run'").get() },
    { revision: 1, fence_token: 1 },
  );
  assert.equal(db.prepare('SELECT count(*) AS count FROM fence').get().count, 1);
  db.close();

  const reopened = openTestInspector(dbPath);
  assert.deepEqual(
    { ...reopened.prepare("SELECT revision,fence_token FROM work_run WHERE work_run_id='run'").get() },
    { revision: 1, fence_token: 1 },
  );
  assert.equal(reopened.prepare('SELECT count(*) AS count FROM fence').get().count, 1);
  reopened.close();
});

test('maintenance and presentation reservation generations also require step, revision and automatic audit', async (t) => {
  const dbPath = await migratedPath(t);
  const db = openTestInspector(dbPath, { readOnly: false });
  insertEvent(db, 'maintenance-event');
  db.prepare(`INSERT INTO maintenance_outbox(
    maintenance_outbox_id,operation_scope,operation_key,task_type,target,
    state,revision,fence_token,created_at,updated_at
  ) VALUES ('maintenance','maintenance:owner','task:1','compact','owner',
    'pending',0,0,?,?)`).run(AT, AT);
  assert.throws(() => db.prepare("UPDATE maintenance_outbox SET fence_token=99 WHERE maintenance_outbox_id='maintenance'").run());
  assert.throws(() => db.prepare("UPDATE maintenance_outbox SET fence_token=4.5 WHERE maintenance_outbox_id='maintenance'").run());
  assert.equal(db.prepare(`UPDATE maintenance_outbox
    SET state='reserved',lease_owner='worker',lease_until=?,
        revision=?,fence_token=?,fence_reason_code='maintenance_claim',
        fence_causation_id='maintenance-event',fence_operation_key='maintenance:1',
        fence_operation_digest=?,
        fence_committed_at=?,updated_at=?
    WHERE maintenance_outbox_id='maintenance' AND revision=0 AND fence_token=0`)
    .run(LATER, 1n, 1n, OPERATION_DIGEST, LATER, LATER).changes, 1);
  assert.throws(() => db.prepare(`UPDATE maintenance_outbox
    SET operation_key='other' WHERE maintenance_outbox_id='maintenance'`).run());
  assert.throws(() => db.prepare("DELETE FROM maintenance_outbox WHERE maintenance_outbox_id='maintenance'").run());

  insertPresentationFixture(db);
  assert.throws(() => db.prepare("UPDATE presentation_outbox SET fence_token=99 WHERE presentation_outbox_id='presentation'").run());
  assert.throws(() => db.prepare("UPDATE presentation_outbox SET revision=2,fence_token=1 WHERE presentation_outbox_id='presentation'").run());
  assert.equal(db.prepare(`UPDATE presentation_outbox
    SET state='reserved',lease_owner='worker',lease_until=?,
        revision=?,fence_token=?,fence_reason_code='presentation_claim',
        fence_causation_id='presentation-event',fence_operation_key='presentation:1',
        fence_operation_digest=?,
        fence_committed_at=?,updated_at=?
    WHERE presentation_outbox_id='presentation' AND revision=0 AND fence_token=0`)
    .run(LATER, 1n, 1n, OPERATION_DIGEST, LATER, LATER).changes, 1);
  assert.throws(() => db.prepare(`UPDATE presentation_outbox
    SET operation_scope='other' WHERE presentation_outbox_id='presentation'`).run());
  assert.throws(() => db.prepare("DELETE FROM presentation_outbox WHERE presentation_outbox_id='presentation'").run());

  assert.deepEqual(
    db.prepare(`SELECT domain,old_fence,new_fence,old_revision,new_revision
      FROM fence ORDER BY domain`).all().map((row) => ({ ...row })),
    [
      { domain: 'maintenance_outbox', old_fence: 0, new_fence: 1, old_revision: 0, new_revision: 1 },
      { domain: 'presentation_outbox', old_fence: 0, new_fence: 1, old_revision: 0, new_revision: 1 },
    ],
  );
  db.close();
});

test('fence audit failure rolls back rotation and later statement failure leaves no audit', async (t) => {
  const dbPath = await migratedPath(t);
  const db = openTestInspector(dbPath, { readOnly: false });
  insertEvent(db);
  insertRun(db);

  db.exec(`CREATE TRIGGER reject_fence_audit BEFORE INSERT ON fence
    BEGIN SELECT RAISE(ABORT, 'simulated fence audit failure'); END`);
  assert.throws(() => rotateRunSql(db, { oldFence: 0, oldRevision: 0 }));
  assert.deepEqual(
    { ...db.prepare("SELECT revision,fence_token FROM work_run WHERE work_run_id='run'").get() },
    { revision: 0, fence_token: 0 },
  );
  assert.equal(db.prepare('SELECT count(*) AS count FROM fence').get().count, 0);
  db.exec('DROP TRIGGER reject_fence_audit');

  insertRun(db, 'run-2');
  assert.throws(() => db.prepare(`UPDATE work_run
    SET fence_token=1,revision=1,state='invalid',
        fence_reason_code='lease_rotated',fence_causation_id='fence-event',
        fence_operation_key='run-2:1',fence_committed_at=?,updated_at=?
    WHERE work_run_id='run-2'`).run(LATER, LATER));
  assert.deepEqual(
    { ...db.prepare("SELECT revision,fence_token FROM work_run WHERE work_run_id='run-2'").get() },
    { revision: 0, fence_token: 0 },
  );
  assert.equal(db.prepare('SELECT count(*) AS count FROM fence').get().count, 0);
  db.close();
});

test('projector cursor is a second audited generation domain and cannot jump or store non-integers', async (t) => {
  const dbPath = await migratedPath(t);
  const db = openTestInspector(dbPath, { readOnly: false });
  insertEvent(db, 'projection-event');
  db.prepare(`INSERT INTO projector_cursor(
    projector_cursor_id,projector_id,target_scope,revision,fence_token,created_at,updated_at
  ) VALUES ('cursor','everos','owner',0,0,?,?)`).run(AT, AT);
  db.prepare(`INSERT INTO projection_outbox(
    projection_outbox_id,operation_scope,operation_key,projector_id,target_scope,
    source_sequence,source_event_id,source_entity_type,source_entity_id,source_revision,
    state,revision,attempt_count,fence_token,created_at,updated_at
  ) SELECT 'projection','projection:owner','projection:1','everos','owner',
    sequence_no,'projection-event','journal_event','projection-event',revision,
    'pending',0,0,0,?,? FROM journal_event WHERE journal_event_id='projection-event'`).run(AT, AT);

  assert.throws(() => db.prepare("UPDATE projector_cursor SET fence_token=99 WHERE projector_cursor_id='cursor'").run());
  assert.throws(() => db.prepare("UPDATE projector_cursor SET fence_token=4.5 WHERE projector_cursor_id='cursor'").run());
  assert.equal(db.prepare(`UPDATE projector_cursor
    SET fence_token=1,revision=1,lease_owner='worker',lease_until=?,
        fence_reason_code='projection_claim',
        fence_causation_id='projection-event',fence_operation_key='cursor:1',
        fence_operation_digest=?,fence_result_outbox_id='projection',
        fence_committed_at=?
    WHERE projector_cursor_id='cursor'`).run(LATER, OPERATION_DIGEST, LATER).changes, 1);
  assert.deepEqual(
    { ...db.prepare("SELECT revision,fence_token FROM projector_cursor WHERE projector_cursor_id='cursor'").get() },
    { revision: 1, fence_token: 1 },
  );
  assert.deepEqual(
    { ...db.prepare(`SELECT domain,projector_cursor_id,old_fence,new_fence,
      old_revision,new_revision,reason_code,causation_id FROM fence`).get() },
    {
      domain: 'projector_cursor',
      projector_cursor_id: 'cursor',
      old_fence: 0,
      new_fence: 1,
      old_revision: 0,
      new_revision: 1,
      reason_code: 'projection_claim',
      causation_id: 'projection-event',
    },
  );
  assert.throws(() => db.prepare(`UPDATE projector_cursor
    SET projector_id='vault' WHERE projector_cursor_id='cursor'`).run());
  assert.throws(() => db.prepare(`UPDATE projector_cursor
    SET target_scope='other' WHERE projector_cursor_id='cursor'`).run());
  assert.throws(() => db.prepare("DELETE FROM projector_cursor WHERE projector_cursor_id='cursor'").run());
  db.close();
});

test('all Core fence storage uses strict integer checks and snapshot fields cannot masquerade as REAL', async (t) => {
  const dbPath = await migratedPath(t);
  const db = openTestInspector(dbPath);
  for (const table of FENCE_TABLES) {
    const sql = db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?").get(table).sql;
    assert.match(sql, /\)\s+STRICT$/i, `${table} is not STRICT`);
    assert.match(
      sql,
      /fence_token\s+INTEGER\s+NOT NULL[^,]*typeof\(fence_token\)\s*=\s*'integer'/is,
      `${table}.fence_token does not preserve and reject non-integer storage classes`,
    );
  }
  for (const table of ['maintenance_outbox', 'presentation_outbox', 'projection_outbox', 'projector_cursor', 'work_run', 'lease']) {
    const sql = db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?").get(table).sql;
    assert.match(
      sql,
      /revision\s+INTEGER\s+NOT NULL[^,]*typeof\(revision\)\s*=\s*'integer'/is,
      `${table}.revision is not a strict authority revision`,
    );
  }
  const auditSql = db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='fence'").get().sql;
  for (const column of ['old_fence', 'new_fence', 'old_revision', 'new_revision']) {
    assert.match(
      auditSql,
      new RegExp(`${column}\\s+INTEGER\\s+NOT NULL[^,]*typeof\\(${column}\\)\\s*=\\s*'integer'`, 'is'),
      `fence.${column} is not a strict integer`,
    );
  }
  db.close();
});

test('candidate v1 rejects a legacy REAL fence fixture without coercion and remains clean after reopen', async (t) => {
  const dbPath = await migratedPath(t);
  const db = openTestInspector(dbPath, { readOnly: false });
  assert.throws(() => db.prepare(`INSERT INTO work_run(
    work_run_id,attempt_no,execution_epoch_id,state,revision,fence_token,
    contract_revision,created_at,updated_at
  ) VALUES ('legacy-real',1,'epoch','queued',0,4.5,0,?,?)`).run(AT, AT));
  assert.equal(db.prepare("SELECT count(*) AS count FROM work_run WHERE work_run_id='legacy-real'").get().count, 0);
  db.close();

  const reopened = openCoreDatabase({ dbPath });
  assert.equal(reopened.reader.schemaVersion(), 1);
  await reopened.close();
  const inspector = openTestInspector(dbPath);
  assert.equal(inspector.prepare("SELECT count(*) AS count FROM work_run WHERE work_run_id='legacy-real'").get().count, 0);
  inspector.close();
});
