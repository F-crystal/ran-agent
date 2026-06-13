#!/usr/bin/env node

import { runHermesLiteSoftReset } from '../node_bridge/src/hermesSessionMaintenance.mjs';

function parseAction(argv = []) {
  if (argv.includes('--dry-run')) return 'dry-run';
  if (argv.includes('--apply')) return 'apply';
  if (argv.includes('--status')) return 'status';
  if (argv.includes('--rollback-last')) return 'rollback-last';
  return 'status';
}

function printHelp() {
  console.log([
    'Usage: bash scripts/hermes-lite-soft-reset.sh --dry-run|--apply|--status|--rollback-last',
    '',
    'This command does not restart services or edit systemd. It only reads/writes Hermes lite soft-reset runtime state when enabled.',
  ].join('\n'));
}

const action = parseAction(process.argv.slice(2));
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  printHelp();
  process.exit(0);
}

try {
  const result = runHermesLiteSoftReset({
    action,
    env: process.env,
    reason: action === 'apply' ? 'manual_apply' : action,
  });
  console.log(JSON.stringify(sanitizeResult(result), null, 2));
  process.exit(result.ok === false ? 1 : 0);
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    error: 'hermes_lite_soft_reset_failed',
    message: String(error?.message || error || 'unknown error'),
  }, null, 2));
  process.exit(1);
}

function sanitizeResult(value) {
  if (!value || typeof value !== 'object') return { ok: false, error: 'empty_result' };
  const result = { ...value };
  delete result.newSessionNonce;
  if (result.digest && typeof result.digest === 'object') {
    result.digest = {
      date: String(result.digest.date || ''),
      profile: String(result.digest.profile || ''),
      digestId: String(result.digest.digestId || ''),
      sourceSessionIdHash: String(result.digest.sourceSessionIdHash || ''),
      counts: {
        open_threads: Array.isArray(result.digest.open_threads) ? result.digest.open_threads.length : 0,
        pending_commitments: Array.isArray(result.digest.pending_commitments) ? result.digest.pending_commitments.length : 0,
        active_preferences: Array.isArray(result.digest.active_preferences) ? result.digest.active_preferences.length : 0,
        recent_artifacts: Array.isArray(result.digest.recent_artifacts) ? result.digest.recent_artifacts.length : 0,
        do_not_carry: Array.isArray(result.digest.do_not_carry) ? result.digest.do_not_carry.length : 0,
      },
    };
  }
  return result;
}
