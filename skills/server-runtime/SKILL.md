---
name: server-runtime
description: "Server runtime deployment and drift repair for ran-agent/Hermes. Use when changing or operating production server scripts, lite/full Hermes gateways, systemd units, runtime env files, MCP server exposure, deploy hooks, or one-command server rollout. Covers virtualenv activation and env-preserving configuration rules."
---

# Server Runtime Skill

Status: CURRENT (2026-08-07)

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

Always include the Python virtualenv activation in server deploy, repair, or
diagnostic commands:

```bash
cd /opt/ran_agent
source /opt/ran_agent/.venv/bin/activate
```

Standalone Lite/Full drift repair is retired. An authorized repair must use an
exact immutable release transaction; that transaction may invoke the staged
split compatibility script internally while production still runs v0.13:

```bash
cd /opt/ran_agent
source /opt/ran_agent/.venv/bin/activate
bash scripts/deploy-hermes-candidate.sh --commit <reviewed-40-char-sha> --dry-run
```

Do not run `git pull`, `git switch`, or `git checkout` in the production
checkout before deployment. The release transaction resolves and gates one
immutable, reviewed candidate SHA. Do not use a floating `origin/main` apply as
the default deployment instruction; follow the candidate-specific release
contract in `docs/governance/hermes_release_deployment.md`.

For the unified Hermes v0.20 Runtime-only cutover, use the exact
candidate-extracted controller instead of the legacy candidate controller.
Keep the reviewed SHA, artifact, controller, and rollback snapshot explicit:

```bash
cd /opt/ran_agent
source /opt/ran_agent/.venv/bin/activate
RUNTIME_CANDIDATE=<reviewed-40-char-sha>
RUNTIME_CANDIDATE_REF=refs/ran-agent/runtime-candidates/$RUNTIME_CANDIDATE
RUNTIME_CONTROLLER=/opt/ran_agent-release/runtime-artifacts/deploy-hermes-runtime-release-<reviewed-40-char-sha>.py
RUNTIME_ARTIFACT=/opt/ran_agent-release/runtime-artifacts/hermes-runtime-<candidate-short-sha>.tar.gz
git update-ref "$RUNTIME_CANDIDATE_REF" "$RUNTIME_CANDIDATE" 0000000000000000000000000000000000000000
test "$(git rev-parse --verify "$RUNTIME_CANDIDATE_REF^{commit}")" = "$RUNTIME_CANDIDATE"
sudo "$RUNTIME_CONTROLLER" --candidate "$RUNTIME_CANDIDATE" --artifact "$RUNTIME_ARTIFACT" --mode dry-run
sudo "$RUNTIME_CONTROLLER" --candidate "$RUNTIME_CANDIDATE" --artifact "$RUNTIME_ARTIFACT" --mode apply
```

The apply output is Runtime rollback authority only while the current source
binding records `runtimeRollbackAuthorized=true`. During that window, pass its
exact snapshot to the same candidate-extracted controller:

```bash
sudo "$RUNTIME_CONTROLLER" --candidate "$RUNTIME_CANDIDATE" --mode rollback \
  --snapshot /opt/ran_agent-release/runtime-snapshots/<exact-transaction-directory>
```

Once the unified topology marker exists, never use
`deploy-hermes-candidate.sh` or standalone `apply-hermes-runtime-split.sh` as a
Runtime rollback path; both intentionally fail closed at that boundary. Retain
the candidate-named controller, `refs/ran-agent/runtime-candidates/<SHA>`, and
the accepted snapshot together for the complete rollback window. Once a later
accepted source binding records `runtimeRollbackAuthorized=false`, these are
evidence-only: do not invoke Runtime rollback. Use only that source candidate's
reviewed `source-rollback` mode for source changes.

Do not ask the user to remember activation separately. Put it in the command
block or make the script self-sufficient.

## Configuration Preservation Rule

Default to reusing existing runtime configuration.

- New optional env keys in the release-internal
  `apply-hermes-runtime-split.sh` should use
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
- Keep `personal_memory` as the only public personal-memory surface. Ombre is
  an internal read source behind Python, not a second Hermes tool.
- Treat upstream Ombre Brain as source-runner first:
  `OMBRE_BRAIN_RUNNER=source`, source checkout under
  `.ran_agent_state/ombre-brain/upstream`, venv under
  `.ran_agent_state/ombre-brain/.venv`.
- Docker is optional. Do not install Docker silently from the Hermes runtime
  split script; only use `OMBRE_BRAIN_RUNNER=docker` when the operator has made
  Docker available intentionally.
- Python reads `OMBRE_BRAIN_MCP_URL` directly through bounded
  `breath_search`; do not deploy the retired `18002` adapter or a raw Hermes
  Ombre tool in the unified profile.
- Provision FastEmbed dependencies and the pinned local model as candidate
  assets before restart. Runtime recall must stay `local_files_only` and must
  not download or call a paid embedding API.
- Store runtime data under ignored state or private `vault/ombre`; never commit
  memory buckets.
- Reuse existing Ombre env values by default. Operator changes should survive
  routine drift repair unless a `RAN_AGENT_DEPLOY_*` override is provided.
