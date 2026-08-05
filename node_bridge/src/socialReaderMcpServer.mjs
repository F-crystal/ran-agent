#!/usr/bin/env node
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { buildMediaAssets, hostFromUrl, redactUrl } from './mediaReader/assetResolver.mjs';

const SERVER_INFO = {
  name: 'ran-agent-social-reader',
  version: '0.1.0',
};

const DEFAULT_TIMEOUT_MS = 90000;
const DEFAULT_MAX_COMMENTS = 30;
const MAX_COMMENTS_CAP = 100;
const DEFAULT_MAX_MEDIA_ASSETS = 100;
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
function buildXhsCanonicalUrl(noteId, xsecToken = '', xsecSource = '') {
  if (!noteId) return '';
  const canonical = new URL(`https://www.xiaohongshu.com/explore/${noteId}`);
  if (xsecToken) canonical.searchParams.set('xsec_token', xsecToken);
  if (xsecSource) canonical.searchParams.set('xsec_source', xsecSource);
  return canonical.toString();
}

export function buildSocialReaderTools(env = process.env) {
  void env;
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
            default: DEFAULT_MAX_MEDIA_ASSETS,
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
  ];
  return tools;
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

function normalizeGenericImageList(payload) {
  const source = payload?.data?.note || payload?.note || payload || {};
  for (const key of ['images', 'imageList', 'image_list', 'image_urls', 'imageUrls']) {
    const value = source[key] || payload?.[key];
    if (!Array.isArray(value)) continue;
    return value
      .map((item) => {
        if (typeof item === 'string') {
          return { url: item };
        }
        if (item && typeof item === 'object') {
          return item;
        }
        return null;
      })
      .filter(Boolean);
  }
  return [];
}

function normalizeGenericVideoList(payload) {
  const source = payload?.data?.note || payload?.note || payload || {};
  for (const key of ['videos', 'videoList', 'video_list']) {
    const value = source[key] || payload?.[key];
    if (Array.isArray(value)) return value.filter((item) => item && typeof item === 'object');
  }
  const videoUrl = firstString(source.video_url, source.videoUrl, source.media_url, source.url);
  return videoUrl ? [{ type: 'video', url: videoUrl, thumbnail: firstString(source.thumbnail, source.cover_url, source.cover_image) }] : [];
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

  const source = payload?.data?.note || payload?.note || payload;
  const postText = firstString(
    source.desc,
    source.caption,
    source.content,
    source.text,
    source.description,
    source.title,
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
    title: firstString(source.title, source.displayTitle, payload.title),
    note_id: firstString(source.note_id, source.noteId, source.id, payload.note_id, payload.id, payload.feed_id),
    parser_status: status || '',
    media_type: firstString(source.type, payload.type),
    images: normalizeGenericImageList(payload),
    media: payload.media,
    media_list: payload.media_list,
    medias: payload.medias,
    videos: normalizeGenericVideoList(payload),
    audios: payload.audios,
    attachments: payload.attachments,
    image_count: payload.image_count ?? source.image_count,
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

function xhsObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function pickXhsNoteData(data) {
  const root = xhsObject(data) || {};
  const dataNode = xhsObject(root.data) || {};
  const resultNode = xhsObject(root.result) || {};
  const payloadNode = xhsObject(root.payload) || {};
  return xhsObject(root.note)
    || xhsObject(dataNode.note)
    || xhsObject(resultNode.note)
    || xhsObject(payloadNode.note)
    || xhsObject(root.noteCard)
    || xhsObject(dataNode.noteCard)
    || xhsObject(resultNode.noteCard)
    || root;
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

function positiveInt(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function normalizeMaxMediaAssets(value) {
  return positiveInt(value, DEFAULT_MAX_MEDIA_ASSETS);
}

function resolveMediaReaderTimeoutMs(env = process.env, toolArguments = {}) {
  const explicit = positiveInt(env.MEDIA_READER_MCP_TIMEOUT_MS, 0);
  if (explicit) return explicit;
  const assets = Array.isArray(toolArguments.assets) ? toolArguments.assets.length : 0;
  const concurrency = positiveInt(env.PERSONAL_AGENT_MEDIA_MAX_CONCURRENCY, 2);
  const perItemTimeoutMs = positiveInt(env.PERSONAL_AGENT_MEDIA_PER_ITEM_TIMEOUT_MS, 60000);
  const batchTimeoutMs = positiveInt(env.PERSONAL_AGENT_MEDIA_BATCH_TIMEOUT_MS, 0);
  const computedBatchMs = assets > 0
    ? Math.ceil(assets / Math.max(concurrency, 1)) * perItemTimeoutMs + 30000
    : 0;
  return Math.max(batchTimeoutMs, computedBatchMs, 120000);
}

function resolveXhsBackendTimeoutMs(env = process.env) {
  const parsed = Number(env.SOCIAL_READER_XHS_BACKEND_TIMEOUT_MS || env.XHS_BACKEND_MCP_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
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
  function pushRaw(value) {
    const text = String(value || '').trim();
    if (!text || candidates.includes(text)) return;
    candidates.push(text);
  }
  function pushUrl(value) {
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

  pushRaw(rawText);
  pushUrl(resolved.url || extractFirstUrl(rawText).url);
  pushUrl(resolved.canonical_url);
  pushUrl(resolved.resolved_url);
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

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
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
    return buildTextResult({
      ok: true,
      url: extracted.url,
      resolved_url: resolved.resolved_url,
      platform: 'xhs',
      note_id: noteId,
      xsec_source: resolved.xsec_source || '',
      has_xsec_token: Boolean(xsecToken),
      cache_written: false,
      public_only: true,
      account_backed: false,
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
    max_assets: DEFAULT_MAX_MEDIA_ASSETS,
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

function partialSocialFailureResult({ platform, url, failure }) {
  const errorCode = String(failure?.error_code || 'SOCIAL_READER_PARTIAL_FAILURE');
  const partialFailure = {
    asset_id: 'platform-1',
    error_code: errorCode,
    error: failure?.error || `${errorCode}: platform read failed`,
    platform,
    captcha_detected: failure?.captcha_detected === true,
    recovery_suggestion: failure?.recovery_suggestion || '',
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
  const env = options.env || process.env;
  const timeoutMs = resolveMediaReaderTimeoutMs(env, toolArguments);
  if (typeof options.mediaReaderCallImpl === 'function') {
    return await options.mediaReaderCallImpl({ toolName, arguments: toolArguments, timeoutMs });
  }
  return await callMcpToolViaStdio({
    command: env.MEDIA_READER_MCP_COMMAND || 'bash',
    args: parseJsonArrayEnv(env.MEDIA_READER_MCP_ARGS_JSON, ['scripts/start_media_reader_mcp.sh']),
    env: process.env,
    toolName,
    arguments: toolArguments,
    timeoutMs,
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
        max_assets: normalizeMaxMediaAssets(args.max_media_assets),
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
  const maxMediaAssets = normalizeMaxMediaAssets(args.max_media_assets);
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
      maxAssets: maxMediaAssets,
    }),
    ]
    : [];

  if (includeMedia && assets.length > 0) {
    const mediaResult = await callMediaReaderTool('analyze_media_batch', {
      assets,
      media_detail: mediaDetail,
      max_assets: maxMediaAssets,
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
  const publicResult = await readXhsPublicChain({
    rawText: args.url || url,
    resolved,
    includeComments: false,
    maxComments: 0,
  }, options);
  const publicData = publicResult?.structuredContent || null;
  const publicOk = publicData?.ok === true && hasUsableXhsPublicContent(publicData);
  const source = publicOk && publicData.source === 'wanyi-watermark-mcp'
    ? 'wanyi-watermark'
    : (publicData?.source || 'xhs_public_only');
  const normalizedMedia = publicOk ? normalizeXhsMedia({ ...publicData, source }) : { images: [], videos: [], media: [], cover_image: '' };

  const diagnostics = {
    detail_backend: {
      name: source,
      ok: publicOk,
      error_code: publicOk ? '' : 'XHS_PUBLIC_PARSE_FAILED',
      message: publicOk ? '' : 'Public XHS parsers could not extract readable content; account-backed readers are disabled.',
      raw_fields_seen: publicOk ? extractRawFieldsSeen(publicData) : {},
      used_cached_token: false,
      used_canonical_url: Boolean(resolved.canonical_url),
    },
    media_backend: {
      name: source,
      ok: normalizedMedia.media.length > 0,
      error_code: normalizedMedia.media.length > 0 ? '' : 'XHS_PUBLIC_MEDIA_UNAVAILABLE',
      message: normalizedMedia.media.length > 0 ? '' : 'Public XHS parsers returned no media resources.',
      media_count: normalizedMedia.media.length,
      raw_fields_seen: publicOk ? extractRawFieldsSeen(publicData) : {},
    },
    public_only: true,
    account_backed: false,
  };

  if (debug) {
    diagnostics.public_raw_preview = publicData ? sanitizeRawPreview(JSON.stringify(publicData)) : '';
  }

  const normalizedMediaItems = mergeXhsMediaItems(normalizedMedia.media);
  const images = normalizedMediaItems.filter((item) => item.type === 'image');
  const videos = normalizedMediaItems.filter((item) => item.type === 'video');
  const mediaCount = normalizedMediaItems.length;
  const mediaDetail = normalizeMediaDetail(args.media_detail);
  const includeMedia = args.include_media !== false && mediaDetail !== 'none';
  const maxMediaAssets = normalizeMaxMediaAssets(args.max_media_assets);
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

  if (!publicOk) {
    return buildTextResult({
      ok: false,
      partial_success: false,
      platform: 'xhs',
      note_id: noteId,
      url,
      source: 'xhs_public_only',
      public_only: true,
      account_backed: false,
      error_code: 'XHS_PUBLIC_PARSE_FAILED',
      message: 'Public XHS parsers could not extract readable content; account-backed readers are disabled.',
      images: [],
      videos: [],
      media: [],
      media_assets: [],
      media_analysis: mediaAnalysis,
      diagnostics,
    });
  }

  const title = publicData?.title || publicData?.note_title || '';
  const desc = publicData?.desc || publicData?.content || publicData?.post_text || '';

  if (mediaCount === 0) {
    return buildTextResult({
      ok: true,
      partial_success: false,
      quality: 'low',
      platform: 'xhs',
      note_id: noteId,
      url,
      source,
      public_only: true,
      account_backed: false,
      title,
      desc,
      tags: publicData?.tags || [],
      images,
      videos,
      media: normalizedMediaItems,
      media_assets: [],
      media_analysis: mediaAnalysis,
      post_text: publicData?.post_text || desc,
      comments_text: '',
      comments_supported: false,
      diagnostics,
    });
  }

  return buildTextResult({
    ok: true,
    partial_success: partialMediaRead,
    platform: 'xhs',
    note_id: noteId,
    url,
    source,
    public_only: true,
    account_backed: false,
    title,
    desc,
    tags: publicData?.tags || [],
    images,
    videos,
    media: normalizedMediaItems,
    media_assets: mediaAssets,
    media_analysis: mediaAnalysis,
    post_text: publicData?.post_text || desc,
    comments_text: '',
    comments_supported: false,
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
      publicData?.post_text || desc,
      mediaAnalysis?.merged_summary ? `媒体: ${mediaAnalysis.merged_summary}` : '',
    ].filter(Boolean).join('\n\n'),
    diagnostics,
  });
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

function buildMediaAssetsFromXhsItems({ mediaItems = [], platform = '', maxAssets = DEFAULT_MAX_MEDIA_ASSETS } = {}) {
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

function hasUsableXhsPublicContent(payload = {}) {
  if (payload?.ok === false) return false;
  const normalized = normalizeXhsMedia(payload);
  return Boolean(
    firstString(payload.post_text, payload.desc, payload.content, payload.title)
    || normalized.images.length
    || normalized.videos.length
  );
}

function xhsGenericConfigOrInjected(env, options = {}) {
  return getXhsFallbackServerConfig(env)
    || (typeof options.mcpCallImpl === 'function' ? { command: 'injected-test-generic-parser', args: [], env: {} } : null);
}

function finalizeXhsPublicResult(result, { source } = {}) {
  if (!result?.structuredContent?.ok) return result;
  if (source) {
    result.structuredContent.source = source;
  }
  result.structuredContent.comments_text = '';
  result.structuredContent.comments_supported = false;
  result.structuredContent.account_backed = false;
  result.structuredContent.public_only = true;
  if (Array.isArray(result.content) && result.content[0]?.type === 'text') {
    result.content[0].text = JSON.stringify(result.structuredContent, null, 2);
  }
  return result;
}

async function readXhsPublicParserTool({ url, toolName = 'parse_xhs_link', source = '' }, { includeComments, maxComments, env }, options = {}) {
  const config = xhsGenericConfigOrInjected(env, options);
  if (!config) return null;
  const xhsTimeoutMs = resolveXhsBackendTimeoutMs(env);
  const result = await readGenericSocialPost({
    url,
    platform: 'xhs',
    includeComments,
    maxComments,
  }, {
    ...options,
    xhsTimeoutMs,
    _xhsFallbackConfig: config,
    _genericParserToolName: toolName,
  });
  if (result?.structuredContent?.ok === true && hasUsableXhsPublicContent(result.structuredContent)) {
    return finalizeXhsPublicResult(result, { source });
  }
  return null;
}

function getXhsPublicSidecarConfig(env = process.env) {
  const enabled = String(env.XHS_PUBLIC_SIDECAR_ENABLED || 'true').trim().toLowerCase() !== 'false';
  const url = String(env.XHS_PUBLIC_SIDECAR_URL || '').trim();
  const timeoutMs = positiveInt(env.XHS_PUBLIC_SIDECAR_TIMEOUT_MS, 90000);
  return { enabled, url, timeoutMs, configured: Boolean(enabled && url) };
}

async function parseResponseBody(response) {
  if (typeof response?.json === 'function') {
    return await response.json();
  }
  if (typeof response?.text === 'function') {
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return response;
}

async function readXhsDownloaderSidecar({ url, env }, options = {}) {
  const config = getXhsPublicSidecarConfig(env);
  if (!config.configured) return null;
  const requestUrl = extractFirstUrl(url).url || String(url || '').trim();
  try {
    const parsed = new URL(requestUrl);
    if (!isAllowedXhsHostname(parsed.hostname)) return null;
  } catch {
    return null;
  }
  const fetchImpl = resolveFetchImpl(options.fetchImpl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetchImpl(config.url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url: requestUrl,
        download: false,
        cookie: '',
      }),
    });
    if (response?.ok === false || (Number(response?.status) >= 400)) {
      return null;
    }
    const body = await parseResponseBody(response);
    const normalized = normalizeGenericParserPayload(typeof body === 'string' ? body : JSON.stringify(body));
    if (!normalized.ok) return null;
    const payload = {
      ok: true,
      platform: 'xhs',
      url: requestUrl,
      source: 'xhs-downloader-sidecar',
      parser_tool: 'xhs_downloader_detail',
      post_text: normalized.post_text,
      comments_text: '',
      comments_supported: false,
      public_only: true,
      account_backed: false,
      ...(normalized.title ? { title: normalized.title } : {}),
      ...(normalized.note_id ? { note_id: normalized.note_id } : {}),
      ...(Array.isArray(normalized.images) && normalized.images.length ? { images: normalized.images } : {}),
      ...(Array.isArray(normalized.videos) && normalized.videos.length ? { videos: normalized.videos } : {}),
      ...(normalized.media ? { media: normalized.media } : {}),
    };
    return hasUsableXhsPublicContent(payload) ? buildTextResult(payload) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function decodeHtmlEntities(text = '') {
  return String(text || '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function extractMetaContent(html = '', name = '') {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`<meta\\s+[^>]*(?:property|name)=["']${escaped}["'][^>]*content=["']([^"']+)["'][^>]*>`, 'i');
  const match = String(html || '').match(pattern);
  return match ? decodeHtmlEntities(match[1]) : '';
}

async function readXhsHtmlPublicFallback({ url, env }, options = {}) {
  if (String(env.XHS_PUBLIC_HTML_FALLBACK_ENABLED || '').trim().toLowerCase() !== 'true') return null;
  const requestUrl = extractFirstUrl(url).url || String(url || '').trim();
  try {
    const parsed = new URL(requestUrl);
    if (!isAllowedXhsHostname(parsed.hostname)) return null;
  } catch {
    return null;
  }
  const fetchImpl = resolveFetchImpl(options.fetchImpl);
  const timeoutMs = positiveInt(env.XHS_PUBLIC_HTML_FALLBACK_TIMEOUT_MS, 30000);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(requestUrl, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'user-agent': BROWSER_USER_AGENT,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    if (response?.ok === false || (Number(response?.status) >= 400)) return null;
    const html = typeof response?.text === 'function' ? await response.text() : '';
    const title = firstString(extractMetaContent(html, 'og:title'), extractMetaContent(html, 'title'));
    const desc = firstString(extractMetaContent(html, 'og:description'), extractMetaContent(html, 'description'));
    const image = extractMetaContent(html, 'og:image');
    const payload = {
      ok: true,
      platform: 'xhs',
      url: requestUrl,
      source: 'xhs-html-public-fallback',
      title,
      post_text: desc || title,
      comments_text: '',
      comments_supported: false,
      public_only: true,
      account_backed: false,
      images: image ? [{ url: image }] : [],
    };
    return hasUsableXhsPublicContent(payload) ? buildTextResult(payload) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function readXhsPublicChain({ rawText, resolved, includeComments, maxComments }, options = {}) {
  const env = options.env || process.env;
  const candidates = buildXhsReadUrlCandidates({ rawText, resolved });
  for (const candidateUrl of candidates) {
    const parsed = await readXhsPublicParserTool({
      url: candidateUrl,
      toolName: 'parse_xhs_link',
    }, { includeComments, maxComments, env }, options);
    if (parsed) return parsed;
  }
  for (const candidateUrl of candidates) {
    const sidecar = await readXhsDownloaderSidecar({ url: candidateUrl, env }, options);
    if (sidecar) return sidecar;
  }
  for (const candidateUrl of candidates) {
    const generic = await readXhsPublicParserTool({
      url: candidateUrl,
      toolName: 'parse_generic_link',
      source: 'wanyi-watermark-generic',
    }, { includeComments, maxComments, env }, options);
    if (generic) return generic;
  }
  for (const candidateUrl of candidates) {
    const html = await readXhsHtmlPublicFallback({ url: candidateUrl, env }, options);
    if (html) return html;
  }
  return null;
}

function buildXhsPublicParseFailedResult({ rawText, resolved } = {}) {
  return buildTextResult({
    ok: true,
    partial: true,
    content_available: false,
    full_text_available: false,
    evidence_level: 'metadata_only',
    should_answer_from_content: false,
    platform: 'xhs',
    url: resolved?.resolved_url || resolved?.canonical_url || resolved?.original_url || String(rawText || ''),
    note_id: resolved?.note_id || '',
    source: 'xhs_public_only',
    post_text: '',
    comments_text: '',
    comments_supported: false,
    public_only: true,
    account_backed: false,
    error_code: 'XHS_PUBLIC_PARSE_FAILED',
    warnings: [
      { code: 'XHS_PUBLIC_PARSE_FAILED', message: 'Public XHS parsers could not extract readable content; account-backed readers are disabled.' },
      { code: 'PARTIAL_RESULT', message: 'Returning URL and metadata only; full content unavailable' },
    ],
    fallback_chain: ['wanyi_watermark', 'xhs_downloader_public_sidecar', 'wanyi_generic', 'html_public_fallback', 'partial'],
  });
}

function displayXhsResolvedUrl(resolved = {}, fallback = '') {
  return resolved.canonical_url || resolved.resolved_url || resolved.url || fallback || '';
}

async function readXhsPost({ rawText, resolved, includeComments, maxComments }, options = {}) {
  const result = await readXhsPublicChain({ rawText, resolved, includeComments, maxComments }, options);
  if (result) {
    result.structuredContent.primary = true;
    result.structuredContent.url = displayXhsResolvedUrl(resolved, result.structuredContent.url);
    if (resolved?.note_id && !result.structuredContent.note_id) {
      result.structuredContent.note_id = resolved.note_id;
    }
    result.content[0].text = JSON.stringify(result.structuredContent, null, 2);
    return result;
  }
  return buildXhsPublicParseFailedResult({ rawText, resolved });
}

async function readGenericSocialPost({ url, platform, includeComments, maxComments }, options = {}) {
  const toolName = options._genericParserToolName || genericParserToolForPlatform(platform);
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
  if (server === 'xhs') {
    throw new Error('XHS_ACCOUNT_BACKED_DISABLED: XHS account-backed MCP backends are retired');
  }
  if (typeof options.mcpCallImpl === 'function') {
    return await options.mcpCallImpl({ server, toolName, arguments: toolArguments });
  }
  const env = options.env || process.env;
  const config = server === 'bilibili'
      ? bilibiliServerConfig(env)
      : genericParserServerConfig(env);
  const timeoutMs = options._overrideTimeoutMs
    || resolveTimeoutMs(env);
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
  void options;
  if (String(name || '').startsWith('xhs_browse_')) {
    return buildErrorResult('XHS_ACCOUNT_BACKED_DISABLED: xhs_browse tools are retired; Xiaohongshu reads are public-only.', {
      error_code: 'XHS_ACCOUNT_BACKED_DISABLED',
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
  if (method === 'ping') {
    return {};
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
