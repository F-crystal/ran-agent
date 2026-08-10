import assert from 'node:assert/strict';
import test from 'node:test';

import { openCoreDatabase } from '../../src/core/coreDb.mjs';
import { formatExternalMcpTaskRef } from '../../src/core/coreExternalNotificationService.mjs';
import { createCoreExternalPollService } from '../../src/core/coreExternalPoll.mjs';
import { createCoreRuntimeComposition } from '../../src/core/coreRuntimeComposition.mjs';
import { createCoreSchedulingService } from '../../src/core/coreScheduling.mjs';
import { createTempCore, openTestInspector } from './helpers/testCoreInspector.mjs';

const START = '2026-08-08T15:00:00.000Z';
const DUE = '2026-08-08T15:01:00.000Z';
const TOKEN = `hmac-sha256:v1:test:${'a'.repeat(64)}`;

async function setup(t, payloadRef, externalFact = null) {
  const { dbPath } = createTempCore(t, 'hermes-core-runtime-composition-');
  let current = new Date(START);
  const core = openCoreDatabase({ dbPath, now: () => current });
  core.migrate();
  await core.writer.write((tx) => {
    tx.packageBTurn.createOrResolveConversation({
      conversationId: 'conversation', canonicalConversationKey: 'conversation', ownerId: 'owner',
      actorRef: 'owner:verified', platform: 'feishu', primaryFrontend: 'feishu',
      sourceInstanceId: 'node-channel-hub:feishu', platformConversationBinding: 'feishu:conversation',
      createdAt: START,
    });
    tx.packageBPresentation.createOrReadBinding({
      operationKey: 'binding:create', bindingId: 'binding', conversationId: 'conversation', ownerId: 'owner',
      sourceInstanceId: 'node-channel-hub:feishu', platform: 'feishu', destinationKind: 'conversation',
      destinationRef: 'owner-dm', adapterMetadata: { protocol: 'test', receiptMode: 'typed' }, createdAt: START,
    });
    tx.journal.append({
      eventId: 'cause', eventType: 'schedule_requested', ownerId: 'owner', conversationId: 'conversation',
      originRef: 'test', sourceKind: 'test', sourceRef: 'test', createdAt: START,
    });
    if (externalFact) {
      tx.journal.append({
        eventId: externalFact.eventId, eventType: 'external_poll_fact_observed', ownerId: 'owner',
        actorRef: 'forum-mcp', originRef: 'core-external-poll-worker', sourceKind: 'external_mcp',
        sourceRef: 'fingerprint', revision: 0, causationId: 'cause', correlationId: 'poll-work', createdAt: START,
      });
      tx.journal.appendPayload({
        payloadId: `${externalFact.eventId}:payload`, eventId: externalFact.eventId,
        storageKind: 'external_ref', payloadRef: `external-mcp:/activity/${externalFact.activityId}/revision/${externalFact.revision}`,
        contentHashToken: TOKEN, sensitivity: 'sensitive', retentionClass: 'canonical', createdAt: START,
      });
      tx.projections.createCursor({
        cursorId: `${externalFact.eventId}:cursor`, projectorId: 'core-external-attention-v1',
        targetScope: externalFact.eventId, createdAt: START,
      });
      tx.projections.reserve({
        outboxId: `${externalFact.eventId}:projection`, operationScope: `external-test:${externalFact.eventId}`,
        operationKey: `external-test:${externalFact.eventId}`, projectorId: 'core-external-attention-v1',
        targetScope: externalFact.eventId, sourceEventId: externalFact.eventId, sourceRevision: 0,
        payloadRef, createdAt: START,
      });
      tx.journal.append({
        eventId: `${externalFact.eventId}:notification`, eventType: 'core_external_notification_registered',
        ownerId: 'owner', actorRef: 'owner', originRef: payloadRef,
        sourceKind: 'core-external-notification:v1', sourceRef: payloadRef,
        revision: 1, causationId: externalFact.eventId, createdAt: START,
      });
    }
    tx.activities.create({
      activityId: 'activity', ownerId: 'owner', conversationId: 'conversation', title: 'Scheduled notification',
      goalRef: payloadRef, domain: 'personal', riskClass: 'reversible', autonomyLevel: 1,
      state: 'active', contractRevision: 0, resumePolicy: 'bounded_auto', reportPolicy: 'milestone', createdAt: START,
    });
  });
  if (externalFact) {
    const projections = createCoreExternalPollService({ core });
    await projections.completeProjection(core.reader.externalPollProjectionForFact(externalFact.eventId));
  }
  const scheduling = createCoreSchedulingService({ core });
  await scheduling.createSchedule({
    scheduleSpecId: 'schedule', scheduleSpecRevisionId: 'schedule-r1', activityId: 'activity',
    operationKey: 'schedule:create', recurrence: { kind: 'one_shot', at: DUE },
    taskKind: 'scheduled_instruction', payloadRef, catchUpPolicy: 'latest',
    activityContractRevision: 0, conversationId: 'conversation', presentationBindingId: 'binding',
    expectedBindingRevision: 0,
    causationId: externalFact ? `${externalFact.eventId}:notification` : 'cause',
  });
  current = new Date(DUE);
  await scheduling.wakeDue();
  return { core, dbPath, now: () => current };
}

test('an admitted external checkpoint is decided by Hermes and sent through the typed Core delivery', async (t) => {
  const externalFact = {
    eventId: 'external-fact-1', activityId: 'activity-1', revision: 3, checkpointDigest: 'checkpoint-3',
  };
  const payloadRef = formatExternalMcpTaskRef({ ...externalFact, factEventId: externalFact.eventId });
  const { core, dbPath, now } = await setup(t, payloadRef, externalFact);
  const messages = [];
  const sends = [];
  const runtime = createCoreRuntimeComposition({
    runtime: { core, hashContent: () => TOKEN },
    externalMcpRuntime: { store: { get: () => ({
      activityId: 'activity-1', status: 'active', revision: 3, domain: 'forum',
      scope: { serverId: 'forum-mcp', resourceId: 'topic-1' },
      checkpoint: { stateDigest: 'checkpoint-3', summary: 'The watched topic has a new reply.' },
    }) } },
    channelHub: async (message) => {
      messages.push(message);
      return {
        replyText: JSON.stringify({
          action: 'notify', message: '关注的帖子有一条新回复。',
          evidence_refs: ['core-external-mcp:external-fact-1'], why_now: 'new watched reply',
        }),
        provider: 'hermes', model: 'test',
      };
    },
    sendFeishu: async (input) => { sends.push(input); },
    now,
    env: { RAN_AGENT_CORE_WORK_POLL_MS: '250' },
  });
  runtime.start();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await runtime.stop();
  const inspect = openTestInspector(dbPath);
  const work = inspect.prepare('SELECT state,failure_class FROM work_run').get();
  assert.equal(work.state, 'completed', JSON.stringify(work));
  assert.equal(messages[0].route_hint, 'external_mcp_system_queue');
  assert.deepEqual(messages[0].proactive_event.evidence_refs, ['core-external-mcp:external-fact-1']);
  assert.equal(sends.length, 1);
  const scheduleCause = inspect.prepare(`SELECT event.causation_id AS fact_event_id
    FROM schedule_spec_revision revision JOIN journal_event event
      ON event.journal_event_id=revision.causation_id
    WHERE revision.schedule_spec_id='schedule'`).get();
  assert.equal(scheduleCause.fact_event_id, 'external-fact-1');
  assert.equal(sends[0].text, '关注的帖子有一条新回复。');
  runtime.start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await runtime.stop();
  assert.equal(sends.length, 1);
  inspect.close();
  await core.close();
});

test('an external notification fails closed when revision or checkpoint digest no longer matches its fact', async (t) => {
  for (const [name, activity] of [
    ['newer revision', {
      activityId: 'activity-1', status: 'active', revision: 4, domain: 'forum',
      scope: { serverId: 'forum-mcp' }, checkpoint: { stateDigest: 'checkpoint-4', summary: 'newer content' },
    }],
    ['different checkpoint', {
      activityId: 'activity-1', status: 'active', revision: 3, domain: 'forum',
      scope: { serverId: 'forum-mcp' }, checkpoint: { stateDigest: 'changed', summary: 'changed content' },
    }],
  ]) {
    await t.test(name, async (st) => {
      const externalFact = {
        eventId: `external-fact-${name.replaceAll(' ', '-')}`,
        activityId: 'activity-1', revision: 3, checkpointDigest: 'checkpoint-3',
      };
      const payloadRef = formatExternalMcpTaskRef({ ...externalFact, factEventId: externalFact.eventId });
      const { core, now } = await setup(st, payloadRef, externalFact);
      let hermesCalls = 0;
      let sends = 0;
      const runtime = createCoreRuntimeComposition({
        runtime: { core, hashContent: () => TOKEN },
        externalMcpRuntime: { store: { get: () => activity } },
        channelHub: async () => { hermesCalls += 1; return {}; },
        sendFeishu: async () => { sends += 1; },
        now, env: { RAN_AGENT_CORE_WORK_POLL_MS: '250' },
      });
      runtime.start();
      await new Promise((resolve) => setTimeout(resolve, 30));
      await runtime.stop();
      assert.equal(hermesCalls, 0);
      assert.equal(sends, 0);
      assert.equal(core.reader.workRun(core.reader.workRunsForOccurrence(
        core.reader.wakeOccurrences('schedule')[0].wake_occurrence_id,
      )[0].work_run_id).state, 'completed');
      await core.close();
    });
  }
});

test('Python reminder acknowledgement observes a durably terminal suppressed WorkRun', async (t) => {
  const { core, dbPath, now } = await setup(t, 'legacy-todo:7');
  const acknowledgementStates = [];
  let sends = 0;
  const runtime = createCoreRuntimeComposition({
    runtime: { core, hashContent: () => TOKEN },
    channelHub: async () => { throw new Error('completed reminder must suppress before Hermes'); },
    sendFeishu: async () => { sends += 1; },
    fetchImpl: async (url) => {
      if (url.endsWith('/tools/todo/get')) {
        return { ok: true, json: async () => ({ todo: { id: 7, status: 'done' } }) };
      }
      if (url.endsWith('/tools/todo/ack')) {
        const inspector = openTestInspector(dbPath);
        acknowledgementStates.push(inspector.prepare('SELECT state FROM work_run').get().state);
        inspector.close();
        return { ok: true, json: async () => ({ acknowledged: true }) };
      }
      throw new Error(`unexpected Python route: ${url}`);
    },
    now,
    env: { RAN_AGENT_CORE_WORK_POLL_MS: '250' },
  });
  runtime.start();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await runtime.stop();
  assert.deepEqual(acknowledgementStates, ['completed']);
  assert.equal(sends, 0);
  await core.close();
});
