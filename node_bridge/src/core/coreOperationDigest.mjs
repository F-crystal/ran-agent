import { createHash } from 'node:crypto';

import { coreError } from './coreErrors.mjs';

export const OPERATION_SEMANTIC_DIGEST_VERSION = 1;

const DIGEST_PATTERN = /^sha256:v1:[0-9a-f]{64}$/;

function canonicalField(name, value) {
  if (value === undefined) {
    throw coreError('CORE_OPERATION_SEMANTICS_INVALID', `${name} is required for operation identity`);
  }
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw coreError('CORE_OPERATION_SEMANTICS_INVALID', `${name} must be a safe integer`);
  }
  if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) {
    throw coreError('CORE_OPERATION_SEMANTICS_INVALID', `${name} must be a canonical scalar`);
  }
  return [name, value];
}

function digest(fields) {
  const canonical = JSON.stringify([
    ['operation_schema_version', OPERATION_SEMANTIC_DIGEST_VERSION],
    ...fields,
  ]);
  return assertOperationSemanticDigest(
    `sha256:v1:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`,
  );
}

export function workRunFenceOperationDigest(input) {
  return digest([
    canonicalField('operation_kind', 'rotate_fence'),
    canonicalField('domain', 'work_run'),
    canonicalField('work_run_id', input.workRunId),
    canonicalField('expected_revision', input.expectedRevision),
    canonicalField('expected_fence', input.expectedFence),
    canonicalField('next_revision', input.expectedRevision + 1),
    canonicalField('next_fence', input.nextFence),
    canonicalField('next_state', input.nextState),
    canonicalField('reason_code', input.reasonCode),
    canonicalField('causation_id', input.sourceEventId),
    canonicalField('operation_key', input.rotationOperationKey),
  ]);
}

export function projectorClaimOperationDigest(input, { cursor, outbox }) {
  return digest([
    canonicalField('operation_kind', 'claim_projection'),
    canonicalField('domain', 'projector_cursor'),
    canonicalField('projector_cursor_id', input.cursorId),
    canonicalField('projector_id', cursor.projector_id),
    canonicalField('target_scope', cursor.target_scope),
    canonicalField('projection_outbox_id', input.outboxId),
    canonicalField('source_sequence', Number(outbox.source_sequence)),
    canonicalField('source_event_id', outbox.source_event_id),
    canonicalField('source_entity_type', outbox.source_entity_type),
    canonicalField('source_entity_id', outbox.source_entity_id),
    canonicalField('source_revision', Number(outbox.source_revision)),
    canonicalField('expected_cursor_revision', input.expectedCursorRevision),
    canonicalField('expected_cursor_fence', input.expectedCursorFence),
    canonicalField('next_cursor_fence', input.expectedCursorFence + 1),
    canonicalField('expected_outbox_revision', input.expectedOutboxRevision),
    canonicalField('next_outbox_revision', input.expectedOutboxRevision + 1),
    canonicalField('operation_key', input.rotationOperationKey),
    canonicalField('lease_owner', input.leaseOwner),
    canonicalField('lease_until', input.leaseUntil),
  ]);
}

export function assertOperationSemanticDigest(value) {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw coreError('CORE_OPERATION_DIGEST_INVALID', 'operation semantic digest is invalid');
  }
  return value;
}
