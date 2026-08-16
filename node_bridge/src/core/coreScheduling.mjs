import { createHash } from 'node:crypto';

import { coreError } from './coreErrors.mjs';
import { assertKeyedContentHashToken } from './coreHashToken.mjs';
import { assertOperationSemanticDigest } from './coreOperationDigest.mjs';

const OPERATION_KEY = /^[A-Za-z0-9._:-]{1,200}$/;
const WALL_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/;
const formatters = new Map();

function canonicalIso(value, field) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw coreError('CORE_SCHEDULE_TIME_INVALID', `${field} must be an instant`);
  const iso = date.toISOString();
  if (!iso.endsWith('.000Z')) throw coreError('CORE_SCHEDULE_TIME_INVALID', `${field} must use whole-second precision`);
  return iso;
}

function assertOperationKey(value) {
  if (typeof value !== 'string' || !OPERATION_KEY.test(value)) {
    throw coreError('CORE_SCHEDULE_OPERATION_KEY_INVALID', 'schedule operation key is invalid');
  }
  return value;
}

function formatter(timeZone) {
  if (formatters.has(timeZone)) return formatters.get(timeZone);
  let value;
  try {
    value = new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    });
    value.format(new Date(0));
  } catch (error) {
    throw coreError('CORE_SCHEDULE_TIMEZONE_INVALID', 'daily schedule requires an IANA timezone', error);
  }
  formatters.set(timeZone, value);
  return value;
}

function localParts(instant, timeZone) {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(new Date(instant))
    .filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
  return {
    year: parts.year, month: parts.month, day: parts.day,
    hour: parts.hour, minute: parts.minute, second: parts.second,
  };
}

function dateKey(parts) {
  return parts.year * 10_000 + parts.month * 100 + parts.day;
}

function timeKey(parts) {
  return parts.hour * 3_600 + parts.minute * 60 + parts.second;
}

function addLocalDays(parts, days) {
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

function localDayDistance(left, right) {
  return Math.round((Date.UTC(right.year, right.month - 1, right.day)
    - Date.UTC(left.year, left.month - 1, left.day)) / 86_400_000);
}

function resolveDailyInstant(date, wallTime, timeZone) {
  const [hour, minute, second] = wallTime.split(':').map(Number);
  const wantedDate = dateKey(date);
  const wantedTime = hour * 3_600 + minute * 60 + second;
  const center = Date.UTC(date.year, date.month - 1, date.day, hour, minute, second);
  const start = center - 16 * 3_600_000;
  let firstAfterGap = null;
  // ponytail: bounded minute scan is enough for three recurrence forms; use Temporal when Node ships it unflagged.
  for (let offset = 0; offset <= 32 * 60; offset += 1) {
    const instant = start + offset * 60_000;
    const parts = localParts(instant, timeZone);
    if (dateKey(parts) !== wantedDate) continue;
    const actualTime = timeKey(parts);
    if (actualTime === wantedTime) return new Date(instant).toISOString();
    if (actualTime > wantedTime && firstAfterGap === null) {
      firstAfterGap = new Date(instant - (instant % 60_000)).toISOString();
    }
  }
  if (firstAfterGap) return firstAfterGap;
  throw coreError('CORE_SCHEDULE_DAILY_RESOLUTION_FAILED', 'daily wall time could not be resolved');
}

export function localDateForInstant(instant, timeZone) {
  const parts = localParts(instant, timeZone);
  return [parts.year, parts.month, parts.day]
    .map((part, index) => String(part).padStart(index === 0 ? 4 : 2, '0')).join('-');
}

export function resolveLocalDateTime(date, time, timeZone) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(time || ''))) {
    throw coreError('CORE_SCHEDULE_LOCAL_TIME_INVALID', 'local date and time must use YYYY-MM-DD and HH:MM');
  }
  const [year, month, day] = date.split('-').map(Number);
  const canonical = new Date(Date.UTC(year, month - 1, day));
  if (canonical.toISOString().slice(0, 10) !== date) {
    throw coreError('CORE_SCHEDULE_LOCAL_TIME_INVALID', 'local date is invalid');
  }
  return resolveDailyInstant({ year, month, day }, `${time}:00`, timeZone);
}

function normalizeRecurrence(recurrence) {
  if (!recurrence || typeof recurrence !== 'object') {
    throw coreError('CORE_SCHEDULE_RECURRENCE_INVALID', 'recurrence is required');
  }
  if (recurrence.kind === 'one_shot') {
    return Object.freeze({ kind: 'one_shot', at: canonicalIso(recurrence.at, 'one-shot at') });
  }
  if (recurrence.kind === 'interval') {
    if (!Number.isSafeInteger(recurrence.everySeconds) || recurrence.everySeconds < 1) {
      throw coreError('CORE_SCHEDULE_RECURRENCE_INVALID', 'interval must use positive whole seconds');
    }
    return Object.freeze({
      kind: 'interval',
      anchorAt: canonicalIso(recurrence.anchorAt, 'interval anchor'),
      everySeconds: recurrence.everySeconds,
    });
  }
  if (recurrence.kind === 'daily') {
    if (typeof recurrence.time !== 'string' || !WALL_TIME.test(recurrence.time)) {
      throw coreError('CORE_SCHEDULE_RECURRENCE_INVALID', 'daily time must be HH:MM:SS');
    }
    if (typeof recurrence.timeZone !== 'string' || !recurrence.timeZone.trim()) {
      throw coreError('CORE_SCHEDULE_TIMEZONE_INVALID', 'daily schedule requires an IANA timezone');
    }
    formatter(recurrence.timeZone);
    return Object.freeze({ kind: 'daily', time: recurrence.time, timeZone: recurrence.timeZone });
  }
  throw coreError('CORE_SCHEDULE_RECURRENCE_INVALID', 'unsupported recurrence kind');
}

function nextAfter(recurrence, instant) {
  const after = new Date(instant).getTime();
  if (recurrence.kind === 'one_shot') return new Date(recurrence.at).getTime() > after ? recurrence.at : null;
  if (recurrence.kind === 'interval') {
    const anchor = new Date(recurrence.anchorAt).getTime();
    const period = recurrence.everySeconds * 1_000;
    const steps = Math.max(0, Math.floor((after - anchor) / period) + 1);
    return new Date(anchor + steps * period).toISOString();
  }
  const parts = localParts(after, recurrence.timeZone);
  let candidate = resolveDailyInstant(parts, recurrence.time, recurrence.timeZone);
  if (new Date(candidate).getTime() <= after) {
    candidate = resolveDailyInstant(addLocalDays(parts, 1), recurrence.time, recurrence.timeZone);
  }
  return candidate;
}

function initialDue(recurrence, after) {
  const due = nextAfter(recurrence, after);
  if (!due) throw coreError('CORE_SCHEDULE_NO_FUTURE_DUE', 'schedule has no due instant after Core now');
  return due;
}

function intervalWindow(recurrence, firstDue, now) {
  const first = new Date(firstDue).getTime();
  const current = new Date(now).getTime();
  const period = recurrence.everySeconds * 1_000;
  const total = Math.floor((current - first) / period) + 1;
  const tailCount = Math.min(total, 8);
  const tail = Array.from({ length: tailCount }, (_, index) => (
    new Date(first + (total - tailCount + index) * period).toISOString()
  ));
  return { total, tail, nextFuture: new Date(first + total * period).toISOString() };
}

function dailyWindow(recurrence, firstDue, now) {
  const firstDate = localParts(firstDue, recurrence.timeZone);
  const nowParts = localParts(now, recurrence.timeZone);
  const days = localDayDistance(firstDate, nowParts);
  const todayDue = resolveDailyInstant(nowParts, recurrence.time, recurrence.timeZone);
  const includesToday = new Date(todayDue).getTime() <= new Date(now).getTime();
  const total = Math.max(0, days + (includesToday ? 1 : 0));
  const tailCount = Math.min(total, 8);
  const tail = Array.from({ length: tailCount }, (_, index) => resolveDailyInstant(
    addLocalDays(firstDate, total - tailCount + index), recurrence.time, recurrence.timeZone,
  ));
  const nextDate = includesToday ? addLocalDays(nowParts, 1) : nowParts;
  return { total, tail, nextFuture: resolveDailyInstant(nextDate, recurrence.time, recurrence.timeZone) };
}

function dueWindow(recurrence, firstDue, now, catchUpPolicy, catchUpLimit) {
  if (new Date(firstDue).getTime() > new Date(now).getTime()) {
    return { selected: [], skipped: 0, nextDue: firstDue };
  }
  let window;
  if (recurrence.kind === 'one_shot') window = { total: 1, tail: [firstDue], nextFuture: null };
  else if (recurrence.kind === 'interval') window = intervalWindow(recurrence, firstDue, now);
  else window = dailyWindow(recurrence, firstDue, now);

  let selected;
  if (catchUpPolicy === 'skip') {
    selected = window.tail.at(-1) === now ? [now] : [];
  } else if (catchUpPolicy === 'latest') {
    selected = [window.tail.at(-1)];
  } else {
    selected = window.tail.slice(-catchUpLimit);
  }
  return {
    selected,
    skipped: window.total - selected.length,
    nextDue: window.nextFuture,
  };
}

function digest(input, recurrenceJson) {
  const canonical = JSON.stringify([
    ['operation_schema', 'core-schedule-revision:v1'],
    ['schedule_spec_id', input.scheduleSpecId],
    ['activity_id', input.activityId],
    ['revision', input.revision],
    ['recurrence', recurrenceJson],
    ['task_kind', input.taskKind],
    ['payload_ref', input.payloadRef],
    ['catch_up_policy', input.catchUpPolicy],
    ['catch_up_limit', input.catchUpLimit],
    ['activity_contract_revision', input.activityContractRevision],
    ['conversation_id', input.conversationId ?? null],
    ['presentation_binding_id', input.presentationBindingId ?? null],
    ['expected_binding_revision', input.expectedBindingRevision ?? null],
    ['causation_id', input.causationId],
    ['operation_key', input.operationKey],
  ]);
  return assertOperationSemanticDigest(`sha256:v1:${createHash('sha256').update(canonical).digest('hex')}`);
}

function workRunClaimDigest(input, sourceEventId) {
  const canonical = JSON.stringify([
    ['operation_schema', 'core-scheduled-work-claim:v1'],
    ['work_run_id', input.workRunId],
    ['expected_revision', input.expectedRevision],
    ['expected_fence', input.expectedFence],
    ['lease_owner', input.leaseOwner],
    ['lease_until', input.leaseUntil],
    ['causation_id', sourceEventId],
    ['operation_key', input.operationKey],
  ]);
  return assertOperationSemanticDigest(`sha256:v1:${createHash('sha256').update(canonical).digest('hex')}`);
}

function workRunTerminalDigest(input, authority) {
  const canonical = JSON.stringify([
    ['operation_schema', 'core-work-run-terminal:v1'],
    ['operation_key', input.operationKey],
    ['work_run_id', authority.workRunId],
    ['work_run_revision', authority.expectedRevision],
    ['work_run_fence', authority.fenceToken],
    ['lease_owner', authority.leaseOwner],
    ['lease_id', authority.leaseId],
    ['result_state', input.resultState],
    ['result_ref', input.resultRef],
    ['result_hash_token', input.resultHashToken],
    ['failure_class', input.failureClass ?? null],
  ]);
  return assertOperationSemanticDigest(`sha256:v1:${createHash('sha256').update(canonical).digest('hex')}`);
}

function workRunRecoveryDigest(input, sourceEventId) {
  const canonical = JSON.stringify([
    ['operation_schema', 'core-work-run-recovery:v1'],
    ['operation_key', input.operationKey],
    ['work_run_id', input.workRunId],
    ['expected_revision', input.expectedRevision],
    ['expected_fence', input.expectedFence],
    ['causation_id', sourceEventId],
  ]);
  return assertOperationSemanticDigest(`sha256:v1:${createHash('sha256').update(canonical).digest('hex')}`);
}

function deterministicId(prefix, ...parts) {
  return `${prefix}:v1:${createHash('sha256').update(parts.join('\0')).digest('hex')}`;
}

function normalizeScheduledAuthority(input) {
  if (!input || typeof input.workRunId !== 'string' || !input.workRunId
    || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1
    || !Number.isSafeInteger(input.fenceToken) || input.fenceToken < 1
    || typeof input.leaseOwner !== 'string' || !input.leaseOwner
    || typeof input.leaseId !== 'string' || !input.leaseId) {
    throw coreError('CORE_SCHEDULE_WORK_AUTHORITY_INVALID', 'scheduled Work Run authority is invalid');
  }
  return Object.freeze({
    workRunId: input.workRunId,
    expectedRevision: input.expectedRevision,
    fenceToken: input.fenceToken,
    leaseOwner: input.leaseOwner,
    leaseId: input.leaseId,
  });
}

export function assertScheduledWorkAuthority(get, input, {
  exchangeId = null,
  sourceTurnId = null,
  activeAt,
} = {}) {
  const authority = normalizeScheduledAuthority(input);
  const at = canonicalIso(activeAt, 'scheduled authority time');
  const row = get(`SELECT run.*,lease.state AS lease_state,lease.fence_token AS lease_fence,
      lease.lease_owner AS claimed_lease_owner,lease.lease_until AS claimed_lease_until,
      activity.state AS activity_state,activity.contract_revision AS activity_contract_revision,
      activity.conversation_id AS activity_conversation_id,
      occurrence.schedule_spec_revision_id,revision.task_kind,revision.payload_ref AS schedule_payload_ref,
      revision.causation_id,revision.conversation_id AS schedule_conversation_id,
      revision.presentation_binding_id,revision.expected_binding_revision,
      exchange.conversation_id AS exchange_conversation_id,exchange.ingress_event_id,
      exchange.root_instruction_turn_id,exchange.revision AS exchange_revision,
      binding.state AS binding_state,binding.revision AS binding_revision
    FROM work_run run
    JOIN lease ON lease.lease_id=run.lease_id AND lease.work_run_id=run.work_run_id
    JOIN activity ON activity.activity_id=run.activity_id
    JOIN wake_occurrence occurrence ON occurrence.wake_occurrence_id=run.wake_occurrence_id
    JOIN schedule_spec_revision revision
      ON revision.schedule_spec_revision_id=occurrence.schedule_spec_revision_id
    JOIN exchange ON exchange.exchange_id=run.exchange_id
    JOIN presentation_binding binding
      ON binding.presentation_binding_id=revision.presentation_binding_id
      AND binding.conversation_id=revision.conversation_id
    WHERE run.work_run_id=?`, authority.workRunId);
  const valid = row && row.state === 'running'
    && Number(row.revision) === authority.expectedRevision
    && Number(row.fence_token) === authority.fenceToken
    && row.lease_id === authority.leaseId
    && row.lease_owner === authority.leaseOwner
    && row.lease_state === 'active'
    && Number(row.lease_fence) === authority.fenceToken
    && row.claimed_lease_owner === authority.leaseOwner
    && row.claimed_lease_until === row.lease_until
    && new Date(row.lease_until).getTime() >= new Date(at).getTime()
    && row.task_kind === 'scheduled_instruction'
    && row.activity_state === 'active'
    && Number(row.contract_revision) === Number(row.activity_contract_revision)
    && row.activity_conversation_id === row.schedule_conversation_id
    && row.exchange_conversation_id === row.schedule_conversation_id
    && row.ingress_event_id === null
    && row.binding_state === 'active'
    && Number(row.binding_revision) === Number(row.expected_binding_revision)
    && (exchangeId === null || row.exchange_id === exchangeId);
  if (!valid) {
    throw coreError('CORE_SCHEDULE_WORK_AUTHORITY_STALE', 'scheduled Work Run authority is missing or stale');
  }
  if (sourceTurnId !== null) {
    const source = get(`SELECT turn.role,turn.visibility,turn.active_revision_id,
        revision.payload_ref,instruction.instruction_kind,receipt.source_kind,
        receipt.correlation_id,receipt.actor_ref,receipt.revision AS receipt_revision
      FROM semantic_turn turn
      JOIN turn_revision revision ON revision.turn_revision_id=turn.active_revision_id
      JOIN exchange_instruction instruction
        ON instruction.semantic_turn_id=turn.semantic_turn_id
        AND instruction.exchange_id=turn.exchange_id
      JOIN journal_event receipt ON receipt.journal_event_id=revision.source_event_id
      WHERE turn.semantic_turn_id=? AND turn.exchange_id=? AND turn.conversation_id=?`,
    sourceTurnId, row.exchange_id, row.exchange_conversation_id);
    if (!source || row.root_instruction_turn_id !== sourceTurnId
      || source.role !== 'system' || source.visibility !== 'internal'
      || source.instruction_kind !== 'root'
      || source.payload_ref !== row.schedule_payload_ref
      || source.source_kind !== 'core-scheduled-instruction:v1'
      || source.correlation_id !== authority.workRunId
      || source.actor_ref !== authority.leaseOwner
      || Number(source.receipt_revision) !== authority.expectedRevision) {
      throw coreError('CORE_SCHEDULE_INSTRUCTION_INVALID', 'scheduled instruction is not bound to Work Run authority');
    }
  }
  return Object.freeze({ ...authority, exchangeId: row.exchange_id, conversationId: row.exchange_conversation_id,
    payloadRef: row.schedule_payload_ref, causationId: row.causation_id });
}

export function assertClaimedWorkRunAuthority(get, input, activeAt) {
  const authority = normalizeScheduledAuthority(input);
  const at = canonicalIso(activeAt, 'Work Run authority time');
  const row = get(`SELECT run.*,lease.state AS lease_state,lease.fence_token AS lease_fence,
      lease.lease_owner AS claimed_lease_owner,lease.lease_until AS claimed_lease_until,
      activity.owner_id,activity.state AS activity_state,
      activity.contract_revision AS activity_contract_revision,
      occurrence.schedule_spec_revision_id,revision.task_kind,revision.payload_ref,
      revision.causation_id
    FROM work_run run
    JOIN lease ON lease.lease_id=run.lease_id AND lease.work_run_id=run.work_run_id
    JOIN activity ON activity.activity_id=run.activity_id
    JOIN wake_occurrence occurrence ON occurrence.wake_occurrence_id=run.wake_occurrence_id
    JOIN schedule_spec_revision revision
      ON revision.schedule_spec_revision_id=occurrence.schedule_spec_revision_id
    WHERE run.work_run_id=?`, authority.workRunId);
  const valid = row && row.state === 'running'
    && Number(row.revision) === authority.expectedRevision
    && Number(row.fence_token) === authority.fenceToken
    && row.lease_id === authority.leaseId
    && row.lease_owner === authority.leaseOwner
    && row.lease_state === 'active'
    && Number(row.lease_fence) === authority.fenceToken
    && row.claimed_lease_owner === authority.leaseOwner
    && row.claimed_lease_until === row.lease_until
    && new Date(row.lease_until).getTime() >= new Date(at).getTime()
    && row.activity_state === 'active'
    && Number(row.contract_revision) === Number(row.activity_contract_revision);
  if (!valid) {
    throw coreError('CORE_SCHEDULE_WORK_AUTHORITY_STALE', 'scheduled Work Run authority is missing or stale');
  }
  return Object.freeze({ authority, row });
}

function scheduledInstructionDigest(input, authority) {
  const canonical = JSON.stringify([
    ['operation_schema', 'core-scheduled-instruction:v1'],
    ['operation_key', input.operationKey],
    ['work_run_id', authority.workRunId],
    ['work_run_revision', authority.expectedRevision],
    ['work_run_fence', authority.fenceToken],
    ['lease_owner', authority.leaseOwner],
    ['lease_id', authority.leaseId],
    ['exchange_id', authority.exchangeId],
    ['instruction_turn_id', input.instructionTurnId],
    ['instruction_revision_id', input.instructionRevisionId],
    ['payload_ref', authority.payloadRef],
    ['payload_hash_token', input.payloadHashToken],
  ]);
  return assertOperationSemanticDigest(`sha256:v1:${createHash('sha256').update(canonical).digest('hex')}`);
}

function normalizedRevision(input, revision) {
  const recurrence = normalizeRecurrence(input.recurrence);
  const recurrenceJson = JSON.stringify(recurrence);
  const catchUpPolicy = input.catchUpPolicy ?? 'latest';
  const catchUpLimit = catchUpPolicy === 'bounded' ? input.catchUpLimit : 1;
  if (!['skip', 'latest', 'bounded'].includes(catchUpPolicy)
    || !Number.isSafeInteger(catchUpLimit) || catchUpLimit < 1 || catchUpLimit > 8) {
    throw coreError('CORE_SCHEDULE_CATCH_UP_INVALID', 'catch-up policy or limit is invalid');
  }
  const operationKey = assertOperationKey(input.operationKey);
  const revisionInput = {
    ...input, revision, recurrence, recurrenceJson, catchUpPolicy, catchUpLimit, operationKey,
  };
  return Object.freeze({
    ...revisionInput,
    semanticDigest: digest(revisionInput, recurrenceJson),
  });
}

function replayRevision(get, scheduleSpecId, operationKey, semanticDigest) {
  const prior = get(`SELECT * FROM schedule_spec_revision
    WHERE schedule_spec_id=? AND operation_key=?`, scheduleSpecId, operationKey);
  if (!prior) return null;
  if (prior.semantic_digest !== semanticDigest) {
    throw coreError('CORE_OPERATION_KEY_CONFLICT', 'schedule operation key has different semantics');
  }
  return Object.freeze({ disposition: 'already_applied', revision: prior });
}

function insertRevision(run, input) {
  run(`INSERT INTO schedule_spec_revision(
    schedule_spec_revision_id,schedule_spec_id,revision,recurrence_kind,recurrence_json,
    task_kind,payload_ref,catch_up_policy,catch_up_limit,activity_contract_revision,
    operation_key,semantic_digest,causation_id,conversation_id,presentation_binding_id,
    expected_binding_revision,created_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  input.scheduleSpecRevisionId, input.scheduleSpecId, input.revision,
  input.recurrence.kind, input.recurrenceJson, input.taskKind, input.payloadRef,
  input.catchUpPolicy, input.catchUpLimit, input.activityContractRevision,
  input.operationKey, input.semanticDigest, input.causationId,
  input.conversationId ?? null, input.presentationBindingId ?? null,
  input.expectedBindingRevision ?? null, input.createdAt);
}

function appendSystemEvent(run, input) {
  const eventId = deterministicId(input.eventType, input.scheduleSpecId, input.sourceRef);
  run(`INSERT OR IGNORE INTO journal_event(
    journal_event_id,event_type,owner_id,conversation_id,activity_id,origin_ref,
    source_kind,source_ref,revision,causation_id,created_at
  ) VALUES (?,?,?,?,?,'core-managed-tick','schedule_spec',?,?,?,?)`,
  eventId, input.eventType, input.ownerId, input.conversationId ?? null, input.activityId,
  input.sourceRef, input.revision, input.causationId, input.createdAt);
  return eventId;
}

export function createCoreScheduleRepository({ get, all, run, now }) {
  const coreNow = () => canonicalIso(now(), 'Core now');
  return Object.freeze({
    create(input) {
      const at = coreNow();
      const normalized = normalizedRevision({ ...input, now: at, createdAt: at }, 1);
      const replay = replayRevision(get, normalized.scheduleSpecId, normalized.operationKey, normalized.semanticDigest);
      if (replay) return replay;
      if (get('SELECT 1 AS found FROM schedule_spec WHERE schedule_spec_id=?', normalized.scheduleSpecId)) {
        throw coreError('CORE_SCHEDULE_ALREADY_EXISTS', 'schedule already exists');
      }
      const activity = get('SELECT * FROM activity WHERE activity_id=?', normalized.activityId);
      if (!activity || Number(activity.contract_revision) !== normalized.activityContractRevision) {
        throw coreError('CORE_SCHEDULE_ACTIVITY_STALE', 'schedule activity contract is missing or stale');
      }
      run(`INSERT INTO schedule_spec(
        schedule_spec_id,activity_id,current_revision_id,next_due_at,state,revision,created_at,updated_at
      ) VALUES (?,?,?,?,'enabled',1,?,?)`,
      normalized.scheduleSpecId, normalized.activityId, normalized.scheduleSpecRevisionId,
      initialDue(normalized.recurrence, normalized.now), normalized.createdAt, normalized.createdAt);
      insertRevision(run, normalized);
      return Object.freeze({
        disposition: 'created',
        schedule: get('SELECT * FROM schedule_spec WHERE schedule_spec_id=?', normalized.scheduleSpecId),
        revision: get('SELECT * FROM schedule_spec_revision WHERE schedule_spec_revision_id=?', normalized.scheduleSpecRevisionId),
      });
    },

    revise(input) {
      const at = coreNow();
      const normalized = normalizedRevision({ ...input, now: at, createdAt: at }, input.expectedRevision + 1);
      const replay = replayRevision(get, normalized.scheduleSpecId, normalized.operationKey, normalized.semanticDigest);
      if (replay) return replay;
      const schedule = get('SELECT * FROM schedule_spec WHERE schedule_spec_id=?', normalized.scheduleSpecId);
      if (!schedule || schedule.activity_id !== normalized.activityId
        || Number(schedule.revision) !== input.expectedRevision) {
        throw coreError('CORE_SCHEDULE_REVISION_STALE', 'schedule head changed before revision');
      }
      const latestOccurrence = get(`SELECT scheduled_for FROM wake_occurrence
        WHERE schedule_spec_id=? ORDER BY scheduled_for DESC LIMIT 1`, normalized.scheduleSpecId);
      const lowerBound = latestOccurrence && latestOccurrence.scheduled_for > at
        ? latestOccurrence.scheduled_for : at;
      const nextDueAt = initialDue(normalized.recurrence, lowerBound);
      insertRevision(run, normalized);
      const changed = run(`UPDATE schedule_spec
        SET current_revision_id=?,next_due_at=?,state='enabled',revision=?,updated_at=?
        WHERE schedule_spec_id=? AND revision=?`,
      normalized.scheduleSpecRevisionId, nextDueAt, normalized.revision,
      normalized.createdAt, normalized.scheduleSpecId, input.expectedRevision);
      if (changed.changes !== 1) throw coreError('CORE_SCHEDULE_REVISION_STALE', 'schedule head changed before revision');
      return Object.freeze({
        disposition: 'revised',
        schedule: get('SELECT * FROM schedule_spec WHERE schedule_spec_id=?', normalized.scheduleSpecId),
        revision: get('SELECT * FROM schedule_spec_revision WHERE schedule_spec_revision_id=?', normalized.scheduleSpecRevisionId),
      });
    },

    commitInstruction(input) {
      const operationKey = assertOperationKey(input.operationKey);
      const instructionTurnId = assertOperationKey(input.instructionTurnId);
      const instructionRevisionId = assertOperationKey(input.instructionRevisionId);
      const payloadHashToken = assertKeyedContentHashToken(input.payloadHashToken);
      const requested = normalizeScheduledAuthority(input.authority);
      const base = get(`SELECT run.exchange_id,run.activity_id,activity.owner_id,exchange.conversation_id,
          revision.payload_ref,revision.causation_id
        FROM work_run run
        JOIN activity ON activity.activity_id=run.activity_id
        JOIN exchange ON exchange.exchange_id=run.exchange_id
        JOIN wake_occurrence occurrence ON occurrence.wake_occurrence_id=run.wake_occurrence_id
        JOIN schedule_spec_revision revision
          ON revision.schedule_spec_revision_id=occurrence.schedule_spec_revision_id
        WHERE run.work_run_id=?`, requested.workRunId);
      if (!base) throw coreError('CORE_SCHEDULE_WORK_AUTHORITY_STALE', 'scheduled Work Run authority is missing or stale');
      const authority = Object.freeze({ ...requested, exchangeId: base.exchange_id, payloadRef: base.payload_ref });
      const digest = scheduledInstructionDigest({
        operationKey, instructionTurnId, instructionRevisionId, payloadHashToken,
      }, authority);
      const eventId = deterministicId('scheduled-instruction', requested.workRunId, operationKey);
      const elsewhere = get(`SELECT * FROM journal_event
        WHERE event_type='core_scheduled_instruction_committed' AND origin_ref=?`, operationKey);
      const prior = get(`SELECT * FROM journal_event
        WHERE journal_event_id=? AND event_type='core_scheduled_instruction_committed'`, eventId);
      if (elsewhere && elsewhere.journal_event_id !== eventId) {
        throw coreError('CORE_OPERATION_KEY_CONFLICT', 'scheduled instruction operation key targets another Work Run');
      }
      if (prior) {
        if (prior.source_ref !== digest || prior.correlation_id !== requested.workRunId
          || prior.exchange_id !== base.exchange_id || prior.actor_ref !== requested.leaseOwner) {
          throw coreError('CORE_OPERATION_KEY_CONFLICT', 'scheduled instruction operation key has different semantics');
        }
        const turn = get(`SELECT turn.semantic_turn_id,turn.active_revision_id
          FROM semantic_turn turn WHERE turn.semantic_turn_id=? AND turn.exchange_id=?
          AND turn.conversation_id=? AND turn.role='system' AND turn.visibility='internal'`,
        instructionTurnId, base.exchange_id, base.conversation_id);
        if (!turn || turn.active_revision_id !== instructionRevisionId) {
          throw coreError('CORE_OPERATION_RECEIPT_INTEGRITY', 'scheduled instruction receipt result is missing');
        }
        return Object.freeze({ disposition: 'already_applied', eventId,
          instructionTurnId, instructionRevisionId, authority });
      }

      const at = coreNow();
      const active = assertScheduledWorkAuthority(get, requested, { exchangeId: base.exchange_id, activeAt: at });
      const exchange = get('SELECT * FROM exchange WHERE exchange_id=?', base.exchange_id);
      if (Number(exchange.revision) !== 0 || exchange.root_instruction_turn_id !== null
        || get('SELECT 1 AS found FROM semantic_turn WHERE semantic_turn_id=?', instructionTurnId)
        || get('SELECT 1 AS found FROM turn_revision WHERE turn_revision_id=?', instructionRevisionId)) {
        throw coreError('CORE_SCHEDULE_INSTRUCTION_CONFLICT', 'scheduled Exchange already has another instruction');
      }
      run(`INSERT INTO journal_event(
        journal_event_id,event_type,owner_id,conversation_id,exchange_id,activity_id,
        actor_ref,origin_ref,source_kind,source_ref,revision,causation_id,correlation_id,created_at
      ) SELECT ?,'core_scheduled_instruction_committed',?,?,?,?,?,?,'core-scheduled-instruction:v1',
          ?,?,?,?,?
        FROM work_run WHERE work_run_id=?`,
      eventId, base.owner_id, base.conversation_id, base.exchange_id,
      base.activity_id,
      requested.leaseOwner, operationKey, digest, requested.expectedRevision,
      base.causation_id, requested.workRunId, at, requested.workRunId);
      run(`INSERT INTO semantic_turn(
        semantic_turn_id,conversation_id,exchange_id,actor_ref,role,active_revision_id,
        commit_state,visibility,created_at
      ) VALUES (?,?,?,'system:core-schedule','system',NULL,'committed','internal',?)`,
      instructionTurnId, base.conversation_id, base.exchange_id, at);
      run(`INSERT INTO turn_revision(
        turn_revision_id,semantic_turn_id,revision,change_kind,payload_ref,content_hash_token,
        source_event_id,supersedes_revision_id,created_at
      ) VALUES (?,?,1,'initial',?,?,?,NULL,?)`,
      instructionRevisionId, instructionTurnId, active.payloadRef, payloadHashToken, eventId, at);
      run('UPDATE semantic_turn SET active_revision_id=? WHERE semantic_turn_id=?',
        instructionRevisionId, instructionTurnId);
      run(`INSERT INTO exchange_instruction(
        exchange_instruction_id,exchange_id,conversation_id,semantic_turn_id,
        instruction_kind,sequence_no,source_event_id,created_at
      ) VALUES (?,?,?,?,'root',1,?,?)`,
      deterministicId('scheduled-exchange-instruction', base.exchange_id, instructionTurnId),
      base.exchange_id, base.conversation_id, instructionTurnId, eventId, at);
      const adopted = run(`UPDATE exchange SET root_instruction_turn_id=?,revision=1,updated_at=?
        WHERE exchange_id=? AND conversation_id=? AND revision=0 AND root_instruction_turn_id IS NULL`,
      instructionTurnId, at, base.exchange_id, base.conversation_id);
      if (adopted.changes !== 1) {
        throw coreError('CORE_SCHEDULE_INSTRUCTION_CONFLICT', 'scheduled Exchange instruction changed during commit');
      }
      return Object.freeze({ disposition: 'applied', eventId,
        instructionTurnId, instructionRevisionId, authority: active });
    },

    assertWorkRunAuthority(input) {
      return assertScheduledWorkAuthority(get, input.authority, {
        exchangeId: input.exchangeId ?? null,
        sourceTurnId: input.sourceTurnId ?? null,
        activeAt: input.activeAt,
      });
    },

    claimWorkRun(input) {
      const at = coreNow();
      const operationKey = assertOperationKey(input.operationKey);
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0
        || !Number.isSafeInteger(input.expectedFence) || input.expectedFence < 0
        || typeof input.leaseOwner !== 'string' || !input.leaseOwner
        || new Date(input.leaseUntil).getTime() <= new Date(at).getTime()) {
        throw coreError('CORE_SCHEDULE_WORK_CLAIM_INVALID', 'scheduled Work Run claim is invalid');
      }
      const work = get(`SELECT run.*, revision.causation_id
        FROM work_run run
        JOIN wake_occurrence occurrence ON occurrence.wake_occurrence_id=run.wake_occurrence_id
        JOIN schedule_spec_revision revision
          ON revision.schedule_spec_revision_id=occurrence.schedule_spec_revision_id
        WHERE run.work_run_id=?`, input.workRunId);
      if (!work) return null;
      const operationDigest = workRunClaimDigest({ ...input, operationKey }, work.causation_id);
      const prior = get(`SELECT * FROM fence
        WHERE domain='work_run' AND work_run_id=? AND operation_key=?`, input.workRunId, operationKey);
      if (prior) {
        if (prior.operation_semantic_digest !== operationDigest) {
          throw coreError('CORE_OPERATION_KEY_CONFLICT', 'scheduled Work Run claim key has different semantics');
        }
        return Object.freeze({
          disposition: 'already_applied',
          workRunId: prior.work_run_id,
          revision: Number(prior.new_revision),
          fenceToken: Number(prior.new_fence),
          lease: get('SELECT * FROM lease WHERE work_run_id=? AND fence_token=?',
            prior.work_run_id, prior.new_fence),
        });
      }
      const activity = get('SELECT * FROM activity WHERE activity_id=?', work.activity_id);
      if (activity?.state !== 'active'
        || Number(activity.contract_revision) !== Number(work.contract_revision)
        || !['queued', 'waiting'].includes(work.state)
        || Number(work.revision) !== input.expectedRevision
        || Number(work.fence_token) !== input.expectedFence) return null;

      const nextFence = input.expectedFence + 1;
      const leaseId = deterministicId('scheduled-lease', input.workRunId, String(nextFence));
      run(`INSERT INTO lease(
        lease_id,work_run_id,lease_owner,lease_until,fence_token,state,revision,
        source_event_id,created_at
      ) VALUES (?,?,?,?,?,'active',0,?,?)`,
      leaseId, input.workRunId, input.leaseOwner, input.leaseUntil,
      nextFence, work.causation_id, at);
      const changed = run(`UPDATE work_run
        SET state='running',revision=revision+1,lease_id=?,lease_owner=?,lease_until=?,
            fence_token=?,fence_reason_code='lease_acquired',fence_causation_id=?,
            fence_operation_key=?,fence_operation_digest=?,fence_committed_at=?,
            started_at=COALESCE(started_at,?),heartbeat_at=?,updated_at=?
        WHERE work_run_id=? AND revision=? AND fence_token=? AND state IN ('queued','waiting')`,
      leaseId, input.leaseOwner, input.leaseUntil, nextFence, work.causation_id,
      operationKey, operationDigest, at, at, at, at,
      input.workRunId, input.expectedRevision, input.expectedFence);
      if (changed.changes !== 1) throw coreError('CORE_SCHEDULE_WORK_CLAIM_STALE', 'scheduled Work Run changed during claim');
      return Object.freeze({
        disposition: 'applied', workRunId: input.workRunId,
        revision: input.expectedRevision + 1, fenceToken: nextFence,
        lease: get('SELECT * FROM lease WHERE lease_id=?', leaseId),
      });
    },

    completeWorkRun(input) {
      const at = coreNow();
      const operationKey = assertOperationKey(input.operationKey);
      if (!['completed', 'failed'].includes(input.resultState)
        || typeof input.resultRef !== 'string' || !input.resultRef.trim()
        || (input.resultState === 'failed' && (typeof input.failureClass !== 'string' || !input.failureClass.trim()))) {
        throw coreError('CORE_SCHEDULE_WORK_RESULT_INVALID', 'scheduled Work Run result is invalid');
      }
      const resultHashToken = assertKeyedContentHashToken(input.resultHashToken);
      const authority = normalizeScheduledAuthority(input.authority);
      const semanticDigest = workRunTerminalDigest({ ...input, operationKey, resultHashToken }, authority);
      const eventId = deterministicId('scheduled-work-terminal', authority.workRunId, operationKey);
      const prior = get(`SELECT * FROM journal_event
        WHERE journal_event_id=? AND event_type='core_work_run_terminal'`, eventId);
      if (prior) {
        if (prior.source_ref !== semanticDigest || prior.correlation_id !== authority.workRunId
          || prior.actor_ref !== authority.leaseOwner || Number(prior.revision) !== authority.expectedRevision + 1) {
          throw coreError('CORE_OPERATION_KEY_CONFLICT', 'scheduled Work Run result key has different semantics');
        }
        return Object.freeze({ disposition: 'already_applied', eventId,
          workRun: get('SELECT * FROM work_run WHERE work_run_id=?', authority.workRunId) });
      }
      const { row } = assertClaimedWorkRunAuthority(get, authority, at);
      run(`INSERT INTO journal_event(
        journal_event_id,event_type,owner_id,conversation_id,exchange_id,activity_id,
        actor_ref,origin_ref,source_kind,source_ref,revision,causation_id,correlation_id,created_at
      ) VALUES (?,'core_work_run_terminal',?,?,?,?,?,?,?, ?,?,?,?,?)`,
      eventId, row.owner_id, row.exchange_id ? get('SELECT conversation_id FROM exchange WHERE exchange_id=?', row.exchange_id).conversation_id : null,
      row.exchange_id, row.activity_id, authority.leaseOwner, operationKey,
      `core-work-run-terminal:${input.resultState}`, semanticDigest, authority.expectedRevision + 1,
      row.causation_id, authority.workRunId, at);
      run(`INSERT INTO journal_payload(
        journal_payload_id,journal_event_id,storage_kind,payload_ref,content_hash_token,
        sensitivity,retention_class,created_at
      ) VALUES (?,?,'external_ref',?,?,'normal','diagnostic',?)`,
      `${eventId}:payload`, eventId, input.resultRef, resultHashToken, at);
      const changed = run(`UPDATE work_run
        SET state=?,revision=revision+1,lease_owner=NULL,lease_until=NULL,
            heartbeat_at=?,ended_at=?,failure_class=?,updated_at=?
        WHERE work_run_id=? AND state='running' AND revision=? AND fence_token=?
          AND lease_id=? AND lease_owner=?`,
      input.resultState, at, at, input.resultState === 'failed' ? input.failureClass : null, at,
      authority.workRunId, authority.expectedRevision, authority.fenceToken,
      authority.leaseId, authority.leaseOwner);
      if (changed.changes !== 1) throw coreError('CORE_SCHEDULE_WORK_RESULT_STALE', 'scheduled Work Run changed before result commit');
      const released = run(`UPDATE lease SET state='revoked',revision=revision+1,revoked_at=?
        WHERE lease_id=? AND work_run_id=? AND state='active' AND fence_token=? AND lease_owner=?`,
      at, authority.leaseId, authority.workRunId, authority.fenceToken, authority.leaseOwner);
      if (released.changes !== 1) throw coreError('CORE_SCHEDULE_WORK_RESULT_STALE', 'scheduled Work Run lease changed before result commit');
      return Object.freeze({ disposition: 'applied', eventId,
        workRun: get('SELECT * FROM work_run WHERE work_run_id=?', authority.workRunId) });
    },

    recoverExpiredWorkRun(input) {
      const at = coreNow();
      const operationKey = assertOperationKey(input.operationKey);
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1
        || !Number.isSafeInteger(input.expectedFence) || input.expectedFence < 1) {
        throw coreError('CORE_SCHEDULE_WORK_RECOVERY_INVALID', 'expired Work Run recovery authority is invalid');
      }
      const work = get(`SELECT run.*,revision.causation_id,lease.state AS lease_state,
          lease.fence_token AS lease_fence,lease.lease_owner AS claimed_lease_owner,
          lease.lease_until AS claimed_lease_until
        FROM work_run run
        JOIN lease ON lease.lease_id=run.lease_id AND lease.work_run_id=run.work_run_id
        JOIN wake_occurrence occurrence ON occurrence.wake_occurrence_id=run.wake_occurrence_id
        JOIN schedule_spec_revision revision
          ON revision.schedule_spec_revision_id=occurrence.schedule_spec_revision_id
        WHERE run.work_run_id=?`, input.workRunId);
      if (!work) return null;
      const semanticDigest = workRunRecoveryDigest({ ...input, operationKey }, work.causation_id);
      const prior = get(`SELECT * FROM fence
        WHERE domain='work_run' AND work_run_id=? AND operation_key=?`, input.workRunId, operationKey);
      if (prior) {
        if (prior.operation_semantic_digest !== semanticDigest) {
          throw coreError('CORE_OPERATION_KEY_CONFLICT', 'expired Work Run recovery key has different semantics');
        }
        return Object.freeze({ disposition: 'already_applied', workRunId: input.workRunId,
          revision: Number(prior.new_revision), fenceToken: Number(prior.new_fence) });
      }
      const valid = work.state === 'running' && work.lease_state === 'active'
        && Number(work.revision) === input.expectedRevision
        && Number(work.fence_token) === input.expectedFence
        && Number(work.lease_fence) === input.expectedFence
        && work.claimed_lease_owner === work.lease_owner
        && work.claimed_lease_until === work.lease_until
        && new Date(work.lease_until).getTime() < new Date(at).getTime();
      if (!valid) return null;
      const released = run(`UPDATE lease SET state='revoked',revision=revision+1,revoked_at=?
        WHERE lease_id=? AND work_run_id=? AND state='active' AND fence_token=?`,
      at, work.lease_id, input.workRunId, input.expectedFence);
      if (released.changes !== 1) throw coreError('CORE_SCHEDULE_WORK_RECOVERY_STALE', 'expired Work Run lease changed during recovery');
      const changed = run(`UPDATE work_run
        SET state='waiting',revision=revision+1,fence_token=fence_token+1,
            lease_owner=NULL,lease_until=NULL,fence_reason_code='restart',
            fence_causation_id=?,fence_operation_key=?,fence_operation_digest=?,
            fence_committed_at=?,heartbeat_at=?,updated_at=?
        WHERE work_run_id=? AND state='running' AND revision=? AND fence_token=? AND lease_id=?`,
      work.causation_id, operationKey, semanticDigest, at, at, at,
      input.workRunId, input.expectedRevision, input.expectedFence, work.lease_id);
      if (changed.changes !== 1) throw coreError('CORE_SCHEDULE_WORK_RECOVERY_STALE', 'expired Work Run changed during recovery');
      return Object.freeze({ disposition: 'applied', workRunId: input.workRunId,
        revision: input.expectedRevision + 1, fenceToken: input.expectedFence + 1 });
    },

    wakeDue(input) {
      const at = coreNow();
      if (!Number.isSafeInteger(input.batchSize) || input.batchSize < 1 || input.batchSize > 128) {
        throw coreError('CORE_SCHEDULE_BATCH_INVALID', 'managed tick batch size must be between 1 and 128');
      }
      const schedules = all(`SELECT spec.*, revision.recurrence_json, revision.catch_up_policy,
          revision.catch_up_limit, revision.activity_contract_revision, revision.causation_id,
          revision.conversation_id, revision.presentation_binding_id,
          revision.expected_binding_revision
        FROM schedule_spec spec
        JOIN schedule_spec_revision revision
          ON revision.schedule_spec_revision_id=spec.current_revision_id
        WHERE spec.state='enabled' AND spec.next_due_at<=?
        ORDER BY spec.next_due_at,spec.schedule_spec_id LIMIT ?`, at, input.batchSize);
      const results = [];
      for (const schedule of schedules) {
        const activity = get('SELECT * FROM activity WHERE activity_id=?', schedule.activity_id);
        if (activity?.state === 'paused') {
          results.push(Object.freeze({ scheduleSpecId: schedule.schedule_spec_id, disposition: 'paused' }));
          continue;
        }
        const authorityValid = activity?.state === 'active'
          && Number(activity.contract_revision) === Number(schedule.activity_contract_revision);
        let bindingValid = true;
        if (schedule.conversation_id !== null) {
          const conversation = get('SELECT * FROM conversation WHERE conversation_id=?', schedule.conversation_id);
          const binding = get(`SELECT * FROM presentation_binding
            WHERE presentation_binding_id=? AND conversation_id=?`,
          schedule.presentation_binding_id, schedule.conversation_id);
          bindingValid = activity?.conversation_id === schedule.conversation_id
            && conversation?.state === 'active' && binding?.state === 'active'
            && Number(binding?.revision) === Number(schedule.expected_binding_revision);
        }
        if (!authorityValid || !bindingValid) {
          const sourceRef = `${schedule.current_revision_id}:${authorityValid ? 'binding' : 'activity'}`;
          appendSystemEvent(run, {
            eventType: 'schedule_authority_retired', scheduleSpecId: schedule.schedule_spec_id,
            sourceRef, ownerId: activity?.owner_id ?? null, conversationId: schedule.conversation_id,
            activityId: schedule.activity_id, revision: schedule.revision,
            causationId: schedule.causation_id, createdAt: at,
          });
          run(`UPDATE schedule_spec SET state='retired',next_due_at=NULL,updated_at=?
            WHERE schedule_spec_id=? AND current_revision_id=? AND state='enabled'`,
          at, schedule.schedule_spec_id, schedule.current_revision_id);
          results.push(Object.freeze({ scheduleSpecId: schedule.schedule_spec_id, disposition: 'retired' }));
          continue;
        }

        const recurrence = JSON.parse(schedule.recurrence_json);
        const window = dueWindow(
          recurrence, schedule.next_due_at, at,
          schedule.catch_up_policy, Number(schedule.catch_up_limit),
        );
        const occurrences = [];
        for (const scheduledFor of window.selected) {
          const occurrenceId = deterministicId('wake', schedule.schedule_spec_id, scheduledFor);
          const existing = get('SELECT * FROM wake_occurrence WHERE wake_occurrence_id=?', occurrenceId);
          if (existing) {
            occurrences.push(existing);
            continue;
          }
          run(`INSERT INTO wake_occurrence(
            wake_occurrence_id,schedule_spec_id,schedule_spec_revision_id,scheduled_for,created_at
          ) VALUES (?,?,?,?,?)`, occurrenceId, schedule.schedule_spec_id,
          schedule.current_revision_id, scheduledFor, at);
          let exchangeId = null;
          if (schedule.conversation_id !== null) {
            exchangeId = deterministicId('scheduled-exchange', occurrenceId);
            run(`INSERT INTO exchange(
              exchange_id,conversation_id,activity_id,state,priority,revision,created_at,updated_at
            ) VALUES (?,?,?,'open','normal',0,?,?)`,
            exchangeId, schedule.conversation_id, schedule.activity_id, at, at);
          }
          const attemptNo = Number(get(`SELECT COALESCE(max(attempt_no),0)+1 AS attempt_no
            FROM work_run WHERE activity_id=?`, schedule.activity_id).attempt_no);
          run(`INSERT INTO work_run(
            work_run_id,activity_id,exchange_id,attempt_no,execution_epoch_id,state,revision,
            fence_token,contract_revision,created_at,updated_at,wake_occurrence_id
          ) VALUES (?,?,?,?,?,'queued',0,0,?,?,?,?)`,
          deterministicId('scheduled-work', occurrenceId), schedule.activity_id, exchangeId,
          attemptNo, occurrenceId, schedule.activity_contract_revision,
          at, at, occurrenceId);
          occurrences.push(get('SELECT * FROM wake_occurrence WHERE wake_occurrence_id=?', occurrenceId));
        }
        if (window.skipped > 0) {
          appendSystemEvent(run, {
            eventType: 'schedule_windows_skipped', scheduleSpecId: schedule.schedule_spec_id,
            sourceRef: `${schedule.next_due_at}:${window.nextDue ?? 'exhausted'}:${window.skipped}`,
            ownerId: activity.owner_id, conversationId: schedule.conversation_id,
            activityId: schedule.activity_id, revision: schedule.revision,
            causationId: schedule.causation_id, createdAt: at,
          });
        }
        const nextState = window.nextDue === null ? 'exhausted' : 'enabled';
        const changed = run(`UPDATE schedule_spec SET next_due_at=?,state=?,updated_at=?
          WHERE schedule_spec_id=? AND current_revision_id=? AND next_due_at=? AND state='enabled'`,
        window.nextDue, nextState, at, schedule.schedule_spec_id,
        schedule.current_revision_id, schedule.next_due_at);
        if (changed.changes !== 1) throw coreError('CORE_SCHEDULE_WAKE_STALE', 'schedule changed during managed tick');
        results.push(Object.freeze({
          scheduleSpecId: schedule.schedule_spec_id,
          disposition: occurrences.length > 0 ? 'woken' : 'advanced',
          skipped: window.skipped,
          occurrences: Object.freeze(occurrences),
          nextDueAt: window.nextDue,
        }));
      }
      return Object.freeze(results);
    },
  });
}

export function createCoreSchedulingService({ core, batchSize = 32 } = {}) {
  if (!core?.writer?.write) {
    throw coreError('CORE_SCHEDULING_DEPENDENCY_INVALID', 'Core writer is required');
  }
  return Object.freeze({
    createSchedule: (input) => core.writer.write((tx) => tx.schedules.create(input)),
    reviseSchedule: (input) => core.writer.write((tx) => tx.schedules.revise(input)),
    commitScheduledInstruction: (input) => core.writer.write((tx) => tx.schedules.commitInstruction(input)),
    claimWorkRun: (input) => core.writer.write((tx) => tx.schedules.claimWorkRun(input)),
    completeWorkRun: (input) => core.writer.write((tx) => tx.schedules.completeWorkRun(input)),
    recoverExpiredWorkRun: (input) => core.writer.write((tx) => tx.schedules.recoverExpiredWorkRun(input)),
    wakeDue: () => core.writer.write((tx) => tx.schedules.wakeDue({ batchSize })),
  });
}
