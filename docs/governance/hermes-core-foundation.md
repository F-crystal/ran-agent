# Hermes Core Foundation

Status: CURRENT (2026-08-05)

This document records the public source-level status of Hermes Core Package A
and the owner-accepted Package B.1 typed business transactions. It is not a
deployment record and does not change the current production runtime described
by `docs/governance/current_runtime_status.md`.

## Status Boundary

- Package A Core Foundation is implemented in local repository source under
  `node_bridge/src/core/`, with tests under `node_bridge/tests/core/`.
- Schema v1 is frozen. Its migration artifact must not be edited in place;
  every future structural change requires a new migration v2 or later.
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
- Core is not connected to `channelHub`, `replyBackend`, any frontend,
  provider history, or a presentation adapter.
- Legacy Timeline, durable outbox, Python ingest/memory writers, and other
  legacy writers remain active in the current runtime.
- No Core write path has been deployed or enabled in production. Package B.2
  has not started, and the one-time production cutover is not authorized.

## Scheduling And Runtime Target

`docs/governance/hermes-core-scheduling-and-unified-runtime.md` is the current
`DESIGNED` v0.5 amendment for Package C scheduling and the eventual single
Hermes companion runtime. It keeps Schema v1 and Package B/B.1 frozen, proposes
an additive Schema v2, and treats one deploy-owned Hermes cron job only as the
managed clock edge over the same idempotent `core-wake` command. The MVP does
not prebuild a second timer fallback.

That document is not implementation or deployment evidence. Current source has
no Schema v2 ScheduleSpec/WakeOccurrence repository, no composed `core-wake`
service, and no unified production gateway. Production remains governed by
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
state transitions. These are Foundation primitives, not evidence that the
corresponding Package B/C runtime integrations exist.

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

The stable foundation available to a future Package B.2 service now includes
atomic ingress plus immutable assembly intent, atomic part/reference plus
processing transition, durable reference/deferred history, parent-scoped
recovery and candidate readers, global pending-ingress cold-start discovery,
and a seal digest computed from persisted reference state.
`appendPartWithProcessing` is the formal composite part path; the older split
primitives remain compatibility and diagnostic surfaces whose half-states are
explicitly exposed by typed readers rather than hidden.

This accepted source foundation remains inactive. `node_bridge/src/index.mjs`
does not compose the Package B path, and ChannelHub, frontends, provider
gateway/history, Global Timeline, `durableOutbox`, and Python ingest remain on
their existing production paths. Package B.2 service orchestration has not
been implemented.

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
