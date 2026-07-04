import dns from 'node:dns/promises';
import net from 'node:net';
import { MediaReaderError, redactUrl, hostFromUrl } from '../assetResolver.mjs';
import { resolveBilibiliMedia } from './bilibiliResolver.mjs';
import { resolveWechatArticle } from './wechatArticleResolver.mjs';
import { resolveXhsMedia } from './xhsResolver.mjs';

export const BROWSER_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const URL_RE = /https?:\/\/[^\s"'<>【】「」《》]+/ig;
const TRAILING_RE = /(?:复制打开.*)?[，。！？、；：）)\]}】》」'".\s]+$/u;

const PLATFORM_HOSTS = {
  bilibili: ['b23.tv', 'www.bilibili.com', 'bilibili.com', 'm.bilibili.com'],
  wechat_article: ['mp.weixin.qq.com'],
  xhs: ['xhslink.com', 'www.xiaohongshu.com', 'xiaohongshu.com', 'm.xiaohongshu.com'],
};

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_REDIRECTS = 5;

export function extractFirstUrl(text) {
  const matches = String(text || '').match(URL_RE) || [];
  if (!matches.length) {
    return '';
  }
  return matches[0].replace(TRAILING_RE, '');
}

function normalizeHost(hostname) {
  return String(hostname || '').toLowerCase();
}

export function hostMatches(hostname, allowedHosts = []) {
  const host = normalizeHost(hostname);
  return allowedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

export function detectPlatformFromUrl(url) {
  const hostname = hostFromUrl(url);
  if (hostMatches(hostname, PLATFORM_HOSTS.bilibili)) {
    return 'bilibili';
  }
  if (hostMatches(hostname, PLATFORM_HOSTS.wechat_article)) {
    return 'wechat_article';
  }
  if (hostMatches(hostname, PLATFORM_HOSTS.xhs)) {
    return 'xhs';
  }
  return 'unknown';
}

export function platformHosts(platform) {
  return PLATFORM_HOSTS[platform] || [];
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
  if (!value) return false;
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

function timeoutMsFor(env = process.env) {
  const parsed = Number(env.PERSONAL_AGENT_PLATFORM_RESOLVE_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_TIMEOUT_MS;
}

function maxRedirectsFor(options = {}) {
  const parsed = Number(options.maxRedirects);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : DEFAULT_MAX_REDIRECTS;
}

export async function assertSafePlatformUrl(url, { platform = 'auto', options = {}, errorCode = 'URL_BLOCKED' } = {}) {
  let parsed;
  try {
    parsed = new URL(String(url || '').trim());
  } catch {
    throw new MediaReaderError(errorCode, `${errorCode}: invalid platform URL`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new MediaReaderError(errorCode, `${errorCode}: platform URL scheme is not allowed`);
  }
  const detected = detectPlatformFromUrl(parsed.toString());
  const expected = platform === 'auto' ? detected : platform;
  if (!['bilibili', 'xhs', 'wechat_article'].includes(detected) || detected !== expected) {
    throw new MediaReaderError('UNSUPPORTED_PLATFORM', 'UNSUPPORTED_PLATFORM: URL host is not allowed for platform resolver', {
      platform: expected,
      url_host: parsed.hostname.toLowerCase(),
    });
  }
  const hostname = parsed.hostname.toLowerCase();
  if (net.isIP(hostname) && isPrivateIp(hostname)) {
    throw new MediaReaderError('PRIVATE_NETWORK_BLOCKED', 'PRIVATE_NETWORK_BLOCKED: platform URL points to private network', {
      url_host: hostname,
    });
  }
  const resolveHostnameImpl = options.resolveHostnameImpl || defaultResolveHostname;
  const addresses = await resolveHostnameImpl(hostname);
  if (addresses.some(isPrivateIp)) {
    throw new MediaReaderError('PRIVATE_NETWORK_BLOCKED', 'PRIVATE_NETWORK_BLOCKED: platform host resolved to private network', {
      url_host: hostname,
    });
  }
  return parsed;
}

export async function resolveShortlink(url, { platform = 'auto', options = {}, errorCode = 'SHORTLINK_RESOLVE_FAILED' } = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = timeoutMsFor(env);
  const maxRedirects = maxRedirectsFor(options);
  let current = String(url || '').trim();

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    await assertSafePlatformUrl(current, { platform, options, errorCode });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(current, {
        method: 'GET',
        redirect: 'manual',
        headers: { 'user-agent': BROWSER_USER_AGENT },
        signal: controller.signal,
      });
    } catch (error) {
      throw new MediaReaderError(errorCode, `${errorCode}: shortlink resolve failed`, {
        url_host: hostFromUrl(current),
        reason: error?.name === 'AbortError' ? 'timeout' : 'fetch_failed',
      });
    } finally {
      clearTimeout(timer);
    }

    const status = Number(response?.status || 0);
    const location = response?.headers?.get?.('location') || '';
    if (status >= 300 && status < 400 && location) {
      current = new URL(location, current).toString();
      try {
        await assertSafePlatformUrl(current, { platform, options, errorCode });
      } catch (error) {
        throw new MediaReaderError(errorCode, `${errorCode}: shortlink redirected outside platform whitelist`, {
          url_host: hostFromUrl(current),
          cause_code: error?.error_code || 'URL_BLOCKED',
        });
      }
      const host = hostFromUrl(current);
      if ((platform === 'bilibili' && host !== 'b23.tv') || (platform === 'xhs' && host !== 'xhslink.com')) {
        return current;
      }
      continue;
    }
    if (status >= 400) {
      throw new MediaReaderError(errorCode, `${errorCode}: shortlink returned HTTP ${status}`, {
        platform,
        url_host: hostFromUrl(current),
        http_status: status,
      });
    }
    if (response?.url && response.url !== current) {
      current = response.url;
      await assertSafePlatformUrl(current, { platform, options, errorCode });
    }
    return current;
  }

  throw new MediaReaderError(errorCode, `${errorCode}: too many shortlink redirects`, {
    url_host: hostFromUrl(current),
  });
}

export function sanitizePlatformResult(result = {}) {
  const media = Array.isArray(result.media) ? result.media.map((item, index) => ({
    type: item.type || 'unknown',
    url_redacted: item.url ? redactUrl(item.url) : String(item.url_redacted || ''),
    asset_id: item.asset_id || `${item.type || 'media'}-${index + 1}`,
    mime: item.mime || '',
    duration_seconds: item.duration_seconds ?? null,
    source: item.source || 'platform_resolver',
  })) : [];
  return {
    ok: result.ok !== false,
    platform: result.platform || 'unknown',
    resolver: result.resolver || '',
    source: result.source || '',
    public_only: result.public_only === true,
    account_backed: result.account_backed === true,
    evidence_level: result.evidence_level || '',
    error_code: result.error_code || '',
    content_available: result.content_available,
    full_text_available: result.full_text_available,
    should_answer_from_content: result.should_answer_from_content,
    comments_supported: result.comments_supported === true,
    original_url_redacted: redactUrl(result.original_url || result.original_url_redacted || ''),
    resolved_url_redacted: redactUrl(result.resolved_url || result.resolved_url_redacted || ''),
    metadata: result.metadata || {},
    post_text: String(result.post_text || ''),
    comments: Array.isArray(result.comments) ? result.comments : [],
    media,
    subtitle: result.subtitle || null,
    transcript_source: result.transcript_source || 'none',
    visual_source: result.visual_source || 'none',
    warnings: Array.isArray(result.warnings) ? result.warnings : [],
  };
}

export function isPlatformMediaInput(value = '') {
  const url = extractFirstUrl(value);
  return Boolean(url && detectPlatformFromUrl(url) !== 'unknown');
}

export async function resolvePlatformMedia(args = {}, options = {}) {
  const env = options.env || process.env;
  const enabled = String(env.PERSONAL_AGENT_PLATFORM_RESOLVERS_ENABLED || 'true').trim().toLowerCase() !== 'false';
  if (!enabled) {
    throw new MediaReaderError('PLATFORM_RESOLVER_NOT_CONFIGURED', 'PLATFORM_RESOLVER_NOT_CONFIGURED: platform resolvers are disabled');
  }
  const originalUrl = extractFirstUrl(args.url_or_text || args.url || '');
  if (!originalUrl) {
    throw new MediaReaderError('NO_URL_FOUND', 'NO_URL_FOUND: no URL found in share text');
  }
  const requestedPlatform = ['bilibili', 'xhs', 'wechat_article'].includes(args.platform) ? args.platform : 'auto';
  const detected = detectPlatformFromUrl(originalUrl);
  const platform = requestedPlatform === 'auto' ? detected : requestedPlatform;
  if (!['bilibili', 'xhs', 'wechat_article'].includes(platform) || (detected !== 'unknown' && requestedPlatform !== 'auto' && detected !== platform)) {
    throw new MediaReaderError('UNSUPPORTED_PLATFORM', 'UNSUPPORTED_PLATFORM: unsupported social URL host', {
      platform,
      url_host: hostFromUrl(originalUrl),
    });
  }
  await assertSafePlatformUrl(originalUrl, { platform, options });
  if (platform === 'bilibili') {
    return await resolveBilibiliMedia({ ...args, originalUrl }, options);
  }
  if (platform === 'xhs') {
    return await resolveXhsMedia({ ...args, originalUrl }, options);
  }
  if (platform === 'wechat_article') {
    return await resolveWechatArticle({ ...args, originalUrl }, options);
  }
  throw new MediaReaderError('UNSUPPORTED_PLATFORM', 'UNSUPPORTED_PLATFORM: unsupported social URL host', {
    url_host: hostFromUrl(originalUrl),
  });
}
