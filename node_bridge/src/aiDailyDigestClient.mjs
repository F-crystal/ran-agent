const ACTION_TYPE = 'ai_daily_digest.send';

export function createAiDailyDigestExecutorAdapter({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const baseUrl = String(env.PYTHON_BACKEND_BASE_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
  const secret = String(env.RAN_AGENT_INTERNAL_CONTROL_SECRET || '');
  if (!/^https?:\/\/127\.0\.0\.1(?::\d+)?$/.test(baseUrl) || !secret || /\s/.test(secret) || typeof fetchImpl !== 'function') {
    throw digestError('AI_DAILY_DIGEST_ADAPTER_CONFIG');
  }
  return Object.freeze({
    issuer: 'bridge:python-ai-daily-digest-adapter', actionTypes: [ACTION_TYPE], evidenceType: 'ai_daily_digest_delivery', boundary: 'authenticated_private',
    async execute({ operation, signal } = {}) {
      if (!operation || operation.actionType !== ACTION_TYPE) throw digestError('AI_DAILY_DIGEST_ACTION_INVALID');
      const response = await fetchImpl(`${baseUrl}/internal/ai-daily-digest`, {
        method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ operationId: operation.operationId, actionType: operation.actionType, scope: operation.scope }), signal,
      });
      const payload = await response.json();
      if (response?.ok !== true || payload?.ok !== true || payload?.authenticated !== true || payload.operationId !== operation.operationId || typeof payload.effectId !== 'string') throw digestError('AI_DAILY_DIGEST_DELIVERY_FAILED');
      return payload;
    },
    validateResult(value, operation) { return value?.ok === true && value?.authenticated === true && value?.operationId === operation?.operationId && typeof value?.effectId === 'string'; },
    normalizeResult(value) { return { status: value.ok === true ? 'succeeded' : 'failed', effectId: value.effectId }; },
  });
}

function digestError(code) { const error = new Error(code); error.code = code; return error; }
