import test from 'node:test';
import assert from 'node:assert/strict';

import { createTodoExecutorAdapter, normalizeTodoCreateScope } from '../src/todoClient.mjs';

const ENV = {
  PYTHON_BACKEND_BASE_URL: 'http://127.0.0.1:8787',
  RAN_AGENT_INTERNAL_CONTROL_SECRET: 'private-secret',
  HERMES_ENVIRONMENT_TIMEZONE: 'Asia/Shanghai',
};
const OPERATION_ID = `op_${'a'.repeat(32)}`;
const VALID_SCOPE = {
  title: '线下活动',
  date: '2026-08-21',
  startTime: '08:55',
  endTime: '14:00',
  reminderMinutes: 30,
};

test('todo.create derives the canonical reminder and calls the authenticated Todo boundary once', async () => {
  const calls = [];
  const adapter = createTodoExecutorAdapter({
    env: ENV,
    fetchImpl: async (url, init) => {
      const request = JSON.parse(init.body);
      calls.push({ url, init, request });
      return {
        ok: true,
        async json() {
          return {
            ok: true,
            authenticated: true,
            operationId: request.operationId,
            effectId: 'todo:create:1',
            result: { todoId: 1, reminderAt: request.scope.reminderAt, coreRegistration: 'registered' },
          };
        },
      };
    },
  });

  const result = await adapter.execute({ operation: {
    operationId: OPERATION_ID,
    actionType: 'todo.create',
    scope: VALID_SCOPE,
  } });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:8787/internal/todo/actions');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer private-secret');
  assert.deepEqual(calls[0].request.scope, {
    ...VALID_SCOPE,
    reminderAt: '2026-08-21 08:25:00',
    timeZone: 'Asia/Shanghai',
    content: '线下活动（2026-08-21 08:55–14:00）',
  });
  assert.equal(result.result.coreRegistration, 'registered');
});

test('todo.create reminder arithmetic crosses to the previous local date', () => {
  const scope = normalizeTodoCreateScope({
    title: '凌晨出发',
    date: '2026-08-21',
    startTime: '00:15',
    endTime: '01:00',
    reminderMinutes: 30,
  });

  assert.equal(scope.reminderAt, '2026-08-20 23:45:00');
});

test('todo.create rejects invalid or model-owned extra scope before any effect', async () => {
  let calls = 0;
  const adapter = createTodoExecutorAdapter({
    env: ENV,
    fetchImpl: async () => { calls += 1; throw new Error('must not call Python'); },
  });
  const invalidScopes = [
    { ...VALID_SCOPE, date: '2026-02-30' },
    { ...VALID_SCOPE, startTime: '24:00' },
    { ...VALID_SCOPE, endTime: '08:55' },
    { ...VALID_SCOPE, reminderTime: '08:25' },
    { ...VALID_SCOPE, privateField: 'forbidden' },
  ];

  for (const scope of invalidScopes) {
    await assert.rejects(adapter.execute({ operation: {
      operationId: OPERATION_ID,
      actionType: 'todo.create',
      scope,
    } }), { code: 'TODO_SCOPE_INVALID' });
  }
  assert.equal(calls, 0);
});
