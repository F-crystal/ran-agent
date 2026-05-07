import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { MediaReaderError, hostFromUrl } from '../assetResolver.mjs';
import {
  assertSafePlatformUrl,
  detectPlatformFromUrl,
  resolveShortlink,
} from './index.mjs';
import { callMcpToolViaStdio, parseJsonArrayEnv, textFromMcpResult } from './mcpClient.mjs';

const execFileAsync = promisify(execFile);

function boolFromEnv(env, key, fallback) {
  const value = env?.[key];
  if (value === undefined || value === null || value === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

function normalizeMaxAssets(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.floor(parsed), 100) : 20;
}

function extractBvid(url) {
  const match = String(url || '').match(/\/video\/(BV[0-9A-Za-z]+)/);
  return match ? match[1] : '';
}

function pageFromUrl(url) {
  try {
    const parsed = new URL(url);
    const page = Number(parsed.searchParams.get('p') || 1);
    return Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
  } catch {
    return 1;
  }
}

function warning(code, extra = {}) {
  return { code, ...extra };
}

function mapBilibiliError(error) {
  const code = String(error?.error_code || '').trim();
  if (code) return code;
  const text = `${error?.message || error || ''}`.toLowerCase();
  if (text.includes('login') || text.includes('auth') || text.includes('sessdata')) return 'BILIBILI_AUTH_REQUIRED';
  if (text.includes('vip')) return 'BILIBILI_VIP_REQUIRED';
  if (text.includes('region')) return 'BILIBILI_REGION_BLOCKED';
  if (text.includes('expire')) return 'STREAM_URL_EXPIRED';
  if (text.includes('not found')) return 'BILIBILI_EXTRACT_FAILED';
  return 'BILIBILI_EXTRACT_FAILED';
}

function normalizeMedia(media = [], maxAssets = 20) {
  return media
    .filter(Boolean)
    .slice(0, maxAssets)
    .map((item, index) => ({
      type: item.type || 'unknown',
      url: item.url || item.media_url || item.cover_url || item.image_url || '',
      asset_id: item.asset_id || `${item.type || 'media'}-${index + 1}`,
      mime: item.mime || '',
      duration_seconds: item.duration_seconds ?? null,
      source: 'platform_resolver',
      text: item.text || '',
    }));
}

function providerFromOptions(options = {}) {
  return options.platformProviders?.bilibili;
}

async function resolveWithMcp({ originalUrl, resolvedUrl, bvid, page, args, maxAssets }, options = {}) {
  const env = options.env || process.env;
  let result;
  if (typeof options.mcpCallImpl === 'function') {
    result = await options.mcpCallImpl({
      server: 'bilibili',
      toolName: 'get_video_info',
      arguments: { bvid },
    });
  } else {
    const command = String(env.PERSONAL_AGENT_BILIBILI_MCP_COMMAND || '').trim();
    if (!command) {
      return null;
    }
    result = await callMcpToolViaStdio({
      command,
      args: parseJsonArrayEnv(env.PERSONAL_AGENT_BILIBILI_MCP_ARGS_JSON, []),
      env: process.env,
      toolName: 'get_video_info',
      arguments: { bvid },
      timeoutMs: Number(env.PERSONAL_AGENT_PLATFORM_RESOLVE_TIMEOUT_MS || 15000),
    });
  }
  return {
    metadata: { bvid, page, source_url_host: hostFromUrl(resolvedUrl) },
    post_text: textFromMcpResult(result),
    comments: args.include_comments === true ? [] : [],
    media: [],
    original_url: originalUrl,
  };
}

async function resolveWithYtdlp({ resolvedUrl, bvid, page, maxAssets }, options = {}) {
  const env = options.env || process.env;
  const ytdlpPath = String(env.PERSONAL_AGENT_YTDLP_PATH || '').trim();
  if (!ytdlpPath) {
    throw new MediaReaderError('PLATFORM_RESOLVER_NOT_CONFIGURED', 'PLATFORM_RESOLVER_NOT_CONFIGURED: Bilibili provider or yt-dlp path is not configured');
  }
  const execFileImpl = options.execFileImpl || execFileAsync;
  try {
    const { stdout } = await execFileImpl(ytdlpPath, [
      '--dump-json',
      '--skip-download',
      '--no-warnings',
      '--write-subs',
      '--write-auto-subs',
      '--sub-langs',
      'zh-Hans,zh-CN,zh,en',
      resolvedUrl,
    ], {
      timeout: Number(env.PERSONAL_AGENT_PLATFORM_RESOLVE_TIMEOUT_MS || 15000),
      maxBuffer: 10 * 1024 * 1024,
    });
    const payload = JSON.parse(String(stdout || '{}').trim().split('\n').at(-1) || '{}');
    const thumbnail = payload.thumbnail || '';
    const media = [];
    if (thumbnail) {
      media.push({ type: 'cover', url: thumbnail, mime: 'image/jpeg' });
    }
    return {
      metadata: {
        title: payload.title || '',
        bvid,
        page,
        uploader: payload.uploader || '',
        duration_seconds: payload.duration || null,
      },
      post_text: payload.description || payload.title || '',
      media: normalizeMedia(media, maxAssets),
      subtitle: null,
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new MediaReaderError('DEPENDENCY_MISSING', 'DEPENDENCY_MISSING: yt-dlp command is missing');
    }
    throw new MediaReaderError(mapBilibiliError(error), `${mapBilibiliError(error)}: Bilibili extraction failed`);
  }
}

export async function resolveBilibiliMedia(args = {}, options = {}) {
  const env = options.env || process.env;
  if (!boolFromEnv(env, 'PERSONAL_AGENT_BILIBILI_ENABLED', true)) {
    throw new MediaReaderError('PLATFORM_RESOLVER_NOT_CONFIGURED', 'PLATFORM_RESOLVER_NOT_CONFIGURED: Bilibili resolver is disabled');
  }
  const originalUrl = args.originalUrl || args.url_or_text || args.url || '';
  await assertSafePlatformUrl(originalUrl, { platform: 'bilibili', options });
  let resolvedUrl = originalUrl;
  if (hostFromUrl(originalUrl) === 'b23.tv') {
    resolvedUrl = await resolveShortlink(originalUrl, {
      platform: 'bilibili',
      options,
      errorCode: 'SHORTLINK_RESOLVE_FAILED',
    });
  }
  if (detectPlatformFromUrl(resolvedUrl) !== 'bilibili') {
    throw new MediaReaderError('BILIBILI_EXTRACT_FAILED', 'BILIBILI_EXTRACT_FAILED: resolved URL is not Bilibili');
  }
  await assertSafePlatformUrl(resolvedUrl, { platform: 'bilibili', options });
  const bvid = extractBvid(resolvedUrl);
  const page = pageFromUrl(resolvedUrl);
  if (!bvid) {
    throw new MediaReaderError('BILIBILI_EXTRACT_FAILED', 'BILIBILI_EXTRACT_FAILED: BVID not found');
  }
  const maxAssets = normalizeMaxAssets(args.max_assets);
  const provider = providerFromOptions(options);
  let providerResult;
  try {
    if (provider?.resolve) {
      providerResult = await provider.resolve({
        url: resolvedUrl,
        original_url: originalUrl,
        bvid,
        page,
        media_detail: args.media_detail || 'standard',
        include_comments: args.include_comments === true,
        max_comments: Number(args.max_comments || 30),
        max_assets: maxAssets,
      });
    } else {
      providerResult = await resolveWithMcp({ originalUrl, resolvedUrl, bvid, page, args, maxAssets }, options)
        || await resolveWithYtdlp({ resolvedUrl, bvid, page, maxAssets }, options);
    }
  } catch (error) {
    if (error instanceof MediaReaderError) {
      throw error;
    }
    const code = mapBilibiliError(error);
    throw new MediaReaderError(code, `${code}: Bilibili extraction failed`);
  }

  const metadata = {
    ...(providerResult?.metadata || {}),
    bvid: providerResult?.metadata?.bvid || bvid,
    page: providerResult?.metadata?.page || page,
  };
  const media = normalizeMedia(providerResult?.media || [], maxAssets);
  const subtitle = providerResult?.subtitle || media.find((item) => item.type === 'subtitle' && item.text)?.text || null;
  const hasCover = media.some((item) => item.type === 'cover' || item.type === 'image');
  const warnings = Array.isArray(providerResult?.warnings) ? providerResult.warnings : [];
  if (!subtitle) {
    warnings.push(warning('SUBTITLE_NOT_FOUND'));
  }
  return {
    ok: true,
    platform: 'bilibili',
    resolver: 'bilibiliResolver',
    original_url: originalUrl,
    resolved_url: resolvedUrl,
    metadata,
    post_text: String(providerResult?.post_text || ''),
    comments: Array.isArray(providerResult?.comments) ? providerResult.comments.slice(0, Number(args.max_comments || 30)) : [],
    media,
    subtitle: subtitle && typeof subtitle === 'object' ? subtitle : subtitle ? { text: String(subtitle) } : null,
    transcript_source: subtitle ? 'subtitle' : 'none',
    visual_source: hasCover ? 'thumbnail' : 'none',
    warnings,
  };
}
