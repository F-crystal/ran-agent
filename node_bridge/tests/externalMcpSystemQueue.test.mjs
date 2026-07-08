import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildExternalMcpSyntheticTurn,
  evaluateExternalMcpSystemQueueEgress,
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
    globalUserId: 'ou-home',
    evidenceRefs: ['external_mcp_evidence:abc123'],
    dedupeKey: 'thread:forum.example/123:update:456',
    expiresAt: '2026-07-01T13:00:00Z',
    deliverability: 'notify_allowed',
    allowedCapabilityTiers: ['T1', 'T2'],
  });

  assert.equal(turn.platform, 'feishu');
  assert.equal(turn.channel_type, 'dm');
  assert.equal(turn.conversation_id, 'oc-home');
  assert.equal(turn.sender_id, 'ou-home');
  assert.equal(turn.route_hint, 'external_mcp_system_queue');
  assert.match(turn.text, /watched forum thread changed/);
  assert.match(turn.text, /event_id: watch-1/);
  assert.match(turn.text, /evidence_refs: external_mcp_evidence:abc123/);
  assert.match(turn.text, /dedupe_key: thread:forum.example\/123/);
  assert.match(turn.text, /expires_at: 2026-07-01T13:00:00.000Z/);
  assert.match(turn.text, /notify_allowed/);
  assert.match(turn.text, /Return exactly one JSON object/);
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
    routeHint: 'external_mcp_system_queue',
    replyText: 'remember',
  }), { suppress: true, reason: 'remember' });
  assert.deepEqual(shouldSuppressSystemQueueReply({
    routeHint: 'scheduled_ai_daily_digest',
    replyText: 'silent',
  }), { suppress: false, reason: '' });
  assert.deepEqual(shouldSuppressSystemQueueReply({
    routeHint: 'external_mcp_system_queue',
    replyText: '{"action":"draft","message":"maybe"}',
  }), { suppress: true, reason: 'draft_requires_confirmation' });
  assert.deepEqual(shouldSuppressSystemQueueReply({
    routeHint: 'external_mcp_system_queue',
    replyText: '有一个你关注的帖子更新了',
  }), { suppress: true, reason: 'malformed_action' });
});

test('system queue egress only sends structured notify actions with matching evidence', () => {
  const event = {
    event_id: 'watch-1',
    kind: 'forum_watch',
    global_user_id: 'ou-home',
    channel: 'feishu',
    watch_scope: 'thread:forum.example/123',
    reason: 'watched forum thread changed',
    evidence_refs: ['external_mcp_evidence:abc123'],
    dedupe_key: 'thread:forum.example/123:update:456',
    created_at: '2026-07-01T12:00:00.000Z',
    expires_at: '2026-07-01T13:00:00.000Z',
    deliverability: 'notify_allowed',
    allowed_capability_tiers: ['T1', 'T2'],
    quiet_policy: 'respect',
    budget_class: 'external_mcp',
  };

  const notify = evaluateExternalMcpSystemQueueEgress({
    event,
    replyText: JSON.stringify({
      action: 'notify',
      message: '你关注的帖子有一条直接回复。',
      evidence_refs: ['external_mcp_evidence:abc123'],
      why_now: 'watched thread received a direct reply',
    }),
  });
  assert.equal(notify.send, true);
  assert.equal(notify.message, '你关注的帖子有一条直接回复。');

  const rawText = evaluateExternalMcpSystemQueueEgress({ event, replyText: '你关注的帖子有更新' });
  assert.equal(rawText.send, false);
  assert.equal(rawText.reason, 'malformed_action');

  const noEvidence = evaluateExternalMcpSystemQueueEgress({
    event,
    replyText: JSON.stringify({
      action: 'notify',
      message: '你关注的帖子有一条直接回复。',
      evidence_refs: ['external_mcp_evidence:other'],
      why_now: 'watched thread received a direct reply',
    }),
  });
  assert.equal(noEvidence.send, false);
  assert.equal(noEvidence.reason, 'evidence_missing');

  const noWhyNow = evaluateExternalMcpSystemQueueEgress({
    event,
    replyText: JSON.stringify({
      action: 'notify',
      message: '你关注的帖子有一条直接回复。',
      evidence_refs: ['external_mcp_evidence:abc123'],
    }),
  });
  assert.equal(noWhyNow.send, false);
  assert.equal(noWhyNow.reason, 'why_now_missing');
});

test('system queue egress uses configured proactive notify length budget', () => {
  const event = {
    event_id: 'game-1',
    kind: 'game_activity',
    global_user_id: 'ou-home',
    channel: 'feishu',
    watch_scope: 'game:cedartoy/slot-1',
    reason: 'scoped game activity finished',
    evidence_refs: ['external_mcp_evidence:game123'],
    dedupe_key: 'game:cedartoy/slot-1',
    created_at: '2026-07-01T12:00:00.000Z',
    expires_at: '2026-07-01T13:00:00.000Z',
    deliverability: 'notify_allowed',
    allowed_capability_tiers: ['T3'],
    quiet_policy: 'respect',
    budget_class: 'external_mcp',
  };
  const message = `进展：${'这局已经推进并记录了关键状态。'.repeat(55)}`;

  const configured = evaluateExternalMcpSystemQueueEgress({
    event,
    env: { HERMES_PROACTIVE_NOTIFY_MAX_CHARS: '1600' },
    replyText: JSON.stringify({
      action: 'notify',
      message,
      evidence_refs: ['external_mcp_evidence:game123'],
      why_now: 'game activity reached a final state',
    }),
  });
  assert.equal(configured.send, true);

  const defaultBudget = evaluateExternalMcpSystemQueueEgress({
    event,
    replyText: JSON.stringify({
      action: 'notify',
      message,
      evidence_refs: ['external_mcp_evidence:game123'],
      why_now: 'game activity reached a final state',
    }),
  });
  assert.equal(defaultBudget.send, false);
  assert.equal(defaultBudget.reason, 'message_too_long');
});
