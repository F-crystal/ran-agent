// O2 remains fail-off without managed production env. The production runtime
// explicitly enables it after wiring the canonical Steward and the existing
// tool-less DeepSeek provider boundary.

import path from 'node:path';

import { resolveStateDir } from '../runtimeState.mjs';

export function getOmbreCompatConfig(env = process.env) {
  const enabled = String(env.OMBRE_COMPAT_ENABLED || 'false') === 'true';
  const testMode = String(env.OMBRE_COMPAT_TEST_MODE || 'false') === 'true';
  const stateDir = env.OMBRE_COMPAT_STATE_DIR
    ? path.resolve(env.OMBRE_COMPAT_STATE_DIR)
    : path.join(resolveStateDir(env), 'ombre-compat');
  return {
    enabled,
    testMode,
    stateDir,
    queueDir: path.join(stateDir, 'queue'),
    payloadDir: path.join(stateDir, 'payloads'),
    projectionDir: path.join(stateDir, 'projection'),
    registryDir: path.join(stateDir, 'payload-index'),
    lockDir: path.join(stateDir, 'locks'),
    stewardEndpoint: env.OMBRE_COMPAT_STEWARD_ENDPOINT || 'http://127.0.0.1:18001/internal/ran-agent/steward/v1',
    stewardTokenFile: env.RAN_AGENT_STEWARD_TOKEN_FILE
      || path.join(resolveStateDir(env), 'ombre-compat', 'secrets', 'steward-api-token'),
    stewardIdentityFile: env.OMBRE_COMPAT_STEWARD_IDENTITY_FILE
      || env.RAN_AGENT_STEWARD_IDENTITY_FILE
      || path.join(resolveStateDir(env), 'ombre-brain', 'steward-identity.v1.json'),
    patchManifestSha256: env.OMBRE_COMPAT_PATCH_MANIFEST_SHA256 || '',
    apiSchemaSha256: env.OMBRE_COMPAT_API_SCHEMA_SHA256 || '',
    effectiveSourceTreeSha256: env.OMBRE_COMPAT_EFFECTIVE_SOURCE_TREE_SHA256 || '',
    dispatchTimeoutMs: clampInt(env.OMBRE_COMPAT_DISPATCH_TIMEOUT_MS, 15000, 1000, 120000),
    curator: {
      baseUrl: env.OMBRE_COMPAT_CURATOR_BASE_URL || 'https://api.deepseek.com/v1',
      model: env.OMBRE_COMPAT_CURATOR_MODEL || env.HERMES_DEFAULT_MODEL || 'deepseek-v4-flash',
      apiKey: env.DEEPSEEK_API_KEY || env.OMBRE_COMPAT_CURATOR_API_KEY || '',
      timeoutMs: clampInt(env.OMBRE_COMPAT_CURATOR_TIMEOUT_MS, 30000, 1000, 180000),
    },
    reviewer: {
      baseUrl: env.OMBRE_COMPAT_REVIEWER_BASE_URL || 'https://api.deepseek.com/v1',
      model: env.OMBRE_COMPAT_REVIEWER_MODEL || env.HERMES_DEFAULT_MODEL || 'deepseek-v4-flash',
      apiKey: env.DEEPSEEK_API_KEY || env.OMBRE_COMPAT_REVIEWER_API_KEY || '',
      timeoutMs: clampInt(env.OMBRE_COMPAT_REVIEWER_TIMEOUT_MS, 30000, 1000, 180000),
    },
  };
}

// The seam and every worker entry point must check this first. Test mode is
// required whenever the layer is enabled inside NODE_ENV=test so that an
// accidental flip in a test environment cannot reach a real upstream.
export function isCompatActive(config, env = process.env) {
  if (!config.enabled) return false;
  if (String(env.NODE_ENV || '') === 'test' && !config.testMode) return false;
  return true;
}

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
