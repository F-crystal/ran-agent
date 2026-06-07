#!/usr/bin/env node
import readline from 'node:readline';
import path from 'node:path';

import { buildCoReadingApiContract } from './apiContract.mjs';
import { importFromFile, importFromPastedText } from './importers.mjs';
import {
  ANNOTATION_VISIBILITY,
  BOOK_STATES,
  DEFAULT_TRASH_RETENTION_DAYS,
  createCoReadingStore,
  readChunkText,
} from './store.mjs';

export { BOOK_STATES };

export const CO_READING_SERVER_INFO = Object.freeze({
  name: 'ran-agent-co-reading',
  version: '0.1.0',
});

const READ_TOOLS = new Set([
  'reading_list_books',
  'reading_list_chunks',
  'reading_get_progress',
  'reading_continue',
  'reading_read_chunk',
  'reading_get_context_window',
  'reading_search',
  'reading_list_annotations',
  'reading_read_thread',
  'reading_get_storage_stats',
  'reading_list_events',
]);

const WRITE_TOOLS = new Set([
  'reading_import_book',
  'reading_import_pasted_text',
  'reading_add_annotation',
  'reading_share_annotation',
  'reading_reply_to_annotation',
  'reading_mark_progress',
  'reading_archive_book',
  'reading_restore_book',
  'reading_delete_book',
  'reading_cleanup_trash',
]);

const DESTRUCTIVE_TOOLS = new Set([
  'reading_delete_book',
  'reading_cleanup_trash',
]);

export function buildCoReadingTools() {
  const tools = [
    ['reading_list_books', 'List books in the private co-reading library. Trash is hidden unless include_trash is true.', schema({ include_trash: bool() })],
    ['reading_list_chunks', 'List chunks for one book without returning private annotations or chunk text.', schema({ book_id: str() }, ['book_id'])],
    ['reading_get_progress', 'Read synchronized progress for a book, user, and device.', schema({ book_id: str(), user_id: str(), device_id: str() }, ['book_id'])],
    ['reading_continue', 'Return the next chunk from synchronized progress for an explicitly selected book.', schema({ book_id: str(), user_id: str(), device_id: str() }, ['book_id'])],
    ['reading_read_chunk', 'Read one explicit chunk and only shared/Hermes-visible annotations for that chunk.', schema({ book_id: str(), chunk_id: str() }, ['book_id', 'chunk_id'])],
    ['reading_get_context_window', 'Read an explicit bounded chunk window around a selected chunk. Use only when the user asks for surrounding context.', schema({ book_id: str(), chunk_id: str(), before: int(0, 3), after: int(0, 3) }, ['book_id', 'chunk_id'])],
    ['reading_search', 'Search active book chunks through FTS. Results read chunk files as source and never return private annotations.', schema({ book_id: str(), query: str(), limit: int(1, 50) }, ['query'])],
    ['reading_list_annotations', 'List only shared user annotations and Hermes-authored annotations. Private annotations are hidden.', schema({ book_id: str(), chunk_id: str() }, ['book_id'])],
    ['reading_read_thread', 'Read a visible annotation thread. Private annotation threads are not returned.', schema({ annotation_id: str() }, ['annotation_id'])],
    ['reading_get_storage_stats', 'Read storage stats for one book or all books.', schema({ book_id: str() })],
    ['reading_list_events', 'List co-reading audit events. Destructive changes and cleanup are recorded here.', schema({ book_id: str(), limit: int(1, 500) })],
    ['reading_import_book', 'Owner-only import of EPUB/TXT/Markdown/PDF files. PDF OCR is not performed; scanned PDFs are marked ocr_required.', ownerSchema({ file_path: str(), title: str(), author: str() }, ['file_path'])],
    ['reading_import_pasted_text', 'Owner-only import from pasted TXT/Markdown/plain text.', ownerSchema({ title: str(), author: str(), text: str(), format: str() }, ['title', 'text'])],
    ['reading_add_annotation', 'Owner-only add of a private or shared margin annotation. Defaults to private.', ownerSchema({ book_id: str(), chunk_id: str(), quote: str(), quote_offset: int(0), note: str(), visibility: str(['private', 'shared']) }, ['book_id', 'chunk_id', 'note'])],
    ['reading_share_annotation', 'Owner-only publish of one private annotation so Hermes can read and reply to it.', ownerSchema({ annotation_id: str() }, ['annotation_id'])],
    ['reading_reply_to_annotation', 'Owner-only append a reply under a visible annotation. Hermes may not reply to private annotations.', ownerSchema({ annotation_id: str(), text: str(), author: str(['user', 'hermes']) }, ['annotation_id', 'text'])],
    ['reading_mark_progress', 'Owner-only update of synchronized reading progress and audit event.', ownerSchema({ book_id: str(), chunk_id: str(), offset: int(0), user_id: str(), device_id: str() }, ['book_id', 'chunk_id'])],
    ['reading_archive_book', 'Owner-only transition a book from active/trash to archived and audit the change.', ownerSchema({ book_id: str() }, ['book_id'])],
    ['reading_restore_book', 'Owner-only transition archived/trash book back to active and audit the change.', ownerSchema({ book_id: str() }, ['book_id'])],
    ['reading_delete_book', 'Owner-only soft delete into trash. Requires confirm=true and writes reading_events with retention metadata.', ownerSchema({ book_id: str(), confirm: bool(), trash_retention_days: int(0, 3650) }, ['book_id', 'confirm'])],
    ['reading_cleanup_trash', 'Owner-only prune expired trash records and their indexes. Writes reading_events before pruning.', ownerSchema({ now_iso: str() })],
  ];

  return tools.map(([name, description, inputSchema]) => ({
    name,
    title: titleCase(name),
    description,
    inputSchema,
    annotations: {
      readOnlyHint: READ_TOOLS.has(name),
      destructiveHint: DESTRUCTIVE_TOOLS.has(name),
      idempotentHint: READ_TOOLS.has(name),
    },
  }));
}

export async function handleCoReadingMcpRequest(request, options = {}) {
  const method = String(request?.method || '');
  if (method === 'initialize') {
    return {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: CO_READING_SERVER_INFO,
    };
  }
  if (method === 'tools/list') {
    return { tools: buildCoReadingTools() };
  }
  if (method === 'resources/list') {
    return { resources: [{ uri: 'co-reading://api-contract', name: 'co_reading Web reader API contract', mimeType: 'application/json' }] };
  }
  if (method === 'resources/read') {
    const uri = String(request?.params?.uri || '');
    if (uri === 'co-reading://api-contract') {
      return {
        contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(buildCoReadingApiContract(), null, 2) }],
      };
    }
    throw new Error(`unknown co_reading resource: ${uri}`);
  }
  if (method === 'tools/call') {
    const params = request?.params || {};
    const name = String(params.name || '');
    const args = params.arguments || {};
    if (!READ_TOOLS.has(name) && !WRITE_TOOLS.has(name)) {
      return errorResult(`unknown tool: ${name}`, 'CO_READING_UNKNOWN_TOOL');
    }
    if (WRITE_TOOLS.has(name) && !isOwnerAuthorized(args, options)) {
      return errorResult('owner-only co_reading write tool denied', 'CO_READING_PERMISSION_DENIED');
    }
    try {
      const store = await getStore(options);
      return await dispatchTool({ name, args, store, options });
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error), 'CO_READING_TOOL_ERROR');
    }
  }
  throw new Error(`unsupported MCP method: ${method}`);
}

async function dispatchTool({ name, args, store, options }) {
  if (name === 'reading_list_books') {
    return result({ ok: true, books: store.listBooks({ includeTrash: args.include_trash === true }) });
  }
  if (name === 'reading_list_chunks') {
    return result({ ok: true, chunks: store.listChunks(args.book_id) });
  }
  if (name === 'reading_get_progress') {
    return result({ ok: true, progress: store.getProgress(args.book_id, args.user_id || 'user:ran', args.device_id || 'default') });
  }
  if (name === 'reading_continue') {
    const chunk = store.continueReading({ bookId: args.book_id, userId: args.user_id || 'user:ran', deviceId: args.device_id || 'default' });
    if (!chunk) return result({ ok: true, completed: true, chunk: null });
    return await visibleChunkResult(store, chunk);
  }
  if (name === 'reading_read_chunk') {
    const chunk = store.getChunk(args.book_id, args.chunk_id);
    if (!chunk) return errorResult('chunk not found', 'CO_READING_CHUNK_NOT_FOUND');
    return await visibleChunkResult(store, chunk);
  }
  if (name === 'reading_get_context_window') {
    return await contextWindowResult(store, args);
  }
  if (name === 'reading_search') {
    const chunks = store.search({ bookId: args.book_id || '', query: args.query, limit: args.limit });
    const results = [];
    for (const chunk of chunks) {
      results.push({
        book_id: chunk.book_id,
        chunk_id: chunk.id,
        title: chunk.title,
        text: await readChunkText({ rootDir: store.rootDir }, chunk),
      });
    }
    return result({ ok: true, results });
  }
  if (name === 'reading_list_annotations') {
    return result({ ok: true, annotations: store.listAnnotations({ bookId: args.book_id, chunkId: args.chunk_id, includePrivate: false }) });
  }
  if (name === 'reading_read_thread') {
    const thread = store.readThread(args.annotation_id);
    if (!thread) return errorResult('thread not visible or not found', 'CO_READING_THREAD_NOT_VISIBLE');
    return result({ ok: true, ...thread });
  }
  if (name === 'reading_get_storage_stats') {
    return result({ ok: true, storage: store.getStorageStats(args.book_id || null) });
  }
  if (name === 'reading_list_events') {
    return result({ ok: true, events: store.listEvents({ bookId: args.book_id, limit: args.limit }) });
  }
  if (name === 'reading_import_pasted_text') {
    const parsed = await importFromPastedText(args);
    const imported = await store.importBook(parsed);
    return result({ ok: true, ...imported });
  }
  if (name === 'reading_import_book') {
    const parsed = await importFromFile({ filePath: args.file_path, title: args.title, author: args.author });
    const imported = await store.importBook(parsed);
    return result({ ok: true, ...imported });
  }
  if (name === 'reading_add_annotation') {
    const annotation = store.addAnnotation({
      bookId: args.book_id,
      chunkId: args.chunk_id,
      quote: args.quote || '',
      quoteOffset: args.quote_offset ?? null,
      note: args.note || '',
      visibility: args.visibility === ANNOTATION_VISIBILITY.SHARED ? ANNOTATION_VISIBILITY.SHARED : ANNOTATION_VISIBILITY.PRIVATE,
    });
    return result({ ok: true, annotation });
  }
  if (name === 'reading_share_annotation') {
    return result({ ok: true, annotation: store.shareAnnotation(args.annotation_id) });
  }
  if (name === 'reading_reply_to_annotation') {
    return result({ ok: true, reply: store.replyToAnnotation({ annotationId: args.annotation_id, text: args.text, author: args.author || 'hermes' }) });
  }
  if (name === 'reading_mark_progress') {
    return result({ ok: true, progress: store.markProgress({ bookId: args.book_id, chunkId: args.chunk_id, offset: args.offset || 0, userId: args.user_id || 'user:ran', deviceId: args.device_id || 'default' }) });
  }
  if (name === 'reading_archive_book') {
    return result({ ok: true, book: await store.setBookState({ bookId: args.book_id, state: BOOK_STATES.ARCHIVED }) });
  }
  if (name === 'reading_restore_book') {
    return result({ ok: true, book: await store.setBookState({ bookId: args.book_id, state: BOOK_STATES.ACTIVE }) });
  }
  if (name === 'reading_delete_book') {
    if (args.confirm !== true) return errorResult('confirm=true is required', 'CO_READING_CONFIRM_REQUIRED');
    const book = await store.setBookState({ bookId: args.book_id, state: BOOK_STATES.TRASH, trashRetentionDays: args.trash_retention_days ?? DEFAULT_TRASH_RETENTION_DAYS });
    return result({ ok: true, book, trash_expires_at: book.trash_expires_at });
  }
  if (name === 'reading_cleanup_trash') {
    return result({ ok: true, ...(store.cleanupTrash({ now: args.now_iso ? new Date(args.now_iso) : new Date() })) });
  }
  return errorResult(`unknown tool: ${name}`, 'CO_READING_UNKNOWN_TOOL');
}

async function visibleChunkResult(store, chunk) {
  const text = await readChunkText({ rootDir: store.rootDir }, chunk);
  const annotations = store.listAnnotations({ bookId: chunk.book_id, chunkId: chunk.id, includePrivate: false });
  return result({ ok: true, chunk, text, annotations });
}

async function contextWindowResult(store, args) {
  const chunks = store.listChunks(args.book_id);
  const index = chunks.findIndex((chunk) => chunk.id === args.chunk_id);
  if (index < 0) return errorResult('chunk not found', 'CO_READING_CHUNK_NOT_FOUND');
  const before = Math.max(0, Math.min(Number(args.before) || 0, 3));
  const after = Math.max(0, Math.min(Number(args.after) || 0, 3));
  const selected = chunks.slice(Math.max(0, index - before), Math.min(chunks.length, index + after + 1));
  const window = [];
  for (const chunk of selected) {
    window.push({ chunk, text: await readChunkText({ rootDir: store.rootDir }, chunk) });
  }
  return result({ ok: true, book_id: args.book_id, center_chunk_id: args.chunk_id, window });
}

async function getStore(options = {}) {
  if (options.store) return options.store;
  const rootDir = options.rootDir || options.env?.CO_READING_ROOT_DIR || process.env.CO_READING_ROOT_DIR || path.resolve(process.cwd(), '.ran_agent_state/co_reading');
  const store = createCoReadingStore({ rootDir });
  await store.initialize();
  return store;
}

function isOwnerAuthorized(args = {}, options = {}) {
  if (options.trustedOwner === true) return true;
  const expected = String(options.ownerToken || options.env?.CO_READING_OWNER_TOKEN || process.env.CO_READING_OWNER_TOKEN || '').trim();
  if (!expected) return false;
  return String(args.owner_token || '').trim() === expected;
}

function result(payload) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

function errorResult(message, errorCode) {
  const payload = { ok: false, error: String(message), error_code: errorCode };
  return {
    isError: true,
    content: [{ type: 'text', text: payload.error }],
    structuredContent: payload,
  };
}

function str(enumValues = null) {
  const schema = { type: 'string' };
  if (enumValues) schema.enum = enumValues;
  return schema;
}

function bool() {
  return { type: 'boolean' };
}

function int(minimum = undefined, maximum = undefined) {
  const schema = { type: 'integer' };
  if (minimum !== undefined) schema.minimum = minimum;
  if (maximum !== undefined) schema.maximum = maximum;
  return schema;
}

function schema(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false };
}

function ownerSchema(properties, required = []) {
  return schema({ owner_token: str(), ...properties }, ['owner_token', ...required]);
}

function titleCase(name) {
  return name.replace(/_/g, ' ').replace(/\b\w/g, (match) => match.toUpperCase());
}

function writeJsonRpcResponse(id, response) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result: response })}\n`);
}

function writeJsonRpcError(id, error) {
  process.stdout.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
  })}\n`);
}

export function runCoReadingMcpServer(options = {}) {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let request;
    try {
      request = JSON.parse(trimmed);
    } catch (error) {
      writeJsonRpcError(null, error);
      return;
    }
    if (request.id === undefined) return;
    try {
      const response = await handleCoReadingMcpRequest(request, options);
      writeJsonRpcResponse(request.id, response);
    } catch (error) {
      writeJsonRpcError(request.id, error);
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCoReadingMcpServer();
}
