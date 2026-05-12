import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { getOutboundServerConfig, handleOutboundRequest, resolveStateDir } from '../src/outboundServer.mjs';
import {
  appendPendingOutboundMessage,
  drainPendingOutboundMessages,
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
  const stateBaseDir = path.join(PROJECT_ROOT, '.openclaw_state');
  fs.mkdirSync(stateBaseDir, { recursive: true });
  const tempStateDir = fs.mkdtempSync(path.join(stateBaseDir, 'node-bridge-outbound-'));
  const previousDelay = process.env.NODE_BRIDGE_OUTBOUND_SEGMENT_DELAY_MS;
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.NODE_BRIDGE_OUTBOUND_SEGMENT_DELAY_MS = '0';
  process.env.OPENCLAW_STATE_DIR = tempStateDir;

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
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
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
    OPENCLAW_STATE_DIR: path.join(PROJECT_ROOT, '.openclaw_state', 'test-outbound-server'),
  };
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  const previousReminderDelivery = process.env.PERSONAL_AGENT_REMINDER_DELIVERY_ENABLED;
  process.env.OPENCLAW_STATE_DIR = env.OPENCLAW_STATE_DIR;
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
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
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
  const stateBaseDir = path.join(PROJECT_ROOT, '.openclaw_state');
  fs.mkdirSync(stateBaseDir, { recursive: true });
  const tempStateDir = fs.mkdtempSync(path.join(stateBaseDir, 'node-bridge-outbound-'));
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  const previousReminderDelivery = process.env.PERSONAL_AGENT_REMINDER_DELIVERY_ENABLED;
  process.env.OPENCLAW_STATE_DIR = tempStateDir;
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
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    if (previousReminderDelivery === undefined) {
      delete process.env.PERSONAL_AGENT_REMINDER_DELIVERY_ENABLED;
    } else {
      process.env.PERSONAL_AGENT_REMINDER_DELIVERY_ENABLED = previousReminderDelivery;
    }
  }
});

test('handleOutboundRequest requeues blocked proactive messages with a retry delay', async () => {
  const stateBaseDir = path.join(PROJECT_ROOT, '.openclaw_state');
  fs.mkdirSync(stateBaseDir, { recursive: true });
  const tempStateDir = fs.mkdtempSync(path.join(stateBaseDir, 'node-bridge-outbound-'));
  const env = {
    OPENCLAW_STATE_DIR: tempStateDir,
    NODE_BRIDGE_OUTBOUND_RETRY_DELAY_MS: '1000',
  };
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  const previousRetryDelay = process.env.NODE_BRIDGE_OUTBOUND_RETRY_DELAY_MS;
  process.env.OPENCLAW_STATE_DIR = env.OPENCLAW_STATE_DIR;
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
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
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
  assert.equal(resolved, path.join(PROJECT_ROOT, '.openclaw_state'));
});

test('resolveStateDir rejects paths outside project workspace', () => {
  assert.throws(
    () => resolveStateDir({ OPENCLAW_STATE_DIR: path.dirname(PROJECT_ROOT) }),
    /must stay inside project workspace/
  );
});
