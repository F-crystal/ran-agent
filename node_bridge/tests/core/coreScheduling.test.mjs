import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { openCoreDatabase } from '../../src/core/coreDb.mjs';
import { createCoreSchedulingService } from '../../src/core/coreScheduling.mjs';
import { createTempCore, openTestInspector } from './helpers/testCoreInspector.mjs';

const CAUSATION_AT = '2026-01-01T00:00:00.000Z';

async function setup(t, start = CAUSATION_AT) {
  const { dbPath } = createTempCore(t, 'hermes-core-scheduling-');
  let current = new Date(start);
  const core = openCoreDatabase({ dbPath, now: () => current });
  core.migrate();
  const service = createCoreSchedulingService({ core, batchSize: 16 });
  await core.writer.write((tx) => {
    tx.journal.append({
      eventId: 'schedule-causation', eventType: 'schedule_requested', ownerId: 'owner',
      originRef: 'fixture', sourceKind: 'test', sourceRef: 'fixture', createdAt: CAUSATION_AT,
    });
    tx.activities.create({
      activityId: 'activity', ownerId: 'owner', title: 'Scheduled work',
      goalRef: 'goal:scheduled', domain: 'personal', riskClass: 'reversible',
      autonomyLevel: 1, state: 'active', contractRevision: 0,
      resumePolicy: 'bounded_auto', reportPolicy: 'milestone', createdAt: CAUSATION_AT,
    });
  });
  return { core, service, setNow: (value) => { current = new Date(value); } };
}

function scheduleInput(overrides = {}) {
  return {
    scheduleSpecId: 'schedule', scheduleSpecRevisionId: 'schedule-r1',
    activityId: 'activity', operationKey: 'schedule:create',
    recurrence: { kind: 'one_shot', at: '2026-01-01T00:01:00.000Z' },
    taskKind: 'system_maintenance', payloadRef: 'task:fixture',
    catchUpPolicy: 'latest', activityContractRevision: 0,
    causationId: 'schedule-causation', ...overrides,
  };
}

test('one-shot occurrence and initial WorkRun commit once across duplicate ticks and replay', async (t) => {
  const { core, service, setNow } = await setup(t);
  const input = scheduleInput();
  assert.equal((await service.createSchedule(input)).disposition, 'created');
  assert.deepEqual(await core.writer.write((tx) => tx.schedules.wakeDue({
    batchSize: 16, now: '2099-01-01T00:00:00.000Z',
  })), []);
  setNow('2026-01-01T00:01:00.000Z');
  const ticks = await Promise.all([service.wakeDue(), service.wakeDue()]);
  assert.deepEqual(ticks.map((items) => items.length).sort(), [0, 1]);
  const occurrences = core.reader.wakeOccurrences('schedule');
  assert.equal(occurrences.length, 1);
  assert.equal(occurrences[0].scheduled_for, '2026-01-01T00:01:00.000Z');
  assert.equal(core.reader.workRunsForOccurrence(occurrences[0].wake_occurrence_id).length, 1);
  assert.equal(core.reader.scheduleSpec('schedule').state, 'exhausted');
  assert.equal((await service.createSchedule(input)).disposition, 'already_applied');
  await core.close();
});

test('missed interval latest catch-up creates only the newest slot and never drains old backlog', async (t) => {
  const { core, service, setNow } = await setup(t);
  await service.createSchedule(scheduleInput({
    recurrence: { kind: 'interval', anchorAt: '2026-01-01T00:00:01.000Z', everySeconds: 60 },
  }));
  setNow('2026-01-01T00:05:30.000Z');
  const [result] = await service.wakeDue();
  assert.equal(result.skipped, 5);
  assert.equal(result.occurrences.length, 1);
  assert.equal(result.occurrences[0].scheduled_for, '2026-01-01T00:05:01.000Z');
  assert.equal(result.nextDueAt, '2026-01-01T00:06:01.000Z');
  assert.deepEqual(await service.wakeDue(), []);
  assert.equal(core.reader.wakeOccurrences('schedule').length, 1);
  await core.close();
});

test('bounded interval catch-up is hard-capped and advances beyond the entire missed window', async (t) => {
  const { core, service, setNow } = await setup(t);
  await service.createSchedule(scheduleInput({
    recurrence: { kind: 'interval', anchorAt: '2026-01-01T00:00:01.000Z', everySeconds: 10 },
    catchUpPolicy: 'bounded', catchUpLimit: 3,
  }));
  setNow('2026-01-01T00:02:00.000Z');
  const [result] = await service.wakeDue();
  assert.equal(result.occurrences.length, 3);
  assert.equal(result.skipped, 9);
  assert.deepEqual(result.occurrences.map((row) => row.scheduled_for), [
    '2026-01-01T00:01:31.000Z', '2026-01-01T00:01:41.000Z', '2026-01-01T00:01:51.000Z',
  ]);
  assert.equal(result.nextDueAt, '2026-01-01T00:02:01.000Z');
  assert.deepEqual(await service.wakeDue(), []);
  assert.equal(core.reader.wakeOccurrences('schedule').length, 3);
  await core.close();
});

test('schedule revision replay is stable and new occurrences bind the immutable new head', async (t) => {
  const { core, service, setNow } = await setup(t);
  await service.createSchedule(scheduleInput({
    recurrence: { kind: 'interval', anchorAt: '2026-01-01T00:01:00.000Z', everySeconds: 60 },
  }));
  setNow('2026-01-01T00:00:10.000Z');
  const revision = {
    ...scheduleInput({
      scheduleSpecRevisionId: 'schedule-r2', operationKey: 'schedule:revise:2',
      recurrence: { kind: 'interval', anchorAt: '2026-01-01T00:02:00.000Z', everySeconds: 120 },
      payloadRef: 'task:revised',
    }),
    expectedRevision: 1,
  };
  assert.equal((await service.reviseSchedule(revision)).disposition, 'revised');
  assert.equal((await service.reviseSchedule(revision)).disposition, 'already_applied');
  await assert.rejects(service.reviseSchedule({ ...revision, payloadRef: 'task:conflict' }), {
    code: 'CORE_OPERATION_KEY_CONFLICT',
  });
  setNow('2026-01-01T00:02:00.000Z');
  const [result] = await service.wakeDue();
  assert.equal(result.occurrences.length, 1);
  assert.equal(result.occurrences[0].schedule_spec_revision_id, 'schedule-r2');
  assert.equal(core.reader.scheduleSpec('schedule').revision, 2);
  await core.close();
});

test('scheduled WorkRun claim rechecks Activity authority and replays one lease fence', async (t) => {
  const { core, service, setNow } = await setup(t);
  await service.createSchedule(scheduleInput());
  setNow('2026-01-01T00:01:00.000Z');
  const [wake] = await service.wakeDue();
  const work = core.reader.workRunsForOccurrence(wake.occurrences[0].wake_occurrence_id)[0];
  const claim = {
    workRunId: work.work_run_id, expectedRevision: 0, expectedFence: 0,
    leaseOwner: 'worker', leaseUntil: '2026-01-01T00:02:00.000Z',
    operationKey: 'scheduled-work:claim:1',
  };
  const first = await service.claimWorkRun(claim);
  const replay = await service.claimWorkRun(claim);
  assert.equal(first.disposition, 'applied');
  assert.equal(replay.disposition, 'already_applied');
  assert.equal(first.lease.lease_id, replay.lease.lease_id);
  assert.equal(core.reader.workRun(work.work_run_id).fence_token, 1);
  await assert.rejects(service.claimWorkRun({ ...claim, leaseOwner: 'other' }), {
    code: 'CORE_OPERATION_KEY_CONFLICT',
  });
  await core.close();
});

test('daily recurrence resolves DST gap forward and repeated wall time to the earlier instant', async (t) => {
  const spring = await setup(t, '2026-03-07T12:00:00.000Z');
  await spring.service.createSchedule(scheduleInput({
    recurrence: { kind: 'daily', time: '02:30:00', timeZone: 'America/New_York' },
  }));
  assert.equal(spring.core.reader.scheduleSpec('schedule').next_due_at, '2026-03-08T07:00:00.000Z');
  await spring.core.close();

  const fall = await setup(t, '2026-10-31T12:00:00.000Z');
  await fall.service.createSchedule(scheduleInput({
    recurrence: { kind: 'daily', time: '01:30:00', timeZone: 'America/New_York' },
  }));
  assert.equal(fall.core.reader.scheduleSpec('schedule').next_due_at, '2026-11-01T05:30:00.000Z');
  await fall.core.close();
});

test('message-capable wake creates a typed Exchange but never a chat turn or presentation send', async (t) => {
  const { core } = await setup(t);
  const { dbPath } = core;
  await core.close();
  const seed = openTestInspector(dbPath, { readOnly: false });
  seed.prepare(`INSERT INTO conversation(
    conversation_id,owner_id,state,revision,created_at,updated_at
  ) VALUES ('conversation','owner','active',0,?,?)`).run(CAUSATION_AT, CAUSATION_AT);
  seed.prepare("UPDATE activity SET conversation_id='conversation' WHERE activity_id='activity'").run();
  seed.prepare(`INSERT INTO presentation_binding(
    presentation_binding_id,conversation_id,source_instance_id,platform,destination_ref,
    adapter_metadata_json,state,revision,created_at,updated_at
  ) VALUES ('binding','conversation','feishu-main','feishu','owner-dm','{}','active',0,?,?)`)
    .run(CAUSATION_AT, CAUSATION_AT);
  seed.close();

  let current = new Date(CAUSATION_AT);
  const scheduledCore = openCoreDatabase({ dbPath, now: () => current });
  const service = createCoreSchedulingService({ core: scheduledCore });
  await service.createSchedule(scheduleInput({
    taskKind: 'scheduled_instruction',
    conversationId: 'conversation', presentationBindingId: 'binding', expectedBindingRevision: 0,
  }));
  current = new Date('2026-01-01T00:01:00.000Z');
  const [result] = await service.wakeDue();
  const work = scheduledCore.reader.workRunsForOccurrence(result.occurrences[0].wake_occurrence_id);
  assert.equal(work.length, 1);
  assert.match(work[0].exchange_id, /^scheduled-exchange:v1:/);
  await scheduledCore.close();

  const inspect = openTestInspector(dbPath);
  assert.equal(inspect.prepare('SELECT count(*) AS count FROM semantic_turn').get().count, 0);
  assert.equal(inspect.prepare('SELECT count(*) AS count FROM presentation_outbox').get().count, 0);
  inspect.close();
});

test('paused activity mutates nothing and stale activity authority retires without work', async (t) => {
  const { core, service } = await setup(t);
  await service.createSchedule(scheduleInput());
  const { dbPath } = core;
  await core.close();

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys=ON');
  db.prepare("UPDATE activity SET state='paused' WHERE activity_id='activity'").run();
  db.close();
  let current = new Date('2026-01-01T00:01:00.000Z');
  const pausedCore = openCoreDatabase({ dbPath, now: () => current });
  const pausedService = createCoreSchedulingService({ core: pausedCore });
  assert.equal((await pausedService.wakeDue())[0].disposition, 'paused');
  assert.equal(pausedCore.reader.wakeOccurrences('schedule').length, 0);
  await pausedCore.close();

  const staleDb = new DatabaseSync(dbPath);
  staleDb.prepare("UPDATE activity SET state='cancelled',contract_revision=1 WHERE activity_id='activity'").run();
  staleDb.close();
  const staleCore = openCoreDatabase({ dbPath, now: () => current });
  const staleService = createCoreSchedulingService({ core: staleCore });
  assert.equal((await staleService.wakeDue())[0].disposition, 'retired');
  assert.equal(staleCore.reader.scheduleSpec('schedule').state, 'retired');
  assert.equal(staleCore.reader.wakeOccurrences('schedule').length, 0);
  await staleCore.close();
});
