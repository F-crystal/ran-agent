import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { CoreError, coreError } from './coreErrors.mjs';
import { CORE_MIGRATIONS, runCoreMigrations } from './coreMigrations.mjs';
import { CORE_DATABASE_MODE, CORE_DIRECTORY_MODE } from './corePaths.mjs';
import { expectedCoreSchemaFingerprint, validateCoreSchema } from './coreSchemaManifest.mjs';
import { createCoreWriter } from './coreWriter.mjs';
import { createCoreTransactionFacade } from './repositories/coreRepository.mjs';
import { createPackageBIngressReader } from './repositories/packageBIngressRepository.mjs';
import { createPackageBAssemblyReader } from './repositories/packageBAssemblyRepository.mjs';
import { createPackageBProviderReader } from './repositories/packageBProviderRepository.mjs';
import { createPackageBTurnReader } from './repositories/packageBTurnRepository.mjs';
import {
  createPackageBFinalReader,
  createPackageBPresentationReader,
} from './repositories/packageBPresentationRepository.mjs';

function scalar(db, sql) {
  const row = db.prepare(sql).get();
  return row ? Object.values(row)[0] : undefined;
}

function verifyPragmas(db) {
  const actual = Object.freeze({
    journalMode: String(scalar(db, 'PRAGMA journal_mode')).toLowerCase(),
    foreignKeys: Number(scalar(db, 'PRAGMA foreign_keys')),
    synchronous: Number(scalar(db, 'PRAGMA synchronous')),
    busyTimeout: Number(scalar(db, 'PRAGMA busy_timeout')),
    recursiveTriggers: Number(scalar(db, 'PRAGMA recursive_triggers')),
    ignoreCheckConstraints: Number(scalar(db, 'PRAGMA ignore_check_constraints')),
  });
  if (actual.journalMode !== 'wal' || actual.foreignKeys !== 1
    || actual.synchronous !== 2 || actual.busyTimeout !== 5000
    || actual.recursiveTriggers !== 1 || actual.ignoreCheckConstraints !== 0) {
    throw coreError('CORE_DB_PRAGMA_MISMATCH', 'Core database safety pragmas were not applied');
  }
  return actual;
}

export function openCoreDatabase(options = {}) {
  return new CoreDatabase(options).open();
}

export class CoreDatabase {
  #db = null;
  #writerController = null;
  #writerFacade = null;
  #reader = null;
  #transactionIdentity = null;
  #schemaReady = false;
  #writesStarted = false;
  #now;

  constructor({ dbPath, now = () => new Date(Math.floor(Date.now() / 1_000) * 1_000) } = {}) {
    if (!String(dbPath || '').trim()) throw coreError('CORE_DB_PATH_REQUIRED', 'explicit Core database path is required');
    if (typeof now !== 'function') throw coreError('CORE_DB_CLOCK_REQUIRED', 'Core clock must be a function');
    this.dbPath = path.resolve(dbPath);
    this.#now = now;
  }

  open() {
    if (this.#db) return this;
    const directory = path.dirname(this.dbPath);
    fs.mkdirSync(directory, { recursive: true, mode: CORE_DIRECTORY_MODE });
    fs.chmodSync(directory, CORE_DIRECTORY_MODE);
    let db;
    try {
      db = new DatabaseSync(this.dbPath);
      fs.chmodSync(this.dbPath, CORE_DATABASE_MODE);
      db.exec('PRAGMA journal_mode=WAL');
      db.exec('PRAGMA foreign_keys=ON');
      db.exec('PRAGMA synchronous=FULL');
      db.exec('PRAGMA busy_timeout=5000');
      db.exec('PRAGMA recursive_triggers=ON');
      db.exec('PRAGMA ignore_check_constraints=OFF');
      verifyPragmas(db);
      this.#secureDatabaseFiles();
      this.#db = db;
      const existingVersion = Number(scalar(db, 'PRAGMA user_version'));
      if (existingVersion > 0) {
        runCoreMigrations(db, CORE_MIGRATIONS, { validateVersion: validateCoreSchema });
        this.#schemaReady = true;
      }
      this.#reader = this.#createReader();
      this.#writerController = createCoreWriter({
        dbIdentity: this.#canonicalIdentity(directory),
        runTransaction: (callback) => this.#transaction(callback),
      });
      this.#writerFacade = this.#writerController.facade;
      this.#schemaReady = existingVersion > 0;
      this.#writesStarted = false;
      return this;
    } catch (error) {
      try {
        db?.close();
      } catch {
        // The original open failure is authoritative; the handle is already unusable.
      }
      this.#db = null;
      this.#reader = null;
      this.#writerController = null;
      this.#writerFacade = null;
      if (error instanceof CoreError) throw error;
      throw coreError('CORE_DB_OPEN_FAILED', 'Core database unavailable', error);
    }
  }

  get writer() {
    this.#requireOpen();
    return this.#writerFacade;
  }

  get reader() {
    this.#requireOpen();
    return this.#reader;
  }

  migrate() {
    if (this.#writesStarted || this.#transactionIdentity !== null) {
      throw coreError('CORE_MIGRATION_AFTER_WRITE_FORBIDDEN', 'Core migrations must finish before business writes begin');
    }
    this.#secureDatabaseFiles();
    const result = runCoreMigrations(this.#requireOpen(), CORE_MIGRATIONS, { validateVersion: validateCoreSchema });
    this.#schemaReady = true;
    return result;
  }

  async close() {
    if (!this.#db) return;
    await this.#writerController.close();
    const db = this.#db;
    this.#db = null;
    this.#writerController = null;
    this.#writerFacade = null;
    this.#reader = null;
    this.#schemaReady = false;
    this.#writesStarted = false;
    db.close();
  }

  #canonicalIdentity(directory) {
    return path.join(fs.realpathSync(directory), path.basename(this.dbPath));
  }

  #requireOpen() {
    if (!this.#db) throw coreError('CORE_DB_CLOSED', 'Core database is closed');
    return this.#db;
  }

  #secureDatabaseFiles() {
    for (const candidate of [this.dbPath, `${this.dbPath}-wal`, `${this.dbPath}-shm`]) {
      if (fs.existsSync(candidate)) fs.chmodSync(candidate, CORE_DATABASE_MODE);
    }
  }

  #createReader() {
    const read = (sql, ...params) => this.#requireOpen().prepare(sql).get(...params);
    const all = (sql, ...params) => this.#requireOpen().prepare(sql).all(...params);
    const packageBIngress = createPackageBIngressReader({ read, all });
    const packageBAssembly = createPackageBAssemblyReader({ read, all });
    const packageBTurn = createPackageBTurnReader({ read, all });
    const packageBProvider = createPackageBProviderReader({ read, all });
    const packageBPresentation = createPackageBPresentationReader({ read, all });
    const packageBFinal = createPackageBFinalReader({ read, all });
    return Object.freeze({
      pragmaSnapshot: () => verifyPragmas(this.#requireOpen()),
      schemaVersion: () => Number(read('PRAGMA user_version').user_version),
      schemaFingerprint: () => {
        if (!this.#schemaReady) throw coreError('CORE_SCHEMA_NOT_READY', 'Core schema is not validated');
        return expectedCoreSchemaFingerprint(Number(read('PRAGMA user_version').user_version));
      },
      migrationHistory: () => all(`SELECT migration_id, from_version, to_version, checksum, applied_at
        FROM schema_migration ORDER BY to_version`).map((row) => Object.freeze({ ...row })),
      schemaObjectNames: () => all(`SELECT type, name FROM sqlite_master
        WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`).map((row) => Object.freeze({ ...row })),
      foreignKeyViolations: () => all('PRAGMA foreign_key_check').map((row) => Object.freeze({ ...row })),
      journalEventCount: () => Number(read('SELECT count(*) AS count FROM journal_event').count),
      journalEvent: (eventId) => read('SELECT * FROM journal_event WHERE journal_event_id=?', eventId),
      journalPayload: (payloadId) => read('SELECT * FROM journal_payload WHERE journal_payload_id=?', payloadId),
      ingressEventCount: () => Number(read('SELECT count(*) AS count FROM ingress_event').count),
      ingressEvent: (eventId) => read('SELECT * FROM ingress_event WHERE ingress_event_id=?', eventId),
      activity: (activityId) => read('SELECT * FROM activity WHERE activity_id=?', activityId),
      workRun: (workRunId) => read('SELECT * FROM work_run WHERE work_run_id=?', workRunId),
      projectorCursor: (projectorId, targetScope) => read(
        'SELECT * FROM projector_cursor WHERE projector_id=? AND target_scope=?', projectorId, targetScope,
      ),
      projectionOutbox: (outboxId) => read('SELECT * FROM projection_outbox WHERE projection_outbox_id=?', outboxId),
      scheduleSpec: (scheduleSpecId) => read('SELECT * FROM schedule_spec WHERE schedule_spec_id=?', scheduleSpecId),
      scheduleSpecRevision: (revisionId) => read(
        'SELECT * FROM schedule_spec_revision WHERE schedule_spec_revision_id=?', revisionId,
      ),
      wakeOccurrence: (occurrenceId) => read(
        'SELECT * FROM wake_occurrence WHERE wake_occurrence_id=?', occurrenceId,
      ),
      wakeOccurrences: (scheduleSpecId) => all(
        'SELECT * FROM wake_occurrence WHERE schedule_spec_id=? ORDER BY scheduled_for', scheduleSpecId,
      ).map((row) => Object.freeze({ ...row })),
      workRunsForOccurrence: (occurrenceId) => all(
        'SELECT * FROM work_run WHERE wake_occurrence_id=? ORDER BY attempt_no', occurrenceId,
      ).map((row) => Object.freeze({ ...row })),
      livingIdentity: (identityId) => read('SELECT * FROM living_identity WHERE identity_id=?', identityId),
      soulRevision: (soulRevisionId) => read('SELECT * FROM soul_revision WHERE soul_revision_id=?', soulRevisionId),
      packageBIngress,
      packageBAssembly,
      packageBTurn,
      packageBProvider,
      packageBPresentation,
      packageBFinal,
    });
  }

  #transaction(callback) {
    if (typeof callback !== 'function') throw coreError('CORE_TRANSACTION_CALLBACK_REQUIRED', 'transaction callback is required');
    const db = this.#requireOpen();
    if (!this.#schemaReady) {
      throw coreError('CORE_SCHEMA_NOT_READY', 'Core migration history must be validated before writes begin');
    }
    if (this.#transactionIdentity !== null) {
      throw coreError('CORE_TRANSACTION_NESTED_FORBIDDEN', 'nested Core transactions are forbidden');
    }
    const identity = Symbol('core-transaction');
    const token = { active: true, identity };
    const revoke = () => {
      token.active = false;
      if (this.#transactionIdentity === identity) this.#transactionIdentity = null;
    };
    const assertActive = () => {
      if (!token.active || token.identity !== identity || this.#transactionIdentity !== identity) {
        throw coreError('CORE_TRANSACTION_CONTEXT_REVOKED', 'Core transaction context is no longer active');
      }
    };

    this.#secureDatabaseFiles();
    db.exec('BEGIN IMMEDIATE');
    this.#writesStarted = true;
    this.#transactionIdentity = identity;
    const tx = createCoreTransactionFacade({
      assertActive,
      prepare: (sql) => {
        assertActive();
        return db.prepare(sql);
      },
      now: this.#now,
    });
    try {
      const result = callback(tx);
      revoke();
      let then;
      try {
        then = result !== null && (typeof result === 'object' || typeof result === 'function')
          ? Reflect.get(result, 'then')
          : undefined;
      } catch (error) {
        throw coreError('CORE_TRANSACTION_THENABLE_INSPECTION_FAILED', 'transaction result then property threw', error);
      }
      if (typeof then === 'function') {
        if (result instanceof Promise) result.catch(() => {});
        throw coreError('CORE_TRANSACTION_ASYNC_FORBIDDEN', 'Core transaction callbacks must be synchronous');
      }
      db.exec('COMMIT');
      return result;
    } catch (error) {
      revoke();
      try {
        db.exec('ROLLBACK');
      } catch (rollbackError) {
        throw coreError('CORE_TRANSACTION_ROLLBACK_FAILED', 'Core transaction rollback failed', rollbackError);
      }
      throw error;
    } finally {
      revoke();
    }
  }
}
