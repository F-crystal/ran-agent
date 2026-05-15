import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getAccountBindingKey,
  getGlobalUserId,
  getHermesSessionId,
  getHermesSessionKey,
  getStableConversationKey,
} from '../src/identityMap.mjs';

test('identity map defaults all frontends to the same global user', () => {
  assert.equal(getGlobalUserId({ platform: 'wechat', sender_id: 'wx-raw-openid' }), 'user:ran');
  assert.equal(getGlobalUserId({ platform: 'feishu', sender_id: 'ou-raw-openid' }), 'user:ran');
  assert.equal(getGlobalUserId({ platform: 'desktop', sender_id: 'desktop-local' }), 'user:ran');
});

test('identity map builds hashed account binding keys without raw ids', () => {
  const key = getAccountBindingKey({ platform: 'wechat', sender_id: 'wx-secret-openid' });
  assert.match(key, /^wechat:[a-f0-9]{16}$/);
  assert.equal(key.includes('wx-secret-openid'), false);
});

test('same global user gets same Hermes session key across platforms', () => {
  const left = getHermesSessionKey('user:ran');
  const right = getHermesSessionKey(getGlobalUserId({ platform: 'feishu', sender_id: 'ou-secret' }));
  assert.equal(left, right);
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
