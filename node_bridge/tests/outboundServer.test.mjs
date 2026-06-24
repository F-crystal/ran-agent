import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  getOutboundServerConfig,
  handleEnvironmentSensorRequest,
  handleOutboundRequest,
  handleScheduledAiDigestRequest,
  resolveStateDir,
} from '../src/outboundServer.mjs';
import {
  appendPendingOutboundMessage,
  drainPendingOutboundMessages,
  setFeishuHomeDmTarget,
  setProactiveDispatchState,
} from '../src/runtimeState.mjs';

const PROJECT_ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const ORIGINAL_PROACTIVE_ENABLED = process.env.PERSONAL_AGENT_PROACTIVE_ENABLED;

test.beforeEach(() => {
  process.env.PERSONAL_AGENT_PROACTIVE_ENABLED = 'true';
});

test.afterEach(() => {
  if (ORIGINAL_PROACTIVE_ENABLED === undefined) {
    delete process.env.PERSONAL_AGENT_PROACTIVE_ENABLED;
  } else {
    process.env.PERSONAL_AGENT_PROACTIVE_ENABLED = ORIGINAL_PROACTIVE_ENABLED;
  }
});

test('getOutboundServerConfig reads host and port from environment', () => {
  const config = getOutboundServerConfig({
    NODE_BRIDGE_OUTBOUND_HOST: '127.0.0.2',
    NODE_BRIDGE_OUTBOUND_PORT: '9901',
    PERSONAL_AGENT_WECHAT_ACCOUNT_ID: 'personal_agent',
  });

  assert.equal(config.host, '127.0.0.2');
  assert.equal(config.port, 9901);
  assert.equal(config.accountId, 'personal_agent');
});

test('handleEnvironmentSensorRequest accepts Sensor Logger payload with path token', async () => {
  const env = {
    RAN_AGENT_STATE_DIR: fs.mkdtempSync(path.join(PROJECT_ROOT, '.ran_agent_state', 'test-env-ingest-')),
    ENVIRONMENT_SENSOR_INGEST_TOKEN: 'secret-token',
  };
  const result = await handleEnvironmentSensorRequest({
    env,
    method: 'POST',
    url: '/environment/sensorlogger/secret-token',
    bodyText: JSON.stringify({
      messageId: 1,
      sessionId: 'session-a',
      deviceId: 'phone-a',
      payload: [
        {
          name: 'battery',
          time: 1710000001000000000,
          values: { batteryLevel: 0.42, batteryState: 'charging', lowPowerMode: false },
        },
      ],
    }),
  });

  assert.equal(result.status, 200);
  assert.equal(result.payload.ok, true);
  assert.equal(result.payload.readings, 1);
  const latestPath = path.join(env.RAN_AGENT_STATE_DIR, 'environment', 'latest.json');
  const latest = JSON.parse(fs.readFileSync(latestPath, 'utf8'));
  assert.equal(latest.battery.percent, 42);
  assert.equal(latest.battery.state, 'charging');
});

test('handleEnvironmentSensorRequest rejects missing or wrong token', async () => {
  const env = {
    RAN_AGENT_STATE_DIR: fs.mkdtempSync(path.join(PROJECT_ROOT, '.ran_agent_state', 'test-env-ingest-')),
    ENVIRONMENT_SENSOR_INGEST_TOKEN: 'secret-token',
  };
  const result = await handleEnvironmentSensorRequest({
    env,
    method: 'POST',
    url: '/environment/sensorlogger/wrong',
    bodyText: '{}',
  });

  assert.equal(result.status, 403);
  assert.equal(result.payload.error, 'forbidden');
});

test('handleOutboundRequest sends proactive message through bot', async () => {
  let sentPayload = null;
  const result = await handleOutboundRequest({
    bot: {
      async sendMessage(text) {
        sentPayload = text;
      },
    },
    logger: {
      info() {},
      error() {},
    },
    method: 'POST',
    url: '/outbound/send',
    bodyText: JSON.stringify({ text: '你刚提到下午要改论文提纲，进展到哪一步了？' }),
  });

  assert.equal(result.status, 200);
  assert.equal(result.payload.ok, true);
  if (result.payload.queued !== true) {
    assert.equal(typeof result.payload.nextCheckinInMinutes, 'number');
    assert.equal(sentPayload, '你刚提到下午要改论文提纲，进展到哪一步了？');
  } else {
    assert.equal(sentPayload, null);
  }
});

test('handleScheduledAiDigestRequest routes digest through existing Feishu DM flow', async () => {
  const templatePath = path.join(PROJECT_ROOT, 'src/personal_agent/prompts/ai_daily_digest_report.md');
  assert.equal(fs.existsSync(templatePath), true);

  const stateBaseDir = path.join(PROJECT_ROOT, '.ran_agent_state');
  fs.mkdirSync(stateBaseDir, { recursive: true });
  const tempStateDir = fs.mkdtempSync(path.join(stateBaseDir, 'scheduled-digest-'));
  const env = {
    ...process.env,
    RAN_AGENT_STATE_DIR: tempStateDir,
    FEISHU_LARK_CLI_BIN: 'lark-cli',
    FEISHU_LARK_CLI_IDENTITY: 'bot',
  };
  setFeishuHomeDmTarget(
    {
      platform: 'feishu',
      channel_type: 'dm',
      conversation_id: 'oc-home',
      sender_id: 'ou-home',
    },
    env
  );

  let channelMessage = null;
  const calls = [];
  const result = await handleScheduledAiDigestRequest({
    logger: { info() {}, warn() {}, error() {}, log() {} },
    env,
    bodyText: JSON.stringify({ facts: '今日 AI 事实材料' }),
    channelHub: async (message, options) => {
      channelMessage = message;
      await options.adapter.sendReply({
        target: {
          channel_type: 'dm',
          conversation_id: message.conversation_id,
          sender_id: message.sender_id,
        },
        text: '给陛下呈上今日 AI 日报',
        message,
      });
      return { replyText: '给陛下呈上今日 AI 日报' };
    },
    execFileImpl: async (bin, args) => {
      calls.push({ bin, args });
      return { stdout: '{"ok":true}' };
    },
  });

  assert.equal(result.status, 200);
  assert.equal(result.payload.ok, true);
  assert.equal(channelMessage.platform, 'feishu');
  assert.equal(channelMessage.channel_type, 'dm');
  assert.equal(channelMessage.conversation_id, 'oc-home');
  assert.equal(channelMessage.sender_id, 'ou-home');
  assert.equal(channelMessage.route_hint, 'scheduled_ai_daily_digest');
  assert.match(channelMessage.text, /今日 AI 事实材料/);
  assert.match(channelMessage.text, /标题、来源、正文/);
  assert.match(channelMessage.text, /50-200/);
  assert.match(channelMessage.text, /报道式自然段/);
  assert.match(channelMessage.text, /不要使用“看点\/意义\/适合\/今日信号”/);
  assert.doesNotMatch(channelMessage.text, /\{facts\}/);
  assert.doesNotMatch(channelMessage.text, /发生了什么 \+ 为什么值得看/);
  assert.equal(calls[0].bin, 'lark-cli');
  assert.equal(calls[0].args.includes('--user-id'), true);
  assert.equal(calls[0].args.includes('ou-home'), true);
});

test('handleOutboundRequest drops checkin when proactive delivery is disabled', async () => {
  process.env.PERSONAL_AGENT_PROACTIVE_ENABLED = 'false';
  let sendCalled = false;
  const result = await handleOutboundRequest({
    bot: {
      async sendMessage() {
        sendCalled = true;
      },
    },
    logger: {
      info() {},
      warn() {},
      error() {},
    },
    method: 'POST',
    url: '/outbound/send',
    bodyText: JSON.stringify({ text: '你刚提到下午要改论文提纲，进展到哪一步了？' }),
  });

  assert.equal(result.status, 200);
  assert.equal(result.payload.ok, true);
  assert.equal(result.payload.dropped, true);
  assert.equal(result.payload.reason, 'proactive_delivery_disabled');
  assert.equal(sendCalled, false);
});

test('handleOutboundRequest forwards structured media payloads through bot', async () => {
  let sentPayload = null;
  const result = await handleOutboundRequest({
    bot: {
      async sendMessage(payload) {
        sentPayload = payload;
      },
    },
    logger: {
      info() {},
      error() {},
    },
    method: 'POST',
    url: '/outbound/send',
    bodyText: JSON.stringify({
      text: '图来了',
      media: {
        type: 'image',
        url: 'https://example.com/out.png',
      },
      force: true,
    }),
  });

  assert.equal(result.status, 200);
  assert.equal(result.payload.ok, true);
  assert.deepEqual(sentPayload, {
    text: '图来了',
    media: {
      type: 'image',
      url: 'https://example.com/out.png',
    },
  });
});

test('handleOutboundRequest forwards audio media payloads through bot', async () => {
  let sentPayload = null;
  const result = await handleOutboundRequest({
    bot: {
      async sendMessage(payload) {
        sentPayload = payload;
      },
    },
    logger: {
      info() {},
      error() {},
    },
    method: 'POST',
    url: '/outbound/send',
    bodyText: JSON.stringify({
      text: '语音来了',
      media: {
        type: 'audio',
        url: '/tmp/reply.wav',
      },
      force: true,
    }),
  });

  assert.equal(result.status, 200);
  assert.equal(result.payload.ok, true);
  assert.deepEqual(sentPayload, {
    text: '语音来了',
    media: {
      type: 'audio',
      url: '/tmp/reply.wav',
    },
  });
});

test('handleOutboundRequest splits paragraph-delimited proactive text into sequential sends', async () => {
  const stateBaseDir = path.join(PROJECT_ROOT, '.ran_agent_state');
  fs.mkdirSync(stateBaseDir, { recursive: true });
  const tempStateDir = fs.mkdtempSync(path.join(stateBaseDir, 'node-bridge-outbound-'));
  const previousDelay = process.env.NODE_BRIDGE_OUTBOUND_SEGMENT_DELAY_MS;
  const previousStateDir = process.env.RAN_AGENT_STATE_DIR;
  process.env.NODE_BRIDGE_OUTBOUND_SEGMENT_DELAY_MS = '0';
  process.env.RAN_AGENT_STATE_DIR = tempStateDir;

  try {
    const sentPayloads = [];
    const result = await handleOutboundRequest({
      bot: {
        async sendMessage(payload) {
          sentPayloads.push(payload);
        },
      },
      logger: {
        info() {},
        error() {},
      },
      method: 'POST',
      url: '/outbound/send',
      bodyText: JSON.stringify({
        text: '第一段\n\n第二段\n\n第三段',
        force: true,
      }),
    });

    assert.equal(result.status, 200);
    assert.equal(result.payload.ok, true);
    assert.deepEqual(sentPayloads, ['第一段', '第二段', '第三段']);
  } finally {
    if (previousDelay === undefined) {
      delete process.env.NODE_BRIDGE_OUTBOUND_SEGMENT_DELAY_MS;
    } else {
      process.env.NODE_BRIDGE_OUTBOUND_SEGMENT_DELAY_MS = previousDelay;
    }
    if (previousStateDir === undefined) {
      delete process.env.RAN_AGENT_STATE_DIR;
    } else {
      process.env.RAN_AGENT_STATE_DIR = previousStateDir;
    }
  }
});

test('handleOutboundRequest queues failed outbound message instead of returning 500', async () => {
  const result = await handleOutboundRequest({
    bot: {
      async sendMessage() {
        throw new Error('context expired');
      },
    },
    logger: {
      info() {},
      error() {},
    },
    method: 'POST',
    url: '/outbound/send',
    bodyText: JSON.stringify({ text: '你说今晚要早睡，我晚点再提醒你收尾。' }),
  });

  assert.equal(result.status, 200);
  assert.equal(result.payload.ok, true);
  assert.equal(result.payload.queued, true);
});

test('handleOutboundRequest drops low-value proactive text', async () => {
  let sendCalled = false;
  const result = await handleOutboundRequest({
    bot: {
      async sendMessage() {
        sendCalled = true;
      },
    },
    logger: {
      info() {},
      warn() {},
      error() {},
    },
    method: 'POST',
    url: '/outbound/send',
    bodyText: JSON.stringify({ text: '刚想到你最近挺忙的，今天还顺吗。' }),
  });

  assert.equal(result.status, 200);
  assert.equal(result.payload.ok, true);
  assert.equal(result.payload.dropped, true);
  assert.equal(result.payload.reason, 'low_value_proactive_text');
  assert.equal(sendCalled, false);
});

test('handleOutboundRequest lets reminders bypass checkin cooldown', async () => {
  const env = {
    RAN_AGENT_STATE_DIR: path.join(PROJECT_ROOT, '.ran_agent_state', 'test-outbound-server'),
  };
  const previousStateDir = process.env.RAN_AGENT_STATE_DIR;
  const previousReminderDelivery = process.env.PERSONAL_AGENT_REMINDER_DELIVERY_ENABLED;
  process.env.RAN_AGENT_STATE_DIR = env.RAN_AGENT_STATE_DIR;
  process.env.PERSONAL_AGENT_REMINDER_DELIVERY_ENABLED = 'true';
  setProactiveDispatchState({ nextAllowedAt: '2999-01-01T00:00:00.000Z' }, env);

  try {
    let sentText = '';
    const result = await handleOutboundRequest({
      bot: {
        async sendMessage(text) {
          sentText = text;
        },
      },
      logger: {
        info() {},
        error() {},
      },
      method: 'POST',
      url: '/outbound/send',
      bodyText: JSON.stringify({ text: '提醒一下：去单位', kind: 'reminder' }),
    });

    assert.equal(result.status, 200);
    assert.equal(result.payload.ok, true);
    assert.equal(result.payload.queued, undefined);
    assert.equal(sentText, '提醒一下：去单位');
  } finally {
    if (previousStateDir === undefined) {
      delete process.env.RAN_AGENT_STATE_DIR;
    } else {
      process.env.RAN_AGENT_STATE_DIR = previousStateDir;
    }
    if (previousReminderDelivery === undefined) {
      delete process.env.PERSONAL_AGENT_REMINDER_DELIVERY_ENABLED;
    } else {
      process.env.PERSONAL_AGENT_REMINDER_DELIVERY_ENABLED = previousReminderDelivery;
    }
  }
});

test('handleOutboundRequest drops reminder messages when reminder delivery is disabled', async () => {
  const previousReminderDelivery = process.env.PERSONAL_AGENT_REMINDER_DELIVERY_ENABLED;
  process.env.PERSONAL_AGENT_REMINDER_DELIVERY_ENABLED = 'false';

  try {
    let sendCalled = false;
    const result = await handleOutboundRequest({
      bot: {
        async sendMessage() {
          sendCalled = true;
        },
      },
      logger: {
        info() {},
        warn() {},
        error() {},
      },
      method: 'POST',
      url: '/outbound/send',
      bodyText: JSON.stringify({ text: '提醒一下：去单位', kind: 'reminder' }),
    });

    assert.equal(result.status, 200);
    assert.equal(result.payload.ok, true);
    assert.equal(result.payload.dropped, true);
    assert.equal(result.payload.reason, 'reminder_delivery_disabled');
    assert.equal(sendCalled, false);
  } finally {
    if (previousReminderDelivery === undefined) {
      delete process.env.PERSONAL_AGENT_REMINDER_DELIVERY_ENABLED;
    } else {
      process.env.PERSONAL_AGENT_REMINDER_DELIVERY_ENABLED = previousReminderDelivery;
    }
  }
});

test('handleOutboundRequest drops pending reminder-like messages when reminder delivery is disabled', async () => {
  const stateBaseDir = path.join(PROJECT_ROOT, '.ran_agent_state');
  fs.mkdirSync(stateBaseDir, { recursive: true });
  const tempStateDir = fs.mkdtempSync(path.join(stateBaseDir, 'node-bridge-outbound-'));
  const previousStateDir = process.env.RAN_AGENT_STATE_DIR;
  const previousReminderDelivery = process.env.PERSONAL_AGENT_REMINDER_DELIVERY_ENABLED;
  process.env.RAN_AGENT_STATE_DIR = tempStateDir;
  process.env.PERSONAL_AGENT_REMINDER_DELIVERY_ENABLED = 'false';
  appendPendingOutboundMessage({ text: '提醒一下：交房租', reason: 'send_failed:context expired' }, process.env);

  try {
    const sentPayloads = [];
    const result = await handleOutboundRequest({
      bot: {
        async sendMessage(payload) {
          sentPayloads.push(payload);
        },
      },
      logger: {
        info() {},
        warn() {},
        error() {},
      },
      method: 'POST',
      url: '/outbound/send',
      bodyText: JSON.stringify({ text: '普通主动消息', force: true }),
    });

    assert.equal(result.status, 200);
    assert.equal(result.payload.ok, true);
    assert.deepEqual(sentPayloads, ['普通主动消息']);
    assert.deepEqual(drainPendingOutboundMessages(10, process.env), []);
  } finally {
    if (previousStateDir === undefined) {
      delete process.env.RAN_AGENT_STATE_DIR;
    } else {
      process.env.RAN_AGENT_STATE_DIR = previousStateDir;
    }
    if (previousReminderDelivery === undefined) {
      delete process.env.PERSONAL_AGENT_REMINDER_DELIVERY_ENABLED;
    } else {
      process.env.PERSONAL_AGENT_REMINDER_DELIVERY_ENABLED = previousReminderDelivery;
    }
  }
});

test('handleOutboundRequest requeues blocked proactive messages with a retry delay', async () => {
  const stateBaseDir = path.join(PROJECT_ROOT, '.ran_agent_state');
  fs.mkdirSync(stateBaseDir, { recursive: true });
  const tempStateDir = fs.mkdtempSync(path.join(stateBaseDir, 'node-bridge-outbound-'));
  const env = {
    RAN_AGENT_STATE_DIR: tempStateDir,
    NODE_BRIDGE_OUTBOUND_RETRY_DELAY_MS: '1000',
  };
  const previousStateDir = process.env.RAN_AGENT_STATE_DIR;
  const previousRetryDelay = process.env.NODE_BRIDGE_OUTBOUND_RETRY_DELAY_MS;
  process.env.RAN_AGENT_STATE_DIR = env.RAN_AGENT_STATE_DIR;
  process.env.NODE_BRIDGE_OUTBOUND_RETRY_DELAY_MS = env.NODE_BRIDGE_OUTBOUND_RETRY_DELAY_MS;
  setProactiveDispatchState({ nextAllowedAt: '2999-01-01T00:00:00.000Z' }, env);

  try {
    const result = await handleOutboundRequest({
      bot: {
        async sendMessage() {
          throw new Error('should not send while cooldown is active');
        },
      },
      logger: {
        info() {},
        error() {},
      },
      method: 'POST',
      url: '/outbound/send',
      bodyText: JSON.stringify({ text: '稍后再提醒我一次' }),
    });

    assert.equal(result.status, 200);
    assert.equal(result.payload.queued, true);
    assert.equal(result.payload.reason, 'checkin_cooldown_not_reached');

    const earlyDrain = drainPendingOutboundMessages(10, env, Date.parse('2000-01-01T00:00:00.000Z'));
    assert.equal(earlyDrain.length, 0);

    const lateDrain = drainPendingOutboundMessages(10, env, Date.parse('3000-01-01T00:00:00.000Z'));
    assert.equal(lateDrain.length, 1);
    assert.equal(lateDrain[0].text, '稍后再提醒我一次');
    assert.match(lateDrain[0].nextAttemptAt, /T/);
  } finally {
    if (previousStateDir === undefined) {
      delete process.env.RAN_AGENT_STATE_DIR;
    } else {
      process.env.RAN_AGENT_STATE_DIR = previousStateDir;
    }
    if (previousRetryDelay === undefined) {
      delete process.env.NODE_BRIDGE_OUTBOUND_RETRY_DELAY_MS;
    } else {
      process.env.NODE_BRIDGE_OUTBOUND_RETRY_DELAY_MS = previousRetryDelay;
    }
  }
});

test('resolveStateDir defaults to project-local state directory', () => {
  const resolved = resolveStateDir({});
  assert.equal(resolved, path.join(PROJECT_ROOT, '.ran_agent_state'));
});

test('resolveStateDir rejects paths outside project workspace', () => {
  assert.throws(
    () => resolveStateDir({ RAN_AGENT_STATE_DIR: path.dirname(PROJECT_ROOT) }),
    /must stay inside project workspace/
  );
});
