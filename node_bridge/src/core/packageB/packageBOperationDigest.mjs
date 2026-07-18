import { createHash } from 'node:crypto';

import { coreError } from '../coreErrors.mjs';
import { assertOperationSemanticDigest } from '../coreOperationDigest.mjs';

function scalar(name, value) {
  if (value === undefined) {
    throw coreError('CORE_OPERATION_SEMANTICS_INVALID', `${name} is required for operation identity`);
  }
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw coreError('CORE_OPERATION_SEMANTICS_INVALID', `${name} must be a safe integer`);
  }
  if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) {
    throw coreError('CORE_OPERATION_SEMANTICS_INVALID', `${name} must be a canonical scalar`);
  }
  return value;
}

function fields(specification) {
  return specification.map(([name, value]) => [name, scalar(name, value)]);
}

function digest(schema, specification) {
  const canonical = JSON.stringify([
    ['operation_schema', schema],
    ...fields(specification),
  ]);
  return assertOperationSemanticDigest(
    `sha256:v1:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`,
  );
}

function presentationItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw coreError('CORE_OPERATION_SEMANTICS_INVALID', 'presentations must be a non-empty array');
  }
  return JSON.stringify(items.map((item, index) => fields([
    [`presentations[${index}].outbox_id`, item?.outboxId],
    [`presentations[${index}].operation_scope`, item?.operationScope],
    [`presentations[${index}].operation_key`, item?.operationKey],
    [`presentations[${index}].binding_id`, item?.bindingId],
    [`presentations[${index}].target`, item?.target],
    [`presentations[${index}].destination_kind`, item?.destinationKind],
    [`presentations[${index}].kind`, item?.kind],
    [`presentations[${index}].payload_ref`, item?.payloadRef],
    [`presentations[${index}].payload_hash_token`, item?.payloadHashToken],
    [`presentations[${index}].route_revision`, item?.routeRevision ?? null],
    [`presentations[${index}].route_source_instance_id`, item?.routeSourceInstanceId ?? null],
    [`presentations[${index}].route_platform`, item?.routePlatform ?? null],
    [`presentations[${index}].route_destination_ref`, item?.routeDestinationRef ?? null],
  ])));
}

export function conversationIdentityOperationDigest(input) {
  return digest('package-b-conversation-identity:v1', [
    ['canonical_conversation_key', input.canonicalConversationKey],
    ['conversation_id', input.conversationId],
    ['owner_id', input.ownerId],
    ['actor_ref', input.actorRef],
    ['platform', input.platform],
    ['source_instance_id', input.sourceInstanceId],
    ['platform_conversation_identity', input.platformConversationBinding],
    ['identity_revision', input.identityRevision ?? 1],
  ]);
}

export function presentationBindingOperationDigest(input) {
  return digest('package-b-presentation-binding:v1', [
    ['operation_key', input.operationKey],
    ['presentation_binding_id', input.bindingId],
    ['conversation_id', input.conversationId],
    ['owner_id', input.ownerId],
    ['source_instance_id', input.sourceInstanceId],
    ['platform', input.platform],
    ['destination_kind', input.destinationKind],
    ['destination_ref', input.destinationRef],
    ['adapter_metadata', input.adapterMetadataCanonical],
  ]);
}

export function foregroundExchangeOperationDigest(input) {
  return digest('package-b-foreground-exchange:v1', [
    ['operation_key', input.operationKey],
    ['conversation_id', input.conversationId],
    ['exchange_id', input.exchangeId ?? null],
    ['expected_conversation_revision', input.expectedConversationRevision],
  ]);
}

export function assemblyPartOperationDigest(input) {
  return digest('package-b-assembly-part:v1', [
    ['operation_key', input.operationKey],
    ['assembly_id', input.assemblyId],
    ['assembly_expected_revision', input.expectedAssemblyRevision],
    ['part_id', input.partId],
    ['part_kind', input.partKind],
    ['sequence_no', input.sequenceNo],
    ['payload_ref', input.payloadRef],
    ['payload_hash_token', input.payloadHashToken],
    ['anchor_ref', input.anchorRef ?? null],
    ['reference_ref', input.referenceRef ?? null],
    ['other_media_kind', input.otherMetadata?.mediaKind ?? null],
    ['other_mime_type', input.otherMetadata?.mimeType ?? null],
    ['other_size_bytes', input.otherMetadata?.sizeBytes ?? null],
    ['ingress_event_id', input.ingressEventId],
    ['source_revision', input.sourceRevision],
    ['disposition', input.disposition ?? 'active'],
  ]);
}

export function assemblyLifecycleOperationDigest(input) {
  return digest('package-b-assembly-lifecycle:v1', [
    ['operation_key', input.operationKey],
    ['operation_kind', input.operationKind],
    ['assembly_id', input.assemblyId],
    ['conversation_id', input.conversationId],
    ['expected_revision', input.expectedRevision],
    ['part_id', input.partId ?? null],
    ['next_quiet_deadline', input.quietDeadline ?? null],
    ['hard_deadline', input.hardDeadline ?? null],
    ['disposition', input.disposition ?? null],
  ]);
}

export function assemblyActivePartSetDigest({ assemblyId, assemblyRevision, parts }) {
  if (!Array.isArray(parts) || parts.length === 0) {
    throw coreError('CORE_ASSEMBLY_EMPTY', 'active assembly part set cannot be empty');
  }
  const ordered = [...parts].sort((left, right) => (
    Number(left.sequenceNo) - Number(right.sequenceNo)
    || String(left.ingressEventId).localeCompare(String(right.ingressEventId))
    || String(left.partId).localeCompare(String(right.partId))
  ));
  return digest('package-b-assembly-active-part-set:v1', [
    ['assembly_id', assemblyId],
    ['assembly_revision', assemblyRevision],
    ['parts', JSON.stringify(ordered.map((part, index) => fields([
      [`parts[${index}].sequence_no`, part.sequenceNo],
      [`parts[${index}].ingress_event_id`, part.ingressEventId],
      [`parts[${index}].part_id`, part.partId],
      [`parts[${index}].part_kind`, part.partKind],
      [`parts[${index}].payload_ref`, part.payloadRef],
      [`parts[${index}].payload_hash_token`, part.payloadHashToken],
      [`parts[${index}].anchor_ref`, part.anchorRef ?? null],
      [`parts[${index}].reference_ref`, part.referenceRef ?? null],
      [`parts[${index}].disposition`, part.disposition],
      [`parts[${index}].ingress_identity`, part.ingressIdentity],
      [`parts[${index}].part_semantic_digest`, part.partSemanticDigest],
    ])))],
  ]);
}

export function ingressOperationDigest(input) {
  return digest('package-b-ingress:v1', [
    ['platform', input.platform],
    ['source_instance_id', input.sourceInstanceId],
    ['native_event_id_trust', input.nativeEventIdTrust],
    ['native_event_id', input.nativeEventId],
    ['owner_id', input.ownerId],
    ['actor_ref', input.actorRef],
    ['platform_conversation_binding', input.platformConversationBinding],
    ['canonical_conversation_key', input.canonicalConversationKey],
    ['payload_ref', input.payloadRef],
    ['payload_hash_token', input.payloadHashToken],
    ['mutation_kind', input.mutationKind],
    ['mutation_target_native_event_id', input.mutationTargetNativeEventId],
    ['retry_of', input.retryOf],
    ['vendor_event_time', input.vendorEventTime ?? null],
  ]);
}

export function assemblySealOperationDigest(input) {
  return digest('package-b-assembly-seal:v1', [
    ['operation_key', input.operationKey],
    ['assembly_id', input.assemblyId],
    ['conversation_id', input.conversationId],
    ['expected_revision', input.expectedRevision],
    ['active_part_set_digest', input.activePartSetDigest],
    ['sealed_at', input.sealedAt],
  ]);
}

export function userTurnOperationDigest(input) {
  return digest('package-b-user-turn:v1', [
    ['operation_key', input.operationKey],
    ['conversation_id', input.conversationId],
    ['exchange_id', input.exchangeId],
    ['assembly_id', input.assemblyId],
    ['assembly_revision', input.assemblyRevision],
    ['semantic_turn_id', input.semanticTurnId],
    ['turn_revision_id', input.turnRevisionId],
    ['source_revision', input.sourceRevision],
    ['payload_ref', input.payloadRef],
    ['payload_hash_token', input.payloadHashToken],
    ['actor_ref', input.actorRef ?? null],
    ['change_kind', input.changeKind ?? null],
    ['supersedes_revision_id', input.supersedesRevisionId ?? null],
    ['source_event_id', input.sourceEventId ?? null],
  ]);
}

export function finalCommitOperationDigest(input) {
  return digest('package-b-final-commit:v1', [
    ['operation_key', input.operationKey],
    ['conversation_id', input.conversationId],
    ['exchange_id', input.exchangeId],
    ['source_turn_id', input.sourceTurnId],
    ['source_revision', input.sourceRevision],
    ['provider_epoch_id', input.providerEpochId],
    ['provider_attempt', input.providerAttempt],
    ['provider_attempt_receipt_id', input.providerAttemptReceiptId],
    ['assistant_turn_id', input.assistantTurnId],
    ['assistant_revision_id', input.assistantRevisionId],
    ['assistant_actor_ref', input.assistantActorRef ?? null],
    ['final_payload_ref', input.finalPayloadRef],
    ['final_payload_hash_token', input.finalPayloadHashToken],
    ['expected_exchange_revision', input.expectedExchangeRevision],
    ['expected_provider_epoch_revision', input.expectedProviderEpochRevision],
    ['presentations', presentationItems(input.presentations)],
  ]);
}

export function presentationClaimOperationDigest(input) {
  return digest('package-b-presentation-claim:v1', [
    ['operation_key', input.operationKey],
    ['worker_id', input.workerId],
    ['presentation_outbox_id', input.outboxId],
    ['assistant_turn_id', input.assistantTurnId],
    ['source_revision', input.sourceRevision],
    ['presentation_binding_id', input.bindingId],
    ['target', input.target],
    ['expected_revision', input.expectedRevision],
    ['expected_fence', input.expectedFence],
    ['lease_owner', input.leaseOwner],
    ['lease_until', input.leaseUntil],
    ['causation_event_id', input.causationEventId ?? null],
  ]);
}

export function presentationResultOperationDigest(input) {
  return digest('package-b-presentation-result:v1', [
    ['operation_key', input.operationKey],
    ['presentation_outbox_id', input.outboxId],
    ['claim_operation_key', input.claimOperationKey],
    ['fence_token', input.fenceToken],
    ['lease_owner', input.leaseOwner ?? null],
    ['result_state', input.resultState],
    ['evidence_ref', input.evidenceRef],
    ['evidence_hash_token', input.evidenceHashToken],
    ['error_class', input.errorClass],
  ]);
}

export function presentationDispatchStartOperationDigest(input) {
  return digest('package-b-presentation-dispatch-start:v1', [
    ['operation_key', input.operationKey],
    ['presentation_outbox_id', input.outboxId],
    ['claim_operation_key', input.claimOperationKey],
    ['claim_operation_digest', input.claimOperationDigest],
    ['expected_revision', input.expectedRevision],
    ['fence_token', input.fenceToken],
    ['lease_owner', input.leaseOwner],
  ]);
}

export function providerEpochOperationDigest(input) {
  return digest('package-b-provider-epoch:v1', [
    ['operation_key', input.operationKey],
    ['provider_epoch_id', input.providerEpochId],
    ['conversation_id', input.conversationId],
    ['exchange_id', input.exchangeId],
    ['source_turn_id', input.sourceTurnId],
    ['source_revision', input.sourceRevision],
    ['source_revision_id', input.sourceRevisionId],
    ['canonical_snapshot_ref', input.canonicalSnapshotRef],
    ['canonical_snapshot_hash_token', input.snapshotHashToken],
    ['canonical_cursor', input.committedEventCursor ?? null],
    ['provider', input.provider],
    ['model', input.model],
    ['capability_snapshot_ref', input.capabilitySnapshotRef],
    ['capability_snapshot_hash_token', input.capabilitySnapshotHashToken],
    ['soul_revision_id', input.soulRevisionId ?? null],
    ['upstream_binding_kind', input.upstreamBindingKind],
    ['upstream_handle_hash_token', input.upstreamHandleHashToken],
    ['epoch_state', input.epochState ?? 'active'],
    ['taint_state', input.taintState ?? 'clean'],
    ['request_identity', input.requestIdentity],
  ]);
}

export function providerEpochTransitionOperationDigest(input) {
  return digest('package-b-provider-epoch-transition:v1', [
    ['operation_key', input.operationKey],
    ['provider_epoch_id', input.providerEpochId],
    ['conversation_id', input.conversationId],
    ['exchange_id', input.exchangeId],
    ['expected_current_state', input.expectedCurrentState],
    ['expected_revision', input.expectedRevision],
    ['next_state', input.nextState],
    ['taint_state', input.taintState],
  ]);
}

export function providerAttemptOperationDigest(input) {
  return digest('package-b-provider-attempt:v1', [
    ['operation_key', input.operationKey],
    ['request_id', input.requestId],
    ['provider_epoch_id', input.epochId],
    ['conversation_id', input.conversationId ?? null],
    ['exchange_id', input.exchangeId ?? null],
    ['source_turn_id', input.sourceTurnId],
    ['source_revision', input.sourceRevision],
    ['provider', input.provider ?? null],
    ['model', input.model ?? null],
    ['capability_snapshot_ref', input.capabilitySnapshotRef ?? null],
    ['capability_snapshot_hash_token', input.capabilitySnapshotHashToken ?? null],
    ['attempt_number', input.attemptNumber],
    ['result_class', input.resultClass],
    ['error_class', input.errorClass],
    ['started_at', input.startedAt],
    ['completed_at', input.completedAt],
    ['snapshot_ref', input.snapshotRef],
    ['snapshot_hash_token', input.snapshotHashToken],
    ['metadata_ref', input.metadataRef],
    ['metadata_hash_token', input.metadataHashToken],
  ]);
}
