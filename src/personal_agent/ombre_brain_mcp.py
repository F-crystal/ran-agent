#!/usr/bin/env python3
"""
Ombre Brain MCP Server - Emotional Memory System for AI Agents

This is a lightweight MCP-compatible server that implements Ombre Brain's
core emotional memory features:
- Russell's valence/arousal emotional tagging
- Modified Ebbinghaus forgetting curve
- Obsidian-compatible Markdown storage
- Active memory surfacing

Usage:
    python ombre_brain_mcp.py <action>
    
Actions:
    breath, trace, pulse - Recall memories based on emotional relevance
    hold - Store a long-term memory
    grow - Store a core memory
"""

from __future__ import annotations

import json
import sys
import os
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Optional
import hashlib


@dataclass
class EmotionalMemory:
    """A memory with emotional valence/arousal coordinates."""
    content: str
    timestamp: str
    valence: float  # -1.0 (negative) to 1.0 (positive)
    arousal: float  # 0.0 (calm) to 1.0 (excited)
    weight: float   # Memory importance/strength
    tags: list[str]
    source: str
    unresolved: bool = False
    
    def to_markdown(self) -> str:
        """Convert to Obsidian-compatible Markdown with YAML frontmatter."""
        frontmatter = {
            "created": self.timestamp,
            "valence": round(self.valence, 2),
            "arousal": round(self.arousal, 2),
            "weight": round(self.weight, 2),
            "tags": self.tags,
            "source": self.source,
            "unresolved": self.unresolved,
        }
        
        yaml_lines = ["---"]
        for key, value in frontmatter.items():
            if isinstance(value, list):
                yaml_lines.append(f"{key}:")
                for item in value:
                    yaml_lines.append(f"  - {item}")
            elif isinstance(value, bool):
                yaml_lines.append(f"{key}: {str(value).lower()}")
            else:
                yaml_lines.append(f"{key}: {value}")
        yaml_lines.append("---")
        
        return "\n".join(yaml_lines) + f"\n\n{self.content}\n"
    
    @classmethod
    def from_markdown(cls, content: str, filename: str) -> Optional[EmotionalMemory]:
        """Parse an Obsidian-compatible Markdown file."""
        match = re.match(r'---\n(.*?)\n---\n\n(.*)', content, re.DOTALL)
        if not match:
            return None
        
        yaml_content, body = match.groups()
        
        # Simple YAML parsing
        data = {"tags": []}
        current_key = None
        for line in yaml_content.strip().split('\n'):
            if line.startswith('  - '):
                if current_key == "tags":
                    data["tags"].append(line[4:].strip())
            elif ':' in line:
                key, value = line.split(':', 1)
                key = key.strip()
                value = value.strip()
                current_key = key
                
                if key == "tags":
                    continue
                elif value.lower() == "true":
                    data[key] = True
                elif value.lower() == "false":
                    data[key] = False
                elif value.replace('.', '').replace('-', '').isdigit():
                    data[key] = float(value)
                else:
                    data[key] = value
        
        return cls(
            content=body.strip(),
            timestamp=data.get("created", datetime.now().isoformat()),
            valence=data.get("valence", 0.0),
            arousal=data.get("arousal", 0.5),
            weight=data.get("weight", 0.5),
            tags=data.get("tags", []),
            source=data.get("source", "unknown"),
            unresolved=data.get("unresolved", False),
        )


def _memory_identity(memory: EmotionalMemory) -> tuple[object, ...]:
    """Return a stable dedupe key for a loaded memory."""

    return (
        memory.content,
        memory.timestamp,
        round(memory.valence, 4),
        round(memory.arousal, 4),
        round(memory.weight, 4),
        tuple(memory.tags),
        memory.source,
        memory.unresolved,
    )


class OmbreBrain:
    """Core Ombre Brain emotional memory system."""
    
    def __init__(self, vault_path: Path, fallback_vault_paths: list[Path] | None = None):
        self.vault_path = vault_path
        self.vault_path.mkdir(parents=True, exist_ok=True)
        self.fallback_vault_paths = tuple(
            path for path in (fallback_vault_paths or []) if path != self.vault_path
        )
        self.memories: list[EmotionalMemory] = []
        self._load_memories()
    
    def _load_memories(self):
        """Load all memories from the vault."""
        loaded_identities: set[tuple[object, ...]] = set()
        for vault_dir in (self.vault_path, *self.fallback_vault_paths):
            if not vault_dir.exists():
                continue
            for md_file in vault_dir.glob("*.md"):
                try:
                    content = md_file.read_text(encoding='utf-8')
                    memory = EmotionalMemory.from_markdown(content, md_file.name)
                    if memory is None:
                        continue
                    identity = _memory_identity(memory)
                    if identity in loaded_identities:
                        continue
                    loaded_identities.add(identity)
                    self.memories.append(memory)
                except Exception:
                    continue
    
    def _save_memory(self, memory: EmotionalMemory):
        """Save a memory to the vault."""
        # Generate filename from content hash
        content_hash = hashlib.md5(memory.content.encode()).hexdigest()[:8]
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"{timestamp}_{content_hash}.md"
        
        filepath = self.vault_path / filename
        filepath.write_text(memory.to_markdown(), encoding='utf-8')
        self.memories.append(memory)
    
    def _calculate_decay(self, memory: EmotionalMemory) -> float:
        """Calculate memory strength after applying Ebbinghaus forgetting curve."""
        created = datetime.fromisoformat(memory.timestamp)
        age_days = (datetime.now() - created).total_seconds() / 86400
        
        # Modified Ebbinghaus curve: weight * e^(-age/7)
        decay_factor = 2.71828 ** (-age_days / 7)
        return memory.weight * decay_factor
    
    def _emotional_relevance(self, memory: EmotionalMemory, query: str) -> float:
        """Calculate emotional relevance score for a query."""
        # Base score from decayed weight
        score = self._calculate_decay(memory)
        
        # Boost for high emotional intensity (high arousal + extreme valence)
        emotional_intensity = memory.arousal * (1 + abs(memory.valence))
        score *= (1 + emotional_intensity)
        
        # Boost for unresolved memories
        if memory.unresolved:
            score *= 1.5
        
        # Simple keyword matching
        query_words = set(query.lower().split())
        content_words = set(memory.content.lower().split())
        tag_words = set(tag.lower() for tag in memory.tags)
        
        overlap = len(query_words & content_words) + len(query_words & tag_words) * 2
        score *= (1 + overlap * 0.3)
        
        return score
    
    def breath(self, user_text: str, response_mode: str) -> list[dict]:
        """
        'Breath' - Surface the most emotionally relevant recent memories.
        Like taking a breath and recalling what's immediately present.
        """
        # Sort by recency and emotional relevance
        scored = []
        for memory in self.memories:
            relevance = self._emotional_relevance(memory, user_text)
            scored.append((relevance, memory))
        
        scored.sort(reverse=True)
        
        # Return top 3 most relevant
        return [
            {
                "content": m.content,
                "valence": m.valence,
                "arousal": m.arousal,
                "tags": m.tags,
                "unresolved": m.unresolved,
            }
            for _, m in scored[:3]
        ]
    
    def trace(self, user_text: str, response_mode: str) -> list[dict]:
        """
        'Trace' - Follow the emotional threads through memory.
        Find memories that connect to the current context.
        """
        # Find memories with similar emotional patterns
        scored = []
        for memory in self.memories:
            score = self._emotional_relevance(memory, user_text)
            
            # Boost for memories with strong emotional tags
            if any(tag in ["important", "emotional", "breakthrough", "conflict"] 
                   for tag in memory.tags):
                score *= 1.3
            
            scored.append((score, memory))
        
        scored.sort(reverse=True)
        
        return [
            {
                "content": m.content,
                "valence": m.valence,
                "arousal": m.arousal,
                "tags": m.tags,
                "connections": len(m.tags),
            }
            for _, m in scored[:3]
        ]
    
    def pulse(self, user_text: str, response_mode: str) -> list[dict]:
        """
        'Pulse' - Check the emotional pulse of core memories.
        Surface fundamental, high-weight memories that define the relationship.
        """
        # Focus on high-weight core memories
        core_memories = [m for m in self.memories if m.weight > 0.7]
        
        scored = []
        for memory in core_memories:
            score = self._emotional_relevance(memory, user_text)
            scored.append((score, memory))
        
        scored.sort(reverse=True)
        
        return [
            {
                "content": m.content,
                "valence": m.valence,
                "arousal": m.arousal,
                "weight": m.weight,
                "tags": m.tags,
            }
            for _, m in scored[:2]
        ]
    
    def hold(self, candidate: dict, layer: str) -> dict:
        """
        'Hold' - Store a memory in long-term storage.
        """
        # Extract emotional coordinates from candidate or use defaults
        valence = candidate.get("valence", 0.0)
        arousal = candidate.get("arousal", 0.5)
        weight = candidate.get("weight", 0.5)
        
        # If no explicit emotion, infer from content
        if valence == 0.0 and arousal == 0.5:
            content = str(candidate.get("content", candidate.get("memory", "")))
            valence, arousal = self._infer_emotion(content)
        
        memory = EmotionalMemory(
            content=str(candidate.get("content", candidate.get("memory", ""))),
            timestamp=datetime.now().isoformat(),
            valence=valence,
            arousal=arousal,
            weight=weight,
            tags=candidate.get("tags", ["long_term"]),
            source=candidate.get("source", "agent"),
            unresolved=candidate.get("unresolved", False),
        )
        
        self._save_memory(memory)
        
        return {"stored": True, "id": hashlib.md5(memory.content.encode()).hexdigest()[:8]}
    
    def grow(self, candidate: dict, layer: str) -> dict:
        """
        'Grow' - Store a core memory that defines the relationship.
        Higher weight, more permanent.
        """
        memory = EmotionalMemory(
            content=str(candidate.get("content", candidate.get("memory", ""))),
            timestamp=datetime.now().isoformat(),
            valence=candidate.get("valence", 0.0),
            arousal=candidate.get("arousal", 0.5),
            weight=0.9,  # Core memories have high weight
            tags=candidate.get("tags", ["core", "identity"]),
            source=candidate.get("source", "agent"),
            unresolved=False,  # Core memories are typically resolved
        )
        
        self._save_memory(memory)
        
        return {"stored": True, "id": hashlib.md5(memory.content.encode()).hexdigest()[:8]}
    
    def _infer_emotion(self, text: str) -> tuple[float, float]:
        """Infer emotional valence and arousal from text."""
        text_lower = text.lower()
        
        # Positive indicators
        positive_words = ["喜欢", "爱", "开心", "快乐", "成功", "好", "棒", "优秀", "感谢", "幸福"]
        # Negative indicators
        negative_words = ["讨厌", "恨", "难过", "失败", "糟糕", "坏", "痛苦", "失望", "生气", "焦虑"]
        # High arousal indicators
        excited_words = ["兴奋", "激动", "震惊", "惊喜", "愤怒", "恐惧", "狂喜", "绝望"]
        # Low arousal indicators
        calm_words = ["平静", "放松", "舒适", "安心", "无聊", "疲倦", "困倦"]
        
        valence = 0.0
        arousal = 0.5
        
        pos_count = sum(1 for w in positive_words if w in text_lower)
        neg_count = sum(1 for w in negative_words if w in text_lower)
        exc_count = sum(1 for w in excited_words if w in text_lower)
        calm_count = sum(1 for w in calm_words if w in text_lower)
        
        # Calculate valence
        if pos_count > neg_count:
            valence = min(1.0, 0.3 + pos_count * 0.2)
        elif neg_count > pos_count:
            valence = max(-1.0, -0.3 - neg_count * 0.2)
        
        # Calculate arousal
        if exc_count > calm_count:
            arousal = min(1.0, 0.6 + exc_count * 0.1)
        elif calm_count > exc_count:
            arousal = max(0.0, 0.4 - calm_count * 0.1)
        
        return valence, arousal


def main():
    """Main entry point for MCP server."""
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No action specified"}), file=sys.stderr)
        sys.exit(1)
    
    action = sys.argv[1]
    
    # Read input from stdin
    try:
        input_data = json.load(sys.stdin)
    except json.JSONDecodeError:
        input_data = {}
    
    # Initialize Ombre Brain
    vault_path = Path(os.getenv("OMBRE_VAULT_PATH", "vault/ombre"))
    fallback_raw = os.getenv("OMBRE_VAULT_FALLBACK_PATHS", "").strip()
    fallback_paths = [
        Path(path.strip())
        for path in fallback_raw.split(os.pathsep)
        if path.strip()
    ]
    if not fallback_paths:
        legacy_path = Path(os.getenv("OMBRE_VAULT_LEGACY_PATH", ".openclaw_state/ombre_vault"))
        if legacy_path != vault_path:
            fallback_paths.append(legacy_path)
    brain = OmbreBrain(vault_path, fallback_paths)
    
    # Route to appropriate action
    result = {}
    
    if action in ("breath", "trace", "pulse"):
        user_text = input_data.get("user_text", "")
        response_mode = input_data.get("response_mode", "")
        items = getattr(brain, action)(user_text, response_mode)
        result = {"items": items}
    
    elif action == "hold":
        candidate = input_data.get("candidate", {})
        layer = input_data.get("layer", "long")
        result = brain.hold(candidate, layer)
    
    elif action == "grow":
        candidate = input_data.get("candidate", {})
        layer = input_data.get("layer", "core")
        result = brain.grow(candidate, layer)
    
    else:
        print(json.dumps({"error": f"Unknown action: {action}"}), file=sys.stderr)
        sys.exit(1)
    
    # Output result as JSON
    print(json.dumps(result))


if __name__ == "__main__":
    main()
