import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createIsolatedTestEnv } from './helpers/isolatedState.mjs';

import {
  appendExternalMcpEvidence,
  listExternalMcpEvidence,
  sanitizeExternalMcpEvidence,
  verifyExternalMcpEvidenceRefs,
} from '../src/externalMcp/evidenceLog.mjs';

function tempEnv(t) {
  return createIsolatedTestEnv(t, {}, 'external-mcp-evidence-');
}

function rawEvent(overrides = {}) {
  return {
    requestId: 'req-123',
    globalUserId: 'user:ran',
    serverId: 'forum.example',
    toolName: 'forum.read_thread',
    watchScope: 'thread:forum.example/123',
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
  assert.equal(event.watch_scope, 'thread:forum.example/123');
  assert.equal(event.tier, 'T1');
  assert.equal(event.session_mode, 'observe');
  assert.equal(event.trigger, 'proactive');
  assert.equal(event.decision, 'allowed');
  assert.match(event.result_id_hash, /^[a-f0-9]{16}$/);
  assert.match(event.evidence_ref, /^external_mcp_evidence:[a-f0-9]{16}$/);
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
  assert.match(first.evidence_ref, /^external_mcp_evidence:[a-f0-9]{16}$/);
  assert.equal(second.tool_id, 'forum.submit_reply');
  assert.equal(listed.length, 2);
  assert.deepEqual(listed.map((item) => item.request_id), ['req-1', 'req-2']);
  assert.equal(serialized.includes('result-1'), false);
  assert.equal(serialized.includes('result-2'), false);
  assert.equal(serialized.includes('private forum text'), false);
});

test('evidence verifier accepts only trusted matching evidence refs', (t) => {
  const env = tempEnv(t);
  const evidence = appendExternalMcpEvidence(rawEvent({ requestId: 'req-1' }), { env, now: '2026-07-01T10:00:00Z' });

  const trusted = verifyExternalMcpEvidenceRefs({
    refs: [evidence.evidence_ref],
    globalUserId: 'user:ran',
    serverId: 'forum.example',
    watchScope: 'thread:forum.example/123',
    allowedCapabilityTiers: ['T1', 'T2'],
  }, { env, now: '2026-07-01T10:01:00Z' });
  const spoofed = verifyExternalMcpEvidenceRefs({
    refs: ['external_mcp_evidence:spoofed'],
    globalUserId: 'user:ran',
    serverId: 'forum.example',
    watchScope: 'thread:forum.example/123',
    allowedCapabilityTiers: ['T1', 'T2'],
  }, { env, now: '2026-07-01T10:01:00Z' });
  const mismatchedScope = verifyExternalMcpEvidenceRefs({
    refs: [evidence.evidence_ref],
    globalUserId: 'user:ran',
    serverId: 'forum.example',
    watchScope: 'thread:forum.example/other',
    allowedCapabilityTiers: ['T1', 'T2'],
  }, { env, now: '2026-07-01T10:01:00Z' });
  const scopeLessEvidence = appendExternalMcpEvidence(rawEvent({
    requestId: 'req-empty-scope',
    watchScope: '',
    resultId: 'result-empty-scope',
  }), { env, now: '2026-07-01T10:00:30Z' });
  const emptyScopeRejected = verifyExternalMcpEvidenceRefs({
    refs: [scopeLessEvidence.evidence_ref],
    globalUserId: 'user:ran',
    serverId: 'forum.example',
    watchScope: 'thread:forum.example/123',
    allowedCapabilityTiers: ['T1', 'T2'],
  }, { env, now: '2026-07-01T10:01:00Z' });
  const missingTierScope = verifyExternalMcpEvidenceRefs({
    refs: [evidence.evidence_ref],
    globalUserId: 'user:ran',
    serverId: 'forum.example',
    watchScope: 'thread:forum.example/123',
  }, { env, now: '2026-07-01T10:01:00Z' });
  const wrongTier = verifyExternalMcpEvidenceRefs({
    refs: [evidence.evidence_ref],
    globalUserId: 'user:ran',
    serverId: 'forum.example',
    watchScope: 'thread:forum.example/123',
    allowedCapabilityTiers: ['T3'],
  }, { env, now: '2026-07-01T10:01:00Z' });

  assert.equal(trusted.ok, true);
  assert.deepEqual(trusted.trustedRefs, [evidence.evidence_ref]);
  assert.equal(spoofed.ok, false);
  assert.equal(spoofed.reason, 'evidence_not_trusted');
  assert.equal(mismatchedScope.ok, false);
  assert.equal(mismatchedScope.reason, 'evidence_scope_mismatch');
  assert.equal(emptyScopeRejected.ok, false);
  assert.equal(emptyScopeRejected.reason, 'evidence_scope_mismatch');
  assert.equal(missingTierScope.ok, false);
  assert.equal(missingTierScope.reason, 'evidence_tier_scope_required');
  assert.equal(wrongTier.ok, false);
  assert.equal(wrongTier.reason, 'evidence_tier_not_allowed');
});

test('evidence tolerates only an incomplete final JSONL tail and repairs it before append', (t) => {
  const env = tempEnv(t);
  const first = appendExternalMcpEvidence(rawEvent({ requestId: 'req-complete' }), { env, now: '2026-07-01T10:00:00Z' });
  const target = `${env.RAN_AGENT_STATE_DIR}/external_mcp/evidence.jsonl`;
  fs.appendFileSync(target, '{"timestamp":"2026-07-01T10:01:00.000Z"');

  assert.deepEqual(listExternalMcpEvidence({ env }).map((item) => item.evidence_ref), [first.evidence_ref]);
  const second = appendExternalMcpEvidence(rawEvent({ requestId: 'req-repaired' }), { env, now: '2026-07-01T10:02:00Z' });
  assert.deepEqual(listExternalMcpEvidence({ env }).map((item) => item.evidence_ref), [first.evidence_ref, second.evidence_ref]);
});

test('evidence corruption before the final JSONL tail is quarantined and fails closed', (t) => {
  const env = tempEnv(t);
  const target = `${env.RAN_AGENT_STATE_DIR}/external_mcp/evidence.jsonl`;
  fs.mkdirSync(`${env.RAN_AGENT_STATE_DIR}/external_mcp`, { recursive: true });
  fs.writeFileSync(target, '{"not":"an evidence record"}\n{', 'utf8');

  assert.throws(
    () => listExternalMcpEvidence({ env }),
    (error) => error?.code === 'RAN_AGENT_STATE_CORRUPT',
  );
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.readdirSync(`${env.RAN_AGENT_STATE_DIR}/external_mcp`).some((entry) => entry.startsWith('evidence.jsonl.corrupt-')), true);
});
