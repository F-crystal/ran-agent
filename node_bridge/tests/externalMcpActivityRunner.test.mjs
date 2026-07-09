import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  createExternalMcpActivityTargetToken,
  consumeExternalMcpActivityCall,
  getTrustedExternalMcpActivityGrant,
  registerExternalMcpAbortController,
  runDueExternalMcpActivities,
  startExternalMcpActivity,
  stopExternalMcpActivitiesByUser,
} from '../src/externalMcp/activityRunner.mjs';
import { appendExternalMcpEvidence } from '../src/externalMcp/evidenceLog.mjs';
import { evaluateExternalMcpPolicy } from '../src/externalMcp/policy.mjs';
import {
  closeExternalMcpSession,
  getExternalMcpSession,
} from '../src/externalMcp/sessionManager.mjs';

const PROJECT_ROOT = path.resolve(new URL('../..', import.meta.url).pathname);

test('activity runner creates a bounded trusted game_play grant for Hermes activity turns', (t) => {
  const env = tempEnv(t);
  const activity = startExternalMcpActivity({
    globalUserId: 'user:ran',
    serverId: 'cedartoy-games',
    kind: 'game_play',
    maxMinutes: 30,
    maxCalls: 2,
    maxShares: 3,
    allowedToolPattern: '^ecosystem\\.',
    now: '2026-07-02T10:00:00Z',
  }, { env });

  const grant = getTrustedExternalMcpActivityGrant(activity.activityId, {
    env,
    globalUserId: 'user:ran',
    serverId: 'cedartoy-games',
    now: '2026-07-02T10:01:00Z',
  });
  const decision = evaluateExternalMcpPolicy({
    now: '2026-07-02T10:01:00Z',
    profile: 'lite',
    trigger: 'activity',
    sessionMode: 'interactive',
    scopedGrant: grant,
    tool: {
      serverId: 'cedartoy-games',
      name: 'ecosystem.cmd',
      tier: 'T3',
      profileScope: 'full',
      proactiveAllowed: true,
      confirmationRequired: false,
      reason: 'sandbox_activity',
    },
  });

  assert.equal(activity.status, 'active');
  assert.equal(activity.kind, 'game_play');
  assert.equal(activity.budget.maxCalls, 2);
  assert.equal(decision.allowed, true);
  assert.equal(decision.scopedGrantId, activity.grantId);
});

test('activity runner enforces call budgets before endless loops happen', (t) => {
  const env = tempEnv(t);
  const activity = startExternalMcpActivity({
    globalUserId: 'user:ran',
    serverId: 'cedartoy-games',
    kind: 'game_play',
    maxMinutes: 30,
    maxCalls: 1,
    now: '2026-07-02T10:00:00Z',
  }, { env });

  const first = consumeExternalMcpActivityCall(activity.activityId, { env, now: '2026-07-02T10:01:00Z' });
  const second = consumeExternalMcpActivityCall(activity.activityId, { env, now: '2026-07-02T10:02:00Z' });
  const grantAfterStop = getTrustedExternalMcpActivityGrant(activity.activityId, {
    env,
    globalUserId: 'user:ran',
    serverId: 'cedartoy-games',
    now: '2026-07-02T10:02:00Z',
  });

  assert.equal(first.allowed, true);
  assert.equal(second.allowed, false);
  assert.equal(second.reason, 'activity_call_budget_exhausted');
  assert.equal(grantAfterStop, null);
});

test('activity stop works by global user id and aborts runtime work', (t) => {
  const env = tempEnv(t);
  const activity = startExternalMcpActivity({
    globalUserId: 'user:ran',
    serverId: 'cedartoy-games',
    kind: 'game_play',
    maxMinutes: 30,
    now: '2026-07-02T10:00:00Z',
  }, { env });
  const controller = new AbortController();
  registerExternalMcpAbortController({
    globalUserId: 'user:ran',
    activityId: activity.activityId,
    sessionId: activity.sessionId,
  }, controller);

  const stopped = stopExternalMcpActivitiesByUser('user:ran', {
    env,
    now: '2026-07-02T10:05:00Z',
    reason: 'user_stop',
  });

  assert.equal(stopped.ok, true);
  assert.deepEqual(stopped.stoppedActivityIds, [activity.activityId]);
  assert.equal(controller.signal.aborted, true);
  assert.equal(getExternalMcpSession(activity.sessionId, {
    env,
    globalUserId: 'user:ran',
    serverId: 'cedartoy-games',
    now: '2026-07-02T10:06:00Z',
  }), null);
});

test('activity abort watcher notices session closure from another process', async (t) => {
  const env = tempEnv(t);
  const activity = startExternalMcpActivity({
    globalUserId: 'user:ran',
    serverId: 'cedartoy-games',
    kind: 'game_play',
    maxMinutes: 30,
    now: '2026-07-02T10:00:00Z',
  }, { env });
  const controller = new AbortController();
  const aborted = new Promise((resolve) => {
    controller.signal.addEventListener('abort', () => resolve(true), { once: true });
  });
  const unregister = registerExternalMcpAbortController({
    globalUserId: 'user:ran',
    serverId: 'cedartoy-games',
    activityId: activity.activityId,
    sessionId: activity.sessionId,
  }, controller, {
    env,
    pollMs: 5,
  });

  closeExternalMcpSession(activity.sessionId, {
    env,
    globalUserId: 'user:ran',
    serverId: 'cedartoy-games',
    now: '2026-07-02T10:01:00Z',
  });

  assert.equal(await Promise.race([aborted, delay(200).then(() => false)]), true);
  unregister();
});

test('background activity uses bridge target token and sends only with trusted evidence', async (t) => {
  const env = tempEnv(t);
  const token = createExternalMcpActivityTargetToken({
    globalUserId: 'user:ran',
    platform: 'wechat',
    conversationId: 'wx-conv',
    senderId: 'wx-sender',
    channelType: 'dm',
    now: '2026-07-02T10:00:00Z',
  }, { env });
  const activity = startExternalMcpActivity({
    globalUserId: 'model-supplied-user',
    serverId: 'cedartoy-games',
    kind: 'game_play',
    background: true,
    activityTargetToken: token.token,
    watchScope: 'game:cedartoy/slot-1',
    maxMinutes: 30,
    maxCalls: 2,
    now: '2026-07-02T10:01:00Z',
  }, { env });
  const evidence = appendExternalMcpEvidence({
    requestId: 'req-game-1',
    globalUserId: 'user:ran',
    serverId: 'cedartoy-games',
    toolName: 'play',
    watchScope: 'game:cedartoy/slot-1',
    tier: 'T3',
    sessionMode: 'interactive',
    trigger: 'activity',
    decision: 'allow',
    result: { ok: true, status: 'success' },
  }, { env, now: '2026-07-02T10:02:00Z' });

  const sent = [];
  const result = await runDueExternalMcpActivities({
    env,
    now: '2026-07-02T10:03:00Z',
    channelHub: async (message, options) => {
      assert.match(message.text, /activity_id:/);
      assert.match(message.text, /watch_scope: game:cedartoy\/slot-1/);
      assert.doesNotMatch(message.text, /session_id|extmcp_|sessionKey|upstream/i);
      await options.adapter.sendReply({
        target: { conversation_id: 'ignored' },
        message,
        text: JSON.stringify({
          action: 'notify',
          message: '游戏推进完成：已经完成这一轮探索，并记录了关键状态。',
          evidence_refs: [evidence.evidence_ref],
          why_now: 'activity tick reached a useful game state',
        }),
      });
      return { replyText: 'ok' };
    },
    sendText: async (target, text) => {
      sent.push({ target, text });
    },
  });

  assert.equal(activity.globalUserId, 'user:ran');
  assert.equal(activity.background, true);
  assert.equal(result.processed, 1);
  assert.equal(result.sent, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].target.platform, 'wechat');
  assert.equal(sent[0].target.conversationId, 'wx-conv');
  assert.equal(sent[0].target.senderId, 'wx-sender');
});

test('background activity refuses missing target token and suppresses untrusted final claims', async (t) => {
  const env = tempEnv(t);
  const denied = startExternalMcpActivity({
    globalUserId: 'user:ran',
    serverId: 'cedartoy-games',
    kind: 'game_play',
    background: true,
    watchScope: 'game:cedartoy/slot-1',
  }, { env });
  assert.equal(denied.ok, false);
  assert.equal(denied.error_code, 'EXTERNAL_MCP_ACTIVITY_TARGET_TOKEN_REQUIRED');

  const token = createExternalMcpActivityTargetToken({
    globalUserId: 'user:ran',
    platform: 'wechat',
    conversationId: 'wx-conv',
    senderId: 'wx-sender',
  }, { env, now: '2026-07-02T10:00:00Z' });
  startExternalMcpActivity({
    serverId: 'cedartoy-games',
    kind: 'game_play',
    background: true,
    activityTargetToken: token.token,
    watchScope: 'game:cedartoy/slot-1',
    now: '2026-07-02T10:01:00Z',
  }, { env });

  const sent = [];
  const result = await runDueExternalMcpActivities({
    env,
    now: '2026-07-02T10:02:00Z',
    channelHub: async (message, options) => {
      await options.adapter.sendReply({
        target: {},
        message,
        text: JSON.stringify({
          action: 'notify',
          message: '我完成了这一轮探索。',
          evidence_refs: ['external_mcp_evidence:fake'],
          why_now: 'activity tick ended',
        }),
      });
      return { replyText: 'ok' };
    },
    sendText: async (target, text) => {
      sent.push({ target, text });
    },
  });

  assert.equal(result.processed, 1);
  assert.equal(result.sent, 0);
  assert.equal(result.results[0].reason, 'evidence_required');
  assert.equal(sent.length, 0);
});

test('background activity respects proactive kill switch before sending', async (t) => {
  const env = { ...tempEnv(t), HERMES_PROACTIVE_EVENTS_ENABLED: 'false' };
  const token = createExternalMcpActivityTargetToken({
    globalUserId: 'user:ran',
    platform: 'wechat',
    conversationId: 'wx-conv',
    senderId: 'wx-sender',
  }, { env, now: '2026-07-02T10:00:00Z' });
  startExternalMcpActivity({
    serverId: 'cedartoy-games',
    kind: 'game_play',
    background: true,
    activityTargetToken: token.token,
    watchScope: 'game:cedartoy/slot-1',
    now: '2026-07-02T10:01:00Z',
  }, { env });

  let channelHubCalled = false;
  const sent = [];
  const result = await runDueExternalMcpActivities({
    env,
    now: '2026-07-02T10:02:00Z',
    channelHub: async () => {
      channelHubCalled = true;
    },
    sendText: async (target, text) => {
      sent.push({ target, text });
    },
  });

  assert.equal(result.processed, 1);
  assert.equal(result.sent, 0);
  assert.equal(result.results[0].reason, 'proactive_events_disabled');
  assert.equal(channelHubCalled, false);
  assert.equal(sent.length, 0);
});

test('background activity respects share budget before invoking Hermes', async (t) => {
  const env = tempEnv(t);
  const token = createExternalMcpActivityTargetToken({
    globalUserId: 'user:ran',
    platform: 'wechat',
    conversationId: 'wx-conv',
    senderId: 'wx-sender',
  }, { env, now: '2026-07-02T10:00:00Z' });
  startExternalMcpActivity({
    serverId: 'cedartoy-games',
    kind: 'game_play',
    background: true,
    activityTargetToken: token.token,
    watchScope: 'game:cedartoy/slot-1',
    maxShares: 0,
    now: '2026-07-02T10:01:00Z',
  }, { env });

  let channelHubCalled = false;
  const first = await runDueExternalMcpActivities({
    env,
    now: '2026-07-02T10:02:00Z',
    channelHub: async () => {
      channelHubCalled = true;
    },
    sendText: async () => {},
  });
  const second = await runDueExternalMcpActivities({
    env,
    now: '2026-07-02T10:03:00Z',
    channelHub: async () => {
      channelHubCalled = true;
    },
    sendText: async () => {},
  });

  assert.equal(first.processed, 1);
  assert.equal(first.sent, 0);
  assert.equal(first.results[0].reason, 'activity_share_budget_exhausted');
  assert.equal(second.processed, 0);
  assert.equal(channelHubCalled, false);
});

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function tempEnv(t) {
  const root = fs.mkdtempSync(path.join(PROJECT_ROOT, '.ran_agent_state', 'test-external-mcp-activity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { RAN_AGENT_STATE_DIR: root, HERMES_PROACTIVE_EVENTS_ENABLED: 'true' };
}
