"""Behavior tests for the time MCP launcher shell script."""

from __future__ import annotations

import os
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[1]
SCRIPT = ROOT_DIR / "scripts" / "start_time_mcp.sh"


class StartTimeMcpScriptTest(unittest.TestCase):
    def run_script(self, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
        clean_env = {
            "PATH": f"{env['PATH']}:/usr/bin:/bin",
            "HOME": env.get("HOME", tempfile.gettempdir()),
        }
        for key in (
            "LOCAL_TIMEZONE",
            "TIME_MCP_PYTHON",
            "MCP_SERVER_TIME_PYTHON",
            "TIME_MCP_PREWARM",
        ):
            if key in env:
                clean_env[key] = env[key]

        return subprocess.run(
            ["/bin/bash", str(SCRIPT)],
            cwd=ROOT_DIR,
            env=clean_env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )

    def test_missing_uvx_errors_when_python_module_is_not_available(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            bin_dir = Path(temp_dir) / "bin"
            bin_dir.mkdir()

            result = self.run_script({"PATH": str(bin_dir)})

        self.assertEqual(result.returncode, 127)
        self.assertIn("uvx is required", result.stderr)

    def test_env_python_with_preinstalled_module_is_used_before_uvx(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            log_path = temp_path / "argv.log"
            fake_python = temp_path / "python"
            fake_uvx = temp_path / "uvx"
            fake_python.write_text(
                textwrap.dedent(
                    f"""\
                    #!/bin/sh
                    if [ "$1" = "-c" ]; then
                      exit 0
                    fi
                    printf '%s\\n' "$*" > "{log_path}"
                    exit 0
                    """
                ),
                encoding="utf-8",
            )
            fake_uvx.write_text(
                "#!/bin/sh\nprintf 'uvx should not run\\n' >&2\nexit 42\n",
                encoding="utf-8",
            )
            fake_python.chmod(0o755)
            fake_uvx.chmod(0o755)

            result = self.run_script(
                {
                    "PATH": temp_dir,
                    "TIME_MCP_PYTHON": str(fake_python),
                    "LOCAL_TIMEZONE": "Asia/Shanghai",
                }
            )
            logged_argv = log_path.read_text(encoding="utf-8").strip() if log_path.exists() else ""

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            logged_argv,
            "-m mcp_server_time --local-timezone Asia/Shanghai",
        )

    def test_uvx_fallback_passes_local_timezone_argument(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            log_path = temp_path / "argv.log"
            fake_uvx = temp_path / "uvx"
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

            result = self.run_script({"PATH": temp_dir, "LOCAL_TIMEZONE": "Asia/Shanghai"})
            logged_argv = log_path.read_text(encoding="utf-8").strip() if log_path.exists() else ""

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            logged_argv,
            "mcp-server-time --local-timezone Asia/Shanghai",
        )


class StartPlaywrightMcpScriptTest(unittest.TestCase):
    def run_script(self, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
        clean_env = {
            "PATH": f"{env['PATH']}:/usr/bin:/bin",
            "HOME": env.get("HOME", tempfile.gettempdir()),
        }
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

        return subprocess.run(
            ["/bin/bash", str(ROOT_DIR / "scripts" / "start_playwright_mcp.sh")],
            cwd=ROOT_DIR,
            env=clean_env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
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
                    "PLAYWRIGHT_MCP_USER_DATA_DIR": "/opt/ran_agent/.openclaw_state/playwright-profile",
                    "PLAYWRIGHT_MCP_STORAGE_STATE": "/opt/ran_agent/.openclaw_state/xhs-auth.json",
                    "PLAYWRIGHT_MCP_CAPS": "network,storage",
                }
            )
            logged_argv = log_path.read_text(encoding="utf-8").strip() if log_path.exists() else ""

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("--isolated", logged_argv)
        self.assertIn("--user-data-dir /opt/ran_agent/.openclaw_state/playwright-profile", logged_argv)
        self.assertIn("--storage-state /opt/ran_agent/.openclaw_state/xhs-auth.json", logged_argv)
        self.assertIn("--caps network,storage", logged_argv)


class StartSocialReaderMcpScriptTest(unittest.TestCase):
    def run_script(self, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
        clean_env = {
            "PATH": f"{env['PATH']}:/usr/bin:/bin",
            "HOME": env.get("HOME", tempfile.gettempdir()),
        }
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

        return subprocess.run(
            ["/bin/bash", str(ROOT_DIR / "scripts" / "start_social_reader_mcp.sh")],
            cwd=ROOT_DIR,
            env=clean_env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
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


class StartObsidianMemoryMcpScriptTest(unittest.TestCase):
    def run_script(self, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
        clean_env = {
            "PATH": f"{env['PATH']}:/usr/bin:/bin",
            "HOME": env.get("HOME", tempfile.gettempdir()),
        }
        for key in (
            "OBSIDIAN_MEMORY_MCP_PROVIDER",
            "OBSIDIAN_MEMORY_VAULT_DIR",
            "OBSIDIAN_MEMORY_INDEX_PATH",
            "OBSIDIAN_MEMORY_OBSIDIAN_INDEX_PACKAGE",
            "OBSIDIAN_MEMORY_OBSIDIAN_INDEX_LAUNCHER",
            "OBSIDIAN_MEMORY_REINDEX",
            "OBSIDIAN_MEMORY_WATCH",
            "OBSIDIAN_MEMORY_UV_BIN",
            "OBSIDIAN_INDEX_DEVICE",
        ):
            if key in env:
                clean_env[key] = env[key]

        return subprocess.run(
            ["/bin/bash", str(ROOT_DIR / "scripts" / "start_obsidian_memory_mcp.sh")],
            cwd=ROOT_DIR,
            env=clean_env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )

    def test_obsidian_index_defaults_to_cpu_without_reindex_or_watch(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            log_path = temp_path / "argv.log"
            fake_uvx = temp_path / "uvx"
            fake_uvx.write_text(
                textwrap.dedent(
                    f"""\
                    #!/bin/sh
                    printf '%s\\n' "$*" > "{log_path}"
                    printf 'device=%s\\n' "${{OBSIDIAN_INDEX_DEVICE:-}}" >> "{log_path}"
                    exit 0
                    """
                ),
                encoding="utf-8",
            )
            fake_uvx.chmod(0o755)

            result = self.run_script(
                {
                    "PATH": temp_dir,
                    "OBSIDIAN_MEMORY_VAULT_DIR": str(temp_path / "vault"),
                    "OBSIDIAN_MEMORY_INDEX_PATH": str(temp_path / "data" / "obsidian-memory-index.duckdb"),
                }
            )
            logged_argv = log_path.read_text(encoding="utf-8").strip() if log_path.exists() else ""

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("--from iflow-mcp-tcsavage-obsidian-index python", logged_argv)
        self.assertIn("scripts/obsidian_index_mcp_launcher.py mcp", logged_argv)
        self.assertIn(f"--vault {temp_path / 'vault'}", logged_argv)
        self.assertIn(f"--database {temp_path / 'data' / 'obsidian-memory-index.duckdb'}", logged_argv)
        self.assertIn("device=cpu", logged_argv)
        self.assertNotIn("--reindex", logged_argv)
        self.assertNotIn("--watch", logged_argv)

    def test_obsidian_index_reindex_and_watch_are_opt_in(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            log_path = temp_path / "argv.log"
            fake_uvx = temp_path / "uvx"
            fake_uvx.write_text(
                textwrap.dedent(
                    f"""\
                    #!/bin/sh
                    printf '%s\\n' "$*" > "{log_path}"
                    printf 'device=%s\\n' "${{OBSIDIAN_INDEX_DEVICE:-}}" >> "{log_path}"
                    exit 0
                    """
                ),
                encoding="utf-8",
            )
            fake_uvx.chmod(0o755)

            result = self.run_script(
                {
                    "PATH": temp_dir,
                    "OBSIDIAN_MEMORY_REINDEX": "1",
                    "OBSIDIAN_MEMORY_WATCH": "true",
                    "OBSIDIAN_INDEX_DEVICE": "cuda",
                }
            )
            logged_argv = log_path.read_text(encoding="utf-8").strip() if log_path.exists() else ""

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("--reindex", logged_argv)
        self.assertIn("--watch", logged_argv)
        self.assertIn("device=cuda", logged_argv)

    def test_obsidian_index_prefers_uv_run_when_uv_is_available(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            log_path = temp_path / "argv.log"
            fake_uv = temp_path / "uv"
            fake_uv.write_text(
                textwrap.dedent(
                    f"""\
                    #!/bin/sh
                    printf '%s\\n' "$*" > "{log_path}"
                    exit 0
                    """
                ),
                encoding="utf-8",
            )
            fake_uv.chmod(0o755)

            result = self.run_script({"PATH": temp_dir})
            logged_argv = log_path.read_text(encoding="utf-8").strip() if log_path.exists() else ""

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("run --no-project --with iflow-mcp-tcsavage-obsidian-index python", logged_argv)
        self.assertIn("scripts/obsidian_index_mcp_launcher.py mcp", logged_argv)


class StartMimoPowerMcpScriptTest(unittest.TestCase):
    def run_script(self, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
        clean_env = {
            "PATH": f"{env['PATH']}:/usr/bin:/bin",
            "HOME": env.get("HOME", tempfile.gettempdir()),
        }
        for key in (
            "MIMO_POWER_NODE_BIN",
            "MIMO_TOKEN_PLAN_API_KEY",
            "MIMO_TOKEN_PLAN_OPENAI_BASE_URL",
            "MIMO_TOKEN_PLAN_EXPIRES_AT",
            "MIMO_POWER_MODEL",
            "MIMO_POWER_TASK_DIR",
        ):
            if key in env:
                clean_env[key] = env[key]

        return subprocess.run(
            ["/bin/bash", str(ROOT_DIR / "scripts" / "start_mimo_power_mcp.sh")],
            cwd=ROOT_DIR,
            env=clean_env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )

    def test_mimo_power_wrapper_runs_node_facade_with_independent_env(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            log_path = temp_path / "argv.log"
            fake_node = temp_path / "node"
            fake_node.write_text(
                textwrap.dedent(
                    f"""\
                    #!/bin/sh
                    printf '%s\\n' "$*" > "{log_path}"
                    printf 'model=%s\\n' "${{MIMO_POWER_MODEL:-}}" >> "{log_path}"
                    printf 'key_present=%s\\n' "$(test -n "${{MIMO_TOKEN_PLAN_API_KEY:-}}" && printf yes || printf no)" >> "{log_path}"
                    exit 0
                    """
                ),
                encoding="utf-8",
            )
            fake_node.chmod(0o755)

            result = self.run_script(
                {
                    "PATH": temp_dir,
                    "MIMO_POWER_NODE_BIN": str(fake_node),
                    "MIMO_TOKEN_PLAN_API_KEY": "tp-secret",
                    "MIMO_POWER_MODEL": "mimo-v2.5-pro",
                }
            )
            logged_argv = log_path.read_text(encoding="utf-8").strip() if log_path.exists() else ""

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("node_bridge/src/mimoPowerMcpServer.mjs", logged_argv)
        self.assertIn("model=mimo-v2.5-pro", logged_argv)
        self.assertIn("key_present=yes", logged_argv)
        self.assertNotIn("tp-secret", logged_argv)


if __name__ == "__main__":
    unittest.main()
