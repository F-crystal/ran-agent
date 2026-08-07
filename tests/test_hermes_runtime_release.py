from __future__ import annotations

import importlib.util
import io
import json
import os
import subprocess
import tarfile
from pathlib import Path
from types import SimpleNamespace

import pytest


SCRIPT = Path(__file__).parents[1] / "scripts/deploy-hermes-runtime-release.py"
SPEC = importlib.util.spec_from_file_location("hermes_runtime_release", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def test_env_patch_changes_only_managed_keys_and_collapses_duplicates() -> None:
    original = b"# keep\nSECRET=private\nHERMES_PROFILE=old\nHERMES_PROFILE=older\nTAIL=value\n"
    patched = MODULE.patch_env_bytes(
        original,
        {
            "HERMES_PROFILE": "ran-assistant-lite",
            "HERMES_API_BASE_URL": "http://127.0.0.1:8642/v1",
        },
    )
    assert patched == (
        b"# keep\nSECRET=private\nTAIL=value\n"
        b"HERMES_PROFILE=ran-assistant-lite\n"
        b"HERMES_API_BASE_URL=http://127.0.0.1:8642/v1\n"
    )


def test_unified_unit_uses_exact_runtime_and_one_port() -> None:
    unit = (Path(__file__).parents[1] / "hermes/systemd/ran-agent-hermes-unified.service").read_text()
    assert "/opt/ran-agent-runtimes/hermes-v0.20.0-3049a082c0d1/bin/hermes" in unit
    assert "ExecStart=/usr/bin/env HERMES_HOME=/home/ubuntu/.hermes-ran-agent/lite" in unit
    assert "HERMES_PROFILE=ran-agent-companion" in unit
    assert "API_SERVER_PORT=8642" in unit
    assert "8643" not in unit
    assert "HERMES_DISABLE_LAZY_INSTALLS=1" in unit
    assert "TIRITH_ENABLED=false" in unit
    assert "BindReadOnlyPaths=" not in unit
    assert "PERSONAL_MEMORY_BACKEND_TIMEOUT_MS=" not in unit


def test_overlay_contract_binds_candidate_manifest_mutation_and_unit(monkeypatch: pytest.MonkeyPatch) -> None:
    install_root = Path("/opt/ran-agent-runtimes/hermes-v0.20.0-3049a082c0d1")
    blobs = {path: f"payload:{path}".encode() for path in MODULE.COMPANION_OVERLAY_PATHS}
    files = [
        {
            "source": path,
            "sourceSha256": MODULE.sha256_bytes(blobs[path]),
            "artifactPath": f"companion-overlay/{path}",
            "destination": f"/opt/ran_agent/{path}",
        }
        for path in MODULE.COMPANION_OVERLAY_PATHS
    ]
    manifest = {"companionOverlay": {"mountMode": "systemd-bind-read-only", "files": files}}
    overlay = {
        "mode": "systemd-bind-read-only",
        "artifactPrefix": "companion-overlay",
        "targetRoot": "/opt/ran_agent",
        "files": files,
    }
    mutation = {"artifactManifest": {"installRoot": str(install_root)}, "unifiedUnit": {"companionOverlay": overlay}}
    unit = "\n".join(
        f"BindReadOnlyPaths={install_root}/companion-overlay/{path}:/opt/ran_agent/{path}"
        for path in MODULE.COMPANION_OVERLAY_PATHS
    ).encode()
    monkeypatch.setattr(MODULE, "candidate_blob", lambda _repo, _candidate, path: blobs[path])

    assert MODULE.validate_companion_overlay_contract(Path("/repo"), "a" * 40, manifest, mutation, unit) == files

    manifest["companionOverlay"]["files"][0] = {**files[0], "sourceSha256": "0" * 64}
    with pytest.raises(MODULE.ReleaseError, match="identity mismatch"):
        MODULE.validate_companion_overlay_contract(Path("/repo"), "a" * 40, manifest, mutation, unit)


def test_overlay_host_baseline_rejects_a_symlink(tmp_path: Path) -> None:
    target = tmp_path / "target"
    target.write_text("old")
    link = tmp_path / "link"
    link.symlink_to(target)
    with pytest.raises(MODULE.ReleaseError, match="changed type"):
        MODULE.validate_overlay_host_baseline({
            "overlayHostBaseline": {str(link): {"sha256": MODULE.sha256_file(target)}}
        })


def test_capacity_contract_is_additive() -> None:
    mutation = {
        "admission": {
            "peakNewAllocatedBytes": 300,
            "peakInventoryBytes": {"completeLiteHomeSnapshot": 100},
            "capacityObservation": {"floorBytes": 700},
        }
    }
    original = MODULE.shutil.disk_usage
    original_statvfs = MODULE.os.statvfs
    MODULE.shutil.disk_usage = lambda _path: type("Usage", (), {"free": 1001})()
    MODULE.os.statvfs = lambda _path: type("Vfs", (), {"f_favail": 5000})()
    try:
        assert MODULE.capacity_admission(
            Path("/"), mutation, preallocated_bytes=10, lite_home_bytes=110, required_inodes=4000
        ) == {
            "freeBytesNow": 1001,
            "preallocatedBytes": 10,
            "freeBytesBeforeStaging": 1011,
            "requiredBytes": 1010,
            "headroomBytes": 1,
            "liteHomeAllocatedBytes": 110,
            "contractedLiteHomeBytes": 100,
            "freeInodes": 5000,
            "requiredInodes": 4000,
        }
    finally:
        MODULE.shutil.disk_usage = original
        MODULE.os.statvfs = original_statvfs


def test_snapshot_capacity_accounts_for_sparse_logical_bytes(tmp_path: Path) -> None:
    sparse = tmp_path / "sparse"
    with sparse.open("wb") as handle:
        handle.truncate(16 * 1024 * 1024)
    assert MODULE.snapshot_capacity_bytes(tmp_path) >= sparse.stat().st_size + 1024 * 1024


def test_snapshot_validator_rejects_hardlinks(tmp_path: Path) -> None:
    archive = tmp_path / "bad.tar.gz"
    with tarfile.open(archive, "w:gz") as output:
        root = tarfile.TarInfo("lite")
        root.type = tarfile.DIRTYPE
        output.addfile(root)
        target = tarfile.TarInfo("lite/file")
        target.size = 1
        output.addfile(target, io.BytesIO(b"x"))
        link = tarfile.TarInfo("lite/link")
        link.type = tarfile.LNKTYPE
        link.linkname = "lite/file"
        output.addfile(link)
    with pytest.raises(MODULE.ReleaseError, match="unsupported"):
        MODULE.validate_snapshot_archive(archive)


def _install_transaction_fixture(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    repo = tmp_path / "repo"
    lite_home = tmp_path / "home/lite"
    profile_home = lite_home / "profiles/ran-assistant-lite"
    cron_home = lite_home / "cron"
    systemd = tmp_path / "systemd"
    runtime_root = tmp_path / "runtimes"
    snapshot_root = tmp_path / "snapshots"
    release_root = tmp_path / "release"
    for directory in (repo / ".venv/bin", profile_home, cron_home, systemd, runtime_root, snapshot_root, release_root):
        directory.mkdir(parents=True, exist_ok=True)
    snapshot_root.chmod(0o700)
    (lite_home / "config.yaml").write_text("old-config\n")
    (profile_home / "config.yaml").write_text("old-profile\n")
    (cron_home / "jobs.json").write_text('{"jobs": []}\n')
    lite_unit = systemd / "ran-agent-hermes.service"
    full_unit = systemd / "ran-agent-hermes-full.service"
    lite_unit.write_text("old-lite-unit\n")
    full_unit.write_text("old-full-unit\n")
    env_files = (repo / ".env.local", repo / "node_bridge/.env.local")
    env_files[1].parent.mkdir()
    for env_file in env_files:
        env_file.write_text("SECRET=keep\nHERMES_PROFILE=old\n")
    legacy = (repo / ".venv/bin/hermes", repo / ".venv/bin/python")
    for path in legacy:
        path.write_text("legacy\n")

    builder_bytes = (Path(__file__).parents[1] / "scripts/build-hermes-runtime-artifact.py").read_bytes()
    module_dir = tmp_path / "builder-module"
    module_dir.mkdir()
    builder = MODULE.load_builder(builder_bytes, module_dir)
    source = tmp_path / "hermes-runtime"
    (source / "python/bin").mkdir(parents=True)
    (source / "bin").mkdir()
    python = source / "python/bin/python3.12"
    python.write_text("python")
    python.chmod(0o755)
    (source / "bin/hermes").write_text("hermes")
    artifact = tmp_path / "runtime.tar.gz"
    builder.deterministic_archive(source, artifact)
    profile = b"new-profile\n"
    unit = b"new-unit\n"
    values = {
        "HERMES_API_BASE_URL": "http://127.0.0.1:8642/v1",
        "HERMES_LITE_API_BASE_URL": "http://127.0.0.1:8642/v1",
        "HERMES_FULL_API_BASE_URL": "http://127.0.0.1:8642/v1",
        "CO_READING_HERMES_API_BASE_URL": "http://127.0.0.1:8642/v1",
        "HERMES_PROFILE": "ran-assistant-lite",
        "HERMES_LITE_PROFILE": "ran-assistant-lite",
        "HERMES_FULL_PROFILE": "ran-assistant-lite",
    }
    install_root = runtime_root / "candidate"
    context = {
        "builder": builder_bytes,
        "manifest": {
            "artifact": {
                "archiveRoot": "hermes-runtime",
                "treeSha256": builder.tree_digest(source),
                "tarGzSha256": MODULE.sha256_file(artifact),
            },
            "python": {"executableSha256": MODULE.sha256_file(python)},
        },
        "profile": profile,
        "unit": unit,
        "mutation": {"envMutations": [{"values": values}]},
        "installRoot": install_root,
        "productionHead": "a" * 40,
        "legacyRuntime": {str(path): MODULE.sha256_file(path) for path in legacy},
    }

    monkeypatch.setattr(MODULE, "REPO", repo)
    monkeypatch.setattr(MODULE, "LITE_HOME", lite_home)
    monkeypatch.setattr(MODULE, "LITE_UNIT", lite_unit)
    monkeypatch.setattr(MODULE, "FULL_UNIT", full_unit)
    monkeypatch.setattr(MODULE, "FULL_BLOCK_DROPIN", systemd / "ran-agent-hermes-full.service.d/99-unified-topology.conf")
    monkeypatch.setattr(MODULE, "ENV_FILES", env_files)
    monkeypatch.setattr(MODULE, "RUNTIME_ROOT", runtime_root)
    monkeypatch.setattr(MODULE, "SNAPSHOT_ROOT", snapshot_root)
    monkeypatch.setattr(MODULE, "TOPOLOGY_MARKER", release_root / "runtime-topology.v1.json")
    monkeypatch.setattr(MODULE, "require_private_root", lambda _path: None)
    monkeypatch.setattr(MODULE, "require_private_runtime_root", lambda: None)
    monkeypatch.setattr(MODULE, "stop_for_snapshot", lambda: None)
    monkeypatch.setattr(MODULE, "service_state", lambda _unit: {"active": "active", "enabled": "enabled", "load": "loaded"})
    monkeypatch.setattr(MODULE, "restore_service_states", lambda _state: None)
    monkeypatch.setattr(MODULE, "run", lambda *args, **kwargs: subprocess.CompletedProcess(args[0], 0, "", ""))
    monkeypatch.setattr(
        MODULE,
        "git",
        lambda _repo, *args, **kwargs: subprocess.CompletedProcess(
            args, 0, ("a" * 40 + "\n") if args[:2] == ("rev-parse", "HEAD") else "", ""
        ),
    )
    monkeypatch.setattr(MODULE, "pwd", SimpleNamespace(getpwnam=lambda _name: SimpleNamespace(pw_uid=os.getuid())))
    monkeypatch.setattr(MODULE, "grp", SimpleNamespace(getgrnam=lambda _name: SimpleNamespace(gr_gid=os.getgid())))
    monkeypatch.setattr(MODULE.os, "chown", lambda *args, **kwargs: None)
    monkeypatch.setattr(MODULE, "port_open", lambda port: port == 8642)
    monkeypatch.setattr(MODULE, "validate_gateway_process", lambda _context: {})
    monkeypatch.setattr(MODULE, "wait_for_gateway_process", lambda _context: {})
    monkeypatch.setattr(MODULE, "wait_for_gateway", lambda *args, **kwargs: None)
    monkeypatch.setattr(MODULE, "validate_installed_runtime", lambda _context: {})
    monkeypatch.setattr(MODULE, "validate_node_routes", lambda: None)
    return context, artifact, lite_home, lite_unit, env_files


def test_staged_apply_and_explicit_rollback_restore_files(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    context, artifact, lite_home, lite_unit, env_files = _install_transaction_fixture(monkeypatch, tmp_path)
    snapshot = MODULE.apply("a" * 40, artifact, context)
    assert json.loads((snapshot / "state.json").read_text())["phase"] == "accepted"
    assert (lite_home / "config.yaml").read_bytes() == context["profile"]
    assert lite_unit.read_bytes() == context["unit"]
    MODULE.rollback(snapshot, "a" * 40)
    assert (lite_home / "config.yaml").read_text() == "old-config\n"
    assert lite_unit.read_text() == "old-lite-unit\n"
    assert env_files[0].read_text() == "SECRET=keep\nHERMES_PROFILE=old\n"
    assert context["installRoot"].is_dir()
    MODULE.rollback(snapshot, "a" * 40)
    assert context["installRoot"].is_dir()


def test_apply_failure_rolls_back_before_return(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    context, artifact, lite_home, _lite_unit, env_files = _install_transaction_fixture(monkeypatch, tmp_path)
    monkeypatch.setattr(MODULE, "install_unit", lambda _unit: (_ for _ in ()).throw(MODULE.ReleaseError("fault")))
    with pytest.raises(MODULE.ReleaseError, match="fault"):
        MODULE.apply("a" * 40, artifact, context)
    assert (lite_home / "config.yaml").read_text() == "old-config\n"
    assert env_files[0].read_text() == "SECRET=keep\nHERMES_PROFILE=old\n"


def test_full_release_fails_closed_after_unified_marker() -> None:
    controller = (Path(__file__).parents[1] / "scripts/deploy-hermes-release.sh").read_text()
    assert "unified_runtime_requires_topology_aware_release" in controller
    assert "unfinished_unified_runtime_transaction" in controller
    split = (Path(__file__).parents[1] / "scripts/apply-hermes-runtime-split.sh").read_text()
    assert "unified Hermes topology is active; lite/full repair is retired" in split
    cleanup = (Path(__file__).parents[1] / "scripts/clean-uv-cache-safe.sh").read_text()
    marker_branch = cleanup.split('if [ -e /opt/ran_agent-release/runtime-topology.v1.json ]; then', 1)[1]
    assert "ran-agent-hermes-full.service" not in marker_branch.split("else", 1)[0]


def test_production_standalone_split_is_retired() -> None:
    script = Path(__file__).parents[1] / "scripts/apply-hermes-runtime-split.sh"
    result = subprocess.run(
        ["bash", str(script)],
        env={"PATH": "/usr/bin:/bin", "RAN_AGENT_REPO_ROOT": "/opt/ran_agent"},
        capture_output=True,
        text=True,
    )
    assert result.returncode != 0
    assert "standalone lite/full repair is retired" in result.stderr
    bypass = subprocess.run(
        ["bash", str(script)],
        env={"PATH": "/usr/bin:/bin", "RAN_AGENT_REPO_ROOT": "/tmp/fake-candidate"},
        capture_output=True,
        text=True,
    )
    assert bypass.returncode != 0
    assert "canonical production targets require an immutable staged release" in bypass.stderr


def test_full_block_rejects_symlink_dropin_directory(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    real = tmp_path / "real"
    real.mkdir()
    link = tmp_path / "dropins"
    link.symlink_to(real, target_is_directory=True)
    monkeypatch.setattr(MODULE, "FULL_BLOCK_DROPIN", link / "99-unified-topology.conf")
    with pytest.raises(MODULE.ReleaseError, match="drop-in path is unsafe"):
        MODULE.install_full_block()


def test_backup_fsyncs_parent_before_return(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.write_text("value")
    snapshot = tmp_path / "snapshot"
    snapshot.mkdir()
    events: list[str] = []
    monkeypatch.setattr(MODULE, "fsync_tree", lambda _path: events.append("tree"))
    monkeypatch.setattr(MODULE, "fsync_directory", lambda _path: events.append("parent"))
    MODULE.backup_path(snapshot, source, 0)
    assert events == ["tree", "parent"]


def test_transaction_fsyncs_roots_before_terminal_state(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    context, artifact, lite_home, _lite_unit, _env_files = _install_transaction_fixture(monkeypatch, tmp_path)
    events: list[str] = []
    original_tree = MODULE.fsync_tree
    original_directory = MODULE.fsync_directory
    original_update = MODULE.update_phase

    def record_tree(path: Path) -> None:
        events.append(f"tree:{path}")
        original_tree(path)

    def record_directory(path: Path) -> None:
        events.append(f"directory:{path}")
        original_directory(path)

    def record_phase(snapshot: Path, state: dict, phase: str) -> None:
        events.append(f"phase:{phase}")
        original_update(snapshot, state, phase)

    monkeypatch.setattr(MODULE, "fsync_tree", record_tree)
    monkeypatch.setattr(MODULE, "fsync_directory", record_directory)
    monkeypatch.setattr(MODULE, "update_phase", record_phase)
    snapshot = MODULE.apply("a" * 40, artifact, context)
    assert events.index(f"directory:{MODULE.SNAPSHOT_ROOT}") < events.index("phase:accepted")
    assert events.index(f"tree:{context['installRoot']}") < events.index("phase:accepted")
    MODULE.rollback(snapshot, "a" * 40)
    assert events.index(f"tree:{lite_home}") < events.index("phase:rolled-back")


def test_release_candidate_status_is_exact() -> None:
    MODULE.require_release_candidate_status("RELEASE_CANDIDATE_READY_FOR_RUNTIME_APPLY")
    for rejected in ("RELEASE_CANDIDATE_REJECTED", "RELEASE_CANDIDATE_NOT_AUTHORIZED", None):
        with pytest.raises(MODULE.ReleaseError, match="not a release-candidate"):
            MODULE.require_release_candidate_status(rejected)


def test_candidate_controller_binding_rejects_a_floating_rollback_controller(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(MODULE, "check_candidate", lambda *_: None)
    monkeypatch.setattr(MODULE, "candidate_blob", lambda *_: b"different-controller")
    with pytest.raises(MODULE.ReleaseError, match="running controller is not the candidate controller"):
        MODULE.validate_candidate_controller(Path("/fixture"), "a" * 40)

    source = SCRIPT.read_text(encoding="utf-8")
    assert source.index("validate_candidate_controller(REPO, args.candidate)") < source.index(
        'if args.mode == "rollback":'
    )


def test_candidate_requires_a_persistent_rollback_ref(monkeypatch: pytest.MonkeyPatch) -> None:
    candidate = "a" * 40

    def fake_git(_repo: Path, *args: str, **_kwargs: object) -> subprocess.CompletedProcess:
        if args[:2] == ("rev-parse", "--verify") and args[2] == f"{candidate}^{{commit}}":
            return subprocess.CompletedProcess(args, 0, f"{candidate}\n", "")
        if args[:2] == ("rev-parse", "--verify"):
            raise subprocess.CalledProcessError(1, args)
        return subprocess.CompletedProcess(args, 0, "", "")

    monkeypatch.setattr(MODULE, "git", fake_git)
    with pytest.raises(MODULE.ReleaseError, match="persistent runtime candidate ref is absent"):
        MODULE.check_candidate(Path("/fixture"), candidate)


def test_preflight_does_not_overwrite_the_candidate_unit_payload() -> None:
    source = SCRIPT.read_text(encoding="utf-8")
    assert "for unit, state_value in all_service_states.items()" not in source
    assert "for service_unit, state_value in all_service_states.items()" in source
    assert "candidate runtime payload type was corrupted during preflight" in source


def test_gateway_readiness_covers_hermes_mcp_discovery_ceiling() -> None:
    assert MODULE.GATEWAY_READINESS_ATTEMPTS * 0.5 >= 150


def test_gateway_process_waits_for_same_pid_exec_transition(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    expected = tmp_path / "runtime/python/bin/python3.12"
    expected.parent.mkdir(parents=True)
    expected.write_bytes(b"python")
    executables = iter((Path("/usr/bin/dash"), expected))
    monkeypatch.setattr(MODULE, "service_main_pid", lambda _unit: 123)
    monkeypatch.setattr(MODULE, "process_executable", lambda _pid: next(executables))
    monkeypatch.setattr(
        MODULE,
        "validate_gateway_process",
        lambda _context, *, expected_pid=None: {"pid": str(expected_pid)},
    )
    monkeypatch.setattr(MODULE.time, "sleep", lambda _seconds: None)

    assert MODULE.wait_for_gateway_process({"installRoot": tmp_path / "runtime"}) == {"pid": "123"}


def test_gateway_process_settle_timeout_reports_last_executable(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    clock = iter((0.0, 11.0))
    monkeypatch.setattr(MODULE, "service_main_pid", lambda _unit: 123)
    monkeypatch.setattr(MODULE, "process_executable", lambda _pid: Path("/usr/bin/dash"))
    monkeypatch.setattr(MODULE.time, "monotonic", lambda: next(clock))
    monkeypatch.setattr(MODULE.time, "sleep", lambda _seconds: None)

    with pytest.raises(MODULE.ReleaseError, match=r"pid=123 exe=/usr/bin/dash"):
        MODULE.wait_for_gateway_process({"installRoot": tmp_path / "runtime"})


def test_gateway_process_settle_rejects_main_pid_change(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    pids = iter((123, 456))
    monkeypatch.setattr(MODULE, "service_main_pid", lambda _unit: next(pids))

    with pytest.raises(MODULE.ReleaseError, match="MainPID changed"):
        MODULE.wait_for_gateway_process({"installRoot": tmp_path / "runtime"})


def test_privileged_replace_rejects_symlink_target(tmp_path: Path) -> None:
    target = tmp_path / "target"
    target.write_text("keep")
    link = tmp_path / "link"
    link.symlink_to(target)
    with pytest.raises(MODULE.ReleaseError, match="not a regular file"):
        MODULE.atomic_write_existing(link, b"replace", mode=0o600, uid=os.getuid(), gid=os.getgid())
    assert target.read_text() == "keep"


def test_listener_must_belong_to_expected_main_pid(monkeypatch: pytest.MonkeyPatch) -> None:
    output = 'LISTEN 0 128 127.0.0.1:8642 0.0.0.0:* users:(("python",pid=123,fd=4))\n'
    monkeypatch.setattr(
        MODULE,
        "run",
        lambda *args, **kwargs: subprocess.CompletedProcess(args[0], 0, output, ""),
    )
    MODULE.validate_listener_topology(123)
    with pytest.raises(MODULE.ReleaseError, match="listener topology"):
        MODULE.validate_listener_topology(456)


def test_corrupt_rollback_archive_fails_before_service_mutation(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    context, artifact, _lite_home, _lite_unit, _env_files = _install_transaction_fixture(monkeypatch, tmp_path)
    snapshot = MODULE.apply("a" * 40, artifact, context)
    archive = snapshot / "lite-home.tar.gz"
    archive.write_bytes(archive.read_bytes() + b"corrupt")
    calls: list[list[str]] = []
    monkeypatch.setattr(
        MODULE,
        "run",
        lambda command, **kwargs: calls.append(command) or subprocess.CompletedProcess(command, 0, "", ""),
    )
    with pytest.raises(MODULE.ReleaseError, match="archive digest mismatch"):
        MODULE.rollback(snapshot, "a" * 40)
    assert calls == []


def test_corrupt_file_backup_fails_before_service_mutation(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    context, artifact, _lite_home, _lite_unit, _env_files = _install_transaction_fixture(monkeypatch, tmp_path)
    snapshot = MODULE.apply("a" * 40, artifact, context)
    backup = snapshot / "files/0"
    backup.write_bytes(backup.read_bytes() + b"corrupt")
    calls: list[list[str]] = []
    monkeypatch.setattr(
        MODULE,
        "run",
        lambda command, **kwargs: calls.append(command) or subprocess.CompletedProcess(command, 0, "", ""),
    )
    with pytest.raises(MODULE.ReleaseError, match="backup integrity mismatch"):
        MODULE.rollback(snapshot, "a" * 40)
    assert calls == []


def test_restore_starts_timer_only_after_gateways_and_node(monkeypatch: pytest.MonkeyPatch) -> None:
    events: list[str] = []
    state = {
        "services": {
            unit: {"active": "active", "enabled": "enabled", "load": "loaded"}
            for unit in MODULE.SERVICES
        }
    }
    monkeypatch.setattr(
        MODULE,
        "run",
        lambda command, **kwargs: events.append("run:" + ":".join(command))
        or subprocess.CompletedProcess(command, 0, "", ""),
    )
    monkeypatch.setattr(MODULE, "set_enabled", lambda unit, _state: events.append("enable:" + unit))
    monkeypatch.setattr(MODULE, "process_environment", lambda _unit: {})
    monkeypatch.setattr(MODULE, "wait_for_gateway", lambda port, *_args: events.append(f"ready:{port}"))
    monkeypatch.setattr(MODULE, "service_state", lambda unit: state["services"][unit])
    MODULE.restore_service_states(state)
    node = events.index("run:systemctl:start:ran-agent-node.service")
    timer = events.index("run:systemctl:start:ran-agent-hermes-lite-soft-reset.timer")
    assert events.index("ready:8642") < node
    assert events.index("ready:8643") < node
    assert node < timer
