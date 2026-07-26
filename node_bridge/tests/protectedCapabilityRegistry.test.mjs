import assert from 'node:assert/strict';
import test from 'node:test';

import {
  admitExternalMcpCandidate,
  validateManifest,
} from '../src/externalMcp/registry.mjs';
import { createIsolatedTestEnv } from './helpers/isolatedState.mjs';

const CODE = 'PROTECTED_CAPABILITY_NAME_COLLISION';

function candidate(overrides = {}) {
  return {
    id: 'org.example.new_game',
    title: 'New game',
    source: 'https://github.com/example/new-game',
    transport: 'streamable-http',
    url: 'https://game.example.test/mcp',
    activityKind: 'game',
    tools: [{ name: 'game.observe', description: 'Observe a sandbox game.' }],
    ...overrides,
  };
}

test('external manifests reject every protected server name and namespace', () => {
  for (const name of [
    'search_hub',
    'social_reader',
    'media_reader',
    'personal_memory',
    'obsidian_memory',
    'ombre_memory',
    'co_reading',
    'sticker_catalog',
    'media_generation',
    'time',
    'playwright',
  ]) {
    const exact = validateManifest(candidate({ id: name }));
    assert.equal(exact.ok, false, name);
    assert.deepEqual(exact.errors, [CODE]);

    const nested = validateManifest(candidate({ id: `org.example.${name}_adapter` }));
    assert.equal(nested.ok, false, `${name} nested`);
    assert.deepEqual(nested.errors, [CODE]);
  }
});

test('external manifests reject protected tool prefixes without renaming', () => {
  for (const name of ['social_reader', 'media_reader', 'co_reading', 'personal_memory']) {
    const result = validateManifest(candidate({
      tools: [{ name: `mcp_${name}_read`, description: 'Read something.' }],
    }));
    assert.equal(result.ok, false, name);
    assert.deepEqual(result.errors, [CODE]);
  }
});

test('protected namespace does not block ordinary domain fields containing common words', () => {
  const result = validateManifest(candidate({
    id: 'org.example.real_time_game',
    tools: [
      { name: 'game.get_time', description: 'Read the current in-game turn time.' },
      { name: 'game.playwright_character', description: 'Observe a character role.' },
    ],
  }));
  assert.equal(result.ok, true);
});

test('admission persists a stable denied result for protected collisions', async (t) => {
  const env = createIsolatedTestEnv(t, {}, 'protected-registry-');
  const result = await admitExternalMcpCandidate(candidate({ id: 'search_hub' }), { env });
  assert.equal(result.ok, false);
  assert.equal(result.state, 'denied');
  assert.equal(result.entry.reason, CODE);
  assert.equal(result.entry.enabled, false);
  assert.equal(result.entry.manifest, null);
  assert.deepEqual(result.errors, [CODE]);
});
