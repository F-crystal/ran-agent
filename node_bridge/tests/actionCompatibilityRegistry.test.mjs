import test from 'node:test';
import assert from 'node:assert/strict';

import { loadActionCompatibilityRegistry } from '../src/actionCompatibilityRegistry.mjs';

test('protected compatibility registry is versioned, closed, and does not describe prompt content', () => {
  const registry = loadActionCompatibilityRegistry();

  assert.equal(registry.schemaVersion, 1);
  assert.deepEqual(Object.keys(registry.actions).sort(), [
    'external_mcp_read',
    'external_mcp_write',
    'external_send',
    'media_generate',
    'media_read',
    'social_read',
    'sticker_send',
  ]);
  assert.equal(registry.actions.media_generate.signals.includes('marker:WECHAT_MEDIA:media_generation_mcp'), true);
  for (const entry of Object.values(registry.actions)) {
    assert.equal(Array.isArray(entry.signals), true);
    assert.equal(entry.signals.length > 0, true);
  }
});
