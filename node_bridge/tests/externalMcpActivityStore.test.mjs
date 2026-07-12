import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createExternalMcpActivityStore } from '../src/externalMcp/activityStore.mjs';
import { registerTestCleanup } from './helpers/isolatedState.mjs';


function fixture(t) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'external-activity-store-'));
  registerTestCleanup(t, () => fs.rmSync(dir, { recursive: true, force: true }));
  return {
    dir,
    target: path.join(dir, 'activities.json'),
    store: createExternalMcpActivityStore({ statePath: path.join(dir, 'activities.json') }),
  };
}


function activityInput(overrides = {}) {
  return {
    activityId: 'activity-1',
    actor: { key: 'actor-hash', kind: 'owner' },
    domain: 'game',
    driverId: 'generic-mcp-adapter',
    goal: { text: 'Continue the selected game', constraints: ['stay in selected game'] },
    scope: { serverId: 'configured-game', resourceId: 'game:forest', parameters: {} },
    risk: { envelopeId: 'game-owner-v1', allowedEffects: ['read', 'write'], boundaryGrants: [] },
    status: 'active',
    checkpoint: {
      stateDigest: '',
      summary: '',
      terminal: false,
      evidenceRefs: [],
      updatedAt: null,
    },
    pendingOperation: null,
    nextWake: '2026-07-10T12:00:00.000Z',
    notifyTarget: {
      platform: 'wechat',
      channelType: 'dm',
      conversationId: 'conversation-private',
      senderId: 'owner-private',
    },
    ...overrides,
  };
}


test('creates one explicit versioned activity record with all durable fields', (t) => {
  const { store, target } = fixture(t);
  const created = store.create(activityInput(), { now: '2026-07-10T10:00:00.000Z' });

  assert.equal(created.ok, true);
  assert.deepEqual(Object.keys(created.activity).sort(), [
    'activityId',
    'actor',
    'checkpoint',
    'coreJobReceipt',
    'domain',
    'driverId',
    'goal',
    'leaseOwner',
    'leaseUntil',
    'nextWake',
    'notifyTarget',
    'pendingOperation',
    'revision',
    'risk',
    'scope',
    'status',
    'timestamps',
  ]);
  assert.equal(created.activity.revision, 1);
  assert.equal(created.activity.leaseOwner, null);
  assert.equal(created.activity.leaseUntil, null);
  assert.equal(created.activity.coreJobReceipt, null);
  assert.deepEqual(created.activity.timestamps, {
    createdAt: '2026-07-10T10:00:00.000Z',
    updatedAt: '2026-07-10T10:00:00.000Z',
    startedAt: '2026-07-10T10:00:00.000Z',
    stoppedAt: null,
    completedAt: null,
  });
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  assert.equal(store.get('activity-1').activityId, 'activity-1');
});


test('persists the bounded tool, arguments, and session context needed to reconcile an unknown operation', (t) => {
  const { store } = fixture(t);
  store.create(activityInput(), { now: '2026-07-10T10:00:00.000Z' });
  const saved = store.compareAndSwap('activity-1', {
    expectedRevision: 1,
    patch: { pendingOperation: {
      operationId: 'operation-play-1', actionId: 'action-play-1', toolName: 'play', effect: 'write',
      arguments: { game_id: 'forest', action: 'north' }, sessionId: 'extmcp_session_1', status: 'unknown',
      startedAt: '2026-07-10T10:00:00.000Z', updatedAt: '2026-07-10T10:00:01.000Z',
    } },
    now: '2026-07-10T10:00:01.000Z',
  });

  assert.equal(saved.ok, true);
  assert.deepEqual(store.get('activity-1').pendingOperation, {
    operationId: 'operation-play-1', actionId: 'action-play-1', toolName: 'play', effect: 'write',
    arguments: { game_id: 'forest', action: 'north' }, sessionId: 'extmcp_session_1', status: 'unknown',
    startedAt: '2026-07-10T10:00:00.000Z', updatedAt: '2026-07-10T10:00:01.000Z',
  });
});


test('rejects internally inconsistent terminal records at creation', (t) => {
  const { store } = fixture(t);

  const result = store.create(activityInput({ status: 'stopped' }), {
    now: '2026-07-10T10:00:00.000Z',
  });

  assert.equal(result.error_code, 'EXTERNAL_MCP_ACTIVITY_INVALID');
  assert.deepEqual(store.list(), []);
});


test('migrates a legacy read-only array while preserving its mode and later atomic updates', (t) => {
  const { store, target } = fixture(t);
  fs.writeFileSync(target, JSON.stringify([
    {
      activityId: 'legacy-active',
      globalUserId: 'private-user-id',
      serverId: 'configured-game',
      kind: 'game_play',
      status: 'active',
      watchScope: 'game:legacy',
      createdAt: '2026-07-09T10:00:00.000Z',
      nextRunAt: '2026-07-10T10:00:00.000Z',
      notifyTarget: { platform: 'wechat', channel_type: 'dm', conversation_id: 'c1', sender_id: 'u1' },
    },
    {
      activityId: 'legacy-stopped',
      globalUserId: 'private-user-id',
      serverId: 'configured-forum',
      kind: 'forum_read',
      status: 'stopped',
      createdAt: '2026-07-09T10:00:00.000Z',
    },
  ]));
  fs.chmodSync(target, 0o400);

  const activities = store.list({ now: '2026-07-10T11:00:00.000Z' });

  assert.equal(activities.length, 2);
  assert.equal(activities[0].status, 'paused');
  assert.equal(activities[0].actor.key.length, 64);
  assert.notEqual(activities[0].actor.key, 'private-user-id');
  assert.deepEqual(activities[0].risk.allowedEffects, []);
  assert.deepEqual(activities[0].risk.boundaryGrants, []);
  assert.equal(activities[0].nextWake, null);
  assert.equal(activities[1].status, 'stopped');
  assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).schemaVersion, 1);
  assert.equal(fs.statSync(target).mode & 0o777, 0o400);

  const updated = store.compareAndSwap('legacy-active', {
    expectedRevision: 1,
    patch: { nextWake: '2026-07-10T12:00:00.000Z' },
    now: '2026-07-10T11:01:00.000Z',
  });
  assert.equal(updated.ok, true);
  assert.equal(store.get('legacy-active').nextWake, '2026-07-10T12:00:00.000Z');
  assert.equal(fs.statSync(target).mode & 0o777, 0o400);
});


test('legacy migration waits for the single-writer lock instead of overwriting a newer writer', (t) => {
  const { store, target } = fixture(t);
  fs.writeFileSync(target, JSON.stringify([{
    activityId: 'legacy-active',
    globalUserId: 'private-user-id',
    serverId: 'configured-game',
    kind: 'game_play',
    status: 'active',
  }]));
  fs.writeFileSync(`${target}.lock`, 'another writer');

  assert.throws(
    () => store.list(),
    (error) => error?.code === 'EXTERNAL_MCP_ACTIVITY_STORE_BUSY',
  );
  assert.equal(Array.isArray(JSON.parse(fs.readFileSync(target, 'utf8'))), true);

  fs.rmSync(`${target}.lock`);
  assert.equal(store.list().length, 1);
  assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).schemaVersion, 1);
});


test('quarantines truncated or incompatible state and fails closed', (t) => {
  const { dir, target } = fixture(t);
  for (const [name, content] of [
    ['truncated', '{'],
    ['incompatible', JSON.stringify({ schemaVersion: 99, activities: [] })],
    ['unsafe-legacy', JSON.stringify([{ activityId: '', status: 'active' }])],
  ]) {
    fs.writeFileSync(target, content);
    const store = createExternalMcpActivityStore({ statePath: target });
    assert.throws(
      () => store.list(),
      (error) => error?.code === 'RAN_AGENT_STATE_CORRUPT',
      name,
    );
    assert.equal(fs.existsSync(target), false);
    assert.equal(fs.readdirSync(dir).some((entry) => entry.startsWith('activities.json.corrupt-')), true);
    assert.throws(
      () => store.list(),
      (error) => error?.code === 'RAN_AGENT_STATE_CORRUPT',
      `${name} remains fail-closed after quarantine`,
    );
  }
});


test('compareAndSwap increments revision and rejects stale writers without mutation', (t) => {
  const { store } = fixture(t);
  store.create(activityInput(), { now: '2026-07-10T10:00:00.000Z' });

  const stale = store.compareAndSwap('activity-1', {
    expectedRevision: 0,
    patch: { nextWake: '2026-07-10T12:30:00.000Z' },
    now: '2026-07-10T10:01:00.000Z',
  });
  const committed = store.compareAndSwap('activity-1', {
    expectedRevision: 1,
    patch: {
      checkpoint: {
        stateDigest: 'sha256:checkpoint',
        summary: 'Reached the next room',
        terminal: false,
        evidenceRefs: ['evidence:1'],
        updatedAt: '2026-07-10T10:01:00.000Z',
      },
      pendingOperation: {
        operationId: 'operation-1',
        actionId: 'action-1',
        effect: 'write',
        status: 'unknown',
        startedAt: '2026-07-10T10:00:30.000Z',
        updatedAt: '2026-07-10T10:01:00.000Z',
      },
      nextWake: '2026-07-10T12:30:00.000Z',
    },
    now: '2026-07-10T10:01:00.000Z',
  });

  assert.deepEqual(stale, {
    ok: false,
    error: 'activity revision is stale',
    error_code: 'EXTERNAL_MCP_ACTIVITY_STALE_REVISION',
    currentRevision: 1,
  });
  assert.equal(committed.ok, true);
  assert.equal(committed.activity.revision, 2);
  assert.equal(committed.activity.pendingOperation.operationId, 'operation-1');
  assert.equal(store.get('activity-1').nextWake, '2026-07-10T12:30:00.000Z');
});


test('adjustScope CAS allows equal or strict structured narrowing and rejects every widening', (t) => {
  const { store } = fixture(t);
  store.create(activityInput({
    scope: {
      serverId: 'configured-game',
      resourceId: 'game:forest',
      parameters: { areas: ['hall', 'kitchen'], modes: ['observe', 'play'] },
    },
  }), { now: '2026-07-10T10:00:00.000Z' });

  const narrowed = store.adjustScope('activity-1', {
    expectedRevision: 1,
    newScope: {
      serverId: 'configured-game',
      resourceId: 'game:forest',
      parameters: { areas: ['kitchen'], modes: ['observe', 'play'] },
    },
    now: '2026-07-10T10:01:00.000Z',
  });
  const equal = store.adjustScope('activity-1', {
    expectedRevision: 2,
    newScope: narrowed.activity.scope,
    now: '2026-07-10T10:02:00.000Z',
  });
  const widenedArray = store.adjustScope('activity-1', {
    expectedRevision: 2,
    newScope: {
      ...narrowed.activity.scope,
      parameters: { areas: ['hall', 'kitchen'], modes: ['observe', 'play'] },
    },
    now: '2026-07-10T10:03:00.000Z',
  });
  const addedKey = store.adjustScope('activity-1', {
    expectedRevision: 2,
    newScope: {
      ...narrowed.activity.scope,
      parameters: { ...narrowed.activity.scope.parameters, newBoundary: true },
    },
    now: '2026-07-10T10:03:00.000Z',
  });
  const widenedRisk = store.adjustScope('activity-1', {
    expectedRevision: 2,
    newScope: narrowed.activity.scope,
    newRisk: {
      ...narrowed.activity.risk,
      allowedEffects: [...narrowed.activity.risk.allowedEffects, 'payment'],
    },
    now: '2026-07-10T10:03:00.000Z',
  });

  assert.equal(narrowed.ok, true);
  assert.equal(narrowed.activity.revision, 2);
  assert.deepEqual(narrowed.activity.scope.parameters.areas, ['kitchen']);
  assert.equal(equal.idempotent, true);
  assert.equal(equal.activity.revision, 2);
  for (const result of [widenedArray, addedKey, widenedRisk]) {
    assert.equal(result.error_code, 'EXTERNAL_MCP_ACTIVITY_SCOPE_WIDENING_REQUIRES_BOUNDARY');
  }
  assert.equal(store.get('activity-1').revision, 2);
});


test('persisted lease lets only one runner acquire and only its owner release', (t) => {
  const { target } = fixture(t);
  const runnerA = createExternalMcpActivityStore({ statePath: target });
  const runnerB = createExternalMcpActivityStore({ statePath: target });
  runnerA.create(activityInput(), { now: '2026-07-10T10:00:00.000Z' });

  const acquired = runnerA.acquireLease('activity-1', {
    expectedRevision: 1,
    leaseOwner: 'runner-a',
    leaseMs: 30_000,
    now: '2026-07-10T10:01:00.000Z',
  });
  const staleRace = runnerB.acquireLease('activity-1', {
    expectedRevision: 1,
    leaseOwner: 'runner-b',
    leaseMs: 30_000,
    now: '2026-07-10T10:01:00.000Z',
  });
  const held = runnerB.acquireLease('activity-1', {
    expectedRevision: 2,
    leaseOwner: 'runner-b',
    leaseMs: 30_000,
    now: '2026-07-10T10:01:01.000Z',
  });
  const wrongOwner = runnerB.releaseLease('activity-1', {
    expectedRevision: 2,
    leaseOwner: 'runner-b',
    now: '2026-07-10T10:01:02.000Z',
  });
  const released = runnerA.releaseLease('activity-1', {
    expectedRevision: 2,
    leaseOwner: 'runner-a',
    now: '2026-07-10T10:01:02.000Z',
  });

  assert.equal(acquired.ok, true);
  assert.equal(acquired.activity.revision, 2);
  assert.equal(acquired.activity.leaseOwner, 'runner-a');
  assert.equal(staleRace.error_code, 'EXTERNAL_MCP_ACTIVITY_STALE_REVISION');
  assert.equal(held.error_code, 'EXTERNAL_MCP_ACTIVITY_LEASE_HELD');
  assert.equal(wrongOwner.error_code, 'EXTERNAL_MCP_ACTIVITY_LEASE_OWNER_MISMATCH');
  assert.equal(released.ok, true);
  assert.equal(released.activity.revision, 3);
  assert.equal(released.activity.leaseOwner, null);
});


test('serializes read-CAS-write transactions with a fail-closed sibling lock', (t) => {
  const { store, target } = fixture(t);
  store.create(activityInput(), { now: '2026-07-10T10:00:00.000Z' });
  fs.writeFileSync(`${target}.lock`, 'another runner');

  const blocked = store.acquireLease('activity-1', {
    expectedRevision: 1,
    leaseOwner: 'runner-b',
    leaseMs: 30_000,
    now: '2026-07-10T10:01:00.000Z',
  });

  assert.equal(blocked.error_code, 'EXTERNAL_MCP_ACTIVITY_STORE_BUSY');
  assert.equal(store.get('activity-1').revision, 1);
  assert.equal(store.get('activity-1').leaseOwner, null);
});


test('stopped activities and stale callbacks cannot restore or advance state', (t) => {
  const { store } = fixture(t);
  store.create(activityInput(), { now: '2026-07-10T10:00:00.000Z' });
  const acquired = store.acquireLease('activity-1', {
    expectedRevision: 1,
    leaseOwner: 'runner-a',
    leaseMs: 30_000,
    now: '2026-07-10T10:01:00.000Z',
  });
  const stopped = store.stop('activity-1', {
    expectedRevision: acquired.activity.revision,
    reason: 'owner_stop',
    now: '2026-07-10T10:01:01.000Z',
  });
  const late = store.commitCallback('activity-1', {
    expectedRevision: acquired.activity.revision,
    leaseOwner: 'runner-a',
    patch: { status: 'active', nextWake: '2026-07-10T10:02:00.000Z' },
    now: '2026-07-10T10:01:02.000Z',
  });

  assert.equal(stopped.ok, true);
  assert.equal(stopped.activity.status, 'stopped');
  assert.equal(stopped.activity.pendingOperation, null);
  assert.equal(stopped.activity.nextWake, null);
  assert.equal(stopped.activity.leaseOwner, null);
  assert.equal(late.error_code, 'EXTERNAL_MCP_ACTIVITY_STOPPED');
  assert.equal(store.get('activity-1').status, 'stopped');

  store.create(activityInput({ activityId: 'activity-2' }), { now: '2026-07-10T10:02:00.000Z' });
  const lease2 = store.acquireLease('activity-2', {
    expectedRevision: 1,
    leaseOwner: 'runner-a',
    leaseMs: 30_000,
    now: '2026-07-10T10:02:01.000Z',
  });
  store.compareAndSwap('activity-2', {
    expectedRevision: lease2.activity.revision,
    leaseOwner: 'runner-a',
    patch: { nextWake: '2026-07-10T10:03:00.000Z' },
    now: '2026-07-10T10:02:02.000Z',
  });
  const staleCallback = store.commitCallback('activity-2', {
    expectedRevision: lease2.activity.revision,
    leaseOwner: 'runner-a',
    patch: { nextWake: '2026-07-10T10:04:00.000Z' },
    now: '2026-07-10T10:02:03.000Z',
  });
  assert.equal(staleCallback.error_code, 'EXTERNAL_MCP_ACTIVITY_STALE_REVISION');
});


test('actor-scoped stop-all is one atomic durable transaction: it never partially stops on a sibling lock or race', (t) => {
  const { target } = fixture(t);
  const first = createExternalMcpActivityStore({ statePath: target });
  const second = createExternalMcpActivityStore({ statePath: target });
  first.create(activityInput({ activityId: 'activity-one' }), { now: '2026-07-10T10:00:00.000Z' });
  first.create(activityInput({ activityId: 'activity-two' }), { now: '2026-07-10T10:00:00.000Z' });
  first.create(activityInput({ activityId: 'foreign-activity', actor: { key: 'other-hash', kind: 'owner' } }), { now: '2026-07-10T10:00:00.000Z' });

  fs.writeFileSync(`${target}.lock`, 'another runner');
  const locked = second.stopAllForActor({ actorKey: 'actor-hash', now: '2026-07-10T10:01:00.000Z' });
  assert.equal(locked.error_code, 'EXTERNAL_MCP_ACTIVITY_STORE_BUSY');
  assert.equal(first.get('activity-one').status, 'active');
  assert.equal(first.get('activity-two').status, 'active');
  fs.rmSync(`${target}.lock`);

  const stopped = first.stopAllForActor({ actorKey: 'actor-hash', now: '2026-07-10T10:01:01.000Z' });
  assert.equal(stopped.ok, true);
  assert.deepEqual(stopped.aggregate.activityIds, ['activity-one', 'activity-two']);
  assert.match(stopped.aggregate.transactionId, /^stopall_/);
  assert.equal(first.get('activity-one').status, 'stopped');
  assert.equal(first.get('activity-two').status, 'stopped');
  assert.equal(first.get('foreign-activity').status, 'active');

  const raced = second.stopAllForActor({ actorKey: 'actor-hash', now: '2026-07-10T10:01:02.000Z' });
  assert.equal(raced.error_code, 'EXTERNAL_MCP_ACTIVITY_STOP_ALL_NO_MATCH');
  assert.equal(second.get('foreign-activity').status, 'active');
});


test('approved boundary resume atomically adopts the supplied scope and risk only from a paused CAS revision', (t) => {
  const { store } = fixture(t);
  store.create(activityInput({ status: 'paused', nextWake: null }), { now: '2026-07-10T10:00:00.000Z' });
  const resumed = store.resumeWithApprovedBoundary('activity-1', {
    expectedRevision: 1,
    actorKey: 'actor-hash',
    newScope: {
      serverId: 'configured-game', resourceId: 'game:forest', parameters: { areas: ['hall', 'outside'] },
    },
    newRisk: { envelopeId: 'game-owner-v2', allowedEffects: ['read', 'write'], boundaryGrants: ['boundary-approved'] },
    now: '2026-07-10T10:01:00.000Z',
  });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.activity.status, 'active');
  assert.ok(resumed.activity.nextWake);
  assert.deepEqual(resumed.activity.scope.parameters.areas, ['hall', 'outside']);
  assert.equal(resumed.activity.risk.envelopeId, 'game-owner-v2');

  const stale = store.resumeWithApprovedBoundary('activity-1', {
    expectedRevision: 1,
    actorKey: 'actor-hash',
    newScope: resumed.activity.scope,
    newRisk: resumed.activity.risk,
    now: '2026-07-10T10:02:00.000Z',
  });
  assert.equal(stale.error_code, 'EXTERNAL_MCP_ACTIVITY_NOT_PAUSED');
});
