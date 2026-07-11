import test from 'node:test';
import assert from 'node:assert/strict';

import {
  cancelPendingAction,
  confirmPendingAction,
  createPendingAction,
  findLatestPendingAction,
  findPendingActionsForConversation,
  getPendingActionConfig,
  listPendingActions,
} from '../src/pendingActionState.mjs';
import { createIsolatedTestEnv } from './helpers/isolatedState.mjs';

function tempEnv(t) {
  return createIsolatedTestEnv(t, {
    HERMES_ACTION_PENDING_ENABLED: 'true',
    HERMES_ACTION_PENDING_TTL_MINUTES: '30',
  }, 'ran-agent-pending-actions-');
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

test('createPendingAction writes append-only state and sanitized index', (t) => {
  const env = tempEnv(t);
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

test('latest pending action is scoped to channel and conversation hash', (t) => {
  const env = tempEnv(t);
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

  const now = new Date('2026-06-14T04:02:00.000Z');
  assert.equal(findLatestPendingAction({ channel: 'wechat', conversationId: 'conv-a' }, { env, now })?.requestId, 'req-a');
  assert.equal(findLatestPendingAction({ channel: 'feishu', conversationId: 'conv-b' }, { env, now })?.actionId, b.actionId);
  assert.equal(findLatestPendingAction({ channel: 'wechat', conversationId: 'conv-b' }, { env, now }), null);
});

test('confirm cancel and expiry update pending action status', (t) => {
  const env = tempEnv(t);
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

test('external MCP pending actions keep safe ids and hash raw arguments', (t) => {
  const env = tempEnv(t);
  const action = createPendingAction({
    requestId: 'req-external-mcp',
    channel: 'wechat',
    conversationId: 'conv-external-mcp',
    profile: 'ran-assistant-full',
    actionType: 'forum_comment',
    summary: '评论论坛帖子',
    sanitizedPayload: {
      serverId: 'forum.example',
      toolId: 'forum.submit_reply',
      actionFamily: 'forum_comment',
      watchScope: 'thread:forum.example/123',
      grantId: 'grant-abc',
      evidenceId: 'evidence-123',
      arguments: {
        threadId: '123',
        body: 'raw private reply body must not be stored',
      },
      contentRef: 'raw-content-ref',
      cookie: 'sessionid=secret',
    },
    evidence: [
      {
        type: 'external_mcp_tool_result',
        status: 'pending',
        result_id_hash: 'abcdef1234567890',
      },
    ],
  }, { env, now: new Date('2026-07-01T10:00:00.000Z') });

  assert.deepEqual(action.sanitizedPayload, {
    serverId: 'forum.example',
    toolId: 'forum.submit_reply',
    actionFamily: 'forum_comment',
    watchScope: 'thread:forum.example/123',
    grantId: 'grant-abc',
    evidenceId: 'evidence-123',
    argumentsHash: action.sanitizedPayload.argumentsHash,
    contentRefHash: action.sanitizedPayload.contentRefHash,
  });
  assert.match(action.sanitizedPayload.argumentsHash, /^[a-f0-9]{16}$/);
  assert.match(action.sanitizedPayload.contentRefHash, /^[a-f0-9]{16}$/);
  assert.equal(action.evidence[0].type, 'external_mcp_tool_result');

  const serialized = JSON.stringify(listPendingActions({ env }));
  assert.equal(serialized.includes('raw private reply body'), false);
  assert.equal(serialized.includes('raw-content-ref'), false);
  assert.equal(serialized.includes('sessionid=secret'), false);
  assert.equal(serialized.includes('conv-external-mcp'), false);
});

test('actor binding and revision CAS prevent foreign or stale confirmations', (t) => {
  const env = tempEnv(t);
  const owner = {
    actorKey: 'actor:wechat:owner',
    owner: true,
    platform: 'wechat',
    conversationKey: 'wechat:dm:abc',
  };
  const foreign = {
    ...owner,
    actorKey: 'actor:wechat:foreign',
  };
  const action = createPendingAction({
    requestId: 'req-cas',
    channel: 'wechat',
    conversationId: 'conv-cas',
    actionType: 'external_send',
    summary: '发送',
    sanitizedPayload: { recipient: 'private-recipient', contentRef: 'private-content' },
  }, { env, actorContext: owner });

  assert.equal(action.schemaVersion, 2);
  assert.equal(action.revision, 1);
  assert.equal(action.actorKey, owner.actorKey);
  assert.match(action.actionDigest, /^[a-f0-9]{16}$/);
  assert.equal(findPendingActionsForConversation({
    channel: 'wechat',
    conversationId: 'conv-cas',
  }, { env, actorContext: foreign }).length, 0);
  assert.throws(
    () => confirmPendingAction(action.actionId, {
      env,
      actorContext: foreign,
      expectedRevision: action.revision,
    }),
    { code: 'PENDING_ACTION_ACTOR_MISMATCH' },
  );

  const confirmed = confirmPendingAction(action.actionId, {
    env,
    actorContext: owner,
    expectedRevision: action.revision,
  });
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.revision, 2);
  assert.throws(
    () => confirmPendingAction(action.actionId, {
      env,
      actorContext: owner,
      expectedRevision: action.revision,
    }),
    { code: 'PENDING_ACTION_STALE_REVISION' },
  );
});
