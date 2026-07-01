#!/usr/bin/env node
import readline from 'node:readline';

import { normalizeManifest, validateManifest } from './registry.mjs';
import { evaluateExternalMcpPolicy } from './policy.mjs';
import {
  closeExternalMcpSession,
  openExternalMcpSession,
} from './sessionManager.mjs';

const SERVER_INFO = {
  name: 'ran-agent-external-mcp-gateway',
  version: '0.1.0',
};

const TOOL_NAMES = [
  'mcp_catalog_search',
  'mcp_probe_server',
  'mcp_list_enabled',
  'mcp_list_tools',
  'mcp_call',
  'mcp_open_session',
  'mcp_close_session',
  'mcp_explain_policy',
];

export function buildExternalMcpGatewayTools() {
  return [
    tool('mcp_catalog_search', 'MCP Catalog Search', 'Search reviewed external MCP registry entries. Does not execute external MCP tools.', {
      query: str(),
      limit: int(1, 50),
    }),
    tool('mcp_probe_server', 'MCP Probe Server', 'Inspect a candidate MCP in discovery mode. Disabled unless owner explicitly enables discovery.', {
      serverId: str(),
    }),
    tool('mcp_list_enabled', 'MCP List Enabled', 'List enabled external MCP servers with normalized safe tool summaries.', {}),
    tool('mcp_list_tools', 'MCP List Tools', 'List normalized tools for one enabled external MCP server.', {
      serverId: str(),
    }, ['serverId']),
    tool('mcp_call', 'MCP Call', 'Call an approved external MCP tool after policy and session checks.', {
      serverId: str(),
      toolName: str(),
      arguments: { type: 'object', additionalProperties: true },
      sessionId: str(),
    }, ['serverId', 'toolName']),
    tool('mcp_open_session', 'MCP Open Session', 'Open an observe, interactive, or write session for an enabled external MCP server.', {
      globalUserId: str(),
      serverId: str(),
      mode: str(['observe', 'interactive', 'write']),
      trigger: str(['user_turn', 'proactive']),
    }, ['globalUserId', 'serverId', 'mode']),
    tool('mcp_close_session', 'MCP Close Session', 'Close an external MCP session.', {
      sessionId: str(),
      globalUserId: str(),
      serverId: str(),
    }, ['sessionId']),
    tool('mcp_explain_policy', 'MCP Explain Policy', 'Explain whether a tool call is allowed, denied, or requires pending confirmation.', {
      serverId: str(),
      toolName: str(),
      profile: str(['lite', 'full', 'owner_full']),
      sessionMode: str(['observe', 'interactive', 'write']),
      trigger: str(['user_turn', 'proactive']),
    }, ['serverId', 'toolName']),
  ];
}

export async function handleExternalMcpGatewayMcpRequest(request, options = {}) {
  const method = String(request?.method || '');
  if (method === 'initialize') {
    return {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    };
  }
  if (method === 'tools/list') {
    return { tools: buildExternalMcpGatewayTools() };
  }
  if (method === 'tools/call') {
    const params = request?.params || {};
    const name = String(params.name || '');
    const args = params.arguments || {};
    if (!TOOL_NAMES.includes(name)) return errorResult('unknown external MCP gateway tool', 'EXTERNAL_MCP_UNKNOWN_TOOL');
    if (!isGatewayEnabled(options.env || process.env)) return errorResult('external MCP gateway is disabled', 'EXTERNAL_MCP_GATEWAY_DISABLED');
    try {
      return await dispatchTool(name, args, options);
    } catch {
      return errorResult('external MCP gateway tool failed', 'EXTERNAL_MCP_GATEWAY_ERROR');
    }
  }
  throw new Error(`unsupported MCP method: ${method}`);
}

async function dispatchTool(name, args, options) {
  if (name === 'mcp_list_enabled') {
    return result({ ok: true, servers: enabledServers(options) });
  }
  if (name === 'mcp_catalog_search') {
    const query = String(args.query || '').trim().toLowerCase();
    const limit = normalizePositiveInt(args.limit, 20);
    const servers = enabledServers(options)
      .filter((server) => !query || `${server.id} ${server.title}`.toLowerCase().includes(query))
      .slice(0, limit);
    return result({ ok: true, servers });
  }
  if (name === 'mcp_list_tools') {
    const server = findServer(args.serverId, options);
    if (!server) return errorResult('external MCP server not found', 'EXTERNAL_MCP_SERVER_NOT_FOUND');
    return result({ ok: true, serverId: server.id, tools: server.tools });
  }
  if (name === 'mcp_explain_policy') {
    const server = findServer(args.serverId, options);
    if (!server) return errorResult('external MCP server not found', 'EXTERNAL_MCP_SERVER_NOT_FOUND');
    const selectedTool = server.tools.find((item) => item.name === String(args.toolName || '').trim());
    if (!selectedTool) return errorResult('external MCP tool not found', 'EXTERNAL_MCP_TOOL_NOT_FOUND');
    const policy = evaluateExternalMcpPolicy({
      profile: args.profile || 'lite',
      sessionMode: args.sessionMode || 'observe',
      trigger: args.trigger || 'user_turn',
      tool: { ...selectedTool, serverId: server.id },
      watchlistMatched: args.watchlistMatched === true,
      pendingAction: args.pendingAction,
      scopedGrant: args.scopedGrant,
    });
    return result({ ok: true, policy });
  }
  if (name === 'mcp_open_session') {
    const server = findServer(args.serverId, options);
    if (!server) return errorResult('external MCP server not found', 'EXTERNAL_MCP_SERVER_NOT_FOUND');
    const session = openExternalMcpSession({
      globalUserId: args.globalUserId,
      serverId: server.id,
      mode: args.mode,
      trigger: args.trigger || 'user_turn',
      now: options.now,
    }, options);
    if (session.ok === false) return errorResult(session.error, session.error_code);
    return result({ ok: true, session: publicSession(session) });
  }
  if (name === 'mcp_close_session') {
    const closed = closeExternalMcpSession(args.sessionId, {
      ...options,
      globalUserId: args.globalUserId,
      serverId: args.serverId,
      now: options.now,
    });
    return result({ ok: Boolean(closed), session: closed ? publicSession(closed) : null });
  }
  if (name === 'mcp_probe_server') {
    return errorResult('external MCP discovery executor is not enabled', 'EXTERNAL_MCP_DISCOVERY_DISABLED');
  }
  if (name === 'mcp_call') {
    return errorResult('external MCP executor is not enabled', 'EXTERNAL_MCP_EXECUTOR_UNAVAILABLE');
  }
  return errorResult('unknown external MCP gateway tool', 'EXTERNAL_MCP_UNKNOWN_TOOL');
}

function enabledServers(options = {}) {
  const registry = Array.isArray(options.registry) ? options.registry : [];
  return registry
    .map((entry) => validateManifest(entry))
    .filter((entry) => entry.ok)
    .map((entry) => publicServer(entry.manifest));
}

function findServer(serverId, options = {}) {
  const id = String(serverId || '').trim();
  return enabledServers(options).find((server) => server.id === id) || null;
}

function publicServer(manifest) {
  const normalized = normalizeManifest(manifest);
  return {
    id: normalized.id,
    title: normalized.title,
    source: normalized.source,
    version: normalized.version,
    transport: normalized.transport,
    profileScope: normalized.profileScope,
    proactiveAllowed: normalized.proactiveAllowed,
    tools: normalized.tools.map((toolItem) => ({
      name: toolItem.name,
      title: toolItem.title,
      description: toolItem.description,
      tier: toolItem.tier,
      profileScope: toolItem.profileScope,
      proactiveAllowed: toolItem.proactiveAllowed,
      confirmationRequired: toolItem.confirmationRequired,
      reason: toolItem.reason,
      inputSchemaSummary: toolItem.inputSchemaSummary,
      annotations: toolItem.annotations,
    })),
  };
}

function publicSession(session) {
  return {
    sessionId: session.sessionId,
    sessionKey: session.sessionKey,
    serverId: session.serverId,
    mode: session.mode,
    status: session.status,
    expiresAt: session.expiresAt,
  };
}

function isGatewayEnabled(env = process.env) {
  return ['1', 'true', 'yes', 'on'].includes(String(env.EXTERNAL_MCP_GATEWAY_ENABLED || 'false').trim().toLowerCase());
}

function result(payload) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

function errorResult(message, errorCode) {
  const payload = { ok: false, error: String(message || 'external MCP gateway error'), error_code: errorCode };
  return {
    isError: true,
    content: [{ type: 'text', text: payload.error }],
    structuredContent: payload,
  };
}

function tool(name, title, description, properties = {}, required = []) {
  return {
    name,
    title,
    description,
    inputSchema: {
      type: 'object',
      properties,
      required,
      additionalProperties: false,
    },
    annotations: { readOnlyHint: ['mcp_catalog_search', 'mcp_list_enabled', 'mcp_list_tools', 'mcp_explain_policy'].includes(name) },
  };
}

function str(enumValues = null) {
  const schema = { type: 'string' };
  if (enumValues) schema.enum = enumValues;
  return schema;
}

function int(minimum = undefined, maximum = undefined) {
  const schema = { type: 'integer' };
  if (minimum !== undefined) schema.minimum = minimum;
  if (maximum !== undefined) schema.maximum = maximum;
  return schema;
}

function normalizePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function writeJsonRpcResponse(id, response) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result: response })}\n`);
}

function writeJsonRpcError(id, error) {
  process.stdout.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
  })}\n`);
}

export function runExternalMcpGatewayMcpServer(options = {}) {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let request;
    try {
      request = JSON.parse(trimmed);
    } catch (error) {
      writeJsonRpcError(null, error);
      return;
    }
    if (request.id === undefined) return;
    try {
      const response = await handleExternalMcpGatewayMcpRequest(request, options);
      writeJsonRpcResponse(request.id, response);
    } catch (error) {
      writeJsonRpcError(request.id, error);
    }
  });
  rl.on('close', () => {
    process.exit(0);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runExternalMcpGatewayMcpServer();
}
