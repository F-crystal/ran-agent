/** Private client for Python-authoritative durable Core jobs. */

const TERMINAL_STATES = Object.freeze(['completed', 'blocked', 'stopped', 'expired']);
const SAFE_KEY = /^[A-Za-z0-9_.:-]{8,160}$/;
const GOAL_DIGEST = /^[a-f0-9]{32,128}$/;
const VALID_STATUS = new Set(['active', ...TERMINAL_STATES]);
const REGISTERED_CORE_JOB_KINDS = new Set([
  'core.memory-maintenance',
  'core.reflection',
  'core.night-cycle',
  'core.external-activity',
]);

export function getDurableJobClientConfig(env = process.env) {
  return {
    baseUrl: String(env.PYTHON_BACKEND_BASE_URL || 'http://127.0.0.1:8787').replace(/\/$/, ''),
    secret: String(env.RAN_AGENT_INTERNAL_CONTROL_SECRET || ''),
    timeoutMs: positiveInt(env.DURABLE_JOB_CLIENT_TIMEOUT_MS, 5000),
  };
}

export async function createDurableJob(input = {}, options = {}) {
  const body = {
    actorKey: validKey(input.actorKey, 'actorKey'),
    goalDigest: validGoalDigest(input.goalDigest),
    jobKind: validCoreJobKind(input.jobKind),
    payloadRef: validRef(input.payloadRef, 'payloadRef'),
    nextRunAt: validTimestamp(input.nextRunAt),
  };
  return requestReceipt('/internal/durable-jobs', {
    ...options,
    method: 'POST',
    body,
  });
}

export async function queryDurableJob(jobId, options = {}) {
  const identifier = validKey(jobId, 'jobId');
  return requestReceipt(`/internal/durable-jobs/${encodeURIComponent(identifier)}`, {
    ...options,
    method: 'GET',
  });
}

export async function terminalizeDurableJob(jobId, input = {}, options = {}) {
  const identifier = validKey(jobId, 'jobId');
  const terminalState = String(input.terminalState || '').trim();
  if (!TERMINAL_STATES.includes(terminalState)) throw new Error('invalid durable job terminalState');
  return requestReceipt(`/internal/durable-jobs/${encodeURIComponent(identifier)}/terminal`, {
    ...options,
    method: 'POST',
    body: {
      terminalState,
      resultRef: validRef(input.resultRef, 'resultRef'),
    },
  });
}

export function normalizeDurableJobReceipt(value = {}) {
  try {
    const jobId = validKey(value.jobId, 'jobId');
    const actorKey = validKey(value.actorKey, 'actorKey');
    const goalDigest = validGoalDigest(value.goalDigest);
    const status = String(value.status || '').trim();
    const nextRunAt = validTimestamp(value.nextRunAt);
    if (!VALID_STATUS.has(status)
      || !Array.isArray(value.terminalStates)
      || value.terminalStates.length !== TERMINAL_STATES.length
      || value.terminalStates.some((item, index) => item !== TERMINAL_STATES[index])) {
      throw new Error('invalid');
    }
    return Object.freeze({
      jobId,
      actorKey,
      goalDigest,
      status,
      nextRunAt,
      terminalStates: Object.freeze([...TERMINAL_STATES]),
    });
  } catch {
    throw new Error('invalid durable job receipt');
  }
}

async function requestReceipt(pathname, options) {
  const config = options.config || getDurableJobClientConfig(options.env);
  const baseUrl = privateBaseUrl(config.baseUrl);
  const secret = String(config.secret || '');
  if (!secret || /\s/.test(secret)) throw new Error('private control secret is required');
  const fetchImpl = options.fetchImpl || fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), positiveInt(config.timeoutMs, 5000));
  let response;
  try {
    response = await fetchImpl(`${baseUrl}${pathname}`, {
      method: options.method,
      headers: {
        Authorization: `Bearer ${secret}`,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      signal: controller.signal,
    });
  } catch {
    throw new Error('durable job adapter request failed');
  } finally {
    clearTimeout(timeout);
  }
  if (!response?.ok) {
    throw new Error(`durable job adapter rejected request (HTTP ${Number(response?.status) || 0})`);
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error('durable job adapter returned invalid JSON');
  }
  if (payload?.ok !== true) throw new Error('durable job adapter returned an unsuccessful result');
  return normalizeDurableJobReceipt(payload.receipt);
}

function privateBaseUrl(value) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    throw new Error('durable job adapter base URL must be loopback');
  }
  const hostname = url.hostname.toLowerCase();
  const ipv4 = hostname.split('.');
  const loopbackV4 = ipv4.length === 4
    && ipv4[0] === '127'
    && ipv4.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
  if (!['http:', 'https:'].includes(url.protocol)
    || url.username || url.password || url.search || url.hash
    || (!loopbackV4 && hostname !== '[::1]' && hostname !== '::1')) {
    throw new Error('durable job adapter base URL must be loopback');
  }
  return url.toString().replace(/\/$/, '');
}

function validKey(value, field) {
  const text = String(value || '');
  if (text !== text.trim() || !SAFE_KEY.test(text)) throw new Error(`invalid durable job ${field}`);
  return text;
}

function validGoalDigest(value) {
  const text = String(value || '');
  if (!GOAL_DIGEST.test(text)) throw new Error('invalid durable job goalDigest');
  return text;
}

function validCoreJobKind(value) {
  const text = String(value || '');
  if (!REGISTERED_CORE_JOB_KINDS.has(text)) throw new Error('invalid durable job jobKind');
  return text;
}

function validRef(value, field) {
  const text = String(value || '');
  if (text !== text.trim() || !/^[A-Za-z0-9_.:/-]{1,240}$/.test(text)) {
    throw new Error(`invalid durable job ${field}`);
  }
  return text;
}

function validTimestamp(value) {
  const text = String(value || '').trim();
  if (!text || !Number.isFinite(Date.parse(text))) throw new Error('invalid durable job nextRunAt');
  return text;
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
