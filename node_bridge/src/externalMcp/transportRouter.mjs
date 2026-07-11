export function createExternalMcpTransportRouter({ gatewayCall, directCall } = {}) {
  const calls = { gateway: gatewayCall, direct: directCall };
  return {
    async execute(input = {}) {
      const preferred = input.preferredTransport === 'direct' ? 'direct' : 'gateway';
      const alternate = preferred === 'gateway' ? 'direct' : 'gateway';
      const request = deepFreeze({
        operationId: String(input.operationId || ''), manifest: cloneValue(input.manifest || {}), tool: cloneValue(input.tool || {}),
        arguments: cloneValue(input.arguments && typeof input.arguments === 'object' ? input.arguments : {}),
        sessionId: String(input.session?.sessionId || input.sessionId || ''),
        // Only the gateway service may copy a trusted session's opaque
        // upstream token into this internal router argument.
        upstreamSessionId: String(input.upstreamSessionId || ''),
        globalUserId: String(input.session?.globalUserId || input.globalUserId || ''), scopeDigest: String(input.scopeDigest || ''),
        riskDigest: String(input.riskDigest || ''), evidenceContext: cloneValue(input.evidenceContext || {}),
      });
      const attempts = [];
      const first = await call(calls[preferred], preferred, request, attempts, input.signal);
      if (first.ok) return { ...first, attempts };
      if (input.effect !== 'read') {
        const outcome = first.outcome === 'not_applied' ? 'not_applied' : 'unknown';
        return { ...first, outcome, retryAllowed: outcome === 'not_applied', needsReconciliation: outcome === 'unknown', attempts };
      }
      if (!isKnownReadFailure(first)) return { ...first, attempts };
      const second = await call(calls[alternate], alternate, request, attempts, input.signal);
      return { ...second, attempts };
    },
  };
}

async function call(fn, route, request, attempts, signal) {
  let result;
  try {
    result = typeof fn === 'function'
      ? await fn(signal ? { ...request, signal } : request)
      : { ok: false, error_code: 'EXTERNAL_MCP_TRANSPORT_UNAVAILABLE' };
  } catch (error) {
    result = { ok: false, error: String(error?.message || error), error_code: String(error?.code || 'EXTERNAL_MCP_TRANSPORT_FAILED') };
  }
  const normalized = result && typeof result === 'object' ? result : { ok: false, error_code: 'EXTERNAL_MCP_TRANSPORT_FAILED' };
  attempts.push({ route, outcome: normalized.ok ? 'applied' : normalized.outcome || outcomeForError(normalized.error_code) });
  return { ...normalized, route };
}

function outcomeForError(code) {
  return String(code || '') === 'REMOTE_REJECTED' ? 'not_applied' : 'unknown';
}

function isKnownReadFailure(result) {
  return new Set([
    'EXTERNAL_MCP_TRANSPORT_FAILED', 'EXTERNAL_MCP_HTTP_ERROR', 'EXTERNAL_MCP_SESSION_LOST',
    'EXTERNAL_MCP_JSONRPC_ERROR',
  ]).has(String(result.error_code || result.errorCode || ''));
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function cloneValue(value) {
  try {
    return structuredClone(value);
  } catch {
    return {};
  }
}
