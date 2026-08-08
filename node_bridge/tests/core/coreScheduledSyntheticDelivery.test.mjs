import assert from 'node:assert/strict';
import test from 'node:test';

import { openCoreDatabase } from '../../src/core/coreDb.mjs';
import { createCoreSchedulingService } from '../../src/core/coreScheduling.mjs';
import { runPackageBLocalDelivery } from '../../src/core/packageB/packageBDeliveryService.mjs';
import { createTempCore, openTestInspector, rowCount } from './helpers/testCoreInspector.mjs';

const AT = '2026-07-17T00:00:00.000Z';
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

function epochInput(work, authority) {
  return {
    operationKey: 'scheduled:epoch:1', providerEpochId: 'scheduled-epoch-1', conversationId: CONVERSATION,
    exchangeId: work.exchange_id, sourceTurnId: 'scheduled-instruction-turn', sourceRevision: 1,
    sourceRevisionId: 'scheduled-instruction-r1', provider: 'fixture', model: 'fixture-model',
    capabilitySnapshotRef: 'capability:1', capabilitySnapshotHashToken: TOKEN,
    canonicalSnapshotRef: 'snapshot:1', snapshotHashToken: TOKEN, committedEventCursor: null,
    soulRevisionId: null, bindingId: 'epoch-binding-1', upstreamBindingKind: 'session',
    upstreamHandle: 'fixture-session', upstreamHandleHashToken: TOKEN,
    epochState: 'active', taintState: 'clean', requestIdentity: 'request:epoch:1',
    workRunAuthority: authority, createdAt: DUE,
  };
}

function attemptInput(work) {
  return {
    operationKey: 'scheduled:attempt:1', requestId: 'request:1', epochId: 'scheduled-epoch-1', conversationId: CONVERSATION,
    exchangeId: work.exchange_id, sourceTurnId: 'scheduled-instruction-turn', sourceRevision: 1, attemptNumber: 1,
    resultClass: 'completed', errorClass: null, startedAt: DUE, completedAt: DUE,
    snapshotRef: 'snapshot:1', snapshotHashToken: TOKEN,
    metadataRef: 'provider:metadata:1', metadataHashToken: TOKEN,
  };
}

function finalInput(attempt, work, authority, overrides = {}) {
  return {
    operationKey: 'scheduled:final:1', conversationId: CONVERSATION, exchangeId: work.exchange_id,
    sourceTurnId: 'scheduled-instruction-turn', sourceRevision: 1,
    providerEpochId: 'scheduled-epoch-1', providerAttempt: 1, providerAttemptReceiptId: attempt.resultId,
    assistantTurnId: 'scheduled-assistant-turn', assistantRevisionId: 'scheduled-assistant-r1', assistantActorRef: 'assistant:hermes',
    finalPayloadRef: 'payload:assistant', finalPayloadHashToken: TOKEN, expectedExchangeRevision: 1,
    expectedProviderEpochRevision: 0, workRunAuthority: authority, committedAt: DUE,
    presentations: [
      { outboxId: 'outbox-z', operationScope: 'presentation:desktop', operationKey: 'outbox:z', bindingId: 'binding-1',
        target: 'desktop:conversation', kind: 'text', payloadRef: 'presentation:z', payloadHashToken: TOKEN },
    ],
    ...overrides,
  };
}

async function seedConversation(core) {
  const conversation = await core.writer.write((tx) => tx.packageBTurn.createOrResolveConversation(identity()));
  await core.writer.write((tx) => tx.packageBPresentation.createOrReadBinding({
    operationKey: 'binding:create:1',
    bindingId: 'binding-1', conversationId: CONVERSATION, ownerId: OWNER, sourceInstanceId: 'desktop:local',
    platform: 'desktop', destinationKind: 'conversation', destinationRef: 'desktop:conversation',
    adapterMetadata: { protocol: 'fixture', receiptMode: 'fixture' }, createdAt: AT,
  }));
  return { conversation };
}

async function setup(t, start = AT) {
  const { dbPath } = createTempCore(t, 'hermes-core-scheduled-delivery-');
  let current = new Date(start);
  const core = openCoreDatabase({ dbPath, now: () => current });
  core.migrate();
  const seeded = await seedConversation(core);
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

async function prepareScheduledFinal(core, service, seeded, work, claim) {
  const authority = Object.freeze({
    workRunId: work.work_run_id,
    expectedRevision: claim.revision,
    fenceToken: claim.fenceToken,
    leaseOwner: 'scheduled-worker',
    leaseId: claim.lease.lease_id,
  });
  const instruction = await service.commitScheduledInstruction({
    operationKey: 'scheduled:instruction:1',
    instructionTurnId: 'scheduled-instruction-turn',
    instructionRevisionId: 'scheduled-instruction-r1',
    payloadHashToken: TOKEN,
    authority,
  });
  assert.equal(instruction.disposition, 'applied');
  await core.writer.write((tx) => tx.packageBProvider.createEpoch(epochInput(work, authority)));
  const attempt = await core.writer.write((tx) => tx.packageBProvider.appendAttempt(attemptInput(work)));
  return { authority, final: finalInput(attempt, work, authority), identity: seeded.conversation.identity };
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
  const { wake, work, claim } = await wakeAndClaim(core, service, setNow);

  const inspector = openTestInspector(dbPath);
  assert.equal(rowCount(inspector, 'semantic_turn'), 0);
  assert.equal(rowCount(inspector, 'presentation_outbox'), 0);
  inspector.close();
  const prepared = await prepareScheduledFinal(core, service, seeded, work, claim);
  assert.equal(prepared.final.exchangeId, work.exchange_id);
  assert.equal(prepared.authority.workRunId, work.work_run_id);

  let effects = 0;
  const send = async () => {
    effects += 1;
    return { resultState: 'sent', evidenceRef: 'feishu:synthetic:s11:sent', evidenceHashToken: TOKEN };
  };
  const delivered = await runPackageBLocalDelivery({
    core, identity: prepared.identity, finalInput: prepared.final, workRunAuthority: prepared.authority,
    outboxId: 'outbox-z', workerId: 'scheduled-worker',
    claimedAt: DUE, leaseUntil: '2026-07-17T00:06:00.000Z', send,
  });
  assert.equal(delivered.delivery.state, 'sent');
  assert.equal(delivered.delivery.effectAttempted, true);
  assert.equal(effects, 1);

  const chain = openTestInspector(dbPath);
  assert.equal(chain.prepare("SELECT count(*) AS count FROM semantic_turn WHERE role='user'").get().count, 0);
  assert.deepEqual({ ...chain.prepare(`SELECT turn.role,turn.visibility,turn.exchange_id,
      exchange.root_instruction_turn_id FROM semantic_turn turn
      JOIN exchange ON exchange.exchange_id=turn.exchange_id
      WHERE turn.semantic_turn_id='scheduled-instruction-turn'`).get() }, {
    role: 'system', visibility: 'internal', exchange_id: work.exchange_id,
    root_instruction_turn_id: 'scheduled-instruction-turn',
  });
  assert.equal(chain.prepare("SELECT correlation_id FROM journal_event WHERE event_type='core_scheduled_instruction_committed'").get().correlation_id, work.work_run_id);
  assert.equal(chain.prepare("SELECT active_speculative_work_run_id FROM provider_epoch WHERE provider_epoch_id='scheduled-epoch-1'").get().active_speculative_work_run_id, work.work_run_id);
  assert.deepEqual({ ...chain.prepare(`SELECT exchange_id,actor_ref,correlation_id FROM journal_event
      WHERE event_type='package_b_provider_attempt_recorded'`).get() }, {
    exchange_id: work.exchange_id,
    actor_ref: 'scheduled-instruction-turn',
    correlation_id: 'scheduled-epoch-1',
  });
  assert.equal(chain.prepare("SELECT exchange_id FROM semantic_turn WHERE semantic_turn_id='scheduled-assistant-turn'").get().exchange_id, work.exchange_id);
  assert.equal(chain.prepare("SELECT state FROM presentation_outbox WHERE presentation_outbox_id='outbox-z'").get().state, 'sent');
  assert.equal(chain.prepare('SELECT schedule_spec_revision_id FROM wake_occurrence WHERE wake_occurrence_id=?').get(wake.occurrences[0].wake_occurrence_id).schedule_spec_revision_id, 'schedule-r1');
  assert.equal(work.wake_occurrence_id, wake.occurrences[0].wake_occurrence_id);
  chain.close();

  const losingClaim = await service.claimWorkRun({
    workRunId: work.work_run_id, expectedRevision: Number(work.revision), expectedFence: Number(work.fence_token),
    leaseOwner: 'other-worker', leaseUntil: '2026-07-17T00:06:00.000Z',
    operationKey: 'scheduled-work:claim:2',
  });
  assert.equal(losingClaim, null);

  await core.close();
  const reopened = openCoreDatabase({ dbPath, now: () => new Date('2026-07-17T00:07:00.000Z') });
  const replayed = await runPackageBLocalDelivery({
    core: reopened, identity: prepared.identity, finalInput: prepared.final, workRunAuthority: prepared.authority,
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
  const { work, claim } = await wakeAndClaim(core, service, setNow);
  const prepared = await prepareScheduledFinal(core, service, seeded, work, claim);

  let effects = 0;
  const delivered = await runPackageBLocalDelivery({
    core, identity: prepared.identity, finalInput: prepared.final, workRunAuthority: prepared.authority,
    outboxId: 'outbox-z', workerId: 'scheduled-worker',
    claimedAt: DUE, leaseUntil: '2026-07-17T00:06:00.000Z',
    adapterExceptionResult: {
      resultState: 'ambiguous', evidenceRef: 'feishu:synthetic:s11:timeout',
      evidenceHashToken: TOKEN, errorClass: 'adapter_timeout',
    },
    send: async () => {
      effects += 1;
      throw Object.assign(new Error('synthetic adapter timed out after dispatch'), { code: 'ETIMEDOUT' });
    },
  });
  assert.equal(delivered.delivery.state, 'ambiguous');
  assert.equal(delivered.delivery.effectAttempted, true);
  assert.equal(effects, 1);
  const timeoutEvidence = core.reader.journalPayload(`${delivered.delivery.receiptId}:payload`);
  assert.equal(timeoutEvidence.payload_ref, 'feishu:synthetic:s11:timeout');
  assert.equal(timeoutEvidence.content_hash_token, TOKEN);

  await core.close();
  const reopened = openCoreDatabase({ dbPath, now: () => new Date('2026-07-17T00:07:00.000Z') });
  const replayed = await runPackageBLocalDelivery({
    core: reopened, identity: prepared.identity, finalInput: prepared.final, workRunAuthority: prepared.authority,
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

test('a rotated WorkRun fence rejects the scheduled final before any effect', async (t) => {
  const { core, service, dbPath, seeded, setNow } = await setup(t);
  const { work, claim } = await wakeAndClaim(core, service, setNow);
  const prepared = await prepareScheduledFinal(core, service, seeded, work, claim);
  await core.writer.write((tx) => tx.revisions.rotateWorkRunFence({
    workRunId: work.work_run_id,
    expectedRevision: prepared.authority.expectedRevision,
    expectedFence: prepared.authority.fenceToken,
    nextFence: prepared.authority.fenceToken + 1,
    nextState: 'running',
    reasonCode: 'restart',
    sourceEventId: 'delivery-causation',
    rotationOperationKey: 'scheduled-work:cancel:1',
    updatedAt: DUE,
  }));

  let effects = 0;
  await assert.rejects(runPackageBLocalDelivery({
    core,
    identity: prepared.identity,
    finalInput: prepared.final,
    workRunAuthority: prepared.authority,
    outboxId: 'outbox-z',
    workerId: 'scheduled-worker',
    claimedAt: DUE,
    leaseUntil: '2026-07-17T00:06:00.000Z',
    send: async () => { effects += 1; },
  }), { code: 'CORE_SCHEDULE_WORK_AUTHORITY_STALE' });
  assert.equal(effects, 0);
  const inspector = openTestInspector(dbPath);
  assert.equal(rowCount(inspector, 'presentation_outbox'), 0);
  assert.equal(inspector.prepare("SELECT count(*) AS count FROM semantic_turn WHERE role='assistant'").get().count, 0);
  inspector.close();
  await core.close();
});
