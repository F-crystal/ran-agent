import fs from 'node:fs';

import { CORE_CUTOVER_EVENT_ID } from './coreCutover.mjs';
import { coreError } from './coreErrors.mjs';

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/;
const PAYLOAD_REF = /^[A-Za-z0-9._:/-]{1,512}$/;
const TASK_KINDS = new Set(['scheduled_instruction', 'system_maintenance', 'external_poll']);

function wholeSecond(value, field) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime()) || !date.toISOString().endsWith('.000Z')) {
    throw coreError('CORE_SYSTEM_SCHEDULE_TIME_INVALID', `${field} must be a whole-second instant`);
  }
  return date.toISOString();
}

export function loadCoreSystemScheduleManifest(manifestPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest?.schemaVersion !== 1 || manifest?.status !== 'CURRENT'
    || typeof manifest.timeZone !== 'string' || !Array.isArray(manifest.schedules)
    || manifest.schedules.length === 0) {
    throw coreError('CORE_SYSTEM_SCHEDULE_MANIFEST_INVALID', 'system schedule manifest header is invalid');
  }
  const ids = new Set();
  for (const item of manifest.schedules) {
    const recurrence = item?.recurrence;
    const validRecurrence = recurrence?.kind === 'interval'
      ? Number.isSafeInteger(recurrence.everySeconds) && recurrence.everySeconds > 0
      : recurrence?.kind === 'daily' && TIME.test(recurrence.time);
    if (!ID.test(item?.id || '') || ids.has(item.id) || typeof item.source !== 'string'
      || !item.source || typeof item.title !== 'string' || !item.title
      || !TASK_KINDS.has(item.taskKind) || typeof item.visible !== 'boolean'
      || (item.payloadRef !== undefined && !PAYLOAD_REF.test(item.payloadRef))
      || item.visible !== (item.taskKind === 'scheduled_instruction') || !validRecurrence) {
      throw coreError('CORE_SYSTEM_SCHEDULE_MANIFEST_INVALID', 'system schedule entry is invalid');
    }
    ids.add(item.id);
  }
  return Object.freeze(manifest);
}

function recurrenceFor(item, watermark, timeZone) {
  if (item.recurrence.kind === 'daily') {
    return { kind: 'daily', time: item.recurrence.time, timeZone };
  }
  return {
    kind: 'interval', everySeconds: item.recurrence.everySeconds,
    anchorAt: new Date(Date.parse(watermark) + item.recurrence.everySeconds * 1_000).toISOString(),
  };
}

function requireBinding(input) {
  const fields = ['conversationId', 'canonicalConversationKey', 'actorRef', 'platform',
    'sourceInstanceId', 'platformConversationBinding', 'bindingId', 'destinationKind', 'destinationRef'];
  if (!input || fields.some((field) => typeof input[field] !== 'string' || !input[field].trim())) {
    throw coreError('CORE_SYSTEM_SCHEDULE_BINDING_REQUIRED', 'visible system schedules require one owner binding');
  }
  if (input.platform !== 'feishu' || !['user', 'conversation'].includes(input.destinationKind)) {
    throw coreError('CORE_SYSTEM_SCHEDULE_ROUTE_INVALID', 'visible system schedule route is unsupported');
  }
  return input;
}

export function validateCoreSystemScheduleBinding(manifest, input, { required = false } = {}) {
  return required || manifest.schedules.some((item) => item.visible) ? requireBinding(input) : null;
}

export function seedCoreSystemSchedules(tx, {
  manifest, ownerId, watermark, createdAt, visibleBinding,
} = {}) {
  const at = wholeSecond(createdAt, 'system schedule creation time');
  const boundary = wholeSecond(watermark, 'system schedule watermark');
  const visible = validateCoreSystemScheduleBinding(manifest, visibleBinding);
  if (visible) {
    tx.packageBTurn.createOrResolveConversation({
      conversationId: visible.conversationId,
      canonicalConversationKey: visible.canonicalConversationKey,
      ownerId,
      actorRef: visible.actorRef,
      platform: visible.platform,
      primaryFrontend: visible.platform,
      sourceInstanceId: visible.sourceInstanceId,
      platformConversationBinding: visible.platformConversationBinding,
      createdAt: at,
    });
    tx.packageBPresentation.createOrReadBinding({
      operationKey: 'core-cutover:system-owner-binding',
      bindingId: visible.bindingId,
      conversationId: visible.conversationId,
      ownerId,
      sourceInstanceId: visible.sourceInstanceId,
      platform: visible.platform,
      destinationKind: visible.destinationKind,
      destinationRef: visible.destinationRef,
      adapterMetadata: { protocol: 'core-system-schedule', receiptMode: 'typed', routeVersion: '1' },
      createdAt: at,
    });
  }
  for (const item of manifest.schedules) {
    const activityId = `system-activity:${item.id}`;
    tx.activities.create({
      activityId, ownerId, conversationId: item.visible ? visible.conversationId : null,
      title: item.title, goalRef: `system-task:${item.id}`, domain: 'personal',
      riskClass: 'reversible', autonomyLevel: 1, state: 'active', contractRevision: 0,
      resumePolicy: 'bounded_auto', reportPolicy: 'milestone', createdAt: at,
    });
    tx.schedules.create({
      scheduleSpecId: `system-schedule:${item.id}`,
      scheduleSpecRevisionId: `system-schedule-revision:${item.id}:1`,
      activityId,
      operationKey: `core-cutover:system-schedule:${item.id}`,
      recurrence: recurrenceFor(item, boundary, manifest.timeZone),
      taskKind: item.taskKind,
      payloadRef: item.payloadRef || `system-task:${item.id}`,
      catchUpPolicy: 'latest',
      activityContractRevision: 0,
      causationId: CORE_CUTOVER_EVENT_ID,
      conversationId: item.visible ? visible.conversationId : null,
      presentationBindingId: item.visible ? visible.bindingId : null,
      expectedBindingRevision: item.visible ? 0 : null,
    });
  }
  return Object.freeze({ schedules: manifest.schedules.length });
}
