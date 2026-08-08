import assert from 'node:assert/strict';
import test from 'node:test';

import { openCoreDatabase } from '../../src/core/coreDb.mjs';
import { runPackageBLocalDelivery } from '../../src/core/packageB/packageBDeliveryService.mjs';
import { createTempCore } from './helpers/testCoreInspector.mjs';

const AT = '2026-07-17T00:00:00.000Z';
const LATER = '2026-07-17T00:01:00.000Z';
const LATER_2 = '2026-07-17T00:02:00.000Z';
const LATER_3 = '2026-07-17T00:03:00.000Z';
const HARD = '2026-07-17T00:10:00.000Z';
const TOKEN = `hmac-sha256:v1:test-key:${'a'.repeat(64)}`;
const CONVERSATION = 'conversation:owner:desktop';
const OWNER = 'owner';

function identity(overrides = {}) {
  return {
    conversationId: CONVERSATION, canonicalConversationKey: CONVERSATION, ownerId: OWNER,
    actorRef: 'actor:owner', platform: 'desktop', primaryFrontend: 'desktop',
    sourceInstanceId: 'desktop:local', platformConversationBinding: 'desktop:conversation', createdAt: AT,
    ...overrides,
  };
}

function ingress(overrides = {}) {
  return {
    ingressEventId: 'ingress-1', operationKey: 'ingress:1', platform: 'desktop', sourceInstanceId: 'desktop:local',
    nativeEventIdTrust: 'trusted', nativeEventId: 'native-1', ownerId: OWNER, actorRef: 'actor:owner',
    platformConversationBinding: 'desktop:conversation', canonicalConversationKey: CONVERSATION,
    payloadRef: 'payload:ingress-1', payloadHashToken: TOKEN, mutationKind: 'create', mutationTargetNativeEventId: null,
    retryOf: null, vendorEventTime: AT, receivedAt: AT, createdAt: AT, ...overrides,
  };
}

function epochInput(overrides = {}) {
  return {
    operationKey: 'epoch:1', providerEpochId: 'epoch-1', conversationId: CONVERSATION, exchangeId: 'exchange-1',
    sourceTurnId: 'user-turn', sourceRevision: 1, sourceRevisionId: 'user-r1', provider: 'fixture', model: 'fixture-model',
    capabilitySnapshotRef: 'capability:1', capabilitySnapshotHashToken: TOKEN,
    canonicalSnapshotRef: 'snapshot:1', snapshotHashToken: TOKEN, committedEventCursor: null,
    soulRevisionId: null, bindingId: 'epoch-binding-1', upstreamBindingKind: 'session',
    upstreamHandle: 'fixture-session', upstreamHandleHashToken: TOKEN,
    epochState: 'active', taintState: 'clean', requestIdentity: 'request:epoch:1', createdAt: LATER,
    ...overrides,
  };
}

function attemptInput(overrides = {}) {
  return {
    operationKey: 'attempt:1', requestId: 'request:1', epochId: 'epoch-1', conversationId: CONVERSATION,
    exchangeId: 'exchange-1', sourceTurnId: 'user-turn', sourceRevision: 1, attemptNumber: 1,
    resultClass: 'completed', errorClass: null, startedAt: AT, completedAt: LATER,
    snapshotRef: 'snapshot:1', snapshotHashToken: TOKEN,
    metadataRef: 'provider:metadata:1', metadataHashToken: TOKEN,
    ...overrides,
  };
}

async function openFixture(t, prefix = 'hermes-core-b11-') {
  const { dbPath } = createTempCore(t, prefix);
  const core = openCoreDatabase({ dbPath });
  core.migrate();
  return { core, dbPath };
}

async function seedAssembly(core) {
  const conversation = await core.writer.write((tx) => tx.packageBTurn.createOrResolveConversation(identity()));
  const accepted = await core.writer.write((tx) => tx.packageBIngress.commit(ingress()));
  const binding = await core.writer.write((tx) => tx.packageBPresentation.createOrReadBinding({
    operationKey: 'binding:create:1',
    bindingId: 'binding-1', conversationId: CONVERSATION, ownerId: OWNER, sourceInstanceId: 'desktop:local',
    platform: 'desktop', destinationKind: 'conversation', destinationRef: 'desktop:conversation',
    adapterMetadata: { protocol: 'fixture', receiptMode: 'fixture' }, createdAt: AT,
  }));
  const assembly = await core.writer.write((tx) => tx.packageBAssembly.create({
    operationKey: 'assembly:create:1', assemblyId: 'assembly-1', conversationId: CONVERSATION,
    quietDeadline: LATER, hardDeadline: HARD, createdAt: AT,
  }));
  const part = await core.writer.write((tx) => tx.packageBAssembly.appendPart({
    operationKey: 'assembly:part:1', partId: 'part-1', assemblyId: 'assembly-1', ingressEventId: 'ingress-1',
    partKind: 'text', sequenceNo: 1, payloadRef: 'payload:part-1', sourceRevision: 0,
    expectedAssemblyRevision: 0, createdAt: AT,
  }));
  return { conversation, accepted, binding, assembly, part };
}

async function seal(core, conversationIdentity) {
  await core.writer.write((tx) => tx.packageBAssembly.beginSealing({
    operationKey: 'assembly:begin:1', assemblyId: 'assembly-1', expectedRevision: 1, updatedAt: LATER,
  }));
  const expectedActivePartSetDigest = core.reader.packageBAssembly.activePartSetDigest({
    identity: conversationIdentity, conversationId: CONVERSATION, assemblyId: 'assembly-1', expectedRevision: 2,
  });
  return core.writer.write((tx) => tx.packageBAssembly.seal({
    operationKey: 'assembly:seal:1', assemblyId: 'assembly-1', conversationId: CONVERSATION,
    expectedRevision: 2, expectedActivePartSetDigest, sealedAt: LATER,
  }));
}

async function seedUserReady(core) {
  const base = await seedAssembly(core);
  const sealed = await seal(core, base.conversation.identity);
  const user = await core.writer.write((tx) => tx.packageBTurn.commitUserTurn({
    operationKey: 'user:commit:1', conversationId: CONVERSATION, exchangeId: 'exchange-1', assemblyId: 'assembly-1',
    assemblyRevision: sealed.revision, ingressEventId: 'ingress-1', semanticTurnId: 'user-turn', turnRevisionId: 'user-r1',
    actorRef: 'actor:owner', payloadRef: 'payload:user-r1', payloadHashToken: TOKEN, sourceEventId: sealed.resultId, committedAt: LATER,
  }));
  return { ...base, sealed, user };
}

async function seedFinalReady(core) {
  const base = await seedUserReady(core);
  const epoch = await core.writer.write((tx) => tx.packageBProvider.createEpoch(epochInput()));
  const attempt = await core.writer.write((tx) => tx.packageBProvider.appendAttempt(attemptInput()));
  return { ...base, epoch, attempt };
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
      { outboxId: 'outbox-a', operationScope: 'presentation:desktop', operationKey: 'outbox:a', bindingId: 'binding-1',
        target: 'desktop:conversation', kind: 'image', payloadRef: 'presentation:a', payloadHashToken: TOKEN },
    ],
    ...overrides,
  };
}

test('Conversation identity is immutable, complete, scoped, and independent from presentation routes', async (t) => {
  const { core, dbPath } = await openFixture(t, 'hermes-core-b11-identity-');
  const first = await core.writer.write((tx) => tx.packageBTurn.createOrResolveConversation(identity()));
  const replay = await core.writer.write((tx) => tx.packageBTurn.createOrResolveConversation(identity()));
  assert.equal(first.disposition, 'applied');
  assert.equal(replay.disposition, 'already_applied');
  assert.deepEqual(replay.identity, first.identity);
  for (const changed of [
    { actorRef: 'actor:other' }, { platform: 'wechat', primaryFrontend: 'wechat' },
    { sourceInstanceId: 'desktop:other' }, { platformConversationBinding: 'desktop:other' },
  ]) await assert.rejects(core.writer.write((tx) => tx.packageBTurn.createOrResolveConversation(identity(changed))), {
    code: 'CORE_OPERATION_KEY_CONFLICT',
  });
  assert.deepEqual(core.reader.packageBTurn.conversationByCanonicalKey({ identity: first.identity }), first.identity);
  assert.equal(core.reader.packageBTurn.conversationByCanonicalKey({ identity: { ...first.identity, ownerId: 'other' } }), undefined);
  const route = await core.writer.write((tx) => tx.packageBPresentation.createOrReadBinding({
    operationKey: 'binding:identity:1',
    bindingId: 'binding-1', conversationId: CONVERSATION, ownerId: OWNER, sourceInstanceId: 'desktop:local', platform: 'desktop',
    destinationKind: 'conversation', destinationRef: 'route:shared', adapterMetadata: { protocol: 'fixture' }, createdAt: AT,
  }));
  await core.writer.write((tx) => tx.packageBTurn.createOrResolveConversation(identity({
    conversationId: 'conversation:second', canonicalConversationKey: 'conversation:second', platformConversationBinding: 'desktop:second',
  })));
  await assert.rejects(core.writer.write((tx) => tx.packageBPresentation.createOrReadBinding({
    operationKey: 'binding:identity:other',
    bindingId: 'binding-other', conversationId: 'conversation:second', ownerId: OWNER, sourceInstanceId: 'desktop:local', platform: 'desktop',
    destinationKind: 'conversation', destinationRef: 'route:shared', adapterMetadata: { protocol: 'fixture' }, createdAt: AT,
  })), { code: 'CORE_PRESENTATION_BINDING_CONFLICT' });
  assert.equal((await core.writer.write((tx) => tx.packageBPresentation.createOrReadBinding({
    operationKey: 'binding:identity:new-route',
    bindingId: 'binding-new-route', conversationId: CONVERSATION, ownerId: OWNER, sourceInstanceId: 'desktop:local', platform: 'desktop',
    destinationKind: 'conversation', destinationRef: 'route:changed', adapterMetadata: { protocol: 'fixture' }, createdAt: LATER,
  }))).binding.conversation_id, route.binding.conversation_id);
  await core.close();
  const reopened = openCoreDatabase({ dbPath });
  assert.equal(reopened.reader.packageBTurn.conversationIdentity({ identity: first.identity, conversationId: CONVERSATION }).actorRef, 'actor:owner');
  await reopened.close();
});

test('trusted ingress is stable across local retry time and rejects semantic conflicts without writes', async (t) => {
  const { core, dbPath } = await openFixture(t, 'hermes-core-b11-ingress-');
  const conversation = await core.writer.write((tx) => tx.packageBTurn.createOrResolveConversation(identity()));
  const first = await core.writer.write((tx) => tx.packageBIngress.commit(ingress()));
  const replay = await core.writer.write((tx) => tx.packageBIngress.commit(ingress({ receivedAt: LATER })));
  assert.equal(replay.disposition, 'already_applied');
  const duplicate = await core.writer.write((tx) => tx.packageBIngress.commit(ingress({ ingressEventId: 'ingress-duplicate', operationKey: 'ingress:retry', receivedAt: LATER_2 })));
  assert.equal(duplicate.disposition, 'duplicate_native');
  assert.equal(duplicate.resultId, first.resultId);
  const before = { ingress: core.reader.ingressEventCount(), journal: core.reader.journalEventCount() };
  await assert.rejects(core.writer.write((tx) => tx.packageBIngress.commit(ingress({ operationKey: 'ingress:payload-change', payloadRef: 'payload:changed' }))), { code: 'CORE_OPERATION_KEY_CONFLICT' });
  assert.deepEqual({ ingress: core.reader.ingressEventCount(), journal: core.reader.journalEventCount() }, before);
  assert.equal(core.reader.packageBIngress.byId({ identity: conversation.identity, ingressEventId: 'ingress-1' }).received_at, AT);
  assert.equal(core.reader.packageBIngress.byId({ identity: { ...conversation.identity, ownerId: 'other' }, ingressEventId: 'ingress-1' }), undefined);
  await core.close();
  const reopened = openCoreDatabase({ dbPath });
  assert.equal((await reopened.writer.write((tx) => tx.packageBIngress.commit(ingress({ receivedAt: LATER_2 })))).resultId, first.resultId);
  await reopened.close();
});

test('assembly seal recomputes ordered active rows, persists lifecycle receipts, and fails closed', async (t) => {
  const { core } = await openFixture(t, 'hermes-core-b11-assembly-');
  const ready = await seedAssembly(core);
  const before = core.reader.journalEventCount();
  await assert.rejects(core.writer.write((tx) => tx.packageBAssembly.updateQuietDeadline({
    operationKey: 'assembly:quiet:backward', assemblyId: 'assembly-1', expectedRevision: 1, quietDeadline: AT, updatedAt: LATER,
  })), { code: 'CORE_ASSEMBLY_DEADLINE_INVALID' });
  await core.writer.write((tx) => tx.packageBAssembly.beginSealing({ operationKey: 'assembly:begin:1', assemblyId: 'assembly-1', expectedRevision: 1, updatedAt: LATER }));
  await assert.rejects(core.writer.write((tx) => tx.packageBAssembly.seal({
    operationKey: 'assembly:seal:fake', assemblyId: 'assembly-1', conversationId: CONVERSATION, expectedRevision: 2,
    expectedActivePartSetDigest: `sha256:v1:${'b'.repeat(64)}`, sealedAt: LATER,
  })), { code: 'CORE_ASSEMBLY_SEAL_DIGEST_CONFLICT' });
  assert.equal(core.reader.journalEventCount(), before + 1);
  const expected = core.reader.packageBAssembly.activePartSetDigest({ identity: ready.conversation.identity, conversationId: CONVERSATION, assemblyId: 'assembly-1', expectedRevision: 2 });
  const sealed = await core.writer.write((tx) => tx.packageBAssembly.seal({
    operationKey: 'assembly:seal:1', assemblyId: 'assembly-1', conversationId: CONVERSATION, expectedRevision: 2,
    expectedActivePartSetDigest: expected, sealedAt: LATER,
  }));
  assert.equal(sealed.disposition, 'applied');
  assert.equal((await core.writer.write((tx) => tx.packageBAssembly.beginSealing({
    operationKey: 'assembly:begin:1', assemblyId: 'assembly-1', expectedRevision: 1, updatedAt: LATER,
  }))).resultId.startsWith('package-b:assembly_sealing_started:'), true);
  assert.equal((await core.writer.write((tx) => tx.packageBAssembly.appendPart({
    operationKey: 'assembly:part:1', partId: 'part-1', assemblyId: 'assembly-1', ingressEventId: 'ingress-1',
    partKind: 'text', sequenceNo: 1, payloadRef: 'payload:part-1', sourceRevision: 0,
    expectedAssemblyRevision: 0, createdAt: AT,
  }))).resultId, ready.part.resultId);
  assert.equal((await core.writer.write((tx) => tx.packageBAssembly.seal({
    operationKey: 'assembly:seal:1', assemblyId: 'assembly-1', conversationId: CONVERSATION, expectedRevision: 2,
    expectedActivePartSetDigest: expected, sealedAt: LATER,
  }))).resultId, sealed.resultId);
  await assert.rejects(core.writer.write((tx) => tx.packageBAssembly.appendPart({
    operationKey: 'assembly:late', partId: 'part-late', assemblyId: 'assembly-1', ingressEventId: 'ingress-1', partKind: 'text', sequenceNo: 2,
    payloadRef: 'payload:late', sourceRevision: 1, expectedAssemblyRevision: sealed.revision, createdAt: LATER,
  })), { code: 'CORE_ASSEMBLY_NOT_OPEN' });
  assert.equal(core.reader.packageBAssembly.byId({ identity: ready.conversation.identity, conversationId: 'wrong', assemblyId: 'assembly-1' }), undefined);
  await core.close();
});

test('assembly supersede and withdrawal are receipted and cannot fabricate a seal from an empty active set', async (t) => {
  const { core } = await openFixture(t, 'hermes-core-b11-assembly-states-');
  const ready = await seedAssembly(core);
  await core.writer.write((tx) => tx.packageBIngress.commit(ingress({
    ingressEventId: 'ingress-2', operationKey: 'ingress:2', nativeEventId: 'native-2', payloadRef: 'payload:ingress-2',
  })));
  await core.writer.write((tx) => tx.packageBAssembly.appendPart({
    operationKey: 'assembly:part:2', partId: 'part-2', assemblyId: 'assembly-1', ingressEventId: 'ingress-2', partKind: 'other',
    sequenceNo: 2, payloadRef: 'payload:part-2', sourceRevision: 0, expectedAssemblyRevision: 1,
    otherMetadata: { mediaKind: 'video', mimeType: 'video/mp4', sizeBytes: 1 }, createdAt: LATER,
  }));
  const supersedeInput = {
    operationKey: 'assembly:supersede:1', partId: 'part-1', assemblyId: 'assembly-1', expectedAssemblyRevision: 2, updatedAt: LATER,
  };
  const superseded = await core.writer.write((tx) => tx.packageBAssembly.supersedePart(supersedeInput));
  assert.equal(superseded.part.state, 'superseded');
  assert.equal((await core.writer.write((tx) => tx.packageBAssembly.supersedePart(supersedeInput))).resultId, superseded.resultId);
  const withdrawInput = {
    operationKey: 'assembly:withdraw:2', partId: 'part-2', assemblyId: 'assembly-1', expectedAssemblyRevision: 3, updatedAt: LATER,
  };
  const withdrawn = await core.writer.write((tx) => tx.packageBAssembly.withdrawPart(withdrawInput));
  assert.equal(withdrawn.part.state, 'withdrawn');
  assert.equal((await core.writer.write((tx) => tx.packageBAssembly.withdrawPart(withdrawInput))).resultId, withdrawn.resultId);
  await core.writer.write((tx) => tx.packageBAssembly.beginSealing({
    operationKey: 'assembly:begin:empty', assemblyId: 'assembly-1', expectedRevision: 4, updatedAt: LATER,
  }));
  assert.equal((await core.writer.write((tx) => tx.packageBAssembly.supersedePart(supersedeInput))).resultId, superseded.resultId);
  assert.throws(() => core.reader.packageBAssembly.activePartSetDigest({
    identity: ready.conversation.identity, conversationId: CONVERSATION, assemblyId: 'assembly-1', expectedRevision: 5,
  }), { code: 'CORE_ASSEMBLY_EMPTY' });
  await core.close();
});

test('AC-01 seal treats the caller digest as an optional assertion and replays the first internal digest', async (t) => {
  const { core, dbPath } = await openFixture(t, 'hermes-core-b12-seal-');
  await seedAssembly(core);
  await core.writer.write((tx) => tx.packageBAssembly.beginSealing({
    operationKey: 'assembly:begin:optional', assemblyId: 'assembly-1', expectedRevision: 1, updatedAt: LATER,
  }));
  const input = {
    operationKey: 'assembly:seal:optional', assemblyId: 'assembly-1', conversationId: CONVERSATION,
    expectedRevision: 2, sealedAt: LATER,
  };
  const before = core.reader.journalEventCount();
  const [first, concurrentReplay] = await Promise.all([
    core.writer.write((tx) => tx.packageBAssembly.seal(input)),
    core.writer.write((tx) => tx.packageBAssembly.seal(input)),
  ]);
  assert.equal(first.disposition, 'applied');
  assert.equal(concurrentReplay.disposition, 'already_applied');
  assert.equal(concurrentReplay.resultId, first.resultId);
  assert.equal(core.reader.journalEventCount(), before + 1);
  await core.close();

  const reopened = openCoreDatabase({ dbPath });
  const replay = await reopened.writer.write((tx) => tx.packageBAssembly.seal(input));
  assert.equal(replay.disposition, 'already_applied');
  assert.equal(replay.resultId, first.resultId);
  assert.equal(replay.operationDigest, first.operationDigest);
  await reopened.close();
});

test('assembly terminal lifecycle operations replay before current-state validation', async (t) => {
  const { core: rejectCore } = await openFixture(t, 'hermes-core-b12-reject-replay-');
  await seedAssembly(rejectCore);
  const rejectInput = {
    operationKey: 'assembly:reject:replay', assemblyId: 'assembly-1', expectedRevision: 1, updatedAt: LATER,
  };
  const rejected = await rejectCore.writer.write((tx) => tx.packageBAssembly.reject(rejectInput));
  assert.equal((await rejectCore.writer.write((tx) => tx.packageBAssembly.reject(rejectInput))).resultId, rejected.resultId);
  await rejectCore.close();

  const { core: interruptCore } = await openFixture(t, 'hermes-core-b12-interrupt-replay-');
  await seedAssembly(interruptCore);
  const interruptInput = {
    operationKey: 'assembly:interrupt:replay', assemblyId: 'assembly-1', expectedRevision: 1, updatedAt: LATER,
  };
  const interrupted = await interruptCore.writer.write((tx) => tx.packageBAssembly.interrupt(interruptInput));
  assert.equal((await interruptCore.writer.write((tx) => tx.packageBAssembly.interrupt(interruptInput))).resultId, interrupted.resultId);
  await interruptCore.close();
});

test('AC-04 quiet-deadline replay returns its first revision after later state changes', async (t) => {
  const { core, dbPath } = await openFixture(t, 'hermes-core-b12-quiet-');
  const ready = await seedAssembly(core);
  const firstInput = {
    operationKey: 'assembly:quiet:first', assemblyId: 'assembly-1', expectedRevision: 1,
    quietDeadline: LATER_2, updatedAt: LATER_2,
  };
  const first = await core.writer.write((tx) => tx.packageBAssembly.updateQuietDeadline(firstInput));
  assert.equal(first.revision, 2);
  await core.writer.write((tx) => tx.packageBAssembly.updateQuietDeadline({
    operationKey: 'assembly:quiet:later', assemblyId: 'assembly-1', expectedRevision: 2,
    quietDeadline: LATER_3, updatedAt: LATER_3,
  }));
  const journalCount = core.reader.journalEventCount();
  const replay = await core.writer.write((tx) => tx.packageBAssembly.updateQuietDeadline(firstInput));
  assert.equal(replay.disposition, 'already_applied');
  assert.equal(replay.resultId, first.resultId);
  assert.equal(replay.revision, 2);
  assert.equal(core.reader.journalEventCount(), journalCount);
  const sameDeadline = await core.writer.write((tx) => tx.packageBAssembly.updateQuietDeadline({
    operationKey: 'assembly:quiet:same', assemblyId: 'assembly-1', expectedRevision: 3,
    quietDeadline: LATER_3, updatedAt: LATER_3,
  }));
  assert.equal(sameDeadline.disposition, 'already_current');
  assert.equal(core.reader.packageBAssembly.byId({ identity: ready.conversation.identity, conversationId: CONVERSATION, assemblyId: 'assembly-1' }).revision, 3);
  assert.equal(core.reader.journalEventCount(), journalCount);
  await core.close();

  const reopened = openCoreDatabase({ dbPath });
  const reopenedReplay = await reopened.writer.write((tx) => tx.packageBAssembly.updateQuietDeadline(firstInput));
  assert.equal(reopenedReplay.resultId, first.resultId);
  assert.equal(reopenedReplay.revision, 2);
  await reopened.close();
});

test('AC-05 terminal failed and sent outboxes never become dispatch-authorized claims', async (t) => {
  const { core, dbPath } = await openFixture(t, 'hermes-core-b12-terminal-');
  const ready = await seedFinalReady(core);
  const { attempt } = ready;
  const final = await core.writer.write((tx) => tx.packageBFinal.commit(finalInput(attempt)));

  async function record(outboxId, suffix, resultState) {
    const claim = await core.writer.write((tx) => tx.packageBPresentation.claim({
      operationKey: `claim:${suffix}:initial`, workerId: 'worker-1', outboxId, expectedRevision: 0, expectedFence: 0,
      leaseOwner: 'worker-1', leaseUntil: '2026-07-17T00:05:00.000Z', claimedAt: LATER,
      causationEventId: final.resultId,
    }));
    await core.writer.write((tx) => tx.packageBPresentation.markDispatchStarted({
      operationKey: `dispatch:${suffix}:initial`, outboxId, claimOperationKey: `claim:${suffix}:initial`,
      expectedRevision: claim.revision, fenceToken: claim.fenceToken, leaseOwner: 'worker-1', startedAt: LATER,
    }));
    await core.writer.write((tx) => tx.packageBPresentation.recordResult({
      operationKey: `result:${suffix}:${resultState}`, outboxId, claimOperationKey: `claim:${suffix}:initial`,
      expectedRevision: claim.revision, fenceToken: claim.fenceToken, leaseOwner: 'worker-1', resultState,
      evidenceRef: `evidence:${suffix}:${resultState}`, evidenceHashToken: TOKEN,
      errorClass: resultState === 'failed' ? 'definitive_failure' : null, recordedAt: LATER_2,
    }));
  }

  await record('outbox-z', 'z', 'failed');
  const failedBefore = core.reader.packageBPresentation.outbox({ identity: ready.conversation.identity, conversationId: CONVERSATION, outboxId: 'outbox-z' });
  const journalBefore = core.reader.journalEventCount();
  const terminalInput = {
    workerId: 'worker-2', outboxId: 'outbox-z', expectedRevision: Number(failedBefore.revision),
    expectedFence: Number(failedBefore.fence_token), leaseOwner: 'worker-2',
    leaseUntil: '2026-07-17T00:07:00.000Z', claimedAt: LATER_3, causationEventId: final.resultId,
  };
  const [left, right] = await Promise.all([
    core.writer.write((tx) => tx.packageBPresentation.claim({ ...terminalInput, operationKey: 'claim:z:terminal:left' })),
    core.writer.write((tx) => tx.packageBPresentation.claim({ ...terminalInput, operationKey: 'claim:z:terminal:right' })),
  ]);
  for (const result of [left, right]) {
    assert.equal(result.disposition, 'terminal_not_claimable');
    assert.equal(result.dispatchAuthorized, false);
    assert.equal(result.state, 'failed');
  }
  assert.equal(core.reader.journalEventCount(), journalBefore);
  assert.deepEqual(core.reader.packageBPresentation.outbox({ identity: ready.conversation.identity, conversationId: CONVERSATION, outboxId: 'outbox-z' }), failedBefore);

  await record('outbox-a', 'a', 'sent');
  const sentOutbox = core.reader.packageBPresentation.outbox({ identity: ready.conversation.identity, conversationId: CONVERSATION, outboxId: 'outbox-a' });
  const sentClaim = await core.writer.write((tx) => tx.packageBPresentation.claim({
    operationKey: 'claim:a:terminal', workerId: 'worker-2', outboxId: 'outbox-a',
    expectedRevision: Number(sentOutbox.revision), expectedFence: Number(sentOutbox.fence_token),
    leaseOwner: 'worker-2', leaseUntil: '2026-07-17T00:07:00.000Z', claimedAt: LATER_3,
    causationEventId: final.resultId,
  }));
  assert.equal(sentClaim.disposition, 'terminal_not_claimable');
  assert.equal(sentClaim.dispatchAuthorized, false);
  await core.close();

  const reopened = openCoreDatabase({ dbPath });
  const reopenedClaim = await reopened.writer.write((tx) => tx.packageBPresentation.claim({
    ...terminalInput, operationKey: 'claim:z:terminal:reopen',
  }));
  assert.equal(reopenedClaim.disposition, 'terminal_not_claimable');
  assert.equal(reopenedClaim.dispatchAuthorized, false);
  await reopened.close();
});

test('AC-03 final routes come from the binding and typed readback preserves kind hash and order', async (t) => {
  const { core, dbPath } = await openFixture(t, 'hermes-core-b12-route-');
  const ready = await seedFinalReady(core);
  const { attempt } = ready;
  assert.equal((await core.writer.write((tx) => tx.packageBPresentation.createOrReadBinding({
    operationKey: 'binding:create:1', bindingId: 'binding-1', conversationId: CONVERSATION, ownerId: OWNER,
    sourceInstanceId: 'desktop:local', platform: 'desktop', destinationKind: 'conversation',
    destinationRef: 'desktop:conversation', adapterMetadata: { protocol: 'fixture', receiptMode: 'fixture' }, createdAt: AT,
  }))).resultId, ready.binding.resultId);
  await assert.rejects(core.writer.write((tx) => tx.packageBPresentation.createOrReadBinding({
    operationKey: 'binding:create:1', bindingId: 'binding-1', conversationId: CONVERSATION, ownerId: OWNER,
    sourceInstanceId: 'desktop:local', platform: 'desktop', destinationKind: 'user',
    destinationRef: 'desktop:conversation', adapterMetadata: { protocol: 'fixture', receiptMode: 'fixture' }, createdAt: AT,
  })), { code: 'CORE_OPERATION_KEY_CONFLICT' });
  assert.equal(core.reader.packageBPresentation.binding({
    identity: ready.conversation.identity, conversationId: CONVERSATION, bindingId: 'binding-1',
  }).destination_kind, 'conversation');
  const before = core.reader.journalEventCount();
  const mismatches = [
    { target: 'desktop:wrong' },
    { platform: 'wechat' },
    { destinationKind: 'wechat' },
    { routeRevision: 99 },
  ];
  for (const [index, mismatch] of mismatches.entries()) {
    const item = {
      ...finalInput(attempt).presentations[0], ...mismatch,
      outboxId: `outbox-route-conflict-${index}`, operationKey: `outbox:route:conflict:${index}`,
    };
    await assert.rejects(core.writer.write((tx) => tx.packageBFinal.commit(finalInput(attempt, {
      operationKey: `final:route:conflict:${index}`, assistantTurnId: `assistant-route-conflict-${index}`,
      assistantRevisionId: `assistant-route-conflict-${index}-r1`, presentations: [item],
    }))), { code: 'CORE_PRESENTATION_BINDING_CONFLICT' });
  }
  assert.equal(core.reader.journalEventCount(), before);

  const first = await core.writer.write((tx) => tx.packageBFinal.commit(finalInput(attempt)));
  assert.deepEqual(first.outboxIds, ['outbox-z', 'outbox-a']);
  assert.deepEqual(first.presentations.map((item) => ({
    outboxId: item.outboxId, order: item.order, kind: item.kind, payloadRef: item.payloadRef,
    payloadHashToken: item.payloadHashToken, destinationKind: item.destinationKind,
    destinationRef: item.destinationRef,
  })), [
    { outboxId: 'outbox-z', order: 1, kind: 'text', payloadRef: 'presentation:z', payloadHashToken: TOKEN,
      destinationKind: 'conversation', destinationRef: 'desktop:conversation' },
    { outboxId: 'outbox-a', order: 2, kind: 'image', payloadRef: 'presentation:a', payloadHashToken: TOKEN,
      destinationKind: 'conversation', destinationRef: 'desktop:conversation' },
  ]);
  const readback = core.reader.packageBPresentation.byAssistantTurn({
    identity: ready.conversation.identity, conversationId: CONVERSATION, exchangeId: 'exchange-1', turnId: 'assistant-turn',
  });
  assert.deepEqual(readback.map((item) => item.presentation_outbox_id), first.outboxIds);
  assert.equal(readback[0].presentation_kind, 'text');
  assert.equal(readback[0].payload_hash_token, TOKEN);
  assert.equal(readback[1].presentation_kind, 'image');
  assert.equal(readback[1].payload_hash_token, TOKEN);
  await core.close();

  const reopened = openCoreDatabase({ dbPath });
  const replay = await reopened.writer.write((tx) => tx.packageBFinal.commit(finalInput(attempt)));
  assert.deepEqual(replay.presentations, first.presentations);
  await reopened.close();
});

test('AC-02 every downstream reader requires the complete immutable Conversation identity scope', async (t) => {
  const { core, dbPath } = await openFixture(t, 'hermes-core-b12-identity-readers-');
  const ready = await seedFinalReady(core);
  const final = await core.writer.write((tx) => tx.packageBFinal.commit(finalInput(ready.attempt)));
  const expectedIdentity = ready.conversation.identity;
  const scope = { identity: expectedIdentity, conversationId: CONVERSATION };

  assert.equal(core.reader.packageBTurn.conversationIdentity({ ...scope, ownerId: OWNER }).actorRef, 'actor:owner');
  assert.equal(core.reader.packageBIngress.byId({ ...scope, ownerId: OWNER, canonicalConversationKey: CONVERSATION, ingressEventId: 'ingress-1' }).ingress_event_id, 'ingress-1');
  assert.equal(core.reader.packageBAssembly.byId({ ...scope, assemblyId: 'assembly-1' }).turn_assembly_id, 'assembly-1');
  assert.equal(core.reader.packageBTurn.exchange({ ...scope, exchangeId: 'exchange-1' }).exchange_id, 'exchange-1');
  assert.equal(core.reader.packageBTurn.turn({ ...scope, exchangeId: 'exchange-1', turnId: 'user-turn' }).semantic_turn_id, 'user-turn');
  assert.equal(core.reader.packageBTurn.turnRevisions({ ...scope, exchangeId: 'exchange-1', turnId: 'user-turn' }).length, 1);
  assert.equal(core.reader.packageBProvider.epoch({ ...scope, exchangeId: 'exchange-1', epochId: 'epoch-1' }).provider_epoch_id, 'epoch-1');
  assert.equal(core.reader.packageBProvider.attempts({ ...scope, exchangeId: 'exchange-1', epochId: 'epoch-1' }).length, 1);
  assert.equal(core.reader.packageBPresentation.binding({ ...scope, bindingId: 'binding-1' }).presentation_binding_id, 'binding-1');
  assert.equal(core.reader.packageBPresentation.outbox({ ...scope, outboxId: 'outbox-z' }).presentation_outbox_id, 'outbox-z');
  assert.equal(core.reader.packageBFinal.byOperation({
    ...scope, exchangeId: 'exchange-1', operationKey: 'final:1', operationDigest: final.operationDigest,
  }).receipt.journal_event_id, final.resultId);

  const wrongScopes = [
    { ownerId: 'owner:wrong' }, { actorRef: 'actor:wrong' }, { platform: 'wechat' },
    { sourceInstanceId: 'desktop:wrong' }, { platformConversationBinding: 'desktop:wrong' },
    { identityRevision: expectedIdentity.identityRevision + 1 },
    { operationDigest: `sha256:v1:${'b'.repeat(64)}` },
  ];
  for (const changed of wrongScopes) {
    const wrong = { ...expectedIdentity, ...changed };
    assert.equal(core.reader.packageBAssembly.byId({ identity: wrong, conversationId: CONVERSATION, assemblyId: 'assembly-1' }), undefined);
    assert.equal(core.reader.packageBTurn.exchange({ identity: wrong, conversationId: CONVERSATION, exchangeId: 'exchange-1' }), undefined);
    assert.equal(core.reader.packageBTurn.turn({ identity: wrong, conversationId: CONVERSATION, exchangeId: 'exchange-1', turnId: 'user-turn' }), undefined);
    assert.deepEqual(core.reader.packageBTurn.turnRevisions({ identity: wrong, conversationId: CONVERSATION, exchangeId: 'exchange-1', turnId: 'user-turn' }), []);
    assert.equal(core.reader.packageBProvider.epoch({ identity: wrong, conversationId: CONVERSATION, exchangeId: 'exchange-1', epochId: 'epoch-1' }), undefined);
    assert.deepEqual(core.reader.packageBProvider.attempts({ identity: wrong, conversationId: CONVERSATION, exchangeId: 'exchange-1', epochId: 'epoch-1' }), []);
    assert.equal(core.reader.packageBPresentation.binding({ identity: wrong, conversationId: CONVERSATION, bindingId: 'binding-1' }), undefined);
    assert.equal(core.reader.packageBPresentation.outbox({ identity: wrong, conversationId: CONVERSATION, outboxId: 'outbox-z' }), undefined);
    assert.equal(core.reader.packageBFinal.byOperation({
      identity: wrong, conversationId: CONVERSATION, exchangeId: 'exchange-1', operationKey: 'final:1', operationDigest: final.operationDigest,
    }), undefined);
  }
  await core.close();

  const reopened = openCoreDatabase({ dbPath });
  assert.equal(reopened.reader.packageBProvider.epoch({
    identity: expectedIdentity, conversationId: CONVERSATION, exchangeId: 'exchange-1', epochId: 'epoch-1',
  }).provider_epoch_id, 'epoch-1');
  await reopened.close();
});

test('AC-06 Provider Epoch transitions, attempts, receipts and rebuild readback are immutable and replayable', async (t) => {
  const { core, dbPath } = await openFixture(t, 'hermes-core-b12-provider-');
  const ready = await seedFinalReady(core);
  const scope = { identity: ready.conversation.identity, conversationId: CONVERSATION, exchangeId: 'exchange-1' };
  const transitionInput = {
    operationKey: 'epoch:transition:taint', providerEpochId: 'epoch-1', conversationId: CONVERSATION,
    exchangeId: 'exchange-1', expectedCurrentState: 'active', expectedRevision: 0,
    nextState: 'tainted', taintState: 'tainted', updatedAt: LATER_2,
  };
  const firstTransition = await core.writer.write((tx) => tx.packageBProvider.transitionEpoch(transitionInput));
  const replayTransition = await core.writer.write((tx) => tx.packageBProvider.transitionEpoch(transitionInput));
  assert.equal(firstTransition.disposition, 'applied');
  assert.equal(replayTransition.disposition, 'already_applied');
  assert.equal(replayTransition.resultId, firstTransition.resultId);
  assert.equal(core.reader.packageBProvider.transitionReceipt({
    ...scope, epochId: 'epoch-1', operationKey: transitionInput.operationKey,
    operationDigest: firstTransition.operationDigest,
  }).journal_event_id, firstTransition.resultId);

  const secondAttempt = await core.writer.write((tx) => tx.packageBProvider.appendAttempt(attemptInput({
    operationKey: 'attempt:2', requestId: 'request:2', attemptNumber: 2,
    resultClass: 'failed', errorClass: 'timeout', startedAt: LATER_2, completedAt: LATER_3,
    metadataRef: 'provider:metadata:2',
  })));
  assert.equal(secondAttempt.attemptNumber, 2);
  assert.equal((await core.writer.write((tx) => tx.packageBProvider.appendAttempt(attemptInput({
    operationKey: 'attempt:2', requestId: 'request:2', attemptNumber: 2,
    resultClass: 'failed', errorClass: 'timeout', startedAt: LATER_2, completedAt: LATER_3,
    metadataRef: 'provider:metadata:2',
  })))).resultId, secondAttempt.resultId);
  await assert.rejects(core.writer.write((tx) => tx.packageBProvider.appendAttempt(attemptInput({
    operationKey: 'attempt:jump', requestId: 'request:jump', attemptNumber: 4,
  }))), { code: 'CORE_PROVIDER_ATTEMPT_INVALID' });
  const pendingAttempt = await core.writer.write((tx) => tx.packageBProvider.appendAttempt(attemptInput({
    operationKey: 'attempt:3', requestId: 'request:3', attemptNumber: 3,
    resultClass: 'started', errorClass: null, startedAt: LATER_3, completedAt: null,
    metadataRef: 'provider:metadata:3',
  })));
  const pendingReceipt = core.reader.packageBProvider.attemptReceipt({
    ...scope, epochId: 'epoch-1', operationKey: 'attempt:3', operationDigest: pendingAttempt.operationDigest,
  });
  assert.equal(pendingReceipt.completed_at, null);
  assert.equal(pendingReceipt.source_snapshot_ref, 'snapshot:1');
  assert.equal(pendingReceipt.source_snapshot_hash_token, TOKEN);

  const taintedEpoch = await core.writer.write((tx) => tx.packageBProvider.createEpoch(epochInput({
    operationKey: 'epoch:tainted:create', providerEpochId: 'epoch-tainted', bindingId: 'epoch-binding-tainted',
    epochState: 'tainted', taintState: 'tainted', requestIdentity: 'request:epoch:tainted',
  })));
  assert.equal(taintedEpoch.providerEpoch.state, 'tainted');
  assert.equal(taintedEpoch.providerEpoch.taint_state, 'tainted');

  const closed = await core.writer.write((tx) => tx.packageBProvider.transitionEpoch({
    operationKey: 'epoch:transition:close', providerEpochId: 'epoch-1', conversationId: CONVERSATION,
    exchangeId: 'exchange-1', expectedCurrentState: 'tainted', expectedRevision: 1,
    nextState: 'closed', taintState: 'tainted', updatedAt: LATER_3,
  }));
  assert.equal(closed.providerEpoch.state, 'closed');
  await assert.rejects(core.writer.write((tx) => tx.packageBProvider.appendAttempt(attemptInput({
    operationKey: 'attempt:closed:4', requestId: 'request:closed:4', attemptNumber: 4,
  }))), { code: 'CORE_PROVIDER_STATE_TRANSITION_INVALID' });
  await assert.rejects(core.writer.write((tx) => tx.packageBProvider.transitionEpoch({
    operationKey: 'epoch:transition:reopen', providerEpochId: 'epoch-1', conversationId: CONVERSATION,
    exchangeId: 'exchange-1', expectedCurrentState: 'closed', expectedRevision: 2,
    nextState: 'active', taintState: 'clean', updatedAt: LATER_3,
  })), { code: 'CORE_PROVIDER_STATE_TRANSITION_INVALID' });

  const rebuild = core.reader.packageBProvider.rebuildMetadata({ ...scope, epochId: 'epoch-1' });
  assert.equal(rebuild.epoch.request_identity, 'request:epoch:1');
  assert.equal(rebuild.epoch.upstream_binding_kind, 'session');
  assert.equal(rebuild.epoch.upstream_handle, undefined);
  assert.deepEqual(rebuild.stateHistory.map((event) => event.resulting_state), ['active', 'tainted', 'closed']);
  assert.deepEqual(rebuild.attempts.map((attempt) => ({
    attemptNumber: attempt.attempt_number, requestIdentity: attempt.request_identity,
    resultClass: attempt.result_class, errorClass: attempt.error_class,
  })), [
    { attemptNumber: 1, requestIdentity: 'request:1', resultClass: 'completed', errorClass: null },
    { attemptNumber: 2, requestIdentity: 'request:2', resultClass: 'failed', errorClass: 'timeout' },
    { attemptNumber: 3, requestIdentity: 'request:3', resultClass: 'started', errorClass: null },
  ]);
  await core.close();

  const reopened = openCoreDatabase({ dbPath });
  const reopenedRebuild = reopened.reader.packageBProvider.rebuildMetadata({ ...scope, epochId: 'epoch-1' });
  assert.deepEqual(reopenedRebuild, rebuild);
  await reopened.close();
});

test('user revisions are role-restricted, sequential, durable, and concurrency-safe', async (t) => {
  const { core } = await openFixture(t, 'hermes-core-b11-user-');
  const ready = await seedUserReady(core);
  assert.equal(await core.writer.write((tx) => typeof tx.packageBTurn.createUserTurn), 'undefined');
  assert.equal(await core.writer.write((tx) => typeof tx.packageBTurn.appendTurnRevision), 'undefined');
  const revision = {
    operationKey: 'user:revision:2', conversationId: CONVERSATION, exchangeId: 'exchange-1', semanticTurnId: 'user-turn',
    turnRevisionId: 'user-r2', assemblyId: 'assembly-1', assemblyRevision: 3, expectedCurrentRevision: 1, expectedCurrentRevisionId: 'user-r1', changeKind: 'corrected', payloadRef: 'payload:user-r2',
    payloadHashToken: TOKEN, sourceEventId: ready.sealed.resultId, committedAt: LATER_2,
  };
  const first = await core.writer.write((tx) => tx.packageBTurn.appendUserRevision(revision));
  assert.equal(first.sourceRevision, 2);
  assert.equal((await core.writer.write((tx) => tx.packageBTurn.appendUserRevision(revision))).disposition, 'already_applied');
  assert.equal(await core.writer.write((tx) => tx.packageBTurn.appendUserRevision({ ...revision, operationKey: 'user:stale', turnRevisionId: 'user-r99', expectedCurrentRevision: 1 })), null);
  const [left, right] = await Promise.all([
    core.writer.write((tx) => tx.packageBTurn.appendUserRevision({ ...revision, operationKey: 'user:race-left', turnRevisionId: 'user-r3', expectedCurrentRevision: 2, expectedCurrentRevisionId: 'user-r2' })),
    core.writer.write((tx) => tx.packageBTurn.appendUserRevision({ ...revision, operationKey: 'user:race-right', turnRevisionId: 'user-r4', expectedCurrentRevision: 2, expectedCurrentRevisionId: 'user-r2' })),
  ]);
  assert.equal([left, right].filter(Boolean).length, 1);
  assert.equal(core.reader.packageBTurn.turnRevisions({ identity: ready.conversation.identity, conversationId: CONVERSATION, exchangeId: 'exchange-1', turnId: 'user-turn' }).length, 3);
  await core.close();
});

test('provider epoch digest binds every persisted identity field and its reader is parent-scoped', async (t) => {
  const { core, dbPath } = await openFixture(t, 'hermes-core-b11-provider-');
  const ready = await seedFinalReady(core);
  const input = {
    operationKey: 'epoch:1', providerEpochId: 'epoch-1', conversationId: CONVERSATION, exchangeId: 'exchange-1', sourceTurnId: 'user-turn',
    sourceRevision: 1, sourceRevisionId: 'user-r1', provider: 'fixture', model: 'fixture-model', capabilitySnapshotRef: 'capability:1',
    capabilitySnapshotHashToken: TOKEN, canonicalSnapshotRef: 'snapshot:1', snapshotHashToken: TOKEN, committedEventCursor: null,
    soulRevisionId: null, bindingId: 'epoch-binding-1', upstreamBindingKind: 'session', upstreamHandle: 'fixture-session',
    upstreamHandleHashToken: TOKEN, epochState: 'active', requestIdentity: 'request:epoch:1', createdAt: LATER,
  };
  for (const changed of [{ provider: 'other' }, { model: 'other-model' }, { capabilitySnapshotRef: 'capability:other' }, { sourceRevision: 2 }]) {
    await assert.rejects(core.writer.write((tx) => tx.packageBProvider.createEpoch({ ...input, ...changed })), { code: 'CORE_OPERATION_KEY_CONFLICT' });
  }
  const epoch = core.reader.packageBProvider.epoch({ identity: ready.conversation.identity, conversationId: CONVERSATION, exchangeId: 'exchange-1', epochId: 'epoch-1' });
  assert.equal(epoch.provider, 'fixture');
  assert.equal(epoch.capability_snapshot_hash_token, TOKEN);
  assert.equal(epoch.upstream_handle, undefined);
  assert.equal(core.reader.packageBProvider.epoch({ identity: ready.conversation.identity, conversationId: 'wrong', exchangeId: 'exchange-1', epochId: 'epoch-1' }), undefined);
  await assert.rejects(core.writer.write((tx) => tx.packageBTurn.appendUserRevision({
    operationKey: 'user:after-epoch', conversationId: CONVERSATION, exchangeId: 'exchange-1', semanticTurnId: 'user-turn',
    turnRevisionId: 'user-r2', assemblyId: 'assembly-1', assemblyRevision: 3, expectedCurrentRevision: 1,
    expectedCurrentRevisionId: 'user-r1', changeKind: 'corrected', payloadRef: 'payload:user-r2', payloadHashToken: TOKEN,
    sourceEventId: ready.sealed.resultId, committedAt: LATER_2,
  })), { code: 'CORE_PROVIDER_SNAPSHOT_BOUND' });
  await core.close();
  const reopened = openCoreDatabase({ dbPath });
  assert.equal(reopened.reader.packageBProvider.attempts({ identity: ready.conversation.identity, conversationId: CONVERSATION, exchangeId: 'exchange-1', epochId: 'epoch-1' }).length, 1);
  await reopened.close();
  void ready;
});

test('final assistant canon and ordered enqueue receipts are atomic and no public assistant mutation exists', async (t) => {
  const { core } = await openFixture(t, 'hermes-core-b11-final-');
  const ready = await seedFinalReady(core);
  const { attempt } = ready;
  assert.equal(await core.writer.write((tx) => typeof tx.packageBTurn.appendTurnRevision), 'undefined');
  const input = finalInput(attempt);
  const [first, replay] = await Promise.all([
    core.writer.write((tx) => tx.packageBFinal.commit(input)), core.writer.write((tx) => tx.packageBFinal.commit(input)),
  ]);
  assert.equal(first.disposition, 'applied');
  assert.deepEqual(first.outboxIds, ['outbox-z', 'outbox-a']);
  assert.equal(replay.disposition, 'already_applied');
  assert.deepEqual(replay.outboxIds, first.outboxIds);
  const receipt = core.reader.packageBFinal.byOperation({ identity: ready.conversation.identity, conversationId: CONVERSATION, exchangeId: 'exchange-1', operationKey: 'final:1', operationDigest: first.operationDigest });
  assert.deepEqual(receipt.enqueued.map((row) => row.correlation_id), first.outboxIds);
  assert.ok(receipt.enqueued.every((row, index) => row.conversation_id === CONVERSATION
    && row.exchange_id === 'exchange-1' && row.actor_ref === 'assistant-turn'
    && Number(row.revision) === index + 1 && row.source_kind.startsWith('package_b_presentation_enqueued:')));
  for (const changed of [{ finalPayloadRef: 'payload:other' }, { assistantActorRef: 'assistant:other' }, { sourceRevision: 2 }]) {
    await assert.rejects(core.writer.write((tx) => tx.packageBFinal.commit({ ...input, ...changed })), { code: 'CORE_OPERATION_KEY_CONFLICT' });
  }
  const beforeRollback = core.reader.journalEventCount();
  const rollbackItem = { ...input.presentations[0], outboxId: 'outbox-rollback', operationKey: 'outbox-rollback' };
  await assert.rejects(core.writer.write((tx) => tx.packageBFinal.commit(finalInput(attempt, {
    operationKey: 'final:outbox-rollback', assistantTurnId: 'assistant-outbox-rollback', assistantRevisionId: 'assistant-outbox-rollback-r1',
    presentations: [rollbackItem, { ...rollbackItem, kind: 'image' }],
  }))));
  assert.equal(core.reader.packageBTurn.turn({ identity: ready.conversation.identity, conversationId: CONVERSATION, exchangeId: 'exchange-1', turnId: 'assistant-outbox-rollback' }), undefined);
  assert.equal(core.reader.journalEventCount(), beforeRollback);
  await assert.rejects(core.writer.write((tx) => {
    tx.packageBFinal.commit(finalInput(attempt, {
      operationKey: 'final:journal-rollback', assistantTurnId: 'assistant-journal-rollback', assistantRevisionId: 'assistant-journal-rollback-r1',
      presentations: [{ ...input.presentations[0], outboxId: 'outbox-journal-rollback', operationKey: 'outbox-journal-rollback' }],
    }));
    throw new Error('inject rollback after final receipt');
  }), { code: 'CORE_WRITE_FAILED' });
  await assert.rejects(core.writer.write((tx) => {
    tx.packageBProvider.createEpoch(epochInput({
      operationKey: 'epoch:fault:create', providerEpochId: 'epoch-fault', bindingId: 'epoch-binding-fault',
      requestIdentity: 'request:epoch:fault',
    }));
    throw new Error('fault after provider epoch receipt');
  }), { code: 'CORE_WRITE_FAILED' });
  assert.equal(core.reader.packageBTurn.turn({ identity: ready.conversation.identity, conversationId: CONVERSATION, exchangeId: 'exchange-1', turnId: 'assistant-journal-rollback' }), undefined);
  assert.equal(core.reader.journalEventCount(), beforeRollback);
  await assert.rejects(core.writer.write((tx) => tx.packageBFinal.commit(finalInput(attempt, {
    operationKey: 'final:rollback', assistantTurnId: 'assistant-rollback', assistantRevisionId: 'user-r1',
    presentations: [{ ...input.presentations[0], outboxId: 'outbox-rollback', operationKey: 'outbox-rollback' }],
  }))));
  assert.equal(core.reader.packageBTurn.turn({ identity: ready.conversation.identity, conversationId: CONVERSATION, exchangeId: 'exchange-1', turnId: 'assistant-rollback' }), undefined);
  await core.close();
});

test('dispatch-start is a one-time may-have-sent boundary with lease, fence, replay, recovery and scope checks', async (t) => {
  const { core, dbPath } = await openFixture(t, 'hermes-core-b11-dispatch-');
  const ready = await seedFinalReady(core);
  const { attempt } = ready;
  const final = await core.writer.write((tx) => tx.packageBFinal.commit(finalInput(attempt)));
  const claimInput = { operationKey: 'claim:z:1', workerId: 'worker-1', outboxId: 'outbox-z', expectedRevision: 0, expectedFence: 0,
    leaseOwner: 'worker-1', leaseUntil: '2026-07-17T00:05:00.000Z', claimedAt: LATER, causationEventId: final.resultId };
  const claim = await core.writer.write((tx) => tx.packageBPresentation.claim(claimInput));
  assert.equal(claim.dispatchAuthorized, true);
  const dispatchInput = { operationKey: 'dispatch:z:1', outboxId: 'outbox-z', claimOperationKey: 'claim:z:1',
    expectedRevision: claim.revision, fenceToken: claim.fenceToken, leaseOwner: 'worker-1', startedAt: LATER };
  const first = await core.writer.write((tx) => tx.packageBPresentation.markDispatchStarted(dispatchInput));
  const journalCount = core.reader.journalEventCount();
  const exact = await core.writer.write((tx) => tx.packageBPresentation.markDispatchStarted(dispatchInput));
  const otherKey = await core.writer.write((tx) => tx.packageBPresentation.markDispatchStarted({ ...dispatchInput, operationKey: 'dispatch:z:2' }));
  assert.equal(first.dispatchAuthorized, true);
  assert.equal(exact.dispatchAuthorized, false);
  assert.equal(otherKey.dispatchAuthorized, false);
  assert.equal(otherKey.resultId, first.resultId);
  assert.equal(core.reader.journalEventCount(), journalCount);
  assert.equal(await core.writer.write((tx) => tx.packageBPresentation.markDispatchStarted({ ...dispatchInput, operationKey: 'dispatch:stale', expectedRevision: 0 })), null);
  assert.equal(await core.writer.write((tx) => tx.packageBPresentation.markDispatchStarted({
    ...dispatchInput, operationKey: 'dispatch:wrong-owner', leaseOwner: 'worker-2',
  })), null);
  assert.equal(await core.writer.write((tx) => tx.packageBPresentation.markDispatchStarted({
    ...dispatchInput, operationKey: 'dispatch:expired', startedAt: '2026-07-17T00:06:00.000Z',
  })), null);
  assert.equal(await core.writer.write((tx) => tx.packageBPresentation.markDispatchStarted({
    ...dispatchInput, operationKey: 'dispatch:wrong-fence', fenceToken: 2,
  })), null);
  await assert.rejects(core.writer.write((tx) => tx.packageBPresentation.markDispatchStarted({ ...dispatchInput, outboxId: 'outbox-a' })), { code: 'CORE_OPERATION_KEY_CONFLICT' });
  const sentClaim = await core.writer.write((tx) => tx.packageBPresentation.claim({
    operationKey: 'claim:a:1', workerId: 'worker-1', outboxId: 'outbox-a', expectedRevision: 0, expectedFence: 0,
    leaseOwner: 'worker-1', leaseUntil: '2026-07-17T00:05:00.000Z', claimedAt: LATER, causationEventId: final.resultId,
  }));
  const sentDispatch = await core.writer.write((tx) => tx.packageBPresentation.markDispatchStarted({
    operationKey: 'dispatch:a:1', outboxId: 'outbox-a', claimOperationKey: 'claim:a:1', expectedRevision: sentClaim.revision,
    fenceToken: sentClaim.fenceToken, leaseOwner: 'worker-1', startedAt: LATER,
  }));
  const sentInput = {
    operationKey: 'presentation:sent:a:1', outboxId: 'outbox-a', claimOperationKey: 'claim:a:1', expectedRevision: sentClaim.revision,
    fenceToken: sentDispatch.fenceToken, leaseOwner: 'worker-1', resultState: 'sent', evidenceRef: 'evidence:a:sent',
    evidenceHashToken: TOKEN, errorClass: null, recordedAt: LATER_2,
  };
  const sent = await core.writer.write((tx) => tx.packageBPresentation.recordResult(sentInput));
  const sentReplay = await core.writer.write((tx) => tx.packageBPresentation.recordResult(sentInput));
  assert.equal(sent.disposition, 'applied');
  assert.equal(sentReplay.disposition, 'already_applied');
  assert.equal(core.reader.packageBPresentation.resultReceipt({
    identity: ready.conversation.identity, conversationId: CONVERSATION, outboxId: 'outbox-a', operationKey: sentInput.operationKey, operationDigest: sent.operationDigest,
    fenceToken: sentInput.fenceToken,
  }).journal_event_id, sent.resultId);
  await core.close();
  const reopened = openCoreDatabase({ dbPath });
  const recovered = await reopened.writer.write((tx) => tx.packageBPresentation.claim({
    operationKey: 'claim:z:recover', workerId: 'worker-2', outboxId: 'outbox-z', expectedRevision: claim.revision,
    expectedFence: claim.fenceToken, leaseOwner: 'worker-2', leaseUntil: '2026-07-17T00:07:00.000Z',
    claimedAt: '2026-07-17T00:06:00.000Z', causationEventId: final.resultId,
  }));
  assert.equal(recovered.disposition, 'dispatch_state_ambiguous');
  assert.equal(recovered.dispatchAuthorized, false);
  assert.equal(reopened.reader.packageBPresentation.outbox({ identity: ready.conversation.identity, conversationId: CONVERSATION, outboxId: 'outbox-z' }).state, 'ambiguous');
  assert.equal(reopened.reader.packageBPresentation.outbox({ identity: ready.conversation.identity, conversationId: 'wrong', outboxId: 'outbox-z' }), undefined);
  await reopened.close();
});

test('Package B.2 local loop commits final, performs one effect, and replays the typed receipt', async (t) => {
  const { core, dbPath } = await openFixture(t, 'hermes-core-b2-local-loop-');
  const ready = await seedFinalReady(core);
  let effects = 0;
  const input = {
    core,
    identity: ready.conversation.identity,
    finalInput: finalInput(ready.attempt, { presentations: [finalInput(ready.attempt).presentations[0]] }),
    outboxId: 'outbox-z',
    workerId: 'worker-b2',
    claimedAt: LATER_2,
    leaseUntil: HARD,
    startedAt: LATER_2,
    recordedAt: LATER_3,
    send: async (item) => {
      effects += 1;
      assert.deepEqual(item, {
        outboxId: 'outbox-z', target: 'desktop:conversation', platform: 'desktop',
        destinationKind: 'conversation', presentationKind: 'text', payloadRef: 'presentation:z',
        payloadHashToken: TOKEN, routeRevision: 0,
      });
      return { resultState: 'sent', evidenceRef: 'evidence:b2:sent', evidenceHashToken: TOKEN, errorClass: null };
    },
  };

  const first = await runPackageBLocalDelivery(input);
  assert.equal(first.final.disposition, 'applied');
  assert.deepEqual(first.delivery, {
    disposition: 'applied', state: 'sent', effectAttempted: true,
    outboxId: 'outbox-z', receiptId: first.delivery.receiptId,
  });
  assert.equal(effects, 1);
  await core.close();

  const reopened = openCoreDatabase({ dbPath });
  const replay = await runPackageBLocalDelivery({ ...input, core: reopened });
  assert.equal(replay.final.disposition, 'already_applied');
  assert.deepEqual(replay.delivery, {
    disposition: 'terminal', state: 'sent', effectAttempted: false, outboxId: 'outbox-z',
  });
  assert.equal(reopened.reader.journalEvent(first.delivery.receiptId).event_type,
    'package_b_presentation_result_recorded');
  assert.equal(effects, 1);
  await reopened.close();
});

test('AC-07 typed receipt readers and transaction fault boundaries are complete and parent-scoped', async (t) => {
  const { core, dbPath } = await openFixture(t, 'hermes-core-b12-receipts-');
  const ready = await seedFinalReady(core);
  const expectedIdentity = ready.conversation.identity;
  const scope = { identity: expectedIdentity, conversationId: CONVERSATION };

  assert.equal(core.reader.packageBTurn.identityReceipt(scope).journal_event_id, expectedIdentity.identityReceiptId);
  assert.equal(core.reader.packageBIngress.byOperation({
    identity: expectedIdentity, operationKey: 'ingress:1', operationDigest: ready.accepted.operationDigest,
  }).journal_event_id, ready.accepted.resultId);
  assert.equal(core.reader.packageBPresentation.bindingReceipt({
    ...scope, bindingId: 'binding-1', operationKey: 'binding:create:1', operationDigest: ready.binding.operationDigest,
  }).journal_event_id, ready.binding.resultId);
  assert.equal(core.reader.packageBAssembly.operationReceipt({
    ...scope, assemblyId: 'assembly-1', kind: 'assembly_created', operationKey: 'assembly:create:1',
    operationDigest: ready.assembly.operationDigest,
  }).journal_event_id, ready.assembly.resultId);
  assert.equal(core.reader.packageBAssembly.operationReceipt({
    ...scope, assemblyId: 'assembly-1', resultId: 'part-1', kind: 'assembly_part_appended',
    operationKey: 'assembly:part:1', operationDigest: ready.part.operationDigest,
  }).journal_event_id, ready.part.resultId);
  assert.equal(core.reader.packageBTurn.userReceipt({
    ...scope, exchangeId: 'exchange-1', operationKey: 'user:commit:1', operationDigest: ready.user.operationDigest,
  }).journal_event_id, ready.user.resultId);
  const foregroundInput = {
    operationKey: 'foreground:exchange:1', conversationId: CONVERSATION, exchangeId: 'exchange-1',
    expectedConversationRevision: 0, updatedAt: LATER,
  };
  const foreground = await core.writer.write((tx) => tx.packageBTurn.compareAndSetForegroundExchange(foregroundInput));
  assert.equal((await core.writer.write((tx) => tx.packageBTurn.compareAndSetForegroundExchange(foregroundInput))).resultId,
    foreground.resultId);
  assert.equal(core.reader.packageBTurn.foregroundExchangeReceipt({
    ...scope, operationKey: foregroundInput.operationKey, operationDigest: foreground.operationDigest,
  }).journal_event_id, foreground.resultId);
  assert.equal(core.reader.packageBProvider.epochReceipt({
    ...scope, exchangeId: 'exchange-1', epochId: 'epoch-1', operationKey: 'epoch:1', operationDigest: ready.epoch.operationDigest,
  }).journal_event_id, ready.epoch.resultId);
  assert.equal(core.reader.packageBProvider.attemptReceipt({
    ...scope, exchangeId: 'exchange-1', epochId: 'epoch-1', operationKey: 'attempt:1', operationDigest: ready.attempt.operationDigest,
  }).journal_event_id, ready.attempt.resultId);

  const final = await core.writer.write((tx) => tx.packageBFinal.commit(finalInput(ready.attempt)));
  assert.equal(core.reader.packageBFinal.byOperation({
    ...scope, exchangeId: 'exchange-1', operationKey: 'final:1', operationDigest: final.operationDigest,
  }).receipt.journal_event_id, final.resultId);
  assert.equal(core.reader.packageBFinal.byOperation({
    ...scope, exchangeId: 'exchange-1', operationKey: 'final:1',
    operationDigest: `sha256:v1:${'f'.repeat(64)}`,
  }), undefined);
  assert.equal(core.reader.packageBPresentation.enqueueReceipt({
    ...scope, exchangeId: 'exchange-1', outboxId: 'outbox-z', finalOperationKey: 'final:1',
    itemOrder: 1, operationDigest: final.operationDigest,
  }).correlation_id, 'outbox-z');
  assert.equal(core.reader.packageBPresentation.enqueueReceipt({
    ...scope, exchangeId: 'exchange-1', outboxId: 'outbox-z', finalOperationKey: 'final:1',
    itemOrder: 2, operationDigest: final.operationDigest,
  }), undefined);

  const claimInput = {
    operationKey: 'claim:receipt:1', workerId: 'worker-1', outboxId: 'outbox-z', expectedRevision: 0,
    expectedFence: 0, leaseOwner: 'worker-1', leaseUntil: '2026-07-17T00:05:00.000Z',
    claimedAt: LATER, causationEventId: final.resultId,
  };
  const claim = await core.writer.write((tx) => tx.packageBPresentation.claim(claimInput));
  assert.equal(core.reader.packageBPresentation.claimReceipt({
    ...scope, outboxId: 'outbox-z', operationKey: claimInput.operationKey, operationDigest: claim.operationDigest,
    fenceToken: claim.fenceToken,
  }).correlation_id, 'outbox-z');
  const dispatchInput = {
    operationKey: 'dispatch:receipt:1', outboxId: 'outbox-z', claimOperationKey: claimInput.operationKey,
    expectedRevision: claim.revision, fenceToken: claim.fenceToken, leaseOwner: 'worker-1', startedAt: LATER,
  };
  const dispatch = await core.writer.write((tx) => tx.packageBPresentation.markDispatchStarted(dispatchInput));
  assert.equal(core.reader.packageBPresentation.dispatchStarted({
    ...scope, outboxId: 'outbox-z', operationKey: dispatchInput.operationKey,
    operationDigest: dispatch.operationDigest, fenceToken: dispatch.fenceToken,
  }).journal_event_id, dispatch.resultId);

  const beforeFault = {
    journal: core.reader.journalEventCount(),
    epoch: core.reader.packageBProvider.epoch({ ...scope, exchangeId: 'exchange-1', epochId: 'epoch-1' }),
    outbox: core.reader.packageBPresentation.outbox({ ...scope, outboxId: 'outbox-a' }),
  };
  await assert.rejects(core.writer.write((tx) => {
    tx.packageBProvider.transitionEpoch({
      operationKey: 'epoch:fault:transition', providerEpochId: 'epoch-1', conversationId: CONVERSATION,
      exchangeId: 'exchange-1', expectedCurrentState: 'active', expectedRevision: 0,
      nextState: 'tainted', taintState: 'tainted', updatedAt: LATER_2,
    });
    throw new Error('fault after provider transition receipt');
  }), { code: 'CORE_WRITE_FAILED' });
  await assert.rejects(core.writer.write((tx) => {
    tx.packageBProvider.appendAttempt(attemptInput({
      operationKey: 'attempt:fault:2', requestId: 'request:fault:2', attemptNumber: 2,
      startedAt: LATER_2, completedAt: LATER_3,
    }));
    throw new Error('fault after provider attempt receipt');
  }), { code: 'CORE_WRITE_FAILED' });
  await assert.rejects(core.writer.write((tx) => {
    tx.packageBPresentation.claim({
      operationKey: 'claim:fault:a', workerId: 'worker-fault', outboxId: 'outbox-a', expectedRevision: 0,
      expectedFence: 0, leaseOwner: 'worker-fault', leaseUntil: '2026-07-17T00:05:00.000Z',
      claimedAt: LATER, causationEventId: final.resultId,
    });
    throw new Error('fault after claim fence receipt');
  }), { code: 'CORE_WRITE_FAILED' });
  assert.equal(core.reader.journalEventCount(), beforeFault.journal);
  assert.deepEqual(core.reader.packageBProvider.epoch({ ...scope, exchangeId: 'exchange-1', epochId: 'epoch-1' }), beforeFault.epoch);
  assert.deepEqual(core.reader.packageBPresentation.outbox({ ...scope, outboxId: 'outbox-a' }), beforeFault.outbox);
  assert.equal(core.reader.packageBProvider.attempts({ ...scope, exchangeId: 'exchange-1', epochId: 'epoch-1' }).length, 1);

  const faultClaimInput = {
    operationKey: 'claim:fault:committed', workerId: 'worker-fault', outboxId: 'outbox-a', expectedRevision: 0,
    expectedFence: 0, leaseOwner: 'worker-fault', leaseUntil: '2026-07-17T00:05:00.000Z',
    claimedAt: LATER, causationEventId: final.resultId,
  };
  const faultClaim = await core.writer.write((tx) => tx.packageBPresentation.claim(faultClaimInput));
  const faultDispatchInput = {
    operationKey: 'dispatch:fault:a', outboxId: 'outbox-a', claimOperationKey: faultClaimInput.operationKey,
    expectedRevision: faultClaim.revision, fenceToken: faultClaim.fenceToken,
    leaseOwner: 'worker-fault', startedAt: LATER,
  };
  const beforeDispatchFault = core.reader.journalEventCount();
  await assert.rejects(core.writer.write((tx) => {
    tx.packageBPresentation.markDispatchStarted(faultDispatchInput);
    throw new Error('fault after dispatch-start receipt');
  }), { code: 'CORE_WRITE_FAILED' });
  assert.equal(core.reader.journalEventCount(), beforeDispatchFault);
  const committedDispatch = await core.writer.write((tx) => tx.packageBPresentation.markDispatchStarted(faultDispatchInput));
  const ambiguousInput = {
    operationKey: 'result:fault:ambiguous', outboxId: 'outbox-a', claimOperationKey: faultClaimInput.operationKey,
    expectedRevision: faultClaim.revision, fenceToken: faultClaim.fenceToken, leaseOwner: 'worker-fault',
    resultState: 'ambiguous', evidenceRef: 'evidence:fault:ambiguous', evidenceHashToken: TOKEN,
    errorClass: 'unknown_delivery', recordedAt: LATER_2,
  };
  const beforeResultFault = core.reader.journalEventCount();
  await assert.rejects(core.writer.write((tx) => {
    tx.packageBPresentation.recordResult(ambiguousInput);
    throw new Error('fault after result receipt');
  }), { code: 'CORE_WRITE_FAILED' });
  assert.equal(core.reader.journalEventCount(), beforeResultFault);
  const ambiguous = await core.writer.write((tx) => tx.packageBPresentation.recordResult(ambiguousInput));
  assert.equal(ambiguous.disposition, 'applied');
  const reconcileInput = {
    operationKey: 'reconcile:fault:a', outboxId: 'outbox-a', claimOperationKey: faultClaimInput.operationKey,
    expectedRevision: faultClaim.revision + 1, fenceToken: committedDispatch.fenceToken,
    resultState: 'sent', evidenceRef: 'evidence:fault:sent', evidenceHashToken: TOKEN,
    errorClass: null, recordedAt: LATER_3,
  };
  const beforeReconcileFault = core.reader.journalEventCount();
  await assert.rejects(core.writer.write((tx) => {
    tx.packageBPresentation.reconcile(reconcileInput);
    throw new Error('fault after reconciliation receipt');
  }), { code: 'CORE_WRITE_FAILED' });
  assert.equal(core.reader.journalEventCount(), beforeReconcileFault);
  await core.close();

  const reopened = openCoreDatabase({ dbPath });
  assert.equal(reopened.reader.packageBPresentation.bindingReceipt({
    ...scope, bindingId: 'binding-1', operationKey: 'binding:create:1', operationDigest: ready.binding.operationDigest,
  }).journal_event_id, ready.binding.resultId);
  assert.equal(reopened.reader.packageBProvider.attemptReceipt({
    ...scope, exchangeId: 'exchange-1', epochId: 'epoch-1', operationKey: 'attempt:1', operationDigest: ready.attempt.operationDigest,
  }).journal_event_id, ready.attempt.resultId);
  await reopened.close();

  const { core: rollbackCore } = await openFixture(t, 'hermes-core-b12-rollback-');
  await assert.rejects(rollbackCore.writer.write((tx) => {
    tx.packageBTurn.createOrResolveConversation(identity());
    throw new Error('fault after identity receipt');
  }), { code: 'CORE_WRITE_FAILED' });
  assert.equal(rollbackCore.reader.journalEventCount(), 0);
  const rollbackConversation = await rollbackCore.writer.write((tx) => tx.packageBTurn.createOrResolveConversation(identity()));
  await assert.rejects(rollbackCore.writer.write((tx) => {
    tx.packageBIngress.commit(ingress());
    throw new Error('fault after ingress receipt');
  }), { code: 'CORE_WRITE_FAILED' });
  assert.equal(rollbackCore.reader.ingressEventCount(), 0);
  assert.equal(rollbackCore.reader.journalEventCount(), 1);
  assert.equal(rollbackCore.reader.packageBTurn.conversationIdentity({
    identity: rollbackConversation.identity, conversationId: CONVERSATION,
  }).conversationId, CONVERSATION);
  const rollbackReady = await seedAssembly(rollbackCore);
  const assemblyJournal = rollbackCore.reader.journalEventCount();
  await assert.rejects(rollbackCore.writer.write((tx) => {
    tx.packageBAssembly.updateQuietDeadline({
      operationKey: 'assembly:fault:quiet', assemblyId: 'assembly-1', expectedRevision: 1,
      quietDeadline: LATER_2, updatedAt: LATER_2,
    });
    throw new Error('fault after assembly revision receipt');
  }), { code: 'CORE_WRITE_FAILED' });
  assert.equal(rollbackCore.reader.journalEventCount(), assemblyJournal);
  assert.equal(rollbackCore.reader.packageBAssembly.byId({
    identity: rollbackReady.conversation.identity, conversationId: CONVERSATION, assemblyId: 'assembly-1',
  }).revision, 1);
  await assert.rejects(rollbackCore.writer.write((tx) => {
    tx.packageBAssembly.beginSealing({
      operationKey: 'assembly:fault:begin', assemblyId: 'assembly-1', expectedRevision: 1, updatedAt: LATER,
    });
    tx.packageBAssembly.seal({
      operationKey: 'assembly:fault:seal', assemblyId: 'assembly-1', conversationId: CONVERSATION,
      expectedRevision: 2, sealedAt: LATER,
    });
    throw new Error('fault after seal digest receipt');
  }), { code: 'CORE_WRITE_FAILED' });
  assert.equal(rollbackCore.reader.packageBAssembly.byId({
    identity: rollbackReady.conversation.identity, conversationId: CONVERSATION, assemblyId: 'assembly-1',
  }).state, 'open');
  const rollbackSeal = await seal(rollbackCore, rollbackReady.conversation.identity);
  const userJournal = rollbackCore.reader.journalEventCount();
  await assert.rejects(rollbackCore.writer.write((tx) => {
    tx.packageBTurn.commitUserTurn({
      operationKey: 'user:fault:commit', conversationId: CONVERSATION, exchangeId: 'exchange-fault', assemblyId: 'assembly-1',
      assemblyRevision: rollbackSeal.revision, ingressEventId: 'ingress-1', semanticTurnId: 'user-turn-fault',
      turnRevisionId: 'user-turn-fault-r1', actorRef: 'actor:owner', payloadRef: 'payload:user-fault',
      payloadHashToken: TOKEN, sourceEventId: rollbackSeal.resultId, committedAt: LATER,
    });
    throw new Error('fault after user turn receipt');
  }), { code: 'CORE_WRITE_FAILED' });
  assert.equal(rollbackCore.reader.journalEventCount(), userJournal);
  assert.equal(rollbackCore.reader.packageBTurn.exchange({
    identity: rollbackReady.conversation.identity, conversationId: CONVERSATION, exchangeId: 'exchange-fault',
  }), undefined);
  await rollbackCore.close();
});

test('all B.1 reader and write namespaces remain typed and transaction-bound', async (t) => {
  const { core } = await openFixture(t, 'hermes-core-b11-exports-');
  const names = await core.writer.write((tx) => Object.keys(tx).filter((name) => name.startsWith('packageB')).sort());
  assert.deepEqual(names, ['packageBAssembly', 'packageBFinal', 'packageBIngress', 'packageBPresentation', 'packageBProvider', 'packageBTurn']);
  const writerMethods = await core.writer.write((tx) => Object.fromEntries(names.map((name) => [name, Object.keys(tx[name]).sort()])));
  assert.deepEqual(writerMethods, {
    packageBAssembly: ['appendPart', 'appendPartWithProcessing', 'beginSealing', 'create', 'interrupt', 'reject', 'seal', 'supersedePart', 'transitionReference', 'updateQuietDeadline', 'withdrawPart'],
    packageBFinal: ['commit'],
    packageBIngress: ['commit', 'commitWithAssemblyIntent', 'transitionAssemblyProcessing'],
    packageBPresentation: ['claim', 'createOrReadBinding', 'markDispatchStarted', 'reconcile', 'recordResult'],
    packageBProvider: ['appendAttempt', 'createEpoch', 'transitionEpoch'],
    packageBTurn: ['appendUserRevision', 'commitUserTurn', 'compareAndSetForegroundExchange', 'createOrResolveConversation'],
  });
  assert.deepEqual(Object.fromEntries(names.map((name) => [name, Object.keys(core.reader[name]).sort()])), {
    packageBAssembly: ['activePartSetDigest', 'byId', 'deferredAssociations', 'dueBefore', 'dueWork', 'openRecent', 'operationReceipt', 'partByIngress', 'parts', 'referenceTarget', 'sealReceipt'],
    packageBFinal: ['byOperation'],
    packageBIngress: ['assemblyIntentByIngress', 'assemblyIntentByOperation', 'assemblyProcessingByIngress', 'byId', 'byOperation', 'byTrustedNativeScope', 'pendingAssemblyWork'],
    packageBPresentation: ['binding', 'bindingReceipt', 'byAssistantTurn', 'claimReceipt', 'dispatchStarted', 'enqueueReceipt', 'outbox', 'resultReceipt'],
    packageBProvider: ['attemptReceipt', 'attempts', 'epoch', 'epochReceipt', 'rebuildMetadata', 'transitionReceipt'],
    packageBTurn: ['conversationByCanonicalKey', 'conversationIdentity', 'exchange', 'foregroundExchangeReceipt', 'identityReceipt', 'presentationBinding', 'turn', 'turnRevisions', 'userReceipt', 'userRevisionReceipt'],
  });
  assert.equal(await core.writer.write((tx) => typeof tx.packageBTurn.createAssistantTurn), 'undefined');
  for (const reader of [core.reader.packageBIngress, core.reader.packageBAssembly, core.reader.packageBTurn, core.reader.packageBProvider, core.reader.packageBPresentation, core.reader.packageBFinal]) {
    assert.equal(Object.isFrozen(reader), true);
    for (const forbidden of ['prepare', 'run', 'exec', 'write', 'transaction', 'sql']) assert.equal(reader[forbidden], undefined);
  }
  await core.close();
});
