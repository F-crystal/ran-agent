import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';

import { resolveLocalDateTime } from './core/coreScheduling.mjs';

const execFile = promisify(execFileCallback);
const ACTION_TYPE = 'feishu.calendar.create';
const SCOPE_KEYS = ['date', 'endTime', 'reminderMinutes', 'startTime', 'title'];
const OPERATION_ID = /^op_[a-f0-9]{32}$/;

export function createFeishuCalendarExecutorAdapter({
  env = process.env,
  execFileImpl = execFile,
} = {}) {
  const command = String(env.FEISHU_LARK_CLI_BIN || 'lark-cli').trim();
  const timeZone = String(env.HERMES_ENVIRONMENT_TIMEZONE || 'Asia/Shanghai').trim();
  const timeoutMs = positiveInt(env.FEISHU_CALENDAR_ACTION_TIMEOUT_MS, 60_000);
  if (!command || typeof execFileImpl !== 'function') throw calendarError('FEISHU_CALENDAR_CONFIG');
  const run = async (args, signal) => {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    let stdout;
    try {
      ({ stdout } = await execFileImpl(command, [...args, '--format', 'json', '--as', 'user'], {
        encoding: 'utf8', maxBuffer: 1024 * 1024, signal: requestSignal,
      }));
    } catch (cause) {
      throw calendarError('FEISHU_CALENDAR_COMMAND_FAILED', cause);
    }
    let payload;
    try { payload = JSON.parse(String(stdout || '')); } catch (cause) {
      throw calendarError('FEISHU_CALENDAR_RESPONSE_INVALID', cause);
    }
    if (payload?.ok !== true || payload?.identity !== 'user') {
      throw calendarError('FEISHU_CALENDAR_COMMAND_REJECTED');
    }
    return payload;
  };

  return Object.freeze({
    issuer: 'bridge:lark-cli-calendar-adapter',
    actionTypes: [ACTION_TYPE],
    evidenceType: 'feishu_calendar_readback',
    boundary: 'authenticated_private',
    async execute({ operation, signal } = {}) {
      if (!operation || operation.actionType !== ACTION_TYPE
        || !OPERATION_ID.test(String(operation.operationId || ''))) {
        throw calendarError('FEISHU_CALENDAR_ACTION_INVALID');
      }
      const scope = normalizeFeishuCalendarCreateScope(operation.scope, { timeZone });
      const created = await run([
        'calendar', '+create', '--calendar-id', 'primary', '--summary', scope.title,
        '--start', scope.startInstant, '--end', scope.endInstant,
      ], signal);
      const eventId = String(created?.data?.event?.event_id || created?.data?.event_id || '');
      if (!/^[A-Za-z0-9_-]{6,200}$/.test(eventId)) throw calendarError('FEISHU_CALENDAR_CREATE_UNVERIFIED');
      await run([
        'calendar', 'events', 'patch', '--calendar-id', 'primary', '--event-id', eventId,
        '--data', JSON.stringify({ reminders: [{ minutes: scope.reminderMinutes }] }),
      ], signal);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      const fetched = await run([
        'calendar', 'events', 'get', '--calendar-id', 'primary', '--event-id', eventId,
      ], signal);
      const event = fetched?.data?.event;
      const reminders = Array.isArray(event?.reminders) ? event.reminders : [];
      if (String(event?.event_id || '') !== eventId || String(event?.summary || '') !== scope.title
        || String(event?.start_time?.timestamp || '') !== scope.startTimestamp
        || String(event?.end_time?.timestamp || '') !== scope.endTimestamp
        || !reminders.some((item) => Number(item?.minutes) === scope.reminderMinutes)) {
        throw calendarError('FEISHU_CALENDAR_READBACK_FAILED');
      }
      return Object.freeze({
        authenticated: true,
        operationId: operation.operationId,
        status: 'succeeded',
        effectId: `feishu-calendar:${createHash('sha256').update(eventId).digest('hex').slice(0, 32)}`,
      });
    },
    validateResult(value, operation) {
      return value?.authenticated === true && value?.operationId === operation?.operationId
        && value?.status === 'succeeded' && /^feishu-calendar:[a-f0-9]{32}$/.test(String(value?.effectId || ''));
    },
    normalizeResult(value) { return { status: value.status, effectId: value.effectId }; },
  });
}

export function normalizeFeishuCalendarCreateScope(value, { timeZone = 'Asia/Shanghai' } = {}) {
  if (!isPlainObject(value) || Object.keys(value).sort().join('|') !== SCOPE_KEYS.join('|')) {
    throw calendarError('FEISHU_CALENDAR_SCOPE_INVALID');
  }
  const title = typeof value.title === 'string' ? value.title.trim() : '';
  const reminderMinutes = value.reminderMinutes;
  if (!title || title.length > 120 || /[\r\n\t\0]/.test(title)
    || !Number.isInteger(reminderMinutes) || reminderMinutes < 0 || reminderMinutes > 10_080) {
    throw calendarError('FEISHU_CALENDAR_SCOPE_INVALID');
  }
  let startInstant;
  let endInstant;
  try {
    startInstant = resolveLocalDateTime(value.date, value.startTime, timeZone);
    endInstant = resolveLocalDateTime(value.date, value.endTime, timeZone);
  } catch {
    throw calendarError('FEISHU_CALENDAR_SCOPE_INVALID');
  }
  if (Date.parse(endInstant) <= Date.parse(startInstant)) throw calendarError('FEISHU_CALENDAR_SCOPE_INVALID');
  return Object.freeze({
    title, date: value.date, startTime: value.startTime, endTime: value.endTime,
    reminderMinutes, timeZone,
    startInstant: new Date(startInstant).toISOString().replace('.000Z', 'Z'),
    endInstant: new Date(endInstant).toISOString().replace('.000Z', 'Z'),
    startTimestamp: String(Date.parse(startInstant) / 1_000),
    endTimestamp: String(Date.parse(endInstant) / 1_000),
  });
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function calendarError(code, cause) {
  const error = new Error(code, cause ? { cause } : undefined);
  error.code = code;
  return error;
}
