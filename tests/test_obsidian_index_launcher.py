"""Tests for the obsidian-index compatibility launcher."""

from __future__ import annotations

import importlib.util
import tempfile
import textwrap
import unittest
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[1]
LAUNCHER_PATH = ROOT_DIR / "scripts" / "obsidian_index_mcp_launcher.py"


def load_launcher_module():
    spec = importlib.util.spec_from_file_location("obsidian_index_mcp_launcher", LAUNCHER_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load obsidian_index_mcp_launcher")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ObsidianIndexLauncherPatchTest(unittest.TestCase):
    def test_patch_replaces_mps_device_with_env_configured_cpu_default(self) -> None:
        launcher = load_launcher_module()
        source = textwrap.dedent(
            """\
            from sentence_transformers import SentenceTransformer

            class Encoder:
                def __init__(self):
                    self.model_minilm_l6_v2 = SentenceTransformer(
                        "sentence-transformers/paraphrase-MiniLM-L6-v2",
                        device="mps",
                    )
            """
        )

        updated, changed = launcher._patch_encoder_source_text(source)

        self.assertTrue(changed)
        self.assertIn("import os", updated)
        self.assertIn('device=os.environ.get("OBSIDIAN_INDEX_DEVICE", "cpu")', updated)
        self.assertNotIn('device="mps"', updated)

    def test_patch_is_idempotent_for_already_patched_source(self) -> None:
        launcher = load_launcher_module()
        source = textwrap.dedent(
            """\
            import os

            from sentence_transformers import SentenceTransformer

            class Encoder:
                def __init__(self):
                    self.model_minilm_l6_v2 = SentenceTransformer(
                        "sentence-transformers/paraphrase-MiniLM-L6-v2",
                        device=os.environ.get("OBSIDIAN_INDEX_DEVICE", "cpu"),
                    )
            """
        )

        updated, changed = launcher._patch_encoder_source_text(source)

        self.assertFalse(changed)
        self.assertEqual(updated, source)

    def test_patch_encoder_source_file_writes_updated_source(self) -> None:
        launcher = load_launcher_module()
        with tempfile.TemporaryDirectory() as temp_dir:
            encoder_path = Path(temp_dir) / "encoder.py"
            encoder_path.write_text(
                "from sentence_transformers import SentenceTransformer\n"
                "SentenceTransformer('model', device='mps')\n",
                encoding="utf-8",
            )

            changed = launcher._patch_encoder_source_file(encoder_path)
            updated = encoder_path.read_text(encoding="utf-8")

        self.assertTrue(changed)
        self.assertIn("import os", updated)
        self.assertIn('device=os.environ.get("OBSIDIAN_INDEX_DEVICE", "cpu")', updated)


if __name__ == "__main__":
    unittest.main()
