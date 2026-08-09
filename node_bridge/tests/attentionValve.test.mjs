import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { createAttentionValve } from '../src/attentionValve.mjs';
import { createIsolatedTestEnv } from './helpers/isolatedState.mjs';

function setup(t, { presence = 'available', criticalAllowlist = [] } = {}) {
  const env = createIsolatedTestEnv(t, {}, 'attention-valve-');
  const statePath = path.join(env.RAN_AGENT_STATE_DIR, 'attention', 'delayed.json');
  let currentPresence = presence;
  let current = new Date('2026-08-08T10:00:00.000Z');
  const valve = createAttentionValve({
    statePath,
    now: () => current,
    presenceProvider: () => currentPresence,
    criticalAllowlist,
  });
  return {
    valve,
    statePath,
    setPresence: (value) => { currentPresence = value; },
    setNow: (value) => { current = new Date(value); },
    reopen: () => createAttentionValve({
      statePath,
      now: () => current,
      presenceProvider: () => currentPresence,
      criticalAllowlist,
    }),
  };
}

test('timely results are delayed and coalesced by fingerprint while the owner is gaming', (t) => {
  const { valve, setPresence } = setup(t, { presence: 'gaming' });
  const first = valve.evaluate({
    contentClass: 'timely', fingerprint: 'rss:kinmen:1', summary: '第一条更新', payloadRef: 'source:revision:1',
  });
  assert.deepEqual(first, {
    disposition: 'delayed', reason: 'presence_gaming', contentClass: 'timely',
    fingerprint: 'rss:kinmen:1', coalescedCount: 1,
  });
  valve.evaluate({ contentClass: 'timely', fingerprint: 'rss:kinmen:1', summary: '第二条更新' });
  const third = valve.evaluate({
    contentClass: 'timely', fingerprint: 'rss:kinmen:1', summary: '第三条更新', payloadRef: 'source:revision:3',
  });
  assert.equal(third.coalescedCount, 3);
  valve.evaluate({ contentClass: 'timely', fingerprint: 'forum:topic:9', summary: '另一个来源' });

  const pending = valve.listPending();
  assert.equal(pending.length, 2);
  const coalesced = pending.find((item) => item.fingerprint === 'rss:kinmen:1');
  assert.equal(coalesced.count, 3);
  assert.equal(coalesced.summary, '第三条更新');
  assert.equal(coalesced.payloadRef, 'source:revision:3');
  assert.equal(coalesced.state, 'pending');

  setPresence('focused');
  assert.deepEqual(valve.flush(), []);
  assert.equal(valve.listPending().length, 2);

  setPresence('available');
  const flushed = valve.flush();
  assert.equal(flushed.length, 2);
  assert.equal(flushed.find((item) => item.fingerprint === 'rss:kinmen:1').count, 3);
  assert.equal(flushed[0].state, 'flushing');
  assert.equal(valve.listPending().length, 0);
  valve.confirmFlushed('rss:kinmen:1');
  valve.confirmFlushed('forum:topic:9');
  assert.equal(valve.flush().length, 0);
});

test('delayed items survive restart and an interrupted flush is never lost', (t) => {
  const { valve, setPresence, reopen } = setup(t, { presence: 'dnd' });
  valve.evaluate({ contentClass: 'timely', fingerprint: 'watch:server:7', summary: '关注的服务有动静' });
  valve.evaluate({ contentClass: 'critical', fingerprint: 'watch:server:8', summary: '未列入白名单的 critical' });

  const restarted = reopen();
  assert.equal(restarted.listPending().length, 2);

  setPresence('available');
  const flushed = restarted.flush();
  assert.equal(flushed.length, 2);

  const afterCrash = reopen();
  const recovered = afterCrash.listPending();
  assert.equal(recovered.length, 2);
  assert.ok(recovered.every((item) => item.state === 'pending'));

  const reflushed = afterCrash.flush();
  assert.equal(reflushed.length, 2);
  for (const item of reflushed) afterCrash.confirmFlushed(item.fingerprint);
  assert.equal(afterCrash.listPending().length, 0);
  assert.equal(valve.listPending().length, 0);
});

test('ambient results stay silent and are never stored', (t) => {
  const { valve } = setup(t, { presence: 'gaming' });
  const decision = valve.evaluate({
    contentClass: 'ambient', fingerprint: 'curiosity:1', summary: '背景观察',
  });
  assert.deepEqual(decision, { disposition: 'suppress_silent', contentClass: 'ambient' });
  assert.equal(valve.listPending().length, 0);
});

test('only an owner-allowlisted critical key bypasses quiet presence', (t) => {
  const { valve } = setup(t, { presence: 'gaming', criticalAllowlist: ['reminder:explicit'] });
  const bypass = valve.evaluate({
    contentClass: 'critical', criticalKey: 'reminder:explicit',
    fingerprint: 'reminder:1', summary: '明确提醒',
  });
  assert.deepEqual(bypass, { disposition: 'deliver_now', reason: 'critical_allowlisted', contentClass: 'critical' });

  const downgraded = valve.evaluate({
    contentClass: 'critical', criticalKey: 'model:claimed-urgent',
    fingerprint: 'model:1', summary: '模型自称紧急',
  });
  assert.equal(downgraded.disposition, 'delayed');
  assert.equal(valve.listPending().length, 1);
});

test('explicit owner reminders bypass quiet presence through quiet policy', (t) => {
  const { valve } = setup(t, { presence: 'dnd' });
  const decision = valve.evaluate({
    contentClass: 'timely', quietPolicy: 'ignore_for_explicit_reminder',
    summary: '你定的提醒',
  });
  assert.deepEqual(decision, {
    disposition: 'deliver_now', reason: 'explicit_reminder', contentClass: 'timely',
  });
  assert.equal(valve.listPending().length, 0);

  valve.evaluate({ contentClass: 'timely', fingerprint: 'reminder:explicit:1', summary: '先进入 backlog' });
  const promoted = valve.evaluate({
    contentClass: 'timely', quietPolicy: 'ignore_for_explicit_reminder',
    fingerprint: 'reminder:explicit:1', summary: '同一提醒现在明确要求绕过',
  });
  assert.deepEqual(promoted, decision);
  assert.equal(valve.listPending().length, 0);
});

test('available presence delivers immediately and an unknown reading delays instead of interrupting', (t) => {
  const { valve, setPresence } = setup(t, { presence: 'available' });
  const immediate = valve.evaluate({ contentClass: 'timely', fingerprint: 'rss:1', summary: '立即可达' });
  assert.deepEqual(immediate, {
    disposition: 'deliver_now', reason: 'presence_available', contentClass: 'timely',
  });

  setPresence('adapter-returned-garbage');
  const unknown = valve.evaluate({ contentClass: 'timely', fingerprint: 'rss:2', summary: '读数未知' });
  assert.equal(unknown.disposition, 'delayed');
  assert.equal(unknown.reason, 'presence_unknown');
  assert.equal(valve.listPending().length, 1);

  setPresence('available');
  const flushed = valve.flush();
  assert.equal(flushed.length, 1);
  valve.confirmFlushed('rss:2');
});

test('an equivalent delayed fingerprint stays one candidate when presence becomes available', (t) => {
  const { valve, setPresence } = setup(t, { presence: 'gaming' });
  valve.evaluate({ contentClass: 'timely', fingerprint: 'rss:transition:1', summary: 'first' });

  setPresence('available');
  const equivalent = valve.evaluate({
    contentClass: 'timely', fingerprint: 'rss:transition:1', summary: 'same fact after presence change',
  });
  assert.deepEqual(equivalent, {
    disposition: 'delayed', reason: 'coalesced_existing', contentClass: 'timely',
    fingerprint: 'rss:transition:1', coalescedCount: 2,
  });

  const flushed = valve.flush();
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0].fingerprint, 'rss:transition:1');
  assert.equal(flushed[0].count, 2);
  valve.confirmFlushed('rss:transition:1');
  assert.equal(valve.flush().length, 0);
});

test('confirming a non-flushing item fails closed', (t) => {
  const { valve, setPresence } = setup(t, { presence: 'gaming' });
  valve.evaluate({ contentClass: 'timely', fingerprint: 'rss:3', summary: '待确认' });
  assert.throws(() => valve.confirmFlushed('rss:3'), { code: 'ATTENTION_FLUSH_STATE_INVALID' });
  setPresence('available');
  valve.flush();
  assert.throws(() => valve.confirmFlushed('rss:other'), { code: 'ATTENTION_FLUSH_STATE_INVALID' });
  valve.confirmFlushed('rss:3');
});

test('a fact arriving during flush survives the stale confirmation', (t) => {
  const { valve, setPresence } = setup(t, { presence: 'gaming' });
  valve.evaluate({ contentClass: 'timely', fingerprint: 'rss:race:1', summary: '第一条' });
  setPresence('available');
  const flushed = valve.flush();
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0].count, 1);

  setPresence('gaming');
  const coalesced = valve.evaluate({ contentClass: 'timely', fingerprint: 'rss:race:1', summary: '第二条' });
  assert.equal(coalesced.coalescedCount, 2);
  assert.throws(() => valve.confirmFlushed('rss:race:1'), { code: 'ATTENTION_FLUSH_STATE_INVALID' });

  const pending = valve.listPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].count, 2);
  assert.equal(pending[0].summary, '第二条');

  setPresence('available');
  const reflushed = valve.flush();
  assert.equal(reflushed.length, 1);
  assert.equal(reflushed[0].count, 2);
  valve.confirmFlushed('rss:race:1');
  assert.equal(valve.listPending().length, 0);
});

test('an unconfirmed flush never strands items for the process lifetime', (t) => {
  const { valve, setPresence } = setup(t, { presence: 'gaming' });
  valve.evaluate({ contentClass: 'timely', fingerprint: 'rss:stuck:1', summary: '可能丢投递' });
  setPresence('available');
  const first = valve.flush();
  assert.equal(first.length, 1);
  assert.equal(valve.listPending().length, 0);

  const second = valve.flush();
  assert.equal(second.length, 1);
  assert.equal(second[0].fingerprint, 'rss:stuck:1');
  valve.confirmFlushed('rss:stuck:1');
  assert.equal(valve.listPending().length, 0);
  assert.equal(valve.flush().length, 0);
});
