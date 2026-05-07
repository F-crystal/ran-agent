"""Helpers for reading the canonical preference profile as a weak runtime reference."""

from __future__ import annotations

import json
from dataclasses import dataclass

from personal_agent.config import AppConfig


@dataclass(frozen=True)
class PreferenceWeakReference:
    """Compact runtime-facing preference summary with deliberately weak guidance."""

    stable_dislikes: tuple[str, ...] = ()
    contextual_risks: tuple[str, ...] = ()
    updated_at: str = ""

    def render_for_prompt(self) -> str:
        """Render a short, weak-reference block for chat prompting."""

        lines: list[str] = []
        if self.stable_dislikes:
            lines.append("- 用户较稳定不喜欢的表达模式：" + "；".join(self.stable_dislikes[:3]))
        if self.contextual_risks:
            lines.append("- 当前应更谨慎的语境风险：" + "；".join(self.contextual_risks[:3]))
        return "\n".join(lines)


def load_preference_weak_reference(config: AppConfig) -> PreferenceWeakReference:
    """Load a weak preference reference from the canonical JSON profile when available."""

    profile_path = config.data_dir / "preference_profile.json"
    if not profile_path.exists():
        return PreferenceWeakReference()
    try:
        payload = json.loads(profile_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return PreferenceWeakReference()

    stable_dislikes = tuple(
        str(item.get("label", "")).strip()
        for item in payload.get("stable_dislikes", [])
        if isinstance(item, dict) and str(item.get("label", "")).strip()
    )
    contextual_risks = tuple(
        str(item.get("label", "")).strip()
        for item in payload.get("contextual_risks", [])
        if isinstance(item, dict) and str(item.get("label", "")).strip()
    )
    return PreferenceWeakReference(
        stable_dislikes=stable_dislikes,
        contextual_risks=contextual_risks,
        updated_at=str(payload.get("updated_at", "")).strip(),
    )
