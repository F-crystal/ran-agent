# Co-Reading Runtime

Status: CURRENT (2026-06-08)

`co_reading` is the private shared reading room for Hermes and the owner. It is
book-first: EPUB, TXT, Markdown, pasted text, local HTML, and PDF
metadata/text-layer import are supported. Web reader URL import reuses existing
read paths: normal URLs go through `search_hub`, and social URLs go through
`social_reader`. It does not introduce a separate crawling stack.

## Storage

Default local storage:

```text
/opt/ran_agent/.ran_agent_state/co_reading/
  reading.db
  library/
    <book_id>/
      chunks/
        <chunk_id>.txt.gz
  trash/
  exports/
```

SQLite stores metadata, progress, annotations, threads, events, imports,
storage stats, and FTS index rows. Chunk text source-of-truth is always the
gzip file under `library/<book_id>/chunks/`. FTS hits must be resolved by
`chunk_id` and then read back from the chunk file.

Chinese chunk translations are cached under
`library/<book_id>/translations/*.txt.gz`. SQLite stores translation metadata,
target language, provider, source hash, and path. Translation cache bytes are
counted in `reading_storage_stats.asset_bytes`.

Private content must not be committed. Keep `CO_READING_ROOT_DIR` under
`.ran_agent_state/` or another machine-local ignored path.

## SQLite Tables

- `reading_books`
- `reading_sections`
- `reading_chunks`
- `reading_progress`
- `reading_annotations`
- `reading_threads`
- `reading_events`
- `reading_imports`
- `reading_sessions`
- `reading_storage_stats`
- `reading_chunk_fts`
- `reading_translations`

## State Machine

Book states:

- `active`: chunk files are readable and searchable.
- `archived`: reading metadata is retained; callers should treat it as inactive
  until restored.
- `trash`: soft-deleted with `trashed_at` and `trash_expires_at`.

Archive, restore, delete, progress writes, annotation writes, and cleanup write
`reading_events`. Trash cleanup prunes only expired trash records.

The Web reader exposes the same state transitions through server-side wrapper
routes. Browser clients use only `CO_READING_WEB_ACCESS_TOKEN`; they never send
`CO_READING_OWNER_TOKEN`.

- Active books can be archived or moved to trash from the shelf.
- Archived books can be restored to active or moved to trash.
- Trash books can be restored until cleanup prunes expired trash records.
- Moving a book to trash is soft delete. It keeps retention metadata in
  `trashed_at` and `trash_expires_at`.

## Privacy And Permission

Annotation visibility:

- `private`: never returned by Hermes-facing list/read/search tools.
- `shared`: visible to Hermes and the Web reader shared context.

In the Web reader, saving a `shared` annotation automatically invites Hermes to
write one co-reading response into `reading_threads`. The inline Hermes box on
the annotation card is for follow-up questions, not the primary trigger.

Annotation anchors:

- `anchor_kind=original` anchors the quote to source chunk text.
- `anchor_kind=translation` anchors the quote to cached translated text.
- `anchor_lang=source` is used for original anchors; translated anchors use the
  target language such as `zh-CN`.

Hermes can read only:

- explicit chunks requested by `reading_read_chunk`;
- bounded context windows requested by `reading_get_context_window`;
- shared user annotations;
- Hermes-authored thread replies under visible annotations.

Write tools require owner authorization through `CO_READING_OWNER_TOKEN` and the
tool argument `owner_token`. Destructive tools also require explicit arguments
such as `confirm: true`.

## Import Rules

- EPUB: Python stdlib extractor reads OPF spine and XHTML/HTML body text.
  Imported sections are split into page-sized chunks so long chapters do not
  become one oversized reader chunk.
- TXT: plain text chunking with loose chapter heading detection and page-sized
  splitting for long paragraphs.
- Markdown: heading-aware chunking with page-sized splitting inside long
  sections.
- Pasted text: direct text/Markdown import.
- PDF: prefer `pdftotext` from Poppler for text-layer extraction, then fall
  back to a simple text operator scan. Scanned PDFs are stored as book records
  with `ocr_required=true`; OCR is not performed.
- Web URL: provider interface only, reserved for later integration.

Uploaded browser files are temporary. If a previous EPUB/PDF upload was
imported before parser changes, re-upload the file to generate new chunks. The
old upload payload is not retained for automatic reprocessing.

## Translation Rules

The Web reader renders bilingual reading by default: original text remains the
annotation anchor, and the Chinese translation is displayed below each original
paragraph.

- Browser clients request `/translation` with only `CO_READING_WEB_ACCESS_TOKEN`.
- Provider credentials stay on the server.
- Default provider is `hermes`, using `CO_READING_HERMES_API_BASE_URL`.
- Cache key is `chunk_id + target_lang + provider + source_hash`.
- If the chunk text changes, `source_hash` changes and the old translation is
  not reused.
- Translations are not inserted into FTS and are not used as Hermes private
  context unless separately surfaced by a future explicit tool.
- Users may annotate original or translated text. Shared translated annotations
  carry their anchor kind/language into the Hermes request context.
- Shared translated annotations can trigger the same automatic Hermes
  co-reading response as source-text annotations.

## MCP Tools

Read tools:

- `reading_list_books`
- `reading_list_chunks`
- `reading_get_progress`
- `reading_continue`
- `reading_read_chunk`
- `reading_get_context_window`
- `reading_search`
- `reading_list_annotations`
- `reading_read_thread`
- `reading_get_storage_stats`
- `reading_list_events`

Owner-only write tools:

- `reading_import_book`
- `reading_import_pasted_text`
- `reading_add_annotation`
- `reading_share_annotation`
- `reading_reply_to_annotation`
- `reading_mark_progress`
- `reading_archive_book`
- `reading_restore_book`
- `reading_delete_book`
- `reading_cleanup_trash`

## Web Reader API Contract

The canonical API contract is exported from
`node_bridge/src/coReading/apiContract.mjs` and exposed as MCP resource
`co-reading://api-contract`.

Tailscale-only Web reader deployment and security rules live in
`docs/governance/co-reading-web-reader.md`.

Important Web reader routes:

- `GET /reader`
- `GET /api/co-reading/books`
- `POST /api/co-reading/import-paste`
- `POST /api/co-reading/import-file`
- `POST /api/co-reading/import-url`
- `GET /api/co-reading/books/:book_id/chunks`
- `GET /api/co-reading/books/:book_id/chunks/:chunk_id`
- `GET /api/co-reading/books/:book_id/chunks/:chunk_id/translation`
- `POST /api/co-reading/books/:book_id/archive`
- `POST /api/co-reading/books/:book_id/restore`
- `POST /api/co-reading/books/:book_id/trash`
- `POST /api/co-reading/trash/cleanup`
- `GET /api/co-reading/books/:book_id/search`
- `GET /api/co-reading/books/:book_id/progress`
- `POST /api/co-reading/books/:book_id/progress`
- `POST /api/co-reading/books/:book_id/annotations`
- `POST /api/co-reading/annotations/:annotation_id/ask-hermes`
