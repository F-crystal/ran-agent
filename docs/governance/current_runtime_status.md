# Current Runtime Status

Status: CURRENT (2026-08-07)

This is the compact source of truth for current production behavior. Commands
live in `docs/governance/server_runtime_commands.md`; design contracts and
historical phase records stay in their focused governance documents.

## Production

```text
repository_sha: 2c8e97cacd1d2eaed30738abe621f3393cffb885; clean; accepted binding.v4
companion_overlay: dc5fcf13f86483073c54ac046e1b238a90c91921; accepted; source checkout not converged
runtime: Hermes v0.20.0; deepseek-v4-flash; one gateway on 127.0.0.1:8642
retired_runtime: 8643 absent; ran-agent-hermes-full inactive, disabled and condition-blocked
runtime_stage: PROD_VERIFIED for the bounded channel, identity, memory, capability, topology and 2026-08-07 digest evidence
services: Node, Python, unified Hermes and direct Ombre Brain active; no unexpected restart in the acceptance window
identity: production processes run as ubuntu:ubuntu
storage: 70% used; 18391031808 bytes available after retired v0.13 payload deletion
```

WeChat, Feishu/Lark and the optional Desktop proxy share
`ChannelHub -> replyBackend -> hermesGatewayClient -> Hermes`. Conversation
sessions are channel/conversation scoped; non-referential requests do not
inherit another channel's last turn. Python `/chat` is retired and returns 410.

The unified companion keeps the former Lite/Full capability union on one
runtime. Search, terminal/file/session tools, Playwright, media, co-reading and
the supported MCP registrations remain available. The accepted companion
overlay removes `obsidian_memory` from the active Hermes mount namespace and
routes bounded Vault recall through `personal_memory`; the host-visible profile
files remain on the old source checkout and still contain that retired
registration. No replacement dependency was installed.
Hermes-native `cronjob`, `delegate_task` and `execute_code` remain disabled.
Scheduled outbound is limited to explicit reminders, the opt-in AI digest and
governed external-MCP notifications.

## Memory

Production memory uses local SQLite with free offline FastEmbed/HNSW plus
keyword retrieval. `personal_memory` also performs a bounded direct Ombre
`breath_search` through the loopback-only service on `18001`; source failures
are surfaced separately from an empty result. The recall-only adapter on
`18002` is inactive, and the O2 compatibility writer is inactive.

Ombre is a derived relationship/context source, not the authority for Core
facts or deployment truth. Core and governed runtime documents remain the
authorities; future Ombre ingestion must be a rebuildable projection from
confirmed Core events or other explicit sources.

The accepted overlay deploys main's strict query-only `personalMemoryMcpServer`,
explicit `source_status`, Vault retrieval, and Python extractor assembly. Its
controller declares a 15000 ms Python-backend deadline. The active Hermes
parent still receives 5000 ms from later Home/Profile `EnvironmentFile`
entries, while the MCP child receives no explicit value and therefore uses the
overlay server's 15000 ms default. The current request path has the larger
budget, but removing the overlay without reconciling source and env authority
would restore the old 5000 ms behavior. The source-convergence transaction must
make and verify one 15000 ms truth instead of adding another overlay.

## Delivery Evidence

Directed isolation probes returned only `飞书独立` on Feishu and `微信独立`
on WeChat; neither channel inherited the sibling channel's answer.

The 2026-08-07 08:00 AI digest produced exactly one observed Feishu message
without trailing envelope JSON. Node recorded a sent attempt once, and Python
stored the matching sent marker and timeline event without the earlier caller
timeout. This closes the named digest occurrence; it is not a universal
exactly-once guarantee.

Hermes identity was observed on WeChat and Feishu, a real personal-memory hit
was observed, and a Full-origin search capability completed through the
unified runtime. `8643` remained absent.

## Source And Recovery Authority

Binding.v4 completed source apply, source rollback and reapply. It records
`runtimeRollbackAuthorized=false`; the retained Runtime controller, artifact,
candidate ref, topology and snapshot state are evidence-only. Do not invoke
Runtime rollback. The candidate-extracted binding.v4 source controller is the
current rollback path for production source changes.

The owner authorized closing the v0.13 rollback window before the 2026-08-07
cleanup. Closure relied on bounded v0.20 production acceptance plus the real
binding.v4 source apply/rollback/reapply; no separate v0.13 Runtime rollback was
used as a close-out drill. Six exact retired payloads were then removed under
the root-owned `v013-payloads.deleted.json` record, reclaiming 224079872
allocated bytes. Shared runtimes, MCP capabilities, model/index assets, the
v0.20 Runtime and personal data were preserved.

Two earlier companion-overlay attempts are closed as `rolled_back`: the first
exposed the parked Obsidian startup dependency, and the second exposed
client-lifetime and rollback-readiness defects. Candidate
`dc5fcf13f86483073c54ac046e1b238a90c91921` then ran under a transient systemd
unit and was accepted at `2026-08-07T12:46:10Z`. Its transaction records the
exact profile, MCP namespace, Python source, drop-in and overlay digests. The
active rollback target is therefore the real `2c8e97c + accepted overlay`
topology, not the bare host-visible old profile.

## Main Source State

Main is `dc5fcf13f86483073c54ac046e1b238a90c91921`, archived and pushed but not
source-deployed. It preserves the newer Core and personal-memory design,
retires the standalone Obsidian surface, and includes the accepted overlay
controller fixes. Production `2c8e97c` is not its ancestor: the trees are
diverged by 244 files (`+59623/-15594` at the 2026-08-07 audit), so convergence
requires a full classified source review rather than a routine fast-forward.
The source still aligns four production-backed contracts:

- canonical `memory_bge_vector_index.*` paths;
- Ombre endpoint absence classified as transport failure;
- unified Hermes and co-reading defaults on `8642`;
- O2 release/apply/acceptance defaults off unless explicitly enabled.

The archive changed source authority only. A later production source
transaction must still validate and apply one exact main SHA.

## Active Follow-Ups

1. Classify the main-versus-production diff and audit every consumed non-secret
   runtime env key. Then use one overlay-aware source transaction whose apply
   tests the unmounted candidate and whose rollback restores the current
   accepted overlay topology.
2. After source convergence, close the existing-asset Feishu workflow as one bounded
   typed request/receipt path: organize an existing Minutes transcript and
   existing attachment into a cloud document, move it to the requested folder,
   and return the verified document and move result. The 2026-08-07 probe
   produced no action request or trusted evidence, so the completion gate
   correctly refused to claim success. Do not add ASR or presentation
   generation to this path.
3. Improve Ombre ingestion and retrieval only after the current façade is
   stable; use the existing free local embedding stack and do not add a paid
   provider by default.

The remote branch set is intentionally `main` plus
`codex/p2-memory-production-candidate`; retain the latter because it carries the
exact production source lineage until a future main source cutover succeeds.

Package A and B.1 Core primitives exist in source but are not composed into the
production Node write path. Packages B.2/B.3 and Gate 5 have not started. O2 is
an archived migration-era path, remains off, and is not the target architecture.

## Protected State

Never commit or print env files, credentials, cookies, proxy URLs, runtime
state, private vault content, databases, logs, debug output, provider-visible
history, local archives, caches or personal media.
