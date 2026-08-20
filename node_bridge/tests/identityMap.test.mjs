import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';

import {
  getAccountBindingKey,
  getGlobalUserId,
  getHermesSessionId,
  getHermesSessionKey,
  deriveTrustedActorContext,
  getIdentityBinding,
  getStableConversationKey,
  bootstrapOwnerBinding,
  validateOwnerBindingPreflight,
  shortHash,
} from '../src/identityMap.mjs';
import { createIsolatedTestEnv } from './helpers/isolatedState.mjs';

test('identity map defaults all frontends to the same global user', (t) => {
  const isolated = createIsolatedTestEnv(t, {}, 'ran-agent-identity-');
  const env = {
    ...isolated,
    RAN_AGENT_IDENTITY_MAP_PATH: path.join(isolated.RAN_AGENT_STATE_DIR, 'identity-map.json'),
  };
  assert.equal(getGlobalUserId({ platform: 'wechat', sender_id: 'wx-raw-openid' }, { env }), 'user:ran');
  assert.equal(getGlobalUserId({ platform: 'feishu', sender_id: 'ou-raw-openid' }, { env }), 'user:ran');
  assert.equal(getGlobalUserId({ platform: 'desktop', sender_id: 'desktop-local' }, { env }), 'user:ran');
});

test('protected Telegram owner binding shares global owner but isolates conversation and session', (t) => {
  const isolated = createIsolatedTestEnv(t, {}, 'ran-agent-telegram-identity-');
  const identityMapPath = path.join(isolated.RAN_AGENT_STATE_DIR, 'identity-map.json');
  const telegramKey = `telegram:${shortHash('tg-owner')}`;
  const wechatKey = `wechat:${shortHash('wx-owner')}`;
  writeFileSync(identityMapPath, JSON.stringify({
    schemaVersion: 2,
    bindings: {
      [telegramKey]: {
        platform: 'telegram', senderHash: shortHash('tg-owner'), globalUserId: 'user:ran', owner: true,
        provenance: 'telegram_owner_challenge', createdAt: '2026-08-20T00:00:00.000Z',
      },
      [wechatKey]: {
        platform: 'wechat', senderHash: shortHash('wx-owner'), globalUserId: 'user:ran', owner: true,
        provenance: 'wechat_account_bootstrap', createdAt: '2026-08-20T00:00:00.000Z',
      },
    },
  }));
  const env = { ...isolated, RAN_AGENT_IDENTITY_MAP_PATH: identityMapPath };
  const telegram = { platform: 'telegram', channel_type: 'dm', conversation_id: 'tg-chat', sender_id: 'tg-owner' };
  const wechat = { platform: 'wechat', channel_type: 'dm', conversation_id: 'wx-chat', sender_id: 'wx-owner' };

  assert.equal(getGlobalUserId(telegram, { env }), 'user:ran');
  assert.equal(getIdentityBinding(telegram, { env }).owner, true);
  assert.notEqual(getStableConversationKey(telegram), getStableConversationKey(wechat));
  assert.match(getHermesSessionId(telegram), /^ran-agent-telegram-/);
  assert.match(getHermesSessionId(wechat), /^ran-agent-wechat-/);
  assert.notEqual(getHermesSessionId(telegram), getHermesSessionId(wechat));
});

test('identity map builds hashed account binding keys without raw ids', () => {
  const key = getAccountBindingKey({ platform: 'wechat', sender_id: 'wx-secret-openid' });
  assert.match(key, /^wechat:[a-f0-9]{16}$/);
  assert.equal(key.includes('wx-secret-openid'), false);
});

test('Hermes session keys stay inside stable conversation boundaries', () => {
  const left = getHermesSessionKey('wechat:dm:wx-conv');
  const right = getHermesSessionKey('feishu:dm:fs-conv');
  assert.notEqual(left, right);
  assert.match(left, /^ran-agent-memory-[a-f0-9]{16}$/);
});

test('different platform conversations get isolated Hermes session ids', () => {
  const wechat = getHermesSessionId({
    platform: 'wechat',
    channel_type: 'dm',
    conversation_id: 'wx-conv',
    sender_id: 'wx-user',
  });
  const feishuDm = getHermesSessionId({
    platform: 'feishu',
    channel_type: 'dm',
    conversation_id: 'chat-a',
    sender_id: 'ou-user',
  });
  const feishuGroupA = getHermesSessionId({
    platform: 'feishu',
    channel_type: 'group',
    conversation_id: 'chat-group',
    sender_id: 'ou-user-a',
  });
  const feishuGroupB = getHermesSessionId({
    platform: 'feishu',
    channel_type: 'group',
    conversation_id: 'chat-group',
    sender_id: 'ou-user-b',
  });
  const desktop = getHermesSessionId({
    platform: 'desktop',
    channel_type: 'desktop',
    conversation_id: 'desktop-thread',
    sender_id: 'desktop-client',
  });

  assert.match(wechat, /^ran-agent-wechat-[a-f0-9]{16}$/);
  assert.match(feishuDm, /^ran-agent-feishu-dm-[a-f0-9]{16}$/);
  assert.match(feishuGroupA, /^ran-agent-feishu-group-[a-f0-9]{16}$/);
  assert.match(desktop, /^ran-agent-desktop-[a-f0-9]{16}$/);
  assert.notEqual(wechat, feishuDm);
  assert.notEqual(feishuGroupA, feishuGroupB);
});

test('stable conversation key keeps platform and conversation boundaries', () => {
  assert.equal(
    getStableConversationKey({ platform: 'wechat', channel_type: 'dm', conversation_id: 'wx-conv' }),
    'wechat:dm:wx-conv'
  );
});

test('versioned identity binding is the only source of owner authority', (t) => {
  const isolated = createIsolatedTestEnv(t, {}, 'ran-agent-identity-v2-');
  const identityMapPath = path.join(isolated.RAN_AGENT_STATE_DIR, 'identity-map.json');
  const ownerMessage = { platform: 'wechat', sender_id: 'wx-owner' };
  const bindingKey = getAccountBindingKey(ownerMessage);
  writeFileSync(identityMapPath, JSON.stringify({
    schemaVersion: 2,
    bindings: {
      [bindingKey]: {
        platform: 'wechat',
        senderHash: bindingKey.split(':')[1],
        globalUserId: 'user:ran',
        owner: true,
        provenance: 'owner_bootstrap',
        createdAt: '2026-07-10T00:00:00.000Z',
      },
    },
  }));
  const env = { ...isolated, RAN_AGENT_IDENTITY_MAP_PATH: identityMapPath };

  assert.equal(getIdentityBinding(ownerMessage, { env }).owner, true);
  assert.equal(getIdentityBinding({ platform: 'wechat', sender_id: 'foreign' }, { env }).owner, false);
  assert.deepEqual(validateOwnerBindingPreflight({ env }), { ok: true, ownerBindingCount: 1 });
});

test('owner bootstrap adds bindings monotonically, retries exactly, and rejects rebinding', (t) => {
  const isolated = createIsolatedTestEnv(t, {}, 'ran-agent-owner-bootstrap-');
  const identityMapPath = path.join(isolated.RAN_AGENT_STATE_DIR, 'identity-map.json');
  const env = { ...isolated, RAN_AGENT_IDENTITY_MAP_PATH: identityMapPath };
  bootstrapOwnerBinding({
    trustedIdentity: {
      platform: 'feishu',
      senderId: 'ou-private-owner-id',
      globalUserId: 'user:ran',
      provenance: 'feishu_account_bootstrap',
    },
    env,
    now: '2026-07-10T00:00:00.000Z',
  });
  const feishuKey = getAccountBindingKey({ platform: 'feishu', sender_id: 'ou-private-owner-id' });
  const before = JSON.parse(readFileSync(identityMapPath, 'utf8'));
  const feishuBinding = structuredClone(before.bindings[feishuKey]);
  const wechatIdentity = {
    platform: 'wechat',
    senderId: 'wx-private-owner-id',
    globalUserId: 'user:ran',
    provenance: 'wechat_account_bootstrap',
  };
  const result = bootstrapOwnerBinding({ trustedIdentity: wechatIdentity, env, now: '2026-07-11T00:00:00.000Z' });

  assert.deepEqual(result, { ok: true, ownerBindingCount: 2 });
  assert.deepEqual(JSON.parse(readFileSync(identityMapPath, 'utf8')).bindings[feishuKey], feishuBinding);
  assert.equal(getIdentityBinding({ platform: 'wechat', sender_id: 'wx-private-owner-id' }, { env }).owner, true);
  assert.equal(getIdentityBinding({ platform: 'wechat', sender_id: 'wx-foreign' }, { env }).owner, false);
  const stored = readFileSync(identityMapPath, 'utf8');
  assert.deepEqual(
    bootstrapOwnerBinding({ trustedIdentity: wechatIdentity, env, now: '2027-01-01T00:00:00.000Z' }),
    { ok: true, ownerBindingCount: 2 },
  );
  assert.equal(readFileSync(identityMapPath, 'utf8'), stored);
  assert.throws(
    () => bootstrapOwnerBinding({
      trustedIdentity: { ...wechatIdentity, globalUserId: 'user:attacker' }, env,
    }),
    (error) => error?.code === 'OWNER_BOOTSTRAP_BINDING_CONFLICT',
  );
  assert.equal(stored.includes('wx-private-owner-id'), false);
  assert.equal(stored.includes('ou-private-owner-id'), false);
  assert.equal(statSync(identityMapPath).mode & 0o777, 0o600);
});

test('owner bootstrap rejects adding a different global owner', (t) => {
  const isolated = createIsolatedTestEnv(t, {}, 'ran-agent-owner-bootstrap-conflict-');
  const env = {
    ...isolated,
    RAN_AGENT_IDENTITY_MAP_PATH: path.join(isolated.RAN_AGENT_STATE_DIR, 'identity-map.json'),
  };
  bootstrapOwnerBinding({
    trustedIdentity: { platform: 'feishu', senderId: 'ou-owner', globalUserId: 'user:ran', provenance: 'test' }, env,
  });
  assert.throws(
    () => bootstrapOwnerBinding({
      trustedIdentity: { platform: 'wechat', senderId: 'wx-owner', globalUserId: 'user:other', provenance: 'test' }, env,
    }),
    (error) => error?.code === 'OWNER_BOOTSTRAP_GLOBAL_USER_CONFLICT',
  );
});

test('missing and unsupported platforms fail closed instead of acquiring WeChat identity or session semantics', () => {
  for (const message of [{ sender_id: 'missing' }, { platform: 'signal', sender_id: 'unsupported' }]) {
    assert.throws(() => getAccountBindingKey(message), (error) => error?.code === 'PLATFORM_UNSUPPORTED');
    assert.throws(() => getHermesSessionId(message), (error) => error?.code === 'PLATFORM_UNSUPPORTED');
  }
});

test('critical identity-map corruption is quarantined and fails closed', (t) => {
  const isolated = createIsolatedTestEnv(t, {}, 'ran-agent-identity-corrupt-');
  const identityMapPath = path.join(isolated.RAN_AGENT_STATE_DIR, 'identity-map.json');
  writeFileSync(identityMapPath, '{not-valid-json');
  const env = { ...isolated, RAN_AGENT_IDENTITY_MAP_PATH: identityMapPath };

  assert.throws(
    () => getIdentityBinding({ platform: 'wechat', sender_id: 'wx-owner' }, { env }),
    (error) => error?.code === 'RAN_AGENT_STATE_CORRUPT',
  );
  assert.equal(existsSync(identityMapPath), false);
  assert.equal(
    readdirSync(path.dirname(identityMapPath)).some((entry) => entry.startsWith('identity-map.json.corrupt-')),
    true,
  );
});

test('legacy and fallback identity preserve continuity but never infer owner', () => {
  const message = { platform: 'feishu', sender_id: 'ou-legacy' };
  const key = getAccountBindingKey(message);

  assert.equal(getIdentityBinding(message, {
    identityMap: { bindings: { [key]: 'user:ran' } },
  }).owner, false);
  assert.equal(getIdentityBinding(message, {
    identityMap: { default_global_user_id: 'user:ran' },
  }).owner, false);
  assert.deepEqual(validateOwnerBindingPreflight({
    identityMap: { bindings: { [key]: 'user:ran' } },
  }), { ok: false, ownerBindingCount: 0, blocker: 'owner_binding_required' });
});

test('trusted actor context ignores model-supplied authority and hashes private identity', () => {
  const message = {
    platform: 'wechat',
    channel_type: 'dm',
    sender_id: 'wx-owner-secret',
    conversation_id: 'wx-conversation-secret',
    message_id: 'wx-message-secret',
    actorKey: 'actor:forged',
    owner: true,
    global_user_id: 'user:forged',
  };
  const key = getAccountBindingKey(message);
  const context = deriveTrustedActorContext(message, {
    identityMap: {
      schemaVersion: 2,
      bindings: {
        [key]: {
          platform: 'wechat',
          senderHash: key.split(':')[1],
          globalUserId: 'user:ran',
          owner: false,
          provenance: 'test_foreign',
          createdAt: '2026-07-10T00:00:00.000Z',
        },
      },
    },
    receivedAt: '2026-07-10T12:00:00.000Z',
  });

  assert.equal(context.owner, false);
  assert.match(context.actorKey, /^actor:wechat:[a-f0-9]{16}:[a-f0-9]{16}$/);
  assert.match(context.conversationKey, /^wechat:dm:[a-f0-9]{16}$/);
  assert.match(context.messageKey, /^wechat:[a-f0-9]{16}$/);
  assert.equal(JSON.stringify(context).includes('secret'), false);
  assert.equal(JSON.stringify(context).includes('forged'), false);
});
