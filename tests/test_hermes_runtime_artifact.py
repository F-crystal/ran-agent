from __future__ import annotations

import base64
import hashlib
import importlib.util
import io
import json
import tarfile
import tempfile
import unittest
import zipfile
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / "scripts" / "build-hermes-runtime-artifact.py"
SPEC = importlib.util.spec_from_file_location("hermes_runtime_artifact", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class HermesRuntimeArtifactTest(unittest.TestCase):
    def test_safe_extract_rejects_escape_hardlink_and_symlink_parent(self) -> None:
        cases = []

        escape = tarfile.TarInfo("../escape")
        escape.size = 1
        cases.append([(escape, b"x")])

        hardlink = tarfile.TarInfo("hardlink")
        hardlink.type = tarfile.LNKTYPE
        hardlink.linkname = "target"
        cases.append([(hardlink, None)])

        symlink = tarfile.TarInfo("link")
        symlink.type = tarfile.SYMTYPE
        symlink.linkname = "target"
        nested = tarfile.TarInfo("link/file")
        nested.size = 1
        cases.append([(symlink, None), (nested, b"x")])

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for index, members in enumerate(cases):
                archive = root / f"bad-{index}.tar"
                with tarfile.open(archive, "w") as output:
                    for member, content in members:
                        output.addfile(member, io.BytesIO(content) if content is not None else None)
                with self.assertRaises(ValueError):
                    MODULE.safe_extract_tar(archive, root / f"out-{index}")

    def test_safe_extract_accepts_relative_symlink(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / "good.tar"
            with tarfile.open(archive, "w") as output:
                target = tarfile.TarInfo("python/bin/python3.12")
                target.size = 2
                output.addfile(target, io.BytesIO(b"ok"))
                link = tarfile.TarInfo("python/bin/python3")
                link.type = tarfile.SYMTYPE
                link.linkname = "python3.12"
                output.addfile(link)
            destination = root / "out"
            MODULE.safe_extract_tar(archive, destination)
            self.assertEqual((destination / "python/bin/python3").read_bytes(), b"ok")

    def test_safe_extract_rejects_casefold_collision_unless_prefix_is_excluded(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / "case.tar"
            with tarfile.open(archive, "w") as output:
                for name in ("python/share/terminfo/E/Eterm", "python/share/terminfo/e/eterm"):
                    member = tarfile.TarInfo(name)
                    member.size = 1
                    output.addfile(member, io.BytesIO(b"x"))
            with self.assertRaisesRegex(ValueError, "casefold archive collision"):
                MODULE.safe_extract_tar(archive, root / "rejected")
            accepted = root / "accepted"
            MODULE.safe_extract_tar(archive, accepted, exclude_prefixes=("python/share/terminfo",))
            self.assertEqual(list(accepted.rglob("*")), [])

    def test_tree_digest_covers_content_mode_and_symlink_target(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            file = root / "file"
            file.write_text("one", encoding="utf-8")
            file.chmod(0o644)
            link = root / "link"
            link.symlink_to("file")
            original = MODULE.tree_digest(root)
            file.write_text("two", encoding="utf-8")
            changed_content = MODULE.tree_digest(root)
            self.assertNotEqual(original, changed_content)
            file.write_text("one", encoding="utf-8")
            file.chmod(0o600)
            self.assertNotEqual(original, MODULE.tree_digest(root))
            file.chmod(0o644)
            link.unlink()
            link.symlink_to("other")
            self.assertNotEqual(original, MODULE.tree_digest(root))

    def test_tree_walk_never_follows_symlink_cycle(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "file").write_text("ok", encoding="utf-8")
            (root / "loop").symlink_to(".")
            self.assertEqual([path.name for path in MODULE.walk_tree(root)], ["file", "loop"])
            self.assertEqual(len(MODULE.tree_digest(root)), 64)

    def test_deterministic_archive_has_stable_digest(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "root"
            root.mkdir()
            (root / "file").write_text("payload", encoding="utf-8")
            (root / "link").symlink_to("file")
            first = Path(temporary) / "first.tar.gz"
            second = Path(temporary) / "second.tar.gz"
            MODULE.deterministic_archive(root, first)
            MODULE.deterministic_archive(root, second)
            self.assertEqual(MODULE.sha256_file(first), MODULE.sha256_file(second))
            with tarfile.open(first, "r:gz") as archive:
                names = archive.getnames()
                self.assertEqual(names, ["hermes-runtime", "hermes-runtime/file", "hermes-runtime/link"])
                self.assertTrue(all(member.mtime == 0 and member.uid == 0 and member.gid == 0 for member in archive.getmembers()))
                self.assertEqual(archive.getmember("hermes-runtime/link").mode, 0o777)

    def test_wheel_metadata_reads_name_and_version(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            wheel = Path(temporary) / "example-1.2.3-py3-none-any.whl"
            with zipfile.ZipFile(wheel, "w") as output:
                output.writestr("example-1.2.3.dist-info/METADATA", "Name: Example_Name\nVersion: 1.2.3\n")
                output.writestr("example/_vendor/other-9.0.dist-info/METADATA", "Name: other\nVersion: 9.0\n")
            self.assertEqual(MODULE.wheel_metadata(wheel), ("example-name", "1.2.3"))

    def test_normalize_installed_records_removes_omitted_files_and_keeps_closure(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            site_packages = Path(temporary)
            metadata = site_packages / "example-1.0.dist-info"
            metadata.mkdir()
            (metadata / "uv_cache.json").write_text('{"timestamp": 123}\n', encoding="utf-8")
            script = site_packages / "bin" / "example"
            script.parent.mkdir()
            script.write_text("run", encoding="utf-8")
            example = site_packages / "example.py"
            example.write_text("x", encoding="utf-8")
            pillow = site_packages / "PIL"
            pillow.mkdir()
            imaging_tk = pillow / "_imagingtk.cpython-312-x86_64-linux-gnu.so"
            tkinter_finder = pillow / "_tkinter_finder.py"
            imaging_tk.write_bytes(b"elf")
            tkinter_finder.write_bytes(b"find")
            digest = base64.urlsafe_b64encode(hashlib.sha256(b"x").digest()).decode("ascii").rstrip("=")
            (metadata / "RECORD").write_text(
                f"example.py,sha256={digest},1\n"
                "example-1.0.dist-info/uv_cache.json,sha256=drop,19\n"
                "bin/example,sha256=drop,3\n"
                "PIL/_imagingtk.cpython-312-x86_64-linux-gnu.so,sha256=drop,3\n"
                "PIL/_tkinter_finder.py,sha256=drop,4\n"
                "example-1.0.dist-info/RECORD,,\n",
                encoding="utf-8",
            )

            MODULE.normalize_installed_records(
                site_packages,
                omitted_globs=("PIL/_imagingtk*.so", "PIL/_tkinter_finder.py"),
            )

            self.assertFalse((metadata / "uv_cache.json").exists())
            self.assertFalse(script.exists())
            self.assertFalse(imaging_tk.exists())
            self.assertFalse(tkinter_finder.exists())
            self.assertEqual(
                (metadata / "RECORD").read_text(encoding="utf-8"),
                f"example.py,sha256={digest},1\nexample-1.0.dist-info/RECORD,,\n",
            )

    def test_normalize_installed_records_requires_exact_record_entry(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            metadata = Path(temporary) / "example-1.0.dist-info"
            metadata.mkdir()
            cache = metadata / "uv_cache.json"
            cache.write_text('{"timestamp": 123}\n', encoding="utf-8")
            (metadata / "RECORD").write_text("example.py,sha256=keep,1\n", encoding="utf-8")

            with self.assertRaisesRegex(ValueError, "RECORD count invalid"):
                MODULE.normalize_installed_records(Path(temporary))

            self.assertTrue(cache.exists())

    def test_remove_headless_optional_extensions_requires_one_tkinter_binary(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            runtime = Path(temporary)
            extension_dir = runtime / "python/lib/python3.12/lib-dynload"
            extension_dir.mkdir(parents=True)
            extension = extension_dir / "_tkinter.cpython-312-x86_64-linux-gnu.so"
            extension.write_bytes(b"elf")

            MODULE.remove_headless_optional_extensions(runtime)

            self.assertFalse(extension.exists())
            with self.assertRaisesRegex(ValueError, "count invalid: 0"):
                MODULE.remove_headless_optional_extensions(runtime)

    def test_governed_manifest_keeps_builder_schema(self) -> None:
        path = Path(__file__).parents[1] / "docs/governance/hermes_runtime_artifact.v1.json"
        manifest = json.loads(path.read_text(encoding="utf-8"))
        self.assertNotIn("wheels", manifest)
        self.assertNotIn("installed", manifest)
        self.assertEqual(len(manifest["dependencies"]["wheels"]), 77)
        self.assertEqual(len(manifest["dependencies"]["installed"]), 77)
        self.assertEqual(manifest["status"], "LOCAL_BUILT_NOT_LINUX_VERIFIED")


if __name__ == "__main__":
    unittest.main()
