# Hermes Core Foundation

Status: IMPLEMENTED FOUNDATION REFERENCE (2026-08-18)

This document records the public source-level contract of Hermes Core Packages
A-E. All five packages completed their staged acceptance and were composed by
the S12 production cutover. Exact live state and later repairs remain governed
by `docs/governance/current_runtime_status.md`.

## Status Boundary

| Package | Current status | Production disposition |
|---|---|---|
| A | COMPLETE | Frozen Schema v1 foundation accepted and retained. |
| B | COMPLETE | Typed final/presentation transactions and Node delivery path are live; the presentation binding uses the dedicated `binding:channel-hub:v1` namespace and its repository reader is part of current `main`. |
| C | COMPLETE | Schema v2 scheduling, managed wake and WorkRun authority are live. |
| D | COMPLETE | Legacy migration, quiescence, suppression and reconciliation completed at S12 cutover. |
| E | COMPLETE | Fault, no-resend and attention acceptance completed before cutover and remains the production invariant. |

- Package A Core Foundation is implemented in local repository source under
  `node_bridge/src/core/`, with tests under `node_bridge/tests/core/`.
- Schema v1 is frozen. Its migration artifact must not be edited in place;
  every future structural change requires a new migration v2 or later.
- Package C adds immutable migration `core-0002-scheduling`, ScheduleSpec and
  WakeOccurrence repositories, scheduled WorkRun creation/claim, and an
  injected `wakeDue()` clock edge. Existing v1 databases upgrade in place.
- Package D adds the governed 19-component migration manifest, a read-only
  legacy-copy inspector/rehearsal command, and a hash-bound external-poll Core
  fact writer. The fact writer requires a claimed `external_poll` WorkRun,
  binds the server identifier to its Schedule revision, and exposes no delivery
  operation.
- Package B.1 typed business transactions are implemented in the same local
  Core source and have received owner acceptance. The accepted Conversation,
  ingress, assembly, Turn, Provider Epoch, final-commit, and presentation
  contracts use typed operation receipts and parent-scoped readers.
- The additive Package B.1 recovery API has also received owner acceptance.
  It closes atomic ingress/intent commit, atomic part/processing commit,
  durable reference/deferred state, factual recovery readers, and
  reference-aware seal digest consistency without changing Schema v1.
- The Package B.1 global pending ingress reader has received owner acceptance.
  The existing typed reader can discover cold-start recovery work without an
  identity seed while retaining verified Conversation scope, canonical scoped
  pagination, and fail-closed corruption handling.
- Package B.2 added the orchestration seam in
  `node_bridge/src/core/packageB/packageBDeliveryService.mjs`. It composes the
  existing final transaction, outbox claim and dispatch-start boundary, one
  injected adapter effect, and the typed result receipt. Reopen/replay returns
  the terminal result without invoking the effect again.
- Package B.3 connected ChannelHub to the Core path. S12 then established one
  production semantic writer and accepted the managed wake and presentation
  boundary. Later presentation-binding repair removed namespace ambiguity
  without creating another writer or effect path.
- Compatibility state may remain where current runtime governance names it,
  but it is not a second Core semantic authority.

## Scheduling And Runtime Target

`docs/governance/hermes-core-scheduling-and-unified-runtime.md` is the Package
C-E contract and accepted cutover design. Schema v2, the deploy-owned managed
wake and the single production semantic writer are live. The MVP retains no
second timer fallback. Production remains governed by
`docs/governance/current_runtime_status.md`.

## Frozen Schema v1

| Item | Frozen value |
|------|--------------|
| schema version | `1` |
| tables | `41` |
| named indexes | `7` |
| triggers | `62` |
| migration ID | `core-0001-initial` |
| migration range | `0 -> 1` |
| migration checksum | `0cbc7bc1afddeff8ac11ce40cf54ee54fe444fe3ba23c63cbf8271db1db31151` |
| schema fingerprint | `9cc3f1e4a62c9d7809d31d477e1b4e41fec49b12dd44b1f3dcaf4b0235270671` |

Migration-history mismatch and actual-schema drift fail closed. Package B must
not alter these values, reorder the v1 statements, or redefine its checksum
source.

## Additive Schema v2

| Item | Current value |
|------|---------------|
| schema version | `2` |
| migration ID | `core-0002-scheduling` |
| migration range | `1 -> 2` |
| migration checksum | `3918da27972ec41c2547b250abf5d659e9a93d66339001deed9dfa6a59b67ba2` |
| schema fingerprint | `ee2a9d60fbbc037c28cee8870182a695635005542ca40d4fd8437616fbdf52b5` |

Schema v2 adds `schedule_spec`, append-only `schedule_spec_revision`,
append-only `wake_occurrence`, and the nullable immutable
`work_run.wake_occurrence_id`. It does not rewrite any Schema v1 statement.

## Stable Foundation Boundary

The supported application entry is `openCoreDatabase({ dbPath })`. Its stable
lifecycle is:

1. open an explicit database path;
2. call `core.migrate()` before business writes;
3. submit short synchronous writes through `core.writer.write(callback,
   { priority? })`;
4. use only typed transaction-facade repositories inside the callback;
5. use `core.reader` for typed reads outside the write queue;
6. call `core.close()` and await queue drain.

The production object exposes no raw `DatabaseSync`, SQL executor,
`prepare`, public transaction runner, generic patch, Canon hard-delete, or
legacy/JSON fallback. Transaction facades are revoked when their synchronous
callback returns or throws; delayed and Promise-based writes cannot escape.

Package A supplies typed primitives for journal/payload append, trusted ingress
identity, tombstone/publication/effect receipts, projection reservation and
cursor CAS, Work Run revision/fence CAS, and the database half of Living Soul
state transitions. These primitives alone are not production evidence; current
composition and acceptance are recorded in `current_runtime_status.md`.

## Owner-Accepted Package B.1 Boundary

Package B.1 adds six typed transaction namespaces inside the synchronous,
revoked CoreWriter transaction facade:

- `packageBAssembly`
- `packageBFinal`
- `packageBIngress`
- `packageBPresentation`
- `packageBProvider`
- `packageBTurn`

Conversation identity is an immutable typed binding covering owner, actor,
platform, source instance, platform-native Conversation identity, provenance,
and revision. Presentation bindings are separate routing authority; sharing or
changing a destination route does not create or mutate Conversation identity.

Assistant Canon writes are not exposed as standalone public primitives. A
final assistant Turn, its first revision, ordered presentation outbox items,
typed receipts, and durable result identity commit atomically in one SQLite
transaction. Provider Epoch identity and source snapshot bindings are
immutable; typed state transitions and sequential attempts retain sufficient
non-secret metadata for close/reopen rebuild readback.

The foundation composed by the Package B.2 service includes
atomic ingress plus immutable assembly intent, atomic part/reference plus
processing transition, durable reference/deferred history, parent-scoped
recovery and candidate readers, global pending-ingress cold-start discovery,
and a seal digest computed from persisted reference state.
`appendPartWithProcessing` is the formal composite part path; the older split
primitives remain compatibility and diagnostic surfaces whose half-states are
explicitly exposed by typed readers rather than hidden.

Production composes the Package B path through the Node/Core mainline and keeps
one semantic writer and one presentation effect path. ChannelHub, frontends,
provider history, Global Timeline, and compatibility surfaces do not become
second authorities. Package B.2 adds no fallback store or duplicate delivery
runtime.

## Operation Identity

Fence rotation and projector claim use a versioned request-semantic digest:

```text
sha256:v1:<64 lowercase hexadecimal digits>
```

The operation key is only a parent-scoped lookup key. Equal key and equal full
semantic digest returns `already_applied` with the first immutable receipt
result. Equal key with different request semantics fails with
`CORE_OPERATION_KEY_CONFLICT` and zero mutation. Missing or inconsistent
receipt identity fails closed rather than re-executing the operation.

## Trust Boundary

The Foundation assumes an owner-only Core directory and database, one trusted
Node process, and one logical CoreWriter per canonical database. SQLite runs in
WAL mode with foreign keys, `synchronous=FULL`, recursive triggers, enabled
CHECK constraints, and a bounded busy timeout. It does not claim to resist a
same-UID process that replaces or directly corrupts the SQLite file.

All Package A tests use temporary databases. The production target remains
`<RAN_AGENT_STATE_DIR>/core/core-state.sqlite3`, but Package A does not resolve,
open, migrate, or write that production path automatically.
