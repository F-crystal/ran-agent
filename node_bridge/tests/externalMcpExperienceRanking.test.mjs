import assert from 'node:assert/strict';
import test from 'node:test';

import { rankExternalMcpExperiences } from '../src/externalMcp/experienceRanking.mjs';

function experience(overrides = {}) {
  return {
    experienceId: 'exp_1234567890abcdef',
    domain: 'game',
    driverId: 'generic-mcp-adapter',
    driverVersion: 'a'.repeat(64),
    goalClass: 'bounded_environment_goal',
    scopeClass: 'game/slot/play',
    observationDigest: 'b'.repeat(64),
    actionId: 'inspect_room',
    outcome: 'progress',
    effectDigest: 'c'.repeat(64),
    evidenceDigests: ['d'.repeat(64)],
    createdAt: '2026-07-11T00:00:00.000Z',
    ...overrides,
  };
}

function query(overrides = {}) {
  return {
    domain: 'game',
    driverId: 'generic-mcp-adapter',
    driverVersion: 'a'.repeat(64),
    goalClass: 'bounded_environment_goal',
    scopeClass: 'game/slot/play',
    observationDigest: 'b'.repeat(64),
    legalActions: [{ actionId: 'inspect_room', availability: 'available' }],
    ...overrides,
  };
}

test('experience ranking returns bounded advisory results only for current matching legal actions', () => {
  const result = rankExternalMcpExperiences([
    experience(),
    experience({ experienceId: 'exp_abcdef1234567890', actionId: 'open_door', outcome: 'completed', evidenceDigests: ['e'.repeat(64)] }),
  ], query({
    legalActions: [
      { actionId: 'inspect_room', availability: 'available' },
      { actionId: 'open_door', availability: 'available' },
    ],
    maxResults: 1,
  }));

  assert.equal(result.length, 1);
  assert.equal(result[0].proven, true);
  assert.equal(result[0].actionId, 'inspect_room');
  assert.equal(Object.hasOwn(result[0], 'evidenceDigests'), false);
  assert.equal(Object.hasOwn(result[0], 'effectDigest'), false);
});

test('experience ranking excludes cross-domain, stale-driver, and unsafe-action records', () => {
  const records = [
    experience({ domain: 'forum', experienceId: 'exp_abcdef1234567890' }),
    experience({ driverVersion: 'e'.repeat(64), experienceId: 'exp_abcdef1234567891' }),
    experience(),
  ];

  assert.deepEqual(rankExternalMcpExperiences(records, query()), [{
    proven: true, actionId: 'inspect_room', outcome: 'progress', score: 1,
  }]);
  assert.deepEqual(rankExternalMcpExperiences([experience()], query({
    legalActions: [{ actionId: 'inspect_room', availability: 'available', unsafe: true }],
  })), []);
});

test('experience ranking demotes repeated failed strategies and never invents an action', () => {
  const records = [
    experience(),
    experience({ experienceId: 'exp_abcdef1234567890', outcome: 'failed', observationDigest: 'e'.repeat(64), evidenceDigests: ['e'.repeat(64)] }),
    experience({ experienceId: 'exp_abcdef1234567891', outcome: 'failed', observationDigest: 'f'.repeat(64), evidenceDigests: ['f'.repeat(64)] }),
  ];

  assert.deepEqual(rankExternalMcpExperiences(records, query({ observationDigest: 'e'.repeat(64) })), []);
  assert.deepEqual(rankExternalMcpExperiences(records, query({ legalActions: [{ actionId: 'invented', availability: 'available' }] })), []);
});
