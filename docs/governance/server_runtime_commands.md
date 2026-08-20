# Server Runtime Commands

Status: CURRENT (2026-08-18)

This is the operator runbook for `/opt/ran_agent`. It contains stable current
commands, not migration journals. Historical S12 and runtime-cutover evidence
lives in `s12-readiness-topology.md`, `hermes_release_deployment.md`, and ignored
release records.

## Current Topology

| Service | Listener | Current role |
|---|---|---|
| `ran-agent-python.service` | loopback `8787` | ingest, memory, knowledge, reflection, scheduling APIs |
| `ran-agent-node.service` | loopback control `8791` | ChannelHub, bridges, Core, delivery, MCP composition |
| `ran-agent-hermes.service` | loopback `8642` | only active Hermes companion gateway |
| `ran-agent-hermes-full.service` | none | retired, inactive, condition-blocked |
| `ran-agent-ombre-brain.service` | loopback `18001` | internal read/projector MCP |
| `ran-agent-xhs-public-sidecar.service` | loopback `18061` | public-only XHS parser sidecar |
| co-reading Web reader | configured Tailscale address `8787` plus loopback backend | private owner reader |

Python, Node, Hermes, and Ombre run as the existing `ubuntu` service identity.
Do not create another Unix user/group or change ownership, permissions, or
storage layout as part of feature/deploy work.

The active Hermes source is `hermes/profile/config.companion.yaml`. It exposes
chat/companionship/play MCPs only. Legacy `config.yaml`, Lite/Full names,
runtime-cutover controllers, and v0.13 artifacts are compatibility or evidence,
not current deployment authority.

## Command Prerequisite

Every production diagnostic, repair, or release command starts with:

```bash
cd /opt/ran_agent
source /opt/ran_agent/.venv/bin/activate
```

Never run `git pull`, `git switch`, `git checkout`, standalone
`apply-hermes-runtime-split.sh`, or hand-written systemd/env mutations as a
deployment shortcut.

## Immutable Source Release

Pin one reviewed archived source and use the common transaction:

```bash
cd /opt/ran_agent
source /opt/ran_agent/.venv/bin/activate

bash scripts/deploy-hermes-candidate.sh \
  --commit <reviewed-40-char-main-sha> --dry-run
```

Only after separate owner authorization, apply the same SHA:

```bash
bash scripts/deploy-hermes-candidate.sh \
  --commit <same-reviewed-40-char-main-sha> --apply
```

`scripts/deploy-hermes-main.sh --dry-run|--apply` is the convenience entrypoint
for reviewed `origin/main`; it fetches, resolves, and pins one exact SHA before
entering the same transaction. Do not treat the branch name itself as apply
authority.

The transaction owns preflight, immutable staging, release gates, snapshot,
checkout activation, dependency reuse/swap, profile projection, service restart,
acceptance, and rollback metadata. Use only the exact rollback command/snapshot
printed by that transaction. Runtime-only cutover rollback is closed and must
not be invoked.

## Environment Ownership

Active EnvironmentFiles:

- `/opt/ran_agent/.env.local`
- `/opt/ran_agent/node_bridge/.env.local`
- `/home/ubuntu/.hermes/.env` for the small Hermes service-only overlay

Owner-only files remain `ubuntu:ubuntu` mode `0600`. Inspect variable names or
explicitly safe non-secret flags only. Never print values for API keys, tokens,
cookies, proxy URLs, Lark identities, recipient bindings, or login state.

Current safety/routing invariants:

- `AI_DAILY_DIGEST_ENABLED=false`; daily reports belong to Codex.
- `EXTERNAL_MCP_GATEWAY_ENABLED=true`, system queue enabled, and activity runner
  enabled; registry/policy/grant/evidence gates remain mandatory.
- `RAN_AGENT_CORE_ENABLED=true` and managed wake enabled.
- `OMBRE_BRAIN_ENABLED=true` and the MCP URL is loopback `18001`.
- Qwen-MM OCR/VLM and knowledge use Token Plan `qwen3.6-flash`.
- ASR and media generation remain on DashScope.
- XHS is public-only; account-backed keys and services remain absent.
- Telegram source support is disabled by default. Production enablement requires
  `TELEGRAM_BRIDGE_ENABLED`, the protected bot/owner bindings, and the dedicated
  `TELEGRAM_PROXY_URL`; never route Telegram through a global Node proxy.
- The active proactive owner presentation binding remains Feishu until a
  separately authorized expected-revision cutover commits WeChat or Telegram.

`OPENCLAW_STATE_DIR` may still appear in the Node process because the vendored
WeChat SDK uses that compatibility name for the current ran-agent state root.
It is not OpenClaw runtime authority. Old OpenClaw gateway credentials and all
MiMo Token Plan/runtime variables are retired and must remain absent.

## Qwen Token Plan

The owner stores `TOKEN_PLAN_API_KEY` in `/opt/ran_agent/.env.local`. Never pass
it in argv or tool output. Configure or revalidate with:

```bash
cd /opt/ran_agent
source /opt/ran_agent/.venv/bin/activate
bash scripts/configure-qwen-token-plan.sh
```

The script reuses the stored key or prompts with hidden input only when absent.
It validates visual chat and Responses APIs, prepares the pinned Qwen-MM
backend, atomically synchronizes root/Node providers and Qwen settings, restarts
the affected services, and restores the prior state on failure.

## Health And Boundary Checks

```bash
cd /opt/ran_agent
source /opt/ran_agent/.venv/bin/activate

bash scripts/diagnose-lite-full.sh
bash scripts/diagnose-hermes-tools.sh
bash scripts/diagnose-hermes-continuity.sh
bash scripts/diagnose-multi-frontend.sh
bash scripts/diagnose-external-mcp-gateway.sh
bash scripts/diagnose-ombre-memory.sh
bash scripts/diagnose-search-hub.sh
bash scripts/diagnose-media-xhs.sh \
  --smoke-generic --smoke-public-sidecar --smoke-social-tools
```

The historical `lite/full` script name is compatibility only. A successful
diagnosis proves one active unified gateway and an inactive Full unit.

For high-risk completion evidence, wrap the separately authorized read-only
check:

```bash
.venv/bin/python scripts/workflow_guard.py verify \
  --label <bounded-label> -- <read-only-command>
```

The guard records evidence; it does not authorize apply, rollback, deletion,
identity/permission changes, or external effects.

## Routing Checks

- Fresh web/news/academic facts enter through `search_hub`.
- Social links enter through `social_reader`; discovered media enters
  `media_reader`.
- XHS uses public parsers only. Never restore `XHS_COOKIE`, QR login,
  account-backed MCPs, token caches, or `ran-agent-xhs-browse.service`.
- Public parser metadata is not content-read evidence; usable text or media
  analysis is required.
- Co-reading normal URLs reuse Search Hub and social URLs reuse Social Reader.
  Browser clients receive only `CO_READING_WEB_ACCESS_TOKEN`; the owner token
  stays server-side.

## Safe Maintenance

UV cache cleanup uses only the scoped helper:

```bash
bash scripts/clean-uv-cache-safe.sh
bash scripts/clean-uv-cache-safe.sh --yes
```

Its protected state includes social-reader markers, `vault/`, `data/`, and
debug media evidence. Do not manually remove snapshot, runtime, model, database,
vault, log, or cache trees of uncertain ownership.

## Retired Boundaries

Do not restore or operate:

- OpenClaw, Kimi, GLM, or MiMo Power as frontend/runtime authorities;
- the v0.13 split deployment or Runtime rollback path;
- the `18002` recall adapter or O2 writer/Steward/token seam;
- Hermes Calendar/Todo/Minutes/digest work executors;
- account-backed XHS services or credentials;
- Python `/chat` or a second conversation runtime.

Exact deleted components are recorded in `cleanup.md`. Current product/runtime
truth lives in `current_runtime_status.md`; completed transaction detail is not
an operator command source.
