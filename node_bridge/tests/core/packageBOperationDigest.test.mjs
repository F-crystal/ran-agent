import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assemblyActivePartSetDigest,
  assemblyLifecycleOperationDigest,
  assemblyPartOperationDigest,
  assemblySealOperationDigest,
  conversationIdentityOperationDigest,
  finalCommitOperationDigest,
  foregroundExchangeOperationDigest,
  ingressOperationDigest,
  presentationClaimOperationDigest,
  presentationBindingOperationDigest,
  presentationDispatchStartOperationDigest,
  presentationResultOperationDigest,
  providerAttemptOperationDigest,
  providerEpochOperationDigest,
  providerEpochTransitionOperationDigest,
  userTurnOperationDigest,
} from '../../src/core/packageB/packageBOperationDigest.mjs';

const TOKEN = `hmac-sha256:v1:test-key:${'a'.repeat(64)}`;
const AT = '2026-07-17T00:00:00.000Z';

const fixtures = Object.freeze([
  [ingressOperationDigest, {
    operationKey: 'ingress:1', platform: 'desktop', sourceInstanceId: 'desktop:local', nativeEventIdTrust: 'absent', nativeEventId: null,
    ownerId: 'owner', actorRef: 'actor:owner', platformConversationBinding: 'desktop:conversation', canonicalConversationKey: 'conversation:owner:desktop',
    payloadRef: 'payload:1', payloadHashToken: TOKEN, mutationKind: 'create', mutationTargetNativeEventId: null, retryOf: null, vendorEventTime: AT,
  }, 'payloadRef', 'sha256:v1:c9fe32df6a015b641f67a31cb6436c6022efaaf12ffa60e1b368fe31209d0cc6'],
  [conversationIdentityOperationDigest, {
    canonicalConversationKey: 'conversation', conversationId: 'conversation', ownerId: 'owner', actorRef: 'actor', platform: 'desktop',
    sourceInstanceId: 'desktop:local', platformConversationBinding: 'native', identityRevision: 1,
  }, 'actorRef', 'sha256:v1:2877d740ceaf747b1fea6020835629984a4cdd133cbc75ffe1f25d239d57470a'],
  [presentationBindingOperationDigest, {
    operationKey: 'binding:1', bindingId: 'binding', conversationId: 'conversation', ownerId: 'owner',
    sourceInstanceId: 'desktop:local', platform: 'desktop', destinationKind: 'conversation', destinationRef: 'destination',
    adapterMetadataCanonical: '{"protocol":"fixture"}',
  }, 'destinationRef', 'sha256:v1:6b9c344460753aef4fc19cc861fc1729ec11517b620f0e47af3f41b3cb9310dd'],
  [foregroundExchangeOperationDigest, {
    operationKey: 'foreground:1', conversationId: 'conversation', exchangeId: 'exchange', expectedConversationRevision: 0,
  }, 'exchangeId', 'sha256:v1:8f815d311c8b3b21f22b71926489d3da1a86d9b58ec1353115a4891371be2926'],
  [assemblyPartOperationDigest, {
    operationKey: 'part:1', assemblyId: 'assembly', expectedAssemblyRevision: 0, partId: 'part', partKind: 'text', sequenceNo: 1,
    payloadRef: 'payload', payloadHashToken: TOKEN, anchorRef: null, referenceRef: null, ingressEventId: 'ingress', sourceRevision: 0, disposition: 'active',
  }, 'partId', 'sha256:v1:4ecacb053b3a3a1f5518b0c9bca10b22fdf879f651562dc0a3c5c39124aa112f'],
  [assemblyLifecycleOperationDigest, {
    operationKey: 'life:1', operationKind: 'reject', assemblyId: 'assembly', conversationId: 'conversation', expectedRevision: 2,
    partId: null, quietDeadline: null, hardDeadline: null, disposition: 'rejected',
  }, 'operationKind', 'sha256:v1:d91ed1a5c79955681d50f14df49c64456c6f63d23e2e55ba48fb845920a08894'],
  [assemblySealOperationDigest, {
    operationKey: 'seal:1', assemblyId: 'assembly', conversationId: 'conversation', expectedRevision: 2,
    activePartSetDigest: `sha256:v1:${'b'.repeat(64)}`, sealedAt: AT,
  }, 'expectedRevision', 'sha256:v1:82fc5e66782b27c739961fdab34d11f9946b769542591acc2e47d123b6d40165'],
  [userTurnOperationDigest, {
    operationKey: 'user-turn:1', conversationId: 'conversation', exchangeId: 'exchange', assemblyId: 'assembly', assemblyRevision: 3,
    semanticTurnId: 'user-turn', turnRevisionId: 'user-turn-r1', sourceRevision: 1, payloadRef: 'payload:user', payloadHashToken: TOKEN,
    actorRef: 'actor', changeKind: 'initial', supersedesRevisionId: null, sourceEventId: 'event',
  }, 'sourceEventId', 'sha256:v1:2b04dceb7178e42c698a69e42691538373defbcfa7a5c355b623a4afc8597880'],
  [finalCommitOperationDigest, {
    operationKey: 'final:1', conversationId: 'conversation', exchangeId: 'exchange', sourceTurnId: 'user-turn', sourceRevision: 1,
    providerEpochId: 'epoch', providerAttempt: 1, providerAttemptReceiptId: 'provider-attempt-receipt', assistantTurnId: 'assistant-turn',
    assistantRevisionId: 'assistant-turn-r1', assistantActorRef: 'assistant', finalPayloadRef: 'payload:assistant', finalPayloadHashToken: TOKEN,
    expectedExchangeRevision: 1, expectedProviderEpochRevision: 0, presentations: [{
      outboxId: 'outbox-1', operationScope: 'presentation:desktop', operationKey: 'presentation:1', bindingId: 'binding', target: 'desktop',
      destinationKind: 'desktop', kind: 'text', payloadRef: 'presentation:1', payloadHashToken: TOKEN, routeRevision: 0, routeSourceInstanceId: 'desktop:local',
      routePlatform: 'desktop', routeDestinationRef: 'desktop',
    }],
  }, 'assistantActorRef', 'sha256:v1:0c9d7de6d61d3f76728149930e477d765b8fbedfd9506d5692757459eeb939ca'],
  [presentationClaimOperationDigest, {
    operationKey: 'claim:1', workerId: 'worker', outboxId: 'outbox', assistantTurnId: 'assistant-turn', sourceRevision: 1,
    bindingId: 'binding', target: 'desktop', expectedRevision: 0, expectedFence: 0, leaseOwner: 'worker',
    leaseUntil: '2026-07-17T00:01:00.000Z', causationEventId: 'cause',
  }, 'causationEventId', 'sha256:v1:49d2633dcff4eeb1a8aa44f64cb996a93ab384556686be8d464b550d7d8175b0'],
  [presentationDispatchStartOperationDigest, {
    operationKey: 'dispatch:1', outboxId: 'outbox', claimOperationKey: 'claim:1', claimOperationDigest: `sha256:v1:${'c'.repeat(64)}`,
    expectedRevision: 1, fenceToken: 1, leaseOwner: 'worker',
  }, 'expectedRevision', 'sha256:v1:2ec1088363a66470f3a9a21dc07fc2ab14af18edd6992754c15b6dedab5a72bc'],
  [presentationResultOperationDigest, {
    operationKey: 'result:1', outboxId: 'outbox', claimOperationKey: 'claim:1', fenceToken: 1, leaseOwner: 'worker', resultState: 'sent',
    evidenceRef: 'receipt:1', evidenceHashToken: TOKEN, errorClass: null,
  }, 'leaseOwner', 'sha256:v1:dd4b3bbd86a13e478b605486b9e9fd071a316247653fefc6926f00621d17e0d0'],
  [providerEpochOperationDigest, {
    operationKey: 'epoch:1', providerEpochId: 'epoch', conversationId: 'conversation', exchangeId: 'exchange', sourceTurnId: 'user',
    sourceRevision: 1, sourceRevisionId: 'user-r1', canonicalSnapshotRef: 'snapshot', snapshotHashToken: TOKEN, committedEventCursor: null,
    provider: 'p', model: 'm', capabilitySnapshotRef: 'cap', capabilitySnapshotHashToken: TOKEN, soulRevisionId: null,
    upstreamBindingKind: 'session', upstreamHandleHashToken: TOKEN, epochState: 'active', taintState: 'clean', requestIdentity: 'request',
  }, 'model', 'sha256:v1:86016b0f9618195f0e6948f2efb73f3e6296556b083bdf325da43c91b6683b36'],
  [providerEpochTransitionOperationDigest, {
    operationKey: 'epoch:transition:1', providerEpochId: 'epoch', conversationId: 'conversation', exchangeId: 'exchange',
    expectedCurrentState: 'active', expectedRevision: 0, nextState: 'tainted', taintState: 'tainted',
  }, 'nextState', 'sha256:v1:640be1fa97224648a556114fd039e86f9f96adcadcb48957d05ae5f5c82805d8'],
  [providerAttemptOperationDigest, {
    operationKey: 'provider:1', requestId: 'request', epochId: 'epoch', conversationId: 'conversation', exchangeId: 'exchange',
    sourceTurnId: 'user-turn', sourceRevision: 1, provider: 'p', model: 'm', capabilitySnapshotRef: 'cap', capabilitySnapshotHashToken: TOKEN,
    attemptNumber: 1, resultClass: 'started', errorClass: null, startedAt: AT, completedAt: null,
    snapshotRef: 'snapshot:1', snapshotHashToken: TOKEN, metadataRef: 'metadata:1', metadataHashToken: TOKEN,
  }, 'attemptNumber', 'sha256:v1:a3214b9814220d2f48b64d93e54fb463730e6e2cfc51a25bf6f9d7ab07802f88'],
]);

test('every B.1 operation digest has a fixed vector and reacts to semantic changes', () => {
  for (const [builder, input, changedField, expected] of fixtures) {
    assert.equal(builder(input), expected);
    const changed = typeof input[changedField] === 'number' ? input[changedField] + 1 : `${input[changedField]}:changed`;
    assert.notEqual(builder({ ...input, [changedField]: changed }), expected);
  }
  const partSet = assemblyActivePartSetDigest({
    assemblyId: 'assembly', assemblyRevision: 2, parts: [{ sequenceNo: 1, ingressEventId: 'ingress', partId: 'part', partKind: 'text',
      payloadRef: 'payload', payloadHashToken: TOKEN, anchorRef: null, referenceRef: null, disposition: 'active', ingressIdentity: 'identity',
      partSemanticDigest: `sha256:v1:${'b'.repeat(64)}` }],
  });
  assert.equal(partSet, 'sha256:v1:794fcb6f393e2a43d74dab473948dad2f8687b3957ad8e002d88ac0f94b2bf63');
  const pair = [
    { sequenceNo: 2, ingressEventId: 'ingress-b', partId: 'part-b', partKind: 'text', payloadRef: 'payload-b', payloadHashToken: TOKEN,
      anchorRef: null, referenceRef: null, disposition: 'active', ingressIdentity: 'identity-b', partSemanticDigest: `sha256:v1:${'c'.repeat(64)}` },
    { sequenceNo: 1, ingressEventId: 'ingress-a', partId: 'part-a', partKind: 'text', payloadRef: 'payload-a', payloadHashToken: TOKEN,
      anchorRef: null, referenceRef: null, disposition: 'active', ingressIdentity: 'identity-a', partSemanticDigest: `sha256:v1:${'d'.repeat(64)}` },
  ];
  assert.equal(
    assemblyActivePartSetDigest({ assemblyId: 'assembly', assemblyRevision: 3, parts: pair }),
    assemblyActivePartSetDigest({ assemblyId: 'assembly', assemblyRevision: 3, parts: [...pair].reverse() }),
  );
});

test('trusted ingress excludes local receipt time but binds vendor semantic time', () => {
  const input = fixtures[0][1];
  assert.equal(ingressOperationDigest({ ...input, receivedAt: AT }), ingressOperationDigest({ ...input, receivedAt: '2026-07-17T00:01:00.000Z' }));
  assert.notEqual(ingressOperationDigest(input), ingressOperationDigest({ ...input, vendorEventTime: '2026-07-17T00:00:01.000Z' }));
});

test('digest builders reject missing required fields and non-scalar input', () => {
  assert.throws(() => conversationIdentityOperationDigest({ ...fixtures[1][1], actorRef: undefined }), { code: 'CORE_OPERATION_SEMANTICS_INVALID' });
  const providerFixture = fixtures.find(([builder]) => builder === providerEpochOperationDigest)[1];
  assert.throws(() => providerEpochOperationDigest({ ...providerFixture, provider: { arbitrary: 'object' } }), { code: 'CORE_OPERATION_SEMANTICS_INVALID' });
  assert.throws(() => assemblyActivePartSetDigest({ assemblyId: 'assembly', assemblyRevision: 1, parts: [] }), { code: 'CORE_ASSEMBLY_EMPTY' });
});
