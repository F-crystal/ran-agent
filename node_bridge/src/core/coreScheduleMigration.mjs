import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { openCoreDatabase } from './coreDb.mjs';
import { CORE_SCHEMA_VERSION } from './coreSchema.mjs';

const DISPOSITIONS = new Set([
  'MIGRATE_TO_SCHEDULE',
  'RETAIN_NON_VISIBLE_MAINTENANCE',
  'REPLACE_WITH_CORE_WORKER',
  'RETIRE_EMPTY',
]);
const DELIVERY_STATES = ['reserved', 'sending', 'sent', 'failed', 'ambiguous'];

function migrationError(code, message) {
  return Object.assign(new Error(message), { code });
}

function canonicalIso(value, field) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime()) || !date.toISOString().endsWith('.000Z')) {
    throw migrationError('CORE_MIGRATION_TIME_INVALID', `${field} must be a whole-second instant`);
  }
  return date.toISOString();
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fileDigest(filePath) {
  return fs.existsSync(filePath) ? `sha256:${digest(fs.readFileSync(filePath))}` : null;
}

function readJsonCollection(filePath, key) {
  if (!fs.existsSync(filePath)) return [];
  let value;
  try {
    value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw migrationError('CORE_MIGRATION_STATE_INVALID', `${path.basename(filePath)} is not valid JSON`, error);
  }
  const rows = Array.isArray(value) ? value : value?.[key];
  if (!Array.isArray(rows)) {
    throw migrationError('CORE_MIGRATION_STATE_INVALID', `${path.basename(filePath)} has no ${key} collection`);
  }
  return rows;
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table));
}

function legacyReminderInstant(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  // ponytail: legacy reminders are stored in the project's fixed Asia/Shanghai scheduler time.
  const instant = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)
    ? new Date(`${text.replace(' ', 'T')}+08:00`)
    : new Date(text);
  return Number.isFinite(instant.getTime()) ? instant.toISOString() : null;
}

function countBy(rows, allowed, valueOf) {
  const counts = Object.fromEntries(allowed.map((value) => [value, 0]));
  counts.other = 0;
  for (const row of rows) {
    const value = String(valueOf(row) || '').trim().toLowerCase();
    if (Object.hasOwn(counts, value)) counts[value] += 1;
    else counts.other += 1;
  }
  return counts;
}

export function loadCoreScheduleMigrationManifest(manifestPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest?.schemaVersion !== 1 || manifest?.status !== 'CURRENT'
    || !Array.isArray(manifest.components) || manifest.components.length === 0) {
    throw migrationError('CORE_MIGRATION_MANIFEST_INVALID', 'migration manifest header is invalid');
  }
  const ids = new Set();
  for (const component of manifest.components) {
    if (!component?.id || ids.has(component.id) || !DISPOSITIONS.has(component.disposition)) {
      throw migrationError('CORE_MIGRATION_MANIFEST_INVALID', 'component identity or disposition is invalid');
    }
    ids.add(component.id);
  }
  for (const policy of ['todoReminder', 'externalWatch', 'externalActivity', 'legacyDurableJob']) {
    if (manifest.importPolicies?.[policy]?.candidateState !== 'paused') {
      throw migrationError('CORE_MIGRATION_MANIFEST_INVALID', `${policy} candidates must default paused`);
    }
  }
  return Object.freeze(manifest);
}

export function inspectLegacySchedulingCopy({ legacyDbPath, stateDir, watermark }) {
  const at = canonicalIso(watermark, 'cutover watermark');
  const watermarkMs = Date.parse(at);
  const databasePath = path.resolve(legacyDbPath);
  const resolvedStateDir = path.resolve(stateDir);
  if (!fs.statSync(databasePath).isFile()) {
    throw migrationError('CORE_MIGRATION_SOURCE_INVALID', 'legacy database copy must be a file');
  }

  const db = new DatabaseSync(databasePath, { readOnly: true });
  let todos = [];
  let durableJobs = [];
  let digestReceipts = 0;
  try {
    if (tableExists(db, 'todos')) {
      todos = db.prepare(`SELECT id,reminder_at,last_reminded_at,status
        FROM todos ORDER BY id`).all();
    }
    if (tableExists(db, 'durable_jobs')) {
      durableJobs = db.prepare(`SELECT job_id,state,job_kind,next_run_at
        FROM durable_jobs ORDER BY job_id`).all();
    }
    if (tableExists(db, 'handoff_memory')) {
      digestReceipts = Number(db.prepare(`SELECT count(*) AS count FROM handoff_memory
        WHERE key LIKE 'ai_daily_digest:sent:%'`).get().count);
    }
  } finally {
    db.close();
  }

  const reminderCandidates = [];
  let historicalReminders = 0;
  let invalidReminderTimes = 0;
  for (const todo of todos) {
    if (String(todo.status) !== 'pending' || !todo.reminder_at) continue;
    const scheduledFor = legacyReminderInstant(todo.reminder_at);
    if (!scheduledFor) {
      invalidReminderTimes += 1;
      continue;
    }
    if (todo.last_reminded_at || Date.parse(scheduledFor) <= watermarkMs) {
      historicalReminders += 1;
      continue;
    }
    reminderCandidates.push(Object.freeze({
      sourceRef: `legacy-todo:${todo.id}`,
      scheduledFor,
      state: 'paused',
    }));
  }

  const watchPath = path.join(resolvedStateDir, 'external_mcp', 'watchlist.json');
  const activityPath = path.join(resolvedStateDir, 'external_mcp', 'activities.json');
  const notificationPath = path.join(resolvedStateDir, 'external_mcp', 'notification-events.json');
  const outboxPath = path.join(resolvedStateDir, 'core', 'durable-outbox.json');
  const proactiveLedgerPath = path.join(resolvedStateDir, 'node-bridge-runtime', 'proactive-events.json');
  const pendingOutboundPath = path.join(resolvedStateDir, 'node-bridge-runtime', 'pending-outbound.json');
  const proactiveDispatchPath = path.join(resolvedStateDir, 'node-bridge-runtime', 'proactive-dispatch.json');
  const watches = readJsonCollection(watchPath, 'watches');
  const activities = readJsonCollection(activityPath, 'activities');
  const notifications = readJsonCollection(notificationPath, 'events');
  const outbox = readJsonCollection(outboxPath, 'items');
  const proactiveLedger = readJsonCollection(proactiveLedgerPath, 'records');
  const pendingOutbound = readJsonCollection(pendingOutboundPath, 'messages');

  const watchCandidates = watches.map((watch) => Object.freeze({
    sourceRef: `legacy-external-watch:sha256:${digest(JSON.stringify([
      watch.globalUserId, watch.serverId, watch.kind, watch.scope,
    ]))}`,
    notifyRequested: watch.notify !== false,
    state: 'paused',
  }));
  const activityCandidates = activities
    .filter((activity) => ['active', 'leased', 'paused', 'blocked'].includes(String(activity.status || activity.state || '')))
    .map((activity) => Object.freeze({
      sourceRef: `legacy-external-activity:sha256:${digest(JSON.stringify([
        activity.activityId || activity.activity_id,
        activity.globalUserId || activity.global_user_id,
        activity.serverId || activity.server_id,
        activity.kind,
        activity.watchScope || activity.watch_scope,
      ]))}`,
      state: 'paused',
    }));
  const durableJobStates = countBy(durableJobs, ['active', 'leased', 'terminal'], (row) => row.state);
  const notificationStates = countBy(notifications, ['reserved', 'sent', 'failed', 'released'], (row) => row.status || 'sent');
  const outboxStates = countBy(outbox, DELIVERY_STATES, (row) => row.delivery);
  const proactiveLedgerStates = countBy(proactiveLedger, ['reserved', 'sent'], (row) => row.status);

  return Object.freeze({
    watermark: at,
    sourceDigests: Object.freeze({
      legacyDatabase: fileDigest(databasePath),
      externalWatchlist: fileDigest(watchPath),
      externalActivities: fileDigest(activityPath),
      externalNotifications: fileDigest(notificationPath),
      legacyOutbox: fileDigest(outboxPath),
      proactiveLedger: fileDigest(proactiveLedgerPath),
      pendingOutbound: fileDigest(pendingOutboundPath),
      proactiveDispatch: fileDigest(proactiveDispatchPath),
    }),
    counts: Object.freeze({
      todos: todos.length,
      futureReminderCandidates: reminderCandidates.length,
      historicalReminders,
      invalidReminderTimes,
      digestReceipts,
      externalWatchCandidates: watchCandidates.length,
      externalActivityCandidates: activityCandidates.length,
      durableJobStates: Object.freeze(durableJobStates),
      notificationStates: Object.freeze(notificationStates),
      outboxStates: Object.freeze(outboxStates),
      proactiveLedgerStates: Object.freeze(proactiveLedgerStates),
      pendingOutboundMessages: pendingOutbound.length,
      proactiveDispatchStatePresent: fs.existsSync(proactiveDispatchPath),
    }),
    staged: Object.freeze({
      reminders: Object.freeze(reminderCandidates),
      externalWatches: Object.freeze(watchCandidates),
      externalActivities: Object.freeze(activityCandidates),
    }),
  });
}

export async function rehearseCoreScheduleMigration({
  manifestPath, legacyDbPath, stateDir, coreDbPath, watermark,
}) {
  const manifest = loadCoreScheduleMigrationManifest(manifestPath);
  const snapshot = inspectLegacySchedulingCopy({ legacyDbPath, stateDir, watermark });
  const candidatePath = path.resolve(coreDbPath);
  if (fs.existsSync(candidatePath)) {
    throw migrationError('CORE_MIGRATION_CANDIDATE_EXISTS', 'candidate Core database must not already exist');
  }
  const core = openCoreDatabase({ dbPath: candidatePath, now: () => new Date(snapshot.watermark) });
  const migration = core.migrate();
  await core.close();

  const cutoverBlockers = [];
  if (snapshot.counts.invalidReminderTimes > 0) cutoverBlockers.push('invalid_reminder_time');
  if (snapshot.counts.durableJobStates.active + snapshot.counts.durableJobStates.leased > 0) {
    cutoverBlockers.push('legacy_durable_jobs_not_quiesced');
  }
  if (snapshot.counts.externalActivityCandidates > 0) {
    cutoverBlockers.push('legacy_external_activities_not_quiesced');
  }
  if (snapshot.counts.outboxStates.sending + snapshot.counts.outboxStates.ambiguous > 0) {
    cutoverBlockers.push('legacy_outbox_requires_reconciliation');
  }
  if (snapshot.counts.proactiveLedgerStates.reserved > 0) {
    cutoverBlockers.push('legacy_proactive_reservations_not_quiesced');
  }
  if (snapshot.counts.pendingOutboundMessages > 0) {
    cutoverBlockers.push('legacy_pending_outbound_requires_reconciliation');
  }

  return Object.freeze({
    schemaVersion: 1,
    status: 'passed',
    watermark: snapshot.watermark,
    manifestDigest: `sha256:${digest(fs.readFileSync(manifestPath))}`,
    componentCount: manifest.components.length,
    dispositions: Object.freeze(Object.fromEntries([...DISPOSITIONS].map((value) => [
      value, manifest.components.filter((component) => component.disposition === value).length,
    ]))),
    sourceDigests: snapshot.sourceDigests,
    counts: snapshot.counts,
    staged: snapshot.staged,
    candidate: Object.freeze({
      schemaVersion: CORE_SCHEMA_VERSION,
      migrationsApplied: migration.applied,
      businessRowsWritten: 0,
      externalEffects: 0,
    }),
    cutoverBlockers: Object.freeze(cutoverBlockers),
  });
}
