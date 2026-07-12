import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  appendTurn,
  buildContinuityNote,
  compactTimeline,
  getActiveTopic,
  getActiveTopicContext,
  getGlobalRecentHistory,
  getGlobalTimelineConfig,
  getLocalRecentHistory,
  readTimelineRecords,
} from '../src/globalTimeline.mjs';
import { createIsolatedTestEnv } from './helpers/isolatedState.mjs';

function tempTimelinePath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ran-agent-timeline-')), 'timeline.jsonl');
}

test('test-state timeline config derives both paths and never falls back to production', (t) => {
  const env = createIsolatedTestEnv(t, {}, 'timeline-config-');
  const config = getGlobalTimelineConfig({ NODE_ENV: 'test', RAN_AGENT_ALLOW_TEST_STATE_DIR: '1', RAN_AGENT_STATE_DIR: env.RAN_AGENT_STATE_DIR });
  assert.equal(config.timelinePath, path.join(env.RAN_AGENT_STATE_DIR, 'global-timeline.jsonl'));
  assert.equal(config.archiveDir, path.join(env.RAN_AGENT_STATE_DIR, 'timeline_archive'));
  assert.ok(config.timelinePath.startsWith(env.RAN_AGENT_STATE_DIR));
  assert.ok(config.archiveDir.startsWith(env.RAN_AGENT_STATE_DIR));
  assert.throws(() => getGlobalTimelineConfig({ NODE_ENV: 'test', RAN_AGENT_ALLOW_TEST_STATE_DIR: '1' }), /production state/);
  assert.throws(() => getGlobalTimelineConfig({ NODE_ENV: 'test', RAN_AGENT_ALLOW_TEST_STATE_DIR: '1', RAN_AGENT_STATE_DIR: env.RAN_AGENT_STATE_DIR, RAN_AGENT_GLOBAL_TIMELINE_PATH: '/opt/ran_agent/.ran_agent_state/global-timeline.jsonl' }), /production state/);
  assert.throws(() => getGlobalTimelineConfig({ NODE_ENV: 'test', RAN_AGENT_ALLOW_TEST_STATE_DIR: '1', RAN_AGENT_STATE_DIR: env.RAN_AGENT_STATE_DIR, RAN_AGENT_TIMELINE_ARCHIVE_DIR: '/opt/ran_agent/.ran_agent_state/timeline_archive' }), /production state/);
  assert.throws(() => getGlobalTimelineConfig({ NODE_ENV: 'test', RAN_AGENT_ALLOW_TEST_STATE_DIR: '1', RAN_AGENT_GLOBAL_TIMELINE_PATH: '/opt/ran_agent/.ran_agent_state/global-timeline.jsonl', RAN_AGENT_TIMELINE_ARCHIVE_DIR: '/opt/ran_agent/.ran_agent_state/timeline_archive' }), /production state/);
});

test('isolated state helper owns both timeline paths', (t) => {
  const env = createIsolatedTestEnv(t, {}, 'timeline-helper-');
  assert.equal(env.RAN_AGENT_GLOBAL_TIMELINE_PATH, path.join(env.RAN_AGENT_STATE_DIR, 'global-timeline.jsonl'));
  assert.equal(env.RAN_AGENT_TIMELINE_ARCHIVE_DIR, path.join(env.RAN_AGENT_STATE_DIR, 'timeline_archive'));
});

test('global timeline appends user and assistant turns with hashed ids', () => {
  const timelinePath = tempTimelinePath();
  appendTurn({
    timelinePath,
    id: 'msg-1',
    global_user_id: 'user:ran',
    platform: 'wechat',
    channel_type: 'dm',
    conversation_id: 'wx-secret-conv',
    sender_id: 'wx-secret-user',
    role: 'user',
    text: '我们聊内莉·布莱',
    created_at: 1000,
  });
  appendTurn({
    timelinePath,
    id: 'reply-1',
    global_user_id: 'user:ran',
    platform: 'wechat',
    channel_type: 'dm',
    conversation_id: 'wx-secret-conv',
    sender_id: 'assistant',
    role: 'assistant',
    text: '她是卧底疯人院的记者',
    created_at: 1001,
  });

  const records = readTimelineRecords({ timelinePath });
  assert.equal(records.length, 2);
  assert.match(records[0].conversation_id_hash, /^[a-f0-9]{16}$/);
  assert.equal(JSON.stringify(records).includes('wx-secret-conv'), false);
  assert.equal(records[0].text, '我们聊内莉·布莱');
});

test('global timeline returns local and global recent history', () => {
  const timelinePath = tempTimelinePath();
  appendTurn({ timelinePath, global_user_id: 'user:ran', platform: 'wechat', channel_type: 'dm', conversation_id: 'wx-a', sender_id: 'u', role: 'user', text: '微信话题', created_at: 1 });
  appendTurn({ timelinePath, global_user_id: 'user:ran', platform: 'feishu', channel_type: 'dm', conversation_id: 'fs-a', sender_id: 'u', role: 'user', text: '飞书里继续说内莉·布莱', created_at: 2 });
  appendTurn({ timelinePath, global_user_id: 'user:ran', platform: 'wechat', channel_type: 'dm', conversation_id: 'wx-a', sender_id: 'assistant', role: 'assistant', text: '微信回复', created_at: 3 });

  const local = getLocalRecentHistory({ timelinePath, global_user_id: 'user:ran', platform: 'wechat', conversation_id: 'wx-a', limit: 10, charBudget: 1000 });
  const global = getGlobalRecentHistory({ timelinePath, global_user_id: 'user:ran', limit: 10, charBudget: 1000 });

  assert.deepEqual(local.map((item) => item.content), ['微信话题', '微信回复']);
  assert.equal(global.some((item) => item.content.includes('飞书里继续说内莉·布莱')), true);
});

test('bridge notices are not replayed as Hermes assistant recent history', () => {
  const timelinePath = tempTimelinePath();
  appendTurn({ timelinePath, global_user_id: 'user:ran', platform: 'wechat', channel_type: 'dm', conversation_id: 'wx-a', sender_id: 'u', role: 'user', text: '帮我读一下链接', created_at: 1 });
  appendTurn({ timelinePath, global_user_id: 'user:ran', platform: 'wechat', channel_type: 'dm', conversation_id: 'wx-a', sender_id: 'assistant', role: 'assistant', source: 'bridge_action_gate', text: '链接内容未成功读取，未生成正文判断。', created_at: 2 });
  appendTurn({ timelinePath, global_user_id: 'user:ran', platform: 'wechat', channel_type: 'dm', conversation_id: 'wx-a', sender_id: 'assistant', role: 'assistant', source: 'hermes', text: '可以把截图发来，我再看。', created_at: 3 });

  const local = getLocalRecentHistory({ timelinePath, global_user_id: 'user:ran', platform: 'wechat', conversation_id: 'wx-a', limit: 10, charBudget: 1000 });

  assert.deepEqual(local.map((item) => item.content), ['帮我读一下链接', '可以把截图发来，我再看。']);
});

test('active topic and continuity note include cross-platform referents', () => {
  const timelinePath = tempTimelinePath();
  appendTurn({ timelinePath, global_user_id: 'user:ran', platform: 'wechat', channel_type: 'dm', conversation_id: 'wx-a', sender_id: 'u', role: 'user', text: '我们聊内莉·布莱，她把自己送进疯人院这个故事', created_at: 1 });
  appendTurn({ timelinePath, global_user_id: 'user:ran', platform: 'wechat', channel_type: 'dm', conversation_id: 'wx-a', sender_id: 'assistant', role: 'assistant', text: '内莉·布莱的勇气在于替被消音的人作证。', created_at: 2 });

  const activeTopic = getActiveTopic({ timelinePath, global_user_id: 'user:ran', charBudget: 500 });
  const note = buildContinuityNote({
    message: { text: '我觉得她的故事特别令人感动' },
    localRecent: [],
    globalRecent: getGlobalRecentHistory({ timelinePath, global_user_id: 'user:ran', limit: 4, charBudget: 1000 }),
    activeTopic,
  });

  assert.match(activeTopic, /内莉/);
  assert.match(note, /current_topic/);
  assert.match(note, /不要问/);
});

test('freshness gate downgrades old active topic to stale context', () => {
  const timelinePath = tempTimelinePath();
  const friday = Date.UTC(2026, 5, 26, 10, 0, 0);
  const sunday = Date.UTC(2026, 5, 28, 10, 0, 0);
  appendTurn({
    timelinePath,
    global_user_id: 'user:ran',
    platform: 'wechat',
    channel_type: 'dm',
    conversation_id: 'wx-migration',
    sender_id: 'u',
    role: 'user',
    text: '我换了新电脑，正在迁移资料',
    created_at: friday,
  });

  const context = getActiveTopicContext({
    timelinePath,
    global_user_id: 'user:ran',
    charBudget: 500,
    staleCharBudget: 500,
    now: sunday,
    freshnessHours: 24,
  });
  const note = buildContinuityNote({
    message: { text: '今天天气不错' },
    activeTopic: context.activeTopic,
    staleContext: context.staleContext,
  });

  assert.equal(context.activeTopic.includes('迁移'), false);
  assert.match(context.staleContext, /迁移资料/);
  assert.equal(note.includes('current_topic'), false);
});

test('referential message can use stale context without open loop', () => {
  const timelinePath = tempTimelinePath();
  const friday = Date.UTC(2026, 5, 26, 10, 0, 0);
  const sunday = Date.UTC(2026, 5, 28, 10, 0, 0);
  appendTurn({
    timelinePath,
    global_user_id: 'user:ran',
    platform: 'wechat',
    channel_type: 'dm',
    conversation_id: 'wx-migration',
    sender_id: 'u',
    role: 'user',
    text: '我换了新电脑，正在迁移资料',
    created_at: friday,
  });

  const context = getActiveTopicContext({
    timelinePath,
    global_user_id: 'user:ran',
    charBudget: 500,
    staleCharBudget: 500,
    now: sunday,
    freshnessHours: 24,
  });
  const note = buildContinuityNote({
    message: { text: '上次那个迁移的事，继续说' },
    activeTopic: context.activeTopic,
    staleContext: context.staleContext,
  });

  assert.match(note, /stale_context/);
  assert.match(note, /do_not_assume_current: true/);
  assert.doesNotMatch(note, /current_topic/);
  assert.doesNotMatch(note, /open_loop/);
});

test('freshness gate can be disabled for legacy active topic behavior', () => {
  const timelinePath = tempTimelinePath();
  const friday = Date.UTC(2026, 5, 26, 10, 0, 0);
  const sunday = Date.UTC(2026, 5, 28, 10, 0, 0);
  appendTurn({
    timelinePath,
    global_user_id: 'user:ran',
    platform: 'wechat',
    channel_type: 'dm',
    conversation_id: 'wx-migration',
    sender_id: 'u',
    role: 'user',
    text: '我换了新电脑，正在迁移资料',
    created_at: friday,
  });

  const context = getActiveTopicContext({
    timelinePath,
    global_user_id: 'user:ran',
    charBudget: 500,
    staleCharBudget: 500,
    now: sunday,
    freshnessHours: 0,
  });

  assert.match(context.activeTopic, /迁移资料/);
  assert.equal(context.staleContext, '');
});

test('timeline sanitizes long JSON logs and base64 blobs', () => {
  const timelinePath = tempTimelinePath();
  appendTurn({
    timelinePath,
    global_user_id: 'user:ran',
    platform: 'desktop',
    channel_type: 'desktop',
    conversation_id: 'desktop',
    sender_id: 'client',
    role: 'user',
    text: `log line\n{"payload":"${'x'.repeat(1600)}"}\ndata:image/png;base64,${'a'.repeat(2000)}`,
    created_at: 1,
  });

  const [record] = readTimelineRecords({ timelinePath });
  assert.equal(record.text.includes('data:image/png;base64'), false);
  assert.equal(record.text.includes('x'.repeat(1000)), false);
});

test('appendTurn truncates long text and stores text_summary', () => {
  const timelinePath = tempTimelinePath();
  appendTurn({
    timelinePath,
    global_user_id: 'user:ran',
    platform: 'wechat',
    channel_type: 'dm',
    conversation_id: 'wx-long',
    sender_id: 'u',
    role: 'user',
    text: `内莉·布莱 ${'很长的内容'.repeat(600)}`,
    created_at: 1,
  });

  const [record] = readTimelineRecords({ timelinePath });
  assert.ok(record.text.length <= 2000);
  assert.match(record.text_summary, /内莉/);
  assert.equal(record.text_summary.length <= 800, true);
});

test('appendTurn stores stack traces and journal logs as summaries', () => {
  const timelinePath = tempTimelinePath();
  appendTurn({
    timelinePath,
    global_user_id: 'user:ran',
    platform: 'desktop',
    channel_type: 'desktop',
    conversation_id: 'desktop',
    sender_id: 'client',
    role: 'user',
    text: `journalctl -u ran-agent-node.service\nError: boom\n    at secretFunction (/tmp/app.js:1:2)\n${'line\n'.repeat(200)}`,
    created_at: 1,
  });

  const [record] = readTimelineRecords({ timelinePath });
  assert.match(record.text_summary, /日志或错误堆栈/);
  assert.equal(record.text.includes('secretFunction'), false);
});

test('compactTimeline archives old file and preserves recent local history', () => {
  const timelinePath = tempTimelinePath();
  const archiveDir = path.join(path.dirname(timelinePath), 'archive');
  for (let i = 0; i < 8; i += 1) {
    appendTurn({
      timelinePath,
      global_user_id: 'user:ran',
      platform: 'wechat',
      channel_type: 'dm',
      conversation_id: 'wx-compact',
      sender_id: i % 2 === 0 ? 'u' : 'assistant',
      role: i % 2 === 0 ? 'user' : 'assistant',
      text: i < 5 ? `旧话题 ${i}` : `最近内莉·布莱话题 ${i}`,
      created_at: Date.UTC(2026, 4, 15, 0, 0, i),
    });
  }

  const result = compactTimeline({
    timelinePath,
    archiveDir,
    maxTurns: 4,
    maxBytes: 1024 * 1024,
    retainRecentTurns: 3,
    retentionDays: 0,
  });

  assert.equal(result.compacted, true);
  assert.equal(result.archive_path.endsWith('.jsonl.gz'), true);
  assert.equal(fs.existsSync(result.archive_path), true);

  const local = getLocalRecentHistory({ timelinePath, global_user_id: 'user:ran', platform: 'wechat', conversation_id: 'wx-compact', limit: 10, charBudget: 2000 });
  assert.equal(local.some((item) => item.content.includes('最近内莉·布莱话题')), true);
  assert.equal(local.some((item) => item.content.includes('旧话题 0')), false);
});

test('retention compaction removes expired raw records once without re-compacting summaries', () => {
  const timelinePath = tempTimelinePath();
  const archiveDir = path.join(path.dirname(timelinePath), 'archive');
  const now = Date.UTC(2026, 6, 12, 12, 0, 0);
  const cutoff = now - 24 * 60 * 60 * 1000;
  for (const [id, text, created_at] of [
    ['expired-1', 'expired raw record one', now - 3 * 24 * 60 * 60 * 1000],
    ['expired-2', 'expired raw record two', now - 2 * 24 * 60 * 60 * 1000],
    ['fresh-1', 'fresh raw record', now - 60 * 60 * 1000],
  ]) {
    appendTurn({
      timelinePath,
      id,
      global_user_id: 'user:ran',
      platform: 'wechat',
      channel_type: 'dm',
      conversation_id: 'wx-retention',
      sender_id: 'u',
      role: 'user',
      text,
      created_at,
    });
  }

  const first = compactTimeline({ timelinePath, archiveDir, maxTurns: 10, maxBytes: 1024 * 1024, retentionDays: 1, now });
  assert.equal(first.compacted, true);
  assert.equal(fs.readdirSync(archiveDir).filter((entry) => entry.endsWith('.jsonl.gz')).length, 1);
  assert.equal(readTimelineRecords({ timelinePath, limit: 10 }).filter((record) => !record.compacted).every((record) => record.created_at >= cutoff), true);

  const second = compactTimeline({ timelinePath, archiveDir, maxTurns: 10, maxBytes: 1024 * 1024, retentionDays: 1, now });
  assert.equal(second.compacted, false);
  assert.equal(fs.readdirSync(archiveDir).filter((entry) => entry.endsWith('.jsonl.gz')).length, 1);
});

test('compactTimeline keeps active topic through summary records', () => {
  const timelinePath = tempTimelinePath();
  const archiveDir = path.join(path.dirname(timelinePath), 'archive');
  for (let i = 0; i < 7; i += 1) {
    appendTurn({
      timelinePath,
      global_user_id: 'user:ran',
      platform: 'feishu',
      channel_type: 'dm',
      conversation_id: `fs-${i}`,
      sender_id: 'u',
      role: 'user',
      text: i === 0 ? '我们聊内莉·布莱，她把自己送进疯人院这个故事' : `普通旧话题 ${i}`,
      created_at: Date.UTC(2026, 4, 15, 0, i, 0),
    });
  }

  compactTimeline({ timelinePath, archiveDir, maxTurns: 3, maxBytes: 1024 * 1024, retainRecentTurns: 2 });
  const activeTopic = getActiveTopic({ timelinePath, global_user_id: 'user:ran', charBudget: 1000 });
  assert.match(activeTopic, /内莉/);
});
