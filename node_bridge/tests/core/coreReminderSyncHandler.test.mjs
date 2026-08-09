import assert from 'node:assert/strict';
import test from 'node:test';

import { createCoreReminderSyncHandler } from '../../src/core/coreReminderSyncHandler.mjs';

const TOKEN = `hmac-sha256:v1:test:${'a'.repeat(64)}`;

test('reminder sync registers only pending unacknowledged timed todos', async () => {
  const calls = [];
  const handler = createCoreReminderSyncHandler({
    hashContent: () => TOKEN,
    reminderService: { register: async (input) => calls.push(input) },
    fetchImpl: async () => ({ ok: true, json: async () => ({ todos: [
      { id: 1, status: 'pending', reminder_at: '2026-08-09 15:00:00', last_reminded_at: null },
      { id: 2, status: 'done', reminder_at: '2026-08-09 16:00:00', last_reminded_at: null },
      { id: 3, status: 'pending', reminder_at: '2026-08-09 17:00:00', last_reminded_at: '2026-08-09 17:00:01' },
      { id: 4, status: 'pending', reminder_at: null, last_reminded_at: null },
    ] }) }),
  });
  const result = await handler({ work: { work_run_id: 'work-1', payload_ref: 'system-task:reminder-check' } });
  assert.equal(handler.canHandle({ payload_ref: 'system-task:reminder-check' }), true);
  assert.equal(handler.canHandle({ payload_ref: 'system-task:knowledge-06' }), false);
  assert.deepEqual(calls, [{ todoId: 1, scheduledFor: '2026-08-09T07:00:00.000Z' }]);
  assert.equal(result.resultRef, 'core-reminder-sync:work-1:1');
});
