import { MediaReaderError, hostFromUrl } from '../assetResolver.mjs';
import { assertSafePlatformUrl, BROWSER_USER_AGENT } from './index.mjs';

const WECHAT_RECOVERY_SUGGESTION = '当前微信公众号文章触发微信验证码或动态加载限制。请在浏览器中打开文章后复制正文，或导出 PDF/截图上传；也可以配置已验证的 wechat-reader 浏览器会话后重试。';
const CAPTCHA_RE = /wappoc_appmsgcaptcha|appmsgcaptcha|captcha|验证码|环境异常/i;
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_REDIRECTS = 5;

function timeoutMsFor(env = process.env) {
  const parsed = Number(env.PERSONAL_AGENT_PLATFORM_RESOLVE_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_TIMEOUT_MS;
}

function maxRedirectsFor(options = {}) {
  const parsed = Number(options.maxRedirects);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : DEFAULT_MAX_REDIRECTS;
}

function decodeHtmlEntities(text = '') {
  return String(text)
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripHtml(html = '') {
  return decodeHtmlEntities(String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim());
}

function extractTitle(html = '') {
  const meta = String(html || '').match(/<meta[^>]+(?:property|name)=["'](?:og:title|twitter:title|title)["'][^>]+content=["']([^"']+)["']/i)
    || String(html || '').match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:title|twitter:title|title)["']/i);
  if (meta?.[1]) {
    return decodeHtmlEntities(meta[1]).trim();
  }
  const title = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return title?.[1] ? stripHtml(title[1]) : '';
}

function extractArticleText(html = '') {
  const contentMatch = String(html || '').match(/<[^>]+id=["']js_content["'][^>]*>([\s\S]*?)<\/[^>]+>/i)
    || String(html || '').match(/<[^>]+class=["'][^"']*rich_media_content[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i);
  const scopedText = contentMatch?.[1] ? stripHtml(contentMatch[1]) : '';
  if (scopedText.length >= 80) {
    return scopedText;
  }
  const fullText = stripHtml(html);
  return fullText.length >= 200 ? fullText : '';
}

function wechatError(code, message, extra = {}) {
  return new MediaReaderError(code, `${code}: ${message}`, {
    platform: 'wechat_article',
    captcha_detected: code === 'WECHAT_CAPTCHA_REQUIRED',
    recovery_suggestion: WECHAT_RECOVERY_SUGGESTION,
    ...extra,
  });
}

async function fetchWechatArticle(url, options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = timeoutMsFor(env);
  const maxRedirects = maxRedirectsFor(options);
  let current = String(url || '').trim();

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    await assertSafePlatformUrl(current, { platform: 'wechat_article', options });
    if (CAPTCHA_RE.test(current)) {
      throw wechatError('WECHAT_CAPTCHA_REQUIRED', 'WeChat captcha page detected', {
        url_host: hostFromUrl(current),
      });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(current, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          'user-agent': BROWSER_USER_AGENT,
          accept: 'text/html,application/xhtml+xml',
        },
        signal: controller.signal,
      });
    } catch (error) {
      throw wechatError('WECHAT_ARTICLE_EXTRACT_FAILED', 'WeChat article fetch failed', {
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
      await assertSafePlatformUrl(current, { platform: 'wechat_article', options });
      continue;
    }
    const finalUrl = response?.url || current;
    await assertSafePlatformUrl(finalUrl, { platform: 'wechat_article', options });
    const html = await response.text();
    return { finalUrl, status, html };
  }

  throw wechatError('WECHAT_ARTICLE_EXTRACT_FAILED', 'too many WeChat article redirects', {
    url_host: hostFromUrl(current),
  });
}

export async function resolveWechatArticle(args = {}, options = {}) {
  const originalUrl = args.originalUrl || args.url_or_text || args.url || '';
  await assertSafePlatformUrl(originalUrl, { platform: 'wechat_article', options });

  const { finalUrl, status, html } = await fetchWechatArticle(originalUrl, options);
  const captchaDetected = CAPTCHA_RE.test(`${finalUrl}\n${html}`);
  if (captchaDetected) {
    throw wechatError('WECHAT_CAPTCHA_REQUIRED', 'WeChat captcha or abnormal environment page detected', {
      http_status: status || undefined,
      url_host: hostFromUrl(finalUrl),
    });
  }
  if (status === 401 || status === 403) {
    throw wechatError('WECHAT_LOGIN_REQUIRED', 'WeChat article requires login or verified browser session', {
      http_status: status,
      url_host: hostFromUrl(finalUrl),
    });
  }
  if (status >= 400) {
    throw wechatError('WECHAT_ARTICLE_EXTRACT_FAILED', `WeChat article returned HTTP ${status}`, {
      http_status: status,
      url_host: hostFromUrl(finalUrl),
    });
  }

  const title = extractTitle(html);
  const articleText = extractArticleText(html);
  if (!articleText) {
    throw wechatError('WECHAT_DYNAMIC_CONTENT_UNAVAILABLE', 'WeChat article body is not available from static HTML', {
      http_status: status || undefined,
      url_host: hostFromUrl(finalUrl),
      captcha_detected: false,
      title,
    });
  }

  return {
    ok: true,
    platform: 'wechat_article',
    resolver: 'wechatArticleResolver',
    original_url: originalUrl,
    resolved_url: finalUrl,
    metadata: {
      title,
      source_url_host: hostFromUrl(finalUrl),
    },
    post_text: articleText,
    comments: [],
    media: [],
    transcript_source: 'article_text',
    visual_source: 'none',
    warnings: [],
  };
}
