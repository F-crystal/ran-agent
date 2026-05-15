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

## Publication Notes

- Historical archive notes and deployment journals are local-only under ignored `local_archive/docs/`; do not force-add them to Git unless the owner explicitly asks for a specific safe file.
- Future archive records go under `local_archive/docs/governance/archive/`.
- Future deployment notes go under `local_archive/docs/deployment/`.
- Runtime state, private vault content, logs, databases, debug outputs, env files, and local archive material must remain ignored.
- `docs/governance/current_runtime_status.md` is the detailed current-state reference; this file only tracks which docs are authoritative for public readers.

## Conflict Rule

1. Runtime code behavior is first truth.
2. Then the public source-of-truth docs listed above.
3. Local archives are context only and are not part of the public release surface.
