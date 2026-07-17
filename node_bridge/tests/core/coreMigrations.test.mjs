import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  CORE_MIGRATIONS, migrationChecksum, runCoreMigrations, validateMigrationPlan,
} from '../../src/core/coreMigrations.mjs';
import { openCoreDatabase } from '../../src/core/coreDb.mjs';
import { createTempCore } from './helpers/testCoreInspector.mjs';

function rawDb(t, filename = 'migration.sqlite3') {
  const { root } = createTempCore(t, 'hermes-core-migration-');
  fs.mkdirSync(root, { recursive: true });
  return { db: new DatabaseSync(path.join(root, filename)), dbPath: path.join(root, filename) };
}

function migration(id, from, statements, checksumSource = statements.join('\n')) {
  return { migrationId: id, fromVersion: from, toVersion: from + 1, statements, checksumSource };
}

const LEDGER_SQL = `CREATE TABLE schema_migration (
  migration_id TEXT, from_version INTEGER, to_version INTEGER, checksum TEXT, applied_at TEXT
)`;

test('fresh 0->1 succeeds, applied history validates, and rerun is no-op', (t) => {
  const { db } = rawDb(t);
  assert.deepEqual(runCoreMigrations(db), { version: 1, applied: ['core-0001-initial'] });
  assert.deepEqual(runCoreMigrations(db), { version: 1, applied: [] });
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
  assert.equal(db.prepare('SELECT count(*) AS count FROM schema_migration').get().count, 1);
  db.close();
});

test('actual schema drift fails closed without recreating missing Core objects', (t) => {
  const { db, dbPath } = rawDb(t, 'drift.sqlite3');
  runCoreMigrations(db);
  db.exec('DROP TABLE runtime_interaction_override');
  db.close();
  assert.throws(() => openCoreDatabase({ dbPath }), { code: 'CORE_SCHEMA_DRIFT' });
  const damaged = new DatabaseSync(dbPath);
  assert.equal(damaged.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name='runtime_interaction_override'").get().count, 0);
  assert.equal(damaged.prepare('PRAGMA user_version').get().user_version, 1);
  damaged.close();
  assert.throws(() => openCoreDatabase({ dbPath }), { code: 'CORE_SCHEMA_DRIFT' });
});

test('missing Core index, trigger or changed table definition fails schema validation', (t) => {
  for (const [name, mutation] of [
    ['index', 'DROP INDEX projection_ready'],
    ['trigger', 'DROP TRIGGER soul_revision_active_receipt'],
    ['table-definition', `DROP TABLE runtime_interaction_override;
      CREATE TABLE runtime_interaction_override (
        runtime_interaction_override_id TEXT PRIMARY KEY,
        identity_id TEXT NOT NULL
      )`],
  ]) {
    const { db, dbPath } = rawDb(t, `drift-${name}.sqlite3`);
    runCoreMigrations(db);
    db.exec(mutation);
    db.close();
    assert.throws(() => openCoreDatabase({ dbPath }), { code: 'CORE_SCHEMA_DRIFT' }, name);
  }
});

test('non-Core objects are ignored by the v1 manifest fingerprint', async (t) => {
  const { db, dbPath } = rawDb(t, 'extra-object.sqlite3');
  runCoreMigrations(db);
  db.exec('CREATE TABLE local_test_diagnostic(id INTEGER)');
  db.close();
  const core = openCoreDatabase({ dbPath });
  assert.match(core.reader.schemaFingerprint(), /^[0-9a-f]{64}$/);
  await core.close();
  const verify = new DatabaseSync(dbPath);
  assert.equal(verify.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name='local_test_diagnostic'").get().count, 1);
  verify.close();
});

test('an unexpected trigger attached to a Core table is schema drift', (t) => {
  const { db, dbPath } = rawDb(t, 'extra-core-trigger.sqlite3');
  runCoreMigrations(db);
  db.exec(`CREATE TRIGGER unexpected_core_trigger
    BEFORE INSERT ON journal_event BEGIN SELECT RAISE(ABORT, 'unexpected'); END`);
  db.close();
  assert.throws(() => openCoreDatabase({ dbPath }), { code: 'CORE_SCHEMA_DRIFT' });
});

test('checksum source is explicit and line-ending canonical', () => {
  const lf = migration('m1', 0, ['SELECT 1'], 'line one\nline two');
  const crlf = migration('m1', 0, ['SELECT 1'], 'line one\r\nline two');
  assert.equal(migrationChecksum(lf), migrationChecksum(crlf));
  assert.throws(() => migrationChecksum({ ...lf, checksumSource: undefined }), { code: 'CORE_MIGRATION_CHECKSUM_SOURCE_REQUIRED' });
});

test('checksum mismatch fails before any schema write', (t) => {
  const { db } = rawDb(t);
  runCoreMigrations(db);
  const before = db.prepare("SELECT group_concat(name, '|') AS names FROM sqlite_master").get().names;
  const changed = [{ ...CORE_MIGRATIONS[0], checksumSource: 'changed immutable artifact' }];
  assert.throws(() => runCoreMigrations(db, changed), { code: 'CORE_MIGRATION_CHECKSUM_MISMATCH' });
  assert.equal(db.prepare("SELECT group_concat(name, '|') AS names FROM sqlite_master").get().names, before);
  db.close();
});

test('nonzero version without ledger fails closed and creates no schema', (t) => {
  const { db } = rawDb(t);
  db.exec('PRAGMA user_version=1');
  const before = db.prepare('SELECT count(*) AS count FROM sqlite_master').get().count;
  assert.throws(() => runCoreMigrations(db), { code: 'CORE_MIGRATION_LEDGER_MISSING' });
  assert.equal(db.prepare('SELECT count(*) AS count FROM sqlite_master').get().count, before);
  db.close();
});

test('version zero with untracked schema is not treated as a fresh Core database', (t) => {
  const { db } = rawDb(t);
  db.exec('CREATE TABLE foreign_schema(id INTEGER)');
  assert.throws(() => runCoreMigrations(db), { code: 'CORE_MIGRATION_DIRTY_DATABASE' });
  assert.equal(db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name='foreign_schema'").get().count, 1);
  assert.equal(db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name='schema_migration'").get().count, 0);
  db.close();
});

test('ledger/version mismatch, missing rows, jumps and duplicate history are rejected before DDL', (t) => {
  const cases = [
    { name: 'empty-ledger-v1', version: 1, rows: [] },
    { name: 'jump', version: 1, rows: [['m2', 1, 2, 'x']] },
    { name: 'duplicate-id', version: 2, rows: [['m1', 0, 1, 'x'], ['m1', 1, 2, 'y']] },
    { name: 'duplicate-to', version: 2, rows: [['m1', 0, 1, 'x'], ['m2', 1, 1, 'y']] },
  ];
  for (const fixture of cases) {
    const { db } = rawDb(t, `${fixture.name}.sqlite3`);
    db.exec(LEDGER_SQL);
    for (const row of fixture.rows) {
      db.prepare('INSERT INTO schema_migration VALUES (?, ?, ?, ?, ?)').run(...row, '2026-07-16T00:00:00.000Z');
    }
    db.exec(`PRAGMA user_version=${fixture.version}`);
    const before = db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='table'").get().count;
    assert.throws(() => runCoreMigrations(db), { code: /CORE_MIGRATION_/ }, fixture.name);
    assert.equal(db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='table'").get().count, before);
    db.close();
  }
});

test('invalid migration plans reject duplicate IDs, duplicate versions, gaps and unordered steps', () => {
  const m1 = migration('m1', 0, [LEDGER_SQL]);
  assert.throws(() => validateMigrationPlan([m1, { ...migration('m1', 1, ['SELECT 1']) }]), { code: 'CORE_MIGRATION_SEQUENCE_INVALID' });
  assert.throws(() => validateMigrationPlan([m1, { ...migration('m2', 1, ['SELECT 1']), toVersion: 1 }]), { code: 'CORE_MIGRATION_SEQUENCE_INVALID' });
  assert.throws(() => validateMigrationPlan([migration('gap', 2, ['SELECT 1'])]), { code: 'CORE_MIGRATION_SEQUENCE_INVALID' });
});

test('all pending migrations commit as one batch', (t) => {
  const { db } = rawDb(t);
  const plan = [
    migration('m1', 0, [LEDGER_SQL, 'CREATE TABLE one(id INTEGER)']),
    migration('m2', 1, ['CREATE TABLE two(id INTEGER)']),
    migration('m3', 2, ['CREATE TABLE three(id INTEGER)']),
  ];
  assert.deepEqual(runCoreMigrations(db, plan), { version: 3, applied: ['m1', 'm2', 'm3'] });
  assert.equal(db.prepare('SELECT count(*) AS count FROM schema_migration').get().count, 3);
  db.close();
});

test('second or third pending migration failure rolls the whole batch back across reopen', (t) => {
  for (const failingStep of [2, 3]) {
    const { db, dbPath } = rawDb(t, `batch-fail-${failingStep}.sqlite3`);
    const plan = [
      migration('m1', 0, [LEDGER_SQL, 'CREATE TABLE one(id INTEGER)']),
      migration('m2', 1, failingStep === 2 ? ['CREATE TABLE two(id INTEGER)', 'INVALID SQL'] : ['CREATE TABLE two(id INTEGER)']),
      migration('m3', 2, failingStep === 3 ? ['CREATE TABLE three(id INTEGER)', 'INVALID SQL'] : ['CREATE TABLE three(id INTEGER)']),
    ];
    assert.throws(() => runCoreMigrations(db, plan));
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 0);
    assert.equal(db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name IN ('schema_migration','one','two','three')").get().count, 0);
    db.close();
    const reopened = new DatabaseSync(dbPath);
    assert.equal(reopened.prepare('PRAGMA user_version').get().user_version, 0);
    assert.equal(reopened.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name IN ('schema_migration','one','two','three')").get().count, 0);
    reopened.close();
  }
});
