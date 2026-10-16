"""Verify public exports in an isolated Git fixture, never the real checkout."""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(shutil.which("git"), "Git is required for the public export fixture")
class PublicExportTests(unittest.TestCase):
    def test_frontend_dependency_manifests_are_exported_without_other_root_files(self) -> None:
        with tempfile.TemporaryDirectory(prefix="publisher-public-export-") as temporary:
            fixture = Path(temporary)
            source = fixture / "source"
            files = {
                "app/web/company_network.py": "# Safe fixture\n",
                "tests/test_company_network.py": "# Safe fixture\n",
                "tests/test_asset_sync.py": "# Safe fixture\n",
                "tests/asset-paths.test.mjs": "// Safe fixture\n",
                "config/company-network.example.json": "{}\n",
                "publication/README.md": "# Public fixture\n",
                ".gitignore": "node_modules/\n",
                "package.json": '{"name":"fixture","private":true}\n',
                "package-lock.json": '{"name":"fixture","lockfileVersion":3}\n',
                "private-keep.txt": "must not be exported\n",
                "tools/deploy-typography.ps1": "# Isolated deployment fixture\n",
            }
            for relative, content in files.items():
                path = source / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(content, encoding="utf-8")
            shutil.copyfile(ROOT / "tools/export-public.py", source / "tools/export-public.py")
            for command in (["git", "init", "-q"], ["git", "add", "."]):
                subprocess.run(command, cwd=source, capture_output=True, check=True)
            destination = fixture / "public"

            result = subprocess.run([
                sys.executable, str(source / "tools/export-public.py"), str(destination),
            ], capture_output=True, text=True, timeout=30)

            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            for name in ("package.json", "package-lock.json"):
                self.assertTrue((destination / name).is_file(), name + " was omitted from public export")
                self.assertEqual(json.loads((destination / name).read_text("utf-8")), json.loads(files[name]))
            for relative in ("tools/export-public.py", "tools/deploy-typography.ps1"):
                self.assertTrue((destination / relative).is_file(), relative + " was omitted from public export")
            self.assertFalse((destination / "private-keep.txt").exists())
            self.assertFalse((destination / ".git").exists())


if __name__ == "__main__":
    unittest.main()
