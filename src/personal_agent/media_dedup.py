"""Media deduplication service using SQLite for index storage."""

from __future__ import annotations

import hashlib
from datetime import datetime
from pathlib import Path
from typing import Optional, Tuple

from personal_agent.db import Database


class MediaDedupService:
    """Generic media deduplication service (images, audio, video, documents).
    
    Phase 1: SHA256 exact deduplication.
    Phase 2: pHash perceptual deduplication (field reserved, not implemented).
    """

    def __init__(self, database: Database, vault_root: Path) -> None:
        self._db = database
        self._vault_root = vault_root

    def compute_sha256(self, file_path: Path) -> str:
        """Calculate SHA256 hash of a file."""
        sha256 = hashlib.sha256()
        with open(file_path, 'rb') as f:
            for chunk in iter(lambda: f.read(8192), b''):
                sha256.update(chunk)
        return sha256.hexdigest()

    def find_by_sha256(self, sha256: str) -> Optional[dict]:
        """Find existing media record by SHA256.
        
        Returns:
            Dict with keys: sha256, rel_path, size_bytes, mime_type, reference_count
            None if not found.
        """
        with self._db.connection() as conn:
            row = conn.execute(
                """
                SELECT sha256, rel_path, size_bytes, mime_type, reference_count
                FROM media_dedup
                WHERE sha256 = ?
                """,
                (sha256,)
            ).fetchone()
        if row is None:
            return None
        return {
            "sha256": row["sha256"],
            "rel_path": row["rel_path"],
            "size_bytes": row["size_bytes"],
            "mime_type": row["mime_type"],
            "reference_count": row["reference_count"],
        }

    def insert_dedup_record(
        self,
        sha256: str,
        rel_path: str,
        size_bytes: int,
        mime_type: str,
        width: Optional[int] = None,
        height: Optional[int] = None,
    ) -> None:
        """Insert a new media dedup record."""
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with self._db.connection() as conn:
            conn.execute(
                """
                INSERT INTO media_dedup (
                    sha256, phash, rel_path, width, height, size_bytes, 
                    mime_type, first_seen_at, last_seen_at, reference_count
                )
                VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, 0)
                """,
                (sha256, rel_path, width, height, size_bytes, mime_type, now, now)
            )
            conn.commit()

    def insert_ref(
        self,
        sha256: str,
        source_table: str,
        source_id: str,
        source_column: str,
        context: Optional[str] = None,
    ) -> None:
        """Insert a reference to an existing media record."""
        with self._db.connection() as conn:
            conn.execute(
                """
                INSERT INTO media_dedup_refs (sha256, source_table, source_id, source_column, context)
                VALUES (?, ?, ?, ?, ?)
                """,
                (sha256, source_table, source_id, source_column, context)
            )
            conn.execute(
                """
                UPDATE media_dedup 
                SET reference_count = reference_count + 1, 
                    last_seen_at = CURRENT_TIMESTAMP
                WHERE sha256 = ?
                """,
                (sha256,)
            )
            conn.commit()

    def deduplicate_and_link(
        self,
        src_path: Path,
        vault_rel_dir: Path,
        source_table: str,
        source_id: str,
        source_column: str,
        context: Optional[str] = None,
        mime_type: Optional[str] = None,
    ) -> Tuple[bool, Path]:
        """
        Deduplicate a media file and return the target path.
        
        Args:
            src_path: Source file path (absolute, e.g., /tmp/weixin-agent/...)
            vault_rel_dir: Target vault subdirectory (relative to vault root, e.g., inbox/images/.media)
            source_table: Source table name for reference tracking (e.g., 'external_exchanges')
            source_id: Source record ID for reference tracking (e.g., inbox note path)
            source_column: Source column name for reference tracking (e.g., 'media_path')
            context: Optional context (e.g., user message prefix, max 100 chars)
            mime_type: Optional MIME type
        
        Returns:
            (is_duplicate, target_rel_path)
            - is_duplicate: True if file already exists (reuse existing path)
            - target_rel_path: Relative path from vault root
        """
        sha256 = self.compute_sha256(src_path)
        existing = self.find_by_sha256(sha256)
        
        if existing:
            # Duplicate: reuse existing file, add reference
            self.insert_ref(
                sha256=sha256,
                source_table=source_table,
                source_id=source_id,
                source_column=source_column,
                context=context,
            )
            return (True, Path(existing["rel_path"]))
        else:
            # New file: generate target path, caller will copy
            # File name: {sha256}{extension}
            file_ext = src_path.suffix.lower() if src_path.suffix else ".bin"
            file_name = f"{sha256}{file_ext}"
            target_rel_path = vault_rel_dir / file_name
            return (False, target_rel_path)

    def finalize_new_media(
        self,
        sha256: str,
        rel_path: Path,
        size_bytes: int,
        mime_type: Optional[str],
        source_table: str,
        source_id: str,
        source_column: str,
        context: Optional[str] = None,
    ) -> None:
        """
        Finalize a new media record after successful copy.
        
        Call this AFTER the file has been copied to the target location.
        """
        # Insert dedup record
        self.insert_dedup_record(
            sha256=sha256,
            rel_path=str(rel_path),
            size_bytes=size_bytes,
            mime_type=mime_type or "application/octet-stream",
        )
        
        # Insert first reference
        self.insert_ref(
            sha256=sha256,
            source_table=source_table,
            source_id=source_id,
            source_column=source_column,
            context=context,
        )

    def get_reference_history(self, sha256: str) -> list[dict]:
        """Get all references for a media file."""
        with self._db.connection() as conn:
            rows = conn.execute(
                """
                SELECT id, source_table, source_id, source_column, context, created_at
                FROM media_dedup_refs
                WHERE sha256 = ?
                ORDER BY id ASC
                """,
                (sha256,)
            ).fetchall()
        return [
            {
                "id": row["id"],
                "source_table": row["source_table"],
                "source_id": row["source_id"],
                "source_column": row["source_column"],
                "context": row["context"],
                "created_at": row["created_at"],
            }
            for row in rows
        ]

    def get_stats(self) -> dict:
        """Get deduplication statistics."""
        with self._db.connection() as conn:
            total_files = conn.execute("SELECT COUNT(*) FROM media_dedup").fetchone()[0]
            total_refs = conn.execute("SELECT COUNT(*) FROM media_dedup_refs").fetchone()[0]
            total_saved_bytes = conn.execute(
                """
                SELECT COALESCE(SUM(size_bytes * (reference_count - 1)), 0)
                FROM media_dedup
                WHERE reference_count > 1
                """
            ).fetchone()[0]
        return {
            "total_unique_files": total_files,
            "total_references": total_refs,
            "total_saved_bytes": total_saved_bytes,
            "total_saved_mb": round(total_saved_bytes / (1024 * 1024), 2),
        }
