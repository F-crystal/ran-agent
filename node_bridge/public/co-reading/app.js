const TOKEN_KEY = 'CO_READING_WEB_ACCESS_TOKEN';
const VIEW_KEY = 'co_reading_current_view';
const COLLAPSED_ANNOTATIONS_KEY = 'co_reading_collapsed_annotations';
const DEVICE_ID = 'browser';
const AUTO_HERMES_QUESTION = '请作为共读者，对这条 shared annotation 分享你的读后感、联想或提醒。回应要具体、简洁，不要只是复述批注。';

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
  translationText: '',
  translationStatus: 'idle',
  translationCached: false,
  translationRequestId: '',
  translationCache: new Map(),
  selectedQuote: '',
  selectedQuoteOffset: null,
  selectedAnchorKind: 'original',
  selectedAnchorLang: 'source',
  pendingTrashBookId: '',
  loadingHermes: new Set(),
  depositingVault: new Set(),
  hermesErrors: new Map(),
  collapsedAnnotations: loadCollapsedAnnotations(),
  localThreadReplies: new Map(),
  activeAnnotationId: '',
  selectionCaptureTimer: null,
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
    const card = document.createElement('article');
    card.className = `book-card ${book.id === state.bookId ? 'is-active' : ''} ${book.state !== 'active' ? 'is-muted' : ''}`;
    const openButton = document.createElement('button');
    openButton.type = 'button';
    openButton.className = 'book-open';
    openButton.innerHTML = `
      <span class="book-title">${escapeHtml(book.title || 'Untitled')}</span>
      <span class="book-meta">${escapeHtml(book.author || book.source_uri || '来源未记录')}</span>
      <span class="book-badges">
        <span>${escapeHtml(book.format || 'unknown')}</span>
        <span class="state-badge state-${escapeHtml(book.state || 'active')}">${escapeHtml(book.state || 'active')}</span>
      </span>
      <span class="book-placeholders">${escapeHtml(bookStateLine(book))}</span>
    `;
    openButton.onclick = () => {
      if (book.state && book.state !== 'active') {
        setStatus(bookStateLine(book), 'error');
        return;
      }
      openBook(book.id);
    };
    card.appendChild(openButton);
    card.appendChild(createBookActions(book));
    li.appendChild(card);
    list.appendChild(li);
  }
}

function createBookActions(book) {
  const actions = document.createElement('div');
  actions.className = 'book-actions';
  const stateName = book.state || 'active';
  if (stateName === 'active') {
    actions.append(
      bookActionButton('归档', 'secondary compact', () => mutateBookState(book, 'archive')),
      bookActionButton(state.pendingTrashBookId === book.id ? '确认回收' : '回收站', 'danger compact', () => trashBook(book))
    );
  } else if (stateName === 'archived') {
    actions.append(
      bookActionButton('恢复', 'secondary compact', () => mutateBookState(book, 'restore')),
      bookActionButton(state.pendingTrashBookId === book.id ? '确认回收' : '回收站', 'danger compact', () => trashBook(book))
    );
  } else if (stateName === 'trash') {
    actions.append(bookActionButton('恢复', 'secondary compact', () => mutateBookState(book, 'restore')));
  }
  return actions;
}

function bookActionButton(label, className, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  button.onclick = (event) => {
    event.stopPropagation();
    Promise.resolve(onClick()).catch((error) => setStatus(error.message || String(error), 'error'));
  };
  return button;
}

async function mutateBookState(book, action) {
  state.pendingTrashBookId = '';
  const body = await api(`/books/${encodeURIComponent(book.id)}/${action}`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  await refreshBooks();
  const nextState = body.book?.state || '';
  if (book.id === state.bookId && nextState !== 'active') {
    clearCurrentBook();
  }
  setStatus(`${book.title || book.id} 已${actionLabel(action)}`, 'ok');
}

async function trashBook(book) {
  if (state.pendingTrashBookId !== book.id) {
    state.pendingTrashBookId = book.id;
    renderBooks();
    setStatus(`再点一次“确认回收”把《${book.title || book.id}》移入回收站`, 'error');
    return;
  }
  const body = await api(`/books/${encodeURIComponent(book.id)}/trash`, {
    method: 'POST',
    body: JSON.stringify({ confirm: true }),
  });
  state.pendingTrashBookId = '';
  await refreshBooks();
  if (book.id === state.bookId) clearCurrentBook();
  setStatus(`已移入回收站，保留至 ${formatDate(body.trash_expires_at)}`, 'ok');
}

function actionLabel(action) {
  if (action === 'archive') return '归档';
  if (action === 'restore') return '恢复';
  return action;
}

function clearCurrentBook() {
  state.bookId = '';
  state.chunkId = '';
  state.chunks = [];
  state.annotations = [];
  state.translationText = '';
  state.translationStatus = 'idle';
  state.translationCached = false;
  state.translationRequestId = '';
  state.chunkText = '';
  state.activeAnnotationId = '';
  $('chunk-title').textContent = '未打开书籍';
  $('chunk-text').textContent = '';
  $('reader-subtitle').textContent = '私人共读阅读器';
  $('chunk-kicker').textContent = '未打开书籍';
  $('chunk-position').textContent = '--';
  $('chunk-position-bottom').textContent = '--';
  renderChunks();
  renderAnnotations();
  clearComposer();
}

function bookStateLine(book) {
  if (book.state === 'archived') return '正文已归档，不作为继续阅读入口';
  if (book.state === 'trash') return `回收站 · ${book.trash_expires_at ? `保留至 ${formatDate(book.trash_expires_at)}` : '等待清理'}`;
  if (book.ocr_required) return 'PDF 无可读文本层，需要 OCR；当前 reader 不做 OCR';
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
    const book = state.books.find((item) => item.id === bookId);
    if (book?.ocr_required) {
      setStatus('这个 PDF 没有可读文本层，需要 OCR；当前 reader 不做 OCR', 'error');
    } else {
      setStatus('这本书没有可读 chunk', 'error');
    }
  }
}

async function openChunk(chunkId) {
  if (!state.bookId || !chunkId) return;
  if (state.chunkId && state.chunkId !== chunkId) state.activeAnnotationId = '';
  state.chunkId = chunkId;
  clearComposer();
  state.translationText = '';
  state.translationStatus = 'loading';
  state.translationCached = false;
  const body = await api(`/books/${encodeURIComponent(state.bookId)}/chunks/${encodeURIComponent(chunkId)}`);
  state.chunkText = body.text || '';
  state.annotations = body.annotations || [];
  $('chunk-title').textContent = body.chunk?.title || body.chunk?.id || 'Untitled chunk';
  renderReaderText();
  renderChunkMeta(body.chunk);
  renderChunks();
  renderAnnotations();
  await api(`/books/${encodeURIComponent(state.bookId)}/progress`, {
    method: 'POST',
    body: JSON.stringify({ chunk_id: chunkId, offset: 0, device_id: DEVICE_ID }),
  });
  loadTranslation(chunkId);
}

async function loadTranslation(chunkId, options = {}) {
  if (!state.bookId || !chunkId) return;
  const cacheKey = translationCacheKey(state.bookId, chunkId, 'zh-CN');
  const requestId = `${state.bookId}:${chunkId}:${Date.now()}`;
  state.translationRequestId = requestId;
  state.translationStatus = 'loading';
  if (options.force === true) {
    state.translationText = '';
    state.translationCached = false;
    state.translationCache.delete(cacheKey);
  } else {
    const cached = state.translationCache.get(cacheKey);
    if (cached?.text) {
      state.translationText = cached.text;
      state.translationCached = true;
      state.translationStatus = 'ready';
      renderReaderText();
    }
  }
  renderReaderText();
  try {
    const forceParam = options.force === true ? '&force=true' : '';
    const body = await api(`/books/${encodeURIComponent(state.bookId)}/chunks/${encodeURIComponent(chunkId)}/translation?target=zh-CN${forceParam}`);
    if (state.translationRequestId !== requestId || state.chunkId !== chunkId) return;
    state.translationText = body.translation?.text || '';
    state.translationCached = body.cached === true;
    state.translationStatus = state.translationText ? 'ready' : 'error';
    if (state.translationText) {
      state.translationCache.set(cacheKey, { text: state.translationText, cached: state.translationCached });
    }
    renderReaderText();
    if (options.force === true) setStatus('翻译已刷新', 'ok');
  } catch (error) {
    if (state.translationRequestId !== requestId || state.chunkId !== chunkId) return;
    state.translationText = '';
    state.translationStatus = 'error';
    renderReaderText();
    setStatus(`翻译失败：${error.message || String(error)}`, 'error');
  }
}

function translationCacheKey(bookId, chunkId, targetLang) {
  return `${bookId}:${chunkId}:${targetLang}`;
}

async function refreshTranslation() {
  if (!state.bookId || !state.chunkId) throw new Error('先打开一个 chunk');
  await loadTranslation(state.chunkId, { force: true });
}

function renderReaderText() {
  const container = $('chunk-text');
  container.innerHTML = '';
  if (!state.chunkText) return;
  const originals = splitParagraphsWithOffsets(state.chunkText);
  const translations = splitParagraphsWithOffsets(state.translationText);
  const activeAnnotation = currentActiveAnnotation();
  originals.forEach((original, index) => {
    const block = document.createElement('section');
    block.className = 'bilingual-block';
    const originalNode = document.createElement('p');
    originalNode.className = 'original-text';
    renderTextWithAnnotation(originalNode, original, activeAnnotation, 'original');
    const translationNode = document.createElement('p');
    translationNode.className = `translation-text translation-${state.translationStatus}`;
    renderTextWithAnnotation(translationNode, translationLineFor(index, translations), activeAnnotation, 'translation');
    block.append(originalNode, translationNode);
    container.appendChild(block);
  });
  if (translations.length > originals.length) {
    const extra = document.createElement('section');
    extra.className = 'bilingual-block translation-extra';
    const translationNode = document.createElement('p');
    translationNode.className = 'translation-text translation-ready';
    renderTextWithAnnotation(
      translationNode,
      {
        text: translations.slice(originals.length).map((paragraph) => paragraph.text).join('\n\n'),
        offset: translations[originals.length]?.offset ?? null,
      },
      activeAnnotation,
      'translation'
    );
    extra.appendChild(translationNode);
    container.appendChild(extra);
  }
}

function translationLineFor(index, translations) {
  if (state.translationStatus === 'loading') return { text: index === 0 ? '翻译中...' : '', offset: null };
  if (state.translationStatus === 'error') return { text: index === 0 ? '翻译暂不可用，原文仍可阅读。' : '', offset: null };
  return translations[index] || { text: '', offset: null };
}

function splitParagraphsWithOffsets(text) {
  const source = String(text || '');
  const paragraphs = [];
  const regex = /\S[\s\S]*?(?=\n{2,}|$)/g;
  for (const match of source.matchAll(regex)) {
    const raw = match[0];
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const leading = raw.search(/\S/);
    paragraphs.push({ text: trimmed, offset: match.index + (leading < 0 ? 0 : leading) });
  }
  return paragraphs;
}

function currentActiveAnnotation() {
  if (!state.activeAnnotationId) return null;
  return state.annotations.find((annotation) => annotation.id === state.activeAnnotationId) || null;
}

function renderTextWithAnnotation(node, paragraph, annotation, anchorKind) {
  const text = typeof paragraph === 'string' ? paragraph : paragraph?.text || '';
  const paragraphOffset = typeof paragraph?.offset === 'number' ? paragraph.offset : null;
  const highlight = annotationHighlightRange(text, paragraphOffset, annotation, anchorKind);
  if (!highlight) {
    node.textContent = text;
    return;
  }
  node.append(
    document.createTextNode(text.slice(0, highlight.start)),
    createAnnotationHighlight(text.slice(highlight.start, highlight.end)),
    document.createTextNode(text.slice(highlight.end))
  );
}

function annotationHighlightRange(text, paragraphOffset, annotation, anchorKind) {
  const quote = String(annotation?.quote || '').trim();
  if (!quote || annotation?.anchor_kind !== anchorKind) return null;
  const start = text.indexOf(quote);
  if (start < 0) return null;
  const quoteOffset = Number.isInteger(annotation.quote_offset) ? annotation.quote_offset : null;
  if (quoteOffset !== null && paragraphOffset !== null) {
    const localOffset = quoteOffset - paragraphOffset;
    if (localOffset >= 0 && localOffset + quote.length <= text.length && text.slice(localOffset, localOffset + quote.length) === quote) {
      return { start: localOffset, end: localOffset + quote.length };
    }
  }
  return { start, end: start + quote.length };
}

function createAnnotationHighlight(text) {
  const mark = document.createElement('mark');
  mark.className = 'annotation-highlight';
  mark.textContent = text;
  return mark;
}

function renderChunkMeta(chunk = {}) {
  const index = state.chunks.findIndex((item) => item.id === state.chunkId);
  const book = state.books.find((item) => item.id === state.bookId);
  $('reader-subtitle').textContent = book?.title || '私人共读阅读器';
  $('chunk-kicker').textContent = book ? `${book.title}${book.author ? ` · ${book.author}` : ''}` : '未打开书籍';
  const positionText = index >= 0 ? `${index + 1} / ${state.chunks.length}` : '--';
  $('chunk-position').textContent = positionText;
  $('chunk-position-bottom').textContent = positionText;
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
  list.querySelector('.chunk-item.is-active')?.scrollIntoView({ block: 'center', inline: 'nearest' });
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
    const collapsed = state.collapsedAnnotations.has(annotation.id);
    card.className = `annotation-card ${collapsed ? 'is-collapsed' : ''} ${state.activeAnnotationId === annotation.id ? 'is-active' : ''}`;
    const replies = renderableReplies(annotation);
    const error = state.hermesErrors.get(annotation.id);
    card.innerHTML = `
      <header class="annotation-header">
        <button class="annotation-toggle" type="button" aria-expanded="${collapsed ? 'false' : 'true'}">
          <span>${collapsed ? '展开' : '折叠'}</span>
          <b>${escapeHtml(annotation.note || annotation.quote || '批注')}</b>
        </button>
        <span class="reply-count">${replies.length}</span>
      </header>
      <div class="annotation-meta">
        <span class="visibility ${escapeHtml(annotation.visibility)}">${escapeHtml(annotation.visibility)}</span>
        <span class="anchor-badge">${escapeHtml(anchorLabel(annotation))}</span>
        <time>${formatDate(annotation.created_at)}</time>
      </div>
      <div class="annotation-body">
        <blockquote>${escapeHtml(annotation.quote || '')}</blockquote>
        <p class="annotation-note">${escapeHtml(annotation.note || '（无批注正文）')}</p>
        <div class="thread">
          <div class="thread-title">thread / replies · ${replies.length}</div>
          ${replies.map((reply) => `
          <div class="reply ${reply.local ? 'reply-local' : ''}">
            <b>${escapeHtml(reply.author || 'unknown')}</b>
            <time>${formatDate(reply.created_at)}</time>
            <p>${escapeHtml(reply.text || '')}</p>
            ${reply.local ? '<small>本地待同步显示；若刷新后消失，请重启服务器 Node 服务。</small>' : ''}
          </div>
          `).join('')}
        </div>
        ${error ? `<div class="inline-error">${escapeHtml(error)}</div>` : ''}
      </div>
    `;
    card.querySelector('.annotation-toggle').onclick = () => toggleAnnotation(annotation.id);
    card.querySelector('.annotation-body')?.addEventListener('click', (event) => {
      if (event.target.closest('button, textarea, input, select, a')) return;
      focusAnnotationQuote(annotation);
    });
    if (annotation.visibility === 'shared' && !collapsed) {
      const actions = document.createElement('div');
      actions.className = 'annotation-actions';
      actions.appendChild(createDepositButton(annotation));
      card.appendChild(actions);
      card.appendChild(createHermesBox(annotation));
    }
    list.appendChild(card);
  }
}

function createDepositButton(annotation) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'secondary compact';
  const loading = state.depositingVault.has(annotation.id);
  button.textContent = loading ? '沉淀中...' : '沉淀到 Vault';
  button.disabled = loading;
  button.onclick = async () => {
    state.depositingVault.add(annotation.id);
    renderAnnotations();
    try {
      const body = await api(`/annotations/${encodeURIComponent(annotation.id)}/deposit-vault`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setStatus(`已沉淀到 ${body.deposited?.vault_relative_path || 'vault inbox'}`, 'ok');
    } catch (error) {
      setStatus(`沉淀失败：${error.message || String(error)}`, 'error');
    } finally {
      state.depositingVault.delete(annotation.id);
      renderAnnotations();
    }
  };
  return button;
}

function renderableReplies(annotation) {
  const serverReplies = annotation.replies || [];
  const serverKeys = new Set(serverReplies.map(replyKey));
  const localReplies = state.localThreadReplies.get(annotation.id) || [];
  return [
    ...serverReplies,
    ...localReplies.filter((reply) => !serverKeys.has(replyKey(reply))),
  ];
}

function replyKey(reply = {}) {
  return `${reply.author || ''}:${reply.text || ''}`;
}

function toggleAnnotation(annotationId) {
  if (state.collapsedAnnotations.has(annotationId)) {
    state.collapsedAnnotations.delete(annotationId);
  } else {
    state.collapsedAnnotations.add(annotationId);
  }
  saveCollapsedAnnotations();
  renderAnnotations();
}

function focusAnnotationQuote(annotation) {
  if (!annotation?.id) return;
  state.activeAnnotationId = annotation.id;
  renderReaderText();
  renderAnnotations();
  setView('reader');
  requestAnimationFrame(() => {
    $('chunk-text').querySelector('.annotation-highlight')?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
  });
}

function loadCollapsedAnnotations() {
  try {
    const values = JSON.parse(sessionStorage.getItem(COLLAPSED_ANNOTATIONS_KEY) || '[]');
    return new Set(Array.isArray(values) ? values.filter((item) => typeof item === 'string') : []);
  } catch {
    return new Set();
  }
}

function saveCollapsedAnnotations() {
  sessionStorage.setItem(COLLAPSED_ANNOTATIONS_KEY, JSON.stringify([...state.collapsedAnnotations]));
}

function addLocalThreadReply(annotationId, text) {
  const value = String(text || '').trim();
  if (!value) return null;
  const reply = {
    id: `local-${Date.now()}`,
    author: 'user',
    text: value,
    created_at: new Date().toISOString(),
    local: true,
  };
  const replies = state.localThreadReplies.get(annotationId) || [];
  state.localThreadReplies.set(annotationId, [...replies, reply]);
  return reply.id;
}

function removeLocalThreadReply(annotationId, localId) {
  if (!localId) return;
  const replies = state.localThreadReplies.get(annotationId) || [];
  const next = replies.filter((reply) => reply.id !== localId);
  if (next.length) state.localThreadReplies.set(annotationId, next);
  else state.localThreadReplies.delete(annotationId);
}

function createHermesBox(annotation) {
  const box = document.createElement('div');
  box.className = 'hermes-box';
  const input = document.createElement('textarea');
  input.rows = 2;
  input.placeholder = (annotation.replies || []).length
    ? '继续追问 Hermes...'
    : 'Hermes 会自动回应；这里可继续追问';
  const button = document.createElement('button');
  button.type = 'button';
  const loading = state.loadingHermes.has(annotation.id);
  button.textContent = loading ? '回应中...' : '追问';
  button.disabled = loading;
  button.onclick = async () => {
    const question = input.value.trim();
    const localReplyId = addLocalThreadReply(annotation.id, question);
    state.hermesErrors.delete(annotation.id);
    state.loadingHermes.add(annotation.id);
    renderAnnotations();
    try {
      const body = await askHermes(annotation.id, question, { recordUserQuestion: true });
      if (body.user_reply?.id) {
        removeLocalThreadReply(annotation.id, localReplyId);
      } else if (question) {
        setStatus('Hermes 已回复；服务器后端可能还未重启，追问暂以本地待同步显示', 'error');
      }
      await openChunk(state.chunkId);
      if (body.user_reply?.id || !question) setStatus('Hermes 已回复', 'ok');
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

async function askHermes(annotationId, question, options = {}) {
  return await api(`/annotations/${encodeURIComponent(annotationId)}/ask-hermes`, {
    method: 'POST',
    body: JSON.stringify({
      question,
      record_user_question: options.recordUserQuestion === true,
    }),
  });
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
  if (body.import_summary?.ocr_required && body.import_summary?.chunk_count === 0) {
    setStatus('PDF 已入库，但没有可读文本层，需要 OCR；当前 reader 不做 OCR', 'error');
    renderBooks();
    return;
  }
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
  const body = await api(`/books/${encodeURIComponent(state.bookId)}/annotations`, {
    method: 'POST',
    body: JSON.stringify({
      chunk_id: state.chunkId,
      quote: state.selectedQuote,
      quote_offset: state.selectedQuoteOffset,
      anchor_kind: state.selectedAnchorKind,
      anchor_lang: state.selectedAnchorLang,
      note: $('annotation-note').value,
      visibility,
    }),
  });
  clearComposer();
  if (visibility === 'shared' && body.annotation?.id) {
    await autoAskHermes(body.annotation.id);
  } else {
    await openChunk(state.chunkId);
  }
  setView('annotations');
}

async function autoAskHermes(annotationId) {
  let hermesError = null;
  state.hermesErrors.delete(annotationId);
  state.loadingHermes.add(annotationId);
  await openChunk(state.chunkId);
  setView('annotations');
  try {
    await askHermes(annotationId, AUTO_HERMES_QUESTION);
  } catch (error) {
    hermesError = error.message || String(error);
    state.hermesErrors.set(annotationId, hermesError);
  } finally {
    state.loadingHermes.delete(annotationId);
    await openChunk(state.chunkId);
    setView('annotations');
  }
  if (hermesError) {
    throw new Error(`批注已保存，但 Hermes 自动回应失败：${hermesError}`);
  }
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
  const originalAnchor = closestElement(range.commonAncestorContainer, 'original-text');
  const translationAnchor = closestElement(range.commonAncestorContainer, 'translation-text');
  if (!originalAnchor && !translationAnchor) return;
  state.selectedQuote = quote.slice(0, 1200);
  state.selectedAnchorKind = translationAnchor ? 'translation' : 'original';
  state.selectedAnchorLang = translationAnchor ? 'zh-CN' : 'source';
  const sourceText = translationAnchor ? state.translationText : state.chunkText;
  state.selectedQuoteOffset = sourceText.indexOf(quote);
  if (state.selectedQuoteOffset < 0) state.selectedQuoteOffset = null;
  $('annotation-quote-preview').textContent = state.selectedQuote;
  $('annotation-quote-preview').dataset.anchorKind = state.selectedAnchorKind;
  $('annotation-composer').classList.remove('hidden');
  state.activeAnnotationId = '';
  renderAnnotations();
  setComposerOpen(true);
}

function scheduleSelectionCapture() {
  clearTimeout(state.selectionCaptureTimer);
  state.selectionCaptureTimer = setTimeout(captureSelection, 180);
}

function closestElement(node, className) {
  let current = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
  while (current) {
    if (current.classList?.contains(className)) return current;
    current = current.parentElement;
  }
  return null;
}

function clearComposer() {
  state.selectedQuote = '';
  state.selectedQuoteOffset = null;
  state.selectedAnchorKind = 'original';
  state.selectedAnchorLang = 'source';
  $('annotation-note').value = '';
  $('annotation-quote-preview').textContent = '';
  $('annotation-quote-preview').dataset.anchorKind = 'original';
  $('annotation-composer').classList.add('hidden');
  setComposerOpen(false);
}

function setView(view) {
  state.currentView = view;
  sessionStorage.setItem(VIEW_KEY, view);
  $('co-reading-reader').dataset.view = view;
  document.querySelectorAll('.mobile-tabs button').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.view === view);
  });
}

function setComposerOpen(open) {
  $('co-reading-reader').classList.toggle('composer-open', open);
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

function anchorLabel(annotation = {}) {
  return annotation.anchor_kind === 'translation' ? `译文 ${annotation.anchor_lang || 'zh-CN'}` : '原文';
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
  $('save-shared').onclick = () => runAction('保存 shared 批注并邀请 Hermes', () => saveAnnotation('shared'));
  $('cancel-annotation').onclick = clearComposer;
  $('search-submit').onclick = () => runAction('搜索', search);
  $('refresh-translation').onclick = () => runAction('刷新翻译', refreshTranslation);
  $('prev-chunk').onclick = () => move(-1);
  $('next-chunk').onclick = () => move(1);
  $('prev-chunk-bottom').onclick = () => move(-1);
  $('next-chunk-bottom').onclick = () => move(1);
  $('toggle-shelf').onclick = () => setShelfCollapsed(!state.shelfCollapsed);
  $('chunk-text').addEventListener('mouseup', scheduleSelectionCapture);
  $('chunk-text').addEventListener('keyup', scheduleSelectionCapture);
  $('chunk-text').addEventListener('touchend', scheduleSelectionCapture, { passive: true });
  document.addEventListener('selectionchange', scheduleSelectionCapture);
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
