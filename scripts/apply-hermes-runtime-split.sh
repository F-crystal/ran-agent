#!/bin/bash
# Apply the production Hermes lite/full runtime split.
# Idempotent: safe to re-run after git pull, profile install, or service restart.
# No secrets are written or printed. XHS account-backed cookies/tokens are
# intentionally removed because Xiaohongshu reading is public-only.

set -euo pipefail

REPO_ROOT="${RAN_AGENT_REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
HERMES_BIN="${HERMES_BIN:-hermes}"
PYTHON_BIN="${RAN_AGENT_PYTHON_BIN:-/opt/ran_agent/.venv/bin/python}"
FULL_HOME="${HERMES_HOME:-/home/ubuntu/.hermes-ran-agent}"
LITE_HOME="${HERMES_LITE_HOME:-$FULL_HOME/lite}"
RUNTIME_USER="${RAN_AGENT_RUNTIME_USER:-ubuntu}"
RUNTIME_GROUP="${RAN_AGENT_RUNTIME_GROUP:-$RUNTIME_USER}"
NODE_ENV_FILE="${RAN_AGENT_NODE_ENV_FILE:-/opt/ran_agent/.env.local}"
NODE_BRIDGE_ENV_FILE="${RAN_AGENT_NODE_BRIDGE_ENV_FILE:-/opt/ran_agent/node_bridge/.env.local}"
HERMES_GLOBAL_ENV_FILE="${HERMES_GLOBAL_ENV_FILE:-/home/ubuntu/.hermes/.env}"
SYSTEMD_DIR="${SYSTEMD_DIR:-/etc/systemd/system}"
RUNTIME_STATE_DIR="${RAN_AGENT_DEPLOY_STATE_DIR:-${RAN_AGENT_STATE_DIR:-/opt/ran_agent/.ran_agent_state}}"
if [[ -n "${RAN_AGENT_DEPLOY_STATE_DIR:-}" && -n "${RAN_AGENT_STATE_DIR:-}" &&
  "$RAN_AGENT_DEPLOY_STATE_DIR" != "$RAN_AGENT_STATE_DIR" ]]; then
  echo "ERROR: canonical live state directory mismatch" >&2
  exit 1
fi
RUNTIME_DEBUG_DIR="${RAN_AGENT_DEPLOY_DEBUG_DIR:-/opt/ran_agent/debug}"
LITE_SERVICE="$SYSTEMD_DIR/ran-agent-hermes.service"
FULL_SERVICE="$SYSTEMD_DIR/ran-agent-hermes-full.service"
OMBRE_SERVICE="$SYSTEMD_DIR/ran-agent-ombre-brain.service"
OMBRE_RECALL_SERVICE="$SYSTEMD_DIR/ran-agent-ombre-recall.service"
NODE_STEWARD_DROPIN_DIR="$SYSTEMD_DIR/ran-agent-node.service.d"
NODE_STEWARD_DROPIN="$NODE_STEWARD_DROPIN_DIR/99-ombre-steward-identity.conf"
XHS_BROWSE_SERVICE="$SYSTEMD_DIR/ran-agent-xhs-browse.service"
XHS_PUBLIC_SIDECAR_SERVICE="$SYSTEMD_DIR/ran-agent-xhs-public-sidecar.service"
LITE_DROPIN_DIR="$SYSTEMD_DIR/ran-agent-hermes.service.d"
STALE_LITE_DROPINS=(
  "$LITE_DROPIN_DIR/30-hermes-env.conf"
  "$LITE_DROPIN_DIR/30-hermes-runtime.conf"
  "$LITE_DROPIN_DIR/90-lite-runtime.conf"
)
API_HOST="${API_SERVER_HOST:-127.0.0.1}"
LITE_PORT="${HERMES_LITE_API_PORT:-8642}"
FULL_PORT="${HERMES_FULL_API_PORT:-8643}"
LITE_PROFILE="ran-assistant-lite"
FULL_PROFILE="ran-assistant"
MODEL_NAME="${RAN_AGENT_DEPLOY_HERMES_MODEL:-deepseek-v4-flash}"
PROVIDER_NAME="deepseek"
DEEPSEEK_THINKING_MODE="disabled"
case "$MODEL_NAME" in
  deepseek-v4-pro|deepseek-v4-flash) ;;
  *) echo "ERROR: RAN_AGENT_DEPLOY_HERMES_MODEL must be deepseek-v4-pro or deepseek-v4-flash" >&2; exit 1 ;;
esac
MODEL_POLICY_ENV=(
  "HERMES_PROVIDER=$PROVIDER_NAME"
  "HERMES_INFERENCE_PROVIDER=$PROVIDER_NAME"
  "HERMES_DEFAULT_MODEL=$MODEL_NAME"
  "HERMES_INFERENCE_MODEL=$MODEL_NAME"
  "HERMES_PRO_MODEL=$MODEL_NAME"
  "HERMES_DEEPSEEK_THINKING_MODE=$DEEPSEEK_THINKING_MODE"
)
BACKUP_DIR="$(mktemp -d)"
XHS_GENERIC_FALLBACK_PREPARE_TIMEOUT_SECONDS="${XHS_GENERIC_FALLBACK_PREPARE_TIMEOUT_SECONDS:-120}"
XHS_PUBLIC_SIDECAR_PREPARE_TIMEOUT_SECONDS="${XHS_PUBLIC_SIDECAR_PREPARE_TIMEOUT_SECONDS:-900}"
XHS_PUBLIC_SIDECAR_AUTO_PREPARE="${RAN_AGENT_DEPLOY_XHS_PUBLIC_SIDECAR_AUTO_PREPARE:-true}"
XHS_PUBLIC_SIDECAR_ENABLED_DEFAULT="${RAN_AGENT_DEPLOY_XHS_PUBLIC_SIDECAR_ENABLED:-true}"
XHS_PUBLIC_SIDECAR_HOST_DEFAULT="${RAN_AGENT_DEPLOY_XHS_PUBLIC_SIDECAR_HOST:-127.0.0.1}"
XHS_PUBLIC_SIDECAR_PORT_DEFAULT="${RAN_AGENT_DEPLOY_XHS_PUBLIC_SIDECAR_PORT:-18061}"
XHS_PUBLIC_SIDECAR_URL_DEFAULT="${RAN_AGENT_DEPLOY_XHS_PUBLIC_SIDECAR_URL:-http://$XHS_PUBLIC_SIDECAR_HOST_DEFAULT:$XHS_PUBLIC_SIDECAR_PORT_DEFAULT/xhs/detail}"
XHS_PUBLIC_SIDECAR_TIMEOUT_MS_DEFAULT="${RAN_AGENT_DEPLOY_XHS_PUBLIC_SIDECAR_TIMEOUT_MS:-90000}"
XHS_PUBLIC_HTML_FALLBACK_ENABLED_DEFAULT="${RAN_AGENT_DEPLOY_XHS_PUBLIC_HTML_FALLBACK_ENABLED:-true}"
XHS_PUBLIC_SIDECAR_MARKER_PATH_DEFAULT="${RAN_AGENT_DEPLOY_XHS_PUBLIC_SIDECAR_MARKER_PATH:-/opt/ran_agent/.ran_agent_state/social_reader/xhs-public-sidecar-ready.json}"
XHS_PUBLIC_SIDECAR_ROOT_DIR_DEFAULT="${RAN_AGENT_DEPLOY_XHS_PUBLIC_SIDECAR_ROOT_DIR:-/opt/ran_agent/.ran_agent_state/xhs-public-sidecar}"
HERMES_CONTEXT_INJECTION_MODE_DEFAULT="${RAN_AGENT_DEPLOY_HERMES_CONTEXT_INJECTION_MODE:-auto}"
HERMES_CONTEXT_CACHE_STRATEGY_DEFAULT="${RAN_AGENT_DEPLOY_HERMES_CONTEXT_CACHE_STRATEGY:-balanced}"
HERMES_RECENT_TEXT_TURNS_DEFAULT="${RAN_AGENT_DEPLOY_HERMES_RECENT_TEXT_TURNS:-4}"
HERMES_RECENT_TEXT_CHAR_BUDGET_DEFAULT="${RAN_AGENT_DEPLOY_HERMES_RECENT_TEXT_CHAR_BUDGET:-2400}"
HERMES_GLOBAL_RECENT_TURNS_DEFAULT="${RAN_AGENT_DEPLOY_HERMES_GLOBAL_RECENT_TURNS:-2}"
HERMES_GLOBAL_RECENT_CHAR_BUDGET_DEFAULT="${RAN_AGENT_DEPLOY_HERMES_GLOBAL_RECENT_CHAR_BUDGET:-800}"
HERMES_ACTIVE_TOPIC_CHAR_BUDGET_DEFAULT="${RAN_AGENT_DEPLOY_HERMES_ACTIVE_TOPIC_CHAR_BUDGET:-400}"
HERMES_CONTINUITY_FRESHNESS_HOURS_DEFAULT="${RAN_AGENT_DEPLOY_HERMES_CONTINUITY_FRESHNESS_HOURS:-24}"
HERMES_CACHE_FRIENDLY_HISTORY_DEFAULT="${RAN_AGENT_DEPLOY_HERMES_CACHE_FRIENDLY_HISTORY:-false}"
HERMES_CACHE_FRIENDLY_HISTORY_MAX_TURNS_DEFAULT="${RAN_AGENT_DEPLOY_HERMES_CACHE_FRIENDLY_HISTORY_MAX_TURNS:-6}"
HERMES_CACHE_FRIENDLY_HISTORY_CHAR_BUDGET_DEFAULT="${RAN_AGENT_DEPLOY_HERMES_CACHE_FRIENDLY_HISTORY_CHAR_BUDGET:-12000}"
HERMES_CACHE_FRIENDLY_HISTORY_PROFILE_DEFAULT="${RAN_AGENT_DEPLOY_HERMES_CACHE_FRIENDLY_HISTORY_PROFILE:-lite}"
HERMES_CACHE_TELEMETRY_ENABLED_DEFAULT="${RAN_AGENT_DEPLOY_HERMES_CACHE_TELEMETRY_ENABLED:-true}"
HERMES_LITE_SOFT_RESET_ENABLED_DEFAULT="${RAN_AGENT_DEPLOY_HERMES_LITE_SOFT_RESET_ENABLED:-true}"
HERMES_LITE_SOFT_RESET_DRY_RUN_DEFAULT="${RAN_AGENT_DEPLOY_HERMES_LITE_SOFT_RESET_DRY_RUN:-false}"
HERMES_LITE_SOFT_RESET_MAX_DIGEST_CHARS_DEFAULT="${RAN_AGENT_DEPLOY_HERMES_LITE_SOFT_RESET_MAX_DIGEST_CHARS:-1200}"
HERMES_LITE_SOFT_RESET_KEEP_LAST_N_DEFAULT="${RAN_AGENT_DEPLOY_HERMES_LITE_SOFT_RESET_KEEP_LAST_N:-4}"
HERMES_LITE_SOFT_RESET_STATE_FILE_DEFAULT="${RAN_AGENT_DEPLOY_HERMES_LITE_SOFT_RESET_STATE_FILE:-.ran_agent_state/hermes/session_maintenance.json}"
HERMES_LITE_SOFT_RESET_DIGEST_DIR_DEFAULT="${RAN_AGENT_DEPLOY_HERMES_LITE_SOFT_RESET_DIGEST_DIR:-.ran_agent_state/hermes/digests/}"
HERMES_ACTION_GATE_ENABLED_DEFAULT="${RAN_AGENT_DEPLOY_HERMES_ACTION_GATE_ENABLED:-true}"
HERMES_ACTION_GATE_MODE_DEFAULT="${RAN_AGENT_DEPLOY_HERMES_ACTION_GATE_MODE:-repair}"
HERMES_ACTION_GATE_MAX_REPAIR_ATTEMPTS_DEFAULT="${RAN_AGENT_DEPLOY_HERMES_ACTION_GATE_MAX_REPAIR_ATTEMPTS:-1}"
HERMES_ACTION_PENDING_ENABLED_DEFAULT="${RAN_AGENT_DEPLOY_HERMES_ACTION_PENDING_ENABLED:-true}"
HERMES_ACTION_PENDING_TTL_MINUTES_DEFAULT="${RAN_AGENT_DEPLOY_HERMES_ACTION_PENDING_TTL_MINUTES:-30}"
HERMES_REPLY_TIMEOUT_SECONDS_DEFAULT="${RAN_AGENT_DEPLOY_HERMES_REPLY_TIMEOUT_SECONDS:-1200}"
NODE_BRIDGE_QUICK_ACK_ENABLED_DEFAULT=false
NODE_BRIDGE_QUICK_ACK_TIMEOUT_MS_DEFAULT="${RAN_AGENT_DEPLOY_NODE_BRIDGE_QUICK_ACK_TIMEOUT_MS:-4500}"
NODE_BRIDGE_QUICK_ACK_TEXT_DEFAULT="${RAN_AGENT_DEPLOY_NODE_BRIDGE_QUICK_ACK_TEXT:-收到，正在处理。}"
FEISHU_SEND_TIMEOUT_SECONDS_DEFAULT="${RAN_AGENT_DEPLOY_FEISHU_SEND_TIMEOUT_SECONDS:-30}"
FEISHU_DOWNLOAD_TIMEOUT_SECONDS_DEFAULT="${RAN_AGENT_DEPLOY_FEISHU_DOWNLOAD_TIMEOUT_SECONDS:-30}"
HERMES_ENVIRONMENT_CONTEXT_ENABLED_DEFAULT="${RAN_AGENT_DEPLOY_HERMES_ENVIRONMENT_CONTEXT_ENABLED:-true}"
HERMES_ENVIRONMENT_WEATHER_ENABLED_DEFAULT="${RAN_AGENT_DEPLOY_HERMES_ENVIRONMENT_WEATHER_ENABLED:-true}"
HERMES_ENVIRONMENT_MAX_AGE_MS_DEFAULT="${RAN_AGENT_DEPLOY_HERMES_ENVIRONMENT_MAX_AGE_MS:-1800000}"
HERMES_ENVIRONMENT_WEATHER_CACHE_MS_DEFAULT="${RAN_AGENT_DEPLOY_HERMES_ENVIRONMENT_WEATHER_CACHE_MS:-600000}"
HERMES_ENVIRONMENT_TIMEZONE_DEFAULT="${RAN_AGENT_DEPLOY_HERMES_ENVIRONMENT_TIMEZONE:-Asia/Shanghai}"
WEIXIN_SDK_INBOUND_MEDIA_DIRS_DEFAULT="${RAN_AGENT_DEPLOY_WEIXIN_SDK_INBOUND_MEDIA_DIRS:-/tmp/weixin-agent/media/inbound}"
EXTERNAL_MCP_GATEWAY_ALLOW_ENV_ENABLE_DEFAULT="${RAN_AGENT_DEPLOY_EXTERNAL_MCP_GATEWAY_ALLOW_ENV_ENABLE:-true}"
EXTERNAL_MCP_GATEWAY_ENABLED_DEFAULT="${RAN_AGENT_DEPLOY_EXTERNAL_MCP_GATEWAY_ENABLED:-true}"
EXTERNAL_MCP_SYSTEM_QUEUE_ENABLED_DEFAULT="${RAN_AGENT_DEPLOY_EXTERNAL_MCP_SYSTEM_QUEUE_ENABLED:-true}"
EXTERNAL_MCP_ACTIVITY_RUNNER_ENABLED_DEFAULT="${RAN_AGENT_DEPLOY_EXTERNAL_MCP_ACTIVITY_RUNNER_ENABLED:-true}"
EXTERNAL_MCP_ACTIVITY_TICK_MS_DEFAULT="${RAN_AGENT_DEPLOY_EXTERNAL_MCP_ACTIVITY_TICK_MS:-60000}"
HERMES_PROACTIVE_EVENTS_ENABLED_DEFAULT="${RAN_AGENT_DEPLOY_HERMES_PROACTIVE_EVENTS_ENABLED:-true}"
HERMES_PROACTIVE_EXTERNAL_MCP_ENABLED_DEFAULT="${RAN_AGENT_DEPLOY_HERMES_PROACTIVE_EXTERNAL_MCP_ENABLED:-true}"
HERMES_PROACTIVE_REMINDERS_ENABLED_DEFAULT="${RAN_AGENT_DEPLOY_HERMES_PROACTIVE_REMINDERS_ENABLED:-true}"
HERMES_PROACTIVE_NOTIFY_MAX_CHARS_DEFAULT="${RAN_AGENT_DEPLOY_HERMES_PROACTIVE_NOTIFY_MAX_CHARS:-1600}"
PERSONAL_AGENT_KNOWLEDGE_CRON_HOURS_DEFAULT="${RAN_AGENT_DEPLOY_PERSONAL_AGENT_KNOWLEDGE_CRON_HOURS:-6,12,18,23}"
PERSONAL_AGENT_KNOWLEDGE_CRON_MINUTE_DEFAULT="${RAN_AGENT_DEPLOY_PERSONAL_AGENT_KNOWLEDGE_CRON_MINUTE:-0}"
PERSONAL_AGENT_DAILY_CARRYOVER_ENABLED_DEFAULT="${RAN_AGENT_DEPLOY_PERSONAL_AGENT_DAILY_CARRYOVER_ENABLED:-true}"
PERSONAL_AGENT_DAILY_CARRYOVER_HOUR_DEFAULT="${RAN_AGENT_DEPLOY_PERSONAL_AGENT_DAILY_CARRYOVER_HOUR:-4}"
PERSONAL_AGENT_DAILY_CARRYOVER_MINUTE_DEFAULT="${RAN_AGENT_DEPLOY_PERSONAL_AGENT_DAILY_CARRYOVER_MINUTE:-0}"
AI_DAILY_DIGEST_ENABLED_DEFAULT="${RAN_AGENT_DEPLOY_AI_DAILY_DIGEST_ENABLED:-true}"
AI_DAILY_DIGEST_HOUR_DEFAULT="${RAN_AGENT_DEPLOY_AI_DAILY_DIGEST_HOUR:-8}"
AI_DAILY_DIGEST_MINUTE_DEFAULT="${RAN_AGENT_DEPLOY_AI_DAILY_DIGEST_MINUTE:-0}"
PERSONAL_AGENT_QWEN_TIMEOUT_SECONDS_DEFAULT="${RAN_AGENT_DEPLOY_PERSONAL_AGENT_QWEN_TIMEOUT_SECONDS:-300}"
PERSONAL_AGENT_OCR_PROVIDER_DEFAULT="${RAN_AGENT_DEPLOY_PERSONAL_AGENT_OCR_PROVIDER:-dashscope-qwen-vl-ocr}"
PERSONAL_AGENT_OCR_MODEL_DEFAULT="${RAN_AGENT_DEPLOY_PERSONAL_AGENT_OCR_MODEL:-qwen-vl-ocr-2025-11-20}"
PERSONAL_AGENT_OCR_TIMEOUT_MS_DEFAULT="${RAN_AGENT_DEPLOY_PERSONAL_AGENT_OCR_TIMEOUT_MS:-120000}"
OMBRE_BRAIN_ENABLED_DEFAULT="${RAN_AGENT_DEPLOY_OMBRE_BRAIN_ENABLED:-true}"
OMBRE_BRAIN_MCP_ENABLED_DEFAULT="${RAN_AGENT_DEPLOY_OMBRE_BRAIN_MCP_ENABLED:-true}"
OMBRE_BRAIN_RUNNER_DEFAULT="${RAN_AGENT_DEPLOY_OMBRE_BRAIN_RUNNER:-source}"
OMBRE_BRAIN_COMMIT_DEFAULT="${RAN_AGENT_DEPLOY_OMBRE_BRAIN_COMMIT:-0e83d4671ce1629e03ad36bb9160235bf60dbd34}"
OMBRE_BRAIN_REPO_URL_DEFAULT="${RAN_AGENT_DEPLOY_OMBRE_BRAIN_REPO_URL:-https://github.com/P0luz/Ombre-Brain}"
OMBRE_BRAIN_HOME_DEFAULT="$RUNTIME_STATE_DIR/ombre-brain"
if [[ -n "${RAN_AGENT_DEPLOY_OMBRE_BRAIN_HOME:-}" &&
  "$RAN_AGENT_DEPLOY_OMBRE_BRAIN_HOME" != "$OMBRE_BRAIN_HOME_DEFAULT" ]]; then
  echo "ERROR: Ombre Brain home must derive from the canonical live state directory" >&2
  exit 1
fi
OMBRE_BRAIN_SOURCE_DIR_DEFAULT="${RAN_AGENT_DEPLOY_OMBRE_BRAIN_SOURCE_DIR:-$OMBRE_BRAIN_HOME_DEFAULT/upstream}"
OMBRE_BRAIN_VENV_DEFAULT="${RAN_AGENT_DEPLOY_OMBRE_BRAIN_VENV:-$OMBRE_BRAIN_HOME_DEFAULT/.venv}"
OMBRE_BUCKETS_DIR_DEFAULT="${RAN_AGENT_DEPLOY_OMBRE_BUCKETS_DIR:-/opt/ran_agent/vault/ombre}"
OMBRE_BRAIN_IMAGE_DEFAULT="${RAN_AGENT_DEPLOY_OMBRE_BRAIN_IMAGE:-p0luz/ombre-brain:latest}"
OMBRE_BIND_HOST_DEFAULT="${RAN_AGENT_DEPLOY_OMBRE_BIND_HOST:-${RAN_AGENT_DEPLOY_OMBRE_BRAIN_BIND_HOST:-127.0.0.1}}"
OMBRE_MCP_REQUIRE_AUTH_DEFAULT="${RAN_AGENT_DEPLOY_OMBRE_MCP_REQUIRE_AUTH:-false}"
OMBRE_BRAIN_PORT_DEFAULT="${RAN_AGENT_DEPLOY_OMBRE_BRAIN_PORT:-18001}"
OMBRE_BRAIN_COMPOSE_FILE_DEFAULT="${RAN_AGENT_DEPLOY_OMBRE_BRAIN_COMPOSE_FILE:-$OMBRE_BRAIN_HOME_DEFAULT/docker-compose.yml}"
OMBRE_BRAIN_CONFIG_FILE_DEFAULT="${RAN_AGENT_DEPLOY_OMBRE_BRAIN_CONFIG_FILE:-$OMBRE_BRAIN_HOME_DEFAULT/config.yaml}"
OMBRE_BRAIN_STATUS_FILE_DEFAULT="${RAN_AGENT_DEPLOY_OMBRE_BRAIN_STATUS_FILE:-$OMBRE_BRAIN_HOME_DEFAULT/status.json}"
OMBRE_BRAIN_MCP_URL_DEFAULT="${RAN_AGENT_DEPLOY_OMBRE_BRAIN_MCP_URL:-http://$OMBRE_BIND_HOST_DEFAULT:$OMBRE_BRAIN_PORT_DEFAULT/mcp}"
OMBRE_BRAIN_HEALTH_URL_DEFAULT="${RAN_AGENT_DEPLOY_OMBRE_BRAIN_HEALTH_URL:-http://$OMBRE_BIND_HOST_DEFAULT:$OMBRE_BRAIN_PORT_DEFAULT/health}"
OMBRE_RECALL_PORT_DEFAULT="${RAN_AGENT_DEPLOY_OMBRE_RECALL_PORT:-18002}"
OMBRE_RECALL_MCP_URL_DEFAULT="${RAN_AGENT_DEPLOY_OMBRE_RECALL_MCP_URL:-http://127.0.0.1:$OMBRE_RECALL_PORT_DEFAULT/mcp}"
OMBRE_RECALL_HEALTH_URL_DEFAULT="${RAN_AGENT_DEPLOY_OMBRE_RECALL_HEALTH_URL:-http://127.0.0.1:$OMBRE_RECALL_PORT_DEFAULT/health}"
OMBRE_HEALTH_TIMEOUT_SECONDS="${RAN_AGENT_DEPLOY_OMBRE_HEALTH_TIMEOUT_SECONDS:-90}"
PERSONAL_AGENT_OMBRE_READ_ENABLED_DEFAULT="${RAN_AGENT_DEPLOY_PERSONAL_AGENT_OMBRE_READ_ENABLED:-true}"
PERSONAL_AGENT_OMBRE_TIMEOUT_MS_DEFAULT="${RAN_AGENT_DEPLOY_PERSONAL_AGENT_OMBRE_TIMEOUT_MS:-1500}"
PERSONAL_AGENT_OMBRE_MAX_RESULTS_DEFAULT="${RAN_AGENT_DEPLOY_PERSONAL_AGENT_OMBRE_MAX_RESULTS:-3}"
PERSONAL_AGENT_OMBRE_MAX_CHARS_DEFAULT="${RAN_AGENT_DEPLOY_PERSONAL_AGENT_OMBRE_MAX_CHARS:-900}"
PERSONAL_AGENT_OMBRE_BACKEND_DEFAULT="${RAN_AGENT_DEPLOY_PERSONAL_AGENT_OMBRE_BACKEND:-recall_only}"
OMBRE_COMPAT_ENABLED_DEFAULT="${RAN_AGENT_DEPLOY_OMBRE_COMPAT_ENABLED:-true}"
OMBRE_COMPAT_STATE_DIR_DEFAULT="${RAN_AGENT_DEPLOY_OMBRE_COMPAT_STATE_DIR:-$RUNTIME_STATE_DIR/ombre-compat}"
OMBRE_COMPAT_STEWARD_ENDPOINT_DEFAULT="${RAN_AGENT_DEPLOY_OMBRE_COMPAT_STEWARD_ENDPOINT:-http://127.0.0.1:$OMBRE_BRAIN_PORT_DEFAULT/internal/ran-agent/steward/v1}"
OMBRE_COMPAT_STEWARD_IDENTITY_FILE_DEFAULT="${RAN_AGENT_DEPLOY_OMBRE_COMPAT_STEWARD_IDENTITY_FILE:-$OMBRE_BRAIN_HOME_DEFAULT/steward-identity.v1.json}"
OMBRE_COMPAT_CURATOR_BASE_URL_DEFAULT="${RAN_AGENT_DEPLOY_OMBRE_COMPAT_CURATOR_BASE_URL:-https://api.deepseek.com/v1}"
OMBRE_COMPAT_CURATOR_MODEL_DEFAULT="${RAN_AGENT_DEPLOY_OMBRE_COMPAT_CURATOR_MODEL:-$MODEL_NAME}"
OMBRE_COMPAT_REVIEWER_BASE_URL_DEFAULT="${RAN_AGENT_DEPLOY_OMBRE_COMPAT_REVIEWER_BASE_URL:-https://api.deepseek.com/v1}"
OMBRE_COMPAT_REVIEWER_MODEL_DEFAULT="${RAN_AGENT_DEPLOY_OMBRE_COMPAT_REVIEWER_MODEL:-$MODEL_NAME}"
# The release transaction uses this narrowly-scoped mode.  It refreshes the
# executable services while preserving the operator's existing Hermes profile
# and config.yaml shape, including arbitrary opaque MCP entries and full/lite
# membership.  Ordinary drift-repair retains the historical behaviour.
PRESERVE_RUNTIME_SHAPE="${RAN_AGENT_RELEASE_PRESERVE_RUNTIME_SHAPE:-0}"

if [ "${RAN_AGENT_NO_SUDO:-}" = "1" ] || [ "$EUID" -eq 0 ]; then
  SUDO=(env)
else
  SUDO=(sudo)
fi

require_release_authority() {
  if [[ "$REPO_ROOT" == /opt/ran_agent && "${RAN_AGENT_RELEASE_STAGED_CANDIDATE:-0}" != 1 ]]; then
    echo "ERROR: standalone lite/full repair is retired; use an immutable release transaction" >&2
    exit 1
  fi
  if [[ "${RAN_AGENT_RELEASE_STAGED_CANDIDATE:-0}" != 1 ]] && {
    [[ "$SYSTEMD_DIR" == /etc/systemd/system ]] ||
    [[ "$NODE_ENV_FILE" == /opt/ran_agent/.env.local ]] ||
    [[ "$NODE_BRIDGE_ENV_FILE" == /opt/ran_agent/node_bridge/.env.local ]] ||
    [[ "$FULL_HOME" == /home/ubuntu/.hermes-ran-agent ]];
  }; then
    echo "ERROR: canonical production targets require an immutable staged release" >&2
    exit 1
  fi
  if [[ "$REPO_ROOT" != /opt/ran_agent ]]; then
    return
  fi
  if ! "${SUDO[@]}" /usr/bin/python3 -I -c '
import json, pathlib
root = pathlib.Path("/opt/ran_agent-release/runtime-snapshots")
for path in root.glob("*/state.json") if root.is_dir() else ():
    state = json.loads(path.read_text(encoding="utf-8"))
    if state.get("phase") not in {"accepted", "rolled-back"}:
        raise SystemExit(1)
'; then
    "${SUDO[@]}" systemctl stop ran-agent-node.service 2>/dev/null || true
    echo "ERROR: unfinished unified Hermes transaction requires rollback" >&2
    exit 1
  fi
  if "${SUDO[@]}" test -e /opt/ran_agent-release/runtime-topology.v1.json ||
    "${SUDO[@]}" test -L /opt/ran_agent-release/runtime-topology.v1.json; then
    echo "ERROR: unified Hermes topology is active; lite/full repair is retired" >&2
    exit 1
  fi
}

cleanup() {
  rm -rf "$BACKUP_DIR"
}
trap cleanup EXIT

log() {
  printf '[hermes-runtime-split] %s\n' "$*"
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: required command not found: $1" >&2
    exit 1
  fi
}

resolve_runtime_identity() {
  local resolved_user resolved_group
  IFS=$'\t' read -r resolved_user resolved_group RUNTIME_UID RUNTIME_GID < <(
    "${SUDO[@]}" env \
      RAN_AGENT_TEST_MODE="${RAN_AGENT_TEST_MODE:-0}" \
      RAN_AGENT_TEST_PROC_ROOT="${RAN_AGENT_TEST_PROC_ROOT:-/proc}" \
      bash "$REPO_ROOT/scripts/verify-runtime-service-identity.sh" \
      --identity "$RUNTIME_USER" "$RUNTIME_GROUP"
  ) || return 1
  [[ "$resolved_user" == "$RUNTIME_USER" && "$resolved_group" == "$RUNTIME_GROUP" ]]
}

verify_service_runtime_identity() {
  "${SUDO[@]}" env \
    RAN_AGENT_TEST_MODE="${RAN_AGENT_TEST_MODE:-0}" \
    RAN_AGENT_TEST_PROC_ROOT="${RAN_AGENT_TEST_PROC_ROOT:-/proc}" \
    bash "$REPO_ROOT/scripts/verify-runtime-service-identity.sh" \
    --service "$1" --expect "$RUNTIME_USER" "$RUNTIME_GROUP" >/dev/null
}

verify_steward_runtime_health() {
  if [[ "${RAN_AGENT_TEST_MODE:-0}" == 1 && -n "${RAN_AGENT_STEWARD_VERIFY_TEST_COMMAND:-}" ]]; then
    "$RAN_AGENT_STEWARD_VERIFY_TEST_COMMAND"
    return
  fi
  "${SUDO[@]}" "$PYTHON_BIN" "$REPO_ROOT/scripts/verify-ombre-steward-runtime.py" \
    --state-dir "$RUNTIME_STATE_DIR" \
    --identity-file "$RUNTIME_STATE_DIR/ombre-brain/steward-identity.v1.json" \
    --runtime-user "$RUNTIME_USER" --runtime-group "$RUNTIME_GROUP" >/dev/null
}

run_as_runtime_identity() {
  [ -n "${RUNTIME_UID:-}" ] && [ -n "${RUNTIME_GID:-}" ] ||
    { echo "ERROR: Hermes runtime identity is unresolved" >&2; return 1; }
  if [ "$(id -u)" = "$RUNTIME_UID" ] && [ "$(id -g)" = "$RUNTIME_GID" ]; then
    "$@"
    return
  fi
  local runuser_bin
  runuser_bin="$(command -v runuser 2>/dev/null || true)"
  [ -n "$runuser_bin" ] ||
    { echo "ERROR: runuser is required to publish as the Hermes runtime identity" >&2; return 1; }
  "${SUDO[@]}" "$runuser_bin" --user "$RUNTIME_USER" --group "$RUNTIME_GROUP" -- "$@"
}

chown_if_user_exists() {
  local path="$1"
  if id "$RUNTIME_USER" >/dev/null 2>&1; then
    "${SUDO[@]}" chown -R "$RUNTIME_USER:$RUNTIME_GROUP" "$path"
  fi
}

runtime_state_path() {
  printf '%s/%s\n' "$RUNTIME_STATE_DIR" "$1"
}

runtime_debug_path() {
  printf '%s/%s\n' "$RUNTIME_DEBUG_DIR" "$1"
}

env_file_value() {
  local file="$1"
  local key="$2"
  if "${SUDO[@]}" test -f "$file"; then
    "${SUDO[@]}" awk -F= -v key="$key" '$1 == key { value=substr($0, length(key) + 2) } END { if (value != "") print value }' "$file"
  fi
}

effective_env_value() {
  local key="$1"
  local default="$2"
  local value="${!key:-}"
  if [ -n "$value" ]; then
    printf '%s\n' "$value"
    return 0
  fi
  local file
  for file in "$NODE_ENV_FILE" "$NODE_BRIDGE_ENV_FILE" "$FULL_HOME/.env" "$LITE_HOME/.env" "$FULL_HOME/profiles/$FULL_PROFILE/.env" "$LITE_HOME/profiles/$LITE_PROFILE/.env"; do
    value="$(env_file_value "$file" "$key" | tail -n 1 || true)"
    if [ -n "$value" ]; then
      printf '%s\n' "$value"
      return 0
    fi
  done
  printf '%s\n' "$default"
}

bool_is_true() {
  case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in
    1|true|yes|on)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

validate_ombre_network_contract() {
  if ! ombre_brain_enabled || ! bool_is_true "$(effective_env_value OMBRE_BRAIN_MCP_ENABLED "$OMBRE_BRAIN_MCP_ENABLED_DEFAULT")"; then
    echo "ERROR: Ombre Lite/Full parity requires OMBRE_BRAIN_ENABLED=true and OMBRE_BRAIN_MCP_ENABLED=true" >&2
    return 1
  fi
  env \
    OMBRE_BRAIN_RUNNER="$(effective_env_value OMBRE_BRAIN_RUNNER "$OMBRE_BRAIN_RUNNER_DEFAULT")" \
    OMBRE_BRAIN_COMMIT="$(effective_env_value OMBRE_BRAIN_COMMIT "$OMBRE_BRAIN_COMMIT_DEFAULT")" \
    OMBRE_BIND_HOST="$(effective_env_value OMBRE_BIND_HOST "$OMBRE_BIND_HOST_DEFAULT")" \
    OMBRE_MCP_REQUIRE_AUTH="$(effective_env_value OMBRE_MCP_REQUIRE_AUTH "$OMBRE_MCP_REQUIRE_AUTH_DEFAULT")" \
    OMBRE_BRAIN_MCP_URL="$(effective_env_value OMBRE_BRAIN_MCP_URL "$OMBRE_BRAIN_MCP_URL_DEFAULT")" \
    OMBRE_BRAIN_HEALTH_URL="$(effective_env_value OMBRE_BRAIN_HEALTH_URL "$OMBRE_BRAIN_HEALTH_URL_DEFAULT")" \
    OMBRE_RECALL_MCP_URL="$(effective_env_value OMBRE_RECALL_MCP_URL "$OMBRE_RECALL_MCP_URL_DEFAULT")" \
    OMBRE_RECALL_HEALTH_URL="$(effective_env_value OMBRE_RECALL_HEALTH_URL "$OMBRE_RECALL_HEALTH_URL_DEFAULT")" \
    "$PYTHON_BIN" "$REPO_ROOT/scripts/ombre_o1_contract.py" validate-runner >/dev/null
}

validate_ombre_compat_contract() {
  case "$OMBRE_COMPAT_ENABLED_DEFAULT" in true|false) ;; *)
    echo "ERROR: RAN_AGENT_DEPLOY_OMBRE_COMPAT_ENABLED must be true or false" >&2
    return 1
  esac
  [ "$OMBRE_COMPAT_STATE_DIR_DEFAULT" = "$RUNTIME_STATE_DIR/ombre-compat" ] || {
    echo "ERROR: Ombre compatibility state must derive from the canonical live state directory" >&2
    return 1
  }
  [ "$OMBRE_COMPAT_STEWARD_IDENTITY_FILE_DEFAULT" = "$OMBRE_BRAIN_HOME_DEFAULT/steward-identity.v1.json" ] || {
    echo "ERROR: Ombre compatibility identity must use the canonical Steward identity" >&2
    return 1
  }
  [ "$OMBRE_COMPAT_STEWARD_ENDPOINT_DEFAULT" = "http://127.0.0.1:$OMBRE_BRAIN_PORT_DEFAULT/internal/ran-agent/steward/v1" ] || {
    echo "ERROR: Ombre compatibility Steward endpoint must remain on the managed loopback upstream" >&2
    return 1
  }
  validate_ombre_compat_model_endpoint \
    "$OMBRE_COMPAT_CURATOR_BASE_URL_DEFAULT" "$OMBRE_COMPAT_CURATOR_MODEL_DEFAULT" curator
  validate_ombre_compat_model_endpoint \
    "$OMBRE_COMPAT_REVIEWER_BASE_URL_DEFAULT" "$OMBRE_COMPAT_REVIEWER_MODEL_DEFAULT" reviewer
}

validate_ombre_compat_model_endpoint() {
  local base_url="$1" model="$2" label="$3"
  if [[ "$base_url" != https://api.deepseek.com/v1 ||
    ( "$model" != deepseek-v4-flash && "$model" != deepseek-v4-pro ) ]]; then
    echo "ERROR: Ombre compatibility $label must use the managed tool-less DeepSeek provider" >&2
    return 1
  fi
}

print_managed_endpoint_failure() {
  local unit="$1" journal hint=see_root_journal
  echo "--- $unit startup state ---" >&2
  "${SUDO[@]}" systemctl show "$unit" --no-pager \
    --property=ActiveState --property=SubState --property=Result \
    --property=ExecMainCode --property=ExecMainStatus --property=NRestarts >&2 || true
  journal="$("${SUDO[@]}" journalctl -u "$unit" -n 40 --no-pager --output=cat 2>/dev/null || true)"
  if grep -qi 'permission denied' <<<"$journal"; then
    hint=permission_denied
  elif grep -Eq 'ModuleNotFoundError|ImportError' <<<"$journal"; then
    hint=python_dependency_error
  elif grep -qi 'address already in use' <<<"$journal"; then
    hint=listener_conflict
  elif grep -qi 'no such file or directory' <<<"$journal"; then
    hint=path_missing
  fi
  printf '%s\n' "startup_hint=$hint" >&2
}

wait_for_managed_endpoint() {
  local unit="$1" health_url="$2" port="$3" label="$4" waited=0 pid listeners active_state
  local active=0 pid_valid=0 listener_owned=0 health_ok=0
  while [ "$waited" -le "$OMBRE_HEALTH_TIMEOUT_SECONDS" ]; do
    active=0
    pid_valid=0
    listener_owned=0
    health_ok=0
    pid="$("${SUDO[@]}" systemctl show "$unit" --property=MainPID --value 2>/dev/null || true)"
    listeners="$("${SUDO[@]}" ss -ltnp 2>/dev/null || true)"
    if "${SUDO[@]}" systemctl is-active --quiet "$unit"; then active=1; fi
    if [[ "$pid" =~ ^[1-9][0-9]*$ ]]; then pid_valid=1; fi
    if [ "$pid_valid" -eq 1 ] &&
      printf '%s\n' "$listeners" | grep -Eq "127\\.0\\.0\\.1:$port([^0-9]|$).*pid=$pid([^0-9]|$)"; then
      listener_owned=1
    fi
    if [ "$active" -eq 1 ] &&
      curl --fail --silent --show-error --max-time 3 "$health_url" >/dev/null 2>&1; then
      health_ok=1
    fi
    if [ "$active" -eq 1 ] && [ "$pid_valid" -eq 1 ] &&
      [ "$listener_owned" -eq 1 ] && [ "$health_ok" -eq 1 ]; then
      log "$label unit/PID/listener/health contract passed"
      return 0
    fi
    active_state="$("${SUDO[@]}" systemctl show "$unit" --property=ActiveState --value 2>/dev/null || true)"
    if [ "$active_state" = failed ]; then
      print_managed_endpoint_failure "$unit"
      echo "ERROR: $label exited before its listener and health contract became ready" >&2
      return 1
    fi
    sleep 3
    waited=$((waited + 3))
  done
  print_managed_endpoint_failure "$unit"
  echo "ERROR: $label unit/PID/listener/health contract did not pass before dependent startup (active=$active pid=$pid pid_valid=$pid_valid listener_owned=$listener_owned health=$health_ok)" >&2
  return 1
}

wait_for_ombre_health() {
  wait_for_managed_endpoint \
    ran-agent-ombre-brain.service \
    "$(effective_env_value OMBRE_BRAIN_HEALTH_URL "$OMBRE_BRAIN_HEALTH_URL_DEFAULT")" \
    "$OMBRE_BRAIN_PORT_DEFAULT" \
    "Ombre upstream"
}

wait_for_ombre_recall_health() {
  wait_for_managed_endpoint \
    ran-agent-ombre-recall.service \
    "$(effective_env_value OMBRE_RECALL_HEALTH_URL "$OMBRE_RECALL_HEALTH_URL_DEFAULT")" \
    "$OMBRE_RECALL_PORT_DEFAULT" \
    "Ombre recall adapter"
}

verify_gateway_runtime_identity() {
  local unit actual_user actual_group
  for unit in ran-agent-hermes.service ran-agent-hermes-full.service; do
    actual_user="$("${SUDO[@]}" systemctl show "$unit" --property=User --value 2>/dev/null)" ||
      { echo "ERROR: cannot read runtime user for $unit" >&2; return 1; }
    actual_group="$("${SUDO[@]}" systemctl show "$unit" --property=Group --value 2>/dev/null)" ||
      { echo "ERROR: cannot read runtime group for $unit" >&2; return 1; }
    [ "$actual_user" = "$RUNTIME_USER" ] ||
      { echo "ERROR: $unit runtime user does not match projection publisher" >&2; return 1; }
    if [ -z "$actual_group" ]; then
      actual_group="$(id -gn "$actual_user" 2>/dev/null)" || return 1
    fi
    [ "$actual_group" = "$RUNTIME_GROUP" ] ||
      { echo "ERROR: $unit runtime group does not match projection publisher" >&2; return 1; }
  done
}

publish_verified_hermes_projection() {
  local core_db="$RUNTIME_STATE_DIR/core/core-state.sqlite3"
  local output="$RUNTIME_STATE_DIR/hermes/published-memory-context.json"
  local node_bin="${RAN_AGENT_NODE_BIN:-/opt/nodejs/node-v22.22.2-linux-x64/bin/node}"
  local projection_root
  projection_root="$(dirname "$output")"
  if [ ! -f "$core_db" ]; then
    echo "ERROR: Core activity snapshot unavailable; existing verified projection retained" >&2
    return 1
  fi
  verify_gateway_runtime_identity
  "${SUDO[@]}" mkdir -p "$projection_root"
  "${SUDO[@]}" chown "$RUNTIME_USER:$RUNTIME_GROUP" "$projection_root"
  "${SUDO[@]}" chmod 0700 "$projection_root"
  if ! run_as_runtime_identity \
    "$node_bin" "$REPO_ROOT/node_bridge/src/hermesIdentityProjection.mjs" \
    "$core_db" "$output" "$REPO_ROOT"; then
    echo "ERROR: verified Hermes projection publication failed or is ambiguous; Hermes startup blocked" >&2
    return 1
  fi
  if ! run_as_runtime_identity \
    "$node_bin" "$REPO_ROOT/node_bridge/src/hermesIdentityProjection.mjs" \
    verify-runtime "$output" "$REPO_ROOT" "$RUNTIME_UID" "$RUNTIME_GID"; then
    echo "ERROR: Hermes runtime identity cannot verify the complete projection graph; Lite startup blocked" >&2
    return 1
  fi
  log "published one verified identity/activity projection for Lite and Full"
}

ombre_brain_enabled() {
  bool_is_true "$(effective_env_value OMBRE_BRAIN_ENABLED "$OMBRE_BRAIN_ENABLED_DEFAULT")"
}

ombre_runner_value() {
  effective_env_value OMBRE_BRAIN_RUNNER "$OMBRE_BRAIN_RUNNER_DEFAULT" | tr '[:upper:]' '[:lower:]'
}

ombre_source_ready() {
  local source_dir
  local venv_dir
  source_dir="$(effective_env_value OMBRE_BRAIN_SOURCE_DIR "$OMBRE_BRAIN_SOURCE_DIR_DEFAULT")"
  venv_dir="$(effective_env_value OMBRE_BRAIN_VENV "$OMBRE_BRAIN_VENV_DEFAULT")"
  [ -f "$source_dir/src/server.py" ] && [ -x "$venv_dir/bin/python" ]
}

ombre_runner_available() {
  local status_file
  status_file="$(effective_env_value OMBRE_BRAIN_STATUS_FILE "$OMBRE_BRAIN_STATUS_FILE_DEFAULT")"
  if [ -f "$status_file" ]; then
    grep -Eq '"deploy_ready"[[:space:]]*:[[:space:]]*true' "$status_file"
    return $?
  fi
  local runner
  runner="$(ombre_runner_value)"
  case "$runner" in
    source)
      ombre_source_ready
      ;;
    *)
      return 1
      ;;
  esac
}

ombre_mcp_should_be_exposed() {
  ombre_brain_enabled &&
    bool_is_true "$(effective_env_value OMBRE_BRAIN_MCP_ENABLED "$OMBRE_BRAIN_MCP_ENABLED_DEFAULT")" &&
    ombre_runner_available
}

trusted_runtime_media_dirs() {
  runtime_debug_path "wechat/inbound"
  runtime_debug_path "mimo_inbound"
  runtime_state_path "wechat/inbound"
  runtime_state_path "feishu/inbound"
  runtime_state_path "ran-agent-weixin/media"
}

ensure_runtime_dirs() {
  log "ensuring runtime state and trusted media directories"
  local dirs=(
    "$(runtime_state_path "uv-cache")"
    "$(runtime_state_path "uv-tools")"
    "$(runtime_state_path "social_reader")"
    "$(runtime_state_path "xhs-public-sidecar")"
    "$(runtime_state_path "environment")"
    "$OMBRE_BRAIN_HOME_DEFAULT"
    "$OMBRE_BRAIN_SOURCE_DIR_DEFAULT"
    "$OMBRE_BRAIN_VENV_DEFAULT"
  )
  local media_dir
  while IFS= read -r media_dir; do
    dirs+=("$media_dir")
  done < <(trusted_runtime_media_dirs)
  "${SUDO[@]}" mkdir -p "${dirs[@]}"
  "${SUDO[@]}" mkdir -p "$OMBRE_BUCKETS_DIR_DEFAULT"
  local dir
  for dir in "${dirs[@]}"; do
    chown_if_user_exists "$dir"
  done
}

ensure_ombre_compat_state_dir() {
  "${SUDO[@]}" test ! -L "$OMBRE_COMPAT_STATE_DIR_DEFAULT" || {
    echo "ERROR: Ombre compatibility state directory must not be a symlink" >&2
    return 1
  }
  "${SUDO[@]}" mkdir -p "$OMBRE_COMPAT_STATE_DIR_DEFAULT"
  "${SUDO[@]}" chown -R "$RUNTIME_USER:$RUNTIME_GROUP" "$OMBRE_COMPAT_STATE_DIR_DEFAULT"
  "${SUDO[@]}" chmod 700 "$OMBRE_COMPAT_STATE_DIR_DEFAULT"
}

write_file() {
  local mode="$1"
  local dest="$2"
  local tmp
  tmp="$(mktemp)"
  cat >| "$tmp"
  install_file_portable "$mode" "$tmp" "$dest"
  rm -f "$tmp"
}

install_file_portable() {
  local mode="$1"
  local src="$2"
  local dest="$3"
  if "${SUDO[@]}" install -D -m "$mode" "$src" "$dest" 2>/dev/null; then
    return 0
  fi
  "${SUDO[@]}" mkdir -p "$(dirname "$dest")"
  "${SUDO[@]}" cp "$src" "$dest"
  "${SUDO[@]}" chmod "$mode" "$dest"
}

backup_env_file() {
  local label="$1"
  local file="$2"
  if "${SUDO[@]}" test -f "$file"; then
    "${SUDO[@]}" cp -p "$file" "$BACKUP_DIR/$label"
  fi
}

restore_env_file() {
  local label="$1"
  local file="$2"
  if [ -f "$BACKUP_DIR/$label" ]; then
    install_file_portable 600 "$BACKUP_DIR/$label" "$file"
    chown_if_user_exists "$file"
  fi
}

upsert_env_file() {
  local file="$1"
  shift
  local tmp
  tmp="$(mktemp)"
  local optional_key_blob=" "
  local assignment

  for assignment in "$@"; do
    if [[ "$assignment" == \?*=* ]]; then
      local optional_assignment="${assignment#\?}"
      optional_key_blob+="${optional_assignment%%=*} "
    fi
  done

  if "${SUDO[@]}" test -f "$file"; then
    while IFS= read -r line || [ -n "$line" ]; do
      local key="${line%%=*}"
      if [[ "$line" != *=* ]] || ! is_managed_env_key "$key" || [[ "$optional_key_blob" == *" $key "* ]]; then
        printf '%s\n' "$line" >> "$tmp"
      fi
    done < <("${SUDO[@]}" cat "$file")
  fi
  for assignment in "$@"; do
    if [[ "$assignment" == \?*=* ]]; then
      local default_assignment="${assignment#\?}"
      local default_key="${default_assignment%%=*}"
      if "${SUDO[@]}" test -f "$file" && "${SUDO[@]}" grep -Eq "^${default_key}=" "$file"; then
        continue
      fi
      assignment="$default_assignment"
    fi
    printf '%s\n' "$assignment" >> "$tmp"
  done
  install_file_portable 600 "$tmp" "$file"
  chown_if_user_exists "$file"
  rm -f "$tmp"
}

is_managed_env_key() {
  case "$1" in
    HERMES_PROVIDER|HERMES_INFERENCE_PROVIDER|HERMES_DEFAULT_MODEL|HERMES_INFERENCE_MODEL|HERMES_PRO_MODEL|HERMES_DEEPSEEK_THINKING_MODE|PERSONAL_AGENT_HERMES_MODEL)
      return 0
      ;;
    HERMES_HOME|HERMES_PROFILE|API_SERVER_ENABLED|API_SERVER_HOST|API_SERVER_PORT|API_SERVER_MODEL_NAME|HERMES_API_BASE_URL|HERMES_LITE_API_BASE_URL|HERMES_FULL_API_BASE_URL|HERMES_LITE_PROFILE|HERMES_FULL_PROFILE|RAN_AGENT_CAPABILITY_MODE|RAN_AGENT_INTERNAL_CONTROL_SECRET|HERMES_CONTEXT_INJECTION_MODE|HERMES_CONTEXT_CACHE_STRATEGY|HERMES_SESSION_CONTINUITY_ENABLED|HERMES_SESSION_ID_PREFIX|HERMES_SESSION_KEY_PREFIX|HERMES_RECENT_TEXT_TURNS|HERMES_RECENT_TEXT_CHAR_BUDGET|HERMES_RECENT_TEXT_MAX_USER_CHARS|HERMES_RECENT_TEXT_MAX_ASSISTANT_CHARS|HERMES_GLOBAL_RECENT_TURNS|HERMES_GLOBAL_RECENT_CHAR_BUDGET|HERMES_ACTIVE_TOPIC_CHAR_BUDGET|HERMES_CONTINUITY_FRESHNESS_HOURS|HERMES_CACHE_FRIENDLY_HISTORY|HERMES_CACHE_FRIENDLY_HISTORY_MAX_TURNS|HERMES_CACHE_FRIENDLY_HISTORY_CHAR_BUDGET|HERMES_CACHE_FRIENDLY_HISTORY_PROFILE|HERMES_CACHE_TELEMETRY_ENABLED|HERMES_LITE_SOFT_RESET_ENABLED|HERMES_LITE_SOFT_RESET_DRY_RUN|HERMES_LITE_SOFT_RESET_MAX_DIGEST_CHARS|HERMES_LITE_SOFT_RESET_KEEP_LAST_N|HERMES_LITE_SOFT_RESET_STATE_FILE|HERMES_LITE_SOFT_RESET_DIGEST_DIR|HERMES_ACTION_GATE_ENABLED|HERMES_ACTION_GATE_MODE|HERMES_ACTION_GATE_MAX_REPAIR_ATTEMPTS|HERMES_ACTION_PENDING_ENABLED|HERMES_ACTION_PENDING_TTL_MINUTES|HERMES_REPLY_TIMEOUT_SECONDS|NODE_BRIDGE_QUICK_ACK_ENABLED|NODE_BRIDGE_QUICK_ACK_TIMEOUT_MS|NODE_BRIDGE_QUICK_ACK_TEXT|FEISHU_SEND_TIMEOUT_SECONDS|FEISHU_DOWNLOAD_TIMEOUT_SECONDS|HERMES_ENVIRONMENT_CONTEXT_ENABLED|HERMES_ENVIRONMENT_WEATHER_ENABLED|HERMES_ENVIRONMENT_MAX_AGE_MS|HERMES_ENVIRONMENT_WEATHER_CACHE_MS|HERMES_ENVIRONMENT_TIMEZONE|RAN_AGENT_TIMELINE_MAX_BYTES|RAN_AGENT_TIMELINE_MAX_TURNS|RAN_AGENT_TIMELINE_RETENTION_DAYS|RAN_AGENT_TIMELINE_COMPACT_ENABLED|RAN_AGENT_TIMELINE_ARCHIVE_DIR|PERSONAL_AGENT_PROACTIVE_ENABLED|PERSONAL_AGENT_REMINDER_DELIVERY_ENABLED|HERMES_PROACTIVE_EVENTS_ENABLED|HERMES_PROACTIVE_EXTERNAL_MCP_ENABLED|HERMES_PROACTIVE_REMINDERS_ENABLED|HERMES_PROACTIVE_NOTIFY_MAX_CHARS|PERSONAL_AGENT_QWEN_TIMEOUT_SECONDS|PERSONAL_AGENT_KNOWLEDGE_CRON_HOURS|PERSONAL_AGENT_KNOWLEDGE_CRON_MINUTE|PERSONAL_AGENT_DAILY_CARRYOVER_ENABLED|PERSONAL_AGENT_DAILY_CARRYOVER_HOUR|PERSONAL_AGENT_DAILY_CARRYOVER_MINUTE|AI_DAILY_DIGEST_ENABLED|AI_DAILY_DIGEST_HOUR|AI_DAILY_DIGEST_MINUTE|FEISHU_LARK_CLI_BIN|FEISHU_LARK_CLI_IDENTITY|DESKTOP_PROXY_HOST|DESKTOP_PROXY_PORT|SEARCH_HUB_ENABLED|SEARCH_HUB_PROFILE_MODE|SEARCH_HUB_DEFAULT_LIMIT|SEARCH_HUB_TIMEOUT_MS|SEARCH_HUB_CACHE_TTL_MS|SEARCH_HUB_CACHE_PATH|SEARCH_HUB_ENABLE_TAVILY|SEARCH_HUB_ENABLE_AIHOT|SEARCH_HUB_ENABLE_OPENCLI|SEARCH_HUB_ENABLE_OPENCLI_BROWSER|SEARCH_HUB_ENABLE_PLAYWRIGHT_FALLBACK|SEARCH_HUB_OPENCLI_BIN|SEARCH_HUB_OPENCLI_TIMEOUT_MS|SEARCH_HUB_PUBLIC_ONLY_DEFAULT|UV_CACHE_DIR|UV_TOOL_DIR|UV_LINK_MODE|UV_PYTHON_DOWNLOADS|SOCIAL_READER_GENERIC_FALLBACK_ENABLED|SOCIAL_READER_XHS_BACKEND_TIMEOUT_MS|SOCIAL_READER_XHS_GENERIC_FALLBACK_TIMEOUT_MS|XHS_BACKEND_MCP_TIMEOUT_MS|MEDIA_READER_MCP_TIMEOUT_MS|PERSONAL_AGENT_MEDIA_DOWNLOAD_TIMEOUT_MS|PERSONAL_AGENT_MEDIA_MAX_CONCURRENCY|PERSONAL_AGENT_MEDIA_BATCH_TIMEOUT_MS|PERSONAL_AGENT_MEDIA_PER_ITEM_TIMEOUT_MS|PERSONAL_AGENT_OCR_PROVIDER|PERSONAL_AGENT_OCR_MODEL|PERSONAL_AGENT_OCR_TIMEOUT_MS|OBSIDIAN_MEMORY_MCP_ENABLED|XHS_GENERIC_FALLBACK_READY_PATH|XHS_GENERIC_FALLBACK_MIN_VERSION|XHS_PUBLIC_SIDECAR_ENABLED|XHS_PUBLIC_SIDECAR_URL|XHS_PUBLIC_SIDECAR_TIMEOUT_MS|XHS_PUBLIC_HTML_FALLBACK_ENABLED|XHS_PUBLIC_SIDECAR_MARKER_PATH|XHS_PUBLIC_SIDECAR_ROOT_DIR|WEIXIN_SDK_INBOUND_MEDIA_DIRS|EXTERNAL_MCP_GATEWAY_PROFILE|EXTERNAL_MCP_GATEWAY_ALLOW_ENV_ENABLE|EXTERNAL_MCP_GATEWAY_ENABLED|EXTERNAL_MCP_SYSTEM_QUEUE_ENABLED|EXTERNAL_MCP_ACTIVITY_RUNNER_ENABLED|EXTERNAL_MCP_ACTIVITY_TICK_MS|OMBRE_BRAIN_ENABLED|OMBRE_BRAIN_MCP_ENABLED|OMBRE_BRAIN_RUNNER|OMBRE_BRAIN_REPO_URL|OMBRE_BRAIN_HOME|OMBRE_BRAIN_SOURCE_DIR|OMBRE_BRAIN_VENV|OMBRE_BUCKETS_DIR|OMBRE_BRAIN_IMAGE|OMBRE_BIND_HOST|OMBRE_MCP_REQUIRE_AUTH|OMBRE_BRAIN_PORT|OMBRE_BRAIN_COMPOSE_FILE|OMBRE_BRAIN_CONFIG_FILE|OMBRE_BRAIN_STATUS_FILE|OMBRE_BRAIN_MCP_URL|OMBRE_BRAIN_HEALTH_URL|OMBRE_RECALL_PORT|OMBRE_RECALL_MCP_URL|OMBRE_RECALL_HEALTH_URL|PERSONAL_AGENT_OMBRE_BACKEND|PERSONAL_AGENT_OMBRE_MCP_URL|PERSONAL_AGENT_OMBRE_MCP_TIMEOUT_SECONDS|PERSONAL_AGENT_OMBRE_READ_ENABLED|PERSONAL_AGENT_OMBRE_WRITE_ENABLED|PERSONAL_AGENT_OMBRE_TIMEOUT_MS|PERSONAL_AGENT_OMBRE_MAX_RESULTS|PERSONAL_AGENT_OMBRE_MAX_CHARS|PERSONAL_AGENT_OMBRE_ANCHOR_ENABLED|PERSONAL_AGENT_OMBRE_I_ENABLED|PERSONAL_AGENT_OMBRE_WRITE_MODE|OMBRE_COMPAT_ENABLED|OMBRE_COMPAT_STATE_DIR|OMBRE_COMPAT_STEWARD_ENDPOINT|OMBRE_COMPAT_STEWARD_IDENTITY_FILE|OMBRE_COMPAT_CURATOR_BASE_URL|OMBRE_COMPAT_CURATOR_MODEL|OMBRE_COMPAT_REVIEWER_BASE_URL|OMBRE_COMPAT_REVIEWER_MODEL)
      return 0
      ;;
    XHS_COOKIE|XHS_MCP_COMMAND|XHS_MCP_ARGS_JSON|PERSONAL_AGENT_XHS_MCP_COMMAND|PERSONAL_AGENT_XHS_MCP_ARGS_JSON|XHS_BROWSE_ENABLED|SOCIAL_READER_EXPOSE_XHS_BROWSE_TOOLS|XHS_BROWSE_MARKER_PATH|XHS_BROWSE_ROOT_DIR|XHS_BROWSE_MCP_URL|XHS_BROWSE_MCP_COMMAND|XHS_BROWSE_MCP_ARGS_JSON|XHS_BROWSE_MCP_COOKIE_ENV|XHS_BROWSE_MCP_COOKIE|XHS_BROWSE_MCP_TIMEOUT_MS|XHS_BROWSE_MAX_RESULTS|XHS_BROWSE_MAX_ITEMS|XHS_BROWSE_MIN_INTERVAL_MS|XHS_BROWSE_MAX_CALLS_PER_SESSION|XHS_BROWSE_SEARCH_ENABLED|XHS_BROWSE_NOTE_ENABLED|XHS_BROWSE_USER_ENABLED|XHS_BROWSE_FEED_ENABLED|XHS_NOTE_TOKEN_CACHE_PATH|XHS_NOTE_TOKEN_CACHE_DEBUG)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

is_ombre_compat_env_key() {
  case "$1" in
    OMBRE_COMPAT_ENABLED|OMBRE_COMPAT_STATE_DIR|OMBRE_COMPAT_STEWARD_ENDPOINT|OMBRE_COMPAT_STEWARD_IDENTITY_FILE|OMBRE_COMPAT_CURATOR_BASE_URL|OMBRE_COMPAT_CURATOR_MODEL|OMBRE_COMPAT_REVIEWER_BASE_URL|OMBRE_COMPAT_REVIEWER_MODEL) return 0 ;;
    *) return 1 ;;
  esac
}

resolve_ombre_compat_enabled() {
  local file line effective=''
  if declare -p RAN_AGENT_DEPLOY_OMBRE_COMPAT_ENABLED >/dev/null 2>&1; then
    effective="$OMBRE_COMPAT_ENABLED_DEFAULT"
  else
    # systemd applies these EnvironmentFile entries in this order; the last
    # OMBRE_COMPAT_ENABLED assignment encountered is the operator's value.
    for file in "$NODE_ENV_FILE" "$NODE_BRIDGE_ENV_FILE"; do
      if "${SUDO[@]}" test -f "$file"; then
        while IFS= read -r line || [ -n "$line" ]; do
          [[ "$line" == OMBRE_COMPAT_ENABLED=* ]] || continue
          effective="${line#*=}"
        done < <("${SUDO[@]}" cat "$file")
      fi
    done
    [[ -n "$effective" ]] || effective="$OMBRE_COMPAT_ENABLED_DEFAULT"
  fi
  case "$effective" in
    true|false) printf '%s\n' "$effective" ;;
    *)
      echo "ERROR: effective OMBRE_COMPAT_ENABLED must be true or false" >&2
      return 1
      ;;
  esac
}

upsert_ombre_compat_env_file() {
  local file="$1"
  shift
  local tmp assignment key optional_key_blob=" "
  tmp="$(mktemp)"
  for assignment in "$@"; do
    [[ "$assignment" != \?*=* ]] || optional_key_blob+="${assignment#\?}"' '
  done
  if "${SUDO[@]}" test -f "$file"; then
    while IFS= read -r line || [ -n "$line" ]; do
      key="${line%%=*}"
      if [[ "$line" != *=* ]] || ! is_ombre_compat_env_key "$key" || [[ "$optional_key_blob" == *" $key="* ]]; then
        printf '%s\n' "$line" >> "$tmp"
      fi
    done < <("${SUDO[@]}" cat "$file")
  fi
  for assignment in "$@"; do
    if [[ "$assignment" == \?*=* ]]; then
      assignment="${assignment#\?}"
      key="${assignment%%=*}"
      if "${SUDO[@]}" test -f "$file" && "${SUDO[@]}" grep -Eq "^${key}=" "$file"; then
        continue
      fi
    fi
    printf '%s\n' "$assignment" >> "$tmp"
  done
  install_file_portable 600 "$tmp" "$file"
  chown_if_user_exists "$file"
  rm -f "$tmp"
}

write_ombre_compat_env() {
  log "refreshing managed Ombre O2 compatibility env"
  local enabled
  enabled="$(resolve_ombre_compat_enabled)"
  local assignments=(
    "OMBRE_COMPAT_ENABLED=$enabled"
    "OMBRE_COMPAT_STATE_DIR=$OMBRE_COMPAT_STATE_DIR_DEFAULT"
    "OMBRE_COMPAT_STEWARD_ENDPOINT=$OMBRE_COMPAT_STEWARD_ENDPOINT_DEFAULT"
    "OMBRE_COMPAT_STEWARD_IDENTITY_FILE=$OMBRE_COMPAT_STEWARD_IDENTITY_FILE_DEFAULT"
    "OMBRE_COMPAT_CURATOR_BASE_URL=$OMBRE_COMPAT_CURATOR_BASE_URL_DEFAULT"
    "OMBRE_COMPAT_CURATOR_MODEL=$OMBRE_COMPAT_CURATOR_MODEL_DEFAULT"
    "OMBRE_COMPAT_REVIEWER_BASE_URL=$OMBRE_COMPAT_REVIEWER_BASE_URL_DEFAULT"
    "OMBRE_COMPAT_REVIEWER_MODEL=$OMBRE_COMPAT_REVIEWER_MODEL_DEFAULT"
  )
  upsert_ombre_compat_env_file "$NODE_ENV_FILE" "${assignments[@]}"
  upsert_ombre_compat_env_file "$NODE_BRIDGE_ENV_FILE" "${assignments[@]}"
}

install_profiles() {
  log "installing Hermes profiles"
  mkdir -p "$FULL_HOME" "$LITE_HOME"
  chown_if_user_exists "$FULL_HOME"

  HERMES_HOME="$FULL_HOME" "$HERMES_BIN" profile install "$REPO_ROOT/hermes/profile" --name "$FULL_PROFILE" --force -y
  HERMES_HOME="$LITE_HOME" "$HERMES_BIN" profile install "$REPO_ROOT/hermes/profile" --name "$LITE_PROFILE" --force -y
}

install_deepseek_provider_plugin() {
  local source="$REPO_ROOT/hermes/profile/plugins/model-providers/deepseek"
  local home name
  for home in "$FULL_HOME" "$LITE_HOME"; do
    for name in __init__.py plugin.yaml; do
      [ -f "$source/$name" ] || {
        echo "ERROR: missing DeepSeek provider policy: $source/$name" >&2
        return 1
      }
      install_file_portable 644 "$source/$name" "$home/plugins/model-providers/deepseek/$name"
      chown_if_user_exists "$home/plugins/model-providers/deepseek/$name"
    done
  done
}

write_model_selected_config() {
  local source="$1" destination="$2" tmp
  tmp="$(mktemp)"
  "${SUDO[@]}" sed -E \
    -e "s/^([[:space:]]*default:[[:space:]]*)deepseek-v4-(pro|flash)[[:space:]]*$/\\1$MODEL_NAME/" \
    -e "s/^([[:space:]]*model:[[:space:]]*)deepseek-v4-(pro|flash)[[:space:]]*$/\\1$MODEL_NAME/" \
    "$source" >| "$tmp"
  install_file_portable 644 "$tmp" "$destination"
  chown_if_user_exists "$destination"
  rm -f "$tmp"
}

select_installed_profile_models() {
  local config
  for config in \
    "$FULL_HOME/config.yaml" \
    "$FULL_HOME/profiles/$FULL_PROFILE/config.yaml" \
    "$LITE_HOME/config.yaml" \
    "$LITE_HOME/profiles/$LITE_PROFILE/config.yaml"; do
    "${SUDO[@]}" test -f "$config" || {
      echo "ERROR: required installed Hermes config is missing: $config" >&2
      return 1
    }
    write_model_selected_config "$config" "$config"
  done
}

write_model_policy_env() {
  local file
  for file in \
    "$NODE_ENV_FILE" \
    "$NODE_BRIDGE_ENV_FILE" \
    "$FULL_HOME/.env" \
    "$FULL_HOME/profiles/$FULL_PROFILE/.env" \
    "$LITE_HOME/.env" \
    "$LITE_HOME/profiles/$LITE_PROFILE/.env"; do
    upsert_env_file "$file" "${MODEL_POLICY_ENV[@]}" "PERSONAL_AGENT_HERMES_MODEL=$MODEL_NAME"
  done
}

verify_model_policy() {
  local config home name file assignment
  for config in \
    "$FULL_HOME/config.yaml" \
    "$FULL_HOME/profiles/$FULL_PROFILE/config.yaml" \
    "$LITE_HOME/config.yaml" \
    "$LITE_HOME/profiles/$LITE_PROFILE/config.yaml"; do
    "${SUDO[@]}" grep -Eq "^[[:space:]]*(default|model):[[:space:]]*${MODEL_NAME}[[:space:]]*$" "$config" ||
      { echo "ERROR: Hermes model policy mismatch: $config" >&2; return 1; }
  done
  for home in "$FULL_HOME" "$LITE_HOME"; do
    for name in __init__.py plugin.yaml; do
      "${SUDO[@]}" cmp -s \
        "$REPO_ROOT/hermes/profile/plugins/model-providers/deepseek/$name" \
        "$home/plugins/model-providers/deepseek/$name" ||
        { echo "ERROR: installed DeepSeek provider policy mismatch: $home" >&2; return 1; }
    done
  done
  for file in \
    "$NODE_ENV_FILE" \
    "$NODE_BRIDGE_ENV_FILE" \
    "$FULL_HOME/.env" \
    "$FULL_HOME/profiles/$FULL_PROFILE/.env" \
    "$LITE_HOME/.env" \
    "$LITE_HOME/profiles/$LITE_PROFILE/.env"; do
    for assignment in "${MODEL_POLICY_ENV[@]}"; do
      "${SUDO[@]}" grep -qxF "$assignment" "$file" ||
        { echo "ERROR: Hermes model env mismatch: $file:${assignment%%=*}" >&2; return 1; }
    done
  done
}

install_o1_identity_and_recall_contract() {
  local home profile target name
  for home in "$FULL_HOME" "$LITE_HOME"; do
    if [ "$home" = "$FULL_HOME" ]; then profile="$FULL_PROFILE"; else profile="$LITE_PROFILE"; fi
    target="$home/profiles/$profile"
    "${SUDO[@]}" mkdir -p "$target"
    for name in IDENTITY.md SOUL.md AGENTS.md; do
      install_file_portable 644 "$REPO_ROOT/hermes/profile/$name" "$target/$name"
      chown_if_user_exists "$target/$name"
    done
    for target in "$home/config.yaml" "$home/profiles/$profile/config.yaml"; do
      "${SUDO[@]}" test -f "$target" || continue
      "${SUDO[@]}" sed -i.bak 's/${OMBRE_BRAIN_MCP_URL}/${OMBRE_RECALL_MCP_URL}/g' "$target"
      "${SUDO[@]}" rm -f "$target.bak"
    done
  done
}

verify_o1_identity_and_recall_contract() {
  local home profile target name
  for home in "$FULL_HOME" "$LITE_HOME"; do
    if [ "$home" = "$FULL_HOME" ]; then profile="$FULL_PROFILE"; else profile="$LITE_PROFILE"; fi
    target="$home/profiles/$profile"
    for name in IDENTITY.md SOUL.md AGENTS.md; do
      "${SUDO[@]}" cmp -s "$REPO_ROOT/hermes/profile/$name" "$target/$name" || {
        echo "ERROR: installed $profile/$name drifted from the O1 identity authority" >&2
        return 1
      }
    done
    for target in "$home/config.yaml" "$home/profiles/$profile/config.yaml"; do
      "${SUDO[@]}" test -f "$target" || continue
    done
  done
  validate_runtime_ombre_configs
}

validate_runtime_ombre_configs() {
  local configs=(
    "$FULL_HOME/config.yaml"
    "$FULL_HOME/profiles/$FULL_PROFILE/config.yaml"
    "$LITE_HOME/config.yaml"
    "$LITE_HOME/profiles/$LITE_PROFILE/config.yaml"
  )
  local target
  for target in "${configs[@]}"; do
    "${SUDO[@]}" test -f "$target" || {
      echo "ERROR: required installed Hermes config is missing: $target" >&2
      return 1
    }
  done
  [ "${#configs[@]}" -eq 4 ] || {
    echo "ERROR: all four installed Lite/Full root/profile configs are required" >&2
    return 1
  }
  OMBRE_RECALL_MCP_URL="$(effective_env_value OMBRE_RECALL_MCP_URL "$OMBRE_RECALL_MCP_URL_DEFAULT")" \
    "${SUDO[@]}" "$PYTHON_BIN" "$REPO_ROOT/scripts/ombre_o1_contract.py" \
      validate-config "${configs[@]}" >/dev/null || {
        echo "ERROR: installed Hermes MCP surface violates the semantic O1 recall-only contract" >&2
        return 1
      }
}

write_runtime_env() {
  log "refreshing runtime env files without touching secrets"
  local internal_control_secret="${RAN_AGENT_DEPLOY_INTERNAL_CONTROL_SECRET:-}"
  if [[ ! "$internal_control_secret" =~ ^[a-f0-9]{64}$ ]] && "${SUDO[@]}" test -f "$NODE_ENV_FILE"; then
    internal_control_secret="$("${SUDO[@]}" sed -n 's/^RAN_AGENT_INTERNAL_CONTROL_SECRET=//p' "$NODE_ENV_FILE" | tail -n 1)"
  fi
  if [[ ! "$internal_control_secret" =~ ^[a-f0-9]{64}$ ]]; then
    internal_control_secret="$(openssl rand -hex 32)"
  fi
  local ombre_env=(
    "?OMBRE_BRAIN_ENABLED=$OMBRE_BRAIN_ENABLED_DEFAULT"
    "?OMBRE_BRAIN_MCP_ENABLED=$OMBRE_BRAIN_MCP_ENABLED_DEFAULT"
    "?OMBRE_BRAIN_RUNNER=$OMBRE_BRAIN_RUNNER_DEFAULT"
    "?OMBRE_BRAIN_REPO_URL=$OMBRE_BRAIN_REPO_URL_DEFAULT"
    "?OMBRE_BRAIN_HOME=$OMBRE_BRAIN_HOME_DEFAULT"
    "?OMBRE_BRAIN_SOURCE_DIR=$OMBRE_BRAIN_SOURCE_DIR_DEFAULT"
    "?OMBRE_BRAIN_VENV=$OMBRE_BRAIN_VENV_DEFAULT"
    "?OMBRE_BUCKETS_DIR=$OMBRE_BUCKETS_DIR_DEFAULT"
    "?OMBRE_BRAIN_IMAGE=$OMBRE_BRAIN_IMAGE_DEFAULT"
    "OMBRE_BIND_HOST=$OMBRE_BIND_HOST_DEFAULT"
    "OMBRE_MCP_REQUIRE_AUTH=$OMBRE_MCP_REQUIRE_AUTH_DEFAULT"
    "?OMBRE_BRAIN_PORT=$OMBRE_BRAIN_PORT_DEFAULT"
    "?OMBRE_BRAIN_COMPOSE_FILE=$OMBRE_BRAIN_COMPOSE_FILE_DEFAULT"
    "?OMBRE_BRAIN_CONFIG_FILE=$OMBRE_BRAIN_CONFIG_FILE_DEFAULT"
    "?OMBRE_BRAIN_STATUS_FILE=$OMBRE_BRAIN_STATUS_FILE_DEFAULT"
    "OMBRE_BRAIN_MCP_URL=$OMBRE_BRAIN_MCP_URL_DEFAULT"
    "?OMBRE_BRAIN_HEALTH_URL=$OMBRE_BRAIN_HEALTH_URL_DEFAULT"
    "OMBRE_RECALL_PORT=$OMBRE_RECALL_PORT_DEFAULT"
    "OMBRE_RECALL_MCP_URL=$OMBRE_RECALL_MCP_URL_DEFAULT"
    "OMBRE_RECALL_HEALTH_URL=$OMBRE_RECALL_HEALTH_URL_DEFAULT"
    "?PERSONAL_AGENT_OMBRE_BACKEND=$PERSONAL_AGENT_OMBRE_BACKEND_DEFAULT"
    "PERSONAL_AGENT_OMBRE_MCP_URL=$OMBRE_RECALL_MCP_URL_DEFAULT"
    "?PERSONAL_AGENT_OMBRE_MCP_TIMEOUT_SECONDS=10"
    "?PERSONAL_AGENT_OMBRE_READ_ENABLED=$PERSONAL_AGENT_OMBRE_READ_ENABLED_DEFAULT"
    "?PERSONAL_AGENT_OMBRE_TIMEOUT_MS=$PERSONAL_AGENT_OMBRE_TIMEOUT_MS_DEFAULT"
    "?PERSONAL_AGENT_OMBRE_MAX_RESULTS=$PERSONAL_AGENT_OMBRE_MAX_RESULTS_DEFAULT"
    "?PERSONAL_AGENT_OMBRE_MAX_CHARS=$PERSONAL_AGENT_OMBRE_MAX_CHARS_DEFAULT"
  )
  local xhs_public_env=(
    "XHS_PUBLIC_SIDECAR_ENABLED=$XHS_PUBLIC_SIDECAR_ENABLED_DEFAULT"
    "XHS_PUBLIC_SIDECAR_URL=$XHS_PUBLIC_SIDECAR_URL_DEFAULT"
    "XHS_PUBLIC_SIDECAR_TIMEOUT_MS=$XHS_PUBLIC_SIDECAR_TIMEOUT_MS_DEFAULT"
    "XHS_PUBLIC_HTML_FALLBACK_ENABLED=$XHS_PUBLIC_HTML_FALLBACK_ENABLED_DEFAULT"
    "XHS_PUBLIC_SIDECAR_MARKER_PATH=$XHS_PUBLIC_SIDECAR_MARKER_PATH_DEFAULT"
    "XHS_PUBLIC_SIDECAR_ROOT_DIR=$XHS_PUBLIC_SIDECAR_ROOT_DIR_DEFAULT"
  )
  local media_reader_ocr_env=(
    "PERSONAL_AGENT_OCR_PROVIDER=$PERSONAL_AGENT_OCR_PROVIDER_DEFAULT"
    "PERSONAL_AGENT_OCR_MODEL=$PERSONAL_AGENT_OCR_MODEL_DEFAULT"
    "PERSONAL_AGENT_OCR_TIMEOUT_MS=$PERSONAL_AGENT_OCR_TIMEOUT_MS_DEFAULT"
  )
  local external_mcp_env=(
    "EXTERNAL_MCP_GATEWAY_ALLOW_ENV_ENABLE=$EXTERNAL_MCP_GATEWAY_ALLOW_ENV_ENABLE_DEFAULT"
    "EXTERNAL_MCP_GATEWAY_ENABLED=$EXTERNAL_MCP_GATEWAY_ENABLED_DEFAULT"
    "EXTERNAL_MCP_SYSTEM_QUEUE_ENABLED=$EXTERNAL_MCP_SYSTEM_QUEUE_ENABLED_DEFAULT"
    "EXTERNAL_MCP_ACTIVITY_RUNNER_ENABLED=$EXTERNAL_MCP_ACTIVITY_RUNNER_ENABLED_DEFAULT"
    "EXTERNAL_MCP_ACTIVITY_TICK_MS=$EXTERNAL_MCP_ACTIVITY_TICK_MS_DEFAULT"
  )
  local hermes_client_env=(
    "${MODEL_POLICY_ENV[@]}"
    "PERSONAL_AGENT_HERMES_MODEL=$MODEL_NAME"
    "HERMES_REPLY_TIMEOUT_SECONDS=$HERMES_REPLY_TIMEOUT_SECONDS_DEFAULT"
  )
  local reply_window_env=(
    "${hermes_client_env[@]}"
    "NODE_BRIDGE_QUICK_ACK_ENABLED=$NODE_BRIDGE_QUICK_ACK_ENABLED_DEFAULT"
    "NODE_BRIDGE_QUICK_ACK_TIMEOUT_MS=$NODE_BRIDGE_QUICK_ACK_TIMEOUT_MS_DEFAULT"
    "NODE_BRIDGE_QUICK_ACK_TEXT=$NODE_BRIDGE_QUICK_ACK_TEXT_DEFAULT"
    "FEISHU_SEND_TIMEOUT_SECONDS=$FEISHU_SEND_TIMEOUT_SECONDS_DEFAULT"
    "FEISHU_DOWNLOAD_TIMEOUT_SECONDS=$FEISHU_DOWNLOAD_TIMEOUT_SECONDS_DEFAULT"
  )
  local proactive_event_env=(
    "HERMES_PROACTIVE_EVENTS_ENABLED=$HERMES_PROACTIVE_EVENTS_ENABLED_DEFAULT"
    "HERMES_PROACTIVE_EXTERNAL_MCP_ENABLED=$HERMES_PROACTIVE_EXTERNAL_MCP_ENABLED_DEFAULT"
    "HERMES_PROACTIVE_REMINDERS_ENABLED=$HERMES_PROACTIVE_REMINDERS_ENABLED_DEFAULT"
    "HERMES_PROACTIVE_NOTIFY_MAX_CHARS=$HERMES_PROACTIVE_NOTIFY_MAX_CHARS_DEFAULT"
  )
  upsert_env_file "$FULL_HOME/.env" \
    "HERMES_HOME=$FULL_HOME" \
    "HERMES_PROFILE=$FULL_PROFILE" \
    "API_SERVER_ENABLED=true" \
    "API_SERVER_HOST=$API_HOST" \
    "API_SERVER_PORT=$FULL_PORT" \
    "API_SERVER_MODEL_NAME=$FULL_PROFILE" \
    "HERMES_API_BASE_URL=http://$API_HOST:$FULL_PORT/v1" \
    "${hermes_client_env[@]}" \
    "PERSONAL_AGENT_PROACTIVE_ENABLED=false" \
    "PERSONAL_AGENT_REMINDER_DELIVERY_ENABLED=false" \
    "${proactive_event_env[@]}" \
    "${external_mcp_env[@]}" \
    "EXTERNAL_MCP_GATEWAY_PROFILE=full" \
    "PERSONAL_AGENT_QWEN_TIMEOUT_SECONDS=$PERSONAL_AGENT_QWEN_TIMEOUT_SECONDS_DEFAULT" \
    "PERSONAL_AGENT_KNOWLEDGE_CRON_HOURS=$PERSONAL_AGENT_KNOWLEDGE_CRON_HOURS_DEFAULT" \
    "PERSONAL_AGENT_KNOWLEDGE_CRON_MINUTE=$PERSONAL_AGENT_KNOWLEDGE_CRON_MINUTE_DEFAULT" \
    "PERSONAL_AGENT_DAILY_CARRYOVER_ENABLED=$PERSONAL_AGENT_DAILY_CARRYOVER_ENABLED_DEFAULT" \
    "PERSONAL_AGENT_DAILY_CARRYOVER_HOUR=$PERSONAL_AGENT_DAILY_CARRYOVER_HOUR_DEFAULT" \
    "PERSONAL_AGENT_DAILY_CARRYOVER_MINUTE=$PERSONAL_AGENT_DAILY_CARRYOVER_MINUTE_DEFAULT" \
    "SEARCH_HUB_ENABLED=true" \
    "SEARCH_HUB_PROFILE_MODE=full" \
    "SEARCH_HUB_DEFAULT_LIMIT=5" \
    "SEARCH_HUB_TIMEOUT_MS=30000" \
    "SEARCH_HUB_CACHE_TTL_MS=300000" \
    "SEARCH_HUB_CACHE_PATH=/opt/ran_agent/.ran_agent_state/search_hub/cache.jsonl" \
    "SEARCH_HUB_ENABLE_TAVILY=true" \
    "SEARCH_HUB_ENABLE_AIHOT=true" \
    "SEARCH_HUB_ENABLE_OPENCLI=true" \
    "SEARCH_HUB_ENABLE_OPENCLI_BROWSER=false" \
    "SEARCH_HUB_ENABLE_PLAYWRIGHT_FALLBACK=true" \
    "SEARCH_HUB_OPENCLI_BIN=opencli" \
    "SEARCH_HUB_OPENCLI_TIMEOUT_MS=60000" \
    "SEARCH_HUB_PUBLIC_ONLY_DEFAULT=false" \
    "UV_CACHE_DIR=/opt/ran_agent/.ran_agent_state/uv-cache" \
    "UV_TOOL_DIR=/opt/ran_agent/.ran_agent_state/uv-tools" \
    "UV_LINK_MODE=copy" \
    "UV_PYTHON_DOWNLOADS=never" \
    "SOCIAL_READER_GENERIC_FALLBACK_ENABLED=true" \
    "SOCIAL_READER_XHS_BACKEND_TIMEOUT_MS=90000" \
    "?SOCIAL_READER_XHS_GENERIC_FALLBACK_TIMEOUT_MS=90000" \
    "XHS_BACKEND_MCP_TIMEOUT_MS=90000" \
    "MEDIA_READER_MCP_TIMEOUT_MS=1200000" \
    "PERSONAL_AGENT_MEDIA_DOWNLOAD_TIMEOUT_MS=60000" \
    "PERSONAL_AGENT_MEDIA_MAX_CONCURRENCY=3" \
    "PERSONAL_AGENT_MEDIA_BATCH_TIMEOUT_MS=1200000" \
    "PERSONAL_AGENT_MEDIA_PER_ITEM_TIMEOUT_MS=120000" \
    "${media_reader_ocr_env[@]}" \
    "OBSIDIAN_MEMORY_MCP_ENABLED=false" \
    "XHS_GENERIC_FALLBACK_READY_PATH=/opt/ran_agent/.ran_agent_state/social_reader/generic-fallback-ready.json" \
    "?XHS_GENERIC_FALLBACK_MIN_VERSION=1.2.0" \
    "WEIXIN_SDK_INBOUND_MEDIA_DIRS=$WEIXIN_SDK_INBOUND_MEDIA_DIRS_DEFAULT" \
    "${xhs_public_env[@]}" \
    "${ombre_env[@]}" \
    "?OPENALEX_MAILTO="

  upsert_env_file "$FULL_HOME/profiles/$FULL_PROFILE/.env" \
    "HERMES_HOME=$FULL_HOME" \
    "HERMES_PROFILE=$FULL_PROFILE" \
    "API_SERVER_ENABLED=true" \
    "API_SERVER_HOST=$API_HOST" \
    "API_SERVER_PORT=$FULL_PORT" \
    "API_SERVER_MODEL_NAME=$FULL_PROFILE" \
    "HERMES_API_BASE_URL=http://$API_HOST:$FULL_PORT/v1" \
    "${hermes_client_env[@]}" \
    "PERSONAL_AGENT_PROACTIVE_ENABLED=false" \
    "PERSONAL_AGENT_REMINDER_DELIVERY_ENABLED=false" \
    "${proactive_event_env[@]}" \
    "${external_mcp_env[@]}" \
    "EXTERNAL_MCP_GATEWAY_PROFILE=full" \
    "SEARCH_HUB_ENABLED=true" \
    "SEARCH_HUB_PROFILE_MODE=full" \
    "SEARCH_HUB_DEFAULT_LIMIT=5" \
    "SEARCH_HUB_TIMEOUT_MS=30000" \
    "SEARCH_HUB_CACHE_TTL_MS=300000" \
    "SEARCH_HUB_CACHE_PATH=/opt/ran_agent/.ran_agent_state/search_hub/cache.jsonl" \
    "SEARCH_HUB_ENABLE_TAVILY=true" \
    "SEARCH_HUB_ENABLE_AIHOT=true" \
    "SEARCH_HUB_ENABLE_OPENCLI=true" \
    "SEARCH_HUB_ENABLE_OPENCLI_BROWSER=false" \
    "SEARCH_HUB_ENABLE_PLAYWRIGHT_FALLBACK=true" \
    "SEARCH_HUB_OPENCLI_BIN=opencli" \
    "SEARCH_HUB_OPENCLI_TIMEOUT_MS=60000" \
    "SEARCH_HUB_PUBLIC_ONLY_DEFAULT=false" \
    "UV_CACHE_DIR=/opt/ran_agent/.ran_agent_state/uv-cache" \
    "UV_TOOL_DIR=/opt/ran_agent/.ran_agent_state/uv-tools" \
    "UV_LINK_MODE=copy" \
    "UV_PYTHON_DOWNLOADS=never" \
    "SOCIAL_READER_GENERIC_FALLBACK_ENABLED=true" \
    "SOCIAL_READER_XHS_BACKEND_TIMEOUT_MS=90000" \
    "?SOCIAL_READER_XHS_GENERIC_FALLBACK_TIMEOUT_MS=90000" \
    "XHS_BACKEND_MCP_TIMEOUT_MS=90000" \
    "MEDIA_READER_MCP_TIMEOUT_MS=1200000" \
    "PERSONAL_AGENT_MEDIA_DOWNLOAD_TIMEOUT_MS=60000" \
    "PERSONAL_AGENT_MEDIA_MAX_CONCURRENCY=3" \
    "PERSONAL_AGENT_MEDIA_BATCH_TIMEOUT_MS=1200000" \
    "PERSONAL_AGENT_MEDIA_PER_ITEM_TIMEOUT_MS=120000" \
    "${media_reader_ocr_env[@]}" \
    "OBSIDIAN_MEMORY_MCP_ENABLED=false" \
    "XHS_GENERIC_FALLBACK_READY_PATH=/opt/ran_agent/.ran_agent_state/social_reader/generic-fallback-ready.json" \
    "?XHS_GENERIC_FALLBACK_MIN_VERSION=1.2.0" \
    "WEIXIN_SDK_INBOUND_MEDIA_DIRS=$WEIXIN_SDK_INBOUND_MEDIA_DIRS_DEFAULT" \
    "${xhs_public_env[@]}" \
    "${ombre_env[@]}" \
    "?OPENALEX_MAILTO="

  upsert_env_file "$LITE_HOME/.env" \
    "HERMES_HOME=$LITE_HOME" \
    "HERMES_PROFILE=$LITE_PROFILE" \
    "API_SERVER_ENABLED=true" \
    "API_SERVER_HOST=$API_HOST" \
    "API_SERVER_PORT=$LITE_PORT" \
    "API_SERVER_MODEL_NAME=$LITE_PROFILE" \
    "HERMES_API_BASE_URL=http://$API_HOST:$LITE_PORT/v1" \
    "${hermes_client_env[@]}" \
    "PERSONAL_AGENT_PROACTIVE_ENABLED=false" \
    "PERSONAL_AGENT_REMINDER_DELIVERY_ENABLED=false" \
    "${proactive_event_env[@]}" \
    "${external_mcp_env[@]}" \
    "EXTERNAL_MCP_GATEWAY_PROFILE=lite" \
    "SEARCH_HUB_ENABLED=true" \
    "SEARCH_HUB_PROFILE_MODE=lite" \
    "SEARCH_HUB_DEFAULT_LIMIT=5" \
    "SEARCH_HUB_TIMEOUT_MS=30000" \
    "SEARCH_HUB_CACHE_TTL_MS=300000" \
    "SEARCH_HUB_CACHE_PATH=/opt/ran_agent/.ran_agent_state/search_hub/cache.jsonl" \
    "SEARCH_HUB_ENABLE_TAVILY=true" \
    "SEARCH_HUB_ENABLE_AIHOT=true" \
    "SEARCH_HUB_ENABLE_OPENCLI=true" \
    "SEARCH_HUB_ENABLE_OPENCLI_BROWSER=false" \
    "SEARCH_HUB_ENABLE_PLAYWRIGHT_FALLBACK=false" \
    "SEARCH_HUB_OPENCLI_BIN=opencli" \
    "SEARCH_HUB_OPENCLI_TIMEOUT_MS=60000" \
    "SEARCH_HUB_PUBLIC_ONLY_DEFAULT=true" \
    "UV_CACHE_DIR=/opt/ran_agent/.ran_agent_state/uv-cache" \
    "UV_TOOL_DIR=/opt/ran_agent/.ran_agent_state/uv-tools" \
    "UV_LINK_MODE=copy" \
    "UV_PYTHON_DOWNLOADS=never" \
    "SOCIAL_READER_GENERIC_FALLBACK_ENABLED=true" \
    "SOCIAL_READER_XHS_BACKEND_TIMEOUT_MS=90000" \
    "?SOCIAL_READER_XHS_GENERIC_FALLBACK_TIMEOUT_MS=90000" \
    "XHS_BACKEND_MCP_TIMEOUT_MS=90000" \
    "MEDIA_READER_MCP_TIMEOUT_MS=1200000" \
    "PERSONAL_AGENT_MEDIA_DOWNLOAD_TIMEOUT_MS=60000" \
    "PERSONAL_AGENT_MEDIA_MAX_CONCURRENCY=3" \
    "PERSONAL_AGENT_MEDIA_BATCH_TIMEOUT_MS=1200000" \
    "PERSONAL_AGENT_MEDIA_PER_ITEM_TIMEOUT_MS=120000" \
    "${media_reader_ocr_env[@]}" \
    "OBSIDIAN_MEMORY_MCP_ENABLED=false" \
    "XHS_GENERIC_FALLBACK_READY_PATH=/opt/ran_agent/.ran_agent_state/social_reader/generic-fallback-ready.json" \
    "?XHS_GENERIC_FALLBACK_MIN_VERSION=1.2.0" \
    "WEIXIN_SDK_INBOUND_MEDIA_DIRS=$WEIXIN_SDK_INBOUND_MEDIA_DIRS_DEFAULT" \
    "${xhs_public_env[@]}" \
    "${ombre_env[@]}" \
    "?OPENALEX_MAILTO="

  upsert_env_file "$LITE_HOME/profiles/$LITE_PROFILE/.env" \
    "HERMES_HOME=$LITE_HOME" \
    "HERMES_PROFILE=$LITE_PROFILE" \
    "API_SERVER_ENABLED=true" \
    "API_SERVER_HOST=$API_HOST" \
    "API_SERVER_PORT=$LITE_PORT" \
    "API_SERVER_MODEL_NAME=$LITE_PROFILE" \
    "HERMES_API_BASE_URL=http://$API_HOST:$LITE_PORT/v1" \
    "${hermes_client_env[@]}" \
    "PERSONAL_AGENT_PROACTIVE_ENABLED=false" \
    "PERSONAL_AGENT_REMINDER_DELIVERY_ENABLED=false" \
    "${proactive_event_env[@]}" \
    "${external_mcp_env[@]}" \
    "EXTERNAL_MCP_GATEWAY_PROFILE=lite" \
    "SEARCH_HUB_ENABLED=true" \
    "SEARCH_HUB_PROFILE_MODE=lite" \
    "SEARCH_HUB_DEFAULT_LIMIT=5" \
    "SEARCH_HUB_TIMEOUT_MS=30000" \
    "SEARCH_HUB_CACHE_TTL_MS=300000" \
    "SEARCH_HUB_CACHE_PATH=/opt/ran_agent/.ran_agent_state/search_hub/cache.jsonl" \
    "SEARCH_HUB_ENABLE_TAVILY=true" \
    "SEARCH_HUB_ENABLE_AIHOT=true" \
    "SEARCH_HUB_ENABLE_OPENCLI=true" \
    "SEARCH_HUB_ENABLE_OPENCLI_BROWSER=false" \
    "SEARCH_HUB_ENABLE_PLAYWRIGHT_FALLBACK=false" \
    "SEARCH_HUB_OPENCLI_BIN=opencli" \
    "SEARCH_HUB_OPENCLI_TIMEOUT_MS=60000" \
    "SEARCH_HUB_PUBLIC_ONLY_DEFAULT=true" \
    "UV_CACHE_DIR=/opt/ran_agent/.ran_agent_state/uv-cache" \
    "UV_TOOL_DIR=/opt/ran_agent/.ran_agent_state/uv-tools" \
    "UV_LINK_MODE=copy" \
    "UV_PYTHON_DOWNLOADS=never" \
    "SOCIAL_READER_GENERIC_FALLBACK_ENABLED=true" \
    "SOCIAL_READER_XHS_BACKEND_TIMEOUT_MS=90000" \
    "?SOCIAL_READER_XHS_GENERIC_FALLBACK_TIMEOUT_MS=90000" \
    "XHS_BACKEND_MCP_TIMEOUT_MS=90000" \
    "MEDIA_READER_MCP_TIMEOUT_MS=1200000" \
    "PERSONAL_AGENT_MEDIA_DOWNLOAD_TIMEOUT_MS=60000" \
    "PERSONAL_AGENT_MEDIA_MAX_CONCURRENCY=3" \
    "PERSONAL_AGENT_MEDIA_BATCH_TIMEOUT_MS=1200000" \
    "PERSONAL_AGENT_MEDIA_PER_ITEM_TIMEOUT_MS=120000" \
    "${media_reader_ocr_env[@]}" \
    "OBSIDIAN_MEMORY_MCP_ENABLED=false" \
    "XHS_GENERIC_FALLBACK_READY_PATH=/opt/ran_agent/.ran_agent_state/social_reader/generic-fallback-ready.json" \
    "?XHS_GENERIC_FALLBACK_MIN_VERSION=1.2.0" \
    "WEIXIN_SDK_INBOUND_MEDIA_DIRS=$WEIXIN_SDK_INBOUND_MEDIA_DIRS_DEFAULT" \
    "${xhs_public_env[@]}" \
    "${ombre_env[@]}" \
    "?OPENALEX_MAILTO="

  upsert_env_file "$NODE_ENV_FILE" \
    "RAN_AGENT_INTERNAL_CONTROL_SECRET=$internal_control_secret" \
    "HERMES_API_BASE_URL=http://$API_HOST:$LITE_PORT/v1" \
    "HERMES_LITE_API_BASE_URL=http://$API_HOST:$LITE_PORT/v1" \
    "HERMES_FULL_API_BASE_URL=http://$API_HOST:$FULL_PORT/v1" \
    "RAN_AGENT_CAPABILITY_MODE=auto" \
    "HERMES_CONTEXT_INJECTION_MODE=$HERMES_CONTEXT_INJECTION_MODE_DEFAULT" \
    "HERMES_CONTEXT_CACHE_STRATEGY=$HERMES_CONTEXT_CACHE_STRATEGY_DEFAULT" \
    "HERMES_LITE_PROFILE=$LITE_PROFILE" \
    "HERMES_FULL_PROFILE=$FULL_PROFILE" \
    "HERMES_SESSION_CONTINUITY_ENABLED=true" \
    "HERMES_SESSION_ID_PREFIX=ran-agent" \
    "HERMES_SESSION_KEY_PREFIX=ran-agent-memory" \
    "HERMES_RECENT_TEXT_TURNS=$HERMES_RECENT_TEXT_TURNS_DEFAULT" \
    "HERMES_RECENT_TEXT_CHAR_BUDGET=$HERMES_RECENT_TEXT_CHAR_BUDGET_DEFAULT" \
    "HERMES_RECENT_TEXT_MAX_USER_CHARS=1200" \
    "HERMES_RECENT_TEXT_MAX_ASSISTANT_CHARS=1200" \
    "HERMES_GLOBAL_RECENT_TURNS=$HERMES_GLOBAL_RECENT_TURNS_DEFAULT" \
    "HERMES_GLOBAL_RECENT_CHAR_BUDGET=$HERMES_GLOBAL_RECENT_CHAR_BUDGET_DEFAULT" \
    "HERMES_ACTIVE_TOPIC_CHAR_BUDGET=$HERMES_ACTIVE_TOPIC_CHAR_BUDGET_DEFAULT" \
    "HERMES_CONTINUITY_FRESHNESS_HOURS=$HERMES_CONTINUITY_FRESHNESS_HOURS_DEFAULT" \
    "HERMES_CACHE_FRIENDLY_HISTORY=$HERMES_CACHE_FRIENDLY_HISTORY_DEFAULT" \
    "HERMES_CACHE_FRIENDLY_HISTORY_MAX_TURNS=$HERMES_CACHE_FRIENDLY_HISTORY_MAX_TURNS_DEFAULT" \
    "HERMES_CACHE_FRIENDLY_HISTORY_CHAR_BUDGET=$HERMES_CACHE_FRIENDLY_HISTORY_CHAR_BUDGET_DEFAULT" \
    "HERMES_CACHE_FRIENDLY_HISTORY_PROFILE=$HERMES_CACHE_FRIENDLY_HISTORY_PROFILE_DEFAULT" \
    "HERMES_CACHE_TELEMETRY_ENABLED=$HERMES_CACHE_TELEMETRY_ENABLED_DEFAULT" \
    "HERMES_LITE_SOFT_RESET_ENABLED=$HERMES_LITE_SOFT_RESET_ENABLED_DEFAULT" \
    "HERMES_LITE_SOFT_RESET_DRY_RUN=$HERMES_LITE_SOFT_RESET_DRY_RUN_DEFAULT" \
    "HERMES_LITE_SOFT_RESET_MAX_DIGEST_CHARS=$HERMES_LITE_SOFT_RESET_MAX_DIGEST_CHARS_DEFAULT" \
    "HERMES_LITE_SOFT_RESET_KEEP_LAST_N=$HERMES_LITE_SOFT_RESET_KEEP_LAST_N_DEFAULT" \
    "HERMES_LITE_SOFT_RESET_STATE_FILE=$HERMES_LITE_SOFT_RESET_STATE_FILE_DEFAULT" \
    "HERMES_LITE_SOFT_RESET_DIGEST_DIR=$HERMES_LITE_SOFT_RESET_DIGEST_DIR_DEFAULT" \
    "HERMES_ACTION_GATE_ENABLED=$HERMES_ACTION_GATE_ENABLED_DEFAULT" \
    "HERMES_ACTION_GATE_MODE=$HERMES_ACTION_GATE_MODE_DEFAULT" \
    "HERMES_ACTION_GATE_MAX_REPAIR_ATTEMPTS=$HERMES_ACTION_GATE_MAX_REPAIR_ATTEMPTS_DEFAULT" \
    "HERMES_ACTION_PENDING_ENABLED=$HERMES_ACTION_PENDING_ENABLED_DEFAULT" \
    "HERMES_ACTION_PENDING_TTL_MINUTES=$HERMES_ACTION_PENDING_TTL_MINUTES_DEFAULT" \
    "${reply_window_env[@]}" \
    "HERMES_CONTINUITY_FRESHNESS_HOURS=$HERMES_CONTINUITY_FRESHNESS_HOURS_DEFAULT" \
    "?HERMES_ENVIRONMENT_CONTEXT_ENABLED=$HERMES_ENVIRONMENT_CONTEXT_ENABLED_DEFAULT" \
    "?HERMES_ENVIRONMENT_WEATHER_ENABLED=$HERMES_ENVIRONMENT_WEATHER_ENABLED_DEFAULT" \
    "?HERMES_ENVIRONMENT_MAX_AGE_MS=$HERMES_ENVIRONMENT_MAX_AGE_MS_DEFAULT" \
    "?HERMES_ENVIRONMENT_WEATHER_CACHE_MS=$HERMES_ENVIRONMENT_WEATHER_CACHE_MS_DEFAULT" \
    "?HERMES_ENVIRONMENT_TIMEZONE=$HERMES_ENVIRONMENT_TIMEZONE_DEFAULT" \
    "RAN_AGENT_TIMELINE_MAX_BYTES=52428800" \
    "RAN_AGENT_TIMELINE_MAX_TURNS=5000" \
    "RAN_AGENT_TIMELINE_RETENTION_DAYS=30" \
    "RAN_AGENT_TIMELINE_COMPACT_ENABLED=true" \
    "RAN_AGENT_TIMELINE_ARCHIVE_DIR=/opt/ran_agent/.ran_agent_state/timeline_archive" \
    "PERSONAL_AGENT_PROACTIVE_ENABLED=false" \
    "PERSONAL_AGENT_REMINDER_DELIVERY_ENABLED=false" \
    "${proactive_event_env[@]}" \
    "${external_mcp_env[@]}" \
    "PERSONAL_AGENT_QWEN_TIMEOUT_SECONDS=$PERSONAL_AGENT_QWEN_TIMEOUT_SECONDS_DEFAULT" \
    "PERSONAL_AGENT_KNOWLEDGE_CRON_HOURS=$PERSONAL_AGENT_KNOWLEDGE_CRON_HOURS_DEFAULT" \
    "PERSONAL_AGENT_KNOWLEDGE_CRON_MINUTE=$PERSONAL_AGENT_KNOWLEDGE_CRON_MINUTE_DEFAULT" \
    "PERSONAL_AGENT_DAILY_CARRYOVER_ENABLED=$PERSONAL_AGENT_DAILY_CARRYOVER_ENABLED_DEFAULT" \
    "PERSONAL_AGENT_DAILY_CARRYOVER_HOUR=$PERSONAL_AGENT_DAILY_CARRYOVER_HOUR_DEFAULT" \
    "PERSONAL_AGENT_DAILY_CARRYOVER_MINUTE=$PERSONAL_AGENT_DAILY_CARRYOVER_MINUTE_DEFAULT" \
    "AI_DAILY_DIGEST_ENABLED=$AI_DAILY_DIGEST_ENABLED_DEFAULT" \
    "AI_DAILY_DIGEST_HOUR=$AI_DAILY_DIGEST_HOUR_DEFAULT" \
    "AI_DAILY_DIGEST_MINUTE=$AI_DAILY_DIGEST_MINUTE_DEFAULT" \
    "SEARCH_HUB_ENABLED=true" \
    "SEARCH_HUB_DEFAULT_LIMIT=5" \
    "SEARCH_HUB_TIMEOUT_MS=30000" \
    "SEARCH_HUB_CACHE_TTL_MS=300000" \
    "SEARCH_HUB_CACHE_PATH=/opt/ran_agent/.ran_agent_state/search_hub/cache.jsonl" \
    "SEARCH_HUB_ENABLE_TAVILY=true" \
    "SEARCH_HUB_ENABLE_AIHOT=true" \
    "SEARCH_HUB_ENABLE_OPENCLI=true" \
    "SEARCH_HUB_OPENCLI_BIN=opencli" \
    "SEARCH_HUB_OPENCLI_TIMEOUT_MS=60000" \
    "?OPENALEX_MAILTO=" \
    "?FEISHU_BRIDGE_ENABLED=false" \
    "FEISHU_LARK_CLI_BIN=lark-cli" \
    "FEISHU_LARK_CLI_IDENTITY=bot" \
    "?DESKTOP_PROXY_ENABLED=false" \
    "DESKTOP_PROXY_HOST=127.0.0.1" \
    "DESKTOP_PROXY_PORT=8650" \
    "UV_CACHE_DIR=/opt/ran_agent/.ran_agent_state/uv-cache" \
    "UV_TOOL_DIR=/opt/ran_agent/.ran_agent_state/uv-tools" \
    "UV_LINK_MODE=copy" \
    "UV_PYTHON_DOWNLOADS=never" \
    "SOCIAL_READER_GENERIC_FALLBACK_ENABLED=true" \
    "SOCIAL_READER_XHS_BACKEND_TIMEOUT_MS=90000" \
    "?SOCIAL_READER_XHS_GENERIC_FALLBACK_TIMEOUT_MS=90000" \
    "XHS_BACKEND_MCP_TIMEOUT_MS=90000" \
    "MEDIA_READER_MCP_TIMEOUT_MS=1200000" \
    "PERSONAL_AGENT_MEDIA_DOWNLOAD_TIMEOUT_MS=60000" \
    "PERSONAL_AGENT_MEDIA_MAX_CONCURRENCY=3" \
    "PERSONAL_AGENT_MEDIA_BATCH_TIMEOUT_MS=1200000" \
    "PERSONAL_AGENT_MEDIA_PER_ITEM_TIMEOUT_MS=120000" \
    "${media_reader_ocr_env[@]}" \
    "OBSIDIAN_MEMORY_MCP_ENABLED=false" \
    "XHS_GENERIC_FALLBACK_READY_PATH=/opt/ran_agent/.ran_agent_state/social_reader/generic-fallback-ready.json" \
    "?XHS_GENERIC_FALLBACK_MIN_VERSION=1.2.0" \
    "WEIXIN_SDK_INBOUND_MEDIA_DIRS=$WEIXIN_SDK_INBOUND_MEDIA_DIRS_DEFAULT" \
    "${xhs_public_env[@]}" \
    "${ombre_env[@]}"

  upsert_env_file "$NODE_BRIDGE_ENV_FILE" \
    "${MODEL_POLICY_ENV[@]}" \
    "PERSONAL_AGENT_HERMES_MODEL=$MODEL_NAME" \
    "HERMES_CONTEXT_CACHE_STRATEGY=$HERMES_CONTEXT_CACHE_STRATEGY_DEFAULT" \
    "HERMES_CACHE_FRIENDLY_HISTORY=$HERMES_CACHE_FRIENDLY_HISTORY_DEFAULT" \
    "HERMES_CACHE_FRIENDLY_HISTORY_MAX_TURNS=$HERMES_CACHE_FRIENDLY_HISTORY_MAX_TURNS_DEFAULT" \
    "HERMES_CACHE_FRIENDLY_HISTORY_CHAR_BUDGET=$HERMES_CACHE_FRIENDLY_HISTORY_CHAR_BUDGET_DEFAULT" \
    "HERMES_CACHE_FRIENDLY_HISTORY_PROFILE=$HERMES_CACHE_FRIENDLY_HISTORY_PROFILE_DEFAULT" \
    "HERMES_CACHE_TELEMETRY_ENABLED=$HERMES_CACHE_TELEMETRY_ENABLED_DEFAULT" \
    "HERMES_ACTION_GATE_ENABLED=$HERMES_ACTION_GATE_ENABLED_DEFAULT" \
    "HERMES_ACTION_GATE_MODE=$HERMES_ACTION_GATE_MODE_DEFAULT" \
    "HERMES_ACTION_GATE_MAX_REPAIR_ATTEMPTS=$HERMES_ACTION_GATE_MAX_REPAIR_ATTEMPTS_DEFAULT" \
    "HERMES_ACTION_PENDING_ENABLED=$HERMES_ACTION_PENDING_ENABLED_DEFAULT" \
    "HERMES_ACTION_PENDING_TTL_MINUTES=$HERMES_ACTION_PENDING_TTL_MINUTES_DEFAULT" \
    "${reply_window_env[@]}" \
    "PERSONAL_AGENT_PROACTIVE_ENABLED=false" \
    "?HERMES_ENVIRONMENT_CONTEXT_ENABLED=$HERMES_ENVIRONMENT_CONTEXT_ENABLED_DEFAULT" \
    "?HERMES_ENVIRONMENT_WEATHER_ENABLED=$HERMES_ENVIRONMENT_WEATHER_ENABLED_DEFAULT" \
    "?HERMES_ENVIRONMENT_MAX_AGE_MS=$HERMES_ENVIRONMENT_MAX_AGE_MS_DEFAULT" \
    "?HERMES_ENVIRONMENT_WEATHER_CACHE_MS=$HERMES_ENVIRONMENT_WEATHER_CACHE_MS_DEFAULT" \
    "?HERMES_ENVIRONMENT_TIMEZONE=$HERMES_ENVIRONMENT_TIMEZONE_DEFAULT" \
    "${proactive_event_env[@]}" \
    "${external_mcp_env[@]}" \
    "SOCIAL_READER_GENERIC_FALLBACK_ENABLED=true" \
    "SOCIAL_READER_XHS_BACKEND_TIMEOUT_MS=90000" \
    "?SOCIAL_READER_XHS_GENERIC_FALLBACK_TIMEOUT_MS=90000" \
    "XHS_BACKEND_MCP_TIMEOUT_MS=90000" \
    "MEDIA_READER_MCP_TIMEOUT_MS=1200000" \
    "PERSONAL_AGENT_MEDIA_DOWNLOAD_TIMEOUT_MS=60000" \
    "PERSONAL_AGENT_MEDIA_MAX_CONCURRENCY=3" \
    "PERSONAL_AGENT_MEDIA_BATCH_TIMEOUT_MS=1200000" \
    "PERSONAL_AGENT_MEDIA_PER_ITEM_TIMEOUT_MS=120000" \
    "${media_reader_ocr_env[@]}" \
    "XHS_GENERIC_FALLBACK_READY_PATH=/opt/ran_agent/.ran_agent_state/social_reader/generic-fallback-ready.json" \
    "?XHS_GENERIC_FALLBACK_MIN_VERSION=1.2.0" \
    "WEIXIN_SDK_INBOUND_MEDIA_DIRS=$WEIXIN_SDK_INBOUND_MEDIA_DIRS_DEFAULT" \
    "${xhs_public_env[@]}" \
    "${ombre_env[@]}"
}

filter_obsidian_memory_from_config() {
  local file="$1"
  local tmp_filter
  tmp_filter="$(mktemp)"
  awk '
    /^mcp_servers:/ { in_mcp=1 }
    in_mcp && /^  obsidian_memory:/ { skip=1; next }
    in_mcp && skip && /^  [^ ]/ { skip=0 }
    in_mcp && skip { next }
    /^platform_toolsets:/ { in_pt=1 }
    in_pt && /mcp-obsidian_memory/ { next }
    { print }
  ' "$file" >| "$tmp_filter"
  "${SUDO[@]}" cp "$tmp_filter" "$file"
  rm -f "$tmp_filter"
}

write_lite_runtime_config() {
  log "refreshing lite runtime config"
  write_model_selected_config "$REPO_ROOT/hermes/profile/config.lite.yaml" "$LITE_HOME/config.yaml"
  write_model_selected_config "$REPO_ROOT/hermes/profile/config.lite.yaml" "$LITE_HOME/profiles/$LITE_PROFILE/config.yaml"
  if [ "${OBSIDIAN_MEMORY_MCP_ENABLED:-false}" = "false" ]; then
    filter_obsidian_memory_from_config "$LITE_HOME/config.yaml"
    filter_obsidian_memory_from_config "$LITE_HOME/profiles/$LITE_PROFILE/config.yaml"
  fi
  chown_if_user_exists "$LITE_HOME"
}

write_full_runtime_config() {
  local profile_config="$FULL_HOME/profiles/$FULL_PROFILE/config.yaml"
  local runtime_config="$FULL_HOME/config.yaml"
  local tmp

  log "refreshing full runtime config"
  if ! "${SUDO[@]}" test -f "$profile_config"; then
    echo "ERROR: missing installed full profile config: $profile_config" >&2
    exit 1
  fi

  tmp="$(mktemp)"
  cat >| "$tmp" <<EOF
# Generated by scripts/apply-hermes-runtime-split.sh.
# Secrets stay in .env files; this file contains runtime shape only.

model:
  provider: deepseek
  default: $MODEL_NAME
  model: $MODEL_NAME
  base_url: https://api.deepseek.com/v1
  api_mode: chat_completions

web:
  search_backend: tavily
  extract_backend: tavily

compression:
  enabled: true
  threshold: 0.35
  target_ratio: 0.12
  protect_last_n: 8
  hygiene_hard_message_limit: 160

auxiliary:
  compression:
    provider: main
    model: ''
    base_url: null
  web_extract:
    provider: main
    model: ''
    base_url: null
  session_search:
    provider: main
    model: ''
    base_url: null

terminal:
  backend: local
  cwd: /opt/ran_agent
  timeout: 180
  lifetime_seconds: 300

disabled_tools:
  - browser_vision
  - image_generate
  - text_to_speech
  - video_analyze
  - vision_analyze

platform_toolsets:
  cli:
    - web
    - terminal
    - file
    - skills
    - memory
    - session_search
    - safe
    - mcp-time
    - mcp-social_reader
    - mcp-media_reader
    - mcp-search_hub
    - mcp-co_reading
    - mcp-sticker_catalog
    - mcp-media_generation
    - mcp-personal_memory
    - mcp-obsidian_memory
    - mcp-ombre_memory
    - mcp-playwright
  gateway:
    - web
    - terminal
    - file
    - skills
    - memory
    - session_search
    - safe
    - mcp-time
    - mcp-social_reader
    - mcp-media_reader
    - mcp-search_hub
    - mcp-co_reading
    - mcp-sticker_catalog
    - mcp-media_generation
    - mcp-personal_memory
    - mcp-obsidian_memory
    - mcp-ombre_memory
    - mcp-playwright

EOF

  "${SUDO[@]}" awk 'BEGIN { copy=0 } /^mcp_servers:/ { copy=1 } copy { print }' "$profile_config" >> "$tmp"
  if ! "${SUDO[@]}" grep -Eq '^  tavily:' "$profile_config"; then
    cat >> "$tmp" <<'EOF'

  tavily:
    url: "https://mcp.tavily.com/mcp/?tavilyApiKey=${TAVILY_API_KEY}"
    timeout: 60
    connect_timeout: 30
EOF
  fi

  if [ "${OBSIDIAN_MEMORY_MCP_ENABLED:-false}" = "false" ]; then
    filter_obsidian_memory_from_config "$tmp"
  fi
  install_file_portable 644 "$tmp" "$runtime_config"
  chown_if_user_exists "$runtime_config"
  rm -f "$tmp"
}

write_ombre_recall_unit() {
  write_file 0644 "$OMBRE_RECALL_SERVICE" <<EOF
[Unit]
Description=Ran Agent Ombre Recall-Only MCP Adapter (port $OMBRE_RECALL_PORT_DEFAULT)
After=network-online.target ran-agent-ombre-brain.service
Requires=ran-agent-ombre-brain.service

[Service]
Type=simple
User=$RUNTIME_USER
Group=$RUNTIME_GROUP
WorkingDirectory=/opt/ran_agent
EnvironmentFile=-$NODE_ENV_FILE
EnvironmentFile=-$NODE_BRIDGE_ENV_FILE
Environment=OMBRE_RECALL_BIND_HOST=127.0.0.1
Environment=OMBRE_RECALL_PORT=$OMBRE_RECALL_PORT_DEFAULT
ExecStart=/opt/nodejs/node-v22.22.2-linux-x64/bin/node /opt/ran_agent/node_bridge/src/ombreRecallMcpServer.mjs
Restart=on-failure
RestartSec=5
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
EOF
}

write_node_steward_identity_dropin() {
  write_file 0644 "$NODE_STEWARD_DROPIN" <<EOF
[Service]
User=$RUNTIME_USER
Group=$RUNTIME_GROUP
Environment=RAN_AGENT_STATE_DIR=$RUNTIME_STATE_DIR
Environment=RAN_AGENT_NODE_BIN=${RAN_AGENT_NODE_BIN:-/opt/nodejs/node-v22.22.2-linux-x64/bin/node}
Environment=RAN_AGENT_STEWARD_TOKEN_FILE=$RUNTIME_STATE_DIR/ombre-compat/secrets/steward-api-token
Environment=OMBRE_COMPAT_STEWARD_IDENTITY_FILE=$OMBRE_BRAIN_HOME_DEFAULT/steward-identity.v1.json
EOF
}

write_ombre_brain_unit() {
  local buckets_dir
  buckets_dir="$(effective_env_value OMBRE_BUCKETS_DIR "$OMBRE_BUCKETS_DIR_DEFAULT")"
  write_file 0644 "$OMBRE_SERVICE" <<EOF
[Unit]
Description=Ran Agent Ombre Brain Memory Service (port $OMBRE_BRAIN_PORT_DEFAULT)
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=30
StartLimitBurst=3

[Service]
Type=simple
User=$RUNTIME_USER
Group=$RUNTIME_GROUP
WorkingDirectory=/opt/ran_agent
EnvironmentFile=-$NODE_ENV_FILE
EnvironmentFile=-$NODE_BRIDGE_ENV_FILE
EnvironmentFile=-$HERMES_GLOBAL_ENV_FILE
EnvironmentFile=-$FULL_HOME/.env
EnvironmentFile=-$FULL_HOME/profiles/$FULL_PROFILE/.env
UnsetEnvironment=BASH_ENV ENV BASHOPTS SHELLOPTS BASH_XTRACEFD PYTHONHOME PYTHONPATH PYTHONSTARTUP LD_PRELOAD LD_LIBRARY_PATH
Environment=RAN_AGENT_REPO_ROOT=/opt/ran_agent
Environment=OMBRE_BRAIN_RUNNER=source
Environment=OMBRE_BRAIN_COMMIT=$OMBRE_BRAIN_COMMIT_DEFAULT
Environment=OMBRE_BIND_HOST=127.0.0.1
Environment=OMBRE_MCP_REQUIRE_AUTH=false
Environment=OMBRE_TRANSPORT=streamable-http
Environment=OMBRE_PORT=$OMBRE_BRAIN_PORT_DEFAULT
Environment=OMBRE_BRAIN_MCP_URL=http://127.0.0.1:18001/mcp
Environment=OMBRE_BRAIN_HEALTH_URL=http://127.0.0.1:18001/health
Environment=RAN_AGENT_STATE_DIR=$RUNTIME_STATE_DIR
Environment=OMBRE_BRAIN_HOME=$OMBRE_BRAIN_HOME_DEFAULT
Environment=RAN_AGENT_MANAGED_OMBRE_RUNTIME=1
Environment=RAN_AGENT_MANAGED_OMBRE_STATE_DIR=$RUNTIME_STATE_DIR
Environment=RAN_AGENT_MANAGED_OMBRE_BUCKETS_DIR=$buckets_dir
Environment=OMBRE_CONFIG_PATH=$OMBRE_BRAIN_HOME_DEFAULT/config.yaml
Environment=OMBRE_VAULT_DIR=$buckets_dir
Environment=OMBRE_BUCKETS_DIR=$buckets_dir
Environment=RAN_AGENT_STEWARD_IDENTITY_FILE=$RUNTIME_STATE_DIR/ombre-brain/steward-identity.v1.json
Environment=RAN_AGENT_STEWARD_TOKEN_FILE=$RUNTIME_STATE_DIR/ombre-compat/secrets/steward-api-token
ExecStart=/usr/bin/bash /opt/ran_agent/scripts/start_ombre_brain_service.sh --managed /opt/ran_agent $RUNTIME_STATE_DIR $buckets_dir
Restart=on-failure
RestartSec=2
TimeoutStopSec=120

[Install]
WantedBy=multi-user.target
EOF
}

write_systemd_units() {
  log "refreshing systemd units"
  write_file 0644 "$LITE_SERVICE" <<EOF
[Unit]
Description=Ran Agent Hermes Lite Gateway (port $LITE_PORT)
After=network-online.target ran-agent-python.service ran-agent-ombre-brain.service ran-agent-ombre-recall.service
Wants=network-online.target

[Service]
Type=simple
User=$RUNTIME_USER
Group=$RUNTIME_GROUP
WorkingDirectory=/opt/ran_agent
EnvironmentFile=-$NODE_ENV_FILE
EnvironmentFile=-$NODE_BRIDGE_ENV_FILE
EnvironmentFile=-$HERMES_GLOBAL_ENV_FILE
EnvironmentFile=-$LITE_HOME/.env
EnvironmentFile=-$LITE_HOME/profiles/$LITE_PROFILE/.env
Environment=RAN_AGENT_REPO_ROOT=/opt/ran_agent
Environment=HERMES_HOME=$LITE_HOME
Environment=HERMES_PROFILE=$LITE_PROFILE
Environment=API_SERVER_ENABLED=true
Environment=API_SERVER_HOST=$API_HOST
Environment=API_SERVER_PORT=$LITE_PORT
Environment=API_SERVER_MODEL_NAME=$LITE_PROFILE
Environment=HERMES_API_BASE_URL=http://$API_HOST:$LITE_PORT/v1
Environment=HERMES_REPLY_MODE=api
Environment=HERMES_REPLY_TIMEOUT_SECONDS=$HERMES_REPLY_TIMEOUT_SECONDS_DEFAULT
Environment=HERMES_RESTART_DRAIN_TIMEOUT=60
Environment=PYTHON_BACKEND_BASE_URL=http://127.0.0.1:8787
Environment=PYTHON_BACKEND_INGEST_TIMEOUT_MS=5000
Environment=PERSONAL_MEMORY_BACKEND_TIMEOUT_MS=5000
Environment=PERSONAL_AGENT_PROACTIVE_ENABLED=false
Environment=PERSONAL_AGENT_REMINDER_DELIVERY_ENABLED=false
Environment=HERMES_PROACTIVE_EVENTS_ENABLED=$HERMES_PROACTIVE_EVENTS_ENABLED_DEFAULT
Environment=HERMES_PROACTIVE_EXTERNAL_MCP_ENABLED=$HERMES_PROACTIVE_EXTERNAL_MCP_ENABLED_DEFAULT
Environment=HERMES_PROACTIVE_REMINDERS_ENABLED=$HERMES_PROACTIVE_REMINDERS_ENABLED_DEFAULT
Environment=UV_CACHE_DIR=/opt/ran_agent/.ran_agent_state/uv-cache
Environment=UV_TOOL_DIR=/opt/ran_agent/.ran_agent_state/uv-tools
Environment=UV_LINK_MODE=copy
Environment=UV_PYTHON_DOWNLOADS=never
Environment=SOCIAL_READER_GENERIC_FALLBACK_ENABLED=true
Environment=SOCIAL_READER_XHS_BACKEND_TIMEOUT_MS=90000
Environment=SOCIAL_READER_XHS_GENERIC_FALLBACK_TIMEOUT_MS=90000
Environment=XHS_BACKEND_MCP_TIMEOUT_MS=90000
Environment=XHS_PUBLIC_SIDECAR_ENABLED=$XHS_PUBLIC_SIDECAR_ENABLED_DEFAULT
Environment=XHS_PUBLIC_SIDECAR_URL=$XHS_PUBLIC_SIDECAR_URL_DEFAULT
Environment=XHS_PUBLIC_SIDECAR_TIMEOUT_MS=$XHS_PUBLIC_SIDECAR_TIMEOUT_MS_DEFAULT
Environment=XHS_PUBLIC_HTML_FALLBACK_ENABLED=$XHS_PUBLIC_HTML_FALLBACK_ENABLED_DEFAULT
Environment=XHS_PUBLIC_SIDECAR_MARKER_PATH=$XHS_PUBLIC_SIDECAR_MARKER_PATH_DEFAULT
Environment=MEDIA_READER_MCP_TIMEOUT_MS=1200000
Environment=PERSONAL_AGENT_MEDIA_DOWNLOAD_TIMEOUT_MS=60000
Environment=PERSONAL_AGENT_MEDIA_MAX_CONCURRENCY=3
Environment=PERSONAL_AGENT_MEDIA_BATCH_TIMEOUT_MS=1200000
Environment=PERSONAL_AGENT_MEDIA_PER_ITEM_TIMEOUT_MS=120000
Environment=PERSONAL_AGENT_OCR_PROVIDER=$PERSONAL_AGENT_OCR_PROVIDER_DEFAULT
Environment=PERSONAL_AGENT_OCR_MODEL=$PERSONAL_AGENT_OCR_MODEL_DEFAULT
Environment=PERSONAL_AGENT_OCR_TIMEOUT_MS=$PERSONAL_AGENT_OCR_TIMEOUT_MS_DEFAULT
Environment=XHS_GENERIC_FALLBACK_MIN_VERSION=1.2.0
Environment=OBSIDIAN_MEMORY_MCP_ENABLED=false
ExecStart=/usr/bin/env bash -lc 'cd /opt/ran_agent && source /opt/ran_agent/.venv/bin/activate && exec hermes -p $LITE_PROFILE gateway run --replace --accept-hooks'
Restart=always
RestartSec=5
TimeoutStopSec=240

[Install]
WantedBy=multi-user.target
EOF

  write_file 0644 "$FULL_SERVICE" <<EOF
[Unit]
Description=Ran Agent Hermes Full Gateway (port $FULL_PORT)
After=network-online.target ran-agent-python.service ran-agent-ombre-brain.service ran-agent-ombre-recall.service
Wants=network-online.target

[Service]
Type=simple
User=$RUNTIME_USER
Group=$RUNTIME_GROUP
WorkingDirectory=/opt/ran_agent
EnvironmentFile=-$NODE_ENV_FILE
EnvironmentFile=-$NODE_BRIDGE_ENV_FILE
EnvironmentFile=-$HERMES_GLOBAL_ENV_FILE
EnvironmentFile=-$FULL_HOME/.env
EnvironmentFile=-$FULL_HOME/profiles/$FULL_PROFILE/.env
Environment=RAN_AGENT_REPO_ROOT=/opt/ran_agent
Environment=HERMES_HOME=$FULL_HOME
Environment=HERMES_PROFILE=$FULL_PROFILE
Environment=API_SERVER_ENABLED=true
Environment=API_SERVER_HOST=$API_HOST
Environment=API_SERVER_PORT=$FULL_PORT
Environment=API_SERVER_MODEL_NAME=$FULL_PROFILE
Environment=HERMES_API_BASE_URL=http://$API_HOST:$FULL_PORT/v1
Environment=HERMES_REPLY_MODE=api
Environment=HERMES_REPLY_TIMEOUT_SECONDS=$HERMES_REPLY_TIMEOUT_SECONDS_DEFAULT
Environment=HERMES_RESTART_DRAIN_TIMEOUT=60
Environment=PYTHON_BACKEND_BASE_URL=http://127.0.0.1:8787
Environment=PYTHON_BACKEND_INGEST_TIMEOUT_MS=5000
Environment=PERSONAL_MEMORY_BACKEND_TIMEOUT_MS=5000
Environment=PERSONAL_AGENT_PROACTIVE_ENABLED=false
Environment=PERSONAL_AGENT_REMINDER_DELIVERY_ENABLED=false
Environment=HERMES_PROACTIVE_EVENTS_ENABLED=$HERMES_PROACTIVE_EVENTS_ENABLED_DEFAULT
Environment=HERMES_PROACTIVE_EXTERNAL_MCP_ENABLED=$HERMES_PROACTIVE_EXTERNAL_MCP_ENABLED_DEFAULT
Environment=HERMES_PROACTIVE_REMINDERS_ENABLED=$HERMES_PROACTIVE_REMINDERS_ENABLED_DEFAULT
Environment=UV_CACHE_DIR=/opt/ran_agent/.ran_agent_state/uv-cache
Environment=UV_TOOL_DIR=/opt/ran_agent/.ran_agent_state/uv-tools
Environment=UV_LINK_MODE=copy
Environment=UV_PYTHON_DOWNLOADS=never
Environment=SOCIAL_READER_GENERIC_FALLBACK_ENABLED=true
Environment=SOCIAL_READER_XHS_BACKEND_TIMEOUT_MS=90000
Environment=SOCIAL_READER_XHS_GENERIC_FALLBACK_TIMEOUT_MS=90000
Environment=XHS_BACKEND_MCP_TIMEOUT_MS=90000
Environment=XHS_PUBLIC_SIDECAR_ENABLED=$XHS_PUBLIC_SIDECAR_ENABLED_DEFAULT
Environment=XHS_PUBLIC_SIDECAR_URL=$XHS_PUBLIC_SIDECAR_URL_DEFAULT
Environment=XHS_PUBLIC_SIDECAR_TIMEOUT_MS=$XHS_PUBLIC_SIDECAR_TIMEOUT_MS_DEFAULT
Environment=XHS_PUBLIC_HTML_FALLBACK_ENABLED=$XHS_PUBLIC_HTML_FALLBACK_ENABLED_DEFAULT
Environment=XHS_PUBLIC_SIDECAR_MARKER_PATH=$XHS_PUBLIC_SIDECAR_MARKER_PATH_DEFAULT
Environment=MEDIA_READER_MCP_TIMEOUT_MS=1200000
Environment=PERSONAL_AGENT_MEDIA_DOWNLOAD_TIMEOUT_MS=60000
Environment=PERSONAL_AGENT_MEDIA_MAX_CONCURRENCY=3
Environment=PERSONAL_AGENT_MEDIA_BATCH_TIMEOUT_MS=1200000
Environment=PERSONAL_AGENT_MEDIA_PER_ITEM_TIMEOUT_MS=120000
Environment=PERSONAL_AGENT_OCR_PROVIDER=$PERSONAL_AGENT_OCR_PROVIDER_DEFAULT
Environment=PERSONAL_AGENT_OCR_MODEL=$PERSONAL_AGENT_OCR_MODEL_DEFAULT
Environment=PERSONAL_AGENT_OCR_TIMEOUT_MS=$PERSONAL_AGENT_OCR_TIMEOUT_MS_DEFAULT
Environment=XHS_GENERIC_FALLBACK_MIN_VERSION=1.2.0
Environment=OBSIDIAN_MEMORY_MCP_ENABLED=false
ExecStart=/usr/bin/env bash -lc 'cd /opt/ran_agent && source /opt/ran_agent/.venv/bin/activate && exec hermes -p $FULL_PROFILE gateway run --replace --accept-hooks'
Restart=always
RestartSec=5
TimeoutStopSec=240

[Install]
WantedBy=multi-user.target
EOF

  write_ombre_brain_unit
  write_ombre_recall_unit

  write_file 0644 "$XHS_PUBLIC_SIDECAR_SERVICE" <<EOF
[Unit]
Description=Ran Agent XHS Public Sidecar (XHS-Downloader API, port $XHS_PUBLIC_SIDECAR_PORT_DEFAULT)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUNTIME_USER
WorkingDirectory=/opt/ran_agent
EnvironmentFile=-$NODE_ENV_FILE
EnvironmentFile=-$NODE_BRIDGE_ENV_FILE
Environment=RAN_AGENT_REPO_ROOT=/opt/ran_agent
Environment=XHS_PUBLIC_SIDECAR_ENABLED=$XHS_PUBLIC_SIDECAR_ENABLED_DEFAULT
Environment=XHS_PUBLIC_SIDECAR_HOST=$XHS_PUBLIC_SIDECAR_HOST_DEFAULT
Environment=XHS_PUBLIC_SIDECAR_PORT=$XHS_PUBLIC_SIDECAR_PORT_DEFAULT
Environment=XHS_PUBLIC_SIDECAR_MARKER_PATH=$XHS_PUBLIC_SIDECAR_MARKER_PATH_DEFAULT
Environment=XHS_PUBLIC_SIDECAR_ROOT_DIR=$XHS_PUBLIC_SIDECAR_ROOT_DIR_DEFAULT
ExecStart=/usr/bin/env bash -lc 'cd /opt/ran_agent && source /opt/ran_agent/.venv/bin/activate && exec bash scripts/start_xhs_public_sidecar.sh'
Restart=on-failure
RestartSec=10
TimeoutStopSec=120

[Install]
WantedBy=multi-user.target
EOF

  # A release candidate deliberately does not repair legacy runtime drift:
  # those files may belong to an arbitrary installed MCP provider.
  if [ "$PRESERVE_RUNTIME_SHAPE" != "1" ]; then
    cleanup_stale_lite_dropins
  fi
  if [ "$PRESERVE_RUNTIME_SHAPE" != "1" ]; then
    "${SUDO[@]}" rm -f "$XHS_BROWSE_SERVICE"
  fi
}

cleanup_stale_lite_dropins() {
  local dropin
  for dropin in "${STALE_LITE_DROPINS[@]}"; do
    "${SUDO[@]}" rm -f "$dropin"
  done
}

systemd_unit_is_loaded() {
  local service="$1"
  local load_state
  load_state=$("${SUDO[@]}" systemctl show "$service" --property=LoadState --value 2>/dev/null) || return 1
  [ -n "$load_state" ] && [ "$load_state" != "not-found" ]
}

reset_failed_if_loaded() {
  local service
  for service in "$@"; do
    if systemd_unit_is_loaded "$service"; then
      if "${SUDO[@]}" systemctl is-failed --quiet "$service"; then
        "${SUDO[@]}" systemctl reset-failed "$service"
      fi
    fi
  done
}

start_o1_dependency() {
  local service="$1"
  local enabled_state
  enabled_state="$("${SUDO[@]}" systemctl is-enabled "$service" 2>/dev/null || true)"
  [ "$enabled_state" != "masked" ] && [ "$enabled_state" != "masked-runtime" ] || {
    echo "ERROR: $service is masked; O1 will not unmask operator policy" >&2
    return 1
  }
  systemd_unit_is_loaded "$service" || {
    echo "ERROR: required generated unit is still not-found after daemon-reload: $service" >&2
    return 1
  }
  reset_failed_if_loaded "$service"
  "${SUDO[@]}" systemctl enable "$service" >/dev/null
  "${SUDO[@]}" systemctl restart "$service"
}

refuse_masked_o1_units() {
  local service state
  for service in ran-agent-ombre-brain.service ran-agent-ombre-recall.service; do
    state="$("${SUDO[@]}" systemctl is-enabled "$service" 2>/dev/null || true)"
    [ "$state" != "masked" ] && [ "$state" != "masked-runtime" ] || {
      echo "ERROR: $service is masked; O1 will not overwrite or unmask operator policy" >&2
      return 1
    }
  done
}

xhs_public_sidecar_marker_ready() {
  local marker_path
  marker_path="$(effective_env_value XHS_PUBLIC_SIDECAR_MARKER_PATH "$XHS_PUBLIC_SIDECAR_MARKER_PATH_DEFAULT")"
  [ -f "$marker_path" ] || return 1
  python3 - "$marker_path" <<'PYEOF'
import json, os, sys
try:
    with open(sys.argv[1], "r", encoding="utf-8") as fh:
        marker = json.load(fh)
except Exception:
    sys.exit(1)
required = [
    marker.get("source_dir", ""),
    marker.get("venv_python", ""),
]
ok = (
    marker.get("ok") is True
    and all(path and os.path.exists(path) for path in required)
    and os.access(marker.get("venv_python", ""), os.X_OK)
    and str(marker.get("api_url", "")).startswith("http://127.0.0.1:")
)
sys.exit(0 if ok else 1)
PYEOF
}

cleanup_account_backed_xhs_runtime() {
  log "removing account-backed XHS browse runtime surfaces"
  "${SUDO[@]}" systemctl disable --now ran-agent-xhs-browse.service >/dev/null 2>&1 || true
  "${SUDO[@]}" rm -f "$XHS_BROWSE_SERVICE"
  "${SUDO[@]}" rm -f \
    /opt/ran_agent/.ran_agent_state/social_reader/xhs-browse-ready.json \
    /opt/ran_agent/.ran_agent_state/social_reader/xhs-note-token-cache.json \
    /opt/ran_agent/node_bridge/.ran_agent_state/social_reader/xhs-note-token-cache.json
}

prepare_ombre_runtime() {
  if ! ombre_brain_enabled; then
    return 0
  fi
  local buckets_dir prepare_path=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  if [[ "${RAN_AGENT_TEST_MODE:-0}" == 1 ]]; then prepare_path="$PATH"; fi
  buckets_dir="$(effective_env_value OMBRE_BUCKETS_DIR "$OMBRE_BUCKETS_DIR_DEFAULT")"
  local buckets_parent="${buckets_dir%/*}"
  local buckets_grandparent="${buckets_parent%/*}"
  if [[ "$buckets_dir" != /* || -z "$buckets_grandparent" || "$buckets_grandparent" = / ||
    "$buckets_dir" =~ (^|/)\.\.?(/|$) || "$buckets_dir" = *//* || "$buckets_dir" = */ ||
    "$buckets_dir" = "$REPO_ROOT" || "$buckets_dir" = "$RUNTIME_STATE_DIR" ||
    "$buckets_dir" = "$OMBRE_BRAIN_HOME_DEFAULT" ]]; then
    echo "ERROR: unsafe Ombre buckets directory" >&2
    return 1
  fi
  if [ "${RAN_AGENT_TEST_MODE:-0}" != 1 ]; then
    local checked_path="$buckets_dir"
    while [ "$checked_path" != / ]; do
      if "${SUDO[@]}" test -L "$checked_path"; then
        echo "ERROR: Ombre buckets path must not contain symlinks" >&2
        return 1
      fi
      checked_path="${checked_path%/*}"
      [ -n "$checked_path" ] || checked_path=/
    done
  fi
  if "${SUDO[@]}" test -L "$OMBRE_BRAIN_HOME_DEFAULT" || "${SUDO[@]}" test -L "$buckets_dir"; then
    echo "ERROR: Ombre runtime paths must not be symlinks" >&2
    return 1
  fi
  "${SUDO[@]}" mkdir -p "$OMBRE_BRAIN_HOME_DEFAULT" "$buckets_dir"
  "${SUDO[@]}" chown -R "$RUNTIME_USER:$RUNTIME_GROUP" "$OMBRE_BRAIN_HOME_DEFAULT" "$buckets_dir"
  log "preparing Ombre Brain runtime"
  if run_as_runtime_identity /usr/bin/env -i \
    HOME="$OMBRE_BRAIN_HOME_DEFAULT" \
    PATH="$prepare_path" \
    TMPDIR=/tmp \
    OMBRE_BRAIN_ENABLED="$(effective_env_value OMBRE_BRAIN_ENABLED "$OMBRE_BRAIN_ENABLED_DEFAULT")" \
    OMBRE_BRAIN_MCP_ENABLED="$(effective_env_value OMBRE_BRAIN_MCP_ENABLED "$OMBRE_BRAIN_MCP_ENABLED_DEFAULT")" \
    OMBRE_BRAIN_RUNNER="$(effective_env_value OMBRE_BRAIN_RUNNER "$OMBRE_BRAIN_RUNNER_DEFAULT")" \
    OMBRE_BRAIN_COMMIT="$(effective_env_value OMBRE_BRAIN_COMMIT "$OMBRE_BRAIN_COMMIT_DEFAULT")" \
    OMBRE_BRAIN_REPO_URL="$(effective_env_value OMBRE_BRAIN_REPO_URL "$OMBRE_BRAIN_REPO_URL_DEFAULT")" \
    OMBRE_BRAIN_HOME="$OMBRE_BRAIN_HOME_DEFAULT" \
    OMBRE_BRAIN_SOURCE_DIR="$OMBRE_BRAIN_SOURCE_DIR_DEFAULT" \
    OMBRE_BRAIN_VENV="$OMBRE_BRAIN_VENV_DEFAULT" \
    OMBRE_BUCKETS_DIR="$buckets_dir" \
    OMBRE_BRAIN_IMAGE="$(effective_env_value OMBRE_BRAIN_IMAGE "$OMBRE_BRAIN_IMAGE_DEFAULT")" \
    OMBRE_BIND_HOST="$(effective_env_value OMBRE_BIND_HOST "$OMBRE_BIND_HOST_DEFAULT")" \
    OMBRE_MCP_REQUIRE_AUTH="$(effective_env_value OMBRE_MCP_REQUIRE_AUTH "$OMBRE_MCP_REQUIRE_AUTH_DEFAULT")" \
    OMBRE_BRAIN_PORT="$(effective_env_value OMBRE_BRAIN_PORT "$OMBRE_BRAIN_PORT_DEFAULT")" \
    OMBRE_BRAIN_COMPOSE_FILE="$OMBRE_BRAIN_COMPOSE_FILE_DEFAULT" \
    OMBRE_BRAIN_CONFIG_FILE="$OMBRE_BRAIN_CONFIG_FILE_DEFAULT" \
    OMBRE_BRAIN_STATUS_FILE="$OMBRE_BRAIN_STATUS_FILE_DEFAULT" \
    RAN_AGENT_STATE_DIR="$RUNTIME_STATE_DIR" \
    RAN_AGENT_RUNTIME_USER="$RUNTIME_USER" \
    RAN_AGENT_RUNTIME_GROUP="$RUNTIME_GROUP" \
    RAN_AGENT_TEST_MODE="${RAN_AGENT_TEST_MODE:-0}" \
    RAN_AGENT_OMBRE_PATCH_PYTHON_BIN="${RAN_AGENT_OMBRE_PATCH_PYTHON_BIN:-}" \
    RAN_AGENT_ROTATE_STEWARD_TOKEN="${RAN_AGENT_ROTATE_STEWARD_TOKEN:-0}" \
    RAN_AGENT_STEWARD_ROTATION_QUIESCED="${RAN_AGENT_STEWARD_ROTATION_QUIESCED:-0}" \
    OMBRE_BRAIN_UPDATE_SOURCE="${OMBRE_BRAIN_UPDATE_SOURCE:-true}" \
    OMBRE_BRAIN_UPDATE_TIMEOUT_SECONDS="${OMBRE_BRAIN_UPDATE_TIMEOUT_SECONDS:-300}" \
    /bin/bash "$REPO_ROOT/scripts/prepare-ombre-brain.sh" 2>&1; then
    if "${SUDO[@]}" test -L "$OMBRE_BRAIN_HOME_DEFAULT" ||
      ! "${SUDO[@]}" test -d "$OMBRE_BRAIN_HOME_DEFAULT" ||
      ! "${SUDO[@]}" test -d "$buckets_dir"; then
      echo "ERROR: prepared Ombre runtime paths are not real directories" >&2
      return 1
    fi
    log "Ombre Brain runtime prepared"
  else
    echo "ERROR: Ombre Brain preparation failed" >&2
    return 1
  fi
}

restart_services() {
  log "reloading systemd and restarting services"
  "${SUDO[@]}" systemctl daemon-reload
  verify_service_runtime_identity ran-agent-node.service
  verify_service_runtime_identity ran-agent-ombre-brain.service
  sleep 1
  if [ "$PRESERVE_RUNTIME_SHAPE" = "1" ]; then
    reset_failed_if_loaded ran-agent-python.service ran-agent-node.service ran-agent-hermes.service ran-agent-hermes-full.service ran-agent-ombre-brain.service ran-agent-ombre-recall.service
    prepare_ombre_runtime
    start_o1_dependency ran-agent-ombre-brain.service
    wait_for_ombre_health
    verify_service_runtime_identity ran-agent-ombre-brain.service
    verify_steward_runtime_health
    start_o1_dependency ran-agent-ombre-recall.service
    wait_for_ombre_recall_health
    "${SUDO[@]}" systemctl restart ran-agent-python.service
    publish_verified_hermes_projection
    "${SUDO[@]}" systemctl restart ran-agent-hermes.service
    wait_for_gateway_port "$LITE_PORT" ran-agent-hermes.service
    run_gateway_provider_canary lite "$LITE_PORT" "$LITE_PROFILE" ran-agent-hermes.service
    "${SUDO[@]}" systemctl restart ran-agent-hermes-full.service
    wait_for_gateway_port "$FULL_PORT" ran-agent-hermes-full.service
    run_gateway_provider_canary full "$FULL_PORT" "$FULL_PROFILE" ran-agent-hermes-full.service
    "${SUDO[@]}" systemctl restart ran-agent-node.service
    verify_service_runtime_identity ran-agent-node.service
    return 0
  fi
  reset_failed_if_loaded ran-agent-python.service ran-agent-node.service ran-agent-hermes.service ran-agent-hermes-full.service ran-agent-ombre-brain.service ran-agent-ombre-recall.service ran-agent-xhs-public-sidecar.service
  cleanup_account_backed_xhs_runtime
  if ombre_brain_enabled; then
    if ombre_runner_available; then
      start_o1_dependency ran-agent-ombre-brain.service
      wait_for_ombre_health
      verify_service_runtime_identity ran-agent-ombre-brain.service
      verify_steward_runtime_health
      start_o1_dependency ran-agent-ombre-recall.service
      wait_for_ombre_recall_health
    else
      echo "ERROR: Ombre Brain runner is not available" >&2
      return 1
    fi
  else
    "${SUDO[@]}" systemctl disable --now ran-agent-ombre-brain.service >/dev/null 2>&1 || true
    "${SUDO[@]}" systemctl disable --now ran-agent-ombre-recall.service >/dev/null 2>&1 || true
  fi
  if bool_is_true "$XHS_PUBLIC_SIDECAR_ENABLED_DEFAULT" && xhs_public_sidecar_marker_ready; then
    "${SUDO[@]}" systemctl enable ran-agent-xhs-public-sidecar.service >/dev/null 2>&1 || true
    if "${SUDO[@]}" systemctl restart ran-agent-xhs-public-sidecar.service; then
      log "XHS public sidecar service restart requested"
    else
      log "WARNING: XHS public sidecar service restart failed (non-blocking)"
    fi
  else
    log "XHS public sidecar marker not ready or disabled; service disabled until prepare succeeds"
    "${SUDO[@]}" systemctl disable --now ran-agent-xhs-public-sidecar.service >/dev/null 2>&1 || true
  fi
  "${SUDO[@]}" systemctl restart ran-agent-python.service
  publish_verified_hermes_projection
  "${SUDO[@]}" systemctl restart ran-agent-hermes.service
  wait_for_gateway_port "$LITE_PORT" ran-agent-hermes.service
  run_gateway_provider_canary lite "$LITE_PORT" "$LITE_PROFILE" ran-agent-hermes.service
  "${SUDO[@]}" systemctl restart ran-agent-hermes-full.service
  wait_for_gateway_port "$FULL_PORT" ran-agent-hermes-full.service
  run_gateway_provider_canary full "$FULL_PORT" "$FULL_PROFILE" ran-agent-hermes-full.service
  "${SUDO[@]}" systemctl restart ran-agent-node.service
  verify_service_runtime_identity ran-agent-node.service
}

print_failure_context() {
  echo ""
  echo "ERROR: Hermes runtime split verification failed." >&2
  echo "--- effective systemd units (systemctl cat) ---" >&2
  "${SUDO[@]}" systemctl cat ran-agent-hermes.service ran-agent-hermes-full.service ran-agent-xhs-public-sidecar.service >&2 || true
  echo "--- service status ---" >&2
  "${SUDO[@]}" systemctl --no-pager --full status ran-agent-python.service ran-agent-hermes.service ran-agent-hermes-full.service ran-agent-xhs-public-sidecar.service ran-agent-node.service >&2 || true
  echo "--- recent Hermes logs ---" >&2
  "${SUDO[@]}" journalctl -u ran-agent-hermes.service -u ran-agent-hermes-full.service -u ran-agent-xhs-public-sidecar.service -n 120 --no-pager >&2 || true
  echo "--- listening sockets ---" >&2
  "${SUDO[@]}" ss -ltnp >&2 || true
}

pid_has_env() {
  local pid="$1"
  local expected="$2"
  if [ "$EUID" -eq 0 ]; then
    tr '\0' '\n' < "/proc/$pid/environ" | grep -qx "$expected"
  else
    sudo sh -c "tr '\0' '\n' < '/proc/$pid/environ'" | grep -qx "$expected"
  fi
}

port_is_listening() {
  local port="$1"
  ss -ltnH | awk '{ print $4 }' | grep -Eq "(:|\\])$port$"
}

wait_for_gateway_port() {
  local port="$1"
  local service="$2"
  local waited=0
  while [ "$waited" -le 90 ]; do
    if port_is_listening "$port"; then
      return 0
    fi
    if ! "${SUDO[@]}" systemctl is-active --quiet "$service"; then
      return 1
    fi
    sleep 3
    waited=$((waited + 3))
  done
  return 1
}

gateway_service_env_value() {
  local service="$1" name="$2" pid entry
  pid="$("${SUDO[@]}" systemctl show "$service" --property=MainPID --value 2>/dev/null)" || return 1
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  while IFS= read -r -d '' entry; do
    case "$entry" in
      "$name"=*) printf '%s' "${entry#*=}"; return 0 ;;
    esac
  done < <("${SUDO[@]}" cat "/proc/$pid/environ")
  return 1
}

run_gateway_provider_canary() {
  local mode="$1" port="$2" profile="$3" service="$4" node_bin api_key nonce pointer
  if [[ "${RAN_AGENT_TEST_MODE:-0}" == 1 && -n "${RAN_AGENT_PROVIDER_CANARY_TEST_COMMAND:-}" ]]; then
    "$RAN_AGENT_PROVIDER_CANARY_TEST_COMMAND" "$mode" "$port" "$profile" "$service"
    return
  fi
  node_bin="${RAN_AGENT_NODE_BIN:-/opt/nodejs/node-v22.22.2-linux-x64/bin/node}"
  api_key="$(gateway_service_env_value "$service" HERMES_API_KEY || gateway_service_env_value "$service" API_SERVER_KEY)" ||
    { echo "ERROR: $mode provider canary API key unavailable" >&2; return 1; }
  nonce="$("$node_bin" -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
  pointer="$RUNTIME_STATE_DIR/hermes/published-memory-context.json"
  env \
    HERMES_REPLY_MODE=api \
    HERMES_API_BASE_URL="http://127.0.0.1:$port/v1" \
    HERMES_LITE_API_BASE_URL="http://127.0.0.1:$port/v1" \
    HERMES_FULL_API_BASE_URL="http://127.0.0.1:$port/v1" \
    HERMES_API_KEY="$api_key" \
    HERMES_PROFILE="$profile" \
    HERMES_LITE_PROFILE="$profile" \
    HERMES_FULL_PROFILE="$profile" \
    RAN_AGENT_CAPABILITY_MODE="$mode" \
    RAN_AGENT_REPO_ROOT="$REPO_ROOT" \
    HERMES_PUBLISHED_MEMORY_CONTEXT_PATH="$pointer" \
    RAN_AGENT_PROVIDER_CANARY_MODE="$mode" \
    RAN_AGENT_PROVIDER_CANARY_NONCE="$nonce" \
    RAN_AGENT_CONTEXT_SIZE_LOG=0 \
    "$node_bin" "$REPO_ROOT/node_bridge/src/hermesProviderBoundaryCanary.mjs" >/dev/null
}

systemd_cat_contains() {
  local service="$1"
  local pattern="$2"
  local output
  output=$("${SUDO[@]}" systemctl cat "$service" 2>/dev/null) || return 1
  printf '%s\n' "$output" | grep -qF "$pattern"
}

config_has_toolset() {
  local file="$1"
  local toolset="$2"
  awk '
    /^mcp_servers:/ { in_toolsets=0 }
    /^platform_toolsets:/ { in_toolsets=1 }
    in_toolsets { print }
  ' "$file" | grep -q -- "$toolset"
}

verify_runtime() {
  local lite_pid
  local full_pid
  validate_runtime_ombre_configs
  verify_model_policy

  log "verifying compact systemd units"
  # Cache systemctl cat output once for all checks
  local lite_cat full_cat
  lite_cat=$("${SUDO[@]}" systemctl cat ran-agent-hermes.service 2>/dev/null) || lite_cat=""
  full_cat=$("${SUDO[@]}" systemctl cat ran-agent-hermes-full.service 2>/dev/null) || full_cat=""

  systemd_cat_contains_cached() {
    local cat_output="$1"
    local pattern="$2"
    printf '%s\n' "$cat_output" | grep -qF "$pattern"
  }

  if ! systemd_cat_contains_cached "$lite_cat" 'Environment=HERMES_HOME=/home/ubuntu/.hermes-ran-agent/lite'; then
    echo "ERROR: lite systemd unit is not compacted to lite HERMES_HOME" >&2
    echo "--- systemctl cat ran-agent-hermes.service (first 30 lines) ---" >&2
    printf '%s\n' "$lite_cat" | head -30 >&2
    exit 1
  fi
  if ! systemd_cat_contains_cached "$lite_cat" 'Environment=HERMES_PROFILE=ran-assistant-lite'; then
    echo "ERROR: lite systemd unit missing ran-assistant-lite profile" >&2
    exit 1
  fi
  if ! systemd_cat_contains_cached "$lite_cat" 'Environment=API_SERVER_PORT=8642'; then
    echo "ERROR: lite systemd unit missing API_SERVER_PORT=8642" >&2
    exit 1
  fi
  if ! systemd_cat_contains_cached "$lite_cat" 'Environment=API_SERVER_MODEL_NAME=ran-assistant-lite'; then
    echo "ERROR: lite systemd unit missing ran-assistant-lite model name" >&2
    exit 1
  fi
  if ! systemd_cat_contains_cached "$lite_cat" "Environment=HERMES_REPLY_TIMEOUT_SECONDS=$HERMES_REPLY_TIMEOUT_SECONDS_DEFAULT"; then
    echo "ERROR: lite systemd unit missing HERMES_REPLY_TIMEOUT_SECONDS=$HERMES_REPLY_TIMEOUT_SECONDS_DEFAULT" >&2
    exit 1
  fi
  if ! systemd_cat_contains_cached "$lite_cat" 'hermes -p ran-assistant-lite gateway run'; then
    echo "ERROR: lite systemd unit ExecStart is not ran-assistant-lite gateway" >&2
    exit 1
  fi
  if ! systemd_cat_contains_cached "$full_cat" 'Environment=HERMES_HOME=/home/ubuntu/.hermes-ran-agent'; then
    echo "ERROR: full systemd unit missing full HERMES_HOME" >&2
    exit 1
  fi
  if ! systemd_cat_contains_cached "$full_cat" 'Environment=HERMES_PROFILE=ran-assistant'; then
    echo "ERROR: full systemd unit missing ran-assistant profile" >&2
    exit 1
  fi
  if ! systemd_cat_contains_cached "$full_cat" 'Environment=API_SERVER_PORT=8643'; then
    echo "ERROR: full systemd unit missing API_SERVER_PORT=8643" >&2
    exit 1
  fi
  if ! systemd_cat_contains_cached "$full_cat" 'Environment=API_SERVER_MODEL_NAME=ran-assistant'; then
    echo "ERROR: full systemd unit missing ran-assistant model name" >&2
    exit 1
  fi
  if ! systemd_cat_contains_cached "$full_cat" "Environment=HERMES_REPLY_TIMEOUT_SECONDS=$HERMES_REPLY_TIMEOUT_SECONDS_DEFAULT"; then
    echo "ERROR: full systemd unit missing HERMES_REPLY_TIMEOUT_SECONDS=$HERMES_REPLY_TIMEOUT_SECONDS_DEFAULT" >&2
    exit 1
  fi
  if ! systemd_cat_contains_cached "$full_cat" 'hermes -p ran-assistant gateway run'; then
    echo "ERROR: full systemd unit ExecStart is not ran-assistant gateway" >&2
    exit 1
  fi
  for uv_env in 'UV_CACHE_DIR=/opt/ran_agent/.ran_agent_state/uv-cache' 'UV_TOOL_DIR=/opt/ran_agent/.ran_agent_state/uv-tools' 'UV_LINK_MODE=copy' 'UV_PYTHON_DOWNLOADS=never'; do
    if ! systemd_cat_contains_cached "$lite_cat" "$uv_env"; then
      echo "ERROR: lite systemd unit missing $uv_env" >&2
      exit 1
    fi
    if ! systemd_cat_contains_cached "$full_cat" "$uv_env"; then
      echo "ERROR: full systemd unit missing $uv_env" >&2
      exit 1
    fi
  done
  while IFS= read -r media_dir; do
    if ! "${SUDO[@]}" test -d "$media_dir"; then
      echo "ERROR: missing runtime trusted media directory: $media_dir" >&2
      exit 1
    fi
  done < <(trusted_runtime_media_dirs)
  for node_env in \
    "HERMES_CONTEXT_INJECTION_MODE=$HERMES_CONTEXT_INJECTION_MODE_DEFAULT" \
    "HERMES_CONTEXT_CACHE_STRATEGY=$HERMES_CONTEXT_CACHE_STRATEGY_DEFAULT" \
    "HERMES_RECENT_TEXT_TURNS=$HERMES_RECENT_TEXT_TURNS_DEFAULT" \
    "HERMES_RECENT_TEXT_CHAR_BUDGET=$HERMES_RECENT_TEXT_CHAR_BUDGET_DEFAULT" \
    "HERMES_GLOBAL_RECENT_TURNS=$HERMES_GLOBAL_RECENT_TURNS_DEFAULT" \
    "HERMES_GLOBAL_RECENT_CHAR_BUDGET=$HERMES_GLOBAL_RECENT_CHAR_BUDGET_DEFAULT" \
    "HERMES_ACTIVE_TOPIC_CHAR_BUDGET=$HERMES_ACTIVE_TOPIC_CHAR_BUDGET_DEFAULT" \
    "HERMES_CACHE_FRIENDLY_HISTORY=$HERMES_CACHE_FRIENDLY_HISTORY_DEFAULT" \
    "HERMES_CACHE_FRIENDLY_HISTORY_MAX_TURNS=$HERMES_CACHE_FRIENDLY_HISTORY_MAX_TURNS_DEFAULT" \
    "HERMES_CACHE_FRIENDLY_HISTORY_CHAR_BUDGET=$HERMES_CACHE_FRIENDLY_HISTORY_CHAR_BUDGET_DEFAULT" \
    "HERMES_CACHE_FRIENDLY_HISTORY_PROFILE=$HERMES_CACHE_FRIENDLY_HISTORY_PROFILE_DEFAULT" \
    "HERMES_CACHE_TELEMETRY_ENABLED=$HERMES_CACHE_TELEMETRY_ENABLED_DEFAULT" \
    "HERMES_LITE_SOFT_RESET_ENABLED=$HERMES_LITE_SOFT_RESET_ENABLED_DEFAULT" \
    "HERMES_LITE_SOFT_RESET_DRY_RUN=$HERMES_LITE_SOFT_RESET_DRY_RUN_DEFAULT" \
    "HERMES_ACTION_GATE_ENABLED=$HERMES_ACTION_GATE_ENABLED_DEFAULT" \
    "HERMES_ACTION_GATE_MODE=$HERMES_ACTION_GATE_MODE_DEFAULT" \
    "HERMES_ACTION_GATE_MAX_REPAIR_ATTEMPTS=$HERMES_ACTION_GATE_MAX_REPAIR_ATTEMPTS_DEFAULT" \
    "HERMES_ACTION_PENDING_ENABLED=$HERMES_ACTION_PENDING_ENABLED_DEFAULT" \
    "HERMES_ACTION_PENDING_TTL_MINUTES=$HERMES_ACTION_PENDING_TTL_MINUTES_DEFAULT" \
    "HERMES_REPLY_TIMEOUT_SECONDS=$HERMES_REPLY_TIMEOUT_SECONDS_DEFAULT" \
    "NODE_BRIDGE_QUICK_ACK_ENABLED=$NODE_BRIDGE_QUICK_ACK_ENABLED_DEFAULT" \
    "NODE_BRIDGE_QUICK_ACK_TIMEOUT_MS=$NODE_BRIDGE_QUICK_ACK_TIMEOUT_MS_DEFAULT" \
    "NODE_BRIDGE_QUICK_ACK_TEXT=$NODE_BRIDGE_QUICK_ACK_TEXT_DEFAULT" \
    "FEISHU_SEND_TIMEOUT_SECONDS=$FEISHU_SEND_TIMEOUT_SECONDS_DEFAULT" \
    "FEISHU_DOWNLOAD_TIMEOUT_SECONDS=$FEISHU_DOWNLOAD_TIMEOUT_SECONDS_DEFAULT" \
    "HERMES_PROACTIVE_EVENTS_ENABLED=$HERMES_PROACTIVE_EVENTS_ENABLED_DEFAULT" \
    "HERMES_PROACTIVE_EXTERNAL_MCP_ENABLED=$HERMES_PROACTIVE_EXTERNAL_MCP_ENABLED_DEFAULT" \
    "HERMES_PROACTIVE_REMINDERS_ENABLED=$HERMES_PROACTIVE_REMINDERS_ENABLED_DEFAULT" \
    "HERMES_PROACTIVE_NOTIFY_MAX_CHARS=$HERMES_PROACTIVE_NOTIFY_MAX_CHARS_DEFAULT" \
    "EXTERNAL_MCP_GATEWAY_ALLOW_ENV_ENABLE=$EXTERNAL_MCP_GATEWAY_ALLOW_ENV_ENABLE_DEFAULT" \
    "EXTERNAL_MCP_GATEWAY_ENABLED=$EXTERNAL_MCP_GATEWAY_ENABLED_DEFAULT" \
    "EXTERNAL_MCP_SYSTEM_QUEUE_ENABLED=$EXTERNAL_MCP_SYSTEM_QUEUE_ENABLED_DEFAULT" \
    "EXTERNAL_MCP_ACTIVITY_RUNNER_ENABLED=$EXTERNAL_MCP_ACTIVITY_RUNNER_ENABLED_DEFAULT" \
    "EXTERNAL_MCP_ACTIVITY_TICK_MS=$EXTERNAL_MCP_ACTIVITY_TICK_MS_DEFAULT" \
    "WEIXIN_SDK_INBOUND_MEDIA_DIRS=$WEIXIN_SDK_INBOUND_MEDIA_DIRS_DEFAULT" \
    "PERSONAL_AGENT_QWEN_TIMEOUT_SECONDS=$PERSONAL_AGENT_QWEN_TIMEOUT_SECONDS_DEFAULT" \
    "PERSONAL_AGENT_KNOWLEDGE_CRON_HOURS=$PERSONAL_AGENT_KNOWLEDGE_CRON_HOURS_DEFAULT" \
    "PERSONAL_AGENT_KNOWLEDGE_CRON_MINUTE=$PERSONAL_AGENT_KNOWLEDGE_CRON_MINUTE_DEFAULT" \
    "PERSONAL_AGENT_DAILY_CARRYOVER_ENABLED=$PERSONAL_AGENT_DAILY_CARRYOVER_ENABLED_DEFAULT" \
    "PERSONAL_AGENT_DAILY_CARRYOVER_HOUR=$PERSONAL_AGENT_DAILY_CARRYOVER_HOUR_DEFAULT" \
    "PERSONAL_AGENT_DAILY_CARRYOVER_MINUTE=$PERSONAL_AGENT_DAILY_CARRYOVER_MINUTE_DEFAULT" \
    "AI_DAILY_DIGEST_ENABLED=$AI_DAILY_DIGEST_ENABLED_DEFAULT" \
    "AI_DAILY_DIGEST_HOUR=$AI_DAILY_DIGEST_HOUR_DEFAULT" \
    "AI_DAILY_DIGEST_MINUTE=$AI_DAILY_DIGEST_MINUTE_DEFAULT"; do
    if ! "${SUDO[@]}" grep -q "^$node_env$" "$NODE_ENV_FILE"; then
      echo "ERROR: node env missing context optimization default $node_env" >&2
      exit 1
    fi
  done
  local stale_dropin
  for stale_dropin in "${STALE_LITE_DROPINS[@]}"; do
    if "${SUDO[@]}" test -e "$stale_dropin"; then
      echo "ERROR: stale Hermes runtime drop-in remains: $stale_dropin" >&2
      exit 1
    fi
  done

  log "verifying gateway processes and ports"
  sleep 2
  lite_pid="$(pgrep -u "$RUNTIME_USER" -f "hermes -p $LITE_PROFILE gateway run" | head -n 1 || true)"
  full_pid="$(pgrep -u "$RUNTIME_USER" -f "hermes -p $FULL_PROFILE gateway run" | head -n 1 || true)"

  if [ -z "$lite_pid" ] || [ -z "$full_pid" ]; then
    print_failure_context
    exit 1
  fi
  if ! pid_has_env "$lite_pid" "API_SERVER_PORT=$LITE_PORT"; then
    print_failure_context
    exit 1
  fi
  if ! pid_has_env "$full_pid" "API_SERVER_PORT=$FULL_PORT"; then
    print_failure_context
    exit 1
  fi
  wait_for_gateway_port "$LITE_PORT" ran-agent-hermes.service || true
  wait_for_gateway_port "$FULL_PORT" ran-agent-hermes-full.service || true
  if ! port_is_listening "$LITE_PORT" || ! port_is_listening "$FULL_PORT"; then
    print_failure_context
    exit 1
  fi

  log "verifying Search Hub source and runtime config"
  if ! grep -q '"search_hub"' "$REPO_ROOT/.mcp.json"; then
    echo "ERROR: .mcp.json does not register search_hub" >&2
    exit 1
  fi
  if ! grep -q '"sticker_catalog"' "$REPO_ROOT/.mcp.json"; then
    echo "ERROR: .mcp.json does not register sticker_catalog" >&2
    exit 1
  fi
  if ! grep -q '"ombre_memory"' "$REPO_ROOT/.mcp.json"; then
    echo "ERROR: .mcp.json does not register ombre_memory" >&2
    exit 1
  fi
  if ! grep -q 'mcp-search_hub' "$REPO_ROOT/hermes/profile/config.yaml"; then
    echo "ERROR: full source profile missing mcp-search_hub" >&2
    exit 1
  fi
  if ! grep -q 'mcp-ombre_memory' "$REPO_ROOT/hermes/profile/config.yaml"; then
    echo "ERROR: full source profile missing mcp-ombre_memory" >&2
    exit 1
  fi
  if ! grep -q 'mcp-sticker_catalog' "$REPO_ROOT/hermes/profile/config.yaml"; then
    echo "ERROR: full source profile missing mcp-sticker_catalog" >&2
    exit 1
  fi
  if ! grep -q 'mcp-search_hub' "$REPO_ROOT/hermes/profile/config.lite.yaml"; then
    echo "ERROR: lite source profile missing mcp-search_hub" >&2
    exit 1
  fi
  if ! grep -q 'mcp-sticker_catalog' "$REPO_ROOT/hermes/profile/config.lite.yaml"; then
    echo "ERROR: lite source profile missing mcp-sticker_catalog" >&2
    exit 1
  fi
  if ! grep -q 'mcp-ombre_memory' "$REPO_ROOT/hermes/profile/config.lite.yaml"; then
    echo "ERROR: lite source profile missing mcp-ombre_memory" >&2
    exit 1
  fi
  local legacy_ombre_name='ombre_memory_''extra'
  local legacy_ombre_path='/mcp''-extra'
  if grep -R -Eq "$legacy_ombre_name|$legacy_ombre_path" \
    "$REPO_ROOT/.mcp.json" \
    "$REPO_ROOT/hermes/profile/config.yaml" \
    "$REPO_ROOT/hermes/profile/config.lite.yaml" \
    "$REPO_ROOT/hermes/profile/mcp.template.yaml"; then
    echo "ERROR: legacy Ombre extra MCP surface remains in source config" >&2
    exit 1
  fi
  if ! grep -q '^  search_hub:' "$FULL_HOME/config.yaml"; then
    echo "ERROR: full runtime config missing search_hub MCP server" >&2
    exit 1
  fi
  if ! grep -q '^  search_hub:' "$LITE_HOME/config.yaml"; then
    echo "ERROR: lite runtime config missing search_hub MCP server" >&2
    exit 1
  fi
  if ! grep -q '^  sticker_catalog:' "$FULL_HOME/config.yaml"; then
    echo "ERROR: full runtime config missing sticker_catalog MCP server" >&2
    exit 1
  fi
  if ! grep -q '^  sticker_catalog:' "$LITE_HOME/config.yaml"; then
    echo "ERROR: lite runtime config missing sticker_catalog MCP server" >&2
    exit 1
  fi
  if ! config_has_toolset "$LITE_HOME/config.yaml" 'mcp-search_hub'; then
    echo "ERROR: lite runtime toolset missing mcp-search_hub" >&2
    exit 1
  fi
  if ! config_has_toolset "$LITE_HOME/config.yaml" 'mcp-sticker_catalog'; then
    echo "ERROR: lite runtime toolset missing mcp-sticker_catalog" >&2
    exit 1
  fi
  if config_has_toolset "$LITE_HOME/config.yaml" 'mcp-playwright'; then
    echo "ERROR: lite runtime toolset exposes mcp-playwright" >&2
    exit 1
  fi
  if config_has_toolset "$LITE_HOME/config.yaml" 'mcp-media_generation'; then
    echo "ERROR: lite runtime toolset exposes mcp-media_generation" >&2
    exit 1
  fi
  if ! config_has_toolset "$LITE_HOME/config.yaml" 'mcp-ombre_memory'; then
    echo "ERROR: lite runtime toolset missing mcp-ombre_memory" >&2
    exit 1
  fi
  if ! grep -q '^  ombre_memory:' "$LITE_HOME/config.yaml"; then
    echo "ERROR: lite runtime config missing ombre_memory MCP server" >&2
    exit 1
  fi
  if ! config_has_toolset "$FULL_HOME/config.yaml" 'mcp-search_hub'; then
    echo "ERROR: full runtime toolset missing mcp-search_hub" >&2
    exit 1
  fi
  if ! config_has_toolset "$FULL_HOME/config.yaml" 'mcp-sticker_catalog'; then
    echo "ERROR: full runtime toolset missing mcp-sticker_catalog" >&2
    exit 1
  fi
  if ! config_has_toolset "$FULL_HOME/config.yaml" 'mcp-playwright'; then
    echo "ERROR: full runtime toolset missing mcp-playwright" >&2
    exit 1
  fi
  if ! test -x "$REPO_ROOT/scripts/start_search_hub_mcp.sh"; then
    echo "ERROR: scripts/start_search_hub_mcp.sh missing or not executable" >&2
    exit 1
  fi
  if ! test -x "$REPO_ROOT/scripts/start_sticker_catalog_mcp.sh"; then
    echo "ERROR: scripts/start_sticker_catalog_mcp.sh missing or not executable" >&2
    exit 1
  fi
  if ! config_has_toolset "$FULL_HOME/config.yaml" 'mcp-ombre_memory'; then
    echo "ERROR: full runtime toolset missing mcp-ombre_memory" >&2
    exit 1
  fi
  if ! grep -q '^  ombre_memory:' "$FULL_HOME/config.yaml"; then
    echo "ERROR: full runtime config missing ombre_memory MCP server" >&2
    exit 1
  fi
  if grep -Eq "$legacy_ombre_name|$legacy_ombre_path" "$LITE_HOME/config.yaml" "$FULL_HOME/config.yaml"; then
    echo "ERROR: legacy Ombre extra MCP surface remains in runtime config" >&2
    exit 1
  fi
  wait_for_ombre_health

  log "verifying obsidian_memory MCP config"
  if [ "${OBSIDIAN_MEMORY_MCP_ENABLED:-false}" = "false" ]; then
    if config_has_toolset "$LITE_HOME/config.yaml" 'mcp-obsidian_memory'; then
      echo "ERROR: lite runtime toolset exposes mcp-obsidian_memory but OBSIDIAN_MEMORY_MCP_ENABLED=false" >&2
      exit 1
    fi
    if config_has_toolset "$FULL_HOME/config.yaml" 'mcp-obsidian_memory'; then
      echo "ERROR: full runtime toolset exposes mcp-obsidian_memory but OBSIDIAN_MEMORY_MCP_ENABLED=false" >&2
      exit 1
    fi
    if grep -q '^  obsidian_memory:' "$LITE_HOME/config.yaml"; then
      echo "ERROR: lite runtime config has mcp_servers.obsidian_memory but OBSIDIAN_MEMORY_MCP_ENABLED=false" >&2
      exit 1
    fi
    if grep -q '^  obsidian_memory:' "$FULL_HOME/config.yaml"; then
      echo "ERROR: full runtime config has mcp_servers.obsidian_memory but OBSIDIAN_MEMORY_MCP_ENABLED=false" >&2
      exit 1
    fi
  fi

  if systemd_unit_is_loaded ran-agent-xhs-browse.service; then
    echo "ERROR: account-backed ran-agent-xhs-browse.service is still loaded" >&2
    exit 1
  fi
  if "${SUDO[@]}" test -e /opt/ran_agent/.ran_agent_state/social_reader/xhs-browse-ready.json; then
    echo "ERROR: account-backed XHS browse marker still exists" >&2
    exit 1
  fi
  if "${SUDO[@]}" test -e /opt/ran_agent/.ran_agent_state/social_reader/xhs-note-token-cache.json; then
    echo "ERROR: legacy XHS token cache still exists" >&2
    exit 1
  fi
  for env_file in "$NODE_ENV_FILE" "$NODE_BRIDGE_ENV_FILE" "$FULL_HOME/.env" "$LITE_HOME/.env" "$FULL_HOME/profiles/$FULL_PROFILE/.env" "$LITE_HOME/profiles/$LITE_PROFILE/.env"; do
    if "${SUDO[@]}" test -f "$env_file" && "${SUDO[@]}" grep -Eq '^(XHS_COOKIE|XHS_MCP_|PERSONAL_AGENT_XHS_MCP_|XHS_BROWSE_|SOCIAL_READER_EXPOSE_XHS_BROWSE_TOOLS|XHS_NOTE_TOKEN_CACHE_)' "$env_file"; then
      echo "ERROR: account-backed XHS env key remains in $env_file" >&2
      exit 1
    fi
  done

  if bool_is_true "$XHS_PUBLIC_SIDECAR_ENABLED_DEFAULT" && xhs_public_sidecar_marker_ready; then
    if "${SUDO[@]}" systemctl is-active --quiet ran-agent-xhs-public-sidecar.service; then
      log "OK: XHS public sidecar service active"
    else
      log "WARNING: XHS public sidecar marker is ready, but ran-agent-xhs-public-sidecar.service is not active"
    fi
  else
    log "XHS public sidecar marker not ready; XHS remains public-only through wanyi/html fallbacks"
  fi

  log "OK: $LITE_PROFILE pid=$lite_pid port=$LITE_PORT"
  log "OK: $FULL_PROFILE pid=$full_pid port=$FULL_PORT"
}

main() {
  require_release_authority
  case "${1:-}" in
    '') ;;
    --preserve-runtime-shape) PRESERVE_RUNTIME_SHAPE=1 ;;
    *) echo "ERROR: invalid runtime split mode" >&2; exit 1 ;;
  esac

  # Candidate release mode changes code only.  Existing profile membership,
  # opaque MCP config, env files, and units stay owned by the operator.
  if [ "$PRESERVE_RUNTIME_SHAPE" = "1" ]; then
    require_command systemctl
    require_command curl
    resolve_runtime_identity
    validate_ombre_network_contract
    validate_ombre_compat_contract
    ensure_ombre_compat_state_dir
    install_o1_identity_and_recall_contract
    install_deepseek_provider_plugin
    select_installed_profile_models
    write_model_policy_env
    write_ombre_compat_env
    verify_o1_identity_and_recall_contract
    verify_model_policy
    refuse_masked_o1_units
    write_node_steward_identity_dropin
    write_ombre_brain_unit
    write_ombre_recall_unit
    restart_services
    verify_o1_identity_and_recall_contract
    verify_model_policy
    return 0
  fi

  # Drift repair installs profiles and generates units which directly invoke
  # Hermes.  Candidate release mode above only restarts existing units.
  require_command "$HERMES_BIN"
  require_command systemctl
  require_command journalctl
  require_command pgrep
  require_command ss
  require_command openssl
  require_command curl
  resolve_runtime_identity
  validate_ombre_network_contract
  validate_ombre_compat_contract
  refuse_masked_o1_units

  ensure_runtime_dirs
  ensure_ombre_compat_state_dir

  if [ "$PRESERVE_RUNTIME_SHAPE" != "1" ]; then
    backup_env_file full_home_env "$FULL_HOME/.env"
    backup_env_file full_profile_env "$FULL_HOME/profiles/$FULL_PROFILE/.env"
    backup_env_file lite_home_env "$LITE_HOME/.env"
    backup_env_file lite_profile_env "$LITE_HOME/profiles/$LITE_PROFILE/.env"
    backup_env_file node_env "$NODE_ENV_FILE"
    backup_env_file node_bridge_env "$NODE_BRIDGE_ENV_FILE"

    install_profiles
    install_deepseek_provider_plugin

    restore_env_file full_home_env "$FULL_HOME/.env"
    restore_env_file full_profile_env "$FULL_HOME/profiles/$FULL_PROFILE/.env"
    restore_env_file lite_home_env "$LITE_HOME/.env"
    restore_env_file lite_profile_env "$LITE_HOME/profiles/$LITE_PROFILE/.env"
    restore_env_file node_env "$NODE_ENV_FILE"
    restore_env_file node_bridge_env "$NODE_BRIDGE_ENV_FILE"

    write_lite_runtime_config
  fi
  write_runtime_env
  write_ombre_compat_env
  if [ "$PRESERVE_RUNTIME_SHAPE" != "1" ]; then
    prepare_ombre_runtime
    write_full_runtime_config
  fi
  write_systemd_units
  write_node_steward_identity_dropin
  if [ "$PRESERVE_RUNTIME_SHAPE" != "1" ]; then
    cleanup_account_backed_xhs_runtime
  fi

  # Prepare XHS generic fallback tool (non-blocking, before restart)
  if [ "$PRESERVE_RUNTIME_SHAPE" != "1" ] && [ "${SOCIAL_READER_GENERIC_FALLBACK_ENABLED:-true}" != "false" ]; then
    log "preparing XHS generic fallback tool"
    if timeout "$XHS_GENERIC_FALLBACK_PREPARE_TIMEOUT_SECONDS" bash "$REPO_ROOT/scripts/prepare-xhs-generic-fallback.sh" 2>&1; then
      log "XHS generic fallback prepared"
    else
      log "WARNING: XHS generic fallback preparation failed or timed out (non-blocking)"
    fi
  fi

  # Prepare public XHS sidecar (non-blocking; it never receives cookies).
  if [ "$PRESERVE_RUNTIME_SHAPE" != "1" ] && [ "$XHS_PUBLIC_SIDECAR_AUTO_PREPARE" != "false" ] && bool_is_true "$XHS_PUBLIC_SIDECAR_ENABLED_DEFAULT"; then
    log "preparing XHS public sidecar"
    if timeout "$XHS_PUBLIC_SIDECAR_PREPARE_TIMEOUT_SECONDS" bash "$REPO_ROOT/scripts/prepare-xhs-public-sidecar.sh" 2>&1; then
      log "XHS public sidecar prepared"
    else
      log "WARNING: XHS public sidecar preparation failed or timed out (non-blocking)"
    fi
  else
    log "XHS public sidecar auto-prepare disabled"
  fi

  restart_services
  if [ "$PRESERVE_RUNTIME_SHAPE" != "1" ]; then
    verify_runtime
  fi
  if [ "$PRESERVE_RUNTIME_SHAPE" != "1" ] && [ -x "$REPO_ROOT/scripts/diagnose-media-xhs.sh" ]; then
    bash "$REPO_ROOT/scripts/diagnose-media-xhs.sh" --smoke-generic --smoke-public-sidecar --smoke-social-tools
  fi
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
