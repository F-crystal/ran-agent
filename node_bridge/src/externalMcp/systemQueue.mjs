const ROUTE_HINT = 'external_mcp_system_queue';
const VALID_DELIVERABILITY = new Set(['silent_only', 'draft_allowed', 'notify_allowed']);
const VALID_TIERS = new Set(['T0', 'T1', 'T2', 'T3']);

export function buildExternalMcpSyntheticTurn(input = {}) {
  const deliverability = normalizeDeliverability(input.deliverability);
  const tiers = normalizeTiers(input.allowedCapabilityTiers || input.allowed_capability_tiers);
  const reason = sanitizeText(input.reason || '');
  const watchScope = sanitizeText(input.watchScope || input.watch_scope || '');
  const text = [
    '[External MCP system turn]',
    `reason: ${reason}`,
    `watch_scope: ${watchScope}`,
    `deliverability: ${deliverability}`,
    `allowed_capability_tiers: ${tiers.join(',') || 'T1'}`,
    'Hermes may stay silent, remember quietly, draft, or notify only if the evidence and deliverability allow it.',
  ].join('\n');
  return {
    id: sanitizeId(input.id || `external-mcp-${Date.now()}`),
    message_id: sanitizeId(input.id || `external-mcp-${Date.now()}`),
    platform: sanitizePlatform(input.platform || 'feishu'),
    channel_type: 'dm',
    conversation_id: sanitizeId(input.conversationId || input.conversation_id || ''),
    sender_id: sanitizeId(input.senderId || input.sender_id || ''),
    route_hint: ROUTE_HINT,
    text,
    media: [],
    created_at: Number(input.createdAt || input.created_at || Date.now()),
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
  return { suppress: false, reason: '' };
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
