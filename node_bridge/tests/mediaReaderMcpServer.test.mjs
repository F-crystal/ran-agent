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

function wavBytes() {
  return Buffer.from('RIFF0000WAVEfmt ', 'ascii');
}

function mp4Bytes() {
  return Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x18]), Buffer.from('ftypmp42', 'ascii')]);
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

test('analyze_image returns structured dependency error when default PaddleOCR is missing', async () => {
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
  assert.equal(result.structuredContent.error_code, 'DEPENDENCY_MISSING');
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

test('analyze_image uses DashScope OCR and vision adapters when an API key is configured', async () => {
  const requests = [];
  const result = await handleMediaReaderMcpRequest(
    {
      method: 'tools/call',
      params: {
        name: 'analyze_image',
        arguments: { url: 'https://cdn.example.com/pic.png', ocr: true, vlm: true },
      },
    },
    {
      env: {
        ...tempCacheEnv(),
        DASHSCOPE_API_KEY: 'test-key',
        PERSONAL_AGENT_OCR_PROVIDER: 'dashscope-qwen-vl-ocr',
        PERSONAL_AGENT_OCR_MODEL: 'qwen-vl-ocr-2025-11-20',
        PERSONAL_AGENT_VISION_MODEL: 'qwen3-vl-flash',
      },
      fetchImpl: async (url, init = {}) => {
        if (String(url).includes('/compatible-mode/v1/chat/completions')) {
          const body = JSON.parse(String(init.body || '{}'));
          requests.push(body);
          const content = body.model.includes('ocr')
            ? '{"text":"图中文字","blocks":[{"text":"图中文字"}]}'
            : '{"summary":"一张带中文文字的图片","objects":["文字","图片"]}';
          return {
            ok: true,
            status: 200,
            json: async () => ({ choices: [{ message: { content } }] }),
          };
        }
        return responseFromBytes({
          url,
          headers: { 'content-type': 'image/png', 'content-length': String(pngBytes().length) },
          bytes: pngBytes(),
        });
      },
      resolveHostnameImpl: async () => ['93.184.216.34'],
    }
  );

  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.ocr_text, '图中文字');
  assert.equal(result.structuredContent.scene_summary, '一张带中文文字的图片');
  assert.deepEqual(result.structuredContent.objects, ['文字', '图片']);
  assert.deepEqual(requests.map((request) => request.model), ['qwen-vl-ocr-2025-11-20', 'qwen3-vl-flash']);
  assert.match(requests[0].messages[0].content[0].image_url.url, /^data:image\/png;base64,/);
});

test('analyze_image uses PaddleOCR as the default OCR provider before DashScope vision', async () => {
  const requests = [];
  const paddleCalls = [];
  const paddleExecOptions = [];
  const result = await handleMediaReaderMcpRequest(
    {
      method: 'tools/call',
      params: {
        name: 'analyze_image',
        arguments: { url: 'https://cdn.example.com/pic.png', ocr: true, vlm: true },
      },
    },
    {
      env: {
        ...tempCacheEnv(),
        DASHSCOPE_API_KEY: 'test-key',
        PERSONAL_AGENT_OCR_PROVIDER: 'paddleocr',
        PERSONAL_AGENT_PADDLEOCR_COMMAND: 'paddleocr',
      },
      fetchImpl: async (url, init = {}) => {
        if (String(url).includes('/compatible-mode/v1/chat/completions')) {
          const body = JSON.parse(String(init.body || '{}'));
          requests.push(body);
          return {
            ok: true,
            status: 200,
            json: async () => ({ choices: [{ message: { content: '{"summary":"本地 OCR 后的图片摘要","objects":["截图"]}' } }] }),
          };
        }
        return responseFromBytes({
          url,
          headers: { 'content-type': 'image/png', 'content-length': String(pngBytes().length) },
          bytes: pngBytes(),
        });
      },
      resolveHostnameImpl: async () => ['93.184.216.34'],
      execFileImpl: async (command, args, options) => {
        paddleCalls.push([command, ...args]);
        paddleExecOptions.push(options);
        return {
          stdout: JSON.stringify({
            text: '本地识别文字',
            blocks: [{ text: '本地识别文字' }],
          }),
          stderr: '',
        };
      },
    }
  );

  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.ocr_text, '本地识别文字');
  assert.equal(result.structuredContent.model.ocr, 'paddleocr');
  assert.equal(result.structuredContent.scene_summary, '本地 OCR 后的图片摘要');
  assert.equal(paddleCalls.length, 1);
  assert.equal(paddleCalls[0][0], 'paddleocr');
  assert.equal(paddleExecOptions[0].env.FLAGS_use_mkldnn, 'false');
  assert.deepEqual(requests.map((request) => request.model), ['qwen3-vl-flash']);
});

test('transcribe_audio uses DashScope ASR adapter when an API key is configured', async () => {
  const requests = [];
  const result = await handleMediaReaderMcpRequest(
    {
      method: 'tools/call',
      params: {
        name: 'transcribe_audio',
        arguments: { url: 'https://media.example.com/voice.wav', language_hint: 'zh' },
      },
    },
    {
      env: {
        ...tempCacheEnv(),
        DASHSCOPE_API_KEY: 'test-key',
        PERSONAL_AGENT_ASR_MODEL: 'qwen3-asr-flash',
      },
      fetchImpl: async (url, init = {}) => {
        if (String(url).includes('/compatible-mode/v1/chat/completions')) {
          const body = JSON.parse(String(init.body || '{}'));
          requests.push(body);
          return {
            ok: true,
            status: 200,
            json: async () => ({ choices: [{ message: { content: '这是一段语音转写' } }] }),
          };
        }
        return responseFromBytes({
          url,
          headers: { 'content-type': 'audio/wav', 'content-length': String(wavBytes().length) },
          bytes: wavBytes(),
        });
      },
      resolveHostnameImpl: async () => ['93.184.216.34'],
    }
  );

  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.transcript, '这是一段语音转写');
  assert.equal(result.structuredContent.model, 'qwen3-asr-flash');
  assert.equal(requests[0].messages[0].content[0].type, 'input_audio');
  assert.match(requests[0].messages[0].content[0].input_audio.data, /^data:audio\/wav;base64,/);
});

test('analyze_video runs ffprobe ffmpeg frame extraction and DashScope analysis', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-reader-ffmpeg-'));
  const calls = [];
  async function execFileImpl(command, args) {
    calls.push([command, ...args]);
    if (command === '/fake/ffprobe') {
      return {
        stdout: JSON.stringify({
          format: { duration: '6.0', format_name: 'mov,mp4,m4a,3gp,3g2,mj2' },
          streams: [{ codec_type: 'video', width: 640, height: 360 }],
        }),
        stderr: '',
      };
    }
    if (command === '/fake/ffmpeg' && args.includes('-frames:v')) {
      const pattern = args.at(-1);
      fs.writeFileSync(pattern.replace('%03d', '001'), pngBytes());
      return { stdout: '', stderr: '' };
    }
    if (command === '/fake/ffmpeg' && args.includes('-vn')) {
      fs.writeFileSync(args.at(-1), wavBytes());
      return { stdout: '', stderr: '' };
    }
    if (command === 'paddleocr') {
      return { stdout: JSON.stringify({ text: '视频帧文字', blocks: [] }), stderr: '' };
    }
    throw new Error(`unexpected command ${command} ${args.join(' ')}`);
  }

  const result = await handleMediaReaderMcpRequest(
    {
      method: 'tools/call',
      params: {
        name: 'analyze_video',
        arguments: {
          url: 'https://media.example.com/video.mp4',
          max_frames: 1,
          include_audio: true,
          include_ocr: true,
          include_vlm: true,
        },
      },
    },
    {
      env: {
        ...tempCacheEnv(),
        PERSONAL_AGENT_MEDIA_CACHE_DIR: tempDir,
        DASHSCOPE_API_KEY: 'test-key',
        PERSONAL_AGENT_OCR_PROVIDER: 'paddleocr',
        PERSONAL_AGENT_FFPROBE_PATH: '/fake/ffprobe',
        PERSONAL_AGENT_FFMPEG_PATH: '/fake/ffmpeg',
        PERSONAL_AGENT_PADDLEOCR_COMMAND: 'paddleocr',
      },
      fetchImpl: async (url, init = {}) => {
        if (String(url).includes('/compatible-mode/v1/chat/completions')) {
          const body = JSON.parse(String(init.body || '{}'));
          const content = body.model.includes('ocr')
            ? '{"text":"视频帧文字","blocks":[]}'
            : body.model.includes('asr')
              ? '视频音频转写'
              : '{"summary":"视频画面摘要","objects":["画面"]}';
          return {
            ok: true,
            status: 200,
            json: async () => ({ choices: [{ message: { content } }] }),
          };
        }
        return responseFromBytes({
          url,
          headers: { 'content-type': 'video/mp4', 'content-length': String(mp4Bytes().length) },
          bytes: mp4Bytes(),
        });
      },
      resolveHostnameImpl: async () => ['93.184.216.34'],
      execFileImpl,
    }
  );

  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.metadata.duration_seconds, 6);
  assert.equal(result.structuredContent.frames.length, 1);
  assert.equal(result.structuredContent.frames[0].scene_summary, '视频画面摘要');
  assert.equal(result.structuredContent.asr.transcript, '视频音频转写');
  assert.match(result.structuredContent.overall_summary, /视频画面摘要/);
  assert.ok(calls.some((call) => call[0] === '/fake/ffprobe'));
  assert.ok(calls.some((call) => call[0] === '/fake/ffmpeg'));
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
