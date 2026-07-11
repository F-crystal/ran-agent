export const PROTECTED_MCP_NAMES = Object.freeze([
  'search_hub',
  'social_reader',
  'media_reader',
  'personal_memory',
  'obsidian_memory',
  'ombre_memory',
  'ombre_memory_extra',
  'co_reading',
  'sticker_catalog',
  'media_generation',
  'time',
  'playwright',
]);

const PROTECTED_MCP_NAME_SET = new Set(PROTECTED_MCP_NAMES);

export const PROTECTED_CAPABILITY_COLLISION_CODE = 'PROTECTED_CAPABILITY_NAME_COLLISION';

export function normalizeCapabilityName(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_');
}

export function isProtectedCapabilityName(value) {
  const segments = String(value || '').trim().toLowerCase().split(/[.:/]+/)
    .map(normalizeCapabilityName)
    .filter(Boolean);
  return segments.some((segment) => PROTECTED_MCP_NAME_SET.has(segment)
    || PROTECTED_MCP_NAMES.some((name) => segment.startsWith(`${name}_`)));
}

export function isProtectedCapabilityToolPrefix(value) {
  const normalized = normalizeCapabilityName(value);
  if (!normalized) return false;
  return PROTECTED_MCP_NAME_SET.has(normalized)
    || PROTECTED_MCP_NAMES.some((name) => (
      normalized.startsWith(`${name}_`)
      || normalized.startsWith(`mcp_${name}_`)
    ));
}

export function protectedCapabilityCollision(value) {
  if (!isProtectedCapabilityName(value)) return null;
  return Object.freeze({
    ok: false,
    error_code: PROTECTED_CAPABILITY_COLLISION_CODE,
  });
}
