#!/usr/bin/env node
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { buildMediaAssets, hostFromUrl, redactUrl } from './mediaReader/assetResolver.mjs';

// Default Puppeteer executable path for xhs-mcp backend (use system Chromium)
if (!process.env.PUPPETEER_EXECUTABLE_PATH) {
  process.env.PUPPETEER_EXECUTABLE_PATH = '/snap/bin/chromium';
}
if (!process.env.PUPPETEER_SKIP_DOWNLOAD) {
  process.env.PUPPETEER_SKIP_DOWNLOAD = 'true';
}

const SERVER_INFO = {
  name: 'ran-agent-social-reader',
  version: '0.1.0',
};

const DEFAULT_TIMEOUT_MS = 90000;
const DEFAULT_MAX_COMMENTS = 30;
const MAX_COMMENTS_CAP = 100;
const XHS_MAX_REDIRECTS = 5;
const BROWSER_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const XHS_ALLOWED_HOSTS = new Set([
  'xhslink.com',
  'xiaohongshu.com',
  'www.xiaohongshu.com',
  'm.xiaohongshu.com',
]);

const PLATFORM_HOSTS = [
  ['xhs', ['xiaohongshu.com', 'xhslink.com', 'rednote.com']],
  ['douyin', ['douyin.com', 'iesdouyin.com']],
  ['kuaishou', ['kuaishou.com', 'gifshow.com']],
  ['bilibili', ['bilibili.com', 'b23.tv']],
  ['wechat_article', ['mp.weixin.qq.com']],
  ['netease_music', ['music.163.com', 'y.music.163.com', '163cn.tv']],
  ['weibo', ['weibo.com', 'weibo.cn']],
  ['zhihu', ['zhihu.com']],
];
// Internal cache for note_id -> xsecToken mapping (never exposed to users)
const xhsNoteTokenCache = new Map();
const XHS_NOTE_TOKEN_CACHE_MAX_SIZE = 1000;
let xhsNoteTokenCacheLoaded = false;

function shouldExposeXhsBrowseTools(env = process.env) {
  return String(env.SOCIAL_READER_EXPOSE_XHS_BROWSE_TOOLS || '').trim().toLowerCase() === 'true';
}

function resolveXhsNoteTokenCachePath(env = process.env) {
  const configured = String(env.XHS_NOTE_TOKEN_CACHE_PATH || '').trim();
  if (configured) {
    return path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), configured);
  }
  return path.resolve(process.cwd(), '.ran_agent_state/social_reader/xhs-note-token-cache.json');
}

function loadXhsNoteTokenCache(env = process.env) {
  if (xhsNoteTokenCacheLoaded) return;
  xhsNoteTokenCacheLoaded = true;
  const filePath = resolveXhsNoteTokenCachePath(env);
  try {
    const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const entries = payload && typeof payload === 'object' ? payload.entries || payload : {};
    for (const [noteId, entry] of Object.entries(entries)) {
      if (noteId && entry && typeof entry === 'object') {
        xhsNoteTokenCache.set(noteId, entry);
      }
    }
  } catch {
    // Cache is best-effort state; missing or invalid files should not break reading.
  }
}

function persistXhsNoteTokenCache(env = process.env) {
  const filePath = resolveXhsNoteTokenCachePath(env);
  const debug = String(env.XHS_NOTE_TOKEN_CACHE_DEBUG || '').trim() === '1';
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const entries = Object.fromEntries(xhsNoteTokenCache.entries());
    fs.writeFileSync(filePath, `${JSON.stringify({ entries }, null, 2)}\n`, { mode: 0o600 });
    if (debug) {
      console.error(`[xhs-cache] persisted ${xhsNoteTokenCache.size} entries to ${filePath}`);
    }
  } catch (error) {
    if (debug) {
      console.error(`[xhs-cache] persist failed: ${filePath} error=${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function buildXhsCanonicalUrl(noteId, xsecToken = '', xsecSource = '') {
  if (!noteId) return '';
  const canonical = new URL(`https://www.xiaohongshu.com/explore/${noteId}`);
  if (xsecToken) canonical.searchParams.set('xsec_token', xsecToken);
  if (xsecSource) canonical.searchParams.set('xsec_source', xsecSource);
  return canonical.toString();
}

function normalizeXhsCanonicalUrl(noteId, candidateUrl = '', xsecToken = '', xsecSource = '') {
  if (!noteId) return '';
  const info = candidateUrl ? parseXhsUrlInfo(candidateUrl) : null;
  const token = xsecToken || info?.xsec_token || '';
  const source = xsecSource || info?.xsec_source || '';
  return buildXhsCanonicalUrl(noteId, token, source);
}

function cacheXhsNoteToken(noteId, xsecToken = '', metadata = {}, options = {}) {
  if (!noteId) return;
  const env = options.env || process.env;
  loadXhsNoteTokenCache(env);
  if (xhsNoteTokenCache.size >= XHS_NOTE_TOKEN_CACHE_MAX_SIZE) {
    const firstKey = xhsNoteTokenCache.keys().next().value;
    if (firstKey) xhsNoteTokenCache.delete(firstKey);
  }
  const existing = xhsNoteTokenCache.get(noteId) || {};
  const xsecSource = metadata.xsec_source || existing.xsec_source || '';
  const canonicalUrl = normalizeXhsCanonicalUrl(
    noteId,
    metadata.canonical_url || existing.canonical_url || '',
    xsecToken || existing.xsecToken || '',
    xsecSource
  );
  xhsNoteTokenCache.set(noteId, {
    ...existing,
    xsecToken: xsecToken || existing.xsecToken || '',
    xsec_source: xsecSource,
    canonical_url: canonicalUrl,
    url: metadata.url || canonicalUrl || existing.url || '',
    title: metadata.title || existing.title || '',
    user: metadata.user || existing.user || '',
    user_id: metadata.user_id || existing.user_id || '',
    cover_image: metadata.cover_image || existing.cover_image || '',
    type: metadata.type || existing.type || '',
    stats: metadata.stats || existing.stats || {},
    createdAt: Date.now(),
  });
  if (String(env.XHS_NOTE_TOKEN_CACHE_DEBUG || '').trim() === '1') {
    const tokenLen = (xsecToken || existing.xsecToken || '').length;
    console.error(`[xhs-cache] cached noteId=${noteId} token_len=${tokenLen} path=${resolveXhsNoteTokenCachePath(env)}`);
  }
  persistXhsNoteTokenCache(env);
}

function getCachedXhsNoteToken(noteId, options = {}) {
  if (!noteId) return null;
  loadXhsNoteTokenCache(options.env || process.env);
  const entry = xhsNoteTokenCache.get(noteId);
  if (!entry) return null;
  const TTL_MS = 24 * 60 * 60 * 1000;
  if (Date.now() - entry.createdAt > TTL_MS) {
    xhsNoteTokenCache.delete(noteId);
    return null;
  }
  const normalizedCanonicalUrl = normalizeXhsCanonicalUrl(
    noteId,
    entry.canonical_url || '',
    entry.xsecToken || entry.xsec_token || '',
    entry.xsec_source || ''
  );
  if (normalizedCanonicalUrl && normalizedCanonicalUrl !== entry.canonical_url) {
    entry.canonical_url = normalizedCanonicalUrl;
    xhsNoteTokenCache.set(noteId, entry);
    persistXhsNoteTokenCache(options.env || process.env);
  }
  return entry;
}



export function buildSocialReaderTools(env = process.env) {
  const tools = [
    {
      name: 'resolve_social_url',
      title: 'Resolve Social URL',
      description: 'Resolve a social media share URL and identify its platform before reading it.',
      inputSchema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'URL or share text containing URL.',
          },
        },
        required: ['url'],
        additionalProperties: false,
      },
    },
    {
      name: 'read_social_post',
      title: 'Read Social Post',
      description: 'Read a social media post through read-only platform-specific MCP backends. Use for Xiaohongshu, Douyin, Bilibili, Weibo, Kuaishou, and similar share links.',
      inputSchema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'URL or share text containing URL.',
          },
          include_comments: {
            type: 'boolean',
            description: 'Whether to fetch comments when the platform backend supports comments.',
            default: false,
          },
          max_comments: {
            type: 'integer',
            description: `Maximum number of comments to request or return. Capped at ${MAX_COMMENTS_CAP}.`,
            minimum: 1,
            maximum: MAX_COMMENTS_CAP,
            default: DEFAULT_MAX_COMMENTS,
          },
        },
        required: ['url'],
        additionalProperties: false,
      },
    },
    {
      name: 'read_social_post_deep',
      title: 'Read Social Post Deep',
      description: 'Read a social post and optionally analyze referenced media through the media_reader facade.',
      inputSchema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'URL or share text containing URL.',
          },
          include_comments: {
            type: 'boolean',
            description: 'Whether to fetch comments when the platform backend supports comments.',
            default: false,
          },
          max_comments: {
            type: 'integer',
            description: `Maximum number of comments to request or return. Capped at ${MAX_COMMENTS_CAP}.`,
            minimum: 1,
            maximum: MAX_COMMENTS_CAP,
            default: DEFAULT_MAX_COMMENTS,
          },
          include_media: {
            type: 'boolean',
            description: 'Whether to analyze media assets through media_reader.',
            default: true,
          },
          media_detail: {
            type: 'string',
            description: 'Media analysis depth. standard is the default to avoid full-cost analysis by default.',
            enum: ['none', 'basic', 'standard', 'full'],
            default: 'standard',
          },
          max_media_assets: {
            type: 'integer',
            description: 'Maximum media assets to analyze.',
            minimum: 1,
            maximum: 100,
            default: 20,
          },
        },
        required: ['url'],
        additionalProperties: false,
      },
    },
    {
      name: 'read_music_share',
      title: 'Read Music Share',
      description: 'Read a music share link without controlling playback. Use for NetEase Cloud Music song shares and share text.',
      inputSchema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'URL or share text containing URL.',
          },
        },
        required: ['url'],
        additionalProperties: false,
      },
    },
    {
      name: 'check_social_login',
      title: 'Check Social Login',
      description: 'Check whether the configured read-only social backend has usable login state.',
      inputSchema: {
        type: 'object',
        properties: {
          platform: {
            type: 'string',
            description: 'Platform id to check.',
            enum: ['xhs'],
          },
        },
        required: ['platform'],
        additionalProperties: false,
      },
    },
  ];
  if (!shouldExposeXhsBrowseTools(env)) {
    return tools;
  }
  return [
    ...tools,
    {
      name: 'xhs_browse_probe',
      title: 'XHS Browse Probe',
      description: 'Probe XHS browse backend availability and discover available tools. Always available.',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
    {
      name: 'xhs_browse_search',
      title: 'XHS Browse Search',
      description: 'Search Xiaohongshu notes by keyword. Requires XHS_BROWSE_ENABLED=true and XHS_BROWSE_SEARCH_ENABLED=true.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query keyword.' },
          max_results: { type: 'integer', description: 'Maximum results. Default 5, hard limit 10.', minimum: 1, maximum: 10, default: 5 },
          sort: { type: 'string', description: 'Sort order.', enum: ['relevance', 'latest', 'popular'], default: 'relevance' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
    {
      name: 'xhs_browse_note',
      title: 'XHS Browse Note',
      description: 'Get Xiaohongshu note details by note_id, URL, or read_ref returned by xhs_browse_search. Requires XHS_BROWSE_ENABLED=true and XHS_BROWSE_NOTE_ENABLED=true.',
      inputSchema: {
        type: 'object',
        properties: {
          note_id: { type: 'string', description: 'Note ID to fetch.' },
          read_ref: { type: 'string', description: 'Opaque read reference returned by xhs_browse_search, for example xhs:note:<note_id>.' },
          url: { type: 'string', description: 'XHS note URL when available.' },
          include_images: { type: 'boolean', description: 'Include images.', default: true },
        },
        required: [],
        additionalProperties: false,
      },
    },
    {
      name: 'xhs_browse_user',
      title: 'XHS Browse User',
      description: 'Get Xiaohongshu user profile. Requires XHS_BROWSE_USER_ENABLED=true (disabled by default).',
      inputSchema: {
        type: 'object',
        properties: {
          user_id: { type: 'string', description: 'User ID.' },
          max_items: { type: 'integer', description: 'Max notes. Default 5, hard limit 10.', minimum: 1, maximum: 10, default: 5 },
        },
        required: ['user_id'],
        additionalProperties: false,
      },
    },
    {
      name: 'xhs_browse_feed',
      title: 'XHS Browse Feed',
      description: 'Get Xiaohongshu recommendation feed. Requires XHS_BROWSE_FEED_ENABLED=true (disabled by default).',
      inputSchema: {
        type: 'object',
        properties: {
          category: { type: 'string', description: 'Feed category.', enum: ['default', 'food', 'travel', 'fashion'], default: 'default' },
          max_items: { type: 'integer', description: 'Max items. Default 5, hard limit 10.', minimum: 1, maximum: 10, default: 5 },
        },
        required: [],
        additionalProperties: false,
      },
    },

  ];
}

export function detectSocialPlatform(url) {
  let host = '';
  try {
    host = new URL(String(url || '').trim()).hostname.toLowerCase();
  } catch {
    return 'unknown';
  }
  for (const [platform, hosts] of PLATFORM_HOSTS) {
    if (hosts.some((item) => host === item || host.endsWith(`.${item}`))) {
      return platform;
    }
  }
  return 'unknown';
}

function buildErrorResult(message, extra = {}) {
  const errorCode = extra.error_code || 'BACKEND_MCP_ERROR';
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: String(message || 'social reader failed'),
      },
    ],
    structuredContent: {
      ok: false,
      error_code: errorCode,
      error: String(message || 'social reader failed'),
      ...extra,
    },
  };
}

function buildTextResult(payload) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload, null, 2),
      },
    ],
    structuredContent: payload,
  };
}

function wrapMcpResult(result) {
  // Already an MCP result (has content array)
  if (result && Array.isArray(result.content)) return result;
  // Bare error object (ok: false)
  if (result && result.ok === false) {
    return buildErrorResult(result.message || result.error || 'unknown error', result);
  }
  // Bare success object
  return buildTextResult(result);
}

function textFromMcpResult(result) {
  if (typeof result === 'string') {
    return result;
  }
  const content = Array.isArray(result?.content) ? result.content : [];
  return content
    .map((item) => item?.type === 'text' ? String(item.text || '') : '')
    .filter(Boolean)
    .join('\n')
    .trim();
}

function normalizeGenericParserPayload(text) {
  const rawText = String(text || '').trim();
  if (!rawText) {
    return {
      ok: false,
      error_code: 'GENERIC_PARSE_FAILED',
      error: 'GENERIC_PARSE_FAILED: parser returned empty text',
    };
  }

  let payload = null;
  try {
    const parsed = JSON.parse(rawText);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      payload = parsed;
    }
  } catch {
    payload = null;
  }

  if (!payload) {
    return {
      ok: true,
      post_text: rawText,
    };
  }

  const status = String(payload.status || '').trim().toLowerCase();
  if (status === 'error' || payload.ok === false || payload.success === false) {
    const message = firstString(payload.error, payload.message) || 'generic parser returned failure';
    return {
      ok: false,
      error_code: 'GENERIC_PARSE_FAILED',
      error: `GENERIC_PARSE_FAILED: ${message}`,
      parser_status: status || '',
    };
  }

  const postText = firstString(
    payload.desc,
    payload.caption,
    payload.content,
    payload.text,
    payload.description,
    payload.title
  ) || rawText;

  return {
    ok: true,
    post_text: postText,
    title: firstString(payload.title),
    note_id: firstString(payload.note_id, payload.id),
    parser_status: status || '',
    media_type: firstString(payload.type),
    images: Array.isArray(payload.images) ? payload.images : [],
    media: payload.media,
    media_list: payload.media_list,
    medias: payload.medias,
    videos: payload.videos,
    audios: payload.audios,
    attachments: payload.attachments,
    image_count: payload.image_count,
  };
}

function xhsBackendTextError(text, toolName) {
  const normalized = String(text || '').trim();
  if (!normalized) {
    return null;
  }
  if (/cookie已失效|cookie失效|cookie expired|invalid cookie/i.test(normalized)) {
    return {
      error_code: 'XHS_COOKIE_EXPIRED',
      message: `${toolName} returned login failure: ${normalized}`,
      hint: 'XHS cookie has expired. Re-login to xiaohongshu.com and update XHS_COOKIE in .env.local.',
    };
  }
  if (/验证码|风控|risk|captcha/i.test(normalized)) {
    return {
      error_code: 'XHS_IP_RISK',
      message: `${toolName} returned risk control: ${normalized}`,
      hint: 'XHS detected IP risk or requires captcha. Try again later or use a different network.',
    };
  }
  if (/^获取失败[。.!！\s]*$/i.test(normalized) || /获取失败/.test(normalized)) {
    return {
      error_code: 'BACKEND_MCP_ERROR',
      message: `${toolName} returned backend failure text: ${normalized}`,
    };
  }
  return null;
}

function buildXhsDiagnostic({ platform, url, noteId, whichBackend, backendToolName, errorCode, backendError, hasCookie, hasXsecToken, usedCachedToken, usedCanonicalUrl, rawFieldsSeen, rawPreview, env }) {
  const cookieDiag = platform === 'xhs' ? xhsCookieDiagnostics(env || process.env) : undefined;
  return {
    platform: platform || 'xhs',
    url: url || '',
    note_id: noteId || '',
    which_backend: whichBackend || '',
    backend_tool_name: backendToolName || '',
    error_code: errorCode || '',
    backend_error: backendError || '',
    has_cookie: hasCookie !== undefined ? hasCookie : Boolean(cookieDiag?.status === 'SET'),
    has_xsec_token: hasXsecToken !== undefined ? hasXsecToken : false,
    used_cached_token: usedCachedToken || false,
    used_canonical_url: usedCanonicalUrl || false,
    raw_fields_seen: rawFieldsSeen || {},
    raw_preview: rawPreview ? rawPreview.slice(0, 1000) : '',
    cookie_diagnostics: cookieDiag,
  };
}

function sanitizeRawPreview(text, maxLen = 1000) {
  let cleaned = String(text || '').slice(0, maxLen);
  // Redact potential cookies and tokens
  cleaned = cleaned.replace(/(?:cookie|token|key|secret|password|sessdata)[=:]\s*[^\s,;]{8,}/gi, (m) => {
    const sep = m.includes('=') ? '=' : ':';
    const key = m.split(sep)[0];
    return `${key}${sep}***REDACTED***`;
  });
  return cleaned;
}

function extractRawFieldsSeen(data) {
  if (!data || typeof data !== 'object') return {};
  const noteData = pickXhsNoteData(data);
  const noteCard = xhsObject(noteData.noteCard) || xhsObject(noteData.note_card) || {};
  const sources = [data, xhsObject(data.data), xhsObject(data.result), noteData, noteCard].filter(Boolean);
  const has = (predicate) => sources.some(predicate);
  const imageArrays = [];
  for (const source of sources) {
    for (const key of ['images', 'image_list', 'imageList']) {
      if (Array.isArray(source[key])) imageArrays.push(source[key]);
    }
  }
  const hasImages = imageArrays.some((items) => items.length > 0);
  const hasUrlPng = imageArrays.some((items) => items.some((i) => i && typeof i === 'object' && i.url_png));
  const hasUrlWebp = imageArrays.some((items) => items.some((i) => i && typeof i === 'object' && i.url_webp));
  return {
    status: has((source) => Boolean(source.status)),
    type: has((source) => Boolean(source.type)),
    platform: has((source) => Boolean(source.platform)),
    title: has((source) => Boolean(source.title || source.note_title || source.display_title || source.displayTitle)),
    desc: has((source) => Boolean(source.desc || source.description || source.note_desc || source.content || source.post_text)),
    caption: has((source) => Boolean(source.caption)),
    url: has((source) => Boolean(source.url)),
    source_url: has((source) => Boolean(source.source_url)),
    image_count: has((source) => Boolean(source.image_count)) || hasImages,
    images: hasImages,
    images_url_png: hasUrlPng,
    images_url_webp: hasUrlWebp,
    format_info: has((source) => Boolean(source.format_info)),
    video: has((source) => Boolean(source.video || source.video_url || source.note_video)),
    media: has((source) => Boolean(source.media?.length || source.media_list?.length)),
    comments: has((source) => Boolean(source.comments?.length || source.comment_list?.length)),
    tags: has((source) => Boolean(source.tags?.length || source.tag_list?.length)),
  };
}

function parseJsonArrayEnv(value, fallback) {
  if (!value) {
    return fallback;
  }
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
      return parsed;
    }
  } catch {
    // Fall through to the fallback; env value is surfaced by docs and tests.
  }
  return fallback;
}

function headersGet(headers, name) {
  const lowerName = String(name || '').toLowerCase();
  return headers[lowerName] || '';
}

function nodeHttpFetch(url, init = {}, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(String(url));
    const client = parsed.protocol === 'http:' ? http : https;
    const headers = {
      'accept-encoding': 'identity',
      ...(init.headers || {}),
    };
    const request = client.request(parsed, {
      method: init.method || 'GET',
      headers,
    }, (response) => {
      const status = response.statusCode || 0;
      const location = response.headers.location || '';
      if ([301, 302, 303, 307, 308].includes(status) && init.redirect !== 'manual' && location && redirectCount < 10) {
        response.resume();
        const nextUrl = new URL(location, parsed).toString();
        resolve(nodeHttpFetch(nextUrl, init, redirectCount + 1));
        return;
      }
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({
          ok: status >= 200 && status < 300,
          status,
          url: parsed.toString(),
          headers: {
            get: (name) => headersGet(response.headers, name),
          },
          text: async () => body,
          json: async () => JSON.parse(body),
        });
      });
    });
    request.on('error', reject);
    if (init.signal) {
      init.signal.addEventListener('abort', () => {
        request.destroy(new Error('The operation was aborted'));
      }, { once: true });
    }
    request.end();
  });
}

export function resolveFetchImpl(explicitFetchImpl) {
  if (explicitFetchImpl) {
    return explicitFetchImpl;
  }
  if (typeof globalThis.fetch === 'function') {
    return globalThis.fetch.bind(globalThis);
  }
  return nodeHttpFetch;
}

function normalizeMaxComments(value) {
  if (value === undefined || value === null || value === '') {
    return DEFAULT_MAX_COMMENTS;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_MAX_COMMENTS;
  }
  return Math.max(1, Math.min(MAX_COMMENTS_CAP, Math.floor(parsed)));
}

function resolveTimeoutMs(env = process.env) {
  const parsed = Number(env.SOCIAL_READER_MCP_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

function resolveXhsBackendTimeoutMs(env = process.env) {
  const parsed = Number(env.SOCIAL_READER_XHS_BACKEND_TIMEOUT_MS || env.XHS_BACKEND_MCP_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

function xhsServerConfig(env = process.env) {
  return {
    command: env.XHS_MCP_COMMAND || 'uvx',
    args: parseJsonArrayEnv(env.XHS_MCP_ARGS_JSON, ['--from', 'jobson-xhs-mcp', 'xhs-mcp']),
    env: {
      XHS_COOKIE: env.XHS_COOKIE || '',
    },
  };
}

function bilibiliServerConfig(env = process.env) {
  return {
    command: env.BILIBILI_MCP_COMMAND || 'npx',
    args: parseJsonArrayEnv(env.BILIBILI_MCP_ARGS_JSON, ['-y', '@wangshunnn/bilibili-mcp-server']),
    env: {},
  };
}

function genericParserServerConfig(env = process.env) {
  return {
    command: env.SOCIAL_PARSE_MCP_COMMAND || 'uvx',
    args: parseJsonArrayEnv(env.SOCIAL_PARSE_MCP_ARGS_JSON, ['wanyi-watermark']),
    env: {},
  };
}

function genericParserToolForPlatform(platform) {
  if (platform === 'douyin') {
    return 'parse_douyin_link';
  }
  if (platform === 'xhs') {
    return 'parse_xhs_link';
  }
  return 'parse_generic_link';
}

function readGenericFallbackMarker(env = process.env) {
  const markerPath = env.XHS_GENERIC_FALLBACK_READY_PATH
    || '/opt/ran_agent/.ran_agent_state/social_reader/generic-fallback-ready.json';
  try {
    return JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch {
    return null;
  }
}

function getXhsFallbackServerConfig(env = process.env) {
  const marker = readGenericFallbackMarker(env);
  if (marker?.ok && marker.command) {
    return {
      command: marker.command,
      args: marker.args || [],
      env: {},
    };
  }
  if (env.SOCIAL_READER_ALLOW_RUNTIME_UVX_FALLBACK === 'true') {
    return genericParserServerConfig(env);
  }
  return null;
}

function normalizeXhsScheme(url) {
  // Normalize xhslink short URLs from http:// to https:// to avoid
  // mixed-content redirects and terminal/browser security blocks.
  return String(url || '').replace(/^http:\/\/xhslink\.com\//i, 'https://xhslink.com/');
}

export function extractFirstUrl(text) {
  const raw = String(text || '');
  const match = raw.match(/https?:\/\/[^\s"'<>【】「」《》，。！？、；：]+/i);
  if (!match) {
    return {
      url: '',
      before_text: raw.trim(),
      after_text: '',
      error_code: 'NO_URL_FOUND',
    };
  }
  let url = match[0];
  url = url.replace(/[，。！？、；：）)\]}】》」'".]+$/u, '');
  // Normalize xhslink short URLs from http to https to avoid redirect/security issues
  url = normalizeXhsScheme(url);
  return {
    url,
    before_text: raw.slice(0, match.index).trim(),
    after_text: raw.slice((match.index || 0) + match[0].length).trim(),
  };
}

function isAllowedXhsHostname(hostname) {
  return XHS_ALLOWED_HOSTS.has(String(hostname || '').toLowerCase());
}

function isXhsShortLinkHost(hostname) {
  return String(hostname || '').toLowerCase() === 'xhslink.com';
}

function resolveXhsRedirectLocation(location, baseUrl) {
  if (String(location || '').startsWith('/')) {
    return new URL(location, 'https://www.xiaohongshu.com');
  }
  return new URL(location, baseUrl);
}

export function parseXhsUrlInfo(url) {
  let parsed;
  try {
    parsed = new URL(String(url || '').trim());
  } catch {
    return {
      note_id: '',
      xsec_token: '',
      xsec_source: '',
      canonical_url: '',
    };
  }
  if (!isAllowedXhsHostname(parsed.hostname)) {
    return {
      note_id: '',
      xsec_token: '',
      xsec_source: '',
      canonical_url: '',
    };
  }
  const parts = parsed.pathname.split('/').filter(Boolean);
  let noteId = '';
  const exploreIndex = parts.indexOf('explore');
  const discoveryIndex = parts.indexOf('discovery');
  if (exploreIndex >= 0 && parts[exploreIndex + 1]) {
    noteId = parts[exploreIndex + 1];
  } else if (discoveryIndex >= 0 && parts[discoveryIndex + 1] === 'item' && parts[discoveryIndex + 2]) {
    noteId = parts[discoveryIndex + 2];
  }
  const xsecToken = parsed.searchParams.get('xsec_token') || '';
  const xsecSource = parsed.searchParams.get('xsec_source') || '';
  let canonicalUrl = '';
  if (noteId) {
    const canonical = new URL(`https://www.xiaohongshu.com/explore/${noteId}`);
    if (xsecToken) {
      canonical.searchParams.set('xsec_token', xsecToken);
    }
    if (xsecSource) {
      canonical.searchParams.set('xsec_source', xsecSource);
    }
    canonicalUrl = canonical.toString();
  }
  return {
    note_id: noteId,
    xsec_token: xsecToken,
    xsec_source: xsecSource,
    canonical_url: canonicalUrl,
  };
}

function buildXhsReadUrlCandidates({ rawText = '', resolved = {} } = {}) {
  const candidates = [];
  function push(value) {
    const text = String(value || '').trim();
    if (!text) return;
    const extracted = extractFirstUrl(text);
    const url = extracted.url || text;
    if (!url || candidates.includes(url)) return;
    try {
      const parsed = new URL(url);
      if (isXhsShortLinkHost(parsed.hostname) && candidates.length > 0) return;
    } catch {
      return;
    }
    candidates.push(url);
  }

  push(resolved.resolved_url);
  push(resolved.canonical_url);
  push(resolved.url);
  push(rawText);
  return candidates;
}

export async function resolveXhsShareUrl(input, options = {}) {
  const extracted = extractFirstUrl(input);
  if (!extracted.url) {
    return {
      ok: false,
      error_code: 'NO_URL_FOUND',
      error: 'NO_URL_FOUND: no URL found in share text',
    };
  }
  let currentUrl;
  try {
    currentUrl = new URL(extracted.url);
  } catch {
    return {
      ok: false,
      error_code: 'UNSUPPORTED_PLATFORM',
      error: 'UNSUPPORTED_PLATFORM: invalid URL',
      url: extracted.url,
    };
  }
  if (!isAllowedXhsHostname(currentUrl.hostname)) {
    return {
      ok: false,
      error_code: 'UNSUPPORTED_PLATFORM',
      error: 'UNSUPPORTED_PLATFORM: unsupported XHS host',
      url: extracted.url,
    };
  }

  const fetchImpl = resolveFetchImpl(options.fetchImpl);
  const timeoutMs = resolveTimeoutMs(options.env);
  let redirectCount = 0;
  let finalUrl = currentUrl.toString();

  while (isXhsShortLinkHost(currentUrl.hostname) && redirectCount < XHS_MAX_REDIRECTS) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(currentUrl.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'user-agent': BROWSER_USER_AGENT,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });
    } catch (error) {
      clearTimeout(timeout);
      return {
        ok: false,
        error_code: 'SHORTLINK_RESOLVE_FAILED',
        error: `SHORTLINK_RESOLVE_FAILED: ${error instanceof Error ? error.message : String(error)}`,
        url: extracted.url,
      };
    } finally {
      clearTimeout(timeout);
    }

    const location = response?.headers?.get?.('location') || response?.headers?.get?.('Location') || '';
    if (location && response.status >= 300 && response.status < 400) {
      currentUrl = resolveXhsRedirectLocation(location, currentUrl);
      if (!isAllowedXhsHostname(currentUrl.hostname)) {
        return {
          ok: false,
          error_code: 'UNSUPPORTED_PLATFORM',
          error: 'UNSUPPORTED_PLATFORM: redirect target is not an allowed XHS host',
          url: extracted.url,
        };
      }
      finalUrl = currentUrl.toString();
      redirectCount += 1;
      continue;
    }

    if (response?.url) {
      currentUrl = new URL(response.url, currentUrl);
      finalUrl = currentUrl.toString();
    }
    break;
  }

  if (redirectCount >= XHS_MAX_REDIRECTS && isXhsShortLinkHost(currentUrl.hostname)) {
    return {
      ok: false,
      error_code: 'SHORTLINK_RESOLVE_FAILED',
      error: 'SHORTLINK_RESOLVE_FAILED: too many redirects',
      url: extracted.url,
    };
  }

  const info = parseXhsUrlInfo(finalUrl);
  if (!info.note_id) {
    return {
      ok: false,
      error_code: 'MISSING_NOTE_ID',
      error: 'MISSING_NOTE_ID: could not parse note id from XHS URL',
      url: extracted.url,
      resolved_url: finalUrl,
    };
  }
  return {
    ok: true,
    url: extracted.url,
    share_text: String(input || ''),
    title_hint: extracted.before_text,
    resolved_url: finalUrl,
    note_id: info.note_id,
    xsec_token: info.xsec_token,
    xsec_source: info.xsec_source,
    canonical_url: info.canonical_url || finalUrl,
  };
}

async function prepareXhsBackendUrl({ rawText, resolved }, options = {}) {
  if (!resolved.note_id) {
    return {
      ok: false,
      error_code: 'MISSING_NOTE_ID',
      error: 'MISSING_NOTE_ID: could not parse note id from XHS URL',
    };
  }
  if (resolved.xsec_token && resolved.canonical_url) {
    return {
      ok: true,
      backend_url: resolved.canonical_url,
      source: 'resolved_url',
    };
  }
  const cachedEntry = getCachedXhsNoteToken(resolved.note_id, options);
  if (cachedEntry?.xsecToken && cachedEntry?.canonical_url) {
    return {
      ok: true,
      backend_url: cachedEntry.canonical_url,
      source: 'xhs_browse_cache',
    };
  }
  return await resolveFreshXhsTokenFromSearch({ rawText, resolved }, options);
}

async function resolveFreshXhsTokenFromSearch({ rawText, resolved }, options = {}) {
  const keywords = buildXhsSearchKeywords(rawText, resolved);
  if (!keywords) {
    return {
      ok: false,
      error_code: 'MISSING_XSEC_TOKEN',
      error: 'MISSING_XSEC_TOKEN: no xsec_token and no searchable title hint',
      note_id: resolved.note_id || '',
    };
  }

  const browsePrepared = await resolveFreshXhsTokenFromBrowseSearch({ resolved, keywords }, options);
  if (browsePrepared?.ok === true) {
    return browsePrepared;
  }

  let searchResult;
  try {
    searchResult = await callBackendMcpTool('xhs', 'search_notes', { keywords }, options);
  } catch (error) {
    return backendErrorPayload(error, { platform: 'xhs', tool: 'search_notes' });
  }
  const candidates = extractXhsSearchCandidates(searchResult);
  const withInfo = candidates
    .map((candidate) => ({
      ...candidate,
      info: parseXhsUrlInfo(candidate.url || ''),
    }))
    .filter((candidate) => candidate.info.note_id && candidate.info.xsec_token);

  const noteMatches = withInfo.filter((candidate) => candidate.info.note_id === resolved.note_id);
  if (noteMatches.length === 1) {
    return {
      ok: true,
      backend_url: noteMatches[0].info.canonical_url,
      source: 'search_note_id',
      keywords,
    };
  }
  if (noteMatches.length > 1) {
    return {
      ok: false,
      error_code: 'AMBIGUOUS_SEARCH_RESULT',
      error: 'AMBIGUOUS_SEARCH_RESULT: multiple search results matched note_id',
      note_id: resolved.note_id,
      keywords,
    };
  }

  const titleMatches = withInfo.filter((candidate) => titleMatchesHint(candidate.title, keywords));
  if (!resolved.note_id && titleMatches.length === 1) {
    return {
      ok: true,
      backend_url: titleMatches[0].info.canonical_url,
      source: 'search_title',
      keywords,
    };
  }
  if (resolved.note_id && titleMatches.length === 1 && titleMatches[0].info.note_id === resolved.note_id) {
    return {
      ok: true,
      backend_url: titleMatches[0].info.canonical_url,
      source: 'search_title_note_id',
      keywords,
    };
  }
  if (titleMatches.length > 1) {
    return {
      ok: false,
      error_code: 'AMBIGUOUS_SEARCH_RESULT',
      error: 'AMBIGUOUS_SEARCH_RESULT: multiple title search results matched',
      note_id: resolved.note_id || '',
      keywords,
    };
  }

  return {
    ok: false,
    error_code: 'MISSING_XSEC_TOKEN',
    error: 'MISSING_XSEC_TOKEN: search did not return a fresh token for this note',
    note_id: resolved.note_id || '',
    keywords,
  };
}

async function resolveFreshXhsTokenFromBrowseSearch({ resolved, keywords }, options = {}) {
  const env = options.env || process.env;
  const config = getXhsBrowseConfig(env);
  if (!config.enabled || !config.isConfigured || !config.searchEnabled) {
    return null;
  }

  let searchResult;
  try {
    searchResult = await xhsBrowseSearch({
      query: keywords,
      max_results: config.maxResults,
    }, { ...options, xhsBrowseSkipMinInterval: true });
  } catch {
    return null;
  }
  if (searchResult?.ok !== true || !Array.isArray(searchResult.results)) {
    return null;
  }

  const noteId = resolved.note_id || '';
  const matches = searchResult.results.filter((candidate) => candidate.note_id === noteId);
  if (matches.length !== 1) {
    return null;
  }

  const cachedEntry = getCachedXhsNoteToken(noteId, options);
  if (!cachedEntry?.xsecToken || !cachedEntry?.canonical_url) {
    return null;
  }

  return {
    ok: true,
    backend_url: cachedEntry.canonical_url,
    source: 'xhs_browse_search',
    keywords,
  };
}

function buildXhsSearchKeywords(rawText, resolved) {
  const extracted = extractFirstUrl(rawText || '');
  const hint = (resolved?.title_hint || extracted.before_text || '').trim();
  return hint
    .replace(/\s+/g, ' ')
    .replace(/[，。！？、；："'【】《》]+/g, ' ')
    .trim()
    .slice(0, 80);
}

function extractXhsSearchCandidates(result) {
  const structured = result?.structuredContent || null;
  const text = textFromMcpResult(result);
  const values = [];
  collectCandidateObjects(structured, values);
  if (text) {
    try {
      collectCandidateObjects(JSON.parse(text), values);
    } catch {
      collectCandidateObjectsFromText(text, values);
    }
  }
  return values;
}

function collectCandidateObjects(value, output) {
  if (!value) {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectCandidateObjects(item, output);
    }
    return;
  }
  if (typeof value !== 'object') {
    return;
  }
  const url = firstString(value.url, value.note_url, value.link, value.share_url);
  const title = firstString(value.title, value.display_title, value.desc, value.content);
  if (url) {
    output.push({ url, title });
  }
  for (const nestedKey of ['items', 'notes', 'data', 'results', 'list']) {
    if (value[nestedKey]) {
      collectCandidateObjects(value[nestedKey], output);
    }
  }
}

function collectCandidateObjectsFromText(text, output) {
  const urls = String(text || '').match(/https?:\/\/[^\s"'<>【】「」《》]+/ig) || [];
  for (const url of urls) {
    output.push({ url: url.replace(/[，。！？、；：）)\]}】》」'".]+$/u, ''), title: '' });
  }
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function titleMatchesHint(title, hint) {
  const normalizedTitle = normalizeSearchText(title);
  const normalizedHint = normalizeSearchText(hint);
  return Boolean(normalizedTitle && normalizedHint && (
    normalizedTitle.includes(normalizedHint)
    || normalizedHint.includes(normalizedTitle)
  ));
}

function normalizeSearchText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '')
    .trim();
}

function classifyXhsError(error) {
  const msg = String(error?.message || error || '').toLowerCase();
  if (msg.includes('timed out') || msg.includes('timeout')) return 'XHS_BACKEND_TIMEOUT';
  if (msg.includes('cookie') || msg.includes('login') || msg.includes('401')) return 'XHS_COOKIE_INVALID';
  if (msg.includes('xsec')) return 'XHS_SHORTLINK_RESOLVE_FAILED';
  if (msg.includes('captcha') || msg.includes('risk') || msg.includes('verify')) return 'XHS_ANTI_BOT_OR_CAPTCHA';
  if (msg.includes('enotfound') || msg.includes('econnrefused') || msg.includes('network')) return 'XHS_NETWORK_ERROR';
  return 'XHS_BACKEND_MCP_ERROR';
}

function backendErrorPayload(error, extra = {}) {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  let errorCode = 'BACKEND_MCP_ERROR';
  if (/captcha|risk|风控|验证|滑块/.test(lower)) {
    errorCode = 'CAPTCHA_OR_RISK_CONTROL';
  } else if (/cookie|login|unauthorized|401|登录/.test(lower)) {
    errorCode = 'LOGIN_REQUIRED';
  } else if (/timed out|timeout|ETIMEDOUT/.test(lower)) {
    errorCode = 'XHS_BACKEND_TIMEOUT';
  }
  return {
    ok: false,
    error_code: errorCode,
    error: `${errorCode}: ${message}`,
    retryable: errorCode === 'XHS_BACKEND_TIMEOUT',
    ...extra,
  };
}

function backendErrorResult(error, extra = {}) {
  const payload = backendErrorPayload(error, extra);
  return buildErrorResult(payload.error, payload);
}

async function resolveSocialUrl(url, options = {}) {
  const extracted = extractFirstUrl(url);
  if (!extracted.url) {
    return buildErrorResult('NO_URL_FOUND: no URL found in share text', { error_code: 'NO_URL_FOUND' });
  }
  const platform = detectSocialPlatform(extracted.url);
  if (platform === 'xhs') {
    const resolved = await resolveXhsShareUrl(url, options);
    if (!resolved.ok) {
      return buildErrorResult(resolved.error || resolved.error_code, resolved);
    }
    const noteId = resolved.note_id || '';
    const xsecToken = resolved.xsec_token || '';
    let cacheWritten = false;
    const cachePath = resolveXhsNoteTokenCachePath(options.env || process.env);
    if (noteId && xsecToken) {
      try {
        cacheXhsNoteToken(noteId, xsecToken, {
          xsec_source: resolved.xsec_source || '',
          canonical_url: resolved.canonical_url || resolved.resolved_url || '',
          url: extracted.url,
        }, options);
        cacheWritten = true;
      } catch {
        // Cache write is best-effort
      }
    }
    return buildTextResult({
      ok: true,
      url: extracted.url,
      resolved_url: resolved.resolved_url,
      platform: 'xhs',
      note_id: noteId,
      xsec_source: resolved.xsec_source || '',
      has_xsec_token: Boolean(xsecToken),
      cache_written: cacheWritten,
      cache_path: cachePath,
    });
  }
  const resolvedUrl = await defaultResolveUrl(extracted.url, {
    timeoutMs: resolveTimeoutMs(options.env),
    fetchImpl: options.fetchImpl,
  });
  return buildTextResult({
    ok: true,
    url: extracted.url,
    resolved_url: resolvedUrl || extracted.url,
    platform: detectSocialPlatform(resolvedUrl || extracted.url),
  });
}

async function defaultResolveUrl(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || DEFAULT_TIMEOUT_MS);
  const fetchImpl = resolveFetchImpl(options.fetchImpl);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': BROWSER_USER_AGENT,
      },
    });
    return response.url || url;
  } catch {
    return url;
  } finally {
    clearTimeout(timeout);
  }
}

async function checkSocialLogin(platform, options = {}) {
  if (platform !== 'xhs') {
    return buildErrorResult(`UNSUPPORTED_PLATFORM: unsupported login check platform: ${platform}`, { error_code: 'UNSUPPORTED_PLATFORM', platform });
  }
  const env = options.env || process.env;
  const cookieDiag = xhsCookieDiagnostics(env);
  if (!String(env.XHS_COOKIE || '').trim()) {
    return buildErrorResult('LOGIN_REQUIRED: XHS_COOKIE is required for xhs login checks', {
      error_code: 'XHS_COOKIE_MISSING',
      platform: 'xhs',
      cookie_diagnostics: cookieDiag,
    });
  }
  try {
    const result = await callBackendMcpTool('xhs', 'check_cookie', {}, options);
    const text = textFromMcpResult(result);
    const ok = /有效|valid/i.test(text) && !/失效|invalid/i.test(text);
    return buildTextResult({
      ok,
      platform: 'xhs',
      status_text: text,
    });
  } catch (error) {
    return backendErrorResult(error, { platform: 'xhs' });
  }
}

function extractBilibiliBvid(urlOrText) {
  const extracted = extractFirstUrl(urlOrText);
  const source = extracted.url || String(urlOrText || '');
  const match = source.match(/BV[0-9A-Za-z]{10,}/);
  return match ? match[0] : '';
}

async function readBilibiliPost({ rawText, includeComments, maxComments }, options = {}) {
  const extracted = extractFirstUrl(rawText || '');
  if (!extracted.url) {
    return buildErrorResult('NO_URL_FOUND: no URL found in share text', { error_code: 'NO_URL_FOUND' });
  }
  const resolvedUrl = await defaultResolveUrl(extracted.url, {
    timeoutMs: resolveTimeoutMs(options.env),
    fetchImpl: options.fetchImpl,
  });
  const bvid = extractBilibiliBvid(resolvedUrl || extracted.url);
  if (!bvid) {
    return buildErrorResult('MISSING_NOTE_ID: could not parse Bilibili bvid from URL', {
      error_code: 'MISSING_NOTE_ID',
      platform: 'bilibili',
      url: resolvedUrl || extracted.url,
    });
  }
  try {
    const result = await callBackendMcpTool('bilibili', 'get_video_info', { bvid }, options);
    return buildTextResult({
      ok: true,
      platform: 'bilibili',
      url: resolvedUrl || extracted.url,
      source: '@wangshunnn/bilibili-mcp-server',
      bvid,
      include_comments: includeComments,
      max_comments: maxComments,
      comments_supported: false,
      post_text: textFromMcpResult(result),
      comments_text: '',
    });
  } catch (error) {
    return backendErrorResult(error, { platform: 'bilibili', bvid, url: resolvedUrl || extracted.url });
  }
}

function parseNeteaseMusicInfo(urlOrText) {
  const extracted = extractFirstUrl(urlOrText);
  if (!extracted.url) {
    return {
      ok: false,
      error_code: 'NO_URL_FOUND',
      error: 'NO_URL_FOUND: no URL found in share text',
    };
  }
  let parsed;
  try {
    parsed = new URL(extracted.url);
  } catch {
    return {
      ok: false,
      error_code: 'UNSUPPORTED_PLATFORM',
      error: 'UNSUPPORTED_PLATFORM: invalid music URL',
      url: extracted.url,
    };
  }
  const platform = detectSocialPlatform(parsed.toString());
  if (platform !== 'netease_music') {
    return {
      ok: false,
      error_code: 'UNSUPPORTED_PLATFORM',
      error: 'UNSUPPORTED_PLATFORM: not a NetEase Cloud Music URL',
      url: extracted.url,
    };
  }
  const hashParams = new URLSearchParams(String(parsed.hash || '').replace(/^#\/?[^?]*\??/, ''));
  const songId = parsed.searchParams.get('id') || hashParams.get('id') || '';
  const pathname = parsed.pathname.toLowerCase();
  const musicType = pathname.includes('/playlist') || String(parsed.hash || '').includes('/playlist')
    ? 'playlist'
    : pathname.includes('/album') || String(parsed.hash || '').includes('/album')
      ? 'album'
      : 'song';
  return {
    ok: true,
    url: extracted.url,
    music_type: musicType,
    id: songId,
  };
}

function isNeteaseShortLink(url) {
  try {
    return new URL(String(url || '').trim()).hostname.toLowerCase() === '163cn.tv';
  } catch {
    return false;
  }
}

async function resolveNeteaseMusicUrl(urlOrText, options = {}) {
  const extracted = extractFirstUrl(urlOrText);
  if (!extracted.url) {
    return extracted;
  }
  if (!isNeteaseShortLink(extracted.url)) {
    return {
      ...extracted,
      resolved_url: extracted.url,
    };
  }
  const resolvedUrl = await defaultResolveUrl(extracted.url, {
    timeoutMs: resolveTimeoutMs(options.env),
    fetchImpl: options.fetchImpl,
  });
  return {
    ...extracted,
    resolved_url: resolvedUrl || extracted.url,
  };
}

function resolveNeteaseApiBaseUrl(env = process.env) {
  return String(env.NETEASE_MUSIC_API_BASE_URL || 'https://music.163.com/api').trim().replace(/\/+$/, '');
}

async function readMusicShare(args = {}, options = {}) {
  const resolved = await resolveNeteaseMusicUrl(args.url || '', options);
  const info = parseNeteaseMusicInfo(resolved.resolved_url || resolved.url || args.url || '');
  if (!info.ok) {
    return buildErrorResult(info.error || info.error_code, info);
  }
  if (info.music_type !== 'song') {
    return buildErrorResult('UNSUPPORTED_PLATFORM: only NetEase song shares are supported for now', {
      error_code: 'UNSUPPORTED_PLATFORM',
      platform: 'netease_music',
      music_type: info.music_type,
      url: info.url,
    });
  }
  if (!info.id) {
    return buildErrorResult('MISSING_NOTE_ID: could not parse NetEase song id from URL', {
      error_code: 'MISSING_NOTE_ID',
      platform: 'netease_music',
      url: info.url,
    });
  }
  const apiUrl = new URL(`${resolveNeteaseApiBaseUrl(options.env)}/song/detail`);
  apiUrl.searchParams.set('ids', `[${info.id}]`);
  const fetchImpl = resolveFetchImpl(options.fetchImpl);
  try {
    const response = await fetchImpl(apiUrl.toString(), {
      method: 'GET',
      headers: {
        'user-agent': BROWSER_USER_AGENT,
        referer: 'https://music.163.com/',
      },
    });
    if (response?.ok === false) {
      throw new Error(`NetEase music API returned status ${response.status || 'unknown'}`);
    }
    const payload = await response.json();
    const song = Array.isArray(payload?.songs) ? payload.songs[0] : null;
    if (!song) {
      throw new Error('NetEase music API returned no song');
    }
    const album = song.al || song.album || {};
    const artists = Array.isArray(song.ar)
      ? song.ar
      : Array.isArray(song.artists)
        ? song.artists
        : [];
    return buildTextResult({
      ok: true,
      platform: 'netease_music',
      source: 'NeteaseCloudMusicApi-compatible',
      url: info.url,
      music_type: 'song',
      song_id: String(song.id || info.id),
      title: String(song.name || ''),
      artists: artists.map((artist) => String(artist?.name || '').trim()).filter(Boolean),
      album: String(album.name || ''),
      cover_url: String(album.picUrl || album.picUrl_str || ''),
      post_text: JSON.stringify(payload, null, 2),
    });
  } catch (error) {
    return backendErrorResult(error, { platform: 'netease_music', url: info.url, song_id: info.id });
  }
}

async function readWechatArticlePost(args = {}, options = {}) {
  const mediaResult = await callMediaReaderTool('resolve_platform_media', {
    url_or_text: args.url || '',
    platform: 'wechat_article',
    media_detail: 'standard',
    include_comments: false,
    max_comments: 0,
    max_assets: 20,
  }, options);
  const structured = mediaResult.structuredContent || {};
  if (structured.ok === false || mediaResult.isError) {
    return buildErrorResult(structured.error || structured.error_code || 'WECHAT_ARTICLE_EXTRACT_FAILED', {
      platform: 'wechat_article',
      captcha_detected: structured.captcha_detected === true,
      error_code: structured.error_code || 'WECHAT_ARTICLE_EXTRACT_FAILED',
      recovery_suggestion: structured.recovery_suggestion || '',
      http_status: structured.http_status,
    });
  }
  return buildTextResult({
    ok: true,
    platform: 'wechat_article',
    url: structured.resolved_url_redacted || structured.original_url_redacted || args.url || '',
    source: 'media_reader.resolve_platform_media',
    include_comments: false,
    max_comments: 0,
    comments_supported: false,
    post_text: structured.post_text || '',
    comments_text: '',
    platform_media: structured,
  });
}

function partialSocialFailureResult({ platform, url, failure, env }) {
  const errorCode = String(failure?.error_code || 'SOCIAL_READER_PARTIAL_FAILURE');
  const cookieDiag = platform === 'xhs' ? xhsCookieDiagnostics(env || process.env) : undefined;
  const partialFailure = {
    asset_id: 'platform-1',
    error_code: errorCode,
    error: failure?.error || `${errorCode}: platform read failed`,
    platform,
    captcha_detected: failure?.captcha_detected === true,
    recovery_suggestion: failure?.recovery_suggestion || '',
    cookie_diagnostics: cookieDiag,
  };
  return buildTextResult({
    ok: true,
    partial: true,
    platform,
    url,
    source: 'social_reader_partial_failure',
    include_comments: false,
    max_comments: 0,
    media_detail: 'standard',
    post_text: '',
    comments_text: '',
    media_assets: [],
    media_analysis: {
      ok: true,
      partial: true,
      items: [],
      merged_summary: '',
      timeline: [],
      partial_failures: [partialFailure],
      warnings: [errorCode],
    },
    deep_summary: '',
    partial_failures: [partialFailure],
    warnings: [errorCode, 'MEDIA_ANALYSIS_PARTIAL'],
  });
}

async function readSocialPost(args = {}, options = {}) {
  const extracted = extractFirstUrl(args.url || '');
  if (!extracted.url) {
    return buildErrorResult('NO_URL_FOUND: no URL found in share text', { error_code: 'NO_URL_FOUND' });
  }
  const platform = detectSocialPlatform(extracted.url);
  const includeComments = args.include_comments === true;
  const maxComments = normalizeMaxComments(args.max_comments);

  if (platform === 'xhs') {
    const resolved = await resolveXhsShareUrl(args.url, options);
    if (!resolved.ok) {
      return buildErrorResult(resolved.error || resolved.error_code, resolved);
    }
    return await readXhsPost({
      rawText: String(args.url || ''),
      resolved,
      includeComments,
      maxComments,
    }, options);
  }

  if (platform === 'bilibili') {
    return await readBilibiliPost({
      rawText: String(args.url || ''),
      includeComments,
      maxComments,
    }, options);
  }

  if (platform === 'netease_music') {
    return await readMusicShare(args, options);
  }

  if (platform === 'wechat_article') {
    return await readWechatArticlePost(args, options);
  }

  if (platform === 'unknown') {
    return buildErrorResult('UNSUPPORTED_PLATFORM: unsupported social URL host', { error_code: 'UNSUPPORTED_PLATFORM', url: extracted.url });
  }

  const resolvedUrl = await defaultResolveUrl(extracted.url, {
    timeoutMs: resolveTimeoutMs(options.env),
    fetchImpl: options.fetchImpl,
  });

  return await readGenericSocialPost({
    url: resolvedUrl || extracted.url,
    platform,
    includeComments,
    maxComments,
  }, options);
}

function normalizeMediaDetail(value) {
  const text = String(value || 'standard').trim().toLowerCase();
  return ['none', 'basic', 'standard', 'full'].includes(text) ? text : 'standard';
}

function collectMediaUrlsFromValue(value, output = []) {
  if (!value) {
    return output;
  }
  if (typeof value === 'string') {
    const urls = value.match(/https?:\/\/[^\s"'<>【】「」《》，。！？、；：]+/ig) || [];
    for (const url of urls) {
      output.push(url.replace(/[，。！？、；：）)\]}】》」'".]+$/u, ''));
    }
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectMediaUrlsFromValue(item, output);
    }
    return output;
  }
  if (typeof value === 'object') {
    for (const key of ['url', 'url_png', 'url_webp', 'thumbnail', 'cover_image', 'media_url', 'image_url', 'video_url', 'audio_url', 'src', 'cover_url']) {
      if (typeof value[key] === 'string') {
        collectMediaUrlsFromValue(value[key], output);
      }
    }
    for (const key of ['media', 'media_list', 'medias', 'images', 'videos', 'audios', 'attachments', 'data']) {
      if (value[key]) {
        collectMediaUrlsFromValue(value[key], output);
      }
    }
  }
  return output;
}

function extractMediaUrlsFromPostText(postText) {
  const text = String(postText || '');
  const output = [];
  try {
    collectMediaUrlsFromValue(JSON.parse(text), output);
  } catch {
    collectMediaUrlsFromValue(text, output);
  }
  return [...new Set(output)];
}

function extractMediaUrlsFromSocialPayload(social) {
  const output = extractMediaUrlsFromPostText(social?.post_text || '');
  collectMediaUrlsFromValue(social?.images, output);
  collectMediaUrlsFromValue(social?.media, output);
  collectMediaUrlsFromValue(social?.media_list, output);
  collectMediaUrlsFromValue(social?.medias, output);
  collectMediaUrlsFromValue(social?.videos, output);
  collectMediaUrlsFromValue(social?.audios, output);
  collectMediaUrlsFromValue(social?.attachments, output);
  return [...new Set(output)];
}

async function callMediaReaderTool(toolName, toolArguments = {}, options = {}) {
  if (typeof options.mediaReaderCallImpl === 'function') {
    return await options.mediaReaderCallImpl({ toolName, arguments: toolArguments });
  }
  const env = options.env || process.env;
  return await callMcpToolViaStdio({
    command: env.MEDIA_READER_MCP_COMMAND || 'bash',
    args: parseJsonArrayEnv(env.MEDIA_READER_MCP_ARGS_JSON, ['scripts/start_media_reader_mcp.sh']),
    env: process.env,
    toolName,
    arguments: toolArguments,
    timeoutMs: resolveTimeoutMs(env),
  });
}

async function readSocialPostDeep(args = {}, options = {}) {
  const extracted = extractFirstUrl(args.url || '');
  const detectedPlatform = detectSocialPlatform(extracted.url || args.url || '');
  const debug = args.debug === true;
  const env = options.env || process.env;

  // XHS: two-path approach (detail + media independently)
  if (detectedPlatform === 'xhs') {
    return await readXhsPostDeep({ extracted, args, debug, env }, options);
  }

  // Non-XHS: original flow
  let socialResult = await readSocialPost(args, options);
  if (socialResult.structuredContent?.ok === false) {
    if (detectedPlatform === 'wechat_article') {
      return partialSocialFailureResult({
        platform: 'wechat_article',
        url: extracted.url || args.url || '',
        failure: socialResult.structuredContent || {},
        env: options.env,
      });
    }
    if (['bilibili', 'wechat_article'].includes(detectedPlatform)) {
      const platformResult = await callMediaReaderTool('resolve_platform_media', {
        url_or_text: args.url || '',
        platform: detectedPlatform,
        media_detail: normalizeMediaDetail(args.media_detail),
        include_comments: args.include_comments === true,
        max_comments: normalizeMaxComments(args.max_comments),
        max_assets: Number(args.max_media_assets || 20),
      }, options);
      if (platformResult.structuredContent?.ok === true) {
        const platformMedia = platformResult.structuredContent;
        socialResult = buildTextResult({
          ok: true,
          platform: platformMedia.platform,
          url: extracted.url || args.url || '',
          source: 'media_reader.resolve_platform_media',
          include_comments: args.include_comments === true,
          max_comments: normalizeMaxComments(args.max_comments),
          post_text: platformMedia.post_text || '',
          comments_text: Array.isArray(platformMedia.comments) ? platformMedia.comments.join('\n') : '',
          platform_media: platformMedia,
        });
      } else {
        return partialSocialFailureResult({
          platform: detectedPlatform,
          url: extracted.url || args.url || '',
          failure: platformResult.structuredContent || socialResult.structuredContent || {},
          env: options.env,
        });
      }
    } else {
      return socialResult;
    }
  }
  const social = socialResult.structuredContent || {};
  const mediaDetail = normalizeMediaDetail(args.media_detail);
  const includeMedia = args.include_media !== false && mediaDetail !== 'none';
  const maxMediaAssets = Number(args.max_media_assets || 20);
  let mediaAnalysis = {
    ok: true,
    partial: false,
    items: [],
    merged_summary: '',
    timeline: [],
    partial_failures: [],
    warnings: [],
  };
  const mediaUrls = includeMedia ? extractMediaUrlsFromSocialPayload(social) : [];
  const platformAsset = includeMedia && ['bilibili'].includes(social.platform || detectedPlatform)
    ? [{
      asset_id: 'platform-1',
      type: 'platform',
      url: extracted.url || social.url || args.url || '',
      platform: social.platform || detectedPlatform,
      source: 'social_reader_deep',
    }]
    : [];
  const assets = includeMedia
    ? [
      ...platformAsset,
      ...buildMediaAssets({
      mediaUrls,
      platform: social.platform || '',
      maxAssets: Number(args.max_media_assets || 20),
    }),
    ]
    : [];

  if (includeMedia && assets.length > 0) {
    const mediaResult = await callMediaReaderTool('analyze_media_batch', {
      assets,
      media_detail: mediaDetail,
      max_assets: Number(args.max_media_assets || 20),
      task: 'summarize_social_post_media',
    }, options);
    mediaAnalysis = mediaResult.structuredContent || mediaResult;
  }

  const deepSummary = [
    social.post_text ? `正文: ${social.post_text}` : '',
    social.comments_text ? `评论: ${social.comments_text}` : '',
    mediaAnalysis?.merged_summary ? `媒体: ${mediaAnalysis.merged_summary}` : '',
  ].filter(Boolean).join('\n\n');

  return buildTextResult({
    ok: true,
    platform: social.platform || detectSocialPlatform(args.url || ''),
    url: social.url || args.url || '',
    source: social.source || '',
    include_comments: args.include_comments === true,
    max_comments: normalizeMaxComments(args.max_comments),
    media_detail: mediaDetail,
    post_text: social.post_text || '',
    comments_text: social.comments_text || '',
    media_assets: assets,
    media_analysis: mediaAnalysis,
    deep_summary: deepSummary,
    warnings: [
      ...(Array.isArray(mediaAnalysis?.warnings) ? mediaAnalysis.warnings : []),
      ...(mediaAnalysis?.partial ? ['MEDIA_ANALYSIS_PARTIAL'] : []),
    ],
  });
}

// XHS two-path deep read: detail (structured text) + media (wanyi-watermark) independently
async function readXhsPostDeep({ extracted, args, debug, env }, options = {}) {
  const url = extracted.url || args.url || '';
  const resolved = { ...extractFirstUrl(url), resolved_url: '', canonical_url: '' };

  // Resolve the URL first
  const resolvedXhs = await resolveXhsShareUrl(url, options);
  if (resolvedXhs.ok) {
    resolved.resolved_url = resolvedXhs.resolved_url || '';
    resolved.canonical_url = resolvedXhs.canonical_url || resolvedXhs.resolved_url || '';
    resolved.note_id = resolvedXhs.note_id || '';
    resolved.xsec_token = resolvedXhs.xsec_token || '';
    resolved.xsec_source = resolvedXhs.xsec_source || '';
  }

  const noteId = resolved.note_id || '';
  const cachedEntry = noteId ? getCachedXhsNoteToken(noteId, options) : null;
  const hasCookie = Boolean(String(env.XHS_COOKIE || '').trim());

  // Determine media URLs for wanyi fallback (priority: original short link > canonical > resolved)
  const wanyiUrl = url || resolved.resolved_url || '';

  // Run both paths in parallel
  const [detailResult, mediaResult] = await Promise.allSettled([
    // Path 1: Detail (structured text)
    runXhsDetailPath({ url, resolved, cachedEntry, hasCookie, env, args }, options),
    // Path 2: Media (wanyi-watermark)
    runXhsMediaPath({ wanyiUrl, resolved, env }, options),
  ]);

  const detail = detailResult.status === 'fulfilled' ? detailResult.value : { ok: false, error_code: 'DETAIL_EXCEPTION', message: String(detailResult.reason) };
  const media = mediaResult.status === 'fulfilled' ? mediaResult.value : { ok: false, error_code: 'MEDIA_EXCEPTION', message: String(mediaResult.reason) };

  const detailOk = detail?.ok === true;
  const mediaOk = media?.ok === true;

  // Build diagnostics
  const diagnostics = {
    detail_backend: {
      name: detail?.source || 'unknown',
      ok: detailOk,
      error_code: detail?.error_code || '',
      message: detail?.message || '',
      raw_fields_seen: detail?.raw_fields_seen || {},
      used_cached_token: detail?.used_cached_token || false,
      used_canonical_url: detail?.used_canonical_url || false,
    },
    media_backend: {
      name: 'wanyi-watermark',
      ok: mediaOk,
      error_code: media?.error_code || '',
      message: media?.message || '',
      media_count: normalizeXhsMedia(media).images.length + normalizeXhsMedia(media).videos.length,
      raw_fields_seen: media?.raw_fields_seen || {},
    },
  };

  if (debug) {
    diagnostics.detail_raw_preview = detail ? sanitizeRawPreview(JSON.stringify(detail)) : '';
    diagnostics.media_raw_preview = media ? sanitizeRawPreview(JSON.stringify(media)) : '';
  }

  const detailMedia = detailOk ? normalizeXhsMedia(detail) : { images: [], videos: [], media: [], cover_image: '' };
  const mediaPathItems = mediaOk && Array.isArray(media.media) && media.media.length > 0
    ? media.media
    : [
      ...(mediaOk ? (media.images || []) : []),
      ...(mediaOk ? (media.videos || []) : []),
    ];
  const normalizedMediaItems = mergeXhsMediaItems([...mediaPathItems, ...detailMedia.media]);
  const images = normalizedMediaItems.filter((item) => item.type === 'image');
  const videos = normalizedMediaItems.filter((item) => item.type === 'video');
  const mediaCount = normalizedMediaItems.length;
  const mediaDetail = normalizeMediaDetail(args.media_detail);
  const includeMedia = args.include_media !== false && mediaDetail !== 'none';
  const maxMediaAssets = Number(args.max_media_assets || 20);
  let mediaAnalysis = {
    ok: true,
    partial: false,
    items: [],
    merged_summary: '',
    timeline: [],
    partial_failures: [],
    warnings: [],
  };
  const totalMediaCount = normalizedMediaItems.filter((item) => item?.url).length;
  const mediaAssets = includeMedia
    ? buildMediaAssetsFromXhsItems({
      mediaItems: normalizedMediaItems,
      platform: 'xhs',
      maxAssets: maxMediaAssets,
    })
    : [];
  const analyzedMediaCount = mediaAssets.length;
  let successfulMediaCount = 0;
  const truncatedByMaxAssets = includeMedia && totalMediaCount > analyzedMediaCount;
  if (includeMedia && mediaAssets.length > 0) {
    const mediaResult = await callMediaReaderTool('analyze_media_batch', {
      assets: mediaAssets,
      media_detail: mediaDetail,
      max_assets: maxMediaAssets,
      task: 'summarize_social_post_media',
    }, options);
    mediaAnalysis = mediaResult.structuredContent || mediaResult;
    successfulMediaCount = Array.isArray(mediaAnalysis?.items) ? mediaAnalysis.items.length : 0;
  }
  const mediaAnalysisPartial = mediaAnalysis?.partial === true;
  const partialMediaRead = truncatedByMaxAssets
    || mediaAnalysisPartial
    || (includeMedia && analyzedMediaCount > successfulMediaCount);

  // Both failed
  if (!detailOk && !mediaOk) {
    return buildTextResult({
      ok: false,
      partial_success: false,
      platform: 'xhs',
      note_id: noteId,
      url,
      error_code: detail?.error_code || media?.error_code || 'XHS_DEEP_READ_FAILED',
      message: `Detail: ${detail?.message || 'failed'}. Media: ${media?.message || 'failed'}.`,
      images: [],
      videos: [],
      media: [],
      media_assets: [],
      media_analysis: mediaAnalysis,
      diagnostics,
    });
  }

  // Detail ok but no media
  if (detailOk && mediaCount === 0) {
    const title = detail?.title || detail?.note_title || '';
    const desc = detail?.desc || detail?.content || detail?.post_text || '';
    return buildTextResult({
      ok: true,
      partial_success: false,
      quality: 'low',
      platform: 'xhs',
      note_id: noteId,
      url,
      source: detail?.source || 'xhs_browse',
      title,
      desc,
      tags: detail?.tags || [],
      images,
      videos,
      media: normalizedMediaItems,
      media_assets: [],
      media_analysis: mediaAnalysis,
      post_text: detail?.post_text || desc,
      comments_text: detail?.comments_text || '',
      diagnostics,
    });
  }

  // Merge results (detail ok + media ok, or detail failed + media ok)
  const title = detailOk ? (detail?.title || detail?.note_title || media?.title || '') : (media?.title || '');
  const desc = detailOk ? (detail?.desc || detail?.content || detail?.post_text || media?.desc || '') : (media?.desc || '');
  const tags = detailOk ? (detail?.tags || []) : [];

  return buildTextResult({
    ok: true,
    partial_success: (!detailOk && mediaOk) || partialMediaRead,
    platform: 'xhs',
    note_id: noteId,
    url,
    source: detailOk ? (detail?.source || 'xhs_browse') : 'wanyi-watermark',
    title,
    desc,
    tags,
    images,
    videos,
    media: normalizedMediaItems,
    media_assets: mediaAssets,
    media_analysis: mediaAnalysis,
    post_text: detailOk ? (detail?.post_text || desc) : '',
    comments_text: detail?.comments_text || '',
    message: !detailOk && mediaOk ? '正文未完整获取，但媒体资源已获取' : undefined,
    media_count: mediaCount,
    total_media_count: totalMediaCount,
    analyzed_media_count: analyzedMediaCount,
    successful_media_count: successfulMediaCount,
    truncated_by_max_assets: truncatedByMaxAssets,
    warnings: [
      ...(Array.isArray(mediaAnalysis?.warnings) ? mediaAnalysis.warnings : []),
      ...(truncatedByMaxAssets ? ['XHS_MEDIA_ASSETS_TRUNCATED_BY_MAX_ASSETS'] : []),
      ...(mediaAnalysisPartial ? ['MEDIA_ANALYSIS_PARTIAL'] : []),
    ],
    deep_summary: [
      detailOk ? (detail?.post_text || desc) : '',
      mediaAnalysis?.merged_summary ? `媒体: ${mediaAnalysis.merged_summary}` : '',
    ].filter(Boolean).join('\n\n'),
    diagnostics,
  });
}

// Detail path: try xhs_browse_note or jobson get_note_content
async function runXhsDetailPath({ url, resolved, cachedEntry, hasCookie, env, args }, options = {}) {
  const noteId = resolved.note_id || '';
  let detailCachedEntry = cachedEntry;
  let xsecToken = detailCachedEntry?.xsecToken || resolved.xsec_token || '';
  let canonicalUrl = detailCachedEntry?.canonical_url || resolved.canonical_url || '';

  if (!xsecToken && noteId) {
    const prepared = await prepareXhsBackendUrl({ rawText: args.url || url, resolved }, options);
    if (prepared?.ok === true) {
      detailCachedEntry = getCachedXhsNoteToken(noteId, options) || detailCachedEntry;
      xsecToken = detailCachedEntry?.xsecToken || parseXhsUrlInfo(prepared.backend_url || '').xsec_token || '';
      canonicalUrl = detailCachedEntry?.canonical_url || prepared.backend_url || canonicalUrl;
    }
  }

  // Try xhs_browse_note first (uses cache or the token-bearing canonical URL)
  if (noteId && xsecToken) {
    try {
      const browseResult = await xhsBrowseNote({
        note_id: noteId,
        url: canonicalUrl || resolved.canonical_url || url,
        include_images: true,
      }, { ...options, xhsBrowseSkipMinInterval: true });
      if (browseResult?.ok === true || browseResult?.structuredContent?.ok === true) {
        const data = browseResult.structuredContent || browseResult;
        const normalized = normalizeXhsMedia({ ...data, source: 'xhs_browse' });
        return {
          ok: true,
          source: 'xhs_browse',
          title: data.title || '',
          desc: data.content || data.desc || '',
          post_text: data.content || data.desc || '',
          tags: data.tags || [],
          images: normalized.images,
          videos: normalized.videos,
          media: normalized.media,
          cover_image: normalized.cover_image,
          comments_text: data.comments_text || '',
          used_cached_token: Boolean(detailCachedEntry?.xsecToken),
          used_canonical_url: Boolean(detailCachedEntry?.canonical_url || canonicalUrl),
          raw_fields_seen: extractRawFieldsSeen(data),
        };
      }
    } catch (e) {
      // Fall through to jobson
    }
  }

  // Try jobson get_note_content with canonical URL
  if (!xsecToken) {
    return {
      ok: false,
      error_code: 'XHS_DETAIL_TOKEN_MISSING',
      message: 'Skipping token-aware XHS detail backend because no xsec_token is available',
      source: 'jobson-xhs-mcp',
    };
  }
  if (canonicalUrl || url) {
    try {
      const postResult = await callBackendMcpTool('xhs', 'get_note_content', { url: canonicalUrl || url }, options);
      const postText = textFromMcpResult(postResult);
      const postTextError = xhsBackendTextError(postText, 'get_note_content');
      if (!postTextError) {
        return {
          ok: true,
          source: 'jobson-xhs-mcp',
          post_text: postText,
          desc: postText,
          used_cached_token: Boolean(detailCachedEntry?.xsecToken),
          used_canonical_url: Boolean(canonicalUrl),
          raw_fields_seen: { desc: Boolean(postText) },
        };
      }
      return { ok: false, error_code: postTextError.error_code, message: postTextError.message, source: 'jobson-xhs-mcp' };
    } catch (e) {
      return { ok: false, error_code: 'XHS_BACKEND_EXCEPTION', message: e instanceof Error ? e.message : String(e), source: 'jobson-xhs-mcp' };
    }
  }

  return { ok: false, error_code: 'XHS_NO_DETAIL_SOURCE', message: 'No note_id or URL for detail path' };
}

// Media path: wanyi-watermark generic parser (independent of detail)
async function runXhsMediaPath({ wanyiUrl, resolved, env }, options = {}) {
  const envRef = options.env || env || process.env;
  const xhsTimeoutMs = resolveXhsBackendTimeoutMs(envRef);
  const xhsFallbackConfig = getXhsFallbackServerConfig(envRef);
  // Priority: original short link > canonical URL
  const urls = [wanyiUrl, resolved?.canonical_url, resolved?.resolved_url].filter(Boolean);
  const uniqueUrls = [...new Set(urls)];

  for (const tryUrl of uniqueUrls) {
    try {
      if (!xhsFallbackConfig) continue;
      const result = await readGenericSocialPost({
        url: tryUrl,
        platform: 'xhs',
        includeComments: false,
        maxComments: 0,
      }, { ...options, xhsTimeoutMs, _xhsFallbackConfig: xhsFallbackConfig });
      if (result?.structuredContent?.ok === true) {
        const data = result.structuredContent;
        const normalized = normalizeXhsMedia(data);
        const mediaCount = normalized.images.length + normalized.videos.length;
        if (mediaCount > 0) {
          return {
            ok: true,
            source: 'wanyi-watermark',
            title: data.title || '',
            desc: data.post_text || data.desc || '',
            images: normalized.images,
            videos: normalized.videos,
            media: normalized.media,
            cover_image: normalized.cover_image,
            raw_fields_seen: extractRawFieldsSeen(data),
          };
        }
        // wanyi returned success but no media
        return {
          ok: false,
          error_code: 'WANYI_NO_MEDIA',
          message: 'wanyi returned success but no normalized media resources',
          source: 'wanyi-watermark',
          raw_fields_seen: extractRawFieldsSeen(data),
        };
      }
    } catch {
      // Try next URL
    }
  }

  return { ok: false, error_code: 'WANYI_MEDIA_FAILED', message: 'wanyi-watermark failed for all URL variants' };
}

function mergeXhsMediaItems(items = []) {
  const merged = [];
  const seen = new Set();
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const url = String(item.url || '').trim();
    if (!url) continue;
    const type = String(item.type || 'media').trim().toLowerCase() || 'media';
    const key = `${type}:${url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({ ...item, type, url });
  }
  return merged;
}

function buildMediaAssetsFromXhsItems({ mediaItems = [], platform = '', maxAssets = 20 } = {}) {
  const typedItems = mergeXhsMediaItems(mediaItems).slice(0, maxAssets);
  const typeCounts = new Map();
  return typedItems.map((item) => {
    const rawType = String(item.type || '').trim().toLowerCase();
    const type = ['image', 'video', 'audio', 'platform'].includes(rawType) ? rawType : 'media';
    const count = (typeCounts.get(type) || 0) + 1;
    typeCounts.set(type, count);
    const url = String(item.url || '').trim();
    return {
      asset_id: `${type}-${count}`,
      type,
      url,
      url_host: hostFromUrl(url),
      url_redacted: redactUrl(url),
      source: platform ? `social_reader:${platform}` : 'explicit_url',
    };
  });
}

// Normalize wanyi media output to standard format
function normalizeXhsMedia(mediaResult) {
  if (!mediaResult || mediaResult.ok === false) return { images: [], videos: [], media: [], cover_image: '' };

  const images = [];
  const videos = [];
  const seen = new Set();

  const resultType = String(mediaResult.type || '').trim().toLowerCase();
  const resultPlatform = String(mediaResult.platform || '').trim().toLowerCase();
  const sourceBackend = mediaResult.source_backend
    || mediaResult.source
    || (resultPlatform === 'generic' ? 'wanyi-watermark-generic' : 'wanyi-watermark');

  function pushImage(item = {}, fallbackSource = sourceBackend) {
    if (!item || typeof item !== 'object') return;
    const url = firstString(
      item.url_png,
      item.url_webp,
      item.url,
      item.urlDefault,
      item.url_default,
      item.imageUrl,
      item.image_url,
      item.src,
      item.urlPre,
      item.url_pre,
      item.thumbnail,
      item.cover_image
    );
    if (!url || seen.has(`image:${url}`)) return;
    seen.add(`image:${url}`);
    images.push({
      type: 'image',
      url,
      url_png: item.url_png || '',
      url_webp: item.url_webp || '',
      thumbnail: firstString(item.thumbnail, item.cover_image, item.urlPre, item.url_pre, item.url_webp),
      width: Number(item.width) || 0,
      height: Number(item.height) || 0,
      source_backend: item.source_backend || fallbackSource,
    });
  }

  function pushVideo(item = {}, fallbackSource = sourceBackend) {
    if (!item || typeof item !== 'object') return;
    const url = firstString(item.url, item.video_url, item.media_url, item.src);
    if (!url || seen.has(`video:${url}`)) return;
    seen.add(`video:${url}`);
    videos.push({
      type: 'video',
      url,
      title: item.title || mediaResult.title || '',
      caption: item.caption || mediaResult.caption || '',
      thumbnail: item.thumbnail || item.cover_image || item.cover_url || '',
      source_url: item.source_url || mediaResult.source_url || '',
      width: Number(item.width) || 0,
      height: Number(item.height) || 0,
      source_backend: item.source_backend || fallbackSource,
    });
  }

  // 1. XHS image note: images[].url_png / images[].url_webp
  if (Array.isArray(mediaResult.images)) {
    for (const img of mediaResult.images) {
      pushImage(img, sourceBackend);
    }
  }

  // 2. XHS video note: type=video, url field
  if (resultType === 'video' && mediaResult.url) {
    pushVideo(mediaResult, sourceBackend);
  }

  // 3. Generic fallback video: platform=generic, url + source_url
  if (resultPlatform === 'generic' && mediaResult.url && resultType !== 'video') {
    pushVideo(mediaResult, 'wanyi-watermark-generic');
  }

  for (const { list, forceType } of [
    { list: mediaResult.media, forceType: '' },
    { list: mediaResult.media_list, forceType: '' },
    { list: mediaResult.medias, forceType: '' },
    { list: mediaResult.videos, forceType: 'video' },
  ]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const type = String(item?.type || '').trim().toLowerCase();
      if (forceType === 'video' || type === 'video') {
        pushVideo(item, sourceBackend);
      } else if (type === 'image' || item?.url_png || item?.url_webp || item?.urlDefault || item?.urlPre || item?.url_default || item?.url_pre || item?.thumbnail || item?.image_url || item?.imageUrl) {
        pushImage(item, sourceBackend);
      } else {
        pushVideo(item, sourceBackend);
      }
    }
  }

  const coverImage = firstString(
    mediaResult.cover_image,
    mediaResult.cover_url,
    mediaResult.thumbnail,
    images[0]?.thumbnail,
    images[0]?.url,
    videos[0]?.thumbnail
  );
  return { images, videos, media: [...images, ...videos], cover_image: coverImage };
}

function xhsCookieDiagnostics(env) {
  const cookie = String(env.XHS_COOKIE || '').trim();
  if (!cookie) return { status: 'MISSING', error_code: 'XHS_COOKIE_MISSING' };
  const len = cookie.length;
  // Simple sha256 prefix for diagnostic (no crypto import needed)
  let hash = 0;
  for (let i = 0; i < Math.min(cookie.length, 256); i++) {
    hash = ((hash << 5) - hash + cookie.charCodeAt(i)) | 0;
  }
  const hashPrefix = Math.abs(hash).toString(16).slice(0, 12).padStart(12, '0');
  return { status: 'SET', len, hash_prefix: hashPrefix };
}

async function readXhsPost({ rawText, resolved, includeComments, maxComments }, options = {}) {
  const env = options.env || process.env;
  const hasCookie = String(env.XHS_COOKIE || '').trim();
  const cookieDiag = xhsCookieDiagnostics(env);
  const genericFallbackEnabled = String(env.SOCIAL_READER_GENERIC_FALLBACK_ENABLED || 'true') !== 'false';
  const xhsTimeoutMs = resolveXhsBackendTimeoutMs(env);
  if (genericFallbackEnabled) {
    const xhsFallbackConfig = getXhsFallbackServerConfig(env);
    if (xhsFallbackConfig) {
      for (const candidateUrl of buildXhsReadUrlCandidates({ rawText, resolved })) {
        const generic = await readGenericSocialPost({
          url: candidateUrl,
          platform: 'xhs',
          includeComments,
          maxComments,
        }, {
          ...options,
          xhsTimeoutMs,
          _xhsFallbackConfig: xhsFallbackConfig,
        });
        if (generic.structuredContent?.ok === true) {
          generic.structuredContent.primary = true;
          generic.content[0].text = JSON.stringify(generic.structuredContent, null, 2);
          return generic;
        }
      }
    } else {
      return buildTextResult({
        ok: true,
        partial: true,
        content_available: false,
        full_text_available: false,
        evidence_level: 'metadata_only',
        should_answer_from_content: false,
        platform: 'xhs',
        url: resolved.resolved_url || resolved.canonical_url || resolved.original_url || String(rawText || ''),
        note_id: resolved.note_id || '',
        source: 'partial_fallback',
        post_text: '',
        comments_text: '',
        error_code: 'XHS_GENERIC_FALLBACK_NOT_READY',
        warnings: [
          { code: 'XHS_GENERIC_FALLBACK_NOT_READY', message: 'Generic fallback tool not prepared; run scripts/prepare-xhs-generic-fallback.sh' },
          { code: 'PARTIAL_RESULT', message: 'Returning URL and metadata only; full content unavailable' },
        ],
        fallback_chain: ['generic_marker', 'partial'],
      });
    }
  }
  if (!hasCookie) {
    return buildErrorResult('LOGIN_REQUIRED: XHS_COOKIE is required for xhs content/comments', {
      error_code: 'XHS_COOKIE_MISSING',
      platform: 'xhs',
      cookie_diagnostics: cookieDiag,
      hint: 'Set XHS_COOKIE in .env.local. Cookie may expire periodically; re-login to xiaohongshu.com and copy fresh cookie.',
    });
  }

  const prepared = await prepareXhsBackendUrl({ rawText, resolved }, options);
  if (!prepared.ok) {
    if (prepared.error_code === 'AMBIGUOUS_SEARCH_RESULT') {
      return buildErrorResult(prepared.error || prepared.error_code, {
        ...prepared,
        platform: 'xhs',
        url: resolved.resolved_url || resolved.original_url || String(rawText),
      });
    }
    if (genericFallbackEnabled) {
      const xhsFallbackConfig = getXhsFallbackServerConfig(env);
      if (xhsFallbackConfig) {
        return await readGenericSocialPost({ url: resolved.resolved_url || resolved.original_url || String(rawText), platform: 'xhs', includeComments, maxComments }, { ...options, _xhsFallbackConfig: xhsFallbackConfig });
      }
    }
    return buildErrorResult(prepared.error || prepared.error_code, prepared);
  }
  const url = prepared.backend_url;

  try {
    const postResult = await callBackendMcpTool('xhs', 'get_note_content', { url }, options);
    const postText = textFromMcpResult(postResult);
    const postTextError = xhsBackendTextError(postText, 'get_note_content');
    if (postTextError) {
      const error = new Error(postTextError.message);
      error.error_code = postTextError.error_code;
      throw error;
    }
    let commentsText = '';
    if (includeComments) {
      const commentsResult = await callBackendMcpTool('xhs', 'get_note_comments', { url }, options);
      commentsText = limitCommentBlocks(textFromMcpResult(commentsResult), maxComments);
      const commentsTextError = xhsBackendTextError(commentsText, 'get_note_comments');
      if (commentsTextError) {
        const error = new Error(commentsTextError.message);
        error.error_code = commentsTextError.error_code;
        throw error;
      }
    }
    return buildTextResult({
      ok: true,
      platform: 'xhs',
      url,
      source: 'jobson-xhs-mcp',
      include_comments: includeComments,
      max_comments: maxComments,
      post_text: postText,
      comments_text: commentsText,
    });
  } catch (error) {
    if (genericFallbackEnabled) {
      // Check marker before attempting generic fallback
      const xhsFallbackConfig = getXhsFallbackServerConfig(options.env || process.env);
      if (!xhsFallbackConfig) {
        const errorCode = classifyXhsError(error);
        return buildTextResult({
          ok: true,
          partial: true,
          content_available: false,
          full_text_available: false,
          evidence_level: 'metadata_only',
          should_answer_from_content: false,
          platform: 'xhs',
          url: resolved.resolved_url || resolved.canonical_url || url,
          note_id: resolved.note_id || '',
          source: 'partial_fallback',
          post_text: '',
          comments_text: '',
          warnings: [
            { code: errorCode, message: `XHS backend failed: ${error instanceof Error ? error.message : String(error)}` },
            { code: 'XHS_GENERIC_FALLBACK_NOT_READY', message: 'Generic fallback tool not prepared; run scripts/prepare-xhs-generic-fallback.sh' },
            { code: 'PARTIAL_RESULT', message: 'Returning URL and metadata only; full content unavailable' },
          ],
          fallback_chain: ['jobson_xhs_mcp', 'partial'],
          xhs_error: error instanceof Error ? error.message : String(error),
        });
      }
      // Marker ready — try generic fallback with marker-gated config
      const fallback = await readGenericSocialPost({ url, platform: 'xhs', includeComments, maxComments }, { ...options, _xhsFallbackConfig: xhsFallbackConfig });
      if (fallback.structuredContent?.ok === true) {
        fallback.structuredContent.partial = true;
        fallback.structuredContent.content_available = true;
        fallback.structuredContent.full_text_available = false;
        fallback.structuredContent.evidence_level = 'generic_parser';
        fallback.structuredContent.should_answer_from_content = true;
        fallback.structuredContent.source = 'generic_parser_fallback';
        fallback.structuredContent.xhs_error = error instanceof Error ? error.message : String(error);
        fallback.structuredContent.fallback = true;
        fallback.structuredContent.fallback_from = error?.error_code || 'XHS_BACKEND_EXCEPTION';
        fallback.structuredContent.warnings = [
          { code: 'GENERIC_PARSER_FALLBACK', message: 'Used generic parser after XHS backend failure' },
          { code: 'FULL_TEXT_UNAVAILABLE', message: 'Content from generic parser, not original XHS backend' },
        ];
        fallback.structuredContent.diagnostics = buildXhsDiagnostic({
          platform: 'xhs', url, whichBackend: 'generic_parser', backendToolName: 'wanyi-watermark',
          errorCode: error?.error_code || 'XHS_BACKEND_EXCEPTION',
          backendError: error instanceof Error ? error.message : String(error),
          hasCookie, hasXsecToken: Boolean(resolved.xsec_token),
          usedCachedToken: Boolean(prepared.source === 'xhs_browse_cache'),
          usedCanonicalUrl: Boolean(prepared.backend_url),
          env,
        });
        fallback.content[0].text = JSON.stringify(fallback.structuredContent, null, 2);
        return fallback;
      }
      // Generic parser also failed — return metadata-only partial result
      const errorCode = classifyXhsError(error);
      return buildTextResult({
        ok: true,
        partial: true,
        content_available: false,
        full_text_available: false,
        evidence_level: 'metadata_only',
        should_answer_from_content: false,
        platform: 'xhs',
        url: resolved.resolved_url || resolved.canonical_url || url,
        note_id: resolved.note_id || '',
        source: 'partial_fallback',
        post_text: '',
        comments_text: '',
        warnings: [
          { code: errorCode, message: `XHS backend failed: ${error instanceof Error ? error.message : String(error)}` },
          { code: 'GENERIC_PARSER_FAILED', message: 'Generic parser also failed' },
          { code: 'PARTIAL_RESULT', message: 'Returning URL and metadata only; full content unavailable' },
        ],
        fallback_chain: ['jobson_xhs_mcp', 'wanyi_watermark', 'partial'],
        xhs_error: error instanceof Error ? error.message : String(error),
      });
    }
    return backendErrorResult(error, { platform: 'xhs', url });
  }
}

async function readGenericSocialPost({ url, platform, includeComments, maxComments }, options = {}) {
  const toolName = genericParserToolForPlatform(platform);
  const env = options.env || process.env;
  const timeoutMs = options._overrideTimeoutMs
    || options.xhsTimeoutMs
    || resolveTimeoutMs(env);

  // Use marker-gated config if provided (XHS fallback path), otherwise default
  const xhsConfig = options._xhsFallbackConfig;
  let result;
  try {
    if (xhsConfig) {
      if (typeof options.mcpCallImpl === 'function') {
        result = await options.mcpCallImpl({ server: 'generic', toolName, arguments: { share_link: url } });
      } else {
        result = await callMcpToolViaStdio({
          command: xhsConfig.command,
          args: xhsConfig.args,
          env: { ...process.env, ...xhsConfig.env },
          toolName,
          arguments: { share_link: url },
          timeoutMs,
        });
      }
    } else {
      result = await callBackendMcpTool('generic', toolName, { share_link: url }, {
        ...options,
        ...(options.xhsTimeoutMs ? { _overrideTimeoutMs: options.xhsTimeoutMs } : {}),
      });
    }
    const normalized = normalizeGenericParserPayload(textFromMcpResult(result));
    if (!normalized.ok) {
      return buildErrorResult(normalized.error, {
        platform,
        url,
        source: 'wanyi-watermark-mcp',
        parser_tool: toolName,
        error_code: normalized.error_code,
        parser_status: normalized.parser_status,
      });
    }
    return buildTextResult({
      ok: true,
      platform,
      url,
      source: 'wanyi-watermark-mcp',
      include_comments: includeComments,
      max_comments: maxComments,
      parser_tool: toolName,
      post_text: normalized.post_text,
      comments_text: '',
      comments_supported: false,
      ...(normalized.title ? { title: normalized.title } : {}),
      ...(normalized.note_id ? { note_id: normalized.note_id } : {}),
      ...(normalized.parser_status ? { parser_status: normalized.parser_status } : {}),
      ...(normalized.media_type ? { media_type: normalized.media_type } : {}),
      ...(Array.isArray(normalized.images) && normalized.images.length > 0 ? { images: normalized.images } : {}),
      ...(normalized.media ? { media: normalized.media } : {}),
      ...(normalized.media_list ? { media_list: normalized.media_list } : {}),
      ...(normalized.medias ? { medias: normalized.medias } : {}),
      ...(normalized.videos ? { videos: normalized.videos } : {}),
      ...(normalized.audios ? { audios: normalized.audios } : {}),
      ...(normalized.attachments ? { attachments: normalized.attachments } : {}),
      ...(normalized.image_count !== undefined ? { image_count: normalized.image_count } : {}),
    });
  } catch (error) {
    return backendErrorResult(error, { platform, url });
  }
}

function limitCommentBlocks(text, maxComments) {
  const trimmed = String(text || '').trim();
  if (!trimmed) {
    return '';
  }
  const blocks = trimmed.split(/\n\s*\n/).filter(Boolean);
  if (blocks.length <= maxComments) {
    return trimmed;
  }
  return blocks.slice(0, maxComments).join('\n\n');
}

async function callBackendMcpTool(server, toolName, toolArguments = {}, options = {}) {
  if (typeof options.mcpCallImpl === 'function') {
    return await options.mcpCallImpl({ server, toolName, arguments: toolArguments });
  }
  const env = options.env || process.env;
  const config = server === 'xhs'
    ? xhsServerConfig(env)
    : server === 'bilibili'
      ? bilibiliServerConfig(env)
      : genericParserServerConfig(env);
  const timeoutMs = options._overrideTimeoutMs
    || (server === 'xhs'
      ? resolveXhsBackendTimeoutMs(env)
      : resolveTimeoutMs(env));
  return await callMcpToolViaStdio({
    command: config.command,
    args: config.args,
    env: {
      ...process.env,
      ...config.env,
    },
    toolName,
    arguments: toolArguments,
    timeoutMs,
  });
}

export async function callMcpToolViaStdio({
  command,
  args = [],
  env = process.env,
  toolName,
  arguments: toolArguments = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  return await new Promise((resolve, reject) => {
    const targetId = 2;
    const child = spawn(command, args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finishReject(new Error(`MCP backend timed out after ${timeoutMs}ms: ${command}`));
    }, timeoutMs);

    function finishResolve(value) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.kill('SIGTERM');
      resolve(value);
    }

    function finishReject(error) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    }

    const rl = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }
      let payload;
      try {
        payload = JSON.parse(trimmed);
      } catch {
        return;
      }
      if (payload.id === targetId) {
        if (payload.error) {
          finishReject(new Error(payload.error.message || JSON.stringify(payload.error)));
        } else {
          finishResolve(payload.result);
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', finishReject);
    child.on('exit', (code, signal) => {
      if (!settled && code !== 0) {
        finishReject(new Error(`MCP backend exited code=${code} signal=${signal || ''}: ${stderr.trim()}`));
      } else if (!settled) {
        finishReject(new Error(`Backend exited without JSON-RPC response: code=${code} signal=${signal || ''}: ${stderr.trim()}`));
      }
    });

    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'ran-agent-social-reader', version: '0.1.0' },
      },
    })}\n`);
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
      params: {},
    })}\n`);
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: targetId,
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: toolArguments,
      },
    })}\n`);
  });
}

async function callTool(name, args = {}, options = {}) {
  if (String(name || '').startsWith('xhs_browse_') && !shouldExposeXhsBrowseTools(options.env || process.env)) {
    return buildErrorResult('XHS browse tools are hidden. Set SOCIAL_READER_EXPOSE_XHS_BROWSE_TOOLS=true to enable diagnostics.', {
      error_code: 'XHS_BROWSE_TOOL_HIDDEN',
    });
  }
  if (name === 'resolve_social_url') {
    return await resolveSocialUrl(args.url, options);
  }
  if (name === 'read_social_post') {
    return await readSocialPost(args, options);
  }
  if (name === 'read_social_post_deep') {
    return await readSocialPostDeep(args, options);
  }
  if (name === 'read_music_share') {
    return await readMusicShare(args, options);
  }
  if (name === 'check_social_login') {
    return await checkSocialLogin(String(args.platform || ''), options);
  }
  if (name === 'xhs_browse_probe') {
    const result = await xhsBrowseProbe(args, options);
    return wrapMcpResult(result);
  }
  if (name === 'xhs_browse_search') {
    const result = await xhsBrowseSearch(args, options);
    return wrapMcpResult(result);
  }
  if (name === 'xhs_browse_note') {
    const result = await xhsBrowseNote(args, options);
    return wrapMcpResult(result);
  }
  if (name === 'xhs_browse_user') {
    const result = await xhsBrowseUser(args, options);
    return wrapMcpResult(result);
  }
  if (name === 'xhs_browse_feed') {
    const result = await xhsBrowseFeed(args, options);
    return wrapMcpResult(result);
  }

  return buildErrorResult(`unknown tool: ${name}`);
}

export async function handleSocialReaderMcpRequest(request, options = {}) {
  const method = String(request?.method || '');
  if (method === 'initialize') {
    return {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    };
  }
  if (method === 'tools/list') {
    return { tools: buildSocialReaderTools(options.env || process.env) };
  }
  if (method === 'tools/call') {
    const params = request?.params || {};
    return await callTool(String(params.name || ''), params.arguments || {}, options);
  }
  throw new Error(`unsupported MCP method: ${method}`);
}

function writeJsonRpcResponse(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function writeJsonRpcError(id, error) {
  process.stdout.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: {
      code: -32603,
      message: error instanceof Error ? error.message : String(error),
    },
  })}\n`);
}

export function runSocialReaderMcpServer(options = {}) {
  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });
  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    let request;
    try {
      request = JSON.parse(trimmed);
    } catch (error) {
      writeJsonRpcError(null, error);
      return;
    }
    if (request.id === undefined) {
      return;
    }
    try {
      const result = await handleSocialReaderMcpRequest(request, options);
      writeJsonRpcResponse(request.id, result);
    } catch (error) {
      writeJsonRpcError(request.id, error);
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runSocialReaderMcpServer();
}
// ============================================================================
// XHS Browse 常量和配置
// ============================================================================

const XHS_BROWSE_DEFAULTS = {
  enabled: false,
  maxResults: 5,
  maxResultsHardLimit: 10,
  maxItems: 5,
  maxItemsHardLimit: 10,
  minIntervalMs: 30000,
  maxCallsPerSession: 10,
  timeoutMs: 60000,
  searchEnabled: true,
  noteEnabled: true,
  userEnabled: false,
  feedEnabled: false,
};

const XHS_BROWSE_TOOL_CANDIDATES = {
  search: ['search_notes', 'search_feeds', 'search', 'query_notes', 'search_note', 'xhs_search_note'],
  note: ['get_note_info', 'get_feed_detail', 'get_note', 'note_detail', 'get_note_content', 'xhs_get_note_detail'],
  user: ['get_user_notes', 'user_profile', 'user_homepage'],
  feed: ['get_feed', 'explore', 'recommendation_feed'],
};

const XHS_BROWSE_ERROR_CODES = {
  DISABLED: 'XHS_BROWSE_DISABLED',
  BACKEND_UNAVAILABLE: 'XHS_BROWSE_BACKEND_UNAVAILABLE',
  TOOL_NOT_FOUND: 'XHS_BROWSE_TOOL_NOT_FOUND',
  PROTOCOL_ERROR: 'XHS_BROWSE_PROTOCOL_ERROR',
  SEARCH_FAILED: 'XHS_SEARCH_FAILED',
  NOTE_READ_FAILED: 'XHS_NOTE_READ_FAILED',
  PROFILE_DISABLED: 'XHS_PROFILE_DISABLED',
  PROFILE_FAILED: 'XHS_PROFILE_FAILED',
  FEED_DISABLED: 'XHS_FEED_DISABLED',
  FEED_FAILED: 'XHS_FEED_FAILED',
  AUTH_REQUIRED: 'XHS_AUTH_REQUIRED',
  RISK_CONTROL: 'XHS_RISK_CONTROL',
  RATE_LIMITED: 'XHS_RATE_LIMITED',
  INVALID_ARGUMENT: 'XHS_INVALID_ARGUMENT',
  TIMEOUT: 'XHS_TIMEOUT',
  BACKEND_MCP_ERROR: 'XHS_BACKEND_MCP_ERROR',
};

function xhsBrowseToolMatches(toolName, candidate) {
  const name = String(toolName || '');
  return name === candidate || name.endsWith(`.${candidate}`) || name.endsWith(`_${candidate}`) || name.endsWith(`-${candidate}`);
}

// Session 调用计数（内存中，重启后重置）
let xhsBrowseSessionCallCount = 0;
let xhsBrowseLastCallTime = 0;

// ============================================================================
// XHS Browse 配置读取函数
// ============================================================================

function getXhsBrowseConfig(env = process.env) {
  const enabled = String(env.XHS_BROWSE_ENABLED || 'false').toLowerCase() === 'true';
  const command = String(env.XHS_BROWSE_MCP_COMMAND || '').trim();
  const argsJson = String(env.XHS_BROWSE_MCP_ARGS_JSON || '');
  const cookieEnv = String(env.XHS_BROWSE_MCP_COOKIE_ENV || 'XHS_COOKIE');
  const timeoutMs = Number(env.XHS_BROWSE_MCP_TIMEOUT_MS || XHS_BROWSE_DEFAULTS.timeoutMs);
  const maxResults = Math.min(
    Number(env.XHS_BROWSE_MAX_RESULTS || XHS_BROWSE_DEFAULTS.maxResults),
    XHS_BROWSE_DEFAULTS.maxResultsHardLimit
  );
  const maxItems = Math.min(
    Number(env.XHS_BROWSE_MAX_ITEMS || XHS_BROWSE_DEFAULTS.maxItems),
    XHS_BROWSE_DEFAULTS.maxItemsHardLimit
  );
  const minIntervalMs = Number(env.XHS_BROWSE_MIN_INTERVAL_MS || XHS_BROWSE_DEFAULTS.minIntervalMs);
  const maxCallsPerSession = Number(env.XHS_BROWSE_MAX_CALLS_PER_SESSION || XHS_BROWSE_DEFAULTS.maxCallsPerSession);
  const searchEnabled = String(env.XHS_BROWSE_SEARCH_ENABLED || 'true').toLowerCase() === 'true';
  const noteEnabled = String(env.XHS_BROWSE_NOTE_ENABLED || 'true').toLowerCase() === 'true';
  const userEnabled = String(env.XHS_BROWSE_USER_ENABLED || 'false').toLowerCase() === 'true';
  const feedEnabled = String(env.XHS_BROWSE_FEED_ENABLED || 'false').toLowerCase() === 'true';

  // 获取 Cookie（通过变量名间接引用，不直接存储）
  const cookie = String(env[cookieEnv] || '');

  return {
    enabled,
    command,
    args: parseJsonArrayEnv(argsJson, []),
    cookieEnv,
    cookie,
    timeoutMs,
    maxResults,
    maxItems,
    minIntervalMs,
    maxCallsPerSession,
    searchEnabled,
    noteEnabled,
    userEnabled,
    feedEnabled,
    isConfigured: command && command.length > 0,
  };
}

function xhsBrowseServerConfig(env = process.env) {
  const config = getXhsBrowseConfig(env);
  return {
    command: config.command,
    args: config.args,
    env: config.cookieEnv ? { [config.cookieEnv]: config.cookie } : {},
  };
}

// ============================================================================
// XHS Browse Rate Limiting
// ============================================================================

function checkXhsBrowseRateLimit(config, options = {}) {
  const now = Date.now();
  
  // 检查调用间隔
  if (!options.skipMinInterval && xhsBrowseLastCallTime > 0) {
    const interval = now - xhsBrowseLastCallTime;
    if (interval < config.minIntervalMs) {
      return {
        ok: false,
        error_code: XHS_BROWSE_ERROR_CODES.RATE_LIMITED,
        message: `Rate limited: minimum interval is ${config.minIntervalMs}ms, please wait ${Math.ceil((config.minIntervalMs - interval) / 1000)}s`,
      };
    }
  }

  // 检查 session 调用次数
  if (xhsBrowseSessionCallCount >= config.maxCallsPerSession) {
    return {
      ok: false,
      error_code: XHS_BROWSE_ERROR_CODES.RATE_LIMITED,
      message: `Rate limited: maximum ${config.maxCallsPerSession} calls per session exceeded`,
    };
  }

  // 更新计数
  xhsBrowseLastCallTime = now;
  xhsBrowseSessionCallCount++;

  return null; // 没有限流
}

// ============================================================================
// XHS Browse Backend Adapter
// ============================================================================

async function callXhsBrowseBackend(toolName, args, config, options = {}) {
  if (typeof options.xhsBrowseCallImpl === 'function') {
    return await options.xhsBrowseCallImpl({
      toolName,
      arguments: args,
      config,
    });
  }
  return new Promise((resolve, reject) => {
    if (!config.command || !config.args || config.args.length === 0) {
      resolve({
        ok: false,
        error_code: XHS_BROWSE_ERROR_CODES.BACKEND_UNAVAILABLE,
        message: 'XHS_BROWSE_MCP_COMMAND not configured',
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let child;
    const targetId = toolName === 'probe' ? 2 : 3;

    try {
      child = spawn(config.command, config.args, {
        env: { ...process.env, ...config.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({
        ok: false,
        error_code: XHS_BROWSE_ERROR_CODES.BACKEND_UNAVAILABLE,
        message: `Failed to spawn backend: ${error.message}`,
      });
      return;
    }

    const timeoutHandle = setTimeout(() => {
      if (child) {
        child.kill('SIGTERM');
      }
      resolve({
        ok: false,
        error_code: XHS_BROWSE_ERROR_CODES.TIMEOUT,
        message: `Backend call timeout after ${config.timeoutMs}ms`,
      });
    }, config.timeoutMs);

    let settled = false;
    const finishResolve = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      resolve(result);
    };

    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      reject(error);
    };

    const rl = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });

    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      let payload;
      try {
        payload = JSON.parse(trimmed);
      } catch {
        return;
      }

      // 处理 initialize 响应
      if (payload.id === 1) {
        if (payload.error) {
          finishResolve({
            ok: false,
            error_code: XHS_BROWSE_ERROR_CODES.PROTOCOL_ERROR,
            message: `Initialize failed: ${payload.error.message}`,
          });
        }
        return;
      }

      // 处理 tools/list 响应
      if (payload.id === 2) {
        if (payload.error) {
          finishResolve({
            ok: false,
            error_code: XHS_BROWSE_ERROR_CODES.PROTOCOL_ERROR,
            message: `tools/list failed: ${payload.error.message}`,
          });
        } else {
          finishResolve({
            ok: true,
            available_tools: (payload.result?.tools || []).map(t => t.name),
          });
        }
        return;
      }

      // 处理工具调用响应
      if (payload.id === targetId && targetId === 3) {
        if (payload.error) {
          finishResolve({
            ok: false,
            error_code: XHS_BROWSE_ERROR_CODES.BACKEND_MCP_ERROR,
            message: payload.error.message,
          });
        } else {
          finishResolve({
            ok: true,
            data: payload.result,
          });
        }
        return;
      }
    });

    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.on('error', finishReject);
    child.on('exit', (code, signal) => {
      if (!settled && code !== 0) {
        finishResolve({
          ok: false,
          error_code: XHS_BROWSE_ERROR_CODES.BACKEND_UNAVAILABLE,
          message: `Backend exited with code ${code}: ${stderr.trim()}`,
        });
      } else if (!settled) {
        finishResolve({
          ok: false,
          error_code: XHS_BROWSE_ERROR_CODES.BACKEND_MCP_ERROR,
          message: `Backend exited without JSON-RPC response: code=${code} signal=${signal || ''}: ${stderr.trim()}`,
        });
      }
    });

    // 发送 MCP 协议消息
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'ran-agent-social-reader', version: '0.1.0' },
      },
    }) + '\n');

    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
      params: {},
    }) + '\n');

    // 请求 tools/list
    if (toolName === 'probe') {
      child.stdin.write(JSON.stringify({
        jsonrpc: '2.0',
        id: targetId,
        method: 'tools/list',
        params: {},
      }) + '\n');
    } else {
      // 调用具体工具
      child.stdin.write(JSON.stringify({
        jsonrpc: '2.0',
        id: targetId,
        method: 'tools/call',
        params: {
          name: toolName,
          arguments: args,
        },
      }) + '\n');
    }
  });
}

async function probeXhsBrowseBackend(config, options = {}) {
  if (!config.isConfigured) {
    return {
      ok: false,
      error_code: XHS_BROWSE_ERROR_CODES.BACKEND_UNAVAILABLE,
      message: 'XHS_BROWSE not configured',
    };
  }

  const result = await callXhsBrowseBackend('probe', {}, config, options);
  
  if (!result.ok) {
    return result;
  }

  // 匹配工具名
  const availableTools = result.available_tools || [];
  const matchedTools = {};

  for (const [category, candidates] of Object.entries(XHS_BROWSE_TOOL_CANDIDATES)) {
    for (const candidate of candidates) {
      const matched = availableTools.find((tool) => xhsBrowseToolMatches(tool, candidate));
      if (matched) {
        matchedTools[category] = matched;
        break;
      }
    }
  }

  return {
    ok: true,
    backend: 'xhs_browse',
    command: config.command,
    args: config.args,
    callable_verified: true,
    declared_tools: availableTools,
    available_tools: availableTools,
    matched_tools: matchedTools,
  };
}

function mapXhsBrowseToolName(category, config, matchedTools) {
  if (matchedTools && matchedTools[category]) {
    return matchedTools[category];
  }
  
  const candidates = XHS_BROWSE_TOOL_CANDIDATES[category];
  return candidates ? candidates[0] : category;
}

function parseMcpStructuredData(data) {
  if (!data) return {};
  if (data.structuredContent && typeof data.structuredContent === 'object') {
    return data.structuredContent;
  }
  const text = textFromMcpResult(data);
  if (!text) {
    return data && typeof data === 'object' ? data : {};
  }
  try {
    return JSON.parse(text);
  } catch {
    return { content: text };
  }
}

function parseXhsNoteLookup(args = {}) {
  const readRef = String(args.read_ref || '').trim();
  const fromRef = readRef.match(/^xhs:note:([^:\s]+)$/);
  const rawUrl = String(args.url || '').trim();
  const urlInfo = rawUrl ? parseXhsUrlInfo(rawUrl) : null;
  return {
    noteId: String(args.note_id || '').trim() || (fromRef ? fromRef[1] : '') || urlInfo?.note_id || '',
    readRef,
    url: rawUrl,
    urlInfo,
  };
}

function xhsBrowseBackendArgsForNote(toolName, noteId, entry = {}, includeImages = true) {
  const xsecToken = entry.xsecToken || entry.xsec_token || '';
  const xsecSource = entry.xsec_source || '';
  const canonicalUrl = entry.canonical_url || buildXhsCanonicalUrl(noteId, xsecToken, xsecSource);
  if (xhsBrowseToolMatches(toolName, 'get_note_content')) {
    return { url: canonicalUrl };
  }
  if (xhsBrowseToolMatches(toolName, 'get_feed_detail')) {
    return { feed_id: noteId, xsec_token: xsecToken };
  }
  if (xhsBrowseToolMatches(toolName, 'xhs_get_note_detail')) {
    return { feedId: noteId, xsecToken, include_images: includeImages };
  }
  if (xhsBrowseToolMatches(toolName, 'get_note_info') || xhsBrowseToolMatches(toolName, 'get_note') || xhsBrowseToolMatches(toolName, 'note_detail')) {
    return {
      note_id: noteId,
      xsec_token: xsecToken,
      url: canonicalUrl,
      include_images: includeImages,
    };
  }
  return { feedId: noteId, xsecToken, include_images: includeImages };
}

function xhsObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function hasXhsNoteFields(value) {
  const item = xhsObject(value);
  if (!item) return false;
  const noteCard = xhsObject(item.noteCard) || xhsObject(item.note_card) || {};
  return Boolean(
    item.id || item.note_id || item.title || item.displayTitle || item.display_title
    || item.content || item.desc || item.description || item.post_text
    || item.images || item.image_list || item.imageList
    || noteCard.id || noteCard.note_id || noteCard.title || noteCard.displayTitle || noteCard.display_title
    || noteCard.content || noteCard.desc || noteCard.description || noteCard.post_text
    || noteCard.images || noteCard.image_list || noteCard.imageList
  );
}

function pickXhsNoteData(rawData) {
  const roots = [rawData, rawData?.data, rawData?.result].map(xhsObject).filter(Boolean);
  const candidates = [];
  for (const root of roots) {
    candidates.push(root.feed, root.note, root.noteCard, root.note_card, root);
  }
  return candidates.map(xhsObject).find(hasXhsNoteFields) || candidates.map(xhsObject).find(Boolean) || {};
}

function xhsBrowseNoteHasReadableContent(note) {
  return Boolean(
    String(note?.title || note?.content || note?.desc || note?.post_text || '').trim()
    || (Array.isArray(note?.images) && note.images.length > 0)
  );
}

function normalizeXhsBrowseResponse(category, rawData, originalQuery, options = {}) {
  const debugShape = {
    category,
    raw_keys: rawData && typeof rawData === 'object' ? Object.keys(rawData).sort() : [],
  };

  // 根据类别归一化响应结构
  if (category === 'search') {
    // xhs-mcp returns items[] or feeds[] with nested noteCard structure
    const searchData = rawData.data || rawData;
    const rawItems = searchData.items || searchData.feeds || searchData.results || [];
    
    // Parse and normalize each item
    const normalizedItems = rawItems.map(item => {
      // xhs-mcp structure: item.noteCard.* nested, item.id and item.xsecToken at top level
      const noteCard = item.noteCard || item;
      const user = noteCard.user || item.user || {};
      const cover = noteCard.cover || item.cover || {};
      const interactInfo = noteCard.interactInfo || item.interactInfo || {};
      const urlInfo = parseXhsUrlInfo(item.url || item.note_url || item.link || '');
      
      const noteId = item.id || item.note_id || noteCard.id || noteCard.note_id || urlInfo.note_id || '';
      const xsecToken = item.xsecToken || item.xsec_token || noteCard.xsecToken || noteCard.xsec_token || urlInfo.xsec_token || '';
      const xsecSource = item.xsecSource || item.xsec_source || noteCard.xsecSource || noteCard.xsec_source || urlInfo.xsec_source || '';
      const canonicalUrl = xsecToken
        ? buildXhsCanonicalUrl(noteId, xsecToken, xsecSource)
        : (urlInfo.canonical_url || buildXhsCanonicalUrl(noteId));
      const stats = {
        liked_count: interactInfo.likedCount || interactInfo.liked_count || 0,
        collected_count: interactInfo.collectedCount || interactInfo.collected_count || 0,
        comment_count: interactInfo.commentCount || interactInfo.comment_count || 0,
        shared_count: interactInfo.sharedCount || interactInfo.shared_count || 0,
      };
      
      // Cache search context internally (tokens are never exposed to model/user output).
      if (noteId) {
        cacheXhsNoteToken(noteId, xsecToken, {
          title: noteCard.displayTitle || noteCard.display_title || '',
          user: user.nickname || user.nickName || '',
          user_id: user.userId || user.id || '',
          cover_image: cover.urlDefault || cover.urlPre || cover.coverUrl || item.cover_image || '',
          type: noteCard.type || '',
          xsec_source: xsecSource,
          canonical_url: canonicalUrl,
          url: canonicalUrl,
          stats,
        }, options);
      }
      
      return {
        note_id: noteId,
        read_ref: noteId ? `xhs:note:${noteId}` : '',
        title: noteCard.displayTitle || noteCard.display_title || item.title || '',
        user: user.nickname || user.nickName || user.name || user.username || '',
        user_id: user.userId || user.id || '',
        cover_image: cover.urlDefault || cover.urlPre || cover.coverUrl || item.cover_image || '',
        type: noteCard.type || item.type || '',
        ...stats,
        url: noteId ? `https://www.xiaohongshu.com/explore/${noteId}` : (item.url || ''),
        xsecToken: xsecToken, // Keep for internal use, will be filtered in output if needed
      };
    });
    
    // Remove xsecToken from final output (internal only)
    const results = normalizedItems.map(({ xsecToken, ...rest }) => rest);
    
    return {
      ok: true,
      query: originalQuery || searchData.query || '',
      results: results,
      total_count: searchData.total_count || searchData.total || searchData.count || rawItems.length,
      debug_shape: {
        ...debugShape,
        item_count: rawItems.length,
      },
    };
  }

  if (category === 'note') {
    const noteData = pickXhsNoteData(rawData);
    const noteCard = xhsObject(noteData.noteCard) || xhsObject(noteData.note_card) || noteData;
    const images = noteData.images || noteData.image_list || noteData.imageList || noteCard.images || noteCard.image_list || noteCard.imageList || [];
    return {
      ok: true,
      note_id: noteData.note_id || noteData.id || noteCard.note_id || noteCard.id || '',
      title: noteData.title || noteData.displayTitle || noteData.display_title || noteCard.title || noteCard.displayTitle || noteCard.display_title || '',
      content: noteData.content || noteData.desc || noteData.description || noteData.post_text || noteCard.content || noteCard.desc || noteCard.description || noteCard.post_text || '',
      images,
      user: noteData.user || noteCard.user || { id: noteData.user_id || '', name: noteData.username || '' },
      create_time: noteData.create_time || noteData.created_at || noteCard.time || '',
      debug_shape: debugShape,
    };
  }

  if (category === 'user') {
    return {
      ok: true,
      user_id: rawData.user_id || rawData.id || '',
      user_info: {
        name: rawData.user_info?.name || rawData.username || rawData.name || '',
        avatar: rawData.user_info?.avatar || rawData.avatar || '',
        followers: rawData.user_info?.followers || rawData.followers || '',
        following: rawData.user_info?.following || rawData.following || '',
      },
      notes: (rawData.notes || []).map(note => ({
        note_id: note.note_id || note.id || '',
        title: note.title || '',
        cover_image: note.cover_image || note.cover || '',
        create_time: note.create_time || note.created_at || '',
      })),
      debug_shape: debugShape,
    };
  }

  if (category === 'feed') {
    return {
      ok: true,
      category: rawData.category || 'default',
      feed: (rawData.feed || rawData.items || []).map(item => ({
        note_id: item.note_id || item.id || '',
        title: item.title || '',
        user: item.user || { id: item.user_id || '', name: item.username || '' },
        url: item.url || item.link || '',
      })),
      debug_shape: debugShape,
    };
  }

  return { ok: true, data: rawData, debug_shape: debugShape };
}

async function fallbackXhsBrowseNote({ noteId, lookup, cachedEntry, fallbackFrom }, options = {}) {
  const fallbackUrl = lookup?.url || cachedEntry?.url || cachedEntry?.canonical_url || buildXhsCanonicalUrl(noteId);
  const envRef = options.env || process.env;
  const xhsFallbackConfig = getXhsFallbackServerConfig(envRef);
  if (!xhsFallbackConfig) return null;
  const fallback = await readGenericSocialPost({
    url: fallbackUrl,
    platform: 'xhs',
    includeComments: false,
    maxComments: 0,
  }, { ...options, xhsTimeoutMs: resolveXhsBackendTimeoutMs(envRef), _xhsFallbackConfig: xhsFallbackConfig });

  if (fallback.structuredContent?.ok !== true) {
    return null;
  }

  return {
    ok: true,
    partial: false,
    note_id: noteId,
    title: cachedEntry?.title || fallback.structuredContent.title || '',
    content: fallback.structuredContent.post_text || '',
    images: Array.isArray(fallback.structuredContent.images) ? fallback.structuredContent.images : [],
    user: { id: cachedEntry?.user_id || '', name: cachedEntry?.user || '' },
    source: 'wanyi-watermark-mcp',
    read_ref: `xhs:note:${noteId}`,
    ...(fallbackFrom ? { fallback_from: fallbackFrom } : {}),
  };
}

function getXhsBrowseFailurePayload(rawData) {
  if (!rawData || typeof rawData !== 'object') {
    return null;
  }
  if (rawData.success === false || rawData.ok === false) {
    return {
      message: String(rawData.message || rawData.error || 'Failed to read note'),
      backend_error: rawData.error ? String(rawData.error) : '',
    };
  }
  return null;
}

// ============================================================================
// XHS Browse 工具实现
// ============================================================================

async function xhsBrowseProbe(args, options = {}) {
  const config = getXhsBrowseConfig(options.env || process.env);
  
  if (!config.isConfigured) {
    return {
      ok: false,
      error_code: XHS_BROWSE_ERROR_CODES.BACKEND_UNAVAILABLE,
      message: 'XHS_BROWSE_MCP_COMMAND not configured',
    };
  }

  return await probeXhsBrowseBackend(config, options);
}

async function xhsBrowseSearch(args, options = {}) {
  const config = getXhsBrowseConfig(options.env || process.env);

  if (!config.enabled) {
    return {
      ok: false,
      error_code: XHS_BROWSE_ERROR_CODES.DISABLED,
      message: 'XHS_BROWSE is disabled. Set XHS_BROWSE_ENABLED=true to enable.',
    };
  }

  if (!config.searchEnabled) {
    return {
      ok: false,
      error_code: XHS_BROWSE_ERROR_CODES.DISABLED,
      message: 'XHS_BROWSE_SEARCH is disabled. Set XHS_BROWSE_SEARCH_ENABLED=true to enable.',
    };
  }

  if (!config.isConfigured) {
    return {
      ok: false,
      error_code: XHS_BROWSE_ERROR_CODES.BACKEND_UNAVAILABLE,
      message: 'XHS_BROWSE backend not configured',
    };
  }

  // 限流检查
  const rateLimitError = checkXhsBrowseRateLimit(config, { skipMinInterval: options.xhsBrowseSkipMinInterval === true });
  if (rateLimitError) {
    return rateLimitError;
  }

  // 参数验证
  const query = String(args.query || '').trim();
  if (!query) {
    return {
      ok: false,
      error_code: XHS_BROWSE_ERROR_CODES.INVALID_ARGUMENT,
      message: 'query is required',
    };
  }

  let maxResults = Number(args.max_results || config.maxResults);
  maxResults = Math.min(maxResults, XHS_BROWSE_DEFAULTS.maxResultsHardLimit);

  const sort = args.sort || 'relevance';

  // 探测后端并获取工具映射
  const probeResult = await probeXhsBrowseBackend(config, options);
  if (!probeResult.ok) {
    return probeResult;
  }

  if (!probeResult.matched_tools?.search) {
    return {
      ok: false,
      error_code: XHS_BROWSE_ERROR_CODES.TOOL_NOT_FOUND,
      message: 'Search tool not found in backend',
      available_tools: probeResult.available_tools,
    };
  }

  // 调用后端
  const backendToolName = probeResult.matched_tools.search;
  // 根据后端工具名称映射参数
  const backendArgs = {};
  if (xhsBrowseToolMatches(backendToolName, 'search_notes')) {
    backendArgs.keywords = query;
  } else if (xhsBrowseToolMatches(backendToolName, 'search_feeds')) {
    backendArgs.keyword = query;
  } else if (xhsBrowseToolMatches(backendToolName, 'xhs_search_note') || backendToolName.includes('search')) {
    backendArgs.keyword = query;
  } else {
    backendArgs.query = query;
  }
  if (!xhsBrowseToolMatches(backendToolName, 'search_feeds')) {
    backendArgs.max_results = maxResults;
    backendArgs.sort = sort;
  }

  const result = await callXhsBrowseBackend(backendToolName, backendArgs, config, options);

  if (!result.ok) {
    return {
      ok: false,
      error_code: XHS_BROWSE_ERROR_CODES.SEARCH_FAILED,
      message: result.message || 'Search failed',
    };
  }

  // Parse xhs-mcp response: result.data.content[0].text contains JSON string
  let rawData = {};
  try {
    const mcpContent = result.data?.content?.[0]?.text;
    if (mcpContent) {
      const parsed = JSON.parse(mcpContent);
      // xhs-mcp returns {success, items/feeds, count} or {success: false, error, message}
      if (parsed.success === false) {
        return {
          ok: false,
          error_code: XHS_BROWSE_ERROR_CODES.SEARCH_FAILED,
          message: parsed.message || parsed.error || 'Search failed',
          debug: { raw: mcpContent.substring(0, 500) },
        };
      }
      // Map xhs-mcp fields to expected format
      rawData = {
        items: parsed.items || parsed.feeds || parsed.data?.items || parsed.data?.feeds || [],
        total_count: parsed.count || parsed.total || parsed.data?.count || parsed.data?.total || 0,
        query: parsed.keyword || parsed.query || query || '',
      };
    }
  } catch (parseError) {
    return {
      ok: false,
      error_code: XHS_BROWSE_ERROR_CODES.SEARCH_FAILED,
      message: 'Failed to parse backend response: ' + parseError.message,
      debug: { raw: result.data ? JSON.stringify(result.data).substring(0, 500) : 'empty' },
    };
  }

  const normalized = normalizeXhsBrowseResponse('search', rawData, query, options);
  
  // Truncate results to maxResults
  if (normalized.ok && normalized.results && normalized.results.length > maxResults) {
    normalized.results = normalized.results.slice(0, maxResults);
    normalized.total_count = normalized.results.length;
  }
  
  return normalized;
}

async function xhsBrowseNote(args, options = {}) {
  const env = options.env || process.env;
  const debug = args.debug === true;
  const config = getXhsBrowseConfig(env);
  const hasCookie = Boolean(String(env.XHS_COOKIE || '').trim());

  if (!config.enabled) {
    return {
      ok: false,
      error_code: XHS_BROWSE_ERROR_CODES.DISABLED,
      message: 'XHS_BROWSE is disabled. Set XHS_BROWSE_ENABLED=true to enable.',
    };
  }

  if (!config.noteEnabled) {
    return {
      ok: false,
      error_code: XHS_BROWSE_ERROR_CODES.DISABLED,
      message: 'XHS_BROWSE_NOTE is disabled. Set XHS_BROWSE_NOTE_ENABLED=true to enable.',
    };
  }

  if (!config.isConfigured) {
    return {
      ok: false,
      error_code: XHS_BROWSE_ERROR_CODES.BACKEND_UNAVAILABLE,
      message: 'XHS_BROWSE backend not configured',
    };
  }

  // 限流检查
  const rateLimitError = checkXhsBrowseRateLimit(config, { skipMinInterval: options.xhsBrowseSkipMinInterval === true });
  if (rateLimitError) {
    return rateLimitError;
  }

  // 参数验证
  const lookup = parseXhsNoteLookup(args);
  const noteId = lookup.noteId;
  if (!noteId) {
    return {
      ok: false,
      error_code: XHS_BROWSE_ERROR_CODES.INVALID_ARGUMENT,
      message: 'note_id, read_ref, or url is required',
    };
  }
  if (lookup.urlInfo?.xsec_token) {
    cacheXhsNoteToken(noteId, lookup.urlInfo.xsec_token, {
      xsec_source: lookup.urlInfo.xsec_source,
      canonical_url: lookup.urlInfo.canonical_url,
      url: lookup.urlInfo.canonical_url,
    }, options);
  }

  // 探测后端并获取工具映射
  const probeResult = await probeXhsBrowseBackend(config, options);
  if (!probeResult.ok) {
    return probeResult;
  }

  if (!probeResult.matched_tools?.note) {
    return {
      ok: false,
      error_code: XHS_BROWSE_ERROR_CODES.TOOL_NOT_FOUND,
      message: 'Note tool not found in backend',
      available_tools: probeResult.available_tools,
    };
  }

  // Get xsecToken from cache (populated by search results or resolve_social_url)
  const cachedEntry = getCachedXhsNoteToken(noteId, options);
  const xsecToken = cachedEntry?.xsecToken || '';
  const usedCachedToken = Boolean(xsecToken);
  const usedCanonicalUrl = Boolean(cachedEntry?.canonical_url && xsecToken);

  // If no xsecToken in cache, try the generic parser against the cached or bare URL.
  if (!xsecToken) {
    const fallbackResult = await fallbackXhsBrowseNote({ noteId, lookup, cachedEntry }, options);
    if (fallbackResult) {
      fallbackResult.fallback_from = 'XHS_NOTE_NO_TOKEN';
      fallbackResult.diagnostics = buildXhsDiagnostic({
        platform: 'xhs', noteId, whichBackend: 'generic_parser', backendToolName: 'wanyi-watermark',
        errorCode: '', hasCookie, hasXsecToken: false, usedCachedToken: false, usedCanonicalUrl: false, env,
      });
      return fallbackResult;
    }
    return {
      ok: false,
      error_code: 'XHS_NOTE_CONTEXT_REQUIRED',
      message: `No cached token context for note_id: ${noteId}. Search first or provide an XHS URL that fallback can parse.`,
      hint: 'Run xhs_browse_search with a relevant query, then read the returned read_ref.',
      diagnostics: buildXhsDiagnostic({
        platform: 'xhs', noteId, whichBackend: 'none', hasCookie, hasXsecToken: false, usedCachedToken: false, usedCanonicalUrl: false, env,
      }),
    };
  }

  // Call backend with the argument style expected by the matched backend tool.
  const backendToolName = probeResult.matched_tools.note;
  const result = await callXhsBrowseBackend(
    backendToolName,
    xhsBrowseBackendArgsForNote(backendToolName, noteId, cachedEntry, args.include_images !== false),
    config,
    options
  );

  if (!result.ok) {
    return {
      ok: false,
      error_code: XHS_BROWSE_ERROR_CODES.NOTE_READ_FAILED,
      message: result.message || 'Failed to read note',
      diagnostics: buildXhsDiagnostic({
        platform: 'xhs', noteId, whichBackend: 'xhs_browse', backendToolName,
        errorCode: XHS_BROWSE_ERROR_CODES.NOTE_READ_FAILED, backendError: result.message,
        hasCookie, hasXsecToken: true, usedCachedToken, usedCanonicalUrl, env,
      }),
    };
  }

  const rawData = parseMcpStructuredData(result.data || {});
  const backendFailure = getXhsBrowseFailurePayload(rawData);
  if (backendFailure) {
    // Classify the error more precisely
    const classifiedError = xhsBackendTextError(backendFailure.message || '', backendToolName);
    const errorCode = classifiedError?.error_code || XHS_BROWSE_ERROR_CODES.NOTE_READ_FAILED;

    const fallbackResult = await fallbackXhsBrowseNote({
      noteId,
      lookup,
      cachedEntry,
      fallbackFrom: errorCode,
    }, options);
    if (fallbackResult) {
      fallbackResult.diagnostics = buildXhsDiagnostic({
        platform: 'xhs', noteId, whichBackend: 'generic_parser', backendToolName,
        errorCode, backendError: backendFailure.message,
        hasCookie, hasXsecToken: true, usedCachedToken, usedCanonicalUrl,
        rawFieldsSeen: extractRawFieldsSeen(rawData),
        rawPreview: debug ? sanitizeRawPreview(JSON.stringify(rawData)) : '',
        env,
      });
      return fallbackResult;
    }
    return {
      ok: false,
      error_code: errorCode,
      message: backendFailure.message,
      backend_error: backendFailure.backend_error,
      note_id: noteId,
      read_ref: `xhs:note:${noteId}`,
      diagnostics: buildXhsDiagnostic({
        platform: 'xhs', noteId, whichBackend: 'xhs_browse', backendToolName,
        errorCode, backendError: backendFailure.message,
        hasCookie, hasXsecToken: true, usedCachedToken, usedCanonicalUrl,
        rawFieldsSeen: extractRawFieldsSeen(rawData),
        rawPreview: debug ? sanitizeRawPreview(JSON.stringify(rawData)) : '',
        env,
      }),
    };
  }

  const normalized = normalizeXhsBrowseResponse('note', rawData, '', options);
  if (!xhsBrowseNoteHasReadableContent(normalized)) {
    const fallbackResult = await fallbackXhsBrowseNote({
      noteId,
      lookup,
      cachedEntry,
      fallbackFrom: XHS_BROWSE_ERROR_CODES.NOTE_READ_FAILED,
    }, options);
    if (fallbackResult) {
      fallbackResult.diagnostics = buildXhsDiagnostic({
        platform: 'xhs', noteId, whichBackend: 'generic_parser', backendToolName,
        errorCode: XHS_BROWSE_ERROR_CODES.NOTE_READ_FAILED, backendError: 'XHS browse detail returned no readable fields',
        hasCookie, hasXsecToken: true, usedCachedToken, usedCanonicalUrl,
        rawFieldsSeen: extractRawFieldsSeen(rawData),
        rawPreview: debug ? sanitizeRawPreview(JSON.stringify(rawData)) : '',
        env,
      });
      return fallbackResult;
    }
    return {
      ok: false,
      error_code: XHS_BROWSE_ERROR_CODES.NOTE_READ_FAILED,
      message: 'XHS browse detail returned no readable fields',
      note_id: noteId,
      read_ref: `xhs:note:${noteId}`,
      diagnostics: buildXhsDiagnostic({
        platform: 'xhs', noteId, whichBackend: 'xhs_browse', backendToolName,
        errorCode: XHS_BROWSE_ERROR_CODES.NOTE_READ_FAILED, backendError: 'empty normalized note',
        hasCookie, hasXsecToken: true, usedCachedToken, usedCanonicalUrl,
        rawFieldsSeen: extractRawFieldsSeen(rawData),
        rawPreview: debug ? sanitizeRawPreview(JSON.stringify(rawData)) : '',
        env,
      }),
    };
  }
  // Add diagnostics to successful response
  normalized.raw_fields_seen = extractRawFieldsSeen(rawData);
  if (debug) {
    normalized.raw_preview = sanitizeRawPreview(JSON.stringify(rawData));
  }
  normalized.diagnostics = buildXhsDiagnostic({
    platform: 'xhs', noteId, whichBackend: 'xhs_browse', backendToolName,
    hasCookie, hasXsecToken: true, usedCachedToken, usedCanonicalUrl,
    rawFieldsSeen: extractRawFieldsSeen(rawData), env,
  });
  return normalized;
}

async function xhsBrowseUser(args, options = {}) {
  const config = getXhsBrowseConfig(options.env || process.env);

  if (!config.enabled) {
    return {
      ok: false,
      error_code: XHS_BROWSE_ERROR_CODES.DISABLED,
      message: 'XHS_BROWSE is disabled. Set XHS_BROWSE_ENABLED=true to enable.',
    };
  }

  if (!config.userEnabled) {
    return {
      ok: false,
      error_code: XHS_BROWSE_ERROR_CODES.PROFILE_DISABLED,
      message: 'XHS_BROWSE_USER is disabled by default. Set XHS_BROWSE_USER_ENABLED=true to enable.',
    };
  }

  if (!config.isConfigured) {
    return {
      ok: false,
      error_code: XHS_BROWSE_ERROR_CODES.BACKEND_UNAVAILABLE,
      message: 'XHS_BROWSE backend not configured',
    };
  }

  // 限流检查
  const rateLimitError = checkXhsBrowseRateLimit(config);
  if (rateLimitError) {
    return rateLimitError;
  }

  // 参数验证
  const userId = String(args.user_id || '').trim();
  if (!userId) {
    return {
      ok: false,
      error_code: XHS_BROWSE_ERROR_CODES.INVALID_ARGUMENT,
      message: 'user_id is required',
    };
  }

  let maxItems = Number(args.max_items || config.maxItems);
  maxItems = Math.min(maxItems, XHS_BROWSE_DEFAULTS.maxItemsHardLimit);

  // 探测后端并获取工具映射
  const probeResult = await probeXhsBrowseBackend(config, options);
  if (!probeResult.ok) {
    return probeResult;
  }

  if (!probeResult.matched_tools?.user) {
    return {
      ok: false,
      error_code: XHS_BROWSE_ERROR_CODES.TOOL_NOT_FOUND,
      message: 'User tool not found in backend',
      available_tools: probeResult.available_tools,
    };
  }

  // 调用后端
  const backendToolName = probeResult.matched_tools.user;
  const result = await callXhsBrowseBackend(backendToolName, {
    user_id: userId,
    max_items: maxItems,
  }, config, options);

  if (!result.ok) {
    return {
      ok: false,
      error_code: XHS_BROWSE_ERROR_CODES.PROFILE_FAILED,
      message: result.message || 'Failed to get user profile',
    };
  }

  return normalizeXhsBrowseResponse('user', result.data || {}, '', options);
}

async function xhsBrowseFeed(args, options = {}) {
  const config = getXhsBrowseConfig(options.env || process.env);

  if (!config.enabled) {
    return {
      ok: false,
      error_code: XHS_BROWSE_ERROR_CODES.DISABLED,
      message: 'XHS_BROWSE is disabled. Set XHS_BROWSE_ENABLED=true to enable.',
    };
  }

  if (!config.feedEnabled) {
    return {
      ok: false,
      error_code: XHS_BROWSE_ERROR_CODES.FEED_DISABLED,
      message: 'XHS_BROWSE_FEED is disabled by default due to risk control. Set XHS_BROWSE_FEED_ENABLED=true to enable.',
    };
  }

  if (!config.isConfigured) {
    return {
      ok: false,
      error_code: XHS_BROWSE_ERROR_CODES.BACKEND_UNAVAILABLE,
      message: 'XHS_BROWSE backend not configured',
    };
  }

  // 限流检查
  const rateLimitError = checkXhsBrowseRateLimit(config);
  if (rateLimitError) {
    return rateLimitError;
  }

  // 探测后端并获取工具映射
  const probeResult = await probeXhsBrowseBackend(config, options);
  if (!probeResult.ok) {
    return probeResult;
  }

  if (!probeResult.matched_tools?.feed) {
    return {
      ok: false,
      error_code: XHS_BROWSE_ERROR_CODES.TOOL_NOT_FOUND,
      message: 'Feed tool not found in backend',
      available_tools: probeResult.available_tools,
    };
  }

  const category = args.category || 'default';
  let maxItems = Number(args.max_items || config.maxItems);
  maxItems = Math.min(maxItems, XHS_BROWSE_DEFAULTS.maxItemsHardLimit);

  // 调用后端
  const backendToolName = probeResult.matched_tools.feed;
  const result = await callXhsBrowseBackend(backendToolName, {
    category,
    max_items: maxItems,
  }, config, options);

  if (!result.ok) {
    return {
      ok: false,
      error_code: XHS_BROWSE_ERROR_CODES.FEED_FAILED,
      message: result.message || 'Failed to get feed',
    };
  }

  return normalizeXhsBrowseResponse('feed', result.data || {}, '', options);
}
