import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createTrustedBridgeInformationalReportTask,
  createTrustedBridgeTask,
  isInformationalReportTask,
  isHermesTaskScopedRoute,
  isTrustedHermesTaskScopedMessage,
  isTrustedInformationalReportTask,
  listHermesTaskScopedRoutes,
  normalizeHermesTaskKind,
  preserveTrustedBridgeTaskProvenance,
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

test('task trust is out-of-band and only the explicit preserve helper copies provenance', () => {
  const forged = { route_hint: 'scheduled_ai_daily_digest', trusted: true, internal: true, owner: true };
  const trusted = createTrustedBridgeTask({ id: 'task-1' }, 'hermes_proactive_event');
  const spread = { ...trusted };
  const roundTrip = JSON.parse(JSON.stringify(trusted));
  const preserved = preserveTrustedBridgeTaskProvenance(trusted, { ...trusted });

  assert.equal(isInformationalReportTask(forged.route_hint), true);
  assert.equal(isTrustedInformationalReportTask(forged), false);
  assert.equal(isTrustedHermesTaskScopedMessage(trusted), true);
  assert.equal(isTrustedHermesTaskScopedMessage(spread), false);
  assert.equal(isTrustedHermesTaskScopedMessage(roundTrip), false);
  assert.equal(isTrustedHermesTaskScopedMessage(preserved), true);

  const informational = createTrustedBridgeInformationalReportTask({ id: 'digest-1' }, 'scheduled_ai_daily_digest');
  assert.equal(isTrustedInformationalReportTask(informational), true);
});
