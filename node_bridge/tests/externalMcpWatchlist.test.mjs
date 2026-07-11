import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createIsolatedTestEnv } from './helpers/isolatedState.mjs';

import {
  addExternalMcpWatch,
  checkExternalMcpRateBudget,
  commitExternalMcpNotificationReservation,
  listExternalMcpWatches,
  recordExternalMcpNotification,
  removeExternalMcpWatch,
  releaseExternalMcpNotificationReservation,
  reserveExternalMcpNotification,
} from '../src/externalMcp/watchlist.mjs';

function tempEnv(t) {
  return createIsolatedTestEnv(t, {}, 'external-mcp-watchlist-');
}

test('watchlist adds lists and removes normalized watch scopes', (t) => {
  const env = tempEnv(t);
  const watch = addExternalMcpWatch({
    globalUserId: 'user:ran',
    serverId: 'forum.example',
    kind: 'forum',
    scope: 'thread:forum.example/123',
    notify: true,
  }, { env, now: '2026-07-01T10:00:00Z' });

  assert.equal(watch.ok, true);
  assert.match(watch.watchId, /^watch_[a-f0-9]{16}$/);
  assert.deepEqual(listExternalMcpWatches({ env }).map((item) => item.scope), ['thread:forum.example/123']);

  const removed = removeExternalMcpWatch(watch.watchId, { env });
  assert.equal(removed.ok, true);
  assert.deepEqual(listExternalMcpWatches({ env }), []);
});

test('watchlist rejects malformed or unsafe scopes fail-closed', (t) => {
  const env = tempEnv(t);
  const result = addExternalMcpWatch({
    globalUserId: 'user:ran',
    serverId: 'forum.example',
    kind: 'forum',
    scope: 'cookie=sessionid=secret',
  }, { env });

  assert.equal(result.ok, false);
  assert.equal(result.error_code, 'EXTERNAL_MCP_INVALID_WATCH_SCOPE');
  assert.deepEqual(listExternalMcpWatches({ env }), []);
});

test('watchlist keeps a configured embodied MCP watch instead of treating its domain as invalid', (t) => {
  const env = tempEnv(t);
  const watch = addExternalMcpWatch({
    globalUserId: 'user:ran',
    serverId: 'robot.example',
    kind: 'embodied',
    scope: 'device:robot.example/unit-1',
  }, { env, now: '2026-07-01T10:00:00Z' });

  assert.equal(watch.ok, true);
  assert.equal(listExternalMcpWatches({ env })[0].kind, 'embodied');
});

test('rate budget enforces one global notification per day', (t) => {
  const env = tempEnv(t);
  const first = checkExternalMcpRateBudget({
    globalUserId: 'user:ran',
    serverId: 'forum.example',
    topicKey: 'thread:1',
    now: '2026-07-01T10:00:00Z',
  }, { env });
  recordExternalMcpNotification({
    globalUserId: 'user:ran',
    serverId: 'forum.example',
    topicKey: 'thread:1',
    now: '2026-07-01T10:00:00Z',
  }, { env });
  const second = checkExternalMcpRateBudget({
    globalUserId: 'user:ran',
    serverId: 'game.local',
    topicKey: 'game:2',
    now: '2026-07-01T12:00:00Z',
  }, { env });

  assert.equal(first.allowed, true);
  assert.equal(second.allowed, false);
  assert.equal(second.reason, 'global_daily_budget_exhausted');
});

test('rate budget enforces per-topic cooldown after global budget window passes', (t) => {
  const env = tempEnv(t);
  recordExternalMcpNotification({
    globalUserId: 'user:ran',
    serverId: 'forum.example',
    topicKey: 'thread:1',
    now: '2026-07-01T10:00:00Z',
  }, { env });

  const sameTopic = checkExternalMcpRateBudget({
    globalUserId: 'user:ran',
    serverId: 'forum.example',
    topicKey: 'thread:1',
    now: '2026-07-02T09:00:00Z',
  }, { env });
  const nextDay = checkExternalMcpRateBudget({
    globalUserId: 'user:ran',
    serverId: 'forum.example',
    topicKey: 'thread:2',
    now: '2026-07-02T10:01:00Z',
  }, { env });

  assert.equal(sameTopic.allowed, false);
  assert.equal(sameTopic.reason, 'topic_cooldown_active');
  assert.equal(nextDay.allowed, true);
});

test('notification reservations block concurrent budget checks until committed or released', (t) => {
  const env = tempEnv(t);
  const firstBudget = checkExternalMcpRateBudget({
    globalUserId: 'user:ran',
    serverId: 'forum.example',
    topicKey: 'thread:1',
  }, { env, now: '2026-07-01T10:00:00Z' });
  const reservation = reserveExternalMcpNotification({
    globalUserId: 'user:ran',
    serverId: 'forum.example',
    topicKey: 'thread:1',
  }, { env, now: '2026-07-01T10:00:00Z' });
  const secondBudget = checkExternalMcpRateBudget({
    globalUserId: 'user:ran',
    serverId: 'forum.example',
    topicKey: 'thread:2',
  }, { env, now: '2026-07-01T10:00:00Z' });

  assert.equal(firstBudget.allowed, true);
  assert.equal(reservation.allowed, true);
  assert.match(reservation.event.reservationId, /^reservation_[a-f0-9]{16}$/);
  assert.equal(secondBudget.allowed, false);
  assert.equal(secondBudget.reason, 'global_daily_budget_exhausted');

  const released = releaseExternalMcpNotificationReservation(reservation.event.reservationId, { env });
  const afterRelease = checkExternalMcpRateBudget({
    globalUserId: 'user:ran',
    serverId: 'forum.example',
    topicKey: 'thread:2',
  }, { env, now: '2026-07-01T10:00:00Z' });
  assert.equal(released.ok, true);
  assert.equal(afterRelease.allowed, true);

  const secondReservation = reserveExternalMcpNotification({
    globalUserId: 'user:ran',
    serverId: 'forum.example',
    topicKey: 'thread:2',
  }, { env, now: '2026-07-01T10:00:00Z' });
  const committed = commitExternalMcpNotificationReservation(secondReservation.event.reservationId, {
    env,
    now: '2026-07-01T10:01:00Z',
  });
  const afterCommit = checkExternalMcpRateBudget({
    globalUserId: 'user:ran',
    serverId: 'forum.example',
    topicKey: 'thread:3',
  }, { env, now: '2026-07-01T10:02:00Z' });
  assert.equal(committed.status, 'sent');
  assert.equal(afterCommit.allowed, false);
  assert.equal(afterCommit.reason, 'global_daily_budget_exhausted');
});

test('watch and notification corruption are quarantined instead of resetting rate limits', (t) => {
  const env = tempEnv(t);
  const directory = `${env.RAN_AGENT_STATE_DIR}/external_mcp`;
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(`${directory}/watchlist.json`, '{', 'utf8');

  assert.throws(
    () => listExternalMcpWatches({ env }),
    (error) => error?.code === 'RAN_AGENT_STATE_CORRUPT',
  );
  assert.equal(fs.readdirSync(directory).some((entry) => entry.startsWith('watchlist.json.corrupt-')), true);

  fs.writeFileSync(`${directory}/notification-events.json`, '{', 'utf8');
  assert.throws(
    () => checkExternalMcpRateBudget({
      globalUserId: 'user:ran', serverId: 'forum.example', topicKey: 'thread:1',
    }, { env }),
    (error) => error?.code === 'RAN_AGENT_STATE_CORRUPT',
  );
  assert.equal(fs.readdirSync(directory).some((entry) => entry.startsWith('notification-events.json.corrupt-')), true);
});
