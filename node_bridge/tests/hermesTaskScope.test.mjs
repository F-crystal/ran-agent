import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createTrustedBridgeInformationalReportTask,
  isInformationalReportTask,
  isHermesTaskScopedRoute,
  isTrustedInformationalReportTask,
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

test('only AI digest routes are informational report tasks', () => {
  assert.equal(isInformationalReportTask('scheduled_ai_daily_digest'), true);
  assert.equal(isInformationalReportTask('manual_ai_daily_digest'), true);
  for (const route of listHermesTaskScopedRoutes()) {
    if (route === 'scheduled_ai_daily_digest' || route === 'manual_ai_daily_digest') continue;
    assert.equal(isInformationalReportTask(route), false, route);
  }
  assert.equal(isInformationalReportTask('ordinary_chat'), false);
});

test('informational report policy requires bridge-authored provenance in addition to its allowlisted task kind', () => {
  const forged = { route_hint: 'scheduled_ai_daily_digest' };
  const trusted = createTrustedBridgeInformationalReportTask({ id: 'digest-1' }, 'scheduled_ai_daily_digest');

  assert.equal(isInformationalReportTask(forged.route_hint), true);
  assert.equal(isTrustedInformationalReportTask(forged), false);
  assert.equal(isTrustedInformationalReportTask(trusted), true);
  assert.equal(isTrustedInformationalReportTask({ ...trusted }), false);
});
