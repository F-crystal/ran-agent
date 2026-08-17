from __future__ import annotations

import importlib.util
import contextlib
import io
import json
import os
import sqlite3
import subprocess
import sys
import tarfile
from pathlib import Path
from types import SimpleNamespace

import pytest


SCRIPT = Path(__file__).parents[1] / "scripts/deploy-hermes-runtime-release.py"
SPEC = importlib.util.spec_from_file_location("hermes_runtime_release", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


@pytest.fixture(autouse=True)
def _local_sealed_profile_parser(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(MODULE, "SOURCE_RUNTIME_PYTHON", Path(sys.executable).resolve())
    monkeypatch.setattr(MODULE.pwd, "getpwnam", lambda _name: SimpleNamespace(
        pw_uid=os.getuid(), pw_gid=os.getgid(),
    ))


def wake_blobs(lite_home: Path, profile_dir: Path, payload: bytes = b"#!/bin/sh\nexit 0\n") -> dict[str, bytes]:
    manifest = {
        "schemaVersion": 1,
        "status": "CURRENT",
        "runtime": {
            "provider": "hermes-cron",
            "home": str(lite_home),
            "profile": MODULE.SOURCE_PROFILE,
            "scriptTimeoutSeconds": 30,
        },
        "job": {
            "name": "ran-agent-core-wake",
            "schedule": "every 1m",
            "repeat": "forever",
            "script": "core-wake.sh",
            "scriptSource": MODULE.SOURCE_WAKE_SCRIPT_SOURCE,
            "scriptTarget": str(profile_dir / "scripts/core-wake.sh"),
            "workdir": "/opt/ran_agent",
            "no_agent": True,
            "deliver": "local",
            "enabled": False,
            "state": "paused",
            "pauseReason": "awaiting-owner-s12-production-authorization",
        },
    }
    return {
        MODULE.SOURCE_MANAGED_WAKE_PATH: json.dumps(manifest).encode(),
        MODULE.SOURCE_WAKE_SCRIPT_SOURCE: payload,
    }


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


def test_source_env_patch_removes_split_and_retired_memory_keys() -> None:
    original = (
        b"SECRET=keep\n"
        b"HERMES_FULL_API_BASE_URL=http://127.0.0.1:8643/v1\n"
        b"HERMES_LITE_PROFILE=ran-assistant-lite\n"
        b"RAN_AGENT_CAPABILITY_MODE=auto\n"
        b"OMBRE_RECALL_MCP_URL=http://127.0.0.1:18002/mcp\n"
        b"OMBRE_COMPAT_ENABLED=false\n"
        b"RAN_AGENT_STEWARD_TOKEN_FILE=/private/token\n"
        b"OBSIDIAN_MEMORY_MCP_ENABLED=false\n"
        b"PERSONAL_MEMORY_BACKEND_TIMEOUT_MS=5000\n"
        b"AI_DAILY_DIGEST_ENABLED=true\n"
    )
    patched = MODULE.patch_source_env_bytes(original)
    assert patched == (
        b"SECRET=keep\n"
        b"HERMES_API_BASE_URL=http://127.0.0.1:8642/v1\n"
        b"HERMES_PROFILE=ran-agent-companion\n"
        b"CO_READING_HERMES_API_BASE_URL=http://127.0.0.1:8642/v1\n"
        b"AI_DAILY_DIGEST_ENABLED=false\n"
    )


def test_source_projection_reuses_publisher_and_requires_existing_runtime_boundary(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    repo = tmp_path / "repo"
    projection = repo / ".ran_agent_state/hermes/published-memory-context.json"
    core_db = repo / ".ran_agent_state/core/core-state.sqlite3"
    projection.parent.mkdir(parents=True, mode=0o700)
    core_db.parent.mkdir(parents=True)
    core_db.write_bytes(b"sqlite")
    projection.parent.chmod(0o700)
    core_db.chmod(0o600)
    identity = SimpleNamespace(pw_uid=os.getuid())
    group = SimpleNamespace(gr_gid=os.getgid())
    calls: list[list[str]] = []
    monkeypatch.setattr(MODULE, "REPO", repo)
    monkeypatch.setattr(MODULE, "CORE_DB", core_db)
    monkeypatch.setattr(MODULE, "SOURCE_PROJECTION", projection)
    monkeypatch.setattr(MODULE.pwd, "getpwnam", lambda _name: identity)
    monkeypatch.setattr(MODULE.grp, "getgrnam", lambda _name: group)
    monkeypatch.setattr(MODULE, "run", lambda command, **_kwargs: calls.append(command))

    MODULE.publish_source_projection()
    assert len(calls) == 2
    assert calls[0][-3:] == [str(core_db), str(projection), str(repo)]
    assert calls[1][-5:] == ["verify-runtime", str(projection), str(repo), str(os.getuid()), str(os.getgid())]

    projection.parent.chmod(0o775)
    with pytest.raises(MODULE.ReleaseError, match="projection runtime boundary is invalid"):
        MODULE.publish_source_projection()


def test_current_source_pointer_is_the_sole_acceptance_authority(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    snapshot_root = tmp_path / "source-snapshots"
    artifact_root = tmp_path / "source-artifacts"
    snapshot = snapshot_root / "source-old"
    controller = artifact_root / f"deploy-hermes-source-{'a' * 40}.py"
    snapshot.mkdir(parents=True)
    artifact_root.mkdir()
    candidate = "a" * 40
    (snapshot / "state.json").write_text(json.dumps({
        "candidate": candidate, "phase": "accepted", "controller": str(controller),
    }))
    controller.write_text("controller")
    pointer_path = snapshot_root / "current-source.json"
    pointer = {
        "schemaVersion": 1,
        "candidate": candidate,
        "snapshot": str(snapshot),
        "controller": str(controller),
    }
    pointer_path.write_text(json.dumps(pointer))
    monkeypatch.setattr(MODULE, "SOURCE_SNAPSHOT_ROOT", snapshot_root)
    monkeypatch.setattr(MODULE, "SOURCE_ARTIFACT_ROOT", artifact_root)
    monkeypatch.setattr(MODULE, "SOURCE_POINTER", pointer_path)

    assert MODULE.current_source_pointer() == pointer
    pointer_path.unlink()
    assert MODULE.current_source_pointer() is None


def test_source_advance_rejects_private_or_migrating_paths() -> None:
    MODULE.validate_source_advance_paths([".env.example", "node_bridge/src/replyBackend.mjs", "README.md"])
    with pytest.raises(MODULE.ReleaseError, match="profile change requiring a dedicated migration"):
        MODULE.validate_source_advance_paths(["hermes/profile/config.yaml"])
    for path in (".env.local", "data/private.db", "migrations/999.sql", "vault/raw/item"):
        with pytest.raises(MODULE.ReleaseError, match="source advance contains"):
            MODULE.validate_source_advance_paths([path])


def _source_profile_blobs() -> dict[str, bytes]:
    root = Path(__file__).parents[1]
    return {
        MODULE.PROFILE_PATH: (root / MODULE.PROFILE_PATH).read_bytes(),
        MODULE.SOURCE_PROFILE_MIGRATION_PATH: (root / MODULE.SOURCE_PROFILE_MIGRATION_PATH).read_bytes(),
        MODULE.SOURCE_MANAGED_WAKE_PATH: (root / MODULE.SOURCE_MANAGED_WAKE_PATH).read_bytes(),
    }


def _source_profile_prior() -> str:
    return json.loads(_source_profile_blobs()[MODULE.SOURCE_PROFILE_MIGRATION_PATH])["priorAcceptedSource"]


def test_source_profile_migration_requires_and_accepts_only_the_exact_contract(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    prior = _source_profile_prior()
    candidate = "b" * 40
    changed = [
        MODULE.PROFILE_PATH,
        "hermes/profile/scripts/core-wake.sh",
    ]
    with pytest.raises(MODULE.ReleaseError, match="missing or invalid"):
        monkeypatch.setattr(
            MODULE,
            "candidate_blob",
            lambda _repo, _candidate, _path: (_ for _ in ()).throw(subprocess.CalledProcessError(1, [])),
        )
        MODULE.validate_source_advance_paths(changed, candidate=candidate, prior=prior)

    blobs = _source_profile_blobs()
    monkeypatch.setattr(MODULE, "candidate_blob", lambda _repo, _candidate, path: blobs[path])
    MODULE.validate_source_advance_paths(changed, candidate=candidate, prior=prior)


@pytest.mark.parametrize("mutation", ("prior", "digest"))
def test_source_profile_migration_rejects_wrong_authority(
    monkeypatch: pytest.MonkeyPatch, mutation: str
) -> None:
    prior = _source_profile_prior()
    blobs = _source_profile_blobs()
    contract = json.loads(blobs[MODULE.SOURCE_PROFILE_MIGRATION_PATH])
    if mutation == "prior":
        contract["priorAcceptedSource"] = "0" * 40
    else:
        contract["activeProfile"]["sourceSha256"] = "0" * 64
    blobs[MODULE.SOURCE_PROFILE_MIGRATION_PATH] = json.dumps(contract).encode()
    monkeypatch.setattr(MODULE, "candidate_blob", lambda _repo, _candidate, path: blobs[path])
    with pytest.raises(MODULE.ReleaseError, match="does not match"):
        MODULE.validate_source_advance_paths(
            [MODULE.PROFILE_PATH],
            candidate="b" * 40,
            prior=prior,
        )


def test_source_profile_migration_rejects_an_unexpected_profile_path(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    blobs = _source_profile_blobs()
    monkeypatch.setattr(MODULE, "candidate_blob", lambda _repo, _candidate, path: blobs[path])
    with pytest.raises(MODULE.ReleaseError, match="does not match"):
        MODULE.validate_source_advance_paths(
            [
                MODULE.PROFILE_PATH,
                "hermes/profile/unexpected.yaml",
            ],
            candidate="b" * 40,
            prior=_source_profile_prior(),
        )


def test_source_advance_wake_script_only_passes_without_profile_migration(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    wake = (Path(__file__).parents[1] / MODULE.SOURCE_MANAGED_WAKE_PATH).read_bytes()

    def candidate_blob(_repo: Path, _candidate: str, path: str) -> bytes:
        if path == MODULE.SOURCE_PROFILE_MIGRATION_PATH:
            pytest.fail("wake-only source advance consulted profile migration")
        assert path == MODULE.SOURCE_MANAGED_WAKE_PATH
        return wake

    monkeypatch.setattr(MODULE, "candidate_blob", candidate_blob)
    MODULE.validate_source_advance_paths(
        ["hermes/profile/scripts/core-wake.sh"],
        candidate="b" * 40,
        prior="e0e4769e76e48fb5832e028e06300ecb691665f5",
    )


def test_source_advance_wake_script_only_rejects_a_malformed_wake_contract(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    blobs = _source_profile_blobs()
    wake = json.loads(blobs[MODULE.SOURCE_MANAGED_WAKE_PATH])
    wake["job"]["name"] = "unrelated-cron"
    blobs[MODULE.SOURCE_MANAGED_WAKE_PATH] = json.dumps(wake).encode()
    monkeypatch.setattr(MODULE, "candidate_blob", lambda _repo, _candidate, path: blobs[path])
    with pytest.raises(MODULE.ReleaseError, match="managed Core wake source contract is invalid"):
        MODULE.validate_source_advance_paths(
            ["hermes/profile/scripts/core-wake.sh"],
            candidate="b" * 40,
            prior="e0e4769e76e48fb5832e028e06300ecb691665f5",
        )


def test_companion_profile_validation_uses_yaml_semantics() -> None:
    profile = (Path(__file__).parents[1] / MODULE.PROFILE_PATH).read_bytes()
    MODULE.validate_companion_profile(profile)
    for malicious in (
        profile.replace(b"    - mcp-search_hub\n", b"    - mcp-search_hub\n    - \"web\"\n", 1),
        b"""
platform_toolsets:
  cli: &tools
    - mcp-search_hub
    - web
  api_server: *tools
mcp_servers:
  search_hub: {}
""",
        profile + b"\n\"web\": {}\n",
    ):
        with pytest.raises(MODULE.ReleaseError, match="R1B assembly invariant"):
            MODULE.validate_companion_profile(malicious)


def test_governed_companion_migration_passes_source_dry_run_validation(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    root = Path(__file__).parents[1]
    prior = _source_profile_prior()
    candidate = "b" * 40
    changed = [
        MODULE.PROFILE_PATH,
        "hermes/profile/scripts/core-wake.sh",
    ]
    blobs = {
        **_source_profile_blobs(),
        MODULE.CONTROLLER_PATH: SCRIPT.read_bytes(),
        MODULE.UNIT_SOURCE_PATH: (root / MODULE.UNIT_SOURCE_PATH).read_bytes(),
        "node_bridge/src/hermesGatewayClient.mjs": (root / "node_bridge/src/hermesGatewayClient.mjs").read_bytes(),
        "node_bridge/src/personalMemoryMcpServer.mjs": (root / "node_bridge/src/personalMemoryMcpServer.mjs").read_bytes(),
    }
    monkeypatch.setattr(MODULE, "validate_candidate_object", lambda *_args: None)
    monkeypatch.setattr(
        MODULE,
        "validate_persistent_candidate_ref",
        lambda *_args: (_ for _ in ()).throw(AssertionError("persistent ref was consulted")),
    )
    monkeypatch.setattr(MODULE, "current_source_pointer", lambda: {"candidate": prior})
    monkeypatch.setattr(MODULE, "candidate_blob", lambda _repo, _candidate, path: blobs[path])
    monkeypatch.setattr(
        MODULE,
        "run",
        lambda *args, **_kwargs: subprocess.CompletedProcess(args[0], 0, "", ""),
    )

    def fake_git(_repo: Path, *args: str, **_kwargs):
        if args[:2] == ("diff", "--name-only"):
            return subprocess.CompletedProcess(args, 0, "\n".join(changed) + "\n", "")
        if args == ("rev-parse", "--verify", "refs/remotes/origin/main"):
            return subprocess.CompletedProcess(args, 0, candidate + "\n", "")
        return subprocess.CompletedProcess(args, 0, "", "")

    monkeypatch.setattr(MODULE, "git", fake_git)
    monkeypatch.setattr(MODULE, "require_source_baseline", lambda _candidate: {"kind": "converged"})
    monkeypatch.setattr(
        MODULE.shutil,
        "disk_usage",
        lambda _path: SimpleNamespace(free=10 * 1024 * 1024 * 1024),
    )

    assert MODULE.source_main(SimpleNamespace(candidate=candidate, mode="source-dry-run", snapshot=None)) == 0
    assert json.loads(capsys.readouterr().out)["status"] == "SOURCE_DRY_RUN_OK"


def test_source_profile_activation_uses_companion_for_current_and_future_advances(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    lite_home = tmp_path / "lite"
    profile_dir = lite_home / "profiles/ran-agent-companion"
    profile_dir.mkdir(parents=True)
    targets = (lite_home / "config.yaml", profile_dir / "config.yaml")
    for target in targets:
        target.write_text("legacy-web-profile\n")
    companion = (Path(__file__).parents[1] / MODULE.PROFILE_PATH).read_bytes()
    monkeypatch.setattr(MODULE, "LITE_HOME", lite_home)
    monkeypatch.setattr(MODULE, "SOURCE_PROFILE_DIR", profile_dir)
    monkeypatch.setattr(MODULE, "candidate_blob", lambda _repo, _candidate, path: companion if path == MODULE.PROFILE_PATH else b"inert\n")

    MODULE.validate_source_advance_paths(["README.md"], candidate="b" * 40, prior="a" * 40)
    MODULE.activate_source_profile("b" * 40)

    assert all(target.read_bytes() == companion for target in targets)
    assert b"mcp-search_hub" in companion and b"mcp-playwright" not in companion
    assert b"\n    - web\n" not in companion
    assert b"search_backend:" not in companion and b"extract_backend:" not in companion


@pytest.mark.parametrize("prior_script", [False, True])
def test_source_profile_and_pointer_rollback_restore_exact_prior_authority(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, prior_script: bool,
) -> None:
    prior_head = "a" * 40
    candidate = "b" * 40
    repo = tmp_path / "repo"
    lite_home = tmp_path / "lite"
    profile_dir = lite_home / "profiles/ran-agent-companion"
    profile_dir.mkdir(parents=True)
    root_config = lite_home / "config.yaml"
    profile_config = profile_dir / "config.yaml"
    root_config.write_bytes(b"prior-root\n")
    profile_config.write_bytes(b"prior-profile\n")
    script_target = profile_dir / "scripts/core-wake.sh"
    if prior_script:
        script_target.parent.mkdir()
        script_target.write_bytes(b"prior-script\n")
    snapshot_root = tmp_path / "snapshots"
    snapshot = snapshot_root / "source-new"
    (snapshot / "files").mkdir(parents=True)
    records = [MODULE.backup_path(snapshot, path, index) for index, path in enumerate((root_config, profile_dir))]
    overlay = tmp_path / "overlay"
    overlay.mkdir()
    (overlay / "state.json").write_text('{"status":"accepted"}\n')
    prior_pointer = {
        "schemaVersion": 1,
        "candidate": prior_head,
        "snapshot": str(snapshot_root / "prior"),
        "controller": str(tmp_path / "prior-controller.py"),
    }
    state = {
        "candidate": candidate,
        "phase": "accepted",
        "baselineKind": "converged",
        "priorHead": prior_head,
        "priorRef": "",
        "priorPointer": prior_pointer,
        "overlayStateSha256": MODULE.sha256_file(overlay / "state.json"),
        "paths": records,
        "services": {},
    }
    (snapshot / "state.json").write_text(json.dumps(state))
    pointer = snapshot_root / "current-source.json"
    pointer.write_text(json.dumps({"candidate": candidate, "snapshot": str(snapshot)}))
    repo.mkdir()
    companion = (Path(__file__).parents[1] / MODULE.PROFILE_PATH).read_bytes()
    blobs = wake_blobs(lite_home, profile_dir)
    blobs[MODULE.PROFILE_PATH] = companion
    monkeypatch.setattr(MODULE, "REPO", repo)
    monkeypatch.setattr(MODULE, "CORE_DB", tmp_path / "missing-core.sqlite3")
    monkeypatch.setattr(MODULE, "LITE_HOME", lite_home)
    monkeypatch.setattr(MODULE, "SOURCE_PROFILE_DIR", profile_dir)
    monkeypatch.setattr(MODULE, "SOURCE_SNAPSHOT_ROOT", snapshot_root)
    monkeypatch.setattr(MODULE, "SOURCE_POINTER", pointer)
    monkeypatch.setattr(MODULE, "current_source_pointer", lambda: {
        "schemaVersion": 1, "candidate": candidate, "snapshot": str(snapshot),
        "controller": str(tmp_path / "controller.py"),
    })
    monkeypatch.setattr(MODULE, "SOURCE_OVERLAY_TRANSACTION", overlay)
    monkeypatch.setattr(MODULE, "SOURCE_HERMES_OVERLAY_DROPIN", tmp_path / "missing-hermes-dropin")
    monkeypatch.setattr(MODULE, "SOURCE_PYTHON_OVERLAY_DROPIN", tmp_path / "missing-python-dropin")
    monkeypatch.setattr(MODULE, "candidate_blob", lambda _repo, _candidate, path: blobs[path])
    monkeypatch.setattr(MODULE, "stop_source_services", lambda: None)
    monkeypatch.setattr(MODULE, "restore_source_services", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(MODULE, "restore_metadata", lambda *_args: None)
    monkeypatch.setattr(MODULE, "git_as_checkout_owner", lambda *_args: None)
    monkeypatch.setattr(
        MODULE,
        "git",
        lambda _repo, *args, **_kwargs: subprocess.CompletedProcess(
            args, 0, f"{prior_head}\n" if args[:2] == ("rev-parse", "HEAD") else "", ""
        ),
    )

    MODULE.activate_source_profile(candidate)
    MODULE.project_source_wake_script(candidate)
    assert root_config.read_bytes() == companion and profile_config.read_bytes() == companion
    assert script_target.read_bytes() == blobs[MODULE.SOURCE_WAKE_SCRIPT_SOURCE]
    assert not script_target.is_symlink() and script_target.stat().st_mode & 0o777 == 0o755
    assert (script_target.stat().st_uid, script_target.stat().st_gid) == (os.getuid(), os.getgid())
    MODULE.source_rollback(snapshot, candidate)

    assert root_config.read_bytes() == b"prior-root\n"
    assert profile_config.read_bytes() == b"prior-profile\n"
    assert (script_target.read_bytes() == b"prior-script\n") if prior_script else not script_target.exists()
    assert json.loads(pointer.read_text()) == prior_pointer


def test_source_apply_retry_uses_committed_pointer_without_mutation(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    candidate = "b" * 40
    snapshot = tmp_path / "source-accepted"
    pointer = {
        "schemaVersion": 1, "candidate": candidate, "snapshot": str(snapshot),
        "controller": str(tmp_path / "controller.py"),
    }
    unit = tmp_path / "ran-agent-hermes.service"
    unit.write_bytes(b"unit\n")
    profile_targets = (tmp_path / "config.yaml", tmp_path / "profile.yaml")
    for target in profile_targets:
        target.write_bytes(b"profile\n")
    env_files = (tmp_path / ".env.local", tmp_path / "node.env.local")
    for env_file in env_files:
        env_file.write_text("AI_DAILY_DIGEST_ENABLED=false\n", encoding="utf-8")
    monkeypatch.setattr(MODULE, "current_source_pointer", lambda: pointer)
    monkeypatch.setattr(MODULE, "REPO", tmp_path)
    monkeypatch.setattr(MODULE, "ENV_FILES", env_files)
    monkeypatch.setattr(MODULE, "LITE_UNIT", unit)
    monkeypatch.setattr(MODULE, "SOURCE_HERMES_OVERLAY_DROPIN", tmp_path / "absent-hermes")
    monkeypatch.setattr(MODULE, "SOURCE_PYTHON_OVERLAY_DROPIN", tmp_path / "absent-python")
    monkeypatch.setattr(MODULE, "SOURCE_NODE_STEWARD_DROPIN", tmp_path / "absent-steward")
    monkeypatch.setattr(MODULE, "SOURCE_LEGACY_PROFILE_DIR", tmp_path / "absent-legacy")
    monkeypatch.setattr(
        MODULE, "git", lambda _repo, *args, **_kwargs: subprocess.CompletedProcess(
            args, 0, candidate + "\n" if args == ("rev-parse", "HEAD") else "", "",
        ),
    )
    monkeypatch.setattr(
        MODULE, "candidate_blob",
        lambda _repo, _candidate, path: b"unit\n" if path == MODULE.UNIT_SOURCE_PATH else b"profile\n",
    )
    monkeypatch.setattr(MODULE, "validate_companion_profile", lambda _profile: None)
    monkeypatch.setattr(MODULE, "source_profile_targets", lambda: profile_targets)
    monkeypatch.setattr(MODULE, "service_state", lambda _unit: {"active": "active"})
    monkeypatch.setattr(MODULE, "service_main_pid", lambda _unit: 123)
    monkeypatch.setattr(MODULE, "process_environment_for_pid", lambda _pid: {"HERMES_PROFILE": MODULE.SOURCE_PROFILE})
    monkeypatch.setattr(MODULE, "process_executable", lambda _pid: Path(
        "/opt/ran-agent-runtimes/hermes-v0.20.0-3049a082c0d1/python/bin/python3.12"
    ))
    monkeypatch.setattr(MODULE, "process_environment", lambda _unit: {})
    monkeypatch.setattr(MODULE, "validate_listener_topology", lambda _pid: None)
    monkeypatch.setattr(MODULE, "port_open", lambda port: port == 18001)
    monkeypatch.setattr(MODULE, "wait_port", lambda _port: None)
    monkeypatch.setattr(MODULE, "wait_for_gateway", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(MODULE, "source_memory_probe", lambda: (_ for _ in ()).throw(OSError("memory down")))
    monkeypatch.setattr(MODULE, "source_real_provider_probe", lambda: (_ for _ in ()).throw(OSError("provider down")))
    monkeypatch.setattr(
        MODULE, "stage_source_candidate",
        lambda *_args: (_ for _ in ()).throw(AssertionError("retry staged source")),
    )
    validations = []
    monkeypatch.setattr(MODULE, "require_source_wake_script", lambda value: validations.append(value))
    monkeypatch.setattr(
        MODULE, "project_source_wake_script",
        lambda _value: (_ for _ in ()).throw(AssertionError("retry reprojected wake script")),
    )

    assert MODULE.source_apply(candidate) == {
        "status": "SOURCE_APPLIED", "candidate": candidate, "snapshot": str(snapshot),
    }
    assert validations == [candidate]


def test_source_baseline_uses_dependency_blobs_for_reuse_admission(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    prior, candidate, repo = "a" * 40, "b" * 40, tmp_path / "repo"
    (repo / "node_modules").mkdir(parents=True)
    topology, binding, overlay = tmp_path / "topology", tmp_path / "binding", tmp_path / "overlay"
    topology.write_text(json.dumps({
        "candidate": "0b793e8fea85c409800ee7e0d615501816c99387", "topology": "unified-hermes-v0.20",
    }))
    binding.write_text('{"phase":"accepted","runtimeRollbackAuthorized":false}')
    overlay.mkdir()
    (overlay / "state.json").write_text(json.dumps({
        "status": "accepted", "candidate": MODULE.SOURCE_OVERLAY_CANDIDATE,
    }))
    for name, value in (("REPO", repo), ("TOPOLOGY_MARKER", topology), ("SOURCE_BINDING", binding),
                        ("SOURCE_OVERLAY_TRANSACTION", overlay)):
        monkeypatch.setattr(MODULE, name, value)
    monkeypatch.setattr(MODULE, "SOURCE_HERMES_OVERLAY_DROPIN", tmp_path / "retired-hermes")
    monkeypatch.setattr(MODULE, "SOURCE_PYTHON_OVERLAY_DROPIN", tmp_path / "retired-python")
    monkeypatch.setattr(MODULE, "SOURCE_SNAPSHOT_ROOT", tmp_path / "snapshots")
    monkeypatch.setattr(MODULE, "current_source_pointer", lambda: {"candidate": prior})
    monkeypatch.setattr(MODULE, "git", lambda _repo, *args, **_kwargs: subprocess.CompletedProcess(
        args, 0, prior + "\n" if args == ("rev-parse", "HEAD") else "", "",
    ))
    monkeypatch.setattr(MODULE.shutil, "disk_usage", lambda _path: SimpleNamespace(free=1))

    for changed_path in (None, "package.json", "package-lock.json"):
        monkeypatch.setattr(MODULE, "candidate_blob", lambda _repo, commit, path:
                            b"changed" if commit == candidate and path == changed_path else b"same")
        if changed_path:
            with pytest.raises(MODULE.ReleaseError, match="less than 2 GiB"):
                MODULE.require_source_baseline(candidate)
        else:
            assert MODULE.require_source_baseline(candidate)["dependenciesChanged"] is False

    monkeypatch.setattr(MODULE, "candidate_blob", lambda *_args: b"same")
    monkeypatch.setattr(
        MODULE, "stage_source_candidate",
        lambda *_args: (_ for _ in ()).throw(AssertionError("invalid reuse fell back to npm")),
    )
    for invalid in ("missing", "file", "symlink"):
        modules = repo / "node_modules"
        if modules.exists() or modules.is_symlink():
            modules.unlink() if not modules.is_dir() else modules.rmdir()
        if invalid == "file":
            modules.write_text("invalid")
        elif invalid == "symlink":
            modules.symlink_to(tmp_path / "missing")
        with pytest.raises(MODULE.ReleaseError, match="node_modules is unavailable"):
            MODULE.source_apply(candidate)


def test_activate_source_candidate_reuses_or_swaps_modules_without_a_second_path(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    repo, snapshot, stage = tmp_path / "repo", tmp_path / "snapshot", tmp_path / "stage"
    live_modules, staged_modules = repo / "node_modules", stage / "node_modules"
    live_modules.mkdir(parents=True)
    staged_modules.mkdir(parents=True)
    (live_modules / "old").write_text("old")
    (staged_modules / "new").write_text("new")
    snapshot.mkdir()
    monkeypatch.setattr(MODULE, "REPO", repo)
    monkeypatch.setattr(MODULE, "ENV_FILES", ())
    monkeypatch.setattr(MODULE, "git_as_checkout_owner", lambda *_args: None)
    monkeypatch.setattr(
        MODULE, "activate_source_profile",
        lambda *_args: (_ for _ in ()).throw(RuntimeError("after modules")),
    )
    monkeypatch.setattr(MODULE.os, "chown", lambda *_args: (_ for _ in ()).throw(AssertionError("reuse chowned modules")))
    inode = live_modules.stat().st_ino

    with pytest.raises(RuntimeError, match="after modules"):
        MODULE.activate_source_candidate("b" * 40, None, snapshot, install_profile=False)
    assert live_modules.stat().st_ino == inode and not (snapshot / "node_modules.rollback").exists()

    monkeypatch.setattr(MODULE.os, "chown", lambda *_args: None)
    with pytest.raises(RuntimeError, match="after modules"):
        MODULE.activate_source_candidate("b" * 40, stage, snapshot, install_profile=False)
    assert (live_modules / "new").read_text() == "new"
    assert (snapshot / "node_modules.rollback" / "old").read_text() == "old"


@pytest.mark.parametrize(("prior_form", "fail_head"), [("detached", False), ("branch", False), ("detached", True)])
def test_source_git_convergence_and_head_failure_recovery(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, prior_form: str, fail_head: bool
) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()

    def git(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
        return subprocess.run(["git", "-C", str(repo), *args], check=check, capture_output=True, text=True)
    git("init", "-q")
    git("config", "user.email", "source-test@example.com")
    git("config", "user.name", "Source Test")
    tracked = repo / "tracked.txt"
    tracked.write_text("prior\n")
    git("add", "tracked.txt")
    git("commit", "-qm", "prior")
    prior_head = git("rev-parse", "HEAD").stdout.strip()
    prior_ref = git("symbolic-ref", "HEAD").stdout.strip()
    tracked.write_text("candidate\n")
    git("commit", "-qam", "candidate")
    candidate = git("rev-parse", "HEAD").stdout.strip()
    git("update-ref", prior_ref, prior_head)
    git("restore", "--source", prior_head, "--staged", "--worktree", "--", ":/")
    if prior_form == "detached":
        git("update-ref", "--no-deref", "HEAD", prior_head)

    (snapshot := tmp_path / "snapshot").mkdir()
    (overlay := tmp_path / "overlay").mkdir()
    (overlay / "state.json").write_text("{}")
    prior_pointer = {"candidate": prior_head}
    pointer = [prior_pointer]
    state = {
        "baselineKind": "converged", "priorHead": prior_head,
        "priorRef": prior_ref if prior_form == "branch" else "", "priorPointer": prior_pointer,
        "paths": [], "overlayStateSha256": MODULE.sha256_file(overlay / "state.json"),
    }
    activation_order = []
    for name, value in (
        ("REPO", repo), ("SOURCE_SNAPSHOT_ROOT", tmp_path / "snapshots"),
        ("SOURCE_OVERLAY_TRANSACTION", overlay), ("ENV_FILES", ()),
        ("LITE_UNIT", tmp_path / "unit"),
        ("SOURCE_HERMES_OVERLAY_DROPIN", tmp_path / "missing-hermes"),
        ("SOURCE_PYTHON_OVERLAY_DROPIN", tmp_path / "missing-python"),
        ("SOURCE_NODE_STEWARD_DROPIN", tmp_path / "missing-steward"),
        ("SOURCE_LEGACY_PROFILE_DIR", tmp_path / "missing-profile"),
    ):
        monkeypatch.setattr(MODULE, name, value)
    monkeypatch.setattr(MODULE, "current_source_pointer", lambda: pointer[0])
    monkeypatch.setattr(MODULE, "publish_source_pointer", lambda value: pointer.__setitem__(0, value))
    monkeypatch.setattr(MODULE, "require_source_baseline", lambda _candidate: {
        "kind": "converged", "priorPointer": prior_pointer, "dependenciesChanged": False,
    })
    monkeypatch.setattr(MODULE, "persist_source_authority", lambda _candidate: tmp_path / "controller")
    monkeypatch.setattr(MODULE, "create_source_snapshot", lambda *_args: (snapshot, state))
    monkeypatch.setattr(MODULE, "stop_source_services", lambda: None)
    monkeypatch.setattr(MODULE, "restore_source_services", lambda *_args, **_kwargs: activation_order.append("restart"))
    monkeypatch.setattr(MODULE, "activate_source_profile", lambda _candidate: activation_order.append("profile"))
    monkeypatch.setattr(MODULE, "project_source_wake_script", lambda _candidate: activation_order.append("wake"))
    monkeypatch.setattr(MODULE, "validate_source_acceptance", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(MODULE, "candidate_blob", lambda *_args: b"unit\n")
    monkeypatch.setattr(MODULE, "atomic_write", lambda path, data, **_kwargs: path.write_bytes(data))

    def mutate(*args: str) -> None:
        if fail_head and args == ("update-ref", "--no-deref", "HEAD", candidate):
            assert tracked.read_text() == "candidate\n"
            assert git("diff", "--cached", "--name-only").stdout == "tracked.txt\n"
            assert git("rev-parse", "HEAD").stdout.strip() == prior_head
            raise MODULE.ReleaseError("injected HEAD failure")
        git(*args)

    monkeypatch.setattr(MODULE, "git_as_checkout_owner", mutate)
    receipt = MODULE.source_apply(candidate)
    if fail_head:
        assert receipt["status"] == "SOURCE_ROLLED_BACK" and pointer[0] == prior_pointer
    else:
        assert receipt["status"] == "SOURCE_APPLIED"
        assert activation_order == ["profile", "wake", "restart"]
        assert tracked.read_text() == "candidate\n"
        assert git("symbolic-ref", "-q", "HEAD", check=False).returncode != 0
        assert git("rev-parse", prior_ref).stdout.strip() == prior_head
        MODULE.restore_source_snapshot(snapshot, state)
    assert tracked.read_text() == "prior\n"
    assert git("rev-parse", "HEAD").stdout.strip() == prior_head
    symbolic = git("symbolic-ref", "-q", "HEAD", check=False)
    assert (symbolic.stdout.strip() if symbolic.returncode == 0 else "") == state["priorRef"]
    assert git("status", "--porcelain").stdout == ""


def test_source_git_mutation_error_is_one_bounded_printable_line(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(MODULE, "REPO", tmp_path)
    monkeypatch.setattr(MODULE.pwd, "getpwuid", lambda _uid: SimpleNamespace(pw_name="ubuntu"))
    monkeypatch.setattr(MODULE, "run", lambda *_args, **_kwargs: (_ for _ in ()).throw(
        subprocess.CalledProcessError(1, ["git"], stderr="\x00\nfatal: " + "x" * 300 + "\nprivate")
    ))
    with pytest.raises(MODULE.ReleaseError) as error:
        MODULE.git_as_checkout_owner("restore")
    detail = str(error.value).removeprefix("source Git mutation failed:")
    assert len(detail) == 240 and detail.startswith("fatal: ") and "private" not in detail


def test_interrupted_precommit_apply_restores_prior_before_fresh_baseline(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    candidate = "b" * 40
    snapshot_root = tmp_path / "snapshots"
    interrupted = snapshot_root / "source-interrupted"
    interrupted.mkdir(parents=True)
    (interrupted / "state.json").write_text(json.dumps({
        "candidate": candidate, "priorPointer": None, "phase": "accepted",
    }))
    stage = tmp_path / "stage"
    stage.mkdir()
    fresh = snapshot_root / "source-fresh"
    fresh.mkdir()
    baseline = {"kind": "initial", "priorPointer": None, "dependenciesChanged": False}
    calls = []
    monkeypatch.setattr(MODULE, "SOURCE_SNAPSHOT_ROOT", snapshot_root)
    monkeypatch.setattr(MODULE, "current_source_pointer", lambda: None)

    def require_baseline(_candidate=None, *, require_capacity=True):
        calls.append(("baseline", require_capacity))
        return baseline

    monkeypatch.setattr(MODULE, "require_source_baseline", require_baseline)
    monkeypatch.setattr(MODULE, "restore_source_snapshot", lambda path, _state: calls.append(("restore", path)))
    monkeypatch.setattr(MODULE, "update_phase", lambda path, _state, phase: calls.append((phase, path)))
    monkeypatch.setattr(MODULE, "persist_source_authority", lambda _candidate: tmp_path / "controller.py")
    monkeypatch.setattr(
        MODULE, "stage_source_candidate",
        lambda *_args: (_ for _ in ()).throw(AssertionError("reuse staged dependencies")),
    )
    monkeypatch.setattr(MODULE, "create_source_snapshot", lambda *_args: (fresh, {}))
    monkeypatch.setattr(MODULE, "stop_source_services", lambda: calls.append(("mutate", fresh)))
    monkeypatch.setattr(
        MODULE, "activate_source_candidate",
        lambda _candidate, selected_stage, *_args, **_kwargs: calls.append(("stage", selected_stage)),
    )
    monkeypatch.setattr(MODULE, "restore_source_services", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(MODULE, "validate_source_acceptance", lambda *_args: None)
    monkeypatch.setattr(MODULE, "publish_source_pointer", lambda _pointer: None)

    assert MODULE.source_apply(candidate)["status"] == "SOURCE_APPLIED"
    assert calls[:4] == [
        ("restore", interrupted), ("rolled-back", interrupted),
        ("baseline", False), ("baseline", True),
    ]
    assert ("mutate", fresh) in calls and ("stage", None) in calls


def test_apply_restore_failure_reports_both_failures_as_reconciliation_required(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    candidate = "b" * 40
    stage = tmp_path / "stage"
    stage.mkdir()
    snapshot = tmp_path / "snapshots" / "fresh"
    snapshot.mkdir(parents=True)
    monkeypatch.setattr(MODULE, "SOURCE_SNAPSHOT_ROOT", snapshot.parent)
    monkeypatch.setattr(MODULE, "current_source_pointer", lambda: None)
    monkeypatch.setattr(
        MODULE, "require_source_baseline",
        lambda _candidate: {"kind": "initial", "priorPointer": None, "dependenciesChanged": True},
    )
    monkeypatch.setattr(MODULE, "persist_source_authority", lambda _candidate: tmp_path / "controller.py")
    monkeypatch.setattr(MODULE, "stage_source_candidate", lambda _candidate: stage)
    monkeypatch.setattr(MODULE, "create_source_snapshot", lambda *_args: (snapshot, {}))
    monkeypatch.setattr(MODULE, "stop_source_services", lambda: None)
    monkeypatch.setattr(
        MODULE, "activate_source_candidate",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(ValueError("apply failed")),
    )
    monkeypatch.setattr(
        MODULE, "restore_source_snapshot",
        lambda *_args: (_ for _ in ()).throw(OSError("restore failed")),
    )

    with pytest.raises(
        MODULE.SourceReconciliationRequired,
        match="source apply failed:ValueError; restore failed:OSError",
    ):
        MODULE.source_apply(candidate)


def test_apply_failure_returns_explicit_safe_rollback_receipt(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    candidate = "b" * 40
    stage = tmp_path / "stage"
    stage.mkdir()
    snapshot = tmp_path / "snapshots" / "fresh"
    snapshot.mkdir(parents=True)
    calls = []
    monkeypatch.setattr(MODULE, "SOURCE_SNAPSHOT_ROOT", snapshot.parent)
    monkeypatch.setattr(MODULE, "current_source_pointer", lambda: None)
    monkeypatch.setattr(
        MODULE, "require_source_baseline",
        lambda _candidate: {"kind": "initial", "priorPointer": None, "dependenciesChanged": True},
    )
    monkeypatch.setattr(MODULE, "persist_source_authority", lambda _candidate: tmp_path / "controller.py")
    monkeypatch.setattr(MODULE, "stage_source_candidate", lambda _candidate: calls.append("stage") or stage)
    monkeypatch.setattr(MODULE, "create_source_snapshot", lambda *_args: (snapshot, {}))
    monkeypatch.setattr(MODULE, "stop_source_services", lambda: None)
    monkeypatch.setattr(
        MODULE, "activate_source_candidate",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(ValueError("apply failed")),
    )
    monkeypatch.setattr(MODULE, "restore_source_snapshot", lambda *_args: calls.append("restore"))
    monkeypatch.setattr(MODULE, "update_phase", lambda *_args: calls.append("rolled-back"))

    assert MODULE.source_apply(candidate) == {
        "status": "SOURCE_ROLLED_BACK", "candidate": candidate,
        "snapshot": str(snapshot),
    }
    assert calls == ["stage", "restore", "rolled-back"]


def test_candidate_pointer_overrides_rolled_back_snapshot_phase(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    candidate = "b" * 40
    snapshot = tmp_path / "snapshot"
    snapshot.mkdir()
    (snapshot / "state.json").write_text(json.dumps({
        "candidate": candidate, "phase": "rolled-back", "priorPointer": None,
    }))
    pointer = {"candidate": candidate, "snapshot": str(snapshot)}
    calls = []
    monkeypatch.setattr(MODULE, "SOURCE_SNAPSHOT_ROOT", tmp_path)
    monkeypatch.setattr(MODULE, "current_source_pointer", lambda: pointer)
    monkeypatch.setattr(MODULE, "assert_source_rollback_boundary", lambda _state: None)
    monkeypatch.setattr(MODULE, "restore_source_snapshot", lambda *_args: calls.append("restore"))
    monkeypatch.setattr(MODULE, "update_phase", lambda *_args: None)
    monkeypatch.setattr(MODULE, "publish_source_pointer", lambda value: calls.append(value))

    assert MODULE.source_rollback(snapshot, candidate)["status"] == "SOURCE_ROLLED_BACK"
    assert calls == ["restore", None]


def test_source_rollback_retry_uses_durable_prior_pointer_without_restore(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    candidate = "b" * 40
    prior = {"candidate": "a" * 40}
    snapshot = tmp_path / "snapshot"
    snapshot.mkdir()
    (snapshot / "state.json").write_text(json.dumps({
        "candidate": candidate, "priorPointer": prior,
    }))
    checked = []
    monkeypatch.setattr(MODULE, "SOURCE_SNAPSHOT_ROOT", tmp_path)
    monkeypatch.setattr(MODULE, "current_source_pointer", lambda: prior)
    monkeypatch.setattr(
        MODULE, "require_source_baseline",
        lambda *, require_capacity=True: checked.append(require_capacity) or {},
    )
    monkeypatch.setattr(
        MODULE, "source_memory_probe",
        lambda: (_ for _ in ()).throw(AssertionError("rollback replay used memory liveness")),
    )
    monkeypatch.setattr(
        MODULE, "source_real_provider_probe",
        lambda: (_ for _ in ()).throw(AssertionError("rollback replay used provider liveness")),
    )
    monkeypatch.setattr(
        MODULE, "restore_source_snapshot",
        lambda *_args: (_ for _ in ()).throw(AssertionError("retry restored source")),
    )

    assert MODULE.source_rollback(snapshot, candidate)["status"] == "SOURCE_ROLLED_BACK"
    assert checked == [False]


def test_source_pointer_absence_is_committed_by_parent_fsync(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    pointer = tmp_path / "current-source.json"
    pointer.write_text("{}")
    synced = []
    monkeypatch.setattr(MODULE, "SOURCE_POINTER", pointer)
    monkeypatch.setattr(MODULE, "fsync_directory", lambda path: synced.append(path))

    MODULE.publish_source_pointer(None)

    assert not pointer.exists()
    assert synced == [tmp_path]


def core_authority_db(path: Path, *, candidate: str | None = None, source_ref: str | None = None) -> None:
    with sqlite3.connect(path) as database:
        database.execute("""CREATE TABLE journal_event(
            journal_event_id TEXT PRIMARY KEY,event_type TEXT,owner_id TEXT,actor_ref TEXT,origin_ref TEXT,
            source_kind TEXT,source_ref TEXT,correlation_id TEXT
        )""")
        if candidate is not None:
            semantics = {
                "schemaVersion": 1, "candidateSha": candidate,
                "migrationSnapshotDigest": f"sha256:{'c' * 64}",
                "scheduleManifestDigest": f"sha256:{'d' * 64}",
                "ambiguousOutboxDisposition": "terminal_no_resend",
                "pendingOutboundDisposition": "suppress",
            }
            database.execute(
                "INSERT INTO journal_event VALUES('core-cutover:v1','core_cutover_committed_at',"
                "'owner','owner','owner-authorization','core-cutover:v1',?,?)",
                (source_ref or json.dumps(semantics), candidate),
            )
    path.chmod(0o600)


def test_source_rollback_without_core_marker_preserves_pre_s12_semantics(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    database = tmp_path / "core.sqlite3"
    core_authority_db(database)
    monkeypatch.setattr(MODULE, "CORE_DB", database)
    MODULE.assert_source_rollback_boundary({"priorHead": "a" * 40})


def test_source_rollback_rejects_a_pre_core_snapshot_after_cutover(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    database = tmp_path / "core.sqlite3"
    core_authority_db(database, candidate="b" * 40)
    monkeypatch.setattr(MODULE, "CORE_DB", database)
    monkeypatch.setattr(MODULE, "REPO", tmp_path)
    monkeypatch.setattr(MODULE, "run", lambda *_args, **_kwargs: subprocess.CompletedProcess([], 1, "", ""))
    with pytest.raises(MODULE.ReleaseError, match="cross the committed Core authority boundary"):
        MODULE.assert_source_rollback_boundary({"priorHead": "a" * 40})


@pytest.mark.parametrize("restore_head", ["b" * 40, "c" * 40])
def test_source_rollback_allows_the_cutover_candidate_or_descendant(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, restore_head: str
) -> None:
    database = tmp_path / "core.sqlite3"
    core_authority_db(database, candidate="b" * 40)
    monkeypatch.setattr(MODULE, "CORE_DB", database)
    monkeypatch.setattr(MODULE, "REPO", tmp_path)
    monkeypatch.setattr(MODULE, "run", lambda *_args, **_kwargs: subprocess.CompletedProcess([], 0, "", ""))
    MODULE.assert_source_rollback_boundary({"priorHead": restore_head})


@pytest.mark.parametrize("kind", ["missing-journal", "malformed-marker"])
def test_source_rollback_fails_closed_on_malformed_core_authority(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, kind: str
) -> None:
    database = tmp_path / "core.sqlite3"
    if kind == "missing-journal":
        sqlite3.connect(database).close()
        database.chmod(0o600)
    else:
        core_authority_db(database, candidate="b" * 40, source_ref="not-json")
    monkeypatch.setattr(MODULE, "CORE_DB", database)
    with pytest.raises(MODULE.ReleaseError, match="Core (authority database lacks|cutover marker is malformed)"):
        MODULE.assert_source_rollback_boundary({"priorHead": "b" * 40})


def test_source_rollback_fails_closed_on_unsafe_core_database_mode(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    database = tmp_path / "core.sqlite3"
    core_authority_db(database, candidate="b" * 40)
    database.chmod(0o644)
    monkeypatch.setattr(MODULE, "CORE_DB", database)
    with pytest.raises(MODULE.ReleaseError, match="identity/mode/link count"):
        MODULE.assert_source_rollback_boundary({"priorHead": "b" * 40})


def test_source_rollback_checks_core_boundary_before_restoring(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    candidate = "b" * 40
    snapshot = tmp_path / "snapshot"
    snapshot.mkdir()
    (snapshot / "state.json").write_text(json.dumps({
        "candidate": candidate, "phase": "accepted", "priorHead": "a" * 40,
    }))
    pointer = tmp_path / "current-source.json"
    pointer.write_text(json.dumps({"candidate": candidate, "snapshot": str(snapshot)}))
    monkeypatch.setattr(MODULE, "SOURCE_SNAPSHOT_ROOT", tmp_path)
    monkeypatch.setattr(MODULE, "SOURCE_POINTER", pointer)
    monkeypatch.setattr(MODULE, "current_source_pointer", lambda: {
        "schemaVersion": 1, "candidate": candidate, "snapshot": str(snapshot),
        "controller": str(tmp_path / "controller.py"),
    })
    monkeypatch.setattr(MODULE, "assert_source_rollback_boundary", lambda _state: (_ for _ in ()).throw(
        MODULE.ReleaseError("boundary rejected")
    ))
    restored = []
    monkeypatch.setattr(MODULE, "restore_source_snapshot", lambda *_args: restored.append(True))
    with pytest.raises(MODULE.ReleaseError, match="boundary rejected"):
        MODULE.source_rollback(snapshot, candidate)
    assert restored == []


def test_gateway_readiness_refreshes_credentials_after_main_pid_change(monkeypatch: pytest.MonkeyPatch) -> None:
    environments = iter([{"API_SERVER_KEY": "stale"}, {"API_SERVER_KEY": "fresh"}])
    attempts: list[str | None] = []

    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self):
            return b'{"data":[{"id":"ran-agent-companion"}]}'

    def open_request(request, *, timeout):
        attempts.append(request.get_header("Authorization"))
        if attempts[-1] != "Bearer fresh":
            raise OSError("stale process credentials")
        return Response()

    monkeypatch.setattr(MODULE, "process_environment", lambda _unit: next(environments))
    monkeypatch.setattr(MODULE.urllib.request, "urlopen", open_request)
    monkeypatch.setattr(MODULE.time, "sleep", lambda _seconds: None)

    MODULE.wait_for_gateway(8642, {}, "ran-agent-companion", refresh_unit="ran-agent-hermes.service")
    assert attempts == ["Bearer stale", "Bearer fresh"]


def test_source_verify_is_read_only_without_a_candidate_ref_or_lock(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    candidate = "a" * 40
    artifact = tmp_path / "release"
    snapshots = artifact / "source-snapshots"
    monkeypatch.setattr(MODULE, "REPO", tmp_path)
    monkeypatch.setattr(MODULE, "LOCK_PATH", artifact / ".release-transaction.lock")
    monkeypatch.setattr(MODULE, "SOURCE_POINTER", snapshots / "current-source.json")
    monkeypatch.setattr(MODULE, "SOURCE_SNAPSHOT_ROOT", snapshots)
    monkeypatch.setattr(MODULE, "SOURCE_ARTIFACT_ROOT", artifact / "source-artifacts")
    with pytest.raises(MODULE.ReleaseError, match="requires the existing release lock"):
        with MODULE.release_lock(create=False):
            pass
    assert not MODULE.LOCK_PATH.exists()
    monkeypatch.delenv("GIT_OPTIONAL_LOCKS", raising=False)

    @contextlib.contextmanager
    def existing_lock(*, create: bool = True):
        assert create is False
        assert os.environ["GIT_OPTIONAL_LOCKS"] == "0"
        yield

    monkeypatch.setattr(MODULE, "release_lock", existing_lock)
    validated = []
    monkeypatch.setattr(
        MODULE, "validate_source_candidate",
        lambda value, **kwargs: validated.append((value, kwargs)),
    )
    monkeypatch.setattr(MODULE, "require_source_baseline", lambda _candidate: {"kind": "converged"})
    monkeypatch.setattr(MODULE.shutil, "disk_usage", lambda _path: SimpleNamespace(free=123))

    assert MODULE.source_main(SimpleNamespace(
        candidate=candidate, mode="source-verify", snapshot=None,
    )) == 0
    assert validated == [(candidate, {})]
    assert not MODULE.LOCK_PATH.exists()
    assert json.loads(capsys.readouterr().out) == {
        "candidate": candidate, "freeBytes": 123, "status": "SOURCE_VERIFY_OK",
    }


def test_source_verify_reuses_candidate_validation_without_persistent_ref_authority(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    candidate = "b" * 40
    prior = "a" * 40
    object_checks = []
    monkeypatch.setattr(
        MODULE, "validate_candidate_object", lambda repo, value: object_checks.append((repo, value)),
    )
    monkeypatch.setattr(
        MODULE, "validate_persistent_candidate_ref",
        lambda *_args: (_ for _ in ()).throw(AssertionError("persistent ref was consulted")),
    )
    monkeypatch.setattr(MODULE, "current_source_pointer", lambda: {"candidate": prior})
    monkeypatch.setattr(
        MODULE, "run", lambda *_args, **_kwargs: subprocess.CompletedProcess([], 0, "", ""),
    )

    def fake_git(_repo: Path, *args: str, **_kwargs):
        if args[:2] == ("diff", "--name-only"):
            return subprocess.CompletedProcess(args, 0, "README.md\n", "")
        if args == ("rev-parse", "--verify", "refs/remotes/origin/main"):
            return subprocess.CompletedProcess(args, 0, candidate + "\n", "")
        return subprocess.CompletedProcess(args, 0, "", "")

    monkeypatch.setattr(MODULE, "git", fake_git)
    monkeypatch.setattr(
        MODULE, "candidate_blob",
        lambda _repo, _candidate, path: SCRIPT.read_bytes() if path == MODULE.CONTROLLER_PATH else b"",
    )
    monkeypatch.setattr(MODULE, "validate_unified_source_shape", lambda _candidate: None)
    MODULE.validate_source_candidate(candidate)
    MODULE.validate_source_candidate(candidate, allow_current=True)
    assert object_checks == [(MODULE.REPO, candidate), (MODULE.REPO, candidate)]


def test_persist_source_authority_persists_only_the_controller_artifact(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    candidate = "b" * 40
    artifact_root = tmp_path / "source-artifacts"
    payload = SCRIPT.read_bytes()
    writes = []
    monkeypatch.setattr(MODULE, "SOURCE_ARTIFACT_ROOT", artifact_root)
    monkeypatch.setattr(MODULE, "candidate_blob", lambda _repo, _value, _path: payload)
    monkeypatch.setattr(
        MODULE,
        "atomic_write",
        lambda path, data, **kwargs: writes.append((path, data, kwargs)),
    )
    monkeypatch.setattr(
        MODULE,
        "git_as_checkout_owner",
        lambda *_args: (_ for _ in ()).throw(AssertionError("source ref was re-asserted")),
    )

    destination = MODULE.persist_source_authority(candidate)

    assert destination == artifact_root / f"deploy-hermes-source-{candidate}.py"
    assert writes == [(destination, payload, {"mode": 0o700, "uid": 0, "gid": 0})]


def test_source_rollback_admission_relies_on_snapshot_and_pointer_without_a_ref(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    candidate = "b" * 40
    snapshot = tmp_path / "snapshots" / "source-new"
    monkeypatch.setattr(MODULE, "validate_candidate_object", lambda *_args: None)
    monkeypatch.setattr(
        MODULE,
        "validate_persistent_candidate_ref",
        lambda *_args: (_ for _ in ()).throw(AssertionError("persistent ref was consulted")),
    )
    monkeypatch.setattr(MODULE, "current_source_pointer", lambda: {"candidate": candidate})
    monkeypatch.setattr(
        MODULE, "run", lambda *_args, **_kwargs: subprocess.CompletedProcess([], 0, "", ""),
    )
    monkeypatch.setattr(
        MODULE,
        "git",
        lambda _repo, *args, **_kwargs: subprocess.CompletedProcess(
            args,
            0,
            candidate + "\n" if args == ("rev-parse", "--verify", "refs/remotes/origin/main") else "",
            "",
        ),
    )
    monkeypatch.setattr(
        MODULE,
        "candidate_blob",
        lambda _repo, _candidate, path: SCRIPT.read_bytes() if path == MODULE.CONTROLLER_PATH else b"",
    )
    monkeypatch.setattr(MODULE, "validate_unified_source_shape", lambda _candidate: None)
    rolled_back = []
    monkeypatch.setattr(
        MODULE, "source_rollback",
        lambda *args: (rolled_back.append(args) or {
            "status": "SOURCE_ROLLED_BACK", "candidate": candidate,
            "snapshot": str(snapshot.resolve()),
        }),
    )

    assert MODULE.source_main(SimpleNamespace(
        candidate=candidate, mode="source-rollback", snapshot=snapshot,
    )) == 0

    assert rolled_back == [(snapshot.resolve(), candidate)]
    assert json.loads(capsys.readouterr().out)["status"] == "SOURCE_ROLLED_BACK"


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
    memory = (Path(__file__).parents[1] / "node_bridge/src/personalMemoryMcpServer.mjs").read_text()
    assert "const BACKEND_TIMEOUT_MS = 15000;" in memory
    assert "PERSONAL_MEMORY_BACKEND_TIMEOUT_MS" not in memory


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
    assert source.index("validate_source_candidate(args.candidate") < source.index(
        'if args.mode == "source-rollback":'
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
