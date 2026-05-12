/**
 * OpenClaw Gateway HTTP client for direct frontend chat completions.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile as execFileCallback, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveStateDir } from './runtimeState.mjs';
import { ensureConversationMediaContext } from './mediaContextStore.mjs';
import {
  buildCompactMediaContext,
  selectMediaArtifactsForPrompt,
  buildContextSizeLog,
  buildPersonaContract,
} from './openclawContextPolicy.mjs';
import { isPathInsideRoot, isTrustedLocalMediaPath, resolveProjectRoot } from './trustedMediaPaths.mjs';
import {
  buildStructuredUrlContext,
  collectExtractedImageUrls,
  extractStructuredContentFromHtml,
  extractStructuredContentFromUrlWithPlaywright,
  extractUrlsFromText,
  shouldUsePlaywrightStructuredExtraction,
} from './webStructuredExtract.mjs';

const INLINE_MEDIA_BYTE_LIMIT = 12 * 1024 * 1024;
const IMAGE_TASK_POLL_MAX_ATTEMPTS = 20;
const IMAGE_TASK_POLL_DELAY_MS = 1500;
const WECHAT_REPLY_SEGMENT_MARKER = /\n{2,}/;
const GENERATED_AUDIO_SAMPLE_RATE = 24000;
const OPENCLAW_EMPTY_RESPONSE_SENTINEL = 'No response from OpenClaw.';
const execFile = promisify(execFileCallback);

export function getOpenClawGatewayConfig(env = process.env) {
  const baseUrl = (env.OPENCLAW_GATEWAY_BASE_URL || 'http://127.0.0.1:19123').replace(/\/$/, '');
  const token = String(env.OPENCLAW_GATEWAY_TOKEN || '').trim();
  const model = String(env.OPENCLAW_GATEWAY_MODEL || 'openclaw/personal-system').trim();
  const allowModelOverride = String(env.OPENCLAW_ALLOW_BACKEND_MODEL_OVERRIDE || '').trim().toLowerCase() === 'true';
  const modelOverride = allowModelOverride ? String(env.OPENCLAW_BACKEND_MODEL || '').trim() : '';
  const audioModel = String(env.OPENCLAW_GATEWAY_AUDIO_MODEL || 'whisper-1').trim();
  const imageModel = String(env.OPENCLAW_GATEWAY_IMAGE_MODEL || 'qwen-image').trim();
  const speechModel = String(env.OPENCLAW_GATEWAY_SPEECH_MODEL || 'qwen3-omni-flash').trim();
  const chatRetryAttempts = Math.max(1, Number.parseInt(String(env.OPENCLAW_GATEWAY_CHAT_RETRY_ATTEMPTS || '3'), 10) || 3);
  const chatRetryDelayMs = Math.max(0, Number.parseInt(String(env.OPENCLAW_GATEWAY_CHAT_RETRY_DELAY_MS || '1500'), 10) || 1500);
  const directApiBaseUrl = (env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com').replace(/\/$/, '');
  const directApiToken = String(env.DASHSCOPE_API_KEY || env.QWEN_API_KEY || env.ANTHROPIC_AUTH_TOKEN || '').trim();
  const agentTimeoutSeconds = Math.max(30, Number.parseInt(String(env.OPENCLAW_AGENT_TIMEOUT_SECONDS || '180'), 10) || 180);
  const projectRoot = resolveProjectRoot(env);

  return {
    baseUrl,
    token,
    model,
    modelOverride,
    audioModel,
    imageModel,
    speechModel,
    chatRetryAttempts,
    chatRetryDelayMs,
    directApiBaseUrl,
    directApiToken,
    agentTimeoutSeconds,
    projectRoot,
    fallbackText: env.NODE_BRIDGE_FALLBACK_TEXT || '暂时无法连接到 personal agent，请稍后再试。',
  };
}

function buildGatewayReply(result = {}) {
  const replyText = String(result.reply_text || '').trim();
  const followUpMessages = Array.isArray(result.follow_up_messages) ? result.follow_up_messages : [];
  const media = normalizeOutgoingMedia(result.media);
  return {
    reply_text: replyText,
    follow_up_messages: followUpMessages,
    media,
    model: result.model,
  };
}

export async function sendChatToOpenClawGateway(payload, options = {}) {
  const config = options.config || getOpenClawGatewayConfig(options.env);
  const fetchImpl = options.fetchImpl || fetch;
  const logger = options.logger || console;
  const recallRequest = detectDirectMemoryRecallRequest(String(payload.text || ''));

  if (recallRequest?.kind === 'breath') {
    return buildGatewayReply(await recallMemoryDirectly(recallRequest.query, {
      fetchImpl,
      logger,
      env: options.env,
    }));
  }

  try {
    return await attemptChatCompletion(payload, {
      config,
      fetchImpl,
      logger,
      useFallbackMediaText: false,
      captureReminder: true,
      structuredContentExtractor: options.structuredContentExtractor,
      playwrightBrowserFactory: options.playwrightBrowserFactory,
      playwrightTimeoutMs: options.playwrightTimeoutMs,
    });
  } catch (error) {
    if (!hasFallbackableMedia(payload)) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`openclaw gateway request failed: ${message}`);
    }

    logger.warn?.(`openclaw gateway multimodal attempt failed, retrying with text fallback: ${formatErrorMessage(error)}`);
    try {
      return await attemptChatCompletion(payload, {
        config,
        fetchImpl,
        logger,
        useFallbackMediaText: true,
        captureReminder: false,
        structuredContentExtractor: options.structuredContentExtractor,
        playwrightBrowserFactory: options.playwrightBrowserFactory,
        playwrightTimeoutMs: options.playwrightTimeoutMs,
      });
    } catch (fallbackError) {
      const message = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      throw new Error(`openclaw gateway request failed: ${message}`);
    }
  }
}

export async function sendChatToOpenClawAgent(payload, options = {}) {
  const env = options.env || process.env;
  const config = options.config || getOpenClawGatewayConfig(env);
  const execFileImpl = options.execFileImpl || execFile;
  const logger = options.logger || console;
  const timeoutSeconds = Math.max(30, Number(options.timeoutSeconds || config.agentTimeoutSeconds || 180));
  const projectRoot = config.projectRoot || resolveProjectRoot(env);
  const configPath = String(
    env.OPENCLAW_CONFIG_PATH
    || env.OPENCLAW_CONFIG
    || path.join(projectRoot, 'openclaw/openclaw.personal-system.json')
  );
  const preparedPayload = preparePayloadMediaForAgent(payload, {
    env,
    logger,
    projectRoot,
  });
  const sessionId = buildOpenClawAgentSessionId(preparedPayload);
  const mediaContext = await ensureConversationMediaContext(preparedPayload, {
    env,
    logger,
    ...(options.mediaContextOptions || {}),
  });
  // Context Policy v1: compact media context
  const contextPolicyMode = String(env.OPENCLAW_CONTEXT_POLICY || 'compact').trim().toLowerCase();
  const maxMediaArtifacts = Math.max(1, Number(env.OPENCLAW_MAX_MEDIA_ARTIFACTS || 3));
  const enableContextSizeLog = String(env.OPENCLAW_CONTEXT_SIZE_LOG || '1').trim().toLowerCase() === '1';

  let mediaContextText;
  if (contextPolicyMode === 'compact' && Array.isArray(mediaContext.artifacts)) {
    const selected = selectMediaArtifactsForPrompt(mediaContext.artifacts, maxMediaArtifacts);
    mediaContextText = buildCompactMediaContext(selected);
  } else {
    // legacy fallback
    mediaContextText = mediaContext.contextText;
  }

  // Context size logging
  if (enableContextSizeLog) {
    const personaContract = buildPersonaContract();
    const temporalContext = buildBridgeTemporalUserContext();
    const mediaInstruction = String(options.mediaInstruction || "");
    const userText = String(preparedPayload.text || "");
    const finalMessage = buildOpenClawAgentMessage(preparedPayload, { mediaContextText });
    const sizeLog = buildContextSizeLog([
      { label: "system_prompt_chars", text: temporalContext },
      { label: "persona_prompt_chars", text: personaContract },
      { label: "history_chars", text: "" },
      { label: "media_context_chars", text: mediaContextText },
      { label: "tool_context_chars", text: mediaInstruction },
      { label: "final_prompt_chars", text: finalMessage },
    ]);
    const enrichedLog = {
      ...sizeLog,
      media_artifact_count: Array.isArray(mediaContext.artifacts) ? mediaContext.artifacts.length : 0,
      injected_media_count: Array.isArray(mediaContext.artifacts) && contextPolicyMode === "compact" ? selectMediaArtifactsForPrompt(mediaContext.artifacts, maxMediaArtifacts).length : 0,
      compacted_history_count: 0,
      request_id: String(Date.now()) + "-" + Math.random().toString(36).slice(2, 8),
      context_policy_mode: contextPolicyMode,
    };
    logger.log?.("[context-size]", JSON.stringify(enrichedLog));
  }
  const message = buildOpenClawAgentMessage(preparedPayload, {
    mediaContextText,
  });
  const command = String(env.OPENCLAW_AGENT_COMMAND || 'npx').trim() || 'npx';
  const args = [
    'openclaw',
    'agent',
    '--session-id',
    sessionId,
    '--message',
    message,
    '--timeout',
    String(timeoutSeconds),
    '--json',
  ];

  logger.log?.(`openclaw agent request session_id=${sessionId} timeout_seconds=${timeoutSeconds}`);
  const childEnv = buildOpenClawAgentChildEnv({
    env,
    projectRoot,
    configPath,
  });
  let stdout = '';
  let stderr = '';
  try {
    const result = await execFileImpl(command, args, {
      cwd: projectRoot,
      env: childEnv,
      timeout: (timeoutSeconds + 30) * 1000,
      maxBuffer: 8 * 1024 * 1024,
    });
    stdout = String(result?.stdout || '');
    stderr = String(result?.stderr || '');
  } catch (error) {
    stdout = String(error?.stdout || '');
    stderr = String(error?.stderr || '');
    const detail = [error?.message, stderr.trim()].filter(Boolean).join(': ');
    throw new Error(`openclaw agent request failed: ${detail || String(error)}`);
  }

  if (stderr.trim()) {
    logger.warn?.(`openclaw agent stderr: ${stderr.trim().slice(0, 1000)}`);
  }
  const parsed = parseOpenClawAgentJson(stdout);
  if (parsed?.status && parsed.status !== 'ok') {
    throw new Error(`openclaw agent error: ${parsed.summary || parsed.status}`);
  }
  const result = parsed?.result && typeof parsed.result === 'object' ? parsed.result : parsed || {};
  const payloads = Array.isArray(result.payloads) ? result.payloads : [];
  const replyText = payloads
    .map((item) => typeof item?.text === 'string' ? item.text.trim() : '')
    .filter(Boolean)
    .join('\n\n')
    || String(result?.meta?.finalAssistantVisibleText || '').trim();
  if (!replyText || replyText === OPENCLAW_EMPTY_RESPONSE_SENTINEL) {
    throw new Error('openclaw agent returned empty response');
  }
  const agentMeta = result?.meta?.agentMeta || {};
  return buildGatewayReply({
    reply_text: replyText,
    follow_up_messages: [],
    media: extractOpenClawAgentPayloadMedia(payloads),
    model: [agentMeta.provider, agentMeta.model].filter(Boolean).join('/') || 'openclaw/agent',
  });
}

function buildOpenClawAgentChildEnv({ env = process.env, projectRoot, configPath }) {
  const projectEnv = {
    ...readDotEnvFile(path.join(projectRoot, '.env.local')),
    ...readDotEnvFile(path.join(projectRoot, 'node_bridge', '.env.local')),
    ...env,
    OPENCLAW_CONFIG_PATH: configPath,
  };
  const merged = {
    ...process.env,
    ...projectEnv,
  };
  inheritClaudeSettingsEnv(merged, new Set(Object.keys(projectEnv)));
  return merged;
}

function readDotEnvFile(filePath) {
  const values = {};
  let raw = '';
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return values;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) {
      continue;
    }
    const index = trimmed.indexOf('=');
    const key = trimmed.slice(0, index).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }
    values[key] = unquoteEnvValue(trimmed.slice(index + 1).trim());
  }
  return values;
}

function unquoteEnvValue(value) {
  if (value.length >= 2 && (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))
  )) {
    return value.slice(1, -1);
  }
  return value;
}

function inheritClaudeSettingsEnv(targetEnv, protectedKeys = new Set()) {
  const settingsPath = selectClaudeSettingsFile(targetEnv);
  if (!settingsPath) {
    return;
  }
  const settingsEnv = readClaudeSettingsEnv(settingsPath);
  for (const key of [
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'API_TIMEOUT_MS',
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  ]) {
    if (!protectedKeys.has(key) && settingsEnv[key] !== undefined && settingsEnv[key] !== null && String(settingsEnv[key])) {
      targetEnv[key] = String(settingsEnv[key]);
    }
  }
}

function selectClaudeSettingsFile(env = process.env) {
  const candidates = [];
  if (env.CLAUDE_SETTINGS_FILE) {
    candidates.push(env.CLAUDE_SETTINGS_FILE);
  }
  if (env.HOME) {
    candidates.push(path.join(env.HOME, '.claude', 'settings.json'));
  }
  candidates.push('/home/ubuntu/.claude/settings.json', '/usr/bin/.claude/settings.json');
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    try {
      if (fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // Try next candidate.
    }
  }
  return '';
}

function readClaudeSettingsEnv(settingsPath) {
  try {
    const parsed = JSON.parse(stripJsonLineComments(fs.readFileSync(settingsPath, 'utf8')));
    return parsed?.env && typeof parsed.env === 'object' && !Array.isArray(parsed.env)
      ? parsed.env
      : {};
  } catch {
    return {};
  }
}

function stripJsonLineComments(text) {
  let result = '';
  let inString = false;
  let escape = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1] || '';
    if (inString) {
      result += char;
      if (escape) {
        escape = false;
      } else if (char === '\\') {
        escape = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }
    if (char === '/' && next === '/') {
      index += 1;
      while (index + 1 < text.length && !['\r', '\n'].includes(text[index + 1])) {
        index += 1;
      }
      continue;
    }
    result += char;
  }
  return result;
}

function extractOpenClawAgentPayloadMedia(payloads = []) {
  if (!Array.isArray(payloads)) {
    return null;
  }
  for (const payload of payloads) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      continue;
    }
    const mediaUrl = typeof payload.mediaUrl === 'string' && payload.mediaUrl.trim()
      ? payload.mediaUrl.trim()
      : Array.isArray(payload.mediaUrls)
        ? payload.mediaUrls.find((item) => typeof item === 'string' && item.trim())?.trim()
        : '';
    if (!mediaUrl) {
      continue;
    }
    const type = inferOpenClawAgentMediaType(mediaUrl, payload.audioAsVoice === true);
    const fileName = extractFileNameFromMediaUrl(mediaUrl);
    return fileName ? { type, url: mediaUrl, fileName } : { type, url: mediaUrl };
  }
  return null;
}

function inferOpenClawAgentMediaType(mediaUrl, audioAsVoice = false) {
  if (audioAsVoice) {
    return 'audio';
  }
  const extension = path.extname(extractPathFromMediaUrl(mediaUrl)).trim().toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.avif', '.heic'].includes(extension)) {
    return 'image';
  }
  if (['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v'].includes(extension)) {
    return 'video';
  }
  if (['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.oga', '.webm', '.flac'].includes(extension)) {
    return 'audio';
  }
  return 'file';
}

function extractFileNameFromMediaUrl(mediaUrl) {
  const fileName = path.basename(extractPathFromMediaUrl(mediaUrl)).trim();
  return fileName && fileName !== '.' && fileName !== '/' ? fileName : '';
}

function extractPathFromMediaUrl(mediaUrl) {
  const raw = String(mediaUrl || '').trim();
  if (!raw) {
    return '';
  }
  try {
    return decodeURIComponent(new URL(raw).pathname || '');
  } catch {
    return raw.split(/[?#]/, 1)[0] || raw;
  }
}

export function buildTemporalContext(now = new Date()) {
  const shanghaiDateTime = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(now).replace(' ', 'T');
  const timeString = now.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'long',
  });
  const hourParts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const hour = Number(hourParts.find((part) => part.type === 'hour')?.value || '0');
  let timeOfDay = '晚上';
  if (hour >= 6 && hour <= 11) {
    timeOfDay = '早上';
  } else if (hour >= 12 && hour <= 17) {
    timeOfDay = '下午';
  } else if (hour >= 18 && hour <= 22) {
    timeOfDay = '晚上';
  } else {
      timeOfDay = '深夜';
  }
  return {
    timeString,
    timeOfDay,
    absoluteTimeString: `${shanghaiDateTime}+08:00`,
  };
}

function buildBridgeTemporalUserContext(now = new Date()) {
  const { timeString, timeOfDay, absoluteTimeString } = buildTemporalContext(now);
  return `【微信桥接实时上下文（非用户原话，不要复述）】当前本地时间：${timeString}（${timeOfDay}，Asia/Shanghai；ISO=${absoluteTimeString}）。这是本轮最新时间上下文，涉及相对时间判断时优先参考。`;
}

function prependBridgeTemporalUserContext(text) {
  const trimmed = String(text || '').trim();
  const context = buildBridgeTemporalUserContext();
  if (!trimmed) {
    return context;
  }
  return `${context}\n\n${trimmed}`;
}

function addBridgeTemporalContextToUserContent(content) {
  if (!Array.isArray(content) || content.length === 0) {
    return [{ type: 'text', text: buildBridgeTemporalUserContext() }];
  }
  const hasMediaPart = content.some((part) => part?.type && part.type !== 'text');
  if (hasMediaPart) {
    return [
      ...content,
      { type: 'text', text: buildBridgeTemporalUserContext() },
    ];
  }
  const firstTextIndex = content.findIndex((part) => part?.type === 'text');
  if (firstTextIndex < 0) {
    return [
      ...content,
      { type: 'text', text: buildBridgeTemporalUserContext() },
    ];
  }
  return content.map((part, index) => (
    index === firstTextIndex
      ? { ...part, text: prependBridgeTemporalUserContext(part.text) }
      : part
  ));
}

function buildOpenClawAgentSessionId(payload = {}) {
  const raw = String(payload.sender_id || payload.user || 'wechat').trim() || 'wechat';
  const encoded = Buffer.from(raw).toString('base64url').slice(0, 72);
  return `wechat-${encoded || 'default'}`;
}

function buildOpenClawAgentMessage(payload = {}, options = {}) {
  const text = String(payload.text || '').trim();
  const batch = Array.isArray(payload.message_batch)
    ? payload.message_batch
        .map((item) => String(item?.text || '').trim())
        .filter(Boolean)
    : [];
  const userText = batch.length > 0 ? batch.join('\n') : text;
  const mediaInstruction = [
    '【微信桥接媒体工具指令（非用户原话，不要复述）】',
    '如果用户要求生成图片、画图、发图、生成语音、朗读或发语音，必须调用 OpenClaw MCP 工具 media_generation__generate_image 或 media_generation__generate_speech。',
    '不允许使用 exec、PATH 检查、command -v、pollinations.ai，不能编造 markdown 图片 URL。',
    '媒体工具成功后，最终回复必须保留工具结果中的 WECHAT_MEDIA: {...} 原始行，供微信桥接层转换为图片或语音。',
  ].join('\n');
  const inboundMediaInstruction = buildInboundMediaInstruction(payload);
  const mediaContextText = String(options.mediaContextText || '').trim();
  return [
    buildBridgeTemporalUserContext(),
    mediaInstruction,
    inboundMediaInstruction,
    mediaContextText,
    userText || '你好',
  ].filter(Boolean).join('\n\n');
}

function buildInboundMediaInstruction(payload = {}) {
  const mediaItems = normalizeMediaItems(payload.media);
  const assetLines = [];
  for (const [index, media] of mediaItems.entries()) {
    const filePath = typeof media.filePath === 'string' ? media.filePath.trim() : '';
    if (!filePath) {
      continue;
    }
    assetLines.push([
      `${index + 1}.`,
      `type=${media.type || inferMediaTypeFromMime(media.mimeType) || 'unknown'}`,
      media.mimeType ? `mime=${media.mimeType}` : '',
      `file_path=${filePath}`,
    ].filter(Boolean).join(' '));
  }
  for (const imageUrl of Array.isArray(payload.image_urls) ? payload.image_urls : []) {
    const trimmed = typeof imageUrl === 'string' ? imageUrl.trim() : '';
    if (!isRemoteHttpUrl(trimmed)) {
      continue;
    }
    assetLines.push(`${assetLines.length + 1}. type=image url=${trimmed}`);
  }
  if (assetLines.length === 0) {
    return '';
  }
  return [
    '【微信入站媒体资产（非用户原话，不要复述）】',
    '用户随本轮上传了媒体。必须调用 MCP 工具 mimo_power__analyze 来分析这些媒体，把下列 file_path/url 作为 assets 传入。',
    '不要用 exec/process 读取图片文件，不要用自身视觉能力直接分析图片。优先调用 mimo_power__analyze；如果 MiMo 返回临时错误（如 MIMO_REQUEST_FAILED、MIMO_REQUEST_TIMEOUT 等），自动 fallback 到 media_reader；如果 MiMo 返回配置错误（MIMO_TOKEN_PLAN_KEY_MISSING、EXPIRED），直接报错提示用户检查 Token Plan 配置。',
    ...assetLines,
  ].join('\n');
}

function preparePayloadMediaForAgent(payload = {}, options = {}) {
  const mediaItems = normalizeMediaItems(payload.media);
  if (mediaItems.length === 0) {
    return payload;
  }

  const projectRoot = path.resolve(String(options.projectRoot || resolveProjectRoot(options.env)));
  let changed = false;
  const preparedMedia = mediaItems.map((item) => {
    const preparedPath = prepareLocalMediaPathForAgent(item.filePath, {
      ...options,
      projectRoot,
    });
    if (preparedPath !== item.filePath) {
      changed = true;
      return preparedPath ? { ...item, filePath: preparedPath } : null;
    }
    return item;
  }).filter(Boolean);

  if (!changed) {
    return payload;
  }
  return {
    ...payload,
    media: preparedMedia,
  };
}

function prepareLocalMediaPathForAgent(filePath, options = {}) {
  const raw = typeof filePath === 'string' ? filePath.trim() : '';
  if (!raw || isRemoteOrDataImageUrl(raw)) {
    return raw;
  }
  const resolved = path.resolve(raw);
  const projectRoot = path.resolve(String(options.projectRoot || resolveProjectRoot(options.env)));
  const env = {
    ...(options.env || process.env),
    RAN_AGENT_ROOT: projectRoot,
  };
  if (isTrustedLocalMediaPath(resolved, env)) {
    return resolved;
  }
  // Only copy external files (outside the project workspace) into the trusted
  // inbound directory. Project-internal files (e.g. .env, vault, data) are
  // never promoted to trusted media — they stay dropped.
  if (isPathInsideRoot(resolved, projectRoot)) {
    options.logger?.warn?.('dropping project-internal file outside trusted media directories');
    return '';
  }
  try {
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      options.logger?.warn?.(`inbound media file not found or not a file: ${resolved}`);
      return '';
    }
    const inboundDir = path.join(projectRoot, 'debug', 'wechat', 'inbound');
    fs.mkdirSync(inboundDir, { recursive: true });
    const ext = path.extname(resolved) || '.bin';
    const base = path.basename(resolved, path.extname(resolved)) || 'media';
    const dest = path.join(inboundDir, `${base}-${Date.now()}${ext}`);
    fs.copyFileSync(resolved, dest);
    options.logger?.log?.(`copied inbound media to trusted dir: ${dest}`);
    return dest;
  } catch (error) {
    options.logger?.warn?.(`failed to copy inbound media to trusted dir: ${error instanceof Error ? error.message : String(error)}`);
    return '';
  }
}

function inferMediaTypeFromMime(mimeType) {
  const normalized = String(mimeType || '').trim().toLowerCase();
  if (normalized.startsWith('image/')) return 'image';
  if (normalized.startsWith('audio/')) return 'audio';
  if (normalized.startsWith('video/')) return 'video';
  if (normalized) return 'file';
  return '';
}

function parseOpenClawAgentJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) {
    throw new Error('openclaw agent returned no JSON output');
  }
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(text.slice(start, end + 1));
    }
    throw new Error(`openclaw agent returned invalid JSON: ${text.slice(0, 500)}`);
  }
}

function buildAvailableTools(options = {}) {
  const allowCreateTodo = options.allowCreateTodo !== false;
  const allowListTodos = options.allowListTodos === true;
  const allowStoreExplorationMemory = options.allowStoreExplorationMemory === true;
  const allowMediaGeneration = options.allowMediaGeneration !== false;
  const tools = [];

  if (allowCreateTodo) {
    tools.push({
      type: 'function',
      function: {
        name: 'create_todo',
        description: 'Create a todo/reminder when user mentions a task with a specific time. Extract the time expression and task content from the user message.',
        parameters: {
          type: 'object',
          properties: {
            text: {
              type: 'string',
              description: 'The full text containing time expression and task content, e.g., "周四下午1点去单位开会"',
            },
          },
          required: ['text'],
        },
      },
    });
  }

  if (allowListTodos) {
    tools.push({
      type: 'function',
      function: {
        name: 'list_todos',
        description: 'List all pending todos/reminders',
        parameters: {
          type: 'object',
          properties: {},
        },
      },
    });
  }

  if (allowStoreExplorationMemory) {
    tools.push({
      type: 'function',
      function: {
        name: 'store_exploration_memory',
        description: 'Store exploration findings as a memory for future reference. Call this after using web_search or web_fetch to discover something interesting that the user might care about. The memory will be available for recall in future conversations.',
        parameters: {
          type: 'object',
          properties: {
            topic: {
              type: 'string',
              description: 'The topic or subject that was explored',
            },
            source: {
              type: 'string',
              description: 'The source of the exploration (e.g., "web_search", "wikipedia", "tech_news")',
            },
            summary: {
              type: 'string',
              description: 'A concise summary of what was learned (2-3 sentences)',
            },
            key_insights: {
              type: 'array',
              items: { type: 'string' },
              description: 'Key insights or facts discovered during exploration',
            },
            relevance_to_user: {
              type: 'string',
              description: 'Why this might be relevant or interesting to the user',
            },
          },
          required: ['topic', 'summary'],
        },
      },
    });
  }

  if (allowMediaGeneration) {
    tools.push({
      type: 'function',
      function: {
        name: 'generate_image',
        description: 'Generate an image and send it back to the user as WeChat image media. Use when the user asks to draw, create, make, or send a picture, image, poster, avatar, wallpaper, or illustration.',
        parameters: {
          type: 'object',
          properties: {
            prompt: {
              type: 'string',
              description: 'A concise image generation prompt describing the desired visual result.',
            },
          },
          required: ['prompt'],
          additionalProperties: false,
        },
      },
    });

    tools.push({
      type: 'function',
      function: {
        name: 'generate_speech',
        description: 'Generate spoken audio and send it back to the user as a native WeChat voice message. Use when the user asks to send a voice message, read text aloud, say a sentence, synthesize speech, or create audio.',
        parameters: {
          type: 'object',
          properties: {
            text: {
              type: 'string',
              description: 'The exact text to speak in the generated voice message.',
            },
          },
          required: ['text'],
          additionalProperties: false,
        },
      },
    });
  }

  return tools;
}

function buildResponsesMediaGenerationTools() {
  return [
    {
      type: 'function',
      name: 'generate_image',
      description: 'Generate an image and send it back to the user as WeChat image media. Use when the user asks to draw, create, make, or send a picture, image, poster, avatar, wallpaper, or illustration.',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'A concise image generation prompt describing the desired visual result.',
          },
        },
        required: ['prompt'],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'generate_speech',
      description: 'Generate spoken audio and send it back to the user as a native WeChat voice message. Use when the user asks to send a voice message, read text aloud, say a sentence, synthesize speech, or create audio.',
      parameters: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'The exact text to speak in the generated voice message.',
          },
        },
        required: ['text'],
        additionalProperties: false,
      },
    },
  ];
}

function buildMediaGenerationSystemPrompt() {
  return '当前微信桥接系统提供可调用的出站多模态生成工具：generate_image 会生成并发送图片，generate_speech 会生成并发送微信语音。用户请求画图、发图、生成图片、朗读、发语音、语音消息、合成音频时，优先调用对应工具；不要仅根据前台文本模型本体回答“不能画图/没有 TTS”。工具结果会进入本轮上下文，最终回复应自然确认已发送。';
}

async function maybeCreateReminderForExplicitRequest(payload, options = {}) {
  const text = String(payload.text || '').trim();
  if (!isExplicitReminderRequest(text)) {
    return null;
  }

  const fetchImpl = options.fetchImpl || fetch;
  const logger = options.logger || console;
  const backendBaseUrl = process.env.PYTHON_BACKEND_BASE_URL || 'http://127.0.0.1:8787';

  const response = await fetchImpl(`${backendBaseUrl}/tools/todo/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      source: 'openclaw_live_chat',
      extract_time: true,
      require_time: true,
    }),
  });

  let responseBody;
  try {
    responseBody = await response.json();
  } catch {
    throw new Error('todo creation returned invalid JSON');
  }

  if (response.status === 422) {
    logger.warn?.(`deterministic reminder capture needs follow-up: ${responseBody?.error || 'time parse failed'}`);
    return {
      needsFollowUp: true,
      error: responseBody?.error || 'Failed to parse reminder time',
    };
  }

  if (!response.ok) {
    const errorText = typeof responseBody?.error?.message === 'string'
      ? responseBody.error.message
      : typeof responseBody?.error === 'string'
        ? responseBody.error
        : `HTTP ${response.status}`;
    throw new Error(`todo creation failed: ${errorText}`);
  }

  if (!responseBody?.success) {
    throw new Error(responseBody?.error || 'todo creation failed');
  }

  logger.info?.(`deterministic reminder created todo_id=${responseBody.todo_id ?? 'unknown'}`);
  return responseBody;
}

function isExplicitReminderRequest(text) {
  return /(?:提醒我|帮我提醒|叫我|记得|闹钟)/.test(String(text || '').trim());
}

function isExplicitTodoCompletion(text) {
  return /^(?:办完了|做完了|完成了|搞定了|已经办完了|已经做完了|已经完成了|已经搞定了)(?:[，,。！! ]*(?:不用提醒了|不用提醒|别提醒了|不需要提醒了))?$/.test(
    String(text || '').trim()
  );
}

function isExplicitTodoCancellation(text) {
  return /^(?:这个提醒不用了|这个不用提醒了|不用提醒了|不用提醒|别提醒了|取消提醒|这条提醒取消吧)$/.test(
    String(text || '').trim()
  );
}

async function maybeCompleteTodoForExplicitUpdate(payload, options = {}) {
  const text = String(payload.text || '').trim();
  if (!isExplicitTodoCompletion(text)) {
    return null;
  }

  const fetchImpl = options.fetchImpl || fetch;
  const logger = options.logger || console;
  const backendBaseUrl = process.env.PYTHON_BACKEND_BASE_URL || 'http://127.0.0.1:8787';

  const response = await fetchImpl(`${backendBaseUrl}/tools/todo/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      source: 'openclaw_live_chat',
    }),
  });

  let responseBody;
  try {
    responseBody = await response.json();
  } catch {
    throw new Error('todo completion returned invalid JSON');
  }

  if (!response.ok) {
    const errorText = typeof responseBody?.error === 'string' ? responseBody.error : `HTTP ${response.status}`;
    throw new Error(`todo completion failed: ${errorText}`);
  }
  logger.info?.(`deterministic todo completion todo_id=${responseBody.todo_id ?? 'unknown'}`);
  return responseBody;
}

async function maybeCancelTodoForExplicitUpdate(payload, options = {}) {
  const text = String(payload.text || '').trim();
  if (!isExplicitTodoCancellation(text)) {
    return null;
  }

  const fetchImpl = options.fetchImpl || fetch;
  const logger = options.logger || console;
  const backendBaseUrl = process.env.PYTHON_BACKEND_BASE_URL || 'http://127.0.0.1:8787';

  const response = await fetchImpl(`${backendBaseUrl}/tools/todo/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      source: 'openclaw_live_chat',
    }),
  });

  let responseBody;
  try {
    responseBody = await response.json();
  } catch {
    throw new Error('todo cancellation returned invalid JSON');
  }

  if (!response.ok) {
    const errorText = typeof responseBody?.error === 'string' ? responseBody.error : `HTTP ${response.status}`;
    throw new Error(`todo cancellation failed: ${errorText}`);
  }
  logger.info?.(`deterministic todo cancellation todo_id=${responseBody.todo_id ?? 'unknown'}`);
  return responseBody;
}

function shouldOverrideReminderReply(replyText) {
  const text = String(replyText || '');
  return /没法主动发消息提醒|不能主动发消息提醒|记得设个手机闹钟|设个手机闹钟|自己设闹钟/.test(text);
}

function buildDeterministicReminderReply(reminderCapture, payload) {
  const parsedTime = String(reminderCapture?.parsed_time || '').trim();
  const content = String(reminderCapture?.content || payload?.text || '').trim();
  if (parsedTime && content) {
    return `好，已经记下了。我会在${parsedTime}提醒你：${content}。`;
  }
  if (parsedTime) {
    return `好，已经记下了。我会在${parsedTime}提醒你。`;
  }
  return '好，已经记下了。我会按时提醒你。';
}

function finalizeReminderReply(replyText, reminderCapture, payload) {
  if (!reminderCapture?.parsed_time) {
    return replyText;
  }
  if (shouldOverrideReminderReply(replyText)) {
    return buildDeterministicReminderReply(reminderCapture, payload);
  }
  return replyText;
}

async function parseResponseJson(response, errorMessage) {
  try {
    return await response.json();
  } catch {
    throw new Error(errorMessage);
  }
}

function extractGatewayErrorText(body, status) {
  return typeof body?.error?.message === 'string'
    ? body.error.message
    : typeof body?.error === 'string'
      ? body.error
      : `HTTP ${status}`;
}

async function attemptChatCompletion(payload, options = {}) {
  const config = options.config || getOpenClawGatewayConfig(options.env);
  const fetchImpl = options.fetchImpl || fetch;
  const logger = options.logger || console;
  const sleepImpl = options.sleepImpl || sleep;
  const rawText = String(payload.text || '').trim();
  const standaloneCommandText = detectStandaloneOpenClawCommand(rawText);
  if (standaloneCommandText) {
    return await sendStandaloneGatewayCommand(standaloneCommandText, payload, {
      config,
      fetchImpl,
      logger,
      sleepImpl,
    });
  }
  const isReminderRequest = isExplicitReminderRequest(payload.text);
  const completionCapture = options.captureReminder === false
    ? null
    : await maybeCompleteTodoForExplicitUpdate(payload, { fetchImpl, logger });
  const cancellationCapture = options.captureReminder === false || completionCapture
    ? null
    : await maybeCancelTodoForExplicitUpdate(payload, { fetchImpl, logger });
  let reminderCapture = null;
  if (options.captureReminder !== false && isReminderRequest && !completionCapture && !cancellationCapture) {
    reminderCapture = await maybeCreateReminderForExplicitRequest(payload, {
      fetchImpl,
      logger,
    });
  }
  const content = await buildUserMessageContent(payload, {
    config,
    fetchImpl,
    logger,
    useFallbackMediaText: options.useFallbackMediaText === true,
    structuredContentExtractor: options.structuredContentExtractor,
    playwrightBrowserFactory: options.playwrightBrowserFactory,
    playwrightTimeoutMs: options.playwrightTimeoutMs,
  });

  const { timeString, timeOfDay, absoluteTimeString } = buildTemporalContext();
  const messages = [
    {
      role: 'system',
      content: `当前时间：${timeString}（${timeOfDay}，Asia/Shanghai；ISO=${absoluteTimeString}）。回答涉及时间时先和现在对齐。`,
    },
  ];

  if (reminderCapture?.parsed_time) {
    messages.push({
      role: 'system',
      content: `这条消息里的提醒已由后端成功创建，提醒时间是 ${reminderCapture.parsed_time}。不要再次创建提醒，直接自然确认即可。`,
    });
  } else if (completionCapture?.todo_id) {
    messages.push({
      role: 'system',
      content: `这条消息对应的待办已由后端标记为完成，事项是 ${completionCapture.content || '该待办'}。不要重复调用完成动作，直接自然确认即可。`,
    });
  } else if (cancellationCapture?.todo_id) {
    messages.push({
      role: 'system',
      content: `这条消息对应的待办已由后端取消提醒，事项是 ${cancellationCapture.content || '该待办'}。不要重复调用取消动作，直接自然确认即可。`,
    });
  } else if (reminderCapture?.needsFollowUp) {
    messages.push({
      role: 'system',
      content: '用户明确想设置提醒，但当前未能可靠解析提醒时间。你必须先用一句简短中文追问具体时间，暂时不要声称已经设置成功。',
    });
  }

  const tools = buildAvailableTools({
    allowCreateTodo: !(reminderCapture?.parsed_time || reminderCapture?.needsFollowUp || isReminderRequest),
    allowListTodos: shouldAllowTodoListing(payload.text),
    allowStoreExplorationMemory: shouldAllowExplorationMemoryTool(payload),
    allowMediaGeneration: config.enableBridgeMediaTools === true,
  });
  if (tools.some((tool) => tool?.function?.name === 'generate_image' || tool?.function?.name === 'generate_speech')) {
    messages.push({
      role: 'system',
      content: buildMediaGenerationSystemPrompt(),
    });
  }

  messages.push({
    role: 'user',
    content: serializeUserContent(content, payload),
  });

  const requestBody = {
    model: config.model,
    user: payload.sender_id,
    messages,
    tools,
  };

  const headers = buildOpenClawHeaders(config, payload);
  let response;
  try {
    response = await postChatCompletionWithRetry(`${config.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
    }, {
      config,
      fetchImpl,
      logger,
      sleepImpl,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`openclaw gateway request failed: ${message}`);
  }

  const responseBody = await parseResponseJson(response, 'openclaw gateway returned invalid JSON');

  if (!response.ok) {
    throw new Error(`openclaw gateway error: ${extractGatewayErrorText(responseBody, response.status)}`);
  }

  const message = responseBody?.choices?.[0]?.message;
  const contentText = message?.content;
  const toolCalls = message?.tool_calls;

  // Handle tool calls
  if (toolCalls && Array.isArray(toolCalls) && toolCalls.length > 0) {
    const toolResults = await executeToolCalls(toolCalls, {
      fetchImpl,
      logger,
      config,
      env: options.env,
      sleepImpl,
    });

    // Build follow-up request with tool results
    const followUpMessages = [
      ...requestBody.messages,
      {
        role: 'assistant',
        content: contentText || null,
        tool_calls: toolCalls,
      },
      ...toolResults.map((result) => ({
        role: 'tool',
        tool_call_id: result.tool_call_id,
        content: JSON.stringify(result.output),
      })),
    ];

    const followUpBody = {
      ...requestBody,
      messages: followUpMessages,
    };

    const followUpResponse = await postChatCompletionWithRetry(`${config.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(followUpBody),
    }, {
      config,
      fetchImpl,
      logger,
      sleepImpl,
    });

    const followUpBody_json = await parseResponseJson(followUpResponse, 'openclaw gateway returned invalid JSON on tool follow-up');

    if (!followUpResponse.ok) {
      throw new Error(`openclaw gateway error on follow-up: ${extractGatewayErrorText(followUpBody_json, followUpResponse.status)}`);
    }

    const finalContent = followUpBody_json?.choices?.[0]?.message?.content;
    if (typeof finalContent !== 'string' || finalContent.trim() === '') {
      throw new Error('openclaw gateway response missing content after tool execution');
    }
    if (isOpenClawEmptyResponseSentinel(finalContent)) {
      throw new Error('openclaw gateway returned empty agent response after tool execution');
    }

    return buildGatewayReply({
      ...buildWechatReplyEnvelope(
        finalizeReminderReply(finalContent, reminderCapture, payload),
        payload,
      ),
      media: pickFirstGeneratedMedia(toolResults),
      model: followUpBody_json?.model || config.model,
    });
  }

  if (typeof contentText !== 'string' || contentText.trim() === '') {
    throw new Error('openclaw gateway response missing choices[0].message.content');
  }
  if (isOpenClawEmptyResponseSentinel(contentText)) {
    throw new Error('openclaw gateway returned empty agent response');
  }

  return buildGatewayReply({
    ...buildWechatReplyEnvelope(
      finalizeReminderReply(contentText, reminderCapture, payload),
      payload,
    ),
    model: responseBody?.model || config.model,
  });
}

function isOpenClawEmptyResponseSentinel(text) {
  return String(text || '').trim() === OPENCLAW_EMPTY_RESPONSE_SENTINEL;
}

function detectStandaloneOpenClawCommand(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed || /\n/.test(trimmed)) {
    return '';
  }
  if (!trimmed.startsWith('/')) {
    return '';
  }
  return /^\/[a-z0-9_-]+(?:\s+.*)?$/i.test(trimmed) ? trimmed : '';
}

async function sendStandaloneGatewayCommand(commandText, payload, options = {}) {
  const config = options.config || getOpenClawGatewayConfig(options.env);
  const fetchImpl = options.fetchImpl || fetch;
  const logger = options.logger || console;
  const sleepImpl = options.sleepImpl || sleep;
  const headers = buildOpenClawHeaders(config, payload);
  const requestBody = {
    model: config.model,
    user: payload.sender_id,
    messages: [
      {
        role: 'user',
        content: commandText,
      },
    ],
    tools: [],
  };

  const response = await postChatCompletionWithRetry(`${config.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(requestBody),
  }, {
    config,
    fetchImpl,
    logger,
    sleepImpl,
  });

  const responseBody = await parseResponseJson(response, 'openclaw gateway returned invalid JSON');

  if (!response.ok) {
    throw new Error(`openclaw gateway error: ${extractGatewayErrorText(responseBody, response.status)}`);
  }

  const contentText = responseBody?.choices?.[0]?.message?.content;
  if (typeof contentText !== 'string' || contentText.trim() === '') {
    throw new Error('openclaw gateway response missing choices[0].message.content');
  }
  if (isOpenClawEmptyResponseSentinel(contentText)) {
    throw new Error('openclaw gateway returned empty agent response');
  }

  return buildGatewayReply({
    ...buildWechatReplyEnvelope(contentText, payload),
    model: responseBody?.model || config.model,
  });
}

async function postChatCompletionWithRetry(url, init, options = {}) {
  const config = options.config || {};
  const fetchImpl = options.fetchImpl || fetch;
  const logger = options.logger || console;
  const sleepImpl = options.sleepImpl || sleep;
  const maxAttempts = Math.max(1, Number(config.chatRetryAttempts) || 1);
  const delayMs = Math.max(0, Number(config.chatRetryDelayMs) || 0);

  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, init);
      if (!shouldRetryGatewayResponse(response) || attempt === maxAttempts) {
        return response;
      }
      logger.warn?.(`openclaw gateway transient HTTP ${response.status}, retrying attempt ${attempt}/${maxAttempts}`);
    } catch (error) {
      lastError = error;
      if (!isRetryableGatewayError(error) || attempt === maxAttempts) {
        throw error;
      }
      logger.warn?.(`openclaw gateway transient failure, retrying attempt ${attempt}/${maxAttempts}: ${formatErrorMessage(error)}`);
    }

    if (attempt < maxAttempts && delayMs > 0) {
      await sleepImpl(delayMs);
    }
  }

  if (lastError) {
    throw lastError;
  }
  throw new Error('openclaw gateway request failed without a response');
}

function shouldRetryGatewayResponse(response) {
  const status = Number(response?.status) || 0;
  return status === 502 || status === 503 || status === 504;
}

function isRetryableGatewayError(error) {
  const message = formatErrorMessage(error).toLowerCase();
  return (
    message.includes('econnrefused') ||
    message.includes('econnreset') ||
    message.includes('socket hang up') ||
    message.includes('timed out') ||
    message.includes('timeout') ||
    message.includes('fetch failed')
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildOpenClawHeaders(config, payload) {
  const headers = {
    'Content-Type': 'application/json',
  };
  if (config.token) {
    headers.Authorization = `Bearer ${config.token}`;
  }
  if (config.modelOverride) {
    headers['x-openclaw-model'] = config.modelOverride;
  }
  headers['x-openclaw-message-channel'] = payload.channel || 'wechat';
  return headers;
}

async function executeToolCalls(toolCalls, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const logger = options.logger || console;
  const config = options.config || getOpenClawGatewayConfig(options.env);
  const results = [];

  for (const toolCall of toolCalls) {
    const functionName = toolCall.function?.name;
    const functionArgs = toolCall.function?.arguments;
    const toolCallId = toolCall.id;

    if (!functionName || !toolCallId) {
      logger.warn?.(`invalid tool call: missing name or id`);
      continue;
    }

    let args;
    try {
      args = JSON.parse(functionArgs || '{}');
    } catch {
      logger.warn?.(`failed to parse tool call arguments: ${functionArgs}`);
      args = {};
    }

    const backendBaseUrl = process.env.PYTHON_BACKEND_BASE_URL || 'http://127.0.0.1:8787';

    try {
      if (functionName === 'create_todo') {
        const response = await fetchImpl(`${backendBaseUrl}/tools/todo/create`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: args.text,
            source: 'openclaw_tool',
          }),
        });
        const result = await response.json();
        results.push({
          tool_call_id: toolCallId,
          output: result,
        });
        logger.info?.(`tool create_todo executed: ${args.text?.substring(0, 50)}`);
      } else if (functionName === 'list_todos') {
        const response = await fetchImpl(`${backendBaseUrl}/tools/todo/list`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        const result = await response.json();
        results.push({
          tool_call_id: toolCallId,
          output: result,
        });
        logger.info?.(`tool list_todos executed`);
      } else if (functionName === 'store_exploration_memory') {
        const response = await fetchImpl(`${backendBaseUrl}/tools/exploration/store`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            topic: args.topic,
            source: args.source || 'web_search',
            summary: args.summary,
            key_insights: args.key_insights || [],
            relevance_to_user: args.relevance_to_user || '',
          }),
        });
        const result = await response.json();
        results.push({
          tool_call_id: toolCallId,
          output: result,
        });
        logger.info?.(`tool store_exploration_memory executed: topic=${args.topic}`);
      } else if (functionName === 'generate_image') {
        const prompt = String(args.prompt || '').trim();
        if (!prompt) {
          throw new Error('generate_image requires prompt');
        }
        const generated = await generateImageWithQwen(prompt, {
          config,
          fetchImpl,
          logger,
          sleepImpl: options.sleepImpl,
        });
        results.push({
          tool_call_id: toolCallId,
          output: {
            kind: 'image',
            prompt,
            reply_text: generated.reply_text,
            media: generated.media,
            model: generated.model,
          },
        });
        logger.info?.('tool generate_image executed');
      } else if (functionName === 'generate_speech') {
        const text = String(args.text || args.prompt || '').trim();
        if (!text) {
          throw new Error('generate_speech requires text');
        }
        const generated = await generateSpeechWithQwenOmni(text, {
          config,
          fetchImpl,
          logger,
          env: options.env,
        });
        results.push({
          tool_call_id: toolCallId,
          output: {
            kind: 'speech',
            text,
            reply_text: generated.reply_text,
            media: generated.media,
            model: generated.model,
          },
        });
        logger.info?.('tool generate_speech executed');
      } else {
        logger.warn?.(`unknown tool: ${functionName}`);
        results.push({
          tool_call_id: toolCallId,
          output: { error: `unknown tool: ${functionName}` },
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error?.(`tool execution failed: ${functionName} - ${message}`);
      results.push({
        tool_call_id: toolCallId,
        output: { error: message },
      });
    }
  }

  return results;
}

function pickFirstGeneratedMedia(toolResults) {
  if (!Array.isArray(toolResults)) {
    return null;
  }
  for (const result of toolResults) {
    const media = normalizeOutgoingMedia(result?.output?.media);
    if (media) {
      return media;
    }
  }
  return null;
}

async function buildUserMessageContent(payload, options = {}) {
  const logger = options.logger || console;
  const content = [];
  const text = await buildPrimaryUserText(payload, options);
  if (text) {
    content.push({ type: 'text', text });
  }

  const mediaItems = normalizeMediaItems(payload.media);
  for (const imagePart of collectImageParts(payload, mediaItems, logger)) {
    content.push(imagePart);
  }

  const audioMediaItems = mediaItems.filter((item) => isAudioMedia(item));
  for (const audioPart of await collectAudioParts(audioMediaItems, {
    config: options.config,
    fetchImpl: options.fetchImpl,
    logger,
    useFallbackMediaText: options.useFallbackMediaText === true,
  })) {
    content.push(audioPart);
  }

  const videoMediaItems = mediaItems.filter((item) => isVideoMedia(item));
  for (const videoPart of await collectVideoParts(videoMediaItems, {
    logger,
    useFallbackMediaText: options.useFallbackMediaText === true,
  })) {
    content.push(videoPart);
  }

  if (content.length === 0 && mediaItems.length > 0) {
    content.push({ type: 'text', text: buildMediaFallbackText(mediaItems) });
  }

  return addBridgeTemporalContextToUserContent(content);
}

async function buildPrimaryUserText(payload, options = {}) {
  const batch = normalizeMessageBatch(payload.message_batch);
  const structuredUrlContext = await maybeBuildStructuredUrlContext(payload, options);
  if (batch.length > 1) {
    const lines = ['以下是同一会话里连续收到的多条微信消息，请按顺序整体理解：'];
    for (const item of batch) {
      const text = String(item.text || '').trim();
      if (text) {
        lines.push(`${item.index}. ${text}`);
      }
    }
    if (structuredUrlContext) {
      lines.push('');
      lines.push(structuredUrlContext);
    }
    return lines.join('\n');
  }
  const primaryText = String(payload.text || '').trim();
  if (!structuredUrlContext) {
    return primaryText;
  }
  return structuredUrlContext;
}

async function maybeBuildStructuredUrlContext(payload, options = {}) {
  const logger = options.logger || console;
  const urls = extractUrlsFromText(payload?.text || '');
  if (urls.length === 0) {
    return '';
  }

  const fetchImpl = options.fetchImpl || fetch;
  const results = [];
  for (const url of urls.slice(0, 2)) {
    const playwrightResult = await tryExtractStructuredContentWithPlaywright(url, options, logger);
    if (playwrightResult) {
      results.push(playwrightResult);
      continue;
    }
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: {
          'user-agent': 'Mozilla/5.0 OpenClawBridge/1.0',
        },
      });
      if (!response.ok) {
        continue;
      }
      const html = await response.text();
      const extracted = extractStructuredContentFromHtml(html, url);
      results.push({
        url,
        ...extracted,
      });
    } catch (error) {
      logger.warn?.(`structured url extraction failed url=${url} error=${formatErrorMessage(error)}`);
    }
  }
  const extractedImageUrls = collectExtractedImageUrls(results);
  if (extractedImageUrls.length > 0) {
    const existingUrls = Array.isArray(payload.image_urls) ? payload.image_urls : [];
    for (const url of extractedImageUrls) {
      if (!existingUrls.includes(url)) {
        existingUrls.push(url);
      }
    }
    payload.image_urls = existingUrls;
  }
  return buildStructuredUrlContext(payload, results);
}

async function tryExtractStructuredContentWithPlaywright(url, options = {}, logger = console) {
  if (
    typeof options.structuredContentExtractor !== 'function' &&
    !shouldUsePlaywrightStructuredExtraction(options.env || process.env)
  ) {
    return null;
  }
  const extractor = typeof options.structuredContentExtractor === 'function'
    ? options.structuredContentExtractor
    : extractStructuredContentFromUrlWithPlaywright;
  try {
    const extracted = await extractor(url, {
      browserFactory: options.playwrightBrowserFactory,
      timeoutMs: options.playwrightTimeoutMs,
    });
    const text = String(extracted?.text || '').trim();
    if (text.length < 120) {
      return null;
    }
    return {
      url,
      ...extracted,
    };
  } catch (error) {
    logger.warn?.(`playwright structured extraction failed url=${url} error=${formatErrorMessage(error)}`);
    return null;
  }
}

function normalizeMessageBatch(messageBatch) {
  if (!Array.isArray(messageBatch)) {
    return [];
  }
  return messageBatch
    .map((item, index) => ({
      index: Number.isFinite(Number(item?.index)) ? Number(item.index) : index + 1,
      text: String(item?.text || '').trim(),
    }))
    .filter((item) => item.text);
}

function shouldAllowTodoListing(text) {
  const normalized = String(text || '').trim();
  if (!normalized) {
    return false;
  }
  return /(?:待办|提醒|todo|有哪些事|还有什么没做|看看提醒|列出提醒)/i.test(normalized);
}

function shouldAllowExplorationMemoryTool(payload) {
  const routeHint = String(payload.route_hint || '').trim().toLowerCase();
  return routeHint === 'web_search';
}

function shouldPreferSegmentedReply(text) {
  const normalized = String(text || '').trim();
  if (!normalized) {
    return false;
  }
  return /(?:分[成为]?多条|分几条|分条发|一条一条发|别一次发完)/.test(normalized);
}

function buildWechatReplyEnvelope(replyText, payload) {
  const normalizedReply = String(replyText || '').trim();
  if (!normalizedReply) {
    return { reply_text: normalizedReply, follow_up_messages: [] };
  }
  if (!shouldPreferSegmentedReply(payload?.text)) {
    return { reply_text: normalizedReply, follow_up_messages: [] };
  }

  const segments = normalizedReply
    .split(WECHAT_REPLY_SEGMENT_MARKER)
    .map((item) => item.trim())
    .filter(Boolean);
  if (segments.length <= 1) {
    return { reply_text: normalizedReply, follow_up_messages: [] };
  }
  return {
    reply_text: segments[0],
    follow_up_messages: segments.slice(1),
  };
}

function normalizeOutgoingMedia(media) {
  if (!media || typeof media !== 'object' || Array.isArray(media)) {
    return null;
  }
  const type = typeof media.type === 'string' ? media.type.trim().toLowerCase() : '';
  const url = typeof media.url === 'string' ? media.url.trim() : '';
  const fileName = typeof media.fileName === 'string' ? media.fileName.trim() : '';
  if (!type || !url) {
    return null;
  }
  if (!['image', 'video', 'file', 'audio'].includes(type)) {
    return null;
  }
  return fileName ? { type, url, fileName } : { type, url };
}

function detectDirectMemoryRecallRequest(text) {
  const normalized = String(text || '').trim();
  if (!normalized) {
    return null;
  }
  if (normalized === '/breath') {
    return { kind: 'breath', query: '最近' };
  }
  if (normalized.startsWith('/breath ')) {
    return { kind: 'breath', query: normalized.slice(8).trim() || '最近' };
  }
  return null;
}

export async function generateImageWithQwen(prompt, options = {}) {
  const config = options.config || getOpenClawGatewayConfig(options.env);
  const fetchImpl = options.fetchImpl || fetch;
  const logger = options.logger || console;
  const sleepImpl = options.sleepImpl || sleep;
  if (!config.directApiToken) {
    throw new Error('image generation requires DASHSCOPE_API_KEY or QWEN_API_KEY');
  }
  const taskId = await createImageTask(prompt, {
    config,
    fetchImpl,
  });
  const taskResult = await pollImageTask(taskId, {
    config,
    fetchImpl,
    sleepImpl,
  });
  const imageUrl = extractGeneratedImageUrl(taskResult);
  if (!imageUrl) {
    throw new Error('qwen-image generation finished without image url');
  }
  logger.info?.(`qwen-image generated image task_id=${taskId}`);
  return {
    reply_text: '好，图给你生成好了。',
    media: {
      type: 'image',
      url: imageUrl,
    },
    model: config.imageModel,
  };
}

async function createImageTask(prompt, options = {}) {
  const config = options.config || {};
  const fetchImpl = options.fetchImpl || fetch;
  const response = await fetchImpl(`${config.directApiBaseUrl}/api/v1/services/aigc/text2image/image-synthesis`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.directApiToken}`,
      'Content-Type': 'application/json',
      'X-DashScope-Async': 'enable',
    },
    body: JSON.stringify({
      model: config.imageModel || 'qwen-image',
      input: { prompt },
      parameters: {
        n: 1,
        size: '1328*1328',
        watermark: false,
        prompt_extend: true,
        negative_prompt: ' ',
      },
    }),
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body?.message || body?.code || `image generation request failed: HTTP ${response.status}`);
  }
  const taskId = String(body?.output?.task_id || '').trim();
  if (!taskId) {
    throw new Error('image generation response missing task_id');
  }
  return taskId;
}

async function pollImageTask(taskId, options = {}) {
  const config = options.config || {};
  const fetchImpl = options.fetchImpl || fetch;
  const sleepImpl = options.sleepImpl || sleep;
  for (let attempt = 1; attempt <= IMAGE_TASK_POLL_MAX_ATTEMPTS; attempt += 1) {
    const response = await fetchImpl(`${config.directApiBaseUrl}/api/v1/tasks/${encodeURIComponent(taskId)}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${config.directApiToken}`,
      },
    });
    const body = await response.json();
    if (!response.ok) {
      throw new Error(body?.message || body?.code || `image task polling failed: HTTP ${response.status}`);
    }
    const taskStatus = String(body?.output?.task_status || '').trim().toUpperCase();
    if (taskStatus === 'SUCCEEDED') {
      return body;
    }
    if (taskStatus === 'FAILED' || taskStatus === 'CANCELED' || taskStatus === 'UNKNOWN') {
      throw new Error(body?.output?.message || `image task ${taskStatus.toLowerCase()}`);
    }
    await sleepImpl(IMAGE_TASK_POLL_DELAY_MS);
  }
  throw new Error('image task polling timed out');
}

function extractGeneratedImageUrl(body) {
  const choices = Array.isArray(body?.output?.results) ? body.output.results : [];
  if (choices.length > 0 && typeof choices[0]?.url === 'string' && choices[0].url.trim()) {
    return choices[0].url.trim();
  }
  const imageUrl = String(body?.output?.image_url || '').trim();
  if (imageUrl) {
    return imageUrl;
  }
  const nestedChoices = Array.isArray(body?.output?.choices) ? body.output.choices : [];
  const nestedUrl = String(nestedChoices[0]?.url || nestedChoices[0]?.image_url || '').trim();
  return nestedUrl;
}

export async function generateSpeechWithQwenOmni(prompt, options = {}) {
  const config = options.config || getOpenClawGatewayConfig(options.env);
  const fetchImpl = options.fetchImpl || fetch;
  const logger = options.logger || console;
  if (!config.directApiToken) {
    throw new Error('speech generation requires DASHSCOPE_API_KEY');
  }
  const response = await fetchImpl('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.directApiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.speechModel || 'qwen3-omni-flash',
      stream: true,
      stream_options: {
        include_usage: true,
      },
      extra_body: {
        enable_thinking: false,
      },
      modalities: ['text', 'audio'],
      audio: {
        voice: 'Cherry',
        format: 'wav',
      },
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: prompt }],
        },
      ],
    }),
  });
  if (!response.ok) {
    const body = await parseSpeechErrorResponse(response);
    throw new Error(body?.error?.message || body?.message || `speech generation failed: HTTP ${response.status}`);
  }
  const body = await parseSpeechGenerationResponse(response);
  const audioData = Array.isArray(body.audioData)
    ? body.audioData.map((item) => String(item || '').trim()).filter(Boolean)
    : String(body.audioData || '').trim();
  if ((Array.isArray(audioData) && audioData.length === 0) || (!Array.isArray(audioData) && !audioData)) {
    throw new Error('speech generation response missing audio data');
  }
  const outputPath = writeGeneratedAudioFile(audioData, {
    env: options.env,
    format: String(body.audioFormat || 'wav').trim() || 'wav',
  });
  logger.info?.(`qwen omni generated speech path=${outputPath}`);
  return {
    reply_text: body.replyText || '好，语音给你生成好了。',
    media: {
      type: 'audio',
      url: outputPath,
      fileName: path.basename(outputPath),
    },
    model: config.speechModel,
  };
}

async function parseSpeechErrorResponse(response) {
  try {
    return await response.json();
  } catch {
    try {
      return { message: await response.text() };
    } catch {
      return {};
    }
  }
}

async function parseSpeechGenerationResponse(response) {
  const contentType = String(response.headers?.get?.('content-type') || '').toLowerCase();
  if (!contentType.includes('text/event-stream')) {
    const body = await response.json();
    return {
      replyText: String(body?.choices?.[0]?.message?.content || '').trim(),
      audioData: String(body?.choices?.[0]?.message?.audio?.data || '').trim(),
      audioFormat: String(body?.choices?.[0]?.message?.audio?.format || 'wav').trim() || 'wav',
    };
  }

  const reader = response.body?.getReader?.();
  if (!reader) {
    throw new Error('speech generation response missing stream body');
  }

  const decoder = new TextDecoder();
  let rawBuffer = '';
  let replyText = '';
  const audioData = [];
  let audioFormat = 'wav';

  while (true) {
    const { done, value } = await reader.read();
    rawBuffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const segments = rawBuffer.split(/\r?\n\r?\n/);
    rawBuffer = segments.pop() || '';
    for (const segment of segments) {
      const parsedChunk = parseSseChunk(segment);
      if (!parsedChunk) {
        continue;
      }
      if (parsedChunk.done) {
        continue;
      }
      const delta = parsedChunk.payload?.choices?.[0]?.delta || {};
      if (typeof delta.content === 'string') {
        replyText += delta.content;
      }
      if (typeof delta.audio?.data === 'string') {
        audioData.push(delta.audio.data);
      }
      if (typeof delta.audio?.format === 'string' && delta.audio.format.trim()) {
        audioFormat = delta.audio.format.trim();
      }
    }
    if (done) {
      if (rawBuffer.trim()) {
        const parsedChunk = parseSseChunk(rawBuffer);
        if (parsedChunk?.payload) {
          const delta = parsedChunk.payload?.choices?.[0]?.delta || {};
          if (typeof delta.content === 'string') {
            replyText += delta.content;
          }
          if (typeof delta.audio?.data === 'string') {
            audioData.push(delta.audio.data);
          }
          if (typeof delta.audio?.format === 'string' && delta.audio.format.trim()) {
            audioFormat = delta.audio.format.trim();
          }
        }
      }
      break;
    }
  }

  return {
    replyText: replyText.trim(),
    audioData: audioData.map((item) => item.trim()).filter(Boolean),
    audioFormat,
  };
}

async function recallMemoryDirectly(query, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const backendBaseUrl = process.env.PYTHON_BACKEND_BASE_URL || 'http://127.0.0.1:8787';
  const response = await fetchImpl(`${backendBaseUrl}/tools/memory/recall`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      user_text: String(query || '').trim() || '最近',
      route: 'text_chat',
      response_mode: 'chat',
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const errorText = String(body?.error || '').trim() || `HTTP ${response.status}`;
    throw new Error(`memory recall failed: ${errorText}`);
  }
  const renderedContext = String(body?.rendered_context || '').trim();
  if (renderedContext) {
    return {
      reply_text: renderedContext,
      follow_up_messages: [],
    };
  }
  return {
    reply_text: '现在没有检索到可用的 Ombre 记忆。',
    follow_up_messages: [],
  };
}

function parseSseChunk(chunkText) {
  const dataLines = String(chunkText || '')
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim());
  if (dataLines.length === 0) {
    return null;
  }
  const data = dataLines.join('\n');
  if (data === '[DONE]') {
    return { done: true };
  }
  return {
    done: false,
    payload: JSON.parse(data),
  };
}

function writeGeneratedAudioFile(base64Data, options = {}) {
  const generatedDir = path.join(resolveStateDir(options.env), 'generated');
  fs.mkdirSync(generatedDir, { recursive: true });
  const filename = `wechat-audio-${Date.now()}.wav`;
  const outputPath = path.join(generatedDir, filename);
  const sourceBuffer = decodeGeneratedAudioBase64(base64Data);
  const outputBuffer = normalizeGeneratedAudioBuffer(sourceBuffer, options.format);
  fs.writeFileSync(outputPath, outputBuffer);
  return outputPath;
}

function decodeGeneratedAudioBase64(base64Data) {
  const chunks = Array.isArray(base64Data)
    ? base64Data.map((item) => String(item || '').trim()).filter(Boolean)
    : [String(base64Data || '').trim()].filter(Boolean);
  if (chunks.length === 0) {
    return Buffer.alloc(0);
  }
  if (chunks.length === 1) {
    return Buffer.from(chunks[0], 'base64');
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk, 'base64')));
}

function normalizeGeneratedAudioBuffer(buffer, format = 'wav') {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('speech generation response missing audio data');
  }

  if (isWavBuffer(buffer)) {
    return buffer;
  }

  const normalizedFormat = String(format || '').trim().toLowerCase();
  if (normalizedFormat === 'wav' || normalizedFormat === 'pcm' || normalizedFormat === 'pcm_s16le' || normalizedFormat === 'raw') {
    return pcmBytesToWav(buffer, GENERATED_AUDIO_SAMPLE_RATE);
  }

  return pcmBytesToWav(buffer, GENERATED_AUDIO_SAMPLE_RATE);
}

function isWavBuffer(buffer) {
  return Buffer.isBuffer(buffer)
    && buffer.length >= 12
    && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
    && buffer.subarray(8, 12).toString('ascii') === 'WAVE';
}

function pcmBytesToWav(pcm, sampleRate) {
  const pcmBytes = pcm.byteLength;
  const totalSize = 44 + pcmBytes;
  const buf = Buffer.allocUnsafe(totalSize);
  let offset = 0;
  buf.write('RIFF', offset);
  offset += 4;
  buf.writeUInt32LE(totalSize - 8, offset);
  offset += 4;
  buf.write('WAVE', offset);
  offset += 4;
  buf.write('fmt ', offset);
  offset += 4;
  buf.writeUInt32LE(16, offset);
  offset += 4;
  buf.writeUInt16LE(1, offset);
  offset += 2;
  buf.writeUInt16LE(1, offset);
  offset += 2;
  buf.writeUInt32LE(sampleRate, offset);
  offset += 4;
  buf.writeUInt32LE(sampleRate * 2, offset);
  offset += 4;
  buf.writeUInt16LE(2, offset);
  offset += 2;
  buf.writeUInt16LE(16, offset);
  offset += 2;
  buf.write('data', offset);
  offset += 4;
  buf.writeUInt32LE(pcmBytes, offset);
  offset += 4;
  Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).copy(buf, offset);
  return buf;
}

function serializeUserContent(content, payload) {
  if (content.length === 0) {
    return String(payload.text || '');
  }
  if (content.length === 1 && content[0].type === 'text') {
    return content[0].text;
  }
  return content;
}

function collectImageParts(payload, mediaItems, logger = console) {
  const parts = [];

  for (const media of mediaItems) {
    const normalizedImageUrl = toGatewayImageUrl(media, logger);
    if (!normalizedImageUrl) {
      continue;
    }
    parts.push({
      type: 'image_url',
      image_url: { url: normalizedImageUrl },
    });
  }

  for (const imageUrl of Array.isArray(payload.image_urls) ? payload.image_urls : []) {
    if (typeof imageUrl !== 'string' || !imageUrl.trim()) {
      continue;
    }
    const trimmed = imageUrl.trim();
    if (isRemoteOrDataImageUrl(trimmed)) {
      parts.push({ type: 'image_url', image_url: { url: trimmed } });
      continue;
    }
    if (mediaItems.some((item) => item.filePath === trimmed)) {
      continue;
    }
    const normalizedImageUrl = toGatewayImageUrl(trimmed, logger);
    if (!normalizedImageUrl) {
      continue;
    }
    parts.push({
      type: 'image_url',
      image_url: { url: normalizedImageUrl },
    });
  }

  return uniqueImageParts(parts);
}

async function collectAudioParts(audioMediaItems, options = {}) {
  const parts = [];
  for (const media of audioMediaItems) {
    if (!options.useFallbackMediaText) {
      const inputAudioPart = toGatewayInputAudioPart(media, options.logger || console);
      if (inputAudioPart) {
        parts.push(inputAudioPart);
        continue;
      }
    }

    const transcript = await transcribeAudioMedia(media, options);
    const text = buildAudioFallbackText(media, transcript);
    if (text) {
      parts.push({ type: 'text', text });
    }
  }
  return parts;
}

async function collectVideoParts(videoMediaItems, options = {}) {
  const parts = [];
  for (const media of videoMediaItems) {
    if (!options.useFallbackMediaText) {
      const videoPart = toGatewayVideoPart(media, options.logger || console);
      if (videoPart) {
        parts.push(videoPart);
        continue;
      }
    }

    const fallbackParts = await buildVideoFallbackParts(media, options);
    parts.push(...fallbackParts);
  }
  return parts;
}

function uniqueImageParts(parts) {
  const unique = [];
  for (const part of parts) {
    const url = part?.image_url?.url;
    if (typeof url !== 'string' || !url.trim()) {
      continue;
    }
    if (!unique.some((existing) => existing.image_url.url === url)) {
      unique.push(part);
    }
  }
  return unique;
}

function toGatewayImageUrl(imageRef, logger = console) {
  if (!imageRef) {
    return '';
  }
  if (typeof imageRef === 'object' && imageRef !== null) {
    return toGatewayImageUrlFromMedia(imageRef, logger);
  }
  if (typeof imageRef !== 'string') {
    return '';
  }
  const trimmed = imageRef.trim();
  if (!trimmed) {
    return '';
  }
  if (isRemoteOrDataImageUrl(trimmed)) {
    return trimmed;
  }

  const mimeType = inferMimeTypeFromPath(trimmed, 'image');
  if (!mimeType) {
    logger.warn?.(`skip local image ref without supported image mime: ${trimmed}`);
    return '';
  }
  return toGatewayDataUri(trimmed, mimeType, logger, 'image');
}

function toGatewayImageUrlFromMedia(media, logger = console) {
  const filePath = typeof media.filePath === 'string' ? media.filePath.trim() : '';
  if (!filePath) {
    return '';
  }
  if (isRemoteOrDataImageUrl(filePath)) {
    return filePath;
  }
  if (!isImageMedia(media)) {
    return '';
  }
  const mimeType = resolveMediaMimeType(media, 'image');
  if (!mimeType) {
    logger.warn?.(`skip image media without supported mimeType: ${filePath}`);
    return '';
  }
  return toGatewayDataUri(filePath, mimeType, logger, 'image');
}

function toGatewayInputAudioPart(media, logger = console) {
  const filePath = typeof media.filePath === 'string' ? media.filePath.trim() : '';
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    logger.warn?.(`skip missing audio file ref: ${filePath}`);
    return null;
  }
  if (fs.statSync(filePath).size > INLINE_MEDIA_BYTE_LIMIT) {
    logger.warn?.(`skip oversized audio file ref: ${filePath}`);
    return null;
  }
  const mimeType = resolveMediaMimeType(media, 'audio');
  const format = resolveInputAudioFormat(mimeType, filePath);
  if (!format) {
    return null;
  }
  const base64 = fs.readFileSync(filePath).toString('base64');
  return {
    type: 'input_audio',
    input_audio: {
      data: base64,
      format,
    },
  };
}

function toGatewayVideoPart(media, logger = console) {
  const filePath = typeof media.filePath === 'string' ? media.filePath.trim() : '';
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    logger.warn?.(`skip missing video file ref: ${filePath}`);
    return null;
  }
  if (fs.statSync(filePath).size > INLINE_MEDIA_BYTE_LIMIT) {
    logger.warn?.(`skip oversized video file ref: ${filePath}`);
    return null;
  }
  const mimeType = resolveMediaMimeType(media, 'video');
  if (!mimeType) {
    logger.warn?.(`skip video media without supported mimeType: ${filePath}`);
    return null;
  }
  return {
    type: 'video_url',
    video_url: { url: toGatewayDataUri(filePath, mimeType, logger, 'video') },
  };
}

async function buildVideoFallbackParts(media, options = {}) {
  const logger = options.logger || console;
  const filePath = typeof media.filePath === 'string' ? media.filePath.trim() : '';
  const parts = [];
  const keyframePart = await maybeExtractVideoKeyframePart(filePath, logger);
  if (keyframePart) {
    parts.push(keyframePart);
  }

  const fallbackText = buildVideoFallbackText(media, keyframePart ? ' 已提取关键帧并附加给模型。' : '');
  if (fallbackText) {
    parts.push({ type: 'text', text: fallbackText });
  }
  return parts;
}

async function maybeExtractVideoKeyframePart(filePath, logger = console) {
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return null;
  }
  if (!isExecutableAvailable('ffmpeg')) {
    return null;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-bridge-video-'));
  const framePath = path.join(tempDir, 'frame.jpg');
  try {
    const result = spawnSync(
      'ffmpeg',
      ['-y', '-i', filePath, '-vf', 'select=eq(n\\,0)', '-vframes', '1', framePath],
      { stdio: 'ignore' }
    );
    if (result.status !== 0 || !fs.existsSync(framePath) || !fs.statSync(framePath).isFile()) {
      return null;
    }
    const base64 = fs.readFileSync(framePath).toString('base64');
    return {
      type: 'image_url',
      image_url: { url: `data:image/jpeg;base64,${base64}` },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn?.(`video keyframe extraction failed: ${message}`);
    return null;
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

function transcribeAudioMedia(media, options = {}) {
  const config = options.config || getOpenClawGatewayConfig(options.env);
  const fetchImpl = options.fetchImpl || fetch;
  const logger = options.logger || console;
  const filePath = typeof media.filePath === 'string' ? media.filePath.trim() : '';
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    logger.warn?.(`skip missing audio file ref for transcription: ${filePath}`);
    return Promise.resolve('');
  }

  const mimeType = resolveMediaMimeType(media, 'audio') || 'application/octet-stream';
  const fileName = path.basename(filePath);
  const { body, contentType } = buildMultipartFormBody([
    {
      name: 'file',
      filename: fileName,
      contentType: mimeType,
      data: fs.readFileSync(filePath),
    },
    {
      name: 'model',
      data: Buffer.from(config.audioModel || 'whisper-1', 'utf8'),
    },
  ]);

  const headers = {};
  if (config.token) {
    headers.Authorization = `Bearer ${config.token}`;
  }
  headers['Content-Type'] = contentType;

  return fetchImpl(`${config.baseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers,
    body,
  })
    .then(async (response) => {
      let body;
      try {
        body = await response.json();
      } catch {
        logger.warn?.('audio transcription returned invalid JSON');
        return '';
      }

      if (!response.ok) {
        const errorText = typeof body?.error === 'string'
          ? body.error
          : typeof body?.error?.message === 'string'
            ? body.error.message
            : `HTTP ${response.status}`;
        logger.warn?.(`audio transcription error: ${errorText}`);
        return '';
      }

      return typeof body?.text === 'string' ? body.text.trim() : '';
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn?.(`audio transcription request failed: ${message}`);
      return '';
    });
}

function buildMultipartFormBody(parts) {
  const boundary = `----openclaw-${Math.random().toString(16).slice(2)}`;
  const chunks = [];

  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`, 'utf8'));

    if (part.filename) {
      chunks.push(Buffer.from(
        `Content-Disposition: form-data; name="${escapeMultipartValue(part.name)}"; filename="${escapeMultipartValue(part.filename)}"\r\n` +
        `Content-Type: ${String(part.contentType || 'application/octet-stream')}\r\n\r\n`,
        'utf8'
      ));
      chunks.push(Buffer.isBuffer(part.data) ? part.data : Buffer.from(part.data || ''));
      chunks.push(Buffer.from('\r\n', 'utf8'));
      continue;
    }

    chunks.push(Buffer.from(
      `Content-Disposition: form-data; name="${escapeMultipartValue(part.name)}"\r\n\r\n`,
      'utf8'
    ));
    chunks.push(Buffer.isBuffer(part.data) ? part.data : Buffer.from(String(part.data || ''), 'utf8'));
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }

  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function escapeMultipartValue(value) {
  return String(value || '').replace(/["\\]/g, '\\$&');
}

function resolveMediaMimeType(media, kind = '') {
  const filePath = typeof media?.filePath === 'string' ? media.filePath : '';
  const rawMime = typeof media?.mimeType === 'string' ? media.mimeType.trim().toLowerCase() : '';
  if (rawMime) {
    if (isWildcardMimeType(rawMime, kind)) {
      const detectedFromHeader = detectMimeTypeFromFileHeader(filePath, kind);
      if (detectedFromHeader) {
        return detectedFromHeader;
      }
    }
    if (!kind) {
      return rawMime;
    }
    if (kind === 'image' && rawMime.startsWith('image/')) {
      return rawMime;
    }
    if (kind === 'audio' && rawMime.startsWith('audio/')) {
      return rawMime;
    }
    if (kind === 'video' && rawMime.startsWith('video/')) {
      return rawMime;
    }
  }

  return inferMimeTypeFromPath(filePath, kind) || '';
}

function inferMimeTypeFromPath(filePath, kind = '') {
  const extension = path.extname(String(filePath || '')).trim().toLowerCase();
  const imageMimeByExt = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.avif': 'image/avif',
    '.heic': 'image/heic',
  };
  const audioMimeByExt = {
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.oga': 'audio/ogg',
    '.webm': 'audio/webm',
    '.flac': 'audio/flac',
  };
  const videoMimeByExt = {
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.webm': 'video/webm',
    '.mkv': 'video/x-matroska',
    '.avi': 'video/x-msvideo',
    '.m4v': 'video/mp4',
  };

  if (kind === 'image') {
    return imageMimeByExt[extension] || '';
  }
  if (kind === 'audio') {
    return audioMimeByExt[extension] || '';
  }
  if (kind === 'video') {
    return videoMimeByExt[extension] || '';
  }
  return imageMimeByExt[extension] || audioMimeByExt[extension] || videoMimeByExt[extension] || '';
}

function isWildcardMimeType(rawMime, kind = '') {
  if (!rawMime || !rawMime.endsWith('/*')) {
    return false;
  }
  if (!kind) {
    return true;
  }
  return rawMime === `${kind}/*`;
}

function detectMimeTypeFromFileHeader(filePath, kind = '') {
  const header = readFileHeader(filePath, 64);
  if (header.length === 0) {
    return '';
  }
  const detected = detectMimeTypeFromBuffer(header);
  if (!detected) {
    return '';
  }
  if (kind && !detected.startsWith(`${kind}/`)) {
    return '';
  }
  return detected;
}

function readFileHeader(filePath, maxBytes = 64) {
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return Buffer.alloc(0);
  }

  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(maxBytes);
    const bytesRead = fs.readSync(fd, buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead);
  } catch {
    return Buffer.alloc(0);
  } finally {
    if (typeof fd === 'number') {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore close errors
      }
    }
  }
}

function detectMimeTypeFromBuffer(buffer) {
  if (!buffer || buffer.length < 2) {
    return '';
  }

  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    buffer.length >= 8
    && buffer[0] === 0x89
    && buffer[1] === 0x50
    && buffer[2] === 0x4e
    && buffer[3] === 0x47
    && buffer[4] === 0x0d
    && buffer[5] === 0x0a
    && buffer[6] === 0x1a
    && buffer[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (
    buffer.length >= 6
    && buffer[0] === 0x47
    && buffer[1] === 0x49
    && buffer[2] === 0x46
    && buffer[3] === 0x38
    && (buffer[4] === 0x37 || buffer[4] === 0x39)
    && buffer[5] === 0x61
  ) {
    return 'image/gif';
  }
  if (
    buffer.length >= 12
    && buffer[0] === 0x52
    && buffer[1] === 0x49
    && buffer[2] === 0x46
    && buffer[3] === 0x46
    && buffer[8] === 0x57
    && buffer[9] === 0x45
    && buffer[10] === 0x42
    && buffer[11] === 0x50
  ) {
    return 'image/webp';
  }
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return 'image/bmp';
  }
  if (
    buffer.length >= 12
    && buffer[4] === 0x66
    && buffer[5] === 0x74
    && buffer[6] === 0x79
    && buffer[7] === 0x70
  ) {
    const brand = buffer.subarray(8, 12).toString('ascii').toLowerCase();
    if (brand === 'avif' || brand === 'avis') {
      return 'image/avif';
    }
    if (brand === 'heic' || brand === 'heix' || brand === 'hevc' || brand === 'hevx') {
      return 'image/heic';
    }
    if (brand === 'mif1' || brand === 'msf1') {
      return 'image/heif';
    }
  }
  return '';
}

function resolveInputAudioFormat(mimeType, filePath) {
  const normalized = String(mimeType || '').toLowerCase();
  if (normalized.startsWith('audio/wav') || normalized === 'audio/x-wav') {
    return 'wav';
  }
  if (normalized.startsWith('audio/mpeg') || normalized.startsWith('audio/mp3') || normalized === 'audio/mpeg3') {
    return 'mp3';
  }
  const extension = path.extname(String(filePath || '')).trim().toLowerCase();
  if (extension === '.wav') {
    return 'wav';
  }
  if (extension === '.mp3') {
    return 'mp3';
  }
  return '';
}

function toGatewayDataUri(filePath, mimeType, logger = console, kind = 'media') {
  if (!filePath || !mimeType) {
    return '';
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    logger.warn?.(`skip missing ${kind} file ref: ${filePath}`);
    return '';
  }
  if (fs.statSync(filePath).size > INLINE_MEDIA_BYTE_LIMIT) {
    logger.warn?.(`skip oversized ${kind} file ref: ${filePath}`);
    return '';
  }
  const base64 = fs.readFileSync(filePath).toString('base64');
  return `data:${mimeType};base64,${base64}`;
}

function isExecutableAvailable(command) {
  const result = spawnSync(command, ['-version'], { stdio: 'ignore' });
  return !result.error && result.status === 0;
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

function isImageMedia(media) {
  if (!media || typeof media !== 'object') {
    return false;
  }
  const mimeType = resolveMediaMimeType(media, 'image');
  if (typeof mimeType === 'string' && mimeType.startsWith('image/')) {
    return true;
  }
  if (typeof media.type === 'string') {
    const normalizedType = media.type.trim().toLowerCase();
    return normalizedType === 'image' || normalizedType === 'pic' || normalizedType === 'photo';
  }
  return false;
}

function isAudioMedia(media) {
  if (!media || typeof media !== 'object') {
    return false;
  }
  const mimeType = resolveMediaMimeType(media, 'audio');
  if (typeof mimeType === 'string' && mimeType.startsWith('audio/')) {
    return true;
  }
  if (typeof media.type === 'string') {
    const normalizedType = media.type.trim().toLowerCase();
    return normalizedType === 'audio' || normalizedType === 'voice' || normalizedType === 'audio_message';
  }
  return false;
}

function isVideoMedia(media) {
  if (!media || typeof media !== 'object') {
    return false;
  }
  const mimeType = resolveMediaMimeType(media, 'video');
  if (typeof mimeType === 'string' && mimeType.startsWith('video/')) {
    return true;
  }
  if (typeof media.type === 'string') {
    const normalizedType = media.type.trim().toLowerCase();
    return normalizedType === 'video' || normalizedType === 'movie' || normalizedType === 'clip';
  }
  return false;
}

function isRemoteOrDataImageUrl(value) {
  return /^https?:\/\//i.test(value) || /^data:image\//i.test(value);
}

function isRemoteHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || '').trim());
}

function hasFallbackableMedia(payload) {
  const mediaItems = normalizeMediaItems(payload.media);
  if (mediaItems.some((item) => isAudioMedia(item) || isVideoMedia(item))) {
    return true;
  }
  for (const imageUrl of Array.isArray(payload.image_urls) ? payload.image_urls : []) {
    if (typeof imageUrl === 'string' && imageUrl.trim() && !isRemoteOrDataImageUrl(imageUrl.trim())) {
      return true;
    }
  }
  return false;
}

function buildMediaFallbackText(mediaItems) {
  if (!Array.isArray(mediaItems) || mediaItems.length === 0) {
    return '';
  }
  const kinds = [];
  for (const item of mediaItems) {
    if (isImageMedia(item)) {
      kinds.push('图片');
    } else if (isAudioMedia(item)) {
      kinds.push('音频');
    } else if (isVideoMedia(item)) {
      kinds.push('视频');
    } else {
      kinds.push('媒体');
    }
  }
  return `收到${uniqueStrings(kinds).join('、')}消息，当前暂无法直接处理，请补充文字说明。`;
}

function buildAudioFallbackText(media, transcript) {
  const filePath = typeof media.filePath === 'string' ? path.basename(media.filePath.trim()) : '';
  const text = typeof transcript === 'string' ? transcript.trim() : '';
  if (text) {
    return filePath ? `【音频转写:${filePath}】${text}` : `【音频转写】${text}`;
  }
  return filePath ? `收到音频消息：${filePath}。当前暂无法直接转写，请补充文字说明。` : '收到音频消息，当前暂无法直接转写，请补充文字说明。';
}

function buildVideoFallbackText(media, extra = '') {
  const filePath = typeof media.filePath === 'string' ? media.filePath.trim() : '';
  const fileName = filePath ? path.basename(filePath) : '';
  const mimeType = resolveMediaMimeType(media, 'video');
  const sizeText = getReadableFileSize(filePath);
  const details = [fileName, mimeType || '', sizeText].filter(Boolean).join(' / ');
  const prefix = details ? `【视频信息:${details}】` : '【视频信息】';
  const suffix = String(extra || '').trim();
  return suffix ? `${prefix}请结合视频内容理解。${suffix}` : `${prefix}请结合视频内容理解。`;
}

function getReadableFileSize(filePath) {
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return '';
  }
  const bytes = fs.statSync(filePath).size;
  if (bytes < 1024) {
    return `${bytes}B`;
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)}KB`;
  }
  return `${Math.round(bytes / (1024 * 1024))}MB`;
}

function formatErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function uniqueStrings(values) {
  const unique = [];
  for (const value of values) {
    if (typeof value !== 'string' || !value.trim()) {
      continue;
    }
    const trimmed = value.trim();
    if (!unique.includes(trimmed)) {
      unique.push(trimmed);
    }
  }
  return unique;
}
