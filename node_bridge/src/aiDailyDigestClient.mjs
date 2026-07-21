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
      let response;
      try {
        response = await fetchImpl(`${baseUrl}/internal/ai-daily-digest`, {
          method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ operationId: operation.operationId, actionType: operation.actionType, scope: operation.scope }), signal,
        });
      } catch (error) {
        return outcome(operation, isKnownPreDispatchFailure(error) ? 'failed' : 'ambiguous');
      }
      let payload;
      try {
        payload = await response.json();
      } catch {
        return outcome(operation, 'ambiguous');
      }
      if (response?.ok === true && payload?.ok === true && payload?.authenticated === true
        && payload.operationId === operation.operationId && typeof payload.effectId === 'string') {
        return { ...outcome(operation, 'succeeded'), effectId: payload.effectId };
      }
      return outcome(operation, 'failed');
    },
    validateResult(value, operation) {
      return value?.nodeOwned === true && value?.operationId === operation?.operationId
        && ['succeeded', 'failed', 'ambiguous'].includes(value?.status)
        && typeof value?.effectId === 'string';
    },
    normalizeResult(value) {
      return { status: value.status, effectId: value.effectId, summary: value.summary, target: value.target, retryable: value.retryable };
    },
  });
}

function outcome(operation, status) {
  const summary = status === 'succeeded'
    ? '今日日报已补发。'
    : status === 'ambiguous'
      ? '日报发送请求已经发出，但当前无法确认是否送达。'
      : '日报生成或发送失败，未确认送达。';
  return {
    nodeOwned: true,
    operationId: operation.operationId,
    status,
    effectId: `${operation.operationId}:${status}`,
    summary,
    target: 'daily-report:current-local-date',
    retryable: status === 'failed',
  };
}

function isKnownPreDispatchFailure(error) {
  const code = String(error?.code || '').toUpperCase();
  return ['ECONNREFUSED', 'EACCES', 'EPERM', 'ENOENT'].includes(code);
}

function digestError(code) { const error = new Error(code); error.code = code; return error; }
