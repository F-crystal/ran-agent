import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  commitCoreCutover,
  CORE_CUTOVER_EVENT_ID,
  validateCoreCutoverInput,
} from './coreCutover.mjs';
import { openCoreDatabase } from './coreDb.mjs';
import { coreError } from './coreErrors.mjs';
import { applyCoreScheduleCutover } from './coreScheduleCutover.mjs';
import { CORE_SCHEMA_VERSION, CORE_TABLES } from './coreSchema.mjs';
import {
  loadCoreSystemScheduleManifest,
  seedCoreSystemSchedules,
  validateCoreSystemScheduleBinding,
} from './coreSystemSchedules.mjs';

function digest(filePath) {
  return `sha256:${createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')}`;
}

function readJson(filePath, label) {
  let bytes;
  let value;
  try {
    value = typeof filePath === 'number' ? fs.fstatSync(filePath) : fs.statSync(filePath);
    bytes = fs.readFileSync(filePath);
  } catch (error) {
    throw coreError('CORE_CUTOVER_INPUT_UNREADABLE', `${label} is unreadable`, error);
  }
  if (!value.isFile()) throw coreError('CORE_CUTOVER_INPUT_MISSING', 'cutover input file is missing');
  try {
    return Object.freeze({ bytes, value: JSON.parse(bytes.toString('utf8')) });
  } catch (error) {
    throw coreError('CORE_CUTOVER_INPUT_INVALID', `${label} is not valid JSON`, error);
  }
}

function assertSnapshot(snapshot) {
  const counts = snapshot?.counts;
  const allowedBlockers = new Set(['legacy_pending_outbound_requires_reconciliation']);
  const blockers = Array.isArray(snapshot?.cutoverBlockers) ? snapshot.cutoverBlockers : [];
  const valid = snapshot?.schemaVersion === 1 && snapshot?.status === 'passed'
    && snapshot?.candidate?.schemaVersion === CORE_SCHEMA_VERSION
    && snapshot.candidate.businessRowsWritten === 0 && snapshot.candidate.externalEffects === 0
    && counts?.invalidReminderTimes === 0
    && counts?.durableJobStates?.active === 0 && counts?.durableJobStates?.leased === 0
    && counts?.externalActivityStates?.active === 0 && counts?.externalActivityStates?.leased === 0
    && counts?.outboxStates?.sending === 0 && counts?.outboxAmbiguousUnsafe === 0
    && counts?.proactiveLedgerStates?.reserved === 0
    && blockers.every((item) => allowedBlockers.has(item));
  if (!valid) {
    throw coreError('CORE_CUTOVER_SNAPSHOT_BLOCKED', 'fresh migration snapshot has unresolved cutover blockers');
  }
}

function businessRows(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return Object.freeze({
      counts: Object.fromEntries(CORE_TABLES.filter((table) => table !== 'schema_migration')
        .map((table) => [table, Number(db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count)])),
      cutoverCommitted: Boolean(db.prepare(`SELECT 1 AS found FROM journal_event
        WHERE journal_event_id=? AND event_type='core_cutover_committed_at'`).get(CORE_CUTOVER_EVENT_ID)),
    });
  } finally {
    db.close();
  }
}

function plan(input) {
  validateCoreCutoverInput(input);
  for (const filePath of [input.coreDbPath, input.systemManifestPath]) {
    if (typeof filePath !== 'string' || !fs.statSync(filePath).isFile()) {
      throw coreError('CORE_CUTOVER_INPUT_MISSING', 'cutover input file is missing');
    }
  }
  const snapshotInput = readJson(input.snapshotPath, 'migration snapshot');
  const snapshot = snapshotInput.value;
  assertSnapshot(snapshot);
  const manifest = loadCoreSystemScheduleManifest(input.systemManifestPath);
  const visibleBindingInput = readJson(input.visibleBindingPath, 'visible binding');
  const visibleBinding = visibleBindingInput.value;
  const visibleBindingBytes = visibleBindingInput.bytes;
  const visibleBindingDigest = `sha256:${createHash('sha256').update(visibleBindingBytes).digest('hex')}`;
  if (visibleBindingDigest !== input.visibleBindingDigest) {
    throw coreError('CORE_CUTOVER_BINDING_DIGEST_MISMATCH', 'visible binding differs from approved S12 authority');
  }
  validateCoreSystemScheduleBinding(manifest, visibleBinding);
  const database = businessRows(input.coreDbPath);
  if (!database.cutoverCommitted && Object.values(database.counts).some((count) => count !== 0)) {
    throw coreError('CORE_CUTOVER_CANDIDATE_NOT_EMPTY', 'pre-cutover Core candidate contains business rows');
  }
  const snapshotDigest = `sha256:${createHash('sha256').update(snapshotInput.bytes).digest('hex')}`;
  return Object.freeze({ snapshot, snapshotDigest, manifest, visibleBinding, visibleBindingDigest, database });
}

export async function executeCoreCutover(input = {}) {
  const prepared = plan(input);
  const summary = Object.freeze({
    status: input.mode === 'apply' ? 'ready_to_apply' : 'verified',
    watermark: prepared.snapshot.watermark,
    candidateSha: input.candidateSha,
    importedCandidates: (prepared.snapshot.staged?.reminders?.length || 0)
      + (prepared.snapshot.staged?.externalWatches?.length || 0)
      + (prepared.snapshot.staged?.externalActivities?.length || 0),
    systemSchedules: prepared.manifest.schedules.length,
    pendingOutboundSuppressed: prepared.snapshot.counts.pendingOutboundMessages,
    ambiguousNoResend: prepared.snapshot.counts.outboxAmbiguousTerminalNoResend,
    visibleBindingSha256: prepared.visibleBindingDigest,
    destinationKind: prepared.visibleBinding.destinationKind,
  });
  if (input.mode !== 'apply') return summary;

  const core = openCoreDatabase({ dbPath: input.coreDbPath, now: () => new Date(input.committedAt) });
  try {
    const cutover = await commitCoreCutover({
      core,
      input: {
        ownerId: input.ownerId,
        authorizationRef: input.authorizationRef,
        watermark: prepared.snapshot.watermark,
        committedAt: input.committedAt,
        candidateSha: input.candidateSha,
        migrationSnapshotDigest: prepared.snapshotDigest,
        scheduleManifestDigest: digest(input.systemManifestPath),
        visibleBindingDigest: prepared.visibleBindingDigest,
        ambiguousOutboxDisposition: 'terminal_no_resend',
        pendingOutboundDisposition: 'suppress',
      },
      apply: (tx) => {
        applyCoreScheduleCutover(tx, {
          snapshot: prepared.snapshot, ownerId: input.ownerId, createdAt: input.committedAt,
        });
        seedCoreSystemSchedules(tx, {
          manifest: prepared.manifest, ownerId: input.ownerId,
          watermark: prepared.snapshot.watermark, createdAt: input.committedAt,
          visibleBinding: prepared.visibleBinding,
        });
      },
    });
    if (!core.reader.journalEvent(CORE_CUTOVER_EVENT_ID)) {
      throw coreError('CORE_CUTOVER_RECEIPT_MISSING', 'cutover authority marker is missing after commit');
    }
    return Object.freeze({ ...summary, status: 'applied', disposition: cutover.disposition });
  } finally {
    await core.close();
  }
}
