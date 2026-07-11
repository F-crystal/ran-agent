import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createIsolatedTestEnv } from './helpers/isolatedState.mjs';

import {
  closeExternalMcpSession,
  getExternalMcpSession,
  listExternalMcpSessions,
  openExternalMcpSession,
  updateExternalMcpSession,
} from '../src/externalMcp/sessionManager.mjs';

function tempEnv(t) {
  return createIsolatedTestEnv(t, {}, 'external-mcp-session-');
}

test('session manager opens user-bound observe sessions with random ids', (t) => {
  const env = tempEnv(t);
  const session = openExternalMcpSession({
    globalUserId: 'user:ran',
    serverId: 'forum.example',
    mode: 'observe',
    ttlMinutes: 10,
    now: '2026-07-01T10:00:00Z',
  }, { env });

  assert.equal(session.ok, true);
  assert.match(session.sessionId, /^extmcp_[a-f0-9]{24}$/);
  assert.match(session.sessionKey, /^user:ran:forum\.example:observe:extmcp_[a-f0-9]{24}$/);
  assert.equal(session.mode, 'observe');
  assert.equal(session.status, 'active');

  const loaded = getExternalMcpSession(session.sessionId, {
    env,
    globalUserId: 'user:ran',
    serverId: 'forum.example',
    now: '2026-07-01T10:01:00Z',
  });
  assert.equal(loaded.sessionId, session.sessionId);
  assert.equal(loaded.sessionKey, session.sessionKey);
});

test('session manager denies cross-user and cross-server session reuse', (t) => {
  const env = tempEnv(t);
  const session = openExternalMcpSession({
    globalUserId: 'user:ran',
    serverId: 'forum.example',
    mode: 'interactive',
    now: '2026-07-01T10:00:00Z',
  }, { env });

  assert.equal(getExternalMcpSession(session.sessionId, {
    env,
    globalUserId: 'user:other',
    serverId: 'forum.example',
    now: '2026-07-01T10:01:00Z',
  }), null);
  assert.equal(getExternalMcpSession(session.sessionId, {
    env,
    globalUserId: 'user:ran',
    serverId: 'game.local',
    now: '2026-07-01T10:01:00Z',
  }), null);
});

test('session manager expires sessions and omits expired sessions from active lookup', (t) => {
  const env = tempEnv(t);
  const session = openExternalMcpSession({
    globalUserId: 'user:ran',
    serverId: 'forum.example',
    mode: 'observe',
    ttlMinutes: 5,
    now: '2026-07-01T10:00:00Z',
  }, { env });

  const expired = getExternalMcpSession(session.sessionId, {
    env,
    globalUserId: 'user:ran',
    serverId: 'forum.example',
    now: '2026-07-01T10:06:00Z',
  });

  assert.equal(expired, null);
  assert.deepEqual(listExternalMcpSessions({ env, now: '2026-07-01T10:06:00Z' }), []);
});

test('session manager refuses proactive write sessions', (t) => {
  const env = tempEnv(t);
  const result = openExternalMcpSession({
    globalUserId: 'user:ran',
    serverId: 'game.local',
    mode: 'write',
    trigger: 'proactive',
    now: '2026-07-01T10:00:00Z',
  }, { env });

  assert.equal(result.ok, false);
  assert.equal(result.error_code, 'EXTERNAL_MCP_PROACTIVE_WRITE_SESSION_DENIED');
});

test('session manager closes sessions by marking them closed', (t) => {
  const env = tempEnv(t);
  const session = openExternalMcpSession({
    globalUserId: 'user:ran',
    serverId: 'forum.example',
    mode: 'observe',
    now: '2026-07-01T10:00:00Z',
  }, { env });

  const closed = closeExternalMcpSession(session.sessionId, {
    env,
    globalUserId: 'user:ran',
    serverId: 'forum.example',
    now: '2026-07-01T10:02:00Z',
  });

  assert.equal(closed.status, 'closed');
  assert.equal(getExternalMcpSession(session.sessionId, {
    env,
    globalUserId: 'user:ran',
    serverId: 'forum.example',
    now: '2026-07-01T10:03:00Z',
  }), null);
});

test('session manager stores upstream MCP session ids privately', (t) => {
  const env = tempEnv(t);
  const session = openExternalMcpSession({
    globalUserId: 'user:ran',
    serverId: 'cedartoy-games',
    mode: 'interactive',
    now: '2026-07-01T10:00:00Z',
  }, { env });

  const updated = updateExternalMcpSession(session.sessionId, {
    upstreamSessionId: 'remote-session-1',
  }, {
    env,
    globalUserId: 'user:ran',
    serverId: 'cedartoy-games',
    now: '2026-07-01T10:01:00Z',
  });
  const loaded = getExternalMcpSession(session.sessionId, {
    env,
    globalUserId: 'user:ran',
    serverId: 'cedartoy-games',
    now: '2026-07-01T10:02:00Z',
  });

  assert.equal(updated.upstreamSessionId, 'remote-session-1');
  assert.equal(loaded.upstreamSessionId, 'remote-session-1');
});

test('session corruption is quarantined instead of being treated as no active sessions', (t) => {
  const env = tempEnv(t);
  const directory = `${env.RAN_AGENT_STATE_DIR}/external_mcp`;
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(`${directory}/sessions.json`, '{', 'utf8');

  assert.throws(
    () => listExternalMcpSessions({ env }),
    (error) => error?.code === 'RAN_AGENT_STATE_CORRUPT',
  );
  assert.equal(fs.existsSync(`${directory}/sessions.json`), false);
  assert.equal(fs.readdirSync(directory).some((entry) => entry.startsWith('sessions.json.corrupt-')), true);
});
