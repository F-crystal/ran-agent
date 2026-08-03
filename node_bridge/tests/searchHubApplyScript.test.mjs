import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
    `upsert_env_file ${JSON.stringify(envFile)} SEARCH_HUB_PROFILE_MODE=lite '?OPENALEX_MAILTO=' SEARCH_HUB_ENABLED=true PERSONAL_AGENT_PROACTIVE_ENABLED=false PERSONAL_AGENT_REMINDER_DELIVERY_ENABLED=false HERMES_PROACTIVE_EVENTS_ENABLED=true HERMES_PROACTIVE_EXTERNAL_MCP_ENABLED=true HERMES_PROACTIVE_REMINDERS_ENABLED=true`,
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
  assert.match(text, /HERMES_PROACTIVE_EVENTS_ENABLED=true/);
  assert.match(text, /HERMES_PROACTIVE_EXTERNAL_MCP_ENABLED=true/);
  assert.match(text, /HERMES_PROACTIVE_REMINDERS_ENABLED=true/);
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
  const xhsPublicUnit = readFileSync(join(systemdDir, 'ran-agent-xhs-public-sidecar.service'), 'utf8');

  assert.match(liteUnit, /Description=Ran Agent Hermes Lite Gateway \(port 8642\)/);
  assert.match(liteUnit, /Environment=HERMES_HOME=\/home\/ubuntu\/\.hermes-ran-agent\/lite/);
  assert.match(liteUnit, /Environment=HERMES_PROFILE=ran-assistant-lite/);
  assert.match(liteUnit, /Environment=API_SERVER_PORT=8642/);
  assert.match(liteUnit, /Environment=API_SERVER_MODEL_NAME=ran-assistant-lite/);
  assert.match(liteUnit, /Environment=PERSONAL_AGENT_PROACTIVE_ENABLED=false/);
  assert.match(liteUnit, /Environment=PERSONAL_AGENT_REMINDER_DELIVERY_ENABLED=false/);
  assert.match(liteUnit, /Environment=HERMES_PROACTIVE_EVENTS_ENABLED=true/);
  assert.match(liteUnit, /Environment=HERMES_PROACTIVE_EXTERNAL_MCP_ENABLED=true/);
  assert.match(liteUnit, /Environment=HERMES_PROACTIVE_REMINDERS_ENABLED=true/);
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
  assert.match(fullUnit, /Environment=HERMES_PROACTIVE_EVENTS_ENABLED=true/);
  assert.match(fullUnit, /Environment=HERMES_PROACTIVE_EXTERNAL_MCP_ENABLED=true/);
  assert.match(fullUnit, /Environment=HERMES_PROACTIVE_REMINDERS_ENABLED=true/);
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
    assert.match(unit, /Environment=XHS_PUBLIC_SIDECAR_URL=http:\/\/127\.0\.0\.1:18061\/xhs\/detail/);
    assert.doesNotMatch(unit, /XHS_COOKIE/);
    assert.doesNotMatch(unit, /XHS_BROWSE/);
    assert.doesNotMatch(unit, /start_xhs_browse_backend/);
  }

  assert.match(xhsPublicUnit, /Description=Ran Agent XHS Public Sidecar \(XHS-Downloader API, port 18061\)/);
  assert.match(xhsPublicUnit, /ExecStart=.*scripts\/start_xhs_public_sidecar\.sh/);
  assert.doesNotMatch(xhsPublicUnit, /XHS_COOKIE/);
  assert.doesNotMatch(xhsPublicUnit, /xiaohongshu-mcp/);
  assert.equal(existsSync(join(systemdDir, 'ran-agent-xhs-browse.service')), false);

  // OpenCLI browser-backed disabled in both units (via env files)
  // Full retains Playwright fallback (set in env files, not in unit Environment= lines)

  // Proactive/reminder freeze stays false
  assert.match(liteUnit, /Environment=PERSONAL_AGENT_PROACTIVE_ENABLED=false/);
  assert.match(liteUnit, /Environment=PERSONAL_AGENT_REMINDER_DELIVERY_ENABLED=false/);
  assert.match(liteUnit, /Environment=HERMES_PROACTIVE_EVENTS_ENABLED=true/);
  assert.match(liteUnit, /Environment=HERMES_PROACTIVE_REMINDERS_ENABLED=true/);
  assert.match(fullUnit, /Environment=PERSONAL_AGENT_PROACTIVE_ENABLED=false/);
  assert.match(fullUnit, /Environment=PERSONAL_AGENT_REMINDER_DELIVERY_ENABLED=false/);
  assert.match(fullUnit, /Environment=HERMES_PROACTIVE_EVENTS_ENABLED=true/);
  assert.match(fullUnit, /Environment=HERMES_PROACTIVE_REMINDERS_ENABLED=true/);
});

test('apply script env upsert includes UV cache and XHS timeout vars', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uv-env-upsert-'));
  const envFile = join(dir, '.env');
  writeFileSync(envFile, 'EXISTING_KEY=keep\n');

  execFileSync('bash', ['-lc', [
    'set -euo pipefail',
    'export RAN_AGENT_NO_SUDO=1',
    'source scripts/apply-hermes-runtime-split.sh',
    `upsert_env_file ${JSON.stringify(envFile)} UV_CACHE_DIR=/opt/ran_agent/.ran_agent_state/uv-cache UV_TOOL_DIR=/opt/ran_agent/.ran_agent_state/uv-tools UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never SOCIAL_READER_GENERIC_FALLBACK_ENABLED=true SOCIAL_READER_XHS_BACKEND_TIMEOUT_MS=90000 XHS_BACKEND_MCP_TIMEOUT_MS=90000 XHS_GENERIC_FALLBACK_READY_PATH=/opt/ran_agent/.ran_agent_state/social_reader/generic-fallback-ready.json WEIXIN_SDK_INBOUND_MEDIA_DIRS=/tmp/weixin-agent/media/inbound SEARCH_HUB_ENABLE_OPENCLI_BROWSER=false`,
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
  assert.match(text, /SOCIAL_READER_GENERIC_FALLBACK_ENABLED=true/);
  assert.match(text, /SOCIAL_READER_XHS_BACKEND_TIMEOUT_MS=90000/);
  assert.match(text, /XHS_BACKEND_MCP_TIMEOUT_MS=90000/);
  assert.match(text, /XHS_GENERIC_FALLBACK_READY_PATH=\/opt\/ran_agent\/\.ran_agent_state\/social_reader\/generic-fallback-ready\.json/);
  assert.match(text, /WEIXIN_SDK_INBOUND_MEDIA_DIRS=\/tmp\/weixin-agent\/media\/inbound/);
  assert.match(text, /SEARCH_HUB_ENABLE_OPENCLI_BROWSER=false/);
});

test('apply script env upsert removes account-backed XHS keys and writes public-only sidecar keys', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xhs-public-env-upsert-'));
  const envFile = join(dir, '.env');
  writeFileSync(envFile, [
    'XHS_COOKIE=secret-cookie',
    'XHS_MCP_COMMAND=uvx',
    'XHS_MCP_ARGS_JSON=["--from","jobson-xhs-mcp","xhs-mcp"]',
    'PERSONAL_AGENT_XHS_MCP_COMMAND=uvx',
    'PERSONAL_AGENT_XHS_MCP_ARGS_JSON=["xhs"]',
    'XHS_BROWSE_ENABLED=true',
    'SOCIAL_READER_EXPOSE_XHS_BROWSE_TOOLS=true',
    'XHS_BROWSE_MCP_COMMAND=mcporter',
    'XHS_NOTE_TOKEN_CACHE_PATH=/tmp/xhs-cache.json',
    'UNRELATED_SECRET=keep',
  ].join('\n'));

  execFileSync('bash', ['-lc', [
    'set -euo pipefail',
    'export RAN_AGENT_NO_SUDO=1',
    'source scripts/apply-hermes-runtime-split.sh',
    `upsert_env_file ${JSON.stringify(envFile)} SOCIAL_READER_GENERIC_FALLBACK_ENABLED=true XHS_PUBLIC_SIDECAR_ENABLED=true XHS_PUBLIC_SIDECAR_URL=http://127.0.0.1:18061/xhs/detail XHS_PUBLIC_HTML_FALLBACK_ENABLED=true`,
  ].join('\n')], {
    cwd: new URL('../..', import.meta.url).pathname,
    stdio: 'pipe',
  });

  const text = readFileSync(envFile, 'utf8');
  assert.match(text, /UNRELATED_SECRET=keep/);
  assert.match(text, /SOCIAL_READER_GENERIC_FALLBACK_ENABLED=true/);
  assert.match(text, /XHS_PUBLIC_SIDECAR_ENABLED=true/);
  assert.match(text, /XHS_PUBLIC_SIDECAR_URL=http:\/\/127\.0\.0\.1:18061\/xhs\/detail/);
  assert.match(text, /XHS_PUBLIC_HTML_FALLBACK_ENABLED=true/);
  assert.doesNotMatch(text, /XHS_COOKIE/);
  assert.doesNotMatch(text, /XHS_MCP_/);
  assert.doesNotMatch(text, /PERSONAL_AGENT_XHS_MCP_/);
  assert.doesNotMatch(text, /XHS_BROWSE/);
  assert.doesNotMatch(text, /SOCIAL_READER_EXPOSE_XHS_BROWSE_TOOLS/);
  assert.doesNotMatch(text, /XHS_NOTE_TOKEN_CACHE/);
});

test('media reader startup defaults to DashScope OCR full-read budget', () => {
  const scriptPath = new URL('../../scripts/start_media_reader_mcp.sh', import.meta.url).pathname;
  const script = readFileSync(scriptPath, 'utf8');

  assert.match(script, /PERSONAL_AGENT_OCR_PROVIDER="\$\{PERSONAL_AGENT_OCR_PROVIDER:-dashscope-qwen-vl-ocr\}"/);
  assert.match(script, /PERSONAL_AGENT_OCR_MODEL="\$\{PERSONAL_AGENT_OCR_MODEL:-qwen-vl-ocr-2025-11-20\}"/);
  assert.match(script, /PERSONAL_AGENT_OCR_TIMEOUT_MS="\$\{PERSONAL_AGENT_OCR_TIMEOUT_MS:-120000\}"/);
  assert.doesNotMatch(script, /PERSONAL_AGENT_OCR_PROVIDER="\$\{PERSONAL_AGENT_OCR_PROVIDER:-paddleocr\}"/);
});

test('apply script creates runtime trusted media directories', () => {
  const dir = mkdtempSync(join(tmpdir(), 'trusted-media-runtime-dirs-'));
  const stateDir = join(dir, '.ran_agent_state');
  const debugDir = join(dir, 'debug');

  execFileSync('bash', ['-lc', [
    'set -euo pipefail',
    'export RAN_AGENT_NO_SUDO=1',
    `export RAN_AGENT_DEPLOY_STATE_DIR=${JSON.stringify(stateDir)}`,
    `export RAN_AGENT_STATE_DIR=${JSON.stringify(stateDir)}`,
    `export RAN_AGENT_DEPLOY_DEBUG_DIR=${JSON.stringify(debugDir)}`,
    `export RAN_AGENT_DEPLOY_OMBRE_BRAIN_HOME=${JSON.stringify(join(stateDir, 'ombre-brain'))}`,
    `export RAN_AGENT_DEPLOY_OMBRE_BUCKETS_DIR=${JSON.stringify(join(stateDir, 'ombre-buckets'))}`,
    'source scripts/apply-hermes-runtime-split.sh',
    'ensure_runtime_dirs',
  ].join('\n')], {
    cwd: new URL('../..', import.meta.url).pathname,
    stdio: 'pipe',
  });

  for (const relativePath of [
    'uv-cache',
    'uv-tools',
    'wechat/inbound',
    'feishu/inbound',
    'ran-agent-weixin/media',
  ]) {
    assert.equal(existsSync(join(stateDir, relativePath)), true, `${relativePath} should exist`);
  }
  assert.equal(existsSync(join(debugDir, 'wechat', 'inbound')), true);
  assert.equal(existsSync(join(debugDir, 'mimo_inbound')), true);
});

test('prepare_ombre_runtime refuses a broad recursive ownership target', () => {
  for (const target of ['/', '/opt/ran_agent/vault/ombre/../../../..']) {
    assert.throws(() => execFileSync('bash', ['-lc', [
      'set -euo pipefail',
      'export RAN_AGENT_NO_SUDO=1',
      'source scripts/apply-hermes-runtime-split.sh',
      'prepare_ombre_runtime',
    ].join('\n')], {
      cwd: new URL('../..', import.meta.url).pathname,
      env: { ...process.env, OMBRE_BUCKETS_DIR: target },
      stdio: 'pipe',
    }), /Command failed/);
  }
});

test('apply script keeps Node and Hermes marker path env consistent', () => {
  const scriptPath = new URL('../../scripts/apply-hermes-runtime-split.sh', import.meta.url).pathname;
  const script = readFileSync(scriptPath, 'utf8');
  const markerPath = 'XHS_GENERIC_FALLBACK_READY_PATH=/opt/ran_agent/.ran_agent_state/social_reader/generic-fallback-ready.json';
  const escaped = markerPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const occurrences = script.match(new RegExp(escaped, 'g')) || [];
  assert.ok(occurrences.length >= 6, 'marker path should be present in full, lite, root Node, and node_bridge env writes');
  assert.match(script, /NODE_BRIDGE_ENV_FILE="\$\{RAN_AGENT_NODE_BRIDGE_ENV_FILE:-\/opt\/ran_agent\/node_bridge\/\.env\.local\}"/);
  assert.match(script, new RegExp(`upsert_env_file "\\$NODE_BRIDGE_ENV_FILE"[\\s\\S]*"${escaped}"`));
});

test('apply script writes Hermes context optimization defaults to Node env', () => {
  const scriptPath = new URL('../../scripts/apply-hermes-runtime-split.sh', import.meta.url).pathname;
  const script = readFileSync(scriptPath, 'utf8');

  assert.match(script, /HERMES_CONTEXT_INJECTION_MODE_DEFAULT="\$\{RAN_AGENT_DEPLOY_HERMES_CONTEXT_INJECTION_MODE:-auto\}"/);
  assert.match(script, /HERMES_CONTEXT_CACHE_STRATEGY_DEFAULT="\$\{RAN_AGENT_DEPLOY_HERMES_CONTEXT_CACHE_STRATEGY:-balanced\}"/);
  assert.match(script, /HERMES_RECENT_TEXT_TURNS_DEFAULT="\$\{RAN_AGENT_DEPLOY_HERMES_RECENT_TEXT_TURNS:-4\}"/);
  assert.match(script, /HERMES_RECENT_TEXT_CHAR_BUDGET_DEFAULT="\$\{RAN_AGENT_DEPLOY_HERMES_RECENT_TEXT_CHAR_BUDGET:-2400\}"/);
  assert.match(script, /HERMES_GLOBAL_RECENT_TURNS_DEFAULT="\$\{RAN_AGENT_DEPLOY_HERMES_GLOBAL_RECENT_TURNS:-2\}"/);
  assert.match(script, /HERMES_GLOBAL_RECENT_CHAR_BUDGET_DEFAULT="\$\{RAN_AGENT_DEPLOY_HERMES_GLOBAL_RECENT_CHAR_BUDGET:-800\}"/);
  assert.match(script, /HERMES_ACTIVE_TOPIC_CHAR_BUDGET_DEFAULT="\$\{RAN_AGENT_DEPLOY_HERMES_ACTIVE_TOPIC_CHAR_BUDGET:-400\}"/);
  assert.match(script, /HERMES_CACHE_FRIENDLY_HISTORY_DEFAULT="\$\{RAN_AGENT_DEPLOY_HERMES_CACHE_FRIENDLY_HISTORY:-false\}"/);
  assert.match(script, /HERMES_CACHE_FRIENDLY_HISTORY_MAX_TURNS_DEFAULT="\$\{RAN_AGENT_DEPLOY_HERMES_CACHE_FRIENDLY_HISTORY_MAX_TURNS:-6\}"/);
  assert.match(script, /HERMES_CACHE_FRIENDLY_HISTORY_CHAR_BUDGET_DEFAULT="\$\{RAN_AGENT_DEPLOY_HERMES_CACHE_FRIENDLY_HISTORY_CHAR_BUDGET:-12000\}"/);
  assert.match(script, /HERMES_CACHE_FRIENDLY_HISTORY_PROFILE_DEFAULT="\$\{RAN_AGENT_DEPLOY_HERMES_CACHE_FRIENDLY_HISTORY_PROFILE:-lite\}"/);
  assert.match(script, /HERMES_CACHE_TELEMETRY_ENABLED_DEFAULT="\$\{RAN_AGENT_DEPLOY_HERMES_CACHE_TELEMETRY_ENABLED:-true\}"/);
  assert.match(script, /HERMES_LITE_SOFT_RESET_ENABLED_DEFAULT="\$\{RAN_AGENT_DEPLOY_HERMES_LITE_SOFT_RESET_ENABLED:-true\}"/);
  assert.match(script, /HERMES_LITE_SOFT_RESET_DRY_RUN_DEFAULT="\$\{RAN_AGENT_DEPLOY_HERMES_LITE_SOFT_RESET_DRY_RUN:-false\}"/);
  assert.match(script, /HERMES_ACTION_GATE_ENABLED_DEFAULT="\$\{RAN_AGENT_DEPLOY_HERMES_ACTION_GATE_ENABLED:-true\}"/);
  assert.match(script, /HERMES_ACTION_GATE_MODE_DEFAULT="\$\{RAN_AGENT_DEPLOY_HERMES_ACTION_GATE_MODE:-repair\}"/);
  assert.match(script, /HERMES_ACTION_GATE_MAX_REPAIR_ATTEMPTS_DEFAULT="\$\{RAN_AGENT_DEPLOY_HERMES_ACTION_GATE_MAX_REPAIR_ATTEMPTS:-1\}"/);
  assert.match(script, /HERMES_ACTION_PENDING_ENABLED_DEFAULT="\$\{RAN_AGENT_DEPLOY_HERMES_ACTION_PENDING_ENABLED:-true\}"/);
  assert.match(script, /HERMES_ACTION_PENDING_TTL_MINUTES_DEFAULT="\$\{RAN_AGENT_DEPLOY_HERMES_ACTION_PENDING_TTL_MINUTES:-30\}"/);
  assert.match(script, /NODE_BRIDGE_QUICK_ACK_ENABLED_DEFAULT=false/);
  assert.match(script, /internal_control_secret="\$\(openssl rand -hex 32\)"/);
  assert.match(script, /"RAN_AGENT_INTERNAL_CONTROL_SECRET=\$internal_control_secret"/);
  assert.match(script, /NODE_BRIDGE_QUICK_ACK_TEXT_DEFAULT="\$\{RAN_AGENT_DEPLOY_NODE_BRIDGE_QUICK_ACK_TEXT:-收到，正在处理。\}"/);
  assert.match(script, /AI_DAILY_DIGEST_ENABLED_DEFAULT="\$\{RAN_AGENT_DEPLOY_AI_DAILY_DIGEST_ENABLED:-true\}"/);
  assert.match(script, /AI_DAILY_DIGEST_HOUR_DEFAULT="\$\{RAN_AGENT_DEPLOY_AI_DAILY_DIGEST_HOUR:-8\}"/);
  assert.match(script, /AI_DAILY_DIGEST_MINUTE_DEFAULT="\$\{RAN_AGENT_DEPLOY_AI_DAILY_DIGEST_MINUTE:-0\}"/);
  assert.match(script, /HERMES_PROACTIVE_NOTIFY_MAX_CHARS_DEFAULT="\$\{RAN_AGENT_DEPLOY_HERMES_PROACTIVE_NOTIFY_MAX_CHARS:-1600\}"/);
  assert.match(script, /EXTERNAL_MCP_ACTIVITY_RUNNER_ENABLED_DEFAULT="\$\{RAN_AGENT_DEPLOY_EXTERNAL_MCP_ACTIVITY_RUNNER_ENABLED:-true\}"/);
  assert.match(script, /EXTERNAL_MCP_ACTIVITY_TICK_MS_DEFAULT="\$\{RAN_AGENT_DEPLOY_EXTERNAL_MCP_ACTIVITY_TICK_MS:-60000\}"/);
  assert.match(script, /"HERMES_ACTION_GATE_ENABLED=\$HERMES_ACTION_GATE_ENABLED_DEFAULT"/);
  assert.match(script, /"HERMES_ACTION_GATE_MODE=\$HERMES_ACTION_GATE_MODE_DEFAULT"/);
  assert.match(script, /"HERMES_ACTION_GATE_MAX_REPAIR_ATTEMPTS=\$HERMES_ACTION_GATE_MAX_REPAIR_ATTEMPTS_DEFAULT"/);
  assert.match(script, /"HERMES_ACTION_PENDING_ENABLED=\$HERMES_ACTION_PENDING_ENABLED_DEFAULT"/);
  assert.match(script, /"HERMES_ACTION_PENDING_TTL_MINUTES=\$HERMES_ACTION_PENDING_TTL_MINUTES_DEFAULT"/);
  assert.match(script, /"HERMES_CONTEXT_CACHE_STRATEGY=\$HERMES_CONTEXT_CACHE_STRATEGY_DEFAULT"/);
  assert.match(script, /"HERMES_CACHE_FRIENDLY_HISTORY=\$HERMES_CACHE_FRIENDLY_HISTORY_DEFAULT"/);
  assert.match(script, /"HERMES_CACHE_FRIENDLY_HISTORY_MAX_TURNS=\$HERMES_CACHE_FRIENDLY_HISTORY_MAX_TURNS_DEFAULT"/);
  assert.match(script, /"HERMES_CACHE_FRIENDLY_HISTORY_CHAR_BUDGET=\$HERMES_CACHE_FRIENDLY_HISTORY_CHAR_BUDGET_DEFAULT"/);
  assert.match(script, /"HERMES_CACHE_FRIENDLY_HISTORY_PROFILE=\$HERMES_CACHE_FRIENDLY_HISTORY_PROFILE_DEFAULT"/);
  assert.match(script, /"HERMES_CACHE_TELEMETRY_ENABLED=\$HERMES_CACHE_TELEMETRY_ENABLED_DEFAULT"/);
  assert.match(script, /"HERMES_PROACTIVE_NOTIFY_MAX_CHARS=\$HERMES_PROACTIVE_NOTIFY_MAX_CHARS_DEFAULT"/);
  assert.match(script, /"EXTERNAL_MCP_ACTIVITY_RUNNER_ENABLED=\$EXTERNAL_MCP_ACTIVITY_RUNNER_ENABLED_DEFAULT"/);
  assert.match(script, /"EXTERNAL_MCP_ACTIVITY_TICK_MS=\$EXTERNAL_MCP_ACTIVITY_TICK_MS_DEFAULT"/);
  assert.match(script, /"AI_DAILY_DIGEST_ENABLED=\$AI_DAILY_DIGEST_ENABLED_DEFAULT"/);
  assert.match(script, /"AI_DAILY_DIGEST_HOUR=\$AI_DAILY_DIGEST_HOUR_DEFAULT"/);
  assert.match(script, /"AI_DAILY_DIGEST_MINUTE=\$AI_DAILY_DIGEST_MINUTE_DEFAULT"/);
  assert.match(script, /upsert_env_file "\$NODE_ENV_FILE"[\s\S]*"AI_DAILY_DIGEST_ENABLED=\$AI_DAILY_DIGEST_ENABLED_DEFAULT"[\s\S]*"AI_DAILY_DIGEST_HOUR=\$AI_DAILY_DIGEST_HOUR_DEFAULT"[\s\S]*"AI_DAILY_DIGEST_MINUTE=\$AI_DAILY_DIGEST_MINUTE_DEFAULT"/);
  assert.match(script, /upsert_env_file "\$NODE_BRIDGE_ENV_FILE"[\s\S]*"PERSONAL_AGENT_PROACTIVE_ENABLED=false"/);
  assert.doesNotMatch(script, /"HERMES_RECENT_TEXT_TURNS=10"/);
  assert.doesNotMatch(script, /"HERMES_RECENT_TEXT_CHAR_BUDGET=6000"/);
  assert.doesNotMatch(script, /"HERMES_GLOBAL_RECENT_TURNS=6"/);
  assert.doesNotMatch(script, /"HERMES_GLOBAL_RECENT_CHAR_BUDGET=2500"/);
  assert.doesNotMatch(script, /"HERMES_ACTIVE_TOPIC_CHAR_BUDGET=1200"/);
});

test('apply script context defaults do not inherit stale HERMES env values', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-stale-context-env-'));
  const envFile = join(dir, '.env');
  writeFileSync(envFile, [
    'HERMES_CONTEXT_INJECTION_MODE=auto',
    'HERMES_CONTEXT_CACHE_STRATEGY=cache_first',
    'HERMES_RECENT_TEXT_TURNS=10',
    'HERMES_RECENT_TEXT_CHAR_BUDGET=6000',
    'HERMES_GLOBAL_RECENT_TURNS=6',
    'HERMES_GLOBAL_RECENT_CHAR_BUDGET=2500',
    'HERMES_ACTIVE_TOPIC_CHAR_BUDGET=1200',
    'HERMES_CACHE_FRIENDLY_HISTORY=true',
    'HERMES_CACHE_TELEMETRY_ENABLED=false',
  ].join('\n'));

  execFileSync('bash', ['-lc', [
    'set -euo pipefail',
    'export RAN_AGENT_NO_SUDO=1',
    'export HERMES_RECENT_TEXT_TURNS=10',
    'export HERMES_RECENT_TEXT_CHAR_BUDGET=6000',
    'export HERMES_GLOBAL_RECENT_TURNS=6',
    'export HERMES_GLOBAL_RECENT_CHAR_BUDGET=2500',
    'export HERMES_ACTIVE_TOPIC_CHAR_BUDGET=1200',
    'source scripts/apply-hermes-runtime-split.sh',
    [
      'upsert_env_file',
      JSON.stringify(envFile),
      '"HERMES_CONTEXT_INJECTION_MODE=$HERMES_CONTEXT_INJECTION_MODE_DEFAULT"',
      '"HERMES_CONTEXT_CACHE_STRATEGY=$HERMES_CONTEXT_CACHE_STRATEGY_DEFAULT"',
      '"HERMES_RECENT_TEXT_TURNS=$HERMES_RECENT_TEXT_TURNS_DEFAULT"',
      '"HERMES_RECENT_TEXT_CHAR_BUDGET=$HERMES_RECENT_TEXT_CHAR_BUDGET_DEFAULT"',
      '"HERMES_GLOBAL_RECENT_TURNS=$HERMES_GLOBAL_RECENT_TURNS_DEFAULT"',
      '"HERMES_GLOBAL_RECENT_CHAR_BUDGET=$HERMES_GLOBAL_RECENT_CHAR_BUDGET_DEFAULT"',
      '"HERMES_ACTIVE_TOPIC_CHAR_BUDGET=$HERMES_ACTIVE_TOPIC_CHAR_BUDGET_DEFAULT"',
      '"HERMES_CACHE_FRIENDLY_HISTORY=$HERMES_CACHE_FRIENDLY_HISTORY_DEFAULT"',
      '"HERMES_CACHE_TELEMETRY_ENABLED=$HERMES_CACHE_TELEMETRY_ENABLED_DEFAULT"',
    ].join(' '),
  ].join('\n')], {
    cwd: new URL('../..', import.meta.url).pathname,
    stdio: 'pipe',
  });

  const text = readFileSync(envFile, 'utf8');
  assert.match(text, /HERMES_CONTEXT_INJECTION_MODE=auto/);
  assert.match(text, /HERMES_CONTEXT_CACHE_STRATEGY=balanced/);
  assert.match(text, /HERMES_RECENT_TEXT_TURNS=4/);
  assert.match(text, /HERMES_RECENT_TEXT_CHAR_BUDGET=2400/);
  assert.match(text, /HERMES_GLOBAL_RECENT_TURNS=2/);
  assert.match(text, /HERMES_GLOBAL_RECENT_CHAR_BUDGET=800/);
  assert.match(text, /HERMES_ACTIVE_TOPIC_CHAR_BUDGET=400/);
  assert.match(text, /HERMES_CACHE_FRIENDLY_HISTORY=false/);
  assert.match(text, /HERMES_CACHE_TELEMETRY_ENABLED=true/);
  assert.doesNotMatch(text, /HERMES_RECENT_TEXT_TURNS=10/);
  assert.doesNotMatch(text, /HERMES_CONTEXT_CACHE_STRATEGY=cache_first/);
  assert.doesNotMatch(text, /HERMES_RECENT_TEXT_CHAR_BUDGET=6000/);
  assert.doesNotMatch(text, /HERMES_GLOBAL_RECENT_TURNS=6/);
  assert.doesNotMatch(text, /HERMES_GLOBAL_RECENT_CHAR_BUDGET=2500/);
  assert.doesNotMatch(text, /HERMES_ACTIVE_TOPIC_CHAR_BUDGET=1200/);
  assert.doesNotMatch(text, /HERMES_CACHE_FRIENDLY_HISTORY=true/);
  assert.doesNotMatch(text, /HERMES_CACHE_TELEMETRY_ENABLED=false/);
});

test('soft reset timer installer writes 05:00 apply timer and enables Node runtime env', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-soft-reset-timer-'));
  const systemdDir = join(dir, 'systemd');
  const nodeEnvFile = join(dir, '.env.local');
  const nodeBridgeEnvFile = join(dir, 'node_bridge.env.local');
  writeFileSync(nodeEnvFile, [
    'HERMES_LITE_SOFT_RESET_ENABLED=false',
    'HERMES_LITE_SOFT_RESET_DRY_RUN=true',
    'KEEP_ME=yes',
  ].join('\n'));
  writeFileSync(nodeBridgeEnvFile, 'KEEP_BRIDGE=yes\n');

  execFileSync('bash', ['scripts/install-hermes-lite-soft-reset-timer.sh', '--install', '--time', '05:00'], {
    cwd: new URL('../..', import.meta.url).pathname,
    env: {
      ...process.env,
      RAN_AGENT_NO_SUDO: '1',
      RAN_AGENT_NO_SYSTEMCTL: '1',
      SYSTEMD_DIR: systemdDir,
      RAN_AGENT_NODE_ENV_FILE: nodeEnvFile,
      RAN_AGENT_NODE_BRIDGE_ENV_FILE: nodeBridgeEnvFile,
      RAN_AGENT_RUNTIME_USER: 'ran-agent-test-user-does-not-exist',
    },
    stdio: 'pipe',
  });

  const service = readFileSync(join(systemdDir, 'ran-agent-hermes-lite-soft-reset.service'), 'utf8');
  const timer = readFileSync(join(systemdDir, 'ran-agent-hermes-lite-soft-reset.timer'), 'utf8');
  const nodeEnv = readFileSync(nodeEnvFile, 'utf8');
  const bridgeEnv = readFileSync(nodeBridgeEnvFile, 'utf8');

  assert.match(service, /ExecStart=\/bin\/bash \/opt\/ran_agent\/scripts\/hermes-lite-soft-reset\.sh --apply/);
  assert.match(service, /Environment=HERMES_LITE_SOFT_RESET_ENABLED=true/);
  assert.match(service, /Environment=HERMES_LITE_SOFT_RESET_DRY_RUN=false/);
  assert.match(timer, /OnCalendar=\*-\*-\* 05:00:00/);
  assert.match(timer, /Persistent=true/);
  assert.match(nodeEnv, /KEEP_ME=yes/);
  assert.match(nodeEnv, /HERMES_LITE_SOFT_RESET_ENABLED=true/);
  assert.match(nodeEnv, /HERMES_LITE_SOFT_RESET_DRY_RUN=false/);
  assert.match(bridgeEnv, /KEEP_BRIDGE=yes/);
  assert.match(bridgeEnv, /HERMES_LITE_SOFT_RESET_ENABLED=true/);
  assert.match(bridgeEnv, /HERMES_LITE_SOFT_RESET_DRY_RUN=false/);
});

test('manual Hermes lite soft reset script calls the authenticated loopback endpoint with CAS', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-soft-reset-manual-env-'));
  const nodeEnvFile = join(dir, '.env.local');
  const nodeBridgeEnvFile = join(dir, 'node_bridge.env.local');
  const fakeCurl = join(dir, 'curl');
  const callsFile = join(dir, 'curl.calls');
  writeFileSync(nodeEnvFile, [
    'HERMES_LITE_SOFT_RESET_ENABLED=true',
    'HERMES_LITE_SOFT_RESET_DRY_RUN=false',
    'RAN_AGENT_INTERNAL_CONTROL_SECRET=owner-control-secret',
  ].join('\n'));
  writeFileSync(nodeBridgeEnvFile, 'NODE_BRIDGE_OUTBOUND_HOST=127.0.0.2\nNODE_BRIDGE_OUTBOUND_PORT=9901\n');
  writeFileSync(fakeCurl, [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> ${JSON.stringify(callsFile)}`,
    'case "$*" in',
    '  *\\"action\\":\\"status\\"*) printf \'{"ok":true,"revision":7}\\n\' ;;',
    '  *) printf \'{"ok":true,"applied":true,"revision":8}\\n\' ;;',
    'esac',
  ].join('\n'));
  chmodSync(fakeCurl, 0o755);

  const output = execFileSync('bash', ['scripts/hermes-lite-soft-reset.sh', '--apply'], {
    cwd: new URL('../..', import.meta.url).pathname,
    env: {
      ...process.env,
      RAN_AGENT_SKIP_ENV_FILE_LOAD: '',
      CURL_BIN: fakeCurl,
      RAN_AGENT_NODE_ENV_FILE: nodeEnvFile,
      RAN_AGENT_NODE_BRIDGE_ENV_FILE: nodeBridgeEnvFile,
    },
    encoding: 'utf8',
  }).trim();

  assert.equal(output, '{"ok":true,"applied":true,"revision":8}');
  const calls = readFileSync(callsFile, 'utf8');
  assert.match(calls, /http:\/\/127\.0\.0\.2:9901\/control\/hermes-lite-soft-reset/);
  assert.match(calls, /Authorization: Bearer owner-control-secret/);
  assert.match(calls, /"action":"status"/);
  assert.match(calls, /"action":"apply","expectedRevision":7/);
  const script = readFileSync(new URL('../../scripts/hermes-lite-soft-reset.sh', import.meta.url), 'utf8');
  assert.doesNotMatch(script, /hermes-lite-soft-reset\.mjs/);
  assert.doesNotMatch(script, /127\.\*|localhost/);
  const retiredDirectWriter = readFileSync(new URL('../../scripts/hermes-lite-soft-reset.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(retiredDirectWriter, /runHermesLiteSoftReset|hermesSessionMaintenance/);
  assert.match(retiredDirectWriter, /direct_soft_reset_writer_retired/);
});

test('apply script wraps XHS generic fallback prepare with timeout and keeps failure non-blocking', () => {
  const scriptPath = new URL('../../scripts/apply-hermes-runtime-split.sh', import.meta.url).pathname;
  const script = readFileSync(scriptPath, 'utf8');
  assert.match(script, /XHS_GENERIC_FALLBACK_PREPARE_TIMEOUT_SECONDS="\$\{XHS_GENERIC_FALLBACK_PREPARE_TIMEOUT_SECONDS:-120\}"/);
  assert.match(script, /timeout "\$XHS_GENERIC_FALLBACK_PREPARE_TIMEOUT_SECONDS" bash "\$REPO_ROOT\/scripts\/prepare-xhs-generic-fallback\.sh"/);
  assert.match(script, /WARNING: XHS generic fallback preparation failed or timed out \(non-blocking\)/);
  assert.match(script, /restart_services/);
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

test('apply script filter_obsidian_memory_from_config removes obsidian_memory from toolsets and mcp_servers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'obsidian-filter-'));
  const configFile = join(dir, 'config.yaml');
  writeFileSync(configFile, [
    'platform_toolsets:',
    '  cli:',
    '    - mcp-search_hub',
    '    - mcp-obsidian_memory',
    '    - mcp-playwright',
    '  gateway:',
    '    - mcp-search_hub',
    '    - mcp-obsidian_memory',
    '    - mcp-playwright',
    '',
    'mcp_servers:',
    '  search_hub:',
    '    command: bash',
    '    args: ["-lc", "echo search_hub"]',
    '    timeout: 30',
    '  obsidian_memory:',
    '    command: bash',
    '    args: ["-lc", "echo obsidian"]',
    '    timeout: 180',
    '  playwright:',
    '    command: npx',
    '    args: ["@anthropic-ai/mcp-playwright"]',
    '    timeout: 60',
  ].join('\n'));

  execFileSync('bash', ['-lc', [
    'set -euo pipefail',
    'export RAN_AGENT_NO_SUDO=1',
    'source scripts/apply-hermes-runtime-split.sh',
    `filter_obsidian_memory_from_config ${JSON.stringify(configFile)}`,
  ].join('\n')], {
    cwd: new URL('../..', import.meta.url).pathname,
    stdio: 'pipe',
  });

  const text = readFileSync(configFile, 'utf8');
  // obsidian_memory removed from toolsets
  assert.doesNotMatch(text, /mcp-obsidian_memory/);
  // obsidian_memory removed from mcp_servers
  assert.doesNotMatch(text, /obsidian_memory:/);
  // search_hub and playwright preserved
  assert.match(text, /mcp-search_hub/);
  assert.match(text, /mcp-playwright/);
  assert.match(text, /search_hub:/);
  assert.match(text, /playwright:/);
});

test('apply script filter_obsidian_memory_from_config preserves other MCP servers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'obsidian-filter-keep-'));
  const configFile = join(dir, 'config.yaml');
  writeFileSync(configFile, [
    'platform_toolsets:',
    '  gateway:',
    '    - mcp-search_hub',
    '    - mcp-media_generation',
    '    - mcp-obsidian_memory',
    '    - mcp-personal_memory',
    '',
    'mcp_servers:',
    '  search_hub:',
    '    command: bash',
    '    timeout: 30',
    '  media_generation:',
    '    command: bash',
    '    timeout: 60',
    '  obsidian_memory:',
    '    command: bash',
    '    timeout: 180',
    '  personal_memory:',
    '    command: bash',
    '    timeout: 30',
  ].join('\n'));

  execFileSync('bash', ['-lc', [
    'set -euo pipefail',
    'export RAN_AGENT_NO_SUDO=1',
    'source scripts/apply-hermes-runtime-split.sh',
    `filter_obsidian_memory_from_config ${JSON.stringify(configFile)}`,
  ].join('\n')], {
    cwd: new URL('../..', import.meta.url).pathname,
    stdio: 'pipe',
  });

  const text = readFileSync(configFile, 'utf8');
  assert.doesNotMatch(text, /mcp-obsidian_memory/);
  assert.doesNotMatch(text, /  obsidian_memory:/);
  assert.match(text, /mcp-search_hub/);
  assert.match(text, /mcp-media_generation/);
  assert.match(text, /mcp-personal_memory/);
  assert.match(text, /  personal_memory:/);
});

test('apply script preserves optional Ombre env values and pins the loopback MCP contract', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ombre-env-upsert-'));
  const envFile = join(dir, '.env');
  writeFileSync(envFile, [
    'OMBRE_BRAIN_ENABLED=false',
    'OMBRE_BRAIN_PORT=19999',
    'OMBRE_BRAIN_REPO_URL=https://github.com/P0luz/Ombre-Brain',
  ].join('\n'));

  execFileSync('bash', ['-lc', [
    'set -euo pipefail',
    'export RAN_AGENT_NO_SUDO=1',
    'source scripts/apply-hermes-runtime-split.sh',
    [
      'upsert_env_file',
      JSON.stringify(envFile),
      '"?OMBRE_BRAIN_ENABLED=$OMBRE_BRAIN_ENABLED_DEFAULT"',
      '"?OMBRE_BRAIN_PORT=$OMBRE_BRAIN_PORT_DEFAULT"',
      '"OMBRE_BIND_HOST=$OMBRE_BIND_HOST_DEFAULT"',
      '"OMBRE_MCP_REQUIRE_AUTH=$OMBRE_MCP_REQUIRE_AUTH_DEFAULT"',
      '"OMBRE_BRAIN_MCP_URL=$OMBRE_BRAIN_MCP_URL_DEFAULT"',
      '"OMBRE_RECALL_MCP_URL=$OMBRE_RECALL_MCP_URL_DEFAULT"',
      '"?PERSONAL_AGENT_OMBRE_MAX_CHARS=$PERSONAL_AGENT_OMBRE_MAX_CHARS_DEFAULT"',
    ].join(' '),
  ].join('\n')], {
    cwd: new URL('../..', import.meta.url).pathname,
    stdio: 'pipe',
  });

  const text = readFileSync(envFile, 'utf8');
  assert.match(text, /OMBRE_BRAIN_ENABLED=false/);
  assert.match(text, /OMBRE_BRAIN_PORT=19999/);
  assert.match(text, /OMBRE_BIND_HOST=127\.0\.0\.1/);
  assert.match(text, /OMBRE_MCP_REQUIRE_AUTH=false/);
  assert.match(text, /OMBRE_BRAIN_MCP_URL=http:\/\/127\.0\.0\.1:18001\/mcp/);
  assert.match(text, /OMBRE_RECALL_MCP_URL=http:\/\/127\.0\.0\.1:18002\/mcp/);
  assert.match(text, /PERSONAL_AGENT_OMBRE_MAX_CHARS=900/);
  assert.doesNotMatch(text, /OMBRE_BRAIN_PORT=18001/);
});

test('apply script enforces the unauthenticated loopback-only Ombre contract', () => {
  for (const exports of [
    ['OMBRE_BIND_HOST=0.0.0.0', 'OMBRE_BRAIN_MCP_URL=http://0.0.0.0:18001/mcp'],
    ['OMBRE_BRAIN_HEALTH_URL=http://example.invalid/health'],
    ['OMBRE_RECALL_MCP_URL=http://example.invalid/mcp'],
    ['OMBRE_RECALL_HEALTH_URL=http://example.invalid/health'],
    ['OMBRE_MCP_REQUIRE_AUTH=true'],
  ]) {
    assert.throws(() => execFileSync('bash', ['-lc', [
      'set -euo pipefail',
      'export RAN_AGENT_NO_SUDO=1',
      'export OMBRE_MCP_REQUIRE_AUTH=false',
      ...exports.map((entry) => `export ${entry}`),
      'source scripts/apply-hermes-runtime-split.sh',
      'validate_ombre_network_contract',
    ].join('\n')], {
      cwd: new URL('../..', import.meta.url).pathname,
      stdio: 'pipe',
    }));
  }
});

test('apply script keeps full recall-only Ombre MCP when source runner is prepared', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ombre-full-source-ready-'));
  const fullHome = join(dir, 'full');
  const liteHome = join(dir, 'lite');
  const sourceDir = join(dir, 'upstream');
  const venvDir = join(dir, 'venv');
  mkdirSync(join(fullHome, 'profiles', 'ran-assistant'), { recursive: true });
  mkdirSync(join(liteHome, 'profiles', 'ran-assistant-lite'), { recursive: true });
  mkdirSync(join(sourceDir, 'src'), { recursive: true });
  mkdirSync(join(venvDir, 'bin'), { recursive: true });
  writeFileSync(join(fullHome, 'config.yaml'), '');
  writeFileSync(join(sourceDir, 'src', 'server.py'), '');
  writeFileSync(join(venvDir, 'bin', 'python'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(venvDir, 'bin', 'python'), 0o755);
  writeFileSync(join(fullHome, 'profiles', 'ran-assistant', 'config.yaml'), [
    'mcp_servers:',
    '  ombre_memory:',
    '    url: "${OMBRE_RECALL_MCP_URL}"',
    '  search_hub:',
    '    command: bash',
    '  sticker_catalog:',
    '    command: bash',
    '  playwright:',
    '    command: bash',
  ].join('\n'));

  execFileSync('bash', ['-lc', [
    'set -euo pipefail',
    'export RAN_AGENT_NO_SUDO=1',
    `export HERMES_HOME=${JSON.stringify(fullHome)}`,
    `export HERMES_LITE_HOME=${JSON.stringify(liteHome)}`,
    `export RAN_AGENT_DEPLOY_OMBRE_BRAIN_SOURCE_DIR=${JSON.stringify(sourceDir)}`,
    `export RAN_AGENT_DEPLOY_OMBRE_BRAIN_VENV=${JSON.stringify(venvDir)}`,
    'source scripts/apply-hermes-runtime-split.sh',
    'write_full_runtime_config',
  ].join('\n')], {
    cwd: new URL('../..', import.meta.url).pathname,
    stdio: 'pipe',
  });

  const text = readFileSync(join(fullHome, 'config.yaml'), 'utf8');
  assert.match(text, /mcp-ombre_memory/);
  assert.match(text, /^  ombre_memory:/m);
  assert.match(text, /\$\{OMBRE_RECALL_MCP_URL\}/);
  assert.doesNotMatch(text, /\$\{OMBRE_BRAIN_MCP_URL\}/);
  assert.doesNotMatch(text, new RegExp([['ombre_memory', 'extra'].join('_'), ['mcp', 'extra'].join('-')].join('|')));
});

test('apply script writes the pinned source/loopback/auth Ombre systemd contract', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ombre-systemd-'));
  const systemdDir = join(dir, 'systemd');
  const expectedStateDir = process.env.RAN_AGENT_STATE_DIR || '/opt/ran_agent/.ran_agent_state';
  mkdirSync(systemdDir, { recursive: true });

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

  const unit = readFileSync(join(systemdDir, 'ran-agent-ombre-brain.service'), 'utf8');
  const liteUnit = readFileSync(join(systemdDir, 'ran-agent-hermes.service'), 'utf8');
  const fullUnit = readFileSync(join(systemdDir, 'ran-agent-hermes-full.service'), 'utf8');
  assert.match(unit, /Description=Ran Agent Ombre Brain Memory Service/);
  assert.match(unit, /EnvironmentFile=-\/opt\/ran_agent\/\.env\.local/);
  assert.equal(unit.match(/^ExecStart=.*$/m)?.[0], `ExecStart=/usr/bin/bash /opt/ran_agent/scripts/start_ombre_brain_service.sh --managed /opt/ran_agent ${expectedStateDir} /opt/ran_agent/vault/ombre`);
  assert.doesNotMatch(unit, /bash -lc|source \/opt\/ran_agent\/\.venv\/bin\/activate/);
  assert.match(unit, /^UnsetEnvironment=BASH_ENV ENV BASHOPTS SHELLOPTS BASH_XTRACEFD PYTHONHOME PYTHONPATH PYTHONSTARTUP LD_PRELOAD LD_LIBRARY_PATH$/m);
  assert.match(unit, /^Environment=OMBRE_BRAIN_RUNNER=source$/m);
  assert.match(unit, /^Environment=OMBRE_BRAIN_COMMIT=0e83d4671ce1629e03ad36bb9160235bf60dbd34$/m);
  assert.match(unit, /^Environment=OMBRE_BIND_HOST=127\.0\.0\.1$/m);
  assert.match(unit, /^Environment=OMBRE_MCP_REQUIRE_AUTH=false$/m);
  assert.match(unit, /^Environment=OMBRE_TRANSPORT=streamable-http$/m);
  assert.match(unit, /^Environment=OMBRE_PORT=18001$/m);
  assert.equal(unit.match(/^Environment=OMBRE_CONFIG_PATH=.*$/m)?.[0], `Environment=OMBRE_CONFIG_PATH=${expectedStateDir}/ombre-brain/config.yaml`);
  assert.match(unit, /^Environment=OMBRE_VAULT_DIR=\/opt\/ran_agent\/vault\/ombre$/m);
  assert.match(unit, /^StartLimitIntervalSec=30$/m);
  assert.match(unit, /^StartLimitBurst=3$/m);
  assert.match(liteUnit, /After=.*ran-agent-ombre-brain\.service/);
  assert.match(fullUnit, /After=.*ran-agent-ombre-brain\.service/);
});

test('apply script skips reset-failed for systemd units that are not loaded yet', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ombre-reset-failed-'));
  const binDir = join(dir, 'bin');
  const logFile = join(dir, 'systemctl.log');
  mkdirSync(binDir, { recursive: true });
  const fakeSystemctl = join(binDir, 'systemctl');
  writeFileSync(fakeSystemctl, [
    '#!/bin/sh',
    'printf "%s\\n" "$*" >> "$SYSTEMCTL_LOG"',
    'if [ "$1" = "show" ]; then',
    '  case "$2" in',
    '    ran-agent-ombre-brain.service)',
    '      printf "%s\\n" "not-found"',
    '      exit 0',
    '      ;;',
    '    *)',
    '      printf "%s\\n" "loaded"',
    '      exit 0',
    '      ;;',
    '  esac',
    'fi',
    'if [ "$1" = "reset-failed" ] && [ "$2" = "ran-agent-ombre-brain.service" ]; then',
    '  printf "%s\\n" "Failed to reset failed state of unit ran-agent-ombre-brain.service: Unit ran-agent-ombre-brain.service not loaded." >&2',
    '  exit 1',
    'fi',
    'exit 0',
    '',
  ].join('\n'));
  chmodSync(fakeSystemctl, 0o755);

  execFileSync('bash', ['-lc', [
    'set -euo pipefail',
    'export RAN_AGENT_NO_SUDO=1',
    'source scripts/apply-hermes-runtime-split.sh',
    'reset_failed_if_loaded ran-agent-hermes.service ran-agent-ombre-brain.service',
  ].join('\n')], {
    cwd: new URL('../..', import.meta.url).pathname,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      SYSTEMCTL_LOG: logFile,
    },
    stdio: 'pipe',
  });

  const log = readFileSync(logFile, 'utf8');
  assert.match(log, /show ran-agent-hermes\.service --property=LoadState --value/);
  assert.match(log, /reset-failed ran-agent-hermes\.service/);
  assert.match(log, /show ran-agent-ombre-brain\.service --property=LoadState --value/);
  assert.doesNotMatch(log, /reset-failed ran-agent-ombre-brain\.service/);
});

test('start_ombre_brain_service.sh runs the prepared managed source without preparing again', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ombre-source-runner-'));
  const rootDir = join(dir, 'repo');
  const stateDir = join(dir, 'custom-live-state');
  const homeDir = join(stateDir, 'ombre-brain');
  const sourceDir = join(homeDir, 'upstream');
  const venvDir = join(homeDir, '.venv');
  const logFile = join(dir, 'python.log');
  mkdirSync(join(rootDir, 'scripts'), { recursive: true });
  mkdirSync(join(rootDir, 'node_bridge'), { recursive: true });
  mkdirSync(join(sourceDir, 'src'), { recursive: true });
  mkdirSync(join(venvDir, 'bin'), { recursive: true });
  writeFileSync(join(rootDir, '.env.local'), 'exit 97\n');
  writeFileSync(join(rootDir, 'node_bridge', '.env.local'), 'exit 98\n');
  writeFileSync(join(homeDir, 'config.yaml'), 'transport: stdio\n');
  writeFileSync(join(sourceDir, 'src', 'server.py'), 'print("server placeholder")\n');
  writeFileSync(join(venvDir, 'bin', 'python'), [
    '#!/bin/sh',
    'printf "%s\\n" "$PWD|$*|$OMBRE_TRANSPORT|$OMBRE_PORT|$OMBRE_CONFIG_PATH|$OMBRE_VAULT_DIR|$OMBRE_BUCKETS_DIR" > "$OMBRE_TEST_LOG"',
    'exit 0',
    '',
  ].join('\n'));
  chmodSync(join(venvDir, 'bin', 'python'), 0o755);
  writeFileSync(join(rootDir, 'scripts', 'prepare-ombre-brain.sh'), '#!/bin/sh\nexit 99\n');
  chmodSync(join(rootDir, 'scripts', 'prepare-ombre-brain.sh'), 0o755);

  execFileSync('/bin/bash', [
    'scripts/start_ombre_brain_service.sh',
    '--managed', rootDir, stateDir, join(dir, 'buckets'),
  ], {
    cwd: new URL('../..', import.meta.url).pathname,
    env: {
      ...process.env,
      RAN_AGENT_REPO_ROOT: '',
      RAN_AGENT_STATE_DIR: '/ignored/env/state',
      RAN_AGENT_MANAGED_OMBRE_RUNTIME: '0',
      OMBRE_BRAIN_ENABLED: 'false',
      OMBRE_BRAIN_HOME: '/ignored/env/home',
      OMBRE_BRAIN_RUNNER: 'source',
      OMBRE_BRAIN_SOURCE_DIR: '/conflicting/source',
      OMBRE_BRAIN_VENV: '/conflicting/venv',
      OMBRE_TEST_LOG: logFile,
      PYTHONHOME: '/poison/python-home',
      PYTHONPATH: '/poison/python-path',
      PATH: '/poison/path',
    },
    stdio: 'pipe',
  });

  const log = readFileSync(logFile, 'utf8');
  assert.equal(
    log.trim(),
    `${sourceDir}|-E -s src/server.py|streamable-http|18001|${homeDir}/config.yaml|${join(dir, 'buckets')}|${join(dir, 'buckets')}`,
  );
});

test('diagnose-ombre-memory.sh keeps full config path separate from lite env HERMES_HOME', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ombre-diagnose-paths-'));
  const rootDir = join(dir, 'repo');
  const stateDir = join(dir, 'custom-live-state');
  const fullHome = join(dir, 'full-home');
  const liteHome = join(dir, 'lite-home');
  mkdirSync(rootDir, { recursive: true });
  mkdirSync(fullHome, { recursive: true });
  mkdirSync(liteHome, { recursive: true });
  writeFileSync(join(fullHome, '.env'), `HERMES_HOME=${fullHome}\n`);
  writeFileSync(join(liteHome, '.env'), `HERMES_HOME=${liteHome}\n`);
  writeFileSync(join(fullHome, 'config.yaml'), 'platform_toolsets:\n  cli: []\nmcp_servers: {}\n');
  writeFileSync(join(liteHome, 'config.yaml'), 'platform_toolsets:\n  cli: []\nmcp_servers: {}\n');
  const statusFile = join(stateDir, 'ombre-brain', 'status.json');
  mkdirSync(dirname(statusFile), { recursive: true });
  writeFileSync(statusFile, JSON.stringify({
    schema_version: 1,
    deploy_ready: false,
    needs_update: true,
    repo: { update: 'timeout', after: 'abc123', remote: 'def456' },
    requirements: { install: 'skipped_unchanged' },
    warnings: ['source_update_timeout'],
  }));

  const output = execFileSync('bash', ['scripts/diagnose-ombre-memory.sh'], {
    cwd: new URL('../..', import.meta.url).pathname,
    env: {
      ...process.env,
      RAN_AGENT_REPO_ROOT: rootDir,
      RAN_AGENT_STATE_DIR: stateDir,
      HERMES_HOME: fullHome,
      HERMES_LITE_HOME: liteHome,
      OMBRE_BRAIN_ENABLED: 'false',
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  assert.match(output, new RegExp(`--- lite: ${liteHome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/config\\.yaml ---`));
  assert.match(output, new RegExp(`--- full: ${fullHome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/config\\.yaml ---`));
  assert.match(output, /=== Status ===/);
  assert.match(output, /deploy_ready: false/);
  assert.match(output, /needs_update: true/);
  assert.match(output, /repo_update: timeout/);
  assert.match(output, /warnings: PRESENT/);
});

test('prepare-ombre-brain.sh rejects Docker without creating a parallel O1 runtime', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ombre-prepare-'));
  const rootDir = join(dir, 'repo');
  const stateDir = join(dir, 'custom-live-state');
  const homeDir = join(stateDir, 'ombre-brain');
  const bucketsDir = join(dir, 'vault', 'ombre');
  mkdirSync(rootDir, { recursive: true });

  assert.throws(() => {
    execFileSync('bash', ['scripts/prepare-ombre-brain.sh'], {
      cwd: new URL('../..', import.meta.url).pathname,
      env: {
        ...process.env,
        RAN_AGENT_REPO_ROOT: rootDir,
        RAN_AGENT_STATE_DIR: stateDir,
        OMBRE_BRAIN_RUNNER: 'docker',
        OMBRE_BRAIN_HOME: homeDir,
        OMBRE_BUCKETS_DIR: bucketsDir,
        OMBRE_COMPRESS_API_KEY: 'must-not-be-written',
        OMBRE_DASHBOARD_PASSWORD: 'must-not-be-written',
      },
      stdio: 'pipe',
    });
  }, /Command failed/);
  assert.equal(existsSync(join(homeDir, 'docker-compose.yml')), false);
  assert.equal(existsSync(join(homeDir, 'status.json')), false);
});

test('prepare-ombre-brain.sh fails closed when timed-out source cannot prove the pinned commit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ombre-update-timeout-'));
  const rootDir = join(dir, 'repo');
  const stateDir = join(dir, 'custom-live-state');
  const homeDir = join(stateDir, 'ombre-brain');
  const sourceDir = join(homeDir, 'upstream');
  const binDir = join(dir, 'bin');
  const timeoutLog = join(dir, 'timeout.log');
  mkdirSync(join(sourceDir, 'src'), { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(sourceDir, 'src', 'server.py'), '');
  execFileSync('git', ['init'], { cwd: sourceDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'ombre-test@example.invalid'], { cwd: sourceDir });
  execFileSync('git', ['config', 'user.name', 'Ombre test'], { cwd: sourceDir });
  execFileSync('git', ['add', 'src/server.py'], { cwd: sourceDir });
  execFileSync('git', ['commit', '-m', 'fixed fixture'], { cwd: sourceDir, stdio: 'pipe' });
  const fixedCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceDir, encoding: 'utf8' }).trim();
  writeFileSync(join(binDir, 'timeout'), [
    '#!/usr/bin/env bash',
    `printf '%s\\n' "$*" >> ${JSON.stringify(timeoutLog)}`,
    'exit 124',
  ].join('\n'));
  chmodSync(join(binDir, 'timeout'), 0o755);
  writeFileSync(join(binDir, 'python312'), '#!/bin/sh\nprintf "3.12\\n"\n');
  chmodSync(join(binDir, 'python312'), 0o755);

  assert.throws(() => execFileSync('bash', ['scripts/prepare-ombre-brain.sh'], {
    cwd: new URL('../..', import.meta.url).pathname,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      RAN_AGENT_REPO_ROOT: rootDir,
      RAN_AGENT_STATE_DIR: stateDir,
      OMBRE_BRAIN_HOME: homeDir,
      OMBRE_BRAIN_SOURCE_DIR: sourceDir,
      OMBRE_BRAIN_VENV: join(homeDir, '.venv'),
      RAN_AGENT_OMBRE_PATCH_PYTHON_BIN: join(binDir, 'python312'),
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }), /Command failed/);

  assert.match(readFileSync(timeoutLog, 'utf8'), /300 git -C .* fetch origin 0e83d4671ce1629e03ad36bb9160235bf60dbd34/);
  assert.equal(existsSync(join(homeDir, 'status.json')), false);
});

test('prepare-ombre-brain.sh installs the official hashed lock once and caches its fingerprint', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ombre-requirements-cache-'));
  const rootDir = join(dir, 'repo');
  const stateDir = join(dir, 'custom-live-state');
  const homeDir = join(stateDir, 'ombre-brain');
  const sourceDir = join(homeDir, 'upstream');
  const venvDir = join(homeDir, '.venv');
  const pipLog = join(dir, 'pip.log');
  mkdirSync(join(sourceDir, 'src'), { recursive: true });
  mkdirSync(join(venvDir, 'bin'), { recursive: true });
  writeFileSync(join(sourceDir, 'src', 'server.py'), '');
  writeFileSync(join(sourceDir, 'requirements.lock.txt'), 'fastapi==0.1 \\\n+    --hash=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n');
  execFileSync('git', ['init'], { cwd: sourceDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'ombre-test@example.invalid'], { cwd: sourceDir });
  execFileSync('git', ['config', 'user.name', 'Ombre test'], { cwd: sourceDir });
  execFileSync('git', ['add', 'src/server.py', 'requirements.lock.txt'], { cwd: sourceDir });
  execFileSync('git', ['commit', '-m', 'fixed fixture'], { cwd: sourceDir, stdio: 'pipe' });
  const fixedCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceDir, encoding: 'utf8' }).trim();
  writeFileSync(join(venvDir, 'bin', 'python'), [
    '#!/usr/bin/env bash',
    'if [[ "$*" == *"sys.version_info"* ]]; then printf "3.12\\n"; exit 0; fi',
    `printf '%s\\n' "$*" >> ${JSON.stringify(pipLog)}`,
    'exit 0',
  ].join('\n'));
  chmodSync(join(venvDir, 'bin', 'python'), 0o755);
  const patchPython = join(dir, 'ombre-patch-python');
  writeFileSync(patchPython, '#!/usr/bin/env bash\nif [[ "$*" == *"sys.version_info"* ]]; then printf "3.12\\n"; fi\nexit 0\n');
  chmodSync(patchPython, 0o755);
  const gitShim = join(dir, 'git');
  writeFileSync(gitShim, [
    '#!/usr/bin/env bash',
    'if [[ "$*" == *"rev-parse HEAD"* ]]; then',
    '  printf "%s\\n" 0e83d4671ce1629e03ad36bb9160235bf60dbd34',
    '  exit 0',
    'fi',
    'exec /usr/bin/git "$@"',
    '',
  ].join('\n'));
  chmodSync(gitShim, 0o755);

  const env = {
    ...process.env,
    PATH: `${dir}:${process.env.PATH}`,
    RAN_AGENT_REPO_ROOT: rootDir,
    RAN_AGENT_STATE_DIR: stateDir,
    OMBRE_BRAIN_UPDATE_SOURCE: 'false',
    OMBRE_BRAIN_HOME: homeDir,
    OMBRE_BRAIN_SOURCE_DIR: sourceDir,
    OMBRE_BRAIN_VENV: venvDir,
    RAN_AGENT_OMBRE_PATCH_PYTHON_BIN: patchPython,
  };
  execFileSync('bash', ['scripts/prepare-ombre-brain.sh'], {
    cwd: new URL('../..', import.meta.url).pathname,
    env,
    stdio: 'pipe',
  });
  execFileSync('bash', ['scripts/prepare-ombre-brain.sh'], {
    cwd: new URL('../..', import.meta.url).pathname,
    env,
    stdio: 'pipe',
  });

  const pipCalls = readFileSync(pipLog, 'utf8')
    .split('\n')
    .filter((line) => line.includes('-m pip install'));
  const healthChecks = readFileSync(pipLog, 'utf8')
    .split('\n')
    .filter((line) => line.includes('-m pip check'));
  const importChecks = readFileSync(pipLog, 'utf8')
    .split('\n')
    .filter((line) => line.includes('-I -c'));
  assert.equal(pipCalls.length, 1);
  assert.equal(pipCalls[0], `-m pip install --require-hashes -r ${join(sourceDir, 'requirements.lock.txt')}`);
  assert.equal(healthChecks.length, 2);
  assert.equal(importChecks.length, 2);
  assert.equal(existsSync(join(venvDir, '.requirements.lock.fingerprint')), true);
  assert.equal(existsSync(join(venvDir, '.requirements.fingerprint')), false);
});

test('start_obsidian_memory_mcp.sh does not contain uv tool install --force', () => {
  const scriptPath = new URL('../../scripts/start_obsidian_memory_mcp.sh', import.meta.url).pathname;
  const script = readFileSync(scriptPath, 'utf8');
  assert.doesNotMatch(script, /uv tool install.*--force/);
  assert.match(script, /OBSIDIAN_MEMORY_TOOL_NOT_PREPARED/);
});

test('prepare-obsidian-memory-tool.sh uses flock and supports --force', () => {
  const scriptPath = new URL('../../scripts/prepare-obsidian-memory-tool.sh', import.meta.url).pathname;
  const script = readFileSync(scriptPath, 'utf8');
  assert.match(script, /flock/);
  assert.match(script, /\-\-force/);
  assert.match(script, /UV_CACHE_DIR/);
  assert.match(script, /UV_TOOL_DIR/);
});

test('prepare-xhs-generic-fallback.sh validates ready marker schema before skipping', () => {
  const scriptPath = new URL('../../scripts/prepare-xhs-generic-fallback.sh', import.meta.url).pathname;
  const script = readFileSync(scriptPath, 'utf8');
  assert.match(script, /marker_is_ready\(\)/);
  assert.match(script, /d\.get\('command'\) == wrapper/);
  assert.match(script, /d\.get\('args'\) == \[\]/);
  assert.match(script, /d\.get\('tool_name'\) == tool_name/);
  assert.match(script, /backend_executable/);
});

test('prepare-xhs-generic-fallback.sh refreshes stale wanyi versions', () => {
  const scriptPath = new URL('../../scripts/prepare-xhs-generic-fallback.sh', import.meta.url).pathname;
  const script = readFileSync(scriptPath, 'utf8');
  assert.match(script, /XHS_GENERIC_FALLBACK_MIN_VERSION:-1\.2\.0/);
  assert.match(script, /version_gte/);
  assert.match(script, /version_ok = version_gte/);
  assert.match(script, /INSTALL_SPEC=/);
  assert.match(script, /uv tool install "\$INSTALL_SPEC"/);
  assert.match(script, /Existing marker is missing required schema\/backend readiness or has stale version/);
});

test('clean-uv-cache-safe.sh kills obsidian install processes and protects XHS cache', () => {
  const scriptPath = new URL('../../scripts/clean-uv-cache-safe.sh', import.meta.url).pathname;
  const script = readFileSync(scriptPath, 'utf8');
  assert.match(script, /start_obsidian_memory_mcp\.sh/);
  assert.match(script, /uv tool install iflow-mcp-tcsavage-obsidian-index/);
  assert.match(script, /\/tmp\/ran-agent-hermes-home-phase5/);
  // Protected directories must not be deleted
  assert.match(script, /social_reader/);
  assert.match(script, /xhs_notes/);
  assert.match(script, /vault/);
  assert.match(script, /data/);
});

test('diagnose-media-xhs.sh reports deployed revision and effective media/XHS env', () => {
  const scriptPath = new URL('../../scripts/diagnose-media-xhs.sh', import.meta.url).pathname;
  const script = readFileSync(scriptPath, 'utf8');

  assert.match(script, /git rev-parse --short HEAD/);
  assert.match(script, /effective_env_value\(\)/);
  assert.match(script, /effective generic timeout/);
  assert.match(script, /PERSONAL_AGENT_MEDIA_ALLOWED_HOSTS/);
  assert.match(script, /xiaohongshu\.com/);
  assert.match(script, /xhscdn\.com/);
});

test('apply script systemd units include OBSIDIAN_MEMORY_MCP_ENABLED=false', () => {
  const dir = mkdtempSync(join(tmpdir(), 'obsidian-systemd-'));
  const systemdDir = join(dir, 'systemd');
  mkdirSync(systemdDir, { recursive: true });

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

  assert.match(liteUnit, /Environment=OBSIDIAN_MEMORY_MCP_ENABLED=false/);
  assert.match(fullUnit, /Environment=OBSIDIAN_MEMORY_MCP_ENABLED=false/);
});

test('Hermes release gate requires Node 22.19.0 or newer', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-release-old-node-'));
  const fakeNode = join(dir, 'node');
  writeFileSync(fakeNode, [
    '#!/usr/bin/env bash',
    'if [ "$1" = "-p" ]; then echo 22.18.0; exit 0; fi',
    'exit 0',
  ].join('\n'));
  chmodSync(fakeNode, 0o755);

  assert.throws(
    () => execFileSync('bash', ['scripts/hermes-release-gate.sh', '--preflight-only'], {
      cwd: new URL('../..', import.meta.url).pathname,
      env: { PATH: '/usr/bin:/bin', RAN_AGENT_NODE_BIN: fakeNode },
      stdio: 'pipe',
    }),
    /Command failed/
  );
});

test('Hermes release gate probes node:sqlite with a real query', () => {
  const gatePath = new URL('../../scripts/hermes-release-gate.sh', import.meta.url).pathname;
  const script = readFileSync(gatePath, 'utf8');

  assert.match(script, /node:sqlite/);
  assert.match(script, /DatabaseSync/);
  assert.match(script, /SELECT 1/);
  assert.match(script, /env -i/);
  assert.doesNotMatch(script, /source .*\.env/);
});

test('Hermes release gate isolates probes and tests in a read-only source snapshot', () => {
  const gatePath = new URL('../../scripts/hermes-release-gate.sh', import.meta.url).pathname;
  const script = readFileSync(gatePath, 'utf8');

  assert.match(script, /git .*ls-files -co --exclude-standard -z/);
  assert.match(script, /chmod -R a-w/);
  assert.match(script, /source_env_file_present/);
  assert.match(script, /source_symlink_present/);
  assert.match(script, /source_sitecustomize_present/);
  assert.match(script, /run_clean/);
  assert.match(script, /RAN_AGENT_SKIP_ENV_FILE_LOAD=1/);
  assert.match(script, /-p no:cacheprovider/);
  assert.match(script, /PYTHONPATH=.*SOURCE_ROOT\/src/);
  assert.match(script, /node-test-/);
  assert.ok(script.indexOf('SANDBOX_ROOT=') < script.indexOf('NODE_VERSION='));
});

test('release-tested launchers honor the shared env-file test guard', () => {
  const root = new URL('../..', import.meta.url).pathname;
  for (const relativePath of [
    'scripts/start_time_mcp.sh',
    'scripts/start_playwright_mcp.sh',
    'scripts/start_obsidian_memory_mcp.sh',
    'scripts/start_sticker_catalog_mcp.sh',
    'scripts/start_external_mcp_gateway.sh',
    'scripts/start_ombre_brain_service.sh',
  ]) {
    const script = readFileSync(join(root, relativePath), 'utf8');
    if (relativePath === 'scripts/start_ombre_brain_service.sh') {
      assert.match(script, /NODE_ENV[^\n]*test[^\n]*RAN_AGENT_SKIP_ENV_FILE_LOAD/, relativePath);
    } else {
      assert.match(script, /source "\$ROOT_DIR\/scripts\/launcher_test_isolation\.sh"/, relativePath);
    }
  }
});

test('generic launcher env guard skips files only for explicit test mode', () => {
  const dir = mkdtempSync(join(tmpdir(), 'launcher-env-guard-'));
  const scriptsDir = join(dir, 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  const launcher = join(scriptsDir, 'start_external_mcp_gateway.sh');
  const sourceLauncher = new URL('../../scripts/start_external_mcp_gateway.sh', import.meta.url).pathname;
  writeFileSync(launcher, readFileSync(sourceLauncher));
  copyFileSync(
    new URL('../../scripts/launcher_test_isolation.sh', import.meta.url),
    join(scriptsDir, 'launcher_test_isolation.sh'),
  );
  chmodSync(launcher, 0o755);
  writeFileSync(join(dir, '.env.local'), 'SENTINEL_ENV=loaded\n');
  const fakeNode = join(dir, 'fake-node');
  writeFileSync(fakeNode, '#!/bin/sh\nprintf "%s\\n" "${SENTINEL_ENV-unset}"\n');
  chmodSync(fakeNode, 0o755);

  const run = (extraEnv) => execFileSync('bash', [launcher, 'disabled-call'], {
    env: {
      PATH: '/usr/bin:/bin',
      EXTERNAL_MCP_GATEWAY_NODE_BIN: fakeNode,
      ...extraEnv,
    },
    encoding: 'utf8',
  }).trim();

  assert.equal(run({}), 'loaded');
  assert.equal(run({ NODE_ENV: 'production', RAN_AGENT_SKIP_ENV_FILE_LOAD: '1' }), 'loaded');
  assert.equal(run({ NODE_ENV: 'test', RAN_AGENT_SKIP_ENV_FILE_LOAD: '1' }), 'unset');
});
