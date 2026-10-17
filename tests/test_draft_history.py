"""History uses synthetic drafts only; no account or network access."""
import concurrent.futures
import copy
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app/web"))
try:
    from draft_history import DraftHistory
except ModuleNotFoundError as exc:
    if exc.name != "draft_history":
        raise
    DraftHistory = None


DRAFT_ID = "draft-20000101-1234abcd"


class DraftHistoryTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(DraftHistory, "DraftHistory implementation is missing")
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.folder = self.base / "drafts" / DRAFT_ID
        (self.folder / "images/nested").mkdir(parents=True)
        (self.folder / "images/nested/图.png").write_bytes(b"original-image")
        (self.folder / "cover.png").write_bytes(b"original-image")
        self.draft = {
            "id": DRAFT_ID, "content": "# 初稿\n\n![图](images/nested/图.png)",
            "metadata": {"title": "初稿", "cover": "cover.png", "font_size": 17},
            "revision": "revision-one", "source_name": "source.md",
            "created_at": "2026-10-18T00:00:00+00:00", "updated_at": "2026-10-18T01:00:00+00:00",
            "publish": {"access_token": "never-snapshot-publish-state"},
        }
        (self.folder / "article.md").write_text(self.draft["content"], encoding="utf-8")
        (self.folder / "draft.json").write_text(json.dumps(self.draft), encoding="utf-8")
        self.history = DraftHistory(self.base / "history")

    def capture(self):
        return self.history.capture(self.draft, self.folder, "manual-save")

    def test_snapshot_restores_original_text_metadata_and_all_assets(self):
        summary = self.capture()
        self.draft["metadata"]["title"] = "changed"
        (self.folder / "cover.png").write_bytes(b"changed")
        snapshot = self.history.read(DRAFT_ID, summary["snapshot_id"])
        self.assertEqual(snapshot["content"], "# 初稿\n\n![图](images/nested/图.png)")
        self.assertEqual(snapshot["metadata"], {"title": "初稿", "cover": "cover.png", "font_size": 17})
        self.assertNotIn("publish", snapshot)
        self.assertEqual(len(snapshot["manifest"]["assets"]), 2)
        restored = self.base / "restored"
        self.history.restore_assets(snapshot, restored)
        self.assertEqual((restored / "cover.png").read_bytes(), b"original-image")
        self.assertEqual((restored / "images/nested/图.png").read_bytes(), b"original-image")
        self.assertEqual(self.history.list(DRAFT_ID), [summary])
        objects = list((self.history.root / "objects").glob("*/*"))
        self.assertEqual(len(objects), 1, "identical cover/image bytes must share an object")

    def test_corrupt_asset_object_blocks_restore_before_any_output(self):
        summary = self.capture()
        snapshot = self.history.read(DRAFT_ID, summary["snapshot_id"])
        next((self.history.root / "objects").glob("*/*")).write_bytes(b"corrupt")
        destination = self.base / "restored"
        with self.assertRaises(ValueError):
            self.history.restore_assets(snapshot, destination)
        self.assertFalse(destination.exists())

    def test_corrupt_snapshot_cannot_silently_change_text_or_metadata(self):
        summary = self.capture()
        snapshot_path = next((self.history.root / "snapshots" / DRAFT_ID).glob("*.json"))
        envelope = json.loads(snapshot_path.read_text("utf-8"))
        envelope["snapshot"]["content"] = "tampered"
        snapshot_path.write_text(json.dumps(envelope), encoding="utf-8")
        with self.assertRaises(ValueError):
            self.history.read(DRAFT_ID, summary["snapshot_id"])

    def test_restore_rejects_path_traversal_and_preserves_existing_assets(self):
        summary = self.capture()
        snapshot = self.history.read(DRAFT_ID, summary["snapshot_id"])
        for bad_path in ("../outside.png", "images/../../outside.png", "images\\..\\outside.png", "C:/outside.png", "images/CON.png"):
            changed = copy.deepcopy(snapshot)
            changed["manifest"]["assets"][0]["path"] = bad_path
            with self.subTest(path=bad_path), self.assertRaises(ValueError):
                self.history.restore_assets(changed, self.base / "restored")
        with self.assertRaises(FileExistsError):
            self.history.restore_assets(snapshot, self.folder)
        self.assertEqual((self.folder / "cover.png").read_bytes(), b"original-image")
        self.assertFalse((self.base / "outside.png").exists())

    def test_invalid_ids_and_overlapping_history_and_live_folder_are_rejected(self):
        for invalid in ("../drafts", "", DRAFT_ID + "/../other", "draft-bad"):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                self.history.list(invalid)
        for invalid in ("../snapshot", "", "C:/snapshot"):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                self.history.read(DRAFT_ID, invalid)
        nested = DraftHistory(self.folder / "history")
        with self.assertRaises(ValueError):
            nested.capture(self.draft, self.folder, "save")

    def test_concurrent_instances_preserve_all_snapshots_and_share_asset_objects(self):
        def capture(index):
            return DraftHistory(self.history.root).capture(self.draft, self.folder, f"save-{index}")
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            summaries = list(pool.map(capture, range(20)))
        self.assertEqual(len({item["snapshot_id"] for item in summaries}), 20)
        self.assertEqual(len(self.history.list(DRAFT_ID)), 20)
        self.assertEqual(len(list((self.history.root / "objects").glob("*/*"))), 1)

    def test_failed_snapshot_install_does_not_expose_partial_history(self):
        with patch("draft_history.os.link", side_effect=OSError("simulated disk failure")):
            with self.assertRaises(OSError):
                self.capture()
        self.assertEqual(self.history.list(DRAFT_ID), [])
        self.assertEqual((self.folder / "cover.png").read_bytes(), b"original-image")

    def test_failed_final_snapshot_write_preserves_previous_history(self):
        previous = self.capture()
        with patch("draft_history.os.link", side_effect=OSError("simulated final snapshot failure")):
            with self.assertRaises(OSError):
                self.capture()
        self.assertEqual(self.history.list(DRAFT_ID), [previous])
        self.assertEqual(self.history.read(DRAFT_ID, previous["snapshot_id"])["content"], self.draft["content"])

    def test_failed_second_asset_write_rolls_back_only_new_assets(self):
        snapshot = self.history.read(DRAFT_ID, self.capture()["snapshot_id"])
        destination = self.base / "restore"
        destination.mkdir()
        (destination / "article.md").write_bytes(b"keep caller text")
        real_link = os.link
        count = 0

        def fail_second_link(source, target):
            nonlocal count
            count += 1
            if count == 2:
                raise OSError("simulated full disk on second image")
            return real_link(source, target)

        with patch("draft_history.os.link", side_effect=fail_second_link):
            with self.assertRaises(OSError):
                self.history.restore_assets(snapshot, destination)
        self.assertEqual([p.relative_to(destination).as_posix() for p in destination.rglob("*") if p.is_file()], ["article.md"])
        self.assertEqual((destination / "article.md").read_bytes(), b"keep caller text")

    def test_processes_publish_complete_independent_snapshots(self):
        script = (
            "import json,sys;from pathlib import Path;"
            "sys.path.insert(0,sys.argv[1]);from draft_history import DraftHistory;"
            "draft=json.loads(Path(sys.argv[3],'draft.json').read_text('utf-8'));"
            "DraftHistory(Path(sys.argv[2])).capture(draft,Path(sys.argv[3]),'process-save')"
        )

        def run(_):
            return subprocess.run([
                sys.executable, "-X", "utf8", "-c", script,
                str(Path(__file__).resolve().parents[1] / "app/web"),
                str(self.history.root), str(self.folder),
            ], capture_output=True, text=True, timeout=30)

        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            results = list(pool.map(run, range(6)))
        for result in results:
            self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.history.list(DRAFT_ID)), 6)
        self.assertEqual(len(list((self.history.root / "objects").glob("*/*"))), 1)

    def test_trash_preserves_entire_draft_and_restores_without_overwrite(self):
        (self.folder / "publish-state.json").write_bytes(b'{"media_id":"local-state"}')
        record = self.history.trash(DRAFT_ID, self.folder)
        self.assertFalse(self.folder.exists())
        self.assertEqual(record["retention_days"], 30)
        self.assertFalse(record["automatic_delete"])
        self.assertEqual(self.history.list_trash(), [record])
        self.folder.mkdir()
        (self.folder / "article.md").write_bytes(b"newer draft")
        with self.assertRaises(FileExistsError):
            self.history.restore_trash(record["trash_id"], self.folder.parent)
        self.assertEqual((self.folder / "article.md").read_bytes(), b"newer draft")
        destination = self.base / "restored-drafts"
        self.assertEqual(self.history.restore_trash(record["trash_id"], destination), DRAFT_ID)
        self.assertEqual((destination / DRAFT_ID / "publish-state.json").read_bytes(), b'{"media_id":"local-state"}')
        self.assertEqual((destination / DRAFT_ID / "cover.png").read_bytes(), b"original-image")
        self.assertEqual(self.history.list_trash(), [])

    def test_failed_trash_move_leaves_live_draft_recoverable(self):
        with patch("draft_history.os.rename", side_effect=OSError("simulated denied move")):
            with self.assertRaises(OSError):
                self.history.trash(DRAFT_ID, self.folder)
        self.assertTrue((self.folder / "article.md").exists())
        self.assertEqual(self.history.list_trash(), [])

    def test_capture_and_restore_reject_symlinked_assets(self):
        external = self.base / "external"
        external.mkdir()
        (external / "secret.png").write_bytes(b"private")
        linked = self.folder / "images/linked"
        self.make_directory_link(linked, external)
        with self.assertRaises(ValueError):
            self.capture()
        with self.assertRaises(ValueError):
            self.history.trash(DRAFT_ID, self.folder)
        if linked.is_junction():
            linked.rmdir()
        else:
            linked.unlink()
        snapshot = self.history.read(DRAFT_ID, self.capture()["snapshot_id"])
        restored = self.base / "restored"
        restored.mkdir()
        self.make_directory_link(restored / "images", external)
        with self.assertRaises(ValueError):
            self.history.restore_assets(snapshot, restored)
        self.assertEqual(list(external.iterdir()), [external / "secret.png"])

    def relation_map(self):
        digest = hashlib.sha256(b'original-image').hexdigest()
        return {'cover.png': {'source_path': 'images/nested/图.png', 'source_hash': digest,
                              'derived_hash': digest, 'mode': 'diagram', 'operations': [{'operation': 'lossless-png'}]}}

    def test_future_snapshots_capture_sanitized_relations_and_restore_private_sidecar(self):
        mapping = self.relation_map()
        mapping['cover.png']['access_token'] = 'synthetic-private-value'
        (self.folder / '.asset-relations.json').write_text(json.dumps(mapping), encoding='utf-8')
        snapshot = self.history.read(DRAFT_ID, self.capture()['snapshot_id'])
        self.assertEqual(snapshot['manifest']['asset_relations'], self.relation_map())
        target = self.base / 'restored-relations'
        self.history.restore_assets(snapshot, target)
        self.assertEqual(json.loads((target / '.asset-relations.json').read_text('utf-8')), self.relation_map())
        self.assertEqual((target / 'cover.png').read_bytes(), b'original-image')

    def test_bad_relations_reject_capture_and_authenticated_snapshot_rebinding(self):
        mapping = self.relation_map()
        mapping['cover.png']['source_hash'] = '0' * 64
        (self.folder / '.asset-relations.json').write_text(json.dumps(mapping), encoding='utf-8')
        with self.assertRaises(ValueError):
            self.capture()
        self.assertEqual(self.history.list(DRAFT_ID), [])
        (self.folder / '.asset-relations.json').write_text(json.dumps(self.relation_map()), encoding='utf-8')
        summary = self.capture()
        record_path = self.history.root / 'snapshots' / DRAFT_ID / (summary['snapshot_id'] + '.json')
        envelope = json.loads(record_path.read_text('utf-8'))
        envelope['snapshot']['manifest']['asset_relations']['cover.png']['source_path'] = 'images/missing.png'
        serialized = json.dumps(envelope['snapshot'], ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()
        envelope['sha256'] = hashlib.sha256(serialized).hexdigest()
        record_path.write_text(json.dumps(envelope), encoding='utf-8')
        with self.assertRaises(ValueError):
            self.history.read(DRAFT_ID, summary['snapshot_id'])

    def make_directory_link(self, link, target):
        try:
            link.symlink_to(target, target_is_directory=True)
        except OSError:
            if os.name != "nt":
                raise
            result = subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(target)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)


class TrashPurgeTests(unittest.TestCase):
    """Permanent removal operates only on explicitly confirmed synthetic trash."""
    capture = DraftHistoryTests.capture
    make_directory_link = DraftHistoryTests.make_directory_link

    def setUp(self):
        DraftHistoryTests.setUp(self)
        self.assertTrue(callable(getattr(self.history, 'purge_trash', None)), 'Confirmed per-item trash purge is missing')

    def prepare_trash(self):
        record = self.history.trash(DRAFT_ID, self.folder)
        return record, self.history.root / 'trash' / record['trash_id']

    def remove_link(self, path):
        if path.is_junction():
            path.rmdir()
        else:
            path.unlink()

    def start_contender(self, action, trash_id, destination):
        ready = self.base / ('ready-' + action)
        script = '''import json,sys
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from draft_history import DraftHistory
history=DraftHistory(Path(sys.argv[2]))
Path(sys.argv[6]).write_text('ready')
try:
    if sys.argv[3]=='restore':
        history.restore_trash(sys.argv[4],Path(sys.argv[5]))
    else:
        history.purge_trash(sys.argv[4],sys.argv[4])
    print(json.dumps({'status':'success'}))
except FileNotFoundError:
    print(json.dumps({'status':'missing'}))
'''
        process = subprocess.Popen([sys.executable, '-X', 'utf8', '-c', script,
                                    str(Path(__file__).resolve().parents[1] / 'app/web'), str(self.history.root),
                                    action, trash_id, str(destination), str(ready)], stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, text=True)
        def cleanup():
            if process.poll() is None:
                process.kill()
            process.communicate(timeout=5)
        self.addCleanup(cleanup)
        deadline = time.monotonic() + 10
        while not ready.is_file() and time.monotonic() < deadline:
            if process.poll() is not None:
                self.fail('Contender exited before attempting history operation: ' + process.communicate()[1])
            time.sleep(.01)
        self.assertTrue(ready.is_file(), 'Contender did not reach the locked operation')
        return process

    def test_exact_confirmation_deletes_one_record_and_keeps_objects_snapshots_and_other_drafts(self):
        snapshot = self.capture()
        record, entry = self.prepare_trash()
        self.folder.mkdir()
        (self.folder / 'article.md').write_bytes(b'new unrelated live content')
        other_trash = self.history.trash(DRAFT_ID, self.folder)
        self.folder.mkdir()
        (self.folder / 'article.md').write_bytes(b'newest live content')
        envelope_path = entry / 'record.json'
        envelope = json.loads(envelope_path.read_text('utf-8'))
        # These hostile extra fields must never select a deletion destination.
        envelope['original_path'] = str(self.folder)
        envelope['payload_path'] = str(self.history.root / 'trash' / other_trash['trash_id'])
        envelope_path.write_text(json.dumps(envelope), encoding='utf-8')
        protected = {path: path.read_bytes() for path in self.history.root.rglob('*')
                     if path.is_file() and not path.is_relative_to(entry) and path.name != '.lock'}
        self.assertIsNone(self.history.purge_trash(record['trash_id'], record['trash_id']))
        self.assertFalse(entry.exists())
        self.assertEqual(self.history.list_trash(), [other_trash])
        self.assertEqual((self.folder / 'article.md').read_bytes(), b'newest live content')
        self.assertEqual(self.history.read(DRAFT_ID, snapshot['snapshot_id'])['content'], self.draft['content'])
        for path, original in protected.items():
            self.assertEqual(path.read_bytes(), original)

    def test_missing_wrong_confirmation_and_unsafe_identifiers_change_nothing(self):
        record, entry = self.prepare_trash()
        original = {path: path.read_bytes() for path in entry.rglob('*') if path.is_file()}
        for confirmation in ['', None, False, record['trash_id'].upper(), record['trash_id'] + ' ']:
            with self.subTest(confirmation=confirmation), self.assertRaises(ValueError):
                self.history.purge_trash(record['trash_id'], confirmation)
        with self.assertRaises(ValueError):
            self.history.purge_trash(record['trash_id'])
        for value in ['../outside', '', record['trash_id'] + '/../other', 'C:/outside', 'trash-' + 'g' * 32]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.history.purge_trash(value, value)
        missing = 'trash-' + '0' * 32
        with self.assertRaises(FileNotFoundError):
            self.history.purge_trash(missing, missing)
        for path, expected in original.items():
            self.assertEqual(path.read_bytes(), expected)

    def test_links_in_record_root_payload_root_or_descendants_are_rejected_before_any_delete(self):
        record, entry = self.prepare_trash()
        external = self.base / 'external'
        external.mkdir()
        (external / 'secret.txt').write_bytes(b'keep unrelated file')
        for location in ['descendant', 'payload', 'record']:
            with self.subTest(location=location):
                if location == 'descendant':
                    linked = entry / 'draft/images/linked'
                    holding = None
                else:
                    linked = entry / 'draft' if location == 'payload' else entry
                    holding = self.base / ('holding-' + location)
                    linked.rename(holding)
                try:
                    self.make_directory_link(linked, external)
                    with self.assertRaises(ValueError):
                        self.history.purge_trash(record['trash_id'], record['trash_id'])
                    self.assertEqual((external / 'secret.txt').read_bytes(), b'keep unrelated file')
                finally:
                    if linked.is_symlink() or linked.is_junction():
                        self.remove_link(linked)
                    if holding is not None:
                        holding.rename(linked)
        self.assertEqual((entry / 'draft/article.md').read_text('utf-8'), self.draft['content'])

    def test_corrupt_record_and_restored_record_cannot_select_a_live_deletion(self):
        record, entry = self.prepare_trash()
        original = (entry / 'record.json').read_bytes()
        corrupted = {**record, 'trash_id': 'trash-' + '0' * 32}
        (entry / 'record.json').write_text(json.dumps(corrupted), encoding='utf-8')
        with self.assertRaises(ValueError):
            self.history.purge_trash(record['trash_id'], record['trash_id'])
        (entry / 'record.json').write_bytes(original)
        self.history.restore_trash(record['trash_id'], self.folder.parent)
        with self.assertRaises(FileNotFoundError):
            self.history.purge_trash(record['trash_id'], record['trash_id'])
        self.assertTrue((entry / 'record.json').is_file())
        self.assertEqual((self.folder / 'article.md').read_text('utf-8'), self.draft['content'])

    def test_io_failure_surfaces_keeps_record_and_does_not_claim_cleanup_success(self):
        record, entry = self.prepare_trash()
        original_unlink = Path.unlink
        def denied(path, *args, **kwargs):
            if path.is_relative_to(entry):
                raise OSError('simulated denied permanent removal')
            return original_unlink(path, *args, **kwargs)
        with patch.object(Path, 'unlink', new=denied), self.assertRaises(OSError):
            self.history.purge_trash(record['trash_id'], record['trash_id'])
        self.assertEqual(self.history.list_trash(), [record])
        self.assertEqual((entry / 'draft/article.md').read_text('utf-8'), self.draft['content'])
        self.history.purge_trash(record['trash_id'], record['trash_id'])
        self.assertFalse(entry.exists())

    def test_restore_holds_process_lock_and_later_purge_cannot_delete_restored_draft(self):
        import draft_history
        record, entry = self.prepare_trash()
        entered, release = threading.Event(), threading.Event()
        rename = draft_history._rename_no_replace
        def held_rename(source, target):
            if source == entry / 'draft':
                entered.set()
                if not release.wait(15):
                    raise TimeoutError('Synthetic restore gate expired')
            return rename(source, target)
        with patch('draft_history._rename_no_replace', side_effect=held_rename), concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            restoring = pool.submit(self.history.restore_trash, record['trash_id'], self.folder.parent)
            try:
                self.assertTrue(entered.wait(5))
                contender = self.start_contender('purge', record['trash_id'], self.folder.parent)
                with self.assertRaises(subprocess.TimeoutExpired):
                    contender.wait(timeout=.2)
            finally:
                release.set()
            self.assertEqual(restoring.result(timeout=5), DRAFT_ID)
            stdout, stderr = contender.communicate(timeout=10)
            self.assertEqual(contender.returncode, 0, stderr)
            self.assertEqual(json.loads(stdout)['status'], 'missing')
        self.assertEqual((self.folder / 'article.md').read_text('utf-8'), self.draft['content'])

    def test_purge_holds_process_lock_and_later_restore_fails_without_a_live_folder(self):
        record, entry = self.prepare_trash()
        entered, release = threading.Event(), threading.Event()
        original_unlink = Path.unlink
        def held_unlink(path, *args, **kwargs):
            if path.is_relative_to(entry) and not entered.is_set():
                entered.set()
                if not release.wait(15):
                    raise TimeoutError('Synthetic purge gate expired')
            return original_unlink(path, *args, **kwargs)
        with patch.object(Path, 'unlink', new=held_unlink), concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            purging = pool.submit(self.history.purge_trash, record['trash_id'], record['trash_id'])
            try:
                self.assertTrue(entered.wait(5))
                contender = self.start_contender('restore', record['trash_id'], self.folder.parent)
                with self.assertRaises(subprocess.TimeoutExpired):
                    contender.wait(timeout=.2)
            finally:
                release.set()
            self.assertIsNone(purging.result(timeout=5))
            stdout, stderr = contender.communicate(timeout=10)
            self.assertEqual(contender.returncode, 0, stderr)
            self.assertEqual(json.loads(stdout)['status'], 'missing')
        self.assertFalse(entry.exists())
        self.assertFalse(self.folder.exists())


if __name__ == "__main__":
    unittest.main()
