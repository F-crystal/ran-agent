import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import {
  inspectLegacySchedulingCopy,
  loadCoreScheduleMigrationManifest,
  rehearseCoreScheduleMigration,
} from '../../src/core/coreScheduleMigration.mjs';
import { createTempCore, openTestInspector } from './helpers/testCoreInspector.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const MANIFEST = path.join(REPO_ROOT, 'docs/governance/core_schedule_migration.v1.json');
const WATERMARK = '2026-08-08T08:00:00.000Z';

function buildLegacyCopy(t) {
  const { root, dbPath: coreDbPath } = createTempCore(t, 'hermes-core-s10-');
  const legacyDbPath = path.join(root, 'legacy.sqlite3');
  const stateDir = path.join(root, 'legacy-state');
  fs.mkdirSync(path.join(stateDir, 'external_mcp'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'core'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'node-bridge-runtime'), { recursive: true });
  const db = new DatabaseSync(legacyDbPath);
  db.exec(`CREATE TABLE todos(
      id INTEGER PRIMARY KEY, reminder_at TEXT, last_reminded_at TEXT, status TEXT
    );
    CREATE TABLE durable_jobs(
      job_id TEXT PRIMARY KEY, state TEXT, job_kind TEXT, next_run_at TEXT
    );
    CREATE TABLE handoff_memory(key TEXT PRIMARY KEY, value TEXT);`);
  db.prepare('INSERT INTO todos VALUES (?,?,?,?)').run(1, '2026-08-08 15:00:00', null, 'pending');
  db.prepare('INSERT INTO todos VALUES (?,?,?,?)').run(2, '2026-08-09 18:00:00', null, 'pending');
  db.prepare('INSERT INTO todos VALUES (?,?,?,?)').run(3, '2026-08-10 18:00:00', '2026-08-08 10:00:00', 'pending');
  db.prepare('INSERT INTO todos VALUES (?,?,?,?)').run(4, null, null, 'pending');
  db.prepare('INSERT INTO durable_jobs VALUES (?,?,?,?)').run('job-active', 'active', 'core.external-activity', WATERMARK);
  db.prepare('INSERT INTO durable_jobs VALUES (?,?,?,?)').run('job-done', 'terminal', 'core.reflection', WATERMARK);
  db.prepare('INSERT INTO handoff_memory VALUES (?,?)').run('ai_daily_digest:sent:2026-08-08', 'private');
  db.close();
  fs.writeFileSync(path.join(stateDir, 'external_mcp', 'watchlist.json'), JSON.stringify({
    schemaVersion: 1,
    revision: 1,
    watches: [
      { globalUserId: 'owner', serverId: 'forum-mcp', kind: 'forum', scope: 'private-forum', notify: true },
      { globalUserId: 'owner', serverId: 'rss-mcp', kind: 'rss', scope: 'private-feed', notify: false },
    ],
  }));
  fs.writeFileSync(path.join(stateDir, 'external_mcp', 'activities.json'), JSON.stringify({
    schemaVersion: 1, revision: 1,
    activities: [{
      activityId: 'private-activity', globalUserId: 'owner', serverId: 'forum-mcp',
      kind: 'forum_read', watchScope: 'private-forum', status: 'active',
    }],
  }));
  fs.writeFileSync(path.join(stateDir, 'external_mcp', 'notification-events.json'), JSON.stringify({
    schemaVersion: 1, revision: 1, events: [{ status: 'sent' }, { status: 'reserved' }],
  }));
  fs.writeFileSync(path.join(stateDir, 'core', 'durable-outbox.json'), JSON.stringify({
    schemaVersion: 1, items: [{ delivery: 'sent' }, { delivery: 'sending' }, {
      delivery: 'ambiguous', attemptCount: 1,
      sendStartedAt: '2026-08-08T07:59:00.000Z',
      deliveryCommittedAt: '2026-08-08T07:59:01.000Z',
      delivery_terminal_revision: 1,
      delivery_terminal_receipt_id: 'terminal:ambiguous:1',
      deliveryTerminalReceipts: [{
        delivery_terminal_receipt_id: 'terminal:ambiguous:1', delivery: 'ambiguous',
      }],
    }],
  }));
  fs.writeFileSync(path.join(stateDir, 'node-bridge-runtime', 'proactive-events.json'), JSON.stringify([
    { status: 'sent' }, { status: 'reserved' },
  ]));
  fs.writeFileSync(path.join(stateDir, 'node-bridge-runtime', 'pending-outbound.json'), JSON.stringify({
    messages: [{ text: 'private pending message' }],
  }));
  fs.writeFileSync(path.join(stateDir, 'node-bridge-runtime', 'proactive-dispatch.json'), JSON.stringify({
    nextAllowedAt: WATERMARK,
  }));
  return { root, legacyDbPath, stateDir, coreDbPath };
}

test('S10 rehearsal stages only future reminder/watch identities paused and creates no work or effect', async (t) => {
  const fixture = buildLegacyCopy(t);
  const manifest = loadCoreScheduleMigrationManifest(MANIFEST);
  assert.equal(new Set(manifest.components.map((item) => item.id)).size, manifest.components.length);
  assert.ok(manifest.components.every((item) => fs.existsSync(path.join(REPO_ROOT, item.source.split(':')[0]))));

  const inspected = inspectLegacySchedulingCopy({ ...fixture, watermark: WATERMARK });
  assert.equal(inspected.counts.futureReminderCandidates, 1);
  assert.equal(inspected.counts.historicalReminders, 2);
  assert.equal(inspected.counts.externalWatchCandidates, 2);
  assert.equal(inspected.counts.externalActivityCandidates, 1);
  assert.equal(inspected.counts.externalActivityStates.active, 1);
  assert.equal(inspected.counts.outboxAmbiguousTerminalNoResend, 1);
  assert.equal(inspected.counts.outboxAmbiguousUnsafe, 0);
  assert.ok(inspected.staged.reminders.every((item) => item.state === 'paused'));
  assert.ok(inspected.staged.externalWatches.every((item) => item.state === 'paused'));
  assert.ok(inspected.staged.externalActivities.every((item) => item.state === 'paused'));
  assert.doesNotMatch(JSON.stringify(inspected), /private-forum|private-feed|private/);

  const result = await rehearseCoreScheduleMigration({
    manifestPath: MANIFEST,
    legacyDbPath: fixture.legacyDbPath,
    stateDir: fixture.stateDir,
    coreDbPath: fixture.coreDbPath,
    watermark: WATERMARK,
  });
  assert.equal(result.status, 'passed');
  assert.deepEqual(result.candidate.migrationsApplied, ['core-0001-initial', 'core-0002-scheduling']);
  assert.equal(result.candidate.businessRowsWritten, 0);
  assert.equal(result.candidate.externalEffects, 0);
  assert.deepEqual(result.cutoverBlockers, [
    'legacy_durable_jobs_not_quiesced', 'legacy_external_activities_not_quiesced',
    'legacy_outbox_requires_reconciliation', 'legacy_proactive_reservations_not_quiesced',
    'legacy_pending_outbound_requires_reconciliation',
  ]);

  const candidate = openTestInspector(fixture.coreDbPath);
  assert.equal(candidate.prepare('PRAGMA user_version').get().user_version, 2);
  assert.equal(candidate.prepare('SELECT count(*) AS count FROM activity').get().count, 0);
  assert.equal(candidate.prepare('SELECT count(*) AS count FROM wake_occurrence').get().count, 0);
  assert.equal(candidate.prepare('SELECT count(*) AS count FROM work_run').get().count, 0);
  candidate.close();
});
