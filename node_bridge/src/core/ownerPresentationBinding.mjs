import { coreError } from './coreErrors.mjs';

const ACTIVE_PLATFORMS = new Set(['wechat']);
const DESTINATION_KINDS = new Set(['user', 'conversation']);

export function resolveActiveOwnerPresentationBinding(core, {
  operationKey = 'core-cutover:system-owner-binding',
  expectedRevision,
} = {}) {
  if (!core?.reader?.packageBPresentation?.bindingsByOperation) {
    throw coreError('CORE_PRESENTATION_BINDING_DEPENDENCY_INVALID', 'Core presentation binding reader is required');
  }
  const routes = core.reader.packageBPresentation.bindingsByOperation(operationKey);
  if (!Array.isArray(routes) || routes.length !== 1) {
    throw coreError('CORE_PRESENTATION_BINDING_AMBIGUOUS', 'exactly one owner presentation binding is required');
  }
  const active = assertActiveOwnerPresentationBinding(core, routes[0]);
  if (expectedRevision !== undefined && Number(active.revision) !== Number(expectedRevision)) {
    throw coreError('CORE_PRESENTATION_BINDING_STALE', 'presentation binding revision is stale');
  }
  return active;
}

export function resolveConversationPresentationBinding(core, {
  identity, conversationId, bindingId, expectedRevision,
} = {}) {
  const committed = resolveActiveOwnerPresentationBinding(core, { expectedRevision });
  const binding = core?.reader?.packageBPresentation?.binding?.({ identity, conversationId, bindingId });
  if (!binding) throw coreError('CORE_PRESENTATION_BINDING_MISSING', 'presentation binding is missing');
  const active = assertActiveOwnerPresentationBinding(core, {
    ...binding,
    receipt_owner_id: committed.receipt_owner_id,
  });
  if (committed.presentation_binding_id !== active.presentation_binding_id
    || committed.conversation_id !== active.conversation_id
    || committed.platform !== active.platform
    || committed.destination_kind !== active.destination_kind
    || committed.destination_ref !== active.destination_ref
    || Number(committed.revision) !== Number(active.revision)) {
    throw coreError('CORE_PRESENTATION_BINDING_NOT_GLOBAL', 'delivery binding is not the committed owner binding');
  }
  return committed;
}

export function assertActiveOwnerPresentationBinding(core, binding) {
  if (!binding || binding.state !== 'active') {
    throw coreError('CORE_PRESENTATION_BINDING_INACTIVE', 'presentation binding is inactive');
  }
  if (!ACTIVE_PLATFORMS.has(String(binding.platform || '').trim().toLowerCase())) {
    throw coreError('CORE_PRESENTATION_BINDING_UNSUPPORTED', 'presentation binding platform is unsupported');
  }
  if (!DESTINATION_KINDS.has(String(binding.destination_kind || '').trim())
    || !binding.presentation_binding_id || !binding.conversation_id || !binding.destination_ref
    || !binding.source_instance_id || !binding.receipt_owner_id
    || !Number.isSafeInteger(Number(binding.revision))) {
    throw coreError('CORE_PRESENTATION_BINDING_INVALID', 'presentation binding is incomplete');
  }
  const identity = core?.reader?.conversationIdentityById?.(binding.conversation_id);
  if (!identity?.ownerId || identity.ownerId !== binding.receipt_owner_id) {
    throw coreError('CORE_PRESENTATION_BINDING_FOREIGN_OWNER', 'presentation binding owner is not the Core owner');
  }
  return Object.freeze({
    ...binding,
    platform: String(binding.platform).trim().toLowerCase(),
    revision: Number(binding.revision),
  });
}

export function presentationTarget(binding) {
  const destination = String(binding?.destination_ref || '').trim();
  if (!destination) throw coreError('CORE_PRESENTATION_BINDING_TARGET_MISSING', 'presentation binding destination is missing');
  if (binding.destination_kind === 'conversation') {
    return { platform: binding.platform, channel_type: 'group', conversation_id: destination, sender_id: destination };
  }
  return { platform: binding.platform, channel_type: 'dm', conversation_id: destination, sender_id: destination };
}
