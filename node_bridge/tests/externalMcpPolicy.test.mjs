import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evaluateExternalMcpPolicy,
  isSideEffectTier,
  normalizeProfile,
  normalizeTier,
} from '../src/externalMcp/policy.mjs';

const NOW = new Date('2026-07-01T10:00:00Z');

function decision(input = {}) {
  return evaluateExternalMcpPolicy({
    now: NOW,
    profile: 'lite',
    sessionMode: 'observe',
    trigger: 'user_turn',
    tool: {
      serverId: 'forum.example',
      name: 'forum.read_thread',
      tier: 'T1',
      profileScope: 'lite',
      proactiveAllowed: true,
      confirmationRequired: false,
    },
    ...input,
  });
}

test('policy allows lite observe calls for classified public read tools', () => {
  const result = decision();

  assert.equal(result.allowed, true);
  assert.equal(result.decision, 'allow');
  assert.equal(result.requiresPendingAction, false);
  assert.equal(result.reason, 'policy_pass');
});

test('policy denies missing classification by default', () => {
  const result = decision({
    tool: {
      serverId: 'unknown',
      name: 'mystery.do_anything',
    },
  });

  assert.equal(result.allowed, false);
  assert.equal(result.decision, 'deny');
  assert.equal(result.reason, 'missing_tool_classification');
});

test('policy enforces profile scope hierarchy', () => {
  const result = decision({
    profile: 'lite',
    tool: {
      serverId: 'browser.example',
      name: 'browser.navigate',
      tier: 'T2',
      profileScope: 'full',
      proactiveAllowed: false,
      confirmationRequired: false,
    },
  });

  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'profile_scope_denied');
  assert.equal(result.requiredProfile, 'full');
});

test('policy allows proactive authenticated reads only with explicit watchlist match', () => {
  const noWatch = decision({
    profile: 'full',
    trigger: 'proactive',
    tool: {
      serverId: 'forum.example',
      name: 'forum.read_mentions',
      tier: 'T2',
      profileScope: 'full',
      proactiveAllowed: true,
      confirmationRequired: false,
    },
  });
  const watched = decision({
    profile: 'full',
    trigger: 'proactive',
    watchlistMatched: true,
    tool: {
      serverId: 'forum.example',
      name: 'forum.read_mentions',
      tier: 'T2',
      profileScope: 'full',
      proactiveAllowed: true,
      confirmationRequired: false,
    },
  });

  assert.equal(noWatch.allowed, false);
  assert.equal(noWatch.reason, 'proactive_requires_watchlist');
  assert.equal(watched.allowed, true);
  assert.equal(watched.decision, 'allow');
});

test('policy denies proactive use of write sessions and side-effect tiers', () => {
  const result = decision({
    profile: 'full',
    trigger: 'proactive',
    sessionMode: 'write',
    watchlistMatched: true,
    tool: {
      serverId: 'forum.example',
      name: 'forum.submit_reply',
      tier: 'T4',
      profileScope: 'full',
      proactiveAllowed: false,
      confirmationRequired: true,
    },
  });

  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'proactive_write_denied');
});

test('policy requires pending action for T4 side effects', () => {
  const result = decision({
    profile: 'full',
    sessionMode: 'interactive',
    tool: {
      serverId: 'forum.example',
      name: 'forum.submit_reply',
      tier: 'T4',
      profileScope: 'full',
      proactiveAllowed: false,
      confirmationRequired: true,
    },
  });

  assert.equal(result.allowed, false);
  assert.equal(result.decision, 'confirmation_required');
  assert.equal(result.requiresPendingAction, true);
  assert.equal(result.pendingActionType, 'forum_comment');
});

test('policy allows confirmed pending T4 action and records evidence requirement', () => {
  const result = decision({
    profile: 'full',
    sessionMode: 'write',
    pendingAction: {
      status: 'confirmed',
      actionType: 'forum_comment',
      serverId: 'forum.example',
      toolName: 'forum.submit_reply',
    },
    tool: {
      serverId: 'forum.example',
      name: 'forum.submit_reply',
      tier: 'T4',
      profileScope: 'full',
      proactiveAllowed: false,
      confirmationRequired: true,
    },
  });

  assert.equal(result.allowed, true);
  assert.equal(result.decision, 'allow');
  assert.deepEqual(result.requiredEvidence, ['authorization', 'external_mcp_tool_result']);
});

test('policy allows scoped game grants only inside server, tool, mode, and expiry bounds', () => {
  const allowed = decision({
    profile: 'full',
    sessionMode: 'write',
    tool: {
      serverId: 'game.local',
      name: 'game.act',
      tier: 'T4',
      profileScope: 'full',
      proactiveAllowed: false,
      confirmationRequired: true,
    },
    scopedGrant: {
      grantId: 'grant-1',
      serverId: 'game.local',
      toolName: 'game.act',
      mode: 'write',
      expiresAt: '2026-07-01T10:30:00Z',
    },
  });
  const expired = decision({
    profile: 'full',
    sessionMode: 'write',
    tool: {
      serverId: 'game.local',
      name: 'game.act',
      tier: 'T4',
      profileScope: 'full',
      proactiveAllowed: false,
      confirmationRequired: true,
    },
    scopedGrant: {
      grantId: 'grant-1',
      serverId: 'game.local',
      toolName: 'game.act',
      mode: 'write',
      expiresAt: '2026-07-01T09:59:59Z',
    },
  });

  assert.equal(allowed.allowed, true);
  assert.equal(allowed.scopedGrantId, 'grant-1');
  assert.equal(expired.allowed, false);
  assert.equal(expired.reason, 'scoped_grant_expired');
});

test('T5 destructive actions stay disabled without a scoped grant even for owner full', () => {
  const result = decision({
    profile: 'owner_full',
    sessionMode: 'write',
    tool: {
      serverId: 'forum.example',
      name: 'forum.delete_post',
      tier: 'T5',
      profileScope: 'owner_full',
      proactiveAllowed: false,
      confirmationRequired: true,
    },
    pendingAction: {
      status: 'confirmed',
      actionType: 'external_mcp_write',
      serverId: 'forum.example',
      toolName: 'forum.delete_post',
    },
  });

  assert.equal(result.allowed, false);
  assert.equal(result.reason, 't5_requires_scoped_grant');
});

test('normalizers fail closed for unknown tiers and profiles', () => {
  assert.equal(normalizeTier('T3'), 'T3');
  assert.equal(normalizeTier('anything'), 'T5');
  assert.equal(normalizeProfile('owner_full'), 'owner_full');
  assert.equal(normalizeProfile('root'), 'lite');
  assert.equal(isSideEffectTier('T3'), false);
  assert.equal(isSideEffectTier('T4'), true);
  assert.equal(isSideEffectTier('T5'), true);
});
