import hashlib
import json
from pathlib import Path

import yaml


PROFILE = Path(__file__).parents[1] / "hermes/profile/config.companion.yaml"
LITE_PROFILE = Path(__file__).parents[1] / "hermes/profile/config.lite.yaml"
FULL_PROFILE = Path(__file__).parents[1] / "hermes/profile/config.yaml"
UNIT = Path(__file__).parents[1] / "hermes/systemd/ran-agent-hermes-unified.service"
MUTATION = Path(__file__).parents[1] / "docs/governance/hermes_runtime_mutation.v1.json"
FORBIDDEN_TOOLS = {"cronjob", "delegate_task", "execute_code"}


def test_companion_profile_preserves_union_behind_one_memory_facade() -> None:
    config = yaml.safe_load(PROFILE.read_text(encoding="utf-8"))
    lite = yaml.safe_load(LITE_PROFILE.read_text(encoding="utf-8"))
    full = yaml.safe_load(FULL_PROFILE.read_text(encoding="utf-8"))
    cli = config["platform_toolsets"]["cli"]
    api = config["platform_toolsets"]["api_server"]
    legacy_toolsets = set(lite["platform_toolsets"]["gateway"]) | set(full["platform_toolsets"]["gateway"])
    legacy_mcp = set(lite["mcp_servers"]) | set(full["mcp_servers"])

    assert cli == api
    assert set(api) == legacy_toolsets - {"mcp-ombre_memory"}
    assert set(config["mcp_servers"]) == legacy_mcp - {"ombre_memory"}
    assert "mcp-personal_memory" in api
    assert FORBIDDEN_TOOLS.issubset(config["disabled_tools"])
    assert "Environment=OBSIDIAN_MEMORY_MCP_ENABLED=true" in UNIT.read_text(encoding="utf-8")
    sticker = config["mcp_servers"]["sticker_catalog"]["env"]
    search = config["mcp_servers"]["search_hub"]["env"]
    external = config["mcp_servers"]["external_mcp_gateway"]["env"]
    assert sticker["STICKER_CATALOG_PROFILE_MODE"] == "full" and sticker["STICKER_CATALOG_ALLOW_RUNTIME_SAVE"] == "true"
    assert search["SEARCH_HUB_PROFILE_MODE"] == "full"
    assert search["SEARCH_HUB_ENABLE_PLAYWRIGHT_FALLBACK"] == "true" and search["SEARCH_HUB_PUBLIC_ONLY_DEFAULT"] == "false"
    assert external["EXTERNAL_MCP_GATEWAY_PROFILE"] == "full"
    assert external["EXTERNAL_MCP_GATEWAY_ENABLED"] == "false" and external["EXTERNAL_MCP_SYSTEM_QUEUE_ENABLED"] == "false"
    assert config["security"]["allow_lazy_installs"] is False
    assert config["security"]["tirith_enabled"] is False
    assert config["agent"]["reasoning_effort"] == "none"
    assert "ombre_memory" not in config["mcp_servers"]


def test_deployed_runtime_mutation_remains_bound_to_its_historical_profile() -> None:
    mutation = json.loads(MUTATION.read_text(encoding="utf-8"))
    config = yaml.safe_load(PROFILE.read_text(encoding="utf-8"))
    digest = hashlib.sha256(PROFILE.read_bytes()).hexdigest()

    assert mutation["deploymentStatus"] == "DEPLOYED"
    assert mutation["companionProfile"]["sourceSha256"] != digest
    assert mutation["companionProfile"]["destinationSha256"] == mutation["companionProfile"]["sourceSha256"]
    assert "mcp-ombre_memory" in mutation["companionProfile"]["requiredToolsets"]
    assert "mcp-ombre_memory" not in config["platform_toolsets"]["api_server"]
    assert set(mutation["companionProfile"]["forbiddenTools"]) == FORBIDDEN_TOOLS
    assert mutation["unifiedUnit"]["sourceSha256"] == hashlib.sha256(UNIT.read_bytes()).hexdigest()
    values = mutation["envMutations"][0]["values"]
    assert len({values[key] for key in ("HERMES_PROFILE", "HERMES_LITE_PROFILE", "HERMES_FULL_PROFILE")}) == 1
    assert len({values[key] for key in ("HERMES_API_BASE_URL", "HERMES_LITE_API_BASE_URL", "HERMES_FULL_API_BASE_URL")}) == 1
    assert any(item["unit"] == "ran-agent-node.service" for item in mutation["unitMutations"])
    hermes_unit = next(item for item in mutation["unitMutations"] if item["unit"] == "ran-agent-hermes.service")
    assert hermes_unit["afterEnvironment"] == {
        "HERMES_DISABLE_LAZY_INSTALLS": "1",
        "TIRITH_ENABLED": "false",
        "OBSIDIAN_MEMORY_MCP_ENABLED": "true",
    }
    admission = mutation["admission"]
    assert admission["peakNewAllocatedBytes"] == sum(admission["peakInventoryBytes"].values())
    observation = admission["capacityObservation"]
    assert observation["requiredBytes"] == observation["floorBytes"] + admission["peakNewAllocatedBytes"]
    assert observation["headroomBytes"] == observation["freeBytes"] - observation["requiredBytes"]
    assert "NOT_ADMISSION" in admission["current"]
