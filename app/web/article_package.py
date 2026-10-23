"""Portable content-only backups; credentials and account identities never export.

Format 1 packages contain article.md, bounded metadata.json, manifest.json and
all verified local images, including unused originals and covers. Import owns
canonical hash names; source/derivative links contain only whitelisted fields.
"""
from __future__ import annotations

import hashlib
import io
import json
import math
import re
import unicodedata
import zipfile
from datetime import datetime, timezone
from urllib.parse import parse_qsl, unquote, urlsplit

RENDER_VERSION = '2026.10.23-gutter.1'
MAX_METADATA_BYTES = 256 * 1024
MAX_MANIFEST_BYTES = 2 * 1024 * 1024
EXPORT_METADATA = frozenset(('title','author','digest','cover','source_url','need_open_comment','only_fans_can_comment','show_cover_pic','theme','palette','font_family','font_size','code_font_size','code_theme','code_wrap','table_mode','caption_font_size','table_font_size','published_at','imported_at','import_fingerprint','import_kind','article_type','experiment_conditions','source_author','source_date','block_overrides'))
CONDITION_FIELDS = frozenset(('hardware','vram','os_kernel','rocm_version','framework_version','model_version','precision','parallelism','input_output_length','concurrency','test_date','raw_data_source'))
HASH = re.compile(r'[a-f0-9]{64}\Z')
CREDENTIAL = re.compile(r'(?:[a-z0-9]+[_-])*(?:access[_-]?token|refresh[_-]?token|api[_-]?(?:token|key)|app[_-]?secret|secret|password|passwd|cookie|authorization|credentials|token)\Z', re.I)


class PackageValidationError(ValueError):
    pass


def json_bytes(value, limit):
    try:
        data = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode('utf-8')
    except (TypeError, ValueError, UnicodeError, RecursionError) as exc:
        raise PackageValidationError('Package JSON data is invalid') from exc
    if len(data) > limit:
        raise PackageValidationError('Package JSON exceeds its local size limit')
    return data


def read_package_json(data, limit):
    if not isinstance(data, bytes) or len(data) > limit:
        raise PackageValidationError('Package JSON exceeds its local size limit')
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise PackageValidationError('Package JSON has duplicate keys')
            result[key] = value
        return result
    def constant(_value):
        raise PackageValidationError('Package JSON contains nonfinite numbers')
    try:
        result = json.loads(data.decode('utf-8-sig'), object_pairs_hook=pairs, parse_constant=constant)
    except (ValueError, UnicodeError, RecursionError) as exc:
        raise PackageValidationError('Package JSON is invalid') from exc
    if not isinstance(result, dict):
        raise PackageValidationError('Package JSON must be an object')
    return result


def package_asset_path(value):
    if not isinstance(value, str) or not value or len(value) > 1024:
        raise PackageValidationError('Invalid package asset path')
    decoded = unquote(value)
    for candidate in (value, decoded):
        parts = candidate.split('/')
        if (candidate.startswith('/') or any(ord(c) < 32 or c in '\\:<>\"|?*' for c in candidate)
                or any(not part or part in ('.', '..') or part.endswith((' ', '.')) for part in parts)):
            raise PackageValidationError('Unsafe package asset path')
    if unicodedata.normalize('NFC', value) != value or not re.search(r'\.(?:png|jpe?g|gif|webp)\Z', value, re.I):
        raise PackageValidationError('Unsupported package asset path')
    if not (value.startswith('images/') or re.fullmatch(r'cover\.(?:png|jpe?g|gif|webp)', value, re.I)):
        raise PackageValidationError('Package assets must be local images or covers')
    return value


def _string(value, limit):
    if not isinstance(value, str) or len(value) > limit or '\x00' in value:
        raise PackageValidationError('Invalid package text metadata')
    return value


def _number(value, low, high, integer=False):
    if type(value) not in ((int,) if integer else (int, float)) or not math.isfinite(value) or not low <= value <= high:
        raise PackageValidationError('Invalid package numeric metadata')
    return value


def _choice(value, choices):
    if not isinstance(value, str) or value not in choices:
        raise PackageValidationError('Invalid package metadata option')
    return value


def _url(value):
    _string(value, 4096)
    if not value:
        return ''
    try:
        parsed = urlsplit(value)
        if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password:
            return ''
        if any(CREDENTIAL.fullmatch(key) or key.lower() in {'key','signature','sig','x-amz-signature','x-amz-credential'} for key, _ in parse_qsl(parsed.query)):
            return ''
    except ValueError:
        return ''
    return value


def safe_package_metadata(metadata):
    """Allow only portable, typed article metadata; discard unknown nested keys."""
    if not isinstance(metadata, dict):
        raise PackageValidationError('Package metadata must be an object')
    result = {}
    strings = {'title': 64, 'author': 32, 'digest': 120, 'published_at': 512, 'imported_at': 512, 'import_fingerprint': 512, 'import_kind': 512, 'source_author': 512, 'source_date': 512}
    choices = {
        'theme': {'default','grace','simple','technical','journal','minimal','obsidian','deepsea','teal','nord','dracula','latte'},
        'palette': {'warm','wechat','blue','red','violet','ink'}, 'font_family': {'theme','sans','serif'},
        'code_wrap': {'scroll','wrap'}, 'table_mode': {'auto','scroll','cards'},
        'code_theme': {'auto','vscode','github','catppuccin'},
        'article_type': {'tutorial','benchmark','rocm-repost'},
    }
    for key, value in metadata.items():
        if key not in EXPORT_METADATA:
            continue
        if key in strings:
            result[key] = _string(value, strings[key])
        elif key in choices:
            result[key] = _choice(value, choices[key])
        elif key == 'source_url':
            result[key] = _url(value)
        elif key == 'cover':
            result[key] = package_asset_path(value) if value else _string(value, 0)
        elif key in ('show_cover_pic','need_open_comment','only_fans_can_comment'):
            if type(value) is not bool:
                raise PackageValidationError('Invalid package Boolean metadata')
            result[key] = value
        elif key == 'code_font_size':
            if type(value) is not int or value not in (12, 14):
                raise PackageValidationError('Invalid package code font size')
            result[key] = value
        elif key in ('font_size','caption_font_size','table_font_size'):
            result[key] = _number(value, 15 if key == 'font_size' else 12, 18 if key == 'font_size' else 16, integer=True)
        elif key == 'experiment_conditions':
            if not isinstance(value, dict):
                raise PackageValidationError('Package experiment conditions must be an object')
            result[key] = {name: _string(item, 1024) for name, item in value.items() if name in CONDITION_FIELDS}
        elif key == 'block_overrides':
            if not isinstance(value, dict) or len(value) > 200:
                raise PackageValidationError('Invalid package block overrides')
            overrides = {}
            for block_id, candidate in value.items():
                if not isinstance(block_id, str) or not re.fullmatch(r'block-[a-f0-9]{64}', block_id):
                    continue
                if not isinstance(candidate, dict):
                    raise PackageValidationError('Invalid package block override')
                kind = _choice(candidate.get('kind'), {'p','figcaption','table','h1','h2','h3','h4','h5','h6'})
                item = {'kind': kind}
                for field in ('font_size','margin_before','margin_after','line_height'):
                    if field not in candidate:
                        continue
                    if field == 'font_size':
                        low, high = (15,22) if kind == 'p' else (12,16) if kind in {'figcaption','table'} else (18,32)
                        item[field] = _number(candidate[field], low, high, integer=True)
                    elif field == 'line_height':
                        item[field] = _number(candidate[field], 1.2, 2.4)
                    else:
                        item[field] = _number(candidate[field], 0, 48, integer=True)
                if len(item) > 1:
                    overrides[block_id] = item
            result[key] = overrides
    json_bytes(result, MAX_METADATA_BYTES)
    return result


def _vector(value, size, low=0, high=1000000000, integer=False):
    if not isinstance(value, list) or len(value) != size:
        raise PackageValidationError('Invalid package derivation coordinates')
    return [_number(item, low, high, integer) for item in value]


def _image_details(value):
    if not isinstance(value, dict):
        raise PackageValidationError('Invalid package image details')
    safe = {}
    for key, item in value.items():
        if key == 'sha256':
            if not isinstance(item, str) or not HASH.fullmatch(item):
                raise PackageValidationError('Invalid package image fingerprint')
            safe[key] = item
        elif key in ('width','height','frames','duration_ms','loop'):
            if key == 'loop' and item is None:
                continue
            safe[key] = _number(item, 0, 1000000000, integer=True)
        elif key == 'format':
            safe[key] = _choice(item, {'PNG','JPEG','GIF','WEBP'})
        elif key == 'transparency':
            if type(item) is not bool:
                raise PackageValidationError('Invalid package image transparency')
            safe[key] = item
    return safe


def safe_asset_relation(value):
    """A recursive field whitelist, not a generic dictionary scrubber."""
    if not isinstance(value, dict):
        raise PackageValidationError('Invalid package asset relationship')
    result = {}
    for key, item in value.items():
        if key == 'source_path':
            result[key] = package_asset_path(item)
        elif key in ('source_hash','derived_hash'):
            if not isinstance(item, str) or not HASH.fullmatch(item):
                raise PackageValidationError('Invalid package asset fingerprint')
            result[key] = item
        elif key == 'mode':
            result[key] = _choice(item, {'photo','diagram','gif','cover'})
        elif key == 'kind':
            result[key] = _choice(item, {'public-download','rich-content'})
        elif key in ('source_url','final_url'):
            safe = _url(item)
            if safe:
                result[key] = safe
        elif key in ('width','height','frames','duration_ms'):
            result[key] = _number(item, 0, 1000000000, integer=True)
        elif key == 'format':
            result[key] = _choice(item, {'PNG','JPEG','GIF','WEBP'})
        elif key == 'crop_box' or key == 'safe_area_pixels':
            result[key] = _vector(item, 4, integer=True)
        elif key == 'focal_point':
            result[key] = _vector(item, 2, 0, 1)
        elif key == 'ratio':
            result[key] = _number(item, .25, 4)
        elif key == 'safe_area':
            if not isinstance(item, dict):
                raise PackageValidationError('Invalid package safe-area information')
            area = {}
            if 'normalized' in item:
                area['normalized'] = _vector(item['normalized'], 4, 0, 1)
            if 'pixels' in item:
                area['pixels'] = _vector(item['pixels'], 4, integer=True)
            # Free-form notes are not transportable operational fields.
            result[key] = area
        elif key == 'source':
            if not isinstance(item, dict):
                raise PackageValidationError('Invalid package source relationship')
            if item.get('kind') in {'mermaid','math'}:
                source = {'kind': item['kind'], 'text': _string(item.get('text'), 20000)}
                for field in ('from','to'):
                    if field in item:
                        source[field] = _number(item[field], 0, 200000, integer=True)
                if 'display' in item:
                    if type(item['display']) is not bool:
                        raise PackageValidationError('Invalid formula display metadata')
                    source['display'] = item['display']
                result[key] = source
            else:
                result[key] = _image_details(item)
        elif key == 'operations':
            if not isinstance(item, list) or len(item) > 32:
                raise PackageValidationError('Invalid package derivation operations')
            operations = []
            for operation in item:
                if not isinstance(operation, dict):
                    raise PackageValidationError('Invalid package derivation operation')
                name = operation.get('operation')
                if name not in {'apply-exif-orientation','cover-crop','resize','jpeg-compression','lossless-png','gif-compatibility-preset'}:
                    continue
                safe = {'operation': name}
                for field in ('quality','source_frames','target_frames','duration_ms'):
                    if field in operation:
                        safe[field] = _number(operation[field], 0, 1000000000, integer=True)
                for field, count in [('box',4),('size',2)]:
                    if field in operation:
                        safe[field] = _vector(operation[field], count, integer=True)
                if operation.get('alpha_background') == 'white':
                    safe['alpha_background'] = 'white'
                operations.append(safe)
            result[key] = operations
    return result


def validate_relations(raw, by_path):
    if not isinstance(raw, dict) or len(raw) > 253:
        raise PackageValidationError('Invalid package asset relationship map')
    result = {}
    for path, value in raw.items():
        package_asset_path(path)
        if path not in by_path:
            raise PackageValidationError('Package relationship refers to missing image material')
        relation = safe_asset_relation(value)
        actual = by_path[path]['sha256']
        if relation.get('derived_hash', actual) != actual:
            raise PackageValidationError('Derived image fingerprint does not match package material')
        relation['derived_hash'] = actual
        source_path = relation.get('source_path')
        source_hash = relation.get('source_hash')
        if source_path:
            if source_path not in by_path:
                raise PackageValidationError('Original image material is missing from package')
            actual_source = by_path[source_path]['sha256']
            if source_hash and source_hash != actual_source:
                raise PackageValidationError('Original image fingerprint does not match package material')
            relation['source_hash'] = actual_source
        elif source_hash and source_hash not in {item['sha256'] for item in by_path.values()}:
            raise PackageValidationError('Original image fingerprint is absent from package')
        result[path] = relation
    return result


def article_package(store, draft_id):
    """Export a complete, importable package without account or transport state."""
    # Lazy imports avoid an article_import -> article_package -> editor cycle.
    from article_import import MAX_INPUT_BYTES, MAX_TEXT_BYTES, MAX_EXPANDED_BYTES, MAX_ARCHIVE_FILES, _image_asset, _image_references
    from asset_service import relations
    with store._lock:
        draft = store.get(draft_id)
        metadata = safe_package_metadata(draft['metadata'])
        content = draft['content']
        entries, by_path = {}, {}
        for asset in store.list_assets(draft_id):
            path = package_asset_path(asset['path'])
            data = store.asset_path(draft_id, path).read_bytes()
            verified = _image_asset(data)
            entries[path] = data
            by_path[path] = verified
        if len(entries) + 3 > MAX_ARCHIVE_FILES:
            raise PackageValidationError('Package exceeds the archive entry limit')
        cover = metadata.get('cover')
        if cover and cover not in by_path:
            raise PackageValidationError('Package cover image is missing')
        changes = {}
        prefix = f'/api/editor/drafts/{draft_id}/assets/'
        for start, end, target in _image_references(content):
            if target.startswith(prefix):
                path = package_asset_path(unquote(target[len(prefix):]))
                if path not in by_path:
                    raise PackageValidationError('Package image reference has no local material')
                changes[start, end] = path.replace(' ', '%20')
        for (start, end), path in sorted(changes.items(), reverse=True):
            content = content[:start] + path + content[end:]
        article = content.encode('utf-8')
        if len(article) > MAX_TEXT_BYTES:
            raise PackageValidationError('Package article exceeds the text limit')
        safe_relations = validate_relations(relations(store, draft_id), by_path)
        manifest = {
            'format': 1, 'render_version': RENDER_VERSION,
            'content_sha256': hashlib.sha256(article).hexdigest(),
            'exported_at': datetime.now(timezone.utc).isoformat(),
            'assets': [{'path': path, 'sha256': verified['sha256'], 'size': len(entries[path])} for path, verified in sorted(by_path.items())],
            'asset_relations': safe_relations,
        }
        sync = {}
        publish = draft.get('publish') or {}
        if publish.get('publish_status') in {'draft_synced','published','pending'}:
            sync['publish_status'] = publish['publish_status']
        for field in ('synced_at',):
            value = publish.get(field)
            if isinstance(value, str):
                try:
                    date = datetime.fromisoformat(value)
                    if date.tzinfo:
                        sync[field] = date.isoformat()
                except ValueError:
                    pass
        value = publish.get('render_fingerprint')
        if isinstance(value, str) and HASH.fullmatch(value):
            sync['render_fingerprint'] = value
        if sync:
            manifest['sync'] = sync
        entries['article.md'] = article
        entries['metadata.json'] = json_bytes(metadata, MAX_METADATA_BYTES)
        entries['manifest.json'] = json_bytes(manifest, MAX_MANIFEST_BYTES)
        if sum(len(data) for data in entries.values()) > MAX_EXPANDED_BYTES:
            raise PackageValidationError('Package exceeds the expanded archive limit')
        out = io.BytesIO()
        # Stored members always meet the importer's compression-ratio guard.
        with zipfile.ZipFile(out, 'w', compression=zipfile.ZIP_STORED) as archive:
            for path, data in entries.items():
                archive.writestr(path, data)
        value = out.getvalue()
        if len(value) > MAX_INPUT_BYTES:
            raise PackageValidationError('Package exceeds the current import upload limit; split the draft before exporting')
        return value
