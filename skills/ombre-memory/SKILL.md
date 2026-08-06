---
name: ombre-memory
description: Inspect or change ran-agent personal-memory recall, Ombre Brain integration, local semantic retrieval, or their deployment boundary.
---

# Ombre Memory

Status: CURRENT (2026-08-06)

## Product Role

- `personal_memory` is the only Hermes-facing personal-memory facade in the
  next unified v0.20 source profile.
- Local SQLite working/profile memory supplies recent context and explicit
  user decisions. FastEmbed with `BAAI/bge-small-zh-v1.5` supplies free local
  semantic ranking over that store; keyword ranking remains available.
- Ombre is a derived read source for emotional and long-term relationship
  context. It is not the authority for technical reality, delivery truth,
  identity, permissions, or Core facts.
- Governance docs remain authoritative for ran-agent runtime facts. Future
  confirmed Core events may project into Ombre, but no projector or Ombre write
  path is authorized in the current line.

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
are not exposed.

Local semantic retrieval is offline at request time. The exact FastEmbed model
must be provisioned into `data/fastembed_cache` before activation; a missing
model reports `local_memory=degraded` and does not trigger a network download.
The model has no API or token charge.

## Deployment Truth

The P2 source is locally verified but not deployed until a new exact candidate installs its pinned
Python dependency/model assets, installs the revised companion profile,
restarts only Python and unified Hermes, and passes the real chain above.
Production currently still runs source `0cbeed7`, exposes direct Ombre through
the deployed historical profile, keeps `18001` active, and keeps `18002`
inactive.

The `18002` O1 adapter, split Lite/Full profiles, and split release controller
are retained only by the still-open v0.13 rollback window. They are not a
fallback or target architecture and must be removed together when that window
closes.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `OMBRE_BRAIN_MCP_URL` | `http://127.0.0.1:18001/mcp` | Internal Ombre read endpoint used by Python |
| `PERSONAL_AGENT_OMBRE_MCP_TIMEOUT_SECONDS` | `10` | Read timeout |
| `PERSONAL_AGENT_VECTOR_MEMORY_ENABLED` | `true` | Local FastEmbed + HNSW ranking |
| `PERSONAL_AGENT_MEMORY_LLM_ENABLED` | `false` | Optional extra extraction call; off by default to avoid hidden cost |

Use `skills/server-runtime/SKILL.md` for any deployment or service change.
Never place vault data, model caches, env files, or credentials in Git.
