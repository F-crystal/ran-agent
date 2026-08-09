import assert from 'node:assert/strict';
import test from 'node:test';

import { openCoreDatabase } from '../../src/core/coreDb.mjs';
import { createCoreRuntimeComposition } from '../../src/core/coreRuntimeComposition.mjs';
import { createCoreSchedulingService } from '../../src/core/coreScheduling.mjs';
import { createTempCore, openTestInspector } from './helpers/testCoreInspector.mjs';

const START = '2026-08-08T15:00:00.000Z';
const DUE = '2026-08-08T15:01:00.000Z';
const TOKEN = `hmac-sha256:v1:test:${'a'.repeat(64)}`;

async function setup(t, payloadRef) {
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
    tx.activities.create({
      activityId: 'activity', ownerId: 'owner', conversationId: 'conversation', title: 'Scheduled notification',
      goalRef: payloadRef, domain: 'personal', riskClass: 'reversible', autonomyLevel: 1,
      state: 'active', contractRevision: 0, resumePolicy: 'bounded_auto', reportPolicy: 'milestone', createdAt: START,
    });
  });
  const scheduling = createCoreSchedulingService({ core });
  await scheduling.createSchedule({
    scheduleSpecId: 'schedule', scheduleSpecRevisionId: 'schedule-r1', activityId: 'activity',
    operationKey: 'schedule:create', recurrence: { kind: 'one_shot', at: DUE },
    taskKind: 'scheduled_instruction', payloadRef, catchUpPolicy: 'latest',
    activityContractRevision: 0, conversationId: 'conversation', presentationBindingId: 'binding',
    expectedBindingRevision: 0, causationId: 'cause',
  });
  current = new Date(DUE);
  await scheduling.wakeDue();
  return { core, dbPath, now: () => current };
}

test('an admitted external checkpoint is decided by Hermes and sent through the typed Core delivery', async (t) => {
  const { core, dbPath, now } = await setup(t, 'external-mcp-task:activity-1:3');
  const messages = [];
  const sends = [];
  const runtime = createCoreRuntimeComposition({
    runtime: { core, hashContent: () => TOKEN },
    externalMcpRuntime: { store: { get: () => ({
      activityId: 'activity-1', revision: 3, domain: 'forum',
      scope: { serverId: 'forum-mcp', resourceId: 'topic-1' },
      checkpoint: { summary: 'The watched topic has a new reply.' },
    }) } },
    channelHub: async (message) => {
      messages.push(message);
      return {
        replyText: JSON.stringify({
          action: 'notify', message: '关注的帖子有一条新回复。',
          evidence_refs: ['core-external-mcp:activity-1:3'], why_now: 'new watched reply',
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
  assert.equal(sends.length, 1);
  assert.equal(sends[0].text, '关注的帖子有一条新回复。');
  runtime.start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await runtime.stop();
  assert.equal(sends.length, 1);
  inspect.close();
  await core.close();
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
