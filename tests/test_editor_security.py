"""The local editor grants only the exact shipped import map inline script."""
import base64
import hashlib
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'app/web'))
from editor_security import import_map_csp


class ImportMapPolicyTests(unittest.TestCase):
    def test_only_the_exact_import_map_receives_a_hash(self):
        with tempfile.TemporaryDirectory() as directory:
            page = Path(directory) / 'index.html'
            content = '{"imports":{"/old.js":"/new.js"}}'
            page.write_text('<script>alert(1)</script><script type="importmap">' + content + '</script>', encoding='utf-8')
            expected = base64.b64encode(hashlib.sha256(content.encode()).digest()).decode()
            self.assertEqual(import_map_csp(page), " 'sha256-" + expected + "'")
            page.write_text('<script type="importmap"> ' + content + '</script>', encoding='utf-8')
            self.assertNotEqual(import_map_csp(page), " 'sha256-" + expected + "'")

    def test_absent_import_map_does_not_allow_inline_scripts(self):
        with tempfile.TemporaryDirectory() as directory:
            page = Path(directory) / 'index.html'
            self.assertEqual(import_map_csp(page), '')
            page.write_text('<script>run()</script>', encoding='utf-8')
            self.assertEqual(import_map_csp(page), '')


if __name__ == '__main__':
    unittest.main()
