"""Unit tests for media deduplication service (Phase 1: SHA256)."""

from __future__ import annotations

import hashlib
import shutil
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest import mock

from personal_agent.config import AppConfig
from personal_agent.db import Database
from personal_agent.media_dedup import MediaDedupService


class MediaDedupServiceTest(unittest.TestCase):
    """Test SHA256 exact deduplication logic."""

    def setUp(self) -> None:
        """Create temporary directories and initialize database."""
        self._temp_dir = Path(tempfile.mkdtemp(prefix="media_dedup_test_"))
        self._data_dir = self._temp_dir / "data"
        self._logs_dir = self._temp_dir / "logs"
        self._vault_dir = self._temp_dir / "vault"
        self._debug_dir = self._temp_dir / "debug"
        self._data_dir.mkdir(parents=True, exist_ok=True)
        self._logs_dir.mkdir(parents=True, exist_ok=True)
        self._vault_dir.mkdir(parents=True, exist_ok=True)
        self._debug_dir.mkdir(parents=True, exist_ok=True)

        # Create config using correct parameters
        self._config = AppConfig(
            base_dir=self._temp_dir,
            data_dir=self._data_dir,
            logs_dir=self._logs_dir,
            vault_dir=self._vault_dir,
            debug_dir=self._debug_dir,
            database_path=self._data_dir / "personal_agent.db",
            log_file_path=self._logs_dir / "personal_agent.log",
        )

        # Initialize database with mock logger
        mock_logger = mock.MagicMock()
        self._db = Database(config=self._config, logger=mock_logger)
        self._db.initialize()

        # Create dedup service
        self._dedup_service = MediaDedupService(
            database=self._db,
            vault_root=self._vault_dir,
        )

        # Create test media files
        self._media_dir = self._temp_dir / "media"
        self._media_dir.mkdir(parents=True, exist_ok=True)
        
        # Create test image file (duplicate content)
        self._test_image_content = b"fake image content for testing deduplication"
        self._test_image1 = self._media_dir / "test_image1.png"
        self._test_image2 = self._media_dir / "test_image2.png"  # Same content
        self._test_image3 = self._media_dir / "test_image3.png"  # Different content
        
        self._test_image1.write_bytes(self._test_image_content)
        self._test_image2.write_bytes(self._test_image_content)
        self._test_image3.write_bytes(b"different image content")

    def tearDown(self) -> None:
        """Clean up temporary directories."""
        if self._temp_dir.exists():
            shutil.rmtree(self._temp_dir)

    def test_compute_sha256(self) -> None:
        """Test SHA256 hash calculation."""
        sha256 = self._dedup_service.compute_sha256(self._test_image1)
        
        # Verify it's a valid SHA256 hex string (64 characters)
        self.assertEqual(len(sha256), 64)
        self.assertTrue(all(c in "0123456789abcdef" for c in sha256))
        
        # Verify identical files have same hash
        sha256_duplicate = self._dedup_service.compute_sha256(self._test_image2)
        self.assertEqual(sha256, sha256_duplicate)
        
        # Verify different files have different hash
        sha256_different = self._dedup_service.compute_sha256(self._test_image3)
        self.assertNotEqual(sha256, sha256_different)

    def test_insert_and_find_dedup_record(self) -> None:
        """Test inserting and finding dedup records."""
        sha256 = self._dedup_service.compute_sha256(self._test_image1)
        rel_path = "inbox/images/.media/test.bin"
        
        # Insert record
        self._dedup_service.insert_dedup_record(
            sha256=sha256,
            rel_path=rel_path,
            size_bytes=len(self._test_image_content),
            mime_type="image/png",
        )
        
        # Find record
        result = self._dedup_service.find_by_sha256(sha256)
        
        self.assertIsNotNone(result)
        self.assertEqual(result["sha256"], sha256)
        self.assertEqual(result["rel_path"], rel_path)
        self.assertEqual(result["size_bytes"], len(self._test_image_content))
        self.assertEqual(result["mime_type"], "image/png")
        self.assertEqual(result["reference_count"], 0)  # insert_dedup_record sets initial count to 0

    def test_deduplicate_and_link_new_file(self) -> None:
        """Test deduplication for a new (non-duplicate) file."""
        vault_rel_dir = Path("inbox/images/.media")
        
        is_duplicate, target_rel_path = self._dedup_service.deduplicate_and_link(
            src_path=self._test_image1,
            vault_rel_dir=vault_rel_dir,
            source_table="external_exchanges",
            source_id="/test/note1.md",
            source_column="media_path",
            context="test context",
            mime_type="image/png",
        )
        
        # Should not be a duplicate
        self.assertFalse(is_duplicate)
        
        # Target path should be based on SHA256
        expected_sha256 = self._dedup_service.compute_sha256(self._test_image1)
        self.assertIn(expected_sha256, str(target_rel_path))
        self.assertTrue(str(target_rel_path).endswith(".png"))

    def test_deduplicate_and_link_duplicate_file(self) -> None:
        """Test deduplication for a duplicate file."""
        vault_rel_dir = Path("inbox/images/.media")
        
        # First, process the file as new
        is_duplicate1, target_rel_path1 = self._dedup_service.deduplicate_and_link(
            src_path=self._test_image1,
            vault_rel_dir=vault_rel_dir,
            source_table="external_exchanges",
            source_id="/test/note1.md",
            source_column="media_path",
            context="test context 1",
            mime_type="image/png",
        )
        
        self.assertFalse(is_duplicate1)
        
        # Finalize the first file
        self._dedup_service.finalize_new_media(
            sha256=self._dedup_service.compute_sha256(self._test_image1),
            rel_path=target_rel_path1,
            size_bytes=len(self._test_image_content),
            mime_type="image/png",
            source_table="external_exchanges",
            source_id="/test/note1.md",
            source_column="media_path",
            context="test context 1",
        )
        
        # Now process the duplicate file
        is_duplicate2, target_rel_path2 = self._dedup_service.deduplicate_and_link(
            src_path=self._test_image2,
            vault_rel_dir=vault_rel_dir,
            source_table="external_exchanges",
            source_id="/test/note2.md",
            source_column="media_path",
            context="test context 2",
            mime_type="image/png",
        )
        
        # Should be detected as duplicate
        self.assertTrue(is_duplicate2)
        
        # Should return the same path as the original
        self.assertEqual(target_rel_path1, target_rel_path2)

    def test_reference_count_increases(self) -> None:
        """Test that reference count increases when duplicate is detected."""
        vault_rel_dir = Path("inbox/images/.media")
        
        # Process first file
        is_duplicate1, target_rel_path1 = self._dedup_service.deduplicate_and_link(
            src_path=self._test_image1,
            vault_rel_dir=vault_rel_dir,
            source_table="external_exchanges",
            source_id="/test/note1.md",
            source_column="media_path",
            context="test context 1",
            mime_type="image/png",
        )
        
        self.assertFalse(is_duplicate1)
        sha256 = self._dedup_service.compute_sha256(self._test_image1)
        
        self._dedup_service.finalize_new_media(
            sha256=sha256,
            rel_path=target_rel_path1,
            size_bytes=len(self._test_image_content),
            mime_type="image/png",
            source_table="external_exchanges",
            source_id="/test/note1.md",
            source_column="media_path",
            context="test context 1",
        )
        
        # Process duplicate file
        is_duplicate2, target_rel_path2 = self._dedup_service.deduplicate_and_link(
            src_path=self._test_image2,
            vault_rel_dir=vault_rel_dir,
            source_table="external_exchanges",
            source_id="/test/note2.md",
            source_column="media_path",
            context="test context 2",
            mime_type="image/png",
        )
        
        self.assertTrue(is_duplicate2)
        
        # Check reference count
        result = self._dedup_service.find_by_sha256(sha256)
        self.assertEqual(result["reference_count"], 2)

    def test_get_reference_history(self) -> None:
        """Test getting reference history for a media file."""
        vault_rel_dir = Path("inbox/images/.media")
        
        # Process first file
        is_duplicate1, target_rel_path1 = self._dedup_service.deduplicate_and_link(
            src_path=self._test_image1,
            vault_rel_dir=vault_rel_dir,
            source_table="external_exchanges",
            source_id="/test/note1.md",
            source_column="media_path",
            context="test context 1",
            mime_type="image/png",
        )
        
        sha256 = self._dedup_service.compute_sha256(self._test_image1)
        
        self._dedup_service.finalize_new_media(
            sha256=sha256,
            rel_path=target_rel_path1,
            size_bytes=len(self._test_image_content),
            mime_type="image/png",
            source_table="external_exchanges",
            source_id="/test/note1.md",
            source_column="media_path",
            context="test context 1",
        )
        
        # Process duplicate file
        is_duplicate2, target_rel_path2 = self._dedup_service.deduplicate_and_link(
            src_path=self._test_image2,
            vault_rel_dir=vault_rel_dir,
            source_table="external_exchanges",
            source_id="/test/note2.md",
            source_column="media_path",
            context="test context 2",
            mime_type="image/png",
        )
        
        # Get reference history
        history = self._dedup_service.get_reference_history(sha256)
        
        self.assertEqual(len(history), 2)
        self.assertEqual(history[0]["source_id"], "/test/note1.md")
        self.assertEqual(history[0]["context"], "test context 1")
        self.assertEqual(history[1]["source_id"], "/test/note2.md")
        self.assertEqual(history[1]["context"], "test context 2")

    def test_get_stats(self) -> None:
        """Test getting deduplication statistics."""
        vault_rel_dir = Path("inbox/images/.media")
        
        # Get initial stats
        initial_stats = self._dedup_service.get_stats()
        self.assertEqual(initial_stats["total_unique_files"], 0)
        self.assertEqual(initial_stats["total_references"], 0)
        self.assertEqual(initial_stats["total_saved_bytes"], 0)
        
        # Process a file
        is_duplicate, target_rel_path = self._dedup_service.deduplicate_and_link(
            src_path=self._test_image1,
            vault_rel_dir=vault_rel_dir,
            source_table="external_exchanges",
            source_id="/test/note1.md",
            source_column="media_path",
            context="test context",
            mime_type="image/png",
        )
        
        sha256 = self._dedup_service.compute_sha256(self._test_image1)
        
        self._dedup_service.finalize_new_media(
            sha256=sha256,
            rel_path=target_rel_path,
            size_bytes=len(self._test_image_content),
            mime_type="image/png",
            source_table="external_exchanges",
            source_id="/test/note1.md",
            source_column="media_path",
            context="test context",
        )
        
        # Get updated stats
        updated_stats = self._dedup_service.get_stats()
        self.assertEqual(updated_stats["total_unique_files"], 1)
        self.assertEqual(updated_stats["total_references"], 1)
        self.assertEqual(updated_stats["total_saved_bytes"], 0)  # No duplicates yet
        
        # Process duplicate
        is_duplicate2, target_rel_path2 = self._dedup_service.deduplicate_and_link(
            src_path=self._test_image2,
            vault_rel_dir=vault_rel_dir,
            source_table="external_exchanges",
            source_id="/test/note2.md",
            source_column="media_path",
            context="test context 2",
            mime_type="image/png",
        )
        
        # Get stats with duplicate
        final_stats = self._dedup_service.get_stats()
        self.assertEqual(final_stats["total_unique_files"], 1)
        self.assertEqual(final_stats["total_references"], 2)
        self.assertEqual(final_stats["total_saved_bytes"], len(self._test_image_content))


if __name__ == "__main__":
    unittest.main()
