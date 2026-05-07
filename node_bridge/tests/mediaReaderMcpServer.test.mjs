import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildMediaReaderTools,
  handleMediaReaderMcpRequest,
} from '../src/mediaReaderMcpServer.mjs';

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

function pngBytes() {
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d,
  ]);
}

function tempCacheEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-reader-cache-'));
  return {
    PERSONAL_AGENT_MEDIA_CACHE_DIR: dir,
    PERSONAL_AGENT_MEDIA_ALLOWED_HOSTS: 'cdn.example.com,media.example.com',
    PERSONAL_AGENT_MEDIA_MAX_BYTES: '1048576',
    PERSONAL_AGENT_MEDIA_DOWNLOAD_TIMEOUT_MS: '1000',
  };
}

test('media reader exposes stable facade tool names with object schemas', () => {
  const tools = buildMediaReaderTools();

  assert.deepEqual(
    tools.map((tool) => tool.name),
    [
      'extract_media_assets',
      'analyze_image',
      'transcribe_audio',
      'analyze_video',
      'analyze_media_batch',
    ]
  );
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
});

test('analyze_image returns structured provider-not-configured error without credentials or provider', async () => {
  const result = await handleMediaReaderMcpRequest(
    {
      method: 'tools/call',
      params: {
        name: 'analyze_image',
        arguments: { url: 'https://cdn.example.com/pic.png' },
      },
    },
    {
      env: tempCacheEnv(),
      fetchImpl: async (url) => responseFromBytes({
        url,
        headers: { 'content-type': 'image/png', 'content-length': String(pngBytes().length) },
        bytes: pngBytes(),
      }),
      resolveHostnameImpl: async () => ['93.184.216.34'],
    }
  );

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.ok, false);
  assert.equal(result.structuredContent.error_code, 'PROVIDER_NOT_CONFIGURED');
});

test('analyze_image uses content-hash based analysis cache', async () => {
  let visionCalls = 0;
  const env = {
    ...tempCacheEnv(),
    PERSONAL_AGENT_VISION_PROVIDER: 'mock',
    PERSONAL_AGENT_OCR_PROVIDER: 'mock',
  };
  const options = {
    env,
    fetchImpl: async (url) => responseFromBytes({
      url,
      headers: { 'content-type': 'image/png', 'content-length': String(pngBytes().length) },
      bytes: pngBytes(),
    }),
    resolveHostnameImpl: async () => ['93.184.216.34'],
    ocrProvider: {
      analyzeImage: async () => ({ text: '图中文字', blocks: [{ text: '图中文字' }], model: 'mock-ocr' }),
    },
    visionProvider: {
      analyzeImage: async () => {
        visionCalls += 1;
        return { summary: '一张测试图片', objects: ['test'], model: 'mock-vlm' };
      },
    },
  };

  const request = {
    method: 'tools/call',
    params: {
      name: 'analyze_image',
      arguments: { url: 'https://cdn.example.com/pic.png', ocr: true, vlm: true },
    },
  };
  const first = await handleMediaReaderMcpRequest(request, options);
  const second = await handleMediaReaderMcpRequest(request, options);

  assert.equal(first.structuredContent.ok, true);
  assert.equal(first.structuredContent.cache_hit, false);
  assert.equal(second.structuredContent.ok, true);
  assert.equal(second.structuredContent.cache_hit, true);
  assert.equal(visionCalls, 1);
  assert.equal(second.structuredContent.content_sha256, first.structuredContent.content_sha256);
});

test('analyze_media_batch returns partial results when one item fails', async () => {
  const result = await handleMediaReaderMcpRequest(
    {
      method: 'tools/call',
      params: {
        name: 'analyze_media_batch',
        arguments: {
          media_detail: 'standard',
          assets: [
            { asset_id: 'img-ok', type: 'image', url: 'https://cdn.example.com/a.png' },
            { asset_id: 'img-bad', type: 'image', url: 'file:///tmp/private.png' },
          ],
        },
      },
    },
    {
      env: {
        ...tempCacheEnv(),
        PERSONAL_AGENT_VISION_PROVIDER: 'mock',
        PERSONAL_AGENT_OCR_PROVIDER: 'mock',
      },
      fetchImpl: async (url) => responseFromBytes({
        url,
        headers: { 'content-type': 'image/png', 'content-length': String(pngBytes().length) },
        bytes: pngBytes(),
      }),
      resolveHostnameImpl: async () => ['93.184.216.34'],
      ocrProvider: { analyzeImage: async () => ({ text: 'ok', blocks: [], model: 'mock-ocr' }) },
      visionProvider: { analyzeImage: async () => ({ summary: 'ok image', objects: [], model: 'mock-vlm' }) },
    }
  );

  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.partial, true);
  assert.equal(result.structuredContent.items.length, 1);
  assert.equal(result.structuredContent.partial_failures.length, 1);
  assert.equal(result.structuredContent.partial_failures[0].asset_id, 'img-bad');
  assert.equal(result.structuredContent.partial_failures[0].error_code, 'URL_BLOCKED');
});
