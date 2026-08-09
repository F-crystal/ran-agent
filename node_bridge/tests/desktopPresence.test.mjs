import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { createDesktopPresenceProvider } from '../src/desktopPresence.mjs';
import { createIsolatedTestEnv } from './helpers/isolatedState.mjs';

test('desktop presence prefers an active managed game and treats stale or missing signals as unknown', (t) => {
  const env = createIsolatedTestEnv(t, {}, 'desktop-presence-');
  const statePath = path.join(env.RAN_AGENT_STATE_DIR, 'attention', 'presence.json');
  const activities = [];
  const provider = createDesktopPresenceProvider({
    statePath,
    externalMcpRuntime: { store: { list: () => activities } },
    now: () => new Date('2026-08-08T10:00:00.000Z'),
  });
  assert.equal(provider(), 'unknown');
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({
    schemaVersion: 1, state: 'focused', observedAt: '2026-08-08T09:59:00.000Z',
    expiresAt: '2026-08-08T10:01:00.000Z', source: 'activitywatch',
  }));
  assert.equal(provider(), 'focused');
  activities.push({ status: 'active', domain: 'game' });
  assert.equal(provider(), 'gaming');
  activities[0].status = 'paused';
  fs.writeFileSync(statePath, JSON.stringify({
    schemaVersion: 1, state: 'available', observedAt: '2026-08-08T09:00:00.000Z',
    expiresAt: '2026-08-08T09:05:00.000Z', source: 'activitywatch',
  }));
  assert.equal(provider(), 'unknown');
});
