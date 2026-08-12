import assert from 'node:assert/strict';
import test from 'node:test';

import {
  commitCoreCutover,
  isCoreCutoverCommitted,
} from '../../src/core/coreCutover.mjs';
import { openCoreDatabase } from '../../src/core/coreDb.mjs';
import { createTempCore } from './helpers/testCoreInspector.mjs';

const INPUT = Object.freeze({
  ownerId: 'owner',
  authorizationRef: 'owner-approval:s12:test',
  watermark: '2026-08-08T15:00:00.000Z',
  committedAt: '2026-08-08T15:01:00.000Z',
  candidateSha: 'a'.repeat(40),
  migrationSnapshotDigest: `sha256:${'b'.repeat(64)}`,
  scheduleManifestDigest: `sha256:${'c'.repeat(64)}`,
  visibleBindingDigest: `sha256:${'d'.repeat(64)}`,
  ambiguousOutboxDisposition: 'terminal_no_resend',
  pendingOutboundDisposition: 'suppress',
});

test('cutover authority commits atomically, replays exactly, and rejects conflicting semantics', async (t) => {
  const { dbPath } = createTempCore(t, 'hermes-core-cutover-');
  const core = openCoreDatabase({ dbPath });
  core.migrate();
  let applies = 0;
  const apply = (tx) => {
    applies += 1;
    tx.activities.create({
      activityId: 'imported-paused', ownerId: 'owner', title: 'Imported paused task',
      goalRef: 'legacy:test', domain: 'personal', riskClass: 'reversible',
      state: 'paused', contractRevision: 0, resumePolicy: 'manual', reportPolicy: 'milestone',
      createdAt: INPUT.committedAt,
    });
  };

  assert.equal(isCoreCutoverCommitted(core), false);
  assert.equal((await commitCoreCutover({ core, input: INPUT, apply })).disposition, 'applied');
  assert.equal(isCoreCutoverCommitted(core), true);
  assert.equal((await commitCoreCutover({ core, input: INPUT, apply })).disposition, 'already_applied');
  assert.equal(applies, 1);
  assert.equal(core.reader.activity('imported-paused').state, 'paused');
  await assert.rejects(commitCoreCutover({
    core, input: { ...INPUT, watermark: '2026-08-08T15:00:01.000Z' }, apply,
  }), { code: 'CORE_CUTOVER_CONFLICT' });
  await assert.rejects(commitCoreCutover({
    core, input: { ...INPUT, visibleBindingDigest: `sha256:${'e'.repeat(64)}` }, apply,
  }), { code: 'CORE_CUTOVER_CONFLICT' });
  assert.equal(applies, 1);
  await core.close();
});

test('cutover apply failure rolls back imports and authority marker together', async (t) => {
  const { dbPath } = createTempCore(t, 'hermes-core-cutover-rollback-');
  const core = openCoreDatabase({ dbPath });
  core.migrate();
  await assert.rejects(commitCoreCutover({
    core,
    input: INPUT,
    apply: (tx) => {
      tx.activities.create({
        activityId: 'must-rollback', ownerId: 'owner', title: 'Rollback task',
        goalRef: 'legacy:test', domain: 'personal', riskClass: 'reversible',
        state: 'paused', contractRevision: 0, resumePolicy: 'manual', reportPolicy: 'milestone',
        createdAt: INPUT.committedAt,
      });
      throw new Error('synthetic cutover failure');
    },
  }), /synthetic cutover failure/);
  assert.equal(core.reader.activity('must-rollback'), undefined);
  assert.equal(isCoreCutoverCommitted(core), false);
  await core.close();
});
