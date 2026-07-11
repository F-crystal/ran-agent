import assert from 'node:assert/strict';
import test from 'node:test';

import { listExternalMcpEvidence } from '../src/externalMcp/evidenceLog.mjs';
import { listExternalMcpExperiences } from '../src/externalMcp/experienceStore.mjs';
import { createExternalMcpAutonomyRuntime } from '../src/externalMcp/runtime.mjs';
import { listExternalMcpSessions } from '../src/externalMcp/sessionManager.mjs';
import { createIsolatedTestEnv } from './helpers/isolatedState.mjs';

const ACTOR = Object.freeze({
  actorKey: 'actor:owner:runtime',
  conversationKey: 'conversation:wechat:runtime',
  platform: 'wechat',
});

function enabledGame(id) {
  return {
    id,
    activityKind: 'game',
    tools: [{
      name: 'play',
      title: 'Play',
      description: 'Play the sandbox game.',
      tier: 'T3',
      inputSchema: { type: 'object', additionalProperties: true },
    }],
  };
}


function coreJobOptions() {
  const receipts = new Map();
  return {
    async createCoreJob(input) {
      const receipt = {
        jobId: `job_external_${input.goalDigest.slice(0, 24)}`,
        actorKey: input.actorKey,
        goalDigest: input.goalDigest,
        status: 'active',
        nextRunAt: input.nextRunAt,
        terminalStates: ['completed', 'blocked', 'stopped', 'expired'],
      };
      receipts.set(receipt.jobId, receipt);
      return receipt;
    },
    async queryCoreJob(jobId) { return receipts.get(jobId); },
    async terminalizeCoreJob(jobId, input) {
      const current = receipts.get(jobId);
      const receipt = { ...current, status: input.terminalState };
      receipts.set(jobId, receipt);
      return receipt;
    },
  };
}

test('bridge-owned runtime starts with an immediate supervisor scan and gives the facade only one enabled matching manifest', async (t) => {
  const env = createIsolatedTestEnv(t);
  const runtime = createExternalMcpAutonomyRuntime({
    env,
    ...coreJobOptions(),
    intervalMs: 60_000,
    listManifests: () => [enabledGame('cedar-toy')],
    transport: { async call() { return { content: [{ type: 'text', text: 'ok' }] }; } },
  });

  const initial = await runtime.start();
  assert.deepEqual(initial, { ok: true, processed: 0, results: [] });
  const result = await runtime.facade.handle({
    requestRef: 'runtime-start-1',
    command: 'start_or_resume',
    goal: '继续玩这个游戏直到第一关结束',
    environmentHint: 'game',
  }, ACTOR);

  assert.equal(result.action, 'started');
  assert.equal(runtime.store.list().length, 1);
  assert.equal(runtime.store.list()[0].scope.serverId, 'cedar-toy');
  runtime.stop();
});

test('bridge-owned runtime deterministically selects a trusted manifest when more than one enabled manifest matches a facade domain', async (t) => {
  const env = createIsolatedTestEnv(t);
  const runtime = createExternalMcpAutonomyRuntime({
    env,
    ...coreJobOptions(),
    listManifests: () => [enabledGame('cedar-one'), enabledGame('cedar-two')],
    transport: { async call() { return {}; } },
  });

  const result = await runtime.facade.handle({
    requestRef: 'runtime-start-ambiguous',
    command: 'start_or_resume',
    goal: '继续玩这个游戏直到第一关结束',
    environmentHint: 'game',
  }, ACTOR);
  assert.equal(result.action, 'started');
  assert.equal(runtime.store.list()[0].scope.serverId, 'cedar-one');
  runtime.stop();
});

test('bridge-owned runtime routes configured browser and API manifests through the generic other-domain adapter', async (t) => {
  const env = createIsolatedTestEnv(t);
  for (const [activityKind, id] of [['browser', 'browser-reader'], ['api', 'status-api']]) {
    const runtime = createExternalMcpAutonomyRuntime({
      env,
      ...coreJobOptions(),
      listManifests: () => [{
        id, activityKind,
        tools: [{ name: 'read', title: 'Read', tier: 'T1', inputSchema: { type: 'object', properties: {} } }],
      }],
      transport: { async call() { return { content: [{ type: 'text', text: 'ok' }] }; } },
    });
    const result = await runtime.facade.handle({
      requestRef: `runtime-${activityKind}-start`, command: 'start_or_resume',
      goal: activityKind === 'browser' ? '持续浏览器状态观察' : '持续接口状态观察', environmentHint: activityKind,
    }, ACTOR);
    assert.equal(result.action, 'started');
    assert.equal(runtime.store.list().find((item) => item.goal.text.includes(activityKind === 'browser' ? '浏览器' : '接口'))?.scope.serverId, id);
    runtime.stop();
  }
});

test('a due activity reaches the bridge-owned gateway path, records a receipt evidence ref, and reconciles unknown without direct adapter replay', async (t) => {
  const env = createIsolatedTestEnv(t);
  const routed = [];
  let plannerCalls = 0;
  let brokerReconciles = 0;
  const manifest = {
    id: 'cedar-toy',
    activityKind: 'game',
    transport: 'streamable-http',
    tools: [{
      name: 'advance',
      title: 'Advance',
      description: 'Advance one bounded sandbox-game checkpoint.',
      tier: 'T3',
      profileScope: 'full',
      proactiveAllowed: true,
      confirmationRequired: false,
      reason: 'sandbox_activity',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    }],
  };
  const runtime = createExternalMcpAutonomyRuntime({
    env,
    ...coreJobOptions(),
    listManifests: () => [manifest],
    planner: {
      async chooseAction({ legalActions }) {
        plannerCalls += 1;
        return { actionId: legalActions[0]?.actionId };
      },
    },
    transport: {
      async call(request) {
        // This provider-shaped call is reached only after the runtime's
        // capability/policy/session checks and gateway receipt minting path.
        routed.push(request);
        assert.equal(request.toolName, 'advance');
        assert.match(request.operationId, /^operation_/);
        return { content: [{ type: 'text', text: 'Advanced one checkpoint.' }] };
      },
    },
    async reconcileOperation({ capability }) {
      brokerReconciles += 1;
      assert.match(capability.operationId, /^operation_/);
      return 'unknown';
    },
    tickIntervalMs: 1_000,
  });
  const started = runtime.supervisor.startOrResume({
    actorKey: ACTOR.actorKey,
    conversationKey: ACTOR.conversationKey,
    domain: 'game',
    goal: { text: 'continue the selected game', parameters: {} },
    manifest,
    trustedContext: { allowedResourceIds: [] },
    risk: { envelopeId: 'owner-game-v1', allowedEffects: ['read', 'write'], boundaryGrants: [] },
  });

  const ticked = await runtime.tick();
  assert.equal(ticked.processed, 1);
  assert.equal(plannerCalls, 1);
  assert.equal(routed.length, 1);
  const afterTick = runtime.store.get(started.activityId);
  assert.equal(afterTick.status, 'active');
  assert.equal(afterTick.checkpoint.evidenceRefs.length, 1);
  assert.equal(listExternalMcpEvidence({ env }).length, 1);
  const experiences = listExternalMcpExperiences({ env });
  assert.equal(experiences.length, 1);
  assert.match(experiences[0].actionId, /^action_[a-f0-9]{24}$/);
  assert.equal(experiences[0].outcome, 'progress');
  assert.equal(JSON.stringify(experiences[0]).includes('Advanced one checkpoint.'), false);

  runtime.store.compareAndSwap(started.activityId, {
    expectedRevision: afterTick.revision,
    patch: {
      pendingOperation: {
        operationId: routed[0].operationId, actionId: 'action_unknown', toolName: 'advance', effect: 'write', status: 'unknown',
        arguments: {}, sessionId: 'extmcp_session_legacy',
        startedAt: '2026-07-10T10:00:00.000Z', updatedAt: '2026-07-10T10:00:00.000Z',
      },
      nextWake: '2020-01-01T00:00:00.000Z',
    },
  });
  const reconciled = await runtime.tick();
  assert.equal(reconciled.processed, 1);
  assert.equal(runtime.store.get(started.activityId).status, 'blocked');
  assert.equal(brokerReconciles, 1);
  assert.equal(plannerCalls, 1);
  assert.equal(routed.length, 1);
  runtime.stop();
});

test('an ambiguous T3 sandbox-game play is not replayed on the direct route and stays durably unknown', async (t) => {
  const env = createIsolatedTestEnv(t);
  const manifest = {
    id: 'cedar-toy', activityKind: 'game', transport: 'streamable-http',
    tools: [{
      name: 'play', title: 'Play', tier: 'T3', profileScope: 'full', proactiveAllowed: true,
      confirmationRequired: false, reason: 'sandbox_activity',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    }],
  };
  let gatewayCalls = 0;
  let directCalls = 0;
  const runtime = createExternalMcpAutonomyRuntime({
    env,
    ...coreJobOptions(),
    listManifests: () => [manifest],
    planner: { async chooseAction({ legalActions }) { return { actionId: legalActions[0]?.actionId }; } },
    gatewayCall: async () => {
      gatewayCalls += 1;
      return { ok: false, error_code: 'EXTERNAL_MCP_TRANSPORT_FAILED' };
    },
    directCall: async () => {
      directCalls += 1;
      return { ok: true, result: { shouldNotRun: true } };
    },
    transport: { async call() { throw new Error('the route stubs must be used'); } },
  });
  const started = runtime.supervisor.startOrResume({
    actorKey: ACTOR.actorKey, conversationKey: ACTOR.conversationKey, domain: 'game',
    goal: { text: 'continue the selected game', parameters: {} }, manifest,
    trustedContext: { allowedResourceIds: [] },
    risk: { envelopeId: 'owner-game-v1', allowedEffects: ['read', 'write'], boundaryGrants: [] },
  });

  const ticked = await runtime.tick();
  const activity = runtime.store.get(started.activityId);

  assert.equal(ticked.processed, 1);
  assert.equal(gatewayCalls, 1);
  assert.equal(directCalls, 0);
  assert.equal(activity.status, 'blocked');
  assert.equal(activity.pendingOperation.status, 'unknown');
  assert.equal(activity.pendingOperation.toolName, 'play');
  assert.deepEqual(activity.pendingOperation.arguments, {});
  assert.match(activity.pendingOperation.sessionId, /^extmcp_/);
  assert.equal(listExternalMcpExperiences({ env }).length, 0);
  runtime.stop();
});

test('runtime carries an upstream MCP session only between bridge-owned calls', async (t) => {
  const env = createIsolatedTestEnv(t);
  const upstreams = [];
  const manifest = {
    id: 'sessionful-game', activityKind: 'game', transport: 'streamable-http',
    tools: [{
      name: 'play', title: 'Play', tier: 'T3', profileScope: 'full', proactiveAllowed: true,
      confirmationRequired: false, reason: 'sandbox_activity',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    }],
  };
  const runtime = createExternalMcpAutonomyRuntime({
    env,
    listManifests: () => [manifest],
    planner: { async chooseAction({ legalActions }) { return { actionId: legalActions[0]?.actionId }; } },
    transport: {
      async call(request) {
        upstreams.push(request.upstreamSessionId || '');
        return { upstreamSessionId: upstreams.length === 1 ? 'remote-session-1' : 'remote-session-2', content: [] };
      },
    },
  });
  const started = runtime.supervisor.startOrResume({
    actorKey: ACTOR.actorKey, conversationKey: ACTOR.conversationKey, domain: 'game',
    goal: { text: 'continue the selected game', parameters: {} }, manifest,
    trustedContext: { allowedResourceIds: [] },
    risk: { envelopeId: 'owner-game-v1', allowedEffects: ['read', 'write'], boundaryGrants: [] },
  });

  await runtime.tick();
  const first = runtime.store.get(started.activityId);
  runtime.store.compareAndSwap(started.activityId, {
    expectedRevision: first.revision,
    patch: { nextWake: '2020-01-01T00:00:00.000Z' },
  });
  await runtime.tick();

  assert.deepEqual(upstreams, ['', 'remote-session-1']);
  assert.equal(JSON.stringify(runtime.store.get(started.activityId)).includes('remote-session'), false);
  runtime.stop();
});

test('runtime refreshes the enabled server live schema, compiles Cedar-shaped arguments privately, and constrains only the operation on discovery failure', async (t) => {
  const env = createIsolatedTestEnv(t);
  const calls = [];
  let discoveryCalls = 0;
  const manifest = {
    id: 'cedar-toy', activityKind: 'game', transport: 'streamable-http', url: 'https://example.test/mcp',
    tools: [{
      name: 'play', title: 'Play', tier: 'T3', profileScope: 'full', proactiveAllowed: true,
      confirmationRequired: false, reason: 'sandbox_activity', inputSchemaSummary: { propertyNames: ['stale'], required: [] },
    }],
  };
  const runtime = createExternalMcpAutonomyRuntime({
    env,
    ...coreJobOptions(),
    listManifests: () => [manifest],
    discover: async () => {
      discoveryCalls += 1;
      if (discoveryCalls > 2) return { ok: false, error_code: 'OFFLINE' };
      const properties = {
        game_id: { type: 'string', default: 'forest' },
        action: { type: 'string', default: 'look around' },
      };
      if (discoveryCalls === 2) properties.style = { type: 'string', default: 'safe' };
      return {
        ok: true,
        initializeResult: { serverInfo: { name: 'cedar-live' }, capabilities: { tools: { listChanged: true } } },
        toolsResult: { tools: [{
          name: 'play', inputSchema: {
            type: 'object',
            properties,
            required: ['game_id', 'action'], additionalProperties: false,
          },
        }] },
      };
    },
    planner: { async chooseAction({ legalActions }) { return { actionId: legalActions[0]?.actionId }; } },
    transport: {
      async call(request) {
        calls.push(request);
        return {
          content: [{ type: 'text', text: 'Turn accepted.' }],
          notifications: [{ method: 'notifications/tools/list_changed' }],
        };
      },
    },
  });

  const committed = await runtime.facade.handle({
    requestRef: 'live-schema-start', command: 'start_or_resume', goal: '持续玩选中的游戏', environmentHint: 'game',
  }, ACTOR);
  assert.equal(committed.action, 'started');
  assert.doesNotMatch(JSON.stringify(committed), /game_id|style|nativeArguments/);

  await runtime.tick();
  assert.deepEqual(calls[0].arguments, { game_id: 'forest', action: 'look around', style: 'safe' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(discoveryCalls >= 3);

  const activity = runtime.store.list()[0];
  const afterFirstTick = runtime.store.get(activity.activityId);
  runtime.store.compareAndSwap(activity.activityId, {
    expectedRevision: afterFirstTick.revision,
    patch: { nextWake: '2020-01-01T00:00:00.000Z' },
  });
  const constrained = await runtime.tick();
  assert.equal(constrained.processed, 1);
  assert.equal(runtime.store.get(activity.activityId).status, 'blocked');
  assert.equal(calls.length, 1);
  runtime.stop();
});

test('runtime retains an arbitrary live schema in memory and does not make the configured server selection depend on discovery shape', async (t) => {
  const env = createIsolatedTestEnv(t);
  let calls = 0;
  const runtime = createExternalMcpAutonomyRuntime({
    env,
    ...coreJobOptions(),
    listManifests: () => [{
      id: 'arbitrary-enabled', activityKind: 'other', transport: 'streamable-http', url: 'https://example.test/mcp',
      tools: [{ name: 'unknown', title: 'Unknown', tier: 'T5', inputSchemaSummary: { propertyNames: [], required: [] } }],
    }],
    discover: async () => ({
      ok: true,
      initializeResult: { serverInfo: { name: 'arbitrary-live' }, capabilities: { tools: {} } },
      toolsResult: { tools: [{ name: 'transmogrify', inputSchema: {
        type: 'object', properties: { opaque: { type: 'object', default: {}, additionalProperties: true } }, required: ['opaque'],
      } }] },
    }),
    transport: { async call() { calls += 1; return {}; } },
  });
  const result = await runtime.facade.handle({
    requestRef: 'arbitrary-live-start', command: 'start_or_resume', goal: '继续这个已连接的环境', environmentHint: 'other',
  }, ACTOR);
  assert.equal(result.action, 'started');
  assert.equal(runtime.store.list()[0].scope.serverId, 'arbitrary-enabled');
  await runtime.tick();
  assert.equal(runtime.store.list()[0].status, 'paused');
  assert.equal(calls, 0);
  runtime.stop();
});

test('a committed checkpoint submits its candidate with only the durable activity delivery context', async (t) => {
  const env = createIsolatedTestEnv(t);
  const submitted = [];
  const runtime = createExternalMcpAutonomyRuntime({
    env,
    ...coreJobOptions(),
    listManifests: () => [{
      id: 'checkpoint-mcp', activityKind: 'game', transport: 'streamable-http',
      tools: [{ name: 'observe', title: 'Observe', tier: 'T1', inputSchema: { type: 'object', properties: {} } }],
    }],
    planner: { async chooseAction({ legalActions }) { return { actionId: legalActions[0]?.actionId }; } },
    transport: { async call() { return { structuredContent: { summary: 'Checkpoint is ready.', terminal: false } }; } },
    submitCandidate(candidate, context) { submitted.push({ candidate, context }); },
  });

  const started = await runtime.facade.handle({
    requestRef: 'checkpoint-submit', command: 'start_or_resume', goal: '继续玩已选择的游戏', environmentHint: 'game',
  }, ACTOR);
  await runtime.tick();

  assert.equal(started.action, 'started');
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].candidate.status, 'ready');
  assert.equal(submitted[0].context.activityId, runtime.store.list()[0].activityId);
  assert.deepEqual(Object.keys(submitted[0].context).sort(), ['activityId', 'checkpointDigest', 'notifyTarget', 'revision']);
  assert.equal(submitted[0].context.notifyTarget, null);
  runtime.stop();
});

test('only the bridge can attach the trusted reply destination after the first wake commits', async (t) => {
  const env = createIsolatedTestEnv(t);
  const runtime = createExternalMcpAutonomyRuntime({
    env,
    ...coreJobOptions(),
    listManifests: () => [{
      id: 'target-mcp', activityKind: 'game', transport: 'streamable-http',
      tools: [{ name: 'observe', title: 'Observe', tier: 'T1', inputSchema: { type: 'object', properties: {} } }],
    }],
    transport: { async call() { return { structuredContent: { summary: 'ok', terminal: false } }; } },
  });
  const started = await runtime.facade.handle({
    requestRef: 'target-start', command: 'start_or_resume', goal: '继续玩已选择的游戏', environmentHint: 'game',
  }, ACTOR);

  const attached = await runtime.facade.bindNotifyTarget({
    receipt: started.receipt,
    actorContext: ACTOR,
    target: { platform: 'wechat', channelType: 'dm', conversationId: 'conversation-1', senderId: 'sender-1' },
  });

  assert.equal(attached.ok, true);
  assert.deepEqual(runtime.store.list().find((item) => item.coreJobReceipt?.jobId === started.receipt.jobId).notifyTarget, {
    platform: 'wechat', channelType: 'dm', conversationId: 'conversation-1', senderId: 'sender-1',
  });
  runtime.stop();
});

test('runtime stop commits first and then closes its bridge-owned session', async (t) => {
  const env = createIsolatedTestEnv(t);
  const runtime = createExternalMcpAutonomyRuntime({
    env,
    ...coreJobOptions(),
    listManifests: () => [{
      id: 'stop-session-mcp', activityKind: 'game', transport: 'streamable-http',
      tools: [{ name: 'observe', title: 'Observe', tier: 'T1', inputSchema: { type: 'object', properties: {} } }],
    }],
    transport: { async call() { return { structuredContent: { summary: 'ok', terminal: false } }; } },
  });
  const started = await runtime.facade.handle({
    requestRef: 'stop-session', command: 'start_or_resume', goal: '继续玩已选择的游戏', environmentHint: 'game',
  }, ACTOR);
  await runtime.tick();
  assert.equal(listExternalMcpSessions({ env }).length, 1);

  const stopped = await runtime.facade.handle({
    requestRef: 'stop-session-now', command: 'stop', goal: '停止全部',
  }, ACTOR);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(stopped.action, 'stopped_all');
  assert.equal(runtime.store.list().find((item) => item.coreJobReceipt?.jobId === started.receipt.jobId).status, 'stopped');
  assert.equal(listExternalMcpSessions({ env }).length, 0);
  runtime.stop();
});


test('runtime stop aborts the actual in-flight broker transport after the durable stop commits', async (t) => {
  const env = createIsolatedTestEnv(t);
  const manifest = {
    id: 'abortable-game', activityKind: 'game', transport: 'streamable-http',
    tools: [{ name: 'play', title: 'Play', tier: 'T3', profileScope: 'full', proactiveAllowed: true,
      confirmationRequired: false, reason: 'sandbox_activity', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }],
  };
  let resolveCall;
  let signal;
  const runtime = createExternalMcpAutonomyRuntime({
    env,
    listManifests: () => [manifest],
    planner: { async chooseAction({ legalActions }) { return { actionId: legalActions[0]?.actionId }; } },
    transport: {
      async call(request) {
        signal = request.signal;
        return await new Promise((resolve) => { resolveCall = resolve; });
      },
    },
  });
  const started = runtime.supervisor.startOrResume({
    actorKey: ACTOR.actorKey, conversationKey: ACTOR.conversationKey, domain: 'game',
    goal: { text: 'continue the selected game', parameters: {} }, manifest,
    trustedContext: { allowedResourceIds: [] }, risk: { envelopeId: 'owner-game-v1', allowedEffects: ['read', 'write'], boundaryGrants: [] },
  });

  const tick = runtime.tick();
  for (let index = 0; index < 20 && !signal; index += 1) await new Promise((resolve) => setImmediate(resolve));
  const stopped = runtime.supervisor.stop(started.activityId);

  assert.equal(stopped.status, 'stopped');
  assert.equal(signal?.aborted, true);
  resolveCall?.({ content: [] });
  await tick;
  assert.equal(runtime.store.get(started.activityId).status, 'stopped');
  runtime.stop();
});
