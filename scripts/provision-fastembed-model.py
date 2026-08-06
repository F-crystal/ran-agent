#!/usr/bin/env python3
"""Download and verify the free local personal-memory embedding model."""

from __future__ import annotations

import argparse
from pathlib import Path

from fastembed import TextEmbedding


MODEL = "BAAI/bge-small-zh-v1.5"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cache-dir", type=Path, required=True)
    args = parser.parse_args()
    args.cache_dir.mkdir(parents=True, exist_ok=True)
    description = TextEmbedding._get_model_description(MODEL)
    model_path = TextEmbedding.retrieve_model_gcs(
        MODEL,
        str(description.sources.url),
        str(args.cache_dir),
        deprecated_tar_struct=description.sources.deprecated_tar_struct,
    )
    model = TextEmbedding(model_name=MODEL, specific_model_path=str(model_path), threads=2)
    vector = next(model.query_embed(["本地记忆模型验收"]))
    if len(vector) != 512:
        raise RuntimeError(f"unexpected embedding dimension: {len(vector)}")
    print(model_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
