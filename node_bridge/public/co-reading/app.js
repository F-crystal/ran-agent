const TOKEN_KEY = 'CO_READING_WEB_ACCESS_TOKEN';
const VIEW_KEY = 'co_reading_current_view';
const DEVICE_ID = 'browser';

const state = {
  token: sessionStorage.getItem(TOKEN_KEY) || '',
  currentView: sessionStorage.getItem(VIEW_KEY) || 'reader',
  bookFilter: 'active',
  shelfCollapsed: true,
  books: [],
  chunks: [],
  annotations: [],
  bookId: '',
  chunkId: '',
  chunkText: '',
  selectedQuote: '',
  selectedQuoteOffset: null,
  loadingHermes: new Set(),
  hermesErrors: new Map(),
};

const $ = (id) => document.getElementById(id);

function setStatus(text, tone = 'neutral') {
  const node = $('app-status');
  node.textContent = text;
  node.dataset.tone = tone;
}

async function runAction(label, fn) {
  try {
    setStatus(`${label}...`);
    await fn();
    setStatus(`${label}完成`, 'ok');
  } catch (error) {
    setStatus(error.message || String(error), 'error');
  }
}

async function api(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${state.token}`,
    ...(options.headers || {}),
  };
  const response = await fetch(`/api/co-reading${path}`, { ...options, headers });
  let body = {};
  try {
    body = await response.json();
  } catch {
    body = {};
  }
  if (!response.ok || body.ok === false) {
    throw new Error(body.error || `HTTP ${response.status}`);
  }
  return body;
}

async function refreshBooks() {
  const body = await api('/books?include_trash=true');
  state.books = body.books || [];
  renderBooks();
}

function renderBooks() {
  const list = $('book-list');
  const books = state.books.filter((book) => (book.state || 'active') === state.bookFilter);
  list.innerHTML = '';
  if (!books.length) {
    list.innerHTML = `<li class="empty-card">没有 ${escapeHtml(state.bookFilter)} 书籍</li>`;
    return;
  }
  for (const book of books) {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `book-card ${book.id === state.bookId ? 'is-active' : ''} ${book.state !== 'active' ? 'is-muted' : ''}`;
    button.innerHTML = `
      <span class="book-title">${escapeHtml(book.title || 'Untitled')}</span>
      <span class="book-meta">${escapeHtml(book.author || book.source_uri || '来源未记录')}</span>
      <span class="book-badges">
        <span>${escapeHtml(book.format || 'unknown')}</span>
        <span class="state-badge state-${escapeHtml(book.state || 'active')}">${escapeHtml(book.state || 'active')}</span>
      </span>
      <span class="book-placeholders">${escapeHtml(bookStateLine(book))}</span>
    `;
    button.onclick = () => {
      if (book.state && book.state !== 'active') {
        setStatus(bookStateLine(book), 'error');
        return;
      }
      openBook(book.id);
    };
    li.appendChild(button);
    list.appendChild(li);
  }
}

function bookStateLine(book) {
  if (book.state === 'archived') return '正文已归档，不作为继续阅读入口';
  if (book.state === 'trash') return `回收站 · ${book.trash_expires_at ? `保留至 ${formatDate(book.trash_expires_at)}` : '等待清理'}`;
  return '进度同步中 · 最近阅读由 progress 恢复';
}

async function openBook(bookId) {
  state.bookId = bookId;
  state.chunkId = '';
  state.chunks = [];
  state.annotations = [];
  clearComposer();
  renderBooks();
  setStatus('加载目录...');
  const chunks = await api(`/books/${encodeURIComponent(bookId)}/chunks`);
  state.chunks = chunks.chunks || [];
  renderChunks();
  const progress = await api(`/books/${encodeURIComponent(bookId)}/progress?device_id=${encodeURIComponent(DEVICE_ID)}`);
  const nextChunkId = progress.progress?.chunk_id || state.chunks[0]?.id;
  if (nextChunkId) {
    await openChunk(nextChunkId);
    setView('reader');
  } else {
    setStatus('这本书没有 chunk', 'error');
  }
}

async function openChunk(chunkId) {
  if (!state.bookId || !chunkId) return;
  state.chunkId = chunkId;
  clearComposer();
  const body = await api(`/books/${encodeURIComponent(state.bookId)}/chunks/${encodeURIComponent(chunkId)}`);
  state.chunkText = body.text || '';
  state.annotations = body.annotations || [];
  $('chunk-title').textContent = body.chunk?.title || body.chunk?.id || 'Untitled chunk';
  $('chunk-text').textContent = state.chunkText;
  renderChunkMeta(body.chunk);
  renderChunks();
  renderAnnotations();
  await api(`/books/${encodeURIComponent(state.bookId)}/progress`, {
    method: 'POST',
    body: JSON.stringify({ chunk_id: chunkId, offset: 0, device_id: DEVICE_ID }),
  });
}

function renderChunkMeta(chunk = {}) {
  const index = state.chunks.findIndex((item) => item.id === state.chunkId);
  const book = state.books.find((item) => item.id === state.bookId);
  $('reader-subtitle').textContent = book?.title || '私人共读阅读器';
  $('chunk-kicker').textContent = book ? `${book.title}${book.author ? ` · ${book.author}` : ''}` : '未打开书籍';
  $('chunk-position').textContent = index >= 0 ? `${index + 1} / ${state.chunks.length}` : '--';
  if (chunk?.char_count) $('chunk-position').title = `${chunk.char_count} 字符`;
}

function renderChunks() {
  $('chunk-count').textContent = String(state.chunks.length);
  const list = $('chunk-list');
  list.className = state.chunks.length ? 'chunk-list' : 'chunk-list empty';
  list.innerHTML = '';
  if (!state.chunks.length) {
    list.textContent = '打开一本书后显示目录';
    return;
  }
  state.chunks.forEach((chunk, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `chunk-item ${chunk.id === state.chunkId ? 'is-active' : ''}`;
    button.innerHTML = `
      <span class="chunk-order">${index + 1}</span>
      <span class="chunk-main">
        <span class="chunk-name">${escapeHtml(chunk.title || chunk.id)}</span>
        <span class="chunk-info">${escapeHtml(chunk.id)} · ${Number(chunk.char_count || 0).toLocaleString()} 字符</span>
      </span>
    `;
    button.onclick = () => {
      openChunk(chunk.id);
      setView('reader');
    };
    list.appendChild(button);
  });
}

function renderAnnotations() {
  $('annotation-count').textContent = String(state.annotations.length);
  const list = $('annotation-list');
  list.className = state.annotations.length ? 'annotation-list' : 'annotation-list empty';
  list.innerHTML = '';
  if (!state.annotations.length) {
    list.textContent = '暂无批注。选中正文中的文字即可创建。';
    return;
  }
  for (const annotation of state.annotations) {
    const card = document.createElement('article');
    card.className = 'annotation-card';
    const replies = annotation.replies || [];
    const error = state.hermesErrors.get(annotation.id);
    card.innerHTML = `
      <div class="annotation-meta">
        <span class="visibility ${escapeHtml(annotation.visibility)}">${escapeHtml(annotation.visibility)}</span>
        <time>${formatDate(annotation.created_at)}</time>
      </div>
      <blockquote>${escapeHtml(annotation.quote || '')}</blockquote>
      <p class="annotation-note">${escapeHtml(annotation.note || '（无批注正文）')}</p>
      <div class="thread">
        <div class="thread-title">thread / replies · ${replies.length}</div>
        ${replies.map((reply) => `
          <div class="reply">
            <b>${escapeHtml(reply.author || 'unknown')}</b>
            <time>${formatDate(reply.created_at)}</time>
            <p>${escapeHtml(reply.text || '')}</p>
          </div>
        `).join('')}
      </div>
      ${error ? `<div class="inline-error">${escapeHtml(error)}</div>` : ''}
    `;
    if (annotation.visibility === 'shared') {
      card.appendChild(createHermesBox(annotation));
    }
    list.appendChild(card);
  }
}

function createHermesBox(annotation) {
  const box = document.createElement('div');
  box.className = 'hermes-box';
  const input = document.createElement('textarea');
  input.rows = 2;
  input.placeholder = '问 Hermes 关于这条 shared annotation 的问题';
  const button = document.createElement('button');
  button.type = 'button';
  const loading = state.loadingHermes.has(annotation.id);
  button.textContent = loading ? '发送中...' : '问 Hermes';
  button.disabled = loading;
  button.onclick = async () => {
    const question = input.value.trim();
    state.hermesErrors.delete(annotation.id);
    state.loadingHermes.add(annotation.id);
    renderAnnotations();
    try {
      await api(`/annotations/${encodeURIComponent(annotation.id)}/ask-hermes`, {
        method: 'POST',
        body: JSON.stringify({ question }),
      });
      await openChunk(state.chunkId);
      setStatus('Hermes 已回复', 'ok');
    } catch (error) {
      state.hermesErrors.set(annotation.id, error.message || String(error));
      setStatus('Hermes 请求失败', 'error');
      renderAnnotations();
    } finally {
      state.loadingHermes.delete(annotation.id);
      renderAnnotations();
    }
  };
  box.append(input, button);
  return box;
}

async function importPaste() {
  const text = $('import-text').value;
  if (!text.trim()) throw new Error('请先粘贴正文');
  const body = await api('/import-paste', {
    method: 'POST',
    body: JSON.stringify({
      title: $('import-title').value.trim() || 'Untitled',
      author: $('import-author').value.trim(),
      format: $('import-format').value,
      text,
    }),
  });
  $('import-text').value = '';
  await refreshBooks();
  await openBook(body.book.id);
}

async function importFile() {
  const file = $('file-input').files?.[0];
  if (!file) throw new Error('请选择文件');
  const dataBase64 = await fileToBase64(file);
  const body = await api('/import-file', {
    method: 'POST',
    body: JSON.stringify({
      filename: file.name,
      data_base64: dataBase64,
      title: $('file-title').value.trim(),
      author: $('file-author').value.trim(),
    }),
  });
  await refreshBooks();
  if (body.book?.id) await openBook(body.book.id);
}

async function importUrl() {
  const url = $('url-input').value.trim();
  if (!url) throw new Error('请填写 URL');
  const body = await api('/import-url', {
    method: 'POST',
    body: JSON.stringify({
      url,
      title: $('url-title').value.trim(),
      author: $('url-author').value.trim(),
    }),
  });
  await refreshBooks();
  if (body.book?.id) await openBook(body.book.id);
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
    reader.readAsDataURL(file);
  });
}

async function saveAnnotation(visibility) {
  if (!state.bookId || !state.chunkId) throw new Error('先打开一个 chunk');
  if (!state.selectedQuote.trim()) throw new Error('请先在正文中选中文字');
  await api(`/books/${encodeURIComponent(state.bookId)}/annotations`, {
    method: 'POST',
    body: JSON.stringify({
      chunk_id: state.chunkId,
      quote: state.selectedQuote,
      quote_offset: state.selectedQuoteOffset,
      note: $('annotation-note').value,
      visibility,
    }),
  });
  clearComposer();
  await openChunk(state.chunkId);
  setView('annotations');
}

async function search() {
  const q = $('search-query').value.trim();
  if (!state.bookId) throw new Error('请先打开一本书');
  if (!q) throw new Error('请输入搜索词');
  const body = await api(`/books/${encodeURIComponent(state.bookId)}/search?q=${encodeURIComponent(q)}`);
  const results = $('search-results');
  results.innerHTML = '';
  const hits = body.results || [];
  if (!hits.length) {
    results.innerHTML = '<div class="empty-card">没有搜索结果</div>';
    return;
  }
  for (const hit of hits) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'search-hit';
    item.innerHTML = `<b>${escapeHtml(hit.title || hit.chunk_id)}</b><p>${escapeHtml((hit.text || '').slice(0, 240))}</p>`;
    item.onclick = () => openChunk(hit.chunk_id);
    results.appendChild(item);
  }
}

function move(delta) {
  const index = state.chunks.findIndex((chunk) => chunk.id === state.chunkId);
  const next = state.chunks[index + delta];
  if (next) openChunk(next.id);
}

function captureSelection() {
  const selection = window.getSelection();
  const quote = String(selection?.toString() || '').trim();
  if (!quote) return;
  const range = selection.rangeCount ? selection.getRangeAt(0) : null;
  if (!range || !$('chunk-text').contains(range.commonAncestorContainer)) return;
  state.selectedQuote = quote.slice(0, 1200);
  state.selectedQuoteOffset = state.chunkText.indexOf(quote);
  if (state.selectedQuoteOffset < 0) state.selectedQuoteOffset = null;
  $('annotation-quote-preview').textContent = state.selectedQuote;
  $('annotation-composer').classList.remove('hidden');
  setView(window.matchMedia('(max-width: 760px)').matches ? 'annotations' : state.currentView);
}

function clearComposer() {
  state.selectedQuote = '';
  state.selectedQuoteOffset = null;
  $('annotation-note').value = '';
  $('annotation-quote-preview').textContent = '';
  $('annotation-composer').classList.add('hidden');
}

function setView(view) {
  state.currentView = view;
  sessionStorage.setItem(VIEW_KEY, view);
  $('co-reading-reader').dataset.view = view;
  document.querySelectorAll('.mobile-tabs button').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.view === view);
  });
}

function setShelfCollapsed(collapsed) {
  state.shelfCollapsed = collapsed;
  $('co-reading-reader').classList.toggle('shelf-collapsed', collapsed);
  $('toggle-shelf').textContent = collapsed ? '打开书架' : '收起书架';
}

function formatDate(value) {
  if (!value) return '时间未记录';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', { hour12: false });
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function bindEvents() {
  $('access-token').value = state.token;
  $('save-token').onclick = () => runAction('连接', async () => {
    state.token = $('access-token').value.trim();
    sessionStorage.setItem(TOKEN_KEY, state.token);
    await refreshBooks();
  });
  $('refresh-books').onclick = () => runAction('刷新书架', refreshBooks);
  $('import-submit').onclick = () => runAction('导入粘贴', importPaste);
  $('file-import-submit').onclick = () => runAction('导入文件', importFile);
  $('url-import-submit').onclick = () => runAction('导入 URL', importUrl);
  $('save-private').onclick = () => runAction('保存 private 批注', () => saveAnnotation('private'));
  $('save-shared').onclick = () => runAction('保存 shared 批注', () => saveAnnotation('shared'));
  $('cancel-annotation').onclick = clearComposer;
  $('search-submit').onclick = () => runAction('搜索', search);
  $('prev-chunk').onclick = () => move(-1);
  $('next-chunk').onclick = () => move(1);
  $('toggle-shelf').onclick = () => setShelfCollapsed(!state.shelfCollapsed);
  $('chunk-text').addEventListener('mouseup', captureSelection);
  $('chunk-text').addEventListener('keyup', captureSelection);
  document.querySelectorAll('.filter-button').forEach((button) => {
    button.onclick = () => {
      state.bookFilter = button.dataset.filter;
      document.querySelectorAll('.filter-button').forEach((item) => item.classList.toggle('is-active', item === button));
      renderBooks();
    };
  });
  document.querySelectorAll('.mobile-tabs button').forEach((button) => {
    button.onclick = () => setView(button.dataset.view);
  });
}

bindEvents();
setView(state.currentView);
setShelfCollapsed(state.shelfCollapsed);

if (state.token) {
  refreshBooks().then(() => setStatus('已连接', 'ok')).catch((error) => setStatus(error.message, 'error'));
} else {
  setStatus('请输入 CO_READING_WEB_ACCESS_TOKEN');
}
