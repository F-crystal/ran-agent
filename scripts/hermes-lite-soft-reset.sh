#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

load_env_file() {
  local file="$1"
  [ -f "$file" ] || return 0
  set -a
  # shellcheck source=/dev/null
  . "$file"
  set +a
}

if [[ -z "${RAN_AGENT_INTERNAL_CONTROL_SECRET:-}" && -z "${RAN_AGENT_SKIP_ENV_FILE_LOAD:-}" ]]; then
  load_env_file "${RAN_AGENT_NODE_ENV_FILE:-$REPO_ROOT/.env.local}"
  load_env_file "${RAN_AGENT_NODE_BRIDGE_ENV_FILE:-$REPO_ROOT/node_bridge/.env.local}"
fi

case "${1:---status}" in
  --status) action="status" ;;
  --apply) action="apply" ;;
  --dry-run) action="dry-run" ;;
  --rollback-last) action="rollback-last" ;;
  --help|-h)
    echo 'Usage: bash scripts/hermes-lite-soft-reset.sh --dry-run|--apply|--status|--rollback-last'
    exit 0
    ;;
  *)
    echo '{"ok":false,"error":"unknown_action"}' >&2
    exit 2
    ;;
esac

if [[ -z "${RAN_AGENT_INTERNAL_CONTROL_SECRET:-}" ]]; then
  echo '{"ok":false,"error":"control_secret_unavailable"}' >&2
  exit 78
fi

CURL_EXE="${CURL_BIN:-$(command -v curl || true)}"
if [[ -z "$CURL_EXE" ]]; then
  echo '{"ok":false,"error":"curl_not_found"}' >&2
  exit 127
fi

host="${NODE_BRIDGE_OUTBOUND_HOST:-127.0.0.1}"
if [[ "$host" =~ ^127\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]]; then
  request_host="$host"
elif [[ "$host" == "::1" || "$host" == "[::1]" ]]; then
  request_host='[::1]'
else
  echo '{"ok":false,"error":"loopback_host_required"}' >&2
  exit 78
fi
port="${NODE_BRIDGE_OUTBOUND_PORT:-8791}"
if [[ ! "$port" =~ ^[0-9]+$ ]] || (( port < 1 || port > 65535 )); then
  echo '{"ok":false,"error":"invalid_control_port"}' >&2
  exit 78
fi
endpoint="http://$request_host:$port/control/hermes-lite-soft-reset"

request_control() {
  "$CURL_EXE" --silent --show-error --fail-with-body \
    --request POST \
    --header "Authorization: Bearer $RAN_AGENT_INTERNAL_CONTROL_SECRET" \
    --header 'Content-Type: application/json' \
    --data "$1" \
    "$endpoint"
}

if [[ "$action" == "apply" || "$action" == "rollback-last" ]]; then
  status_json="$(request_control '{"action":"status"}')"
  revision="$(printf '%s' "$status_json" | sed -n 's/.*"revision":\([0-9][0-9]*\).*/\1/p')"
  if [[ -z "$revision" ]]; then
    echo '{"ok":false,"error":"control_status_missing_revision"}' >&2
    exit 1
  fi
  request_control "{\"action\":\"$action\",\"expectedRevision\":$revision}"
  exit $?
fi

request_control "{\"action\":\"$action\"}"
