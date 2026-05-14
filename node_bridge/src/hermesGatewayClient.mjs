/**
 * Hermes API/CLI adapter for the WeChat reply backend.
 *
 * This module only calls Hermes. It does not implement an agent runtime,
 * DeepSeek gateway, or tool loop.
 */

import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { ensureConversationMediaContext } from './mediaContextStore.mjs';
import {
  getContextPolicyConfig,
  buildCompactMediaContext,
  selectMediaArtifactsForPrompt,
  buildContextSizeLog,
} from './contextPolicy.mjs';
import { resolveProjectRoot } from './trustedMediaPaths.mjs';

const execFile = promisify(execFileCallback);

export function getHermesGatewayConfig(env = process.env) {
  const baseUrl = String(env.HERMES_API_BASE_URL || 'http://127.0.0.1:8642/v1').trim().replace(/\/$/, '');
  const token = String(env.HERMES_API_KEY || env.API_SERVER_KEY || '').trim();
  const model = String(env.HERMES_DEFAULT_MODEL || env.HERMES_INFERENCE_MODEL || 'deepseek-v4-flash').trim();
  const provider = String(env.HERMES_PROVIDER || env.HERMES_INFERENCE_PROVIDER || 'deepseek').trim();
  const profile = String(env.HERMES_PROFILE || 'ran-assistant').trim();
  const mode = normalizeMode(env.HERMES_REPLY_MODE || env.HERMES_GATEWAY_CLIENT_MODE || 'api');
  const command = String(env.HERMES_COMMAND || 'hermes').trim() || 'hermes';
  const timeoutSeconds = Math.max(30, Number.parseInt(String(env.HERMES_REPLY_TIMEOUT_SECONDS || '180'), 10) || 180);
  const projectRoot = resolveProjectRoot(env);
  const {
    contextPolicyMode,
    maxMediaArtifacts,
    enableContextSizeLog,
  } = getContextPolicyConfig(env);

  return {
    baseUrl,
    token,
    model,
    provider,
    profile,
    mode,
    command,
    timeoutSeconds,
    projectRoot,
    contextPolicyMode,
    maxMediaArtifacts,
    enableContextSizeLog,
    fallbackText: env.NODE_BRIDGE_FALLBACK_TEXT || '暂时无法连接到 Hermes，请稍后再试。',
  };
}

export async function sendChatToHermesGateway(payload, options = {}) {
  const env = options.env || process.env;
  const config = options.config || getHermesGatewayConfig(env);
  const logger = options.logger || console;
  const preparedMessage = await buildHermesUserMessage(payload, {
    env,
    config,
    logger,
    mediaContextOptions: options.mediaContextOptions,
  });

  if (config.mode === 'oneshot') {
    return sendChatToHermesOneShot(preparedMessage, {
      config,
      execFileImpl: options.execFileImpl,
    });
  }

  try {
    return await sendChatToHermesApi(preparedMessage, {
      config,
      fetchImpl: options.fetchImpl,
    });
  } catch (error) {
    if (config.mode !== 'auto') {
      throw error;
    }
    logger.warn?.(`hermes api request failed, retrying with one-shot: ${formatErrorMessage(error)}`);
    return sendChatToHermesOneShot(preparedMessage, {
      config,
      execFileImpl: options.execFileImpl,
    });
  }
}

async function sendChatToHermesApi(message, options = {}) {
  const config = options.config || getHermesGatewayConfig();
  const fetchImpl = options.fetchImpl || fetch;
  const endpoint = `${config.baseUrl}/chat/completions`;
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: buildHermesHeaders(config),
    body: JSON.stringify({
      model: config.profile || 'ran-assistant',
      messages: [
        {
          role: 'system',
          content: buildHermesSystemInstruction(),
        },
        {
          role: 'user',
          content: message,
        },
      ],
      stream: false,
    }),
  });

  if (!response?.ok) {
    const status = response?.status || 'unknown';
    const text = typeof response?.text === 'function' ? await response.text().catch(() => '') : '';
    throw new Error(`hermes api request failed: HTTP ${status}${text ? ` ${text.slice(0, 300)}` : ''}`);
  }

  const body = await parseHermesJson(response);
  return buildHermesReply(body, config);
}

async function sendChatToHermesOneShot(message, options = {}) {
  const config = options.config || getHermesGatewayConfig();
  const execFileImpl = options.execFileImpl || execFile;
  const args = [
    '-p',
    config.profile,
    '--provider',
    config.provider,
    '--model',
    config.model,
    '-z',
    message,
  ];
  const { stdout } = await execFileImpl(config.command, args, {
    cwd: config.projectRoot,
    timeout: config.timeoutSeconds * 1000,
  });
  return buildHermesReply({
    reply_text: String(stdout || '').trim(),
    model: config.model,
  }, config);
}

async function buildHermesUserMessage(payload = {}, options = {}) {
  const config = options.config || getHermesGatewayConfig(options.env);
  const mediaContext = await ensureConversationMediaContext(payload, {
    env: options.env,
    logger: options.logger,
    ...(options.mediaContextOptions || {}),
  });
  const mediaContextText = buildHermesMediaContextText(mediaContext, config);
  const hasMedia = normalizeMediaItems(payload.media).length > 0
    || (Array.isArray(payload.image_urls) && payload.image_urls.some((u) => typeof u === 'string' && u.trim()))
    || (Array.isArray(mediaContext.artifacts) && mediaContext.artifacts.length > 0);
  const courtlyAnchor = buildCourtlyStyleAnchor(payload);
  const socialRoutingHint = buildSocialLinkRoutingHint(payload);
  const message = [
    buildBridgeTemporalUserContext(payload),
    courtlyAnchor,
    socialRoutingHint,
    hasMedia ? buildHermesMediaGenerationInstruction() : '',
    buildHermesInboundMediaInstruction(payload),
    mediaContextText,
    buildHermesUserText(payload),
  ].filter(Boolean).join('\n\n');

  if (config.enableContextSizeLog) {
    const sizeLog = buildContextSizeLog([
      { label: 'system_prompt_chars', text: buildHermesSystemInstruction() },
      { label: 'media_context_chars', text: mediaContextText },
      { label: 'final_prompt_chars', text: message },
    ]);
    options.logger?.log?.('[hermes-context-size]', JSON.stringify({
      ...sizeLog,
      media_artifact_count: Array.isArray(mediaContext.artifacts) ? mediaContext.artifacts.length : 0,
      request_id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      context_policy_mode: config.contextPolicyMode,
    }));
  }

  return message;
}

function buildHermesSystemInstruction() {
  return 'You are Hermes, ran-agent personal assistant. Use profile tools and memory. Text-only; use MCP for media. Never expose internals. MANDATORY RULES: (1) Social platform links (XHS/Bilibili/WeChat article/music/Douyin/Kuaishou/Weibo/Zhihu) -> MUST use social_reader MCP, NEVER use web_extract for these. (2) Images/video/audio -> MUST use media_reader or mimo_power, NEVER feed raw image_url to DeepSeek. (3) Image/speech generation -> MUST use media_generation. (4) Old media queries ("那张图/之前的截图/几天前的海报") -> MUST use search_media_artifacts first. (5) Normal web pages (news/blogs/docs) -> web_extract and web_search are allowed.';
}

const COURTLY_DISABLE_PATTERN = /正常说话|别叫陛下|别演|不要角色扮演|先别演/;
const COURTLY_FORCE_PATTERN = /恢复女官模式|叫我陛下|臣呢|按之前那个模式|恢复微臣模式/;

function shouldDisableCourtlyStyle(text) {
  return COURTLY_DISABLE_PATTERN.test(String(text || ''));
}

function shouldForceCourtlyStyle(text) {
  return COURTLY_FORCE_PATTERN.test(String(text || ''));
}

const SOCIAL_PLATFORM_NAMES = [
  { pattern: /xhslink\.com|xiaohongshu\.com|xhs\.com/i, name: '小红书' },
  { pattern: /bilibili\.com|b23\.tv/i, name: 'B站' },
  { pattern: /mp\.weixin\.qq\.com/i, name: '微信公众号' },
  { pattern: /douyin\.com/i, name: '抖音' },
  { pattern: /kuaishou\.com/i, name: '快手' },
  { pattern: /weibo\.com/i, name: '微博' },
  { pattern: /zhihu\.com/i, name: '知乎' },
  { pattern: /music\.163\.com|y\.music\.163\.com/i, name: '网易云音乐' },
];

function detectSocialPlatform(text) {
  for (const { pattern, name } of SOCIAL_PLATFORM_NAMES) {
    if (pattern.test(text)) return name;
  }
  return '';
}

function buildSocialLinkRoutingHint(payload = {}) {
  const text = String(payload.text || '');
  const platform = detectSocialPlatform(text);
  if (!platform) return '';
  return [
    '【社交链接路由指令（非用户原话，不要复述）】',
    `本轮包含社交平台链接：${platform}。`,
    '必须优先使用 social_reader MCP：',
    '1. 先 resolve_social_url；',
    '2. 再 read_social_post_deep；',
    '3. 不要使用 web_extract 处理该平台链接；',
    '4. 如含图片、视频或音频，再按需调用 media_reader 或 mimo_power；',
    '5. DeepSeek V4 只根据工具返回的结构化文本总结，不得直接处理 image_url。',
  ].join('\n');
}

export function buildCourtlyStyleAnchor(payload = {}) {
  const env = payload._env || process.env;
  const mode = String(env.RAN_AGENT_COURTLY_MODE || 'on').trim().toLowerCase();
  if (mode === 'off') return '';

  const text = String(payload.text || '');
  if (shouldDisableCourtlyStyle(text)) return '';
  if (shouldForceCourtlyStyle(text)) {
    return '当前对话风格：陛下—贴身女官模式。称用户为"陛下"，自称"臣/微臣"；技术内容保持清楚直接。';
  }
  // Default: inject anchor
  return '当前对话风格：陛下—贴身女官模式。称用户为"陛下"，自称"臣/微臣"；技术内容保持清楚直接。';
}

function buildHermesMediaGenerationInstruction() {
  return [
    '【微信桥接媒体工具指令（非用户原话，不要复述）】',
    '如果用户要求生成图片、画图、发图、生成语音、朗读或发语音，必须使用 Hermes MCP 工具 media_generation。',
    '媒体工具成功后，最终回复必须保留工具结果中的 WECHAT_MEDIA: {...} 原始行，供微信桥接层转换为图片或语音。',
  ].join('\n');
}

function buildHermesInboundMediaInstruction(payload = {}) {
  const assetLines = [];
  for (const [index, media] of normalizeMediaItems(payload.media).entries()) {
    assetLines.push([
      `${index + 1}.`,
      `type=${media.type || inferMediaTypeFromMime(media.mimeType) || 'unknown'}`,
      media.mimeType ? `mime=${media.mimeType}` : '',
      `file_path=${media.filePath}`,
    ].filter(Boolean).join(' '));
  }
  for (const imageUrl of Array.isArray(payload.image_urls) ? payload.image_urls : []) {
    const trimmed = typeof imageUrl === 'string' ? imageUrl.trim() : '';
    if (/^https?:\/\//i.test(trimmed)) {
      assetLines.push(`${assetLines.length + 1}. type=image url=${trimmed}`);
    }
  }
  if (assetLines.length === 0) {
    return '';
  }
  return [
    '【微信入站媒体资产（非用户原话，不要复述）】',
    '用户随本轮上传了媒体。DeepSeek V4 不直接看原始媒体；必须优先使用 mimo_power 或 media_reader 的工具结果。',
    '如果工具不可用、媒体过期或引用不明确，要直接说明，不要猜测内容。',
    ...assetLines,
  ].join('\n');
}

function buildHermesMediaContextText(mediaContext = {}, config = {}) {
  if (config.contextPolicyMode === 'compact' && Array.isArray(mediaContext.artifacts)) {
    const selected = selectMediaArtifactsForPrompt(mediaContext.artifacts, config.maxMediaArtifacts || 3);
    return buildCompactMediaContext(selected);
  }
  return String(mediaContext.contextText || '').trim();
}

function buildHermesUserText(payload = {}) {
  const text = String(payload.text || '').trim();
  const batch = Array.isArray(payload.message_batch)
    ? payload.message_batch.map((item) => String(item?.text || '').trim()).filter(Boolean)
    : [];
  return batch.length > 0 ? batch.join('\n') : (text || '你好');
}

const RELATIVE_TIME_PATTERN = /今天|明天|昨天|后天|这周|上周|下周|刚才|最近|现在|今晚|明早|几点|什么时候|多久|何时/;

function buildBridgeTemporalUserContext(payload = {}, now = new Date()) {
  const text = String(payload?.text || '');
  const hasRelativeTime = RELATIVE_TIME_PATTERN.test(text);
  const formatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  if (hasRelativeTime) {
    return `【微信桥接实时上下文（非用户原话，不要复述）】当前本地时间：${formatter.format(now)}（Asia/Shanghai；ISO=${now.toISOString()}）。这是本轮最新时间上下文，涉及相对时间判断时优先参考。`;
  }
  return `【时间：${formatter.format(now)}】`;
}

function buildHermesHeaders(config = {}) {
  const headers = {
    'Content-Type': 'application/json',
  };
  if (config.token) {
    headers.Authorization = `Bearer ${config.token}`;
  }
  return headers;
}

async function parseHermesJson(response) {
  try {
    return await response.json();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`hermes api returned invalid JSON: ${message}`);
  }
}

function buildHermesReply(body = {}, config = {}) {
  const replyText = extractHermesReplyText(body).trim();
  const media = normalizeOutgoingMedia(body.media);
  return {
    reply_text: replyText || config.fallbackText || '',
    follow_up_messages: Array.isArray(body.follow_up_messages) ? body.follow_up_messages : [],
    media,
    model: body.model || config.model,
  };
}

function extractHermesReplyText(body = {}) {
  if (typeof body.reply_text === 'string') {
    return body.reply_text;
  }
  if (typeof body.output_text === 'string') {
    return body.output_text;
  }
  const choice = Array.isArray(body.choices) ? body.choices[0] : null;
  if (typeof choice?.message?.content === 'string') {
    return choice.message.content;
  }
  if (Array.isArray(choice?.message?.content)) {
    return extractTextParts(choice.message.content);
  }
  if (typeof choice?.text === 'string') {
    return choice.text;
  }
  if (Array.isArray(body.output)) {
    return extractTextParts(body.output.flatMap((item) => Array.isArray(item?.content) ? item.content : [item]));
  }
  return '';
}

function extractTextParts(parts = []) {
  return parts
    .map((part) => {
      if (typeof part === 'string') {
        return part;
      }
      if (typeof part?.text === 'string') {
        return part.text;
      }
      if (typeof part?.content === 'string') {
        return part.content;
      }
      return '';
    })
    .filter(Boolean)
    .join('');
}

function normalizeMode(mode) {
  const normalized = String(mode || '').trim().toLowerCase();
  return ['api', 'oneshot', 'auto'].includes(normalized) ? normalized : 'api';
}

function normalizeMediaItems(media) {
  if (!media) {
    return [];
  }
  const items = Array.isArray(media) ? media : [media];
  return items
    .map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return null;
      }
      const filePath = typeof item.filePath === 'string' ? item.filePath.trim() : '';
      if (!filePath) {
        return null;
      }
      return {
        filePath,
        mimeType: typeof item.mimeType === 'string' ? item.mimeType.trim().toLowerCase() : '',
        type: typeof item.type === 'string' ? item.type.trim().toLowerCase() : '',
      };
    })
    .filter(Boolean);
}

function normalizeOutgoingMedia(media) {
  if (!media || typeof media !== 'object' || Array.isArray(media)) {
    return null;
  }
  const type = typeof media.type === 'string' ? media.type.trim().toLowerCase() : '';
  const url = typeof media.url === 'string' ? media.url.trim() : '';
  const fileName = typeof media.fileName === 'string' ? media.fileName.trim() : '';
  if (!type || !url || !['image', 'video', 'file', 'audio'].includes(type)) {
    return null;
  }
  return fileName ? { type, url, fileName } : { type, url };
}

function inferMediaTypeFromMime(mimeType) {
  const mime = String(mimeType || '').toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  return '';
}

function formatErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
