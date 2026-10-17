"""Synthetic local sync workers only; no publisher, account files or network."""
import json
import multiprocessing
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'app/web'))
from sync_jobs import SyncJobs, SyncJobConflict, SyncJobCapacityError, DefinitiveSyncFailure
import sync_jobs


IMAGE_HASH = 'a' * 64
PUBLIC_URL = 'https://example.org/synthetic-image.png'


def snapshot(**changes):
    return {
        'content': '# Synthetic article\n\nPrivate local snapshot only.',
        'metadata': {'title': 'Synthetic article', 'theme': 'technical'},
        'html': '<h1>Synthetic article</h1>',
        'render_version': 'synthetic-v1',
        'image_hashes': {'images/example.png': IMAGE_HASH},
        'preflight_acknowledgements': ['synthetic-fingerprint'],
        **changes,
    }


def process_worker(root, stage, ready, release):
    jobs = SyncJobs(Path(root))

    def work(context):
        context.checkpoint(image_cache={IMAGE_HASH: PUBLIC_URL})
        context.emit(stage, completed=1, total=2)
        ready.put(context.job_id)
        release.wait(15)
        return {'media_id': 'synthetic-media-id', 'created': True}

    jobs.start('draft-synthetic', 'account-synthetic', snapshot(), work)
    release.wait(15)


class SyncJobTests(unittest.TestCase):
    def test_content_hash_revision_survives_public_result(self):
        jobs=self.jobs
        record=jobs.start('draft-revision','account-revision',snapshot(),lambda _:{'draft_revision':'b'*64})
        self.assertEqual(jobs.wait_for(record['id'])['result'].get('draft_revision'),'b'*64)
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / 'sync-jobs'
        self.jobs = SyncJobs(self.root)

    def test_job_is_persisted_before_worker_and_public_summary_omits_article(self):
        entered = threading.Event()
        release = threading.Event()
        self.addCleanup(release.set)
        observed = []
        original = snapshot()

        def work(context):
            stored = self.jobs.get(context.job_id, include_snapshot=True)
            observed.append(stored['snapshot']['content'])
            changed_copy = context.snapshot
            changed_copy['metadata']['title'] = 'Worker mutation'
            entered.set()
            release.wait(3)
            context.emit('verify', completed=1, total=1)
            return {'media_id': 'synthetic-remote', 'created': True, 'verified': True}

        job = self.jobs.start('draft-synthetic', 'account-synthetic', original, work)
        self.assertTrue(entered.wait(3))
        original['content'] = 'Caller mutation'
        original['metadata']['title'] = 'Caller mutation'
        persisted = self.jobs.get(job['id'], include_snapshot=True)
        self.assertEqual(observed, [snapshot()['content']])
        self.assertEqual(persisted['snapshot']['metadata']['title'], 'Synthetic article')
        self.assertEqual(persisted['snapshot']['preflight_acknowledgements'], ['synthetic-fingerprint'])
        self.assertNotIn('snapshot', job)
        self.assertNotIn('html', json.dumps(job))
        self.assertNotIn('Private local snapshot', json.dumps(job))
        release.set()
        finished = self.jobs.wait_for(job['id'], timeout=3)
        self.assertEqual(finished['state'], 'succeeded')
        self.assertTrue(finished['result']['verified'])

    def test_identical_active_snapshot_reuses_job_and_changed_snapshot_conflicts(self):
        entered, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)

        def work(context):
            entered.set()
            release.wait(3)
            return {'created': True}

        first = self.jobs.start('draft-synthetic', 'account-synthetic', snapshot(), work)
        self.assertTrue(entered.wait(3))
        other_instance = SyncJobs(self.root)
        second = other_instance.start('draft-synthetic', 'account-synthetic', dict(reversed(list(snapshot().items()))), lambda _: self.fail('Duplicate worker'))
        self.assertEqual(second['id'], first['id'])
        self.assertEqual(second['fingerprint'], first['fingerprint'])
        with self.assertRaises(SyncJobConflict):
            other_instance.start('draft-synthetic', 'account-synthetic', snapshot(html='<p>Changed style</p>'), work)
        release.set()
        self.jobs.wait_for(first['id'], timeout=3)

    def test_different_accounts_run_separately_and_do_not_share_checkpoints(self):
        entered, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)

        def first_worker(context):
            context.checkpoint(image_cache={IMAGE_HASH: PUBLIC_URL})
            entered.set()
            release.wait(3)
            return {'created': True}

        first = self.jobs.start('draft-synthetic', 'account-one', snapshot(), first_worker)
        self.assertTrue(entered.wait(3))
        observed = []

        def second_worker(context):
            observed.append(context.checkpoint_state)
            return {'created': True}

        second = self.jobs.start('draft-synthetic', 'account-two', snapshot(), second_worker)
        self.jobs.wait_for(second['id'], timeout=3)
        self.assertEqual(observed, [{}])
        self.assertNotEqual(first['fingerprint'], second['fingerprint'])
        release.set()
        self.jobs.wait_for(first['id'], timeout=3)

    def test_failed_upload_retry_resumes_confirmed_image_and_cover_caches(self):
        def failed(context):
            context.emit('images', completed=1, total=2)
            context.checkpoint(image_cache={IMAGE_HASH: PUBLIC_URL}, cover_cache={'b' * 64: 'synthetic-cover'})
            raise RuntimeError('API_TOKEN=synthetic-worker-secret; private details')

        job = self.jobs.start('draft-synthetic', 'account-synthetic', snapshot(), failed)
        failed_summary = self.jobs.wait_for(job['id'], timeout=3)
        self.assertEqual(failed_summary['state'], 'failed')
        observations = []

        def resumed(context):
            observations.append(context.checkpoint_state)
            context.checkpoint(image_cache={'c' * 64: 'https://example.org/second.png'})
            return {'media_id': 'synthetic-media-id', 'created': True}

        self.jobs.retry(job['id'], resumed)
        result = self.jobs.wait_for(job['id'], timeout=3)
        self.assertEqual(result['state'], 'succeeded')
        self.assertEqual(result['attempt'], 2)
        self.assertEqual(observations[0]['image_cache'], {IMAGE_HASH: PUBLIC_URL})
        self.assertEqual(observations[0]['cover_cache'], {'b' * 64: 'synthetic-cover'})
        self.assertEqual(len(self.jobs.get(job['id'], include_snapshot=True)['checkpoint']['image_cache']), 2)
        serialized = '\n'.join(path.read_text('utf-8') for path in self.root.rglob('*.json'))
        self.assertNotIn('synthetic-worker-secret', serialized)
        self.assertNotIn('private details', serialized)

    def test_unknown_remote_write_outcome_blocks_retry_and_new_start_until_explicit_resolution(self):
        def failed(context):
            context.emit('remote-write', operation='create')
            raise TimeoutError('access_token=synthetic-network-secret')

        job = self.jobs.start('draft-synthetic', 'account-synthetic', snapshot(), failed)
        result = self.jobs.wait_for(job['id'], timeout=3)
        self.assertEqual(result['state'], 'uncertain')
        self.assertFalse(result['retryable'])
        with self.assertRaises(SyncJobConflict):
            self.jobs.retry(job['id'], lambda _: {})
        with self.assertRaises(SyncJobConflict):
            self.jobs.start('draft-synthetic', 'account-synthetic', snapshot(content='New text'), lambda _: {})
        resolved = self.jobs.resolve_uncertain(job['id'], outcome='succeeded', result={'media_id': 'verified-remote', 'verified': True})
        self.assertEqual(resolved['state'], 'succeeded')
        self.assertEqual(resolved['result']['media_id'], 'verified-remote')

    def test_known_remote_refusal_is_failed_and_retryable_without_persisting_message(self):
        def failed(context):
            context.emit('remote-write')
            raise DefinitiveSyncFailure('Remote says access_token=synthetic-secret')

        job = self.jobs.start('draft-synthetic', 'account-synthetic', snapshot(), failed)
        result = self.jobs.wait_for(job['id'], timeout=3)
        self.assertEqual(result['state'], 'failed')
        self.assertTrue(result['retryable'])
        self.assertNotIn('synthetic-secret', json.dumps(result))
        self.jobs.retry(job['id'], lambda _: {'created': True})
        self.assertEqual(self.jobs.wait_for(job['id'], timeout=3)['state'], 'succeeded')

    def test_progress_and_result_projection_never_persist_arbitrary_payloads(self):
        def work(context):
            context.emit('images', completed=1, total=2, message='synthetic-message-secret', token='synthetic-progress-secret')
            return {'created': True, 'media_id': 'safe-media-id', 'access_token': 'synthetic-result-secret', 'draft': {'content': 'private-result-fulltext'}}

        job = self.jobs.start('draft-synthetic', 'account-synthetic', snapshot(), work)
        result = self.jobs.wait_for(job['id'], timeout=3)
        self.assertEqual(result['progress']['completed'], 1)
        self.assertEqual(result['result'], {'created': True, 'media_id': 'safe-media-id'})
        serialized = '\n'.join(path.read_text('utf-8') for path in self.root.rglob('*.json'))
        for secret in ['synthetic-message-secret', 'synthetic-progress-secret', 'synthetic-result-secret', 'private-result-fulltext']:
            self.assertNotIn(secret, serialized)

    def test_result_fields_do_not_accept_unvalidated_exception_text_as_identifiers_or_dates(self):
        def work(context):
            return {'created': True, 'media_id': 'access_token=synthetic-secret', 'synced_at': 'password=synthetic-secret', 'content_sha256': 'synthetic-secret'}

        job = self.jobs.start('draft-synthetic', 'account-synthetic', snapshot(), work)
        result = self.jobs.wait_for(job['id'], timeout=3)
        self.assertEqual(result['result'], {'created': True})
        self.assertNotIn('synthetic-secret', '\n'.join(path.read_text('utf-8') for path in self.root.rglob('*.json')))

    def test_terminal_job_releases_its_pair_before_a_new_start_can_observe_completion(self):
        closing, release, attempted, finished = (threading.Event() for _ in range(4))
        self.addCleanup(release.set)
        original = sync_jobs._Lease.close
        delayed_once = []
        errors = []
        next_jobs = []

        def delayed_close(lease):
            if not delayed_once and lease.stream is not None and '.leases' in lease.key and threading.current_thread().name.startswith('sync-'):
                delayed_once.append(True)
                closing.set()
                release.wait(3)
            return original(lease)

        def start_after_completion():
            attempted.set()
            try:
                next_jobs.append(self.jobs.start('draft-synthetic', 'account-synthetic', snapshot(content='Second snapshot'), lambda _: {'created': True}))
            except Exception as exc:
                errors.append(type(exc).__name__)
            finally:
                finished.set()

        with patch.object(sync_jobs._Lease, 'close', delayed_close):
            first = self.jobs.start('draft-synthetic', 'account-synthetic', snapshot(), lambda _: {'created': True})
            self.assertTrue(closing.wait(3))
            contender = threading.Thread(target=start_after_completion)
            contender.start()
            try:
                self.assertTrue(attempted.wait(3))
                self.assertFalse(finished.wait(0.05), 'new start must wait for terminal lease release')
            finally:
                release.set()
                contender.join(3)
        self.assertFalse(contender.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(self.jobs.wait_for(first['id'], timeout=3)['state'], 'succeeded')
        self.assertEqual(self.jobs.wait_for(next_jobs[0]['id'], timeout=3)['state'], 'succeeded')

    def test_rejects_credentials_in_snapshot_and_checkpoint_without_storing_them(self):
        with self.assertRaises(ValueError):
            self.jobs.start('draft-synthetic', 'account-synthetic', snapshot(credentials={'app_secret': 'synthetic-secret'}), lambda _: {})
        with self.assertRaises(ValueError):
            self.jobs.start('draft-synthetic', 'account-one', snapshot(target_account_id='account-other'), lambda _: {})

        def invalid(context):
            context.checkpoint(image_cache={IMAGE_HASH: 'https://example.org/a.png?access_token=synthetic-secret'})

        job = self.jobs.start('draft-synthetic', 'account-synthetic', snapshot(), invalid)
        result = self.jobs.wait_for(job['id'], timeout=3)
        self.assertEqual(result['state'], 'failed')
        self.assertEqual(self.jobs.get(job['id'], include_snapshot=True)['checkpoint'], {})
        self.assertNotIn('synthetic-secret', '\n'.join(path.read_text('utf-8') for path in self.root.rglob('*.json')))

    def test_prefixed_credential_fields_are_rejected_before_any_job_is_written(self):
        for key in ['OPENAI_API_KEY', 'WX_APP_SECRET', 'API_TOKEN', 'refresh-token']:
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.jobs.start('draft-synthetic', 'account-synthetic', snapshot(**{key: 'synthetic-only-secret'}), lambda _: {})
        self.assertEqual(self.jobs.list(), [])

    def test_checkpoint_baselines_are_hashes_and_signed_urls_cannot_store_credentials(self):
        rejected = []

        def work(context):
            for fields in [
                {'baseline_hashes': {'content': 'arbitrary-sensitive-payload'}},
                {'image_cache': {IMAGE_HASH: 'https://example.org/image.png?X-Amz-Signature=synthetic-secret'}},
            ]:
                try:
                    context.checkpoint(**fields)
                except ValueError:
                    rejected.append(True)
            context.checkpoint(baseline_hashes={'content': IMAGE_HASH})
            return {'created': True}

        job = self.jobs.start('draft-synthetic', 'account-synthetic', snapshot(), work)
        self.jobs.wait_for(job['id'], timeout=3)
        self.assertEqual(rejected, [True, True])
        serialized = '\n'.join(path.read_text('utf-8') for path in self.root.rglob('*.json'))
        self.assertNotIn('arbitrary-sensitive-payload', serialized)
        self.assertNotIn('synthetic-secret', serialized)

    def test_failed_atomic_checkpoint_install_keeps_previous_complete_record(self):
        entered, update, rejected, finish = (threading.Event() for _ in range(4))
        self.addCleanup(finish.set)
        self.addCleanup(update.set)

        def work(context):
            entered.set()
            update.wait(3)
            try:
                context.checkpoint(image_cache={IMAGE_HASH: PUBLIC_URL})
            except OSError:
                rejected.set()
            finish.wait(3)
            return {'created': True}

        job = self.jobs.start('draft-synthetic', 'account-synthetic', snapshot(), work)
        self.assertTrue(entered.wait(3))
        before = self.jobs.get(job['id'], include_snapshot=True)
        with patch.object(sync_jobs.os, 'replace', side_effect=OSError('synthetic disk failure')):
            update.set()
            self.assertTrue(rejected.wait(3))
            after = self.jobs.get(job['id'], include_snapshot=True)
            self.assertEqual(after, before)
            self.assertEqual(list(self.root.glob('.sync-job-*')), [])
        finish.set()
        self.assertEqual(self.jobs.wait_for(job['id'], timeout=3)['state'], 'succeeded')

    def test_snapshot_disk_mutation_is_detected_before_retry(self):
        job = self.jobs.start('draft-synthetic', 'account-synthetic', snapshot(), lambda _: {'created': True})
        self.jobs.wait_for(job['id'], timeout=3)
        path = self.root / f"{job['id']}.json"
        record = json.loads(path.read_text('utf-8'))
        record['snapshot']['html'] = '<p>Changed outside the original snapshot</p>'
        path.write_text(json.dumps(record), 'utf-8')
        with self.assertRaises(ValueError):
            self.jobs.get(job['id'])

    def test_listing_is_bounded_and_capacity_never_deletes_snapshots(self):
        jobs = SyncJobs(self.root, max_jobs=2)
        first = jobs.start('draft-one', 'account-one', snapshot(), lambda _: {'created': True})
        jobs.wait_for(first['id'], timeout=3)
        second = jobs.start('draft-two', 'account-one', snapshot(), lambda _: {'created': True})
        jobs.wait_for(second['id'], timeout=3)
        with self.assertRaises(SyncJobCapacityError):
            jobs.start('draft-three', 'account-one', snapshot(), lambda _: {})
        self.assertEqual(len(jobs.list(limit=1)), 1)
        self.assertEqual([item['id'] for item in jobs.list(draft_id='draft-one')], [first['id']])
        self.assertEqual(jobs.get(first['id'], include_snapshot=True)['snapshot']['content'], snapshot()['content'])

    def test_real_process_lease_survives_new_instance_and_releases_after_crash(self):
        self._crash_and_check('images', 'interrupted')

    def test_real_process_crash_after_remote_write_remains_uncertain(self):
        self._crash_and_check('remote-write', 'uncertain')

    def _crash_and_check(self, stage, expected):
        spawn = multiprocessing.get_context('spawn')
        ready, release = spawn.Queue(), spawn.Event()
        process = spawn.Process(target=process_worker, args=(str(self.root), stage, ready, release))
        process.start()
        try:
            job_id = ready.get(timeout=8)
            other = SyncJobs(self.root)
            self.assertEqual(other.get(job_id)['state'], 'running')
            reused = other.start('draft-synthetic', 'account-synthetic', snapshot(), lambda _: self.fail('Concurrent process worker'))
            self.assertEqual(reused['id'], job_id)
            process.terminate()
            process.join(5)
            self.assertFalse(process.is_alive())
            restarted = SyncJobs(self.root)
            summary = restarted.get(job_id)
            self.assertEqual(summary['state'], expected)
            self.assertEqual(restarted.get(job_id, include_snapshot=True)['checkpoint']['image_cache'], {IMAGE_HASH: PUBLIC_URL})
            if expected == 'interrupted':
                restarted.retry(job_id, lambda context: {'created': context.checkpoint_state['image_cache'][IMAGE_HASH] == PUBLIC_URL})
                self.assertEqual(restarted.wait_for(job_id, timeout=3)['state'], 'succeeded')
            else:
                with self.assertRaises(SyncJobConflict):
                    restarted.retry(job_id, lambda _: {})
        finally:
            if process.is_alive():
                process.terminate()
            process.join(5)
            ready.close()
            ready.join_thread()


if __name__ == '__main__':
    unittest.main()
