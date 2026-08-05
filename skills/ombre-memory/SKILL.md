# Ombre Memory Skill

Status: CURRENT (2026-08-05)

`POINT_IN_TIME_AUDIT` (2026-08-05): production SHA
`bb66f1e6a8a400d599c7f86139107742bbedddc8` still uses the existing direct
Ombre Brain path on `127.0.0.1:18001`. The recall-only O1 baseline and the O2
baseline are archived but not deployed; `18002` was inactive and O2 was absent
from the active revision/configuration. This source revision defines the strict
P2 recall contract but does not imply production deployment. V4 Pro is frozen;
Node Receipt is deferred; Package B.2/B.3 have not started.

## Overview

Ombre Brain is an emotional memory system that gives the agent persistent, emotionally-aware memory capabilities. Unlike traditional key-value stores, it mimics human memory by:

- Tagging experiences with emotional valence/arousal coordinates (Russell's model)
- Applying a modified Ebbinghaus forgetting curve
- Actively surfacing unresolved or emotionally intense memories
- Storing memories as Obsidian-compatible Markdown files

Canonical upstream for live feature checks: [P0luz/Ombre-Brain](https://github.com/P0luz/Ombre-Brain). Do not substitute similarly named forks or older links when assessing current Ombre Brain features. This repo's local `ombre_brain_mcp.py` is a lightweight project adapter and may expose only a subset of upstream tools.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Ombre Brain Memory System                     │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │
│  │   breath    │  │   trace     │  │   pulse     │  Recall      │
│  │  (recent)   │  │  (threads)  │  │  (core)     │  Actions     │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘             │
│         └─────────────────┼─────────────────┘                   │
│                           ▼                                     │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │              Emotional Memory Engine                      │   │
│  │  - Valence/Arousal tagging                               │   │
│  │  - Weight-based importance scoring                       │   │
│  │  - Modified Ebbinghaus forgetting curve                  │   │
│  │  - Keyword + emotional relevance matching                │   │
│  └─────────────────────────────────────────────────────────┘   │
│                           │                                     │
│                           ▼                                     │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │              Obsidian-Compatible Vault                   │   │
│  │  - Markdown files with YAML frontmatter                  │   │
│  │  - Human-readable and editable                           │   │
│  │  - Git-friendly storage                                  │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

## Emotional Coordinates

Ombre Brain uses Russell's circumplex model of affect:

```
                    High Arousal
                         ▲
                         │
    Excited/Stressed     │     Alert/Angry
         (-0.5, 0.8)     │      (0.8, 0.9)
                         │
    ◄────────────────────┼────────────────────►
    Negative             │              Positive
    Valence              │              Valence
                         │
         (-0.8, 0.2)     │      (0.9, 0.3)
    Sad/Depressed        │     Content/Happy
                         │
                         ▼
                    Low Arousal
```

- **Valence**: -1.0 (negative) to 1.0 (positive)
- **Arousal**: 0.0 (calm) to 1.0 (excited)
- **Weight**: 0.0 to 1.0 (memory importance)

## Upstream Registry Reference

The action names below describe the pinned upstream project, not capabilities
granted to Hermes. Several apparent retrieval actions can update access or
decay state. O1 therefore exposes none of this raw registry to Hermes.

### Recall Actions

| Action | Purpose | Returns |
|--------|---------|---------|
| `breath` | Surface recent, emotionally relevant memories | Top 3 recent memories |
| `trace` | Follow emotional threads through memory | Connected memories |
| `pulse` | Check core, high-weight memories | Fundamental memories |

### Mutation Actions (not authorized in O1)

| Action | Purpose | Layer |
|--------|---------|-------|
| `hold` | Store long-term memory | Long-term |
| `grow` | Store core/identity memory | Core |

## Integration

### Python Backend

```python
from personal_agent.ombre_mcp import OmbreMCPMemoryBackend

# Initialize backend
ombre = OmbreMCPMemoryBackend(config, logger)

# Recall memories
memories = ombre.recall(
    user_text="用户查询内容",
    response_mode="chat"
)

# O1 intentionally provides no Ombre mutation method.
```

### MCP Server

The local MCP tool boundary accepts only `{"query": "...", "limit": 5}` for
`ombre_recall_search`. The Python backend maps its internal `user_text` input
to `query`; `response_mode` never crosses the MCP boundary. Successful empty
recall is logged as `outcome=empty`, while transport, JSON-RPC, and malformed
payload failures are logged as `outcome=failed`. O1 intentionally provides no
hold/grow/raw-upstream call path.

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PERSONAL_AGENT_OMBRE_BACKEND` | `recall_only` | Use the local fail-closed recall adapter; the known production legacy value maps to this mode with a warning, and unknown values fail closed |
| `PERSONAL_AGENT_OMBRE_MCP_URL` | `http://127.0.0.1:18002/mcp` | Local recall-only MCP endpoint |
| `PERSONAL_AGENT_OMBRE_MCP_TIMEOUT_SECONDS` | 10 | Request timeout |
| `OMBRE_VAULT_PATH` | `vault/ombre` | Primary memory storage path |
| `OMBRE_VAULT_LEGACY_PATH` | `.ran_agent_state/ombre_vault` | Legacy vault path kept as read fallback during migration |
| `OMBRE_VAULT_FALLBACK_PATHS` | `.ran_agent_state/ombre_vault` | Extra fallback vault paths, separated by `:` |

When wiring upstream Ombre Brain into server deployment, also load
`skills/server-runtime/SKILL.md`. New Ombre env defaults should reuse existing
server values by default (`?KEY=value` in `apply-hermes-runtime-split.sh`) and
only overwrite through explicit `RAN_AGENT_DEPLOY_*` overrides or canonical
safety/routing contracts.

O1 Hermes server deployments support only the pinned upstream source runner
(`OMBRE_BRAIN_RUNNER=source`). Docker, external, and unknown runners fail
closed. The single `ombre_memory` entry shared by Lite and Full points to the
local recall-only adapter at `127.0.0.1:18002/mcp`; raw upstream
`127.0.0.1:18001/mcp` is never part of the Hermes MCP surface.

### Memory Storage Format

Each memory is stored as an Obsidian-compatible Markdown file:

```markdown
---
created: 2026-04-14T20:46:11.015570
valence: 0.5
arousal: 0.5
weight: 0.8
tags:
  - preference
  - reminder
source: agent
unresolved: false
---

用户喜欢晚上8点提醒吃饭
```

## Forgetting Curve

Ombre Brain implements a modified Ebbinghaus forgetting curve:

```
Memory Strength = Weight × e^(-AgeInDays / 7)
```

- Memories decay over time
- High-weight memories persist longer
- Emotional intensity boosts recall
- Unresolved memories get a 1.5x boost

## Usage Examples

### Mutation

O1 does not authorize automatic storage, emotional inference, or any other
Ombre mutation. Those capabilities require a separately authorized later line.

### Memory Retrieval

```python
# Query: "提醒"
# Returns memories tagged with "reminder" or containing "提醒"

# Query: "喜欢"
# Returns positive valence memories
```

## Files

- `node_bridge/src/ombreRecallMcpServer.mjs` - active local recall-only MCP server candidate
- `src/personal_agent/ombre_mcp.py` - Python client backend
- `src/personal_agent/ombre_brain_mcp.py` - legacy direct adapter; not the O1 Hermes MCP surface
- `vault/ombre/` - Primary memory storage directory
- `.ran_agent_state/ombre_vault/` - Legacy read-only fallback during migration

## References

- [Ombre Brain canonical GitHub repository](https://github.com/P0luz/Ombre-Brain)
- [Ombre Brain on MCP Market](https://mcpmarket.com/zh/server/ombre-brain)
- Russell, J.A. (1980). A circumplex model of affect
- Ebbinghaus forgetting curve
