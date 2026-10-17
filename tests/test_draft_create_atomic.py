"""Failed initial saves must not leave an unlisted partial draft directory."""
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'app/web'))
from editor_service import DraftStore


class DraftCreateAtomicTests(unittest.TestCase):
    def test_metadata_write_failure_removes_only_the_new_folder(self):
        with tempfile.TemporaryDirectory() as directory:
            store=DraftStore(Path(directory) / 'drafts')
            previous=store.create('# Existing article\n\nKeep this draft.')
            before={p.name for p in store.root.iterdir()}
            with patch('editor_service.atomic_json',side_effect=OSError('simulated full disk')):
                with self.assertRaises(OSError):
                    store.create('# New import\n\nCannot finish saving.')
            self.assertEqual({p.name for p in store.root.iterdir()},before)
            self.assertEqual(store.get(previous['id']),previous)


if __name__=='__main__':
    unittest.main()
