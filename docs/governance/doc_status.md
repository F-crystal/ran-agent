# Documentation Status

Status: CURRENT (2026-08-06)

A current read-only audit at `2026-08-06T21:47:13+08:00` supersedes the older
production-head statements below: production is clean
`0cbeed729255cfdc13af7aec1438880b2ae79ec5`; unified Hermes v0.20 remains the
only gateway on `8642`, `8643` is absent, retired Full is inactive/disabled,
Node/Python are active with zero restarts since the 19:35 source apply, direct
Ombre `18001` is active, recall-only `18002` is inactive, and storage is 70%
used with 18,435,219,456 bytes available. Source binding v1 accepted
`bb66f1e6 -> 57638ce`; binding v2 accepted `57638ce -> 0cbeed7`. These are
`DEPLOYED` facts, not `PROD_VERIFIED` claims for the pending digest, identity,
memory-hit, and capability observations.

`POINT_IN_TIME_AUDIT`
(`2026-08-05T13:30:09+08:00..13:35:11+08:00`) revalidated production SHA
`bb66f1e6a8a400d599c7f86139107742bbedddc8`, a clean worktree, four active core
units, Hermes v0.13.0 with `deepseek-v4-flash`, the existing direct Ombre path
on `18001`, and 68% storage utilization (39/59 GB used, 19 GB available).
Recall-only O1 on `18002` was inactive and O2 was absent from the active
revision/configuration. All observed runtime processes used `ubuntu:ubuntu`.
The separately authorized permission containment completed at
`2026-08-05T17:09:04+08:00`: seven files are now `ubuntu:ubuntu 0600` and
`/opt/ran_agent/data` is `0700`; services and Python health remained good.
Only secret-like key counts were collected, never values. Five backups matched
secret-like patterns; rotation and deletion remain separately unauthorised.

A separate `POINT_IN_TIME_AUDIT`
(`2026-08-05T13:42:19.295+08:00..13:42:20.223+08:00`) confirmed that the
legacy `ran-agent` account remained present with UID 999/GID 988 and a nologin
shell. Combined with the base window's process inventory, no ran-agent-owned
runtime process was observed. This does not authorize identity mutation or
account deletion.

For the single 2026-08-05 08:00 digest occurrence, a separate
`POINT_IN_TIME_AUDIT`
(`2026-08-05T13:42:01.034+08:00..13:46:55.750+08:00`) established
`EXACTLY_ONCE_OBSERVED`: Node completed in about 66 seconds, the durable outbox
recorded `sent` on attempt 1, and exactly one matching Feishu message was
observed. The Python caller timed out at 30 seconds and persisted no sent marker
or timeline row. This is occurrence-scoped evidence, not a global exactly-once
guarantee, and that occurrence must not be retried.

The four-file digest correction atop `b5b4ff4` is bound by unified-diff SHA-256
`ada5e89f1912ec0d208adbe91e43596f1528a1512a58f0d63ae5654de4df932f`.
Its caller deadline is derived as Hermes deadline + Feishu deadline + 30-second
margin. A read-only Python-service environment check at
`2026-08-05T14:24:21+08:00` observed 1200/30 production values, yielding a
1260-second caller deadline; its
outbox transitions use a live clock. The artifact is `LOCAL_VERIFIED` by 7
Python and 67 Node tests in
`2026-08-05T14:25:28+08:00..14:25:29+08:00`; its behavior was subsequently
deployed by source binding v1 and remains pending a clean real 08:00 cycle.

The duplicate JSON observed after recent AI digests is a separate output-boundary
defect: Hermes sometimes returned visible prose followed by the same private reply
envelope, while the bridge recognized envelopes only when the whole content was
JSON. The shared Hermes response parser now recognizes only a valid v1 trailing
envelope whose `message` exactly matches the preceding prose, then exposes that
message once. Invalid, mismatched, or JSON-example suffixes remain visible. The
same validation found that the unified profile's renamed runtime-topology heading
would break Node identity projection after a future source deploy; its parser
anchor now follows the current heading. The complete Hermes gateway test file
passed; both corrections were subsequently deployed by the accepted source
bindings and remain short of `PROD_VERIFIED`.

O1 `1be3ee5`, V4+O1 `c52f8ba`, O2 `a978444`, and the unified-identity/O2
rollback line `b5b4ff4` are `ARCHIVED` and not deployed to production. The
strict Python -> HTTP -> Node recall contract was locally verified and archived
at `deed261`, but production still uses direct `18001` and keeps `18002`
inactive. Gate 5 is not authorized, `total_delete` remains
unsupported, Node Receipt is deferred, and Package B.2/B.3 have not started.

The Hermes v0.20 Runtime is `DEPLOYED` from exact candidate
`0b793e8fea85c409800ee7e0d615501816c99387`; it is not yet `PROD_VERIFIED`.
Immediate acceptance observed the private v0.20 MainPID, one `8642` Hermes
listener, no `8643`, retired Full inactive/disabled/condition-blocked, zero
cron jobs/executions, and active Node/Python. The accepted rollback authority
is `runtime-20260806T010417Z-0b793e8fea85`. Three older terminal rolled-back
Runtime snapshots were deleted after acceptance, reclaiming about 638 MiB.
Optional `obsidian_memory` remains registered but parked on its inherited
malformed partial uv tool; old split production had disabled and filtered it,
so no large ML dependency install was attempted during cutover. The prior
`44b84fb11fe8` failed apply and completed rollback remain disclosed in the
runtime status/evidence.

Two bounded source-only transactions subsequently advanced the clean production
checkout to `0cbeed7` without replacing the accepted Hermes MainPID. They
deployed the digest deadline/outbox corrections, trailing-envelope
normalization, conversation-scoped session continuity, and explicit memory
tool recall behavior. The main-source convergence change is `LOCAL_VERIFIED`
only until it is archived and separately applied; it does not turn the parked
`18002` O1 adapter or O2 into production behavior.

The personal-memory P2 source is `LOCAL_VERIFIED_NOT_DEPLOYED`: 137 focused
Python tests plus 8 subtests and 6 Node tests pass on Linux. The next unified
profile has one public `personal_memory` facade, Python reads bounded Ombre
`breath_search` internally on `18001`, and local semantic retrieval uses the
free offline FastEmbed `BAAI/bge-small-zh-v1.5` model. The deployed historical
profile still exposes direct Ombre until a new exact candidate supplies the
pinned dependency/model assets and applies the revised profile.

This file is the public documentation index and conflict rule. Historical
deployment notes belong under ignored `local_archive/`, not under
`docs/governance/`.

## Lifecycle Stages

Stages describe completed lifecycle events for one exact artifact and scope;
they are not permanent quality scores. Every claim binds its artifact,
evidence, and time. A separately recorded known blocker prevents advancement.

| Stage | Meaning |
|---|---|
| `DESIGNED` | An approved contract or design exists; no implementation claim. |
| `IMPLEMENTED` | Code exists for the named scope; no validation or deployment claim. |
| `LOCAL_VERIFIED` | Required isolated/local acceptance passed for that exact artifact. |
| `ARCHIVED` | The exact artifact was committed and pushed with archive evidence; this is not deployment approval. |
| `DEPLOYED` | The production mutation completed; no post-deploy acceptance claim. |
| `PROD_VERIFIED` | Bounded production acceptance or observation passed for the named dimensions and time window. |

## Public Source Of Truth

| Document | Ownership |
|----------|-----------|
| `README.md` / `README_en.md` | User-facing project overview |
| `hermes/README.md` / `hermes/README_en.md` | Hermes profile distribution overview |
| `AGENTS.md` | Repo-root operating rules |
| `CLAUDE.md` | Claude shim that points to canonical `AGENTS.md` |
| `hermes/profile/AGENTS.md` | Hermes profile runtime constraints |
| `hermes/profile/config.companion.yaml` | LOCAL_VERIFIED_NOT_DEPLOYED next unified profile; preserves the capability union except the duplicate direct Ombre tool, whose read capability remains behind personal_memory |
| `docs/governance/doc_status.md` | Documentation index and conflict rule |
| `docs/governance/current_runtime_status.md` | Compact current runtime truth |
| `docs/governance/hermes-core-foundation.md` | Local-only Core Package A boundary and frozen Schema v1 |
| `docs/governance/hermes-core-scheduling-and-unified-runtime.md` | DESIGNED Schema v2 scheduling, single clock projection, and unified Hermes runtime target |
| `docs/governance/server_runtime_commands.md` | Script-first server runbook |
| `docs/governance/hermes_release_deployment.md` | Immutable-SHA Hermes deployment, acceptance, rollback, and RC-to-main closure |
| `docs/governance/hermes_release_bootstrap.v1.sha256` | Bootstrap framework source-digest manifest |
| `docs/governance/phase_status.md` | Historical phase closure status |
| `docs/governance/constraints.md` | Runtime and implementation constraints |
| `docs/governance/co-reading.md` | Co Reading storage, import, MCP, privacy, and API contract |
| `docs/governance/co-reading-web-reader.md` | Tailscale-only Co Reading Web reader deployment and acceptance |
| `docs/governance/skills.md` | On-demand skill map |
| `docs/governance/delivery-evidence.md` | High-risk feasibility, validation evidence, and adversarial acceptance contract |
| `docs/governance/agent-capability-governance.md` | Shared agent skill, hook, plugin, and MCP governance |
| `docs/governance/sub_agents.md` | Sub-agent candidate policy |
| `docs/governance/cleanup.md` | Retired/deleted component record |
| `docs/governance/media-pipeline.md` | Media pipeline and context policy |
| `docs/governance/sticker-catalog.md` | Cross-channel sticker catalog and safe `RAN_MEDIA` contract |
| `docs/governance/hermes-action-contract-gate.md` | Hermes action contract validation, repair, and pending-action rules |
| `docs/governance/hermes_action_compatibility.v1.json` | Versioned closed registry of protected compatibility evidence signals |
| `docs/governance/hermes_protected_capabilities.v1.json` | Legacy split-profile capability digest retained with the v0.13 rollback line |
| `docs/governance/hermes_runtime_artifact.v1.json` | Immutable LOCAL_BUILT provenance and digest manifest for the pinned Hermes v0.20 artifact; later Linux verification is recorded separately and neither document alone is deployment approval |
| `docs/governance/hermes_runtime_linux_verification.v1.json` | LOCAL_VERIFIED native Linux artifact/profile, exact eight-file overlay, 218-second MCP keepalive, zero-business-state-delta, and Git-less ubuntu/root controller evidence; includes the disclosed superseded 8642 restart probe |
| `docs/governance/hermes_runtime_mutation.v1.json` | DEPLOYED by exact candidate 0b793e8fea85c409800ee7e0d615501816c99387; accepted snapshot retained for rollback; observation remains before PROD_VERIFIED |
| `docs/governance/hermes-context-optimization.md` | Hermes context optimization, cache-friendly history, and soft reset |
| `docs/governance/external-mcp-gateway.md` | External MCP gateway, admission, evidence, and proactive system queue |
| `docs/governance/wechat-bridge-media-buffer.md` | WeChat media buffering semantics |
| `docs/governance/mimo-power-mcp.md` | Retired MiMo Power MCP record |
| `docs/governance/multi_frontend_identity_strategy.md` | Multi-frontend identity and timeline |
| `docs/governance/prompt-slimming-audit.md` | Prompt slimming ownership audit |

## Conflict Rule

1. Runtime code behavior is first truth.
2. Then the public source-of-truth docs listed above.
3. Local archives are context only and are not part of the public release
   surface.

## Hermes Reliability Release Status Boundary

For the Hermes reliability release, `docs/governance/` describes current
runtime behavior and release contracts. The 2026-07-10 Core and External MCP
design documents remain proposed target architectures, even where individual
components landed. Their implementation plans are historical task records with
unchecked items and must not be read as either a release checklist or a claim
that all design goals are deployed. The superseded durable-game document is a
compatibility pointer only.

Historical release lineage entries are superseded by
`docs/governance/current_runtime_status.md`; they must not be used to describe
the current production SHA.

## Governance Rules

- Keep `AGENTS.md` light and self-contained. Keep `CLAUDE.md` as a shim to
  `AGENTS.md`. Detailed runtime facts belong in `docs/governance/` or skills.
- Keep `docs/governance/current_runtime_status.md` compact; move commands to
  `server_runtime_commands.md`, specialized runtime contracts to focused
  governance docs, and historical detail to `phase_status.md`.
- Keep `server_runtime_commands.md` script-first. Do not add one-off pasteable
  repair logs.
- Keep governance docs in English. README files may be Chinese/English pairs.
- Keep runtime state, private vault content, logs, databases, debug outputs,
  env files, and local archive material out of Git.
- Completed code/doc changes that need GitHub synchronization must go through
  `skills/archive-and-push/SKILL.md`.

## Current Closed Runtime Fixes

- Hermes lite/full runtime split is closed on
  `scripts/apply-hermes-runtime-split.sh` and
  `scripts/diagnose-lite-full.sh`.
- Search Hub is the unified fresh web/news/academic search entry; actual
  social links still read through `social_reader` / `media_reader`.
- XHS is public-only. Deploy prepares `wanyi-watermark` via
  `/opt/ran_agent/.ran_agent_state/social_reader/generic-fallback-ready.json`
  and the XHS-Downloader sidecar via
  `/opt/ran_agent/.ran_agent_state/social_reader/xhs-public-sidecar-ready.json`;
  account-backed browse service, `XHS_COOKIE`, `xiaohongshu-mcp`, and legacy
  token caches are removed by `scripts/apply-hermes-runtime-split.sh`.
- XHS evidence gate separates `link_resolution`, `metadata_read`, and
  `content_read`; public metadata cannot claim content read.
- Request id logging is unified across context-size, routing, evidence, and
  evidence-gate logs.
- Node root env and `node_bridge/.env.local` are both managed for XHS public
  parser and generic fallback marker consistency.
- Media reader startup fallback now matches production DashScope OCR defaults;
  PaddleOCR is an explicit local override.
- Scheduled outbound allowlist paths are the opt-in AI daily digest and
  explicit user-created reminders. Reminders use ProactiveEvent egress; neither
  path reopens old proactive check-ins.
- `co_reading` Web reader is Tailscale-only, supports bilingual reading,
  browser imports, scoped Hermes margin replies, and explicit shared annotation
  deposit to `vault/inbox/co_reading/`.
- `sticker_catalog` is the current cross-channel sticker surface. Hermes may
  emit only safe `RAN_MEDIA` markers with `stickerId`; assets stay in ignored
  runtime state.
- Hermes Action Contract Gate is the current guard for tool-backed actions:
  high-risk writes require explicit confirmation or pending-action state.
- Bridge-authored safety notices are neutral `bridge_*` messages. They may be
  sent to users, but are filtered out of Hermes recent/global assistant history.
- Hermes context optimization is closed as a conservative package: local recent
  history, bounded global active topic, optional cache-friendly append history,
  and opt-in lite soft reset all write only under ignored runtime state.
- `external_mcp_gateway` is registered as a stable MCP broker for dynamically
  admitted game/forum/browser MCPs. Source profiles fall back disabled, while
  standard server deploy enables the gateway/system-queue env gates. Dynamic
  admission uses candidate states, safe remote Streamable HTTP execution,
  scoped bounded activities, and global-user stop interruption; notifications
  require watchlist and rate budget, while T4/T5 writes require pending action
  evidence or trusted scoped grants.
- External MCP policy explain/call paths share trusted session context; compact
  aliases like `list_games`/`listgames` resolve only when unique, and private
  upstream session ids are reused without entering public evidence.
- External MCP background activities use bridge-created target tokens, then
  internal `activityId` session resolution; public activity prompts must not
  expose target/session/upstream secrets.
- Slow WeChat/Feishu replies use the managed reply-window contract:
  `HERMES_REPLY_TIMEOUT_SECONDS`, default-off quick ack, authorized async final
  send, and distinct Feishu ack/final idempotency keys.
- The archived O1 contract retained by the local V4+O1 candidate exposes only
  the local recall-only adapter to Hermes;
  raw upstream Ombre MCP is isolated. This is not a production claim.
