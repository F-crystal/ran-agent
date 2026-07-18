import assert from 'node:assert/strict';
import test from 'node:test';

import { openCoreDatabase } from '../../src/core/coreDb.mjs';
import { createTempCore, openTestInspector, rowCount } from './helpers/testCoreInspector.mjs';

const AT = '2026-07-18T00:00:00.000Z';
const LATER = '2026-07-18T00:01:00.000Z';
const HARD = '2026-07-18T00:10:00.000Z';
const TOKEN = `hmac-sha256:v1:test-key:${'a'.repeat(64)}`;
const CONVERSATION = 'conversation:recovery';

function conversationInput(overrides = {}) {
  return {
    conversationId: CONVERSATION,
    canonicalConversationKey: CONVERSATION,
    ownerId: 'owner',
    actorRef: 'actor:owner',
    platform: 'desktop',
    primaryFrontend: 'desktop',
    sourceInstanceId: 'desktop:local',
    platformConversationBinding: 'desktop:conversation',
    createdAt: AT,
    ...overrides,
  };
}

function ingressInput(overrides = {}) {
  return {
    ingressEventId: 'ingress-1',
    operationKey: 'ingress:1',
    platform: 'desktop',
    sourceInstanceId: 'desktop:local',
    nativeEventIdTrust: 'trusted',
    nativeEventId: 'native-1',
    ownerId: 'owner',
    actorRef: 'actor:owner',
    platformConversationBinding: 'desktop:conversation',
    canonicalConversationKey: CONVERSATION,
    payloadRef: 'payload:ingress-1',
    payloadHashToken: TOKEN,
    mutationKind: 'create',
    mutationTargetNativeEventId: null,
    retryOf: null,
    vendorEventTime: AT,
    receivedAt: AT,
    createdAt: AT,
    ...overrides,
  };
}

function intentInput(overrides = {}) {
  return {
    operationKey: 'intent:1',
    processingOperationKey: 'processing:1',
    partKind: 'text',
    sequenceNo: 1,
    payloadSize: 24,
    referenceKind: 'none',
    explicitReference: null,
    deferredReference: null,
    targetIngressId: null,
    targetNativeEventId: null,
    anchorKind: null,
    anchorLang: null,
    partMetadata: {},
    mutationTargetIngressId: null,
    retryCausation: null,
    causationId: 'cause:ingress-1',
    correlationId: 'correlation:conversation-recovery',
    createdAt: AT,
    ...overrides,
  };
}

async function openFixture(t, prefix = 'hermes-core-b13-') {
  const { dbPath } = createTempCore(t, prefix);
  const core = openCoreDatabase({ dbPath });
  core.migrate();
  return { core, dbPath };
}

async function commitIntent(core, overrides = {}) {
  return core.writer.write((tx) => {
    const conversation = tx.packageBTurn.createOrResolveConversation(conversationInput(overrides.conversation));
    const committed = tx.packageBIngress.commitWithAssemblyIntent({
      identity: conversation.identity,
      ingress: ingressInput(overrides.ingress),
      intent: intentInput(overrides.intent),
    });
    return { conversation, committed };
  });
}

test('conversation, ingress, immutable intent, and pending receipt commit atomically and reopen completely', async (t) => {
  const { core, dbPath } = await openFixture(t, 'hermes-core-b13-intent-');
  const first = await commitIntent(core);
  const replay = await commitIntent(core, { ingress: { receivedAt: LATER } });
  assert.equal(first.committed.ingress.disposition, 'applied');
  assert.equal(replay.committed.intent.resultId, first.committed.intent.resultId);
  assert.deepEqual(replay.committed.intent, first.committed.intent);
  assert.equal(first.committed.processing.state, 'pending');

  const expectedIntent = {
    ingressEventId: 'ingress-1',
    ingressResultId: first.committed.ingress.resultId,
    conversationId: CONVERSATION,
    canonicalConversationKey: CONVERSATION,
    ownerId: 'owner', actorRef: 'actor:owner', platform: 'desktop', sourceInstanceId: 'desktop:local',
    platformConversationBinding: 'desktop:conversation', nativeEventId: 'native-1', nativeEventIdTrust: 'trusted',
    partKind: 'text', sequenceNo: 1, payloadRef: 'payload:ingress-1', payloadHashToken: TOKEN, payloadSize: 24,
    referenceKind: 'none', explicitReference: null, deferredReference: null, targetIngressId: null,
    targetNativeEventId: null, anchorKind: null, anchorLang: null, partMetadata: {}, mutationKind: 'create',
    mutationTargetIngressId: null, mutationTargetNativeEventId: null, retryCausation: null,
    receivedAt: AT, vendorEventTime: AT, operationKey: 'intent:1', causationId: 'cause:ingress-1',
    correlationId: 'correlation:conversation-recovery', createdAt: AT,
  };
  const read = core.reader.packageBIngress.assemblyIntentByIngress({
    identity: first.conversation.identity, ingressEventId: 'ingress-1',
  });
  for (const [key, value] of Object.entries(expectedIntent)) assert.deepEqual(read[key], value, key);
  assert.equal(typeof read.journalSequence, 'number');
  assert.match(read.operationDigest, /^sha256:v1:[a-f0-9]{64}$/);
  assert.equal(core.reader.packageBIngress.pendingAssemblyWork({ identity: first.conversation.identity }).length, 1);
  assert.equal(core.reader.packageBIngress.assemblyIntentByIngress({
    identity: { ...first.conversation.identity, sourceInstanceId: 'desktop:other' }, ingressEventId: 'ingress-1',
  }), undefined);

  await assert.rejects(core.writer.write((tx) => {
    const conversation = tx.packageBTurn.createOrResolveConversation(conversationInput({
      conversationId: 'conversation:rollback', canonicalConversationKey: 'conversation:rollback',
      platformConversationBinding: 'desktop:rollback',
    }));
    tx.packageBIngress.commitWithAssemblyIntent({
      identity: conversation.identity,
      ingress: ingressInput({
        ingressEventId: 'ingress-rollback', operationKey: 'ingress:rollback',
        canonicalConversationKey: 'conversation:rollback', platformConversationBinding: 'desktop:rollback',
        nativeEventId: 'native-rollback',
      }),
      intent: intentInput({ operationKey: 'intent:rollback', processingOperationKey: 'processing:rollback' }),
    });
    throw new Error('fault after intent receipt');
  }), /fault after intent receipt/);
  assert.equal(core.reader.packageBTurn.conversationIdentity({
    identity: { ...first.conversation.identity, conversationId: 'conversation:rollback' },
    conversationId: 'conversation:rollback',
  }), undefined);

  await core.close();
  const reopened = openCoreDatabase({ dbPath });
  const reopenedIntent = reopened.reader.packageBIngress.assemblyIntentByOperation({
    identity: first.conversation.identity,
    operationKey: 'intent:1',
    operationDigest: read.operationDigest,
  });
  assert.deepEqual(reopenedIntent, read);
  assert.equal(reopened.reader.packageBIngress.pendingAssemblyWork({ identity: first.conversation.identity }).length, 1);
  await reopened.close();
});

test('appendPart persists reference revisions atomically and seal uses the active durable reference', async (t) => {
  const { core, dbPath } = await openFixture(t, 'hermes-core-b13-reference-');
  const base = await commitIntent(core, {
    intent: {
      referenceKind: 'deferred', deferredReference: 'native:target', targetNativeEventId: 'native-target',
    },
  });
  await core.writer.write((tx) => tx.packageBAssembly.create({
    operationKey: 'assembly:create:1', assemblyId: 'assembly-1', conversationId: CONVERSATION,
    quietDeadline: LATER, hardDeadline: HARD, createdAt: AT,
  }));
  const appended = await core.writer.write((tx) => tx.packageBAssembly.appendPart({
    identity: base.conversation.identity,
    operationKey: 'part:1', partId: 'part-1', assemblyId: 'assembly-1', ingressEventId: 'ingress-1',
    partKind: 'text', sequenceNo: 1, payloadRef: 'payload:ingress-1', sourceRevision: 0,
    expectedAssemblyRevision: 0, createdAt: AT,
    reference: {
      operationKey: 'reference:1', kind: 'deferred', state: 'unresolved', targetIngressId: null,
      targetNativeEventId: 'native-target', targetPartId: null, anchorKind: 'quote', anchorLang: 'zh',
      causationId: 'ingress-1', correlationId: 'reference:thread-1', createdAt: AT,
    },
  }));
  assert.equal(appended.reference.state, 'unresolved');
  const unresolvedDigest = core.reader.packageBAssembly.activePartSetDigest({
    identity: base.conversation.identity, conversationId: CONVERSATION, assemblyId: 'assembly-1', expectedRevision: 1,
  });
  const history = core.reader.packageBAssembly.deferredAssociations({
    identity: base.conversation.identity, conversationId: CONVERSATION, assemblyId: 'assembly-1',
  });
  assert.equal(history.length, 1);
  assert.equal(history[0].current.state, 'unresolved');

  const resolved = await core.writer.write((tx) => tx.packageBAssembly.transitionReference({
    identity: base.conversation.identity,
    operationKey: 'reference:resolve:1', assemblyId: 'assembly-1', partId: 'part-1',
    expectedAssemblyRevision: 1,
    expectedState: 'unresolved', nextState: 'resolved', targetIngressId: 'ingress-1',
    targetNativeEventId: 'native-1', targetPartId: 'part-1', anchorKind: 'quote', anchorLang: 'zh',
    causationId: appended.reference.resultId, correlationId: 'reference:thread-1', createdAt: LATER,
  }));
  assert.equal(resolved.state, 'resolved');
  const resolvedDigest = core.reader.packageBAssembly.activePartSetDigest({
    identity: base.conversation.identity, conversationId: CONVERSATION, assemblyId: 'assembly-1', expectedRevision: 2,
  });
  assert.notEqual(resolvedDigest, unresolvedDigest);
  const association = core.reader.packageBAssembly.deferredAssociations({
    identity: base.conversation.identity, conversationId: CONVERSATION, assemblyId: 'assembly-1',
  })[0];
  assert.equal(association.history.length, 2);
  assert.equal(association.history[0].state, 'unresolved');
  assert.equal(association.current.state, 'resolved');

  await core.writer.write((tx) => tx.packageBAssembly.beginSealing({
    operationKey: 'assembly:begin:1', assemblyId: 'assembly-1', expectedRevision: 2, updatedAt: LATER,
  }));
  const finalDigest = core.reader.packageBAssembly.activePartSetDigest({
    identity: base.conversation.identity, conversationId: CONVERSATION, assemblyId: 'assembly-1', expectedRevision: 3,
  });
  const sealed = await core.writer.write((tx) => tx.packageBAssembly.seal({
    operationKey: 'assembly:seal:1', assemblyId: 'assembly-1', conversationId: CONVERSATION,
    expectedRevision: 3, sealedAt: LATER,
  }));
  assert.equal(sealed.disposition, 'applied');

  await core.close();
  const reopened = openCoreDatabase({ dbPath });
  assert.equal(reopened.reader.packageBAssembly.deferredAssociations({
    identity: base.conversation.identity, conversationId: CONVERSATION, assemblyId: 'assembly-1',
  })[0].current.state, 'resolved');
  assert.equal(reopened.reader.packageBAssembly.activePartSetDigest({
    identity: base.conversation.identity, conversationId: CONVERSATION, assemblyId: 'assembly-1', expectedRevision: 3,
  }), finalDigest);
  await reopened.close();
});

test('processing transitions fold deterministically and recovery readers expose facts without policy', async (t) => {
  const { core } = await openFixture(t, 'hermes-core-b13-recovery-');
  const base = await commitIntent(core);
  await core.writer.write((tx) => tx.packageBAssembly.create({
    operationKey: 'assembly:create:1', assemblyId: 'assembly-1', conversationId: CONVERSATION,
    quietDeadline: LATER, hardDeadline: HARD, createdAt: AT,
  }));
  const part = await core.writer.write((tx) => tx.packageBAssembly.appendPart({
    identity: base.conversation.identity,
    operationKey: 'part:1', partId: 'part-1', assemblyId: 'assembly-1', ingressEventId: 'ingress-1',
    partKind: 'text', sequenceNo: 1, payloadRef: 'payload:ingress-1', sourceRevision: 0,
    expectedAssemblyRevision: 0, createdAt: AT,
  }));
  const transition = await core.writer.write((tx) => tx.packageBIngress.transitionAssemblyProcessing({
    identity: base.conversation.identity,
    operationKey: 'processing:assembled:1', ingressEventId: 'ingress-1',
    intentId: base.committed.intent.resultId, expectedState: 'pending', nextState: 'assembled',
    assemblyId: 'assembly-1', partId: 'part-1', causationId: part.resultId, createdAt: LATER,
  }));
  assert.equal(transition.state, 'assembled');
  assert.equal(core.reader.packageBIngress.pendingAssemblyWork({ identity: base.conversation.identity }).length, 0);
  assert.equal(core.reader.packageBAssembly.partByIngress({
    identity: base.conversation.identity, conversationId: CONVERSATION, ingressEventId: 'ingress-1',
  }).turn_assembly_part_id, 'part-1');
  assert.equal(core.reader.packageBAssembly.openRecent({
    identity: base.conversation.identity, conversationId: CONVERSATION, since: AT, at: HARD,
  })[0].turn_assembly_id, 'assembly-1');
  assert.equal(core.reader.packageBAssembly.referenceTarget({
    identity: base.conversation.identity, conversationId: CONVERSATION, targetIngressId: 'ingress-1',
  }).ingress.ingress_event_id, 'ingress-1');
  const due = core.reader.packageBAssembly.dueWork({ at: LATER });
  assert.equal(due[0].identity.sourceInstanceId, 'desktop:local');
  assert.equal(due[0].assembly.turn_assembly_id, 'assembly-1');
  await assert.rejects(core.writer.write((tx) => tx.packageBIngress.transitionAssemblyProcessing({
    identity: base.conversation.identity,
    operationKey: 'processing:illegal:1', ingressEventId: 'ingress-1',
    intentId: base.committed.intent.resultId, expectedState: 'assembled', nextState: 'deferred',
    assemblyId: 'assembly-1', partId: 'part-1', causationId: transition.resultId, createdAt: LATER,
  })), { code: 'CORE_INGRESS_PROCESSING_TRANSITION_INVALID' });
});

test('RC-01 exposes part-written pending work and atomically completes it without duplicate parts', async (t) => {
  const { core, dbPath } = await openFixture(t, 'hermes-core-b131-half-state-');
  const base = await commitIntent(core);
  await core.writer.write((tx) => tx.packageBAssembly.create({
    operationKey: 'assembly:create:half', assemblyId: 'assembly-half', conversationId: CONVERSATION,
    quietDeadline: LATER, hardDeadline: HARD, createdAt: AT,
  }));
  const input = {
    identity: base.conversation.identity,
    operationKey: 'part:half', partId: 'part-half', assemblyId: 'assembly-half', ingressEventId: 'ingress-1',
    partKind: 'text', sequenceNo: 1, payloadRef: 'payload:ingress-1', sourceRevision: 0,
    expectedAssemblyRevision: 0, createdAt: AT,
    processing: {
      operationKey: 'processing:half:assembled', intentId: base.committed.intent.resultId,
      expectedState: 'pending', nextState: 'assembled', createdAt: LATER,
    },
  };

  await core.writer.write((tx) => tx.packageBAssembly.appendPart(input));
  const halfState = core.reader.packageBIngress.pendingAssemblyWork({ identity: base.conversation.identity });
  assert.equal(halfState.length, 1);
  assert.equal(halfState[0].workDisposition, 'part_written_processing_pending');
  assert.equal(halfState[0].part.turn_assembly_part_id, 'part-half');

  const before = core.reader.journalEventCount();
  const completed = await core.writer.write((tx) => tx.packageBAssembly.appendPartWithProcessing(input));
  const after = core.reader.journalEventCount();
  const replay = await core.writer.write((tx) => tx.packageBAssembly.appendPartWithProcessing(input));
  assert.deepEqual(replay, completed);
  assert.equal(completed.processing.state, 'assembled');
  assert.equal(core.reader.journalEventCount(), after);
  assert.equal(after, before + 1);
  assert.equal(core.reader.packageBAssembly.parts({
    identity: base.conversation.identity, conversationId: CONVERSATION, assemblyId: 'assembly-half',
  }).length, 1);
  assert.equal(core.reader.packageBIngress.pendingAssemblyWork({ identity: base.conversation.identity }).length, 0);

  await core.close();
  const reopened = openCoreDatabase({ dbPath });
  assert.equal(reopened.reader.packageBIngress.assemblyProcessingByIngress({
    identity: base.conversation.identity, ingressEventId: 'ingress-1',
  }).state, 'assembled');
  assert.equal(reopened.reader.packageBAssembly.partByIngress({
    identity: base.conversation.identity, conversationId: CONVERSATION, ingressEventId: 'ingress-1',
  }).turn_assembly_part_id, 'part-half');
  await reopened.close();
});

test('RC-02 composite ingress replay returns its immutable first result after later processing', async (t) => {
  const { core, dbPath } = await openFixture(t, 'hermes-core-b131-first-result-');
  const first = await commitIntent(core);
  await core.writer.write((tx) => tx.packageBIngress.transitionAssemblyProcessing({
    identity: first.conversation.identity, operationKey: 'processing:first-result:deferred',
    ingressEventId: 'ingress-1', intentId: first.committed.intent.resultId,
    expectedState: 'pending', nextState: 'deferred', assemblyId: null, partId: null,
    causationId: first.committed.processing.resultId, createdAt: LATER,
  }));
  const beforeReplay = core.reader.journalEventCount();
  const replay = await commitIntent(core);
  assert.deepEqual(replay.committed, first.committed);
  assert.equal(replay.committed.processing.state, 'pending');
  assert.equal(core.reader.packageBIngress.assemblyProcessingByIngress({
    identity: first.conversation.identity, ingressEventId: 'ingress-1',
  }).state, 'deferred');
  assert.equal(core.reader.journalEventCount(), beforeReplay);

  await assert.rejects(commitIntent(core, {
    intent: { processingOperationKey: 'processing:different-first-result' },
  }), { code: 'CORE_OPERATION_KEY_CONFLICT' });
  assert.equal(core.reader.journalEventCount(), beforeReplay);

  await core.close();
  const reopened = openCoreDatabase({ dbPath });
  const reopenedReplay = await reopened.writer.write((tx) => {
    const conversation = tx.packageBTurn.createOrResolveConversation(conversationInput());
    return tx.packageBIngress.commitWithAssemblyIntent({
      identity: conversation.identity, ingress: ingressInput(), intent: intentInput(),
    });
  });
  assert.deepEqual(reopenedReplay, first.committed);
  await reopened.close();
});

test('RC-01 composite part processing rolls back after its receipt and serializes identical workers', async (t) => {
  const { core } = await openFixture(t, 'hermes-core-b131-composite-fault-');
  const base = await commitIntent(core);
  await core.writer.write((tx) => tx.packageBAssembly.create({
    operationKey: 'assembly:create:atomic', assemblyId: 'assembly-atomic', conversationId: CONVERSATION,
    quietDeadline: LATER, hardDeadline: HARD, createdAt: AT,
  }));
  const input = {
    identity: base.conversation.identity, operationKey: 'part:atomic:new', partId: 'part-atomic-new',
    assemblyId: 'assembly-atomic', ingressEventId: 'ingress-1', partKind: 'text', sequenceNo: 1,
    payloadRef: 'payload:ingress-1', sourceRevision: 0, expectedAssemblyRevision: 0, createdAt: AT,
    processing: {
      operationKey: 'processing:atomic:new', intentId: base.committed.intent.resultId,
      expectedState: 'pending', nextState: 'assembled', createdAt: LATER,
    },
  };
  const [left, right] = await Promise.all([
    core.writer.write((tx) => tx.packageBAssembly.appendPartWithProcessing(input)),
    core.writer.write((tx) => tx.packageBAssembly.appendPartWithProcessing(input)),
  ]);
  assert.deepEqual(right, left);
  assert.equal(core.reader.packageBAssembly.parts({
    identity: base.conversation.identity, conversationId: CONVERSATION, assemblyId: 'assembly-atomic',
  }).length, 1);

  const second = await commitIntent(core, {
    ingress: { ingressEventId: 'ingress-fault', operationKey: 'ingress:fault', nativeEventId: 'native-fault', payloadRef: 'payload:ingress-fault' },
    intent: { operationKey: 'intent:fault', processingOperationKey: 'processing:fault' },
  });
  await core.writer.write((tx) => tx.packageBAssembly.create({
    operationKey: 'assembly:create:fault', assemblyId: 'assembly-fault', conversationId: CONVERSATION,
    quietDeadline: LATER, hardDeadline: HARD, createdAt: AT,
  }));
  const beforeFault = core.reader.journalEventCount();
  await assert.rejects(core.writer.write((tx) => {
    tx.packageBAssembly.appendPartWithProcessing({
      identity: second.conversation.identity, operationKey: 'part:fault:new', partId: 'part-fault-new',
      assemblyId: 'assembly-fault', ingressEventId: 'ingress-fault', partKind: 'text', sequenceNo: 1,
      payloadRef: 'payload:ingress-fault', sourceRevision: 0, expectedAssemblyRevision: 0, createdAt: AT,
      processing: {
        operationKey: 'processing:fault:assembled', intentId: second.committed.intent.resultId,
        expectedState: 'pending', nextState: 'assembled', createdAt: LATER,
      },
    });
    throw new Error('fault after composite processing receipt');
  }), /fault after composite processing receipt/);
  assert.equal(core.reader.journalEventCount(), beforeFault);
  assert.equal(core.reader.packageBAssembly.partByIngress({
    identity: second.conversation.identity, conversationId: CONVERSATION, ingressEventId: 'ingress-fault',
  }), undefined);
  const pending = core.reader.packageBIngress.pendingAssemblyWork({ identity: second.conversation.identity })
    .find((item) => item.intent.ingressEventId === 'ingress-fault');
  assert.equal(pending.workDisposition, 'pending_without_part');
  const deferred = await core.writer.write((tx) => tx.packageBAssembly.appendPartWithProcessing({
    identity: second.conversation.identity, operationKey: 'part:fault:deferred', partId: 'part-fault-deferred',
    assemblyId: 'assembly-fault', ingressEventId: 'ingress-fault', partKind: 'text', sequenceNo: 1,
    payloadRef: 'payload:ingress-fault', sourceRevision: 0, expectedAssemblyRevision: 0, createdAt: AT,
    processing: {
      operationKey: 'processing:fault:deferred', intentId: second.committed.intent.resultId,
      expectedState: 'pending', nextState: 'deferred', createdAt: LATER,
    },
  }));
  assert.equal(deferred.processing.state, 'deferred');
  assert.equal(core.reader.packageBIngress.pendingAssemblyWork({ identity: second.conversation.identity })
    .find((item) => item.intent.ingressEventId === 'ingress-fault').workDisposition, 'deferred');
  await core.close();
});

test('RC-03 reference replay inherits its first target and rejects contradictory target tuples', async (t) => {
  const { core, dbPath } = await openFixture(t, 'hermes-core-b131-reference-target-');
  const base = await commitIntent(core, {
    intent: { referenceKind: 'deferred', deferredReference: 'native:1', targetNativeEventId: 'native-1' },
  });
  await commitIntent(core, {
    ingress: { ingressEventId: 'ingress-2', operationKey: 'ingress:2', nativeEventId: 'native-2', payloadRef: 'payload:ingress-2' },
    intent: { operationKey: 'intent:2', processingOperationKey: 'processing:2' },
  });
  await core.writer.write((tx) => tx.packageBAssembly.create({
    operationKey: 'assembly:create:target', assemblyId: 'assembly-target', conversationId: CONVERSATION,
    quietDeadline: LATER, hardDeadline: HARD, createdAt: AT,
  }));
  await core.writer.write((tx) => tx.packageBAssembly.appendPart({
    identity: base.conversation.identity, operationKey: 'part:target:1', partId: 'part-target-1',
    assemblyId: 'assembly-target', ingressEventId: 'ingress-1', partKind: 'text', sequenceNo: 1,
    payloadRef: 'payload:ingress-1', sourceRevision: 0, expectedAssemblyRevision: 0, createdAt: AT,
    reference: {
      operationKey: 'reference:target:initial', kind: 'deferred', state: 'unresolved',
      targetIngressId: null, targetNativeEventId: 'native-1', targetPartId: null,
      anchorKind: 'quote', anchorLang: 'zh', causationId: 'ingress-1', correlationId: 'reference:target', createdAt: AT,
    },
  }));
  await core.writer.write((tx) => tx.packageBAssembly.appendPart({
    identity: base.conversation.identity, operationKey: 'part:target:2', partId: 'part-target-2',
    assemblyId: 'assembly-target', ingressEventId: 'ingress-2', partKind: 'text', sequenceNo: 2,
    payloadRef: 'payload:ingress-2', sourceRevision: 0, expectedAssemblyRevision: 1, createdAt: AT,
  }));

  const beforeConflict = core.reader.journalEventCount();
  await assert.rejects(core.writer.write((tx) => tx.packageBAssembly.transitionReference({
    identity: base.conversation.identity, operationKey: 'reference:target:contradiction',
    assemblyId: 'assembly-target', partId: 'part-target-1', expectedAssemblyRevision: 2,
    expectedState: 'unresolved', nextState: 'resolved', targetIngressId: 'ingress-1',
    targetNativeEventId: 'native-2', targetPartId: 'part-target-1', causationId: 'reference:target:initial',
    createdAt: LATER,
  })), { code: 'CORE_ASSEMBLY_REFERENCE_TARGET_CONFLICT' });
  assert.equal(core.reader.journalEventCount(), beforeConflict);

  const resolutionInput = {
    identity: base.conversation.identity, operationKey: 'reference:target:resolved',
    assemblyId: 'assembly-target', partId: 'part-target-1', expectedAssemblyRevision: 2,
    expectedState: 'unresolved', nextState: 'resolved', targetPartId: 'part-target-1',
    causationId: 'reference:target:initial', createdAt: LATER,
  };
  const resolved = await core.writer.write((tx) => tx.packageBAssembly.transitionReference(resolutionInput));
  const replay = await core.writer.write((tx) => tx.packageBAssembly.transitionReference(resolutionInput));
  assert.deepEqual(replay, resolved);
  assert.equal(resolved.targetIngressId, 'ingress-1');
  assert.equal(resolved.targetNativeEventId, 'native-1');
  const beforeRetarget = core.reader.journalEventCount();
  await assert.rejects(core.writer.write((tx) => tx.packageBAssembly.transitionReference({
    ...resolutionInput, targetPartId: 'part-target-2',
  })), { code: 'CORE_OPERATION_KEY_CONFLICT' });
  assert.equal(core.reader.journalEventCount(), beforeRetarget);

  await core.close();
  const reopened = openCoreDatabase({ dbPath });
  assert.deepEqual(await reopened.writer.write((tx) => tx.packageBAssembly.transitionReference(resolutionInput)), resolved);
  await reopened.close();
});

test('RC-04 seal freezes reference state while preserving old exact replay', async (t) => {
  const { core, dbPath } = await openFixture(t, 'hermes-core-b131-seal-freeze-');
  const base = await commitIntent(core, {
    intent: { referenceKind: 'deferred', deferredReference: 'native:1', targetNativeEventId: 'native-1' },
  });
  await core.writer.write((tx) => tx.packageBAssembly.create({
    operationKey: 'assembly:create:freeze', assemblyId: 'assembly-freeze', conversationId: CONVERSATION,
    quietDeadline: LATER, hardDeadline: HARD, createdAt: AT,
  }));
  await core.writer.write((tx) => tx.packageBAssembly.appendPart({
    identity: base.conversation.identity, operationKey: 'part:freeze', partId: 'part-freeze',
    assemblyId: 'assembly-freeze', ingressEventId: 'ingress-1', partKind: 'text', sequenceNo: 1,
    payloadRef: 'payload:ingress-1', sourceRevision: 0, expectedAssemblyRevision: 0, createdAt: AT,
    reference: {
      operationKey: 'reference:freeze:initial', kind: 'deferred', state: 'unresolved', targetIngressId: null,
      targetNativeEventId: 'native-1', targetPartId: null, anchorKind: 'quote', anchorLang: 'zh',
      causationId: 'ingress-1', correlationId: 'reference:freeze', createdAt: AT,
    },
  }));
  const resolutionInput = {
    identity: base.conversation.identity, operationKey: 'reference:freeze:resolved',
    assemblyId: 'assembly-freeze', partId: 'part-freeze', expectedAssemblyRevision: 1,
    expectedState: 'unresolved', nextState: 'resolved', targetIngressId: 'ingress-1',
    targetNativeEventId: 'native-1', targetPartId: 'part-freeze', causationId: 'reference:freeze:initial',
    createdAt: LATER,
  };
  const resolved = await core.writer.write((tx) => tx.packageBAssembly.transitionReference(resolutionInput));
  await core.writer.write((tx) => tx.packageBAssembly.beginSealing({
    operationKey: 'assembly:begin:freeze', assemblyId: 'assembly-freeze', expectedRevision: 2, updatedAt: LATER,
  }));
  const beforeSealingAttempt = core.reader.journalEventCount();
  await assert.rejects(core.writer.write((tx) => tx.packageBAssembly.transitionReference({
    ...resolutionInput, operationKey: 'reference:freeze:sealing', expectedAssemblyRevision: 3,
    expectedState: 'resolved', nextState: 'withdrawn', causationId: resolved.resultId,
  })), { code: 'CORE_ASSEMBLY_REFERENCE_TERMINAL' });
  assert.equal(core.reader.journalEventCount(), beforeSealingAttempt);
  const sealedDigest = core.reader.packageBAssembly.activePartSetDigest({
    identity: base.conversation.identity, conversationId: CONVERSATION,
    assemblyId: 'assembly-freeze', expectedRevision: 3,
  });
  await core.writer.write((tx) => tx.packageBAssembly.seal({
    operationKey: 'assembly:seal:freeze', assemblyId: 'assembly-freeze', conversationId: CONVERSATION,
    expectedRevision: 3, sealedAt: LATER,
  }));
  assert.deepEqual(await core.writer.write((tx) => tx.packageBAssembly.transitionReference(resolutionInput)), resolved);
  const beforeLate = core.reader.journalEventCount();
  await assert.rejects(core.writer.write((tx) => tx.packageBAssembly.transitionReference({
    ...resolutionInput, operationKey: 'reference:freeze:late', expectedState: 'resolved', nextState: 'withdrawn',
    causationId: resolved.resultId,
  })), { code: 'CORE_ASSEMBLY_REFERENCE_TERMINAL' });
  assert.equal(core.reader.journalEventCount(), beforeLate);
  assert.equal(core.reader.packageBAssembly.activePartSetDigest({
    identity: base.conversation.identity, conversationId: CONVERSATION,
    assemblyId: 'assembly-freeze', expectedRevision: 3,
  }), sealedDigest);

  await core.writer.write((tx) => tx.packageBAssembly.create({
    operationKey: 'assembly:create:rejected-reference', assemblyId: 'assembly-rejected-reference',
    conversationId: CONVERSATION, quietDeadline: LATER, hardDeadline: HARD, createdAt: AT,
  }));
  await core.writer.write((tx) => tx.packageBAssembly.appendPart({
    identity: base.conversation.identity, operationKey: 'part:rejected-reference', partId: 'part-rejected-reference',
    assemblyId: 'assembly-rejected-reference', ingressEventId: 'ingress-1', partKind: 'text', sequenceNo: 1,
    payloadRef: 'payload:ingress-1', sourceRevision: 0, expectedAssemblyRevision: 0, createdAt: AT,
    reference: {
      operationKey: 'reference:rejected:initial', kind: 'deferred', state: 'unresolved',
      targetIngressId: 'ingress-1', targetNativeEventId: 'native-1', targetPartId: 'part-rejected-reference',
      anchorKind: 'quote', anchorLang: 'zh', causationId: 'ingress-1',
      correlationId: 'reference:rejected', createdAt: AT,
    },
  }));
  await core.writer.write((tx) => tx.packageBAssembly.reject({
    operationKey: 'assembly:reject:reference', assemblyId: 'assembly-rejected-reference',
    expectedRevision: 1, updatedAt: LATER,
  }));
  await assert.rejects(core.writer.write((tx) => tx.packageBAssembly.transitionReference({
    identity: base.conversation.identity, operationKey: 'reference:rejected:late',
    assemblyId: 'assembly-rejected-reference', partId: 'part-rejected-reference', expectedAssemblyRevision: 2,
    expectedState: 'unresolved', nextState: 'resolved', targetIngressId: 'ingress-1',
    targetNativeEventId: 'native-1', targetPartId: 'part-rejected-reference',
    causationId: 'reference:rejected:initial', createdAt: LATER,
  })), { code: 'CORE_ASSEMBLY_REFERENCE_TERMINAL' });

  await core.close();
  const reopened = openCoreDatabase({ dbPath });
  assert.equal(reopened.reader.packageBAssembly.deferredAssociations({
    identity: base.conversation.identity, conversationId: CONVERSATION, assemblyId: 'assembly-freeze',
  })[0].current.state, 'resolved');
  assert.equal(reopened.reader.packageBAssembly.activePartSetDigest({
    identity: base.conversation.identity, conversationId: CONVERSATION,
    assemblyId: 'assembly-freeze', expectedRevision: 3,
  }), sealedDigest);
  await reopened.close();
});

test('RC-04 serialized seal/reference races admit only the ordering-consistent outcome', async (t) => {
  const { core } = await openFixture(t, 'hermes-core-b131-seal-race-');
  const base = await commitIntent(core, {
    intent: { referenceKind: 'deferred', deferredReference: 'native:1', targetNativeEventId: 'native-1' },
  });
  const makeAssembly = async (suffix, ingressEventId, nativeEventId, intentResult) => {
    await core.writer.write((tx) => tx.packageBAssembly.create({
      operationKey: `assembly:create:${suffix}`, assemblyId: `assembly-${suffix}`, conversationId: CONVERSATION,
      quietDeadline: LATER, hardDeadline: HARD, createdAt: AT,
    }));
    await core.writer.write((tx) => tx.packageBAssembly.appendPart({
      identity: base.conversation.identity, operationKey: `part:${suffix}`, partId: `part-${suffix}`,
      assemblyId: `assembly-${suffix}`, ingressEventId, partKind: 'text', sequenceNo: 1,
      payloadRef: `payload:${ingressEventId}`, sourceRevision: 0, expectedAssemblyRevision: 0, createdAt: AT,
      reference: {
        operationKey: `reference:${suffix}:initial`, kind: 'deferred', state: 'unresolved',
        targetIngressId: ingressEventId, targetNativeEventId: nativeEventId, targetPartId: `part-${suffix}`,
        anchorKind: 'quote', anchorLang: 'zh', causationId: intentResult,
        correlationId: `reference:${suffix}`, createdAt: AT,
      },
    }));
  };
  await makeAssembly('reference-first', 'ingress-1', 'native-1', base.committed.intent.resultId);
  const referenceFirst = core.writer.write((tx) => tx.packageBAssembly.transitionReference({
    identity: base.conversation.identity, operationKey: 'reference:reference-first:resolved',
    assemblyId: 'assembly-reference-first', partId: 'part-reference-first', expectedAssemblyRevision: 1,
    expectedState: 'unresolved', nextState: 'resolved', targetIngressId: 'ingress-1',
    targetNativeEventId: 'native-1', targetPartId: 'part-reference-first',
    causationId: 'reference:reference-first:initial', createdAt: LATER,
  }));
  const sealAfterReference = core.writer.write((tx) => {
    tx.packageBAssembly.beginSealing({
      operationKey: 'assembly:begin:reference-first', assemblyId: 'assembly-reference-first',
      expectedRevision: 2, updatedAt: LATER,
    });
    return tx.packageBAssembly.seal({
      operationKey: 'assembly:seal:reference-first', assemblyId: 'assembly-reference-first',
      conversationId: CONVERSATION, expectedRevision: 3, sealedAt: LATER,
    });
  });
  assert.deepEqual((await Promise.all([referenceFirst, sealAfterReference])).map((item) => item.state ?? item.disposition),
    ['resolved', 'applied']);

  const second = await commitIntent(core, {
    ingress: { ingressEventId: 'ingress-seal-first', operationKey: 'ingress:seal-first', nativeEventId: 'native-seal-first', payloadRef: 'payload:ingress-seal-first' },
    intent: { operationKey: 'intent:seal-first', processingOperationKey: 'processing:seal-first',
      referenceKind: 'deferred', deferredReference: 'native:seal-first', targetNativeEventId: 'native-seal-first' },
  });
  await makeAssembly('seal-first', 'ingress-seal-first', 'native-seal-first', second.committed.intent.resultId);
  const sealFirst = core.writer.write((tx) => {
    tx.packageBAssembly.beginSealing({
      operationKey: 'assembly:begin:seal-first', assemblyId: 'assembly-seal-first', expectedRevision: 1, updatedAt: LATER,
    });
    return tx.packageBAssembly.seal({
      operationKey: 'assembly:seal:seal-first', assemblyId: 'assembly-seal-first',
      conversationId: CONVERSATION, expectedRevision: 2, sealedAt: LATER,
    });
  });
  const lateReference = core.writer.write((tx) => tx.packageBAssembly.transitionReference({
    identity: base.conversation.identity, operationKey: 'reference:seal-first:resolved',
    assemblyId: 'assembly-seal-first', partId: 'part-seal-first', expectedAssemblyRevision: 1,
    expectedState: 'unresolved', nextState: 'resolved', targetIngressId: 'ingress-seal-first',
    targetNativeEventId: 'native-seal-first', targetPartId: 'part-seal-first',
    causationId: 'reference:seal-first:initial', createdAt: LATER,
  }));
  const race = await Promise.allSettled([sealFirst, lateReference]);
  assert.deepEqual(race.map((item) => item.status), ['fulfilled', 'rejected']);
  assert.equal(race[1].reason.code, 'CORE_ASSEMBLY_REFERENCE_TERMINAL');
  await core.close();
});

test('additive public APIs stay inside the six accepted typed namespaces', async (t) => {
  const { core, dbPath } = await openFixture(t, 'hermes-core-b13-surface-');
  await core.writer.write((tx) => {
    assert.deepEqual(Object.keys(tx).sort(), [
      'effects', 'ingress', 'journal', 'packageBAssembly', 'packageBFinal', 'packageBIngress',
      'packageBPresentation', 'packageBProvider', 'packageBTurn', 'projections', 'publications',
      'revisions', 'soul', 'tombstones',
    ]);
    assert.deepEqual(Object.keys(tx.packageBIngress).sort(), [
      'commit', 'commitWithAssemblyIntent', 'transitionAssemblyProcessing',
    ]);
    assert.deepEqual(Object.keys(tx.packageBAssembly).sort(), [
      'appendPart', 'appendPartWithProcessing', 'beginSealing', 'create', 'interrupt', 'reject', 'seal', 'supersedePart',
      'transitionReference', 'updateQuietDeadline', 'withdrawPart',
    ]);
  });
  await core.close();
  const inspector = openTestInspector(dbPath);
  assert.equal(rowCount(inspector, 'schema_migration'), 1);
  inspector.close();
});

test('intent and processing replay, conflicts, scopes, and recover-worker races are deterministic', async (t) => {
  const { core } = await openFixture(t, 'hermes-core-b13-processing-');
  const base = await commitIntent(core);
  const beforeConflict = {
    ingress: core.reader.ingressEventCount(), journal: core.reader.journalEventCount(),
  };
  await assert.rejects(commitIntent(core, { intent: { payloadSize: 25 } }), {
    code: 'CORE_OPERATION_KEY_CONFLICT',
  });
  assert.deepEqual({ ingress: core.reader.ingressEventCount(), journal: core.reader.journalEventCount() }, beforeConflict);
  await assert.rejects(commitIntent(core, {
    ingress: {
      ingressEventId: 'ingress-conflicting-intent', operationKey: 'ingress:conflicting-intent',
      nativeEventIdTrust: 'untrusted', nativeEventId: 'native-conflicting-intent',
    },
    intent: { processingOperationKey: 'processing:conflicting-intent' },
  }), { code: 'CORE_OPERATION_KEY_CONFLICT' });
  assert.deepEqual({ ingress: core.reader.ingressEventCount(), journal: core.reader.journalEventCount() }, beforeConflict);
  const [left, right] = await Promise.all([commitIntent(core), commitIntent(core)]);
  assert.equal(left.committed.intent.resultId, right.committed.intent.resultId);
  assert.equal(core.reader.packageBIngress.assemblyIntentByOperation({
    identity: base.conversation.identity, operationKey: 'intent:1',
    operationDigest: `sha256:v1:${'f'.repeat(64)}`,
  }), undefined);
  for (const changed of [
    { ownerId: 'other' }, { actorRef: 'actor:other' }, { platform: 'wechat' },
    { sourceInstanceId: 'desktop:other' }, { platformConversationBinding: 'desktop:other' },
    { operationDigest: `sha256:v1:${'f'.repeat(64)}` },
  ]) assert.equal(core.reader.packageBIngress.assemblyIntentByIngress({
    identity: { ...base.conversation.identity, ...changed }, ingressEventId: 'ingress-1',
  }), undefined);

  const deferredInput = {
    identity: base.conversation.identity, operationKey: 'processing:deferred:1', ingressEventId: 'ingress-1',
    intentId: base.committed.intent.resultId, expectedState: 'pending', nextState: 'deferred',
    assemblyId: null, partId: null, causationId: base.committed.processing.resultId, createdAt: LATER,
  };
  const [deferred, deferredReplay] = await Promise.all([
    core.writer.write((tx) => tx.packageBIngress.transitionAssemblyProcessing(deferredInput)),
    core.writer.write((tx) => tx.packageBIngress.transitionAssemblyProcessing(deferredInput)),
  ]);
  assert.deepEqual(deferredReplay, deferred);
  assert.equal(core.reader.packageBIngress.pendingAssemblyWork({ identity: base.conversation.identity }).length, 1);
  const rejected = await core.writer.write((tx) => tx.packageBIngress.transitionAssemblyProcessing({
    ...deferredInput, operationKey: 'processing:rejected:1', expectedState: 'deferred', nextState: 'rejected',
    causationId: deferred.resultId,
  }));
  assert.equal(rejected.state, 'rejected');
  assert.equal(core.reader.packageBIngress.pendingAssemblyWork({ identity: base.conversation.identity }).length, 0);
  assert.deepEqual(await core.writer.write((tx) => tx.packageBIngress.transitionAssemblyProcessing({
    ...deferredInput, operationKey: 'processing:rejected:1', expectedState: 'deferred', nextState: 'rejected',
    causationId: deferred.resultId,
  })), rejected);
});

test('explicit and mutation references are parent-scoped and append/reference failures roll back together', async (t) => {
  const { core } = await openFixture(t, 'hermes-core-b13-reference-scope-');
  const first = await commitIntent(core);
  await commitIntent(core, {
    ingress: { ingressEventId: 'ingress-2', operationKey: 'ingress:2', nativeEventId: 'native-2',
      payloadRef: 'payload:ingress-2' },
    intent: { operationKey: 'intent:2', processingOperationKey: 'processing:2', partKind: 'quote',
      referenceKind: 'explicit', explicitReference: 'native:1', targetNativeEventId: 'native-1' },
  });
  await core.writer.write((tx) => tx.packageBAssembly.create({
    operationKey: 'assembly:create:1', assemblyId: 'assembly-1', conversationId: CONVERSATION,
    quietDeadline: LATER, hardDeadline: HARD, createdAt: AT,
  }));
  await core.writer.write((tx) => tx.packageBAssembly.appendPart({
    identity: first.conversation.identity, operationKey: 'part:target', partId: 'part-target',
    assemblyId: 'assembly-1', ingressEventId: 'ingress-1', partKind: 'text', sequenceNo: 1,
    payloadRef: 'payload:ingress-1', sourceRevision: 0, expectedAssemblyRevision: 0, createdAt: AT,
  }));
  const explicitInput = {
    identity: first.conversation.identity, operationKey: 'part:explicit', partId: 'part-explicit',
    assemblyId: 'assembly-1', ingressEventId: 'ingress-2', partKind: 'quote', sequenceNo: 2,
    payloadRef: 'payload:ingress-2', sourceRevision: 0, expectedAssemblyRevision: 1, createdAt: AT,
    reference: {
      operationKey: 'reference:explicit', kind: 'explicit', state: 'resolved', targetIngressId: 'ingress-1',
      targetNativeEventId: 'native-1', targetPartId: 'part-target', anchorKind: 'quote', anchorLang: 'zh',
      causationId: 'ingress-2', correlationId: 'reference:explicit', createdAt: AT,
    },
  };
  const explicit = await core.writer.write((tx) => tx.packageBAssembly.appendPart(explicitInput));
  assert.equal(explicit.reference.kind, 'explicit');
  assert.deepEqual((await core.writer.write((tx) => tx.packageBAssembly.appendPart(explicitInput))).reference, explicit.reference);
  const before = core.reader.journalEventCount();
  await assert.rejects(core.writer.write((tx) => tx.packageBAssembly.appendPart({
    ...explicitInput,
    reference: { ...explicitInput.reference, targetNativeEventId: 'native-2' },
  })), { code: 'CORE_OPERATION_KEY_CONFLICT' });
  assert.equal(core.reader.journalEventCount(), before);

  await commitIntent(core, {
    ingress: { ingressEventId: 'ingress-3', operationKey: 'ingress:3', nativeEventId: 'native-3',
      payloadRef: 'payload:ingress-3' },
    intent: { operationKey: 'intent:3', processingOperationKey: 'processing:3', partKind: 'edit',
      referenceKind: 'mutation_target', targetIngressId: 'ingress-1' },
  });
  const assemblyBefore = core.reader.packageBAssembly.byId({
    identity: first.conversation.identity, conversationId: CONVERSATION, assemblyId: 'assembly-1',
  });
  await assert.rejects(core.writer.write((tx) => tx.packageBAssembly.appendPart({
    identity: first.conversation.identity, operationKey: 'part:bad-reference', partId: 'part-bad',
    assemblyId: 'assembly-1', ingressEventId: 'ingress-3', partKind: 'edit', sequenceNo: 3,
    payloadRef: 'payload:ingress-3', sourceRevision: 0,
    expectedAssemblyRevision: assemblyBefore.revision, createdAt: LATER,
    reference: {
      operationKey: 'reference:bad', kind: 'mutation_target', state: 'resolved',
      targetIngressId: 'ingress-outside', targetNativeEventId: null, targetPartId: null,
      anchorKind: null, anchorLang: null, causationId: 'ingress-3', correlationId: 'reference:bad', createdAt: LATER,
    },
  })), { code: 'CORE_ASSEMBLY_REFERENCE_SCOPE_CONFLICT' });
  assert.equal(core.reader.packageBAssembly.partByIngress({
    identity: first.conversation.identity, conversationId: CONVERSATION, ingressEventId: 'ingress-3',
  }), undefined);
  assert.equal(core.reader.packageBAssembly.byId({
    identity: first.conversation.identity, conversationId: CONVERSATION, assemblyId: 'assembly-1',
  }).revision, assemblyBefore.revision);
});

test('part append plus processing transition rolls back as one transaction and due work ordering is stable', async (t) => {
  const { core } = await openFixture(t, 'hermes-core-b13-atomic-processing-');
  const base = await commitIntent(core);
  await core.writer.write((tx) => tx.packageBAssembly.create({
    operationKey: 'assembly:create:z', assemblyId: 'assembly-z', conversationId: CONVERSATION,
    quietDeadline: LATER, hardDeadline: HARD, createdAt: AT,
  }));
  await core.writer.write((tx) => tx.packageBAssembly.create({
    operationKey: 'assembly:create:a', assemblyId: 'assembly-a', conversationId: CONVERSATION,
    quietDeadline: LATER, hardDeadline: HARD, createdAt: AT,
  }));
  assert.deepEqual(core.reader.packageBAssembly.dueWork({ at: LATER }).map((item) => item.assembly.turn_assembly_id),
    ['assembly-a', 'assembly-z']);
  const before = core.reader.journalEventCount();
  await assert.rejects(core.writer.write((tx) => {
    const part = tx.packageBAssembly.appendPart({
      identity: base.conversation.identity, operationKey: 'part:atomic', partId: 'part-atomic',
      assemblyId: 'assembly-a', ingressEventId: 'ingress-1', partKind: 'text', sequenceNo: 1,
      payloadRef: 'payload:ingress-1', sourceRevision: 0, expectedAssemblyRevision: 0, createdAt: AT,
    });
    tx.packageBIngress.transitionAssemblyProcessing({
      identity: base.conversation.identity, operationKey: 'processing:atomic', ingressEventId: 'ingress-1',
      intentId: base.committed.intent.resultId, expectedState: 'pending', nextState: 'assembled',
      assemblyId: 'assembly-a', partId: 'part-atomic', causationId: part.resultId, createdAt: LATER,
    });
    throw new Error('fault after part and processing receipts');
  }), /fault after part and processing receipts/);
  assert.equal(core.reader.packageBAssembly.partByIngress({
    identity: base.conversation.identity, conversationId: CONVERSATION, ingressEventId: 'ingress-1',
  }), undefined);
  assert.equal(core.reader.packageBIngress.assemblyProcessingByIngress({
    identity: base.conversation.identity, ingressEventId: 'ingress-1',
  }).state, 'pending');
  assert.equal(core.reader.journalEventCount(), before);
});

test('typed recovery receipts reject raw text, paths, and non-allowlisted metadata before persistence', async (t) => {
  const { core } = await openFixture(t, 'hermes-core-b13-safe-receipt-');
  for (const intent of [
    { referenceKind: 'explicit', explicitReference: 'raw user prompt with spaces' },
    { partMetadata: { localPath: '/private/user/message.txt' } },
    { partMetadata: { mimeType: 'text/plain\nraw-body' } },
  ]) await assert.rejects(commitIntent(core, { intent }), {
    code: /CORE_ASSEMBLY_INTENT_(REFERENCE|METADATA)_INVALID/,
  });
  assert.equal(core.reader.ingressEventCount(), 0);
  assert.equal(core.reader.journalEventCount(), 0);
});

test('conflicting intent workers, reference resolution workers, and terminal processing have one durable winner', async (t) => {
  const { core } = await openFixture(t, 'hermes-core-b13-races-');
  const intentRace = await Promise.allSettled([
    commitIntent(core),
    commitIntent(core, { intent: { payloadSize: 25 } }),
  ]);
  assert.deepEqual(intentRace.map((item) => item.status), ['fulfilled', 'rejected']);
  assert.equal(intentRace[1].reason.code, 'CORE_OPERATION_KEY_CONFLICT');
  const base = intentRace[0].value;

  await core.writer.write((tx) => tx.packageBAssembly.create({
    operationKey: 'assembly:create:race', assemblyId: 'assembly-race', conversationId: CONVERSATION,
    quietDeadline: LATER, hardDeadline: HARD, createdAt: AT,
  }));
  await core.writer.write((tx) => tx.packageBAssembly.appendPart({
    identity: base.conversation.identity, operationKey: 'part:race', partId: 'part-race',
    assemblyId: 'assembly-race', ingressEventId: 'ingress-1', partKind: 'text', sequenceNo: 1,
    payloadRef: 'payload:ingress-1', sourceRevision: 0, expectedAssemblyRevision: 0, createdAt: AT,
    reference: {
      operationKey: 'reference:race:initial', kind: 'deferred', state: 'unresolved', targetIngressId: null,
      targetNativeEventId: 'native-1', targetPartId: null, anchorKind: 'quote', anchorLang: 'zh',
      causationId: 'ingress-1', correlationId: 'reference:race', createdAt: AT,
    },
  }));
  const resolution = (operationKey) => core.writer.write((tx) => tx.packageBAssembly.transitionReference({
    identity: base.conversation.identity, operationKey, assemblyId: 'assembly-race', partId: 'part-race',
    expectedAssemblyRevision: 1,
    expectedState: 'unresolved', nextState: 'resolved', targetIngressId: 'ingress-1',
    targetNativeEventId: 'native-1', targetPartId: 'part-race', anchorKind: 'quote', anchorLang: 'zh',
    causationId: 'reference:race:initial', createdAt: LATER,
  }));
  const referenceRace = await Promise.allSettled([
    resolution('reference:race:left'), resolution('reference:race:right'),
  ]);
  assert.deepEqual(referenceRace.map((item) => item.status), ['fulfilled', 'rejected']);
  assert.equal(referenceRace[1].reason.code, 'CORE_ASSEMBLY_REFERENCE_STALE');
  assert.equal(core.reader.packageBAssembly.deferredAssociations({
    identity: base.conversation.identity, conversationId: CONVERSATION, assemblyId: 'assembly-race',
  })[0].current.state, 'resolved');

  const terminal = await core.writer.write((tx) => tx.packageBIngress.transitionAssemblyProcessing({
    identity: base.conversation.identity, operationKey: 'processing:terminal:race', ingressEventId: 'ingress-1',
    intentId: base.committed.intent.resultId, expectedState: 'pending', nextState: 'terminal',
    assemblyId: null, partId: null, causationId: base.committed.processing.resultId, createdAt: LATER,
  }));
  assert.equal(terminal.state, 'terminal');
  assert.equal(core.reader.packageBIngress.pendingAssemblyWork({ identity: base.conversation.identity }).length, 0);
  await assert.rejects(core.writer.write((tx) => tx.packageBIngress.transitionAssemblyProcessing({
    identity: base.conversation.identity, operationKey: 'processing:terminal:race', ingressEventId: 'ingress-1',
    intentId: base.committed.intent.resultId, expectedState: 'pending', nextState: 'rejected',
    assemblyId: null, partId: null, causationId: base.committed.processing.resultId, createdAt: LATER,
  })), { code: 'CORE_OPERATION_KEY_CONFLICT' });
});
