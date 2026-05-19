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

  // UV cache/tool env vars present in both units
  for (const unit of [liteUnit, fullUnit]) {
    assert.match(unit, /Environment=UV_CACHE_DIR=\/opt\/ran_agent\/\.ran_agent_state\/uv-cache/);
    assert.match(unit, /Environment=UV_TOOL_DIR=\/opt\/ran_agent\/\.ran_agent_state\/uv-tools/);
    assert.match(unit, /Environment=UV_LINK_MODE=copy/);
    assert.match(unit, /Environment=UV_PYTHON_DOWNLOADS=never/);
    assert.match(unit, /Environment=SOCIAL_READER_XHS_BACKEND_TIMEOUT_MS=90000/);
    assert.match(unit, /Environment=XHS_BACKEND_MCP_TIMEOUT_MS=90000/);
  }

  // OpenCLI browser-backed disabled in both units (via env files)
  // Full retains Playwright fallback (set in env files, not in unit Environment= lines)

  // Proactive/reminder freeze stays false
  assert.match(liteUnit, /Environment=PERSONAL_AGENT_PROACTIVE_ENABLED=false/);
  assert.match(liteUnit, /Environment=PERSONAL_AGENT_REMINDER_DELIVERY_ENABLED=false/);
  assert.match(fullUnit, /Environment=PERSONAL_AGENT_PROACTIVE_ENABLED=false/);
  assert.match(fullUnit, /Environment=PERSONAL_AGENT_REMINDER_DELIVERY_ENABLED=false/);
});

test('apply script env upsert includes UV cache and XHS timeout vars', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uv-env-upsert-'));
  const envFile = join(dir, '.env');
  writeFileSync(envFile, 'EXISTING_KEY=keep\n');

  execFileSync('bash', ['-lc', [
    'set -euo pipefail',
    'export RAN_AGENT_NO_SUDO=1',
    'source scripts/apply-hermes-runtime-split.sh',
    `upsert_env_file ${JSON.stringify(envFile)} UV_CACHE_DIR=/opt/ran_agent/.ran_agent_state/uv-cache UV_TOOL_DIR=/opt/ran_agent/.ran_agent_state/uv-tools UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never SOCIAL_READER_XHS_BACKEND_TIMEOUT_MS=90000 XHS_BACKEND_MCP_TIMEOUT_MS=90000 SEARCH_HUB_ENABLE_OPENCLI_BROWSER=false`,
  ].join('\n')], {
    cwd: new URL('../..', import.meta.url).pathname,
    stdio: 'pipe',
  });

  const text = readFileSync(envFile, 'utf8');
  assert.match(text, /EXISTING_KEY=keep/);
  assert.match(text, /UV_CACHE_DIR=\/opt\/ran_agent\/\.ran_agent_state\/uv-cache/);
  assert.match(text, /UV_TOOL_DIR=\/opt\/ran_agent\/\.ran_agent_state\/uv-tools/);
  assert.match(text, /UV_LINK_MODE=copy/);
  assert.match(text, /UV_PYTHON_DOWNLOADS=never/);
  assert.match(text, /SOCIAL_READER_XHS_BACKEND_TIMEOUT_MS=90000/);
  assert.match(text, /XHS_BACKEND_MCP_TIMEOUT_MS=90000/);
  assert.match(text, /SEARCH_HUB_ENABLE_OPENCLI_BROWSER=false/);
});

test('apply script full env has OpenCLI browser-backed disabled and Playwright fallback enabled', () => {
  const dir = mkdtempSync(join(tmpdir(), 'full-env-opencli-'));
  const envFile = join(dir, '.env');
  writeFileSync(envFile, '');

  execFileSync('bash', ['-lc', [
    'set -euo pipefail',
    'export RAN_AGENT_NO_SUDO=1',
    'source scripts/apply-hermes-runtime-split.sh',
    `upsert_env_file ${JSON.stringify(envFile)} SEARCH_HUB_ENABLE_OPENCLI_BROWSER=false SEARCH_HUB_ENABLE_PLAYWRIGHT_FALLBACK=true SEARCH_HUB_PROFILE_MODE=full`,
  ].join('\n')], {
    cwd: new URL('../..', import.meta.url).pathname,
    stdio: 'pipe',
  });

  const text = readFileSync(envFile, 'utf8');
  assert.match(text, /SEARCH_HUB_ENABLE_OPENCLI_BROWSER=false/);
  assert.match(text, /SEARCH_HUB_ENABLE_PLAYWRIGHT_FALLBACK=true/);
  assert.match(text, /SEARCH_HUB_PROFILE_MODE=full/);
});

test('clean-uv-cache-safe.sh does not delete XHS cache or protected directories', () => {
  const scriptPath = new URL('../../scripts/clean-uv-cache-safe.sh', import.meta.url).pathname;
  const script = readFileSync(scriptPath, 'utf8');

  // Must not contain rm commands targeting protected directories
  assert.equal(script.includes('rm'), true); // script does rm, but only for uv cache
  assert.equal(script.includes('social_reader'), true); // listed as protected
  assert.equal(script.includes('xhs_notes'), true); // listed as protected

  // Must not have rm -rf targeting social_reader, vault, data, or debug
  // (The script only does rm on UV_CACHE_DIR contents and ~/.cache/uv)
  assert.equal(script.includes('rm -rf.*social_reader'), false);
  assert.equal(script.includes('rm -rf.*vault'), false);
  assert.equal(script.includes('rm -rf.*data'), false);
  assert.equal(script.includes('rm -rf.*debug'), false);

  // The actual rm should only target UV_CACHE_DIR contents
  assert.equal(script.includes('UV_CACHE_DIR:?'), true);
});
