import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function createTempCore(t, prefix = 'hermes-core-a1-') {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  const dbPath = path.join(root, 'core', 'core-state.sqlite3');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, dbPath };
}

export function openTestInspector(dbPath, { readOnly = true } = {}) {
  const db = new DatabaseSync(dbPath, { readOnly });
  if (!readOnly) {
    db.exec(`PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      PRAGMA recursive_triggers=ON;
      PRAGMA ignore_check_constraints=OFF`);
  }
  return db;
}

export function flushImmediate() {
  return new Promise((resolve) => setImmediate(resolve));
}

export function rowCount(db, table) {
  if (!/^[a-z_]+$/.test(table)) throw new Error('invalid test table name');
  return Number(db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count);
}
