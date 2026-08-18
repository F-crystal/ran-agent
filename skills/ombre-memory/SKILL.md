---
name: ombre-memory
description: Inspect or change ran-agent personal-memory recall, Ombre Brain integration, local semantic retrieval, or their deployment boundary.
---

# Ombre Memory

Status: CURRENT (2026-08-18)

## Product Role

- `personal_memory` is the only Hermes-facing personal-memory facade in the
  unified v0.20 source profile.
- Local SQLite working/profile memory supplies recent context and explicit
  user decisions. FastEmbed with `BAAI/bge-small-zh-v1.5` supplies free local
  semantic ranking over that store; keyword ranking remains available.
- Ombre is a derived read source for emotional and long-term relationship
  context. It is not the authority for technical reality, delivery truth,
  identity, permissions, or Core facts.
- Governance docs remain authoritative for ran-agent runtime facts. The owner
  authorized one internal rebuildable projector on 2026-08-08; direct
  model-to-Ombre write and every O2 compatibility path remain forbidden.
- Explicit personal learning uses the existing typed action path: Hermes
  proposes an action identifier and bounded content, Node validates that the
  identifier, content class and format agree, and the authenticated Python
  adapter owns persistence. Ombre remains an independent read-only source.

## Current Source Contract

Python calls the official loopback Ombre Brain MCP at `18001` directly:

```text
personal_memory -> Python -> tools/call breath_search
arguments: {"query": "...", "max_results": 5}
```

The response must be correlated JSON-RPC with
`structuredContent.result: string`. The facade bounds returned text and reports
`hit`, `empty`, `transport_error`, or `protocol_error`; it never turns a failed
call into an empty-memory claim. `hold`, `grow`, and other upstream mutations
are not exposed through `personal_memory` or the public recall MCP.

The S8 source-only projector lives behind Core rather than a model tool. It
accepts only current `personal_learning_confirmed` or
`core_relationship_summary_confirmed` journal events whose content recomputes
to the keyed journal-payload hash. It reuses Core's projection cursor/outbox,
calls only official loopback `hold`, `grow`, `breath_advanced`, and `trace`, and
uses stable event/scope markers for lost-response reconciliation and
erase/rebuild. Do not add a second outbox, direct Hermes mutation tool, or O2
writer.

Local semantic retrieval is offline at request time. The exact FastEmbed model
must be provisioned into `data/fastembed_cache` before activation; a missing
model reports `local_memory=degraded` and does not trigger a network download.
The model has no API or token charge.

## Deployment Truth

Production runs one unified Hermes gateway with `personal_memory`; direct
loopback Ombre on `18001` is active, while the retired `18002` adapter and O2
writer are absent. Public/model-facing recall remains query-only.

The stable backend now composes the accepted projector. A verified successful
`memory.remember`, `memory.correct`, or `memory.forget` receipt creates the
hash-bound Core source before the projector performs the corresponding
hold/replace/erase operation. Confirmed relationship-summary events retain the
existing `grow` mapping. Stable markers reconcile lost responses, and the Core
source stays retryable when projection fails.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `OMBRE_BRAIN_MCP_URL` | `http://127.0.0.1:18001/mcp` | Internal Ombre read endpoint used by Python |
| `PERSONAL_AGENT_OMBRE_MCP_TIMEOUT_SECONDS` | `10` | Read timeout |
| `PERSONAL_AGENT_VECTOR_MEMORY_ENABLED` | `true` | Local FastEmbed + HNSW ranking |
| `PERSONAL_AGENT_MEMORY_LLM_ENABLED` | `false` | Optional extra extraction call; off by default to avoid hidden cost |

Use `skills/server-runtime/SKILL.md` for any deployment or service change.
Never place vault data, model caches, env files, or credentials in Git.
