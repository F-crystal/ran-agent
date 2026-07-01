#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env.local"
NODE_BRIDGE_ENV_FILE="$ROOT_DIR/node_bridge/.env.local"

if [[ "${EXTERNAL_MCP_GATEWAY_SKIP_ENV_FILES:-false}" != "true" ]]; then
  if [ -f "$ENV_FILE" ]; then
    set -a
    # shellcheck disable=SC1090
    source "$ENV_FILE"
    set +a
  fi

  if [ -f "$NODE_BRIDGE_ENV_FILE" ]; then
    set -a
    # shellcheck disable=SC1090
    source "$NODE_BRIDGE_ENV_FILE"
    set +a
  fi
fi

if [[ "${EXTERNAL_MCP_GATEWAY_ALLOW_ENV_ENABLE:-false}" != "true" ]]; then
  export EXTERNAL_MCP_GATEWAY_ENABLED=false
  export EXTERNAL_MCP_SYSTEM_QUEUE_ENABLED=false
fi

export PATH="/home/ubuntu/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
NODE_BIN="${EXTERNAL_MCP_GATEWAY_NODE_BIN:-node}"

if [ "${1:-}" = "initialize" ]; then
  cd "$ROOT_DIR"
  exec "$NODE_BIN" --input-type=module -e '
import { handleExternalMcpGatewayMcpRequest } from "./node_bridge/src/externalMcp/gatewayMcpServer.mjs";
const result = await handleExternalMcpGatewayMcpRequest({ method: "initialize", params: {} });
process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result })}\n`);
'
fi

if [ "${1:-}" = "disabled-call" ]; then
  cd "$ROOT_DIR"
  exec "$NODE_BIN" --input-type=module -e '
import { handleExternalMcpGatewayMcpRequest } from "./node_bridge/src/externalMcp/gatewayMcpServer.mjs";
const result = await handleExternalMcpGatewayMcpRequest({
  method: "tools/call",
  params: { name: "mcp_list_enabled", arguments: {} },
});
process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result })}\n`);
'
fi

exec "$NODE_BIN" "$ROOT_DIR/node_bridge/src/externalMcp/gatewayMcpServer.mjs"
