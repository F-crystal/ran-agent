"""Runtime configuration for filesystem paths and scheduler settings."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path


def _load_prompt_json(filename: str) -> dict[str, object]:
    """Load one bundled prompt JSON file into a dictionary."""

    prompt_path = Path(__file__).resolve().parent / "prompts" / filename
    with prompt_path.open("r", encoding="utf-8") as prompt_file:
        return json.load(prompt_file)


def _load_default_system_prompt() -> str:
    """Load the default system prompt from the bundled JSON file."""

    prompt_data = _load_prompt_json("system_prompt.json")
    prompt = str(prompt_data["agent_system_prompt"]).strip()
    if not prompt:
        raise ValueError("agent_system_prompt must not be empty")
    return prompt


def _load_default_memory_policy_prompt() -> str:
    """Render the bundled memory policy JSON into one instruction prompt string."""

    policy_data = _load_prompt_json("memory_policy.json")
    sections: list[str] = []

    policy_name = str(policy_data.get("policy_name", "")).strip()
    role = str(policy_data.get("role", "")).strip()
    goal = str(policy_data.get("goal", "")).strip()

    if policy_name:
        sections.append(f"[Policy Name]\n{policy_name}")
    if role:
        sections.append(f"[Role]\n{role}")
    if goal:
        sections.append(f"[Goal]\n{goal}")

    for section_name in ("decision_rules", "output_schema", "output_rules", "forbidden"):
        items = policy_data.get(section_name, [])
        if not isinstance(items, list):
            continue
        normalized_items = [str(item).strip() for item in items if str(item).strip()]
        if not normalized_items:
            continue
        title = section_name.replace("_", " ").title()
        body = "\n".join(f"- {item}" for item in normalized_items)
        sections.append(f"[{title}]\n{body}")

    layers = policy_data.get("layers", {})
    if isinstance(layers, dict) and layers:
        layer_lines = [
            f"- {str(key).strip()}: {str(value).strip()}"
            for key, value in layers.items()
            if str(key).strip() and str(value).strip()
        ]
        if layer_lines:
            sections.append("[Layers]\n" + "\n".join(layer_lines))

    prompt = "\n\n".join(section for section in sections if section.strip()).strip()
    if not prompt:
        raise ValueError("memory policy prompt must not be empty")
    return prompt


def _load_default_tool_use_prompt() -> str:
    """Load the system prompt used for tool and multimodal requests."""

    prompt_data = _load_prompt_json("tool_use_system_prompt.json")
    prompt = str(prompt_data["tool_use_system_prompt"]).strip()
    if not prompt:
        raise ValueError("tool_use_system_prompt must not be empty")
    return prompt


def _env_enabled(name: str, default: str = "false") -> bool:
    return os.getenv(name, default).strip().lower() in {"1", "true", "yes", "on"}


def _env_disabled(name: str, default: str = "true") -> bool:
    return os.getenv(name, default).strip().lower() in {"0", "false", "no", "off"}


def _first_bool_env(names: tuple[str, ...], default: str = "false") -> bool:
    for name in names:
        raw = os.getenv(name)
        if raw is not None and raw.strip():
            return raw.strip().lower() in {"1", "true", "yes", "on"}
    return default.strip().lower() in {"1", "true", "yes", "on"}


DEFAULT_SYSTEM_PROMPT = _load_default_system_prompt()
DEFAULT_MEMORY_POLICY_PROMPT = _load_default_memory_policy_prompt()
DEFAULT_TOOL_USE_PROMPT = _load_default_tool_use_prompt()


def _extract_env_placeholder_name(value: str) -> str:
    cleaned = str(value).strip()
    if cleaned.startswith("${") and cleaned.endswith("}"):
        return cleaned[2:-1].strip()
    return ""


def _load_openclaw_runtime_contract(_base_dir: Path) -> dict[str, object]:
    """Return default runtime contract (OpenClaw config removed)."""
    return {
        "config_path": "hermes/profile/config.yaml",
        "gateway_base_url": "http://127.0.0.1:8642",
        "gateway_token_env_var": "HERMES_API_KEY",
        "gateway_model_target": "deepseek-v4-flash",
        "gateway_timeout_seconds": 180,
        "backend_model_ref": "",
        "backend_model_provider": "",
        "backend_model_name": "",
        "backend_model_api": "",
        "backend_model_base_url": "",
        "backend_model_api_key_env_var": "",
        "backend_model_max_tokens": 0,
    }


@dataclass(frozen=True)
class AppConfig:
    """Holds file paths and runtime values for the local agent."""

    base_dir: Path
    data_dir: Path
    logs_dir: Path
    vault_dir: Path
    database_path: Path
    log_file_path: Path
    debug_dir: Path = Path("debug")
    reflections_dir: Path = Path("debug/reflections")
    night_cycles_dir: Path = Path("debug/night_cycles")
    scheduler_timezone: str = "Asia/Shanghai"
    brain_loop_interval_minutes: int = 120
    proactive_check_interval_minutes: int = 90
    knowledge_check_interval_minutes: int = 360
    knowledge_backlog_trigger_count: int = 10
    knowledge_backlog_trigger_age_minutes: int = 120
    knowledge_cron_hours: str = "6,12,18,23"
    knowledge_cron_minute: int = 0
    daily_carryover_enabled: bool = True
    daily_carryover_hour: int = 4
    daily_carryover_minute: int = 0
    reminder_check_interval_minutes: int = 5
    proactive_enabled: bool = False
    proactive_events_enabled: bool = False
    reminder_delivery_enabled: bool = False
    proactive_reminders_enabled: bool = False
    ai_daily_digest_enabled: bool = False
    ai_daily_digest_hour: int = 8
    ai_daily_digest_minute: int = 0
    proactive_idle_minutes: int = 60
    proactive_daily_limit: int = 5
    proactive_silent_start_hour: int = 0
    proactive_silent_end_hour: int = 9
    node_bridge_outbound_base_url: str = "http://127.0.0.1:8791"
    profile_memory_limit: int = 3
    working_memory_limit: int = 2
    session_recent_user_messages_limit: int = 3
    memory_context_max_chars: int = 600
    daily_context_max_chars: int = 600
    reflection_context_max_chars: int = 600
    continuity_context_max_chars: int = 1200
    knowledge_recall_limit: int = 1
    knowledge_snippet_max_chars: int = 240
    proactive_memory_context_max_chars: int = 300
    hermes_bounded_context_enabled: bool = True
    hermes_bounded_context_interval_minutes: int = 720
    working_memory_retention_limit: int = 20
    profile_memory_history_limit: int = 30
    profile_memory_repeat_threshold: int = 2
    memory_llm_enabled: bool = False
    memory_llm_history_limit: int = 6
    vector_memory_enabled: bool = True
    vector_memory_candidate_limit: int = 200
    vector_memory_index_path: Path = Path("data/memory_bge_vector_index.bin")
    vector_memory_metadata_path: Path = Path("data/memory_bge_vector_index.json")
    memory_policy_prompt: str = DEFAULT_MEMORY_POLICY_PROMPT
    agent_system_prompt: str = DEFAULT_SYSTEM_PROMPT
    tool_use_system_prompt: str = DEFAULT_TOOL_USE_PROMPT
    reviewer_enabled: bool = True
    reviewer_debug_log_enabled: bool = False
    reviewer_blacklist_enabled: bool = True
    off_topic_check_enabled: bool = True
    self_reflection_enabled: bool = True
    self_reflection_interval_minutes: int = 720
    self_reflection_sample_limit: int = 200
    knowledge_agent_enabled: bool = True
    knowledge_agent_runner_name: str = "qwen"
    knowledge_agent_command: str = ""
    knowledge_agent_api_key_env_var: str = "DASHSCOPE_API_KEY"
    knowledge_agent_timeout_seconds: int = 300
    night_cycle_enabled: bool = True
    night_cycle_hour: int = 0
    night_cycle_minute: int = 0
    hermes_base_url: str = "http://127.0.0.1:8642"
    hermes_api_key_env_var: str = "HERMES_API_KEY"
    hermes_model: str = "deepseek-v4-flash"
    hermes_timeout_seconds: int = 180
    backend_model_ref: str = ""
    backend_model_provider: str = ""
    backend_model_name: str = ""
    backend_model_api: str = ""
    backend_model_base_url: str = ""
    backend_model_api_key_env_var: str = ""
    backend_model_max_tokens: int = 0
    backend_qwen_enabled: bool = False
    qwen_api_key_env_var: str = "DASHSCOPE_API_KEY"
    qwen_tools_model: str = "qwen3.5-plus"
    qwen_base_url: str = "https://dashscope.aliyuncs.com/compatible-mode/v1/responses"
    qwen_timeout_seconds: int = 300
    persona_evolution_enabled: bool = True
    persona_proposals_dir: Path = Path("debug/persona_proposals")
    identity_path: Path = Path("IDENTITY.md")
    soul_path: Path = Path("SOUL.md")
    ombre_mcp_timeout_seconds: int = 10
    ombre_mcp_url: str = "http://127.0.0.1:18001/mcp"
    wechat_account_id: str = "personal_agent"
    wechat_login_mode: str = "terminal"
    http_host: str = "127.0.0.1"
    http_port: int = 8787


def load_config(base_dir: Path | None = None) -> AppConfig:
    """Build configuration from the repository layout."""

    resolved_base_dir = base_dir or Path(__file__).resolve().parents[2]
    data_dir = resolved_base_dir / "data"
    logs_dir = resolved_base_dir / "logs"
    vault_dir = resolved_base_dir / "vault"
    debug_dir = resolved_base_dir / "debug"
    reflections_dir = debug_dir / "reflections"
    night_cycles_dir = debug_dir / "night_cycles"
    openclaw_contract = _load_openclaw_runtime_contract(resolved_base_dir)

    return AppConfig(
        base_dir=resolved_base_dir,
        data_dir=data_dir,
        logs_dir=logs_dir,
        vault_dir=vault_dir,
        debug_dir=debug_dir,
        reflections_dir=reflections_dir,
        night_cycles_dir=night_cycles_dir,
        hermes_base_url=os.getenv(
            "HERMES_API_BASE_URL",
            str(openclaw_contract["gateway_base_url"]),
        ).strip().rstrip("/"),
        hermes_api_key_env_var=os.getenv(
            "PERSONAL_AGENT_HERMES_API_KEY_ENV",
            str(openclaw_contract["gateway_token_env_var"]),
        ).strip(),
        hermes_model=os.getenv(
            "PERSONAL_AGENT_HERMES_MODEL",
            str(openclaw_contract["gateway_model_target"]),
        ).strip(),
        hermes_timeout_seconds=int(
            os.getenv(
                "PERSONAL_AGENT_HERMES_TIMEOUT_SECONDS",
                str(openclaw_contract["gateway_timeout_seconds"]),
            ).strip()
        ),
        backend_model_ref=str(openclaw_contract["backend_model_ref"]).strip(),
        backend_model_provider=str(openclaw_contract["backend_model_provider"]).strip(),
        backend_model_name=str(openclaw_contract["backend_model_name"]).strip(),
        backend_model_api=str(openclaw_contract["backend_model_api"]).strip(),
        backend_model_base_url=str(openclaw_contract["backend_model_base_url"]).strip(),
        backend_model_api_key_env_var=str(openclaw_contract["backend_model_api_key_env_var"]).strip(),
        backend_model_max_tokens=int(openclaw_contract["backend_model_max_tokens"]),
        database_path=data_dir / "personal_agent.db",
        log_file_path=logs_dir / "personal_agent.log",
        brain_loop_interval_minutes=int(
            os.getenv("PERSONAL_AGENT_BRAIN_LOOP_INTERVAL_MINUTES", "120").strip()
        ),
        proactive_check_interval_minutes=int(
            os.getenv("PERSONAL_AGENT_PROACTIVE_CHECK_INTERVAL_MINUTES", "90").strip()
        ),
        knowledge_check_interval_minutes=int(
            os.getenv("PERSONAL_AGENT_KNOWLEDGE_CHECK_INTERVAL_MINUTES", "360").strip()
        ),
        knowledge_backlog_trigger_count=int(
            os.getenv("PERSONAL_AGENT_KNOWLEDGE_BACKLOG_TRIGGER_COUNT", "10").strip()
        ),
        knowledge_backlog_trigger_age_minutes=int(
            os.getenv("PERSONAL_AGENT_KNOWLEDGE_BACKLOG_TRIGGER_AGE_MINUTES", "120").strip()
        ),
        knowledge_cron_hours=os.getenv("PERSONAL_AGENT_KNOWLEDGE_CRON_HOURS", "6,12,18,23").strip(),
        knowledge_cron_minute=int(os.getenv("PERSONAL_AGENT_KNOWLEDGE_CRON_MINUTE", "0").strip()),
        daily_carryover_enabled=not _env_disabled("PERSONAL_AGENT_DAILY_CARRYOVER_ENABLED", "true"),
        daily_carryover_hour=int(os.getenv("PERSONAL_AGENT_DAILY_CARRYOVER_HOUR", "4").strip()),
        daily_carryover_minute=int(os.getenv("PERSONAL_AGENT_DAILY_CARRYOVER_MINUTE", "0").strip()),
        reminder_check_interval_minutes=int(
            os.getenv("PERSONAL_AGENT_REMINDER_CHECK_INTERVAL_MINUTES", "5").strip()
        ),
        proactive_enabled=_env_enabled("PERSONAL_AGENT_PROACTIVE_ENABLED", "false"),
        proactive_events_enabled=_env_enabled("HERMES_PROACTIVE_EVENTS_ENABLED", "false"),
        reminder_delivery_enabled=_first_bool_env(
            ("HERMES_PROACTIVE_REMINDERS_ENABLED", "PERSONAL_AGENT_REMINDER_DELIVERY_ENABLED"),
            "false",
        ),
        proactive_reminders_enabled=_first_bool_env(
            ("HERMES_PROACTIVE_REMINDERS_ENABLED", "PERSONAL_AGENT_REMINDER_DELIVERY_ENABLED"),
            "false",
        ),
        ai_daily_digest_enabled=_env_enabled("AI_DAILY_DIGEST_ENABLED", "false"),
        ai_daily_digest_hour=int(os.getenv("AI_DAILY_DIGEST_HOUR", "8").strip()),
        ai_daily_digest_minute=int(os.getenv("AI_DAILY_DIGEST_MINUTE", "0").strip()),
        proactive_idle_minutes=int(
            os.getenv("PERSONAL_AGENT_PROACTIVE_IDLE_MINUTES", "60").strip()
        ),
        proactive_daily_limit=int(
            os.getenv("PERSONAL_AGENT_PROACTIVE_DAILY_LIMIT", "5").strip()
        ),
        proactive_silent_start_hour=int(
            os.getenv("PERSONAL_AGENT_PROACTIVE_SILENT_START_HOUR", "0").strip()
        ),
        proactive_silent_end_hour=int(
            os.getenv("PERSONAL_AGENT_PROACTIVE_SILENT_END_HOUR", "9").strip()
        ),
        node_bridge_outbound_base_url=os.getenv(
            "PERSONAL_AGENT_NODE_BRIDGE_OUTBOUND_BASE_URL",
            "http://127.0.0.1:8791",
        ).strip().rstrip("/"),
        profile_memory_limit=int(os.getenv("PERSONAL_AGENT_PROFILE_MEMORY_LIMIT", "3").strip()),
        working_memory_limit=int(os.getenv("PERSONAL_AGENT_WORKING_MEMORY_LIMIT", "2").strip()),
        session_recent_user_messages_limit=int(
            os.getenv("PERSONAL_AGENT_SESSION_RECENT_USER_MESSAGES_LIMIT", "3").strip()
        ),
        memory_context_max_chars=int(
            os.getenv("PERSONAL_AGENT_MEMORY_CONTEXT_MAX_CHARS", "600").strip()
        ),
        daily_context_max_chars=int(
            os.getenv("PERSONAL_AGENT_DAILY_CONTEXT_MAX_CHARS", "600").strip()
        ),
        reflection_context_max_chars=int(
            os.getenv("PERSONAL_AGENT_REFLECTION_CONTEXT_MAX_CHARS", "600").strip()
        ),
        continuity_context_max_chars=int(
            os.getenv("PERSONAL_AGENT_CONTINUITY_CONTEXT_MAX_CHARS", "1200").strip()
        ),
        knowledge_recall_limit=int(os.getenv("PERSONAL_AGENT_KNOWLEDGE_RECALL_LIMIT", "1").strip()),
        knowledge_snippet_max_chars=int(
            os.getenv("PERSONAL_AGENT_KNOWLEDGE_SNIPPET_MAX_CHARS", "240").strip()
        ),
        proactive_memory_context_max_chars=int(
            os.getenv("PERSONAL_AGENT_PROACTIVE_MEMORY_CONTEXT_MAX_CHARS", "300").strip()
        ),
        hermes_bounded_context_enabled=not _env_disabled("PERSONAL_AGENT_HERMES_BOUNDED_CONTEXT_ENABLED", "true"),
        hermes_bounded_context_interval_minutes=int(
            os.getenv("PERSONAL_AGENT_HERMES_BOUNDED_CONTEXT_INTERVAL_MINUTES", "720").strip()
        ),
        working_memory_retention_limit=int(
            os.getenv("PERSONAL_AGENT_WORKING_MEMORY_RETENTION_LIMIT", "20").strip()
        ),
        profile_memory_history_limit=int(
            os.getenv("PERSONAL_AGENT_PROFILE_MEMORY_HISTORY_LIMIT", "30").strip()
        ),
        profile_memory_repeat_threshold=int(
            os.getenv("PERSONAL_AGENT_PROFILE_MEMORY_REPEAT_THRESHOLD", "2").strip()
        ),
        memory_llm_enabled=_env_enabled("PERSONAL_AGENT_MEMORY_LLM_ENABLED", "false"),
        memory_llm_history_limit=int(
            os.getenv("PERSONAL_AGENT_MEMORY_LLM_HISTORY_LIMIT", "6").strip()
        ),
        vector_memory_enabled=not _env_disabled("PERSONAL_AGENT_VECTOR_MEMORY_ENABLED", "true"),
        vector_memory_candidate_limit=int(
            os.getenv("PERSONAL_AGENT_VECTOR_MEMORY_CANDIDATE_LIMIT", "200").strip()
        ),
        vector_memory_index_path=Path(
            os.getenv(
                "PERSONAL_AGENT_VECTOR_MEMORY_INDEX_PATH",
                str(data_dir / "memory_bge_vector_index.bin"),
            ).strip()
        ),
        vector_memory_metadata_path=Path(
            os.getenv(
                "PERSONAL_AGENT_VECTOR_MEMORY_METADATA_PATH",
                str(data_dir / "memory_bge_vector_index.json"),
            ).strip()
        ),
        memory_policy_prompt=os.getenv(
            "PERSONAL_AGENT_MEMORY_POLICY_PROMPT",
            DEFAULT_MEMORY_POLICY_PROMPT,
        ).strip(),
        agent_system_prompt=os.getenv("PERSONAL_AGENT_SYSTEM_PROMPT", DEFAULT_SYSTEM_PROMPT).strip(),
        tool_use_system_prompt=os.getenv(
            "PERSONAL_AGENT_TOOL_USE_SYSTEM_PROMPT",
            DEFAULT_TOOL_USE_PROMPT,
        ).strip(),
        reviewer_enabled=not _env_disabled("PERSONAL_AGENT_REVIEWER_ENABLED", "true"),
        reviewer_debug_log_enabled=_env_enabled("PERSONAL_AGENT_REVIEWER_DEBUG_LOG_ENABLED", "false"),
        reviewer_blacklist_enabled=not _env_disabled("PERSONAL_AGENT_REVIEWER_BLACKLIST_ENABLED", "true"),
        off_topic_check_enabled=not _env_disabled("PERSONAL_AGENT_OFF_TOPIC_CHECK_ENABLED", "true"),
        self_reflection_enabled=not _env_disabled("PERSONAL_AGENT_SELF_REFLECTION_ENABLED", "true"),
        self_reflection_interval_minutes=int(
            os.getenv("PERSONAL_AGENT_SELF_REFLECTION_INTERVAL_MINUTES", "720").strip()
        ),
        self_reflection_sample_limit=int(
            os.getenv("PERSONAL_AGENT_SELF_REFLECTION_SAMPLE_LIMIT", "200").strip()
        ),
        knowledge_agent_enabled=not _env_disabled("PERSONAL_AGENT_KNOWLEDGE_AGENT_ENABLED", "true"),
        knowledge_agent_runner_name=os.getenv(
            "PERSONAL_AGENT_KNOWLEDGE_AGENT_RUNNER",
            "qwen",
        ).strip() or "qwen",
        knowledge_agent_command=os.getenv(
            "PERSONAL_AGENT_KNOWLEDGE_AGENT_COMMAND",
            f"/bin/bash {resolved_base_dir / 'vault_runner.sh'}",
        ).strip(),
        knowledge_agent_api_key_env_var=os.getenv(
            "PERSONAL_AGENT_KNOWLEDGE_AGENT_API_KEY_ENV",
            os.getenv("PERSONAL_AGENT_QWEN_API_KEY_ENV", "DASHSCOPE_API_KEY"),
        ).strip(),
        knowledge_agent_timeout_seconds=int(
            os.getenv(
                "PERSONAL_AGENT_KNOWLEDGE_AGENT_TIMEOUT_SECONDS",
                os.getenv("PERSONAL_AGENT_QWEN_TIMEOUT_SECONDS", "300"),
            ).strip()
        ),
        night_cycle_enabled=not _env_disabled("PERSONAL_AGENT_NIGHT_CYCLE_ENABLED", "true"),
        night_cycle_hour=int(os.getenv("PERSONAL_AGENT_NIGHT_CYCLE_HOUR", "0").strip()),
        night_cycle_minute=int(os.getenv("PERSONAL_AGENT_NIGHT_CYCLE_MINUTE", "0").strip()),
        backend_qwen_enabled=_env_enabled("PERSONAL_AGENT_BACKEND_QWEN_ENABLED", "false"),
        qwen_api_key_env_var=os.getenv(
            "PERSONAL_AGENT_QWEN_API_KEY_ENV",
            "DASHSCOPE_API_KEY",
        ).strip(),
        qwen_tools_model=os.getenv("PERSONAL_AGENT_QWEN_TOOLS_MODEL", "qwen3.5-plus").strip(),
        qwen_base_url=os.getenv(
            "PERSONAL_AGENT_QWEN_BASE_URL",
            "https://dashscope.aliyuncs.com/compatible-mode/v1/responses",
        ).strip(),
        qwen_timeout_seconds=int(
            os.getenv("PERSONAL_AGENT_QWEN_TIMEOUT_SECONDS", "300").strip()
        ),
        persona_evolution_enabled=not _env_disabled("PERSONAL_AGENT_PERSONA_EVOLUTION_ENABLED", "true"),
        persona_proposals_dir=debug_dir / "persona_proposals",
        identity_path=resolved_base_dir / "IDENTITY.md",
        soul_path=resolved_base_dir / "SOUL.md",
        ombre_mcp_timeout_seconds=int(
            os.getenv("PERSONAL_AGENT_OMBRE_MCP_TIMEOUT_SECONDS", "10").strip()
        ),
        ombre_mcp_url=os.getenv(
            "OMBRE_BRAIN_MCP_URL",
            "http://127.0.0.1:18001/mcp",
        ).strip(),
        wechat_account_id=os.getenv("PERSONAL_AGENT_WECHAT_ACCOUNT_ID", "personal_agent").strip(),
        wechat_login_mode=os.getenv("PERSONAL_AGENT_WECHAT_LOGIN_MODE", "terminal").strip().lower(),
        http_host=os.getenv("PERSONAL_AGENT_HTTP_HOST", "127.0.0.1").strip(),
        http_port=int(os.getenv("PERSONAL_AGENT_HTTP_PORT", "8787").strip()),
    )
