#!/usr/bin/env python3
"""Fail-closed O1 runtime configuration and transaction-state validation."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import ipaddress
import re
import sys
from pathlib import Path
from urllib.parse import urlsplit

import yaml

PINNED_OMBRE_COMMIT = "0e83d4671ce1629e03ad36bb9160235bf60dbd34"
ADAPTER_URL = "http://127.0.0.1:18002/mcp"
UPSTREAM_URL = "http://127.0.0.1:18001/mcp"
HEX40 = re.compile(r"^[0-9a-f]{40}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
ENV_REFERENCE = re.compile(r"\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))")


class DuplicateKeyError(ValueError):
    pass


class StrictYamlLoader(yaml.SafeLoader):
    pass


def _unique_mapping(loader: yaml.SafeLoader, node: yaml.Node, deep: bool = False) -> dict:
    result = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if key in result:
            raise DuplicateKeyError(f"duplicate YAML key: {key}")
        result[key] = loader.construct_object(value_node, deep=deep)
    return result


StrictYamlLoader.add_constructor(
    yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG,
    _unique_mapping,
)


def _json_no_duplicates(pairs: list[tuple[str, object]]) -> dict:
    result = {}
    for key, value in pairs:
        if key in result:
            raise DuplicateKeyError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def _expand(value: str, env: dict[str, str]) -> str:
    def replacement(match: re.Match[str]) -> str:
        name = match.group(1) or match.group(2)
        if name not in env:
            return match.group(0)
        return env[name]

    return ENV_REFERENCE.sub(replacement, value)


def _loopback_host(hostname: str) -> bool:
    if hostname.lower() == "localhost":
        return True
    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        return False
    if address.is_loopback:
        return True
    return bool(getattr(address, "ipv4_mapped", None) and address.ipv4_mapped.is_loopback)


def _canonical_mcp_endpoint(value: str, *, protected: bool = False) -> str:
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError as error:
        raise ValueError(f"invalid MCP URL: {value}") from error
    hostname = parsed.hostname or ""
    contract_port = port in {18001, 18002}
    contract_candidate = protected or contract_port or _loopback_host(hostname)
    if not contract_candidate:
        if not parsed.scheme or not hostname:
            raise ValueError(f"invalid MCP URL: {value}")
        return value
    if ENV_REFERENCE.search(value):
        raise ValueError(f"unresolved protected MCP URL: {value}")
    if parsed.scheme.lower() != "http" or not _loopback_host(hostname):
        raise ValueError(f"protected MCP endpoint must use a literal loopback host: {value}")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError(f"protected MCP endpoint contains forbidden URL components: {value}")
    if port is None or parsed.path != "/mcp":
        raise ValueError(f"protected MCP endpoint requires explicit port and /mcp path: {value}")
    return f"http://127.0.0.1:{port}/mcp"


def validate_runtime_config(path: Path, env: dict[str, str]) -> dict:
    document = yaml.load(path.read_text(encoding="utf-8"), Loader=StrictYamlLoader)
    if not isinstance(document, dict):
        raise ValueError(f"{path}: config root must be a mapping")
    servers = document.get("mcp_servers")
    if not isinstance(servers, dict):
        raise ValueError(f"{path}: mcp_servers must be a mapping")
    if list(servers).count("ombre_memory") != 1 or "ombre_memory" not in servers:
        raise ValueError(f"{path}: exactly one mcp_servers.ombre_memory is required")

    resolved_urls: dict[str, str] = {}
    for name, definition in servers.items():
        if not isinstance(definition, dict):
            raise ValueError(f"{path}: mcp server {name} must be a mapping")
        if "url" not in definition:
            continue
        if not isinstance(definition["url"], str):
            raise ValueError(f"{path}: mcp server {name} URL must be text")
        resolved = _canonical_mcp_endpoint(
            _expand(definition["url"], env),
            protected=str(name) == "ombre_memory",
        )
        resolved_urls[str(name)] = resolved
        if resolved == UPSTREAM_URL:
            raise ValueError(f"{path}: raw Ombre upstream exposed as mcp_servers.{name}")

    if resolved_urls.get("ombre_memory") != ADAPTER_URL:
        raise ValueError(
            f"{path}: mcp_servers.ombre_memory must resolve exactly to {ADAPTER_URL}"
        )
    aliases = [name for name, url in resolved_urls.items() if url == ADAPTER_URL]
    if aliases != ["ombre_memory"]:
        raise ValueError(f"{path}: recall adapter has aliases: {aliases}")

    toolsets = document.get("platform_toolsets")
    if not isinstance(toolsets, dict):
        raise ValueError(f"{path}: platform_toolsets must be a mapping")
    for surface in ("cli", "gateway"):
        tools = toolsets.get(surface)
        if not isinstance(tools, list) or any(not isinstance(tool, str) for tool in tools):
            raise ValueError(f"{path}: platform_toolsets.{surface} must be a string list")
        if tools.count("mcp-ombre_memory") != 1:
            raise ValueError(
                f"{path}: platform_toolsets.{surface} must expose exactly one mcp-ombre_memory"
            )
        for name in servers:
            if name != "ombre_memory" and name.lower().startswith("ombre"):
                if f"mcp-{name}" in tools:
                    raise ValueError(f"{path}: unexpected Ombre toolset alias mcp-{name}")
    return {"path": str(path), "ombre_memory_url": resolved_urls["ombre_memory"]}


def validate_runner(env: dict[str, str]) -> dict:
    required = (
        "OMBRE_BRAIN_RUNNER",
        "OMBRE_BRAIN_COMMIT",
        "OMBRE_BIND_HOST",
        "OMBRE_MCP_REQUIRE_AUTH",
        "OMBRE_BRAIN_MCP_URL",
        "OMBRE_BRAIN_HEALTH_URL",
        "OMBRE_RECALL_MCP_URL",
        "OMBRE_RECALL_HEALTH_URL",
    )
    missing = [name for name in required if name not in env or not env[name].strip()]
    if missing:
        raise ValueError(f"missing O1 runtime setting(s): {', '.join(missing)}")
    if env["OMBRE_BRAIN_RUNNER"].strip().lower() != "source":
        raise ValueError("O1 only supports OMBRE_BRAIN_RUNNER=source")
    if env["OMBRE_BRAIN_COMMIT"].strip() != PINNED_OMBRE_COMMIT:
        raise ValueError("Ombre source commit is not pinned to the O1 contract")
    if env["OMBRE_BIND_HOST"].strip() != "127.0.0.1":
        raise ValueError("O1 requires OMBRE_BIND_HOST=127.0.0.1")
    if env["OMBRE_MCP_REQUIRE_AUTH"].strip().lower() != "false":
        raise ValueError("O1 loopback contract requires explicit OMBRE_MCP_REQUIRE_AUTH=false")
    expected = {
        "OMBRE_BRAIN_MCP_URL": UPSTREAM_URL,
        "OMBRE_BRAIN_HEALTH_URL": "http://127.0.0.1:18001/health",
        "OMBRE_RECALL_MCP_URL": ADAPTER_URL,
        "OMBRE_RECALL_HEALTH_URL": "http://127.0.0.1:18002/health",
    }
    for name, value in expected.items():
        if env[name].strip() != value:
            raise ValueError(f"{name} must be exactly {value}")
    return {
        "runner": "source",
        "commit": PINNED_OMBRE_COMMIT,
        "bind_host": "127.0.0.1",
        "auth": False,
    }


STATE_FIELDS = {
    "schema_version",
    "transaction_id",
    "candidate_sha",
    "base_sha",
    "status",
    "acceptance_state",
    "rollback_state",
    "rollbackable",
    "current_production_identity",
    "completed_at",
    "manifest_digest",
    "service_state_digest",
}
STATUSES = {
    "in_progress",
    "accepted",
    "deployment_failed",
    "rollback_in_progress",
    "rollback_complete",
    "rollback_failed",
    "rollback_used",
    "resumable",
}


def _digest_file(path: Path) -> str:
    content = path.read_bytes()
    if not content:
        raise ValueError(f"empty evidence file: {path.name}")
    return hashlib.sha256(content).hexdigest()


def classify_snapshot(
    directory: Path,
    current_transaction: str,
    production_transaction: str,
) -> dict:
    if directory.name == current_transaction:
        return {"decision": "KEEP", "reason": "current_transaction"}
    if directory.name == production_transaction:
        return {"decision": "KEEP", "reason": "current_production_rollback_point"}
    try:
        state_path = directory / "transaction-state.json"
        state = json.loads(
            state_path.read_text(encoding="utf-8"),
            object_pairs_hook=_json_no_duplicates,
        )
        if not isinstance(state, dict):
            raise ValueError("state must be an object")
        unknown = set(state) - STATE_FIELDS
        missing = STATE_FIELDS - set(state)
        if unknown:
            raise ValueError(f"unknown state fields: {sorted(unknown)}")
        if missing:
            raise ValueError(f"missing state fields: {sorted(missing)}")
        if state["schema_version"] != 1:
            raise ValueError("unsupported schema_version")
        if state["transaction_id"] != directory.name:
            raise ValueError("transaction_id does not match directory")
        if not HEX40.fullmatch(state["candidate_sha"] or ""):
            raise ValueError("candidate_sha is not canonical 40-hex")
        if not HEX40.fullmatch(state["base_sha"] or ""):
            raise ValueError("base_sha is not canonical 40-hex")
        if state["status"] not in STATUSES:
            raise ValueError("unsupported transaction status")
        if not isinstance(state["rollbackable"], bool):
            raise ValueError("rollbackable must be boolean")
        if not isinstance(state["current_production_identity"], str):
            raise ValueError("current_production_identity must be text")
        if not isinstance(state["completed_at"], str):
            raise ValueError("completed_at must be text")
        if not SHA256.fullmatch(state["manifest_digest"] or ""):
            raise ValueError("manifest_digest invalid")
        if not SHA256.fullmatch(state["service_state_digest"] or ""):
            raise ValueError("service_state_digest invalid")
        manifest = directory / "manifest"
        services = directory / "services"
        if _digest_file(manifest) != state["manifest_digest"]:
            raise ValueError("manifest checksum mismatch")
        if _digest_file(services) != state["service_state_digest"]:
            raise ValueError("service state checksum mismatch")

        accepted = (
            state["status"] == "accepted"
            and state["acceptance_state"] == "accepted"
            and state["rollback_state"] == "not_used"
            and state["rollbackable"] is True
            and bool(state["completed_at"])
            and state["current_production_identity"] == f"transaction:{state['transaction_id']}"
        )
        if state["acceptance_state"] == "accepted" and state["rollback_state"] != "not_used":
            raise ValueError("accepted transaction has contradictory rollback state")
        if state["status"] == "accepted" and not accepted:
            raise ValueError("accepted transaction is incomplete")
        if accepted:
            return {
                "decision": "ELIGIBLE",
                "reason": "verified_accepted_rollbackable",
                "completed_at": state["completed_at"],
            }
        rollback_used = (
            state["status"] == "rollback_used"
            and state["acceptance_state"] == "not_accepted"
            and state["rollback_state"] == "rollback_used"
            and state["rollbackable"] is False
            and bool(state["completed_at"])
        )
        if state["status"] == "rollback_used" and not rollback_used:
            raise ValueError("rollback-used transaction is incomplete")
        if rollback_used:
            return {
                "decision": "PRUNE_PAYLOAD",
                "reason": "verified_completed_rollback_used",
                "completed_at": state["completed_at"],
            }
        return {"decision": "SKIP_UNCERTAIN", "reason": f"non_prunable_status:{state['status']}"}
    except Exception as error:
        return {"decision": "SKIP_UNCERTAIN", "reason": str(error)}


def parse_env_assignments(values: list[str]) -> dict[str, str]:
    result = dict(os.environ)
    for value in values:
        if "=" not in value:
            raise ValueError(f"invalid --env assignment: {value}")
        key, item = value.split("=", 1)
        result[key] = item
    return result


def read_production_pointer(path: Path) -> dict:
    value = json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=_json_no_duplicates)
    if not isinstance(value, dict) or set(value) != {
        "schema_version", "transaction_id", "candidate_sha"
    }:
        raise ValueError("production pointer fields invalid")
    if value["schema_version"] != 1:
        raise ValueError("production pointer schema unsupported")
    if not isinstance(value["transaction_id"], str) or not value["transaction_id"]:
        raise ValueError("production pointer transaction_id invalid")
    if not HEX40.fullmatch(value["candidate_sha"] or ""):
        raise ValueError("production pointer candidate_sha invalid")
    return value


def main() -> int:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    config_parser = subparsers.add_parser("validate-config")
    config_parser.add_argument("paths", nargs="+", type=Path)
    config_parser.add_argument("--env", action="append", default=[])
    runner_parser = subparsers.add_parser("validate-runner")
    runner_parser.add_argument("--env", action="append", default=[])
    retention_parser = subparsers.add_parser("classify-snapshot")
    retention_parser.add_argument("directory", type=Path)
    retention_parser.add_argument("--current-transaction", default="")
    retention_parser.add_argument("--production-transaction", default="")
    retention_parser.add_argument("--format", choices=("json", "tsv"), default="json")
    pointer_parser = subparsers.add_parser("read-production-pointer")
    pointer_parser.add_argument("path", type=Path)
    pointer_parser.add_argument(
        "--format", choices=("json", "transaction-id", "candidate-sha", "tsv"), default="json"
    )
    args = parser.parse_args()
    try:
        if args.command == "validate-config":
            env = parse_env_assignments(args.env)
            result = [validate_runtime_config(path, env) for path in args.paths]
        elif args.command == "validate-runner":
            result = validate_runner(parse_env_assignments(args.env))
        elif args.command == "classify-snapshot":
            result = classify_snapshot(
                args.directory,
                args.current_transaction,
                args.production_transaction,
            )
        else:
            result = read_production_pointer(args.path)
        if args.command == "read-production-pointer" and args.format == "transaction-id":
            print(result["transaction_id"])
        elif args.command == "read-production-pointer" and args.format == "candidate-sha":
            print(result["candidate_sha"])
        elif args.command == "read-production-pointer" and args.format == "tsv":
            print(f"{result['transaction_id']}\t{result['candidate_sha']}")
        elif args.command == "classify-snapshot" and args.format == "tsv":
            print(
                "\t".join(
                    (
                        result["decision"],
                        result["reason"].replace("\t", " "),
                        str(result.get("completed_at", "")),
                    )
                )
            )
        else:
            print(json.dumps(result, ensure_ascii=False, sort_keys=True))
        return 0
    except Exception as error:
        print(f"OMBRE_O1_CONTRACT_INVALID: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
