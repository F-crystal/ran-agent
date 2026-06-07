# Co-Reading Runtime

Status: CURRENT (2026-06-08)

`co_reading` is the private shared reading room for Hermes and the owner. It is
book-first: EPUB, TXT, Markdown, pasted text, and PDF metadata/text-layer import
are supported. Web URL import is intentionally a provider interface only; it is
not hardwired to `search_hub` or `social_reader`.

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

## State Machine

Book states:

- `active`: chunk files are readable and searchable.
- `archived`: reading metadata is retained; callers should treat it as inactive
  until restored.
- `trash`: soft-deleted with `trashed_at` and `trash_expires_at`.

Archive, restore, delete, progress writes, annotation writes, and cleanup write
`reading_events`. Trash cleanup prunes only expired trash records.

## Privacy And Permission

Annotation visibility:

- `private`: never returned by Hermes-facing list/read/search tools.
- `shared`: visible to Hermes and the Web reader shared context.

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
- TXT: plain text chunking with loose chapter heading detection.
- Markdown: heading-aware chunking.
- Pasted text: direct text/Markdown import.
- PDF: detect simple text layer and import that text. Scanned PDFs are stored as
  book records with `ocr_required=true`; OCR is not performed.
- Web URL: provider interface only, reserved for later integration.

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

Important routes:

- `GET /api/books`
- `POST /api/books/import`
- `POST /api/books/import-paste`
- `POST /api/books/import-url`
- `GET /api/books/:book_id/chunks/:chunk_id`
- `GET /api/books/:book_id/context-window`
- `GET /api/books/:book_id/search`
- `POST /api/books/:book_id/annotations`
- `POST /api/books/:book_id/annotations/:annotation_id/share`
- `POST /api/books/:book_id/archive`
- `POST /api/books/:book_id/restore`
- `DELETE /api/books/:book_id`
- `POST /api/trash/cleanup`

