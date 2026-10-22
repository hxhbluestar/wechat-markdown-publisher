"""Code themes are portable article settings and part of the sync snapshot."""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'app/web'))
from article_import import prepare_import
from article_package import article_package, safe_package_metadata, PackageValidationError
from editor_service import DraftStore, normalize_metadata, EditorError
import test_typography_metadata
import test_sync_workflow


class CodeThemeMetadataTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.store = DraftStore(Path(self.temporary.name) / 'drafts')

    def test_only_explicit_supported_theme_ids_are_retained(self):
        self.assertEqual(normalize_metadata({}).get('code_theme'), 'auto')
        for value in ('auto', 'vscode', 'github', 'catppuccin'):
            self.assertEqual(normalize_metadata({'code_theme': value}).get('code_theme'), value)
        for value in ('VS Code', 'github; color:red', '', None, 12, True, [], {}):
            with self.subTest(value=value):
                self.assertEqual(normalize_metadata({'code_theme': value}).get('code_theme'), 'auto')

    def test_theme_is_per_article_and_default_keeps_old_revision(self):
        first, second = self.store.create('# First'), self.store.create('# Second')
        old_metadata = {key: value for key, value in first['metadata'].items() if key != 'code_theme'}
        self.assertEqual(first['revision'], self.store._revision(first['content'], old_metadata))
        saved = self.store.save(first['id'], first['content'], {**first['metadata'], 'code_theme': 'catppuccin'}, first['revision'])
        self.assertEqual(saved['metadata'].get('code_theme'), 'catppuccin')
        self.assertNotEqual(saved['revision'], first['revision'])
        self.assertEqual(self.store.get(second['id'])['metadata'].get('code_theme'), 'auto')
        restored = self.store.save(first['id'], first['content'], {**saved['metadata'], 'code_theme': 'auto'}, saved['revision'])
        self.assertEqual(restored['revision'], first['revision'])

    def test_history_and_portable_package_restore_explicit_theme(self):
        draft = self.store.create_prepared('# Saved\n\n```python\nx = 1\n```', {'title': 'Saved', 'code_theme': 'github'})
        snapshot = self.store.history.capture(draft, self.store._draft_dir(draft['id']), 'manual-save')
        saved = self.store.save(draft['id'], draft['content'], {**draft['metadata'], 'code_theme': 'vscode'}, draft['revision'])
        restored = self.store.restore_version(draft['id'], snapshot['snapshot_id'], saved['revision'])
        self.assertEqual(restored['metadata'].get('code_theme'), 'github')
        prepared = prepare_import('portable.zip', article_package(self.store, restored['id']))
        self.assertEqual(prepared['metadata'].get('code_theme'), 'github')
        imported = self.store.create_prepared(prepared['content'], prepared['metadata'], assets=prepared['assets'])
        self.assertEqual(imported['metadata'].get('code_theme'), 'github')

    def test_packages_reject_invalid_theme_instead_of_dropping_it(self):
        for value in ('auto', 'vscode', 'github', 'catppuccin'):
            self.assertEqual(safe_package_metadata({'code_theme': value}), {'code_theme': value})
        for value in ('x', 'github; color:red', None, [], {}, 12, True):
            with self.subTest(value=value), self.assertRaises(PackageValidationError):
                safe_package_metadata({'code_theme': value})

    def test_new_article_templates_preserve_all_portable_metadata_through_save_history_and_import(self):
        for theme, code_theme in (('nord', 'vscode'), ('dracula', 'catppuccin'), ('latte', 'github')):
            with self.subTest(theme=theme):
                metadata = {
                    'title': 'Synthetic ' + theme, 'author': 'Synthetic author', 'digest': 'Synthetic digest',
                    'theme': theme, 'palette': 'violet', 'font_family': 'serif', 'font_size': 18,
                    'code_theme': code_theme, 'code_font_size': 14, 'code_wrap': 'scroll',
                    'table_mode': 'cards', 'caption_font_size': 14, 'table_font_size': 15,
                    'source_url': 'https://example.invalid/article', 'source_author': 'Original author',
                    'source_date': '2026-10-22', 'article_type': 'benchmark',
                    'experiment_conditions': {'hardware': 'Synthetic GPU', 'precision': 'FP16'},
                    'block_overrides': {'block-' + 'a' * 64: {'kind': 'p', 'font_size': 18, 'line_height': 1.9}},
                    'need_open_comment': True, 'only_fans_can_comment': True, 'show_cover_pic': True,
                }
                draft = self.store.create_prepared('# Template\n\n```python\nx = 1\n```', metadata)
                for key, value in metadata.items():
                    self.assertEqual(draft['metadata'].get(key), value, key)
                snapshot = self.store.history.capture(draft, self.store._draft_dir(draft['id']), 'manual-save')
                saved = self.store.save(draft['id'], draft['content'], {**draft['metadata'], 'theme': 'technical', 'code_theme': 'auto'}, draft['revision'])
                restored = self.store.restore_version(draft['id'], snapshot['snapshot_id'], saved['revision'])
                self.assertEqual(restored['metadata'], draft['metadata'])
                prepared = prepare_import('template.zip', article_package(self.store, restored['id']))
                imported = self.store.create_prepared(prepared['content'], prepared['metadata'], assets=prepared['assets'])
                for key, value in metadata.items():
                    self.assertEqual(imported['metadata'].get(key), value, key)


class CodeThemeSyncTests(unittest.TestCase):
    setUp = test_typography_metadata.TypographySyncTests.setUp
    save_options = test_typography_metadata.TypographySyncTests.save_options
    sync = test_typography_metadata.TypographySyncTests.sync
    assert_no_remote_calls = test_typography_metadata.TypographySyncTests.assert_no_remote_calls

    def test_explicit_theme_compares_before_remote_calls_and_is_recorded(self):
        saved = self.save_options(code_theme='catppuccin')
        keys = ('font_family', 'font_size', 'code_font_size', 'code_wrap', 'table_mode', 'caption_font_size', 'table_font_size')
        options = {key: saved['metadata'][key] for key in keys}
        for theme in (None, 'auto', 'github'):
            requested = options if theme is None else {**options, 'code_theme': theme}
            with self.subTest(theme=theme):
                with self.assertRaises(EditorError) as raised:
                    self.sync('technical', typography=requested)
                self.assertEqual(raised.exception.status, 409)
                self.assert_no_remote_calls()
        synced, _ = self.sync('technical', typography={**options, 'code_theme': 'catppuccin'})
        self.assertEqual(synced['publish']['typography'].get('code_theme'), 'catppuccin')

    def test_old_seven_field_request_is_accepted_only_for_auto(self):
        saved = self.save_options(code_font_size=14)
        options = {key: saved['metadata'][key] for key in ('font_family', 'font_size', 'code_font_size', 'code_wrap', 'table_mode', 'caption_font_size', 'table_font_size')}
        synced, _ = self.sync('technical', typography=options)
        self.assertEqual(synced['publish']['typography'].get('code_theme'), 'auto')

    def test_older_four_and_six_fields_cannot_omit_an_explicit_theme(self):
        saved = self.save_options(code_theme='github')
        for keys in (('font_family', 'font_size', 'code_wrap', 'table_mode'),
                     ('font_family', 'font_size', 'code_wrap', 'table_mode', 'caption_font_size', 'table_font_size')):
            options = {key: saved['metadata'][key] for key in keys}
            with self.subTest(fields=len(keys)):
                with self.assertRaises(EditorError) as raised:
                    self.sync('technical', typography=options)
                self.assertEqual(raised.exception.status, 409)
                self.assert_no_remote_calls()

    def test_invalid_explicit_theme_rejects_before_remote_calls(self):
        saved = self.save_options()
        options = {key: saved['metadata'][key] for key in ('font_family', 'font_size', 'code_font_size', 'code_wrap', 'table_mode', 'caption_font_size', 'table_font_size')}
        for value in ('unknown', 'vscode; color:red', [], {}, True):
            with self.subTest(value=value), self.assertRaises(EditorError):
                self.sync('technical', typography={**options, 'code_theme': value})
            self.assert_no_remote_calls()

    def test_new_article_templates_sync_all_eight_settings_with_each_explicit_code_theme(self):
        for theme in ('nord', 'dracula', 'latte'):
            for code_theme in ('auto', 'vscode', 'github', 'catppuccin'):
                with self.subTest(theme=theme, code_theme=code_theme):
                    options = {'font_family': 'serif', 'font_size': 18, 'code_theme': code_theme,
                               'code_font_size': 14, 'code_wrap': 'wrap', 'table_mode': 'cards',
                               'caption_font_size': 12, 'table_font_size': 14}
                    saved = self.save_options(theme, **options)
                    self.assertEqual(saved['metadata']['theme'], theme)
                    synced, _ = self.sync(theme, typography=options)
                    self.assertEqual(synced['publish']['theme'], theme)
                    self.assertEqual(synced['publish']['typography'], options)
                    self.assertEqual(synced['publish']['draft_revision'], saved['revision'])


class CodeThemeAsyncSyncTests(unittest.TestCase):
    setUp = test_sync_workflow.SyncWorkflowTests.setUp
    finish_workers = test_sync_workflow.SyncWorkflowTests.finish_workers
    put = test_sync_workflow.SyncWorkflowTests.put
    payload = test_sync_workflow.SyncWorkflowTests.payload

    def test_old_seven_fields_bind_auto_theme_to_frozen_snapshot(self):
        payload = self.payload()
        payload['typography'].pop('code_theme', None)
        job = self.workflow.start(self.draft['id'], payload)
        finished = self.jobs.wait_for(job['id'], timeout=3)
        self.assertEqual(finished['state'], 'succeeded')
        self.assertEqual(self.publisher.observed[0]['draft']['metadata'].get('code_theme'), 'auto')

    def test_new_article_templates_keep_all_settings_in_async_snapshot(self):
        for index, (theme, code_theme) in enumerate((('nord', 'vscode'), ('dracula', 'catppuccin'), ('latte', 'github'))):
            with self.subTest(theme=theme):
                options = {'theme': theme, 'font_family': 'serif', 'font_size': 18,
                           'code_font_size': 14, 'code_theme': code_theme, 'code_wrap': 'scroll',
                           'table_mode': 'cards', 'caption_font_size': 14, 'table_font_size': 15}
                self.draft = self.store.save(self.draft['id'], self.draft['content'], {**self.draft['metadata'], **options}, self.draft['revision'])
                payload = self.payload()
                job = self.workflow.start(self.draft['id'], payload)
                self.assertEqual(self.jobs.wait_for(job['id'], timeout=3)['state'], 'succeeded')
                frozen = self.publisher.observed[index]['draft']['metadata']
                for key, value in options.items():
                    self.assertEqual(frozen.get(key), value, key)

    def test_explicit_theme_cannot_be_omitted_or_mismatched_in_async_sync(self):
        self.draft = self.store.save(self.draft['id'], self.draft['content'], {**self.draft['metadata'], 'code_theme': 'github'}, self.draft['revision'])
        payload = self.payload()
        for theme in (None, 'auto', 'catppuccin'):
            requested = {**payload, 'typography': {**payload['typography']}}
            if theme is None:
                requested['typography'].pop('code_theme', None)
            else:
                requested['typography']['code_theme'] = theme
            with self.subTest(theme=theme):
                with self.assertRaises(EditorError) as raised:
                    self.workflow.start(self.draft['id'], requested)
                self.assertEqual(raised.exception.status, 409)
                self.assertEqual(self.jobs.list(), [])
                self.assertEqual(self.publisher.calls, [])
        job = self.workflow.start(self.draft['id'], payload)
        self.assertEqual(self.jobs.wait_for(job['id'], timeout=3)['state'], 'succeeded')
        self.assertEqual(self.publisher.observed[0]['draft']['metadata'].get('code_theme'), 'github')


if __name__ == '__main__':
    unittest.main()
