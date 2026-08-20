import { createTrustedBridgeTask } from './hermesTaskScope.mjs';
import { getCheckinRange, getProactiveDispatchState } from './runtimeState.mjs';

const VALID_KINDS = new Set([
  'reminder',
  'forum_watch',
  'game_activity',
  'digest',
  'curiosity',
  'maintenance',
  'external_mcp',
  'companion',
]);
const VALID_CHANNELS = new Set(['feishu', 'wechat', 'desktop']);
const VALID_DELIVERABILITY = new Set(['silent_only', 'draft_allowed', 'notify_allowed']);
const VALID_TIERS = new Set(['T0', 'T1', 'T2', 'T3']);
const VALID_BUDGET_CLASSES = new Set(['external_mcp', 'reminder', 'digest', 'curiosity', 'maintenance']);
const PROACTIVE_ROUTE_HINT = 'hermes_proactive_event';
const DEFAULT_PROACTIVE_NOTIFY_MAX_CHARS = 700;

export function normalizeProactiveEvent(input = {}, defaults = {}) {
  const eventId = sanitizeId(input.event_id || input.eventId || input.id || defaults.eventId || '');
  const kind = normalizeKind(input.kind || defaults.kind || '');
  const globalUserId = sanitizeId(
    input.global_user_id || input.globalUserId || defaults.globalUserId || ''
  );
  const channel = normalizeChannel(input.channel || defaults.channel || '');
  const watchScope = sanitizeScope(input.watch_scope || input.watchScope || defaults.watchScope || '');
  const reason = sanitizeText(input.reason || defaults.reason || '');
  const evidenceRefs = normalizeRefs(
    input.evidence_refs || input.evidenceRefs || defaults.evidenceRefs || []
  );
  const dedupeKey = sanitizeScope(input.dedupe_key || input.dedupeKey || defaults.dedupeKey || watchScope || eventId);
  const createdAt = normalizeIso(input.created_at || input.createdAt || defaults.createdAt || new Date());
  const expiresAt = normalizeIso(input.expires_at || input.expiresAt || defaults.expiresAt || '');
  const deliverability = normalizeDeliverability(input.deliverability || defaults.deliverability || 'silent_only');
  const allowedCapabilityTiers = normalizeTiers(
    input.allowed_capability_tiers || input.allowedCapabilityTiers || defaults.allowedCapabilityTiers || ['T1']
  );
  const quietPolicy = normalizeQuietPolicy(input.quiet_policy || input.quietPolicy || defaults.quietPolicy || 'respect');
  const budgetClass = normalizeBudgetClass(input.budget_class || input.budgetClass || defaults.budgetClass || kind);

  const missing = [];
  if (!eventId) missing.push('event_id');
  if (!kind) missing.push('kind');
  if (!globalUserId) missing.push('global_user_id');
  if (!watchScope) missing.push('watch_scope');
  if (!reason) missing.push('reason');
  if (!dedupeKey) missing.push('dedupe_key');
  if (!createdAt) missing.push('created_at');
  if (missing.length > 0) {
    return { ok: false, error: `missing_or_invalid_${missing.join('_')}` };
  }

  return {
    ok: true,
    event: {
      event_id: eventId,
      kind,
      global_user_id: globalUserId,
      channel,
      watch_scope: watchScope,
      reason,
      evidence_refs: evidenceRefs,
      dedupe_key: dedupeKey,
      created_at: createdAt,
      expires_at: expiresAt,
      deliverability,
      allowed_capability_tiers: allowedCapabilityTiers,
      quiet_policy: quietPolicy,
      budget_class: budgetClass,
    },
  };
}

export function buildProactiveSyntheticTurn(event, target = {}) {
  const id = sanitizeId(event?.event_id || `proactive-${Date.now()}`);
  const text = [
    '[Hermes proactive event]',
    'This is an internal system turn, not a user-authored message.',
    `event_id: ${event.event_id}`,
    `kind: ${event.kind}`,
    `watch_scope: ${event.watch_scope}`,
    `reason: ${event.reason}`,
    `evidence_refs: ${(event.evidence_refs || []).join(',') || 'none'}`,
    `dedupe_key: ${event.dedupe_key}`,
    `created_at: ${event.created_at}`,
    `expires_at: ${event.expires_at || 'none'}`,
    `deliverability: ${event.deliverability}`,
    `allowed_capability_tiers: ${(event.allowed_capability_tiers || []).join(',') || 'T1'}`,
    `quiet_policy: ${event.quiet_policy}`,
    `budget_class: ${event.budget_class}`,
    '',
    'Return exactly one JSON object with action silent, remember, draft, or notify.',
    'For notify, include message, evidence_refs, and why_now. Do not send generic check-ins.',
  ].join('\n');
  return createTrustedBridgeTask({
    id,
    message_id: id,
    platform: target.platform || event.channel || '',
    channel_type: target.channel_type || target.channelType || 'dm',
    conversation_id: sanitizeId(target.conversation_id || target.conversationId || ''),
    sender_id: sanitizeId(target.sender_id || target.senderId || event.global_user_id || ''),
    global_user_id: event.global_user_id || '',
    route_hint: PROACTIVE_ROUTE_HINT,
    proactive_event: event,
    text,
    media: [],
    created_at: Date.parse(event.created_at) || Date.now(),
  }, PROACTIVE_ROUTE_HINT);
}

export function evaluateProactiveAdmission(event, options = {}) {
  if (!isTruthyEnv((options.env || process.env).HERMES_PROACTIVE_EVENTS_ENABLED)) {
    return { accepted: false, reason: 'proactive_events_disabled' };
  }
  const now = normalizeDate(options.now || new Date()) || new Date();
  if (event.kind === 'companion') {
    const policy = getCheckinRange(options.env || process.env);
    if (!policy.enabled) return { accepted: false, reason: 'companion_stopped' };
    if (isQuietHour(now, options.env || process.env)) {
      return { accepted: false, reason: 'companion_quiet_hours' };
    }
    const nextAllowedAt = normalizeDate(getProactiveDispatchState(options.env || process.env).nextAllowedAt);
    if (nextAllowedAt && nextAllowedAt.getTime() > now.getTime()) {
      return { accepted: false, reason: 'companion_cooldown' };
    }
  }
  const expiresAt = normalizeDate(event.expires_at);
  if (expiresAt && expiresAt.getTime() < now.getTime()) {
    return { accepted: false, reason: 'event_expired' };
  }
  if (event.deliverability === 'notify_allowed' && requiresEvidence(event) && event.evidence_refs.length === 0) {
    return { accepted: false, reason: 'evidence_required' };
  }
  return { accepted: true, reason: 'accepted' };
}

export function parseHermesProactiveAction(replyText) {
  const text = String(replyText || '').trim();
  if (!text) {
    return { ok: false, reason: 'empty_action' };
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: 'malformed_action' };
    }
    const action = String(parsed.action || parsed.type || '').trim().toLowerCase();
    if (!['silent', 'remember', 'draft', 'notify'].includes(action)) {
      return { ok: false, reason: 'unsupported_action' };
    }
    return { ok: true, action: { ...parsed, action } };
  } catch {
    return { ok: false, reason: 'malformed_action' };
  }
}

export function proactiveNotifyMaxChars(env = process.env) {
  const parsed = Number.parseInt(String(env?.HERMES_PROACTIVE_NOTIFY_MAX_CHARS || ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_PROACTIVE_NOTIFY_MAX_CHARS;
  }
  return Math.min(Math.max(parsed, 200), 4000);
}

export function evaluateProactiveEgress({ event, replyText, env } = {}) {
  const parsed = parseHermesProactiveAction(replyText);
  if (!parsed.ok) {
    return { send: false, reason: parsed.reason };
  }
  const action = parsed.action;
  if (action.action === 'silent' || action.action === 'remember') {
    return { send: false, reason: action.action, action };
  }
  if (action.action === 'draft') {
    return { send: false, reason: 'draft_requires_confirmation', action };
  }
  if (event.deliverability !== 'notify_allowed') {
    return { send: false, reason: 'deliverability_not_notify_allowed', action };
  }
  const message = String(action.message || '').trim();
  if (!message) {
    return { send: false, reason: 'empty_message', action };
  }
  if (message.length > proactiveNotifyMaxChars(env)) {
    return { send: false, reason: 'message_too_long', action };
  }
  if (containsToolTrace(message)) {
    return { send: false, reason: 'tool_trace_in_message', action };
  }
  if (event.kind !== 'reminder' && isGenericProactiveMessage(message)) {
    return { send: false, reason: 'generic_proactive_message', action };
  }
  if ((requiresEvidence(event) || event.evidence_refs.length > 0) && !hasTrustedEvidence(event, action)) {
    return { send: false, reason: 'evidence_missing', action };
  }
  if (!String(action.why_now || action.whyNow || '').trim()) {
    return { send: false, reason: 'why_now_missing', action };
  }
  return { send: true, reason: 'notify_allowed', message, action };
}

export function proactiveEventRouteHint() {
  return PROACTIVE_ROUTE_HINT;
}

export function isTruthyEnv(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || 'false').trim().toLowerCase());
}

function normalizeKind(value) {
  const text = String(value || '').trim().toLowerCase();
  return VALID_KINDS.has(text) ? text : '';
}

function normalizeChannel(value) {
  const text = String(value || '').trim().toLowerCase();
  return VALID_CHANNELS.has(text) ? text : '';
}

function normalizeDeliverability(value) {
  const text = String(value || '').trim().toLowerCase();
  return VALID_DELIVERABILITY.has(text) ? text : 'silent_only';
}

function normalizeTiers(values) {
  const list = Array.isArray(values) ? values : values ? [values] : ['T1'];
  const tiers = list
    .map((item) => String(item || '').trim().toUpperCase())
    .filter((item) => VALID_TIERS.has(item))
    .slice(0, 4);
  return tiers.length ? tiers : ['T1'];
}

function normalizeBudgetClass(value) {
  const text = String(value || '').trim().toLowerCase();
  if (VALID_BUDGET_CLASSES.has(text)) return text;
  if (text === 'forum_watch' || text === 'game_activity' || text === 'external_mcp') return 'external_mcp';
  return 'maintenance';
}

function normalizeQuietPolicy(value) {
  const text = String(value || '').trim().toLowerCase();
  return ['respect', 'ignore_for_explicit_reminder'].includes(text) ? text : 'respect';
}

function normalizeRefs(values) {
  const list = Array.isArray(values) ? values : values ? [values] : [];
  return Array.from(new Set(
    list
      .map((item) => sanitizeRef(item))
      .filter(Boolean)
  )).slice(0, 20);
}

function normalizeIso(value) {
  if (!value) return '';
  const date = normalizeDate(value);
  return date ? date.toISOString() : '';
}

function normalizeDate(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? new Date(parsed) : null;
}

function requiresEvidence(event) {
  return ['forum_watch', 'game_activity', 'external_mcp', 'companion'].includes(event.kind);
}

function isQuietHour(now, env) {
  const start = boundedHour(env.PERSONAL_AGENT_PROACTIVE_SILENT_START_HOUR, 0);
  const end = boundedHour(env.PERSONAL_AGENT_PROACTIVE_SILENT_END_HOUR, 9);
  if (start === end) return false;
  let hour;
  try {
    hour = Number(new Intl.DateTimeFormat('en-GB', {
      timeZone: String(env.HERMES_ENVIRONMENT_TIMEZONE || 'Asia/Shanghai'),
      hour: '2-digit', hourCycle: 'h23',
    }).format(now));
  } catch {
    return true;
  }
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

function boundedHour(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 23 ? parsed : fallback;
}

function hasTrustedEvidence(event, action) {
  const actionRefs = normalizeRefs(action.evidence_refs || action.evidenceRefs || []);
  if (!actionRefs.length) return false;
  const eventRefs = new Set(event.evidence_refs || []);
  return actionRefs.some((item) => eventRefs.has(item));
}

function containsToolTrace(message) {
  return /```|<tool|<\/tool>|tool_call|arguments?\s*[:=]|observation\s*[:=]/i.test(message);
}

function isGenericProactiveMessage(message) {
  const normalized = String(message || '').trim().replace(/\s+/g, '');
  if (!normalized) return true;
  const blockedPatterns = [
    /刚想到你最近挺忙的[，,。]?今天?还顺吗[。？?]?$/,
    /最近忙吗[。？?]?$/,
    /你最近还好吗[。？?]?$/,
    /我想起你了[。！!]?$/,
    /只是想来看看你[。！!]?$/,
  ];
  return blockedPatterns.some((pattern) => pattern.test(normalized));
}

function sanitizeId(value) {
  return String(value || '')
    .trim()
    .replace(/[\r\n\t]/g, ' ')
    .replace(/[^a-zA-Z0-9_.:-]/g, '')
    .slice(0, 160);
}

function sanitizeScope(value) {
  return String(value || '')
    .trim()
    .replace(/[\r\n\t]/g, ' ')
    .replace(/[^a-zA-Z0-9_.:/-]/g, '')
    .slice(0, 180);
}

function sanitizeRef(value) {
  return String(value || '')
    .trim()
    .replace(/[\r\n\t]/g, ' ')
    .replace(/[^a-zA-Z0-9_.:/-]/g, '')
    .slice(0, 180);
}

function sanitizeText(value) {
  return String(value || '')
    .replace(/cookie\s*=\s*[^ ]+/gi, 'cookie=[redacted]')
    .replace(/token\s*=\s*[^ ]+/gi, 'token=[redacted]')
    .replace(/session[-_\w]*\s*=\s*[^ ]+/gi, 'session=[redacted]')
    .replace(/sk-[a-z0-9_-]{8,}/gi, '[redacted-secret]')
    .replace(/xox[baprs]-[a-z0-9_-]+/gi, '[redacted-secret]')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, 500);
}
