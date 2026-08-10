import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { openCoreDatabase } from '../../src/core/coreDb.mjs';
import { createCoreExternalPollService } from '../../src/core/coreExternalPoll.mjs';
import { formatExternalMcpTaskRef } from '../../src/core/coreExternalNotificationService.mjs';
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
    serverId: 'forum-mcp',
    sourceFingerprint: `sha256:v1:${'a'.repeat(64)}`,
    payloadRef: 'vault:/external-mcp/fact-1',
    contentHashToken: formatKeyedContentHashToken({ keyId: 'core-test', digest: 'b'.repeat(64) }),
  };
  const factEventId = `external-poll-fact:v1:${createHash('sha256')
    .update(`${work.work_run_id}\0${input.sourceFingerprint}`).digest('hex')}`;
  input.projectionPayloadRef = formatExternalMcpTaskRef({
    activityId: 'activity-1', revision: 1, checkpointDigest: 'checkpoint-1', factEventId,
  });
  await assert.rejects(facts.recordFact({ ...input, authority: {
    workRunId: work.work_run_id, expectedRevision: 1, fenceToken: 1,
    leaseOwner: 'external-poll-worker', leaseId: 'missing',
  } }), { code: 'CORE_EXTERNAL_POLL_AUTHORITY_STALE' });
  const claim = await scheduling.claimWorkRun({
    workRunId: work.work_run_id, expectedRevision: 0, expectedFence: 0,
    leaseOwner: 'external-poll-worker', leaseUntil: '2026-08-08T08:02:00.000Z',
    operationKey: 'external-poll:claim:1',
  });
  const authority = {
    workRunId: claim.workRunId, expectedRevision: claim.revision,
    fenceToken: claim.fenceToken, leaseOwner: 'external-poll-worker', leaseId: claim.lease.lease_id,
  };
  await assert.rejects(facts.recordFact({ ...input, authority, serverId: 'other-mcp' }), {
    code: 'CORE_EXTERNAL_POLL_AUTHORITY_STALE',
  });
  assert.equal((await facts.recordFact({ ...input, authority })).disposition, 'recorded');
  assert.equal((await facts.recordFact({ ...input, authority })).disposition, 'already_applied');
  await assert.rejects(facts.recordFact({ ...input, authority, payloadRef: 'vault:/external-mcp/fact-2' }), {
    code: 'CORE_OPERATION_KEY_CONFLICT',
  });
  assert.equal(core.reader.externalPollProjectionForFact(factEventId)?.state, 'pending');
  const legacyFingerprint = `sha256:v1:${'c'.repeat(64)}`;
  const legacySuffix = createHash('sha256').update(`${work.work_run_id}\0${legacyFingerprint}`).digest('hex');
  const legacyEventId = `external-poll-fact:v1:${legacySuffix}`;
  const legacyPayloadId = `external-poll-payload:v1:${legacySuffix}`;
  const legacyInput = {
    ...input,
    sourceFingerprint: legacyFingerprint,
    projectionPayloadRef: formatExternalMcpTaskRef({
      activityId: 'activity-1', revision: 1, checkpointDigest: 'checkpoint-1', factEventId: legacyEventId,
    }),
  };
  await core.writer.write((tx) => {
    tx.journal.append({
      eventId: legacyEventId, eventType: 'external_poll_fact_observed', ownerId: 'owner',
      activityId: 'external-poll-activity', actorRef: 'forum-mcp', originRef: 'core-external-poll-worker',
      sourceKind: 'external_mcp', sourceRef: legacyFingerprint, revision: 0,
      causationId: 'external-poll-causation', correlationId: work.work_run_id, createdAt: current.toISOString(),
    });
    tx.journal.appendPayload({
      payloadId: legacyPayloadId, eventId: legacyEventId, storageKind: 'external_ref',
      payloadRef: legacyInput.payloadRef, contentHashToken: legacyInput.contentHashToken,
      sensitivity: 'sensitive', retentionClass: 'canonical', createdAt: current.toISOString(),
    });
  });
  assert.equal((await facts.recordFact({ ...legacyInput, authority })).disposition, 'already_applied');
  assert.equal(core.reader.externalPollProjectionForFact(legacyEventId)?.state, 'pending');
  await core.close();

  const inspect = openTestInspector(dbPath);
  assert.equal(inspect.prepare("SELECT count(*) AS count FROM journal_event WHERE event_type='external_poll_fact_observed'").get().count, 2);
  assert.equal(inspect.prepare('SELECT count(*) AS count FROM presentation_outbox').get().count, 0);
  assert.equal(inspect.prepare('SELECT count(*) AS count FROM effect_attempt').get().count, 0);
  inspect.close();
});
