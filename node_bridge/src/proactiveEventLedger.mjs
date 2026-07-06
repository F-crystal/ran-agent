import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { resolveStateDir } from './runtimeState.mjs';

const LEDGER_FILE = 'proactive-events.json';
const RESERVATION_TTL_MS = 10 * 60 * 1000;
const SENT_DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;

export function reserveProactiveEventDelivery(event = {}, options = {}) {
  const env = options.env || process.env;
  const now = normalizeDate(options.now) || new Date();
  const eventId = sanitizeId(event.event_id || event.eventId || '');
  const dedupeKey = sanitizeScope(event.dedupe_key || event.dedupeKey || eventId);
  if (!eventId || !dedupeKey) {
    return { allowed: false, reason: 'invalid_event_dedupe_scope' };
  }
  const records = readLedger(env);
  const active = activeRecords(records, now);
  const existing = active.find((item) => item.eventId === eventId || item.dedupeKey === dedupeKey);
  if (existing) {
    return {
      allowed: false,
      reason: existing.status === 'sent' ? 'event_already_sent' : 'event_dedupe_active',
      record: existing,
    };
  }
  const record = {
    reservationId: `proevt_${hashShort(`${eventId}:${dedupeKey}:${now.toISOString()}`)}`,
    eventId,
    dedupeKey,
    kind: sanitizeId(event.kind || ''),
    globalUserId: sanitizeId(event.global_user_id || event.globalUserId || ''),
    createdAt: now.toISOString(),
    reserveExpiresAt: new Date(now.getTime() + RESERVATION_TTL_MS).toISOString(),
    status: 'reserved',
  };
  writeLedger(env, [...pruneRecords(records, now), record].slice(-500));
  return { allowed: true, reason: 'event_reserved', record };
}

export function commitProactiveEventDelivery(reservationId, options = {}) {
  const env = options.env || process.env;
  const now = normalizeDate(options.now) || new Date();
  const id = sanitizeId(reservationId);
  let committed = null;
  const next = readLedger(env).map((item) => {
    if (item?.reservationId !== id && item?.eventId !== id) return item;
    committed = {
      ...item,
      status: 'sent',
      sentAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + SENT_DEDUPE_TTL_MS).toISOString(),
    };
    return committed;
  });
  writeLedger(env, pruneRecords(next, now).slice(-500));
  return committed;
}

export function releaseProactiveEventDelivery(reservationId, options = {}) {
  const env = options.env || process.env;
  const now = normalizeDate(options.now) || new Date();
  const id = sanitizeId(reservationId);
  const records = readLedger(env);
  const next = records.filter((item) => item?.reservationId !== id && item?.eventId !== id);
  writeLedger(env, pruneRecords(next, now).slice(-500));
  return { ok: next.length !== records.length, reservationId: id };
}

function ledgerPath(env) {
  return path.join(resolveStateDir(env), 'node-bridge-runtime', LEDGER_FILE);
}

function readLedger(env) {
  try {
    const parsed = JSON.parse(fs.readFileSync(ledgerPath(env), 'utf8'));
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item === 'object') : [];
  } catch {
    return [];
  }
}

function writeLedger(env, records) {
  const target = ledgerPath(env);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
}

function activeRecords(records, now) {
  const nowMs = now.getTime();
  return records.filter((item) => {
    const status = String(item.status || '').trim().toLowerCase();
    if (status === 'reserved') {
      const expiresMs = Date.parse(String(item.reserveExpiresAt || ''));
      return Number.isFinite(expiresMs) && expiresMs >= nowMs;
    }
    if (status === 'sent') {
      const expiresMs = Date.parse(String(item.expiresAt || ''));
      return !Number.isFinite(expiresMs) || expiresMs >= nowMs;
    }
    return false;
  });
}

function pruneRecords(records, now) {
  const nowMs = now.getTime();
  return records.filter((item) => {
    const status = String(item.status || '').trim().toLowerCase();
    if (status === 'reserved') {
      const expiresMs = Date.parse(String(item.reserveExpiresAt || ''));
      return Number.isFinite(expiresMs) && expiresMs >= nowMs;
    }
    if (status === 'sent') {
      const expiresMs = Date.parse(String(item.expiresAt || ''));
      return !Number.isFinite(expiresMs) || expiresMs >= nowMs;
    }
    return false;
  });
}

function normalizeDate(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? new Date(parsed) : null;
}

function sanitizeId(value) {
  return String(value || '').trim().replace(/[\r\n\t]/g, ' ').replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 160);
}

function sanitizeScope(value) {
  return String(value || '').trim().replace(/[\r\n\t]/g, ' ').replace(/[^a-zA-Z0-9_.:/-]/g, '').slice(0, 180);
}

function hashShort(value) {
  return createHash('sha256').update(String(value || ''), 'utf8').digest('hex').slice(0, 16);
}
