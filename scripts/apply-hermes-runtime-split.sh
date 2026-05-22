#!/bin/bash
# Apply the production Hermes lite/full runtime split.
# Idempotent: safe to re-run after git pull, profile install, or service restart.
# No secrets are written or printed; existing API keys/cookies/tokens are preserved.

set -euo pipefail

REPO_ROOT="${RAN_AGENT_REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
HERMES_BIN="${HERMES_BIN:-hermes}"
FULL_HOME="${HERMES_HOME:-/home/ubuntu/.hermes-ran-agent}"
LITE_HOME="${HERMES_LITE_HOME:-$FULL_HOME/lite}"
RUNTIME_USER="${RAN_AGENT_RUNTIME_USER:-ubuntu}"
RUNTIME_GROUP="${RAN_AGENT_RUNTIME_GROUP:-$RUNTIME_USER}"
NODE_ENV_FILE="${RAN_AGENT_NODE_ENV_FILE:-/opt/ran_agent/.env.local}"
NODE_BRIDGE_ENV_FILE="${RAN_AGENT_NODE_BRIDGE_ENV_FILE:-/opt/ran_agent/node_bridge/.env.local}"
HERMES_GLOBAL_ENV_FILE="${HERMES_GLOBAL_ENV_FILE:-/home/ubuntu/.hermes/.env}"
SYSTEMD_DIR="${SYSTEMD_DIR:-/etc/systemd/system}"
LITE_SERVICE="$SYSTEMD_DIR/ran-agent-hermes.service"
FULL_SERVICE="$SYSTEMD_DIR/ran-agent-hermes-full.service"
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
MODEL_NAME="deepseek-v4-flash"
BACKUP_DIR="$(mktemp -d)"
XHS_GENERIC_FALLBACK_PREPARE_TIMEOUT_SECONDS="${XHS_GENERIC_FALLBACK_PREPARE_TIMEOUT_SECONDS:-120}"

if [ "${RAN_AGENT_NO_SUDO:-}" = "1" ] || [ "$EUID" -eq 0 ]; then
  SUDO=(env)
else
  SUDO=(sudo)
fi

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

chown_if_user_exists() {
  local path="$1"
  if id "$RUNTIME_USER" >/dev/null 2>&1; then
    "${SUDO[@]}" chown -R "$RUNTIME_USER:$RUNTIME_GROUP" "$path"
  fi
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
    "${SUDO[@]}" install -D -m 600 "$BACKUP_DIR/$label" "$file"
    chown_if_user_exists "$file"
  fi
}

upsert_env_file() {
  local file="$1"
  shift
  local tmp
  tmp="$(mktemp)"

  if "${SUDO[@]}" test -f "$file"; then
    while IFS= read -r line; do
      local key="${line%%=*}"
      if [[ "$line" != *=* ]] || ! is_managed_env_key "$key"; then
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
    HERMES_HOME|HERMES_PROFILE|API_SERVER_ENABLED|API_SERVER_HOST|API_SERVER_PORT|API_SERVER_MODEL_NAME|HERMES_API_BASE_URL|HERMES_LITE_API_BASE_URL|HERMES_FULL_API_BASE_URL|HERMES_LITE_PROFILE|HERMES_FULL_PROFILE|RAN_AGENT_CAPABILITY_MODE|HERMES_SESSION_CONTINUITY_ENABLED|HERMES_SESSION_ID_PREFIX|HERMES_SESSION_KEY_PREFIX|HERMES_RECENT_TEXT_TURNS|HERMES_RECENT_TEXT_CHAR_BUDGET|HERMES_RECENT_TEXT_MAX_USER_CHARS|HERMES_RECENT_TEXT_MAX_ASSISTANT_CHARS|HERMES_GLOBAL_RECENT_TURNS|HERMES_GLOBAL_RECENT_CHAR_BUDGET|HERMES_ACTIVE_TOPIC_CHAR_BUDGET|RAN_AGENT_TIMELINE_MAX_BYTES|RAN_AGENT_TIMELINE_MAX_TURNS|RAN_AGENT_TIMELINE_RETENTION_DAYS|RAN_AGENT_TIMELINE_COMPACT_ENABLED|RAN_AGENT_TIMELINE_ARCHIVE_DIR|PERSONAL_AGENT_PROACTIVE_ENABLED|PERSONAL_AGENT_REMINDER_DELIVERY_ENABLED|FEISHU_LARK_CLI_BIN|FEISHU_LARK_CLI_IDENTITY|DESKTOP_PROXY_HOST|DESKTOP_PROXY_PORT|SEARCH_HUB_ENABLED|SEARCH_HUB_PROFILE_MODE|SEARCH_HUB_DEFAULT_LIMIT|SEARCH_HUB_TIMEOUT_MS|SEARCH_HUB_CACHE_TTL_MS|SEARCH_HUB_CACHE_PATH|SEARCH_HUB_ENABLE_TAVILY|SEARCH_HUB_ENABLE_AIHOT|SEARCH_HUB_ENABLE_OPENCLI|SEARCH_HUB_ENABLE_OPENCLI_BROWSER|SEARCH_HUB_ENABLE_PLAYWRIGHT_FALLBACK|SEARCH_HUB_OPENCLI_BIN|SEARCH_HUB_OPENCLI_TIMEOUT_MS|SEARCH_HUB_PUBLIC_ONLY_DEFAULT|UV_CACHE_DIR|UV_TOOL_DIR|UV_LINK_MODE|UV_PYTHON_DOWNLOADS|SOCIAL_READER_GENERIC_FALLBACK_ENABLED|SOCIAL_READER_XHS_BACKEND_TIMEOUT_MS|XHS_BACKEND_MCP_TIMEOUT_MS|OBSIDIAN_MEMORY_MCP_ENABLED|XHS_GENERIC_FALLBACK_READY_PATH)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

install_profiles() {
  log "installing Hermes profiles"
  mkdir -p "$FULL_HOME" "$LITE_HOME"
  chown_if_user_exists "$FULL_HOME"

  HERMES_HOME="$FULL_HOME" "$HERMES_BIN" profile install "$REPO_ROOT/hermes/profile" --name "$FULL_PROFILE" --force -y
  HERMES_HOME="$LITE_HOME" "$HERMES_BIN" profile install "$REPO_ROOT/hermes/profile" --name "$LITE_PROFILE" --force -y
}

write_runtime_env() {
  log "refreshing runtime env files without touching secrets"
  upsert_env_file "$FULL_HOME/.env" \
    "HERMES_HOME=$FULL_HOME" \
    "HERMES_PROFILE=$FULL_PROFILE" \
    "API_SERVER_ENABLED=true" \
    "API_SERVER_HOST=$API_HOST" \
    "API_SERVER_PORT=$FULL_PORT" \
    "API_SERVER_MODEL_NAME=$FULL_PROFILE" \
    "HERMES_API_BASE_URL=http://$API_HOST:$FULL_PORT/v1" \
    "PERSONAL_AGENT_PROACTIVE_ENABLED=false" \
    "PERSONAL_AGENT_REMINDER_DELIVERY_ENABLED=false" \
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
    "XHS_BACKEND_MCP_TIMEOUT_MS=90000" \
    "OBSIDIAN_MEMORY_MCP_ENABLED=false" \
    "XHS_GENERIC_FALLBACK_READY_PATH=/opt/ran_agent/.ran_agent_state/social_reader/generic-fallback-ready.json" \
    "?OPENALEX_MAILTO="

  upsert_env_file "$FULL_HOME/profiles/$FULL_PROFILE/.env" \
    "HERMES_HOME=$FULL_HOME" \
    "HERMES_PROFILE=$FULL_PROFILE" \
    "API_SERVER_ENABLED=true" \
    "API_SERVER_HOST=$API_HOST" \
    "API_SERVER_PORT=$FULL_PORT" \
    "API_SERVER_MODEL_NAME=$FULL_PROFILE" \
    "HERMES_API_BASE_URL=http://$API_HOST:$FULL_PORT/v1" \
    "PERSONAL_AGENT_PROACTIVE_ENABLED=false" \
    "PERSONAL_AGENT_REMINDER_DELIVERY_ENABLED=false" \
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
    "XHS_BACKEND_MCP_TIMEOUT_MS=90000" \
    "OBSIDIAN_MEMORY_MCP_ENABLED=false" \
    "XHS_GENERIC_FALLBACK_READY_PATH=/opt/ran_agent/.ran_agent_state/social_reader/generic-fallback-ready.json" \
    "?OPENALEX_MAILTO="

  upsert_env_file "$LITE_HOME/.env" \
    "HERMES_HOME=$LITE_HOME" \
    "HERMES_PROFILE=$LITE_PROFILE" \
    "API_SERVER_ENABLED=true" \
    "API_SERVER_HOST=$API_HOST" \
    "API_SERVER_PORT=$LITE_PORT" \
    "API_SERVER_MODEL_NAME=$LITE_PROFILE" \
    "HERMES_API_BASE_URL=http://$API_HOST:$LITE_PORT/v1" \
    "PERSONAL_AGENT_PROACTIVE_ENABLED=false" \
    "PERSONAL_AGENT_REMINDER_DELIVERY_ENABLED=false" \
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
    "XHS_BACKEND_MCP_TIMEOUT_MS=90000" \
    "OBSIDIAN_MEMORY_MCP_ENABLED=false" \
    "XHS_GENERIC_FALLBACK_READY_PATH=/opt/ran_agent/.ran_agent_state/social_reader/generic-fallback-ready.json" \
    "?OPENALEX_MAILTO="

  upsert_env_file "$LITE_HOME/profiles/$LITE_PROFILE/.env" \
    "HERMES_HOME=$LITE_HOME" \
    "HERMES_PROFILE=$LITE_PROFILE" \
    "API_SERVER_ENABLED=true" \
    "API_SERVER_HOST=$API_HOST" \
    "API_SERVER_PORT=$LITE_PORT" \
    "API_SERVER_MODEL_NAME=$LITE_PROFILE" \
    "HERMES_API_BASE_URL=http://$API_HOST:$LITE_PORT/v1" \
    "PERSONAL_AGENT_PROACTIVE_ENABLED=false" \
    "PERSONAL_AGENT_REMINDER_DELIVERY_ENABLED=false" \
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
    "XHS_BACKEND_MCP_TIMEOUT_MS=90000" \
    "OBSIDIAN_MEMORY_MCP_ENABLED=false" \
    "XHS_GENERIC_FALLBACK_READY_PATH=/opt/ran_agent/.ran_agent_state/social_reader/generic-fallback-ready.json" \
    "?OPENALEX_MAILTO="

  upsert_env_file "$NODE_ENV_FILE" \
    "HERMES_API_BASE_URL=http://$API_HOST:$LITE_PORT/v1" \
    "HERMES_LITE_API_BASE_URL=http://$API_HOST:$LITE_PORT/v1" \
    "HERMES_FULL_API_BASE_URL=http://$API_HOST:$FULL_PORT/v1" \
    "RAN_AGENT_CAPABILITY_MODE=auto" \
    "HERMES_LITE_PROFILE=$LITE_PROFILE" \
    "HERMES_FULL_PROFILE=$FULL_PROFILE" \
    "HERMES_SESSION_CONTINUITY_ENABLED=true" \
    "HERMES_SESSION_ID_PREFIX=ran-agent" \
    "HERMES_SESSION_KEY_PREFIX=ran-agent-memory" \
    "HERMES_RECENT_TEXT_TURNS=10" \
    "HERMES_RECENT_TEXT_CHAR_BUDGET=6000" \
    "HERMES_RECENT_TEXT_MAX_USER_CHARS=1200" \
    "HERMES_RECENT_TEXT_MAX_ASSISTANT_CHARS=1200" \
    "HERMES_GLOBAL_RECENT_TURNS=6" \
    "HERMES_GLOBAL_RECENT_CHAR_BUDGET=2500" \
    "HERMES_ACTIVE_TOPIC_CHAR_BUDGET=1200" \
    "RAN_AGENT_TIMELINE_MAX_BYTES=52428800" \
    "RAN_AGENT_TIMELINE_MAX_TURNS=5000" \
    "RAN_AGENT_TIMELINE_RETENTION_DAYS=30" \
    "RAN_AGENT_TIMELINE_COMPACT_ENABLED=true" \
    "RAN_AGENT_TIMELINE_ARCHIVE_DIR=/opt/ran_agent/.ran_agent_state/timeline_archive" \
    "PERSONAL_AGENT_PROACTIVE_ENABLED=false" \
    "PERSONAL_AGENT_REMINDER_DELIVERY_ENABLED=false" \
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
    "XHS_BACKEND_MCP_TIMEOUT_MS=90000" \
    "OBSIDIAN_MEMORY_MCP_ENABLED=false" \
    "XHS_GENERIC_FALLBACK_READY_PATH=/opt/ran_agent/.ran_agent_state/social_reader/generic-fallback-ready.json"

  upsert_env_file "$NODE_BRIDGE_ENV_FILE" \
    "SOCIAL_READER_GENERIC_FALLBACK_ENABLED=true" \
    "SOCIAL_READER_XHS_BACKEND_TIMEOUT_MS=90000" \
    "XHS_BACKEND_MCP_TIMEOUT_MS=90000" \
    "XHS_GENERIC_FALLBACK_READY_PATH=/opt/ran_agent/.ran_agent_state/social_reader/generic-fallback-ready.json"
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
  "${SUDO[@]}" install -D -m 644 "$REPO_ROOT/hermes/profile/config.lite.yaml" "$LITE_HOME/config.yaml"
  "${SUDO[@]}" install -D -m 644 "$REPO_ROOT/hermes/profile/config.lite.yaml" "$LITE_HOME/profiles/$LITE_PROFILE/config.yaml"
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
  cat > "$tmp" <<EOF
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
    - mcp-mimo_power
    - mcp-search_hub
    - mcp-media_generation
    - mcp-personal_memory
    - mcp-obsidian_memory
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
    - mcp-mimo_power
    - mcp-search_hub
    - mcp-media_generation
    - mcp-personal_memory
    - mcp-obsidian_memory
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

  "${SUDO[@]}" install -D -m 644 "$tmp" "$runtime_config"
  chown_if_user_exists "$runtime_config"
  rm -f "$tmp"
}

write_systemd_units() {
  log "refreshing systemd units"
  write_file 0644 "$LITE_SERVICE" <<EOF
[Unit]
Description=Ran Agent Hermes Lite Gateway (port $LITE_PORT)
After=network-online.target ran-agent-python.service
Wants=network-online.target

[Service]
Type=simple
User=$RUNTIME_USER
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
Environment=HERMES_REPLY_TIMEOUT_SECONDS=180
Environment=HERMES_RESTART_DRAIN_TIMEOUT=60
Environment=PYTHON_BACKEND_BASE_URL=http://127.0.0.1:8787
Environment=PYTHON_BACKEND_INGEST_TIMEOUT_MS=5000
Environment=PERSONAL_MEMORY_BACKEND_TIMEOUT_MS=5000
Environment=PERSONAL_AGENT_PROACTIVE_ENABLED=false
Environment=PERSONAL_AGENT_REMINDER_DELIVERY_ENABLED=false
Environment=UV_CACHE_DIR=/opt/ran_agent/.ran_agent_state/uv-cache
Environment=UV_TOOL_DIR=/opt/ran_agent/.ran_agent_state/uv-tools
Environment=UV_LINK_MODE=copy
Environment=UV_PYTHON_DOWNLOADS=never
Environment=SOCIAL_READER_GENERIC_FALLBACK_ENABLED=true
Environment=SOCIAL_READER_XHS_BACKEND_TIMEOUT_MS=90000
Environment=XHS_BACKEND_MCP_TIMEOUT_MS=90000
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
After=network-online.target ran-agent-python.service
Wants=network-online.target

[Service]
Type=simple
User=$RUNTIME_USER
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
Environment=HERMES_REPLY_TIMEOUT_SECONDS=240
Environment=HERMES_RESTART_DRAIN_TIMEOUT=60
Environment=PYTHON_BACKEND_BASE_URL=http://127.0.0.1:8787
Environment=PYTHON_BACKEND_INGEST_TIMEOUT_MS=5000
Environment=PERSONAL_MEMORY_BACKEND_TIMEOUT_MS=5000
Environment=PERSONAL_AGENT_PROACTIVE_ENABLED=false
Environment=PERSONAL_AGENT_REMINDER_DELIVERY_ENABLED=false
Environment=UV_CACHE_DIR=/opt/ran_agent/.ran_agent_state/uv-cache
Environment=UV_TOOL_DIR=/opt/ran_agent/.ran_agent_state/uv-tools
Environment=UV_LINK_MODE=copy
Environment=UV_PYTHON_DOWNLOADS=never
Environment=SOCIAL_READER_GENERIC_FALLBACK_ENABLED=true
Environment=SOCIAL_READER_XHS_BACKEND_TIMEOUT_MS=90000
Environment=XHS_BACKEND_MCP_TIMEOUT_MS=90000
Environment=OBSIDIAN_MEMORY_MCP_ENABLED=false
ExecStart=/usr/bin/env bash -lc 'cd /opt/ran_agent && source /opt/ran_agent/.venv/bin/activate && exec hermes -p $FULL_PROFILE gateway run --replace --accept-hooks'
Restart=always
RestartSec=5
TimeoutStopSec=240

[Install]
WantedBy=multi-user.target
EOF

  cleanup_stale_lite_dropins
}

cleanup_stale_lite_dropins() {
  local dropin
  for dropin in "${STALE_LITE_DROPINS[@]}"; do
    "${SUDO[@]}" rm -f "$dropin"
  done
}

restart_services() {
  log "reloading systemd and restarting services"
  "${SUDO[@]}" systemctl daemon-reload
  sleep 1
  "${SUDO[@]}" systemctl reset-failed ran-agent-hermes.service ran-agent-hermes-full.service || true
  "${SUDO[@]}" systemctl restart ran-agent-hermes.service
  wait_for_gateway_port "$LITE_PORT" ran-agent-hermes.service || true
  "${SUDO[@]}" systemctl restart ran-agent-hermes-full.service
  wait_for_gateway_port "$FULL_PORT" ran-agent-hermes-full.service || true
  "${SUDO[@]}" systemctl restart ran-agent-node.service
}

print_failure_context() {
  echo ""
  echo "ERROR: Hermes runtime split verification failed." >&2
  echo "--- effective systemd units (systemctl cat) ---" >&2
  "${SUDO[@]}" systemctl cat ran-agent-hermes.service ran-agent-hermes-full.service >&2 || true
  echo "--- service status ---" >&2
  "${SUDO[@]}" systemctl --no-pager --full status ran-agent-hermes.service ran-agent-hermes-full.service ran-agent-node.service >&2 || true
  echo "--- recent Hermes logs ---" >&2
  "${SUDO[@]}" journalctl -u ran-agent-hermes.service -u ran-agent-hermes-full.service -n 120 --no-pager >&2 || true
  echo "--- listening sockets ---" >&2
  ss -ltnp >&2 || true
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
  if ! grep -q 'mcp-search_hub' "$REPO_ROOT/hermes/profile/config.yaml"; then
    echo "ERROR: full source profile missing mcp-search_hub" >&2
    exit 1
  fi
  if ! grep -q 'mcp-search_hub' "$REPO_ROOT/hermes/profile/config.lite.yaml"; then
    echo "ERROR: lite source profile missing mcp-search_hub" >&2
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
  if ! config_has_toolset "$LITE_HOME/config.yaml" 'mcp-search_hub'; then
    echo "ERROR: lite runtime toolset missing mcp-search_hub" >&2
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
  if ! config_has_toolset "$FULL_HOME/config.yaml" 'mcp-search_hub'; then
    echo "ERROR: full runtime toolset missing mcp-search_hub" >&2
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

  log "OK: $LITE_PROFILE pid=$lite_pid port=$LITE_PORT"
  log "OK: $FULL_PROFILE pid=$full_pid port=$FULL_PORT"
}

main() {
  require_command "$HERMES_BIN"
  require_command systemctl
  require_command journalctl
  require_command pgrep
  require_command ss

  # Ensure UV cache and tool directories exist
  mkdir -p /opt/ran_agent/.ran_agent_state/uv-cache /opt/ran_agent/.ran_agent_state/uv-tools
  chown_if_user_exists /opt/ran_agent/.ran_agent_state/uv-cache
  chown_if_user_exists /opt/ran_agent/.ran_agent_state/uv-tools

  backup_env_file full_home_env "$FULL_HOME/.env"
  backup_env_file full_profile_env "$FULL_HOME/profiles/$FULL_PROFILE/.env"
  backup_env_file lite_home_env "$LITE_HOME/.env"
  backup_env_file lite_profile_env "$LITE_HOME/profiles/$LITE_PROFILE/.env"
  backup_env_file node_env "$NODE_ENV_FILE"
  backup_env_file node_bridge_env "$NODE_BRIDGE_ENV_FILE"

  install_profiles

  restore_env_file full_home_env "$FULL_HOME/.env"
  restore_env_file full_profile_env "$FULL_HOME/profiles/$FULL_PROFILE/.env"
  restore_env_file lite_home_env "$LITE_HOME/.env"
  restore_env_file lite_profile_env "$LITE_HOME/profiles/$LITE_PROFILE/.env"
  restore_env_file node_env "$NODE_ENV_FILE"
  restore_env_file node_bridge_env "$NODE_BRIDGE_ENV_FILE"

  write_lite_runtime_config
  write_full_runtime_config
  write_runtime_env
  write_systemd_units

  # Prepare XHS generic fallback tool (non-blocking, before restart)
  if [ "${SOCIAL_READER_GENERIC_FALLBACK_ENABLED:-true}" != "false" ]; then
    log "preparing XHS generic fallback tool"
    if timeout "$XHS_GENERIC_FALLBACK_PREPARE_TIMEOUT_SECONDS" bash "$REPO_ROOT/scripts/prepare-xhs-generic-fallback.sh" 2>&1; then
      log "XHS generic fallback prepared"
    else
      log "WARNING: XHS generic fallback preparation failed or timed out (non-blocking)"
    fi
  fi

  restart_services
  verify_runtime
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
