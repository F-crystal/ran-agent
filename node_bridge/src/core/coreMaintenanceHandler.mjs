import { coreError } from './coreErrors.mjs';

function requestFor(payloadRef) {
  if (payloadRef === 'system-task:life-loop') return ['/tools/life-loop/state', {}];
  if (/^system-task:knowledge-(?:06|12|18|23)$/.test(payloadRef)) {
    return ['/tools/knowledge/run', { action: 'auto', trigger: 'core_schedule' }];
  }
  if (payloadRef === 'system-task:daily-carryover') {
    return ['/tools/knowledge/run', { action: 'daily_carryover', trigger: 'core_schedule' }];
  }
  if (payloadRef === 'system-task:self-reflection') return ['/tools/reflection/run', {}];
  if (payloadRef === 'system-task:hermes-bounded-context') return ['/tools/memory/maintain', {}];
  if (payloadRef === 'system-task:night-cycle') return ['/tools/night-cycle/run', {}];
  return null;
}

export function createPythonCoreMaintenanceHandler({
  env = process.env,
  fetchImpl = globalThis.fetch,
  hashContent,
  timeoutMs = 120_000,
} = {}) {
  if (typeof fetchImpl !== 'function' || typeof hashContent !== 'function') {
    throw coreError('CORE_MAINTENANCE_DEPENDENCY_INVALID', 'Core maintenance requires Python HTTP and a content hasher');
  }
  const baseUrl = String(env.PYTHON_BACKEND_BASE_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
  const handler = async ({ work }) => {
    const request = requestFor(work.payload_ref);
    if (!request) throw coreError('CORE_MAINTENANCE_TASK_UNSUPPORTED', 'system maintenance task has no owner');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(`${baseUrl}${request[0]}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request[1]), signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!response?.ok) throw coreError('CORE_MAINTENANCE_REQUEST_FAILED', 'Python maintenance request failed');
    const result = await response.json();
    const resultRef = `python-maintenance:${work.payload_ref}:${work.work_run_id}`;
    return Object.freeze({
      resultRef,
      resultHashToken: hashContent('python-maintenance-result', JSON.stringify(result)),
    });
  };
  handler.canHandle = (work) => requestFor(work?.payload_ref) !== null;
  return handler;
}
