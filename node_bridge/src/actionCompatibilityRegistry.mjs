import fs from 'node:fs';

const REGISTRY_URL = new URL('../../docs/governance/hermes_action_compatibility.v1.json', import.meta.url);
const ALLOWED_ACTIONS = new Set(['social_read', 'media_read', 'sticker_send', 'media_generate', 'external_mcp_read', 'external_mcp_write', 'external_send']);

export function loadActionCompatibilityRegistry() {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(REGISTRY_URL, 'utf8')); } catch { throw registryError('ACTION_COMPATIBILITY_REGISTRY_INVALID'); }
  if (!parsed || parsed.schemaVersion !== 1 || !parsed.actions || typeof parsed.actions !== 'object') {
    throw registryError('ACTION_COMPATIBILITY_REGISTRY_INVALID');
  }
  const keys = Object.keys(parsed.actions).sort();
  if (keys.length !== ALLOWED_ACTIONS.size || keys.some((key) => !ALLOWED_ACTIONS.has(key))) {
    throw registryError('ACTION_COMPATIBILITY_REGISTRY_INVALID');
  }
  for (const key of keys) {
    const entry = parsed.actions[key];
    if (!entry || !Array.isArray(entry.signals) || entry.signals.length === 0 || !Array.isArray(entry.statuses) || !Array.isArray(entry.claims)) {
      throw registryError('ACTION_COMPATIBILITY_REGISTRY_INVALID');
    }
  }
  return Object.freeze({ schemaVersion: 1, actions: Object.freeze(parsed.actions) });
}

function registryError(code) { const error = new Error(code); error.code = code; return error; }
