import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  appendExternalMcpEvidence,
  listExternalMcpEvidence,
  sanitizeExternalMcpEvidence,
} from '../src/externalMcp/evidenceLog.mjs';

function tempEnv(t) {
  const base = path.join(process.cwd(), '.tmp-test-external-mcp-evidence');
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

function rawEvent(overrides = {}) {
  return {
    requestId: 'req-123',
    globalUserId: 'user:ran',
    serverId: 'forum.example',
    toolName: 'forum.read_thread',
    tier: 'T1',
    sessionMode: 'observe',
    trigger: 'proactive',
    decision: 'allowed',
    resultId: 'private-result-id',
    result: {
      ok: true,
      rawText: 'private forum text with cookie=session-secret',
      path: '/Users/fengran/private/forum-cache.sqlite',
    },
    error: 'Authorization: Bearer secret-token',
    sessionId: 'extmcp_private_session_id',
    ...overrides,
  };
}

test('evidence sanitizer keeps proof fields and redacts raw payloads', () => {
  const event = sanitizeExternalMcpEvidence(rawEvent());
  const serialized = JSON.stringify(event);

  assert.equal(event.request_id, 'req-123');
  assert.equal(event.global_user_id, 'user:ran');
  assert.equal(event.server_id, 'forum.example');
  assert.equal(event.tool_id, 'forum.read_thread');
  assert.equal(event.tier, 'T1');
  assert.equal(event.session_mode, 'observe');
  assert.equal(event.trigger, 'proactive');
  assert.equal(event.decision, 'allowed');
  assert.match(event.result_id_hash, /^[a-f0-9]{16}$/);
  assert.equal(serialized.includes('private-result-id'), false);
  assert.equal(serialized.includes('session-secret'), false);
  assert.equal(serialized.includes('/Users/fengran'), false);
  assert.equal(serialized.includes('secret-token'), false);
  assert.equal(serialized.includes('extmcp_private_session_id'), false);
});

test('evidence sanitizer preserves activity trigger for autonomous MCP loops', () => {
  const event = sanitizeExternalMcpEvidence(rawEvent({ trigger: 'activity' }));

  assert.equal(event.trigger, 'activity');
});

test('evidence log appends and lists sanitized JSONL events', (t) => {
  const env = tempEnv(t);
  const first = appendExternalMcpEvidence(rawEvent({ requestId: 'req-1', resultId: 'result-1' }), { env, now: '2026-07-01T10:00:00Z' });
  const second = appendExternalMcpEvidence(rawEvent({
    requestId: 'req-2',
    toolName: 'forum.submit_reply',
    tier: 'T4',
    sessionMode: 'write',
    decision: 'confirmation_required',
    resultId: 'result-2',
  }), { env, now: '2026-07-01T10:01:00Z' });

  const listed = listExternalMcpEvidence({ env });
  const serialized = JSON.stringify(listed);

  assert.equal(first.request_id, 'req-1');
  assert.equal(second.tool_id, 'forum.submit_reply');
  assert.equal(listed.length, 2);
  assert.deepEqual(listed.map((item) => item.request_id), ['req-1', 'req-2']);
  assert.equal(serialized.includes('result-1'), false);
  assert.equal(serialized.includes('result-2'), false);
  assert.equal(serialized.includes('private forum text'), false);
});
