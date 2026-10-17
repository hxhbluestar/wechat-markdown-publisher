"""Persistent local jobs with account/draft leases, not a network publisher.

``SyncJobs(root).start(draft_id, account_id, snapshot, worker)`` flushes an
immutable JSON snapshot before starting a daemon worker. ``worker(context)``
receives defensive ``snapshot`` / ``checkpoint_state`` copies and may call
``emit(stage, completed=..., total=...)`` and ``checkpoint(image_cache=...)``.
The worker returns a small result dictionary; public getters never expose full
articles or checkpoints unless ``include_snapshot=True`` is explicitly used.

Retry is explicit and preserves confirmed, account-specific checkpoints. A
remote-write exception is uncertain unless the publisher raises the exported
``DefinitiveSyncFailure`` after receiving a definite API refusal. Uncertain jobs
hold their account/draft reservation until ``resolve_uncertain`` is called by a
caller that has independently checked the remote result. Nothing retries on
import, construction, or process restart. No automatic deletion is performed:
capacity refuses new jobs instead of removing recovery snapshots.

Every cooperating process uses the same root registry lock and per-pair OS
lease. OS leases release after process death, permitting safe reconciliation.
The private root must remain outside publicly exported application files.
"""
from __future__ import annotations

import contextlib
import hashlib
import json
import os
import re
import secrets
import tempfile
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit


STAGES = frozenset({'preflight', 'images', 'cover', 'remote-check', 'remote-write', 'verify'})
ACTIVE_STATES = frozenset({'queued', 'running'})
TERMINAL_STATES = frozenset({'succeeded', 'failed', 'uncertain', 'interrupted'})
_JOB_ID = re.compile(r'job-[a-f0-9]{32}\Z')
_IDENTIFIER = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\Z')
_HASH = re.compile(r'[a-f0-9]{64}\Z')
_CREDENTIAL_KEY = re.compile(r'(?:[a-z0-9]+[_-])*(?:access[_-]?token|refresh[_-]?token|app[_-]?secret|client[_-]?secret|api[_-]?(?:key|token)|password|passwd|authorization|cookie|credentials|secret|token)\Z', re.I)
_MEDIA_ID = re.compile(r'[A-Za-z0-9_-]{1,512}\Z')
_MAX_JSON_BYTES = 24 * 1024 * 1024
_ROOT_LOCKS: dict[str, threading.RLock] = {}
_LIVE_LEASES: dict[str, '_Lease'] = {}
_GUARD = threading.RLock()
_SAFE_FAILURES = {
    'api-rejected': '远端明确拒绝了本次请求，请核对后重试',
    'preflight-failed': '发布前检查未通过，请修正后重试',
    'account-mismatch': '目标账号与快照不一致，请核对账号',
    'remote-conflict': '远端内容有变化，请核对后继续',
    'asset-failed': '素材处理失败，已确认的上传进度已保留',
}


class SyncJobConflict(Exception):
    """Another active or uncertain job reserves this account/draft pair."""
    status = 409

    def __init__(self, job_id: str = ''):
        super().__init__('该账号与稿件已有进行中或待核实的同步任务')
        self.job_id = job_id


class SyncJobCapacityError(Exception):
    status = 409

    def __init__(self):
        super().__init__('同步任务存储已达保留上限，请先备份并明确管理历史记录')


class DefinitiveSyncFailure(Exception):
    """Only raise after a definite refusal; arbitrary remote text is discarded."""

    def __init__(self, code: str = 'api-rejected'):
        self.code = code if code in _SAFE_FAILURES else 'api-rejected'
        super().__init__(_SAFE_FAILURES[self.code])


class UnknownRemoteResult(Exception):
    def __init__(self, *_ignored):
        super().__init__('远端写入结果待核实，不能直接重试')


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec='microseconds')


def _json_bytes(value) -> bytes:
    try:
        data = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode('utf-8')
    except (ValueError, TypeError, UnicodeError, RecursionError) as exc:
        raise ValueError('Sync job data must be valid JSON') from exc
    if len(data) > _MAX_JSON_BYTES:
        raise ValueError('Sync job data exceeds the local storage limit')
    return data


def _copy(value):
    return json.loads(_json_bytes(value))


def _identifier(value, pattern=_IDENTIFIER):
    if not isinstance(value, str) or not pattern.fullmatch(value):
        raise ValueError('Invalid sync job identifier')
    return value


def _checked(path: Path) -> Path:
    path = Path(os.path.abspath(path))
    for part in (*reversed(path.parents), path):
        if part.is_symlink() or part.is_junction():
            raise ValueError('Sync job paths cannot contain symlinks or junctions')
    return path


def _no_credential_keys(value):
    if isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str) or _CREDENTIAL_KEY.fullmatch(key):
                raise ValueError('Credentials cannot be stored in sync jobs')
            _no_credential_keys(item)
    elif isinstance(value, list):
        for item in value:
            _no_credential_keys(item)


def _fingerprint(draft_id, account_id, snapshot):
    return hashlib.sha256(_json_bytes({'draft_id': draft_id, 'account_id': account_id, 'snapshot': snapshot})).hexdigest()


def _error(code, message):
    return {'code': code, 'message': message}


def _safe_result(result):
    if not isinstance(result, dict):
        raise ValueError('Sync worker must return a result dictionary')
    safe = {}
    for key in ('created', 'verified', 'remote_changed'):
        if type(result.get(key)) is bool:
            safe[key] = result[key]
    for key in ('media_id', 'publish_id'):
        value = result.get(key)
        if isinstance(value, str) and _MEDIA_ID.fullmatch(value):
            safe[key] = value
    for key in ('content_sha256', 'render_fingerprint'):
        value = result.get(key)
        if isinstance(value, str) and _HASH.fullmatch(value):
            safe[key] = value
    if isinstance(result.get('synced_at'), str):
        try:
            date = datetime.fromisoformat(result['synced_at'])
            if date.tzinfo is not None:
                safe['synced_at'] = date.isoformat()
        except ValueError:
            pass
    if isinstance(result.get('draft_revision'),str) and _HASH.fullmatch(result['draft_revision']):
        safe['draft_revision'] = result['draft_revision']
    if result.get('publish_status') in {'draft_synced', 'published', 'pending'}:
        safe['publish_status'] = result['publish_status']
    return safe


def _safe_progress(values):
    safe = {}
    for key in ('completed', 'total', 'current', 'uploaded', 'reused', 'image_index', 'image_count'):
        value = values.get(key)
        if type(value) is int and 0 <= value <= 1_000_000:
            safe[key] = value
    if values.get('operation') in {'create', 'update'}:
        safe['operation'] = values['operation']
    return safe


def _cache_url(value):
    if not isinstance(value, str) or len(value) > 4096 or any(ord(char) < 32 for char in value):
        raise ValueError('Invalid confirmed image URL')
    try:
        parsed = urlsplit(value)
        if parsed.scheme not in {'https', 'http'} or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError('Invalid confirmed image URL')
        if any(_CREDENTIAL_KEY.fullmatch(key) or key.lower() in {'key', 'sig', 'signature', 'auth', 'auth_key', 'x-amz-signature', 'x-amz-credential', 'x-goog-signature', 'x-goog-credential'} for key, _ in parse_qsl(parsed.query)):
            raise ValueError('Credential-bearing image URLs cannot be checkpointed')
    except ValueError:
        raise ValueError('Invalid confirmed image URL') from None
    return value


def _checkpoint_fields(fields):
    if not isinstance(fields, dict):
        raise ValueError('Invalid sync checkpoint')
    allowed = {'image_cache', 'cover_cache', 'media_id', 'thumb_media_id', 'cover_sha256', 'remote_snapshot', 'baseline_hashes', 'remote_write_confirmed', 'remote_verified', 'operation', 'preflight_acknowledgements'}
    if set(fields) - allowed:
        raise ValueError('Unsupported sync checkpoint field')
    copied = _copy(fields)
    _no_credential_keys(copied)
    for key in ('image_cache', 'cover_cache', 'baseline_hashes'):
        if key in copied and not isinstance(copied[key], dict):
            raise ValueError('Invalid sync checkpoint cache')
    for digest, url in copied.get('image_cache', {}).items():
        _identifier(digest, _HASH)
        _cache_url(url)
    for digest, media_id in copied.get('cover_cache', {}).items():
        _identifier(digest, _HASH)
        if not isinstance(media_id, str) or not _MEDIA_ID.fullmatch(media_id):
            raise ValueError('Invalid confirmed cover media identifier')
    for name, digest in copied.get('baseline_hashes', {}).items():
        _identifier(name)
        _identifier(digest, _HASH)
    for key in ('media_id', 'thumb_media_id'):
        if key in copied and (not isinstance(copied[key], str) or not _MEDIA_ID.fullmatch(copied[key])):
            raise ValueError('Invalid confirmed media identifier')
    if 'cover_sha256' in copied:
        _identifier(copied['cover_sha256'], _HASH)
    for key in ('remote_write_confirmed', 'remote_verified'):
        if key in copied and type(copied[key]) is not bool:
            raise ValueError('Invalid sync checkpoint flag')
    if 'operation' in copied and copied['operation'] not in {'create', 'update'}:
        raise ValueError('Invalid sync checkpoint operation')
    return copied


class _Lease:
    def __init__(self, path: Path):
        self.key = os.path.normcase(str(path))
        self.stream = None
        with _GUARD:
            if self.key in _LIVE_LEASES:
                return
            _checked(path)
            path.parent.mkdir(parents=True, exist_ok=True)
            stream = path.open('a+b')
            try:
                if stream.seek(0, os.SEEK_END) == 0:
                    stream.write(b'\0')
                    stream.flush()
                stream.seek(0)
                if os.name == 'nt':
                    import msvcrt
                    msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                stream.close()
                return
            self.stream = stream
            _LIVE_LEASES[self.key] = self

    def close(self):
        with _GUARD:
            if self.stream is None:
                return
            stream, self.stream = self.stream, None
            try:
                stream.seek(0)
                if os.name == 'nt':
                    import msvcrt
                    msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(stream.fileno(), fcntl.LOCK_UN)
            finally:
                stream.close()
                _LIVE_LEASES.pop(self.key, None)


class SyncJobContext:
    def __init__(self, jobs: 'SyncJobs', job_id: str, attempt: int):
        self._jobs = jobs
        self.job_id = job_id
        self._attempt = attempt

    @property
    def snapshot(self):
        return self._jobs.get(self.job_id, include_snapshot=True)['snapshot']

    @property
    def checkpoint_state(self):
        return self._jobs.get(self.job_id, include_snapshot=True)['checkpoint']

    def emit(self, stage: str, **progress):
        if stage not in STAGES:
            raise ValueError('Invalid sync progress stage')
        def update(record):
            record['stage'] = stage
            record['progress'] = _safe_progress(progress)
            if stage == 'remote-write':
                record['remote_write_started'] = True
        self._jobs._update(self.job_id, self._attempt, update)

    def checkpoint(self, **fields):
        fields = _checkpoint_fields(fields)
        def update(record):
            for key, value in fields.items():
                if key in {'image_cache', 'cover_cache', 'baseline_hashes'}:
                    record['checkpoint'].setdefault(key, {}).update(value)
                else:
                    record['checkpoint'][key] = value
        self._jobs._update(self.job_id, self._attempt, update)


class SyncJobs:
    def __init__(self, root: Path, max_jobs: int = 200):
        if type(max_jobs) is not int or not 1 <= max_jobs <= 10_000:
            raise ValueError('Invalid sync job capacity')
        self.root = _checked(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.max_jobs = max_jobs
        key = os.path.normcase(str(self.root))
        with _GUARD:
            self._thread_lock = _ROOT_LOCKS.setdefault(key, threading.RLock())
        with self._locked():
            self._reconcile()

    def _path(self, *parts):
        _checked(self.root)
        path = _checked(self.root.joinpath(*parts))
        if not path.is_relative_to(self.root) or path == self.root:
            raise ValueError('Sync job path escapes its root')
        return path

    @contextlib.contextmanager
    def _locked(self):
        with self._thread_lock:
            lease = _Lease(self._path('.registry.lock'))
            deadline = time.monotonic() + 10
            while lease.stream is None:
                if time.monotonic() >= deadline:
                    raise TimeoutError('Sync job storage is busy')
                time.sleep(0.01)
                lease = _Lease(self._path('.registry.lock'))
            try:
                yield
            finally:
                lease.close()

    def _pair_lease(self, draft_id, account_id):
        digest = hashlib.sha256(_json_bytes([draft_id, account_id])).hexdigest()
        return _Lease(self._path('.leases', f'{digest}.lock'))

    def _read(self, job_id):
        _identifier(job_id, _JOB_ID)
        path = self._path(f'{job_id}.json')
        if path.stat().st_size > _MAX_JSON_BYTES:
            raise ValueError('Sync job record exceeds its storage limit')
        try:
            record = json.loads(path.read_bytes())
            if record['id'] != job_id or record['state'] not in ACTIVE_STATES | TERMINAL_STATES:
                raise ValueError()
            _identifier(record['draft_id'])
            _identifier(record['account_id'])
            if record['fingerprint'] != _fingerprint(record['draft_id'], record['account_id'], record['snapshot']):
                raise ValueError()
            if record['stage'] not in STAGES or not isinstance(record['checkpoint'], dict):
                raise ValueError()
        except (KeyError, TypeError, UnicodeError, json.JSONDecodeError, ValueError):
            raise ValueError('Sync job record is invalid or has changed') from None
        return record

    def _write(self, record):
        path = self._path(f"{_identifier(record['id'], _JOB_ID)}.json")
        data = _json_bytes(record)
        fd, temporary = tempfile.mkstemp(prefix='.sync-job-', dir=self.root)
        try:
            with os.fdopen(fd, 'wb') as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            _checked(path)
            os.replace(temporary, path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def _records(self):
        return [self._read(path.stem) for path in sorted(self.root.glob('job-*.json'))]

    def _reconcile(self):
        for record in self._records():
            if record['state'] not in ACTIVE_STATES:
                continue
            lease = self._pair_lease(record['draft_id'], record['account_id'])
            if lease.stream is None:
                continue
            try:
                if record.get('remote_write_started'):
                    record['state'] = 'uncertain'
                    record['error'] = _error('remote-result-unknown', '进程中断，远端写入结果待核实，不能直接重试')
                else:
                    record['state'] = 'interrupted'
                    record['error'] = _error('process-interrupted', '进程中断，已确认的素材进度已保留，可明确重试')
                record['updated_at'] = _now()
                self._write(record)
            finally:
                lease.close()

    @staticmethod
    def _public(record, include_snapshot=False):
        result = {key: record[key] for key in ('id', 'draft_id', 'account_id', 'fingerprint', 'state', 'stage', 'progress', 'attempt', 'created_at', 'updated_at', 'result', 'error')}
        result['retryable'] = record['state'] in {'failed', 'interrupted'}
        if include_snapshot:
            result['snapshot'] = record['snapshot']
            result['checkpoint'] = record['checkpoint']
        return _copy(result)

    def get(self, job_id: str, include_snapshot: bool = False):
        with self._locked():
            self._reconcile()
            return self._public(self._read(job_id), include_snapshot)

    def list(self, draft_id: str | None = None, limit: int = 50):
        if draft_id is not None:
            _identifier(draft_id)
        if type(limit) is not int or not 1 <= limit <= 200:
            raise ValueError('Sync job list limit must be between 1 and 200')
        with self._locked():
            self._reconcile()
            records = [record for record in self._records() if draft_id is None or record['draft_id'] == draft_id]
            records.sort(key=lambda record: (record['created_at'], record['id']), reverse=True)
            return [self._public(record) for record in records[:limit]]

    def start(self, draft_id: str, account_id: str, snapshot: dict, worker):
        _identifier(draft_id)
        _identifier(account_id)
        if not isinstance(snapshot, dict) or not callable(worker):
            raise ValueError('Invalid sync snapshot or worker')
        _no_credential_keys(snapshot)
        snapshot = _copy(snapshot)
        if snapshot.get('target_account_id', account_id) != account_id:
            raise ValueError('Sync snapshot target account does not match')
        if isinstance(snapshot.get('metadata'), dict) and snapshot['metadata'].get('wechat_account_id', account_id) != account_id:
            raise ValueError('Sync metadata target account does not match')
        snapshot['target_account_id'] = account_id
        fingerprint = _fingerprint(draft_id, account_id, snapshot)
        with self._locked():
            self._reconcile()
            records = self._records()
            for record in records:
                if record['draft_id'] == draft_id and record['account_id'] == account_id and record['state'] in ACTIVE_STATES | {'uncertain'}:
                    if record['state'] in ACTIVE_STATES and record['fingerprint'] == fingerprint:
                        return self._public(record)
                    raise SyncJobConflict(record['id'])
            if len(records) >= self.max_jobs:
                raise SyncJobCapacityError()
            lease = self._pair_lease(draft_id, account_id)
            if lease.stream is None:
                raise SyncJobConflict()
            now = _now()
            record = {'version': 1, 'id': f'job-{secrets.token_hex(16)}', 'draft_id': draft_id, 'account_id': account_id, 'fingerprint': fingerprint, 'snapshot': snapshot, 'checkpoint': {}, 'state': 'queued', 'stage': 'preflight', 'progress': {}, 'attempt': 1, 'created_at': now, 'updated_at': now, 'result': None, 'error': None, 'remote_write_started': False}
            try:
                self._write(record)
                summary = self._public(record)
                self._launch(record, worker, lease)
                return summary
            except BaseException:
                lease.close()
                raise

    def retry(self, job_id: str, worker):
        if not callable(worker):
            raise ValueError('Invalid sync worker')
        with self._locked():
            self._reconcile()
            record = self._read(job_id)
            if record['state'] not in {'failed', 'interrupted'}:
                raise SyncJobConflict(job_id)
            for other in self._records():
                if other['id'] != job_id and other['draft_id'] == record['draft_id'] and other['account_id'] == record['account_id'] and other['state'] in ACTIVE_STATES | {'uncertain'}:
                    raise SyncJobConflict(other['id'])
            lease = self._pair_lease(record['draft_id'], record['account_id'])
            if lease.stream is None:
                raise SyncJobConflict(job_id)
            record.update(state='queued', stage='preflight', progress={}, result=None, error=None, remote_write_started=False, updated_at=_now(), attempt=record['attempt'] + 1)
            try:
                self._write(record)
                summary = self._public(record)
                self._launch(record, worker, lease)
                return summary
            except BaseException:
                lease.close()
                raise

    def resolve_uncertain(self, job_id: str, *, outcome: str, result: dict | None = None, before_resolve=None):
        """Caller must verify the remote outcome before invoking this method."""
        if outcome not in {'succeeded', 'failed'}:
            raise ValueError('An uncertain job requires a definite verified outcome')
        if before_resolve is not None and (outcome!='succeeded' or not callable(before_resolve)):
            raise ValueError('A verified resolution callback is invalid')
        safe_result = _safe_result(result or {}) if outcome == 'succeeded' else None
        with self._locked():
            self._reconcile()
            record = self._read(job_id)
            if record['state'] != 'uncertain':
                raise SyncJobConflict(job_id)
            if before_resolve is not None:before_resolve()
            if outcome=='succeeded' and safe_result.get('verified') is True and safe_result.get('media_id'):
                record['checkpoint']['media_id']=safe_result['media_id']
            record.update(state=outcome, result=safe_result, error=None if outcome == 'succeeded' else _error('remote-not-written', '已明确核实远端未写入，可以重试'), updated_at=_now())
            self._write(record)
            return self._public(record)

    def wait_for(self, job_id: str, timeout: float = 10):
        if not isinstance(timeout, (int, float)) or not 0 <= timeout <= 120:
            raise ValueError('Invalid sync wait timeout')
        deadline = time.monotonic() + timeout
        while True:
            record = self.get(job_id)
            if record['state'] in TERMINAL_STATES:
                return record
            if time.monotonic() >= deadline:
                raise TimeoutError('Sync job is still in progress')
            time.sleep(min(0.01, max(0, deadline - time.monotonic())))

    def _update(self, job_id, attempt, mutation):
        with self._locked():
            record = self._read(job_id)
            if record['state'] != 'running' or record['attempt'] != attempt:
                raise SyncJobConflict(job_id)
            mutation(record)
            record['updated_at'] = _now()
            self._write(record)

    def _launch(self, record, worker, lease):
        threading.Thread(target=self._run, args=(record['id'], record['attempt'], worker, lease), name=f"sync-{record['id']}", daemon=True).start()

    def _run(self, job_id, attempt, worker, lease):
        try:
            with self._locked():
                record = self._read(job_id)
                record.update(state='running', updated_at=_now())
                self._write(record)
            context = SyncJobContext(self, job_id, attempt)
            try:
                result = _safe_result(worker(context))
            except BaseException as exc:
                with self._locked():
                    record = self._read(job_id)
                    if isinstance(exc, DefinitiveSyncFailure):
                        record.update(state='failed', error=_error(exc.code, _SAFE_FAILURES[exc.code]))
                    elif isinstance(exc, UnknownRemoteResult) or record.get('remote_write_started'):
                        record.update(state='uncertain', error=_error('remote-result-unknown', '远端写入结果待核实，不能直接重试'))
                    else:
                        record.update(state='failed', error=_error('worker-failed', '同步步骤失败，已确认的进度已保留，请核对后重试'))
                    record['updated_at'] = _now()
                    self._write(record)
                    lease.close()
            else:
                with self._locked():
                    record = self._read(job_id)
                    record.update(state='succeeded', result=result, error=None, updated_at=_now())
                    self._write(record)
                    lease.close()
        except BaseException:
            # Storage itself can fail. Never log arbitrary worker exception data;
            # the still-active record is reconciled after its lease is released.
            pass
        finally:
            lease.close()
