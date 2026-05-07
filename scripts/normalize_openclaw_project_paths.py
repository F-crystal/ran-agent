from __future__ import annotations

import json
import sys
from pathlib import Path


def normalize_config_paths(
    config_path: Path,
    root_dir: str,
    claude_command: str | None = None,
) -> bool:
    if not config_path.exists():
        return False

    payload = json.loads(config_path.read_text(encoding="utf-8"))
    changed = False

    agents = payload.get("agents")
    if isinstance(agents, dict):
        defaults = agents.get("defaults")
        if isinstance(defaults, dict):
            if defaults.get("workspace") != root_dir:
                defaults["workspace"] = root_dir
                changed = True

            cli_backends = defaults.get("cliBackends")
            if isinstance(cli_backends, dict):
                claude_cli = cli_backends.get("claude-cli")
                if (
                    isinstance(claude_cli, dict)
                    and claude_command
                    and claude_cli.get("command") != claude_command
                ):
                    claude_cli["command"] = claude_command
                    changed = True

        agent_list = agents.get("list")
        if isinstance(agent_list, list):
            for agent in agent_list:
                if isinstance(agent, dict) and agent.get("workspace") != root_dir:
                    agent["workspace"] = root_dir
                    changed = True

    plugins = payload.get("plugins")
    if isinstance(plugins, dict):
        load = plugins.get("load")
        if isinstance(load, dict):
            expected_path = str(Path(root_dir) / ".openclaw" / "extensions")
            paths = load.get("paths")
            if isinstance(paths, list) and paths != [expected_path]:
                load["paths"] = [expected_path]
                changed = True

    if changed:
        config_path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    return changed


def main(argv: list[str]) -> int:
    if len(argv) < 3:
        print(
            "usage: normalize_openclaw_project_paths.py CONFIG_PATH ROOT_DIR [CLAUDE_COMMAND]",
            file=sys.stderr,
        )
        return 2

    config_path = Path(argv[1])
    root_dir = argv[2]
    claude_command = argv[3] if len(argv) > 3 and argv[3] else None

    changed = normalize_config_paths(config_path, root_dir, claude_command)
    if changed:
        print(f"normalized openclaw config paths in {config_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
