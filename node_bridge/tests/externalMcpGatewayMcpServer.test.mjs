import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  buildExternalMcpGatewayTools,
  handleExternalMcpGatewayMcpRequest,
} from '../src/externalMcp/gatewayMcpServer.mjs';

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = path.resolve(new URL('../..', import.meta.url).pathname);

function safeManifest() {
  return {
    id: 'forum.example',
    title: 'Example Forum',
    source: 'https://github.com/example/forum-mcp',
    version: '1.0.0',
    transport: 'stdio',
    command: 'node',
    args: ['server.mjs'],
    requiredEnv: ['FORUM_TOKEN'],
    tools: [
      { name: 'forum.read_thread', description: 'Read a public thread.' },
      { name: 'forum.submit_reply', description: 'Submit reply to a thread.' },
    ],
  };
}

async function callTool(name, args = {}, options = {}) {
  return await handleExternalMcpGatewayMcpRequest({
    method: 'tools/call',
    params: { name, arguments: args },
  }, options);
}

test('external MCP gateway exposes one stable tool surface', () => {
  assert.deepEqual(buildExternalMcpGatewayTools().map((tool) => tool.name), [
    'mcp_catalog_search',
    'mcp_probe_server',
    'mcp_list_enabled',
    'mcp_list_tools',
    'mcp_call',
    'mcp_open_session',
    'mcp_close_session',
    'mcp_explain_policy',
  ]);
});

test('external MCP gateway initialize works while source profile calls stay disabled by default', async () => {
  const init = await handleExternalMcpGatewayMcpRequest({ method: 'initialize', params: {} }, { env: {} });
  const tools = await handleExternalMcpGatewayMcpRequest({ method: 'tools/list', params: {} }, { env: {} });
  const denied = await callTool('mcp_list_enabled', {}, { env: {} });

  assert.equal(init.serverInfo.name, 'ran-agent-external-mcp-gateway');
  assert.equal(tools.tools.length, 8);
  assert.equal(denied.isError, true);
  assert.equal(denied.structuredContent.error_code, 'EXTERNAL_MCP_GATEWAY_DISABLED');
});

test('external MCP gateway lists normalized enabled registry entries only when enabled', async () => {
  const result = await callTool('mcp_list_enabled', {}, {
    env: { EXTERNAL_MCP_GATEWAY_ENABLED: 'true' },
    registry: [safeManifest()],
  });

  assert.equal(result.structuredContent.ok, true);
  assert.deepEqual(result.structuredContent.servers.map((server) => server.id), ['forum.example']);
  assert.deepEqual(result.structuredContent.servers[0].tools.map((tool) => [tool.name, tool.tier]), [
    ['forum.read_thread', 'T1'],
    ['forum.submit_reply', 'T4'],
  ]);
  assert.equal(JSON.stringify(result).includes('FORUM_TOKEN='), false);
});

test('external MCP gateway explains policy decisions without executing tools', async () => {
  const result = await callTool('mcp_explain_policy', {
    serverId: 'forum.example',
    toolName: 'forum.submit_reply',
    profile: 'full',
    sessionMode: 'interactive',
  }, {
    env: { EXTERNAL_MCP_GATEWAY_ENABLED: 'true' },
    registry: [safeManifest()],
  });

  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.policy.decision, 'confirmation_required');
  assert.equal(result.structuredContent.policy.requiresPendingAction, true);
});

test('external MCP gateway opens observe sessions through the stable surface', async () => {
  const result = await callTool('mcp_open_session', {
    globalUserId: 'user:ran',
    serverId: 'forum.example',
    mode: 'observe',
  }, {
    env: { EXTERNAL_MCP_GATEWAY_ENABLED: 'true' },
    registry: [safeManifest()],
  });

  assert.equal(result.structuredContent.ok, true);
  assert.match(result.structuredContent.session.sessionId, /^extmcp_[a-f0-9]{24}$/);
  assert.equal(result.structuredContent.session.mode, 'observe');
});

test('start_external_mcp_gateway.sh initialize exits after one response', async () => {
  const { stdout } = await execFileAsync(
    'bash',
    ['scripts/start_external_mcp_gateway.sh', 'initialize'],
    { cwd: PROJECT_ROOT, timeout: 1500 }
  );

  const response = JSON.parse(stdout.trim());
  assert.equal(response.result.serverInfo.name, 'ran-agent-external-mcp-gateway');
});

test('start_external_mcp_gateway.sh keeps tool calls disabled despite stale env enable', async () => {
  const { stdout } = await execFileAsync(
    'bash',
    ['scripts/start_external_mcp_gateway.sh', 'disabled-call'],
    {
      cwd: PROJECT_ROOT,
      timeout: 1500,
      env: {
        ...process.env,
        EXTERNAL_MCP_GATEWAY_ENABLED: 'true',
        EXTERNAL_MCP_SYSTEM_QUEUE_ENABLED: 'true',
        EXTERNAL_MCP_GATEWAY_ALLOW_ENV_ENABLE: '',
        EXTERNAL_MCP_GATEWAY_SKIP_ENV_FILES: 'true',
      },
    }
  );

  const response = JSON.parse(stdout.trim());
  assert.equal(response.result.isError, true);
  assert.equal(response.result.structuredContent.error_code, 'EXTERNAL_MCP_GATEWAY_DISABLED');
});
