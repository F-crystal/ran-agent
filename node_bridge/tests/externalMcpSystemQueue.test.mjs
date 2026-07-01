import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildExternalMcpSyntheticTurn,
  shouldSuppressSystemQueueReply,
} from '../src/externalMcp/systemQueue.mjs';

test('system queue builds synthetic Hermes turns without outbound content ownership', () => {
  const turn = buildExternalMcpSyntheticTurn({
    id: 'watch-1',
    platform: 'feishu',
    conversationId: 'oc-home',
    senderId: 'ou-home',
    reason: 'watched forum thread changed',
    watchScope: 'thread:forum.example/123',
    deliverability: 'notify_allowed',
    allowedCapabilityTiers: ['T1', 'T2'],
  });

  assert.equal(turn.platform, 'feishu');
  assert.equal(turn.channel_type, 'dm');
  assert.equal(turn.conversation_id, 'oc-home');
  assert.equal(turn.sender_id, 'ou-home');
  assert.equal(turn.route_hint, 'external_mcp_system_queue');
  assert.match(turn.text, /watched forum thread changed/);
  assert.match(turn.text, /notify_allowed/);
  assert.doesNotMatch(turn.text, /cookie|token|session/i);
});

test('system queue suppresses explicit silent and remember replies only on external MCP synthetic turns', () => {
  assert.deepEqual(shouldSuppressSystemQueueReply({
    routeHint: 'external_mcp_system_queue',
    replyText: 'silent',
  }), { suppress: true, reason: 'silent' });
  assert.deepEqual(shouldSuppressSystemQueueReply({
    routeHint: 'external_mcp_system_queue',
    replyText: '{"action":"remember","note":"store quietly"}',
  }), { suppress: true, reason: 'remember' });
  assert.deepEqual(shouldSuppressSystemQueueReply({
    routeHint: 'scheduled_ai_daily_digest',
    replyText: 'silent',
  }), { suppress: false, reason: '' });
  assert.deepEqual(shouldSuppressSystemQueueReply({
    routeHint: 'external_mcp_system_queue',
    replyText: '有一个你关注的帖子更新了',
  }), { suppress: false, reason: '' });
});
