import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
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
  const tools = buildExternalMcpGatewayTools();
  assert.deepEqual(tools.map((tool) => tool.name), [
    'mcp_catalog_search',
    'mcp_probe_server',
    'mcp_enable_server',
    'mcp_list_enabled',
    'mcp_list_tools',
    'mcp_call',
    'mcp_open_session',
    'mcp_close_session',
    'mcp_start_activity',
    'mcp_stop',
    'mcp_explain_policy',
  ]);
  const callToolSchema = tools.find((tool) => tool.name === 'mcp_call')?.inputSchema;
  assert.ok(callToolSchema?.properties?.requestId);
  assert.ok(callToolSchema?.properties?.watchScope);
  assert.ok(callToolSchema?.properties?.topicKey);
});

test('external MCP gateway initialize works while source profile calls stay disabled by default', async () => {
  const init = await handleExternalMcpGatewayMcpRequest({ method: 'initialize', params: {} }, { env: {} });
  const tools = await handleExternalMcpGatewayMcpRequest({ method: 'tools/list', params: {} }, { env: {} });
  const denied = await callTool('mcp_list_enabled', {}, { env: {} });

  assert.equal(init.serverInfo.name, 'ran-agent-external-mcp-gateway');
  assert.equal(tools.tools.length, 11);
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

test('external MCP gateway probes candidates through the executor and stores auto-admitted entries', async (t) => {
  const env = tempGatewayEnv(t);
  const result = await callTool('mcp_probe_server', {
    serverId: 'cedartoy-games',
    url: 'https://toy.cedarstar.org/mcp',
    transport: 'streamable-http',
    activityKind: 'game',
  }, {
    env: { ...env, EXTERNAL_MCP_GATEWAY_ENABLED: 'true' },
    lookupImpl: async () => [{ address: '203.0.113.30', family: 4 }],
    executor: {
      async probe() {
        return {
          ok: true,
          manifest: {
            id: 'cedartoy-games',
            title: 'CedarToy Games',
            source: 'https://github.com/Zizuixixiang/cedareco',
            transport: 'streamable-http',
            url: 'https://toy.cedarstar.org/mcp',
            activityKind: 'game',
            tools: [{ name: 'ecosystem.cmd', description: 'Run a command inside a text-only sandbox game.' }],
          },
          notifications: [],
        };
      },
    },
  });
  const enabled = await callTool('mcp_list_enabled', {}, {
    env: { ...env, EXTERNAL_MCP_GATEWAY_ENABLED: 'true' },
  });

  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.admission.state, 'auto_admitted');
  assert.deepEqual(enabled.structuredContent.servers.map((server) => server.id), ['cedartoy-games']);
});

test('external MCP gateway quarantines risky tools from mixed activity servers', async (t) => {
  const env = tempGatewayEnv(t);
  const probe = await callTool('mcp_probe_server', {
    serverId: 'cedartoy-games',
    url: 'https://toy.cedarstar.org/',
    transport: 'streamable-http',
    activityKind: 'game',
  }, {
    env: { ...env, EXTERNAL_MCP_GATEWAY_ENABLED: 'true' },
    lookupImpl: async () => [{ address: '203.0.113.33', family: 4 }],
    executor: {
      async probe() {
        return {
          ok: true,
          manifest: {
            id: 'cedartoy-games',
            title: 'CedarToy Games',
            transport: 'streamable-http',
            url: 'https://toy.cedarstar.org/',
            activityKind: 'game',
            tools: [
              { name: 'list_games', description: '列出所有可用游戏，返回分类列表及简介' },
              { name: 'get_guide', description: '获取指定游戏的玩法说明' },
              { name: 'play', description: '执行游戏操作' },
              { name: 'login', description: '登录游戏账号' },
              {
                name: 'play_extra',
                description: '执行游戏操作',
                inputSchema: {
                  type: 'object',
                  properties: {
                    payload: {
                      type: 'object',
                      properties: {
                        token: { type: 'string' },
                      },
                      required: ['token'],
                    },
                  },
                },
              },
              { name: 'account', description: '注册账号用；游客也能玩，账号仅供存档和持久身份。' },
            ],
          },
        };
      },
    },
  });
  const tools = await callTool('mcp_list_tools', {
    serverId: 'cedartoy-games',
  }, {
    env: { ...env, EXTERNAL_MCP_GATEWAY_ENABLED: 'true' },
  });
  const account = await callTool('mcp_call', {
    globalUserId: 'user:ran',
    serverId: 'cedartoy-games',
    toolName: 'account',
    sessionId: 'extmcp_missing',
  }, {
    env: { ...env, EXTERNAL_MCP_GATEWAY_ENABLED: 'true', HERMES_PROFILE: 'ran-assistant' },
  });

  assert.equal(probe.structuredContent.admission.state, 'auto_admitted');
  assert.equal(probe.structuredContent.admission.entry.reason, 'safe_remote_sandbox_tool_subset');
  assert.deepEqual(tools.structuredContent.tools.map((tool) => tool.name), ['list_games', 'get_guide', 'play']);
  assert.equal(account.isError, true);
  assert.equal(account.structuredContent.error_code, 'EXTERNAL_MCP_TOOL_NOT_FOUND');
});

test('external MCP gateway activity grants include auto-admitted generic game tools', async (t) => {
  const env = tempGatewayEnv(t);
  await callTool('mcp_probe_server', {
    serverId: 'cedartoy-games',
    url: 'https://toy.cedarstar.org/',
    transport: 'streamable-http',
    activityKind: 'game',
  }, {
    env: { ...env, EXTERNAL_MCP_GATEWAY_ENABLED: 'true' },
    lookupImpl: async () => [{ address: '203.0.113.34', family: 4 }],
    executor: {
      async probe() {
        return {
          ok: true,
          manifest: {
            id: 'cedartoy-games',
            title: 'CedarToy Games',
            transport: 'streamable-http',
            url: 'https://toy.cedarstar.org/',
            activityKind: 'game',
            tools: [
              { name: 'list_games', description: '列出所有可用游戏，返回分类列表及简介' },
              { name: 'get_guide', description: '获取指定游戏的玩法说明' },
              { name: 'play', description: '执行游戏操作' },
              { name: 'account', description: '注册账号用；游客也能玩，账号仅供存档和持久身份。' },
            ],
          },
        };
      },
    },
  });
  const activity = await callTool('mcp_start_activity', {
    globalUserId: 'user:ran',
    serverId: 'cedartoy-games',
    kind: 'game_play',
    maxMinutes: 30,
    maxCalls: 2,
  }, {
    env: { ...env, EXTERNAL_MCP_GATEWAY_ENABLED: 'true' },
  });
  let callInput = null;
  const result = await callTool('mcp_call', {
    globalUserId: 'user:ran',
    serverId: 'cedartoy-games',
    toolName: 'play',
    arguments: { game: 'eco', action: 'eco_observe', params: { player_id: 'hmsran01', action: 'gaze' } },
    sessionId: activity.structuredContent.activity.sessionId,
    activityId: activity.structuredContent.activity.activityId,
  }, {
    env: { ...env, EXTERNAL_MCP_GATEWAY_ENABLED: 'true', HERMES_PROFILE: 'ran-assistant' },
    executor: {
      async call(input) {
        callInput = input;
        return { ok: true, result: { content: [{ type: 'text', text: '一池清水' }] } };
      },
    },
  });

  assert.equal(activity.structuredContent.ok, true);
  assert.equal(result.structuredContent.ok, true);
  assert.equal(callInput.toolName, 'play');
  assert.equal(callInput.url, 'https://toy.cedarstar.org/');
});

test('external MCP gateway calls admitted tools through policy and executor', async (t) => {
  const env = tempGatewayEnv(t);
  await callTool('mcp_probe_server', {
    serverId: 'cedartoy-games',
    url: 'https://toy.cedarstar.org/mcp',
    transport: 'streamable-http',
    activityKind: 'game',
  }, {
    env: { ...env, EXTERNAL_MCP_GATEWAY_ENABLED: 'true' },
    lookupImpl: async () => [{ address: '203.0.113.31', family: 4 }],
    executor: {
      async probe() {
        return {
          ok: true,
          manifest: {
            id: 'cedartoy-games',
            title: 'CedarToy Games',
            transport: 'streamable-http',
            url: 'https://toy.cedarstar.org/mcp',
            activityKind: 'game',
            tools: [{ name: 'ecosystem.cmd', description: 'Run a command inside a text-only sandbox game.' }],
          },
        };
      },
    },
  });
  const session = await callTool('mcp_open_session', {
    globalUserId: 'user:ran',
    serverId: 'cedartoy-games',
    mode: 'interactive',
  }, {
    env: { ...env, EXTERNAL_MCP_GATEWAY_ENABLED: 'true' },
  });
  let callInput = null;
  const result = await callTool('mcp_call', {
    globalUserId: 'user:ran',
    serverId: 'cedartoy-games',
    toolName: 'ecosystem.cmd',
    arguments: { cmd: 'observe' },
    sessionId: session.structuredContent.session.sessionId,
    requestId: 'req-ecosystem-observe',
    watchScope: 'game:cedartoy/eco',
  }, {
    env: { ...env, EXTERNAL_MCP_GATEWAY_ENABLED: 'true', HERMES_PROFILE: 'ran-assistant' },
    executor: {
      async call(input) {
        callInput = input;
        return {
          ok: true,
          result: { content: [{ type: 'text', text: '生态缸很平静' }] },
        };
      },
    },
  });

  assert.equal(result.structuredContent.ok, true);
  assert.equal(callInput.toolName, 'ecosystem.cmd');
  assert.equal(callInput.arguments.cmd, 'observe');
  assert.equal(result.structuredContent.result.content[0].text, '生态缸很平静');
  assert.equal(result.structuredContent.evidence.request_id, 'req-ecosystem-observe');
  assert.equal(result.structuredContent.evidence.watch_scope, 'game:cedartoy/eco');
});

test('external MCP gateway requires a live session for tool calls', async (t) => {
  const env = tempGatewayEnv(t);
  const result = await callTool('mcp_call', {
    globalUserId: 'user:ran',
    serverId: 'cedartoy-games',
    toolName: 'ecosystem.cmd',
    arguments: { cmd: 'observe' },
  }, {
    env: { ...env, EXTERNAL_MCP_GATEWAY_ENABLED: 'true', HERMES_PROFILE: 'ran-assistant' },
    registry: [{
      id: 'cedartoy-games',
      transport: 'streamable-http',
      url: 'https://toy.cedarstar.org/mcp',
      activityKind: 'game',
      tools: [{ name: 'ecosystem.cmd', description: 'Run a command inside a text-only sandbox game.' }],
    }],
  });

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error_code, 'EXTERNAL_MCP_SESSION_REQUIRED');
});

test('external MCP gateway ignores model-supplied profile and session mode on calls', async (t) => {
  const env = tempGatewayEnv(t);
  const opened = await callTool('mcp_open_session', {
    globalUserId: 'user:ran',
    serverId: 'cedartoy-games',
    mode: 'observe',
  }, {
    env: { ...env, EXTERNAL_MCP_GATEWAY_ENABLED: 'true' },
    registry: [{
      id: 'cedartoy-games',
      transport: 'streamable-http',
      url: 'https://toy.cedarstar.org/mcp',
      activityKind: 'game',
      tools: [{ name: 'ecosystem.cmd', description: 'Run a command inside a text-only sandbox game.' }],
    }],
  });
  const result = await callTool('mcp_call', {
    globalUserId: 'user:ran',
    serverId: 'cedartoy-games',
    toolName: 'ecosystem.cmd',
    sessionId: opened.structuredContent.session.sessionId,
    profile: 'owner_full',
    sessionMode: 'interactive',
    trigger: 'activity',
  }, {
    env: { ...env, EXTERNAL_MCP_GATEWAY_ENABLED: 'true', HERMES_PROFILE: 'ran-assistant-lite' },
    registry: [{
      id: 'cedartoy-games',
      transport: 'streamable-http',
      url: 'https://toy.cedarstar.org/mcp',
      activityKind: 'game',
      tools: [{ name: 'ecosystem.cmd', description: 'Run a command inside a text-only sandbox game.' }],
    }],
  });

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error_code, 'EXTERNAL_MCP_POLICY_DENIED');
  assert.equal(result.structuredContent.policy.profile, 'lite');
  assert.equal(result.structuredContent.policy.sessionMode, 'observe');
  assert.equal(result.structuredContent.policy.trigger, 'user_turn');
});

test('external MCP gateway explains policy with the same trusted context used by calls', async (t) => {
  const env = tempGatewayEnv(t);
  const registry = [{
    id: 'cedartoy-games',
    transport: 'streamable-http',
    url: 'https://toy.cedarstar.org/mcp',
    activityKind: 'game',
    tools: [{ name: 'ecosystem.cmd', description: 'Run a command inside a text-only sandbox game.' }],
  }];
  const opened = await callTool('mcp_open_session', {
    globalUserId: 'user:ran',
    serverId: 'cedartoy-games',
    mode: 'observe',
  }, {
    env: { ...env, EXTERNAL_MCP_GATEWAY_ENABLED: 'true' },
    registry,
  });
  const explain = await callTool('mcp_explain_policy', {
    globalUserId: 'user:ran',
    serverId: 'cedartoy-games',
    toolName: 'ecosystem.cmd',
    sessionId: opened.structuredContent.session.sessionId,
    profile: 'owner_full',
    sessionMode: 'interactive',
  }, {
    env: { ...env, EXTERNAL_MCP_GATEWAY_ENABLED: 'true', HERMES_PROFILE: 'ran-assistant-lite' },
    registry,
  });
  const call = await callTool('mcp_call', {
    globalUserId: 'user:ran',
    serverId: 'cedartoy-games',
    toolName: 'ecosystem.cmd',
    sessionId: opened.structuredContent.session.sessionId,
  }, {
    env: { ...env, EXTERNAL_MCP_GATEWAY_ENABLED: 'true', HERMES_PROFILE: 'ran-assistant-lite' },
    registry,
  });

  assert.equal(explain.structuredContent.ok, true);
  assert.equal(explain.structuredContent.context_source, 'session');
  assert.equal(explain.structuredContent.policy.profile, 'lite');
  assert.equal(explain.structuredContent.policy.sessionMode, 'observe');
  assert.equal(explain.structuredContent.policy.trigger, 'user_turn');
  assert.equal(call.isError, true);
  assert.deepEqual(explain.structuredContent.policy, call.structuredContent.policy);
});

test('external MCP gateway resolves unique compact tool aliases without exposing ambiguous matches', async (t) => {
  const env = tempGatewayEnv(t);
  const registry = [{
    id: 'cedartoy-games',
    transport: 'streamable-http',
    url: 'https://toy.cedarstar.org/',
    activityKind: 'game',
    tools: [
      { name: 'listgames', description: '列出所有可用游戏，返回分类列表及简介' },
      { name: 'getguide', description: '获取指定游戏的玩法说明' },
      { name: 'play', description: '执行游戏操作' },
    ],
  }];
  const session = await callTool('mcp_open_session', {
    globalUserId: 'user:ran',
    serverId: 'cedartoy-games',
    mode: 'interactive',
  }, {
    env: { ...env, EXTERNAL_MCP_GATEWAY_ENABLED: 'true' },
    registry,
  });
  let calledToolName = '';
  const result = await callTool('mcp_call', {
    globalUserId: 'user:ran',
    serverId: 'cedartoy-games',
    toolName: 'list_games',
    sessionId: session.structuredContent.session.sessionId,
  }, {
    env: { ...env, EXTERNAL_MCP_GATEWAY_ENABLED: 'true', HERMES_PROFILE: 'ran-assistant' },
    registry,
    executor: {
      async call(input) {
        calledToolName = input.toolName;
        return { ok: true, result: { content: [{ type: 'text', text: 'eco' }] } };
      },
    },
  });

  assert.equal(result.structuredContent.ok, true);
  assert.equal(calledToolName, 'listgames');
  assert.equal(result.structuredContent.toolName, 'listgames');

  const ambiguous = await callTool('mcp_call', {
    globalUserId: 'user:ran',
    serverId: 'cedartoy-games',
    toolName: 'get-guide',
    sessionId: session.structuredContent.session.sessionId,
  }, {
    env: { ...env, EXTERNAL_MCP_GATEWAY_ENABLED: 'true', HERMES_PROFILE: 'ran-assistant' },
    registry: [{
      ...registry[0],
      tools: [
        { name: 'get_guide', description: '获取指定游戏的玩法说明' },
        { name: 'getguide', description: '获取指定游戏的玩法说明' },
      ],
    }],
  });
  assert.equal(ambiguous.isError, true);
  assert.equal(ambiguous.structuredContent.error_code, 'EXTERNAL_MCP_TOOL_AMBIGUOUS');
});

test('external MCP gateway persists upstream MCP session ids between calls without exposing them', async (t) => {
  const env = tempGatewayEnv(t);
  const registry = [{
    id: 'cedartoy-games',
    transport: 'streamable-http',
    url: 'https://toy.cedarstar.org/',
    activityKind: 'game',
    tools: [{ name: 'listgames', description: '列出所有可用游戏，返回分类列表及简介' }],
  }];
  const session = await callTool('mcp_open_session', {
    globalUserId: 'user:ran',
    serverId: 'cedartoy-games',
    mode: 'interactive',
  }, {
    env: { ...env, EXTERNAL_MCP_GATEWAY_ENABLED: 'true' },
    registry,
  });
  const upstreams = [];
  const options = {
    env: { ...env, EXTERNAL_MCP_GATEWAY_ENABLED: 'true', HERMES_PROFILE: 'ran-assistant' },
    registry,
    executor: {
      async call(input) {
        upstreams.push(input.upstreamSessionId || '');
        return {
          ok: true,
          upstreamSessionId: upstreams.length === 1 ? 'remote-session-1' : 'remote-session-2',
          result: { content: [{ type: 'text', text: 'ok' }] },
        };
      },
    },
  };

  const first = await callTool('mcp_call', {
    globalUserId: 'user:ran',
    serverId: 'cedartoy-games',
    toolName: 'listgames',
    sessionId: session.structuredContent.session.sessionId,
  }, options);
  const second = await callTool('mcp_call', {
    globalUserId: 'user:ran',
    serverId: 'cedartoy-games',
    toolName: 'listgames',
    sessionId: session.structuredContent.session.sessionId,
  }, options);

  assert.equal(first.structuredContent.ok, true);
  assert.equal(second.structuredContent.ok, true);
  assert.deepEqual(upstreams, ['', 'remote-session-1']);
  assert.equal(JSON.stringify(session.structuredContent.session).includes('remote-session'), false);
  assert.equal(JSON.stringify(second.structuredContent.evidence).includes('remote-session'), false);
});

test('external MCP gateway activity calls require bounded activity grants and consume budget', async (t) => {
  const env = tempGatewayEnv(t);
  await callTool('mcp_probe_server', {
    serverId: 'cedartoy-games',
    url: 'https://toy.cedarstar.org/mcp',
    transport: 'streamable-http',
    activityKind: 'game',
  }, {
    env: { ...env, EXTERNAL_MCP_GATEWAY_ENABLED: 'true' },
    lookupImpl: async () => [{ address: '203.0.113.32', family: 4 }],
    executor: {
      async probe() {
        return {
          ok: true,
          manifest: {
            id: 'cedartoy-games',
            transport: 'streamable-http',
            url: 'https://toy.cedarstar.org/mcp',
            activityKind: 'game',
            tools: [{ name: 'ecosystem.cmd', description: 'Run a command inside a text-only sandbox game.' }],
          },
        };
      },
    },
  });
  const activity = await callTool('mcp_start_activity', {
    globalUserId: 'user:ran',
    serverId: 'cedartoy-games',
    kind: 'game_play',
    maxMinutes: 30,
    maxCalls: 1,
  }, {
    env: { ...env, EXTERNAL_MCP_GATEWAY_ENABLED: 'true' },
  });
  const args = {
    globalUserId: 'user:ran',
    serverId: 'cedartoy-games',
    toolName: 'ecosystem.cmd',
    arguments: { cmd: 'wait' },
    sessionId: activity.structuredContent.activity.sessionId,
    activityId: activity.structuredContent.activity.activityId,
  };
  const first = await callTool('mcp_call', args, {
    env: { ...env, EXTERNAL_MCP_GATEWAY_ENABLED: 'true', HERMES_PROFILE: 'ran-assistant' },
    executor: { async call() { return { ok: true, result: { content: [{ type: 'text', text: '一天过去了' }] } }; } },
  });
  const second = await callTool('mcp_call', args, {
    env: { ...env, EXTERNAL_MCP_GATEWAY_ENABLED: 'true', HERMES_PROFILE: 'ran-assistant' },
    executor: { async call() { return { ok: true, result: { content: [{ type: 'text', text: '不该继续' }] } }; } },
  });

  assert.equal(activity.structuredContent.ok, true);
  assert.equal(activity.structuredContent.syntheticTurn.route_hint, 'external_mcp_activity');
  assert.equal(first.structuredContent.ok, true);
  assert.equal(first.structuredContent.policy.scopedGrantId, activity.structuredContent.activity.grantId);
  assert.equal(first.structuredContent.evidence.trigger, 'activity');
  assert.equal(second.isError, true);
  assert.equal(second.structuredContent.error_code, 'EXTERNAL_MCP_ACTIVITY_BUDGET_EXHAUSTED');
});

test('external MCP gateway stop interrupts activities by global user id', async (t) => {
  const env = tempGatewayEnv(t);
  const activity = await callTool('mcp_start_activity', {
    globalUserId: 'user:ran',
    serverId: 'cedartoy-games',
    kind: 'game_play',
    maxMinutes: 30,
  }, {
    env: { ...env, EXTERNAL_MCP_GATEWAY_ENABLED: 'true' },
    registry: [{
      id: 'cedartoy-games',
      transport: 'streamable-http',
      url: 'https://toy.cedarstar.org/mcp',
      activityKind: 'game',
      tools: [{ name: 'ecosystem.cmd', description: 'Run a command inside a text-only sandbox game.' }],
    }],
  });
  const stopped = await callTool('mcp_stop', {
    globalUserId: 'user:ran',
    reason: 'user_stop',
  }, {
    env: { ...env, EXTERNAL_MCP_GATEWAY_ENABLED: 'true' },
  });

  assert.equal(activity.structuredContent.ok, true);
  assert.equal(stopped.structuredContent.ok, true);
  assert.deepEqual(stopped.structuredContent.stoppedActivityIds, [activity.structuredContent.activity.activityId]);
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

function tempGatewayEnv(t) {
  const root = fs.mkdtempSync(path.join(PROJECT_ROOT, '.ran_agent_state', 'test-external-mcp-gateway-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { RAN_AGENT_STATE_DIR: root };
}
