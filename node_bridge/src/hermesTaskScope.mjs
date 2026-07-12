const TASK_SCOPED_ROUTE_HINTS = Object.freeze([
  'scheduled_ai_daily_digest',
  'manual_ai_daily_digest',
  'action_gate_repair',
  'release_runtime_journey',
  'hermes_proactive_event',
  'external_mcp_system_queue',
]);

const TASK_SCOPED_ROUTE_SET = new Set(TASK_SCOPED_ROUTE_HINTS);

export function normalizeHermesTaskKind(routeHint = '') {
  const normalized = String(routeHint || '').trim();
  return TASK_SCOPED_ROUTE_SET.has(normalized) ? normalized : '';
}

export function isHermesTaskScopedRoute(routeHint = '') {
  return Boolean(normalizeHermesTaskKind(routeHint));
}

export function listHermesTaskScopedRoutes() {
  return [...TASK_SCOPED_ROUTE_HINTS];
}
