import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const OPENCLAW_CONFIG_PATH = new URL('../../openclaw/openclaw.personal-system.json', import.meta.url);
const PROJECT_ROOT = path.resolve(new URL('../..', import.meta.url).pathname);

import {
  buildTemporalContext,
  getOpenClawGatewayConfig,
  sendChatToOpenClawAgent,
  sendChatToOpenClawGateway,
} from '../src/openclawGatewayClient.mjs';
import {
  buildStructuredUrlContext,
  extractStructuredContentFromHtml,
  extractUrlsFromText,
  resolvePlaywrightLaunchOptions,
  shouldUsePlaywrightStructuredExtraction,
} from '../src/webStructuredExtract.mjs';
import {
  handleMediaGenerationMcpRequest,
} from '../src/mediaGenerationMcpServer.mjs';

function makeTempFile(filename, contents) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-media-'));
  const filePath = path.join(tempDir, filename);
  fs.writeFileSync(filePath, contents);
  return { tempDir, filePath };
}

function makeJsonResponse(body, ok = true, status = 200) {
  return {
    ok,
    status,
    headers: {
      get() {
        return 'application/json';
      },
    },
    async json() {
      return body;
    },
  };
}

function makeSseResponse(events, ok = true, status = 200) {
  const encoder = new TextEncoder();
  return {
    ok,
    status,
    headers: {
      get(name) {
        return String(name || '').toLowerCase() === 'content-type' ? 'text/event-stream' : null;
      },
    },
    body: new ReadableStream({
      start(controller) {
        for (const event of events) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    }),
  };
}

function getUserMessageContent(body) {
  return body?.messages?.find?.((item) => item?.role === 'user')?.content;
}

function getSystemText(body, pattern) {
  return body?.messages
    ?.filter?.((item) => item?.role === 'system')
    ?.map((item) => String(item.content || ''))
    ?.find((text) => pattern.test(text)) || '';
}

test('getOpenClawGatewayConfig ignores backend model override unless explicitly enabled', () => {
  const config = getOpenClawGatewayConfig({
    OPENCLAW_GATEWAY_BASE_URL: 'http://127.0.0.1:19123/',
    OPENCLAW_GATEWAY_TOKEN: 'abc',
    OPENCLAW_GATEWAY_MODEL: 'openclaw/default',
    OPENCLAW_BACKEND_MODEL: 'qwen/qwen3.5-plus',
    OPENCLAW_GATEWAY_AUDIO_MODEL: 'whisper-large-v3',
  });

  assert.equal(config.baseUrl, 'http://127.0.0.1:19123');
  assert.equal(config.token, 'abc');
  assert.equal(config.model, 'openclaw/default');
  assert.equal(config.modelOverride, '');
  assert.equal(config.audioModel, 'whisper-large-v3');
  assert.equal(config.imageModel, 'qwen-image');
  assert.equal(config.speechModel, 'qwen3-omni-flash');
});

test('getOpenClawGatewayConfig allows backend model override when explicitly enabled', () => {
  const config = getOpenClawGatewayConfig({
    OPENCLAW_GATEWAY_BASE_URL: 'http://127.0.0.1:19123/',
    OPENCLAW_GATEWAY_TOKEN: 'abc',
    OPENCLAW_GATEWAY_MODEL: 'openclaw/default',
    OPENCLAW_BACKEND_MODEL: 'qwen/qwen3.5-plus',
    OPENCLAW_ALLOW_BACKEND_MODEL_OVERRIDE: 'true',
  });

  assert.equal(config.model, 'openclaw/default');
  assert.equal(config.modelOverride, 'qwen/qwen3.5-plus');
});

test('getOpenClawGatewayConfig accepts QWEN_API_KEY as direct generation token fallback', () => {
  const config = getOpenClawGatewayConfig({
    QWEN_API_KEY: 'sk-qwen-only',
  });

  assert.equal(config.directApiToken, 'sk-qwen-only');
});

test('openclaw config exposes live lookup and gateway exec tools while todo handling stays bridge-managed', () => {
  const config = JSON.parse(fs.readFileSync(OPENCLAW_CONFIG_PATH, 'utf8'));
  const rootAllow = config.tools?.allow || [];
  const agentAllow = config.agents?.list?.[0]?.tools?.allow || [];

  assert.deepEqual(rootAllow, ['web_search', 'web_fetch', 'session_status', 'exec', 'process']);
  assert.deepEqual(agentAllow, ['read', 'web_search', 'web_fetch', 'session_status', 'exec', 'process']);
  assert.equal(config.tools?.web?.search?.provider, 'tavily');
  assert.equal(config.tools?.exec?.host, 'gateway');
  assert.deepEqual(config.tools?.exec?.pathPrepend, ['/usr/local/bin', '/usr/bin', '/bin']);
  assert.equal(config.plugins?.entries?.tavily?.enabled, true);
  assert.equal(config.plugins?.entries?.['todo-tools']?.enabled, false);
  assert.equal(rootAllow.includes('create_todo'), false);
  assert.equal(rootAllow.includes('list_todos'), false);
  assert.equal(agentAllow.includes('create_todo'), false);
  assert.equal(agentAllow.includes('list_todos'), false);
});

test('openclaw config registers media generation MCP so OpenClaw owns media tool calls', () => {
  const config = JSON.parse(fs.readFileSync(OPENCLAW_CONFIG_PATH, 'utf8'));
  const mcpServers = config.mcp?.servers || {};

  assert.ok(mcpServers.time);
  assert.deepEqual(mcpServers.media_generation, {
    command: 'bash',
    args: ['scripts/start_media_generation_mcp.sh'],
  });
  assert.deepEqual(mcpServers.social_reader, {
    command: 'bash',
    args: ['scripts/start_social_reader_mcp.sh'],
  });
});

test('openclaw config keeps the personal-system agent on the tool-capable Claude settings provider path', () => {
  const config = JSON.parse(fs.readFileSync(OPENCLAW_CONFIG_PATH, 'utf8'));
  const defaultsModel = config.agents?.defaults?.model || {};
  const listedAgentModel = config.agents?.list?.[0]?.model || {};
  const listedAgent = config.agents?.list?.[0] || {};
  const defaults = config.agents?.defaults || {};
  const claudeCliBackend = config.agents?.defaults?.cliBackends?.['claude-cli'] || {};
  const claudeProvider = config.models?.providers?.claude_code || {};
  const bootstrapHook = config.hooks?.internal?.entries?.['bootstrap-extra-files'] || {};
  const providerModelIds = (claudeProvider.models || []).map((item) => item.id);

  assert.equal(defaultsModel.primary, 'qwen3.5-plus');
  assert.deepEqual(defaultsModel.fallbacks, []);
  assert.equal(listedAgent.id, 'personal-system');
  assert.equal(listedAgent.default, true);
  assert.equal(listedAgentModel.primary, 'qwen3.5-plus');
  assert.deepEqual(listedAgentModel.fallbacks, []);
  assert.equal(defaults.heartbeat?.every, '90m');
  assert.equal(listedAgent.heartbeat?.every, '90m');
  assert.equal(defaults.contextInjection, 'continuation-skip');
  assert.equal(defaults.contextPruning?.mode, 'cache-ttl');
  assert.equal(defaults.contextPruning?.ttl, '10m');
  assert.equal(defaults.contextPruning?.minPrunableToolChars, 12000);
  assert.equal(defaults.compaction?.mode, 'safeguard');
  assert.equal(defaults.params?.cacheRetention, 'short');
  assert.equal(defaults.blockStreamingDefault, 'on');
  assert.equal(claudeCliBackend.command, 'claude');
  assert.equal(claudeProvider.api, 'anthropic-messages');
  assert.equal(claudeProvider.baseUrl, '${ANTHROPIC_BASE_URL}');
  assert.equal(claudeProvider.apiKey, '${ANTHROPIC_AUTH_TOKEN}');
  assert.deepEqual(providerModelIds, ['qwen3.5-plus', 'qwen3.6-plus', 'qwen-image', 'qwen3-omni-flash']);
  assert.equal(
    providerModelIds.some((id) => /qwen3\.(5|6)-plus-\d{4}-\d{2}-\d{2}$/.test(id)),
    false
  );
  assert.equal(claudeProvider.models.find((item) => item.id === 'qwen3.5-plus')?.contextWindow, 120000);
  assert.equal(claudeProvider.models.find((item) => item.id === 'qwen3.6-plus')?.contextWindow, 120000);
  assert.equal(claudeProvider.models.find((item) => item.id === 'qwen3.5-plus')?.cost?.input, 0.117);
  assert.equal(claudeProvider.models.find((item) => item.id === 'qwen3.5-plus')?.cost?.output, 0.704);
  assert.equal(claudeProvider.models.find((item) => item.id === 'qwen3.6-plus')?.cost?.input, 0.293);
  assert.equal(claudeProvider.models.find((item) => item.id === 'qwen3.6-plus')?.cost?.output, 1.76);
  assert.deepEqual(
    claudeProvider.models.find((item) => item.id === 'qwen3-omni-flash')?.input,
    ['text', 'image']
  );
  assert.equal(config.hooks?.internal?.enabled, true);
  assert.equal(bootstrapHook.enabled, true);
  assert.deepEqual(bootstrapHook.paths, ['openclaw/AGENTS.md']);
});

test('sendChatToOpenClawGateway returns parsed reply payload', async () => {
  let capturedBody = null;
  let capturedHeaders = null;
  const response = await sendChatToOpenClawGateway(
    { text: '你好', sender_id: 'user-1', channel: 'wechat' },
    {
      config: {
        baseUrl: 'http://127.0.0.1:19123',
        token: 'abc',
        model: 'openclaw/personal-system',
        modelOverride: '',
        audioModel: 'whisper-1',
      },
      fetchImpl: async (_, init) => {
        capturedHeaders = init?.headers || null;
        capturedBody = init?.body ? JSON.parse(init.body) : null;
        return makeJsonResponse({
          model: 'openclaw/personal-system',
          choices: [{ message: { content: '收到' } }],
        });
      },
    }
  );

  assert.equal(response.reply_text, '收到');
  assert.equal(capturedBody?.model, 'openclaw/personal-system');
  assert.equal(capturedHeaders?.['x-openclaw-model'], undefined);
});

test('sendChatToOpenClawAgent invokes OpenClaw agent runtime and returns MCP marker text', async () => {
  let capturedCommand = '';
  let capturedArgs = [];
  let capturedOptions = null;
  const response = await sendChatToOpenClawAgent(
    { text: '帮我画一只边牧', sender_id: 'user-agent-image', channel: 'wechat' },
    {
      env: {
        RAN_AGENT_ROOT: '/opt/ran_agent',
        OPENCLAW_CONFIG: '/opt/ran_agent/openclaw/openclaw.personal-system.json',
      },
      execFileImpl: async (command, args, options) => {
        capturedCommand = command;
        capturedArgs = args;
        capturedOptions = options;
        return {
          stdout: JSON.stringify({
            status: 'ok',
            result: {
              payloads: [
                {
                  text: '图好了。\n\nWECHAT_MEDIA: {"source":"media_generation_mcp","type":"image","url":"https://example.com/agent.png","model":"qwen-image"}',
                },
              ],
              meta: {
                agentMeta: {
                  provider: 'claude_code',
                  model: 'qwen3.5-plus',
                },
              },
            },
          }),
          stderr: '',
        };
      },
    }
  );

  assert.equal(capturedCommand, 'npx');
  assert.deepEqual(capturedArgs.slice(0, 2), ['openclaw', 'agent']);
  assert.ok(capturedArgs.includes('--json'));
  assert.ok(capturedArgs.includes('--session-id'));
  assert.equal(capturedOptions.cwd, '/opt/ran_agent');
  assert.equal(capturedOptions.env.OPENCLAW_CONFIG_PATH, '/opt/ran_agent/openclaw/openclaw.personal-system.json');
  assert.match(capturedArgs[capturedArgs.indexOf('--message') + 1], /media_generation__generate_image/);
  assert.match(capturedArgs[capturedArgs.indexOf('--message') + 1], /pollinations\.ai/);
  assert.match(response.reply_text, /WECHAT_MEDIA:/);
  assert.equal(response.model, 'claude_code/qwen3.5-plus');
});

test('sendChatToOpenClawAgent describes inbound media as MiMo MCP assets', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-agent-mimo-media-'));
  const mediaPath = path.join(projectRoot, 'debug', 'wechat', 'inbound', 'screenshot.png');
  fs.mkdirSync(path.dirname(mediaPath), { recursive: true });
  fs.writeFileSync(mediaPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  let capturedArgs = [];
  let response;
  try {
    response = await sendChatToOpenClawAgent(
      {
        text: '帮我看这张截图',
        sender_id: 'user-agent-mimo-media',
        channel: 'wechat',
        media: [
          {
            filePath: mediaPath,
            mimeType: 'image/png',
            type: 'image',
          },
        ],
      },
      {
        env: {
          RAN_AGENT_ROOT: projectRoot,
          OPENCLAW_CONFIG: path.join(projectRoot, 'openclaw/openclaw.personal-system.json'),
          OPENCLAW_CONTEXT_POLICY: 'legacy',
        },
        execFileImpl: async (command, args) => {
          capturedArgs = args;
          return {
            stdout: JSON.stringify({
              status: 'ok',
              result: {
                payloads: [{ text: 'MiMo 已分析截图' }],
                meta: {
                  agentMeta: {
                    provider: 'claude_code',
                    model: 'qwen3.5-plus',
                  },
                },
              },
            }),
            stderr: '',
          };
        },
        mediaContextOptions: {
          analyzeMediaAssetImpl: async () => ({
            ok: true,
            analyzer: 'mimo_power',
            summary: 'MiMo 看到一张截图。',
          }),
        },
        logger: { log() {}, warn() {} },
      }
    );
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }

  const message = capturedArgs[capturedArgs.indexOf('--message') + 1];
  assert.match(message, /mimo_power__analyze/);
  assert.match(message, /debug\/wechat\/inbound\/screenshot\.png/);
  assert.match(message, /image\/png/);
  assert.doesNotMatch(message, /media_reader__analyze_image/);
  assert.equal(response.reply_text, 'MiMo 已分析截图');
});

test('sendChatToOpenClawAgent drops project files outside trusted media directories', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-agent-untrusted-media-'));
  const privatePath = path.join(projectRoot, 'node_bridge', '.env.local');
  fs.mkdirSync(path.dirname(privatePath), { recursive: true });
  fs.writeFileSync(privatePath, 'SECRET=value\n');
  let capturedArgs = [];
  try {
    await sendChatToOpenClawAgent(
      {
        text: '帮我看这个文件',
        sender_id: 'user-agent-untrusted-media',
        channel: 'wechat',
        media: [{ filePath: privatePath, mimeType: 'text/plain', type: 'file' }],
        image_urls: [privatePath],
      },
      {
        env: {
          RAN_AGENT_ROOT: projectRoot,
          OPENCLAW_CONFIG: path.join(projectRoot, 'openclaw/openclaw.personal-system.json'),
          OPENCLAW_CONTEXT_POLICY: 'legacy',
        },
        execFileImpl: async (command, args) => {
          capturedArgs = args;
          return {
            stdout: JSON.stringify({
              status: 'ok',
              result: {
                payloads: [{ text: '没有可分析的可信媒体' }],
                meta: {
                  agentMeta: {
                    provider: 'claude_code',
                    model: 'qwen3.5-plus',
                  },
                },
              },
            }),
            stderr: '',
          };
        },
        logger: { log() {}, warn() {} },
      }
    );
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }

  const message = capturedArgs[capturedArgs.indexOf('--message') + 1];
  assert.doesNotMatch(message, /SECRET=value/);
  assert.doesNotMatch(message, /\.env\.local/);
  assert.doesNotMatch(message, /node_bridge/);
  assert.doesNotMatch(message, /微信入站媒体资产/);
});

test('sendChatToOpenClawAgent copies external media files to trusted inbound directory', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-agent-external-media-'));
  const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-sdk-media-'));
  const imageFile = path.join(externalDir, '1778345688721-95b3b62d.bin');
  fs.writeFileSync(imageFile, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  let capturedArgs = [];
  try {
    await sendChatToOpenClawAgent(
      {
        text: '',
        sender_id: 'user-agent-external-media',
        channel: 'wechat',
        media: [{ filePath: imageFile, mimeType: 'image/png', type: 'image' }],
      },
      {
        env: {
          RAN_AGENT_ROOT: projectRoot,
          OPENCLAW_CONFIG: path.join(projectRoot, 'openclaw/openclaw.personal-system.json'),
          OPENCLAW_CONTEXT_POLICY: 'legacy',
        },
        execFileImpl: async (command, args) => {
          capturedArgs = args;
          return {
            stdout: JSON.stringify({
              status: 'ok',
              result: {
                payloads: [{ text: '已分析图片' }],
                meta: { agentMeta: { provider: 'claude_code', model: 'qwen3.5-plus' } },
              },
            }),
            stderr: '',
          };
        },
        logger: { log() {}, warn() {} },
      }
    );
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(externalDir, { recursive: true, force: true });
  }

  const message = capturedArgs[capturedArgs.indexOf('--message') + 1];
  assert.match(message, /微信入站媒体资产/);
  assert.match(message, /mimo_power__analyze/);
  // The file should have been copied to the trusted inbound directory
  assert.match(message, /debug\/wechat\/inbound/);
  // The original /tmp path should NOT appear
  assert.doesNotMatch(message, new RegExp(externalDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('sendChatToOpenClawAgent injects generated media artifact context before OpenClaw reply', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-agent-media-context-'));
  const mediaPath = path.join(projectRoot, 'debug', 'wechat', 'inbound', 'screenshot.png');
  fs.mkdirSync(path.dirname(mediaPath), { recursive: true });
  fs.writeFileSync(mediaPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  let capturedArgs = [];
  let response;
  try {
    response = await sendChatToOpenClawAgent(
      {
        text: '刚才这张截图是什么意思',
        sender_id: 'user-agent-media-context',
        channel: 'wechat',
        media: [
          {
            filePath: mediaPath,
            mimeType: 'image/png',
            type: 'image',
          },
        ],
      },
      {
        env: {
          RAN_AGENT_ROOT: projectRoot,
          OPENCLAW_CONFIG: path.join(projectRoot, 'openclaw/openclaw.personal-system.json'),
          OPENCLAW_CONTEXT_POLICY: 'legacy',
        },
        execFileImpl: async (command, args) => {
          capturedArgs = args;
          return {
            stdout: JSON.stringify({
              status: 'ok',
              result: {
                payloads: [{ text: '这是登录失败截图' }],
                meta: {
                  agentMeta: {
                    provider: 'claude_code',
                    model: 'qwen3.5-plus',
                  },
                },
              },
            }),
            stderr: '',
          };
        },
        mediaContextOptions: {
          analyzeMediaAssetImpl: async () => ({
            ok: true,
            analyzer: 'mimo_power',
            summary: '截图显示登录失败，提示验证码过期。',
            ocr_text: '验证码过期',
            artifact_path: path.join(projectRoot, 'debug/mimo_tasks/fake.md'),
          }),
        },
        logger: { log() {}, warn() {} },
      }
    );
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }

  const message = capturedArgs[capturedArgs.indexOf('--message') + 1];
  assert.match(message, /【最近媒体上下文/);
  assert.match(message, /截图显示登录失败/);
  assert.match(message, /验证码过期/);
  assert.match(message, /artifact_id=/);
  assert.equal(response.reply_text, '这是登录失败截图');
});

test('sendChatToOpenClawAgent loads project env and Claude settings for child process', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-agent-env-'));
  const homeDir = path.join(tempDir, 'home');
  fs.mkdirSync(path.join(tempDir, 'openclaw'), { recursive: true });
  fs.mkdirSync(path.join(tempDir, 'node_bridge'), { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(tempDir, '.env.local'), 'OPENCLAW_GATEWAY_TOKEN=from-root-env\n');
  fs.writeFileSync(path.join(tempDir, 'node_bridge', '.env.local'), 'NODE_BRIDGE_TEST_FLAG=from-node-env\n');
  fs.writeFileSync(
    path.join(homeDir, '.claude', 'settings.json'),
    JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: 'https://anthropic-compatible.example.com',
        ANTHROPIC_AUTH_TOKEN: 'from-claude-settings',
      },
    })
  );

  let capturedOptions = null;
  try {
    await sendChatToOpenClawAgent(
      { text: '你好', sender_id: 'agent-env-user', channel: 'wechat' },
      {
        env: {
          RAN_AGENT_ROOT: tempDir,
          HOME: homeDir,
        },
        execFileImpl: async (command, args, options) => {
          capturedOptions = options;
          return {
            stdout: JSON.stringify({
              payloads: [{ text: '收到' }],
              meta: { agentMeta: { provider: 'claude_code', model: 'qwen3.5-plus' } },
            }),
            stderr: '',
          };
        },
        logger: { log() {}, warn() {} },
      }
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  assert.equal(capturedOptions.env.OPENCLAW_GATEWAY_TOKEN, 'from-root-env');
  assert.equal(capturedOptions.env.NODE_BRIDGE_TEST_FLAG, 'from-node-env');
  assert.equal(capturedOptions.env.ANTHROPIC_BASE_URL, 'https://anthropic-compatible.example.com');
  assert.equal(capturedOptions.env.ANTHROPIC_AUTH_TOKEN, 'from-claude-settings');
});

test('sendChatToOpenClawAgent parses top-level OpenClaw agent JSON payloads', async () => {
  const response = await sendChatToOpenClawAgent(
    { text: '生成语音', sender_id: 'user-agent-speech', channel: 'wechat' },
    {
      env: {
        RAN_AGENT_ROOT: '/opt/ran_agent',
        OPENCLAW_CONFIG: '/opt/ran_agent/openclaw/openclaw.personal-system.json',
      },
      execFileImpl: async () => ({
        stdout: JSON.stringify({
          payloads: [
            {
              text: '好的，已经生成语音。\nWECHAT_MEDIA: {"source":"media_generation_mcp","kind":"speech","type":"audio","url":"/opt/ran_agent/.openclaw_state/generated/wechat-audio.wav","fileName":"wechat-audio.wav","model":"qwen3-omni-flash"}',
            },
          ],
          meta: {
            agentMeta: {
              provider: 'claude_code',
              model: 'qwen3.5-plus',
            },
          },
        }),
        stderr: '',
      }),
      logger: { log() {}, warn() {} },
    }
  );

  assert.match(response.reply_text, /WECHAT_MEDIA:/);
  assert.equal(response.model, 'claude_code/qwen3.5-plus');
});

test('sendChatToOpenClawAgent preserves top-level OpenClaw mediaUrl audio payloads', async () => {
  const audioPath = '/opt/ran_agent/.openclaw_state/generated/wechat-audio.wav';
  const response = await sendChatToOpenClawAgent(
    { text: '生成语音', sender_id: 'user-agent-speech-media-url', channel: 'wechat' },
    {
      env: {
        RAN_AGENT_ROOT: '/opt/ran_agent',
        OPENCLAW_CONFIG: '/opt/ran_agent/openclaw/openclaw.personal-system.json',
      },
      execFileImpl: async () => ({
        stdout: JSON.stringify({
          payloads: [
            {
              text: '好的，已经生成语音。',
              mediaUrl: audioPath,
              mediaUrls: [audioPath],
              audioAsVoice: true,
            },
          ],
          meta: {
            agentMeta: {
              provider: 'claude_code',
              model: 'qwen3.5-plus',
            },
          },
        }),
        stderr: '',
      }),
      logger: { log() {}, warn() {} },
    }
  );

  assert.equal(response.reply_text, '好的，已经生成语音。');
  assert.deepEqual(response.media, {
    type: 'audio',
    url: audioPath,
    fileName: 'wechat-audio.wav',
  });
});

test('sendChatToOpenClawGateway keeps exploration memory gated without bridge-owned media tools', async () => {
  let capturedBody = null;
  await sendChatToOpenClawGateway(
    { text: '帮我查一下今天的新闻', sender_id: 'user-search', channel: 'wechat', route_hint: 'web_search' },
    {
      config: {
        baseUrl: 'http://127.0.0.1:19123',
        token: 'abc',
        model: 'openclaw/personal-system',
        modelOverride: '',
        audioModel: 'whisper-1',
      },
      fetchImpl: async (_, init) => {
        capturedBody = init?.body ? JSON.parse(init.body) : null;
        return makeJsonResponse({
          model: 'openclaw/personal-system',
          choices: [{ message: { content: '收到' } }],
        });
      },
    }
  );

  const toolNames = capturedBody.tools.map((item) => item.function.name);
  assert.ok(toolNames.includes('create_todo'));
  assert.ok(toolNames.includes('store_exploration_memory'));
  assert.equal(toolNames.includes('generate_image'), false);
  assert.equal(toolNames.includes('generate_speech'), false);
  assert.doesNotMatch(JSON.stringify(capturedBody.messages), /当前微信桥接系统提供可调用的出站多模态生成工具/);
});

test('sendChatToOpenClawGateway lets normal chat call speech generation tools', async () => {
  const tempStateDir = path.join(PROJECT_ROOT, '.openclaw_state', 'test-normal-chat-speech-tool');
  const calls = [];
  const response = await sendChatToOpenClawGateway(
    { text: '帮我处理一下这句话：晚上好', sender_id: 'user-normal-chat', channel: 'wechat' },
    {
      env: {
        OPENCLAW_STATE_DIR: tempStateDir,
      },
      config: {
        baseUrl: 'http://127.0.0.1:19123',
        token: 'abc',
        model: 'openclaw/personal-system',
        modelOverride: '',
        directApiToken: 'sk-test',
        speechModel: 'qwen3-omni-flash',
        enableBridgeMediaTools: true,
      },
      fetchImpl: async (url, init) => {
        calls.push({
          url: String(url),
          body: init?.body ? JSON.parse(init.body) : null,
        });
        if (String(url).includes('/compatible-mode/v1/chat/completions')) {
          return makeSseResponse([
            {
              choices: [
                {
                  delta: {
                    audio: {
                      data: Buffer.from([0x11, 0x22]).toString('base64'),
                      format: 'wav',
                    },
                  },
                },
              ],
            },
          ]);
        }
        if (String(url).endsWith('/v1/chat/completions') && !JSON.stringify(calls.at(-1).body.messages).includes('"role":"tool"')) {
          const toolNames = calls.at(-1).body.tools.map((item) => item.function.name);
          assert.ok(toolNames.includes('generate_speech'));
          assert.ok(toolNames.includes('generate_image'));
          assert.match(JSON.stringify(calls.at(-1).body.messages), /当前微信桥接系统提供可调用的出站多模态生成工具/);
          return makeJsonResponse({
            model: 'openclaw/personal-system',
            choices: [{
              message: {
                content: '我来处理一下。',
                tool_calls: [
                  {
                    id: 'call-normal-speech-1',
                    function: {
                      name: 'generate_speech',
                      arguments: JSON.stringify({ text: '晚上好' }),
                    },
                  },
                ],
              },
            }],
          });
        }
        assert.equal(calls.at(-1).body.messages.find((item) => item.role === 'tool').tool_call_id, 'call-normal-speech-1');
        return makeJsonResponse({
          model: 'openclaw/personal-system',
          choices: [{
            message: {
              content: '语音已经发出。',
            },
          }],
        });
      },
    }
  );

  assert.equal(response.reply_text, '语音已经发出。');
  assert.equal(response.media.type, 'audio');
  assert.match(response.media.url, /wechat-audio-.*\.wav$/);
});

test('sendChatToOpenClawGateway does not treat /image as a direct generation command', async () => {
  const calls = [];
  const response = await sendChatToOpenClawGateway(
    { text: '/image 画一只戴围巾的猫', sender_id: 'user-image', channel: 'wechat' },
    {
      config: {
        baseUrl: 'http://127.0.0.1:19123',
        token: 'abc',
        model: 'openclaw/personal-system',
        modelOverride: '',
        directApiBaseUrl: 'https://dashscope.aliyuncs.com',
        directApiToken: 'sk-test',
        imageModel: 'qwen-image',
      },
      sleepImpl: async () => {},
      fetchImpl: async (url, init) => {
        calls.push({
          url: String(url),
          body: init?.body ? JSON.parse(init.body) : null,
        });
        assert.equal(String(url), 'http://127.0.0.1:19123/v1/chat/completions');
        assert.equal(calls.at(-1).body.messages[0].content, '/image 画一只戴围巾的猫');
        assert.deepEqual(calls.at(-1).body.tools, []);
        return makeJsonResponse({
          model: 'openclaw/personal-system',
          choices: [{ message: { content: '这个命令交给 OpenClaw 处理。' } }],
        });
      },
    }
  );

  assert.equal(response.reply_text, '这个命令交给 OpenClaw 处理。');
  assert.equal(response.media, null);
  assert.deepEqual(response.follow_up_messages, []);
  assert.equal(calls.length, 1);
});

test('sendChatToOpenClawGateway does not treat /speak as a direct generation command', async () => {
  const calls = [];
  const response = await sendChatToOpenClawGateway(
    { text: '/speak 请读一句晚上早点休息', sender_id: 'user-audio-gen', channel: 'wechat' },
    {
      config: {
        baseUrl: 'http://127.0.0.1:19123',
        token: 'abc',
        model: 'openclaw/personal-system',
        modelOverride: '',
        directApiToken: 'sk-test',
        speechModel: 'qwen3-omni-flash',
        enableBridgeMediaTools: true,
      },
      fetchImpl: async (url, init) => {
        calls.push({
          url: String(url),
          body: init?.body ? JSON.parse(init.body) : null,
        });
        assert.equal(String(url), 'http://127.0.0.1:19123/v1/chat/completions');
        assert.equal(calls.at(-1).body.messages[0].content, '/speak 请读一句晚上早点休息');
        assert.deepEqual(calls.at(-1).body.tools, []);
        return makeJsonResponse({
          model: 'openclaw/personal-system',
          choices: [{ message: { content: '这个命令交给 OpenClaw 处理。' } }],
        });
      },
    }
  );

  assert.equal(response.reply_text, '这个命令交给 OpenClaw 处理。');
  assert.equal(response.media, null);
  assert.equal(calls.length, 1);
});

test('sendChatToOpenClawGateway exposes speech generation as a model-visible tool', async () => {
  const tempStateDir = path.join(PROJECT_ROOT, '.openclaw_state', 'test-visible-speech-tool');
  const calls = [];
  const response = await sendChatToOpenClawGateway(
    { text: '请发语音消息：请吃晚饭', sender_id: 'user-audio-tool', channel: 'wechat' },
    {
      env: {
        OPENCLAW_STATE_DIR: tempStateDir,
      },
      config: {
        baseUrl: 'http://127.0.0.1:19123',
        token: 'abc',
        model: 'openclaw/personal-system',
        modelOverride: '',
        directApiToken: 'sk-test',
        speechModel: 'qwen3-omni-flash',
        enableBridgeMediaTools: true,
      },
      fetchImpl: async (url, init) => {
        calls.push({
          url: String(url),
          body: init?.body ? JSON.parse(init.body) : null,
        });
        if (String(url).includes('/compatible-mode/v1/chat/completions')) {
          return makeSseResponse([
            {
              choices: [
                {
                  delta: {
                    audio: {
                      data: Buffer.from([0x11, 0x22]).toString('base64'),
                      format: 'wav',
                    },
                  },
                },
              ],
            },
          ]);
        }
        if (String(url).endsWith('/v1/chat/completions') && !JSON.stringify(calls.at(-1).body.messages).includes('"role":"tool"')) {
          const toolNames = calls.at(-1).body.tools.map((item) => item.function.name);
          assert.ok(toolNames.includes('generate_speech'));
          assert.equal(calls.at(-1).body.tool_choice, undefined);
          assert.match(JSON.stringify(calls.at(-1).body.messages), /generate_speech/);
          return makeJsonResponse({
            model: 'openclaw/personal-system',
            choices: [{
              message: {
                content: '我来发语音。',
                tool_calls: [
                  {
                    id: 'call-speech-1',
                    function: {
                      name: 'generate_speech',
                      arguments: JSON.stringify({ text: '请吃晚饭' }),
                    },
                  },
                ],
              },
            }],
          });
        }
        const toolMessage = calls.at(-1).body.messages.find((item) => item.role === 'tool');
        const toolOutput = JSON.parse(toolMessage.content);
        assert.equal(toolOutput.kind, 'speech');
        assert.equal(toolOutput.media.type, 'audio');
        return makeJsonResponse({
          model: 'openclaw/personal-system',
          choices: [{ message: { content: '我发了语音。' } }],
        });
      },
    }
  );

  assert.equal(response.reply_text, '我发了语音。');
  assert.equal(response.media.type, 'audio');
  assert.match(response.media.url, /wechat-audio-.*\.wav$/);
  const wav = fs.readFileSync(response.media.url);
  assert.equal(wav.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(wav.readUInt32LE(40), 2);
});

test('sendChatToOpenClawGateway exposes image generation as a model-visible tool', async () => {
  const calls = [];
  const response = await sendChatToOpenClawGateway(
    { text: '给我来张图，猫在月亮上睡觉', sender_id: 'user-image-tool', channel: 'wechat' },
    {
      config: {
        baseUrl: 'http://127.0.0.1:19123',
        token: 'abc',
        model: 'openclaw/personal-system',
        modelOverride: '',
        directApiBaseUrl: 'https://dashscope.aliyuncs.com',
        directApiToken: 'sk-test',
        imageModel: 'qwen-image',
        enableBridgeMediaTools: true,
      },
      sleepImpl: async () => {},
      fetchImpl: async (url, init) => {
        calls.push({
          url: String(url),
          body: init?.body ? JSON.parse(init.body) : null,
        });
        if (String(url).includes('/image-synthesis')) {
          return makeJsonResponse({
            output: {
              task_id: 'task-image-tool',
              task_status: 'PENDING',
            },
          });
        }
        if (String(url).includes('/api/v1/tasks/')) {
          return makeJsonResponse({
            output: {
              task_id: 'task-image-tool',
              task_status: 'SUCCEEDED',
              results: [{ url: 'https://example.com/generated-tool.png' }],
            },
          });
        }
        if (String(url).endsWith('/v1/chat/completions') && !JSON.stringify(calls.at(-1).body.messages).includes('"role":"tool"')) {
          const toolNames = calls.at(-1).body.tools.map((item) => item.function.name);
          assert.ok(toolNames.includes('generate_image'));
          assert.equal(calls.at(-1).body.tool_choice, undefined);
          assert.match(JSON.stringify(calls.at(-1).body.messages), /generate_image/);
          return makeJsonResponse({
            model: 'openclaw/personal-system',
            choices: [{
              message: {
                content: '我来画。',
                tool_calls: [
                  {
                    id: 'call-image-1',
                    function: {
                      name: 'generate_image',
                      arguments: JSON.stringify({ prompt: '猫在月亮上睡觉' }),
                    },
                  },
                ],
              },
            }],
          });
        }
        const toolMessage = calls.at(-1).body.messages.find((item) => item.role === 'tool');
        const toolOutput = JSON.parse(toolMessage.content);
        assert.equal(toolOutput.kind, 'image');
        assert.equal(toolOutput.media.url, 'https://example.com/generated-tool.png');
        return makeJsonResponse({
          model: 'openclaw/personal-system',
          choices: [{ message: { content: '图发你了。' } }],
        });
      },
    }
  );

  assert.equal(response.reply_text, '图发你了。');
  assert.deepEqual(response.media, {
    type: 'image',
    url: 'https://example.com/generated-tool.png',
  });
});

test('sendChatToOpenClawGateway lets the model decide natural draw requests without forced responses routing', async () => {
  const calls = [];
  const response = await sendChatToOpenClawGateway(
    { text: '那我给你画只猫', sender_id: 'user-image-natural-tool', channel: 'wechat' },
    {
      config: {
        baseUrl: 'http://127.0.0.1:19123',
        token: 'abc',
        model: 'openclaw/personal-system',
        modelOverride: '',
        directApiBaseUrl: 'https://dashscope.aliyuncs.com',
        directApiToken: 'sk-test',
        imageModel: 'qwen-image',
        enableBridgeMediaTools: true,
      },
      sleepImpl: async () => {},
      fetchImpl: async (url, init) => {
        calls.push({
          url: String(url),
          body: init?.body ? JSON.parse(init.body) : null,
        });
        if (String(url).includes('/image-synthesis')) {
          return makeJsonResponse({
            output: {
              task_id: 'task-natural-image-tool',
              task_status: 'PENDING',
            },
          });
        }
        if (String(url).includes('/api/v1/tasks/')) {
          return makeJsonResponse({
            output: {
              task_id: 'task-natural-image-tool',
              task_status: 'SUCCEEDED',
              results: [{ url: 'https://example.com/natural-cat.png' }],
            },
          });
        }
        if (String(url).endsWith('/v1/chat/completions') && !JSON.stringify(calls.at(-1).body.messages).includes('"role":"tool"')) {
          const body = calls.at(-1).body;
          assert.equal(body.tool_choice, undefined);
          assert.ok(body.tools.map((item) => item.function.name).includes('generate_image'));
          return makeJsonResponse({
            model: 'openclaw/personal-system',
            choices: [{
              message: {
                content: '我来画猫。',
                tool_calls: [
                  {
                    id: 'call-natural-image-1',
                    function: {
                      name: 'generate_image',
                      arguments: JSON.stringify({ prompt: '一只猫' }),
                    },
                  },
                ],
              },
            }],
          });
        }
        assert.equal(calls.at(-1).body.messages.find((item) => item.role === 'tool').tool_call_id, 'call-natural-image-1');
        return makeJsonResponse({
          model: 'openclaw/personal-system',
          choices: [{ message: { content: '猫图发你了。' } }],
        });
      },
    }
  );

  assert.equal(response.reply_text, '猫图发你了。');
  assert.deepEqual(response.media, {
    type: 'image',
    url: 'https://example.com/natural-cat.png',
  });
});

test('sendChatToOpenClawGateway preserves streamed qwen omni audio fragments from model tool calls', async () => {
  const tempStateDir = path.join(PROJECT_ROOT, '.openclaw_state', 'test-generated-audio-fragments');
  const calls = [];
  const response = await sendChatToOpenClawGateway(
    { text: '请用语音读一句晚上早点休息', sender_id: 'user-audio-fragments', channel: 'wechat' },
    {
      env: {
        OPENCLAW_STATE_DIR: tempStateDir,
      },
      config: {
        baseUrl: 'http://127.0.0.1:19123',
        token: 'abc',
        model: 'openclaw/personal-system',
        modelOverride: '',
        directApiToken: 'sk-test',
        speechModel: 'qwen3-omni-flash',
        enableBridgeMediaTools: true,
      },
      fetchImpl: async (url, init) => {
        calls.push({
          url: String(url),
          body: init?.body ? JSON.parse(init.body) : null,
        });
        if (String(url).includes('/compatible-mode/v1/chat/completions')) {
          return makeSseResponse([
            {
              choices: [
                {
                  delta: {
                    audio: {
                      data: Buffer.from([0x01, 0x02]).toString('base64'),
                      format: 'wav',
                    },
                  },
                },
              ],
            },
            {
              choices: [
                {
                  delta: {
                    audio: {
                      data: Buffer.from([0x03, 0x04]).toString('base64'),
                      format: 'wav',
                    },
                  },
                },
              ],
            },
          ]);
        }
        if (String(url).endsWith('/v1/chat/completions') && !JSON.stringify(calls.at(-1).body.messages).includes('"role":"tool"')) {
          return makeJsonResponse({
            model: 'openclaw/personal-system',
            choices: [{
              message: {
                content: '我来读。',
                tool_calls: [
                  {
                    id: 'call-audio-fragments-1',
                    function: {
                      name: 'generate_speech',
                      arguments: JSON.stringify({ text: '晚上早点休息' }),
                    },
                  },
                ],
              },
            }],
          });
        }
        assert.equal(calls.at(-1).body.messages.find((item) => item.role === 'tool').tool_call_id, 'call-audio-fragments-1');
        return makeJsonResponse({
          model: 'openclaw/personal-system',
          choices: [{ message: { content: '语音发好了。' } }],
        });
      },
    }
  );

  const wav = fs.readFileSync(response.media.url);
  assert.equal(wav.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(wav.subarray(8, 12).toString('ascii'), 'WAVE');
  assert.equal(wav.readUInt32LE(40), 4);
  assert.deepEqual([...wav.subarray(44)], [0x01, 0x02, 0x03, 0x04]);
});

test('sendChatToOpenClawGateway routes /breath to backend memory recall', async () => {
  const calls = [];
  const response = await sendChatToOpenClawGateway(
    { text: '/breath 晚上好', sender_id: 'user-breath', channel: 'wechat' },
    {
      fetchImpl: async (url, init) => {
        calls.push({
          url: String(url),
          body: init?.body ? JSON.parse(init.body) : null,
        });
        assert.equal(String(url), 'http://127.0.0.1:8787/tools/memory/recall');
        return makeJsonResponse({
          should_inject: true,
          rendered_context: '【长期记忆】\n- 用户喜欢晚上8点提醒吃饭',
          used_sources: ['ombre_long_memory'],
        });
      },
    }
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body, {
    user_text: '晚上好',
    route: 'text_chat',
    response_mode: 'chat',
  });
  assert.equal(response.reply_text, '【长期记忆】\n- 用户喜欢晚上8点提醒吃饭');
  assert.deepEqual(response.follow_up_messages, []);
  assert.equal(response.media, null);
});

test('sendChatToOpenClawGateway passes /compact through to OpenClaw native command handling', async () => {
  const calls = [];
  const response = await sendChatToOpenClawGateway(
    { text: '/compact 关注API设计决策', sender_id: 'user-compact', channel: 'wechat' },
    {
      config: {
        baseUrl: 'http://127.0.0.1:19123',
        token: 'abc',
        model: 'openclaw/personal-system',
        modelOverride: '',
      },
      fetchImpl: async (url, init) => {
        calls.push({
          url: String(url),
          body: init?.body ? JSON.parse(init.body) : null,
        });
        assert.equal(String(url), 'http://127.0.0.1:19123/v1/chat/completions');
        return makeJsonResponse({
          model: 'openclaw/personal-system',
          choices: [{ message: { content: '已压缩当前上下文。' } }],
        });
      },
    }
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body, {
    model: 'openclaw/personal-system',
    user: 'user-compact',
    messages: [{ role: 'user', content: '/compact 关注API设计决策' }],
    tools: [],
  });
  assert.equal(response.reply_text, '已压缩当前上下文。');
  assert.deepEqual(response.follow_up_messages, []);
  assert.equal(response.media, null);
});

test('media generation MCP exposes image and speech tools', async () => {
  const initialized = await handleMediaGenerationMcpRequest({ method: 'initialize' });
  assert.equal(initialized.serverInfo.name, 'ran-agent-media-generation');
  assert.deepEqual(initialized.capabilities, { tools: {} });

  const listed = await handleMediaGenerationMcpRequest({ method: 'tools/list' });
  const names = listed.tools.map((tool) => tool.name);
  assert.deepEqual(names, ['generate_image', 'generate_speech']);
  assert.equal(
    listed.tools.find((tool) => tool.name === 'generate_image').inputSchema.required[0],
    'prompt'
  );
  assert.equal(
    listed.tools.find((tool) => tool.name === 'generate_speech').inputSchema.required[0],
    'text'
  );
});

test('media generation MCP generate_image returns structured media metadata', async () => {
  const calls = [];
  const result = await handleMediaGenerationMcpRequest(
    {
      method: 'tools/call',
      params: {
        name: 'generate_image',
        arguments: { prompt: '一只猫' },
      },
    },
    {
      config: {
        directApiBaseUrl: 'https://dashscope.aliyuncs.com',
        directApiToken: 'sk-test',
        imageModel: 'qwen-image',
      },
      sleepImpl: async () => {},
      fetchImpl: async (url) => {
        calls.push(String(url));
        if (String(url).includes('/image-synthesis')) {
          return makeJsonResponse({
            output: {
              task_id: 'task-mcp-image',
              task_status: 'PENDING',
            },
          });
        }
        return makeJsonResponse({
          output: {
            task_id: 'task-mcp-image',
            task_status: 'SUCCEEDED',
            results: [{ url: 'https://example.com/mcp-image.png' }],
          },
        });
      },
    }
  );

  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.kind, 'image');
  assert.equal(result.structuredContent.prompt, '一只猫');
  assert.equal(result.structuredContent.model, 'qwen-image');
  assert.deepEqual(result.structuredContent.media, {
    type: 'image',
    url: 'https://example.com/mcp-image.png',
  });
  assert.match(result.content[0].text, /mcp-image\.png/);
  assert.match(result.content[0].text, /WECHAT_MEDIA:/);
  assert.equal(calls.length, 2);
});

test('media generation MCP reports missing image API key before calling DashScope', async () => {
  let called = false;
  const result = await handleMediaGenerationMcpRequest(
    {
      method: 'tools/call',
      params: {
        name: 'generate_image',
        arguments: { prompt: '一只猫' },
      },
    },
    {
      config: {
        directApiBaseUrl: 'https://dashscope.aliyuncs.com',
        directApiToken: '',
        imageModel: 'qwen-image',
      },
      fetchImpl: async () => {
        called = true;
        return makeJsonResponse({});
      },
    }
  );

  assert.equal(result.structuredContent.ok, false);
  assert.match(result.structuredContent.error, /DASHSCOPE_API_KEY|QWEN_API_KEY/);
  assert.equal(called, false);
});

test('sendChatToOpenClawGateway rejects OpenClaw empty-response sentinel from standalone commands', async () => {
  await assert.rejects(
    sendChatToOpenClawGateway(
      { text: '/status', sender_id: 'user-status', channel: 'wechat' },
      {
        fetchImpl: async () => makeJsonResponse({
          choices: [
            {
              message: {
                content: 'No response from OpenClaw.',
              },
            },
          ],
          model: 'openclaw/personal-system',
        }),
      }
    ),
    /openclaw gateway returned empty agent response/
  );
});

test('extractUrlsFromText returns unique urls in order', () => {
  assert.deepEqual(
    extractUrlsFromText('看下这个 https://example.com/a 和这个 https://example.com/a 再看 https://example.com/b'),
    ['https://example.com/a', 'https://example.com/b']
  );
});

test('extractStructuredContentFromHtml returns readable article text and links', () => {
  const result = extractStructuredContentFromHtml(`
    <html>
      <head>
        <title>Example Title</title>
        <meta name="description" content="Short summary" />
      </head>
      <body>
        <article>
          <h1>Example Title</h1>
          <p>${'正文内容 '.repeat(120)}</p>
          <a href="/detail">继续阅读</a>
        </article>
      </body>
    </html>
  `, 'https://example.com/post');

  assert.equal(result.title, 'Example Title');
  assert.match(result.text, /正文内容/);
  assert.ok(result.text.length > 200);
  assert.equal(result.links[0].href, 'https://example.com/detail');
});

test('buildStructuredUrlContext folds extraction results into a compact prompt block', () => {
  const context = buildStructuredUrlContext(
    { text: '帮我总结这个链接' },
    [
      {
        url: 'https://example.com/post',
        title: 'Example',
        excerpt: 'Summary',
        text: 'Main article body',
      },
    ]
  );

  assert.match(context, /结构化提取结果/);
  assert.match(context, /https:\/\/example.com\/post/);
  assert.match(context, /Main article body/);
  assert.match(context, /用户问题：帮我总结这个链接/);
});

test('resolvePlaywrightLaunchOptions prefers explicit system chromium path', () => {
  const options = resolvePlaywrightLaunchOptions({
    PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: '/usr/bin/chromium',
  });

  assert.equal(options.headless, true);
  assert.equal(options.executablePath, '/usr/bin/chromium');
});

test('shouldUsePlaywrightStructuredExtraction enables Playwright when browser path or channel is configured', () => {
  assert.equal(
    shouldUsePlaywrightStructuredExtraction({}, { existsSync() { return false; } }),
    false
  );
  assert.equal(
    shouldUsePlaywrightStructuredExtraction(
      { PLAYWRIGHT_USE_SYSTEM_CHROMIUM: 'true' },
      { existsSync(filePath) { return filePath === '/usr/bin/chromium'; } }
    ),
    true
  );
  assert.equal(
    shouldUsePlaywrightStructuredExtraction({ PLAYWRIGHT_CHROMIUM_CHANNEL: 'chrome' }),
    true
  );
});

test('sendChatToOpenClawGateway injects structured url context before user question', async () => {
  let capturedBody = null;
  await sendChatToOpenClawGateway(
    { text: '帮我看这个链接 https://example.com/post 讲了什么', sender_id: 'user-url', channel: 'wechat' },
    {
      config: {
        baseUrl: 'http://127.0.0.1:19123',
        token: 'abc',
        model: 'openclaw/personal-system',
        modelOverride: '',
        audioModel: 'whisper-1',
      },
      fetchImpl: async (url, init) => {
        if (String(url) === 'https://example.com/post') {
          return {
            ok: true,
            status: 200,
            async text() {
              return '<html><body><article><h1>链接标题</h1><p>' + '结构化正文 '.repeat(120) + '</p></article></body></html>';
            },
          };
        }
        capturedBody = init?.body ? JSON.parse(init.body) : null;
        return makeJsonResponse({
          model: 'openclaw/personal-system',
          choices: [{ message: { content: '收到' } }],
        });
      },
    }
  );

  const userContent = getUserMessageContent(capturedBody);
  const injectedText = typeof userContent === 'string'
    ? userContent
    : userContent?.[0]?.text || '';
  assert.match(injectedText, /结构化提取结果/);
  assert.match(injectedText, /链接标题/);
});

test('sendChatToOpenClawGateway prefers Playwright structured extraction before HTML fallback', async () => {
  let capturedBody = null;
  let fetchCallCount = 0;
  await sendChatToOpenClawGateway(
    { text: '帮我看这个链接 https://example.com/post', sender_id: 'user-url-playwright', channel: 'wechat' },
    {
      structuredContentExtractor: async (url) => ({
        url,
        title: 'Playwright 标题',
        excerpt: 'Playwright 摘要',
        text: 'Playwright 正文 '.repeat(40),
      }),
      fetchImpl: async (url, init) => {
        fetchCallCount += 1;
        capturedBody = init?.body ? JSON.parse(init.body) : null;
        return makeJsonResponse({
          model: 'openclaw/personal-system',
          choices: [{ message: { content: '收到' } }],
        });
      },
    }
  );

  const userContent = getUserMessageContent(capturedBody);
  const injectedText = typeof userContent === 'string'
    ? userContent
    : userContent?.[0]?.text || '';
  assert.match(injectedText, /Playwright 标题/);
  assert.match(injectedText, /Playwright 正文/);
  assert.equal(fetchCallCount, 1);
});

test('sendChatToOpenClawGateway falls back to HTML extraction when Playwright extraction fails', async () => {
  let capturedBody = null;
  await sendChatToOpenClawGateway(
    { text: '帮我看这个链接 https://example.com/post', sender_id: 'user-url-playwright-fallback', channel: 'wechat' },
    {
      structuredContentExtractor: async () => {
        throw new Error('playwright failed');
      },
      fetchImpl: async (url, init) => {
        if (String(url) === 'https://example.com/post') {
          return {
            ok: true,
            status: 200,
            async text() {
              return '<html><body><article><h1>HTML 回退标题</h1><p>' + 'HTML 回退正文 '.repeat(120) + '</p></article></body></html>';
            },
          };
        }
        capturedBody = init?.body ? JSON.parse(init.body) : null;
        return makeJsonResponse({
          model: 'openclaw/personal-system',
          choices: [{ message: { content: '收到' } }],
        });
      },
    }
  );

  const userContent = getUserMessageContent(capturedBody);
  const injectedText = typeof userContent === 'string'
    ? userContent
    : userContent?.[0]?.text || '';
  assert.match(injectedText, /HTML 回退标题/);
  assert.match(injectedText, /HTML 回退正文/);
});

test('sendChatToOpenClawGateway retries transient gateway failures before succeeding', async () => {
  let attempts = 0;

  const response = await sendChatToOpenClawGateway(
    { text: '你好', sender_id: 'user-retry', channel: 'wechat' },
    {
      config: {
        baseUrl: 'http://127.0.0.1:19123',
        token: 'abc',
        model: 'openclaw/personal-system',
        modelOverride: '',
        audioModel: 'whisper-1',
        chatRetryAttempts: 3,
        chatRetryDelayMs: 0,
      },
      sleepImpl: async () => {},
      fetchImpl: async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new Error('connect ECONNREFUSED 127.0.0.1:19123');
        }
        return makeJsonResponse({
          model: 'openclaw/personal-system',
          choices: [{ message: { content: '恢复了' } }],
        });
      },
    }
  );

  assert.equal(response.reply_text, '恢复了');
  assert.equal(attempts, 3);
});

test('sendChatToOpenClawGateway forwards backend override header when explicitly configured', async () => {
  let capturedHeaders = null;
  const response = await sendChatToOpenClawGateway(
    { text: '你好', sender_id: 'user-override', channel: 'wechat' },
    {
      config: {
        baseUrl: 'http://127.0.0.1:19123',
        token: 'abc',
        model: 'openclaw/personal-system',
        modelOverride: 'codex/gpt-5.4-mini',
        audioModel: 'whisper-1',
      },
      fetchImpl: async (_, init) => {
        capturedHeaders = init?.headers || null;
        return makeJsonResponse({
          model: 'openclaw/personal-system',
          choices: [{ message: { content: '收到' } }],
        });
      },
    }
  );

  assert.equal(response.reply_text, '收到');
  assert.equal(capturedHeaders?.['x-openclaw-model'], 'codex/gpt-5.4-mini');
});

test('sendChatToOpenClawGateway deterministically creates explicit reminders before chat completion', async () => {
  const calls = [];

  const response = await sendChatToOpenClawGateway(
    { text: '提醒我明天下午三点开会', sender_id: 'user-reminder', channel: 'wechat' },
    {
      config: {
        baseUrl: 'http://127.0.0.1:19123',
        token: 'abc',
        model: 'openclaw/default',
        modelOverride: '',
        audioModel: 'whisper-1',
      },
      fetchImpl: async (url, init) => {
        calls.push({
          url,
          body: init?.body ? JSON.parse(init.body) : null,
        });

        if (url.includes('/tools/todo/create')) {
          return makeJsonResponse({
            success: true,
            todo_id: 42,
            parsed_time: '2026-04-16 15:00:00',
            explanation: 'Parsed as 15:00',
            needs_confirmation: false,
          });
        }

        if (url.includes('/v1/chat/completions')) {
          return makeJsonResponse({
            model: 'openclaw/default',
            choices: [{ message: { content: '我会提醒你。' } }],
          });
        }

        throw new Error(`unexpected url: ${url}`);
      },
    }
  );

  assert.equal(response.reply_text, '我会提醒你。');
  assert.equal(calls[0].url, 'http://127.0.0.1:8787/tools/todo/create');
  assert.equal(calls[0].body.source, 'openclaw_live_chat');
  assert.equal(calls[0].body.extract_time, true);
  assert.equal(calls[0].body.require_time, true);
  assert.equal(calls[1].url, 'http://127.0.0.1:19123/v1/chat/completions');
  assert.equal(
    calls[1].body.tools.some((tool) => tool?.function?.name === 'create_todo'),
    false
  );
  assert.match(getSystemText(calls[1].body, /提醒已由后端成功创建/), /提醒已由后端成功创建/);
});

test('sendChatToOpenClawGateway overrides contradictory reminder disclaimers after reminder creation', async () => {
  const response = await sendChatToOpenClawGateway(
    { text: '晚上8点提醒我把明天交流用的ppt准备出来', sender_id: 'user-reminder-override', channel: 'wechat' },
    {
      config: {
        baseUrl: 'http://127.0.0.1:19123',
        token: 'abc',
        model: 'openclaw/default',
        modelOverride: '',
        audioModel: 'whisper-1',
      },
      fetchImpl: async (url) => {
        if (url.includes('/tools/todo/create')) {
          return makeJsonResponse({
            success: true,
            todo_id: 52,
            content: '把明天交流用的ppt准备出来',
            parsed_time: '2026-04-15 20:00:00',
            explanation: 'Parsed as 20:00',
            needs_confirmation: false,
          });
        }

        if (url.includes('/v1/chat/completions')) {
          return makeJsonResponse({
            model: 'openclaw/default',
            choices: [{ message: { content: '我没法主动发消息提醒你，所以记得设个手机闹钟。' } }],
          });
        }

        throw new Error(`unexpected url: ${url}`);
      },
    }
  );

  assert.equal(
    response.reply_text,
    '好，已经记下了。我会在2026-04-15 20:00:00提醒你：把明天交流用的ppt准备出来。'
  );
});

test('sendChatToOpenClawGateway asks follow-up when explicit reminder time cannot be parsed', async () => {
  const calls = [];

  const response = await sendChatToOpenClawGateway(
    { text: '提醒我记得交房租', sender_id: 'user-reminder-follow-up', channel: 'wechat' },
    {
      config: {
        baseUrl: 'http://127.0.0.1:19123',
        token: 'abc',
        model: 'openclaw/default',
        modelOverride: '',
        audioModel: 'whisper-1',
      },
      fetchImpl: async (url, init) => {
        calls.push({
          url,
          body: init?.body ? JSON.parse(init.body) : null,
        });

        if (url.includes('/tools/todo/create')) {
          return makeJsonResponse({
            success: false,
            error: 'Could not parse time',
            parsed_time: null,
            needs_confirmation: true,
          }, false, 422);
        }

        if (url.includes('/v1/chat/completions')) {
          return makeJsonResponse({
            model: 'openclaw/default',
            choices: [{ message: { content: '你想让我什么时候提醒你交房租？' } }],
          });
        }

        throw new Error(`unexpected url: ${url}`);
      },
    }
  );

  assert.equal(response.reply_text, '你想让我什么时候提醒你交房租？');
  assert.equal(calls[1].url, 'http://127.0.0.1:19123/v1/chat/completions');
  assert.equal(
    calls[1].body.tools.some((tool) => tool?.function?.name === 'create_todo'),
    false
  );
  assert.match(getSystemText(calls[1].body, /必须先用一句简短中文追问具体时间/), /必须先用一句简短中文追问具体时间/);
});

test('sendChatToOpenClawGateway deterministically completes latest todo for explicit completion text', async () => {
  const calls = [];

  const response = await sendChatToOpenClawGateway(
    { text: '办完了', sender_id: 'user-complete', channel: 'wechat' },
    {
      config: {
        baseUrl: 'http://127.0.0.1:19123',
        token: 'abc',
        model: 'openclaw/default',
        modelOverride: '',
        audioModel: 'whisper-1',
      },
      fetchImpl: async (url, init) => {
        calls.push({
          url,
          body: init?.body ? JSON.parse(init.body) : null,
        });

        if (url.includes('/tools/todo/complete')) {
          return makeJsonResponse({
            success: true,
            todo_id: 9,
            content: '去单位',
            status: 'done',
          });
        }

        if (url.includes('/v1/chat/completions')) {
          return makeJsonResponse({
            model: 'openclaw/default',
            choices: [{ message: { content: '好，记成已完成了。' } }],
          });
        }

        throw new Error(`unexpected url: ${url}`);
      },
    }
  );

  assert.equal(response.reply_text, '好，记成已完成了。');
  assert.equal(calls[0].url, 'http://127.0.0.1:8787/tools/todo/complete');
  assert.equal(calls[1].url, 'http://127.0.0.1:19123/v1/chat/completions');
});

test('sendChatToOpenClawGateway treats done-no-reminder phrasing as deterministic completion', async () => {
  const calls = [];

  const response = await sendChatToOpenClawGateway(
    { text: '做完了，不用提醒了', sender_id: 'user-done-no-reminder', channel: 'wechat' },
    {
      config: {
        baseUrl: 'http://127.0.0.1:19123',
        token: 'abc',
        model: 'openclaw/default',
        modelOverride: '',
        audioModel: 'whisper-1',
      },
      fetchImpl: async (url, init) => {
        calls.push({
          url,
          body: init?.body ? JSON.parse(init.body) : null,
        });

        if (url.includes('/tools/todo/complete')) {
          return makeJsonResponse({
            success: true,
            todo_id: 15,
            content: '提交报销',
            status: 'done',
          });
        }

        if (url.includes('/v1/chat/completions')) {
          return makeJsonResponse({
            model: 'openclaw/default',
            choices: [{ message: { content: '好，我这边记成已经完成，不再提醒了。' } }],
          });
        }

        throw new Error(`unexpected url: ${url}`);
      },
    }
  );

  assert.equal(response.reply_text, '好，我这边记成已经完成，不再提醒了。');
  assert.equal(calls[0].url, 'http://127.0.0.1:8787/tools/todo/complete');
  assert.equal(calls[1].url, 'http://127.0.0.1:19123/v1/chat/completions');
});

test('sendChatToOpenClawGateway deterministically cancels latest todo for explicit cancel text', async () => {
  const calls = [];

  const response = await sendChatToOpenClawGateway(
    { text: '这个提醒不用了', sender_id: 'user-cancel-reminder', channel: 'wechat' },
    {
      config: {
        baseUrl: 'http://127.0.0.1:19123',
        token: 'abc',
        model: 'openclaw/default',
        modelOverride: '',
        audioModel: 'whisper-1',
      },
      fetchImpl: async (url, init) => {
        calls.push({
          url,
          body: init?.body ? JSON.parse(init.body) : null,
        });

        if (url.includes('/tools/todo/cancel')) {
          return makeJsonResponse({
            success: true,
            todo_id: 21,
            content: '去取快递',
            status: 'cancelled',
          });
        }

        if (url.includes('/v1/chat/completions')) {
          return makeJsonResponse({
            model: 'openclaw/default',
            choices: [{ message: { content: '好，这条提醒我先取消掉。' } }],
          });
        }

        throw new Error(`unexpected url: ${url}`);
      },
    }
  );

  assert.equal(response.reply_text, '好，这条提醒我先取消掉。');
  assert.equal(calls[0].url, 'http://127.0.0.1:8787/tools/todo/cancel');
  assert.equal(calls[1].url, 'http://127.0.0.1:19123/v1/chat/completions');
});

test('sendChatToOpenClawGateway throws on non-ok response', async () => {
  await assert.rejects(
    () => sendChatToOpenClawGateway(
      { text: '你好', sender_id: 'user-1', channel: 'wechat' },
      {
        config: {
          baseUrl: 'http://127.0.0.1:19123',
          token: 'abc',
          model: 'openclaw/default',
          modelOverride: '',
          audioModel: 'whisper-1',
        },
        fetchImpl: async () => makeJsonResponse({ error: { message: 'bad request' } }, false, 400),
      }
    ),
    /openclaw gateway error: bad request/
  );
});

test('sendChatToOpenClawGateway rejects OpenClaw empty-response sentinel', async () => {
  await assert.rejects(
    () => sendChatToOpenClawGateway(
      { text: '你好', sender_id: 'user-empty-sentinel', channel: 'wechat' },
      {
        config: {
          baseUrl: 'http://127.0.0.1:19123',
          token: 'abc',
          model: 'openclaw/default',
          modelOverride: '',
          audioModel: 'whisper-1',
        },
        fetchImpl: async () => makeJsonResponse({
          model: 'openclaw/default',
          choices: [{ message: { content: 'No response from OpenClaw.' } }],
        }),
      }
    ),
    /empty agent response/
  );
});

test('buildTemporalContext derives timeOfDay from Asia/Shanghai time instead of host local time', () => {
  const context = buildTemporalContext(new Date('2026-04-15T23:30:00.000Z'));

  assert.match(context.timeString, /2026年04月16日.*07:30/);
  assert.equal(context.timeOfDay, '早上');
});

test('sendChatToOpenClawGateway injects compact absolute-time guidance before user content', async () => {
  let capturedBody = null;

  await sendChatToOpenClawGateway(
    { text: '下午一点半去找老师这件事还来得及吗', sender_id: 'user-time-guidance', channel: 'wechat' },
    {
      config: {
        baseUrl: 'http://127.0.0.1:19123',
        token: 'abc',
        model: 'openclaw/default',
        modelOverride: '',
        audioModel: 'whisper-1',
      },
      fetchImpl: async (_, init) => {
        capturedBody = JSON.parse(init.body);
        return makeJsonResponse({
          model: 'openclaw/default',
          choices: [{ message: { content: '收到' } }],
        });
      },
    }
  );

  assert.match(capturedBody?.messages?.[0]?.content || '', /当前时间：/);
  assert.match(capturedBody?.messages?.[0]?.content || '', /Asia\/Shanghai/);
  assert.match(capturedBody?.messages?.[0]?.content || '', /回答涉及时间时先和现在对齐/);
});

test('sendChatToOpenClawGateway embeds bridge time context in current user content', async () => {
  let capturedBody = null;

  await sendChatToOpenClawGateway(
    { text: '现在几点了', sender_id: 'user-current-time', channel: 'wechat' },
    {
      config: {
        baseUrl: 'http://127.0.0.1:19123',
        token: 'abc',
        model: 'openclaw/default',
        modelOverride: '',
        audioModel: 'whisper-1',
      },
      fetchImpl: async (_, init) => {
        capturedBody = JSON.parse(init.body);
        return makeJsonResponse({
          model: 'openclaw/default',
          choices: [{ message: { content: '收到' } }],
        });
      },
    }
  );

  const userContent = getUserMessageContent(capturedBody);
  assert.match(userContent, /微信桥接实时上下文/);
  assert.match(userContent, /当前本地时间：/);
  assert.match(userContent, /Asia\/Shanghai/);
  assert.match(userContent, /现在几点了/);
});

test('sendChatToOpenClawGateway converts local image file path to data URI', async () => {
  const { filePath: imagePath } = makeTempFile(
    'cat.png',
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=', 'base64')
  );

  let capturedBody = null;
  await sendChatToOpenClawGateway(
    {
      text: '看图',
      sender_id: 'user-1',
      channel: 'wechat',
      image_urls: [imagePath],
      media: [
        {
          filePath: imagePath,
          type: 'image',
        },
      ],
    },
    {
      config: {
        baseUrl: 'http://127.0.0.1:19123',
        token: 'abc',
        model: 'openclaw/default',
        modelOverride: '',
        audioModel: 'whisper-1',
      },
      fetchImpl: async (_, init) => {
        capturedBody = JSON.parse(init.body);
        return makeJsonResponse({
          model: 'openclaw/default',
          choices: [{ message: { content: '收到' } }],
        });
      },
    }
  );

  const imagePart = getUserMessageContent(capturedBody)?.find?.((part) => part?.type === 'image_url');
  assert.match(imagePart?.image_url?.url || '', /^data:image\/png;base64,/);
});

test('sendChatToOpenClawGateway normalizes wildcard image mimeType from media attachment', async () => {
  const { filePath: imagePath } = makeTempFile(
    'wechat-image.bin',
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=', 'base64')
  );

  let capturedBody = null;
  await sendChatToOpenClawGateway(
    {
      text: '',
      sender_id: 'user-image-wildcard',
      channel: 'wechat',
      media: [
        {
          filePath: imagePath,
          mimeType: 'image/*',
          type: 'image',
        },
      ],
    },
    {
      config: {
        baseUrl: 'http://127.0.0.1:19123',
        token: 'abc',
        model: 'openclaw/default',
        modelOverride: '',
        audioModel: 'whisper-1',
      },
      fetchImpl: async (_, init) => {
        capturedBody = JSON.parse(init.body);
        return makeJsonResponse({
          model: 'openclaw/default',
          choices: [{ message: { content: '收到' } }],
        });
      },
    }
  );

  const imagePart = getUserMessageContent(capturedBody)?.find?.((part) => part?.type === 'image_url');
  assert.match(imagePart?.image_url?.url || '', /^data:image\/png;base64,/);
  assert.doesNotMatch(imagePart?.image_url?.url || '', /^data:image\/\*;base64,/);
});

test('sendChatToOpenClawGateway forwards supported audio as input_audio', async () => {
  const { filePath: audioPath } = makeTempFile('voice.mp3', Buffer.from('ID3'));

  let capturedBody = null;
  await sendChatToOpenClawGateway(
    {
      text: '',
      sender_id: 'user-audio',
      channel: 'wechat',
      media: [
        {
          filePath: audioPath,
          mimeType: 'audio/mpeg',
          type: 'audio',
        },
      ],
    },
    {
      config: {
        baseUrl: 'http://127.0.0.1:19123',
        token: 'abc',
        model: 'openclaw/default',
        modelOverride: '',
        audioModel: 'whisper-1',
      },
      fetchImpl: async (_, init) => {
        capturedBody = JSON.parse(init.body);
        return makeJsonResponse({
          model: 'openclaw/default',
          choices: [{ message: { content: '收到' } }],
        });
      },
    }
  );

  assert.equal(getUserMessageContent(capturedBody)?.[0]?.type, 'input_audio');
  assert.equal(getUserMessageContent(capturedBody)?.[0]?.input_audio?.format, 'mp3');
});

test('sendChatToOpenClawGateway falls back to audio transcription text after gateway rejection', async () => {
  const { filePath: audioPath } = makeTempFile('voice.mp3', Buffer.from('ID3'));

  const chatBodies = [];
  let transcriptionCalls = 0;
  const reply = await sendChatToOpenClawGateway(
    {
      text: '',
      sender_id: 'user-audio-fallback',
      channel: 'wechat',
      media: [
        {
          filePath: audioPath,
          mimeType: 'audio/mpeg',
          type: 'audio',
        },
      ],
    },
    {
      config: {
        baseUrl: 'http://127.0.0.1:19123',
        token: 'abc',
        model: 'openclaw/default',
        modelOverride: '',
        audioModel: 'whisper-1',
      },
      fetchImpl: async (url, init) => {
        if (url.includes('/audio/transcriptions')) {
          transcriptionCalls += 1;
          return makeJsonResponse({ text: '这是转写' });
        }
        if (url.includes('/v1/chat/completions')) {
          const body = JSON.parse(init.body);
          chatBodies.push(body);
          if (chatBodies.length === 1) {
            return makeJsonResponse({ error: { message: 'unsupported audio' } }, false, 400);
          }
          return makeJsonResponse({
            model: 'openclaw/default',
            choices: [{ message: { content: '收到音频' } }],
          });
        }
        throw new Error(`unexpected fetch url: ${url}`);
      },
    }
  );

  assert.equal(reply.reply_text, '收到音频');
  assert.equal(transcriptionCalls, 1);
  assert.equal(chatBodies.length, 2);
  assert.equal(getUserMessageContent(chatBodies[0])?.[0]?.type, 'input_audio');
  assert.equal(typeof getUserMessageContent(chatBodies[1]), 'string');
  assert.match(getUserMessageContent(chatBodies[1]), /这是转写/);
});

test('sendChatToOpenClawGateway forwards local video file path as video_url', async () => {
  const { filePath: videoPath } = makeTempFile('clip.mp4', Buffer.from('ftypmp42'));

  let capturedBody = null;
  await sendChatToOpenClawGateway(
    {
      text: '看视频',
      sender_id: 'user-video',
      channel: 'wechat',
      media: [
        {
          filePath: videoPath,
          mimeType: 'video/mp4',
          type: 'video',
        },
      ],
    },
    {
      config: {
        baseUrl: 'http://127.0.0.1:19123',
        token: 'abc',
        model: 'openclaw/default',
        modelOverride: '',
        audioModel: 'whisper-1',
      },
      fetchImpl: async (_, init) => {
        capturedBody = JSON.parse(init.body);
        return makeJsonResponse({
          model: 'openclaw/default',
          choices: [{ message: { content: '收到' } }],
        });
      },
    }
  );

  const videoPart = getUserMessageContent(capturedBody)?.find?.((part) => part?.type === 'video_url');
  assert.match(videoPart?.video_url?.url || '', /^data:video\/mp4;base64,/);
});

test('sendChatToOpenClawGateway falls back to video text after gateway rejection', async () => {
  const { filePath: videoPath } = makeTempFile('clip.mp4', Buffer.from('ftypmp42'));

  const chatBodies = [];
  const reply = await sendChatToOpenClawGateway(
    {
      text: '',
      sender_id: 'user-video-fallback',
      channel: 'wechat',
      media: [
        {
          filePath: videoPath,
          mimeType: 'video/mp4',
          type: 'video',
        },
      ],
    },
    {
      config: {
        baseUrl: 'http://127.0.0.1:19123',
        token: 'abc',
        model: 'openclaw/default',
        modelOverride: '',
        audioModel: 'whisper-1',
      },
      fetchImpl: async (url, init) => {
        if (url.includes('/v1/chat/completions')) {
          const body = JSON.parse(init.body);
          chatBodies.push(body);
          if (chatBodies.length === 1) {
            return makeJsonResponse({ error: { message: 'unsupported video' } }, false, 400);
          }
          return makeJsonResponse({
            model: 'openclaw/default',
            choices: [{ message: { content: '收到视频' } }],
          });
        }
        throw new Error(`unexpected fetch url: ${url}`);
      },
    }
  );

  assert.equal(reply.reply_text, '收到视频');
  assert.equal(chatBodies.length, 2);
  assert.equal(typeof getUserMessageContent(chatBodies[1]), 'string');
  assert.match(getUserMessageContent(chatBodies[1]), /视频信息/);
});
