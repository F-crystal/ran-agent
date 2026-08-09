import assert from 'node:assert/strict';
import test from 'node:test';

import { openCoreDatabase } from '../../src/core/coreDb.mjs';
import { createCoreSchedulingService } from '../../src/core/coreScheduling.mjs';
import { createCoreWorkRunWorker } from '../../src/core/coreWorkRunWorker.mjs';
import { createPackageBScheduledDeliveryHandler } from '../../src/core/packageB/packageBScheduledDeliveryService.mjs';
import { createTempCore, openTestInspector } from './helpers/testCoreInspector.mjs';

const START = '2026-08-08T15:00:00.000Z';
const DUE = '2026-08-08T15:01:00.000Z';
const TOKEN = `hmac-sha256:v1:test:${'a'.repeat(64)}`;

test('scheduled WorkRun consumer proves the typed system instruction to terminal receipt chain', async (t) => {
  const { dbPath } = createTempCore(t, 'hermes-core-scheduled-worker-');
  let current = new Date(START);
  const core = openCoreDatabase({ dbPath, now: () => current });
  core.migrate();
  const scheduling = createCoreSchedulingService({ core });
  const identityInput = {
    conversationId: 'conversation', canonicalConversationKey: 'conversation', ownerId: 'owner',
    actorRef: 'owner:verified', platform: 'feishu', primaryFrontend: 'feishu',
    sourceInstanceId: 'node-channel-hub:feishu', platformConversationBinding: 'feishu:conversation',
    createdAt: START,
  };
  await core.writer.write((tx) => {
    tx.packageBTurn.createOrResolveConversation(identityInput);
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
      activityId: 'activity', ownerId: 'owner', conversationId: 'conversation', title: 'Visible schedule',
      goalRef: 'goal:test', domain: 'personal', riskClass: 'reversible', autonomyLevel: 1,
      state: 'active', contractRevision: 0, resumePolicy: 'bounded_auto', reportPolicy: 'milestone', createdAt: START,
    });
  });
  await scheduling.createSchedule({
    scheduleSpecId: 'schedule', scheduleSpecRevisionId: 'schedule-r1', activityId: 'activity',
    operationKey: 'schedule:create', recurrence: { kind: 'one_shot', at: DUE },
    taskKind: 'scheduled_instruction', payloadRef: 'system-task:daily-digest', catchUpPolicy: 'latest',
    activityContractRevision: 0, conversationId: 'conversation', presentationBindingId: 'binding',
    expectedBindingRevision: 0, causationId: 'cause',
  });
  current = new Date(DUE);
  await scheduling.wakeDue();
  let effects = 0;
  const terminals = [];
  const scheduled = createPackageBScheduledDeliveryHandler({
    core, now: () => current, hashContent: () => TOKEN,
    decide: async ({ payloadRef }) => ({ replyText: `result for ${payloadRef}`, provider: 'hermes', model: 'test' }),
    send: async () => {
      effects += 1;
      return { resultState: 'sent', evidenceRef: 'feishu:test:sent', evidenceHashToken: TOKEN };
    },
    afterTerminal: async (context, delivery) => terminals.push({ context, delivery }),
  });
  const worker = createCoreWorkRunWorker({
    core, now: () => current, hashContent: () => TOKEN,
    handlers: { scheduled_instruction: scheduled },
  });
  const [result] = await worker.runOnce();
  assert.equal(result.state, 'completed');
  assert.equal(effects, 1);
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0].context.payload_ref, 'system-task:daily-digest');
  assert.equal(terminals[0].delivery.state, 'sent');
  assert.deepEqual(await worker.runOnce(), []);
  assert.equal(effects, 1);
  const inspector = openTestInspector(dbPath);
  assert.equal(inspector.prepare("SELECT count(*) AS count FROM semantic_turn WHERE role='user'").get().count, 0);
  assert.equal(inspector.prepare("SELECT count(*) AS count FROM semantic_turn WHERE role='system' AND visibility='internal'").get().count, 1);
  assert.equal(inspector.prepare("SELECT state FROM presentation_outbox").get().state, 'sent');
  assert.equal(inspector.prepare("SELECT state FROM work_run").get().state, 'completed');
  inspector.close();
  await core.close();
});
