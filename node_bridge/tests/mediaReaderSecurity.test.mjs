import assert from 'node:assert/strict';
import test from 'node:test';
import { handleMediaReaderMcpRequest } from '../src/mediaReaderMcpServer.mjs';

function env() {
  return {
    PERSONAL_AGENT_MEDIA_ALLOWED_HOSTS: 'cdn.example.com',
    PERSONAL_AGENT_MEDIA_MAX_BYTES: '1048576',
    PERSONAL_AGENT_MEDIA_DOWNLOAD_TIMEOUT_MS: '1000',
  };
}

function responseFromBytes({ url, status = 200, headers = {}, bytes = Buffer.from('') }) {
  const normalizedHeaders = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)])
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: {
      get: (name) => normalizedHeaders[String(name || '').toLowerCase()] || '',
    },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

async function callAnalyzeImage(url, options = {}) {
  return await handleMediaReaderMcpRequest(
    {
      method: 'tools/call',
      params: {
        name: 'analyze_image',
        arguments: { url },
      },
    },
    {
      env: env(),
      ...options,
    }
  );
}

test('media reader blocks file URLs before provider work', async () => {
  const result = await callAnalyzeImage('file:///tmp/private.png');

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error_code, 'URL_BLOCKED');
});

test('media reader blocks private network hosts after DNS resolution', async () => {
  const result = await callAnalyzeImage('https://cdn.example.com/private.png', {
    resolveHostnameImpl: async () => ['127.0.0.1'],
  });

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error_code, 'PRIVATE_NETWORK_BLOCKED');
});

test('media reader re-checks redirects before downloading redirected target', async () => {
  const result = await callAnalyzeImage('https://cdn.example.com/redirect.png', {
    resolveHostnameImpl: async (hostname) => hostname === 'cdn.example.com' ? ['93.184.216.34'] : ['127.0.0.1'],
    fetchImpl: async (url) => responseFromBytes({
      url: 'http://127.0.0.1/private.png',
      status: 200,
      headers: { 'content-type': 'image/png', 'content-length': '12' },
      bytes: Buffer.from('not-reached'),
    }),
  });

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error_code, 'PRIVATE_NETWORK_BLOCKED');
});

test('media reader returns MIME_MISMATCH when bytes do not match declared image type', async () => {
  const result = await callAnalyzeImage('https://cdn.example.com/not-image.png', {
    resolveHostnameImpl: async () => ['93.184.216.34'],
    fetchImpl: async (url) => responseFromBytes({
      url,
      headers: { 'content-type': 'image/png', 'content-length': '8' },
      bytes: Buffer.from('notimage'),
    }),
  });

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error_code, 'MIME_MISMATCH');
});
