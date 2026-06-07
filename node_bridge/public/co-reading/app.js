const state = {
  token: sessionStorage.getItem('co_reading_access_token') || '',
  books: [],
  chunks: [],
  bookId: '',
  chunkId: '',
};

const $ = (id) => document.getElementById(id);

function setStatus(text) {
  $('chunk-title').textContent = text;
}

async function api(path, options = {}) {
  const response = await fetch(`/api/co-reading${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${state.token}`,
      ...(options.headers || {}),
    },
  });
  const body = await response.json();
  if (!response.ok || body.ok === false) {
    throw new Error(body.error || `HTTP ${response.status}`);
  }
  return body;
}

async function refreshBooks() {
  const body = await api('/books');
  state.books = body.books || [];
  $('book-list').innerHTML = '';
  for (const book of state.books) {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.textContent = `${book.title} (${book.format}, ${book.state})`;
    button.onclick = () => openBook(book.id);
    li.appendChild(button);
    $('book-list').appendChild(li);
  }
}

async function openBook(bookId) {
  state.bookId = bookId;
  const chunks = await api(`/books/${encodeURIComponent(bookId)}/chunks`);
  state.chunks = chunks.chunks || [];
  const progress = await api(`/books/${encodeURIComponent(bookId)}/progress?device_id=browser`);
  const nextChunkId = progress.progress?.chunk_id || state.chunks[0]?.id;
  if (nextChunkId) await openChunk(nextChunkId);
}

async function openChunk(chunkId) {
  state.chunkId = chunkId;
  const body = await api(`/books/${encodeURIComponent(state.bookId)}/chunks/${encodeURIComponent(chunkId)}`);
  $('chunk-title').textContent = body.chunk.title || body.chunk.id;
  $('chunk-text').textContent = body.text || '';
  renderAnnotations(body.annotations || []);
  await api(`/books/${encodeURIComponent(state.bookId)}/progress`, {
    method: 'POST',
    body: JSON.stringify({ chunk_id: chunkId, offset: 0, device_id: 'browser' }),
  });
}

function renderAnnotations(annotations) {
  $('annotation-list').innerHTML = '';
  for (const annotation of annotations) {
    const card = document.createElement('div');
    card.className = 'annotation-card';
    const replies = (annotation.replies || []).map((reply) => `<p><b>${escapeHtml(reply.author)}:</b> ${escapeHtml(reply.text)}</p>`).join('');
    card.innerHTML = `
      <div class="meta">${escapeHtml(annotation.visibility)} · ${escapeHtml(annotation.id)}</div>
      <p><b>Quote:</b> ${escapeHtml(annotation.quote || '')}</p>
      <p>${escapeHtml(annotation.note || '')}</p>
      ${replies}
    `;
    if (annotation.visibility === 'shared') {
      const ask = document.createElement('button');
      ask.textContent = '问 Hermes';
      ask.onclick = async () => {
        const question = prompt('问 Hermes 什么？') || '';
        await api(`/annotations/${encodeURIComponent(annotation.id)}/ask-hermes`, {
          method: 'POST',
          body: JSON.stringify({ question }),
        });
        await openChunk(state.chunkId);
      };
      card.appendChild(ask);
    }
    $('annotation-list').appendChild(card);
  }
}

async function importPaste() {
  const body = await api('/import-paste', {
    method: 'POST',
    body: JSON.stringify({
      title: $('import-title').value.trim() || 'Untitled',
      format: $('import-format').value,
      text: $('import-text').value,
    }),
  });
  await refreshBooks();
  await openBook(body.book.id);
}

async function saveAnnotation() {
  if (!state.bookId || !state.chunkId) throw new Error('先打开一个 chunk');
  await api(`/books/${encodeURIComponent(state.bookId)}/annotations`, {
    method: 'POST',
    body: JSON.stringify({
      chunk_id: state.chunkId,
      quote: $('annotation-quote').value,
      note: $('annotation-note').value,
      visibility: $('annotation-visibility').value,
    }),
  });
  $('annotation-note').value = '';
  await openChunk(state.chunkId);
}

async function search() {
  const q = $('search-query').value.trim();
  const body = await api(`/books/${encodeURIComponent(state.bookId)}/search?q=${encodeURIComponent(q)}`);
  $('search-results').innerHTML = '';
  for (const hit of body.results || []) {
    const item = document.createElement('div');
    item.className = 'search-hit';
    item.innerHTML = `<b>${escapeHtml(hit.title || hit.chunk_id)}</b><p>${escapeHtml((hit.text || '').slice(0, 240))}</p>`;
    item.onclick = () => openChunk(hit.chunk_id);
    $('search-results').appendChild(item);
  }
}

function move(delta) {
  const index = state.chunks.findIndex((chunk) => chunk.id === state.chunkId);
  const next = state.chunks[index + delta];
  if (next) openChunk(next.id);
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

$('access-token').value = state.token;
$('save-token').onclick = async () => {
  state.token = $('access-token').value.trim();
  sessionStorage.setItem('co_reading_access_token', state.token);
  await refreshBooks();
};
$('refresh-books').onclick = refreshBooks;
$('import-submit').onclick = () => importPaste().catch((error) => alert(error.message));
$('annotation-submit').onclick = () => saveAnnotation().catch((error) => alert(error.message));
$('search-submit').onclick = () => search().catch((error) => alert(error.message));
$('prev-chunk').onclick = () => move(-1);
$('next-chunk').onclick = () => move(1);

if (state.token) {
  refreshBooks().catch((error) => setStatus(error.message));
}
