---
name: server-runtime
description: "Operate the current ran-agent/Hermes production runtime: immutable source deployment, systemd/env diagnostics, MCP exposure, and configuration preservation."
---

# Server Runtime Skill

Status: CURRENT (2026-08-18)

## Current Topology

- `/opt/ran_agent` is the production checkout.
- `ubuntu:ubuntu` owns and runs Python, Node, unified Hermes, and Ombre Brain.
- `ran-agent-hermes.service` is the only active Hermes gateway, on loopback
  `8642`; the retired Full unit must stay inactive and condition-blocked.
- `hermes/profile/config.companion.yaml` is the active source profile.
- Runtime-only v0.20 cutover and v0.13 rollback are closed. Their controllers,
  artifacts, refs, and snapshots are evidence-only, never current repair paths.

## Required Command Shape

Every production diagnostic or release command starts with:

```bash
cd /opt/ran_agent
source /opt/ran_agent/.venv/bin/activate
```

Do not run `git pull`, `git switch`, `git checkout`, standalone
`apply-hermes-runtime-split.sh`, or manual systemd/env rewrites as deployment.
Pin one reviewed immutable source and enter the common transaction:

```bash
bash scripts/deploy-hermes-candidate.sh \
  --commit <reviewed-40-char-main-sha> --dry-run
# A separately authorized production apply uses the same SHA:
bash scripts/deploy-hermes-candidate.sh \
  --commit <reviewed-40-char-main-sha> --apply
```

For the reviewed current `origin/main`, `scripts/deploy-hermes-main.sh` is the
convenience entrypoint. It still resolves and pins one exact SHA before the
same transaction. Follow `docs/governance/hermes_release_deployment.md` and
`docs/governance/server_runtime_commands.md`; never use a branch name as apply
authority.

## Configuration Preservation

- Preserve existing local credentials and operator values unless the accepted
  contract explicitly owns a replacement.
- Optional managed keys use `?KEY=value` in `upsert_env_file`; canonical safety
  and routing keys may use `KEY=value`.
- Expose operator overrides as `RAN_AGENT_DEPLOY_*` values.
- Add every managed key to `is_managed_env_key`; otherwise retired or drifted
  values survive source repair.
- Keep owner-only env files mode `0600`; never print key, cookie, token, proxy,
  recipient, or login-state values.
- Do not change Unix users, groups, ownership, permissions, or storage layout
  without separate explicit owner authorization.

## Integration Checklist

For a production runtime feature:

1. Reuse the existing service, facade, state root, and deploy transaction.
2. Add only required defaults and managed env ownership.
3. Put private state below `.ran_agent_state/` or another ignored runtime root.
4. Add the feature only to `config.companion.yaml` when Hermes must see it.
5. Keep broad shell/file/session/direct-browser tools outside the companion
   profile; external MCPs enter through `external_mcp_gateway`.
6. Add or update one focused `scripts/diagnose-*.sh` check.
7. Update the stable runbook, not a one-off repair transcript.
8. Verify the changed invariant through `scripts/workflow_guard.py` before a
   high-risk completion claim.

## Ombre Brain

- Keep `personal_memory` as the only Hermes-facing memory facade.
- Ombre Brain runs source-first under `.ran_agent_state/ombre-brain` and listens
  on loopback `18001`; Docker is optional and never installed silently.
- Public recall is query-only. The stable Core/Python backend owns the one
  rebuildable hold/grow/correct/forget projector.
- Do not restore the retired `18002` adapter, O2 writer, raw Hermes mutation
  tool, Steward/token seam, or paid embedding dependency.
- FastEmbed assets must be provisioned before activation; request-time recall
  stays `local_files_only`.

## Current Diagnostics

```bash
bash scripts/diagnose-lite-full.sh
bash scripts/diagnose-hermes-tools.sh
bash scripts/diagnose-external-mcp-gateway.sh
bash scripts/diagnose-ombre-memory.sh
bash scripts/diagnose-media-xhs.sh
```

The historical `lite/full` wording in the first script name is compatibility
only; a successful result must prove one unified gateway and an inactive Full
unit.
