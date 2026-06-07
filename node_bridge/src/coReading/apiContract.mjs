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
      web_access_token_header: 'Authorization: Bearer <CO_READING_WEB_ACCESS_TOKEN>',
      owner_token_server_only: 'CO_READING_OWNER_TOKEN stays on the server and is never sent to browser HTML, JavaScript, localStorage, logs, or API responses.',
      private_annotation_rule: 'private annotations are never returned by list/read/search APIs used by Hermes or unauthenticated readers',
    },
    states: {
      book: ['active', 'archived', 'trash'],
      annotation_visibility: ['private', 'shared'],
    },
    endpoints: [
      endpoint('GET', '/reader', 'Serve the static Web reader shell.', 'public-shell'),
      endpoint('GET', '/api/co-reading/books', 'List non-trash books by default.', 'web-token'),
      endpoint('GET', '/api/co-reading/books/:book_id', 'Read one book manifest and storage summary.', 'web-token'),
      endpoint('POST', '/api/co-reading/import-paste', 'Server-side import of pasted text or Markdown. Browser never sends owner token.', 'web-token-write-wrapper'),
      endpoint('GET', '/api/co-reading/books/:book_id/chunks', 'List chunks for the reader.', 'web-token'),
      endpoint('GET', '/api/co-reading/books/:book_id/chunks/:chunk_id', 'Read one chunk plus owner-visible sidebar annotations. Text is read back from .txt.gz chunk files.', 'web-token'),
      endpoint('GET', '/api/co-reading/books/:book_id/search', 'FTS lookup, then chunk file readback.', 'web-token'),
      endpoint('GET', '/api/co-reading/books/:book_id/progress', 'Read synchronized browser progress for user/device.', 'web-token'),
      endpoint('POST', '/api/co-reading/books/:book_id/progress', 'Server-side wrapper updates progress and writes reading_events.', 'web-token-write-wrapper'),
      endpoint('POST', '/api/co-reading/books/:book_id/annotations', 'Server-side wrapper creates private/shared annotation. Default private.', 'web-token-write-wrapper'),
      endpoint('POST', '/api/co-reading/annotations/:annotation_id/ask-hermes', 'Server-side route asks Hermes only for shared annotations and stores the reply in reading_threads.', 'web-token-write-wrapper'),
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
