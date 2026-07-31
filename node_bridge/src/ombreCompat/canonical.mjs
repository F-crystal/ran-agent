// Canonical serialization, digests, and id helpers for the O2 compatibility
// layer. All contract digests (source event, operation key, request, policy)
// are computed over this stable encoding.

import { createHash, randomBytes } from 'node:crypto';

// Deterministic JSON: object keys sorted recursively, no undefined values,
// arrays kept in order. Only JSON-safe values are allowed.
export function canonicalStringify(value) {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value) {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry));
  if (typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      const entry = value[key];
      if (entry === undefined) continue;
      out[key] = canonicalize(entry);
    }
    return out;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return value;
  }
  if (['string', 'boolean'].includes(typeof value)) return value;
  return String(value);
}

export function sha256Hex(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

export function sha256Digest(text) {
  return `sha256:${sha256Hex(text)}`;
}

export function canonicalDigest(value) {
  return sha256Digest(canonicalStringify(value));
}

export function utf8ByteLength(text) {
  return Buffer.byteLength(String(text ?? ''), 'utf8');
}

export function newId(prefix) {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}

// Deterministic opaque id derived from canonical material (stable ids such
// as source event ids that must survive process restarts).
export function derivedId(prefix, material) {
  return `${prefix}_${sha256Hex(canonicalStringify(material)).slice(0, 32)}`;
}

export function isSha256Digest(value) {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
}

export function deepFreezeClone(value) {
  return deepFreeze(structuredClone(value));
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}
