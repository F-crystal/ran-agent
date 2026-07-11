import assert from 'node:assert/strict';
import test from 'node:test';

import { createCoreDurableJobExecutor } from '../src/coreDurableJobExecutor.mjs';

const ACTOR = Object.freeze({
  actorKey: 'actor:wechat:owner:0001',
  owner: true,
  platform: 'wechat',
  conversationKey: 'wechat:dm:owner',
});

test('creates only bridge-derived active Core job receipts for the exact allowlist', async () => {
  const calls = [];
  const executor = createCoreDurableJobExecutor({
    now: () => new Date('2026-07-11T00:00:00.000Z'),
    createJob: async (input) => {
      calls.push(input);
      return {
        jobId: 'job_1234567890abcdef', actorKey: input.actorKey, goalDigest: input.goalDigest,
        status: 'active', nextRunAt: input.nextRunAt,
        terminalStates: ['completed', 'blocked', 'stopped', 'expired'],
      };
    },
  });

  const result = await executor.execute({
    request: { requestRef: 'core-1', actionType: 'core.reflection', scope: { jobId: 'forged', nextRunAt: '2099-01-01T00:00:00.000Z' } },
    actorContext: ACTOR,
    currentMessage: { text: '请你之后反思一下我们这次聊天', request_id: 'untrusted-model-request-id' },
  });

  assert.equal(result.ok, true);
  assert.equal(result.receipt.requestRef, 'core-1');
  assert.equal(result.receipt.actionType, 'core.reflection');
  assert.equal(result.receipt.status, 'active');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].jobKind, 'core.reflection');
  assert.equal(calls[0].actorKey, ACTOR.actorKey);
  assert.match(calls[0].goalDigest, /^[a-f0-9]{64}$/);
  assert.match(calls[0].payloadRef, /^payload:core:[a-f0-9]{64}$/);
  assert.equal(calls[0].nextRunAt, '2026-07-11T00:00:00.000Z');
  assert.notEqual(calls[0].payloadRef, 'forged');
});

test('rejects foreign actors, unregistered kinds, and adapter failures without a promise receipt', async () => {
  let calls = 0;
  const executor = createCoreDurableJobExecutor({
    createJob: async () => { calls += 1; throw new Error('adapter unavailable'); },
  });
  const foreign = await executor.execute({
    request: { requestRef: 'core-foreign', actionType: 'core.reflection', scope: {} },
    actorContext: { ...ACTOR, owner: false }, currentMessage: { text: 'later' },
  });
  assert.deepEqual(foreign, { ok: false, reason: 'ACTOR_NOT_AUTHORIZED', receipt: null });
  const unsupported = await executor.execute({
    request: { requestRef: 'core-unregistered', actionType: 'core.anything', scope: {} },
    actorContext: ACTOR, currentMessage: { text: 'later' },
  });
  assert.deepEqual(unsupported, { ok: false, reason: 'CORE_JOB_UNSUPPORTED', receipt: null });
  const failed = await executor.execute({
    request: { requestRef: 'core-failed', actionType: 'core.reflection', scope: {} },
    actorContext: ACTOR, currentMessage: { text: 'later' },
  });
  assert.deepEqual(failed, { ok: false, reason: 'CORE_JOB_CREATE_FAILED', receipt: null });
  assert.equal(calls, 1);
});

test('does not accept an adapter receipt bound to another actor or job input', async () => {
  const executor = createCoreDurableJobExecutor({
    createJob: async (input) => ({
      jobId: 'job_1234567890abcdef', actorKey: 'actor:other', goalDigest: input.goalDigest,
      status: 'active', nextRunAt: input.nextRunAt,
      terminalStates: ['completed', 'blocked', 'stopped', 'expired'],
    }),
  });
  const result = await executor.execute({
    request: { requestRef: 'core-cross-actor', actionType: 'core.memory-maintenance', scope: {} },
    actorContext: ACTOR, currentMessage: { text: 'later' },
  });
  assert.deepEqual(result, { ok: false, reason: 'CORE_JOB_RECEIPT_INVALID', receipt: null });
});

test('uses the real private durable-job client receipt rather than a model job object', async () => {
  let body;
  const executor = createCoreDurableJobExecutor({
    now: () => new Date('2026-07-11T00:00:00.000Z'),
    env: { RAN_AGENT_INTERNAL_CONTROL_SECRET: 'private-secret', PYTHON_BACKEND_BASE_URL: 'http://127.0.0.1:8787' },
    fetchImpl: async (_url, init) => {
      body = JSON.parse(init.body);
      return {
        ok: true, status: 200,
        async json() {
          return {
            ok: true,
            receipt: {
              jobId: 'job_1234567890abcdef', actorKey: body.actorKey, goalDigest: body.goalDigest,
              status: 'active', nextRunAt: body.nextRunAt,
              terminalStates: ['completed', 'blocked', 'stopped', 'expired'],
            },
          };
        },
      };
    },
  });

  const result = await executor.execute({
    request: { requestRef: 'real-client-1', actionType: 'core.night-cycle', scope: { actorKey: 'forged' } },
    actorContext: ACTOR, currentMessage: { text: '今晚总结一下' },
  });

  assert.equal(result.ok, true);
  assert.equal(result.receipt.jobId, 'job_1234567890abcdef');
  assert.equal(body.actorKey, ACTOR.actorKey);
  assert.equal(body.jobKind, 'core.night-cycle');
  assert.equal('jobId' in body, false);
});
