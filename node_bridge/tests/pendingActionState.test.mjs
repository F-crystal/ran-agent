import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  cancelPendingAction,
  confirmPendingAction,
  createPendingAction,
  findLatestPendingAction,
  getPendingActionConfig,
  listPendingActions,
} from '../src/pendingActionState.mjs';

function tempEnv() {
  const base = path.join(process.cwd(), '.ran_agent_state', 'test-pending-actions');
  fs.mkdirSync(base, { recursive: true });
  return {
    RAN_AGENT_STATE_DIR: fs.mkdtempSync(path.join(base, 'case-')),
    HERMES_ACTION_PENDING_ENABLED: 'true',
    HERMES_ACTION_PENDING_TTL_MINUTES: '30',
  };
}

test('pending action config defaults to enabled with 30 minute ttl', () => {
  assert.deepEqual(getPendingActionConfig({}), {
    enabled: true,
    ttlMinutes: 30,
  });
  assert.deepEqual(getPendingActionConfig({
    HERMES_ACTION_PENDING_ENABLED: 'false',
    HERMES_ACTION_PENDING_TTL_MINUTES: '5',
  }), {
    enabled: false,
    ttlMinutes: 5,
  });
});

test('createPendingAction writes append-only state and sanitized index', () => {
  const env = tempEnv();
  const action = createPendingAction({
    requestId: 'req-pending',
    channel: 'wechat',
    conversationId: 'conv-secret',
    profile: 'ran-assistant-lite',
    actionType: 'sticker_save',
    summary: '保存表情包',
    sanitizedPayload: {
      filePath: '/opt/ran_agent/.ran_agent_state/wechat/inbound/private.png',
      token: 'secret-token',
      media: [{ filePath: '/private/path.png', ref: 'media-private-ref' }],
      tags: ['开心'],
    },
  }, { env, now: new Date('2026-06-14T04:00:00.000Z') });

  assert.match(action.actionId, /^act_/);
  assert.equal(action.status, 'pending');
  assert.equal(action.actionType, 'sticker_save');
  assert.equal(action.conversationIdHash.length, 16);
  assert.deepEqual(action.sanitizedPayload, {
    tags: ['开心'],
    mediaRefs: [{ refHash: action.sanitizedPayload.mediaRefs[0].refHash, type: '' }],
  });

  const serialized = JSON.stringify(listPendingActions({ env }));
  assert.equal(serialized.includes('/opt/ran_agent'), false);
  assert.equal(serialized.includes('/private/path'), false);
  assert.equal(serialized.includes('secret-token'), false);
  assert.equal(serialized.includes('conv-secret'), false);
});

test('latest pending action is scoped to channel and conversation hash', () => {
  const env = tempEnv();
  createPendingAction({
    requestId: 'req-a',
    channel: 'wechat',
    conversationId: 'conv-a',
    actionType: 'memory_write',
    summary: '记忆',
  }, { env, now: new Date('2026-06-14T04:00:00.000Z') });
  const b = createPendingAction({
    requestId: 'req-b',
    channel: 'feishu',
    conversationId: 'conv-b',
    actionType: 'memory_write',
    summary: '记忆',
  }, { env, now: new Date('2026-06-14T04:01:00.000Z') });

  assert.equal(findLatestPendingAction({ channel: 'wechat', conversationId: 'conv-a' }, { env })?.requestId, 'req-a');
  assert.equal(findLatestPendingAction({ channel: 'feishu', conversationId: 'conv-b' }, { env })?.actionId, b.actionId);
  assert.equal(findLatestPendingAction({ channel: 'wechat', conversationId: 'conv-b' }, { env }), null);
});

test('confirm cancel and expiry update pending action status', () => {
  const env = tempEnv();
  const action = createPendingAction({
    requestId: 'req-expire',
    channel: 'wechat',
    conversationId: 'conv-expire',
    actionType: 'external_send',
    summary: '发送',
  }, {
    env,
    now: new Date('2026-06-14T04:00:00.000Z'),
    ttlMinutes: 1,
  });

  assert.equal(findLatestPendingAction({
    channel: 'wechat',
    conversationId: 'conv-expire',
  }, { env, now: new Date('2026-06-14T04:02:00.000Z') }), null);
  assert.equal(listPendingActions({ env }).find((item) => item.actionId === action.actionId).status, 'expired');

  const toConfirm = createPendingAction({
    requestId: 'req-confirm',
    channel: 'wechat',
    conversationId: 'conv-confirm',
    actionType: 'memory_write',
    summary: '记忆',
  }, { env });
  assert.equal(confirmPendingAction(toConfirm.actionId, { env }).status, 'confirmed');

  const toCancel = createPendingAction({
    requestId: 'req-cancel',
    channel: 'wechat',
    conversationId: 'conv-cancel',
    actionType: 'memory_write',
    summary: '记忆',
  }, { env });
  assert.equal(cancelPendingAction(toCancel.actionId, { env }).status, 'cancelled');
});
