#!/usr/bin/env node

console.error(JSON.stringify({
  ok: false,
  error: 'direct_soft_reset_writer_retired',
  replacement: 'bash scripts/hermes-lite-soft-reset.sh --status|--dry-run|--apply|--rollback-last',
}));
process.exit(64);
