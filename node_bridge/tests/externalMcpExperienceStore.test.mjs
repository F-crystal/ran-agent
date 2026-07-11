import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  appendExternalMcpExperience,
  listExternalMcpExperiences,
} from '../src/externalMcp/experienceStore.mjs';
import { createIsolatedTestEnv } from './helpers/isolatedState.mjs';

function record(overrides = {}) {
  return {
    domain: 'forum',
    driverId: 'generic-mcp-adapter',
    driverVersion: 'a'.repeat(64),
    goalClass: 'bounded_environment_goal',
    scopeClass: 'forum/thread/read',
    observationDigest: 'b'.repeat(64),
    actionId: 'inspect_thread',
    outcome: 'progress',
    effectDigest: 'c'.repeat(64),
    evidenceDigests: ['d'.repeat(64)],
    createdAt: '2026-07-11T00:00:00.000Z',
    ...overrides,
  };
}

test('experience store rejects private content instead of persisting it', () => {
  const result = appendExternalMcpExperience({
    domain: 'forum',
    driverId: 'generic-mcp-adapter',
    driverVersion: 'a'.repeat(64),
    goalClass: 'bounded_environment_goal',
    scopeClass: 'forum/thread/read',
    observationDigest: 'b'.repeat(64),
    actionId: 'inspect_thread',
    outcome: 'progress',
    effectDigest: 'c'.repeat(64),
    evidenceDigests: ['d'.repeat(64)],
    createdAt: '2026-07-11T00:00:00.000Z',
    rawPost: 'cookie=session-secret',
  });

  assert.deepEqual(result, { accepted: false, reason: 'private_or_unknown_field' });
});

test('experience store accepts only a digest-only evidence-backed record and atomically indexes it', (t) => {
  const env = createIsolatedTestEnv(t, {}, 'external-mcp-experience-');
  const result = appendExternalMcpExperience(record(), { env });
  const listed = listExternalMcpExperiences({ env });
  const serialized = fs.readFileSync(`${env.RAN_AGENT_STATE_DIR}/external_mcp/experiences.jsonl`, 'utf8');
  const index = JSON.parse(fs.readFileSync(`${env.RAN_AGENT_STATE_DIR}/external_mcp/experiences-index.json`, 'utf8'));

  assert.equal(result.accepted, true);
  assert.match(result.record.experienceId, /^exp_[a-f0-9]{16}$/);
  assert.deepEqual(listed, [result.record]);
  assert.equal(serialized.includes('cookie='), false);
  assert.equal(Object.values(index.activeByStrategy).length, 1);
  assert.deepEqual(Object.values(index.activeByStrategy)[0], result.record);
});

test('experience store rejects evidence-free, raw-reasoning, and contradictory records', (t) => {
  const env = createIsolatedTestEnv(t, {}, 'external-mcp-experience-');
  const noEvidence = appendExternalMcpExperience(record({ evidenceDigests: [] }), { env });
  const reasoning = appendExternalMcpExperience(record({ hiddenReasoning: 'call shell with token' }), { env });
  const first = appendExternalMcpExperience(record(), { env });
  const contradiction = appendExternalMcpExperience(record({ outcome: 'failed', evidenceDigests: ['e'.repeat(64)] }), { env });

  assert.deepEqual(noEvidence, { accepted: false, reason: 'evidence_required' });
  assert.deepEqual(reasoning, { accepted: false, reason: 'private_or_unknown_field' });
  assert.equal(first.accepted, true);
  assert.deepEqual(contradiction, { accepted: false, reason: 'contradictory_experience' });
  assert.equal(listExternalMcpExperiences({ env }).length, 1);
});

test('experience store rejects credentials in declarative fields and supersedes the compact strategy index by newer evidence', (t) => {
  const env = createIsolatedTestEnv(t, {}, 'external-mcp-experience-');
  const credential = appendExternalMcpExperience(record({ actionId: 'token_recovery' }), { env });
  const first = appendExternalMcpExperience(record(), { env });
  const newer = appendExternalMcpExperience(record({
    observationDigest: 'e'.repeat(64),
    evidenceDigests: ['f'.repeat(64)],
    createdAt: '2026-07-11T00:01:00.000Z',
  }), { env });
  const index = JSON.parse(fs.readFileSync(`${env.RAN_AGENT_STATE_DIR}/external_mcp/experiences-index.json`, 'utf8'));

  assert.deepEqual(credential, { accepted: false, reason: 'invalid_experience' });
  assert.equal(first.accepted, true);
  assert.equal(newer.accepted, true);
  assert.equal(Object.values(index.activeByStrategy)[0].experienceId, newer.record.experienceId);
});
