import { readFileSync } from 'node:fs';
import { MediaReaderError, hostFromUrl } from '../assetResolver.mjs';
import {
  assertSafePlatformUrl,
  resolveShortlink,
} from './index.mjs';
import { callMcpToolViaStdio, parseJsonArrayEnv, textFromMcpResult } from './mcpClient.mjs';

function boolFromEnv(env, key, fallback) {
  const value = env?.[key];
  if (value === undefined || value === null || value === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

function normalizeMaxAssets(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.floor(parsed), 100) : 20;
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

function isRecoverableXhsError(error) {
  const code = String(error?.error_code || '').trim();
  // Non-recoverable: auth, cookie, risk control, config errors
  if (['XHS_AUTH_REQUIRED', 'XHS_COOKIE_MISSING', 'XHS_RISK_CONTROL', 'PLATFORM_RESOLVER_NOT_CONFIGURED'].includes(code)) return false;
  // Recoverable by explicit code
  if (['XHS_BACKEND_TIMEOUT', 'XHS_BACKEND_MCP_ERROR', 'XHS_NETWORK_ERROR', 'XHS_SHORTLINK_RESOLVE_FAILED'].includes(code)) return true;
  // Recoverable by message inspection (only when no explicit error_code)
  if (!code) {
    const msg = String(error?.message || error || '').toLowerCase();
    if (msg.includes('timed out') || msg.includes('timeout')) return true;
    if (msg.includes('enotfound') || msg.includes('econnrefused') || msg.includes('network')) return true;
  }
  return false;
}

function mapXhsError(error) {
  const code = String(error?.error_code || '').trim();
  if (code) return code;
  const text = `${error?.message || error || ''}`.toLowerCase();
  if (text.includes('risk') || text.includes('captcha') || text.includes('verify')) return 'XHS_RISK_CONTROL';
  if (text.includes('login') || text.includes('auth') || text.includes('cookie')) return 'XHS_AUTH_REQUIRED';
  if (text.includes('xsec')) return 'XHS_MISSING_XSEC_TOKEN';
  if (text.includes('timed out') || text.includes('timeout')) return 'XHS_BACKEND_TIMEOUT';
  return 'XHS_BACKEND_MCP_ERROR';
}

function normalizeMedia(media = [], maxAssets = 20) {
  return media
    .filter(Boolean)
    .slice(0, maxAssets)
    .map((item, index) => ({
      type: item.type || (item.video_url ? 'video' : item.cover_url ? 'cover' : item.image_url ? 'image' : 'unknown'),
      url: item.url || item.media_url || item.video_url || item.cover_url || item.image_url || '',
      asset_id: item.asset_id || `${item.type || 'media'}-${index + 1}`,
      mime: item.mime || '',
      duration_seconds: item.duration_seconds ?? null,
      source: 'platform_resolver',
    }));
}

function mediaHasVideo(media = []) {
  return media.some((item) => item.type === 'video' || item.video_url || item.mime?.startsWith?.('video/'));
}

function providerFromOptions(options = {}) {
  return options.platformProviders?.xhs;
}

async function callXhsMcp({ toolName, resolvedUrl, maxComments }, options = {}) {
  const env = options.env || process.env;
  if (typeof options.mcpCallImpl === 'function') {
    return await options.mcpCallImpl({
      server: 'xhs',
      toolName,
      arguments: toolName === 'get_note_comments'
        ? { url: resolvedUrl, max_count: maxComments }
        : { url: resolvedUrl },
    });
  }
  const command = String(env.PERSONAL_AGENT_XHS_MCP_COMMAND || '').trim();
  if (!command) {
    return null;
  }
  return await callMcpToolViaStdio({
    command,
    args: parseJsonArrayEnv(env.PERSONAL_AGENT_XHS_MCP_ARGS_JSON, []),
    env: process.env,
    toolName,
    arguments: toolName === 'get_note_comments'
      ? { url: resolvedUrl, max_count: maxComments }
      : { url: resolvedUrl },
    timeoutMs: Number(env.XHS_BACKEND_MCP_TIMEOUT_MS || env.PERSONAL_AGENT_PLATFORM_RESOLVE_TIMEOUT_MS || 90000),
  });
}

async function resolveWithMcp({ resolvedUrl, noteId, args, maxAssets }, options = {}) {
  const postResult = await callXhsMcp({
    toolName: 'get_note_content',
    resolvedUrl,
    maxComments: Number(args.max_comments || 30),
  }, options);
  if (!postResult) {
    return null;
  }
  let comments = [];
  if (args.include_comments === true) {
    const commentsResult = await callXhsMcp({
      toolName: 'get_note_comments',
      resolvedUrl,
      maxComments: Number(args.max_comments || 30),
    }, options);
    const commentsText = textFromMcpResult(commentsResult);
    comments = commentsText
      ? commentsText.split(/\n\s*\n/).map((item) => item.trim()).filter(Boolean).slice(0, Number(args.max_comments || 30))
      : [];
  }
  return {
    metadata: { note_id: noteId, source_url_host: hostFromUrl(resolvedUrl) },
    post_text: textFromMcpResult(postResult),
    comments,
    media: [],
    max_assets: maxAssets,
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
  await assertSafePlatformUrl(resolvedUrl, { platform: 'xhs', options });
  const noteId = noteIdFromUrl(resolvedUrl);
  const maxAssets = normalizeMaxAssets(args.max_assets);
  const provider = providerFromOptions(options);

  let providerResult;
  try {
    if (provider?.resolve) {
      providerResult = await provider.resolve({
        url: resolvedUrl,
        original_url: originalUrl,
        note_id: noteId,
        media_detail: args.media_detail || 'standard',
        include_comments: args.include_comments === true,
        max_comments: Number(args.max_comments || 30),
        max_assets: maxAssets,
      });
    } else {
      providerResult = await resolveWithMcp({ resolvedUrl, noteId, args, maxAssets }, options);
      if (!providerResult) {
        throw new MediaReaderError('PLATFORM_RESOLVER_NOT_CONFIGURED', 'PLATFORM_RESOLVER_NOT_CONFIGURED: XHS backend provider is not configured');
      }
    }
  } catch (error) {
    const code = mapXhsError(error);
    // Only attempt fallback for recoverable errors
    if (!isRecoverableXhsError(error)) {
      if (error instanceof MediaReaderError) throw error;
      throw new MediaReaderError(code, `${code}: XHS backend resolver failed`);
    }

    // For recoverable errors, try generic parser fallback via readiness marker
    const marker = readGenericFallbackMarker(env);
    if (!marker?.ok) {
      // No generic fallback available — return metadata-only partial
      return {
        ok: true,
        partial: true,
        content_available: false,
        full_text_available: false,
        evidence_level: 'metadata_only',
        should_answer_from_content: false,
        platform: 'xhs',
        resolver: 'xhsResolver',
        original_url: originalUrl,
        resolved_url: resolvedUrl,
        metadata: { note_id: noteId, source_url_host: hostFromUrl(resolvedUrl) },
        post_text: '',
        comments: [],
        media: [],
        max_assets: maxAssets,
        warnings: [
          warning(code, { message: `XHS backend failed: ${error?.message || error}` }),
          warning('XHS_GENERIC_FALLBACK_NOT_READY'),
          warning('PARTIAL_RESULT'),
        ],
      };
    }

    try {
      const { callMcpToolViaStdio, textFromMcpResult } = await import('./mcpClient.mjs');
      const genericResult = await callMcpToolViaStdio({
        command: marker.command,
        args: marker.args || [],
        env: process.env,
        toolName: marker.tool_name || 'parse_xhs_link',
        arguments: { share_link: resolvedUrl },
        timeoutMs: Number(env.SOCIAL_READER_MCP_TIMEOUT_MS || 45000),
      });
      const text = textFromMcpResult(genericResult);
      if (text) {
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
          metadata: { note_id: noteId, source_url_host: hostFromUrl(resolvedUrl) },
          post_text: text,
          comments: [],
          media: [],
          max_assets: maxAssets,
          warnings: [
            warning('GENERIC_PARSER_FALLBACK'),
            warning('FULL_TEXT_UNAVAILABLE'),
          ],
        };
      }
    } catch {
      // Generic parser also failed — fall through to metadata-only partial result
    }

    // Metadata-only partial result
    return {
      ok: true,
      partial: true,
      content_available: false,
      full_text_available: false,
      evidence_level: 'metadata_only',
      should_answer_from_content: false,
      platform: 'xhs',
      resolver: 'xhsResolver',
      original_url: originalUrl,
      resolved_url: resolvedUrl,
      metadata: { note_id: noteId, source_url_host: hostFromUrl(resolvedUrl) },
      post_text: '',
      comments: [],
      media: [],
      max_assets: maxAssets,
      warnings: [
        warning(code, { message: `XHS backend failed: ${error?.message || error}` }),
        warning('PARTIAL_RESULT'),
      ],
    };
  }

  const media = normalizeMedia(providerResult?.media || [], maxAssets);
  const metadata = {
    ...(providerResult?.metadata || {}),
    note_id: providerResult?.metadata?.note_id || noteId,
  };
  const warnings = Array.isArray(providerResult?.warnings) ? [...providerResult.warnings] : [];
  if (!hasXsecToken(resolvedUrl)) {
    warnings.push(warning('XHS_MISSING_XSEC_TOKEN'));
  }
  if ((metadata.has_video || providerResult?.has_video) && !mediaHasVideo(media)) {
    warnings.push(warning('XHS_VIDEO_ASSET_NOT_EXPOSED_BY_BACKEND'));
  }
  const comments = Array.isArray(providerResult?.comments) ? providerResult.comments.slice(0, Number(args.max_comments || 30)) : [];
  return {
    ok: true,
    platform: 'xhs',
    resolver: 'xhsResolver',
    original_url: originalUrl,
    resolved_url: resolvedUrl,
    metadata,
    post_text: String(providerResult?.post_text || ''),
    comments,
    media,
    subtitle: providerResult?.subtitle || null,
    transcript_source: providerResult?.subtitle ? 'subtitle' : 'none',
    visual_source: media.some((item) => ['image', 'cover'].includes(item.type)) ? 'thumbnail' : 'none',
    warnings,
  };
}
