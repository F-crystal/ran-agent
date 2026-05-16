import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

test('apply script writes compact lite/full systemd units and removes stale runtime drop-ins', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-systemd-compact-'));
  const systemdDir = join(dir, 'systemd');
  const dropinDir = join(systemdDir, 'ran-agent-hermes.service.d');
  mkdirSync(dropinDir, { recursive: true });
  writeFileSync(join(dropinDir, '30-hermes-env.conf'), '[Service]\nEnvironment=OLD=1\n');
  writeFileSync(join(dropinDir, '30-hermes-runtime.conf'), '[Service]\nEnvironment=OLD=1\n');
  writeFileSync(join(dropinDir, '90-lite-runtime.conf'), '[Service]\nEnvironment=OLD=1\n');
  writeFileSync(join(dropinDir, '20-timeout.conf'), '[Service]\nTimeoutStopSec=240\n');

  execFileSync('bash', ['-lc', [
    'set -euo pipefail',
    'export RAN_AGENT_NO_SUDO=1',
    `export SYSTEMD_DIR=${JSON.stringify(systemdDir)}`,
    'source scripts/apply-hermes-runtime-split.sh',
    'write_systemd_units',
  ].join('\n')], {
    cwd: new URL('../..', import.meta.url).pathname,
    stdio: 'pipe',
  });

  const liteUnit = readFileSync(join(systemdDir, 'ran-agent-hermes.service'), 'utf8');
  const fullUnit = readFileSync(join(systemdDir, 'ran-agent-hermes-full.service'), 'utf8');

  assert.match(liteUnit, /Description=Ran Agent Hermes Lite Gateway \(port 8642\)/);
  assert.match(liteUnit, /Environment=HERMES_HOME=\/home\/ubuntu\/\.hermes-ran-agent\/lite/);
  assert.match(liteUnit, /Environment=HERMES_PROFILE=ran-assistant-lite/);
  assert.match(liteUnit, /Environment=API_SERVER_PORT=8642/);
  assert.match(liteUnit, /Environment=API_SERVER_MODEL_NAME=ran-assistant-lite/);
  assert.match(liteUnit, /Environment=PERSONAL_AGENT_PROACTIVE_ENABLED=false/);
  assert.match(liteUnit, /Environment=PERSONAL_AGENT_REMINDER_DELIVERY_ENABLED=false/);
  assert.match(liteUnit, /ExecStart=.*hermes -p ran-assistant-lite gateway run/);
  assert.doesNotMatch(liteUnit, /HERMES_PROFILE=ran-assistant\n/);
  assert.doesNotMatch(liteUnit, /API_SERVER_PORT=8643/);

  assert.match(fullUnit, /Description=Ran Agent Hermes Full Gateway \(port 8643\)/);
  assert.match(fullUnit, /Environment=HERMES_HOME=\/home\/ubuntu\/\.hermes-ran-agent/);
  assert.match(fullUnit, /Environment=HERMES_PROFILE=ran-assistant/);
  assert.match(fullUnit, /Environment=API_SERVER_PORT=8643/);
  assert.match(fullUnit, /Environment=API_SERVER_MODEL_NAME=ran-assistant/);
  assert.match(fullUnit, /Environment=PERSONAL_AGENT_PROACTIVE_ENABLED=false/);
  assert.match(fullUnit, /Environment=PERSONAL_AGENT_REMINDER_DELIVERY_ENABLED=false/);
  assert.match(fullUnit, /ExecStart=.*hermes -p ran-assistant gateway run/);
  assert.doesNotMatch(fullUnit, /ran-assistant-lite/);

  assert.equal(existsSync(join(dropinDir, '30-hermes-env.conf')), false);
  assert.equal(existsSync(join(dropinDir, '30-hermes-runtime.conf')), false);
  assert.equal(existsSync(join(dropinDir, '90-lite-runtime.conf')), false);
  assert.equal(existsSync(join(dropinDir, '20-timeout.conf')), true);
});
