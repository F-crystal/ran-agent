#!/usr/bin/env bash
# Diagnose the optional Ombre Brain runtime and Hermes full-profile MCP wiring.

set -euo pipefail

ROOT_DIR="${RAN_AGENT_REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
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

OMBRE_BRAIN_REPO_URL="${OMBRE_BRAIN_REPO_URL:-https://github.com/P0luz/Ombre-Brain}"
OMBRE_BRAIN_ENABLED="${OMBRE_BRAIN_ENABLED:-true}"
OMBRE_BRAIN_MCP_ENABLED="${OMBRE_BRAIN_MCP_ENABLED:-true}"
OMBRE_BRAIN_RUNNER="${OMBRE_BRAIN_RUNNER:-source}"
OMBRE_BRAIN_HOME="${OMBRE_BRAIN_HOME:-$ROOT_DIR/.ran_agent_state/ombre-brain}"
OMBRE_BRAIN_SOURCE_DIR="${OMBRE_BRAIN_SOURCE_DIR:-$OMBRE_BRAIN_HOME/upstream}"
OMBRE_BRAIN_VENV="${OMBRE_BRAIN_VENV:-$OMBRE_BRAIN_HOME/.venv}"
OMBRE_BUCKETS_DIR="${OMBRE_BUCKETS_DIR:-$ROOT_DIR/vault/ombre}"
OMBRE_BRAIN_BIND_HOST="${OMBRE_BRAIN_BIND_HOST:-127.0.0.1}"
OMBRE_BRAIN_PORT="${OMBRE_BRAIN_PORT:-18001}"
OMBRE_BRAIN_MCP_URL="${OMBRE_BRAIN_MCP_URL:-http://$OMBRE_BRAIN_BIND_HOST:$OMBRE_BRAIN_PORT/mcp}"
OMBRE_BRAIN_MCP_EXTRA_URL="${OMBRE_BRAIN_MCP_EXTRA_URL:-http://$OMBRE_BRAIN_BIND_HOST:$OMBRE_BRAIN_PORT/mcp-extra}"
OMBRE_BRAIN_HEALTH_URL="${OMBRE_BRAIN_HEALTH_URL:-http://$OMBRE_BRAIN_BIND_HOST:$OMBRE_BRAIN_PORT/health}"
OMBRE_BRAIN_COMPOSE_FILE="${OMBRE_BRAIN_COMPOSE_FILE:-$OMBRE_BRAIN_HOME/docker-compose.yml}"
OMBRE_BRAIN_CONFIG_FILE="${OMBRE_BRAIN_CONFIG_FILE:-$OMBRE_BRAIN_HOME/config.yaml}"
OMBRE_BRAIN_STATUS_FILE="${OMBRE_BRAIN_STATUS_FILE:-$OMBRE_BRAIN_HOME/status.json}"

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
echo "mcp_url: $OMBRE_BRAIN_MCP_URL"
echo "mcp_extra_url: $OMBRE_BRAIN_MCP_EXTRA_URL"

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
echo "=== Docker/service ==="
if command -v docker >/dev/null 2>&1; then
  echo "docker: $(command -v docker)"
  if docker compose version >/dev/null 2>&1; then
    echo "docker compose: OK"
  else
    echo "docker compose: NOT READY"
  fi
else
  echo "docker: NOT FOUND"
fi

if command -v systemctl >/dev/null 2>&1; then
  status=$(systemctl is-active ran-agent-ombre-brain.service 2>/dev/null || echo "unknown")
  echo "ran-agent-ombre-brain.service: $status"
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
echo "=== Hermes MCP config ==="
LITE_CONFIG="$LITE_HOME/config.yaml"
FULL_CONFIG="$FULL_HOME/config.yaml"
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
  for name in ombre_memory ombre_memory_extra; do
    if toolset_has "$cfg" "mcp-$name"; then
      echo "toolset mcp-$name: PRESENT"
    else
      echo "toolset mcp-$name: absent"
    fi
    if server_has "$cfg" "$name"; then
      echo "mcp_servers.$name: PRESENT"
    else
      echo "mcp_servers.$name: absent"
    fi
  done
done
