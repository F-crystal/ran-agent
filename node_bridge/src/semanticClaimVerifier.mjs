const DEFAULT_FAILURE_NOTICE = '回复核验暂时失败，请稍后重试。';
const RECEIPT_FIELDS = new Set(['requestRef', 'actionType', 'outcome', 'status', 'effectDigest', 'errorCode']);

export function getSemanticVerifierConfig(env = process.env) {
  const requested = parseBoolean(env.HERMES_SEMANTIC_VERIFIER_ENABLED, false);
  const testOnlyBypass = String(process.env.NODE_TEST_CONTEXT || '').trim() === 'child-v8'
    && parseBoolean(env.HERMES_SEMANTIC_VERIFIER_TEST_BYPASS || process.env.HERMES_SEMANTIC_VERIFIER_TEST_BYPASS, false);
  const provider = String(env.HERMES_SEMANTIC_VERIFIER_PROVIDER || '').trim();
  const baseUrl = String(env.HERMES_SEMANTIC_VERIFIER_BASE_URL || '').trim().replace(/\/$/, '');
  const model = String(env.HERMES_SEMANTIC_VERIFIER_MODEL || '').trim();
  const contractValid = provider === 'openai-compatible'
    && isHttpUrl(baseUrl)
    && model.length > 0
    && model.length <= 160;
  return {
    requested,
    enabled: requested && contractValid,
    blockedReason: requested && !contractValid ? 'config_incomplete' : '',
    testOnlyBypass,
    testRuntime: testOnlyBypass,
    provider,
    baseUrl,
    model,
    apiKey: String(env.HERMES_SEMANTIC_VERIFIER_API_KEY || '').trim(),
    timeoutMs: boundedInteger(env.HERMES_SEMANTIC_VERIFIER_TIMEOUT_MS, 4_000, 100, 30_000),
    maxConcurrency: boundedInteger(env.HERMES_SEMANTIC_VERIFIER_MAX_CONCURRENCY, 4, 1, 32),
    maxRewriteChars: boundedInteger(env.HERMES_SEMANTIC_VERIFIER_MAX_REWRITE_CHARS, 600, 40, 2_000),
  };
}

export async function verifySemanticClaims({
  envelope,
  receiptSummaries = [],
  config = getSemanticVerifierConfig(),
  verifierImpl = callVerifierEndpoint,
  fetchImpl = fetch,
} = {}) {
  const message = String(envelope?.message || '');
  if (!hasDeclarations(envelope)) {
    return { ok: true, status: 'not_required', releaseText: message, unsupportedClaims: [], excludeFromHistory: false };
  }
  if (config.enabled !== true) {
    if (config.testOnlyBypass === true && config.testRuntime === true && isNodeTestRuntime()) {
      return { ok: true, status: 'test_bypass', releaseText: message, unsupportedClaims: [], excludeFromHistory: false };
    }
    return {
      ok: false,
      status: String(config.blockedReason || 'semantic_verifier_unavailable'),
      releaseText: DEFAULT_FAILURE_NOTICE,
      unsupportedClaims: [],
      excludeFromHistory: true,
    };
  }
  const input = {
    message,
    declarationTypes: declarationTypes(envelope),
    receiptSummaries: sanitizeReceiptSummaries(receiptSummaries),
  };
  try {
    const raw = await withTimeout(
      Promise.resolve(verifierImpl(input, { config, fetchImpl })),
      Number(config.timeoutMs) || 4_000,
    );
    const verdict = normalizeVerdict(raw);
    if (verdict.supported) {
      return { ok: true, status: 'supported', releaseText: message, unsupportedClaims: [], excludeFromHistory: false };
    }
    const rewrite = verdict.rewrite.slice(0, Math.max(40, Number(config.maxRewriteChars) || 600)).trim();
    if (!rewrite) throw verifierError('SEMANTIC_VERIFIER_BAD_JSON', 'unsupported verdict requires rewrite');
    return {
      ok: true,
      status: 'rewritten',
      releaseText: rewrite,
      unsupportedClaims: verdict.unsupportedClaims,
      excludeFromHistory: false,
    };
  } catch (error) {
    return {
      ok: false,
      status: normalizeErrorCode(error),
      releaseText: DEFAULT_FAILURE_NOTICE,
      unsupportedClaims: [],
      excludeFromHistory: true,
    };
  }
}

async function callVerifierEndpoint(input, { config, fetchImpl }) {
  if (!config.baseUrl || !config.model) throw verifierError('SEMANTIC_VERIFIER_CONFIG', 'verifier endpoint is not configured');
  const response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        {
          role: 'system',
          content: 'Check whether every declared claim or commitment is supported by the sanitized receipts. Return strict JSON only.',
        },
        { role: 'user', content: JSON.stringify(input) },
      ],
      temperature: 0,
      response_format: { type: 'json_object' },
    }),
  });
  if (!response.ok) throw verifierError('SEMANTIC_VERIFIER_HTTP', `verifier HTTP ${response.status}`);
  const payload = await response.json();
  return payload?.choices?.[0]?.message?.content;
}

function normalizeVerdict(raw) {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      throw verifierError('SEMANTIC_VERIFIER_BAD_JSON', 'verifier returned invalid JSON');
    }
  }
  if (!isPlainObject(value)) throw verifierError('SEMANTIC_VERIFIER_BAD_JSON', 'verifier verdict must be an object');
  const keys = Object.keys(value);
  if (keys.some((key) => !['supported', 'unsupportedClaims', 'rewrite'].includes(key))) {
    throw verifierError('SEMANTIC_VERIFIER_BAD_JSON', 'verifier verdict has unknown fields');
  }
  if (typeof value.supported !== 'boolean' || !Array.isArray(value.unsupportedClaims)) {
    throw verifierError('SEMANTIC_VERIFIER_BAD_JSON', 'verifier verdict is incomplete');
  }
  const unsupportedClaims = value.unsupportedClaims.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 32);
  if (value.supported === true && unsupportedClaims.length > 0) {
    throw verifierError('SEMANTIC_VERIFIER_DISAGREEMENT', 'verifier verdict disagrees with itself');
  }
  return {
    supported: value.supported,
    unsupportedClaims,
    rewrite: typeof value.rewrite === 'string' ? value.rewrite : '',
  };
}

function declarationTypes(envelope) {
  return [
    ...(Array.isArray(envelope?.claims) ? envelope.claims : []).map((item) => `claim:${item.type}`),
    ...(Array.isArray(envelope?.commitments) ? envelope.commitments : []).map((item) => `commitment:${item.type}`),
  ].slice(0, 64);
}

function hasDeclarations(envelope) {
  return declarationTypes(envelope).length > 0;
}

function sanitizeReceiptSummaries(items) {
  return (Array.isArray(items) ? items : []).slice(0, 32).map((item) => {
    if (!isPlainObject(item)) return {};
    return Object.fromEntries(
      Object.entries(item)
        .filter(([key]) => RECEIPT_FIELDS.has(key))
        .map(([key, value]) => [key, String(value ?? '').slice(0, 240)]),
    );
  });
}

function withTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(verifierError('SEMANTIC_VERIFIER_TIMEOUT', 'verifier timed out')), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function parseBoolean(value, fallback) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(normalized);
}

function isNodeTestRuntime() {
  return String(process.env.NODE_TEST_CONTEXT || '').trim() === 'child-v8';
}

function boundedInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function isHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function verifierError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeErrorCode(error) {
  const code = String(error?.code || 'SEMANTIC_VERIFIER_FAILURE').trim();
  return code.toLowerCase();
}
