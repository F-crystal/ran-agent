import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getBackendIngestConfig,
  ingestExchangeToBackend,
} from '../src/backendIngestClient.mjs';

test('getBackendIngestConfig reads environment variables', () => {
  const config = getBackendIngestConfig({
    PYTHON_BACKEND_INGEST_ENABLED: 'false',
    PYTHON_BACKEND_BASE_URL: 'http://127.0.0.1:9999/',
  });

  assert.equal(config.enabled, false);
  assert.equal(config.baseUrl, 'http://127.0.0.1:9999');
  assert.equal(config.timeoutMs, 5000);
});

test('ingestExchangeToBackend returns ok payload', async () => {
  const response = await ingestExchangeToBackend(
    {
      channel: 'wechat',
      sender_id: 'user-1',
      user_text: '你好',
      reply_text: '收到',
      source: 'hermes',
    },
    {
      config: {
        enabled: true,
        baseUrl: 'http://127.0.0.1:8787',
        timeoutMs: 5000,
      },
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        async json() {
          return { ok: true };
        },
      }),
    }
  );

  assert.equal(response.ok, true);
});

test('ingestExchangeToBackend forwards the durable event id as an idempotency header', async () => {
  let request = null;
  await ingestExchangeToBackend({
    channel: 'wechat',
    sender_id: 'user-1',
    user_text: '你好',
    reply_text: '收到',
    source: 'hermes',
    event_id: 'outbox_0123456789abcdef0123456789abcdef',
  }, {
    config: { enabled: true, baseUrl: 'http://127.0.0.1:8787', timeoutMs: 5000 },
    fetchImpl: async (_url, options) => {
      request = options;
      return { ok: true, status: 200, async json() { return { ok: true }; } };
    },
  });

  assert.equal(request.headers['X-Ran-Agent-Event-Id'], 'outbox_0123456789abcdef0123456789abcdef');
  assert.equal(JSON.parse(request.body).event_id, 'outbox_0123456789abcdef0123456789abcdef');
});
