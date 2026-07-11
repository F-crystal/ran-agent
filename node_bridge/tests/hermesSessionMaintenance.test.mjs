import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  buildHermesLiteContinuityDigest,
  getHermesLiteSoftResetConfig,
  readHermesLiteMaintenanceState,
  runHermesLiteSoftReset,
} from '../src/hermesSessionMaintenance.mjs';
import { createIsolatedTestEnv } from './helpers/isolatedState.mjs';

function maintenanceEnv(t, overrides = {}) {
  const env = createIsolatedTestEnv(t, overrides, 'ran-agent-hermes-maintenance-');
  return {
    ...env,
    RAN_AGENT_GLOBAL_TIMELINE_PATH: path.join(env.RAN_AGENT_STATE_DIR, 'global.jsonl'),
    HERMES_LITE_SOFT_RESET_ENABLED: 'true',
    HERMES_LITE_SOFT_RESET_DRY_RUN: 'false',
    ...overrides,
  };
}

const sampleRecords = [
  { role: 'user', text: `请继续排查 Hermes token 用量，不要保存这段超长用户原文 ${'敏感原文'.repeat(120)}`, created_at: 1 },
  { role: 'assistant', text_summary: 'pending: 明天继续观察 prompt_cache_hit_tokens 和 input_tokens', created_at: 2 },
  { role: 'user', text: '偏好：日常聊天保持 slim，不要解释 session/token 机制', created_at: 3 },
  { role: 'assistant', text: 'recent artifact: node_bridge/src/hermesGatewayClient.mjs 已完成 B 包', created_at: 4 },
  { role: 'user', text: '已结束：不要继续携带小红书旧链接调试上下文', created_at: 5 },
];

test('soft reset disabled is a no-op and does not create state file', (t) => {
  const env = maintenanceEnv(t, { HERMES_LITE_SOFT_RESET_ENABLED: 'false' });
  const result = runHermesLiteSoftReset({ action: 'apply', env, timelineRecords: sampleRecords, now: new Date('2026-06-14T00:00:00Z') });

  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'disabled');
  assert.equal(fs.existsSync(getHermesLiteSoftResetConfig(env).stateFile), false);
});

test('dry-run reports planned rotation without writing session pointer', (t) => {
  const env = maintenanceEnv(t, { HERMES_LITE_SOFT_RESET_DRY_RUN: 'true' });
  const result = runHermesLiteSoftReset({ action: 'apply', env, timelineRecords: sampleRecords, now: new Date('2026-06-14T00:00:00Z') });

  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.wouldRotate, true);
  assert.equal(fs.existsSync(getHermesLiteSoftResetConfig(env).stateFile), false);
  assert.match(result.digest.digestId, /^[a-f0-9]{16}$/);
});

test('apply writes bounded digest and new lite session pointer', (t) => {
  const env = maintenanceEnv(t);
  const result = runHermesLiteSoftReset({ action: 'apply', env, timelineRecords: sampleRecords, now: new Date('2026-06-14T00:00:00Z'), reason: 'nightly' });
  const config = getHermesLiteSoftResetConfig(env);
  const state = readHermesLiteMaintenanceState(config);

  assert.equal(result.ok, true);
  assert.equal(result.applied, true);
  assert.match(state.currentSessionNonce, /^lite-/);
  assert.equal(state.pendingDigestId, result.digest.digestId);
  assert.equal(state.lastReset.reason, 'nightly');
  assert.equal(fs.existsSync(path.join(config.digestDir, `${result.digest.digestId}.json`)), true);
  assert.match(state.lastReset.oldSessionIdHash, /^[a-f0-9]{16}$/);
  assert.match(state.lastReset.newSessionIdHash, /^[a-f0-9]{16}$/);
});

test('digest is bounded, structured, and avoids large raw user text', () => {
  const digest = buildHermesLiteContinuityDigest({
    records: sampleRecords,
    maxChars: 420,
    keepLastN: 4,
    now: new Date('2026-06-14T00:00:00Z'),
    sourceSessionNonce: 'old-session',
  });

  assert.equal(digest.date, '2026-06-14');
  assert.equal(digest.profile, 'lite');
  assert.match(digest.sourceSessionIdHash, /^[a-f0-9]{16}$/);
  for (const key of ['open_threads', 'pending_commitments', 'active_preferences', 'recent_artifacts', 'do_not_carry']) {
    assert.ok(Array.isArray(digest[key]), key);
    assert.ok(digest[key].length <= 5, key);
  }
  assert.ok(JSON.stringify(digest).length <= 420);
  assert.equal(JSON.stringify(digest).includes('敏感原文'.repeat(20)), false);
});

test('rollback-last restores previous lite session pointer without deleting digest', (t) => {
  const env = maintenanceEnv(t);
  const first = runHermesLiteSoftReset({ action: 'apply', env, timelineRecords: sampleRecords, now: new Date('2026-06-14T00:00:00Z') });
  const second = runHermesLiteSoftReset({ action: 'apply', env, timelineRecords: sampleRecords, now: new Date('2026-06-15T00:00:00Z') });
  const config = getHermesLiteSoftResetConfig(env);
  const secondDigestPath = path.join(config.digestDir, `${second.digest.digestId}.json`);

  const rollback = runHermesLiteSoftReset({ action: 'rollback-last', env, now: new Date('2026-06-15T01:00:00Z') });
  const state = readHermesLiteMaintenanceState(config);

  assert.equal(rollback.ok, true);
  assert.equal(rollback.rolledBack, true);
  assert.equal(state.currentSessionNonce, first.newSessionNonce);
  assert.equal(fs.existsSync(secondDigestPath), true);
});

test('soft reset revisions reject stale compare-and-swap without changing state', (t) => {
  const env = maintenanceEnv(t);
  const first = runHermesLiteSoftReset({
    action: 'apply',
    expectedRevision: 0,
    env,
    timelineRecords: sampleRecords,
    now: new Date('2026-06-14T00:00:00Z'),
  });
  assert.equal(first.revision, 1);

  const stale = runHermesLiteSoftReset({
    action: 'apply',
    expectedRevision: 0,
    env,
    timelineRecords: sampleRecords,
    now: new Date('2026-06-15T00:00:00Z'),
  });
  assert.deepEqual(stale, {
    ok: false,
    error: 'stale_revision',
    expectedRevision: 0,
    currentRevision: 1,
  });
  assert.equal(readHermesLiteMaintenanceState(env).revision, 1);
});

test('legacy maintenance state without revision remains compatible and upgrades on write', (t) => {
  const env = maintenanceEnv(t);
  const config = getHermesLiteSoftResetConfig(env);
  fs.mkdirSync(path.dirname(config.stateFile), { recursive: true });
  fs.writeFileSync(config.stateFile, JSON.stringify({
    version: 1,
    profile: 'lite',
    currentSessionNonce: 'legacy-lite-session',
    digests: [],
    rollbackStack: [],
  }));

  assert.equal(readHermesLiteMaintenanceState(config).revision, 0);
  const result = runHermesLiteSoftReset({
    action: 'apply',
    expectedRevision: 0,
    env,
    timelineRecords: sampleRecords,
    now: new Date('2026-06-14T00:00:00Z'),
  });
  assert.equal(result.revision, 1);
  assert.equal(readHermesLiteMaintenanceState(config).revision, 1);
});
