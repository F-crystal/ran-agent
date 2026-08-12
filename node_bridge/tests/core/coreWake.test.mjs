import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { commitCoreCutover } from '../../src/core/coreCutover.mjs';
import { openCoreDatabase } from '../../src/core/coreDb.mjs';
import { runCoreWakeFromEnvironment, wakeCommittedCore } from '../../src/core/coreWake.mjs';
import { createTempCore } from './helpers/testCoreInspector.mjs';

const CUTOVER = Object.freeze({
  ownerId: 'owner', authorizationRef: 'owner-approval:s12:test',
  watermark: '2026-08-08T15:00:00.000Z', committedAt: '2026-08-08T15:01:00.000Z',
  candidateSha: 'a'.repeat(40), migrationSnapshotDigest: `sha256:${'b'.repeat(64)}`,
  scheduleManifestDigest: `sha256:${'c'.repeat(64)}`,
  visibleBindingDigest: `sha256:${'d'.repeat(64)}`,
  ambiguousOutboxDisposition: 'terminal_no_resend', pendingOutboundDisposition: 'suppress',
});

test('managed wake refuses pre-cutover Core and reads no caller time', async (t) => {
  const { root, dbPath } = createTempCore(t, 'hermes-core-wake-');
  await assert.rejects(runCoreWakeFromEnvironment({
    RAN_AGENT_CORE_WAKE_ENABLED: 'true', RAN_AGENT_STATE_DIR: root,
  }), { code: 'CORE_WAKE_DATABASE_MISSING' });
  assert.equal(fs.existsSync(dbPath), false);

  const core = openCoreDatabase({ dbPath });
  core.migrate();
  await assert.rejects(wakeCommittedCore({ core }), { code: 'CORE_CUTOVER_NOT_COMMITTED' });
  await commitCoreCutover({ core, input: CUTOVER, apply() {} });
  assert.deepEqual(await wakeCommittedCore({ core }), {
    checked: true, schedules: 0, occurrences: 0, occurrenceIds: [],
  });
  await core.close();
});

test('managed wake requires its deploy-owned disabled-by-default switch', async () => {
  await assert.rejects(runCoreWakeFromEnvironment({}), { code: 'CORE_WAKE_DISABLED' });
});
