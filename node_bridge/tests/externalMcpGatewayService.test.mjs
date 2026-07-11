import assert from 'node:assert/strict';
import test from 'node:test';

import { createExternalMcpGatewayService } from '../src/externalMcp/gatewayService.mjs';
import {
  createBridgeExternalMcpOperationCapability,
  digestExternalMcpOperationValue,
  verifyExternalMcpOperationReceipt,
} from '../src/externalMcp/operationReceipt.mjs';
import { trustExternalMcpPendingAction, trustExternalMcpScopedGrant } from '../src/externalMcp/policy.mjs';


const NOW = new Date('2026-07-10T10:00:00.000Z');
const READ_MANIFEST = {
  id: 'generic-forum',
  title: 'Generic forum',
  transport: 'streamable-http',
  url: 'https://mcp.example.test/rpc',
  tools: [{
    name: 'forum.read',
    title: 'Read forum',
    tier: 'T1',
    profileScope: 'lite',
    proactiveAllowed: true,
    confirmationRequired: false,
    reason: 'public_read',
  }],
};
const WRITE_MANIFEST = {
  ...READ_MANIFEST,
  tools: [{
    name: 'forum.post',
    title: 'Post to forum',
    tier: 'T4',
    profileScope: 'full',
    proactiveAllowed: false,
    confirmationRequired: true,
    reason: 'external_side_effect',
  }],
};
const GAME_MANIFEST = {
  id: 'cedar-toy',
  title: 'Sandbox game',
  transport: 'streamable-http',
  url: 'https://mcp.example.test/rpc',
  tools: [{
    name: 'play',
    title: 'Play',
    tier: 'T3',
    profileScope: 'full',
    proactiveAllowed: true,
    confirmationRequired: false,
    reason: 'sandbox_activity',
  }],
};
const SESSION = {
  sessionId: 'extmcp_session_1',
  globalUserId: 'user:owner',
  serverId: 'generic-forum',
  mode: 'interactive',
  status: 'active',
  upstreamSessionId: 'upstream-old',
};


function bridgeCapability({ effect = 'read', toolName = 'forum.read', args = { topic: 'updates' }, activity = null, pendingAction = null, scopedGrant = null } = {}) {
  const scope = activity?.scope || { serverId: 'generic-forum', resourceId: 'forum-main', parameters: {} };
  const risk = activity?.risk || { envelopeId: 'owner-read-v1', allowedEffects: [effect], boundaryGrants: [] };
  return createBridgeExternalMcpOperationCapability({
    operationId: effect === 'read' ? 'operation-read-1' : 'operation-write-1',
    actorKey: activity?.actor?.key || 'actor-owner',
    globalUserId: 'user:owner',
    serverId: 'generic-forum',
    toolName,
    sessionId: SESSION.sessionId,
    activityId: activity?.activityId || '',
    actionId: activity ? 'action-post-1' : 'action-read-1',
    activityRevision: activity?.revision || 0,
    leaseOwner: activity?.leaseOwner || '',
    effect,
    profile: 'full',
    trigger: activity ? 'activity' : 'user_turn',
    watchScope: 'forum:main',
    preferredTransport: 'gateway',
    scope,
    risk,
    arguments: args,
    scopedGrant,
    pendingAction,
    issuedAt: NOW,
    expiresAt: new Date(NOW.getTime() + 60_000),
  });
}


function fakeActivityStore(activity) {
  let current = structuredClone(activity);
  return {
    get: () => structuredClone(current),
    compareAndSwap: (_activityId, input) => {
      if (input.expectedRevision !== current.revision) {
        return { ok: false, error_code: 'EXTERNAL_MCP_ACTIVITY_STALE_REVISION' };
      }
      current = { ...current, ...input.patch, revision: current.revision + 1 };
      return { ok: true, activity: structuredClone(current) };
    },
    commitCallback: (_activityId, input) => {
      if (input.expectedRevision !== current.revision || input.leaseOwner !== current.leaseOwner) {
        return { ok: false, error_code: 'EXTERNAL_MCP_ACTIVITY_STALE_REVISION' };
      }
      current = { ...current, ...input.patch, revision: current.revision + 1 };
      return { ok: true, activity: structuredClone(current) };
    },
  };
}


test('trusted bridge invocation composes registry, session, policy, transport and evidence before minting receipt', async () => {
  let calls = 0;
  const evidence = [];
  const capability = bridgeCapability();
  const service = createExternalMcpGatewayService({
    now: () => NOW,
    listManifests: () => [READ_MANIFEST],
    getSession: () => SESSION,
    router: {
      execute: async (input) => {
        calls += 1;
        assert.equal(input.operationId, capability.operationId);
        assert.equal(input.scopeDigest, capability.scopeDigest);
        assert.equal(input.riskDigest, capability.riskDigest);
        return { ok: true, route: 'gateway', result: { content: [{ type: 'text', text: 'result' }] }, attempts: [] };
      },
    },
    appendEvidence: (input) => {
      evidence.push(input);
      return { evidence_ref: 'external_mcp_evidence:trusted-1' };
    },
  });

  const response = await service.invoke({ capability, arguments: { topic: 'updates' } });

  assert.equal(response.ok, true);
  assert.equal(calls, 1);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].decision, 'allow');
  assert.equal(verifyExternalMcpOperationReceipt(response.receipt, { capability, now: NOW }).ok, true);
});


test('model-visible diagnostic wrapper is untrusted and cannot execute or mint a receipt', async () => {
  let calls = 0;
  const capability = bridgeCapability();
  const service = createExternalMcpGatewayService({
    now: () => NOW,
    listManifests: () => [READ_MANIFEST],
    getSession: () => SESSION,
    router: { execute: async () => { calls += 1; return { ok: true, result: {} }; } },
    appendEvidence: () => { throw new Error('diagnostic must not append trusted evidence'); },
  });

  const diagnostic = await service.diagnose({
    serverId: 'generic-forum',
    toolName: 'forum.read',
    sessionId: SESSION.sessionId,
    globalUserId: SESSION.globalUserId,
    profile: 'full',
  });
  assert.equal(diagnostic.ok, true);
  assert.equal(diagnostic.trusted, false);
  assert.equal(diagnostic.executable, false);
  assert.equal(Object.hasOwn(diagnostic, 'receipt'), false);
  assert.equal(calls, 0);

  const forged = await service.invoke({
    capability: JSON.parse(JSON.stringify(capability)),
    arguments: { topic: 'updates' },
  });
  assert.equal(forged.error_code, 'EXTERNAL_MCP_OPERATION_CAPABILITY_REQUIRED');
  assert.equal(calls, 0);
});


test('activity actor, revision, resource scope and risk must all match before transport', async () => {
  const activity = {
    activityId: 'activity-1',
    actor: { key: 'actor-owner', kind: 'owner' },
    scope: { serverId: 'generic-forum', resourceId: 'forum-main', parameters: {} },
    risk: { envelopeId: 'forum-owner-v1', allowedEffects: ['read'], boundaryGrants: [] },
    status: 'active',
    revision: 3,
    leaseOwner: null,
    leaseUntil: null,
    pendingOperation: null,
  };
  let calls = 0;
  const capability = bridgeCapability({ activity });
  const service = createExternalMcpGatewayService({
    now: () => NOW,
    listManifests: () => [READ_MANIFEST],
    getSession: () => SESSION,
    activityStore: fakeActivityStore({ ...activity, risk: { ...activity.risk, envelopeId: 'changed-risk' } }),
    router: { execute: async () => { calls += 1; return { ok: true, result: {} }; } },
  });

  const response = await service.invoke({ capability, arguments: { topic: 'updates' } });
  assert.equal(response.error_code, 'EXTERNAL_MCP_ACTIVITY_CONTEXT_MISMATCH');
  assert.equal(calls, 0);
  assert.notEqual(digestExternalMcpOperationValue(activity.risk), digestExternalMcpOperationValue({ ...activity.risk, envelopeId: 'changed-risk' }));
});


test('the one durably precommitted trusted operation may dispatch, while a different pending operation cannot replay', async () => {
  const activity = {
    activityId: 'activity-precommitted-read',
    actor: { key: 'actor-owner', kind: 'owner' },
    scope: { serverId: 'generic-forum', resourceId: 'forum-main', parameters: {} },
    risk: { envelopeId: 'forum-read-v1', allowedEffects: ['read'], boundaryGrants: [] },
    status: 'active', revision: 2, leaseOwner: null, leaseUntil: null, pendingOperation: null,
  };
  const capability = bridgeCapability({
    activity,
    scopedGrant: trustExternalMcpScopedGrant({
      grantId: 'grant-precommitted-read', serverId: 'generic-forum', toolName: 'forum.read', mode: 'interactive',
      expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
    }),
  });
  const precommitted = {
    ...activity,
    pendingOperation: {
      operationId: capability.operationId, actionId: capability.actionId, effect: capability.effect, status: 'pending',
      startedAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
    },
  };
  let calls = 0;
  const service = createExternalMcpGatewayService({
    now: () => NOW,
    listManifests: () => [READ_MANIFEST],
    getSession: () => SESSION,
    activityStore: fakeActivityStore(precommitted),
    router: { execute: async () => { calls += 1; return { ok: true, route: 'gateway', result: { ok: true } }; } },
    appendEvidence: () => ({ evidence_ref: 'external_mcp_evidence:precommitted-1' }),
  });

  const accepted = await service.invoke({ capability, arguments: { topic: 'updates' } });
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  assert.equal(calls, 1);

  const blocked = await service.invoke({
    capability: createBridgeExternalMcpOperationCapability({
      operationId: capability.operationId,
      actorKey: 'actor-owner', globalUserId: 'user:owner', serverId: 'generic-forum', toolName: 'forum.read',
      sessionId: SESSION.sessionId, activityId: activity.activityId, actionId: 'action-other', activityRevision: activity.revision,
      leaseOwner: '', effect: 'read', profile: 'full', trigger: 'activity', watchScope: 'forum:main', preferredTransport: 'gateway',
      scope: activity.scope, risk: activity.risk, arguments: { topic: 'updates' },
      scopedGrant: trustExternalMcpScopedGrant({
        grantId: 'grant-precommitted-other', serverId: 'generic-forum', toolName: 'forum.read', mode: 'interactive',
        expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
      }),
      issuedAt: NOW, expiresAt: new Date(NOW.getTime() + 60_000),
    }),
    arguments: { topic: 'updates' },
  });
  assert.equal(blocked.error_code, 'EXTERNAL_MCP_OPERATION_RETRY_BLOCKED');
  assert.equal(calls, 1);
});


test('effect timeout persists pendingOperation; reconcile unknown blocks and cannot retry', async () => {
  const activity = {
    activityId: 'activity-write-1',
    actor: { key: 'actor-owner', kind: 'owner' },
    scope: { serverId: 'generic-forum', resourceId: 'forum-main', parameters: {} },
    risk: { envelopeId: 'forum-write-v1', allowedEffects: ['effect'], boundaryGrants: ['forum.post'] },
    status: 'active',
    revision: 4,
    leaseOwner: null,
    leaseUntil: null,
    pendingOperation: null,
  };
  const store = fakeActivityStore(activity);
  const pendingAction = trustExternalMcpPendingAction({
    actionId: 'pending-action-1',
    actionType: 'forum_post',
    status: 'confirmed',
    expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
    serverId: 'generic-forum',
    toolName: 'forum.post',
  });
  const capability = bridgeCapability({
    effect: 'effect',
    toolName: 'forum.post',
    args: { text: 'hello' },
    activity,
    pendingAction,
  });
  let calls = 0;
  const service = createExternalMcpGatewayService({
    now: () => NOW,
    listManifests: () => [WRITE_MANIFEST],
    getSession: () => SESSION,
    activityStore: store,
    router: {
      execute: async () => {
        calls += 1;
        return {
          ok: false,
          outcome: 'unknown',
          needsReconciliation: true,
          errorCode: 'EXTERNAL_MCP_ABORTED',
          attempts: [{ route: 'gateway', outcome: 'unknown' }],
        };
      },
    },
    reconcileOperation: async () => 'unknown',
    appendEvidence: () => ({ evidence_ref: 'external_mcp_evidence:failed-1' }),
  });

  const first = await service.invoke({ capability, arguments: { text: 'hello' } });
  assert.equal(first.outcome, 'unknown');
  assert.equal(store.get().pendingOperation.operationId, capability.operationId);
  assert.equal(store.get().pendingOperation.status, 'unknown');

  const reconcileCapability = createBridgeExternalMcpOperationCapability({
    ...bridgeCapabilityInputForRetry(capability, store.get()),
    arguments: { text: 'hello' },
    pendingAction,
    issuedAt: NOW,
    expiresAt: new Date(NOW.getTime() + 60_000),
  });
  const reconciled = await service.reconcile({ capability: reconcileCapability, observation: {} });
  assert.equal(reconciled.outcome, 'unknown');
  assert.equal(store.get().pendingOperation.status, 'unknown');

  const retryCapability = createBridgeExternalMcpOperationCapability({
    ...bridgeCapabilityInputForRetry(reconcileCapability, store.get()),
    arguments: { text: 'hello' },
    pendingAction,
    issuedAt: NOW,
    expiresAt: new Date(NOW.getTime() + 60_000),
  });
  const retried = await service.retry({ capability: retryCapability, arguments: { text: 'hello' } });
  assert.equal(retried.error_code, 'EXTERNAL_MCP_OPERATION_RETRY_BLOCKED');
  assert.equal(calls, 1);
});


test('a sandbox-game play is effectful even at T3: a known failure has one provider attempt and remains unknown', async () => {
  const activity = {
    activityId: 'activity-game-play-1',
    actor: { key: 'actor-owner', kind: 'owner' },
    scope: { serverId: 'cedar-toy', resourceId: 'forest', parameters: {} },
    risk: { envelopeId: 'game-owner-v1', allowedEffects: ['read', 'write'], boundaryGrants: [] },
    status: 'active', revision: 1, leaseOwner: null, leaseUntil: null, pendingOperation: null,
  };
  const store = fakeActivityStore(activity);
  const capability = createBridgeExternalMcpOperationCapability({
    operationId: 'operation-game-play-1', actorKey: 'actor-owner', globalUserId: 'user:owner',
    serverId: 'cedar-toy', toolName: 'play', sessionId: SESSION.sessionId,
    activityId: activity.activityId, actionId: 'action-game-play-1', activityRevision: activity.revision,
    leaseOwner: '', effect: 'write', profile: 'full', trigger: 'activity', watchScope: 'forest', preferredTransport: 'gateway',
    scope: activity.scope, risk: activity.risk, arguments: { game_id: 'forest', action: 'north' },
    scopedGrant: trustExternalMcpScopedGrant({
      grantId: 'game-play-grant-1', kind: 'game_play', serverId: 'cedar-toy', allowedToolPattern: '^play$', mode: 'interactive',
      expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
    }),
    issuedAt: NOW, expiresAt: new Date(NOW.getTime() + 60_000),
  });
  let calls = 0;
  const service = createExternalMcpGatewayService({
    now: () => NOW,
    listManifests: () => [GAME_MANIFEST],
    getSession: () => ({ ...SESSION, serverId: 'cedar-toy' }),
    activityStore: store,
    router: { execute: async () => {
      calls += 1;
      return { ok: false, error_code: 'EXTERNAL_MCP_TRANSPORT_FAILED' };
    } },
  });

  const result = await service.invoke({ capability, arguments: { game_id: 'forest', action: 'north' } });

  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'unknown');
  assert.equal(result.needsReconciliation, true);
  assert.equal(calls, 1);
  assert.equal(store.get().pendingOperation.status, 'unknown');
});


test('a successful sandbox-game play preserves an effect receipt and evidence', async () => {
  const activity = {
    activityId: 'activity-game-play-success',
    actor: { key: 'actor-owner', kind: 'owner' },
    scope: { serverId: 'cedar-toy', resourceId: 'forest', parameters: {} },
    risk: { envelopeId: 'game-owner-v1', allowedEffects: ['read', 'write'], boundaryGrants: [] },
    status: 'active', revision: 1, leaseOwner: null, leaseUntil: null, pendingOperation: null,
  };
  const store = fakeActivityStore(activity);
  const capability = createBridgeExternalMcpOperationCapability({
    operationId: 'operation-game-play-success', actorKey: 'actor-owner', globalUserId: 'user:owner',
    serverId: 'cedar-toy', toolName: 'play', sessionId: SESSION.sessionId,
    activityId: activity.activityId, actionId: 'action-game-play-success', activityRevision: activity.revision,
    leaseOwner: '', effect: 'write', profile: 'full', trigger: 'activity', watchScope: 'forest', preferredTransport: 'gateway',
    scope: activity.scope, risk: activity.risk, arguments: { game_id: 'forest', action: 'north' },
    scopedGrant: trustExternalMcpScopedGrant({
      grantId: 'game-play-grant-success', kind: 'game_play', serverId: 'cedar-toy', allowedToolPattern: '^play$', mode: 'interactive',
      expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
    }),
    issuedAt: NOW, expiresAt: new Date(NOW.getTime() + 60_000),
  });
  const service = createExternalMcpGatewayService({
    now: () => NOW,
    listManifests: () => [GAME_MANIFEST],
    getSession: () => ({ ...SESSION, serverId: 'cedar-toy' }),
    activityStore: store,
    router: { execute: async () => ({ ok: true, route: 'gateway', result: { accepted: true } }) },
    appendEvidence: () => ({ evidence_ref: 'external_mcp_evidence:game-play-success' }),
  });

  const result = await service.invoke({ capability, arguments: { game_id: 'forest', action: 'north' } });

  assert.equal(result.ok, true);
  assert.equal(result.receipt.effect, 'write');
  assert.equal(result.receipt.evidenceRef, 'external_mcp_evidence:game-play-success');
  assert.equal(store.get().pendingOperation, null);
  assert.equal(verifyExternalMcpOperationReceipt(result.receipt, { capability, now: NOW }).ok, true);
});


test('effectful explicit not_applied is durably terminal before retry', async () => {
  const activity = {
    activityId: 'activity-write-not-applied',
    actor: { key: 'actor-owner', kind: 'owner' },
    scope: { serverId: 'generic-forum', resourceId: 'forum-main', parameters: {} },
    risk: { envelopeId: 'forum-write-v1', allowedEffects: ['effect'], boundaryGrants: ['forum.post'] },
    status: 'active', revision: 1, leaseOwner: null, leaseUntil: null, pendingOperation: null,
  };
  const pendingAction = trustExternalMcpPendingAction({
    actionId: 'pending-action-not-applied', actionType: 'forum_post', status: 'confirmed',
    expiresAt: new Date(NOW.getTime() + 60_000).toISOString(), serverId: 'generic-forum', toolName: 'forum.post',
  });
  const capability = createBridgeExternalMcpOperationCapability({
    ...bridgeCapabilityInputForRetry(null, activity), arguments: { text: 'hello' }, pendingAction,
    issuedAt: NOW, expiresAt: new Date(NOW.getTime() + 60_000),
  });
  const store = fakeActivityStore(activity);
  const service = createExternalMcpGatewayService({
    now: () => NOW, listManifests: () => [WRITE_MANIFEST], getSession: () => SESSION, activityStore: store,
    router: { execute: async () => ({ ok: false, outcome: 'not_applied', error_code: 'REMOTE_REJECTED' }) },
  });

  const result = await service.invoke({ capability, arguments: { text: 'hello' } });
  assert.equal(result.outcome, 'not_applied');
  assert.equal(store.get().pendingOperation.status, 'not_applied');
});


test('reconcile not_applied is the sole path that permits one effect retry', async () => {
  const activity = {
    activityId: 'activity-write-2',
    actor: { key: 'actor-owner', kind: 'owner' },
    scope: { serverId: 'generic-forum', resourceId: 'forum-main', parameters: {} },
    risk: { envelopeId: 'forum-write-v1', allowedEffects: ['effect'], boundaryGrants: ['forum.post'] },
    status: 'active',
    revision: 10,
    leaseOwner: null,
    leaseUntil: null,
    pendingOperation: {
      operationId: 'operation-write-1',
      actionId: 'action-post-1',
      effect: 'effect',
      status: 'pending',
      startedAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    },
  };
  const store = fakeActivityStore(activity);
  const pendingAction = trustExternalMcpPendingAction({
    actionId: 'pending-action-2',
    actionType: 'forum_post',
    status: 'confirmed',
    expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
    serverId: 'generic-forum',
    toolName: 'forum.post',
  });
  const initialCapability = createBridgeExternalMcpOperationCapability({
    ...bridgeCapabilityInputForRetry(null, activity),
    arguments: { text: 'hello' },
    pendingAction,
    issuedAt: NOW,
    expiresAt: new Date(NOW.getTime() + 60_000),
  });
  let calls = 0;
  const service = createExternalMcpGatewayService({
    now: () => NOW,
    listManifests: () => [WRITE_MANIFEST],
    getSession: () => SESSION,
    activityStore: store,
    router: {
      execute: async () => {
        calls += 1;
        return { ok: true, route: 'direct', result: { applied: true }, attempts: [] };
      },
    },
    reconcileOperation: async () => 'not_applied',
    appendEvidence: () => ({ evidence_ref: 'external_mcp_evidence:retry-1' }),
  });

  const reconciled = await service.reconcile({ capability: initialCapability, observation: {} });
  assert.equal(reconciled.outcome, 'not_applied');
  assert.equal(store.get().pendingOperation.status, 'not_applied');

  const retryCapability = createBridgeExternalMcpOperationCapability({
    ...bridgeCapabilityInputForRetry(initialCapability, store.get()),
    arguments: { text: 'hello' },
    pendingAction,
    issuedAt: NOW,
    expiresAt: new Date(NOW.getTime() + 60_000),
  });
  const retried = await service.retry({ capability: retryCapability, arguments: { text: 'hello' } });
  assert.equal(retried.ok, true);
  assert.equal(calls, 1);
  assert.equal(store.get().pendingOperation, null);
  assert.equal(verifyExternalMcpOperationReceipt(retried.receipt, { capability: retryCapability, now: NOW }).ok, true);
});


function bridgeCapabilityInputForRetry(previousCapability, activity) {
  return {
    operationId: previousCapability?.operationId || 'operation-write-1',
    actorKey: 'actor-owner',
    globalUserId: 'user:owner',
    serverId: 'generic-forum',
    toolName: 'forum.post',
    sessionId: SESSION.sessionId,
    activityId: activity.activityId,
    actionId: 'action-post-1',
    activityRevision: activity.revision,
    leaseOwner: activity.leaseOwner || '',
    effect: 'effect',
    profile: 'full',
    trigger: 'activity',
    watchScope: 'forum:main',
    preferredTransport: 'gateway',
    scope: activity.scope,
    risk: activity.risk,
  };
}
