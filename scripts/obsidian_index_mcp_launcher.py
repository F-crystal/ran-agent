#!/usr/bin/env python3
"""Run obsidian-index MCP with the ran-agent server compatibility patch.

The published obsidian-index package currently hardcodes SentenceTransformer
to Apple's MPS backend. Linux servers need CPU, and the background worker
imports the encoder in a child process, so patch the installed source before
starting the upstream click command.
"""

from __future__ import annotations

import importlib.util
import os
import sys
from pathlib import Path


PATCHED_DEVICE_EXPR = 'device=os.environ.get("OBSIDIAN_INDEX_DEVICE", "cpu")'


def _patch_encoder_source_text(text: str) -> tuple[str, bool]:
    changed = False
    updated = text

    if PATCHED_DEVICE_EXPR in updated:
        return updated, False

    if "import os\n" not in updated:
        import_line = "from sentence_transformers import SentenceTransformer"
        if import_line in updated:
            updated = updated.replace(import_line, f"import os\n\n{import_line}", 1)
            changed = True
        else:
            updated = f"import os\n{updated}"
            changed = True

    replacements = {
        'device="mps"': PATCHED_DEVICE_EXPR,
        "device='mps'": PATCHED_DEVICE_EXPR,
    }
    for old, new in replacements.items():
        if old in updated:
            updated = updated.replace(old, new)
            changed = True

    return updated, changed


def _patch_encoder_source_file(path: Path) -> bool:
    text = path.read_text(encoding="utf-8")
    updated, changed = _patch_encoder_source_text(text)
    if changed:
        path.write_text(updated, encoding="utf-8")
    return changed


def _find_encoder_source() -> Path:
    spec = importlib.util.find_spec("obsidian_index.index.encoder")
    if spec is None or spec.origin is None:
        raise RuntimeError("cannot find obsidian_index.index.encoder in the current Python env")
    return Path(spec.origin)


def main() -> None:
    os.environ.setdefault("OBSIDIAN_INDEX_DEVICE", "cpu")
    try:
        _patch_encoder_source_file(_find_encoder_source())
    except Exception as exc:
        print(f"failed to patch obsidian-index encoder device: {exc}", file=sys.stderr)
        raise SystemExit(2) from exc

    from obsidian_index.main import main as obsidian_index_main

    obsidian_index_main(args=sys.argv[1:], prog_name="obsidian-index")


if __name__ == "__main__":
    main()
