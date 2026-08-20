import assert from 'node:assert/strict';
import test from 'node:test';

import { generateSpeechWithQwenOmni, getDashScopeMediaConfig } from '../src/dashscopeMediaClient.mjs';

test('speech generation uses the configured compatible DashScope endpoint', async () => {
  const config = getDashScopeMediaConfig({
    DASHSCOPE_API_KEY: 'test-key',
    DASHSCOPE_COMPAT_BASE_URL: 'https://example.test/compatible-mode/v1/',
  });
  let requestedUrl = '';

  await assert.rejects(
    generateSpeechWithQwenOmni('test', {
      config,
      fetchImpl: async (url) => {
        requestedUrl = String(url);
        return { ok: false, status: 418, json: async () => ({ message: 'expected stop' }) };
      },
    }),
    /expected stop/
  );

  assert.equal(requestedUrl, 'https://example.test/compatible-mode/v1/chat/completions');
});
