---
name: server-runtime
description: "Server runtime deployment and drift repair for ran-agent/Hermes. Use when changing or operating production server scripts, lite/full Hermes gateways, systemd units, runtime env files, MCP server exposure, deploy hooks, or one-command server rollout. Covers virtualenv activation and env-preserving configuration rules."
---

# Server Runtime Skill

Status: CURRENT (2026-06-23)

## Use When

- The task mentions server deployment, `/opt/ran_agent`, runtime drift, systemd,
  Hermes lite/full, MCP exposure, deploy hooks, or deployment scripts.
- The task changes `scripts/apply-hermes-runtime-split.sh`,
  `scripts/diagnose-*.sh`, Hermes runtime profiles, or server env contracts.
- The task adds a new runtime service or MCP such as Ombre Brain.

## Required Server Command Shape

These are Hermes runtime configuration conditions, not optional shell habits.
When giving production Hermes deploy or repair commands, label them as
configuration prerequisites.

Always include the Python virtualenv activation in server deploy or diagnostic
commands:

```bash
cd /opt/ran_agent
source /opt/ran_agent/.venv/bin/activate
bash scripts/apply-hermes-runtime-split.sh
```

For standard deployment, prefer this sequence:

```bash
cd /opt/ran_agent
source /opt/ran_agent/.venv/bin/activate
git pull --ff-only
bash scripts/apply-hermes-runtime-split.sh
bash scripts/diagnose-lite-full.sh
```

Do not ask the user to remember activation separately. Put it in the command
block or make the script self-sufficient.

## Configuration Preservation Rule

Default to reusing existing runtime configuration.

- New optional env keys in `apply-hermes-runtime-split.sh` should use
  `?KEY=value` in `upsert_env_file` when an existing value is safe to keep.
- Use plain `KEY=value` only for canonical routing and safety keys that the
  deploy script intentionally owns, or when the user explicitly asks to
  overwrite.
- For operator overrides, add a `RAN_AGENT_DEPLOY_*` variable and use it as the
  explicit override path.
- Add every new managed key to `is_managed_env_key`; otherwise drift repair can
  leave stale values in place.
- Preserve secrets and local credentials. Never print keys, cookies, tokens,
  proxy URLs, or platform login state.

Pattern:

```bash
NEW_FEATURE_ENABLED_DEFAULT="${RAN_AGENT_DEPLOY_NEW_FEATURE_ENABLED:-true}"

upsert_env_file "$NODE_ENV_FILE" \
  "?NEW_FEATURE_ENABLED=$NEW_FEATURE_ENABLED_DEFAULT"
```

Use non-optional assignment only when overwriting is part of the contract:

```bash
upsert_env_file "$NODE_ENV_FILE" \
  "HERMES_LITE_API_BASE_URL=http://$API_HOST:$LITE_PORT/v1"
```

## Script Integration Checklist

When adding a production runtime feature:

1. Add defaults near the other `RAN_AGENT_DEPLOY_*` defaults.
2. Add directories to `ensure_runtime_dirs` if the feature needs state/cache.
3. Add env keys to `is_managed_env_key`.
4. Upsert env into all relevant files:
   `/opt/ran_agent/.env.local`, `node_bridge/.env.local`, Hermes full home,
   Hermes lite home, and profile `.env` files as appropriate.
5. Add profile entries only to the profile that should see the MCP:
   lite stays small; full can expose owner/debug tools.
6. If systemd needs the variable at process start, add it to the generated unit.
7. Add or update a `scripts/diagnose-*.sh` checker.
8. Update `docs/governance/server_runtime_commands.md` only with the stable
   script-first command, not one-off repair blocks.

## Ombre Brain Specifics

For Ombre Brain, the canonical upstream is
`https://github.com/P0luz/Ombre-Brain`.

Default posture:

- Deploy through the common runtime script, not manual server edits.
- Keep lite using `personal_memory` as the small public memory surface.
- Treat upstream Ombre Brain as source-runner first:
  `OMBRE_BRAIN_RUNNER=source`, source checkout under
  `.ran_agent_state/ombre-brain/upstream`, venv under
  `.ran_agent_state/ombre-brain/.venv`.
- Docker is optional. Do not install Docker silently from the Hermes runtime
  split script; only use `OMBRE_BRAIN_RUNNER=docker` when the operator has made
  Docker available intentionally.
- Python `personal_memory` should use upstream Ombre first with the repo-local
  shim only as rollback fallback (`PERSONAL_AGENT_OMBRE_BACKEND=official_with_legacy_fallback`).
- Expose direct Ombre MCP tools in full only unless there is a specific reason
  to expand lite, and only when the upstream runner is actually available.
- Store runtime data under ignored state or private `vault/ombre`; never commit
  memory buckets.
- Reuse existing Ombre env values by default. Operator changes should survive
  routine drift repair unless a `RAN_AGENT_DEPLOY_*` override is provided.
