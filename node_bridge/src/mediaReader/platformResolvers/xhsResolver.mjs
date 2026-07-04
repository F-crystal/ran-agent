import { readFileSync } from 'node:fs';
import { MediaReaderError, hostFromUrl } from '../assetResolver.mjs';
import {
  assertSafePlatformUrl,
  resolveShortlink,
} from './index.mjs';
import { callMcpToolViaStdio, textFromMcpResult } from './mcpClient.mjs';

const DEFAULT_MAX_XHS_ASSETS = 100;

function boolFromEnv(env, key, fallback) {
  const value = env?.[key];
  if (value === undefined || value === null || value === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

function normalizeMaxAssets(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.floor(parsed), DEFAULT_MAX_XHS_ASSETS) : DEFAULT_MAX_XHS_ASSETS;
}

function positiveTimeoutMs(...values) {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  }
  return 45000;
}

function resolveXhsGenericFallbackTimeoutMs(env = process.env) {
  return positiveTimeoutMs(
    env.SOCIAL_READER_XHS_GENERIC_FALLBACK_TIMEOUT_MS,
    env.SOCIAL_READER_XHS_BACKEND_TIMEOUT_MS,
    env.XHS_BACKEND_MCP_TIMEOUT_MS,
    env.SOCIAL_READER_MCP_TIMEOUT_MS,
    90000
  );
}

function noteIdFromUrl(url) {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/\/(?:explore|discovery\/item)\/([^/?#]+)/);
    return match ? match[1] : '';
  } catch {
    return '';
  }
}

function hasXsecToken(url) {
  try {
    const parsed = new URL(url);
    return Boolean(parsed.searchParams.get('xsec_token'));
  } catch {
    return false;
  }
}

function canonicalXhsNoteUrl(url) {
  try {
    const parsed = new URL(String(url || '').trim());
    const noteId = noteIdFromUrl(parsed.toString());
    if (!noteId) return parsed.toString();
    const canonical = new URL(`https://www.xiaohongshu.com/explore/${noteId}`);
    const xsecToken = parsed.searchParams.get('xsec_token') || '';
    const xsecSource = parsed.searchParams.get('xsec_source') || '';
    if (xsecToken) canonical.searchParams.set('xsec_token', xsecToken);
    if (xsecSource) canonical.searchParams.set('xsec_source', xsecSource);
    return canonical.toString();
  } catch {
    return String(url || '');
  }
}

function warning(code, extra = {}) {
  return { code, ...extra };
}

function readGenericFallbackMarker(env = process.env) {
  const markerPath = env.XHS_GENERIC_FALLBACK_READY_PATH
    || '/opt/ran_agent/.ran_agent_state/social_reader/generic-fallback-ready.json';
  try {
    return JSON.parse(readFileSync(markerPath, 'utf8'));
  } catch {
    return null;
  }
}

function normalizeMedia(media = [], maxAssets = DEFAULT_MAX_XHS_ASSETS) {
  return media
    .filter(Boolean)
    .slice(0, maxAssets)
    .map((item, index) => ({
      type: item.type || (item.video_url ? 'video' : item.cover_url ? 'cover' : item.image_url ? 'image' : 'unknown'),
      url: item.url || item.media_url || item.video_url || item.cover_url || item.image_url || '',
      asset_id: item.asset_id || `${item.type || 'media'}-${index + 1}`,
      mime: item.mime || '',
      duration_seconds: item.duration_seconds ?? null,
      source: item.source || 'platform_resolver',
    }));
}

function parseMaybeJson(text = '') {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function firstTextValue(...values) {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) return text;
  }
  return '';
}

function pushUrlMedia(output, type, url, maxAssets) {
  const text = String(url || '').trim();
  if (!text || output.length >= maxAssets) return;
  if (output.some((item) => item.url === text)) return;
  output.push({
    type,
    url: text,
    asset_id: `${type}-${output.length + 1}`,
    source: 'generic_parser_fallback',
  });
}

function collectGenericMediaFromValue(output, value, fallbackType, maxAssets) {
  if (!value || output.length >= maxAssets) return;
  if (typeof value === 'string') {
    pushUrlMedia(output, fallbackType, value, maxAssets);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectGenericMediaFromValue(output, item, fallbackType, maxAssets);
    return;
  }
  if (typeof value !== 'object') return;
  const imageUrl = firstTextValue(
    value.url_png,
    value.url_webp,
    value.urlDefault,
    value.urlPre,
    value.url_default,
    value.url_pre,
    value.image_url,
    value.imageUrl,
    value.cover_url,
    value.cover,
    value.thumbnail,
    value.src,
    value.url,
  );
  const videoUrl = firstTextValue(value.video_url, value.videoUrl, value.media_url);
  const type = String(value.type || value.media_type || '').toLowerCase();
  if (videoUrl || type.includes('video')) {
    pushUrlMedia(output, 'video', videoUrl || imageUrl, maxAssets);
    return;
  }
  if (imageUrl) pushUrlMedia(output, fallbackType, imageUrl, maxAssets);
}

function normalizeGenericFallbackResult(text = '', { noteId = '', sourceHost = '', maxAssets = DEFAULT_MAX_XHS_ASSETS } = {}) {
  const parsed = parseMaybeJson(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      metadata: { note_id: noteId, source_url_host: sourceHost },
      post_text: String(text || '').trim(),
      media: [],
    };
  }
  const title = firstTextValue(parsed.title, parsed.name);
  const body = firstTextValue(
    parsed.post_text,
    parsed.postText,
    parsed.content,
    parsed.full_text,
    parsed.fullText,
    parsed.desc,
    parsed.description,
    parsed.caption,
    parsed.text,
  );
  const postText = [title, body].filter(Boolean).join('\n\n');
  const media = [];
  collectGenericMediaFromValue(media, parsed.image_urls, 'image', maxAssets);
  collectGenericMediaFromValue(media, parsed.imageUrls, 'image', maxAssets);
  collectGenericMediaFromValue(media, parsed.images, 'image', maxAssets);
  collectGenericMediaFromValue(media, parsed.imageList, 'image', maxAssets);
  collectGenericMediaFromValue(media, parsed.image_list, 'image', maxAssets);
  collectGenericMediaFromValue(media, parsed.data?.note?.imageList, 'image', maxAssets);
  collectGenericMediaFromValue(media, parsed.data?.note?.images, 'image', maxAssets);
  collectGenericMediaFromValue(media, parsed.media, 'image', maxAssets);
  collectGenericMediaFromValue(media, parsed.media_list, 'image', maxAssets);
  collectGenericMediaFromValue(media, parsed.medias, 'image', maxAssets);
  collectGenericMediaFromValue(media, parsed.video_urls, 'video', maxAssets);
  collectGenericMediaFromValue(media, parsed.videos, 'video', maxAssets);
  return {
    metadata: {
      note_id: firstTextValue(parsed.note_id, parsed.noteId, noteId),
      source_url_host: sourceHost,
      title,
      tags: Array.isArray(parsed.tags) ? parsed.tags : [],
    },
    post_text: postText,
    media,
  };
}

function mediaHasVideo(media = []) {
  return media.some((item) => item.type === 'video' || item.video_url || item.mime?.startsWith?.('video/'));
}

function providerFromOptions(options = {}) {
  return options.platformProviders?.xhs;
}

function genericMarkerOrInjected(env, options = {}) {
  return readGenericFallbackMarker(env)
    || (typeof options.mcpCallImpl === 'function' ? { ok: true, command: 'injected-test-generic-parser', args: [], tool_name: 'parse_xhs_link' } : null);
}

function xhsPublicSidecarConfig(env = process.env) {
  const enabled = boolFromEnv(env, 'XHS_PUBLIC_SIDECAR_ENABLED', true);
  const url = String(env.XHS_PUBLIC_SIDECAR_URL || '').trim();
  return {
    enabled,
    url,
    timeoutMs: positiveTimeoutMs(env.XHS_PUBLIC_SIDECAR_TIMEOUT_MS, env.SOCIAL_READER_XHS_GENERIC_FALLBACK_TIMEOUT_MS, 90000),
    configured: Boolean(enabled && url),
  };
}

async function parseResponseBody(response) {
  if (typeof response?.json === 'function') return await response.json();
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

async function fetchXhsPublicSidecar({ resolvedUrl, noteId, sourceHost, maxAssets }, options = {}) {
  const env = options.env || process.env;
  const config = xhsPublicSidecarConfig(env);
  if (!config.configured) return null;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetchImpl(config.url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: resolvedUrl, download: false, cookie: '' }),
    });
    if (response?.ok === false || Number(response?.status || 200) >= 400) return null;
    const body = await parseResponseBody(response);
    return normalizeGenericFallbackResult(typeof body === 'string' ? body : JSON.stringify(body), {
      noteId,
      sourceHost,
      maxAssets,
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function hasPublicFallbackContent(fallback) {
  return Boolean(fallback?.post_text || fallback?.media?.length);
}

async function resolvePublicXhsFallback({ originalUrl, resolvedUrl, noteId, args, maxAssets }, options = {}) {
  const env = options.env || process.env;
  const sourceHost = hostFromUrl(resolvedUrl);
  const marker = genericMarkerOrInjected(env, options);
  const warnings = [];
  if (!hasXsecToken(resolvedUrl)) warnings.push(warning('XHS_MISSING_XSEC_TOKEN'));
  if (args.include_comments === true) warnings.push(warning('XHS_COMMENTS_UNSUPPORTED_PUBLIC_ONLY'));

  if (marker?.ok) {
    try {
      const toolName = marker.tool_name || 'parse_xhs_link';
      const timeoutMs = resolveXhsGenericFallbackTimeoutMs(env);
      const genericResult = typeof options.mcpCallImpl === 'function'
        ? await options.mcpCallImpl({
          server: 'generic',
          toolName,
          arguments: { share_link: resolvedUrl },
          timeoutMs,
        })
        : await callMcpToolViaStdio({
          command: marker.command,
          args: marker.args || [],
          env: process.env,
          toolName,
          arguments: { share_link: resolvedUrl },
          timeoutMs,
        });
      const fallback = normalizeGenericFallbackResult(textFromMcpResult(genericResult), {
        noteId,
        sourceHost,
        maxAssets,
      });
      if (hasPublicFallbackContent(fallback)) {
        return {
          ok: true,
          partial: true,
          content_available: true,
          full_text_available: false,
          evidence_level: 'generic_parser',
          should_answer_from_content: true,
          source: 'generic_parser_fallback',
          platform: 'xhs',
          resolver: 'xhsResolver',
          original_url: originalUrl,
          resolved_url: resolvedUrl,
          metadata: fallback.metadata,
          post_text: fallback.post_text,
          comments: [],
          comments_supported: false,
          media: normalizeMedia(fallback.media, maxAssets),
          max_assets: maxAssets,
          public_only: true,
          account_backed: false,
          warnings: [...warnings, warning('GENERIC_PARSER_FALLBACK'), warning('FULL_TEXT_UNAVAILABLE')],
        };
      }
    } catch {
      // Try the next public-only path.
    }
  }

  const sidecar = await fetchXhsPublicSidecar({ resolvedUrl, noteId, sourceHost, maxAssets }, options);
  if (hasPublicFallbackContent(sidecar)) {
    return {
      ok: true,
      partial: true,
      content_available: true,
      full_text_available: false,
      evidence_level: 'xhs_downloader_public_sidecar',
      should_answer_from_content: true,
      source: 'xhs-downloader-sidecar',
      platform: 'xhs',
      resolver: 'xhsResolver',
      original_url: originalUrl,
      resolved_url: resolvedUrl,
      metadata: sidecar.metadata,
      post_text: sidecar.post_text,
      comments: [],
      comments_supported: false,
      media: normalizeMedia(sidecar.media, maxAssets),
      max_assets: maxAssets,
      public_only: true,
      account_backed: false,
      warnings: [...warnings, warning('XHS_DOWNLOADER_PUBLIC_SIDECAR')],
    };
  }

  return {
    ok: true,
    partial: true,
    content_available: false,
    full_text_available: false,
    evidence_level: 'metadata_only',
    should_answer_from_content: false,
    source: 'xhs_public_only',
    platform: 'xhs',
    resolver: 'xhsResolver',
    original_url: originalUrl,
    resolved_url: resolvedUrl,
    metadata: { note_id: noteId, source_url_host: sourceHost },
    post_text: '',
    comments: [],
    comments_supported: false,
    media: [],
    max_assets: maxAssets,
    public_only: true,
    account_backed: false,
    error_code: 'XHS_PUBLIC_PARSE_FAILED',
    warnings: [...warnings, warning('XHS_PUBLIC_PARSE_FAILED'), warning('PARTIAL_RESULT')],
  };
}

export async function resolveXhsMedia(args = {}, options = {}) {
  const env = options.env || process.env;
  if (!boolFromEnv(env, 'PERSONAL_AGENT_XHS_ENABLED', true)) {
    throw new MediaReaderError('PLATFORM_RESOLVER_NOT_CONFIGURED', 'PLATFORM_RESOLVER_NOT_CONFIGURED: XHS resolver is disabled');
  }
  const originalUrl = args.originalUrl || args.url_or_text || args.url || '';
  await assertSafePlatformUrl(originalUrl, { platform: 'xhs', options });
  let resolvedUrl = originalUrl;
  if (hostFromUrl(originalUrl) === 'xhslink.com') {
    resolvedUrl = await resolveShortlink(originalUrl, {
      platform: 'xhs',
      options,
      errorCode: 'XHS_SHORTLINK_RESOLVE_FAILED',
    });
  }
  resolvedUrl = canonicalXhsNoteUrl(resolvedUrl);
  await assertSafePlatformUrl(resolvedUrl, { platform: 'xhs', options });
  const noteId = noteIdFromUrl(resolvedUrl);
  const maxAssets = normalizeMaxAssets(args.max_assets);
  const result = await resolvePublicXhsFallback({ originalUrl, resolvedUrl, noteId, args, maxAssets }, options);
  return {
    ...result,
    subtitle: null,
    transcript_source: 'none',
    visual_source: Array.isArray(result.media) && result.media.some((item) => ['image', 'cover'].includes(item.type)) ? 'thumbnail' : 'none',
  };
}
