/**
 * Optional backend ingest client (timeline/session persistence only).
 */

export function getBackendIngestConfig(env = process.env) {
  return {
    enabled: String(env.PYTHON_BACKEND_INGEST_ENABLED || 'true').toLowerCase() === 'true',
    baseUrl: (env.PYTHON_BACKEND_BASE_URL || 'http://127.0.0.1:8787').replace(/\/$/, ''),
  };
}

export async function ingestExchangeToBackend(payload, options = {}) {
  const config = options.config || getBackendIngestConfig(options.env);
  if (!config.enabled) {
    return { ok: false, skipped: true, reason: 'disabled' };
  }

  const fetchImpl = options.fetchImpl || fetch;
  let response;
  try {
    response = await fetchImpl(`${config.baseUrl}/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`backend ingest request failed: ${message}`);
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
