#!/usr/bin/env node
import http from 'node:http';
import https from 'node:https';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { buildMediaAssets } from './mediaReader/assetResolver.mjs';

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

export function buildSocialReaderTools() {
  return [
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
      description: 'Get Xiaohongshu note details by note_id. Requires XHS_BROWSE_ENABLED=true and XHS_BROWSE_NOTE_ENABLED=true.',
      inputSchema: {
        type: 'object',
        properties: {
          note_id: { type: 'string', description: 'Note ID to fetch.' },
          include_images: { type: 'boolean', description: 'Include images.', default: true },
        },
        required: ['note_id'],
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

function xhsBackendTextError(text, toolName) {
  const normalized = String(text || '').trim();
  if (!normalized) {
    return null;
  }
  if (/cookie已失效|cookie失效|cookie expired|invalid cookie/i.test(normalized)) {
    return {
      error_code: 'LOGIN_REQUIRED',
      message: `${toolName} returned login failure: ${normalized}`,
    };
  }
  if (/验证码|风控|risk|captcha/i.test(normalized)) {
    return {
      error_code: 'CAPTCHA_OR_RISK_CONTROL',
      message: `${toolName} returned risk control: ${normalized}`,
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

function backendErrorPayload(error, extra = {}) {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  let errorCode = 'BACKEND_MCP_ERROR';
  if (/captcha|risk|风控|验证|滑块/.test(lower)) {
    errorCode = 'CAPTCHA_OR_RISK_CONTROL';
  } else if (/cookie|login|unauthorized|401|登录/.test(lower)) {
    errorCode = 'LOGIN_REQUIRED';
  }
  return {
    ok: false,
    error_code: errorCode,
    error: `${errorCode}: ${message}`,
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
    return buildTextResult({
      ok: true,
      url: extracted.url,
      resolved_url: resolved.resolved_url,
      platform: 'xhs',
      note_id: resolved.note_id || '',
      xsec_source: resolved.xsec_source || '',
      has_xsec_token: Boolean(resolved.xsec_token),
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
  if (!String(env.XHS_COOKIE || '').trim()) {
    return buildErrorResult('LOGIN_REQUIRED: XHS_COOKIE is required for xhs login checks', { error_code: 'LOGIN_REQUIRED', platform: 'xhs' });
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
    for (const key of ['url', 'media_url', 'image_url', 'video_url', 'audio_url', 'src', 'cover_url']) {
      if (typeof value[key] === 'string') {
        collectMediaUrlsFromValue(value[key], output);
      }
    }
    for (const key of ['media', 'medias', 'images', 'videos', 'audios', 'attachments', 'data']) {
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
  let socialResult = await readSocialPost(args, options);
  if (socialResult.structuredContent?.ok === false) {
    if (detectedPlatform === 'wechat_article') {
      return partialSocialFailureResult({
        platform: 'wechat_article',
        url: extracted.url || args.url || '',
        failure: socialResult.structuredContent || {},
      });
    }
    if (['bilibili', 'xhs', 'wechat_article'].includes(detectedPlatform)) {
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
        });
      }
    } else {
      return socialResult;
    }
  }
  const social = socialResult.structuredContent || {};
  const mediaDetail = normalizeMediaDetail(args.media_detail);
  const includeMedia = args.include_media !== false && mediaDetail !== 'none';
  let mediaAnalysis = {
    ok: true,
    partial: false,
    items: [],
    merged_summary: '',
    timeline: [],
    partial_failures: [],
    warnings: [],
  };
  const mediaUrls = includeMedia ? extractMediaUrlsFromPostText(social.post_text) : [];
  const platformAsset = includeMedia && ['bilibili', 'xhs'].includes(social.platform || detectedPlatform)
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

async function readXhsPost({ rawText, resolved, includeComments, maxComments }, options = {}) {
  const env = options.env || process.env;
  const hasCookie = String(env.XHS_COOKIE || '').trim();
  const genericFallbackEnabled = String(env.SOCIAL_READER_GENERIC_FALLBACK_ENABLED || 'true') !== 'false';
  if (!hasCookie) {
    if (genericFallbackEnabled) {
      return await readGenericSocialPost({ url: resolved.resolved_url, platform: 'xhs', includeComments, maxComments }, options);
    }
    return buildErrorResult('LOGIN_REQUIRED: XHS_COOKIE is required for xhs content/comments', { error_code: 'LOGIN_REQUIRED', platform: 'xhs' });
  }

  const prepared = await prepareXhsBackendUrl({ rawText, resolved }, options);
  if (!prepared.ok) {
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
      const fallback = await readGenericSocialPost({ url, platform: 'xhs', includeComments, maxComments }, options);
      fallback.structuredContent.xhs_error = error instanceof Error ? error.message : String(error);
      fallback.structuredContent.fallback = true;
      fallback.content[0].text = JSON.stringify(fallback.structuredContent, null, 2);
      return fallback;
    }
    return backendErrorResult(error, { platform: 'xhs', url });
  }
}

async function readGenericSocialPost({ url, platform, includeComments, maxComments }, options = {}) {
  const toolName = genericParserToolForPlatform(platform);
  try {
    const result = await callBackendMcpTool('generic', toolName, { share_link: url }, options);
    return buildTextResult({
      ok: true,
      platform,
      url,
      source: 'wanyi-watermark-mcp',
      include_comments: includeComments,
      max_comments: maxComments,
      parser_tool: toolName,
      post_text: textFromMcpResult(result),
      comments_text: '',
      comments_supported: false,
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
  return await callMcpToolViaStdio({
    command: config.command,
    args: config.args,
    env: {
      ...process.env,
      ...config.env,
    },
    toolName,
    arguments: toolArguments,
    timeoutMs: resolveTimeoutMs(env),
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
      if (payload.id === 2) {
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
      id: 2,
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: toolArguments,
      },
    })}\n`);
  });
}

async function callTool(name, args = {}, options = {}) {
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
    return await xhsBrowseProbe(args, options);
  }
  if (name === 'xhs_browse_search') {
    return await xhsBrowseSearch(args, options);
  }
  if (name === 'xhs_browse_note') {
    return await xhsBrowseNote(args, options);
  }
  if (name === 'xhs_browse_user') {
    return await xhsBrowseUser(args, options);
  }
  if (name === 'xhs_browse_feed') {
    return await xhsBrowseFeed(args, options);
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
    return { tools: buildSocialReaderTools() };
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
  search: ['search_notes', 'search', 'query_notes', 'search_note'],
  note: ['get_note_info', 'get_note', 'note_detail', 'get_note_content'],
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

function checkXhsBrowseRateLimit(config) {
  const now = Date.now();
  
  // 检查调用间隔
  if (xhsBrowseLastCallTime > 0) {
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

async function callXhsBrowseBackend(toolName, args, config) {
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

    try {
      const { spawn } = require('node:child_process');
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

    const rl = require('node:readline').createInterface({
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
      if (payload.id === 3) {
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
        id: 2,
        method: 'tools/list',
        params: {},
      }) + '\n');
    } else {
      // 调用具体工具
      child.stdin.write(JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: toolName,
          arguments: args,
        },
      }) + '\n');
    }
  });
}

async function probeXhsBrowseBackend(config) {
  if (!config.isConfigured) {
    return {
      ok: false,
      error_code: XHS_BROWSE_ERROR_CODES.BACKEND_UNAVAILABLE,
      message: 'XHS_BROWSE not configured',
    };
  }

  const result = await callXhsBrowseBackend('probe', {}, config);
  
  if (!result.ok) {
    return result;
  }

  // 匹配工具名
  const availableTools = result.available_tools || [];
  const matchedTools = {};

  for (const [category, candidates] of Object.entries(XHS_BROWSE_TOOL_CANDIDATES)) {
    for (const candidate of candidates) {
      if (availableTools.includes(candidate)) {
        matchedTools[category] = candidate;
        break;
      }
    }
  }

  return {
    ok: true,
    backend: 'xhs_browse',
    command: config.command,
    args: config.args,
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

function normalizeXhsBrowseResponse(category, rawData) {
  // 根据类别归一化响应结构
  if (category === 'search') {
    return {
      ok: true,
      query: rawData.query || '',
      results: (rawData.results || []).map(item => ({
        note_id: item.note_id || item.id || '',
        title: item.title || '',
        user: item.user || { id: item.user_id || '', name: item.username || '' },
        url: item.url || item.link || '',
        cover_image: item.cover_image || item.cover || item.image || '',
      })),
      total_count: rawData.total_count || rawData.total || (rawData.results || []).length,
    };
  }

  if (category === 'note') {
    return {
      ok: true,
      note_id: rawData.note_id || rawData.id || '',
      title: rawData.title || '',
      content: rawData.content || rawData.desc || rawData.description || '',
      images: rawData.images || rawData.image_list || [],
      user: rawData.user || { id: rawData.user_id || '', name: rawData.username || '' },
      create_time: rawData.create_time || rawData.created_at || '',
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
    };
  }

  return { ok: true, data: rawData };
}

// ============================================================================
// XHS Browse 工具实现
// ============================================================================

async function xhsBrowseProbe(args, options = {}) {
  const config = getXhsBrowseConfig();
  
  if (!config.isConfigured) {
    return {
      ok: false,
      error_code: XHS_BROWSE_ERROR_CODES.BACKEND_UNAVAILABLE,
      message: 'XHS_BROWSE_MCP_COMMAND not configured',
    };
  }

  return await probeXhsBrowseBackend(config);
}

async function xhsBrowseSearch(args, options = {}) {
  const config = getXhsBrowseConfig();

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
  const rateLimitError = checkXhsBrowseRateLimit(config);
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
  const probeResult = await probeXhsBrowseBackend(config);
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
  const result = await callXhsBrowseBackend(backendToolName, {
    query,
    max_results: maxResults,
    sort,
  }, config);

  if (!result.ok) {
    return {
      ok: false,
      error_code: XHS_BROWSE_ERROR_CODES.SEARCH_FAILED,
      message: result.message || 'Search failed',
    };
  }

  return normalizeXhsBrowseResponse('search', result.data || {});
}

async function xhsBrowseNote(args, options = {}) {
  const config = getXhsBrowseConfig();

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
  const rateLimitError = checkXhsBrowseRateLimit(config);
  if (rateLimitError) {
    return rateLimitError;
  }

  // 参数验证
  const noteId = String(args.note_id || '').trim();
  if (!noteId) {
    return {
      ok: false,
      error_code: XHS_BROWSE_ERROR_CODES.INVALID_ARGUMENT,
      message: 'note_id is required',
    };
  }

  // 探测后端并获取工具映射
  const probeResult = await probeXhsBrowseBackend(config);
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

  // 调用后端
  const backendToolName = probeResult.matched_tools.note;
  const result = await callXhsBrowseBackend(backendToolName, {
    note_id: noteId,
    include_images: args.include_images !== false,
  }, config);

  if (!result.ok) {
    return {
      ok: false,
      error_code: XHS_BROWSE_ERROR_CODES.NOTE_READ_FAILED,
      message: result.message || 'Failed to read note',
    };
  }

  return normalizeXhsBrowseResponse('note', result.data || {});
}

async function xhsBrowseUser(args, options = {}) {
  const config = getXhsBrowseConfig();

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
  const probeResult = await probeXhsBrowseBackend(config);
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
  }, config);

  if (!result.ok) {
    return {
      ok: false,
      error_code: XHS_BROWSE_ERROR_CODES.PROFILE_FAILED,
      message: result.message || 'Failed to get user profile',
    };
  }

  return normalizeXhsBrowseResponse('user', result.data || {});
}

async function xhsBrowseFeed(args, options = {}) {
  const config = getXhsBrowseConfig();

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
  const probeResult = await probeXhsBrowseBackend(config);
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
  }, config);

  if (!result.ok) {
    return {
      ok: false,
      error_code: XHS_BROWSE_ERROR_CODES.FEED_FAILED,
      message: result.message || 'Failed to get feed',
    };
  }

  return normalizeXhsBrowseResponse('feed', result.data || {});
}
