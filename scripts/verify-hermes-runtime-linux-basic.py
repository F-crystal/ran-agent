#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.machinery
import importlib.util
import json
import os
import platform
import stat
import subprocess
from pathlib import Path


def run(command: list[str], *, env: dict[str, str] | None = None) -> str:
    result = subprocess.run(command, env=env, check=False, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if result.returncode:
        raise RuntimeError(f"command failed ({result.returncode}): {command}\n{result.stdout}")
    return result.stdout


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--builder", type=Path, required=True)
    parser.add_argument("--scratch", type=Path, required=True)
    args = parser.parse_args()
    if platform.system() != "Linux" or platform.machine() != "x86_64":
        raise SystemExit("requires Linux x86_64")

    spec = importlib.util.spec_from_file_location("artifact_builder", args.builder)
    if spec is None or spec.loader is None:
        raise RuntimeError("artifact builder cannot be loaded")
    builder = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(builder)
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    if manifest.get("schemaVersion") != 1 or not isinstance(manifest.get("artifact"), dict):
        raise RuntimeError("artifact manifest schema invalid")
    artifact = manifest["artifact"]
    if args.archive.stat().st_size != artifact["bytes"]:
        raise RuntimeError("artifact byte count mismatch")
    archive_sha256 = builder.sha256_file(args.archive)
    if archive_sha256 != artifact["tarGzSha256"]:
        raise RuntimeError("artifact archive digest mismatch")

    if args.scratch.exists():
        raise SystemExit(f"scratch path already exists: {args.scratch}")
    args.scratch.mkdir(mode=0o755)
    builder.safe_extract_tar(args.archive, args.scratch)
    runtime = args.scratch / artifact["archiveRoot"]
    runtime_tree_sha256 = builder.tree_digest(runtime)
    if runtime_tree_sha256 != artifact["treeSha256"]:
        raise RuntimeError("artifact tree digest mismatch")

    elf_files = [path for path in builder.walk_tree(runtime) if path.is_file() and path.open("rb").read(4) == b"\x7fELF"]
    loader_env = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8"}
    for path in elf_files:
        output = run(["/usr/bin/ldd", str(path)], env=loader_env)
        if "not found" in output:
            raise RuntimeError(f"unresolved ELF dependency: {path}\n{output}")

    python = runtime / "python/bin/python3"
    app = runtime / "app"
    site = runtime / "python/lib/python3.12/site-packages"
    import_probe = r'''
import importlib, importlib.machinery, sys
from pathlib import Path
app, site, dyn = map(Path, sys.argv[1:])
sys.path.insert(0, str(app))
modules = []
for root in (site, dyn):
    for path in root.rglob("*.so"):
        relative = path.relative_to(root).as_posix()
        for suffix in importlib.machinery.EXTENSION_SUFFIXES:
            if relative.endswith(suffix):
                name = relative[:-len(suffix)].replace("/", ".")
                modules.append(name)
                break
for name in sorted(set(modules)):
    importlib.import_module(name)
print(len(set(modules)))
'''
    clean = {
        "PATH": "/usr/bin:/bin",
        "HOME": str(args.scratch / "home"),
        "TMPDIR": str(args.scratch / "tmp"),
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "PYTHONNOUSERSITE": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
        "TERM": "xterm-256color",
    }
    Path(clean["HOME"]).mkdir()
    Path(clean["TMPDIR"]).mkdir()
    imported = run([str(python), "-B", "-I", "-c", import_probe, str(app), str(site), str(runtime / "python/lib/python3.12/lib-dynload")], env=clean).strip()
    curses_probe = "import curses,sys; curses.setupterm(); colors=curses.tigetnum('colors'); print(colors); sys.exit(0 if colors >= 256 else 1)"
    term_colors = int(run([str(python), "-B", "-I", "-c", curses_probe], env=clean).strip())
    version = run([str(runtime / "bin/hermes"), "--version"], env=clean).strip()
    metadata_version = run([str(python), "-B", "-I", "-c", "from importlib.metadata import version; print(version('hermes-agent'))"], env={**clean, "PYTHONPATH": str(site)}).strip()
    if "0.20.0" not in version or metadata_version != "0.20.0":
        raise RuntimeError(f"version mismatch: cli={version!r} metadata={metadata_version!r}")

    relocated = args.scratch / "relocated-runtime"
    runtime.rename(relocated)
    run([str(relocated / "bin/hermes"), "--version"], env=clean)
    for path in [relocated, *builder.walk_tree(relocated)]:
        if not path.is_symlink():
            path.chmod(stat.S_IMODE(path.stat().st_mode) & ~0o222)
    if any(path.lstat().st_mode & 0o222 for path in [relocated, *builder.walk_tree(relocated)] if not path.is_symlink()):
        raise RuntimeError("runtime remains writable")
    run([str(relocated / "bin/hermes"), "--version"], env=clean)
    run([str(relocated / "python/bin/python3"), "-B", "-I", "-c", curses_probe], env=clean)
    run([
        str(relocated / "python/bin/python3"), "-B", "-I", "-c", import_probe,
        str(relocated / "app"), str(relocated / "python/lib/python3.12/site-packages"),
        str(relocated / "python/lib/python3.12/lib-dynload"),
    ], env=clean)
    print(json.dumps({
        "status": "PASS",
        "artifactTarGzSha256": archive_sha256,
        "treeSha256": runtime_tree_sha256,
        "elfFiles": len(elf_files),
        "compiledModules": int(imported),
        "termColors": term_colors,
        "version": metadata_version,
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
