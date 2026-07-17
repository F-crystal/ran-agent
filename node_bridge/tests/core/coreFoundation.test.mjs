import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { openCoreDatabase } from '../../src/core/coreDb.mjs';
import { resolveCoreDbPath } from '../../src/core/corePaths.mjs';
import { CORE_SCHEMA_VERSION, CORE_TABLES } from '../../src/core/coreSchema.mjs';
import { createTempCore, openTestInspector } from './helpers/testCoreInspector.mjs';

test('runtime path helper computes the fixed target without creating it', (t) => {
  const { root } = createTempCore(t);
  const target = resolveCoreDbPath(root);
  assert.equal(target, path.join(root, 'core', 'core-state.sqlite3'));
  assert.equal(fs.existsSync(path.dirname(target)), false);
});

test('database lifecycle verifies owner-only permissions and required pragmas', async (t) => {
  const { dbPath } = createTempCore(t);
  const core = openCoreDatabase({ dbPath });
  assert.deepEqual(core.reader.pragmaSnapshot(), {
    journalMode: 'wal', foreignKeys: 1, synchronous: 2, busyTimeout: 5000,
    recursiveTriggers: 1, ignoreCheckConstraints: 0,
  });
  assert.equal(fs.statSync(path.dirname(dbPath)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(dbPath).mode & 0o777, 0o600);
  for (const sidecar of [`${dbPath}-wal`, `${dbPath}-shm`]) {
    if (fs.existsSync(sidecar)) assert.equal(fs.statSync(sidecar).mode & 0o777, 0o600);
  }
  await core.close();
  assert.throws(() => core.reader, { code: 'CORE_DB_CLOSED' });
});

test('production public API exposes no raw database or arbitrary SQL write surface', async (t) => {
  const { dbPath } = createTempCore(t);
  const core = openCoreDatabase({ dbPath });
  core.migrate();
  for (const name of [
    'db', 'exec', 'prepare', 'run', 'transaction', 'transact', 'pragma',
    'delete', 'replace', 'insertOrReplace',
  ]) {
    assert.equal(core[name], undefined, `CoreDatabase unexpectedly exposes ${name}`);
    assert.equal(core.reader[name], undefined, `reader unexpectedly exposes ${name}`);
    assert.equal(core.writer[name], undefined, `writer unexpectedly exposes ${name}`);
  }
  assert.equal(typeof core.close, 'function');
  assert.equal(core.writer.close, undefined);
  assert.deepEqual(Object.keys(core.writer), ['write']);
  assert.equal(Object.isFrozen(core.writer), true);
  await core.writer.write((tx) => {
    for (const name of [
      'db', 'exec', 'prepare', 'run', 'transaction', 'delete', 'replace', 'insertOrReplace',
    ]) assert.equal(tx[name], undefined);
    tx.journal.append({
      eventId: 'public-api-test', eventType: 'test', originRef: 'fixture',
      sourceKind: 'test', sourceRef: 'fixture', createdAt: '2026-07-16T00:00:00.000Z',
    });
  });
  assert.equal(core.reader.journalEventCount(), 1);
  await core.close();
});

test('business writes fail closed until migration history is validated and migration cannot follow writes', async (t) => {
  const { dbPath } = createTempCore(t);
  const core = openCoreDatabase({ dbPath });
  await assert.rejects(core.writer.write(() => {}), { code: 'CORE_SCHEMA_NOT_READY' });
  core.migrate();
  await core.writer.write((tx) => tx.journal.append({
    eventId: 'first-write', eventType: 'test', originRef: 'fixture',
    sourceKind: 'test', sourceRef: 'fixture', createdAt: '2026-07-16T00:00:00.000Z',
  }));
  assert.throws(() => core.migrate(), { code: 'CORE_MIGRATION_AFTER_WRITE_FORBIDDEN' });
  assert.equal(core.reader.journalEventCount(), 1);
  await core.close();
});

test('v1 migration creates all fixed Foundation objects and is idempotent', async (t) => {
  const { dbPath } = createTempCore(t);
  const core = openCoreDatabase({ dbPath });
  assert.deepEqual(core.migrate().applied, ['core-0001-initial']);
  assert.deepEqual(core.migrate(), { version: CORE_SCHEMA_VERSION, applied: [] });
  const tables = new Set(core.reader.schemaObjectNames()
    .filter((entry) => entry.type === 'table').map((entry) => entry.name));
  for (const table of CORE_TABLES) assert.ok(tables.has(table), `missing ${table}`);
  assert.equal(core.reader.schemaVersion(), 1);
  assert.equal(core.reader.migrationHistory().length, 1);
  assert.deepEqual(core.reader.foreignKeyViolations(), []);
  const firstFingerprint = core.reader.schemaFingerprint();
  assert.match(firstFingerprint, /^[0-9a-f]{64}$/);
  await core.close();
  const reopened = openCoreDatabase({ dbPath });
  assert.equal(reopened.reader.schemaFingerprint(), firstFingerprint);
  await reopened.close();
});

test('frozen schema v1 identity and object manifest remain exact across reopen', async (t) => {
  const { dbPath } = createTempCore(t, 'hermes-core-frozen-v1-');
  const core = openCoreDatabase({ dbPath });
  assert.deepEqual(core.migrate(), { version: 1, applied: ['core-0001-initial'] });
  const counts = Object.fromEntries(['table', 'index', 'trigger'].map((type) => [
    type,
    core.reader.schemaObjectNames().filter((entry) => entry.type === type).length,
  ]));
  assert.deepEqual(counts, { table: 41, index: 7, trigger: 62 });
  assert.deepEqual(core.reader.migrationHistory().map((row) => ({
    migration_id: row.migration_id,
    from_version: row.from_version,
    to_version: row.to_version,
    checksum: row.checksum,
  })), [{
    migration_id: 'core-0001-initial',
    from_version: 0,
    to_version: 1,
    checksum: '0cbc7bc1afddeff8ac11ce40cf54ee54fe444fe3ba23c63cbf8271db1db31151',
  }]);
  assert.equal(
    core.reader.schemaFingerprint(),
    '9cc3f1e4a62c9d7809d31d477e1b4e41fec49b12dd44b1f3dcaf4b0235270671',
  );
  await core.close();

  const reopened = openCoreDatabase({ dbPath });
  assert.equal(reopened.reader.schemaVersion(), 1);
  assert.equal(
    reopened.reader.schemaFingerprint(),
    '9cc3f1e4a62c9d7809d31d477e1b4e41fec49b12dd44b1f3dcaf4b0235270671',
  );
  await reopened.close();
});

test('committed rows survive close/reopen and failed transactions leave no rows', async (t) => {
  const { dbPath } = createTempCore(t);
  let core = openCoreDatabase({ dbPath });
  core.migrate();
  await core.writer.write((tx) => tx.journal.append({
    eventId: 'kept', eventType: 'test', originRef: 'fixture', sourceKind: 'test',
    sourceRef: 'fixture', createdAt: '2026-07-16T00:00:00.000Z',
  }));
  await assert.rejects(core.writer.write((tx) => {
    tx.journal.append({
      eventId: 'lost', eventType: 'test', originRef: 'fixture', sourceKind: 'test',
      sourceRef: 'fixture', createdAt: '2026-07-16T00:00:00.000Z',
    });
    throw new Error('rollback');
  }), { code: 'CORE_WRITE_FAILED' });
  await core.close();
  core = openCoreDatabase({ dbPath });
  assert.equal(core.reader.pragmaSnapshot().journalMode, 'wal');
  assert.equal(core.reader.journalEventCount(), 1);
  assert.equal(core.reader.journalEvent('kept').journal_event_id, 'kept');
  assert.equal(core.reader.journalEvent('lost'), undefined);
  await core.close();

  const inspector = openTestInspector(dbPath);
  assert.equal(inspector.prepare('SELECT count(*) AS count FROM journal_event').get().count, 1);
  inspector.close();
});
