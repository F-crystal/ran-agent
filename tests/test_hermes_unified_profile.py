import json
from pathlib import Path

import yaml


PROFILE = Path(__file__).parents[1] / "hermes/profile/config.companion.yaml"
MUTATION = Path(__file__).parents[1] / "docs/governance/hermes_runtime_mutation.v1.json"
FORBIDDEN_TOOLS = {"cronjob", "delegate_task", "execute_code"}


def test_companion_profile_is_the_capability_union_behind_one_memory_facade() -> None:
    config = yaml.safe_load(PROFILE.read_text(encoding="utf-8"))
    cli = config["platform_toolsets"]["cli"]
    api = config["platform_toolsets"]["api_server"]
    expected_tools = {
        "skills", "memory", "safe",
        "mcp-time", "mcp-social_reader", "mcp-media_reader", "mcp-search_hub",
        "mcp-co_reading", "mcp-sticker_catalog", "mcp-media_generation",
        "mcp-personal_memory", "mcp-external_mcp_gateway",
    }
    expected_mcp = {
        "time", "social_reader", "media_reader", "media_generation", "co_reading",
        "sticker_catalog", "search_hub", "personal_memory",
        "external_mcp_gateway", "tavily",
    }

    assert cli == api
    assert set(api) == expected_tools
    assert "web" not in config
    assert "web" not in api
    assert "mcp-search_hub" in api
    assert set(config["mcp_servers"]) == expected_mcp
    assert "mcp-personal_memory" in api
    assert FORBIDDEN_TOOLS.issubset(config["disabled_tools"])
    sticker = config["mcp_servers"]["sticker_catalog"]["env"]
    search = config["mcp_servers"]["search_hub"]["env"]
    external = config["mcp_servers"]["external_mcp_gateway"]["env"]
    assert sticker["STICKER_CATALOG_PROFILE_MODE"] == "full" and sticker["STICKER_CATALOG_ALLOW_RUNTIME_SAVE"] == "true"
    assert search["SEARCH_HUB_PROFILE_MODE"] == "full"
    assert search["SEARCH_HUB_ENABLE_PLAYWRIGHT_FALLBACK"] == "true" and search["SEARCH_HUB_PUBLIC_ONLY_DEFAULT"] == "false"
    assert external["EXTERNAL_MCP_GATEWAY_PROFILE"] == "full"
    assert external["EXTERNAL_MCP_GATEWAY_ALLOW_ENV_ENABLE"] == "true"
    assert external["EXTERNAL_MCP_GATEWAY_ENABLED"] == "true" and external["EXTERNAL_MCP_SYSTEM_QUEUE_ENABLED"] == "true"
    assert config["security"]["allow_lazy_installs"] is False
    assert config["security"]["tirith_enabled"] is False
    assert config["agent"]["reasoning_effort"] == "none"
    assert config["hooks"] == {
        "post_api_request": [{
            "command": "/usr/bin/python3 /opt/ran_agent/scripts/hermes-provider-response-observer.py",
            "timeout": 5,
        }]
    }
    assert "hooks_auto_accept" not in config
    assert "ombre_memory" not in config["mcp_servers"]


def test_deployed_runtime_mutation_remains_bound_to_its_historical_profile() -> None:
    mutation = json.loads(MUTATION.read_text(encoding="utf-8"))
    assert mutation["deploymentStatus"] == "DEPLOYED"
    assert mutation["companionProfile"]["sourceSha256"] == "f015cdfd63469befe6d6c57172b78705418707e8a3756c670782db2241717a17"
    assert mutation["companionProfile"]["destinationSha256"] == mutation["companionProfile"]["sourceSha256"]
    assert "mcp-ombre_memory" in mutation["companionProfile"]["requiredToolsets"]
    assert set(mutation["companionProfile"]["forbiddenTools"]) == FORBIDDEN_TOOLS
    assert mutation["unifiedUnit"]["sourceSha256"] == "42703a7eaa1975b6336a6eae700c744f9bedc12892f5ab0492d753ef396a479c"
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
