import { CORE_CUTOVER_EVENT_ID } from './coreCutover.mjs';
import { coreError } from './coreErrors.mjs';

function positiveTodoId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw coreError('CORE_REMINDER_TODO_ID_INVALID', 'reminder todo id must be a positive integer');
  }
  return id;
}

function reminderTimes(value, now) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime()) || !date.toISOString().endsWith('.000Z')) {
    throw coreError('CORE_REMINDER_TIME_INVALID', 'reminder time must be a whole-second instant');
  }
  const floor = Math.floor(now().getTime() / 1_000) * 1_000;
  return Object.freeze({
    requested: date.toISOString(),
    scheduled: new Date(Math.max(date.getTime(), floor + 1_000)).toISOString(),
  });
}

export function createCoreReminderService({
  core,
  now = () => new Date(),
  conversationId = 'system-owner-conversation',
  bindingId = 'system-owner-binding',
} = {}) {
  if (!core?.writer?.write || !core?.reader?.conversationIdentityById) {
    throw coreError('CORE_REMINDER_DEPENDENCY_INVALID', 'Core reminder service requires an open Core runtime');
  }
  return Object.freeze({
    async register({ todoId, scheduledFor } = {}) {
      const id = positiveTodoId(todoId);
      const times = reminderTimes(scheduledFor, now);
      const identity = core.reader.conversationIdentityById(conversationId);
      const binding = identity && core.reader.packageBPresentation.binding({ identity, conversationId, bindingId });
      if (!identity || !binding || binding.state !== 'active') {
        throw coreError('CORE_REMINDER_BINDING_MISSING', 'Core reminder requires the active owner presentation binding');
      }
      const payloadRef = `legacy-todo:${id}`;
      const eventId = `core-reminder:todo:${id}:v1`;
      const sourceRef = JSON.stringify({ todoId: id, scheduledFor: times.requested });
      const outcome = await core.writer.write((tx) => {
        const prior = tx.journal.event(eventId);
        if (prior) {
          if (prior.event_type !== 'core_reminder_registered' || prior.source_kind !== 'core-reminder:v1'
            || prior.source_ref !== sourceRef || prior.conversation_id !== conversationId) {
            throw coreError('CORE_REMINDER_CONFLICT', 'todo reminder is already registered with different semantics');
          }
          return Object.freeze({ disposition: 'already_registered', todoId: id,
            scheduleSpecId: `todo-reminder-schedule:${id}` });
        }
        const activityId = `todo-reminder-activity:${id}`;
        tx.activities.create({
          activityId, ownerId: identity.ownerId, conversationId,
          title: 'Explicit owner reminder', goalRef: payloadRef, domain: 'personal',
          riskClass: 'reversible', autonomyLevel: 1, state: 'active', contractRevision: 0,
          resumePolicy: 'bounded_auto', reportPolicy: 'milestone', createdAt: now().toISOString(),
        });
        tx.journal.append({
          eventId, eventType: 'core_reminder_registered', ownerId: identity.ownerId,
          conversationId, activityId, actorRef: identity.ownerId, originRef: payloadRef,
          sourceKind: 'core-reminder:v1', sourceRef, revision: 1,
          causationId: CORE_CUTOVER_EVENT_ID, createdAt: now().toISOString(),
        });
        tx.schedules.create({
          scheduleSpecId: `todo-reminder-schedule:${id}`,
          scheduleSpecRevisionId: `todo-reminder-schedule:${id}:revision:1`,
          activityId, operationKey: `todo-reminder:create:${id}`,
          recurrence: { kind: 'one_shot', at: times.scheduled }, taskKind: 'scheduled_instruction', payloadRef,
          catchUpPolicy: 'latest', activityContractRevision: 0, causationId: eventId,
          conversationId, presentationBindingId: bindingId,
          expectedBindingRevision: Number(binding.revision),
        });
        return Object.freeze({ disposition: 'registered', todoId: id,
          scheduleSpecId: `todo-reminder-schedule:${id}` });
      });
      const schedule = core.reader.scheduleSpec(outcome.scheduleSpecId);
      return Object.freeze({ ...outcome, scheduledFor: schedule?.next_due_at ?? null });
    },
  });
}
