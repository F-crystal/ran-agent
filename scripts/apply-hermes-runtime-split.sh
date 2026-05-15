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
LITE_DROPIN="$SYSTEMD_DIR/ran-agent-hermes.service.d/90-lite-runtime.conf"
FULL_SERVICE="$SYSTEMD_DIR/ran-agent-hermes-full.service"
API_HOST="${API_SERVER_HOST:-127.0.0.1}"
LITE_PORT="${HERMES_LITE_API_PORT:-8642}"
FULL_PORT="${HERMES_FULL_API_PORT:-8643}"
LITE_PROFILE="ran-assistant-lite"
FULL_PROFILE="ran-assistant"
MODEL_NAME="deepseek-v4-flash"
BACKUP_DIR="$(mktemp -d)"

if [ "$EUID" -eq 0 ]; then
  SUDO=()
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
  cat > "$tmp"
  "${SUDO[@]}" install -D -m "$mode" "$tmp" "$dest"
  rm -f "$tmp"
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
  local key_regex
  tmp="$(mktemp)"
  key_regex='^(HERMES_HOME|HERMES_PROFILE|API_SERVER_ENABLED|API_SERVER_HOST|API_SERVER_PORT|API_SERVER_MODEL_NAME|HERMES_API_BASE_URL|HERMES_LITE_API_BASE_URL|HERMES_FULL_API_BASE_URL|HERMES_LITE_PROFILE|HERMES_FULL_PROFILE|RAN_AGENT_CAPABILITY_MODE|HERMES_SESSION_CONTINUITY_ENABLED|HERMES_SESSION_ID_PREFIX|HERMES_SESSION_KEY_PREFIX|HERMES_RECENT_TEXT_TURNS|HERMES_RECENT_TEXT_CHAR_BUDGET|HERMES_RECENT_TEXT_MAX_USER_CHARS|HERMES_RECENT_TEXT_MAX_ASSISTANT_CHARS|HERMES_GLOBAL_RECENT_TURNS|HERMES_GLOBAL_RECENT_CHAR_BUDGET|HERMES_ACTIVE_TOPIC_CHAR_BUDGET|FEISHU_BRIDGE_ENABLED|FEISHU_LARK_CLI_BIN|DESKTOP_PROXY_ENABLED|DESKTOP_PROXY_HOST|DESKTOP_PROXY_PORT)='

  if "${SUDO[@]}" test -f "$file"; then
    "${SUDO[@]}" grep -Ev "$key_regex" "$file" > "$tmp" || true
  fi
  for assignment in "$@"; do
    printf '%s\n' "$assignment" >> "$tmp"
  done
  "${SUDO[@]}" install -D -m 600 "$tmp" "$file"
  chown_if_user_exists "$file"
  rm -f "$tmp"
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
    "HERMES_API_BASE_URL=http://$API_HOST:$FULL_PORT/v1"

  upsert_env_file "$FULL_HOME/profiles/$FULL_PROFILE/.env" \
    "HERMES_HOME=$FULL_HOME" \
    "HERMES_PROFILE=$FULL_PROFILE" \
    "API_SERVER_ENABLED=true" \
    "API_SERVER_HOST=$API_HOST" \
    "API_SERVER_PORT=$FULL_PORT" \
    "API_SERVER_MODEL_NAME=$FULL_PROFILE" \
    "HERMES_API_BASE_URL=http://$API_HOST:$FULL_PORT/v1"

  upsert_env_file "$LITE_HOME/.env" \
    "HERMES_HOME=$LITE_HOME" \
    "HERMES_PROFILE=$LITE_PROFILE" \
    "API_SERVER_ENABLED=true" \
    "API_SERVER_HOST=$API_HOST" \
    "API_SERVER_PORT=$LITE_PORT" \
    "API_SERVER_MODEL_NAME=$LITE_PROFILE" \
    "HERMES_API_BASE_URL=http://$API_HOST:$LITE_PORT/v1"

  upsert_env_file "$LITE_HOME/profiles/$LITE_PROFILE/.env" \
    "HERMES_HOME=$LITE_HOME" \
    "HERMES_PROFILE=$LITE_PROFILE" \
    "API_SERVER_ENABLED=true" \
    "API_SERVER_HOST=$API_HOST" \
    "API_SERVER_PORT=$LITE_PORT" \
    "API_SERVER_MODEL_NAME=$LITE_PROFILE" \
    "HERMES_API_BASE_URL=http://$API_HOST:$LITE_PORT/v1"

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
    "FEISHU_BRIDGE_ENABLED=false" \
    "FEISHU_LARK_CLI_BIN=lark-cli" \
    "DESKTOP_PROXY_ENABLED=false" \
    "DESKTOP_PROXY_HOST=127.0.0.1" \
    "DESKTOP_PROXY_PORT=8650"
}

write_lite_runtime_config() {
  log "refreshing lite runtime config"
  "${SUDO[@]}" install -D -m 644 "$REPO_ROOT/hermes/profile/config.lite.yaml" "$LITE_HOME/config.yaml"
  "${SUDO[@]}" install -D -m 644 "$REPO_ROOT/hermes/profile/config.lite.yaml" "$LITE_HOME/profiles/$LITE_PROFILE/config.yaml"
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
    - mcp-media_generation
    - mcp-personal_memory
    - mcp-obsidian_memory
    - mcp-playwright
    - mcp-tavily
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
    - mcp-media_generation
    - mcp-personal_memory
    - mcp-obsidian_memory
    - mcp-playwright
    - mcp-tavily

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

  "${SUDO[@]}" install -D -m 644 "$tmp" "$runtime_config"
  chown_if_user_exists "$runtime_config"
  rm -f "$tmp"
}

write_systemd_units() {
  log "refreshing systemd units"
  write_file 0644 "$LITE_DROPIN" <<EOF
[Service]
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
ExecStart=
ExecStart=/usr/bin/env bash -lc 'cd /opt/ran_agent && source /opt/ran_agent/.venv/bin/activate && exec hermes -p $LITE_PROFILE gateway run --replace --accept-hooks'
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
ExecStart=/usr/bin/env bash -lc 'cd /opt/ran_agent && source /opt/ran_agent/.venv/bin/activate && exec hermes -p $FULL_PROFILE gateway run --replace --accept-hooks'
Restart=always
RestartSec=5
TimeoutStopSec=240

[Install]
WantedBy=multi-user.target
EOF
}

restart_services() {
  log "reloading systemd and restarting services"
  "${SUDO[@]}" systemctl daemon-reload
  "${SUDO[@]}" systemctl reset-failed ran-agent-hermes.service ran-agent-hermes-full.service || true
  "${SUDO[@]}" systemctl restart ran-agent-hermes.service
  sleep 10
  "${SUDO[@]}" systemctl restart ran-agent-hermes-full.service
  sleep 10
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

verify_runtime() {
  local lite_pid
  local full_pid

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
  if ! port_is_listening "$LITE_PORT" || ! port_is_listening "$FULL_PORT"; then
    print_failure_context
    exit 1
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

  backup_env_file full_home_env "$FULL_HOME/.env"
  backup_env_file full_profile_env "$FULL_HOME/profiles/$FULL_PROFILE/.env"
  backup_env_file lite_home_env "$LITE_HOME/.env"
  backup_env_file lite_profile_env "$LITE_HOME/profiles/$LITE_PROFILE/.env"
  backup_env_file node_env "$NODE_ENV_FILE"

  install_profiles

  restore_env_file full_home_env "$FULL_HOME/.env"
  restore_env_file full_profile_env "$FULL_HOME/profiles/$FULL_PROFILE/.env"
  restore_env_file lite_home_env "$LITE_HOME/.env"
  restore_env_file lite_profile_env "$LITE_HOME/profiles/$LITE_PROFILE/.env"
  restore_env_file node_env "$NODE_ENV_FILE"

  write_lite_runtime_config
  write_full_runtime_config
  write_runtime_env
  write_systemd_units
  restart_services
  verify_runtime
}

main "$@"
