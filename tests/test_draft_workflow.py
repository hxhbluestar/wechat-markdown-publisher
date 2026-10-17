import base64
import json
import hashlib
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'app' / 'web'))
import editor_service
from editor_service import DraftStore, RevisionConflict

PNG=base64.b64encode(b'\x89PNG\r\n\x1a\nfixture').decode()

class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.store=DraftStore(Path(self.tmp.name)/'drafts')
        self.addCleanup(self.tmp.cleanup)

    def test_save_history_restore_copy_and_soft_delete_retain_assets(self):
        first=self.store.create('# Original')
        self.store.save_asset(first['id'],'images/one.png',PNG)
        second=self.store.save(first['id'],'# Changed',first['metadata'],first['revision'])
        versions=self.store.history.list(first['id'])
        original=next(v for v in versions if self.store.history.read(first['id'],v['snapshot_id'])['content']=='# Original')
        restored=self.store.restore_version(first['id'],original['snapshot_id'],second['revision'])
        self.assertNotEqual(restored['id'],first['id'])
        self.assertEqual(restored['content'],'# Original')
        self.assertEqual(self.store.asset_path(restored['id'],'images/one.png').read_bytes(),base64.b64decode(PNG))
        self.assertEqual(restored['publish'],{})
        self.store.delete(first['id'])
        self.assertFalse((self.store.root/first['id']).exists())
        trash=self.store.history.list_trash()[0]
        self.store.history.restore_trash(trash['trash_id'],self.store.root)
        self.assertEqual(self.store.get(first['id'])['content'],'# Changed')

    def test_stale_restore_does_not_overwrite_current(self):
        d=self.store.create('# Start')
        saved=self.store.save(d['id'],'# Next',d['metadata'],d['revision'])
        version=self.store.history.list(d['id'])[0]
        with self.assertRaises(RevisionConflict):
            self.store.restore_version(d['id'],version['snapshot_id'],d['revision'])
        self.assertEqual(self.store.get(d['id'])['revision'],saved['revision'])

    def test_partial_save_failure_restores_coherent_original(self):
        d=self.store.create('# Start')
        real=editor_service.atomic_json
        def fail_once(path,data):
            if path.name=='draft.json' and data.get('metadata',{}).get('title')=='New':
                raise OSError('disk full')
            return real(path,data)
        with patch.object(editor_service,'atomic_json',side_effect=fail_once):
            with self.assertRaises(OSError):
                self.store.save(d['id'],'# New',{**d['metadata'],'title':'New'},d['revision'])
        self.assertEqual(self.store.get(d['id'])['revision'],d['revision'])

    def test_interrupted_commit_recovers_on_restart(self):
        d=self.store.create('# Start')
        real=editor_service.atomic_json
        class PowerLoss(BaseException):pass
        def power_loss(path,data):
            if path.name=='draft.json':raise PowerLoss()
            return real(path,data)
        with patch.object(editor_service,'atomic_json',side_effect=power_loss):
            with self.assertRaises(PowerLoss):
                self.store.save(d['id'],'# Durable',{**d['metadata'],'title':'Durable'},d['revision'])
        restarted=DraftStore(self.store.root)
        recovered=restarted.get(d['id'])
        self.assertEqual(recovered['content'],'# Durable')
        self.assertEqual(recovered['metadata']['title'],'Durable')

    def test_failed_prepared_history_leaves_no_half_import(self):
        with patch.object(self.store.history,'capture',side_effect=OSError('history disk full')):
            with self.assertRaises(OSError):self.store.create_prepared('# New',{'title':'New'})
        self.assertEqual(self.store.list(),[])

    def portable_assets(self):
        from test_asset_sync import PNG_BYTES
        from asset_workbench import derive_image
        derivative = derive_image(PNG_BYTES, 'diagram')
        assets = [{'name': 'images/original.png', 'bytes': PNG_BYTES},
                  {'name': 'images/derived.png', 'bytes': derivative['bytes']}]
        relation = {**derivative['metadata'], 'source_path': 'images/original.png'}
        return assets, {'images/derived.png': relation}

    def test_portable_relation_accepts_real_static_inspection_without_a_loop(self):
        from article_package import safe_asset_relation
        assets, mapping = self.portable_assets()
        clean = safe_asset_relation(mapping['images/derived.png'])
        self.assertEqual(clean['source']['sha256'], hashlib.sha256(assets[0]['bytes']).hexdigest())
        self.assertNotIn('loop', clean['source'])

    def test_prepared_relations_are_private_and_present_before_history_and_visibility(self):
        from asset_service import relations
        assets, mapping = self.portable_assets()
        mapping['images/derived.png']['source']['access_token'] = 'synthetic-nested-private-token'
        mapping['images/derived.png']['cookie'] = 'synthetic-private-cookie'
        original_capture = self.store.history.capture
        observed = []
        def capture(candidate, folder, reason):
            observed.append(json.loads((folder / '.asset-relations.json').read_text('utf-8')))
            self.assertFalse((self.store.root / candidate['id']).exists())
            return original_capture(candidate, folder, reason)
        with patch.object(self.store.history, 'capture', side_effect=capture):
            draft = self.store.create_prepared('# Relations\n![图](images/derived.png)',
                                               {'title': 'Relations', 'cover': 'images/original.png'},
                                               assets=assets, asset_relations=mapping)
        saved = relations(self.store, draft['id'])
        self.assertEqual(observed, [saved])
        self.assertNotIn('synthetic-nested-private-token', json.dumps(saved))
        self.assertNotIn('synthetic-private-cookie', json.dumps(saved))
        self.assertEqual(saved['images/derived.png']['source_path'], 'images/original.png')
        version = self.store.history.list(draft['id'])[0]
        snapshot = self.store.history.read(draft['id'], version['snapshot_id'])
        self.assertEqual(snapshot['manifest']['asset_relations'], saved)
        self.assertNotIn('asset_relations', draft['metadata'])

    def test_relations_survive_history_copy_and_package_import_without_late_side_effects(self):
        from article_package import article_package
        from article_import import prepare_import
        from asset_service import relations
        assets, mapping = self.portable_assets()
        draft = self.store.create_prepared('# Relations\n![图](images/derived.png)', {'title': 'Relations'},
                                           assets=assets, asset_relations=mapping)
        version = self.store.history.list(draft['id'])[0]
        original = relations(self.store, draft['id'])
        saved = self.store.save(draft['id'], '# Later text', draft['metadata'], draft['revision'])
        restored = self.store.restore_version(draft['id'], version['snapshot_id'], saved['revision'])
        self.assertEqual(relations(self.store, restored['id']), original)
        copied = self.store.copy_draft(draft['id'], '# Conflict copy', saved['metadata'])
        self.assertEqual(relations(self.store, copied['id']), original)
        prepared = prepare_import('roundtrip.zip', article_package(self.store, restored['id']))
        imported = self.store.create_prepared(prepared['content'], prepared['metadata'], assets=prepared['assets'],
                                              asset_relations=prepared['asset_relations'])
        remapped = relations(self.store, imported['id'])
        self.assertEqual(remapped, prepared['asset_relations'])
        for path, relation in remapped.items():
            self.assertEqual(hashlib.sha256(self.store.asset_path(imported['id'], path).read_bytes()).hexdigest(), relation['derived_hash'])
            self.assertEqual(hashlib.sha256(self.store.asset_path(imported['id'], relation['source_path']).read_bytes()).hexdigest(), relation['source_hash'])

    def test_bad_prepared_relations_and_sidecar_write_failure_leave_no_new_draft(self):
        import copy
        assets, mapping = self.portable_assets()
        variants = []
        for key, value in [('source_path', '../outside.png'), ('source_path', 'images/missing.png'),
                           ('source_hash', '0' * 64), ('derived_hash', '0' * 64)]:
            invalid = copy.deepcopy(mapping)
            invalid['images/derived.png'][key] = value
            variants.append(invalid)
        variants.extend([[], {'images/missing.png': {}}])
        for invalid in variants:
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                self.store.create_prepared('# Invalid relation', {'title': 'Invalid'}, assets=assets, asset_relations=invalid)
            self.assertEqual(list(self.store.root.iterdir()), [])
        real_write = editor_service.atomic_write
        def denied(path, data):
            if path.name == '.asset-relations.json':
                raise OSError('synthetic relation sidecar failure')
            return real_write(path, data)
        with patch.object(editor_service, 'atomic_write', side_effect=denied), self.assertRaises(OSError):
            self.store.create_prepared('# No partial import', {'title': 'No partial import'}, assets=assets, asset_relations=mapping)
        self.assertEqual(list(self.store.root.iterdir()), [])

    def test_old_prepared_defaults_keep_snapshot_and_sidecar_absent(self):
        draft = self.store.create_prepared('# Old semantics', {'title': 'Old semantics'})
        version = self.store.history.list(draft['id'])[0]
        self.assertNotIn('asset_relations', self.store.history.read(draft['id'], version['snapshot_id'])['manifest'])
        self.assertFalse((self.store._draft_dir(draft['id']) / '.asset-relations.json').exists())

if __name__=='__main__':unittest.main()
