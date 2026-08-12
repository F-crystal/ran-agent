import assert from 'node:assert/strict';
import test from 'node:test';

import { commitCoreCutover } from '../../src/core/coreCutover.mjs';
import { openCoreDatabase } from '../../src/core/coreDb.mjs';
import { applyCoreScheduleCutover } from '../../src/core/coreScheduleCutover.mjs';
import { createTempCore, openTestInspector } from './helpers/testCoreInspector.mjs';

const WATERMARK = '2026-08-08T15:00:00.000Z';
const COMMITTED_AT = '2026-08-08T15:01:00.000Z';

function snapshot() {
  return {
    staged: {
      reminders: [{ sourceRef: 'legacy-todo:7', scheduledFor: '2026-08-09T00:00:00.000Z', state: 'paused' }],
      externalWatches: [{ sourceRef: `legacy-external-watch:sha256:${'1'.repeat(64)}`, state: 'paused' }],
      externalActivities: [{ sourceRef: `legacy-external-activity:sha256:${'2'.repeat(64)}`, state: 'paused' }],
    },
    counts: {
      historicalReminders: 3,
      pendingOutboundMessages: 1,
      outboxStates: { ambiguous: 65, sending: 0 },
    },
    sourceDigests: {
      legacyDatabase: `sha256:${'3'.repeat(64)}`,
      legacyOutbox: `sha256:${'4'.repeat(64)}`,
      pendingOutbound: `sha256:${'5'.repeat(64)}`,
    },
  };
}

test('cutover imports only paused candidates and records aggregate no-resend evidence', async (t) => {
  const { dbPath } = createTempCore(t, 'hermes-core-schedule-cutover-');
  const core = openCoreDatabase({ dbPath, now: () => new Date(COMMITTED_AT) });
  core.migrate();
  const result = await commitCoreCutover({
    core,
    input: {
      ownerId: 'owner', authorizationRef: 'owner-approval:s12:test',
      watermark: WATERMARK, committedAt: COMMITTED_AT, candidateSha: 'a'.repeat(40),
      migrationSnapshotDigest: `sha256:${'b'.repeat(64)}`,
      scheduleManifestDigest: `sha256:${'c'.repeat(64)}`,
      visibleBindingDigest: `sha256:${'d'.repeat(64)}`,
      ambiguousOutboxDisposition: 'terminal_no_resend', pendingOutboundDisposition: 'suppress',
    },
    apply: (tx) => applyCoreScheduleCutover(tx, {
      snapshot: snapshot(), ownerId: 'owner', createdAt: COMMITTED_AT,
    }),
  });
  assert.equal(result.disposition, 'applied');
  const inspector = openTestInspector(dbPath);
  assert.equal(inspector.prepare("SELECT count(*) AS count FROM activity WHERE state='paused'").get().count, 3);
  assert.equal(inspector.prepare('SELECT count(*) AS count FROM schedule_spec').get().count, 1);
  assert.equal(inspector.prepare('SELECT count(*) AS count FROM wake_occurrence').get().count, 0);
  assert.equal(inspector.prepare("SELECT count(*) AS count FROM journal_event WHERE event_type='legacy_delivery_suppressed'").get().count, 3);
  const ambiguous = inspector.prepare("SELECT source_ref FROM journal_event WHERE source_kind='legacy-ambiguous-outbox'").get();
  assert.deepEqual(JSON.parse(ambiguous.source_ref), { count: 65, sourceDigest: `sha256:${'4'.repeat(64)}` });
  inspector.close();
  await core.close();
});

test('a reminder that is no longer future aborts the whole cutover', async (t) => {
  const { dbPath } = createTempCore(t, 'hermes-core-schedule-cutover-stale-');
  const core = openCoreDatabase({ dbPath, now: () => new Date(COMMITTED_AT) });
  core.migrate();
  const stale = snapshot();
  stale.staged.reminders[0].scheduledFor = WATERMARK;
  await assert.rejects(commitCoreCutover({
    core,
    input: {
      ownerId: 'owner', authorizationRef: 'owner-approval:s12:test',
      watermark: WATERMARK, committedAt: COMMITTED_AT, candidateSha: 'a'.repeat(40),
      migrationSnapshotDigest: `sha256:${'b'.repeat(64)}`,
      scheduleManifestDigest: `sha256:${'c'.repeat(64)}`,
      visibleBindingDigest: `sha256:${'d'.repeat(64)}`,
      ambiguousOutboxDisposition: 'terminal_no_resend', pendingOutboundDisposition: 'suppress',
    },
    apply: (tx) => applyCoreScheduleCutover(tx, { snapshot: stale, ownerId: 'owner', createdAt: COMMITTED_AT }),
  }), { code: 'CORE_CUTOVER_REMINDER_NOT_FUTURE' });
  assert.equal(core.reader.journalEvent('core-cutover:v1'), undefined);
  await core.close();
});
