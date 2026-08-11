"""Integration coverage for the local-only archive transaction workflow."""

from __future__ import annotations

import hashlib
import json
import os
import stat
import subprocess
import sys
import time
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = REPO_ROOT / "scripts" / "archive_and_push.sh"
GITHUB_HTTPS = "https://github.com/F-crystal/ran-agent.git"
GITHUB_SSH = "git@github.com:F-crystal/ran-agent.git"


def git(cwd: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(cwd), *args], check=True, text=True, capture_output=True
    ).stdout.strip()


def run_archive(
    repo: Path, *args: str, extra_env: dict[str, str] | None = None, script: Path = SCRIPT
) -> subprocess.CompletedProcess[str]:
    env = os.environ | {
        "ARCHIVE_ROOT": str(repo),
        "ARCHIVE_HELPER": str(REPO_ROOT / "scripts" / "archive_transaction_helper.py"),
        "ARCHIVE_PYTHON_BIN": sys.executable,
        "ARCHIVE_PYTHON_TEST_COMMAND": "printf python-ok",
        "ARCHIVE_NODE_TEST_COMMAND": "printf node-ok",
        "ARCHIVE_TEST_HEARTBEAT_SECONDS": "1",
    }
    if extra_env:
        env |= extra_env
    return subprocess.run(
        [str(script), *args], text=True, capture_output=True, env=env, timeout=30
    )


def setup_feature_repo(tmp_path: Path) -> tuple[Path, Path]:
    remote = tmp_path / "origin.git"
    repo = tmp_path / "repo"
    subprocess.run(["git", "init", "--bare", str(remote)], check=True, capture_output=True)
    subprocess.run(["git", "init", "-b", "main", str(repo)], check=True, capture_output=True)
    git(repo, "config", "user.name", "Archive Test")
    git(repo, "config", "user.email", "archive@example.test")
    (repo / "README.md").write_text("base\n", encoding="utf-8")
    git(repo, "add", "README.md")
    git(repo, "commit", "-m", "base")
    git(repo, "remote", "add", "origin", str(remote))
    git(repo, "push", "-u", "origin", "main")
    git(repo, "switch", "-c", "feature/archive")
    return repo, remote


def test_default_node_baseline_binds_supported_absolute_nvm_runtime(tmp_path: Path) -> None:
    repo, remote = setup_feature_repo(tmp_path)
    old_bin = tmp_path / "old-bin"
    supported_bin = tmp_path / "nvm" / "versions" / "node" / "v22.22.2" / "bin"
    marker = tmp_path / "node-test-ran"
    old_bin.mkdir()
    supported_bin.mkdir(parents=True)
    old_node = old_bin / "node"
    supported_node = supported_bin / "node"
    old_node.write_text(
        "#!/bin/sh\ncase \"${1:-}\" in -p) printf '16.17.0\\n';; --version) printf 'v16.17.0\\n';; *) exit 64;; esac\n",
        encoding="utf-8",
    )
    supported_node.write_text(
        "#!/bin/sh\ncase \"${1:-}\" in -p) printf '22.22.2\\n';; --version) printf 'v22.22.2\\n';; --test) printf 'ok\\n' > \"$NODE_TEST_MARKER\";; *) exit 64;; esac\n",
        encoding="utf-8",
    )
    old_node.chmod(0o755)
    supported_node.chmod(0o755)
    (repo / "node_bridge").mkdir()
    (repo / "node_bridge" / ".keep").write_text("fixture\n", encoding="utf-8")
    env = os.environ | {
        "ARCHIVE_ROOT": str(repo),
        "ARCHIVE_HELPER": str(REPO_ROOT / "scripts" / "archive_transaction_helper.py"),
        "ARCHIVE_PYTHON_BIN": sys.executable,
        "ARCHIVE_PYTHON_TEST_COMMAND": "printf python-ok",
        "ARCHIVE_TEST_HEARTBEAT_SECONDS": "1",
        "NVM_DIR": str(tmp_path / "nvm"),
        "NODE_TEST_MARKER": str(marker),
        "PATH": f"{old_bin}:/usr/bin:/bin:/usr/local/bin",
    }
    for key in ("ARCHIVE_NODE_BIN", "ARCHIVE_NODE_TEST_COMMAND", "RAN_AGENT_NODE_BIN"):
        env.pop(key, None)

    result = subprocess.run(
        [str(SCRIPT), "--push"], text=True, capture_output=True, env=env, timeout=30
    )

    assert result.returncode == 0, result.stderr
    assert marker.read_text(encoding="utf-8") == "ok\n"
    transaction, journal = journal_for(repo)
    record = json.loads((transaction.parent / "validation-record.json").read_text(encoding="utf-8"))
    assert record["node_version"] == "v22.22.2"
    assert str(supported_node) in record["commands"][1]
    assert "npm --prefix" not in record["commands"][1]
    assert git(repo, "--git-dir", str(remote), "rev-parse", "main") == git(repo, "rev-parse", "HEAD")


def configure_fallback_push_targets(repo: Path, primary_target: Path, alternate_target: Path) -> None:
    """Point origin at the GitHub URLs, rewritten to the local push targets.

    Fetches resolve through the primary clone, which holds identical refs, so
    preflight stays local; only the actual pushes hit the rejecting hooks.
    """
    git(repo, "remote", "set-url", "origin", GITHUB_HTTPS)
    git(repo, "config", f"url.file://{primary_target}.insteadOf", GITHUB_HTTPS)
    git(repo, "config", f"url.file://{alternate_target}.insteadOf", GITHUB_SSH)


def rejecting_bare_clone(source: Path, target: Path) -> Path:
    subprocess.run(["git", "clone", "--bare", str(source), str(target)], check=True, capture_output=True)
    reject = target / "hooks" / "pre-receive"
    reject.write_text("#!/usr/bin/env bash\nexit 1\n", encoding="utf-8")
    reject.chmod(0o755)
    return target


def assert_raw_origin_restored(repo: Path) -> None:
    assert git(repo, "config", "--get", "remote.origin.url") == GITHUB_HTTPS
    for name in ("missing-primary.git", "missing-alternate.git"):
        subprocess.run(
            ["git", "-C", str(repo), "config", "--unset-all", f"url.file://{repo.parent / name}.insteadOf"],
            check=False,
            capture_output=True,
        )
    assert git(repo, "remote", "get-url", "origin") == GITHUB_HTTPS


def write_validation_record(repo: Path, head: str) -> Path:
    """Create a checksum-valid local validation record for a clean feature HEAD."""
    record = {
        "schema_version": 1,
        "repository_realpath": str(repo.resolve()),
        "head_sha": head,
        "worktree_clean": True,
        "node_version": "vtest",
        "python_version": "Python test",
        "commands": ["printf python-ok", "printf node-ok"],
        "per_command_status": {
            name: {
                "command": f"printf {name}-ok",
                "status": "passed",
                "exit_code": 0,
                "duration_seconds": 0,
                "log_path": f"local_archive/{name}.log",
            }
            for name in ("python", "node")
        },
        "completed_at": "2026-07-14T00:00:00Z",
    }
    digest_input = json.dumps(record, sort_keys=True, separators=(",", ":")).encode()
    record["checksum"] = hashlib.sha256(digest_input).hexdigest()
    path = repo / "local_archive" / "runtime" / "trusted-validation.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(record), encoding="utf-8")
    return path


def test_precommitted_feature_pushes_and_writes_resumable_journal(tmp_path: Path) -> None:
    repo, remote = setup_feature_repo(tmp_path)
    (repo / "feature.txt").write_text("feature\n", encoding="utf-8")
    git(repo, "add", "feature.txt")
    git(repo, "commit", "-m", "feature: archive transaction")
    feature_head = git(repo, "rev-parse", "HEAD")

    result = run_archive(repo, "--push")

    assert result.returncode == 0, result.stderr
    # The merge phase never checks out the target branch in the source
    # worktree; it advances refs/heads/main in place.
    assert git(repo, "branch", "--show-current") == "feature/archive"
    assert git(repo, "rev-parse", "main") == feature_head
    assert git(repo, "rev-parse", "HEAD") == feature_head
    assert git(repo, "--git-dir", str(remote), "rev-parse", "main") == feature_head

    runtime = repo / "local_archive" / "runtime" / "archive-and-push"
    transactions = list(runtime.glob("*/transaction.json"))
    assert len(transactions) == 1
    journal = json.loads(transactions[0].read_text(encoding="utf-8"))
    assert journal["schema_version"] == 1
    assert journal["phase"] == "completed"
    assert journal["phase_status"] == "succeeded"
    assert journal["test_results"]["python"]["status"] == "passed"
    assert journal["test_results"]["node"]["status"] == "passed"
    assert journal["validation_status"] == "ran"
    assert journal["validated_head"] == feature_head
    assert journal["validation_source"] == "executed"
    assert journal["validation_record_path"] == f"local_archive/runtime/archive-and-push/{journal['transaction_id']}/validation-record.json"
    assert journal["validation_record_checksum"]
    assert journal["validation_completed_at"]
    assert journal["validation_skip_reason"] is None
    assert journal["merge_result"]["status"] == "succeeded"
    assert journal["push_result"]["status"] == "succeeded"
    assert journal["archive_result"]["status"] == "succeeded"
    assert (transactions[0].parent / "logs" / "python-baseline.log").read_text(encoding="utf-8") == "python-ok"
    assert (transactions[0].parent / "logs" / "node-baseline.log").read_text(encoding="utf-8") == "node-ok"
    assert (transactions[0].parent / "validation-record.json").is_file()
    validation_record = json.loads((transactions[0].parent / "validation-record.json").read_text(encoding="utf-8"))
    assert validation_record["branch"] == "feature/archive"
    assert validation_record["base_sha"] == journal["expected_origin_main"]

    record = next((repo / "local_archive" / "docs" / "governance" / "archive").glob("*.md"))
    contents = record.read_text(encoding="utf-8")
    assert "Status: ran" in contents
    assert f"Validated head: {feature_head}" in contents
    assert "feature.txt" in contents
    assert "feature: archive transaction" in contents


def test_same_day_default_archives_use_transaction_specific_records(tmp_path: Path) -> None:
    repo, remote = setup_feature_repo(tmp_path)
    (repo / "first.txt").write_text("first\n", encoding="utf-8")
    first = run_archive(repo, "--push")
    assert first.returncode == 0, first.stderr

    (repo / "second.txt").write_text("second\n", encoding="utf-8")
    second = run_archive(repo, "--push", extra_env={"ARCHIVE_TRANSACTION_LOCK_HELD": "1"})
    assert second.returncode == 0, second.stderr

    journals = [
        json.loads(path.read_text(encoding="utf-8"))
        for path in (repo / "local_archive" / "runtime" / "archive-and-push").glob("*/transaction.json")
    ]
    records = {str(journal["archive_record_path"]) for journal in journals}
    assert len(journals) == len(records) == 2
    assert all((repo / record).is_file() for record in records)
    assert git(repo, "--git-dir", str(remote), "rev-parse", "main") == git(repo, "rev-parse", "HEAD")


def test_reused_validation_is_durable_before_merge_and_rendered_from_journal(tmp_path: Path) -> None:
    repo, remote = setup_feature_repo(tmp_path)
    (repo / "feature.txt").write_text("feature\n", encoding="utf-8")
    git(repo, "add", "feature.txt")
    git(repo, "commit", "-m", "feature")
    source_head = git(repo, "rev-parse", "HEAD")
    record = write_validation_record(repo, source_head)
    checksum = json.loads(record.read_text(encoding="utf-8"))["checksum"]

    result = run_archive(
        repo,
        "--push",
        "--reuse-validation",
        str(record),
        extra_env={
            "ARCHIVE_NODE_TEST_COMMAND": "",
            "ARCHIVE_NODE_BIN": str(tmp_path / "missing-node"),
        },
    )

    assert result.returncode == 0, result.stderr
    transaction, journal = journal_for(repo)
    assert journal["validation_status"] == "reused"
    assert journal["validated_head"] == source_head
    assert journal["validation_source"] == "validation_record"
    assert journal["validation_record_path"] == "local_archive/runtime/trusted-validation.json"
    assert journal["validation_record_checksum"] == checksum
    assert journal["validation_completed_at"] == "2026-07-14T00:00:00Z"
    assert journal["validation_skip_reason"] is None
    assert journal["test_results"]["python"]["status"] == "passed"
    assert journal["test_results"]["node"]["status"] == "passed"
    assert git(repo, "rev-parse", "HEAD") == source_head
    assert git(repo, "--git-dir", str(remote), "rev-parse", "main") == source_head
    archive = next((repo / "local_archive" / "docs" / "governance" / "archive").glob("*.md"))
    contents = archive.read_text(encoding="utf-8")
    assert "## Validation" in contents
    assert "- Status: reused" in contents
    assert f"- Validated head: {source_head}" in contents
    assert "- Source: validation_record" in contents
    assert "- Validation record: local_archive/runtime/trusted-validation.json" in contents
    assert f"- Validation checksum: {checksum}" in contents
    assert "- python" in contents
    assert "  - Status: passed" in contents
    assert transaction.parent.is_relative_to(repo / "local_archive")


def test_reused_validation_rejects_final_symlink_without_git_mutation(tmp_path: Path) -> None:
    repo, remote = setup_feature_repo(tmp_path)
    (repo / "feature.txt").write_text("feature\n", encoding="utf-8")
    git(repo, "add", "feature.txt")
    git(repo, "commit", "-m", "feature")
    source_head = git(repo, "rev-parse", "HEAD")
    validation = write_validation_record(repo, source_head)
    outside = tmp_path / "outside-validation.json"
    outside.write_bytes(validation.read_bytes())
    validation.unlink()
    validation.symlink_to(outside)
    digest = hashlib.sha256(outside.read_bytes()).hexdigest()

    result = run_archive(repo, "--push", "--reuse-validation", str(validation))

    assert result.returncode == 34
    assert validation.is_symlink()
    assert hashlib.sha256(outside.read_bytes()).hexdigest() == digest
    assert git(repo, "rev-parse", "HEAD") == source_head
    assert git(repo, "--git-dir", str(remote), "rev-parse", "main") != source_head
    _transaction, journal = journal_for(repo)
    assert journal["phase"] == "validation"
    assert journal["failure_stage"] == "validation"


def journal_for(repo: Path) -> tuple[Path, dict[str, object]]:
    path = next((repo / "local_archive" / "runtime" / "archive-and-push").glob("*/transaction.json"))
    return path, json.loads(path.read_text(encoding="utf-8"))


def test_uncommitted_allowed_file_is_committed_and_pushed(tmp_path: Path) -> None:
    repo, remote = setup_feature_repo(tmp_path)
    (repo / "new.txt").write_text("new\n", encoding="utf-8")

    result = run_archive(repo, "--push")

    assert result.returncode == 0, result.stderr
    assert git(repo, "rev-parse", "HEAD") == git(repo, "--git-dir", str(remote), "rev-parse", "main")
    transaction, journal = journal_for(repo)
    assert journal["commit_result"]["status"] == "succeeded"
    assert journal["head_sha"] == git(repo, "rev-parse", "HEAD")
    archive = next((repo / "local_archive" / "docs" / "governance" / "archive").glob("*.md"))
    assert f"- Head: {journal['head_sha']}" in archive.read_text(encoding="utf-8")
    assert "A\tnew.txt" in archive.read_text(encoding="utf-8")


def test_commit_failure_does_not_merge_or_push(tmp_path: Path) -> None:
    repo, remote = setup_feature_repo(tmp_path)
    base = git(repo, "rev-parse", "HEAD")
    (repo / "blocked.txt").write_text("blocked\n", encoding="utf-8")
    hook = repo / ".git" / "hooks" / "pre-commit"
    hook.write_text("#!/usr/bin/env bash\nexit 19\n", encoding="utf-8")
    hook.chmod(0o755)

    result = run_archive(repo, "--push")

    assert result.returncode != 0
    assert git(repo, "branch", "--show-current") == "feature/archive"
    assert git(repo, "--git-dir", str(remote), "rev-parse", "main") == base
    _path, journal = journal_for(repo)
    assert journal["phase"] == "commit"
    assert journal["phase_status"] == "failed"
    assert journal["failure_stage"] == "commit"


def test_commit_signing_failure_does_not_merge_or_push(tmp_path: Path) -> None:
    repo, remote = setup_feature_repo(tmp_path)
    base = git(repo, "rev-parse", "HEAD")
    (repo / "signed.txt").write_text("signed\n", encoding="utf-8")
    failing_gpg = tmp_path / "failing-gpg"
    failing_gpg.write_text("#!/usr/bin/env bash\nexit 1\n", encoding="utf-8")
    failing_gpg.chmod(0o755)
    git(repo, "config", "commit.gpgsign", "true")
    git(repo, "config", "gpg.program", str(failing_gpg))

    result = run_archive(repo, "--push")

    assert result.returncode != 0
    assert git(repo, "branch", "--show-current") == "feature/archive"
    assert git(repo, "--git-dir", str(remote), "rev-parse", "main") == base
    _path, journal = journal_for(repo)
    assert journal["failure_stage"] == "commit"


def test_timeout_is_journaled_and_never_mutates_git(tmp_path: Path) -> None:
    repo, remote = setup_feature_repo(tmp_path)
    base = git(repo, "rev-parse", "HEAD")

    result = run_archive(
        repo,
        "--push",
        extra_env={
            "ARCHIVE_PYTHON_TEST_COMMAND": "sleep 3",
            "ARCHIVE_PYTHON_TEST_TIMEOUT_SECONDS": "0.2",
        },
    )

    assert result.returncode != 0
    assert git(repo, "--git-dir", str(remote), "rev-parse", "main") == base
    _path, journal = journal_for(repo)
    assert journal["test_results"]["python"]["status"] == "timed_out"
    assert journal["phase"] == "validation"


def test_node_failure_and_timeout_are_both_journaled(tmp_path: Path) -> None:
    for command, timeout, expected in (("exit 7", "900", "failed"), ("sleep 3", "0.2", "timed_out")):
        repo, _remote = setup_feature_repo(tmp_path / expected)
        result = run_archive(
            repo,
            "--push",
            extra_env={"ARCHIVE_NODE_TEST_COMMAND": command, "ARCHIVE_NODE_TEST_TIMEOUT_SECONDS": timeout},
        )
        assert result.returncode != 0
        _path, journal = journal_for(repo)
        assert journal["test_results"]["node"]["status"] == expected


def test_validation_timeout_can_only_resume_by_rerunning_validation(tmp_path: Path) -> None:
    repo, _remote = setup_feature_repo(tmp_path)
    failed = run_archive(
        repo,
        "--push",
        extra_env={"ARCHIVE_PYTHON_TEST_COMMAND": "sleep 3", "ARCHIVE_PYTHON_TEST_TIMEOUT_SECONDS": "0.2"},
    )
    assert failed.returncode != 0
    transaction, journal = journal_for(repo)
    assert journal["phase"] == "validation"
    assert journal["test_results"]["python"]["status"] == "timed_out"

    resumed = run_archive(repo, "--resume", transaction.parent.name)
    assert resumed.returncode == 0, resumed.stderr
    journal = json.loads(transaction.read_text(encoding="utf-8"))
    assert journal["test_results"]["python"]["status"] == "passed"
    assert journal["phase"] == "completed"


def test_skip_tests_requires_reason_and_is_not_reported_as_passed(tmp_path: Path) -> None:
    repo, _remote = setup_feature_repo(tmp_path)
    assert run_archive(repo, "--push", "--skip-tests").returncode != 0

    result = run_archive(repo, "--push", "--skip-tests", "--skip-tests-reason", "operator reviewed CI")

    assert result.returncode == 0, result.stderr
    _path, journal = journal_for(repo)
    assert journal["test_results"]["status"] == "skipped"
    assert journal["validation_status"] == "skipped"
    assert journal["validated_head"] is None
    assert journal["validation_source"] == "operator_skip"
    assert journal["validation_skip_reason"] == "operator reviewed CI"
    record = next((repo / "local_archive" / "docs" / "governance" / "archive").glob("*.md"))
    contents = record.read_text(encoding="utf-8")
    assert "- Status: skipped" in contents
    assert "- Validated head: none" in contents
    assert "- Skip reason: operator reviewed CI" in contents


def test_archive_record_path_outside_local_archive_is_rejected_before_transaction(tmp_path: Path) -> None:
    repo, remote = setup_feature_repo(tmp_path)
    base = git(repo, "rev-parse", "HEAD")

    result = run_archive(repo, "--push", "--record", str(tmp_path / "outside.md"))

    assert result.returncode != 0
    assert git(repo, "branch", "--show-current") == "feature/archive"
    assert git(repo, "rev-parse", "HEAD") == base
    assert git(repo, "--git-dir", str(remote), "rev-parse", "main") == base
    assert not (repo / "local_archive" / "runtime" / "archive-and-push").exists()


def test_push_failure_resumes_only_the_push(tmp_path: Path) -> None:
    repo, remote = setup_feature_repo(tmp_path)
    (repo / "feature.txt").write_text("feature\n", encoding="utf-8")
    git(repo, "add", "feature.txt")
    git(repo, "commit", "-m", "feature")
    reject = remote / "hooks" / "pre-receive"
    reject.write_text("#!/usr/bin/env bash\nexit 1\n", encoding="utf-8")
    reject.chmod(0o755)

    failed = run_archive(repo, "--push")
    assert failed.returncode != 0
    transaction, journal = journal_for(repo)
    assert journal["phase"] == "push"
    assert journal["push_result"]["local_main_advanced"] is True
    reject.unlink()

    resumed = run_archive(
        repo,
        "--resume",
        transaction.parent.name,
        extra_env={
            "ARCHIVE_NODE_TEST_COMMAND": "",
            "ARCHIVE_NODE_BIN": str(tmp_path / "missing-node"),
        },
    )

    assert resumed.returncode == 0, resumed.stderr
    assert git(repo, "--git-dir", str(remote), "rev-parse", "main") == git(repo, "rev-parse", "HEAD")
    assert json.loads(transaction.read_text(encoding="utf-8"))["phase"] == "completed"


def test_primary_push_failure_uses_alternate_and_restores_original_url(tmp_path: Path) -> None:
    repo, successful_remote = setup_feature_repo(tmp_path)
    rejecting_primary = rejecting_bare_clone(successful_remote, tmp_path / "missing-primary.git")
    configure_fallback_push_targets(repo, rejecting_primary, successful_remote)
    (repo / "feature.txt").write_text("feature\n", encoding="utf-8")
    git(repo, "add", "feature.txt")
    git(repo, "commit", "-m", "feature")
    head = git(repo, "rev-parse", "HEAD")

    result = run_archive(repo, "--push")

    assert result.returncode == 0, result.stderr
    assert git(repo, "--git-dir", str(successful_remote), "rev-parse", "main") == head
    assert_raw_origin_restored(repo)
    _path, journal = journal_for(repo)
    assert journal["push_result"]["primary_push"] == "failed"
    assert journal["push_result"]["alternate_push"] == "succeeded"
    assert journal["push_result"]["original_remote_url_restored"] is True


def test_double_push_failure_restores_original_url_without_archive_success(tmp_path: Path) -> None:
    repo, _unused_remote = setup_feature_repo(tmp_path)
    rejecting_primary = rejecting_bare_clone(_unused_remote, tmp_path / "missing-primary.git")
    rejecting_alternate = rejecting_bare_clone(_unused_remote, tmp_path / "missing-alternate.git")
    configure_fallback_push_targets(repo, rejecting_primary, rejecting_alternate)
    (repo / "feature.txt").write_text("feature\n", encoding="utf-8")
    git(repo, "add", "feature.txt")
    git(repo, "commit", "-m", "feature")

    result = run_archive(repo, "--push")

    assert result.returncode != 0
    assert_raw_origin_restored(repo)
    transaction, journal = journal_for(repo)
    assert journal["failure_stage"] == "push"
    assert journal["push_result"]["primary_push"] == "failed"
    assert journal["push_result"]["alternate_push"] == "failed"
    assert journal["push_result"]["original_remote_url_restored"] is True
    records = list((repo / "local_archive" / "docs" / "governance" / "archive").glob("*.md"))
    assert not records
    assert (transaction.parent / "failure-summary.md").is_file()


def test_validation_record_reuse_is_exact_head_only(tmp_path: Path) -> None:
    repo, _remote = setup_feature_repo(tmp_path)
    first = run_archive(repo, "--push")
    assert first.returncode == 0, first.stderr
    transaction, _journal = journal_for(repo)
    record = transaction.parent / "validation-record.json"
    git(repo, "switch", "-c", "feature/reuse")

    reused = run_archive(
        repo,
        "--push",
        "--reuse-validation",
        str(record),
        "--record",
        str(repo / "local_archive" / "docs" / "governance" / "archive" / "reused.md"),
    )
    assert reused.returncode == 0, reused.stderr

    git(repo, "switch", "-c", "feature/mismatch")
    (repo / "mismatch.txt").write_text("mismatch\n", encoding="utf-8")
    git(repo, "add", "mismatch.txt")
    git(repo, "commit", "-m", "mismatch")
    rejected = run_archive(repo, "--push", "--reuse-validation", str(record))
    assert rejected.returncode != 0
    assert git(repo, "branch", "--show-current") == "feature/mismatch"
    assert git(repo, "--git-dir", str(_remote), "rev-parse", "main") != git(repo, "rev-parse", "HEAD")


def test_validation_provenance_write_failure_never_reaches_git_mutation(tmp_path: Path) -> None:
    repo, remote = setup_feature_repo(tmp_path)
    base = git(repo, "rev-parse", "HEAD")
    (repo / "uncommitted.txt").write_text("change\n", encoding="utf-8")
    counter = tmp_path / "journal-update-count"
    helper = tmp_path / "fail-provenance-helper.py"
    helper.write_text(
        "from pathlib import Path\nimport os,runpy,sys\n"
        "if sys.argv[1:2] == ['journal-update']:\n"
        "    path=Path(os.environ['ARCHIVE_TEST_JOURNAL_COUNTER'])\n"
        "    count=int(path.read_text() if path.exists() else '0')+1\n"
        "    path.write_text(str(count))\n"
        "    if count == 5: raise SystemExit('forced provenance journal failure')\n"
        f"runpy.run_path({str(REPO_ROOT / 'scripts' / 'archive_transaction_helper.py')!r}, run_name='__main__')\n",
        encoding="utf-8",
    )

    result = run_archive(
        repo,
        "--push",
        extra_env={"ARCHIVE_HELPER": str(helper), "ARCHIVE_TEST_JOURNAL_COUNTER": str(counter)},
    )

    assert result.returncode != 0
    assert git(repo, "branch", "--show-current") == "feature/archive"
    assert git(repo, "rev-parse", "HEAD") == base
    assert git(repo, "--git-dir", str(remote), "rev-parse", "main") == base


def test_source_head_change_after_validation_fails_before_staging(tmp_path: Path) -> None:
    repo, remote = setup_feature_repo(tmp_path)
    (repo / "feature.txt").write_text("feature\n", encoding="utf-8")
    git(repo, "add", "feature.txt")
    git(repo, "commit", "-m", "validated feature")
    source_head = git(repo, "rev-parse", "HEAD")
    base = git(repo, "--git-dir", str(remote), "rev-parse", "main")
    counter = tmp_path / "journal-update-count"
    helper = tmp_path / "advance-source-helper.py"
    helper.write_text(
        "from pathlib import Path\nimport os,runpy,subprocess,sys\n"
        "if sys.argv[1:2] == ['journal-update']:\n"
        "    path=Path(os.environ['ARCHIVE_TEST_JOURNAL_COUNTER'])\n"
        "    count=int(path.read_text() if path.exists() else '0')+1\n"
        "    path.write_text(str(count))\n"
        "    if count == 6:\n"
        "        subprocess.run(['git','-C',os.environ['ARCHIVE_TEST_REPO'],'commit','--allow-empty','-m','intruder'], check=True)\n"
        f"runpy.run_path({str(REPO_ROOT / 'scripts' / 'archive_transaction_helper.py')!r}, run_name='__main__')\n",
        encoding="utf-8",
    )

    result = run_archive(
        repo,
        "--push",
        extra_env={
            "ARCHIVE_HELPER": str(helper),
            "ARCHIVE_TEST_JOURNAL_COUNTER": str(counter),
            "ARCHIVE_TEST_REPO": str(repo),
        },
    )

    assert result.returncode != 0
    assert git(repo, "branch", "--show-current") == "feature/archive"
    assert git(repo, "rev-parse", "HEAD") != source_head
    assert git(repo, "--git-dir", str(remote), "rev-parse", "main") == base


def test_archive_markdown_mismatch_fails_without_publishing_a_record(tmp_path: Path) -> None:
    repo, remote = setup_feature_repo(tmp_path)
    (repo / "feature.txt").write_text("feature\n", encoding="utf-8")
    git(repo, "add", "feature.txt")
    git(repo, "commit", "-m", "feature")
    bad_helper = tmp_path / "bad-render-helper.py"
    source = (REPO_ROOT / "scripts" / "archive_transaction_helper.py").read_text(encoding="utf-8")
    expected = 'f"- Validated head: {markdown_value(journal.get(\'validated_head\'))}",'
    assert expected in source
    bad_helper.write_text(source.replace(expected, '"- Validated head: mismatch",'), encoding="utf-8")

    result = run_archive(repo, "--push", extra_env={"ARCHIVE_HELPER": str(bad_helper)})

    assert result.returncode != 0
    transaction, journal = journal_for(repo)
    assert journal["phase"] == "archive"
    assert journal["phase_status"] == "failed"
    assert git(repo, "--git-dir", str(remote), "rev-parse", "main") == git(repo, "rev-parse", "HEAD")
    assert not list((repo / "local_archive" / "docs" / "governance" / "archive").glob("*.md"))
    assert (transaction.parent / "archive-record.md").is_file()


def test_helper_marks_explicit_signal_as_interrupted(tmp_path: Path) -> None:
    log = tmp_path / "test.log"
    result = tmp_path / "result.json"
    process = subprocess.Popen(
        [
            "python3", str(REPO_ROOT / "scripts" / "archive_transaction_helper.py"), "run",
            "--log", str(log), "--result-file", str(result), "--timeout-seconds", "20",
            "--heartbeat-seconds", "1", "--", "bash", "-lc", "sleep 20",
        ],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    assert process.stdout is not None
    assert process.stdout.readline().startswith("test started:")
    process.terminate()
    process.communicate(timeout=5)

    assert json.loads(result.read_text(encoding="utf-8"))["status"] == "interrupted"


def test_timeout_escalates_to_kill_after_term_grace(tmp_path: Path) -> None:
    log = tmp_path / "timeout.log"
    result = tmp_path / "result.json"
    completed = subprocess.run(
        [
            "python3", str(REPO_ROOT / "scripts" / "archive_transaction_helper.py"), "run",
            "--log", str(log), "--result-file", str(result), "--timeout-seconds", "0.2",
            "--grace-seconds", "0.1", "--", "python3", "-c",
            "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(30)",
        ],
        text=True,
        capture_output=True,
        timeout=5,
    )
    assert completed.returncode != 0
    recorded = json.loads(result.read_text(encoding="utf-8"))
    assert recorded["status"] == "timed_out"
    assert recorded["exit_code"] == -9


def test_self_test_exits_successfully_without_holding_a_lock() -> None:
    result = subprocess.run([str(SCRIPT), "--self-test"], text=True, capture_output=True)

    assert result.returncode == 0, result.stderr
    assert result.stdout == "self-test: ok\n"


def test_archive_failure_resumes_without_repeating_push(tmp_path: Path) -> None:
    repo, remote = setup_feature_repo(tmp_path)
    (repo / "feature.txt").write_text("feature\n", encoding="utf-8")
    git(repo, "add", "feature.txt")
    git(repo, "commit", "-m", "feature")
    source_head = git(repo, "rev-parse", "HEAD")
    validation = write_validation_record(repo, source_head)
    checksum = json.loads(validation.read_text(encoding="utf-8"))["checksum"]
    blocked_parent = repo / "local_archive" / "blocked-parent"
    blocked_parent.parent.mkdir(parents=True, exist_ok=True)
    blocked_parent.write_text("not a directory", encoding="utf-8")

    failed = run_archive(repo, "--push", "--reuse-validation", str(validation), "--record", str(blocked_parent / "record.md"))
    assert failed.returncode != 0
    transaction, journal = journal_for(repo)
    merged_head = git(repo, "rev-parse", "HEAD")
    assert journal["phase"] == "archive"
    assert git(repo, "--git-dir", str(remote), "rev-parse", "main") == merged_head
    blocked_parent.unlink()
    blocked_parent.mkdir()
    original_record = blocked_parent / "record.md"
    original_record.write_text("older archive\n", encoding="utf-8")

    resumed = run_archive(repo, "--resume", transaction.parent.name)
    assert resumed.returncode == 0, resumed.stderr
    assert git(repo, "--git-dir", str(remote), "rev-parse", "main") == merged_head
    journal = json.loads(transaction.read_text(encoding="utf-8"))
    assert journal["phase"] == "completed"
    assert journal["validation_status"] == "reused"
    assert journal["validated_head"] == source_head
    assert journal["validation_record_checksum"] == checksum
    record = repo / str(journal["archive_record_path"])
    assert journal["archive_record_previous_path"] == original_record.relative_to(repo).as_posix()
    assert record != original_record
    assert original_record.read_text(encoding="utf-8") == "older archive\n"
    assert record.is_file()
    assert f"- Validated head: {source_head}" in record.read_text(encoding="utf-8")


def test_archive_running_resumes_before_or_after_record_publish(tmp_path: Path) -> None:
    for published in (False, True):
        repo, remote = setup_feature_repo(tmp_path / str(published).lower())
        (repo / "feature.txt").write_text("feature\n", encoding="utf-8")
        completed = run_archive(repo, "--push")
        assert completed.returncode == 0, completed.stderr
        transaction, journal = journal_for(repo)
        head = git(repo, "rev-parse", "HEAD")
        record = repo / str(journal["archive_record_path"])
        if not published:
            record.unlink()
        journal["phase"] = "archive"
        journal["phase_status"] = "running"
        journal["archive_result"] = {"status": "pending"}
        transaction.write_text(json.dumps(journal), encoding="utf-8")

        resumed = run_archive(repo, "--resume", transaction.parent.name)

        assert resumed.returncode == 0, resumed.stderr
        journal = json.loads(transaction.read_text(encoding="utf-8"))
        assert journal["phase"] == "completed"
        assert journal["phase_status"] == "succeeded"
        assert journal["archive_result"]["status"] == "succeeded"
        assert record.is_file()
        assert git(repo, "--git-dir", str(remote), "rev-parse", "main") == head


def test_archive_resume_rejects_transaction_record_symlink_escape(tmp_path: Path) -> None:
    for matching in (False, True):
        repo, _remote = setup_feature_repo(tmp_path / str(matching).lower())
        (repo / "feature.txt").write_text("feature\n", encoding="utf-8")
        git(repo, "add", "feature.txt")
        git(repo, "commit", "-m", "feature")
        source_head = git(repo, "rev-parse", "HEAD")
        validation = write_validation_record(repo, source_head)
        blocked_parent = repo / "local_archive" / "blocked-parent"
        blocked_parent.parent.mkdir(parents=True, exist_ok=True)
        blocked_parent.write_text("not a directory", encoding="utf-8")
        failed = run_archive(
            repo,
            "--push",
            "--reuse-validation",
            str(validation),
            "--record",
            str(blocked_parent / "record.md"),
        )
        assert failed.returncode != 0
        transaction, journal = journal_for(repo)
        blocked_parent.unlink()
        blocked_parent.mkdir()
        original_record = blocked_parent / "record.md"
        original_record.write_text("older archive\n", encoding="utf-8")
        candidate = blocked_parent / f"record-{transaction.parent.name}.md"
        escaped = repo.parent / "escaped-record.md"
        if matching:
            included = transaction.parent / "included.txt"
            changed = transaction.parent / "changed.txt"
            included.write_text("none\n", encoding="utf-8")
            changed.write_text("none\n", encoding="utf-8")
            rendered = subprocess.run(
                [
                    sys.executable,
                    str(REPO_ROOT / "scripts" / "archive_transaction_helper.py"),
                    "archive-render",
                    "--journal",
                    str(transaction),
                    "--output",
                    str(escaped),
                    "--included-commits-file",
                    str(included),
                    "--changed-files-file",
                    str(changed),
                    "--remote",
                    "origin",
                ],
                text=True,
                capture_output=True,
            )
            assert rendered.returncode == 0, rendered.stderr
        candidate.symlink_to(escaped)

        resumed = run_archive(repo, "--resume", transaction.parent.name)

        assert resumed.returncode == 81
        journal = json.loads(transaction.read_text(encoding="utf-8"))
        assert journal["phase"] == "archive"
        assert journal["phase_status"] == "failed"
        assert journal["archive_record_path"] == original_record.relative_to(repo).as_posix()
        assert original_record.read_text(encoding="utf-8") == "older archive\n"
        assert candidate.is_symlink()
        assert escaped.is_file() is matching


def test_active_lock_rejects_a_second_transaction(tmp_path: Path) -> None:
    repo, _remote = setup_feature_repo(tmp_path)
    process_env = os.environ | {
        "ARCHIVE_ROOT": str(repo),
        "ARCHIVE_HELPER": str(REPO_ROOT / "scripts" / "archive_transaction_helper.py"),
        "ARCHIVE_PYTHON_BIN": sys.executable,
        "ARCHIVE_PYTHON_TEST_COMMAND": "sleep 3",
        "ARCHIVE_NODE_TEST_COMMAND": "printf node-ok",
    }
    first = subprocess.Popen(
        [str(SCRIPT), "--push"], text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=process_env
    )
    assert first.stdout is not None
    while True:
        line = first.stdout.readline()
        if "test started:" in line:
            break
        if not line and first.poll() is not None:
            _stdout, stderr = first.communicate()
            raise AssertionError(f"first archive transaction exited before validation: {stderr}")
    runtime = repo / "local_archive" / "runtime" / "archive-and-push"

    second = run_archive(repo, "--push")

    assert second.returncode == 73
    assert "lock is active" in second.stderr
    assert len(list(runtime.glob("*/transaction.json"))) == 1
    first.communicate(timeout=30)
    assert first.returncode == 0, first.stderr
    journal = json.loads(next(runtime.glob("*/transaction.json")).read_text(encoding="utf-8"))
    assert journal["phase"] == "completed"
    assert len(list((repo / "local_archive" / "docs" / "governance" / "archive").glob("*.md"))) == 1


def test_dead_prejournal_lock_is_recovered_without_an_orphan_transaction(tmp_path: Path) -> None:
    repo, remote = setup_feature_repo(tmp_path)
    runtime = repo / "local_archive" / "runtime" / "archive-and-push"
    lock = runtime / ".flock"
    lock.parent.mkdir(parents=True)
    lock.write_text("pid=999999999\nstarted_at=stale\n", encoding="utf-8")
    lock.chmod(0o600)

    result = run_archive(repo, "--push")

    assert result.returncode == 0, result.stderr
    journals = list(runtime.glob("*/transaction.json"))
    assert len(journals) == 1
    assert json.loads(journals[0].read_text(encoding="utf-8"))["phase"] == "completed"
    assert lock.is_file()
    assert "pid=999999999" not in lock.read_text(encoding="utf-8")
    assert git(repo, "--git-dir", str(remote), "rev-parse", "main") == git(repo, "rev-parse", "HEAD")


def test_archive_lock_rejects_non_regular_paths_before_transaction(tmp_path: Path) -> None:
    for kind in ("fifo", "directory", "symlink", "world-writable", "hard-link"):
        repo, remote = setup_feature_repo(tmp_path / kind)
        base = git(repo, "rev-parse", "HEAD")
        runtime = repo / "local_archive" / "runtime" / "archive-and-push"
        runtime.mkdir(parents=True)
        lock = runtime / ".flock"
        target = runtime / "lock-target"
        if kind == "fifo":
            os.mkfifo(lock)
        elif kind == "directory":
            lock.mkdir()
        elif kind == "symlink":
            target.write_text("do not touch\n", encoding="utf-8")
            target.chmod(0o600)
            lock.symlink_to(target)
        elif kind == "hard-link":
            target.write_text("do not touch\n", encoding="utf-8")
            target.chmod(0o600)
            os.link(target, lock)
        else:
            lock.write_text("pid=none\n", encoding="utf-8")
            lock.chmod(0o666)

        target_digest = hashlib.sha256(target.read_bytes()).hexdigest() if target.exists() else None
        target_status = target.stat() if target.exists() else None

        result = run_archive(repo, "--push")

        assert result.returncode == 74
        assert "archive transaction lock" in result.stderr
        assert not list(runtime.glob("*/transaction.json"))
        assert git(repo, "rev-parse", "HEAD") == base
        assert git(repo, "--git-dir", str(remote), "rev-parse", "main") == base
        if kind == "symlink":
            assert lock.is_symlink()
        if target_status is not None:
            assert hashlib.sha256(target.read_bytes()).hexdigest() == target_digest
            after = target.stat()
            assert (after.st_uid, stat.S_IMODE(after.st_mode)) == (
                target_status.st_uid,
                stat.S_IMODE(target_status.st_mode),
            )
        if kind == "world-writable":
            assert stat.S_IMODE(lock.stat().st_mode) == 0o666


def test_archive_lock_rejects_symlinked_runtime_parent(tmp_path: Path) -> None:
    repo, _remote = setup_feature_repo(tmp_path)
    runtime = repo / "local_archive" / "runtime"
    runtime.mkdir(parents=True)
    outside = tmp_path / "outside-runtime"
    outside.mkdir()
    (runtime / "archive-and-push").symlink_to(outside)

    result = run_archive(repo, "--push")

    assert result.returncode == 74
    assert not (outside / ".flock").exists()
    assert not list(outside.glob("*/transaction.json"))


def test_archive_lock_rejects_missing_or_unrelated_inherited_fd(tmp_path: Path) -> None:
    repo, _remote = setup_feature_repo(tmp_path)
    runtime = repo / "local_archive" / "runtime" / "archive-and-push"
    invalid = run_archive(repo, "--push", extra_env={"ARCHIVE_TRANSACTION_LOCK_FD": "999999"})
    assert invalid.returncode == 74
    assert not list(runtime.glob("*/transaction.json"))

    unrelated = tmp_path / "unrelated.lock"
    with unrelated.open("w+") as descriptor:
        env = os.environ | {
            "ARCHIVE_ROOT": str(repo),
            "ARCHIVE_HELPER": str(REPO_ROOT / "scripts" / "archive_transaction_helper.py"),
            "ARCHIVE_PYTHON_BIN": sys.executable,
            "ARCHIVE_PYTHON_TEST_COMMAND": "printf python-ok",
            "ARCHIVE_NODE_TEST_COMMAND": "printf node-ok",
            "ARCHIVE_TRANSACTION_LOCK_FD": str(descriptor.fileno()),
        }
        result = subprocess.run(
            [str(SCRIPT), "--push"],
            text=True,
            capture_output=True,
            env=env,
            pass_fds=(descriptor.fileno(),),
            timeout=30,
        )
    assert result.returncode == 74
    assert not list(runtime.glob("*/transaction.json"))


def test_archive_helper_rejects_final_symlinks_without_touching_targets(tmp_path: Path) -> None:
    root = tmp_path / "repo"
    runtime = root / "local_archive" / "runtime"
    runtime.mkdir(parents=True)
    protected = runtime / "protected"
    protected.write_text("do not touch\n", encoding="utf-8")
    protected.chmod(0o600)
    before = protected.stat()
    digest = hashlib.sha256(protected.read_bytes()).hexdigest()
    lock = runtime / ".flock"
    lock.symlink_to(protected)

    with protected.open("r+") as descriptor:
        verified = subprocess.run(
            [
                sys.executable,
                str(REPO_ROOT / "scripts" / "archive_transaction_helper.py"),
                "lock-verify",
                "--root",
                str(root),
                "--lock",
                str(lock),
                "--fd",
                str(descriptor.fileno()),
            ],
            text=True,
            capture_output=True,
            pass_fds=(descriptor.fileno(),),
        )

    source = runtime / "source.md"
    source.symlink_to(protected)
    destination = root / "local_archive" / "docs" / "record.md"
    published = subprocess.run(
        [
            sys.executable,
            str(REPO_ROOT / "scripts" / "archive_transaction_helper.py"),
            "archive-publish",
            "--root",
            str(root),
            "--source",
            str(source),
            "--target",
            str(destination),
        ],
        text=True,
        capture_output=True,
    )

    assert verified.returncode == 74
    assert published.returncode == 82
    assert lock.is_symlink() and source.is_symlink()
    assert not destination.exists()
    assert hashlib.sha256(protected.read_bytes()).hexdigest() == digest
    after = protected.stat()
    assert (after.st_uid, stat.S_IMODE(after.st_mode)) == (
        before.st_uid,
        stat.S_IMODE(before.st_mode),
    )


def test_local_archive_containment_precedes_parent_creation(tmp_path: Path) -> None:
    root = tmp_path / "repo"
    source = root / "local_archive" / "runtime" / "source.md"
    source.parent.mkdir(parents=True)
    source.write_text("archive\n", encoding="utf-8")
    outside = root / "outside"

    lock = subprocess.run(
        [
            sys.executable,
            str(REPO_ROOT / "scripts" / "archive_transaction_helper.py"),
            "lock-exec",
            "--root",
            str(root),
            "--lock",
            str(root / "local_archive" / ".." / "outside" / "lock" / ".flock"),
            "--",
            "/usr/bin/true",
        ],
        text=True,
        capture_output=True,
    )
    published = subprocess.run(
        [
            sys.executable,
            str(REPO_ROOT / "scripts" / "archive_transaction_helper.py"),
            "archive-publish",
            "--root",
            str(root),
            "--source",
            str(source),
            "--target",
            str(root / "local_archive" / ".." / "outside" / "archive" / "record.md"),
        ],
        text=True,
        capture_output=True,
    )

    assert lock.returncode == 74
    assert published.returncode == 82
    assert not outside.exists()
    assert source.read_text(encoding="utf-8") == "archive\n"


def test_archive_publish_never_replaces_and_rejects_symlinked_parent(tmp_path: Path) -> None:
    root = tmp_path / "repo"
    source = root / "local_archive" / "runtime" / "source.md"
    target = root / "local_archive" / "docs" / "record.md"
    source.parent.mkdir(parents=True)
    target.parent.mkdir(parents=True)
    source.write_text("new\n", encoding="utf-8")
    target.write_text("old\n", encoding="utf-8")
    existing = subprocess.run(
        [
            sys.executable,
            str(REPO_ROOT / "scripts" / "archive_transaction_helper.py"),
            "archive-publish",
            "--root",
            str(root),
            "--source",
            str(source),
            "--target",
            str(target),
        ],
        text=True,
        capture_output=True,
    )
    assert existing.returncode == 17
    assert target.read_text(encoding="utf-8") == "old\n"
    assert source.read_text(encoding="utf-8") == "new\n"

    symlink_target = root / "local_archive" / "docs" / "resolved.md"
    symlink_target.write_text("symlink target\n", encoding="utf-8")
    target_symlink = root / "local_archive" / "docs" / "record-link.md"
    target_symlink.symlink_to(symlink_target)
    symlinked = subprocess.run(
        [
            sys.executable,
            str(REPO_ROOT / "scripts" / "archive_transaction_helper.py"),
            "archive-publish",
            "--root",
            str(root),
            "--source",
            str(source),
            "--target",
            str(target_symlink),
        ],
        text=True,
        capture_output=True,
    )
    assert symlinked.returncode == 17
    assert target_symlink.is_symlink()
    assert symlink_target.read_text(encoding="utf-8") == "symlink target\n"
    assert source.read_text(encoding="utf-8") == "new\n"

    outside = tmp_path / "outside-archive"
    outside.mkdir()
    escaped_parent = root / "local_archive" / "escaped"
    escaped_parent.symlink_to(outside)
    escaped = subprocess.run(
        [
            sys.executable,
            str(REPO_ROOT / "scripts" / "archive_transaction_helper.py"),
            "archive-publish",
            "--root",
            str(root),
            "--source",
            str(source),
            "--target",
            str(escaped_parent / "record.md"),
        ],
        text=True,
        capture_output=True,
    )
    assert escaped.returncode == 82
    assert not (outside / "record.md").exists()
    assert source.read_text(encoding="utf-8") == "new\n"

    source_alias = source.with_name("source-alias.md")
    os.link(source, source_alias)
    hard_linked_target = root / "local_archive" / "docs" / "hard-linked.md"
    hard_linked = subprocess.run(
        [
            sys.executable,
            str(REPO_ROOT / "scripts" / "archive_transaction_helper.py"),
            "archive-publish",
            "--root",
            str(root),
            "--source",
            str(source),
            "--target",
            str(hard_linked_target),
        ],
        text=True,
        capture_output=True,
    )
    assert hard_linked.returncode == 82
    assert not hard_linked_target.exists()
    source_alias.unlink()

    successful_target = root / "local_archive" / "new" / "record.md"
    source_inode = source.stat().st_ino
    successful = subprocess.run(
        [
            sys.executable,
            str(REPO_ROOT / "scripts" / "archive_transaction_helper.py"),
            "archive-publish",
            "--root",
            str(root),
            "--source",
            str(source),
            "--target",
            str(successful_target),
        ],
        text=True,
        capture_output=True,
    )
    assert successful.returncode == 0, successful.stderr
    assert not source.exists()
    assert successful_target.read_text(encoding="utf-8") == "new\n"
    assert successful_target.stat().st_ino == source_inode


def test_explicit_archive_record_final_symlink_is_rejected_before_transaction(tmp_path: Path) -> None:
    repo, remote = setup_feature_repo(tmp_path)
    base = git(repo, "rev-parse", "HEAD")
    record = repo / "local_archive" / "docs" / "governance" / "archive" / "record.md"
    resolved = record.with_name("resolved.md")
    record.parent.mkdir(parents=True)
    record.symlink_to(resolved)

    result = run_archive(repo, "--push", "--record", str(record))

    assert result.returncode != 0
    assert record.is_symlink()
    assert not resolved.exists()
    assert not list((repo / "local_archive" / "runtime" / "archive-and-push").glob("*/transaction.json"))
    assert git(repo, "rev-parse", "HEAD") == base
    assert git(repo, "--git-dir", str(remote), "rev-parse", "main") == base


def test_origin_change_after_validation_fails_closed(tmp_path: Path) -> None:
    repo, remote = setup_feature_repo(tmp_path)
    process_env = os.environ | {
        "ARCHIVE_ROOT": str(repo),
        "ARCHIVE_HELPER": str(REPO_ROOT / "scripts" / "archive_transaction_helper.py"),
        "ARCHIVE_PYTHON_BIN": sys.executable,
        "ARCHIVE_PYTHON_TEST_COMMAND": "sleep 2",
        "ARCHIVE_NODE_TEST_COMMAND": "printf node-ok",
    }
    process = subprocess.Popen([str(SCRIPT), "--push"], text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=process_env)
    assert process.stdout is not None
    while "test started:" not in process.stdout.readline():
        pass
    racer = tmp_path / "racer"
    subprocess.run(["git", "clone", "--branch", "main", str(remote), str(racer)], check=True, capture_output=True)
    git(racer, "config", "user.name", "Racer")
    git(racer, "config", "user.email", "racer@example.test")
    (racer / "race.txt").write_text("race\n", encoding="utf-8")
    git(racer, "add", "race.txt")
    git(racer, "commit", "-m", "race")
    git(racer, "push", "origin", "main")
    process.communicate(timeout=30)

    assert process.returncode != 0
    _path, journal = journal_for(repo)
    assert journal["failure_stage"] == "remote_race"
    assert git(repo, "branch", "--show-current") == "feature/archive"
