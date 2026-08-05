#!/usr/bin/env bash
# Diagnose the internal Ombre runtime and Lite/Full recall-only wiring.

set -euo pipefail

ROOT_DIR="${RAN_AGENT_REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
CALLER_STATE_DIR="${RAN_AGENT_STATE_DIR:-}"
CALLER_OMBRE_BRAIN_HOME="${OMBRE_BRAIN_HOME:-}"
HERMES_HOME="${HERMES_HOME:-/home/ubuntu/.hermes-ran-agent}"
LITE_HOME="${HERMES_LITE_HOME:-$HERMES_HOME/lite}"
FULL_HOME="$HERMES_HOME"
LITE_HOME="$LITE_HOME"

for env_file in "$ROOT_DIR/.env.local" "$ROOT_DIR/node_bridge/.env.local" "$FULL_HOME/.env" "$LITE_HOME/.env"; do
  if [ -f "$env_file" ]; then
    set -a
    # shellcheck disable=SC1090
    source "$env_file"
    set +a
  fi
done
HERMES_HOME="$FULL_HOME"
HERMES_LITE_HOME="$LITE_HOME"

RAN_AGENT_STATE_DIR="${CALLER_STATE_DIR:-${RAN_AGENT_STATE_DIR:-/opt/ran_agent/.ran_agent_state}}"
[[ -z "$CALLER_OMBRE_BRAIN_HOME" ]] || OMBRE_BRAIN_HOME="$CALLER_OMBRE_BRAIN_HOME"
DERIVED_OMBRE_BRAIN_HOME="$RAN_AGENT_STATE_DIR/ombre-brain"
if [[ -n "${OMBRE_BRAIN_HOME:-}" && "$OMBRE_BRAIN_HOME" != "$DERIVED_OMBRE_BRAIN_HOME" ]]; then
  echo "ERROR: Ombre Brain home must derive from RAN_AGENT_STATE_DIR" >&2
  exit 1
fi
OMBRE_BRAIN_REPO_URL="${OMBRE_BRAIN_REPO_URL:-https://github.com/P0luz/Ombre-Brain}"
OMBRE_BRAIN_ENABLED="${OMBRE_BRAIN_ENABLED:-true}"
OMBRE_BRAIN_MCP_ENABLED="${OMBRE_BRAIN_MCP_ENABLED:-true}"
OMBRE_BRAIN_RUNNER="${OMBRE_BRAIN_RUNNER:-source}"
OMBRE_BRAIN_COMMIT="${OMBRE_BRAIN_COMMIT:-0e83d4671ce1629e03ad36bb9160235bf60dbd34}"
OMBRE_BRAIN_HOME="$DERIVED_OMBRE_BRAIN_HOME"
OMBRE_BRAIN_SOURCE_DIR="${OMBRE_BRAIN_SOURCE_DIR:-$OMBRE_BRAIN_HOME/upstream}"
OMBRE_BRAIN_VENV="${OMBRE_BRAIN_VENV:-$OMBRE_BRAIN_HOME/.venv}"
OMBRE_BUCKETS_DIR="${OMBRE_BUCKETS_DIR:-$ROOT_DIR/vault/ombre}"
OMBRE_BIND_HOST="${OMBRE_BIND_HOST:-127.0.0.1}"
OMBRE_MCP_REQUIRE_AUTH="${OMBRE_MCP_REQUIRE_AUTH:-false}"
OMBRE_BRAIN_PORT="${OMBRE_BRAIN_PORT:-18001}"
OMBRE_BRAIN_MCP_URL="${OMBRE_BRAIN_MCP_URL:-http://$OMBRE_BIND_HOST:$OMBRE_BRAIN_PORT/mcp}"
OMBRE_BRAIN_HEALTH_URL="${OMBRE_BRAIN_HEALTH_URL:-http://$OMBRE_BIND_HOST:$OMBRE_BRAIN_PORT/health}"
OMBRE_RECALL_PORT="${OMBRE_RECALL_PORT:-18002}"
OMBRE_RECALL_MCP_URL="${OMBRE_RECALL_MCP_URL:-http://127.0.0.1:$OMBRE_RECALL_PORT/mcp}"
OMBRE_RECALL_HEALTH_URL="${OMBRE_RECALL_HEALTH_URL:-http://127.0.0.1:$OMBRE_RECALL_PORT/health}"
OMBRE_BRAIN_COMPOSE_FILE="${OMBRE_BRAIN_COMPOSE_FILE:-$OMBRE_BRAIN_HOME/docker-compose.yml}"
OMBRE_BRAIN_CONFIG_FILE="${OMBRE_BRAIN_CONFIG_FILE:-$OMBRE_BRAIN_HOME/config.yaml}"
OMBRE_BRAIN_STATUS_FILE="${OMBRE_BRAIN_STATUS_FILE:-$OMBRE_BRAIN_HOME/status.json}"
OMBRE_STEWARD_IDENTITY_FILE="${RAN_AGENT_STEWARD_IDENTITY_FILE:-$OMBRE_BRAIN_HOME/steward-identity.v1.json}"
OMBRE_STEWARD_ENDPOINT="${RAN_AGENT_STEWARD_ENDPOINT:-http://127.0.0.1:$OMBRE_BRAIN_PORT/internal/ran-agent/steward/v1}"
OMBRE_COMPAT_ENABLED="${OMBRE_COMPAT_ENABLED:-false}"
OMBRE_COMPAT_STATE_DIR="${OMBRE_COMPAT_STATE_DIR:-$RAN_AGENT_STATE_DIR/ombre-compat}"
OMBRE_COMPAT_STEWARD_ENDPOINT="${OMBRE_COMPAT_STEWARD_ENDPOINT:-$OMBRE_STEWARD_ENDPOINT}"
OMBRE_COMPAT_STEWARD_IDENTITY_FILE="${OMBRE_COMPAT_STEWARD_IDENTITY_FILE:-$OMBRE_STEWARD_IDENTITY_FILE}"
OMBRE_COMPAT_CURATOR_BASE_URL="${OMBRE_COMPAT_CURATOR_BASE_URL:-https://api.deepseek.com/v1}"
OMBRE_COMPAT_CURATOR_MODEL="${OMBRE_COMPAT_CURATOR_MODEL:-${HERMES_DEFAULT_MODEL:-deepseek-v4-flash}}"
OMBRE_COMPAT_REVIEWER_BASE_URL="${OMBRE_COMPAT_REVIEWER_BASE_URL:-https://api.deepseek.com/v1}"
OMBRE_COMPAT_REVIEWER_MODEL="${OMBRE_COMPAT_REVIEWER_MODEL:-${HERMES_DEFAULT_MODEL:-deepseek-v4-flash}}"
PYTHON_BIN="${RAN_AGENT_PYTHON_BIN:-${ROOT_DIR}/.venv/bin/python}"
RUNTIME_USER="${RAN_AGENT_RUNTIME_USER:-ubuntu}"
RUNTIME_GROUP="${RAN_AGENT_RUNTIME_GROUP:-$RUNTIME_USER}"
if [[ "${EUID}" -eq 0 ]] || ! command -v sudo >/dev/null 2>&1; then SUDO=(); else SUDO=(sudo); fi

for actual_expected in \
  "$OMBRE_BRAIN_SOURCE_DIR|$OMBRE_BRAIN_HOME/upstream" \
  "$OMBRE_BRAIN_VENV|$OMBRE_BRAIN_HOME/.venv" \
  "$OMBRE_BRAIN_COMPOSE_FILE|$OMBRE_BRAIN_HOME/docker-compose.yml" \
  "$OMBRE_BRAIN_CONFIG_FILE|$OMBRE_BRAIN_HOME/config.yaml" \
  "$OMBRE_BRAIN_STATUS_FILE|$OMBRE_BRAIN_HOME/status.json" \
  "$OMBRE_STEWARD_IDENTITY_FILE|$OMBRE_BRAIN_HOME/steward-identity.v1.json"; do
  [[ "${actual_expected%%|*}" == "${actual_expected#*|}" ]] || {
    echo "ERROR: Ombre runtime path must derive from RAN_AGENT_STATE_DIR" >&2
    exit 1
  }
done

if [ "$OMBRE_BRAIN_ENABLED" != "false" ] && [ "$OMBRE_BRAIN_ENABLED" != "0" ]; then
  env \
    OMBRE_BRAIN_RUNNER="$OMBRE_BRAIN_RUNNER" \
    OMBRE_BRAIN_COMMIT="$OMBRE_BRAIN_COMMIT" \
    OMBRE_BIND_HOST="$OMBRE_BIND_HOST" \
    OMBRE_MCP_REQUIRE_AUTH="$OMBRE_MCP_REQUIRE_AUTH" \
    OMBRE_BRAIN_MCP_URL="$OMBRE_BRAIN_MCP_URL" \
    OMBRE_BRAIN_HEALTH_URL="$OMBRE_BRAIN_HEALTH_URL" \
    OMBRE_RECALL_MCP_URL="$OMBRE_RECALL_MCP_URL" \
    OMBRE_RECALL_HEALTH_URL="$OMBRE_RECALL_HEALTH_URL" \
    "$PYTHON_BIN" "$ROOT_DIR/scripts/ombre_o1_contract.py" validate-runner >/dev/null
fi

json_field() {
  local file="$1"
  local field="$2"
  [ -f "$file" ] || return 1
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$file" "$field" <<'PY' || return 1
import json, sys
path, field = sys.argv[1], sys.argv[2]
with open(path, encoding="utf-8") as f:
    data = json.load(f)
value = data.get(field, "")
if value is None:
    print("null")
elif isinstance(value, bool):
    print(str(value).lower())
else:
    print(value)
PY
    return 0
  fi
  tr '{},' '\n\n\n' < "$file" \
    | grep -E "\"$field\"[[:space:]]*:" \
    | head -n 1 \
    | sed 's/^.*:[[:space:]]*//; s/[",]//g; s/^[[:space:]]*//; s/[[:space:]]*$//'
}

json_nested_field() {
  local file="$1"
  local object="$2"
  local field="$3"
  [ -f "$file" ] || return 1
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$file" "$object" "$field" <<'PY' || return 1
import json, sys
path, obj, field = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path, encoding="utf-8") as f:
    data = json.load(f)
value = data.get(obj, {}).get(field, "") if isinstance(data.get(obj), dict) else ""
if value is None:
    print("null")
elif isinstance(value, bool):
    print(str(value).lower())
else:
    print(value)
PY
    return 0
  fi
  json_field "$file" "$field"
}

toolset_has() {
  local file="$1"
  local toolset="$2"
  [ -f "$file" ] || return 1
  awk '
    /^mcp_servers:/ { in_toolsets=0 }
    /^platform_toolsets:/ { in_toolsets=1 }
    in_toolsets { print }
  ' "$file" | grep -q -- "$toolset"
}

server_has() {
  local file="$1"
  local name="$2"
  [ -f "$file" ] || return 1
  grep -q "^  $name:" "$file"
}

compat_model_endpoint_valid() {
  case "$1|$2" in
    'https://api.deepseek.com/v1|deepseek-v4-flash'|'https://api.deepseek.com/v1|deepseek-v4-pro') return 0 ;;
    *) return 1 ;;
  esac
}

echo "=== Ombre Brain runtime ==="
echo "repo_url: $OMBRE_BRAIN_REPO_URL"
echo "enabled: $OMBRE_BRAIN_ENABLED"
echo "mcp_enabled: $OMBRE_BRAIN_MCP_ENABLED"
echo "runner: $OMBRE_BRAIN_RUNNER"
echo "home: $OMBRE_BRAIN_HOME"
echo "source: $OMBRE_BRAIN_SOURCE_DIR"
echo "venv: $OMBRE_BRAIN_VENV"
echo "buckets: $OMBRE_BUCKETS_DIR"
echo "health_url: $OMBRE_BRAIN_HEALTH_URL"
echo "internal_mcp_url: $OMBRE_BRAIN_MCP_URL"
echo "recall_health_url: $OMBRE_RECALL_HEALTH_URL"
echo "recall_mcp_url: $OMBRE_RECALL_MCP_URL"

echo ""
echo "=== Ombre O2 compatibility writer (pre-Gate-5) ==="
echo "enabled: $OMBRE_COMPAT_ENABLED"
echo "state: $OMBRE_COMPAT_STATE_DIR"
echo "steward_endpoint: $OMBRE_COMPAT_STEWARD_ENDPOINT"
echo "steward_identity: $OMBRE_COMPAT_STEWARD_IDENTITY_FILE"
echo "curator: $OMBRE_COMPAT_CURATOR_BASE_URL model=$OMBRE_COMPAT_CURATOR_MODEL"
echo "reviewer: $OMBRE_COMPAT_REVIEWER_BASE_URL model=$OMBRE_COMPAT_REVIEWER_MODEL"
if [[ "$OMBRE_COMPAT_ENABLED" == false ]]; then
  echo "managed O2 config: DISABLED"
elif [[ "$OMBRE_COMPAT_STATE_DIR" == "$RAN_AGENT_STATE_DIR/ombre-compat" &&
  "$OMBRE_COMPAT_STEWARD_ENDPOINT" == "http://127.0.0.1:$OMBRE_BRAIN_PORT/internal/ran-agent/steward/v1" &&
  "$OMBRE_COMPAT_STEWARD_IDENTITY_FILE" == "$OMBRE_BRAIN_HOME/steward-identity.v1.json" &&
  -n "${DEEPSEEK_API_KEY:-}" ]] &&
  compat_model_endpoint_valid "$OMBRE_COMPAT_CURATOR_BASE_URL" "$OMBRE_COMPAT_CURATOR_MODEL" &&
  compat_model_endpoint_valid "$OMBRE_COMPAT_REVIEWER_BASE_URL" "$OMBRE_COMPAT_REVIEWER_MODEL"; then
  echo "managed O2 config: VALID"
else
  echo "managed O2 config: INVALID_OR_INCOMPLETE"
fi

echo ""
echo "=== Status ==="
echo "status_file: $OMBRE_BRAIN_STATUS_FILE"
if [ -f "$OMBRE_BRAIN_STATUS_FILE" ]; then
  echo "deploy_ready: $(json_field "$OMBRE_BRAIN_STATUS_FILE" deploy_ready || echo UNKNOWN)"
  echo "needs_update: $(json_field "$OMBRE_BRAIN_STATUS_FILE" needs_update || echo UNKNOWN)"
  echo "repo_update: $(json_nested_field "$OMBRE_BRAIN_STATUS_FILE" repo update || echo UNKNOWN)"
  echo "repo_after: $(json_nested_field "$OMBRE_BRAIN_STATUS_FILE" repo after || echo UNKNOWN)"
  echo "repo_remote: $(json_nested_field "$OMBRE_BRAIN_STATUS_FILE" repo remote || echo UNKNOWN)"
  echo "requirements_install: $(json_nested_field "$OMBRE_BRAIN_STATUS_FILE" requirements install || echo UNKNOWN)"
  if grep -q '"warnings"[[:space:]]*:[[:space:]]*\[[^]]\{1,\}\]' "$OMBRE_BRAIN_STATUS_FILE"; then
    echo "warnings: PRESENT"
  else
    echo "warnings: none"
  fi
else
  echo "status: MISSING"
fi

if [ "$OMBRE_BRAIN_REPO_URL" != "https://github.com/P0luz/Ombre-Brain" ]; then
  echo "WARNING: Ombre Brain repo URL is not the canonical P0luz/Ombre-Brain upstream"
fi

echo ""
echo "=== Files ==="
for path in "$OMBRE_BRAIN_HOME" "$OMBRE_BRAIN_SOURCE_DIR/src/server.py" "$OMBRE_BRAIN_VENV/bin/python" "$OMBRE_BUCKETS_DIR" "$OMBRE_BRAIN_COMPOSE_FILE" "$OMBRE_BRAIN_CONFIG_FILE"; do
  if [ -e "$path" ]; then
    echo "$path: PRESENT"
  else
    echo "$path: MISSING"
  fi
done

echo ""
echo "=== Managed source services ==="

if command -v systemctl >/dev/null 2>&1; then
  upstream_status=$("${SUDO[@]}" systemctl is-active ran-agent-ombre-brain.service 2>/dev/null || echo "unknown")
  recall_status=$("${SUDO[@]}" systemctl is-active ran-agent-ombre-recall.service 2>/dev/null || echo "unknown")
  echo "ran-agent-ombre-brain.service: $upstream_status"
  echo "ran-agent-ombre-recall.service: $recall_status"
  for spec in "ran-agent-ombre-brain.service:18001" "ran-agent-ombre-recall.service:18002"; do
    unit="${spec%%:*}"; port="${spec##*:}"
    pid="$("${SUDO[@]}" systemctl show "$unit" --property=MainPID --value 2>/dev/null || true)"
    if [[ "$pid" =~ ^[1-9][0-9]*$ ]] &&
      "${SUDO[@]}" ss -ltnp 2>/dev/null | grep -Eq "127\\.0\\.0\\.1:$port([^0-9]|$).*pid=$pid([^0-9]|$)"; then
      echo "$unit ownership: MainPID=$pid owns loopback:$port"
    else
      echo "$unit ownership: INVALID"
    fi
  done
  for unit in ran-agent-node.service ran-agent-ombre-brain.service; do
    if [[ "$("${SUDO[@]}" systemctl show "$unit" --property=User --value 2>/dev/null)" == "$RUNTIME_USER" &&
      "$("${SUDO[@]}" systemctl show "$unit" --property=Group --value 2>/dev/null)" == "$RUNTIME_GROUP" ]]; then
      echo "$unit runtime identity: VALID"
    else
      echo "$unit runtime identity: INVALID"
    fi
  done
else
  echo "systemctl: NOT FOUND"
fi

echo ""
echo "=== Health ==="
if curl -fsS --max-time 5 "$OMBRE_BRAIN_HEALTH_URL" >/tmp/ombre-brain-health.$$ 2>/tmp/ombre-brain-health.err.$$; then
  cat /tmp/ombre-brain-health.$$
  echo ""
else
  echo "health: FAILED"
  sed 's/[[:cntrl:]]//g' /tmp/ombre-brain-health.err.$$ 2>/dev/null || true
fi
rm -f /tmp/ombre-brain-health.$$ /tmp/ombre-brain-health.err.$$

echo ""
echo "=== Patched Steward identity/auth ==="
if id "$RUNTIME_USER" >/dev/null 2>&1 &&
  "$PYTHON_BIN" "$ROOT_DIR/scripts/verify-ombre-steward-runtime.py" \
    --state-dir "$RAN_AGENT_STATE_DIR" \
    --identity-file "$OMBRE_STEWARD_IDENTITY_FILE" \
    --endpoint "$OMBRE_STEWARD_ENDPOINT" \
    --runtime-user "$RUNTIME_USER" --runtime-group "$RUNTIME_GROUP" >/dev/null 2>&1; then
  echo "steward runtime contract: VALID"
else
  echo "steward runtime contract: INVALID_OR_UNAVAILABLE"
fi

echo ""
echo "=== Recall adapter health ==="
if curl -fsS --max-time 5 "$OMBRE_RECALL_HEALTH_URL" >/tmp/ombre-recall-health.$$ 2>/tmp/ombre-recall-health.err.$$; then
  cat /tmp/ombre-recall-health.$$
  echo ""
else
  echo "recall_health: FAILED"
  sed 's/[[:cntrl:]]//g' /tmp/ombre-recall-health.err.$$ 2>/dev/null || true
fi
rm -f /tmp/ombre-recall-health.$$ /tmp/ombre-recall-health.err.$$

echo ""
echo "=== Hermes MCP config ==="
LITE_CONFIG="$LITE_HOME/config.yaml"
FULL_CONFIG="$FULL_HOME/config.yaml"
if [ -f "$FULL_CONFIG" ] &&
  [ -f "$FULL_HOME/profiles/ran-assistant/config.yaml" ] &&
  [ -f "$LITE_CONFIG" ] &&
  [ -f "$LITE_HOME/profiles/ran-assistant-lite/config.yaml" ]; then
  OMBRE_RECALL_MCP_URL="$OMBRE_RECALL_MCP_URL" \
    "$PYTHON_BIN" "$ROOT_DIR/scripts/ombre_o1_contract.py" validate-config \
      "$FULL_CONFIG" "$FULL_HOME/profiles/ran-assistant/config.yaml" \
      "$LITE_CONFIG" "$LITE_HOME/profiles/ran-assistant-lite/config.yaml" >/dev/null
  echo "semantic recall-only config: VALID"
else
  echo "semantic recall-only config: INCOMPLETE"
fi
for label in lite full; do
  if [ "$label" = "lite" ]; then
    cfg="$LITE_CONFIG"
  else
    cfg="$FULL_CONFIG"
  fi
  echo "--- $label: ${cfg:-UNKNOWN} ---"
  if [ ! -f "$cfg" ]; then
    echo "config: MISSING"
    continue
  fi
  for name in ombre_memory; do
    if toolset_has "$cfg" "mcp-$name"; then
      echo "toolset mcp-$name: PRESENT"
    else
      echo "toolset mcp-$name: absent"
    fi
    if server_has "$cfg" "$name"; then
      echo "mcp_servers.$name: PRESENT"
      if grep -q '\${OMBRE_RECALL_MCP_URL}' "$cfg"; then
        echo "mcp_servers.$name recall-only URL: PRESENT"
      else
        echo "mcp_servers.$name recall-only URL: MISSING"
      fi
      if grep -q '\${OMBRE_BRAIN_MCP_URL}' "$cfg"; then
        echo "mcp_servers.$name raw upstream URL: UNSAFE"
      else
        echo "mcp_servers.$name raw upstream URL: absent"
      fi
    else
      echo "mcp_servers.$name: absent"
    fi
  done
done
