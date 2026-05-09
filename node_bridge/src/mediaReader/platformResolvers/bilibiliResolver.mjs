import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { MediaReaderError, hostFromUrl, redactUrl } from '../assetResolver.mjs';
import { createCacheStore, sha256Bytes } from '../cacheStore.mjs';
import {
  assertSafePlatformUrl,
  detectPlatformFromUrl,
  resolveShortlink,
} from './index.mjs';
import { callMcpToolViaStdio, parseJsonArrayEnv, textFromMcpResult } from './mcpClient.mjs';

const execFileAsync = promisify(execFile);
const BILIBILI_RECOVERY_SUGGESTION = '当前服务器访问 B站解析接口被 412 拦截。可以尝试配置 SESSDATA、配置 yt-dlp 代理/更换出口，或提供字幕文本、音频文件、视频文件、本地解析结果。';
const BILIBILI_AUTH_RECOVERY_SUGGESTION = '当前 B站内容需要登录态或权限。可以配置有效 SESSDATA 后重试，或提供字幕文本、音频文件、视频文件、本地解析结果。';

const BILIBILI_ERROR_CODES = new Set([
  'BILIBILI_PRECONDITION_FAILED',
  'BILIBILI_SHORTLINK_BLOCKED',
  'BILIBILI_EXTRACT_FAILED',
  'BILIBILI_AUTH_REQUIRED',
  'BILIBILI_VIP_REQUIRED',
  'BILIBILI_REGION_BLOCKED',
  'STREAM_URL_EXPIRED',
  'SUBTITLE_NOT_FOUND',
  'AUDIO_STREAM_NOT_FOUND',
  'VIDEO_STREAM_NOT_FOUND',
  'DEPENDENCY_MISSING',
  'PLATFORM_RESOLVER_NOT_CONFIGURED',
  'MEDIA_DOWNLOAD_FORBIDDEN',
]);

function boolFromEnv(env, key, fallback) {
  const value = env?.[key];
  if (value === undefined || value === null || value === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

function normalizeMaxAssets(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.floor(parsed), 100) : 20;
}

function normalizeAnalysisSeconds(value, env = process.env) {
  const configured = Number(env.PERSONAL_AGENT_BILIBILI_ANALYSIS_MAX_SECONDS || 60);
  const cap = Number.isFinite(configured) && configured > 0 ? configured : 60;
  const requested = Number(value || cap);
  const seconds = Number.isFinite(requested) && requested > 0 ? requested : cap;
  return Math.min(Math.floor(seconds), Math.floor(cap), 600);
}

function mimeForVideoFile(filePath) {
  const extension = path.extname(String(filePath || '')).toLowerCase();
  if (extension === '.webm') return 'video/webm';
  if (extension === '.mkv') return 'video/x-matroska';
  if (extension === '.mov') return 'video/quicktime';
  return 'video/mp4';
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
  if (BILIBILI_ERROR_CODES.has(code)) return code;
  const text = `${error?.message || ''}\n${error?.stderr || ''}\n${error?.stdout || ''}\n${error || ''}`.toLowerCase();
  if (text.includes('412') || text.includes('precondition failed') || text.includes('request is blocked by server')) return 'BILIBILI_PRECONDITION_FAILED';
  if (text.includes('login') || text.includes('auth') || text.includes('cookie') || text.includes('sessdata')) return 'BILIBILI_AUTH_REQUIRED';
  if (text.includes('403') || text.includes('forbidden')) return 'MEDIA_DOWNLOAD_FORBIDDEN';
  if (text.includes('login') || text.includes('auth') || text.includes('sessdata')) return 'BILIBILI_AUTH_REQUIRED';
  if (text.includes('vip')) return 'BILIBILI_VIP_REQUIRED';
  if (text.includes('region')) return 'BILIBILI_REGION_BLOCKED';
  if (text.includes('expire')) return 'STREAM_URL_EXPIRED';
  if (text.includes('subtitle')) return 'SUBTITLE_NOT_FOUND';
  if (text.includes('audio')) return 'AUDIO_STREAM_NOT_FOUND';
  if (text.includes('video')) return 'VIDEO_STREAM_NOT_FOUND';
  if (text.includes('not found')) return 'BILIBILI_EXTRACT_FAILED';
  return 'BILIBILI_EXTRACT_FAILED';
}

function httpStatusFromError(error) {
  const explicit = Number(error?.http_status || error?.status || error?.statusCode || error?.extra?.http_status);
  if (Number.isInteger(explicit) && explicit > 0) {
    return explicit;
  }
  const text = `${error?.message || ''}\n${error?.stderr || ''}\n${error?.stdout || ''}`;
  const match = text.match(/(?:HTTP(?:\s+Error)?|status)\s*[: ]\s*(\d{3})/i) || text.match(/\b(4\d{2}|5\d{2})\b/);
  return match ? Number(match[1]) : undefined;
}

function ytdlpRuntimeContext(env = process.env) {
  const proxy = String(env.PERSONAL_AGENT_YTDLP_PROXY || '').trim();
  const allowCookies = boolFromEnv(env, 'PERSONAL_AGENT_BILIBILI_ALLOW_AUTH_COOKIES', false);
  const sessdataEnv = String(env.PERSONAL_AGENT_BILIBILI_SESSDATA_ENV || 'SESSDATA').trim() || 'SESSDATA';
  const sessdata = allowCookies ? String(env[sessdataEnv] || '').trim() : '';
  return {
    proxy,
    used_proxy: Boolean(proxy),
    sessdata,
    has_sessdata: Boolean(sessdata),
  };
}

export function shouldDownloadBilibiliForAnalysis(env = process.env) {
  return boolFromEnv(env, 'PERSONAL_AGENT_BILIBILI_DOWNLOAD_FOR_ANALYSIS', false);
}

export async function downloadBilibiliAudioOnly({ url, bvid = '', maxSeconds }, options = {}) {
  const env = options.env || process.env;
  const ytdlpPath = String(env.PERSONAL_AGENT_YTDLP_PATH || '').trim();
  if (!ytdlpPath) {
    throw new MediaReaderError('PLATFORM_RESOLVER_NOT_CONFIGURED', 'PLATFORM_RESOLVER_NOT_CONFIGURED: yt-dlp path is not configured for Bilibili audio analysis', bilibiliErrorExtra({
      code: 'PLATFORM_RESOLVER_NOT_CONFIGURED',
      env,
    }));
  }
  await assertSafePlatformUrl(url, { platform: 'bilibili', options });
  const cache = options.cacheStore || createCacheStore(env);
  const parentDir = path.join(cache.rootDir, 'platform-downloads');
  fs.mkdirSync(parentDir, { recursive: true });
  const workDir = fs.mkdtempSync(path.join(parentDir, 'bilibili-audio-'));
  const runtime = ytdlpRuntimeContext(env);
  const secondsCap = Number(env.PERSONAL_AGENT_BILIBILI_AUDIO_ANALYSIS_MAX_SECONDS || 300);
  const seconds = Math.min(normalizeAnalysisSeconds(maxSeconds, env), secondsCap);
  const ytdlpArgs = [
    '--no-playlist',
    '--no-warnings',
    '-f',
    'ba',
    '--download-sections',
    `*0-${seconds}`,
    '--paths',
    workDir,
    '-o',
    '%(id)s.%(ext)s',
    '--print',
    'after_move:filepath',
    '--no-simulate',
  ];
  const ffmpegPath = String(env.PERSONAL_AGENT_FFMPEG_PATH || '').trim();
  if (ffmpegPath) {
    ytdlpArgs.push('--ffmpeg-location', ffmpegPath);
  }
  if (runtime.proxy) {
    ytdlpArgs.push('--proxy', runtime.proxy);
  }
  if (runtime.sessdata) {
    ytdlpArgs.push('--add-header', `Cookie: SESSDATA=${runtime.sessdata}`);
  }
  ytdlpArgs.push(url);

  try {
    const execFileImpl = options.execFileImpl || execFileAsync;
    const { stdout } = await execFileImpl(ytdlpPath, ytdlpArgs, {
      timeout: Number(env.PERSONAL_AGENT_BILIBILI_ANALYSIS_DOWNLOAD_TIMEOUT_MS || env.PERSONAL_AGENT_MEDIA_PER_ITEM_TIMEOUT_MS || 120000),
      maxBuffer: 10 * 1024 * 1024,
    });
    const printedPath = String(stdout || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .find((line) => path.isAbsolute(line) && fs.existsSync(line));
    const downloadedPath = printedPath || fs.readdirSync(workDir)
      .map((name) => path.join(workDir, name))
      .filter((filePath) => fs.existsSync(filePath) && fs.statSync(filePath).isFile())
      .sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];
    if (!downloadedPath) {
      throw new MediaReaderError('AUDIO_STREAM_NOT_FOUND', 'AUDIO_STREAM_NOT_FOUND: yt-dlp did not produce a Bilibili audio file', bilibiliErrorExtra({
        code: 'AUDIO_STREAM_NOT_FOUND',
        env,
      }));
    }
    const bytes = fs.readFileSync(downloadedPath);
    const ext = path.extname(downloadedPath).toLowerCase();
    const mimeMap = { '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.mp3': 'audio/mpeg', '.opus': 'audio/ogg', '.wav': 'audio/wav' };
    return {
      type: 'audio',
      file_path: downloadedPath,
      mime: mimeMap[ext] || 'audio/mp4',
      content_sha256: sha256Bytes(bytes),
      content_length: bytes.length,
      url_host: hostFromUrl(url),
      url_redacted: redactUrl(url),
      bvid: bvid || extractBvid(url),
      source: 'bilibili_ytdlp_audio_download',
    };
  } catch (error) {
    if (error instanceof MediaReaderError) throw error;
    if (error?.code === 'ENOENT') {
      throw new MediaReaderError('DEPENDENCY_MISSING', 'DEPENDENCY_MISSING: yt-dlp command is missing', bilibiliErrorExtra({
        code: 'DEPENDENCY_MISSING', error, env,
      }));
    }
    const code = mapBilibiliError(error);
    throw new MediaReaderError(code, `${code}: Bilibili audio download failed`, bilibiliErrorExtra({ code, error, env }));
  }
}

function recoverySuggestionFor(code) {
  if (code === 'BILIBILI_AUTH_REQUIRED' || code === 'MEDIA_DOWNLOAD_FORBIDDEN' || code === 'BILIBILI_VIP_REQUIRED') {
    return BILIBILI_AUTH_RECOVERY_SUGGESTION;
  }
  return BILIBILI_RECOVERY_SUGGESTION;
}

export async function downloadBilibiliVideoForAnalysis({ url, bvid = '', maxSeconds }, options = {}) {
  const env = options.env || process.env;
  const ytdlpPath = String(env.PERSONAL_AGENT_YTDLP_PATH || '').trim();
  if (!ytdlpPath) {
    throw new MediaReaderError('PLATFORM_RESOLVER_NOT_CONFIGURED', 'PLATFORM_RESOLVER_NOT_CONFIGURED: yt-dlp path is not configured for Bilibili analysis', bilibiliErrorExtra({
      code: 'PLATFORM_RESOLVER_NOT_CONFIGURED',
      env,
    }));
  }
  await assertSafePlatformUrl(url, { platform: 'bilibili', options });
  const cache = options.cacheStore || createCacheStore(env);
  const parentDir = path.join(cache.rootDir, 'platform-downloads');
  fs.mkdirSync(parentDir, { recursive: true });
  const workDir = fs.mkdtempSync(path.join(parentDir, 'bilibili-'));
  const runtime = ytdlpRuntimeContext(env);
  const seconds = normalizeAnalysisSeconds(maxSeconds, env);
  const format = String(env.PERSONAL_AGENT_BILIBILI_ANALYSIS_FORMAT || 'bv*+ba/b').trim() || 'bv*+ba/b';
  const ytdlpArgs = [
    '--no-playlist',
    '--no-warnings',
    '-f',
    format,
    '--download-sections',
    `*0-${seconds}`,
    '--force-keyframes-at-cuts',
    '--remux-video',
    'mp4',
    '--paths',
    workDir,
    '-o',
    '%(id)s.%(ext)s',
    '--print',
    'after_move:filepath',
    '--no-simulate',
  ];
  const ffmpegPath = String(env.PERSONAL_AGENT_FFMPEG_PATH || '').trim();
  if (ffmpegPath) {
    ytdlpArgs.push('--ffmpeg-location', ffmpegPath);
  }
  if (runtime.proxy) {
    ytdlpArgs.push('--proxy', runtime.proxy);
  }
  if (runtime.sessdata) {
    ytdlpArgs.push('--add-header', `Cookie: SESSDATA=${runtime.sessdata}`);
  }
  ytdlpArgs.push(url);

  try {
    const execFileImpl = options.execFileImpl || execFileAsync;
    const { stdout } = await execFileImpl(ytdlpPath, ytdlpArgs, {
      timeout: Number(env.PERSONAL_AGENT_BILIBILI_ANALYSIS_DOWNLOAD_TIMEOUT_MS || env.PERSONAL_AGENT_MEDIA_PER_ITEM_TIMEOUT_MS || 120000),
      maxBuffer: 10 * 1024 * 1024,
    });
    const printedPath = String(stdout || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .find((line) => path.isAbsolute(line) && fs.existsSync(line));
    const downloadedPath = printedPath || fs.readdirSync(workDir)
      .map((name) => path.join(workDir, name))
      .filter((filePath) => fs.existsSync(filePath) && fs.statSync(filePath).isFile())
      .sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];
    if (!downloadedPath) {
      throw new MediaReaderError('VIDEO_STREAM_NOT_FOUND', 'VIDEO_STREAM_NOT_FOUND: yt-dlp did not produce a Bilibili analysis video file', bilibiliErrorExtra({
        code: 'VIDEO_STREAM_NOT_FOUND',
        env,
      }));
    }
    const bytes = fs.readFileSync(downloadedPath);
    return {
      type: 'video',
      file_path: downloadedPath,
      mime: mimeForVideoFile(downloadedPath),
      content_sha256: sha256Bytes(bytes),
      content_length: bytes.length,
      url_host: hostFromUrl(url),
      url_redacted: redactUrl(url),
      bvid: bvid || extractBvid(url),
      source: 'bilibili_ytdlp_analysis_download',
    };
  } catch (error) {
    if (error instanceof MediaReaderError) {
      throw error;
    }
    if (error?.code === 'ENOENT') {
      throw new MediaReaderError('DEPENDENCY_MISSING', 'DEPENDENCY_MISSING: yt-dlp command is missing', bilibiliErrorExtra({
        code: 'DEPENDENCY_MISSING',
        error,
        env,
      }));
    }
    const code = mapBilibiliError(error);
    throw new MediaReaderError(code, `${code}: Bilibili analysis video download failed`, bilibiliErrorExtra({ code, error, env }));
  }
}

function bilibiliErrorExtra({ code, error, env, extra = {} }) {
  const runtime = ytdlpRuntimeContext(env);
  const httpStatus = httpStatusFromError(error);
  return {
    platform: 'bilibili',
    ...(httpStatus ? { http_status: httpStatus } : {}),
    used_proxy: runtime.used_proxy,
    has_sessdata: runtime.has_sessdata,
    recovery_suggestion: recoverySuggestionFor(code),
    ...extra,
  };
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

function providerModeFromEnv(env = process.env) {
  const value = String(env.PERSONAL_AGENT_BILIBILI_PROVIDER || '').trim().toLowerCase();
  if (['ytdlp', 'yt-dlp', 'yt_dlp'].includes(value)) return 'ytdlp';
  if (['mcp', 'bilibili-mcp', 'backend_mcp'].includes(value)) return 'mcp';
  return 'auto';
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

function vttToPlainText(vtt) {
  return String(vtt || '')
    .split(/\r?\n\r?\n/)
    .filter((cue) => /\d{2}:\d{2}:\d{2}[.,]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[.,]\d{3}/.test(cue))
    .map((cue) => {
      const lines = cue.split(/\r?\n/);
      return lines
        .slice(1)
        .map((line) => line.replace(/<[^>]+>/g, '').trim())
        .filter(Boolean)
        .join(' ');
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function srtToPlainText(srt) {
  return String(srt || '')
    .split(/\r?\n\r?\n/)
    .filter((cue) => /^\d+$/m.test(cue.split(/\r?\n/)[0]))
    .map((cue) => {
      const lines = cue.split(/\r?\n/);
      return lines
        .slice(2)
        .map((line) => line.replace(/<[^>]+>/g, '').trim())
        .filter(Boolean)
        .join(' ');
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

async function extractSubtitlesFromYtdlp({ resolvedUrl, bvid }, options = {}) {
  const env = options.env || process.env;
  const ytdlpPath = String(env.PERSONAL_AGENT_YTDLP_PATH || '').trim();
  if (!ytdlpPath) return null;
  const execFileImpl = options.execFileImpl || execFileAsync;
  const runtime = ytdlpRuntimeContext(env);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ran-bili-subs-'));
  try {
    const args = [
      '--skip-download',
      '--no-warnings',
      '--write-subs',
      '--write-auto-subs',
      '--sub-langs',
      'zh-Hans,zh-CN,zh,ai-zh',
      '--sub-format',
      'vtt/srt',
      '--paths',
      workDir,
      '-o',
      '%(id)s.%(ext)s',
    ];
    if (runtime.proxy) args.push('--proxy', runtime.proxy);
    if (runtime.sessdata) args.push('--add-header', `Cookie: SESSDATA=${runtime.sessdata}`);
    args.push(resolvedUrl);
    await execFileImpl(ytdlpPath, args, {
      timeout: Number(env.PERSONAL_AGENT_PLATFORM_RESOLVE_TIMEOUT_MS || 15000),
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch {
    return null;
  }
  const subtitleFiles = fs.readdirSync(workDir)
    .filter((name) => /\.(vtt|srt)$/i.test(name))
    .sort()
    .map((name) => path.join(workDir, name));
  const texts = [];
  for (const filePath of subtitleFiles) {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const isVtt = /\.vtt$/i.test(filePath);
      const text = isVtt ? vttToPlainText(raw) : srtToPlainText(raw);
      if (text) {
        const lang = path.basename(filePath).match(/\.([a-z]{2}(?:-[A-Za-z]+)?)\.(?:vtt|srt)$/i)?.[1] || '';
        texts.push({ text, lang, source: isVtt ? 'vtt' : 'srt' });
      }
    } catch {
      // ignore unreadable subtitle files
    }
  }
  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  if (!texts.length) return null;
  const primary = texts.find((t) => ['zh-Hans', 'zh-CN', 'zh', 'ai-zh'].includes(t.lang)) || texts[0];
  return {
    text: primary.text,
    source: `yt-dlp/${primary.source}`,
    available: texts.map((t) => ({ lang: t.lang, source: t.source })),
  };
}

async function resolveWithYtdlp({ resolvedUrl, bvid, page, maxAssets }, options = {}) {
  const env = options.env || process.env;
  const ytdlpPath = String(env.PERSONAL_AGENT_YTDLP_PATH || '').trim();
  if (!ytdlpPath) {
    throw new MediaReaderError('PLATFORM_RESOLVER_NOT_CONFIGURED', 'PLATFORM_RESOLVER_NOT_CONFIGURED: Bilibili provider or yt-dlp path is not configured', bilibiliErrorExtra({
      code: 'PLATFORM_RESOLVER_NOT_CONFIGURED',
      env,
    }));
  }
  const execFileImpl = options.execFileImpl || execFileAsync;
  const runtime = ytdlpRuntimeContext(env);
  const ytdlpArgs = [
    '--dump-json',
    '--skip-download',
    '--no-warnings',
    '--write-subs',
    '--write-auto-subs',
    '--sub-langs',
    'zh-Hans,zh-CN,zh,en',
  ];
  if (runtime.proxy) {
    ytdlpArgs.push('--proxy', runtime.proxy);
  }
  if (runtime.sessdata) {
    ytdlpArgs.push('--add-header', `Cookie: SESSDATA=${runtime.sessdata}`);
  }
  ytdlpArgs.push(resolvedUrl);
  try {
    const { stdout } = await execFileImpl(ytdlpPath, ytdlpArgs, {
      timeout: Number(env.PERSONAL_AGENT_PLATFORM_RESOLVE_TIMEOUT_MS || 15000),
      maxBuffer: 10 * 1024 * 1024,
    });
    const payload = JSON.parse(String(stdout || '{}').trim().split('\n').at(-1) || '{}');
    const thumbnail = payload.thumbnail || '';
    const media = [];
    if (thumbnail) {
      media.push({ type: 'cover', url: thumbnail, mime: 'image/jpeg' });
    }
    const hasAnyCaptions = (payload.subtitles && Object.keys(payload.subtitles).length > 0)
      || (payload.automatic_captions && Object.keys(payload.automatic_captions).length > 0);
    let subtitle = null;
    if (hasAnyCaptions) {
      subtitle = await extractSubtitlesFromYtdlp({ resolvedUrl, bvid }, options);
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
      subtitle,
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new MediaReaderError('DEPENDENCY_MISSING', 'DEPENDENCY_MISSING: yt-dlp command is missing', bilibiliErrorExtra({
        code: 'DEPENDENCY_MISSING',
        error,
        env,
      }));
    }
    const code = mapBilibiliError(error);
    throw new MediaReaderError(code, `${code}: Bilibili extraction failed`, bilibiliErrorExtra({ code, error, env }));
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
    try {
      resolvedUrl = await resolveShortlink(originalUrl, {
        platform: 'bilibili',
        options,
        errorCode: 'SHORTLINK_RESOLVE_FAILED',
      });
    } catch (error) {
      if (error instanceof MediaReaderError) {
        const code = error.error_code === 'SHORTLINK_RESOLVE_FAILED' && Number(error.extra?.http_status) === 412
          ? 'BILIBILI_SHORTLINK_BLOCKED'
          : error.error_code;
        throw new MediaReaderError(code, `${code}: Bilibili shortlink resolve failed`, bilibiliErrorExtra({
          code,
          error,
          env,
          extra: {
            ...error.extra,
            http_status: error.extra?.http_status,
          },
        }));
      }
      throw error;
    }
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
      const providerMode = providerModeFromEnv(env);
      if (providerMode === 'ytdlp') {
        providerResult = await resolveWithYtdlp({ resolvedUrl, bvid, page, maxAssets }, options);
      } else if (providerMode === 'mcp') {
        providerResult = await resolveWithMcp({ originalUrl, resolvedUrl, bvid, page, args, maxAssets }, options);
        if (!providerResult) {
          throw new MediaReaderError('PLATFORM_RESOLVER_NOT_CONFIGURED', 'PLATFORM_RESOLVER_NOT_CONFIGURED: Bilibili MCP provider is not configured', bilibiliErrorExtra({
            code: 'PLATFORM_RESOLVER_NOT_CONFIGURED',
            env,
          }));
        }
      } else {
        providerResult = await resolveWithMcp({ originalUrl, resolvedUrl, bvid, page, args, maxAssets }, options)
          || await resolveWithYtdlp({ resolvedUrl, bvid, page, maxAssets }, options);
      }
    }
  } catch (error) {
    if (error instanceof MediaReaderError) {
      throw error;
    }
    const code = mapBilibiliError(error);
    throw new MediaReaderError(code, `${code}: Bilibili extraction failed`, bilibiliErrorExtra({ code, error, env }));
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
