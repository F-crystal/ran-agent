import { createHash } from 'node:crypto';

import { CORE_CUTOVER_EVENT_ID } from './coreCutover.mjs';
import { coreError } from './coreErrors.mjs';

function stableId(kind, sourceRef) {
  return `${kind}:v1:${createHash('sha256').update(sourceRef).digest('hex')}`;
}

function wholeSecond(value, field) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime()) || !date.toISOString().endsWith('.000Z')) {
    throw coreError('CORE_CUTOVER_MIGRATION_TIME_INVALID', `${field} must be a whole-second instant`);
  }
  return date.toISOString();
}

function createPausedActivity(tx, { sourceRef, ownerId, title, createdAt }) {
  const activityId = stableId('legacy-candidate', sourceRef);
  tx.activities.create({
    activityId, ownerId, title, goalRef: sourceRef, domain: 'personal',
    riskClass: 'reversible', autonomyLevel: 0, state: 'paused', contractRevision: 0,
    resumePolicy: 'manual', reportPolicy: 'milestone', createdAt,
  });
  return activityId;
}

function appendSuppression(tx, { kind, count, sourceDigest, createdAt }) {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw coreError('CORE_CUTOVER_MIGRATION_COUNT_INVALID', 'suppression count is invalid');
  }
  if (count === 0) return null;
  return tx.journal.append({
    eventId: `core-cutover:suppression:${kind}:v1`,
    eventType: 'legacy_delivery_suppressed',
    originRef: 'core-cutover',
    sourceKind: `legacy-${kind}`,
    sourceRef: JSON.stringify({ count, sourceDigest: sourceDigest ?? null }),
    revision: 1,
    causationId: CORE_CUTOVER_EVENT_ID,
    createdAt,
  });
}

export function applyCoreScheduleCutover(tx, { snapshot, ownerId, createdAt } = {}) {
  if (!snapshot?.staged || !snapshot?.counts || !snapshot?.sourceDigests) {
    throw coreError('CORE_CUTOVER_MIGRATION_SNAPSHOT_INVALID', 'fresh migration snapshot is required');
  }
  const at = wholeSecond(createdAt, 'migration creation time');
  let activities = 0;
  let reminderSchedules = 0;
  for (const item of snapshot.staged.reminders || []) {
    const scheduledFor = wholeSecond(item.scheduledFor, 'future reminder time');
    if (item.state !== 'paused' || Date.parse(scheduledFor) <= Date.parse(at)) {
      throw coreError('CORE_CUTOVER_REMINDER_NOT_FUTURE', 'imported reminder must remain paused and future');
    }
    const activityId = createPausedActivity(tx, {
      sourceRef: item.sourceRef, ownerId, title: 'Imported reminder candidate', createdAt: at,
    });
    const scheduleId = stableId('legacy-reminder-schedule', item.sourceRef);
    tx.schedules.create({
      scheduleSpecId: scheduleId,
      scheduleSpecRevisionId: `${scheduleId}:revision:1`,
      activityId,
      operationKey: stableId('legacy-reminder-import', item.sourceRef),
      recurrence: { kind: 'one_shot', at: scheduledFor },
      taskKind: 'system_maintenance',
      payloadRef: item.sourceRef,
      catchUpPolicy: 'latest',
      activityContractRevision: 0,
      causationId: CORE_CUTOVER_EVENT_ID,
    });
    activities += 1;
    reminderSchedules += 1;
  }
  for (const item of [...(snapshot.staged.externalWatches || []), ...(snapshot.staged.externalActivities || [])]) {
    if (item.state !== 'paused') {
      throw coreError('CORE_CUTOVER_CANDIDATE_NOT_PAUSED', 'external migration candidate must be paused');
    }
    createPausedActivity(tx, {
      sourceRef: item.sourceRef, ownerId, title: 'Imported external MCP candidate', createdAt: at,
    });
    activities += 1;
  }

  appendSuppression(tx, {
    kind: 'historical-reminders', count: snapshot.counts.historicalReminders,
    sourceDigest: snapshot.sourceDigests.legacyDatabase, createdAt: at,
  });
  appendSuppression(tx, {
    kind: 'ambiguous-outbox', count: snapshot.counts.outboxStates?.ambiguous || 0,
    sourceDigest: snapshot.sourceDigests.legacyOutbox, createdAt: at,
  });
  appendSuppression(tx, {
    kind: 'sending-outbox', count: snapshot.counts.outboxStates?.sending || 0,
    sourceDigest: snapshot.sourceDigests.legacyOutbox, createdAt: at,
  });
  appendSuppression(tx, {
    kind: 'pending-outbound', count: snapshot.counts.pendingOutboundMessages,
    sourceDigest: snapshot.sourceDigests.pendingOutbound, createdAt: at,
  });
  return Object.freeze({ activities, reminderSchedules });
}
