import { createHash } from 'node:crypto';

import { coreError } from './coreErrors.mjs';

const PAYLOAD = /^external-mcp-task:v2:([A-Za-z0-9_-]{1,480})$/;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,180}$/;

function key(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

export function parseExternalMcpTaskRef(value) {
  const match = String(value || '').match(PAYLOAD);
  if (!match) return null;
  try {
    const decoded = JSON.parse(
      Buffer.from(match[1], 'base64url').toString('utf8'),
    );
    if (!Array.isArray(decoded) || decoded.length !== 4) return null;
    const [activityId, revision, checkpointDigest, factEventId] = decoded;
    if (!SAFE_ID.test(activityId) || !Number.isSafeInteger(revision) || revision < 0
      || typeof checkpointDigest !== 'string' || checkpointDigest.length < 1 || checkpointDigest.length > 240
      || !SAFE_ID.test(factEventId)) return null;
    return Object.freeze({ activityId, revision, checkpointDigest, factEventId });
  } catch { return null; }
}

export function formatExternalMcpTaskRef({ activityId, revision, checkpointDigest, factEventId } = {}) {
  const encoded = Buffer.from(JSON.stringify([activityId, revision, checkpointDigest, factEventId]), 'utf8')
    .toString('base64url');
  const payloadRef = `external-mcp-task:v2:${encoded}`;
  if (!parseExternalMcpTaskRef(payloadRef) || payloadRef.length > 512) {
    throw coreError('CORE_EXTERNAL_NOTIFICATION_INPUT_INVALID', 'external notification payload is invalid');
  }
  return payloadRef;
}

export function createCoreExternalNotificationService({
  core, now = () => new Date(), conversationId = 'system-owner-conversation', bindingId = 'system-owner-binding',
} = {}) {
  if (!core?.writer?.write || !core?.reader?.conversationIdentityById) {
    throw coreError('CORE_EXTERNAL_NOTIFICATION_DEPENDENCY_INVALID', 'external notification requires an open Core runtime');
  }
  return Object.freeze({
    async register({ payloadRef, causationId } = {}) {
      const parsed = parseExternalMcpTaskRef(payloadRef);
      if (!parsed) throw coreError('CORE_EXTERNAL_NOTIFICATION_INPUT_INVALID', 'external notification payload is invalid');
      const fact = core.reader.journalEvent(causationId);
      const factPayload = core.reader.journalPayloadForEvent?.(causationId);
      const projection = core.reader.externalPollProjectionForFact?.(causationId);
      if (parsed.factEventId !== causationId || fact?.event_type !== 'external_poll_fact_observed'
        || fact.invalidated_at !== null
        || factPayload?.payload_ref !== `external-mcp:/activity/${parsed.activityId}/revision/${parsed.revision}`
        || projection?.payload_ref !== payloadRef) {
        throw coreError('CORE_EXTERNAL_NOTIFICATION_CAUSATION_INVALID', 'external notification requires its Core fact');
      }
      const identity = core.reader.conversationIdentityById(conversationId);
      const binding = identity && core.reader.packageBPresentation.binding({ identity, conversationId, bindingId });
      if (!identity || !binding || binding.state !== 'active') {
        throw coreError('CORE_EXTERNAL_NOTIFICATION_BINDING_MISSING', 'external notification requires the active owner binding');
      }
      const stable = key(payloadRef);
      const eventId = `core-external-notification:${stable}`;
      const scheduledFor = new Date(Math.floor(now().getTime() / 1_000) * 1_000 + 1_000).toISOString();
      const outcome = await core.writer.write((tx) => {
        const prior = tx.journal.event(eventId);
        if (prior) {
          if (prior.source_ref !== payloadRef || prior.conversation_id !== conversationId
            || prior.causation_id !== causationId) {
            throw coreError('CORE_EXTERNAL_NOTIFICATION_CONFLICT', 'external notification identity has different semantics');
          }
          return Object.freeze({ disposition: 'already_registered', scheduleSpecId: `external-notification-schedule:${stable}` });
        }
        const activityId = `external-notification-activity:${stable}`;
        tx.activities.create({
          activityId, ownerId: identity.ownerId, conversationId, title: 'External MCP notification decision',
          goalRef: payloadRef, domain: 'personal', riskClass: 'reversible', autonomyLevel: 1,
          state: 'active', contractRevision: 0, resumePolicy: 'bounded_auto',
          reportPolicy: 'milestone', createdAt: now().toISOString(),
        });
        tx.journal.append({
          eventId, eventType: 'core_external_notification_registered', ownerId: identity.ownerId,
          conversationId, activityId, actorRef: identity.ownerId, originRef: payloadRef,
          sourceKind: 'core-external-notification:v1', sourceRef: payloadRef, revision: 1,
          causationId, createdAt: now().toISOString(),
        });
        tx.schedules.create({
          scheduleSpecId: `external-notification-schedule:${stable}`,
          scheduleSpecRevisionId: `external-notification-schedule:${stable}:revision:1`,
          activityId, operationKey: `external-notification:create:${stable}`,
          recurrence: { kind: 'one_shot', at: scheduledFor }, taskKind: 'scheduled_instruction', payloadRef,
          catchUpPolicy: 'latest', activityContractRevision: 0, causationId: eventId,
          conversationId, presentationBindingId: bindingId,
          expectedBindingRevision: Number(binding.revision),
        });
        return Object.freeze({ disposition: 'registered', scheduleSpecId: `external-notification-schedule:${stable}` });
      });
      return Object.freeze({ ...outcome, scheduledFor: core.reader.scheduleSpec(outcome.scheduleSpecId)?.next_due_at ?? null });
    },
  });
}
