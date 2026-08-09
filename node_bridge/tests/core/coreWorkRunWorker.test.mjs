import assert from 'node:assert/strict';
import test from 'node:test';

import { openCoreDatabase } from '../../src/core/coreDb.mjs';
import { createCoreSchedulingService } from '../../src/core/coreScheduling.mjs';
import { createCoreWorkRunWorker } from '../../src/core/coreWorkRunWorker.mjs';
import { createTempCore, openTestInspector } from './helpers/testCoreInspector.mjs';

const START = '2026-08-08T15:00:00.000Z';
const DUE = '2026-08-08T15:01:00.000Z';
const TOKEN = `hmac-sha256:v1:test:${'a'.repeat(64)}`;

async function setup(t) {
  const { dbPath } = createTempCore(t, 'hermes-core-work-run-worker-');
  let current = new Date(START);
  const core = openCoreDatabase({ dbPath, now: () => current });
  core.migrate();
  const scheduling = createCoreSchedulingService({ core });
  await core.writer.write((tx) => {
    tx.journal.append({
      eventId: 'cause', eventType: 'schedule_requested', ownerId: 'owner',
      originRef: 'test', sourceKind: 'test', sourceRef: 'test', createdAt: START,
    });
    tx.activities.create({
      activityId: 'activity', ownerId: 'owner', title: 'Maintenance', goalRef: 'goal:test',
      domain: 'personal', riskClass: 'reversible', autonomyLevel: 1, state: 'active',
      contractRevision: 0, resumePolicy: 'bounded_auto', reportPolicy: 'milestone', createdAt: START,
    });
  });
  await scheduling.createSchedule({
    scheduleSpecId: 'schedule', scheduleSpecRevisionId: 'schedule-r1', activityId: 'activity',
    operationKey: 'schedule:create', recurrence: { kind: 'one_shot', at: DUE },
    taskKind: 'system_maintenance', payloadRef: 'system-task:test', catchUpPolicy: 'latest',
    activityContractRevision: 0, causationId: 'cause',
  });
  current = new Date(DUE);
  await scheduling.wakeDue();
  return { core, scheduling, now: () => current, setNow: (value) => { current = new Date(value); } };
}

test('worker claims one queued WorkRun, records terminal evidence, and never re-executes it', async (t) => {
  const { core, now } = await setup(t);
  let calls = 0;
  const worker = createCoreWorkRunWorker({
    core, now, hashContent: () => TOKEN,
    handlers: {
      system_maintenance: async ({ work }) => {
        calls += 1;
        assert.equal(work.payload_ref, 'system-task:test');
        return { resultRef: 'maintenance-result:test' };
      },
    },
  });
  const [result] = await worker.runOnce();
  assert.equal(result.state, 'completed');
  assert.equal(calls, 1);
  assert.deepEqual(await worker.runOnce(), []);
  assert.equal(calls, 1);
  const work = core.reader.workRun(result.workRunId);
  assert.equal(work.state, 'completed');
  assert.equal(work.lease_owner, null);
  const inspector = openTestInspector(core.dbPath);
  const receipt = inspector.prepare("SELECT * FROM journal_event WHERE event_type='core_work_run_terminal'").get();
  assert.equal(receipt.correlation_id, result.workRunId);
  assert.equal(inspector.prepare('SELECT payload_ref FROM journal_payload WHERE journal_event_id=?')
    .get(receipt.journal_event_id).payload_ref, 'maintenance-result:test');
  inspector.close();
  await core.close();
});

test('handler failure becomes one durable failed result instead of an automatic retry', async (t) => {
  const { core, now } = await setup(t);
  let calls = 0;
  const worker = createCoreWorkRunWorker({
    core, now, hashContent: () => TOKEN,
    handlers: {
      system_maintenance: async () => {
        calls += 1;
        throw Object.assign(new Error('unknown outcome'), { code: 'ETIMEDOUT' });
      },
    },
  });
  const [result] = await worker.runOnce();
  assert.equal(result.state, 'failed');
  assert.equal(core.reader.workRun(result.workRunId).failure_class, 'ETIMEDOUT');
  assert.deepEqual(await worker.runOnce(), []);
  assert.equal(calls, 1);
  await core.close();
});

test('unsupported task kind stays queued for its real owner', async (t) => {
  const { core, now } = await setup(t);
  const worker = createCoreWorkRunWorker({ core, now, hashContent: () => TOKEN });
  assert.deepEqual(await worker.runOnce(), []);
  assert.equal(core.reader.scheduledWorkQueue()[0].state, 'queued');
  await core.close();
});

test('an expired claimed WorkRun is fenced, reclaimed, and completed once after restart', async (t) => {
  const { core, scheduling, now, setNow } = await setup(t);
  const work = core.reader.scheduledWorkQueue()[0];
  await scheduling.claimWorkRun({
    workRunId: work.work_run_id, expectedRevision: 0, expectedFence: 0,
    leaseOwner: 'crashed-worker', leaseUntil: '2026-08-08T15:01:01.000Z',
    operationKey: 'crashed-worker:claim',
  });
  setNow('2026-08-08T15:01:02.000Z');
  let calls = 0;
  const worker = createCoreWorkRunWorker({
    core, now, hashContent: () => TOKEN,
    handlers: { system_maintenance: async () => { calls += 1; return { resultRef: 'recovered' }; } },
  });
  const [result] = await worker.runOnce();
  assert.equal(result.state, 'completed');
  assert.equal(calls, 1);
  assert.equal(core.reader.workRun(result.workRunId).fence_token, 3);
  assert.deepEqual(await worker.runOnce(), []);
  await core.close();
});
