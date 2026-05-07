"""Registry for local tools and future MCP-backed tools used by the chat runtime."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Dict

from personal_agent.config import AppConfig
from personal_agent.db import Database
from personal_agent.local_context_tools import (
    get_active_opportunities,
    get_agent_internal_state,
    get_knowledge_state,
    get_preference_profile,
    get_recent_session_support,
    get_recent_timeline,
    inspect_local_memory,
)
from personal_agent.memory_specialist import MemorySpecialist


ToolFn = Callable[..., Dict[str, object]]


@dataclass(frozen=True)
class RegisteredTool:
    """One tool entry in the local registry."""

    name: str
    description: str
    handler: ToolFn


class ToolRegistry:
    """Owns local tool registration and read-only invocation."""

    def __init__(self) -> None:
        self._tools: dict[str, RegisteredTool] = {}

    def register(self, name: str, description: str, handler: ToolFn) -> None:
        """Register one named tool handler."""

        self._tools[name] = RegisteredTool(name=name, description=description, handler=handler)

    def call(self, name: str, **kwargs) -> dict[str, object]:
        """Invoke one registered tool by name."""

        tool = self._tools[name]
        return tool.handler(**kwargs)

    def list_names(self) -> tuple[str, ...]:
        """Return the registered tool names."""

        return tuple(sorted(self._tools))


def build_local_tool_registry(
    *,
    database: Database,
    memory_specialist: MemorySpecialist,
    config: AppConfig,
) -> ToolRegistry:
    """Build the local read-only tool registry used by the chat runtime."""

    registry = ToolRegistry()
    registry.register(
        "get_recent_timeline",
        "Inspect the recent timeline events stored locally.",
        lambda **kwargs: get_recent_timeline(database, limit=int(kwargs.get("limit", 10))),
    )
    registry.register(
        "get_recent_session_support",
        "Inspect recent local session continuity support for one channel.",
        lambda **kwargs: get_recent_session_support(
            memory_specialist,
            channel=str(kwargs.get("channel", "wechat")),
        ),
    )
    registry.register(
        "get_preference_profile",
        "Read the weak runtime preference profile derived from reflection.",
        lambda **kwargs: get_preference_profile(config),
    )
    registry.register(
        "get_active_opportunities",
        "Inspect the most recently surfaced life opportunities.",
        lambda **kwargs: get_active_opportunities(database),
    )
    registry.register(
        "get_agent_internal_state",
        "Inspect the agent's own short-window lifecycle trace.",
        lambda **kwargs: get_agent_internal_state(database),
    )
    registry.register(
        "inspect_local_memory",
        "Inspect local short-term and compatibility long-term memory recall.",
        lambda **kwargs: inspect_local_memory(
            memory_specialist,
            user_text=str(kwargs.get("user_text", "")).strip(),
        ),
    )
    registry.register(
        "get_knowledge_state",
        "Inspect the latest lightweight background knowledge-maintenance state.",
        lambda **kwargs: get_knowledge_state(config),
    )
    return registry
