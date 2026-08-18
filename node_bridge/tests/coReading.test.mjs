import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildCoReadingApiContract } from '../src/coReading/apiContract.mjs';
import {
  BOOK_STATES,
  buildCoReadingTools,
  handleCoReadingMcpRequest,
} from '../src/coReading/mcpServer.mjs';
import {
  createCoReadingStore,
  hashText,
  readChunkText,
} from '../src/coReading/store.mjs';
import { createCoReadingWebApp, getCoReadingWebConfig } from '../src/coReading/webServer.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function tempRoot() {
  return await mkdtemp(path.join(os.tmpdir(), 'co-reading-'));
}

async function withStore(fn) {
  const root = await tempRoot();
  try {
    const store = createCoReadingStore({ rootDir: root });
    await store.initialize();
    await fn({ root, store });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('co-reading defaults to the unified Hermes gateway', () => {
  assert.equal(getCoReadingWebConfig({}).hermesBaseUrl, 'http://127.0.0.1:8642/v1');
});

function callTool(name, args, options = {}) {
  return handleCoReadingMcpRequest(
    {
      method: 'tools/call',
      params: { name, arguments: args },
    },
    options
  );
}

function req(method, url, { token = 'web', body = null } = {}) {
  return {
    method,
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    json: async () => body || {},
  };
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
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

async function createMinimalEpub(filePath, bodyHtml = '<h1>Chapter One</h1><p>First EPUB paragraph.</p><p>Second EPUB paragraph.</p>') {
  const script = `
import zipfile
from pathlib import Path
p = Path(${JSON.stringify(filePath)})
body_html = ${JSON.stringify(bodyHtml)}
with zipfile.ZipFile(p, "w") as z:
    z.writestr("mimetype", "application/epub+zip")
    z.writestr("META-INF/container.xml", """<?xml version='1.0'?><container version='1.0' xmlns='urn:oasis:names:tc:opendocument:xmlns:container'><rootfiles><rootfile full-path='OPS/content.opf' media-type='application/oebps-package+xml'/></rootfiles></container>""")
    z.writestr("OPS/content.opf", """<?xml version='1.0'?><package xmlns='http://www.idpf.org/2007/opf' version='3.0'><metadata xmlns:dc='http://purl.org/dc/elements/1.1/'><dc:title>EPUB Title</dc:title><dc:creator>EPUB Author</dc:creator></metadata><manifest><item id='c1' href='chapter1.xhtml' media-type='application/xhtml+xml'/></manifest><spine><itemref idref='c1'/></spine></package>""")
    z.writestr("OPS/chapter1.xhtml", "<html xmlns='http://www.w3.org/1999/xhtml'><body>" + body_html + "</body></html>")
`;
  await run('python3', ['-c', script]);
}

test('co_reading initializes required SQLite tables and FTS metadata table', async () => {
  await withStore(async ({ store }) => {
    const tables = store.listTables();

    assert.deepEqual(
      [
        'reading_annotations',
        'reading_books',
        'reading_chunk_fts',
        'reading_chunks',
        'reading_events',
        'reading_imports',
        'reading_progress',
        'reading_sections',
        'reading_sessions',
        'reading_storage_stats',
        'reading_translations',
        'reading_threads',
      ].every((name) => tables.includes(name)),
      true
    );
  });
});

test('co_reading imports pasted text into gzipped chunks and searches by FTS while reading chunk files as source', async () => {
  await withStore(async ({ root }) => {
    const result = await callTool(
      'reading_import_pasted_text',
      {
        owner_token: 'owner',
        title: 'Shared Reading',
        text: '第一章\n这里讨论共同阅读和边栏批注。\n\n第二章\nHermes 只能读被允许的上下文。',
        format: 'markdown',
      },
      { rootDir: root, ownerToken: 'owner' }
    );

    assert.equal(result.structuredContent.ok, true);
    assert.equal(result.structuredContent.book.state, BOOK_STATES.ACTIVE);
    assert.equal(result.structuredContent.chunks.length >= 1, true);

    const chunk = result.structuredContent.chunks[0];
    assert.match(chunk.path, /\.txt\.gz$/);
    const text = await readChunkText({ rootDir: root }, chunk);
    assert.match(text, /共同阅读/);

    const search = await callTool(
      'reading_search',
      { book_id: result.structuredContent.book.id, query: '边栏批注' },
      { rootDir: root }
    );
    assert.equal(search.structuredContent.ok, true);
    assert.equal(search.structuredContent.results.length, 1);
    assert.equal(search.structuredContent.results[0].chunk_id, chunk.id);
    assert.match(search.structuredContent.results[0].text, /边栏批注/);
  });
});

test('private annotations are hidden from list tools and Hermes-readable chunks', async () => {
  await withStore(async ({ root }) => {
    const imported = await callTool(
      'reading_import_pasted_text',
      { owner_token: 'owner', title: 'Privacy Book', text: '隐私批注测试正文。' },
      { rootDir: root, ownerToken: 'owner' }
    );
    const bookId = imported.structuredContent.book.id;
    const chunkId = imported.structuredContent.chunks[0].id;

    await callTool(
      'reading_add_annotation',
      {
        owner_token: 'owner',
        book_id: bookId,
        chunk_id: chunkId,
        quote: '隐私批注',
        note: '不该给 Hermes 看',
        visibility: 'private',
      },
      { rootDir: root, ownerToken: 'owner' }
    );
    const shared = await callTool(
      'reading_add_annotation',
      {
        owner_token: 'owner',
        book_id: bookId,
        chunk_id: chunkId,
        quote: '测试正文',
        note: '这条可以共享',
        visibility: 'shared',
      },
      { rootDir: root, ownerToken: 'owner' }
    );

    const listed = await callTool(
      'reading_list_annotations',
      { book_id: bookId, chunk_id: chunkId },
      { rootDir: root }
    );
    assert.deepEqual(listed.structuredContent.annotations.map((item) => item.id), [
      shared.structuredContent.annotation.id,
    ]);

    const read = await callTool(
      'reading_read_chunk',
      { book_id: bookId, chunk_id: chunkId },
      { rootDir: root }
    );
    assert.equal(read.structuredContent.annotations.length, 1);
    assert.doesNotMatch(JSON.stringify(read.structuredContent), /不该给 Hermes 看/);
  });
});

test('write tools require owner token and destructive state changes write events with trash retention', async () => {
  await withStore(async ({ root }) => {
    const denied = await callTool(
      'reading_import_pasted_text',
      { title: 'Denied', text: 'no owner' },
      { rootDir: root, ownerToken: 'owner' }
    );
    assert.equal(denied.isError, true);
    assert.equal(denied.structuredContent.error_code, 'CO_READING_PERMISSION_DENIED');

    const imported = await callTool(
      'reading_import_pasted_text',
      { owner_token: 'owner', title: 'State Book', text: '状态机正文。' },
      { rootDir: root, ownerToken: 'owner' }
    );
    const bookId = imported.structuredContent.book.id;

    const archived = await callTool(
      'reading_archive_book',
      { owner_token: 'owner', book_id: bookId },
      { rootDir: root, ownerToken: 'owner' }
    );
    assert.equal(archived.structuredContent.book.state, BOOK_STATES.ARCHIVED);

    const deleted = await callTool(
      'reading_delete_book',
      { owner_token: 'owner', book_id: bookId, confirm: true },
      { rootDir: root, ownerToken: 'owner' }
    );
    assert.equal(deleted.structuredContent.book.state, BOOK_STATES.TRASH);
    assert.equal(typeof deleted.structuredContent.trash_expires_at, 'string');

    const events = await callTool('reading_list_events', { book_id: bookId }, { rootDir: root });
    assert.deepEqual(events.structuredContent.events.map((event) => event.event_type), [
      'book_imported',
      'book_archived',
      'book_trashed',
    ]);
  });
});

test('importer supports txt markdown epub and marks PDF text layer or OCR requirement without OCR', async () => {
  await withStore(async ({ root }) => {
    const txtPath = path.join(root, 'sample.txt');
    const mdPath = path.join(root, 'sample.md');
    const epubPath = path.join(root, 'sample.epub');
    const longEpubPath = path.join(root, 'long.epub');
    const pdfPath = path.join(root, 'sample.pdf');
    await writeFile(txtPath, 'TXT title\nTXT body text');
    await writeFile(mdPath, '# Markdown Title\n\nMarkdown body text');
    await createMinimalEpub(epubPath);
    await createMinimalEpub(longEpubPath, `<h1>Long Chapter</h1><p>${'Long EPUB sentence. '.repeat(420)}</p>`);
    await writeFile(pdfPath, '%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nendobj\nstream\nBT (PDF text layer) Tj ET\nendstream\n%%EOF');

    for (const filePath of [txtPath, mdPath, epubPath]) {
      const imported = await callTool(
        'reading_import_book',
        { owner_token: 'owner', file_path: filePath },
        { rootDir: root, ownerToken: 'owner' }
      );
      assert.equal(imported.structuredContent.ok, true);
      assert.equal(imported.structuredContent.book.state, BOOK_STATES.ACTIVE);
      assert.equal(imported.structuredContent.chunks.length >= 1, true);
    }

    const longEpub = await callTool(
      'reading_import_book',
      { owner_token: 'owner', file_path: longEpubPath },
      { rootDir: root, ownerToken: 'owner' }
    );
    assert.equal(longEpub.structuredContent.book.format, 'epub');
    assert.equal(longEpub.structuredContent.chunks.length > 1, true);
    assert.equal(longEpub.structuredContent.chunks.every((chunk) => chunk.char_count <= 4500), true);

    const pdf = await callTool(
      'reading_import_book',
      { owner_token: 'owner', file_path: pdfPath },
      { rootDir: root, ownerToken: 'owner' }
    );
    assert.equal(pdf.structuredContent.ok, true);
    assert.equal(pdf.structuredContent.book.format, 'pdf');
    assert.equal(pdf.structuredContent.book.ocr_required, false);

    await writeFile(pdfPath, '%PDF-1.4\n/Type /Page\n/Image\n%%EOF');
    const scannedPdf = await callTool(
      'reading_import_book',
      { owner_token: 'owner', file_path: pdfPath, title: 'Scanned PDF' },
      { rootDir: root, ownerToken: 'owner' }
    );
    assert.equal(scannedPdf.structuredContent.book.ocr_required, true);
    assert.equal(scannedPdf.structuredContent.chunks.length, 0);
  });
});

test('MCP tool names and Web reader API contract expose permission layers', async () => {
  const tools = buildCoReadingTools();
  assert.deepEqual(tools.map((tool) => tool.name), [
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
  assert.equal(tools.find((tool) => tool.name === 'reading_import_book').annotations.destructiveHint, false);
  assert.equal(tools.find((tool) => tool.name === 'reading_delete_book').annotations.destructiveHint, true);
  assert.equal(tools.find((tool) => tool.name === 'reading_read_chunk').annotations.readOnlyHint, true);

  const initialized = await handleCoReadingMcpRequest({ method: 'initialize' });
  assert.deepEqual(initialized.capabilities, { tools: {} });
  assert.equal(initialized.serverInfo.name, 'ran-agent-co-reading');

  const contract = buildCoReadingApiContract();
  assert.equal(contract.service, 'co_reading_web_reader');
  assert.equal(contract.endpoints.some((endpoint) => endpoint.method === 'POST' && endpoint.path === '/api/co-reading/import-paste'), true);
  assert.equal(contract.endpoints.some((endpoint) => endpoint.method === 'POST' && endpoint.path === '/api/co-reading/books/:book_id/archive'), true);
  assert.equal(contract.endpoints.some((endpoint) => endpoint.method === 'POST' && endpoint.path === '/api/co-reading/books/:book_id/trash'), true);
  assert.equal(contract.endpoints.some((endpoint) => endpoint.method === 'GET' && endpoint.path === '/api/co-reading/books/:book_id/chunks/:chunk_id/translation'), true);
  assert.equal(contract.endpoints.some((endpoint) => endpoint.method === 'POST' && endpoint.path === '/api/co-reading/annotations/:annotation_id/ask-hermes'), true);
  assert.equal(contract.security.owner_only_writes, true);
});

test('co_reading Web static UI keeps mobile annotation composer in reader view', async () => {
  const appJs = await readFile(path.join(REPO_ROOT, 'node_bridge/public/co-reading/app.js'), 'utf8');
  const css = await readFile(path.join(REPO_ROOT, 'node_bridge/public/co-reading/style.css'), 'utf8');

  assert.doesNotMatch(appJs, /setView\(window\.matchMedia\('\(max-width: 760px\)'\)\.matches \? 'annotations'/);
  assert.match(appJs, /composer-open/);
  assert.match(appJs, /translationCache: new Map/);
  assert.match(appJs, /translationCacheKey/);
  assert.match(css, /\.layout\[data-view="reader"\]\.composer-open \.annotations-panel/);
});

test('co_reading Web static UI supports mobile selection and annotation quote focus', async () => {
  const appJs = await readFile(path.join(REPO_ROOT, 'node_bridge/public/co-reading/app.js'), 'utf8');
  const css = await readFile(path.join(REPO_ROOT, 'node_bridge/public/co-reading/style.css'), 'utf8');

  assert.match(appJs, /scheduleSelectionCapture/);
  assert.match(appJs, /selectionchange/);
  assert.match(appJs, /touchend/);
  assert.match(appJs, /activeAnnotationId/);
  assert.match(appJs, /focusAnnotationQuote/);
  assert.match(appJs, /annotation-highlight/);
  assert.match(css, /\.annotation-highlight/);
  assert.match(css, /\.annotation-card\.is-active/);
});

test('co_reading Web API protects owner token and supports shelf import read progress search annotations', async () => {
  await withStore(async ({ root, store }) => {
    const translationCalls = [];
    const app = createCoReadingWebApp({
      store,
      config: {
        accessToken: 'web-token',
        ownerToken: 'server-owner-secret',
        rootDir: root,
      },
      fetchImpl: async (url, request) => {
        const body = JSON.parse(request.body);
        translationCalls.push({ url, body });
        const isJudge = /translation QA judge/i.test(body.messages?.[0]?.content || '');
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{ message: { content: isJudge ? '{"valid":true,"reason":"direct translation"}' : '第一段中文译文。\n\n第二段中文译文。' } }],
          }),
        };
      },
    });

    const denied = await app.handleRequest(req('GET', '/api/co-reading/books', { token: '' }));
    assert.equal(denied.status, 401);

    const reader = await app.handleRequest(req('GET', '/reader', { token: '' }));
    assert.equal(reader.status, 200);
    assert.match(reader.text, /co-reading-reader/);
    assert.doesNotMatch(reader.text, /server-owner-secret/);

    const imported = await app.handleRequest(req('POST', '/api/co-reading/import-paste', {
      token: 'web-token',
      body: {
        title: 'Web Reader Book',
        format: 'markdown',
        text: '# 第一章\n\n这是第一段。\n\n这是第二段，包含搜索词。',
      },
    }));
    assert.equal(imported.status, 200);
    assert.equal(imported.body.ok, true);
    assert.doesNotMatch(JSON.stringify(imported.body), /server-owner-secret/);
    const bookId = imported.body.book.id;
    const chunkId = imported.body.chunks[0].id;

    const shelf = await app.handleRequest(req('GET', '/api/co-reading/books', { token: 'web-token' }));
    assert.equal(shelf.body.books.some((book) => book.id === bookId), true);

    const chunk = await app.handleRequest(req('GET', `/api/co-reading/books/${encodeURIComponent(bookId)}/chunks/${encodeURIComponent(chunkId)}`, { token: 'web-token' }));
    assert.equal(chunk.status, 200);
    assert.match(chunk.body.text, /搜索词/);

    const progressWrite = await app.handleRequest(req('POST', `/api/co-reading/books/${encodeURIComponent(bookId)}/progress`, {
      token: 'web-token',
      body: { chunk_id: chunkId, offset: 12, device_id: 'desktop' },
    }));
    assert.equal(progressWrite.body.progress.offset, 12);
    const progressRead = await app.handleRequest(req('GET', `/api/co-reading/books/${encodeURIComponent(bookId)}/progress?device_id=desktop`, { token: 'web-token' }));
    assert.equal(progressRead.body.progress.chunk_id, chunkId);

    const search = await app.handleRequest(req('GET', `/api/co-reading/books/${encodeURIComponent(bookId)}/search?q=${encodeURIComponent('搜索词')}`, { token: 'web-token' }));
    assert.equal(search.status, 200);
    assert.equal(search.body.results.length, 1);
    assert.match(search.body.results[0].text, /搜索词/);

    const annotation = await app.handleRequest(req('POST', `/api/co-reading/books/${encodeURIComponent(bookId)}/annotations`, {
      token: 'web-token',
      body: {
        chunk_id: chunkId,
        quote: '第一段',
        note: 'private margin note',
        visibility: 'private',
      },
    }));
    assert.equal(annotation.body.annotation.visibility, 'private');
    assert.equal(annotation.body.annotation.anchor_kind, 'original');
    assert.equal(annotation.body.annotation.anchor_lang, 'source');

    const translationAnnotation = await app.handleRequest(req('POST', `/api/co-reading/books/${encodeURIComponent(bookId)}/annotations`, {
      token: 'web-token',
      body: {
        chunk_id: chunkId,
        quote: '第一段中文译文',
        note: 'translation margin note',
        visibility: 'private',
        anchor_kind: 'translation',
        anchor_lang: 'zh-CN',
      },
    }));
    assert.equal(translationAnnotation.body.annotation.anchor_kind, 'translation');
    assert.equal(translationAnnotation.body.annotation.anchor_lang, 'zh-CN');

    const listed = await app.handleRequest(req('GET', `/api/co-reading/books/${encodeURIComponent(bookId)}/chunks/${encodeURIComponent(chunkId)}`, { token: 'web-token' }));
    assert.equal(listed.body.annotations.some((item) => item.note === 'private margin note'), true);
    assert.equal(listed.body.annotations.some((item) => item.note === 'translation margin note' && item.anchor_kind === 'translation'), true);

    const translated = await app.handleRequest(req('GET', `/api/co-reading/books/${encodeURIComponent(bookId)}/chunks/${encodeURIComponent(chunkId)}/translation?target=zh-CN`, { token: 'web-token' }));
    assert.equal(translated.status, 200);
    assert.equal(translated.body.source_is_target, true);
    assert.equal(translated.body.translation.text, '');
    assert.equal(translationCalls.length, 0);
    assert.doesNotMatch(JSON.stringify(translated.body), /server-owner-secret/);

    const cachedTranslation = await app.handleRequest(req('GET', `/api/co-reading/books/${encodeURIComponent(bookId)}/chunks/${encodeURIComponent(chunkId)}/translation?target=zh-CN`, { token: 'web-token' }));
    assert.equal(cachedTranslation.status, 200);
    assert.equal(cachedTranslation.body.source_is_target, true);
    assert.equal(translationCalls.length, 0);

    const refreshedTranslation = await app.handleRequest(req('GET', `/api/co-reading/books/${encodeURIComponent(bookId)}/chunks/${encodeURIComponent(chunkId)}/translation?target=zh-CN&force=true`, { token: 'web-token' }));
    assert.equal(refreshedTranslation.status, 200);
    assert.equal(refreshedTranslation.body.source_is_target, true);
    assert.equal(translationCalls.length, 0);

    const archived = await app.handleRequest(req('POST', `/api/co-reading/books/${encodeURIComponent(bookId)}/archive`, { token: 'web-token' }));
    assert.equal(archived.status, 200);
    assert.equal(archived.body.book.state, BOOK_STATES.ARCHIVED);

    const restored = await app.handleRequest(req('POST', `/api/co-reading/books/${encodeURIComponent(bookId)}/restore`, { token: 'web-token' }));
    assert.equal(restored.body.book.state, BOOK_STATES.ACTIVE);

    const deniedTrash = await app.handleRequest(req('POST', `/api/co-reading/books/${encodeURIComponent(bookId)}/trash`, { token: 'web-token' }));
    assert.equal(deniedTrash.status, 400);

    const trashed = await app.handleRequest(req('POST', `/api/co-reading/books/${encodeURIComponent(bookId)}/trash`, {
      token: 'web-token',
      body: { confirm: true },
    }));
    assert.equal(trashed.body.book.state, BOOK_STATES.TRASH);
    assert.equal(typeof trashed.body.trash_expires_at, 'string');

    const activeShelf = await app.handleRequest(req('GET', '/api/co-reading/books', { token: 'web-token' }));
    assert.equal(activeShelf.body.books.some((book) => book.id === bookId), false);
    const fullShelf = await app.handleRequest(req('GET', '/api/co-reading/books?include_trash=true', { token: 'web-token' }));
    assert.equal(fullShelf.body.books.some((book) => book.id === bookId && book.state === BOOK_STATES.TRASH), true);
    assert.deepEqual(store.listEvents({ bookId }).map((event) => event.event_type).slice(-3), [
      'book_archived',
      'book_restored',
      'book_trashed',
    ]);
  });
});

test('co_reading Web translation skips cached untranslated English output', async () => {
  await withStore(async ({ root, store }) => {
    const source = 'Remus gave Sirius a look that was half exasperated, half amused, and turned back to the page.';
    const imported = await callTool(
      'reading_import_pasted_text',
      { owner_token: 'owner', title: 'Translation Guard Book', text: source },
      { rootDir: root, ownerToken: 'owner' }
    );
    const bookId = imported.structuredContent.book.id;
    const chunkId = imported.structuredContent.chunks[0].id;
    await store.saveTranslation({
      bookId,
      chunkId,
      targetLang: 'zh-CN',
      provider: 'hermes',
      sourceHash: hashText(source),
      text: source,
    });
    store.db.prepare('UPDATE reading_translations SET qa_validated_at = NULL WHERE chunk_id = ?').run(chunkId);
    const translationCalls = [];
    const app = createCoReadingWebApp({
      store,
      config: {
        accessToken: 'web-token',
        ownerToken: 'owner',
        rootDir: root,
      },
      fetchImpl: async (url, request) => {
        const body = JSON.parse(request.body);
        translationCalls.push({ url, body });
        const isJudge = /translation QA judge/i.test(body.messages?.[0]?.content || '');
        const content = isJudge
          ? (translationCalls.length === 1
            ? '{"valid":false,"reason":"candidate copies the English source"}'
            : '{"valid":true,"reason":"candidate is a direct translation"}')
          : '莱姆斯看了小天狼星一眼，半是恼火，半是好笑，然后又低头看书。';
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{ message: { content } }],
          }),
        };
      },
    });

    const translated = await app.handleRequest(req('GET', `/api/co-reading/books/${encodeURIComponent(bookId)}/chunks/${encodeURIComponent(chunkId)}/translation?target=zh-CN`, { token: 'web-token' }));
    assert.equal(translated.status, 200);
    assert.equal(translated.body.cached, false);
    assert.match(translated.body.translation.text, /莱姆斯/);
    assert.equal(translationCalls.length, 3);
    assert.match(translationCalls[0].body.messages[0].content, /translation QA judge/i);
    assert.doesNotMatch(translationCalls[1].body.messages[0].content, /translation QA judge/i);
    assert.match(translationCalls[2].body.messages[0].content, /translation QA judge/i);
  });
});

test('co_reading Web translation uses model judge to reject co-reading commentary and stores only translation text', async () => {
  await withStore(async ({ root, store }) => {
    const source = 'Remus looked at Sirius and lowered his voice. The corridor was quiet, but the old fear had not disappeared.';
    const imported = await callTool(
      'reading_import_pasted_text',
      { owner_token: 'owner', title: 'Commentary Translation', text: source },
      { rootDir: root, ownerToken: 'owner' }
    );
    const bookId = imported.structuredContent.book.id;
    const chunkId = imported.structuredContent.chunks[0].id;
    const calls = [];
    const app = createCoReadingWebApp({
      store,
      config: {
        accessToken: 'web-token',
        ownerToken: 'owner',
        rootDir: root,
        hermesBaseUrl: 'http://hermes.test/v1',
        hermesApiKey: 'api-key',
      },
      fetchImpl: async (url, options) => {
        const body = JSON.parse(options.body);
        calls.push(body);
        const isJudge = /translation QA judge/i.test(body.messages?.[0]?.content || '');
        const content = isJudge
          ? (calls.length === 2
            ? '{"valid":false,"reason":"candidate is a co-reading reaction, not a translation"}'
            : '{"valid":true,"reason":"candidate is a direct Simplified Chinese translation"}')
          : (calls.length === 1
            ? '臣读完了——这个改写太有趣了。Sirius全程暴躁，Remus咬着牙附和，俩人一起对Dumbledore的策略表示强烈不满，效果拉满。'
            : '莱姆斯看着小天狼星，压低了声音。走廊很安静，但旧日的恐惧并没有消失。');
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content } }] }),
        };
      },
    });

    const translated = await app.handleRequest(req('GET', `/api/co-reading/books/${encodeURIComponent(bookId)}/chunks/${encodeURIComponent(chunkId)}/translation?target=zh-CN`, { token: 'web-token' }));

    assert.equal(translated.status, 200);
    assert.equal(calls.length, 4);
    assert.doesNotMatch(calls[0].messages[0].content, /translation QA judge/i);
    assert.match(calls[1].messages[0].content, /translation QA judge/i);
    assert.doesNotMatch(calls[2].messages[0].content, /translation QA judge/i);
    assert.match(calls[3].messages[0].content, /translation QA judge/i);
    assert.match(calls[2].messages[0].content, /co-reading reaction, not a translation/);
    assert.match(translated.body.translation.text, /莱姆斯看着小天狼星/);
    assert.doesNotMatch(translated.body.translation.text, /臣读完了|改写太有趣了|效果拉满/);
  });
});

test('co_reading Web API imports uploaded HTML and PDF files without retaining browser payloads', async () => {
  await withStore(async ({ root, store }) => {
    const app = createCoReadingWebApp({
      store,
      config: {
        accessToken: 'web-token',
        ownerToken: 'server-owner-secret',
        rootDir: root,
      },
    });

    const html = Buffer.from('<!doctype html><title>HTML Book</title><article><h1>HTML Chapter</h1><p>Readable HTML body for co reading.</p></article>', 'utf8').toString('base64');
    const importedHtml = await app.handleRequest(req('POST', '/api/co-reading/import-file', {
      token: 'web-token',
      body: {
        filename: 'html-book.html',
        data_base64: html,
      },
    }));
    assert.equal(importedHtml.status, 200);
    assert.equal(importedHtml.body.book.format, 'html');
    assert.equal(importedHtml.body.book.source_kind, 'upload');
    assert.equal(importedHtml.body.book.original_retained, false);
    assert.match(importedHtml.body.chunks[0].title, /HTML/);

    const htmlChunk = await app.handleRequest(req('GET', `/api/co-reading/books/${encodeURIComponent(importedHtml.body.book.id)}/chunks/${encodeURIComponent(importedHtml.body.chunks[0].id)}`, { token: 'web-token' }));
    assert.match(htmlChunk.body.text, /Readable HTML body/);

    const pdfWithoutTextLayer = Buffer.from('%PDF-1.4\n1 0 obj <<>> endobj\n%%EOF', 'latin1').toString('base64');
    const importedPdf = await app.handleRequest(req('POST', '/api/co-reading/import-file', {
      token: 'web-token',
      body: {
        filename: 'scan.pdf',
        data_base64: pdfWithoutTextLayer,
      },
    }));
    assert.equal(importedPdf.status, 200);
    assert.equal(importedPdf.body.book.format, 'pdf');
    assert.equal(importedPdf.body.book.ocr_required, true);
    assert.equal(importedPdf.body.chunks.length, 0);
    assert.equal(importedPdf.body.import_summary.ocr_required, true);
    assert.equal(importedPdf.body.import_summary.chunk_count, 0);
  });
});

test('co_reading Web API imports normal URLs through search_hub and social URLs through social_reader', async () => {
  await withStore(async ({ root, store }) => {
    const searchHubCalls = [];
    const socialReaderCalls = [];
    const app = createCoReadingWebApp({
      store,
      config: {
        accessToken: 'web-token',
        ownerToken: 'server-owner-secret',
        rootDir: root,
      },
      searchHubReadImpl: async (args) => {
        searchHubCalls.push(args);
        return {
          item: {
            title: 'Search Hub Article',
            url: 'https://example.com/article',
            provider: 'tavily',
            source: 'example.com',
          },
          content: 'Search Hub extracted article text for the reading room.',
          warnings: [],
        };
      },
      socialReaderRequestImpl: async (request) => {
        socialReaderCalls.push(request);
        return {
          structuredContent: {
            ok: true,
            platform: 'bilibili',
            title: 'Social Reader Post',
            url: 'https://www.bilibili.com/video/BV123',
            post_text: 'Social reader extracted post text for co reading.',
            comments_text: 'comment one',
            warnings: [],
          },
        };
      },
    });

    const normal = await app.handleRequest(req('POST', '/api/co-reading/import-url', {
      token: 'web-token',
      body: {
        url: 'https://example.com/article?token=secret',
      },
    }));
    assert.equal(normal.status, 200);
    assert.equal(normal.body.book.format, 'url');
    assert.equal(normal.body.book.source_kind, 'url');
    assert.match(normal.body.chunks[0].title, /Search Hub/);
    assert.equal(searchHubCalls.length, 1);
    assert.equal(socialReaderCalls.length, 0);

    const social = await app.handleRequest(req('POST', '/api/co-reading/import-url', {
      token: 'web-token',
      body: {
        url: 'https://www.bilibili.com/video/BV123',
      },
    }));
    assert.equal(social.status, 200);
    assert.equal(social.body.book.format, 'social');
    assert.equal(social.body.book.source_kind, 'url');
    assert.equal(searchHubCalls.length, 1);
    assert.equal(socialReaderCalls.length, 1);
    assert.equal(socialReaderCalls[0].params.name, 'read_social_post');
    assert.match(JSON.stringify(social.body), /Social Reader Post/);
  });
});

test('co_reading Web ask-Hermes route only accepts shared annotations and stores replies in reading_threads', async () => {
  await withStore(async ({ root, store }) => {
    const farContext = `FULL_CHUNK_SHOULD_NOT_BE_SENT ${'远处正文'.repeat(160)}`;
    const targetContext = '目标上下文之前。这一段可以问 Hermes。目标上下文之后。';
    const imported = await callTool(
      'reading_import_pasted_text',
      { owner_token: 'owner', title: 'Hermes Ask Book', text: `${farContext}\n\n${targetContext}` },
      { rootDir: root, ownerToken: 'owner' }
    );
    const bookId = imported.structuredContent.book.id;
    const chunkId = imported.structuredContent.chunks[0].id;
    const privateAnn = store.addAnnotation({
      bookId,
      chunkId,
      quote: '共读正文',
      note: 'private-not-for-hermes',
      visibility: 'private',
    });
    const sharedAnn = store.addAnnotation({
      bookId,
      chunkId,
      quote: '这一段',
      note: 'shared-question-context',
      visibility: 'shared',
      anchorKind: 'translation',
      anchorLang: 'zh-CN',
    });

    const hermesBodies = [];
    const app = createCoReadingWebApp({
      store,
      config: {
        accessToken: 'web-token',
        ownerToken: 'owner',
        rootDir: root,
        hermesBaseUrl: 'http://hermes.test/v1',
        hermesApiKey: 'api-key',
        askContextChars: 120,
        vaultDir: path.join(root, 'vault'),
      },
      fetchImpl: async (url, options) => {
        hermesBodies.push({ url, body: String(options.body || '') });
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{ message: { content: 'Hermes reply saved.' } }],
          }),
        };
      },
    });

    const denied = await app.handleRequest(req('POST', `/api/co-reading/annotations/${encodeURIComponent(privateAnn.id)}/ask-hermes`, {
      token: 'web-token',
      body: { question: '能解释吗？' },
    }));
    assert.equal(denied.status, 403);
    assert.equal(hermesBodies.length, 0);

    const asked = await app.handleRequest(req('POST', `/api/co-reading/annotations/${encodeURIComponent(sharedAnn.id)}/ask-hermes`, {
      token: 'web-token',
      body: { question: '请回应这段。', recordUserQuestion: true },
    }));
    assert.equal(asked.status, 200);
    assert.equal(asked.body.user_reply.author, 'user');
    assert.equal(asked.body.user_reply.text, '请回应这段。');
    assert.equal(asked.body.reply.author, 'hermes');
    assert.equal(asked.body.reply.text, 'Hermes reply saved.');
    assert.equal(hermesBodies.length, 1);
    assert.match(hermesBodies[0].body, /shared-question-context/);
    assert.match(hermesBodies[0].body, /Annotation anchor: translation \(zh-CN\)/);
    assert.match(hermesBodies[0].body, /目标上下文之前/);
    assert.doesNotMatch(hermesBodies[0].body, /FULL_CHUNK_SHOULD_NOT_BE_SENT/);
    assert.doesNotMatch(hermesBodies[0].body, /private-not-for-hermes/);

    const thread = store.readThread(sharedAnn.id);
    assert.equal(thread.replies.length, 2);
    assert.equal(thread.replies[0].author, 'user');
    assert.equal(thread.replies[0].text, '请回应这段。');
    assert.equal(thread.replies[1].author, 'hermes');
    assert.equal(thread.replies[1].text, 'Hermes reply saved.');

    const privateDeposit = await app.handleRequest(req('POST', `/api/co-reading/annotations/${encodeURIComponent(privateAnn.id)}/deposit-vault`, {
      token: 'web-token',
      body: {},
    }));
    assert.equal(privateDeposit.status, 403);

    const deposited = await app.handleRequest(req('POST', `/api/co-reading/annotations/${encodeURIComponent(sharedAnn.id)}/deposit-vault`, {
      token: 'web-token',
      body: {},
    }));
    assert.equal(deposited.status, 200);
    assert.match(deposited.body.deposited.vault_relative_path, /^inbox\/co_reading\//);
    assert.doesNotMatch(path.basename(deposited.body.deposited.vault_relative_path), /^\d{4}-\d{2}-\d{2}-/);
    assert.equal(deposited.body.deposited.path, undefined);
    const vaultText = await readFile(path.join(root, 'vault', deposited.body.deposited.vault_relative_path), 'utf8');
    assert.match(vaultText, /shared-question-context/);
    assert.match(vaultText, /Hermes reply saved/);
    assert.doesNotMatch(vaultText, /private-not-for-hermes/);

    store.replyToAnnotation({ annotationId: sharedAnn.id, text: 'Second Hermes reply.', author: 'hermes', actor: 'hermes' });
    const depositedAgain = await app.handleRequest(req('POST', `/api/co-reading/annotations/${encodeURIComponent(sharedAnn.id)}/deposit-vault`, {
      token: 'web-token',
      body: {},
    }));
    assert.equal(depositedAgain.status, 200);
    assert.equal(depositedAgain.body.deposited.vault_relative_path, deposited.body.deposited.vault_relative_path);
    const updatedVaultText = await readFile(path.join(root, 'vault', depositedAgain.body.deposited.vault_relative_path), 'utf8');
    assert.match(updatedVaultText, /Second Hermes reply/);
  });
});

test('co_reading Web ask-Hermes unwraps a JSON reply envelope instead of storing raw JSON', async () => {
  await withStore(async ({ root, store }) => {
    const imported = await callTool(
      'reading_import_pasted_text',
      { owner_token: 'owner', title: 'Envelope Book', text: '信封测试正文。' },
      { rootDir: root, ownerToken: 'owner' }
    );
    const bookId = imported.structuredContent.book.id;
    const chunkId = imported.structuredContent.chunks[0].id;
    const sharedAnn = store.addAnnotation({
      bookId,
      chunkId,
      quote: '信封测试',
      note: 'shared-note',
      visibility: 'shared',
    });

    const app = createCoReadingWebApp({
      store,
      config: {
        accessToken: 'web-token',
        ownerToken: 'owner',
        rootDir: root,
        hermesBaseUrl: 'http://hermes.test/v1',
      },
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: '{"reply":"哈哈，这句戳中我了。真正的共读回应。"}' } }],
        }),
      }),
    });

    const asked = await app.handleRequest(req('POST', `/api/co-reading/annotations/${encodeURIComponent(sharedAnn.id)}/ask-hermes`, {
      token: 'web-token',
      body: {},
    }));
    assert.equal(asked.status, 200);
    assert.equal(asked.body.reply.text, '哈哈，这句戳中我了。真正的共读回应。');
    const thread = store.readThread(sharedAnn.id);
    assert.equal(thread.replies.length, 1);
    assert.equal(thread.replies[0].text, '哈哈，这句戳中我了。真正的共读回应。');
  });
});

test('co_reading Web translation unwraps a JSON translation envelope before judging and saving', async () => {
  await withStore(async ({ root, store }) => {
    const imported = await callTool(
      'reading_import_pasted_text',
      { owner_token: 'owner', title: 'Envelope Translation Book', text: 'The boy who lived under the stairs.' },
      { rootDir: root, ownerToken: 'owner' }
    );
    const bookId = imported.structuredContent.book.id;
    const chunkId = imported.structuredContent.chunks[0].id;

    const app = createCoReadingWebApp({
      store,
      config: {
        accessToken: 'web-token',
        ownerToken: 'owner',
        rootDir: root,
        hermesBaseUrl: 'http://hermes.test/v1',
      },
      fetchImpl: async (url, request) => {
        const body = JSON.parse(request.body);
        const isJudge = /translation QA judge/i.test(body.messages?.[0]?.content || '');
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{ message: { content: isJudge ? '{"valid":true,"reason":"direct translation"}' : '{"translation":"住在楼梯下的那个男孩。"}' } }],
          }),
        };
      },
    });

    const translated = await app.handleRequest(req('GET', `/api/co-reading/books/${encodeURIComponent(bookId)}/chunks/${encodeURIComponent(chunkId)}/translation?target=zh-CN`, { token: 'web-token' }));
    assert.equal(translated.status, 200);
    assert.equal(translated.body.cached, false);
    assert.equal(translated.body.translation.text, '住在楼梯下的那个男孩。');

    const cached = await app.handleRequest(req('GET', `/api/co-reading/books/${encodeURIComponent(bookId)}/chunks/${encodeURIComponent(chunkId)}/translation?target=zh-CN`, { token: 'web-token' }));
    assert.equal(cached.status, 200);
    assert.equal(cached.body.cached, true);
    assert.equal(cached.body.translation.text, '住在楼梯下的那个男孩。');
  });
});

test('co_reading Web config supports Tailscale host env without reusing Bilibili SOCKS proxy', () => {
  const config = getCoReadingWebConfig({
    CO_READING_WEB_ENABLED: 'true',
    CO_READING_WEB_HOST: '100.64.0.12',
    CO_READING_WEB_PORT: '8787',
    CO_READING_WEB_ACCESS_TOKEN: 'web-token',
    CO_READING_OWNER_TOKEN: 'owner-token',
    PERSONAL_AGENT_YTDLP_PROXY: 'socks5h://127.0.0.1:10808',
  });

  assert.equal(config.enabled, true);
  assert.equal(config.host, '100.64.0.12');
  assert.equal(config.port, 8787);
  assert.equal(config.accessToken, 'web-token');
  assert.equal(config.ownerToken, 'owner-token');
  assert.equal(config.ytdlpProxy, undefined);
});

/* ========================================================================
   Web frontend regression harness: a dependency-free DOM stub that runs
   the real public/co-reading/app.js inside a vm context. Assertions are
   made on observable effects (DOM stub state, fetch log, storage), never
   on app.js internals. Added for the reader-redesign review: token
   boundaries, selection anchoring, touch recovery, single-flight save,
   overlay stack, keyboard boundaries.
   ======================================================================== */

import vm from 'node:vm';

const FE_APP_PATH = path.join(REPO_ROOT, 'node_bridge/public/co-reading/app.js');
const FE_INDEX_PATH = path.join(REPO_ROOT, 'node_bridge/public/co-reading/index.html');
const FE_CSS_PATH = path.join(REPO_ROOT, 'node_bridge/public/co-reading/style.css');
const FE_APP_SOURCE = await readFile(FE_APP_PATH, 'utf8');

const FE_CHUNK1 = 'Alpha first paragraph.\n\nBeta second paragraph here.';
const FE_CHUNK2 = 'Gamma third paragraph.';
const FE_CHUNK3 = 'The lighthouse keeper counted the hours by the beam.\n\nDawn came slowly over the headland.';
const FE_TRANS1 = '第一段翻译。\n\n第二段翻译文本。';
const FE_TRANS2 = '译二一。\n\n译二二。\n\n译二三。\n\n译二二。';
const FE_TRANS3 = '守塔人借着光束数着时间。\n\n黎明缓缓越过海角。';

const feSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Deterministic microtask flush — settles gated promise chains after a gate
// opens, without relying on wall-clock sleeps.
async function feFlush(rounds = 50) {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

function feGate() {
  let open;
  const promise = new Promise((resolve) => { open = resolve; });
  return { promise, open };
}

function createFeStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
    clear: () => map.clear(),
    _map: map,
  };
}

class FeTextNode {
  constructor(text) {
    this.nodeType = 3;
    this._text = String(text);
    this.parentElement = null;
  }

  get textContent() {
    return this._text;
  }
}

function feMatchesSelector(el, selector) {
  return selector.split(',').some((raw) => {
    const part = raw.trim();
    if (!part) return false;
    if (part.startsWith('.')) {
      const classes = part.split('.').filter(Boolean);
      return classes.every((cls) => el.classList?.contains(cls));
    }
    if (part.startsWith('#')) return el.id === part.slice(1);
    const attr = part.match(/^\[([^\]="]+)(?:="([^"]*)")?\]$/);
    if (attr) {
      const value = el.getAttribute?.(attr[1]);
      if (attr[2] === undefined) return value !== null && value !== undefined;
      return value === attr[2];
    }
    return el.tagName === part.toUpperCase();
  });
}

function feFindAllIn(el, selector, out = []) {
  for (const child of el.children || []) {
    if (child.nodeType === 1 && feMatchesSelector(child, selector)) out.push(child);
    feFindAllIn(child, selector, out);
  }
  return out;
}

class FeElement {
  constructor(tag = 'div', doc = null) {
    this.tagName = String(tag).toUpperCase();
    this.nodeType = 1;
    this.children = [];
    this.parentElement = null;
    this._text = '';
    this._innerHTML = '';
    this._listeners = {};
    this._qs = null;
    this._qsa = null;
    this._doc = doc;
    this._classes = new Set();
    this.dataset = {};
    this.attributes = {};
    this.style = { setProperty: (key, value) => { this.style[key] = value; } };
    this.id = '';
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.title = '';
    this.tabIndex = 0;
    this.offsetWidth = 120;
    this.offsetHeight = 40;
    this.offsetParent = {};
    this.onclick = null;
    this.classList = {
      add: (...cls) => cls.forEach((c) => this._classes.add(c)),
      remove: (...cls) => cls.forEach((c) => this._classes.delete(c)),
      toggle: (cls, force) => {
        const on = force === undefined ? !this._classes.has(cls) : Boolean(force);
        if (on) this._classes.add(cls);
        else this._classes.delete(cls);
        return on;
      },
      contains: (cls) => this._classes.has(cls),
    };
  }

  get className() {
    return [...this._classes].join(' ');
  }

  set className(value) {
    this._classes.clear();
    String(value).split(/\s+/).filter(Boolean).forEach((cls) => this._classes.add(cls));
  }

  get textContent() {
    if (this.children.length) return this.children.map((child) => child.textContent).join('');
    return this._text;
  }

  set textContent(value) {
    for (const child of this.children) child.parentElement = null;
    this.children = [];
    this._text = String(value);
  }

  get innerHTML() {
    return this._innerHTML;
  }

  set innerHTML(value) {
    for (const child of this.children) child.parentElement = null;
    this.children = [];
    this._innerHTML = String(value);
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  append(...nodes) {
    nodes.forEach((node) => this.appendChild(node));
  }

  setAttribute(key, value) {
    this.attributes[key] = String(value);
  }

  getAttribute(key) {
    return key in this.attributes ? this.attributes[key] : null;
  }

  removeAttribute(key) {
    delete this.attributes[key];
  }

  addEventListener(type, fn) {
    (this._listeners[type] ||= []).push(fn);
  }

  removeEventListener(type, fn) {
    this._listeners[type] = (this._listeners[type] || []).filter((fn2) => fn2 !== fn);
  }

  dispatch(type, event = {}) {
    if (!event.type) event.type = type;
    if (!event.target) event.target = this;
    (this._listeners[type] || []).slice().forEach((fn) => fn(event));
  }

  click() {
    this.onclick?.({ target: this, stopPropagation() {}, preventDefault() {} });
    this.dispatch('click', { target: this });
  }

  focus() {
    if (this._doc) {
      let blocked = false;
      let current = this;
      while (current) {
        if (current.inert) {
          blocked = true;
          break;
        }
        current = current.parentElement;
      }
      this._doc._focusLog.push({ id: this.id, blocked });
      this._doc.activeElement = this;
    }
  }

  contains(node) {
    let current = node;
    while (current) {
      if (current === this) return true;
      current = current.parentElement;
    }
    return false;
  }

  closest(selector) {
    let current = this;
    while (current) {
      if (current.nodeType === 1 && feMatchesSelector(current, selector)) return current;
      current = current.parentElement;
    }
    return null;
  }

  querySelector(selector) {
    const found = feFindAllIn(this, selector)[0];
    if (found) return found;
    if (!this._qs) this._qs = {};
    if (!this._qs[selector]) this._qs[selector] = new FeElement('div', this._doc);
    return this._qs[selector];
  }

  querySelectorAll(selector) {
    if (this._qsa && selector in this._qsa) return this._qsa[selector];
    return feFindAllIn(this, selector);
  }

  getBoundingClientRect() {
    return { left: 100, top: 100, right: 220, bottom: 118, width: 120, height: 18 };
  }

  scrollIntoView() {}
}

class FeDocument {
  constructor() {
    this._elements = new Map();
    this._qsa = {};
    this._listeners = {};
    this._focusLog = [];
    this.activeElement = null;
    this.body = new FeElement('body', this);
    this.documentElement = new FeElement('html', this);
  }

  getElementById(id) {
    if (!this._elements.has(id)) {
      const el = new FeElement('div', this);
      el.id = id;
      this._elements.set(id, el);
    }
    return this._elements.get(id);
  }

  createElement(tag) {
    return new FeElement(tag, this);
  }

  createTextNode(text) {
    return new FeTextNode(text);
  }

  querySelectorAll(selector) {
    return this._qsa[selector] || [];
  }

  querySelector() {
    return null;
  }

  closest() {
    return null;
  }

  contains(node) {
    let current = node;
    while (current) {
      if (current === this.body || current === this.documentElement) return true;
      current = current.parentElement;
    }
    return false;
  }

  addEventListener(type, fn) {
    (this._listeners[type] ||= []).push(fn);
  }

  removeEventListener(type, fn) {
    this._listeners[type] = (this._listeners[type] || []).filter((fn2) => fn2 !== fn);
  }

  dispatch(type, event = {}) {
    if (!event.type) event.type = type;
    if (!event.target) event.target = this.body;
    (this._listeners[type] || []).slice().forEach((fn) => fn(event));
  }
}

async function feRoute(h, url, options = {}) {
  const method = options.method || 'GET';
  const body = options.body ? JSON.parse(options.body) : null;
  h.fetchLog.push({ method, url, body });
  const json = (payload, status = 200) => ({ status, ok: status < 400, json: async () => payload });
  if (h.flags.unauthorized) return json({ ok: false, error: 'unauthorized' }, 401);
  if (method === 'GET' && url.includes('/books?include_trash=true')) {
    if (h.flags.holdBooks) await h.gates.books.promise;
    return json({ ok: true, books: [{ id: 'b1', title: '测试书', author: '作者', state: 'active', format: 'text' }] });
  }
  if (method === 'GET' && url.endsWith('/books/b1/chunks')) {
    if (h.flags.holdChunkList) await h.gates.chunkList.promise;
    return json({
      ok: true,
      chunks: [
        { id: 'c1', title: '第一章', char_count: FE_CHUNK1.length },
        { id: 'c2', title: '第二章', char_count: FE_CHUNK2.length },
        { id: 'c3', title: '第三章', char_count: FE_CHUNK3.length },
      ],
    });
  }
  if (method === 'GET' && url.includes('/books/b1/progress?device_id')) {
    return json({ ok: true, progress: { chunk_id: 'c1' } });
  }
  if (method === 'GET' && url.includes('/chunks/c1/translation')) {
    if (h.flags.holdTranslation) await h.gates.translation.promise;
    return json({ ok: true, translation: { text: FE_TRANS1 }, cached: false });
  }
  if (method === 'GET' && url.includes('/chunks/c2/translation')) {
    return json({ ok: true, translation: { text: FE_TRANS2 }, cached: false });
  }
  if (method === 'GET' && url.includes('/chunks/c3/translation')) {
    return json({ ok: true, translation: { text: FE_TRANS3 }, cached: false });
  }
  const chunkMatch = url.match(/\/books\/b1\/chunks\/(c\d)$/);
  if (method === 'GET' && chunkMatch) {
    const cid = chunkMatch[1];
    if (h.flags.holdChunks.has(cid)) await h.gates.chunk[cid].promise;
    if (h.flags.failChunks.has(cid)) return json({ ok: false, error: 'chunk failed' }, 500);
    const texts = { c1: FE_CHUNK1, c2: FE_CHUNK2, c3: FE_CHUNK3 };
    const titles = { c1: '第一章', c2: '第二章', c3: '第三章' };
    const annotations = {
      c1: [],
      c2: [{ id: 'a-c2', note: 'c2 既有批注', quote: 'Gamma', quote_offset: 0, anchor_kind: 'original', anchor_lang: 'source', visibility: 'private', created_at: '2026-07-18T00:00:00Z', replies: [] }],
      c3: [],
    };
    return json({ ok: true, text: texts[cid], chunk: { id: cid, title: titles[cid], char_count: texts[cid].length }, annotations: annotations[cid] });
  }
  if (method === 'POST' && url.endsWith('/books/b1/progress')) {
    // Mock server: receiving and completing are separate events so tests can
    // prove the server-visible commit order of progress mutations.
    h.progressServer.push({ event: 'received', chunkId: body?.chunk_id });
    if (body?.chunk_id && h.flags.holdProgressFor.has(body.chunk_id)) {
      await Promise.race([
        h.gates.progress[body.chunk_id].promise,
        options.signal ? new Promise((resolve) => options.signal._listeners.push(resolve)) : new Promise(() => {}),
      ]);
      if (options.signal?.aborted) {
        h.progressServer.push({ event: 'client-aborted', chunkId: body.chunk_id });
        const error = new Error('The operation was aborted');
        error.name = 'AbortError';
        throw error;
      }
    }
    h.progressServer.push({ event: 'completed', chunkId: body?.chunk_id });
    if (body?.chunk_id && h.flags.failProgressFor.has(body.chunk_id)) return json({ ok: false, error: 'progress failed' }, 500);
    return json({ ok: true });
  }
  if (method === 'POST' && url.endsWith('/books/b1/annotations')) {
    if (h.flags.holdAnnotation) await h.gates.annotation.promise;
    if (h.flags.failAnnotations) return json({ ok: false, error: 'save failed' }, 500);
    return json({ ok: true, annotation: { id: `a${h.fetchLog.length}`, visibility: body?.visibility || 'private' } });
  }
  if (method === 'POST' && url.includes('ask-hermes')) {
    if (h.flags.failHermes) return json({ ok: false, error: 'hermes down' }, 500);
    return json({ ok: true, hermes_reply: { id: 'h1' } });
  }
  if (method === 'POST' && url.includes('deposit-vault')) {
    return json({ ok: true, deposited: { vault_relative_path: 'inbox/a1.md' } });
  }
  return json({ ok: false, error: `unrouted ${method} ${url}` }, 404);
}

async function createFrontendHarness({ token = 'web-token' } = {}) {
  const documentStub = new FeDocument();
  const session = createFeStorage();
  const local = createFeStorage();
  if (token) session.setItem('CO_READING_WEB_ACCESS_TOKEN', token);
  const h = {
    document: documentStub,
    session,
    local,
    fetchLog: [],
    progressServer: [],
    flags: {
      unauthorized: false,
      holdTranslation: false,
      failAnnotations: false,
      failHermes: false,
      holdAnnotation: false,
      holdBooks: false,
      holdChunks: new Set(),
      failChunks: new Set(),
      holdProgressFor: new Set(),
      holdChunkList: false,
      failProgressFor: new Set(),
    },
    gates: {
      translation: feGate(),
      annotation: feGate(),
      books: feGate(),
      chunk: { c1: feGate(), c2: feGate(), c3: feGate() },
      progress: { c1: feGate(), c2: feGate(), c3: feGate() },
      chunkList: feGate(),
    },
    selectionBox: { current: null },
  };
  const fetchStub = (url, options) => feRoute(h, url, options);
  const windowStub = {
    matchMedia: () => ({ matches: false }),
    getSelection: () => h.selectionBox.current,
    innerWidth: 1280,
    innerHeight: 800,
    visualViewport: { height: 800 },
    addEventListener() {},
    removeEventListener() {},
  };

  const tabReader = new FeElement('button', documentStub);
  tabReader.dataset.view = 'reader';
  const tabAnnotations = new FeElement('button', documentStub);
  tabAnnotations.dataset.view = 'annotations';
  documentStub._qsa['.mobile-tabs button'] = [new FeElement('button', documentStub), tabReader, tabAnnotations];

  const visPrivate = new FeElement('button', documentStub);
  visPrivate.dataset.visibility = 'private';
  const visShared = new FeElement('button', documentStub);
  visShared.dataset.visibility = 'shared';
  documentStub._qsa['.composer-visibility button'] = [visPrivate, visShared];

  documentStub._qsa['.settings-mode'] = ['original', 'bilingual', 'translation'].map((mode) => {
    const el = new FeElement('button', documentStub);
    el.dataset.textMode = mode;
    return el;
  });
  documentStub._qsa['.filter-button'] = ['active', 'archived', 'trash'].map((filter) => {
    const el = new FeElement('button', documentStub);
    el.dataset.filter = filter;
    return el;
  });
  documentStub._qsa['[data-drawer-tab]'] = ['shelf', 'toc'].map((tab) => {
    const el = new FeElement('button', documentStub);
    el.dataset.drawerTab = tab;
    return el;
  });
  documentStub._qsa['[data-import-tab]'] = ['paste', 'file', 'url'].map((tab) => {
    const el = new FeElement('button', documentStub);
    el.dataset.importTab = tab;
    return el;
  });
  documentStub._qsa['[data-import-panel]'] = ['paste', 'file', 'url'].map((panel) => {
    const el = new FeElement('section', documentStub);
    el.dataset.importPanel = panel;
    return el;
  });

  for (const id of ['import-modal', 'auth-modal', 'nav-drawer', 'drawer-scrim', 'settings-popover', 'search-bar', 'selection-toolbar', 'clear-token', 'expand-quote']) {
    documentStub.getElementById(id).hidden = true;
  }
  documentStub.getElementById('annotation-composer').classList.add('hidden');
  // Give the document a realistic top-level structure so inert/aria-hidden
  // background guarding has real body children to work on.
  for (const id of ['co-reading-reader', 'nav-drawer', 'drawer-scrim', 'selection-toolbar', 'import-modal', 'auth-modal']) {
    documentStub.body.appendChild(documentStub.getElementById(id));
  }
  const topbar = new FeElement('header', documentStub);
  documentStub.body.appendChild(topbar);
  topbar.appendChild(documentStub.getElementById('app-status'));
  topbar.appendChild(documentStub.getElementById('toggle-drawer'));
  documentStub.getElementById('nav-drawer').appendChild(documentStub.getElementById('open-import'));

  const sandbox = {
    document: documentStub,
    window: windowStub,
    sessionStorage: session,
    localStorage: local,
    fetch: fetchStub,
    console,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (fn) => fn(),
    Node: { ELEMENT_NODE: 1 },
    HTMLElement: class {},
    AbortController: class {
      constructor() {
        this.signal = { aborted: false, _listeners: [] };
      }

      abort() {
        this.signal.aborted = true;
        this.signal._listeners.splice(0).forEach((fn) => fn());
      }
    },
  };
  h.context = vm.createContext(sandbox);
  vm.runInContext(FE_APP_SOURCE, h.context, { filename: 'app.js' });
  await feSleep(10);
  h.$ = (id) => documentStub.getElementById(id);
  return h;
}

async function feOpenBook(h) {
  await h.context.openBook('b1');
  await feSleep(10);
}

function fePreparePara(para) {
  if (!para._feText) para._feText = para.textContent;
  para.children = [];
  const node = new FeTextNode(para._feText);
  para.appendChild(node);
  return node;
}

function feParagraph(h, blockIndex, kind) {
  const block = h.document.getElementById('chunk-text').children[blockIndex];
  return kind === 'translation' ? block.children[1] : block.children[0];
}

function feMakeRange(h, { startNode, startOffset, endNode, endOffset, ancestor }) {
  return {
    startContainer: startNode,
    startOffset,
    endContainer: endNode,
    endOffset,
    commonAncestorContainer: ancestor || startNode,
    getBoundingClientRect: () => ({ left: 100, top: 100, right: 220, bottom: 118, width: 120, height: 18 }),
    cloneRange() {
      let container = null;
      let endN = null;
      let endO = 0;
      return {
        selectNodeContents(el) { container = el; },
        setEnd(node, offset) { endN = node; endO = offset; },
        toString() {
          const full = container.textContent;
          let upto = endO;
          if (endN && endN.nodeType === 3) {
            let base = 0;
            for (const child of container.children) {
              if (child === endN) break;
              base += child.textContent.length;
            }
            upto = base + endO;
          }
          return full.slice(0, upto);
        },
      };
    },
  };
}

function feSelect(h, { para, start, end, text }) {
  const node = fePreparePara(para);
  const range = feMakeRange(h, { startNode: node, startOffset: start, endNode: node, endOffset: end });
  h.selectionBox.current = {
    rangeCount: 1,
    isCollapsed: false,
    anchorNode: node,
    toString: () => text,
    getRangeAt: () => range,
    removeAllRanges() { h.selectionBox.current = null; },
  };
  return range;
}

function feSelectAcross(h, startPara, endPara, text) {
  const startNode = fePreparePara(startPara);
  const endNode = fePreparePara(endPara);
  const range = feMakeRange(h, {
    startNode,
    startOffset: 0,
    endNode,
    endOffset: endNode.textContent.length,
    ancestor: h.document.getElementById('chunk-text'),
  });
  h.selectionBox.current = {
    rangeCount: 1,
    isCollapsed: false,
    anchorNode: startNode,
    toString: () => text,
    getRangeAt: () => range,
    removeAllRanges() { h.selectionBox.current = null; },
  };
  return range;
}

const feCount = (h, method, needle) => h.fetchLog.filter((entry) => entry.method === method && entry.url.includes(needle)).length;
const feCountEnd = (h, method, suffix) => h.fetchLog.filter((entry) => entry.method === method && entry.url.endsWith(suffix)).length;
const feLast = (h, method, needle) => h.fetchLog.filter((entry) => entry.method === method && entry.url.includes(needle)).at(-1);

test('co_reading Web frontend: auth modal never refills, leaks or silently drops the access token', async () => {
  const h = await createFrontendHarness({ token: 'existing-web-token' });
  const $ = h.$;

  h.context.openAuthModal();
  assert.equal($('access-token').value, '', 'password field must stay empty when the modal opens');
  assert.equal($('clear-token').hidden, false, 'clear action visible while a token is saved');
  h.context.closeAuthModal();
  assert.equal(h.session.getItem('CO_READING_WEB_ACCESS_TOKEN'), 'existing-web-token', 'cancelling keeps the saved token');

  h.context.openAuthModal();
  $('access-token').value = 'replacement-web-token';
  $('save-token').click();
  await feSleep(10);
  assert.equal(h.session.getItem('CO_READING_WEB_ACCESS_TOKEN'), 'replacement-web-token');
  assert.equal($('access-token').value, '', 'input cleared right after a successful save');
  assert.equal($('auth-modal').hidden, true);

  for (const [key, value] of h.local._map) {
    assert.ok(!String(value).includes('replacement-web-token'), `localStorage ${key} must not hold the token`);
  }
  for (const el of h.document._elements.values()) {
    assert.ok(!JSON.stringify(el.attributes).includes('replacement-web-token'), `#${el.id} attributes must not hold the token`);
    assert.ok(!JSON.stringify(el.dataset).includes('replacement-web-token'), `#${el.id} dataset must not hold the token`);
    assert.ok(!String(el._innerHTML || '').includes('replacement-web-token'), `#${el.id} innerHTML must not hold the token`);
  }

  h.context.openAuthModal();
  $('access-token').value = '   ';
  $('save-token').click();
  await feSleep(10);
  assert.equal(h.session.getItem('CO_READING_WEB_ACCESS_TOKEN'), 'replacement-web-token', 'blank input must not overwrite the token');
  assert.equal($('app-status-text').textContent, '请输入访问口令');
  assert.equal($('auth-modal').hidden, false, 'modal stays open on validation error');

  $('clear-token').click();
  assert.equal(h.session.getItem('CO_READING_WEB_ACCESS_TOKEN'), null, 'clear action only drops the session token');
  assert.equal($('access-token').value, '');
  assert.equal($('clear-token').hidden, true);
  assert.equal($('app-status-text').textContent, '未连接');
});

test('co_reading Web frontend: 401 opens the auth modal without exposing or deleting the old token', async () => {
  const h = await createFrontendHarness({ token: 'stale-web-token' });
  const $ = h.$;
  h.flags.unauthorized = true;
  await h.context.refreshBooks().catch(() => {});
  await feSleep(5);
  assert.equal($('auth-modal').hidden, false, '401 reopens the auth modal');
  assert.equal($('access-token').value, '', 'no old token refilled after 401');
  assert.ok($('auth-hint').textContent.length > 0);
  assert.ok(!$('auth-hint').textContent.includes('stale-web-token'), 'hint must not embed the token');
  assert.ok(!$('app-status-text').textContent.includes('stale-web-token'), 'status must not embed the token');
  assert.equal(h.session.getItem('CO_READING_WEB_ACCESS_TOKEN'), 'stale-web-token', 'old token kept until the user replaces or clears it');
});

test('co_reading Web frontend: selection capture anchors exact offsets and rejects mixed selections', async () => {
  const h = await createFrontendHarness();
  await feOpenBook(h);
  const $ = h.$;

  feSelect(h, { para: feParagraph(h, 0, 'original'), start: 6, end: 21, text: 'first paragraph' });
  h.context.captureSelection();
  assert.equal($('selection-toolbar').hidden, false, 'same-paragraph original selection shows the toolbar');
  h.context.openComposer('private');
  assert.equal($('annotation-quote-preview').textContent, 'first paragraph');
  await h.context.saveAnnotation('private');
  let post = feLast(h, 'POST', '/books/b1/annotations');
  assert.equal(post.body.quote, 'first paragraph');
  assert.equal(post.body.quote_offset, 6, 'offset comes from the real range, not indexOf');
  assert.equal(post.body.anchor_kind, 'original');
  assert.equal(post.body.anchor_lang, 'source');
  assert.equal(feCount(h, 'POST', 'ask-hermes'), 0, 'private annotations never call Hermes');

  feSelect(h, { para: feParagraph(h, 0, 'translation'), start: 1, end: 3, text: '一段' });
  h.context.captureSelection();
  assert.equal($('selection-toolbar').hidden, false, 'same-paragraph translation selection shows the toolbar');
  h.context.openComposer('shared');
  await h.context.saveAnnotation('shared');
  post = feLast(h, 'POST', '/books/b1/annotations');
  assert.equal(post.body.quote, '一段');
  assert.equal(post.body.quote_offset, 1);
  assert.equal(post.body.anchor_kind, 'translation');
  assert.equal(post.body.anchor_lang, 'zh-CN');
  assert.equal(feCount(h, 'POST', 'ask-hermes'), 1, 'shared save invites Hermes exactly once');

  const mixed = [
    ['original', 'translation'],
    ['translation', 'original'],
  ];
  for (const [startKind, endKind] of mixed) {
    feSelectAcross(h, feParagraph(h, 0, startKind), feParagraph(h, 0, endKind), 'mixed selection text');
    h.context.captureSelection();
    assert.equal($('selection-toolbar').hidden, true, `${startKind}→${endKind} selection must be refused`);
  }
  feSelectAcross(h, feParagraph(h, 0, 'original'), feParagraph(h, 1, 'original'), 'cross paragraph text');
  h.context.captureSelection();
  assert.equal($('selection-toolbar').hidden, true, 'cross-paragraph original selection must be refused');
  feSelectAcross(h, feParagraph(h, 0, 'translation'), feParagraph(h, 1, 'translation'), 'cross block text');
  h.context.captureSelection();
  assert.equal($('selection-toolbar').hidden, true, 'cross-block translation selection must be refused');
});

test('co_reading Web frontend: translation loading/error placeholders cannot be annotated', async () => {
  const h = await createFrontendHarness();
  h.flags.holdTranslation = true;
  await feOpenBook(h);
  const placeholder = feParagraph(h, 0, 'translation');
  assert.equal(placeholder.dataset.placeholder, 'true');
  feSelect(h, { para: placeholder, start: 0, end: 3, text: '翻译中' });
  h.context.captureSelection();
  assert.equal(h.$('selection-toolbar').hidden, true, 'placeholder selection must be refused');
  h.gates.translation.open();
  await feSleep(10);
});

test('co_reading Web frontend: whole-paragraph quote uses paragraph identity and expires after chunk switch', async () => {
  const h = await createFrontendHarness();
  await feOpenBook(h);

  feSelect(h, { para: feParagraph(h, 0, 'original'), start: 6, end: 21, text: 'first paragraph' });
  h.context.captureSelection();
  assert.equal(h.context.expandQuoteToParagraph(), true);
  await h.context.saveAnnotation('private');
  let post = feLast(h, 'POST', '/books/b1/annotations');
  assert.equal(post.body.quote, 'Alpha first paragraph.');
  assert.equal(post.body.quote_offset, 0, 'original paragraph offset comes from chunkText, not DOM text');
  assert.equal(post.body.anchor_kind, 'original');

  feSelect(h, { para: feParagraph(h, 0, 'translation'), start: 1, end: 3, text: '一段' });
  h.context.captureSelection();
  assert.equal(h.context.expandQuoteToParagraph(), true);
  await h.context.saveAnnotation('private');
  post = feLast(h, 'POST', '/books/b1/annotations');
  assert.equal(post.body.quote, '第一段翻译。');
  assert.equal(post.body.quote_offset, 0, 'translation paragraph offset comes from translationText');
  assert.equal(post.body.anchor_kind, 'translation');

  feSelect(h, { para: feParagraph(h, 0, 'original'), start: 0, end: 5, text: 'Alpha' });
  h.context.captureSelection();
  await h.context.openChunk('c2');
  await feSleep(10);
  assert.equal(h.context.expandQuoteToParagraph(), false, 'stale paragraph reference expires after chunk switch');
  h.$('select-paragraph').click();
  assert.ok(h.$('annotation-composer').classList.contains('hidden'), 'expired reference must not open the composer');
});

test('co_reading Web frontend: touchcancel resets gesture state and pending capture timers', async () => {
  const h = await createFrontendHarness();
  await feOpenBook(h);
  const $ = h.$;
  const chunkText = $('chunk-text');
  assert.equal((chunkText._listeners.touchstart || []).length, 1, 'touchstart bound exactly once');
  assert.equal((chunkText._listeners.touchend || []).length, 1, 'touchend bound exactly once');
  assert.equal((chunkText._listeners.touchcancel || []).length, 1, 'touchcancel bound exactly once');
  assert.equal((h.document._listeners.selectionchange || []).length, 1, 'selectionchange bound exactly once');
  const selectValid = () => feSelect(h, { para: feParagraph(h, 0, 'original'), start: 6, end: 21, text: 'first paragraph' });

  chunkText.dispatch('touchstart');
  selectValid();
  chunkText.dispatch('touchend');
  assert.equal($('selection-toolbar').hidden, true, 'toolbar stays hidden while the gesture settles');
  await feSleep(500);
  assert.equal($('selection-toolbar').hidden, false, 'toolbar appears after the selection settles');

  chunkText.dispatch('touchstart');
  selectValid();
  chunkText.dispatch('touchend');
  chunkText.dispatch('touchcancel');
  await feSleep(500);
  assert.equal($('selection-toolbar').hidden, true, 'touchcancel cancels the pending capture');

  chunkText.dispatch('mouseup');
  await feSleep(260);
  assert.equal($('selection-toolbar').hidden, false, 'selection works again after touchcancel (no lock)');

  chunkText.dispatch('touchstart');
  selectValid();
  chunkText.dispatch('touchend');
  await feSleep(100);
  chunkText.dispatch('touchstart');
  await feSleep(500);
  assert.equal($('selection-toolbar').hidden, true, 'capture must not fire in the middle of a new gesture');
  chunkText.dispatch('touchend');
  await feSleep(500);
  assert.equal($('selection-toolbar').hidden, false, 'settled second gesture captures normally');

  chunkText.dispatch('touchstart');
  selectValid();
  chunkText.dispatch('touchend');
  h.context.openImportModal();
  await feSleep(500);
  assert.equal($('selection-toolbar').hidden, true, 'pending capture is swallowed while a modal is open');
  h.context.closeImportModal();
});

test('co_reading Web frontend: annotation save is single-flight, failure-safe and chunk-switch safe', async () => {
  const h = await createFrontendHarness();
  await feOpenBook(h);
  const $ = h.$;
  const selectValid = () => {
    feSelect(h, { para: feParagraph(h, 0, 'original'), start: 6, end: 21, text: 'first paragraph' });
    h.context.captureSelection();
  };

  selectValid();
  h.context.openComposer('private');
  $('annotation-note').value = '第一条笔记';
  await Promise.all([h.context.saveAnnotation('private'), h.context.saveAnnotation('private')]);
  assert.equal(feCountEnd(h, 'POST', '/books/b1/annotations'), 1, 'double save issues exactly one request');
  assert.equal(feCount(h, 'POST', 'ask-hermes'), 0, 'private save never triggers Hermes');
  assert.equal(feCount(h, 'POST', 'deposit-vault'), 0, 'private save never touches Vault');
  assert.equal($('annotation-note').value, '', 'composer cleared after success');
  assert.ok($('annotation-composer').classList.contains('hidden'));

  selectValid();
  h.context.openComposer('shared');
  $('annotation-note').value = 'shared note';
  h.flags.failAnnotations = true;
  await assert.rejects(h.context.saveAnnotation('shared'), /save failed/);
  assert.equal($('save-annotation').disabled, false, 'save button restored after failure');
  assert.equal($('annotation-note').value, 'shared note', 'note preserved after failure');
  assert.equal($('save-annotation').textContent, '保存并邀请 Hermes', 'shared visibility preserved after failure');
  h.flags.failAnnotations = false;
  await h.context.saveAnnotation('shared');
  assert.equal(feCountEnd(h, 'POST', '/books/b1/annotations'), 3, 'log holds first private + failed attempt + one retry (no silent duplicates)');
  assert.equal(feCount(h, 'POST', 'ask-hermes'), 1, 'Hermes invited once for the retried shared save');

  selectValid();
  h.context.openComposer('shared');
  h.flags.failHermes = true;
  await assert.rejects(h.context.saveAnnotation('shared'), /Hermes/);
  assert.equal(feCountEnd(h, 'POST', '/books/b1/annotations'), 4, 'annotation saved even when Hermes fails');
  assert.equal(feCount(h, 'POST', 'ask-hermes'), 2, 'Hermes attempted exactly once for that annotation');
  h.flags.failHermes = false;

  selectValid();
  h.context.openComposer('private');
  h.flags.holdAnnotation = true;
  const inflight = h.context.saveAnnotation('private');
  await feSleep(5);
  assert.equal($('save-annotation').disabled, true, 'save locked while in flight');
  assert.ok(h.document._qsa['.composer-visibility button'].every((button) => button.disabled), 'visibility locked while in flight');
  await h.context.openChunk('c2');
  const c1Gets = feCountEnd(h, 'GET', '/books/b1/chunks/c1');
  h.gates.annotation.open();
  await inflight;
  await feSleep(5);
  assert.equal(feCountEnd(h, 'GET', '/books/b1/chunks/c1'), c1Gets, 'stale completion must not re-render the previous chunk');
});

test('co_reading Web frontend: Escape closes overlays in LIFO order and Tab stays trapped in the top modal', async () => {
  const h = await createFrontendHarness();
  const $ = h.$;

  h.context.openDrawer();
  h.context.toggleSettings(true);
  h.context.handleEscape();
  assert.equal($('settings-popover').hidden, true, 'Esc closes the topmost overlay first');
  assert.equal($('nav-drawer').hidden, false, 'lower overlay untouched');
  h.context.handleEscape();
  assert.equal($('nav-drawer').hidden, true);

  await feOpenBook(h);
  feSelect(h, { para: feParagraph(h, 0, 'original'), start: 6, end: 21, text: 'first paragraph' });
  h.context.captureSelection();
  h.context.openComposer('private');
  h.context.openDrawer();
  h.context.handleEscape();
  assert.equal($('nav-drawer').hidden, true, 'drawer above composer closes first');
  assert.ok(!$('annotation-composer').classList.contains('hidden'), 'composer survives');
  h.context.handleEscape();
  assert.ok($('annotation-composer').classList.contains('hidden'), 'composer closes on the next Esc');

  const modal = $('auth-modal');
  const closeBtn = $('close-auth');
  const input = $('access-token');
  const clearBtn = $('clear-token');
  const saveBtn = $('save-token');
  modal._qsa = { 'button, input, textarea, select, [href], [tabindex]:not([tabindex="-1"])': [closeBtn, input, clearBtn, saveBtn] };
  h.context.openAuthModal();
  h.document.activeElement = saveBtn;
  const tabEvent = { key: 'Tab', shiftKey: false, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  h.document.dispatch('keydown', tabEvent);
  assert.equal(tabEvent.defaultPrevented, true, 'Tab trapped at the last control');
  assert.equal(h.document.activeElement, closeBtn, 'focus cycles to the first control');
  const shiftTabEvent = { key: 'Tab', shiftKey: true, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  h.document.activeElement = closeBtn;
  h.document.dispatch('keydown', shiftTabEvent);
  assert.equal(shiftTabEvent.defaultPrevented, true, 'Shift+Tab trapped at the first control');
  assert.equal(h.document.activeElement, saveBtn, 'focus cycles to the last control');

  h.context.openImportModal();
  h.context.handleEscape();
  assert.equal($('import-modal').hidden, true, 'stacked modals: only the top one closes');
  assert.equal($('auth-modal').hidden, false);
  h.context.handleEscape();
  assert.equal($('auth-modal').hidden, true);
  assert.equal(h.document.activeElement, $('app-status'), 'focus falls back to the status trigger after the auth modal closes');
});

test('co_reading Web frontend: arrow navigation ignores typing targets, IME, modifiers, modals and selections', async () => {
  const h = await createFrontendHarness();
  await feOpenBook(h);
  const keyEvent = (over = {}) => ({
    key: 'ArrowRight',
    target: h.document.body,
    isComposing: false,
    defaultPrevented: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    preventDefault() { this.defaultPrevented = true; },
    ...over,
  });
  const c2Gets = () => feCountEnd(h, 'GET', '/books/b1/chunks/c2');

  let ev = keyEvent();
  h.document.dispatch('keydown', ev);
  assert.equal(ev.defaultPrevented, true, 'plain ArrowRight turns the page');
  await feSleep(10);
  assert.equal(c2Gets(), 1);

  ev = keyEvent();
  h.document.dispatch('keydown', ev);
  assert.equal(ev.defaultPrevented, true, 'ArrowRight turns to the last chunk');
  await feSleep(10);

  ev = keyEvent();
  h.document.dispatch('keydown', ev);
  assert.equal(ev.defaultPrevented, false, 'no preventDefault at the last chunk');

  ev = keyEvent({ key: 'ArrowLeft' });
  h.document.dispatch('keydown', ev);
  assert.equal(ev.defaultPrevented, true, 'ArrowLeft turns back');
  await feSleep(10);

  const inputTarget = new FeElement('input', h.document);
  inputTarget.parentElement = h.document.body;
  const before = h.fetchLog.length;
  for (const blocked of [
    keyEvent({ target: inputTarget }),
    keyEvent({ isComposing: true }),
    keyEvent({ shiftKey: true }),
    keyEvent({ metaKey: true }),
    keyEvent({ ctrlKey: true }),
  ]) {
    h.document.dispatch('keydown', blocked);
    assert.equal(blocked.defaultPrevented, false, 'blocked context must not turn the page');
  }

  h.context.openAuthModal();
  ev = keyEvent();
  h.document.dispatch('keydown', ev);
  assert.equal(ev.defaultPrevented, false, 'modal open blocks page turns');
  h.context.closeAuthModal();

  feSelect(h, { para: feParagraph(h, 0, 'original'), start: 6, end: 21, text: 'first paragraph' });
  ev = keyEvent();
  h.document.dispatch('keydown', ev);
  assert.equal(ev.defaultPrevented, false, 'active selection blocks page turns');
  h.selectionBox.current = null;

  assert.equal(h.fetchLog.length, before, 'none of the blocked attempts hit the network');
});

test('co_reading Web frontend static: unique ids, hooks present, token storage boundary held', async () => {
  const html = await readFile(FE_INDEX_PATH, 'utf8');
  const css = await readFile(FE_CSS_PATH, 'utf8');
  const ids = [...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  assert.deepEqual(duplicates, [], 'index.html must not contain duplicate ids');
  for (const hook of ['app-status-live', 'clear-token', 'select-paragraph', 'selection-toolbar', 'annotation-composer', 'access-token', 'import-modal', 'auth-modal']) {
    assert.ok(ids.includes(hook), `missing #${hook}`);
  }
  for (const [name, source] of [['index.html', html], ['app.js', FE_APP_SOURCE], ['style.css', css]]) {
    assert.ok(!source.includes('CO_READING_OWNER_TOKEN'), `${name} must never reference the owner token`);
  }
  assert.ok(FE_APP_SOURCE.includes('sessionStorage.setItem(TOKEN_KEY'), 'token kept in sessionStorage');
  assert.ok(!FE_APP_SOURCE.includes('localStorage.setItem(TOKEN_KEY'), 'token never written to localStorage');
  assert.ok(!FE_APP_SOURCE.includes('localStorage.getItem(TOKEN_KEY'), 'token never read from localStorage');
  const saveBody = FE_APP_SOURCE.slice(
    FE_APP_SOURCE.indexOf('async function saveAnnotation'),
    FE_APP_SOURCE.indexOf('async function autoAskHermes')
  );
  assert.ok(saveBody.includes("visibility === 'shared'"), 'Hermes auto-invite stays shared-only');
  assert.ok(!saveBody.includes('deposit-vault'), 'save path never deposits to Vault');
  assert.ok(css.includes('prefers-reduced-motion'), 'reduced motion respected');
  assert.ok(css.includes('.chunk-text:focus-visible'), 'reader focus must stay visible');
});

/* ========================================================================
   Final async-state adversarial tests (five blockers from the final
   re-review). Races use deferred promises/gates, never sleep-based timing.
   ======================================================================== */

test('co_reading Web frontend adversarial: token is dropped from the DOM synchronously on save', async () => {
  const h = await createFrontendHarness({ token: 'old-web-token' });
  const $ = h.$;
  h.flags.holdBooks = true;
  h.context.openAuthModal();
  $('access-token').value = 'brand-new-web-token';
  const booksBefore = feCount(h, 'GET', '/books?include_trash');

  $('save-token').click();
  // The fetch promise is still pending — the secret must already be gone.
  assert.equal($('access-token').value, '', 'input cleared synchronously, before any await resolves');
  assert.equal($('access-token').getAttribute('value'), null, 'no value attribute persists');
  assert.equal(h.session.getItem('CO_READING_WEB_ACCESS_TOKEN'), 'brand-new-web-token', 'session updated without writing back to the input');

  $('save-token').click();
  $('save-token').click();
  assert.equal(feCount(h, 'GET', '/books?include_trash'), booksBefore + 1, 'repeat clicks issue no duplicate validation request');
  assert.equal(h.session.getItem('CO_READING_WEB_ACCESS_TOKEN'), 'brand-new-web-token', 'empty input never overwrites the saved token');
  assert.equal($('access-token').value, '', 'input stays empty while the request pends');

  h.gates.books.open();
  await feSleep(10);
  assert.equal($('access-token').value, '', 'input stays empty after slow success');
  assert.equal($('auth-modal').hidden, true);
  assert.ok(!$('app-status-text').textContent.includes('brand-new-web-token'), 'status never carries the token');
  for (const el of h.document._elements.values()) {
    assert.ok(!JSON.stringify(el.dataset).includes('brand-new-web-token'), `#${el.id} dataset must not hold the token`);
    assert.ok(!String(el._innerHTML || '').includes('brand-new-web-token'), `#${el.id} innerHTML must not hold the token`);
  }
});

test('co_reading Web frontend adversarial: token input stays empty on slow failure and on cancel', async () => {
  const h = await createFrontendHarness({ token: 'old-web-token' });
  const $ = h.$;
  h.context.openAuthModal();
  $('access-token').value = 'failing-web-token';
  h.flags.unauthorized = true;
  h.flags.holdBooks = true;
  $('save-token').click();
  assert.equal($('access-token').value, '', 'cleared before the failing request resolves');
  h.gates.books.open();
  await feSleep(10);
  assert.equal($('access-token').value, '', 'input stays empty after slow failure');
  assert.ok(!$('app-status-text').textContent.includes('failing-web-token'), 'error status carries no token');
  assert.ok(!$('auth-hint').textContent.includes('failing-web-token'), '401 hint carries no token');
  assert.equal($('auth-modal').hidden, false, '401 reopens the modal without refilling');

  // cancel while a save is pending: the request may finish later, input stays empty
  h.flags.unauthorized = false;
  h.flags.holdBooks = true;
  h.gates.books = feGate();
  $('access-token').value = 'cancelled-web-token';
  $('save-token').click();
  h.context.closeAuthModal();
  assert.equal($('access-token').value, '', 'input empty at cancel time');
  h.gates.books.open();
  await feSleep(10);
  assert.equal($('access-token').value, '', 'input still empty after the cancelled request completes');
  assert.equal(h.session.getItem('CO_READING_WEB_ACCESS_TOKEN'), 'cancelled-web-token');
});

test('co_reading Web frontend adversarial: out-of-order chunk responses cannot overwrite a newer chunk', async () => {
  const h = await createFrontendHarness();
  await feOpenBook(h);
  const $ = h.$;
  assert.equal($('chunk-title').textContent, '第一章');

  // A = c2 (slow), B = c3 (fast): B must win and stay.
  h.flags.holdChunks.add('c2');
  const staleA = h.context.openChunk('c2');
  await h.context.openChunk('c3');
  await feSleep(5);
  assert.equal($('chunk-title').textContent, '第三章');
  h.gates.chunk.c2.open();
  await staleA;
  await feSleep(5);
  assert.equal($('chunk-title').textContent, '第三章', 'stale A must not overwrite the title of B');
  assert.ok($('chunk-text').children[0].children[0].textContent.startsWith('The lighthouse'), 'body still belongs to B');
  assert.equal($('annotation-count').textContent, '0', 'annotations of A never enter B');
  assert.equal(
    h.fetchLog.filter((entry) => entry.method === 'POST' && entry.url.endsWith('/progress') && entry.body?.chunk_id === 'c2').length,
    0,
    'stale A never writes progress'
  );
  assert.equal(feCount(h, 'GET', '/chunks/c2/translation'), 0, 'stale A never starts a translation');

  // Reverse order: A = c3 (slow), B = c2 (fast).
  h.flags.holdChunks.add('c3');
  h.gates.chunk.c3 = feGate();
  const staleC3 = h.context.openChunk('c3');
  await h.context.openChunk('c2');
  await feSleep(5);
  assert.equal($('chunk-title').textContent, '第二章');
  h.gates.chunk.c3.open();
  await staleC3;
  await feSleep(5);
  assert.equal($('chunk-title').textContent, '第二章', 'stale A must not overwrite B in the reverse order');
  assert.equal($('annotation-count').textContent, '1', 'B annotations intact');

  // Slow error cannot clobber a newer successful chunk either.
  h.flags.holdChunks.add('c3');
  h.flags.failChunks.add('c3');
  h.gates.chunk.c3 = feGate();
  const failing = h.context.openChunk('c3').catch((error) => error);
  await h.context.openChunk('c1');
  await feSleep(5);
  h.gates.chunk.c3.open();
  await failing;
  await feSleep(5);
  assert.equal($('chunk-title').textContent, '第一章', 'slow failure leaves the current chunk untouched');

  // clearCurrentBook invalidates an in-flight load.
  h.flags.holdChunks.add('c2');
  h.gates.chunk.c2 = feGate();
  const staleAfterClear = h.context.openChunk('c2');
  h.context.clearCurrentBook();
  h.gates.chunk.c2.open();
  await staleAfterClear;
  await feSleep(5);
  assert.equal($('chunk-title').textContent, '从书架选择一本书，开始阅读', 'stale response must not resurrect a cleared book');
  assert.equal($('chunk-text').textContent, '');
});

test('co_reading Web frontend adversarial: stale save completion cannot clear or relock a newer composer', async () => {
  const h = await createFrontendHarness();
  await feOpenBook(h);
  const $ = h.$;
  const selectValid = (start, end, text) => {
    feSelect(h, { para: feParagraph(h, 0, 'original'), start, end, text });
    h.context.captureSelection();
  };

  // A: private save on c1, held in flight.
  selectValid(6, 21, 'first paragraph');
  h.context.openComposer('private');
  $('annotation-note').value = 'A note';
  h.flags.holdAnnotation = true;
  const saveA = h.context.saveAnnotation('private');
  await feSleep(2);
  assert.equal($('save-annotation').disabled, true, 'own session locked while in flight');

  // The user moves to c2 and opens a NEW composer there.
  await h.context.openChunk('c2');
  await feSleep(5);
  selectValid(0, 5, 'Gamma');
  h.context.openComposer('shared');
  $('annotation-note').value = 'B note';
  assert.equal($('save-annotation').disabled, false, 'new composer session starts unlocked');

  h.gates.annotation.open();
  await saveA;
  await feSleep(5);
  assert.ok(!$('annotation-composer').classList.contains('hidden'), 'new composer survives the stale completion');
  assert.equal($('annotation-quote-preview').textContent, 'Gamma', 'preview untouched');
  assert.equal($('annotation-note').value, 'B note', 'note untouched');
  assert.equal($('save-annotation').disabled, false, 'stale finally must not relock the new session');
  assert.equal($('save-annotation').textContent, '保存并邀请 Hermes', 'new session visibility intact');
  assert.equal($('chunk-title').textContent, '第二章', 'stale save does not reopen its old chunk');
  assert.equal(feCount(h, 'POST', 'ask-hermes'), 0, 'private A never invites Hermes');
  assert.equal(feCountEnd(h, 'POST', '/books/b1/annotations'), 1, 'A saved exactly once');

  // B still saves normally afterwards (different generation, not blocked).
  await h.context.saveAnnotation('shared');
  assert.equal(feCountEnd(h, 'POST', '/books/b1/annotations'), 2, 'B saves after A completes');
  assert.equal(feCount(h, 'POST', 'ask-hermes'), 1, 'shared B invites Hermes exactly once');
});

test('co_reading Web frontend adversarial: stale shared save still invites Hermes once but never touches the new context', async () => {
  const h = await createFrontendHarness();
  await feOpenBook(h);
  const $ = h.$;
  feSelect(h, { para: feParagraph(h, 0, 'original'), start: 6, end: 21, text: 'first paragraph' });
  h.context.captureSelection();
  h.context.openComposer('shared');
  h.flags.holdAnnotation = true;
  const saveA = h.context.saveAnnotation('shared');
  await feSleep(2);
  const c1Gets = feCountEnd(h, 'GET', '/books/b1/chunks/c1');

  await h.context.openChunk('c2');
  await feSleep(5);
  feSelect(h, { para: feParagraph(h, 0, 'original'), start: 0, end: 5, text: 'Gamma' });
  h.context.captureSelection();
  h.context.openComposer('private');
  $('annotation-note').value = 'B private';

  h.gates.annotation.open();
  await saveA;
  await feSleep(5);
  assert.equal(feCount(h, 'POST', 'ask-hermes'), 1, 'shared A still invites Hermes exactly once');
  assert.equal(feCountEnd(h, 'GET', '/books/b1/chunks/c1'), c1Gets, 'stale completion never re-renders the old chunk');
  assert.ok(!$('annotation-composer').classList.contains('hidden'), 'new composer intact');
  assert.equal($('annotation-note').value, 'B private');
});

test('co_reading Web frontend adversarial: stale save failure leaves the new composer and buttons untouched', async () => {
  const h = await createFrontendHarness();
  await feOpenBook(h);
  const $ = h.$;
  feSelect(h, { para: feParagraph(h, 0, 'original'), start: 6, end: 21, text: 'first paragraph' });
  h.context.captureSelection();
  h.context.openComposer('private');
  h.flags.holdAnnotation = true;
  const saveA = h.context.saveAnnotation('private');
  await feSleep(2);

  await h.context.openChunk('c2');
  await feSleep(5);
  feSelect(h, { para: feParagraph(h, 0, 'original'), start: 0, end: 5, text: 'Gamma' });
  h.context.captureSelection();
  h.context.openComposer('shared');
  $('annotation-note').value = 'B note';

  h.flags.failAnnotations = true;
  h.gates.annotation.open();
  await assert.rejects(saveA, /save failed/);
  await feSleep(5);
  assert.ok(!$('annotation-composer').classList.contains('hidden'), 'failure does not close the new composer');
  assert.equal($('annotation-note').value, 'B note', 'failure does not touch the new note');
  assert.equal($('save-annotation').disabled, false, 'stale finally does not relock');
  assert.equal($('save-annotation').textContent, '保存并邀请 Hermes', 'new session label intact');
});

test('co_reading Web frontend adversarial: whole-paragraph quote comes from the canonical source model, never DOM text', async () => {
  const h = await createFrontendHarness();
  await feOpenBook(h);
  const $ = h.$;

  const para = feParagraph(h, 0, 'original');
  feSelect(h, { para, start: 6, end: 21, text: 'first paragraph' });
  h.context.captureSelection();
  // Adversarial DOM mutations after capture: highlight-like text, injected
  // decoration, aria-only node — none may leak into the quote.
  para.appendChild(new FeTextNode('DOM-INJECTED-NOT-SOURCE'));
  const ariaOnly = new FeElement('span', h.document);
  ariaOnly.setAttribute('aria-hidden', 'true');
  ariaOnly.textContent = 'ARIA-ONLY-NOT-SOURCE';
  para.appendChild(ariaOnly);
  assert.equal(h.context.expandQuoteToParagraph(), true);
  assert.equal($('annotation-quote-preview').textContent, 'Alpha first paragraph.', 'quote is the canonical source slice');
  h.context.openComposer('private');
  await h.context.saveAnnotation('private');
  const post = feLast(h, 'POST', '/books/b1/annotations');
  assert.equal(post.body.quote, 'Alpha first paragraph.');
  assert.ok(!post.body.quote.includes('DOM-INJECTED'), 'injected DOM text never enters the quote');
  assert.ok(!post.body.quote.includes('ARIA-ONLY'), 'aria-only DOM text never enters the quote');
  assert.equal(post.body.quote_offset, 0);

  // Translation model with MORE paragraphs than the original resolves by its own offsets.
  await h.context.openChunk('c2');
  await feSleep(5);
  const extra = $('chunk-text').children[1];
  assert.ok(extra?.classList.contains('translation-extra'), 'extra translation block rendered');
  const extraPara = extra.children[0];
  feSelect(h, { para: extraPara, start: 0, end: 3, text: '译二二' });
  h.context.captureSelection();
  assert.equal(h.context.expandQuoteToParagraph(), true);
  assert.equal($('annotation-quote-preview').textContent, '译二二。', 'extra translation paragraph resolves via the translation model');

  // A selection anchored to a detached (pre-re-render) DOM node is refused.
  const oldPara = feParagraph(h, 0, 'original');
  h.context.renderReaderText();
  feSelect(h, { para: oldPara, start: 0, end: 5, text: 'Gamma' });
  h.context.captureSelection();
  assert.equal($('selection-toolbar').hidden, true, 'detached paragraph reference is refused');
});

test('co_reading Web frontend adversarial: modal reclaims escaped focus and releases the background on close', async () => {
  const h = await createFrontendHarness();
  const $ = h.$;
  assert.equal((h.document._listeners.focusin || []).length, 1, 'focusin guard bound exactly once');
  const authModal = $('auth-modal');
  const authControls = [$('close-auth'), $('access-token'), $('clear-token'), $('save-token')];
  authControls.forEach((el) => authModal.appendChild(el));
  authModal._qsa = { 'button, input, textarea, select, [href], [tabindex]:not([tabindex="-1"])': authControls };

  h.context.openAuthModal();
  assert.equal($('co-reading-reader').inert, true, 'background inert while the modal is open');
  assert.equal($('co-reading-reader').getAttribute('aria-hidden'), 'true');
  assert.equal(authModal.inert, false, 'modal itself stays active');

  // escape before any focus landed inside: reclaim to the first control
  const backgroundButton = $('next-chunk');
  backgroundButton.focus();
  h.document.dispatch('focusin', { target: backgroundButton });
  assert.equal(h.document.activeElement, $('close-auth'), 'escaped focus reclaimed to the first modal control');

  // focus inside is remembered; a later escape returns there
  h.document.dispatch('focusin', { target: $('access-token') });
  backgroundButton.focus();
  h.document.dispatch('focusin', { target: backgroundButton });
  assert.equal(h.document.activeElement, $('access-token'), 'reclaim prefers the last control inside the modal');

  h.document.dispatch('focusin', { target: h.document.body });
  assert.ok(authModal.contains(h.document.activeElement), 'focusing the body is pulled back into the modal');

  // last inside control got detached: fall back to the first focusable
  $('access-token').parentElement = null;
  h.document.dispatch('focusin', { target: h.document.body });
  assert.equal(h.document.activeElement, $('close-auth'), 'detached last-focus falls back to the first control');
  authModal.appendChild($('access-token'));

  // repeated escapes do not recurse or oscillate
  for (let index = 0; index < 3; index += 1) h.document.dispatch('focusin', { target: h.document.body });
  assert.ok(authModal.contains(h.document.activeElement), 'no focus loop');

  // nested overlay: only the top modal may hold focus
  const importModal = $('import-modal');
  const importControls = [$('close-import'), $('import-title'), $('import-submit')];
  importControls.forEach((el) => importModal.appendChild(el));
  importModal._qsa = { 'button, input, textarea, select, [href], [tabindex]:not([tabindex="-1"])': importControls };
  h.context.openImportModal();
  assert.equal(authModal.inert, true, 'lower modal becomes inert under a nested overlay');
  h.document.dispatch('focusin', { target: $('save-token') });
  assert.ok(importModal.contains(h.document.activeElement), 'focus in the lower modal is pulled up to the top one');
  h.context.closeImportModal();
  assert.equal(authModal.inert, false, 'lower modal active again after the top one closes');

  h.context.closeAuthModal();
  assert.equal($('co-reading-reader').inert, false, 'background released when the last modal closes');
  assert.equal($('co-reading-reader').getAttribute('aria-hidden'), null, 'aria-hidden cleaned up');
  backgroundButton.focus();
  h.document.dispatch('focusin', { target: backgroundButton });
  assert.equal(h.document.activeElement, backgroundButton, 'no modal → the guard stays out of the way');

  // 401 auto-open engages the same guard
  h.flags.unauthorized = true;
  await h.context.refreshBooks().catch(() => {});
  await feSleep(5);
  assert.equal(authModal.hidden, false, '401 auto-opens the modal');
  assert.equal($('co-reading-reader').inert, true, 'guard active for the auto-opened modal');
});

/* ========================================================================
   v0.2 adversarial tests: the five exact missed sequences from the final
   async rereview. All races are driven by explicit gates + feFlush
   (microtask drain), never wall-clock sleeps.
   ======================================================================== */

test('co_reading Web frontend adversarial: token re-entered during a pending save is also cleared synchronously', async () => {
  const h = await createFrontendHarness({ token: 'old-web-token' });
  const $ = h.$;
  h.flags.holdBooks = true;
  h.context.openAuthModal();
  $('access-token').value = 'first-secret';
  const booksBefore = feCount(h, 'GET', '/books?include_trash');
  $('save-token').click();
  assert.equal($('access-token').value, '', 'first input cleared synchronously');

  $('access-token').value = 'second-secret';
  $('save-token').click();
  assert.equal($('access-token').value, '', 're-typed token cleared synchronously even while the first save is pending');
  assert.equal($('access-token').getAttribute('value'), null, 'no value attribute holds the re-typed token');
  assert.equal(feCount(h, 'GET', '/books?include_trash'), booksBefore + 1, 'still exactly one validation request');
  assert.equal(h.session.getItem('CO_READING_WEB_ACCESS_TOKEN'), 'first-secret', 'the second click never overwrote the session token');

  h.gates.books.open();
  await feFlush();
  assert.equal($('access-token').value, '', 'nothing is written back after the slow success');
  assert.equal(h.session.getItem('CO_READING_WEB_ACCESS_TOKEN'), 'first-secret');
  assert.ok(!$('app-status-text').textContent.includes('first-secret'), 'status carries no token');
});

test('co_reading Web frontend adversarial: progress writes are latest-wins even with an older write in flight', async () => {
  const h = await createFrontendHarness();
  await feOpenBook(h);
  const $ = h.$;

  // A = c2: body renders, its progress POST is gated in flight.
  h.flags.holdProgressFor.add('c2');
  const staleA = h.context.openChunk('c2');
  await feFlush();
  assert.equal($('chunk-title').textContent, '第二章');

  // B = c3: body renders; its progress write queues behind the gated one.
  const openC3 = h.context.openChunk('c3');
  await feFlush();
  assert.equal($('chunk-title').textContent, '第三章');

  h.gates.progress.c2.open();
  await staleA;
  await openC3;
  await feFlush();

  const progressPosts = h.fetchLog.filter((entry) => entry.method === 'POST' && entry.url.endsWith('/progress'));
  assert.equal(progressPosts.at(-1).body.chunk_id, 'c3', 'the newest chunk progress is submitted last (latest-wins)');
  assert.equal($('chunk-title').textContent, '第三章', 'UI stays on B');
  // Reads are decoupled from the mutation queue: B's translation must NOT
  // wait for A's gated progress, and A's translation response (a read) must
  // never overwrite B's translation state.
  assert.equal(feCount(h, 'GET', '/chunks/c3/translation'), 1, 'B translation started without waiting for the stale progress');
  const visibleTranslation = $('chunk-text').children[0].children[1];
  assert.ok(visibleTranslation.classList.contains('translation-ready'), 'B translation state intact, not clobbered by a stale finally');
  assert.equal(visibleTranslation.textContent, FE_TRANS3.split('\n\n')[0], 'visible translation belongs to B');

  // Two concurrent openBook calls on the SAME book: the older one loses.
  const progressGetsBefore = feCount(h, 'GET', '/books/b1/progress?device_id');
  h.flags.holdChunkList = true;
  const firstOpen = h.context.openBook('b1');
  const secondOpen = h.context.openBook('b1');
  await feFlush();
  h.gates.chunkList.open();
  await Promise.all([firstOpen, secondOpen]);
  await feFlush();
  assert.equal(
    feCount(h, 'GET', '/books/b1/progress?device_id'),
    progressGetsBefore + 1,
    'only the newer same-book open proceeds past the chunk list'
  );
  assert.equal($('chunk-title').textContent, '第一章', 'the newer open completes normally');
});

test('co_reading Web frontend adversarial: same-chunk stale save cannot clear the newer composer (private)', async () => {
  const h = await createFrontendHarness();
  await feOpenBook(h);
  const $ = h.$;
  const selectValid = (start, end, text) => {
    feSelect(h, { para: feParagraph(h, 0, 'original'), start, end, text });
    h.context.captureSelection();
  };

  selectValid(6, 21, 'first paragraph');
  h.context.openComposer('private');
  $('annotation-note').value = 'A note';
  h.flags.holdAnnotation = true;
  const saveA = h.context.saveAnnotation('private');
  await feFlush();

  // The user cancels A and builds composer B in the SAME chunk.
  h.context.clearComposer();
  selectValid(0, 5, 'Alpha');
  h.context.openComposer('shared');
  $('annotation-note').value = 'B note';
  const c1Gets = feCountEnd(h, 'GET', '/books/b1/chunks/c1');

  h.gates.annotation.open();
  await saveA;
  await feFlush();

  assert.ok(!$('annotation-composer').classList.contains('hidden'), 'composer B stays open');
  assert.equal($('annotation-note').value, 'B note', 'note of B untouched');
  assert.equal($('annotation-quote-preview').textContent, 'Alpha', 'anchor of B untouched');
  assert.equal($('save-annotation').disabled, false, 'stale finally does not relock B');
  assert.equal($('save-annotation').textContent, '保存并邀请 Hermes', 'visibility of B intact');
  assert.equal(feCountEnd(h, 'GET', '/books/b1/chunks/c1'), c1Gets, 'stale private save does not refresh the chunk UI');
  assert.equal(feCount(h, 'POST', 'ask-hermes'), 0, 'private A never invites Hermes');
  assert.equal(feCountEnd(h, 'POST', '/books/b1/annotations'), 1, 'A still saved exactly once');

  await h.context.saveAnnotation('shared');
  assert.equal(feCountEnd(h, 'POST', '/books/b1/annotations'), 2, 'B saves normally afterwards');
  assert.equal(feCount(h, 'POST', 'ask-hermes'), 1, 'shared B invites Hermes exactly once');
});

test('co_reading Web frontend adversarial: same-chunk stale shared save invites Hermes once without touching the new composer', async () => {
  const h = await createFrontendHarness();
  await feOpenBook(h);
  const $ = h.$;
  const selectValid = (start, end, text) => {
    feSelect(h, { para: feParagraph(h, 0, 'original'), start, end, text });
    h.context.captureSelection();
  };

  selectValid(6, 21, 'first paragraph');
  h.context.openComposer('shared');
  $('annotation-note').value = 'A shared note';
  h.flags.holdAnnotation = true;
  const saveA = h.context.saveAnnotation('shared');
  await feFlush();

  h.context.clearComposer();
  selectValid(0, 5, 'Alpha');
  h.context.openComposer('private');
  $('annotation-note').value = 'B private note';
  const c1Gets = feCountEnd(h, 'GET', '/books/b1/chunks/c1');

  h.gates.annotation.open();
  await saveA;
  await feFlush();

  assert.equal(feCount(h, 'POST', 'ask-hermes'), 1, 'shared A still invites Hermes exactly once');
  assert.equal(feCountEnd(h, 'GET', '/books/b1/chunks/c1'), c1Gets, 'no refresh happens around the Hermes call');
  assert.ok(!$('annotation-composer').classList.contains('hidden'), 'composer B stays open');
  assert.equal($('annotation-note').value, 'B private note');
  assert.equal($('save-annotation').disabled, false);
});

test('co_reading Web frontend adversarial: same-chunk stale save error and mid-flight edits preserve the composer', async () => {
  const h = await createFrontendHarness();
  await feOpenBook(h);
  const $ = h.$;
  const selectValid = (start, end, text) => {
    feSelect(h, { para: feParagraph(h, 0, 'original'), start, end, text });
    h.context.captureSelection();
  };

  // Error path with a mid-flight note edit in the SAME session.
  selectValid(6, 21, 'first paragraph');
  h.context.openComposer('private');
  $('annotation-note').value = 'A note';
  h.flags.holdAnnotation = true;
  const saveA = h.context.saveAnnotation('private');
  await feFlush();
  $('annotation-note').value = 'A edited mid-flight';
  $('annotation-note').dispatch('input');
  h.flags.failAnnotations = true;
  h.gates.annotation.open();
  await assert.rejects(saveA, /save failed/);
  await feFlush();
  assert.ok(!$('annotation-composer').classList.contains('hidden'), 'failure keeps the edited composer open');
  assert.equal($('annotation-note').value, 'A edited mid-flight', 'edited note preserved');
  assert.equal($('save-annotation').disabled, false, 'same-session finally still unlocks the controls');

  // Success path with a mid-flight edit: completion must NOT clear the edit.
  h.flags.failAnnotations = false;
  h.flags.holdAnnotation = true;
  h.gates.annotation = feGate();
  const saveB = h.context.saveAnnotation('private');
  await feFlush();
  $('annotation-note').value = 'B edited mid-flight';
  $('annotation-note').dispatch('input');
  const c1Gets = feCountEnd(h, 'GET', '/books/b1/chunks/c1');
  h.gates.annotation.open();
  await saveB;
  await feFlush();
  assert.ok(!$('annotation-composer').classList.contains('hidden'), 'stale success does not close the edited composer');
  assert.equal($('annotation-note').value, 'B edited mid-flight', 'stale success does not clear the edited note');
  assert.equal(feCountEnd(h, 'GET', '/books/b1/chunks/c1'), c1Gets, 'stale success does not refresh the chunk UI');
  assert.equal(feCountEnd(h, 'POST', '/books/b1/annotations'), 2, 'both submissions reached the backend once each');
});

test('co_reading Web frontend adversarial: translation-extra paragraphs resolve by unique canonical identity', async () => {
  const h = await createFrontendHarness();
  await feOpenBook(h);
  await h.context.openChunk('c2');
  await feFlush();
  const $ = h.$;

  const extra = $('chunk-text').children[1];
  assert.ok(extra?.classList.contains('translation-extra'), 'extra translation block rendered');
  assert.equal(extra.children.length, 3, 'every extra paragraph rendered separately');
  assert.equal(extra.children[0].dataset.paragraphId, 'translation:1');
  assert.equal(extra.children[1].dataset.paragraphId, 'translation:2');
  assert.equal(extra.children[2].dataset.paragraphId, 'translation:3');

  // The review's failing case: the SECOND extra paragraph must expand to itself.
  feSelect(h, { para: extra.children[1], start: 0, end: 3, text: '译二三' });
  h.context.captureSelection();
  assert.equal(h.context.expandQuoteToParagraph(), true);
  assert.equal($('annotation-quote-preview').textContent, '译二三。', 'second extra paragraph expands to itself, not the first');

  // Two extra paragraphs with IDENTICAL text resolve by identity, not text lookup.
  const duplicate = extra.children[2];
  feSelect(h, { para: duplicate, start: 0, end: 3, text: '译二二' });
  h.context.captureSelection();
  duplicate.appendChild(new FeTextNode('ARIA-ONLY-NOT-SOURCE'));
  assert.equal(h.context.expandQuoteToParagraph(), true);
  assert.equal($('annotation-quote-preview').textContent, '译二二。');
  h.context.openComposer('private');
  await h.context.saveAnnotation('private');
  const post = feLast(h, 'POST', '/books/b1/annotations');
  const firstOccurrence = FE_TRANS2.indexOf('译二二。');
  const expectedOffset = FE_TRANS2.indexOf('译二二。', firstOccurrence + 1);
  assert.equal(post.body.quote, '译二二。');
  assert.equal(post.body.quote_offset, expectedOffset, 'offset belongs to the SECOND identical paragraph');
  assert.ok(!post.body.quote.includes('ARIA-ONLY'), 'injected DOM text never enters the quote');
  assert.equal(post.body.anchor_kind, 'translation');
  assert.equal(post.body.anchor_lang, 'zh-CN');
});

test('co_reading Web frontend adversarial: modal close syncs inert before restoring focus — focus never lands on BODY', async () => {
  const h = await createFrontendHarness();
  const $ = h.$;
  const authModal = $('auth-modal');
  const authControls = [$('close-auth'), $('access-token'), $('clear-token'), $('save-token')];
  authControls.forEach((el) => authModal.appendChild(el));
  authModal._qsa = { 'button, input, textarea, select, [href], [tabindex]:not([tabindex="-1"])': authControls };

  // Single layer, programmatic close.
  h.context.openAuthModal();
  assert.equal($('co-reading-reader').inert, true);
  h.context.closeAuthModal();
  assert.equal(h.document.activeElement, $('app-status'), 'focus restored to the opener');
  assert.notEqual(h.document.activeElement, h.document.body, 'focus never lands on BODY');
  assert.equal(h.document._focusLog.at(-1).blocked, false, 'focus happened after inert was lifted');
  assert.equal($('co-reading-reader').inert, false, 'background released');

  // Esc path uses the same synchronized close.
  h.context.openAuthModal();
  h.document.dispatch('keydown', { key: 'Escape' });
  assert.equal(h.document.activeElement, $('app-status'), 'Esc close also restores focus');
  assert.equal(h.document._focusLog.at(-1).blocked, false);

  // Nested: closing the top modal moves focus INTO the lower modal.
  const importModal = $('import-modal');
  const importControls = [$('close-import'), $('import-title'), $('import-submit')];
  importControls.forEach((el) => importModal.appendChild(el));
  importModal._qsa = { 'button, input, textarea, select, [href], [tabindex]:not([tabindex="-1"])': importControls };
  h.context.openAuthModal();
  h.context.openImportModal();
  h.context.closeImportModal();
  assert.ok(authModal.contains(h.document.activeElement), 'closing the top modal focuses the lower modal');
  assert.equal(authModal.inert, false, 'lower modal active again');
  assert.equal($('co-reading-reader').inert, true, 'background stays inert while a modal remains');
  h.context.closeAuthModal();
  assert.equal(h.document.activeElement, $('app-status'));
  assert.equal($('co-reading-reader').inert, false);

  // 401 auto-open follows the same close path.
  h.flags.unauthorized = true;
  await h.context.refreshBooks().catch(() => {});
  await feFlush();
  assert.equal(authModal.hidden, false, '401 auto-opens the modal');
  h.context.closeAuthModal();
  assert.equal(h.document.activeElement, $('app-status'), 'focus restored after the 401 modal closes');
  assert.equal(h.document._focusLog.at(-1).blocked, false);
  h.flags.unauthorized = false;

  // Opener removed before close: documented fallback, never BODY.
  h.context.openAuthModal();
  const opener = $('app-status');
  const openerParent = opener.parentElement;
  opener.parentElement = null;
  h.context.closeAuthModal();
  assert.equal(h.document.activeElement, $('chunk-text'), 'removed opener falls back to the reader surface');
  assert.notEqual(h.document.activeElement, h.document.body);
  openerParent.appendChild(opener);

  // After everything is closed, the guard stays out of normal page focus.
  $('next-chunk').focus();
  h.document.dispatch('focusin', { target: $('next-chunk') });
  assert.equal(h.document.activeElement, $('next-chunk'), 'no modal → normal focus is not hijacked');
});

/* ========================================================================
   v0.3 adversarial tests: the two paths still open in the closure review.
   Fix 1 proves the server-visible commit order of progress mutations with a
   mock server that separates "received" from "completed". Fix 2 drives the
   REAL production path (save button click → saveAnnotationWithStatus).
   ======================================================================== */

test('co_reading Web frontend adversarial: progress mutations are never client-aborted and commit strictly in order', async () => {
  const h = await createFrontendHarness();
  await feOpenBook(h);
  const $ = h.$;
  assert.deepEqual(
    h.progressServer.map((entry) => `${entry.event}:${entry.chunkId}`),
    ['received:c1', 'completed:c1']
  );

  // A = c2: its progress mutation reached the mock server and stays pending.
  h.flags.holdProgressFor.add('c2');
  const openA = h.context.openChunk('c2');
  await feFlush();
  assert.equal($('chunk-title').textContent, '第二章');
  assert.deepEqual(h.progressServer.at(-1), { event: 'received', chunkId: 'c2' }, 'A progress reached the server');

  // B = c3 opens: reads may abort, but the A mutation must not; B's progress
  // must not even be SENT before A's server response completes.
  const openB = h.context.openChunk('c3');
  await feFlush();
  assert.equal($('chunk-title').textContent, '第三章');
  assert.ok(!h.progressServer.some((entry) => entry.chunkId === 'c3'), 'B progress not sent while A is still server-pending');
  assert.ok(!h.progressServer.some((entry) => entry.event === 'client-aborted'), 'A mutation was never client-aborted');
  assert.equal(feCount(h, 'GET', '/chunks/c3/translation'), 1, 'B translation never waited for the stale mutation');

  h.gates.progress.c2.open();
  await openA;
  await openB;
  await feFlush();
  assert.deepEqual(
    h.progressServer.map((entry) => `${entry.event}:${entry.chunkId}`),
    ['received:c1', 'completed:c1', 'received:c2', 'completed:c2', 'received:c3', 'completed:c3'],
    'server-visible commit order is strictly A → B'
  );
  assert.equal($('chunk-title').textContent, '第三章', 'UI stays on B');
  assert.equal($('chunk-text').children[0].children[1].textContent, FE_TRANS3.split('\n\n')[0], 'B translation intact after A completion');

  // Coalescing: while a mutation is pending, intermediate payloads are
  // dropped and only the newest pending one is ever sent.
  h.gates.progress.c2 = feGate();
  const base = h.progressServer.length;
  const openA2 = h.context.openChunk('c2');
  await feFlush();
  const openB2 = h.context.openChunk('c3');
  await feFlush();
  const openC = h.context.openChunk('c1');
  await feFlush();
  h.gates.progress.c2.open();
  await Promise.all([openA2, openB2, openC]);
  await feFlush();
  assert.deepEqual(
    h.progressServer.slice(base).map((entry) => `${entry.event}:${entry.chunkId}`),
    ['received:c2', 'completed:c2', 'received:c1', 'completed:c1'],
    'intermediate payload (c3) was dropped; only the newest pending mutation was sent'
  );
});

test('co_reading Web frontend adversarial: progress mutation failure is silent for newer chunks but reported for the current one', async () => {
  const h = await createFrontendHarness();
  await feOpenBook(h);
  const $ = h.$;

  // A = c2 progress pending on the server; switch to c3; A's write fails late → silent.
  h.flags.holdProgressFor.add('c2');
  const openA = h.context.openChunk('c2');
  await feFlush();
  const openB = h.context.openChunk('c3');
  await feFlush();
  h.context.setStatus('marker-status');
  h.flags.failProgressFor.add('c2');
  h.gates.progress.c2.open();
  await openA;
  await openB;
  await feFlush();
  assert.equal($('app-status-text').textContent, 'marker-status', 'stale progress failure never reaches the status area');

  // Current chunk progress failure IS reported.
  h.flags.failProgressFor.add('c1');
  h.context.setStatus('marker-2');
  await h.context.openChunk('c1');
  await feFlush();
  assert.equal($('app-status-text').textContent, '阅读进度保存失败：progress failed', 'current progress failure is reported');
  h.flags.failProgressFor.clear();
});

test('co_reading Web frontend adversarial: same-chunk stale save failure stays silent for the new composer via the real save path', async () => {
  const h = await createFrontendHarness();
  await feOpenBook(h);
  const $ = h.$;
  const selectValid = (start, end, text) => {
    feSelect(h, { para: feParagraph(h, 0, 'original'), start, end, text });
    h.context.captureSelection();
  };

  selectValid(6, 21, 'first paragraph');
  h.context.openComposer('private');
  $('annotation-note').value = 'A note';
  h.flags.holdAnnotation = true;
  // The REAL production path: button click → saveAnnotationWithStatus.
  $('save-annotation').click();
  await feFlush();
  assert.equal($('app-status-text').textContent, '保存 private 批注...', 'in-progress status for the current save');

  h.context.clearComposer();
  selectValid(0, 5, 'Alpha');
  h.context.openComposer('shared');
  $('annotation-note').value = 'B note';
  h.context.setStatus('neutral-marker');
  h.flags.failAnnotations = true;
  h.gates.annotation.open();
  await feFlush();

  assert.equal($('app-status-text').textContent, 'neutral-marker', 'stale failure never reaches the global status');
  assert.equal($('app-status-live').textContent, 'neutral-marker', 'stale failure never reaches the live region');
  assert.ok(!$('annotation-composer').classList.contains('hidden'), 'composer B stays open');
  assert.equal($('annotation-note').value, 'B note', 'B content unchanged');
  assert.equal($('annotation-quote-preview').textContent, 'Alpha', 'B anchor unchanged');
  assert.equal($('save-annotation').textContent, '保存并邀请 Hermes', 'B visibility unchanged');
  assert.equal($('save-annotation').disabled, false, 'B stays editable');
  assert.equal(feCountEnd(h, 'POST', '/books/b1/annotations'), 1, 'A attempted exactly once');

  // The same failure IS reported when the submission still owns the composer.
  $('save-annotation').click();
  await feFlush();
  assert.equal($('app-status-text').textContent, 'save failed', 'current submission failure shows the error');
  assert.equal($('annotation-note').value, 'B note', 'note preserved for retry');
  assert.equal($('save-annotation').disabled, false, 'controls restored for the current composer');
  h.flags.failAnnotations = false;
});

test('co_reading Web frontend adversarial: same-chunk stale save success is silent while the current save still confirms', async () => {
  const h = await createFrontendHarness();
  await feOpenBook(h);
  const $ = h.$;
  const selectValid = (start, end, text) => {
    feSelect(h, { para: feParagraph(h, 0, 'original'), start, end, text });
    h.context.captureSelection();
  };

  selectValid(6, 21, 'first paragraph');
  h.context.openComposer('private');
  h.flags.holdAnnotation = true;
  $('save-annotation').click();
  await feFlush();

  h.context.clearComposer();
  selectValid(0, 5, 'Alpha');
  h.context.openComposer('shared');
  $('annotation-note').value = 'B note';
  h.context.setStatus('neutral-marker');
  h.gates.annotation.open();
  await feFlush();

  assert.equal($('app-status-text').textContent, 'neutral-marker', 'stale success writes no success message into the new context');
  assert.equal(feCount(h, 'POST', 'ask-hermes'), 0, 'private stale save never invites Hermes');
  assert.equal($('annotation-note').value, 'B note');

  $('save-annotation').click();
  await feFlush(300);
  assert.equal($('app-status-text').textContent, '保存 shared 批注并邀请 Hermes完成', 'current save still confirms');
  assert.equal(feCount(h, 'POST', 'ask-hermes'), 1, 'current shared save invites Hermes exactly once');
});
