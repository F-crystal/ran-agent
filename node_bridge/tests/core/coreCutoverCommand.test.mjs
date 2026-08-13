import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { executeCoreCutover } from '../../src/core/coreCutoverCommand.mjs';
import { openCoreDatabase } from '../../src/core/coreDb.mjs';
import { createTempCore, openTestInspector } from './helpers/testCoreInspector.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SYSTEM_MANIFEST = path.join(REPO_ROOT, 'docs/governance/core_system_schedules.v1.json');
const WATERMARK = '2026-08-08T15:00:00.000Z';
const COMMITTED_AT = '2026-08-08T15:01:00.000Z';
const digest = (filePath) => `sha256:${createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')}`;

function setup(t) {
  const { root, dbPath } = createTempCore(t, 'hermes-core-cutover-command-');
  const snapshotPath = path.join(root, 'snapshot.json');
  const visibleBindingPath = path.join(root, 'visible-binding.json');
  fs.writeFileSync(snapshotPath, JSON.stringify({
    schemaVersion: 1, status: 'passed', watermark: WATERMARK,
    candidate: { schemaVersion: 2, businessRowsWritten: 0, externalEffects: 0 },
    cutoverBlockers: ['legacy_pending_outbound_requires_reconciliation'],
    counts: {
      invalidReminderTimes: 0,
      durableJobStates: { active: 0, leased: 0, terminal: 0 },
      externalActivityStates: { active: 0, leased: 0, paused: 1, blocked: 0 },
      outboxStates: { sending: 0, ambiguous: 1, sent: 1, failed: 0, reserved: 0 },
      outboxAmbiguousTerminalNoResend: 1, outboxAmbiguousUnsafe: 0,
      proactiveLedgerStates: { reserved: 0, sent: 0 },
      historicalReminders: 1, pendingOutboundMessages: 1,
    },
    sourceDigests: {
      legacyDatabase: `sha256:${'1'.repeat(64)}`,
      legacyOutbox: `sha256:${'2'.repeat(64)}`,
      pendingOutbound: `sha256:${'3'.repeat(64)}`,
    },
    staged: {
      reminders: [], externalWatches: [],
      externalActivities: [{ sourceRef: `legacy-external-activity:sha256:${'4'.repeat(64)}`, state: 'paused' }],
    },
  }));
  fs.writeFileSync(visibleBindingPath, JSON.stringify({
    conversationId: 'system-owner-conversation', canonicalConversationKey: 'system-owner-conversation',
    actorRef: 'owner:verified', platform: 'feishu', sourceInstanceId: 'node-channel-hub:feishu',
    platformConversationBinding: 'feishu:conversation:system-owner',
    bindingId: 'system-owner-binding', destinationKind: 'user', destinationRef: 'ou-owner-fixture',
  }));
  return { root, dbPath, snapshotPath, visibleBindingPath };
}

test('exact cutover command verifies without writes then applies and replays one transaction', async (t) => {
  const fixture = setup(t);
  const core = openCoreDatabase({ dbPath: fixture.dbPath, now: () => new Date(WATERMARK) });
  core.migrate();
  await core.close();
  const input = {
    mode: 'verify', coreDbPath: fixture.dbPath, snapshotPath: fixture.snapshotPath,
    systemManifestPath: SYSTEM_MANIFEST, visibleBindingPath: fixture.visibleBindingPath,
    visibleBindingDigest: digest(fixture.visibleBindingPath),
    candidateSha: 'a'.repeat(40), committedAt: COMMITTED_AT,
    ownerId: 'owner', authorizationRef: 'owner-approval:s12:test',
  };
  const snapshotFd = fs.openSync(fixture.snapshotPath, 'r');
  const bindingFd = fs.openSync(fixture.visibleBindingPath, 'r');
  const fdVerified = await executeCoreCutover({
    ...input, snapshotPath: snapshotFd, visibleBindingPath: bindingFd,
  });
  fs.closeSync(bindingFd);
  fs.closeSync(snapshotFd);
  assert.equal(fdVerified.status, 'verified');
  const verified = await executeCoreCutover(input);
  assert.equal(verified.status, 'verified');
  const approvedBinding = fs.readFileSync(fixture.visibleBindingPath);
  const replacement = JSON.parse(approvedBinding);
  replacement.destinationRef = 'ou-owner-replacement';
  fs.writeFileSync(fixture.visibleBindingPath, JSON.stringify(replacement));
  await assert.rejects(executeCoreCutover(input), { code: 'CORE_CUTOVER_BINDING_DIGEST_MISMATCH' });
  fs.writeFileSync(fixture.visibleBindingPath, approvedBinding);
  let inspector = openTestInspector(fixture.dbPath);
  assert.equal(inspector.prepare('SELECT count(*) AS count FROM journal_event').get().count, 0);
  inspector.close();

  const applied = await executeCoreCutover({ ...input, mode: 'apply' });
  assert.equal(applied.status, 'applied');
  assert.equal(applied.disposition, 'applied');
  assert.equal((await executeCoreCutover({ ...input, mode: 'apply' })).disposition, 'already_applied');
  inspector = openTestInspector(fixture.dbPath);
  assert.equal(inspector.prepare("SELECT count(*) AS count FROM journal_event WHERE journal_event_id='core-cutover:v1'").get().count, 1);
  assert.equal(inspector.prepare('SELECT count(*) AS count FROM schedule_spec').get().count, 13);
  assert.equal(inspector.prepare("SELECT count(*) AS count FROM activity WHERE state='paused'").get().count, 1);
  inspector.close();
});

test('exact cutover command rejects unresolved rehearsal blockers', async (t) => {
  const fixture = setup(t);
  const core = openCoreDatabase({ dbPath: fixture.dbPath });
  core.migrate();
  await core.close();
  const snapshot = JSON.parse(fs.readFileSync(fixture.snapshotPath, 'utf8'));
  snapshot.cutoverBlockers.push('legacy_durable_jobs_not_quiesced');
  snapshot.counts.durableJobStates.active = 1;
  fs.writeFileSync(fixture.snapshotPath, JSON.stringify(snapshot));
  await assert.rejects(executeCoreCutover({
    mode: 'verify', coreDbPath: fixture.dbPath, snapshotPath: fixture.snapshotPath,
    systemManifestPath: SYSTEM_MANIFEST, visibleBindingPath: fixture.visibleBindingPath,
    visibleBindingDigest: digest(fixture.visibleBindingPath),
    candidateSha: 'a'.repeat(40), committedAt: COMMITTED_AT,
  }), { code: 'CORE_CUTOVER_SNAPSHOT_BLOCKED' });
});

test('exact cutover verification rejects an invalid visible binding before apply', async (t) => {
  const fixture = setup(t);
  const core = openCoreDatabase({ dbPath: fixture.dbPath });
  core.migrate();
  await core.close();
  fs.writeFileSync(fixture.visibleBindingPath, '{}');
  const expected = digest(fixture.visibleBindingPath);
  const verify = (visibleBindingDigest = expected) => executeCoreCutover({
    mode: 'verify', coreDbPath: fixture.dbPath, snapshotPath: fixture.snapshotPath,
    systemManifestPath: SYSTEM_MANIFEST, visibleBindingPath: fixture.visibleBindingPath,
    visibleBindingDigest,
    candidateSha: 'a'.repeat(40), committedAt: COMMITTED_AT,
  });
  fs.rmSync(fixture.visibleBindingPath);
  await assert.rejects(verify(), { code: 'CORE_CUTOVER_INPUT_UNREADABLE' });
  fs.writeFileSync(fixture.visibleBindingPath, '{}');
  await assert.rejects(verify(), { code: 'CORE_SYSTEM_SCHEDULE_BINDING_REQUIRED' });

  fs.writeFileSync(fixture.visibleBindingPath, JSON.stringify({
    conversationId: 'system-owner-conversation', canonicalConversationKey: 'system-owner-conversation',
    actorRef: 'owner:verified', platform: 'feishu', sourceInstanceId: 'node-channel-hub:feishu',
    platformConversationBinding: 'feishu:conversation:system-owner',
    bindingId: 'system-owner-binding', destinationKind: 'ambiguous', destinationRef: 'recipient-fixture',
  }));
  await assert.rejects(verify(digest(fixture.visibleBindingPath)), { code: 'CORE_SYSTEM_SCHEDULE_ROUTE_INVALID' });
});

test('exact cutover verification rejects invalid candidate authority before apply', async (t) => {
  const fixture = setup(t);
  const core = openCoreDatabase({ dbPath: fixture.dbPath });
  core.migrate();
  await core.close();

  await assert.rejects(executeCoreCutover({
    mode: 'verify', coreDbPath: fixture.dbPath, snapshotPath: fixture.snapshotPath,
    systemManifestPath: SYSTEM_MANIFEST, visibleBindingPath: fixture.visibleBindingPath,
    visibleBindingDigest: digest(fixture.visibleBindingPath),
    candidateSha: 'not-a-sha', committedAt: COMMITTED_AT,
  }), { code: 'CORE_CUTOVER_SEMANTICS_INVALID' });
  await assert.rejects(executeCoreCutover({
    mode: 'verify', coreDbPath: fixture.dbPath, snapshotPath: fixture.snapshotPath,
    systemManifestPath: SYSTEM_MANIFEST, visibleBindingPath: fixture.visibleBindingPath,
    visibleBindingDigest: digest(fixture.visibleBindingPath),
    candidateSha: 'a'.repeat(40), committedAt: 'not-a-time',
  }), { code: 'CORE_CUTOVER_TIME_INVALID' });
});
