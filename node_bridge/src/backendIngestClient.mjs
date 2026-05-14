/**
 * Optional backend ingest client (timeline/session persistence only).
 */

export function getBackendIngestConfig(env = process.env) {
  return {
    enabled: String(env.PYTHON_BACKEND_INGEST_ENABLED || 'true').toLowerCase() === 'true',
    baseUrl: (env.PYTHON_BACKEND_BASE_URL || 'http://127.0.0.1:8787').replace(/\/$/, ''),
    timeoutMs: parsePositiveInt(env.PYTHON_BACKEND_INGEST_TIMEOUT_MS, 5000),
  };
}

export async function ingestExchangeToBackend(payload, options = {}) {
  const config = options.config || getBackendIngestConfig(options.env);
  if (!config.enabled) {
    return { ok: false, skipped: true, reason: 'disabled' };
  }

  const fetchImpl = options.fetchImpl || fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  let response;
  try {
    response = await fetchImpl(`${config.baseUrl}/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`backend ingest request failed: ${message}`);
  } finally {
    clearTimeout(timeout);
  }

  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error('backend ingest returned invalid JSON');
  }

  if (!response.ok || body?.ok !== true) {
    const errorText = typeof body?.error === 'string' ? body.error : `HTTP ${response.status}`;
    throw new Error(`backend ingest error: ${errorText}`);
  }

  return body;
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
