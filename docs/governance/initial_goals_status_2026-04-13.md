# Initial Goals Status (2026-04-13)

## Scope And Method

- Basis: `AGENTS.md` + active docs under `docs/governance/` listed by `docs/governance/doc_status.md`.
- Local historical archives may exist under ignored `local_archive/`, but this public tree treats `docs/governance/` as the source of truth.
- This document summarizes the "initial goals" in current executable form, not historical wording.

## Initial Goals (Current Executable Version)

| Goal | Evidence Files | Current Status | Next Step |
| --- | --- | --- | --- |
| Lock frontline to OpenClaw as single speaker, with the configured Claude-compatible provider path | `AGENTS.md`; `docs/governance/constraints.md`; `docs/governance/current_runtime_status.md` | 已完成 | Keep startup/ops docs consistent with `./start_openclaw.sh` as sole frontend entry and keep Qwen confined to backend knowledge maintenance. |
| Keep Python runtime as backend capability layer only (no second front brain, `/chat` retired) | `AGENTS.md`; `docs/governance/constraints.md`; `docs/governance/current_runtime_status.md`; `docs/governance/cleanup.md`; `docs/governance/cleanup_execution_checklist_2026-04-13.md` | 已完成 | Keep `/chat` 410 retired guard and backend tools/ingest path stable. |
| Enforce skills-first specialist loading (on-demand, not always-loaded) | `AGENTS.md`; `docs/governance/skills.md`; `docs/governance/constraints.md` | 已完成 | Keep new specialist additions within `skills/*/SKILL.md` and avoid baseline preloading. |
| Restrict sub-agent usage to heavy/background tasks only | `AGENTS.md`; `docs/governance/sub_agents.md`; `docs/governance/constraints.md` | 已完成 | Continue enforcing "no sub-agent" for frontline chat, memory main flow, life loop. |
| Keep knowledge and memory direction stable (knowledge product path + Ombre-first memory path) | `AGENTS.md`; `docs/governance/constraints.md` | 已完成 | Keep migration work gated by explicit migration request. |
| Complete post-cutover cleanup safely (remove obsolete frontend-era files only after preconditions) | `docs/governance/cleanup.md`; `docs/governance/cleanup_execution_checklist_2026-04-13.md` | 已完成 | Keep future cleanup changes in small reversible steps and preserve OpenClaw mainline. |
| Stabilize end-to-end runtime after bridge/network/auth blockers | `docs/governance/current_runtime_status.md` | 部分完成 | Keep monitor loop and real inbound message verification green. |

## Completion Snapshot

- 已完成: 6
- 部分完成: 1
- 未完成: 0

Overall: governance direction is converged; remaining work is concentrated in runtime auth stabilization.
