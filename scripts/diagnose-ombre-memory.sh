#!/usr/bin/env bash
# Diagnose the optional Ombre Brain runtime and Hermes full-profile MCP wiring.

set -euo pipefail

ROOT_DIR="${RAN_AGENT_REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
HERMES_HOME="${HERMES_HOME:-/home/ubuntu/.hermes-ran-agent}"
LITE_HOME="${HERMES_LITE_HOME:-$HERMES_HOME/lite}"

for env_file in "$ROOT_DIR/.env.local" "$ROOT_DIR/node_bridge/.env.local" "$HERMES_HOME/.env" "$LITE_HOME/.env"; do
  if [ -f "$env_file" ]; then
    set -a
    # shellcheck disable=SC1090
    source "$env_file"
    set +a
  fi
done

OMBRE_BRAIN_REPO_URL="${OMBRE_BRAIN_REPO_URL:-https://github.com/P0luz/Ombre-Brain}"
OMBRE_BRAIN_ENABLED="${OMBRE_BRAIN_ENABLED:-true}"
OMBRE_BRAIN_MCP_ENABLED="${OMBRE_BRAIN_MCP_ENABLED:-true}"
OMBRE_BRAIN_HOME="${OMBRE_BRAIN_HOME:-$ROOT_DIR/.ran_agent_state/ombre-brain}"
OMBRE_BUCKETS_DIR="${OMBRE_BUCKETS_DIR:-$ROOT_DIR/vault/ombre}"
OMBRE_BRAIN_BIND_HOST="${OMBRE_BRAIN_BIND_HOST:-127.0.0.1}"
OMBRE_BRAIN_PORT="${OMBRE_BRAIN_PORT:-18001}"
OMBRE_BRAIN_MCP_URL="${OMBRE_BRAIN_MCP_URL:-http://$OMBRE_BRAIN_BIND_HOST:$OMBRE_BRAIN_PORT/mcp}"
OMBRE_BRAIN_MCP_EXTRA_URL="${OMBRE_BRAIN_MCP_EXTRA_URL:-http://$OMBRE_BRAIN_BIND_HOST:$OMBRE_BRAIN_PORT/mcp-extra}"
OMBRE_BRAIN_HEALTH_URL="${OMBRE_BRAIN_HEALTH_URL:-http://$OMBRE_BRAIN_BIND_HOST:$OMBRE_BRAIN_PORT/health}"
OMBRE_BRAIN_COMPOSE_FILE="${OMBRE_BRAIN_COMPOSE_FILE:-$OMBRE_BRAIN_HOME/docker-compose.yml}"
OMBRE_BRAIN_CONFIG_FILE="${OMBRE_BRAIN_CONFIG_FILE:-$OMBRE_BRAIN_HOME/config.yaml}"

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
echo "home: $OMBRE_BRAIN_HOME"
echo "buckets: $OMBRE_BUCKETS_DIR"
echo "health_url: $OMBRE_BRAIN_HEALTH_URL"
echo "mcp_url: $OMBRE_BRAIN_MCP_URL"
echo "mcp_extra_url: $OMBRE_BRAIN_MCP_EXTRA_URL"

if [ "$OMBRE_BRAIN_REPO_URL" != "https://github.com/P0luz/Ombre-Brain" ]; then
  echo "WARNING: Ombre Brain repo URL is not the canonical P0luz/Ombre-Brain upstream"
fi

echo ""
echo "=== Files ==="
for path in "$OMBRE_BRAIN_HOME" "$OMBRE_BUCKETS_DIR" "$OMBRE_BRAIN_COMPOSE_FILE" "$OMBRE_BRAIN_CONFIG_FILE"; do
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
FULL_CONFIG="$HERMES_HOME/config.yaml"
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
