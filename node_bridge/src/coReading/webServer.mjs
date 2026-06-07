#!/usr/bin/env node
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { importFromPastedText } from './importers.mjs';
import { ANNOTATION_VISIBILITY, createCoReadingStore, readChunkText } from './store.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PUBLIC_ROOT = path.join(PROJECT_ROOT, 'node_bridge/public/co-reading');
const DEFAULT_HERMES_BASE_URL = 'http://127.0.0.1:8643/v1';

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
  };
}

export function createCoReadingWebApp(options = {}) {
  const env = options.env || process.env;
  const config = { ...getCoReadingWebConfig(env), ...(options.config || {}) };
  const fetchImpl = options.fetchImpl || globalThis.fetch;
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
      return await routeApi({ req, url, store, config, fetchImpl });
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

async function routeApi({ req, url, store, config, fetchImpl }) {
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
  if (pathParts[0] === 'books' && pathParts[1]) {
    const bookId = decodeURIComponent(pathParts[1]);
    if (req.method === 'GET' && pathParts.length === 2) {
      return jsonResponse(200, { ok: true, book: store.getBook(bookId), storage: store.getStorageStats(bookId) });
    }
    if (req.method === 'GET' && pathParts[2] === 'chunks' && pathParts.length === 3) {
      return jsonResponse(200, { ok: true, chunks: store.listChunks(bookId) });
    }
    if (req.method === 'GET' && pathParts[2] === 'chunks' && pathParts[3]) {
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
        note: body.note || '',
        visibility: body.visibility === ANNOTATION_VISIBILITY.SHARED ? ANNOTATION_VISIBILITY.SHARED : ANNOTATION_VISIBILITY.PRIVATE,
        actor: 'web',
      });
      return jsonResponse(200, { ok: true, annotation });
    }
  }
  if (pathParts[0] === 'annotations' && pathParts[1] && pathParts[2] === 'ask-hermes' && req.method === 'POST') {
    const annotationId = decodeURIComponent(pathParts[1]);
    const body = await readJsonBody(req);
    return await askHermesForAnnotation({ store, annotationId, question: body.question || '', config, fetchImpl });
  }
  return jsonResponse(404, { ok: false, error: 'not found' });
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
      content: 'You are Hermes in the co_reading Web reader. Reply to the shared annotation. Private annotations are unavailable.',
    },
    {
      role: 'user',
      content: [
        `Book: ${annotation.book_id}`,
        `Chunk: ${chunk.title || chunk.id}`,
        `Chunk text:\n${text}`,
        `Shared quote: ${annotation.quote}`,
        `Shared note: ${annotation.note}`,
        `Reader question: ${question || 'Please respond to this shared note.'}`,
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
