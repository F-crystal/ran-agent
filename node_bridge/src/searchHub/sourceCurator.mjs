const SENSITIVE_QUERY_KEYS = /^(xsec_token|token|access_token|api_key|apikey|key|signature|sig|expires|expires_at|x-amz-signature|x-amz-credential|x-amz-security-token|x-oss-signature|authorization|auth|cookie|session|sessdata)$/i;
const TRACKING_QUERY_KEYS = /^(utm_|fbclid|gclid|yclid|mc_cid|mc_eid)/i;
const SENSITIVE_RAW_KEYS = /authorization|cookie|token|secret|api[_-]?key|xsec|signature|signed|sessdata/i;
const SENSITIVE_WARNING = /\b(api[_-]?key|authorization|cookie|token|xsec[_-]?token|sessdata|x-amz-signature|signed url)\b|bearer\s+[a-z0-9._-]+/i;

export function redactSensitiveUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY_KEYS.test(key) || TRACKING_QUERY_KEYS.test(key)) {
        url.searchParams.delete(key);
      }
    }
    url.hash = '';
    return url.toString();
  } catch {
    return raw.replace(/([?&](?:xsec_token|token|signature|sig|api_key|key|Expires|X-Amz-Signature)=)[^&\s]+/gi, '');
  }
}

function sanitizeRaw(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const clean = {};
  for (const [key, value] of Object.entries(raw)) {
    if (SENSITIVE_RAW_KEYS.test(key)) continue;
    if (typeof value === 'string' && SENSITIVE_WARNING.test(value)) continue;
    clean[key] = value;
  }
  return clean;
}

export function normalizeSearchResult(input = {}) {
  const title = String(input.title || input.name || input.headline || '').trim();
  const url = redactSensitiveUrl(input.url || input.link || input.href || '');
  const snippet = String(input.snippet || input.summary || input.description || '').trim();
  const content = String(input.content || input.text || '').trim();
  const source = String(input.source || input.site || hostnameFromUrl(url) || '').trim();
  const provider = String(input.provider || 'unknown').trim() || 'unknown';
  const confidence = clampNumber(input.confidence, 0, 1, defaultConfidenceForProvider(provider));
  return {
    title: title || url || 'Untitled',
    url,
    source,
    published_at: String(input.published_at || input.publishedAt || input.date || '').trim(),
    snippet,
    content,
    provider,
    confidence,
    needs_read: input.needs_read === true || (!content && Boolean(url)),
    raw: sanitizeRaw(input.raw || {}),
  };
}

export function curateSearchResults(items = [], options = {}) {
  const limit = Math.max(1, Number.parseInt(String(options.limit || '10'), 10) || 10);
  const warnings = sanitizeWarnings(options.warnings || []);
  const byUrl = new Map();
  const urlOrder = [];
  for (const item of Array.isArray(items) ? items : []) {
    const normalized = normalizeSearchResult(item);
    const key = normalized.url ? normalizeUrlKey(normalized.url) : `title:${normalized.title.toLowerCase()}`;
    const existing = byUrl.get(key);
    if (!existing || normalized.confidence >= existing.confidence) {
      byUrl.set(key, normalized);
      if (!existing) urlOrder.push(key);
    }
  }
  const curated = urlOrder
    .map((key) => byUrl.get(key))
    .filter(Boolean)
    .sort((a, b) => b.confidence - a.confidence || providerRank(b.provider) - providerRank(a.provider))
    .slice(0, limit);
  return {
    items: curated,
    warnings,
  };
}

export function mergeProviderResults(results = [], options = {}) {
  const items = [];
  const used = [];
  const warnings = [];
  for (const result of results) {
    if (!result) continue;
    if (Array.isArray(result.items)) items.push(...result.items);
    if (Array.isArray(result.used_providers)) used.push(...result.used_providers);
    if (Array.isArray(result.warnings)) warnings.push(...result.warnings);
  }
  const curated = curateSearchResults(items, { ...options, warnings });
  return {
    items: curated.items,
    used_providers: [...new Set(used)],
    warnings: curated.warnings,
  };
}

export function sanitizeWarnings(warnings = []) {
  return [...new Set((Array.isArray(warnings) ? warnings : [warnings])
    .map((warning) => String(warning || '').trim())
    .filter(Boolean)
    .map((warning) => (SENSITIVE_WARNING.test(warning) ? 'REDACTED_SENSITIVE_WARNING' : warning)))];
}

function normalizeUrlKey(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    if (parsed.pathname.endsWith('/') && parsed.pathname !== '/') {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }
    return parsed.toString().toLowerCase();
  } catch {
    return String(url || '').toLowerCase();
  }
}

function hostnameFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function defaultConfidenceForProvider(provider) {
  if (provider === 'aihot') return 0.92;
  if (provider === 'opencli') return 0.82;
  if (provider === 'tavily') return 0.74;
  if (provider === 'social_reader') return 0.78;
  if (provider === 'playwright') return 0.62;
  return 0.5;
}

function providerRank(provider) {
  return {
    aihot: 5,
    opencli: 4,
    tavily: 3,
    social_reader: 2,
    playwright: 1,
  }[provider] || 0;
}
