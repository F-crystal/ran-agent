import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDurableJob,
  getDurableJobClientConfig,
  normalizeDurableJobReceipt,
  queryDurableJob,
  terminalizeDurableJob,
} from '../src/durableJobClient.mjs';

const RECEIPT = {
  jobId: 'job_1234567890abcdef',
  actorKey: `actor:${'a'.repeat(32)}`,
  goalDigest: 'b'.repeat(64),
  status: 'active',
  nextRunAt: '2026-07-10T10:00:00.000Z',
  terminalStates: ['completed', 'blocked', 'stopped', 'expired'],
};

test('config uses the shared private control secret and loopback Python base URL', () => {
  assert.deepEqual(getDurableJobClientConfig({
    PYTHON_BACKEND_BASE_URL: 'http://127.0.0.2:9876/',
    RAN_AGENT_INTERNAL_CONTROL_SECRET: 'owner-secret',
    DURABLE_JOB_CLIENT_TIMEOUT_MS: '2500',
  }), {
    baseUrl: 'http://127.0.0.2:9876',
    secret: 'owner-secret',
    timeoutMs: 2500,
  });
});

test('create sends only bounded job digests with Bearer auth and returns immutable receipt', async () => {
  let captured;
  const receipt = await createDurableJob({
    actorKey: RECEIPT.actorKey,
    goalDigest: RECEIPT.goalDigest,
    jobKind: 'core.reflection',
    payloadRef: 'payload:reflection',
    nextRunAt: RECEIPT.nextRunAt,
    rawGoal: 'must never cross the private API boundary',
  }, {
    config: { baseUrl: 'http://127.0.0.1:8787', secret: 'owner-secret', timeoutMs: 1000 },
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return jsonResponse({ ok: true, receipt: RECEIPT });
    },
  });

  assert.equal(captured.url, 'http://127.0.0.1:8787/internal/durable-jobs');
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.headers.Authorization, 'Bearer owner-secret');
  assert.deepEqual(JSON.parse(captured.init.body), {
    actorKey: RECEIPT.actorKey,
    goalDigest: RECEIPT.goalDigest,
    jobKind: 'core.reflection',
    payloadRef: 'payload:reflection',
    nextRunAt: RECEIPT.nextRunAt,
  });
  assert.deepEqual(receipt, RECEIPT);
  assert.equal(Object.isFrozen(receipt), true);
  assert.equal(Object.isFrozen(receipt.terminalStates), true);
});

test('query uses exact encoded job route and normalizes terminal receipt', async () => {
  let captured;
  const receipt = await queryDurableJob('job_1234567890abcdef', {
    config: { baseUrl: 'http://[::1]:8787', secret: 'owner-secret', timeoutMs: 1000 },
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return jsonResponse({
        ok: true,
        receipt: { ...RECEIPT, status: 'completed' },
      });
    },
  });

  assert.equal(captured.url, 'http://[::1]:8787/internal/durable-jobs/job_1234567890abcdef');
  assert.equal(captured.init.method, 'GET');
  assert.equal(receipt.status, 'completed');
});

test('external activity job kind and terminal transition use the authenticated private lifecycle', async () => {
  let captured;
  const receipt = await terminalizeDurableJob(RECEIPT.jobId, {
    terminalState: 'stopped',
    resultRef: 'activity:terminal:stopped',
  }, {
    config: { baseUrl: 'http://127.0.0.1:8787', secret: 'owner-secret', timeoutMs: 1000 },
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return jsonResponse({ ok: true, receipt: { ...RECEIPT, status: 'stopped' } });
    },
  });

  assert.equal(captured.url, `http://127.0.0.1:8787/internal/durable-jobs/${RECEIPT.jobId}/terminal`);
  assert.equal(captured.init.method, 'POST');
  assert.deepEqual(JSON.parse(captured.init.body), {
    terminalState: 'stopped',
    resultRef: 'activity:terminal:stopped',
  });
  assert.equal(receipt.status, 'stopped');

  const created = await createDurableJob({
    actorKey: RECEIPT.actorKey,
    goalDigest: RECEIPT.goalDigest,
    jobKind: 'core.external-activity',
    payloadRef: 'activity:autonomy_1234567890abcdef',
    nextRunAt: RECEIPT.nextRunAt,
  }, {
    config: { baseUrl: 'http://127.0.0.1:8787', secret: 'owner-secret', timeoutMs: 1000 },
    fetchImpl: async () => jsonResponse({ ok: true, receipt: RECEIPT }),
  });
  assert.equal(created.jobId, RECEIPT.jobId);
});

test('client rejects missing secret and non-loopback URLs before fetch', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return jsonResponse({ ok: true, receipt: RECEIPT });
  };
  await assert.rejects(
    createDurableJob({
      actorKey: RECEIPT.actorKey,
      goalDigest: RECEIPT.goalDigest,
      jobKind: 'core.reflection',
      payloadRef: 'payload:reflection',
      nextRunAt: RECEIPT.nextRunAt,
    }, {
      config: { baseUrl: 'http://127.0.0.1:8787', secret: '', timeoutMs: 1000 },
      fetchImpl,
    }),
    /private control secret is required/,
  );
  await assert.rejects(
    queryDurableJob(RECEIPT.jobId, {
      config: { baseUrl: 'https://jobs.example.com', secret: 'owner-secret', timeoutMs: 1000 },
      fetchImpl,
    }),
    /loopback/,
  );
  assert.equal(calls, 0);
});

test('receipt normalization rejects widened or malformed authority', async () => {
  assert.throws(
    () => normalizeDurableJobReceipt({ ...RECEIPT, terminalStates: [...RECEIPT.terminalStates, 'failed'] }),
    /invalid durable job receipt/,
  );
  assert.throws(
    () => normalizeDurableJobReceipt({ ...RECEIPT, goalDigest: 'raw user goal' }),
    /invalid durable job receipt/,
  );
  await assert.rejects(
    createDurableJob({ ...RECEIPT, jobKind: 'core.unreviewed-network-work', payloadRef: 'payload:untrusted' }, {
      config: { baseUrl: 'http://127.0.0.1:8787', secret: 'owner-secret', timeoutMs: 1000 },
      fetchImpl: async () => jsonResponse({ ok: true, receipt: RECEIPT }),
    }),
    /invalid durable job jobKind/,
  );
});

test('adapter failures do not echo private response bodies', async () => {
  await assert.rejects(
    queryDurableJob(RECEIPT.jobId, {
      config: { baseUrl: 'http://127.0.0.1:8787', secret: 'owner-secret', timeoutMs: 1000 },
      fetchImpl: async () => jsonResponse({ error: 'Bearer leaked-secret /private/path' }, false, 500),
    }),
    (error) => {
      assert.match(error.message, /HTTP 500/);
      assert.doesNotMatch(error.message, /leaked-secret|private\/path/);
      return true;
    },
  );
});

function jsonResponse(payload, ok = true, status = 200) {
  return {
    ok,
    status,
    async json() { return payload; },
  };
}
