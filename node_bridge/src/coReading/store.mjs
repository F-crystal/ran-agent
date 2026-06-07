import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzip, gzip } from 'node:zlib';
import { promisify } from 'node:util';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export const DEFAULT_TRASH_RETENTION_DAYS = 30;

export const BOOK_STATES = Object.freeze({
  ACTIVE: 'active',
  ARCHIVED: 'archived',
  TRASH: 'trash',
});

export const ANNOTATION_VISIBILITY = Object.freeze({
  PRIVATE: 'private',
  SHARED: 'shared',
});

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS reading_books (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    author TEXT NOT NULL DEFAULT '',
    format TEXT NOT NULL,
    source_kind TEXT NOT NULL DEFAULT 'file',
    source_uri TEXT NOT NULL DEFAULT '',
    source_hash TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL CHECK (state IN ('active','archived','trash')),
    ocr_required INTEGER NOT NULL DEFAULT 0,
    original_retained INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    trashed_at TEXT,
    trash_expires_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS reading_sections (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL,
    parent_id TEXT,
    title TEXT NOT NULL,
    section_order INTEGER NOT NULL,
    depth INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (book_id) REFERENCES reading_books(id)
  )`,
  `CREATE TABLE IF NOT EXISTS reading_chunks (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL,
    section_id TEXT,
    chunk_order INTEGER NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    path TEXT NOT NULL,
    char_count INTEGER NOT NULL DEFAULT 0,
    prev_id TEXT,
    next_id TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (book_id) REFERENCES reading_books(id),
    FOREIGN KEY (section_id) REFERENCES reading_sections(id)
  )`,
  `CREATE TABLE IF NOT EXISTS reading_progress (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL,
    user_id TEXT NOT NULL DEFAULT 'user:ran',
    device_id TEXT NOT NULL DEFAULT 'default',
    chunk_id TEXT,
    offset INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    UNIQUE(book_id, user_id, device_id)
  )`,
  `CREATE TABLE IF NOT EXISTS reading_annotations (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL,
    chunk_id TEXT NOT NULL,
    quote TEXT NOT NULL DEFAULT '',
    quote_offset INTEGER,
    note TEXT NOT NULL DEFAULT '',
    author TEXT NOT NULL DEFAULT 'user',
    visibility TEXT NOT NULL CHECK (visibility IN ('private','shared')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (book_id) REFERENCES reading_books(id),
    FOREIGN KEY (chunk_id) REFERENCES reading_chunks(id)
  )`,
  `CREATE TABLE IF NOT EXISTS reading_threads (
    id TEXT PRIMARY KEY,
    annotation_id TEXT NOT NULL,
    book_id TEXT NOT NULL,
    chunk_id TEXT NOT NULL,
    author TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (annotation_id) REFERENCES reading_annotations(id)
  )`,
  `CREATE TABLE IF NOT EXISTS reading_events (
    id TEXT PRIMARY KEY,
    book_id TEXT,
    event_type TEXT NOT NULL,
    actor TEXT NOT NULL DEFAULT 'system',
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS reading_imports (
    id TEXT PRIMARY KEY,
    book_id TEXT,
    source_kind TEXT NOT NULL,
    source_uri TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS reading_sessions (
    id TEXT PRIMARY KEY,
    book_id TEXT,
    user_id TEXT NOT NULL DEFAULT 'user:ran',
    active_chunk_id TEXT,
    shared_context_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS reading_storage_stats (
    book_id TEXT PRIMARY KEY,
    chunk_bytes INTEGER NOT NULL DEFAULT 0,
    original_bytes INTEGER NOT NULL DEFAULT 0,
    asset_bytes INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (book_id) REFERENCES reading_books(id)
  )`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS reading_chunk_fts USING fts5(
    book_id UNINDEXED,
    chunk_id UNINDEXED,
    text,
    tokenize = 'unicode61'
  )`,
  `CREATE INDEX IF NOT EXISTS idx_reading_chunks_book_order ON reading_chunks(book_id, chunk_order)`,
  `CREATE INDEX IF NOT EXISTS idx_reading_annotations_book_chunk ON reading_annotations(book_id, chunk_id)`,
  `CREATE INDEX IF NOT EXISTS idx_reading_threads_annotation ON reading_threads(annotation_id)`,
  `CREATE INDEX IF NOT EXISTS idx_reading_events_book ON reading_events(book_id, created_at)`,
];

function nowIso() {
  return new Date().toISOString();
}

function id(prefix) {
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${random}`;
}

function slugify(value, fallback = 'book') {
  const slug = String(value || '')
    .normalize('NFKD')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .toLowerCase();
  return slug || fallback;
}

function relativeChunkPath(bookId, chunkId) {
  return path.posix.join('library', bookId, 'chunks', `${chunkId}.txt.gz`);
}

function safeJson(value) {
  return JSON.stringify(value ?? {}, null, 0);
}

function rowToObject(row) {
  if (!row) return null;
  const output = { ...row };
  for (const key of ['ocr_required', 'original_retained']) {
    if (key in output) output[key] = Boolean(output[key]);
  }
  return output;
}

export function createCoReadingStore({ rootDir } = {}) {
  if (!rootDir) throw new Error('co_reading rootDir is required');
  return new CoReadingStore(rootDir);
}

export class CoReadingStore {
  constructor(rootDir) {
    this.rootDir = path.resolve(rootDir);
    this.dbPath = path.join(this.rootDir, 'reading.db');
    this.db = null;
  }

  async initialize() {
    await mkdir(path.join(this.rootDir, 'library'), { recursive: true });
    await mkdir(path.join(this.rootDir, 'trash'), { recursive: true });
    await mkdir(path.join(this.rootDir, 'exports'), { recursive: true });
    this.open();
    for (const statement of SCHEMA) {
      this.db.exec(statement);
    }
    this.db.exec('PRAGMA journal_mode = WAL');
  }

  open() {
    if (!this.db) {
      this.db = new DatabaseSync(this.dbPath);
    }
    return this.db;
  }

  listTables() {
    this.open();
    return this.db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','virtual table') ORDER BY name").all().map((row) => row.name);
  }

  async importBook({ title, author = '', format, sourceKind = 'file', sourceUri = '', chunks = [], ocrRequired = false, originalRetained = false }) {
    this.open();
    const createdAt = nowIso();
    const bookId = uniqueBookId(this.db, title);
    const bookDir = path.join(this.rootDir, 'library', bookId);
    const chunksDir = path.join(bookDir, 'chunks');
    await mkdir(chunksDir, { recursive: true });

    this.db.prepare(`
      INSERT INTO reading_books (id, title, author, format, source_kind, source_uri, state, ocr_required, original_retained, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(bookId, title || 'Untitled', author || '', format, sourceKind, sourceUri, BOOK_STATES.ACTIVE, ocrRequired ? 1 : 0, originalRetained ? 1 : 0, createdAt, createdAt);

    const sectionByTitle = new Map();
    const insertedChunks = [];
    for (let index = 0; index < chunks.length; index += 1) {
      const item = chunks[index];
      const sectionTitle = item.sectionTitle || item.title || 'Main';
      let sectionId = sectionByTitle.get(sectionTitle);
      if (!sectionId) {
        sectionId = `${bookId}_sec_${String(sectionByTitle.size + 1).padStart(4, '0')}`;
        sectionByTitle.set(sectionTitle, sectionId);
        this.db.prepare(`
          INSERT INTO reading_sections (id, book_id, parent_id, title, section_order, depth)
          VALUES (?, ?, NULL, ?, ?, 0)
        `).run(sectionId, bookId, sectionTitle, sectionByTitle.size - 1);
      }
      const chunkId = `${bookId}_ch_${String(index + 1).padStart(6, '0')}`;
      const relPath = relativeChunkPath(bookId, chunkId);
      const text = String(item.text || '');
      await writeChunkText({ rootDir: this.rootDir }, relPath, text);
      const prevId = index > 0 ? `${bookId}_ch_${String(index).padStart(6, '0')}` : null;
      const nextId = index < chunks.length - 1 ? `${bookId}_ch_${String(index + 2).padStart(6, '0')}` : null;
      this.db.prepare(`
        INSERT INTO reading_chunks (id, book_id, section_id, chunk_order, title, path, char_count, prev_id, next_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(chunkId, bookId, sectionId, index, item.title || sectionTitle, relPath, text.length, prevId, nextId, createdAt);
      this.db.prepare('INSERT INTO reading_chunk_fts (book_id, chunk_id, text) VALUES (?, ?, ?)').run(bookId, chunkId, text);
      insertedChunks.push({
        id: chunkId,
        book_id: bookId,
        section_id: sectionId,
        order: index,
        title: item.title || sectionTitle,
        path: relPath,
        char_count: text.length,
        prev_id: prevId,
        next_id: nextId,
      });
    }

    await this.refreshStorageStats(bookId);
    this.recordEvent({ bookId, eventType: 'book_imported', actor: 'owner', payload: { format, source_kind: sourceKind, chunk_count: insertedChunks.length, ocr_required: Boolean(ocrRequired) } });
    return { book: this.getBook(bookId), chunks: insertedChunks };
  }

  getBook(bookId) {
    this.open();
    return rowToObject(this.db.prepare('SELECT * FROM reading_books WHERE id = ?').get(bookId));
  }

  listBooks({ includeTrash = false } = {}) {
    this.open();
    const rows = includeTrash
      ? this.db.prepare('SELECT * FROM reading_books ORDER BY updated_at DESC').all()
      : this.db.prepare("SELECT * FROM reading_books WHERE state != 'trash' ORDER BY updated_at DESC").all();
    return rows.map(rowToObject);
  }

  listChunks(bookId) {
    this.open();
    return this.db.prepare('SELECT * FROM reading_chunks WHERE book_id = ? ORDER BY chunk_order ASC').all(bookId).map(rowToObject);
  }

  getChunk(bookId, chunkId) {
    this.open();
    return rowToObject(this.db.prepare('SELECT * FROM reading_chunks WHERE book_id = ? AND id = ?').get(bookId, chunkId));
  }

  getFirstChunk(bookId) {
    this.open();
    return rowToObject(this.db.prepare('SELECT * FROM reading_chunks WHERE book_id = ? ORDER BY chunk_order ASC LIMIT 1').get(bookId));
  }

  getProgress(bookId, userId = 'user:ran', deviceId = 'default') {
    this.open();
    return rowToObject(this.db.prepare('SELECT * FROM reading_progress WHERE book_id = ? AND user_id = ? AND device_id = ?').get(bookId, userId, deviceId));
  }

  markProgress({ bookId, chunkId, offset = 0, userId = 'user:ran', deviceId = 'default', actor = 'owner' }) {
    this.open();
    const at = nowIso();
    const progressId = `${bookId}:${userId}:${deviceId}`;
    this.db.prepare(`
      INSERT INTO reading_progress (id, book_id, user_id, device_id, chunk_id, offset, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(book_id, user_id, device_id) DO UPDATE SET chunk_id = excluded.chunk_id, offset = excluded.offset, updated_at = excluded.updated_at
    `).run(progressId, bookId, userId, deviceId, chunkId, Number(offset) || 0, at);
    this.recordEvent({ bookId, eventType: 'progress_marked', actor, payload: { chunk_id: chunkId, offset: Number(offset) || 0, user_id: userId, device_id: deviceId } });
    return this.getProgress(bookId, userId, deviceId);
  }

  continueReading({ bookId, userId = 'user:ran', deviceId = 'default' }) {
    const progress = this.getProgress(bookId, userId, deviceId);
    if (progress?.chunk_id) {
      const chunk = this.getChunk(bookId, progress.chunk_id);
      if (chunk?.next_id) return this.getChunk(bookId, chunk.next_id);
      if (chunk) return chunk;
    }
    return this.getFirstChunk(bookId);
  }

  search({ bookId, query, limit = 10 }) {
    this.open();
    const safeLimit = Math.max(1, Math.min(Number(limit) || 10, 50));
    let rows = this.db.prepare(`
      SELECT c.*
      FROM reading_chunk_fts f
      JOIN reading_chunks c ON c.id = f.chunk_id
      JOIN reading_books b ON b.id = c.book_id
      WHERE f.text MATCH ? AND (? = '' OR f.book_id = ?) AND b.state = 'active'
      LIMIT ?
    `).all(String(query || '').trim(), bookId || '', bookId || '', safeLimit);
    if (rows.length === 0) {
      rows = this.db.prepare(`
        SELECT c.*
        FROM reading_chunk_fts f
        JOIN reading_chunks c ON c.id = f.chunk_id
        JOIN reading_books b ON b.id = c.book_id
        WHERE f.text LIKE ? AND (? = '' OR f.book_id = ?) AND b.state = 'active'
        LIMIT ?
      `).all(`%${String(query || '').trim()}%`, bookId || '', bookId || '', safeLimit);
    }
    return rows.map(rowToObject);
  }

  addAnnotation({ bookId, chunkId, quote = '', quoteOffset = null, note = '', visibility = ANNOTATION_VISIBILITY.PRIVATE, author = 'user', actor = 'owner' }) {
    this.open();
    const createdAt = nowIso();
    const annotationId = id('ann');
    const normalizedVisibility = visibility === ANNOTATION_VISIBILITY.SHARED ? ANNOTATION_VISIBILITY.SHARED : ANNOTATION_VISIBILITY.PRIVATE;
    this.db.prepare(`
      INSERT INTO reading_annotations (id, book_id, chunk_id, quote, quote_offset, note, author, visibility, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(annotationId, bookId, chunkId, quote, quoteOffset === null || quoteOffset === undefined ? null : Number(quoteOffset), note, author, normalizedVisibility, createdAt, createdAt);
    this.recordEvent({ bookId, eventType: 'annotation_added', actor, payload: { annotation_id: annotationId, chunk_id: chunkId, visibility: normalizedVisibility } });
    return this.getAnnotation(annotationId, { includePrivate: true });
  }

  getAnnotation(annotationId, { includePrivate = false } = {}) {
    this.open();
    const row = rowToObject(this.db.prepare('SELECT * FROM reading_annotations WHERE id = ?').get(annotationId));
    if (!row) return null;
    if (!includePrivate && row.visibility !== ANNOTATION_VISIBILITY.SHARED && row.author !== 'hermes') return null;
    return row;
  }

  listAnnotations({ bookId, chunkId, includePrivate = false }) {
    this.open();
    const where = ['book_id = ?'];
    const args = [bookId];
    if (chunkId) {
      where.push('chunk_id = ?');
      args.push(chunkId);
    }
    if (!includePrivate) {
      where.push("(visibility = 'shared' OR author = 'hermes')");
    }
    return this.db.prepare(`SELECT * FROM reading_annotations WHERE ${where.join(' AND ')} ORDER BY created_at ASC`).all(...args).map(rowToObject);
  }

  shareAnnotation(annotationId, actor = 'owner') {
    this.open();
    const annotation = this.getAnnotation(annotationId, { includePrivate: true });
    if (!annotation) throw new Error(`annotation not found: ${annotationId}`);
    const at = nowIso();
    this.db.prepare("UPDATE reading_annotations SET visibility = 'shared', updated_at = ? WHERE id = ?").run(at, annotationId);
    this.recordEvent({ bookId: annotation.book_id, eventType: 'annotation_shared', actor, payload: { annotation_id: annotationId } });
    return this.getAnnotation(annotationId, { includePrivate: false });
  }

  replyToAnnotation({ annotationId, text, author = 'hermes', actor = 'owner' }) {
    this.open();
    const annotation = this.getAnnotation(annotationId, { includePrivate: true });
    if (!annotation) throw new Error(`annotation not found: ${annotationId}`);
    if (annotation.visibility !== ANNOTATION_VISIBILITY.SHARED && author === 'hermes') {
      throw new Error('Hermes cannot reply to private annotation');
    }
    const threadId = id('thread');
    const at = nowIso();
    this.db.prepare(`
      INSERT INTO reading_threads (id, annotation_id, book_id, chunk_id, author, text, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(threadId, annotationId, annotation.book_id, annotation.chunk_id, author, text, at);
    this.recordEvent({ bookId: annotation.book_id, eventType: 'thread_replied', actor, payload: { annotation_id: annotationId, thread_id: threadId, author } });
    return rowToObject(this.db.prepare('SELECT * FROM reading_threads WHERE id = ?').get(threadId));
  }

  readThread(annotationId, { includePrivate = false } = {}) {
    this.open();
    const annotation = this.getAnnotation(annotationId, { includePrivate });
    if (!annotation) return null;
    const replies = this.db.prepare('SELECT * FROM reading_threads WHERE annotation_id = ? ORDER BY created_at ASC').all(annotationId).map(rowToObject);
    return { annotation, replies };
  }

  async setBookState({ bookId, state, actor = 'owner', trashRetentionDays = DEFAULT_TRASH_RETENTION_DAYS }) {
    this.open();
    const book = this.getBook(bookId);
    if (!book) throw new Error(`book not found: ${bookId}`);
    const at = nowIso();
    let trashExpiresAt = null;
    let trashedAt = null;
    if (state === BOOK_STATES.TRASH) {
      trashedAt = at;
      trashExpiresAt = new Date(Date.now() + Number(trashRetentionDays) * 24 * 60 * 60 * 1000).toISOString();
    }
    this.db.prepare(`
      UPDATE reading_books
      SET state = ?, updated_at = ?, trashed_at = ?, trash_expires_at = ?
      WHERE id = ?
    `).run(state, at, trashedAt, trashExpiresAt, bookId);
    const eventType = state === BOOK_STATES.ARCHIVED ? 'book_archived' : state === BOOK_STATES.TRASH ? 'book_trashed' : 'book_restored';
    this.recordEvent({ bookId, eventType, actor, payload: { previous_state: book.state, state, trash_expires_at: trashExpiresAt } });
    return this.getBook(bookId);
  }

  cleanupTrash({ actor = 'owner', now = new Date() } = {}) {
    this.open();
    const expired = this.db.prepare("SELECT * FROM reading_books WHERE state = 'trash' AND trash_expires_at IS NOT NULL AND trash_expires_at <= ?").all(now.toISOString()).map(rowToObject);
    for (const book of expired) {
      this.recordEvent({ bookId: book.id, eventType: 'book_trash_pruned', actor, payload: { trash_expires_at: book.trash_expires_at } });
      this.db.prepare('DELETE FROM reading_chunk_fts WHERE book_id = ?').run(book.id);
      this.db.prepare('DELETE FROM reading_threads WHERE book_id = ?').run(book.id);
      this.db.prepare('DELETE FROM reading_annotations WHERE book_id = ?').run(book.id);
      this.db.prepare('DELETE FROM reading_progress WHERE book_id = ?').run(book.id);
      this.db.prepare('DELETE FROM reading_chunks WHERE book_id = ?').run(book.id);
      this.db.prepare('DELETE FROM reading_sections WHERE book_id = ?').run(book.id);
      this.db.prepare('DELETE FROM reading_storage_stats WHERE book_id = ?').run(book.id);
      this.db.prepare('DELETE FROM reading_books WHERE id = ?').run(book.id);
    }
    return { removed: expired.length, books: expired.map((book) => book.id) };
  }

  listEvents({ bookId, limit = 100 } = {}) {
    this.open();
    const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
    const rows = bookId
      ? this.db.prepare('SELECT * FROM reading_events WHERE book_id = ? ORDER BY created_at ASC LIMIT ?').all(bookId, safeLimit)
      : this.db.prepare('SELECT * FROM reading_events ORDER BY created_at ASC LIMIT ?').all(safeLimit);
    return rows.map((row) => ({ ...row, payload: JSON.parse(row.payload_json || '{}') }));
  }

  recordEvent({ bookId = null, eventType, actor = 'system', payload = {} }) {
    this.open();
    this.db.prepare(`
      INSERT INTO reading_events (id, book_id, event_type, actor, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id('event'), bookId, eventType, actor, safeJson(payload), nowIso());
  }

  async refreshStorageStats(bookId) {
    this.open();
    const chunks = this.listChunks(bookId);
    let chunkBytes = 0;
    for (const chunk of chunks) {
      try {
        const item = await stat(path.join(this.rootDir, chunk.path));
        chunkBytes += item.size;
      } catch {
        // Missing chunk files are reported through read errors; stats stay best-effort.
      }
    }
    this.db.prepare(`
      INSERT INTO reading_storage_stats (book_id, chunk_bytes, original_bytes, asset_bytes, updated_at)
      VALUES (?, ?, 0, 0, ?)
      ON CONFLICT(book_id) DO UPDATE SET chunk_bytes = excluded.chunk_bytes, updated_at = excluded.updated_at
    `).run(bookId, chunkBytes, nowIso());
    return this.getStorageStats(bookId);
  }

  getStorageStats(bookId = null) {
    this.open();
    if (bookId) {
      return rowToObject(this.db.prepare('SELECT * FROM reading_storage_stats WHERE book_id = ?').get(bookId));
    }
    return this.db.prepare('SELECT * FROM reading_storage_stats ORDER BY updated_at DESC').all().map(rowToObject);
  }
}

function uniqueBookId(db, title) {
  const base = slugify(title || 'book');
  let candidate = base;
  let index = 1;
  while (db.prepare('SELECT id FROM reading_books WHERE id = ?').get(candidate)) {
    index += 1;
    candidate = `${base}-${index}`;
  }
  return candidate;
}

export async function writeChunkText({ rootDir }, relativePath, text) {
  const absolute = path.join(rootDir, relativePath);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, await gzipAsync(Buffer.from(String(text || ''), 'utf8')));
  return absolute;
}

export async function readChunkText({ rootDir }, chunkOrPath) {
  const relPath = typeof chunkOrPath === 'string' ? chunkOrPath : chunkOrPath.path;
  const buffer = await readFile(path.join(rootDir, relPath));
  return String(await gunzipAsync(buffer), 'utf8');
}

export async function moveBookToTrashDir({ rootDir, bookId }) {
  const source = path.join(rootDir, 'library', bookId);
  const target = path.join(rootDir, 'trash', `${bookId}-${Date.now()}`);
  await mkdir(path.dirname(target), { recursive: true });
  try {
    await rename(source, target);
  } catch {
    await rm(source, { recursive: true, force: true });
  }
  return target;
}
