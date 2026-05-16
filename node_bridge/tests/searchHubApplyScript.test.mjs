import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

test('apply script env upsert preserves existing Search Hub secrets and optional mailto', () => {
  const dir = mkdtempSync(join(tmpdir(), 'search-hub-apply-'));
  const envFile = join(dir, '.env');
  writeFileSync(envFile, [
    'TAVILY_API_KEY=secret-value',
    'OPENALEX_MAILTO=owner@example.com',
    'SEARCH_HUB_PROFILE_MODE=custom-old',
  ].join('\n'));

  execFileSync('bash', ['-lc', [
    'set -euo pipefail',
    'export RAN_AGENT_NO_SUDO=1',
    'source scripts/apply-hermes-runtime-split.sh',
    `upsert_env_file ${JSON.stringify(envFile)} SEARCH_HUB_PROFILE_MODE=lite '?OPENALEX_MAILTO=' SEARCH_HUB_ENABLED=true PERSONAL_AGENT_PROACTIVE_ENABLED=false PERSONAL_AGENT_REMINDER_DELIVERY_ENABLED=false`,
  ].join('\n')], {
    cwd: new URL('../..', import.meta.url).pathname,
    stdio: 'pipe',
  });

  const text = readFileSync(envFile, 'utf8');
  assert.match(text, /TAVILY_API_KEY=secret-value/);
  assert.match(text, /OPENALEX_MAILTO=owner@example\.com/);
  assert.match(text, /SEARCH_HUB_PROFILE_MODE=lite/);
  assert.match(text, /SEARCH_HUB_ENABLED=true/);
  assert.match(text, /PERSONAL_AGENT_PROACTIVE_ENABLED=false/);
  assert.match(text, /PERSONAL_AGENT_REMINDER_DELIVERY_ENABLED=false/);
  assert.doesNotMatch(text, /custom-old/);
});
