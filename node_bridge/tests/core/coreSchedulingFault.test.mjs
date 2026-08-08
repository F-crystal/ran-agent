import assert from 'node:assert/strict';
import test from 'node:test';

import { openCoreDatabase } from '../../src/core/coreDb.mjs';
import { createCoreSchedulingService } from '../../src/core/coreScheduling.mjs';
import { createTempCore, openTestInspector, rowCount } from './helpers/testCoreInspector.mjs';

const CAUSATION_AT = '2026-01-01T00:00:00.000Z';

async function setup(t, start = CAUSATION_AT) {
  const { dbPath } = createTempCore(t, 'hermes-core-schedule-fault-');
  let current = new Date(start);
  const core = openCoreDatabase({ dbPath, now: () => current });
  core.migrate();
  const service = createCoreSchedulingService({ core, batchSize: 16 });
  await core.writer.write((tx) => {
    tx.journal.append({
      eventId: 'fault-causation', eventType: 'schedule_requested', ownerId: 'owner',
      originRef: 'fixture', sourceKind: 'test', sourceRef: 'fixture', createdAt: CAUSATION_AT,
    });
    tx.activities.create({
      activityId: 'activity', ownerId: 'owner', title: 'Scheduled work',
      goalRef: 'goal:scheduled', domain: 'personal', riskClass: 'reversible',
      autonomyLevel: 1, state: 'active', contractRevision: 0,
      resumePolicy: 'bounded_auto', reportPolicy: 'milestone', createdAt: CAUSATION_AT,
    });
  });
  return { core, service, dbPath, setNow: (value) => { current = new Date(value); } };
}

function scheduleInput(overrides = {}) {
  return {
    scheduleSpecId: 'schedule', scheduleSpecRevisionId: 'schedule-r1',
    activityId: 'activity', operationKey: 'schedule:create',
    recurrence: { kind: 'one_shot', at: '2026-01-01T00:01:00.000Z' },
    taskKind: 'system_maintenance', payloadRef: 'task:fixture',
    catchUpPolicy: 'latest', activityContractRevision: 0,
    causationId: 'fault-causation', ...overrides,
  };
}

test('clock rollback never duplicates, regresses, or loses an occurrence', async (t) => {
  const { core, service, setNow } = await setup(t);
  await service.createSchedule(scheduleInput({
    recurrence: { kind: 'interval', anchorAt: '2026-01-01T00:02:00.000Z', everySeconds: 300 },
    catchUpPolicy: 'latest',
  }));
  setNow('2026-01-01T00:02:30.000Z');
  await service.wakeDue();
  assert.equal(rowCount(openTestInspector(core.dbPath), 'wake_occurrence'), 1);
  assert.equal(core.reader.scheduleSpec('schedule').next_due_at, '2026-01-01T00:07:00.000Z');

  setNow('2026-01-01T00:01:00.000Z');
  const rolled = await service.wakeDue();
  assert.deepEqual(rolled, []);
  assert.equal(rowCount(openTestInspector(core.dbPath), 'wake_occurrence'), 1);
  assert.equal(rowCount(openTestInspector(core.dbPath), 'work_run'), 1);
  assert.equal(core.reader.scheduleSpec('schedule').next_due_at, '2026-01-01T00:07:00.000Z');

  setNow('2026-01-01T00:07:30.000Z');
  await service.wakeDue();
  assert.equal(rowCount(openTestInspector(core.dbPath), 'wake_occurrence'), 2);
  assert.equal(rowCount(openTestInspector(core.dbPath), 'work_run'), 2);
  await core.close();
});

test('long downtime collapses to one latest occurrence with one aggregate skip event', async (t) => {
  const { core, service, setNow } = await setup(t, '2025-12-31T23:59:00.000Z');
  await service.createSchedule(scheduleInput({
    recurrence: { kind: 'interval', anchorAt: '2026-01-01T00:00:00.000Z', everySeconds: 60 },
    catchUpPolicy: 'latest',
  }));
  setNow('2026-01-01T06:00:00.000Z');
  const [wake] = await service.wakeDue();
  assert.equal(wake.disposition, 'woken');
  assert.equal(wake.occurrences.length, 1);
  assert.equal(wake.occurrences[0].scheduled_for, '2026-01-01T06:00:00.000Z');
  assert.equal(wake.skipped, 360);
  const inspector = openTestInspector(core.dbPath);
  assert.equal(rowCount(inspector, 'wake_occurrence'), 1);
  assert.equal(rowCount(inspector, 'work_run'), 1);
  assert.equal(
    Number(inspector.prepare("SELECT count(*) AS count FROM journal_event WHERE event_type='schedule_windows_skipped'").get().count),
    1,
  );
  assert.equal(core.reader.scheduleSpec('schedule').next_due_at, '2026-01-01T06:01:00.000Z');

  const again = await service.wakeDue();
  assert.deepEqual(again, []);
  assert.equal(rowCount(inspector, 'wake_occurrence'), 1);
  await core.close();
});

test('a failure inside the tick transaction rolls every schedule back before commit', async (t) => {
  const { core, service, dbPath, setNow } = await setup(t);
  await service.createSchedule(scheduleInput({
    scheduleSpecId: 'schedule-a', scheduleSpecRevisionId: 'schedule-a-r1', operationKey: 'schedule-a:create',
  }));
  await service.createSchedule(scheduleInput({
    scheduleSpecId: 'schedule-b', scheduleSpecRevisionId: 'schedule-b-r1', operationKey: 'schedule-b:create',
  }));

  const saboteur = openTestInspector(dbPath, { readOnly: false });
  saboteur.prepare(`INSERT INTO schedule_spec_revision(
      schedule_spec_revision_id,schedule_spec_id,revision,recurrence_kind,recurrence_json,
      task_kind,payload_ref,catch_up_policy,catch_up_limit,activity_contract_revision,
      operation_key,semantic_digest,causation_id,conversation_id,presentation_binding_id,
      expected_binding_revision,created_at
    ) SELECT
      'schedule-b-r2-corrupt',schedule_spec_id,2,'one_shot','{corrupt',
      task_kind,payload_ref,catch_up_policy,catch_up_limit,activity_contract_revision,
      'schedule-b:create:corrupt','sha256:v1:0000000000000000000000000000000000000000000000000000000000000000',causation_id,conversation_id,presentation_binding_id,
      expected_binding_revision,created_at
    FROM schedule_spec_revision WHERE schedule_spec_id='schedule-b'`).run();
  saboteur.prepare("UPDATE schedule_spec SET current_revision_id='schedule-b-r2-corrupt' WHERE schedule_spec_id='schedule-b'").run();
  saboteur.close();

  setNow('2026-01-01T00:01:30.000Z');
  await assert.rejects(service.wakeDue());

  const inspector = openTestInspector(dbPath);
  assert.equal(rowCount(inspector, 'wake_occurrence'), 0);
  assert.equal(rowCount(inspector, 'work_run'), 0);
  assert.equal(rowCount(inspector, 'exchange'), 0);
  assert.equal(core.reader.scheduleSpec('schedule-a').next_due_at, '2026-01-01T00:01:00.000Z');
  assert.equal(core.reader.scheduleSpec('schedule-a').state, 'enabled');
  assert.equal(core.reader.scheduleSpec('schedule-b').state, 'enabled');
  inspector.close();

  const repair = openTestInspector(dbPath, { readOnly: false });
  repair.prepare("UPDATE schedule_spec SET current_revision_id='schedule-b-r1' WHERE schedule_spec_id='schedule-b'").run();
  repair.close();

  await core.close();
  const reopened = openCoreDatabase({ dbPath, now: () => new Date('2026-01-01T00:01:30.000Z') });
  const reopenedService = createCoreSchedulingService({ core: reopened, batchSize: 16 });
  const woken = await reopenedService.wakeDue();
  assert.equal(woken.length, 2);
  const verifier = openTestInspector(dbPath);
  assert.equal(rowCount(verifier, 'wake_occurrence'), 2);
  assert.equal(rowCount(verifier, 'work_run'), 2);

  const replayed = await reopenedService.wakeDue();
  assert.deepEqual(replayed, []);
  assert.equal(rowCount(verifier, 'wake_occurrence'), 2);
  assert.equal(rowCount(verifier, 'work_run'), 2);
  verifier.close();
  await reopened.close();
});

test('a committed occurrence survives restart and its existing WorkRun is claimed once', async (t) => {
  const { core, service, dbPath, setNow } = await setup(t);
  await service.createSchedule(scheduleInput());
  setNow('2026-01-01T00:01:00.000Z');
  const [wake] = await service.wakeDue();
  const occurrenceId = wake.occurrences[0].wake_occurrence_id;
  const original = core.reader.workRunsForOccurrence(occurrenceId)[0];
  assert.equal(original.state, 'queued');
  await core.close();

  const reopened = openCoreDatabase({ dbPath, now: () => new Date('2026-01-01T00:01:30.000Z') });
  const reopenedService = createCoreSchedulingService({ core: reopened, batchSize: 16 });
  const claim = await reopenedService.claimWorkRun({
    workRunId: original.work_run_id,
    expectedRevision: Number(original.revision),
    expectedFence: Number(original.fence_token),
    leaseOwner: 'restart-worker',
    leaseUntil: '2026-01-01T00:02:30.000Z',
    operationKey: 'restart-worker:claim:1',
  });
  assert.equal(claim.disposition, 'applied');
  assert.equal((await reopenedService.claimWorkRun({
    workRunId: original.work_run_id,
    expectedRevision: Number(original.revision),
    expectedFence: Number(original.fence_token),
    leaseOwner: 'restart-worker',
    leaseUntil: '2026-01-01T00:02:30.000Z',
    operationKey: 'restart-worker:claim:1',
  })).disposition, 'already_applied');
  assert.deepEqual(await reopenedService.wakeDue(), []);

  const inspector = openTestInspector(dbPath);
  assert.equal(rowCount(inspector, 'wake_occurrence'), 1);
  assert.equal(rowCount(inspector, 'work_run'), 1);
  assert.equal(rowCount(inspector, 'lease'), 1);
  inspector.close();
  await reopened.close();
});

test('a tick across the DST fold creates the repeated wall time exactly once at the earlier instant', async (t) => {
  const { core, service, setNow } = await setup(t, '2026-10-31T06:00:00.000Z');
  await service.createSchedule(scheduleInput({
    recurrence: { kind: 'daily', time: '01:30:00', timeZone: 'America/New_York' },
    catchUpPolicy: 'latest',
  }));
  assert.equal(core.reader.scheduleSpec('schedule').next_due_at, '2026-11-01T05:30:00.000Z');

  setNow('2026-11-01T05:45:00.000Z');
  const [wake] = await service.wakeDue();
  assert.equal(wake.occurrences.length, 1);
  assert.equal(wake.occurrences[0].scheduled_for, '2026-11-01T05:30:00.000Z');
  assert.equal(core.reader.scheduleSpec('schedule').next_due_at, '2026-11-02T06:30:00.000Z');

  setNow('2026-11-01T07:00:00.000Z');
  await service.wakeDue();
  const inspector = openTestInspector(core.dbPath);
  assert.equal(rowCount(inspector, 'wake_occurrence'), 1);
  assert.equal(rowCount(inspector, 'work_run'), 1);
  inspector.close();
  await core.close();
});
