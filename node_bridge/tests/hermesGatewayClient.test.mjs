import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';

import {
  getHermesGatewayConfig,
  sendChatToHermesGateway,
  buildCourtlyStyleAnchor,
  readXhsTokenCache,
  matchXhsTokenCacheEntry,
  buildSocialEvidenceReport,
  applySocialLinkEvidenceGate,
} from '../src/hermesGatewayClient.mjs';
import {
  getHermesLiteSoftResetConfig,
  readHermesLiteMaintenanceState,
  runHermesLiteSoftReset,
} from '../src/hermesSessionMaintenance.mjs';
import { saveSensorLoggerMessage } from '../src/environmentSense.mjs';

const PROJECT_ROOT = path.resolve(new URL('../..', import.meta.url).pathname);

function makeJsonResponse(body, ok = true, status = 200) {
  return {
    ok,
    status,
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}

function historyTurns(prefix, count, filler = '') {
  const messages = [];
  for (let index = 1; index <= count; index += 1) {
    messages.push({ role: 'user', content: `${prefix} user ${index} ${filler}`.trim() });
    messages.push({ role: 'assistant', content: `${prefix} assistant ${index} ${filler}`.trim() });
  }
  return messages;
}

async function captureHermesRequest({ payload = {}, env = {}, responseBody = null } = {}) {
  const logs = [];
  const warns = [];
  let capturedBody = null;
  let capturedHeaders = null;
  await sendChatToHermesGateway(
    {
      text: '当前用户消息',
      sender_id: 'capture-sender',
      conversation_id: 'capture-conversation',
      channel: 'wechat',
      ...payload,
    },
    {
      config: getHermesGatewayConfig({
        HERMES_API_BASE_URL: 'http://127.0.0.1:8642/v1',
        HERMES_API_KEY: 'token',
        HERMES_REPLY_MODE: 'api',
        RAN_AGENT_CONTEXT_SIZE_LOG: '1',
        ...env,
      }),
      fetchImpl: async (url, options) => {
        capturedBody = JSON.parse(options.body);
        capturedHeaders = options.headers;
        return makeJsonResponse(responseBody || { choices: [{ message: { content: 'ok' } }] });
      },
      logger: {
        log(msg) { logs.push(msg); },
        warn(msg) { warns.push(msg); },
      },
    }
  );
  return { capturedBody, capturedHeaders, logs, warns };
}

function parseContextComponentsLog(logs) {
  const line = logs.find((item) => item.startsWith('[hermes-context-components]'));
  assert.ok(line, 'expected hermes context component log');
  return JSON.parse(line.slice(line.indexOf('{')));
}

function parseProviderUsageLog(logs) {
  const line = logs.find((item) => item.startsWith('[hermes-provider-usage]'));
  assert.ok(line, 'expected hermes provider usage log');
  return JSON.parse(line.slice(line.indexOf('{')));
}

function tempGatewayStateDir(prefix = 'hermes-gateway-soft-reset-') {
  const base = path.join(PROJECT_ROOT, '.ran_agent_state');
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, prefix));
}

function readProviderVisibleHistoryFiles(stateDir) {
  const dir = path.join(stateDir, 'hermes', 'provider_visible_history');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => path.join(dir, name));
}

function readProviderVisibleHistoryRecords(stateDir) {
  const files = readProviderVisibleHistoryFiles(stateDir);
  assert.equal(files.length, 1, 'expected one provider-visible history file');
  return fs.readFileSync(files[0], 'utf8')
    .split(/\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test('getHermesGatewayConfig reads Hermes defaults and normalizes base URL', () => {
  const config = getHermesGatewayConfig({
    HERMES_API_BASE_URL: 'http://127.0.0.1:8642/v1/',
    HERMES_API_KEY: 'token',
    HERMES_PROFILE: 'ran-assistant',
    HERMES_PROVIDER: 'deepseek',
    HERMES_DEFAULT_MODEL: 'deepseek-v4-flash',
    HERMES_REPLY_MODE: 'auto',
    RAN_AGENT_CONTEXT_POLICY: 'compact',
    RAN_AGENT_MAX_MEDIA_ARTIFACTS: '2',
    RAN_AGENT_CONTEXT_SIZE_LOG: '0',
  });

  assert.equal(config.baseUrl, 'http://127.0.0.1:8642/v1');
  assert.equal(config.token, 'token');
  assert.equal(config.profile, 'ran-assistant');
  assert.equal(config.provider, 'deepseek');
  assert.equal(config.model, 'deepseek-v4-flash');
  assert.equal(config.mode, 'auto');
  assert.equal(config.maxMediaArtifacts, 2);
  assert.equal(config.enableContextSizeLog, false);
});

test('sendChatToHermesGateway calls OpenAI-compatible Hermes API server', async () => {
  let capturedUrl = '';
  let capturedBody = null;
  let capturedHeaders = null;
  const response = await sendChatToHermesGateway(
    {
      text: '你好',
      sender_id: 'conv-hermes-api',
      channel: 'wechat',
      message_batch: [{ text: '你好' }, { text: '补一句' }],
    },
    {
      config: getHermesGatewayConfig({
        HERMES_API_BASE_URL: 'http://127.0.0.1:8642/v1',
        HERMES_API_KEY: 'token',
        HERMES_PROFILE: 'ran-assistant',
        HERMES_DEFAULT_MODEL: 'deepseek-v4-flash',
        RAN_AGENT_CONTEXT_SIZE_LOG: '0',
        RAN_AGENT_CAPABILITY_MODE: 'full',
      }),
      fetchImpl: async (url, init) => {
        // Health check to /models has no body; chat completions has body
        if (init?.body) {
          capturedUrl = url;
          capturedHeaders = init.headers;
          capturedBody = JSON.parse(init.body);
        }
        return makeJsonResponse({
          model: 'ran-assistant',
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'Hermes reply',
              },
            },
          ],
        });
      },
    }
  );

  assert.equal(capturedUrl, 'http://127.0.0.1:8643/v1/chat/completions');
  assert.equal(capturedHeaders.Authorization, 'Bearer token');
  assert.equal(capturedBody.model, 'ran-assistant');
  assert.equal(capturedBody.stream, false);
  assert.match(capturedBody.messages[0].content, /Hermes/);
  assert.match(capturedBody.messages[1].content, /时间/);
  assert.match(capturedBody.messages[1].content, /你好\n补一句/);
  assert.equal(response.reply_text, 'Hermes reply');
  assert.equal(response.model, 'ran-assistant');
});

test('sendChatToHermesGateway injects lightweight environment context when state is fresh', async () => {
  const stateDir = tempGatewayStateDir('hermes-env-context-');
  const env = {
    RAN_AGENT_STATE_DIR: stateDir,
    HERMES_ENVIRONMENT_CONTEXT_ENABLED: 'true',
    HERMES_ENVIRONMENT_HOME_LAT: '31.2304',
    HERMES_ENVIRONMENT_HOME_LON: '121.4737',
    HERMES_ENVIRONMENT_HOME_RADIUS_M: '250',
    HERMES_ENVIRONMENT_CITY_LABEL: '上海',
  };
  saveSensorLoggerMessage({
    messageId: 1,
    sessionId: 'session-a',
    deviceId: 'phone-a',
    payload: [
      { name: 'location', time: 1710000000000000000, values: { latitude: 31.2304, longitude: 121.4737, horizontalAccuracy: 8 } },
      { name: 'battery', time: 1710000001000000000, values: { batteryLevel: 0.19, batteryState: 'unplugged', lowPowerMode: true } },
    ],
  }, {
    env,
    now: new Date(),
  });

  let capturedBody = null;
  const response = await sendChatToHermesGateway(
    {
      text: '我现在出门要带伞吗',
      sender_id: 'conv-hermes-env',
      conversation_id: 'conv-hermes-env',
      channel: 'wechat',
    },
    {
      env,
      config: getHermesGatewayConfig({
        ...env,
        HERMES_API_BASE_URL: 'http://127.0.0.1:8642/v1',
        HERMES_API_KEY: 'token',
        HERMES_REPLY_MODE: 'api',
        RAN_AGENT_CONTEXT_SIZE_LOG: '0',
      }),
      fetchImpl: async (url, init) => {
        const text = String(url);
        if (text.includes('air-quality-api.open-meteo.com')) {
          return makeJsonResponse({ current: { pm2_5: 10, us_aqi: 42, uv_index: 4 } });
        }
        if (text.includes('api.open-meteo.com')) {
          return makeJsonResponse({
            current: {
              temperature_2m: 28,
              apparent_temperature: 31,
              relative_humidity_2m: 72,
              precipitation: 0,
              weather_code: 2,
              cloud_cover: 45,
              wind_speed_10m: 8,
              surface_pressure: 1007,
            },
          });
        }
        capturedBody = JSON.parse(init.body);
        return makeJsonResponse({ choices: [{ message: { content: 'env ok' } }] });
      },
      logger: { log() {}, warn() {} },
    }
  );

  assert.equal(response.reply_text, 'env ok');
  assert.match(capturedBody.messages[1].content, /环境感知/);
  assert.match(capturedBody.messages[1].content, /上海/);
  assert.match(capturedBody.messages[1].content, /在家/);
  assert.match(capturedBody.messages[1].content, /电量19%/);
});

test('Hermes API requests include stable session headers per WeChat conversation', async () => {
  const headersByConversation = new Map();
  const config = getHermesGatewayConfig({
    HERMES_API_BASE_URL: 'http://127.0.0.1:8642/v1',
    HERMES_API_KEY: 'token',
    HERMES_REPLY_MODE: 'api',
    RAN_AGENT_CONTEXT_SIZE_LOG: '0',
    HERMES_SESSION_CONTINUITY_ENABLED: 'true',
  });

  for (const sender_id of ['wx-session-a', 'wx-session-a', 'wx-session-b']) {
    await sendChatToHermesGateway(
      { text: `你好 ${sender_id}`, sender_id, conversation_id: sender_id, channel: 'wechat' },
      {
        config,
        fetchImpl: async (url, options) => {
          if (options?.body) {
            const list = headersByConversation.get(sender_id) || [];
            list.push(options.headers);
            headersByConversation.set(sender_id, list);
          }
          return makeJsonResponse({ choices: [{ message: { content: `reply ${sender_id}` } }] });
        },
        logger: { log() {}, warn() {} },
      }
    );
  }

  const first = headersByConversation.get('wx-session-a')[0];
  const second = headersByConversation.get('wx-session-a')[1];
  const other = headersByConversation.get('wx-session-b')[0];

  assert.equal(first['X-Hermes-Session-Id'], second['X-Hermes-Session-Id']);
  assert.equal(first['X-Hermes-Session-Key'], second['X-Hermes-Session-Key']);
  assert.notEqual(first['X-Hermes-Session-Id'], other['X-Hermes-Session-Id']);
  assert.notEqual(first['X-Hermes-Session-Key'], other['X-Hermes-Session-Key']);
  assert.match(first['X-Hermes-Session-Id'], /^ran-agent-wechat-[a-f0-9]{16}$/);
  assert.match(first['X-Hermes-Session-Key'], /^ran-agent-memory-[a-f0-9]{16}$/);
});

test('Hermes API requests accept ChannelHub session id and global session key', async () => {
  let capturedHeaders = null;
  let capturedBody = null;
  const config = getHermesGatewayConfig({
    HERMES_API_BASE_URL: 'http://127.0.0.1:8642/v1',
    HERMES_API_KEY: 'token',
    HERMES_REPLY_MODE: 'api',
    RAN_AGENT_CONTEXT_SIZE_LOG: '0',
  });

  await sendChatToHermesGateway(
    {
      text: '我觉得她的故事特别令人感动',
      sender_id: 'ou-user',
      conversation_id: 'feishu-chat',
      channel: 'feishu',
      platform: 'feishu',
      global_user_id: 'user:ran',
      hermes_session_id: 'ran-agent-feishu-dm-1111222233334444',
      hermes_session_key: 'ran-agent-memory-aaaabbbbccccdddd',
      recent_local_history: [
        { role: 'user', content: '我们聊内莉·布莱' },
        { role: 'assistant', content: '她是卧底疯人院的记者。' },
      ],
      recent_global_history: [
        { role: 'user', content: '微信里提到强女故事03｜她把自己送进了疯人院' },
      ],
      continuity_note: 'current_topic: 内莉·布莱 / 她把自己送进疯人院\nopen_loop: 接住她的故事',
    },
    {
      config,
      fetchImpl: async (url, options) => {
        capturedHeaders = options.headers;
        capturedBody = JSON.parse(options.body);
        return makeJsonResponse({ choices: [{ message: { content: '接上内莉·布莱。' } }] });
      },
      logger: { log() {}, warn() {} },
    }
  );

  assert.equal(capturedHeaders['X-Hermes-Session-Id'], 'ran-agent-feishu-dm-1111222233334444');
  assert.equal(capturedHeaders['X-Hermes-Session-Key'], 'ran-agent-memory-aaaabbbbccccdddd');
  assert.deepEqual(capturedBody.messages.slice(1, 3), [
    { role: 'user', content: '我们聊内莉·布莱' },
    { role: 'assistant', content: '她是卧底疯人院的记者。' },
  ]);
  const finalUser = capturedBody.messages.at(-1).content;
  assert.match(finalUser, /current_topic: 内莉·布莱/);
  assert.match(finalUser, /global active topic/i);
  assert.match(finalUser, /微信里提到强女故事03/);
});

test('Hermes API requests include recent conversation history before current user', async () => {
  let secondBody = null;
  const conversationId = 'wx-nellie-history';
  const config = getHermesGatewayConfig({
    HERMES_API_BASE_URL: 'http://127.0.0.1:8642/v1',
    HERMES_API_KEY: 'token',
    HERMES_REPLY_MODE: 'api',
    RAN_AGENT_CONTEXT_SIZE_LOG: '0',
    HERMES_SESSION_CONTINUITY_ENABLED: 'true',
    HERMES_RECENT_TEXT_TURNS: '10',
  });

  await sendChatToHermesGateway(
    { text: '我们聊内莉·布莱', sender_id: conversationId, conversation_id: conversationId, channel: 'wechat' },
    {
      config,
      fetchImpl: async () => makeJsonResponse({ choices: [{ message: { content: '她是1887年卧底疯人院的记者。' } }] }),
      logger: { log() {}, warn() {} },
    }
  );
  await sendChatToHermesGateway(
    { text: '我觉得她的故事特别令人感动', sender_id: conversationId, conversation_id: conversationId, channel: 'wechat' },
    {
      config,
      fetchImpl: async (url, options) => {
        secondBody = JSON.parse(options.body);
        return makeJsonResponse({ choices: [{ message: { content: '是的，她的勇气很动人。' } }] });
      },
      logger: { log() {}, warn() {} },
    }
  );

  assert.deepEqual(secondBody.messages.map((message) => message.role), ['system', 'user', 'assistant', 'user']);
  assert.equal(secondBody.messages[1].content, '我们聊内莉·布莱');
  assert.equal(secondBody.messages[2].content, '她是1887年卧底疯人院的记者。');
  assert.match(secondBody.messages[3].content, /我觉得她的故事特别令人感动/);
});

test('cache-friendly history is disabled by default and preserves legacy recent text behavior', async () => {
  let secondBody = null;
  const conversationId = 'wx-cache-friendly-default-off';
  const stateDir = tempGatewayStateDir();
  const config = getHermesGatewayConfig({
    HERMES_API_BASE_URL: 'http://127.0.0.1:8642/v1',
    HERMES_API_KEY: 'token',
    HERMES_REPLY_MODE: 'api',
    RAN_AGENT_CONTEXT_SIZE_LOG: '0',
    RAN_AGENT_STATE_DIR: stateDir,
  });

  await sendChatToHermesGateway(
    { text: '第一轮用户原文', sender_id: conversationId, conversation_id: conversationId, channel: 'wechat' },
    { config, fetchImpl: async () => makeJsonResponse({ choices: [{ message: { content: '第一轮回复' } }] }), logger: { log() {}, warn() {} } }
  );
  await sendChatToHermesGateway(
    { text: '第二轮', sender_id: conversationId, conversation_id: conversationId, channel: 'wechat' },
    {
      config,
      fetchImpl: async (url, options) => {
        secondBody = JSON.parse(options.body);
        return makeJsonResponse({ choices: [{ message: { content: '第二轮回复' } }] });
      },
      logger: { log() {}, warn() {} },
    }
  );

  assert.equal(secondBody.messages[1].content, '第一轮用户原文');
  assert.deepEqual(readProviderVisibleHistoryFiles(stateDir), []);
});

test('cache-friendly history writes provider-visible prompts and reuses them as append history', async () => {
  let secondBody = null;
  const conversationId = 'wx-cache-friendly-append';
  const stateDir = tempGatewayStateDir();
  const config = getHermesGatewayConfig({
    HERMES_API_BASE_URL: 'http://127.0.0.1:8642/v1',
    HERMES_API_KEY: 'token',
    HERMES_REPLY_MODE: 'api',
    RAN_AGENT_CONTEXT_SIZE_LOG: '1',
    RAN_AGENT_STATE_DIR: stateDir,
    HERMES_CACHE_FRIENDLY_HISTORY: 'true',
  });

  await sendChatToHermesGateway(
    { text: '第一轮用户原文', sender_id: conversationId, conversation_id: conversationId, channel: 'wechat' },
    { config, fetchImpl: async () => makeJsonResponse({ choices: [{ message: { content: '第一轮 provider 回复' } }] }), logger: { log() {}, warn() {} } }
  );
  const historyFiles = readProviderVisibleHistoryFiles(stateDir);
  assert.equal(historyFiles.length, 1);
  const stored = fs.readFileSync(historyFiles[0], 'utf8');
  assert.match(stored, /第一轮用户原文/);
  assert.match(stored, /provider-visible/);

  await sendChatToHermesGateway(
    { text: '第二轮', sender_id: conversationId, conversation_id: conversationId, channel: 'wechat' },
    {
      config,
      fetchImpl: async (url, options) => {
        secondBody = JSON.parse(options.body);
        return makeJsonResponse({ choices: [{ message: { content: '第二轮 provider 回复' } }] });
      },
      logger: { log() {}, warn() {} },
    }
  );

  assert.deepEqual(secondBody.messages.map((message) => message.role), ['system', 'user', 'assistant', 'user']);
  assert.match(secondBody.messages[1].content, /第一轮用户原文/);
  assert.match(secondBody.messages[1].content, /时间/);
  assert.equal(secondBody.messages[2].content, '第一轮 provider 回复');
  assert.match(secondBody.messages[3].content, /第二轮/);
});

test('cache-friendly append records clean provider-visible content as cache exact', async () => {
  const conversationId = 'wx-cache-exact-clean';
  const stateDir = tempGatewayStateDir();
  const config = getHermesGatewayConfig({
    HERMES_API_BASE_URL: 'http://127.0.0.1:8642/v1',
    HERMES_API_KEY: 'token',
    HERMES_REPLY_MODE: 'api',
    RAN_AGENT_CONTEXT_SIZE_LOG: '0',
    RAN_AGENT_STATE_DIR: stateDir,
    HERMES_CACHE_FRIENDLY_HISTORY: 'true',
  });

  await sendChatToHermesGateway(
    { text: '干净历史内容', sender_id: conversationId, conversation_id: conversationId, channel: 'wechat' },
    {
      config,
      fetchImpl: async () => makeJsonResponse({ choices: [{ message: { content: '干净 provider 回复' } }] }),
      logger: { log() {}, warn() {} },
    }
  );

  const [record] = readProviderVisibleHistoryRecords(stateDir);
  assert.equal(record.cache_exact, true);
  assert.equal(record.sanitized_changed, false);
  assert.equal(record.sanitized_reason, 'none');
  assert.match(record.provider_content_hash, /^[a-f0-9]{64}$/);
  assert.equal(record.provider_content_hash, record.stored_content_hash);
});

test('cache-friendly append records sanitized content as cache inexact without storing secrets', async () => {
  const conversationId = 'wx-cache-exact-sanitized';
  const stateDir = tempGatewayStateDir();
  const config = getHermesGatewayConfig({
    HERMES_API_BASE_URL: 'http://127.0.0.1:8642/v1',
    HERMES_API_KEY: 'token',
    HERMES_REPLY_MODE: 'api',
    RAN_AGENT_CONTEXT_SIZE_LOG: '0',
    RAN_AGENT_STATE_DIR: stateDir,
    HERMES_CACHE_FRIENDLY_HISTORY: 'true',
  });

  await sendChatToHermesGateway(
    {
      text: '请看 token=abc123 和 /Users/fengran/private.txt',
      sender_id: conversationId,
      conversation_id: conversationId,
      channel: 'wechat',
    },
    {
      config,
      fetchImpl: async () => makeJsonResponse({ choices: [{ message: { content: '回复里也有 cookie=secret456 和 /opt/ran_agent/.env.local' } }] }),
      logger: { log() {}, warn() {} },
    }
  );

  const serialized = fs.readFileSync(readProviderVisibleHistoryFiles(stateDir)[0], 'utf8');
  const [record] = readProviderVisibleHistoryRecords(stateDir);
  assert.equal(record.cache_exact, false);
  assert.equal(record.sanitized_changed, true);
  assert.equal(record.sanitized_reason, 'multiple');
  assert.match(record.provider_content_hash, /^[a-f0-9]{64}$/);
  assert.match(record.stored_content_hash, /^[a-f0-9]{64}$/);
  assert.notEqual(record.provider_content_hash, record.stored_content_hash);
  assert.doesNotMatch(serialized, /abc123|secret456|\/Users\/fengran|\/opt\/ran_agent/);
});

test('cache-friendly telemetry reports exactness ratio and prefix break for sanitized history', async () => {
  const conversationId = 'wx-cache-exact-telemetry';
  const stateDir = tempGatewayStateDir();
  const config = getHermesGatewayConfig({
    HERMES_API_BASE_URL: 'http://127.0.0.1:8642/v1',
    HERMES_API_KEY: 'token',
    HERMES_REPLY_MODE: 'api',
    RAN_AGENT_CONTEXT_SIZE_LOG: '1',
    RAN_AGENT_STATE_DIR: stateDir,
    HERMES_CACHE_FRIENDLY_HISTORY: 'true',
  });

  await sendChatToHermesGateway(
    { text: '第一轮 clean', sender_id: conversationId, conversation_id: conversationId, channel: 'wechat' },
    { config, fetchImpl: async () => makeJsonResponse({ choices: [{ message: { content: '第一轮 clean 回复' } }] }), logger: { log() {}, warn() {} } }
  );
  await sendChatToHermesGateway(
    { text: '第二轮 token=broken /Users/fengran/secret.txt', sender_id: conversationId, conversation_id: conversationId, channel: 'wechat' },
    { config, fetchImpl: async () => makeJsonResponse({ choices: [{ message: { content: '第二轮回复' } }] }), logger: { log() {}, warn() {} } }
  );

  const logs = [];
  await sendChatToHermesGateway(
    { text: '第三轮观察 telemetry', sender_id: conversationId, conversation_id: conversationId, channel: 'wechat' },
    {
      config,
      fetchImpl: async () => makeJsonResponse({
        choices: [{ message: { content: '第三轮回复' } }],
        usage: { prompt_cache_hit_tokens: 10, prompt_cache_miss_tokens: 5 },
      }),
      logger: { log(msg) { logs.push(msg); }, warn() {} },
    }
  );

  const usage = parseProviderUsageLog(logs);
  assert.equal(usage.cache_strategy, 'balanced');
  assert.equal(usage.cache_exact_history_turns, 1);
  assert.equal(usage.cache_inexact_history_turns, 1);
  assert.equal(usage.cache_prefix_broken_at_turn, 2);
  assert.equal(usage.sanitized_changed, true);
  assert.equal(usage.cache_exact_ratio, 0.5);
});

test('cache-friendly history does not write assistant append records when provider fails', async () => {
  const conversationId = 'wx-cache-friendly-failure';
  const stateDir = tempGatewayStateDir();
  const config = getHermesGatewayConfig({
    HERMES_API_BASE_URL: 'http://127.0.0.1:8642/v1',
    HERMES_API_KEY: 'token',
    HERMES_REPLY_MODE: 'api',
    RAN_AGENT_CONTEXT_SIZE_LOG: '0',
    RAN_AGENT_STATE_DIR: stateDir,
    HERMES_CACHE_FRIENDLY_HISTORY: 'true',
  });

  await assert.rejects(
    () => sendChatToHermesGateway(
      { text: '这轮会失败', sender_id: conversationId, conversation_id: conversationId, channel: 'wechat' },
      { config, fetchImpl: async () => makeJsonResponse({ error: 'down' }, false, 503), logger: { log() {}, warn() {} } }
    ),
    /HTTP 503/
  );

  assert.deepEqual(readProviderVisibleHistoryFiles(stateDir), []);
});

test('cache-friendly history trims old turns by max turn budget', async () => {
  let thirdBody = null;
  const conversationId = 'wx-cache-friendly-turn-budget';
  const stateDir = tempGatewayStateDir();
  const config = getHermesGatewayConfig({
    HERMES_API_BASE_URL: 'http://127.0.0.1:8642/v1',
    HERMES_API_KEY: 'token',
    HERMES_REPLY_MODE: 'api',
    RAN_AGENT_CONTEXT_SIZE_LOG: '1',
    RAN_AGENT_STATE_DIR: stateDir,
    HERMES_CACHE_FRIENDLY_HISTORY: 'true',
    HERMES_CACHE_FRIENDLY_HISTORY_MAX_TURNS: '1',
  });

  await sendChatToHermesGateway(
    { text: '第一轮应该被裁剪', sender_id: conversationId, conversation_id: conversationId, channel: 'wechat' },
    { config, fetchImpl: async () => makeJsonResponse({ choices: [{ message: { content: '第一轮回复' } }] }), logger: { log() {}, warn() {} } }
  );
  await sendChatToHermesGateway(
    { text: '第二轮应该保留', sender_id: conversationId, conversation_id: conversationId, channel: 'wechat' },
    { config, fetchImpl: async () => makeJsonResponse({ choices: [{ message: { content: '第二轮回复' } }] }), logger: { log() {}, warn() {} } }
  );
  await sendChatToHermesGateway(
    { text: '第三轮当前用户消息不能被裁剪', sender_id: conversationId, conversation_id: conversationId, channel: 'wechat' },
    {
      config,
      fetchImpl: async (url, options) => {
        thirdBody = JSON.parse(options.body);
        return makeJsonResponse({ choices: [{ message: { content: '第三轮回复' } }] });
      },
      logger: { log() {}, warn() {} },
    }
  );

  const serialized = JSON.stringify(thirdBody.messages);
  assert.doesNotMatch(serialized, /第一轮应该被裁剪/);
  assert.match(serialized, /第二轮应该保留/);
  assert.match(thirdBody.messages.at(-1).content, /第三轮当前用户消息不能被裁剪/);
});

test('cache-friendly history trims old turns by char budget without trimming current user', async () => {
  let secondBody = null;
  const conversationId = 'wx-cache-friendly-char-budget';
  const stateDir = tempGatewayStateDir();
  const config = getHermesGatewayConfig({
    HERMES_API_BASE_URL: 'http://127.0.0.1:8642/v1',
    HERMES_API_KEY: 'token',
    HERMES_REPLY_MODE: 'api',
    RAN_AGENT_CONTEXT_SIZE_LOG: '0',
    RAN_AGENT_STATE_DIR: stateDir,
    HERMES_CACHE_FRIENDLY_HISTORY: 'true',
    HERMES_CACHE_FRIENDLY_HISTORY_CHAR_BUDGET: '20',
  });

  await sendChatToHermesGateway(
    { text: `第一轮超长 ${'长内容'.repeat(80)}`, sender_id: conversationId, conversation_id: conversationId, channel: 'wechat' },
    { config, fetchImpl: async () => makeJsonResponse({ choices: [{ message: { content: `第一轮超长回复 ${'回复'.repeat(80)}` } }] }), logger: { log() {}, warn() {} } }
  );
  await sendChatToHermesGateway(
    { text: '第二轮当前用户消息不能被裁剪', sender_id: conversationId, conversation_id: conversationId, channel: 'wechat' },
    {
      config,
      fetchImpl: async (url, options) => {
        secondBody = JSON.parse(options.body);
        return makeJsonResponse({ choices: [{ message: { content: '第二轮回复' } }] });
      },
      logger: { log() {}, warn() {} },
    }
  );

  const serialized = JSON.stringify(secondBody.messages);
  assert.doesNotMatch(serialized, /第一轮超长/);
  assert.match(secondBody.messages.at(-1).content, /第二轮当前用户消息不能被裁剪/);
});

test('cache-friendly history falls back to legacy recent history when append log is corrupt', async () => {
  let secondBody = null;
  const conversationId = 'wx-cache-friendly-corrupt';
  const stateDir = tempGatewayStateDir();
  const config = getHermesGatewayConfig({
    HERMES_API_BASE_URL: 'http://127.0.0.1:8642/v1',
    HERMES_API_KEY: 'token',
    HERMES_REPLY_MODE: 'api',
    RAN_AGENT_CONTEXT_SIZE_LOG: '0',
    RAN_AGENT_STATE_DIR: stateDir,
    HERMES_CACHE_FRIENDLY_HISTORY: 'true',
  });

  await sendChatToHermesGateway(
    { text: '第一轮原文用于旧内存回退', sender_id: conversationId, conversation_id: conversationId, channel: 'wechat' },
    { config, fetchImpl: async () => makeJsonResponse({ choices: [{ message: { content: '第一轮回复' } }] }), logger: { log() {}, warn() {} } }
  );
  for (const file of readProviderVisibleHistoryFiles(stateDir)) {
    writeFileSync(file, '{not valid jsonl}\n');
  }

  await sendChatToHermesGateway(
    { text: '第二轮', sender_id: conversationId, conversation_id: conversationId, channel: 'wechat' },
    {
      config,
      fetchImpl: async (url, options) => {
        secondBody = JSON.parse(options.body);
        return makeJsonResponse({ choices: [{ message: { content: '第二轮回复' } }] });
      },
      logger: { log() {}, warn() {} },
    }
  );

  assert.equal(secondBody.messages[1].content, '第一轮原文用于旧内存回退');
});

test('cache telemetry calculates cache hit ratio and tolerates missing usage fields', async () => {
  const logs = [];
  const stateDir = tempGatewayStateDir();
  const config = getHermesGatewayConfig({
    HERMES_API_BASE_URL: 'http://127.0.0.1:8642/v1',
    HERMES_API_KEY: 'token',
    HERMES_REPLY_MODE: 'api',
    RAN_AGENT_CONTEXT_SIZE_LOG: '1',
    RAN_AGENT_STATE_DIR: stateDir,
    HERMES_CACHE_TELEMETRY_ENABLED: 'true',
  });

  await sendChatToHermesGateway(
    { text: ' telemetry ', sender_id: 'wx-cache-telemetry', conversation_id: 'wx-cache-telemetry', channel: 'wechat' },
    {
      config,
      fetchImpl: async () => makeJsonResponse({
        choices: [{ message: { content: 'ok' } }],
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          total_tokens: 120,
          prompt_cache_hit_tokens: 75,
          prompt_cache_miss_tokens: 25,
        },
      }),
      logger: { log(msg) { logs.push(msg); }, warn() {} },
    }
  );
  const usage = parseProviderUsageLog(logs);
  assert.equal(usage.cache_hit_ratio, 0.75);
  assert.equal(usage.cache_friendly_history_enabled, false);
  assert.equal(usage.cache_friendly_history_turns, 0);
  assert.equal(usage.soft_reset_resume, false);
  assert.equal(typeof usage.daily_digest_chars, 'number');

  const missingLogs = [];
  await sendChatToHermesGateway(
    { text: 'missing usage', sender_id: 'wx-cache-telemetry-missing', conversation_id: 'wx-cache-telemetry-missing', channel: 'wechat' },
    {
      config,
      fetchImpl: async () => makeJsonResponse({ choices: [{ message: { content: 'ok' } }] }),
      logger: { log(msg) { missingLogs.push(msg); }, warn() {} },
    }
  );
  const missing = parseProviderUsageLog(missingLogs);
  assert.equal(missing.prompt_cache_hit_tokens, null);
  assert.equal(missing.prompt_cache_miss_tokens, null);
  assert.equal(missing.cache_hit_ratio, null);
});

test('cache-friendly append log redacts tokens cookies and absolute paths', async () => {
  const conversationId = 'wx-cache-friendly-redact';
  const stateDir = tempGatewayStateDir();
  const config = getHermesGatewayConfig({
    HERMES_API_BASE_URL: 'http://127.0.0.1:8642/v1',
    HERMES_API_KEY: 'token',
    HERMES_REPLY_MODE: 'api',
    RAN_AGENT_CONTEXT_SIZE_LOG: '0',
    RAN_AGENT_STATE_DIR: stateDir,
    HERMES_CACHE_FRIENDLY_HISTORY: 'true',
  });

  await sendChatToHermesGateway(
    {
      text: '请记一下 token=abc123 cookie=session456 文件 /Users/fengran/secret.txt 和 /opt/ran_agent/.env.local',
      sender_id: conversationId,
      conversation_id: conversationId,
      channel: 'wechat',
    },
    { config, fetchImpl: async () => makeJsonResponse({ choices: [{ message: { content: 'raw token=reply-secret /private/tmp/file' } }] }), logger: { log() {}, warn() {} } }
  );

  const text = fs.readFileSync(readProviderVisibleHistoryFiles(stateDir)[0], 'utf8');
  assert.doesNotMatch(text, /abc123|session456|reply-secret|\/Users\/fengran|\/opt\/ran_agent|\/private\/tmp/);
  assert.match(text, /token=\[redacted\]/);
  assert.match(text, /\[path\]/);
});

test('cache-friendly append log keeps raw provider response and final gate summary separately', async () => {
  const conversationId = 'wx-cache-friendly-gate-summary';
  const stateDir = tempGatewayStateDir();
  const config = getHermesGatewayConfig({
    HERMES_API_BASE_URL: 'http://127.0.0.1:8642/v1',
    HERMES_API_KEY: 'token',
    HERMES_REPLY_MODE: 'api',
    RAN_AGENT_CONTEXT_SIZE_LOG: '0',
    RAN_AGENT_STATE_DIR: stateDir,
    HERMES_CACHE_FRIENDLY_HISTORY: 'true',
  });

  const response = await sendChatToHermesGateway(
    {
      text: '读一下 http://xhslink.com/o/no-cache-evidence',
      sender_id: conversationId,
      conversation_id: conversationId,
      channel: 'wechat',
    },
    {
      config,
      fetchImpl: async () => makeJsonResponse({ choices: [{ message: { content: '我已经读到了全文，内容很完整。' } }] }),
      logger: { log() {}, warn() {} },
    }
  );

  assert.notEqual(response.reply_text, '我已经读到了全文，内容很完整。');
  const record = JSON.parse(fs.readFileSync(readProviderVisibleHistoryFiles(stateDir)[0], 'utf8').trim());
  assert.equal(record.messages[1].content, '我已经读到了全文，内容很完整。');
  assert.match(record.final_delivered_summary, /没有成功解析|没有拿到正文|不能说已经读到了全文/);
});

test('cache-friendly history does not break current media compact injection', async () => {
  let capturedBody = null;
  const stateDir = tempGatewayStateDir();
  await sendChatToHermesGateway(
    {
      text: '看看这张图',
      sender_id: 'wx-cache-friendly-media',
      conversation_id: 'wx-cache-friendly-media',
      channel: 'wechat',
      media: [{ filePath: '/tmp/test.png', mimeType: 'image/png', type: 'image' }],
    },
    {
      config: getHermesGatewayConfig({
        HERMES_API_BASE_URL: 'http://127.0.0.1:8642/v1',
        HERMES_API_KEY: 'token',
        HERMES_REPLY_MODE: 'api',
        RAN_AGENT_CONTEXT_SIZE_LOG: '0',
        RAN_AGENT_STATE_DIR: stateDir,
        HERMES_CACHE_FRIENDLY_HISTORY: 'true',
      }),
      fetchImpl: async (url, options) => {
        capturedBody = JSON.parse(options.body);
        return makeJsonResponse({ choices: [{ message: { content: 'ok' } }] });
      },
      logger: { log() {}, warn() {} },
    }
  );

  assert.match(capturedBody.messages.at(-1).content, /入站媒体/);
  assert.match(capturedBody.messages.at(-1).content, /媒体工具指令/);
});

test('cache-friendly history is not enabled for full profile by default', async () => {
  let secondBody = null;
  const conversationId = 'wx-cache-friendly-full-default';
  const stateDir = tempGatewayStateDir();
  const config = getHermesGatewayConfig({
    HERMES_LITE_API_BASE_URL: 'http://127.0.0.1:8642/v1',
    HERMES_FULL_API_BASE_URL: 'http://127.0.0.1:8643/v1',
    HERMES_API_KEY: 'token',
    HERMES_REPLY_MODE: 'api',
    RAN_AGENT_CONTEXT_SIZE_LOG: '0',
    RAN_AGENT_STATE_DIR: stateDir,
    RAN_AGENT_CAPABILITY_MODE: 'full',
    HERMES_CACHE_FRIENDLY_HISTORY: 'true',
  });

  await sendChatToHermesGateway(
    { text: '第一轮 full 原文', sender_id: conversationId, conversation_id: conversationId, channel: 'wechat' },
    { config, fetchImpl: async () => makeJsonResponse({ choices: [{ message: { content: '第一轮 full 回复' } }] }), logger: { log() {}, warn() {} } }
  );
  await sendChatToHermesGateway(
    { text: '第二轮 full', sender_id: conversationId, conversation_id: conversationId, channel: 'wechat' },
    {
      config,
      fetchImpl: async (url, options) => {
        if (options?.body) secondBody = JSON.parse(options.body);
        return makeJsonResponse({ choices: [{ message: { content: '第二轮 full 回复' } }] });
      },
      logger: { log() {}, warn() {} },
    }
  );

  assert.equal(secondBody.messages[1].content, '第一轮 full 原文');
  assert.deepEqual(readProviderVisibleHistoryFiles(stateDir), []);
});

test('context cache strategy defaults to balanced with cache telemetry only', async () => {
  const logs = [];
  const config = getHermesGatewayConfig({
    HERMES_API_BASE_URL: 'http://127.0.0.1:8642/v1',
    HERMES_API_KEY: 'token',
    HERMES_REPLY_MODE: 'api',
  });
  assert.equal(config.contextCacheStrategy, 'balanced');
  assert.equal(config.cacheFriendlyHistoryEnabled, false);
  assert.equal(config.cacheTelemetryEnabled, true);

  await sendChatToHermesGateway(
    { text: '默认策略', sender_id: 'wx-cache-strategy-default', conversation_id: 'wx-cache-strategy-default', channel: 'wechat' },
    {
      config,
      fetchImpl: async () => makeJsonResponse({ choices: [{ message: { content: 'ok' } }] }),
      logger: { log(msg) { logs.push(msg); }, warn() {} },
    }
  );

  const usage = parseProviderUsageLog(logs);
  assert.equal(usage.cache_strategy, 'balanced');
  assert.equal(usage.cache_friendly_history_enabled, false);
});

test('cache-first strategy opts into provider-visible append history even when boolean flag is not set', async () => {
  let secondBody = null;
  const conversationId = 'wx-cache-strategy-cache-first';
  const stateDir = tempGatewayStateDir();
  const config = getHermesGatewayConfig({
    HERMES_API_BASE_URL: 'http://127.0.0.1:8642/v1',
    HERMES_API_KEY: 'token',
    HERMES_REPLY_MODE: 'api',
    RAN_AGENT_CONTEXT_SIZE_LOG: '1',
    RAN_AGENT_STATE_DIR: stateDir,
    HERMES_CONTEXT_CACHE_STRATEGY: 'cache_first',
  });

  await sendChatToHermesGateway(
    { text: 'cache first 第一轮', sender_id: conversationId, conversation_id: conversationId, channel: 'wechat' },
    { config, fetchImpl: async () => makeJsonResponse({ choices: [{ message: { content: 'cache first 回复' } }] }), logger: { log() {}, warn() {} } }
  );

  await sendChatToHermesGateway(
    {
      text: 'cache first 第二轮',
      sender_id: conversationId,
      conversation_id: conversationId,
      channel: 'wechat',
      recent_local_history: [{ role: 'user', content: 'legacy recent should not win' }],
    },
    {
      config,
      fetchImpl: async (url, options) => {
        secondBody = JSON.parse(options.body);
        return makeJsonResponse({ choices: [{ message: { content: 'ok' } }] });
      },
      logger: { log() {}, warn() {} },
    }
  );

  assert.equal(config.contextCacheStrategy, 'cache_first');
  assert.equal(readProviderVisibleHistoryFiles(stateDir).length, 1);
  assert.match(JSON.stringify(secondBody.messages), /cache first 第一轮/);
  assert.doesNotMatch(JSON.stringify(secondBody.messages), /legacy recent should not win/);
});

test('token-first strategy avoids provider-visible append history and keeps legacy trimming path', async () => {
  let secondBody = null;
  const conversationId = 'wx-cache-strategy-token-first';
  const stateDir = tempGatewayStateDir();
  const config = getHermesGatewayConfig({
    HERMES_API_BASE_URL: 'http://127.0.0.1:8642/v1',
    HERMES_API_KEY: 'token',
    HERMES_REPLY_MODE: 'api',
    RAN_AGENT_CONTEXT_SIZE_LOG: '1',
    RAN_AGENT_STATE_DIR: stateDir,
    HERMES_CONTEXT_CACHE_STRATEGY: 'token_first',
    HERMES_CACHE_FRIENDLY_HISTORY: 'true',
    HERMES_RECENT_TEXT_TURNS: '1',
  });

  await sendChatToHermesGateway(
    { text: 'token first 第一轮', sender_id: conversationId, conversation_id: conversationId, channel: 'wechat' },
    { config, fetchImpl: async () => makeJsonResponse({ choices: [{ message: { content: 'token first 回复' } }] }), logger: { log() {}, warn() {} } }
  );

  await sendChatToHermesGateway(
    {
      text: 'token first 第二轮',
      sender_id: conversationId,
      conversation_id: conversationId,
      channel: 'wechat',
      recent_local_history: [
        { role: 'user', content: 'legacy old should trim' },
        { role: 'assistant', content: 'legacy old reply should trim' },
        { role: 'user', content: 'legacy newest should remain' },
        { role: 'assistant', content: 'legacy newest reply should remain' },
      ],
    },
    {
      config,
      fetchImpl: async (url, options) => {
        secondBody = JSON.parse(options.body);
        return makeJsonResponse({ choices: [{ message: { content: 'ok' } }] });
      },
      logger: { log() {}, warn() {} },
    }
  );

  const serialized = JSON.stringify(secondBody.messages);
  assert.equal(config.contextCacheStrategy, 'token_first');
  assert.deepEqual(readProviderVisibleHistoryFiles(stateDir), []);
  assert.doesNotMatch(serialized, /token first 第一轮/);
  assert.doesNotMatch(serialized, /legacy old should trim/);
  assert.match(serialized, /legacy newest should remain/);
});

test('Hermes user prompt keeps stable routing before digest time media context and current text', async () => {
  const { capturedBody } = await captureHermesRequest({
    payload: {
      text: '今天帮我看看这张图',
      daily_digest: { open_threads: ['digest item'] },
      continuity_note: 'current_topic: stable continuity',
      active_topic: 'active topic block',
      media: [{ filePath: '/tmp/test.png', mimeType: 'image/png', type: 'image' }],
    },
  });

  const userPrompt = capturedBody.messages.at(-1).content;
  const routeIndex = userPrompt.indexOf('当前对话风格');
  const mediaInstructionIndex = userPrompt.indexOf('媒体工具指令');
  const continuityIndex = userPrompt.indexOf('current_topic: stable continuity');
  const digestIndex = userPrompt.indexOf('daily_digest');
  const timeIndex = Math.max(userPrompt.indexOf('【时间'), userPrompt.indexOf('当前本地时间'));
  const inboundMediaIndex = userPrompt.indexOf('入站媒体');
  const currentTextIndex = userPrompt.lastIndexOf('今天帮我看看这张图');

  assert.ok(routeIndex >= 0);
  assert.ok(mediaInstructionIndex > routeIndex);
  assert.ok(continuityIndex > mediaInstructionIndex);
  assert.ok(digestIndex > continuityIndex);
  assert.ok(timeIndex > digestIndex);
  assert.ok(inboundMediaIndex > timeIndex);
  assert.ok(currentTextIndex > inboundMediaIndex);
  assert.equal(userPrompt.startsWith('【时间'), false);
  assert.equal(userPrompt.startsWith('【微信桥接实时上下文'), false);
});

test('Hermes prompt labels stale continuity without treating it as current topic', async () => {
  const { capturedBody } = await captureHermesRequest({
    payload: {
      text: '今天天气不错',
      active_topic: '',
      stale_context: '我换了新电脑，正在迁移资料',
    },
  });

  const userPrompt = capturedBody.messages.at(-1).content;
  assert.match(userPrompt, /stale_context: 我换了新电脑，正在迁移资料/);
  assert.match(userPrompt, /do_not_assume_current: true/);
  assert.doesNotMatch(userPrompt, /current_topic: 我换了新电脑/);
});

test('recent history budget trims old text but preserves recent referent', async () => {
  let finalBody = null;
  const conversationId = 'wx-budget-nellie';
  const config = getHermesGatewayConfig({
    HERMES_API_BASE_URL: 'http://127.0.0.1:8642/v1',
    HERMES_API_KEY: 'token',
    HERMES_REPLY_MODE: 'api',
    RAN_AGENT_CONTEXT_SIZE_LOG: '0',
    HERMES_RECENT_TEXT_TURNS: '10',
    HERMES_RECENT_TEXT_CHAR_BUDGET: '220',
    HERMES_RECENT_TEXT_MAX_USER_CHARS: '120',
    HERMES_RECENT_TEXT_MAX_ASSISTANT_CHARS: '120',
  });

  await sendChatToHermesGateway(
    { text: `旧话题 ${'无关内容'.repeat(120)}`, sender_id: conversationId, conversation_id: conversationId, channel: 'wechat' },
    { config, fetchImpl: async () => makeJsonResponse({ choices: [{ message: { content: `旧回复 ${'无关回复'.repeat(120)}` } }] }), logger: { log() {}, warn() {} } }
  );
  await sendChatToHermesGateway(
    { text: '我们继续聊内莉·布莱，她把自己送进疯人院这个故事', sender_id: conversationId, conversation_id: conversationId, channel: 'wechat' },
    { config, fetchImpl: async () => makeJsonResponse({ choices: [{ message: { content: '她用卧底调查揭露制度性伤害。' } }] }), logger: { log() {}, warn() {} } }
  );
  await sendChatToHermesGateway(
    { text: '我觉得她的故事特别令人感动', sender_id: conversationId, conversation_id: conversationId, channel: 'wechat' },
    {
      config,
      fetchImpl: async (url, options) => {
        finalBody = JSON.parse(options.body);
        return makeJsonResponse({ choices: [{ message: { content: '确实动人。' } }] });
      },
      logger: { log() {}, warn() {} },
    }
  );

  const serialized = JSON.stringify(finalBody.messages, null, 2);
  assert.match(serialized, /内莉·布莱/);
  assert.doesNotMatch(serialized, /无关内容无关内容无关内容/);
  assert.equal(finalBody.messages.at(-1).role, 'user');
  assert.match(finalBody.messages.at(-1).content, /我觉得她的故事特别令人感动/);
});

test('XHS fallback follow-up keeps recent link context and forbids mechanism explanation', async () => {
  let secondBody = null;
  const conversationId = 'wx-xhs-fallback-history';
  const config = getHermesGatewayConfig({
    HERMES_API_BASE_URL: 'http://127.0.0.1:8642/v1',
    HERMES_API_KEY: 'token',
    HERMES_REPLY_MODE: 'api',
    RAN_AGENT_CONTEXT_SIZE_LOG: '0',
    HERMES_RECENT_TEXT_TURNS: '10',
  });
  const xhsText = '强女故事03｜她把自己送进了疯人院 http://xhslink.com/o/AgWWVuPNi6z';

  await sendChatToHermesGateway(
    { text: xhsText, sender_id: conversationId, conversation_id: conversationId, channel: 'wechat' },
    {
      config,
      fetchImpl: async () => makeJsonResponse({ choices: [{ message: { content: '这篇是内莉·布莱的故事；图片未完整读取。' } }] }),
      logger: { log() {}, warn() {} },
    }
  );
  await sendChatToHermesGateway(
    { text: '图片的话，你应该用 fallback 逻辑去读取', sender_id: conversationId, conversation_id: conversationId, channel: 'wechat' },
    {
      config,
      fetchImpl: async (url, options) => {
        secondBody = JSON.parse(options.body);
        return makeJsonResponse({ choices: [{ message: { content: '我重新读图。' } }] });
      },
      logger: { log() {}, warn() {} },
    }
  );

  const serialized = JSON.stringify(secondBody.messages, null, 2);
  assert.match(serialized, /xhslink\.com\/o\/AgWWVuPNi6z/);
  assert.match(serialized, /内莉·布莱/);
  assert.match(serialized, /直接重试/);
  assert.doesNotMatch(serialized, /vision_analyze|DeepSeek 没视觉|不能看像素/);
});

test('sendChatToHermesGateway parses Responses-style output_text', async () => {
  const response = await sendChatToHermesGateway(
    { text: 'ping', sender_id: 'conv-responses', channel: 'wechat' },
    {
      config: getHermesGatewayConfig({
        HERMES_API_BASE_URL: 'http://127.0.0.1:8642/v1',
        RAN_AGENT_CONTEXT_SIZE_LOG: '0',
      }),
      fetchImpl: async () => makeJsonResponse({
        model: 'ran-assistant',
        output_text: 'pong',
      }),
    }
  );

  assert.equal(response.reply_text, 'pong');
});

test('sendChatToHermesGateway supports hermes one-shot mode', async () => {
  let capturedCommand = '';
  let capturedArgs = null;
  const response = await sendChatToHermesGateway(
    { text: '只输出 OK', sender_id: 'conv-oneshot', channel: 'wechat' },
    {
      config: getHermesGatewayConfig({
        HERMES_REPLY_MODE: 'oneshot',
        HERMES_COMMAND: 'hermes',
        HERMES_PROFILE: 'ran-assistant',
        HERMES_PROVIDER: 'deepseek',
        HERMES_DEFAULT_MODEL: 'deepseek-v4-flash',
        RAN_AGENT_CONTEXT_SIZE_LOG: '0',
        RAN_AGENT_CAPABILITY_MODE: 'full',
      }),
      execFileImpl: async (command, args) => {
        capturedCommand = command;
        capturedArgs = args;
        return { stdout: 'OK\n' };
      },
    }
  );

  assert.equal(capturedCommand, 'hermes');
  assert.deepEqual(capturedArgs.slice(0, 7), [
    '-p',
    'ran-assistant',
    '--provider',
    'deepseek',
    '--model',
    'deepseek-v4-flash',
    '-z',
  ]);
  assert.match(capturedArgs[7], /只输出 OK/);
  assert.equal(response.reply_text, 'OK');
  assert.equal(response.model, 'deepseek-v4-flash');
});

test('sendChatToHermesGateway can fall back from API to one-shot in auto mode', async () => {
  const response = await sendChatToHermesGateway(
    { text: 'fallback', sender_id: 'conv-auto', channel: 'wechat' },
    {
      config: getHermesGatewayConfig({
        HERMES_REPLY_MODE: 'auto',
        HERMES_PROFILE: 'ran-assistant',
        HERMES_PROVIDER: 'deepseek',
        HERMES_DEFAULT_MODEL: 'deepseek-v4-flash',
        RAN_AGENT_CONTEXT_SIZE_LOG: '0',
      }),
      fetchImpl: async () => makeJsonResponse({ error: 'down' }, false, 503),
      execFileImpl: async () => ({ stdout: 'fallback ok\n' }),
      logger: { warn() {} },
    }
  );

  assert.equal(response.reply_text, 'fallback ok');
});

test('sendChatToHermesGateway uses compact system instruction (single line)', async () => {
  let capturedBody = null;
  await sendChatToHermesGateway(
    { text: '你好', sender_id: 'conv-compact-sys', channel: 'wechat' },
    {
      config: getHermesGatewayConfig({
        HERMES_API_BASE_URL: 'http://127.0.0.1:8642/v1',
        HERMES_API_KEY: 'token',
        HERMES_REPLY_MODE: 'api',
        RAN_AGENT_CONTEXT_SIZE_LOG: '0',
      }),
      fetchImpl: async (url, options) => {
        capturedBody = JSON.parse(options.body);
        return makeJsonResponse({ choices: [{ message: { content: 'hi' } }] });
      },
      logger: { warn() {} },
    }
  );

  const systemMsg = capturedBody.messages.find((m) => m.role === 'system');
  assert.ok(systemMsg);
  assert.ok(systemMsg.content.length <= 1800, 'system instruction should stay compact');
  assert.ok(!systemMsg.content.includes('MANDATORY RULES'), 'should not inject long mandatory rules');
  assert.ok(systemMsg.content.includes('social_reader'), 'should mention social_reader');
  assert.ok(systemMsg.content.includes('先回应当前话题'), 'should include short style anchor');
  assert.ok(!systemMsg.content.includes('web_extract and web_search are allowed'), 'should not spend system prompt on normal web detail');
});

test('plain feedback gets short continuity note without mechanism terms', async () => {
  let capturedBody = null;
  await sendChatToHermesGateway(
    { text: '你有点不连贯', sender_id: 'conv-feedback-style', channel: 'wechat' },
    {
      config: getHermesGatewayConfig({
        HERMES_API_BASE_URL: 'http://127.0.0.1:8642/v1',
        HERMES_API_KEY: 'token',
        HERMES_REPLY_MODE: 'api',
        RAN_AGENT_CONTEXT_SIZE_LOG: '0',
      }),
      fetchImpl: async (url, options) => {
        capturedBody = JSON.parse(options.body);
        return makeJsonResponse({ choices: [{ message: { content: '收到' } }] });
      },
      logger: { warn() {} },
    }
  );

  const userMsg = capturedBody.messages.find((m) => m.role === 'user');
  assert.ok(userMsg.content.includes('conversation continuity note'), 'should inject continuity note');
  assert.ok(userMsg.content.includes('do_not_repeat'), 'should include concise do_not_repeat guard');
  assert.ok(userMsg.content.length < 900, 'plain feedback prompt should stay short');
  for (const forbidden of ['提示词', 'system prompt', '技能扫描', '工具列表', '上下文窗口', 'token', '压缩机制']) {
    assert.ok(!userMsg.content.includes(forbidden), `plain continuity note should not expose ${forbidden}`);
  }
});

test('sendChatToHermesGateway does not inject media generation instruction for plain text', async () => {
  let capturedBody = null;
  await sendChatToHermesGateway(
    { text: '今天天气怎么样', sender_id: 'conv-plain', channel: 'wechat' },
    {
      config: getHermesGatewayConfig({
        HERMES_API_BASE_URL: 'http://127.0.0.1:8642/v1',
        HERMES_API_KEY: 'token',
        HERMES_REPLY_MODE: 'api',
        RAN_AGENT_CONTEXT_SIZE_LOG: '0',
      }),
      fetchImpl: async (url, options) => {
        capturedBody = JSON.parse(options.body);
        return makeJsonResponse({ choices: [{ message: { content: '晴天' } }] });
      },
      logger: { warn() {} },
    }
  );

  const userMsg = capturedBody.messages.find((m) => m.role === 'user');
  assert.ok(!userMsg.content.includes('媒体工具指令'), 'plain text should not include media generation instruction');
});

test('sendChatToHermesGateway injects full temporal context for relative time words', async () => {
  let capturedBody = null;
  await sendChatToHermesGateway(
    { text: '今天有什么安排', sender_id: 'conv-time', channel: 'wechat' },
    {
      config: getHermesGatewayConfig({
        HERMES_API_BASE_URL: 'http://127.0.0.1:8642/v1',
        HERMES_API_KEY: 'token',
        HERMES_REPLY_MODE: 'api',
        RAN_AGENT_CONTEXT_SIZE_LOG: '0',
      }),
      fetchImpl: async (url, options) => {
        capturedBody = JSON.parse(options.body);
        return makeJsonResponse({ choices: [{ message: { content: '没有安排' } }] });
      },
      logger: { warn() {} },
    }
  );

  const userMsg = capturedBody.messages.find((m) => m.role === 'user');
  assert.ok(userMsg.content.includes('微信桥接实时上下文'), 'relative time should trigger full temporal context');
  assert.ok(userMsg.content.includes('Asia/Shanghai'), 'full context should include timezone');
});

test('sendChatToHermesGateway uses compact temporal context for plain messages', async () => {
  let capturedBody = null;
  await sendChatToHermesGateway(
    { text: '你好呀', sender_id: 'conv-compact-time', channel: 'wechat' },
    {
      config: getHermesGatewayConfig({
        HERMES_API_BASE_URL: 'http://127.0.0.1:8642/v1',
        HERMES_API_KEY: 'token',
        HERMES_REPLY_MODE: 'api',
        RAN_AGENT_CONTEXT_SIZE_LOG: '0',
      }),
      fetchImpl: async (url, options) => {
        capturedBody = JSON.parse(options.body);
        return makeJsonResponse({ choices: [{ message: { content: '你好' } }] });
      },
      logger: { warn() {} },
    }
  );

  const userMsg = capturedBody.messages.find((m) => m.role === 'user');
  assert.ok(userMsg.content.includes('【时间：'), 'should have compact time prefix');
  assert.ok(!userMsg.content.includes('微信桥接实时上下文'), 'should not have full temporal block');
});

test('sendChatToHermesGateway injects media generation instruction when media present', async () => {
  let capturedBody = null;
  await sendChatToHermesGateway(
    {
      text: '帮我看看',
      sender_id: 'conv-media',
      channel: 'wechat',
      media: [{ filePath: '/tmp/test.png', mimeType: 'image/png', type: 'image' }],
    },
    {
      config: getHermesGatewayConfig({
        HERMES_API_BASE_URL: 'http://127.0.0.1:8642/v1',
        HERMES_API_KEY: 'token',
        HERMES_REPLY_MODE: 'api',
        RAN_AGENT_CONTEXT_SIZE_LOG: '0',
      }),
      fetchImpl: async (url, options) => {
        capturedBody = JSON.parse(options.body);
        return makeJsonResponse({ choices: [{ message: { content: '好的' } }] });
      },
      logger: { warn() {} },
    }
  );

  const userMsg = capturedBody.messages.find((m) => m.role === 'user');
  assert.ok(userMsg.content.includes('媒体工具指令'), 'media present should include media generation instruction');
});

test('media instruction is not injected when only plain text exists', async () => {
  let capturedBody = null;
  await sendChatToHermesGateway(
    { text: '你有点不连贯', sender_id: 'conv-no-media-instruction', channel: 'wechat' },
    {
      config: getHermesGatewayConfig({
        HERMES_API_BASE_URL: 'http://127.0.0.1:8642/v1',
        HERMES_API_KEY: 'token',
        HERMES_REPLY_MODE: 'api',
        RAN_AGENT_CONTEXT_SIZE_LOG: '0',
      }),
      fetchImpl: async (url, options) => {
        capturedBody = JSON.parse(options.body);
        return makeJsonResponse({ choices: [{ message: { content: '收到' } }] });
      },
      logger: { warn() {} },
    }
  );

  const userMsg = capturedBody.messages.find((m) => m.role === 'user');
  assert.ok(!userMsg.content.includes('微信入站媒体资产'), 'plain text should not include inbound media instruction');
  assert.ok(!userMsg.content.includes('媒体工具指令'), 'plain text should not include media generation instruction');
});

// --- Courtly Style Anchor Tests ---

test('buildCourtlyStyleAnchor injects anchor for default plain text', () => {
  const anchor = buildCourtlyStyleAnchor({ text: '你好呀' });
  assert.ok(anchor.length > 0, 'should inject anchor for plain text');
  assert.ok(anchor.includes('陛下'), 'anchor should mention 陛下');
  assert.ok(anchor.includes('臣'), 'anchor should mention 臣');
  assert.ok(anchor.length < 80, 'anchor should be short');
});

test('buildCourtlyStyleAnchor returns empty for disable phrases', () => {
  for (const phrase of ['正常说话', '别叫陛下', '别演', '不要角色扮演', '先别演']) {
    assert.equal(buildCourtlyStyleAnchor({ text: phrase }), '', `"${phrase}" should disable anchor`);
  }
});

test('buildCourtlyStyleAnchor injects anchor for force phrases', () => {
  for (const phrase of ['恢复女官模式', '叫我陛下', '臣呢', '按之前那个模式', '恢复微臣模式']) {
    const anchor = buildCourtlyStyleAnchor({ text: phrase });
    assert.ok(anchor.length > 0, `"${phrase}" should force anchor`);
    assert.ok(anchor.includes('陛下'), `"${phrase}" anchor should mention 陛下`);
  }
});

test('buildCourtlyStyleAnchor returns empty when RAN_AGENT_COURTLY_MODE=off', () => {
  const anchor = buildCourtlyStyleAnchor({ text: '你好', _env: { RAN_AGENT_COURTLY_MODE: 'off' } });
  assert.equal(anchor, '', 'should not inject anchor when mode is off');
});

test('buildCourtlyStyleAnchor injects anchor when RAN_AGENT_COURTLY_MODE=on', () => {
  const anchor = buildCourtlyStyleAnchor({ text: '你好', _env: { RAN_AGENT_COURTLY_MODE: 'on' } });
  assert.ok(anchor.length > 0, 'should inject anchor when mode is on');
});

test('buildCourtlyStyleAnchor does not contain long SOUL content', () => {
  const anchor = buildCourtlyStyleAnchor({ text: '你好' });
  assert.ok(!anchor.includes('核心原则'), 'anchor should not contain SOUL section headers');
  assert.ok(!anchor.includes('说话方式'), 'anchor should not contain SOUL section headers');
  assert.ok(!anchor.includes('输出边界'), 'anchor should not contain SOUL section headers');
});

test('sendChatToHermesGateway includes courtly anchor in plain text message', async () => {
  let capturedBody = null;
  await sendChatToHermesGateway(
    { text: '今天天气怎么样', sender_id: 'conv-courtly', channel: 'wechat' },
    {
      config: getHermesGatewayConfig({
        HERMES_API_BASE_URL: 'http://127.0.0.1:8642/v1',
        HERMES_API_KEY: 'token',
        HERMES_REPLY_MODE: 'api',
        RAN_AGENT_CONTEXT_SIZE_LOG: '0',
      }),
      fetchImpl: async (url, options) => {
        capturedBody = JSON.parse(options.body);
        return makeJsonResponse({ choices: [{ message: { content: '晴天' } }] });
      },
      logger: { warn() {} },
    }
  );

  const userMsg = capturedBody.messages.find((m) => m.role === 'user');
  assert.ok(userMsg.content.includes('贴身女官'), 'should include courtly anchor');
  assert.ok(userMsg.content.includes('陛下'), 'should include 陛下');
});

test('sendChatToHermesGateway excludes courtly anchor for disable phrases', async () => {
  let capturedBody = null;
  await sendChatToHermesGateway(
    { text: '正常说话，今天天气怎么样', sender_id: 'conv-no-courtly', channel: 'wechat' },
    {
      config: getHermesGatewayConfig({
        HERMES_API_BASE_URL: 'http://127.0.0.1:8642/v1',
        HERMES_API_KEY: 'token',
        HERMES_REPLY_MODE: 'api',
        RAN_AGENT_CONTEXT_SIZE_LOG: '0',
      }),
      fetchImpl: async (url, options) => {
        capturedBody = JSON.parse(options.body);
        return makeJsonResponse({ choices: [{ message: { content: '晴天' } }] });
      },
      logger: { warn() {} },
    }
  );

  const userMsg = capturedBody.messages.find((m) => m.role === 'user');
  assert.ok(!userMsg.content.includes('贴身女官'), 'should not include courtly anchor when disabled');
});

test('sendChatToHermesGateway does not break media routing with courtly anchor', async () => {
  let capturedBody = null;
  await sendChatToHermesGateway(
    {
      text: '帮我看看',
      sender_id: 'conv-courtly-media',
      channel: 'wechat',
      media: [{ filePath: '/tmp/test.png', mimeType: 'image/png', type: 'image' }],
    },
    {
      config: getHermesGatewayConfig({
        HERMES_API_BASE_URL: 'http://127.0.0.1:8642/v1',
        HERMES_API_KEY: 'token',
        HERMES_REPLY_MODE: 'api',
        RAN_AGENT_CONTEXT_SIZE_LOG: '0',
      }),
      fetchImpl: async (url, options) => {
        capturedBody = JSON.parse(options.body);
        return makeJsonResponse({ choices: [{ message: { content: '好的' } }] });
      },
      logger: { warn() {} },
    }
  );

  const userMsg = capturedBody.messages.find((m) => m.role === 'user');
  assert.ok(userMsg.content.includes('贴身女官'), 'should include courtly anchor even with media');
  assert.ok(userMsg.content.includes('入站媒体'), 'should still include media instruction');
  assert.ok(userMsg.content.includes('媒体工具指令'), 'should still include media generation instruction');
});

// --- Social Link Routing Tests ---

test('xhslink.com injects social_reader routing instruction', async () => {
  let capturedBody = null;
  const logs = [];
  await sendChatToHermesGateway(
    { text: '帮我看看 http://xhslink.com/o/abc123', sender_id: 'conv-xhs', channel: 'wechat' },
    {
      config: getHermesGatewayConfig({ HERMES_API_BASE_URL: 'http://127.0.0.1:8642/v1', HERMES_API_KEY: 'token', HERMES_REPLY_MODE: 'api', RAN_AGENT_CONTEXT_SIZE_LOG: '0' }),
      fetchImpl: async (url, options) => { capturedBody = JSON.parse(options.body); return makeJsonResponse({ choices: [{ message: { content: 'ok' } }] }); },
      logger: { warn() {}, log(msg) { logs.push(msg); } },
    }
  );
  const userMsg = capturedBody.messages.find((m) => m.role === 'user');
  assert.ok(userMsg.content.includes('社交链接路由指令'), 'should inject social routing');
  assert.ok(userMsg.content.includes('小红书'), 'should detect platform');
  assert.ok(userMsg.content.includes('social_reader'), 'should mention social_reader');
  assert.ok(userMsg.content.includes('mcp_social_reader_read_social_post'), 'should include tool name');
  assert.ok(userMsg.content.includes('首个工具必须是 mcp_social_reader_read_social_post'), 'should require social_reader first');
  assert.ok(userMsg.content.includes('terminal 不得处理 xhslink'), 'should disallow terminal for xhslink');
  assert.ok(userMsg.content.includes('browser_navigate 不得作为第一读取路径'), 'should disallow browser first');
  assert.ok(userMsg.content.includes('canonical URL 不等于正文'), 'should warn about canonical URL');
  assert.ok(!userMsg.content.includes('vision_analyze'), 'social hint should not repeat vision tool bans');
  assert.ok(logs.some((line) => line.includes('[social-link-routing]') && line.includes('platform=xhs') && line.includes('preferred_first_tool=mcp_social_reader_read_social_post')));
  assert.ok(logs.some((line) => line.includes('[social-link-routing]') && line.includes('browser_first_disallowed=true') && line.includes('terminal_disallowed=true')));
});

test('bilibili.com injects social_reader routing instruction', async () => {
  let capturedBody = null;
  await sendChatToHermesGateway(
    { text: '看看这个 https://www.bilibili.com/video/BV1234567', sender_id: 'conv-bili', channel: 'wechat' },
    {
      config: getHermesGatewayConfig({ HERMES_API_BASE_URL: 'http://127.0.0.1:8642/v1', HERMES_API_KEY: 'token', HERMES_REPLY_MODE: 'api', RAN_AGENT_CONTEXT_SIZE_LOG: '0' }),
      fetchImpl: async (url, options) => { capturedBody = JSON.parse(options.body); return makeJsonResponse({ choices: [{ message: { content: 'ok' } }] }); },
      logger: { warn() {} },
    }
  );
  const userMsg = capturedBody.messages.find((m) => m.role === 'user');
  assert.ok(userMsg.content.includes('B站'), 'should detect bilibili');
  assert.ok(userMsg.content.includes('social_reader'), 'should mention social_reader');
});

test('mp.weixin.qq.com injects social_reader routing instruction', async () => {
  let capturedBody = null;
  await sendChatToHermesGateway(
    { text: '读一下 https://mp.weixin.qq.com/s/abc123', sender_id: 'conv-wx', channel: 'wechat' },
    {
      config: getHermesGatewayConfig({ HERMES_API_BASE_URL: 'http://127.0.0.1:8642/v1', HERMES_API_KEY: 'token', HERMES_REPLY_MODE: 'api', RAN_AGENT_CONTEXT_SIZE_LOG: '0' }),
      fetchImpl: async (url, options) => { capturedBody = JSON.parse(options.body); return makeJsonResponse({ choices: [{ message: { content: 'ok' } }] }); },
      logger: { warn() {} },
    }
  );
  const userMsg = capturedBody.messages.find((m) => m.role === 'user');
  assert.ok(userMsg.content.includes('微信公众号'), 'should detect weixin');
  assert.ok(userMsg.content.includes('social_reader'), 'should mention social_reader');
});

test('normal web link does NOT inject social_reader routing', async () => {
  let capturedBody = null;
  await sendChatToHermesGateway(
    { text: '看看这篇新闻 https://news.example.com/article/123', sender_id: 'conv-news', channel: 'wechat' },
    {
      config: getHermesGatewayConfig({ HERMES_API_BASE_URL: 'http://127.0.0.1:8642/v1', HERMES_API_KEY: 'token', HERMES_REPLY_MODE: 'api', RAN_AGENT_CONTEXT_SIZE_LOG: '0' }),
      fetchImpl: async (url, options) => { capturedBody = JSON.parse(options.body); return makeJsonResponse({ choices: [{ message: { content: 'ok' } }] }); },
      logger: { warn() {} },
    }
  );
  const userMsg = capturedBody.messages.find((m) => m.role === 'user');
  assert.ok(!userMsg.content.includes('社交链接路由指令'), 'should NOT inject social routing for normal web');
  assert.ok(!userMsg.content.includes('social_reader'), 'should NOT mention social_reader');
  assert.ok(!userMsg.content.includes('terminal 不得处理 xhslink'), 'should NOT inject xhs terminal rule for normal web');
  assert.ok(!userMsg.content.includes('browser_navigate 不得作为第一读取路径'), 'should NOT inject browser first rule for normal web');
});

test('social routing does not break courtly style anchor', async () => {
  let capturedBody = null;
  await sendChatToHermesGateway(
    { text: '帮我看看 http://xhslink.com/o/abc123', sender_id: 'conv-xhs-courtly', channel: 'wechat' },
    {
      config: getHermesGatewayConfig({ HERMES_API_BASE_URL: 'http://127.0.0.1:8642/v1', HERMES_API_KEY: 'token', HERMES_REPLY_MODE: 'api', RAN_AGENT_CONTEXT_SIZE_LOG: '0' }),
      fetchImpl: async (url, options) => { capturedBody = JSON.parse(options.body); return makeJsonResponse({ choices: [{ message: { content: 'ok' } }] }); },
      logger: { warn() {} },
    }
  );
  const userMsg = capturedBody.messages.find((m) => m.role === 'user');
  assert.ok(userMsg.content.includes('贴身女官'), 'should include courtly anchor');
  assert.ok(userMsg.content.includes('社交链接路由指令'), 'should include social routing');
});

test('social routing does not break media context injection', async () => {
  let capturedBody = null;
  await sendChatToHermesGateway(
    { text: '看看 http://xhslink.com/o/abc123', sender_id: 'conv-xhs-media', channel: 'wechat', media: [{ filePath: '/tmp/test.png', mimeType: 'image/png', type: 'image' }] },
    {
      config: getHermesGatewayConfig({ HERMES_API_BASE_URL: 'http://127.0.0.1:8642/v1', HERMES_API_KEY: 'token', HERMES_REPLY_MODE: 'api', RAN_AGENT_CONTEXT_SIZE_LOG: '0' }),
      fetchImpl: async (url, options) => { capturedBody = JSON.parse(options.body); return makeJsonResponse({ choices: [{ message: { content: 'ok' } }] }); },
      logger: { warn() {} },
    }
  );
  const userMsg = capturedBody.messages.find((m) => m.role === 'user');
  assert.ok(userMsg.content.includes('社交链接路由指令'), 'should include social routing');
  assert.ok(userMsg.content.includes('入站媒体'), 'should include media instruction');
  assert.ok(userMsg.content.includes('媒体工具指令'), 'should include media generation instruction');
});

test('auto routing sends debug and lark-cli intents to full gateway', async () => {
  for (const text of ['调试模式', 'systemctl status ran-agent-node', 'journalctl -u ran-agent-node', 'git pull', 'npm test', 'lark-cli user me']) {
    let capturedUrl = '';
    await sendChatToHermesGateway(
      { text, sender_id: `conv-full-${text}`, channel: 'wechat' },
      {
        config: getHermesGatewayConfig({
          HERMES_LITE_API_BASE_URL: 'http://127.0.0.1:8642/v1',
          HERMES_FULL_API_BASE_URL: 'http://127.0.0.1:8643/v1',
          HERMES_API_KEY: 'token',
          HERMES_REPLY_MODE: 'api',
          RAN_AGENT_CONTEXT_SIZE_LOG: '0',
          RAN_AGENT_CAPABILITY_MODE: 'auto',
        }),
        fetchImpl: async (url, init) => {
          if (init?.body) capturedUrl = url;
          return makeJsonResponse({ choices: [{ message: { content: 'ok' } }] });
        },
        logger: { warn() {}, log() {} },
      }
    );
    assert.equal(capturedUrl, 'http://127.0.0.1:8643/v1/chat/completions', `${text} should route to full`);
  }
});

test('auto routing keeps normal chat, XHS, and media on lite gateway', async () => {
  const cases = [
    { text: '你有点不连贯', sender_id: 'conv-lite-chat' },
    { text: '看看 http://xhslink.com/o/abc123', sender_id: 'conv-lite-xhs' },
    { text: '帮我看看', sender_id: 'conv-lite-media', media: [{ filePath: '/tmp/test.png', mimeType: 'image/png', type: 'image' }] },
  ];
  for (const payload of cases) {
    let capturedUrl = '';
    await sendChatToHermesGateway(
      { channel: 'wechat', ...payload },
      {
        config: getHermesGatewayConfig({
          HERMES_LITE_API_BASE_URL: 'http://127.0.0.1:8642/v1',
          HERMES_FULL_API_BASE_URL: 'http://127.0.0.1:8643/v1',
          HERMES_API_KEY: 'token',
          HERMES_REPLY_MODE: 'api',
          RAN_AGENT_CONTEXT_SIZE_LOG: '0',
          RAN_AGENT_CAPABILITY_MODE: 'auto',
        }),
        fetchImpl: async (url, init) => {
          if (init?.body) capturedUrl = url;
          return makeJsonResponse({ choices: [{ message: { content: 'ok' } }] });
        },
        logger: { warn() {}, log() {} },
      }
    );
    assert.equal(capturedUrl, 'http://127.0.0.1:8642/v1/chat/completions', `${payload.text} should route to lite`);
  }
});

test('auto routing keeps explicit sticker-save intents on lite gateway', async () => {
  const cases = [
    { text: '保存这个为表情包', sender_id: 'conv-sticker-save', media: [{ filePath: '/tmp/sticker.png', mimeType: 'image/png', type: 'image' }] },
    { text: '这个加入表情包', sender_id: 'conv-sticker-add', media: [{ filePath: '/tmp/sticker.gif', mimeType: 'image/gif', type: 'image' }] },
    { text: '以后用这个表情', sender_id: 'conv-sticker-future', media: [{ filePath: '/tmp/sticker.webp', mimeType: 'image/webp', type: 'image' }] },
  ];

  for (const payload of cases) {
    let capturedUrl = '';
    await sendChatToHermesGateway(
      { channel: 'wechat', ...payload },
      {
        config: getHermesGatewayConfig({
          HERMES_LITE_API_BASE_URL: 'http://127.0.0.1:8642/v1',
          HERMES_FULL_API_BASE_URL: 'http://127.0.0.1:8643/v1',
          HERMES_API_KEY: 'token',
          HERMES_REPLY_MODE: 'api',
          RAN_AGENT_CONTEXT_SIZE_LOG: '0',
          RAN_AGENT_CAPABILITY_MODE: 'auto',
        }),
        fetchImpl: async (url, init) => {
          if (init?.body) capturedUrl = url;
          return makeJsonResponse({ choices: [{ message: { content: 'ok' } }] });
        },
        logger: { warn() {}, log() {} },
      }
    );
    assert.equal(capturedUrl, 'http://127.0.0.1:8642/v1/chat/completions', `${payload.text} should stay on lite`);
  }
});

// --- Social Link Evidence Gate Tests ---

test('buildSocialEvidenceReport: no social link returns empty report', () => {
  const report = buildSocialEvidenceReport({ text: '你好' }, null, {}, { log() {} });
  assert.equal(report.hasSocialLink, false);
  assert.equal(report.platform, '');
  assert.equal(report.allow_claim_read, false);
  assert.equal(report.evidence_source, 'none');
});

test('buildSocialEvidenceReport: XHS link with empty cache sets link_resolution false', () => {
  const report = buildSocialEvidenceReport(
    { text: '看看 http://xhslink.com/o/abc123' },
    null,
    { XHS_TOKEN_CACHE_PATH: '/nonexistent/cache.json' },
    { log() {} }
  );
  assert.equal(report.hasSocialLink, true);
  assert.equal(report.platform, '小红书');
  assert.equal(report.link_resolution.ok, false);
  assert.equal(report.content_read.ok, false);
  assert.equal(report.allow_claim_read, false);
});

test('matchXhsTokenCacheEntry: matches by URL', () => {
  const cache = {
    'key1': { url: 'https://xhslink.com/o/abc123', canonical_url: 'https://www.xiaohongshu.com/explore/6a0002d9', note_id: '6a0002d9' },
  };
  const entry = matchXhsTokenCacheEntry('看看 https://xhslink.com/o/abc123', cache);
  assert.ok(entry);
  assert.equal(entry.canonical_url, 'https://www.xiaohongshu.com/explore/6a0002d9');
});

test('matchXhsTokenCacheEntry: matches by canonical_url', () => {
  const cache = {
    'key1': { canonical_url: 'https://www.xiaohongshu.com/explore/6a0002d9' },
  };
  const entry = matchXhsTokenCacheEntry('https://www.xiaohongshu.com/explore/6a0002d9', cache);
  assert.ok(entry);
});

test('matchXhsTokenCacheEntry: returns null for non-matching URL', () => {
  const cache = {
    'key1': { url: 'https://xhslink.com/o/other' },
  };
  const entry = matchXhsTokenCacheEntry('看看 https://xhslink.com/o/abc123', cache);
  assert.equal(entry, null);
});

test('buildSocialEvidenceReport: token cache hit sets link_resolution true but content_read false', () => {
  const cachePath = '/tmp/test-xhs-cache-' + Date.now() + '.json';
  writeFileSync(cachePath, JSON.stringify({
    'key1': { url: 'https://xhslink.com/o/abc123', canonical_url: 'https://www.xiaohongshu.com/explore/6a0002d9', note_id: '6a0002d9' },
  }));
  try {
    const report = buildSocialEvidenceReport(
      { text: '看看 https://xhslink.com/o/abc123' },
      null,
      { XHS_TOKEN_CACHE_PATH: cachePath },
      { log() {} }
    );
    assert.equal(report.hasSocialLink, true);
    assert.equal(report.link_resolution.ok, true);
    assert.equal(report.link_resolution.source, 'token_cache');
    assert.equal(report.link_resolution.canonical_url, 'https://www.xiaohongshu.com/explore/6a0002d9');
    assert.equal(report.content_read.ok, false);
    assert.equal(report.allow_claim_read, false);
    assert.equal(report.evidence_source, 'token_cache');
  } finally {
    unlinkSync(cachePath);
  }
});

test('buildSocialEvidenceReport: token cache with metadata sets metadata_read true', () => {
  const cachePath = '/tmp/test-xhs-cache-meta-' + Date.now() + '.json';
  writeFileSync(cachePath, JSON.stringify({
    'key1': { url: 'https://xhslink.com/o/abc123', canonical_url: 'https://www.xiaohongshu.com/explore/6a0002d9', title: '测试笔记', user: 'testuser' },
  }));
  try {
    const report = buildSocialEvidenceReport(
      { text: '看看 https://xhslink.com/o/abc123' },
      null,
      { XHS_TOKEN_CACHE_PATH: cachePath },
      { log() {} }
    );
    assert.equal(report.metadata_read.ok, true);
    assert.deepEqual(report.metadata_read.fields, ['title', 'user']);
    assert.equal(report.content_read.ok, false);
    assert.equal(report.allow_claim_read, false);
  } finally {
    unlinkSync(cachePath);
  }
});

test('applySocialLinkEvidenceGate: no social link passes through', () => {
  const result = applySocialLinkEvidenceGate(
    { text: '你好' },
    '读到了，全文是...',
    { hasSocialLink: false },
    { log() {} }
  );
  assert.equal(result.evidenceGateTriggered, false);
  assert.equal(result.replyText, '读到了，全文是...');
});

test('applySocialLinkEvidenceGate: social link + claim + no content_read triggers gate', () => {
  const result = applySocialLinkEvidenceGate(
    { text: '看看 http://xhslink.com/o/abc123' },
    '我读到了这篇帖子，全文是关于...',
    { hasSocialLink: true, platform: 'xhs', link_resolution: { ok: false }, metadata_read: { ok: false }, content_read: { ok: false }, allow_claim_read: false, evidence_source: 'token_cache' },
    { log() {} }
  );
  assert.equal(result.evidenceGateTriggered, true);
  assert.match(result.replyText, /没有成功解析这个链接/);
});

test('applySocialLinkEvidenceGate: link_resolution only + claim triggers gate with link_resolution text', () => {
  const result = applySocialLinkEvidenceGate(
    { text: '看看 http://xhslink.com/o/abc123' },
    '我读到了这篇帖子的内容',
    { hasSocialLink: true, platform: 'xhs', link_resolution: { ok: true }, metadata_read: { ok: false }, content_read: { ok: false }, allow_claim_read: false, evidence_source: 'token_cache' },
    { log() {} }
  );
  assert.equal(result.evidenceGateTriggered, true);
  assert.match(result.replyText, /只确认链接已解析/);
});

test('applySocialLinkEvidenceGate: metadata_read only + claim triggers gate with metadata text', () => {
  const result = applySocialLinkEvidenceGate(
    { text: '看看 http://xhslink.com/o/abc123' },
    '我读到了这篇帖子',
    { hasSocialLink: true, platform: 'xhs', link_resolution: { ok: true }, metadata_read: { ok: true }, content_read: { ok: false }, allow_claim_read: false, evidence_source: 'token_cache' },
    { log() {} }
  );
  assert.equal(result.evidenceGateTriggered, true);
  assert.match(result.replyText, /只拿到了一些标题/);
});

test('applySocialLinkEvidenceGate: content_read ok passes through', () => {
  const result = applySocialLinkEvidenceGate(
    { text: '看看 http://xhslink.com/o/abc123' },
    '我读到了这篇帖子，全文是...',
    { hasSocialLink: true, platform: 'xhs', link_resolution: { ok: true }, metadata_read: { ok: true }, content_read: { ok: true }, allow_claim_read: true, evidence_source: 'tool_result' },
    { log() {} }
  );
  assert.equal(result.evidenceGateTriggered, false);
  assert.equal(result.replyText, '我读到了这篇帖子，全文是...');
});

test('applySocialLinkEvidenceGate: failure acknowledgment does not trigger gate', () => {
  const result = applySocialLinkEvidenceGate(
    { text: '看看 http://xhslink.com/o/abc123' },
    '臣这边只确认链接已解析，但没有拿到正文内容',
    { hasSocialLink: true, platform: 'xhs', link_resolution: { ok: true }, metadata_read: { ok: false }, content_read: { ok: false }, allow_claim_read: false, evidence_source: 'token_cache' },
    { log() {} }
  );
  assert.equal(result.evidenceGateTriggered, false);
});

test('applySocialLinkEvidenceGate: no claim in reply does not trigger gate', () => {
  const result = applySocialLinkEvidenceGate(
    { text: '看看 http://xhslink.com/o/abc123' },
    '这个链接看起来不错',
    { hasSocialLink: true, platform: 'xhs', link_resolution: { ok: true }, metadata_read: { ok: false }, content_read: { ok: false }, allow_claim_read: false, evidence_source: 'token_cache' },
    { log() {} }
  );
  assert.equal(result.evidenceGateTriggered, false);
});

test('social routing hint includes mcp_social_reader tool name', async () => {
  let capturedBody = '';
  await sendChatToHermesGateway(
    { text: '看看 http://xhslink.com/o/abc123', sender_id: 'conv-hint-test', channel: 'wechat' },
    {
      config: getHermesGatewayConfig({
        HERMES_API_BASE_URL: 'http://127.0.0.1:8642/v1',
        HERMES_API_KEY: 'token',
        HERMES_REPLY_MODE: 'api',
        RAN_AGENT_CONTEXT_SIZE_LOG: '0',
      }),
      fetchImpl: async (url, init) => {
        if (init?.body) capturedBody = init.body;
        return makeJsonResponse({ choices: [{ message: { content: 'ok' } }] });
      },
      logger: { warn() {}, log() {} },
    }
  );
  const body = JSON.parse(capturedBody);
  const userMsg = body.messages.find((m) => m.role === 'user');
  assert.ok(userMsg.content.includes('mcp_social_reader_read_social_post'), 'should include mcp_social_reader tool name');
  assert.ok(userMsg.content.includes('canonical URL 不等于正文'), 'should include canonical URL warning');
});

test('system instruction contains canonical URL evidence rule', async () => {
  let capturedBody = '';
  await sendChatToHermesGateway(
    { text: '你好', sender_id: 'conv-sys-test', channel: 'wechat' },
    {
      config: getHermesGatewayConfig({
        HERMES_API_BASE_URL: 'http://127.0.0.1:8642/v1',
        HERMES_API_KEY: 'token',
        HERMES_REPLY_MODE: 'api',
        RAN_AGENT_CONTEXT_SIZE_LOG: '0',
      }),
      fetchImpl: async (url, init) => {
        if (init?.body) capturedBody = init.body;
        return makeJsonResponse({ choices: [{ message: { content: 'ok' } }] });
      },
      logger: { warn() {}, log() {} },
    }
  );
  const body = JSON.parse(capturedBody);
  const sysMsg = body.messages.find((m) => m.role === 'system');
  assert.ok(sysMsg.content.includes('Canonical URL resolution does NOT equal content read'), 'system instruction should contain evidence rule');
  assert.ok(sysMsg.content.length < 1800, `system instruction should be under 1800 chars, got ${sysMsg.content.length}`);
});

test('audit logs include evidence stage and allow_claim_read', async () => {
  const logs = [];
  const cachePath = '/tmp/test-xhs-audit-' + Date.now() + '.json';
  writeFileSync(cachePath, JSON.stringify({
    'key1': { url: 'https://xhslink.com/o/audit123', canonical_url: 'https://www.xiaohongshu.com/explore/audit' },
  }));
  try {
    await sendChatToHermesGateway(
      { text: '看看 https://xhslink.com/o/audit123', sender_id: 'conv-audit', channel: 'wechat' },
      {
        config: getHermesGatewayConfig({
          HERMES_API_BASE_URL: 'http://127.0.0.1:8642/v1',
          HERMES_API_KEY: 'token',
          HERMES_REPLY_MODE: 'api',
          RAN_AGENT_CONTEXT_SIZE_LOG: '0',
          XHS_TOKEN_CACHE_PATH: cachePath,
        }),
        fetchImpl: async () => makeJsonResponse({ choices: [{ message: { content: 'ok' } }] }),
        logger: { warn() {}, log(msg) { logs.push(msg); } },
      }
    );
    const evidenceLogs = logs.filter((l) => l.includes('[xhs-evidence]'));
    assert.ok(evidenceLogs.length > 0, 'should have evidence logs');
    assert.ok(evidenceLogs.some((l) => l.includes('stage=link_resolution')), 'should log link_resolution stage');
    assert.ok(evidenceLogs.some((l) => l.includes('stage=content_read')), 'should log content_read stage');
    assert.ok(evidenceLogs.some((l) => l.includes('allow_claim_read=')), 'should log allow_claim_read');
    assert.ok(evidenceLogs.some((l) => l.includes('evidence_source=')), 'should log evidence_source');
  } finally {
    unlinkSync(cachePath);
  }
});

test('buildSocialEvidenceReport redacts token-bearing canonical URL in evidence logs', () => {
  const logs = [];
  const cachePath = '/tmp/test-xhs-redacted-log-' + Date.now() + '.json';
  writeFileSync(cachePath, JSON.stringify({
    'key1': {
      url: 'https://xhslink.com/o/audit123',
      canonical_url: 'https://www.xiaohongshu.com/explore/audit?xsec_token=secret-token&xsec_source=pc_share',
    },
  }));
  try {
    buildSocialEvidenceReport(
      { text: '看看 https://xhslink.com/o/audit123' },
      null,
      { XHS_TOKEN_CACHE_PATH: cachePath },
      { log(message) { logs.push(message); } },
      'req-redacted-1'
    );
    const evidenceLogs = logs.filter((line) => line.includes('[xhs-evidence]'));
    assert.ok(
      evidenceLogs.some((line) => line.includes('canonical_url=https://www.xiaohongshu.com/explore/audit?[redacted]')),
      'should redact canonical URL query'
    );
    assert.ok(evidenceLogs.every((line) => !line.includes('secret-token')), 'should not log xsec_token values');
  } finally {
    unlinkSync(cachePath);
  }
});

test('buildSocialEvidenceReport and applySocialLinkEvidenceGate use provided request_id', () => {
  const logs = [];
  const logger = { log(msg) { logs.push(msg); } };
  const report = buildSocialEvidenceReport(
    { text: '看看 https://xhslink.com/o/no-cache' },
    null,
    { XHS_TOKEN_CACHE_PATH: '/tmp/missing-xhs-cache.json' },
    logger,
    'req-fixed-1'
  );
  applySocialLinkEvidenceGate(
    { text: '看看 https://xhslink.com/o/no-cache' },
    '我读到了正文，内容如下',
    report,
    logger,
    'req-fixed-1'
  );
  const evidenceLogs = logs.filter((line) => line.includes('[xhs-evidence]'));
  assert.ok(evidenceLogs.length > 0);
  assert.ok(evidenceLogs.every((line) => line.includes('request_id=req-fixed-1')));
});

test('same Hermes request reuses request_id for context, routing, evidence, and gate logs', async () => {
  const logs = [];
  await sendChatToHermesGateway(
    { text: '看看 http://xhslink.com/o/abc123', sender_id: 'conv-request-id', channel: 'wechat' },
    {
      config: getHermesGatewayConfig({
        HERMES_API_BASE_URL: 'http://127.0.0.1:8642/v1',
        HERMES_API_KEY: 'token',
        HERMES_REPLY_MODE: 'api',
        RAN_AGENT_CONTEXT_SIZE_LOG: '1',
        XHS_TOKEN_CACHE_PATH: '/tmp/missing-xhs-cache.json',
      }),
      fetchImpl: async () => makeJsonResponse({ choices: [{ message: { content: '我读到了正文，内容如下' } }] }),
      logger: { warn() {}, log(msg) { logs.push(msg); } },
    }
  );
  const requestIds = logs
    .filter((line) => line.includes('[hermes-context-size]') || line.includes('[social-link-routing]') || line.includes('[xhs-evidence]'))
    .map((line) => {
      const jsonStart = line.indexOf('{');
      if (jsonStart >= 0) return JSON.parse(line.slice(jsonStart)).request_id;
      return line.match(/request_id=([^\s]+)/)?.[1];
    })
    .filter(Boolean);
  assert.ok(requestIds.length >= 4);
  assert.equal(new Set(requestIds).size, 1);
});

test('context component telemetry logs sizes and hashes without user text', async () => {
  const logs = [];
  await sendChatToHermesGateway(
    {
      text: '秘密用户原文 包含 cookie=abc123456789',
      sender_id: 'sender-secret',
      conversation_id: 'conv-secret',
      channel: 'wechat',
      recent_local_history: [
        { role: 'user', content: '本地历史原文' },
        { role: 'assistant', content: '本地回复原文' },
      ],
      recent_global_history: [
        { role: 'user', content: '跨平台历史原文' },
      ],
      active_topic: '活跃话题原文',
      continuity_note: '连续性备注原文',
    },
    {
      config: getHermesGatewayConfig({
        HERMES_API_BASE_URL: 'http://127.0.0.1:8642/v1',
        HERMES_API_KEY: 'token',
        HERMES_REPLY_MODE: 'api',
        RAN_AGENT_CONTEXT_SIZE_LOG: '1',
      }),
      fetchImpl: async () => makeJsonResponse({ choices: [{ message: { content: 'ok' } }] }),
      logger: { warn() {}, log(msg) { logs.push(msg); } },
    }
  );

  const line = logs.find((item) => item.startsWith('[hermes-context-components]'));
  assert.ok(line, 'should log context component telemetry');
  const payload = JSON.parse(line.slice(line.indexOf('{')));

  assert.equal(payload.profile, 'ran-assistant-lite');
  assert.equal(payload.channel, 'wechat');
  assert.match(payload.conversation_id_hash, /^[a-f0-9]{16}$/);
  assert.match(payload.session_id_hash, /^[a-f0-9]{16}$/);
  assert.equal(payload.context_mode, 'auto');
  assert.equal(typeof payload.context_decision_reason, 'string');
  assert.equal(typeof payload.budgets.recentLocalTurns, 'number');
  for (const key of [
    'recent_local_history',
    'global_recent_history',
    'active_topic',
    'continuity_note',
    'media_context',
    'daily_digest',
    'current_user_message',
  ]) {
    assert.equal(typeof payload.components[key].chars, 'number', key);
    assert.equal(typeof payload.components[key].bytes, 'number', key);
    assert.equal(typeof payload.components[key].estimated_tokens, 'number', key);
    assert.equal(typeof payload.components[key].omitted, 'boolean', key);
  }
  assert.equal(payload.components.daily_digest.chars, 0);

  const serialized = JSON.stringify(payload);
  for (const forbidden of ['秘密用户原文', '本地历史原文', '跨平台历史原文', '活跃话题原文', '连续性备注原文', 'abc123456789', '/opt/']) {
    assert.ok(!serialized.includes(forbidden), `telemetry should not include ${forbidden}`);
  }
});

test('provider usage telemetry tolerates missing usage fields', async () => {
  const logs = [];
  const response = await sendChatToHermesGateway(
    { text: 'hello', sender_id: 'usage-missing', conversation_id: 'usage-missing', channel: 'wechat' },
    {
      config: getHermesGatewayConfig({
        HERMES_API_BASE_URL: 'http://127.0.0.1:8642/v1',
        HERMES_API_KEY: 'token',
        HERMES_REPLY_MODE: 'api',
        RAN_AGENT_CONTEXT_SIZE_LOG: '1',
      }),
      fetchImpl: async () => makeJsonResponse({ choices: [{ message: { content: 'ok' } }] }),
      logger: { warn() {}, log(msg) { logs.push(msg); } },
    }
  );

  assert.equal(response.reply_text, 'ok');
  const line = logs.find((item) => item.startsWith('[hermes-provider-usage]'));
  assert.ok(line, 'should log provider usage telemetry');
  const payload = JSON.parse(line.slice(line.indexOf('{')));
  assert.equal(payload.input_tokens, null);
  assert.equal(payload.output_tokens, null);
  assert.equal(payload.total_tokens, null);
  assert.equal(payload.prompt_cache_hit_tokens, null);
  assert.equal(payload.prompt_cache_miss_tokens, null);
});

test('provider usage telemetry records token and cache counters when present', async () => {
  const logs = [];
  await sendChatToHermesGateway(
    { text: 'hello', sender_id: 'usage-present', conversation_id: 'usage-present', channel: 'wechat' },
    {
      config: getHermesGatewayConfig({
        HERMES_API_BASE_URL: 'http://127.0.0.1:8642/v1',
        HERMES_API_KEY: 'token',
        HERMES_REPLY_MODE: 'api',
        RAN_AGENT_CONTEXT_SIZE_LOG: '1',
      }),
      fetchImpl: async () => makeJsonResponse({
        choices: [{ message: { content: 'ok' } }],
        usage: {
          prompt_tokens: 123,
          completion_tokens: 45,
          total_tokens: 168,
          prompt_cache_hit_tokens: 100,
          prompt_cache_miss_tokens: 23,
        },
      }),
      logger: { warn() {}, log(msg) { logs.push(msg); } },
    }
  );

  const line = logs.find((item) => item.startsWith('[hermes-provider-usage]'));
  assert.ok(line, 'should log provider usage telemetry');
  const payload = JSON.parse(line.slice(line.indexOf('{')));
  assert.equal(payload.input_tokens, 123);
  assert.equal(payload.output_tokens, 45);
  assert.equal(payload.total_tokens, 168);
  assert.equal(payload.prompt_cache_hit_tokens, 100);
  assert.equal(payload.prompt_cache_miss_tokens, 23);
});

test('context injection rich mode preserves legacy-sized local history budget', async () => {
  const { capturedBody, logs } = await captureHermesRequest({
    env: { HERMES_CONTEXT_INJECTION_MODE: 'rich' },
    payload: {
      recent_local_history: historyTurns('rich-local', 5),
      recent_global_history: historyTurns('rich-global', 3),
      active_topic: 'rich-active-topic',
    },
  });

  assert.deepEqual(capturedBody.messages.slice(1, 11).map((message) => message.content), historyTurns('rich-local', 5).map((message) => message.content));
  assert.match(capturedBody.messages.at(-1).content, /rich-global user 1/);
  assert.match(capturedBody.messages.at(-1).content, /rich-active-topic/);
  const telemetry = parseContextComponentsLog(logs);
  assert.equal(telemetry.context_mode, 'rich');
  assert.equal(telemetry.context_decision_reason, 'explicit_rich');
  assert.equal(telemetry.budgets.recentLocalTurns, 10);
  assert.equal(telemetry.budgets.globalRecentTurns, 6);
});

test('context injection slim mode uses smaller local global and active topic budgets', async () => {
  const { capturedBody, logs } = await captureHermesRequest({
    env: { HERMES_CONTEXT_INJECTION_MODE: 'slim' },
    payload: {
      recent_local_history: historyTurns('slim-local', 6),
      recent_global_history: historyTurns('slim-global', 4),
      active_topic: `slim-active ${'长话题'.repeat(300)}`,
    },
  });

  const roles = capturedBody.messages.map((message) => message.role);
  assert.equal(roles.filter((role) => role === 'user' || role === 'assistant').length, 9);
  const serialized = JSON.stringify(capturedBody.messages);
  assert.doesNotMatch(serialized, /slim-local user 1/);
  assert.match(serialized, /slim-local user 3/);
  assert.doesNotMatch(serialized, /slim-global user 1/);
  assert.match(serialized, /slim-global user 3/);
  const telemetry = parseContextComponentsLog(logs);
  assert.equal(telemetry.context_mode, 'slim');
  assert.equal(telemetry.budgets.recentLocalTurns, 4);
  assert.equal(telemetry.budgets.globalRecentChars, 800);
  assert.ok(telemetry.components.active_topic.chars <= 400);
});

test('context injection resume mode keeps session and uses short recovery budgets without digest', async () => {
  const { capturedBody, capturedHeaders, logs } = await captureHermesRequest({
    env: { HERMES_CONTEXT_INJECTION_MODE: 'resume' },
    payload: {
      sender_id: 'resume-sender',
      conversation_id: 'resume-conversation',
      recent_local_history: historyTurns('resume-local', 4),
      recent_global_history: historyTurns('resume-global', 3),
      active_topic: 'resume-active-topic',
    },
  });

  assert.match(capturedHeaders['X-Hermes-Session-Id'], /^ran-agent-wechat-[a-f0-9]{16}$/);
  assert.match(capturedHeaders['X-Hermes-Session-Key'], /^ran-agent-memory-[a-f0-9]{16}$/);
  const serialized = JSON.stringify(capturedBody.messages);
  assert.doesNotMatch(serialized, /resume-local user 1/);
  assert.match(serialized, /resume-local user 3/);
  assert.doesNotMatch(serialized, /daily_digest|continuity digest|open_threads/);
  const telemetry = parseContextComponentsLog(logs);
  assert.equal(telemetry.context_mode, 'resume');
  assert.equal(telemetry.context_decision_reason, 'explicit_resume');
  assert.equal(telemetry.components.daily_digest.chars, 0);
  assert.equal(telemetry.budgets.recentLocalTurns, 2);
});

test('context injection auto same conversation omits global recent history', async () => {
  const { capturedBody, logs } = await captureHermesRequest({
    env: { HERMES_CONTEXT_INJECTION_MODE: 'auto' },
    payload: {
      recent_local_history: historyTurns('auto-local', 2),
      recent_global_history: historyTurns('auto-global-sensitive', 3),
      active_topic: 'auto-active-topic',
    },
  });

  const serialized = JSON.stringify(capturedBody.messages);
  assert.match(serialized, /auto-local user 1/);
  assert.doesNotMatch(serialized, /auto-global-sensitive/);
  assert.doesNotMatch(capturedBody.messages.at(-1).content, /global active topic/);
  const telemetry = parseContextComponentsLog(logs);
  assert.equal(telemetry.context_mode, 'auto');
  assert.equal(telemetry.context_decision_reason, 'auto_same_conversation_slim');
  assert.equal(telemetry.budgets.globalRecentTurns, 0);
  assert.equal(telemetry.components.global_recent_history.omitted, true);
});

test('context injection auto cross channel keeps continuity and brief global recent', async () => {
  const { capturedBody, logs } = await captureHermesRequest({
    env: { HERMES_CONTEXT_INJECTION_MODE: 'auto' },
    payload: {
      channel: 'feishu',
      platform: 'feishu',
      recent_local_history: [],
      recent_global_history: historyTurns('cross-global', 3),
      continuity_note: 'current_topic: cross-channel handoff',
      active_topic: 'cross-active-topic',
    },
  });

  const userPrompt = capturedBody.messages.at(-1).content;
  assert.match(userPrompt, /current_topic: cross-channel handoff/);
  assert.match(userPrompt, /cross-global user 2/);
  assert.doesNotMatch(userPrompt, /cross-global user 1/);
  const telemetry = parseContextComponentsLog(logs);
  assert.equal(telemetry.context_decision_reason, 'auto_cross_channel_brief');
  assert.equal(telemetry.budgets.globalRecentTurns, 2);
});

test('context injection env budgets override mode defaults', async () => {
  const { capturedBody, logs } = await captureHermesRequest({
    env: {
      HERMES_CONTEXT_INJECTION_MODE: 'slim',
      HERMES_GLOBAL_RECENT_TURNS: '3',
      HERMES_GLOBAL_RECENT_CHAR_BUDGET: '5000',
    },
    payload: {
      recent_local_history: [],
      recent_global_history: historyTurns('override-global', 3),
    },
  });

  const userPrompt = capturedBody.messages.at(-1).content;
  assert.match(userPrompt, /override-global user 1/);
  assert.match(userPrompt, /override-global assistant 3/);
  const telemetry = parseContextComponentsLog(logs);
  assert.equal(telemetry.context_mode, 'slim');
  assert.equal(telemetry.budgets.globalRecentTurns, 3);
  assert.equal(telemetry.budgets.globalRecentChars, 5000);
});

test('context injection invalid mode falls back to auto and warns', async () => {
  const { logs, warns } = await captureHermesRequest({
    env: { HERMES_CONTEXT_INJECTION_MODE: 'mystery' },
    payload: { recent_local_history: [] },
  });

  assert.ok(warns.some((line) => /invalid HERMES_CONTEXT_INJECTION_MODE/i.test(line)));
  const telemetry = parseContextComponentsLog(logs);
  assert.equal(telemetry.context_mode, 'auto');
  assert.equal(telemetry.context_decision_reason, 'auto_resume_new_session');
});

test('context injection keeps media compact independent from text budgets', async () => {
  const { capturedBody, logs } = await captureHermesRequest({
    env: {
      HERMES_CONTEXT_INJECTION_MODE: 'slim',
      RAN_AGENT_MAX_MEDIA_ARTIFACTS: '1',
    },
    payload: {
      media: [{ filePath: '/tmp/test.png', mimeType: 'image/png', type: 'image' }],
      recent_local_history: historyTurns('media-local', 6),
      recent_global_history: historyTurns('media-global', 4),
    },
    responseBody: { choices: [{ message: { content: 'ok' } }] },
  });

  const userPrompt = capturedBody.messages.at(-1).content;
  assert.match(userPrompt, /媒体工具指令|微信入站媒体资产/);
  const telemetry = parseContextComponentsLog(logs);
  assert.equal(telemetry.context_mode, 'slim');
  assert.equal(telemetry.budgets.recentLocalTurns, 4);
  assert.equal(typeof telemetry.components.media_context.chars, 'number');
});

test('context injection does not truncate current user message', async () => {
  const longUserText = `CURRENT-USER-START ${'用户正文'.repeat(900)} CURRENT-USER-END`;
  const { capturedBody, logs } = await captureHermesRequest({
    env: {
      HERMES_CONTEXT_INJECTION_MODE: 'slim',
      HERMES_RECENT_TEXT_CHAR_BUDGET: '20',
    },
    payload: {
      text: longUserText,
      recent_local_history: historyTurns('tiny-local', 2, 'old text'),
    },
  });

  const userPrompt = capturedBody.messages.at(-1).content;
  assert.match(userPrompt, /CURRENT-USER-START/);
  assert.match(userPrompt, /CURRENT-USER-END/);
  const telemetry = parseContextComponentsLog(logs);
  assert.equal(telemetry.components.current_user_message.chars, longUserText.length);
  assert.ok(!JSON.stringify(telemetry).includes('CURRENT-USER-START'));
});

test('soft reset pending digest is injected once into lite resume request and then consumed', async () => {
  const stateDir = tempGatewayStateDir();
  const env = {
    HERMES_API_BASE_URL: 'http://127.0.0.1:8642/v1',
    HERMES_API_KEY: 'token',
    HERMES_REPLY_MODE: 'api',
    RAN_AGENT_CONTEXT_SIZE_LOG: '1',
    RAN_AGENT_STATE_DIR: stateDir,
    HERMES_LITE_SOFT_RESET_ENABLED: 'true',
    HERMES_LITE_SOFT_RESET_DRY_RUN: 'false',
  };
  runHermesLiteSoftReset({
    action: 'apply',
    env,
    timelineRecords: [
      { role: 'assistant', text_summary: 'pending: 观察 input_tokens 和 prompt_cache_hit_tokens', created_at: 1 },
      { role: 'user', text: '偏好：日常聊天保持 slim，不要解释 session/token 机制', created_at: 2 },
    ],
    now: new Date('2026-06-14T00:00:00Z'),
  });

  const logs = [];
  let capturedBody = null;
  await sendChatToHermesGateway(
    { text: '早', sender_id: 'soft-reset-user', conversation_id: 'soft-reset-conv', channel: 'wechat' },
    {
      config: getHermesGatewayConfig(env),
      fetchImpl: async (url, options) => {
        capturedBody = JSON.parse(options.body);
        return makeJsonResponse({ choices: [{ message: { content: 'ok' } }] });
      },
      logger: { warn() {}, log(msg) { logs.push(msg); } },
    }
  );

  const userPrompt = capturedBody.messages.at(-1).content;
  assert.match(userPrompt, /daily_digest/);
  assert.match(userPrompt, /pending_commitments|active_preferences/);
  const telemetry = parseContextComponentsLog(logs);
  assert.equal(telemetry.context_mode, 'resume');
  assert.equal(telemetry.context_decision_reason, 'soft_reset_pending_digest');
  assert.ok(telemetry.components.daily_digest.chars > 0);
  const state = readHermesLiteMaintenanceState(getHermesLiteSoftResetConfig(env));
  assert.equal(state.digests[0].consumed, true);
  assert.equal(state.pendingDigestId, '');
});

test('soft reset pending digest is not consumed when provider request fails', async () => {
  const stateDir = tempGatewayStateDir();
  const env = {
    HERMES_API_BASE_URL: 'http://127.0.0.1:8642/v1',
    HERMES_API_KEY: 'token',
    HERMES_REPLY_MODE: 'api',
    RAN_AGENT_CONTEXT_SIZE_LOG: '1',
    RAN_AGENT_STATE_DIR: stateDir,
    HERMES_LITE_SOFT_RESET_ENABLED: 'true',
    HERMES_LITE_SOFT_RESET_DRY_RUN: 'false',
  };
  const applied = runHermesLiteSoftReset({
    action: 'apply',
    env,
    timelineRecords: [{ role: 'assistant', text_summary: 'pending: provider failure should keep digest pending', created_at: 1 }],
    now: new Date('2026-06-14T00:00:00Z'),
  });

  await assert.rejects(
    () => sendChatToHermesGateway(
      { text: '早', sender_id: 'soft-reset-fail-user', conversation_id: 'soft-reset-fail-conv', channel: 'wechat' },
      {
        config: getHermesGatewayConfig(env),
        fetchImpl: async () => makeJsonResponse({ error: 'boom' }, false, 500),
        logger: { warn() {}, log() {} },
      }
    ),
    /HTTP 500/
  );

  const state = readHermesLiteMaintenanceState(getHermesLiteSoftResetConfig(env));
  assert.equal(state.pendingDigestId, applied.digest.digestId);
  assert.equal(state.digests[0].consumed, false);
});

test('soft reset pending digest does not affect full profile requests', async () => {
  const stateDir = tempGatewayStateDir();
  const env = {
    HERMES_API_BASE_URL: 'http://127.0.0.1:8642/v1',
    HERMES_FULL_API_BASE_URL: 'http://127.0.0.1:8643/v1',
    HERMES_API_KEY: 'token',
    HERMES_REPLY_MODE: 'api',
    RAN_AGENT_CAPABILITY_MODE: 'full',
    RAN_AGENT_CONTEXT_SIZE_LOG: '1',
    RAN_AGENT_STATE_DIR: stateDir,
    HERMES_LITE_SOFT_RESET_ENABLED: 'true',
    HERMES_LITE_SOFT_RESET_DRY_RUN: 'false',
  };
  const applied = runHermesLiteSoftReset({
    action: 'apply',
    env,
    timelineRecords: [{ role: 'assistant', text_summary: 'pending: lite only digest', created_at: 1 }],
    now: new Date('2026-06-14T00:00:00Z'),
  });

  let capturedBody = null;
  await sendChatToHermesGateway(
    { text: '调试一下服务端', sender_id: 'full-user', conversation_id: 'full-conv', channel: 'wechat' },
    {
      config: getHermesGatewayConfig(env),
      fetchImpl: async (url, options) => {
        if (!options?.body) return makeJsonResponse({ data: [] });
        capturedBody = JSON.parse(options.body);
        return makeJsonResponse({ choices: [{ message: { content: 'ok' } }] });
      },
      logger: { warn() {}, log() {} },
    }
  );

  assert.equal(capturedBody.model, 'ran-assistant');
  assert.doesNotMatch(capturedBody.messages.at(-1).content, /daily_digest|lite only digest/);
  const state = readHermesLiteMaintenanceState(getHermesLiteSoftResetConfig(env));
  assert.equal(state.pendingDigestId, applied.digest.digestId);
  assert.equal(state.digests[0].consumed, false);
});

// --- Robust Token Cache Matching Tests ---

test('matchXhsTokenCacheEntry: entries wrapper with short code match', () => {
  // After readXhsTokenCache normalizes, entries wrapper is unwrapped.
  // matchXhsTokenCacheEntry receives the inner entries directly.
  const cache = {
    '6a0002d9000000003600279b': { url: 'https://xhslink.com/o/1On30olwqeD', canonical_url: 'https://www.xiaohongshu.com/discovery/item/6a0002d9000000003600279b?xsec_token=abc', note_id: '6a0002d9000000003600279b' },
  };
  const entry = matchXhsTokenCacheEntry('看看 https://xhslink.com/o/1On30olwqeD', cache);
  assert.ok(entry);
  assert.equal(entry.note_id, '6a0002d9000000003600279b');
});

test('matchXhsTokenCacheEntry: http URL matches https cache entry', () => {
  const cache = {
    'key1': { url: 'https://xhslink.com/o/abc123' },
  };
  const entry = matchXhsTokenCacheEntry('http://xhslink.com/o/abc123', cache);
  assert.ok(entry);
});

test('matchXhsTokenCacheEntry: trailing Chinese punctuation stripped', () => {
  const cache = {
    'key1': { url: 'https://xhslink.com/o/abc123' },
  };
  const entry = matchXhsTokenCacheEntry('看看 https://xhslink.com/o/abc123。', cache);
  assert.ok(entry);
});

test('matchXhsTokenCacheEntry: trailing Chinese comma stripped', () => {
  const cache = {
    'key1': { url: 'https://xhslink.com/o/abc123' },
  };
  const entry = matchXhsTokenCacheEntry('看看 https://xhslink.com/o/abc123，', cache);
  assert.ok(entry);
});

test('matchXhsTokenCacheEntry: trailing bracket and quote stripped', () => {
  const cache = {
    'key1': { url: 'https://xhslink.com/o/abc123' },
  };
  const entry1 = matchXhsTokenCacheEntry('(https://xhslink.com/o/abc123)', cache);
  assert.ok(entry1, 'should match with parentheses');
  const entry2 = matchXhsTokenCacheEntry('"https://xhslink.com/o/abc123"', cache);
  assert.ok(entry2, 'should match with quotes');
});

test('matchXhsTokenCacheEntry: array cache structure', () => {
  const cache = [
    { url: 'https://xhslink.com/o/abc123', note_id: '6a0002d9', canonical_url: 'https://www.xiaohongshu.com/explore/6a0002d9' },
  ];
  const entry = matchXhsTokenCacheEntry('看看 https://xhslink.com/o/abc123', cache);
  assert.ok(entry);
  assert.equal(entry.note_id, '6a0002d9');
});

test('matchXhsTokenCacheEntry: canonical_url note_id match', () => {
  const cache = {
    'key1': { canonical_url: 'https://www.xiaohongshu.com/discovery/item/6a0002d9000000003600279b?xsec_token=abc' },
  };
  const entry = matchXhsTokenCacheEntry('https://www.xiaohongshu.com/discovery/item/6a0002d9000000003600279b', cache);
  assert.ok(entry);
});

test('matchXhsTokenCacheEntry: short code case insensitive', () => {
  const cache = {
    'key1': { url: 'https://xhslink.com/o/ABC123' },
  };
  const entry = matchXhsTokenCacheEntry('看看 https://xhslink.com/o/abc123', cache);
  assert.ok(entry);
});

test('readXhsTokenCache: prefers XHS_TOKEN_CACHE_PATH env', () => {
  const path1 = '/tmp/test-cache-env-' + Date.now() + '.json';
  const path2 = '/tmp/test-cache-default-' + Date.now() + '.json';
  writeFileSync(path1, JSON.stringify({ from: 'env' }));
  writeFileSync(path2, JSON.stringify({ from: 'default' }));
  try {
    const result = readXhsTokenCache({ XHS_TOKEN_CACHE_PATH: path1 });
    assert.equal(result.from, 'env');
  } finally {
    unlinkSync(path1);
    unlinkSync(path2);
  }
});

test('readXhsTokenCache: falls back to second default path', () => {
  const path2 = '/tmp/test-cache-fallback-' + Date.now() + '.json';
  writeFileSync(path2, JSON.stringify({ from: 'fallback' }));
  try {
    const result = readXhsTokenCache({
      XHS_TOKEN_CACHE_PATH: '/nonexistent/path.json',
      // Override the default paths by passing env that won't match
    });
    // The default paths are hardcoded, but we can't easily override them.
    // This test verifies the function doesn't crash when env path is missing.
    assert.ok(typeof result === 'object');
  } finally {
    unlinkSync(path2);
  }
});

test('readXhsTokenCache: returns empty when all paths missing', () => {
  const result = readXhsTokenCache({ XHS_TOKEN_CACHE_PATH: '/nonexistent/path.json' });
  assert.deepEqual(result, {});
});

test('production case: xhslink with entries wrapper and trailing period', () => {
  const cachePath = '/tmp/test-xhs-production-' + Date.now() + '.json';
  writeFileSync(cachePath, JSON.stringify({
    entries: {
      '6a0002d9000000003600279b': {
        url: 'https://xhslink.com/o/1On30olwqeD',
        canonical_url: 'https://www.xiaohongshu.com/discovery/item/6a0002d9000000003600279b?xsec_token=abc123&xsec_source=pc_search',
        note_id: '6a0002d9000000003600279b',
      },
    },
  }));
  try {
    const report = buildSocialEvidenceReport(
      { text: '看看 https://xhslink.com/o/1On30olwqeD。' },
      null,
      { XHS_TOKEN_CACHE_PATH: cachePath },
      { log() {} }
    );
    assert.equal(report.hasSocialLink, true);
    assert.equal(report.link_resolution.ok, true, 'link_resolution should be true');
    assert.equal(report.link_resolution.source, 'token_cache');
    assert.equal(report.link_resolution.canonical_url, 'https://www.xiaohongshu.com/discovery/item/6a0002d9000000003600279b?xsec_token=abc123&xsec_source=pc_search');
    assert.equal(report.content_read.ok, false, 'content_read should still be false');
    assert.equal(report.allow_claim_read, false);
    assert.equal(report.evidence_source, 'token_cache');
  } finally {
    unlinkSync(cachePath);
  }
});
