import hashlib
import json
from pathlib import Path

import yaml


PROFILE = Path(__file__).parents[1] / "hermes/profile/config.companion.yaml"
UNIT = Path(__file__).parents[1] / "hermes/systemd/ran-agent-hermes-unified.service"
MUTATION = Path(__file__).parents[1] / "docs/governance/hermes_runtime_mutation.v1.json"
REQUIRED_MCP = {
    "time",
    "social_reader",
    "media_reader",
    "media_generation",
    "co_reading",
    "sticker_catalog",
    "search_hub",
    "personal_memory",
    "ombre_memory",
    "external_mcp_gateway",
}
FORBIDDEN_TOOLSETS = {"terminal", "file", "session_search", "cronjob", "delegation", "browser", "code_execution"}


def test_companion_profile_is_one_restricted_api_surface() -> None:
    config = yaml.safe_load(PROFILE.read_text(encoding="utf-8"))
    cli = config["platform_toolsets"]["cli"]
    api = config["platform_toolsets"]["api_server"]

    assert cli == api
    assert not FORBIDDEN_TOOLSETS.intersection(api)
    assert {"mcp-media_generation", "mcp-co_reading"}.issubset(api)
    assert REQUIRED_MCP.issubset(config["mcp_servers"])
    assert "mcp-obsidian_memory" not in api
    assert "obsidian_memory" not in config["mcp_servers"]
    assert "Environment=OBSIDIAN_MEMORY_MCP_ENABLED=false" in UNIT.read_text(encoding="utf-8")
    assert config["security"]["allow_lazy_installs"] is False
    assert config["security"]["tirith_enabled"] is False
    assert config["agent"]["reasoning_effort"] == "none"
    assert config["mcp_servers"]["ombre_memory"]["url"] == "${OMBRE_BRAIN_MCP_URL}"


def test_runtime_mutation_binds_profile_and_live_node_switch() -> None:
    mutation = json.loads(MUTATION.read_text(encoding="utf-8"))
    digest = hashlib.sha256(PROFILE.read_bytes()).hexdigest()

    assert mutation["companionProfile"]["sourceSha256"] == digest
    assert mutation["companionProfile"]["destinationSha256"] == digest
    assert mutation["unifiedUnit"]["sourceSha256"] == hashlib.sha256(UNIT.read_bytes()).hexdigest()
    values = mutation["envMutations"][0]["values"]
    assert len({values[key] for key in ("HERMES_PROFILE", "HERMES_LITE_PROFILE", "HERMES_FULL_PROFILE")}) == 1
    assert len({values[key] for key in ("HERMES_API_BASE_URL", "HERMES_LITE_API_BASE_URL", "HERMES_FULL_API_BASE_URL")}) == 1
    assert any(item["unit"] == "ran-agent-node.service" for item in mutation["unitMutations"])
    hermes_unit = next(item for item in mutation["unitMutations"] if item["unit"] == "ran-agent-hermes.service")
    assert hermes_unit["afterEnvironment"] == {
        "HERMES_DISABLE_LAZY_INSTALLS": "1",
        "TIRITH_ENABLED": "false",
    }
    admission = mutation["admission"]
    assert admission["peakNewAllocatedBytes"] == sum(admission["peakInventoryBytes"].values())
    observation = admission["capacityObservation"]
    assert observation["requiredBytes"] == observation["floorBytes"] + admission["peakNewAllocatedBytes"]
    assert observation["headroomBytes"] == observation["freeBytes"] - observation["requiredBytes"]
    assert "NOT_ADMISSION" in admission["current"]
