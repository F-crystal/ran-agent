import {
  createHash,
  createPublicKey,
  timingSafeEqual,
  verify,
} from 'node:crypto';
import fs from 'node:fs';

import { canonicalDigest, canonicalStringify } from './canonical.mjs';
import { compatError } from './constants.mjs';

const RECEIPT_KEYS = [
  'receipt_version', 'receipt_id', 'source_record_ref', 'source_owner',
  'source_event_id', 'source_revision', 'source_event_digest',
  'source_payload_digest', 'deletion_revision', 'deletion_disposition',
  'deleted_at', 'key_id', 'receipt_digest', 'signature',
];
const REGISTRY_KEYS = [
  'schema_version', 'registry_revision', 'current', 'previous', 'updated_at',
];
const KEY_KEYS = ['key_id', 'public_key_raw_base64url', 'activated_at'];
const PREVIOUS_KEY_KEYS = [...KEY_KEYS, 'retired_at', 'verify_until'];
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const PREVIOUS_VERIFY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export function createSourceDeletionReceiptVerifier({
  registryPath,
  expectedRegistryDigest,
  expectedUid = 0,
  expectedGid,
  resolveSource,
  clock = () => new Date(),
}) {
  if (typeof resolveSource !== 'function') {
    throw compatError('COMPAT_CONFIG_INCOMPLETE', 'source deletion resolver is required');
  }

  function loadRegistry() {
    let bytes;
    try {
      const info = fs.lstatSync(registryPath);
      if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o644
        || info.uid !== expectedUid || (expectedGid !== undefined && info.gid !== expectedGid)) {
        throw new Error('registry file identity');
      }
      bytes = fs.readFileSync(registryPath);
    } catch (cause) {
      throw compatError('COMPAT_DELETION_AUTHORITY_INVALID', 'public key registry unavailable', cause);
    }
    let registry;
    try { registry = JSON.parse(bytes.toString('utf8')); } catch (cause) {
      throw compatError('COMPAT_DELETION_AUTHORITY_INVALID', 'public key registry is malformed', cause);
    }
    strictKeys(registry, REGISTRY_KEYS, 'registry');
    if (registry.schema_version !== 'ran-agent-source-deletion-ed25519-key-registry/v1'
      || !Number.isInteger(registry.registry_revision) || registry.registry_revision < 1
      || !validTime(registry.updated_at)) invalid('registry schema');
    const current = parseKey(registry.current, false);
    const previous = registry.previous === null ? null : parseKey(registry.previous, true);
    if (previous?.key_id === current.key_id) invalid('duplicate registry key id');
    const digest = canonicalDigest(registry);
    if (!safeEqual(digest, expectedRegistryDigest)) invalid('registry digest drift');
    return { registry, current, previous, digest };
  }

  async function verifyReceipt(receipt, expected) {
    strictKeys(receipt, RECEIPT_KEYS, 'receipt');
    validateReceiptSchema(receipt);
    const { receipt_digest, signature, ...material } = receipt;
    const calculated = canonicalDigest(material);
    if (!safeEqual(calculated, receipt_digest)) invalid('receipt digest mismatch');
    const { current, previous } = loadRegistry();
    const key = receipt.key_id === current.key_id
      ? current
      : receipt.key_id === previous?.key_id ? previous : null;
    if (!key) invalid('unknown deletion receipt key');
    if (key === previous) {
      const verifiedAt = toDate(clock());
      if (toDate(receipt.deleted_at) > toDate(previous.retired_at)
        || verifiedAt > toDate(previous.verify_until)) invalid('previous key verification window closed');
    }
    const signatureBytes = decodeExact(signature, 64, 'signature');
    const signatureMaterial = Buffer.from(
      `ran-agent-source-deletion-receipt/v1\n${receipt_digest}`,
      'utf8',
    );
    if (!verify(null, signatureMaterial, key.publicKey, signatureBytes)) {
      invalid('Ed25519 signature invalid');
    }
    assertBinding(receipt, expected);
    const resolution = await resolveSource({
      owner: receipt.source_owner,
      source_record_ref: receipt.source_record_ref,
    });
    if (!resolution || resolution.status !== 'typed_unresolvable') {
      invalid('source record remains resolvable');
    }
    return Object.freeze({
      status: 'verified',
      receipt_id: receipt.receipt_id,
      key_id: receipt.key_id,
      registry_digest: expectedRegistryDigest,
    });
  }

  return Object.freeze({ loadRegistry, verifyReceipt });
}

function validateReceiptSchema(receipt) {
  if (receipt.receipt_version !== 'ran-agent-source-deletion-receipt/v1'
    || !/^csdr_[a-f0-9]{32}$/.test(receipt.receipt_id)
    || !['core.durable-outbox', 'core.global-timeline'].includes(receipt.source_owner)
    || !/^ocq_src_[a-f0-9]{32}$/.test(receipt.source_event_id)
    || !Number.isInteger(receipt.source_revision) || receipt.source_revision < 0
    || !Number.isInteger(receipt.deletion_revision) || receipt.deletion_revision < 1
    || !['deleted', 'cryptographically_unrecoverable'].includes(receipt.deletion_disposition)
    || !validTime(receipt.deleted_at)
    || !SHA256.test(receipt.source_event_digest)
    || !SHA256.test(receipt.source_payload_digest)
    || !SHA256.test(receipt.receipt_digest)
    || !SHA256.test(receipt.key_id)) invalid('receipt schema');
  if (receipt.source_owner === 'core.durable-outbox'
    ? !/^durable-outbox:\/\/item\/[A-Za-z0-9_.:-]+$/.test(receipt.source_record_ref)
    : !/^global-timeline:\/\/event-key\/[^/]+$/.test(receipt.source_record_ref)) {
    invalid('receipt owner/ref binding');
  }
  decodeExact(receipt.signature, 64, 'signature');
}

function assertBinding(receipt, expected) {
  const fields = [
    'source_record_ref', 'source_owner', 'source_event_id', 'source_revision',
    'source_event_digest', 'source_payload_digest', 'deletion_revision',
  ];
  if (!expected || fields.some((field) => receipt[field] !== expected[field])) {
    invalid('source deletion receipt binding mismatch');
  }
}

function parseKey(value, previous) {
  strictKeys(value, previous ? PREVIOUS_KEY_KEYS : KEY_KEYS, 'registry key');
  if (!SHA256.test(value.key_id) || !validTime(value.activated_at)
    || (previous && (!validTime(value.retired_at) || !validTime(value.verify_until)))) {
    invalid('registry key schema');
  }
  if (previous && (toDate(value.retired_at) < toDate(value.activated_at)
    || toDate(value.verify_until).getTime() - toDate(value.retired_at).getTime() !== PREVIOUS_VERIFY_WINDOW_MS)) {
    invalid('registry key rotation window');
  }
  const raw = decodeExact(value.public_key_raw_base64url, 32, 'public key');
  const keyId = `sha256:${createHash('sha256').update(raw).digest('hex')}`;
  if (!safeEqual(keyId, value.key_id)) invalid('public key digest mismatch');
  const publicKey = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  });
  return { ...value, raw, publicKey };
}

function strictKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())
    || canonicalStringify(value).includes('undefined')) invalid(`${label} fields`);
}

function decodeExact(value, length, label) {
  if (typeof value !== 'string' || !BASE64URL.test(value) || value.includes('=')) invalid(`${label} encoding`);
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length !== length || decoded.toString('base64url') !== value) invalid(`${label} length`);
  return decoded;
}

function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function validTime(value) {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function toDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) invalid('clock invalid');
  return date;
}

function invalid(message) {
  throw compatError('COMPAT_DELETION_AUTHORITY_INVALID', message);
}
