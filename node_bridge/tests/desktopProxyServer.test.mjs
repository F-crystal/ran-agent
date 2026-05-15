import test from 'node:test';
import assert from 'node:assert/strict';

import { createDesktopProxyServer, openAiResponseFromReply } from '../src/desktopProxyServer.mjs';

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
  assert.equal(response.status, 200);
  assert.equal(response.body.data.some((model) => model.id === 'ran-agent'), true);
});

test('desktop proxy chat completions routes through channelHub', async () => {
  let normalized = null;
  const server = createDesktopProxyServer({
    env: { DESKTOP_PROXY_DEFAULT_CLIENT_ID: 'desktop-local' },
    channelHub: async (message) => {
      normalized = message;
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
    'x-ran-agent-client-id': 'desktop-client',
    'x-ran-agent-conversation-id': 'desktop-thread',
  }));

  assert.equal(response.status, 200);
  assert.equal(normalized.platform, 'desktop');
  assert.equal(normalized.conversation_id, 'desktop-thread');
  assert.equal(normalized.sender_id, 'desktop-client');
  assert.equal(normalized.text, '她的故事很感动');
  assert.equal(normalized.raw_event_meta.model, 'ran-agent');
  assert.equal(normalized.prior_messages.length, 2);
  assert.equal(response.body.choices[0].message.content, '桌面回复');
});

test('desktop proxy stream=true returns clear unsupported error', async () => {
  const server = createDesktopProxyServer({ channelHub: async () => ({ replyText: '' }) });
  const response = await server.handleRequest(request('POST', '/v1/chat/completions', {
    model: 'ran-agent',
    stream: true,
    messages: [{ role: 'user', content: 'hi' }],
  }));
  assert.equal(response.status, 400);
  assert.match(response.body.error.message, /stream/);
});

test('openAiResponseFromReply is OpenAI-compatible', () => {
  const body = openAiResponseFromReply({ replyText: 'OK' }, { model: 'ran-agent' });
  assert.equal(body.object, 'chat.completion');
  assert.equal(body.choices[0].message.role, 'assistant');
  assert.equal(body.choices[0].message.content, 'OK');
});
