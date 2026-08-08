import { createHash } from 'node:crypto';

import { coreError } from './coreErrors.mjs';
import { CORE_SCHEMA_V1, CORE_SCHEMA_V2 } from './coreSchema.mjs';

const V1_CHECKSUM_SOURCE = `hermes-core-schema-v1\n${CORE_SCHEMA_V1.join('\n-- hermes-core-statement --\n')}`;
const V2_CHECKSUM_SOURCE = `hermes-core-schema-v2\n${CORE_SCHEMA_V2.join('\n-- hermes-core-statement --\n')}`;

export const CORE_MIGRATIONS = Object.freeze([
  Object.freeze({
    migrationId: 'core-0001-initial',
    fromVersion: 0,
    toVersion: 1,
    statements: CORE_SCHEMA_V1,
    checksumSource: V1_CHECKSUM_SOURCE,
  }),
  Object.freeze({
    migrationId: 'core-0002-scheduling',
    fromVersion: 1,
    toVersion: 2,
    statements: CORE_SCHEMA_V2,
    checksumSource: V2_CHECKSUM_SOURCE,
  }),
]);

function normalizeArtifact(value) {
  return String(value).replace(/\r\n?/g, '\n');
}

export function migrationChecksum(migration) {
  if (!migration || typeof migration.checksumSource !== 'string' || migration.checksumSource.length === 0) {
    throw coreError('CORE_MIGRATION_CHECKSUM_SOURCE_REQUIRED', 'migration requires explicit immutable checksumSource');
  }
  const artifact = [
    `id:${migration.migrationId}`,
    `from:${migration.fromVersion}`,
    `to:${migration.toVersion}`,
    'source:',
    normalizeArtifact(migration.checksumSource),
  ].join('\n');
  return createHash('sha256').update(artifact, 'utf8').digest('hex');
}

export function validateMigrationPlan(migrations) {
  if (!Array.isArray(migrations)) {
    throw coreError('CORE_MIGRATION_SEQUENCE_INVALID', 'migration plan must be an array');
  }
  let expected = 0;
  const ids = new Set();
  const toVersions = new Set();
  for (const migration of migrations) {
    if (!migration || typeof migration.migrationId !== 'string' || !migration.migrationId.trim()
      || ids.has(migration.migrationId) || toVersions.has(migration.toVersion)
      || migration.fromVersion !== expected || migration.toVersion !== expected + 1
      || !Array.isArray(migration.statements) || migration.statements.length === 0
      || migration.statements.some((statement) => typeof statement !== 'string' || !statement.trim())
      || typeof migration.checksumSource !== 'string' || migration.checksumSource.length === 0) {
      throw coreError('CORE_MIGRATION_SEQUENCE_INVALID', 'migrations must be immutable, unique, contiguous and ordered from version 0');
    }
    ids.add(migration.migrationId);
    toVersions.add(migration.toVersion);
    expected = migration.toVersion;
  }
  return expected;
}

function readMigrationHistory(db) {
  const activeVersion = Number(db.prepare('PRAGMA user_version').get().user_version);
  const applicationObjectCount = Number(db.prepare(`SELECT count(*) AS count FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%'`).get().count);
  const ledgerExists = Boolean(db.prepare(
    "SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name='schema_migration'",
  ).get());
  if (!ledgerExists) return { activeVersion, ledgerExists, rows: [], applicationObjectCount };
  try {
    const rows = db.prepare(`SELECT migration_id, from_version, to_version, checksum, applied_at
      FROM schema_migration ORDER BY to_version, migration_id`).all();
    return { activeVersion, ledgerExists, rows, applicationObjectCount };
  } catch (error) {
    throw coreError('CORE_MIGRATION_LEDGER_INVALID', 'migration ledger cannot be read with the required schema', error);
  }
}

function validateAppliedHistory(history, migrations, maximumVersion) {
  const { activeVersion, ledgerExists, rows, applicationObjectCount } = history;
  if (!Number.isInteger(activeVersion) || activeVersion < 0 || activeVersion > maximumVersion) {
    throw coreError('CORE_MIGRATION_VERSION_UNSUPPORTED', `unsupported active schema version ${activeVersion}`);
  }
  if (activeVersion > 0 && !ledgerExists) {
    throw coreError('CORE_MIGRATION_LEDGER_MISSING', 'non-zero schema version requires a complete migration ledger');
  }
  if (activeVersion === 0 && !ledgerExists && applicationObjectCount !== 0) {
    throw coreError('CORE_MIGRATION_DIRTY_DATABASE', 'version 0 Core database must not contain untracked schema objects');
  }
  if (activeVersion === 0 && ledgerExists) {
    throw coreError('CORE_MIGRATION_LEDGER_INVALID', 'version 0 cannot contain a migration ledger');
  }
  if (!ledgerExists) return;
  if (rows.length !== activeVersion) {
    throw coreError('CORE_MIGRATION_VERSION_MISMATCH', 'migration ledger length and active schema version disagree');
  }

  const ids = new Set();
  const toVersions = new Set();
  let expectedFrom = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const expectedMigration = migrations[index];
    const fromVersion = Number(row.from_version);
    const toVersion = Number(row.to_version);
    if (ids.has(row.migration_id) || toVersions.has(toVersion)
      || fromVersion !== expectedFrom || toVersion !== expectedFrom + 1
      || !expectedMigration || expectedMigration.migrationId !== row.migration_id
      || expectedMigration.fromVersion !== fromVersion || expectedMigration.toVersion !== toVersion) {
      throw coreError('CORE_MIGRATION_LEDGER_INVALID', 'migration ledger is not the exact contiguous plan prefix');
    }
    if (migrationChecksum(expectedMigration) !== row.checksum) {
      throw coreError('CORE_MIGRATION_CHECKSUM_MISMATCH', `applied migration changed: ${row.migration_id}`);
    }
    ids.add(row.migration_id);
    toVersions.add(toVersion);
    expectedFrom = toVersion;
  }
  if (expectedFrom !== activeVersion) {
    throw coreError('CORE_MIGRATION_VERSION_MISMATCH', 'migration ledger maximum and active schema version disagree');
  }
}

// Internal Foundation runner. The CoreDatabase raw handle is never returned to callers.
// Tests may pass an isolated DatabaseSync handle to exercise synthetic migration plans.
export function runCoreMigrations(db, migrations = CORE_MIGRATIONS, {
  now = () => new Date(),
  validateVersion,
} = {}) {
  const maximumVersion = validateMigrationPlan(migrations);
  const history = readMigrationHistory(db);
  validateAppliedHistory(history, migrations, maximumVersion);
  if (history.activeVersion > 0 && typeof validateVersion === 'function') {
    validateVersion(db, history.activeVersion);
  }

  const pending = migrations.slice(history.activeVersion);
  if (pending.length === 0) return { version: history.activeVersion, applied: [] };

  const appliedAt = now().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const migration of pending) {
      for (const statement of migration.statements) db.exec(statement);
      db.prepare(`INSERT INTO schema_migration(
        migration_id, from_version, to_version, checksum, applied_at
      ) VALUES (?, ?, ?, ?, ?)`).run(
        migration.migrationId,
        migration.fromVersion,
        migration.toVersion,
        migrationChecksum(migration),
        appliedAt,
      );
    }
    db.exec(`PRAGMA user_version=${pending.at(-1).toVersion}`);
    if (typeof validateVersion === 'function') validateVersion(db, pending.at(-1).toVersion);
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch (rollbackError) {
      throw coreError('CORE_MIGRATION_ROLLBACK_FAILED', 'migration batch rollback failed', rollbackError);
    }
    throw error;
  }
  return { version: pending.at(-1).toVersion, applied: pending.map((migration) => migration.migrationId) };
}
