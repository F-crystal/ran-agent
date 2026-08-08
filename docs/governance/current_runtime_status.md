# Current Runtime Status

Status: S4 PROD_VERIFIED; S5 LOCAL_VERIFIED (2026-08-08)

This is the compact source of truth for current production behavior. Commands
live in `docs/governance/server_runtime_commands.md`; design contracts and
historical phase records stay in their focused governance documents.

## Production

```text
repository_sha: 98fd8b38eb4bca9caa6f223f990f1bec3ab6cd0d
companion_overlay: dc5fcf13f86483073c54ac046e1b238a90c91921 retained as rollback-only evidence
runtime: Hermes v0.20.0; deepseek-v4-flash; one gateway on 127.0.0.1:8642
retired_runtime: 8643 absent; ran-agent-hermes-full inactive, disabled and condition-blocked
runtime_stage: PROD_VERIFIED for the bounded channel, identity, memory, capability, topology and 2026-08-07 digest evidence
services: Node, Python, unified Hermes and direct Ombre Brain active; no unexpected restart in the acceptance window
identity: production processes run as ubuntu:ubuntu
storage: 70% used; 18201784320 bytes available after S4 source activation
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
governed `external_mcp_gateway` notifications.

## Memory

Production memory uses local SQLite with free offline FastEmbed/HNSW plus
keyword retrieval. `personal_memory` also performs a bounded direct Ombre
`breath_search` through the loopback-only service on `18001`; source failures
are surfaced separately from an empty result. The recall-only adapter on
`18002` and the O2 writer are absent. S4 removed that writer, its
Steward/token/model endpoint code, and its dedicated release gate without
changing the direct `18001` read path.

Ombre is a derived relationship/context source, not the authority for Core
facts or deployment truth. Core and governed runtime documents remain the
authorities; future Ombre ingestion must be a rebuildable projection from
confirmed Core events or other explicit sources.

The converged source deploys main's strict query-only
`personalMemoryMcpServer`, explicit `source_status`, Vault retrieval, Python
extractor assembly, and a fixed 15000 ms child-process boundary. For explicit
owner requests, Hermes proposes the existing typed personal-learning action and
Node accepts it only when the identifier, content class and exact scope format
agree; Python remains the persistence owner.

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

S2 accepted one production `feishu.minutes_to_doc` action envelope for the
existing `个人成长` Minutes transcript with the four bounded scope fields and a
421-character text-only DocxXML fragment. The canary stopped before the Node
executor to avoid creating a duplicate. Before deployment, the same existing
transcript was organized into one document directly in the uniquely matched
`中海油` folder and passed document readback and folder-parent verification.
The action path adds no ASR or PPT dependency.

S3 deployed source `cc663876881e4d1f5cfb67f20d74230730a2f68c`. A
privacy-preserving production probe selected an existing active
personal-learning record without printing its key or content and observed
`personal_learning=hit` through `personal_memory`; the independent Ombre source
returned the valid observable outcome `empty`. Node, Python, unified Hermes and
direct Ombre remained active.

S4 archived and deployed source
`98fd8b38eb4bca9caa6f223f990f1bec3ab6cd0d`. The full release suite passed
80 tests with three Linux-root-only skips, the source controller passed 33
tests, and production independently reported Node, Python, unified Hermes and
direct Ombre active. Node had no O2 environment residue; `18001` was open and
`18002`/`8643` were closed. Obsolete worktrees and branches were closed only
after a verified Git bundle plus binary patches and untracked-file archives
made their remaining drafts recoverable.

S5 local verification composes the existing Package B final transaction,
presentation outbox claim and dispatch-start boundary, one injected effect and
typed terminal receipt. The focused reopen/replay check invokes the effect once
and returns the durable sent state on replay; all 121 Core tests pass. No
production service, database, route, flag or source pointer changed.

## Source And Recovery Authority

Binding.v4 completed the earlier runtime apply, rollback and reapply and records
`runtimeRollbackAuthorized=false`; the retained Runtime controller, artifact,
candidate ref, topology and snapshot state are evidence-only. S1 then completed
the source dry-run, apply, source rollback and reapply at `c6c0baf`. Post-S1
source advances then accepted S2 at `2dc6d1a`, S3 at `cc66387`, and S4 at
`98fd8b3`; the exact snapshot recorded by
`source-snapshots/current-source.json` is now the source rollback authority and
retains the prior pointer chain. Runtime rollback remains forbidden.

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
historical rollback target was the real `2c8e97c + accepted overlay` topology,
not the bare host-visible old profile; S1 source convergence superseded it.

## Main Source State

S1a was archived at `0fef0427683a8f3f77deec9e6cff937f7ab0a02e`;
its bounded successor completed at
`c6c0baf6dfbcf2cc38a68986292f55649ec93932`. The post-S1 source controller then
advanced the clean production checkout and accepted source pointer through S4
to runtime source `98fd8b38eb4bca9caa6f223f990f1bec3ab6cd0d`. GitHub `main`
also contains the local-only S5 B.2 seam; production remains on the accepted S4
source until a separately authorized cutover.
The source shape keeps one `ran-agent-companion` profile, one `8642` route, the
supported Lite/Full capability union and a fixed 15000 ms memory boundary.
The source still aligns four production-backed contracts:

- canonical `memory_bge_vector_index.*` paths;
- Ombre endpoint absence classified as transport failure;
- unified Hermes and co-reading defaults on `8642`;
- no direct Ombre mutation; inactive O2 seams are absent.

Legacy split-profile release inputs remain excluded from the companion
distribution. The source mode reuses the existing candidate controller and is
the only authorized seam through the unified marker; after S1 it advances only
from the accepted source pointer to an exact archived `main` descendant and
restores that pointer on rollback. The legacy release mode continues to fail
closed.

## Active Follow-Ups

The canonical execution order and stage exit conditions live in
`docs/governance/active_sequence.md`. S0-S5 are complete and the ready frontier
is empty. The preserved root-worktree draft was classified separately from S5:
its legacy `durableOutbox` proactive-delivery changes were not treated as Core
B.2 or merged wholesale.

The remote branch set is intentionally `main` only. Historical candidate
branches are neither production nor rollback authority; recoverable local S4
convergence artifacts remain ignored under `local_archive/`.

Package A and B.1 Core primitives exist in source, and S5 locally verifies one
B.2 final-transaction/outbox/effect/result-receipt loop with 121 passing Core
tests and reopen/replay without a second effect. It is not composed into the
production Node write path; B.3 and Gate 5 have not started. O2 is a retired
migration-era path; only rollback evidence may remain.

## Protected State

Never commit or print env files, credentials, cookies, proxy URLs, runtime
state, private vault content, databases, logs, debug output, provider-visible
history, local archives, caches or personal media.
