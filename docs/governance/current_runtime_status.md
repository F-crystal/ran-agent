# Current Runtime Status

Status: S12 COMPLETE / PROD_ACCEPTED; OWNER CHANNELS SOURCE IN PROGRESS; S13 NOT STARTED (2026-08-20)

This is the compact authority for current source and production behavior.
Commands live in `server_runtime_commands.md`; completed transaction detail
lives in the historical acceptance ledgers and ignored release evidence.

## Verified Production Snapshot

Read-only verification on 2026-08-18 established:

| Surface | Current state |
|---|---|
| Production checkout | Clean archived source |
| Python backend | Active as `ubuntu` |
| Node bridge | Active as `ubuntu` |
| Hermes | One active unified gateway on loopback `8642`, DeepSeek V4 Flash non-thinking |
| Retired Hermes Full | Inactive and condition-blocked; never a fallback |
| Ombre Brain | Active on loopback `18001` |
| XHS public sidecar | Active; account-backed XHS service inactive |
| Co-reading Web reader | Enabled on the configured Tailscale address with a loopback backend |
| Core | Enabled with one semantic writer and managed wake active |
| Daily digest | Disabled; daily reports belong to Codex |
| External MCP | Gateway, system queue, and activity runner enabled behind policy gates |
| Qwen Token Plan | `qwen3.6-flash` for OCR/VLM and knowledge maintenance |

The owner-only env files remain `ubuntu:ubuntu` mode `0600`. Retired MiMo
variables, old OpenClaw gateway credentials, account-backed XHS variables, and
the stale editor swap file are absent. Secret values were not read or reported.

## Source Versus Production

Current source contains one disabled-by-default, owner-private, text-only
Telegram long-poll bridge. It reuses IdentityMap, ChannelHub, the durable
outbox, platform-isolated Hermes sessions, and a Telegram-only proxy dispatcher;
unsupported media and cross-channel fallback are rejected. An isolated
tecserver Node process passed the owner, restart, session, delivery, ambiguity,
shutdown, and proxy matrix. This is source evidence, not production acceptance.

Production still uses the committed Feishu owner presentation binding. No
source apply, service restart, persistent Telegram proxy, polling activation,
real Telegram send, WeChat binding cutover, or Feishu disablement is claimed.

## Conversation Mainline

```text
WeChat / Feishu / optional Desktop Proxy / source-only Telegram text
  -> ChannelHub
  -> replyBackend
  -> hermesGatewayClient
  -> unified Hermes companion
  -> DeepSeek V4 Flash
```

IdentityMap explicitly binds authenticated frontends to one owner identity;
conversation sessions remain channel/conversation scoped. GlobalTimeline can
surface bounded cross-channel context without letting a non-referential turn
inherit another channel's last answer. Python `/chat` is retired and returns
410; the backend no longer constructs a competing chat runtime.

Empty provider content and known `No reply` sentinels are infrastructure
failures. One ordinary conversation may rotate through the existing soft-reset
seam and retry once; failed content never enters user-visible replies or
conversation history.

## Responsibility Boundary

Hermes owns conversation, emotional companionship, co-reading, search, media,
stickers, media generation, and governed external-MCP play. Codex owns Calendar,
Todo, reminders, Minutes/documents, daily reports, code, debugging, deployment,
and other owner-facing work effects.

The active companion profile exposes skills, memory, safe tools, and:

- `time`
- `social_reader`
- `media_reader`
- `search_hub`
- `co_reading`
- `sticker_catalog`
- `media_generation`
- `personal_memory`
- `external_mcp_gateway`

Broad terminal/file/session tools, direct Playwright, native cron, code
execution, and delegation are absent from the companion allowlist. Search Hub
may use its internal governed Playwright fallback. Unknown external MCPs enter
only through `external_mcp_gateway`; default availability does not bypass
registry, grants, budgets, cancellation, evidence, or side-effect confirmation.

## Actions, Delivery, And Proactive Events

Hermes reply envelopes may request only `memory.remember`, `memory.correct`, or
`memory.forget`. Node validates explicit owner intent, exact scope, actor,
idempotency, executor authority, and receipt. Work-action requests are removed
before every executor; Node never derives permission from natural-language
wording.

Text delivery uses the durable outbox/receipt path. Unknown or ambiguous adapter
outcomes are terminal no-resend evidence, not permission to duplicate an
effect. Media and other non-text surfaces retain their own marker/evidence
contracts.

Bounded companionship starts from confirmed personal-learning evidence, emits
one structured ProactiveEvent candidate, and passes Node cadence, quiet-time,
daily-limit, stop, dedupe, and post-send receipt gates. Generic timer greetings
and direct Python proactive text remain disabled. Only governed `external_mcp_gateway` notifications
use their evidence-bound system queue and the same attention discipline.

## Memory And Knowledge

`personal_memory` is the only Hermes-facing memory facade. It combines local
SQLite/FastEmbed retrieval with bounded Ombre `breath_search`. Core and governed
documents remain factual authorities; Ombre is a derived, erasable,
rebuildable relationship/context projection.

A verified personal-learning receipt creates a hash-bound Core source before
the stable backend projects remember/correct/forget to Ombre. Confirmed
relationship summaries retain the `grow` mapping. Public recall and Hermes are
query-only; failed projection leaves the Core source durable and retryable.

Knowledge maintenance runs through the configured Qwen CLI wrapper. Production
uses Token Plan `qwen3.6-flash` for the provider-neutral plan/apply/cleanup
workflow over `vault/`; secrets stay in owner-only env. The vault contract is
`vault/AGENTS.md`.

## Media And Co-Reading

`media_reader` remains the single public media-analysis facade. The pinned
Qwen-MM backend handles OCR and image understanding through Token Plan
`qwen3.6-flash`; ASR and media generation remain on DashScope. XHS is
public-only and never restores cookie, QR-login, or account-backed MCP paths.

`co_reading` supports EPUB, TXT, Markdown, pasted text, local HTML, URL and PDF
text-layer import; scanned PDFs are marked `ocr_required`. Normal URLs reuse
Search Hub and social URLs reuse Social Reader. The Web reader uses a browser
access token only, keeps the owner token server-side, and exposes no public
internet route.

## Source And Recovery

The unified runtime cutover and v0.13 rollback window are closed. Retained
runtime artifacts and snapshots are evidence-only. Current code releases use
one reviewed immutable source transaction; do not deploy with `git pull`,
standalone split scripts, manual checkout changes, or hand-edited systemd/env.

The source transaction refreshes identity/activity projection before service
start. Projection identity is derived from ordered projected Activity rows, so
unrelated SQLite writes do not create false conflicts; a same-revision change
to projected data still fails closed.

## Current Frontier

Packages A-E, S0-S12, post-S12 product-effect recovery, H0-H5, the projection
refresh repair, and Qwen-MM Token Plan routing are complete. S13 is not started.
No current authorization permits deleting S13 observation/rollback evidence or
changing service identities, permissions, ownership, or storage layout.

## Protected State

Never commit or print env files, credentials, cookies, proxy URLs, recipient
identifiers, private vault content, databases, logs, debug output, provider
history, local archives, caches, or personal media.
