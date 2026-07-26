import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const CORE_IDENTITY_FILES = Object.freeze(['IDENTITY.md', 'SOUL.md', 'AGENTS.md']);
const PROJECTION_SCHEMA_VERSION = 3;
const MANIFEST_SCHEMA_VERSION = 1;
const POINTER_SCHEMA_VERSION = 1;
const PUBLICATION_STATE_SCHEMA_VERSION = 1;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const PUBLICATION_STATES = new Set(['building', 'published', 'ambiguous', 'failed', 'reconciling']);

function sha256(value) {
  const input = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  return `sha256:${createHash('sha256').update(input).digest('hex')}`;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function computeHermesIdentityVersion(projectRoot) {
  const profileRoot = path.join(path.resolve(projectRoot), 'hermes', 'profile');
  const sources = {};
  for (const name of CORE_IDENTITY_FILES) {
    const sourcePath = path.join(profileRoot, name);
    const stat = fs.lstatSync(sourcePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`invalid core identity source: ${name}`);
    sources[name] = fs.readFileSync(sourcePath, 'utf8').replace(/\r\n/g, '\n').trim();
  }
  const canonical = CORE_IDENTITY_FILES.map((name) => `${name}\0${sources[name]}`).join('\0');
  return { version: sha256(canonical), sources };
}

export function buildHermesCanonicalProjection(projectRoot) {
  const canonical = computeHermesIdentityVersion(projectRoot);
  const coreLines = canonical.sources['AGENTS.md'].split('\n');
  const requireLine = (prefix) => {
    const line = coreLines.find((value) => value.startsWith(prefix));
    if (!line) throw new Error(`core projection source missing: ${prefix}`);
    return line;
  };
  const liteStart = coreLines.findIndex((line) => line === 'lite/full 口径：');
  if (liteStart < 0) throw new Error('core projection source missing: lite/full 口径：');
  const liteEndOffset = coreLines.slice(liteStart + 1).findIndex((line) => !line.trim());
  const liteEnd = liteEndOffset < 0 ? coreLines.length : liteStart + 1 + liteEndOffset;
  const coreProjection = [
    requireLine('Hermes 是 ran-agent 的前台对话 shell。'),
    requireLine('- 个人记忆：'),
    coreLines.slice(liteStart, liteEnd).join('\n'),
    requireLine('安全边界：'),
  ].join('\n\n');
  return {
    ...canonical,
    text: [
      `identity_version: ${canonical.version}`,
      '--- authoritative IDENTITY.md body ---',
      canonical.sources['IDENTITY.md'],
      '--- authoritative SOUL.md body ---',
      canonical.sources['SOUL.md'],
      '--- authoritative Core canon AGENTS.md minimal projection ---',
      coreProjection,
    ].join('\n'),
  };
}

function projectionPayload(snapshot) {
  return {
    schema_version: snapshot.schema_version,
    identity_version: snapshot.identity_version,
    identity_digest: snapshot.identity_digest,
    source_digest: snapshot.source_digest,
    activity_revision: snapshot.activity_revision,
    activities: snapshot.activities,
    published_memory_context: snapshot.published_memory_context,
  };
}

export function verifyPublishedProjection(snapshot, identityVersion) {
  if (snapshot?.schema_version !== PROJECTION_SCHEMA_VERSION) throw new Error('schema_version_invalid');
  if (snapshot?.identity_version !== identityVersion) throw new Error('identity_version_mismatch');
  if (snapshot?.identity_digest !== identityVersion || !SHA256_PATTERN.test(snapshot.identity_digest)) {
    throw new Error('identity_digest_mismatch');
  }
  if (!SHA256_PATTERN.test(snapshot?.source_digest || '')) throw new Error('source_digest_invalid');
  if (!Number.isInteger(snapshot?.activity_revision) || snapshot.activity_revision < 0) {
    throw new Error('activity_revision_invalid');
  }
  if (!Array.isArray(snapshot?.activities)) throw new Error('activities_invalid');
  if (typeof snapshot?.published_memory_context !== 'string' || !snapshot.published_memory_context.trim()) {
    throw new Error('published_memory_context_invalid');
  }
  const expected = sha256(stableJson(projectionPayload(snapshot)));
  if (snapshot?.projection_revision !== expected) throw new Error('projection_revision_mismatch');
  return snapshot;
}

function pointerPaths(outputPath) {
  const target = path.resolve(outputPath);
  return {
    target,
    directory: path.dirname(target),
    revisions: path.join(path.dirname(target), `${path.basename(target)}.revisions`),
    manifests: path.join(path.dirname(target), `${path.basename(target)}.manifests`),
    state: `${target}.publication-state.json`,
    lock: `${target}.publication.lock`,
  };
}

function invokeFault(faultInjector, stage) {
  faultInjector?.(stage);
}

function fsyncDirectory(directory, faultInjector, stage) {
  invokeFault(faultInjector, stage);
  const handle = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
}

function atomicJson(target, value, { faultInjector, prefix, directoryFsync = true } = {}) {
  const directory = path.dirname(target);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  let renamed = false;
  try {
    invokeFault(faultInjector, `${prefix}-temp-create`);
    const handle = fs.openSync(temporary, 'wx', 0o600);
    try {
      invokeFault(faultInjector, `${prefix}-write`);
      fs.writeFileSync(handle, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
      invokeFault(faultInjector, `${prefix}-file-fsync`);
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    invokeFault(faultInjector, `${prefix}-rename`);
    fs.renameSync(temporary, target);
    renamed = true;
    invokeFault(faultInjector, `${prefix}-swapped`);
    if (directoryFsync) fsyncDirectory(directory, faultInjector, `${prefix}-directory-fsync`);
  } finally {
    if (!renamed) {
      try {
        fs.unlinkSync(temporary);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
  }
}

function readJsonRegular(target, label) {
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label}_not_regular`);
  return JSON.parse(fs.readFileSync(target, 'utf8'));
}

function readRegularBytes(target, label) {
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label}_not_regular`);
  return fs.readFileSync(target);
}

function verifyPointer(pointer) {
  const expected = new Set(['schema_version', 'manifest_file', 'manifest_digest']);
  if (!pointer || typeof pointer !== 'object' || Array.isArray(pointer)) throw new Error('pointer_invalid');
  for (const key of Object.keys(pointer)) if (!expected.has(key)) throw new Error(`pointer_unknown_field:${key}`);
  for (const key of expected) if (!(key in pointer)) throw new Error(`pointer_missing_field:${key}`);
  if (pointer.schema_version !== POINTER_SCHEMA_VERSION) throw new Error('pointer_schema_invalid');
  if (!/^[0-9a-f]{64}\.json$/.test(pointer.manifest_file)) throw new Error('pointer_manifest_file_invalid');
  if (!SHA256_PATTERN.test(pointer.manifest_digest)) throw new Error('pointer_manifest_digest_invalid');
  return pointer;
}

function verifyManifest(manifest, identityVersion) {
  const expected = new Set([
    'schema_version', 'projection_revision', 'activity_revision',
    'high_water_activity_revision', 'source_digest', 'identity_digest',
    'revision_file', 'revision_digest',
  ]);
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('manifest_invalid');
  for (const key of Object.keys(manifest)) if (!expected.has(key)) throw new Error(`manifest_unknown_field:${key}`);
  for (const key of expected) if (!(key in manifest)) throw new Error(`manifest_missing_field:${key}`);
  if (manifest.schema_version !== MANIFEST_SCHEMA_VERSION) throw new Error('manifest_schema_invalid');
  if (manifest.identity_digest !== identityVersion) throw new Error('manifest_identity_mismatch');
  if (!SHA256_PATTERN.test(manifest.projection_revision)
      || !SHA256_PATTERN.test(manifest.source_digest)
      || !SHA256_PATTERN.test(manifest.revision_digest)) throw new Error('manifest_digest_invalid');
  if (!Number.isInteger(manifest.activity_revision) || manifest.activity_revision < 0
      || !Number.isInteger(manifest.high_water_activity_revision)
      || manifest.high_water_activity_revision < manifest.activity_revision) {
    throw new Error('manifest_high_water_invalid');
  }
  if (!/^[0-9a-f]{64}\.json$/.test(manifest.revision_file)) throw new Error('manifest_revision_file_invalid');
  return manifest;
}

function verifyPublicationState(state) {
  const expected = new Set([
    'schema_version', 'state', 'projection_revision',
    'high_water_activity_revision', 'high_water_projection_revision', 'reason',
  ]);
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error('publication_state_invalid');
  }
  for (const key of Object.keys(state)) {
    if (!expected.has(key)) throw new Error(`publication_state_unknown_field:${key}`);
  }
  if (state.schema_version !== PUBLICATION_STATE_SCHEMA_VERSION
      || !PUBLICATION_STATES.has(state.state)) {
    throw new Error('publication_state_schema_invalid');
  }
  if (!Number.isInteger(state.high_water_activity_revision)
      || state.high_water_activity_revision < 0) {
    throw new Error('publication_state_high_water_invalid');
  }
  if (state.high_water_projection_revision !== null
      && !SHA256_PATTERN.test(state.high_water_projection_revision || '')) {
    throw new Error('publication_state_projection_high_water_invalid');
  }
  if (state.high_water_activity_revision > 0 && state.high_water_projection_revision === null) {
    throw new Error('publication_state_projection_high_water_missing');
  }
  if (state.projection_revision !== undefined
      && !SHA256_PATTERN.test(state.projection_revision)) {
    throw new Error('publication_state_projection_invalid');
  }
  if (state.projection_revision !== undefined
      && state.projection_revision !== state.high_water_projection_revision) {
    throw new Error('publication_state_projection_high_water_mismatch');
  }
  if (state.state === 'published'
      && (state.projection_revision !== state.high_water_projection_revision
        || !SHA256_PATTERN.test(state.projection_revision || ''))) {
    throw new Error('publication_state_published_revision_invalid');
  }
  if (state.reason !== undefined && typeof state.reason !== 'string') {
    throw new Error('publication_state_reason_invalid');
  }
  return state;
}

function publicationStateRecord(
  state,
  highWaterActivityRevision,
  highWaterProjectionRevision,
  { projectionRevision, reason } = {},
) {
  const record = {
    schema_version: PUBLICATION_STATE_SCHEMA_VERSION,
    state,
    high_water_activity_revision: highWaterActivityRevision,
    high_water_projection_revision: highWaterProjectionRevision,
  };
  if (projectionRevision) record.projection_revision = projectionRevision;
  if (reason) record.reason = reason;
  return verifyPublicationState(record);
}

function projectionError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function readProjectionGraph(outputPath, identityVersion, minimumHighWater = 0) {
  const locations = pointerPaths(outputPath);
  const pointer = verifyPointer(readJsonRegular(locations.target, 'pointer'));
  const manifestPath = path.join(locations.manifests, pointer.manifest_file);
  const manifestBytes = readRegularBytes(manifestPath, 'manifest');
  if (sha256(manifestBytes) !== pointer.manifest_digest) throw new Error('manifest_digest_mismatch');
  const manifest = verifyManifest(JSON.parse(manifestBytes.toString('utf8')), identityVersion);
  if (manifest.high_water_activity_revision < minimumHighWater
      || manifest.activity_revision < minimumHighWater) throw new Error('projection_rollback_rejected');
  const revisionPath = path.join(locations.revisions, manifest.revision_file);
  const artifactBytes = readRegularBytes(revisionPath, 'revision');
  if (sha256(artifactBytes) !== manifest.revision_digest) throw new Error('revision_digest_mismatch');
  const snapshot = verifyPublishedProjection(JSON.parse(artifactBytes.toString('utf8')), identityVersion);
  if (snapshot.projection_revision !== manifest.projection_revision
      || snapshot.activity_revision !== manifest.activity_revision
      || manifest.high_water_activity_revision !== snapshot.activity_revision
      || snapshot.source_digest !== manifest.source_digest
      || snapshot.identity_digest !== manifest.identity_digest) {
    throw new Error('manifest_revision_cross_reference_mismatch');
  }
  return { pointer, manifest, snapshot };
}

export function loadPublishedProjection(outputPath, identityVersion) {
  const locations = pointerPaths(outputPath);
  const state = verifyPublicationState(readJsonRegular(locations.state, 'publication_state'));
  if (state?.state !== 'published') throw new Error(`projection_publication_${state?.state || 'unknown'}`);
  const graph = readProjectionGraph(outputPath, identityVersion, state.high_water_activity_revision);
  if (state.projection_revision !== graph.snapshot.projection_revision
      || state.high_water_projection_revision !== graph.snapshot.projection_revision
      || state.high_water_activity_revision !== graph.snapshot.activity_revision) {
    throw new Error('publication_state_projection_mismatch');
  }
  return graph.snapshot;
}

function verifyRuntimePath(target, expectedUid, expectedGid, expectedMode, kind) {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()
      || (kind === 'directory' ? !stat.isDirectory() : !stat.isFile())) {
    throw new Error(`projection_runtime_${kind}_invalid:${target}`);
  }
  if (stat.uid !== expectedUid || stat.gid !== expectedGid) {
    throw new Error(`projection_runtime_owner_invalid:${target}`);
  }
  if ((stat.mode & 0o777) !== expectedMode) {
    throw new Error(`projection_runtime_mode_invalid:${target}`);
  }
}

export function verifyPublishedProjectionRuntimeAccess({
  outputPath,
  projectRoot,
  expectedUid = process.getuid?.(),
  expectedGid = process.getgid?.(),
}) {
  if (!Number.isInteger(expectedUid) || expectedUid < 0
      || !Number.isInteger(expectedGid) || expectedGid < 0) {
    throw new Error('projection_runtime_identity_invalid');
  }
  const canonical = computeHermesIdentityVersion(projectRoot);
  const locations = pointerPaths(outputPath);
  const pointer = verifyPointer(readJsonRegular(locations.target, 'pointer'));
  const manifestPath = path.join(locations.manifests, pointer.manifest_file);
  const manifest = verifyManifest(
    readJsonRegular(manifestPath, 'manifest'),
    canonical.version,
  );
  const revisionPath = path.join(locations.revisions, manifest.revision_file);
  for (const directory of [locations.directory, locations.revisions, locations.manifests]) {
    verifyRuntimePath(directory, expectedUid, expectedGid, 0o700, 'directory');
  }
  for (const file of [locations.target, locations.state, manifestPath, revisionPath]) {
    verifyRuntimePath(file, expectedUid, expectedGid, 0o600, 'file');
  }
  return loadPublishedProjection(outputPath, canonical.version);
}

export function reconcilePublishedProjection({ outputPath, identityVersion, faultInjector }) {
  const locations = pointerPaths(outputPath);
  const previous = verifyPublicationState(readJsonRegular(locations.state, 'publication_state'));
  const previousHighWater = previous.high_water_activity_revision;
  const previousProjectionHighWater = previous.high_water_projection_revision;
  try {
    atomicJson(
      locations.state,
      publicationStateRecord('reconciling', previousHighWater, previousProjectionHighWater),
      { faultInjector, prefix: 'state-reconciling' },
    );
    const graph = readProjectionGraph(outputPath, identityVersion, previousHighWater);
    if (graph.snapshot.activity_revision === previousHighWater
        && previousProjectionHighWater
        && graph.snapshot.projection_revision !== previousProjectionHighWater) {
      throw new Error('projection_revision_conflict');
    }
    const highWater = Math.max(previousHighWater, graph.snapshot.activity_revision);
    const projectionHighWater = graph.snapshot.activity_revision > previousHighWater
      ? graph.snapshot.projection_revision
      : previousProjectionHighWater || graph.snapshot.projection_revision;
    fsyncDirectory(locations.directory, faultInjector, 'reconcile-pointer-directory-fsync');
    atomicJson(
      locations.state,
      publicationStateRecord('published', highWater, projectionHighWater, {
        projectionRevision: graph.snapshot.projection_revision,
      }),
      { faultInjector, prefix: 'state-published' },
    );
    return graph.snapshot;
  } catch (error) {
    try {
      atomicJson(
        locations.state,
        publicationStateRecord('ambiguous', previousHighWater, previousProjectionHighWater, {
          reason: String(error?.message || error),
        }),
        { prefix: 'state-ambiguous' },
      );
    } catch {
      // A non-published state still blocks consumers.
    }
    throw error;
  }
}

function readActivities(coreDbPath) {
  const databasePath = path.resolve(coreDbPath);
  const stat = fs.lstatSync(databasePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('core_database_invalid');
  const sourceDigest = sha256(fs.readFileSync(databasePath));
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return {
      sourceDigest,
      activities: db.prepare(`
        SELECT activity_id, title, domain, state, contract_revision, updated_at
        FROM activity
        WHERE state IN ('active', 'paused')
        ORDER BY activity_id
      `).all().map((row) => ({
        activity_id: String(row.activity_id),
        title: String(row.title),
        domain: String(row.domain),
        state: String(row.state),
        contract_revision: Number(row.contract_revision),
        updated_at: String(row.updated_at),
      })),
    };
  } finally {
    db.close();
  }
}

export function publishHermesIdentityProjection({
  projectRoot,
  coreDbPath,
  outputPath,
  faultInjector,
}) {
  const locations = pointerPaths(outputPath);
  fs.mkdirSync(locations.directory, { recursive: true, mode: 0o700 });
  fs.mkdirSync(locations.revisions, { recursive: true, mode: 0o700 });
  fs.mkdirSync(locations.manifests, { recursive: true, mode: 0o700 });
  let lockHandle;
  try {
    lockHandle = fs.openSync(locations.lock, 'wx', 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error('projection_publication_concurrent');
    throw error;
  }

  let pointerSwapped = false;
  let durableFloor = 0;
  let durableProjectionFloor = null;
  let failureStateAllowed = false;
  try {
    const canonical = computeHermesIdentityVersion(projectRoot);
    let durableState = null;
    if (fs.existsSync(locations.state)) {
      try {
        durableState = verifyPublicationState(readJsonRegular(locations.state, 'publication_state'));
      } catch (error) {
        throw projectionError(
          'PROJECTION_RECONCILIATION_REQUIRED',
          `publication_state_invalid:${error?.message || error}`,
        );
      }
      durableFloor = durableState.high_water_activity_revision;
      durableProjectionFloor = durableState.high_water_projection_revision;
    }

    let currentGraph = null;
    if (fs.existsSync(locations.target)) {
      try {
        currentGraph = readProjectionGraph(outputPath, canonical.version);
      } catch (error) {
        throw projectionError(
          'PROJECTION_RECONCILIATION_REQUIRED',
          `current_projection_graph_invalid:${error?.message || error}`,
        );
      }
    }

    if (!durableState && currentGraph) {
      throw projectionError(
        'PROJECTION_RECONCILIATION_REQUIRED',
        'publication_state_missing_for_current_projection',
      );
    }
    if (durableState && !currentGraph
        && (durableFloor > 0
          || durableProjectionFloor
          || ['published', 'ambiguous', 'reconciling'].includes(durableState.state))) {
      throw projectionError(
        'PROJECTION_RECONCILIATION_REQUIRED',
        'current_projection_missing_below_durable_floor',
      );
    }
    if (currentGraph) {
      if (currentGraph.snapshot.activity_revision < durableFloor) {
        throw projectionError(
          'PROJECTION_ROLLBACK_CONFLICT',
          'current_projection_below_durable_floor',
        );
      }
      if (currentGraph.snapshot.activity_revision === durableFloor
          && durableProjectionFloor
          && currentGraph.snapshot.projection_revision !== durableProjectionFloor) {
        throw projectionError(
          'PROJECTION_REVISION_CONFLICT',
          'current_projection_conflicts_with_durable_floor',
        );
      }
      if (currentGraph.snapshot.activity_revision > durableFloor) {
        durableFloor = currentGraph.snapshot.activity_revision;
        durableProjectionFloor = currentGraph.snapshot.projection_revision;
      } else if (!durableProjectionFloor) {
        durableProjectionFloor = currentGraph.snapshot.projection_revision;
      }
    }
    failureStateAllowed = true;

    const { sourceDigest, activities } = readActivities(coreDbPath);
    const activityRevision = activities.reduce(
      (revision, activity) => Math.max(revision, activity.contract_revision),
      0,
    );
    const publishedMemoryContext = activities.length
      ? activities.map((activity) => (
        `- ${activity.activity_id}: ${activity.title} [${activity.state}; ${activity.domain}; revision=${activity.contract_revision}]`
      )).join('\n')
      : '- No active or paused Core activities.';
    const snapshot = {
      schema_version: PROJECTION_SCHEMA_VERSION,
      identity_version: canonical.version,
      identity_digest: canonical.version,
      source_digest: sourceDigest,
      activity_revision: activityRevision,
      activities,
      published_memory_context: publishedMemoryContext,
    };
    snapshot.projection_revision = sha256(stableJson(projectionPayload(snapshot)));
    if (activityRevision < durableFloor) {
      failureStateAllowed = false;
      throw projectionError(
        'PROJECTION_ROLLBACK_CONFLICT',
        'source_activity_revision_below_durable_floor',
      );
    }
    if (activityRevision === durableFloor
        && durableProjectionFloor
        && snapshot.projection_revision !== durableProjectionFloor) {
      failureStateAllowed = false;
      throw projectionError(
        'PROJECTION_REVISION_CONFLICT',
        'source_digest_conflicts_with_durable_revision',
      );
    }
    if (currentGraph
        && currentGraph.snapshot.projection_revision === snapshot.projection_revision) {
      atomicJson(
        locations.state,
        publicationStateRecord('published', durableFloor, durableProjectionFloor, {
          projectionRevision: currentGraph.snapshot.projection_revision,
        }),
        { faultInjector, prefix: 'state-published' },
      );
      return loadPublishedProjection(outputPath, canonical.version);
    }

    atomicJson(
      locations.state,
      publicationStateRecord('building', durableFloor, durableProjectionFloor),
      { faultInjector, prefix: 'state-building' },
    );
    const artifactBytes = Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    const revisionFile = `${snapshot.projection_revision.slice('sha256:'.length)}.json`;
    const revisionPath = path.join(locations.revisions, revisionFile);
    if (!fs.existsSync(revisionPath)) {
      atomicJson(revisionPath, snapshot, { faultInjector, prefix: 'revision' });
    }
    const verifiedBytes = fs.readFileSync(revisionPath);
    const verifiedRevision = verifyPublishedProjection(
      JSON.parse(verifiedBytes.toString('utf8')),
      canonical.version,
    );
    if (!verifiedBytes.equals(artifactBytes)) throw new Error('immutable_revision_conflict');
    if (verifiedRevision.projection_revision !== snapshot.projection_revision
        || verifiedRevision.identity_digest !== snapshot.identity_digest
        || verifiedRevision.activity_revision !== snapshot.activity_revision) {
      throw new Error('revision_post_write_verification_failed');
    }

    const manifest = {
      schema_version: MANIFEST_SCHEMA_VERSION,
      projection_revision: snapshot.projection_revision,
      activity_revision: snapshot.activity_revision,
      high_water_activity_revision: snapshot.activity_revision,
      source_digest: snapshot.source_digest,
      identity_digest: snapshot.identity_digest,
      revision_file: revisionFile,
      revision_digest: sha256(verifiedBytes),
    };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    const manifestDigest = sha256(manifestBytes);
    const manifestFile = `${manifestDigest.slice('sha256:'.length)}.json`;
    const manifestPath = path.join(locations.manifests, manifestFile);
    if (!fs.existsSync(manifestPath)) {
      atomicJson(manifestPath, manifest, { faultInjector, prefix: 'manifest' });
    }
    const verifiedManifestBytes = fs.readFileSync(manifestPath);
    if (!verifiedManifestBytes.equals(manifestBytes)
        || sha256(verifiedManifestBytes) !== manifestDigest) {
      throw new Error('immutable_manifest_conflict');
    }
    const verifiedManifest = verifyManifest(
      JSON.parse(verifiedManifestBytes.toString('utf8')),
      canonical.version,
    );
    if (verifiedManifest.revision_digest !== sha256(verifiedBytes)
        || verifiedManifest.projection_revision !== verifiedRevision.projection_revision) {
      throw new Error('manifest_revision_cross_reference_mismatch');
    }

    const pointer = {
      schema_version: POINTER_SCHEMA_VERSION,
      manifest_file: manifestFile,
      manifest_digest: manifestDigest,
    };
    try {
      atomicJson(locations.target, pointer, {
        faultInjector: (stage) => {
          if (stage === 'pointer-swapped') pointerSwapped = true;
          invokeFault(faultInjector, stage);
        },
        prefix: 'pointer',
      });
      invokeFault(faultInjector, 'pointer-swap-process-interrupt');
      invokeFault(faultInjector, 'post-publication-verification');
      const graph = readProjectionGraph(outputPath, canonical.version, durableFloor);
      if (graph.pointer.manifest_file !== manifestFile
          || graph.manifest.projection_revision !== snapshot.projection_revision) {
        throw new Error('post_publication_verification_failed');
      }
      atomicJson(
        locations.state,
        publicationStateRecord('published', snapshot.activity_revision, snapshot.projection_revision, {
          projectionRevision: snapshot.projection_revision,
        }),
        { faultInjector, prefix: 'state-published' },
      );
      return loadPublishedProjection(outputPath, canonical.version);
    } catch (error) {
      if (!pointerSwapped) throw error;
      try {
        atomicJson(
          locations.state,
          publicationStateRecord('ambiguous', snapshot.activity_revision, snapshot.projection_revision, {
            projectionRevision: snapshot.projection_revision,
            reason: String(error?.message || error),
          }),
          { faultInjector, prefix: 'state-ambiguous' },
        );
      } catch {
        // building/published-but-unconfirmed also blocks consumers.
      }
      const ambiguous = new Error('projection-publication-ambiguous');
      ambiguous.code = 'PROJECTION_PUBLICATION_AMBIGUOUS';
      throw ambiguous;
    }
  } catch (error) {
    if (error?.code !== 'PROJECTION_PUBLICATION_AMBIGUOUS' && failureStateAllowed) {
      try {
        atomicJson(
          locations.state,
          publicationStateRecord('failed', durableFloor, durableProjectionFloor, {
            reason: String(error?.message || error),
          }),
          { faultInjector, prefix: 'state-failed' },
        );
      } catch {
        // The original publication failure remains authoritative.
      }
    }
    throw error;
  } finally {
    try {
      fs.closeSync(lockHandle);
    } finally {
      try {
        fs.unlinkSync(locations.lock);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === 'verify-runtime') {
      const [, , , outputPath, projectRoot = process.cwd(), uid, gid] = process.argv;
      if (!outputPath || !uid || !gid) {
        process.stderr.write(
          'usage: node hermesIdentityProjection.mjs verify-runtime CURRENT_POINTER PROJECT_ROOT UID GID\n',
        );
        process.exit(2);
      }
      const snapshot = verifyPublishedProjectionRuntimeAccess({
        outputPath,
        projectRoot,
        expectedUid: Number(uid),
        expectedGid: Number(gid),
      });
      process.stdout.write(`${JSON.stringify({
        state: 'verified',
        projection_revision: snapshot.projection_revision,
        activity_revision: snapshot.activity_revision,
      })}\n`);
      process.exit(0);
    }
    const [, , coreDbPath, outputPath, projectRoot = process.cwd()] = process.argv;
    if (!coreDbPath || !outputPath) {
      process.stderr.write('usage: node hermesIdentityProjection.mjs CORE_DB CURRENT_POINTER [PROJECT_ROOT]\n');
      process.exit(2);
    }
    const snapshot = publishHermesIdentityProjection({ projectRoot, coreDbPath, outputPath });
    process.stdout.write(`${JSON.stringify({
      state: 'published',
      projection_revision: snapshot.projection_revision,
      activity_revision: snapshot.activity_revision,
    })}\n`);
  } catch (error) {
    process.stderr.write(`${error?.code || 'PROJECTION_PUBLICATION_FAILED'}: ${error?.message || error}\n`);
    process.exit(error?.code === 'PROJECTION_PUBLICATION_AMBIGUOUS' ? 78 : 1);
  }
}
