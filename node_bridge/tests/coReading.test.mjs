import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

import { buildCoReadingApiContract } from '../src/coReading/apiContract.mjs';
import {
  BOOK_STATES,
  buildCoReadingTools,
  handleCoReadingMcpRequest,
} from '../src/coReading/mcpServer.mjs';
import {
  createCoReadingStore,
  readChunkText,
} from '../src/coReading/store.mjs';
import { createCoReadingWebApp, getCoReadingWebConfig } from '../src/coReading/webServer.mjs';

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
        translationCalls.push({ url, body: JSON.parse(request.body) });
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{ message: { content: '第一段中文译文。\n\n第二段中文译文。' } }],
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
    assert.equal(translated.body.cached, false);
    assert.match(translated.body.translation.text, /中文译文/);
    assert.equal(translationCalls.length, 1);
    assert.doesNotMatch(JSON.stringify(translated.body), /server-owner-secret/);

    const cachedTranslation = await app.handleRequest(req('GET', `/api/co-reading/books/${encodeURIComponent(bookId)}/chunks/${encodeURIComponent(chunkId)}/translation?target=zh-CN`, { token: 'web-token' }));
    assert.equal(cachedTranslation.status, 200);
    assert.equal(cachedTranslation.body.cached, true);
    assert.equal(translationCalls.length, 1);
    assert.equal(store.getStorageStats(bookId).asset_bytes > 0, true);

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
    const imported = await callTool(
      'reading_import_pasted_text',
      { owner_token: 'owner', title: 'Hermes Ask Book', text: '共读正文。\n\n这一段可以问 Hermes。' },
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
      body: { question: '请回应这段。' },
    }));
    assert.equal(asked.status, 200);
    assert.equal(asked.body.reply.author, 'hermes');
    assert.equal(asked.body.reply.text, 'Hermes reply saved.');
    assert.equal(hermesBodies.length, 1);
    assert.match(hermesBodies[0].body, /shared-question-context/);
    assert.match(hermesBodies[0].body, /Annotation anchor: translation \(zh-CN\)/);
    assert.doesNotMatch(hermesBodies[0].body, /private-not-for-hermes/);

    const thread = store.readThread(sharedAnn.id);
    assert.equal(thread.replies.length, 1);
    assert.equal(thread.replies[0].text, 'Hermes reply saved.');
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
