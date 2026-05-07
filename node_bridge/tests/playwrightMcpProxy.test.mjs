import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeMcpToolInputSchema,
  normalizeToolsListResult,
} from '../../scripts/playwright_mcp_proxy.mjs';

test('normalizeMcpToolInputSchema supplies empty object schema when missing', () => {
  assert.deepEqual(normalizeMcpToolInputSchema(undefined), {
    type: 'object',
    properties: {},
    additionalProperties: false,
  });
});

test('normalizeMcpToolInputSchema keeps valid object schema properties', () => {
  assert.deepEqual(
    normalizeMcpToolInputSchema({
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
    }),
    {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
    }
  );
});

test('normalizeToolsListResult normalizes every listed tool schema', () => {
  const normalized = normalizeToolsListResult({
    tools: [
      { name: 'browser_close', description: 'Close browser' },
      { name: 'browser_navigate', inputSchema: { properties: { url: { type: 'string' } }, required: ['url'] } },
    ],
  });

  assert.equal(normalized.tools[0].inputSchema.type, 'object');
  assert.equal(normalized.tools[0].inputSchema.additionalProperties, false);
  assert.equal(normalized.tools[1].inputSchema.type, 'object');
  assert.equal(normalized.tools[1].inputSchema.properties.url.type, 'string');
});
