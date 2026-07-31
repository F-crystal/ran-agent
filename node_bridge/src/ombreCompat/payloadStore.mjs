import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { canonicalDigest, newId } from './canonical.mjs';
import { COMPAT_DELETION_DOMAINS, compatError } from './constants.mjs';

const REGISTRY_ID = 'ombre-compat-payload-registry/1';
const EPOCH_SCHEMA = 'compat.registry-writer-epoch-acquired/v1';
const RECOVERY_SCHEMA = 'compat.registry-torn-tail-recovered/v1';
const EVENT_SCHEMA = 'compat-payload-registry-event/1';

export function createCompatPayloadStore({ dir, clock = () => new Date() }) {
  const root = path.resolve(String(dir));
  const stateRoot = path.dirname(root);
  const indexDir = path.join(stateRoot, 'payload-index');
  const quarantineDir = path.join(indexDir, 'quarantine');
  const lockDir = path.join(stateRoot, 'locks');
  const journalPath = path.join(indexDir, 'registry.journal.jsonl');
  const lockPath = path.join(lockDir, 'writer.lock');
  for (const target of [root, indexDir, quarantineDir, lockDir]) fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  const writer_instance_id = `ocq_writer_${randomBytes(12).toString('hex')}`;
  let lockFd = acquireLock(writer_instance_id);
  let closed = false;
  let state;
  try {
    state = replayJournal({ recoverTail: true });
    const writer_epoch = state.writer_epoch + 1;
    appendEpoch({
      previous_epoch: state.writer_epoch,
      writer_epoch,
      writer_instance_id,
      previous_event_digest: state.last_digest,
    });
    state.writer_epoch = writer_epoch;
    state.writer_instance_id = writer_instance_id;
    if (state.tornTail) {
      appendRecovery(state.tornTail);
      state.tornTail = null;
    }
    state = replayJournal({ recoverTail: false });
    runJanitor();
  } catch (error) {
    close();
    throw error;
  }

  function ensureCurrentWriter() {
    if (closed || !Number.isInteger(lockFd)) {
      throw compatError('COMPAT_REGISTRY_WRITER_EPOCH_CONFLICT', 'payload registry writer is closed');
    }
    const durable = replayJournal({ recoverTail: false });
    if (durable.writer_epoch !== state.writer_epoch
      || durable.writer_instance_id !== writer_instance_id) {
      throw compatError('COMPAT_REGISTRY_WRITER_EPOCH_CONFLICT', 'payload registry writer epoch is stale');
    }
    state = durable;
  }

  function put({
    kind,
    body,
    deletion_domain,
    created_at,
    owner_item = 'unbound-owner',
    source_ref = null,
    artifact_kind = 'canonical',
  }) {
    ensureCurrentWriter();
    if (!COMPAT_DELETION_DOMAINS.includes(deletion_domain)) {
      throw compatError('COMPAT_INGRESS_INVALID', `unknown deletion domain ${deletion_domain}`);
    }
    const payload_id = newId('ocq_payload');
    const document = {
      schema_version: 'compat-payload/v1',
      payload_id,
      kind,
      body: String(body ?? ''),
      created_at: toIso(created_at || clock()),
    };
    const digest = canonicalDigest(document);
    const ref = `compat-payload:${createHash('sha256').update(`${payload_id}\0${digest}`).digest('hex')}`;
    const target = payloadPath(ref, deletion_domain);
    const temporaryToken = randomBytes(8).toString('hex');
    const temporaryRef = `compat-artifact://temp/${deletion_domain}/${payload_id}/${temporaryToken}`;
    const temporary = path.join(root, deletion_domain, `.tmp.${payload_id}.${temporaryToken}`);
    appendRegistry({
      event_type: 'artifact_registered',
      payload_ref: ref,
      payload_digest: digest,
      owner_item,
      source_ref,
      artifact_kind: 'temp',
      artifact_ref: temporaryRef,
      resolved_path_digest: pathDigest(temporary),
      byte_length: Buffer.byteLength(JSON.stringify(document)),
      lifecycle_revision: 0,
      state: 'registered',
      occurred_at: toIso(created_at || clock()),
    });
    safeWrite(temporary, `${JSON.stringify(document)}\n`);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    osReplace(temporary, target);
    appendRegistry({
      event_type: 'payload_active',
      payload_ref: ref,
      payload_digest: digest,
      owner_item,
      source_ref,
      artifact_kind,
      artifact_ref: artifactRef(ref, deletion_domain),
      resolved_path_digest: pathDigest(target),
      byte_length: fs.statSync(target).size,
      lifecycle_revision: 0,
      state: 'active',
      occurred_at: toIso(created_at || clock()),
    });
    appendRegistry({
      event_type: 'artifact_invalidated',
      payload_ref: ref,
      payload_digest: digest,
      owner_item,
      source_ref,
      artifact_kind: 'temp',
      artifact_ref: temporaryRef,
      resolved_path_digest: pathDigest(temporary),
      byte_length: 0,
      lifecycle_revision: 0,
      state: 'invalidated',
      occurred_at: toIso(created_at || clock()),
    });
    return { ref, digest, payload_id };
  }

  function get(ref) {
    const record = activeRecord(ref);
    if (!record) throw compatError('COMPAT_PAYLOAD_ERASED', `payload ${ref} is erased or unknown`);
    const target = resolveArtifact(record);
    let document;
    try {
      document = JSON.parse(fs.readFileSync(target, 'utf8'));
    } catch (cause) {
      if (cause?.code === 'ENOENT') throw compatError('COMPAT_PAYLOAD_ERASED', `payload ${ref} is erased or unknown`);
      throw compatError('COMPAT_STORE_CORRUPT', `payload ${ref} is invalid`, cause);
    }
    if (canonicalDigest(document) !== record.payload_digest) {
      throw compatError('COMPAT_STORE_CORRUPT', `payload ${ref} digest mismatch`);
    }
    return Object.freeze(document);
  }

  function has(ref) {
    try {
      get(ref);
      return true;
    } catch {
      return false;
    }
  }

  function erase(ref, { lifecycle_revision = 0 } = {}) {
    ensureCurrentWriter();
    const record = activeRecord(ref);
    if (!record) return false;
    const target = resolveArtifact(record);
    safeUnlink(target, record);
    appendRegistry({
      ...metadata(record),
      event_type: 'payload_invalidated',
      byte_length: 0,
      lifecycle_revision,
      state: 'invalidated',
      occurred_at: toIso(clock()),
    });
    return true;
  }

  function compatibilityDelete({ owner_item, lifecycle_revision = 0 }) {
    ensureCurrentWriter();
    const records = [...state.records.values()]
      .filter((record) => record.owner_item === owner_item && record.state === 'active');
    for (const record of records) erase(record.payload_ref, { lifecycle_revision });
    const artifacts = [...state.artifacts.values()]
      .filter((record) => record.owner_item === owner_item
        && record.state === 'registered'
        && record.artifact_kind !== 'canonical');
    for (const record of artifacts) {
      const target = resolveTemporaryArtifact(record);
      safeTemporaryUnlink(target, record);
      appendRegistry({
        ...metadata(record),
        event_type: 'artifact_invalidated',
        byte_length: 0,
        lifecycle_revision,
        state: 'invalidated',
        occurred_at: toIso(clock()),
      });
    }
    const remaining = [...replayJournal({ recoverTail: false }).records.values()]
      .filter((record) => record.owner_item === owner_item && record.state === 'active');
    if (remaining.length) throw compatError('COMPAT_STORE_CORRUPT', 'compatibility delete inventory incomplete');
    return Object.freeze({
      state: 'compatibility_deleted',
      owner_item,
      deleted_refs: records.map((record) => record.payload_ref),
      invalidated_artifact_refs: artifacts.map((record) => record.artifact_ref),
      registry_digest: replayJournal({ recoverTail: false }).last_digest,
    });
  }

  function list() {
    return [...state.records.values()].filter((record) => record.state === 'active').map((record) => record.payload_ref);
  }

  function runJanitor() {
    ensureCurrentWriter();
    const stale = [...state.artifacts.values()].filter((record) => record.state === 'registered'
      && record.artifact_kind !== 'canonical'
      && record.writer_epoch < state.writer_epoch);
    for (const record of stale) {
      safeTemporaryUnlink(resolveTemporaryArtifact(record), record);
      appendRegistry({
        ...metadata(record),
        event_type: 'artifact_invalidated',
        byte_length: 0,
        lifecycle_revision: record.lifecycle_revision,
        state: 'invalidated',
        occurred_at: toIso(clock()),
      });
    }
    return Object.freeze({
      writer_epoch: state.writer_epoch,
      recovered_artifact_refs: stale.map((record) => record.artifact_ref),
    });
  }

  function close() {
    if (closed) return;
    closed = true;
    if (Number.isInteger(lockFd)) {
      try { fs.closeSync(lockFd); } catch {}
      lockFd = undefined;
    }
    try { fs.unlinkSync(lockPath); } catch {}
  }

  function activeRecord(ref) {
    validateRef(ref);
    state = replayJournal({ recoverTail: false });
    const record = state.records.get(ref);
    return record?.state === 'active' ? record : null;
  }

  function appendRegistry(body) {
    ensureEpochBody(body);
    appendEvent({
      schema_version: EVENT_SCHEMA,
      event_id: `ocq_registry_event_${randomBytes(12).toString('hex')}`,
      ...body,
      writer_epoch: state.writer_epoch,
      previous_event_digest: state.last_digest,
    });
  }

  function appendEpoch(body) {
    appendEvent({
      schema_version: EPOCH_SCHEMA,
      event_id: `ocq_registry_epoch_${randomBytes(12).toString('hex')}`,
      registry_id: REGISTRY_ID,
      ...body,
      acquired_at: toIso(clock()),
    });
  }

  function appendRecovery(tail) {
    appendEvent({
      schema_version: RECOVERY_SCHEMA,
      event_id: `ocq_registry_recovery_${randomBytes(12).toString('hex')}`,
      registry_id: REGISTRY_ID,
      fragment_digest: tail.fragment_digest,
      original_length: tail.original_length,
      truncated_length: tail.truncated_length,
      writer_epoch: state.writer_epoch,
      writer_instance_id,
      recovered_at: toIso(clock()),
      previous_event_digest: state.last_digest,
    });
  }

  function appendEvent(material) {
    const event = { ...material, event_digest: canonicalDigest(material) };
    const descriptor = fs.openSync(journalPath, 'a', 0o600);
    try {
      fs.writeSync(descriptor, `${JSON.stringify(event)}\n`);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fsyncDirectory(indexDir);
    state.last_digest = event.event_digest;
    if (event.schema_version === EPOCH_SCHEMA) {
      state.writer_epoch = event.writer_epoch;
      state.writer_instance_id = event.writer_instance_id;
    } else if (event.schema_version === EVENT_SCHEMA
      && ['payload_active', 'payload_invalidated'].includes(event.event_type)) {
      state.records.set(event.payload_ref, event);
    }
    if (event.schema_version === EVENT_SCHEMA) state.artifacts.set(event.artifact_ref, event);
  }

  function replayJournal({ recoverTail }) {
    if (!fs.existsSync(journalPath)) {
      return {
        writer_epoch: 0,
        writer_instance_id: null,
        last_digest: null,
        records: new Map(),
        artifacts: new Map(),
        tornTail: null,
      };
    }
    const bytes = fs.readFileSync(journalPath);
    let complete = bytes;
    let tail = null;
    if (bytes.length && bytes.at(-1) !== 0x0a) {
      const boundary = bytes.lastIndexOf(0x0a) + 1;
      const fragment = bytes.subarray(boundary);
      if (!fragment.length || !recoverTail) throw compatError('COMPAT_REGISTRY_CORRUPT', 'registry has an unterminated tail');
      const digest = createHash('sha256').update(fragment).digest('hex');
      const quarantine = path.join(quarantineDir, `registry-tail.${digest}.jsonfrag`);
      safeWrite(quarantine, fragment, 0o600);
      fs.truncateSync(journalPath, boundary);
      fsyncFile(journalPath);
      fsyncDirectory(indexDir);
      complete = bytes.subarray(0, boundary);
      tail = {
        fragment_digest: `sha256:${digest}`,
        original_length: bytes.length,
        truncated_length: boundary,
      };
    }
    const result = {
      writer_epoch: 0,
      writer_instance_id: null,
      last_digest: null,
      records: new Map(),
      artifacts: new Map(),
      tornTail: tail,
    };
    const lines = complete.toString('utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      let event;
      try { event = JSON.parse(line); } catch (cause) {
        throw compatError('COMPAT_REGISTRY_CORRUPT', 'registry JSON is corrupt', cause);
      }
      validateJournalEvent(event, result);
      result.last_digest = event.event_digest;
      if (event.schema_version === EPOCH_SCHEMA) {
        result.writer_epoch = event.writer_epoch;
        result.writer_instance_id = event.writer_instance_id;
      } else if (event.schema_version === EVENT_SCHEMA
        && ['payload_active', 'payload_invalidated'].includes(event.event_type)) {
        result.records.set(event.payload_ref, event);
      }
      if (event.schema_version === EVENT_SCHEMA) result.artifacts.set(event.artifact_ref, event);
    }
    return result;
  }

  return Object.freeze({
    put,
    get,
    has,
    erase,
    compatibilityDelete,
    registryDigest: () => replayJournal({ recoverTail: false }).last_digest,
    runJanitor,
    list,
    close,
    root,
    journalPath,
    writer_epoch: state.writer_epoch,
    writer_instance_id,
  });

  function payloadPath(ref, domain) {
    return path.join(root, domain, `${validateRef(ref)}.json`);
  }

  function resolveArtifact(record) {
    const match = /^compat-artifact:\/\/payload\/([^/]+)\/([a-f0-9]{64})$/.exec(record.artifact_ref);
    if (!match || !COMPAT_DELETION_DOMAINS.includes(match[1])
      || match[2] !== validateRef(record.payload_ref)) {
      throw compatError('COMPAT_STORE_CORRUPT', 'registry artifact ref invalid');
    }
    const target = path.join(root, match[1], `${match[2]}.json`);
    assertSafePath(target, record.resolved_path_digest);
    return target;
  }

  function safeUnlink(target, record) {
    assertSafePath(target, record.resolved_path_digest);
    let info;
    try { info = fs.lstatSync(target); } catch (cause) {
      if (cause?.code === 'ENOENT') return;
      throw cause;
    }
    if (info.isSymbolicLink() || !info.isFile()) throw compatError('COMPAT_STORE_CORRUPT', 'unsafe payload file');
    const document = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (canonicalDigest(document) !== record.payload_digest) throw compatError('COMPAT_STORE_CORRUPT', 'payload digest drift');
    fs.unlinkSync(target);
    fsyncDirectory(path.dirname(target));
  }

  function assertSafePath(target, expectedDigest) {
    const relative = path.relative(root, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || pathDigest(target) !== expectedDigest) {
      throw compatError('COMPAT_STORE_CORRUPT', 'DELETE_SAFE_ROOT_VIOLATION');
    }
    let current = root;
    for (const segment of relative.split(path.sep).slice(0, -1)) {
      current = path.join(current, segment);
      if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
        throw compatError('COMPAT_STORE_CORRUPT', 'DELETE_SAFE_ROOT_VIOLATION');
      }
    }
  }

  function resolveTemporaryArtifact(record) {
    const match = /^compat-artifact:\/\/temp\/([^/]+)\/(ocq_payload_[a-f0-9]{24})\/([a-f0-9]{16})$/
      .exec(record.artifact_ref);
    if (!match) throw compatError('COMPAT_STORE_CORRUPT', 'registry temporary artifact ref invalid');
    const domain = match[1];
    if (!COMPAT_DELETION_DOMAINS.includes(domain)) {
      throw compatError('COMPAT_STORE_CORRUPT', 'registry temporary artifact domain invalid');
    }
    const target = path.join(root, domain, `.tmp.${match[2]}.${match[3]}`);
    assertSafePath(target, record.resolved_path_digest);
    return target;
  }

  function safeTemporaryUnlink(target, record) {
    assertSafePath(target, record.resolved_path_digest);
    try {
      const info = fs.lstatSync(target);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw compatError('COMPAT_STORE_CORRUPT', 'unsafe temporary payload artifact');
      }
      fs.unlinkSync(target);
      fsyncDirectory(path.dirname(target));
    } catch (cause) {
      if (cause?.code !== 'ENOENT') throw cause;
    }
  }

  function acquireLock(instanceId) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const descriptor = fs.openSync(lockPath, 'wx', 0o600);
        fs.writeSync(descriptor, `${JSON.stringify({
          pid: process.pid,
          writer_instance_id: instanceId,
        })}\n`);
        fs.fsyncSync(descriptor);
        return descriptor;
      } catch (cause) {
        if (cause?.code !== 'EEXIST') {
          throw compatError('COMPAT_STORE_BUSY', 'payload registry writer lock failed', cause);
        }
        let holder;
        try {
          const info = fs.lstatSync(lockPath);
          if (!info.isFile() || info.isSymbolicLink()) throw new Error('unsafe lock');
          holder = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
          process.kill(holder.pid, 0);
          throw compatError('COMPAT_STORE_BUSY', 'payload registry writer lock is held');
        } catch (error) {
          if (error?.code === 'COMPAT_STORE_BUSY' || error?.code === 'EPERM') throw error;
          const stale = `${lockPath}.stale.${randomBytes(8).toString('hex')}`;
          try {
            fs.renameSync(lockPath, stale);
            fs.unlinkSync(stale);
          } catch (renameError) {
            if (renameError?.code !== 'ENOENT') {
              throw compatError('COMPAT_STORE_BUSY', 'payload registry stale lock recovery failed', renameError);
            }
          }
        }
      }
    }
    throw compatError('COMPAT_STORE_BUSY', 'payload registry writer lock is held');
  }
}

function validateJournalEvent(event, state) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw compatError('COMPAT_REGISTRY_CORRUPT', 'registry event invalid');
  const { event_digest, ...material } = event;
  if (event_digest !== canonicalDigest(material) || event.previous_event_digest !== state.last_digest) {
    throw compatError('COMPAT_REGISTRY_CORRUPT', 'registry hash chain invalid');
  }
  if (event.schema_version === EPOCH_SCHEMA) {
    const keys = [
      'schema_version', 'event_id', 'registry_id', 'previous_epoch', 'writer_epoch',
      'writer_instance_id', 'acquired_at', 'previous_event_digest', 'event_digest',
    ];
    strictKeys(event, keys);
    if (event.registry_id !== REGISTRY_ID || event.previous_epoch !== state.writer_epoch
      || event.writer_epoch !== state.writer_epoch + 1
      || !/^ocq_writer_[a-f0-9]{24}$/.test(event.writer_instance_id)) {
      throw compatError('COMPAT_REGISTRY_CORRUPT', 'registry epoch invalid');
    }
    return;
  }
  if (event.schema_version === RECOVERY_SCHEMA) {
    strictKeys(event, [
      'schema_version', 'event_id', 'registry_id', 'fragment_digest', 'original_length',
      'truncated_length', 'writer_epoch', 'writer_instance_id', 'recovered_at',
      'previous_event_digest', 'event_digest',
    ]);
    if (event.writer_epoch !== state.writer_epoch || event.writer_instance_id !== state.writer_instance_id) {
      throw compatError('COMPAT_REGISTRY_CORRUPT', 'registry recovery epoch invalid');
    }
    return;
  }
  if (event.schema_version !== EVENT_SCHEMA) throw compatError('COMPAT_REGISTRY_CORRUPT', 'unknown registry event');
  strictKeys(event, [
    'schema_version', 'event_id', 'event_type', 'payload_ref', 'payload_digest',
    'owner_item', 'source_ref', 'artifact_kind', 'artifact_ref', 'resolved_path_digest',
    'byte_length', 'lifecycle_revision', 'writer_epoch', 'state', 'occurred_at',
    'previous_event_digest', 'event_digest',
  ]);
  if (event.writer_epoch !== state.writer_epoch) throw compatError('COMPAT_REGISTRY_CORRUPT', 'registry writer epoch invalid');
}

function ensureEpochBody(value) {
  if (!value.owner_item || !value.artifact_ref || !value.payload_ref) {
    throw compatError('COMPAT_INGRESS_INVALID', 'registry binding incomplete');
  }
}

function metadata(record) {
  const {
    payload_ref,
    payload_digest,
    owner_item,
    source_ref,
    artifact_kind,
    artifact_ref,
    resolved_path_digest,
  } = record;
  return {
    payload_ref,
    payload_digest,
    owner_item,
    source_ref,
    artifact_kind,
    artifact_ref,
    resolved_path_digest,
  };
}

function strictKeys(value, keys) {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    throw compatError('COMPAT_REGISTRY_CORRUPT', 'registry event fields invalid');
  }
}

function validateRef(ref) {
  const match = /^compat-payload:([a-f0-9]{64})$/.exec(String(ref || ''));
  if (!match) throw compatError('COMPAT_INGRESS_INVALID', 'invalid payload ref');
  return match[1];
}

function artifactRef(ref, domain) {
  return `compat-artifact://payload/${domain}/${validateRef(ref)}`;
}

function pathDigest(target) {
  return `sha256:${createHash('sha256').update(path.resolve(target)).digest('hex')}`;
}

function toIso(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw compatError('COMPAT_INGRESS_INVALID', 'clock invalid');
  return date.toISOString();
}

function safeWrite(target, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const descriptor = fs.openSync(target, 'wx', mode);
  try {
    fs.writeFileSync(descriptor, value);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fsyncDirectory(path.dirname(target));
}

function osReplace(source, target) {
  fs.renameSync(source, target);
  fsyncDirectory(path.dirname(target));
}

function fsyncFile(target) {
  const descriptor = fs.openSync(target, 'r+');
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function fsyncDirectory(target) {
  let descriptor;
  try {
    descriptor = fs.openSync(target, 'r');
    fs.fsyncSync(descriptor);
  } catch {
    // Some platforms do not support directory fsync.
  } finally {
    if (descriptor !== undefined) try { fs.closeSync(descriptor); } catch {}
  }
}
