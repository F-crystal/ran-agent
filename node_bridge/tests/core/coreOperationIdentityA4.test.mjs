import assert from 'node:assert/strict';
import test from 'node:test';

import { openCoreDatabase } from '../../src/core/coreDb.mjs';
import { createTempCore, openTestInspector } from './helpers/testCoreInspector.mjs';

const AT = '2026-07-17T00:00:00.000Z';
const LATER = '2026-07-17T00:01:00.000Z';

function withoutDisposition(result) {
  const { disposition, ...rest } = result;
  return rest;
}

function appendEvent(tx, eventId, revision = 0) {
  return tx.journal.append({
    eventId, eventType: 'test', originRef: 'fixture', sourceKind: 'test',
    sourceRef: 'fixture', revision, createdAt: AT,
  });
}

async function setupWorkRun(t) {
  const { dbPath } = createTempCore(t, 'hermes-core-operation-a4-run-');
  let core = openCoreDatabase({ dbPath });
  core.migrate();
  await core.writer.write((tx) => appendEvent(tx, 'run-event'));
  await core.close();
  const seed = openTestInspector(dbPath, { readOnly: false });
  seed.prepare(`INSERT INTO work_run(
    work_run_id,attempt_no,execution_epoch_id,state,revision,fence_token,
    contract_revision,created_at,updated_at
  ) VALUES ('run',1,'epoch','queued',0,0,0,?,?)`).run(AT, AT);
  seed.close();
  core = openCoreDatabase({ dbPath });
  return { core, dbPath };
}

async function setupProjection(t) {
  const { dbPath } = createTempCore(t, 'hermes-core-operation-a4-projection-');
  const core = openCoreDatabase({ dbPath });
  core.migrate();
  await core.writer.write((tx) => {
    appendEvent(tx, 'source', 1);
    appendEvent(tx, 'source-2', 2);
    tx.projections.createCursor({
      cursorId: 'cursor', projectorId: 'everos', targetScope: 'owner', createdAt: AT,
    });
    for (const outboxId of ['outbox-a', 'outbox-b']) {
      tx.projections.reserve({
        outboxId, operationScope: `everos:${outboxId}`, operationKey: 'source:1',
        projectorId: 'everos', targetScope: 'owner', sourceEventId: 'source',
        sourceRevision: 1, createdAt: AT,
      });
    }
    tx.projections.reserve({
      outboxId: 'outbox-c', operationScope: 'everos:outbox-c', operationKey: 'source:2',
      projectorId: 'everos', targetScope: 'owner', sourceEventId: 'source-2',
      sourceRevision: 2, createdAt: AT,
    });
  });
  return { core, dbPath };
}

test('A3-FR-01: same Work Run operation key with different nextState conflicts with zero writes', async (t) => {
  const { core, dbPath } = await setupWorkRun(t);
  const base = {
    workRunId: 'run', expectedRevision: 0, expectedFence: 0, nextFence: 1,
    nextState: 'running', reasonCode: 'lease_rotated', sourceEventId: 'run-event',
    rotationOperationKey: 'run:rotation:1', updatedAt: LATER,
  };
  const applied = await core.writer.write((tx) => tx.revisions.rotateWorkRunFence(base));
  assert.equal(applied.disposition, 'applied');
  await assert.rejects(
    core.writer.write((tx) => tx.revisions.rotateWorkRunFence({ ...base, nextState: 'waiting' })),
    { code: 'CORE_OPERATION_KEY_CONFLICT' },
  );
  await core.close();

  const db = openTestInspector(dbPath);
  assert.deepEqual(
    { ...db.prepare("SELECT state,revision,fence_token FROM work_run WHERE work_run_id='run'").get() },
    { state: 'running', revision: 1, fence_token: 1 },
  );
  assert.equal(db.prepare("SELECT count(*) AS count FROM fence WHERE work_run_id='run'").get().count, 1);
  db.close();
});

test('A3-FR-02: same projector operation key cannot claim a different pending outbox', async (t) => {
  const { core, dbPath } = await setupProjection(t);
  const base = {
    cursorId: 'cursor', outboxId: 'outbox-a', expectedCursorRevision: 0,
    expectedCursorFence: 0, expectedOutboxRevision: 0, leaseOwner: 'worker-a',
    leaseUntil: LATER, rotationOperationKey: 'cursor:claim:1', updatedAt: AT,
  };
  const applied = await core.writer.write((tx) => tx.projections.claim(base));
  assert.equal(applied.disposition, 'applied');
  assert.equal(applied.outbox.projection_outbox_id, 'outbox-a');
  await assert.rejects(
    core.writer.write((tx) => tx.projections.claim({ ...base, outboxId: 'outbox-b' })),
    { code: 'CORE_OPERATION_KEY_CONFLICT' },
  );
  await core.close();

  const db = openTestInspector(dbPath);
  assert.deepEqual(
    { ...db.prepare(`SELECT state,revision,fence_token,lease_owner,lease_until
      FROM projection_outbox WHERE projection_outbox_id='outbox-b'`).get() },
    { state: 'pending', revision: 0, fence_token: 0, lease_owner: null, lease_until: null },
  );
  assert.equal(db.prepare("SELECT count(*) AS count FROM fence WHERE projector_cursor_id='cursor'").get().count, 1);
  db.close();
});

test('Work Run replay binds every caller-controlled semantic field and returns the first receipt', async (t) => {
  const { core, dbPath } = await setupWorkRun(t);
  const base = {
    workRunId: 'run', expectedRevision: 0, expectedFence: 0, nextFence: 1,
    nextState: 'running', reasonCode: 'lease_rotated', sourceEventId: 'run-event',
    rotationOperationKey: 'run:binding:1', updatedAt: LATER,
  };
  const first = await core.writer.write((tx) => tx.revisions.rotateWorkRunFence(base));
  const replay = await core.writer.write((tx) => tx.revisions.rotateWorkRunFence(base));
  assert.equal(first.disposition, 'applied');
  assert.equal(replay.disposition, 'already_applied');
  assert.deepEqual(withoutDisposition(replay), withoutDisposition(first));
  assert.match(first.operation_semantic_digest, /^sha256:v1:[0-9a-f]{64}$/);
  const laterState = await core.writer.write((tx) => tx.revisions.compareAndSetWorkRunState({
    workRunId: 'run', expectedRevision: 1, expectedFence: 1,
    nextState: 'waiting', updatedAt: LATER,
  }));
  assert.equal(laterState.state, 'waiting');
  const historicalReplay = await core.writer.write((tx) => tx.revisions.rotateWorkRunFence(base));
  assert.equal(historicalReplay.state, 'running');
  assert.equal(historicalReplay.revision, 1);

  for (const changed of [
    { reasonCode: 'restart' },
    { sourceEventId: 'different-event' },
    { expectedRevision: 1, expectedFence: 1, nextFence: 2 },
  ]) {
    await assert.rejects(
      core.writer.write((tx) => tx.revisions.rotateWorkRunFence({ ...base, ...changed })),
      { code: 'CORE_OPERATION_KEY_CONFLICT' },
    );
  }
  await core.close();
  const reopened = openCoreDatabase({ dbPath });
  const durableReplay = await reopened.writer.write((tx) => tx.revisions.rotateWorkRunFence(base));
  assert.equal(durableReplay.disposition, 'already_applied');
  assert.deepEqual(withoutDisposition(durableReplay), withoutDisposition(first));
  await reopened.close();

  const db = openTestInspector(dbPath);
  assert.deepEqual(
    { ...db.prepare("SELECT state,revision,fence_token FROM work_run WHERE work_run_id='run'").get() },
    { state: 'waiting', revision: 2, fence_token: 1 },
  );
  assert.equal(db.prepare("SELECT count(*) AS count FROM fence WHERE work_run_id='run'").get().count, 1);
  db.close();
});

test('concurrent Work Run requests apply one semantic operation and never alias a conflict', async (t) => {
  const { core, dbPath } = await setupWorkRun(t);
  const base = {
    workRunId: 'run', expectedRevision: 0, expectedFence: 0, nextFence: 1,
    nextState: 'running', reasonCode: 'lease_rotated', sourceEventId: 'run-event',
    rotationOperationKey: 'run:concurrent:1', updatedAt: LATER,
  };
  const identical = await Promise.all([
    core.writer.write((tx) => tx.revisions.rotateWorkRunFence(base)),
    core.writer.write((tx) => tx.revisions.rotateWorkRunFence(base)),
  ]);
  assert.deepEqual(identical.map((item) => item.disposition), ['applied', 'already_applied']);
  assert.deepEqual(withoutDisposition(identical[1]), withoutDisposition(identical[0]));
  await assert.rejects(
    core.writer.write((tx) => tx.revisions.rotateWorkRunFence({ ...base, nextState: 'waiting' })),
    { code: 'CORE_OPERATION_KEY_CONFLICT' },
  );
  await core.close();
  const db = openTestInspector(dbPath);
  assert.equal(db.prepare('SELECT count(*) AS count FROM fence').get().count, 1);
  assert.deepEqual(
    { ...db.prepare("SELECT state,revision,fence_token FROM work_run WHERE work_run_id='run'").get() },
    { state: 'running', revision: 1, fence_token: 1 },
  );
  db.close();
});

test('concurrent Work Run requests with one key and different state produce one commit and one conflict', async (t) => {
  const { core, dbPath } = await setupWorkRun(t);
  const base = {
    workRunId: 'run', expectedRevision: 0, expectedFence: 0, nextFence: 1,
    reasonCode: 'lease_rotated', sourceEventId: 'run-event',
    rotationOperationKey: 'run:race:1', updatedAt: LATER,
  };
  const outcomes = await Promise.allSettled([
    core.writer.write((tx) => tx.revisions.rotateWorkRunFence({ ...base, nextState: 'running' })),
    core.writer.write((tx) => tx.revisions.rotateWorkRunFence({ ...base, nextState: 'waiting' })),
  ]);
  assert.equal(outcomes.filter((item) => item.status === 'fulfilled').length, 1);
  const rejected = outcomes.find((item) => item.status === 'rejected');
  assert.equal(rejected.reason.code, 'CORE_OPERATION_KEY_CONFLICT');
  await core.close();
  const db = openTestInspector(dbPath);
  assert.equal(db.prepare('SELECT count(*) AS count FROM fence').get().count, 1);
  assert.equal(db.prepare("SELECT revision FROM work_run WHERE work_run_id='run'").get().revision, 1);
  db.close();
});

test('projector replay returns the first durable outbox and lease across reopen', async (t) => {
  const { core, dbPath } = await setupProjection(t);
  const base = {
    cursorId: 'cursor', outboxId: 'outbox-a', expectedCursorRevision: 0,
    expectedCursorFence: 0, expectedOutboxRevision: 0, leaseOwner: 'worker-a',
    leaseUntil: LATER, rotationOperationKey: 'cursor:durable:1', updatedAt: AT,
  };
  const first = await core.writer.write((tx) => tx.projections.claim(base));
  const replay = await core.writer.write((tx) => tx.projections.claim(base));
  assert.equal(replay.disposition, 'already_applied');
  assert.deepEqual(withoutDisposition(replay), withoutDisposition(first));
  assert.equal(replay.outbox.projection_outbox_id, 'outbox-a');
  assert.equal(replay.outbox.lease_owner, 'worker-a');
  await core.writer.write((tx) => tx.projections.recordFailure({
    cursorId: 'cursor', outboxId: 'outbox-a', expectedCursorRevision: 1,
    expectedOutboxRevision: 1, fenceToken: 1, leaseOwner: 'worker-a',
    nextAttemptAt: LATER, updatedAt: LATER,
  }));
  const historicalReplay = await core.writer.write((tx) => tx.projections.claim(base));
  assert.equal(historicalReplay.outbox.state, 'reserved');
  assert.equal(historicalReplay.outbox.revision, 1);
  assert.equal(historicalReplay.outbox.lease_owner, 'worker-a');
  await core.close();

  const reopened = openCoreDatabase({ dbPath });
  const durableReplay = await reopened.writer.write((tx) => tx.projections.claim(base));
  assert.equal(durableReplay.disposition, 'already_applied');
  assert.deepEqual(withoutDisposition(durableReplay), withoutDisposition(first));
  await reopened.close();
});

test('projector operation digest binds outbox, source revision, and lease owner with zero conflict writes', async (t) => {
  const { core, dbPath } = await setupProjection(t);
  const base = {
    cursorId: 'cursor', outboxId: 'outbox-a', expectedCursorRevision: 0,
    expectedCursorFence: 0, expectedOutboxRevision: 0, leaseOwner: 'worker-a',
    leaseUntil: LATER, rotationOperationKey: 'cursor:binding:1', updatedAt: AT,
  };
  await core.writer.write((tx) => tx.projections.claim(base));
  for (const changed of [
    { outboxId: 'outbox-b' },
    { outboxId: 'outbox-c' },
    { leaseOwner: 'worker-b' },
    { expectedCursorRevision: 1, expectedCursorFence: 1 },
  ]) {
    await assert.rejects(
      core.writer.write((tx) => tx.projections.claim({ ...base, ...changed })),
      { code: 'CORE_OPERATION_KEY_CONFLICT' },
    );
  }
  await core.close();
  const db = openTestInspector(dbPath);
  assert.deepEqual(
    { ...db.prepare(`SELECT state,revision,fence_token,lease_owner,lease_until
      FROM projection_outbox WHERE projection_outbox_id='outbox-b'`).get() },
    { state: 'pending', revision: 0, fence_token: 0, lease_owner: null, lease_until: null },
  );
  const receipt = { ...db.prepare("SELECT * FROM fence WHERE projector_cursor_id='cursor'").get() };
  assert.equal(receipt.claimed_projection_outbox_id, 'outbox-a');
  assert.match(receipt.operation_semantic_digest, /^sha256:v1:[0-9a-f]{64}$/);
  assert.equal(db.prepare("SELECT count(*) AS count FROM fence WHERE projector_cursor_id='cursor'").get().count, 1);
  db.close();
});

test('concurrent projector claims preserve one real result identity', async (t) => {
  const { core, dbPath } = await setupProjection(t);
  const base = {
    cursorId: 'cursor', outboxId: 'outbox-a', expectedCursorRevision: 0,
    expectedCursorFence: 0, expectedOutboxRevision: 0, leaseOwner: 'worker-a',
    leaseUntil: LATER, rotationOperationKey: 'cursor:concurrent:1', updatedAt: AT,
  };
  const identical = await Promise.all([
    core.writer.write((tx) => tx.projections.claim(base)),
    core.writer.write((tx) => tx.projections.claim(base)),
  ]);
  assert.deepEqual(identical.map((item) => item.disposition), ['applied', 'already_applied']);
  assert.equal(identical[1].outbox.projection_outbox_id, 'outbox-a');
  await assert.rejects(
    core.writer.write((tx) => tx.projections.claim({ ...base, outboxId: 'outbox-b' })),
    { code: 'CORE_OPERATION_KEY_CONFLICT' },
  );
  await core.close();
  const db = openTestInspector(dbPath);
  assert.equal(db.prepare('SELECT count(*) AS count FROM fence').get().count, 1);
  assert.equal(db.prepare("SELECT state FROM projection_outbox WHERE projection_outbox_id='outbox-b'").get().state, 'pending');
  db.close();
});

test('concurrent projector requests with one key and different outboxes commit only the winner identity', async (t) => {
  const { core, dbPath } = await setupProjection(t);
  const base = {
    cursorId: 'cursor', expectedCursorRevision: 0, expectedCursorFence: 0,
    expectedOutboxRevision: 0, leaseOwner: 'worker-a', leaseUntil: LATER,
    rotationOperationKey: 'cursor:race:1', updatedAt: AT,
  };
  const outcomes = await Promise.allSettled([
    core.writer.write((tx) => tx.projections.claim({ ...base, outboxId: 'outbox-a' })),
    core.writer.write((tx) => tx.projections.claim({ ...base, outboxId: 'outbox-b' })),
  ]);
  assert.equal(outcomes.filter((item) => item.status === 'fulfilled').length, 1);
  const rejected = outcomes.find((item) => item.status === 'rejected');
  assert.equal(rejected.reason.code, 'CORE_OPERATION_KEY_CONFLICT');
  await core.close();
  const db = openTestInspector(dbPath);
  const receipt = db.prepare('SELECT claimed_projection_outbox_id FROM fence').get();
  assert.equal(receipt.claimed_projection_outbox_id, 'outbox-a');
  assert.deepEqual(
    { ...db.prepare(`SELECT state,revision,fence_token,lease_owner
      FROM projection_outbox WHERE projection_outbox_id='outbox-b'`).get() },
    { state: 'pending', revision: 0, fence_token: 0, lease_owner: null },
  );
  db.close();
});

test('operation digest format is enforced by SQLite and failed direct rotation leaves no receipt', async (t) => {
  const { core, dbPath } = await setupWorkRun(t);
  await core.close();
  const db = openTestInspector(dbPath, { readOnly: false });
  assert.throws(() => db.prepare(`UPDATE work_run SET
    state='running',revision=1,fence_token=1,fence_reason_code='lease_rotated',
    fence_causation_id='run-event',fence_operation_key='run:invalid:1',
    fence_operation_digest='sha256:v1:ABC',fence_committed_at=?,updated_at=?
    WHERE work_run_id='run' AND revision=0 AND fence_token=0`).run(LATER, LATER));
  assert.deepEqual(
    { ...db.prepare("SELECT state,revision,fence_token FROM work_run WHERE work_run_id='run'").get() },
    { state: 'queued', revision: 0, fence_token: 0 },
  );
  assert.equal(db.prepare('SELECT count(*) AS count FROM fence').get().count, 0);
  db.close();
});
