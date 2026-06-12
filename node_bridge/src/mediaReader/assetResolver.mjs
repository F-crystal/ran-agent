import dns from 'node:dns/promises';
import net from 'node:net';
import path from 'node:path';
import { createCacheStore, sha256Bytes, sha256Hex } from './cacheStore.mjs';

const DEFAULT_ALLOWED_HOSTS = [
  'xiaohongshu.com',
  'xhscdn.com',
  'xhslink.com',
  'rednote.com',
  'douyin.com',
  'iesdouyin.com',
  'bilibili.com',
  'b23.tv',
  'weibo.com',
  'weibo.cn',
  'kuaishou.com',
  'gifshow.com',
  'music.163.com',
  'y.music.163.com',
  '163cn.tv',
];

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const MEDIA_URL_RE = /https?:\/\/[^\s"'<>【】「」《》，。！？、；：]+/ig;

export class MediaReaderError extends Error {
  constructor(errorCode, message, extra = {}) {
    super(message || errorCode);
    this.name = 'MediaReaderError';
    this.error_code = errorCode;
    this.extra = extra;
  }
}

export function buildErrorPayload(error, extra = {}) {
  if (error instanceof MediaReaderError) {
    return {
      ok: false,
      error_code: error.error_code,
      error: error.message,
      ...error.extra,
      ...extra,
    };
  }
  return {
    ok: false,
    error_code: 'DOWNLOAD_FAILED',
    error: error instanceof Error ? error.message : String(error),
    ...extra,
  };
}

function parseAllowedHosts(env = process.env) {
  const configured = String(env.PERSONAL_AGENT_MEDIA_ALLOWED_HOSTS || '').trim();
  const values = configured
    ? configured.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean)
    : DEFAULT_ALLOWED_HOSTS;
  return values;
}

function hostMatches(hostname, allowedHosts) {
  const host = String(hostname || '').toLowerCase();
  return allowedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

function normalizeUrlForKey(url) {
  const parsed = new URL(String(url || '').trim());
  const sensitiveParamPattern = /(token|key|sign|signature|auth|cookie|session|xsec|id_token|access)/i;
  for (const key of [...parsed.searchParams.keys()]) {
    if (sensitiveParamPattern.test(key)) {
      parsed.searchParams.set(key, '[redacted]');
    }
  }
  parsed.hash = '';
  return parsed.toString();
}

export function redactUrl(url) {
  try {
    const parsed = new URL(String(url || '').trim());
    parsed.search = parsed.search ? '?[redacted]' : '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '';
  }
}

export function hostFromUrl(url) {
  try {
    return new URL(String(url || '').trim()).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function normalizePositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function maxBytesForKind(kind, env = process.env) {
  const fallback = normalizePositiveNumber(env.PERSONAL_AGENT_MEDIA_MAX_BYTES, DEFAULT_MAX_BYTES);
  if (kind === 'image') {
    return normalizePositiveNumber(env.PERSONAL_AGENT_IMAGE_MAX_BYTES, fallback);
  }
  if (kind === 'audio') {
    return normalizePositiveNumber(env.PERSONAL_AGENT_AUDIO_MAX_BYTES, fallback);
  }
  if (kind === 'video') {
    return normalizePositiveNumber(env.PERSONAL_AGENT_VIDEO_MAX_BYTES, fallback);
  }
  return fallback;
}

function isPrivateIpv4(ip) {
  const parts = String(ip || '').split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
    return false;
  }
  const [a, b] = parts;
  return a === 10
    || a === 127
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 169 && b === 254)
    || a === 0;
}

function isPrivateIp(ip) {
  const value = String(ip || '').toLowerCase();
  if (!value) {
    return false;
  }
  return isPrivateIpv4(value)
    || value === '::1'
    || value.startsWith('fc')
    || value.startsWith('fd')
    || value.startsWith('fe80:')
    || value === '169.254.169.254';
}

async function defaultResolveHostname(hostname) {
  const records = await dns.lookup(hostname, { all: true });
  return records.map((record) => record.address);
}

export async function assertSafeMediaUrl(url, options = {}) {
  let parsed;
  try {
    parsed = new URL(String(url || '').trim());
  } catch {
    throw new MediaReaderError('URL_BLOCKED', 'URL_BLOCKED: invalid media URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new MediaReaderError('URL_BLOCKED', 'URL_BLOCKED: media URL scheme is not allowed');
  }
  const hostname = parsed.hostname.toLowerCase();
  if (net.isIP(hostname) && isPrivateIp(hostname)) {
    throw new MediaReaderError('PRIVATE_NETWORK_BLOCKED', 'PRIVATE_NETWORK_BLOCKED: media URL points to private network', {
      url_host: hostname,
    });
  }
  if (!hostMatches(hostname, parseAllowedHosts(options.env))) {
    throw new MediaReaderError('URL_BLOCKED', 'URL_BLOCKED: media host is not allowed', { url_host: hostname });
  }
  const resolveHostnameImpl = options.resolveHostnameImpl || defaultResolveHostname;
  const addresses = await resolveHostnameImpl(hostname);
  if (addresses.some(isPrivateIp)) {
    throw new MediaReaderError('PRIVATE_NETWORK_BLOCKED', 'PRIVATE_NETWORK_BLOCKED: media host resolved to private network', {
      url_host: hostname,
    });
  }
  return parsed;
}

export function detectKindFromUrlOrMime(url = '', mime = '') {
  const lowerMime = String(mime || '').toLowerCase();
  if (lowerMime.startsWith('image/')) {
    return 'image';
  }
  if (lowerMime.startsWith('audio/')) {
    return 'audio';
  }
  if (lowerMime.startsWith('video/')) {
    return 'video';
  }
  const extension = path.extname(new URL(String(url || 'https://example.com/file')).pathname).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(extension)) {
    return 'image';
  }
  if (['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg'].includes(extension)) {
    return 'audio';
  }
  if (['.mp4', '.mov', '.webm', '.mkv'].includes(extension)) {
    return 'video';
  }
  return 'unknown';
}

function extensionForMime(mime = '') {
  const normalized = String(mime || '').toLowerCase().split(';')[0].trim();
  if (normalized === 'image/png') return 'png';
  if (normalized === 'image/jpeg') return 'jpg';
  if (normalized === 'image/gif') return 'gif';
  if (normalized === 'image/webp') return 'webp';
  if (normalized === 'audio/mpeg') return 'mp3';
  if (normalized === 'audio/wav' || normalized === 'audio/x-wav') return 'wav';
  if (normalized === 'video/mp4') return 'mp4';
  if (normalized === 'video/webm') return 'webm';
  return 'bin';
}

function matchesMagic(bytes, mime = '') {
  const normalized = String(mime || '').toLowerCase().split(';')[0].trim();
  if (!normalized) {
    return true;
  }
  if (normalized === 'image/png') {
    return bytes.length >= 8
      && bytes[0] === 0x89
      && bytes[1] === 0x50
      && bytes[2] === 0x4e
      && bytes[3] === 0x47;
  }
  if (normalized === 'image/jpeg') {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (normalized === 'image/gif') {
    return bytes.slice(0, 3).toString('ascii') === 'GIF';
  }
  if (normalized === 'image/webp') {
    return bytes.slice(0, 4).toString('ascii') === 'RIFF' && bytes.slice(8, 12).toString('ascii') === 'WEBP';
  }
  if (normalized === 'video/mp4') {
    return bytes.includes(Buffer.from('ftyp'));
  }
  return true;
}

function classifyDownloadStatus(status) {
  if (status === 401) return 'MEDIA_AUTH_REQUIRED';
  if (status === 403) return 'MEDIA_DOWNLOAD_FORBIDDEN';
  if (status === 404 || status === 410) return 'EXPIRED_MEDIA_URL';
  return 'DOWNLOAD_FAILED';
}

export function extractUrlsFromText(text) {
  const matches = String(text || '').match(MEDIA_URL_RE) || [];
  return [...new Set(matches.map((item) => item.replace(/[，。！？、；：）)\]}】》」'".]+$/u, '')))];
}

export function buildMediaAssets({ urlOrText = '', mediaUrls = [], platform = '', maxAssets = 20 } = {}) {
  const urls = [...mediaUrls, ...extractUrlsFromText(urlOrText)].filter(Boolean);
  return [...new Set(urls)].slice(0, maxAssets).map((url, index) => {
    const type = detectKindFromUrlOrMime(url);
    const host = hostFromUrl(url);
    return {
      asset_id: `${type === 'unknown' ? 'media' : type}-${index + 1}`,
      type,
      url,
      url_host: host,
      url_redacted: redactUrl(url),
      source: platform ? `social_reader:${platform}` : 'explicit_url',
    };
  });
}

export async function downloadMediaAsset({ url, expectedKind = '' }, options = {}) {
  const env = options.env || process.env;
  const cache = options.cacheStore || createCacheStore(env);
  const parsed = await assertSafeMediaUrl(url, options);
  const normalizedUrl = normalizeUrlForKey(parsed.toString());
  const temporaryUrlKey = cache.buildTemporaryUrlKey(normalizedUrl);
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = normalizePositiveNumber(env.PERSONAL_AGENT_MEDIA_DOWNLOAD_TIMEOUT_MS, 30000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(parsed.toString(), {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': 'ran-agent-media-reader/0.1',
        accept: '*/*',
      },
    });
  } catch (error) {
    if (error?.name === 'AbortError' || /aborted|timeout/i.test(String(error?.message || error))) {
      throw new MediaReaderError('DOWNLOAD_TIMEOUT', 'DOWNLOAD_TIMEOUT: media download timed out', {
        url_host: parsed.hostname,
      });
    }
    throw new MediaReaderError('DOWNLOAD_FAILED', `DOWNLOAD_FAILED: ${error instanceof Error ? error.message : String(error)}`, {
      url_host: parsed.hostname,
    });
  } finally {
    clearTimeout(timer);
  }

  const finalUrl = response?.url || parsed.toString();
  if (finalUrl !== parsed.toString()) {
    await assertSafeMediaUrl(finalUrl, options);
  }
  const status = Number(response?.status || 0);
  if (response?.ok === false) {
    const errorCode = classifyDownloadStatus(status);
    throw new MediaReaderError(errorCode, `${errorCode}: media download returned status ${status}`, {
      url_host: hostFromUrl(finalUrl),
    });
  }
  const mime = String(response?.headers?.get?.('content-type') || '').split(';')[0].trim().toLowerCase();
  const kind = detectKindFromUrlOrMime(finalUrl, mime);
  const contentLength = Number(response?.headers?.get?.('content-length') || 0);
  const maxBytes = maxBytesForKind(expectedKind || kind, env);
  if (contentLength > maxBytes) {
    throw new MediaReaderError('MAX_BYTES_EXCEEDED', 'MAX_BYTES_EXCEEDED: media content length exceeds configured limit', {
      url_host: hostFromUrl(finalUrl),
      media_type: kind,
    });
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maxBytes) {
    throw new MediaReaderError('MAX_BYTES_EXCEEDED', 'MAX_BYTES_EXCEEDED: media bytes exceed configured limit', {
      url_host: hostFromUrl(finalUrl),
      media_type: kind,
    });
  }
  if (!matchesMagic(bytes, mime)) {
    throw new MediaReaderError('MIME_MISMATCH', 'MIME_MISMATCH: media bytes do not match declared MIME type', {
      url_host: hostFromUrl(finalUrl),
      media_type: kind,
    });
  }
  const contentSha256 = sha256Bytes(bytes);
  const filePath = cache.writeRawContent(contentSha256, extensionForMime(mime), bytes);
  const meta = {
    temporary_url_key: temporaryUrlKey,
    content_sha256: contentSha256,
    file_path: filePath,
    mime,
    type: kind,
    content_length: bytes.length,
    url_host: hostFromUrl(finalUrl),
    url_redacted: redactUrl(finalUrl),
    cache_key: sha256Hex(normalizedUrl),
  };
  cache.writeRawMeta(temporaryUrlKey, meta);
  return meta;
}
