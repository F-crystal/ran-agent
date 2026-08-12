import { createHash } from 'node:crypto';

import { assertCoreCutoverCommitted, CORE_CUTOVER_EVENT_ID } from './coreCutover.mjs';
import { coreError } from './coreErrors.mjs';

function stableId(transactionId) {
  return createHash('sha256').update(transactionId).digest('hex').slice(0, 32);
}

function wholeSecond(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || !date.toISOString().endsWith('.000Z')) {
    throw coreError('S12_ACCEPTANCE_TIME_INVALID', 'S12 acceptance time must use whole-second precision');
  }
  return date.toISOString();
}

function authority(core, input) {
  assertCoreCutoverCommitted(core);
  const marker = core.reader.journalEvent(CORE_CUTOVER_EVENT_ID);
  let semantics;
  try { semantics = JSON.parse(marker.source_ref); } catch { semantics = null; }
  if (marker.owner_id !== input.ownerId || marker.origin_ref !== input.authorizationRef
    || marker.correlation_id !== input.candidateSha || marker.created_at !== input.committedAt
    || semantics?.visibleBindingDigest !== input.visibleBindingSha256) {
    throw coreError('S12_ACCEPTANCE_AUTHORITY_MISMATCH', 'S12 acceptance differs from Core cutover authority');
  }
  return marker;
}

function systemOwnerBinding(core, ownerId) {
  const matches = core.reader.packageBPresentation.bindingsByOperation('core-cutover:system-owner-binding');
  if (matches.length !== 1 || matches[0].receipt_owner_id !== ownerId || matches[0].state !== 'active'
    || matches[0].platform !== 'feishu' || !['user', 'conversation'].includes(matches[0].destination_kind)
    || typeof matches[0].destination_ref !== 'string' || !matches[0].destination_ref) {
    throw coreError('S12_ACCEPTANCE_BINDING_INVALID', 'S12 acceptance requires the committed cutover owner binding');
  }
  const route = matches[0];
  const identity = core.reader.conversationIdentityById(route.conversation_id);
  const binding = identity && core.reader.packageBPresentation.binding({
    identity, conversationId: route.conversation_id, bindingId: route.presentation_binding_id,
  });
  if (!identity || identity.ownerId !== ownerId || !binding) {
    throw coreError('S12_ACCEPTANCE_BINDING_INVALID', 'S12 acceptance requires the committed cutover owner binding');
  }
  return Object.freeze({ identity, binding });
}

export async function registerS12Acceptance({ core, input } = {}) {
  if (!core?.writer?.write || !input || typeof input.transactionId !== 'string' || !input.transactionId) {
    throw coreError('S12_ACCEPTANCE_INPUT_INVALID', 'S12 acceptance input is invalid');
  }
  authority(core, input);
  const { identity, binding } = systemOwnerBinding(core, input.ownerId);
  const conversationId = identity.conversationId;
  const bindingId = binding.presentation_binding_id;
  const stable = stableId(input.transactionId);
  const eventId = `s12-acceptance:${stable}`;
  const activityId = `s12-acceptance-activity:${stable}`;
  const scheduleSpecId = `s12-acceptance-schedule:${stable}`;
  const scheduledAt = wholeSecond(input.scheduledAt);
  const payloadRef = `s12-acceptance:${stable}`;
  const sourceRef = JSON.stringify({
    schemaVersion: 1,
    transactionId: input.transactionId,
    candidateSha: input.candidateSha,
    authorizationRef: input.authorizationRef,
    scheduledAt,
  });
  const result = await core.writer.write((tx) => {
    const prior = tx.journal.event(eventId);
    if (prior) {
      let recorded;
      try { recorded = JSON.parse(prior.source_ref); } catch { recorded = null; }
      if (prior.owner_id !== input.ownerId || prior.conversation_id !== conversationId
        || prior.origin_ref !== input.authorizationRef || prior.correlation_id !== input.transactionId
        || recorded?.schemaVersion !== 1 || recorded.transactionId !== input.transactionId
        || recorded.candidateSha !== input.candidateSha
        || recorded.authorizationRef !== input.authorizationRef) {
        throw coreError('S12_ACCEPTANCE_REPLAY_CONFLICT', 'S12 acceptance replay has different semantics');
      }
      return { disposition: 'already_registered' };
    }
    tx.activities.create({
      activityId, ownerId: input.ownerId, conversationId,
      title: 'S12 Core cutover acceptance', goalRef: payloadRef, domain: 'personal',
      riskClass: 'reversible', autonomyLevel: 1, state: 'active', contractRevision: 0,
      resumePolicy: 'bounded_auto', reportPolicy: 'milestone', createdAt: scheduledAt,
    });
    tx.journal.append({
      eventId, eventType: 's12_acceptance_registered', ownerId: input.ownerId,
      conversationId, activityId, actorRef: input.ownerId,
      originRef: input.authorizationRef, sourceKind: 's12-acceptance:v1', sourceRef,
      revision: 1, causationId: CORE_CUTOVER_EVENT_ID,
      correlationId: input.transactionId, createdAt: scheduledAt,
    });
    tx.schedules.create({
      scheduleSpecId, scheduleSpecRevisionId: `${scheduleSpecId}:revision:1`, activityId,
      operationKey: `s12-acceptance:create:${stable}`,
      recurrence: { kind: 'one_shot', at: scheduledAt }, taskKind: 'scheduled_instruction',
      payloadRef, catchUpPolicy: 'latest', activityContractRevision: 0,
      causationId: eventId, conversationId,
      presentationBindingId: bindingId, expectedBindingRevision: Number(binding.revision),
    });
    return { disposition: 'registered' };
  });
  if (!core.reader.scheduleSpec(scheduleSpecId)) {
    throw coreError('S12_ACCEPTANCE_RECEIPT_MISSING', 'S12 acceptance schedule is missing after registration');
  }
  return Object.freeze({ ...result, eventId, scheduleSpecId, payloadRef });
}

export function inspectS12Acceptance({ core, transactionId, candidateSha, ownerId, authorizationRef,
  visibleBindingSha256, committedAt } = {}) {
  authority(core, { candidateSha, ownerId, authorizationRef, visibleBindingSha256, committedAt });
  const stable = stableId(transactionId);
  const eventId = `s12-acceptance:${stable}`;
  const scheduleSpecId = `s12-acceptance-schedule:${stable}`;
  const event = core.reader.journalEvent(eventId);
  if (!event) return Object.freeze({ status: 'NOT_CREATED', eventId, scheduleSpecId });
  if (event.correlation_id !== transactionId || event.owner_id !== ownerId
    || event.origin_ref !== authorizationRef || event.source_kind !== 's12-acceptance:v1') {
    throw coreError('S12_ACCEPTANCE_REPLAY_CONFLICT', 'S12 acceptance receipt has different authority');
  }
  let recorded;
  try { recorded = JSON.parse(event.source_ref); } catch { recorded = null; }
  if (recorded?.schemaVersion !== 1 || recorded.transactionId !== transactionId
    || recorded.candidateSha !== candidateSha || recorded.authorizationRef !== authorizationRef) {
    throw coreError('S12_ACCEPTANCE_REPLAY_CONFLICT', 'S12 acceptance receipt semantics are invalid');
  }
  const occurrences = core.reader.wakeOccurrences(scheduleSpecId);
  if (occurrences.length > 1) throw coreError('S12_ACCEPTANCE_DUPLICATE_WORK', 'S12 acceptance created multiple occurrences');
  const runs = occurrences.flatMap((occurrence) => core.reader.workRunsForOccurrence(occurrence.wake_occurrence_id));
  if (runs.length === 0) return Object.freeze({ status: 'ENQUEUED', eventId, scheduleSpecId });
  if (runs.length !== 1) throw coreError('S12_ACCEPTANCE_DUPLICATE_WORK', 'S12 acceptance created multiple Work Runs');
  const work = runs[0];
  const outboxId = `outbox:scheduled:${stableId(work.work_run_id)}`;
  const outbox = core.reader.presentationOutboxById(outboxId);
  if (!outbox) {
    return Object.freeze({ status: ['failed', 'cancelled'].includes(work.state) ? 'FORWARD_RECOVERY_REQUIRED' : 'ENQUEUED',
      eventId, scheduleSpecId, workRunId: work.work_run_id });
  }
  const terminal = ['sent', 'failed', 'ambiguous', 'cancelled'].includes(outbox.state);
  const receipt = terminal ? core.reader.presentationResultForOutbox(outboxId) : null;
  if (outbox.state === 'sent' && work.state === 'completed' && receipt?.source_kind === 'package_b_presentation_result:sent') {
    return Object.freeze({ status: 'TERMINAL_RECEIPT', eventId, scheduleSpecId,
      workRunId: work.work_run_id, outboxId, receiptId: receipt.journal_event_id });
  }
  if (outbox.state === 'sent' && work.state !== 'completed' && receipt?.source_kind === 'package_b_presentation_result:sent') {
    return Object.freeze({ status: 'ENQUEUED', eventId, scheduleSpecId,
      workRunId: work.work_run_id, outboxId, deliveryState: outbox.state, receiptId: receipt.journal_event_id });
  }
  return Object.freeze({ status: 'FORWARD_RECOVERY_REQUIRED', eventId, scheduleSpecId,
    workRunId: work.work_run_id, outboxId, deliveryState: outbox.state, receiptId: receipt?.journal_event_id ?? null });
}
