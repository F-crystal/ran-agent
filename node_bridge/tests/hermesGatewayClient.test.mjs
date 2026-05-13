import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getHermesGatewayConfig,
  sendChatToHermesGateway,
} from '../src/hermesGatewayClient.mjs';

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
      }),
      fetchImpl: async (url, init) => {
        capturedUrl = url;
        capturedHeaders = init.headers;
        capturedBody = JSON.parse(init.body);
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

  assert.equal(capturedUrl, 'http://127.0.0.1:8642/v1/chat/completions');
  assert.equal(capturedHeaders.Authorization, 'Bearer token');
  assert.equal(capturedBody.model, 'ran-assistant');
  assert.equal(capturedBody.stream, false);
  assert.match(capturedBody.messages[0].content, /Hermes/);
  assert.match(capturedBody.messages[1].content, /微信桥接实时上下文/);
  assert.match(capturedBody.messages[1].content, /你好\n补一句/);
  assert.equal(response.reply_text, 'Hermes reply');
  assert.equal(response.model, 'ran-assistant');
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
