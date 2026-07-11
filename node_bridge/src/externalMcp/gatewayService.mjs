import { appendExternalMcpEvidence } from './evidenceLog.mjs';
import { evaluateExternalMcpPolicy } from './policy.mjs';
import {
  createExternalMcpOperationReceipt,
  digestExternalMcpOperationValue,
  getExternalMcpOperationAuthorization,
  isTrustedExternalMcpOperationCapability,
} from './operationReceipt.mjs';

export function createExternalMcpGatewayService(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const listManifests = typeof options.listManifests === 'function' ? options.listManifests : () => [];
  const getSession = typeof options.getSession === 'function' ? options.getSession : () => null;
  const appendEvidence = typeof options.appendEvidence === 'function' ? options.appendEvidence : appendExternalMcpEvidence;

  async function invoke(input = {}) {
    return await execute(input, { retry: false });
  }

  async function retry(input = {}) {
    const capability = input.capability;
    const activity = await checkedActivity(capability, { requirePending: 'not_applied' });
    if (!activity.ok) return activity;
    return await execute(input, { retry: true, activity: activity.activity });
  }

  async function execute(input, { retry: retrying, activity: suppliedActivity } = {}) {
    const capability = input.capability;
    const preflight = await validate(capability, input.arguments, { activity: suppliedActivity });
    if (!preflight.ok) return preflight;
    const { manifest, tool, session, activity } = preflight;
    // The supervisor durably records the operation before dispatch.  That
    // exact trusted operation is the one call allowed through; a different or
    // already-ambiguous pending operation remains non-replayable.
    if (retrying !== true && activity?.pendingOperation && !isPrecommittedOperation(activity.pendingOperation, capability)) {
      return failure('EXTERNAL_MCP_OPERATION_RETRY_BLOCKED');
    }
    if (retrying === true && activity?.pendingOperation?.status !== 'not_applied') return failure('EXTERNAL_MCP_OPERATION_RETRY_BLOCKED');
    const authorization = getExternalMcpOperationAuthorization(capability);
    const policy = evaluateExternalMcpPolicy({
      tool: { ...tool, serverId: capability.serverId }, profile: capability.profile, sessionMode: session.mode, trigger: capability.trigger,
      scopedGrant: authorization.scopedGrant, pendingAction: authorization.pendingAction, now: now(),
      serverId: capability.serverId,
    });
    if (!policy.allowed) return failure('EXTERNAL_MCP_POLICY_DENIED', { policy });

    let activeActivity = activity;
    // The supervisor commits its operation before dispatch while holding the
    // lease. In that path this gateway must not touch the same record: even a
    // semantically identical CAS bumps the revision and makes the supervisor
    // lose its checkpoint/evidence commit. Direct callers still get a durable
    // pending record owned by this gateway.
    const gatewayOwnsPending = Boolean(activeActivity
      && capability.effect !== 'read'
      && !isPrecommittedOperation(activeActivity.pendingOperation, capability));
    if (gatewayOwnsPending) {
      const pending = pendingOperation(capability, 'pending', now(), null, input.arguments);
      const saved = cas(activeActivity, { pendingOperation: pending });
      if (!saved.ok) return failure('EXTERNAL_MCP_ACTIVITY_STALE_REVISION');
      activeActivity = saved.activity;
    }

    const routed = await options.router?.execute({
      effect: capability.effect,
      operationId: capability.operationId,
      manifest,
      tool,
      arguments: input.arguments,
      session,
      scopeDigest: capability.scopeDigest,
      riskDigest: capability.riskDigest,
      upstreamSessionId: session.upstreamSessionId || '',
      evidenceContext: { watchScope: capability.watchScope, tier: tool.tier },
      preferredTransport: capability.preferredTransport,
      signal: input.signal,
    });
    if (!routed?.ok) {
      const outcome = routed?.outcome === 'not_applied' ? 'not_applied' : 'unknown';
      const needsReconciliation = outcome === 'unknown' && capability.effect !== 'read';
      if (gatewayOwnsPending) {
        const saved = cas(activeActivity, {
          pendingOperation: pendingOperation(capability, outcome, now(), activeActivity.pendingOperation, input.arguments),
        });
        if (!saved.ok) return failure('EXTERNAL_MCP_ACTIVITY_STALE_REVISION');
      }
      return { ok: false, outcome, needsReconciliation, error_code: routed?.errorCode || routed?.error_code || 'EXTERNAL_MCP_OPERATION_FAILED' };
    }
    let evidence;
    try {
      evidence = appendEvidence({
        globalUserId: capability.globalUserId, serverId: capability.serverId, toolName: capability.toolName,
        watchScope: capability.watchScope, tier: tool.tier, sessionMode: session.mode, trigger: capability.trigger,
        decision: 'allow', status: 'success', result: routed.result,
      });
    } catch {
      return { ok: false, outcome: capability.effect === 'read' ? 'unknown' : 'unknown', needsReconciliation: capability.effect !== 'read', error_code: 'EXTERNAL_MCP_EVIDENCE_APPEND_FAILED' };
    }
    if (gatewayOwnsPending) {
      const saved = cas(activeActivity, { pendingOperation: null });
      if (!saved.ok) return failure('EXTERNAL_MCP_ACTIVITY_STALE_REVISION');
    }
    const receipt = createExternalMcpOperationReceipt(capability, {
      outcome: 'applied', transport: routed.route || capability.preferredTransport || 'gateway',
      evidenceRef: evidence.evidence_ref || evidence.evidenceRef, result: routed.result, now: now(),
    });
    if (routed.upstreamSessionId && typeof options.updateSession === 'function') {
      options.updateSession(session.sessionId, { upstreamSessionId: routed.upstreamSessionId }, {
        globalUserId: session.globalUserId,
        serverId: session.serverId,
        now: now(),
      });
    }
    return { ok: true, result: routed.result, receipt, attempts: routed.attempts || [] };
  }

  async function reconcile(input = {}) {
    const capability = input.capability;
    const activityResult = await checkedActivity(capability, { requirePending: true });
    if (!activityResult.ok) return activityResult;
    const activity = activityResult.activity;
    const outcome = normalizeOutcome(await options.reconcileOperation?.({ capability, activity, observation: input.observation || {} }));
    const saved = cas(activity, { pendingOperation: pendingOperation(capability, outcome, now()) });
    if (!saved.ok) return failure('EXTERNAL_MCP_ACTIVITY_STALE_REVISION');
    return { ok: true, outcome };
  }

  async function checkedActivity(capability, { requirePending } = {}) {
    const result = await validate(capability, undefined, { argumentsOptional: true });
    if (!result.ok) return result;
    if (!result.activity) return failure('EXTERNAL_MCP_ACTIVITY_CONTEXT_MISMATCH');
    if (requirePending && result.activity.pendingOperation?.operationId !== capability.operationId) {
      return failure('EXTERNAL_MCP_OPERATION_RETRY_BLOCKED');
    }
    if (typeof requirePending === 'string' && result.activity.pendingOperation?.status !== requirePending) {
      return failure('EXTERNAL_MCP_OPERATION_RETRY_BLOCKED');
    }
    return { ok: true, activity: result.activity };
  }

  async function validate(capability, argumentsValue, { activity: suppliedActivity, argumentsOptional = false } = {}) {
    if (!isTrustedExternalMcpOperationCapability(capability, { now: now() })) return failure('EXTERNAL_MCP_OPERATION_CAPABILITY_REQUIRED');
    if (!argumentsOptional && digestExternalMcpOperationValue(argumentsValue || {}) !== capability.argumentsDigest) {
      return failure('EXTERNAL_MCP_OPERATION_ARGUMENTS_MISMATCH');
    }
    const manifest = listManifests().find((item) => item?.id === capability.serverId);
    const tool = manifest?.tools?.find((item) => item?.name === capability.toolName);
    if (!manifest || !tool) return failure('EXTERNAL_MCP_TOOL_NOT_FOUND');
    const session = getSession(capability.sessionId);
    if (!session || session.globalUserId !== capability.globalUserId || session.serverId !== capability.serverId || session.status !== 'active') {
      return failure('EXTERNAL_MCP_SESSION_NOT_FOUND');
    }
    if (!Array.isArray(capability.risk?.allowedEffects) || !capability.risk.allowedEffects.includes(capability.effect)
      || capability.scope?.serverId !== capability.serverId || !effectMatchesTool(capability.effect, tool)) {
      return failure('EXTERNAL_MCP_ACTIVITY_CONTEXT_MISMATCH');
    }
    let activity = suppliedActivity || null;
    if (capability.activityId) {
      activity = activity || options.activityStore?.get(capability.activityId);
      if (!activity || activity.status !== 'active' || activity.actor?.key !== capability.actorKey
        || activity.revision !== capability.activityRevision
        || digestExternalMcpOperationValue(activity.scope) !== capability.scopeDigest
        || digestExternalMcpOperationValue(activity.risk) !== capability.riskDigest
        || String(activity.leaseOwner || '') !== capability.leaseOwner) {
        return failure('EXTERNAL_MCP_ACTIVITY_CONTEXT_MISMATCH');
      }
    }
    return { ok: true, manifest, tool, session, activity };
  }

  function diagnose(input = {}) {
    const manifest = listManifests().find((item) => item?.id === input.serverId);
    const tool = manifest?.tools?.find((item) => item?.name === input.toolName);
    if (!manifest || !tool) return failure('EXTERNAL_MCP_TOOL_NOT_FOUND');
    return { ok: true, trusted: false, executable: false, serverId: manifest.id, toolName: tool.name, tier: tool.tier };
  }

  function cas(activity, patch) {
    const result = options.activityStore?.compareAndSwap?.(activity.activityId, {
      expectedRevision: activity.revision,
      leaseOwner: activity.leaseOwner || '',
      patch,
    });
    return result && result.ok ? result : { ok: false };
  }

  return { invoke, retry, reconcile, diagnose };
}

function pendingOperation(capability, status, now, existing = null, argumentsValue = undefined) {
  const stamp = (now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date()).toISOString();
  return {
    operationId: capability.operationId,
    actionId: capability.actionId,
    toolName: capability.toolName,
    effect: capability.effect,
    arguments: safeArguments(argumentsValue === undefined ? existing?.arguments || {} : argumentsValue),
    sessionId: capability.sessionId,
    status, startedAt: existing?.startedAt || stamp, updatedAt: stamp,
  };
}

function safeArguments(value) {
  try {
    const cloned = structuredClone(value && typeof value === 'object' && !Array.isArray(value) ? value : {});
    return JSON.stringify(cloned).length <= 32_768 ? cloned : {};
  } catch {
    return {};
  }
}

function effectMatchesTool(effect, tool) {
  const tier = String(tool?.tier || '').toUpperCase();
  // Tier and effect answer different questions. T3 sandbox-game tools are
  // authorized within their narrow scoped grant, but `play` still changes the
  // remote game state. Treating it as a read here would let the transport
  // retry it on an alternate route after an ambiguous failure.
  if (tier === 'T3' && String(tool?.reason || '') === 'sandbox_activity') return effect === 'write';
  return ['T4', 'T5'].includes(tier) ? effect === 'effect' : effect === 'read';
}

function normalizeOutcome(value) {
  const outcome = String(value || '').toLowerCase();
  return ['applied', 'not_applied', 'unknown'].includes(outcome) ? outcome : 'unknown';
}

function isPrecommittedOperation(pending, capability) {
  return pending?.status === 'pending'
    && pending.operationId === capability.operationId
    && pending.actionId === capability.actionId;
}

function failure(error_code, extra = {}) {
  return { ok: false, error_code, ...extra };
}
