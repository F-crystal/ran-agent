#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

echo "[external-mcp] checking profile fallback-disabled flags"
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

echo "[external-mcp] checking launcher keeps tool calls disabled despite stale env enables"
EXTERNAL_MCP_GATEWAY_SKIP_ENV_FILES=true \
EXTERNAL_MCP_GATEWAY_ENABLED=true \
EXTERNAL_MCP_SYSTEM_QUEUE_ENABLED=true \
  bash scripts/start_external_mcp_gateway.sh disabled-call >/tmp/ran-agent-external-mcp-disabled-call.json
grep -q 'EXTERNAL_MCP_GATEWAY_DISABLED' /tmp/ran-agent-external-mcp-disabled-call.json
rm -f /tmp/ran-agent-external-mcp-disabled-call.json

echo "[external-mcp] checking deploy gates enable broker calls"
EXTERNAL_MCP_GATEWAY_SKIP_ENV_FILES=true \
EXTERNAL_MCP_GATEWAY_ALLOW_ENV_ENABLE=true \
EXTERNAL_MCP_GATEWAY_ENABLED=true \
EXTERNAL_MCP_SYSTEM_QUEUE_ENABLED=true \
  bash scripts/start_external_mcp_gateway.sh disabled-call >/tmp/ran-agent-external-mcp-enabled-call.json
grep -q '"ok":true' /tmp/ran-agent-external-mcp-enabled-call.json
rm -f /tmp/ran-agent-external-mcp-enabled-call.json

echo "[external-mcp] checking Node system queue requires the gateway gate"
node --input-type=module -e '
import { handleExternalMcpSystemQueueRequest } from "./node_bridge/src/outboundServer.mjs";
const result = await handleExternalMcpSystemQueueRequest({
  env: { EXTERNAL_MCP_SYSTEM_QUEUE_ENABLED: "true" },
  bodyText: JSON.stringify({
    serverId: "forum.example",
    watchScope: "thread:forum.example/123",
    topicKey: "thread:forum.example/123",
    reason: "diagnostic",
    deliverability: "notify_allowed",
  }),
  channelHub: async () => {
    throw new Error("system queue should not reach Hermes while gateway is disabled");
  },
});
if (result?.payload?.reason !== "external_mcp_gateway_disabled") {
  throw new Error(`unexpected system queue gate result: ${JSON.stringify(result)}`);
}
'

echo "[external-mcp] running acceptance tests"
node --test \
  node_bridge/tests/externalMcpRegistry.test.mjs \
  node_bridge/tests/externalMcpExecutor.test.mjs \
  node_bridge/tests/externalMcpPolicy.test.mjs \
  node_bridge/tests/externalMcpSessionManager.test.mjs \
  node_bridge/tests/externalMcpActivityRunner.test.mjs \
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

echo "[external-mcp] ok: source profiles fall back disabled; deploy env can explicitly enable gateway/system queue"
