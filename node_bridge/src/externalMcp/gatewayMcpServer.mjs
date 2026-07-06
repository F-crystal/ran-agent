#!/usr/bin/env node
import readline from 'node:readline';

import {
  buildExternalMcpActivitySyntheticTurn,
  consumeExternalMcpActivityCall,
  getTrustedExternalMcpActivityGrant,
  registerExternalMcpAbortController,
  startExternalMcpActivity,
  stopExternalMcpActivitiesByUser,
} from './activityRunner.mjs';
import { appendExternalMcpEvidence } from './evidenceLog.mjs';
import {
  callExternalMcpTool,
  probeExternalMcpServer,
} from './executor.mjs';
import {
  admitExternalMcpCandidate,
  getExternalMcpRegistryEntry,
  listEnabledExternalMcpManifests,
  normalizeManifest,
  validateManifest,
} from './registry.mjs';
import { evaluateExternalMcpPolicy } from './policy.mjs';
import {
  closeExternalMcpSession,
  getExternalMcpSession,
  openExternalMcpSession,
} from './sessionManager.mjs';

const SERVER_INFO = {
  name: 'ran-agent-external-mcp-gateway',
  version: '0.1.0',
};

const TOOL_NAMES = [
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
];

export function buildExternalMcpGatewayTools() {
  return [
    tool('mcp_catalog_search', 'MCP Catalog Search', 'Search reviewed external MCP registry entries. Does not execute external MCP tools.', {
      query: str(),
      limit: int(1, 50),
    }),
    tool('mcp_probe_server', 'MCP Probe Server', 'Inspect a candidate MCP in discovery mode, then store it as candidate/auto-admitted/needs-owner/denied.', {
      serverId: str(),
      title: str(),
      url: str(),
      transport: str(['streamable-http', 'http', 'sse']),
      activityKind: str(['game', 'forum', 'browser', 'api']),
      source: str(),
    }, ['serverId', 'url']),
    tool('mcp_enable_server', 'MCP Enable Server', 'Run the admission state machine for a probed candidate. Unknown MCPs are never permanently enabled by this tool alone.', {
      serverId: str(),
      url: str(),
      transport: str(['streamable-http', 'http', 'sse']),
      activityKind: str(['game', 'forum', 'browser', 'api']),
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
      activityId: str(),
      globalUserId: str(),
      requestId: str(),
      watchScope: str(),
      topicKey: str(),
    }, ['serverId', 'toolName', 'sessionId']),
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
    tool('mcp_start_activity', 'MCP Start Activity', 'Start a bounded external MCP activity such as a game session.', {
      globalUserId: str(),
      serverId: str(),
      kind: str(['game_play', 'forum_read']),
      maxMinutes: int(1, 240),
      maxCalls: int(1, 500),
      maxShares: int(0, 50),
    }, ['globalUserId', 'serverId', 'kind']),
    tool('mcp_stop', 'MCP Stop', 'Stop external MCP activities for a global user and revoke their runtime grants.', {
      globalUserId: str(),
      activityId: str(),
      reason: str(),
    }, ['globalUserId']),
    tool('mcp_explain_policy', 'MCP Explain Policy', 'Explain whether a tool call is allowed, denied, or requires pending confirmation.', {
      serverId: str(),
      toolName: str(),
      profile: str(['lite', 'full', 'owner_full']),
      sessionMode: str(['observe', 'interactive', 'write']),
      trigger: str(['user_turn', 'proactive', 'activity']),
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
    const probe = await (options.executor?.probe || probeExternalMcpServer)({
      serverId: args.serverId,
      title: args.title,
      url: args.url,
      transport: args.transport || 'streamable-http',
      activityKind: args.activityKind,
      source: args.source,
    }, options);
    if (!probe?.ok) return errorResult(probe?.error || 'external MCP discovery failed', probe?.error_code || 'EXTERNAL_MCP_DISCOVERY_FAILED');
    const admission = await admitExternalMcpCandidate(probe.manifest, {
      ...options,
      env: options.env || process.env,
      now: options.now,
    });
    return result({ ok: true, probe: publicProbe(probe), admission });
  }
  if (name === 'mcp_enable_server') {
    const existing = getExternalMcpRegistryEntry(args.serverId, options);
    if (!existing && !args.url) return errorResult('external MCP candidate not found', 'EXTERNAL_MCP_CANDIDATE_NOT_FOUND');
    if (existing?.manifest) {
      const admission = await admitExternalMcpCandidate(existing.manifest, {
        ...options,
        env: options.env || process.env,
        now: options.now,
      });
      return result({ ok: true, admission });
    }
    return await dispatchTool('mcp_probe_server', args, options);
  }
  if (name === 'mcp_call') {
    const server = findServer(args.serverId, options);
    if (!server) return errorResult('external MCP server not found', 'EXTERNAL_MCP_SERVER_NOT_FOUND');
    const selectedTool = server.tools.find((item) => item.name === String(args.toolName || '').trim());
    if (!selectedTool) return errorResult('external MCP tool not found', 'EXTERNAL_MCP_TOOL_NOT_FOUND');
    if (!args.sessionId) return errorResult('external MCP session is required', 'EXTERNAL_MCP_SESSION_REQUIRED');
    const session = getExternalMcpSession(args.sessionId, {
      ...options,
      globalUserId: args.globalUserId,
      serverId: server.id,
    });
    if (!session) return errorResult('external MCP session not found or expired', 'EXTERNAL_MCP_SESSION_NOT_FOUND');
    const globalUserId = session.globalUserId;
    const sessionMode = session.mode;
    const trigger = args.activityId ? 'activity' : 'user_turn';
    const scopedGrant = args.activityId
      ? getTrustedExternalMcpActivityGrant(args.activityId, {
          ...options,
          globalUserId,
          serverId: server.id,
          now: options.now,
        })
      : null;
    const policy = evaluateExternalMcpPolicy({
      profile: resolveGatewayProfile(options),
      sessionMode,
      trigger,
      tool: { ...selectedTool, serverId: server.id },
      now: options.now,
      watchlistMatched: false,
      pendingAction: null,
      scopedGrant,
    });
    if (!policy.allowed) {
      return errorResult(
        policy.requiresPendingAction ? 'external MCP call requires pending confirmation' : 'external MCP call denied by policy',
        policy.requiresPendingAction ? 'EXTERNAL_MCP_PENDING_CONFIRMATION_REQUIRED' : 'EXTERNAL_MCP_POLICY_DENIED',
        { policy }
      );
    }
    if (args.activityId) {
      const budget = consumeExternalMcpActivityCall(args.activityId, {
        ...options,
        now: options.now,
      });
      if (!budget.allowed) {
        return errorResult('external MCP activity budget exhausted', 'EXTERNAL_MCP_ACTIVITY_BUDGET_EXHAUSTED', { reason: budget.reason, policy });
      }
    }
    const manifest = findManifest(server.id, options);
    const controller = args.activityId ? new AbortController() : null;
    const unregisterAbort = controller
      ? registerExternalMcpAbortController({
          globalUserId,
          serverId: server.id,
          activityId: args.activityId,
          sessionId: args.sessionId,
        }, controller, options)
      : () => {};
    let call;
    try {
      call = await (options.executor?.call || callExternalMcpTool)({
        serverId: server.id,
        url: manifest?.url,
        transport: manifest?.transport || server.transport,
        toolName: selectedTool.name,
        arguments: args.arguments || {},
        sessionId: args.sessionId,
        globalUserId,
      }, controller ? { ...options, signal: controller.signal } : options);
    } finally {
      unregisterAbort();
    }
    const activeSession = getExternalMcpSession(args.sessionId, {
      ...options,
      globalUserId,
      serverId: server.id,
    });
    const activeGrant = args.activityId
      ? getTrustedExternalMcpActivityGrant(args.activityId, {
          ...options,
          globalUserId,
          serverId: server.id,
          now: options.now,
        })
      : true;
    const evidence = appendExternalMcpEvidence({
      requestId: args.requestId || args.request_id || '',
      globalUserId,
      serverId: server.id,
      toolName: selectedTool.name,
      watchScope: args.watchScope || args.watch_scope || args.topicKey || args.topic_key
        || args.arguments?.watchScope || args.arguments?.watch_scope || args.arguments?.scope || '',
      tier: selectedTool.tier,
      sessionMode,
      trigger,
      decision: call?.ok && activeSession && activeGrant ? 'allow' : 'failed',
      result: { ok: call?.ok === true && Boolean(activeSession) && Boolean(activeGrant) },
      errorCode: call?.error_code || (!activeSession ? 'EXTERNAL_MCP_SESSION_STOPPED' : !activeGrant ? 'EXTERNAL_MCP_ACTIVITY_STOPPED' : ''),
    }, options);
    if (!call?.ok) return errorResult(call?.error || 'external MCP tool call failed', call?.error_code || 'EXTERNAL_MCP_CALL_FAILED', { policy, evidence });
    if (!activeSession) return errorResult('external MCP session stopped before call completed', 'EXTERNAL_MCP_SESSION_STOPPED', { policy, evidence });
    if (!activeGrant) return errorResult('external MCP activity stopped before call completed', 'EXTERNAL_MCP_ACTIVITY_STOPPED', { policy, evidence });
    return result({ ok: true, serverId: server.id, toolName: selectedTool.name, result: call.result, policy, evidence });
  }
  if (name === 'mcp_start_activity') {
    const server = findServer(args.serverId, options);
    if (!server) return errorResult('external MCP server not found', 'EXTERNAL_MCP_SERVER_NOT_FOUND');
    const activity = startExternalMcpActivity({
      globalUserId: args.globalUserId,
      serverId: server.id,
      kind: args.kind,
      maxMinutes: args.maxMinutes,
      maxCalls: args.maxCalls,
      maxShares: args.maxShares,
      allowedToolPattern: activityToolPattern(server, args.kind),
      now: options.now,
    }, options);
    if (activity.ok === false) return errorResult(activity.error, activity.error_code);
    return result({
      ok: true,
      activity: publicActivity(activity),
      syntheticTurn: buildExternalMcpActivitySyntheticTurn(activity, { reason: 'activity_started' }),
    });
  }
  if (name === 'mcp_stop') {
    const stopped = stopExternalMcpActivitiesByUser(args.globalUserId, {
      ...options,
      now: options.now,
      reason: args.reason || 'user_stop',
    });
    return result({ ok: true, stoppedActivityIds: stopped.stoppedActivityIds });
  }
  return errorResult('unknown external MCP gateway tool', 'EXTERNAL_MCP_UNKNOWN_TOOL');
}

function enabledServers(options = {}) {
  const registry = [
    ...(Array.isArray(options.registry) ? options.registry : []),
    ...listEnabledExternalMcpManifests(options),
  ];
  return registry
    .map((entry) => validateManifest(entry))
    .filter((entry) => entry.ok)
    .map((entry) => publicServer(entry.manifest));
}

function findServer(serverId, options = {}) {
  const id = String(serverId || '').trim();
  return enabledServers(options).find((server) => server.id === id) || null;
}

function findManifest(serverId, options = {}) {
  const id = String(serverId || '').trim();
  return [
    ...(Array.isArray(options.registry) ? options.registry : []),
    ...listEnabledExternalMcpManifests(options),
  ]
    .map((entry) => validateManifest(entry))
    .filter((entry) => entry.ok)
    .map((entry) => entry.manifest)
    .find((manifest) => manifest.id === id) || null;
}

function publicServer(manifest) {
  const normalized = normalizeManifest(manifest);
  return {
    id: normalized.id,
    title: normalized.title,
    source: normalized.source,
    version: normalized.version,
    transport: normalized.transport,
    activityKind: normalized.activityKind,
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

function publicProbe(probe) {
  return {
    ok: probe.ok === true,
    protocolVersion: probe.protocolVersion || '',
    notifications: Array.isArray(probe.notifications)
      ? probe.notifications.map((item) => ({ method: String(item?.method || '').slice(0, 120) })).filter((item) => item.method)
      : [],
    manifest: probe.manifest ? publicServer(probe.manifest) : null,
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

function publicActivity(activity) {
  return {
    activityId: activity.activityId,
    grantId: activity.grantId,
    globalUserId: activity.globalUserId,
    serverId: activity.serverId,
    kind: activity.kind,
    status: activity.status,
    sessionId: activity.sessionId,
    sessionMode: activity.sessionMode,
    budget: activity.budget,
    expiresAt: activity.expiresAt,
  };
}

function activityToolPattern(server, kind) {
  const normalizedKind = String(kind || '').trim().toLowerCase();
  const tools = Array.isArray(server?.tools) ? server.tools : [];
  const names = tools
    .filter((toolItem) => activityAllowsTool(normalizedKind, toolItem))
    .map((toolItem) => String(toolItem.name || '').trim())
    .filter(Boolean)
    .slice(0, 128);
  return names.length > 0 ? `^(?:${names.map(escapeRegExp).join('|')})$` : '';
}

function activityAllowsTool(kind, toolItem) {
  if (kind === 'game_play') return toolItem.tier === 'T3' && toolItem.reason === 'sandbox_activity';
  if (kind === 'forum_read') return ['T1', 'T2'].includes(toolItem.tier) && toolItem.confirmationRequired !== true;
  return false;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isGatewayEnabled(env = process.env) {
  return ['1', 'true', 'yes', 'on'].includes(String(env.EXTERNAL_MCP_GATEWAY_ENABLED || 'false').trim().toLowerCase());
}

function resolveGatewayProfile(options = {}) {
  const env = options.env || process.env;
  const explicit = sanitizeProfile(options.profile || env.EXTERNAL_MCP_GATEWAY_PROFILE || '');
  if (explicit) return explicit;
  const capabilityMode = String(env.RAN_AGENT_CAPABILITY_MODE || '').trim().toLowerCase();
  if (capabilityMode === 'owner_full') return 'owner_full';
  const hermesProfile = String(env.HERMES_PROFILE || '').trim().toLowerCase();
  if (hermesProfile.includes('lite')) return 'lite';
  return 'full';
}

function sanitizeProfile(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return ['lite', 'full', 'owner_full'].includes(normalized) ? normalized : '';
}

function result(payload) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

function errorResult(message, errorCode, extra = {}) {
  const payload = { ok: false, error: String(message || 'external MCP gateway error'), error_code: errorCode, ...extra };
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
