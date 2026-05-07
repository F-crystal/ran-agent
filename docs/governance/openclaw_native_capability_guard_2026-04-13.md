# OpenClaw Native Capability Guard

Date: 2026-04-13  
Scope: compatibility + governance convergence check for "OpenClaw native capability unchanged"

## Retained Capabilities

- Frontline remains OpenClaw single speaker; default model chain is `Claude primary -> Codex fallback`.
- Knowledge maintenance remains on `knowledge_agent.py -> vault_runner.sh -> Qwen Code -> Obsidian vault`.
- Startup entry remains `./start_openclaw.sh`; `HEARTBEAT.md` is present in repo root.
- Specialist skills remain on-demand and match governance list:
  - `memory-specialist`
  - `reflection-specialist`
  - `knowledge-state`
  - `life-loop`
  - `night-cycle`
  - `ombre-memory`
- Node/OpenClaw mainline contract remains `... -> OpenClaw Gateway -> Claude primary -> fallback chain -> reply`.

## Risk Scan (this round)

1. Tools profile drift risk (`medium`)
- Observed runtime truth in `openclaw/openclaw.personal-system.json`: `tools.profile = coding`.
- The `.bak` snapshots match that value, so the prior `messaging` note was stale.
- Guard action: keep governance docs aligned with the current config and require `/new` or `/reset` after any `tools.profile` or `tools.allow` change.

2. Skills allowlist drift risk (`low`)
- Governance allowlist-like source of truth is doc-based (`AGENTS.md` + `docs/governance/skills.md`), and all listed skill files exist.
- No current rollback signal, but adding/removing specialist skill entries without updating both docs remains a future drift vector.

3. Heartbeat config risk (`low`)
- `HEARTBEAT.md` exists and wording is aligned with OpenClaw companion role + on-demand skills.
- Runtime docs already include `HEARTBEAT ENOENT` troubleshooting path.

## Rollback Points

- Tools profile rollback:
  - File: `openclaw/openclaw.personal-system.json`
  - Key: `tools.profile`
  - Fallback: preserve `coding` unless an explicit product decision changes the runtime profile.
- Config snapshot rollback source:
  - `openclaw/openclaw.personal-system.json.bak`
- Governance wording rollback:
  - File: `docs/governance/constraints.md`
  - Line updated this round: tools profile truth is `coding` and tool changes require `/new` or `/reset`.

## Conclusion

- No hard conflict found against current governance boundary.
- Main watchpoint is the `tools.profile` and `tools.allow` change boundary; it is now documented explicitly to prevent accidental capability regression.
