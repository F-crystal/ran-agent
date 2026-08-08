import { readJsonState, writeJsonAtomic } from './atomicState.mjs';

const SCHEMA_VERSION = 1;
const CONTENT_CLASSES = new Set(['ambient', 'timely', 'critical']);
const KNOWN_PRESENCE = new Set(['available', 'gaming', 'focused', 'busy', 'dnd']);
const EXPLICIT_REMINDER_POLICY = 'ignore_for_explicit_reminder';

function attentionError(code, message) {
  return Object.assign(new Error(message), { code });
}

function boundedText(value, field, max = 4000) {
  const text = String(value || '').trim();
  if (text.length > max) throw attentionError('ATTENTION_INPUT_INVALID', `${field} exceeds the bounded length`);
  return text;
}

function requireFingerprint(value) {
  const text = boundedText(value, 'fingerprint', 240);
  if (!text) throw attentionError('ATTENTION_FINGERPRINT_REQUIRED', 'one stable source fingerprint is required');
  return text;
}

function isoNow(now) {
  const date = now();
  if (!Number.isFinite(new Date(date).getTime())) throw attentionError('ATTENTION_CLOCK_INVALID', 'attention valve clock is invalid');
  return new Date(date).toISOString();
}

function normalizeItem(item) {
  const fingerprint = requireFingerprint(item?.fingerprint);
  const contentClass = String(item?.contentClass || '');
  if (!CONTENT_CLASSES.has(contentClass) || contentClass === 'ambient') {
    throw attentionError('ATTENTION_STATE_INVALID', 'delayed item content class is invalid');
  }
  if (!['pending', 'flushing'].includes(item?.state)) {
    throw attentionError('ATTENTION_STATE_INVALID', 'delayed item state is invalid');
  }
  if (!Number.isSafeInteger(item?.count) || item.count < 1) {
    throw attentionError('ATTENTION_STATE_INVALID', 'delayed item count is invalid');
  }
  return {
    fingerprint,
    contentClass,
    state: item.state,
    count: item.count,
    summary: boundedText(item?.summary, 'summary'),
    firstSeenAt: String(item?.firstSeenAt || ''),
    lastSeenAt: String(item?.lastSeenAt || ''),
    flushingSince: item?.flushingSince ? String(item.flushingSince) : null,
  };
}

function validateState(value) {
  if (!value || typeof value !== 'object' || value.schemaVersion !== SCHEMA_VERSION || !Array.isArray(value.items)) {
    return false;
  }
  try {
    const seen = new Set();
    for (const item of value.items) {
      const normalized = normalizeItem(item);
      if (seen.has(normalized.fingerprint)) return false;
      seen.add(normalized.fingerprint);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * The Node attention valve decides only visible delivery timing. It never
 * stores or discards a Core fact: `ambient` results stay silent, `timely`
 * results are delayed and coalesced by stable source fingerprint while the
 * owner is gaming/focused/busy/dnd, and only an owner-allowlisted critical key
 * (or an explicit owner reminder) may bypass. Presence is read from an
 * injected adapter outside any Core transaction; an unknown presence reading
 * delays rather than interrupts, and delayed items are never lost. Run one
 * valve instance per state path: a new flush supersedes an unconfirmed flush,
 * a fact that arrives during a flush returns the item to pending, and only a
 * fresh instance recovers items interrupted by a process crash.
 */
export function createAttentionValve({
  statePath,
  now = () => new Date(),
  presenceProvider = () => 'available',
  criticalAllowlist = [],
} = {}) {
  if (typeof statePath !== 'string' || !statePath.trim()) {
    throw attentionError('ATTENTION_STATE_PATH_REQUIRED', 'attention valve requires a durable state path');
  }
  if (typeof presenceProvider !== 'function') {
    throw attentionError('ATTENTION_PRESENCE_REQUIRED', 'attention valve requires an injected presence adapter');
  }
  const allowlist = new Set(criticalAllowlist.map((key) => String(key || '').trim()).filter(Boolean));
  let recoveryDone = false;

  function load() {
    const state = readJsonState(statePath, {
      validate: validateState,
      missingValue: { schemaVersion: SCHEMA_VERSION, items: [] },
      critical: true,
    });
    if (recoveryDone) return state;
    recoveryDone = true;
    let recovered = false;
    for (const item of state.items) {
      if (item.state === 'flushing') {
        item.state = 'pending';
        item.flushingSince = null;
        recovered = true;
      }
    }
    if (recovered) save(state);
    return state;
  }

  function save(state) {
    writeJsonAtomic(statePath, state, { validate: validateState });
  }

  function presence() {
    const value = String(presenceProvider() || '').trim().toLowerCase();
    return KNOWN_PRESENCE.has(value) ? value : 'unknown';
  }

  function evaluate({ contentClass, fingerprint, summary = '', quietPolicy = 'respect', criticalKey = '' } = {}) {
    const kind = String(contentClass || '').trim();
    if (!CONTENT_CLASSES.has(kind)) throw attentionError('ATTENTION_CONTENT_CLASS_INVALID', 'content class must be ambient, timely, or critical');
    if (kind === 'ambient') return Object.freeze({ disposition: 'suppress_silent', contentClass: kind });
    if (String(quietPolicy || '').trim() === EXPLICIT_REMINDER_POLICY) {
      return Object.freeze({ disposition: 'deliver_now', reason: 'explicit_reminder', contentClass: kind });
    }
    if (kind === 'critical' && allowlist.has(String(criticalKey || '').trim())) {
      return Object.freeze({ disposition: 'deliver_now', reason: 'critical_allowlisted', contentClass: kind });
    }
    const currentPresence = presence();
    if (currentPresence === 'available') {
      return Object.freeze({ disposition: 'deliver_now', reason: 'presence_available', contentClass: kind });
    }
    const key = requireFingerprint(fingerprint);
    const state = load();
    const at = isoNow(now);
    const existing = state.items.find((item) => item.fingerprint === key);
    if (existing) {
      if (existing.state === 'flushing') {
        // A fact that arrives while its fingerprint is mid-flush must survive
        // the old flush's confirmation: return to pending and keep the fact.
        existing.state = 'pending';
        existing.flushingSince = null;
      }
      existing.count += 1;
      existing.summary = boundedText(summary, 'summary') || existing.summary;
      existing.lastSeenAt = at;
    } else {
      state.items.push({
        fingerprint: key,
        contentClass: kind,
        state: 'pending',
        count: 1,
        summary: boundedText(summary, 'summary'),
        firstSeenAt: at,
        lastSeenAt: at,
        flushingSince: null,
      });
    }
    save(state);
    const item = state.items.find((entry) => entry.fingerprint === key);
    return Object.freeze({
      disposition: 'delayed',
      reason: `presence_${currentPresence}`,
      contentClass: kind,
      fingerprint: key,
      coalescedCount: item.count,
    });
  }

  function listPending() {
    return load().items
      .filter((item) => item.state === 'pending')
      .map((item) => Object.freeze({ ...item }));
  }

  function flush() {
    if (presence() !== 'available') return Object.freeze([]);
    const state = load();
    const at = isoNow(now);
    // A new flush supersedes any earlier flush this caller never confirmed:
    // un-stick those items so a failed delivery attempt cannot strand them.
    for (const item of state.items) {
      if (item.state === 'flushing') {
        item.state = 'pending';
        item.flushingSince = null;
      }
    }
    const ready = state.items.filter((item) => item.state === 'pending');
    if (ready.length === 0) {
      save(state);
      return Object.freeze([]);
    }
    for (const item of ready) {
      item.state = 'flushing';
      item.flushingSince = at;
    }
    save(state);
    return Object.freeze(ready.map((item) => Object.freeze({ ...item })));
  }

  function confirmFlushed(fingerprint) {
    const key = requireFingerprint(fingerprint);
    const state = load();
    const index = state.items.findIndex((item) => item.fingerprint === key && item.state === 'flushing');
    if (index === -1) throw attentionError('ATTENTION_FLUSH_STATE_INVALID', 'only a flushing item can be confirmed');
    state.items.splice(index, 1);
    save(state);
  }

  return Object.freeze({
    evaluate,
    listPending,
    flush,
    confirmFlushed,
  });
}
