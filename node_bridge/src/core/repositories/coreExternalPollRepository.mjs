import { createHash } from 'node:crypto';

import { coreError } from '../coreErrors.mjs';
import { assertKeyedContentHashToken } from '../coreHashToken.mjs';
import { assertClaimedWorkRunAuthority } from '../coreScheduling.mjs';

const SAFE_ID = /^[A-Za-z0-9._:-]{1,160}$/;
const SAFE_REF = /^[A-Za-z0-9._:/-]{1,512}$/;
const FINGERPRINT = /^sha256:v1:[0-9a-f]{64}$/;
const AGGREGATE_POLL_REF = 'external-poll:external-mcp-runtime';
const PROJECTOR_ID = 'core-external-attention-v1';

function identifier(value, field) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw coreError('CORE_EXTERNAL_POLL_INPUT_INVALID', `${field} is invalid`);
  }
  return value;
}

function payloadReference(value) {
  if (typeof value !== 'string' || !SAFE_REF.test(value)) {
    throw coreError('CORE_EXTERNAL_POLL_INPUT_INVALID', 'payloadRef must be an opaque reference');
  }
  return value;
}

function deterministicId(prefix, workRunId, fingerprint) {
  return `${prefix}:v1:${createHash('sha256').update(`${workRunId}\0${fingerprint}`).digest('hex')}`;
}

function coreTimestamp(now) {
  const value = now();
  const milliseconds = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(milliseconds)) throw coreError('CORE_DB_CLOCK_INVALID', 'Core clock is invalid');
  return new Date(Math.floor(milliseconds / 1_000) * 1_000).toISOString();
}

export function createCoreExternalPollRepository({ get, run, now, projections }) {
  function ensureProjection(eventId, payloadRef, createdAt) {
    const stable = createHash('sha256').update(eventId).digest('hex').slice(0, 32);
    const targetScope = eventId;
    const cursorId = `cursor:external-attention:${stable}`;
    const outboxId = `projection:external-attention:${stable}`;
    projections.createCursor({ cursorId, projectorId: PROJECTOR_ID, targetScope, createdAt });
    const outbox = projections.reserve({
      outboxId, operationScope: `${PROJECTOR_ID}:${targetScope}`,
      operationKey: `external-attention:${stable}`, projectorId: PROJECTOR_ID, targetScope,
      sourceEventId: eventId, sourceRevision: 0, payloadRef, createdAt,
    });
    return Object.freeze({ cursorId, outboxId, outbox });
  }

  function assertAuthority(input) {
    let active;
    try {
      active = assertClaimedWorkRunAuthority(get, input.authority, coreTimestamp(now));
    } catch (error) {
      if (error?.code !== 'CORE_SCHEDULE_WORK_AUTHORITY_STALE') throw error;
      throw coreError('CORE_EXTERNAL_POLL_AUTHORITY_STALE', 'external poll Work Run authority is missing or stale');
    }
    const { authority, row } = active;
    const expectedPayloadRef = input.expectedPayloadRef === undefined
      ? null : payloadReference(input.expectedPayloadRef);
    const serverId = input.serverId === undefined ? null : identifier(input.serverId, 'serverId');
    const validPayload = expectedPayloadRef === null
      ? [AGGREGATE_POLL_REF, `external-poll:${serverId}`].includes(row.payload_ref)
      : row.payload_ref === expectedPayloadRef;
    if (row.task_kind !== 'external_poll' || !validPayload) {
      throw coreError('CORE_EXTERNAL_POLL_AUTHORITY_STALE', 'external poll Work Run authority is missing or stale');
    }
    return Object.freeze({
      ...authority,
      activityId: row.activity_id,
      ownerId: row.owner_id,
      causationId: row.causation_id,
      payloadRef: row.payload_ref,
    });
  }

  return Object.freeze({
    assertAuthority,
    recordFact(input) {
      const serverId = identifier(input.serverId, 'serverId');
      const authority = assertAuthority({ authority: input.authority, serverId });
      const workRunId = authority.workRunId;
      const sourceFingerprint = String(input.sourceFingerprint || '');
      if (!FINGERPRINT.test(sourceFingerprint)) {
        throw coreError('CORE_EXTERNAL_POLL_INPUT_INVALID', 'sourceFingerprint is invalid');
      }
      const payloadRef = payloadReference(input.payloadRef);
      const projectionPayloadRef = payloadReference(input.projectionPayloadRef);
      const contentHashToken = assertKeyedContentHashToken(input.contentHashToken);
      const eventId = deterministicId('external-poll-fact', workRunId, sourceFingerprint);
      const payloadId = deterministicId('external-poll-payload', workRunId, sourceFingerprint);
      const existing = get(`SELECT event.*,payload.payload_ref,payload.content_hash_token
        FROM journal_event event JOIN journal_payload payload
          ON payload.journal_event_id=event.journal_event_id
        WHERE event.journal_event_id=? AND payload.journal_payload_id=?`, eventId, payloadId);
      if (existing) {
        if (existing.source_ref !== sourceFingerprint || existing.actor_ref !== serverId
          || existing.payload_ref !== payloadRef || existing.content_hash_token !== contentHashToken) {
          throw coreError('CORE_OPERATION_KEY_CONFLICT', 'external poll fact identity has different semantics');
        }
        return Object.freeze({
          disposition: 'already_applied', eventId, payloadId,
          projection: ensureProjection(eventId, projectionPayloadRef, coreTimestamp(now)),
        });
      }

      const createdAt = coreTimestamp(now);
      run(`INSERT INTO journal_event(
        journal_event_id,event_type,owner_id,activity_id,actor_ref,origin_ref,source_kind,
        source_ref,revision,causation_id,correlation_id,created_at
      ) VALUES (?,'external_poll_fact_observed',?,?,?,'core-external-poll-worker',
        'external_mcp',?,0,?,?,?)`,
      eventId, authority.ownerId, authority.activityId, serverId, sourceFingerprint,
      authority.causationId, workRunId, createdAt);
      run(`INSERT INTO journal_payload(
        journal_payload_id,journal_event_id,storage_kind,payload_ref,content_hash_token,
        sensitivity,retention_class,created_at
      ) VALUES (?,?,'external_ref',?,?,'sensitive','canonical',?)`,
      payloadId, eventId, payloadRef, contentHashToken, createdAt);
      return Object.freeze({
        disposition: 'recorded', eventId, payloadId,
        projection: ensureProjection(eventId, projectionPayloadRef, createdAt),
      });
    },
  });
}
