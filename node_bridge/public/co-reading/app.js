/* 共读书房 Web Reader — vanilla JS.
   Sections: state → helpers → overlays (drawer/modals/popover) → shelf →
   reader/translation → annotations/composer → import/search → events/init.
   API routes and data semantics are unchanged; browser only ever sends
   CO_READING_WEB_ACCESS_TOKEN, kept in sessionStorage. */

const TOKEN_KEY = 'CO_READING_WEB_ACCESS_TOKEN';
const VIEW_KEY = 'co_reading_current_view';
const COLLAPSED_ANNOTATIONS_KEY = 'co_reading_collapsed_annotations';
const READER_PREFS_KEY = 'co_reading_reader_prefs';
const DEVICE_ID = 'browser';
const AUTO_HERMES_QUESTION = '请作为共读者，对这条 shared annotation 分享你的读后感、联想或提醒。回应要具体、简洁，不要只是复述批注。';

const state = {
  token: sessionStorage.getItem(TOKEN_KEY) || '',
  currentView: normalizeView(sessionStorage.getItem(VIEW_KEY)),
  bookFilter: 'active',
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
  selectedParagraph: null,
  paragraphRecords: new Map(),
  composerVisibility: 'private',
  composerGeneration: 0,
  composerSessionId: 0,
  composerSession: null,
  savingSubmission: null,
  saveRequestId: 0,
  savingToken: false,
  chunkLoadGeneration: 0,
  chunkLoadController: null,
  progressWriteChain: Promise.resolve(),
  lastModalFocus: null,
  reclaimingFocus: false,
  pendingTrashBookId: '',
  loadingHermes: new Set(),
  depositingVault: new Set(),
  hermesErrors: new Map(),
  hermesQuestions: new Map(),
  collapsedAnnotations: loadCollapsedAnnotations(),
  localThreadReplies: new Map(),
  activeAnnotationId: '',
  selectionCaptureTimer: null,
  selectionGeneration: 0,
  touchSelecting: false,
  lastSelectionTouch: false,
  drawerOpen: false,
  drawerTab: 'shelf',
  prefs: loadReaderPrefs(),
  overlayStack: [],
};

const $ = (id) => document.getElementById(id);
const isMobile = () => window.matchMedia('(max-width: 860px)').matches;

function normalizeView(view) {
  return view === 'annotations' ? 'annotations' : 'reader';
}

/* ---------- status ---------- */

function setStatus(text, tone = 'neutral') {
  $('app-status-text').textContent = text;
  $('app-status').dataset.tone = tone;
  $('app-status').title = text;
  const live = $('app-status-live');
  if (live) live.textContent = text;
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
  if (response.status === 401) {
    openAuthModal({ hint: '口令无效或已过期，请重新输入。' });
  }
  if (!response.ok || body.ok === false) {
    throw new Error(body.error || `HTTP ${response.status}`);
  }
  return body;
}

/* ---------- reader preferences (display only, localStorage) ---------- */

function loadReaderPrefs() {
  const defaults = { fontSize: 18, lineHeight: 1.8, measure: 720, textMode: 'bilingual' };
  try {
    const raw = JSON.parse(localStorage.getItem(READER_PREFS_KEY) || '{}');
    return {
      fontSize: clampNumber(raw.fontSize, 15, 22, defaults.fontSize),
      lineHeight: clampNumber(raw.lineHeight, 1.5, 2.1, defaults.lineHeight),
      measure: clampNumber(raw.measure, 620, 860, defaults.measure),
      textMode: ['original', 'bilingual', 'translation'].includes(raw.textMode) ? raw.textMode : defaults.textMode,
    };
  } catch {
    return defaults;
  }
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function saveReaderPrefs() {
  localStorage.setItem(READER_PREFS_KEY, JSON.stringify(state.prefs));
}

function applyReaderPrefs() {
  const root = document.documentElement;
  root.style.setProperty('--reader-font-size', `${state.prefs.fontSize}px`);
  root.style.setProperty('--reader-line-height', String(state.prefs.lineHeight));
  root.style.setProperty('--reader-measure', `${state.prefs.measure}px`);
  $('font-value').textContent = String(state.prefs.fontSize);
  $('line-value').textContent = state.prefs.lineHeight.toFixed(1);
  $('width-value').textContent = String(state.prefs.measure);
  applyTextMode();
}

function effectiveTextMode() {
  if (state.prefs.textMode === 'translation' && state.translationStatus === 'native') return 'original';
  return state.prefs.textMode;
}

function applyTextMode() {
  $('co-reading-reader').dataset.textMode = effectiveTextMode();
  document.querySelectorAll('.settings-mode').forEach((button) => {
    button.setAttribute('aria-pressed', button.dataset.textMode === state.prefs.textMode ? 'true' : 'false');
  });
}

function adjustPref(key, delta, min, max, step) {
  const next = clampNumber(Math.round((state.prefs[key] + delta) / step) * step, min, max, state.prefs[key]);
  state.prefs[key] = key === 'lineHeight' ? Number(next.toFixed(1)) : next;
  saveReaderPrefs();
  applyReaderPrefs();
}

/* ---------- overlays: drawer, search, settings, modals ---------- */

function pushOverlay(id, trigger) {
  state.overlayStack = state.overlayStack.filter((entry) => entry.id !== id);
  state.overlayStack.push({
    id,
    trigger: trigger || (document.activeElement instanceof HTMLElement ? document.activeElement : null),
  });
}

function popOverlay(id) {
  const index = state.overlayStack.findIndex((entry) => entry.id === id);
  if (index < 0) return null;
  const [entry] = state.overlayStack.splice(index, 1);
  return entry;
}

function topOverlay() {
  return state.overlayStack[state.overlayStack.length - 1] || null;
}

function restoreOverlayFocus(entry, fallbackId) {
  const trigger = entry?.trigger;
  const triggerUsable = trigger && document.contains(trigger) && !trigger.disabled && !trigger.hidden;
  const fallback = fallbackId ? $(fallbackId) : null;
  const fallbackUsable = fallback && document.contains(fallback) && !fallback.disabled && !fallback.hidden;
  const target = triggerUsable ? trigger : (fallbackUsable ? fallback : $('chunk-text'));
  target?.focus?.();
}

// Atomic close: update the stack and visibility first, sync inert/aria for the
// NEW stack, and only then move focus — never into a still-inert subtree.
function closeModalLayer(id, fallbackId) {
  const el = $(id);
  if (el.hidden) return;
  const entry = popOverlay(id);
  el.hidden = true;
  state.lastModalFocus = null;
  syncModalGuards();
  const nextModal = topOpenModal();
  if (nextModal) reclaimModalFocus(nextModal);
  else restoreOverlayFocus(entry, fallbackId);
}

function openDrawer(tab) {
  pushOverlay('nav-drawer');
  state.drawerOpen = true;
  if (tab) state.drawerTab = tab;
  $('nav-drawer').hidden = false;
  $('drawer-scrim').hidden = false;
  document.body.classList.add('drawer-open');
  $('toggle-drawer').setAttribute('aria-expanded', 'true');
  renderDrawerTabs();
  (state.drawerTab === 'toc' ? $('drawer-tab-toc') : $('drawer-tab-shelf')).focus();
}

function closeDrawer() {
  if (!state.drawerOpen) return;
  state.drawerOpen = false;
  $('nav-drawer').hidden = true;
  $('drawer-scrim').hidden = true;
  document.body.classList.remove('drawer-open');
  $('toggle-drawer').setAttribute('aria-expanded', 'false');
  restoreOverlayFocus(popOverlay('nav-drawer'), 'toggle-drawer');
}

function setDrawerTab(tab) {
  state.drawerTab = tab === 'toc' ? 'toc' : 'shelf';
  renderDrawerTabs();
}

function renderDrawerTabs() {
  document.querySelectorAll('[data-drawer-tab]').forEach((tab) => {
    const active = tab.dataset.drawerTab === state.drawerTab;
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
    tab.tabIndex = active ? 0 : -1;
  });
  $('shelf-panel').hidden = state.drawerTab !== 'shelf';
  $('toc-panel').hidden = state.drawerTab !== 'toc';
}

function toggleSearch(force) {
  const bar = $('search-bar');
  const open = typeof force === 'boolean' ? force : bar.hidden;
  if (open === !bar.hidden) return;
  bar.hidden = !open;
  $('toggle-search').setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open) {
    pushOverlay('search-bar');
    $('search-query').focus();
  } else {
    restoreOverlayFocus(popOverlay('search-bar'), 'toggle-search');
  }
}

function toggleSettings(force) {
  const popover = $('settings-popover');
  const open = typeof force === 'boolean' ? force : popover.hidden;
  if (open === !popover.hidden) return;
  popover.hidden = !open;
  $('toggle-settings').setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open) pushOverlay('settings-popover');
  else restoreOverlayFocus(popOverlay('settings-popover'), 'toggle-settings');
}

function openImportModal() {
  cancelPendingSelectionCapture();
  hideSelectionToolbar();
  pushOverlay('import-modal');
  $('import-modal').hidden = false;
  state.lastModalFocus = null;
  syncModalGuards();
  setImportTab('paste');
  $('import-title').focus();
}

function closeImportModal() {
  closeModalLayer('import-modal', 'open-import');
}

function setImportTab(tab) {
  document.querySelectorAll('[data-import-tab]').forEach((button) => {
    const active = button.dataset.importTab === tab;
    button.setAttribute('aria-selected', active ? 'true' : 'false');
    button.tabIndex = active ? 0 : -1;
  });
  document.querySelectorAll('[data-import-panel]').forEach((panel) => {
    panel.hidden = panel.dataset.importPanel !== tab;
  });
}

function openAuthModal({ hint = '' } = {}) {
  cancelPendingSelectionCapture();
  hideSelectionToolbar();
  $('access-token').value = '';
  $('auth-hint').textContent = hint;
  $('auth-hint').classList.toggle('hidden', !hint);
  $('clear-token').hidden = !state.token;
  $('auth-modal').hidden = false;
  pushOverlay('auth-modal');
  state.lastModalFocus = null;
  syncModalGuards();
  $('access-token').focus();
}

function closeAuthModal() {
  closeModalLayer('auth-modal', 'app-status');
}

function topOpenModal() {
  for (let index = state.overlayStack.length - 1; index >= 0; index -= 1) {
    const id = state.overlayStack[index].id;
    if ((id === 'auth-modal' || id === 'import-modal') && !$(id).hidden) return $(id);
  }
  if (!$('auth-modal').hidden) return $('auth-modal');
  if (!$('import-modal').hidden) return $('import-modal');
  return null;
}

function anyModalOpen() {
  return Boolean(topOpenModal());
}

function modalFocusables(modal) {
  return [...modal.querySelectorAll('button, input, textarea, select, [href], [tabindex]:not([tabindex="-1"])')]
    .filter((el) => !el.disabled && el.offsetParent !== null && !el.hidden);
}

function trapModalTab(event) {
  if (event.key !== 'Tab') return;
  const modal = topOpenModal();
  if (!modal) return;
  const focusables = modalFocusables(modal);
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

// Keep focus inside the top modal even when it escapes programmatically.
// Only true aria-modal dialogs (topOpenModal) engage the guard — drawer,
// popover, search bar and composer never grab global focus.
function syncModalGuards() {
  const modal = topOpenModal();
  for (const child of document.body.children) {
    if (child.tagName === 'SCRIPT') continue;
    const inert = Boolean(modal) && child !== modal;
    child.inert = inert;
    if (inert) child.setAttribute('aria-hidden', 'true');
    else child.removeAttribute('aria-hidden');
  }
}

function reclaimModalFocus(modal) {
  if (state.reclaimingFocus) return;
  state.reclaimingFocus = true;
  try {
    const last = state.lastModalFocus;
    const target = (last && modal.contains(last) && !last.disabled && !last.hidden)
      ? last
      : (modalFocusables(modal)[0] || modal.querySelector('.modal-card') || modal);
    target.focus();
  } finally {
    state.reclaimingFocus = false;
  }
}

function handleModalFocusIn(event) {
  const modal = topOpenModal();
  if (!modal) return;
  if (modal.contains(event.target)) {
    state.lastModalFocus = event.target;
    return;
  }
  reclaimModalFocus(modal);
}

/* ---------- shelf ---------- */

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
    const empty = document.createElement('li');
    empty.className = 'empty-row';
    empty.textContent = state.bookFilter === 'active' ? '书架是空的，用「导入」添加第一本书' : `没有${filterLabel(state.bookFilter)}书籍`;
    list.appendChild(empty);
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
        ${book.state && book.state !== 'active' ? `<span class="state-${escapeHtml(book.state)}">${escapeHtml(filterLabel(book.state))}</span>` : ''}
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

function filterLabel(filter) {
  if (filter === 'archived') return '归档';
  if (filter === 'trash') return '回收站';
  return '在读';
}

function createBookActions(book) {
  const actions = document.createElement('div');
  actions.className = 'book-actions';
  const stateName = book.state || 'active';
  if (stateName === 'active') {
    actions.append(
      bookActionButton('归档', 'text-button', () => mutateBookState(book, 'archive')),
      bookActionButton(state.pendingTrashBookId === book.id ? '确认回收' : '回收站', 'text-button danger', () => trashBook(book))
    );
  } else if (stateName === 'archived') {
    actions.append(
      bookActionButton('恢复', 'text-button', () => mutateBookState(book, 'restore')),
      bookActionButton(state.pendingTrashBookId === book.id ? '确认回收' : '回收站', 'text-button danger', () => trashBook(book))
    );
  } else if (stateName === 'trash') {
    actions.append(bookActionButton('恢复', 'text-button', () => mutateBookState(book, 'restore')));
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
  invalidateChunkLoads();
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
  $('chunk-title').textContent = '从书架选择一本书，开始阅读';
  $('chunk-text').textContent = '';
  $('topbar-book').textContent = '共读书房';
  $('topbar-chunk').textContent = '';
  $('chunk-kicker').textContent = '未打开书籍';
  $('chunk-position').textContent = '–';
  $('chunk-position-bottom').textContent = '–';
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
  invalidateChunkLoads();
  const generation = state.chunkLoadGeneration;
  // A newer openBook/openChunk supersedes every resume point of this call,
  // including two concurrent opens of the SAME book.
  const isCurrent = () => state.bookId === bookId && generation === state.chunkLoadGeneration;
  clearComposer();
  renderBooks();
  setStatus('加载目录...');
  const chunks = await api(`/books/${encodeURIComponent(bookId)}/chunks`);
  if (!isCurrent()) return;
  state.chunks = chunks.chunks || [];
  renderChunks();
  setDrawerTab('toc');
  const progress = await api(`/books/${encodeURIComponent(bookId)}/progress?device_id=${encodeURIComponent(DEVICE_ID)}`);
  if (!isCurrent()) return;
  const nextChunkId = progress.progress?.chunk_id || state.chunks[0]?.id;
  if (nextChunkId) {
    await openChunk(nextChunkId);
    if (state.bookId !== bookId) return;
    setView('reader');
    if (isMobile()) closeDrawer();
  } else {
    const book = state.books.find((item) => item.id === bookId);
    if (book?.ocr_required) {
      setStatus('这个 PDF 没有可读文本层，需要 OCR；当前 reader 不做 OCR', 'error');
    } else {
      setStatus('这本书没有可读 chunk', 'error');
    }
  }
}

/* ---------- reader & translation ---------- */

async function openChunk(chunkId) {
  if (!state.bookId || !chunkId) return;
  invalidateChunkLoads();
  const controller = new AbortController();
  state.chunkLoadController = controller;
  const generation = state.chunkLoadGeneration;
  const bookId = state.bookId;
  const isCurrent = () => generation === state.chunkLoadGeneration && state.bookId === bookId && state.chunkId === chunkId;
  if (state.chunkId && state.chunkId !== chunkId) state.activeAnnotationId = '';
  state.chunkId = chunkId;
  state.selectionGeneration += 1;
  clearComposer();
  state.translationText = '';
  state.translationStatus = 'loading';
  state.translationCached = false;
  let body;
  try {
    body = await api(`/books/${encodeURIComponent(bookId)}/chunks/${encodeURIComponent(chunkId)}`, { signal: controller.signal });
  } catch (error) {
    if (!isCurrent()) return; // stale response or aborted: drop entirely
    throw error;
  }
  if (!isCurrent()) return;
  state.chunkText = body.text || '';
  state.annotations = body.annotations || [];
  $('chunk-title').textContent = body.chunk?.title || body.chunk?.id || 'Untitled chunk';
  renderReaderText();
  renderChunkMeta(body.chunk);
  renderChunks();
  renderAnnotations();
  if (!isCurrent()) return;
  // Progress is a mutation: it is queued (latest-wins on the server) but
  // NEVER tied to the read abort controller and never awaited here, so a
  // stale in-flight write can neither be client-aborted nor block the new
  // chunk's body/translation.
  writeProgress(generation, bookId, chunkId);
  loadTranslation(chunkId);
}

function invalidateChunkLoads() {
  state.chunkLoadGeneration += 1;
  if (state.chunkLoadController) {
    state.chunkLoadController.abort();
    state.chunkLoadController = null;
  }
}

// Progress mutations are serialized: the next write is only SENT after the
// previous mutation's fetch has truly settled, so the server-observable
// commit order is fixed. A queued-but-unsent payload whose generation is
// stale is dropped (newer wins); an already-sent mutation is never aborted
// by a chunk switch. Payloads are immutable snapshots taken at enqueue time.
function writeProgress(generation, bookId, chunkId) {
  const isCurrent = () => generation === state.chunkLoadGeneration && state.bookId === bookId && state.chunkId === chunkId;
  const job = state.progressWriteChain.then(async () => {
    if (!isCurrent()) return; // unsent stale payload dropped
    try {
      await api(`/books/${encodeURIComponent(bookId)}/progress`, {
        method: 'POST',
        body: JSON.stringify({ chunk_id: chunkId, offset: 0, device_id: DEVICE_ID }),
      });
    } catch (error) {
      // Stale completion stays silent; only the owning context sees errors.
      if (isCurrent()) setStatus(`阅读进度保存失败：${error.message || String(error)}`, 'error');
    }
  });
  state.progressWriteChain = job;
  return job;
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
    if (body.source_is_target === true) {
      state.translationText = '';
      state.translationCached = true;
      state.translationStatus = 'native';
      renderReaderText();
      return;
    }
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
  state.paragraphRecords = new Map();
  if (!state.chunkText) {
    applyTextMode();
    return;
  }
  const originals = splitParagraphsWithOffsets(state.chunkText);
  const translations = splitParagraphsWithOffsets(state.translationText);
  const activeAnnotation = currentActiveAnnotation();
  // Canonical paragraphs live only in this map, keyed by a chunk-unique
  // paragraphId. DOM nodes carry the id for location; quote text/offsets are
  // always read back from the map, never from DOM text.
  const registerParagraph = (node, id, kind, lang, paragraph) => {
    node.dataset.paragraphId = id;
    state.paragraphRecords.set(id, {
      id,
      kind,
      lang,
      offset: paragraph.offset,
      text: paragraph.text,
      chunkId: state.chunkId,
      selectionGeneration: state.selectionGeneration,
    });
  };
  originals.forEach((original, index) => {
    const block = document.createElement('section');
    block.className = 'bilingual-block';
    const originalNode = document.createElement('p');
    originalNode.className = 'original-text';
    registerParagraph(originalNode, `original:${index}`, 'original', 'source', original);
    renderTextWithAnnotation(originalNode, original, activeAnnotation, 'original');
    block.append(originalNode);
    if (state.translationStatus !== 'native') {
      const translationNode = document.createElement('p');
      translationNode.className = `translation-text translation-${state.translationStatus}`;
      const line = translationLineFor(index, translations);
      if (state.translationStatus === 'loading' || state.translationStatus === 'error') {
        translationNode.dataset.placeholder = 'true';
      } else if (Number.isInteger(line.offset)) {
        registerParagraph(translationNode, `translation:${index}`, 'translation', 'zh-CN', line);
      }
      renderTextWithAnnotation(translationNode, line, activeAnnotation, 'translation');
      block.append(translationNode);
    }
    container.appendChild(block);
  });
  if (translations.length > originals.length) {
    // Every extra translation paragraph gets its own node and its own
    // chunk-unique canonical identity — never merged into one shared offset.
    const extra = document.createElement('section');
    extra.className = 'bilingual-block translation-extra';
    for (let index = originals.length; index < translations.length; index += 1) {
      const paragraph = translations[index];
      const translationNode = document.createElement('p');
      translationNode.className = 'translation-text translation-ready';
      registerParagraph(translationNode, `translation:${index}`, 'translation', 'zh-CN', paragraph);
      renderTextWithAnnotation(translationNode, paragraph, activeAnnotation, 'translation');
      extra.appendChild(translationNode);
    }
    container.appendChild(extra);
  }
  applyTextMode();
}

function translationLineFor(index, translations) {
  if (state.translationStatus === 'loading') return { text: index === 0 ? '翻译中...' : '', offset: null };
  if (state.translationStatus === 'error') return { text: index === 0 ? '翻译暂不可用，原文仍可阅读。' : '', offset: null };
  if (state.translationStatus === 'native') return { text: '', offset: null };
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
  $('topbar-book').textContent = book?.title || '共读书房';
  $('topbar-chunk').textContent = book ? ($('chunk-title').textContent || '') : '';
  $('chunk-kicker').textContent = book ? `${book.title}${book.author ? ` · ${book.author}` : ''}` : '未打开书籍';
  const positionText = index >= 0 ? `${index + 1} / ${state.chunks.length}` : '–';
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
        <span class="chunk-info">${Number(chunk.char_count || 0).toLocaleString()} 字符</span>
      </span>
    `;
    button.onclick = () => {
      openChunk(chunk.id);
      setView('reader');
      if (isMobile()) closeDrawer();
    };
    list.appendChild(button);
  });
  list.querySelector('.chunk-item.is-active')?.scrollIntoView({ block: 'center', inline: 'nearest' });
}

/* ---------- annotations & thread ---------- */

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
    const loading = state.loadingHermes.has(annotation.id);
    card.innerHTML = `
      <header class="annotation-header">
        <button class="annotation-toggle" type="button" aria-expanded="${collapsed ? 'false' : 'true'}">
          <span class="toggle-hint">${collapsed ? '展开' : '折叠'}</span>
          <b>${escapeHtml(annotation.note || annotation.quote || '批注')}</b>
        </button>
        <span class="reply-count">${replies.length ? `${replies.length} 条` : ''}</span>
      </header>
      <div class="annotation-meta">
        <span class="${annotation.visibility === 'shared' ? 'visibility-shared' : ''}">${annotation.visibility === 'shared' ? '共享 · Hermes 可见' : '私密'}</span>
        <span>${escapeHtml(anchorLabel(annotation))}</span>
        <time>${formatDate(annotation.created_at)}</time>
      </div>
      <div class="annotation-body">
        <blockquote>${escapeHtml(annotation.quote || '')}</blockquote>
        <p class="annotation-note">${escapeHtml(annotation.note || '（无批注正文）')}</p>
        ${replies.length || loading ? `
        <div class="thread">
          <div class="thread-title">对话 · ${replies.length}</div>
          ${replies.map((reply) => `
          <div class="reply ${reply.local ? 'reply-local' : ''}">
            <div class="reply-author">
              <b class="${reply.author === 'hermes' ? 'reply-author-hermes' : ''}">${escapeHtml(authorLabel(reply.author))}</b>
              <time>${formatDate(reply.created_at)}</time>
            </div>
            <p>${escapeHtml(reply.text || '')}</p>
            ${reply.local ? '<small>本地待同步显示；若刷新后消失，请重启服务器 Node 服务。</small>' : ''}
          </div>
          `).join('')}
          ${loading ? '<div class="hermes-status">Hermes 正在回应…</div>' : ''}
        </div>
        ` : ''}
        ${error ? `<div class="inline-error"><span>${escapeHtml(error)}</span><button class="text-button retry-hermes" type="button">重试</button></div>` : ''}
      </div>
    `;
    card.querySelector('.annotation-toggle').onclick = () => toggleAnnotation(annotation.id);
    card.querySelector('.retry-hermes')?.addEventListener('click', () => retryHermes(annotation));
    card.querySelector('.annotation-body')?.addEventListener('click', (event) => {
      if (event.target.closest('button, textarea, input, select, a')) return;
      focusAnnotationQuote(annotation);
    });
    if (annotation.visibility === 'shared' && !collapsed) {
      const actions = document.createElement('div');
      actions.className = 'annotation-actions';
      actions.appendChild(createDepositButton(annotation));
      card.querySelector('.annotation-body').appendChild(actions);
      card.querySelector('.annotation-body').appendChild(createHermesBox(annotation));
    }
    list.appendChild(card);
  }
}

function authorLabel(author) {
  if (author === 'hermes') return 'Hermes';
  if (author === 'user') return '你';
  return author || 'unknown';
}

function createDepositButton(annotation) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'text-button';
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
  button.className = 'primary-button';
  const loading = state.loadingHermes.has(annotation.id);
  button.textContent = loading ? '回应中...' : '追问';
  button.disabled = loading;
  button.onclick = async () => {
    const question = input.value.trim();
    state.hermesQuestions.set(annotation.id, question);
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

async function retryHermes(annotation) {
  const question = state.hermesQuestions.get(annotation.id) || AUTO_HERMES_QUESTION;
  state.hermesQuestions.set(annotation.id, question);
  state.hermesErrors.delete(annotation.id);
  state.loadingHermes.add(annotation.id);
  renderAnnotations();
  try {
    await askHermes(annotation.id, question, { recordUserQuestion: false });
    await openChunk(state.chunkId);
    setStatus('Hermes 已回复', 'ok');
  } catch (error) {
    state.hermesErrors.set(annotation.id, error.message || String(error));
    setStatus('Hermes 请求失败', 'error');
  } finally {
    state.loadingHermes.delete(annotation.id);
    renderAnnotations();
  }
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

/* ---------- selection toolbar & composer ---------- */

function captureSelection() {
  state.selectionCaptureTimer = null;
  if (state.touchSelecting) return;
  if (anyModalOpen()) {
    hideSelectionToolbar();
    return;
  }
  const selection = window.getSelection();
  const quote = String(selection?.toString() || '').trim();
  if (!quote) {
    hideSelectionToolbar();
    return;
  }
  const range = selection.rangeCount ? selection.getRangeAt(0) : null;
  if (!range || !$('chunk-text').contains(range.commonAncestorContainer)) {
    hideSelectionToolbar();
    return;
  }
  // Strict rule: the selection must start and end inside ONE source
  // paragraph (original or translation). Mixed-language, cross-paragraph,
  // cross-block, placeholder, or non-content selections are refused instead
  // of being silently anchored to the start node.
  const startPara = closestElement(range.startContainer, 'original-text') || closestElement(range.startContainer, 'translation-text');
  const endPara = closestElement(range.endContainer, 'original-text') || closestElement(range.endContainer, 'translation-text');
  if (!startPara || startPara !== endPara) {
    hideSelectionToolbar();
    return;
  }
  if (startPara.dataset.placeholder === 'true') {
    hideSelectionToolbar();
    return;
  }
  // Resolve the canonical paragraph by its unique id — never by text lookup,
  // so identical paragraphs or injected DOM text cannot confuse the anchor.
  const record = startPara.dataset.paragraphId
    ? state.paragraphRecords.get(startPara.dataset.paragraphId)
    : null;
  if (!record || record.chunkId !== state.chunkId || record.selectionGeneration !== state.selectionGeneration) {
    hideSelectionToolbar();
    return;
  }
  const localStart = rangeOffsetWithin(startPara, range);
  if (localStart === null) {
    hideSelectionToolbar();
    return;
  }
  const sourceText = record.kind === 'translation' ? state.translationText : state.chunkText;
  const sliced = quote.slice(0, 1200);
  const computedOffset = record.offset + localStart;
  if (sourceText.slice(computedOffset, computedOffset + sliced.length) !== sliced) {
    // Offset verification failed — refuse rather than save a wrong anchor.
    hideSelectionToolbar();
    return;
  }
  state.selectedQuote = sliced;
  state.selectedAnchorKind = record.kind;
  state.selectedAnchorLang = record.lang;
  state.selectedQuoteOffset = computedOffset;
  state.selectedParagraph = {
    id: record.id,
    kind: record.kind,
    lang: record.lang,
    offset: record.offset,
    text: record.text,
    chunkId: record.chunkId,
    selectionGeneration: record.selectionGeneration,
  };
  state.composerGeneration += 1; // a fresh selection revokes any in-flight submission's cleanup rights
  state.activeAnnotationId = '';
  renderAnnotations();
  showSelectionToolbar(range);
}

function rangeOffsetWithin(paraEl, range) {
  try {
    const pre = range.cloneRange();
    pre.selectNodeContents(paraEl);
    pre.setEnd(range.startContainer, range.startOffset);
    return pre.toString().length;
  } catch {
    return null;
  }
}

function showSelectionToolbar(range) {
  const toolbar = $('selection-toolbar');
  toolbar.hidden = false;
  const rect = range.getBoundingClientRect();
  const viewportHeight = window.visualViewport?.height || window.innerHeight;
  const toolbarWidth = toolbar.offsetWidth;
  const toolbarHeight = toolbar.offsetHeight;
  const left = Math.min(
    Math.max(8, rect.left + rect.width / 2 - toolbarWidth / 2),
    Math.max(8, window.innerWidth - toolbarWidth - 8)
  );
  // Touch: prefer below the selection so the bar does not cover the native
  // callout or the drag handles; mouse: prefer above.
  let top;
  if (state.lastSelectionTouch) {
    top = rect.bottom + 10;
    if (top + toolbarHeight > viewportHeight - 64) top = rect.top - toolbarHeight - 10;
  } else {
    top = rect.top - toolbarHeight - 10;
    if (top < 60) top = rect.bottom + 10;
  }
  top = Math.min(Math.max(8, top), Math.max(8, viewportHeight - toolbarHeight - 8));
  toolbar.style.left = `${left}px`;
  toolbar.style.top = `${top}px`;
}

function hideSelectionToolbar() {
  $('selection-toolbar').hidden = true;
}

function cancelPendingSelectionCapture() {
  clearTimeout(state.selectionCaptureTimer);
  state.selectionCaptureTimer = null;
}

function scheduleSelectionCapture(delay = 180) {
  cancelPendingSelectionCapture();
  const generation = state.selectionGeneration;
  state.selectionCaptureTimer = setTimeout(() => {
    state.selectionCaptureTimer = null;
    if (generation !== state.selectionGeneration) return;
    if (state.touchSelecting) return;
    if (anyModalOpen()) return;
    captureSelection();
  }, delay);
}

function closestElement(node, className) {
  let current = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
  while (current) {
    if (current.classList?.contains(className)) return current;
    current = current.parentElement;
  }
  return null;
}

function openComposer(visibility) {
  state.composerSessionId += 1;
  state.composerSession = state.composerSessionId;
  state.composerVisibility = visibility === 'shared' ? 'shared' : 'private';
  $('annotation-quote-preview').textContent = state.selectedQuote;
  $('annotation-quote-preview').dataset.anchorKind = state.selectedAnchorKind;
  renderComposerMode();
  setComposerSaving(false); // new session starts with unlocked controls, even if a background save is still in flight
  updateExpandQuoteButton();
  $('annotation-composer').classList.remove('hidden');
  setComposerOpen(true);
  hideSelectionToolbar();
  pushOverlay('composer');
  if (!isMobile()) $('annotation-note').focus();
}

function currentSelectedParagraph() {
  const paragraph = state.selectedParagraph;
  if (!paragraph || paragraph.chunkId !== state.chunkId) return null;
  if (paragraph.selectionGeneration !== state.selectionGeneration) return null;
  const record = state.paragraphRecords.get(paragraph.id);
  if (!record || record.offset !== paragraph.offset || record.selectionGeneration !== state.selectionGeneration) return null;
  return paragraph;
}

function updateExpandQuoteButton() {
  const paragraph = currentSelectedParagraph();
  $('expand-quote').hidden = !paragraph || !state.selectedQuote || paragraph.text === state.selectedQuote;
}

function expandQuoteToParagraph() {
  const paragraph = currentSelectedParagraph();
  if (!paragraph) return false;
  state.composerGeneration += 1; // anchor change revokes an in-flight save's cleanup rights
  state.selectedAnchorKind = paragraph.kind;
  state.selectedAnchorLang = paragraph.lang;
  state.selectedQuote = paragraph.text.slice(0, 1200);
  state.selectedQuoteOffset = paragraph.offset;
  $('annotation-quote-preview').textContent = state.selectedQuote;
  $('annotation-quote-preview').dataset.anchorKind = paragraph.kind;
  updateExpandQuoteButton();
  return true;
}

function renderComposerMode() {
  const shared = state.composerVisibility === 'shared';
  const anchorText = state.selectedAnchorKind === 'translation' ? '译文引用' : '原文引用';
  $('composer-kicker').textContent = `${shared ? '共享批注' : '私密批注'} · ${anchorText}`;
  $('composer-hint').textContent = shared
    ? '共享批注对 Hermes 可见，保存后会自动邀请 Hermes 回应，可沉淀到 Vault。'
    : '私密批注只保存在书房，不会发送给 Hermes，也不会沉淀到 Vault。';
  $('save-annotation').textContent = shared ? '保存并邀请 Hermes' : '保存私密批注';
  document.querySelectorAll('.composer-visibility button').forEach((button) => {
    button.setAttribute('aria-pressed', button.dataset.visibility === state.composerVisibility ? 'true' : 'false');
  });
}

function clearComposer() {
  cancelPendingSelectionCapture();
  state.composerSession = null;
  state.selectedQuote = '';
  state.selectedQuoteOffset = null;
  state.selectedAnchorKind = 'original';
  state.selectedAnchorLang = 'source';
  state.selectedParagraph = null;
  state.composerVisibility = 'private';
  $('annotation-note').value = '';
  $('annotation-quote-preview').textContent = '';
  $('annotation-quote-preview').dataset.anchorKind = 'original';
  $('annotation-composer').classList.add('hidden');
  setComposerOpen(false);
  hideSelectionToolbar();
  renderComposerMode();
  popOverlay('composer');
}

function setComposerSaving(saving) {
  const save = $('save-annotation');
  if (saving) {
    save.disabled = true;
    save.textContent = '保存中…';
    document.querySelectorAll('.composer-visibility button').forEach((button) => { button.disabled = true; });
  } else {
    save.disabled = false;
    document.querySelectorAll('.composer-visibility button').forEach((button) => { button.disabled = false; });
    renderComposerMode();
  }
}

async function saveAnnotation(visibility) {
  // Single-flight per composer session: a second click in the SAME session is
  // ignored, but a newer composer session is never blocked by a stale save.
  if (state.savingSubmission
    && state.savingSubmission.sessionId === state.composerSession
    && state.composerSession !== null) return false;
  if (!state.bookId || !state.chunkId) throw new Error('先打开一个 chunk');
  if (!state.selectedQuote.trim()) throw new Error('请先在正文中选中文字');
  const submission = {
    id: state.saveRequestId + 1,
    sessionId: state.composerSession,
    revision: state.composerGeneration,
    bookId: state.bookId,
    chunkId: state.chunkId,
  };
  state.saveRequestId = submission.id;
  state.savingSubmission = submission;
  setComposerSaving(true);
  // UI cleanup is allowed only while the composer is still exactly this
  // submission's session AND revision — a new composer, a new selection, a
  // note edit, a visibility change or an anchor change all revoke it.
  const ownsComposer = () => state.composerSession !== null
    && state.composerSession === submission.sessionId
    && state.composerGeneration === submission.revision;
  try {
    const body = await api(`/books/${encodeURIComponent(submission.bookId)}/annotations`, {
      method: 'POST',
      body: JSON.stringify({
        chunk_id: submission.chunkId,
        quote: state.selectedQuote,
        quote_offset: state.selectedQuoteOffset,
        anchor_kind: state.selectedAnchorKind,
        anchor_lang: state.selectedAnchorLang,
        note: $('annotation-note').value,
        visibility,
      }),
    });
    const mayTouchUI = ownsComposer();
    submission.ownedAtCompletion = mayTouchUI;
    if (mayTouchUI) {
      clearComposer();
      window.getSelection()?.removeAllRanges?.();
    }
    // After our own intentional clearComposer the session is null; further
    // refresh stays allowed only while no NEW composer session has appeared.
    const uiClear = () => mayTouchUI && state.composerSession === null;
    if (visibility === 'shared' && body.annotation?.id) {
      await autoAskHermes(body.annotation.id, submission, uiClear);
    } else if (uiClear() && state.chunkId === submission.chunkId && state.bookId === submission.bookId) {
      await openChunk(submission.chunkId);
      if (uiClear()) setView('annotations');
    }
    return { owned: mayTouchUI };
  } catch (error) {
    error.saveOwned = submission.ownedAtCompletion === true || ownsComposer();
    throw error;
  } finally {
    if (state.savingSubmission?.id === submission.id) {
      state.savingSubmission = null;
      // Unlock only the session that owns this submission — never a newer one.
      if (state.composerSession !== null && state.composerSession === submission.sessionId) {
        setComposerSaving(false);
      }
    }
  }
}

// Production status path for annotation saves. All status writes are scoped
// to the submission's composer session/revision: a stale success, error or
// finally stays silent instead of polluting a newer composer. runAction is
// intentionally not used here so its automatic status writes cannot leak.
async function saveAnnotationWithStatus(visibility) {
  const sessionAtStart = state.composerSession;
  const revisionAtStart = state.composerGeneration;
  const ownsStatus = () => state.composerSession !== null
    && state.composerSession === sessionAtStart
    && state.composerGeneration === revisionAtStart;
  const label = visibility === 'shared' ? '保存 shared 批注并邀请 Hermes' : '保存 private 批注';
  setStatus(`${label}...`);
  try {
    const result = await saveAnnotation(visibility);
    if (result === false) return; // merged duplicate click — nothing to report
    // The save owned the composer at completion: it may confirm while no NEW
    // composer session has appeared (its own clearComposer set it to null).
    const mayConfirm = result?.owned === true
      && (state.composerSession === null || state.composerSession === sessionAtStart);
    if (mayConfirm) setStatus(`${label}完成`, 'ok');
  } catch (error) {
    const owned = error?.saveOwned === true
      ? (state.composerSession === null || state.composerSession === sessionAtStart)
      : ownsStatus();
    if (owned) setStatus(error.message || String(error), 'error');
  }
}

async function autoAskHermes(annotationId, submission, uiAllowed) {
  // Hermes is always invited exactly once for a shared save. UI refresh
  // happens only while the save still owns the screen — uiAllowed() turns
  // false the moment a newer composer session appears.
  const refreshIfCurrent = async () => {
    if (uiAllowed() && state.chunkId === submission.chunkId && state.bookId === submission.bookId) {
      await openChunk(state.chunkId);
      if (uiAllowed()) setView('annotations');
    }
  };
  let hermesError = null;
  state.hermesQuestions.set(annotationId, AUTO_HERMES_QUESTION);
  state.hermesErrors.delete(annotationId);
  state.loadingHermes.add(annotationId);
  await refreshIfCurrent();
  try {
    await askHermes(annotationId, AUTO_HERMES_QUESTION);
  } catch (error) {
    hermesError = error.message || String(error);
    state.hermesErrors.set(annotationId, hermesError);
  } finally {
    state.loadingHermes.delete(annotationId);
    await refreshIfCurrent();
  }
  if (hermesError) {
    throw new Error(`批注已保存，但 Hermes 自动回应失败：${hermesError}`);
  }
}

/* ---------- import ---------- */

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
  closeImportModal();
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
  closeImportModal();
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
  closeImportModal();
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

/* ---------- search ---------- */

async function search() {
  const q = $('search-query').value.trim();
  if (!state.bookId) throw new Error('请先打开一本书');
  if (!q) throw new Error('请输入搜索词');
  const body = await api(`/books/${encodeURIComponent(state.bookId)}/search?q=${encodeURIComponent(q)}`);
  const results = $('search-results');
  results.innerHTML = '';
  const hits = body.results || [];
  if (!hits.length) {
    results.innerHTML = '<div class="search-empty">没有搜索结果</div>';
    return;
  }
  for (const hit of hits) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'search-hit';
    item.innerHTML = `<b>${escapeHtml(hit.title || hit.chunk_id)}</b><p>${escapeHtml((hit.text || '').slice(0, 240))}</p>`;
    item.onclick = () => {
      openChunk(hit.chunk_id);
      if (isMobile()) toggleSearch(false);
    };
    results.appendChild(item);
  }
}

/* ---------- navigation & view ---------- */

function move(delta) {
  const index = state.chunks.findIndex((chunk) => chunk.id === state.chunkId);
  const next = state.chunks[index + delta];
  if (next) {
    hideSelectionToolbar();
    openChunk(next.id);
  }
}

function setView(view) {
  state.currentView = normalizeView(view);
  sessionStorage.setItem(VIEW_KEY, state.currentView);
  $('co-reading-reader').dataset.view = state.currentView;
  document.querySelectorAll('.mobile-tabs button').forEach((button) => {
    if (!button.dataset.view) return;
    const active = button.dataset.view === state.currentView;
    button.classList.toggle('is-active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
}

function setComposerOpen(open) {
  $('co-reading-reader').classList.toggle('composer-open', open);
}

const INTERACTIVE_SELECTOR = 'input, textarea, select, button, [contenteditable="true"], [contenteditable=""], [role="dialog"], .popover, .drawer, .search-bar, .annotation-composer, .mobile-tabs';

function isInteractiveTarget(target) {
  return Boolean(target?.closest?.(INTERACTIVE_SELECTOR));
}

const OVERLAY_CLOSERS = {
  'import-modal': () => closeImportModal(),
  'auth-modal': () => closeAuthModal(),
  'settings-popover': () => toggleSettings(false),
  'search-bar': () => toggleSearch(false),
  'nav-drawer': () => closeDrawer(),
  composer: () => {
    clearComposer();
    window.getSelection()?.removeAllRanges?.();
  },
};

function handleEscape() {
  // Close only the topmost overlay (LIFO); never collapse several layers at once.
  const top = topOverlay();
  if (top && OVERLAY_CLOSERS[top.id]) {
    OVERLAY_CLOSERS[top.id]();
    return;
  }
  if (!top) hideSelectionToolbar();
}

/* ---------- misc helpers ---------- */

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

/* ---------- events & init ---------- */

function bindEvents() {
  $('toggle-drawer').onclick = () => (state.drawerOpen ? closeDrawer() : openDrawer());
  $('close-drawer').onclick = closeDrawer;
  $('drawer-scrim').onclick = closeDrawer;
  document.querySelectorAll('[data-drawer-tab]').forEach((tab) => {
    tab.onclick = () => setDrawerTab(tab.dataset.drawerTab);
  });
  $('mobile-open-drawer').onclick = () => openDrawer('shelf');

  $('app-status').onclick = () => openAuthModal();
  $('close-auth').onclick = closeAuthModal;
  $('save-token').onclick = () => {
    const input = $('access-token');
    const next = input.value.trim();
    // Drop the secret from the DOM first — before any guard, branch or async
    // work — so a re-typed token can never linger during a pending request.
    input.value = '';
    input.removeAttribute('value');
    if (!next) {
      setStatus('请输入访问口令', 'error');
      return;
    }
    if (state.savingToken) return; // only blocks a second request, never the clearing
    state.savingToken = true;
    setStatus('连接...');
    (async () => {
      try {
        state.token = next;
        sessionStorage.setItem(TOKEN_KEY, next);
        await refreshBooks();
        closeAuthModal();
        setStatus('连接完成', 'ok');
      } catch (error) {
        setStatus(error.message || String(error), 'error');
      } finally {
        state.savingToken = false;
      }
    })();
  };
  $('clear-token').onclick = () => {
    state.token = '';
    sessionStorage.removeItem(TOKEN_KEY);
    $('access-token').value = '';
    $('clear-token').hidden = true;
    $('auth-hint').textContent = '已清除本机保存的口令。';
    $('auth-hint').classList.remove('hidden');
    setStatus('未连接');
  };
  $('access-token').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') $('save-token').click();
  });

  $('toggle-search').onclick = () => toggleSearch();
  $('close-search').onclick = () => toggleSearch(false);
  $('search-submit').onclick = () => runAction('搜索', search);
  $('search-query').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') runAction('搜索', search);
  });

  $('toggle-settings').onclick = () => toggleSettings();
  document.querySelectorAll('.settings-mode').forEach((button) => {
    button.onclick = () => {
      state.prefs.textMode = button.dataset.textMode;
      saveReaderPrefs();
      applyReaderPrefs();
    };
  });
  $('font-decrease').onclick = () => adjustPref('fontSize', -1, 15, 22, 1);
  $('font-increase').onclick = () => adjustPref('fontSize', 1, 15, 22, 1);
  $('line-decrease').onclick = () => adjustPref('lineHeight', -0.1, 1.5, 2.1, 0.1);
  $('line-increase').onclick = () => adjustPref('lineHeight', 0.1, 1.5, 2.1, 0.1);
  $('width-decrease').onclick = () => adjustPref('measure', -20, 620, 860, 20);
  $('width-increase').onclick = () => adjustPref('measure', 20, 620, 860, 20);
  $('refresh-translation').onclick = () => runAction('刷新翻译', refreshTranslation);

  $('open-import').onclick = openImportModal;
  $('close-import').onclick = closeImportModal;
  document.querySelectorAll('[data-import-tab]').forEach((tab) => {
    tab.onclick = () => setImportTab(tab.dataset.importTab);
  });
  $('import-submit').onclick = () => runAction('导入粘贴', importPaste);
  $('file-import-submit').onclick = () => runAction('导入文件', importFile);
  $('url-import-submit').onclick = () => runAction('导入 URL', importUrl);

  $('refresh-books').onclick = () => runAction('刷新书架', refreshBooks);
  document.querySelectorAll('.filter-button').forEach((button) => {
    button.onclick = () => {
      state.bookFilter = button.dataset.filter;
      document.querySelectorAll('.filter-button').forEach((item) => {
        item.classList.toggle('is-active', item === button);
        item.setAttribute('aria-pressed', item === button ? 'true' : 'false');
      });
      renderBooks();
    };
  });

  $('prev-chunk').onclick = () => move(-1);
  $('next-chunk').onclick = () => move(1);
  $('prev-chunk-bottom').onclick = () => move(-1);
  $('next-chunk-bottom').onclick = () => move(1);

  $('select-private').onclick = () => openComposer('private');
  $('select-shared').onclick = () => openComposer('shared');
  $('select-paragraph').onclick = () => {
    if (expandQuoteToParagraph()) openComposer(state.composerVisibility);
  };
  $('selection-toolbar').addEventListener('mousedown', (event) => event.preventDefault());
  document.querySelectorAll('.composer-visibility button').forEach((button) => {
    button.onclick = () => {
      state.composerVisibility = button.dataset.visibility;
      state.composerGeneration += 1; // editing during a save revokes that save's cleanup rights
      renderComposerMode();
    };
  });
  $('save-annotation').onclick = () => {
    saveAnnotationWithStatus(state.composerVisibility);
  };
  $('cancel-annotation').onclick = () => {
    clearComposer();
    window.getSelection()?.removeAllRanges();
  };
  $('annotation-note').addEventListener('input', () => {
    state.composerGeneration += 1; // editing during a save revokes that save's cleanup rights
  });

  $('chunk-text').addEventListener('mouseup', () => {
    state.lastSelectionTouch = false;
    scheduleSelectionCapture(180);
  });
  $('chunk-text').addEventListener('keyup', () => scheduleSelectionCapture(180));
  $('chunk-text').addEventListener('mousedown', (event) => {
    if (event.button === 0) hideSelectionToolbar();
  });
  $('chunk-text').addEventListener('touchstart', () => {
    state.touchSelecting = true;
    state.lastSelectionTouch = true;
    hideSelectionToolbar();
  }, { passive: true });
  $('chunk-text').addEventListener('touchend', () => {
    state.touchSelecting = false;
    state.lastSelectionTouch = true;
    scheduleSelectionCapture(420);
  }, { passive: true });
  $('chunk-text').addEventListener('touchcancel', () => {
    state.touchSelecting = false;
    state.lastSelectionTouch = true;
    cancelPendingSelectionCapture();
    hideSelectionToolbar();
  }, { passive: true });
  document.addEventListener('selectionchange', () => scheduleSelectionCapture(state.lastSelectionTouch ? 420 : 180));
  $('expand-quote').onclick = expandQuoteToParagraph;
  window.addEventListener('scroll', hideSelectionToolbar, { capture: true, passive: true });
  window.addEventListener('resize', hideSelectionToolbar, { passive: true });

  document.querySelectorAll('.mobile-tabs button').forEach((button) => {
    if (button.dataset.view) button.onclick = () => setView(button.dataset.view);
  });

  document.addEventListener('focusin', handleModalFocusIn);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Tab') {
      trapModalTab(event);
      return;
    }
    if (event.key === 'Escape') {
      handleEscape();
      return;
    }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    if (event.isComposing || event.defaultPrevented) return;
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    if (isInteractiveTarget(event.target) || anyModalOpen()) return;
    if (state.touchSelecting) return;
    if (!state.bookId || !state.chunkId) return;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && $('chunk-text')?.contains(selection.anchorNode)) return;
    const delta = event.key === 'ArrowLeft' ? -1 : 1;
    const index = state.chunks.findIndex((chunk) => chunk.id === state.chunkId);
    if (!state.chunks[index + delta]) return;
    event.preventDefault();
    move(delta);
  });

  document.addEventListener('click', (event) => {
    if (!$('settings-popover').hidden
      && !event.target.closest('#settings-popover, #toggle-settings')) {
      toggleSettings(false);
    }
  });
}

bindEvents();
applyReaderPrefs();
setView(state.currentView);
renderDrawerTabs();

if (state.token) {
  refreshBooks()
    .then(() => setStatus('已连接', 'ok'))
    .catch((error) => {
      setStatus(error.message, 'error');
      openAuthModal({ hint: '使用已保存的口令连接失败，请检查口令或服务是否在线。' });
    });
} else {
  setStatus('未连接');
  openAuthModal();
}
