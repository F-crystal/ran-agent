import { createHash } from 'node:crypto';

import { coreError } from '../coreErrors.mjs';
import { assertKeyedContentHashToken } from '../coreHashToken.mjs';

const SAFE_ID = /^[A-Za-z0-9._:-]{1,160}$/;
const SAFE_REF = /^[A-Za-z0-9._:/-]{1,512}$/;
const FINGERPRINT = /^sha256:v1:[0-9a-f]{64}$/;

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

export function createCoreExternalPollRepository({ get, run, now }) {
  return Object.freeze({
    recordFact(input) {
      const workRunId = identifier(input.workRunId, 'workRunId');
      const serverId = identifier(input.serverId, 'serverId');
      const sourceFingerprint = String(input.sourceFingerprint || '');
      if (!FINGERPRINT.test(sourceFingerprint)) {
        throw coreError('CORE_EXTERNAL_POLL_INPUT_INVALID', 'sourceFingerprint is invalid');
      }
      const payloadRef = payloadReference(input.payloadRef);
      const contentHashToken = assertKeyedContentHashToken(input.contentHashToken);
      const authority = get(`SELECT run.work_run_id,run.state,run.contract_revision,
          activity.activity_id,activity.owner_id,activity.state AS activity_state,
          activity.contract_revision AS activity_contract_revision,
          occurrence.wake_occurrence_id,revision.causation_id,revision.task_kind,
          revision.payload_ref AS schedule_payload_ref
        FROM work_run run
        JOIN activity ON activity.activity_id=run.activity_id
        JOIN wake_occurrence occurrence ON occurrence.wake_occurrence_id=run.wake_occurrence_id
        JOIN schedule_spec_revision revision
          ON revision.schedule_spec_revision_id=occurrence.schedule_spec_revision_id
        WHERE run.work_run_id=?`, workRunId);
      if (!authority || authority.task_kind !== 'external_poll'
        || authority.schedule_payload_ref !== `external-poll:${serverId}`
        || authority.state !== 'running' || authority.activity_state !== 'active'
        || Number(authority.contract_revision) !== Number(authority.activity_contract_revision)) {
        throw coreError('CORE_EXTERNAL_POLL_AUTHORITY_STALE', 'external poll Work Run authority is missing or stale');
      }

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
        return Object.freeze({ disposition: 'already_applied', eventId, payloadId });
      }

      const createdAt = coreTimestamp(now);
      run(`INSERT INTO journal_event(
        journal_event_id,event_type,owner_id,activity_id,actor_ref,origin_ref,source_kind,
        source_ref,revision,causation_id,correlation_id,created_at
      ) VALUES (?,'external_poll_fact_observed',?,?,?,'core-external-poll-worker',
        'external_mcp',?,0,?,?,?)`,
      eventId, authority.owner_id, authority.activity_id, serverId, sourceFingerprint,
      authority.causation_id, workRunId, createdAt);
      run(`INSERT INTO journal_payload(
        journal_payload_id,journal_event_id,storage_kind,payload_ref,content_hash_token,
        sensitivity,retention_class,created_at
      ) VALUES (?,?,'external_ref',?,?,'sensitive','canonical',?)`,
      payloadId, eventId, payloadRef, contentHashToken, createdAt);
      return Object.freeze({ disposition: 'recorded', eventId, payloadId });
    },
  });
}
