# Sticker Catalog

Status: CURRENT (2026-06-13)

`sticker_catalog` is a platform-neutral local sticker asset catalog. WeChat and
Feishu are delivery exits only; the model-facing protocol carries `stickerId`,
never server-side file paths.

## Contract

- Assets live under `.ran_agent_state/stickers/` and are ignored by Git.
- Hermes sends stickers through `RAN_MEDIA` markers with
  `source=sticker_catalog`, `kind=sticker`, and `stickerId`.
- `RAN_MEDIA` must not carry `path`, `url`, `filePath`, or nested path-like
  fields. The Node bridge resolves `stickerId` server-side.
- GIF support depends on the destination platform. Feishu currently attempts
  `--image` for image MIME types and falls back to `--file` when upload fails.
- Private/work contexts, daily digests, summaries, error reports, and formal
  notifications do not use stickers by default.

## Saving Boundary

- Save only when the user explicitly asks to save the current inbound media as
  a sticker, for example "保存这个为表情包", "加入表情包", or "以后用这个表情".
- Ordinary screenshots, photos, document images, and work files are not saved
  automatically.
- `sticker_save_from_inbox` accepts at most 10 items and only trusted inbound
  temporary directories, currently including `.ran_agent_state/wechat/inbound`
  and `.ran_agent_state/feishu/inbound`.
- Lite runtime may expose `sticker_save_from_inbox` for this explicit save
  workflow so ordinary chat can turn a user-sent image/GIF into a reusable
  sticker. Update/delete/list remain full/owner-only maintenance tools.
- Tool results expose public sticker metadata only. They must not expose
  absolute paths, tokens, local cache paths, or raw platform resource keys.
- Do not commit real sticker assets. For local testing, create temporary
  throwaway image files under trusted inbound state directories.

## Platform Notes

- WeChat inbound media is already normalized as `{ filePath, mimeType, type }`
  and can be saved only after explicit user intent.
- Feishu image/file inbound messages are downloaded with `lark-cli im
  +messages-resources-download` into `.ran_agent_state/feishu/inbound` before
  becoming save candidates.
- Feishu send behavior must be smoke-tested on the server because `--image` and
  `--file` support depends on the installed `lark-cli` and bot permissions.

## Server Smoke

Do not restart services as part of this smoke.

```bash
cd /opt/ran_agent && source /opt/ran_agent/.venv/bin/activate

scripts/start_sticker_catalog_mcp.sh initialize

printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"sticker_tags","arguments":{}}}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"sticker_pick","arguments":{"tag":"开心","limit":1}}}' \
  '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"sticker_attach","arguments":{"stickerId":"stk_001","caption":"测试"}}}' \
  | scripts/start_sticker_catalog_mcp.sh
```

WeChat checks:

- Send a plain text message and confirm no sticker is attached.
- Send a sticker reply through `RAN_MEDIA` and confirm the bridge resolves by
  `stickerId`.
- Send a legacy `WECHAT_MEDIA` marker and confirm compatibility still works.
- Send an inbound media message, then explicitly ask to save it; ordinary
  screenshots must not auto-save.

Feishu checks:

```bash
command -v lark-cli
lark-cli im +messages-send --help | grep -E -- '--image|--file'
```

- Confirm `--image` and `--file` are present.
- Server `lark-cli` expects file keys, URLs, or cwd-relative local paths for
  `--image` / `--file`; absolute paths and `..` are rejected. The Feishu sender
  therefore runs with `cwd` set to the sticker assets directory and passes only
  the catalog file name.
- Send a catalog sticker to Feishu and confirm image send or file fallback.
- Send an inbound Feishu image/file, explicitly ask to save it, and confirm the
  saved result does not reveal absolute paths.

Security checks:

- Fake `RAN_MEDIA` with `path`, `url`, or `filePath` is rejected.
- Unknown `RAN_MEDIA.source` is rejected.
- Timeline, logs, and tool results do not contain absolute `filePath`,
  platform tokens, cookies, or resolver credentials.
