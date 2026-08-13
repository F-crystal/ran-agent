import { createHash, createHmac } from 'node:crypto';

import { coreError } from '../coreErrors.mjs';
import { formatKeyedContentHashToken } from '../coreHashToken.mjs';
import { runPackageBLocalDelivery } from './packageBDeliveryService.mjs';

const IN_FLIGHT = new WeakMap();

function digest(value, length = 32) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, length);
}

function timestamp(value, offsetMs = 0) {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds)) {
    throw coreError('CORE_NODE_TIMESTAMP_INVALID', 'Node to Core delivery requires a stable message timestamp');
  }
  return new Date(milliseconds + offsetMs).toISOString();
}

function requireText(value, code, message) {
  const normalized = String(value || '').trim();
  if (!normalized) throw coreError(code, message);
  return normalized;
}

function inFlightMap(core) {
  let map = IN_FLIGHT.get(core);
  if (!map) {
    map = new Map();
    IN_FLIGHT.set(core, map);
  }
  return map;
}

export function createCoreContentHasher({ keyId, key } = {}) {
  const normalizedKeyId = requireText(keyId, 'CORE_NODE_HASH_KEY_ID_REQUIRED', 'Core content hash key ID is required');
  if ((typeof key !== 'string' && !Buffer.isBuffer(key)) || key.length === 0) {
    throw coreError('CORE_NODE_HASH_KEY_REQUIRED', 'Core content hash key is required');
  }
  return (kind, value) => formatKeyedContentHashToken({
    keyId: normalizedKeyId,
    digest: createHmac('sha256', key).update(`${requireText(kind, 'CORE_NODE_HASH_KIND_REQUIRED', 'Core hash kind is required')}\u0000${String(value)}`, 'utf8').digest('hex'),
  });
}

function buildExchange({ message, response, globalUserId, actorContext, hashContent }) {
  if (!actorContext?.owner || !actorContext.actorKey) {
    throw coreError('CORE_NODE_ACTOR_UNAUTHORIZED', 'Node to Core local wiring accepts only a verified owner actor');
  }
  if (typeof hashContent !== 'function') {
    throw coreError('CORE_NODE_HASHER_REQUIRED', 'Node to Core local wiring requires an injected content hasher');
  }
  const platform = requireText(message.platform, 'CORE_NODE_PLATFORM_REQUIRED', 'Node platform is required');
  const nativeEventId = requireText(message.id, 'CORE_NODE_MESSAGE_ID_REQUIRED', 'Node message ID is required');
  const conversationBinding = requireText(message.conversation_id, 'CORE_NODE_CONVERSATION_REQUIRED', 'Node conversation is required');
  const userText = requireText(message.text, 'CORE_NODE_USER_TEXT_REQUIRED', 'Node user text is required');
  const assistantText = requireText(response.replyText, 'CORE_NODE_ASSISTANT_TEXT_REQUIRED', 'Hermes final text is required');
  const ownerId = requireText(globalUserId, 'CORE_NODE_OWNER_REQUIRED', 'Core owner identity is required');
  const stableConversationKey = requireText(message.stable_conversation_key,
    'CORE_NODE_CONVERSATION_KEY_REQUIRED', 'Stable Conversation key is required');
  const sourceInstanceId = `node-channel-hub:${platform}`;
  const conversationKey = digest(`${ownerId}\u0000${stableConversationKey}`);
  const messageKey = digest(`${sourceInstanceId}\u0000${nativeEventId}`);
  const routeKey = digest(`${platform}\u0000${conversationBinding}`);
  const conversationId = `conversation:${platform}:${conversationKey}`;
  const exchangeId = `exchange:${messageKey}`;
  const ingressEventId = `ingress:${messageKey}`;
  const assemblyId = `assembly:${messageKey}`;
  const partId = `part:${messageKey}:1`;
  const userTurnId = `turn:user:${messageKey}`;
  const userRevisionId = `revision:user:${messageKey}:1`;
  const providerEpochId = `provider-epoch:${messageKey}`;
  const providerAttemptId = `provider-attempt:${messageKey}:1`;
  const assistantTurnId = `turn:assistant:${messageKey}`;
  const assistantRevisionId = `revision:assistant:${messageKey}:1`;
  const bindingId = `binding:channel-hub:v1:${routeKey}`;
  const outboxId = `outbox:${messageKey}`;
  const destinationRef = `conversation:${routeKey}`;
  const createdAt = timestamp(message.created_at);
  const provider = requireText(response.provider || 'hermes', 'CORE_NODE_PROVIDER_REQUIRED', 'Hermes provider is required');
  const model = requireText(response.model || response.profile || 'unspecified', 'CORE_NODE_MODEL_REQUIRED', 'Hermes model is required');
  return Object.freeze({
    messageKey, platform, nativeEventId, conversationId, canonicalConversationKey: conversationId,
    stableConversationKey, ownerId,
    actorRef: actorContext.actorKey, sourceInstanceId,
    platformConversationBinding: `${platform}:conversation:${routeKey}`,
    exchangeId, ingressEventId, assemblyId, partId, userTurnId, userRevisionId,
    providerEpochId, providerAttemptId, assistantTurnId, assistantRevisionId,
    bindingId, outboxId, destinationRef, userText, assistantText, provider, model, createdAt,
    ingressPayloadRef: `payload:ingress:${messageKey}`,
    userPayloadRef: `payload:user:${messageKey}:1`,
    snapshotRef: `snapshot:${messageKey}:1`,
    capabilitySnapshotRef: `capability:${messageKey}:1`,
    metadataRef: `provider-metadata:${messageKey}:1`,
    finalPayloadRef: `payload:assistant:${messageKey}:1`,
    presentationPayloadRef: `presentation:text:${messageKey}:1`,
    ingressPayloadHashToken: hashContent('ingress-text', userText),
    userPayloadHashToken: hashContent('user-turn', userText),
    snapshotHashToken: hashContent('provider-snapshot', `${stableConversationKey}\u0000${userText}`),
    capabilitySnapshotHashToken: hashContent('provider-capability', `${provider}\u0000${model}`),
    upstreamHandleHashToken: hashContent('provider-handle', message.hermes_session_id || stableConversationKey),
    metadataHashToken: hashContent('provider-metadata', `${provider}\u0000${model}\u0000completed`),
    finalPayloadHashToken: hashContent('assistant-final', assistantText),
    presentationPayloadHashToken: hashContent('presentation-text', assistantText),
  });
}

function normalizeAdapterResult(value, exchange, hashContent) {
  const result = value && typeof value === 'object' ? value : {};
  const status = String(result.textStatus || '').trim().toLowerCase();
  const resultState = status === 'sent'
    ? 'sent'
    : status === 'failed' || result.knownFailure === true ? 'failed' : 'ambiguous';
  const evidenceRef = String(result.adapterReceiptRef || `adapter-receipt:${exchange.messageKey}:${resultState}`).trim();
  return Object.freeze({
    resultState,
    evidenceRef,
    evidenceHashToken: hashContent('adapter-receipt', `${resultState}\u0000${evidenceRef}`),
    errorClass: resultState === 'sent' ? null : String(result.errorClass || `adapter_${resultState}`),
  });
}

async function runNodeDelivery({ core, exchange, hashContent, send }) {
  const identityResult = await core.writer.write((tx) => tx.packageBTurn.createOrResolveConversation({
    conversationId: exchange.conversationId,
    canonicalConversationKey: exchange.canonicalConversationKey,
    ownerId: exchange.ownerId,
    actorRef: exchange.actorRef,
    platform: exchange.platform,
    primaryFrontend: exchange.platform,
    sourceInstanceId: exchange.sourceInstanceId,
    platformConversationBinding: exchange.platformConversationBinding,
    createdAt: exchange.createdAt,
  }));
  const identity = identityResult.identity;
  const ingress = await core.writer.write((tx) => tx.packageBIngress.commit({
    ingressEventId: exchange.ingressEventId,
    operationKey: `node-ingress:${exchange.messageKey}`,
    platform: exchange.platform,
    sourceInstanceId: exchange.sourceInstanceId,
    nativeEventIdTrust: 'trusted',
    nativeEventId: exchange.nativeEventId,
    ownerId: exchange.ownerId,
    actorRef: exchange.actorRef,
    platformConversationBinding: exchange.platformConversationBinding,
    canonicalConversationKey: exchange.canonicalConversationKey,
    payloadRef: exchange.ingressPayloadRef,
    payloadHashToken: exchange.ingressPayloadHashToken,
    mutationKind: 'create',
    mutationTargetNativeEventId: null,
    retryOf: null,
    vendorEventTime: exchange.createdAt,
    receivedAt: exchange.createdAt,
    createdAt: exchange.createdAt,
  }));
  await core.writer.write((tx) => tx.packageBPresentation.createOrReadBinding({
    operationKey: `node-binding:${digest(exchange.destinationRef)}`,
    bindingId: exchange.bindingId,
    conversationId: exchange.conversationId,
    ownerId: exchange.ownerId,
    sourceInstanceId: exchange.sourceInstanceId,
    platform: exchange.platform,
    destinationKind: 'conversation',
    destinationRef: exchange.destinationRef,
    adapterMetadata: { protocol: 'channel-hub', receiptMode: 'typed', routeVersion: '1' },
    createdAt: exchange.createdAt,
  }));
  await core.writer.write((tx) => tx.packageBAssembly.create({
    operationKey: `node-assembly-create:${exchange.messageKey}`,
    assemblyId: exchange.assemblyId,
    conversationId: exchange.conversationId,
    quietDeadline: timestamp(Date.parse(exchange.createdAt), 1),
    hardDeadline: timestamp(Date.parse(exchange.createdAt), 2),
    createdAt: exchange.createdAt,
  }));
  await core.writer.write((tx) => tx.packageBAssembly.appendPart({
    operationKey: `node-assembly-part:${exchange.messageKey}:1`,
    partId: exchange.partId,
    assemblyId: exchange.assemblyId,
    ingressEventId: exchange.ingressEventId,
    partKind: 'text',
    sequenceNo: 1,
    payloadRef: exchange.userPayloadRef,
    sourceRevision: 0,
    expectedAssemblyRevision: 0,
    createdAt: timestamp(Date.parse(exchange.createdAt), 1),
  }));
  await core.writer.write((tx) => tx.packageBAssembly.beginSealing({
    operationKey: `node-assembly-sealing:${exchange.messageKey}`,
    assemblyId: exchange.assemblyId,
    expectedRevision: 1,
    updatedAt: timestamp(Date.parse(exchange.createdAt), 2),
  }));
  const activePartSetDigest = core.reader.packageBAssembly.activePartSetDigest({
    identity,
    conversationId: exchange.conversationId,
    assemblyId: exchange.assemblyId,
    expectedRevision: 2,
  });
  const sealed = await core.writer.write((tx) => tx.packageBAssembly.seal({
    operationKey: `node-assembly-seal:${exchange.messageKey}`,
    assemblyId: exchange.assemblyId,
    conversationId: exchange.conversationId,
    expectedRevision: 2,
    expectedActivePartSetDigest: activePartSetDigest,
    sealedAt: timestamp(Date.parse(exchange.createdAt), 3),
  }));
  await core.writer.write((tx) => tx.packageBTurn.commitUserTurn({
    operationKey: `node-user-turn:${exchange.messageKey}`,
    conversationId: exchange.conversationId,
    exchangeId: exchange.exchangeId,
    assemblyId: exchange.assemblyId,
    assemblyRevision: sealed.revision,
    ingressEventId: ingress.ingressEventId,
    semanticTurnId: exchange.userTurnId,
    turnRevisionId: exchange.userRevisionId,
    actorRef: exchange.actorRef,
    payloadRef: exchange.userPayloadRef,
    payloadHashToken: exchange.userPayloadHashToken,
    sourceEventId: sealed.resultId,
    committedAt: timestamp(Date.parse(exchange.createdAt), 4),
  }));
  await core.writer.write((tx) => tx.packageBProvider.createEpoch({
    operationKey: `node-provider-epoch:${exchange.messageKey}`,
    providerEpochId: exchange.providerEpochId,
    conversationId: exchange.conversationId,
    exchangeId: exchange.exchangeId,
    sourceTurnId: exchange.userTurnId,
    sourceRevision: 1,
    sourceRevisionId: exchange.userRevisionId,
    provider: exchange.provider,
    model: exchange.model,
    capabilitySnapshotRef: exchange.capabilitySnapshotRef,
    capabilitySnapshotHashToken: exchange.capabilitySnapshotHashToken,
    canonicalSnapshotRef: exchange.snapshotRef,
    snapshotHashToken: exchange.snapshotHashToken,
    committedEventCursor: null,
    soulRevisionId: null,
    bindingId: `provider-binding:${exchange.messageKey}`,
    upstreamBindingKind: 'session',
    upstreamHandle: `hermes-session:${exchange.messageKey}`,
    upstreamHandleHashToken: exchange.upstreamHandleHashToken,
    epochState: 'active',
    taintState: 'clean',
    requestIdentity: `provider-request:${exchange.messageKey}`,
    createdAt: timestamp(Date.parse(exchange.createdAt), 5),
  }));
  const attempt = await core.writer.write((tx) => tx.packageBProvider.appendAttempt({
    operationKey: `node-provider-attempt:${exchange.messageKey}:1`,
    requestId: exchange.providerAttemptId,
    epochId: exchange.providerEpochId,
    conversationId: exchange.conversationId,
    exchangeId: exchange.exchangeId,
    sourceTurnId: exchange.userTurnId,
    sourceRevision: 1,
    attemptNumber: 1,
    resultClass: 'completed',
    errorClass: null,
    startedAt: timestamp(Date.parse(exchange.createdAt), 5),
    completedAt: timestamp(Date.parse(exchange.createdAt), 6),
    snapshotRef: exchange.snapshotRef,
    snapshotHashToken: exchange.snapshotHashToken,
    metadataRef: exchange.metadataRef,
    metadataHashToken: exchange.metadataHashToken,
  }));
  const finalInput = {
    operationKey: `node-final:${exchange.messageKey}`,
    conversationId: exchange.conversationId,
    exchangeId: exchange.exchangeId,
    sourceTurnId: exchange.userTurnId,
    sourceRevision: 1,
    providerEpochId: exchange.providerEpochId,
    providerAttempt: 1,
    providerAttemptReceiptId: attempt.resultId,
    assistantTurnId: exchange.assistantTurnId,
    assistantRevisionId: exchange.assistantRevisionId,
    assistantActorRef: 'assistant:hermes',
    finalPayloadRef: exchange.finalPayloadRef,
    finalPayloadHashToken: exchange.finalPayloadHashToken,
    expectedExchangeRevision: 1,
    expectedProviderEpochRevision: 0,
    committedAt: timestamp(Date.parse(exchange.createdAt), 7),
    presentations: [{
      outboxId: exchange.outboxId,
      operationScope: `presentation:${exchange.platform}`,
      operationKey: `node-outbox:${exchange.messageKey}`,
      bindingId: exchange.bindingId,
      target: exchange.destinationRef,
      destinationKind: 'conversation',
      kind: 'text',
      payloadRef: exchange.presentationPayloadRef,
      payloadHashToken: exchange.presentationPayloadHashToken,
      routeRevision: 0,
      routeSourceInstanceId: exchange.sourceInstanceId,
      platform: exchange.platform,
    }],
  };
  return runPackageBLocalDelivery({
    core,
    identity,
    finalInput,
    outboxId: exchange.outboxId,
    workerId: 'node-channel-hub-local',
    claimedAt: timestamp(Date.parse(exchange.createdAt), 8),
    leaseUntil: timestamp(Date.parse(exchange.createdAt), 60_000),
    startedAt: timestamp(Date.parse(exchange.createdAt), 9),
    recordedAt: timestamp(Date.parse(exchange.createdAt), 10),
    send: async (adapterView) => {
      try {
        return normalizeAdapterResult(await send(adapterView), exchange, hashContent);
      } catch {
        return normalizeAdapterResult({
          textStatus: 'ambiguous',
          adapterReceiptRef: `adapter-receipt:${exchange.messageKey}:exception`,
          errorClass: 'adapter_exception',
        }, exchange, hashContent);
      }
    },
  });
}

export async function deliverNodeTextThroughCore({
  core,
  message,
  response,
  globalUserId,
  actorContext,
  hashContent,
  send,
} = {}) {
  if (!core?.writer || !core?.reader || typeof send !== 'function') {
    throw coreError('CORE_NODE_DELIVERY_REQUIRED', 'Node to Core delivery requires Core and one adapter');
  }
  const exchange = buildExchange({ message, response, globalUserId, actorContext, hashContent });
  const active = inFlightMap(core);
  if (active.has(exchange.outboxId)) return active.get(exchange.outboxId);
  const pending = runNodeDelivery({ core, exchange, hashContent, send })
    .then((result) => Object.freeze({ ...result, exchange }))
    .finally(() => active.delete(exchange.outboxId));
  active.set(exchange.outboxId, pending);
  return pending;
}
