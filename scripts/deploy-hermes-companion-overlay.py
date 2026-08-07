#!/usr/bin/env python3
"""Apply an exact Git candidate's Hermes companion MCP overlay."""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import re
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path


OVERLAY_PATHS = (
    "node_bridge/src/coReading/mcpServer.mjs",
    "node_bridge/src/externalMcp/gatewayMcpServer.mjs",
    "node_bridge/src/mediaGenerationMcpServer.mjs",
    "node_bridge/src/mediaReaderMcpServer.mjs",
    "node_bridge/src/personalMemoryMcpServer.mjs",
    "node_bridge/src/searchHubMcpServer.mjs",
    "node_bridge/src/socialReaderMcpServer.mjs",
    "node_bridge/src/stickerCatalogMcpServer.mjs",
)
PROFILE_SOURCE = "hermes/profile/config.companion.yaml"
PROFILE_DESTINATIONS = (
    "/home/ubuntu/.hermes-ran-agent/lite/config.yaml",
    "/home/ubuntu/.hermes-ran-agent/lite/profiles/ran-assistant-lite/config.yaml",
)
PYTHON_SOURCE = "src/personal_agent/service.py"
CANDIDATE_PATHS = (*OVERLAY_PATHS, PROFILE_SOURCE, PYTHON_SOURCE)
HOST_PATHS = (*OVERLAY_PATHS, PYTHON_SOURCE)
CONTROLLER_PATH = "scripts/deploy-hermes-companion-overlay.py"
MANIFEST_PATH = "docs/governance/hermes_companion_overlay.v1.json"
CANDIDATE_REF_ROOT = "refs/ran-agent/overlay-candidates"
MIN_FREE_BYTES = 15 * 1024 * 1024 * 1024
RUNTIME_ROOT = Path("/opt/ran-agent-runtimes")
TRANSACTION_ROOT = Path("/opt/ran_agent-release/companion-overlay-transactions")
LOCK_PATH = Path("/opt/ran_agent-release/.release-transaction.lock")
DROPIN = Path("/etc/systemd/system/ran-agent-hermes.service.d/30-companion-overlay.conf")
PYTHON_DROPIN = Path("/etc/systemd/system/ran-agent-python.service.d/30-personal-memory-overlay.conf")
HERMES_UNIT = "ran-agent-hermes.service"
NODE_UNIT = "ran-agent-node.service"
PYTHON_UNIT = "ran-agent-python.service"


class OverlayError(RuntimeError):
    pass


def run(command: list[str], *, check: bool = True, text: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(command, check=check, capture_output=True, text=text)


def git(repo: Path, *args: str, text: bool = True) -> subprocess.CompletedProcess:
    return run(["git", "-c", f"safe.directory={repo}", "-C", str(repo), *args], text=text)


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def candidate_blob(repo: Path, candidate: str, path: str) -> bytes:
    return git(repo, "show", f"{candidate}:{path}", text=False).stdout


def candidate_files(repo: Path, candidate: str) -> dict[str, bytes]:
    return {path: candidate_blob(repo, candidate, path) for path in CANDIDATE_PATHS}


def overlay_digest(files: dict[str, bytes]) -> str:
    digest = hashlib.sha256()
    for path in CANDIDATE_PATHS:
        digest.update(path.encode("utf-8"))
        digest.update(b"\0")
        digest.update(hashlib.sha256(files[path]).digest())
    return digest.hexdigest()


def render_dropin(root: Path) -> bytes:
    lines = [
        "[Service]",
        "BindReadOnlyPaths=",
        "UnsetEnvironment=OBSIDIAN_MEMORY_MCP_ENABLED",
        "Environment=PERSONAL_MEMORY_BACKEND_TIMEOUT_MS=15000",
    ]
    for relative in OVERLAY_PATHS:
        lines.append(f"BindReadOnlyPaths={root / relative}:/opt/ran_agent/{relative}")
    for destination in PROFILE_DESTINATIONS:
        lines.append(f"BindReadOnlyPaths={root / PROFILE_SOURCE}:{destination}")
    return ("\n".join(lines) + "\n").encode("utf-8")


def render_python_dropin(root: Path) -> bytes:
    return (
        "[Service]\n"
        "BindReadOnlyPaths=\n"
        f"BindReadOnlyPaths={root / PYTHON_SOURCE}:/opt/ran_agent/{PYTHON_SOURCE}\n"
    ).encode("utf-8")


def atomic_write(path: Path, value: bytes, mode: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary_path = Path(temporary)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary_path, mode)
        os.replace(temporary_path, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        temporary_path.unlink(missing_ok=True)


def write_json(path: Path, value: dict) -> None:
    atomic_write(path, (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode(), 0o600)


def require_root() -> None:
    if os.geteuid() != 0:
        raise OverlayError("overlay transaction must run as root")


def require_candidate(repo: Path, candidate: str) -> dict:
    if not re.fullmatch(r"[0-9a-f]{40}", candidate):
        raise OverlayError("candidate must be an exact 40-character SHA")
    resolved = git(repo, "rev-parse", f"{candidate}^{{commit}}").stdout.strip()
    if resolved != candidate:
        raise OverlayError("candidate does not resolve exactly")
    retained = git(repo, "rev-parse", f"{CANDIDATE_REF_ROOT}/{candidate}^{{commit}}").stdout.strip()
    if retained != candidate:
        raise OverlayError("candidate overlay retention ref is absent or differs")
    controller = Path(__file__)
    controller_stat = controller.stat()
    if controller.is_symlink() or not controller.is_file() or controller_stat.st_uid != 0 or controller_stat.st_gid != 0 or controller_stat.st_mode & 0o222:
        raise OverlayError("controller must be root-owned and non-writable")
    if candidate_blob(repo, candidate, CONTROLLER_PATH) != controller.read_bytes():
        raise OverlayError("controller is not extracted from the candidate")
    manifest = json.loads(candidate_blob(repo, candidate, MANIFEST_PATH))
    if manifest.get("schemaVersion") != 1 or manifest.get("status") != "RELEASE_CANDIDATE_READY_FOR_COMPANION_OVERLAY_APPLY":
        raise OverlayError("candidate overlay manifest is not release-ready")
    return manifest


def manifest_files(manifest: dict, key: str) -> dict[str, str]:
    values = {str(item["path"]): str(item["sha256"]) for item in manifest[key]["files"]}
    if tuple(values) != OVERLAY_PATHS or any(not re.fullmatch(r"[0-9a-f]{64}", value) for value in values.values()):
        raise OverlayError(f"manifest {key} file contract is invalid")
    return values


def manifest_profile(manifest: dict, key: str) -> str:
    value = manifest[key]
    digest = str(value["sha256"])
    if value.get("source") != PROFILE_SOURCE or tuple(value.get("destinations", ())) != PROFILE_DESTINATIONS:
        raise OverlayError(f"manifest {key} profile contract is invalid")
    if not re.fullmatch(r"[0-9a-f]{64}", digest):
        raise OverlayError(f"manifest {key} profile digest is invalid")
    return digest


def manifest_python(manifest: dict, key: str) -> str:
    value = manifest[key]
    digest = str(value["sha256"])
    if value.get("source") != PYTHON_SOURCE or value.get("destination") != f"/opt/ran_agent/{PYTHON_SOURCE}":
        raise OverlayError(f"manifest {key} Python contract is invalid")
    if not re.fullmatch(r"[0-9a-f]{64}", digest):
        raise OverlayError(f"manifest {key} Python digest is invalid")
    return digest


def require_exact_file(contract: dict) -> Path:
    path = Path(str(contract["path"]))
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        raise OverlayError(f"runtime contract path is invalid: {path}")
    if sha256_file(path) != contract.get("sha256"):
        raise OverlayError(f"runtime contract digest differs: {path}")
    return path


def service_active(unit: str) -> bool:
    return run(["systemctl", "is-active", "--quiet", unit], check=False).returncode == 0


def service_pid() -> int:
    value = run(["systemctl", "show", "-p", "MainPID", "--value", HERMES_UNIT]).stdout.strip()
    return int(value or "0")


def unit_pid(unit: str) -> int:
    value = run(["systemctl", "show", "-p", "MainPID", "--value", unit]).stdout.strip()
    return int(value or "0")


def port_open(port: int) -> bool:
    with socket.socket() as probe:
        probe.settimeout(0.25)
        return probe.connect_ex(("127.0.0.1", port)) == 0


def wait_for_gateway(timeout: float = 45.0) -> int:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        pid = service_pid()
        if pid > 0 and service_active(HERMES_UNIT) and port_open(8642) and not port_open(8643):
            return pid
        time.sleep(0.25)
    raise OverlayError("unified Hermes gateway did not become ready")


def socket_inodes_for_port(port: int) -> set[str]:
    inodes = set()
    for table in (Path("/proc/net/tcp"), Path("/proc/net/tcp6")):
        for line in table.read_text(encoding="utf-8").splitlines()[1:]:
            fields = line.split()
            if len(fields) >= 10 and fields[3] == "0A" and int(fields[1].split(":")[-1], 16) == port:
                inodes.add(fields[9])
    return inodes


def pid_socket_inodes(pid: int) -> set[str]:
    inodes = set()
    for descriptor in Path(f"/proc/{pid}/fd").iterdir():
        try:
            target = os.readlink(descriptor)
        except FileNotFoundError:
            continue
        match = re.fullmatch(r"socket:\[(\d+)\]", target)
        if match:
            inodes.add(match.group(1))
    return inodes


def require_gateway_identity(pid: int, manifest: dict) -> None:
    runtime = manifest["runtime"]
    require_exact_file(runtime["executable"])
    process = runtime["process"]
    executable = require_exact_file(process["executable"])
    if Path(f"/proc/{pid}/exe").resolve() != executable:
        raise OverlayError("Hermes MainPID interpreter is not the approved v0.20 executable")
    argv = [field.decode() for field in Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0") if field]
    if argv != process["argv"]:
        raise OverlayError("Hermes MainPID argv differs from the approved v0.20 command")
    listeners = socket_inodes_for_port(8642)
    if len(listeners) != 1 or not listeners.issubset(pid_socket_inodes(pid)) or socket_inodes_for_port(8643):
        raise OverlayError("Hermes listener ownership/topology differs")
    environment = dict(
        field.split(b"=", 1) for field in Path(f"/proc/{pid}/environ").read_bytes().split(b"\0") if b"=" in field
    )
    if environment.get(b"HERMES_HOME", b"").decode() != runtime["home"]:
        raise OverlayError("Hermes home differs from the overlay manifest")
    if environment.get(b"HERMES_PROFILE", b"").decode() != runtime["profile"]:
        raise OverlayError("Hermes profile differs from the overlay manifest")


def namespace_digests(pid: int) -> dict[str, str]:
    values = {}
    for relative in OVERLAY_PATHS:
        path = Path(f"/proc/{pid}/root/opt/ran_agent") / relative
        if not path.is_file():
            raise OverlayError(f"overlay target absent in Hermes namespace: {relative}")
        values[relative] = sha256_file(path)
    return values


def namespace_profile_digests(pid: int) -> dict[str, str]:
    values = {}
    root = Path(f"/proc/{pid}/root")
    for destination in PROFILE_DESTINATIONS:
        path = root / destination.lstrip("/")
        if not path.is_file():
            raise OverlayError(f"profile target absent in Hermes namespace: {destination}")
        values[destination] = sha256_file(path)
    return values


def python_namespace_digest(pid: int) -> str:
    path = Path(f"/proc/{pid}/root/opt/ran_agent") / PYTHON_SOURCE
    if not path.is_file():
        raise OverlayError("Python overlay target is absent")
    return sha256_file(path)


def namespace_mounts_readonly(pid: int, source_root: Path | None = None) -> None:
    mountinfo = Path(f"/proc/{pid}/mountinfo").read_text(encoding="utf-8").splitlines()
    options = {}
    sources = {}
    for line in mountinfo:
        fields = line.split()
        if len(fields) >= 6:
            target = fields[4].replace("\\040", " ")
            options[target] = fields[5].split(",")
            sources[target] = fields[3].replace("\\040", " ")
    for relative in OVERLAY_PATHS:
        target = f"/opt/ran_agent/{relative}"
        if target not in options or "ro" not in options[target]:
            raise OverlayError(f"overlay target is not a read-only mount: {relative}")
        if source_root is not None and sources.get(target) != str(source_root / relative):
            raise OverlayError(f"overlay mount source differs: {relative}")
    if source_root is not None:
        for destination in PROFILE_DESTINATIONS:
            if destination not in options or "ro" not in options[destination]:
                raise OverlayError(f"profile target is not a read-only mount: {destination}")
            if sources.get(destination) != str(source_root / PROFILE_SOURCE):
                raise OverlayError(f"profile mount source differs: {destination}")


def python_namespace_mount_readonly(pid: int, source_root: Path) -> None:
    target = f"/opt/ran_agent/{PYTHON_SOURCE}"
    for line in Path(f"/proc/{pid}/mountinfo").read_text(encoding="utf-8").splitlines():
        fields = line.split()
        if len(fields) >= 6 and fields[4].replace("\\040", " ") == target:
            if "ro" not in fields[5].split(",") or fields[3].replace("\\040", " ") != str(source_root / PYTHON_SOURCE):
                break
            return
    raise OverlayError("Python overlay target is not the approved read-only mount")


def host_baseline(repo: Path) -> dict[str, dict[str, int | str]]:
    values = {}
    for relative in HOST_PATHS:
        path = repo / relative
        if path.is_symlink() or not path.is_file():
            raise OverlayError(f"host overlay target is not a regular file: {relative}")
        item = path.stat()
        values[relative] = {
            "sha256": sha256_file(path),
            "device": item.st_dev,
            "inode": item.st_ino,
            "mode": stat.S_IMODE(item.st_mode),
            "uid": item.st_uid,
            "gid": item.st_gid,
        }
    return values


def require_runtime_root() -> None:
    if RUNTIME_ROOT.is_symlink() or not RUNTIME_ROOT.is_dir():
        raise OverlayError("Runtime root is not a real directory")
    value = RUNTIME_ROOT.stat()
    if value.st_uid != os.geteuid() or value.st_gid != os.getegid() or stat.S_IMODE(value.st_mode) != 0o755:
        raise OverlayError("Runtime root identity/mode differs")


def validate_overlay_tree(root: Path, files: dict[str, bytes]) -> None:
    if root.is_symlink() or not root.is_dir():
        raise OverlayError("overlay revision root is not a real directory")
    expected = {root / relative for relative in files}
    actual = {path for path in root.rglob("*") if path.is_file() or path.is_symlink()}
    if actual != expected:
        raise OverlayError("overlay revision contains unexpected or missing files")
    for relative, payload in files.items():
        path = root / relative
        value = path.stat()
        if path.is_symlink() or not path.is_file() or sha256_file(path) != sha256_bytes(payload):
            raise OverlayError("overlay revision differs from candidate")
        if value.st_uid != os.geteuid() or value.st_gid != os.getegid() or stat.S_IMODE(value.st_mode) != 0o444:
            raise OverlayError("overlay file identity/mode differs")
    for directory in (root, *(path for path in root.rglob("*") if path.is_dir())):
        value = directory.stat()
        if directory.is_symlink() or value.st_uid != os.geteuid() or value.st_gid != os.getegid() or stat.S_IMODE(value.st_mode) != 0o555:
            raise OverlayError("overlay directory identity/mode differs")


def require_capacity(files: dict[str, bytes]) -> None:
    value = os.statvfs(RUNTIME_ROOT)
    required_bytes = MIN_FREE_BYTES + sum(len(payload) for payload in files.values()) + 1024 * 1024
    if value.f_bavail * value.f_frsize < required_bytes or value.f_favail < len(files) + 64:
        raise OverlayError("insufficient capacity for the small overlay transaction")


def build_overlay(root: Path, files: dict[str, bytes]) -> None:
    require_runtime_root()
    if root.exists() or root.is_symlink():
        validate_overlay_tree(root, files)
        return
    incoming = RUNTIME_ROOT / f".{root.name}.incoming-{os.getpid()}"
    if incoming.exists():
        raise OverlayError("overlay incoming path already exists")
    try:
        for relative, value in files.items():
            target = incoming / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(value)
            with target.open("rb") as handle:
                os.fsync(handle.fileno())
            target.chmod(0o444)
        for path in sorted((incoming, *incoming.rglob("*")), reverse=True):
            if path.is_dir():
                path.chmod(0o555)
                descriptor = os.open(path, os.O_RDONLY)
                try:
                    os.fsync(descriptor)
                finally:
                    os.close(descriptor)
        os.replace(incoming, root)
        descriptor = os.open(RUNTIME_ROOT, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        validate_overlay_tree(root, files)
    finally:
        if incoming.exists():
            shutil.rmtree(incoming)


def call_memory_mcp(node_bin: Path, server: Path) -> None:
    requests = (
        {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "recall_personal_memory", "arguments": {"query": "overlay acceptance"}}},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "recall_personal_memory", "arguments": {"user_text": "legacy argument"}}},
    )
    payload = "".join(json.dumps(item, ensure_ascii=False) + "\n" for item in requests)
    env = {
        "HOME": "/tmp",
        "LANG": "C.UTF-8",
        "PATH": "/usr/bin:/bin",
        "PYTHON_BACKEND_BASE_URL": "http://127.0.0.1:8787",
        "PERSONAL_MEMORY_BACKEND_TIMEOUT_MS": "15000",
    }
    result = subprocess.run([str(node_bin), str(server)], input=payload, capture_output=True, text=True, timeout=20, env=env)
    if result.returncode != 0:
        raise OverlayError("personal-memory MCP acceptance process failed")
    responses = {item["id"]: item["result"] for line in result.stdout.splitlines() if (item := json.loads(line)).get("id") in {1, 2}}
    accepted = responses.get(1, {}).get("structuredContent", {})
    rejected = responses.get(2, {}).get("structuredContent", {})
    statuses = accepted.get("source_status")
    if (
        not accepted.get("ok")
        or not isinstance(statuses, dict)
        or statuses.get("vault_knowledge") not in {"hit", "empty"}
        or not isinstance(accepted.get("knowledge_hits"), list)
    ):
        raise OverlayError("query recall did not expose the current Vault contract")
    if rejected.get("ok") is not False or "requires query" not in str(rejected.get("error", "")):
        raise OverlayError("legacy user_text argument was not rejected")


def verify_overlay(repo: Path, root: Path, files: dict[str, bytes], baseline: dict, node_bin: Path, manifest: dict) -> dict:
    pid = wait_for_gateway()
    require_gateway_identity(pid, manifest)
    environment = Path(f"/proc/{pid}/environ").read_bytes().split(b"\0")
    if any(value.startswith(b"OBSIDIAN_MEMORY_MCP_ENABLED=") for value in environment):
        raise OverlayError("retired Obsidian environment remains active")
    expected = {path: sha256_bytes(files[path]) for path in OVERLAY_PATHS}
    if namespace_digests(pid) != expected:
        raise OverlayError("Hermes namespace does not expose the candidate overlay")
    profile_digest = sha256_bytes(files[PROFILE_SOURCE])
    if namespace_profile_digests(pid) != {destination: profile_digest for destination in PROFILE_DESTINATIONS}:
        raise OverlayError("Hermes namespace does not expose the candidate profile")
    namespace_mounts_readonly(pid, root)
    python_pid = unit_pid(PYTHON_UNIT)
    if python_pid <= 0 or not service_active(PYTHON_UNIT):
        raise OverlayError("Python backend is not active")
    if python_namespace_digest(python_pid) != sha256_bytes(files[PYTHON_SOURCE]):
        raise OverlayError("Python namespace does not expose the candidate service")
    python_namespace_mount_readonly(python_pid, root)
    if host_baseline(repo) != baseline:
        raise OverlayError("host checkout changed during Runtime overlay apply")
    call_memory_mcp(node_bin, root / "node_bridge/src/personalMemoryMcpServer.mjs")
    if not service_active(NODE_UNIT):
        raise OverlayError("Node bridge is not active")
    return {"hermes_pid": pid, "python_pid": python_pid}


def restore_dropin(path: Path, previous: Path, previous_present: bool) -> None:
    if previous_present:
        atomic_write(path, previous.read_bytes(), 0o644)
    else:
        path.unlink(missing_ok=True)


def gateway_connection_count() -> int:
    total = 0
    for table in (Path("/proc/net/tcp"), Path("/proc/net/tcp6")):
        for line in table.read_text(encoding="utf-8").splitlines()[1:]:
            fields = line.split()
            if len(fields) >= 4 and fields[3] == "01":
                local_port = int(fields[1].split(":")[-1], 16)
                remote_port = int(fields[2].split(":")[-1], 16)
                total += local_port == 8642 or remote_port == 8642
    return total


def stop_services(timer_active: bool) -> None:
    if timer_active:
        run(["systemctl", "stop", "ran-agent-hermes-lite-soft-reset.timer"])
    run(["systemctl", "stop", NODE_UNIT])
    deadline = time.monotonic() + 60
    while gateway_connection_count() and time.monotonic() < deadline:
        time.sleep(0.25)
    if gateway_connection_count():
        raise OverlayError("Hermes connections did not drain")
    run(["systemctl", "stop", HERMES_UNIT])
    run(["systemctl", "stop", PYTHON_UNIT])


def wait_for_python(timeout: float = 30.0) -> int:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        pid = unit_pid(PYTHON_UNIT)
        if pid > 0 and service_active(PYTHON_UNIT) and port_open(8787):
            return pid
        time.sleep(0.25)
    raise OverlayError("Python backend did not become ready")


def start_services(*, gateway_timeout: float = 45.0) -> None:
    run(["systemctl", "daemon-reload"])
    run(["systemctl", "start", PYTHON_UNIT])
    wait_for_python()
    run(["systemctl", "start", HERMES_UNIT])
    wait_for_gateway(gateway_timeout)
    run(["systemctl", "start", NODE_UNIT])


def rollback(transaction: Path, state: dict, manifest: dict) -> None:
    stop_services(bool(state["timer_active"]))
    restore_dropin(DROPIN, transaction / "previous-dropin.conf", bool(state["previous_dropin_present"]))
    restore_dropin(
        PYTHON_DROPIN,
        transaction / "previous-python-dropin.conf",
        bool(state["previous_python_dropin_present"]),
    )
    state["rollback_dropins_restored_at"] = datetime.now(timezone.utc).isoformat()
    write_json(transaction / "state.json", state)
    try:
        start_services(gateway_timeout=120.0)
    except BaseException:
        run(["systemctl", "start", NODE_UNIT], check=False)
        raise
    pid = wait_for_gateway()
    if namespace_digests(pid) != state["previous_namespace_digests"]:
        raise OverlayError("overlay rollback namespace mismatch")
    if namespace_profile_digests(pid) != state["previous_profile_digests"]:
        raise OverlayError("profile rollback namespace mismatch")
    python_pid = unit_pid(PYTHON_UNIT)
    if python_namespace_digest(python_pid) != state["previous_python_digest"]:
        raise OverlayError("Python rollback namespace mismatch")
    require_gateway_identity(pid, manifest)
    namespace_mounts_readonly(pid)
    if host_baseline(Path(state["repo"])) != state["host_baseline"]:
        raise OverlayError("host checkout changed across overlay rollback")
    if state["timer_active"]:
        run(["systemctl", "start", "ran-agent-hermes-lite-soft-reset.timer"])
    state["status"] = "rolled_back"
    state["rolled_back_at"] = datetime.now(timezone.utc).isoformat()
    write_json(transaction / "state.json", state)


def require_current_transaction(
    state: dict,
    current_dropin_sha256: str | None,
    current_python_dropin_sha256: str | None,
    current_digests: dict | None,
    current_profile_digests: dict | None = None,
    current_python_digest: str | None = None,
) -> None:
    if state.get("status") == "accepted":
        if current_dropin_sha256 != state.get("applied_dropin_sha256"):
            raise OverlayError("a newer overlay drop-in supersedes this transaction")
        if current_python_dropin_sha256 != state.get("applied_python_dropin_sha256"):
            raise OverlayError("a newer Python drop-in supersedes this transaction")
        if current_digests is not None and current_digests != state.get("candidate_namespace_digests"):
            raise OverlayError("a newer overlay namespace supersedes this transaction")
        if current_profile_digests is not None and current_profile_digests != state.get("candidate_profile_digests"):
            raise OverlayError("a newer profile namespace supersedes this transaction")
        if current_python_digest is not None and current_python_digest != state.get("candidate_python_digest"):
            raise OverlayError("a newer Python namespace supersedes this transaction")
        return
    if current_digests is not None and current_digests not in (
        state.get("previous_namespace_digests"),
        state.get("candidate_namespace_digests"),
    ):
        raise OverlayError("unfinished transaction no longer matches the active overlay")
    if current_profile_digests is not None and current_profile_digests not in (
        state.get("previous_profile_digests"),
        state.get("candidate_profile_digests"),
    ):
        raise OverlayError("unfinished transaction no longer matches the active profile")
    if current_python_digest is not None and current_python_digest not in (
        state.get("previous_python_digest"),
        state.get("candidate_python_digest"),
    ):
        raise OverlayError("unfinished transaction no longer matches the active Python source")


def explicit_rollback(args: argparse.Namespace) -> None:
    if args.transaction is None:
        raise OverlayError("rollback requires --transaction")
    transaction = args.transaction.resolve()
    transaction_root = TRANSACTION_ROOT.resolve()
    if transaction.parent != transaction_root or not transaction.is_dir():
        raise OverlayError("rollback transaction is outside the managed root")
    state = json.loads((transaction / "state.json").read_text(encoding="utf-8"))
    if state.get("status") not in {"prepared", "activating", "accepted", "rollback_pending", "recovery_required"}:
        raise OverlayError("transaction is not rollback-eligible")
    repo = args.repo.resolve()
    manifest = require_candidate(repo, str(state.get("candidate", "")))
    if git(repo, "status", "--porcelain").stdout.strip():
        raise OverlayError("production checkout is not clean")
    if git(repo, "rev-parse", "HEAD").stdout.strip() != state.get("expected_production_head"):
        raise OverlayError("production checkout changed after overlay acceptance")
    current_pid = service_pid()
    current_digests = namespace_digests(current_pid) if current_pid > 0 and service_active(HERMES_UNIT) else None
    current_profile_digests = namespace_profile_digests(current_pid) if current_pid > 0 and service_active(HERMES_UNIT) else None
    current_dropin_sha256 = sha256_file(DROPIN) if DROPIN.is_file() else None
    current_python_dropin_sha256 = sha256_file(PYTHON_DROPIN) if PYTHON_DROPIN.is_file() else None
    current_python_pid = unit_pid(PYTHON_UNIT)
    current_python_digest = python_namespace_digest(current_python_pid) if current_python_pid > 0 and service_active(PYTHON_UNIT) else None
    require_current_transaction(
        state,
        current_dropin_sha256,
        current_python_dropin_sha256,
        current_digests,
        current_profile_digests,
        current_python_digest,
    )
    if (
        current_dropin_sha256 is None
        and current_python_dropin_sha256 is None
        and current_digests == state["previous_namespace_digests"]
        and current_profile_digests == state["previous_profile_digests"]
        and current_python_digest == state["previous_python_digest"]
        and port_open(8787)
        and service_active(NODE_UNIT)
    ):
        require_gateway_identity(current_pid, manifest)
        namespace_mounts_readonly(current_pid)
        if host_baseline(repo) != state["host_baseline"]:
            raise OverlayError("host checkout changed across observed overlay rollback")
        if state["timer_active"]:
            run(["systemctl", "start", "ran-agent-hermes-lite-soft-reset.timer"])
            if not service_active("ran-agent-hermes-lite-soft-reset.timer"):
                raise OverlayError("soft-reset timer did not recover")
        state["status"] = "rolled_back"
        state["rolled_back_at"] = datetime.now(timezone.utc).isoformat()
        state["rollback_observation"] = "previous runtime already active"
        write_json(transaction / "state.json", state)
        print(json.dumps({"status": "rolled_back", "transaction": str(transaction)}, sort_keys=True))
        return
    rollback(transaction, state, manifest)
    print(json.dumps({"status": "rolled_back", "transaction": str(transaction)}, sort_keys=True))


def preflight(args: argparse.Namespace) -> dict:
    repo = args.repo.resolve()
    manifest = require_candidate(repo, args.candidate)
    if git(repo, "status", "--porcelain").stdout.strip():
        raise OverlayError("production checkout is not clean")
    required_head = str(manifest.get("requiredProductionHead", ""))
    if git(repo, "rev-parse", "HEAD").stdout.strip() != required_head:
        raise OverlayError("production checkout differs from the approved baseline")
    if (
        not service_active(HERMES_UNIT)
        or not service_active(NODE_UNIT)
        or not service_active(PYTHON_UNIT)
        or not port_open(8642)
        or not port_open(8787)
        or port_open(8643)
    ):
        raise OverlayError("unified production topology is not healthy")
    if DROPIN.is_symlink() or (DROPIN.exists() and not DROPIN.is_file()):
        raise OverlayError("managed overlay drop-in has an unsafe type")
    if PYTHON_DROPIN.is_symlink() or (PYTHON_DROPIN.exists() and not PYTHON_DROPIN.is_file()):
        raise OverlayError("managed Python drop-in has an unsafe type")
    if manifest["previousOverlay"].get("dropIn") == "absent" and (DROPIN.exists() or DROPIN.is_symlink()):
        raise OverlayError("candidate requires an absent previous overlay drop-in")
    if manifest["previousPython"].get("dropIn") == "absent" and (PYTHON_DROPIN.exists() or PYTHON_DROPIN.is_symlink()):
        raise OverlayError("candidate requires an absent previous Python drop-in")

    runtime = manifest["runtime"]
    require_runtime_root()
    require_exact_file(runtime["unit"])
    require_exact_file(runtime["executable"])
    node_bin = require_exact_file(runtime["node"])
    require_exact_file(runtime["topology"])
    if not os.access(node_bin, os.X_OK):
        raise OverlayError("manifest Node executable is not executable")

    files = candidate_files(repo, args.candidate)
    require_capacity(files)
    candidate_contract = manifest_files(manifest, "candidateOverlay")
    if {path: sha256_bytes(files[path]) for path in OVERLAY_PATHS} != candidate_contract:
        raise OverlayError("candidate overlay blobs differ from the manifest")
    if sha256_bytes(files[PROFILE_SOURCE]) != manifest_profile(manifest, "candidateProfile"):
        raise OverlayError("candidate profile blob differs from the manifest")
    if sha256_bytes(files[PYTHON_SOURCE]) != manifest_python(manifest, "candidatePython"):
        raise OverlayError("candidate Python blob differs from the manifest")
    digest = overlay_digest(files)
    root = RUNTIME_ROOT / f"companion-overlay-{digest[:16]}"
    baseline = host_baseline(repo)
    previous_pid = service_pid()
    previous_digests = namespace_digests(previous_pid)
    if previous_digests != manifest_files(manifest, "previousOverlay"):
        raise OverlayError("active overlay differs from the approved baseline")
    previous_profile_digests = namespace_profile_digests(previous_pid)
    previous_profile_digest = manifest_profile(manifest, "previousProfile")
    if previous_profile_digests != {destination: previous_profile_digest for destination in PROFILE_DESTINATIONS}:
        raise OverlayError("active profile differs from the approved baseline")
    previous_python_pid = unit_pid(PYTHON_UNIT)
    previous_python_digest = python_namespace_digest(previous_python_pid)
    if previous_python_digest != manifest_python(manifest, "previousPython"):
        raise OverlayError("active Python source differs from the approved baseline")
    require_gateway_identity(previous_pid, manifest)
    namespace_mounts_readonly(previous_pid)
    if TRANSACTION_ROOT.exists():
        for state_path in TRANSACTION_ROOT.glob("*/state.json"):
            status = json.loads(state_path.read_text(encoding="utf-8")).get("status")
            if status in {"prepared", "activating", "rollback_pending", "recovery_required"}:
                raise OverlayError(f"unfinished overlay transaction requires rollback: {state_path.parent}")
    return {
        "repo": repo,
        "manifest": manifest,
        "node_bin": node_bin,
        "files": files,
        "digest": digest,
        "root": root,
        "baseline": baseline,
        "previous_digests": previous_digests,
        "previous_profile_digests": previous_profile_digests,
        "previous_python_digest": previous_python_digest,
        "required_head": required_head,
    }


def apply(args: argparse.Namespace) -> None:
    context = preflight(args)
    repo = context["repo"]
    manifest = context["manifest"]
    node_bin = context["node_bin"]
    files = context["files"]
    digest = context["digest"]
    root = context["root"]
    baseline = context["baseline"]
    previous_digests = context["previous_digests"]
    previous_profile_digests = context["previous_profile_digests"]
    previous_python_digest = context["previous_python_digest"]
    transaction = TRANSACTION_ROOT / f"{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}-{args.candidate[:12]}"
    transaction.mkdir(parents=True, mode=0o700)
    previous_present = DROPIN.exists()
    previous_python_present = PYTHON_DROPIN.exists()
    if previous_present:
        atomic_write(transaction / "previous-dropin.conf", DROPIN.read_bytes(), 0o600)
    if previous_python_present:
        atomic_write(transaction / "previous-python-dropin.conf", PYTHON_DROPIN.read_bytes(), 0o600)
    state = {
        "schema_version": 1,
        "status": "prepared",
        "candidate": args.candidate,
        "expected_production_head": context["required_head"],
        "overlay_digest": digest,
        "overlay_root": str(root),
        "previous_dropin_present": previous_present,
        "previous_python_dropin_present": previous_python_present,
        "previous_namespace_digests": previous_digests,
        "candidate_namespace_digests": {path: sha256_bytes(files[path]) for path in OVERLAY_PATHS},
        "previous_profile_digests": previous_profile_digests,
        "candidate_profile_digests": {
            destination: sha256_bytes(files[PROFILE_SOURCE]) for destination in PROFILE_DESTINATIONS
        },
        "previous_python_digest": previous_python_digest,
        "candidate_python_digest": sha256_bytes(files[PYTHON_SOURCE]),
        "host_baseline": baseline,
        "repo": str(repo),
        "timer_active": service_active("ran-agent-hermes-lite-soft-reset.timer"),
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    write_json(transaction / "state.json", state)

    build_overlay(root, files)
    dropin = render_dropin(root)
    python_dropin = render_python_dropin(root)
    state["applied_dropin_sha256"] = sha256_bytes(dropin)
    state["applied_python_dropin_sha256"] = sha256_bytes(python_dropin)
    state["status"] = "activating"
    write_json(transaction / "state.json", state)

    previous_sigterm = signal.getsignal(signal.SIGTERM)

    def interrupt_apply(_signum, _frame):
        raise OverlayError("overlay apply interrupted")

    signal.signal(signal.SIGTERM, interrupt_apply)
    try:
        stop_services(bool(state["timer_active"]))
        atomic_write(DROPIN, dropin, 0o644)
        atomic_write(PYTHON_DROPIN, python_dropin, 0o644)
        start_services()
        accepted = verify_overlay(repo, root, files, baseline, node_bin, manifest)
        if state["timer_active"]:
            run(["systemctl", "start", "ran-agent-hermes-lite-soft-reset.timer"])
        state.update(status="accepted", accepted_at=datetime.now(timezone.utc).isoformat(), acceptance=accepted)
        write_json(transaction / "state.json", state)
    except BaseException as apply_error:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        state["status"] = "rollback_pending"
        state["apply_error"] = str(apply_error)
        write_json(transaction / "state.json", state)
        try:
            rollback(transaction, state, manifest)
        except BaseException as rollback_error:
            state["status"] = "recovery_required"
            state["rollback_error"] = str(rollback_error)
            write_json(transaction / "state.json", state)
            raise OverlayError(f"apply failed: {apply_error}; rollback failed: {rollback_error}") from rollback_error
        raise
    finally:
        signal.signal(signal.SIGTERM, previous_sigterm)
    print(json.dumps({"status": "accepted", "transaction": str(transaction), "overlay": str(root)}, sort_keys=True))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=("preflight", "apply", "rollback"), default="preflight")
    parser.add_argument("--candidate")
    parser.add_argument("--transaction", type=Path)
    parser.add_argument("--repo", type=Path, default=Path("/opt/ran_agent"))
    args = parser.parse_args()
    require_root()
    descriptor = os.open(LOCK_PATH, os.O_RDONLY if args.mode == "preflight" else os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.mode == "rollback":
            explicit_rollback(args)
        else:
            if not args.candidate:
                raise OverlayError("preflight/apply requires exact --candidate")
            if args.mode == "apply":
                TRANSACTION_ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
                apply(args)
            else:
                context = preflight(args)
                print(json.dumps({
                    "status": "preflight-ok",
                    "candidate": args.candidate,
                    "overlay_digest": context["digest"],
                    "overlay_root": str(context["root"]),
                    "changed_files": [
                        path for path in OVERLAY_PATHS
                        if sha256_bytes(context["files"][path]) != context["previous_digests"][path]
                    ] + ([PROFILE_SOURCE] if sha256_bytes(context["files"][PROFILE_SOURCE])
                         != next(iter(context["previous_profile_digests"].values())) else [])
                    + ([PYTHON_SOURCE] if sha256_bytes(context["files"][PYTHON_SOURCE])
                       != context["previous_python_digest"] else []),
                }, sort_keys=True))
    finally:
        os.close(descriptor)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OverlayError, OSError, subprocess.SubprocessError, json.JSONDecodeError) as error:
        print(f"companion-overlay: failed: {error}", file=sys.stderr)
        raise SystemExit(1)
