from __future__ import annotations

import json
import sys
from pathlib import Path


def normalize_absolute_model_ref(value: object, provider_ids: set[str]) -> object:
    if not isinstance(value, str):
        return value
    sorted_provider_ids = sorted(provider_ids, key=len, reverse=True)
    for provider_id in sorted_provider_ids:
        prefix = f"{provider_id}/"
        if value.startswith(prefix):
            return value[len(prefix) :]

    if not value.startswith("/"):
        return value

    for provider_id in sorted_provider_ids:
        marker = f"/{provider_id}/"
        index = value.find(marker)
        if index >= 0:
            return value[index + len(marker) :]
    return value


def collect_provider_ids(payload: dict) -> set[str]:
    provider_ids = {"claude_code"}
    providers = payload.get("models", {}).get("providers", {})
    if isinstance(providers, dict):
        provider_ids.update(str(key) for key in providers if str(key).strip())
    return provider_ids


def normalize_model_selection(model: object, provider_ids: set[str]) -> bool:
    if isinstance(model, str):
        return False
    if not isinstance(model, dict):
        return False

    changed = False
    primary = model.get("primary")
    normalized_primary = normalize_absolute_model_ref(primary, provider_ids)
    if normalized_primary != primary:
        model["primary"] = normalized_primary
        changed = True

    fallbacks = model.get("fallbacks")
    if isinstance(fallbacks, list):
        normalized_fallbacks = [
            normalize_absolute_model_ref(item, provider_ids) for item in fallbacks
        ]
        if normalized_fallbacks != fallbacks:
            model["fallbacks"] = normalized_fallbacks
            changed = True

    return changed


def normalize_model_refs(payload: dict) -> bool:
    changed = False
    provider_ids = collect_provider_ids(payload)
    agents = payload.get("agents")
    if not isinstance(agents, dict):
        return False

    defaults = agents.get("defaults")
    if isinstance(defaults, dict):
        changed = normalize_model_selection(defaults.get("model"), provider_ids) or changed

    agent_list = agents.get("list")
    if isinstance(agent_list, list):
        for agent in agent_list:
            if isinstance(agent, dict):
                changed = normalize_model_selection(agent.get("model"), provider_ids) or changed

    return changed


def normalize_payload_paths(
    payload: dict,
    root_dir: str,
    claude_command: str | None = None,
) -> bool:
    changed = normalize_model_refs(payload)

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
                if isinstance(claude_cli, dict):
                    existing = claude_cli.get("command")
                    # Only set command when missing/empty; never overwrite an
                    # existing settings provider name (e.g. 'claude') with a
                    # resolved system absolute path (e.g. '/usr/bin/claude').
                    if not existing and claude_command:
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

    return changed


def normalize_json_file(
    path: Path,
    root_dir: str,
    claude_command: str | None = None,
) -> bool:
    if not path.exists():
        return False

    payload = json.loads(path.read_text(encoding="utf-8"))
    changed = normalize_payload_paths(payload, root_dir, claude_command)
    if changed:
        path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    return changed


def normalize_config_paths(
    config_path: Path,
    root_dir: str,
    claude_command: str | None = None,
) -> bool:
    changed = normalize_json_file(config_path, root_dir, claude_command)
    state_config_path = Path(root_dir) / ".openclaw_state" / "openclaw.json"
    changed = normalize_json_file(state_config_path, root_dir, claude_command) or changed
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
