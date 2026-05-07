"""Shared memory dataclasses used across the local and Ombre-backed memory path."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class MemoryStoreDecision:
    """Represents one conservative long-term or core-store decision."""

    action: str = "skip"
    candidate: dict[str, object] | None = None
    source: str = "local"


class OmbreMemoryBackend(Protocol):
    """Backend contract for long, core, and emotional memory access."""

    def recall(
        self,
        *,
        user_text: str,
        response_mode: str,
    ) -> tuple[str, ...]:
        """Return relevant long-memory snippets for one turn."""

    def store_long_term(self, candidate: dict[str, object]) -> MemoryStoreDecision:
        """Store or reject a long-term candidate."""

    def store_core(self, candidate: dict[str, object]) -> MemoryStoreDecision:
        """Store or reject a core-memory candidate."""
