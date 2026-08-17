import assert from 'node:assert/strict';
import test from 'node:test';

process.env.HERMES_SEMANTIC_VERIFIER_TEST_BYPASS = 'true';

import { createReplyBackend } from '../src/replyBackend.mjs';
import { createIsolatedTestEnv } from './helpers/isolatedState.mjs';

const OWNER_MESSAGE = {
  id: 'owner-message-calendar-replan-1',
  text: '8月22日 8:55 到 14:00 我有活动《七月十三日》，加到日程',
  sender_id: 'owner',
  conversation_id: 'owner-conversation',
  channel: 'wechat',
  trusted_actor_context: {
    actorKey: 'actor:wechat:owner:0001',
    owner: true,
    platform: 'wechat',
    conversationKey: 'wechat:dm:conversation',
  },
};

const SCOPE = {
  title: '七月十三日', date: '2026-08-22', startTime: '08:55', endTime: '14:00', reminderMinutes: 30,
};

const ENVELOPE_INVALID_REPLY = {
  reply_text: '回复格式校验失败，请稍后重试。',
  follow_up_messages: [],
  media: null,
  envelope_error_code: 'HERMES_PRIVATE_REPLY_ENVELOPE_INVALID',
};

function env(t) {
  return createIsolatedTestEnv(t, {
    HERMES_ACTION_GATE_ENABLED: 'true',
    HERMES_ACTION_GATE_MODE: 'enforce',
    FEISHU_LARK_CLI_BIN: 'lark-cli',
  }, 'calendar-replan-');
}

function calendarEnvelope(actionOverrides = {}) {
  return {
    reply_envelope: {
      schemaVersion: 1,
      message: '好的。',
      actionRequests: [{ requestRef: 'calendar-replan-1', actionType: 'feishu.calendar.create', scope: { ...SCOPE }, ...actionOverrides }],
      activityRequest: null,
      claims: [],
      commitments: [],
    },
  };
}

function successfulCalendarExec(calls) {
  const responses = [
    { ok: true, identity: 'user', data: { event: { event_id: 'evt_replan_1' } } },
    { ok: true, identity: 'user', data: {} },
    { ok: true, identity: 'user', data: { event: {
      event_id: 'evt_replan_1', summary: '七月十三日',
      start_time: { timestamp: String(Date.parse('2026-08-22T00:55:00.000Z') / 1_000) },
      end_time: { timestamp: String(Date.parse('2026-08-22T06:00:00.000Z') / 1_000) },
      reminders: [{ minutes: 30 }],
    } } },
  ];
  return async (command, args) => {
    calls.push([command, args]);
    return { stdout: JSON.stringify(responses[calls.length - 1]) };
  };
}

function failingExec(calls) {
  return async (command, args) => {
    calls.push([command, args]);
    throw new Error('must not execute');
  };
}

test('an envelope-invalid calendar reply receives one strict replan and then executes feishu.calendar.create', async (t) => {
  const calls = [];
  const inputs = [];
  let attempt = 0;
  const backend = createReplyBackend({
    env: env(t),
    execFileImpl: successfulCalendarExec(calls),
    hermesImpl: async (input) => {
      inputs.push(input);
      attempt += 1;
      if (attempt === 1) return ENVELOPE_INVALID_REPLY;
      return calendarEnvelope();
    },
    ingestImpl: async () => ({ ok: true }),
    logger: { log() {}, warn() {} },
  });

  const result = await backend.getReply(OWNER_MESSAGE);

  assert.equal(result.replyText, '已写入飞书日历并校验：“七月十三日”，2026-08-22 08:55–14:00，提前 30 分钟提醒。');
  assert.equal(inputs.length, 2);
  assert.match(inputs[1].continuity_note, /NODE_ACTION_REPLAN/);
  assert.match(inputs[1].continuity_note, /Never use schedule\.create/);
  assert.deepEqual(calls.map(([, args]) => args.slice(0, 2)), [
    ['calendar', '+create'],
    ['calendar', 'events'],
    ['calendar', 'events'],
  ]);
});

test('a calendar replan repeating the retired incident contract fails closed without execution', async (t) => {
  const calls = [];
  let attempt = 0;
  const backend = createReplyBackend({
    env: env(t),
    execFileImpl: failingExec(calls),
    hermesImpl: async () => {
      attempt += 1;
      if (attempt === 1) return ENVELOPE_INVALID_REPLY;
      return calendarEnvelope({
        id: 'evt_model_invented',
        actionType: 'schedule.create',
        scope: { title: '七月十三日', date: '2026-08-22', startTime: '08:55', endTime: '14:00', reminderTime: '08:25' },
      });
    },
    ingestImpl: async () => ({ ok: true }),
    logger: { log() {}, warn() {} },
  });

  const result = await backend.getReply(OWNER_MESSAGE);

  assert.equal(result.replyText, '回复格式校验失败，请稍后重试。');
  assert.equal(attempt, 2);
  assert.equal(calls.length, 0);
});

test('a calendar replan with a valid envelope but a retired action type fails closed without execution', async (t) => {
  const calls = [];
  let attempt = 0;
  const backend = createReplyBackend({
    env: env(t),
    execFileImpl: failingExec(calls),
    hermesImpl: async () => {
      attempt += 1;
      if (attempt === 1) return ENVELOPE_INVALID_REPLY;
      return calendarEnvelope({
        actionType: 'schedule.create',
        scope: { title: '七月十三日', date: '2026-08-22', startTime: '08:55', endTime: '14:00', reminderMinutes: 30 },
      });
    },
    ingestImpl: async () => ({ ok: true }),
    logger: { log() {}, warn() {} },
  });

  const result = await backend.getReply(OWNER_MESSAGE);

  assert.equal(result.replyText, '回复格式校验失败，请稍后重试。');
  assert.equal(attempt, 2);
  assert.equal(calls.length, 0);
});

test('an envelope-invalid reply without calendar intent is not replanned', async (t) => {
  const calls = [];
  let attempt = 0;
  const backend = createReplyBackend({
    env: env(t),
    execFileImpl: failingExec(calls),
    hermesImpl: async () => {
      attempt += 1;
      return ENVELOPE_INVALID_REPLY;
    },
    ingestImpl: async () => ({ ok: true }),
    logger: { log() {}, warn() {} },
  });

  const result = await backend.getReply({ ...OWNER_MESSAGE, text: '今天有什么 AI 新闻？' });

  assert.equal(result.replyText, '回复格式校验失败，请稍后重试。');
  assert.equal(attempt, 1);
  assert.equal(calls.length, 0);
});

test('a calendar replan whose scope fails normalization never reaches the adapter', async (t) => {
  const calls = [];
  let attempt = 0;
  const backend = createReplyBackend({
    env: env(t),
    execFileImpl: failingExec(calls),
    hermesImpl: async () => {
      attempt += 1;
      if (attempt === 1) return ENVELOPE_INVALID_REPLY;
      return calendarEnvelope({ scope: { ...SCOPE, endTime: '07:00' } });
    },
    ingestImpl: async () => ({ ok: true }),
    logger: { log() {}, warn() {} },
  });

  const result = await backend.getReply(OWNER_MESSAGE);

  assert.equal(result.replyText, '飞书日程创建或校验失败，未确认已写入日历。');
  assert.equal(attempt, 2);
  assert.equal(calls.length, 0);
});
