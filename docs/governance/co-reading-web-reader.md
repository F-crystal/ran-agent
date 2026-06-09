# Co-Reading Web Reader

Status: CURRENT (2026-06-09)

This document owns the private Tailscale-only Web reader for `co_reading`.
It does not change the Bilibili yt-dlp proxy path.

## Network Model

`/reader` is a Web service running on the ran-agent server. Phones, laptops, and
the server must already be in the same Tailscale tailnet.

Recommended access order:

1. Listen directly on the server Tailscale IP.
2. Bind to `127.0.0.1`, then use Tailscale Serve to share the local port inside
   the tailnet.

Do not use Tailscale Funnel for this reader. Funnel is a public internet entry.
Do not use Cloudflare WARP global mode. Do not use a Tailscale exit node as the
normal reader path.

If `CO_READING_WEB_HOST=0.0.0.0`, verify the cloud firewall and security group
do not expose port `8787` to the public internet. Prefer the Tailscale IP or
`127.0.0.1 + tailscale serve`.

## Find The Server Tailscale IP

Run this on the server:

```bash
tailscale ip -4
```

Use the returned `100.x.y.z` address as `<server-tailscale-ip>`.

## Mode A: Listen On The Tailscale IP

Recommended `.env.local` values:

```bash
CO_READING_WEB_ENABLED=true
CO_READING_WEB_HOST=<server-tailscale-ip>
CO_READING_WEB_PORT=8787
CO_READING_WEB_ACCESS_TOKEN=replace-me
CO_READING_OWNER_TOKEN=replace-me-server-only
CO_READING_ROOT_DIR=/opt/ran_agent/.ran_agent_state/co_reading
CO_READING_ASK_CONTEXT_CHARS=1000
CO_READING_ASK_THREAD_LIMIT=6
CO_READING_VAULT_DIR=/opt/ran_agent/vault
CO_READING_NODE_BIN=/opt/nodejs/node-v22.22.2-linux-x64/bin/node
CO_READING_TRANSLATION_ENABLED=true
CO_READING_TRANSLATION_PROVIDER=hermes
CO_READING_TRANSLATION_TARGET_LANG=zh-CN
```

Phone or computer:

```text
http://<server-tailscale-ip>:8787/reader
```

## Mode B: Bind Localhost And Use Tailscale Serve

Recommended `.env.local` values:

```bash
CO_READING_WEB_ENABLED=true
CO_READING_WEB_HOST=127.0.0.1
CO_READING_WEB_PORT=8787
CO_READING_WEB_ACCESS_TOKEN=replace-me
CO_READING_OWNER_TOKEN=replace-me-server-only
CO_READING_ROOT_DIR=/opt/ran_agent/.ran_agent_state/co_reading
CO_READING_ASK_CONTEXT_CHARS=1000
CO_READING_ASK_THREAD_LIMIT=6
CO_READING_VAULT_DIR=/opt/ran_agent/vault
CO_READING_NODE_BIN=/opt/nodejs/node-v22.22.2-linux-x64/bin/node
CO_READING_TRANSLATION_ENABLED=true
CO_READING_TRANSLATION_PROVIDER=hermes
CO_READING_TRANSLATION_TARGET_LANG=zh-CN
```

Then manually configure Tailscale Serve on the server, for example:

```bash
tailscale serve 8787
```

Tailscale Serve shares local services with devices inside the tailnet. Tailscale
Funnel is for public internet access and is not used for this stage.

Reference:

- Tailscale Serve documentation: `https://tailscale.com/docs/features/tailscale-serve`
- Tailscale Funnel documentation: `https://tailscale.com/docs/features/tailscale-funnel`
- Local Bilibili SOCKS runbook:
  `local_archive/docs/deployment/2026-05-09-cloudflare-warp-server-proxy-guide.md`

## Security Rules

- `CO_READING_OWNER_TOKEN` is server-only. It must not appear in browser
  JavaScript, HTML, `localStorage`, logs, API responses, or Git.
- The browser uses only `CO_READING_WEB_ACCESS_TOKEN`.
- Web API routes are under `/api/co-reading/*` and require
  `Authorization: Bearer <CO_READING_WEB_ACCESS_TOKEN>`.
- Browser requests never call MCP directly.
- Browser write actions are server-side wrappers. The server updates SQLite and
  chunk state without sending owner credentials to the browser.
- Translation requests are server-side wrappers. Browser clients never receive
  Hermes, DeepL, Google, or LibreTranslate credentials.
- Private annotations are shown only in the authenticated owner Web UI. They are
  not sent to Hermes.
- Saving a shared annotation automatically invites Hermes to leave one
  co-reading response. The inline Hermes box is for follow-up questions.
- Only shared annotations can use the Hermes route.
- Manual follow-up questions are stored as `author=user` rows in
  `reading_threads`; Hermes replies are stored as `author=hermes` rows and then
  displayed in the sidebar.
- Hermes annotation replies use narrow context by default: shared quote, note,
  recent thread, and a bounded nearby source window. They do not receive the
  full chunk unless a future explicit scope mode is added.
- The default nearby source window is intentionally moderate rather than tiny:
  about 1000 characters before and after the quote, plus the latest 6 thread
  replies. Lower `CO_READING_ASK_CONTEXT_CHARS` only when token cost matters
  more than reading nuance for that deployment.
- Shared annotation cards can be explicitly deposited into
  `vault/inbox/co_reading/` as Markdown. Private annotations cannot be
  deposited. Repeated deposits for the same annotation update one stable
  Markdown note instead of creating dated duplicates.
- Chunk text remains in `.txt.gz` files. Do not store whole books in SQLite,
  `localStorage`, or browser caches.
- Do not commit tokens, cookies, proxy passwords, or real access URLs.

## Bilibili SOCKS Proxy Boundary

The Mac home-network SOCKS proxy is only for Bilibili yt-dlp inside
`media_reader` / `social_reader`.

Keep these boundaries:

- Do not delete or change `PERSONAL_AGENT_YTDLP_PROXY` for this reader.
- `/reader` must not use `socks5h://127.0.0.1:10808`.
- The Mac SOCKS tunnel is not a dependency of `co_reading`.
- If a future book import adds Bilibili video or web article import, route that
  through existing `media_reader` / `social_reader` providers.
- `co_reading` Web reader is a Tailscale internal Web service; the Bilibili
  proxy is a media resolver egress setting. They are independent.

## Reader Functions

Current UI:

- Desktop reader with a top status bar plus shelf, chunks, reader, and margin
  panels.
- Mobile reader with bottom tabs: shelf, chunks, reader, and margin.
- Book shelf with active / archived / trash filters.
- Pasted Text / Markdown import.
- Browser file import through `/api/co-reading/import-file` for TXT,
  Markdown, EPUB, PDF text-layer detection, and local HTML files. Uploaded
  originals are temporary; canonical text remains chunk `.txt.gz`.
- EPUB/TXT/Markdown/URL imports are split into page-sized chunks. Existing
  books imported before a chunking change keep their old chunks until the file
  or URL is imported again.
- PDF text-layer import uses `pdftotext` when available. On Ubuntu install it
  with `sudo apt-get install -y poppler-utils`. If a PDF has no readable text
  layer, the reader stores the book with `ocr_required=true` and creates no
  chunks; OCR is intentionally not run in this stage.
- URL import through `/api/co-reading/import-url`. Normal URLs reuse
  `search_hub` read. Social URLs reuse `social_reader`. The browser never
  calls MCP directly.
- Open a book and display one chunk.
- Bilingual reader rendering: original paragraph plus cached Chinese
  translation below it.
- Manual translation refresh regenerates the current chunk with
  `force=true` and overwrites the translation cache.
- Translation requests are strict translation-only calls. If Hermes returns a
  co-reading comment, summary, or untranslated source copy, a separate strict
  translation QA judge rejects it and the server retries before writing the
  translation cache.
- Previous and next chunk.
- Read and write browser progress.
- Book search.
- Selection-based private or shared annotations.
- Original and translated text can both be selected for annotations. Annotation
  cards show whether the quote is anchored to original text or translated text.
- On mobile, selecting text keeps the reader tab active and opens the annotation
  composer as a bottom sheet, so the selected text can still be used while the
  user writes the note.
- Inline annotation composer; no core `prompt()` / `alert()` flow.
- Sidebar annotations with thread replies.
- Annotation cards can be collapsed and expanded from the sidebar. Collapsed
  cards keep a compact title and reply count visible.
- Shared annotations automatically ask Hermes for one co-reading response when
  saved.
- Inline Hermes follow-up box on shared annotation cards.
- Store manual follow-up questions and Hermes replies in `reading_threads` and
  show both in the margin.
- Explicit `沉淀到 Vault` action on shared annotation cards. It writes a
  Markdown inbox note with book/chunk metadata, quote, user annotation, and
  thread replies.
- Shelf actions for archive, restore, and soft-delete to trash. Trash keeps a
  retention expiry and can be restored before cleanup.

Translation behavior:

- Default provider is `hermes`.
- Cache files are stored under `library/<book_id>/translations/*.txt.gz`.
- Cache identity is `chunk_id + target language + provider + source hash`.
- Translation cache storage is counted in `asset_bytes`.
- The UI may briefly show `翻译中...` while a cache miss is being translated.
- Cached or newly generated output must pass a model-based translation QA
  judgment before it is treated as valid. The judge rejects untranslated source
  copies, commentary, summaries, persona replies, and co-reading reactions.
- Translation cache rows written after QA carry a validation marker and are
  served directly on later reads. Older unmarked cache rows are judged once; if
  rejected, the server regenerates and overwrites the cache.
- Desktop table-of-contents and margin panels are sticky within the viewport.
  The current chunk is scrolled into view automatically when the reader moves.

Current non-goals:

- OCR.
- Complex new web crawling pipeline. URL import must reuse existing
  `search_hub` / `social_reader` paths.
- Public deployment.
- Cloudflare Access.
- Cloudflare WARP global mode.
- Tailscale exit node as the normal reader route.
- Multi-user role system.

## Manual Server Commands

Codex must not SSH to the server or restart services. Run commands manually on
the server.

After `git pull --ff-only`, set local env values and repair runtime drift:

```bash
cd /opt/ran_agent

tailscale ip -4

# Required for PDF text-layer extraction. Scanned/image PDFs still require OCR,
# which is not enabled for this reader stage.
sudo apt-get install -y poppler-utils

# Edit .env.local manually or append values with your real tokens.
# Do not commit .env.local.

bash scripts/apply-hermes-runtime-split.sh
sudo systemctl restart ran-agent-node
```

For standalone smoke without changing the node bridge service:

```bash
cd /opt/ran_agent
source .env.local
bash scripts/start_co_reading_web.sh
```

Then open:

```text
http://<server-tailscale-ip>:8787/reader
```

## Acceptance Checklist

Use a TXT or Markdown sample, plus one file or URL import smoke when available:

1. Start the Web reader.
2. Open `/reader` from phone or computer through the Tailscale IP.
3. Enter `CO_READING_WEB_ACCESS_TOKEN`.
4. Import pasted text, uploaded file, or URL.
5. Confirm the new book appears in the shelf.
6. Open the book.
7. Confirm original text and Chinese translation both appear.
8. Move previous / next chunk.
9. Confirm progress restores on reload.
10. Search text and jump to the hit.
11. Select original text in the reader and confirm the annotation composer opens.
12. Select translated text and confirm the annotation composer also opens.
13. Create a private annotation.
14. Confirm the private card has no Hermes question box.
15. Create a shared annotation.
16. Confirm Hermes is invited automatically and loading state appears.
17. Confirm Hermes reply appears in the sidebar and persists after refresh.
18. Ask a follow-up inline on the shared annotation.
19. Confirm the follow-up question appears as a user thread item and Hermes
    appears as the next thread item.
20. Collapse and expand the shared annotation card and confirm the reply count
    remains visible when collapsed.
21. Deposit the shared annotation to Vault and confirm a Markdown note is
    written under `vault/inbox/co_reading/`.
22. Confirm the private annotation is not sent through the Hermes request path
    and cannot be deposited.
23. Scroll the reader and confirm TOC/margin panels remain reachable on desktop.
24. Scroll to the end of a long chunk and confirm the footer previous / next
    buttons work.
