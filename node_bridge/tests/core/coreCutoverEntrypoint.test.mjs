import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const ROOT = path.resolve(new URL('../../..', import.meta.url).pathname);
const SCRIPT = path.join(ROOT, 'scripts/core-cutover.mjs');
const CANDIDATE = 'a'.repeat(40);

function command(extra = [], env = process.env) {
  return spawnSync(process.execPath, [SCRIPT,
    '--mode', 'apply', '--core-db', '/missing/core.sqlite3', '--snapshot', '/missing/snapshot.json',
    '--system-manifest', '/missing/system.json', '--visible-binding', '/missing/binding.json',
    '--candidate-sha', CANDIDATE, '--committed-at', '2026-08-12T00:00:00.000Z',
    '--owner-id', 'owner', '--authorization-ref', 'auth', ...extra,
  ], { encoding: 'utf8', env });
}

test('Core cutover apply refuses direct subordinate invocation without the S12 journal', () => {
  const result = command();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--mode apply requires --s12-transaction/);
});

test('Core cutover apply requires the exact durable P4 S12 authority chain', (t) => {
  const artifact = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'core-cutover-entrypoint-')));
  t.after(() => fs.rmSync(artifact, { recursive: true, force: true }));
  const directory = path.join(artifact, 's12-transactions', 's12-test');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const journal = path.join(directory, 'transaction.json');
  fs.writeFileSync(journal, `${JSON.stringify({
    schemaVersion: 1, status: 'IN_PROGRESS', phase: 'P3_LEGACY_RECONCILED',
    completedPhases: ['P0_VERIFIED', 'P1_SOURCE_APPLIED', 'P2_CORE_PREPARED', 'P3_LEGACY_RECONCILED'],
    cutoverCommitted: false, candidateSha: CANDIDATE, ownerId: 'owner', authorizationRef: 'auth',
    coreDb: '/missing/core.sqlite3',
  })}\n`, { mode: 0o600 });
  const result = command(['--s12-transaction', journal], {
    ...process.env, RAN_AGENT_RELEASE_ARTIFACT_ROOT: artifact,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /journal does not authorize Core cutover/);
});

test('exact P4 journal authorizes only the existing atomic cutover subordinate', (t) => {
  const artifact = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'core-cutover-entrypoint-')));
  t.after(() => fs.rmSync(artifact, { recursive: true, force: true }));
  const directory = path.join(artifact, 's12-transactions', 's12-test');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const journal = path.join(directory, 'transaction.json');
  fs.writeFileSync(journal, `${JSON.stringify({
    schemaVersion: 1, status: 'IN_PROGRESS', phase: 'P4_QUIESCED',
    completedPhases: ['P0_VERIFIED', 'P1_SOURCE_APPLIED', 'P2_CORE_PREPARED',
      'P3_LEGACY_RECONCILED', 'P4_QUIESCED'],
    cutoverCommitted: false, candidateSha: CANDIDATE, ownerId: 'owner', authorizationRef: 'auth',
    coreDb: '/missing/core.sqlite3',
  })}\n`, { mode: 0o600 });
  const result = command(['--s12-transaction', journal], {
    ...process.env, RAN_AGENT_RELEASE_ARTIFACT_ROOT: artifact,
  });
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stderr, /S12 transaction journal/);
  assert.match(result.stderr, /ENOENT|cutover input/i);
});
