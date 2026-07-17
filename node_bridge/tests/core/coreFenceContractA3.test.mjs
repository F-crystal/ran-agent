import assert from 'node:assert/strict';
import test from 'node:test';

import { openCoreDatabase } from '../../src/core/coreDb.mjs';
import { createTempCore, openTestInspector } from './helpers/testCoreInspector.mjs';

const AT = '2026-07-16T00:00:00.000Z';
const LATER = '2026-07-16T00:01:00.000Z';

async function migratedPath(t) {
  const { dbPath } = createTempCore(t, 'hermes-core-fence-a3-');
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

test('formal Core connection fixes every fence-relevant PRAGMA', async (t) => {
  const { dbPath } = createTempCore(t, 'hermes-core-fence-pragmas-');
  const core = openCoreDatabase({ dbPath });
  assert.deepEqual(core.reader.pragmaSnapshot(), {
    journalMode: 'wal',
    foreignKeys: 1,
    synchronous: 2,
    busyTimeout: 5000,
    recursiveTriggers: 1,
    ignoreCheckConstraints: 0,
  });
  await core.close();
});

test('generation parents and snapshots use strict INTEGER storage', async (t) => {
  const dbPath = await migratedPath(t);
  const db = openTestInspector(dbPath);
  const columns = {
    maintenance_outbox: ['revision', 'fence_token'],
    presentation_outbox: ['revision', 'fence_token'],
    projection_outbox: ['revision', 'fence_token'],
    projector_cursor: ['revision', 'fence_token'],
    work_run: ['revision', 'fence_token'],
    lease: ['revision', 'fence_token'],
    work_checkpoint: ['run_revision', 'fence_token'],
    effect_attempt: ['fence_token'],
    fence: ['old_fence', 'new_fence', 'old_revision', 'new_revision'],
  };
  for (const [table, expected] of Object.entries(columns)) {
    const info = new Map(db.prepare(`PRAGMA table_info(${table})`).all()
      .map((column) => [column.name, column.type]));
    for (const column of expected) assert.equal(info.get(column), 'INTEGER', `${table}.${column}`);
  }
  db.close();
});

test('Work Run identity, deletion, replacement and unaudited rotation are closed by schema', async (t) => {
  const dbPath = await migratedPath(t);
  const db = openTestInspector(dbPath, { readOnly: false });
  db.exec('PRAGMA recursive_triggers=ON; PRAGMA ignore_check_constraints=OFF');
  insertEvent(db);
  insertRun(db);

  assert.throws(() => db.prepare("UPDATE work_run SET work_run_id='other' WHERE work_run_id='run'").run());
  assert.throws(() => db.prepare("UPDATE work_run SET execution_epoch_id='other' WHERE work_run_id='run'").run());
  assert.throws(() => db.prepare("DELETE FROM work_run WHERE work_run_id='run'").run());
  assert.throws(() => db.prepare(`INSERT OR REPLACE INTO work_run(
    work_run_id,attempt_no,execution_epoch_id,state,revision,fence_token,
    contract_revision,created_at,updated_at
  ) VALUES ('run',1,'replacement','queued',0,0,0,?,?)`).run(AT, AT));

  assert.throws(() => db.prepare(`UPDATE work_run
    SET fence_token=1,revision=1,fence_reason_code='lease_rotated',
        fence_causation_id='fence-event',fence_committed_at=?,updated_at=?
    WHERE work_run_id='run'`).run(LATER, LATER));
  assert.deepEqual(
    { ...db.prepare("SELECT revision,fence_token FROM work_run WHERE work_run_id='run'").get() },
    { revision: 0, fence_token: 0 },
  );
  assert.equal(db.prepare('SELECT count(*) AS count FROM fence').get().count, 0);
  db.close();
});

test('typed Work Run rotation is idempotent by scoped operation key', async (t) => {
  const { dbPath } = createTempCore(t, 'hermes-core-fence-operation-');
  let core = openCoreDatabase({ dbPath });
  core.migrate();
  await core.writer.write((tx) => {
    tx.journal.append({
      eventId: 'fence-event', eventType: 'test', originRef: 'fixture',
      sourceKind: 'test', sourceRef: 'fixture', createdAt: AT,
    });
  });
  await core.close();
  const seed = openTestInspector(dbPath, { readOnly: false });
  insertRun(seed);
  seed.close();
  core = openCoreDatabase({ dbPath });

  const input = {
    workRunId: 'run', expectedRevision: 0, expectedFence: 0, nextFence: 1,
    nextState: 'running', reasonCode: 'lease_rotated', sourceEventId: 'fence-event',
    rotationOperationKey: 'run:lease-generation:1', updatedAt: LATER,
  };
  const concurrent = await Promise.all([
    core.writer.write((tx) => tx.revisions.rotateWorkRunFence(input)),
    core.writer.write((tx) => tx.revisions.rotateWorkRunFence(input)),
  ]);
  const first = concurrent.find((result) => result.disposition === 'applied');
  const replay = concurrent.find((result) => result.disposition === 'already_applied');
  assert.ok(first);
  assert.ok(replay);
  assert.equal(replay.fence_token, 1);

  await core.writer.write((tx) => tx.revisions.rotateWorkRunFence({
    ...input,
    expectedRevision: 1,
    expectedFence: 1,
    nextFence: 2,
    rotationOperationKey: 'run:lease-generation:2',
  }));
  await core.close();

  const db = openTestInspector(dbPath);
  assert.deepEqual(
    { ...db.prepare("SELECT revision,fence_token FROM work_run WHERE work_run_id='run'").get() },
    { revision: 2, fence_token: 2 },
  );
  assert.equal(db.prepare("SELECT count(*) AS count FROM fence WHERE work_run_id='run'").get().count, 2);
  assert.equal(db.prepare("SELECT count(*) AS count FROM fence WHERE operation_key='run:lease-generation:1'").get().count, 1);
  db.close();
});

test('operation key scope is per parent while causation may drive multiple rotations', async (t) => {
  const { dbPath } = createTempCore(t, 'hermes-core-fence-scope-');
  let core = openCoreDatabase({ dbPath });
  core.migrate();
  await core.writer.write((tx) => tx.journal.append({
    eventId: 'shared-event', eventType: 'test', originRef: 'fixture',
    sourceKind: 'test', sourceRef: 'fixture', createdAt: AT,
  }));
  await core.close();
  const seed = openTestInspector(dbPath, { readOnly: false });
  insertRun(seed, 'run-a');
  insertRun(seed, 'run-b');
  seed.close();
  core = openCoreDatabase({ dbPath });

  for (const workRunId of ['run-a', 'run-b']) {
    const result = await core.writer.write((tx) => tx.revisions.rotateWorkRunFence({
      workRunId, expectedRevision: 0, expectedFence: 0, nextFence: 1,
      nextState: 'running', reasonCode: 'restart', sourceEventId: 'shared-event',
      rotationOperationKey: 'restart:shared', updatedAt: LATER,
    }));
    assert.equal(result.disposition, 'applied');
  }
  const secondA = await core.writer.write((tx) => tx.revisions.rotateWorkRunFence({
    workRunId: 'run-a', expectedRevision: 1, expectedFence: 1, nextFence: 2,
    nextState: 'running', reasonCode: 'restart', sourceEventId: 'shared-event',
    rotationOperationKey: 'restart:second', updatedAt: LATER,
  }));
  assert.equal(secondA.disposition, 'applied');
  await core.close();

  const db = openTestInspector(dbPath);
  assert.equal(db.prepare("SELECT count(*) AS count FROM fence WHERE causation_id='shared-event'").get().count, 3);
  assert.equal(db.prepare("SELECT count(*) AS count FROM fence WHERE operation_key='restart:shared'").get().count, 2);
  db.close();
});

test('typed fence rotation rejects missing, unsafe and non-integer authority inputs', async (t) => {
  const { dbPath } = createTempCore(t, 'hermes-core-fence-input-');
  let core = openCoreDatabase({ dbPath });
  core.migrate();
  await core.writer.write((tx) => tx.journal.append({
    eventId: 'fence-event', eventType: 'test', originRef: 'fixture',
    sourceKind: 'test', sourceRef: 'fixture', createdAt: AT,
  }));
  await core.close();
  const seed = openTestInspector(dbPath, { readOnly: false });
  insertRun(seed);
  seed.close();
  core = openCoreDatabase({ dbPath });

  const base = {
    workRunId: 'run', expectedRevision: 0, expectedFence: 0, nextFence: 1,
    nextState: 'running', reasonCode: 'lease_rotated', sourceEventId: 'fence-event',
    updatedAt: LATER,
  };
  for (const input of [
    base,
    { ...base, rotationOperationKey: 'bad key' },
    { ...base, rotationOperationKey: 'op:1', nextFence: 1.5 },
    { ...base, rotationOperationKey: 'op:1', expectedRevision: '0' },
  ]) {
    await assert.rejects(core.writer.write((tx) => tx.revisions.rotateWorkRunFence(input)));
  }
  await core.close();
  const db = openTestInspector(dbPath);
  assert.deepEqual(
    { ...db.prepare("SELECT revision,fence_token FROM work_run WHERE work_run_id='run'").get() },
    { revision: 0, fence_token: 0 },
  );
  assert.equal(db.prepare('SELECT count(*) AS count FROM fence').get().count, 0);
  db.close();
});
