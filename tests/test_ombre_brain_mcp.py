"""Tests for the Ombre Brain local MCP server."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from personal_agent.ombre_brain_mcp import EmotionalMemory, OmbreBrain


class OmbreBrainMCPTest(unittest.TestCase):
    """Covers vault compatibility and primary-write migration behavior."""

    def test_loads_legacy_vault_and_writes_primary_vault(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            base_dir = Path(temp_dir)
            primary_vault = base_dir / "vault" / "ombre"
            legacy_vault = base_dir / ".ran_agent_state" / "ombre_vault"
            legacy_vault.mkdir(parents=True)

            memory = EmotionalMemory(
                content="旧 vault 记忆",
                timestamp="2026-04-14T20:46:11.015570",
                valence=0.5,
                arousal=0.5,
                weight=0.8,
                tags=["preference", "reminder"],
                source="agent",
            )
            legacy_vault.joinpath("20260414_204611_f9ece79a.md").write_text(
                memory.to_markdown(),
                encoding="utf-8",
            )
            primary_vault.mkdir(parents=True)
            primary_vault.joinpath("20260414_204611_f9ece79a.md").write_text(
                memory.to_markdown(),
                encoding="utf-8",
            )

            brain = OmbreBrain(primary_vault, [legacy_vault])

            self.assertEqual([item.content for item in brain.memories], ["旧 vault 记忆"])

            result = brain.hold({"content": "新增记忆", "tags": ["migration"]}, "long")

            self.assertTrue(result["stored"])
            self.assertEqual(len(list(primary_vault.glob("*.md"))), 2)
            self.assertEqual(len(list(legacy_vault.glob("*.md"))), 1)


if __name__ == "__main__":
    unittest.main()
