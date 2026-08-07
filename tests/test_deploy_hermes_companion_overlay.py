from __future__ import annotations

import importlib.util
import json
from types import SimpleNamespace
from unittest.mock import patch
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / "scripts/deploy-hermes-companion-overlay.py"
SPEC = importlib.util.spec_from_file_location("deploy_hermes_companion_overlay", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def test_overlay_digest_and_dropin_are_stable(tmp_path: Path) -> None:
    files = {path: path.encode() for path in MODULE.CANDIDATE_PATHS}
    assert MODULE.overlay_digest(files) == MODULE.overlay_digest(dict(reversed(files.items())))

    root = tmp_path / "overlay"
    dropin = MODULE.render_dropin(root).decode()
    lines = dropin.splitlines()
    assert lines[:2] == ["[Service]", "BindReadOnlyPaths="]
    assert len(lines) == len(MODULE.OVERLAY_PATHS) + len(MODULE.PROFILE_DESTINATIONS) + 3
    assert "UnsetEnvironment=OBSIDIAN_MEMORY_MCP_ENABLED" in lines
    for relative in MODULE.OVERLAY_PATHS:
        assert f"BindReadOnlyPaths={root / relative}:/opt/ran_agent/{relative}" in lines
    for destination in MODULE.PROFILE_DESTINATIONS:
        assert f"BindReadOnlyPaths={root / MODULE.PROFILE_SOURCE}:{destination}" in lines
    assert f"BindReadOnlyPaths={root / MODULE.PYTHON_SOURCE}:/opt/ran_agent/{MODULE.PYTHON_SOURCE}" in MODULE.render_python_dropin(root).decode()


def test_overlay_revision_is_content_addressed_and_read_only(tmp_path: Path) -> None:
    files = {path: f"payload:{path}".encode() for path in MODULE.CANDIDATE_PATHS}
    root = tmp_path / "overlay"
    tmp_path.chmod(0o755)
    original_runtime_root = MODULE.RUNTIME_ROOT
    MODULE.RUNTIME_ROOT = tmp_path
    try:
        MODULE.build_overlay(root, files)
        MODULE.build_overlay(root, files)
    finally:
        MODULE.RUNTIME_ROOT = original_runtime_root

    for relative, value in files.items():
        target = root / relative
        assert target.read_bytes() == value
        assert target.stat().st_mode & 0o222 == 0


def test_manifest_changes_personal_memory_and_profile_and_stale_rollback_fails() -> None:
    manifest = json.loads((SCRIPT.parents[1] / "docs/governance/hermes_companion_overlay.v1.json").read_text())
    assert manifest["runtime"]["process"]["argv"][2:4] == ["-m", "hermes_cli.main"]
    previous = MODULE.manifest_files(manifest, "previousOverlay")
    candidate = MODULE.manifest_files(manifest, "candidateOverlay")
    assert [path for path in MODULE.OVERLAY_PATHS if previous[path] != candidate[path]] == [
        "node_bridge/src/personalMemoryMcpServer.mjs"
    ]
    assert MODULE.manifest_profile(manifest, "previousProfile") != MODULE.manifest_profile(manifest, "candidateProfile")
    assert MODULE.manifest_python(manifest, "previousPython") != MODULE.manifest_python(manifest, "candidatePython")

    state = {
        "status": "accepted",
        "applied_dropin_sha256": "dropin-v1",
        "applied_python_dropin_sha256": "python-dropin-v1",
        "candidate_namespace_digests": candidate,
        "candidate_profile_digests": {destination: "profile-v1" for destination in MODULE.PROFILE_DESTINATIONS},
        "candidate_python_digest": "python-v1",
    }
    MODULE.require_current_transaction(state, "dropin-v1", "python-dropin-v1", candidate)
    MODULE.require_current_transaction(state, "dropin-v1", "python-dropin-v1", None)
    try:
        MODULE.require_current_transaction(state, "dropin-v2", "python-dropin-v1", candidate)
    except MODULE.OverlayError:
        pass
    else:
        raise AssertionError("stale rollback must fail")

    activating = {
        "status": "activating",
        "previous_namespace_digests": previous,
        "candidate_namespace_digests": candidate,
        "previous_profile_digests": {destination: "old" for destination in MODULE.PROFILE_DESTINATIONS},
        "candidate_profile_digests": {destination: "new" for destination in MODULE.PROFILE_DESTINATIONS},
        "previous_python_digest": "old-python",
        "candidate_python_digest": "new-python",
    }
    MODULE.require_current_transaction(activating, None, None, None)


def test_accepted_state_write_failure_triggers_rollback(tmp_path: Path) -> None:
    files = {path: path.encode() for path in MODULE.CANDIDATE_PATHS}
    context = {
        "repo": tmp_path,
        "manifest": {},
        "node_bin": Path("/bin/true"),
        "files": files,
        "digest": MODULE.overlay_digest(files),
        "root": tmp_path / "overlay",
        "baseline": {},
        "previous_digests": {path: "old" for path in MODULE.OVERLAY_PATHS},
        "previous_profile_digests": {destination: "old" for destination in MODULE.PROFILE_DESTINATIONS},
        "previous_python_digest": "old-python",
        "required_head": "2" * 40,
    }
    statuses = []
    rolled_back = []

    def write_state(_path, value):
        statuses.append(value["status"])
        if value["status"] == "accepted":
            raise OSError("simulated durable-state failure")

    with (
        patch.object(MODULE, "TRANSACTION_ROOT", tmp_path / "transactions"),
        patch.object(MODULE, "DROPIN", tmp_path / "30-companion-overlay.conf"),
        patch.object(MODULE, "PYTHON_DROPIN", tmp_path / "30-personal-memory-overlay.conf"),
        patch.object(MODULE, "preflight", return_value=context),
        patch.object(MODULE, "service_active", return_value=True),
        patch.object(MODULE, "build_overlay"),
        patch.object(MODULE, "stop_services"),
        patch.object(MODULE, "start_services"),
        patch.object(MODULE, "atomic_write"),
        patch.object(MODULE, "verify_overlay", return_value={"hermes_pid": 1, "digests": {}}),
        patch.object(MODULE, "write_json", side_effect=write_state),
        patch.object(MODULE, "rollback", side_effect=lambda *_args: rolled_back.append(True)),
    ):
        try:
            MODULE.apply(SimpleNamespace(candidate="1" * 40))
        except OSError as error:
            assert "durable-state" in str(error)
        else:
            raise AssertionError("accepted state write failure must propagate")

    assert statuses == ["prepared", "activating", "accepted"]
    assert rolled_back == [True]


def test_capacity_keeps_the_existing_15_gib_floor() -> None:
    enough = SimpleNamespace(
        f_bavail=MODULE.MIN_FREE_BYTES + 2 * 1024 * 1024,
        f_frsize=1,
        f_favail=1000,
    )
    low = SimpleNamespace(f_bavail=MODULE.MIN_FREE_BYTES, f_frsize=1, f_favail=1000)
    with patch.object(MODULE.os, "statvfs", return_value=enough):
        MODULE.require_capacity({"one": b"x"})
    with patch.object(MODULE.os, "statvfs", return_value=low):
        try:
            MODULE.require_capacity({"one": b"x"})
        except MODULE.OverlayError:
            pass
        else:
            raise AssertionError("capacity below the floor must fail")
