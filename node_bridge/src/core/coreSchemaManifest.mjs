import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { coreError } from './coreErrors.mjs';
import { CORE_SCHEMA_V1, CORE_SCHEMA_V2 } from './coreSchema.mjs';

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function normalizeSql(sql) {
  return String(sql || '').replace(/\r\n?/g, '\n').replace(/\s+/g, ' ').trim();
}

function normalizedRows(rows) {
  return rows.map((row) => ({ ...row }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function tableManifest(db, name, sql) {
  const quoted = quoteIdentifier(name);
  const indexes = db.prepare(`PRAGMA index_list(${quoted})`).all().map((index) => ({
    name: index.origin === 'c' ? index.name : null,
    unique: Number(index.unique),
    origin: index.origin,
    partial: Number(index.partial),
    columns: db.prepare(`PRAGMA index_info(${quoteIdentifier(index.name)})`).all()
      .map((column) => column.name),
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return {
    type: 'table',
    name,
    sql: normalizeSql(sql),
    columns: normalizedRows(db.prepare(`PRAGMA table_xinfo(${quoted})`).all()),
    foreignKeys: normalizedRows(db.prepare(`PRAGMA foreign_key_list(${quoted})`).all()),
    indexes,
  };
}

export function buildCoreSchemaManifest(db, expectedNames) {
  const objects = [];
  const expectedKeys = new Set(expectedNames.map((entry) => `${entry.type}:${entry.name}`));
  const coreTables = new Set(expectedNames.filter((entry) => entry.type === 'table').map((entry) => entry.name));
  for (const expected of expectedNames) {
    const row = db.prepare(`SELECT type, name, sql FROM sqlite_schema
      WHERE type=? AND name=? AND name NOT LIKE 'sqlite_%'`).get(expected.type, expected.name);
    if (!row) {
      objects.push({ type: expected.type, name: expected.name, missing: true });
    } else if (row.type === 'table') {
      objects.push(tableManifest(db, row.name, row.sql));
    } else {
      objects.push({ type: row.type, name: row.name, sql: normalizeSql(row.sql) });
    }
  }
  const unexpectedCoreObjects = db.prepare(`SELECT type, name, tbl_name FROM sqlite_schema
    WHERE type IN ('index','trigger') AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL
    ORDER BY type, name`).all()
    .filter((row) => coreTables.has(row.tbl_name) && !expectedKeys.has(`${row.type}:${row.name}`))
    .map((row) => ({ ...row }));
  return Object.freeze({
    objects: objects.sort((left, right) => `${left.type}:${left.name}`.localeCompare(`${right.type}:${right.name}`)),
    unexpectedCoreObjects,
  });
}

export function coreSchemaFingerprint(manifest) {
  return createHash('sha256').update(JSON.stringify(manifest), 'utf8').digest('hex');
}

function buildExpected(statements) {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys=ON');
    for (const statement of statements) db.exec(statement);
    const expectedNames = db.prepare(`SELECT type, name FROM sqlite_schema
      WHERE type IN ('table','index','trigger','view')
        AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL
      ORDER BY type, name`).all().map((row) => ({ ...row }));
    const manifest = buildCoreSchemaManifest(db, expectedNames);
    return Object.freeze({
      expectedNames: Object.freeze(expectedNames),
      manifest,
      fingerprint: coreSchemaFingerprint(manifest),
    });
  } finally {
    db.close();
  }
}

const EXPECTED_BY_VERSION = new Map([
  [1, buildExpected(CORE_SCHEMA_V1)],
  [2, buildExpected([...CORE_SCHEMA_V1, ...CORE_SCHEMA_V2])],
]);

export function expectedCoreSchemaFingerprint(version) {
  const expected = EXPECTED_BY_VERSION.get(version);
  if (!expected) throw coreError('CORE_SCHEMA_VERSION_UNSUPPORTED', `no expected schema manifest for version ${version}`);
  return expected.fingerprint;
}

export function validateCoreSchema(db, version) {
  const expected = EXPECTED_BY_VERSION.get(version);
  if (!expected) throw coreError('CORE_SCHEMA_VERSION_UNSUPPORTED', `no expected schema manifest for version ${version}`);
  const actual = buildCoreSchemaManifest(db, expected.expectedNames);
  const fingerprint = coreSchemaFingerprint(actual);
  if (fingerprint !== expected.fingerprint) {
    throw coreError('CORE_SCHEMA_DRIFT', `Core schema fingerprint mismatch for version ${version}`);
  }
  return fingerprint;
}
