import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { handleIncomingMessage } from '../src/channelHub.mjs';
import { readTimelineRecords } from '../src/globalTimeline.mjs';
import { createPendingAction, listPendingActions } from '../src/pendingActionState.mjs';

function tempEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ran-agent-channel-hub-'));
  const stateBase = path.join(process.cwd(), '.ran_agent_state', 'test-channel-hub');
  fs.mkdirSync(stateBase, { recursive: true });
  return {
    RAN_AGENT_STATE_DIR: fs.mkdtempSync(path.join(stateBase, 'case-')),
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

test('channel hub suppresses adapter sends for silent synthetic external MCP turns', async () => {
  const env = tempEnv();
  let sendCalled = false;
  const response = await handleIncomingMessage({
    id: 'external-mcp-silent-1',
    platform: 'feishu',
    channel_type: 'dm',
    conversation_id: 'oc-home',
    sender_id: 'ou-home',
    route_hint: 'external_mcp_system_queue',
    text: 'system wake',
    created_at: 1000,
  }, {
    env,
    logger: { log() {}, warn() {}, error() {}, info() {} },
    replyBackend: {
      async getReply() {
        return { replyText: '', suppressSend: true, suppressReason: 'silent', followUpMessages: [], media: null };
      },
    },
    adapter: {
      async sendReply() {
        sendCalled = true;
      },
    },
  });

  assert.equal(response.suppressSend, true);
  assert.equal(sendCalled, false);
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

test('channel hub marks old cross-day topic as stale context', async () => {
  const env = {
    ...tempEnv(),
    HERMES_CONTINUITY_FRESHNESS_HOURS: '24',
  };
  await handleIncomingMessage({
    id: 'wx-migration-friday',
    platform: 'wechat',
    channel_type: 'dm',
    conversation_id: 'wx-migration',
    sender_id: 'wx-user',
    text: '我换了新电脑，正在迁移资料',
    created_at: Date.UTC(2026, 5, 26, 10, 0, 0),
  }, {
    env,
    logger: { log() {}, warn() {}, error() {}, info() {} },
    replyBackend: { async getReply() { return { replyText: '收到', followUpMessages: [], media: null }; } },
  });

  let backendMessage = null;
  await handleIncomingMessage({
    id: 'wx-migration-sunday',
    platform: 'wechat',
    channel_type: 'dm',
    conversation_id: 'wx-migration',
    sender_id: 'wx-user',
    text: '今天天气不错',
    created_at: Date.UTC(2026, 5, 28, 10, 0, 0),
  }, {
    env,
    logger: { log() {}, warn() {}, error() {}, info() {} },
    replyBackend: {
      async getReply(message) {
        backendMessage = message;
        return { replyText: '是不错', followUpMessages: [], media: null };
      },
    },
  });

  assert.equal(String(backendMessage.active_topic || '').includes('迁移'), false);
  assert.match(backendMessage.stale_context, /迁移资料/);
  assert.doesNotMatch(backendMessage.continuity_note, /current_topic/);
});

test('channel hub does not persist sticker filePath in assistant media summary', async () => {
  const env = tempEnv();
  const secretPath = '/private/server/stickers/assets/stk_001.png';

  await handleIncomingMessage({
    id: 'wx-sticker-summary',
    platform: 'wechat',
    channel_type: 'dm',
    conversation_id: 'wx-conv',
    sender_id: 'wx-user',
    text: '来张贴纸',
    created_at: 1000,
  }, {
    env,
    logger: { log() {}, warn() {}, error() {}, info() {} },
    replyBackend: {
      async getReply() {
        return {
          replyText: '给你',
          followUpMessages: [],
          media: {
            source: 'sticker_catalog',
            kind: 'sticker',
            stickerId: 'stk_001',
            mime: 'image/png',
            fileName: 'stk_001.png',
            filePath: secretPath,
          },
        };
      },
    },
  });

  const records = readTimelineRecords({ timelinePath: env.RAN_AGENT_GLOBAL_TIMELINE_PATH });
  const assistant = records.find((item) => item.role === 'assistant');
  assert.equal(String(assistant.media_summary || '').includes(secretPath), false);
  assert.match(assistant.media_summary, /"stickerId":"stk_001"/);
});

test('channel hub reply pipeline emits action contract telemetry automatically', async () => {
  const env = {
    ...tempEnv(),
    HERMES_ACTION_GATE_ENABLED: 'true',
    HERMES_ACTION_GATE_MODE: 'observe',
    HERMES_ACTION_GATE_MAX_REPAIR_ATTEMPTS: '1',
  };
  const logs = [];

  const response = await handleIncomingMessage({
    id: 'wx-action-contract',
    platform: 'wechat',
    channel_type: 'dm',
    conversation_id: 'wx-action-conv',
    sender_id: 'wx-user',
    text: '帮我读一下 http://xhslink.com/o/abc123',
    created_at: 1000,
  }, {
    env,
    logger: { log(message) { logs.push(String(message)); }, warn() {}, error() {}, info() {} },
    chatImpl: async () => ({
      reply_text: '我读到了，这篇小红书主要说旅行。',
      follow_up_messages: [],
      media: null,
      model: 'deepseek-v4-flash',
    }),
    ingestImpl: async () => ({ ok: true }),
  });

  assert.equal(response.replyText, '我读到了，这篇小红书主要说旅行。');
  const line = logs.find((item) => item.startsWith('[hermes-action-contract] '));
  assert.ok(line);
  const payload = JSON.parse(line.replace('[hermes-action-contract] ', ''));
  assert.equal(payload.intent, 'social_read');
  assert.equal(payload.gate_mode, 'observe');
  assert.equal(payload.gate_decision, 'observe_only');
  assert.equal(payload.evidence_satisfied, false);
  assert.equal(line.includes('abc123'), false);
  assert.equal(line.includes('旅行'), false);
});

test('channel hub enforce mode sends safe rewrite for unsupported action claims', async () => {
  const env = {
    ...tempEnv(),
    HERMES_ACTION_GATE_ENABLED: 'true',
    HERMES_ACTION_GATE_MODE: 'enforce',
    HERMES_ACTION_GATE_MAX_REPAIR_ATTEMPTS: '1',
  };
  const logs = [];
  let sent = null;

  const response = await handleIncomingMessage({
    id: 'wx-action-enforce',
    platform: 'wechat',
    channel_type: 'dm',
    conversation_id: 'wx-action-enforce-conv',
    sender_id: 'wx-user',
    text: '帮我读一下 http://xhslink.com/o/abc123',
    created_at: 1000,
  }, {
    env,
    logger: { log(message) { logs.push(String(message)); }, warn() {}, error() {}, info() {} },
    chatImpl: async () => ({
      reply_text: '我已经完整读完了，这篇小红书主要说旅行。',
      follow_up_messages: [],
      media: null,
      model: 'deepseek-v4-flash',
    }),
    ingestImpl: async () => ({ ok: true }),
    adapter: {
      async sendReply(payload) {
        sent = payload;
      },
    },
  });

  const rewritten = '链接内容未成功读取，未生成正文判断。可以重试，或发送截图/正文。';
  assert.equal(response.replyText, rewritten);
  assert.equal(sent.text, rewritten);
  const line = logs.find((item) => item.startsWith('[hermes-action-contract] '));
  const payload = JSON.parse(line.replace('[hermes-action-contract] ', ''));
  assert.equal(payload.gate_decision, 'rewrite');
  assert.equal(payload.final_action, 'safe_rewrite');
});

test('channel hub repair mode applies repaired reply through adapter', async () => {
  const env = {
    ...tempEnv(),
    HERMES_ACTION_GATE_ENABLED: 'true',
    HERMES_ACTION_GATE_MODE: 'repair',
    HERMES_ACTION_GATE_MAX_REPAIR_ATTEMPTS: '1',
  };
  const logs = [];
  let sent = null;
  let repairCalls = 0;

  const response = await handleIncomingMessage({
    id: 'wx-action-repair',
    platform: 'wechat',
    channel_type: 'dm',
    conversation_id: 'wx-action-repair-conv',
    sender_id: 'wx-user',
    text: '帮我读一下 http://xhslink.com/o/abc123',
    created_at: 1000,
  }, {
    env,
    logger: { log(message) { logs.push(String(message)); }, warn() {}, error() {}, info() {} },
    chatImpl: async () => ({
      reply_text: '我已经完整读完了，这篇小红书主要说旅行。',
      follow_up_messages: [],
      media: null,
      model: 'deepseek-v4-flash',
    }),
    actionRepairImpl: async () => {
      repairCalls += 1;
      return {
        ok: true,
        status: 'success',
        repairedReply: '链接内容已读取：它在讲旅行规划。',
        toolResult: { toolName: 'mcp_social_reader_read_social_post_deep', ok: true, artifact_id: 'private-artifact' },
      };
    },
    ingestImpl: async () => ({ ok: true }),
    adapter: {
      async sendReply(payload) {
        sent = payload;
      },
    },
  });

  assert.equal(repairCalls, 1);
  assert.equal(response.replyText, '链接内容已读取：它在讲旅行规划。');
  assert.equal(sent.text, '链接内容已读取：它在讲旅行规划。');
  const line = logs.find((item) => item.startsWith('[hermes-action-contract] '));
  const payload = JSON.parse(line.replace('[hermes-action-contract] ', ''));
  assert.equal(payload.repair_status, 'success');
  assert.equal(payload.final_action, 'repair_success');
});

test('channel hub scheduled digest path does not trigger sticker repair', async () => {
  const env = {
    ...tempEnv(),
    HERMES_ACTION_GATE_ENABLED: 'true',
    HERMES_ACTION_GATE_MODE: 'repair',
    HERMES_ACTION_GATE_MAX_REPAIR_ATTEMPTS: '1',
  };
  let repairCalls = 0;

  const response = await handleIncomingMessage({
    id: 'digest-action-repair',
    platform: 'wechat',
    channel_type: 'dm',
    conversation_id: 'wx-digest-conv',
    sender_id: 'wx-user',
    text: '今日 digest：给你发一个表情包～',
    route_hint: 'scheduled_digest',
    created_at: 1000,
  }, {
    env,
    logger: { log() {}, warn() {}, error() {}, info() {} },
    chatImpl: async () => ({
      reply_text: '给你发一个表情包～',
      follow_up_messages: [],
      media: null,
      model: 'deepseek-v4-flash',
    }),
    actionRepairImpl: async () => {
      repairCalls += 1;
      return { ok: true };
    },
    ingestImpl: async () => ({ ok: true }),
  });

  assert.equal(repairCalls, 0);
  assert.equal(response.replyText, '收到这个表情包请求。');
});

test('channel hub creates pending sticker save and executes confirmation through adapter', async () => {
  const env = {
    ...tempEnv(),
    HERMES_ACTION_GATE_ENABLED: 'true',
    HERMES_ACTION_GATE_MODE: 'repair',
    HERMES_ACTION_PENDING_ENABLED: 'true',
    HERMES_ACTION_PENDING_TTL_MINUTES: '30',
  };
  let sent = null;
  const first = await handleIncomingMessage({
    id: 'wx-pending-sticker',
    platform: 'wechat',
    channel_type: 'dm',
    conversation_id: 'wx-pending-sticker-conv',
    sender_id: 'wx-user',
    text: '这个可以当表情包',
    media: [{ filePath: '/tmp/private.png', mimeType: 'image/png', type: 'image' }],
    created_at: 1000,
  }, {
    env,
    logger: { log() {}, warn() {}, error() {}, info() {} },
    chatImpl: async () => ({ reply_text: 'should not call hermes', follow_up_messages: [], media: null }),
    ingestImpl: async () => ({ ok: true }),
    adapter: {
      async sendReply(payload) {
        sent = payload;
      },
    },
  });

  assert.match(first.replyText, /确认保存/);
  assert.equal(sent.text, first.replyText);
  assert.equal(listPendingActions({ env }).length, 1);

  const executions = [];
  const confirmed = await handleIncomingMessage({
    id: 'wx-confirm-sticker',
    platform: 'wechat',
    channel_type: 'dm',
    conversation_id: 'wx-pending-sticker-conv',
    sender_id: 'wx-user',
    text: '确认保存',
    created_at: 1001,
  }, {
    env,
    logger: { log() {}, warn() {}, error() {}, info() {} },
    pendingActionExecutorImpl: async (action) => {
      executions.push(action);
      return { ok: true, replyText: '已保存到表情包库。' };
    },
    ingestImpl: async () => ({ ok: true }),
    adapter: {
      async sendReply(payload) {
        sent = payload;
      },
    },
  });

  assert.equal(executions.length, 1);
  assert.equal(confirmed.replyText, '已保存到表情包库。');
  assert.equal(sent.text, '已保存到表情包库。');
  assert.equal(listPendingActions({ env })[0].status, 'executed');
});

test('channel hub confirmation only affects same conversation pending action', async () => {
  const env = {
    ...tempEnv(),
    HERMES_ACTION_GATE_ENABLED: 'true',
    HERMES_ACTION_GATE_MODE: 'repair',
    HERMES_ACTION_PENDING_ENABLED: 'true',
  };
  createPendingAction({
    requestId: 'req-other-conv',
    channel: 'wechat',
    conversationId: 'other-conversation',
    actionType: 'external_send',
    summary: '发送',
  }, { env });
  let executed = false;

  const response = await handleIncomingMessage({
    id: 'wx-confirm-wrong-conv',
    platform: 'wechat',
    channel_type: 'dm',
    conversation_id: 'current-conversation',
    sender_id: 'wx-user',
    text: '确认',
    created_at: 1000,
  }, {
    env,
    logger: { log() {}, warn() {}, error() {}, info() {} },
    pendingActionExecutorImpl: async () => {
      executed = true;
      return { ok: true };
    },
    ingestImpl: async () => ({ ok: true }),
  });

  assert.equal(executed, false);
  assert.match(response.replyText, /过期|已经处理/);
  assert.equal(listPendingActions({ env })[0].status, 'pending');
});
