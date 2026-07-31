// Ombre O2 stewarded-growth compatibility — projection revision refresh and
// Lite/Full verified common-revision reads (contract §5.6, §7.1, §13.5).
//
// A succeeded projection receipt never lets Lite/Full read a mutating target
// directory. Instead the refresher takes a pure-read snapshot of the target
// state and publishes it as an immutable, content-addressed graph:
//
//   projectionDir/
//     pointer.json              -> { manifest_file, manifest_digest, updated_at }
//     last_verified.json        -> last verified common revision (fallback only)
//     revisions/<digest>.json   -> immutable digest/ref snapshot (compat-projection/v1)
//     manifests/<digest>.json   -> immutable manifest (§5.6 field set)
//
// Readers verify pointer -> manifest -> revision level by level (digest chain,
// cross references, adapter/upstream pins). Lite and Full share this exact
// read path; `mode` is an audit label only and never changes the outcome, so
// neither side may advance while the other silently reads an old revision:
// on any verification failure both fall back to the same last verified common
// revision, or both fail-soft omit Ombre (§5.6, §13.5).

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { writeJsonAtomic } from '../atomicState.mjs';
import { canonicalDigest, derivedId, isSha256Digest } from './canonical.mjs';
import { COMPAT_UPSTREAM_VERSION } from './constants.mjs';

const SNAPSHOT_SCHEMA_VERSION = 'compat-projection/v1';
const MANIFEST_SCHEMA_VERSION = 'compat-projection-manifest/v1';
const POINTER_SCHEMA_VERSION = 'compat-projection-pointer/v1';
const VERIFIED_SCHEMA_VERSION = 'compat-projection-verified/v1';
const HEX_FILE_PATTERN = /^[0-9a-f]{64}\.json$/;
const ITEM_FIELDS = Object.freeze([
  'item_ref', 'item_digest', 'source_operation_key', 'layer',
  'payload_ref', 'payload_digest', 'target_ref', 'revision',
  'lifecycle_state', 'tombstone_metadata',
]);
const TOMBSTONE_FIELDS = Object.freeze([
  'tombstone_ref', 'tombstone_state', 'deletion_ref', 'deletion_domain',
]);

// Fields every manifest must carry (§5.6) plus the immutable-graph bindings.
const MANIFEST_CROSS_REFERENCE_FIELDS = Object.freeze([
  'projection_revision',
  'content_digest',
  'source_cursor',
  'last_projection_receipt_id',
  'adapter_policy_digest',
  'upstream_version',
  'created_at',
]);

function sha256FileDigest(buffer) {
  return `sha256:${createHash('sha256').update(buffer).digest('hex')}`;
}

function serializeJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function digestFileName(digest) {
  return `${digest.slice('sha256:'.length)}.json`;
}

function graphPaths(projectionDir) {
  const root = path.resolve(String(projectionDir));
  return {
    root,
    pointer: path.join(root, 'pointer.json'),
    lastVerified: path.join(root, 'last_verified.json'),
    revisions: path.join(root, 'revisions'),
    manifests: path.join(root, 'manifests'),
  };
}

function snapshotPayload(snapshot) {
  return {
    schema_version: snapshot.schema_version,
    content_digest: snapshot.content_digest,
    source_cursor: snapshot.source_cursor,
    last_projection_receipt_id: snapshot.last_projection_receipt_id,
    adapter_policy_digest: snapshot.adapter_policy_digest,
    upstream_version: snapshot.upstream_version,
    created_at: snapshot.created_at,
    items: snapshot.items,
  };
}

function assertItemShape(item, label) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`${label}_invalid`);
  if (JSON.stringify(Object.keys(item).sort()) !== JSON.stringify([...ITEM_FIELDS].sort())) {
    throw new Error(`${label}_fields_invalid`);
  }
  if (typeof item.item_ref !== 'string' || !item.item_ref) throw new Error(`${label}_item_ref_invalid`);
  if (!isSha256Digest(item.item_digest)) throw new Error(`${label}_item_digest_invalid`);
  if (typeof item.source_operation_key !== 'string' || !item.source_operation_key) {
    throw new Error(`${label}_source_operation_key_invalid`);
  }
  if (typeof item.layer !== 'string' || !item.layer) throw new Error(`${label}_layer_invalid`);
  if (item.payload_ref !== null && (typeof item.payload_ref !== 'string' || !item.payload_ref)) {
    throw new Error(`${label}_payload_ref_invalid`);
  }
  if (!isSha256Digest(item.payload_digest)) throw new Error(`${label}_payload_digest_invalid`);
  if (typeof item.target_ref !== 'string' || !item.target_ref) throw new Error(`${label}_target_ref_invalid`);
  if (!Number.isInteger(item.revision) || item.revision < 0) throw new Error(`${label}_revision_invalid`);
  if (typeof item.lifecycle_state !== 'string' || !item.lifecycle_state) throw new Error(`${label}_lifecycle_invalid`);
  if (item.tombstone_metadata !== null
    && (!item.tombstone_metadata || typeof item.tombstone_metadata !== 'object' || Array.isArray(item.tombstone_metadata))) {
    throw new Error(`${label}_tombstone_invalid`);
  }
  if (item.tombstone_metadata !== null
    && JSON.stringify(Object.keys(item.tombstone_metadata).sort()) !== JSON.stringify([...TOMBSTONE_FIELDS].sort())) {
    throw new Error(`${label}_tombstone_fields_invalid`);
  }
}

// Pure-read resolver output (§7.1): normalized to a canonical item ordering so
// the projection revision is a pure function of target content.
function normalizeItems(rawItems) {
  if (!Array.isArray(rawItems)) throw new Error('resolver_output_invalid:items_not_array');
  const items = rawItems.map((item, index) => {
    const normalized = {
      item_ref: item.item_ref,
      item_digest: item.item_digest,
      source_operation_key: item.source_operation_key,
      layer: item.layer,
      payload_ref: Object.hasOwn(item, 'payload_ref') ? item.payload_ref : item.item_ref,
      payload_digest: item.payload_digest ?? item.item_digest,
      target_ref: item.target_ref ?? item.item_ref,
      revision: item.revision ?? 0,
      lifecycle_state: item.lifecycle_state ?? 'current',
      tombstone_metadata: item.tombstone_metadata ?? null,
    };
    assertItemShape(normalized, `resolver_output_invalid:item_${index}`);
    return normalized;
  });
  items.sort((a, b) => (a.item_ref < b.item_ref ? -1 : a.item_ref > b.item_ref ? 1 : 0));
  for (let index = 1; index < items.length; index += 1) {
    if (items[index].item_ref === items[index - 1].item_ref) {
      throw new Error(`resolver_output_invalid:duplicate_item_ref:${items[index].item_ref}`);
    }
  }
  return items;
}

function verifyItems(items) {
  if (!Array.isArray(items)) throw new Error('snapshot_items_invalid');
  for (let index = 0; index < items.length; index += 1) {
    assertItemShape(items[index], 'snapshot_item');
    if (index > 0 && items[index - 1].item_ref >= items[index].item_ref) {
      throw new Error('snapshot_items_not_sorted');
    }
  }
  return items;
}

function verifySnapshotShape(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new Error('snapshot_invalid');
  if (snapshot.schema_version !== SNAPSHOT_SCHEMA_VERSION) throw new Error('snapshot_schema_invalid');
  if (!isSha256Digest(snapshot.projection_revision)) throw new Error('snapshot_projection_revision_invalid');
  if (!isSha256Digest(snapshot.content_digest)) throw new Error('snapshot_content_digest_invalid');
  if (typeof snapshot.source_cursor !== 'string' || !snapshot.source_cursor) {
    throw new Error('snapshot_source_cursor_invalid');
  }
  if (typeof snapshot.last_projection_receipt_id !== 'string' || !snapshot.last_projection_receipt_id) {
    throw new Error('snapshot_receipt_invalid');
  }
  if (!isSha256Digest(snapshot.adapter_policy_digest)) throw new Error('snapshot_adapter_policy_digest_invalid');
  if (typeof snapshot.upstream_version !== 'string' || !snapshot.upstream_version) {
    throw new Error('snapshot_upstream_version_invalid');
  }
  if (typeof snapshot.created_at !== 'string' || !snapshot.created_at) throw new Error('snapshot_created_at_invalid');
  verifyItems(snapshot.items);
  if (canonicalDigest(snapshot.items) !== snapshot.content_digest) {
    throw new Error('snapshot_content_digest_mismatch');
  }
  if (canonicalDigest(snapshotPayload(snapshot)) !== snapshot.projection_revision) {
    throw new Error('snapshot_projection_revision_mismatch');
  }
  return snapshot;
}

function verifyManifestShape(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('manifest_invalid');
  if (manifest.schema_version !== MANIFEST_SCHEMA_VERSION) throw new Error('manifest_schema_invalid');
  if (!isSha256Digest(manifest.projection_revision)) throw new Error('manifest_projection_revision_invalid');
  if (manifest.revision_file !== digestFileName(manifest.projection_revision)) {
    throw new Error('manifest_revision_file_invalid');
  }
  if (!isSha256Digest(manifest.revision_digest)) throw new Error('manifest_revision_digest_invalid');
  if (!isSha256Digest(manifest.content_digest)) throw new Error('manifest_content_digest_invalid');
  if (typeof manifest.source_cursor !== 'string' || !manifest.source_cursor) {
    throw new Error('manifest_source_cursor_invalid');
  }
  if (typeof manifest.last_projection_receipt_id !== 'string' || !manifest.last_projection_receipt_id) {
    throw new Error('manifest_receipt_invalid');
  }
  if (!isSha256Digest(manifest.adapter_policy_digest)) throw new Error('manifest_adapter_policy_digest_invalid');
  if (typeof manifest.upstream_version !== 'string' || !manifest.upstream_version) {
    throw new Error('manifest_upstream_version_invalid');
  }
  if (typeof manifest.created_at !== 'string' || !manifest.created_at) throw new Error('manifest_created_at_invalid');
  return manifest;
}

function verifyPointerShape(pointer) {
  if (!pointer || typeof pointer !== 'object' || Array.isArray(pointer)) throw new Error('pointer_invalid');
  if (pointer.schema_version !== POINTER_SCHEMA_VERSION) throw new Error('pointer_schema_invalid');
  if (!HEX_FILE_PATTERN.test(pointer.manifest_file || '')) throw new Error('pointer_manifest_file_invalid');
  if (!isSha256Digest(pointer.manifest_digest)) throw new Error('pointer_manifest_digest_invalid');
  if (typeof pointer.updated_at !== 'string' || !pointer.updated_at) throw new Error('pointer_updated_at_invalid');
  return pointer;
}

function verifyVerifiedShape(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('last_verified_invalid');
  if (record.schema_version !== VERIFIED_SCHEMA_VERSION) throw new Error('last_verified_schema_invalid');
  if (!isSha256Digest(record.projection_revision)) throw new Error('last_verified_revision_invalid');
  if (!HEX_FILE_PATTERN.test(record.manifest_file || '')) throw new Error('last_verified_manifest_file_invalid');
  if (!isSha256Digest(record.manifest_digest)) throw new Error('last_verified_manifest_digest_invalid');
  if (typeof record.verified_at !== 'string' || !record.verified_at) throw new Error('last_verified_verified_at_invalid');
  return record;
}

function readRegularBytes(target, label) {
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label}_not_regular`);
  return fs.readFileSync(target);
}

function parseJsonBytes(bytes, label) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error(`${label}_json_invalid`);
  }
}

// Shared verification core for both the pointer path (current revision) and
// the last_verified path (fallback common revision). Throws on any failure;
// callers convert to { status: 'invalid' } / omit as appropriate.
function verifyGraph(paths, { manifestFile, manifestDigest, expectedProjectionRevision, pins }) {
  const manifestBytes = readRegularBytes(path.join(paths.manifests, manifestFile), 'manifest');
  if (sha256FileDigest(manifestBytes) !== manifestDigest) throw new Error('manifest_digest_mismatch');
  const manifest = verifyManifestShape(parseJsonBytes(manifestBytes, 'manifest'));
  if (expectedProjectionRevision !== undefined && manifest.projection_revision !== expectedProjectionRevision) {
    throw new Error('verified_revision_mismatch');
  }
  const revisionBytes = readRegularBytes(path.join(paths.revisions, manifest.revision_file), 'revision');
  if (sha256FileDigest(revisionBytes) !== manifest.revision_digest) throw new Error('revision_digest_mismatch');
  const snapshot = verifySnapshotShape(parseJsonBytes(revisionBytes, 'revision'));
  for (const field of MANIFEST_CROSS_REFERENCE_FIELDS) {
    if (snapshot[field] !== manifest[field]) throw new Error('manifest_revision_cross_reference_mismatch');
  }
  if (pins?.expectedAdapterPolicyDigest !== undefined
      && manifest.adapter_policy_digest !== pins.expectedAdapterPolicyDigest) {
    throw new Error('adapter_policy_pin_mismatch');
  }
  if (pins?.expectedUpstreamVersion !== undefined
      && manifest.upstream_version !== pins.expectedUpstreamVersion) {
    throw new Error('upstream_version_pin_mismatch');
  }
  return {
    status: 'ok',
    projection_revision: manifest.projection_revision,
    snapshot,
    manifest,
    manifest_file: manifestFile,
    manifest_digest: manifestDigest,
  };
}

// Immutable, content-addressed write: an existing file must already hold the
// exact expected bytes; a new file is written atomically (wx temp + fsync +
// rename + directory fsync via writeJsonAtomic) and read back for a byte
// comparison. Any disagreement fails loud.
function writeImmutableJson(directory, fileName, value, label) {
  const target = path.join(directory, fileName);
  const expectedBytes = Buffer.from(serializeJson(value), 'utf8');
  if (fs.existsSync(target)) {
    const existing = readRegularBytes(target, label);
    if (!existing.equals(expectedBytes)) throw new Error(`immutable_${label}_conflict`);
    return expectedBytes;
  }
  writeJsonAtomic(target, value);
  const written = readRegularBytes(target, label);
  if (!written.equals(expectedBytes)) throw new Error(`${label}_readback_mismatch`);
  return written;
}

function resolveClock(clock) {
  return () => {
    const value = clock();
    const date = value instanceof Date ? value : new Date(value);
    return date.toISOString();
  };
}

export function createProjectionRefresher({
  projectionDir,
  store,
  resolver,
  clock = () => new Date(),
  faultInjector,
} = {}) {
  if (!store || typeof store.setRefreshState !== 'function' || typeof store.recordSnapshot !== 'function') {
    throw new Error('projection_refresher_store_invalid');
  }
  if (typeof resolver !== 'function') throw new Error('projection_refresher_resolver_invalid');
  const paths = graphPaths(projectionDir);
  const now = resolveClock(clock);
  const invokeFault = (stage) => {
    if (typeof faultInjector === 'function') faultInjector(stage);
  };

  // §5.6 fixed flow: building -> pure read -> immutable snapshot -> revision +
  // content digest + source cursor -> atomic publish -> Lite/Full share one
  // verified revision. Any resolver or durable-write failure records
  // revision_refresh_state=failed and returns instead of throwing, so the
  // caller's queue journey is never broken by the refresh lane.
  function refresh({ queue_item_id, reason, last_projection_receipt_id, source_cursor } = {}) {
    try {
      if (typeof queue_item_id !== 'string' || !queue_item_id) {
        throw new Error('refresh_binding_invalid:queue_item_id');
      }
      if (typeof reason !== 'string' || !reason) throw new Error('refresh_binding_invalid:reason');
      if (typeof last_projection_receipt_id !== 'string' || !last_projection_receipt_id) {
        throw new Error('refresh_binding_invalid:last_projection_receipt_id');
      }
      if (typeof source_cursor !== 'string' || !source_cursor) {
        throw new Error('refresh_binding_invalid:source_cursor');
      }
      store.setRefreshState({ queue_item_id, revision_refresh_state: 'building' });

      // Pure read (§7.1): no touch, no decay, no anchor, no pulse/grow, no
      // upstream mutation, no read-time queue write. The resolver only reads
      // the pinned target state; the only store effects of this whole lane
      // are refresh_state and snapshot_recorded events.
      const resolved = resolver({ queue_item_id, reason, last_projection_receipt_id, source_cursor });
      const items = normalizeItems(resolved?.items);
      const adapterPolicyDigest = store.adapterPolicyDigest;
      if (!isSha256Digest(adapterPolicyDigest)) throw new Error('adapter_policy_digest_unavailable');

      const content_digest = canonicalDigest(items);
      const snapshot = {
        schema_version: SNAPSHOT_SCHEMA_VERSION,
        content_digest,
        source_cursor,
        last_projection_receipt_id,
        adapter_policy_digest: adapterPolicyDigest,
        upstream_version: COMPAT_UPSTREAM_VERSION,
        created_at: now(),
        items,
      };
      snapshot.projection_revision = canonicalDigest(snapshotPayload(snapshot));

      const revisionFile = digestFileName(snapshot.projection_revision);
      const revisionBytes = writeImmutableJson(paths.revisions, revisionFile, snapshot, 'revision');
      const manifest = {
        schema_version: MANIFEST_SCHEMA_VERSION,
        projection_revision: snapshot.projection_revision,
        revision_file: revisionFile,
        revision_digest: sha256FileDigest(revisionBytes),
        content_digest,
        source_cursor,
        last_projection_receipt_id,
        adapter_policy_digest: adapterPolicyDigest,
        upstream_version: COMPAT_UPSTREAM_VERSION,
        created_at: snapshot.created_at,
      };
      const manifestDigest = sha256FileDigest(Buffer.from(serializeJson(manifest), 'utf8'));
      const manifestFile = digestFileName(manifestDigest);
      writeImmutableJson(paths.manifests, manifestFile, manifest, 'manifest');

      invokeFault('before_pointer_swap');
      writeJsonAtomic(paths.pointer, {
        schema_version: POINTER_SCHEMA_VERSION,
        manifest_file: manifestFile,
        manifest_digest: manifestDigest,
        updated_at: now(),
      });
      invokeFault('after_pointer_swap');

      // Post-publication verification: the graph must read back as verified
      // and land on the revision we just built.
      const verified = readVerifiedProjection({ projectionDir: paths.root });
      if (verified.status !== 'ok' || verified.projection_revision !== snapshot.projection_revision) {
        throw new Error(`post_publish_verification_failed:${verified.reason || 'projection_revision_mismatch'}`);
      }

      store.recordSnapshot({
        snapshot_id: derivedId('ocq_snap', {
          queue_item_id,
          projection_revision: snapshot.projection_revision,
        }),
        queue_item_id,
        reason,
        projection_revision: snapshot.projection_revision,
        content_digest,
        source_cursor,
        last_projection_receipt_id,
        adapter_policy_digest: adapterPolicyDigest,
        upstream_version: COMPAT_UPSTREAM_VERSION,
        item_count: items.length,
        revision_file: revisionFile,
        manifest_file: manifestFile,
        manifest_digest: manifestDigest,
        created_at: snapshot.created_at,
      });
      store.setRefreshState({
        queue_item_id,
        revision_refresh_state: 'published',
        projection_revision: snapshot.projection_revision,
      });
      return {
        status: 'published',
        projection_revision: snapshot.projection_revision,
        content_digest,
        snapshot,
      };
    } catch (error) {
      try {
        store.setRefreshState({ queue_item_id, revision_refresh_state: 'failed' });
      } catch {
        // The refresh failure stays authoritative even when the failure state
        // itself cannot be appended (e.g. store already closed).
      }
      return { status: 'failed', reason: String(error?.message || error) };
    }
  }

  return { refresh, projectionDir: paths.root };
}

// Verified read of the current pointer-selected revision. Never throws: any
// broken link in pointer -> manifest -> revision, any digest or
// cross-reference mismatch, and any adapter/upstream pin drift yields
// { status: 'invalid', reason }.
export function readVerifiedProjection({
  projectionDir,
  expectedAdapterPolicyDigest,
  expectedUpstreamVersion,
} = {}) {
  const paths = graphPaths(projectionDir);
  try {
    const pointer = verifyPointerShape(parseJsonBytes(readRegularBytes(paths.pointer, 'pointer'), 'pointer'));
    return verifyGraph(paths, {
      manifestFile: pointer.manifest_file,
      manifestDigest: pointer.manifest_digest,
      pins: { expectedAdapterPolicyDigest, expectedUpstreamVersion },
    });
  } catch (error) {
    return { status: 'invalid', reason: String(error?.message || error) };
  }
}

function readLastVerified(paths) {
  let bytes;
  try {
    bytes = readRegularBytes(paths.lastVerified, 'last_verified');
  } catch {
    return null;
  }
  try {
    return verifyVerifiedShape(parseJsonBytes(bytes, 'last_verified'));
  } catch {
    return null;
  }
}

function recordLastVerified(paths, graph, verifiedAt) {
  // Derived fallback bookkeeping: a verified in-hand snapshot is never
  // withheld because this bookkeeping write failed — the content-addressed
  // graph on disk remains the authority.
  try {
    writeJsonAtomic(paths.lastVerified, {
      schema_version: VERIFIED_SCHEMA_VERSION,
      projection_revision: graph.projection_revision,
      manifest_file: graph.manifest_file,
      manifest_digest: graph.manifest_digest,
      verified_at: verifiedAt,
    });
  } catch {
    // best effort only
  }
}

// The single Lite/Full read path (§5.6, §7.1). `mode` is an audit label only:
// both modes verify the same current revision, both fall back to the same
// last verified common revision, or both omit. The result never carries any
// per-mode difference, so one side can never advance while the other silently
// reads an old revision.
export function readForMode({
  projectionDir,
  mode,
  expectedAdapterPolicyDigest,
  expectedUpstreamVersion,
  clock = () => new Date(),
} = {}) {
  const paths = graphPaths(projectionDir);
  const pins = { expectedAdapterPolicyDigest, expectedUpstreamVersion };
  const auditMode = typeof mode === 'string' && mode ? mode : 'unknown';
  const now = resolveClock(clock);

  const current = readVerifiedProjection({ projectionDir: paths.root, ...pins });
  if (current.status === 'ok') {
    recordLastVerified(paths, current, now());
    return {
      status: 'ok',
      mode: auditMode,
      projection_revision: current.projection_revision,
      snapshot: current.snapshot,
    };
  }

  const lastVerified = readLastVerified(paths);
  if (lastVerified) {
    try {
      const fallback = verifyGraph(paths, {
        manifestFile: lastVerified.manifest_file,
        manifestDigest: lastVerified.manifest_digest,
        expectedProjectionRevision: lastVerified.projection_revision,
        pins,
      });
      recordLastVerified(paths, fallback, now());
      return {
        status: 'fallback',
        mode: auditMode,
        projection_revision: fallback.projection_revision,
        snapshot: fallback.snapshot,
        reason: current.reason,
      };
    } catch {
      // The last verified reference no longer verifies: fall through to omit.
    }
  }
  return { status: 'omit', mode: auditMode, reason: current.reason };
}
