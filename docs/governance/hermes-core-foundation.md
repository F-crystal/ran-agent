# Hermes Core Foundation

Status: CURRENT (2026-07-17)

This document records the public source-level status of Hermes Core Package A.
It is not a deployment record and does not change the current production
runtime described by `docs/governance/current_runtime_status.md`.

## Status Boundary

- Package A Core Foundation is implemented in local repository source under
  `node_bridge/src/core/`, with tests under `node_bridge/tests/core/`.
- Schema v1 is frozen. Its migration artifact must not be edited in place;
  every future structural change requires a new migration v2 or later.
- Core is not connected to `channelHub`, `replyBackend`, any frontend,
  provider history, or a presentation adapter.
- Legacy Timeline, durable outbox, Python ingest/memory writers, and other
  legacy writers remain active in the current runtime.
- No Core write path has been deployed or enabled in production. Package B has
  not started, and the one-time production cutover is not authorized.

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
