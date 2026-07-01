import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const PROJECT_ROOT = path.resolve(new URL('../..', import.meta.url).pathname);

function readProjectFile(relativePath) {
  return fs.readFileSync(path.join(PROJECT_ROOT, relativePath), 'utf8');
}

test('Hermes profiles register the stable external MCP gateway with source fallback disabled', () => {
  for (const profilePath of ['hermes/profile/config.yaml', 'hermes/profile/config.lite.yaml']) {
    const text = readProjectFile(profilePath);
    assert.match(text, /mcp-external_mcp_gateway/);
    assert.match(text, /^\s+external_mcp_gateway:\n/m);
    assert.match(text, /scripts\/start_external_mcp_gateway\.sh/);
    assert.match(text, /EXTERNAL_MCP_GATEWAY_ENABLED:\s+"false"/);
    assert.match(text, /EXTERNAL_MCP_SYSTEM_QUEUE_ENABLED:\s+"false"/);
  }
});

test('external MCP governance docs preserve mainlines and proactive safety boundaries', () => {
  const hermesProfile = readProjectFile('hermes/profile/AGENTS.md');
  const runtimeStatus = readProjectFile('docs/governance/current_runtime_status.md');
  const constraints = readProjectFile('docs/governance/constraints.md');

  for (const text of [hermesProfile, runtimeStatus, constraints]) {
    assert.match(text, /external_mcp_gateway/);
    assert.match(text, /synthetic Hermes turn|synthetic Feishu turn|合成/);
    assert.match(text, /watchlist|watch list|关注/);
    assert.match(text, /T4\/T5|T4.*T5/);
    assert.match(text, /pending action|待确认/);
  }

  assert.match(runtimeStatus, /social_reader/);
  assert.match(runtimeStatus, /EXTERNAL_MCP_GATEWAY_ALLOW_ENV_ENABLE=true/);
  assert.match(runtimeStatus, /EXTERNAL_MCP_GATEWAY_ENABLED=true/);
  assert.match(runtimeStatus, /EXTERNAL_MCP_SYSTEM_QUEUE_ENABLED=true/);
  assert.match(runtimeStatus, /media_reader/);
  assert.match(runtimeStatus, /search_hub/);
  assert.match(runtimeStatus, /sticker_catalog/);
  assert.match(runtimeStatus, /co_reading/);
  assert.match(hermesProfile, /不得开启旧 proactive|不要主动发 check-in/);
});

test('apply script deploy-enables external MCP gates through managed env files', () => {
  const script = readProjectFile('scripts/apply-hermes-runtime-split.sh');
  assert.match(script, /EXTERNAL_MCP_GATEWAY_ALLOW_ENV_ENABLE_DEFAULT="\$\{RAN_AGENT_DEPLOY_EXTERNAL_MCP_GATEWAY_ALLOW_ENV_ENABLE:-true\}"/);
  assert.match(script, /EXTERNAL_MCP_GATEWAY_ENABLED_DEFAULT="\$\{RAN_AGENT_DEPLOY_EXTERNAL_MCP_GATEWAY_ENABLED:-true\}"/);
  assert.match(script, /EXTERNAL_MCP_SYSTEM_QUEUE_ENABLED_DEFAULT="\$\{RAN_AGENT_DEPLOY_EXTERNAL_MCP_SYSTEM_QUEUE_ENABLED:-true\}"/);
  assert.match(script, /EXTERNAL_MCP_GATEWAY_ALLOW_ENV_ENABLE\|EXTERNAL_MCP_GATEWAY_ENABLED\|EXTERNAL_MCP_SYSTEM_QUEUE_ENABLED/);
  assert.match(script, /"EXTERNAL_MCP_GATEWAY_ALLOW_ENV_ENABLE=\$EXTERNAL_MCP_GATEWAY_ALLOW_ENV_ENABLE_DEFAULT"/);
  assert.match(script, /"EXTERNAL_MCP_GATEWAY_ENABLED=\$EXTERNAL_MCP_GATEWAY_ENABLED_DEFAULT"/);
  assert.match(script, /"EXTERNAL_MCP_SYSTEM_QUEUE_ENABLED=\$EXTERNAL_MCP_SYSTEM_QUEUE_ENABLED_DEFAULT"/);
});

test('external MCP diagnostics script documents acceptance gates', () => {
  const text = readProjectFile('scripts/diagnose-external-mcp-gateway.sh');
  assert.match(text, /EXTERNAL_MCP_GATEWAY_ALLOW_ENV_ENABLE/);
  assert.match(text, /EXTERNAL_MCP_GATEWAY_ENABLED/);
  assert.match(text, /EXTERNAL_MCP_SYSTEM_QUEUE_ENABLED/);
  assert.match(text, /externalMcpRegistry\.test\.mjs/);
  assert.match(text, /externalMcpGatewayMcpServer\.test\.mjs/);
  assert.match(text, /externalMcpWatchlist\.test\.mjs/);
  assert.match(text, /outboundServer\.test\.mjs/);
});
