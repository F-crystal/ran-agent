import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isHermesTaskScopedRoute,
  listHermesTaskScopedRoutes,
  normalizeHermesTaskKind,
} from '../src/hermesTaskScope.mjs';

test('Hermes task scope is a closed shared route registry', () => {
  assert.deepEqual(listHermesTaskScopedRoutes(), [
    'scheduled_ai_daily_digest',
    'manual_ai_daily_digest',
    'action_gate_repair',
    'release_runtime_journey',
    'hermes_proactive_event',
    'external_mcp_system_queue',
  ]);
  for (const route of listHermesTaskScopedRoutes()) {
    assert.equal(isHermesTaskScopedRoute(route), true);
    assert.equal(normalizeHermesTaskKind(route), route);
  }
  assert.equal(isHermesTaskScopedRoute('ordinary_chat'), false);
  assert.equal(normalizeHermesTaskKind(' ordinary_chat '), '');
});
