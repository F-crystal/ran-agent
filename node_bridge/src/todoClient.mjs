const ACTION_TYPE = 'todo.create';
const MODEL_SCOPE_KEYS = ['date', 'endTime', 'reminderMinutes', 'startTime', 'title'];
const RESPONSE_KEYS = ['authenticated', 'effectId', 'ok', 'operationId', 'result'];
const RESULT_KEYS = ['coreRegistration', 'reminderAt', 'todoId'];
const OPERATION_ID = /^op_[a-f0-9]{32}$/;
const MAX_TITLE_CHARS = 200;
const MAX_REMINDER_MINUTES = 10_080;

export function createTodoExecutorAdapter({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const baseUrl = String(env.PYTHON_BACKEND_BASE_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
  const secret = String(env.RAN_AGENT_INTERNAL_CONTROL_SECRET || '');
  const timeZone = runtimeTimeZone(env);
  if (!/^https?:\/\/127\.0\.0\.1(?::\d+)?$/.test(baseUrl)
    || !secret || /\s/.test(secret) || typeof fetchImpl !== 'function') {
    throw todoError('TODO_ADAPTER_CONFIG');
  }

  return Object.freeze({
    issuer: 'bridge:python-todo-adapter',
    actionTypes: [ACTION_TYPE],
    evidenceType: 'todo_core_registration',
    boundary: 'authenticated_private',
    async execute({ operation, signal } = {}) {
      if (!operation || operation.actionType !== ACTION_TYPE || !OPERATION_ID.test(String(operation.operationId || ''))) {
        throw todoError('TODO_ACTION_INVALID');
      }
      const scope = normalizeTodoCreateScope(operation.scope, { timeZone });
      const response = await fetchImpl(`${baseUrl}/internal/todo/actions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ operationId: operation.operationId, actionType: ACTION_TYPE, scope }),
        signal,
      });
      let payload;
      try {
        payload = await response.json();
      } catch {
        throw todoError('TODO_RESPONSE_INVALID');
      }
      if (response?.ok !== true) throw todoError('TODO_CREATE_FAILED');
      return normalizeResponse(payload, operation.operationId, scope.reminderAt);
    },
    validateResult(value, operation) {
      try {
        const scope = normalizeTodoCreateScope(operation?.scope, { timeZone });
        normalizeResponse(value, String(operation?.operationId || ''), scope.reminderAt);
        return true;
      } catch {
        return false;
      }
    },
    normalizeResult(value) {
      return { status: 'succeeded', effectId: value.effectId };
    },
  });
}

export function normalizeTodoCreateScope(value, { timeZone = 'Asia/Shanghai' } = {}) {
  if (!isPlainObject(value) || Object.keys(value).sort().join('|') !== MODEL_SCOPE_KEYS.join('|')) {
    throw todoError('TODO_SCOPE_INVALID');
  }
  const title = typeof value.title === 'string' ? value.title.trim() : '';
  const date = typeof value.date === 'string' ? value.date : '';
  const startTime = validClock(value.startTime);
  const endTime = validClock(value.endTime);
  const reminderMinutes = value.reminderMinutes;
  if (!title || title.length > MAX_TITLE_CHARS || /[\r\n\t\0]/.test(title)
    || !validDate(date) || !startTime || !endTime
    || clockMinutes(endTime) <= clockMinutes(startTime)
    || !Number.isInteger(reminderMinutes)
    || reminderMinutes < 0 || reminderMinutes > MAX_REMINDER_MINUTES) {
    throw todoError('TODO_SCOPE_INVALID');
  }
  assertTimeZone(timeZone);
  const reminderAt = deriveReminderAt(date, startTime, reminderMinutes);
  return Object.freeze({
    title,
    date,
    startTime,
    endTime,
    reminderMinutes,
    reminderAt,
    timeZone,
    content: `${title}（${date} ${startTime}–${endTime}）`,
  });
}

function normalizeResponse(value, operationId, reminderAt) {
  if (!isPlainObject(value) || Object.keys(value).sort().join('|') !== RESPONSE_KEYS.join('|')
    || value.ok !== true || value.authenticated !== true || value.operationId !== operationId
    || typeof value.effectId !== 'string' || value.effectId.length < 8 || value.effectId.length > 180
    || !isPlainObject(value.result) || Object.keys(value.result).sort().join('|') !== RESULT_KEYS.join('|')
    || !Number.isInteger(value.result.todoId) || value.result.todoId <= 0
    || value.result.reminderAt !== reminderAt || value.result.coreRegistration !== 'registered') {
    throw todoError('TODO_RESPONSE_INVALID');
  }
  return Object.freeze(value);
}

function deriveReminderAt(date, startTime, reminderMinutes) {
  const instant = new Date(`${date}T${startTime}:00.000Z`).getTime() - reminderMinutes * 60_000;
  return new Date(instant).toISOString().slice(0, 16).replace('T', ' ') + ':00';
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validClock(value) {
  if (typeof value !== 'string' || !/^\d{2}:\d{2}$/.test(value)) return '';
  const [hour, minute] = value.split(':').map(Number);
  return hour <= 23 && minute <= 59 ? value : '';
}

function clockMinutes(value) {
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
}

function runtimeTimeZone(env) {
  return String(env.HERMES_ENVIRONMENT_TIMEZONE || 'Asia/Shanghai').trim();
}

function assertTimeZone(value) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date(0));
  } catch {
    throw todoError('TODO_TIMEZONE_INVALID');
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function todoError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
