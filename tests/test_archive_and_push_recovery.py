"""Divergence-recovery coverage using disposable Git repositories only."""

from __future__ import annotations

import hashlib
import json
import os
import shlex
import subprocess
import sys
from pathlib import Path


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


def failed_divergent_transaction(
    tmp_path: Path, *, conflict: bool = False, extra_env: dict[str, str] | None = None
) -> tuple[Path, Path, Path, str, str, str]:
    remote = tmp_path / "origin.git"
    repo = tmp_path / "repo"
    subprocess.run(["git", "init", "--bare", str(remote)], check=True, capture_output=True)
    subprocess.run(["git", "init", "-b", "main", str(repo)], check=True, capture_output=True)
    git(repo, "config", "user.name", "Archive Recovery Test")
    git(repo, "config", "user.email", "archive-recovery@example.test")
    (repo / "README.md").write_text("base\n", encoding="utf-8")
    git(repo, "add", "README.md")
    git(repo, "commit", "-m", "base")
    base = git(repo, "rev-parse", "HEAD")
    git(repo, "remote", "add", "origin", str(remote))
    git(repo, "push", "-u", "origin", "main")

    git(repo, "switch", "-c", "feature/archive")
    feature_path = repo / ("README.md" if conflict else "feature.txt")
    feature_path.write_text("feature\n", encoding="utf-8")
    git(repo, "add", feature_path.name)
    git(repo, "commit", "-m", "feature")
    feature = git(repo, "rev-parse", "HEAD")

    git(repo, "switch", "main")
    main_path = repo / ("README.md" if conflict else "main.txt")
    main_path.write_text("main\n", encoding="utf-8")
    git(repo, "add", main_path.name)
    git(repo, "commit", "-m", "main advance")
    main = git(repo, "rev-parse", "HEAD")
    git(repo, "push", "origin", "main")
    git(repo, "switch", "feature/archive")

    failed = run_archive(repo, "--push", extra_env=extra_env)
    assert failed.returncode == 64, (failed.stdout, failed.stderr)
    journal = next(
        (repo / "local_archive" / "runtime" / "archive-and-push").glob("*/transaction.json")
    )
    recorded = json.loads(journal.read_text(encoding="utf-8"))
    assert recorded["phase"] == "merge"
    assert recorded["phase_status"] == "failed"
    assert recorded["failure_code"] == "64"
    assert recorded["head_sha"] == feature
    # Divergence is detected by ancestry before any checkout, so the source
    # worktree is never switched off the feature branch.
    assert git(repo, "branch", "--show-current") == "feature/archive"
    assert git(repo, "rev-parse", "main") == main
    return repo, remote, journal, base, feature, main


def recover(
    repo: Path, journal: Path, *, extra_env: dict[str, str] | None = None
) -> subprocess.CompletedProcess[str]:
    return run_archive(
        repo,
        "--resume",
        journal.parent.name,
        RECOVERY_FLAG,
        extra_env=extra_env,
    )


def read_journal(journal: Path) -> dict[str, object]:
    return json.loads(journal.read_text(encoding="utf-8"))


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def record_digest(record: dict[str, object]) -> str:
    copied = {key: value for key, value in record.items() if key != "checksum"}
    raw = json.dumps(copied, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode()
    return hashlib.sha256(raw).hexdigest()


def manifest_digest(manifest: dict[str, object]) -> str:
    content = {key: value for key, value in manifest.items() if key != "checksum"}
    raw = json.dumps(content, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    return hashlib.sha256(raw).hexdigest()


def marker_commands(tmp_path: Path) -> tuple[dict[str, str], Path, Path, str, str]:
    python_marker = tmp_path / "python-marker.txt"
    node_marker = tmp_path / "node-marker.txt"
    python_command = f"printf 'bound-python\\n' >> {shlex.quote(str(python_marker))}"
    node_command = f"printf 'bound-node\\n' >> {shlex.quote(str(node_marker))}"
    env = {
        "ARCHIVE_PYTHON_TEST_COMMAND": python_command,
        "ARCHIVE_NODE_TEST_COMMAND": node_command,
    }
    return env, python_marker, node_marker, python_command, node_command


def assert_recovery_merge(repo: Path, feature: str, main: str, effective: str) -> None:
    parents = git(repo, "show", "-s", "--format=%P", effective).split()
    assert parents == [feature, main]
    assert git(repo, "merge-base", "--is-ancestor", feature, effective) == ""
    assert git(repo, "merge-base", "--is-ancestor", main, effective) == ""


def crash_helper(tmp_path: Path, needle: str, *, after: bool = False) -> Path:
    path = tmp_path / f"crash-{'after' if after else 'before'}.py"
    path.write_text(
        "import runpy,sys\n"
        f"needle={needle!r}\n"
        f"after={after!r}\n"
        "matched=needle in ' '.join(sys.argv[1:])\n"
        "if matched and not after: raise SystemExit(97)\n"
        "try:\n"
        f"    runpy.run_path({str(HELPER)!r}, run_name='__main__')\n"
        "except SystemExit as exc:\n"
        "    if exc.code not in (None, 0): raise\n"
        "if matched and after: raise SystemExit(97)\n",
        encoding="utf-8",
    )
    return path


def main_race_helper(tmp_path: Path, repo: Path) -> Path:
    path = tmp_path / "main-race-helper.py"
    path.write_text(
        "import runpy,subprocess,sys\n"
        "matched='recovery/worktree-created' in ' '.join(sys.argv[1:])\n"
        "try:\n"
        f"    runpy.run_path({str(HELPER)!r}, run_name='__main__')\n"
        "except SystemExit as exc:\n"
        "    if exc.code not in (None, 0): raise\n"
        "if matched:\n"
        # The source worktree stays on the feature branch during the
        # transaction, so the main race is committed straight onto the ref.
        f"    base=subprocess.check_output(['git','-C',{str(repo)!r},'rev-parse','main'], text=True).strip()\n"
        f"    tree=subprocess.check_output(['git','-C',{str(repo)!r},'rev-parse','main^{{tree}}'], text=True).strip()\n"
        f"    new=subprocess.check_output(['git','-C',{str(repo)!r},'commit-tree',tree,'-p',base,'-m','main race'], text=True).strip()\n"
        f"    subprocess.run(['git','-C',{str(repo)!r},'update-ref','refs/heads/main',new,base], check=True)\n"
        f"    subprocess.run(['git','-C',{str(repo)!r},'push','origin','main'], check=True)\n",
        encoding="utf-8",
    )
    return path


def install_push_counter(remote: Path, counter: Path) -> None:
    hook = remote / "hooks" / "pre-receive"
    hook.write_text(
        "#!/usr/bin/env bash\n"
        f"count=0; [ ! -f {str(counter)!r} ] || count=$(cat {str(counter)!r})\n"
        f"printf '%s' $((count + 1)) > {str(counter)!r}\n",
        encoding="utf-8",
    )
    hook.chmod(0o755)


def test_non_conflicting_divergence_recovers_with_two_parent_merge_and_reruns_validation(
    tmp_path: Path,
) -> None:
    repo, remote, journal, base, feature, main = failed_divergent_transaction(tmp_path)
    counter = tmp_path / "validation-count"
    override = f"printf x >> {shlex.quote(str(counter))}"

    result = recover(
        repo,
        journal,
        extra_env={
            "ARCHIVE_PYTHON_TEST_COMMAND": override,
            "ARCHIVE_NODE_TEST_COMMAND": override,
        },
    )

    assert result.returncode == 0, (result.stdout, result.stderr)
    recorded = read_journal(journal)
    effective = str(recorded["effective_feature_tip"])
    assert_recovery_merge(repo, feature, main, effective)
    assert recorded["original_feature_commit"] == feature
    assert recorded["original_main_commit"] == main
    assert recorded["original_base_commit"] == base
    assert recorded["recovery_phase"] == "recovery/completed"
    recovery_validation = recorded["recovery_validation_record"]
    assert recovery_validation["status"] == "passed"
    # The recovery-environment override is never executed; the original
    # transaction-bound commands are rerun instead.
    assert not counter.exists()
    assert recovery_validation["command_source"] == "original_validation_record"
    assert recovery_validation["commands"] == ["printf python-ok", "printf node-ok"]
    assert recovery_validation["command_checksums"] == [
        sha256_text("printf python-ok"),
        sha256_text("printf node-ok"),
    ]
    assert recovery_validation["original_evidence_path"] == recorded["validation_record_path"]
    assert recovery_validation["original_evidence_checksum"] == recorded["validation_record_checksum"]
    assert recorded["recovery_validation_command_override"] == {
        "policy": "ignored",
        "python": True,
        "node": True,
        "command_source": "original_validation_record",
    }
    assert "printf python-ok" in str(recorded["recovery_test_results"]["python"]["command"])
    assert "printf node-ok" in str(recorded["recovery_test_results"]["node"]["command"])
    assert git(repo, "rev-parse", "feature/archive") == effective
    assert git(repo, "rev-parse", "main") == effective
    assert git(repo, "--git-dir", str(remote), "rev-parse", "main") == effective


def test_conflicting_divergence_fails_closed_and_records_paths(tmp_path: Path) -> None:
    repo, remote, journal, _base, feature, main = failed_divergent_transaction(
        tmp_path, conflict=True
    )

    result = recover(repo, journal)

    assert result.returncode != 0
    recorded = read_journal(journal)
    assert recorded["recovery_phase"] == "recovery/failed"
    assert "README.md" in recorded["recovery_conflict_paths"]
    assert "conflict" in recorded["recovery_failure_reason"]
    assert git(repo, "rev-parse", "feature/archive") == feature
    assert git(repo, "rev-parse", "main") == main
    assert git(repo, "--git-dir", str(remote), "rev-parse", "main") == main
    recovery_worktree = Path(str(recorded["recovery_worktree"]))
    assert not (recovery_worktree / ".git" / "MERGE_HEAD").exists()


def test_feature_tip_change_is_rejected_without_trusting_descendant(tmp_path: Path) -> None:
    repo, remote, journal, _base, feature, main = failed_divergent_transaction(tmp_path)
    git(repo, "switch", "feature/archive")
    git(repo, "commit", "--allow-empty", "-m", "unexpected feature advance")
    unexpected = git(repo, "rev-parse", "HEAD")
    git(repo, "switch", "main")

    result = recover(repo, journal)

    assert result.returncode != 0
    recorded = read_journal(journal)
    assert "feature tip" in recorded["recovery_failure_reason"]
    assert git(repo, "rev-parse", "feature/archive") == unexpected
    assert unexpected != feature
    assert git(repo, "rev-parse", "main") == main
    assert git(repo, "--git-dir", str(remote), "rev-parse", "main") == main


def test_main_change_after_preflight_is_rejected_without_mixed_sha(tmp_path: Path) -> None:
    repo, _remote, journal, _base, feature, main = failed_divergent_transaction(tmp_path)
    racer = main_race_helper(tmp_path, repo)

    result = recover(repo, journal, extra_env={"ARCHIVE_HELPER": str(racer)})

    assert result.returncode != 0
    recorded = read_journal(journal)
    assert recorded["recovery_main_commit"] == main
    assert "main changed" in recorded["recovery_failure_reason"]
    assert git(repo, "rev-parse", "feature/archive") == feature
    assert recorded.get("recovery_merge_commit") is None


def test_dirty_related_worktree_is_rejected(tmp_path: Path) -> None:
    repo, remote, journal, _base, feature, main = failed_divergent_transaction(tmp_path)
    (repo / "dirty.txt").write_text("dirty\n", encoding="utf-8")

    result = recover(repo, journal)

    assert result.returncode != 0
    assert "dirty" in read_journal(journal)["recovery_failure_reason"]
    assert git(repo, "rev-parse", "feature/archive") == feature
    assert git(repo, "rev-parse", "main") == main
    assert git(repo, "--git-dir", str(remote), "rev-parse", "main") == main


def test_wrong_transaction_phase_is_rejected_and_journaled(tmp_path: Path) -> None:
    repo, _remote, journal, _base, feature, main = failed_divergent_transaction(tmp_path)
    recorded = read_journal(journal)
    recorded["phase"] = "completed"
    recorded["phase_status"] = "succeeded"
    journal.write_text(json.dumps(recorded), encoding="utf-8")

    result = recover(repo, journal)

    assert result.returncode != 0
    assert "phase" in read_journal(journal)["recovery_failure_reason"]
    assert git(repo, "rev-parse", "feature/archive") == feature
    assert git(repo, "rev-parse", "main") == main


def test_plain_resume_keeps_exact_feature_tip_contract_and_never_auto_merges(
    tmp_path: Path,
) -> None:
    repo, remote, journal, _base, feature, main = failed_divergent_transaction(tmp_path)

    result = run_archive(repo, "--resume", journal.parent.name)

    assert result.returncode != 0
    assert git(repo, "rev-parse", "feature/archive") == feature
    assert git(repo, "rev-parse", "main") == main
    assert git(repo, "--git-dir", str(remote), "rev-parse", "main") == main
    assert read_journal(journal).get("recovery_authorized") is None


def test_merge_commit_without_journal_update_resumes_without_second_merge(
    tmp_path: Path,
) -> None:
    repo, _remote, journal, _base, feature, main = failed_divergent_transaction(tmp_path)
    crashing = crash_helper(tmp_path, 'recovery_merge_commit="', after=False)
    interrupted = recover(repo, journal, extra_env={"ARCHIVE_HELPER": str(crashing)})
    assert interrupted.returncode != 0
    worktree = Path(str(read_journal(journal)["recovery_worktree"]))
    unjournaled_merge = git(worktree, "rev-parse", "HEAD")
    assert_recovery_merge(repo, feature, main, unjournaled_merge)

    resumed = recover(repo, journal)

    assert resumed.returncode == 0, (resumed.stdout, resumed.stderr)
    recorded = read_journal(journal)
    assert recorded["recovery_merge_commit"] == unjournaled_merge
    assert recorded["effective_feature_tip"] == unjournaled_merge


def test_validation_failure_preserves_merge_evidence_and_does_not_advance_main(
    tmp_path: Path,
) -> None:
    gate = 'test "$RECOVERY_GATE" = original-pass'
    repo, remote, journal, _base, feature, main = failed_divergent_transaction(
        tmp_path,
        extra_env={
            "ARCHIVE_PYTHON_TEST_COMMAND": gate,
            "ARCHIVE_NODE_TEST_COMMAND": gate,
            "RECOVERY_GATE": "original-pass",
        },
    )

    result = recover(
        repo,
        journal,
        extra_env={
            "ARCHIVE_PYTHON_TEST_COMMAND": "true",
            "ARCHIVE_NODE_TEST_COMMAND": "true",
            "RECOVERY_GATE": "bad",
        },
    )

    assert result.returncode != 0
    recorded = read_journal(journal)
    effective = str(recorded["recovery_merge_commit"])
    assert_recovery_merge(repo, feature, main, effective)
    assert recorded["recovery_phase"] == "recovery/failed"
    assert "recovery validation" in str(recorded["recovery_failure_reason"])
    # The bound original command ran and failed; the `true` override did not rescue it.
    assert recorded["recovery_test_results"]["python"]["status"] == "failed"
    assert recorded["recovery_validation_command_override"]["policy"] == "ignored"
    assert recorded["recovery_validation_record"] is None
    assert git(repo, "rev-parse", "main") == main
    assert git(repo, "--git-dir", str(remote), "rev-parse", "main") == main
    assert not Path(str(recorded["archive_record_path"])).is_absolute()
    assert not (repo / str(recorded["archive_record_path"])).exists()


def test_main_ff_interruption_resumes_at_archive_without_second_merge(tmp_path: Path) -> None:
    repo, remote, journal, _base, _feature, _main = failed_divergent_transaction(tmp_path)
    crashing = crash_helper(tmp_path, "recovery/main-ff-completed", after=False)
    interrupted = recover(repo, journal, extra_env={"ARCHIVE_HELPER": str(crashing)})
    assert interrupted.returncode != 0
    recorded = read_journal(journal)
    effective = str(recorded["effective_feature_tip"])
    assert git(repo, "rev-parse", "main") == effective
    first_merge = recorded["recovery_merge_commit"]

    resumed = recover(repo, journal)

    assert resumed.returncode == 0, (resumed.stdout, resumed.stderr)
    recorded = read_journal(journal)
    assert recorded["recovery_merge_commit"] == first_merge
    assert git(repo, "--git-dir", str(remote), "rev-parse", "main") == effective


def test_push_is_idempotent_after_success_and_after_missing_final_journal_update(
    tmp_path: Path,
) -> None:
    repo, remote, journal, _base, _feature, _main = failed_divergent_transaction(tmp_path)
    counter = tmp_path / "push-count"
    install_push_counter(remote, counter)
    crashing = crash_helper(tmp_path, "recovery/push-completed", after=False)
    interrupted = recover(repo, journal, extra_env={"ARCHIVE_HELPER": str(crashing)})
    assert interrupted.returncode != 0
    assert counter.read_text(encoding="utf-8") == "1"

    resumed = recover(repo, journal)
    repeated = recover(repo, journal)

    assert resumed.returncode == 0, (resumed.stdout, resumed.stderr)
    assert repeated.returncode == 0, (repeated.stdout, repeated.stderr)
    assert counter.read_text(encoding="utf-8") == "1"
    assert read_journal(journal)["recovery_phase"] == "recovery/completed"


def test_original_transaction_evidence_is_never_overwritten_or_deleted(tmp_path: Path) -> None:
    repo, _remote, journal, base, feature, main = failed_divergent_transaction(tmp_path)
    before = read_journal(journal)
    validation = journal.parent / "validation-record.json"
    validation_before = validation.read_bytes()
    failure_before = (journal.parent / "failure-summary.md").read_bytes()

    result = recover(repo, journal)

    assert result.returncode == 0, (result.stdout, result.stderr)
    after = read_journal(journal)
    for field in (
        "phase",
        "phase_status",
        "failure_stage",
        "failure_code",
        "validation_status",
        "validated_head",
        "validation_record_path",
        "validation_record_checksum",
    ):
        assert after[field] == before[field]
    assert after["original_feature_commit"] == feature
    assert after["original_main_commit"] == main
    assert after["original_base_commit"] == base
    assert after["original_validation_record"]["path"] == before["validation_record_path"]
    assert validation.read_bytes() == validation_before
    assert (journal.parent / "failure-summary.md").read_bytes() == failure_before
    phases = [event["phase"] for event in after["recovery_history"]]
    assert "recovery/preflight" in phases
    assert "recovery/push-completed" in phases


def test_recovery_true_override_is_ignored_and_bound_commands_rerun(tmp_path: Path) -> None:
    env, python_marker, node_marker, python_command, node_command = marker_commands(tmp_path)
    repo, _remote, journal, _base, _feature, _main = failed_divergent_transaction(
        tmp_path, extra_env=env
    )
    assert python_marker.read_text(encoding="utf-8") == "bound-python\n"
    assert node_marker.read_text(encoding="utf-8") == "bound-node\n"

    result = recover(
        repo,
        journal,
        extra_env={"ARCHIVE_PYTHON_TEST_COMMAND": "true", "ARCHIVE_NODE_TEST_COMMAND": "true"},
    )

    assert result.returncode == 0, (result.stdout, result.stderr)
    # Each bound command ran exactly once more during recovery; `true` never ran.
    assert python_marker.read_text(encoding="utf-8") == "bound-python\nbound-python\n"
    assert node_marker.read_text(encoding="utf-8") == "bound-node\nbound-node\n"
    recorded = read_journal(journal)
    recovery_validation = recorded["recovery_validation_record"]
    assert recovery_validation["status"] == "passed"
    assert recovery_validation["commands"] == [python_command, node_command]
    assert recovery_validation["command_checksums"] == [
        sha256_text(python_command),
        sha256_text(node_command),
    ]
    assert recovery_validation["command_source"] == "original_validation_record"
    assert recorded["recovery_phase"] == "recovery/completed"


def test_recovery_failing_override_is_not_executed(tmp_path: Path) -> None:
    repo, remote, journal, _base, _feature, _main = failed_divergent_transaction(tmp_path)
    sentinel = tmp_path / "override-executed"
    override = f"printf executed >> {shlex.quote(str(sentinel))}; exit 9"

    result = recover(
        repo,
        journal,
        extra_env={"ARCHIVE_PYTHON_TEST_COMMAND": override, "ARCHIVE_NODE_TEST_COMMAND": override},
    )

    assert result.returncode == 0, (result.stdout, result.stderr)
    assert not sentinel.exists()
    recorded = read_journal(journal)
    assert recorded["recovery_validation_record"]["commands"] == ["printf python-ok", "printf node-ok"]
    assert recorded["recovery_validation_command_override"] == {
        "policy": "ignored",
        "python": True,
        "node": True,
        "command_source": "original_validation_record",
    }
    effective = str(recorded["effective_feature_tip"])
    assert git(repo, "rev-parse", "main") == effective
    assert git(repo, "--git-dir", str(remote), "rev-parse", "main") == effective


def test_recovery_rejects_corrupted_evidence_before_any_git_mutation(tmp_path: Path) -> None:
    repo, remote, journal, _base, feature, main = failed_divergent_transaction(tmp_path)
    evidence = journal.parent / "validation-record.json"
    record = json.loads(evidence.read_text(encoding="utf-8"))
    record["commands"] = ["true", "true"]
    evidence.write_text(json.dumps(record), encoding="utf-8")

    result = recover(
        repo,
        journal,
        extra_env={"ARCHIVE_PYTHON_TEST_COMMAND": "true", "ARCHIVE_NODE_TEST_COMMAND": "true"},
    )

    assert result.returncode != 0
    recorded = read_journal(journal)
    assert recorded["recovery_phase"] == "recovery/failed"
    assert "evidence" in str(recorded["recovery_failure_reason"])
    assert recorded.get("recovery_authorized") is not True
    assert recorded.get("recovery_merge_commit") is None
    assert git(repo, "rev-parse", "feature/archive") == feature
    assert git(repo, "rev-parse", "main") == main
    assert git(repo, "--git-dir", str(remote), "rev-parse", "main") == main
    assert not (journal.parent / "recovery-worktree").exists()


def test_recovery_rejects_missing_or_incomplete_evidence_without_env_backfill(
    tmp_path: Path,
) -> None:
    overrides = {"ARCHIVE_PYTHON_TEST_COMMAND": "true", "ARCHIVE_NODE_TEST_COMMAND": "true"}

    missing_dir = tmp_path / "missing"
    missing_dir.mkdir()
    repo, _remote, journal, _base, feature, main = failed_divergent_transaction(missing_dir)
    (journal.parent / "validation-record.json").unlink()
    result = recover(repo, journal, extra_env=overrides)
    assert result.returncode != 0
    assert "missing" in str(read_journal(journal)["recovery_failure_reason"])
    assert git(repo, "rev-parse", "feature/archive") == feature
    assert git(repo, "rev-parse", "main") == main

    commands_dir = tmp_path / "commands"
    commands_dir.mkdir()
    repo, _remote, journal, _base, feature, main = failed_divergent_transaction(commands_dir)
    evidence = journal.parent / "validation-record.json"
    record = json.loads(evidence.read_text(encoding="utf-8"))
    del record["commands"]
    record["checksum"] = record_digest(record)
    evidence.write_text(json.dumps(record), encoding="utf-8")
    journaled = read_journal(journal)
    journaled["validation_record_checksum"] = record["checksum"]
    journal.write_text(json.dumps(journaled), encoding="utf-8")
    result = recover(repo, journal, extra_env=overrides)
    assert result.returncode != 0
    assert "replayable" in str(read_journal(journal)["recovery_failure_reason"])
    assert git(repo, "rev-parse", "feature/archive") == feature
    assert git(repo, "rev-parse", "main") == main

    checksum_dir = tmp_path / "checksum"
    checksum_dir.mkdir()
    repo, _remote, journal, _base, feature, main = failed_divergent_transaction(checksum_dir)
    journaled = read_journal(journal)
    journaled["validation_record_checksum"] = None
    journal.write_text(json.dumps(journaled), encoding="utf-8")
    result = recover(repo, journal, extra_env=overrides)
    assert result.returncode != 0
    assert "incomplete" in str(read_journal(journal)["recovery_failure_reason"])
    assert git(repo, "rev-parse", "feature/archive") == feature
    assert git(repo, "rev-parse", "main") == main


def test_recovery_rejects_evidence_from_another_transaction(tmp_path: Path) -> None:
    repo, remote, journal, _base, feature, _main = failed_divergent_transaction(tmp_path)

    git(repo, "switch", "-c", "feature/other")
    (repo / "other.txt").write_text("other\n", encoding="utf-8")
    git(repo, "add", "other.txt")
    git(repo, "commit", "-m", "other feature")
    git(repo, "switch", "main")
    (repo / "main-again.txt").write_text("main again\n", encoding="utf-8")
    git(repo, "add", "main-again.txt")
    git(repo, "commit", "-m", "main advances again")
    main_again = git(repo, "rev-parse", "HEAD")
    git(repo, "push", "origin", "main")
    git(repo, "switch", "feature/other")
    second = run_archive(repo, "--push")
    assert second.returncode == 64, (second.stdout, second.stderr)
    other_journal = next(
        path
        for path in (repo / "local_archive" / "runtime" / "archive-and-push").glob(
            "*/transaction.json"
        )
        if path != journal
    )

    # Replace the first transaction's evidence file with the second
    # transaction's record, and update the journaled checksum to match the
    # substituted file; ownership must still be rejected via the head binding.
    other_record = json.loads((other_journal.parent / "validation-record.json").read_text(encoding="utf-8"))
    evidence = journal.parent / "validation-record.json"
    evidence.write_bytes((other_journal.parent / "validation-record.json").read_bytes())
    journaled = read_journal(journal)
    journaled["validation_record_checksum"] = other_record["checksum"]
    journal.write_text(json.dumps(journaled), encoding="utf-8")

    result = recover(repo, journal)

    assert result.returncode != 0
    recorded = read_journal(journal)
    assert recorded["recovery_phase"] == "recovery/failed"
    assert "evidence" in str(recorded["recovery_failure_reason"])
    assert recorded.get("recovery_authorized") is not True
    assert recorded.get("recovery_merge_commit") is None
    assert git(repo, "rev-parse", "feature/archive") == feature
    assert git(repo, "rev-parse", "main") == main_again
    assert git(repo, "--git-dir", str(remote), "rev-parse", "main") == main_again
    assert not (journal.parent / "recovery-worktree").exists()


def test_interrupted_recovery_rebinds_transaction_commands_on_resume(tmp_path: Path) -> None:
    env, python_marker, node_marker, python_command, node_command = marker_commands(tmp_path)
    repo, _remote, journal, _base, _feature, _main = failed_divergent_transaction(
        tmp_path, extra_env=env
    )
    crashing = crash_helper(tmp_path, "recovery/validation-started", after=False)
    interrupted = recover(repo, journal, extra_env={"ARCHIVE_HELPER": str(crashing)})
    assert interrupted.returncode != 0
    recorded = read_journal(journal)
    assert recorded["recovery_merge_commit"]
    # Validation never ran: markers still hold only the original transaction's lines.
    assert python_marker.read_text(encoding="utf-8") == "bound-python\n"
    assert node_marker.read_text(encoding="utf-8") == "bound-node\n"

    resumed = recover(
        repo,
        journal,
        extra_env={"ARCHIVE_PYTHON_TEST_COMMAND": "true", "ARCHIVE_NODE_TEST_COMMAND": "true"},
    )

    assert resumed.returncode == 0, (resumed.stdout, resumed.stderr)
    assert python_marker.read_text(encoding="utf-8") == "bound-python\nbound-python\n"
    assert node_marker.read_text(encoding="utf-8") == "bound-node\nbound-node\n"
    recorded = read_journal(journal)
    recovery_validation = recorded["recovery_validation_record"]
    assert recovery_validation["commands"] == [python_command, node_command]
    assert recovery_validation["command_checksums"] == [
        sha256_text(python_command),
        sha256_text(node_command),
    ]
    started = [
        event for event in recorded["recovery_history"] if event["phase"] == "recovery/validation-started"
    ]
    passed = [
        event for event in recorded["recovery_history"] if event["phase"] == "recovery/validation-passed"
    ]
    assert len(started) == 1
    assert len(passed) == 1


def test_normal_transaction_persists_replayable_validation_evidence(tmp_path: Path) -> None:
    repo, _remote, journal, _base, feature, _main = failed_divergent_transaction(tmp_path)
    recorded = read_journal(journal)
    assert recorded["validation_status"] == "ran"
    assert recorded["validation_source"] == "executed"
    path = str(recorded["validation_record_path"])
    checksum = str(recorded["validation_record_checksum"])
    assert path and checksum
    evidence = repo / path
    record = json.loads(evidence.read_text(encoding="utf-8"))
    assert record["commands"] == ["printf python-ok", "printf node-ok"]
    assert record["checksum"] == checksum == record_digest(record)
    assert record["head_sha"] == recorded["validated_head"] == feature
    verified = subprocess.run(
        [
            sys.executable,
            str(HELPER),
            "validation-verify",
            "--record",
            str(evidence),
            "--repository",
            str(repo),
            "--head",
            str(record["head_sha"]),
            "--worktree-clean",
            "false",
        ],
        text=True,
        capture_output=True,
    )
    assert verified.returncode == 0, (verified.stdout, verified.stderr)


def completed_recovery(tmp_path: Path) -> tuple[Path, Path, Path, str, str, str, str]:
    repo, remote, journal, base, feature, main = failed_divergent_transaction(tmp_path)
    result = recover(repo, journal)
    assert result.returncode == 0, (result.stdout, result.stderr)
    recorded = read_journal(journal)
    assert recorded["recovery_phase"] == "recovery/completed"
    return repo, remote, journal, base, feature, main, str(recorded["effective_feature_tip"])


def test_completed_resume_rejects_tampered_recovery_commands(tmp_path: Path) -> None:
    repo, remote, journal, _base, _feature, _main, effective = completed_recovery(tmp_path)
    record_file = journal.parent / "recovery-validation-record.json"
    record_before = record_file.read_bytes()
    journaled = read_journal(journal)
    journaled["recovery_validation_record"]["commands"] = ["true", "true"]
    journal.write_text(json.dumps(journaled), encoding="utf-8")

    result = recover(
        repo,
        journal,
        extra_env={"ARCHIVE_PYTHON_TEST_COMMAND": "false", "ARCHIVE_NODE_TEST_COMMAND": "false"},
    )

    assert result.returncode != 0
    recorded = read_journal(journal)
    assert recorded["recovery_phase"] == "recovery/failed"
    assert "integrity or command-binding" in str(recorded["recovery_failure_reason"])
    assert record_file.read_bytes() == record_before
    assert git(repo, "rev-parse", "feature/archive") == effective
    assert git(repo, "rev-parse", "main") == effective
    assert git(repo, "--git-dir", str(remote), "rev-parse", "main") == effective


def test_completed_resume_rejects_tampered_command_checksums(tmp_path: Path) -> None:
    repo, remote, journal, _base, _feature, _main, effective = completed_recovery(tmp_path)
    journaled = read_journal(journal)
    journaled["recovery_validation_record"]["command_checksums"] = [
        sha256_text("true"),
        sha256_text("true"),
    ]
    journal.write_text(json.dumps(journaled), encoding="utf-8")

    result = recover(repo, journal)

    assert result.returncode != 0
    recorded = read_journal(journal)
    assert recorded["recovery_phase"] == "recovery/failed"
    assert "integrity or command-binding" in str(recorded["recovery_failure_reason"])
    assert git(repo, "rev-parse", "feature/archive") == effective
    assert git(repo, "rev-parse", "main") == effective
    assert git(repo, "--git-dir", str(remote), "rev-parse", "main") == effective


def test_completed_resume_rejects_tampered_original_evidence_attribution(
    tmp_path: Path,
) -> None:
    repo, remote, journal, _base, _feature, _main, effective = completed_recovery(tmp_path)
    journaled = read_journal(journal)
    journaled["recovery_validation_record"]["original_evidence_checksum"] = "0" * 64
    journal.write_text(json.dumps(journaled), encoding="utf-8")

    result = recover(repo, journal)

    assert result.returncode != 0
    recorded = read_journal(journal)
    assert recorded["recovery_phase"] == "recovery/failed"
    assert "integrity or command-binding" in str(recorded["recovery_failure_reason"])
    assert git(repo, "rev-parse", "feature/archive") == effective
    assert git(repo, "rev-parse", "main") == effective
    assert git(repo, "--git-dir", str(remote), "rev-parse", "main") == effective


def test_completed_resume_rejects_tampered_effective_tip(tmp_path: Path) -> None:
    repo, remote, journal, _base, feature, _main, effective = completed_recovery(tmp_path)
    journaled = read_journal(journal)
    journaled["effective_feature_tip"] = feature
    journal.write_text(json.dumps(journaled), encoding="utf-8")

    result = recover(repo, journal)

    assert result.returncode != 0
    recorded = read_journal(journal)
    assert recorded["recovery_phase"] == "recovery/failed"
    assert "effective feature tip" in str(recorded["recovery_failure_reason"])
    assert git(repo, "rev-parse", "feature/archive") == effective
    assert git(repo, "rev-parse", "main") == effective
    assert git(repo, "--git-dir", str(remote), "rev-parse", "main") == effective


def test_completed_resume_is_idempotent_and_mutation_free(tmp_path: Path) -> None:
    env, python_marker, node_marker, _python_command, _node_command = marker_commands(tmp_path)
    repo, remote, journal, _base, feature, main = failed_divergent_transaction(
        tmp_path, extra_env=env
    )
    counter = tmp_path / "push-count"
    install_push_counter(remote, counter)
    first = recover(repo, journal, extra_env=env)
    assert first.returncode == 0, (first.stdout, first.stderr)
    recorded = read_journal(journal)
    effective = str(recorded["effective_feature_tip"])
    journal_before = journal.read_bytes()
    record_file = journal.parent / "recovery-validation-record.json"
    record_before = record_file.read_bytes()
    manifest_file = journal.parent / "recovery-manifest.json"
    manifest_before = manifest_file.read_bytes()
    manifest = json.loads(manifest_before)
    assert manifest["checksum"] == manifest_digest(manifest)
    assert manifest["checksum"] == recorded["recovery_validation_record"]["manifest_checksum"]
    assert manifest["effective_feature_tip"] == effective
    assert manifest["parents"] == [feature, main]
    archive_file = repo / str(recorded["archive_record_path"])
    archive_before = archive_file.read_bytes()
    python_marker_before = python_marker.read_bytes()
    node_marker_before = node_marker.read_bytes()
    assert counter.read_text(encoding="utf-8") == "1"

    second = recover(repo, journal, extra_env=env)

    assert second.returncode == 0, (second.stdout, second.stderr)
    assert journal.read_bytes() == journal_before
    assert record_file.read_bytes() == record_before
    assert manifest_file.read_bytes() == manifest_before
    assert archive_file.read_bytes() == archive_before
    # Validation commands were not rerun, no commit or ref moved, no second push.
    assert python_marker.read_bytes() == python_marker_before
    assert node_marker.read_bytes() == node_marker_before
    assert counter.read_text(encoding="utf-8") == "1"
    assert git(repo, "rev-parse", "feature/archive") == effective
    assert git(repo, "rev-parse", "main") == effective
    assert git(repo, "--git-dir", str(remote), "rev-parse", "main") == effective


def test_completed_resume_rejects_manifest_effective_tip_tamper(tmp_path: Path) -> None:
    repo, remote, journal, _base, feature, _main, effective = completed_recovery(tmp_path)
    manifest_file = journal.parent / "recovery-manifest.json"
    manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
    stored_checksum = str(manifest["checksum"])
    manifest["effective_feature_tip"] = feature
    manifest_file.write_text(json.dumps(manifest), encoding="utf-8")

    result = recover(repo, journal)

    assert result.returncode != 0
    recorded = read_journal(journal)
    assert recorded["recovery_phase"] == "recovery/failed"
    assert "manifest integrity" in str(recorded["recovery_failure_reason"])
    # The stale self-reported checksum was retained and the script did not rewrite it.
    assert json.loads(manifest_file.read_text(encoding="utf-8"))["checksum"] == stored_checksum
    assert git(repo, "rev-parse", "feature/archive") == effective
    assert git(repo, "rev-parse", "main") == effective
    assert git(repo, "--git-dir", str(remote), "rev-parse", "main") == effective


def test_completed_resume_rejects_manifest_parent_tamper(tmp_path: Path) -> None:
    repo, remote, journal, _base, _feature, _main, effective = completed_recovery(tmp_path)
    manifest_file = journal.parent / "recovery-manifest.json"
    manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
    manifest["parents"] = [manifest["recovery_main_commit"], manifest["original_feature_commit"]]
    manifest_file.write_text(json.dumps(manifest), encoding="utf-8")

    result = recover(repo, journal)

    assert result.returncode != 0
    recorded = read_journal(journal)
    assert recorded["recovery_phase"] == "recovery/failed"
    assert "manifest integrity" in str(recorded["recovery_failure_reason"])
    assert git(repo, "rev-parse", "feature/archive") == effective
    assert git(repo, "rev-parse", "main") == effective
    assert git(repo, "--git-dir", str(remote), "rev-parse", "main") == effective


def test_completed_resume_rejects_manifest_checksum_forgery(tmp_path: Path) -> None:
    repo, remote, journal, _base, _feature, _main, effective = completed_recovery(tmp_path)
    manifest_file = journal.parent / "recovery-manifest.json"
    manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
    manifest["tree_sha"] = "0" * 40
    manifest["checksum"] = "f" * 64
    manifest_file.write_text(json.dumps(manifest), encoding="utf-8")

    result = recover(repo, journal)

    assert result.returncode != 0
    recorded = read_journal(journal)
    assert recorded["recovery_phase"] == "recovery/failed"
    assert "manifest integrity" in str(recorded["recovery_failure_reason"])
    assert git(repo, "rev-parse", "feature/archive") == effective
    assert git(repo, "rev-parse", "main") == effective
    assert git(repo, "--git-dir", str(remote), "rev-parse", "main") == effective


def test_completed_resume_rejects_consistent_manifest_journal_forgery(tmp_path: Path) -> None:
    repo, remote, journal, _base, feature, _main, effective = completed_recovery(tmp_path)
    manifest_file = journal.parent / "recovery-manifest.json"
    manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
    manifest["effective_feature_tip"] = feature
    manifest["checksum"] = manifest_digest(manifest)
    manifest_file.write_text(json.dumps(manifest), encoding="utf-8")
    journaled = read_journal(journal)
    journaled["recovery_validation_record"]["manifest_checksum"] = manifest["checksum"]
    journal.write_text(json.dumps(journaled), encoding="utf-8")

    result = recover(repo, journal)

    # Manifest and journal now agree with each other, but not with Git facts.
    assert result.returncode != 0
    recorded = read_journal(journal)
    assert recorded["recovery_phase"] == "recovery/failed"
    assert "manifest topology mismatch" in str(recorded["recovery_failure_reason"])
    assert git(repo, "rev-parse", "feature/archive") == effective
    assert git(repo, "rev-parse", "main") == effective
    assert git(repo, "--git-dir", str(remote), "rev-parse", "main") == effective


def test_first_manifest_generation_uses_canonical_checksum(tmp_path: Path) -> None:
    repo, _remote, journal, base, feature, main, effective = completed_recovery(tmp_path)
    manifest = json.loads((journal.parent / "recovery-manifest.json").read_text(encoding="utf-8"))
    recorded = read_journal(journal)
    assert manifest_digest(manifest) == manifest["checksum"]
    assert recorded["recovery_validation_record"]["manifest_checksum"] == manifest["checksum"]
    assert manifest["schema_version"] == 1
    assert manifest["original_base_commit"] == base
    assert manifest["original_feature_commit"] == feature
    assert manifest["recovery_main_commit"] == main
    assert manifest["effective_feature_tip"] == effective
    assert manifest["parents"] == [feature, main]
    assert manifest["tree_sha"] == git(repo, "rev-parse", f"{effective}^{{tree}}")
    assert manifest["original_paths"] == manifest["effective_paths"]
