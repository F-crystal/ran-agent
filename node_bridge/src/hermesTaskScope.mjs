const TASK_SCOPED_ROUTE_HINTS = Object.freeze([
  'scheduled_ai_daily_digest',
  'manual_ai_daily_digest',
  'action_gate_repair',
  'release_runtime_journey',
  'hermes_proactive_event',
  'external_mcp_system_queue',
]);

const TASK_SCOPED_ROUTE_SET = new Set(TASK_SCOPED_ROUTE_HINTS);
const INFORMATIONAL_REPORT_TASK_ROUTE_SET = new Set([
  'scheduled_ai_daily_digest',
  'manual_ai_daily_digest',
]);
const TRUSTED_BRIDGE_TASKS = new WeakMap();

export function normalizeHermesTaskKind(routeHint = '') {
  const normalized = String(routeHint || '').trim();
  return TASK_SCOPED_ROUTE_SET.has(normalized) ? normalized : '';
}

export function isHermesTaskScopedRoute(routeHint = '') {
  return Boolean(normalizeHermesTaskKind(routeHint));
}

export function isInformationalReportTask(routeHint = '') {
  return INFORMATIONAL_REPORT_TASK_ROUTE_SET.has(normalizeHermesTaskKind(routeHint));
}

export function createTrustedBridgeInformationalReportTask(message = {}, routeHint = '') {
  const kind = normalizeHermesTaskKind(routeHint);
  if (!INFORMATIONAL_REPORT_TASK_ROUTE_SET.has(kind)) {
    throw new Error('trusted informational report task kind is invalid');
  }
  const task = Object.freeze({ ...message, route_hint: kind });
  TRUSTED_BRIDGE_TASKS.set(task, kind);
  return task;
}

export function preserveTrustedBridgeTaskProvenance(source = {}, target = {}) {
  const kind = TRUSTED_BRIDGE_TASKS.get(source);
  if (kind && normalizeHermesTaskKind(target.route_hint) === kind) {
    TRUSTED_BRIDGE_TASKS.set(target, kind);
  }
  return target;
}

export function isTrustedInformationalReportTask(message = {}) {
  const kind = normalizeHermesTaskKind(message?.route_hint);
  return INFORMATIONAL_REPORT_TASK_ROUTE_SET.has(kind) && TRUSTED_BRIDGE_TASKS.get(message) === kind;
}

export function listHermesTaskScopedRoutes() {
  return [...TASK_SCOPED_ROUTE_HINTS];
}
