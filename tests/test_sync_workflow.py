"""Frozen local sync orchestration, with a fake remote publisher only."""
import base64
import copy
import hashlib
import io
import json
import re
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'app/web'))
from editor_service import DraftStore, EditorError, RevisionConflict, TYPOGRAPHY_VALUES, WechatPublisher
from article_package import RENDER_VERSION, article_package
from article_import import prepare_import
from asset_service import derive_asset
from server_preflight import preflight_article
from sync_jobs import SyncJobs, DefinitiveSyncFailure
try:
    from sync_workflow import SyncWorkflow, normalized_remote_article, article_comparison
except ModuleNotFoundError as exc:
    if exc.name != 'sync_workflow':
        raise
    SyncWorkflow = None

ACCOUNT = 'account-123456789abc'


def png(color):
    output = io.BytesIO()
    Image.new('RGB', (12, 8), color).save(output, format='PNG')
    return output.getvalue()


class ContractStore(DraftStore):
    """Use root's account-scoped getter once available; model its declared API meanwhile."""
    def get_publish_state(self, draft_id, account_id):
        parent = getattr(super(), 'get_publish_state', None)
        if parent:
            return parent(draft_id, account_id)
        state = self.get(draft_id)['publish']
        return copy.deepcopy(state) if state.get('account_id') in ('', None, account_id) else {}


class FakePublisher:
    def __init__(self):
        self.entered = threading.Event()
        self.release = threading.Event()
        self.release.set()
        self.calls = []
        self.observed = []
        self.fail_once = False
        self.remote = {'news_item': [{'title': 'Article', 'content': '<p>Remote body</p>'}]}
        self.api = self

    def get_draft(self, media_id):
        return copy.deepcopy(self.remote)

    def sync(self, store, draft_id, html, source_hash, theme, palette, *, typography, context, remote_action, expected_remote_hash):
        self.calls.append({'store': store, 'id': draft_id, 'html': html, 'hash': source_hash,
                           'remote_action': remote_action, 'expected_remote_hash': expected_remote_hash,
                           'checkpoint': context.checkpoint_state})
        self.entered.set()
        if not self.release.wait(5):
            raise RuntimeError('test worker gate timed out')
        draft = store.get(draft_id)
        data = {entry['path']: store.asset_path(draft_id, entry['path']).read_bytes() for entry in store.list_assets(draft_id)}
        self.observed.append({'draft': draft, 'assets': data})
        context.emit('images', completed=1, total=len(data))
        context.checkpoint(image_cache={hashlib.sha256(next(iter(data.values()))).hexdigest(): 'https://example.invalid/uploaded.png'})
        if self.fail_once:
            self.fail_once = False
            raise DefinitiveSyncFailure('asset-failed')
        context.emit('remote-write', operation='create')
        context.checkpoint(media_id='synthetic-media', remote_write_confirmed=True)
        context.emit('verify', completed=1, total=1)
        context.checkpoint(remote_verified=True)
        # This intentionally returns the live edited draft, to catch result leakage.
        saved = store.save_publish_state(draft_id, {'account_id': ACCOUNT, 'media_id': 'synthetic-media', 'draft_revision': draft['revision'], 'publish_status': 'draft_synced'})
        return saved, True


class FakeAccounts:
    def __init__(self, publisher):
        self.fake = publisher
        self.lookups = []

    def get(self, account_id):
        if account_id != ACCOUNT:
            raise EditorError('Unknown synthetic account', 404)
        return {'id': ACCOUNT, 'app_secret': 'transport-secret-must-never-be-copied'}

    def publisher(self, account_id):
        self.get(account_id)
        self.lookups.append(account_id)
        return self.fake


class SyncWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(SyncWorkflow, 'SyncWorkflow implementation is missing')
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.store = ContractStore(self.root / 'drafts')
        self.draft = self.store.create('# Article\n\nOriginal body')
        self.put('cover.png', png('blue'))
        metadata = {**self.draft['metadata'], 'cover': 'cover.png', 'source_url': 'https://example.invalid/article', 'wechat_account_id': ACCOUNT}
        self.draft = self.store.save(self.draft['id'], self.draft['content'], metadata, self.draft['revision'])
        self.jobs = SyncJobs(self.root / 'jobs')
        self.publisher = FakePublisher()
        self.addCleanup(self.publisher.release.set)
        self.accounts = FakeAccounts(self.publisher)
        self.workflow = SyncWorkflow(self.store, self.jobs, self.accounts)
        self.addCleanup(self.finish_workers)

    def finish_workers(self):
        self.publisher.release.set()
        for job in self.jobs.list():
            if job['state'] in {'queued', 'running'}:
                self.jobs.wait_for(job['id'], timeout=5)

    def put(self, relative, data):
        return self.store.save_asset(self.draft['id'], relative, base64.b64encode(data).decode())

    def payload(self, html='<h1>Article</h1><p>Original body</p>'):
        draft = self.store.get(self.draft['id'])
        report = preflight_article(self.store, draft, html, RENDER_VERSION, ACCOUNT)
        return {'source_hash': hashlib.sha256(draft['content'].encode()).hexdigest(), 'revision': draft['revision'],
                'html': html, 'render_version': RENDER_VERSION, 'account_id': ACCOUNT,
                'theme': draft['metadata']['theme'], 'palette': draft['metadata']['palette'],
                'typography': {key: draft['metadata'][key] for key in TYPOGRAPHY_VALUES},
                'preflight_fingerprint': report['fingerprint'],
                'acknowledged': [issue['id'] for issue in report['issues'] if issue['severity'] == 'confirm']}

    def test_accepted_job_freezes_its_revision_and_never_returns_newer_live_text(self):
        self.publisher.release.clear()
        payload = self.payload()
        job = self.workflow.start(self.draft['id'], payload)
        self.assertTrue(self.publisher.entered.wait(3))
        self.store.save(self.draft['id'], '# New local edit', self.draft['metadata'], self.draft['revision'])
        self.publisher.release.set()
        finished = self.jobs.wait_for(job['id'], timeout=3)
        self.assertEqual(finished['state'], 'succeeded')
        self.assertEqual(self.publisher.observed[0]['draft']['content'], '# Article\n\nOriginal body')
        self.assertEqual(finished['result']['content_sha256'], payload['source_hash'])
        self.assertEqual(finished['result']['media_id'], 'synthetic-media')
        self.assertNotIn('New local edit', json.dumps(finished))
        self.assertNotIn('transport-secret', json.dumps(self.jobs.get(job['id'], include_snapshot=True)))
        self.assertEqual(self.store.get(self.draft['id'])['content'], '# New local edit')

    def test_fifteen_assets_are_frozen_before_live_images_are_replaced(self):
        content = '# Article\n\n' + '\n'.join(f'![image {i}](images/{i}.png)' for i in range(15))
        for index in range(15):
            self.put(f'images/{index}.png', png('red'))
        self.draft = self.store.save(self.draft['id'], content, self.draft['metadata'], self.draft['revision'])
        payload = self.payload('<h1>Article</h1>' + ''.join(f'<img src="images/{i}.png">' for i in range(15)))
        self.publisher.release.clear()
        job = self.workflow.start(self.draft['id'], payload)
        self.assertTrue(self.publisher.entered.wait(3))
        for index in range(15):
            self.store.asset_path(self.draft['id'], f'images/{index}.png').write_bytes(png('green'))
        self.publisher.release.set()
        self.assertEqual(self.jobs.wait_for(job['id'], timeout=3)['state'], 'succeeded')
        observed = self.publisher.observed[0]['assets']
        self.assertEqual(len(observed), 16)
        self.assertTrue(all(observed[f'images/{i}.png'] == png('red') for i in range(15)))
        path = self.publisher.calls[0]['store'].asset_path(self.draft['id'], 'images/0.png')
        self.assertTrue(path.is_relative_to(self.jobs.root / job['id']))
        self.assertFalse(path.is_relative_to(self.store.root))

    def test_stale_source_html_metadata_renderer_account_and_typography_are_rejected_before_worker(self):
        original = self.payload()
        for changes in ({'source_hash': '0' * 64}, {'source_hash': '无效哈希'}, {'preflight_fingerprint': '无效哈希'}, {'revision': '0' * 64}, {'html': '<p>Different</p>'},
                        {'render_version': 'obsolete'}, {'account_id': 'account-abcdef123456'},
                        {'theme': 'journal'}, {'palette': 'red'}, {'typography': {**original['typography'], 'font_size': 18}},
                        {'remote_action': 'arbitrary'}, {'remote_action': 'overwrite', 'expected_remote_hash': 'bad'}):
            with self.subTest(changes=changes), self.assertRaises(EditorError):
                self.workflow.start(self.draft['id'], {**original, **changes})
        self.assertEqual(self.publisher.calls, [])
        self.assertEqual(self.jobs.list(), [])
        self.store.save(self.draft['id'], self.draft['content'], {**self.draft['metadata'], 'title': 'Changed title'}, self.draft['revision'])
        with self.assertRaises(EditorError):
            self.workflow.start(self.draft['id'], original)

    def test_stale_asset_fingerprint_and_missing_acknowledgement_cannot_start_a_job(self):
        original = self.payload()
        # Model an external disk change; uploads now preserve same-name originals.
        self.store.asset_path(self.draft['id'], 'cover.png').write_bytes(png('green'))
        with self.assertRaises(EditorError):
            self.workflow.start(self.draft['id'], original)
        current = self.store.get(self.draft['id'])
        self.store.save(current['id'], current['content'], {**current['metadata'], 'source_url': ''}, current['revision'])
        payload = self.payload()
        self.assertTrue(payload['acknowledged'])
        with self.assertRaises(EditorError):
            self.workflow.start(self.draft['id'], {**payload, 'acknowledged': []})
        self.assertEqual(self.publisher.calls, [])

    def test_exact_duplicate_active_request_reuses_one_job_and_one_publisher(self):
        self.publisher.release.clear()
        payload = self.payload()
        first = self.workflow.start(self.draft['id'], payload)
        self.assertTrue(self.publisher.entered.wait(3))
        second = self.workflow.start(self.draft['id'], payload)
        self.assertEqual(second['id'], first['id'])
        self.assertEqual(len(self.publisher.calls), 1)
        self.publisher.release.set()
        self.jobs.wait_for(first['id'], timeout=3)

    def test_resaving_identical_text_and_settings_does_not_change_active_request_identity(self):
        self.publisher.release.clear()
        payload = self.payload()
        first = self.workflow.start(self.draft['id'], payload)
        self.assertTrue(self.publisher.entered.wait(3))
        with patch('editor_service.utc_now', return_value='2027-01-01T00:00:00+00:00'):
            saved = self.store.save(self.draft['id'], self.draft['content'], self.draft['metadata'], self.draft['revision'])
        self.assertEqual(saved['revision'], self.draft['revision'])
        second = self.workflow.start(self.draft['id'], payload)
        self.assertEqual(second['id'], first['id'])
        self.publisher.release.set()
        self.jobs.wait_for(first['id'], timeout=3)

    def test_explicit_retry_after_restart_uses_frozen_assets_and_metadata(self):
        self.publisher.fail_once = True
        job = self.workflow.start(self.draft['id'], self.payload())
        self.assertEqual(self.jobs.wait_for(job['id'], timeout=3)['state'], 'failed')
        self.store.asset_path(self.draft['id'], 'cover.png').write_bytes(png('green'))
        current = self.store.get(self.draft['id'])
        self.store.save(current['id'], '# New unsynchronized content', {**current['metadata'], 'title': 'New title'}, current['revision'])
        restarted_jobs = SyncJobs(self.jobs.root)
        restarted = SyncWorkflow(self.store, restarted_jobs, self.accounts)
        retried = restarted.retry(job['id'])
        self.assertEqual(restarted_jobs.wait_for(retried['id'], timeout=3)['state'], 'succeeded')
        self.assertEqual(self.publisher.observed[-1]['draft']['metadata']['title'], 'Article')
        self.assertEqual(self.publisher.observed[-1]['assets']['cover.png'], png('blue'))
        self.assertTrue(self.publisher.calls[-1]['checkpoint']['image_cache'])

    def test_corrupted_materialized_asset_blocks_retry_before_any_publisher_call(self):
        self.publisher.fail_once = True
        job = self.workflow.start(self.draft['id'], self.payload())
        self.jobs.wait_for(job['id'], timeout=3)
        wrapper = self.publisher.calls[0]['store']
        wrapper.asset_path(self.draft['id'], 'cover.png').write_bytes(b'corrupt')
        with self.assertRaises(EditorError):
            self.workflow.retry(job['id'])
        self.assertEqual(len(self.publisher.calls), 1)

    def test_retry_accepts_verified_empty_relation_sidecar(self):
        (self.store._draft_dir(self.draft['id']) / '.asset-relations.json').write_text('{}', encoding='utf-8')
        self.publisher.fail_once = True
        job = self.workflow.start(self.draft['id'], self.payload())
        self.assertEqual(self.jobs.wait_for(job['id'], timeout=3)['state'], 'failed')
        self.workflow.retry(job['id'])
        self.assertEqual(self.jobs.wait_for(job['id'], timeout=3)['state'], 'succeeded')
        self.assertTrue(self.publisher.calls[-1]['checkpoint']['image_cache'])

    def test_derived_package_retry_restores_only_missing_bytes_and_preserves_sidecar(self):
        derive_asset(self.store, self.draft['id'], 'cover.png', 'diagram', {})
        prepared = prepare_import('synthetic.zip', article_package(self.store, self.draft['id']))
        self.draft = self.store.create_prepared(prepared['content'],
            {**prepared['metadata'], 'wechat_account_id': ACCOUNT}, assets=prepared['assets'],
            asset_relations=prepared['asset_relations'])
        self.publisher.fail_once = True
        job = self.workflow.start(self.draft['id'], self.payload())
        self.assertEqual(self.jobs.wait_for(job['id'], timeout=3)['state'], 'failed')
        wrapper = self.publisher.calls[0]['store']
        folder = wrapper.asset_path(self.draft['id'], self.draft['metadata']['cover']).parent
        while folder.name != self.draft['id']:
            folder = folder.parent
        sidecar = folder / '.asset-relations.json'
        sidecar.write_text(json.dumps(json.loads(sidecar.read_text('utf-8')), indent=2), encoding='utf-8')
        before = {path: (path.read_bytes(), path.stat().st_mtime_ns) for path in folder.rglob('*') if path.is_file()}
        missing = wrapper.asset_path(self.draft['id'], self.draft['metadata']['cover'])
        missing.unlink()
        self.workflow.retry(job['id'])
        self.assertEqual(self.jobs.wait_for(job['id'], timeout=3)['state'], 'succeeded')
        for path, (data, modified) in before.items():
            self.assertEqual(path.read_bytes(), data)
            if path != missing:
                self.assertEqual(path.stat().st_mtime_ns, modified)
        self.assertTrue(self.publisher.calls[-1]['checkpoint']['image_cache'])

    def test_retry_rejects_modified_relation_sidecar_before_publisher(self):
        derive_asset(self.store, self.draft['id'], 'cover.png', 'diagram', {})
        self.publisher.fail_once = True
        job = self.workflow.start(self.draft['id'], self.payload())
        self.assertEqual(self.jobs.wait_for(job['id'], timeout=3)['state'], 'failed')
        folder = self.publisher.calls[0]['store'].asset_path(self.draft['id'], 'cover.png').parent
        sidecar = folder / '.asset-relations.json'
        sidecar.write_text('{}', encoding='utf-8')
        with self.assertRaises(EditorError):
            self.workflow.retry(job['id'])
        self.assertEqual(len(self.publisher.calls), 1)

    def test_portable_derived_package_retry_reuses_first_two_real_publisher_uploads(self):
        content = '# Article\n\n' + '\n'.join(f'![image](images/{i}.png)' for i in range(15))
        for index in range(15):
            self.put(f'images/{index}.png', png((index, 90, 30)))
        self.draft = self.store.save(self.draft['id'], content, self.draft['metadata'], self.draft['revision'])
        derive_asset(self.store, self.draft['id'], 'cover.png', 'diagram', {})
        prepared = prepare_import('portable.zip', article_package(self.store, self.draft['id']))
        self.draft = self.store.create_prepared(prepared['content'],
            {**prepared['metadata'], 'wechat_account_id': ACCOUNT}, assets=prepared['assets'],
            asset_relations=prepared['asset_relations'])

        class API:
            def __init__(self):
                self.uploads, self.remote, self.thumbs, self.adds = [], None, 0, 0
            def upload_content_image(self, path):
                digest = hashlib.sha256(path.read_bytes()).hexdigest()
                self.uploads.append(digest)
                if len(self.uploads) == 3:
                    raise EditorError('Synthetic third-upload failure', 502)
                return f'https://example.invalid/{digest}.png'
            def upload_thumb(self, path):
                self.thumbs += 1
                return 'portable-cover'
            def add_draft(self, article):
                self.adds += 1
                self.remote = {'news_item': [copy.deepcopy(article)]}
                return 'portable-remote'
            def get_draft(self, media_id):
                return copy.deepcopy(self.remote)

        api = API()
        workflow = SyncWorkflow(self.store, self.jobs, FakeAccounts(WechatPublisher(api, account_id=ACCOUNT)))
        html = '<h1>Article</h1>' + ''.join(f'<img src="{path}">' for path in re.findall(r'!\[image\]\(([^)]+)\)', self.draft['content']))
        job = workflow.start(self.draft['id'], self.payload(html))
        self.assertEqual(self.jobs.wait_for(job['id'], timeout=3)['state'], 'failed')
        self.assertEqual(len(api.uploads), 3)
        accepted = api.uploads[:2]
        folder = self.jobs.root / job['id'] / 'assets' / self.draft['id']
        sidecar = folder / '.asset-relations.json'
        sidecar.unlink()
        (folder / self.draft['metadata']['cover']).unlink()
        workflow.retry(job['id'])
        self.assertEqual(self.jobs.wait_for(job['id'], timeout=3)['state'], 'succeeded')
        self.assertTrue(sidecar.is_file())
        self.assertEqual([api.uploads.count(digest) for digest in accepted], [1, 1])
        self.assertEqual((len(api.uploads), api.adds, api.thumbs), (16, 1, 1))

    def test_worker_asset_access_is_confined_to_its_manifest(self):
        job = self.workflow.start(self.draft['id'], self.payload())
        self.jobs.wait_for(job['id'], timeout=3)
        wrapper = self.publisher.calls[0]['store']
        for path in ('../escape.png', 'images/missing.png', '/outside.png'):
            with self.subTest(path=path), self.assertRaises(EditorError):
                wrapper.asset_path(self.draft['id'], path)

    def test_remote_comparison_ignores_transport_fields_and_uses_the_same_baseline_hash(self):
        baseline = normalized_remote_article(self.publisher.remote)
        self.store.save_publish_state(self.draft['id'], {'account_id': ACCOUNT, 'media_id': 'remote-id', 'remote_baseline': baseline})
        self.publisher.remote['access_token'] = 'transport-secret'
        report = self.workflow.compare_remote(self.draft['id'], ACCOUNT)
        self.assertFalse(report['changed'])
        self.assertEqual(report['current_hash'], article_comparison(baseline, baseline)['current_hash'])
        self.assertNotIn('access_token', json.dumps(report))
        self.assertNotIn('transport-secret', json.dumps(report))
        self.publisher.api = object()
        with self.assertRaises(EditorError):
            self.workflow.compare_remote(self.draft['id'], ACCOUNT)

    def test_remote_read_errors_never_reflect_transport_credentials(self):
        self.store.save_publish_state(self.draft['id'], {'account_id': ACCOUNT, 'media_id': 'remote-id'})

        class FailingAPI:
            def get_draft(self, media_id):
                raise RuntimeError('https://api.example.invalid/?access_token=private-transport-secret')

        self.publisher.api = FailingAPI()
        with self.assertRaises(EditorError) as caught:
            self.workflow.compare_remote(self.draft['id'], ACCOUNT)
        self.assertNotIn('private-transport-secret', str(caught.exception))
        self.assertNotIn('access_token', str(caught.exception))

    def test_remote_normalization_is_idempotent_and_ignores_attribute_order_and_layout_wrappers(self):
        first = {'title': ' Article ', 'content': '<section id="x"><p>A <strong>B</strong></p><img src="https://x.invalid/a.png?from=appmsg" alt="Figure"><pre><code>a\n\tb\n</code></pre></section>'}
        second = {'title': 'Article', 'content': '<div class="wechat"><section>A <span style="font-weight:bold">B</span></section><img alt="Figure" data-src="https://x.invalid/a.png" src="placeholder.png"><pre class="code"><code><span>a</span><br><span>\tb</span><br></code></pre></div>', 'app_secret': 'do-not-copy'}
        self.assertEqual(normalized_remote_article(first), normalized_remote_article(normalized_remote_article(first)))
        self.assertFalse(article_comparison(first, second)['changed'])

    def test_remote_content_image_code_table_and_second_article_changes_are_visible(self):
        original = {'title': 'Article', 'content': '<p>Text</p><img src="https://x.invalid/a.png"><pre><code>a\n b</code></pre><table><tr><th>A</th><td>1</td></tr></table>'}
        for changed in ({**original, 'title': 'Other'}, {**original, 'content': original['content'].replace('Text', 'Changed')},
                        {**original, 'content': original['content'].replace('a.png', 'b.png')},
                        {**original, 'content': original['content'].replace(' b', '  b')},
                        {**original, 'content': original['content'].replace('<td>1', '<td>2')}):
            self.assertTrue(article_comparison(original, changed)['changed'])
        self.assertTrue(article_comparison({'news_item': [original, original]}, {'news_item': [original, {**original, 'title': 'Second changed'}]})['changed'])

    def test_normalized_response_marker_cannot_bypass_transport_field_filtering(self):
        normalized = normalized_remote_article({'title': 'Article', 'content': '<p>Body</p>'})
        injected_block, injected_title = copy.deepcopy(normalized), copy.deepcopy(normalized)
        injected_block['articles'][0]['blocks'][0]['access_token'] = 'transport-secret'
        injected_title['articles'][0]['title'] = {'access_token': 'transport-secret'}
        for changed in (injected_block, injected_title):
            with self.assertRaises(ValueError):
                normalized_remote_article(changed)

    def test_inline_code_is_preserved_through_inline_layout_wrappers(self):
        first = {'content': '<p>Run <code>echo  one</code> now.</p>'}
        second = {'content': '<section>Run <span><code><span>echo  one</span></code></span> now.</section>'}
        self.assertFalse(article_comparison(first, second)['changed'])
        self.assertTrue(article_comparison(first, {'content': second['content'].replace('echo  one', 'echo one')})['changed'])

    def test_explicit_code_breaks_match_wechat_code_without_altering_spaces(self):
        sent = {'content': '<pre><code>if True:<br><span style="display:inline-block;width:4ch">    </span>print("x")<br><br># END</code></pre>'}
        remote = {'content': '<pre><code>if True:\n    print("x")\n\n# END</code></pre>'}
        self.assertFalse(article_comparison(sent, remote)['changed'])
        self.assertTrue(article_comparison(sent, {'content': remote['content'].replace('    print', '  print')})['changed'])

    def test_retry_recreates_missing_private_files_without_overwriting_intact_assets(self):
        self.put('images/one.png', png('red'))
        self.publisher.fail_once = True
        job = self.workflow.start(self.draft['id'], self.payload())
        self.jobs.wait_for(job['id'], timeout=3)
        wrapper = self.publisher.calls[0]['store']
        wrapper.asset_path(self.draft['id'], 'cover.png').unlink()
        self.workflow.retry(job['id'])
        self.assertEqual(self.jobs.wait_for(job['id'], timeout=3)['state'], 'succeeded')
        self.assertEqual(self.publisher.observed[-1]['assets']['images/one.png'], png('red'))

    def test_real_publisher_worker_verifies_readback_then_requires_hash_bound_remote_overwrite(self):
        class FakeAPI:
            def __init__(self):
                self.remote, self.added, self.updated, self.thumbs = None, 0, 0, 0

            def upload_thumb(self, path):
                self.thumbs += 1
                return 'synthetic-cover'

            def upload_content_image(self, path):
                return 'https://example.invalid/image.png'

            def add_draft(self, article):
                self.added += 1
                self.remote = {'news_item': [copy.deepcopy(article)]}
                return 'synthetic-real-publisher'

            def update_draft(self, media_id, article):
                self.updated += 1
                self.remote = {'news_item': [copy.deepcopy(article)]}

            def get_draft(self, media_id):
                return copy.deepcopy(self.remote)

        api = FakeAPI()
        workflow = SyncWorkflow(self.store, self.jobs, FakeAccounts(WechatPublisher(api, account_id=ACCOUNT)))
        payload = self.payload()
        first = workflow.start(self.draft['id'], payload)
        finished = self.jobs.wait_for(first['id'], timeout=3)
        self.assertEqual(finished['state'], 'succeeded')
        self.assertTrue(finished['result']['verified'])
        self.assertEqual(finished['result']['draft_revision'], self.draft['revision'])
        api.remote['news_item'][0]['content'] += '<p>Remote manual edit</p>'
        comparison = workflow.compare_remote(self.draft['id'], ACCOUNT)
        self.assertTrue(comparison['changed'])
        conflicted = workflow.start(self.draft['id'], payload)
        self.assertEqual(self.jobs.wait_for(conflicted['id'], timeout=3)['error']['code'], 'remote-conflict')
        self.assertEqual(api.updated, 0)
        accepted = workflow.start(self.draft['id'], {**payload, 'remote_action': 'overwrite', 'expected_remote_hash': comparison['current_hash']})
        self.assertEqual(self.jobs.wait_for(accepted['id'], timeout=3)['state'], 'succeeded')
        self.assertEqual((api.added, api.updated, api.thumbs), (1, 1, 1))


if __name__ == '__main__':
    unittest.main()
