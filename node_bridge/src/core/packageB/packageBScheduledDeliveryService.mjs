import { createHash } from 'node:crypto';

import { coreError } from '../coreErrors.mjs';
import { createCoreSchedulingService } from '../coreScheduling.mjs';
import { runPackageBLocalDelivery } from './packageBDeliveryService.mjs';

function key(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 32);
}

function text(value, code, message) {
  const normalized = String(value || '').trim();
  if (!normalized) throw coreError(code, message);
  return normalized;
}

function wholeSecond(value) {
  const instant = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(instant.getTime())) throw coreError('CORE_SCHEDULED_DELIVERY_TIME_INVALID', 'scheduled delivery time is invalid');
  return new Date(Math.floor(instant.getTime() / 1_000) * 1_000).toISOString();
}

export function createPackageBScheduledDeliveryHandler({
  core, hashContent, decide, send, afterTerminal = async () => {}, now = () => new Date(),
} = {}) {
  if (!core?.writer || typeof hashContent !== 'function' || typeof decide !== 'function' || typeof send !== 'function') {
    throw coreError('CORE_SCHEDULED_DELIVERY_DEPENDENCY_INVALID', 'scheduled delivery requires Core, Hermes decision and one adapter');
  }
  const scheduling = createCoreSchedulingService({ core });
  const handler = async ({ work, authority }) => {
    const context = core.reader.scheduledWorkContext(work.work_run_id);
    if (!context) throw coreError('CORE_SCHEDULED_DELIVERY_CONTEXT_MISSING', 'scheduled delivery context is missing');
    const identity = core.reader.conversationIdentityById(context.conversation_id);
    if (!identity) throw coreError('CORE_SCHEDULED_DELIVERY_IDENTITY_MISSING', 'scheduled delivery identity is missing');
    const stable = key(work.work_run_id);
    const at = wholeSecond(now());
    const instructionTurnId = `turn:scheduled:${stable}`;
    const instructionRevisionId = `revision:scheduled:${stable}:1`;
    await scheduling.commitScheduledInstruction({
      operationKey: `scheduled:instruction:${stable}`,
      instructionTurnId,
      instructionRevisionId,
      payloadHashToken: hashContent('scheduled-instruction', context.payload_ref),
      authority,
    });
    const decision = await decide(Object.freeze({
      workRunId: work.work_run_id,
      conversationId: context.conversation_id,
      scheduledFor: context.scheduled_for,
      recurrence: JSON.parse(context.recurrence_json),
      payloadRef: context.payload_ref,
      platform: context.platform,
      destinationKind: context.destination_kind,
      destinationRef: context.destination_ref,
      ownerId: identity.ownerId,
    }));
    if (decision?.suppressSend === true) {
      const resultRef = `scheduled-silent:${stable}`;
      const deliveryOutcome = Object.freeze({
        state: 'suppressed', resultRef,
      });
      return Object.freeze({
        resultRef, resultHashToken: hashContent('work-run-result', resultRef), deliveryOutcome,
      });
    }
    const replyText = text(decision?.replyText, 'CORE_SCHEDULED_DELIVERY_EMPTY', 'Hermes scheduled decision returned no text');
    const provider = text(decision?.provider || 'hermes', 'CORE_SCHEDULED_DELIVERY_PROVIDER_INVALID', 'scheduled provider is invalid');
    const model = text(decision?.model || 'unspecified', 'CORE_SCHEDULED_DELIVERY_MODEL_INVALID', 'scheduled model is invalid');
    const epochId = `provider-epoch:scheduled:${stable}`;
    const snapshotRef = `snapshot:scheduled:${stable}`;
    const epoch = await core.writer.write((tx) => tx.packageBProvider.createEpoch({
      operationKey: `scheduled:epoch:${stable}`, providerEpochId: epochId,
      conversationId: context.conversation_id, exchangeId: context.exchange_id,
      sourceTurnId: instructionTurnId, sourceRevision: 1, sourceRevisionId: instructionRevisionId,
      provider, model, capabilitySnapshotRef: `capability:scheduled:${stable}`,
      capabilitySnapshotHashToken: hashContent('provider-capability', `${provider}\u0000${model}`),
      canonicalSnapshotRef: snapshotRef,
      snapshotHashToken: hashContent('provider-snapshot', `${context.payload_ref}\u0000${replyText}`),
      committedEventCursor: null, soulRevisionId: null, bindingId: `provider-binding:scheduled:${stable}`,
      upstreamBindingKind: 'session', upstreamHandle: `hermes-scheduled:${stable}`,
      upstreamHandleHashToken: hashContent('provider-handle', `hermes-scheduled:${stable}`),
      epochState: 'active', taintState: 'clean', requestIdentity: `provider-request:scheduled:${stable}`,
      workRunAuthority: authority, createdAt: at,
    }));
    const attempt = await core.writer.write((tx) => tx.packageBProvider.appendAttempt({
      operationKey: `scheduled:attempt:${stable}:1`, requestId: `provider-attempt:scheduled:${stable}:1`,
      epochId, conversationId: context.conversation_id, exchangeId: context.exchange_id,
      sourceTurnId: instructionTurnId, sourceRevision: 1, attemptNumber: 1,
      resultClass: 'completed', errorClass: null, startedAt: at, completedAt: at,
      snapshotRef, snapshotHashToken: epoch.providerEpoch.snapshot_hash_token,
      metadataRef: `provider-metadata:scheduled:${stable}:1`,
      metadataHashToken: hashContent('provider-metadata', `${provider}\u0000${model}\u0000completed`),
    }));
    const outboxId = `outbox:scheduled:${stable}`;
    const delivery = await runPackageBLocalDelivery({
      core, identity, workRunAuthority: authority, outboxId, workerId: authority.leaseOwner,
      claimedAt: at, leaseUntil: authority.leaseUntil || work.lease_until || new Date(Date.parse(at) + 60_000).toISOString(),
      startedAt: at, recordedAt: at,
      adapterExceptionResult: {
        resultState: 'ambiguous', evidenceRef: `adapter-receipt:scheduled:${stable}:exception`,
        evidenceHashToken: hashContent('adapter-receipt', `scheduled:${stable}:exception`),
        errorClass: 'adapter_exception',
      },
      finalInput: {
        operationKey: `scheduled:final:${stable}`, conversationId: context.conversation_id,
        exchangeId: context.exchange_id, sourceTurnId: instructionTurnId, sourceRevision: 1,
        providerEpochId: epochId, providerAttempt: 1, providerAttemptReceiptId: attempt.resultId,
        assistantTurnId: `turn:assistant:scheduled:${stable}`,
        assistantRevisionId: `revision:assistant:scheduled:${stable}:1`, assistantActorRef: 'assistant:hermes',
        finalPayloadRef: `payload:assistant:scheduled:${stable}:1`,
        finalPayloadHashToken: hashContent('assistant-final', replyText),
        expectedExchangeRevision: 1, expectedProviderEpochRevision: 0,
        workRunAuthority: authority, committedAt: at,
        presentations: [{
          outboxId, operationScope: `presentation:${context.platform}`,
          operationKey: `scheduled:outbox:${stable}`, bindingId: context.presentation_binding_id,
          target: context.destination_ref, destinationKind: context.destination_kind, kind: 'text',
          payloadRef: `presentation:text:scheduled:${stable}:1`,
          payloadHashToken: hashContent('presentation-text', replyText),
          routeRevision: Number(context.binding_revision), routeSourceInstanceId: context.source_instance_id,
          platform: context.platform,
        }],
      },
      send: (view) => send(Object.freeze({ ...view, text: replyText })),
    });
    return Object.freeze({
      resultRef: `core-presentation-receipt:${delivery.delivery.receiptId || outboxId}:${delivery.delivery.state}`,
      resultHashToken: hashContent('work-run-result', `${outboxId}\u0000${delivery.delivery.state}`),
      deliveryOutcome: delivery.delivery,
    });
  };
  handler.afterTerminal = async ({ work, outcome }) => {
    const context = core.reader.scheduledWorkContext(work.work_run_id);
    if (!context) throw coreError('CORE_SCHEDULED_DELIVERY_CONTEXT_MISSING', 'scheduled delivery context is missing');
    return afterTerminal(Object.freeze({ ...context, work_run_id: work.work_run_id }), outcome);
  };
  return handler;
}
