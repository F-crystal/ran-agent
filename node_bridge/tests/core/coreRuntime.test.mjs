import assert from 'node:assert/strict';
import test from 'node:test';

import { commitCoreCutover } from '../../src/core/coreCutover.mjs';
import { openCoreDatabase } from '../../src/core/coreDb.mjs';
import { bindCoreChannelHub, openCommittedCoreRuntime } from '../../src/core/coreRuntime.mjs';
import { createTempCore } from './helpers/testCoreInspector.mjs';

const CUTOVER = Object.freeze({
  ownerId: 'owner', authorizationRef: 'owner-approval:s12:test',
  watermark: '2026-08-08T15:00:00.000Z', committedAt: '2026-08-08T15:01:00.000Z',
  candidateSha: 'a'.repeat(40), migrationSnapshotDigest: `sha256:${'b'.repeat(64)}`,
  scheduleManifestDigest: `sha256:${'c'.repeat(64)}`,
  visibleBindingDigest: `sha256:${'d'.repeat(64)}`,
  ambiguousOutboxDisposition: 'terminal_no_resend', pendingOutboundDisposition: 'suppress',
});

test('Node Core lifecycle stays disabled until the cutover marker and hash authority exist', async (t) => {
  const { root, dbPath } = createTempCore(t, 'hermes-core-runtime-');
  assert.equal(await openCommittedCoreRuntime({}), null);
  await assert.rejects(openCommittedCoreRuntime({
    RAN_AGENT_CORE_ENABLED: 'true', RAN_AGENT_STATE_DIR: root,
  }), { code: 'CORE_RUNTIME_DATABASE_MISSING' });

  const seeded = openCoreDatabase({ dbPath });
  seeded.migrate();
  await seeded.close();
  await assert.rejects(openCommittedCoreRuntime({
    RAN_AGENT_CORE_ENABLED: 'true', RAN_AGENT_STATE_DIR: root,
    RAN_AGENT_CORE_HASH_KEY_ID: 'test', RAN_AGENT_CORE_HASH_KEY: 'secret',
  }), { code: 'CORE_CUTOVER_NOT_COMMITTED' });

  const candidate = openCoreDatabase({ dbPath });
  await commitCoreCutover({ core: candidate, input: CUTOVER, apply() {} });
  await candidate.close();
  const runtime = await openCommittedCoreRuntime({
    RAN_AGENT_CORE_ENABLED: 'true', RAN_AGENT_STATE_DIR: root,
    RAN_AGENT_CORE_HASH_KEY_ID: 'test', RAN_AGENT_CORE_HASH_KEY: 'secret',
  });
  const received = await bindCoreChannelHub(async (_message, options) => options, runtime)({ id: 'x' });
  assert.equal(received.core, runtime.core);
  assert.match(received.coreContentHasher('test', 'value'), /^hmac-sha256:v1:test:/);
  await runtime.core.close();
});
