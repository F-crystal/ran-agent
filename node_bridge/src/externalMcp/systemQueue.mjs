import {
  buildProactiveSyntheticTurn,
  evaluateProactiveEgress,
  normalizeProactiveEvent,
  parseHermesProactiveAction,
} from '../proactiveEvents.mjs';

const ROUTE_HINT = 'external_mcp_system_queue';
const VALID_DELIVERABILITY = new Set(['silent_only', 'draft_allowed', 'notify_allowed']);
const VALID_TIERS = new Set(['T0', 'T1', 'T2', 'T3']);

export function buildExternalMcpSyntheticTurn(input = {}) {
  const normalizedKind = inferExternalMcpKind(input.kind || input.watchKind || input.watch_kind);
  const event = input.proactiveEvent || normalizeProactiveEvent({ ...input, kind: normalizedKind }, {
    kind: normalizedKind,
    eventId: input.id,
    globalUserId: input.globalUserId || input.global_user_id || input.senderId || input.sender_id,
    watchScope: input.watchScope || input.watch_scope,
    reason: input.reason,
    evidenceRefs: input.evidenceRefs || input.evidence_refs,
    deliverability: input.deliverability,
    allowedCapabilityTiers: input.allowedCapabilityTiers || input.allowed_capability_tiers,
    budgetClass: 'external_mcp',
  }).event;
  const turn = buildProactiveSyntheticTurn(event, {
    conversation_id: input.conversationId || input.conversation_id,
    sender_id: input.senderId || input.sender_id,
  });
  return {
    ...turn,
    id: sanitizeId(input.id || event?.event_id || `external-mcp-${Date.now()}`),
    message_id: sanitizeId(input.id || event?.event_id || `external-mcp-${Date.now()}`),
    platform: sanitizePlatform(input.platform || turn.platform || 'feishu'),
    channel_type: 'dm',
    conversation_id: sanitizeId(input.conversationId || input.conversation_id || turn.conversation_id || ''),
    sender_id: sanitizeId(input.senderId || input.sender_id || turn.sender_id || ''),
    route_hint: ROUTE_HINT,
  };
}

export function shouldSuppressSystemQueueReply({ routeHint = '', replyText = '' } = {}) {
  if (String(routeHint || '').trim() !== ROUTE_HINT) return { suppress: false, reason: '' };
  const text = String(replyText || '').trim();
  if (!text) return { suppress: true, reason: 'empty' };
  if (/^(silent|静默|不发送)$/i.test(text)) return { suppress: true, reason: 'silent' };
  if (/^(remember|记住|记录)$/i.test(text)) return { suppress: true, reason: 'remember' };
  const parsed = parseJson(text);
  const action = String(parsed?.action || parsed?.type || '').trim().toLowerCase();
  if (action === 'silent') return { suppress: true, reason: 'silent' };
  if (action === 'remember') return { suppress: true, reason: 'remember' };
  if (action === 'draft') return { suppress: true, reason: 'draft_requires_confirmation' };
  if (action === 'notify') return { suppress: false, reason: '' };
  if (parsed) return { suppress: true, reason: 'unsupported_action' };
  return { suppress: true, reason: 'malformed_action' };
}

export function evaluateExternalMcpSystemQueueEgress({ event, replyText, env } = {}) {
  return evaluateProactiveEgress({ event, replyText, env });
}

export function parseExternalMcpSystemQueueAction(replyText) {
  return parseHermesProactiveAction(replyText);
}

export function externalMcpSystemQueueRouteHint() {
  return ROUTE_HINT;
}

function normalizeDeliverability(value) {
  const text = String(value || '').trim().toLowerCase();
  return VALID_DELIVERABILITY.has(text) ? text : 'silent_only';
}

function normalizeTiers(values) {
  const list = Array.isArray(values) ? values : values ? [values] : ['T1'];
  return list
    .map((item) => String(item || '').trim().toUpperCase())
    .filter((item) => VALID_TIERS.has(item))
    .slice(0, 4);
}

function inferExternalMcpKind(value) {
  const text = String(value || '').trim().toLowerCase();
  if (text === 'game') return 'game_activity';
  if (text === 'forum') return 'forum_watch';
  return 'external_mcp';
}

function parseJson(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function sanitizePlatform(value) {
  const text = String(value || '').trim().toLowerCase();
  return ['wechat', 'feishu', 'desktop'].includes(text) ? text : 'feishu';
}

function sanitizeId(value) {
  return String(value || '').trim().replace(/[\r\n\t]/g, ' ').replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 160);
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
    .slice(0, 240);
}
