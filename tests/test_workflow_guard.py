from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = REPO_ROOT / "scripts" / "workflow_guard.py"
SUMMARY_PREFIX = "WORKFLOW_GUARD_SUMMARY="


def git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(repo), *args],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


def setup_repo(tmp_path: Path) -> Path:
    remote = tmp_path / "origin.git"
    repo = tmp_path / "repo"
    subprocess.run(["git", "init", "--bare", str(remote)], check=True, capture_output=True)
    subprocess.run(["git", "init", "-b", "main", str(repo)], check=True, capture_output=True)
    git(repo, "config", "user.name", "Workflow Guard Test")
    git(repo, "config", "user.email", "workflow@example.test")
    (repo / ".gitignore").write_text("local_archive/\n", encoding="utf-8")
    (repo / "tracked.txt").write_text("base\n", encoding="utf-8")
    git(repo, "add", ".gitignore", "tracked.txt")
    git(repo, "commit", "-m", "base")
    git(repo, "remote", "add", "origin", str(remote))
    git(repo, "push", "-u", "origin", "main")
    return repo


def guard(repo: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPT), "--repository", str(repo), *args],
        capture_output=True,
        text=True,
    )


def verify_summary(result: subprocess.CompletedProcess[str]) -> dict[str, object]:
    line = next(line for line in reversed(result.stdout.splitlines()) if line.startswith(SUMMARY_PREFIX))
    return json.loads(line.removeprefix(SUMMARY_PREFIX))


def snapshot(repo: Path) -> Path:
    directory = repo / "local_archive" / "runtime" / "workflow-evidence"
    output = directory / f"snapshot-{len(list(directory.glob('snapshot-*.json')))}.json"
    result = guard(repo, "snapshot", "--output", str(output))
    assert result.returncode == 0, result.stderr
    return output


def test_snapshot_and_check_bind_exact_repository_state(tmp_path: Path) -> None:
    repo = setup_repo(tmp_path)
    output = snapshot(repo)
    document = json.loads(output.read_text(encoding="utf-8"))

    assert document["schema_version"] == 1
    assert document["repository_realpath"] == str(repo.resolve())
    assert document["git"]["head"] == git(repo, "rev-parse", "HEAD")
    assert document["git"]["origin_main"] == git(repo, "rev-parse", "refs/remotes/origin/main")
    assert document["worktree"]["untracked"] == []
    assert len(document["checksum"]) == 64
    assert guard(repo, "check", "--snapshot", str(output)).returncode == 0


def test_repository_argument_is_normalized_to_git_toplevel(tmp_path: Path) -> None:
    repo = setup_repo(tmp_path)
    subdirectory = repo / "nested"
    subdirectory.mkdir()
    output = repo / "local_archive" / "runtime" / "workflow-evidence" / "nested-snapshot.json"

    result = guard(subdirectory, "snapshot", "--output", str(output))

    assert result.returncode == 0, result.stderr
    document = json.loads(output.read_text(encoding="utf-8"))
    assert document["repository_realpath"] == str(repo.resolve())


def test_snapshot_rejects_unignored_or_existing_output(tmp_path: Path) -> None:
    repo = setup_repo(tmp_path)
    unignored = repo / "snapshot.json"
    rejected = guard(repo, "snapshot", "--output", str(unignored))
    assert rejected.returncode == 2
    assert "ignored" in rejected.stderr
    assert not unignored.exists()

    output = snapshot(repo)
    repeated = guard(repo, "snapshot", "--output", str(output))
    assert repeated.returncode == 2
    assert "already exists" in repeated.stderr


def test_check_detects_tracked_untracked_and_origin_drift(tmp_path: Path) -> None:
    repo = setup_repo(tmp_path)
    tracked_snapshot = snapshot(repo)
    (repo / "tracked.txt").write_text("changed\n", encoding="utf-8")
    tracked = guard(repo, "check", "--snapshot", str(tracked_snapshot))
    assert tracked.returncode == 3
    assert "worktree_diff_sha256" in tracked.stdout

    git(repo, "restore", "tracked.txt")
    untracked_snapshot = snapshot(repo)
    (repo / "new.txt").write_text("new\n", encoding="utf-8")
    untracked = guard(repo, "check", "--snapshot", str(untracked_snapshot))
    assert untracked.returncode == 3
    assert "untracked" in untracked.stdout

    (repo / "new.txt").unlink()
    origin_snapshot = snapshot(repo)
    git(repo, "update-ref", "-d", "refs/remotes/origin/main")
    origin = guard(repo, "check", "--snapshot", str(origin_snapshot))
    assert origin.returncode == 3
    assert "origin_main" in origin.stdout


def test_check_detects_index_and_worktree_changes_that_cancel_in_head_diff(tmp_path: Path) -> None:
    repo = setup_repo(tmp_path)
    baseline = snapshot(repo)
    (repo / "tracked.txt").write_text("staged\n", encoding="utf-8")
    git(repo, "add", "tracked.txt")
    (repo / "tracked.txt").write_text("base\n", encoding="utf-8")

    result = guard(repo, "check", "--snapshot", str(baseline))

    assert result.returncode == 3
    assert "index_diff_sha256" in result.stdout
    assert "worktree_diff_sha256" in result.stdout


def test_run_refuses_preexisting_drift_without_executing_command(tmp_path: Path) -> None:
    repo = setup_repo(tmp_path)
    baseline = snapshot(repo)
    marker = repo / "marker.txt"
    (repo / "tracked.txt").write_text("drift\n", encoding="utf-8")

    result = guard(
        repo,
        "run",
        "--snapshot",
        str(baseline),
        "--evidence",
        str(repo / "local_archive" / "runtime" / "workflow-evidence" / "evidence.json"),
        "--label",
        "must-not-run",
        "--",
        sys.executable,
        "-c",
        f"from pathlib import Path; Path({str(marker)!r}).write_text('ran')",
    )

    assert result.returncode == 3
    assert not marker.exists()


def test_run_records_redacted_success_and_failure(tmp_path: Path) -> None:
    repo = setup_repo(tmp_path)
    baseline = snapshot(repo)
    evidence = repo / "local_archive" / "runtime" / "workflow-evidence" / "evidence.json"
    secret = "never-store-this-token"

    passed = guard(
        repo,
        "run",
        "--snapshot",
        str(baseline),
        "--evidence",
        str(evidence),
        "--label",
        "pass",
        "--",
        sys.executable,
        "-c",
        "raise SystemExit(0)",
        secret,
    )
    failed = guard(
        repo,
        "run",
        "--snapshot",
        str(baseline),
        "--evidence",
        str(evidence),
        "--label",
        "fail",
        "--",
        sys.executable,
        "-c",
        "raise SystemExit(7)",
        secret,
    )

    assert passed.returncode == 0
    assert failed.returncode == 5
    raw = evidence.read_text(encoding="utf-8")
    assert secret not in raw
    document = json.loads(raw)
    assert [item["status"] for item in document["results"]] == ["passed", "failed"]
    assert all(len(item["command_sha256"]) == 64 for item in document["results"])
    assert all("command" not in item for item in document["results"])
    assert len(document["checksum"]) == 64
    assert all(item["executable"]["realpath"] for item in document["results"])
    assert all(len(item["executable"]["sha256"]) == 64 for item in document["results"])


def test_run_rejects_tampered_evidence_manifest(tmp_path: Path) -> None:
    repo = setup_repo(tmp_path)
    baseline = snapshot(repo)
    evidence = repo / "local_archive" / "runtime" / "workflow-evidence" / "evidence.json"
    first = guard(
        repo,
        "run",
        "--snapshot",
        str(baseline),
        "--evidence",
        str(evidence),
        "--label",
        "first",
        "--",
        sys.executable,
        "-c",
        "raise SystemExit(0)",
    )
    assert first.returncode == 0
    document = json.loads(evidence.read_text(encoding="utf-8"))
    document["results"][0]["status"] = "failed"
    evidence.write_text(json.dumps(document), encoding="utf-8")

    second = guard(
        repo,
        "run",
        "--snapshot",
        str(baseline),
        "--evidence",
        str(evidence),
        "--label",
        "second",
        "--",
        sys.executable,
        "-c",
        "raise SystemExit(0)",
    )

    assert second.returncode == 2
    assert "checksum" in second.stderr


def test_run_reports_post_command_worktree_drift(tmp_path: Path) -> None:
    repo = setup_repo(tmp_path)
    baseline = snapshot(repo)
    evidence = repo / "local_archive" / "runtime" / "workflow-evidence" / "evidence.json"

    result = guard(
        repo,
        "run",
        "--snapshot",
        str(baseline),
        "--evidence",
        str(evidence),
        "--label",
        "mutates-worktree",
        "--",
        sys.executable,
        "-c",
        "from pathlib import Path; Path('tracked.txt').write_text('changed\\n')",
    )

    assert result.returncode == 4
    item = json.loads(evidence.read_text(encoding="utf-8"))["results"][0]
    assert item["status"] == "worktree_drift"
    assert "worktree_diff_sha256" in item["postcheck"]["changed"]


def test_post_command_drift_has_priority_over_command_failure(tmp_path: Path) -> None:
    repo = setup_repo(tmp_path)
    baseline = snapshot(repo)
    evidence = repo / "local_archive" / "runtime" / "workflow-evidence" / "evidence.json"

    result = guard(
        repo,
        "run",
        "--snapshot",
        str(baseline),
        "--evidence",
        str(evidence),
        "--label",
        "fail-and-drift",
        "--",
        sys.executable,
        "-c",
        "from pathlib import Path; Path('tracked.txt').write_text('changed\\n'); raise SystemExit(7)",
    )

    assert result.returncode == 4
    item = json.loads(evidence.read_text(encoding="utf-8"))["results"][0]
    assert item["exit_code"] == 7
    assert item["status"] == "worktree_drift"


def test_duplicate_label_is_rejected(tmp_path: Path) -> None:
    repo = setup_repo(tmp_path)
    baseline = snapshot(repo)
    evidence = repo / "local_archive" / "runtime" / "workflow-evidence" / "evidence.json"
    command = (
        "run",
        "--snapshot",
        str(baseline),
        "--evidence",
        str(evidence),
        "--label",
        "same",
        "--",
        sys.executable,
        "-c",
        "raise SystemExit(0)",
    )

    assert guard(repo, *command).returncode == 0
    assert guard(repo, *command).returncode == 2


def test_relative_executable_fingerprint_uses_repository_cwd(tmp_path: Path) -> None:
    repo = setup_repo(tmp_path)
    caller = tmp_path / "caller"
    caller.mkdir()
    repo_tool = repo / "tool"
    caller_tool = caller / "tool"
    repo_tool.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    caller_tool.write_text("#!/bin/sh\nexit 7\n", encoding="utf-8")
    repo_tool.chmod(0o755)
    caller_tool.chmod(0o755)
    baseline = snapshot(repo)
    evidence = repo / "local_archive" / "runtime" / "workflow-evidence" / "evidence.json"

    result = subprocess.run(
        [
            sys.executable,
            str(SCRIPT),
            "--repository",
            str(repo),
            "run",
            "--snapshot",
            str(baseline),
            "--evidence",
            str(evidence),
            "--label",
            "relative-tool",
            "--",
            "./tool",
        ],
        cwd=caller,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr
    item = json.loads(evidence.read_text(encoding="utf-8"))["results"][0]
    assert item["executable"]["realpath"] == str(repo_tool.resolve())
    assert item["executable"]["sha256"] == __import__("hashlib").sha256(repo_tool.read_bytes()).hexdigest()


def test_concurrent_runs_do_not_lose_results(tmp_path: Path) -> None:
    repo = setup_repo(tmp_path)
    baseline = snapshot(repo)
    evidence = repo / "local_archive" / "runtime" / "workflow-evidence" / "evidence.json"
    processes = []
    for index in range(8):
        processes.append(
            subprocess.Popen(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--repository",
                    str(repo),
                    "run",
                    "--snapshot",
                    str(baseline),
                    "--evidence",
                    str(evidence),
                    "--label",
                    f"parallel-{index}",
                    "--",
                    sys.executable,
                    "-c",
                    "raise SystemExit(0)",
                ],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                env=os.environ.copy(),
            )
        )

    completed = [process.communicate(timeout=20) + (process.returncode,) for process in processes]
    assert all(returncode == 0 for _, _, returncode in completed), completed
    document = json.loads(evidence.read_text(encoding="utf-8"))
    assert len(document["results"]) == 8
    assert len({item["label"] for item in document["results"]}) == 8


def test_verify_creates_unique_snapshot_and_evidence_for_one_command(tmp_path: Path) -> None:
    repo = setup_repo(tmp_path)

    result = guard(
        repo,
        "verify",
        "--label",
        "focused-tests",
        "--",
        sys.executable,
        "-c",
        "print('command output'); raise SystemExit(0)",
    )

    assert result.returncode == 0, result.stderr
    assert "command output" in result.stdout
    summary = verify_summary(result)
    snapshot_path = Path(summary["snapshot"])
    evidence_path = Path(summary["evidence"])
    expected_directory = repo / "local_archive" / "runtime" / "workflow-evidence"
    assert snapshot_path.parent == expected_directory
    assert evidence_path.parent == expected_directory
    assert snapshot_path != evidence_path
    assert snapshot_path.is_file()
    assert evidence_path.is_file()
    assert summary["label"] == "focused-tests"
    assert summary["status"] == "passed"
    evidence = json.loads(evidence_path.read_text(encoding="utf-8"))
    assert [item["label"] for item in evidence["results"]] == ["focused-tests"]


def test_verify_rejects_invalid_input_before_creating_artifacts(tmp_path: Path) -> None:
    repo = setup_repo(tmp_path)
    directory = repo / "local_archive" / "runtime" / "workflow-evidence"
    non_executable = repo / "non-executable"
    non_executable.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")

    invalid_label = guard(
        repo,
        "verify",
        "--label",
        "",
        "--",
        sys.executable,
        "-c",
        "raise SystemExit(0)",
    )
    missing_command = guard(repo, "verify", "--label", "missing-command")
    missing_executable = guard(
        repo,
        "verify",
        "--label",
        "missing-executable",
        "--",
        "workflow-guard-command-that-does-not-exist",
    )
    non_executable_result = guard(
        repo,
        "verify",
        "--label",
        "non-executable",
        "--",
        "./non-executable",
    )

    assert invalid_label.returncode == 2
    assert missing_command.returncode == 2
    assert missing_executable.returncode == 2
    assert non_executable_result.returncode == 2
    assert not directory.exists() or not any(directory.iterdir())


def test_verify_reports_command_worktree_drift(tmp_path: Path) -> None:
    repo = setup_repo(tmp_path)

    result = guard(
        repo,
        "verify",
        "--label",
        "mutating-check",
        "--",
        sys.executable,
        "-c",
        "from pathlib import Path; Path('tracked.txt').write_text('changed\\n')",
    )

    assert result.returncode == 4
    summary = verify_summary(result)
    assert summary["status"] == "worktree_drift"
    evidence = json.loads(Path(summary["evidence"]).read_text(encoding="utf-8"))
    assert evidence["results"][0]["status"] == "worktree_drift"


def test_verify_rejects_deleted_or_rewritten_snapshot_anchor(tmp_path: Path) -> None:
    for action in ("unlink()", "write_text('{}')"):
        case_directory = tmp_path / action.split("(")[0]
        case_directory.mkdir()
        repo = setup_repo(case_directory)
        result = guard(
            repo,
            "verify",
            "--label",
            f"snapshot-{action.split('(')[0]}",
            "--",
            sys.executable,
            "-c",
            (
                "from pathlib import Path; "
                "snapshot=next(Path('local_archive/runtime/workflow-evidence').glob('*-snapshot.json')); "
                f"snapshot.{action}"
            ),
        )

        assert result.returncode == 4
        summary = verify_summary(result)
        assert summary["status"] == "evidence_anchor_drift"
        evidence = json.loads(Path(summary["evidence"]).read_text(encoding="utf-8"))
        assert evidence["results"][0]["snapshot_anchor"]["matches"] is False


def test_verify_rejects_symlinked_evidence_directory(tmp_path: Path) -> None:
    repo = setup_repo(tmp_path)
    external = tmp_path / "external"
    external.mkdir()
    (repo / "local_archive").symlink_to(external, target_is_directory=True)

    result = guard(
        repo,
        "verify",
        "--label",
        "symlink-escape",
        "--",
        sys.executable,
        "-c",
        "raise SystemExit(0)",
    )

    assert result.returncode == 2
    assert not any(external.iterdir())


def test_verify_rejects_same_content_snapshot_symlink_replacement(tmp_path: Path) -> None:
    repo = setup_repo(tmp_path)
    external_snapshot = tmp_path / "external-snapshot.json"

    result = guard(
        repo,
        "verify",
        "--label",
        "snapshot-symlink",
        "--",
        sys.executable,
        "-c",
        (
            "from pathlib import Path; "
            "snapshot=next(Path('local_archive/runtime/workflow-evidence').glob('*-snapshot.json')); "
            f"external=Path({str(external_snapshot)!r}); "
            "external.write_bytes(snapshot.read_bytes()); snapshot.unlink(); snapshot.symlink_to(external)"
        ),
    )

    assert result.returncode == 4
    summary = verify_summary(result)
    assert summary["status"] == "evidence_anchor_drift"
    assert Path(summary["snapshot"]).is_symlink()


def test_verify_refuses_evidence_write_after_parent_directory_symlink_swap(tmp_path: Path) -> None:
    repo = setup_repo(tmp_path)
    external = tmp_path / "external-after-swap"
    external.mkdir()

    result = guard(
        repo,
        "verify",
        "--label",
        "directory-symlink-swap",
        "--",
        sys.executable,
        "-c",
        (
            "from pathlib import Path; "
            "directory=Path('local_archive/runtime/workflow-evidence'); "
            "directory.rename(directory.with_name('workflow-evidence-original')); "
            f"directory.symlink_to(Path({str(external)!r}), target_is_directory=True)"
        ),
    )

    assert result.returncode == 4
    summary = verify_summary(result)
    assert summary["status"] == "output_boundary_drift"
    assert not Path(summary["evidence"]).exists()
    assert not any(external.iterdir())


def test_project_rules_require_automatic_evidence_for_high_risk_completion() -> None:
    rules = (REPO_ROOT / "AGENTS.md").read_text(encoding="utf-8")

    assert "scripts/workflow_guard.py verify" in rules
    assert "high-risk" in rules
    assert "does not authorize" in rules


def test_governance_map_references_executable_evidence_contract() -> None:
    contract = (REPO_ROOT / "docs" / "governance" / "delivery-evidence.md").read_text(encoding="utf-8")
    skill_map = (REPO_ROOT / "docs" / "governance" / "skills.md").read_text(encoding="utf-8")
    doc_status = (REPO_ROOT / "docs" / "governance" / "doc_status.md").read_text(encoding="utf-8")

    assert "scripts/workflow_guard.py" in contract
    assert "scripts/workflow_guard.py verify" in contract
    assert "Feasibility Gate" in contract
    assert "Adversarial Acceptance" in contract
    assert "delivery-evidence.md" in skill_map
    assert "docs/governance/delivery-evidence.md" in doc_status
