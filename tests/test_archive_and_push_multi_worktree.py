"""Multi-worktree target-branch and legacy stuck-transaction recovery coverage.

Uses disposable Git repositories only.  The merge phase must never check out
the target branch in the source worktree: when no worktree holds it the branch
is advanced by update-ref; when another clean worktree holds it the
fast-forward runs inside that worktree.  Legacy transactions stuck at
merge/running with a null failure code recover only through the strictly
verified --integrate-main-into-feature path.
"""

from __future__ import annotations

import json
import hashlib
import os
import shlex
import shutil
import subprocess
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = REPO_ROOT / "scripts" / "archive_and_push.sh"
HELPER = REPO_ROOT / "scripts" / "archive_transaction_helper.py"
RECOVERY_FLAG = "--integrate-main-into-feature"


def git(cwd: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(cwd), *args], check=True, text=True, capture_output=True
    ).stdout.strip()


def run_archive(
    repo: Path, *args: str, extra_env: dict[str, str] | None = None
) -> subprocess.CompletedProcess[str]:
    env = os.environ | {
        "ARCHIVE_ROOT": str(repo),
        "ARCHIVE_HELPER": str(HELPER),
        "ARCHIVE_PYTHON_TEST_COMMAND": "printf python-ok",
        "ARCHIVE_NODE_TEST_COMMAND": "printf node-ok",
        "ARCHIVE_TEST_HEARTBEAT_SECONDS": "1",
    }
    if extra_env:
        env |= extra_env
    return subprocess.run(
        [str(SCRIPT), *args], text=True, capture_output=True, env=env, timeout=45
    )


def init_repo_with_remote(tmp_path: Path) -> tuple[Path, Path]:
    remote = tmp_path / "origin.git"
    repo = tmp_path / "repo"
    subprocess.run(["git", "init", "--bare", str(remote)], check=True, capture_output=True)
    subprocess.run(["git", "init", "-b", "main", str(repo)], check=True, capture_output=True)
    git(repo, "config", "user.name", "Multi Worktree Test")
    git(repo, "config", "user.email", "multi-worktree@example.test")
    (repo / "README.md").write_text("base\n", encoding="utf-8")
    git(repo, "add", "README.md")
    git(repo, "commit", "-m", "base")
    git(repo, "remote", "add", "origin", str(remote))
    git(repo, "push", "-u", "origin", "main")
    return repo, remote


def worktree_holding(repo: Path, branch: str) -> str | None:
    path = None
    for line in git(repo, "worktree", "list", "--porcelain").splitlines():
        if line.startswith("worktree "):
            path = line[len("worktree "):]
        elif line == f"branch refs/heads/{branch}":
            return path
    return None


def hold_main_in_second_worktree(tmp_path: Path, repo: Path) -> Path:
    candidate = tmp_path / "main-worktree"
    git(repo, "worktree", "add", str(candidate), "main")
    held = worktree_holding(repo, "main")
    assert held is not None
    return Path(held)


def make_linear_repo(tmp_path: Path, *, held_main: bool) -> tuple[Path, Path, str, Path | None]:
    """feature/archive is strictly ahead of main (main is an ancestor)."""
    repo, remote = init_repo_with_remote(tmp_path)
    base = git(repo, "rev-parse", "main")
    git(repo, "switch", "-c", "feature/archive")
    (repo / "feature.txt").write_text("feature\n", encoding="utf-8")
    git(repo, "add", "feature.txt")
    git(repo, "commit", "-m", "feature")
    feature = git(repo, "rev-parse", "HEAD")
    assert git(repo, "merge-base", "--is-ancestor", "main", "feature/archive") == ""
    main_worktree = hold_main_in_second_worktree(tmp_path, repo) if held_main else None
    assert git(repo, "rev-parse", "main") == base
    return repo, remote, feature, main_worktree


def make_diverged_repo(
    tmp_path: Path, *, held_main: bool, leave_uncommitted: bool = False
) -> tuple[Path, Path, str, str, Path | None]:
    """feature/archive and main diverge from the common base commit."""
    repo, remote = init_repo_with_remote(tmp_path)
    git(repo, "switch", "-c", "feature/archive")
    (repo / "feature.txt").write_text("feature\n", encoding="utf-8")
    git(repo, "add", "feature.txt")
    git(repo, "commit", "-m", "feature")
    feature = git(repo, "rev-parse", "HEAD")
    git(repo, "switch", "main")
    (repo / "main.txt").write_text("main\n", encoding="utf-8")
    git(repo, "add", "main.txt")
    git(repo, "commit", "-m", "main advance")
    main = git(repo, "rev-parse", "HEAD")
    git(repo, "push", "origin", "main")
    git(repo, "switch", "feature/archive")
    if leave_uncommitted:
        # Let the transaction itself create the feature commit, mirroring the
        # legacy stuck transaction (commit_result.status == "succeeded").
        git(repo, "reset", "--hard", "HEAD~1")
        (repo / "feature.txt").write_text("feature\n", encoding="utf-8")
        feature = git(repo, "rev-parse", "HEAD")
    main_worktree = hold_main_in_second_worktree(tmp_path, repo) if held_main else None
    return repo, remote, feature, main, main_worktree


def read_journal(journal: Path) -> dict[str, object]:
    return json.loads(journal.read_text(encoding="utf-8"))


def only_journal(repo: Path) -> Path:
    return next((repo / "local_archive" / "runtime" / "archive-and-push").glob("*/transaction.json"))


def recover(
    repo: Path, journal: Path, *, extra_env: dict[str, str] | None = None
) -> subprocess.CompletedProcess[str]:
    return run_archive(repo, "--resume", journal.parent.name, RECOVERY_FLAG, extra_env=extra_env)


def legacy_stuck_transaction(
    tmp_path: Path, *, held_main: bool, with_log: bool
) -> tuple[Path, Path, Path, str, str, Path | None]:
    """Replicate the known legacy state: merge/running with a null failure code.

    The transaction validates and commits, then dies abruptly at the merge
    phase.  With with_log the transaction logs carry the precise target-branch
    checkout-conflict error quoted with the holding worktree path.
    """
    repo, remote, source_head, main, main_worktree = make_diverged_repo(
        tmp_path, held_main=held_main, leave_uncommitted=True
    )
    failed = run_archive(repo, "--push")
    assert failed.returncode == 64, (failed.stdout, failed.stderr)
    journal = only_journal(repo)
    recorded = read_journal(journal)
    feature = str(recorded["head_sha"])
    assert recorded["commit_result"] == {"commit_sha": feature, "status": "succeeded"}
    assert recorded["validation_status"] == "ran"
    assert git(repo, "rev-parse", "feature/archive") == feature
    recorded["phase_status"] = "running"
    recorded["failure_code"] = None
    recorded["failure_stage"] = None
    recorded["merge_result"] = {"status": "pending"}
    journal.write_text(json.dumps(recorded), encoding="utf-8")
    summary = journal.parent / "failure-summary.md"
    if summary.exists():
        summary.unlink()
    if with_log:
        assert main_worktree is not None
        (journal.parent / "logs" / "merge.log").write_text(
            f"+ git -C {repo} checkout main\n"
            f"fatal: 'main' is already checked out at '{main_worktree}'\n",
            encoding="utf-8",
        )
    return repo, remote, journal, feature, main, main_worktree


def marker_commands(tmp_path: Path) -> tuple[dict[str, str], Path, Path]:
    python_marker = tmp_path / "python-marker.txt"
    node_marker = tmp_path / "node-marker.txt"
    env = {
        "ARCHIVE_PYTHON_TEST_COMMAND": f"printf 'bound-python\\n' >> {shlex.quote(str(python_marker))}",
        "ARCHIVE_NODE_TEST_COMMAND": f"printf 'bound-node\\n' >> {shlex.quote(str(node_marker))}",
    }
    return env, python_marker, node_marker


def assert_no_legacy_success_evidence(
    journal: Path, merge_log_before: bytes | None = None
) -> None:
    recorded = read_journal(journal)
    merge_log = journal.parent / "logs" / "merge.log"
    if merge_log_before is None:
        assert not merge_log.exists()
    else:
        assert merge_log.read_bytes() == merge_log_before
    assert recorded.get("legacy_recovery") is None
    assert "legacy_merge_running_main_worktree_conflict" not in journal.read_text(
        encoding="utf-8"
    )
    assert recorded.get("recovery_authorized") is not True


def rewrite_validation_record(journal: Path, **updates: object) -> None:
    evidence = journal.parent / "validation-record.json"
    record = json.loads(evidence.read_text(encoding="utf-8"))
    record.update(updates)
    record.pop("checksum", None)
    digest = json.dumps(record, sort_keys=True, separators=(",", ":")).encode()
    record["checksum"] = hashlib.sha256(digest).hexdigest()
    evidence.write_text(json.dumps(record), encoding="utf-8")
    journaled = read_journal(journal)
    journaled["validation_record_checksum"] = record["checksum"]
    journal.write_text(json.dumps(journaled), encoding="utf-8")


def test_linear_fast_forward_when_target_branch_has_no_worktree(tmp_path: Path) -> None:
    repo, remote, feature, _wt = make_linear_repo(tmp_path, held_main=False)

    result = run_archive(repo, "--push")

    assert result.returncode == 0, (result.stdout, result.stderr)
    # The source worktree is never switched; main advances by update-ref.
    assert git(repo, "branch", "--show-current") == "feature/archive"
    assert git(repo, "rev-parse", "HEAD") == feature
    assert git(repo, "rev-parse", "main") == feature
    assert git(repo, "--git-dir", str(remote), "rev-parse", "main") == feature
    journal = read_journal(only_journal(repo))
    assert journal["phase"] == "completed"
    assert journal["merge_result"]["status"] == "succeeded"


def test_linear_fast_forward_inside_the_worktree_holding_main(tmp_path: Path) -> None:
    repo, remote, feature, main_worktree = make_linear_repo(tmp_path, held_main=True)
    assert main_worktree is not None

    result = run_archive(repo, "--push")

    assert result.returncode == 0, (result.stdout, result.stderr)
    # The fast-forward ran inside the holding worktree and updated its files.
    assert git(main_worktree, "rev-parse", "HEAD") == feature
    assert (main_worktree / "feature.txt").is_file()
    assert worktree_holding(repo, "main") == str(main_worktree)
    assert git(repo, "branch", "--show-current") == "feature/archive"
    assert git(repo, "rev-parse", "main") == feature
    assert git(repo, "--git-dir", str(remote), "rev-parse", "main") == feature
    assert read_journal(only_journal(repo))["merge_result"]["status"] == "succeeded"


def test_diverged_feature_with_held_main_fails_64_then_recovers(tmp_path: Path) -> None:
    repo, remote, journal_feature, main, main_worktree = make_diverged_repo(
        tmp_path, held_main=True
    )

    failed = run_archive(repo, "--push")

    assert failed.returncode == 64, (failed.stdout, failed.stderr)
    journal = only_journal(repo)
    recorded = read_journal(journal)
    assert recorded["phase"] == "merge"
    assert recorded["phase_status"] == "failed"
    assert recorded["failure_code"] == "64"
    # Structured divergence before any mutation: nothing moved anywhere.
    assert git(repo, "branch", "--show-current") == "feature/archive"
    assert git(repo, "rev-parse", "main") == main
    assert git(main_worktree, "rev-parse", "HEAD") == main  # type: ignore[arg-type]
    assert git(repo, "--git-dir", str(remote), "rev-parse", "main") == main

    result = recover(repo, journal)

    assert result.returncode == 0, (result.stdout, result.stderr)
    recorded = read_journal(journal)
    effective = str(recorded["effective_feature_tip"])
    parents = git(repo, "show", "-s", "--format=%P", effective).split()
    assert parents == [journal_feature, main]
    assert git(main_worktree, "rev-parse", "HEAD") == effective  # type: ignore[arg-type]
    assert git(repo, "rev-parse", "main") == effective
    assert git(repo, "--git-dir", str(remote), "rev-parse", "main") == effective
    assert recorded["recovery_phase"] == "recovery/completed"


def test_dirty_target_worktree_fails_closed_without_git_mutation(tmp_path: Path) -> None:
    repo, remote, feature, main_worktree = make_linear_repo(tmp_path, held_main=True)
    assert main_worktree is not None
    main_before = git(repo, "rev-parse", "main")
    (main_worktree / "dirty.txt").write_text("dirty\n", encoding="utf-8")

    result = run_archive(repo, "--push")

    assert result.returncode == 65, (result.stdout, result.stderr)
    journal = read_journal(only_journal(repo))
    assert journal["phase"] == "merge"
    assert journal["phase_status"] == "failed"
    assert journal["failure_code"] == "65"
    assert journal["commit_result"]["status"] == "precommitted_branch"
    # Fail closed: the target ref and both worktrees are untouched.
    assert git(repo, "rev-parse", "main") == main_before
    assert git(main_worktree, "rev-parse", "HEAD") == main_before
    assert git(repo, "branch", "--show-current") == "feature/archive"
    assert git(repo, "rev-parse", "HEAD") == feature
    assert git(repo, "--git-dir", str(remote), "rev-parse", "main") == main_before


def test_target_worktree_with_merge_in_progress_fails_closed(tmp_path: Path) -> None:
    repo, remote, feature, main_worktree = make_linear_repo(tmp_path, held_main=True)
    assert main_worktree is not None
    main_before = git(repo, "rev-parse", "main")
    merge_head = Path(git(main_worktree, "rev-parse", "--git-path", "MERGE_HEAD"))
    if not merge_head.is_absolute():
        merge_head = main_worktree / merge_head
    merge_head.write_text(f"{feature}\n", encoding="utf-8")

    result = run_archive(repo, "--push")

    assert result.returncode == 65, (result.stdout, result.stderr)
    journal = read_journal(only_journal(repo))
    assert journal["phase"] == "merge"
    assert journal["phase_status"] == "failed"
    assert journal["failure_code"] == "65"
    assert git(repo, "rev-parse", "main") == main_before
    assert git(main_worktree, "rev-parse", "HEAD") == main_before
    assert git(repo, "branch", "--show-current") == "feature/archive"
    assert git(repo, "--git-dir", str(remote), "rev-parse", "main") == main_before


def break_remote_at_merge_helper(tmp_path: Path, repo: Path) -> Path:
    path = tmp_path / "break-remote-helper.py"
    path.write_text(
        "import runpy,subprocess,sys\n"
        "argv=' '.join(sys.argv[1:])\n"
        "matched='journal-update' in argv and '--phase merge' in argv\n"
        "try:\n"
        f"    runpy.run_path({str(HELPER)!r}, run_name='__main__')\n"
        "except SystemExit as exc:\n"
        "    if exc.code not in (None, 0): raise\n"
        "if matched:\n"
        f"    subprocess.run(['git','-C',{str(repo)!r},'remote','set-url','origin',{str(tmp_path / 'gone.git')!r}], check=True)\n",
        encoding="utf-8",
    )
    return path


def test_git_command_failure_is_journaled_never_left_running(tmp_path: Path) -> None:
    repo, remote, feature, _wt = make_linear_repo(tmp_path, held_main=False)
    main_before = git(repo, "rev-parse", "main")
    breaker = break_remote_at_merge_helper(tmp_path, repo)

    result = run_archive(repo, "--push", extra_env={"ARCHIVE_HELPER": str(breaker)})

    assert result.returncode == 44, (result.stdout, result.stderr)
    journal = read_journal(only_journal(repo))
    assert journal["phase"] == "merge"
    assert journal["phase_status"] == "failed"
    assert journal["failure_stage"] == "fetch"
    assert journal["failure_code"] == "44"
    assert git(repo, "rev-parse", "main") == main_before
    assert git(repo, "branch", "--show-current") == "feature/archive"


def test_recovery_entry_fetch_failure_is_journaled_and_same_transaction_retries(
    tmp_path: Path,
) -> None:
    repo, remote, journal, feature, main, main_worktree = legacy_stuck_transaction(
        tmp_path, held_main=True, with_log=True
    )
    assert main_worktree is not None
    git(repo, "remote", "set-url", "origin", str(tmp_path / "unreachable.git"))

    failed = recover(repo, journal)

    assert failed.returncode == 96, (failed.stdout, failed.stderr)
    recorded = read_journal(journal)
    assert recorded["phase"] == "merge"
    assert recorded["phase_status"] == "failed"
    assert recorded["failure_stage"] == "recovery_fetch"
    assert recorded["failure_code"] == "96"
    assert recorded["recovery_phase"] == "recovery/preflight"
    assert recorded["recovery_phase_status"] == "failed"
    assert recorded["original_failure"] == {
        "phase": "merge",
        "phase_status": "running",
        "failure_stage": None,
        "failure_code": None,
    }
    assert any(
        event["phase"] == "recovery/preflight" and event["status"] == "failed"
        for event in recorded["recovery_history"]
    )
    assert (journal.parent / "failure-summary.md").is_file()
    assert git(repo, "rev-parse", "feature/archive") == feature
    assert git(repo, "rev-parse", "main") == main
    assert git(main_worktree, "rev-parse", "HEAD") == main
    assert git(repo, "--git-dir", str(remote), "rev-parse", "main") == main

    git(repo, "remote", "set-url", "origin", str(remote))
    retried = recover(repo, journal)

    assert retried.returncode == 0, (retried.stdout, retried.stderr)
    assert read_journal(journal)["phase"] == "completed"


def test_legacy_stuck_transaction_with_captured_conflict_evidence_recovers(tmp_path: Path) -> None:
    repo, remote, journal, feature, main, main_worktree = legacy_stuck_transaction(
        tmp_path, held_main=True, with_log=True
    )
    validation = journal.parent / "validation-record.json"
    validation_before = validation.read_bytes()

    result = recover(repo, journal)

    assert result.returncode == 0, (result.stdout, result.stderr)
    recorded = read_journal(journal)
    effective = str(recorded["effective_feature_tip"])
    # The legacy stuck transaction is completed through the two-parent merge.
    assert recorded["phase"] == "completed"
    assert recorded["phase_status"] == "succeeded"
    assert recorded["recovery_phase"] == "recovery/completed"
    assert recorded["legacy_recovery"]["reason"] == "legacy_merge_running_main_worktree_conflict"
    assert recorded["legacy_recovery"]["evidence_source"] == "captured_log"
    assert recorded["legacy_recovery"]["main_worktree"] == str(main_worktree)
    parents = git(repo, "show", "-s", "--format=%P", effective).split()
    assert parents == [feature, main]
    assert git(repo, "rev-parse", "feature/archive") == effective
    assert git(repo, "rev-parse", "main") == effective
    assert git(main_worktree, "rev-parse", "HEAD") == effective  # type: ignore[arg-type]
    assert git(repo, "--git-dir", str(remote), "rev-parse", "main") == effective
    # No second archive transaction and the original evidence is preserved.
    transactions = list((repo / "local_archive" / "runtime" / "archive-and-push").glob("*/transaction.json"))
    assert transactions == [journal]
    assert recorded["head_sha"] == feature
    assert recorded["original_failure"]["phase"] == "merge"
    assert recorded["original_failure"]["phase_status"] == "running"
    assert recorded["original_failure"]["failure_code"] in (None, "")
    assert validation.read_bytes() == validation_before
    archive = repo / str(recorded["archive_record_path"])
    assert f"- Transaction ID: {journal.parent.name}" in archive.read_text(encoding="utf-8")
    assert f"- Effective feature tip: {effective}" in archive.read_text(encoding="utf-8")
    # A repeated recovery is an idempotent no-op.
    journal_before = journal.read_bytes()
    repeated = recover(repo, journal)
    assert repeated.returncode == 0, (repeated.stdout, repeated.stderr)
    assert journal.read_bytes() == journal_before


def test_legacy_stuck_transaction_without_log_recovers_via_topology_probe(tmp_path: Path) -> None:
    repo, remote, journal, feature, main, main_worktree = legacy_stuck_transaction(
        tmp_path, held_main=True, with_log=False
    )
    assert main_worktree is not None
    assert not (journal.parent / "logs" / "merge.log").exists()

    result = recover(repo, journal)

    assert result.returncode == 0, (result.stdout, result.stderr)
    recorded = read_journal(journal)
    effective = str(recorded["effective_feature_tip"])
    assert recorded["phase"] == "completed"
    assert recorded["phase_status"] == "succeeded"
    assert recorded["legacy_recovery"]["reason"] == "legacy_merge_running_main_worktree_conflict"
    assert recorded["legacy_recovery"]["evidence_source"] == "worktree_topology_probe"
    merge_log = (journal.parent / "logs" / "merge.log").read_text(encoding="utf-8")
    assert f"'main' is already checked out at '{main_worktree}'" in merge_log
    parents = git(repo, "show", "-s", "--format=%P", effective).split()
    assert parents == [feature, main]
    assert git(main_worktree, "rev-parse", "HEAD") == effective
    assert git(repo, "--git-dir", str(remote), "rev-parse", "main") == effective


def test_legacy_recovery_refuses_when_target_main_changed(tmp_path: Path) -> None:
    repo, remote, journal, feature, main, main_worktree = legacy_stuck_transaction(
        tmp_path, held_main=True, with_log=False
    )
    assert main_worktree is not None
    (main_worktree / "main-again.txt").write_text("main again\n", encoding="utf-8")
    git(main_worktree, "add", "main-again.txt")
    git(main_worktree, "commit", "-m", "main moved")
    git(main_worktree, "push", "origin", "main")

    result = recover(repo, journal)

    assert result.returncode != 0
    recorded = read_journal(journal)
    assert recorded["recovery_phase"] == "recovery/failed"
    assert "main changed" in str(recorded["recovery_failure_reason"])
    assert recorded.get("recovery_authorized") is not True
    assert recorded.get("recovery_merge_commit") is None
    assert git(repo, "rev-parse", "feature/archive") == feature
    assert git(repo, "rev-parse", "main") == git(main_worktree, "rev-parse", "HEAD")
    assert not (journal.parent / "recovery-worktree").exists()
    assert_no_legacy_success_evidence(journal)


def test_legacy_recovery_refuses_without_log_and_without_conflict_proof(tmp_path: Path) -> None:
    repo, _remote, journal, feature, main, _wt = legacy_stuck_transaction(
        tmp_path, held_main=False, with_log=False
    )

    result = recover(repo, journal)

    assert result.returncode != 0
    recorded = read_journal(journal)
    assert recorded["recovery_phase"] == "recovery/failed"
    assert "checkout-conflict evidence" in str(recorded["recovery_failure_reason"])
    assert recorded.get("recovery_authorized") is not True
    assert git(repo, "rev-parse", "feature/archive") == feature
    assert git(repo, "rev-parse", "main") == main
    assert not (journal.parent / "recovery-worktree").exists()
    assert_no_legacy_success_evidence(journal)


def test_legacy_recovery_refuses_when_feature_commit_changed(tmp_path: Path) -> None:
    repo, _remote, journal, feature, main, main_worktree = legacy_stuck_transaction(
        tmp_path, held_main=True, with_log=False
    )
    git(repo, "commit", "--allow-empty", "-m", "unexpected feature advance")
    unexpected = git(repo, "rev-parse", "feature/archive")

    result = recover(repo, journal)

    assert result.returncode != 0
    recorded = read_journal(journal)
    assert recorded["recovery_phase"] == "recovery/failed"
    assert "feature commit changed" in str(recorded["recovery_failure_reason"])
    assert recorded.get("recovery_authorized") is not True
    assert git(repo, "rev-parse", "feature/archive") == unexpected
    assert git(repo, "rev-parse", "main") == main
    assert git(main_worktree, "rev-parse", "HEAD") == main  # type: ignore[arg-type]
    assert not (journal.parent / "recovery-worktree").exists()
    assert_no_legacy_success_evidence(journal)


def test_legacy_recovery_refuses_with_invalid_validation_evidence(tmp_path: Path) -> None:
    repo, _remote, journal, feature, main, _wt = legacy_stuck_transaction(
        tmp_path, held_main=True, with_log=False
    )
    evidence = journal.parent / "validation-record.json"
    record = json.loads(evidence.read_text(encoding="utf-8"))
    record["commands"] = ["true", "true"]
    evidence.write_text(json.dumps(record), encoding="utf-8")

    result = recover(repo, journal)

    assert result.returncode != 0
    recorded = read_journal(journal)
    assert recorded["recovery_phase"] == "recovery/failed"
    assert "evidence" in str(recorded["recovery_failure_reason"])
    assert recorded.get("recovery_authorized") is not True
    assert recorded.get("recovery_merge_commit") is None
    assert git(repo, "rev-parse", "feature/archive") == feature
    assert git(repo, "rev-parse", "main") == main
    assert not (journal.parent / "recovery-worktree").exists()
    assert_no_legacy_success_evidence(journal)


@pytest.mark.parametrize(
    "case",
    [
        "validation_missing",
        "validation_repository_mismatch",
        "validation_head_mismatch",
        "push_succeeded",
        "archive_succeeded",
        "archive_record_exists",
        "dirty_feature_holder",
        "dirty_main_holder",
        "wrong_common_dir",
        "non_conflict_cause",
    ],
)
def test_legacy_qualification_rejections_never_write_success_evidence(
    tmp_path: Path, case: str
) -> None:
    repo, remote, journal, feature, main, main_worktree = legacy_stuck_transaction(
        tmp_path, held_main=True, with_log=False
    )
    assert main_worktree is not None
    extra_env: dict[str, str] | None = None
    if case == "validation_missing":
        (journal.parent / "validation-record.json").unlink()
    elif case == "validation_repository_mismatch":
        rewrite_validation_record(journal, repository_realpath=str(tmp_path / "other-repo"))
    elif case == "validation_head_mismatch":
        rewrite_validation_record(journal, head_sha=main)
    elif case == "push_succeeded":
        recorded = read_journal(journal)
        recorded["push_result"] = {"status": "succeeded", "head": feature}
        journal.write_text(json.dumps(recorded), encoding="utf-8")
    elif case == "archive_succeeded":
        recorded = read_journal(journal)
        recorded["archive_result"] = {"status": "succeeded"}
        journal.write_text(json.dumps(recorded), encoding="utf-8")
    elif case == "archive_record_exists":
        archive = repo / str(read_journal(journal)["archive_record_path"])
        archive.parent.mkdir(parents=True, exist_ok=True)
        archive.write_text("unrelated archive\n", encoding="utf-8")
    elif case == "dirty_feature_holder":
        (repo / "dirty-feature.txt").write_text("dirty\n", encoding="utf-8")
    elif case == "dirty_main_holder":
        (main_worktree / "dirty-main.txt").write_text("dirty\n", encoding="utf-8")
    elif case == "wrong_common_dir":
        real_git = shutil.which("git")
        assert real_git is not None
        wrapper_dir = tmp_path / "bin"
        wrapper_dir.mkdir()
        wrapper = wrapper_dir / "git"
        wrapper.write_text(
            "#!/bin/sh\n"
            f"if [ \"$1\" = -C ] && [ \"$2\" = {shlex.quote(str(main_worktree))} ] && "
            "[ \"$3\" = rev-parse ] && [ \"$4\" = --git-common-dir ]; then\n"
            "  printf '/different/common-dir\\n'\n"
            "  exit 0\n"
            "fi\n"
            f"exec {shlex.quote(real_git)} \"$@\"\n",
            encoding="utf-8",
        )
        wrapper.chmod(0o755)
        extra_env = {"PATH": f"{wrapper_dir}{os.pathsep}{os.environ['PATH']}"}
    elif case == "non_conflict_cause":
        (journal.parent / "logs" / "merge.log").write_text(
            "fatal: unrelated merge failure\n", encoding="utf-8"
        )
    merge_log = journal.parent / "logs" / "merge.log"
    merge_log_before = merge_log.read_bytes() if merge_log.exists() else None

    result = recover(repo, journal, extra_env=extra_env)

    assert result.returncode != 0, case
    assert git(repo, "rev-parse", "feature/archive") == feature
    assert git(repo, "rev-parse", "main") == main
    assert git(main_worktree, "rev-parse", "HEAD") == main
    assert git(repo, "--git-dir", str(remote), "rev-parse", "main") == main
    assert not (journal.parent / "recovery-worktree").exists()
    assert_no_legacy_success_evidence(journal, merge_log_before)


def test_legacy_recovery_ignores_environment_validation_command_override(tmp_path: Path) -> None:
    env, python_marker, node_marker = marker_commands(tmp_path)
    repo, _remote, _source_head, main, _wt = make_diverged_repo(
        tmp_path, held_main=True, leave_uncommitted=True
    )
    failed = run_archive(repo, "--push", extra_env=env)
    assert failed.returncode == 64, (failed.stdout, failed.stderr)
    journal = only_journal(repo)
    recorded = read_journal(journal)
    feature = str(recorded["head_sha"])
    recorded["phase_status"] = "running"
    recorded["failure_code"] = None
    recorded["failure_stage"] = None
    recorded["merge_result"] = {"status": "pending"}
    journal.write_text(json.dumps(recorded), encoding="utf-8")
    main_worktree = worktree_holding(repo, "main")
    (journal.parent / "logs" / "merge.log").write_text(
        f"fatal: 'main' is already checked out at '{main_worktree}'\n", encoding="utf-8"
    )
    assert python_marker.read_text(encoding="utf-8") == "bound-python\n"
    assert node_marker.read_text(encoding="utf-8") == "bound-node\n"

    result = recover(
        repo,
        journal,
        extra_env={"ARCHIVE_PYTHON_TEST_COMMAND": "true", "ARCHIVE_NODE_TEST_COMMAND": "true"},
    )

    assert result.returncode == 0, (result.stdout, result.stderr)
    # The transaction-bound commands reran exactly once more; `true` never ran.
    assert python_marker.read_text(encoding="utf-8") == "bound-python\nbound-python\n"
    assert node_marker.read_text(encoding="utf-8") == "bound-node\nbound-node\n"
    recorded = read_journal(journal)
    assert recorded["recovery_validation_command_override"] == {
        "policy": "ignored",
        "python": True,
        "node": True,
        "command_source": "original_validation_record",
    }
    recovery_validation = recorded["recovery_validation_record"]
    assert recovery_validation["status"] == "passed"
    assert recovery_validation["command_source"] == "original_validation_record"
    assert recovery_validation["commands"][0].startswith("printf 'bound-python")
    assert recorded["phase"] == "completed"
    assert recorded["recovery_phase"] == "recovery/completed"
