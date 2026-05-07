from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = (
    Path(__file__).resolve().parents[1] / "scripts" / "normalize_openclaw_project_paths.py"
)
SPEC = importlib.util.spec_from_file_location("normalize_openclaw_project_paths", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC is not None and SPEC.loader is not None
SPEC.loader.exec_module(MODULE)

normalize_config_paths = MODULE.normalize_config_paths


class NormalizeOpenClawProjectPathsTest(unittest.TestCase):
    def test_server_paths_use_repo_root_and_claude_executable(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            config_path = Path(temp_dir) / "openclaw.personal-system.json"
            config_path.write_text(
                json.dumps(
                    {
                        "agents": {
                            "defaults": {
                                "workspace": ".",
                                "cliBackends": {
                                    "claude-cli": {
                                        "command": "claude",
                                    }
                                },
                            },
                            "list": [
                                {
                                    "id": "personal-system",
                                    "workspace": ".",
                                }
                            ],
                        },
                        "plugins": {
                            "load": {
                                "paths": [
                                    ".openclaw/extensions",
                                    "/Users/fengran/ran_agent/.openclaw/extensions",
                                ]
                            }
                        },
                    }
                )
                + "\n",
                encoding="utf-8",
            )

            changed = normalize_config_paths(
                config_path,
                "/opt/ran_agent",
                "/home/ubuntu/.claude/local/claude",
            )
            payload = json.loads(config_path.read_text(encoding="utf-8"))

        self.assertTrue(changed)
        self.assertEqual(payload["agents"]["defaults"]["workspace"], "/opt/ran_agent")
        self.assertEqual(payload["agents"]["list"][0]["workspace"], "/opt/ran_agent")
        self.assertEqual(
            payload["agents"]["defaults"]["cliBackends"]["claude-cli"]["command"],
            "/home/ubuntu/.claude/local/claude",
        )
        self.assertEqual(
            payload["plugins"]["load"]["paths"],
            ["/opt/ran_agent/.openclaw/extensions"],
        )


if __name__ == "__main__":
    unittest.main()
