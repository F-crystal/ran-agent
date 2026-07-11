import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { readHermesLiteMaintenanceState } from '../src/hermesSessionMaintenance.mjs';
import { appendTurn, readTimelineRecords } from '../src/globalTimeline.mjs';
import { listPendingActions } from '../src/pendingActionState.mjs';
import { reserveProactiveEventDelivery } from '../src/proactiveEventLedger.mjs';
import { createIsolatedTestEnv } from './helpers/isolatedState.mjs';

function corruptFile(target, content = '{') {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function assertQuarantined(target) {
  assert.equal(fs.existsSync(target), false);
  assert.equal(
    fs.readdirSync(path.dirname(target)).some((entry) => entry.startsWith(`${path.basename(target)}.corrupt-`)),
    true,
  );
}

test('pending-action corruption fails closed instead of becoming no authorization state', (t) => {
  const env = createIsolatedTestEnv(t, {}, 'critical-pending-');
  const target = path.join(env.RAN_AGENT_STATE_DIR, 'action_contract', 'pending_actions_index.json');
  corruptFile(target);
  assert.throws(() => listPendingActions({ env }), (error) => error?.code === 'RAN_AGENT_STATE_CORRUPT');
  assertQuarantined(target);
});

test('proactive reservation corruption fails closed instead of losing sent dedupe', (t) => {
  const env = createIsolatedTestEnv(t, {}, 'critical-proactive-');
  const target = path.join(env.RAN_AGENT_STATE_DIR, 'node-bridge-runtime', 'proactive-events.json');
  corruptFile(target, '[{"status":"sent"}, null]');
  assert.throws(
    () => reserveProactiveEventDelivery({ event_id: 'evt-1', dedupe_key: 'scope-1' }, { env }),
    (error) => error?.code === 'RAN_AGENT_STATE_CORRUPT',
  );
  assertQuarantined(target);
});

test('lite maintenance pointer corruption fails closed instead of resetting session truth', (t) => {
  const env = createIsolatedTestEnv(t, {}, 'critical-maintenance-');
  const stateFile = path.join(env.RAN_AGENT_STATE_DIR, 'hermes', 'session_maintenance.json');
  corruptFile(stateFile, '{"version":2,"profile":"lite"}');
  assert.throws(
    () => readHermesLiteMaintenanceState({ stateFile, digestDir: path.dirname(stateFile) }),
    (error) => error?.code === 'RAN_AGENT_STATE_CORRUPT',
  );
  assertQuarantined(stateFile);
});

test('timeline event keys dedupe append and survive replay', (t) => {
  const env = createIsolatedTestEnv(t, {}, 'critical-timeline-dedupe-');
  const timelinePath = path.join(env.RAN_AGENT_STATE_DIR, 'timeline.jsonl');
  const input = {
    env: { ...env, RAN_AGENT_TIMELINE_COMPACT_ENABLED: 'false' },
    timelinePath,
    event_key: 'outbox:one',
    platform: 'wechat',
    conversation_id: 'conv',
    sender_id: 'sender',
    role: 'assistant',
    text: '只记一次',
    created_at: 1,
  };
  const first = appendTurn(input);
  const replay = appendTurn({ ...input, id: 'forged-replay-id', created_at: 2 });
  assert.equal(replay.id, first.id);
  assert.equal(readTimelineRecords({ timelinePath }).length, 1);
  assert.equal(readTimelineRecords({ timelinePath })[0].event_key, 'outbox:one');
});

test('timeline rejects interior corruption but repairs one incomplete final tail', (t) => {
  const env = createIsolatedTestEnv(t, {}, 'critical-timeline-tail-');
  const timelinePath = path.join(env.RAN_AGENT_STATE_DIR, 'timeline.jsonl');
  const valid = JSON.stringify({ id: 'turn-1', role: 'user', created_at: 1, text: 'ok' });
  corruptFile(timelinePath, `${valid}\n{"id":"partial"`);
  assert.deepEqual(readTimelineRecords({ timelinePath }).map((record) => record.id), ['turn-1']);
  assert.equal(fs.readFileSync(timelinePath, 'utf8'), `${valid}\n`);

  corruptFile(timelinePath, `${valid}\n{broken}\n`);
  assert.throws(
    () => readTimelineRecords({ timelinePath }),
    (error) => error?.code === 'RAN_AGENT_TIMELINE_CORRUPT',
  );
  assertQuarantined(timelinePath);
});

test('timeline validates existing state before ordinary append even when compaction is disabled', (t) => {
  const env = createIsolatedTestEnv(t, {
    RAN_AGENT_TIMELINE_COMPACT_ENABLED: 'false',
  }, 'critical-timeline-append-');
  const timelinePath = path.join(env.RAN_AGENT_STATE_DIR, 'timeline.jsonl');
  corruptFile(timelinePath, '{broken}\n');

  assert.throws(
    () => appendTurn({
      env,
      timelinePath,
      platform: 'wechat',
      conversation_id: 'conv',
      sender_id: 'sender',
      role: 'user',
      text: 'must not append after corrupt state',
      created_at: 2,
    }),
    (error) => error?.code === 'RAN_AGENT_TIMELINE_CORRUPT',
  );
  assertQuarantined(timelinePath);
});
