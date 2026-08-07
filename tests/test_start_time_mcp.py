"""Behavior tests for the time MCP launcher shell script."""

from __future__ import annotations

import os
import signal
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[1]
SCRIPT = ROOT_DIR / "scripts" / "start_time_mcp.sh"
LAUNCHER_TIMEOUT_SECONDS = 5


def _sandbox_env(env: dict[str, str]) -> dict[str, str]:
    sandbox_root = Path(
        env.get("TMPDIR") or env.get("HOME") or str(env["PATH"]).split(os.pathsep, 1)[0]
    ).resolve()
    return {
        "PATH": f"{env['PATH']}:/usr/bin:/bin",
        "HOME": env.get("HOME", str(sandbox_root)),
        "TMPDIR": env.get("TMPDIR", str(sandbox_root)),
        "XDG_CACHE_HOME": env.get("XDG_CACHE_HOME", str(sandbox_root / "xdg-cache")),
        "UV_CACHE_DIR": env.get("UV_CACHE_DIR", str(sandbox_root / "uv-cache")),
        "UV_TOOL_DIR": env.get("UV_TOOL_DIR", str(sandbox_root / "uv-tools")),
        "NODE_ENV": "test",
        "RAN_AGENT_SKIP_ENV_FILE_LOAD": "1",
        "PYTHONNOUSERSITE": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
    }


def _run_launcher(
    command: list[str], *, cwd: Path, env: dict[str, str], timeout_seconds: float = LAUNCHER_TIMEOUT_SECONDS
) -> subprocess.CompletedProcess[str]:
    process = subprocess.Popen(
        command,
        cwd=cwd,
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
    )
    try:
        stdout, stderr = process.communicate(timeout=timeout_seconds)
    except subprocess.TimeoutExpired as error:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.communicate()
        raise AssertionError(
            f"launcher timed out after {timeout_seconds}s; terminated its process group"
        ) from error
    return subprocess.CompletedProcess(command, process.returncode, stdout, stderr)


def _write_executable(path: Path, content: str) -> None:
    path.write_text(content, encoding="utf-8")
    path.chmod(0o755)


def _time_test_bin(temp_path: Path, probe_log: Path | None = None) -> Path:
    bin_dir = temp_path
    _write_executable(
        bin_dir / "dirname",
        "#!/bin/sh\ncase \"$1\" in */*) printf '%s\\n' \"${1%/*}\" ;; *) printf '.\\n' ;; esac\n",
    )
    probe_line = f"printf 'probe=%s argv=%s\\n' \"$0\" \"$*\" >> \"{probe_log}\"\n" if probe_log else ""
    for name in ("python3", "python"):
        _write_executable(bin_dir / name, f"#!/bin/sh\n{probe_line}exit 1\n")
    return bin_dir



class StartTimeMcpScriptTest(unittest.TestCase):
    def run_script(
        self, env: dict[str, str], timeout_seconds: float = LAUNCHER_TIMEOUT_SECONDS
    ) -> subprocess.CompletedProcess[str]:
        clean_env = _sandbox_env(env)
        clean_env["PATH"] = env["PATH"]
        for key in (
            "LOCAL_TIMEZONE",
            "TIME_MCP_PYTHON",
            "MCP_SERVER_TIME_PYTHON",
            "TIME_MCP_PREWARM",
        ):
            if key in env:
                clean_env[key] = env[key]

        return _run_launcher(
            ["/bin/bash", str(SCRIPT)],
            cwd=ROOT_DIR,
            env=clean_env,
            timeout_seconds=timeout_seconds,
        )

    def test_missing_uvx_errors_when_python_module_is_not_available(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            probe_log = temp_path / "probes.log"
            bin_dir = _time_test_bin(temp_path, probe_log)

            result = self.run_script({"PATH": str(bin_dir)})
            probes = probe_log.read_text(encoding="utf-8") if probe_log.exists() else ""

        self.assertEqual(result.returncode, 127)
        self.assertIn("uvx is required", result.stderr)
        self.assertIn(f"probe={bin_dir / 'python3'}", probes)
        self.assertIn(f"probe={bin_dir / 'python'}", probes)

    def test_env_python_with_preinstalled_module_is_used_before_uvx(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            log_path = temp_path / "argv.log"
            bin_dir = _time_test_bin(temp_path)
            fake_python = temp_path / "time-python"
            fake_uvx = bin_dir / "uvx"
            fake_python.write_text(
                textwrap.dedent(
                    f"""\
                    #!/bin/sh
                    if [ "$1" = "-c" ]; then
                      exit 0
                    fi
                    printf '%s\\n' "$*" > "{log_path}"
                    printf 'guard=%s\\n' "${{RAN_AGENT_SKIP_ENV_FILE_LOAD:-}}" >> "{log_path}"
                    printf 'tmpdir=%s\\n' "${{TMPDIR:-}}" >> "{log_path}"
                    printf 'uv_cache=%s\\n' "${{UV_CACHE_DIR:-}}" >> "{log_path}"
                    exit 0
                    """
                ),
                encoding="utf-8",
            )
            _write_executable(
                fake_uvx,
                "#!/bin/sh\nprintf 'uvx should not run\\n' >&2\nexit 42\n",
            )
            fake_python.chmod(0o755)

            result = self.run_script(
                {
                    "PATH": str(bin_dir),
                    "TIME_MCP_PYTHON": str(fake_python),
                    "LOCAL_TIMEZONE": "Asia/Shanghai",
                }
            )
            logged_argv = log_path.read_text(encoding="utf-8").strip() if log_path.exists() else ""

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("-m mcp_server_time --local-timezone Asia/Shanghai", logged_argv)
        self.assertIn("guard=1", logged_argv)
        self.assertIn(f"tmpdir={temp_path.resolve()}", logged_argv)
        self.assertIn(f"uv_cache={temp_path.resolve() / 'uv-cache'}", logged_argv)

    def test_uvx_fallback_passes_local_timezone_argument(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            log_path = temp_path / "argv.log"
            probe_log = temp_path / "probes.log"
            bin_dir = _time_test_bin(temp_path, probe_log)
            fake_uvx = bin_dir / "uvx"
            fake_uvx.write_text(
                textwrap.dedent(
                    f"""\
                    #!/bin/sh
                    printf '%s\\n' "$*" > "{log_path}"
                    exit 0
                    """
                ),
                encoding="utf-8",
            )
            fake_uvx.chmod(0o755)

            result = self.run_script({"PATH": str(bin_dir), "LOCAL_TIMEZONE": "Asia/Shanghai"})
            logged_argv = log_path.read_text(encoding="utf-8").strip() if log_path.exists() else ""
            probes = probe_log.read_text(encoding="utf-8") if probe_log.exists() else ""

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            logged_argv,
            "mcp-server-time --local-timezone Asia/Shanghai",
        )
        self.assertIn(f"probe={bin_dir / 'python3'}", probes)
        self.assertIn(f"probe={bin_dir / 'python'}", probes)

    def test_timeout_terminates_the_time_launcher_process_group(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            bin_dir = _time_test_bin(temp_path)
            fake_python = temp_path / "hanging-python"
            _write_executable(
                fake_python,
                "#!/bin/sh\nif [ \"$1\" = \"-c\" ]; then exit 0; fi\n(/bin/sleep 30) &\nwait\n",
            )

            with self.assertRaisesRegex(AssertionError, "terminated its process group"):
                self.run_script(
                    {"PATH": str(bin_dir), "TIME_MCP_PYTHON": str(fake_python)},
                    timeout_seconds=0.2,
                )


class StartPlaywrightMcpScriptTest(unittest.TestCase):
    def run_script(self, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
        clean_env = _sandbox_env(env)
        for key in (
            "PLAYWRIGHT_MCP_HEADLESS",
            "PLAYWRIGHT_MCP_PORT",
            "PLAYWRIGHT_MCP_TRANSPORT",
            "PLAYWRIGHT_MCP_HOST",
            "PLAYWRIGHT_MCP_EXECUTABLE_PATH",
            "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH",
            "PLAYWRIGHT_MCP_ISOLATED",
            "PLAYWRIGHT_MCP_USER_DATA_DIR",
            "PLAYWRIGHT_MCP_STORAGE_STATE",
            "PLAYWRIGHT_MCP_CAPS",
        ):
            if key in env:
                clean_env[key] = env[key]

        return _run_launcher(
            ["/bin/bash", str(ROOT_DIR / "scripts" / "start_playwright_mcp.sh")],
            cwd=ROOT_DIR,
            env=clean_env,
        )

    def test_stdio_mode_ignores_port_unless_http_transport_is_explicit(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            log_path = temp_path / "argv.log"
            fake_node = temp_path / "node"
            fake_node.write_text(
                textwrap.dedent(
                    f"""\
                    #!/bin/sh
                    printf '%s\\n' "$*" > "{log_path}"
                    printf 'env_port=%s\\n' "${{PLAYWRIGHT_MCP_PORT:-}}" >> "{log_path}"
                    exit 0
                    """
                ),
                encoding="utf-8",
            )
            fake_node.chmod(0o755)

            result = self.run_script({"PATH": temp_dir, "PLAYWRIGHT_MCP_PORT": "8931"})
            logged_argv = log_path.read_text(encoding="utf-8").strip() if log_path.exists() else ""

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("--port", logged_argv)
        self.assertIn("env_port=", logged_argv)
        self.assertNotIn("env_port=8931", logged_argv)
        self.assertNotIn(
            "export PATH",
            (ROOT_DIR / "scripts" / "start_playwright_mcp.sh").read_text(encoding="utf-8"),
        )

    def test_official_executable_path_env_is_forwarded(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            log_path = temp_path / "argv.log"
            fake_node = temp_path / "node"
            fake_node.write_text(
                textwrap.dedent(
                    f"""\
                    #!/bin/sh
                    printf '%s\\n' "$*" > "{log_path}"
                    exit 0
                    """
                ),
                encoding="utf-8",
            )
            fake_node.chmod(0o755)

            result = self.run_script(
                {
                    "PATH": temp_dir,
                    "PLAYWRIGHT_MCP_EXECUTABLE_PATH": "/snap/bin/chromium",
                }
            )
            logged_argv = log_path.read_text(encoding="utf-8").strip() if log_path.exists() else ""

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("--executable-path /snap/bin/chromium", logged_argv)

    def test_playwright_wrapper_uses_schema_proxy(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            log_path = temp_path / "argv.log"
            fake_node = temp_path / "node"
            fake_node.write_text(
                textwrap.dedent(
                    f"""\
                    #!/bin/sh
                    printf '%s\\n' "$*" > "{log_path}"
                    exit 0
                    """
                ),
                encoding="utf-8",
            )
            fake_node.chmod(0o755)

            result = self.run_script({"PATH": temp_dir})
            logged_argv = log_path.read_text(encoding="utf-8").strip() if log_path.exists() else ""

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("scripts/playwright_mcp_proxy.mjs", logged_argv)

    def test_playwright_wrapper_forwards_isolated_user_data_and_storage_state(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            log_path = temp_path / "argv.log"
            fake_node = temp_path / "node"
            fake_node.write_text(
                textwrap.dedent(
                    f"""\
                    #!/bin/sh
                    printf '%s\\n' "$*" > "{log_path}"
                    exit 0
                    """
                ),
                encoding="utf-8",
            )
            fake_node.chmod(0o755)

            result = self.run_script(
                {
                    "PATH": temp_dir,
                    "PLAYWRIGHT_MCP_ISOLATED": "true",
                    "PLAYWRIGHT_MCP_USER_DATA_DIR": "/opt/ran_agent/.ran_agent_state/playwright-profile",
                    "PLAYWRIGHT_MCP_STORAGE_STATE": "/opt/ran_agent/.ran_agent_state/xhs-auth.json",
                    "PLAYWRIGHT_MCP_CAPS": "network,storage",
                }
            )
            logged_argv = log_path.read_text(encoding="utf-8").strip() if log_path.exists() else ""

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("--isolated", logged_argv)
        self.assertIn("--user-data-dir /opt/ran_agent/.ran_agent_state/playwright-profile", logged_argv)
        self.assertIn("--storage-state /opt/ran_agent/.ran_agent_state/xhs-auth.json", logged_argv)
        self.assertIn("--caps network,storage", logged_argv)


class StartSocialReaderMcpScriptTest(unittest.TestCase):
    def run_script(self, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
        clean_env = _sandbox_env(env)
        for key in (
            "XHS_COOKIE",
            "XHS_MCP_COMMAND",
            "XHS_MCP_ARGS_JSON",
            "SOCIAL_PARSE_MCP_COMMAND",
            "SOCIAL_PARSE_MCP_ARGS_JSON",
            "SOCIAL_READER_MCP_TIMEOUT_MS",
            "SOCIAL_READER_NODE_BIN",
        ):
            if key in env:
                clean_env[key] = env[key]

        return _run_launcher(
            ["/bin/bash", str(ROOT_DIR / "scripts" / "start_social_reader_mcp.sh")],
            cwd=ROOT_DIR,
            env=clean_env,
        )

    def test_social_reader_wrapper_runs_node_facade(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            log_path = temp_path / "argv.log"
            fake_node = temp_path / "node"
            fake_node.write_text(
                textwrap.dedent(
                    f"""\
                    #!/bin/sh
                    printf '%s\\n' "$*" > "{log_path}"
                    printf 'xhs_cookie=%s\\n' "${{XHS_COOKIE:-}}" >> "{log_path}"
                    exit 0
                    """
                ),
                encoding="utf-8",
            )
            fake_node.chmod(0o755)

            result = self.run_script(
                {
                    "PATH": temp_dir,
                    "XHS_COOKIE": "a1=demo",
                    "SOCIAL_READER_NODE_BIN": str(fake_node),
                }
            )
            logged_argv = log_path.read_text(encoding="utf-8").strip() if log_path.exists() else ""

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("node_bridge/src/socialReaderMcpServer.mjs", logged_argv)
        self.assertIn("xhs_cookie=a1=demo", logged_argv)



class LauncherIsolationAuditTest(unittest.TestCase):
    def test_shared_helper_preserves_test_path_and_blocks_env_and_venv(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            env_file = temp_path / ".env.local"
            activate_file = temp_path / "activate"
            env_file.write_text("FROM_ENV=loaded\n", encoding="utf-8")
            activate_file.write_text("FROM_VENV=loaded\n", encoding="utf-8")
            helper = ROOT_DIR / "scripts" / "launcher_test_isolation.sh"
            command = (
                f'source "{helper}"; '
                f'launcher_load_env_file "{env_file}"; '
                f'launcher_activate_venv "{activate_file}"; '
                'launcher_prepend_path "/host-bin"; '
                'printf "%s|%s|%s\\n" "$PATH" "${FROM_ENV:-unset}" "${FROM_VENV:-unset}"'
            )
            isolated_env = _sandbox_env({"PATH": str(temp_path)})
            isolated_env["PATH"] = str(temp_path)
            isolated = _run_launcher(["/bin/bash", "-c", command], cwd=ROOT_DIR, env=isolated_env)
            production_env = dict(isolated_env)
            production_env["NODE_ENV"] = "production"
            production = _run_launcher(["/bin/bash", "-c", command], cwd=ROOT_DIR, env=production_env)

        self.assertEqual(isolated.stdout.strip(), f"{temp_path}|unset|unset")
        self.assertEqual(production.stdout.strip(), f"/host-bin:{temp_path}|loaded|loaded")

    def test_release_gate_mcp_launchers_keep_test_isolation_guards(self) -> None:
        expected = {
            "start_co_reading_mcp.sh",
            "start_external_mcp_gateway.sh",
            "start_media_generation_mcp.sh",
            "start_media_reader_mcp.sh",
            "start_personal_memory_mcp.sh",
            "start_playwright_mcp.sh",
            "start_search_hub_mcp.sh",
            "start_social_reader_mcp.sh",
            "start_sticker_catalog_mcp.sh",
            "start_time_mcp.sh",
        }
        launchers = {path.name for path in (ROOT_DIR / "scripts").glob("start_*mcp*.sh")}
        self.assertEqual(launchers, expected)

        for name in sorted(launchers):
            source = (ROOT_DIR / "scripts" / name).read_text(encoding="utf-8")
            self.assertIn('source "$ROOT_DIR/scripts/launcher_test_isolation.sh"', source, name)
            self.assertNotIn('export PATH=', source, name)
            self.assertNotIn('source "$ENV_FILE"', source, name)
            self.assertNotIn('source "$NODE_BRIDGE_ENV_FILE"', source, name)
            self.assertNotIn('source "$ROOT_DIR/.venv/bin/activate"', source, name)
            self.assertNotIn('command -v ', source, name)

        helper = (ROOT_DIR / "scripts" / "launcher_test_isolation.sh").read_text(encoding="utf-8")
        self.assertIn('[ "${NODE_ENV:-}" = "test" ] && [ "${RAN_AGENT_SKIP_ENV_FILE_LOAD:-}" = "1" ]', helper)
        self.assertIn('launcher_test_isolation_active && return 0', helper)


if __name__ == "__main__":
    unittest.main()
