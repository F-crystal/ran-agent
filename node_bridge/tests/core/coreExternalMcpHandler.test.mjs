import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { openCoreDatabase } from '../../src/core/coreDb.mjs';
import { createAttentionValve } from '../../src/attentionValve.mjs';
import { createCoreExternalMcpHandler } from '../../src/core/coreExternalMcpHandler.mjs';
import {
  createCoreExternalNotificationService,
  parseExternalMcpTaskRef,
} from '../../src/core/coreExternalNotificationService.mjs';
import { formatKeyedContentHashToken } from '../../src/core/coreHashToken.mjs';
import { createCoreSchedulingService } from '../../src/core/coreScheduling.mjs';
import { createCoreWorkRunWorker } from '../../src/core/coreWorkRunWorker.mjs';
import { createTempCore, openTestInspector } from './helpers/testCoreInspector.mjs';

const START = '2026-08-08T08:00:00.000Z';

function hashContent(kind, value) {
  return formatKeyedContentHashToken({
    keyId: 'core-test', digest: createHash('sha256').update(`${kind}\0${value}`).digest('hex'),
  });
}

async function setupClaimedPoll(t, {
  taskKind = 'external_poll', payloadRef = 'external-poll:external-mcp-runtime',
  activityState = 'active', leaseUntil = '2026-08-08T08:03:00.000Z',
  claimWork = true,
} = {}) {
  const { root, dbPath } = createTempCore(t, 'hermes-core-external-mcp-authority-');
  let current = new Date(START);
  const core = openCoreDatabase({ dbPath, now: () => current });
  core.migrate();
  await core.writer.write((tx) => {
    tx.journal.append({
      eventId: 'cause', eventType: 'external_poll_requested', ownerId: 'owner',
      originRef: 'fixture', sourceKind: 'test', sourceRef: 'fixture', createdAt: START,
    });
    tx.activities.create({
      activityId: 'poll-activity', ownerId: 'owner', title: 'External MCP poll',
      goalRef: 'system-task:external-mcp-poll', domain: 'personal', riskClass: 'reversible',
      autonomyLevel: 1, state: activityState, contractRevision: 0,
      resumePolicy: 'bounded_auto', reportPolicy: 'milestone', createdAt: START,
    });
  });
  const scheduling = createCoreSchedulingService({ core });
  await scheduling.createSchedule({
    scheduleSpecId: 'poll-schedule', scheduleSpecRevisionId: 'poll-schedule-r1',
    activityId: 'poll-activity', operationKey: 'poll:create',
    recurrence: { kind: 'one_shot', at: '2026-08-08T08:01:00.000Z' },
    taskKind, payloadRef, catchUpPolicy: 'latest', activityContractRevision: 0,
    causationId: 'cause',
  });
  current = new Date('2026-08-08T08:01:00.000Z');
  await scheduling.wakeDue();
  await scheduling.wakeDue();
  const work = core.reader.scheduledWorkQueue()[0] ?? null;
  if (!work || !claimWork) {
    return {
      core, root, dbPath, scheduling, work, authority: null, now: () => current,
      setNow(value) { current = new Date(value); },
    };
  }
  const claim = await scheduling.claimWorkRun({
    workRunId: work.work_run_id, expectedRevision: Number(work.revision),
    expectedFence: Number(work.fence_token), leaseOwner: 'external-mcp-worker',
    leaseUntil, operationKey: 'poll:claim',
  });
  return {
    core, root, dbPath, scheduling, work,
    authority: {
      workRunId: claim.workRunId, expectedRevision: claim.revision,
      fenceToken: claim.fenceToken, leaseOwner: 'external-mcp-worker', leaseId: claim.lease.lease_id,
    },
    now: () => current,
    setNow(value) { current = new Date(value); },
  };
}

async function seedOwnerBinding(core) {
  await core.writer.write((tx) => {
    tx.packageBTurn.createOrResolveConversation({
      conversationId: 'system-owner-conversation', canonicalConversationKey: 'system-owner-conversation',
      ownerId: 'owner', actorRef: 'owner:verified', platform: 'feishu', primaryFrontend: 'feishu',
      sourceInstanceId: 'node-channel-hub:feishu', platformConversationBinding: 'feishu:owner', createdAt: START,
    });
    tx.packageBPresentation.createOrReadBinding({
      operationKey: 'external:test:binding', bindingId: 'system-owner-binding',
      conversationId: 'system-owner-conversation', ownerId: 'owner',
      sourceInstanceId: 'node-channel-hub:feishu', platform: 'feishu',
      destinationKind: 'conversation', destinationRef: 'owner-dm',
      adapterMetadata: { protocol: 'test', receiptMode: 'typed' }, createdAt: START,
    });
  });
}

function inertAttention() {
  return {
    evaluate: () => ({ disposition: 'silent' }), flush: () => [], confirmFlushed() {},
  };
}

function readyCandidate(summary = 'A verified external checkpoint is ready.') {
  return {
    kind: 'core_external_activity_narration_candidate', status: 'ready', claim: null,
    facts: [{ summary }], receipts: [],
  };
}

test('Core external MCP Work Run records candidates as facts without a send surface', async (t) => {
  const { dbPath } = createTempCore(t, 'hermes-core-external-mcp-handler-');
  let current = new Date(START);
  const core = openCoreDatabase({ dbPath, now: () => current });
  core.migrate();
  await core.writer.write((tx) => {
    tx.journal.append({
      eventId: 'external-mcp-causation', eventType: 'external_poll_requested', ownerId: 'owner',
      originRef: 'fixture', sourceKind: 'test', sourceRef: 'fixture', createdAt: START,
    });
    tx.activities.create({
      activityId: 'external-mcp-system-activity', ownerId: 'owner', title: 'External MCP poll',
      goalRef: 'system-task:external-mcp-poll', domain: 'personal', riskClass: 'reversible',
      autonomyLevel: 1, state: 'active', contractRevision: 0,
      resumePolicy: 'bounded_auto', reportPolicy: 'milestone', createdAt: START,
    });
  });
  const scheduling = createCoreSchedulingService({ core });
  await scheduling.createSchedule({
    scheduleSpecId: 'external-mcp-system-schedule',
    scheduleSpecRevisionId: 'external-mcp-system-schedule-r1',
    activityId: 'external-mcp-system-activity', operationKey: 'external-mcp:create',
    recurrence: { kind: 'one_shot', at: '2026-08-08T08:01:00.000Z' },
    taskKind: 'external_poll', payloadRef: 'external-poll:external-mcp-runtime',
    catchUpPolicy: 'latest', activityContractRevision: 0,
    causationId: 'external-mcp-causation',
  });
  current = new Date('2026-08-08T08:01:00.000Z');
  await scheduling.wakeDue();

  let bridge;
  const admissions = [];
  const registrations = [];
  const confirmed = [];
  let flushCandidates = [];
  let providerCalls = 0;
  const runtime = {
    store: {
      get(activityId) {
        return activityId === 'activity-1' ? {
          activityId, status: 'active', revision: 3,
          scope: { serverId: 'forum-mcp' }, notifyTarget: { platform: 'feishu' },
          checkpoint: { stateDigest: 'checkpoint-1' },
        } : null;
      },
    },
    async tick() {
      providerCalls += 1;
      const candidate = {
        kind: 'core_external_activity_narration_candidate', status: 'ready',
        serverId: 'candidate-controlled-server',
        facts: [{ summary: 'A new forum checkpoint is ready.\u0000' }], receipts: [],
      };
      const context = {
        activityId: 'activity-1', checkpointDigest: 'checkpoint-1',
        notifyTarget: { platform: 'feishu' }, revision: 3,
      };
      await bridge.submitCandidate(candidate, context);
      await bridge.submitCandidate({
        receipts: [], facts: [{ summary: 'A new forum checkpoint is ready.' }],
        serverId: 'candidate-controlled-server', status: 'ready',
        kind: 'core_external_activity_narration_candidate',
      }, { revision: 3, checkpointDigest: 'checkpoint-1', activityId: 'activity-1' });
      return { ok: true, processed: 1 };
    },
  };
  bridge = createCoreExternalMcpHandler({
    core, runtime, hashContent,
    attentionValve: {
      evaluate: (input) => { admissions.push(input); return { disposition: 'delayed' }; },
      flush: () => flushCandidates.splice(0),
      confirmFlushed: (fingerprint) => confirmed.push(fingerprint),
    },
    notificationService: { async register(input) {
      assert.equal(core.reader.journalEvent(input.causationId)?.event_type, 'external_poll_fact_observed');
      registrations.push(input);
    } },
  });
  const worker = createCoreWorkRunWorker({
    core, hashContent, handlers: { external_poll: bridge.handler },
    workerId: 'external-mcp-worker', now: () => current,
  });

  assert.equal((await worker.runOnce())[0].state, 'completed');
  assert.equal(providerCalls, 1);
  assert.equal(admissions.length, 1);
  assert.deepEqual(parseExternalMcpTaskRef(admissions[0].payloadRef), {
    activityId: 'activity-1', revision: 3, checkpointDigest: 'checkpoint-1',
    factEventId: admissions[0].causationId,
  });
  assert.equal(registrations.length, 0);
  flushCandidates = [{
    fingerprint: admissions[0].fingerprint,
    payloadRef: admissions[0].payloadRef,
    causationId: admissions[0].causationId,
  }];
  await bridge.attentionFlushHandler({ work: { work_run_id: 'attention-flush-work' } });
  assert.deepEqual(registrations, [{
    payloadRef: admissions[0].payloadRef, causationId: admissions[0].causationId,
  }]);
  assert.deepEqual(confirmed, [admissions[0].fingerprint]);
  await assert.rejects(bridge.submitCandidate({}, {}), { code: 'CORE_EXTERNAL_POLL_AUTHORITY_STALE' });
  await core.close();

  const inspect = openTestInspector(dbPath);
  const fact = inspect.prepare("SELECT actor_ref,source_ref FROM journal_event WHERE event_type='external_poll_fact_observed'").get();
  assert.equal(fact.actor_ref, 'forum-mcp');
  assert.match(fact.source_ref, /^sha256:v1:[0-9a-f]{64}$/);
  assert.equal(inspect.prepare('SELECT count(*) AS count FROM presentation_outbox').get().count, 0);
  assert.equal(inspect.prepare('SELECT count(*) AS count FROM effect_attempt').get().count, 0);
  inspect.close();
});

test('fact projection recovery crosses crash boundaries without replaying the provider or duplicating schedules', async (t) => {
  for (const mode of ['before_attention', 'before_register', 'after_register', 'after_delayed']) {
    await t.test(mode, async (st) => {
      const fixture = await setupClaimedPoll(st);
      await seedOwnerBinding(fixture.core);
      const activity = {
        activityId: 'activity-1', status: 'active', revision: 3,
        scope: { serverId: 'forum-mcp' }, notifyTarget: { platform: 'feishu' },
        checkpoint: { stateDigest: 'checkpoint-3', summary: 'A durable external checkpoint is ready.' },
      };
      let providerCalls = 0;
      let bridge;
      const durableValve = mode === 'after_delayed' ? createAttentionValve({
        statePath: `${fixture.root}/attention.json`, now: fixture.now, presenceProvider: () => 'gaming',
      }) : null;
      const firstService = createCoreExternalNotificationService({ core: fixture.core, now: fixture.now });
      const runtime = {
        store: { get: () => activity },
        async tick() {
          providerCalls += 1;
          await bridge.submitCandidate(readyCandidate(), {
            activityId: activity.activityId, revision: activity.revision,
            checkpointDigest: activity.checkpoint.stateDigest,
          });
          return { ok: true };
        },
      };
      bridge = createCoreExternalMcpHandler({
        core: fixture.core, runtime, hashContent,
        attentionValve: durableValve || {
          evaluate() {
            if (mode === 'before_attention') throw new Error('injected crash before attention');
            return { disposition: 'deliver_now' };
          },
          flush: () => [], confirmFlushed() {},
        },
        notificationService: {
          async register(input) {
            if (mode === 'before_register') throw new Error('injected crash before register');
            return firstService.register(input);
          },
        },
        afterProjectionEffect: async () => {
          if (['after_register', 'after_delayed'].includes(mode)) throw new Error('injected crash before projection completion');
        },
      });
      await assert.rejects(bridge.handler({ work: fixture.work, authority: fixture.authority }));
      assert.equal(providerCalls, 1);
      assert.equal(fixture.core.reader.pendingExternalPollProjections().length, 1);
      await fixture.core.close();

      const reopened = openCoreDatabase({ dbPath: fixture.dbPath, now: fixture.now });
      const recoveredValve = mode === 'after_delayed' ? createAttentionValve({
        statePath: `${fixture.root}/attention.json`, now: fixture.now, presenceProvider: () => 'gaming',
      }) : { evaluate: () => ({ disposition: 'deliver_now' }), flush: () => [], confirmFlushed() {} };
      const recovered = createCoreExternalMcpHandler({
        core: reopened,
        runtime: { store: { get: () => activity }, async tick() { providerCalls += 1; return { ok: true }; } },
        hashContent, attentionValve: recoveredValve,
        notificationService: createCoreExternalNotificationService({ core: reopened, now: fixture.now }),
      });
      await recovered.recoverPendingProjections();
      assert.equal(reopened.reader.pendingExternalPollProjections().length, 0);
      if (mode === 'after_delayed') assert.equal(recoveredValve.listPending().length, 1);
      const resumed = await recovered.handler({ work: fixture.work, authority: fixture.authority });
      assert.match(resumed.resultRef, /core-external-mcp-poll:/);
      assert.equal(providerCalls, 1);
      const inspect = openTestInspector(fixture.dbPath);
      assert.equal(inspect.prepare('SELECT count(*) AS count FROM schedule_spec').get().count,
        mode === 'after_delayed' ? 1 : 2);
      assert.equal(inspect.prepare("SELECT count(*) AS count FROM projection_outbox WHERE projector_id='core-external-attention-v1' AND state='completed'").get().count, 1);
      inspect.close();
      await reopened.close();
    });
  }
});

test('stale revision, fence, lease owner, or lease id rejects before provider execution', async (t) => {
  const { core, work, authority } = await setupClaimedPoll(t);
  let providerCalls = 0;
  const bridge = createCoreExternalMcpHandler({
    core, hashContent, attentionValve: inertAttention(),
    runtime: {
      store: { get: () => null },
      async tick() { providerCalls += 1; return { ok: true }; },
    },
    notificationService: { async register() {} },
  });
  const invalid = [
    { ...authority, expectedRevision: authority.expectedRevision + 1 },
    { ...authority, fenceToken: authority.fenceToken + 1 },
    { ...authority, leaseOwner: 'other-worker' },
    { ...authority, leaseId: 'other-lease' },
  ];
  for (const candidateAuthority of invalid) {
    await assert.rejects(bridge.handler({ work, authority: candidateAuthority }), {
      code: 'CORE_EXTERNAL_POLL_AUTHORITY_STALE',
    });
  }
  assert.equal(providerCalls, 0);
  await core.close();
});

test('expired authority and wrong task or payload reject before provider execution', async (t) => {
  let providerCalls = 0;
  const runtime = {
    store: { get: () => null },
    async tick() { providerCalls += 1; return { ok: true }; },
  };
  const fixtures = [
    await setupClaimedPoll(t, { taskKind: 'system_maintenance' }),
    await setupClaimedPoll(t, { payloadRef: 'external-poll:forum-mcp' }),
  ];
  for (const fixture of fixtures) {
    const bridge = createCoreExternalMcpHandler({
      core: fixture.core, runtime, hashContent, attentionValve: inertAttention(),
      notificationService: { async register() {} },
    });
    await assert.rejects(bridge.handler({ work: fixture.work, authority: fixture.authority }), {
      code: 'CORE_EXTERNAL_POLL_AUTHORITY_STALE',
    });
    await fixture.core.close();
  }
  const expired = await setupClaimedPoll(t, { leaseUntil: '2026-08-08T08:01:01.000Z' });
  const expiredBridge = createCoreExternalMcpHandler({
    core: expired.core, runtime, hashContent, attentionValve: inertAttention(),
    notificationService: { async register() {} },
  });
  expired.setNow('2026-08-08T08:01:02.000Z');
  await assert.rejects(expiredBridge.handler({ work: expired.work, authority: expired.authority }), {
    code: 'CORE_EXTERNAL_POLL_AUTHORITY_STALE',
  });
  assert.equal(providerCalls, 0);
  await expired.core.close();
});

test('stale external activity revision rejects the candidate and records no fact', async (t) => {
  const { core, work, authority } = await setupClaimedPoll(t);
  let bridge;
  let providerCalls = 0;
  const activity = {
    activityId: 'activity-1', status: 'active', revision: 4,
    scope: { serverId: 'forum-mcp' }, checkpoint: { stateDigest: 'checkpoint-4' },
  };
  const runtime = {
    store: { get: () => activity },
    async tick() {
      providerCalls += 1;
      await bridge.submitCandidate(readyCandidate(), {
        activityId: 'activity-1', revision: 3, checkpointDigest: 'checkpoint-4',
      });
      return { ok: true };
    },
  };
  bridge = createCoreExternalMcpHandler({
    core, runtime, hashContent, attentionValve: inertAttention(),
    notificationService: { async register() {} },
  });
  await assert.rejects(bridge.handler({ work, authority }), {
    code: 'CORE_EXTERNAL_POLL_INPUT_INVALID',
  });
  assert.equal(providerCalls, 1);
  const inspect = openTestInspector(core.dbPath);
  assert.equal(inspect.prepare("SELECT count(*) AS count FROM journal_event WHERE event_type='external_poll_fact_observed'").get().count, 0);
  inspect.close();
  await core.close();
});

test('terminal WorkRun survives reopen without another provider effect or fact', async (t) => {
  const fixture = await setupClaimedPoll(t, { claimWork: false });
  let providerCalls = 0;
  let bridge;
  const activity = {
    activityId: 'activity-1', status: 'active', revision: 1,
    scope: { serverId: 'forum-mcp' }, checkpoint: { stateDigest: 'checkpoint-1' },
  };
  const runtime = {
    store: { get: () => activity },
    async tick() {
      providerCalls += 1;
      await bridge.submitCandidate(readyCandidate(), {
        activityId: 'activity-1', revision: 1, checkpointDigest: 'checkpoint-1',
      });
      return { ok: true };
    },
  };
  bridge = createCoreExternalMcpHandler({
    core: fixture.core, runtime, hashContent, attentionValve: inertAttention(),
    notificationService: { async register() {} },
  });
  const worker = createCoreWorkRunWorker({
    core: fixture.core, hashContent, handlers: { external_poll: bridge.handler },
    workerId: 'external-mcp-worker', now: fixture.now,
  });
  assert.equal((await worker.runOnce())[0].state, 'completed');
  assert.equal(providerCalls, 1);
  await fixture.core.close();

  const reopened = openCoreDatabase({ dbPath: fixture.dbPath, now: fixture.now });
  const reopenedRuntime = {
    store: { get: () => activity },
    async tick() { providerCalls += 1; return { ok: true }; },
  };
  const reopenedBridge = createCoreExternalMcpHandler({
    core: reopened, runtime: reopenedRuntime, hashContent, attentionValve: inertAttention(),
    notificationService: { async register() {} },
  });
  const reopenedWorker = createCoreWorkRunWorker({
    core: reopened, hashContent, handlers: { external_poll: reopenedBridge.handler },
    workerId: 'external-mcp-worker', now: fixture.now,
  });
  assert.deepEqual(await reopenedWorker.runOnce(), []);
  assert.equal(providerCalls, 1);
  const inspect = openTestInspector(fixture.dbPath);
  assert.equal(inspect.prepare("SELECT count(*) AS count FROM journal_event WHERE event_type='external_poll_fact_observed'").get().count, 1);
  inspect.close();
  await reopened.close();
});

test('paused Core external-poll activity produces no WorkRun or provider call', async (t) => {
  const { core, work } = await setupClaimedPoll(t, { activityState: 'paused' });
  let providerCalls = 0;
  assert.equal(work, null);
  const worker = createCoreWorkRunWorker({
    core, hashContent, now: () => new Date('2026-08-08T08:01:00.000Z'),
    handlers: { external_poll: async () => { providerCalls += 1; return { resultRef: 'unexpected' }; } },
  });
  assert.deepEqual(await worker.runOnce(), []);
  assert.equal(providerCalls, 0);
  await core.close();
});
