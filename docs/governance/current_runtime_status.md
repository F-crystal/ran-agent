# Current Runtime Status

Status: S12 COMPLETE / PROD_ACCEPTED; PRODUCT-EFFECT RECOVERY COMPLETE; F6 PROD_APPLIED; MINUTES REPLAN LOCAL_VERIFIED; S13 NOT STARTED (2026-08-17)

This is the compact source of truth for current production behavior. Commands
live in `docs/governance/server_runtime_commands.md`; design contracts and
historical phase records stay in their focused governance documents.

## Production

```text
repository_state: post-S12 product-effect repair applied 2026-08-17
source_pointer: current archived F6 production source
core_authority: core-cutover:v1 committed at e298bab161bf0f4882bcef6e9cd701d546b63ff2
companion_overlay: dc5fcf13f86483073c54ac046e1b238a90c91921 retained as rollback-only evidence
runtime: Hermes v0.20.0; deepseek-v4-flash; one gateway on 127.0.0.1:8642
retired_runtime: 8643 absent; ran-agent-hermes-full inactive, disabled and condition-blocked
runtime_stage: S12 COMPLETE / PROD_ACCEPTED; S13 NOT STARTED
services: Node, Python, unified Hermes and direct Ombre Brain active; normal ingress restored
core_runtime: exactly one semantic writer; managed wake active
acceptance_canary: TERMINAL_AMBIGUOUS_NO_RESEND; one attempt; external effect unknown; no resend or duplicate
owner_acceptance_ref: owner-s12-e298-terminal-ambiguous-acceptance-20260813
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

The current production source keeps the trusted `todo.create` reminder
contract and unified Companion source/wake release path. The post-S12
product-effect repair was applied on 2026-08-17; the two dated digest
backfills, verified Calendar creation, replay-safe Todo schedule registration
and managed-wake activation completed. The first catch-up digest then exposed
malformed private-envelope leakage and a missing Core wake exact-date gate.
The bounded F6 repair was deployed through the unified source transaction on
2026-08-17; its production boundary checks pass and the next real 08:00 digest
observation remains. The source makes Python the sole date-specific AIHOT/template/prompt
owner, binds scheduled reports to the persisted occurrence due date and
timezone, restores explicit historical-date preparation, restores verified
`feishu.calendar.create`, keeps Todo and Calendar semantics distinct, and fixes
`/tools/todo/list` to call the existing pending-Todo owner. It adds no runtime,
scheduler, wake, action registry, or delivery authority. That operation exposed
three bounded product-effect defects (reminder binding resolution, dateless
digest acceptance, missing calendar envelope replan); their repair is locally
verified and independently reviewed per
`docs/governance/post-s12-product-effect-repair.md`. Managed wake is active.

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
authorities. S8 adds one local-only rebuildable projector for confirmed,
payload-hash-bound Core/personal-learning events; production still has no
Ombre mutation path.

The converged source deploys main's strict query-only
`personalMemoryMcpServer`, explicit `source_status`, Vault retrieval, Python
extractor assembly, and a fixed 15000 ms child-process boundary. For explicit
owner requests, Hermes proposes the existing typed personal-learning action and
Node accepts it only when the identifier, content class and exact scope format
agree; Python remains the persistence owner.

## Delivery Evidence

Directed isolation probes returned only `飞书独立` on Feishu and `微信独立`
on WeChat; neither channel inherited the sibling channel's answer. The
2026-08-07 08:00 AI digest produced exactly one observed Feishu message
without trailing envelope JSON, closing the named digest occurrence; it is not
a universal exactly-once guarantee. Hermes identity was observed on WeChat and
Feishu, a real personal-memory hit was observed, and a Full-origin search
capability completed through the unified runtime. `8643` remained absent.

On 2026-08-17 the owner Minutes request exposed four model-boundary failures;
all rejected attempts stopped before the lark-cli write. The deployed repair
keeps unknown fields fail-closed, isolates the one strict replan in the
trusted `action_gate_repair` task session, and normalizes only the exact
public Minutes shape. Production then created one `前辈对话3` document in the
unique `中海油` folder; the receipt passed content and parent-folder readback,
the exact-title directory count is one, and the governed final check
`f7-minutes-production-success-final` passed. No ASR, PPT path or direct
document-creation bypass was added.

## Source And Recovery Authority

Binding.v4 completed the earlier runtime apply, rollback and reapply and
records `runtimeRollbackAuthorized=false`; the retained Runtime controller,
artifact, candidate ref, topology and snapshot state are evidence-only. S1
then completed the source dry-run, apply, source rollback and reapply at
`c6c0baf`. Post-S1 source advances accepted S2 at `2dc6d1a`, S3 at `cc66387`,
and S4 at `98fd8b3`; the exact snapshot recorded by
`source-snapshots/current-source.json` is now the source rollback authority
and retains the prior pointer chain. Runtime rollback remains forbidden.

The owner authorized closing the v0.13 rollback window before the 2026-08-07
cleanup; closure relied on bounded v0.20 production acceptance plus the real
binding.v4 source apply/rollback/reapply. Six exact retired payloads were
removed under the root-owned `v013-payloads.deleted.json` record, reclaiming
224079872 allocated bytes; shared runtimes, MCP capabilities, model/index
assets, the v0.20 Runtime and personal data were preserved.

Two earlier companion-overlay attempts are closed as `rolled_back`. Candidate
`dc5fcf13f86483073c54ac046e1b238a90c91921` then ran under a transient systemd
unit and was accepted at `2026-08-07T12:46:10Z`; its transaction records the
exact profile, MCP namespace, Python source, drop-in and overlay digests. The
historical rollback target (`2c8e97c` + accepted overlay) was superseded by S1
source convergence.

## Main Source State

S1a was archived at `0fef0427683a8f3f77deec9e6cff937f7ab0a02e`; its bounded
successor completed at `c6c0baf6dfbcf2cc38a68986292f55649ec93932`. The post-S1
source controller advanced the clean production checkout and accepted source
pointer through S4 to runtime source
`98fd8b38eb4bca9caa6f223f990f1bec3ab6cd0d`. GitHub `main` also contains the
local-only S5 B.2 seam and S7 Package B.3 Node wiring; production remained on
the accepted S4 source until the separately authorized S12 cutover advanced it
to e298; later unified-source transactions advanced the runtime source to
`9df626f` while preserving the e298 Core authority. The source shape keeps one
`ran-agent-companion` profile, one `8642` route, the supported Lite/Full
capability union and a fixed 15000 ms memory boundary, and still aligns four
production-backed contracts:

- canonical `memory_bge_vector_index.*` paths;
- Ombre endpoint absence classified as transport failure;
- unified Hermes and co-reading defaults on `8642`;
- no production-composed or model-facing Ombre mutation; inactive O2 seams are
  absent.

Legacy split-profile release inputs remain excluded from the companion
distribution. The source mode is the only authorized seam through the unified
marker; after S1 it advances only from the accepted source pointer to an exact
archived `main` descendant and restores that pointer on rollback. The legacy
release mode continues to fail closed.

## Active Follow-Ups

The canonical execution order and stage exit conditions live in
`docs/governance/active_sequence.md`. S0-S12 are complete and S12 is
`PROD_ACCEPTED`; Core authority remains e298. Product-effect recovery and
managed-wake activation and F6 production apply are complete. F6OBS is the
ready frontier: observe one real 08:00 digest with a plain dated body and no
visible private protocol. S13 remains not
started. Cleanup also requires separate explicit owner deletion authorization;
none is current.
The S5-era root-worktree drafts
were triaged in S6: the 30 runtime paths remain in the checksummed desktop
patch, the three governance-hook paths belong to their dedicated task, the
three retained runtime semantics were re-implemented on current main, and the
remaining O2/Steward, legacy-deployment, second proactive-delivery and
JSON-outbox content is retired.

The remote branch set is intentionally `main` only. Historical candidate
branches are neither production nor rollback authority; recoverable local S4
convergence artifacts remain ignored under `local_archive/`.

Package A and B.1 Core primitives exist in source; S5 verifies the local B.2
final/outbox/effect/receipt loop, S7 completes local B.3 Node wiring, S8
completes the local governed Ombre projection seam, S9 completes local Package
C scheduling, S10 completes the migration inventory/rehearsal and external
poll fact seam; S11 completes synthetic fault/attention acceptance, including
the still-unwired `attentionValve.mjs`. None is composed into the
production Node write path.
Ombre Gate 5 is retired with O2 and the historical
name is retained only as retired evidence; the single future Core production
gate is uniformly named the Core Cutover Gate (S12). O2 is a retired
migration-era path; only rollback evidence may remain.

## Protected State

Never commit or print env files, credentials, cookies, proxy URLs, runtime
state, private vault content, databases, logs, debug output, provider-visible
history, local archives, caches or personal media.
