// node_bridge/src/openclawContextPolicy.mjs
// OpenClaw 上下文策略：Artifact 压缩、媒体选择、Persona 契约
// 最小实现 — 零外部依赖

// ─── 类型说明 ───
// Artifact = {
//   id: string,
//   type: 'image'|'video'|'audio'|'text',
//   title?: string,
//   description?: string,
//   source?: string,
//   stats?: { likes?, favorites?, comments? },
//   priority?: 'explicit_ref'|'current_media'|'recent_candidate'|'history',
//   consumed?: boolean,
//   currentRef?: boolean,   // 当前消息引用标记
//   url?: string,
//   timestamp?: number|Date,
// }

// ─── 常量 ───
const MAX_RENDER_LEN = 180;

const PRIORITY_ORDER = {
  explicit_ref: 0,
  current_media: 1,
  recent_candidate: 2,
  history: 3,
};

// ─── renderCompactArtifact ───
/**
 * 将单个 artifact 渲染为 ≤180 字符的紧凑文本。
 *
 * 格式："img_xxx：标题摘要；描述；来源 xxx；N 赞/N 藏/N 评。"
 *
 * @param {object} artifact
 * @returns {string} 不超过 180 字符的文本
 */
export function renderCompactArtifact(artifact) {
  if (!artifact) return '';

  const idLabel = shortId(artifact);

  const segments = [];

  // 标题或描述摘要
  const headline = artifact.title || artifact.description || '';
  if (headline) segments.push(truncate(headline, 40));

  // 描述（如果和标题不同）
  if (artifact.description && artifact.description !== artifact.title) {
    segments.push(truncate(artifact.description, 60));
  }

  // 来源
  if (artifact.source) {
    segments.push(`来源${truncate(artifact.source, 20)}`);
  }

  // 统计
  const stats = formatStats(artifact.stats);
  if (stats) segments.push(stats);

  const body = segments.join('；');
  const full = `${idLabel}：${body}。`;

  // 硬截断到 180 字符
  return truncate(full, MAX_RENDER_LEN);
}

// ─── selectMediaArtifactsForPrompt ───
/**
 * 从候选 artifacts 中选出 ≤ max 个用于 prompt 注入。
 *
 * 选择策略:
 *   1. 过滤掉 consumed=true 且非当前引用的旧媒体
 *   2. 按 priority 显式排序
 *   3. 仅保留媒体类型 (image/video/audio)
 *   4. 取前 max 个
 *
 * @param {object[]} artifacts
 * @param {number} [max=3]
 * @returns {object[]}
 */
export function selectMediaArtifactsForPrompt(artifacts, max = 3) {
  if (!Array.isArray(artifacts) || artifacts.length === 0) return [];

  const MEDIA_TYPES = new Set(['image', 'video', 'audio']);

  return artifacts
    .filter((a) => {
      // 必须是媒体类型
      if (!MEDIA_TYPES.has(a.type)) return false;
      // consumed=true 且不带当前引用 → 跳过
      if (a.consumed && !a.currentRef) return false;
      return true;
    })
    .sort((a, b) => {
      const pa = PRIORITY_ORDER[a.priority] ?? 99;
      const pb = PRIORITY_ORDER[b.priority] ?? 99;
      if (pa !== pb) return pa - pb;
      // 同优先级按时间倒序（新的优先）
      const ta = toTimestamp(a.timestamp);
      const tb = toTimestamp(b.timestamp);
      return tb - ta;
    })
    .slice(0, max);
}

// ─── buildCompactMediaContext ───
/**
 * 将选中的 artifacts 列表构建为一段紧凑的媒体上下文文本，
 * 可直接拼接到 system/user prompt。
 *
 * @param {object[]} artifacts  （通常由 selectMediaArtifactsForPrompt 返回）
 * @returns {string}
 */
export function buildCompactMediaContext(artifacts) {
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    return '[媒体上下文：无可用媒体]';
  }

  const lines = artifacts.map((a, i) => {
    const compact = renderCompactArtifact(a);
    return `  ${i + 1}. ${compact}`;
  });

  return [
    '[当前媒体上下文]',
    ...lines,
    '[请基于以上媒体内容与用户对话]',
  ].join('\n');
}

// ─── buildContextSizeLog ───
/**
 * 统计各部分字节/字符数，返回日志对象，用于 debug 和上下文溢出检测。
 *
 * @param {{label: string, text: string}[]} parts
 * @returns {{totalChars: number, totalBytes: number, parts: object[], overflow: boolean}}
 */
export function buildContextSizeLog(parts) {
  if (!Array.isArray(parts)) {
    return { totalChars: 0, totalBytes: 0, parts: [], overflow: false };
  }

  const detailed = parts.map(({ label, text }) => {
    const chars = (text || '').length;
    const bytes = utf8ByteLength(text || '');
    return { label, chars, bytes };
  });

  const totalChars = detailed.reduce((s, p) => s + p.chars, 0);
  const totalBytes = detailed.reduce((s, p) => s + p.bytes, 0);

  return {
    totalChars,
    totalBytes,
    parts: detailed,
    // 200k tokens ≈ ~600k bytes (粗略)，保守阈值 500KB
    overflow: totalBytes > 500 * 1024,
  };
}

// ─── buildPersonaContract ───
/**
 * 返回轻量 persona 提示词片段，作为 system message 的一部分注入。
 * 保持短小精悍，便于上层覆盖。
 *
 * @returns {string}
 */
export function buildPersonaContract() {
  return [
    '## Persona Contract',
    '你是 OpenClaw 智能助手。',
    '- 回复简洁，优先引用媒体内容中的具体细节。',
    '- 若上下文包含媒体 artifact，主动结合其标题、描述、数据做出分析。',
    '- 保持友好、务实、不过度承诺。',
    '- 若信息不足，明确说明需要补充什么。',
  ].join('\n');
}

// ═══════════════════════════════════
// 内部工具函数
// ═══════════════════════════════════

/**
 * 生成短 ID 标签，如 "img_a3f2" / "vid_9c01"
 */
function shortId(artifact) {
  const prefix = { image: 'img', video: 'vid', audio: 'aud', text: 'txt' };
  const p = prefix[artifact.type] || 'art';
  const id = String(artifact.id || 'unknown');
  // 取 id 后 4 位 hex-like
  const tail = id.length > 4 ? id.slice(-4) : id;
  return `${p}_${tail}`;
}

/**
 * 截断到 maxLen 字符，超出加 "…"
 */
function truncate(str, maxLen) {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '…';
}

/**
 * 格式化统计数据
 */
function formatStats(stats) {
  if (!stats || typeof stats !== 'object') return '';
  const parts = [];
  if (stats.likes != null) parts.push(`${stats.likes}赞`);
  if (stats.favorites != null) parts.push(`${stats.favorites}藏`);
  if (stats.comments != null) parts.push(`${stats.comments}评`);
  return parts.length > 0 ? parts.join('/') : '';
}

/**
 * 安全提取时间戳数值
 */
function toTimestamp(ts) {
  if (!ts) return 0;
  if (ts instanceof Date) return ts.getTime();
  return Number(ts) || 0;
}

/**
 * 计算 UTF-8 字节长度（兼容含中文场景）
 */
function utf8ByteLength(str) {
  // TextEncoder 在 Node 12+ 可用
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(str).byteLength;
  }
  // fallback: 粗略计算
  let bytes = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else bytes += 3;
  }
  return bytes;
}

// ─── 默认导出（方便批量引用） ───
export default {
  renderCompactArtifact,
  selectMediaArtifactsForPrompt,
  buildCompactMediaContext,
  buildContextSizeLog,
  buildPersonaContract,
};
