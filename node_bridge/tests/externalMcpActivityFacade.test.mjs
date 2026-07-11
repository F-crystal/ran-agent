import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

let activityFacade = {};
try {
  activityFacade = await import('../src/externalMcp/activityFacade.mjs');
} catch {}

const ACTOR = Object.freeze({
  actorKey: 'actor:owner:abc',
  conversationKey: 'conversation:wechat:home',
  platform: 'wechat',
});
const TERMINAL_STATES = ['completed', 'blocked', 'stopped', 'expired'];

function normalizeGoal(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function digestGoal(value) {
  return createHash('sha256').update(normalizeGoal(value), 'utf8').digest('hex');
}

function receiptFor(selection, overrides = {}) {
  return {
    jobId: `job_external_${selection.goalDigest.slice(0, 16)}`,
    actorKey: selection.actorKey,
    goalDigest: selection.goalDigest,
    status: 'active',
    nextRunAt: '2026-07-10T12:00:00.000Z',
    terminalStates: TERMINAL_STATES,
    ...overrides,
  };
}

function activity(goal, overrides = {}) {
  const domain = overrides.domain || 'game';
  const selection = {
    actorKey: overrides.actorKey || ACTOR.actorKey,
    conversationKey: overrides.conversationKey || ACTOR.conversationKey,
    domain,
    goalDigest: overrides.goalDigest || digestGoal(goal),
  };
  return {
    activityId: overrides.activityId || `activity-${selection.goalDigest.slice(0, 8)}`,
    ...selection,
    goal,
    normalizedGoal: normalizeGoal(goal),
    status: overrides.status || 'active',
    committed: overrides.committed ?? true,
    firstWakeCommitted: overrides.firstWakeCommitted ?? true,
    receipt: overrides.receipt || receiptFor(selection),
  };
}

function supervisorFixture({ activities = [], commitImpl } = {}) {
  const calls = { list: [], commit: [] };
  return {
    calls,
    supervisor: {
      async listActivities(scope) {
        calls.list.push(scope);
        return activities;
      },
      async commit(input) {
        calls.commit.push(input);
        if (commitImpl) return await commitImpl(input);
        return {
          committed: true,
          firstWakeCommitted: true,
          receipt: receiptFor(input.selection),
        };
      },
    },
  };
}

function durableRequest(overrides = {}) {
  return {
    requestRef: 'j1',
    command: 'start_or_resume',
    goal: '继续玩这个游戏直到第一关结束',
    environmentHint: 'game',
    reporting: { style: 'milestone' },
    ...overrides,
  };
}

test('accepts only the untrusted facade declaration and rejects every model-supplied private field', async () => {
  assert.equal(typeof activityFacade.createExternalMcpActivityFacade, 'function');
  const fixture = supervisorFixture();
  const facade = activityFacade.createExternalMcpActivityFacade({ supervisor: fixture.supervisor });
  for (const field of [
    'actor', 'actorKey', 'recipient', 'recipientId', 'server', 'serverId',
    'session', 'sessionId', 'activity', 'activityId', 'grant', 'grantId',
    'token', 'profile', 'transport', 'scope', 'budget', 'receipt',
    'operation', 'operationId', 'consent', 'consentDecision',
  ]) {
    await assert.rejects(
      facade.handle({ ...durableRequest(), [field]: 'model-value' }, ACTOR),
      (error) => error?.code === 'EXTERNAL_ACTIVITY_PRIVATE_FIELD',
      field,
    );
  }
  await assert.rejects(
    facade.handle({ ...durableRequest(), reporting: { style: 'milestone', token: 'model-token' } }, ACTOR),
    (error) => error?.code === 'EXTERNAL_ACTIVITY_PRIVATE_FIELD',
  );
  await assert.rejects(
    facade.handle({ ...durableRequest(), surprise: true }, ACTOR),
    (error) => error?.code === 'EXTERNAL_ACTIVITY_UNKNOWN_FIELD',
  );
  assert.equal(fixture.calls.list.length, 0);
  assert.equal(fixture.calls.commit.length, 0);
});

test('derives the private selection key only from trusted actor, conversation, domain, and normalized goal', async () => {
  const fixture = supervisorFixture();
  const facade = activityFacade.createExternalMcpActivityFacade({ supervisor: fixture.supervisor });
  const result = await facade.handle(durableRequest(), ACTOR);

  assert.equal(fixture.calls.commit.length, 1);
  const committed = fixture.calls.commit[0];
  assert.equal(committed.action, 'start');
  assert.deepEqual(committed.selection, {
    actorKey: ACTOR.actorKey,
    conversationKey: ACTOR.conversationKey,
    domain: 'game',
    goalDigest: digestGoal(durableRequest().goal),
    key: `${ACTOR.actorKey}|${ACTOR.conversationKey}|game|${digestGoal(durableRequest().goal)}`,
  });
  assert.deepEqual(committed.actorContext, ACTOR);
  assert.equal(result.action, 'started');
  assert.deepEqual(result.receipt, receiptFor(committed.selection));
  assert.equal(Object.isFrozen(result.receipt), true);
  assert.equal(Object.isFrozen(result.receipt.terminalStates), true);
});

test('accepts the envelope preferences alias without exposing private activity fields', async () => {
  const fixture = supervisorFixture();
  const facade = activityFacade.createExternalMcpActivityFacade({ supervisor: fixture.supervisor });
  await facade.handle(durableRequest({ reporting: undefined, preferences: { cadence: 'milestone' } }), ACTOR);
  assert.deepEqual(fixture.calls.commit[0].reporting, { cadence: 'milestone' });
});

test('normalized goal digest ignores case, punctuation, spacing, and requestRef correlation labels', async () => {
  const fixture = supervisorFixture();
  const facade = activityFacade.createExternalMcpActivityFacade({ supervisor: fixture.supervisor });
  await facade.handle(durableRequest({ requestRef: 'first', goal: 'Keep   Playing: FOREST!' }), ACTOR);
  await facade.handle(durableRequest({ requestRef: 'second', goal: 'keep playing forest' }), ACTOR);
  assert.equal(fixture.calls.commit[0].selection.goalDigest, fixture.calls.commit[1].selection.goalDigest);
  assert.equal(fixture.calls.commit[0].selection.key, fixture.calls.commit[1].selection.key);
});

test('dedupes an exact active start and resumes the same unfinished goal', async () => {
  const goal = durableRequest().goal;
  const activeFixture = supervisorFixture({ activities: [activity(goal)] });
  const activeFacade = activityFacade.createExternalMcpActivityFacade({ supervisor: activeFixture.supervisor });
  const deduped = await activeFacade.handle(durableRequest(), ACTOR);
  assert.equal(deduped.action, 'deduped');
  assert.equal(activeFixture.calls.commit.length, 0);

  const pausedFixture = supervisorFixture({ activities: [activity(goal, { status: 'paused' })] });
  const pausedFacade = activityFacade.createExternalMcpActivityFacade({ supervisor: pausedFixture.supervisor });
  const resumed = await pausedFacade.handle(durableRequest(), ACTOR);
  assert.equal(resumed.action, 'resumed');
  assert.equal(pausedFixture.calls.commit[0].action, 'resume');
  assert.equal(pausedFixture.calls.commit[0].activityId, activity(goal).activityId);
});

test('adjust and stop with zero matches are no-ops while multiple matches ask one natural clarification', async () => {
  const emptyFixture = supervisorFixture();
  const emptyFacade = activityFacade.createExternalMcpActivityFacade({ supervisor: emptyFixture.supervisor });
  for (const command of ['adjust', 'stop']) {
    const result = await emptyFacade.handle({ requestRef: command, command, reference: '森林游戏' }, ACTOR);
    assert.equal(result.action, 'noop');
    assert.equal(result.receipt, null);
  }
  assert.equal(emptyFixture.calls.commit.length, 0);

  const multipleFixture = supervisorFixture({
    activities: [
      activity('持续玩森林游戏', { activityId: 'private-game-id' }),
      activity('持续观察论坛更新', { activityId: 'private-forum-id', domain: 'forum' }),
    ],
  });
  const multipleFacade = activityFacade.createExternalMcpActivityFacade({ supervisor: multipleFixture.supervisor });
  const clarification = await multipleFacade.handle({ requestRef: 'a1', command: 'adjust' }, ACTOR);
  assert.equal(clarification.action, 'clarify');
  assert.match(clarification.message, /游戏|论坛/);
  assert.doesNotMatch(clarification.message, /private-|activity|session|MCP|ID/i);
  assert.equal(multipleFixture.calls.commit.length, 0);
});

test('natural reference selects one unfinished activity for adjust and preserves omitted goal', async () => {
  const forum = activity('持续观察论坛更新', { activityId: 'forum-watch-private', domain: 'forum' });
  const fixture = supervisorFixture({
    activities: [activity('持续玩森林游戏'), forum],
  });
  const facade = activityFacade.createExternalMcpActivityFacade({ supervisor: fixture.supervisor });
  const result = await facade.handle({
    requestRef: 'a1',
    command: 'adjust',
    reference: '论坛更新',
    reporting: { style: 'final_only' },
  }, ACTOR);
  assert.equal(result.action, 'adjusted');
  assert.equal(fixture.calls.commit[0].activityId, forum.activityId);
  assert.equal(fixture.calls.commit[0].selection.goalDigest, forum.goalDigest);
  assert.equal(fixture.calls.commit[0].goal, forum.goal);
});

test('stop all affects only unfinished activities owned by the current actor and conversation', async () => {
  const currentGame = activity('持续玩森林游戏', { activityId: 'current-game' });
  const currentForum = activity('持续观察论坛更新', { activityId: 'current-forum', domain: 'forum' });
  const fixture = supervisorFixture({
    activities: [
      currentGame,
      currentForum,
      activity('其他人的游戏', { activityId: 'foreign-actor', actorKey: 'actor:other' }),
      activity('另一个对话的游戏', { activityId: 'foreign-conversation', conversationKey: 'conversation:other' }),
      activity('已经完成', { activityId: 'completed-current', status: 'completed' }),
    ],
  });
  const facade = activityFacade.createExternalMcpActivityFacade({ supervisor: fixture.supervisor });
  const result = await facade.handle({ requestRef: 's1', command: 'stop', goal: '停止全部' }, ACTOR);
  assert.equal(result.action, 'stopped_all');
  assert.deepEqual(fixture.calls.commit[0].activityIds, [currentGame.activityId, currentForum.activityId]);
  assert.equal(fixture.calls.commit[0].selection.actorKey, ACTOR.actorKey);
  assert.equal(fixture.calls.commit[0].selection.conversationKey, ACTOR.conversationKey);
});

test('one-shot reads and protected first-party capabilities never create an activity', async () => {
  const fixture = supervisorFixture();
  const facade = activityFacade.createExternalMcpActivityFacade({ supervisor: fixture.supervisor });
  const goals = [
    '总结这个小红书链接 https://www.xiaohongshu.com/explore/1',
    '读取这个 B站 视频内容',
    '总结这篇微信公众号文章',
    '看看这个网易云音乐链接',
    '读取并总结 https://example.com/article',
    '继续总结这个小红书链接 https://www.xiaohongshu.com/explore/1',
    '持续读取普通 URL https://example.com/article',
    '打开 co-reading 共读这本书',
    '生成一张图片',
    '记住我喜欢简短回复',
    '现在几点',
    '找一个表情包',
    '用 Playwright 调试浏览器',
  ];
  for (let index = 0; index < goals.length; index += 1) {
    const result = await facade.handle(durableRequest({ requestRef: `r${index}`, goal: goals[index], environmentHint: '' }), ACTOR);
    assert.equal(result.action, 'noop', goals[index]);
    assert.equal(result.reason, 'not_durable_environment_goal', goals[index]);
  }
  assert.equal(fixture.calls.list.length, 0);
  assert.equal(fixture.calls.commit.length, 0);
});

test('starts only an explicit structured activity request, without using durable phrase matching as authority', async () => {
  const fixture = supervisorFixture();
  const facade = activityFacade.createExternalMcpActivityFacade({ supervisor: fixture.supervisor });
  const cases = [
    ['在当前环境里保留进度', 'game', 'game'],
    ['在当前主题里保留草稿', 'forum', 'forum'],
    ['执行已授权的设备安全观察', 'device', 'embodied'],
  ];
  for (let index = 0; index < cases.length; index += 1) {
    const [goal, environmentHint, domain] = cases[index];
    const result = await facade.handle(durableRequest({ requestRef: `d${index}`, goal, environmentHint }), ACTOR);
    assert.equal(result.action, 'started');
    assert.equal(fixture.calls.commit[index].selection.domain, domain);
  }
  assert.equal(fixture.calls.commit.length, cases.length);
});

test('returns no receipt unless supervisor state and first wake are committed with exact Core bindings', async () => {
  const failures = [
    async (input) => ({ committed: false, firstWakeCommitted: true, receipt: receiptFor(input.selection) }),
    async (input) => ({ committed: true, firstWakeCommitted: false, receipt: receiptFor(input.selection) }),
    async (input) => ({
      committed: true,
      firstWakeCommitted: true,
      receipt: receiptFor(input.selection, { actorKey: 'actor:other' }),
    }),
    async (input) => ({
      committed: true,
      firstWakeCommitted: true,
      receipt: receiptFor(input.selection, { goalDigest: 'f'.repeat(64) }),
    }),
  ];
  for (const commitImpl of failures) {
    const fixture = supervisorFixture({ commitImpl });
    const facade = activityFacade.createExternalMcpActivityFacade({ supervisor: fixture.supervisor });
    await assert.rejects(
      facade.handle(durableRequest(), ACTOR),
      (error) => ['EXTERNAL_ACTIVITY_NOT_COMMITTED', 'EXTERNAL_ACTIVITY_RECEIPT_UNTRUSTED'].includes(error?.code),
    );
  }
});

test('uses a runtime supported by the Node 22.13 production floor', () => {
  const [major, minor] = process.versions.node.split('.').map(Number);
  assert.equal(major > 22 || (major === 22 && minor >= 13), true);
});
