"""Code-size preferences persist and validate across article lifecycle boundaries."""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'app/web'))
from article_import import prepare_import
from article_package import article_package, safe_package_metadata, PackageValidationError
from editor_service import DraftStore, normalize_metadata, EditorError
import test_typography_metadata


class CodeFontMetadataTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.store = DraftStore(Path(self.temporary.name) / 'drafts')

    def test_only_integer_12_or_14_is_retained_and_missing_code_uses_reading_defaults(self):
        defaults = normalize_metadata({})
        self.assertEqual(defaults.get('code_font_size'), 12)
        self.assertEqual(defaults['code_wrap'], 'wrap')
        for value in (12, 14):
            self.assertEqual(normalize_metadata({'code_font_size': value}).get('code_font_size'), value)
        for value in (True, 12.0, '14', '12px', 13, 11, 15, {}, []):
            with self.subTest(value=value):
                self.assertEqual(normalize_metadata({'code_font_size': value}).get('code_font_size'), 12)
        self.assertEqual(normalize_metadata({'code_wrap': 'scroll'})['code_wrap'], 'scroll')

    def test_code_size_is_saved_per_article_and_changes_revision(self):
        first = self.store.create('# First\n\n```bash\necho hello\n```')
        second = self.store.create('# Second')
        saved = self.store.save(first['id'], first['content'], {**first['metadata'], 'code_font_size': 14, 'code_wrap': 'scroll'}, first['revision'])
        self.assertEqual(self.store.get(first['id'])['metadata'].get('code_font_size'), 14)
        self.assertEqual(self.store.get(first['id'])['metadata']['code_wrap'], 'scroll')
        self.assertEqual(self.store.get(second['id'])['metadata'].get('code_font_size'), 12)
        self.assertNotEqual(saved['revision'], first['revision'])
        restored = self.store.save(first['id'], first['content'], {**saved['metadata'], 'code_font_size': 12, 'code_wrap': 'wrap'}, saved['revision'])
        self.assertEqual(restored['revision'], first['revision'])

    def test_history_restore_and_portable_package_restore_explicit_14_and_scroll(self):
        draft = self.store.create_prepared('# Preserved\n\n```python\nx = 1\n```', {'title': 'Preserved', 'code_font_size': 14, 'code_wrap': 'scroll'})
        snapshot = self.store.history.capture(draft, self.store._draft_dir(draft['id']), 'manual-save')
        saved = self.store.save(draft['id'], draft['content'], {**draft['metadata'], 'code_font_size': 12, 'code_wrap': 'wrap'}, draft['revision'])
        restored = self.store.restore_version(draft['id'], snapshot['snapshot_id'], saved['revision'])
        self.assertEqual(restored['metadata'].get('code_font_size'), 14)
        self.assertEqual(restored['metadata']['code_wrap'], 'scroll')
        prepared = prepare_import('portable.zip', article_package(self.store, restored['id']))
        self.assertEqual(prepared['metadata'].get('code_font_size'), 14)
        self.assertEqual(prepared['metadata']['code_wrap'], 'scroll')
        imported = self.store.create_prepared(prepared['content'], prepared['metadata'], assets=prepared['assets'])
        self.assertEqual(imported['metadata'].get('code_font_size'), 14)

    def test_portable_package_rejects_invalid_code_sizes_instead_of_ignoring_them(self):
        self.assertEqual(safe_package_metadata({'code_font_size': 14}), {'code_font_size': 14})
        for value in (13, 15, '12', 14.0, True, [], {}):
            with self.subTest(value=value), self.assertRaises(PackageValidationError):
                safe_package_metadata({'code_font_size': value})


class CodeFontSyncTests(unittest.TestCase):
    # Reuse the synthetic local store and fake API, without inheriting its tests.
    setUp = test_typography_metadata.TypographySyncTests.setUp
    save_options = test_typography_metadata.TypographySyncTests.save_options
    sync = test_typography_metadata.TypographySyncTests.sync
    assert_no_remote_calls = test_typography_metadata.TypographySyncTests.assert_no_remote_calls
    def test_explicit_code_size_is_compared_before_remote_calls_and_recorded(self):
        saved = self.save_options(code_font_size=14)
        options = {key: saved['metadata'][key] for key in ('font_family', 'font_size', 'code_wrap', 'table_mode', 'caption_font_size', 'table_font_size')}
        with self.assertRaises(EditorError) as raised:
            self.sync('technical', typography=options)
        self.assertEqual(raised.exception.status, 409)
        self.assert_no_remote_calls()
        options['code_font_size'] = 14
        synced, _ = self.sync('technical', typography=options)
        self.assertEqual(synced['publish']['typography'].get('code_font_size'), 14)


if __name__ == '__main__':
    unittest.main()
