#!/usr/bin/env python3
"""Build the pinned Hermes v0.20 Linux runtime artifact without server writes."""

from __future__ import annotations

import argparse
import base64
import csv
import gzip
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import unicodedata
import zipfile
from importlib import metadata
from pathlib import Path, PurePosixPath


SOURCE_COMMIT = "3c27eb6234bf91b8ceee9e9071591b31e9b148cb"
SOURCE_TAG = "v2026.8.3"
SOURCE_TAG_OBJECT = "7de39e700d2c329e15d32eb0b96e2f7cdd9fbdb2"
SOURCE_VERSION = "0.20.0"
SOURCE_SHA256 = "a383dd1109d512f14f87911f657a1546a130ac74fe569c06620628b507334a60"
UV_LOCK_SHA256 = "aab3c83f71b683507a590b6315b23bdc0abd6b63b76b2349eae15bf00dfbaf2b"
REQUIREMENTS_SHA256 = "80b7685a42c3811162754d59f1a01522cd5c798094ba60b00e6b2ce828840df0"
WHEELHOUSE_SHA256 = "6226cfcee99def9ff2b20673aca6a21f2c2a1087ae6c0d3572e65bbd5f2f9cdd"
PYTHON_VERSION = "3.12.13"
PYTHON_ASSET = "cpython-3.12.13+20260804-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz"
PYTHON_SHA256 = "ce2c9c5df1b99a962a86d2f457656918ee5f01b2edea080db28416232a1fcb11"
ARTIFACT_ROOT = "hermes-runtime"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_name(value: str) -> str:
    return re.sub(r"[-_.]+", "-", value).lower()


def safe_extract_tar(archive: Path, destination: Path, *, exclude_prefixes: tuple[str, ...] = ()) -> None:
    """Extract regular files, directories and in-tree symlinks only."""
    with tarfile.open(archive, "r:*") as source:
        excluded = tuple(prefix.rstrip("/") for prefix in exclude_prefixes)
        members = [
            member for member in source.getmembers()
            if not any(
                PurePosixPath(member.name).as_posix().rstrip("/") == prefix
                or PurePosixPath(member.name).as_posix().startswith(prefix + "/")
                for prefix in excluded
            )
        ]
        names: set[str] = set()
        folded_names: dict[str, str] = {}
        symlinks: set[PurePosixPath] = set()
        for member in members:
            path = PurePosixPath(member.name)
            if not member.name or path.is_absolute() or ".." in path.parts:
                raise ValueError(f"unsafe archive path: {member.name!r}")
            normalized = path.as_posix().rstrip("/")
            if normalized in names:
                raise ValueError(f"duplicate archive path: {member.name!r}")
            names.add(normalized)
            folded = unicodedata.normalize("NFD", normalized).casefold()
            if folded in folded_names:
                raise ValueError(f"casefold archive collision: {folded_names[folded]!r} and {member.name!r}")
            folded_names[folded] = member.name
            if member.islnk() or not (member.isfile() or member.isdir() or member.issym()):
                raise ValueError(f"unsupported archive member: {member.name!r}")
            if member.issym():
                target = PurePosixPath(member.linkname)
                if target.is_absolute():
                    raise ValueError(f"absolute symlink target: {member.name!r}")
                resolved: list[str] = []
                for part in (*path.parent.parts, *target.parts):
                    if part in ("", "."):
                        continue
                    if part == "..":
                        if not resolved:
                            raise ValueError(f"escaping symlink target: {member.name!r}")
                        resolved.pop()
                    else:
                        resolved.append(part)
                symlinks.add(path)
        for member in members:
            path = PurePosixPath(member.name)
            if any(parent in symlinks for parent in path.parents):
                raise ValueError(f"archive member below symlink: {member.name!r}")
        destination.mkdir(parents=True, exist_ok=True)
        directories = [member for member in members if member.isdir()]
        files = [member for member in members if member.isfile()]
        links = [member for member in members if member.issym()]
        for member in sorted(directories, key=lambda item: len(PurePosixPath(item.name).parts)):
            (destination / member.name).mkdir(parents=True, exist_ok=True)
        for member in files:
            target = destination / member.name
            target.parent.mkdir(parents=True, exist_ok=True)
            extracted = source.extractfile(member)
            if extracted is None:
                raise ValueError(f"archive file unreadable: {member.name!r}")
            with extracted, target.open("xb") as output:
                shutil.copyfileobj(extracted, output, 1024 * 1024)
            target.chmod(stat.S_IMODE(member.mode))
        for member in links:
            target = destination / member.name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.symlink_to(member.linkname)
        for member in sorted(directories, key=lambda item: len(PurePosixPath(item.name).parts), reverse=True):
            (destination / member.name).chmod(stat.S_IMODE(member.mode))


def wheel_metadata(path: Path) -> tuple[str, str]:
    with zipfile.ZipFile(path) as wheel:
        candidates = [
            name for name in wheel.namelist()
            if len(PurePosixPath(name).parts) == 2
            and PurePosixPath(name).parts[0].endswith(".dist-info")
            and PurePosixPath(name).parts[1] == "METADATA"
        ]
        if len(candidates) != 1:
            raise ValueError(f"wheel metadata count invalid: {path.name}")
        content = wheel.read(candidates[0]).decode("utf-8")
    name = re.search(r"(?m)^Name: (.+)$", content)
    version = re.search(r"(?m)^Version: (.+)$", content)
    if not name or not version:
        raise ValueError(f"wheel metadata incomplete: {path.name}")
    return canonical_name(name.group(1).strip()), version.group(1).strip()


def record_row(line: str) -> tuple[str, str, str]:
    row = next(csv.reader([line]))
    if len(row) != 3:
        raise ValueError(f"wheel RECORD row invalid: {line!r}")
    return row[0], row[1], row[2]


def normalize_installed_records(site_packages: Path, *, omitted_globs: tuple[str, ...] = ()) -> None:
    """Remove intentionally omitted install artifacts and verify RECORD closure."""
    removals = {
        f"{cache.parent.name}/{cache.name}": cache
        for cache in site_packages.glob("*.dist-info/uv_cache.json")
    }
    scripts = site_packages / "bin"
    if scripts.is_dir():
        removals.update({f"bin/{path.name}": path for path in scripts.iterdir()})
    for pattern in omitted_globs:
        matches = list(site_packages.glob(pattern))
        if len(matches) != 1:
            raise ValueError(f"omitted installed path count invalid: {pattern} count={len(matches)}")
        removals[matches[0].relative_to(site_packages).as_posix()] = matches[0]

    counts = dict.fromkeys(removals, 0)
    records = list(site_packages.glob("*.dist-info/RECORD"))
    for record in records:
        lines = record.read_text(encoding="utf-8").splitlines()
        kept = []
        for line in lines:
            relative, _, _ = record_row(line)
            if relative in removals:
                counts[relative] += 1
            else:
                kept.append(line)
        record.write_text("\n".join(kept) + "\n", encoding="utf-8")
    invalid = {path: count for path, count in counts.items() if count != 1}
    if invalid:
        raise ValueError(f"removed install artifact RECORD count invalid: {invalid}")
    for path in removals.values():
        path.unlink()
    shutil.rmtree(scripts, ignore_errors=True)

    for record in records:
        for line in record.read_text(encoding="utf-8").splitlines():
            relative, encoded_hash, encoded_size = record_row(line)
            path = PurePosixPath(relative)
            if path.is_absolute() or ".." in path.parts:
                raise ValueError(f"wheel RECORD path invalid: {relative!r}")
            target = site_packages.joinpath(*path.parts)
            if not target.is_file():
                raise ValueError(f"wheel RECORD path missing: {relative!r}")
            if encoded_size and target.stat().st_size != int(encoded_size):
                raise ValueError(f"wheel RECORD size mismatch: {relative!r}")
            if encoded_hash:
                algorithm, separator, expected = encoded_hash.partition("=")
                if separator != "=" or algorithm != "sha256":
                    raise ValueError(f"wheel RECORD hash unsupported: {relative!r}")
                actual = base64.urlsafe_b64encode(bytes.fromhex(sha256_file(target))).decode("ascii").rstrip("=")
                if actual != expected:
                    raise ValueError(f"wheel RECORD hash mismatch: {relative!r}")


def remove_headless_optional_extensions(runtime: Path) -> None:
    """Remove the optional Tk extension from the headless companion runtime."""
    matches = list(runtime.glob("python/lib/python3.12/lib-dynload/_tkinter*.so"))
    if len(matches) != 1:
        raise ValueError(f"bundled _tkinter extension count invalid: {len(matches)}")
    matches[0].unlink()


def walk_tree(root: Path):
    for entry in sorted(os.scandir(root), key=lambda item: item.name):
        path = Path(entry.path)
        yield path
        if entry.is_dir(follow_symlinks=False):
            yield from walk_tree(path)


def tree_digest(root: Path) -> str:
    digest = hashlib.sha256()
    for path in walk_tree(root):
        relative = path.relative_to(root).as_posix()
        info = path.lstat()
        mode = stat.S_IMODE(info.st_mode)
        if stat.S_ISDIR(info.st_mode):
            kind, payload = "dir", b""
        elif stat.S_ISREG(info.st_mode):
            kind, payload = "file", bytes.fromhex(sha256_file(path))
        elif stat.S_ISLNK(info.st_mode):
            kind, mode, payload = "symlink", 0o777, os.readlink(path).encode("utf-8")
        else:
            raise ValueError(f"unsupported runtime file type: {relative}")
        digest.update(kind.encode("ascii") + b"\0")
        digest.update(relative.encode("utf-8") + b"\0")
        digest.update(f"{mode:o}".encode("ascii") + b"\0")
        digest.update(payload + b"\0")
    return digest.hexdigest()


def deterministic_archive(root: Path, output: Path) -> None:
    with tempfile.NamedTemporaryFile(suffix=".tar", delete=False) as temporary:
        tar_path = Path(temporary.name)
    try:
        with tarfile.open(tar_path, "w", format=tarfile.PAX_FORMAT) as archive:
            for path in [root, *walk_tree(root)]:
                arcname = ARTIFACT_ROOT if path == root else f"{ARTIFACT_ROOT}/{path.relative_to(root).as_posix()}"

                def normalize(info: tarfile.TarInfo) -> tarfile.TarInfo:
                    info.uid = info.gid = 0
                    info.uname = info.gname = "root"
                    info.mtime = 0
                    if info.issym():
                        info.mode = 0o777
                    return info

                archive.add(path, arcname=arcname, recursive=False, filter=normalize)
        output.parent.mkdir(parents=True, exist_ok=True)
        with tar_path.open("rb") as source, output.open("wb") as raw:
            with gzip.GzipFile(filename="", mode="wb", fileobj=raw, compresslevel=9, mtime=0) as compressed:
                shutil.copyfileobj(source, compressed, 1024 * 1024)
    finally:
        tar_path.unlink(missing_ok=True)


def run(command: list[str], *, cwd: Path | None = None, env: dict[str, str] | None = None) -> None:
    subprocess.run(command, cwd=cwd, env=env, check=True)


def build(args: argparse.Namespace) -> dict[str, object]:
    inputs = {
        args.source: SOURCE_SHA256,
        args.requirements: REQUIREMENTS_SHA256,
        args.python_asset: PYTHON_SHA256,
    }
    for path, expected in inputs.items():
        actual = sha256_file(path)
        if actual != expected:
            raise ValueError(f"input digest mismatch: {path.name} expected={expected} actual={actual}")
    uv_digest = sha256_file(args.uv)
    if uv_digest != args.uv_sha256:
        raise ValueError(f"uv digest mismatch: expected={args.uv_sha256} actual={uv_digest}")

    wheels = sorted(args.wheelhouse.glob("*.whl"), key=lambda path: path.name)
    wheel_entries = []
    expected_distributions: dict[str, str] = {}
    wheel_aggregate = hashlib.sha256()
    for wheel in wheels:
        name, version = wheel_metadata(wheel)
        digest = sha256_file(wheel)
        wheel_entries.append({"file": wheel.name, "name": name, "version": version, "sha256": digest})
        wheel_aggregate.update(f"{digest}  ./{wheel.name}\n".encode("utf-8"))
        if name != "setuptools":
            if name in expected_distributions:
                raise ValueError(f"duplicate wheel distribution: {name}")
            expected_distributions[name] = version
    if len(wheels) != 77 or wheel_aggregate.hexdigest() != WHEELHOUSE_SHA256:
        raise ValueError("wheelhouse identity mismatch")
    setuptools_wheels = [entry for entry in wheel_entries if entry["name"] == "setuptools" and entry["version"] == "83.0.0"]
    if len(setuptools_wheels) != 1:
        raise ValueError("setuptools 83 builder wheel missing")

    with tempfile.TemporaryDirectory(prefix="hermes-runtime-build-") as temporary:
        work = Path(temporary)
        runtime = work / ARTIFACT_ROOT
        safe_extract_tar(args.python_asset, runtime, exclude_prefixes=("python/share/terminfo",))
        remove_headless_optional_extensions(runtime)
        extracted_source = work / "source"
        safe_extract_tar(args.source, extracted_source)
        roots = list(extracted_source.iterdir())
        if len(roots) != 1 or not roots[0].is_dir():
            raise ValueError("source archive root invalid")
        shutil.move(str(roots[0]), runtime / "app")
        if sha256_file(runtime / "app" / "uv.lock") != UV_LOCK_SHA256:
            raise ValueError("source uv.lock digest mismatch")

        site_packages = runtime / "python" / "lib" / "python3.12" / "site-packages"
        for path in [site_packages / "pip", *site_packages.glob("pip-*.dist-info")]:
            if path.is_dir():
                shutil.rmtree(path)
        for name in ("pip", "pip3", "pip3.12"):
            (runtime / "python" / "bin" / name).unlink(missing_ok=True)
        uv_env = {"PATH": os.environ.get("PATH", ""), "UV_NO_CONFIG": "1", "UV_NO_PROGRESS": "1", "UV_OFFLINE": "1"}
        run([
            str(args.uv), "pip", "install", "--target", str(site_packages),
            "--python", sys.executable, "--no-python-downloads",
            "--python-version", PYTHON_VERSION, "--python-platform", "x86_64-unknown-linux-gnu",
            "--no-index", "--no-build", "--no-cache", "--link-mode", "copy", "--require-hashes",
            "--find-links", str(args.wheelhouse), "-r", str(args.requirements),
        ], env=uv_env)
        normalize_installed_records(
            site_packages,
            omitted_globs=("PIL/_imagingtk*.so", "PIL/_tkinter_finder.py"),
        )

        metadata_venv = work / "metadata-venv"
        run([sys.executable, "-m", "venv", str(metadata_venv)])
        metadata_python = metadata_venv / "bin" / "python"
        setuptools_path = args.wheelhouse / str(setuptools_wheels[0]["file"])
        run([
            str(args.uv), "pip", "install", "--python", str(metadata_python), "--no-index", "--no-cache",
            str(setuptools_path),
        ], env=uv_env)
        metadata_output = work / "metadata"
        metadata_output.mkdir()
        metadata_env = {"PATH": os.environ.get("PATH", ""), "PYTHONNOUSERSITE": "1"}
        run([str(metadata_python), "-I", "setup.py", "dist_info", "--output-dir", str(metadata_output)], cwd=runtime / "app", env=metadata_env)
        generated = list(metadata_output.glob("hermes_agent-0.20.0.dist-info"))
        if len(generated) != 1:
            raise ValueError("Hermes dist-info generation failed")
        if any(str(work).encode("utf-8") in path.read_bytes() for path in generated[0].iterdir() if path.is_file()):
            raise ValueError("Hermes dist-info leaks build path")
        shutil.copytree(generated[0], site_packages / generated[0].name)

        installed = {
            canonical_name(distribution.metadata["Name"]): distribution.version
            for distribution in metadata.distributions(path=[str(site_packages)])
        }
        expected = {**expected_distributions, "hermes-agent": SOURCE_VERSION}
        if installed != expected:
            raise ValueError(f"installed distribution closure mismatch: expected={expected} actual={installed}")

        launcher = runtime / "bin" / "hermes"
        launcher.parent.mkdir()
        launcher.write_text(
            "#!/bin/sh\n"
            "set -eu\n"
            "SELF=$(readlink -f -- \"$0\")\n"
            "ROOT=$(CDPATH= cd -- \"$(dirname -- \"$SELF\")/..\" && pwd -P)\n"
            "unset PYTHONHOME\n"
            "export PYTHONNOUSERSITE=1 PYTHONDONTWRITEBYTECODE=1 PYTHONSAFEPATH=1\n"
            "export PYTHONPATH=\"$ROOT/app\"\n"
            "exec \"$ROOT/python/bin/python3\" -P -m hermes_cli.main \"$@\"\n",
            encoding="utf-8",
        )
        launcher.chmod(0o755)

        for path in [path for path in walk_tree(runtime) if path.name == "__pycache__" and path.is_dir()]:
            shutil.rmtree(path)
        if any(path.suffix == ".pyc" for path in walk_tree(runtime)) or (site_packages / "bin").exists():
            raise ValueError("runtime contains generated host artifacts")

        runtime_tree_sha256 = tree_digest(runtime)
        deterministic_archive(runtime, args.output)
        result = {
            "schemaVersion": 1,
            "status": "LOCAL_BUILT_NOT_LINUX_VERIFIED",
            "source": {
                "repository": "NousResearch/hermes-agent",
                "tag": SOURCE_TAG,
                "tagObject": SOURCE_TAG_OBJECT,
                "tagVerification": "verified-valid",
                "commit": SOURCE_COMMIT,
                "commitSigned": False,
                "version": SOURCE_VERSION,
                "archiveSha256": SOURCE_SHA256,
                "uvLockSha256": UV_LOCK_SHA256,
            },
            "dependencies": {
                "requirementsSha256": REQUIREMENTS_SHA256,
                "wheelhouseAggregateSha256": WHEELHOUSE_SHA256,
                "wheels": wheel_entries,
                "installed": dict(sorted(expected.items())),
            },
            "python": {
                "version": PYTHON_VERSION,
                "asset": PYTHON_ASSET,
                "assetSha256": PYTHON_SHA256,
                "executableSha256": sha256_file(runtime / "python" / "bin" / "python3.12"),
            },
            "treeTransforms": [{
                "excludedPrefix": "python/share/terminfo/",
                "reason": "target Ubuntu uses readable system terminfo; bundled PBS entries are case-colliding and not auto-discovered",
            }, {
                "removedPaths": [
                    "python/lib/python3.12/lib-dynload/_tkinter*.so",
                    "python/lib/python3.12/site-packages/PIL/_imagingtk*.so",
                    "python/lib/python3.12/site-packages/PIL/_tkinter_finder.py",
                    "the corresponding Pillow wheel RECORD rows",
                ],
                "reason": "remove unused GUI-only Tk integrations from the headless companion runtime instead of exporting a process-wide library search path",
            }, {
                "removedPaths": [
                    "python/bin/pip", "python/bin/pip3", "python/bin/pip3.12",
                    "python/lib/python3.12/site-packages/pip*",
                    "python/lib/python3.12/site-packages/bin/*",
                    "the corresponding bin/* row in each wheel RECORD",
                ],
                "reason": "remove pip and dependency console launchers; zero lazy/online install remains a blocking Linux runtime gate",
            }, {
                "removedPaths": ["python/lib/python3.12/site-packages/*.dist-info/uv_cache.json", "the corresponding row in each wheel RECORD"],
                "reason": "remove uv install-time timestamps so identical locked inputs produce a byte-identical runtime",
            }],
            "builder": {
                "uvVersion": subprocess.check_output([str(args.uv), "--version"], text=True).strip(),
                "uvSha256": uv_digest,
                "setuptoolsWheelSha256": str(setuptools_wheels[0]["sha256"]),
            },
            "artifact": {
                "archiveRoot": ARTIFACT_ROOT,
                "treeSha256": runtime_tree_sha256,
                "tarGzSha256": sha256_file(args.output),
                "bytes": args.output.stat().st_size,
            },
            "pendingLinuxGates": [
                "absolute-root-read-only",
                "ldd-no-not-found",
                "compiled-imports",
                "system-terminfo-curses",
                "relocated-root",
                "hermes-version",
                "unified-gateway-offline-smoke",
                "zero-tirith-download",
                "zero-lazy-install",
            ],
        }
    args.manifest.parent.mkdir(parents=True, exist_ok=True)
    args.manifest.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--requirements", type=Path, required=True)
    parser.add_argument("--wheelhouse", type=Path, required=True)
    parser.add_argument("--python-asset", type=Path, required=True)
    parser.add_argument("--uv", type=Path, required=True)
    parser.add_argument("--uv-sha256", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    args = parser.parse_args()
    for path in (args.source, args.requirements, args.python_asset, args.uv):
        if not path.is_file():
            parser.error(f"file missing: {path}")
    if not args.wheelhouse.is_dir():
        parser.error(f"wheelhouse missing: {args.wheelhouse}")
    try:
        result = build(args)
    except (OSError, ValueError, subprocess.CalledProcessError, tarfile.TarError, zipfile.BadZipFile) as error:
        print(f"build-hermes-runtime-artifact: failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps(result["artifact"], sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
