#!/bin/bash
# Diagnose Search Hub MCP source/runtime convergence.
# Run: bash scripts/diagnose-search-hub.sh
# No secrets exposed.

set -euo pipefail

REPO_ROOT="${RAN_AGENT_REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
HERMES_HOME="${HERMES_HOME:-/home/ubuntu/.hermes-ran-agent}"
LITE_HOME="${HERMES_LITE_HOME:-$HERMES_HOME/lite}"
FULL_CONFIG="$HERMES_HOME/config.yaml"
LITE_CONFIG="$LITE_HOME/config.yaml"
FULL_ENV="$HERMES_HOME/.env"
LITE_ENV="$LITE_HOME/.env"

section() {
  printf '\n=== %s ===\n' "$1"
}

present_in_file() {
  local label="$1"
  local file="$2"
  local pattern="$3"
  if [ -f "$file" ] && grep -q "$pattern" "$file"; then
    echo "$label: PRESENT"
  else
    echo "$label: MISSING"
  fi
}

toolset_has() {
  local file="$1"
  local value="$2"
  [ -f "$file" ] && awk '/^mcp_servers:/ { in_toolsets=0 } /^platform_toolsets:/ { in_toolsets=1 } in_toolsets { print }' "$file" | grep -q "$value"
}

env_value() {
  local file="$1"
  local key="$2"
  [ -f "$file" ] && grep -E "^${key}=" "$file" | tail -n 1 | cut -d= -f2- || true
}

env_present_redacted() {
  local key="$1"
  local value=""
  for file in "$REPO_ROOT/.env.local" "$REPO_ROOT/node_bridge/.env.local" "$FULL_ENV" "$HERMES_HOME/profiles/ran-assistant/.env" "$LITE_ENV" "$LITE_HOME/profiles/ran-assistant-lite/.env"; do
    [ -f "$file" ] || continue
    value="$(grep -E "^${key}=" "$file" | tail -n 1 | cut -d= -f2- || true)"
    [ -n "$value" ] && break
  done
  if [ -n "$value" ]; then
    if command -v sha256sum >/dev/null 2>&1; then
      hash="$(printf '%s' "$value" | sha256sum | awk '{print substr($1,1,12)}')"
    else
      hash="$(printf '%s' "$value" | shasum -a 256 | awk '{print substr($1,1,12)}')"
    fi
    echo "$key: PRESENT len=${#value} sha256=$hash"
  else
    echo "$key: MISSING"
  fi
}

cd "$REPO_ROOT"

section "1. Repo source config"
present_in_file ".mcp.json search_hub" "$REPO_ROOT/.mcp.json" '"search_hub"'
present_in_file "full profile mcp-search_hub" "$REPO_ROOT/hermes/profile/config.yaml" 'mcp-search_hub'
present_in_file "lite profile mcp-search_hub" "$REPO_ROOT/hermes/profile/config.lite.yaml" 'mcp-search_hub'
if [ -x "$REPO_ROOT/scripts/start_search_hub_mcp.sh" ]; then
  echo "start_search_hub_mcp.sh: EXECUTABLE"
else
  echo "start_search_hub_mcp.sh: MISSING_OR_NOT_EXECUTABLE"
fi

section "2. Runtime config"
present_in_file "full runtime search_hub server" "$FULL_CONFIG" '^  search_hub:'
present_in_file "lite runtime search_hub server" "$LITE_CONFIG" '^  search_hub:'
if toolset_has "$FULL_CONFIG" 'mcp-search_hub'; then echo "full mcp-search_hub toolset: PRESENT"; else echo "full mcp-search_hub toolset: MISSING"; fi
if toolset_has "$LITE_CONFIG" 'mcp-search_hub'; then echo "lite mcp-search_hub toolset: PRESENT"; else echo "lite mcp-search_hub toolset: MISSING"; fi
if toolset_has "$LITE_CONFIG" 'mcp-playwright'; then echo "WARNING: lite exposes mcp-playwright"; else echo "lite mcp-playwright toolset: ABSENT (OK)"; fi
if toolset_has "$LITE_CONFIG" 'mcp-media_generation'; then echo "WARNING: lite exposes mcp-media_generation"; else echo "lite mcp-media_generation toolset: ABSENT (OK)"; fi

section "3. Profile modes"
echo "full SEARCH_HUB_PROFILE_MODE: $(env_value "$FULL_ENV" SEARCH_HUB_PROFILE_MODE || true)"
echo "lite SEARCH_HUB_PROFILE_MODE: $(env_value "$LITE_ENV" SEARCH_HUB_PROFILE_MODE || true)"
env_present_redacted TAVILY_API_KEY
env_present_redacted OPENALEX_MAILTO

section "4. Local imports and binaries"
node -e "import('./node_bridge/src/searchHubMcpServer.mjs').then(()=>console.log('searchHubMcpServer import: OK'))"
if command -v opencli >/dev/null 2>&1; then
  echo "opencli: $(command -v opencli)"
else
  echo "opencli: NOT FOUND (public Tavily/AIHOT paths can still work)"
fi

if [ "$(env_value "$FULL_ENV" SEARCH_HUB_ENABLE_OPENCLI_BROWSER || true)" = "true" ] && command -v opencli >/dev/null 2>&1; then
  if command -v timeout >/dev/null 2>&1; then
    DOCTOR_CMD=(timeout 20 opencli doctor)
  else
    DOCTOR_CMD=(opencli doctor)
  fi
  if "${DOCTOR_CMD[@]}" >/tmp/search-hub-opencli-doctor.txt 2>&1; then
    echo "opencli doctor: OK"
  else
    echo "opencli doctor: WARNING browser-backed adapters may be unavailable"
  fi
fi

section "5. MCP smoke"
if command -v timeout >/dev/null 2>&1; then
  SMOKE_CMD=(timeout 30 bash scripts/start_search_hub_mcp.sh)
else
  SMOKE_CMD=(bash scripts/start_search_hub_mcp.sh)
fi
SMOKE_OUTPUT="$(
  printf '%s\n' \
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"diagnose-search-hub","version":"0.1.0"}}}' \
    '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
    '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"search","arguments":{"query":"RAG 最近论文","intent":"academic","limit":1}}}' \
  | "${SMOKE_CMD[@]}"
)" || true
if printf '%s' "$SMOKE_OUTPUT" | grep -q '"name":"search"'; then
  echo "tools/list: OK"
else
  echo "tools/list: CHECK_FAILED"
fi
if printf '%s' "$SMOKE_OUTPUT" | grep -q 'openalex\|arxiv\|pubmed\|OPENCLI_NOT_FOUND\|TAVILY_API_KEY_MISSING'; then
  echo "academic smoke: OK_OR_TYPED_WARNING"
else
  echo "academic smoke: CHECK_OUTPUT"
fi

section "6. Recent logs"
sudo journalctl -u ran-agent-hermes.service -u ran-agent-hermes-full.service -u ran-agent-node.service --since "30 minutes ago" --no-pager 2>/dev/null \
  | grep -i 'search_hub\|mcp-search_hub' \
  | tail -10 || echo "No recent search_hub logs"
