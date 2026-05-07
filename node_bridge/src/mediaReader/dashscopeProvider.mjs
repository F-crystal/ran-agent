import fs from 'node:fs';
import path from 'node:path';
import { MediaReaderError } from './assetResolver.mjs';

const DEFAULT_COMPAT_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const DEFAULT_OCR_MODEL = 'qwen-vl-ocr-2025-11-20';
const DEFAULT_VISION_MODEL = 'qwen3-vl-flash';
const DEFAULT_ASR_MODEL = 'qwen3-asr-flash';

function normalizeCompatibleBaseUrl(raw) {
  const value = String(raw || '').trim().replace(/\/$/, '');
  if (!value) {
    return DEFAULT_COMPAT_BASE_URL;
  }
  if (value.endsWith('/chat/completions')) {
    return value.slice(0, -'/chat/completions'.length);
  }
  if (value.endsWith('/compatible-mode/v1')) {
    return value;
  }
  if (value.endsWith('/api/v1')) {
    return `${value.slice(0, -'/api/v1'.length)}/compatible-mode/v1`;
  }
  return `${value}/compatible-mode/v1`;
}

export function dashScopeToken(env = process.env) {
  return String(
    env.PERSONAL_AGENT_DASHSCOPE_API_KEY
    || env.DASHSCOPE_API_KEY
    || env.QWEN_API_KEY
    || ''
  ).trim();
}

export function resolveDashScopeConfig(env = process.env) {
  const baseUrl = normalizeCompatibleBaseUrl(
    env.PERSONAL_AGENT_DASHSCOPE_COMPAT_BASE_URL
    || env.DASHSCOPE_COMPAT_BASE_URL
    || env.DASHSCOPE_BASE_URL
  );
  return {
    token: dashScopeToken(env),
    baseUrl,
    endpoint: `${baseUrl}/chat/completions`,
    ocrModel: String(env.PERSONAL_AGENT_OCR_MODEL || DEFAULT_OCR_MODEL).trim(),
    visionModel: String(env.PERSONAL_AGENT_VISION_MODEL || DEFAULT_VISION_MODEL).trim(),
    asrModel: String(env.PERSONAL_AGENT_ASR_MODEL || DEFAULT_ASR_MODEL).trim(),
  };
}

export function isDashScopeProvider(provider, env = process.env) {
  const value = String(provider || '').trim().toLowerCase();
  return value === 'dashscope'
    || value === 'dashscope-qwen-vl'
    || value === 'dashscope-qwen-vl-ocr'
    || value === 'dashscope-asr'
    || (!value && Boolean(dashScopeToken(env)));
}

function mimeForAsset(asset) {
  const mime = String(asset?.mime || '').split(';')[0].trim().toLowerCase();
  if (mime) {
    return mime;
  }
  const ext = path.extname(String(asset?.file_path || '')).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.wav') return 'audio/wav';
  if (ext === '.mp3') return 'audio/mpeg';
  if (ext === '.m4a') return 'audio/mp4';
  if (ext === '.mp4') return 'video/mp4';
  return 'application/octet-stream';
}

function dataUrlForAsset(asset) {
  const filePath = String(asset?.file_path || '').trim();
  if (!filePath) {
    throw new MediaReaderError('DOWNLOAD_FAILED', 'DOWNLOAD_FAILED: downloaded media file path is missing');
  }
  const bytes = fs.readFileSync(filePath);
  return `data:${mimeForAsset(asset)};base64,${bytes.toString('base64')}`;
}

function extractMessageContent(body) {
  const message = body?.choices?.[0]?.message;
  const content = message?.content;
  if (typeof content === 'string') {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => typeof item?.text === 'string' ? item.text : '')
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  return '';
}

function parseJsonContent(text) {
  const raw = String(text || '').trim();
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        return {};
      }
    }
  }
  return {};
}

async function chatCompletion({ asset, model, content, env, fetchImpl, errorCode }) {
  const config = resolveDashScopeConfig(env);
  if (!config.token) {
    throw new MediaReaderError('PROVIDER_NOT_CONFIGURED', 'PROVIDER_NOT_CONFIGURED: DASHSCOPE_API_KEY or QWEN_API_KEY is not configured');
  }
  const response = await fetchImpl(config.endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content }],
      stream: false,
    }),
  });
  let body = {};
  try {
    body = await response.json();
  } catch {
    body = {};
  }
  if (!response.ok) {
    throw new MediaReaderError(errorCode, `${errorCode}: ${body?.message || body?.error?.message || body?.code || `HTTP ${response.status}`}`, {
      url_host: asset?.url_host || '',
    });
  }
  const text = extractMessageContent(body);
  if (!text) {
    throw new MediaReaderError(errorCode, `${errorCode}: empty DashScope response`, {
      url_host: asset?.url_host || '',
    });
  }
  return text;
}

export async function analyzeImageOcrWithDashScope(asset, options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || fetch;
  const config = resolveDashScopeConfig(env);
  const text = await chatCompletion({
    asset,
    model: config.ocrModel,
    env,
    fetchImpl,
    errorCode: 'OCR_FAILED',
    content: [
      { type: 'image_url', image_url: { url: dataUrlForAsset(asset) } },
      {
        type: 'text',
        text: [
          '请识别图片中所有可见文字。',
          '只返回 JSON，不要返回 Markdown。',
          '{"text":"完整文字，按自然阅读顺序合并","blocks":[{"text":"单个文字块"}]}',
        ].join('\n'),
      },
    ],
  });
  const parsed = parseJsonContent(text);
  const ocrText = String(parsed.text || text || '').trim();
  const blocks = Array.isArray(parsed.blocks)
    ? parsed.blocks.map((block) => typeof block === 'string' ? { text: block } : block)
    : (ocrText ? [{ text: ocrText }] : []);
  return {
    text: ocrText,
    blocks,
    model: config.ocrModel,
  };
}

export async function analyzeImageVisionWithDashScope(asset, options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || fetch;
  const config = resolveDashScopeConfig(env);
  const prompt = String(options.prompt || options.args?.prompt || '').trim();
  const text = await chatCompletion({
    asset,
    model: config.visionModel,
    env,
    fetchImpl,
    errorCode: 'VLM_FAILED',
    content: [
      { type: 'image_url', image_url: { url: dataUrlForAsset(asset) } },
      {
        type: 'text',
        text: [
          prompt || '请用中文简洁理解这张图片，重点说明画面主体、场景、动作、重要文字和可能的上下文。',
          '只返回 JSON，不要返回 Markdown。',
          '{"summary":"图片内容摘要","objects":["关键对象1","关键对象2"]}',
        ].join('\n'),
      },
    ],
  });
  const parsed = parseJsonContent(text);
  return {
    summary: String(parsed.summary || text || '').trim(),
    objects: Array.isArray(parsed.objects) ? parsed.objects.map((item) => String(item)) : [],
    model: config.visionModel,
  };
}

export async function transcribeAudioWithDashScope(asset, options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || fetch;
  const config = resolveDashScopeConfig(env);
  const languageHint = String(options.args?.language_hint || options.language_hint || env.PERSONAL_AGENT_ASR_LANGUAGE || 'zh').trim();
  const text = await chatCompletion({
    asset,
    model: config.asrModel,
    env,
    fetchImpl,
    errorCode: 'ASR_FAILED',
    content: [
      {
        type: 'input_audio',
        input_audio: {
          data: dataUrlForAsset(asset),
        },
      },
      {
        type: 'text',
        text: `请转写这段音频。语言提示：${languageHint}。只返回转写文本。`,
      },
    ],
  });
  return {
    transcript: text,
    segments: [],
    language: languageHint,
    model: config.asrModel,
  };
}
