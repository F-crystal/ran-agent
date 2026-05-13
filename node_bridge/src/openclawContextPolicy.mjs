/**
 * Legacy OpenClaw context-policy module.
 *
 * New code should import from `contextPolicy.mjs`. This wrapper preserves old
 * imports and OPENCLAW_* env compatibility during the Hermes migration.
 */

export {
  getContextPolicyConfig,
  renderCompactArtifact,
  selectMediaArtifactsForPrompt,
  buildCompactMediaContext,
  buildContextSizeLog,
  buildPersonaContract,
} from './contextPolicy.mjs';
