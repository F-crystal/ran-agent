import importlib.util
import hashlib
import io
import json
import os
from pathlib import Path
import pwd
import shlex
import stat
import subprocess
import sys
import tempfile
import unittest
import urllib.error
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[1] / "scripts/install-ombre-steward-token.py"
SPEC = importlib.util.spec_from_file_location("ombre_steward_token", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
VERIFY_SCRIPT = SCRIPT.with_name("verify-ombre-steward-runtime.py")
VERIFY_SPEC = importlib.util.spec_from_file_location("ombre_steward_verify", VERIFY_SCRIPT)
VERIFY_MODULE = importlib.util.module_from_spec(VERIFY_SPEC)
VERIFY_SPEC.loader.exec_module(VERIFY_MODULE)
IDENTITY_SCRIPT = SCRIPT.with_name("verify-ran-agent-runtime-identity.sh")


class OmbreStewardTokenTest(unittest.TestCase):
    @unittest.skipUnless(
        os.geteuid() == 0 and Path("/usr/sbin/runuser").is_file(),
        "cross-UID verifier boundary requires Linux root",
    )
    def test_root_verifier_executes_live_venv_only_as_ran_agent_with_clean_env(self):
        try:
            account = pwd.getpwnam("ran-agent")
        except KeyError:
            self.skipTest("ran-agent account is unavailable")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            root.chmod(0o755)
            state = root / "state"
            source = state / "ombre-brain/upstream"
            venv = state / "ombre-brain/.venv"
            token = state / MODULE.TOKEN_RELATIVE_PATH
            identity_file = root / "identity.json"
            marker = venv / "sentinel"
            source.mkdir(parents=True)
            (venv / "bin").mkdir(parents=True)
            token.parent.mkdir(parents=True)
            subprocess.run(["git", "init"], cwd=source, check=True, stdout=subprocess.DEVNULL)
            subprocess.run(["git", "config", "user.email", "sentinel@example.invalid"], cwd=source, check=True)
            subprocess.run(["git", "config", "user.name", "sentinel"], cwd=source, check=True)
            lock = source / "requirements.lock.txt"
            lock.write_text("fixture==1\n", encoding="ascii")
            subprocess.run(["git", "add", "."], cwd=source, check=True)
            subprocess.run(["git", "commit", "-m", "fixture"], cwd=source, check=True, stdout=subprocess.DEVNULL)
            head = subprocess.run(
                ["git", "rev-parse", "HEAD"], cwd=source, check=True,
                capture_output=True, text=True,
            ).stdout.strip()
            stamp = venv / ".requirements.lock.fingerprint"
            stamp.write_text(hashlib.sha256(lock.read_bytes()).hexdigest() + "\n", encoding="ascii")
            fake_python = venv / "bin/python"
            fake_python.write_text(
                "#!/bin/sh\n"
                f"printf '%s:%s\\n' \"$(id -u)\" \"${{RAN_AGENT_SENTINEL_SECRET-unset}}\" > {shlex.quote(str(marker))}\n"
                "exit 91\n",
                encoding="ascii",
            )
            fake_python.chmod(0o755)
            token.write_text(("a" * 64) + "\n", encoding="ascii")
            token.chmod(0o600)
            identity_file.write_text(json.dumps({"base_upstream_commit": head}), encoding="utf-8")
            for owned_root in (source, venv):
                for path in [owned_root, *owned_root.rglob("*")]:
                    os.chown(path, account.pw_uid, account.pw_gid)
            os.chown(token, account.pw_uid, account.pw_gid)

            result = subprocess.run(
                [
                    sys.executable, str(VERIFY_SCRIPT),
                    "--state-dir", str(state),
                    "--identity-file", str(identity_file),
                    "--source-dir", str(source),
                    "--venv", str(venv),
                ],
                env={**os.environ, "RAN_AGENT_SENTINEL_SECRET": "must-not-leak"},
                capture_output=True,
                text=True,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(marker.read_text(encoding="ascii"), f"{account.pw_uid}:unset\n")

    def test_atomic_install_and_rotation_are_owner_only(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "steward-api-token"
            MODULE.install_token(target, os.getuid(), os.getgid())
            first = target.read_bytes()
            info = os.lstat(target)
            self.assertTrue(stat.S_ISREG(info.st_mode))
            self.assertFalse(stat.S_ISLNK(info.st_mode))
            self.assertEqual(stat.S_IMODE(info.st_mode), 0o600)
            self.assertEqual((info.st_uid, info.st_gid), (os.getuid(), os.getgid()))
            self.assertRegex(first.decode("ascii"), r"^[a-f0-9]{64}\n$")

            MODULE.install_token(target, os.getuid(), os.getgid())
            second = target.read_bytes()
            self.assertNotEqual(first, second)
            self.assertEqual(stat.S_IMODE(os.lstat(target).st_mode), 0o600)
            self.assertEqual(
                [entry.name for entry in target.parent.iterdir()],
                ["steward-api-token"],
            )

    def test_symlink_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            real = root / "real"
            real.write_text("secret\n", encoding="ascii")
            link = root / "steward-api-token"
            link.symlink_to(real)
            with self.assertRaisesRegex(RuntimeError, "non-symlink regular file"):
                MODULE.assert_token_file(link, os.getuid(), os.getgid())

    def test_wrong_owner_group_or_mode_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "steward-api-token"
            MODULE.install_token(target, os.getuid(), os.getgid())
            with self.assertRaisesRegex(RuntimeError, "owner/group/mode mismatch"):
                MODULE.assert_token_file(target, os.getuid() + 1, os.getgid())
            target.chmod(0o640)
            with self.assertRaisesRegex(RuntimeError, "owner/group/mode mismatch"):
                MODULE.assert_token_file(target, os.getuid(), os.getgid())

    def test_secret_rollback_restores_old_token_and_is_destroyed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "live" / "steward-api-token"
            rollback = root / "private-rollback"
            rollback.mkdir(mode=0o700)
            MODULE.install_token(target, os.getuid(), os.getgid())
            old = target.read_bytes()

            self.assertTrue(MODULE.backup_token(
                target, rollback, os.getuid(), os.getgid(), os.getuid(),
            ))
            backup = rollback / MODULE.ROLLBACK_FILE
            self.assertEqual(stat.S_IMODE(backup.stat().st_mode), 0o600)
            MODULE.install_token(target, os.getuid(), os.getgid())
            self.assertNotEqual(target.read_bytes(), old)

            MODULE.restore_token(
                target, rollback, os.getuid(), os.getgid(), os.getuid(),
            )
            self.assertEqual(target.read_bytes(), old)
            MODULE.destroy_rollback(rollback, os.getuid())
            self.assertFalse(rollback.exists())

    def test_rotation_failure_can_restore_without_copying_secret_into_state(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            os.chown(root, os.getuid(), os.getgid())
            root.chmod(0o700)
            state = root / "live-state"
            stage = root / "stage"
            rollback = root / "release-private"
            target = state / MODULE.TOKEN_RELATIVE_PATH
            rollback.mkdir(mode=0o700)
            stage.mkdir()
            MODULE.install_token(target, os.getuid(), os.getgid())
            old = target.read_bytes()
            MODULE.backup_token(target, rollback, os.getuid(), os.getgid(), os.getuid())
            MODULE.install_token(target, os.getuid(), os.getgid())
            MODULE.restore_token(target, rollback, os.getuid(), os.getgid(), os.getuid())
            MODULE.destroy_rollback(rollback, os.getuid())

            self.assertEqual(target.read_bytes(), old)
            self.assertFalse((stage / MODULE.TOKEN_RELATIVE_PATH).exists())
            self.assertEqual(
                list((state / "ombre-compat").rglob("*")),
                [state / "ombre-compat/secrets", target],
            )

    def test_rotated_token_is_accepted_and_old_token_is_rejected_without_leakage(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            os.chown(root, os.getuid(), os.getgid())
            root.chmod(0o700)
            state = root / "live-state"
            token = state / MODULE.TOKEN_RELATIVE_PATH
            source = state / "ombre-brain/upstream"
            venv = state / "ombre-brain/.venv"
            identity_file = root / "identity.json"
            token.parent.mkdir(parents=True)
            source.mkdir(parents=True)
            (source / ".git").mkdir()
            (venv / "bin").mkdir(parents=True)
            lock = source / "requirements.lock.txt"
            lock.write_text("fixture==1\n", encoding="ascii")
            stamp = venv / ".requirements.lock.fingerprint"
            stamp.write_text(hashlib.sha256(lock.read_bytes()).hexdigest() + "\n", encoding="ascii")
            current = ("a" * 64) + "\n"
            old = ("b" * 64) + "\n"
            token.write_text(current, encoding="ascii")
            os.chown(token, os.getuid(), os.getgid())
            token.chmod(0o600)
            old_file = root / "old-token"
            old_file.write_text(old, encoding="ascii")
            identity = {
                "effective_tree_digest": "sha256:" + ("c" * 64),
                "base_upstream_commit": "d" * 40,
            }
            identity_file.write_text(json.dumps(identity), encoding="utf-8")

            class Response(io.BytesIO):
                def __enter__(self):
                    return self

                def __exit__(self, *_):
                    self.close()

            def urlopen(request, timeout):
                self.assertEqual(timeout, 5)
                supplied = request.headers["X-ran-agent-steward-token"]
                if supplied == old.strip():
                    raise urllib.error.HTTPError(request.full_url, 401, "unauthorized", {}, None)
                self.assertEqual(supplied, current.strip())
                payload = {
                    "schema_version": "ombre.steward-api/1",
                    "status": "ok",
                    **identity,
                }
                return Response(json.dumps(payload).encode("utf-8"))

            account = type("Account", (), {
                "pw_uid": os.getuid(), "pw_gid": os.getgid(), "pw_name": "ran-agent",
            })()
            group = type("Group", (), {"gr_gid": os.getgid(), "gr_name": "ran-agent"})()
            output = io.StringIO()
            argv = [
                "verify-ombre-steward-runtime.py",
                "--state-dir", str(state),
                "--identity-file", str(identity_file),
                "--source-dir", str(source),
                "--venv", str(venv),
                "--rejected-token-file", str(old_file),
            ]
            def run(command, **_):
                if command[0] == "git":
                    stdout = identity["base_upstream_commit"] + "\n"
                elif "sys.version_info" in command[-1]:
                    stdout = "3.12\n"
                else:
                    stdout = ""
                return subprocess.CompletedProcess(command, 0, stdout=stdout)

            with mock.patch.object(sys, "argv", argv), \
                    mock.patch.object(VERIFY_MODULE.pwd, "getpwnam", return_value=account), \
                    mock.patch.object(VERIFY_MODULE.grp, "getgrnam", return_value=group), \
                    mock.patch.object(VERIFY_MODULE.subprocess, "run", side_effect=run), \
                    mock.patch.object(VERIFY_MODULE.urllib.request, "urlopen", side_effect=urlopen), \
                    mock.patch("sys.stdout", output):
                self.assertEqual(VERIFY_MODULE.main(), 0)
                stamp.write_text("0" * 64 + "\n", encoding="ascii")
                with self.assertRaisesRegex(SystemExit, "lock fingerprint mismatch"):
                    VERIFY_MODULE.main()
            self.assertNotIn(current.strip(), output.getvalue())
            self.assertNotIn(old.strip(), output.getvalue())

    def test_system_account_and_numeric_process_identity_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bin_dir = root / "bin"
            proc = root / "proc"
            bin_dir.mkdir()
            (proc / "123").mkdir(parents=True)
            (bin_dir / "id").write_text(
                "#!/bin/sh\n"
                'case "$1" in\n'
                '  -u) printf "%s\\n" "$MOCK_UID" ;;\n'
                '  -g) printf "%s\\n" "$MOCK_GID" ;;\n'
                '  ran-agent) exit 0 ;;\n'
                "  *) exit 1 ;;\n"
                "esac\n",
                encoding="ascii",
            )
            (bin_dir / "getent").write_text(
                "#!/bin/sh\n"
                'case "$1" in\n'
                '  passwd) printf "ran-agent:x:%s:%s::%s:%s\\n" '
                '"$MOCK_PASSWD_UID" "$MOCK_PASSWD_GID" "$MOCK_HOME" "$MOCK_SHELL" ;;\n'
                '  group) printf "ran-agent:x:%s:\\n" "$MOCK_GROUP_GID" ;;\n'
                "  *) exit 1 ;;\n"
                "esac\n",
                encoding="ascii",
            )
            (bin_dir / "systemctl").write_text(
                "#!/bin/sh\n"
                'case "$*" in\n'
                '  *"--property=User"*) printf "%s\\n" "${MOCK_SYSTEMD_USER:-ran-agent}" ;;\n'
                '  *"--property=Group"*) printf "%s\\n" "${MOCK_SYSTEMD_GROUP:-ran-agent}" ;;\n'
                '  *"--property=MainPID"*) printf "%s\\n" "${MOCK_PID:-123}" ;;\n'
                "  *) exit 1 ;;\n"
                "esac\n",
                encoding="ascii",
            )
            for executable in bin_dir.iterdir():
                executable.chmod(0o755)

            base = {
                **os.environ,
                "PATH": f"{bin_dir}:/usr/bin:/bin",
                "RAN_AGENT_TEST_MODE": "1",
                "RAN_AGENT_TEST_PROC_ROOT": str(proc),
                "MOCK_UID": "999",
                "MOCK_GID": "999",
                "MOCK_PASSWD_UID": "999",
                "MOCK_PASSWD_GID": "999",
                "MOCK_GROUP_GID": "999",
                "MOCK_HOME": "/opt/ran_agent",
                "MOCK_SHELL": "/usr/sbin/nologin",
            }

            def verify(mode="--verify-account", unit=None, **changes):
                env = {**base, **{key: str(value) for key, value in changes.items()}}
                command = ["bash", str(IDENTITY_SCRIPT), mode]
                if unit:
                    command.append(unit)
                return subprocess.run(command, env=env, capture_output=True, text=True)

            self.assertEqual(verify().returncode, 0)
            conflicts = [
                {"MOCK_UID": 0, "MOCK_PASSWD_UID": 0},
                {"MOCK_GID": 0, "MOCK_PASSWD_GID": 0, "MOCK_GROUP_GID": 0},
                {"MOCK_PASSWD_GID": 998},
                {"MOCK_SHELL": "/bin/bash"},
                {"MOCK_HOME": "/home/ran-agent"},
            ]
            for values in conflicts:
                with self.subTest(values=values):
                    self.assertNotEqual(verify(**values).returncode, 0)
            self.assertEqual(
                verify(
                    MOCK_UID=60001,
                    MOCK_GID=60001,
                    MOCK_PASSWD_UID=60001,
                    MOCK_PASSWD_GID=60001,
                    MOCK_GROUP_GID=60001,
                ).returncode,
                0,
            )

            status = proc / "123/status"
            status.write_text(
                "Name:\tfixture\nUid:\t999\t999\t999\t999\n"
                "Gid:\t999\t999\t999\t999\n",
                encoding="ascii",
            )
            for unit in ("ran-agent-node.service", "ran-agent-ombre-brain.service"):
                self.assertEqual(verify("--verify-process", unit).returncode, 0)
            status.write_text(
                "Name:\tfixture\nUid:\t999\t998\t999\t999\n"
                "Gid:\t999\t999\t999\t999\n",
                encoding="ascii",
            )
            self.assertNotEqual(
                verify("--verify-process", "ran-agent-node.service").returncode,
                0,
            )
            status.write_text(
                "Name:\tfixture\nUid:\t999\t999\t999\t999\n"
                "Gid:\t999\t998\t999\t999\n",
                encoding="ascii",
            )
            self.assertNotEqual(
                verify("--verify-process", "ran-agent-ombre-brain.service").returncode,
                0,
            )

    def test_system_account_creation_uses_frozen_system_contract(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bin_dir = root / "bin"
            bin_dir.mkdir()
            group_marker = root / "group-created"
            user_marker = root / "user-created"
            calls = root / "calls"
            (bin_dir / "id").write_text(
                "#!/bin/sh\n"
                'test -e "$MOCK_USER_MARKER" || exit 1\n'
                'case "$1" in\n'
                '  -u) echo 999 ;;\n'
                '  -g) echo 999 ;;\n'
                "  ran-agent) exit 0 ;;\n"
                "  *) exit 1 ;;\n"
                "esac\n",
                encoding="ascii",
            )
            (bin_dir / "getent").write_text(
                "#!/bin/sh\n"
                'if test "$1" = group && test -e "$MOCK_GROUP_MARKER"; then\n'
                '  echo "ran-agent:x:999:"; exit 0\n'
                "fi\n"
                'if test "$1" = passwd && test -e "$MOCK_USER_MARKER"; then\n'
                '  echo "ran-agent:x:999:999::/opt/ran_agent:/usr/sbin/nologin"; exit 0\n'
                "fi\n"
                "exit 2\n",
                encoding="ascii",
            )
            (bin_dir / "groupadd").write_text(
                "#!/bin/sh\n"
                'printf "groupadd:%s\\n" "$*" >> "$MOCK_CALLS"\n'
                'test "$*" = "--system ran-agent" || exit 2\n'
                'touch "$MOCK_GROUP_MARKER"\n',
                encoding="ascii",
            )
            (bin_dir / "useradd").write_text(
                "#!/bin/sh\n"
                'printf "useradd:%s\\n" "$*" >> "$MOCK_CALLS"\n'
                'test "$*" = "--system --gid ran-agent --home-dir /opt/ran_agent '
                '--shell /usr/sbin/nologin ran-agent" || exit 2\n'
                'touch "$MOCK_USER_MARKER"\n',
                encoding="ascii",
            )
            for executable in bin_dir.iterdir():
                executable.chmod(0o755)
            result = subprocess.run(
                ["bash", str(IDENTITY_SCRIPT), "--ensure-account"],
                env={
                    **os.environ,
                    "PATH": f"{bin_dir}:/usr/bin:/bin",
                    "RAN_AGENT_TEST_MODE": "1",
                    "MOCK_GROUP_MARKER": str(group_marker),
                    "MOCK_USER_MARKER": str(user_marker),
                    "MOCK_CALLS": str(calls),
                },
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(
                calls.read_text(encoding="ascii").splitlines(),
                [
                    "groupadd:--system ran-agent",
                    "useradd:--system --gid ran-agent --home-dir /opt/ran_agent "
                    "--shell /usr/sbin/nologin ran-agent",
                ],
            )


if __name__ == "__main__":
    unittest.main()
