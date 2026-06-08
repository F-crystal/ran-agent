#!/usr/bin/env node
import http from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { importFromFile, importFromPastedText, importFromUrlText } from './importers.mjs';
import {
  ANNOTATION_VISIBILITY,
  BOOK_STATES,
  DEFAULT_TRASH_RETENTION_DAYS,
  createCoReadingStore,
  hashText,
  readChunkText,
} from './store.mjs';
import { routeSearchHubRead } from '../searchHub/router.mjs';
import { handleSocialReaderMcpRequest } from '../socialReaderMcpServer.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PUBLIC_ROOT = path.join(PROJECT_ROOT, 'node_bridge/public/co-reading');
const DEFAULT_HERMES_BASE_URL = 'http://127.0.0.1:8643/v1';
const DEFAULT_TRANSLATION_PROVIDER = 'hermes';
const DEFAULT_TRANSLATION_TARGET_LANG = 'zh-CN';
const SOCIAL_URL_PATTERN = /https?:\/\/\S*(xhslink\.com|xiaohongshu\.com|xhs\.com|bilibili\.com|b23\.tv|mp\.weixin\.qq\.com|douyin\.com|kuaishou\.com|weibo\.com|zhihu\.com|music\.163\.com)/i;

export function getCoReadingWebConfig(env = process.env) {
  return {
    enabled: String(env.CO_READING_WEB_ENABLED || 'false').trim().toLowerCase() === 'true',
    host: String(env.CO_READING_WEB_HOST || '127.0.0.1').trim() || '127.0.0.1',
    port: Math.max(1, Number.parseInt(String(env.CO_READING_WEB_PORT || '8787'), 10) || 8787),
    accessToken: String(env.CO_READING_WEB_ACCESS_TOKEN || '').trim(),
    ownerToken: String(env.CO_READING_OWNER_TOKEN || '').trim(),
    rootDir: String(env.CO_READING_ROOT_DIR || path.join(PROJECT_ROOT, '.ran_agent_state/co_reading')).trim(),
    hermesBaseUrl: String(env.CO_READING_HERMES_API_BASE_URL || env.HERMES_FULL_API_BASE_URL || DEFAULT_HERMES_BASE_URL).trim().replace(/\/$/, ''),
    hermesApiKey: String(env.CO_READING_HERMES_API_KEY || env.HERMES_API_KEY || env.API_SERVER_KEY || '').trim(),
    translationEnabled: String(env.CO_READING_TRANSLATION_ENABLED || 'true').trim().toLowerCase() !== 'false',
    translationProvider: String(env.CO_READING_TRANSLATION_PROVIDER || DEFAULT_TRANSLATION_PROVIDER).trim().toLowerCase() || DEFAULT_TRANSLATION_PROVIDER,
    translationTargetLang: String(env.CO_READING_TRANSLATION_TARGET_LANG || DEFAULT_TRANSLATION_TARGET_LANG).trim() || DEFAULT_TRANSLATION_TARGET_LANG,
  };
}

export function createCoReadingWebApp(options = {}) {
  const env = options.env || process.env;
  const config = { ...getCoReadingWebConfig(env), ...(options.config || {}) };
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const searchHubReadImpl = options.searchHubReadImpl || ((args) => routeSearchHubRead(args, { env, fetchImpl }));
  const socialReaderRequestImpl = options.socialReaderRequestImpl || ((request) => handleSocialReaderMcpRequest(request, { env, fetchImpl }));
  let storePromise = null;

  async function getStore() {
    if (options.store) return options.store;
    if (!storePromise) {
      const store = createCoReadingStore({ rootDir: config.rootDir });
      storePromise = store.initialize().then(() => store);
    }
    return await storePromise;
  }

  async function handleRequest(req) {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/reader')) {
      return await staticResponse('index.html', 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname.startsWith('/reader/')) {
      const rel = url.pathname.replace(/^\/reader\//, '') || 'index.html';
      return await staticResponse(rel, contentType(rel));
    }
    if (!url.pathname.startsWith('/api/co-reading')) {
      return jsonResponse(404, { ok: false, error: 'not found' });
    }
    if (!isWebAuthorized(req, config)) {
      return jsonResponse(401, { ok: false, error: 'Unauthorized' });
    }
    if (!config.accessToken) {
      return jsonResponse(503, { ok: false, error: 'CO_READING_WEB_ACCESS_TOKEN is required' });
    }
    const store = await getStore();
    try {
      return await routeApi({ req, url, store, config, fetchImpl, searchHubReadImpl, socialReaderRequestImpl });
    } catch (error) {
      return jsonResponse(500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { handleRequest, config };
}

export function startCoReadingWebServer(options = {}) {
  const env = options.env || process.env;
  const config = { ...getCoReadingWebConfig(env), ...(options.config || {}) };
  const logger = options.logger || console;
  if (!config.enabled) {
    logger.info?.('[co-reading-web] disabled');
    return null;
  }
  const app = createCoReadingWebApp({ ...options, config });
  const server = http.createServer(async (req, res) => {
    const response = await app.handleRequest(req);
    const headers = response.headers || {};
    if (response.body !== undefined) {
      res.writeHead(response.status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
      res.end(JSON.stringify(response.body));
    } else {
      res.writeHead(response.status, headers);
      res.end(response.text || '');
    }
  });
  server.listen(config.port, config.host, () => {
    logger.log?.(`[co-reading-web] listening host=${config.host} port=${config.port}`);
  });
  return server;
}

async function routeApi({ req, url, store, config, fetchImpl, searchHubReadImpl, socialReaderRequestImpl }) {
  const pathParts = url.pathname.split('/').filter(Boolean).slice(2);
  if (req.method === 'GET' && pathParts.length === 1 && pathParts[0] === 'books') {
    return jsonResponse(200, { ok: true, books: store.listBooks({ includeTrash: url.searchParams.get('include_trash') === 'true' }) });
  }
  if (req.method === 'POST' && pathParts.join('/') === 'import-paste') {
    const body = await readJsonBody(req);
    const parsed = await importFromPastedText({
      title: body.title,
      author: body.author || '',
      text: body.text,
      format: body.format || 'text',
    });
    const imported = await store.importBook(parsed);
    return jsonResponse(200, { ok: true, ...imported });
  }
  if (req.method === 'POST' && pathParts.join('/') === 'import-file') {
    const body = await readJsonBody(req);
    const parsed = await importUploadedFile({
      filename: body.filename,
      dataBase64: body.data_base64 || body.dataBase64,
      title: body.title,
      author: body.author || '',
    });
    parsed.sourceKind = 'upload';
    parsed.sourceUri = safeUploadSourceUri(body.filename);
    parsed.originalRetained = false;
    const imported = await store.importBook(parsed);
    return jsonResponse(200, { ok: true, ...imported, import_summary: importSummary(parsed, imported) });
  }
  if (req.method === 'POST' && pathParts.join('/') === 'import-url') {
    const body = await readJsonBody(req);
    const parsed = await importUrlThroughExistingReaders({
      url: body.url,
      title: body.title,
      author: body.author || '',
      searchHubReadImpl,
      socialReaderRequestImpl,
    });
    const imported = await store.importBook(parsed);
    return jsonResponse(200, { ok: true, ...imported, import_summary: importSummary(parsed, imported) });
  }
  if (pathParts[0] === 'books' && pathParts[1]) {
    const bookId = decodeURIComponent(pathParts[1]);
    if (req.method === 'GET' && pathParts.length === 2) {
      return jsonResponse(200, { ok: true, book: store.getBook(bookId), storage: store.getStorageStats(bookId) });
    }
    if (req.method === 'POST' && pathParts[2] === 'archive' && pathParts.length === 3) {
      return jsonResponse(200, { ok: true, book: await store.setBookState({ bookId, state: BOOK_STATES.ARCHIVED, actor: 'web' }) });
    }
    if (req.method === 'POST' && pathParts[2] === 'restore' && pathParts.length === 3) {
      return jsonResponse(200, { ok: true, book: await store.setBookState({ bookId, state: BOOK_STATES.ACTIVE, actor: 'web' }) });
    }
    if (req.method === 'POST' && pathParts[2] === 'trash' && pathParts.length === 3) {
      const body = await readJsonBody(req);
      if (body.confirm !== true) {
        return jsonResponse(400, { ok: false, error: 'trash requires confirm=true' });
      }
      const trashRetentionDays = body.trash_retention_days ?? DEFAULT_TRASH_RETENTION_DAYS;
      const book = await store.setBookState({ bookId, state: BOOK_STATES.TRASH, actor: 'web', trashRetentionDays });
      return jsonResponse(200, { ok: true, book, trash_expires_at: book.trash_expires_at });
    }
    if (req.method === 'GET' && pathParts[2] === 'chunks' && pathParts.length === 3) {
      return jsonResponse(200, { ok: true, chunks: store.listChunks(bookId) });
    }
    if (req.method === 'GET' && pathParts[2] === 'chunks' && pathParts[3]) {
      if (pathParts[4] === 'translation') {
        return await translateChunkForWeb({
          store,
          bookId,
          chunkId: decodeURIComponent(pathParts[3]),
          targetLang: url.searchParams.get('target') || config.translationTargetLang,
          force: url.searchParams.get('force') === 'true',
          config,
          fetchImpl,
        });
      }
      return await readChunkForWeb(store, bookId, decodeURIComponent(pathParts[3]));
    }
    if (pathParts[2] === 'progress') {
      if (req.method === 'GET') {
        return jsonResponse(200, { ok: true, progress: store.getProgress(bookId, url.searchParams.get('user_id') || 'user:ran', url.searchParams.get('device_id') || 'default') });
      }
      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        const progress = store.markProgress({
          bookId,
          chunkId: body.chunk_id,
          offset: body.offset || 0,
          userId: body.user_id || 'user:ran',
          deviceId: body.device_id || 'default',
          actor: 'web',
        });
        return jsonResponse(200, { ok: true, progress });
      }
    }
    if (req.method === 'GET' && pathParts[2] === 'search') {
      const query = url.searchParams.get('q') || url.searchParams.get('query') || '';
      const chunks = store.search({ bookId, query, limit: Number(url.searchParams.get('limit') || 10) });
      const results = [];
      for (const chunk of chunks) {
        results.push({ book_id: chunk.book_id, chunk_id: chunk.id, title: chunk.title, text: await readChunkText({ rootDir: store.rootDir }, chunk) });
      }
      return jsonResponse(200, { ok: true, results });
    }
    if (req.method === 'POST' && pathParts[2] === 'annotations') {
      const body = await readJsonBody(req);
      const annotation = store.addAnnotation({
        bookId,
        chunkId: body.chunk_id,
        quote: body.quote || '',
        quoteOffset: body.quote_offset ?? null,
        anchorKind: body.anchor_kind || 'original',
        anchorLang: body.anchor_lang || 'source',
        note: body.note || '',
        visibility: body.visibility === ANNOTATION_VISIBILITY.SHARED ? ANNOTATION_VISIBILITY.SHARED : ANNOTATION_VISIBILITY.PRIVATE,
        actor: 'web',
      });
      return jsonResponse(200, { ok: true, annotation });
    }
  }
  if (pathParts[0] === 'trash' && pathParts[1] === 'cleanup' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const pruned = await store.cleanupTrash({
      actor: 'web',
      now: body.now_iso ? new Date(body.now_iso) : new Date(),
    });
    return jsonResponse(200, { ok: true, pruned });
  }
  if (pathParts[0] === 'annotations' && pathParts[1] && pathParts[2] === 'ask-hermes' && req.method === 'POST') {
    const annotationId = decodeURIComponent(pathParts[1]);
    const body = await readJsonBody(req);
    return await askHermesForAnnotation({ store, annotationId, question: body.question || '', config, fetchImpl });
  }
  return jsonResponse(404, { ok: false, error: 'not found' });
}

function importSummary(parsed = {}, imported = {}) {
  const chunkCount = Array.isArray(imported.chunks) ? imported.chunks.length : Array.isArray(parsed.chunks) ? parsed.chunks.length : 0;
  return {
    format: parsed.format || imported.book?.format || '',
    ocr_required: parsed.ocrRequired === true || imported.book?.ocr_required === true,
    chunk_count: chunkCount,
  };
}

async function importUploadedFile({ filename, dataBase64, title, author }) {
  const safeName = safeUploadFilename(filename);
  const data = String(dataBase64 || '').trim();
  if (!safeName) throw new Error('filename is required');
  if (!data) throw new Error('data_base64 is required');
  const buffer = Buffer.from(data, 'base64');
  if (buffer.length === 0) throw new Error('uploaded file is empty');
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'co-reading-upload-'));
  const filePath = path.join(tempDir, safeName);
  try {
    await writeFile(filePath, buffer);
    return await importFromFile({ filePath, title, author });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function importUrlThroughExistingReaders({ url, title, author, searchHubReadImpl, socialReaderRequestImpl }) {
  const rawUrl = String(url || '').trim();
  if (!rawUrl) throw new Error('url is required');
  if (SOCIAL_URL_PATTERN.test(rawUrl)) {
    const result = await socialReaderRequestImpl({
      method: 'tools/call',
      params: {
        name: 'read_social_post',
        arguments: {
          url: rawUrl,
          include_comments: false,
          max_comments: 0,
        },
      },
    });
    const payload = result?.structuredContent || {};
    if (result?.isError || payload.ok === false) {
      throw new Error(payload.error || payload.error_code || 'social_reader URL import failed');
    }
    const text = extractSocialReaderText(payload);
    return await importFromUrlText({
      url: payload.url || rawUrl,
      title,
      author: author || payload.platform || 'social_reader',
      sourceTitle: payload.title || payload.name || payload.platform || 'Social URL',
      text,
      format: 'social',
    });
  }

  const result = await searchHubReadImpl({ url: rawUrl, depth: 'full' });
  const item = result?.item || {};
  const content = result?.content || item.content || item.snippet || '';
  return await importFromUrlText({
    url: item.url || rawUrl,
    title,
    author: author || item.source || item.provider || 'search_hub',
    sourceTitle: item.title || 'Imported URL',
    text: content,
    format: 'url',
  });
}

function extractSocialReaderText(payload = {}) {
  return [
    payload.post_text,
    payload.note_text,
    payload.desc,
    payload.description,
    payload.content,
    payload.text,
    payload.deep_summary,
    payload.comments_text,
  ].map((part) => String(part || '').trim()).filter(Boolean).join('\n\n');
}

function safeUploadFilename(filename) {
  return path.basename(String(filename || '').trim()).replace(/[^\p{Letter}\p{Number}._ -]+/gu, '_').slice(0, 160);
}

function safeUploadSourceUri(filename) {
  const safeName = safeUploadFilename(filename);
  return safeName ? `upload://${safeName}` : 'upload://unknown';
}

async function readChunkForWeb(store, bookId, chunkId) {
  const chunk = store.getChunk(bookId, chunkId);
  if (!chunk) return jsonResponse(404, { ok: false, error: 'chunk not found' });
  const annotations = store.listAnnotations({ bookId, chunkId, includePrivate: true }).map((annotation) => ({
    ...annotation,
    replies: store.readThread(annotation.id, { includePrivate: true })?.replies || [],
  }));
  return jsonResponse(200, {
    ok: true,
    chunk,
    text: await readChunkText({ rootDir: store.rootDir }, chunk),
    annotations,
  });
}

async function translateChunkForWeb({ store, bookId, chunkId, targetLang, force = false, config, fetchImpl }) {
  if (!config.translationEnabled) {
    return jsonResponse(503, { ok: false, error: 'co_reading translation is disabled' });
  }
  const chunk = store.getChunk(bookId, chunkId);
  if (!chunk) return jsonResponse(404, { ok: false, error: 'chunk not found' });
  const text = await readChunkText({ rootDir: store.rootDir }, chunk);
  const sourceHash = hashText(text);
  const provider = normalizeTranslationProvider(config.translationProvider);
  const lang = normalizeTargetLang(targetLang || config.translationTargetLang);
  if (!force) {
    const cached = await store.readTranslation({ chunkId, targetLang: lang, provider, sourceHash });
    if (cached) {
      return jsonResponse(200, { ok: true, cached: true, translation: translationPayload(cached) });
    }
  }
  const translated = await translateText({ text, targetLang: lang, provider, config, fetchImpl });
  const saved = await store.saveTranslation({
    bookId,
    chunkId,
    targetLang: lang,
    provider,
    sourceHash,
    text: translated,
    actor: 'web',
  });
  return jsonResponse(200, { ok: true, cached: false, translation: translationPayload(saved) });
}

function normalizeTranslationProvider(provider) {
  const value = String(provider || DEFAULT_TRANSLATION_PROVIDER).trim().toLowerCase();
  return value || DEFAULT_TRANSLATION_PROVIDER;
}

function normalizeTargetLang(lang) {
  const value = String(lang || DEFAULT_TRANSLATION_TARGET_LANG).trim();
  return value || DEFAULT_TRANSLATION_TARGET_LANG;
}

function translationPayload(row = {}) {
  return {
    id: row.id,
    book_id: row.book_id,
    chunk_id: row.chunk_id,
    target_lang: row.target_lang,
    provider: row.provider,
    source_hash: row.source_hash,
    char_count: row.char_count,
    created_at: row.created_at,
    updated_at: row.updated_at,
    text: row.text || '',
  };
}

async function translateText({ text, targetLang, provider, config, fetchImpl }) {
  if (provider !== 'hermes') {
    throw new Error(`translation provider not implemented: ${provider}`);
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch unavailable for translation request');
  }
  const messages = [
    {
      role: 'system',
      content: [
        'You are a literary translation engine inside a private co_reading reader.',
        `Translate the user source text into ${targetLang === 'zh-CN' ? 'natural Simplified Chinese' : targetLang}.`,
        'Preserve paragraph breaks, names, titles, numbers, and Markdown-like structure when present.',
        'Return only the translated text. Do not add explanations, summaries, headings, or notes.',
        'If the source text is already Chinese, return it unchanged.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: String(text || ''),
    },
  ];
  const response = await fetchImpl(`${config.hermesBaseUrl || DEFAULT_HERMES_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config.hermesApiKey ? { Authorization: `Bearer ${config.hermesApiKey}` } : {}),
    },
    body: JSON.stringify({
      model: 'ran-assistant',
      messages,
      temperature: 0.1,
    }),
  });
  if (!response.ok) {
    throw new Error(`translation request failed: HTTP ${response.status || 'unknown'}`);
  }
  const payload = await response.json();
  return extractHermesText(payload);
}

async function askHermesForAnnotation({ store, annotationId, question, config, fetchImpl }) {
  if (typeof fetchImpl !== 'function') {
    return jsonResponse(503, { ok: false, error: 'fetch unavailable for Hermes request' });
  }
  const annotation = store.getAnnotation(annotationId, { includePrivate: true });
  if (!annotation) return jsonResponse(404, { ok: false, error: 'annotation not found' });
  if (annotation.visibility !== ANNOTATION_VISIBILITY.SHARED) {
    return jsonResponse(403, { ok: false, error: 'Only shared annotations can be sent to Hermes' });
  }
  const chunk = store.getChunk(annotation.book_id, annotation.chunk_id);
  if (!chunk) return jsonResponse(404, { ok: false, error: 'chunk not found' });
  const text = await readChunkText({ rootDir: store.rootDir }, chunk);
  const messages = [
    {
      role: 'system',
      content: 'You are Hermes in the co_reading Web reader. Reply as a co-reader with a concise observation, feeling, or follow-up question. Private annotations are unavailable.',
    },
    {
      role: 'user',
      content: [
        `Book: ${annotation.book_id}`,
        `Chunk: ${chunk.title || chunk.id}`,
        `Annotation anchor: ${annotation.anchor_kind || 'original'} (${annotation.anchor_lang || 'source'})`,
        `Chunk text:\n${text}`,
        `Shared quote: ${annotation.quote}`,
        `Shared note: ${annotation.note}`,
        `Reader request: ${question || 'As a co-reader, share a concrete reading response to this shared annotation without merely repeating it.'}`,
      ].join('\n\n'),
    },
  ];
  const response = await fetchImpl(`${config.hermesBaseUrl || DEFAULT_HERMES_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config.hermesApiKey ? { Authorization: `Bearer ${config.hermesApiKey}` } : {}),
    },
    body: JSON.stringify({
      model: 'ran-assistant',
      messages,
      temperature: 0.3,
    }),
  });
  if (!response.ok) {
    return jsonResponse(response.status || 502, { ok: false, error: `Hermes request failed: HTTP ${response.status || 'unknown'}` });
  }
  const payload = await response.json();
  const replyText = extractHermesText(payload);
  const reply = store.replyToAnnotation({ annotationId, text: replyText, author: 'hermes', actor: 'hermes' });
  return jsonResponse(200, { ok: true, reply });
}

function extractHermesText(payload = {}) {
  if (typeof payload.output_text === 'string' && payload.output_text.trim()) return payload.output_text.trim();
  const choice = Array.isArray(payload.choices) ? payload.choices[0] : null;
  const text = choice?.message?.content || choice?.text || '';
  return String(text || '').trim() || 'Hermes returned an empty reply.';
}

async function staticResponse(relativePath, type) {
  const safeRel = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (safeRel.includes('..')) return textResponse(400, 'bad path', 'text/plain; charset=utf-8');
  const filePath = path.join(PUBLIC_ROOT, safeRel || 'index.html');
  try {
    return textResponse(200, await readFile(filePath, 'utf8'), type);
  } catch {
    return textResponse(404, 'not found', 'text/plain; charset=utf-8');
  }
}

function contentType(filePath) {
  if (filePath.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  return 'text/plain; charset=utf-8';
}

function isWebAuthorized(req, config) {
  const expected = String(config.accessToken || '').trim();
  if (!expected) return false;
  const authorization = firstHeader(req.headers, 'authorization');
  if (authorization === `Bearer ${expected}`) return true;
  return firstHeader(req.headers, 'x-co-reading-access-token') === expected;
}

async function readJsonBody(req) {
  if (typeof req.json === 'function') return await req.json();
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function firstHeader(headers = {}, name) {
  const direct = headers[name] || headers[name.toLowerCase()];
  if (Array.isArray(direct)) return String(direct[0] || '').trim();
  return String(direct || '').trim();
}

function jsonResponse(status, body) {
  return { status, body };
}

function textResponse(status, text, contentTypeValue) {
  return { status, text, headers: { 'Content-Type': contentTypeValue } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startCoReadingWebServer();
}
