import assert from 'node:assert/strict';
import test from 'node:test';

import { openCoreDatabase } from '../../src/core/coreDb.mjs';
import { createCoreExternalPollService } from '../../src/core/coreExternalPoll.mjs';
import { formatKeyedContentHashToken } from '../../src/core/coreHashToken.mjs';
import { createCoreSchedulingService } from '../../src/core/coreScheduling.mjs';
import { createTempCore, openTestInspector } from './helpers/testCoreInspector.mjs';

const START = '2026-08-08T08:00:00.000Z';

test('external poll worker records one Core fact and has no visible-send surface', async (t) => {
  const { dbPath } = createTempCore(t, 'hermes-core-external-poll-');
  let current = new Date(START);
  const core = openCoreDatabase({ dbPath, now: () => current });
  core.migrate();
  await core.writer.write((tx) => {
    tx.journal.append({
      eventId: 'external-poll-causation', eventType: 'external_poll_requested', ownerId: 'owner',
      originRef: 'fixture', sourceKind: 'test', sourceRef: 'fixture', createdAt: START,
    });
    tx.activities.create({
      activityId: 'external-poll-activity', ownerId: 'owner', title: 'External poll',
      goalRef: 'goal:external-poll', domain: 'personal', riskClass: 'reversible',
      autonomyLevel: 1, state: 'active', contractRevision: 0,
      resumePolicy: 'bounded_auto', reportPolicy: 'milestone', createdAt: START,
    });
  });
  const scheduling = createCoreSchedulingService({ core });
  await scheduling.createSchedule({
    scheduleSpecId: 'external-poll-schedule', scheduleSpecRevisionId: 'external-poll-schedule-r1',
    activityId: 'external-poll-activity', operationKey: 'external-poll:create',
    recurrence: { kind: 'one_shot', at: '2026-08-08T08:01:00.000Z' },
    taskKind: 'external_poll', payloadRef: 'external-poll:forum-mcp',
    catchUpPolicy: 'latest', activityContractRevision: 0,
    causationId: 'external-poll-causation',
  });
  current = new Date('2026-08-08T08:01:00.000Z');
  const [wake] = await scheduling.wakeDue();
  const work = core.reader.workRunsForOccurrence(wake.occurrences[0].wake_occurrence_id)[0];
  const facts = createCoreExternalPollService({ core });
  const input = {
    workRunId: work.work_run_id,
    serverId: 'forum-mcp',
    sourceFingerprint: `sha256:v1:${'a'.repeat(64)}`,
    payloadRef: 'vault:/external-mcp/fact-1',
    contentHashToken: formatKeyedContentHashToken({ keyId: 'core-test', digest: 'b'.repeat(64) }),
  };
  await assert.rejects(facts.recordFact(input), { code: 'CORE_EXTERNAL_POLL_AUTHORITY_STALE' });
  await scheduling.claimWorkRun({
    workRunId: work.work_run_id, expectedRevision: 0, expectedFence: 0,
    leaseOwner: 'external-poll-worker', leaseUntil: '2026-08-08T08:02:00.000Z',
    operationKey: 'external-poll:claim:1',
  });
  await assert.rejects(facts.recordFact({ ...input, serverId: 'other-mcp' }), {
    code: 'CORE_EXTERNAL_POLL_AUTHORITY_STALE',
  });
  assert.equal((await facts.recordFact(input)).disposition, 'recorded');
  assert.equal((await facts.recordFact(input)).disposition, 'already_applied');
  await assert.rejects(facts.recordFact({ ...input, payloadRef: 'vault:/external-mcp/fact-2' }), {
    code: 'CORE_OPERATION_KEY_CONFLICT',
  });
  assert.deepEqual(Object.keys(facts), ['recordFact']);
  await core.close();

  const inspect = openTestInspector(dbPath);
  assert.equal(inspect.prepare("SELECT count(*) AS count FROM journal_event WHERE event_type='external_poll_fact_observed'").get().count, 1);
  assert.equal(inspect.prepare('SELECT count(*) AS count FROM presentation_outbox').get().count, 0);
  assert.equal(inspect.prepare('SELECT count(*) AS count FROM effect_attempt').get().count, 0);
  inspect.close();
});
