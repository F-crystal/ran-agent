---
name: ombre-memory
description: Inspect or change ran-agent personal-memory recall, Ombre Brain integration, local semantic retrieval, or their deployment boundary.
---

# Ombre Memory

Status: CURRENT (2026-08-08)

## Product Role

- `personal_memory` is the only Hermes-facing personal-memory facade in the
  unified v0.20 source profile.
- Local SQLite working/profile memory supplies recent context and explicit
  user decisions. FastEmbed with `BAAI/bge-small-zh-v1.5` supplies free local
  semantic ranking over that store; keyword ranking remains available.
- Ombre is a derived read source for emotional and long-term relationship
  context. It is not the authority for technical reality, delivery truth,
  identity, permissions, or Core facts.
- Governance docs remain authoritative for ran-agent runtime facts. Future
  confirmed Core events may project into Ombre, but no direct model-to-Ombre
  write or O2 compatibility path is authorized in the current line.
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
are not exposed.

Local semantic retrieval is offline at request time. The exact FastEmbed model
must be provisioned into `data/fastembed_cache` before activation; a missing
model reports `local_memory=degraded` and does not trigger a network download.
The model has no API or token charge.

## Deployment Truth

Production runs the S3 source
`cc663876881e4d1f5cfb67f20d74230730a2f68c`, with unified Hermes and
`personal_memory`; direct loopback Ombre recall on `18001` is active, while
`18002` and O2 are inactive. The v0.13 rollback window is closed.

S3 is production verified: active personal learning is visible through
`personal_memory`, the independent read-only Ombre outcome remains visible,
and the four relevant services stayed active. It does not mutate Ombre or
enable O2. The inactive O2 compatibility implementation is scheduled for
deletion in S4 after runtime references are proven absent.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `OMBRE_BRAIN_MCP_URL` | `http://127.0.0.1:18001/mcp` | Internal Ombre read endpoint used by Python |
| `PERSONAL_AGENT_OMBRE_MCP_TIMEOUT_SECONDS` | `10` | Read timeout |
| `PERSONAL_AGENT_VECTOR_MEMORY_ENABLED` | `true` | Local FastEmbed + HNSW ranking |
| `PERSONAL_AGENT_MEMORY_LLM_ENABLED` | `false` | Optional extra extraction call; off by default to avoid hidden cost |

Use `skills/server-runtime/SKILL.md` for any deployment or service change.
Never place vault data, model caches, env files, or credentials in Git.
