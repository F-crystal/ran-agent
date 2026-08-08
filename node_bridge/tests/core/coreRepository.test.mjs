import assert from 'node:assert/strict';
import test from 'node:test';

import { openCoreDatabase } from '../../src/core/coreDb.mjs';
import { createTempCore, openTestInspector } from './helpers/testCoreInspector.mjs';

const AT = '2026-07-16T00:00:00.000Z';
const LATER = '2026-07-16T00:01:00.000Z';

function setup(t) {
  const { dbPath } = createTempCore(t, 'hermes-core-repo-');
  const core = openCoreDatabase({ dbPath });
  core.migrate();
  return { core, dbPath, writer: core.writer };
}

function event(tx, id, revision = 0) {
  return tx.journal.append({
    eventId: id, eventType: 'test', originRef: 'fixture', sourceKind: 'test',
    sourceRef: 'fixture', revision, createdAt: AT,
  });
}

test('append audit primitives retain revision, source and scoped operation identity', async (t) => {
  const { core, writer } = setup(t);
  await writer.write((tx) => {
    event(tx, 'j1');
    tx.tombstones.append({
      tombstoneId: 't1', subjectType: 'journal_event', subjectId: 'j1',
      subjectRevision: 0, reasonCode: 'forget', sourceEventId: 'j1',
      sourceRevision: 0, causationId: 'j1', createdAt: AT,
    });
    tx.publications.append({
      publicationId: 'pub1', operationScope: 'fixture:a', operationKey: 'publish:1',
      subjectType: 'journal_event', subjectId: 'j1', subjectRevision: 0,
      target: 'fixture', disposition: 'requested', sourceEventId: 'j1',
      sourceRevision: 0, causationId: 'j1', createdAt: AT,
    });
    tx.publications.append({
      publicationId: 'pub2', operationScope: 'fixture:b', operationKey: 'publish:1',
      subjectType: 'journal_event', subjectId: 'j1', subjectRevision: 0,
      target: 'other', disposition: 'requested', sourceEventId: 'j1',
      sourceRevision: 0, causationId: 'j1', createdAt: AT,
    });
  });
  await assert.rejects(writer.write((tx) => tx.publications.append({
    publicationId: 'pub3', operationScope: 'fixture:a', operationKey: 'publish:1',
    subjectType: 'journal_event', subjectId: 'j1', subjectRevision: 0,
    target: 'fixture', disposition: 'requested', sourceEventId: 'j1',
    sourceRevision: 0, causationId: 'j1', createdAt: AT,
  })), { code: 'CORE_WRITE_FAILED' });
  await core.close();
  const db = openTestInspector(core.dbPath);
  assert.equal(db.prepare('SELECT count(*) AS count FROM payload_tombstone').get().count, 1);
  assert.equal(db.prepare('SELECT count(*) AS count FROM publication_ledger').get().count, 2);
  db.close();
});

test('trusted ingress is idempotent only within source instance; absent and untrusted remain distinct', async (t) => {
  const { core, writer } = setup(t);
  const trusted = (tx, id, sourceInstanceId = 'wechat:bot-a') => tx.ingress.append({
    ingressEventId: id, sourceInstanceId, platform: 'wechat', nativeEventId: 'native-1',
    nativeEventIdTrust: 'trusted', idempotencyDisposition: 'native_exact',
    receivedAt: AT, createdAt: AT,
  });
  const first = await writer.write((tx) => trusted(tx, 'i1'));
  const duplicate = await writer.write((tx) => trusted(tx, 'i2'));
  const otherSource = await writer.write((tx) => trusted(tx, 'i3', 'wechat:bot-b'));
  assert.equal(first.disposition, 'inserted');
  assert.equal(duplicate.disposition, 'duplicate');
  assert.equal(duplicate.row.ingress_event_id, 'i1');
  assert.equal(otherSource.disposition, 'inserted');

  for (const id of ['absent-1', 'absent-2']) {
    await writer.write((tx) => tx.ingress.append({
      ingressEventId: id, sourceInstanceId: 'desktop:local', platform: 'desktop',
      nativeEventIdTrust: 'absent', idempotencyDisposition: 'internal_only',
      receivedAt: AT, createdAt: AT,
    }));
  }
  for (const id of ['untrusted-1', 'untrusted-2']) {
    await writer.write((tx) => tx.ingress.append({
      ingressEventId: id, sourceInstanceId: 'fixture', platform: 'desktop',
      nativeEventId: 'same-text-derived-id', nativeEventIdTrust: 'untrusted',
      idempotencyDisposition: 'internal_only', receivedAt: AT, createdAt: AT,
    }));
  }
  assert.equal(core.reader.ingressEventCount(), 6);
  await assert.rejects(writer.write((tx) => tx.ingress.append({
    ingressEventId: 'bad-trusted-null', sourceInstanceId: 'fixture', platform: 'wechat',
    nativeEventIdTrust: 'trusted', idempotencyDisposition: 'native_exact',
    receivedAt: AT, createdAt: AT,
  })), { code: 'CORE_INGRESS_TRUST_INVALID' });
  await assert.rejects(writer.write((tx) => tx.ingress.append({
    ingressEventId: 'bad-trusted-empty', sourceInstanceId: 'fixture', platform: 'wechat',
    nativeEventId: '   ', nativeEventIdTrust: 'trusted', idempotencyDisposition: 'native_exact',
    receivedAt: AT, createdAt: AT,
  })), { code: 'CORE_INGRESS_TRUST_INVALID' });
  await assert.rejects(writer.write((tx) => tx.ingress.append({
    ingressEventId: 'bad-absent-sentinel', sourceInstanceId: 'fixture', platform: 'wechat',
    nativeEventId: 'unknown', nativeEventIdTrust: 'absent', idempotencyDisposition: 'internal_only',
    receivedAt: AT, createdAt: AT,
  })), { code: 'CORE_INGRESS_TRUST_INVALID' });
  assert.equal(core.reader.ingressEventCount(), 6);
  await core.close();
});

test('projector cursor reservation, failure and CAS commit are separate and durable', async (t) => {
  const { core, dbPath, writer } = setup(t);
  await writer.write((tx) => {
    event(tx, 'j1');
    event(tx, 'j2');
    tx.projections.createCursor({ cursorId: 'cursor', projectorId: 'everos', targetScope: 'owner', createdAt: AT });
    tx.projections.reserve({
      outboxId: 'o1', operationScope: 'everos:owner', operationKey: 'j1:0',
      projectorId: 'everos', targetScope: 'owner', sourceEventId: 'j1',
      sourceRevision: 0, payloadRef: 'payload:j1', createdAt: AT,
    });
  });
  const claim1 = await writer.write((tx) => tx.projections.claim({
    cursorId: 'cursor', outboxId: 'o1', expectedCursorRevision: 0,
    expectedCursorFence: 0, expectedOutboxRevision: 0, leaseOwner: 'worker-a',
    leaseUntil: LATER, rotationOperationKey: 'cursor:o1:claim:1', updatedAt: AT,
  }));
  const claim1Replay = await writer.write((tx) => tx.projections.claim({
    cursorId: 'cursor', outboxId: 'o1', expectedCursorRevision: 0,
    expectedCursorFence: 0, expectedOutboxRevision: 0, leaseOwner: 'worker-a',
    leaseUntil: LATER, rotationOperationKey: 'cursor:o1:claim:1', updatedAt: AT,
  }));
  assert.equal(claim1.disposition, 'applied');
  assert.equal(claim1Replay.disposition, 'already_applied');
  assert.equal(claim1Replay.cursor.fence_token, 1);
  assert.equal(claim1.outbox.source_entity_type, 'journal_event');
  assert.equal(claim1.outbox.source_entity_id, 'j1');
  assert.equal(claim1.cursor.fence_token, 1);
  assert.equal(await writer.write((tx) => tx.projections.commitCursor({
    cursorId: 'cursor', outboxId: 'o1', expectedCursorRevision: 99,
    expectedOutboxRevision: 1, fenceToken: 1, leaseOwner: 'worker-a', updatedAt: AT,
  })), null);
  const failedCursor = await writer.write((tx) => tx.projections.recordFailure({
    cursorId: 'cursor', outboxId: 'o1', expectedCursorRevision: 1,
    expectedOutboxRevision: 1, fenceToken: 1, leaseOwner: 'worker-a',
    nextAttemptAt: LATER, updatedAt: AT,
  }));
  assert.equal(failedCursor.committed_source_sequence, null);
  assert.equal(core.reader.projectionOutbox('o1').state, 'failed');

  const claim2 = await writer.write((tx) => tx.projections.claim({
    cursorId: 'cursor', outboxId: 'o1', expectedCursorRevision: 2,
    expectedCursorFence: 1, expectedOutboxRevision: 2, leaseOwner: 'worker-b',
    leaseUntil: LATER, rotationOperationKey: 'cursor:o1:claim:2', updatedAt: LATER,
  }));
  const committed = await writer.write((tx) => tx.projections.commitCursor({
    cursorId: 'cursor', outboxId: 'o1', expectedCursorRevision: 3,
    expectedOutboxRevision: 3, fenceToken: claim2.cursor.fence_token,
    leaseOwner: 'worker-b', updatedAt: LATER,
  }));
  assert.ok(committed.cursor.committed_source_sequence >= 1);
  const idempotent = await writer.write((tx) => tx.projections.commitCursor({
    cursorId: 'cursor', outboxId: 'o1', expectedCursorRevision: 0,
    expectedOutboxRevision: 0, fenceToken: 0, leaseOwner: 'stale', updatedAt: LATER,
  }));
  assert.equal(idempotent.cursor.committed_source_sequence, committed.cursor.committed_source_sequence);
  await core.close();

  const reopened = openCoreDatabase({ dbPath });
  assert.equal(reopened.reader.projectorCursor('everos', 'owner').committed_source_sequence, committed.cursor.committed_source_sequence);
  assert.equal(reopened.reader.projectionOutbox('o1').state, 'completed');
  await reopened.close();
});

test('cursor cannot regress and stale reservation cannot advance it', async (t) => {
  const { core, writer } = setup(t);
  await writer.write((tx) => {
    event(tx, 'j1');
    event(tx, 'j2');
    tx.projections.createCursor({ cursorId: 'cursor', projectorId: 'vault', targetScope: 'owner', createdAt: AT });
    tx.projections.reserve({ outboxId: 'new', operationScope: 'vault', operationKey: 'new', projectorId: 'vault', targetScope: 'owner', sourceEventId: 'j2', sourceRevision: 0, createdAt: AT });
  });
  const newClaim = await writer.write((tx) => tx.projections.claim({ cursorId: 'cursor', outboxId: 'new', expectedCursorRevision: 0, expectedCursorFence: 0, expectedOutboxRevision: 0, leaseOwner: 'worker', leaseUntil: LATER, rotationOperationKey: 'cursor:new:claim', updatedAt: AT }));
  await writer.write((tx) => tx.projections.commitCursor({ cursorId: 'cursor', outboxId: 'new', expectedCursorRevision: 1, expectedOutboxRevision: 1, fenceToken: newClaim.cursor.fence_token, leaseOwner: 'worker', updatedAt: AT }));
  const before = core.reader.projectorCursor('vault', 'owner');
  await writer.write((tx) => tx.projections.reserve({ outboxId: 'old', operationScope: 'vault', operationKey: 'old', projectorId: 'vault', targetScope: 'owner', sourceEventId: 'j1', sourceRevision: 0, createdAt: AT }));
  await assert.rejects(writer.write((tx) => {
    const claim = tx.projections.claim({ cursorId: 'cursor', outboxId: 'old', expectedCursorRevision: before.revision, expectedCursorFence: before.fence_token, expectedOutboxRevision: 0, leaseOwner: 'stale-worker', leaseUntil: LATER, rotationOperationKey: 'cursor:old:claim', updatedAt: LATER });
    return tx.projections.commitCursor({ cursorId: 'cursor', outboxId: 'old', expectedCursorRevision: claim.cursor.revision, expectedOutboxRevision: claim.outbox.revision, fenceToken: claim.cursor.fence_token, leaseOwner: 'stale-worker', updatedAt: LATER });
  }), { code: 'CORE_CURSOR_REGRESSION' });
  const after = core.reader.projectorCursor('vault', 'owner');
  assert.equal(after.committed_source_sequence, before.committed_source_sequence);
  assert.equal(after.revision, before.revision);
  assert.equal(core.reader.projectionOutbox('old').state, 'pending');
  await core.close();
});

test('old source revision cannot commit even with a valid reservation lease and fence', async (t) => {
  const { core, dbPath, writer } = setup(t);
  await writer.write((tx) => {
    event(tx, 'source', 1);
    tx.projections.createCursor({ cursorId: 'cursor', projectorId: 'everos', targetScope: 'owner', createdAt: AT });
    tx.projections.reserve({
      outboxId: 'old', operationScope: 'everos', operationKey: 'source:1',
      projectorId: 'everos', targetScope: 'owner', sourceEventId: 'source',
      sourceRevision: 1, createdAt: AT,
    });
  });
  const claim = await writer.write((tx) => tx.projections.claim({
    cursorId: 'cursor', outboxId: 'old', expectedCursorRevision: 0,
    expectedCursorFence: 0, expectedOutboxRevision: 0, leaseOwner: 'worker-old',
    leaseUntil: LATER, rotationOperationKey: 'cursor:old:claim', updatedAt: AT,
  }));
  const mutator = openTestInspector(dbPath, { readOnly: false });
  mutator.prepare("UPDATE journal_event SET revision=2 WHERE journal_event_id='source'").run();
  mutator.close();
  const result = await writer.write((tx) => tx.projections.commitCursor({
    cursorId: 'cursor', outboxId: 'old', expectedCursorRevision: claim.cursor.revision,
    expectedOutboxRevision: claim.outbox.revision, fenceToken: claim.cursor.fence_token,
    leaseOwner: 'worker-old', updatedAt: LATER,
  }));
  assert.equal(result.disposition, 'stale_source');
  assert.equal(core.reader.projectorCursor('everos', 'owner').committed_source_sequence, null);
  assert.equal(core.reader.projectionOutbox('old').state, 'stale');
  await core.close();
  const reopened = openCoreDatabase({ dbPath });
  assert.equal(reopened.reader.projectorCursor('everos', 'owner').committed_source_sequence, null);
  assert.equal(reopened.reader.projectionOutbox('old').state, 'stale');
  await reopened.close();
});

test('tombstoned or invalidated source cannot advance cursor and a later current reservation can', async (t) => {
  const { core, writer } = setup(t);
  await writer.write((tx) => {
    event(tx, 'source', 1);
    event(tx, 'tombstone-event', 0);
    tx.projections.createCursor({ cursorId: 'cursor', projectorId: 'vault', targetScope: 'owner', createdAt: AT });
    tx.projections.reserve({
      outboxId: 'stale', operationScope: 'vault', operationKey: 'source:1',
      projectorId: 'vault', targetScope: 'owner', sourceEventId: 'source',
      sourceRevision: 1, createdAt: AT,
    });
  });
  const staleClaim = await writer.write((tx) => tx.projections.claim({
    cursorId: 'cursor', outboxId: 'stale', expectedCursorRevision: 0,
    expectedCursorFence: 0, expectedOutboxRevision: 0, leaseOwner: 'old-worker',
    leaseUntil: LATER, rotationOperationKey: 'cursor:stale:claim', updatedAt: AT,
  }));
  await writer.write((tx) => tx.tombstones.append({
    tombstoneId: 'source-tombstone', subjectType: 'journal_event', subjectId: 'source',
    subjectRevision: 1, reasonCode: 'superseded', sourceEventId: 'tombstone-event',
    sourceRevision: 0, causationId: 'tombstone-event', createdAt: AT,
  }));
  const stale = await writer.write((tx) => tx.projections.commitCursor({
    cursorId: 'cursor', outboxId: 'stale', expectedCursorRevision: staleClaim.cursor.revision,
    expectedOutboxRevision: staleClaim.outbox.revision, fenceToken: staleClaim.cursor.fence_token,
    leaseOwner: 'old-worker', updatedAt: LATER,
  }));
  assert.equal(stale.disposition, 'stale_source');
  assert.equal(core.reader.projectorCursor('vault', 'owner').committed_source_sequence, null);
  assert.equal(core.reader.projectionOutbox('stale').state, 'stale');

  await writer.write((tx) => {
    event(tx, 'current', 2);
    tx.projections.reserve({
      outboxId: 'current-outbox', operationScope: 'vault', operationKey: 'current:2',
      projectorId: 'vault', targetScope: 'owner', sourceEventId: 'current',
      sourceRevision: 2, createdAt: LATER,
    });
  });
  const currentCursor = core.reader.projectorCursor('vault', 'owner');
  const currentClaim = await writer.write((tx) => tx.projections.claim({
    cursorId: 'cursor', outboxId: 'current-outbox',
    expectedCursorRevision: currentCursor.revision,
    expectedCursorFence: currentCursor.fence_token, expectedOutboxRevision: 0,
    leaseOwner: 'current-worker', leaseUntil: LATER,
    rotationOperationKey: 'cursor:current:claim', updatedAt: LATER,
  }));
  const committed = await writer.write((tx) => tx.projections.commitCursor({
    cursorId: 'cursor', outboxId: 'current-outbox',
    expectedCursorRevision: currentClaim.cursor.revision,
    expectedOutboxRevision: currentClaim.outbox.revision,
    fenceToken: currentClaim.cursor.fence_token, leaseOwner: 'current-worker', updatedAt: LATER,
  }));
  assert.equal(committed.disposition, 'committed');
  const again = await writer.write((tx) => tx.projections.commitCursor({
    cursorId: 'cursor', outboxId: 'current-outbox',
    expectedCursorRevision: 0, expectedOutboxRevision: 0,
    fenceToken: 0, leaseOwner: 'old', updatedAt: LATER,
  }));
  assert.equal(again.disposition, 'already_committed');
  await core.close();
});

test('source invalidation timestamp makes an otherwise valid reservation stale', async (t) => {
  const { core, dbPath, writer } = setup(t);
  await writer.write((tx) => {
    event(tx, 'source', 3);
    tx.projections.createCursor({ cursorId: 'cursor', projectorId: 'ombre', targetScope: 'owner', createdAt: AT });
    tx.projections.reserve({
      outboxId: 'outbox', operationScope: 'ombre', operationKey: 'source:3',
      projectorId: 'ombre', targetScope: 'owner', sourceEventId: 'source',
      sourceRevision: 3, createdAt: AT,
    });
  });
  const claim = await writer.write((tx) => tx.projections.claim({
    cursorId: 'cursor', outboxId: 'outbox', expectedCursorRevision: 0,
    expectedCursorFence: 0, expectedOutboxRevision: 0,
    leaseOwner: 'worker', leaseUntil: LATER,
    rotationOperationKey: 'cursor:outbox:claim', updatedAt: AT,
  }));
  const raw = openTestInspector(dbPath, { readOnly: false });
  raw.prepare("UPDATE journal_event SET invalidated_at=? WHERE journal_event_id='source'").run(LATER);
  raw.close();
  const result = await writer.write((tx) => tx.projections.commitCursor({
    cursorId: 'cursor', outboxId: 'outbox',
    expectedCursorRevision: claim.cursor.revision,
    expectedOutboxRevision: claim.outbox.revision,
    fenceToken: claim.cursor.fence_token, leaseOwner: 'worker', updatedAt: LATER,
  }));
  assert.equal(result.disposition, 'stale_source');
  assert.equal(result.cursor.committed_source_sequence, null);
  assert.equal(result.outbox.state, 'stale');
  await core.close();
});

test('Work Run state CAS keeps fence unchanged and fence rotation is strictly increasing', async (t) => {
  const { core, dbPath, writer } = setup(t);
  await core.close();
  const db = openTestInspector(dbPath, { readOnly: false });
  db.prepare(`INSERT INTO journal_event(
    journal_event_id,event_type,origin_ref,source_kind,source_ref,revision,created_at
  ) VALUES ('run-event','test','fixture','test','fixture',0,?)`).run(AT);
  db.prepare(`INSERT INTO work_run(
    work_run_id, attempt_no, execution_epoch_id, state, revision, fence_token,
    contract_revision, created_at, updated_at
  ) VALUES (?, 1, ?, 'queued', 0, 0, 0, ?, ?)`).run('run', 'epoch', AT, AT);
  db.close();
  const reopened = openCoreDatabase({ dbPath });
  reopened.migrate();
  for (let fence = 0; fence < 4; fence += 1) {
    const rotated = await reopened.writer.write((tx) => tx.revisions.rotateWorkRunFence({
      workRunId: 'run', expectedRevision: fence, expectedFence: fence,
      nextFence: fence + 1, nextState: 'running',
      reasonCode: 'lease_rotated', sourceEventId: 'run-event',
      rotationOperationKey: `run:rotation:${fence + 1}`, updatedAt: LATER,
    }));
    assert.equal(rotated.fence_token, fence + 1);
  }
  assert.equal(await reopened.writer.write((tx) => tx.revisions.rotateWorkRunFence({
    workRunId: 'run', expectedRevision: 4, expectedFence: 3,
    nextFence: 4, nextState: 'running',
    reasonCode: 'lease_rotated', sourceEventId: 'run-event',
    rotationOperationKey: 'run:stale', updatedAt: LATER,
  })), null);
  await assert.rejects(reopened.writer.write((tx) => tx.revisions.rotateWorkRunFence({
    workRunId: 'run', expectedRevision: 4, expectedFence: 4,
    nextFence: 3, nextState: 'running',
    reasonCode: 'lease_rotated', sourceEventId: 'run-event',
    rotationOperationKey: 'run:backwards', updatedAt: LATER,
  })), { code: 'CORE_FENCE_STEP_INVALID' });
  const unchangedFence = await reopened.writer.write((tx) => tx.revisions.compareAndSetWorkRunState({
    workRunId: 'run', expectedRevision: 4, expectedFence: 4,
    nextState: 'running', updatedAt: LATER,
  }));
  assert.equal(unchangedFence.fence_token, 4);
  const changed = await reopened.writer.write((tx) => tx.revisions.rotateWorkRunFence({
    workRunId: 'run', expectedRevision: 5, expectedFence: 4,
    nextFence: 5, nextState: 'running',
    reasonCode: 'lease_rotated', sourceEventId: 'run-event',
    rotationOperationKey: 'run:rotation:5', updatedAt: LATER,
  }));
  assert.equal(changed.revision, 6);
  assert.equal(changed.fence_token, 5);
  const candidates = await Promise.all([
    reopened.writer.write((tx) => tx.revisions.rotateWorkRunFence({
      workRunId: 'run', expectedRevision: 6, expectedFence: 5,
      nextFence: 6, nextState: 'running',
      reasonCode: 'lease_rotated', sourceEventId: 'run-event',
      rotationOperationKey: 'run:rotation:6:a', updatedAt: LATER,
    })),
    reopened.writer.write((tx) => tx.revisions.rotateWorkRunFence({
      workRunId: 'run', expectedRevision: 6, expectedFence: 5,
      nextFence: 6, nextState: 'running',
      reasonCode: 'lease_rotated', sourceEventId: 'run-event',
      rotationOperationKey: 'run:rotation:6:b', updatedAt: LATER,
    })),
  ]);
  assert.equal(candidates.filter(Boolean).length, 1);
  await reopened.close();
  const raw = openTestInspector(dbPath, { readOnly: false });
  const persisted = { ...raw.prepare("SELECT revision,fence_token FROM work_run WHERE work_run_id='run'").get() };
  assert.deepEqual(persisted, { revision: 7, fence_token: 6 });
  assert.equal(raw.prepare("SELECT count(*) AS count FROM fence WHERE domain='work_run' AND work_run_id='run'").get().count, 6);
  assert.throws(() => raw.prepare("UPDATE work_run SET fence_token=4 WHERE work_run_id='run'").run());
  assert.throws(() => raw.prepare("UPDATE work_run SET fence_token=99 WHERE work_run_id='run'").run());
  assert.deepEqual({ ...raw.prepare("SELECT revision,fence_token FROM work_run WHERE work_run_id='run'").get() }, persisted);
  raw.close();
  const finalReopen = openCoreDatabase({ dbPath });
  assert.equal(finalReopen.reader.schemaVersion(), 2);
  await finalReopen.close();
});

test('two SQLite handles observe the same revision/fence CAS boundary', async (t) => {
  const { core, dbPath } = setup(t);
  await core.close();
  const seed = openTestInspector(dbPath, { readOnly: false });
  seed.prepare(`INSERT INTO journal_event(
    journal_event_id,event_type,origin_ref,source_kind,source_ref,revision,created_at
  ) VALUES ('shared-event','test','fixture','test','fixture',0,?)`).run(AT);
  seed.prepare(`INSERT INTO work_run(
    work_run_id,attempt_no,execution_epoch_id,state,revision,fence_token,
    contract_revision,created_at,updated_at
  ) VALUES ('shared',1,'epoch','queued',0,0,0,?,?)`).run(AT, AT);
  seed.close();
  const first = openTestInspector(dbPath, { readOnly: false });
  const second = openTestInspector(dbPath, { readOnly: false });
  const sql = `UPDATE work_run SET revision=1,fence_token=1,
    fence_reason_code='writer_handoff',fence_causation_id='shared-event',
    fence_operation_key='shared:handoff:1',
    fence_operation_digest='sha256:v1:${'b'.repeat(64)}',
    fence_committed_at=?,updated_at=?
    WHERE work_run_id='shared' AND revision=0 AND fence_token=0`;
  const won = first.prepare(sql).run(LATER, LATER);
  const stale = second.prepare(sql).run(LATER, LATER);
  assert.equal(won.changes, 1);
  assert.equal(stale.changes, 0);
  assert.deepEqual({ ...second.prepare("SELECT revision,fence_token FROM work_run WHERE work_run_id='shared'").get() }, { revision: 1, fence_token: 1 });
  assert.equal(second.prepare("SELECT count(*) AS count FROM fence WHERE work_run_id='shared'").get().count, 1);
  first.close();
  second.close();
});
