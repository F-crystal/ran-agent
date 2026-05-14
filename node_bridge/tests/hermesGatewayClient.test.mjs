import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getHermesGatewayConfig,
  sendChatToHermesGateway,
  buildCourtlyStyleAnchor,
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
        RAN_AGENT_CAPABILITY_MODE: 'full',
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
  assert.match(capturedBody.messages[1].content, /时间/);
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
  assert.ok(!systemMsg.content.includes('\n'), 'system instruction should be single line');
  assert.ok(systemMsg.content.includes('MANDATORY RULES'), 'should include mandatory rules');
  assert.ok(systemMsg.content.includes('social_reader'), 'should mention social_reader');
  assert.ok(systemMsg.content.includes('web_extract and web_search are allowed'), 'should allow web tools for normal pages');
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
  await sendChatToHermesGateway(
    { text: '帮我看看 http://xhslink.com/o/abc123', sender_id: 'conv-xhs', channel: 'wechat' },
    {
      config: getHermesGatewayConfig({ HERMES_API_BASE_URL: 'http://127.0.0.1:8642/v1', HERMES_API_KEY: 'token', HERMES_REPLY_MODE: 'api', RAN_AGENT_CONTEXT_SIZE_LOG: '0' }),
      fetchImpl: async (url, options) => { capturedBody = JSON.parse(options.body); return makeJsonResponse({ choices: [{ message: { content: 'ok' } }] }); },
      logger: { warn() {} },
    }
  );
  const userMsg = capturedBody.messages.find((m) => m.role === 'user');
  assert.ok(userMsg.content.includes('社交链接路由指令'), 'should inject social routing');
  assert.ok(userMsg.content.includes('小红书'), 'should detect platform');
  assert.ok(userMsg.content.includes('social_reader'), 'should mention social_reader');
  assert.ok(userMsg.content.includes('resolve_social_url'), 'should include resolve step');
  assert.ok(userMsg.content.includes('read_social_post_deep'), 'should include deep read step');
  assert.ok(userMsg.content.includes('不要使用 web_extract'), 'should forbid web_extract');
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
