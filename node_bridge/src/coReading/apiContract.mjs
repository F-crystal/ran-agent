export function buildCoReadingApiContract() {
  return {
    service: 'co_reading_web_reader',
    version: '0.1.0',
    storage: {
      root_dir_env: 'CO_READING_ROOT_DIR',
      default_root_dir: '.ran_agent_state/co_reading',
      text_source_of_truth: 'library/<book_id>/chunks/<chunk_id>.txt.gz',
      sqlite_role: 'metadata, progress, annotation state, events, storage stats, and FTS index',
      fts_rule: 'FTS rows are lookup indexes only. API and MCP readers must re-read chunk files by chunk_id before returning text.',
    },
    security: {
      owner_only_writes: true,
      owner_token_header: 'X-Co-Reading-Owner-Token',
      private_annotation_rule: 'private annotations are never returned by list/read/search APIs used by Hermes or unauthenticated readers',
    },
    states: {
      book: ['active', 'archived', 'trash'],
      annotation_visibility: ['private', 'shared'],
    },
    endpoints: [
      endpoint('GET', '/api/books', 'List non-trash books by default.', 'read'),
      endpoint('GET', '/api/books/:book_id', 'Read one book manifest and storage summary.', 'read'),
      endpoint('POST', '/api/books/import', 'Owner-only import EPUB/TXT/Markdown/PDF from uploaded file or server file path.', 'write'),
      endpoint('POST', '/api/books/import-paste', 'Owner-only import pasted text or Markdown.', 'write'),
      endpoint('POST', '/api/books/import-url', 'Owner-only reserved URL import entry. Provider interface is not hardwired to search_hub/social_reader.', 'write'),
      endpoint('GET', '/api/books/:book_id/chunks', 'List chunks without returning private annotations.', 'read'),
      endpoint('GET', '/api/books/:book_id/chunks/:chunk_id', 'Read one chunk plus shared/Hermes-visible annotations.', 'read'),
      endpoint('GET', '/api/books/:book_id/context-window', 'Read explicit bounded context around chunk_id with before/after caps.', 'read'),
      endpoint('GET', '/api/books/:book_id/search', 'FTS lookup, then chunk file readback. Does not return private annotations.', 'read'),
      endpoint('GET', '/api/books/:book_id/progress', 'Read synchronized progress for user/device.', 'read'),
      endpoint('POST', '/api/books/:book_id/progress', 'Owner-only update synchronized progress and write reading_events.', 'write'),
      endpoint('GET', '/api/books/:book_id/annotations', 'List shared/Hermes-visible annotations only unless owner UI explicitly asks private over authenticated route.', 'read'),
      endpoint('POST', '/api/books/:book_id/annotations', 'Owner-only create private/shared annotation. Default private.', 'write'),
      endpoint('POST', '/api/books/:book_id/annotations/:annotation_id/share', 'Owner-only mark annotation shared so Hermes can see it.', 'write'),
      endpoint('GET', '/api/books/:book_id/annotations/:annotation_id/thread', 'Read visible annotation thread.', 'read'),
      endpoint('POST', '/api/books/:book_id/annotations/:annotation_id/thread', 'Owner-only append user/Hermes reply under visible annotation.', 'write'),
      endpoint('POST', '/api/books/:book_id/archive', 'Owner-only set book state archived and write reading_events.', 'write'),
      endpoint('POST', '/api/books/:book_id/restore', 'Owner-only restore archived/trash book to active and write reading_events.', 'write'),
      endpoint('DELETE', '/api/books/:book_id', 'Owner-only soft delete into trash. Requires confirm=true and retention metadata.', 'destructive'),
      endpoint('POST', '/api/trash/cleanup', 'Owner-only prune expired trash and write reading_events before deletion.', 'destructive'),
      endpoint('GET', '/api/storage', 'Read storage stats and cleanup candidates.', 'read'),
      endpoint('GET', '/api/events', 'Read audit events for state changes, imports, progress, and cleanup.', 'read'),
    ],
    request_shapes: {
      import_paste: {
        title: 'string',
        author: 'string optional',
        format: 'text|txt|markdown',
        text: 'string',
      },
      import_book: {
        file_path: 'absolute server path or upload token resolved by the future HTTP layer',
        title: 'string optional',
        author: 'string optional',
      },
      annotation: {
        chunk_id: 'string',
        quote: 'string optional',
        quote_offset: 'integer optional',
        note: 'string',
        visibility: 'private|shared, default private',
      },
    },
  };
}

function endpoint(method, path, description, permission) {
  return { method, path, description, permission };
}
