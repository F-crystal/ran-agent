import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  computeHermesIdentityVersion,
  loadPublishedProjection,
  publishHermesIdentityProjection,
  reconcilePublishedProjection,
  verifyPublishedProjection,
  verifyPublishedProjectionRuntimeAccess,
} from '../src/hermesIdentityProjection.mjs';

const PROJECT_ROOT = path.resolve(new URL('../..', import.meta.url).pathname);

function fixture(prefix = 'hermes-projection-', revision = 7) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  if (Number.isInteger(process.getuid?.()) && Number.isInteger(process.getgid?.())) {
    fs.chownSync(directory, process.getuid(), process.getgid());
  }
  fs.chmodSync(directory, 0o700);
  const coreDbPath = path.join(directory, 'core.sqlite3');
  const outputPath = path.join(directory, 'state', 'published-memory-context.json');
  const db = new DatabaseSync(coreDbPath);
  db.exec(`
    CREATE TABLE activity (
      activity_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      domain TEXT NOT NULL,
      state TEXT NOT NULL,
      contract_revision INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  if (revision !== null) {
    db.prepare('INSERT INTO activity VALUES (?, ?, ?, ?, ?, ?)').run(
      'active-1', 'Ship O1 safely', 'runtime', 'active', revision, '2026-07-23T00:00:00Z',
    );
  }
  db.close();
  return { directory, coreDbPath, outputPath };
}

test('publisher uses immutable revision + verified pointer and reader resolves one published snapshot', () => {
  const item = fixture();
  const snapshot = publishHermesIdentityProjection({ projectRoot: PROJECT_ROOT, ...item });
  const identity = computeHermesIdentityVersion(PROJECT_ROOT);
  const pointer = JSON.parse(fs.readFileSync(item.outputPath, 'utf8'));
  const state = JSON.parse(fs.readFileSync(`${item.outputPath}.publication-state.json`, 'utf8'));
  const manifestPath = path.join(`${item.outputPath}.manifests`, pointer.manifest_file);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const revisionPath = path.join(`${item.outputPath}.revisions`, manifest.revision_file);

  assert.equal(snapshot.activity_revision, 7);
  assert.equal(snapshot.activities.length, 1);
  assert.match(snapshot.published_memory_context, /Ship O1 safely/);
  assert.deepEqual(Object.keys(pointer).sort(), ['manifest_digest', 'manifest_file', 'schema_version']);
  assert.equal(manifest.projection_revision, snapshot.projection_revision);
  assert.equal(manifest.identity_digest, identity.version);
  assert.equal(manifest.high_water_activity_revision, 7);
  assert.equal(state.state, 'published');
  assert.equal(state.high_water_activity_revision, 7);
  assert.equal(state.high_water_projection_revision, snapshot.projection_revision);
  assert.deepEqual(loadPublishedProjection(item.outputPath, identity.version), snapshot);
  assert.deepEqual(verifyPublishedProjection(JSON.parse(fs.readFileSync(revisionPath, 'utf8')), identity.version), snapshot);
  assert.deepEqual(verifyPublishedProjectionRuntimeAccess({
    outputPath: item.outputPath,
    projectRoot: PROJECT_ROOT,
  }), snapshot);
  assert.equal(fs.statSync(path.dirname(item.outputPath)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(`${item.outputPath}.revisions`).mode & 0o777, 0o700);
  assert.equal(fs.statSync(`${item.outputPath}.manifests`).mode & 0o777, 0o700);
  assert.equal(fs.statSync(item.outputPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(manifestPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(revisionPath).mode & 0o777, 0o600);
});

test('publisher preserves last verified projection on missing producer database', () => {
  const item = fixture();
  const first = publishHermesIdentityProjection({ projectRoot: PROJECT_ROOT, ...item });
  const pointerBefore = fs.readFileSync(item.outputPath, 'utf8');
  assert.throws(() => publishHermesIdentityProjection({
    projectRoot: PROJECT_ROOT,
    coreDbPath: path.join(item.directory, 'missing.sqlite3'),
    outputPath: item.outputPath,
  }), /core_database_invalid|ENOENT/);
  assert.equal(fs.readFileSync(item.outputPath, 'utf8'), pointerBefore);
  assert.ok(fs.existsSync(path.join(
    `${item.outputPath}.revisions`,
    `${first.projection_revision.slice('sha256:'.length)}.json`,
  )));
  const failed = JSON.parse(fs.readFileSync(`${item.outputPath}.publication-state.json`, 'utf8'));
  assert.equal(failed.state, 'failed');
  assert.equal(failed.high_water_activity_revision, 7);
  assert.equal(failed.high_water_projection_revision, first.projection_revision);
});

test('pointer directory fsync failure is ambiguous, blocks reads, and reconciliation establishes actual current', () => {
  const item = fixture();
  const identity = computeHermesIdentityVersion(PROJECT_ROOT);
  assert.throws(() => publishHermesIdentityProjection({
    projectRoot: PROJECT_ROOT,
    ...item,
    faultInjector(stage) {
      if (stage === 'pointer-directory-fsync') throw new Error('injected pointer fsync');
    },
  }), (error) => error.code === 'PROJECTION_PUBLICATION_AMBIGUOUS');
  assert.equal(JSON.parse(fs.readFileSync(`${item.outputPath}.publication-state.json`, 'utf8')).state, 'ambiguous');
  assert.throws(() => loadPublishedProjection(item.outputPath, identity.version), /projection_publication_ambiguous/);
  const reconciled = reconcilePublishedProjection({ outputPath: item.outputPath, identityVersion: identity.version });
  assert.equal(loadPublishedProjection(item.outputPath, identity.version).projection_revision, reconciled.projection_revision);
});

for (const stage of [
  'state-building-write',
  'state-building-file-fsync',
  'revision-temp-create',
  'revision-write',
  'revision-file-fsync',
  'revision-rename',
  'revision-directory-fsync',
  'manifest-temp-create',
  'manifest-write',
  'manifest-file-fsync',
  'manifest-rename',
  'manifest-directory-fsync',
  'pointer-temp-create',
  'pointer-write',
  'pointer-file-fsync',
  'pointer-rename',
]) {
  test(`publication fault at ${stage} never reports published`, () => {
    const item = fixture(`hermes-projection-${stage}-`);
    assert.throws(() => publishHermesIdentityProjection({
      projectRoot: PROJECT_ROOT,
      ...item,
      faultInjector(current) {
        if (current === stage) throw new Error(`injected:${stage}`);
      },
    }), new RegExp(`injected:${stage}`));
    assert.notEqual(
      JSON.parse(fs.readFileSync(`${item.outputPath}.publication-state.json`, 'utf8')).state,
      'published',
    );
  });
}

for (const stage of [
  'pointer-swapped',
  'pointer-directory-fsync',
  'pointer-swap-process-interrupt',
  'post-publication-verification',
  'state-published-write',
  'state-published-file-fsync',
  'state-published-rename',
  'state-published-directory-fsync',
]) {
  test(`post-swap publication fault at ${stage} is ambiguous and blocks readers`, () => {
    const item = fixture(`hermes-projection-${stage}-`);
    const identity = computeHermesIdentityVersion(PROJECT_ROOT);
    assert.throws(() => publishHermesIdentityProjection({
      projectRoot: PROJECT_ROOT,
      ...item,
      faultInjector(current) {
        if (current === stage) throw new Error(`injected:${stage}`);
      },
    }), (error) => error.code === 'PROJECTION_PUBLICATION_AMBIGUOUS');
    assert.notEqual(
      JSON.parse(fs.readFileSync(`${item.outputPath}.publication-state.json`, 'utf8')).state,
      'published',
    );
    assert.throws(() => loadPublishedProjection(item.outputPath, identity.version));
  });
}

test('ambiguous-state write failure still leaves consumers fail-closed', () => {
  const item = fixture('hermes-projection-ambiguous-state-fault-');
  const identity = computeHermesIdentityVersion(PROJECT_ROOT);
  assert.throws(() => publishHermesIdentityProjection({
    projectRoot: PROJECT_ROOT,
    ...item,
    faultInjector(stage) {
      if (stage === 'pointer-directory-fsync' || stage === 'state-ambiguous-write') {
        throw new Error(`injected:${stage}`);
      }
    },
  }), (error) => error.code === 'PROJECTION_PUBLICATION_AMBIGUOUS');
  assert.notEqual(
    JSON.parse(fs.readFileSync(`${item.outputPath}.publication-state.json`, 'utf8')).state,
    'published',
  );
  assert.throws(() => loadPublishedProjection(item.outputPath, identity.version));
});

test('anti-rollback rejects an older activity revision and retains the verified high-water pointer', () => {
  const item = fixture('hermes-projection-rollback-', 9);
  const first = publishHermesIdentityProjection({ projectRoot: PROJECT_ROOT, ...item });
  const pointerBefore = fs.readFileSync(item.outputPath, 'utf8');
  const db = new DatabaseSync(item.coreDbPath);
  db.prepare('UPDATE activity SET contract_revision = 8').run();
  db.close();
  assert.throws(
    () => publishHermesIdentityProjection({ projectRoot: PROJECT_ROOT, ...item }),
    (error) => error.code === 'PROJECTION_ROLLBACK_CONFLICT',
  );
  assert.equal(fs.readFileSync(item.outputPath, 'utf8'), pointerBefore);
  const pointer = JSON.parse(pointerBefore);
  const manifest = JSON.parse(fs.readFileSync(
    path.join(`${item.outputPath}.manifests`, pointer.manifest_file),
    'utf8',
  ));
  assert.equal(manifest.projection_revision, first.projection_revision);
});

test('publisher treats publication-state revision 10 as a durable floor after pointer and database rollback to 9', () => {
  const item = fixture('hermes-projection-durable-floor-', 9);
  publishHermesIdentityProjection({ projectRoot: PROJECT_ROOT, ...item });
  const pointer9 = fs.readFileSync(item.outputPath);
  const db = new DatabaseSync(item.coreDbPath);
  db.prepare('UPDATE activity SET contract_revision = 10').run();
  db.close();
  const revision10 = publishHermesIdentityProjection({ projectRoot: PROJECT_ROOT, ...item });
  const state10 = fs.readFileSync(`${item.outputPath}.publication-state.json`);
  const manifestCount = fs.readdirSync(`${item.outputPath}.manifests`).length;

  fs.writeFileSync(item.outputPath, pointer9);
  const rolledBackDb = new DatabaseSync(item.coreDbPath);
  rolledBackDb.prepare('UPDATE activity SET contract_revision = 9').run();
  rolledBackDb.close();

  assert.throws(
    () => publishHermesIdentityProjection({ projectRoot: PROJECT_ROOT, ...item }),
    (error) => error.code === 'PROJECTION_ROLLBACK_CONFLICT',
  );
  assert.deepEqual(fs.readFileSync(`${item.outputPath}.publication-state.json`), state10);
  const durable = JSON.parse(state10);
  assert.equal(durable.high_water_activity_revision, 10);
  assert.equal(durable.high_water_projection_revision, revision10.projection_revision);
  assert.equal(fs.readdirSync(`${item.outputPath}.manifests`).length, manifestCount);
  const identity = computeHermesIdentityVersion(PROJECT_ROOT);
  assert.throws(
    () => loadPublishedProjection(item.outputPath, identity.version),
    /projection_rollback_rejected/,
  );
});

test('publisher repairs a verified pointer above state floor but never lowers non-published durable states', () => {
  const item = fixture('hermes-projection-forward-repair-', 9);
  const revision9 = publishHermesIdentityProjection({ projectRoot: PROJECT_ROOT, ...item });
  const state9 = fs.readFileSync(`${item.outputPath}.publication-state.json`);
  const db = new DatabaseSync(item.coreDbPath);
  db.prepare('UPDATE activity SET contract_revision = 10').run();
  db.close();
  const revision10 = publishHermesIdentityProjection({ projectRoot: PROJECT_ROOT, ...item });

  fs.writeFileSync(`${item.outputPath}.publication-state.json`, state9);
  assert.equal(
    publishHermesIdentityProjection({ projectRoot: PROJECT_ROOT, ...item }).projection_revision,
    revision10.projection_revision,
  );
  assert.equal(
    JSON.parse(fs.readFileSync(`${item.outputPath}.publication-state.json`, 'utf8'))
      .high_water_activity_revision,
    10,
  );

  const rolledBackDb = new DatabaseSync(item.coreDbPath);
  rolledBackDb.prepare('UPDATE activity SET contract_revision = 9').run();
  rolledBackDb.close();
  for (const state of ['building', 'failed', 'ambiguous']) {
    const record = {
      schema_version: 1,
      state,
      high_water_activity_revision: 10,
      high_water_projection_revision: revision10.projection_revision,
      ...(state === 'ambiguous' ? { projection_revision: revision10.projection_revision } : {}),
    };
    const before = `${JSON.stringify(record)}\n`;
    fs.writeFileSync(`${item.outputPath}.publication-state.json`, before);
    assert.throws(
      () => publishHermesIdentityProjection({ projectRoot: PROJECT_ROOT, ...item }),
      (error) => error.code === 'PROJECTION_ROLLBACK_CONFLICT',
    );
    assert.equal(fs.readFileSync(`${item.outputPath}.publication-state.json`, 'utf8'), before);
  }
  assert.notEqual(revision9.projection_revision, revision10.projection_revision);
});

test('publisher preserves damaged state, rejects same-revision digest conflict, and is idempotent after restart', () => {
  const damaged = fixture('hermes-projection-damaged-state-', 9);
  publishHermesIdentityProjection({ projectRoot: PROJECT_ROOT, ...damaged });
  fs.writeFileSync(`${damaged.outputPath}.publication-state.json`, '{"damaged":true}\n');
  assert.throws(
    () => publishHermesIdentityProjection({ projectRoot: PROJECT_ROOT, ...damaged }),
    (error) => error.code === 'PROJECTION_RECONCILIATION_REQUIRED',
  );
  assert.equal(fs.readFileSync(`${damaged.outputPath}.publication-state.json`, 'utf8'), '{"damaged":true}\n');

  const conflict = fixture('hermes-projection-same-revision-conflict-', 9);
  const first = publishHermesIdentityProjection({ projectRoot: PROJECT_ROOT, ...conflict });
  const before = fs.readFileSync(`${conflict.outputPath}.publication-state.json`);
  const db = new DatabaseSync(conflict.coreDbPath);
  db.prepare("UPDATE activity SET title = 'Changed at same revision'").run();
  db.close();
  assert.throws(
    () => publishHermesIdentityProjection({ projectRoot: PROJECT_ROOT, ...conflict }),
    (error) => error.code === 'PROJECTION_REVISION_CONFLICT',
  );
  assert.deepEqual(fs.readFileSync(`${conflict.outputPath}.publication-state.json`), before);

  const restart = fixture('hermes-projection-idempotent-restart-', 9);
  const published = publishHermesIdentityProjection({ projectRoot: PROJECT_ROOT, ...restart });
  const repeated = publishHermesIdentityProjection({ projectRoot: PROJECT_ROOT, ...restart });
  assert.equal(repeated.projection_revision, published.projection_revision);
  assert.equal(
    JSON.parse(fs.readFileSync(`${restart.outputPath}.publication-state.json`, 'utf8')).state,
    'published',
  );
  assert.equal(first.activity_revision, 9);
});

test('runtime access verification checks every directory and current graph file', () => {
  const item = fixture('hermes-projection-runtime-access-', 9);
  publishHermesIdentityProjection({ projectRoot: PROJECT_ROOT, ...item });
  const pointer = JSON.parse(fs.readFileSync(item.outputPath, 'utf8'));
  const manifestPath = path.join(`${item.outputPath}.manifests`, pointer.manifest_file);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const revisionPath = path.join(`${item.outputPath}.revisions`, manifest.revision_file);
  const options = { outputPath: item.outputPath, projectRoot: PROJECT_ROOT };
  assert.doesNotThrow(() => verifyPublishedProjectionRuntimeAccess(options));
  for (const target of [
    path.dirname(item.outputPath),
    `${item.outputPath}.revisions`,
    `${item.outputPath}.manifests`,
  ]) {
    fs.chmodSync(target, 0o755);
    assert.throws(() => verifyPublishedProjectionRuntimeAccess(options), /projection_runtime_mode_invalid/);
    fs.chmodSync(target, 0o700);
  }
  for (const target of [
    item.outputPath,
    `${item.outputPath}.publication-state.json`,
    manifestPath,
    revisionPath,
  ]) {
    fs.chmodSync(target, 0o644);
    assert.throws(() => verifyPublishedProjectionRuntimeAccess(options), /projection_runtime_mode_invalid/);
    fs.chmodSync(target, 0o600);
  }
  assert.throws(() => verifyPublishedProjectionRuntimeAccess({
    ...options,
    expectedUid: (process.getuid?.() || 0) + 1,
    expectedGid: process.getgid?.() || 0,
  }), /projection_runtime_owner_invalid/);
});

test('corrupted immutable revision and cross-reference replacement fail closed', () => {
  const item = fixture('hermes-projection-corrupt-');
  publishHermesIdentityProjection({ projectRoot: PROJECT_ROOT, ...item });
  const identity = computeHermesIdentityVersion(PROJECT_ROOT);
  const pointer = JSON.parse(fs.readFileSync(item.outputPath, 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(
    path.join(`${item.outputPath}.manifests`, pointer.manifest_file),
    'utf8',
  ));
  const revisionPath = path.join(`${item.outputPath}.revisions`, manifest.revision_file);
  fs.writeFileSync(revisionPath, '{"tampered":true}\n');
  assert.throws(() => loadPublishedProjection(item.outputPath, identity.version), /revision_digest_mismatch/);
});

test('manifest mismatch and missing manifest pointer fail closed', () => {
  const item = fixture('hermes-projection-manifest-cross-reference-');
  publishHermesIdentityProjection({ projectRoot: PROJECT_ROOT, ...item });
  const identity = computeHermesIdentityVersion(PROJECT_ROOT);
  const pointer = JSON.parse(fs.readFileSync(item.outputPath, 'utf8'));
  const manifestPath = path.join(`${item.outputPath}.manifests`, pointer.manifest_file);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.revision_digest = `sha256:${'0'.repeat(64)}`;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
  assert.throws(() => loadPublishedProjection(item.outputPath, identity.version), /manifest_digest_mismatch/);

  fs.writeFileSync(item.outputPath, `${JSON.stringify({
    schema_version: 1,
    manifest_file: `${'f'.repeat(64)}.json`,
    manifest_digest: `sha256:${'f'.repeat(64)}`,
  })}\n`);
  assert.throws(() => loadPublishedProjection(item.outputPath, identity.version), /ENOENT/);
});

test('reconciliation read failure remains ambiguous', () => {
  const item = fixture('hermes-projection-reconcile-failure-');
  const identity = computeHermesIdentityVersion(PROJECT_ROOT);
  assert.throws(() => publishHermesIdentityProjection({
    projectRoot: PROJECT_ROOT,
    ...item,
    faultInjector(stage) {
      if (stage === 'pointer-swap-process-interrupt') throw new Error('crash');
    },
  }), (error) => error.code === 'PROJECTION_PUBLICATION_AMBIGUOUS');
  const pointer = JSON.parse(fs.readFileSync(item.outputPath, 'utf8'));
  fs.unlinkSync(path.join(`${item.outputPath}.manifests`, pointer.manifest_file));
  assert.throws(() => reconcilePublishedProjection({ outputPath: item.outputPath, identityVersion: identity.version }));
  assert.equal(JSON.parse(fs.readFileSync(`${item.outputPath}.publication-state.json`, 'utf8')).state, 'ambiguous');
});

test('verified graph without published state reconciles before consumers can read it', () => {
  const item = fixture('hermes-projection-state-gap-');
  const identity = computeHermesIdentityVersion(PROJECT_ROOT);
  assert.throws(() => publishHermesIdentityProjection({
    projectRoot: PROJECT_ROOT,
    ...item,
    faultInjector(stage) {
      if (stage === 'state-published-temp-create') throw new Error('state gap');
    },
  }), (error) => error.code === 'PROJECTION_PUBLICATION_AMBIGUOUS');
  assert.throws(() => loadPublishedProjection(item.outputPath, identity.version));
  const reconciled = reconcilePublishedProjection({ outputPath: item.outputPath, identityVersion: identity.version });
  assert.equal(loadPublishedProjection(item.outputPath, identity.version).projection_revision, reconciled.projection_revision);
});

test('reconciliation high-water rejects a pointer rolled back to an old verified graph', () => {
  const item = fixture('hermes-projection-pointer-rollback-', 9);
  publishHermesIdentityProjection({ projectRoot: PROJECT_ROOT, ...item });
  const oldPointer = fs.readFileSync(item.outputPath);
  const db = new DatabaseSync(item.coreDbPath);
  db.prepare('UPDATE activity SET contract_revision = 10').run();
  db.close();
  publishHermesIdentityProjection({ projectRoot: PROJECT_ROOT, ...item });
  const identity = computeHermesIdentityVersion(PROJECT_ROOT);
  fs.writeFileSync(item.outputPath, oldPointer);
  assert.throws(() => reconcilePublishedProjection({
    outputPath: item.outputPath,
    identityVersion: identity.version,
  }), /projection_rollback_rejected/);
  assert.equal(JSON.parse(fs.readFileSync(`${item.outputPath}.publication-state.json`, 'utf8')).state, 'ambiguous');
});

test('publication lock rejects concurrent producer and does not consume the lock', () => {
  const item = fixture('hermes-projection-concurrent-');
  fs.mkdirSync(path.dirname(item.outputPath), { recursive: true });
  fs.writeFileSync(`${item.outputPath}.publication.lock`, 'held');
  assert.throws(() => publishHermesIdentityProjection({ projectRoot: PROJECT_ROOT, ...item }), /projection_publication_concurrent/);
  assert.equal(fs.readFileSync(`${item.outputPath}.publication.lock`, 'utf8'), 'held');
});
