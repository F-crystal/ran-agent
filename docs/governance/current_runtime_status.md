# Current Runtime Status

Status: CURRENT (2026-08-01)

This is the compact source of truth for current production behavior. Detailed
commands live in `docs/governance/server_runtime_commands.md`; focused runtime
contracts live in the linked governance docs below.

## Release Lineage

```text
production_repository_sha: bb66f1e6a8a400d599c7f86139107742bbedddc8
runtime_evidence_class: USER_SUPPLIED_RUNTIME
local_o1_online_revalidation: not performed
production_worktree: clean in owner-supplied 2026-07-31 preflight
production_services: four core units active in owner-supplied 2026-07-31 preflight
production_node: /opt/nodejs/node-v22.22.2-linux-x64/bin/node; node:sqlite probe passed
rejected_deployment_candidates: 834eabef5a2e8883d3237f7b35c96f70d1fac7a9 (desktop-only Hermes path); f6f6048029de6e4c73b5b8b11f1441069770786c (release tests assumed Git metadata and non-root sudo behavior); 8ff3ce43d6b90bf6f972a8293b83a912e5f9cb77 (O1 contract test ignored the gate-provided Python path); 62fca911a09ea7246393cdedece048ee91b4abb5 (provider tests treated the Hermes source project as its runtime venv); 414210f238215d0f8ef83175851b5ed311ad5d06 (identity verifier treated login.defs allocation defaults as existing-account authority); 7649a9471b15b09e9aac25bed269a0e5d8b254dc (cross-user Ombre socket ownership was probed without the existing privilege seam); first four stopped at the immutable pre-mutation gate; 414210f rolled back completely; the supplied 7649a94 trace ends at the bounded startup failure before dependent services and does not yet establish rollback completion
ombre_o1_archived_baseline: 1be3ee58919fb01f1c442d75ba2463e237fba0b2; undeployed
v4_o1_baseline: c52f8ba9b26338204e8ae189d1f1df5f3800e630; archived and pushed; undeployed
v4_pro: explicit Lite/Full opt-in only; undeployed
node_receipt: deferred
ombre_o2: a978444fc94f21c7d84df1e65e6fa8a8eb7dfdd7; independently reviewed implementation baseline; current line adds owner-authorized production wiring; source fail-off; official release default enabled; non-authoritative, projection-only, pre-Gate-5; not deployed
ombre_o2_total_delete: typed unsupported
gate_5: not started, not authorized
package_b_2_b_3: not started
```

This production statement is `USER_SUPPLIED_RUNTIME`, not revalidated by this
local integration line. The formal production release does not contain the
archived O1 baseline, V4+O1 baseline, or O2 implementation.
The owner-supplied preflight showed no tracked or untracked worktree changes.
The first four failed candidate gates ran before snapshots, service
interruption, checkout activation, or runtime mutation. Candidate `414210f`
passed that gate, then its transaction rejected a host identity-policy
assumption and reported `rollback-complete`. Production therefore remains on
the recorded SHA at that evidence point. Candidate `7649a94` later passed the
immutable gate and prepared Ombre, but its startup check mixed privileged
systemd PID discovery with an unprivileged `ss -p` process view. The supplied
trace ends when that bounded check stopped dependent startup; it does not show
the transaction's final rollback result. Server acceptance remains the
authority after the next apply.

The repository mainline keeps every O1 invariant from
`1be3ee58919fb01f1c442d75ba2463e237fba0b2`, keeps Lite/Full on
`deepseek-v4-flash` with explicit provider-boundary
`thinking: {"type":"disabled"}`, and production-wires O2 for the next formal
release. It is not a claim about the still-unrevalidated production host.

## Ombre O2 Reviewed Production Candidate Boundary

The Ombre O2 Stewarded Growth compatibility implementation is archived and
pushed to `main` at `a978444fc94f21c7d84df1e65e6fa8a8eb7dfdd7` under
`node_bridge/src/ombreCompat/`. Honest status, matching the O2 implementation
contract:

- It has passed independent v0.7 design and implementation review and was
  archived and pushed by transaction `20260731T091737Z-81081`. The baseline
  `c52f8ba9b26338204e8ae189d1f1df5f3800e630` (V4+O1) is archived on main but
  still undeployed and unverified in production. Archive-and-push is not
  deployment approval.
- The compatibility writer remains fail-off in source when
  `OMBRE_COMPAT_ENABLED` is absent. The official server apply/release path now
  manages it as enabled by default; ordinary drift repair preserves an
  existing effective operator `false`, while the formal release passes an
  explicit reviewed value. No production Ombre data or external DeepSeek
  endpoint was contacted during this implementation or review.
- Curator and Reviewer are separate tool-less calls to the pinned DeepSeek
  provider boundary. They reuse `DEEPSEEK_API_KEY`, default to
  `deepseek-v4-flash`, force non-thinking JSON output, and fail before O2 state
  creation if required authentication is absent. V4 Pro remains an explicit
  deployment opt-in rather than a fallback.
- The compatibility queue is **pre-Gate-5, non-authoritative, and
  projection-only**: it is not a Canon, Journal, Soul, permission, or
  read-your-write source, and Lite/Full still see only the O1 recall-only
  read surface.
- **Gate 5 is neither executed nor authorized**; the Gate 5 pieces present
  are migration-mapping and sunset dry-run contracts against fixtures only.
- The archived implementation connects the presentation-gated worker pipeline to a
  patched pinned Ombre Steward API and implements compatibility-owned payload
  deletion plus Ed25519 receipt verification. These are local test results,
  not deployment or production claims. `total_delete` remains typed
  unsupported; O2 contains no Core source-deletion signer or private key.
- Its release candidate separates staged source from the canonical live
  state directory (including a non-default release state root and its derived
  Ombre home), fixes Node and the patched Ombre runner to the verified
  `ran-agent:ran-agent` system account and numeric MainPID identity, rotates
  the owner-only Steward token transactionally, excludes it from retained
  snapshots/archives, rejects a stale rotation drop-in before mutation, and
  keeps O2 ingress disabled during token rotation and critical rollback.
  Three adversarial production-wiring review rounds fixed startup auth,
  duplicate-env drift, rollback residue, and hidden Pro fallback paths.
- Production remains on the pre-O1 shape; Flash + O1 + O2 are still not
  validated or deployed there. Node Receipt stays deferred, and Package
  B.2/B.3 have not started.
- Candidate `834eabef5a2e8883d3237f7b35c96f70d1fac7a9` is not deployable: its
  immutable gate embedded a desktop-only Hermes executable path. The current
  remediation resolves the installed v0.13 executable independently from both
  Lite and Full systemd units, requires the canonical executables to match,
  and injects that absolute path only into the isolated provider-boundary test.
  This is a gate portability correction, not a Hermes or model upgrade.
- Candidate `f6f6048029de6e4c73b5b8b11f1441069770786c` is also not deployable:
  its next immutable-gate layer exposed release tests that read `.git` and
  relied on the deploy fixture selecting the non-root `sudo` branch. The
  current remediation supplies the immutable candidate SHA explicitly, fixes
  the fixture privilege seam independently of EUID, and codifies Git-less,
  read-only, root/non-root, `env -i` portability in `AGENTS.md`. It changes no
  production runtime or model policy.
- Candidate `8ff3ce43d6b90bf6f972a8293b83a912e5f9cb77` is also not deployable. The
  next server gate exposed `ombreO1Contract.test.mjs` hard-coding a desktop
  Python executable instead of consuming the already validated
  `RAN_AGENT_PYTHON_BIN`. Every child process therefore failed to spawn on the
  server. The correction uses the explicit gate input, rejects spawn errors
  immediately, and keeps a regression assertion against developer-machine
  paths. This gate also failed before snapshot, service interruption, checkout
  activation, or runtime mutation; no rollback or Hermes/model change occurred.
- Candidate `62fca911a09ea7246393cdedece048ee91b4abb5` is also not deployable. Its
  provider tests read the Hermes `Project:` source path and incorrectly assumed
  that the active interpreter lived at `Project/venv/bin/python`. The service
  actually runs Hermes from the ran-agent venv while loading an editable source
  project elsewhere. The correction derives the test interpreter from the
  verified Lite/Full service Hermes executable's sibling `python`, validates
  its provider import closure, and uses the same boundary in the acceptance
  diagnostic. This gate also stopped before production mutation; Hermes remains
  v0.13 and the model remains Flash.
- Candidate `414210f238215d0f8ef83175851b5ed311ad5d06` is also not deployable. It
  passed the complete immutable gate, then the transaction treated
  `/etc/login.defs` system-ID allocation defaults as authority over an existing
  `ran-agent` account and rejected a valid host layout. The transaction reported
  `rollback-complete`; production stayed on its previous revision. The
  correction removes that policy-file dependency while retaining `--system`
  account creation, non-root numeric identity, NSS/passwd/group consistency,
  fixed home and nologin shell, systemd names, and live process UID/GID checks.
- Candidate `7649a9471b15b09e9aac25bed269a0e5d8b254dc` is also not deployable.
  Its apply path read the Ombre unit MainPID through `sudo systemctl` but read
  socket process metadata through the deployment user's unprivileged `ss -p`.
  Linux can hide another account's socket PID, so a healthy `ran-agent` listener
  was indistinguishable from a wrong owner. The correction preserves the strict
  MainPID/listener/health contract, obtains socket metadata through the same
  privilege seam in startup, acceptance, failure context, and diagnostics, and
  reports active/PID/listener/health dimensions on a bounded startup failure.
  This is a release-observability portability fix, not an Ombre, Hermes, or
  model change. Rollback completion for the supplied failed run is not yet
  evidenced.
- Fresh production-wiring evidence: 137 focused Node tests passed under Node
  22.22.2, including O2 runtime, tool-less Curator/Reviewer, managed env,
  release residue, model policy, and gateway fallback checks. Shell/Python
  syntax and diff validation also passed. This does not replace server
  acceptance or contact a real DeepSeek/Ombre endpoint.
- Pre-remediation O2 production-wiring baseline: Node 22.22.2 standard full discovery collected 1410
  tests across 116 files (1409 passed, 0 failed, 1 environment-gated skip);
  the sole skip, `real patched Ombre process satisfies Steward API v1
  contract`, is gate-skipped because its controlled-process environment
  variables are absent from the standard full run, not failed or ordinarily
  skipped. All 120 tests across the 13 Core files passed. Python 3.10.9 full
  discovery collected 377 tests across 37 files (377 passed, 0 failed,
  0 skipped).
- Remediation evidence: four focused release-gate/resolver checks passed,
  including poisoned inherited PATH and override rejection, Lite/Full canonical
  runtime mismatch, missing executable, and v0.14 fail-closed cases. The real
  independent Lite/Full Hermes provider-boundary integration passed with the
  explicit local v0.13 executable. The archive transaction reruns full Node and
  Python discovery before push.
- Environment-portability remediation evidence: the four release-transaction
  failures reproduced from the server report passed 4/4 after the candidate SHA
  and privilege seam became explicit. Strict owner/group fixtures passed 49/49
  under `env -i` with a host temporary root whose inherited group differed from
  the process group; the four Python Hermes/token regressions also passed 4/4
  in that shape. The complete Git-less, read-only staged `--all` gate then ran
  every admitted Node test file, passed the real Hermes v0.13 provider boundary
  and release smoke, passed all 377 Python tests, printed
  `hermes-release-gate: ok`, and received a `passed` workflow-guard result.
- O1 contract Python-path remediation evidence: the server-shaped isolated O1
  contract file passed 42/42 with an explicit absolute Python input; a missing
  input now reports `ENOENT` instead of silently using a desktop fallback. The
  full release-script file passed 50/50. The complete `--all` release gate then
  passed every admitted Node file, printed `hermes-release-smoke: all-ok`,
  passed all 377 Python tests, printed `hermes-release-gate: ok`, and received a
  `passed` workflow-guard result.
- Hermes runtime-interpreter remediation evidence: the provider boundary file
  passed 4/4 with an explicit Hermes v0.13 runtime interpreter; the release and
  model transaction files passed 56/56, including source-only project layout,
  missing-interpreter, and Lite/Full service drift regressions. The complete
  staged `--all` gate passed every admitted Node file, printed
  `hermes-release-smoke: all-ok`, passed all 378 Python tests, and printed
  `hermes-release-gate: ok`.
- Steward identity portability evidence: all 8 focused Python token/identity
  tests and 3 release transaction/acceptance tests passed, including a matching
  non-root UID/GID outside conventional system allocation ranges and the full
  preserve-runtime-shape path.
- Cross-user listener portability evidence: the regression hides PID metadata
  from ordinary `ss` and exposes it only through the deployment privilege seam;
  both startup and acceptance checks pass in that shape. The full release-script
  file passed 51/51 with explicit Node and Python runtimes. The complete
  read-only isolated `--all` gate then passed every admitted Node test, the real
  Hermes v0.13 provider boundary, `hermes-release-smoke: all-ok`, and all 378
  Python tests; it printed `hermes-release-gate: ok` and received a `passed`
  workflow-guard result.

## Mainline

```text
WeChat / Feishu / Desktop Proxy
  -> ChannelHub
  -> replyBackend
  -> hermesGatewayClient
  -> Hermes gateway lite/full
  -> DeepSeek V4 Flash
  -> reply

Python backend
  -> ingest / memory / knowledge / reflection / scheduler / reminders

External MCP candidates
  -> external_mcp_gateway
  -> optional /external-mcp/system-queue synthetic Hermes turn
```

- Provider: `hermes`; model: `deepseek-v4-flash`; fallback provider: none.
- The reviewed candidate keeps Lite and Full on `deepseek-v4-flash`; the
  installed Hermes v0.13 DeepSeek provider policy adds
  `thinking: {"type":"disabled"}` to the final provider HTTP body. Pro is
  available only through explicit `RAN_AGENT_DEPLOY_HERMES_MODEL=deepseek-v4-pro`.
- Python frontend `/chat` returns 410.
- OpenClaw, Kimi, GLM, and MiMo Power are retired frontend paths.
- WeChat, Feishu/Lark, and Desktop proxy share `ChannelHub`, `IdentityMap`,
  `GlobalTimeline`, and the same `replyBackend` path.
- Desktop Proxy is disabled by default and should stay bound to localhost or a
  controlled private network when enabled. Set `DESKTOP_PROXY_API_KEY` before
  exposing it beyond the local machine.
- Scheduled outbound is limited to allowlisted paths: explicit reminders, the
  opt-in AI daily digest, and governed external MCP watchlist notifications.
  Generic life-loop/check-in outbound remains retired.
- Hermes action semantics are declared by typed `replyEnvelope.actionRequests`
  or verified from protected compatibility signals. The bridge audits those
  inputs and never selects an MCP tool from ordinary user/reply text.
- Manual and scheduled AI-digest generation run in a task-scoped Hermes
  session and deliver through the durable outbox. They do not consume or write
  ordinary conversation/cache/soft-reset history.
- The same closed task scope also applies to action repair, release journey,
  proactive events, and external-MCP system-queue turns; their audit state stays
  in their existing receipts/ledgers/outboxes, never the ordinary timeline.

## Lite/Full Runtime

| Entry | Port | Profile | Home | Default Use |
|-------|------|---------|------|-------------|
| lite | `8642` | `ran-assistant-lite` | `/home/ubuntu/.hermes-ran-agent/lite` | Normal chat, XHS, media, memory |
| full | `8643` | `ran-assistant` | `/home/ubuntu/.hermes-ran-agent` | Debug, commands, logs, Playwright, media generation, `lark-cli` |

- `8642` is a lite-context entry, not a security sandbox.
- Node bridge auto-selects via `RAN_AGENT_CAPABILITY_MODE=auto`.
- Full unavailable -> lite fallback with logged reason.
- Compact systemd is current: `ran-agent-hermes.service` owns lite and
  `ran-agent-hermes-full.service` owns full.
- Stale lite/full drop-ins should be absent after
  `scripts/apply-hermes-runtime-split.sh`.

## Deployment And Diagnostics

Standard deploy/drift repair is `bash scripts/apply-hermes-runtime-split.sh`.
Run diagnostics through the repo scripts named in
`docs/governance/server_runtime_commands.md`, including lite/full,
external MCP, proactive events, multi-frontend, continuity, and Ombre Brain.
Do not hand-edit systemd or runtime env as the normal repair path.

## Runtime Env Contract

The deploy script keeps root Node env, `node_bridge/.env.local`, lite/full
Hermes homes, and lite/full Hermes profile env files aligned.

Important non-secret env groups:

- Current candidate model policy: `HERMES_PROVIDER=deepseek`,
  `HERMES_INFERENCE_PROVIDER=deepseek`,
  `HERMES_DEFAULT_MODEL=deepseek-v4-flash`,
  `HERMES_INFERENCE_MODEL=deepseek-v4-flash`,
  `HERMES_PRO_MODEL=deepseek-v4-flash`, and
  `HERMES_DEEPSEEK_THINKING_MODE=disabled`.
- Hermes routing and cache: `HERMES_LITE_API_BASE_URL`,
  `HERMES_FULL_API_BASE_URL`, `HERMES_CONTEXT_INJECTION_MODE`,
  `HERMES_CONTEXT_CACHE_STRATEGY`, `HERMES_CACHE_*`.
- Public XHS/media: `SOCIAL_READER_GENERIC_FALLBACK_ENABLED`,
  `XHS_PUBLIC_*`, `MEDIA_READER_*`, `PERSONAL_AGENT_OCR_*`.
- Managed UV/Ombre state: `UV_CACHE_DIR`, `UV_TOOL_DIR`,
  `OMBRE_BRAIN_*`, `OMBRE_BRAIN_STATUS_FILE`, `PERSONAL_AGENT_OMBRE_*`.
- O2 compatibility writer: `OMBRE_COMPAT_ENABLED`, canonical state/Steward
  paths, and fixed Curator/Reviewer endpoint/model keys. Authentication reuses
  `DEEPSEEK_API_KEY`; no second production key is written.
- External MCP/proactive gates: `EXTERNAL_MCP_GATEWAY_ALLOW_ENV_ENABLE=true`,
  `EXTERNAL_MCP_GATEWAY_ENABLED=true`,
  `EXTERNAL_MCP_SYSTEM_QUEUE_ENABLED=true`,
  `EXTERNAL_MCP_ACTIVITY_RUNNER_ENABLED=true`, `HERMES_PROACTIVE_*`.
- Reply-window gates: `HERMES_REPLY_TIMEOUT_SECONDS`,
  `NODE_BRIDGE_QUICK_ACK_*`, `FEISHU_SEND_TIMEOUT_SECONDS`, and
  `FEISHU_DOWNLOAD_TIMEOUT_SECONDS`.

UV/UVX runtime work must use the managed cache/tool directories. Use
`scripts/clean-uv-cache-safe.sh` for cleanup and do not delete social-reader
state, vault, data, or XHS note debug output.

## MCP And Routing

| Server | Purpose |
|--------|---------|
| `search_hub` | Fresh web/news/academic/platform search entry |
| `co_reading` | Full-profile shared reading room and Web reader |
| `time` | Timezone-aware time queries (`Asia/Shanghai`) |
| `media_reader` | OCR, ASR, VLM, video, batch media analysis |
| `social_reader` | Social content reading (Bilibili, XHS, WeChat articles, music) |
| `sticker_catalog` | Local sticker picker/attach/save catalog |
| `personal_memory` | Personal memory recall and backend health check |
| `obsidian_memory` | Optional Obsidian vault search, disabled by default |
| legacy direct Ombre surfaces | Prior production-repository shape; the local O1 recall-only replacement is not deployed |
| `media_generation` | Image and speech generation |
| `playwright` | Dynamic/visual web pages, full/debug use |
| `external_mcp_gateway` | Stable broker for governed external MCPs |

- Search Hub is the daily fresh-search entry. Actual social links still use
  `social_reader` / `media_reader` first.
- XHS links are public-only and must not first-read through browser navigation,
  terminal navigation, cookies, QR login, or account-backed MCPs.
- Co Reading is kept out of the lite daily conversation toolset; it remains
  available in full and through the Tailscale-only Web reader.
- Sticker Catalog is registered in lite/full. Lite can pick/attach stickers and
  save trusted inbound media only when the user explicitly asks to save it.

## Safety Gates

- Media pipeline details: `docs/governance/media-pipeline.md`.
- Sticker Catalog details and server smoke: `docs/governance/sticker-catalog.md`.
- Multi-frontend identity/timeline details:
  `docs/governance/multi_frontend_identity_strategy.md`.
- WeChat media buffer details:
  `docs/governance/wechat-bridge-media-buffer.md`.
- Hermes context optimization:
  `docs/governance/hermes-context-optimization.md`.
- Hermes Action Contract Gate:
  `docs/governance/hermes-action-contract-gate.md`.
- External MCP gateway and system queue:
  `docs/governance/external-mcp-gateway.md`.
- Local-only Hermes Core Foundation and frozen Schema v1:
  `docs/governance/hermes-core-foundation.md`.

Core safety facts:

- `replyBackend` runs Hermes Action Contract Gate before replies leave Node.
  Unsupported success claims are observed, rewritten, or repaired according to
  mode; pending state lives under `.ran_agent_state/action_contract/`.
- Bridge-authored action-gate, repair, and pending-action notices use `bridge_*`
  sources and are not replayed into Hermes assistant history.
- Ordinary WeChat/Feishu chats do not quick-ack by default. Long authorized
  background work must return a later proactive final through approved event
  gates and the same adapter path.
- External MCP background activity uses a short bridge-created target token
  only on explicit user intent, then uses `activityId` for later tool calls;
  session ids, target ids, upstream ids, cookies, and tokens must not appear
  in activity prompts or public evidence.
- Public XHS parsers are resource resolvers, not OCR/VLM readers. Complete
  image understanding happens only after assets enter `media_reader`.
- Complete-read claims require content evidence; canonical URLs and public
  metadata are only link-resolution/metadata evidence.
- External MCP manifests are untrusted until normalized and classified. Local
  executable MCP candidates cannot self-enable; T4/T5 side effects require
  pending action evidence or trusted scoped grants plus real executor evidence.

## Scheduled AI Daily Digest

Enable with `AI_DAILY_DIGEST_ENABLED=true`; default time is `08:00`
`Asia/Shanghai`. Delivery reuses the Feishu `ChannelHub -> replyBackend`
path, so follow-up questions stay in the same timeline. If no Feishu DM target
exists, the digest is skipped. Do not hard-code raw Feishu ids in public docs.

## Protected Local State

Never commit or force-add env files, credentials, cookies, proxy URLs, runtime
state, logs, debug output, provider-visible history, pending-action state,
media assets, parser/sidecar markers, private `vault/` content,
`local_archive/`, `.venv/`, caches, or `node_modules/`.

## Known Follow-Up Boundaries

Hermes Core Package A and frozen Schema v1 exist in repository source. Package
B.1 typed business transactions are also implemented there and have received
owner acceptance. Its additive recovery API is also owner accepted and gives a
future B.2 service atomic ingress/intent and part/processing operations,
durable reference/deferred state, factual recovery/candidate readers, and a
reference-aware seal digest. The owner-accepted global pending ingress reader
also provides verified cold-start discovery without an identity seed. These
are inactive repository primitives, not a runtime service.
`node_bridge/src/index.mjs` does not compose the Core B path;
ChannelHub, frontends, the provider gateway/history, Global Timeline,
`durableOutbox`, and Python ingest remain on their existing paths. Package B.2
service implementation has not started, no Core B path has been deployed, and
no partial Core production write path is authorized.

The deployed release does not yet unify automatic memory recall, Ombre direct
and wrapper surfaces, Vault recall, ordinary session continuity, and
provider-visible history under one control plane. It also does not establish a
single final-delivered assistant turn as the proven shared source for every
timeline, backend, provider-history, and session layer. These are follow-up
audit topics, not claims about current production behavior.
