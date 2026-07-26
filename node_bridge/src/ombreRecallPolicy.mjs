import { createHash } from 'node:crypto';

export const OMBRE_UPSTREAM_COMMIT = '0e83d4671ce1629e03ad36bb9160235bf60dbd34';

// Read from P0luz/Ombre-Brain src/server.py at OMBRE_UPSTREAM_COMMIT.
export const OMBRE_UPSTREAM_TOOL_REGISTRY = Object.freeze([
  'breath',
  'breath_search',
  'breath_advanced',
  'hold',
  'grow',
  'trace',
  'anchor',
  'release',
  'pulse',
  'plan',
  'letter_write',
  'letter_read',
  'dream',
  'I',
]);

// These are local tools. None forwards tools/call to the upstream registry.
export const OMBRE_RECALL_TOOLS = Object.freeze([
  {
    name: 'ombre_recall_search',
    description: 'Search the local Ombre bucket projection without touching or changing upstream memory.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 20 },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'ombre_recall_read',
    description: 'Read one Markdown file from the local Ombre bucket projection.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        max_chars: { type: 'integer', minimum: 1, maximum: 20000 },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
]);

export const OMBRE_RECALL_TOOL_NAMES = Object.freeze(
  OMBRE_RECALL_TOOLS.map(({ name }) => name),
);

export function ombreRecallPolicyDigest() {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify({
      upstream_commit: OMBRE_UPSTREAM_COMMIT,
      upstream_registry: OMBRE_UPSTREAM_TOOL_REGISTRY,
      local_allowlist: OMBRE_RECALL_TOOL_NAMES,
    }))
    .digest('hex')}`;
}

export function isAllowedOmbreRecallTool(name) {
  return OMBRE_RECALL_TOOL_NAMES.includes(String(name || ''));
}
