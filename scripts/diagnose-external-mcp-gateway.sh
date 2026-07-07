#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

resolve_node_bin() {
  if [ -n "${NODE_BIN:-}" ]; then
    printf '%s\n' "$NODE_BIN"
    return 0
  fi
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  if [ -x "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" ]; then
    printf '%s\n' "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
    return 0
  fi
  echo "ERROR: node not found; set NODE_BIN to a Node.js executable" >&2
  exit 127
}

NODE_EXE="$(resolve_node_bin)"

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
"$NODE_EXE" --input-type=module -e '
import { handleExternalMcpSystemQueueRequest } from "./node_bridge/src/outboundServer.mjs";
const result = await handleExternalMcpSystemQueueRequest({
  env: {
    HERMES_PROACTIVE_EVENTS_ENABLED: "true",
    HERMES_PROACTIVE_EXTERNAL_MCP_ENABLED: "true",
    EXTERNAL_MCP_SYSTEM_QUEUE_ENABLED: "true",
  },
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

echo "[external-mcp] checking policy/session/alias smoke"
"$NODE_EXE" --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { handleExternalMcpGatewayMcpRequest } from './node_bridge/src/externalMcp/gatewayMcpServer.mjs';

const stateBase = path.join(process.cwd(), '.ran_agent_state');
fs.mkdirSync(stateBase, { recursive: true });
const stateDir = fs.mkdtempSync(path.join(stateBase, 'diagnose-external-mcp-'));
const env = {
  EXTERNAL_MCP_GATEWAY_ENABLED: 'true',
  RAN_AGENT_STATE_DIR: stateDir,
};
const registry = [{
  id: 'cedartoy-games',
  title: 'CedarToy Games',
  source: 'https://toy.cedarstar.org/mcp',
  transport: 'streamable-http',
  url: 'https://toy.cedarstar.org/mcp',
  activityKind: 'game',
  tools: [
    { name: 'listgames', description: '列出所有可用游戏，返回分类列表及简介' },
    { name: 'getguide', description: '获取游戏攻略和规则' },
    { name: 'play', description: '进行一局安全文本游戏' },
  ],
}];
async function callTool(name, args = {}, options = {}) {
  return await handleExternalMcpGatewayMcpRequest({
    method: 'tools/call',
    params: { name, arguments: args },
  }, { env, registry, ...options });
}

const opened = await callTool('mcp_open_session', {
  serverId: 'cedartoy-games',
  globalUserId: 'user:diag',
  mode: 'interactive',
});
assert.equal(opened.structuredContent.ok, true);
const sessionId = opened.structuredContent.session.sessionId;

const explain = await callTool('mcp_explain_policy', {
  serverId: 'cedartoy-games',
  toolName: 'list_games',
  sessionId,
  globalUserId: 'user:diag',
});
assert.equal(explain.structuredContent.ok, true);
assert.equal(explain.structuredContent.context_source, 'session');

const upstreams = [];
const executorImpl = async (input) => {
  upstreams.push(input.upstreamSessionId || '');
  return {
    ok: true,
    serverId: input.serverId,
    toolName: input.toolName,
    result: { games: ['cedar'] },
    upstreamSessionId: upstreams.length === 1 ? 'remote-session-1' : 'remote-session-2',
  };
};
const first = await callTool('mcp_call', {
  serverId: 'cedartoy-games',
  toolName: 'list_games',
  sessionId,
  globalUserId: 'user:diag',
}, { executor: { call: executorImpl } });
const second = await callTool('mcp_call', {
  serverId: 'cedartoy-games',
  toolName: 'list_games',
  sessionId,
  globalUserId: 'user:diag',
}, { executor: { call: executorImpl } });
assert.equal(first.structuredContent.ok, true);
assert.equal(first.structuredContent.toolName, 'listgames');
assert.deepEqual(upstreams, ['', 'remote-session-1']);
assert.equal(JSON.stringify(first.structuredContent).includes('remote-session'), false);
assert.equal(JSON.stringify(second.structuredContent).includes('remote-session'), false);

const ambiguous = await handleExternalMcpGatewayMcpRequest({
  method: 'tools/call',
  params: {
    name: 'mcp_call',
    arguments: {
      serverId: 'ambiguous-games',
      toolName: 'list_games',
      sessionId,
      globalUserId: 'user:diag',
    },
  },
}, {
  env,
  registry: [{
    id: 'ambiguous-games',
    title: 'Ambiguous Games',
    source: 'https://toy.cedarstar.org/mcp',
    transport: 'streamable-http',
    url: 'https://toy.cedarstar.org/mcp',
    activityKind: 'game',
    tools: [
      { name: 'listgames', description: 'list games' },
      { name: 'list-games', description: 'list games duplicate alias' },
    ],
  }],
  executor: { call: executorImpl },
});
assert.equal(ambiguous.isError, true);
assert.equal(ambiguous.structuredContent.error_code, 'EXTERNAL_MCP_TOOL_AMBIGUOUS');
NODE

echo "[external-mcp] running acceptance tests"
"$NODE_EXE" --test \
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
