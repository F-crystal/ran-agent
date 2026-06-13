#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${RAN_AGENT_REPO_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
SYSTEMD_DIR="${SYSTEMD_DIR:-/etc/systemd/system}"
NODE_ENV_FILE="${RAN_AGENT_NODE_ENV_FILE:-/opt/ran_agent/.env.local}"
NODE_BRIDGE_ENV_FILE="${RAN_AGENT_NODE_BRIDGE_ENV_FILE:-/opt/ran_agent/node_bridge/.env.local}"
RUNTIME_USER="${RAN_AGENT_RUNTIME_USER:-ubuntu}"
RUNTIME_GROUP="${RAN_AGENT_RUNTIME_GROUP:-$RUNTIME_USER}"
SERVICE_NAME="ran-agent-hermes-lite-soft-reset.service"
TIMER_NAME="ran-agent-hermes-lite-soft-reset.timer"
ON_CALENDAR="${HERMES_LITE_SOFT_RESET_ON_CALENDAR:-05:00:00}"
ACTION="install"

if [ "${RAN_AGENT_NO_SUDO:-}" = "1" ] || [ "$EUID" -eq 0 ]; then
  SUDO=(env)
else
  SUDO=(sudo)
fi

usage() {
  cat <<'EOF'
Usage:
  bash scripts/install-hermes-lite-soft-reset-timer.sh [--install] [--time HH:MM]
  bash scripts/install-hermes-lite-soft-reset-timer.sh --status
  bash scripts/install-hermes-lite-soft-reset-timer.sh --disable

Installs a daily systemd timer for Hermes lite soft reset. Default time is 05:00.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --install)
      ACTION="install"
      ;;
    --status)
      ACTION="status"
      ;;
    --disable)
      ACTION="disable"
      ;;
    --time)
      shift
      ON_CALENDAR="${1:-}"
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

normalize_time() {
  local value="$1"
  if [[ "$value" =~ ^[0-2][0-9]:[0-5][0-9]$ ]]; then
    printf '%s:00\n' "$value"
    return 0
  fi
  if [[ "$value" =~ ^[0-2][0-9]:[0-5][0-9]:[0-5][0-9]$ ]]; then
    printf '%s\n' "$value"
    return 0
  fi
  echo "ERROR: --time must be HH:MM or HH:MM:SS, got: $value" >&2
  exit 2
}

log() {
  printf '[hermes-lite-soft-reset-timer] %s\n' "$*"
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

write_file() {
  local mode="$1"
  local dest="$2"
  local tmp
  tmp="$(mktemp)"
  cat >| "$tmp"
  install_file_portable "$mode" "$tmp" "$dest"
  rm -f "$tmp"
}

chown_if_user_exists() {
  local path="$1"
  if id "$RUNTIME_USER" >/dev/null 2>&1; then
    "${SUDO[@]}" chown "$RUNTIME_USER:$RUNTIME_GROUP" "$path"
  fi
}

upsert_soft_reset_env() {
  local file="$1"
  local tmp
  tmp="$(mktemp)"
  if "${SUDO[@]}" test -f "$file"; then
    "${SUDO[@]}" awk -F= '
      $0 !~ /=/ { print; next }
      $1 != "HERMES_LITE_SOFT_RESET_ENABLED" && $1 != "HERMES_LITE_SOFT_RESET_DRY_RUN" { print }
    ' "$file" >> "$tmp"
  fi
  printf '%s\n' \
    'HERMES_LITE_SOFT_RESET_ENABLED=true' \
    'HERMES_LITE_SOFT_RESET_DRY_RUN=false' >> "$tmp"
  install_file_portable 600 "$tmp" "$file"
  chown_if_user_exists "$file"
  rm -f "$tmp"
}

systemctl_if_available() {
  if command -v systemctl >/dev/null 2>&1 && [ "${RAN_AGENT_NO_SYSTEMCTL:-}" != "1" ]; then
    "${SUDO[@]}" systemctl "$@"
  fi
}

install_timer() {
  local normalized_time
  normalized_time="$(normalize_time "$ON_CALENDAR")"
  log "enabling Hermes lite soft reset env"
  upsert_soft_reset_env "$NODE_ENV_FILE"
  upsert_soft_reset_env "$NODE_BRIDGE_ENV_FILE"

  log "writing systemd service and timer at $normalized_time"
  write_file 0644 "$SYSTEMD_DIR/$SERVICE_NAME" <<EOF
[Unit]
Description=Ran Agent Hermes Lite Soft Reset
After=ran-agent-node.service

[Service]
Type=oneshot
User=$RUNTIME_USER
Group=$RUNTIME_GROUP
WorkingDirectory=/opt/ran_agent
EnvironmentFile=-$NODE_ENV_FILE
Environment=HERMES_LITE_SOFT_RESET_ENABLED=true
Environment=HERMES_LITE_SOFT_RESET_DRY_RUN=false
ExecStart=/bin/bash /opt/ran_agent/scripts/hermes-lite-soft-reset.sh --apply
EOF

  write_file 0644 "$SYSTEMD_DIR/$TIMER_NAME" <<EOF
[Unit]
Description=Run Hermes Lite Soft Reset daily after night-cycle settlement

[Timer]
OnCalendar=*-*-* $normalized_time
Persistent=true
RandomizedDelaySec=0
Unit=$SERVICE_NAME

[Install]
WantedBy=timers.target
EOF

  systemctl_if_available daemon-reload
  systemctl_if_available enable --now "$TIMER_NAME"
  log "installed timer=$TIMER_NAME on_calendar=$normalized_time"
}

show_status() {
  log "env files"
  for file in "$NODE_ENV_FILE" "$NODE_BRIDGE_ENV_FILE"; do
    if "${SUDO[@]}" test -f "$file"; then
      printf '%s\n' "$file"
      "${SUDO[@]}" grep -E 'HERMES_LITE_SOFT_RESET_ENABLED|HERMES_LITE_SOFT_RESET_DRY_RUN' "$file" || true
    else
      printf '%s missing\n' "$file"
    fi
  done
  if command -v systemctl >/dev/null 2>&1 && [ "${RAN_AGENT_NO_SYSTEMCTL:-}" != "1" ]; then
    "${SUDO[@]}" systemctl list-timers "$TIMER_NAME" --no-pager || true
    "${SUDO[@]}" systemctl status "$TIMER_NAME" --no-pager || true
  else
    log "systemctl unavailable or disabled"
  fi
}

disable_timer() {
  systemctl_if_available disable --now "$TIMER_NAME"
  log "disabled timer=$TIMER_NAME"
}

case "$ACTION" in
  install)
    install_timer
    ;;
  status)
    show_status
    ;;
  disable)
    disable_timer
    ;;
esac
