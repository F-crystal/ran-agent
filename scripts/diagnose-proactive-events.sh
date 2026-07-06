#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$REPO_ROOT"

echo "[proactive-events] checking managed env files"
STRICT_ENV_CHECK="${RAN_AGENT_PROACTIVE_DIAG_STRICT_ENV:-}"
if [[ -z "$STRICT_ENV_CHECK" && "$REPO_ROOT" == "/opt/ran_agent" ]]; then
  STRICT_ENV_CHECK=1
fi

require_env_line() {
  local env_file="$1"
  local expected="$2"
  if grep -q "^$expected$" "$env_file"; then
    return 0
  fi
  if [[ "$STRICT_ENV_CHECK" == "1" ]]; then
    echo "ERROR: $env_file missing $expected" >&2
    exit 1
  fi
  echo "[proactive-events] warn env=$env_file missing $expected"
}

for env_file in ".env.local" "node_bridge/.env.local"; do
  if [[ ! -f "$env_file" ]]; then
    if [[ "$STRICT_ENV_CHECK" == "1" ]]; then
      echo "ERROR: missing required env file $env_file" >&2
      exit 1
    fi
    echo "[proactive-events] skip missing $env_file"
    continue
  fi
  require_env_line "$env_file" "PERSONAL_AGENT_PROACTIVE_ENABLED=false"
  require_env_line "$env_file" "HERMES_PROACTIVE_EVENTS_ENABLED=true"
  require_env_line "$env_file" "HERMES_PROACTIVE_EXTERNAL_MCP_ENABLED=true"
  require_env_line "$env_file" "HERMES_PROACTIVE_REMINDERS_ENABLED=true"
  if grep -q '^PERSONAL_AGENT_PROACTIVE_ENABLED=true$' "$env_file"; then
    echo "ERROR: legacy broad proactive is enabled in $env_file" >&2
    exit 1
  fi
  echo "[proactive-events] ok env=$env_file"
done

read_pid_env() {
  local pid="$1"
  if [[ ! "$pid" =~ ^[0-9]+$ || "$pid" == "0" ]]; then
    return 1
  fi
  if [[ "$EUID" -eq 0 || -r "/proc/$pid/environ" ]]; then
    tr '\0' '\n' < "/proc/$pid/environ"
    return 0
  fi
  if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
    sudo sh -c "tr '\0' '\n' < '/proc/$pid/environ'"
    return 0
  fi
  return 1
}

require_service_env() {
  local service="$1"
  local expected="$2"
  local pid
  pid="$(systemctl show -p MainPID --value "$service" 2>/dev/null || true)"
  if ! read_pid_env "$pid" | grep -qx "$expected"; then
    echo "ERROR: running $service missing env $expected" >&2
    exit 1
  fi
}

echo "[proactive-events] checking Node handlers fail closed"
node --input-type=module <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import {
  handleOutboundRequest,
  handleProactiveEventRequest,
} from './node_bridge/src/outboundServer.mjs';

const retired = await handleOutboundRequest({
  bot: { async sendMessage() { throw new Error('legacy text should not send'); } },
  logger: { info() {}, warn() {}, error() {} },
  method: 'POST',
  url: '/outbound/send',
  bodyText: JSON.stringify({ text: '刚想到你最近挺忙的，今天还顺吗。', force: true }),
});
if (retired.payload?.reason !== 'legacy_checkin_route_retired') {
  throw new Error(`legacy route not retired: ${JSON.stringify(retired.payload)}`);
}
const mediaBypass = await handleOutboundRequest({
  bot: { async sendMessage() { throw new Error('legacy media should not send'); } },
  logger: { info() {}, warn() {}, error() {} },
  method: 'POST',
  url: '/outbound/send',
  bodyText: JSON.stringify({
    text: '图来了',
    media: { type: 'image', url: 'https://example.com/out.png' },
    force: true,
  }),
});
if (mediaBypass.payload?.reason !== 'legacy_checkin_route_retired') {
  throw new Error(`legacy media route not retired: ${JSON.stringify(mediaBypass.payload)}`);
}

const stateBase = path.join(process.cwd(), '.ran_agent_state');
fs.mkdirSync(stateBase, { recursive: true });
const stateDir = fs.mkdtempSync(path.join(stateBase, 'diagnose-proactive-events-'));
const safe = await handleProactiveEventRequest({
  env: {
    RAN_AGENT_STATE_DIR: stateDir,
    HERMES_PROACTIVE_EVENTS_ENABLED: 'true',
    HERMES_PROACTIVE_REMINDERS_ENABLED: 'true',
  },
  bodyText: JSON.stringify({
    event_id: 'diagnose-reminder-1',
    kind: 'reminder',
    global_user_id: 'owner',
    channel: 'feishu',
    watch_scope: 'todo:diagnose',
    reason: 'Diagnostic reminder event should not send without a Feishu target',
    evidence_refs: [],
    dedupe_key: 'diagnose-reminder-1',
    created_at: '2099-01-01T00:00:00.000Z',
    expires_at: '2099-01-01T01:00:00.000Z',
    deliverability: 'notify_allowed',
    allowed_capability_tiers: ['T0'],
    quiet_policy: 'ignore_for_explicit_reminder',
    budget_class: 'reminder',
  }),
});
if (safe.payload?.reason !== 'feishu_home_dm_target_missing') {
  throw new Error(`unexpected proactive event safety result: ${JSON.stringify(safe.payload)}`);
}
fs.rmSync(stateDir, { recursive: true, force: true });
NODE

echo "[proactive-events] checking Python config can read proactive env"
PYTHON_BIN="${PYTHON_BIN:-}"
if [[ -z "$PYTHON_BIN" ]]; then
  if command -v python >/dev/null 2>&1; then
    PYTHON_BIN=python
  else
    PYTHON_BIN=python3
  fi
fi
PYTHONPATH=src "$PYTHON_BIN" - <<'PY'
import os
from personal_agent.config import load_config

os.environ["HERMES_PROACTIVE_EVENTS_ENABLED"] = "true"
os.environ["HERMES_PROACTIVE_REMINDERS_ENABLED"] = "true"
os.environ["PERSONAL_AGENT_PROACTIVE_ENABLED"] = "false"
config = load_config()
if config.proactive_enabled:
    raise SystemExit("legacy proactive should remain disabled")
if not config.proactive_events_enabled:
    raise SystemExit("HERMES_PROACTIVE_EVENTS_ENABLED not reflected in Python config")
if not config.reminder_delivery_enabled:
    raise SystemExit("HERMES_PROACTIVE_REMINDERS_ENABLED not reflected in Python reminder gate")
PY

if command -v systemctl >/dev/null 2>&1; then
  echo "[proactive-events] checking systemd active states"
  systemctl is-active --quiet ran-agent-python.service
  systemctl is-active --quiet ran-agent-node.service
  systemctl is-active --quiet ran-agent-hermes.service
  systemctl is-active --quiet ran-agent-hermes-full.service
  if [[ "$STRICT_ENV_CHECK" == "1" ]]; then
    echo "[proactive-events] checking running service env"
    for service in ran-agent-python.service ran-agent-node.service; do
      require_service_env "$service" "PERSONAL_AGENT_PROACTIVE_ENABLED=false"
      require_service_env "$service" "HERMES_PROACTIVE_EVENTS_ENABLED=true"
      require_service_env "$service" "HERMES_PROACTIVE_EXTERNAL_MCP_ENABLED=true"
      require_service_env "$service" "HERMES_PROACTIVE_REMINDERS_ENABLED=true"
    done
  fi
fi

echo "[proactive-events] ok"
