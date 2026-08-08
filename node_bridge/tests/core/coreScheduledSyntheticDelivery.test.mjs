import assert from 'node:assert/strict';
import test from 'node:test';

import { openCoreDatabase } from '../../src/core/coreDb.mjs';
import { createCoreSchedulingService } from '../../src/core/coreScheduling.mjs';
import { runPackageBLocalDelivery } from '../../src/core/packageB/packageBDeliveryService.mjs';
import { createTempCore, openTestInspector, rowCount } from './helpers/testCoreInspector.mjs';

const AT = '2026-07-17T00:00:00.000Z';
const LATER = '2026-07-17T00:01:00.000Z';
const HARD = '2026-07-17T00:10:00.000Z';
const DUE = '2026-07-17T00:05:00.000Z';
const TOKEN = `hmac-sha256:v1:test-key:${'a'.repeat(64)}`;
const CONVERSATION = 'conversation:owner:desktop';
const OWNER = 'owner';

function identity() {
  return {
    conversationId: CONVERSATION, canonicalConversationKey: CONVERSATION, ownerId: OWNER,
    actorRef: 'actor:owner', platform: 'desktop', primaryFrontend: 'desktop',
    sourceInstanceId: 'desktop:local', platformConversationBinding: 'desktop:conversation', createdAt: AT,
  };
}

function ingress() {
  return {
    ingressEventId: 'ingress-1', operationKey: 'ingress:1', platform: 'desktop', sourceInstanceId: 'desktop:local',
    nativeEventIdTrust: 'trusted', nativeEventId: 'native-1', ownerId: OWNER, actorRef: 'actor:owner',
    platformConversationBinding: 'desktop:conversation', canonicalConversationKey: CONVERSATION,
    payloadRef: 'payload:ingress-1', payloadHashToken: TOKEN, mutationKind: 'create', mutationTargetNativeEventId: null,
    retryOf: null, vendorEventTime: AT, receivedAt: AT, createdAt: AT,
  };
}

function epochInput() {
  return {
    operationKey: 'epoch:1', providerEpochId: 'epoch-1', conversationId: CONVERSATION, exchangeId: 'exchange-1',
    sourceTurnId: 'user-turn', sourceRevision: 1, sourceRevisionId: 'user-r1', provider: 'fixture', model: 'fixture-model',
    capabilitySnapshotRef: 'capability:1', capabilitySnapshotHashToken: TOKEN,
    canonicalSnapshotRef: 'snapshot:1', snapshotHashToken: TOKEN, committedEventCursor: null,
    soulRevisionId: null, bindingId: 'epoch-binding-1', upstreamBindingKind: 'session',
    upstreamHandle: 'fixture-session', upstreamHandleHashToken: TOKEN,
    epochState: 'active', taintState: 'clean', requestIdentity: 'request:epoch:1', createdAt: LATER,
  };
}

function attemptInput() {
  return {
    operationKey: 'attempt:1', requestId: 'request:1', epochId: 'epoch-1', conversationId: CONVERSATION,
    exchangeId: 'exchange-1', sourceTurnId: 'user-turn', sourceRevision: 1, attemptNumber: 1,
    resultClass: 'completed', errorClass: null, startedAt: AT, completedAt: LATER,
    snapshotRef: 'snapshot:1', snapshotHashToken: TOKEN,
    metadataRef: 'provider:metadata:1', metadataHashToken: TOKEN,
  };
}

function finalInput(attempt, overrides = {}) {
  return {
    operationKey: 'final:1', conversationId: CONVERSATION, exchangeId: 'exchange-1', sourceTurnId: 'user-turn', sourceRevision: 1,
    providerEpochId: 'epoch-1', providerAttempt: 1, providerAttemptReceiptId: attempt.resultId,
    assistantTurnId: 'assistant-turn', assistantRevisionId: 'assistant-r1', assistantActorRef: 'assistant:hermes',
    finalPayloadRef: 'payload:assistant', finalPayloadHashToken: TOKEN, expectedExchangeRevision: 1,
    expectedProviderEpochRevision: 0, committedAt: LATER,
    presentations: [
      { outboxId: 'outbox-z', operationScope: 'presentation:desktop', operationKey: 'outbox:z', bindingId: 'binding-1',
        target: 'desktop:conversation', kind: 'text', payloadRef: 'presentation:z', payloadHashToken: TOKEN },
    ],
    ...overrides,
  };
}

async function seedFinalReady(core) {
  const conversation = await core.writer.write((tx) => tx.packageBTurn.createOrResolveConversation(identity()));
  await core.writer.write((tx) => tx.packageBIngress.commit(ingress()));
  await core.writer.write((tx) => tx.packageBPresentation.createOrReadBinding({
    operationKey: 'binding:create:1',
    bindingId: 'binding-1', conversationId: CONVERSATION, ownerId: OWNER, sourceInstanceId: 'desktop:local',
    platform: 'desktop', destinationKind: 'conversation', destinationRef: 'desktop:conversation',
    adapterMetadata: { protocol: 'fixture', receiptMode: 'fixture' }, createdAt: AT,
  }));
  await core.writer.write((tx) => tx.packageBAssembly.create({
    operationKey: 'assembly:create:1', assemblyId: 'assembly-1', conversationId: CONVERSATION,
    quietDeadline: LATER, hardDeadline: HARD, createdAt: AT,
  }));
  await core.writer.write((tx) => tx.packageBAssembly.appendPart({
    operationKey: 'assembly:part:1', partId: 'part-1', assemblyId: 'assembly-1', ingressEventId: 'ingress-1',
    partKind: 'text', sequenceNo: 1, payloadRef: 'payload:part-1', sourceRevision: 0,
    expectedAssemblyRevision: 0, createdAt: AT,
  }));
  await core.writer.write((tx) => tx.packageBAssembly.beginSealing({
    operationKey: 'assembly:begin:1', assemblyId: 'assembly-1', expectedRevision: 1, updatedAt: LATER,
  }));
  const expectedActivePartSetDigest = core.reader.packageBAssembly.activePartSetDigest({
    identity: conversation.identity, conversationId: CONVERSATION, assemblyId: 'assembly-1', expectedRevision: 2,
  });
  const sealed = await core.writer.write((tx) => tx.packageBAssembly.seal({
    operationKey: 'assembly:seal:1', assemblyId: 'assembly-1', conversationId: CONVERSATION,
    expectedRevision: 2, expectedActivePartSetDigest, sealedAt: LATER,
  }));
  await core.writer.write((tx) => tx.packageBTurn.commitUserTurn({
    operationKey: 'user:commit:1', conversationId: CONVERSATION, exchangeId: 'exchange-1', assemblyId: 'assembly-1',
    assemblyRevision: sealed.revision, ingressEventId: 'ingress-1', semanticTurnId: 'user-turn', turnRevisionId: 'user-r1',
    actorRef: 'actor:owner', payloadRef: 'payload:user-r1', payloadHashToken: TOKEN, sourceEventId: sealed.resultId, committedAt: LATER,
  }));
  await core.writer.write((tx) => tx.packageBProvider.createEpoch(epochInput()));
  const attempt = await core.writer.write((tx) => tx.packageBProvider.appendAttempt(attemptInput()));
  return { conversation, attempt };
}

async function setup(t, start = AT) {
  const { dbPath } = createTempCore(t, 'hermes-core-scheduled-delivery-');
  let current = new Date(start);
  const core = openCoreDatabase({ dbPath, now: () => current });
  core.migrate();
  const seeded = await seedFinalReady(core);
  const service = createCoreSchedulingService({ core, batchSize: 16 });
  await core.writer.write((tx) => {
    tx.journal.append({
      eventId: 'delivery-causation', eventType: 'schedule_requested', ownerId: OWNER,
      conversationId: CONVERSATION, originRef: 'fixture', sourceKind: 'test', sourceRef: 'fixture', createdAt: AT,
    });
    tx.activities.create({
      activityId: 'activity', ownerId: OWNER, conversationId: CONVERSATION, title: 'Scheduled visible work',
      goalRef: 'goal:scheduled', domain: 'personal', riskClass: 'reversible',
      autonomyLevel: 1, state: 'active', contractRevision: 0,
      resumePolicy: 'bounded_auto', reportPolicy: 'milestone', createdAt: AT,
    });
  });
  const binding = core.reader.packageBPresentation.binding({
    identity: seeded.conversation.identity, conversationId: CONVERSATION, bindingId: 'binding-1',
  });
  await service.createSchedule({
    scheduleSpecId: 'schedule', scheduleSpecRevisionId: 'schedule-r1',
    activityId: 'activity', operationKey: 'schedule:create',
    recurrence: { kind: 'one_shot', at: DUE },
    taskKind: 'scheduled_instruction', payloadRef: 'task:fixture',
    catchUpPolicy: 'latest', activityContractRevision: 0,
    conversationId: CONVERSATION, presentationBindingId: 'binding-1',
    expectedBindingRevision: Number(binding.revision),
    causationId: 'delivery-causation',
  });
  return { core, service, dbPath, seeded, setNow: (value) => { current = new Date(value); } };
}

async function wakeAndClaim(core, service, setNow) {
  setNow(DUE);
  const [wake] = await service.wakeDue();
  assert.equal(wake.disposition, 'woken');
  assert.equal(wake.occurrences.length, 1);
  const work = core.reader.workRunsForOccurrence(wake.occurrences[0].wake_occurrence_id)[0];
  assert.ok(work, 'one scheduled WorkRun must exist');
  assert.ok(work.exchange_id, 'message-capable wake must bind a typed Exchange');
  const claim = await service.claimWorkRun({
    workRunId: work.work_run_id, expectedRevision: Number(work.revision), expectedFence: Number(work.fence_token),
    leaseOwner: 'scheduled-worker', leaseUntil: '2026-07-17T00:06:00.000Z',
    operationKey: 'scheduled-work:claim:1',
  });
  assert.equal(claim.disposition, 'applied');
  return { wake, work, claim };
}

test('scheduled wake delivers one synthetic effect once across reopen and replay', async (t) => {
  const { core, service, dbPath, seeded, setNow } = await setup(t);
  const { work } = await wakeAndClaim(core, service, setNow);

  const inspector = openTestInspector(dbPath);
  assert.equal(rowCount(inspector, 'semantic_turn'), 1);
  assert.equal(rowCount(inspector, 'presentation_outbox'), 0);
  inspector.close();

  let effects = 0;
  const send = async () => {
    effects += 1;
    return { resultState: 'sent', evidenceRef: 'feishu:synthetic:s11:sent', evidenceHashToken: TOKEN };
  };
  const delivered = await runPackageBLocalDelivery({
    core, identity: seeded.conversation.identity, finalInput: finalInput(seeded.attempt),
    outboxId: 'outbox-z', workerId: 'scheduled-worker',
    claimedAt: DUE, leaseUntil: '2026-07-17T00:06:00.000Z', send,
  });
  assert.equal(delivered.delivery.state, 'sent');
  assert.equal(delivered.delivery.effectAttempted, true);
  assert.equal(effects, 1);

  const losingClaim = await service.claimWorkRun({
    workRunId: work.work_run_id, expectedRevision: Number(work.revision), expectedFence: Number(work.fence_token),
    leaseOwner: 'other-worker', leaseUntil: '2026-07-17T00:06:00.000Z',
    operationKey: 'scheduled-work:claim:2',
  });
  assert.equal(losingClaim, null);

  await core.close();
  const reopened = openCoreDatabase({ dbPath, now: () => new Date('2026-07-17T00:07:00.000Z') });
  const replayed = await runPackageBLocalDelivery({
    core: reopened, identity: seeded.conversation.identity, finalInput: finalInput(seeded.attempt),
    outboxId: 'outbox-z', workerId: 'scheduled-worker',
    claimedAt: '2026-07-17T00:07:00.000Z', leaseUntil: '2026-07-17T00:08:00.000Z',
    send: async () => { throw new Error('terminal Core outbox must not resend'); },
  });
  assert.deepEqual(replayed.delivery, {
    disposition: 'terminal', state: 'sent', effectAttempted: false, outboxId: 'outbox-z',
  });
  assert.equal(effects, 1);
  await reopened.close();
});

test('a timed-out scheduled effect terminalizes ambiguous and restart never redispatches', async (t) => {
  const { core, service, dbPath, seeded, setNow } = await setup(t);
  await wakeAndClaim(core, service, setNow);

  let effects = 0;
  const delivered = await runPackageBLocalDelivery({
    core, identity: seeded.conversation.identity, finalInput: finalInput(seeded.attempt),
    outboxId: 'outbox-z', workerId: 'scheduled-worker',
    claimedAt: DUE, leaseUntil: '2026-07-17T00:06:00.000Z',
    send: async () => {
      effects += 1;
      return { resultState: 'ambiguous', evidenceRef: 'feishu:synthetic:s11:timeout', evidenceHashToken: TOKEN, errorClass: 'adapter_timeout' };
    },
  });
  assert.equal(delivered.delivery.state, 'ambiguous');
  assert.equal(delivered.delivery.effectAttempted, true);
  assert.equal(effects, 1);

  await core.close();
  const reopened = openCoreDatabase({ dbPath, now: () => new Date('2026-07-17T00:07:00.000Z') });
  const replayed = await runPackageBLocalDelivery({
    core: reopened, identity: seeded.conversation.identity, finalInput: finalInput(seeded.attempt),
    outboxId: 'outbox-z', workerId: 'scheduled-worker',
    claimedAt: '2026-07-17T00:07:00.000Z', leaseUntil: '2026-07-17T00:08:00.000Z',
    send: async () => { effects += 1; throw new Error('ambiguous outcome forbids redispatch'); },
  });
  assert.deepEqual(replayed.delivery, {
    disposition: 'terminal', state: 'ambiguous', effectAttempted: false, outboxId: 'outbox-z',
  });
  assert.equal(effects, 1);
  await reopened.close();
});
