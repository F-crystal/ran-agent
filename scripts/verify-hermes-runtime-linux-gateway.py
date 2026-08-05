#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import platform
import shutil
import signal
import stat
import subprocess
import time
import urllib.request
from pathlib import Path


def ip_json(*arguments: str) -> list[dict[str, object]]:
    result = subprocess.run(
        ["/usr/sbin/ip", "-j", *arguments],
        env={"PATH": "/usr/sbin:/usr/bin:/bin", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8"},
        check=True,
        text=True,
        stdout=subprocess.PIPE,
    )
    value = json.loads(result.stdout)
    if not isinstance(value, list):
        raise RuntimeError(f"unexpected ip JSON for {arguments}")
    return value


def require_loopback_only() -> dict[str, object]:
    links = ip_json("link", "show")
    if len(links) != 1 or links[0].get("ifname") != "lo" or "LOOPBACK" not in links[0].get("flags", []):
        raise RuntimeError(f"network namespace has non-loopback interfaces: {links}")
    ipv4_routes = ip_json("route", "show")
    ipv6_routes = ip_json("-6", "route", "show")
    if ipv4_routes or ipv6_routes:
        raise RuntimeError(f"network namespace has routes: ipv4={ipv4_routes} ipv6={ipv6_routes}")
    return {"interfaces": ["lo"], "ipv4Routes": 0, "ipv6Routes": 0}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--profile", type=Path, required=True)
    parser.add_argument("--builder", type=Path, required=True)
    parser.add_argument("--scratch", type=Path, required=True)
    parser.add_argument("--repo-root", default="/opt/ran_agent")
    parser.add_argument("--service-user", default="ubuntu")
    args = parser.parse_args()

    if platform.system() != "Linux" or platform.machine() != "x86_64" or os.geteuid() != 0:
        raise SystemExit("requires Linux x86_64 root harness")
    if os.readlink("/proc/self/ns/net") == os.readlink("/proc/1/ns/net"):
        raise SystemExit("requires an isolated network namespace")
    network = require_loopback_only()
    subprocess.run(["/usr/sbin/ip", "link", "set", "lo", "up"], check=True)
    network = require_loopback_only()

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
    extracted = args.scratch / "extracted"
    builder.safe_extract_tar(args.archive, extracted)
    runtime = extracted / artifact["archiveRoot"]
    runtime_tree_sha256 = builder.tree_digest(runtime)
    if runtime_tree_sha256 != artifact["treeSha256"]:
        raise RuntimeError("artifact tree digest mismatch")
    for path in [runtime, *builder.walk_tree(runtime)]:
        if not path.is_symlink():
            path.chmod(stat.S_IMODE(path.stat().st_mode) & ~0o222)
    if any(path.lstat().st_mode & 0o222 for path in [runtime, *builder.walk_tree(runtime)] if not path.is_symlink()):
        raise RuntimeError("runtime remains writable")
    before = builder.tree_digest(runtime)

    home = args.scratch / "home"
    profile_dir = home / "profiles/ran-assistant-lite"
    fake_bin = args.scratch / "fake-bin"
    profile_dir.mkdir(parents=True, mode=0o700)
    fake_bin.mkdir(mode=0o755)
    shutil.copy2(args.profile, home / "config.yaml")
    shutil.copy2(args.profile, profile_dir / "config.yaml")
    marker = home / "unexpected-installer"
    obsidian_marker = home / "unexpected-obsidian-memory"
    for name in ("uv", "pip", "pip3", "curl", "wget"):
        command = fake_bin / name
        command.write_text(f"#!/bin/sh\nprintf '%s\\n' {name} >> {marker}\nexit 91\n", encoding="utf-8")
        command.chmod(0o755)
    obsidian_command = fake_bin / "obsidian-memory-must-not-start"
    obsidian_command.write_text(
        f"#!/bin/sh\nprintf started > {obsidian_marker}\nsleep 300\n", encoding="utf-8"
    )
    obsidian_command.chmod(0o755)
    subprocess.run(["chown", "-R", f"{args.service_user}:{args.service_user}", str(home)], check=True)

    port = 18765
    key = "isolated-runtime-smoke"
    environment = {
        "PATH": f"{fake_bin}:/usr/bin:/bin",
        "HOME": str(home),
        "TMPDIR": str(home / "tmp"),
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "PYTHONNOUSERSITE": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONPATH": str(runtime / "app"),
        "HERMES_HOME": str(home),
        "HERMES_PROFILE": "ran-assistant-lite",
        "HERMES_DISABLE_LAZY_INSTALLS": "1",
        "TIRITH_ENABLED": "false",
        "HERMES_ACCEPT_HOOKS": "1",
        "RAN_AGENT_REPO_ROOT": args.repo_root,
        "API_SERVER_ENABLED": "true",
        "API_SERVER_HOST": "127.0.0.1",
        "API_SERVER_PORT": str(port),
        "API_SERVER_MODEL_NAME": "ran-assistant-lite",
        "API_SERVER_KEY": key,
        "HERMES_API_KEY": key,
        "HERMES_API_BASE_URL": f"http://127.0.0.1:{port}/v1",
        "DEEPSEEK_API_KEY": "synthetic-offline",
        "TAVILY_API_KEY": "synthetic-offline",
        "OMBRE_BRAIN_MCP_URL": "http://127.0.0.1:18001/mcp",
        "OBSIDIAN_MEMORY_MCP_ENABLED": "false",
        "OBSIDIAN_MEMORY_MCP_COMMAND": str(obsidian_command),
    }
    (home / "tmp").mkdir(mode=0o700)
    subprocess.run(["chown", f"{args.service_user}:{args.service_user}", str(home / "tmp")], check=True)
    env_args = [f"{key}={value}" for key, value in environment.items()]
    command = [
        "/usr/sbin/runuser", "-u", args.service_user, "--", "/usr/bin/env", "-i", *env_args,
        str(runtime / "bin/hermes"), "-p", "ran-assistant-lite", "gateway", "run",
        "--replace", "--external-supervisor", "--accept-hooks",
    ]
    log_path = args.scratch / "gateway.log"
    with log_path.open("wb") as log:
        process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            payload = None
            for _ in range(120):
                if process.poll() is not None:
                    break
                try:
                    request = urllib.request.Request(
                        f"http://127.0.0.1:{port}/v1/models",
                        headers={"Authorization": f"Bearer {key}"},
                    )
                    with urllib.request.urlopen(request, timeout=1) as response:
                        payload = json.loads(response.read())
                    break
                except Exception:
                    time.sleep(0.25)
            if payload is None:
                raise RuntimeError(f"gateway did not become ready; exit={process.poll()}\n{log_path.read_text(errors='replace')}")
            if "ran-assistant-lite" not in json.dumps(payload):
                raise RuntimeError(f"unexpected /v1/models response: {payload}")
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=20)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait(timeout=5)

    lazy_probe = r'''
from tools import lazy_deps, tirith_security
if lazy_deps._allow_lazy_installs() is not False:
    raise RuntimeError("lazy installs unexpectedly enabled")
result = lazy_deps.install_specs(["definitely-missing-package==0"])
if not result.blocked or result.ok:
    raise RuntimeError("direct lazy install was not blocked")
missing = next((name for name in lazy_deps.LAZY_DEPS if lazy_deps.feature_missing(name)), None)
if missing is None:
    raise RuntimeError("no missing lazy feature available for probe")
try:
    lazy_deps.ensure(missing, prompt=False)
except lazy_deps.FeatureUnavailable:
    pass
else:
    raise AssertionError("lazy dependency install was not blocked")
if tirith_security.ensure_installed(log_failures=False) is not None:
    raise RuntimeError("Tirith unexpectedly resolved")
'''
    subprocess.run(
        [
            "/usr/sbin/runuser", "-u", args.service_user, "--", "/usr/bin/env", "-i", *env_args,
            str(runtime / "python/bin/python3"), "-P", "-c", lazy_probe,
        ],
        cwd=runtime / "app",
        check=True,
    )
    if marker.exists():
        raise RuntimeError(f"installer command executed: {marker.read_text(encoding='utf-8')}")
    if obsidian_marker.exists():
        raise RuntimeError("disabled obsidian_memory MCP was started")
    if before != builder.tree_digest(runtime):
        raise RuntimeError("read-only runtime tree changed")
    cron = home / "cron/jobs.json"
    if cron.exists():
        stored = json.loads(cron.read_text(encoding="utf-8"))
        jobs = stored.get("jobs", []) if isinstance(stored, dict) else stored
        if jobs:
            raise RuntimeError("gateway created a cron job")
    if any("tirith" in path.name.lower() for path in home.rglob("*")):
        raise RuntimeError("gateway created Tirith state")
    print(json.dumps({
        "status": "PASS",
        "artifactManifestSha256": builder.sha256_file(args.manifest),
        "artifactTarGzSha256": archive_sha256,
        "treeSha256": runtime_tree_sha256,
        "model": "ran-assistant-lite",
        "network": {"mode": "loopback-only", **network},
        "cronJobs": 0,
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
