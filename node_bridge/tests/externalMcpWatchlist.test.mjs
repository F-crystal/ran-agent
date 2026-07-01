import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  addExternalMcpWatch,
  checkExternalMcpRateBudget,
  listExternalMcpWatches,
  recordExternalMcpNotification,
  removeExternalMcpWatch,
} from '../src/externalMcp/watchlist.mjs';

function tempEnv(t) {
  const base = path.join(process.cwd(), '.tmp-test-external-mcp-watchlist');
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'case-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    try {
      fs.rmdirSync(base);
    } catch {
      // Other tests may still own sibling temp dirs.
    }
  });
  return { RAN_AGENT_STATE_DIR: root };
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
