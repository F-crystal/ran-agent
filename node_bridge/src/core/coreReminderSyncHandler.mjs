import { coreError } from './coreErrors.mjs';
import { createCoreReminderService } from './coreReminderService.mjs';
import { legacyReminderInstant } from './coreScheduleMigration.mjs';

export function createCoreReminderSyncHandler({
  core,
  env = process.env,
  fetchImpl = globalThis.fetch,
  hashContent,
  reminderService,
  now = () => new Date(),
  timeoutMs = 30_000,
} = {}) {
  if ((!core && !reminderService) || typeof fetchImpl !== 'function' || typeof hashContent !== 'function') {
    throw coreError('CORE_REMINDER_SYNC_DEPENDENCY_INVALID', 'reminder sync requires Core, Python HTTP and a content hasher');
  }
  const reminders = reminderService || createCoreReminderService({ core, now });
  const baseUrl = String(env.PYTHON_BACKEND_BASE_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
  const handler = async ({ work }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(`${baseUrl}/tools/todo/list`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: '{}', signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!response?.ok) throw coreError('CORE_REMINDER_SYNC_REQUEST_FAILED', 'todo reminder scan failed');
    const payload = await response.json();
    const candidates = Array.isArray(payload?.todos) ? payload.todos : [];
    let registered = 0;
    for (const todo of candidates) {
      if (todo?.status !== 'pending' || todo?.last_reminded_at || !todo?.reminder_at) continue;
      const scheduledFor = legacyReminderInstant(todo.reminder_at);
      if (!scheduledFor) throw coreError('CORE_REMINDER_TIME_INVALID', 'todo reminder has an invalid time');
      await reminders.register({ todoId: todo.id, scheduledFor });
      registered += 1;
    }
    const resultRef = `core-reminder-sync:${work.work_run_id}:${registered}`;
    return Object.freeze({ resultRef, resultHashToken: hashContent('core-reminder-sync', resultRef) });
  };
  handler.canHandle = (work) => work?.payload_ref === 'system-task:reminder-check';
  return handler;
}
