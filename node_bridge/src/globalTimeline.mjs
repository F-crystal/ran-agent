import fs from 'node:fs';
import path from 'node:path';
import { shortHash } from './identityMap.mjs';

const DEFAULT_TIMELINE_PATH = '/opt/ran_agent/.ran_agent_state/global-timeline.jsonl';

export function getGlobalTimelineConfig(env = process.env) {
  return {
    timelinePath: String(env.RAN_AGENT_GLOBAL_TIMELINE_PATH || DEFAULT_TIMELINE_PATH).trim() || DEFAULT_TIMELINE_PATH,
    globalRecentTurns: Math.max(0, Number.parseInt(String(env.HERMES_GLOBAL_RECENT_TURNS || '6'), 10) || 6),
    globalRecentCharBudget: Math.max(0, Number.parseInt(String(env.HERMES_GLOBAL_RECENT_CHAR_BUDGET || '2500'), 10) || 2500),
    activeTopicCharBudget: Math.max(0, Number.parseInt(String(env.HERMES_ACTIVE_TOPIC_CHAR_BUDGET || '1200'), 10) || 1200),
  };
}

export function appendTurn(turn = {}) {
  const timelinePath = turn.timelinePath || getGlobalTimelineConfig(turn.env).timelinePath;
  const text = sanitizeTimelineText(turn.text || turn.text_summary || '');
  const record = {
    id: String(turn.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
    global_user_id: String(turn.global_user_id || 'user:ran'),
    platform: normalizePlatform(turn.platform),
    channel_type: String(turn.channel_type || 'dm'),
    conversation_id_hash: turn.conversation_id_hash || shortHash(turn.conversation_id || ''),
    sender_id_hash: turn.sender_id_hash || shortHash(turn.sender_id || ''),
    role: turn.role === 'assistant' ? 'assistant' : 'user',
    text,
    created_at: Number(turn.created_at || Date.now()),
  };
  if (turn.text_summary) record.text_summary = sanitizeTimelineText(turn.text_summary, 800);
  if (turn.media_summary) record.media_summary = sanitizeTimelineText(turn.media_summary, 800);
  if (turn.source_message_id) record.source_message_id = String(turn.source_message_id);
  const tags = normalizeTags(turn.tags, text);
  if (tags.length > 0) record.tags = tags;

  fs.mkdirSync(path.dirname(timelinePath), { recursive: true });
  fs.appendFileSync(timelinePath, `${JSON.stringify(record)}\n`, 'utf8');
  return record;
}

export function readTimelineRecords({ timelinePath = getGlobalTimelineConfig().timelinePath, limit = 1000 } = {}) {
  if (!fs.existsSync(timelinePath)) return [];
  const lines = fs.readFileSync(timelinePath, 'utf8').split('\n').filter(Boolean);
  return lines.slice(-Math.max(1, Number(limit) || 1000)).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

export function getLocalRecentHistory({
  timelinePath = getGlobalTimelineConfig().timelinePath,
  platform,
  conversation_id,
  global_user_id = 'user:ran',
  limit = 10,
  charBudget = 6000,
} = {}) {
  const conversationHash = shortHash(conversation_id || '');
  const records = readTimelineRecords({ timelinePath })
    .filter((record) => record.global_user_id === global_user_id)
    .filter((record) => !platform || record.platform === platform)
    .filter((record) => !conversation_id || record.conversation_id_hash === conversationHash);
  return recordsToMessages(records, limit, charBudget);
}

export function getGlobalRecentHistory({
  timelinePath = getGlobalTimelineConfig().timelinePath,
  global_user_id = 'user:ran',
  limit = 6,
  charBudget = 2500,
} = {}) {
  const records = readTimelineRecords({ timelinePath })
    .filter((record) => record.global_user_id === global_user_id);
  return recordsToMessages(records, limit, charBudget);
}

export function getActiveTopic({
  timelinePath = getGlobalTimelineConfig().timelinePath,
  global_user_id = 'user:ran',
  charBudget = 1200,
} = {}) {
  const records = readTimelineRecords({ timelinePath, limit: 80 })
    .filter((record) => record.global_user_id === global_user_id)
    .slice(-12);
  const text = records
    .map((record) => record.text_summary || record.media_summary || record.text || '')
    .filter(Boolean)
    .join(' / ');
  return clipText(text, charBudget);
}

export function buildContinuityNote({
  message = {},
  localRecent = [],
  globalRecent = [],
  activeTopic = '',
} = {}) {
  const text = String(message.text || '').trim();
  const isReferential = /她|他|它|这篇|这个故事|刚才那个|那张图|上面那篇|那个链接|这件事|图片呢|没看到图/.test(text);
  const topic = inferTopic([...localRecent, ...globalRecent], activeTopic);
  if (!isReferential && !topic) return '';
  return [
    '【conversation continuity note（非用户原话，不要复述）】',
    `current_topic: ${topic || 'recent cross-platform conversation'}`,
    `local_recent_turns: ${Math.floor(localRecent.length / 2)}`,
    `global_recent_turns: ${Math.floor(globalRecent.length / 2)}`,
    'relationship_tone: 贴身女官，亲近但不过度仪式化',
    'open_loop: 优先用本会话最近内容解析指代；不足时参考 global active topic',
    'do_not_repeat: 不要问“是谁/哪篇”；不要解释内部连续性实现',
  ].join('\n');
}

function recordsToMessages(records, limit, charBudget) {
  const selected = [];
  let used = 0;
  const max = Math.max(0, Number(limit) || 0);
  const budget = Math.max(0, Number(charBudget) || 0);
  for (const record of records.slice(-max).reverse()) {
    const content = sanitizeTimelineText(record.text_summary || record.media_summary || record.text || '', 1200);
    if (!content) continue;
    const role = record.role === 'assistant' ? 'assistant' : 'user';
    if (used + content.length > budget && selected.length > 0) continue;
    const clipped = used + content.length > budget ? clipText(content, Math.max(1, budget - used)) : content;
    selected.unshift({ role, content: clipped });
    used += clipped.length;
  }
  return selected;
}

export function sanitizeTimelineText(value, maxChars = 1200) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  let text = raw
    .replace(/data:[a-z0-9/+.-]+;base64,[a-z0-9+/=\s]+/ig, '[媒体 base64 已省略]')
    .replace(/```[\s\S]*?```/g, '[代码块已省略]')
    .replace(/\{[\s\S]{1200,}\}/g, '[长 JSON 已省略]')
    .replace(/\b(token|cookie|authorization|xsec_token|api_key)=([^\s&]+)/ig, '$1=[redacted]')
    .replace(/\s+/g, ' ')
    .trim();
  return clipText(text, maxChars);
}

function normalizeTags(tags, text) {
  const output = Array.isArray(tags) ? tags.map((tag) => String(tag || '').trim()).filter(Boolean) : [];
  if (/xhslink\.com|xiaohongshu\.com|xhs\.com/i.test(text)) output.push('xhs');
  if (/图片|视频|音频|media/i.test(text)) output.push('media');
  return [...new Set(output)].slice(0, 8);
}

function inferTopic(messages, activeTopic) {
  const text = [activeTopic, ...messages.map((message) => message.content || '')].join('\n');
  const patterns = [
    /内莉[·・]?布莱|Nellie Bly/ig,
    /强女故事03[^。！？\n]*/i,
    /她把自己送进了疯人院[^。！？\n]*/i,
    /https?:\/\/(?:xhslink\.com|[^/\s]*xiaohongshu\.com)\/[^\s]+/i,
  ];
  const hits = [];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[0]) hits.push(match[0]);
  }
  return hits.length > 0 ? clipText([...new Set(hits)].join(' / '), 180) : clipText(activeTopic, 180);
}

function clipText(value, maxChars) {
  const text = String(value || '');
  const limit = Math.max(1, Number(maxChars) || 1);
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

function normalizePlatform(platform) {
  const value = String(platform || '').trim().toLowerCase();
  return ['wechat', 'feishu', 'desktop'].includes(value) ? value : 'wechat';
}
