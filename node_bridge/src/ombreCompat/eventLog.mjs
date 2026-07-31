// Append-only, hash-chained JSONL event log for the compatibility queue.
// Contract: §3.4 append-only operation metadata; operational state is rebuilt
// by folding typed events; a torn tail from a crash is truncated, corrupt
// non-tail content is quarantined fail-loud.

import fs from 'node:fs';
import path from 'node:path';

import { appendJsonLine, quarantineCorruptState, writeFileAtomic } from '../atomicState.mjs';
import { canonicalDigest, canonicalStringify } from './canonical.mjs';
import { COMPAT_LOG_SCHEMA_VERSION, compatError } from './constants.mjs';

export function createCompatEventLog({ logPath, lockPath }) {
  const target = String(logPath);
  const lock = String(lockPath || `${target}.lock`);
  let lockDescriptor;

  function acquireWriterLock() {
    fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
    try {
      lockDescriptor = fs.openSync(lock, 'wx', 0o600);
      fs.writeFileSync(lockDescriptor, `${process.pid}\n`, 'utf8');
      fs.fsyncSync(lockDescriptor);
    } catch (error) {
      if (error?.code === 'EEXIST') {
        throw compatError('COMPAT_STORE_BUSY', 'compatibility queue writer lock is held');
      }
      throw error;
    }
  }

  function releaseWriterLock() {
    if (lockDescriptor === undefined) return;
    try { fs.closeSync(lockDescriptor); } catch {}
    lockDescriptor = undefined;
    try { fs.rmSync(lock, { force: true }); } catch {}
  }

  // Read every durable entry. A single incomplete JSON tail is treated as a
  // torn write and truncated; anything else invalid quarantines the log.
  function readAll() {
    let text;
    try {
      text = fs.readFileSync(target, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return { entries: [], truncatedTail: false };
      throw error;
    }
    if (!text) return { entries: [], truncatedTail: false };
    const hasFinalNewline = text.endsWith('\n');
    const lines = text.split('\n');
    if (hasFinalNewline) lines.pop();
    const entries = [];
    const validLines = [];
    let truncatedTail = false;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line) throw quarantined('blank-jsonl-line');
      let value;
      try {
        value = JSON.parse(line);
      } catch (error) {
        const isTail = index === lines.length - 1 && !hasFinalNewline && isIncompleteJsonTail(line, error);
        if (!isTail) throw quarantined('invalid-jsonl');
        truncatedTail = true;
        break;
      }
      if (!isValidEntryShape(value)) throw quarantined('invalid-event-record');
      entries.push(value);
      validLines.push(line);
    }
    const chainError = verifyChain(entries);
    if (chainError) throw quarantined(chainError);
    if (truncatedTail) {
      writeFileAtomic(target, validLines.length > 0 ? `${validLines.join('\n')}\n` : '');
    }
    return { entries, truncatedTail };
  }

  function verifyChain(entries) {
    let prev = 'sha256:genesis';
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (entry.seq !== index + 1) return 'event-seq-gap';
      if (entry.prev_digest !== prev) return 'event-chain-break';
      if (entry.entry_digest !== computeEntryDigest(entry)) return 'event-digest-mismatch';
      prev = entry.entry_digest;
    }
    return null;
  }

  function isValidEntryShape(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    if (value.schema_version !== COMPAT_LOG_SCHEMA_VERSION) return false;
    if (!Number.isInteger(value.seq) || value.seq < 1) return false;
    if (typeof value.type !== 'string' || !value.type) return false;
    if (typeof value.at !== 'string' || !Number.isFinite(Date.parse(value.at))) return false;
    if (typeof value.prev_digest !== 'string' || !value.prev_digest.startsWith('sha256:')) return false;
    if (typeof value.entry_digest !== 'string' || !value.entry_digest.startsWith('sha256:')) return false;
    return true;
  }

  function isIncompleteJsonTail(line, error) {
    if (!String(line || '').trimStart().startsWith('{')) return false;
    const message = String(error?.message || '');
    if (/unexpected end|end of json input/i.test(message)) return true;
    const match = message.match(/position\s+(\d+)/i);
    return Boolean(match) && Number(match[1]) >= String(line).length - 1;
  }

  function quarantined(reason) {
    try {
      quarantineCorruptState(target, reason);
    } catch (cause) {
      return compatError('COMPAT_STORE_CORRUPT', 'compatibility event log is invalid and could not be quarantined', cause);
    }
    return compatError('COMPAT_STORE_CORRUPT', `compatibility event log is invalid and was quarantined (${reason})`);
  }

  function head(entries) {
    if (entries.length === 0) return { seq: 0, digest: 'sha256:genesis' };
    const last = entries[entries.length - 1];
    return { seq: last.seq, digest: last.entry_digest };
  }

  // Append one typed event. `type`/`at`/`body` are caller supplied; seq,
  // prev_digest, and entry_digest are assigned here. Returns the durable entry.
  function append({ entries, type, at, body }) {
    const current = head(entries);
    const entry = {
      schema_version: COMPAT_LOG_SCHEMA_VERSION,
      seq: current.seq + 1,
      type,
      at,
      ...body,
      prev_digest: current.digest,
    };
    entry.entry_digest = computeEntryDigest(entry);
    appendJsonLine(target, entry, { validate: isValidEntryShape });
    return entry;
  }

  return {
    logPath: target,
    acquireWriterLock,
    releaseWriterLock,
    readAll,
    append,
    head,
  };
}

export function computeEntryDigest(entry) {
  const { entry_digest: _ignored, ...material } = entry;
  return canonicalDigest(material);
}

export function canonicalEventMaterial(entry) {
  return canonicalStringify(entry);
}
