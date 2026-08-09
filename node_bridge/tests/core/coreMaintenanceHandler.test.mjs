import assert from 'node:assert/strict';
import test from 'node:test';

import { createPythonCoreMaintenanceHandler } from '../../src/core/coreMaintenanceHandler.mjs';

const TOKEN = `hmac-sha256:v1:test:${'a'.repeat(64)}`;

test('Python maintenance handler owns only mapped non-visible tasks', async () => {
  const requests = [];
  const handler = createPythonCoreMaintenanceHandler({
    env: { PYTHON_BACKEND_BASE_URL: 'http://127.0.0.1:8787/' },
    hashContent: () => TOKEN,
    fetchImpl: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      return { ok: true, json: async () => ({ status: 'ok' }) };
    },
  });
  const result = await handler({ work: { work_run_id: 'work-1', payload_ref: 'system-task:knowledge-06' } });
  assert.equal(result.resultRef, 'python-maintenance:system-task:knowledge-06:work-1');
  assert.deepEqual(requests, [{
    url: 'http://127.0.0.1:8787/tools/knowledge/run',
    body: { action: 'auto', trigger: 'core_schedule' },
  }]);
  assert.equal(handler.canHandle({ payload_ref: 'system-task:reminder-check' }), false);
  assert.equal(handler.canHandle({ payload_ref: 'system-task:attention-flush' }), false);
});
