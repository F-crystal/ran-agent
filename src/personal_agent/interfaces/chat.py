"""Chat channel interface reserved for future WeChat integration."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class IncomingMessage:
    """Represents one inbound message from any chat channel."""

    channel: str
    sender_id: str
    text: str
    image_urls: tuple[str, ...] = ()
    route_hint: str = ""


@dataclass(frozen=True)
class OutgoingMessage:
    """Represents one outbound reply returned to a chat channel."""

    channel: str
    recipient_id: str
    text: str


class ChatMessageHandler(Protocol):
    """Defines how a chat channel passes user messages into the agent."""

    def handle_incoming_message(self, message: IncomingMessage) -> OutgoingMessage:
        """Handle one incoming message event and return one reply."""


class ChatGateway:
    """Placeholder chat gateway that documents the future integration seam."""

    def start(self) -> None:
        """Start the chat listener when a concrete channel is implemented."""

        raise NotImplementedError("Chat gateway is not implemented in Phase 1.")
