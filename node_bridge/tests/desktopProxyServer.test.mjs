import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { createDesktopProxyServer, openAiResponseFromReply } from '../src/desktopProxyServer.mjs';
import { createDurableOutbox } from '../src/durableOutbox.mjs';
import { handleIncomingMessage } from '../src/channelHub.mjs';
import { createReplyBackend } from '../src/replyBackend.mjs';
import { createIsolatedTestEnv } from './helpers/isolatedState.mjs';

function request(method, url, body, headers = {}) {
  return {
    method,
    url,
    headers,
    async json() {
      return body;
    },
  };
}

test('desktop proxy /v1/models returns ran-agent models', async () => {
  const server = createDesktopProxyServer({ channelHub: async () => ({ replyText: '' }) });
  const response = await server.handleRequest(request('GET', '/v1/models'));
  assert.equal(response.status, 401);
});

test('desktop proxy requires a configured credential even on loopback', async () => {
  const server = createDesktopProxyServer({
    env: { DESKTOP_PROXY_API_KEY: 'a'.repeat(32) },
    channelHub: async () => ({ replyText: '' }),
  });
  const response = await server.handleRequest(request('GET', '/v1/models'));
  assert.equal(response.status, 401);
});

test('desktop proxy chat completions routes through channelHub', async () => {
  let normalized = null;
  let channelOptions = null;
  const outbox = { name: 'shared-outbox' };
  const server = createDesktopProxyServer({
    env: { DESKTOP_PROXY_API_KEY: 'a'.repeat(32) },
    outbox,
    channelHub: async (message, options) => {
      normalized = message;
      channelOptions = options;
      return { replyText: '桌面回复' };
    },
  });

  const response = await server.handleRequest(request('POST', '/v1/chat/completions', {
    model: 'ran-agent',
    messages: [
      { role: 'user', content: '我们聊内莉·布莱' },
      { role: 'assistant', content: '她是记者' },
      { role: 'user', content: '她的故事很感动' },
    ],
  }, {
    authorization: `Bearer ${'a'.repeat(32)}`,
    'x-ran-agent-client-id': 'desktop-client',
    'x-ran-agent-conversation-id': 'desktop-thread',
  }));

  assert.equal(response.status, 200);
  assert.equal(normalized.platform, 'desktop');
  assert.match(normalized.conversation_id, /^desktop:[a-f0-9]{32}$/);
  assert.equal(normalized.conversation_id, normalized.sender_id);
  assert.notEqual(normalized.conversation_id, 'desktop-thread');
  assert.notEqual(normalized.sender_id, 'desktop-client');
  assert.equal(normalized.text, '她的故事很感动');
  assert.equal(normalized.raw_event_meta.model, 'ran-agent');
  assert.equal(normalized.prior_messages.length, 2);
  assert.equal(channelOptions.outbox, outbox);
  assert.equal(typeof channelOptions.adapter?.sendReply, 'function');
  assert.deepEqual(
    await channelOptions.adapter.sendReply({ text: '桌面回复' }),
    {
      textStatus: 'ambiguous',
      attachments: [],
      adapterReceiptRef: 'desktop:http-response-boundary',
    },
  );
  assert.equal(response.body.choices[0].message.content, '桌面回复');
});

test('desktop OpenAI-compatible payload cannot submit a digest route hint to bypass the action gate', async (t) => {
  const env = createIsolatedTestEnv(t, {
    DESKTOP_PROXY_API_KEY: 'a'.repeat(32),
    HERMES_ACTION_GATE_ENABLED: 'true',
    HERMES_ACTION_GATE_MODE: 'enforce',
  }, 'desktop-forged-route-');
  const server = createDesktopProxyServer({
    env,
    logger: { log() {}, warn() {}, error() {}, info() {} },
    channelHub: (message, options) => handleIncomingMessage(message, {
      ...options,
      replyBackend: createReplyBackend({
        env,
        hermesImpl: async () => ({ reply_text: '图片已经生成好了。', follow_up_messages: [], media: null }),
        ingestImpl: async () => ({ ok: true }),
        logger: { log() {}, warn() {} },
      }),
    }),
  });
  const response = await server.handleRequest(request('POST', '/v1/chat/completions', {
    model: 'ran-agent',
    route_hint: 'manual_ai_daily_digest',
    messages: [{ role: 'user', content: 'hello' }],
  }, { authorization: `Bearer ${'a'.repeat(32)}` }));

  assert.equal(response.status, 200);
  assert.equal(response.body.choices[0].message.content, '尚未收到可验证的执行结果，暂不确认已完成。');
});

test('desktop proxy denies non-loopback binding without a strong credential', async () => {
  const server = createDesktopProxyServer({
    env: {
      DESKTOP_PROXY_HOST: '0.0.0.0',
      DESKTOP_PROXY_API_KEY: 'short',
    },
    channelHub: async () => ({ replyText: '' }),
  });
  const response = await server.handleRequest(request('GET', '/v1/models', undefined, {
    authorization: 'Bearer short',
  }));
  assert.equal(response.status, 403);
});

test('desktop HTTP response delivery is durably ambiguous until the response boundary is observable', async (t) => {
  const baseEnv = createIsolatedTestEnv(t, { DESKTOP_PROXY_API_KEY: 'a'.repeat(32) }, 'desktop-outbox-');
  const env = {
    ...baseEnv,
    RAN_AGENT_GLOBAL_TIMELINE_PATH: path.join(baseEnv.RAN_AGENT_STATE_DIR, 'timeline.jsonl'),
  };
  const outbox = createDurableOutbox({ env });
  const server = createDesktopProxyServer({
    env,
    outbox,
    logger: { log() {}, warn() {}, error() {}, info() {} },
    channelHub: (message, options) => handleIncomingMessage(message, {
      ...options,
      replyBackend: {
        async getReply() {
          return { replyText: '等 HTTP 写入', followUpMessages: [], media: null };
        },
      },
    }),
  });
  const response = await server.handleRequest(request('POST', '/v1/chat/completions', {
    model: 'ran-agent',
    messages: [{ role: 'user', content: 'hello' }],
  }, { authorization: `Bearer ${'a'.repeat(32)}` }));

  assert.equal(response.status, 200);
  assert.equal(response.body.choices[0].message.content, '等 HTTP 写入');
  assert.equal(outbox.list().length, 1);
  assert.equal(outbox.list()[0].delivery, 'ambiguous');
  assert.equal(outbox.list()[0].timelineProjection, 'pending');
});

test('desktop proxy stream=true returns clear unsupported error', async () => {
  const server = createDesktopProxyServer({
    env: { DESKTOP_PROXY_API_KEY: 'a'.repeat(32) },
    channelHub: async () => ({ replyText: '' }),
  });
  const response = await server.handleRequest(request('POST', '/v1/chat/completions', {
    model: 'ran-agent',
    stream: true,
    messages: [{ role: 'user', content: 'hi' }],
  }, { authorization: `Bearer ${'a'.repeat(32)}` }));
  assert.equal(response.status, 400);
  assert.match(response.body.error.message, /stream/);
});

test('openAiResponseFromReply is OpenAI-compatible', () => {
  const body = openAiResponseFromReply({ replyText: 'OK' }, { model: 'ran-agent' });
  assert.equal(body.object, 'chat.completion');
  assert.equal(body.choices[0].message.role, 'assistant');
  assert.equal(body.choices[0].message.content, 'OK');
});
