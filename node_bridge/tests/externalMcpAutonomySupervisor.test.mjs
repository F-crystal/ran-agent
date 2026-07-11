import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createExternalMcpActivityStore } from '../src/externalMcp/activityStore.mjs';
import { createExternalMcpActivityFacade } from '../src/externalMcp/activityFacade.mjs';
import {
  createExternalMcpAutonomySupervisor,
  mintTrustedExternalMcpBoundaryApproval,
} from '../src/externalMcp/autonomySupervisor.mjs';
import { registerTestCleanup } from './helpers/isolatedState.mjs';


function fixture(t) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'autonomy-supervisor-'));
  registerTestCleanup(t, () => fs.rmSync(dir, { recursive: true, force: true }));
  return {
    dir,
    store: createExternalMcpActivityStore({ statePath: path.join(dir, 'activities.json') }),
  };
}


function startInput(overrides = {}) {
  return {
    actorKey: 'owner-actor',
    conversationKey: 'owner-conversation',
    domain: 'game',
    goal: {
      text: 'Continue the selected game',
      constraints: ['stay inside selected game'],
      resourceId: 'game:forest',
      parameters: { areas: ['hall', 'kitchen'] },
    },
    manifest: { id: 'configured-game' },
    trustedContext: { allowedResourceIds: ['game:forest'] },
    risk: { envelopeId: 'game-owner-v1', allowedEffects: ['read', 'write'], boundaryGrants: [] },
    notifyTarget: { platform: 'wechat', channelType: 'dm', conversationId: 'c1', senderId: 'u1' },
    ...overrides,
  };
}


function scriptedAdapter(script = {}) {
  const calls = script.calls || [];
  let observationIndex = 0;
  let receiptIndex = 0;
  return {
    descriptor: { capabilities: { typedTerminal: script.typedTerminal === true } },
    resolveScope(goal, manifest) {
      calls.push('resolveScope');
      return script.resolvedScope || {
        serverId: manifest.id,
        resourceId: goal.resourceId || 'game:forest',
        parameters: goal.parameters || {},
        constraints: [],
      };
    },
    async observe() {
      calls.push('observe');
      if (script.observeBarrier) await script.observeBarrier();
      const observations = script.observations || [{ summary: 'Observed checkpoint.', quality: 'structured', terminal: false }];
      return observations[Math.min(observationIndex++, observations.length - 1)];
    },
    reconcile() {
      calls.push('reconcile');
      return script.reconcile || 'unknown';
    },
    legalActions() {
      calls.push('legalActions');
      return script.legalActions || [{ actionId: 'action-play', effect: 'write', availability: 'available' }];
    },
    async execute(actionId, operationId) {
      calls.push(`execute:${actionId}`);
      if (script.onExecute) await script.onExecute({ actionId, operationId });
      const receipts = script.receipts || [{
        effect: 'write',
        outcome: 'applied',
        evidence: { format: 'text', text: 'Advanced one checkpoint.', untrusted: true, error: false },
        observation: { summary: 'Advanced one checkpoint.', quality: 'text', terminal: false },
      }];
      return receipts[Math.min(receiptIndex++, receipts.length - 1)];
    },
    classify(_goal, observation, receipt) {
      calls.push('classify');
      if (script.typedTerminal === true && observation?.terminal === true) return { status: 'completed' };
      if (receipt?.outcome === 'unknown') return { status: 'blocked' };
      return { status: 'ongoing' };
    },
  };
}


function planner(calls, choose = 'action-play') {
  return {
    async chooseAction() {
      calls.push('planner');
      return { status: 'selected', actionId: choose, attempts: 1 };
    },
  };
}


function coreReceipt(actorKey, goalDigest, status = 'active', jobId = `job_external_${goalDigest.slice(0, 24)}`) {
  return {
    jobId,
    actorKey,
    goalDigest,
    status,
    nextRunAt: '2026-07-10T10:00:00.000Z',
    terminalStates: ['completed', 'blocked', 'stopped', 'expired'],
  };
}


function coreJobOptions(store) {
  return {
    async createCoreJob(input) {
      return coreReceipt(input.actorKey, input.goalDigest);
    },
    async terminalizeCoreJob(jobId, input) {
      const activity = store.list().find((item) => item.coreJobReceipt?.jobId === jobId);
      return coreReceipt(activity.coreJobReceipt.actorKey, activity.coreJobReceipt.goalDigest, input.terminalState, jobId);
    },
  };
}


function attachCoreReceipt(store, activityId, actorKey, goalDigest) {
  const activity = store.get(activityId);
  const saved = store.compareAndSwap(activityId, {
    expectedRevision: activity.revision,
    patch: { coreJobReceipt: coreReceipt(actorKey, goalDigest) },
    now: '2026-07-10T10:00:00.000Z',
  });
  assert.equal(saved.ok, true);
  return saved.activity.coreJobReceipt;
}


test('facade bridge lists only the hashed trusted actor scope and returns no runtime-private fields', async (t) => {
  const { store } = fixture(t);
  const supervisor = createExternalMcpAutonomySupervisor({
    store,
    adapterResolver: () => scriptedAdapter(),
    planner: planner([]),
    now: () => new Date('2026-07-10T10:00:00.000Z'),
  });
  supervisor.startOrResume(startInput());
  supervisor.startOrResume(startInput({ actorKey: 'other-actor', conversationKey: 'other-conversation' }));

  const listed = await supervisor.listActivities({
    actorKey: 'owner-actor',
    conversationKey: 'owner-conversation',
  });

  assert.equal(listed.length, 1);
  assert.equal(listed[0].actorKey, 'owner-actor');
  assert.equal(listed[0].conversationKey, 'owner-conversation');
  assert.equal(listed[0].committed, true);
  assert.equal(listed[0].firstWakeCommitted, true);
  assert.equal(typeof listed[0].goalDigest, 'string');
  assert.equal(Object.hasOwn(listed[0], 'scope'), false);
  assert.equal(Object.hasOwn(listed[0], 'risk'), false);
  assert.equal(Object.hasOwn(listed[0], 'notifyTarget'), false);
});


test('facade bridge fails closed without a runtime resolver and never accepts resolver identity overrides', async (t) => {
  const { store } = fixture(t);
  const supervisor = createExternalMcpAutonomySupervisor({
    store,
    adapterResolver: () => scriptedAdapter(),
    planner: planner([]),
    now: () => new Date('2026-07-10T10:00:00.000Z'),
  });
  const command = {
    action: 'start',
    requestRef: 'r1',
    selection: {
      actorKey: 'owner-actor', conversationKey: 'owner-conversation', domain: 'game',
      goalDigest: createHash('sha256').update('continue the selected game').digest('hex'),
      key: 'owner-actor|owner-conversation|game',
    },
    actorContext: { actorKey: 'owner-actor', conversationKey: 'owner-conversation' },
    goal: 'continue the selected game',
  };
  const missing = await supervisor.commit(command);
  assert.equal(missing.committed, false);
  assert.equal(missing.error_code, 'EXTERNAL_MCP_AUTONOMY_COMMIT_RESOLVER_UNAVAILABLE');

  const protectedSupervisor = createExternalMcpAutonomySupervisor({
    store,
    adapterResolver: () => scriptedAdapter(),
    planner: planner([]),
    now: () => new Date('2026-07-10T10:00:00.000Z'),
    ...coreJobOptions(store),
    resolveCommitInput: () => ({
      ...startInput(),
      actorKey: 'resolver-actor',
      conversationKey: 'resolver-conversation',
    }),
  });
  const committed = await protectedSupervisor.commit(command);
  assert.equal(committed.committed, true);
  assert.equal(store.list().some((item) => item.actor.key === createHash('sha256').update('resolver-actor\nresolver-conversation').digest('hex')), false);
  assert.equal(store.list().some((item) => item.actor.key === createHash('sha256').update('owner-actor\nowner-conversation').digest('hex')), true);

  const emptyResolverSupervisor = createExternalMcpAutonomySupervisor({
    store,
    adapterResolver: () => scriptedAdapter(),
    planner: planner([]),
    now: () => new Date('2026-07-10T10:00:00.000Z'),
    ...coreJobOptions(store),
    resolveCommitInput: () => ({}),
  });
  const empty = await emptyResolverSupervisor.commit({ ...command, action: 'stop', activityId: committed.receipt.jobId });
  assert.equal(empty.committed, true);
  assert.equal(store.list().find((item) => item.coreJobReceipt?.jobId === committed.receipt.jobId).status, 'stopped');
});


test('facade bridge maps resume, adjust, stop, and stop_all only after the durable mutation', async (t) => {
  const { store } = fixture(t);
  const resolveCommitInput = ({ action }) => ({
    ...startInput(),
    ...(action === 'adjust' ? {
      newScope: { serverId: 'configured-game', resourceId: 'game:forest', parameters: { areas: ['hall'] } },
    } : {}),
  });
  const supervisor = createExternalMcpAutonomySupervisor({
    store,
    adapterResolver: () => scriptedAdapter(),
    planner: planner([]),
    now: () => new Date('2026-07-10T10:00:00.000Z'),
    ...coreJobOptions(store),
    resolveCommitInput,
  });
  const started = supervisor.startOrResume(startInput());
  const selection = {
    actorKey: 'owner-actor', conversationKey: 'owner-conversation', domain: 'game', goalDigest: 'b'.repeat(64),
    key: 'owner-actor|owner-conversation|game',
  };
  const base = { requestRef: 'r2', selection, actorContext: { actorKey: 'owner-actor', conversationKey: 'owner-conversation' }, activityId: started.activityId };
  attachCoreReceipt(store, started.activityId, selection.actorKey, selection.goalDigest);
  const adjusted = await supervisor.commit({ ...base, action: 'adjust', goal: 'continue the selected game' });
  assert.equal(adjusted.committed, true);
  assert.deepEqual(store.get(started.activityId).scope.parameters.areas, ['hall']);
  const stopped = await supervisor.commit({ ...base, action: 'stop' });
  assert.equal(stopped.committed, true);
  assert.equal(store.get(started.activityId).status, 'stopped');
  assert.equal(stopped.receipt.status, 'stopped');

  const first = supervisor.startOrResume(startInput({ goal: { ...startInput().goal, text: 'Continue game A' } }));
  const second = supervisor.startOrResume(startInput({ goal: { ...startInput().goal, text: 'Continue game B' } }));
  attachCoreReceipt(store, first.activityId, selection.actorKey, selection.goalDigest);
  attachCoreReceipt(store, second.activityId, selection.actorKey, selection.goalDigest);
  const all = await supervisor.commit({ ...base, action: 'stop_all', activityIds: [first.activityId, second.activityId] });
  assert.equal(all.committed, true);
  assert.equal(store.get(first.activityId).status, 'stopped');
  assert.equal(store.get(second.activityId).status, 'stopped');
});


test('the real facade can start and dedupe against the supervisor bridge without exposing an activity identifier', async (t) => {
  const { store } = fixture(t);
  const supervisor = createExternalMcpAutonomySupervisor({
    store,
    adapterResolver: () => scriptedAdapter(),
    planner: planner([]),
    now: () => new Date('2026-07-10T10:00:00.000Z'),
    ...coreJobOptions(store),
    resolveCommitInput(command) {
      return {
        ...startInput(),
        goal: { ...startInput().goal, text: command.goal },
      };
    },
  });
  const facade = createExternalMcpActivityFacade({ supervisor });
  const actor = { actorKey: 'owner-actor', conversationKey: 'owner-conversation', platform: 'wechat' };
  const request = {
    requestRef: 'bridge-real',
    command: 'start_or_resume',
    goal: '继续玩森林游戏直到第一关结束',
    environmentHint: 'game',
  };

  const started = await facade.handle(request, actor);
  const deduped = await facade.handle({ ...request, requestRef: 'bridge-dedupe' }, actor);

  assert.equal(started.action, 'started');
  assert.equal(deduped.action, 'deduped');
  assert.equal(Object.hasOwn(started.receipt, 'activityId'), false);
  assert.equal(started.receipt.status, 'active');
  assert.equal(store.list().length, 1);
});


test('facade creates, persists, reloads, and terminalizes one Core external-activity receipt', async (t) => {
  const { store } = fixture(t);
  const calls = [];
  const coreReceipt = (input, status = 'active') => ({
    jobId: 'job_external_1234567890abcdef',
    actorKey: input.actorKey,
    goalDigest: input.goalDigest,
    status,
    nextRunAt: '2026-07-10T10:00:00.000Z',
    terminalStates: ['completed', 'blocked', 'stopped', 'expired'],
  });
  const createCoreJob = async (input) => {
    calls.push({ type: 'create', input });
    return coreReceipt(input);
  };
  const terminalizeCoreJob = async (jobId, input) => {
    calls.push({ type: 'terminal', jobId, input });
    return coreReceipt({
      actorKey: 'owner-actor',
      goalDigest: createHash('sha256').update('继续玩森林游戏直到第一关结束').digest('hex'),
    }, input.terminalState);
  };
  const makeSupervisor = () => createExternalMcpAutonomySupervisor({
    store,
    adapterResolver: () => scriptedAdapter(),
    planner: planner([]),
    now: () => new Date('2026-07-10T10:00:00.000Z'),
    createCoreJob,
    terminalizeCoreJob,
    resolveCommitInput(command) {
      return { ...startInput(), goal: { ...startInput().goal, text: command.goal } };
    },
  });
  const actor = { actorKey: 'owner-actor', conversationKey: 'owner-conversation', platform: 'wechat' };
  const request = {
    requestRef: 'core-receipt-start',
    command: 'start_or_resume',
    goal: '继续玩森林游戏直到第一关结束',
    environmentHint: 'game',
  };
  const started = await createExternalMcpActivityFacade({ supervisor: makeSupervisor() }).handle(request, actor);

  assert.equal(started.receipt.jobId, 'job_external_1234567890abcdef');
  assert.equal(calls.filter((call) => call.type === 'create').length, 1);
  assert.deepEqual(store.list()[0].coreJobReceipt, started.receipt);

  const restartedFacade = createExternalMcpActivityFacade({ supervisor: makeSupervisor() });
  const deduped = await restartedFacade.handle({ ...request, requestRef: 'core-receipt-restart' }, actor);
  assert.equal(deduped.action, 'deduped');
  assert.deepEqual(deduped.receipt, started.receipt);
  assert.equal(calls.filter((call) => call.type === 'create').length, 1);

  const stopped = await restartedFacade.handle({
    requestRef: 'core-receipt-stop', command: 'stop', reference: '森林游戏',
  }, actor);
  assert.equal(stopped.receipt.jobId, started.receipt.jobId);
  assert.equal(stopped.receipt.status, 'stopped');
  assert.deepEqual(store.list()[0].coreJobReceipt, stopped.receipt);
  assert.equal(calls.filter((call) => call.type === 'terminal').length, 1);
  assert.deepEqual(calls.find((call) => call.type === 'terminal').input, {
    terminalState: 'stopped',
    resultRef: `activity:${store.list()[0].activityId}:terminal:stopped`,
  });
});

test('facade resume replaces a terminal blocked Core receipt with a fresh active receipt', async (t) => {
  const { store } = fixture(t);
  let creates = 0;
  const supervisor = createExternalMcpAutonomySupervisor({
    store,
    adapterResolver: () => scriptedAdapter(),
    planner: planner([]),
    now: () => new Date('2026-07-10T10:00:00.000Z'),
    async createCoreJob(input) {
      creates += 1;
      return coreReceipt(input.actorKey, input.goalDigest, 'active', `job_external_resume_${creates}`);
    },
    resolveCommitInput(command) {
      return { ...startInput(), goal: { ...startInput().goal, text: command.goal } };
    },
  });
  const facade = createExternalMcpActivityFacade({ supervisor });
  const actor = { actorKey: 'owner-actor', conversationKey: 'owner-conversation', platform: 'wechat' };
  const request = {
    requestRef: 'resume-blocked-start', command: 'start_or_resume',
    goal: 'Continue the selected game', environmentHint: 'game',
  };
  const started = await facade.handle(request, actor);
  const activity = store.list()[0];
  const blocked = store.compareAndSwap(activity.activityId, {
    expectedRevision: activity.revision,
    patch: {
      status: 'blocked', nextWake: null,
      coreJobReceipt: { ...started.receipt, status: 'blocked' },
    },
  });
  assert.equal(blocked.ok, true);

  const resumed = await facade.handle({ ...request, requestRef: 'resume-blocked-again' }, actor);

  assert.equal(resumed.action, 'resumed');
  assert.equal(resumed.receipt.status, 'active');
  assert.notEqual(resumed.receipt.jobId, started.receipt.jobId);
  assert.equal(creates, 2);
  assert.equal(store.get(activity.activityId).status, 'active');
  assert.deepEqual(store.get(activity.activityId).coreJobReceipt, resumed.receipt);
});


test('the real facade stop-all invokes one durable actor-scoped transaction, including every unfinished domain', async (t) => {
  const { store } = fixture(t);
  const supervisor = createExternalMcpAutonomySupervisor({
    store,
    adapterResolver: () => scriptedAdapter(),
    planner: planner([]),
    now: () => new Date('2026-07-10T10:00:00.000Z'),
    ...coreJobOptions(store),
    resolveCommitInput: () => startInput(),
  });
  const game = supervisor.startOrResume(startInput());
  const forum = supervisor.startOrResume(startInput({
    domain: 'forum',
    goal: { ...startInput().goal, text: 'Continue watching the selected forum' },
  }));
  supervisor.startOrResume(startInput({ actorKey: 'foreign', conversationKey: 'foreign-conversation' }));
  attachCoreReceipt(store, game.activityId, 'owner-actor', createHash('sha256').update('continue the selected game').digest('hex'));
  attachCoreReceipt(store, forum.activityId, 'owner-actor', createHash('sha256').update('continue watching the selected forum').digest('hex'));
  const facade = createExternalMcpActivityFacade({ supervisor });
  const stopped = await facade.handle({ requestRef: 'stop-everything', command: 'stop', goal: '停止全部' }, {
    actorKey: 'owner-actor', conversationKey: 'owner-conversation', platform: 'wechat',
  });

  assert.equal(stopped.action, 'stopped_all');
  assert.equal(stopped.receipt.status, 'stopped');
  assert.equal(store.get(game.activityId).status, 'stopped');
  assert.equal(store.get(forum.activityId).status, 'stopped');
  assert.equal(store.list().filter((item) => item.actor.key !== store.get(game.activityId).actor.key)[0].status, 'active');
});


test('resume keeps a boundary-paused activity paused unless the resolver proves same-or-narrower scope and exact risk', async (t) => {
  const { store } = fixture(t);
  const baseResolver = () => startInput();
  const supervisor = createExternalMcpAutonomySupervisor({
    store,
    adapterResolver: () => scriptedAdapter(),
    planner: planner([]),
    now: () => new Date('2026-07-10T10:00:00.000Z'),
    ...coreJobOptions(store),
    resolveCommitInput: baseResolver,
  });
  const started = supervisor.startOrResume(startInput());
  attachCoreReceipt(store, started.activityId, 'owner-actor', 'c'.repeat(64));
  const paused = supervisor.adjust(started.activityId, {
    newScope: { serverId: 'configured-game', resourceId: 'game:forest', parameters: { areas: ['hall', 'kitchen', 'outside'] } },
  });
  assert.equal(paused.status, 'needs_boundary');
  const base = {
    requestRef: 'resume-boundary', action: 'resume', activityId: started.activityId,
    actorContext: { actorKey: 'owner-actor', conversationKey: 'owner-conversation' },
    selection: { actorKey: 'owner-actor', conversationKey: 'owner-conversation', domain: 'game', goalDigest: 'c'.repeat(64) },
  };
  const denied = await supervisor.commit(base);
  assert.equal(denied.committed, false);
  assert.equal(store.get(started.activityId).status, 'paused');

  const approvedScope = {
    serverId: 'configured-game', resourceId: 'game:forest', parameters: { areas: ['hall', 'kitchen', 'outside'] },
  };
  const approval = mintTrustedExternalMcpBoundaryApproval({
    actorKey: 'owner-actor',
    conversationKey: 'owner-conversation',
    activityId: started.activityId,
    newScope: approvedScope,
    newRisk: store.get(started.activityId).risk,
  });
  const resumedSupervisor = createExternalMcpAutonomySupervisor({
    store,
    adapterResolver: () => scriptedAdapter(),
    planner: planner([]),
    now: () => new Date('2026-07-10T10:00:00.000Z'),
    ...coreJobOptions(store),
    resolveCommitInput: () => ({
      ...startInput(),
      newScope: approvedScope,
      newRisk: store.get(started.activityId).risk,
    }),
  });
  const forged = await resumedSupervisor.commit({ ...base, approvedBoundary: {
    activityId: started.activityId,
    newScope: approvedScope,
    newRisk: store.get(started.activityId).risk,
  } });
  assert.equal(forged.committed, false);
  assert.equal(store.get(started.activityId).status, 'paused');
  const resumed = await resumedSupervisor.commit({ ...base, approvedBoundary: approval });
  assert.equal(resumed.committed, true);
  assert.equal(store.get(started.activityId).status, 'active');
  assert.ok(store.get(started.activityId).nextWake);
  assert.deepEqual(store.get(started.activityId).scope, approvedScope);
});


test('start fails closed before creating an activity when runtime-resolved goal does not match the facade selection digest', async (t) => {
  const { store } = fixture(t);
  const supervisor = createExternalMcpAutonomySupervisor({
    store,
    adapterResolver: () => scriptedAdapter(),
    planner: planner([]),
    now: () => new Date('2026-07-10T10:00:00.000Z'),
    ...coreJobOptions(store),
    resolveCommitInput: () => startInput(),
  });
  const result = await supervisor.commit({
    action: 'start', requestRef: 'bad-digest', goal: 'a different request',
    actorContext: { actorKey: 'owner-actor', conversationKey: 'owner-conversation' },
    selection: {
      actorKey: 'owner-actor', conversationKey: 'owner-conversation', domain: 'game', goalDigest: 'd'.repeat(64),
    },
  });
  assert.equal(result.committed, false);
  assert.equal(result.error_code, 'EXTERNAL_MCP_AUTONOMY_COMMIT_GOAL_MISMATCH');
  assert.deepEqual(store.list(), []);
});


test('start does not leave an uncommitted active activity runnable when Core job creation fails', async (t) => {
  const { store } = fixture(t);
  const supervisor = createExternalMcpAutonomySupervisor({
    store,
    adapterResolver: () => scriptedAdapter(),
    planner: planner([]),
    now: () => new Date('2026-07-10T10:00:00.000Z'),
    createCoreJob: async () => { throw new Error('Core is unavailable'); },
    resolveCommitInput: () => startInput(),
  });
  const result = await supervisor.commit({
    action: 'start', requestRef: 'core-create-fails', goal: 'Continue the selected game',
    actorContext: { actorKey: 'owner-actor', conversationKey: 'owner-conversation' },
    selection: {
      actorKey: 'owner-actor', conversationKey: 'owner-conversation', domain: 'game',
      goalDigest: createHash('sha256').update('continue the selected game').digest('hex'),
    },
  });

  assert.equal(result.committed, false);
  assert.equal(result.error_code, 'EXTERNAL_MCP_AUTONOMY_COMMIT_START_FAILED');
  assert.deepEqual(store.list().map((activity) => ({
    status: activity.status, nextWake: activity.nextWake, coreJobReceipt: activity.coreJobReceipt,
  })), [{ status: 'blocked', nextWake: null, coreJobReceipt: null }]);
  assert.equal((await supervisor.scanDue()).processed, 0);
});


test('durable stop and atomic stop-all invoke abort and revoke best-effort without invalidating committed receipts', async (t) => {
  const { store } = fixture(t);
  const callbacks = [];
  const supervisor = createExternalMcpAutonomySupervisor({
    store,
    adapterResolver: () => scriptedAdapter(),
    planner: planner([]),
    now: () => new Date('2026-07-10T10:00:00.000Z'),
    ...coreJobOptions(store),
    resolveCommitInput: () => startInput(),
    abortActivity(activityId) {
      callbacks.push(`abort:${activityId}`);
      throw new Error('abort transport is already gone');
    },
    async revokeActivity(activityId) {
      callbacks.push(`revoke:${activityId}`);
      throw new Error('revoke transport is already gone');
    },
  });
  const first = supervisor.startOrResume(startInput());
  const second = supervisor.startOrResume(startInput({
    domain: 'forum', goal: { ...startInput().goal, text: 'Continue watching the selected forum' },
  }));
  attachCoreReceipt(store, first.activityId, 'owner-actor', createHash('sha256').update('continue the selected game').digest('hex'));
  attachCoreReceipt(store, second.activityId, 'owner-actor', createHash('sha256').update('continue watching the selected forum').digest('hex'));
  const facade = createExternalMcpActivityFacade({ supervisor });
  const result = await facade.handle({ requestRef: 'best-effort-stop', command: 'stop', goal: '停止全部' }, {
    actorKey: 'owner-actor', conversationKey: 'owner-conversation', platform: 'wechat',
  });
  await Promise.resolve();

  assert.equal(result.action, 'stopped_all');
  assert.equal(result.receipt.status, 'stopped');
  assert.equal(store.get(first.activityId).status, 'stopped');
  assert.equal(store.get(second.activityId).status, 'stopped');
  assert.deepEqual(callbacks.sort(), [
    `abort:${first.activityId}`,
    `abort:${second.activityId}`,
    `revoke:${first.activityId}`,
    `revoke:${second.activityId}`,
  ].sort());
});


test('startOrResume dedupes normalized actor, conversation, domain, and goal digest', (t) => {
  const { store } = fixture(t);
  const adapter = scriptedAdapter();
  const supervisor = createExternalMcpAutonomySupervisor({
    store,
    adapterResolver: () => adapter,
    planner: planner([]),
    runnerId: 'runner-a',
    now: () => new Date('2026-07-10T10:00:00.000Z'),
  });

  const first = supervisor.startOrResume(startInput());
  const duplicate = supervisor.startOrResume(startInput({
    goal: {
      ...startInput().goal,
      text: '  continue   THE selected GAME  ',
      constraints: [' stay inside selected game '],
    },
  }));

  assert.equal(first.status, 'started');
  assert.equal(duplicate.status, 'resumed');
  assert.equal(duplicate.deduped, true);
  assert.equal(duplicate.activityId, first.activityId);
  assert.equal(store.list().length, 1);
});


test('goal digest keeps different bounded resources as distinct activities', (t) => {
  const { store } = fixture(t);
  const supervisor = createExternalMcpAutonomySupervisor({
    store,
    adapterResolver: () => scriptedAdapter(),
    planner: planner([]),
    runnerId: 'runner-a',
    now: () => new Date('2026-07-10T10:00:00.000Z'),
  });

  const forest = supervisor.startOrResume(startInput());
  const coast = supervisor.startOrResume(startInput({
    goal: { ...startInput().goal, resourceId: 'game:coast', parameters: { areas: ['beach'] } },
    trustedContext: { allowedResourceIds: ['game:coast'] },
  }));

  assert.notEqual(forest.activityId, coast.activityId);
  assert.equal(store.list().length, 2);
});


test('dedupe never case-folds actor or conversation identity keys', (t) => {
  const { store } = fixture(t);
  const supervisor = createExternalMcpAutonomySupervisor({
    store,
    adapterResolver: () => scriptedAdapter(),
    planner: planner([]),
    runnerId: 'runner-a',
    now: () => new Date('2026-07-10T10:00:00.000Z'),
  });

  const upper = supervisor.startOrResume(startInput({ actorKey: 'Owner-A' }));
  const lower = supervisor.startOrResume(startInput({ actorKey: 'owner-a' }));

  assert.notEqual(upper.activityId, lower.activityId);
  assert.equal(store.list().length, 2);
});


test('adjust narrows by CAS and pauses one time when a wider scope needs a boundary', (t) => {
  const { store } = fixture(t);
  const supervisor = createExternalMcpAutonomySupervisor({
    store,
    adapterResolver: () => scriptedAdapter(),
    planner: planner([]),
    runnerId: 'runner-a',
    now: () => new Date('2026-07-10T10:00:00.000Z'),
  });
  const started = supervisor.startOrResume(startInput());

  const narrowed = supervisor.adjust(started.activityId, {
    newScope: {
      serverId: 'configured-game',
      resourceId: 'game:forest',
      parameters: { areas: ['kitchen'] },
    },
  });
  const widened = supervisor.adjust(started.activityId, {
    newScope: {
      serverId: 'configured-game',
      resourceId: 'game:forest',
      parameters: { areas: ['hall', 'kitchen'] },
    },
  });
  const revisionAfterPause = store.get(started.activityId).revision;
  const repeated = supervisor.adjust(started.activityId, {
    newScope: {
      serverId: 'configured-game',
      resourceId: 'game:forest',
      parameters: { areas: ['hall', 'kitchen'] },
    },
  });

  assert.equal(narrowed.status, 'adjusted');
  assert.deepEqual(store.get(started.activityId).scope.parameters.areas, ['kitchen']);
  assert.equal(widened.status, 'needs_boundary');
  assert.equal(store.get(started.activityId).status, 'paused');
  assert.equal(repeated.status, 'needs_boundary');
  assert.equal(repeated.deduped, true);
  assert.equal(store.get(started.activityId).revision, revisionAfterPause);
});


test('tick follows the deterministic pipeline and keeps multiple nonterminal checkpoints active', async (t) => {
  const { store } = fixture(t);
  const calls = [];
  const candidates = [];
  const adapter = scriptedAdapter({
    calls,
    observations: [
      { summary: 'Checkpoint zero.', quality: 'structured', terminal: false },
      { summary: 'Checkpoint one.', quality: 'structured', terminal: false },
    ],
    receipts: [
      { effect: 'write', outcome: 'applied', evidence: { format: 'text', text: 'Checkpoint one.', untrusted: true }, observation: { summary: 'Checkpoint one.', terminal: false } },
      { effect: 'write', outcome: 'applied', evidence: { format: 'text', text: 'Checkpoint two.', untrusted: true }, observation: { summary: 'Checkpoint two.', terminal: false } },
    ],
  });
  let clock = new Date('2026-07-10T10:00:00.000Z');
  const supervisor = createExternalMcpAutonomySupervisor({
    store,
    adapterResolver: () => adapter,
    planner: planner(calls),
    experienceProvider: {
      async getProven() {
        calls.push('experiences');
        return [{ proven: true, actionId: 'action-play', outcome: 'progress' }];
      },
    },
    submitCandidate(candidate) { candidates.push(candidate); },
    runnerId: 'runner-a',
    now: () => clock,
    tickIntervalMs: 1_000,
  });
  const started = supervisor.startOrResume(startInput());
  calls.length = 0;

  const first = await supervisor.tick(started.activityId);
  clock = new Date('2026-07-10T10:00:02.000Z');
  const second = await supervisor.tick(started.activityId);

  assert.equal(first.status, 'active');
  assert.equal(second.status, 'active');
  assert.equal(store.get(started.activityId).status, 'active');
  assert.equal(store.get(started.activityId).checkpoint.summary, 'Checkpoint two.');
  assert.equal(candidates.length, 2);
  assert.deepEqual(calls.slice(0, 7), [
    'observe', 'resolveScope', 'classify', 'legalActions', 'experiences', 'planner', 'execute:action-play',
  ]);
  assert.equal(calls.filter((item) => item === 'classify').length, 4);
});


test('experience integration sends only digest advice to planning and records a trusted completed checkpoint', async (t) => {
  const { store } = fixture(t);
  const trustedReceipt = { evidenceRef: 'evidence:trusted-checkpoint' };
  const queries = [];
  const appended = [];
  let plannerInput;
  const adapter = scriptedAdapter({
    observations: [{ summary: 'private observation text', quality: 'structured', terminal: false }],
    receipts: [{
      actionId: 'action-play',
      effect: 'write',
      outcome: 'applied',
      evidenceRef: 'evidence:trusted-checkpoint',
      brokerReceipt: trustedReceipt,
      evidence: { format: 'text', text: 'private result text', untrusted: true, error: false },
      observation: { summary: 'private result text', terminal: false },
    }],
  });
  const supervisor = createExternalMcpAutonomySupervisor({
    store,
    adapterResolver: () => adapter,
    planner: {
      async chooseAction(input) {
        plannerInput = input;
        return { actionId: 'action-play' };
      },
    },
    experienceProvider: {
      async getProven(query) {
        queries.push(query);
        return [{ proven: true, actionId: 'action-play', outcome: 'progress', score: 2, rawEvidence: 'must not reach planner' }];
      },
      isTrustedReceipt(receipt) { return receipt === trustedReceipt; },
      async appendOutcome(input) { appended.push(input); },
    },
    now: () => new Date('2026-07-11T00:00:00.000Z'),
  });
  const started = supervisor.startOrResume(startInput());
  Object.assign(trustedReceipt, {
    outcome: 'applied',
    activityId: started.activityId,
    actionId: 'action-play',
    serverId: 'configured-game',
    effect: 'write',
  });

  await supervisor.tick(started.activityId);

  assert.equal(queries.length, 1);
  assert.deepEqual(Object.keys(queries[0]).sort(), [
    'domain', 'driverId', 'driverVersion', 'goalClass', 'legalActions', 'observationDigest', 'scopeClass',
  ]);
  assert.deepEqual(queries[0].legalActions, ['action-play']);
  assert.equal(queries[0].observationDigest.length, 64);
  assert.equal(JSON.stringify(queries[0]).includes('private observation text'), false);
  assert.deepEqual(plannerInput.experiences, [{ proven: true, actionId: 'action-play', outcome: 'progress', score: 2 }]);
  assert.equal(JSON.stringify(plannerInput).includes('rawEvidence'), false);
  assert.equal(appended.length, 1);
  assert.deepEqual(Object.keys(appended[0].record).sort(), [
    'actionId', 'createdAt', 'domain', 'driverId', 'driverVersion', 'effectDigest', 'evidenceDigests', 'goalClass', 'observationDigest', 'outcome', 'scopeClass',
  ]);
  assert.equal(appended[0].record.outcome, 'progress');
  assert.deepEqual(appended[0].record.evidenceDigests.length, 1);
});


test('scanDue resumes committed work after supervisor restart without chat history', async (t) => {
  const { store } = fixture(t);
  const adapter = scriptedAdapter();
  const firstSupervisor = createExternalMcpAutonomySupervisor({
    store,
    adapterResolver: () => adapter,
    planner: planner([]),
    runnerId: 'runner-a',
    now: () => new Date('2026-07-10T10:00:00.000Z'),
  });
  const started = firstSupervisor.startOrResume(startInput());

  const restarted = createExternalMcpAutonomySupervisor({
    store,
    adapterResolver: () => adapter,
    planner: planner([]),
    runnerId: 'runner-b',
    now: () => new Date('2026-07-10T10:00:01.000Z'),
  });
  const result = await restarted.scanDue();

  assert.equal(result.processed, 1);
  assert.equal(result.results[0].activityId, started.activityId);
  assert.equal(store.get(started.activityId).status, 'active');
});


test('default composition runs the real generic adapter, safe planner fallback, and narrator', async (t) => {
  const { store } = fixture(t);
  const transportCalls = [];
  const supervisor = createExternalMcpAutonomySupervisor({
    store,
    discovery: {
      initializeResult: { serverInfo: { name: 'configured-mcp' }, capabilities: { tools: {} } },
      toolsResult: {
        tools: [{
          name: 'observe_state',
          annotations: { readOnlyHint: true },
          inputSchema: { type: 'object', properties: {} },
          outputSchema: { type: 'object', properties: { terminal: { type: 'boolean' } } },
        }],
      },
    },
    transport: {
      async call(request) {
        transportCalls.push(request);
        return { structuredContent: { summary: 'Observed safely.', terminal: false } };
      },
    },
    runnerId: 'runner-a',
    now: () => new Date('2026-07-10T10:00:00.000Z'),
  });
  const started = supervisor.startOrResume(startInput({ manifest: { id: 'configured-mcp' } }));

  const result = await supervisor.tick(started.activityId);

  assert.equal(result.status, 'active');
  assert.equal(result.candidate.status, 'ready');
  assert.equal(transportCalls.length, 2);
  assert.deepEqual(transportCalls.map((item) => item.toolName), ['observe_state', 'observe_state']);
});


test('unknown pending operation reconciles before planning and blocks without replay', async (t) => {
  const { store } = fixture(t);
  const calls = [];
  const adapter = scriptedAdapter({ calls, reconcile: 'unknown' });
  let plannerCalls = 0;
  const supervisor = createExternalMcpAutonomySupervisor({
    store,
    adapterResolver: () => adapter,
    planner: { async chooseAction() { plannerCalls += 1; return { actionId: 'action-play' }; } },
    runnerId: 'runner-a',
    now: () => new Date('2026-07-10T10:00:00.000Z'),
  });
  const started = supervisor.startOrResume(startInput());
  store.compareAndSwap(started.activityId, {
    expectedRevision: 1,
    patch: {
      pendingOperation: {
        operationId: 'operation-old', actionId: 'action-play', effect: 'write', status: 'unknown',
        startedAt: '2026-07-10T09:59:00.000Z', updatedAt: '2026-07-10T09:59:30.000Z',
      },
    },
    now: '2026-07-10T09:59:30.000Z',
  });

  const result = await supervisor.tick(started.activityId);

  assert.equal(result.status, 'blocked');
  assert.equal(store.get(started.activityId).status, 'blocked');
  assert.equal(store.get(started.activityId).pendingOperation.status, 'unknown');
  assert.equal(plannerCalls, 0);
  assert.equal(calls.some((item) => item.startsWith('execute:')), false);
  assert.ok(calls.indexOf('reconcile') > calls.indexOf('observe'));
});


test('activity budget expiry commits one terminal state before any model or transport work', async (t) => {
  const { store } = fixture(t);
  const calls = [];
  let clock = new Date('2026-07-10T10:00:00.000Z');
  const supervisor = createExternalMcpAutonomySupervisor({
    store,
    adapterResolver: () => scriptedAdapter({ calls }),
    planner: planner(calls),
    runnerId: 'runner-a',
    now: () => clock,
    maxActivityMs: 1_000,
  });
  const started = supervisor.startOrResume(startInput());
  calls.length = 0;
  clock = new Date('2026-07-10T10:00:02.000Z');

  const result = await supervisor.tick(started.activityId);

  assert.equal(result.status, 'expired');
  assert.equal(store.get(started.activityId).status, 'expired');
  assert.deepEqual(calls, []);
});


test('user stop during an in-flight transport wins the revision race and suppresses stale candidate', async (t) => {
  const { store } = fixture(t);
  const calls = [];
  const candidates = [];
  let aborts = 0;
  let supervisor;
  const adapter = scriptedAdapter({
    calls,
    async onExecute() {
      const current = store.list()[0];
      supervisor.stop(current.activityId, { reason: 'owner_stop' });
    },
  });
  supervisor = createExternalMcpAutonomySupervisor({
    store,
    adapterResolver: () => adapter,
    planner: planner(calls),
    submitCandidate(candidate) { candidates.push(candidate); },
    abortActivity() { aborts += 1; },
    runnerId: 'runner-a',
    now: () => new Date('2026-07-10T10:00:00.000Z'),
  });
  const started = supervisor.startOrResume(startInput());

  const result = await supervisor.tick(started.activityId);

  assert.equal(result.status, 'stopped');
  assert.equal(store.get(started.activityId).status, 'stopped');
  assert.equal(calls.some((item) => item.startsWith('execute:')), true);
  assert.equal(aborts, 1);
  assert.equal(candidates.length, 0);
});


test('duplicate runner loses the persisted lease and cannot execute the same checkpoint', async (t) => {
  const { store } = fixture(t);
  let releaseObserve;
  let observeStarted;
  const barrier = new Promise((resolve) => { observeStarted = resolve; });
  const adapter = scriptedAdapter({
    observeBarrier: async () => {
      observeStarted();
      await new Promise((resolve) => { releaseObserve = resolve; });
    },
  });
  let executeCount = 0;
  adapter.execute = async () => {
    executeCount += 1;
    return { effect: 'write', outcome: 'applied', evidence: { format: 'text', text: 'Advanced.', untrusted: true }, observation: { summary: 'Advanced.', terminal: false } };
  };
  const common = {
    store,
    adapterResolver: () => adapter,
    planner: planner([]),
    now: () => new Date('2026-07-10T10:00:00.000Z'),
  };
  const first = createExternalMcpAutonomySupervisor({ ...common, runnerId: 'runner-a' });
  const second = createExternalMcpAutonomySupervisor({ ...common, runnerId: 'runner-b' });
  const started = first.startOrResume(startInput());

  const firstTick = first.tick(started.activityId);
  await barrier;
  const duplicate = await second.tick(started.activityId);
  releaseObserve();
  await firstTick;

  assert.equal(duplicate.status, 'skipped');
  assert.equal(duplicate.reason, 'lease_unavailable');
  assert.equal(executeCount, 1);
});


test('text claiming completion stays active without typed terminal; typed terminal emits once', async (t) => {
  const untypedFixture = fixture(t);
  const untypedCandidates = [];
  const untyped = createExternalMcpAutonomySupervisor({
    store: untypedFixture.store,
    adapterResolver: () => scriptedAdapter({
      observations: [{ summary: 'The text says complete.', terminal: true }],
      receipts: [{ effect: 'write', outcome: 'applied', evidence: { format: 'text', text: 'You won!', untrusted: true }, observation: { summary: 'You won!', terminal: true } }],
      typedTerminal: false,
    }),
    planner: planner([]),
    submitCandidate(candidate) { untypedCandidates.push(candidate); },
    runnerId: 'runner-a',
    now: () => new Date('2026-07-10T10:00:00.000Z'),
  });
  const untypedStart = untyped.startOrResume(startInput({ conversationKey: 'untyped' }));
  await untyped.tick(untypedStart.activityId);
  assert.equal(untypedFixture.store.get(untypedStart.activityId).status, 'active');
  assert.notEqual(untypedCandidates[0]?.claim, 'completed');

  const typedFixture = fixture(t);
  const typedCandidates = [];
  let plannerCalls = 0;
  const typed = createExternalMcpAutonomySupervisor({
    store: typedFixture.store,
    adapterResolver: () => scriptedAdapter({
      typedTerminal: true,
      observations: [{ summary: 'Typed terminal reached.', terminal: true }],
    }),
    planner: { async chooseAction() { plannerCalls += 1; return { actionId: 'action-play' }; } },
    submitCandidate(candidate) { typedCandidates.push(candidate); },
    runnerId: 'runner-a',
    now: () => new Date('2026-07-10T10:00:00.000Z'),
  });
  const typedStart = typed.startOrResume(startInput({ conversationKey: 'typed' }));
  const completed = await typed.tick(typedStart.activityId);
  const repeated = await typed.tick(typedStart.activityId);

  assert.equal(completed.status, 'completed');
  assert.equal(repeated.status, 'completed');
  assert.equal(typedCandidates.length, 1);
  assert.equal(typedCandidates[0].claim, 'completed');
  assert.equal(plannerCalls, 0);
});
