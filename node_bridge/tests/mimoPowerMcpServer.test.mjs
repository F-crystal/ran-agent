import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildMimoPowerTools,
  buildMimoRequestBody,
  handleMimoPowerMcpRequest,
} from '../src/mimoPowerMcpServer.mjs';

function tempProjectRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mimo-power-project-'));
}

function makeJsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

test('mimo power exposes one high-capability analyze facade with object schema', () => {
  const tools = buildMimoPowerTools();

  assert.deepEqual(tools.map((tool) => tool.name), ['analyze']);
  assert.equal(tools[0].inputSchema.type, 'object');
  assert.equal(tools[0].inputSchema.additionalProperties, false);
  assert.deepEqual(tools[0].inputSchema.required, ['task']);
  assert.ok(tools[0].description.includes('MiMo'));
});

test('buildMimoRequestBody maps mixed multimodal assets into MiMo OpenAI-compatible content parts', () => {
  const body = buildMimoRequestBody({
    task: '深度分析这些素材',
    assets: [
      { type: 'image', url: 'https://cdn.example.com/a.png' },
      { type: 'audio', url: 'https://cdn.example.com/a.wav' },
      { type: 'video', url: 'https://cdn.example.com/a.mp4', fps: 2, media_resolution: 'low' },
    ],
    mode: 'deep',
  }, {
    env: {
      MIMO_POWER_MODEL: 'mimo-v2.5',
      MIMO_POWER_MAX_COMPLETION_TOKENS: '4096',
    },
  });

  assert.equal(body.model, 'mimo-v2.5');
  assert.equal(body.max_completion_tokens, 4096);
  const content = body.messages[1].content;
  assert.deepEqual(content[0], { type: 'image_url', image_url: { url: 'https://cdn.example.com/a.png' } });
  assert.deepEqual(content[1], { type: 'input_audio', input_audio: { data: 'https://cdn.example.com/a.wav' } });
  assert.deepEqual(content[2], {
    type: 'video_url',
    video_url: { url: 'https://cdn.example.com/a.mp4' },
    fps: 2,
    media_resolution: 'low',
  });
  assert.equal(content.at(-1).type, 'text');
  assert.match(content.at(-1).text, /深度分析这些素材/);
  assert.match(content.at(-1).text, /mode: deep/);
});

test('buildMimoRequestBody defaults to mimo-v2.5-pro for power tasks', () => {
  const body = buildMimoRequestBody({ task: '做重任务分析' }, { env: {} });

  assert.equal(body.model, 'mimo-v2.5-pro');
});

test('analyze calls Token Plan endpoint with api-key header and stores a result artifact', async () => {
  const projectRoot = tempProjectRoot();
  const calls = [];
  const result = await handleMimoPowerMcpRequest(
    {
      method: 'tools/call',
      params: {
        name: 'analyze',
        arguments: {
          task: '分析截图',
          assets: [{ type: 'image', url: 'https://cdn.example.com/a.png' }],
        },
      },
    },
    {
      env: {
        RAN_AGENT_ROOT: projectRoot,
        MIMO_TOKEN_PLAN_API_KEY: 'tp-test',
        MIMO_TOKEN_PLAN_OPENAI_BASE_URL: 'https://token-plan-cn.xiaomimimo.com/v1',
        MIMO_POWER_TASK_DIR: path.join(projectRoot, 'debug/mimo_tasks'),
      },
      resolveHostnameImpl: async () => ['93.184.216.34'],
      fetchImpl: async (url, init = {}) => {
        calls.push({ url: String(url), init });
        return makeJsonResponse({
          model: 'mimo-v2.5',
          choices: [{ message: { content: '这是 MiMo 的深度分析结果。', reasoning_content: 'internal trace' } }],
          usage: { total_tokens: 123 },
        });
      },
    }
  );

  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.model, 'mimo-v2.5');
  assert.equal(result.structuredContent.summary, '这是 MiMo 的深度分析结果。');
  assert.equal(result.structuredContent.usage.total_tokens, 123);
  assert.equal(calls[0].url, 'https://token-plan-cn.xiaomimimo.com/v1/chat/completions');
  assert.equal(calls[0].init.headers['api-key'], 'tp-test');
  assert.equal(calls[0].init.headers.Authorization, undefined);
  assert.match(result.structuredContent.artifact_path, /debug\/mimo_tasks\/mimo-/);
  assert.equal(fs.existsSync(result.structuredContent.artifact_path), true);
  assert.match(fs.readFileSync(result.structuredContent.artifact_path, 'utf8'), /这是 MiMo 的深度分析结果/);
});

test('analyze reports unavailable after configured plan expiry', async () => {
  const result = await handleMimoPowerMcpRequest(
    {
      method: 'tools/call',
      params: {
        name: 'analyze',
        arguments: { task: '分析' },
      },
    },
    {
      env: {
        MIMO_TOKEN_PLAN_API_KEY: 'tp-test',
        MIMO_TOKEN_PLAN_OPENAI_BASE_URL: 'https://token-plan-cn.xiaomimimo.com/v1',
        MIMO_TOKEN_PLAN_EXPIRES_AT: '2026-06-09T23:59:00Z',
      },
      now: new Date('2026-06-10T00:00:00Z'),
      fetchImpl: async () => {
        throw new Error('should not call MiMo after expiry');
      },
    }
  );

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.ok, false);
  assert.equal(result.structuredContent.error_code, 'MIMO_TOKEN_PLAN_EXPIRED');
});

test('local file assets are read only from inside the project workspace', () => {
  const projectRoot = tempProjectRoot();
  const imagePath = path.join(projectRoot, 'debug', 'sample.png');
  fs.mkdirSync(path.dirname(imagePath), { recursive: true });
  fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  const body = buildMimoRequestBody({
    task: '看图',
    assets: [{ type: 'image', file_path: imagePath, mime: 'image/png' }],
  }, {
    env: {
      RAN_AGENT_ROOT: projectRoot,
      MIMO_POWER_MODEL: 'mimo-v2.5',
    },
  });

  assert.match(body.messages[1].content[0].image_url.url, /^data:image\/png;base64,/);
  assert.throws(
    () => buildMimoRequestBody({
      task: '越界文件',
      assets: [{ type: 'image', file_path: '/etc/passwd', mime: 'text/plain' }],
    }, { env: { RAN_AGENT_ROOT: projectRoot } }),
    /must stay inside project workspace/
  );
});
