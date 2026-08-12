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

async function setup(t, payloadRef = 'system-task:daily-digest') {
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
      sourceInstanceId: 'node-channel-hub:feishu', platform: 'feishu', destinationKind: 'user',
      destinationRef: 'ou-owner', adapterMetadata: { protocol: 'test', receiptMode: 'typed' }, createdAt: START,
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
    taskKind: 'scheduled_instruction', payloadRef, catchUpPolicy: 'latest',
    activityContractRevision: 0, conversationId: 'conversation', presentationBindingId: 'binding',
    expectedBindingRevision: 0, causationId: 'cause',
  });
  current = new Date(DUE);
  await scheduling.wakeDue();
  return { core, dbPath, now: () => current, workRunId: core.reader.scheduledWorkQueue()[0].work_run_id };
}

test('scheduled WorkRun consumer proves the typed system instruction to terminal receipt chain', async (t) => {
  const { core, dbPath, now } = await setup(t);
  let effects = 0;
  const routes = [];
  const terminals = [];
  const scheduled = createPackageBScheduledDeliveryHandler({
    core, now, hashContent: () => TOKEN,
    decide: async ({ payloadRef }) => ({ replyText: `result for ${payloadRef}`, provider: 'hermes', model: 'test' }),
    send: async (view) => {
      effects += 1;
      routes.push({ platform: view.platform, destinationKind: view.destinationKind, target: view.target });
      return { resultState: 'sent', evidenceRef: 'feishu:test:sent', evidenceHashToken: TOKEN };
    },
    afterTerminal: async (context, delivery) => {
      const inspector = openTestInspector(dbPath);
      terminals.push({ context, delivery, workState: inspector.prepare('SELECT state FROM work_run').get().state });
      inspector.close();
    },
  });
  const worker = createCoreWorkRunWorker({
    core, now, hashContent: () => TOKEN,
    handlers: { scheduled_instruction: scheduled },
  });
  const [result] = await worker.runOnce();
  assert.equal(result.state, 'completed');
  assert.equal(effects, 1);
  assert.deepEqual(routes, [{ platform: 'feishu', destinationKind: 'user', target: 'ou-owner' }]);
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0].context.payload_ref, 'system-task:daily-digest');
  assert.equal(terminals[0].delivery.state, 'sent');
  assert.equal(terminals[0].workState, 'completed');
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

test('reopen after terminal commit retries only the missing acknowledgement', async (t) => {
  const { core, dbPath, now, workRunId } = await setup(t, 'legacy-todo:8');
  let decisions = 0;
  let effects = 0;
  let acknowledgements = 0;
  const interrupted = createPackageBScheduledDeliveryHandler({
    core, now, hashContent: () => TOKEN,
    decide: async () => {
      decisions += 1;
      return { replyText: 'reminder', provider: 'hermes', model: 'test' };
    },
    send: async () => {
      effects += 1;
      return { resultState: 'sent', evidenceRef: 'feishu:test:sent', evidenceHashToken: TOKEN };
    },
    afterTerminal: async () => {
      acknowledgements += 1;
      assert.equal(core.reader.workRun(workRunId).state, 'completed');
      return false;
    },
  });
  const firstWorker = createCoreWorkRunWorker({
    core, now, hashContent: () => TOKEN, handlers: { scheduled_instruction: interrupted },
  });
  assert.equal((await firstWorker.runOnce())[0].state, 'completed');
  assert.equal(core.reader.workRun(workRunId).state, 'completed');
  assert.equal(core.reader.terminalWorkRunsPendingPostTerminal('scheduled_instruction')[0].work_run_id, workRunId);
  assert.equal(decisions, 1);
  assert.equal(effects, 1);
  assert.equal(acknowledgements, 1);
  await core.close();

  const reopened = openCoreDatabase({ dbPath, now });
  const recovering = createPackageBScheduledDeliveryHandler({
    core: reopened, now, hashContent: () => TOKEN,
    decide: async () => { decisions += 1; throw new Error('delivery must not replay'); },
    send: async () => { effects += 1; throw new Error('effect must not replay'); },
    afterTerminal: async (context) => {
      acknowledgements += 1;
      assert.equal(context.payload_ref, 'legacy-todo:8');
      assert.equal(reopened.reader.workRun(context.work_run_id).state, 'completed');
    },
  });
  const recoveredWorker = createCoreWorkRunWorker({
    core: reopened, now, hashContent: () => TOKEN, handlers: { scheduled_instruction: recovering },
  });
  assert.deepEqual(await recoveredWorker.runOnce(), []);
  assert.deepEqual(await recoveredWorker.runOnce(), []);
  assert.equal(decisions, 1);
  assert.equal(effects, 1);
  assert.equal(acknowledgements, 2);
  const inspector = openTestInspector(dbPath);
  assert.equal(inspector.prepare("SELECT count(*) AS count FROM journal_event WHERE event_type='core_work_run_post_terminal_completed'").get().count, 1);
  inspector.close();
  await reopened.close();
});

test('ambiguous adapter outcome remains terminal and is not resent', async (t) => {
  const { core, now, workRunId } = await setup(t, 'legacy-todo:9');
  let effects = 0;
  let acknowledgements = 0;
  const scheduled = createPackageBScheduledDeliveryHandler({
    core, now, hashContent: () => TOKEN,
    decide: async () => ({ replyText: 'reminder', provider: 'hermes', model: 'test' }),
    send: async () => {
      effects += 1;
      throw Object.assign(new Error('unknown adapter outcome'), { code: 'ETIMEDOUT' });
    },
    afterTerminal: async (_context, delivery) => {
      assert.equal(delivery.state, 'ambiguous');
      acknowledgements += 1;
    },
  });
  const worker = createCoreWorkRunWorker({
    core, now, hashContent: () => TOKEN, handlers: { scheduled_instruction: scheduled },
  });
  assert.equal((await worker.runOnce())[0].state, 'completed');
  assert.deepEqual(await worker.runOnce(), []);
  assert.equal(effects, 1);
  assert.equal(acknowledgements, 1);
  assert.equal(core.reader.workRun(workRunId).state, 'completed');
  await core.close();
});
