# Phase Status

Status: CURRENT (2026-05-22)

This file tracks closed phase boundaries. Detailed design and deployment notes
belong in code, tests, or local archive records, not here.

## Closed Phases

| Phase | Status | Boundary |
|-------|--------|----------|
| 5 | code-closed | Hermes profile and gateway migration |
| 6 | code-closed | Python backend and memory bridge boundary |
| 7 | code-closed | Remove OpenClaw reply path |
| 8 | code-closed | Remove OpenClaw infrastructure and npm dependency |
| 9 | code-closed | Migrate state naming from OpenClaw-era paths to `.ran_agent_state` |
| 10 | code-closed | Remove OpenClaw-era frontend docs/config as runtime authority |
| 11 | code-closed | Search Hub and browser-backed routing foundation |
| 11.1 | code-closed | Compact Hermes lite/full systemd convergence |
| 11.1.1 | code-closed | Compact checker, UV tooling, XHS timeout, and Obsidian optionalization |
| 11.1.5 | code-closed | XHS evidence gate and generic fallback marker |
| 11.1.5b | code-closed | XHS token cache matching and deploy marker hardening |
| 11.1.5c | prompt/routing guard closed | XHS first-read hint forbids browser/terminal first hop |

## Current Runtime Closure

- Hermes lite/full deploy and drift repair is owned by
  `scripts/apply-hermes-runtime-split.sh`.
- Runtime diagnosis is owned by `scripts/diagnose-lite-full.sh` plus
  specialized diagnostic scripts for Search Hub, continuity, multi-frontend,
  tools, and media/XHS.
- Search Hub is the unified fresh web/news/academic entry. Actual social links
  remain on `social_reader` / `media_reader`.
- XHS content reads use the prepared generic fallback marker and token-aware
  compatibility path. Token cache hits are link-resolution evidence only.
- Evidence gate distinguishes `link_resolution`, `metadata_read`, and
  `content_read`; only content evidence allows "read" claims.
- Node root env and `node_bridge/.env.local` both receive the XHS fallback
  marker path during apply.

## Historical Notes

- OpenClaw, Kimi, and GLM are retired frontend/runtime paths.
- `.openclaw_state` names may appear only as historical references or legacy
  compatibility artifacts.
- Phase 6 and later must not reopen Phase 5 acceptance unless explicitly
  requested.
