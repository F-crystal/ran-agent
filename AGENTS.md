# AGENTS.md

Status: CURRENT (2026-08-04)

## Scope

This is the canonical repo-root rule file for agents in this checkout and must stay self-contained on both desktop and server. A separately loaded desktop host policy may add local defaults but is not a prerequisite for this project. Server checkouts under `/opt/ran_agent` must assume no global `AGENTS.md`. Because the immutable release gate rejects symlinks, `CLAUDE.md` and `GEMINI.md` use minimal regular-file imports of the nearest scoped `AGENTS.md`. Hermes runtime constraints live in `hermes/profile/AGENTS.md`.

## Operating Rules

- Keep work local-first and project-scoped unless the user explicitly asks for global agent configuration.
- Keep runtime simple: backend services, state layer, WeChat bridge, MCP/knowledge interfaces. Do not expand a custom front conversation runtime.
- OpenClaw, Kimi, GLM, and MiMo Power are retired as current runtime, deployment, or debugging authorities. Treat `openclaw-*` names and `.openclaw_state` only as legacy compatibility artifacts.
- For time-sensitive facts, perform live lookup before answering. Weather uses `skills/weather/SKILL.md`; other online lookup uses `skills/web-search-live/SKILL.md`.
- For unfamiliar integration/debugging work, check official docs and mature prior art before designing or coding.
- Use absolute paths or workspace-relative paths, not `~`-prefixed paths.
- Feature authorization does not authorize changing production service identities, Unix users/groups, ownership, permission boundaries, or storage layout; these require separate explicit user approval.

## Skills And Delegation

- Load specialist skills on demand; do not preload all specialist context.
- Skill map: `docs/governance/skills.md`.
- Archive, commit, push, or GitHub sync requests must use `skills/archive-and-push/SKILL.md`.
- Server deployment, lite/full runtime, systemd/env, or MCP exposure work must use `skills/server-runtime/SKILL.md`.
- Documentation governance work must use `skills/doc-governance/SKILL.md`.
- Use sub-agents only for heavy background tasks, exploration, or maintenance. Do not sub-agentize frontline chat, memory main flow, life loop, or todo/reminder main flow.

## Agent Capability Governance

- This file and nested project `AGENTS.md` files own project policy on every host; desktop-global policy may add local defaults but may not replace or relax project rules.
- Keep project instruction files limited to stable local correctness and safety rules. Skill-specific triggers and procedures belong in repository skills or governed project documentation.
- Project-only skills stay in this repository. Shared host skills are desktop-only and must not become server runtime dependencies.
- Server runtime under `/opt/ran_agent` is governed by `skills/server-runtime/SKILL.md` and `docs/governance/server_runtime_commands.md`.

## Security And Git

- Keep owner-only posture for high-permission actions.
- Never expose or commit credentials, cookies, tokens, session dumps, local caches, SQLite state, env files, raw private archives, or logs that contain secrets.
- Never commit: `.env.local`, `.ran_agent_state/`, `data/`, `logs/`, `debug/`, `state/`, `local_archive/`, `vault/inbox/`, `vault/raw/`, `vault/wiki/`, or credential files.
- Before committing, stage only intentional source, tests, scripts, and public docs.
- Platform resolver credentials such as SESSDATA, XHS_COOKIE, or proxy URLs must never appear in tool output, logs, docs, or git.

## Delivery Evidence

- Before claiming completion for high-risk deployment, migration,
  archive/commit/push preparation, security, identity, idempotency, or
  irreversible state work, run the applicable separately authorized,
  read-only final check through
  `python3 scripts/workflow_guard.py verify --label <label> -- <command>`.
- For long validation windows, use the explicit snapshot/run flow documented in
  `docs/governance/delivery-evidence.md` instead of taking a late baseline.
- Evidence automation does not authorize commit, push, deploy, migration, risk
  acceptance, destructive action, or any side effect performed by the wrapped
  command; it is not a sandbox.
- Gates may validate only an approved architecture; they must not introduce or
  make mandatory an unapproved migration or security boundary.

## Release Gate Portability

- Tests admitted to an immutable release gate must run from a Git-less,
  read-only source copy under both root and non-root execution, with `env -i`
  isolation and writes confined to explicit scratch/runtime paths.
- Pass candidate digests, runtime executables, and privilege seams as validated
  explicit inputs. Never depend on `.git`, a developer-machine path,
  interactive-shell `PATH`, inherited environment state, or an implicit
  non-root `sudo` branch.
- Fault-injection fixtures must set their privilege-command seam explicitly so
  the intended failure executes regardless of the caller's EUID.
- Identity-sensitive fixtures must explicitly establish the owner, group, and
  mode of their scratch/runtime root; do not rely on host-specific temporary
  directory group inheritance.
- Checkout-permission regressions must exercise real root-owned `0600/0700`
  tracked paths, repair them as the non-root checkout owner, and prove access
  as the service identity. Same-user chmod-only fixtures are insufficient.
- Shell harnesses that source release controllers must prove the intended
  command ran and preserve its failure status. Under `set -u`, branch around
  empty privilege-command arrays instead of expanding them; cover both the
  desktop Bash 3.2 harness and the Linux root/non-root staged gate.
- Real-process integration probes must keep bounded timeouts sized for the
  repository's full-suite concurrency load, not only isolated-file latency.
- A local full-suite pass is insufficient for release-gate changes. Keep and
  run a staged-environment regression that would fail on any of the portability
  assumptions above before producing a deployable SHA.

## Governance References

- Documentation index and conflict rule: `docs/governance/doc_status.md`.
- Current runtime status: `docs/governance/current_runtime_status.md`.
- Server runbook: `docs/governance/server_runtime_commands.md`.
- Agent capability governance: `docs/governance/agent-capability-governance.md`.
- Delivery evidence and adversarial acceptance: `docs/governance/delivery-evidence.md`.
