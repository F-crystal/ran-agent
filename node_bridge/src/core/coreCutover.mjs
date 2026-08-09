import { createHash } from 'node:crypto';

import { coreError } from './coreErrors.mjs';

export const CORE_CUTOVER_EVENT_ID = 'core-cutover:v1';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;

function requireText(value, code, message) {
  const normalized = String(value || '').trim();
  if (!normalized) throw coreError(code, message);
  return normalized;
}

function wholeSecond(value, field) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime()) || !date.toISOString().endsWith('.000Z')) {
    throw coreError('CORE_CUTOVER_TIME_INVALID', `${field} must be a whole-second instant`);
  }
  return date.toISOString();
}

export function validateCoreCutoverInput(input = {}) {
  const candidateSha = requireText(input.candidateSha,
    'CORE_CUTOVER_SHA_REQUIRED', 'candidate SHA is required');
  if (!GIT_SHA.test(candidateSha)) {
    throw coreError('CORE_CUTOVER_SEMANTICS_INVALID', 'cutover source or no-resend semantics are invalid');
  }
  return Object.freeze({
    candidateSha,
    committedAt: wholeSecond(input.committedAt, 'cutover commit time'),
  });
}

function semanticRecord(input) {
  const validated = validateCoreCutoverInput(input);
  const record = Object.freeze({
    schemaVersion: 1,
    watermark: wholeSecond(input.watermark, 'cutover watermark'),
    candidateSha: validated.candidateSha,
    migrationSnapshotDigest: requireText(input.migrationSnapshotDigest,
      'CORE_CUTOVER_SNAPSHOT_REQUIRED', 'migration snapshot digest is required'),
    scheduleManifestDigest: requireText(input.scheduleManifestDigest,
      'CORE_CUTOVER_MANIFEST_REQUIRED', 'schedule manifest digest is required'),
    ambiguousOutboxDisposition: input.ambiguousOutboxDisposition,
    pendingOutboundDisposition: input.pendingOutboundDisposition,
  });
  if (!SHA256.test(record.migrationSnapshotDigest)
    || !SHA256.test(record.scheduleManifestDigest)
    || record.ambiguousOutboxDisposition !== 'terminal_no_resend'
    || record.pendingOutboundDisposition !== 'suppress') {
    throw coreError('CORE_CUTOVER_SEMANTICS_INVALID', 'cutover source or no-resend semantics are invalid');
  }
  return JSON.stringify(record);
}

function result(event, disposition) {
  return Object.freeze({
    disposition,
    eventId: event.journal_event_id,
    committedAt: event.created_at,
    candidateSha: event.correlation_id,
    semanticDigest: `sha256:${createHash('sha256').update(event.source_ref).digest('hex')}`,
  });
}

export function isCoreCutoverCommitted(core) {
  const event = core?.reader?.journalEvent?.(CORE_CUTOVER_EVENT_ID);
  return Boolean(event?.event_type === 'core_cutover_committed_at'
    && event.source_kind === 'core-cutover:v1');
}

export function assertCoreCutoverCommitted(core) {
  if (!isCoreCutoverCommitted(core)) {
    throw coreError('CORE_CUTOVER_NOT_COMMITTED', 'Core production authority is not committed');
  }
}

export function commitCoreCutover({ core, input, apply } = {}) {
  if (!core?.writer?.write || typeof apply !== 'function') {
    throw coreError('CORE_CUTOVER_DEPENDENCY_INVALID', 'Core writer and synchronous cutover apply callback are required');
  }
  const ownerId = requireText(input?.ownerId, 'CORE_CUTOVER_OWNER_REQUIRED', 'cutover owner is required');
  const authorizationRef = requireText(input?.authorizationRef,
    'CORE_CUTOVER_AUTHORIZATION_REQUIRED', 'explicit production authorization reference is required');
  const { committedAt } = validateCoreCutoverInput(input);
  const sourceRef = semanticRecord(input);

  return core.writer.write((tx) => {
    const prior = tx.journal.event(CORE_CUTOVER_EVENT_ID);
    if (prior) {
      if (prior.event_type !== 'core_cutover_committed_at'
        || prior.owner_id !== ownerId || prior.actor_ref !== ownerId
        || prior.origin_ref !== authorizationRef || prior.source_kind !== 'core-cutover:v1'
        || prior.source_ref !== sourceRef || prior.correlation_id !== input.candidateSha
        || prior.created_at !== committedAt) {
        throw coreError('CORE_CUTOVER_CONFLICT', 'Core cutover was already committed with different authority');
      }
      return result(prior, 'already_applied');
    }
    const event = tx.journal.append({
      eventId: CORE_CUTOVER_EVENT_ID,
      eventType: 'core_cutover_committed_at',
      ownerId,
      actorRef: ownerId,
      originRef: authorizationRef,
      sourceKind: 'core-cutover:v1',
      sourceRef,
      revision: 1,
      correlationId: input.candidateSha,
      createdAt: committedAt,
    });
    const applied = apply(tx);
    if (applied && typeof applied.then === 'function') {
      throw coreError('CORE_CUTOVER_ASYNC_FORBIDDEN', 'Core cutover apply callback must be synchronous');
    }
    return result(event, 'applied');
  });
}
