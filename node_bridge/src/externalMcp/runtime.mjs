import { createHash } from 'node:crypto';

import { appendExternalMcpEvidence } from './evidenceLog.mjs';
import { createExternalMcpActivityFacade } from './activityFacade.mjs';
import { createExternalMcpActivityStore } from './activityStore.mjs';
import { createExternalMcpAutonomySupervisor } from './autonomySupervisor.mjs';
import { appendExternalMcpExperience, getProvenExternalMcpExperiences } from './experienceStore.mjs';
import { createExternalMcpGatewayService } from './gatewayService.mjs';
import { bindGenericMcpBrokerResult, createGenericMcpAdapter } from './genericAdapter.mjs';
import { createBridgeExternalMcpOperationCapability } from './operationReceipt.mjs';
import { trustExternalMcpScopedGrant } from './policy.mjs';
import { listEnabledExternalMcpManifests } from './registry.mjs';
import {
  closeExternalMcpSession,
  getExternalMcpSession,
  listExternalMcpSessions,
  openExternalMcpSession,
  updateExternalMcpSession,
} from './sessionManager.mjs';
import { createExternalMcpTransportRouter } from './transportRouter.mjs';
import { discoverExternalMcpServer } from './executor.mjs';
import { createDurableJob, queryDurableJob, terminalizeDurableJob } from '../durableJobClient.mjs';

const DOMAIN_BY_ACTIVITY_KIND = Object.freeze({
  game: 'game',
  forum: 'forum',
  browser: 'other',
  api: 'other',
  embodied: 'embodied',
  other: 'other',
});

// This is the one bridge-owned home for durable external activities.  The
// reply envelope only reaches its facade; registry selection, scope, risk and
// transport remain bridge-owned.
export function createExternalMcpAutonomyRuntime(options = {}) {
  const env = options.env || process.env;
  const logger = options.logger || console;
  const listManifests = typeof options.listManifests === 'function'
    ? options.listManifests
    : () => listEnabledExternalMcpManifests({ env });
  const transport = normalizeBrokerTransport(options.transport);
  const liveDiscovery = createLiveMcpDiscovery({ env, options, transport });
  const store = options.store || createExternalMcpActivityStore({ env, statePath: options.statePath });
  const trustedBrokerReceipts = new WeakSet();
  const broker = createBridgeOwnedBroker({
    env,
    options,
    store,
    listManifests,
    transport,
    onToolsListChanged: liveDiscovery.refresh,
    trustedBrokerReceipts,
  });
  const supervisor = options.supervisor || createExternalMcpAutonomySupervisor({
    store,
    transport,
    tickIntervalMs: options.tickIntervalMs,
    planner: options.planner,
    experienceProvider: options.experienceProvider || createExternalMcpExperienceProvider({ env, trustedBrokerReceipts }),
    narrator: options.narrator,
    submitCandidate: options.submitCandidate,
    abortActivity: options.abortActivity || broker.abortActivity,
    revokeActivity: options.revokeActivity || broker.revokeActivity,
    createCoreJob: options.createCoreJob || ((input) => createDurableJob(input, { env })),
    queryCoreJob: options.queryCoreJob || ((jobId) => queryDurableJob(jobId, { env })),
    terminalizeCoreJob: options.terminalizeCoreJob || ((jobId, input) => terminalizeDurableJob(jobId, input, { env })),
    adapterResolver: ({ activity, input }) => adapterFor({ activity, input, listManifests, liveDiscovery }),
    // The generic adapter only speaks normalized action IDs. Its injected
    // transport is this bridge closure, which mints a non-serializable
    // capability and invokes the gateway service for every tool call.
    transportFor: broker.transportFor,
    reconcilePending: broker.reconcilePending,
    resolveCommitInput: async (command) => resolveCommitInput({ command, listManifests, transport: broker, liveDiscovery }),
  });
  const facadeCore = options.facade || createExternalMcpActivityFacade({
    supervisor,
    resolveStandingStart: ({ currentTurn }) => resolveStandingStart({ currentTurn, listManifests }),
  });
  const facade = Object.freeze({
    ...facadeCore,
    async bindNotifyTarget({ receipt, actorContext, target } = {}) {
      const activityId = String(receipt?.jobId || '').trim();
      return supervisor.bindNotifyTarget(activityId, { actorContext, target });
    },
  });
  const intervalMs = boundedInterval(options.intervalMs || env.EXTERNAL_MCP_ACTIVITY_TICK_MS);
  let timer = null;
  let running = false;

  async function tick() {
    if (running) return { skipped: true, reason: 'already_running' };
    running = true;
    try {
      await liveDiscovery.refreshActive(store.list(), listManifests());
      return await supervisor.scanDue();
    } catch (error) {
      logger.warn?.(`[external-mcp-runtime] supervisor tick failed: ${String(error?.message || error)}`);
      return { skipped: true, reason: 'tick_failed' };
    } finally {
      running = false;
    }
  }

  async function start() {
    const initial = await tick();
    if (!timer) {
      timer = setInterval(() => { tick().catch(() => {}); }, intervalMs);
      timer.unref?.();
    }
    return initial;
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return Object.freeze({ store, supervisor, facade, start, stop, tick });
}

async function resolveCommitInput({ command, listManifests, transport, liveDiscovery }) {
  if (!transport.available) return null;
  const domain = String(command?.selection?.domain || '');
  const candidates = enabledManifestsForDomain(listManifests(), domain);
  if (candidates.length === 0) return null;
  const manifest = candidates[0];
  // A configured server remains configured if this read-only discovery fails;
  // only its current autonomous operation is constrained.
  await liveDiscovery?.refresh(manifest);
  const goal = typeof command.goal === 'string' ? command.goal : '';
  if (!goal) return null;
  return {
    goal: { text: goal, constraints: [] },
    manifest,
    // These are derived only from the enabled registry manifest.  Nothing in
    // the model envelope can select a server, widen scope, or permit effects.
    trustedContext: { allowedResourceIds: [] },
    risk: riskForManifest(manifest),
  };
}

function adapterFor({ activity, input, listManifests, liveDiscovery }) {
  const serverId = String(activity?.scope?.serverId || input?.manifest?.id || '');
  const manifest = manifests(listManifests()).find((item) => item.id === serverId);
  if (!manifest) throw new Error('enabled external MCP manifest is unavailable');
  const discovery = liveDiscovery?.forManifest(manifest);
  return createGenericMcpAdapter(discovery || {
    initializeResult: {
      serverInfo: { name: manifest.id, version: String(manifest.version || '') },
      capabilities: { tools: {} },
    },
    toolsResult: { tools: manifest.tools.map(toolForAdapter) },
  });
}

function enabledManifestsForDomain(value, domain) {
  return manifests(value)
    .filter((manifest) => DOMAIN_BY_ACTIVITY_KIND[manifest.activityKind] === domain)
    .sort((left, right) => left.id.localeCompare(right.id));
}

function resolveStandingStart({ currentTurn, listManifests }) {
  const goal = String(currentTurn?.text || '').trim();
  if (!goal) return null;
  const manifest = manifests(listManifests())
    .filter((item) => item.activityKind !== 'embodied')
    .sort((left, right) => left.id.localeCompare(right.id))[0];
  if (!manifest) return null;
  return { goal, environmentHint: manifest.activityKind, reporting: {} };
}

function manifests(value) {
  const seen = new Set();
  return (Array.isArray(value) ? value : [])
    .filter((manifest) => manifest && typeof manifest === 'object')
    .filter((manifest) => typeof manifest.id === 'string' && manifest.id && Array.isArray(manifest.tools))
    .filter((manifest) => DOMAIN_BY_ACTIVITY_KIND[manifest.activityKind])
    .filter((manifest) => !seen.has(manifest.id) && (seen.add(manifest.id) || true));
}

function toolForAdapter(tool = {}) {
  return {
    name: String(tool.name || ''),
    title: String(tool.title || tool.name || ''),
    description: String(tool.description || ''),
    inputSchema: tool.inputSchema && typeof tool.inputSchema === 'object'
      ? tool.inputSchema
      : schemaFromSummary(tool.inputSchemaSummary),
    outputSchema: tool.outputSchema && typeof tool.outputSchema === 'object' ? tool.outputSchema : undefined,
    // Registry tier is interpreted by riskForManifest.  Do not trust an MCP's
    // annotations to reduce the effect classification here.
    annotations: {},
  };
}

function schemaFromSummary(summary = {}) {
  const names = Array.isArray(summary.propertyNames) ? summary.propertyNames : [];
  const required = Array.isArray(summary.required) ? summary.required : [];
  return {
    type: 'object',
    properties: Object.fromEntries(names.map((name) => [String(name), {}])),
    required: required.map(String),
    additionalProperties: false,
  };
}

function riskForManifest(manifest) {
  const allowsSandboxWrite = manifest.tools.some((tool) => String(tool?.tier || '') === 'T3');
  return {
    envelopeId: `registry-${createHash('sha256').update(stableManifest(manifest)).digest('hex').slice(0, 24)}`,
    allowedEffects: allowsSandboxWrite ? ['read', 'write'] : ['read'],
    boundaryGrants: [],
  };
}

function createLiveMcpDiscovery({ env, options, transport }) {
  const cache = new Map();
  const discover = typeof options.discover === 'function'
    ? options.discover
    : typeof transport.discover === 'function'
      ? transport.discover
      : (manifest) => discoverExternalMcpServer(manifest, { env });

  async function refresh(manifest) {
    const serverId = String(manifest?.id || '').trim();
    if (!serverId) return null;
    // Unit/in-process transports without an endpoint are intentionally not
    // probed. They retain the registry shape; configured remote MCPs always
    // take the live discovery path below.
    if (!canDiscover(manifest, options, transport)) return null;
    try {
      const result = await discover(manifest);
      if (!result?.ok || !isLiveDiscovery(result)) throw new Error('live MCP discovery failed');
      const value = Object.freeze({
        initializeResult: result.initializeResult,
        toolsResult: result.toolsResult,
      });
      cache.set(serverId, { ok: true, value });
      return value;
    } catch {
      // Do not edit registry state or reuse a stale schema after a failed
      // refresh. The adapter stays connected but exposes no executable tool.
      cache.set(serverId, { ok: false });
      return null;
    }
  }

  async function refreshActive(activities, manifestList) {
    const activeServerIds = new Set((Array.isArray(activities) ? activities : [])
      .filter((activity) => activity?.status === 'active')
      .map((activity) => String(activity?.scope?.serverId || '').trim())
      .filter(Boolean));
    const byId = new Map(manifests(manifestList).map((manifest) => [manifest.id, manifest]));
    await Promise.all([...activeServerIds].map((serverId) => refresh(byId.get(serverId))));
  }

  function forManifest(manifest) {
    const serverId = String(manifest?.id || '').trim();
    const cached = cache.get(serverId);
    if (cached?.ok) return cached.value;
    if (cached && !cached.ok) {
      return {
        initializeResult: { serverInfo: { name: serverId }, capabilities: { tools: {} } },
        toolsResult: { tools: [] },
      };
    }
    return null;
  }

  return Object.freeze({ refresh, refreshActive, forManifest });
}

function canDiscover(manifest, options, transport) {
  return typeof options.discover === 'function'
    || typeof transport.discover === 'function'
    || Boolean(String(manifest?.url || '').trim());
}

function isLiveDiscovery(value) {
  return value?.initializeResult && typeof value.initializeResult === 'object'
    && value?.toolsResult && typeof value.toolsResult === 'object'
    && Array.isArray(value.toolsResult.tools);
}

function stableManifest(manifest) {
  return JSON.stringify({
    id: manifest.id,
    activityKind: manifest.activityKind,
    tools: manifest.tools.map((tool) => ({ name: tool.name, tier: tool.tier })),
  });
}

function normalizeBrokerTransport(value) {
  if (value && typeof value.call === 'function') {
    return {
      available: true,
      call: value.call.bind(value),
      discover: typeof value.discover === 'function' ? value.discover.bind(value) : null,
    };
  }
  return {
    available: false,
    discover: null,
    async call() {
      throw new Error('EXTERNAL_MCP_RUNTIME_BROKER_UNWIRED');
    },
  };
}


function createExternalMcpExperienceProvider({ env, trustedBrokerReceipts }) {
  return Object.freeze({
    getProven(query) {
      // The supervisor has already reduced this to current legal action IDs
      // and digests; the store never receives the live goal or observation.
      return getProvenExternalMcpExperiences(query, { env });
    },
    isTrustedReceipt(receipt) {
      return Boolean(receipt && typeof receipt === 'object' && trustedBrokerReceipts?.has(receipt));
    },
    appendOutcome({ record } = {}) {
      return appendExternalMcpExperience(record, { env });
    },
  });
}

function hasToolsListChanged(result) {
  return Array.isArray(result?.notifications)
    && result.notifications.some((item) => item?.method === 'notifications/tools/list_changed');
}


function createBridgeOwnedBroker({ env, options, store, listManifests, transport, onToolsListChanged, trustedBrokerReceipts }) {
  const sessionIds = new Map();
  const operationContexts = new Map();
  const operationControllers = new Map();
  const rawCall = async (request) => {
    if (!transport.available) return { ok: false, error_code: 'EXTERNAL_MCP_RUNTIME_BROKER_UNWIRED' };
    try {
      const result = await transport.call({
        toolName: request?.tool?.name || '',
        arguments: request?.arguments || {},
        operationId: request?.operationId || '',
        serverId: request?.manifest?.id || '',
        manifest: request?.manifest || {},
        upstreamSessionId: request?.upstreamSessionId || '',
        ...(request?.signal ? { signal: request.signal } : {}),
      });
      if (hasToolsListChanged(result)) {
        Promise.resolve(onToolsListChanged?.(request?.manifest)).catch(() => {});
      }
      if (result?.ok === false) return result;
      if (result?.ok === true && Object.hasOwn(result, 'result')) return result;
      return {
        ok: true,
        result,
        ...(result?.upstreamSessionId ? { upstreamSessionId: result.upstreamSessionId } : {}),
      };
    } catch (error) {
      return { ok: false, error_code: String(error?.code || 'EXTERNAL_MCP_TRANSPORT_FAILED') };
    }
  };
  const router = options.router || createExternalMcpTransportRouter({
    gatewayCall: typeof options.gatewayCall === 'function' ? options.gatewayCall : rawCall,
    directCall: typeof options.directCall === 'function' ? options.directCall : rawCall,
  });
  const service = options.gatewayService || createExternalMcpGatewayService({
    now: options.now,
    listManifests: () => manifests(listManifests()),
    activityStore: store,
    router,
    getSession: (sessionId) => getExternalMcpSession(sessionId, { env }),
    updateSession: (sessionId, patch, sessionOptions) => updateExternalMcpSession(sessionId, patch, { env, ...sessionOptions }),
    appendEvidence: (input) => appendExternalMcpEvidence(input, { env }),
    reconcileOperation: options.reconcileOperation,
  });

  function transportFor({ activity, now, selected } = {}) {
    return {
      async prepare(request = {}) {
        const capability = capabilityFor({
          activity,
          request: { ...request, actionId: request.actionId || selected?.actionId || '' },
          currentTime: now,
          listManifests,
          env,
          sessionIds,
          options,
        });
        return capability ? { sessionId: capability.sessionId } : null;
      },
      async call(request = {}) {
        const response = await invoke(activity, {
          ...request,
          actionId: request.actionId || selected?.actionId || '',
        }, now);
        return bindGenericMcpBrokerResult({
          ...(response?.ok === true && response.result && typeof response.result === 'object' ? response.result : {
            isError: true,
            content: [{ type: 'text', text: '' }],
          }),
        }, response);
      },
    };
  }

  async function invoke(activity, request, currentTime) {
    const capability = capabilityFor({ activity, request, currentTime, listManifests, env, sessionIds, options });
    if (!capability) return { ok: false, outcome: 'unknown', error_code: 'EXTERNAL_MCP_ACTIVITY_CAPABILITY_UNAVAILABLE' };
    const contextKey = operationContextKey(activity.activityId, capability.operationId);
    if (!operationContexts.has(contextKey) && operationContexts.size >= 1_000) {
      operationContexts.delete(operationContexts.keys().next().value);
    }
    operationContexts.set(contextKey, {
      toolName: capability.toolName,
      actionId: capability.actionId,
    });
    const controller = new AbortController();
    const controllers = operationControllers.get(activity.activityId) || new Set();
    controllers.add(controller);
    operationControllers.set(activity.activityId, controllers);
    try {
      const response = await service.invoke({ capability, arguments: request.arguments || {}, signal: controller.signal });
      if (response?.ok === true && response.receipt && typeof response.receipt === 'object') trustedBrokerReceipts?.add(response.receipt);
      return response;
    } catch {
      return { ok: false, outcome: 'unknown', error_code: 'EXTERNAL_MCP_GATEWAY_UNAVAILABLE' };
    } finally {
      controllers.delete(controller);
      if (controllers.size === 0) operationControllers.delete(activity.activityId);
    }
  }

  async function reconcilePending({ activity, pendingOperation, observation, now } = {}) {
    const remembered = operationContexts.get(operationContextKey(activity?.activityId, pendingOperation?.operationId));
    const capability = capabilityFor({
      activity,
      request: {
        operationId: pendingOperation?.operationId,
        actionId: remembered?.actionId || pendingOperation?.actionId,
        toolName: remembered?.toolName || pendingOperation?.toolName,
        arguments: {},
      },
      currentTime: now,
      listManifests,
      env,
      sessionIds,
      options,
    });
    if (!capability || typeof service.reconcile !== 'function') return 'unknown';
    try {
      const result = await service.reconcile({ capability, observation: observation || {} });
      return ['applied', 'not_applied', 'unknown'].includes(result?.outcome) ? result.outcome : 'unknown';
    } catch {
      return 'unknown';
    }
  }

  function abortActivity(activityId) {
    const controllers = operationControllers.get(String(activityId || ''));
    for (const controller of controllers || []) controller.abort();
  }

  function revokeActivity(activityId) {
    const activity = store.get(activityId);
    if (!activity?.actor?.key || !activity?.scope?.serverId) return;
    for (const session of listExternalMcpSessions({ env })) {
      if (session.globalUserId !== activity.actor.key || session.serverId !== activity.scope.serverId) continue;
      closeExternalMcpSession(session.sessionId, {
        env,
        globalUserId: activity.actor.key,
        serverId: activity.scope.serverId,
      });
      sessionIds.delete(`${activity.actor.key}\n${activity.scope.serverId}\ninteractive`);
    }
  }

  return Object.freeze({
    available: transport.available,
    transportFor,
    reconcilePending,
    abortActivity,
    revokeActivity,
  });
}


function operationContextKey(activityId, operationId) {
  return `${String(activityId || '')}\n${String(operationId || '')}`;
}


function capabilityFor({ activity, request, currentTime, listManifests, env, sessionIds, options }) {
  if (!activity?.activityId || !activity?.actor?.key || !activity?.scope?.serverId || !activity?.risk) return null;
  const manifest = manifests(listManifests()).find((item) => item.id === activity.scope.serverId);
  const toolName = String(request?.toolName || '').trim();
  const tool = manifest?.tools?.find((item) => item?.name === toolName);
  if (!manifest || !tool || !toolName) return null;
  const now = validDate(currentTime) || new Date();
  const session = ensureBridgeSession({ activity, env, now, sessionIds });
  if (!session) return null;
  const effect = brokerEffect(tool);
  if (!Array.isArray(activity.risk.allowedEffects) || !activity.risk.allowedEffects.includes(effect)) return null;
  const expiresAt = new Date(now.getTime() + 30_000);
  const operationId = String(request?.operationId || `observe_${digest({ activityId: activity.activityId, revision: activity.revision, toolName, now: now.toISOString() }).slice(0, 32)}`).trim();
  const actionId = String(request?.actionId || `bridge_${digest({ toolName, arguments: request?.arguments || {} }).slice(0, 24)}`).trim();
  try {
    return createBridgeExternalMcpOperationCapability({
      operationId,
      actorKey: activity.actor.key,
      globalUserId: activity.actor.key,
      serverId: activity.scope.serverId,
      toolName,
      sessionId: session.sessionId,
      activityId: activity.activityId,
      actionId,
      activityRevision: activity.revision,
      leaseOwner: activity.leaseOwner || '',
      effect,
      profile: trustedProfile(options?.profile || env.HERMES_EXTERNAL_MCP_PROFILE),
      trigger: 'activity',
      watchScope: activity.scope.resourceId || activity.scope.serverId,
      preferredTransport: 'gateway',
      scope: activity.scope,
      risk: activity.risk,
      arguments: request?.arguments || {},
      scopedGrant: trustExternalMcpScopedGrant({
        grantId: `autonomy_${digest({ activityId: activity.activityId, toolName }).slice(0, 24)}`,
        serverId: activity.scope.serverId,
        toolName,
        mode: session.mode,
        expiresAt: expiresAt.toISOString(),
      }),
      issuedAt: now,
      expiresAt,
    });
  } catch {
    return null;
  }
}


function ensureBridgeSession({ activity, env, now, sessionIds }) {
  const key = `${activity.actor.key}\n${activity.scope.serverId}\ninteractive`;
  const known = sessionIds.get(key);
  const existing = known && getExternalMcpSession(known, {
    env,
    now,
    globalUserId: activity.actor.key,
    serverId: activity.scope.serverId,
  });
  if (existing) return existing;
  const reusable = listExternalMcpSessions({ env, now }).find((session) => (
    session.globalUserId === activity.actor.key
    && session.serverId === activity.scope.serverId
    && session.mode === 'interactive'
  ));
  if (reusable) {
    sessionIds.set(key, reusable.sessionId);
    return reusable;
  }
  const created = openExternalMcpSession({
    globalUserId: activity.actor.key,
    serverId: activity.scope.serverId,
    mode: 'interactive',
    trigger: 'activity',
    ttlMinutes: 30,
    now,
  }, { env, now });
  if (!created?.ok) return null;
  sessionIds.set(key, created.sessionId);
  return created;
}


function brokerEffect(tool) {
  const tier = String(tool?.tier || '').toUpperCase();
  // A T3 sandbox activity has a narrow authorization boundary, not read-only
  // semantics. Its actions must remain non-replayable across transports.
  if (tier === 'T3' && String(tool?.reason || '') === 'sandbox_activity') return 'write';
  return ['T4', 'T5'].includes(tier) ? 'effect' : 'read';
}


function trustedProfile(value) {
  return ['lite', 'full', 'owner_full'].includes(String(value || '').trim().toLowerCase())
    ? String(value).trim().toLowerCase()
    : 'full';
}


function validDate(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? new Date(parsed) : null;
}


function digest(value) {
  return createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}


function stableValue(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(stableValue);
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function boundedInterval(value) {
  const parsed = Number(value || 60_000);
  return Math.min(Math.max(Number.isFinite(parsed) ? parsed : 60_000, 5_000), 15 * 60_000);
}
