import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  appendTurn,
  buildContinuityNote,
  getActiveTopic,
  getGlobalRecentHistory,
  getLocalRecentHistory,
  readTimelineRecords,
} from '../src/globalTimeline.mjs';

function tempTimelinePath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ran-agent-timeline-')), 'timeline.jsonl');
}

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
