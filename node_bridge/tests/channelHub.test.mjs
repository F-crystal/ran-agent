import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { handleIncomingMessage } from '../src/channelHub.mjs';
import { readTimelineRecords } from '../src/globalTimeline.mjs';

function tempEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ran-agent-channel-hub-'));
  return {
    RAN_AGENT_GLOBAL_TIMELINE_PATH: path.join(dir, 'timeline.jsonl'),
    RAN_AGENT_IDENTITY_MAP_PATH: path.join(dir, 'identity-map.json'),
  };
}

test('channel hub routes normalized WeChat message through replyBackend and timeline', async () => {
  const env = tempEnv();
  let backendMessage = null;
  let sent = null;
  const response = await handleIncomingMessage({
    id: 'wx-msg-1',
    platform: 'wechat',
    channel_type: 'dm',
    conversation_id: 'wx-conv',
    sender_id: 'wx-user',
    text: '我们聊内莉·布莱',
    created_at: 1000,
  }, {
    env,
    logger: { log() {}, warn() {}, error() {}, info() {} },
    replyBackend: {
      async getReply(message) {
        backendMessage = message;
        return { replyText: '她的故事确实动人', followUpMessages: [], media: null };
      },
    },
    adapter: {
      async sendReply(payload) {
        sent = payload;
      },
    },
  });

  assert.equal(response.replyText, '她的故事确实动人');
  assert.equal(backendMessage.platform, 'wechat');
  assert.equal(backendMessage.global_user_id, 'user:ran');
  assert.match(backendMessage.hermes_session_id, /^ran-agent-wechat-/);
  assert.match(backendMessage.hermes_session_key, /^ran-agent-memory-/);
  assert.equal(sent.text, '她的故事确实动人');

  const records = readTimelineRecords({ timelinePath: env.RAN_AGENT_GLOBAL_TIMELINE_PATH });
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((item) => item.role), ['user', 'assistant']);
});

test('channel hub provides cross-platform active topic to Feishu message', async () => {
  const env = tempEnv();
  await handleIncomingMessage({
    id: 'wx-msg-1',
    platform: 'wechat',
    channel_type: 'dm',
    conversation_id: 'wx-conv',
    sender_id: 'wx-user',
    text: '我们聊内莉·布莱，她把自己送进疯人院这个故事',
    created_at: 1000,
  }, {
    env,
    logger: { log() {}, warn() {}, error() {}, info() {} },
    replyBackend: { async getReply() { return { replyText: '记住这个话题', followUpMessages: [], media: null }; } },
  });

  let backendMessage = null;
  await handleIncomingMessage({
    id: 'fs-msg-1',
    platform: 'feishu',
    channel_type: 'dm',
    conversation_id: 'chat-a',
    sender_id: 'ou-user',
    text: '我觉得她的故事特别令人感动',
    created_at: 1001,
  }, {
    env,
    logger: { log() {}, warn() {}, error() {}, info() {} },
    replyBackend: {
      async getReply(message) {
        backendMessage = message;
        return { replyText: '接上她的故事', followUpMessages: [], media: null };
      },
    },
  });

  assert.match(backendMessage.continuity_note, /内莉/);
  assert.equal(backendMessage.recent_global_history.some((item) => item.content.includes('内莉')), true);
});
