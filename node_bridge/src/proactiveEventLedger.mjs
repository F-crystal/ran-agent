import { createHash } from 'node:crypto';
import path from 'node:path';

import { readJsonState, writeJsonAtomic } from './atomicState.mjs';
import {
  getCheckinRange,
  resolveStateDir,
  setProactiveDispatchState,
} from './runtimeState.mjs';

const LEDGER_FILE = 'proactive-events.json';
const MIN_RESERVATION_TTL_MS = 10 * 60 * 1000;
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
  if (String(event.kind || '') === 'companion'
    && sentCompanionCount(active, event, now, env) >= companionDailyLimit(env)) {
    return { allowed: false, reason: 'companion_daily_limit_reached' };
  }
  const record = {
    reservationId: `proevt_${hashShort(`${eventId}:${dedupeKey}:${now.toISOString()}`)}`,
    eventId,
    dedupeKey,
    kind: sanitizeId(event.kind || ''),
    globalUserId: sanitizeId(event.global_user_id || event.globalUserId || ''),
    createdAt: now.toISOString(),
    reserveExpiresAt: new Date(now.getTime() + reservationTtlMs(env)).toISOString(),
    status: 'reserved',
  };
  writeLedger(env, [...pruneRecords(records, now), record].slice(-500));
  if (record.kind === 'companion') {
    const range = getCheckinRange(env);
    const span = range.maxMinutes - range.minMinutes + 1;
    const offset = Number.parseInt(hashShort(`${eventId}:${dedupeKey}`).slice(0, 8), 16) % span;
    setProactiveDispatchState({
      nextAllowedAt: new Date(now.getTime() + ((range.minMinutes + offset) * 60_000)).toISOString(),
    }, env);
  }
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
  return readJsonState(ledgerPath(env), {
    validate: isLedger,
    missingValue: [],
    critical: true,
  });
}

function writeLedger(env, records) {
  writeJsonAtomic(ledgerPath(env), records, { validate: isLedger });
}

function isLedger(value) {
  return Array.isArray(value) && value.every((record) => Boolean(
    record && typeof record === 'object' && !Array.isArray(record)
    && sanitizeId(record.reservationId)
    && sanitizeId(record.eventId)
    && sanitizeScope(record.dedupeKey)
    && ['reserved', 'sent'].includes(String(record.status || '')),
  ));
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

function companionDailyLimit(env) {
  const parsed = Number.parseInt(String(env.PERSONAL_AGENT_PROACTIVE_DAILY_LIMIT || ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 20) : 5;
}

function reservationTtlMs(env) {
  const replySeconds = positiveInt(env.HERMES_REPLY_TIMEOUT_SECONDS, 180);
  const sendSeconds = positiveInt(env.FEISHU_SEND_TIMEOUT_SECONDS, 30);
  return Math.max(MIN_RESERVATION_TTL_MS, (replySeconds + sendSeconds + 30) * 1000);
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function sentCompanionCount(records, event, now, env) {
  const day = localDay(now, env);
  const globalUserId = sanitizeId(event.global_user_id || event.globalUserId || '');
  return records.filter((item) => item.status === 'sent' && item.kind === 'companion'
    && item.globalUserId === globalUserId && localDay(normalizeDate(item.sentAt), env) === day).length;
}

function localDay(date, env) {
  if (!date) return '';
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: String(env.HERMES_ENVIRONMENT_TIMEZONE || 'Asia/Shanghai'),
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(date);
  } catch {
    return '';
  }
}
