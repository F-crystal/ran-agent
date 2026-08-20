import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { ProxyAgent } from 'undici';

import {
  createTelegramOffsetStore,
  createTelegramSendAdapter,
  getTelegramConfig,
  normalizeTelegramUpdate,
  startTelegramBridge,
} from '../src/telegramBridge.mjs';
import { handleIncomingMessage } from '../src/channelHub.mjs';
import { createDurableOutbox } from '../src/durableOutbox.mjs';
import { bootstrapOwnerBinding, shortHash } from '../src/identityMap.mjs';
import { createIsolatedTestEnv } from './helpers/isolatedState.mjs';

function response(result) {
  return { ok: true, status: 200, async json() { return { ok: true, result }; } };
}

const baseEnv = {
  TELEGRAM_BOT_TOKEN: '123456:unit-test-token',
  TELEGRAM_OWNER_USER_ID: '100',
  TELEGRAM_OWNER_CHAT_ID: '100',
};

function telegramResponse(result, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return { ok: true, result }; } };
}

function ownerUpdate(updateId = 7) {
  return {
    update_id: updateId,
    message: {
      message_id: 11,
      date: 1_750_000_000,
      from: { id: 100, is_bot: false },
      chat: { id: 100, type: 'private' },
      text: 'hello from owner',
    },
  };
}

function waitFor(predicate, timeoutMs = 1000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('test condition timed out'));
      setTimeout(check, 5);
    };
    check();
  });
}

test('Telegram transport exceptions are stable and redact raw token and URL', async () => {
  const fakeToken = '999999:fake-token-for-transport-test';
  const fakeUrl = 'https://api.telegram.org/bot999999:fake-token-for-transport-test/sendMessage';
  const adapter = createTelegramSendAdapter({
    env: { ...baseEnv, TELEGRAM_BOT_TOKEN: fakeToken },
    fetchImpl: async () => {
      throw new Error(`socket failed for ${fakeUrl} using ${fakeToken}`);
    },
  });

  await assert.rejects(
    adapter.sendReply({ target: { conversation_id: '100' }, text: 'redaction test' }),
    (error) => {
      assert.equal(error.code, 'TELEGRAM_TRANSPORT_FAILED');
      assert.equal(error.message, 'Telegram transport request failed');
      assert.doesNotMatch(error.stack || '', /999999:fake-token-for-transport-test/);
      assert.doesNotMatch(error.stack || '', /api\.telegram\.org/);
      assert.equal(Object.hasOwn(error, 'cause'), false);
      return true;
    },
  );
});

test('Telegram slow but healthy send remains sent within the normal API deadline', async () => {
  const adapter = createTelegramSendAdapter({
    env: baseEnv,
    fetchImpl: async (url, options = {}) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(response({ message_id: 17 })), 300);
      options.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(options.signal.reason);
      }, { once: true });
    }),
  });
  const result = await adapter.sendReply({ target: { conversation_id: '100' }, text: 'slow but healthy' });
  assert.equal(result.textStatus, 'sent');
  assert.match(result.adapterReceiptRef, /^telegram:message:[a-f0-9]{16}$/);
});

test('Telegram webhook preflight carries a bounded lifecycle signal', async (t) => {
  const isolated = createIsolatedTestEnv(t, {}, 'telegram-webhook-signal-');
  const env = {
    ...isolated,
    ...baseEnv,
    TELEGRAM_BRIDGE_ENABLED: 'true',
    RAN_AGENT_IDENTITY_MAP_PATH: path.join(isolated.RAN_AGENT_STATE_DIR, 'identity-map.json'),
  };
  bootstrapOwnerBinding({
    trustedIdentity: { platform: 'telegram', senderId: '100', globalUserId: 'user:ran', provenance: 'telegram_owner_challenge' },
    env,
    now: '2026-08-20T00:00:00.000Z',
  });
  let preflightSignal;
  const fetchImpl = async (url, options = {}) => {
    const method = String(url).split('/').pop();
    if (method === 'getWebhookInfo') {
      preflightSignal = options.signal;
      return telegramResponse({ url: '' });
    }
    if (method === 'getUpdates') {
      return new Promise((resolve, reject) => {
        options.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    }
    throw new Error('unexpected Telegram method');
  };
  const bridge = await startTelegramBridge({ env, fetchImpl, logger: { info() {}, warn() {}, error() {} } });
  try {
    assert.ok(preflightSignal instanceof AbortSignal);
    assert.equal(typeof preflightSignal.addEventListener, 'function');
    assert.equal(preflightSignal.aborted, false);
  } finally {
    await bridge.stop();
  }
});

test('Telegram polling backoff resets only after a whole update batch succeeds', async (t) => {
  const isolated = createIsolatedTestEnv(t, {}, 'telegram-batch-backoff-');
  const env = {
    ...isolated,
    ...baseEnv,
    TELEGRAM_BRIDGE_ENABLED: 'true',
    RAN_AGENT_IDENTITY_MAP_PATH: path.join(isolated.RAN_AGENT_STATE_DIR, 'identity-map.json'),
  };
  bootstrapOwnerBinding({
    trustedIdentity: { platform: 'telegram', senderId: '100', globalUserId: 'user:ran', provenance: 'telegram_owner_challenge' },
    env,
    now: '2026-08-20T00:00:00.000Z',
  });
  const delays = [];
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, milliseconds, ...args) => {
    if (milliseconds >= 1000) {
      delays.push(milliseconds);
      return originalSetTimeout(callback, 0, ...args);
    }
    return originalSetTimeout(callback, milliseconds, ...args);
  };
  let bridge;
  try {
    bridge = await startTelegramBridge({
      env,
      fetchImpl: async (url) => String(url).endsWith('/getWebhookInfo')
        ? telegramResponse({ url: '' })
        : telegramResponse([ownerUpdate(17)]),
      channelHub: async () => { throw new Error('handler failed'); },
      logger: { info() {}, warn() {}, error() {} },
    });
    await waitFor(() => delays.length >= 2);
  } finally {
    await bridge?.stop();
    globalThis.setTimeout = originalSetTimeout;
  }
  assert.deepEqual(delays.slice(0, 2), [1000, 2000]);
});

test('Telegram stop aborts a hung send within 500ms and preserves ambiguous terminal state', async (t) => {
  const isolated = createIsolatedTestEnv(t, {}, 'telegram-hung-send-');
  const env = {
    ...isolated,
    ...baseEnv,
    TELEGRAM_BRIDGE_ENABLED: 'true',
    RAN_AGENT_IDENTITY_MAP_PATH: path.join(isolated.RAN_AGENT_STATE_DIR, 'identity-map.json'),
    RAN_AGENT_GLOBAL_TIMELINE_PATH: path.join(isolated.RAN_AGENT_STATE_DIR, 'timeline.jsonl'),
  };
  bootstrapOwnerBinding({
    trustedIdentity: { platform: 'telegram', senderId: '100', globalUserId: 'user:ran', provenance: 'telegram_owner_challenge' },
    env,
    now: '2026-08-20T00:00:00.000Z',
  });
  const outbox = createDurableOutbox({ env });
  let sendStarted = false;
  let releaseSend;
  const fetchImpl = async (url, options = {}) => {
    const method = String(url).split('/').pop();
    if (method === 'getWebhookInfo') return telegramResponse({ url: '' });
    if (method === 'getUpdates') return telegramResponse([ownerUpdate(18)]);
    if (method === 'sendMessage') {
      sendStarted = true;
      return new Promise((resolve, reject) => {
        releaseSend = () => reject(new Error('released hung send'));
        options.signal?.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
    }
    throw new Error('unexpected Telegram method');
  };
  const channelHub = (message, options) => handleIncomingMessage(message, {
    ...options,
    replyBackend: { async getReply() { return { replyText: 'hung reply', followUpMessages: [], media: null }; } },
  });
  const bridge = await startTelegramBridge({ env, outbox, fetchImpl, channelHub, logger: { info() {}, warn() {}, error() {} } });
  await waitFor(() => sendStarted);
  const stopStarted = Date.now();
  const stopPromise = bridge.stop();
  const stopped = await Promise.race([
    stopPromise.then(() => true, () => false),
    new Promise((resolve) => setTimeout(() => resolve(false), 500)),
  ]);
  if (!stopped) releaseSend?.();
  await stopPromise.catch(() => {});
  assert.equal(stopped, true);
  assert.ok(Date.now() - stopStarted < 500);
  assert.equal(outbox.list()[0]?.delivery, 'ambiguous');
});

test('Telegram proxy is opt-in and never inherits global proxy variables', () => {
  const config = getTelegramConfig({
    ...baseEnv,
    TELEGRAM_PROXY_URL: 'http://127.0.0.1:18888',
    HTTPS_PROXY: 'http://global-proxy.invalid:1',
    HTTP_PROXY: 'http://global-proxy.invalid:1',
    ALL_PROXY: 'socks5://global-proxy.invalid:1',
  });
  assert.equal(config.proxyUrl, 'http://127.0.0.1:18888');
  assert.equal(Boolean(config.proxyUrl), true);
  const direct = getTelegramConfig({ ...baseEnv, HTTPS_PROXY: 'http://global-proxy.invalid:1' });
  assert.equal(direct.proxyUrl, '');
  assert.equal(Boolean(direct.proxyUrl), false);
  const fixed = getTelegramConfig({ ...baseEnv, TELEGRAM_API_BASE_URL: 'https://attacker.invalid' });
  assert.equal(Object.hasOwn(fixed, 'baseUrl'), false);
  assert.equal(fixed.offsetPath.endsWith('/telegram/update-offset.json'), true);
});

test('Telegram update normalization is owner-private-text only and rejects foreign/group/bot/media input', () => {
  const config = getTelegramConfig(baseEnv);
  const identityResolver = () => ({ bindingVersion: 2, platform: 'telegram', owner: true });
  const normalizedOwner = normalizeTelegramUpdate(ownerUpdate(), { config, identityResolver });
  assert.equal(normalizedOwner.ok, true);
  assert.equal(Object.hasOwn(normalizedOwner.message, 'message_id'), false);
  assert.equal(normalizedOwner.message.id, `telegram:${shortHash(7)}`);
  const rejected = [
    { message: { ...ownerUpdate().message, from: { id: 101, is_bot: false } } },
    { message: { ...ownerUpdate().message, chat: { id: 100, type: 'group' } } },
    { message: { ...ownerUpdate().message, from: { id: 100, is_bot: true } } },
    { message: { ...ownerUpdate().message, from: { id: 100 } } },
    { message: { ...ownerUpdate().message, photo: [{ file_id: 'media' }] } },
    { message: { ...ownerUpdate().message, text: '' } },
    { ...ownerUpdate(), update_id: -1 },
    { ...ownerUpdate(), message: { ...ownerUpdate().message, message_id: 0 } },
    { ...ownerUpdate(), message: { ...ownerUpdate().message, date: 0 } },
    { ...ownerUpdate(), message: { ...ownerUpdate().message, date: 'not-a-timestamp' } },
    { update_id: 7 },
  ];
  for (const update of rejected) assert.equal(normalizeTelegramUpdate(update, { config, identityResolver }).ok, false);
});

test('disabled Telegram bridge is inert and does not create a dispatcher or access the network', async () => {
  let calls = 0;
  const bridge = await startTelegramBridge({
    env: { ...baseEnv, TELEGRAM_BRIDGE_ENABLED: 'false', TELEGRAM_PROXY_URL: 'http://proxy.invalid:1' },
    fetchImpl: async () => { calls += 1; throw new Error('network must not be reached'); },
  });
  assert.equal(bridge.enabled, false);
  await bridge.stop();
  assert.equal(calls, 0);
});

test('missing Telegram identity-map binding fails before dispatcher or network', async (t) => {
  const isolated = createIsolatedTestEnv(t, {}, 'telegram-missing-identity-');
  let calls = 0;
  await assert.rejects(
    startTelegramBridge({
      env: {
        ...isolated,
        ...baseEnv,
        TELEGRAM_BRIDGE_ENABLED: 'true',
        TELEGRAM_PROXY_URL: 'http://proxy.invalid:18888',
        RAN_AGENT_IDENTITY_MAP_PATH: path.join(isolated.RAN_AGENT_STATE_DIR, 'identity-map.json'),
      },
      fetchImpl: async () => { calls += 1; throw new Error('network must not be reached'); },
    }),
    (error) => error?.code === 'TELEGRAM_OWNER_IDENTITY_REQUIRED',
  );
  assert.equal(calls, 0);
});

test('Telegram bridge preflights webhook, polls once, atomically advances offset, and replay sends once', async (t) => {
  const isolated = createIsolatedTestEnv(t, {}, 'telegram-bridge-loop-');
  const env = {
    ...isolated,
    ...baseEnv,
    TELEGRAM_BRIDGE_ENABLED: 'true',
    RAN_AGENT_IDENTITY_MAP_PATH: path.join(isolated.RAN_AGENT_STATE_DIR, 'identity-map.json'),
    RAN_AGENT_GLOBAL_TIMELINE_PATH: path.join(isolated.RAN_AGENT_STATE_DIR, 'timeline.jsonl'),
  };
  bootstrapOwnerBinding({
    trustedIdentity: { platform: 'telegram', senderId: '100', globalUserId: 'user:ran', provenance: 'telegram_owner_challenge' },
    env,
    now: '2026-08-20T00:00:00.000Z',
  });
  const outbox = createDurableOutbox({ env });
  let pollCalls = 0;
  let activePolls = 0;
  let maxActivePolls = 0;
  let sends = 0;
  let processed = 0;
  const fetchImpl = async (url, options = {}) => {
    const method = String(url).split('/').pop();
    if (method === 'getWebhookInfo') return telegramResponse({ url: '' });
    if (method === 'getUpdates') {
      pollCalls += 1;
      activePolls += 1;
      maxActivePolls = Math.max(maxActivePolls, activePolls);
      if (pollCalls === 1 || pollCalls === 3) {
        activePolls -= 1;
        return telegramResponse([ownerUpdate()]);
      }
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          activePolls -= 1;
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    }
    if (method === 'sendMessage') {
      sends += 1;
      return telegramResponse({ message_id: 99 });
    }
    throw new Error('unexpected Telegram method');
  };
  const channelHub = (message, options) => {
    processed += 1;
    return handleIncomingMessage(message, {
      ...options,
      replyBackend: { async getReply() { return { replyText: 'telegram reply', followUpMessages: [], media: null }; } },
    });
  };
  const bridge = await startTelegramBridge({ env, outbox, fetchImpl, channelHub, logger: { info() {}, warn() {}, error() {} } });
  await waitFor(() => outbox.list().length === 1);
  assert.equal(outbox.list()[0].delivery, 'sent');
  assert.equal(outbox.list()[0].platform, 'telegram');
  assert.equal(sends, 1);
  assert.equal(maxActivePolls, 1);
  assert.equal(createTelegramOffsetStore({ offsetPath: path.join(isolated.RAN_AGENT_STATE_DIR, 'telegram', 'update-offset.json') }).get(), 8);
  await bridge.stop();

  const replay = await startTelegramBridge({ env, outbox, fetchImpl, channelHub, logger: { info() {}, warn() {}, error() {} } });
  await waitFor(() => processed === 2);
  assert.equal(processed, 2);
  assert.equal(sends, 1);
  await replay.stop();
});

test('Telegram transport exception becomes ambiguous outbox terminal and replay does not resend', async (t) => {
  const isolated = createIsolatedTestEnv(t, {}, 'telegram-bridge-ambiguous-');
  const env = {
    ...isolated,
    ...baseEnv,
    TELEGRAM_BRIDGE_ENABLED: 'true',
    RAN_AGENT_IDENTITY_MAP_PATH: path.join(isolated.RAN_AGENT_STATE_DIR, 'identity-map.json'),
    RAN_AGENT_GLOBAL_TIMELINE_PATH: path.join(isolated.RAN_AGENT_STATE_DIR, 'timeline.jsonl'),
  };
  bootstrapOwnerBinding({
    trustedIdentity: { platform: 'telegram', senderId: '100', globalUserId: 'user:ran', provenance: 'telegram_owner_challenge' },
    env,
    now: '2026-08-20T00:00:00.000Z',
  });
  const outbox = createDurableOutbox({ env });
  let pollCalls = 0;
  let sends = 0;
  const fetchImpl = async (url, options = {}) => {
    const method = String(url).split('/').pop();
    if (method === 'getWebhookInfo') return telegramResponse({ url: '' });
    if (method === 'getUpdates') {
      pollCalls += 1;
      if (pollCalls === 1) return telegramResponse([ownerUpdate(8)]);
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    }
    sends += 1;
    throw new Error('Telegram socket closed after request');
  };
  const channelHub = (message, options) => handleIncomingMessage(message, {
    ...options,
    replyBackend: { async getReply() { return { replyText: 'reply before transport uncertainty', followUpMessages: [], media: null }; } },
  });
  const bridge = await startTelegramBridge({ env, outbox, fetchImpl, channelHub, logger: { info() {}, warn() {}, error() {} } });
  await waitFor(() => outbox.list().length === 1);
  assert.equal(outbox.list()[0].delivery, 'ambiguous');
  assert.equal(sends, 1);
  await bridge.stop();

  const replayAdapter = createTelegramSendAdapter({ env, fetchImpl });
  await assert.rejects(
    handleIncomingMessage({
      id: `telegram:${shortHash(8)}`, platform: 'telegram', channel_type: 'dm', conversation_id: '100', sender_id: '100', text: 'hello from owner', created_at: 1_750_000_000_000,
    }, {
      env, outbox, adapter: replayAdapter, logger: { log() {}, warn() {}, error() {}, info() {} },
      replyBackend: { async getReply() { return { replyText: 'reply before transport uncertainty', followUpMessages: [], media: null }; } },
    }),
    /safe to resend|ambiguous/i,
  );
  assert.equal(sends, 1);
});

test('configured Telegram webhook fails closed before getUpdates', async () => {
  let updates = 0;
  await assert.rejects(
    startTelegramBridge({
      env: { ...baseEnv, TELEGRAM_BRIDGE_ENABLED: 'true' },
      identityResolver: () => ({ bindingVersion: 2, platform: 'telegram', owner: true, globalUserId: 'user:ran' }),
      fetchImpl: async (url) => String(url).endsWith('/getWebhookInfo')
        ? telegramResponse({ url: 'https://webhook.invalid' })
        : (updates += 1, telegramResponse([])),
    }),
    (error) => error?.code === 'TELEGRAM_WEBHOOK_CONFIGURED',
  );
  assert.equal(updates, 0);
});

test('Telegram adapter injects only its local dispatcher and returns typed success', async () => {
  let request;
  const adapter = createTelegramSendAdapter({
    env: { ...baseEnv, TELEGRAM_PROXY_URL: 'http://proxy.invalid:18888' },
    dispatcher: new ProxyAgent('http://proxy.invalid:18888'),
    fetchImpl: async (url, options) => {
      request = { url, options };
      return response({ message_id: 7 });
    },
  });
  const result = await adapter.sendReply({ target: { conversation_id: '100' }, text: 'hello' });
  assert.equal(result.textStatus, 'sent');
  assert.match(result.adapterReceiptRef, /^telegram:message:[a-f0-9]{16}$/);
  assert.notEqual(result.adapterReceiptRef, 'telegram:message:7');
  assert.equal(request.options.dispatcher?.constructor?.name, 'ProxyAgent');
  assert.equal(Object.hasOwn(request.options, 'agent'), false);
  await request.options.dispatcher.close();
});

test('Telegram retry_after seconds become bounded millisecond backoff', async (t) => {
  const isolated = createIsolatedTestEnv(t, {}, 'telegram-retry-after-');
  const env = {
    ...isolated,
    ...baseEnv,
    TELEGRAM_BRIDGE_ENABLED: 'true',
    RAN_AGENT_IDENTITY_MAP_PATH: path.join(isolated.RAN_AGENT_STATE_DIR, 'identity-map.json'),
  };
  bootstrapOwnerBinding({
    trustedIdentity: { platform: 'telegram', senderId: '100', globalUserId: 'user:ran', provenance: 'telegram_owner_challenge' },
    env,
    now: '2026-08-20T00:00:00.000Z',
  });
  let observedDelay;
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, milliseconds, ...args) => {
    if (milliseconds === 30_000) observedDelay = milliseconds;
    return originalSetTimeout(callback, milliseconds === 30_000 ? 0 : milliseconds, ...args);
  };
  let bridge;
  try {
    bridge = await startTelegramBridge({
      env,
      fetchImpl: async (url) => String(url).endsWith('/getWebhookInfo')
        ? telegramResponse({ url: '' })
        : { ok: false, status: 429, async json() { return { ok: false, parameters: { retry_after: 30 } }; } },
      logger: { info() {}, warn() {}, error() {} },
    });
    await waitFor(() => observedDelay === 30_000);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    await bridge?.stop();
  }
  assert.equal(observedDelay, 30_000);
});

test('Telegram proxy configuration cannot silently degrade to direct transport without its local dispatcher', () => {
  assert.throws(
    () => createTelegramSendAdapter({ env: { ...baseEnv, TELEGRAM_PROXY_URL: 'http://proxy.invalid:18888' } }),
    (error) => error?.code === 'TELEGRAM_PROXY_DISPATCHER_REQUIRED',
  );
});

test('Telegram without proxy stays direct and proxy transport failure is explicit', async () => {
  let directRequest;
  const direct = createTelegramSendAdapter({
    env: baseEnv,
    fetchImpl: async (url, options) => {
      directRequest = { url, options };
      return response({ message_id: 8 });
    },
  });
  assert.equal((await direct.sendReply({ target: { conversation_id: '100' }, text: 'direct' })).textStatus, 'sent');
  assert.equal(Object.hasOwn(directRequest.options, 'dispatcher'), false);

  let calls = 0;
  const proxied = createTelegramSendAdapter({
    env: { ...baseEnv, TELEGRAM_PROXY_URL: 'http://proxy.invalid:18888' },
    dispatcher: { marker: 'telegram-only' },
    fetchImpl: async () => {
      calls += 1;
      throw new Error('connect failed');
    },
  });
  await assert.rejects(proxied.sendReply({ target: { conversation_id: '100' }, text: 'fails' }), (error) => {
    assert.equal(error.code, 'TELEGRAM_PROXY_UNREACHABLE');
    assert.doesNotMatch(error.message, /proxy\.invalid|18888/);
    return true;
  });
  assert.equal(calls, 1);
});
