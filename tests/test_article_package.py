"""Portable backup round trips use only temporary drafts and synthetic PNGs."""
import hashlib
import io
import json
import struct
import sys
import tempfile
import unittest
import zipfile
import zlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'app/web'))
from article_package import article_package, EXPORT_METADATA
from article_import import prepare_import, ArticleImportError
from asset_service import record_derivation, relations
from editor_service import DraftStore


def png(rgb):
    def chunk(kind, value):
        return struct.pack('>I', len(value)) + kind + value + struct.pack('>I', zlib.crc32(kind + value))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(b'\x00' + bytes(rgb))) + chunk(b'IEND', b'')


ORIGINAL, DERIVED, COVER = png((20, 70, 120)), png((100, 140, 180)), png((180, 90, 30))
sha = lambda value: hashlib.sha256(value).hexdigest()


def zip_bytes(entries):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, 'w', zipfile.ZIP_STORED) as archive:
        for name, data in entries.items():
            archive.writestr(name, data)
    return stream.getvalue()


def members(data):
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        return {name: archive.read(name) for name in archive.namelist()}


def edit_package(data, *, metadata=None, manifest=None, drop=(), extra=None):
    entries = members(data)
    for name, mutate in [('metadata.json', metadata), ('manifest.json', manifest)]:
        if mutate:
            value = json.loads(entries[name])
            mutate(value)
            entries[name] = json.dumps(value).encode()
    for name in drop:
        entries.pop(name, None)
    entries.update(extra or {})
    return zip_bytes(entries)


class ArticlePackageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.store = DraftStore(Path(self.temporary.name) / 'drafts')
        self.block_id = 'block-' + 'b' * 64
        self.content = '# Body heading differs from metadata\n\n![derived](images/derived.png)\n\n~~~python\nmessage = "中文 <tag>"\n~~~\n'
        self.metadata = {
            'title': 'Portable metadata title', 'author': 'Synthetic author', 'digest': 'Synthetic digest',
            'cover': 'cover.png', 'source_url': 'https://example.org/synthetic',
            'theme': 'obsidian', 'palette': 'violet', 'font_family': 'serif', 'font_size': 18,
            'code_wrap': 'wrap', 'table_mode': 'scroll', 'caption_font_size': 12, 'table_font_size': 14,
            'show_cover_pic': True, 'need_open_comment': True, 'only_fans_can_comment': False,
            'article_type': 'benchmark', 'experiment_conditions': {'hardware': 'Synthetic GPU', 'rocm_version': 'Example fixed version', 'concurrency': '4'},
            'block_overrides': {self.block_id: {'kind': 'p', 'font_size': 18, 'margin_before': 12, 'line_height': 1.8}},
            'source_author': 'Original synthetic author', 'source_date': '2026-01-01',
            'wechat_account_id': 'account-123456abcdef',
        }
        assets = [{'name': path, 'bytes': data} for path, data in [('images/original.png', ORIGINAL), ('images/alias.png', ORIGINAL), ('images/derived.png', DERIVED), ('cover.png', COVER)]]
        self.draft = self.store.create_prepared(self.content, self.metadata, assets=assets)
        self.relation = {'source_path': 'images/alias.png', 'source_hash': sha(ORIGINAL), 'derived_hash': sha(DERIVED), 'mode': 'diagram', 'operations': [{'operation': 'lossless-png'}], 'source': {'sha256': sha(ORIGINAL), 'width': 1, 'height': 1, 'format': 'PNG'}}
        record_derivation(self.store, self.draft['id'], 'images/derived.png', self.relation)

    def exported(self):
        return article_package(self.store, self.draft['id'])

    def test_export_import_save_restores_metadata_cover_originals_and_derivative_relationship(self):
        package = self.exported()
        prepared = prepare_import('portable.zip', package)
        self.assertEqual(prepared['title'], self.metadata['title'])
        for field in ['theme', 'palette', 'font_family', 'font_size', 'code_wrap', 'table_mode', 'caption_font_size', 'table_font_size', 'article_type', 'experiment_conditions', 'block_overrides', 'source_author', 'source_date']:
            self.assertEqual(prepared['metadata'][field], self.metadata[field], field)
        original_path, derived_path, cover_path = ['images/' + sha(data) + '.png' for data in (ORIGINAL, DERIVED, COVER)]
        self.assertEqual({asset['name'] for asset in prepared['assets']}, {original_path, derived_path, cover_path})
        self.assertEqual(prepared['metadata']['cover'], cover_path)
        self.assertIn(f'![derived]({derived_path})', prepared['content'])
        self.assertIn('message = "中文 <tag>"', prepared['content'])
        self.assertEqual(prepared['asset_relations'][derived_path]['source_path'], original_path)
        self.assertEqual(prepared['asset_relations'][derived_path]['source_hash'], sha(ORIGINAL))
        self.assertEqual(prepared['source_original']['bytes'], package)
        restored = self.store.create_prepared(prepared['content'], prepared['metadata'], assets=prepared['assets'])
        for path, relation in prepared['asset_relations'].items():
            record_derivation(self.store, restored['id'], path, relation)
        self.assertEqual(self.store.get(restored['id'])['metadata']['cover'], cover_path)
        self.assertEqual(self.store.asset_path(restored['id'], original_path).read_bytes(), ORIGINAL)
        self.assertEqual(relations(self.store, restored['id'])[derived_path]['source_path'], original_path)

    def test_export_has_no_account_credentials_transport_ids_or_unknown_nested_fields(self):
        self.store.save_publish_state(self.draft['id'], {'account_id': 'account-123456abcdef', 'media_id': 'synthetic-transport-media', 'access_token': 'synthetic-token', 'last_error': 'synthetic-private-error', 'synced_at': '2026-01-01T00:00:00+00:00', 'publish_status': 'draft_synced'})
        path = self.store._draft_dir(self.draft['id']) / '.asset-relations.json'
        value = json.loads(path.read_text('utf-8'))
        value['images/derived.png'].update({'account_id': 'synthetic-account', 'cookie': 'synthetic-cookie'})
        value['images/derived.png']['source']['access_token'] = 'synthetic-nested-token'
        value['images/derived.png']['operations'][0]['credentials'] = {'secret': 'synthetic-operation-secret'}
        path.write_text(json.dumps(value), 'utf-8')
        exported = members(self.exported())
        payload = '\n'.join(data.decode('utf-8') for name, data in exported.items() if name.endswith('.json'))
        for secret in ['account-123456abcdef', 'synthetic-transport-media', 'synthetic-token', 'synthetic-private-error', 'synthetic-account', 'synthetic-cookie', 'synthetic-nested-token', 'synthetic-operation-secret']:
            self.assertNotIn(secret, payload)
        self.assertEqual(set(json.loads(exported['metadata.json'])) - EXPORT_METADATA, set())
        self.assertNotIn('publish-state.json', exported)
        self.assertIn('asset_relations', json.loads(exported['manifest.json']))

    def test_import_filters_unknown_metadata_and_nested_condition_credentials(self):
        def change(value):
            value.update({'wechat_account_id': 'account-123456abcdef', 'credentials': {'api_key': 'synthetic-secret'}})
            value['experiment_conditions']['access_token'] = 'synthetic-secret'
            value['block_overrides'][self.block_id]['style'] = 'background:url(https://example.org/a)'
        prepared = prepare_import('portable.zip', edit_package(self.exported(), metadata=change))
        self.assertNotIn('wechat_account_id', prepared['metadata'])
        self.assertNotIn('credentials', prepared['metadata'])
        self.assertNotIn('access_token', prepared['metadata']['experiment_conditions'])
        self.assertNotIn('style', prepared['metadata']['block_overrides'][self.block_id])

    def test_unrelated_zip_metadata_is_not_applied_and_unused_images_still_remain_ignored(self):
        package = zip_bytes({'a.md': '# Ordinary ZIP\n![used](a.png)', 'a.png': ORIGINAL, 'unused.png': COVER, 'metadata.json': '{"title":"Unrelated","extra":"ignored"}', 'manifest.json': '{"dataset":"generic"}'})
        prepared = prepare_import('ordinary.zip', package)
        self.assertEqual(prepared['title'], 'Ordinary ZIP')
        self.assertEqual(len(prepared['assets']), 1)
        self.assertNotIn('asset_relations', prepared)

    def test_unrelated_format_number_or_non_json_manifest_keeps_ordinary_zip_behavior(self):
        for manifest in (b'{"format":1,"dataset":"unrelated"}', b'not a publisher manifest'):
            with self.subTest(manifest=manifest):
                package = zip_bytes({'article.md': '# Ordinary ZIP', 'metadata.json': '{"title":"Not publisher metadata"}', 'manifest.json': manifest})
                prepared = prepare_import('ordinary.zip', package)
                self.assertEqual(prepared['title'], 'Ordinary ZIP')
                self.assertNotIn('asset_relations', prepared)

    def test_same_draft_api_image_alias_is_made_portable_without_changing_live_markdown(self):
        draft = self.store.get(self.draft['id'])
        content = f'# API alias\n![figure](/api/editor/drafts/{draft["id"]}/assets/images/derived.png)\n'
        self.store.save(draft['id'], content, draft['metadata'], draft['revision'])
        package = self.exported()
        self.assertNotIn('/api/editor/drafts/', members(package)['article.md'].decode())
        prepared = prepare_import('portable.zip', package)
        self.assertIn('images/' + sha(DERIVED) + '.png', prepared['content'])
        self.assertEqual(self.store.get(draft['id'])['content'], content)

    def test_package_import_preserves_original_import_provenance_in_metadata(self):
        original = {'imported_at': '2025-01-01T00:00:00+00:00', 'import_kind': 'docx', 'import_fingerprint': 'c' * 64}
        package = edit_package(self.exported(), metadata=lambda value: value.update(original))
        prepared = prepare_import('portable.zip', package)
        for field, value in original.items():
            self.assertEqual(prepared['metadata'][field], value)
        self.assertEqual(prepared['source_original']['kind'], 'zip')

    def test_package_missing_or_corrupt_manifest_metadata_and_hashes_are_blocked(self):
        package = self.exported()
        cases = [
            edit_package(package, drop=['metadata.json']),
            edit_package(package, drop=['manifest.json']),
            edit_package(package, extra={'manifest.json': b'{broken-json'}),
            edit_package(package, extra={'metadata.json': b'{broken-json'}),
            edit_package(package, manifest=lambda value: value.update(format=2)),
            edit_package(package, manifest=lambda value: value.update(content_sha256='0' * 64)),
            edit_package(package, extra={'images/original.png': DERIVED}),
            edit_package(package, drop=['cover.png']),
            edit_package(package, extra={'account.json': b'{"access_token":"synthetic-secret"}'}),
        ]
        for index, broken in enumerate(cases):
            with self.subTest(case=index):
                with self.assertRaises(ArticleImportError) as caught:
                    prepare_import('broken.zip', broken)
                self.assertEqual(caught.exception.report['status'], 'blocked')

    def test_metadata_path_traversal_oversize_known_object_fields_and_nan_are_blocked(self):
        package = self.exported()
        changes = [
            lambda value: value.update(cover='../outside.png'),
            lambda value: value.update(cover='images/%2e%2e/outside.png'),
            lambda value: value.update(title={'secret': 'should not stringify'}),
            lambda value: value.update(font_size={'value': 18}),
            lambda value: value['experiment_conditions'].update(hardware={'secret': 'should not stringify'}),
            lambda value: value['block_overrides'][self.block_id].update(line_height=float('nan')),
        ]
        for index, change in enumerate(changes):
            with self.subTest(case=index), self.assertRaises(ArticleImportError):
                prepare_import('bad-metadata.zip', edit_package(package, metadata=change))
        oversized = json.dumps({'title': 'x' * (256 * 1024 + 1)}).encode()
        with self.assertRaises(ArticleImportError):
            prepare_import('big-metadata.zip', edit_package(package, extra={'metadata.json': oversized}))

    def test_relation_hash_and_source_path_tampering_cannot_rebind_to_another_original(self):
        package = self.exported()
        for change in [
            lambda value: value['asset_relations']['images/derived.png'].update(source_path='../outside.png'),
            lambda value: value['asset_relations']['images/derived.png'].update(source_hash=sha(COVER)),
            lambda value: value['asset_relations']['images/derived.png'].update(derived_hash=sha(COVER)),
        ]:
            with self.assertRaises(ArticleImportError):
                prepare_import('changed-relation.zip', edit_package(package, manifest=change))

    def test_legacy_format1_package_without_derivation_map_still_restores_cover_and_settings(self):
        package = edit_package(self.exported(), manifest=lambda value: value.pop('asset_relations', None))
        prepared = prepare_import('legacy-package.zip', package)
        self.assertEqual(prepared['metadata']['theme'], 'obsidian')
        self.assertEqual(prepared['metadata']['cover'], 'images/' + sha(COVER) + '.png')
        self.assertEqual(len(prepared['assets']), 3)


if __name__ == '__main__':
    unittest.main()
