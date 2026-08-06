# Current Runtime Status

Status: CURRENT (2026-08-06)

This is the compact source of truth for current production behavior. Detailed
commands live in `docs/governance/server_runtime_commands.md`; focused runtime
contracts live in the linked governance docs below.

## Release Lineage

```text
production_repository_sha: bb66f1e6a8a400d599c7f86139107742bbedddc8
runtime_evidence_class: DEPLOYED_RUNTIME_ACCEPTANCE (2026-08-06T09:04:17+08:00..09:13:42+08:00) plus the retained historical audits below
production_observation_stage: DEPLOYED for unified Hermes v0.20; immediate topology acceptance passed, observation window not complete
production_worktree: clean
production_services: Node, Python and unified Hermes active; retired Full inactive/dead, disabled and condition-blocked; direct Ombre Brain 18001 active; recall-only 18002 inactive
production_node: /opt/nodejs/node-v22.22.2-linux-x64/bin/node; node:sqlite probe passed
production_hermes: unified v0.20.0 on 8642; deepseek-v4-flash; one home/profile; no 8643 listener
production_runtime_identity: observed ubuntu:ubuntu; core units declare User=ubuntu
legacy_ran_agent_account_followup: POINT_IN_TIME_AUDIT (2026-08-05T13:42:19.295+08:00..13:42:20.223+08:00); present UID 999/GID 988, nologin; no ran-agent-owned runtime process was observed in the base audit window
production_storage: 42068938752/63290032128 bytes used, 18520346624 bytes available, 70% utilization at 2026-08-06T09:13:42+08:00
runtime_apply_recovery_followup: POINT_IN_TIME_AUDIT (2026-08-06T08:46:03+08:00); production remains clean bb66f1e6 with all four services active, candidate install/topology marker absent, and 18368720896 bytes available (70% utilization)
permission_containment_followup: COMPLETE (2026-08-05T17:07:16+08:00..17:09:04+08:00); seven authorized files ubuntu:ubuntu 0600; /opt/ran_agent/data 0700; five backups matched secret-like key patterns without exposing values; core services and Python health passed; deletion/rotation not authorized
production_memory_surface: existing direct Ombre Brain 18001 active/healthy; recall-only O1 18002 inactive; O2 absent
digest_2026_08_05_followup: POINT_IN_TIME_AUDIT (2026-08-05T13:42:01.034+08:00..13:46:55.750+08:00); EXACTLY_ONCE_OBSERVED externally; Node about 66s; outbox sent attempt 1; one Feishu message; Python 30s timeout left no marker/timeline; do not retry occurrence
digest_deadline_inputs_followup: POINT_IN_TIME_AUDIT (2026-08-05T14:24:21+08:00); Python service environment exposed HERMES_REPLY_TIMEOUT_SECONDS=1200 and FEISHU_SEND_TIMEOUT_SECONDS=30
digest_correction_artifact: four-file patch atop b5b4ff43f8c3d5706192cabefcece49408b73558; unified diff sha256 ada5e89f1912ec0d208adbe91e43596f1528a1512a58f0d63ae5654de4df932f; src/personal_agent/outbound_channel.py, tests/test_outbound_channel.py, node_bridge/src/outboundServer.mjs, node_bridge/tests/outboundServer.test.mjs
digest_correction_stage: LOCAL_VERIFIED (2026-08-05T14:25:28+08:00..14:25:29+08:00) by 7 Python and 67 Node focused/regression tests; caller deadline derived as Hermes deadline + Feishu deadline + 30s margin (1260s under observed 1200s/30s production values) plus live outbox transition clock; not deployed
digest_duplicate_envelope_followup: LOCAL_VERIFIED (2026-08-06); recent digest output exposed a private reply envelope after identical visible prose because the Hermes boundary parsed only whole-string JSON; the shared response parser now accepts only a valid v1 trailing envelope whose message exactly matches that prose and releases the message once; focused Node tests passed; not deployed
unified_identity_projection_compatibility: LOCAL_VERIFIED (2026-08-06); the unified profile renamed the old lite/full prose heading, so the pre-deploy Node identity projection anchor now follows the current stable runtime-topology heading; the complete Hermes gateway test file passes; not deployed
ombre_o1_archived_baseline: 1be3ee58919fb01f1c442d75ba2463e237fba0b2; ARCHIVED; not deployed; real cross-process recall contract blocker
v4_o1_baseline: c52f8ba9b26338204e8ae189d1f1df5f3800e630; ARCHIVED; not deployed
v4_pro: explicit Lite/Full opt-in only; undeployed
node_receipt: deferred
ombre_o2: a978444fc94f21c7d84df1e65e6fa8a8eb7dfdd7; ARCHIVED; projection-only; pre-Gate-5; not deployed
unified_identity_o2_rollback: b5b4ff43f8c3d5706192cabefcece49408b73558; ARCHIVED; not deployed
ombre_o2_total_delete: typed unsupported
gate_5: not started, not authorized
package_b_2_b_3: not started
hermes_v020_unified_runtime_candidate: DEPLOYED for exact candidate 0b793e8fea85c409800ee7e0d615501816c99387, artifact 44572a7be51e66b43aa5f15b9d8442bff52052d4dd0167b75dd85206660cff30 and tree 3049a082c0d1794bdf0f5d681132eaeb84fd7006b5ddb1514694717874214698; exact dry-run left 813932120 bytes headroom; apply returned APPLIED with accepted snapshot /opt/ran_agent-release/runtime-snapshots/runtime-20260806T010417Z-0b793e8fea85; MainPID is the private v0.20 Python, 8642 is the only Hermes listener, Full is inactive/disabled/condition-blocked, cron has 0 jobs and 0 executions, and Node/Python remain active; not yet PROD_VERIFIED
unified_capability_acceptance: configured toolsets and MCP servers equal the legacy source Lite/Full union; terminal/file/session-search and Playwright are present, and all previously active command MCPs launched. Optional obsidian_memory remains registered but parked because the pre-existing iflow uv tool is a malformed 88KB partial install; old split production disabled and filtered this optional MCP. Do not install its Torch/Transformers dependency tree without a separate space-bounded plan
runtime_cleanup_followup: COMPLETE (2026-08-06T09:11+08:00); reset the retired Full unit's stale failed ledger to inactive/dead without starting it, removed three terminal rolled-back Runtime snapshots totaling about 638 MiB, retained only the accepted 0b793e8 snapshot and live v0.13 executables required by its rollback contract; personal data, shared runtimes and unified capabilities were not deleted
runtime_apply_mainpid_incident: ROLLED_BACK (2026-08-06T08:05:58+08:00..08:07:01+08:00); exact candidate 44b84fb11fe8854f510a78d0bea462e9b77b1bb0 passed dry-run, then initial apply inspected MainPID during /usr/bin/env -> dash -> private-python same-PID exec and failed closed before gateway acceptance; the controller restored clean bb66f1e6, all four services and 8642/8643/8787, removed the candidate install, and left no unified-topology marker or active bind topology; do not retry that candidate
runtime_overlay_probe_incident: POINT_IN_TIME_AUDIT (2026-08-06T05:11:22+08:00..05:11:27+08:00); a superseded transient inherited production API_SERVER_PORT/HERMES_HOME after systemd EnvironmentFile precedence and its --replace caused one v0.13 Lite gateway restart; systemd recovery succeeded in five seconds, all four core services remain active, production checkout stayed clean at bb66f1e6, and the accepted 18766 probe showed no business-state delta; this incident is not Runtime deployment
```

This production statement is a bounded `POINT_IN_TIME_AUDIT`, not a promise
about state after the evidence window and not authorization to mutate service
identity, permissions, storage, or the legacy account. The active release
does not contain the archived recall-only O1 baseline, V4+O1 baseline, O2
implementation, or unified-identity candidate.

For the separately timestamped digest follow-up above, external delivery was
observed exactly once, but Python completion truth diverged after its caller
deadline expired. The `LOCAL_VERIFIED` caller-deadline ordering contract and live outbox-clock
correction are not production facts until a separately isolated candidate is
deployed and accepted.

## Superseded Candidate Evidence

The candidate chronology below is retained as historical failure evidence. It
does not describe the current implementation, runtime identity, or deployment
procedure; the release contract and the point-in-time block above take
precedence.

The first four failed candidate gates ran before snapshots, service
interruption, checkout activation, or runtime mutation. Candidate `414210f`
passed that gate, then its transaction rejected a host identity-policy
assumption and reported `rollback-complete`. Production therefore remains on
the recorded SHA at that evidence point. Candidate `7649a94` later passed the
immutable gate and prepared Ombre, but its startup check mixed privileged
systemd PID discovery with an unprivileged `ss -p` process view. The supplied
trace ends when that bounded check stopped dependent startup; it does not show
that transaction's final rollback result. Candidate `8c259dd` later reached a
zero-PID/zero-listener Ombre failure because its `ran-agent` wrapper re-sourced
deployment-user `0600` env files under `set -e`; its owner-supplied trace does
show `rollback-complete`. Production therefore remains on the recorded SHA.
Server acceptance remains the authority after the next apply.

At that candidate evidence point, the repository mainline kept every O1 invariant from
`1be3ee58919fb01f1c442d75ba2463e237fba0b2`, keeps Lite/Full on
`deepseek-v4-flash` with explicit provider-boundary
`thinking: {"type":"disabled"}`, and production-wires O2 for the next formal
release. It was not a claim about the production host at that time.

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
  Ombre home), runs Node and the patched Ombre runner under the same existing
  runtime identity as Hermes (default `ubuntu`), rotates
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
- Candidate `8c259ddcd2a34e80400ac39e444876807960f689` is also not deployable. It
  passed the immutable gate and prepared the pinned Ombre 2.8.8 checkout, but
  the managed `ran-agent` process exited before obtaining a PID/listener because
  its wrapper re-read deployment-user env files. The corrected launcher uses
  explicit managed argv/systemd inputs only; prepare and live source/venv/real
  process checks execute as `ran-agent`, while root only validates ownership
  and orchestrates the transaction. Python 3.12 and all real-process assets now
  fail before snapshot. Completed rollback payload cleanup is classified,
  locked, symlink/mount/inode checked, and evidence-preserving. Final
  transaction directories without state cannot be rollback authority and are
  removed under the same checks; manual recovery of seven such legacy
  directories reclaimed about 15.7 GiB and restored 19GB available without
  touching the live checkout or services. A fresh
  post-prune gate requires allocated blocks and inodes for the complete
  snapshot plus candidate staging and the larger of 25% or 2 GiB byte
  headroom before any copy or service stop. Snapshot cp/tar data
  is atomically committed before its manifest entry, so partial payloads cannot
  become rollback authority. The supplied
  `8c259dd` trace ends with `rollback-complete`; neither O1/O2 nor the Flash
  target is deployed.
- Candidate `3ba6d712ceb464bcbb3068617212979c02bd0e9e` is also not deployable
  yet. It passed the root gate from a manual `/tmp` extraction, but its apply
  stopped before snapshot, service, or checkout mutation when the second
  pre-mutation gate ran as `ran-agent`: the immutable stage lives under the
  root-private `0700` artifact store, so the runtime identity received
  `Permission denied` before opening the gate script. Release tests had masked
  the boundary by chmodding fixture artifact parents to `0711`, a topology
  production never allows. The remediation keeps the store root-private,
  extracts a secret-free copy of the verified candidate archive under `/tmp`,
  seals it root-owned and read-only, proves it byte-identical to the verified
  stage, and runs both gates plus the pre-mutation module-loadability probe
  against that copy. The gate filesystem is budgeted twice — an upfront
  estimate covering the copy plus the node_modules projection, and a measured
  check after `npm ci` — so a full disk stops the transaction before, not
  during, a copy, and the copy is probed as `ran-agent` for readability and
  non-writability before the expensive root gate. Desktop evidence: the full
  release-script suite passes with Linux-root-only checks skipped and a
  `passed` workflow-guard result. On the server the Linux-root release-script
  suite passed 84/85 as root (the sole skip is the non-root-only
  umask-projection check), proving the dual-gate copy, capacity gates, and
  cleanup under the real `0700` topology. The first `ran-agent` full-gate
  rehearsal then exposed a test-isolation leak: identity-map lookups defaulted
  to the production path, which root reads silently but `ran-agent` cannot
  open; the isolated test env and the gate env matrix now pin
  `RAN_AGENT_IDENTITY_MAP_PATH` into each sandbox. The rehearsal then reached
  the Hermes runtime resolution: the production v0.13 runtime is
  editable-installed from the ubuntu home and unreadable to `ran-agent`, an
  identity that never executes Hermes in production. A full classification of
  the suite found five checks that require a non-`ran-agent` identity: the
  provider-boundary and DeepSeek provider checks (ubuntu-owned Hermes
  runtime), plus `hermesModelCutover`, `searchHubApplyScript`, and
  `ombreCompatProductionWiring` (root-only apply tooling that chowns to the
  ubuntu runtime user). The `ran-agent` gate carries an explicit flag that
  prints a reasoned skip for exactly these five — all mandatory in the root
  gate and in acceptance, both pinned off against environment inheritance —
  while every other check still executes as `ran-agent`; unlisted files
  always run. A fresh `ran-agent` full-gate rehearsal on the pushed
  remediation commit is still required before any apply.
- Current zero-PID/disk-pressure remediation evidence: the three focused Node
  release files passed 147/147 under Node 22.22.2; all 9 Steward token/identity
  tests passed as Linux root on the server in an isolated `/tmp` fixture,
  including a real root-to-`ran-agent` venv sentinel and clean-environment
  assertion; the full patched official Ombre 2.8.8 process contract passed
  locally against commit `0e83d4671ce1629e03ad36bb9160235bf60dbd34` and
  Python 3.12. Adversarial review caught and corrected the post-prune capacity
  and partial-manifest rollback hazards. This is pre-deployment evidence only;
  it does not claim server cleanup or acceptance.
- Current release-controller remediation is also pre-deployment. It resolves
  the service-managed Node executable from the active MainPID descendant tree,
  holds the root release lock through a caller-owned cross-UID FIFO, projects
  Git modes and `ubuntu` ownership through no-follow descriptors for root-owned
  tracked residue, and checks runtime imports as `ran-agent`. Capacity uses
  allocated blocks, inodes, and candidate staging; the quiesced snapshot is
  resealed before checkout. Explicit rollback preserves accepted authority on
  interruption, can finalize stale pointer metadata without a second live
  restore, and re-extracts its candidate-pinned six-file controller outside the
  checkout. A later Linux-root immutable gate exposed five test-fixture identity
  leaks: checkout-operator scenarios inherited root EUID, cross-UID children
  inherited a root-private gate `TMPDIR`, and staged-read fixtures lacked
  traversable parent directories. Production rejected those fixtures before
  transaction mutation. The correction is test-only: identity-sensitive
  fixtures use randomized literal `/tmp` roots with explicit ownership/modes,
  checkout scenarios run as `ubuntu`, and cross-UID lock children receive
  `TMPDIR=/tmp`; production checkout, lock, and permission policy is unchanged.
  The local release-script suite collected 83 tests: 81 passed,
  0 failed, and 2 Linux/root-only staged checks were skipped. The Ombre contract
  collected 45 tests: 44 passed, 0 failed, and 1 Linux/root-only ownership check
  was skipped. The final Git-less, read-only desktop `--all` gate ran the real
  patched Ombre 2.8.8 process and Hermes v0.13 Lite/Full boundary, printed
  `hermes-release-smoke: all-ok`, passed 388 Python tests with the single
  Linux-root verifier check skipped, printed `hermes-release-gate: ok`, and
  received a `passed` workflow-guard result. These root-only skips are not
  server acceptance or cleanup evidence.
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

## Unified Hermes Runtime

| Entry | Port | Profile | Home | Default Use |
|-------|------|---------|------|-------------|
| unified | `8642` | `ran-assistant-lite` compatibility ID | `/home/ubuntu/.hermes-ran-agent/lite` | Legacy Lite/Full capability union |

- All legacy Lite/Full bridge URLs and profile selectors resolve to the one
  `8642` instance. There is no `8643` fallback.
- `ran-agent-hermes-full.service` is disabled and condition-blocked; its tiny
  unit/drop-in remain during the active rollback window, not as a second
  runtime.
- The companion profile keeps terminal, file, session search, Playwright,
  media, co-reading and existing MCP registrations. Hermes-native `cronjob`,
  `delegate_task` and `execute_code` remain disabled.

## Deployment And Diagnostics

Unified Runtime deployment/rollback uses its candidate-extracted controller;
compatible code deployment uses the candidate-specific immutable-SHA
transaction in `docs/governance/hermes_release_deployment.md`.
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
| `obsidian_memory` | Optional surface is configured/registered but currently parked on an inherited malformed partial uv tool; not runtime-ready |
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

The authorized production sequence is: cut over and accept the unified
`ubuntu` runtime first; keep any now-idle `ran-agent` account only for old
rollback compatibility; after old-identity rollback authority is retired,
no process or file residue remains, and an accepted `ubuntu` rollback point
exists, request separate approval to delete that account without `-r` or
`--remove-home`.

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
