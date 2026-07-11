import { createHash, randomBytes } from 'node:crypto';

import { createGenericMcpAdapter } from './genericAdapter.mjs';
import { buildExternalMcpNarrationCandidate } from './narrator.mjs';
import { createExternalMcpPlanner } from './planner.mjs';


const TERMINAL_STATUSES = new Set(['completed', 'stopped', 'expired']);
const BOUNDARY_SUMMARY = 'Scope widening requires an owner boundary.';
const TRUSTED_BOUNDARY_APPROVALS = new WeakMap();


// This opaque object is intended for the bridge after it has obtained an
// owner-boundary decision. JSON/model data cannot reproduce WeakMap identity.
// Keeping only the object on the command avoids exposing scope/risk data to the
// reply envelope itself.
export function mintTrustedExternalMcpBoundaryApproval(input = {}) {
  const actor = normalizedFacadeActor(input);
  const activityId = cleanId(input.activityId);
  const newScope = normalizeResolvedScope(input.newScope);
  const newRisk = normalizeRisk(input.newRisk);
  if (!actor || !activityId || !newScope || !newRisk) {
    throw new TypeError('trusted boundary approval is invalid');
  }
  const token = Object.freeze({});
  TRUSTED_BOUNDARY_APPROVALS.set(token, deepFreeze({ actor, activityId, newScope, newRisk }));
  return token;
}


export function createExternalMcpAutonomySupervisor(options = {}) {
  const store = options.store;
  if (!store) throw new TypeError('activity store is required');
  const planner = options.planner || createExternalMcpPlanner(options.plannerConfig || {});
  const adapterResolver = typeof options.adapterResolver === 'function'
    ? options.adapterResolver
    : ({ input }) => createGenericMcpAdapter(input?.discovery || options.discovery || {});
  const narrate = typeof options.narrator === 'function'
    ? options.narrator
    : buildExternalMcpNarrationCandidate;
  const submitCandidate = typeof options.submitCandidate === 'function' ? options.submitCandidate : null;
  // This boundary is intentionally injected by the runtime.  The facade only
  // carries natural language plus the already-attached trusted actor; it never
  // supplies a server, scope, risk envelope, or transport choice.
  const resolveCommitInput = typeof options.resolveCommitInput === 'function'
    ? options.resolveCommitInput
    : null;
  const experienceProvider = options.experienceProvider || null;
  const transport = options.transport;
  const transportFor = typeof options.transportFor === 'function' ? options.transportFor : () => transport;
  const reconcilePending = typeof options.reconcilePending === 'function' ? options.reconcilePending : null;
  const createCoreJob = typeof options.createCoreJob === 'function' ? options.createCoreJob : null;
  const queryCoreJob = typeof options.queryCoreJob === 'function' ? options.queryCoreJob : null;
  const terminalizeCoreJob = typeof options.terminalizeCoreJob === 'function' ? options.terminalizeCoreJob : null;
  const abortActivity = typeof options.abortActivity === 'function' ? options.abortActivity : null;
  const revokeActivity = typeof options.revokeActivity === 'function' ? options.revokeActivity : null;
  const runnerId = cleanId(options.runnerId) || `runner_${randomBytes(8).toString('hex')}`;
  const clock = typeof options.now === 'function' ? options.now : () => new Date();
  const tickIntervalMs = positiveInt(options.tickIntervalMs, 30_000);
  const leaseMs = Math.min(positiveInt(options.leaseMs, 30_000), 5 * 60_000);
  const maxActivityMs = positiveInt(options.maxActivityMs, 4 * 60 * 60_000);
  const maxDuePerScan = Math.min(positiveInt(options.maxDuePerScan, 20), 100);

  function now(value) {
    const current = value instanceof Date ? value : value ? new Date(value) : clock();
    if (!(current instanceof Date) || !Number.isFinite(current.getTime())) throw new TypeError('valid current time is required');
    return current;
  }

  function resolveAdapter(context) {
    const adapter = adapterResolver(context);
    if (!adapter || typeof adapter.resolveScope !== 'function') throw new Error('external MCP adapter is unavailable');
    return adapter;
  }

  function startOrResume(input = {}) {
    const currentTime = now(input.now);
    const identity = normalizedIdentity(input);
    const goal = normalizeGoal(input.goal);
    if (!identity || !goal) return failure('invalid autonomy activity identity or goal', 'EXTERNAL_MCP_AUTONOMY_START_INVALID');
    const goalDigest = digest(normalizedGoalForDigest(goal));
    const activityId = `autonomy_${digest({
      actor: identity.actor,
      conversation: identity.conversation,
      domain: identity.domain,
      goalDigest,
    }).slice(0, 32)}`;
    const existing = store.get(activityId, { now: currentTime });
    if (existing) {
      if (existing.status === 'paused' && existing.checkpoint.summary === BOUNDARY_SUMMARY) {
        return activityResult(existing, 'needs_boundary', { deduped: true });
      }
      if (existing.status === 'active') return activityResult(existing, 'resumed', { deduped: true });
      if (existing.status === 'blocked') {
        const resumed = store.compareAndSwap(activityId, {
          expectedRevision: existing.revision,
          patch: { status: 'active', nextWake: currentTime.toISOString() },
          now: currentTime,
        });
        return resumed.ok ? activityResult(resumed.activity, 'resumed', { deduped: true }) : resumed;
      }
      return activityResult(existing, existing.status, { deduped: true });
    }

    let adapter;
    let resolved;
    try {
      adapter = resolveAdapter({ activity: null, input });
      resolved = adapter.resolveScope(goal, input.manifest || {}, input.trustedContext || {});
    } catch {
      return failure('external MCP scope resolution failed', 'EXTERNAL_MCP_AUTONOMY_SCOPE_FAILED');
    }
    const scope = normalizeResolvedScope(resolved);
    const risk = normalizeRisk(input.risk);
    if (!scope || !risk || resolved.constraints?.includes('scope_not_trusted')) {
      return failure('external MCP scope needs an owner boundary', 'EXTERNAL_MCP_AUTONOMY_NEEDS_BOUNDARY');
    }
    const created = store.create({
      activityId,
      actor: { key: digest(`${identity.actor}\n${identity.conversation}`), kind: cleanId(input.actorKind) || 'owner' },
      domain: identity.domain,
      driverId: cleanId(adapter.descriptor?.adapterId) || 'generic-mcp-adapter',
      goal: { text: goal.text, constraints: goal.constraints },
      scope,
      risk,
      status: 'active',
      checkpoint: { stateDigest: '', summary: '', terminal: false, evidenceRefs: [], updatedAt: null },
      pendingOperation: null,
      nextWake: currentTime.toISOString(),
      notifyTarget: input.notifyTarget || null,
    }, { now: currentTime });
    return created.ok ? activityResult(created.activity, 'started', { deduped: false }) : created;
  }

  function adjust(activityId, input = {}) {
    const currentTime = now(input.now);
    const activity = store.get(activityId, { now: currentTime });
    if (!activity) return failure('activity not found', 'EXTERNAL_MCP_ACTIVITY_NOT_FOUND');
    if (TERMINAL_STATUSES.has(activity.status)) return activityResult(activity, activity.status, { deduped: true });
    const adjusted = store.adjustScope(activity.activityId, {
      expectedRevision: activity.revision,
      newScope: input.newScope,
      ...(Object.hasOwn(input, 'newRisk') ? { newRisk: input.newRisk } : {}),
      now: currentTime,
    });
    if (adjusted.ok) return activityResult(adjusted.activity, 'adjusted', { deduped: adjusted.idempotent === true });
    if (adjusted.error_code !== 'EXTERNAL_MCP_ACTIVITY_SCOPE_WIDENING_REQUIRES_BOUNDARY') return adjusted;
    if (activity.status === 'paused' && activity.checkpoint.summary === BOUNDARY_SUMMARY) {
      return activityResult(activity, 'needs_boundary', { deduped: true });
    }
    const paused = store.compareAndSwap(activity.activityId, {
      expectedRevision: activity.revision,
      patch: {
        status: 'paused',
        checkpoint: checkpoint(BOUNDARY_SUMMARY, 'paused', currentTime, false),
        nextWake: null,
      },
      now: currentTime,
    });
    return paused.ok ? activityResult(paused.activity, 'needs_boundary', { deduped: false }) : paused;
  }

  function stop(activityId, input = {}) {
    const currentTime = now(input.now);
    const activity = store.get(activityId, { now: currentTime });
    if (!activity) return failure('activity not found', 'EXTERNAL_MCP_ACTIVITY_NOT_FOUND');
    if (activity.status === 'stopped') return activityResult(activity, 'stopped', { deduped: true });
    if (TERMINAL_STATUSES.has(activity.status)) return activityResult(activity, activity.status, { deduped: true });
    const stopped = store.stop(activity.activityId, {
      expectedRevision: activity.revision,
      reason: cleanText(input.reason, 200),
      now: currentTime,
    });
    if (stopped.ok) schedulePostStop([activity.activityId]);
    return stopped.ok ? activityResult(stopped.activity, 'stopped', { deduped: false }) : stopped;
  }

  function bindNotifyTarget(activityId, input = {}) {
    const activity = ownedActivity(activityId, input.actorContext);
    const notifyTarget = normalizeNotifyTarget(input.target);
    if (!activity || !notifyTarget || TERMINAL_STATUSES.has(activity.status)) {
      return failure('trusted notification target is unavailable', 'EXTERNAL_MCP_NOTIFY_TARGET_INVALID');
    }
    const bound = store.compareAndSwap(activity.activityId, {
      expectedRevision: activity.revision,
      patch: { notifyTarget },
    });
    return bound.ok ? { ok: true, activity: bound.activity } : bound;
  }

  function schedulePostStop(activityIds) {
    for (const activityId of [...new Set(activityIds.map(cleanId).filter(Boolean))]) {
      for (const callback of [abortActivity, revokeActivity]) {
        if (!callback) continue;
        try {
          Promise.resolve(callback(activityId)).catch(() => {});
        } catch {}
      }
    }
  }

  async function tick(activityId, tickOptions = {}) {
    const currentTime = now(tickOptions.now);
    const initial = store.get(activityId, { now: currentTime });
    if (!initial) return { ok: false, activityId: cleanId(activityId), status: 'missing' };
    if (TERMINAL_STATUSES.has(initial.status)) return tickResult(initial, initial.status, null);
    if (initial.status !== 'active') return tickResult(initial, initial.status, null);

    const leased = store.acquireLease(initial.activityId, {
      expectedRevision: initial.revision,
      leaseOwner: runnerId,
      leaseMs,
      now: currentTime,
    });
    if (!leased.ok) return {
      ok: true,
      activityId: initial.activityId,
      status: 'skipped',
      reason: 'lease_unavailable',
      error_code: leased.error_code,
    };
    let activity = store.get(initial.activityId, { now: currentTime });
    if (!ownsActiveLease(activity, leased.activity.revision, currentTime, runnerId)) return raceResult(activity, initial.activityId);

    if (isBudgetExpired(activity, currentTime, maxActivityMs)) {
      return await commitOutcome(activity, {
        status: 'expired',
        summary: 'Activity time budget expired.',
        currentTime,
        receipt: { effect: 'supervisor', outcome: 'expired', terminal: false },
      });
    }

    let adapter;
    let observation;
    try {
      adapter = resolveAdapter({ activity, input: tickOptions });
      observation = await adapter.observe(activity.scope, { lastResult: activity.checkpoint.summary }, transportFor({
        activity,
        phase: 'observe',
        now: currentTime,
      }));
    } catch {
      return await commitOutcome(activity, {
        status: 'blocked',
        summary: 'The bounded observation step failed.',
        currentTime,
        receipt: { effect: 'observe', outcome: 'failed', terminal: false },
      });
    }
    activity = store.get(activity.activityId, { now: currentTime });
    if (!ownsActiveLease(activity, leased.activity.revision, currentTime, runnerId)) return raceResult(activity, initial.activityId);

    if (activity.pendingOperation) {
      let reconciliation = 'unknown';
      try {
        reconciliation = reconcilePending
          ? await reconcilePending({ activity, pendingOperation: activity.pendingOperation, observation, now: currentTime })
          : adapter.reconcile(activity.pendingOperation.operationId, observation);
      } catch {
        reconciliation = 'unknown';
      }
      // A bridge reconciliation may have durably updated pendingOperation.
      // Reload its CAS revision before committing the terminal decision.
      activity = store.get(activity.activityId, { now: currentTime });
      if (!ownsActiveLease(activity, activity?.revision, currentTime, runnerId)) return raceResult(activity, initial.activityId);
      if (reconciliation === 'unknown') {
        return await commitOutcome(activity, {
          status: 'blocked',
          summary: 'The previous operation outcome remains unknown.',
          currentTime,
          pendingOperation: { ...activity.pendingOperation, status: 'unknown', updatedAt: currentTime.toISOString() },
          receipt: { effect: activity.pendingOperation.effect, outcome: 'unknown', terminal: false },
        });
      }
      if (reconciliation === 'applied') {
        return await commitOutcome(activity, {
          status: 'active',
          summary: 'The previous operation was reconciled as applied.',
          currentTime,
          pendingOperation: null,
          receipt: { effect: activity.pendingOperation.effect, outcome: 'applied', terminal: false },
        });
      }
      return await commitOutcome(activity, {
        status: 'blocked',
        summary: 'The previous operation was confirmed not applied and requires a fresh bounded action.',
        currentTime,
        pendingOperation: { ...activity.pendingOperation, status: 'not_applied', updatedAt: currentTime.toISOString() },
        receipt: { effect: activity.pendingOperation.effect, outcome: 'not_applied', terminal: false },
      });
    }

    const resolved = adapter.resolveScope(
      { ...activity.goal, resourceId: activity.scope.resourceId, parameters: activity.scope.parameters },
      { id: activity.scope.serverId },
      { allowedResourceIds: [activity.scope.resourceId] },
    );
    if (!sameScope(activity.scope, resolved) || resolved.constraints?.includes('scope_not_trusted')) {
      return await commitOutcome(activity, {
        status: 'blocked',
        summary: 'The resolved resource scope no longer matches the committed scope.',
        currentTime,
        receipt: { effect: 'scope', outcome: 'failed', terminal: false },
      });
    }

    const observedClassification = adapter.classify(activity.goal, observation, { outcome: 'observed' });
    if (isTypedCompletion(adapter, observation, observedClassification)) {
      return await commitOutcome(activity, {
        status: 'completed',
        summary: observationSummary(observation) || 'Typed terminal state reached.',
        currentTime,
        receipt: { effect: 'terminal', outcome: 'completed', terminal: true },
        claim: 'completed',
      });
    }

    const legalActions = adapter.legalActions(activity.goal, observation, activity.risk);
    const availableActions = legalActions.filter((item) => item.availability === 'available');
    if (availableActions.length === 0) {
      const needsBoundary = legalActions.some((item) => item.availability === 'needs_boundary');
      return await commitOutcome(activity, {
        status: needsBoundary ? 'paused' : 'blocked',
        summary: needsBoundary ? 'The next effect requires an owner boundary.' : 'No legal bounded action is available.',
        currentTime,
        receipt: { effect: 'planner', outcome: needsBoundary ? 'needs_boundary' : 'blocked', terminal: false },
      });
    }
    // Experience is advisory only.  Build its query after the live adapter has
    // constrained the action set, and pass hashes rather than its raw state.
    const experienceContext = experienceQuery(activity, observation, availableActions);
    const experiences = await provenExperiences(experienceProvider, experienceContext);
    activity = store.get(activity.activityId, { now: currentTime });
    if (!ownsActiveLease(activity, leased.activity.revision, currentTime, runnerId)) return raceResult(activity, initial.activityId);
    const decision = await planner.chooseAction({
      objective: activity.goal,
      observation,
      experiences,
      legalActions,
    });
    activity = store.get(activity.activityId, { now: currentTime });
    if (!ownsActiveLease(activity, leased.activity.revision, currentTime, runnerId)) return raceResult(activity, initial.activityId);
    const selected = availableActions.find((item) => item.actionId === decision?.actionId);
    if (!selected) {
      return await commitOutcome(activity, {
        status: 'blocked',
        summary: 'The planner did not select one legal bounded action.',
        currentTime,
        receipt: { effect: 'planner', outcome: 'blocked', terminal: false },
      });
    }

    const operationId = `operation_${digest({ activityId: activity.activityId, revision: activity.revision, actionId: selected.actionId }).slice(0, 32)}`;
    const native = typeof adapter.operationContext === 'function' ? adapter.operationContext(selected.actionId) : null;
    const preparationTransport = transportFor({
      activity,
      phase: 'execute',
      selected,
      operationId,
      now: currentTime,
    });
    let prepared = null;
    try {
      prepared = typeof preparationTransport?.prepare === 'function'
        ? await preparationTransport.prepare({
          toolName: native?.toolName || selected.toolName || 'unknown',
          arguments: native?.arguments || {}, operationId, actionId: selected.actionId,
        })
        : null;
    } catch {}
    const pendingOperation = {
      operationId,
      actionId: selected.actionId,
      toolName: native?.toolName || selected.toolName || 'unknown',
      effect: selected.effect || 'unknown',
      arguments: native?.arguments || {},
      sessionId: prepared?.sessionId || 'pending',
      status: 'pending',
      startedAt: currentTime.toISOString(),
      updatedAt: currentTime.toISOString(),
    };
    const pendingCommit = store.commitCallback(activity.activityId, {
      expectedRevision: activity.revision,
      leaseOwner: runnerId,
      patch: { pendingOperation, nextWake: null },
      now: currentTime,
    });
    if (!pendingCommit.ok) return raceResult(store.get(activity.activityId, { now: currentTime }), activity.activityId);
    activity = pendingCommit.activity;
    const executionTransport = transportFor({
      activity,
      phase: 'execute',
      selected,
      operationId,
      now: currentTime,
    });

    let receipt;
    try {
      receipt = await adapter.execute(selected.actionId, operationId, executionTransport);
    } catch {
      receipt = {
        effect: selected.effect || 'unknown',
        outcome: 'unknown',
        evidence: null,
        observation,
      };
    }
    const classification = adapter.classify(activity.goal, receipt.observation || observation, receipt);
    let status = 'active';
    if (receipt.outcome === 'unknown' || receipt.outcome === 'failed') status = 'blocked';
    else if (receipt.outcome === 'needs_boundary') status = 'paused';
    else if (isTypedCompletion(adapter, receipt.observation || observation, classification)) status = 'completed';
    const summary = receiptSummary(receipt) || observationSummary(receipt.observation || observation) || 'Bounded activity checkpoint committed.';
    return await commitOutcome(activity, {
      status,
      summary,
      currentTime,
      receipt,
      pendingOperation: receipt.outcome === 'unknown'
        ? { ...pendingOperation, status: 'unknown', updatedAt: currentTime.toISOString() }
        : null,
      claim: status === 'completed' ? 'completed' : '',
      experience: { context: experienceContext, selected },
    });
  }

  async function commitOutcome(activity, {
    status,
    summary,
    currentTime,
    receipt,
    pendingOperation = null,
    claim = '',
    experience = null,
  }) {
    const nextWake = status === 'active'
      ? new Date(currentTime.getTime() + tickIntervalMs).toISOString()
      : null;
    const committed = store.commitCallback(activity.activityId, {
      expectedRevision: activity.revision,
      leaseOwner: runnerId,
      patch: {
        status,
        checkpoint: checkpoint(summary, status, currentTime, status === 'completed', receipt),
        pendingOperation,
        nextWake,
      },
      now: currentTime,
    });
    if (!committed.ok) return raceResult(store.get(activity.activityId, { now: currentTime }), activity.activityId);
    let finalActivity = committed.activity;
    if (isCoreTerminalStatus(finalActivity.status)) {
      finalActivity = await terminalizeActivityCore(finalActivity, finalActivity.status, currentTime);
      if (!finalActivity) {
        return {
          ok: false,
          activityId: activity.activityId,
          status: finalActivity?.status || status,
          candidate: null,
          error_code: 'EXTERNAL_MCP_AUTONOMY_CORE_JOB_TERMINAL_FAILED',
        };
      }
    }
    if (!TERMINAL_STATUSES.has(finalActivity.status)) {
      const released = store.releaseLease(finalActivity.activityId, {
        expectedRevision: finalActivity.revision,
        leaseOwner: runnerId,
        now: currentTime,
      });
      if (released.ok) finalActivity = released.activity;
    }
    const candidate = narrate({
      claim,
      facts: [{ verified: true, summary }],
      receiptSummaries: receipt ? [{
        verified: true,
        effect: receipt.effect || 'unknown',
        outcome: receipt.outcome || status,
        terminal: status === 'completed',
        summary,
      }] : [],
    });
    if (candidate?.status === 'ready' && submitCandidate) {
      await submitCandidate(candidate, {
        activityId: finalActivity.activityId,
        checkpointDigest: finalActivity.checkpoint.stateDigest,
        notifyTarget: finalActivity.notifyTarget,
        revision: finalActivity.revision,
      });
    }
    await appendProvenExperience(experienceProvider, {
      activity: finalActivity,
      receipt,
      checkpoint: finalActivity.checkpoint,
      experience,
      status,
      currentTime,
    });
    return tickResult(finalActivity, status, candidate?.status === 'ready' ? candidate : null);
  }

  async function scanDue(scanOptions = {}) {
    const currentTime = now(scanOptions.now);
    const limit = Math.min(positiveInt(scanOptions.limit, maxDuePerScan), maxDuePerScan);
    for (const activity of store.list({ now: currentTime })) {
      if (isCoreTerminalStatus(activity.status) && coreReceiptNeedsTerminalization(activity.coreJobReceipt, activity.status)) {
        await terminalizeActivityCore(activity, activity.status, currentTime);
      }
    }
    const due = store.list({ now: currentTime })
      .filter((activity) => activity.status === 'active'
        && (isBudgetExpired(activity, currentTime, maxActivityMs)
          || !activity.nextWake
          || Date.parse(activity.nextWake) <= currentTime.getTime()))
      .slice(0, limit);
    const results = [];
    for (const activity of due) results.push(await tick(activity.activityId, { now: currentTime }));
    return { ok: true, processed: results.length, results };
  }

  async function listActivities(input = {}) {
    const identity = normalizedFacadeActor(input);
    if (!identity) return [];
    const actorHash = activityActorHash(identity.actorKey, identity.conversationKey);
    return store.list()
      .filter((activity) => activity.actor?.key === actorHash)
      .map((activity) => facadeActivity(activity, identity))
      .filter(Boolean);
  }

  async function commit(command = {}) {
    const request = normalizeFacadeCommit(command);
    if (!request) return commitFailure('EXTERNAL_MCP_AUTONOMY_COMMIT_INVALID');
    const currentTime = now();

    // Stop never needs discovery, scope resolution, or a currently reachable
    // provider. Its durable state transition must remain available precisely
    // when that surrounding runtime is degraded.
    if (request.action === 'stop_all') {
      const stopped = store.stopAllForActor({
        actorKey: activityActorHash(request.actorContext.actorKey, request.actorContext.conversationKey),
      });
      if (!stopped?.ok || !stopped.aggregate) return commitFailure(stopped?.error_code || 'EXTERNAL_MCP_AUTONOMY_COMMIT_STOP_FAILED');
      schedulePostStop(stopped.aggregate.activityIds);
      const terminalized = [];
      for (const activity of stopped.activities) {
        const updated = await terminalizeActivityCore(activity, 'stopped', now());
        if (!updated) return commitFailure('EXTERNAL_MCP_AUTONOMY_COMMIT_STOP_FAILED');
        terminalized.push(updated);
      }
      return committedAggregateFacadeResult({ ...stopped, activities: terminalized }, request.selection);
    }
    if (request.action === 'stop') {
      const activity = ownedActivity(request.activityId, request.actorContext);
      if (!activity) return commitFailure('EXTERNAL_MCP_AUTONOMY_COMMIT_ACTIVITY_FORBIDDEN');
      const result = stop(activity.activityId);
      if (!result?.ok || result.status !== 'stopped') return commitFailure(result?.error_code || 'EXTERNAL_MCP_AUTONOMY_COMMIT_STOP_FAILED');
      const terminalized = await terminalizeActivityCore(store.get(activity.activityId), 'stopped', currentTime);
      return terminalized
        ? committedFacadeResult(terminalized, request.selection)
        : commitFailure('EXTERNAL_MCP_AUTONOMY_COMMIT_STOP_FAILED');
    }

    if (!resolveCommitInput) return commitFailure('EXTERNAL_MCP_AUTONOMY_COMMIT_RESOLVER_UNAVAILABLE');

    let resolved;
    try {
      resolved = await resolveCommitInput(deepFreeze(cloneValue(request)));
    } catch {
      return commitFailure('EXTERNAL_MCP_AUTONOMY_COMMIT_RESOLUTION_FAILED');
    }
    if (!isCommitRuntimeContext(resolved)) return commitFailure('EXTERNAL_MCP_AUTONOMY_COMMIT_RESOLUTION_FAILED');

    if (request.action === 'start') {
      // Never spread resolver identity: a runtime resolver is allowed to supply
      // discovery/risk context, but the facade's trusted actor remains sole
      // authority for the activity identity.
      const resolvedGoal = normalizeGoal(resolved.goal);
      if (!resolvedGoal || facadeGoalDigest(resolvedGoal.text) !== request.selection.goalDigest) {
        return commitFailure('EXTERNAL_MCP_AUTONOMY_COMMIT_GOAL_MISMATCH');
      }
      const result = startOrResume({
        ...resolved,
        actorKey: request.actorContext.actorKey,
        conversationKey: request.actorContext.conversationKey,
        domain: request.selection.domain,
      });
      if (!result?.ok || result.status !== 'started' && result.status !== 'resumed') {
        return commitFailure(result?.error_code || 'EXTERNAL_MCP_AUTONOMY_COMMIT_START_FAILED');
      }
      const activity = await ensureActiveCoreJob(store.get(result.activityId), request.selection, currentTime);
      if (!activity) blockUncommittedActivity(store.get(result.activityId), currentTime);
      return activity
        ? committedFacadeResult(activity, request.selection)
        : commitFailure('EXTERNAL_MCP_AUTONOMY_COMMIT_START_FAILED');
    }

    const activity = ownedActivity(request.activityId, request.actorContext);
    if (!activity) return commitFailure('EXTERNAL_MCP_AUTONOMY_COMMIT_ACTIVITY_FORBIDDEN');
    if (request.action === 'adjust') {
      if (!isPlainObject(resolved.newScope)) return commitFailure('EXTERNAL_MCP_AUTONOMY_COMMIT_RESOLUTION_FAILED');
      const result = adjust(activity.activityId, {
        newScope: resolved.newScope,
        ...(Object.hasOwn(resolved, 'newRisk') ? { newRisk: resolved.newRisk } : {}),
      });
      if (!result?.ok || result.status !== 'adjusted') {
        return commitFailure(result?.error_code || 'EXTERNAL_MCP_AUTONOMY_COMMIT_ADJUST_FAILED');
      }
      return committedFacadeResult(store.get(activity.activityId), request.selection);
    }
    if (request.action === 'resume') {
      if (TERMINAL_STATUSES.has(activity.status)) return commitFailure('EXTERNAL_MCP_AUTONOMY_COMMIT_ACTIVITY_TERMINAL');
      let current = activity;
      if (current.status === 'paused' && current.checkpoint?.summary === BOUNDARY_SUMMARY) {
        const approval = trustedBoundaryApproval(request.approvedBoundary, current, request.actorContext);
        if (!isPlainObject(resolved.newScope) || !Object.hasOwn(resolved, 'newRisk')) {
          return commitFailure('EXTERNAL_MCP_AUTONOMY_COMMIT_NEEDS_BOUNDARY');
        }
        if (approval) {
          const suppliedScope = normalizeResolvedScope(resolved.newScope);
          const suppliedRisk = normalizeRisk(resolved.newRisk);
          if (!suppliedScope || !suppliedRisk
            || digest(suppliedScope) !== digest(approval.newScope)
            || digest(suppliedRisk) !== digest(approval.newRisk)) {
            return commitFailure('EXTERNAL_MCP_AUTONOMY_COMMIT_NEEDS_BOUNDARY');
          }
          const resumed = store.resumeWithApprovedBoundary(current.activityId, {
            expectedRevision: current.revision,
            actorKey: activityActorHash(request.actorContext.actorKey, request.actorContext.conversationKey),
            newScope: approval.newScope,
            newRisk: approval.newRisk,
            nextWake: now().toISOString(),
            summary: 'Owner-approved boundary resumed.',
          });
          if (!resumed?.ok) return commitFailure(resumed?.error_code || 'EXTERNAL_MCP_AUTONOMY_COMMIT_NEEDS_BOUNDARY');
          return committedFacadeResult(resumed.activity, request.selection);
        }
        const proven = adjust(current.activityId, {
          newScope: resolved.newScope,
          newRisk: resolved.newRisk,
        });
        if (!proven?.ok || proven.status !== 'adjusted') {
          return commitFailure(proven?.error_code || 'EXTERNAL_MCP_AUTONOMY_COMMIT_NEEDS_BOUNDARY');
        }
        current = store.get(current.activityId);
        if (!current || current.status !== 'paused' || current.checkpoint?.summary !== BOUNDARY_SUMMARY) {
          return commitFailure('EXTERNAL_MCP_AUTONOMY_COMMIT_NEEDS_BOUNDARY');
        }
      }
      const resumed = store.compareAndSwap(current.activityId, {
        expectedRevision: current.revision,
        patch: { status: 'active', nextWake: now().toISOString() },
      });
      if (!resumed?.ok) return commitFailure(resumed?.error_code || 'EXTERNAL_MCP_AUTONOMY_COMMIT_RESUME_FAILED');
      const active = await ensureActiveCoreJob(resumed.activity, request.selection, currentTime);
      if (!active) blockUncommittedActivity(resumed.activity, currentTime);
      return active
        ? committedFacadeResult(active, request.selection)
        : commitFailure('EXTERNAL_MCP_AUTONOMY_COMMIT_RESUME_FAILED');
    }
    return commitFailure('EXTERNAL_MCP_AUTONOMY_COMMIT_INVALID');
  }

  function ownedActivity(activityId, actorContext) {
    const identifier = cleanId(activityId);
    const activity = store.get(identifier)
      || store.list().find((item) => item.coreJobReceipt?.jobId === identifier);
    return activity?.actor?.key === activityActorHash(actorContext.actorKey, actorContext.conversationKey)
      ? activity
      : null;
  }

  async function ensureActiveCoreJob(activity, selection, currentTime) {
    if (!activity || !createCoreJob) return null;
    let receipt = matchingCoreReceipt(activity.coreJobReceipt, selection);
    if (receipt && receipt.status === 'active') {
      if (queryCoreJob) {
        try {
          const remote = matchingCoreReceipt(await queryCoreJob(receipt.jobId), selection);
          if (!remote) return null;
          if (remote.status === 'active') receipt = remote;
          else receipt = null;
        } catch {
          return null;
        }
      }
      if (receipt) return persistCoreReceipt(activity, receipt, currentTime);
    }
    let created;
    try {
      created = matchingCoreReceipt(await createCoreJob({
        actorKey: selection.actorKey,
        goalDigest: selection.goalDigest,
        jobKind: 'core.external-activity',
        payloadRef: `activity:${activity.activityId}`,
        nextRunAt: activity.nextWake || activity.timestamps.updatedAt,
      }), selection);
    } catch {
      return null;
    }
    if (!created || created.status !== 'active') return null;
    return persistCoreReceipt(activity, created, currentTime);
  }

  function blockUncommittedActivity(activity, currentTime) {
    if (!activity || activity.status !== 'active' || activity.coreJobReceipt) return;
    store.compareAndSwap(activity.activityId, {
      expectedRevision: activity.revision,
      patch: { status: 'blocked', nextWake: null },
      now: currentTime,
    });
  }

  async function terminalizeActivityCore(activity, terminalState, currentTime) {
    if (!activity?.coreJobReceipt) return activity;
    const receipt = matchingCoreReceipt(activity.coreJobReceipt, null);
    if (!receipt) return null;
    // Core terminal transitions are immutable. A later user stop may still
    // stop the local activity, but must retain the first truthful Core result.
    if (isCoreTerminalStatus(receipt.status)) return activity;
    if (!terminalizeCoreJob) return null;
    let terminal;
    try {
      terminal = matchingCoreReceipt(await terminalizeCoreJob(receipt.jobId, {
        terminalState,
        resultRef: `activity:${activity.activityId}:terminal:${terminalState}`,
      }), null);
    } catch {
      return null;
    }
    if (!terminal || terminal.jobId !== receipt.jobId || terminal.actorKey !== receipt.actorKey
      || terminal.goalDigest !== receipt.goalDigest || terminal.status !== terminalState) return null;
    return persistCoreReceipt(activity, terminal, currentTime);
  }

  function persistCoreReceipt(activity, receipt, currentTime) {
    if (sameCoreReceipt(activity.coreJobReceipt, receipt)) return activity;
    const saved = store.compareAndSwap(activity.activityId, {
      expectedRevision: activity.revision,
      patch: { coreJobReceipt: receipt },
      ...(activity.leaseOwner === runnerId ? { leaseOwner: runnerId } : {}),
      now: currentTime,
    });
    if (saved?.ok) return saved.activity;
    const current = store.get(activity.activityId, { now: currentTime });
    return sameCoreReceipt(current?.coreJobReceipt, receipt) ? current : null;
  }

  return { startOrResume, adjust, stop, bindNotifyTarget, tick, scanDue, listActivities, commit };
}


const FACADE_ACTIONS = new Set(['start', 'resume', 'adjust', 'stop', 'stop_all']);
const FACADE_DOMAINS = new Set(['game', 'forum', 'embodied', 'other']);
const FACADE_TERMINAL_STATES = Object.freeze(['completed', 'blocked', 'stopped', 'expired']);
const FACADE_RECEIPT_STATUSES = new Set(['active', ...FACADE_TERMINAL_STATES]);


function normalizedFacadeActor(value) {
  if (!isPlainObject(value)) return null;
  const actorKey = facadeIdentifier(value.actorKey, 180);
  const conversationKey = facadeIdentifier(value.conversationKey, 180);
  return actorKey && conversationKey ? { actorKey, conversationKey } : null;
}


function normalizeNotifyTarget(value) {
  if (!isPlainObject(value)) return null;
  const platform = cleanId(value.platform);
  const channelType = cleanId(value.channelType || value.channel_type);
  const conversationId = cleanText(value.conversationId || value.conversation_id, 240).trim();
  const senderId = cleanText(value.senderId || value.sender_id, 240).trim();
  return platform && channelType && conversationId && senderId
    ? { platform, channelType, conversationId, senderId }
    : null;
}


function normalizeFacadeCommit(value) {
  if (!isPlainObject(value) || !FACADE_ACTIONS.has(value.action)) return null;
  const actorContext = normalizedFacadeActor(value.actorContext);
  const selection = isPlainObject(value.selection) ? value.selection : null;
  if (!actorContext || !selection) return null;
  const selectionActor = facadeIdentifier(selection.actorKey, 180);
  const selectionConversation = facadeIdentifier(selection.conversationKey, 180);
  const domain = String(selection.domain || '').toLowerCase();
  const goalDigest = String(selection.goalDigest || '');
  if (
    selectionActor !== actorContext.actorKey
    || selectionConversation !== actorContext.conversationKey
    || !(FACADE_DOMAINS.has(domain) || (value.action === 'stop_all' && domain === 'all'))
    || !/^[a-f0-9]{64}$/.test(goalDigest)
  ) return null;
  const activityId = cleanId(value.activityId);
  const activityIds = Array.isArray(value.activityIds)
    ? [...new Set(value.activityIds.map(cleanId).filter(Boolean))]
    : [];
  if (['resume', 'adjust', 'stop'].includes(value.action) && !activityId) return null;
  if (value.action === 'stop_all' && activityIds.length === 0) return null;
  return {
    action: value.action,
    requestRef: facadeIdentifier(value.requestRef, 80) || '',
    actorContext,
    selection: {
      actorKey: actorContext.actorKey,
      conversationKey: actorContext.conversationKey,
      domain,
      goalDigest,
    },
    ...(activityId ? { activityId } : {}),
    ...(activityIds.length > 0 ? { activityIds } : {}),
    ...(typeof value.goal === 'string' ? { goal: cleanText(value.goal, 2_000) } : {}),
    ...(typeof value.reference === 'string' ? { reference: cleanText(value.reference, 500) } : {}),
    ...(typeof value.environmentHint === 'string' ? { environmentHint: cleanText(value.environmentHint, 500) } : {}),
    ...(Object.hasOwn(value, 'reporting') ? { reporting: cloneValue(value.reporting) } : {}),
    ...(Object.hasOwn(value, 'approvedBoundary') ? { approvedBoundary: value.approvedBoundary } : {}),
  };
}


function trustedBoundaryApproval(token, activity, actorContext) {
  const approval = token && typeof token === 'object' ? TRUSTED_BOUNDARY_APPROVALS.get(token) : null;
  if (!approval) return null;
  return approval.activityId === activity.activityId
    && approval.actor.actorKey === actorContext.actorKey
    && approval.actor.conversationKey === actorContext.conversationKey
    ? approval
    : null;
}


function isCommitRuntimeContext(value) {
  return isPlainObject(value) && (
    isPlainObject(value.manifest)
    || isPlainObject(value.discovery)
    || isPlainObject(value.risk)
    || isPlainObject(value.trustedContext)
  );
}


function activityActorHash(actorKey, conversationKey) {
  return digest(`${actorKey}\n${conversationKey}`);
}


function facadeActivity(activity, identity) {
  if (!activity || !FACADE_DOMAINS.has(activity.domain) || typeof activity.goal?.text !== 'string') return null;
  const goalDigest = facadeGoalDigest(activity.goal.text);
  const nextRunAt = validIso(activity.nextWake)
    ? activity.nextWake
    : validIso(activity.timestamps?.updatedAt) ? activity.timestamps.updatedAt : null;
  if (!nextRunAt) return null;
  const receiptStatus = FACADE_RECEIPT_STATUSES.has(activity.status) ? activity.status : 'active';
  const receipt = matchingCoreReceipt(activity.coreJobReceipt, {
    actorKey: identity.actorKey,
    goalDigest,
  });
  return deepFreeze({
    activityId: activity.activityId,
    actorKey: identity.actorKey,
    conversationKey: identity.conversationKey,
    domain: activity.domain,
    goal: activity.goal.text,
    normalizedGoal: normalizeFacadeGoal(activity.goal.text),
    goalDigest,
    status: activity.status,
    committed: true,
    // A non-legacy stored activity was created only after its initial active
    // wake was persisted. Legacy records never enter the facade repair path.
    firstWakeCommitted: activity.actor?.kind !== 'legacy',
    receipt: receipt && receipt.status === receiptStatus ? receipt : null,
  });
}


function committedFacadeResult(activity, selection, override = {}) {
  const status = override.status || activity?.status;
  if (!FACADE_RECEIPT_STATUSES.has(status)) return commitFailure('EXTERNAL_MCP_AUTONOMY_COMMIT_NOT_ACTIVE');
  const receipt = matchingCoreReceipt(activity?.coreJobReceipt, selection);
  if (!receipt || (receipt.status !== status && !(status === 'stopped' && isCoreTerminalStatus(receipt.status)))) {
    return commitFailure('EXTERNAL_MCP_AUTONOMY_COMMIT_CORE_RECEIPT_MISSING');
  }
  return deepFreeze({
    committed: true,
    firstWakeCommitted: activity ? activity.actor?.kind !== 'legacy' : true,
    receipt,
  });
}


function committedAggregateFacadeResult(stopped, selection) {
  const aggregate = stopped.aggregate;
  if (
    !aggregate
    || typeof aggregate.transactionId !== 'string'
    || !validIso(aggregate.committedAt)
    || !Array.isArray(stopped.activities)
    || stopped.activities.length === 0
    || stopped.activities.some((activity) => activity.status !== 'stopped' || activity.actor?.kind === 'legacy')
  ) return commitFailure('EXTERNAL_MCP_AUTONOMY_COMMIT_STOP_FAILED');
  const receipt = [...stopped.activities]
    .sort((left, right) => left.activityId.localeCompare(right.activityId))
    .map((activity) => matchingCoreReceipt(activity.coreJobReceipt, { actorKey: selection.actorKey }))
    .find((item) => item && isCoreTerminalStatus(item.status) && item.goalDigest === selection.goalDigest);
  if (!receipt) return commitFailure('EXTERNAL_MCP_AUTONOMY_COMMIT_CORE_RECEIPT_MISSING');
  return deepFreeze({
    committed: true,
    firstWakeCommitted: true,
    receipt,
  });
}


function facadeReceipt(jobId, actorKey, goalDigest, status, nextRunAt) {
  return deepFreeze({
    jobId: cleanId(jobId),
    actorKey,
    goalDigest,
    status,
    nextRunAt,
    terminalStates: [...FACADE_TERMINAL_STATES],
  });
}


function matchingCoreReceipt(value, selection = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const terminalStates = ['completed', 'blocked', 'stopped', 'expired'];
  const jobId = cleanId(value.jobId);
  const actorKey = facadeIdentifier(value.actorKey, 180);
  const goalDigest = String(value.goalDigest || '');
  const status = String(value.status || '');
  const nextRunAt = String(value.nextRunAt || '');
  if (!jobId || !actorKey || !/^[a-f0-9]{64}$/.test(goalDigest)
    || !FACADE_RECEIPT_STATUSES.has(status) || !validIso(nextRunAt)
    || !Array.isArray(value.terminalStates)
    || value.terminalStates.length !== terminalStates.length
    || value.terminalStates.some((item, index) => item !== terminalStates[index])) return null;
  if (selection && (value.actorKey !== selection.actorKey
    || (selection.goalDigest && goalDigest !== selection.goalDigest))) return null;
  return deepFreeze({ jobId, actorKey, goalDigest, status, nextRunAt, terminalStates: [...terminalStates] });
}


function sameCoreReceipt(left, right) {
  return JSON.stringify(left || null) === JSON.stringify(right || null);
}


function coreReceiptNeedsTerminalization(receipt, status) {
  return Boolean(receipt && receipt.status === 'active' && isCoreTerminalStatus(status));
}


function isCoreTerminalStatus(status) {
  return ['completed', 'blocked', 'stopped', 'expired'].includes(status);
}


function commitFailure(error_code) {
  return Object.freeze({ committed: false, firstWakeCommitted: false, error_code });
}


function normalizeFacadeGoal(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}


function facadeGoalDigest(value) {
  return createHash('sha256').update(normalizeFacadeGoal(value), 'utf8').digest('hex');
}


function facadeIdentifier(value, maxLength) {
  const text = String(value || '').trim();
  return text && text.length <= maxLength && !/[\r\n\t\0]/.test(text) ? text : '';
}


function validIso(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}


function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}


function cloneValue(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(cloneValue);
  return Object.fromEntries(Object.keys(value).map((key) => [key, cloneValue(value[key])]));
}


function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}


function normalizedIdentity(input) {
  const actor = cleanText(input.actorKey || input.actor_key, 240).trim();
  const conversation = cleanText(input.conversationKey || input.conversation_key, 240).trim();
  const domain = cleanId(input.domain).toLowerCase();
  return actor && conversation && ['game', 'forum', 'embodied', 'other'].includes(domain)
    ? { actor, conversation, domain }
    : null;
}


function normalizeGoal(value) {
  const text = cleanText(value?.text, 2_000).trim().replace(/\s+/g, ' ');
  if (!text) return null;
  return {
    text,
    constraints: stringList(value?.constraints, 30, 500),
    resourceId: cleanText(value?.resourceId || value?.resource_id, 240),
    parameters: boundedObject(value?.parameters || {}),
  };
}


function normalizedGoalForDigest(goal) {
  return {
    text: goal.text.toLowerCase(),
    constraints: [...goal.constraints].map((item) => item.trim().replace(/\s+/g, ' ').toLowerCase()).sort(),
    resourceId: goal.resourceId,
    parameters: stableValue(goal.parameters),
  };
}


function normalizeResolvedScope(value) {
  const serverId = cleanId(value?.serverId || value?.server_id);
  if (!serverId) return null;
  return {
    serverId,
    resourceId: cleanText(value?.resourceId || value?.resource_id, 240),
    parameters: boundedObject(value?.parameters || {}),
  };
}


function normalizeRisk(value) {
  const envelopeId = cleanId(value?.envelopeId || value?.envelope_id);
  if (!envelopeId) return null;
  return {
    envelopeId,
    allowedEffects: stringList(value?.allowedEffects, 50, 120),
    boundaryGrants: stringList(value?.boundaryGrants, 50, 200),
  };
}


function ownsActiveLease(activity, expectedRevision, currentTime, runnerId) {
  return Boolean(activity
    && activity.status === 'active'
    && activity.revision === expectedRevision
    && activity.leaseOwner === runnerId
    && activity.leaseUntil
    && Date.parse(activity.leaseUntil) > currentTime.getTime());
}


function sameScope(committed, resolved) {
  const normalized = normalizeResolvedScope(resolved);
  return Boolean(normalized && digest(normalized) === digest(committed));
}


function isTypedCompletion(adapter, observation, classification) {
  return adapter.descriptor?.capabilities?.typedTerminal === true
    && observation?.terminal === true
    && classification?.status === 'completed';
}


async function provenExperiences(provider, query) {
  if (!provider || typeof provider.getProven !== 'function') return [];
  try {
    const legal = new Set(query.legalActions.map((item) => typeof item === 'string' ? item : item?.actionId));
    const records = await provider.getProven(query);
    return (Array.isArray(records) ? records : [])
      .filter((item) => item?.proven === true && legal.has(item.actionId))
      .slice(0, 8)
      .map((item) => ({
        proven: true,
        actionId: item.actionId,
        outcome: cleanId(item.outcome),
        ...(Number.isFinite(item.score) ? { score: item.score } : {}),
      }));
  } catch {
    return [];
  }
}


function experienceQuery(activity, observation, legalActions) {
  const actions = (Array.isArray(legalActions) ? legalActions : [])
    .filter((action) => action?.availability === 'available' && action?.unsafe !== true && cleanId(action.actionId))
    .map((action) => cleanId(action.actionId));
  return {
    domain: activity.domain,
    driverId: activity.driverId,
    driverVersion: digest({ driverId: activity.driverId, serverId: activity.scope.serverId }),
    goalClass: `goal_${digest(activity.goal).slice(0, 48)}`,
    scopeClass: `scope_${digest(activity.scope).slice(0, 47)}`,
    observationDigest: digest(observation),
    legalActions: actions,
  };
}


async function appendProvenExperience(provider, input) {
  if (!provider || typeof provider.appendOutcome !== 'function' || typeof provider.isTrustedReceipt !== 'function') return;
  const receipt = input?.receipt;
  const brokerReceipt = receipt?.brokerReceipt;
  const selected = input?.experience?.selected;
  const context = input?.experience?.context;
  const evidenceRef = cleanText(brokerReceipt?.evidenceRef || brokerReceipt?.evidence_ref, 240).trim();
  if (!context || !selected || selected.availability !== 'available' || selected.unsafe === true
    || !brokerReceipt || receipt?.outcome !== 'applied' || brokerReceipt.outcome !== 'applied'
    || brokerReceipt.activityId !== input.activity?.activityId || brokerReceipt.actionId !== selected.actionId
    || brokerReceipt.serverId !== input.activity?.scope?.serverId || !evidenceRef
    || !Array.isArray(input.checkpoint?.evidenceRefs) || !input.checkpoint.evidenceRefs.includes(evidenceRef)
    || !['active', 'completed'].includes(input.status)) return;
  try {
    if (provider.isTrustedReceipt(brokerReceipt) !== true) return;
    const { legalActions, ...recordContext } = context;
    await provider.appendOutcome({
      receipt: brokerReceipt,
      record: {
        ...recordContext,
        actionId: selected.actionId,
        outcome: input.status === 'completed' ? 'completed' : 'progress',
        effectDigest: digest({ actionId: selected.actionId, effect: brokerReceipt.effect }),
        evidenceDigests: [digest(evidenceRef)],
        createdAt: input.currentTime.toISOString(),
      },
    });
  } catch {
    // Experience is optional: an atomic-state failure must not stop activity.
  }
}


function isBudgetExpired(activity, currentTime, maxActivityMs) {
  return currentTime.getTime() - Date.parse(activity.timestamps.startedAt) >= maxActivityMs;
}


function checkpoint(summary, status, currentTime, terminal, receipt = null) {
  const sanitized = cleanText(summary, 1_000).trim();
  return {
    stateDigest: digest({ summary: sanitized, status, terminal }),
    summary: sanitized,
    terminal,
    evidenceRefs: receiptEvidenceRefs(receipt),
    updatedAt: currentTime.toISOString(),
  };
}


function receiptEvidenceRefs(receipt) {
  const ref = cleanText(
    receipt?.evidenceRef
      || receipt?.brokerReceipt?.evidenceRef
      || receipt?.brokerReceipt?.evidence_ref,
    240,
  ).trim();
  return ref ? [ref] : [];
}


function observationSummary(observation) {
  return cleanText(
    observation?.summary
      || observation?.evidence?.text
      || observation?.evidence?.data?.summary
      || observation?.evidence?.data?.status,
    1_000,
  ).trim();
}


function receiptSummary(receipt) {
  return cleanText(
    receipt?.evidence?.text
      || receipt?.observation?.summary
      || receipt?.evidence?.data?.summary
      || receipt?.evidence?.data?.status,
    1_000,
  ).trim();
}


function raceResult(activity, activityId) {
  const status = activity?.status || 'stale';
  return { ok: true, activityId: cleanId(activityId), status, candidate: null, reason: 'stale_or_stopped' };
}


function activityResult(activity, status, extra = {}) {
  return {
    ok: true,
    activityId: activity.activityId,
    status,
    revision: activity.revision,
    nextWake: activity.nextWake,
    ...extra,
  };
}


function tickResult(activity, status, candidate) {
  return {
    ok: true,
    activityId: activity.activityId,
    status,
    revision: activity.revision,
    nextWake: activity.nextWake,
    candidate,
  };
}


function failure(message, code) {
  return { ok: false, error: message, error_code: code };
}


function digest(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(stableValue(value))).digest('hex');
}


function stableValue(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(stableValue);
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}


function cleanId(value) {
  return String(value || '').trim().replace(/[\r\n\t]/g, '').replace(/[^a-zA-Z0-9_.:@/-]/g, '').slice(0, 240);
}


function cleanText(value, maxChars) {
  return String(value || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, maxChars);
}


function stringList(value, maxItems, maxChars) {
  return (Array.isArray(value) ? value : []).slice(0, maxItems).map((item) => cleanText(item, maxChars).trim()).filter(Boolean);
}


function boundedObject(value) {
  try {
    const text = JSON.stringify(value);
    if (!text || Buffer.byteLength(text, 'utf8') > 16_384) return {};
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}


function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}
