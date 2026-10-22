"""Bind accepted preflight reports to immutable, account-scoped sync jobs.

No remote call occurs in start's validation path. Only the accepted job worker
constructs a publisher. Retry uses its original confirmed source and assets,
never newer editor text. Private files remain under jobs.root/<job>/assets.
The publisher owns network stages, checkpoints and remote conflict decisions.
"""
from __future__ import annotations

import copy
import hashlib
import json
import os
import re
import secrets
import threading
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from article_package import RENDER_VERSION, MAX_MANIFEST_BYTES, read_package_json, json_bytes
from editor_service import (EditorError, RevisionConflict, TYPOGRAPHY_VALUES,
                            DRAFT_ID, WECHAT_ACCOUNT_ID, safe_asset_path)
from server_preflight import preflight_article
from sync_jobs import DefinitiveSyncFailure, SyncJobConflict, UnknownRemoteResult


_HASH = re.compile(r'[a-f0-9]{64}\Z')
_JOB = re.compile(r'job-[a-f0-9]{32}\Z')
_MAX_HTML = 5 * 1024 * 1024


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode('utf-8')


def _hash(value):
    return hashlib.sha256(_json(value)).hexdigest()


def _content_hash(value):
    return hashlib.sha256(value.encode('utf-8')).hexdigest()


def _checked(path):
    path = Path(os.path.abspath(path))
    for part in (*reversed(path.parents), path):
        if part.is_symlink() or part.is_junction():
            raise EditorError('同步任务路径包含不安全的链接', 400)
    return path


def _same_hash(first, second):
    return (isinstance(first, str) and isinstance(second, str)
            and bool(_HASH.fullmatch(first)) and bool(_HASH.fullmatch(second))
            and secrets.compare_digest(first, second))


def _text(value):
    return re.sub(r'\s+', ' ', str(value or '')).strip()


def _url(value, image=False):
    value = str(value or '').strip()
    try:
        parsed = urlsplit(value)
        if parsed.username or parsed.password:
            # Never reflect URL-embedded transport credentials into comparison.
            return '[credential-bearing-url]'
        query = parse_qsl(parsed.query, keep_blank_values=True)
        ignored = {'from', 'scene', 'wxfrom', 'wx_lazy', 'wx_co', 'tp', 'wx_fmt'} if image else set()
        query = [(key, item) for key, item in query if key.lower() not in ignored]
        return urlunsplit((parsed.scheme.lower(), parsed.netloc.lower(), parsed.path,
                           urlencode(sorted(query)), '' if image else parsed.fragment))
    except ValueError:
        return '[invalid-url]'


class _HTMLTree(HTMLParser):
    def __init__(self, source):
        super().__init__(convert_charrefs=True)
        self.root = {'tag': 'root', 'attrs': {}, 'children': []}
        self.stack = [self.root]
        self.feed(source)
        self.close()

    def handle_starttag(self, tag, attrs):
        if len(self.stack) > 128:
            raise ValueError('Remote article structure is too deep')
        node = {'tag': tag, 'attrs': dict(attrs), 'children': []}
        self.stack[-1]['children'].append(node)
        if tag not in {'img', 'br', 'hr', 'input', 'meta', 'link', 'source', 'wbr', 'area', 'base', 'embed', 'param', 'track', 'col'}:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if self.stack[-1]['tag'] == tag:
            self.stack.pop()

    def handle_endtag(self, tag):
        for index in range(len(self.stack) - 1, 0, -1):
            if self.stack[index]['tag'] == tag:
                del self.stack[index:]
                return

    def handle_data(self, data):
        self.stack[-1]['children'].append(data)


_IGNORED = {'script', 'style', 'iframe', 'object', 'embed', 'template', 'noscript'}
_INLINE = {'span', 'strong', 'em', 'b', 'i', 'u', 'a', 's', 'small', 'mark', 'sub', 'sup', 'font', 'abbr', 'del', 'ins'}


def _hidden(node):
    return node['tag'] in _IGNORED or bool(set(str(node['attrs'].get('class') or '').split()) & {
        'hljs-ln-numbers', 'code-snippet__line-index', 'line-number', 'wx-code-caption',
    })


def _plain(node, code=False):
    if isinstance(node, str):
        return node.replace('\r\n', '\n').replace('\r', '\n') if code else node
    code = code or node['tag'] in {'pre', 'code'}
    # Publishing removes CSS classes; explicit markers identify only generated
    # code gutters, while aria-hidden alone must not conceal source characters.
    if (code and node['attrs'].get('data-wx-code-line-number') == 'true'
            and node['attrs'].get('aria-hidden') == 'true'):
        return ''
    if _hidden(node) or node['tag'] == 'img':
        return ''
    if node['tag'] == 'br':
        return '\n'
    return ''.join(_plain(child, code) for child in node['children'])


def _descendants(node, tags):
    for child in node['children']:
        if isinstance(child, dict) and not _hidden(child):
            if child['tag'] in tags:
                yield child
            yield from _descendants(child, tags)


def _segments(children):
    result, pending = [], []

    def flush():
        text = _text(''.join(pending))
        pending.clear()
        if text:
            result.append({'type': 'paragraph', 'text': text})

    def visit(node):
        if isinstance(node, str):
            pending.append(node)
            return
        if _hidden(node):
            return
        tag = node['tag']
        if tag in _INLINE:
            for child in node['children']:
                visit(child)
            return
        if tag == 'br':
            pending.append('\n')
            return
        flush()
        if re.fullmatch(r'h[1-6]', tag):
            result.append({'type': 'heading', 'level': int(tag[1]), 'text': _text(_plain(node))})
        elif tag in {'pre', 'code'}:
            result.append({'type': 'code' if tag == 'pre' else 'inline-code', 'text': _plain(node, True)})
        elif tag == 'img':
            result.append({'type': 'image', 'source': _url(node['attrs'].get('data-src') or node['attrs'].get('src'), True)})
        elif tag == 'table':
            rows = []
            for row in _descendants(node, {'tr'}):
                cells = []
                for cell in row['children']:
                    if not isinstance(cell, dict) or cell['tag'] not in {'th', 'td'}:
                        continue
                    span = lambda key: str(cell['attrs'].get(key) or '1')
                    cells.append({'header': cell['tag'] == 'th', 'rowspan': span('rowspan'), 'colspan': span('colspan'),
                                  'text': _text(_plain(cell)),
                                  'code': [_plain(item, True) for item in _descendants(cell, {'pre'})]})
                if cells:
                    rows.append(cells)
            result.append({'type': 'table', 'rows': rows})
        elif tag in {'ul', 'ol'}:
            result.append({'type': 'list', 'ordered': tag == 'ol', 'items': [
                _segments(child['children']) for child in node['children'] if isinstance(child, dict) and child['tag'] == 'li']})
        elif tag == 'blockquote':
            result.append({'type': 'quote', 'blocks': _segments(node['children'])})
        elif tag == 'hr':
            result.append({'type': 'separator'})
        else:
            result.extend(_segments(node['children']))
    for node in children:
        visit(node)
    flush()
    return result


def _schema(value, fields):
    if not isinstance(value, dict) or set(value) != fields:
        raise ValueError('Invalid normalized remote article schema')


def _strings(values):
    if not isinstance(values, list) or any(not isinstance(item, str) for item in values):
        raise ValueError('Invalid normalized remote article strings')


def _validate_blocks(blocks, depth=0):
    if not isinstance(blocks, list) or depth > 128:
        raise ValueError('Invalid normalized article blocks')
    for node in blocks:
        if not isinstance(node, dict):
            raise ValueError('Invalid normalized article block')
        kind = node.get('type')
        if kind in {'paragraph', 'heading', 'code', 'inline-code'}:
            _schema(node, {'type', 'text', 'level'} if kind == 'heading' else {'type', 'text'})
            if not isinstance(node['text'], str) or kind == 'heading' and (type(node['level']) is not int or not 1 <= node['level'] <= 6):
                raise ValueError('Invalid normalized text block')
        elif kind == 'image':
            _schema(node, {'type', 'source'})
            if not isinstance(node['source'], str):
                raise ValueError('Invalid normalized image')
        elif kind == 'separator':
            _schema(node, {'type'})
        elif kind == 'quote':
            _schema(node, {'type', 'blocks'})
            _validate_blocks(node['blocks'], depth + 1)
        elif kind == 'list':
            _schema(node, {'type', 'ordered', 'items'})
            if type(node['ordered']) is not bool or not isinstance(node['items'], list):
                raise ValueError('Invalid normalized list')
            for item in node['items']:
                _validate_blocks(item, depth + 1)
        elif kind == 'table':
            _schema(node, {'type', 'rows'})
            if not isinstance(node['rows'], list):
                raise ValueError('Invalid normalized table')
            for row in node['rows']:
                if not isinstance(row, list):
                    raise ValueError('Invalid normalized table row')
                for cell in row:
                    _schema(cell, {'header', 'rowspan', 'colspan', 'text', 'code'})
                    if type(cell['header']) is not bool or any(not isinstance(cell[key], str) for key in ('rowspan', 'colspan', 'text')):
                        raise ValueError('Invalid normalized table cell')
                    _strings(cell['code'])
        else:
            raise ValueError('Unknown normalized article block')


def normalized_remote_article(raw):
    """Idempotent semantic object from one article or draft/get's news_item.

    Ignore layout wrappers, attributes and normal prose whitespace; preserve
    code whitespace, headings, list/table structure, image identities and links.
    Only article fields are selected; transport response fields never escape.
    """
    if not isinstance(raw, dict):
        raise ValueError('Remote article response must be an object')
    if raw.get('format') == 'wechat-semantic-v1':
        # Already-normalized objects are generated and retained locally. Select
        # the exact schema again so top-level transport fields are not reflected.
        articles = raw.get('articles')
        if not isinstance(articles, list) or not 1 <= len(articles) <= 20:
            raise ValueError('Invalid normalized remote article')
        selected = []
        fields = {'title', 'author', 'digest', 'source_url', 'cover', 'show_cover_pic',
                  'need_open_comment', 'only_fans_can_comment', 'blocks', 'images', 'links'}
        for article in articles:
            if not isinstance(article, dict) or set(article) != fields:
                raise ValueError('Invalid normalized remote article fields')
            if any(not isinstance(article[key], str) for key in ('title', 'author', 'digest', 'source_url', 'cover')):
                raise ValueError('Invalid normalized article metadata')
            if any(type(article[key]) is not int or article[key] not in (0, 1) for key in ('show_cover_pic', 'need_open_comment', 'only_fans_can_comment')):
                raise ValueError('Invalid normalized article flags')
            _validate_blocks(article['blocks'])
            _strings(article['images'])
            if not isinstance(article['links'], list):
                raise ValueError('Invalid normalized article links')
            for link in article['links']:
                _schema(link, {'href', 'text'})
                if not isinstance(link['href'], str) or not isinstance(link['text'], str):
                    raise ValueError('Invalid normalized link')
            selected.append(copy.deepcopy(article))
        result = {'format': 'wechat-semantic-v1', 'articles': selected}
        if len(_json(result)) > 2 * _MAX_HTML:
            raise ValueError('Remote article exceeds comparison limit')
        return result
    articles = raw.get('news_item') if 'news_item' in raw else [raw]
    if not isinstance(articles, list) or not 1 <= len(articles) <= 20:
        raise ValueError('Remote draft contains no usable article')
    selected = []
    for article in articles:
        if not isinstance(article, dict) or not isinstance(article.get('content'), str):
            raise ValueError('Remote article is missing its body')
        body = article['content']
        if len(body.encode('utf-8')) > _MAX_HTML:
            raise ValueError('Remote article exceeds comparison limit')
        tree = _HTMLTree(body).root
        selected.append({
            'title': _text(article.get('title')), 'author': _text(article.get('author')),
            'digest': _text(article.get('digest')),
            'source_url': _url(article.get('content_source_url') or article.get('source_url')),
            'cover': str(article.get('thumb_media_id') or ''),
            **{key: 1 if article.get(key) in (True, 1, '1') else 0 for key in ('show_cover_pic', 'need_open_comment', 'only_fans_can_comment')},
            'blocks': _segments(tree['children']),
            'images': [_url(node['attrs'].get('data-src') or node['attrs'].get('src'), True) for node in _descendants(tree, {'img'})],
            'links': [{'href': _url(node['attrs'].get('href')), 'text': _text(_plain(node))} for node in _descendants(tree, {'a'}) if node['attrs'].get('href')],
        })
    return {'format': 'wechat-semantic-v1', 'articles': selected}


def article_comparison(baseline, current):
    current = normalized_remote_article(current)
    baseline = normalized_remote_article(baseline) if baseline is not None else None
    fields = []
    if baseline is None:
        fields = ['baseline-unavailable']
    elif len(baseline['articles']) != len(current['articles']):
        fields = ['article-count']
    else:
        for index, (before, after) in enumerate(zip(baseline['articles'], current['articles'])):
            fields.extend(f'articles.{index}.{key}' for key in sorted(before) if before[key] != after[key])
    return {'changed': baseline != current, 'baseline_available': baseline is not None,
            'baseline_hash': _hash(baseline) if baseline is not None else '', 'current_hash': _hash(current),
            'fields': fields, 'baseline': baseline, 'current': current}


class _SnapshotStore:
    """The publisher's DraftStore surface, with immutable source and assets."""
    def __init__(self, live, snapshot, folder):
        self.live, self.snapshot, self.folder = live, snapshot, folder
        self.root = folder.parent
        self._lock = live._lock
        self.account_id = snapshot['target_account_id']
        self.entries = {entry['path']: entry for entry in snapshot['manifest']['assets']}

    def _draft_dir(self, draft_id):
        if draft_id != self.snapshot['draft_id']:
            raise EditorError('同步任务稿件不匹配', 404)
        return _checked(self.folder)

    def get_publish_state(self, draft_id, account_id):
        self._draft_dir(draft_id)
        if account_id != self.account_id:
            raise EditorError('同步任务账号不匹配')
        return copy.deepcopy(self.live.get_publish_state(draft_id, account_id))

    def get(self, draft_id):
        self._draft_dir(draft_id)
        snapshot = self.snapshot
        return {'id': draft_id, 'content': snapshot['content'], 'metadata': copy.deepcopy(snapshot['metadata']),
                'revision': snapshot['revision'], 'source_name': snapshot.get('source_name', ''),
                'created_at': snapshot.get('draft_created_at', ''), 'updated_at': snapshot.get('draft_updated_at', ''),
                'publish': self.get_publish_state(draft_id, self.account_id)}

    def asset_path(self, draft_id, relative, *, must_exist=True):
        folder = self._draft_dir(draft_id)
        clean = safe_asset_path(relative)
        entry = self.entries.get(clean)
        if entry is None:
            raise EditorError('任务快照中没有所请求的素材', 404)
        path = _checked(folder / clean)
        if not path.is_relative_to(folder) or not path.is_file():
            raise EditorError('任务素材缺失或路径不安全')
        data = path.read_bytes()
        if len(data) != entry['size'] or hashlib.sha256(data).hexdigest() != entry['sha256']:
            raise EditorError('任务素材已变化，已停止同步', 409)
        return path

    def list_assets(self, draft_id):
        self._draft_dir(draft_id)
        return copy.deepcopy(list(self.entries.values()))

    def save_publish_state(self, draft_id, state):
        self._draft_dir(draft_id)
        if state.get('account_id') not in (None, '', self.account_id):
            raise EditorError('同步状态账号不匹配')
        return self.live.save_publish_state(draft_id, {**state, 'account_id': self.account_id})


class SyncWorkflow:
    def __init__(self, store, jobs, accounts):
        self.store, self.jobs, self.accounts = store, jobs, accounts
        live, private = _checked(store.root), _checked(jobs.root)
        if live.is_relative_to(private) or private.is_relative_to(live):
            raise EditorError('同步任务目录必须与正文稿件目录分开')
        self._materialize_lock = threading.RLock()

    @staticmethod
    def _confirmation(report, fingerprint, acknowledged):
        if not isinstance(acknowledged, list) or len(acknowledged) > 1024 or any(not isinstance(item, str) or len(item) > 256 for item in acknowledged):
            raise EditorError('预检确认记录无效')
        if not report['can_sync'] or report['counts']['blocker']:
            raise EditorError('发布前检查存在阻断项，请修正后重新检查', 409)
        if not _same_hash(report['fingerprint'], fingerprint):
            raise RevisionConflict()
        # Recommendations, including legacy ``confirm`` findings, must not
        # prevent writing an editable WeChat draft. Keep accepting the old
        # acknowledgement field while enforcing the exact snapshot and blockers.

    def start(self, draft_id, payload):
        if not isinstance(payload, dict):
            raise EditorError('同步请求无效')
        with self.store._lock:
            draft = self.store.get(draft_id)
            if not _same_hash(payload.get('source_hash'), _content_hash(draft['content'])) or payload.get('revision', draft['revision']) != draft['revision']:
                raise RevisionConflict()
            metadata = draft['metadata']
            if payload.get('theme') != metadata['theme'] or payload.get('palette') != metadata['palette']:
                raise RevisionConflict()
            typography = payload.get('typography')
            if not isinstance(typography, dict) or set(typography) != set(TYPOGRAPHY_VALUES):
                raise EditorError('同步排版选项不完整')
            if any(type(typography[key]) is not type(metadata[key]) or typography[key] != metadata[key] for key in TYPOGRAPHY_VALUES):
                raise RevisionConflict()
            account_id = payload.get('account_id')
            if not isinstance(account_id, str) or not WECHAT_ACCOUNT_ID.fullmatch(account_id) or metadata.get('wechat_account_id') != account_id:
                raise EditorError('目标账号与已保存稿件不一致', 409)
            self.accounts.get(account_id)  # Existence only; never copy credentials.
            source_html = payload.get('html')
            report = preflight_article(self.store, draft, source_html, payload.get('render_version'), account_id)
            acknowledgements = payload.get('acknowledged', [])
            self._confirmation(report, payload.get('preflight_fingerprint'), acknowledgements)
            action, expected = payload.get('remote_action', ''), payload.get('expected_remote_hash', '')
            if action not in ('', 'copy', 'overwrite') or not isinstance(expected, str) or expected and not _HASH.fullmatch(expected) or action == 'overwrite' and not _HASH.fullmatch(expected):
                raise EditorError('远端变更确认无效，请重新比较', 409)
            snapshot = {
                'draft_id': draft_id, 'content': draft['content'], 'metadata': copy.deepcopy(metadata),
                'revision': draft['revision'], 'source_name': draft.get('source_name', ''),
                'draft_created_at': draft.get('created_at', ''), 'draft_updated_at': draft.get('updated_at', ''),
                'target_account_id': account_id, 'html': source_html, 'source_hash': payload['source_hash'],
                'render_version': payload['render_version'], 'render_fingerprint': report['fingerprint'],
                'preflight_fingerprint': report['fingerprint'], 'preflight_acknowledgements': sorted(set(acknowledgements)),
                'remote_action': action, 'expected_remote_hash': expected,
            }
            snapshot['request_fingerprint'] = _hash({key: value for key, value in snapshot.items()
                                                     if key not in {'draft_created_at', 'draft_updated_at'}})
            for job in self.jobs.list(draft_id, limit=200):
                if job['account_id'] == account_id and job['state'] in {'queued', 'running', 'uncertain'}:
                    if job['state'] != 'uncertain':
                        existing = self.jobs.get(job['id'], include_snapshot=True)['snapshot']
                        if existing.get('request_fingerprint') == snapshot['request_fingerprint']:
                            return self.jobs.get(job['id'])
                    raise SyncJobConflict(job['id'])
            summary = self.store.history.capture(draft, self.store._draft_dir(draft_id), 'before-sync')
            history = self.store.history.read(draft_id, summary['snapshot_id'])
            snapshot['history_snapshot_id'] = summary['snapshot_id']
            snapshot['manifest'] = history['manifest']
            return self.jobs.start(draft_id, account_id, snapshot, self._worker)

    def _prepare(self, snapshot, job_id):
        try:
            if not _JOB.fullmatch(job_id) or not DRAFT_ID.fullmatch(snapshot['draft_id']) or not WECHAT_ACCOUNT_ID.fullmatch(snapshot['target_account_id']):
                raise ValueError('Invalid snapshot identity')
            history = self.store.history.read(snapshot['draft_id'], snapshot['history_snapshot_id'])
            if any(history[key] != snapshot[key] for key in ('content', 'metadata', 'revision', 'manifest')):
                raise ValueError('History snapshot mismatch')
            if not _same_hash(_content_hash(snapshot['content']), snapshot['source_hash']) or snapshot['render_version'] != RENDER_VERSION:
                raise ValueError('Snapshot version mismatch')
            folder = _checked(self.jobs.root / job_id / 'assets' / snapshot['draft_id'])
            if not folder.is_relative_to(_checked(self.jobs.root)):
                raise ValueError('Private asset path escapes job root')
            with self._materialize_lock:
                expected = {entry['path']: entry for entry in history['manifest']['assets']}
                relation_path = folder / '.asset-relations.json'
                has_relations = 'asset_relations' in history['manifest']
                if folder.exists():
                    for path in folder.rglob('*'):
                        _checked(path)
                        if path.is_dir():
                            if path == relation_path:
                                raise ValueError('Private asset relations must be a file')
                            continue
                        relative = path.relative_to(folder).as_posix()
                        if relative == '.asset-relations.json' and has_relations and path.is_file():
                            with path.open('rb') as stream:
                                relations = read_package_json(stream.read(MAX_MANIFEST_BYTES + 1), MAX_MANIFEST_BYTES)
                            if json_bytes(relations, MAX_MANIFEST_BYTES) != json_bytes(history['manifest']['asset_relations'], MAX_MANIFEST_BYTES):
                                raise ValueError('Corrupt private asset relations')
                            continue
                        if relative not in expected or not path.is_file():
                            raise ValueError('Unexpected private asset')
                        data = path.read_bytes()
                        entry = expected[relative]
                        if len(data) != entry['size'] or hashlib.sha256(data).hexdigest() != entry['sha256']:
                            raise ValueError('Corrupt private asset')
                missing = [entry for entry in expected.values() if not (folder / entry['path']).exists()]
                partial = copy.deepcopy(history)
                partial['manifest']['assets'] = missing
                # The full history was validated above. A partial set cannot
                # validate source/derivative relations, or reinstall an intact
                # sidecar. Restore missing bytes only, with no replacement.
                partial['manifest'].pop('asset_relations', None)
                self.store.history.restore_assets(partial, folder)
                if has_relations and not relation_path.exists():
                    data = json_bytes(history['manifest']['asset_relations'], MAX_MANIFEST_BYTES)
                    created = False
                    try:
                        with relation_path.open('xb') as stream:
                            created = True
                            stream.write(data)
                    except BaseException:
                        if created:
                            relation_path.unlink()
                        raise
            wrapper = _SnapshotStore(self.store, snapshot, folder)
            draft = wrapper.get(snapshot['draft_id'])
            report = preflight_article(wrapper, draft, snapshot['html'], snapshot['render_version'], snapshot['target_account_id'])
            self._confirmation(report, snapshot['preflight_fingerprint'], snapshot['preflight_acknowledgements'])
            return wrapper
        except EditorError:
            raise
        except (ValueError, OSError, KeyError, TypeError) as exc:
            raise EditorError('同步快照或素材校验失败，请保留记录并重新检查', 409) from exc

    def _worker(self, context):
        snapshot = context.snapshot
        context.emit('preflight')
        try:
            wrapper = self._prepare(snapshot, context.job_id)
        except EditorError as exc:
            raise DefinitiveSyncFailure('preflight-failed') from exc
        context.checkpoint(preflight_acknowledgements=snapshot['preflight_acknowledgements'])
        publisher = self.accounts.publisher(snapshot['target_account_id'])
        _, created = publisher.sync(wrapper, snapshot['draft_id'], snapshot['html'], snapshot['source_hash'],
                                    snapshot['metadata']['theme'], snapshot['metadata']['palette'],
                                    typography={key: snapshot['metadata'][key] for key in TYPOGRAPHY_VALUES},
                                    context=context, remote_action=snapshot['remote_action'],
                                    expected_remote_hash=snapshot['expected_remote_hash'])
        checkpoint = context.checkpoint_state
        if not checkpoint.get('remote_verified'):
            raise UnknownRemoteResult()
        return {'created': bool(created), 'verified': True, 'media_id': checkpoint.get('media_id', ''),
                'content_sha256': snapshot['source_hash'], 'draft_revision': snapshot['revision'],
                'render_fingerprint': snapshot['render_fingerprint'], 'publish_status': 'draft_synced'}

    def retry(self, job_id):
        job = self.jobs.get(job_id, include_snapshot=True)
        self._prepare(job['snapshot'], job_id)
        return self.jobs.retry(job_id, self._worker)

    def compare_remote(self, draft_id, account_id):
        if not isinstance(account_id, str) or not WECHAT_ACCOUNT_ID.fullmatch(account_id):
            raise EditorError('目标账号无效')
        with self.store._lock:
            draft = self.store.get(draft_id)
            publish = self.store.get_publish_state(draft_id, account_id)
            media_id = publish.get('media_id')
            if not media_id:
                raise EditorError('该账号尚无可比较的远端草稿', 409)
            baseline = copy.deepcopy(publish.get('remote_baseline'))
        publisher = self.accounts.publisher(account_id)
        getter = getattr(getattr(publisher, 'api', None), 'get_draft', None)
        if not callable(getter):
            raise EditorError('当前公众号接口不支持读取远端草稿，已停止比较', 409)
        try:
            remote = getter(media_id)
        except Exception:
            # Transport exceptions can contain an authenticated request URL.
            raise EditorError('无法读取远端草稿，请检查公众号连接后重试', 502) from None
        try:
            comparison = article_comparison(baseline, remote)
        except (ValueError, TypeError, KeyError) as exc:
            raise EditorError('远端草稿结构无法可靠比较，请先在微信后台核对', 409) from exc
        return {**comparison, 'draft_id': draft_id, 'account_id': account_id, 'media_id': media_id,
                'expected_remote_hash': comparison['current_hash'],
                'local': {'revision': draft['revision'], 'content_sha256': _content_hash(draft['content']),
                          'render_fingerprint': publish.get('render_fingerprint', '')}}
