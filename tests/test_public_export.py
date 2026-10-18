"""Verify public exports in an isolated Git fixture, never the real checkout."""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(shutil.which("git"), "Git is required for the public export fixture")
class PublicExportTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='publisher-public-export-')
        self.addCleanup(self.temporary.cleanup)
        self.fixture = Path(self.temporary.name)
        self.source = self.fixture / 'source'
        self.destination = self.fixture / 'public'

    def export_fixture(self, extras=None):
        files = {
            'app/web/company_network.py': '# Synthetic transport\n',
            'tests/test_company_network.py': '# Synthetic transport tests\n',
            'tests/test_asset_sync.py': '# Synthetic assets tests\n',
            'tests/asset-paths.test.mjs': '// Synthetic assets tests\n',
            'publication/README.md': '# Public documentation\n',
            '.gitignore': 'node_modules/\n',
            **(extras or {}),
        }
        for relative, content in files.items():
            path = self.source / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding='utf-8')
        (self.source / 'tools').mkdir(exist_ok=True)
        shutil.copyfile(ROOT / 'tools/export-public.py', self.source / 'tools/export-public.py')
        for command in (['git', 'init', '-q'], ['git', 'add', '-f', '.']):
            subprocess.run(command, cwd=self.source, capture_output=True, check=True)
        return subprocess.run([sys.executable, str(self.source / 'tools/export-public.py'), str(self.destination)],
                              capture_output=True, text=True, timeout=30)

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

    def test_readable_build_workflow_allowlist_and_pinned_runtime_are_exported(self):
        public_files = {
            '.gitattributes': '* text=auto eol=lf\n',
            'tools/build-frontend.mjs': '// Real readable build entry\n',
            'config/deployment-files.json': '{"schema_version":1,"files":[]}\n',
            '.github/workflows/ci.yml': 'name: synthetic-ci\n',
            'frontend/editor-app.mjs': '// Readable entry\n',
            'frontend/vendor/editor-engine-20261018.js': '// Pinned runtime\n',
            'frontend/vendor/NOTICE.md': '# Runtime provenance\n',
            'app/web/article_import.py': '# Offline import\n',
            'publication/THIRD_PARTY_NOTICES.md': '# Third-party notices\n',
        }
        result = self.export_fixture(public_files)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        for relative in public_files:
            target = relative.removeprefix('publication/')
            self.assertTrue((self.destination / target).is_file(), target)

    def test_force_tracked_private_content_and_private_tools_are_never_exported(self):
        private_files = {
            'app/knowledge_base/drafts/real.md': 'DO NOT EXPORT ARTICLE',
            'app/web/private/accounts.json': 'DO NOT EXPORT ACCOUNT',
            'app/web/data/company-network.json': 'DO NOT EXPORT NETWORK',
            'app/output/article.html': 'DO NOT EXPORT GENERATED ARTICLE',
            'frontend/.env': 'DO NOT EXPORT SECRET',
            'config/wechat.env': 'DO NOT EXPORT SECRET',
            'config/private-network.json': 'DO NOT EXPORT NETWORK',
            'config/company-network.json': 'DO NOT EXPORT ACTUAL NETWORK',
            'scripts/local-cookie-cache.json': 'DO NOT EXPORT COOKIE',
            'tools/audit-public.py': 'DO NOT EXPORT PRIVATE AUDIT',
            'publication/private/local-notes.md': 'DO NOT EXPORT PRIVATE NOTES',
            'publication/.env': 'DO NOT EXPORT SECRET',
        }
        result = self.export_fixture(private_files)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        for relative in private_files:
            self.assertFalse((self.destination / relative.removeprefix('publication/')).exists(), relative)

    def test_editorial_records_are_empty_and_network_examples_are_sanitized(self):
        address = '203.0.113.234'
        result = self.export_fixture({'tests/test_company_network.py': '# public fixture ' + address,
                                     'app/web/article-type-overrides.json': '{"private-article":"real"}',
                                     'config/company-network.example.json': '{"expected_public_ip":"' + address + '"}'})
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertNotIn(address, (self.destination / 'tests/test_company_network.py').read_text())
        self.assertEqual(json.loads((self.destination / 'app/web/article-type-overrides.json').read_text()), {})
        self.assertEqual(json.loads((self.destination / 'config/company-network.example.json').read_text())['expected_public_ip'], 'YOUR_FIXED_PUBLIC_IPV4')

    def test_existing_public_git_metadata_is_preserved_and_new_untracked_source_is_omitted(self):
        (self.destination / '.git').mkdir(parents=True)
        (self.destination / '.git/config').write_text('existing Git identity remains')
        result = self.export_fixture({'frontend/tracked.mjs': '// tracked'})
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual((self.destination / '.git/config').read_text(), 'existing Git identity remains')
        (self.source / 'frontend/untracked.mjs').write_text('// unreviewed untracked source')
        result = subprocess.run([sys.executable, str(self.source / 'tools/export-public.py'), str(self.destination)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse((self.destination / 'frontend/untracked.mjs').exists())

    def test_ci_scanner_allows_synthetic_test_credentials_and_masks_real_source_findings(self):
        workflow = (ROOT / '.github/workflows/ci.yml').read_text('utf-8')
        block = re.search(r'(?m)^        shell: python\r?\n        run: \|\r?\n((?:          .*\r?\n|\r?\n)+)', workflow)
        self.assertIsNotNone(block, 'CI Python runner is missing')
        scanner = textwrap.dedent(block[1])
        secret = 'sk-' + 'A' * 40
        result = self.export_fixture({'tests/test_synthetic.py': 'TOKEN="' + secret + '"', 'frontend/source.mjs': '// safe source'})
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        for command in (['git', 'init', '-q'], ['git', 'add', '-f', '.']):
            subprocess.run(command, cwd=self.destination, capture_output=True, check=True)
        safe = subprocess.run([sys.executable, '-c', scanner], cwd=self.destination, capture_output=True, text=True)
        self.assertEqual(safe.returncode, 0, safe.stdout + safe.stderr)
        (self.destination / 'frontend/source.mjs').write_text('const apiKey = "' + secret + '";')
        blocked = subprocess.run([sys.executable, '-c', scanner], cwd=self.destination, capture_output=True, text=True)
        self.assertNotEqual(blocked.returncode, 0)
        self.assertIn('frontend/source.mjs', blocked.stdout)
        self.assertNotIn(secret, blocked.stdout + blocked.stderr)

    def test_sanitized_public_exporter_can_run_its_privacy_regression_again(self):
        result = self.export_fixture({'tests/test_public_export.py': Path(__file__).read_text('utf-8')})
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        regression = subprocess.run([sys.executable, '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_public_export.py', '-k', 'editorial', '-v'],
                                    cwd=self.destination, capture_output=True, text=True, timeout=30)
        self.assertEqual(regression.returncode, 0, regression.stdout + regression.stderr)


if __name__ == "__main__":
    unittest.main()
