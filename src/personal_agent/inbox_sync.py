"""Helpers for syncing external chat exchanges into vault inbox notes."""

from __future__ import annotations

import re
import shutil
from datetime import datetime
from pathlib import Path

from personal_agent.config import AppConfig


def write_external_exchange_to_inbox(
    *,
    config: AppConfig,
    channel: str,
    sender_id: str,
    source: str,
    user_text: str,
    reply_text: str,
    media_refs: tuple[str, ...] = (),
    now_local: datetime | None = None,
) -> Path:
    """Write one chat exchange note into ``vault/inbox`` and return its path."""

    timestamp = now_local or datetime.now()
    category = _classify_inbox_category(media_refs)
    inbox_dir = config.vault_dir / "inbox" / category
    inbox_dir.mkdir(parents=True, exist_ok=True)

    sender_token = _slugify(sender_id, fallback="unknown_sender")
    channel_token = _slugify(channel, fallback="chat")
    note_name = f"{category}_sync_{timestamp.strftime('%Y%m%d_%H%M%S_%f')}_{channel_token}_{sender_token}.md"
    note_path = inbox_dir / note_name

    # Copy media files to vault inbox and update refs to relative paths
    copied_media_refs = _copy_media_to_vault(
        media_refs=media_refs,
        inbox_dir=inbox_dir,
        note_name=note_name,
    )

    created_at = timestamp.strftime("%Y-%m-%d %H:%M:%S")
    body_lines = [
        "---",
        "type: inbox_note",
        f"title: Chat Sync {created_at}",
        f"created: {created_at}",
        "source: chat_sync",
        f"channel: {channel.strip() or 'unknown'}",
        f"sender_id: {sender_id.strip() or 'unknown'}",
        f"ingest_source: {source.strip() or 'unknown'}",
        f"category: {category}",
        "---",
        "",
        "## User Message",
        user_text.strip() or "(empty)",
        "",
        "## Media References",
    ]
    if copied_media_refs:
        body_lines.extend(f"- {item}" for item in copied_media_refs)
    else:
        body_lines.append("- (none)")
    body_lines.extend(
        [
            "",
            "## Agent Reply",
            reply_text.strip() or "(empty)",
            "",
        ]
    )
    note_path.write_text("\n".join(body_lines), encoding="utf-8")
    return note_path


def _copy_media_to_vault(
    *,
    media_refs: tuple[str, ...],
    inbox_dir: Path,
    note_name: str,
) -> tuple[str, ...]:
    """Copy media files from external paths to vault inbox directory.
    
    Returns updated media refs with relative paths for files that were copied.
    """
    if not media_refs:
        return ()

    copied_refs: list[str] = []
    media_dir = inbox_dir / ".media"
    media_dir.mkdir(exist_ok=True)

    for i, ref in enumerate(media_refs):
        ref = ref.strip()
        if not ref:
            continue

        # Parse media ref format: "mime_type file_path" or just "file_path"
        parts = ref.split(None, 2)  # Split by whitespace, max 2 parts
        if len(parts) >= 2 and "/" in parts[0]:
            # Format: "mime_type file_path" or "mime_type type file_path"
            mime_type = parts[0]
            if len(parts) >= 3:
                file_path = parts[2]
            else:
                file_path = parts[1]
        else:
            # Format: just file_path
            mime_type = "application/octet-stream"
            file_path = ref

        # Check if it's an absolute path that needs copying
        path_obj = Path(file_path)
        if not path_obj.is_absolute():
            # Already a relative path, keep as-is
            copied_refs.append(ref)
            continue

        if not path_obj.exists():
            # File doesn't exist, keep original ref
            copied_refs.append(ref)
            continue

        # Copy file to vault media directory
        file_ext = path_obj.suffix or ".bin"
        dest_name = f"{note_name[:-3]}_{i}{file_ext}"  # Remove .md and add index
        dest_path = media_dir / dest_name

        try:
            shutil.copy2(path_obj, dest_path)
            # Return relative path from inbox note to media file
            relative_path = f".media/{dest_name}"
            copied_refs.append(f"{mime_type} {relative_path}")
        except (OSError, shutil.Error):
            # Copy failed, keep original ref
            copied_refs.append(ref)

    return tuple(copied_refs)


def _slugify(value: str, *, fallback: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_-]+", "-", value.strip())
    cleaned = re.sub(r"-{2,}", "-", cleaned).strip("-_")
    return cleaned or fallback


def _classify_inbox_category(media_refs: tuple[str, ...]) -> str:
    if not media_refs:
        return "chat"
    lowered = [item.strip().lower() for item in media_refs if item.strip()]
    if not lowered:
        return "chat"

    image_markers = (
        ".png",
        ".jpg",
        ".jpeg",
        ".gif",
        ".webp",
        ".bmp",
        ".heic",
        ".svg",
        "image/",
        "data:image/",
    )
    audio_markers = (".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac", "audio/")
    doc_markers = (".pdf", ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx", "application/")

    if any(any(marker in item for marker in image_markers) for item in lowered):
        return "images"
    if any(any(marker in item for marker in audio_markers) for item in lowered):
        return "audio"
    if any(any(marker in item for marker in doc_markers) for item in lowered):
        return "docs"
    return "files"
