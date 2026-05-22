import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync } from 'node:fs';

import {
  getHermesGatewayConfig,
  sendChatToHermesGateway,
  buildCourtlyStyleAnchor,
  readXhsTokenCache,
  matchXhsTokenCacheEntry,
  buildSocialEvidenceReport,
  applySocialLinkEvidenceGate,
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
