# Ombre Memory Skill

Status: ACTIVE (2026-04-14)

## Overview

Ombre Brain is an emotional memory system that gives the agent persistent, emotionally-aware memory capabilities. Unlike traditional key-value stores, it mimics human memory by:

- Tagging experiences with emotional valence/arousal coordinates (Russell's model)
- Applying a modified Ebbinghaus forgetting curve
- Actively surfacing unresolved or emotionally intense memories
- Storing memories as Obsidian-compatible Markdown files

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

## MCP Actions

### Recall Actions

| Action | Purpose | Returns |
|--------|---------|---------|
| `breath` | Surface recent, emotionally relevant memories | Top 3 recent memories |
| `trace` | Follow emotional threads through memory | Connected memories |
| `pulse` | Check core, high-weight memories | Fundamental memories |

### Store Actions

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

# Store memory
ombre.store_long_term({
    "content": "记忆内容",
    "valence": 0.8,
    "arousal": 0.6,
    "weight": 0.7,
    "tags": ["preference", "important"]
})
```

### MCP Server

```bash
# Recall memories
echo '{"user_text": "query", "response_mode": "chat"}' | python src/personal_agent/ombre_brain_mcp.py breath

# Store memory
echo '{"candidate": {"content": "...", "weight": 0.8}, "layer": "long"}' | python src/personal_agent/ombre_brain_mcp.py hold
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PERSONAL_AGENT_OMBRE_MCP_COMMAND` | `src/personal_agent/ombre_brain_mcp.py` | MCP server path |
| `PERSONAL_AGENT_OMBRE_MCP_TIMEOUT_SECONDS` | 10 | Request timeout |
| `OMBRE_VAULT_PATH` | `vault/ombre` | Primary memory storage path |
| `OMBRE_VAULT_LEGACY_PATH` | `.openclaw_state/ombre_vault` | Legacy vault path kept as read fallback during migration |
| `OMBRE_VAULT_FALLBACK_PATHS` | `.openclaw_state/ombre_vault` | Extra fallback vault paths, separated by `:` |

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

### Automatic Emotion Inference

When storing without explicit emotions:

```python
# Content: "用户非常喜欢这个功能，太棒了！"
# Inferred: valence=0.9, arousal=0.8

# Content: "有点失望，希望能改进"
# Inferred: valence=-0.5, arousal=0.4
```

### Memory Retrieval

```python
# Query: "提醒"
# Returns memories tagged with "reminder" or containing "提醒"

# Query: "喜欢"
# Returns positive valence memories
```

## Files

- `src/personal_agent/ombre_brain_mcp.py` - MCP server implementation
- `src/personal_agent/ombre_mcp.py` - Python client backend
- `vault/ombre/` - Primary memory storage directory
- `.openclaw_state/ombre_vault/` - Legacy read-only fallback during migration

## References

- [Ombre Brain on MCP Market](https://mcpmarket.com/zh/server/ombre-brain)
- Russell, J.A. (1980). A circumplex model of affect
- Ebbinghaus forgetting curve
