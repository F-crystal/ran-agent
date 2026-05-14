import fs from 'node:fs';
import { Readability, isProbablyReaderable } from '@mozilla/readability';
import { parseHTML } from 'linkedom';

const URL_PATTERN = /https?:\/\/[^\s]+/gi;
const MAX_TEXT_LENGTH = 6000;
const MAX_LINK_COUNT = 12;
const MAX_IMAGE_COUNT = 15;
const MIN_IMAGE_DIMENSION = 80;
const COMMON_SYSTEM_CHROMIUM_PATHS = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
];

export function extractUrlsFromText(text) {
  const matches = String(text || '').match(URL_PATTERN) || [];
  return [...new Set(matches.map((item) => item.trim()).filter(Boolean))];
}

export function extractStructuredContentFromHtml(html, pageUrl = '') {
  const { document } = parseHTML(String(html || ''));
  const article = tryReadability(document);
  const title = normalizeText(article?.title || document.title || '');
  const excerpt = normalizeText(
    article?.excerpt ||
    document.querySelector('meta[name="description"]')?.getAttribute('content') ||
    ''
  );
  let rawText = normalizeText(article?.textContent || extractFallbackText(document));
  // When the excerpt is much richer than the extracted body (e.g. JS-rendered
  // pages like WeChat MP articles), prefer the excerpt as the primary text.
  if (rawText.length < 80 && excerpt.length >= 80) {
    rawText = excerpt;
  }
  const text = clampText(rawText);
  const links = extractTopLinks(document, pageUrl);
  const images = extractImagesFromDocument(document, pageUrl);

  return {
    title,
    excerpt,
    text,
    links,
    images,
    readerable: Boolean(article),
  };
}

export async function extractStructuredContentFromPage(page) {
  const metadata = await page.evaluate(() => {
    const title = document.title || '';
    const canonical = document.querySelector('link[rel="canonical"]')?.href || location.href;
    const description = document.querySelector('meta[name="description"]')?.getAttribute('content') || '';
    const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
      .slice(0, 10)
      .map((node) => (node.textContent || '').trim())
      .filter(Boolean);
    const links = Array.from(document.querySelectorAll('a[href]'))
      .map((node) => ({
        text: (node.textContent || '').trim(),
        href: node.href || '',
      }))
      .filter((item) => item.text && item.href)
      .slice(0, 20);
    return {
      title,
      canonical,
      description,
      headings,
      links,
      html: document.documentElement.outerHTML,
    };
  });

  const article = extractStructuredContentFromHtml(metadata.html, metadata.canonical);
  return {
    url: metadata.canonical,
    title: article.title || normalizeText(metadata.title),
    excerpt: article.excerpt || normalizeText(metadata.description),
    text: article.text,
    headings: metadata.headings || [],
    links: article.links.length > 0 ? article.links : metadata.links.slice(0, MAX_LINK_COUNT),
    images: article.images,
    readerable: article.readerable,
  };
}

export async function extractStructuredContentFromUrlWithPlaywright(url, options = {}) {
  const browserFactory = typeof options.browserFactory === 'function'
    ? options.browserFactory
    : launchPlaywrightChromium;
  const browser = await browserFactory();
  let context = null;
  let page = null;
  try {
    context = await browser.newContext({
      userAgent: 'Mozilla/5.0 RanAgentBridge/1.0',
    });
    page = await context.newPage();
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: Number(options.timeoutMs) || 15000,
    });
    return await extractStructuredContentFromPage(page);
  } finally {
    try {
      await page?.close();
    } catch {}
    try {
      await context?.close();
    } catch {}
    try {
      await browser?.close();
    } catch {}
  }
}

export function resolvePlaywrightLaunchOptions(env = process.env, fsLike = fs) {
  const executablePath = String(env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '').trim();
  const channel = String(env.PLAYWRIGHT_CHROMIUM_CHANNEL || '').trim();
  const useSystemChromium = String(env.PLAYWRIGHT_USE_SYSTEM_CHROMIUM || '').trim().toLowerCase() === 'true';
  const launchOptions = {
    headless: true,
  };

  if (executablePath) {
    launchOptions.executablePath = executablePath;
    return launchOptions;
  }

  if (useSystemChromium) {
    const detected = COMMON_SYSTEM_CHROMIUM_PATHS.find((candidate) => {
      try {
        return Boolean(fsLike.existsSync(candidate));
      } catch {
        return false;
      }
    });
    if (detected) {
      launchOptions.executablePath = detected;
      return launchOptions;
    }
  }

  if (channel) {
    launchOptions.channel = channel;
  }

  return launchOptions;
}

export function shouldUsePlaywrightStructuredExtraction(env = process.env, fsLike = fs) {
  const executablePath = String(env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '').trim();
  if (executablePath) {
    return true;
  }
  const channel = String(env.PLAYWRIGHT_CHROMIUM_CHANNEL || '').trim();
  if (channel) {
    return true;
  }
  const useSystemChromium = String(env.PLAYWRIGHT_USE_SYSTEM_CHROMIUM || '').trim().toLowerCase() === 'true';
  if (useSystemChromium) {
    return COMMON_SYSTEM_CHROMIUM_PATHS.some((candidate) => {
      try {
        return Boolean(fsLike.existsSync(candidate));
      } catch {
        return false;
      }
    });
  }
  return false;
}

export function buildStructuredUrlContext(payload, extractionResults) {
  const results = Array.isArray(extractionResults) ? extractionResults.filter(Boolean) : [];
  if (results.length === 0) {
    return '';
  }

  const lines = ['以下是链接内容的结构化提取结果，请优先基于这些正文信息理解，不够时再考虑联网检索：'];
  for (const item of results) {
    lines.push(`链接：${item.url || ''}`);
    if (item.title) {
      lines.push(`标题：${item.title}`);
    }
    if (item.excerpt) {
      lines.push(`摘要：${item.excerpt}`);
    }
    if (item.text) {
      lines.push(`正文摘录：${clampText(item.text)}`);
    }
    if (item.images && item.images.length > 0) {
      lines.push(`文中图片（共 ${item.images.length} 张）：`);
      for (let i = 0; i < item.images.length; i++) {
        lines.push(`  [图${i + 1}] ${item.images[i]}`);
      }
    }
  }
  if (payload?.text) {
    lines.push(`用户问题：${String(payload.text).trim()}`);
  }
  return lines.join('\n');
}

export function collectExtractedImageUrls(extractionResults) {
  const results = Array.isArray(extractionResults) ? extractionResults.filter(Boolean) : [];
  const urls = [];
  for (const item of results) {
    if (Array.isArray(item.images)) {
      for (const url of item.images) {
        if (url && !urls.includes(url)) {
          urls.push(url);
        }
      }
    }
  }
  return urls;
}

function tryReadability(document) {
  try {
    const clone = document.cloneNode(true);
    if (isProbablyReaderable(clone)) {
      return new Readability(clone).parse();
    }
    // isProbablyReaderable may return false for content that uses <section>
    // tags (e.g. WeChat MP articles), but Readability.parse() can still
    // produce good results.  Always attempt parse() as a fallback.
    const article = new Readability(clone).parse();
    if (article && article.textContent && article.textContent.length >= 200) {
      return article;
    }
    return null;
  } catch {
    return null;
  }
}

function extractFallbackText(document) {
  const selectors = [
    // WeChat MP article containers
    '#js_content',
    '.rich_media_content',
    '.rich_media',
    // Generic article / main content selectors
    'main',
    'article',
    '[role="main"]',
    '.content',
    '.article',
    '.post',
  ];
  for (const selector of selectors) {
    const node = document.querySelector(selector);
    const text = normalizeText(node?.textContent || '');
    if (text.length >= 200) {
      return text;
    }
  }
  return normalizeText(document.body?.textContent || '');
}

function extractTopLinks(document, pageUrl) {
  const links = Array.from(document.querySelectorAll('a[href]'))
    .map((node) => ({
      text: normalizeText(node.textContent || ''),
      href: absolutizeUrl(node.getAttribute('href') || '', pageUrl),
    }))
    .filter((item) => item.text && item.href)
    .slice(0, MAX_LINK_COUNT);
  return links;
}

function extractImagesFromDocument(document, pageUrl = '') {
  const imgNodes = Array.from(document.querySelectorAll('img'));
  const images = [];
  for (const node of imgNodes) {
    if (images.length >= MAX_IMAGE_COUNT) break;

    // Prefer data-src (WeChat / lazy-load) over src
    const rawUrl = node.getAttribute('data-src') || node.getAttribute('src') || '';
    const url = rawUrl.trim();

    // Skip data URIs (inline icons / emoticons)
    if (!url || url.startsWith('data:')) continue;

    const absoluteUrl = absolutizeUrl(url, pageUrl);
    if (!absoluteUrl) continue;

    // Skip likely decorative / tiny images based on dimension hints
    const dataW = parseInt(node.getAttribute('data-w') || '', 10);
    const width = parseInt(node.getAttribute('width') || '', 10);
    const styleWidth = extractStyleDimension(node.getAttribute('style') || '', 'width');
    const inferredWidth = dataW || width || styleWidth || 0;
    if (inferredWidth > 0 && inferredWidth < MIN_IMAGE_DIMENSION) continue;

    // Skip visually hidden images
    const style = (node.getAttribute('style') || '').toLowerCase();
    if (/display\s*:\s*none/.test(style) || /visibility\s*:\s*hidden/.test(style)) continue;

    images.push(absoluteUrl);
  }
  return images;
}

function extractStyleDimension(styleAttr, property) {
  if (!styleAttr) return 0;
  const regex = new RegExp(`${property}\\s*:\\s*(\\d+)\\s*px`, 'i');
  const match = styleAttr.match(regex);
  return match ? parseInt(match[1], 10) : 0;
}

function absolutizeUrl(href, pageUrl) {
  try {
    return new URL(href, pageUrl || 'https://example.com').toString();
  } catch {
    return '';
  }
}

function normalizeText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function clampText(text) {
  const normalized = normalizeText(text);
  if (normalized.length <= MAX_TEXT_LENGTH) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_TEXT_LENGTH)}...`;
}

async function launchPlaywrightChromium() {
  const { chromium } = await import('playwright-core');
  return chromium.launch(resolvePlaywrightLaunchOptions());
}
