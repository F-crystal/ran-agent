import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { openCoreDatabase } from '../../src/core/coreDb.mjs';
import { createCoreExternalMcpHandler } from '../../src/core/coreExternalMcpHandler.mjs';
import { formatKeyedContentHashToken } from '../../src/core/coreHashToken.mjs';
import { createCoreSchedulingService } from '../../src/core/coreScheduling.mjs';
import { createCoreWorkRunWorker } from '../../src/core/coreWorkRunWorker.mjs';
import { createTempCore, openTestInspector } from './helpers/testCoreInspector.mjs';

const START = '2026-08-08T08:00:00.000Z';

function hashContent(kind, value) {
  return formatKeyedContentHashToken({
    keyId: 'core-test', digest: createHash('sha256').update(`${kind}\0${value}`).digest('hex'),
  });
}

test('Core external MCP Work Run records candidates as facts without a send surface', async (t) => {
  const { dbPath } = createTempCore(t, 'hermes-core-external-mcp-handler-');
  let current = new Date(START);
  const core = openCoreDatabase({ dbPath, now: () => current });
  core.migrate();
  await core.writer.write((tx) => {
    tx.journal.append({
      eventId: 'external-mcp-causation', eventType: 'external_poll_requested', ownerId: 'owner',
      originRef: 'fixture', sourceKind: 'test', sourceRef: 'fixture', createdAt: START,
    });
    tx.activities.create({
      activityId: 'external-mcp-system-activity', ownerId: 'owner', title: 'External MCP poll',
      goalRef: 'system-task:external-mcp-poll', domain: 'personal', riskClass: 'reversible',
      autonomyLevel: 1, state: 'active', contractRevision: 0,
      resumePolicy: 'bounded_auto', reportPolicy: 'milestone', createdAt: START,
    });
  });
  const scheduling = createCoreSchedulingService({ core });
  await scheduling.createSchedule({
    scheduleSpecId: 'external-mcp-system-schedule',
    scheduleSpecRevisionId: 'external-mcp-system-schedule-r1',
    activityId: 'external-mcp-system-activity', operationKey: 'external-mcp:create',
    recurrence: { kind: 'one_shot', at: '2026-08-08T08:01:00.000Z' },
    taskKind: 'external_poll', payloadRef: 'external-poll:external-mcp-runtime',
    catchUpPolicy: 'latest', activityContractRevision: 0,
    causationId: 'external-mcp-causation',
  });
  current = new Date('2026-08-08T08:01:00.000Z');
  await scheduling.wakeDue();

  let bridge;
  const admissions = [];
  const registrations = [];
  const confirmed = [];
  let flushCandidates = [];
  const runtime = {
    store: {
      get(activityId) {
        return activityId === 'activity-1' ? { scope: { serverId: 'forum-mcp' } } : null;
      },
    },
    async tick() {
      await bridge.submitCandidate(
        { status: 'ready', text: 'A new forum checkpoint is ready.' },
        { activityId: 'activity-1', checkpointDigest: 'checkpoint-1', notifyTarget: { platform: 'feishu' }, revision: 3 },
      );
      return { ok: true, processed: 1 };
    },
  };
  bridge = createCoreExternalMcpHandler({
    core, runtime, hashContent,
    attentionValve: {
      evaluate: (input) => { admissions.push(input); return { disposition: 'delayed' }; },
      flush: () => flushCandidates.splice(0),
      confirmFlushed: (fingerprint) => confirmed.push(fingerprint),
    },
    notificationService: { async register(input) { registrations.push(input); } },
  });
  const worker = createCoreWorkRunWorker({
    core, hashContent, handlers: { external_poll: bridge.handler },
    workerId: 'external-mcp-worker', now: () => current,
  });

  assert.equal((await worker.runOnce())[0].state, 'completed');
  assert.equal(admissions[0].payloadRef, 'external-mcp-task:activity-1:3');
  assert.equal(registrations.length, 0);
  flushCandidates = [{
    fingerprint: admissions[0].fingerprint,
    payloadRef: admissions[0].payloadRef,
    causationId: admissions[0].causationId,
  }];
  await bridge.attentionFlushHandler({ work: { work_run_id: 'attention-flush-work' } });
  assert.deepEqual(registrations, [{
    payloadRef: admissions[0].payloadRef, causationId: admissions[0].causationId,
  }]);
  assert.deepEqual(confirmed, [admissions[0].fingerprint]);
  await assert.rejects(bridge.submitCandidate({}, {}), { code: 'CORE_EXTERNAL_POLL_AUTHORITY_STALE' });
  await core.close();

  const inspect = openTestInspector(dbPath);
  const fact = inspect.prepare("SELECT actor_ref,source_ref FROM journal_event WHERE event_type='external_poll_fact_observed'").get();
  assert.equal(fact.actor_ref, 'forum-mcp');
  assert.match(fact.source_ref, /^sha256:v1:[0-9a-f]{64}$/);
  assert.equal(inspect.prepare('SELECT count(*) AS count FROM presentation_outbox').get().count, 0);
  assert.equal(inspect.prepare('SELECT count(*) AS count FROM effect_attempt').get().count, 0);
  inspect.close();
});
