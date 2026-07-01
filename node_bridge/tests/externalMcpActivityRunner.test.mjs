import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  consumeExternalMcpActivityCall,
  getTrustedExternalMcpActivityGrant,
  registerExternalMcpAbortController,
  startExternalMcpActivity,
  stopExternalMcpActivitiesByUser,
} from '../src/externalMcp/activityRunner.mjs';
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
    profile: 'full',
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

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function tempEnv(t) {
  const root = fs.mkdtempSync(path.join(PROJECT_ROOT, '.ran_agent_state', 'test-external-mcp-activity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { RAN_AGENT_STATE_DIR: root };
}
