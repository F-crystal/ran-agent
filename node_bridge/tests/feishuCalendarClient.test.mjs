import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createFeishuCalendarExecutorAdapter,
  normalizeFeishuCalendarCreateScope,
} from '../src/feishuCalendarClient.mjs';

const SCOPE = {
  title: '剧本杀', date: '2026-08-22', startTime: '08:55', endTime: '14:00', reminderMinutes: 30,
};
const OPERATION = { operationId: `op_${'a'.repeat(32)}`, actionType: 'feishu.calendar.create', scope: SCOPE };

test('calendar adapter creates, patches the reminder, and verifies readback as the user identity', async () => {
  const calls = [];
  const responses = [
    { ok: true, identity: 'user', data: { event: { event_id: 'evt_verified_1' } } },
    { ok: true, identity: 'user', data: {} },
    { ok: true, identity: 'user', data: { event: {
      event_id: 'evt_verified_1', summary: '剧本杀',
      start_time: { timestamp: String(Date.parse('2026-08-22T00:55:00.000Z') / 1_000) },
      end_time: { timestamp: String(Date.parse('2026-08-22T06:00:00.000Z') / 1_000) },
      reminders: [{ minutes: 30 }],
    } } },
  ];
  const adapter = createFeishuCalendarExecutorAdapter({
    env: { FEISHU_LARK_CLI_BIN: '/runtime/lark-cli', HERMES_ENVIRONMENT_TIMEZONE: 'Asia/Shanghai' },
    execFileImpl: async (command, args) => {
      calls.push([command, args]);
      return { stdout: JSON.stringify(responses[calls.length - 1]) };
    },
  });

  const result = await adapter.execute({ operation: OPERATION });

  assert.equal(result.status, 'succeeded');
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0][1].slice(0, 4), ['calendar', '+create', '--calendar-id', 'primary']);
  assert.ok(calls[0][1].includes('2026-08-22T00:55:00Z'));
  assert.deepEqual(calls[1][1].slice(0, 3), ['calendar', 'events', 'patch']);
  assert.deepEqual(JSON.parse(calls[1][1][calls[1][1].indexOf('--data') + 1]), { reminders: [{ minutes: 30 }] });
  assert.deepEqual(calls[2][1].slice(0, 3), ['calendar', 'events', 'get']);
  assert.ok(calls.every(([, args]) => args.slice(-4).join('|') === '--format|json|--as|user'));
});

test('calendar scope rejects invalid intervals and extra model fields', () => {
  assert.throws(
    () => normalizeFeishuCalendarCreateScope({ ...SCOPE, endTime: '08:55' }),
    (error) => error?.code === 'FEISHU_CALENDAR_SCOPE_INVALID',
  );
  assert.throws(
    () => normalizeFeishuCalendarCreateScope({ ...SCOPE, reminderTime: '08:25' }),
    (error) => error?.code === 'FEISHU_CALENDAR_SCOPE_INVALID',
  );
});

test('calendar adapter does not verify success when create, patch, or readback fails', async (t) => {
  for (const failingCall of [1, 2, 3]) {
    await t.test(`call ${failingCall}`, async () => {
      let calls = 0;
      const adapter = createFeishuCalendarExecutorAdapter({
        env: { FEISHU_LARK_CLI_BIN: '/runtime/lark-cli', HERMES_ENVIRONMENT_TIMEZONE: 'Asia/Shanghai' },
        execFileImpl: async () => {
          calls += 1;
          if (calls === failingCall) throw Object.assign(new Error('failed'), { code: 'EIO' });
          if (calls === 1) return { stdout: JSON.stringify({ ok: true, identity: 'user', data: { event: { event_id: 'evt_verified_1' } } }) };
          return { stdout: JSON.stringify({ ok: true, identity: 'user', data: { event: {} } }) };
        },
      });
      await assert.rejects(adapter.execute({ operation: OPERATION }));
    });
  }
});
