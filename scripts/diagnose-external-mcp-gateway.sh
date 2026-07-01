#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

echo "[external-mcp] checking profile default-disabled flags"
for profile in hermes/profile/config.yaml hermes/profile/config.lite.yaml; do
  grep -q 'mcp-external_mcp_gateway' "$profile"
  grep -q 'EXTERNAL_MCP_GATEWAY_ENABLED: "false"' "$profile"
  grep -q 'EXTERNAL_MCP_SYSTEM_QUEUE_ENABLED: "false"' "$profile"
  grep -q 'scripts/start_external_mcp_gateway.sh' "$profile"
  echo "[external-mcp] ok profile=$profile"
done

echo "[external-mcp] checking stable MCP initialize path"
bash scripts/start_external_mcp_gateway.sh initialize >/tmp/ran-agent-external-mcp-initialize.json
grep -q 'ran-agent-external-mcp-gateway' /tmp/ran-agent-external-mcp-initialize.json
rm -f /tmp/ran-agent-external-mcp-initialize.json

echo "[external-mcp] running acceptance tests"
node --test \
  node_bridge/tests/externalMcpRegistry.test.mjs \
  node_bridge/tests/externalMcpPolicy.test.mjs \
  node_bridge/tests/externalMcpSessionManager.test.mjs \
  node_bridge/tests/externalMcpEvidenceLog.test.mjs \
  node_bridge/tests/externalMcpGatewayMcpServer.test.mjs \
  node_bridge/tests/externalMcpSystemQueue.test.mjs \
  node_bridge/tests/externalMcpWatchlist.test.mjs \
  node_bridge/tests/externalMcpProfileDocs.test.mjs \
  node_bridge/tests/actionContract.test.mjs \
  node_bridge/tests/pendingActionState.test.mjs \
  node_bridge/tests/replyBackend.test.mjs \
  node_bridge/tests/channelHub.test.mjs \
  node_bridge/tests/outboundServer.test.mjs

echo "[external-mcp] ok: gateway and system queue remain default-disabled unless EXTERNAL_MCP_GATEWAY_ENABLED=true and EXTERNAL_MCP_SYSTEM_QUEUE_ENABLED=true are set explicitly"
