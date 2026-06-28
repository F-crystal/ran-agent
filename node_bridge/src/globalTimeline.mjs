import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { shortHash } from './identityMap.mjs';

const DEFAULT_TIMELINE_PATH = '/opt/ran_agent/.ran_agent_state/global-timeline.jsonl';
const DEFAULT_ARCHIVE_DIR = '/opt/ran_agent/.ran_agent_state/timeline_archive';
const DEFAULT_MAX_TEXT_CHARS = 2000;
const DEFAULT_CONTINUITY_FRESHNESS_HOURS = 24;

export function getGlobalTimelineConfig(env = process.env) {
  return {
    timelinePath: String(env.RAN_AGENT_GLOBAL_TIMELINE_PATH || DEFAULT_TIMELINE_PATH).trim() || DEFAULT_TIMELINE_PATH,
    archiveDir: String(env.RAN_AGENT_TIMELINE_ARCHIVE_DIR || DEFAULT_ARCHIVE_DIR).trim() || DEFAULT_ARCHIVE_DIR,
    maxBytes: Math.max(1, parseIntegerEnv(env.RAN_AGENT_TIMELINE_MAX_BYTES, 52428800)),
    maxTurns: Math.max(1, parseIntegerEnv(env.RAN_AGENT_TIMELINE_MAX_TURNS, 5000)),
    retentionDays: Math.max(0, parseIntegerEnv(env.RAN_AGENT_TIMELINE_RETENTION_DAYS, 30)),
    compactEnabled: String(env.RAN_AGENT_TIMELINE_COMPACT_ENABLED || 'true').trim().toLowerCase() !== 'false',
    globalRecentTurns: Math.max(0, Number.parseInt(String(env.HERMES_GLOBAL_RECENT_TURNS || '6'), 10) || 6),
    globalRecentCharBudget: Math.max(0, Number.parseInt(String(env.HERMES_GLOBAL_RECENT_CHAR_BUDGET || '2500'), 10) || 2500),
    activeTopicCharBudget: Math.max(0, Number.parseInt(String(env.HERMES_ACTIVE_TOPIC_CHAR_BUDGET || '1200'), 10) || 1200),
    continuityFreshnessHours: Math.max(0, parseIntegerEnv(env.HERMES_CONTINUITY_FRESHNESS_HOURS, DEFAULT_CONTINUITY_FRESHNESS_HOURS)),
  };
}

function parseIntegerEnv(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function appendTurn(turn = {}) {
  const config = getGlobalTimelineConfig(turn.env);
  const timelinePath = turn.timelinePath || config.timelinePath;
  const preparedText = prepareTimelineText(turn.text || turn.text_summary || '');
  const text = preparedText.text;
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
  if (!record.text_summary && preparedText.text_summary) record.text_summary = preparedText.text_summary;
  if (turn.media_summary) record.media_summary = sanitizeTimelineText(turn.media_summary, 800);
  if (turn.source_message_id) record.source_message_id = String(turn.source_message_id);
  const tags = normalizeTags(turn.tags, text);
  if (tags.length > 0) record.tags = tags;

  fs.mkdirSync(path.dirname(timelinePath), { recursive: true });
  fs.appendFileSync(timelinePath, `${JSON.stringify(record)}\n`, 'utf8');
  if (config.compactEnabled) {
    try {
      const archiveDir = turn.archiveDir || (turn.timelinePath ? path.join(path.dirname(timelinePath), 'timeline_archive') : config.archiveDir);
      compactTimeline({
        timelinePath,
        archiveDir,
        maxBytes: config.maxBytes,
        maxTurns: config.maxTurns,
        retentionDays: config.retentionDays,
      });
    } catch {
      // Timeline compaction must never break the live reply path.
    }
  }
  return record;
}

export function compactTimeline({
  timelinePath = getGlobalTimelineConfig().timelinePath,
  archiveDir = getGlobalTimelineConfig().archiveDir,
  maxBytes = getGlobalTimelineConfig().maxBytes,
  maxTurns = getGlobalTimelineConfig().maxTurns,
  retentionDays = getGlobalTimelineConfig().retentionDays,
  retainRecentTurns,
  now = Date.now(),
} = {}) {
  if (!fs.existsSync(timelinePath)) {
    return { compacted: false, reason: 'missing_timeline' };
  }
  const stat = fs.statSync(timelinePath);
  const records = readTimelineRecords({ timelinePath, limit: Number.MAX_SAFE_INTEGER });
  const cutoff = retentionDays > 0 ? now - retentionDays * 24 * 60 * 60 * 1000 : 0;
  const hasExpiredRecords = cutoff > 0 && records.some((record) => Number(record.created_at || 0) < cutoff);
  const shouldCompact = stat.size > Number(maxBytes) || records.length > Number(maxTurns) || hasExpiredRecords;
  if (!shouldCompact) {
    return { compacted: false, bytes: stat.size, turns: records.length };
  }

  const keepCount = Math.max(
    1,
    Number.isFinite(Number(retainRecentTurns))
      ? Number(retainRecentTurns)
      : Math.min(records.length, Math.max(100, Math.floor(Number(maxTurns || 5000) * 0.6)))
  );
  const recentRecords = records.slice(-keepCount);
  const recentIds = new Set(recentRecords.map((record) => record.id));
  const oldRecords = records.filter((record) => !recentIds.has(record.id));
  const summaryRecords = buildCompactSummaryRecords(oldRecords, now);

  fs.mkdirSync(archiveDir, { recursive: true });
  const archivePath = path.join(archiveDir, `global-timeline-${new Date(now).toISOString().replace(/[:.]/g, '-')}.jsonl.gz`);
  fs.writeFileSync(archivePath, gzipSync(fs.readFileSync(timelinePath)));

  const rewritten = [...summaryRecords, ...recentRecords]
    .map((record) => JSON.stringify(record))
    .join('\n');
  fs.writeFileSync(timelinePath, rewritten ? `${rewritten}\n` : '', 'utf8');

  const metaPath = path.join(archiveDir, 'last_compact.json');
  fs.writeFileSync(metaPath, JSON.stringify({
    compacted_at: new Date(now).toISOString(),
    archive_path: archivePath,
    original_turns: records.length,
    summary_turns: summaryRecords.length,
    retained_turns: recentRecords.length,
    original_bytes: stat.size,
  }, null, 2), 'utf8');

  return {
    compacted: true,
    archive_path: archivePath,
    original_turns: records.length,
    summary_turns: summaryRecords.length,
    retained_turns: recentRecords.length,
  };
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
  now,
  maxAgeHours,
} = {}) {
  const conversationHash = shortHash(conversation_id || '');
  const records = readTimelineRecords({ timelinePath })
    .filter((record) => record.global_user_id === global_user_id)
    .filter((record) => !platform || record.platform === platform)
    .filter((record) => !conversation_id || record.conversation_id_hash === conversationHash)
    .filter((record) => isRecordFresh(record, { now, freshnessHours: maxAgeHours }));
  return recordsToMessages(records, limit, charBudget);
}

export function getGlobalRecentHistory({
  timelinePath = getGlobalTimelineConfig().timelinePath,
  global_user_id = 'user:ran',
  limit = 6,
  charBudget = 2500,
  now,
  maxAgeHours,
} = {}) {
  const records = readTimelineRecords({ timelinePath })
    .filter((record) => record.global_user_id === global_user_id)
    .filter((record) => isRecordFresh(record, { now, freshnessHours: maxAgeHours }));
  return recordsToMessages(records, limit, charBudget);
}

export function getActiveTopic({
  timelinePath = getGlobalTimelineConfig().timelinePath,
  global_user_id = 'user:ran',
  charBudget = 1200,
  now,
  freshnessHours,
} = {}) {
  return getActiveTopicContext({
    timelinePath,
    global_user_id,
    charBudget,
    now,
    freshnessHours,
  }).activeTopic;
}

export function getActiveTopicContext({
  timelinePath = getGlobalTimelineConfig().timelinePath,
  global_user_id = 'user:ran',
  charBudget = 1200,
  staleCharBudget = charBudget,
  now,
  freshnessHours,
} = {}) {
  const records = readTimelineRecords({ timelinePath, limit: 80 })
    .filter((record) => record.global_user_id === global_user_id)
    .filter((record) => record.role === 'user' || record.compacted === true || record.platform === 'summary')
    .slice(-12);
  const { freshRecords, staleRecords } = splitRecordsByFreshness(records, { now, freshnessHours });
  return {
    activeTopic: clipText(recordsTopicText(freshRecords), charBudget),
    staleContext: clipText(recordsTopicText(staleRecords), staleCharBudget),
  };
}

export function buildContinuityNote({
  message = {},
  localRecent = [],
  globalRecent = [],
  activeTopic = '',
  staleContext = '',
} = {}) {
  const text = String(message.text || '').trim();
  const isReferential = /她|他|它|这篇|这个故事|刚才那个|那张图|上面那篇|那个链接|这件事|图片呢|没看到图|上次|之前|以前|前面|前几天|周五|昨天|那个/.test(text);
  const topic = inferTopic([...localRecent, ...globalRecent], activeTopic);
  const stale = clipText(String(staleContext || '').trim(), 240);
  if (!topic && isReferential && stale) {
    return [
      '【conversation continuity note（非用户原话，不要复述）】',
      `stale_context: ${stale}`,
      'do_not_assume_current: true',
      'reply_style: 如需承接，写成“上次你提到……”；不要假设旧状态仍然成立',
      'do_not_repeat: 不要解释内部连续性实现',
    ].join('\n');
  }
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

function recordsTopicText(records = []) {
  return records
    .map((record) => record.text_summary || record.media_summary || record.text || '')
    .filter(Boolean)
    .join(' / ');
}

function splitRecordsByFreshness(records = [], { now, freshnessHours } = {}) {
  if (!shouldApplyFreshnessGate({ now, freshnessHours })) {
    return { freshRecords: records, staleRecords: [] };
  }
  const cutoff = Number(now) - Number(freshnessHours) * 60 * 60 * 1000;
  const freshRecords = [];
  const staleRecords = [];
  for (const record of records) {
    const createdAt = Number(record.created_at || 0);
    if (Number.isFinite(createdAt) && createdAt > 0 && createdAt < cutoff) {
      staleRecords.push(record);
    } else {
      freshRecords.push(record);
    }
  }
  return { freshRecords, staleRecords };
}

function isRecordFresh(record = {}, { now, freshnessHours } = {}) {
  if (!shouldApplyFreshnessGate({ now, freshnessHours })) return true;
  const createdAt = Number(record.created_at || 0);
  return !Number.isFinite(createdAt) || createdAt <= 0 || createdAt >= Number(now) - Number(freshnessHours) * 60 * 60 * 1000;
}

function shouldApplyFreshnessGate({ now, freshnessHours } = {}) {
  const current = Number(now);
  const hours = Number(freshnessHours);
  return Number.isFinite(current) && current > 0 && Number.isFinite(hours) && hours > 0;
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

function prepareTimelineText(value) {
  const raw = String(value || '').trim();
  if (!raw) return { text: '', text_summary: '' };
  const systemicSummary = summarizeSystemicText(raw);
  if (systemicSummary) {
    return { text: systemicSummary, text_summary: systemicSummary };
  }
  const text = sanitizeTimelineText(raw, DEFAULT_MAX_TEXT_CHARS);
  const wasTruncated = text.length < raw.length || /长 JSON|base64|代码块/.test(text);
  return {
    text,
    text_summary: wasTruncated ? sanitizeTimelineText(raw, 800) : '',
  };
}

function summarizeSystemicText(raw) {
  if (!raw) return '';
  if (/data:[a-z0-9/+.-]+;base64,/i.test(raw)) {
    return '[媒体 base64 payload 已省略]';
  }
  if (/\bjournalctl\b|^\s*at\s+\S+\s+\(.+:\d+:\d+\)/im.test(raw) || /(?:Error|Exception|Traceback):/i.test(raw)) {
    const first = raw.split('\n').map((line) => line.trim()).find(Boolean) || '日志或错误堆栈';
    return `日志或错误堆栈摘要: ${sanitizeTimelineText(first, 240)}`;
  }
  if (/\{[\s\S]{2000,}\}/.test(raw)) {
    return '[长 JSON payload 已省略]';
  }
  return '';
}

function buildCompactSummaryRecords(records = [], now = Date.now()) {
  const groups = new Map();
  for (const record of records) {
    const day = new Date(Number(record.created_at || now)).toISOString().slice(0, 10);
    const globalUserId = record.global_user_id || 'user:ran';
    const key = `${globalUserId}:${day}`;
    const group = groups.get(key) || {
      day,
      globalUserId,
      records: [],
      platforms: new Set(),
      tags: new Set(),
    };
    group.records.push(record);
    if (record.platform) group.platforms.add(record.platform);
    for (const tag of Array.isArray(record.tags) ? record.tags : []) group.tags.add(tag);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const text = group.records
      .map((record) => record.text_summary || record.media_summary || record.text || '')
      .filter(Boolean)
      .join(' / ');
    const summary = `timeline daily/topic summary ${group.day}: ${sanitizeTimelineText(text, 1200)}`;
    return {
      id: `summary-${group.globalUserId}-${group.day}-${shortHash(summary)}`,
      global_user_id: group.globalUserId,
      platform: 'summary',
      channel_type: 'summary',
      conversation_id_hash: shortHash(`summary:${group.globalUserId}:${group.day}`),
      sender_id_hash: shortHash('timeline-compactor'),
      role: 'assistant',
      text: summary,
      text_summary: sanitizeTimelineText(summary, 800),
      created_at: Number(group.records.at(-1)?.created_at || now),
      tags: [...group.tags, ...group.platforms].filter(Boolean).slice(0, 12),
      compacted: true,
      compacted_turns: group.records.length,
    };
  });
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
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function normalizePlatform(platform) {
  const value = String(platform || '').trim().toLowerCase();
  return ['wechat', 'feishu', 'desktop'].includes(value) ? value : 'wechat';
}
