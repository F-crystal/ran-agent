# Documentation Status

Status: CURRENT (2026-05-15)


## Public Source Of Truth

- `README.md` / `README_en.md`
- `hermes/README.md` / `hermes/README_en.md`
- `AGENTS.md`
- `CLAUDE.md`
- `hermes/profile/AGENTS.md`
- `docs/governance/doc_status.md`
- `docs/governance/current_runtime_status.md`
- `docs/governance/phase_status.md`
- `docs/governance/server_runtime_commands.md`
- `docs/governance/wechat-bridge-media-buffer.md`
- `docs/governance/constraints.md`
- `docs/governance/skills.md`
- `docs/governance/sub_agents.md`
- `docs/governance/cleanup.md`
- `docs/governance/media-pipeline.md`
- `docs/governance/mimo-power-mcp.md`
- `docs/governance/prompt-slimming-audit.md`
- `docs/governance/multi_frontend_identity_strategy.md`

## Publication Notes

- Server runtime deployment and drift repair are standardized on
  `bash scripts/apply-hermes-runtime-split.sh`; diagnosis is standardized on
  `bash scripts/diagnose-lite-full.sh`, with
  `bash scripts/diagnose-hermes-continuity.sh` for session-continuity checks.
  Do not document manual systemd/env edits as the normal path for the
  lite/full split.
- Completed code/doc changes that need GitHub synchronization must go through
  `skills/archive-and-push/SKILL.md`; do not hand-stage broad runtime trees.
- Historical archive notes and deployment journals are local-only under ignored `local_archive/docs/`; do not force-add them to Git unless the owner explicitly asks for a specific safe file.
- Future archive records go under `local_archive/docs/governance/archive/`.
- Future deployment notes go under `local_archive/docs/deployment/`.
- Runtime state, private vault content, logs, databases, debug outputs, env files, and local archive material must remain ignored.
- `docs/governance/current_runtime_status.md` is the detailed current-state reference; this file only tracks which docs are authoritative for public readers.

## Conflict Rule

1. Runtime code behavior is first truth.
2. Then the public source-of-truth docs listed above.
3. Local archives are context only and are not part of the public release surface.

## Closed Production Fixes

- `dda3499` made `scripts/apply-hermes-runtime-split.sh` the standard server
  deployment and drift-repair entry for the Hermes lite/full split.
- `dd04424` closed the Hermes continuity and XHS image fallback fixes:
  Node sends stable session headers plus bounded recent text history, XHS media
  fallback normalizes image/video resources for `media_reader`, and reviewer
  lint blocks mechanism-heavy vision explanations in normal social/media replies.
- `25a6ff2` closed the unified multi-frontend entry: WeChat, Feishu/Lark, and
  Desktop proxy all enter `ChannelHub` before `replyBackend`.
- `6b46276` closed GlobalTimeline retention: long turns and payload-like
  content are summarized, old timeline records compact into daily/topic
  summaries, and original JSONL files are gzipped to the archive dir.
- `8a3fa69` closed Feishu bridge production fixes: `lark-cli event consume
  im.message.receive_v1` uses bot identity by default, plain string content is
  parsed, and send commands use `im +messages-send` with idempotency keys.
