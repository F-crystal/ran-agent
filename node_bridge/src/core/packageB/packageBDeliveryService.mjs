import { createHash } from 'node:crypto';

import { coreError } from '../coreErrors.mjs';

const TERMINAL_STATES = new Set(['sent', 'failed', 'ambiguous', 'cancelled']);

function operationKey(kind, outboxId, revision, fenceToken) {
  const identity = createHash('sha256').update(String(outboxId), 'utf8').digest('hex').slice(0, 32);
  return `package-b2:${kind}:${identity}:${revision}:${fenceToken}`;
}

function adapterView(outbox) {
  return Object.freeze({
    outboxId: outbox.presentation_outbox_id,
    target: outbox.destination_ref,
    platform: outbox.route_platform,
    destinationKind: outbox.destination_kind,
    presentationKind: outbox.presentation_kind,
    payloadRef: outbox.payload_ref,
    payloadHashToken: outbox.payload_hash_token,
    routeRevision: Number(outbox.route_revision),
  });
}

export async function runPackageBLocalDelivery({
  core,
  identity,
  finalInput,
  outboxId,
  workerId,
  claimedAt,
  leaseUntil,
  startedAt = claimedAt,
  recordedAt = startedAt,
  send,
}) {
  if (typeof send !== 'function') {
    throw coreError('CORE_B2_ADAPTER_REQUIRED', 'Package B.2 delivery requires one adapter');
  }
  if (!core.reader.packageBTurn.conversationIdentity({ identity, conversationId: finalInput?.conversationId })) {
    throw coreError('CORE_B2_IDENTITY_INVALID', 'Package B.2 delivery requires the verified Conversation identity');
  }
  if (!Array.isArray(finalInput?.presentations)
    || !finalInput.presentations.some((item) => item?.outboxId === outboxId)) {
    throw coreError('CORE_B2_OUTBOX_SCOPE_INVALID', 'Package B.2 outbox does not belong to the final transaction');
  }
  const final = await core.writer.write((tx) => tx.packageBFinal.commit(finalInput));

  const current = core.reader.packageBPresentation.outbox({
    identity,
    conversationId: finalInput.conversationId,
    outboxId,
  });
  if (!current) throw coreError('CORE_B2_OUTBOX_NOT_FOUND', 'Package B.2 outbox is unavailable');
  if (TERMINAL_STATES.has(current.state)) {
    return Object.freeze({
      final,
      delivery: Object.freeze({ disposition: 'terminal', state: current.state, effectAttempted: false, outboxId }),
    });
  }

  const claimOperationKey = operationKey('claim', outboxId, Number(current.revision), Number(current.fence_token));
  const claim = await core.writer.write((tx) => tx.packageBPresentation.claim({
    operationKey: claimOperationKey,
    workerId,
    outboxId,
    expectedRevision: Number(current.revision),
    expectedFence: Number(current.fence_token),
    leaseOwner: workerId,
    leaseUntil,
    claimedAt,
    causationEventId: final.resultId,
  }));
  if (!claim?.dispatchAuthorized) {
    return Object.freeze({
      final,
      delivery: Object.freeze({ disposition: claim?.disposition ?? 'not_claimed', state: claim?.state ?? current.state,
        effectAttempted: false, outboxId }),
    });
  }

  const dispatchOperationKey = operationKey('dispatch', outboxId, claim.revision, claim.fenceToken);
  const dispatch = await core.writer.write((tx) => tx.packageBPresentation.markDispatchStarted({
    operationKey: dispatchOperationKey,
    outboxId,
    claimOperationKey,
    expectedRevision: claim.revision,
    fenceToken: claim.fenceToken,
    leaseOwner: workerId,
    startedAt,
  }));
  if (!dispatch?.dispatchAuthorized) {
    return Object.freeze({
      final,
      delivery: Object.freeze({ disposition: dispatch?.disposition ?? 'dispatch_not_started', state: 'reserved',
        effectAttempted: false, outboxId }),
    });
  }

  const adapterResult = await send(adapterView(current));
  const result = await core.writer.write((tx) => tx.packageBPresentation.recordResult({
    operationKey: operationKey('result', outboxId, claim.revision, claim.fenceToken),
    outboxId,
    claimOperationKey,
    expectedRevision: claim.revision,
    fenceToken: claim.fenceToken,
    leaseOwner: workerId,
    resultState: adapterResult?.resultState,
    evidenceRef: adapterResult?.evidenceRef,
    evidenceHashToken: adapterResult?.evidenceHashToken,
    errorClass: adapterResult?.errorClass ?? null,
    recordedAt,
  }));
  if (!result) throw coreError('CORE_B2_RESULT_NOT_COMMITTED', 'Package B.2 effect result was not committed');
  return Object.freeze({
    final,
    delivery: Object.freeze({ disposition: result.disposition, state: adapterResult.resultState,
      effectAttempted: true, outboxId, receiptId: result.resultId }),
  });
}
