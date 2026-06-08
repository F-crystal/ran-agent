import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const DEFAULT_MAX_CHARS = 7000;

export async function importFromPastedText({ title, author = '', text, format = 'text' }) {
  const normalized = normalizeText(text);
  return {
    title: title || firstHeading(normalized) || 'Pasted Text',
    author,
    format: normalizeFormat(format),
    sourceKind: 'paste',
    sourceUri: '',
    chunks: chunkPlainText(normalized, { maxChars: DEFAULT_MAX_CHARS }),
    ocrRequired: false,
  };
}

export async function importFromFile({ filePath, title, author }) {
  const absolutePath = path.resolve(filePath);
  const ext = path.extname(absolutePath).toLowerCase();
  if (ext === '.txt') {
    const text = await readFile(absolutePath, 'utf8');
    return {
      title: title || firstHeading(text) || path.basename(absolutePath, ext),
      author: author || '',
      format: 'txt',
      sourceKind: 'file',
      sourceUri: absolutePath,
      chunks: chunkPlainText(normalizeText(text), { maxChars: DEFAULT_MAX_CHARS }),
      ocrRequired: false,
    };
  }
  if (ext === '.md' || ext === '.markdown') {
    const text = await readFile(absolutePath, 'utf8');
    return {
      title: title || markdownTitle(text) || path.basename(absolutePath, ext),
      author: author || '',
      format: 'markdown',
      sourceKind: 'file',
      sourceUri: absolutePath,
      chunks: chunkMarkdown(normalizeText(text), { maxChars: DEFAULT_MAX_CHARS }),
      ocrRequired: false,
    };
  }
  if (ext === '.html' || ext === '.htm') {
    const html = await readFile(absolutePath, 'utf8');
    const parsed = extractHtmlText(html);
    return {
      title: title || parsed.title || path.basename(absolutePath, ext),
      author: author || '',
      format: 'html',
      sourceKind: 'file',
      sourceUri: absolutePath,
      chunks: chunkPlainText(parsed.text, { maxChars: DEFAULT_MAX_CHARS, sectionTitle: parsed.title || 'HTML' }),
      ocrRequired: false,
    };
  }
  if (ext === '.epub') {
    const parsed = await extractEpub(absolutePath);
    const textChunks = [];
    for (const section of parsed.sections) {
      textChunks.push(...chunkPlainText(section.text, {
        maxChars: DEFAULT_MAX_CHARS,
        sectionTitle: section.title,
      }));
    }
    return {
      title: title || parsed.title || path.basename(absolutePath, ext),
      author: author || parsed.author || '',
      format: 'epub',
      sourceKind: 'file',
      sourceUri: absolutePath,
      chunks: textChunks,
      ocrRequired: false,
    };
  }
  if (ext === '.pdf') {
    const parsed = await inspectPdfTextLayer(absolutePath);
    return {
      title: title || path.basename(absolutePath, ext),
      author: author || '',
      format: 'pdf',
      sourceKind: 'file',
      sourceUri: absolutePath,
      chunks: parsed.ocrRequired ? [] : chunkPlainText(parsed.text, { maxChars: DEFAULT_MAX_CHARS, sectionTitle: 'PDF Text Layer' }),
      ocrRequired: parsed.ocrRequired,
    };
  }
  throw new Error(`unsupported co_reading import format: ${ext || 'unknown'}`);
}

export async function importFromUrlText({ url, title, author = '', text, format = 'url', sourceTitle = '' }) {
  const normalized = normalizeText(text);
  if (!normalized) {
    throw new Error('URL import returned no readable text');
  }
  const resolvedTitle = title || sourceTitle || firstHeading(normalized) || 'Imported URL';
  return {
    title: resolvedTitle,
    author,
    format,
    sourceKind: 'url',
    sourceUri: String(url || ''),
    chunks: chunkPlainText(normalized, { maxChars: DEFAULT_MAX_CHARS, sectionTitle: resolvedTitle }),
    ocrRequired: false,
  };
}

export function createWebImportProviderRegistry(providers = {}) {
  return {
    async importUrl(url, options = {}) {
      const parsed = new URL(url);
      const provider = providers[parsed.hostname] || providers.default;
      if (!provider) {
        return {
          ok: false,
          error_code: 'CO_READING_WEB_PROVIDER_NOT_CONFIGURED',
          message: 'Web import provider is reserved but not configured.',
          url,
        };
      }
      return await provider.importUrl(url, options);
    },
  };
}

function normalizeFormat(format) {
  const value = String(format || 'text').trim().toLowerCase();
  if (value === 'md') return 'markdown';
  if (['txt', 'text', 'markdown'].includes(value)) return value;
  return 'text';
}

function normalizeText(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\u0000/g, '')
    .trim();
}

function firstHeading(text) {
  return String(text || '').split('\n').map((line) => line.trim()).find(Boolean) || '';
}

function markdownTitle(text) {
  const match = String(text || '').match(/^#\s+(.+)$/m);
  return match?.[1]?.trim() || firstHeading(text);
}

function extractHtmlText(html) {
  const raw = String(html || '');
  const title = decodeHtmlEntities((raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/<[^>]+>/g, ' ').trim());
  const body = raw.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] || raw;
  const withBreaks = body
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|article|section|li|h[1-6]|blockquote|tr)>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  const text = decodeHtmlEntities(withBreaks)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  return { title, text };
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function chunkMarkdown(text, { maxChars = DEFAULT_MAX_CHARS } = {}) {
  const parts = splitByMarkdownHeading(text);
  return parts.flatMap((part) => chunkPlainText(part.text, {
    maxChars,
    sectionTitle: part.title,
  }));
}

function splitByMarkdownHeading(text) {
  const lines = String(text || '').split('\n');
  const sections = [];
  let currentTitle = 'Main';
  let current = [];
  for (const line of lines) {
    const match = line.match(/^#{1,6}\s+(.+)$/);
    if (match && current.length) {
      sections.push({ title: currentTitle, text: current.join('\n').trim() });
      current = [];
    }
    if (match) currentTitle = match[1].trim();
    current.push(line);
  }
  if (current.length) {
    sections.push({ title: currentTitle, text: current.join('\n').trim() });
  }
  return sections.filter((section) => section.text);
}

function chunkPlainText(text, { maxChars = DEFAULT_MAX_CHARS, sectionTitle = null } = {}) {
  const normalized = normalizeText(text);
  if (!normalized) return [];
  const sections = sectionTitle ? [{ title: sectionTitle, text: normalized }] : splitByLooseHeadings(normalized);
  const chunks = [];
  for (const section of sections) {
    const paragraphs = section.text.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
    let buffer = '';
    let part = 1;
    for (const paragraph of paragraphs.length ? paragraphs : [section.text]) {
      if (buffer && buffer.length + paragraph.length + 2 > maxChars) {
        chunks.push(makeChunk(section.title, buffer, part));
        part += 1;
        buffer = '';
      }
      buffer = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
    }
    if (buffer) chunks.push(makeChunk(section.title, buffer, part));
  }
  return chunks;
}

function splitByLooseHeadings(text) {
  const lines = text.split('\n');
  const headingPattern = /^(第[一二三四五六七八九十百千万零〇0-9]+[章节回篇部].*|chapter\s+\w+.*)$/i;
  const sections = [];
  let currentTitle = firstHeading(text) || 'Main';
  let current = [];
  for (const line of lines) {
    if (headingPattern.test(line.trim()) && current.length) {
      sections.push({ title: currentTitle, text: current.join('\n').trim() });
      current = [];
      currentTitle = line.trim();
    }
    current.push(line);
  }
  if (current.length) sections.push({ title: currentTitle, text: current.join('\n').trim() });
  return sections.filter((section) => section.text);
}

function makeChunk(sectionTitle, text, part) {
  const suffix = part > 1 ? ` Part ${part}` : '';
  return {
    title: `${sectionTitle || 'Main'}${suffix}`,
    sectionTitle: sectionTitle || 'Main',
    text,
  };
}

async function extractEpub(filePath) {
  const scriptPath = new URL('./epubExtractor.py', import.meta.url);
  const { stdout } = await run('python3', [scriptPath.pathname, filePath]);
  const parsed = JSON.parse(stdout);
  if (!Array.isArray(parsed.sections) || parsed.sections.length === 0) {
    throw new Error('EPUB import found no readable spine text');
  }
  return parsed;
}

async function inspectPdfTextLayer(filePath) {
  const buffer = await readFile(filePath);
  const raw = buffer.toString('latin1');
  const textMatches = [...raw.matchAll(/\(([^)]{3,})\)\s*Tj/g)].map((match) => match[1]);
  const tjArrayMatches = [...raw.matchAll(/\[([^\]]{3,})\]\s*TJ/g)].map((match) => match[1].replace(/[()[\]]/g, ' '));
  const text = normalizeText([...textMatches, ...tjArrayMatches].join('\n'));
  return {
    ocrRequired: text.length < 10,
    text,
  };
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${command} exited ${code}: ${stderr}`));
      }
    });
  });
}
