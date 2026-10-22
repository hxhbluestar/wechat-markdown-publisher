"""Local Markdown drafts and official-account publishing services.

The historical archive remains read-only. All mutable content lives below
``knowledge_base/drafts`` (or ``WECHAT_DRAFTS_DIR`` in tests/deployments).
"""

from __future__ import annotations

import base64
import contextlib
import company_network
from draft_history import DraftHistory
import hashlib
import html
import json
import mimetypes
import os
import re
import secrets
import shutil
import tempfile
import threading
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Protocol


MAX_JSON_BYTES = 18 * 1024 * 1024
MAX_IMAGE_BYTES = 10 * 1024 * 1024
DRAFT_ID = re.compile(r"^draft-[0-9]{8}-[a-f0-9]{8}$")
WECHAT_ACCOUNT_ID = re.compile(r"^account-[a-f0-9]{12}$")
LOCAL_IMAGE_SRC = re.compile(
    r"(?P<prefix><img\b[^>]*?\bsrc\s*=\s*)(?P<quote>[\"'])(?P<src>.*?)(?P=quote)",
    re.I | re.S,
)
FORBIDDEN_HTML = re.compile(r"<(?:script|iframe|object|embed|form)\b", re.I)
ALLOWED_IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".webp"}
LEGACY_THEMES = {"default", "grace", "simple"}
ALLOWED_THEMES = LEGACY_THEMES | {"technical", "journal", "minimal", "obsidian", "deepsea", "teal", "nord", "dracula", "latte"}
ALLOWED_PALETTES = {"warm", "wechat", "blue", "red", "violet", "ink"}
BASE_TYPOGRAPHY_FIELDS = frozenset({"font_family", "font_size", "code_wrap", "table_mode"})
TYPOGRAPHY_SIZE_DEFAULTS = {"caption_font_size": 12, "table_font_size": 13, "code_font_size": 12}
LEGACY_TYPOGRAPHY_SIZE_DEFAULTS = {"caption_font_size": 13, "table_font_size": 16, "code_font_size": 12}
TYPOGRAPHY_VALUES = {
    "font_family": {"theme", "sans", "serif"},
    "font_size": {15, 16, 17, 18},
    "code_font_size": {12, 14},
    "code_theme": {"auto", "vscode", "github", "catppuccin"},
    "code_wrap": {"scroll", "wrap"},
    "table_mode": {"auto", "scroll", "cards"},
    "caption_font_size": {12, 13, 14, 15, 16},
    "table_font_size": {12, 13, 14, 15, 16},
}


class EditorError(Exception):
    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.status = status


class RevisionConflict(EditorError):
    def __init__(self) -> None:
        super().__init__("稿件已在其他窗口更新，请重新加载后再保存", 409)


class WechatAPIRejected(EditorError):
    """The platform returned a definite JSON errcode, rather than a timeout."""
    definite_rejection = True


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def content_sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(128 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp_name, path)
    finally:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass


def atomic_json(path: Path, data: dict[str, Any]) -> None:
    atomic_write(
        path,
        (json.dumps(data, ensure_ascii=False, indent=2) + "\n").encode("utf-8"),
    )


def safe_asset_path(value: str) -> str:
    value = urllib.parse.unquote(str(value or "")).replace("\\", "/").strip()
    if not value or value.startswith("/") or ":" in value or "\x00" in value or "\r" in value or "\n" in value:
        raise EditorError("素材路径无效")
    parts = [part for part in value.split("/") if part not in ("", ".")]
    if any(part == ".." for part in parts):
        raise EditorError("素材路径不能越过稿件目录")
    clean = "/".join(parts)
    suffix = Path(clean).suffix.lower()
    if suffix not in ALLOWED_IMAGE_EXTS:
        raise EditorError("仅支持 JPG、PNG、GIF 和 WebP 图片")
    if not (clean.startswith("images/") or re.fullmatch(r"cover\.(?:jpe?g|png|gif|webp)", clean, re.I)):
        # Imported Markdown may use pub/ or other relative image folders.
        # Keep every asset inside this draft's images/ tree while preserving
        # the source folder structure to avoid same-name collisions.
        clean = f"images/{clean}"
    return clean


def default_typography(theme: str) -> dict[str, Any]:
    return {
        "font_family": "theme",
        "font_size": 16 if theme in LEGACY_THEMES else 17,
        "code_wrap": "wrap",
        "code_theme": "auto",
        "table_mode": "auto",
        **(LEGACY_TYPOGRAPHY_SIZE_DEFAULTS if theme in LEGACY_THEMES else TYPOGRAPHY_SIZE_DEFAULTS),
    }


def default_metadata(title: str = "") -> dict[str, Any]:
    return {
        "title": title[:64],
        "author": "",
        "digest": "",
        "cover": "",
        "source_url": "",
        "need_open_comment": False,
        "only_fans_can_comment": False,
        "show_cover_pic": False,
        "theme": "technical",
        "palette": "warm",
        **default_typography("technical"),
        "wechat_account_id": "",
    }


def normalize_metadata(value: Any, fallback_title: str = "") -> dict[str, Any]:
    source = value if isinstance(value, dict) else {}
    metadata = default_metadata()
    metadata["title"] = str(source.get("title") or fallback_title).strip()[:64]
    metadata["author"] = str(source.get("author") or "").strip()[:32]
    metadata["digest"] = str(source.get("digest") or "").strip()[:120]
    metadata["source_url"] = str(source.get("source_url") or "").strip()[:2048]
    metadata["need_open_comment"] = bool(source.get("need_open_comment"))
    metadata["only_fans_can_comment"] = bool(source.get("only_fans_can_comment"))
    metadata["show_cover_pic"] = bool(source.get("show_cover_pic"))
    theme = str(source.get("theme") or "technical")
    metadata["theme"] = theme if theme in ALLOWED_THEMES else "technical"
    palette = str(source.get("palette") or "warm")
    metadata["palette"] = palette if palette in ALLOWED_PALETTES else "warm"
    for field, default in default_typography(metadata["theme"]).items():
        candidate = source.get(field, default)
        metadata[field] = (
            candidate
            if type(candidate) is type(default) and candidate in TYPOGRAPHY_VALUES[field]
            else default
        )
    account_id = str(source.get("wechat_account_id") or "").strip()
    if account_id and not WECHAT_ACCOUNT_ID.fullmatch(account_id):
        raise EditorError("公众号账号编号无效")
    metadata["wechat_account_id"] = account_id
    cover = str(source.get("cover") or "").strip()
    metadata["cover"] = safe_asset_path(cover) if cover else ""
    for field in ('published_at', 'imported_at', 'import_fingerprint', 'import_kind', 'source_author', 'source_date'):
        if field in source:
            metadata[field] = str(source[field] or '')[:512]
    if source.get('article_type') in {'tutorial', 'benchmark', 'rocm-repost'}:
        metadata['article_type'] = source['article_type']
    if isinstance(source.get('experiment_conditions'), dict):
        allowed = {'hardware','vram','os_kernel','rocm_version','framework_version','model_version','precision','parallelism','input_output_length','concurrency','test_date','raw_data_source'}
        metadata['experiment_conditions'] = {k:str(v)[:1024] for k,v in source['experiment_conditions'].items() if k in allowed}
    if isinstance(source.get('block_overrides'), dict):
        overrides={}
        for block_id,candidate in sorted(source['block_overrides'].items()):
            if len(overrides)>=200:break
            if not re.fullmatch(r'block-[a-f0-9]{64}',str(block_id)) or not isinstance(candidate,dict):continue
            kind=candidate.get('kind','')
            if not isinstance(kind,str) or not re.fullmatch(r'(?:h[1-6]|p|figcaption|table)',kind):continue
            item={'kind':kind}
            low,high=(15,22) if kind=='p' else (12,16) if kind in {'figcaption','table'} else (18,32)
            for field in ('font_size','margin_before','margin_after','line_height'):
                value=candidate.get(field)
                if (field=='font_size' and type(value) is int and low<=value<=high) or (field.startswith('margin_') and type(value) is int and 0<=value<=48) or (field=='line_height' and type(value) in (int,float) and 1.2<=value<=2.4):item[field]=value
            if len(item)>1:overrides[block_id]=item
        if overrides:metadata['block_overrides']=overrides
    if metadata["source_url"] and not re.match(r"^https?://", metadata["source_url"], re.I):
        raise EditorError("原文链接必须以 http:// 或 https:// 开头")
    return metadata


class DraftStore:
    def __init__(self, root: Path) -> None:
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self.history = DraftHistory(self.root.with_name(self.root.name + '.history'))

    def _draft_dir(self, draft_id: str) -> Path:
        if not DRAFT_ID.fullmatch(draft_id):
            raise EditorError("稿件编号无效", 404)
        path = (self.root / draft_id).resolve()
        if self.root not in path.parents:
            raise EditorError("稿件路径无效", 404)
        return path

    def _paths(self, draft_id: str) -> tuple[Path, Path, Path, Path]:
        folder = self._draft_dir(draft_id)
        return folder, folder / "article.md", folder / "draft.json", folder / "publish-state.json"

    def _revision(self, content: str, metadata: dict[str, Any]) -> str:
        revision_metadata = dict(metadata)
        theme = str(metadata.get("theme") or "")
        defaults = default_typography(theme)
        # Default sizes are equivalent to records saved by the four-field
        # release. Only explicit size changes contribute new revision data.
        for field in TYPOGRAPHY_SIZE_DEFAULTS:
            if metadata.get(field) == defaults[field]:
                revision_metadata.pop(field, None)
        # A missing code theme is the historical "follow article layout"
        # setting. Loading existing drafts must not invalidate their revisions.
        if metadata.get('code_theme', 'auto') == 'auto':
            revision_metadata.pop('code_theme', None)
        if theme in LEGACY_THEMES and all(
            metadata.get(field) == value
            for field, value in defaults.items()
            if field in BASE_TYPOGRAPHY_FIELDS
        ):
            # Equivalent legacy defaults retain historical save/sync revisions.
            for field in BASE_TYPOGRAPHY_FIELDS:
                revision_metadata.pop(field, None)
        serial = json.dumps(revision_metadata, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        return content_sha256(f"{content}\x00{serial}")

    def list(self) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        for folder in self.root.iterdir():
            if not folder.is_dir() or not DRAFT_ID.fullmatch(folder.name):
                continue
            try:
                draft = self.get(folder.name)
            except EditorError:
                continue
            items.append(
                {
                    "id": draft["id"],
                    "title": draft["metadata"]["title"],
                    "digest": draft["metadata"]["digest"],
                    "source_name": draft["source_name"],
                    "updated_at": draft["updated_at"],
                    "publish_status": draft["publish"].get("publish_status", ""),
                }
            )
        return sorted(items, key=lambda item: (item["updated_at"], item["id"]), reverse=True)

    def create(self, content: str, title: str = "", source_name: str = "") -> dict[str, Any]:
        if len(content.encode("utf-8")) > MAX_JSON_BYTES:
            raise EditorError("Markdown 文档过大")
        match = re.search(r"^#\s+(.+?)\s*$", content, re.M)
        inferred = title.strip() or (match.group(1).strip() if match else "") or Path(source_name).stem or "未命名文章"
        with self._lock:
            while True:
                draft_id = f"draft-{datetime.now().strftime('%Y%m%d')}-{secrets.token_hex(4)}"
                folder, article_path, meta_path, state_path = self._paths(draft_id)
                if not folder.exists():
                    break
            now = utc_now()
            folder.mkdir(parents=True)
            metadata = default_metadata(inferred)
            record = {
                "id": draft_id,
                "source_name": Path(source_name).name[:255],
                "created_at": now,
                "updated_at": now,
                "metadata": metadata,
            }
            try:
                atomic_write(article_path, content.encode("utf-8"))
                atomic_json(meta_path, record)
                atomic_json(state_path, {})
            except Exception:
                # A failed first save has no revision to recover from. Remove
                # only the directory just allocated by this locked create.
                shutil.rmtree(folder)
                raise
        return self.get(draft_id)

    def get(self, draft_id: str) -> dict[str, Any]:
        with self._lock:
            return self._get_locked(draft_id)

    def _get_locked(self, draft_id: str) -> dict[str, Any]:
        folder, article_path, meta_path, state_path = self._paths(draft_id)
        transaction = folder / '.save-transaction.json'
        if transaction.is_file():
            # A prepared write is committed as one logical content/metadata pair
            # after process interruption. No user edits are inferred from mtimes.
            try:
                pending = json.loads(transaction.read_text('utf-8'))
                new_content, new_record = pending['content'], pending['record']
                if not isinstance(new_content, str) or new_record.get('id') != draft_id:
                    raise ValueError('Invalid transaction')
                if content_sha256(new_content) != pending['content_hash']:
                    raise ValueError('Corrupt transaction')
                normalize_metadata(new_record.get('metadata'))
                atomic_write(article_path, new_content.encode('utf-8'))
                atomic_json(meta_path, new_record)
                transaction.unlink()
            except (OSError, ValueError, KeyError, TypeError) as exc:
                raise EditorError('稿件保存事务尚未恢复，请保留原目录后检查磁盘', 500) from exc
        if not folder.is_dir() or not article_path.is_file() or not meta_path.is_file():
            raise EditorError("稿件不存在", 404)
        try:
            content = article_path.read_text("utf-8")
            record = json.loads(meta_path.read_text("utf-8"))
            publish = json.loads(state_path.read_text("utf-8")) if state_path.is_file() else {}
        except (OSError, UnicodeError, ValueError) as exc:
            raise EditorError("稿件文件损坏，无法读取", 500) from exc
        metadata = normalize_metadata(record.get("metadata"), "未命名文章")
        selected = metadata.get('wechat_account_id')
        if selected:
            scoped = folder / f'.sync-state-{selected}.json'
            if scoped.is_file():
                try:
                    publish = json.loads(scoped.read_text('utf-8'))
                except (OSError,ValueError) as exc:
                    raise EditorError('账号同步记录损坏，请保留原文件后检查',500) from exc
            elif isinstance(publish,dict) and publish.get('account_id') not in (None,'',selected):
                publish = {}
        return {
            "id": draft_id,
            "content": content,
            "revision": self._revision(content, metadata),
            "source_name": str(record.get("source_name") or ""),
            "created_at": str(record.get("created_at") or ""),
            "updated_at": str(record.get("updated_at") or ""),
            "metadata": metadata,
            "publish": publish if isinstance(publish, dict) else {},
        }

    def save(self, draft_id: str, content: str, metadata: Any, revision: str, reason: str = 'manual-save') -> dict[str, Any]:
        if len(content.encode("utf-8")) > MAX_JSON_BYTES:
            raise EditorError("Markdown 文档过大")
        with self._lock:
            current = self.get(draft_id)
            if revision != current["revision"]:
                raise RevisionConflict()
            normalized = normalize_metadata(metadata, current["metadata"]["title"])
            folder, article_path, meta_path, _ = self._paths(draft_id)
            self.history.capture(current, folder, reason if reason in {'manual-save', 'before-sync', 'proofreading', 'import', 'before-restore'} else 'manual-save')
            record = {
                "id": draft_id,
                "source_name": current["source_name"],
                "created_at": current["created_at"],
                "updated_at": utc_now(),
                "metadata": normalized,
            }
            previous_record = meta_path.read_bytes()
            transaction = folder / '.save-transaction.json'
            atomic_json(transaction, {'content': content, 'content_hash': content_sha256(content), 'record': record})
            try:
                atomic_write(article_path, content.encode('utf-8'))
                atomic_json(meta_path, record)
                transaction.unlink()
            except Exception:
                # Ordinary I/O errors roll back. A process interruption leaves the
                # flushed journal for the next reader to finish the prepared pair.
                atomic_write(article_path, current['content'].encode('utf-8'))
                atomic_write(meta_path, previous_record)
                transaction.unlink(missing_ok=True)
                raise
        return self.get(draft_id)

    def delete(self, draft_id: str) -> None:
        """Move one complete local draft to recoverable trash."""
        with self._lock:
            raw_folder = self.root / draft_id
            if raw_folder.is_symlink():
                raise EditorError("稿件目录无效，无法删除", 400)
            folder = self._draft_dir(draft_id)
            self.get(draft_id)
            try:
                self.history.capture(self.get(draft_id), folder, 'before-delete')
                self.history.trash(draft_id, folder)
            except (OSError, ValueError) as exc:
                raise EditorError("删除稿件失败，请关闭正在占用的文件后重试", 500) from exc

    def restore_version(self, draft_id: str, snapshot_id: str, revision: str) -> dict[str, Any]:
        with self._lock:
            current = self.get(draft_id)
            if current['revision'] != revision:
                raise RevisionConflict()
            snapshot = self.history.read(draft_id, snapshot_id)
            self.history.capture(current, self._draft_dir(draft_id), 'before-restore')
            return self.create_prepared(snapshot['content'], snapshot['metadata'], snapshot.get('source_name', ''), snapshot=snapshot)

    def create_prepared(self, content: str, metadata: dict[str, Any], source_name: str = '', *, assets=(), asset_relations=(), snapshot=None, source_original=None, report=None) -> dict[str, Any]:
        """Materialize a new draft privately, then expose its directory atomically."""
        with self._lock:
            if len(content.encode('utf-8'))>MAX_JSON_BYTES:
                raise EditorError('Markdown 文档过大')
            draft_id = f"draft-{datetime.now().strftime('%Y%m%d')}-{secrets.token_hex(4)}"
            final = self._draft_dir(draft_id)
            stage_parent = Path(tempfile.mkdtemp(prefix='.import-', dir=self.root))
            staging=stage_parent/draft_id
            staging.mkdir()
            try:
                material_paths = set()
                if snapshot is not None:
                    self.history.restore_assets(snapshot, staging)
                    material_paths.update(entry['path'] for entry in snapshot['manifest']['assets'])
                for asset in assets:
                    relative = safe_asset_path(asset['name'])
                    data = asset['bytes']
                    if not isinstance(data, bytes) or not _looks_like_image(data) or len(data) > MAX_IMAGE_BYTES:
                        raise EditorError('导入图片无效或超过 10MB')
                    atomic_write(staging / relative, data)
                    material_paths.add(relative)
                inherited_relations = snapshot is not None and 'asset_relations' in snapshot['manifest']
                default_relations = isinstance(asset_relations, tuple) and not asset_relations
                if not default_relations or inherited_relations:
                    from article_package import MAX_MANIFEST_BYTES, json_bytes, validate_relations
                    raw_relations = snapshot['manifest']['asset_relations'] if default_relations else asset_relations
                    by_path = {}
                    for relative in material_paths:
                        data = (staging / relative).read_bytes()
                        by_path[relative] = {'sha256': hashlib.sha256(data).hexdigest(), 'size': len(data)}
                    portable_relations = validate_relations(raw_relations, by_path)
                    atomic_write(staging / '.asset-relations.json', json_bytes(portable_relations, MAX_MANIFEST_BYTES))
                now = utc_now()
                normalized = normalize_metadata(metadata)
                atomic_write(staging/'article.md', content.encode('utf-8'))
                atomic_json(staging/'draft.json', {'id':draft_id,'source_name':Path(source_name).name[:255],'created_at':now,'updated_at':now,'metadata':normalized})
                atomic_json(staging/'publish-state.json', {})
                if source_original:
                    atomic_write(staging/'source-original.bin', source_original['bytes'])
                    atomic_json(staging/'source-provenance.json', {k:v for k,v in source_original.items() if k!='bytes'})
                if report is not None:
                    atomic_json(staging/'import-report.json', report)
                # Both are resolved children of self.root; only this task's new
                # staging directory may be moved or cleaned up.
                if final.exists():
                    raise EditorError('新稿编号冲突，请重试', 409)
                candidate={'id':draft_id,'content':content,'metadata':normalized,'revision':self._revision(content,normalized),'source_name':Path(source_name).name[:255]}
                self.history.capture(candidate,staging,'import' if snapshot is None else 'restored-copy')
                staging.rename(final)
            except BaseException:
                if stage_parent.exists() and stage_parent.parent.resolve()==self.root and stage_parent.name.startswith('.import-'):
                    shutil.rmtree(stage_parent)
                raise
            stage_parent.rmdir()
            created = self.get(draft_id)
            return created

    def save_publish_state(self, draft_id: str, state: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            folder, _, _, state_path = self._paths(draft_id)
            draft=self.get(draft_id)
            account_id=state.get('account_id')
            if account_id:
                if not WECHAT_ACCOUNT_ID.fullmatch(str(account_id)):
                    raise EditorError('同步记录的账号编号无效')
                atomic_json(folder/f'.sync-state-{account_id}.json', state)
            if not account_id or draft['metadata'].get('wechat_account_id')==account_id:
                atomic_json(state_path, state)
        return self.get(draft_id)

    def get_publish_state(self, draft_id: str, account_id: str) -> dict[str, Any]:
        with self._lock:
            draft=self.get(draft_id)
            if not account_id:
                return dict(draft['publish'])
            if not WECHAT_ACCOUNT_ID.fullmatch(account_id):
                raise EditorError('公众号账号编号无效')
            path=self._draft_dir(draft_id)/f'.sync-state-{account_id}.json'
            if path.is_file():
                value=json.loads(path.read_text('utf-8'))
            else:
                _,_,_,state_path=self._paths(draft_id)
                value=json.loads(state_path.read_text('utf-8')) if state_path.is_file() else {}
            return dict(value) if isinstance(value,dict) and value.get('account_id') in (None,'',account_id) else {}

    def copy_draft(self, draft_id: str, content: str, metadata: dict) -> dict[str, Any]:
        with self._lock:
            current=self.get(draft_id)
            candidate={**current,'content':content,'metadata':normalize_metadata(metadata)}
            candidate['revision']=self._revision(content,candidate['metadata'])
            captured=self.history.capture(candidate,self._draft_dir(draft_id),'conflict-copy')
            snapshot=self.history.read(draft_id,captured['snapshot_id'])
            return self.create_prepared(content,candidate['metadata'],current['source_name'],snapshot=snapshot)

    def asset_path(self, draft_id: str, relative: str, *, must_exist: bool = True) -> Path:
        clean = safe_asset_path(relative)
        folder, _, _, _ = self._paths(draft_id)
        path = (folder / clean).resolve()
        if folder not in path.parents:
            raise EditorError("素材路径无效", 404)
        if must_exist and not path.is_file():
            raise EditorError(f"素材不存在：{clean}", 404)
        return path

    def save_asset(self, draft_id: str, relative: str, encoded: str) -> dict[str, Any]:
        with self._lock:
            return self._save_asset_locked(draft_id,relative,encoded)

    def _save_asset_locked(self, draft_id: str, relative: str, encoded: str) -> dict[str, Any]:
        clean = safe_asset_path(relative)
        try:
            data = base64.b64decode(encoded, validate=True)
        except (ValueError, TypeError) as exc:
            raise EditorError("图片数据无效") from exc
        if not data or len(data) > MAX_IMAGE_BYTES:
            raise EditorError("图片不能为空且不能超过 10MB")
        if not _looks_like_image(data):
            raise EditorError("文件内容不是受支持的图片")
        digest = hashlib.sha256(data).hexdigest()
        path = self.asset_path(draft_id, clean, must_exist=False)
        if path.exists() and path.read_bytes() != data:
            # Uploaded originals may be referenced by historical snapshots,
            # derivations and an accepted sync. A new upload gets a stable
            # content name; callers must use the canonical returned path.
            clean = f'images/upload-{digest}{Path(clean).suffix.lower()}'
            path = self.asset_path(draft_id, clean, must_exist=False)
            if path.exists() and path.read_bytes() != data:
                raise EditorError('素材内容标识冲突，请保留原文件并重新检查', 409)
        if not path.exists():
            atomic_write(path, data)
        return {
            "path": clean,
            "size": len(data),
            "sha256": digest,
        }

    def list_assets(self, draft_id: str) -> list[dict[str, Any]]:
        folder, _, _, _ = self._paths(draft_id)
        self.get(draft_id)
        items: list[dict[str, Any]] = []
        candidates = list(folder.glob("cover.*"))
        images_dir = folder / "images"
        if images_dir.is_dir():
            candidates.extend(images_dir.rglob("*"))
        for path in candidates:
            if not path.is_file():
                continue
            relative = path.relative_to(folder).as_posix()
            try:
                clean = safe_asset_path(relative)
            except EditorError:
                continue
            stat = path.stat()
            items.append(
                {
                    "path": clean,
                    "size": stat.st_size,
                    "content_type": mimetypes.guess_type(path.name)[0]
                    or "application/octet-stream",
                }
            )
        return sorted(
            items,
            key=lambda item: (0 if str(item["path"]).startswith("cover.") else 1, str(item["path"]).lower()),
        )


def _looks_like_image(data: bytes) -> bool:
    return (
        data.startswith(b"\xff\xd8\xff")
        or data.startswith(b"\x89PNG\r\n\x1a\n")
        or data.startswith((b"GIF87a", b"GIF89a"))
        or (len(data) > 12 and data.startswith(b"RIFF") and data[8:12] == b"WEBP")
    )


class WechatApiProtocol(Protocol):
    def upload_content_image(self, path: Path) -> str: ...
    def upload_thumb(self, path: Path) -> str: ...
    def add_draft(self, article: dict[str, Any]) -> str: ...
    def update_draft(self, media_id: str, article: dict[str, Any]) -> None: ...
    def submit_publish(self, media_id: str) -> str: ...
    def publish_status(self, publish_id: str) -> dict[str, Any]: ...


class WechatOpenAPI:
    """Small official-API client with token caching and no browser secrets."""

    API_ROOT = "https://api.weixin.qq.com"

    def __init__(self, app_id: str, app_secret: str, timeout: int = 30) -> None:
        if not app_id or not app_secret:
            raise EditorError("公众号 AppID / AppSecret 尚未配置", 503)
        self.app_id = app_id
        self.app_secret = app_secret
        self.timeout = timeout
        self._access_token = ""
        self._token_deadline = 0.0
        self._lock = threading.Lock()

    @contextlib.contextmanager
    def _open_request(self, request):
        try:
            transport = company_network.from_environment()
            with (transport.open(request, timeout=self.timeout) if transport else
                  urllib.request.urlopen(request, timeout=self.timeout)) as response:
                yield response
        except company_network.CompanyNetworkError as exc:
            error=EditorError(str(exc),503)
            error.definitely_not_sent=True
            raise error from exc

    def _json_request(self, method: str, url: str, payload: Any | None = None) -> dict[str, Any]:
        body = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(url, data=body, method=method)
        request.add_header("Content-Type", "application/json; charset=utf-8")
        try:
            with self._open_request(request) as response:
                result = json.loads(response.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError, ValueError) as exc:
            raise EditorError(f"公众号网络请求失败：{type(exc).__name__}", 502) from exc
        if not isinstance(result, dict):
            raise EditorError("公众号返回了无法识别的数据", 502)
        errcode = int(result.get("errcode", 0) or 0)
        if errcode:
            raise WechatAPIRejected(f"公众号接口错误 {errcode}，请按错误码核对配置与权限", 502)
        return result

    def _token(self) -> str:
        import time

        with self._lock:
            if self._access_token and time.monotonic() < self._token_deadline:
                return self._access_token
            result = self._json_request(
                "POST",
                f"{self.API_ROOT}/cgi-bin/stable_token",
                {
                    "grant_type": "client_credential",
                    "appid": self.app_id,
                    "secret": self.app_secret,
                    "force_refresh": False,
                },
            )
            token = str(result.get("access_token") or "")
            if not token:
                raise EditorError("公众号没有返回 access_token", 502)
            expires = max(300, int(result.get("expires_in", 7200) or 7200) - 300)
            self._access_token = token
            self._token_deadline = time.monotonic() + expires
            return token

    def validate_credentials(self) -> None:
        """Validate AppID, AppSecret and the caller IP without exposing a token."""
        self._token()

    def _url(self, endpoint: str, **query: str) -> str:
        values = {"access_token": self._token(), **query}
        return f"{self.API_ROOT}{endpoint}?{urllib.parse.urlencode(values)}"

    def _post(self, endpoint: str, payload: Any) -> dict[str, Any]:
        return self._json_request("POST", self._url(endpoint), payload)

    def _upload(self, endpoint: str, path: Path, **query: str) -> dict[str, Any]:
        boundary = f"----StarArchive{secrets.token_hex(12)}"
        mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        safe_name = f"upload{path.suffix.lower()}"
        body = (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="media"; filename="{safe_name}"\r\n'
            f"Content-Type: {mime}\r\n\r\n"
        ).encode("utf-8") + path.read_bytes() + f"\r\n--{boundary}--\r\n".encode("ascii")
        request = urllib.request.Request(self._url(endpoint, **query), data=body, method="POST")
        request.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
        try:
            with self._open_request(request) as response:
                result = json.loads(response.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError, ValueError) as exc:
            raise EditorError(f"公众号图片上传失败：{type(exc).__name__}", 502) from exc
        if int(result.get("errcode", 0) or 0):
            raise EditorError(
                f"公众号接口错误 {result.get('errcode')}：{result.get('errmsg', '图片上传失败')}",
                502,
            )
        return result

    def upload_content_image(self, path: Path) -> str:
        result = self._upload("/cgi-bin/media/uploadimg", path)
        url = str(result.get("url") or "")
        if not url:
            raise EditorError("公众号正文图片上传后没有返回 URL", 502)
        return url

    def upload_thumb(self, path: Path) -> str:
        result = self._upload("/cgi-bin/material/add_material", path, type="thumb")
        media_id = str(result.get("media_id") or "")
        if not media_id:
            raise EditorError("公众号封面上传后没有返回 media_id", 502)
        return media_id

    def add_draft(self, article: dict[str, Any]) -> str:
        result = self._post("/cgi-bin/draft/add", {"articles": [article]})
        media_id = str(result.get("media_id") or "")
        if not media_id:
            raise EditorError("公众号新增草稿后没有返回 media_id", 502)
        return media_id

    def update_draft(self, media_id: str, article: dict[str, Any]) -> None:
        self._post("/cgi-bin/draft/update", {"media_id": media_id, "index": 0, "articles": article})

    def get_draft(self, media_id: str) -> dict[str, Any]:
        return self._post('/cgi-bin/draft/get', {'media_id':media_id})

    def get_recent_drafts(self) -> dict[str, Any]:
        return self._post('/cgi-bin/draft/batchget', {'offset':0,'count':20,'no_content':0})

    def submit_publish(self, media_id: str) -> str:
        result = self._post("/cgi-bin/freepublish/submit", {"media_id": media_id})
        publish_id = str(result.get("publish_id") or "")
        if not publish_id:
            raise EditorError("公众号没有返回发布任务编号", 502)
        return publish_id

    def publish_status(self, publish_id: str) -> dict[str, Any]:
        return self._post("/cgi-bin/freepublish/get", {"publish_id": publish_id})


class WechatPublisher:
    def __init__(
        self,
        api: WechatApiProtocol,
        direct_publish_enabled: bool = False,
        *,
        account_id: str = "",
        account_name: str = "",
    ) -> None:
        self.api = api
        self.direct_publish_enabled = direct_publish_enabled
        self.account_id = account_id
        self.account_name = account_name

    def _local_image(self, store: DraftStore, draft_id: str, source: str) -> Path:
        source = html.unescape(source.strip())
        parsed = urllib.parse.urlparse(source)
        if parsed.scheme in ("http", "https") or source.startswith("//"):
            raise EditorError(f"正文包含网络图片，请先下载为本地素材：{source[:100]}")
        prefix = f"/api/editor/drafts/{draft_id}/assets/"
        if source.startswith(prefix):
            relative = source[len(prefix) :]
        else:
            relative = source[2:] if source.startswith("./") else source
        return store.asset_path(draft_id, relative)

    def _replace_images(
        self,
        store: DraftStore,
        draft_id: str,
        source_html: str,
        cache: dict[str, str],
        *, on_image=None,
    ) -> tuple[str, dict[str, str]]:
        if FORBIDDEN_HTML.search(source_html):
            raise EditorError("排版结果包含公众号不支持的危险 HTML 标签")

        # Validate the entire article before the first remote upload. A later
        # missing or unsafe image must not leave partially uploaded content.
        image_paths = {
            match.group("src"): self._local_image(store, draft_id, match.group("src"))
            for match in LOCAL_IMAGE_SRC.finditer(source_html)
        }

        completed=0
        def replace(match: re.Match[str]) -> str:
            nonlocal completed
            path = image_paths[match.group("src")]
            digest = file_sha256(path)
            url = cache.get(digest)
            if not url:
                url = self.api.upload_content_image(path)
                cache[digest] = url
            completed+=1
            if on_image is not None:
                on_image(dict(cache),completed,len(list(LOCAL_IMAGE_SRC.finditer(source_html))))
            return f'{match.group("prefix")}{match.group("quote")}{html.escape(url, quote=True)}{match.group("quote")}'

        return LOCAL_IMAGE_SRC.sub(replace, source_html), cache

    def _validate(self, store: DraftStore, draft: dict[str, Any]) -> Path:
        metadata = draft["metadata"]
        if not metadata["title"]:
            raise EditorError("请填写文章标题")
        if not draft["content"].strip():
            raise EditorError("Markdown 正文不能为空")
        if not metadata["cover"]:
            raise EditorError("请先选择封面图片")
        return store.asset_path(draft["id"], metadata["cover"])

    def sync(
        self,
        store: DraftStore,
        draft_id: str,
        source_html: str,
        source_hash: str,
        theme: str,
        palette: str = "warm",
        *,
        typography: Any | None = None,
        context=None,
        remote_action: str = '',
        expected_remote_hash: str = '',
    ) -> tuple[dict[str, Any], bool]:
        draft = store.get(draft_id)
        if self.account_id and draft["metadata"].get("wechat_account_id") != self.account_id:
            raise EditorError("稿件所选公众号与发布账号不一致")
        actual_hash = content_sha256(draft["content"])
        if not secrets.compare_digest(actual_hash, str(source_hash or "")):
            raise RevisionConflict()
        if theme not in ALLOWED_THEMES or palette not in ALLOWED_PALETTES:
            raise EditorError("公众号版式或配色无效")
        if theme != draft["metadata"]["theme"] or palette != draft["metadata"]["palette"]:
            raise RevisionConflict()
        effective_typography = {field: draft["metadata"][field] for field in TYPOGRAPHY_VALUES}
        typography_defaults = default_typography(theme)
        if typography is None and (
            theme not in LEGACY_THEMES or effective_typography != typography_defaults
        ):
            raise EditorError("请刷新编辑器并重新保存排版选项后再同步", 409)
        if typography is not None:
            if not isinstance(typography, dict):
                raise EditorError("公众号排版选项无效")
            fields = set(typography)
            if fields == BASE_TYPOGRAPHY_FIELDS:
                size_defaults = {field: typography_defaults[field] for field in TYPOGRAPHY_SIZE_DEFAULTS}
                if effective_typography['code_theme'] != 'auto' or any(effective_typography[field] != default for field, default in size_defaults.items()):
                    raise RevisionConflict()
                requested_typography = {**typography, **size_defaults, 'code_theme': 'auto'}
            elif fields == set(TYPOGRAPHY_VALUES) - {'code_font_size', 'code_theme'}:
                # The previous editor sent six typography fields. It can only
                # describe the current draft while code uses the new default.
                if effective_typography['code_theme'] != 'auto' or effective_typography['code_font_size'] != typography_defaults['code_font_size']:
                    raise RevisionConflict()
                requested_typography = {**typography, 'code_font_size': typography_defaults['code_font_size'], 'code_theme': 'auto'}
            elif fields == set(TYPOGRAPHY_VALUES) - {'code_theme'}:
                if effective_typography['code_theme'] != 'auto':
                    raise RevisionConflict()
                requested_typography = {**typography, 'code_theme': 'auto'}
            elif fields == set(TYPOGRAPHY_VALUES):
                requested_typography = typography
            else:
                raise EditorError("公众号排版选项无效")
            for field, expected in effective_typography.items():
                candidate = requested_typography[field]
                if type(candidate) is not type(expected) or candidate not in TYPOGRAPHY_VALUES[field]:
                    raise EditorError("公众号排版选项无效")
            if requested_typography != effective_typography:
                raise RevisionConflict()
        cover_path = self._validate(store, draft)
        if len(source_html.encode("utf-8")) > 5 * 1024 * 1024:
            raise EditorError("公众号排版结果过大")

        publish = dict(draft["publish"])
        if self.account_id and publish.get("account_id") not in (None, "", self.account_id):
            # Remote media IDs and uploaded-image URLs belong to one official
            # account and must never be reused after changing the target.
            publish = {}
        image_cache = publish.get("image_cache")
        if not isinstance(image_cache, dict):
            image_cache = {}
        publish['image_cache']=image_cache
        if self.account_id:
            publish['account_id']=self.account_id
            publish['account_name']=self.account_name
        accepted_remote_hash = ''
        if context:
            from sync_jobs import UnknownRemoteResult,DefinitiveSyncFailure
            from sync_workflow import normalized_remote_article,article_comparison
            context.emit('preflight')
            if hasattr(self.api,'validate_credentials'):
                self.api.validate_credentials()
            checkpoint=context.checkpoint_state
            image_cache.update(checkpoint.get('image_cache') or {})
            if checkpoint.get('thumb_media_id') and checkpoint.get('cover_sha256')==file_sha256(cover_path):
                publish.update(thumb_media_id=checkpoint['thumb_media_id'],cover_sha256=checkpoint['cover_sha256'])
            media_id=str(publish.get('media_id') or '')
            if media_id:
                context.emit('remote-check')
                remote=normalized_remote_article(self.api.get_draft(media_id))
                baseline=publish.get('remote_baseline')
                diff=article_comparison(baseline or remote,remote)
                accepted_remote_hash=diff['current_hash']
                changed=not baseline or not publish.get('remote_verified') or diff['changed']
                if changed:
                    if remote_action not in {'overwrite','copy'} or not secrets.compare_digest(str(expected_remote_hash),diff['current_hash']):
                        raise DefinitiveSyncFailure('remote-conflict')
                elif remote_action in {'overwrite','copy'} and expected_remote_hash and not secrets.compare_digest(str(expected_remote_hash),diff['current_hash']):
                    raise DefinitiveSyncFailure('remote-conflict')
                if remote_action=='copy':
                    publish.pop('media_id',None)
        def checkpoint_image(cache,completed,total):
            publish['image_cache']=dict(cache)
            store.save_publish_state(draft_id,publish)
            if context:
                context.checkpoint(image_cache=dict(cache))
                context.emit('images',completed=completed,total=total)
        try:
            if context:context.emit('images',completed=0,total=len(list(LOCAL_IMAGE_SRC.finditer(source_html))))
            content, image_cache = self._replace_images(store, draft_id, source_html, image_cache, on_image=checkpoint_image)
            cover_hash = file_sha256(cover_path)
            if context:context.emit('cover')
            thumb_media_id = str(publish.get("thumb_media_id") or "") if publish.get("cover_sha256") == cover_hash else ""
            if not thumb_media_id:
                thumb_media_id = self.api.upload_thumb(cover_path)
            publish.update(thumb_media_id=thumb_media_id,cover_sha256=cover_hash)
            store.save_publish_state(draft_id,publish)
            if context:context.checkpoint(thumb_media_id=thumb_media_id,cover_sha256=cover_hash,cover_cache={cover_hash:thumb_media_id})

            metadata = draft["metadata"]
            article = {
                "title": metadata["title"],
                "author": metadata["author"],
                "digest": metadata["digest"],
                "content": content,
                "content_source_url": metadata["source_url"],
                "thumb_media_id": thumb_media_id,
                "show_cover_pic": 1 if metadata["show_cover_pic"] else 0,
                "need_open_comment": 1 if metadata["need_open_comment"] else 0,
                "only_fans_can_comment": 1 if metadata["only_fans_can_comment"] else 0,
            }
            media_id = str(publish.get("media_id") or "")
            created = not bool(media_id)
            if context:
                if media_id:
                    # Uploads can take minutes. Recheck the exact accepted
                    # semantic version immediately before writing. The remote
                    # API has no compare-and-swap, so a small read/write race
                    # remains outside this client's control.
                    context.emit('remote-check')
                    current=normalized_remote_article(self.api.get_draft(media_id))
                    current_hash=article_comparison(current,current)['current_hash']
                    if not secrets.compare_digest(accepted_remote_hash,current_hash):
                        raise DefinitiveSyncFailure('remote-conflict')
                if media_id:context.checkpoint(media_id=media_id)
                context.checkpoint(operation='create' if created else 'update')
                context.emit('remote-write',operation='create' if created else 'update')
            try:
                if created:
                    media_id = self.api.add_draft(article)
                else:
                    self.api.update_draft(media_id, article)
            except Exception as exc:
                if context:
                    if getattr(exc,'definite_rejection',False) or getattr(exc,'definitely_not_sent',False):
                        raise DefinitiveSyncFailure('api-rejected') from exc
                    raise UnknownRemoteResult() from exc
                raise
            if context:
                context.checkpoint(media_id=media_id,remote_write_confirmed=True)
                publish.update(media_id=media_id,remote_verified=False)
                store.save_publish_state(draft_id,publish)
                context.emit('verify')
                try:
                    actual=normalized_remote_article(self.api.get_draft(media_id))
                    verified=not article_comparison(normalized_remote_article(article),actual)['changed']
                    context.checkpoint(remote_snapshot=actual,baseline_hashes={'remote':article_comparison(actual,actual)['current_hash']},remote_verified=verified)
                    publish.update(remote_baseline=actual,remote_baseline_hash=article_comparison(actual,actual)['current_hash'],remote_verified=verified)
                    store.save_publish_state(draft_id,publish)
                    if not verified:
                        raise UnknownRemoteResult()
                except Exception as exc:
                    raise UnknownRemoteResult() from exc
            publish.update(
                {
                    "media_id": media_id,
                    "content_sha256": actual_hash,
                    "draft_revision": draft["revision"],
                    "theme": theme,
                    "palette": palette,
                    "typography": effective_typography,
                    "synced_at": utc_now(),
                    "publish_status": "draft_synced",
                    "image_cache": image_cache,
                    "cover_sha256": cover_hash,
                    "thumb_media_id": thumb_media_id,
                    "last_error": "",
                }
            )
            if self.account_id:
                publish["account_id"] = self.account_id
                publish["account_name"] = self.account_name
            if context:
                from article_package import RENDER_VERSION
                publish.update(render_version=RENDER_VERSION,render_fingerprint=context.snapshot.get('preflight_fingerprint',''),synced_snapshot={'content':draft['content'],'metadata':draft['metadata'],'revision':draft['revision']})
            return store.save_publish_state(draft_id, publish), created
        except Exception as exc:
            publish["last_error"] = '同步未完成，已保留已确认的素材与封面进度'
            publish["failed_at"] = utc_now()
            store.save_publish_state(draft_id, publish)
            raise

    def publish(self, store: DraftStore, draft_id: str) -> dict[str, Any]:
        if not self.direct_publish_enabled:
            raise EditorError("直接发布默认关闭，请先在服务端配置中显式开启", 403)
        draft = store.get(draft_id)
        publish = dict(draft["publish"])
        if self.account_id and draft["metadata"].get("wechat_account_id") != self.account_id:
            raise EditorError("稿件所选公众号与发布账号不一致")
        if self.account_id and publish.get("account_id") != self.account_id:
            raise EditorError("稿件同步账号与当前选择不一致，请重新同步")
        if not publish.get("media_id"):
            raise EditorError("请先同步到公众号草稿箱")
        if publish.get("draft_revision") != draft["revision"]:
            raise EditorError("稿件在同步后发生修改，请重新同步")
        publish_id = self.api.submit_publish(str(publish["media_id"]))
        publish.update(
            publish_id=publish_id,
            publish_status="submitted",
            submitted_at=utc_now(),
            last_error="",
        )
        return store.save_publish_state(draft_id, publish)

    def refresh_status(self, store: DraftStore, draft_id: str) -> dict[str, Any]:
        draft = store.get(draft_id)
        publish = dict(draft["publish"])
        if self.account_id and publish.get("account_id") != self.account_id:
            raise EditorError("稿件同步账号与当前选择不一致，请重新同步")
        publish_id = str(publish.get("publish_id") or "")
        if not publish_id:
            raise EditorError("当前稿件没有待查询的发布任务")
        result = self.api.publish_status(publish_id)
        raw_status = int(result.get("publish_status", 1) or 0)
        labels = {
            0: "publish_success",
            1: "submitted",
            2: "originality_fail",
            3: "publish_fail",
            4: "platform_audit_fail",
            5: "deleted_after_publish",
            6: "banned_after_publish",
        }
        publish["publish_status"] = labels.get(raw_status, f"unknown_{raw_status}")
        publish["status_checked_at"] = utc_now()
        if result.get("article_id"):
            publish["article_id"] = str(result["article_id"])
        detail = result.get("article_detail")
        if isinstance(detail, dict):
            items = detail.get("item")
            if isinstance(items, list) and items and isinstance(items[0], dict):
                publish["article_url"] = str(items[0].get("article_url") or "")
        if result.get("fail_idx") is not None:
            publish["fail_idx"] = result.get("fail_idx")
        return store.save_publish_state(draft_id, publish)


class WechatAccountStore:
    """Server-only multi-account credential store.

    The JSON file must live outside ``web/`` because that directory is served
    as static content. Secrets are never included in public account records.
    """

    def __init__(
        self,
        path: Path,
        *,
        direct_publish_enabled: bool = False,
        api_factory: Any = WechatOpenAPI,
    ) -> None:
        self.path = path.resolve()
        self.direct_publish_enabled = direct_publish_enabled
        self.api_factory = api_factory
        self._lock = threading.RLock()
        self._publishers: dict[str, tuple[str, WechatPublisher]] = {}
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def _load(self) -> list[dict[str, str]]:
        if not self.path.is_file():
            return []
        try:
            payload = json.loads(self.path.read_text("utf-8"))
        except (OSError, UnicodeError, ValueError) as exc:
            raise EditorError("公众号账号配置文件损坏", 500) from exc
        rows = payload.get("accounts") if isinstance(payload, dict) else None
        if not isinstance(rows, list):
            raise EditorError("公众号账号配置格式无效", 500)
        result: list[dict[str, str]] = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            account = {key: str(row.get(key) or "") for key in (
                "id", "name", "app_id", "app_secret", "created_at", "updated_at"
            )}
            if (
                WECHAT_ACCOUNT_ID.fullmatch(account["id"])
                and account["name"]
                and account["app_id"]
                and account["app_secret"]
            ):
                result.append(account)
        return result

    def _save(self, accounts: list[dict[str, str]]) -> None:
        atomic_json(self.path, {"version": 1, "accounts": accounts})
        os.chmod(self.path, 0o600)

    @staticmethod
    def _public(account: dict[str, str]) -> dict[str, str]:
        app_id = account["app_id"]
        hint = app_id if len(app_id) <= 8 else f"{app_id[:4]}…{app_id[-4:]}"
        return {
            "id": account["id"],
            "name": account["name"],
            "app_id_hint": hint,
            "created_at": account["created_at"],
            "updated_at": account["updated_at"],
        }

    @staticmethod
    def _credentials(name: Any, app_id: Any, app_secret: Any) -> tuple[str, str, str]:
        clean_name = str(name or "").strip()
        clean_app_id = str(app_id or "").strip()
        clean_secret = str(app_secret or "").strip()
        if not clean_name or len(clean_name) > 32:
            raise EditorError("账号名称不能为空且不能超过 32 字")
        if not re.fullmatch(r"[A-Za-z0-9_-]{6,64}", clean_app_id):
            raise EditorError("公众号 AppID 格式无效")
        if not re.fullmatch(r"[A-Za-z0-9_-]{16,128}", clean_secret):
            raise EditorError("公众号 AppSecret 格式无效")
        return clean_name, clean_app_id, clean_secret

    def list(self) -> list[dict[str, str]]:
        with self._lock:
            return [self._public(account) for account in self._load()]

    def get(self, account_id: str) -> dict[str, str]:
        if not WECHAT_ACCOUNT_ID.fullmatch(str(account_id or "")):
            raise EditorError("请选择有效的公众号账号")
        with self._lock:
            for account in self._load():
                if account["id"] == account_id:
                    return account
        raise EditorError("所选公众号已被删除或尚未绑定", 404)

    def _validate(self, app_id: str, app_secret: str) -> None:
        api = self.api_factory(app_id, app_secret)
        validator = getattr(api, "validate_credentials", None)
        if not callable(validator):
            raise EditorError("公众号客户端不支持凭据验证", 500)
        validator()

    def create(self, name: Any, app_id: Any, app_secret: Any) -> dict[str, str]:
        clean_name, clean_app_id, clean_secret = self._credentials(name, app_id, app_secret)
        self._validate(clean_app_id, clean_secret)
        with self._lock:
            accounts = self._load()
            if any(item["app_id"] == clean_app_id for item in accounts):
                raise EditorError("这个公众号已经绑定")
            if len(accounts) >= 10:
                raise EditorError("最多绑定 10 个公众号")
            now = utc_now()
            account = {
                "id": f"account-{secrets.token_hex(6)}",
                "name": clean_name,
                "app_id": clean_app_id,
                "app_secret": clean_secret,
                "created_at": now,
                "updated_at": now,
            }
            accounts.append(account)
            self._save(accounts)
            return self._public(account)

    def update(
        self,
        account_id: str,
        name: Any,
        app_id: Any,
        app_secret: Any,
    ) -> dict[str, str]:
        with self._lock:
            accounts = self._load()
            account = next((item for item in accounts if item["id"] == account_id), None)
            if account is None:
                raise EditorError("所选公众号不存在", 404)
            secret = str(app_secret or "").strip() or account["app_secret"]
            clean_name, clean_app_id, clean_secret = self._credentials(name, app_id, secret)
            if any(item["id"] != account_id and item["app_id"] == clean_app_id for item in accounts):
                raise EditorError("这个公众号已经绑定")
        self._validate(clean_app_id, clean_secret)
        with self._lock:
            accounts = self._load()
            account = next((item for item in accounts if item["id"] == account_id), None)
            if account is None:
                raise EditorError("所选公众号不存在", 404)
            account.update(
                name=clean_name,
                app_id=clean_app_id,
                app_secret=clean_secret,
                updated_at=utc_now(),
            )
            self._save(accounts)
            self._publishers.pop(account_id, None)
            return self._public(account)

    def delete(self, account_id: str) -> None:
        with self._lock:
            accounts = self._load()
            kept = [item for item in accounts if item["id"] != account_id]
            if len(kept) == len(accounts):
                raise EditorError("所选公众号不存在", 404)
            self._save(kept)
            self._publishers.pop(account_id, None)

    def publisher(self, account_id: str) -> WechatPublisher:
        account = self.get(account_id)
        fingerprint = content_sha256(f'{account["app_id"]}\x00{account["app_secret"]}')
        with self._lock:
            cached = self._publishers.get(account_id)
            if cached and secrets.compare_digest(cached[0], fingerprint):
                return cached[1]
            publisher = WechatPublisher(
                self.api_factory(account["app_id"], account["app_secret"]),
                direct_publish_enabled=self.direct_publish_enabled,
                account_id=account["id"],
                account_name=account["name"],
            )
            self._publishers[account_id] = (fingerprint, publisher)
            return publisher

def publisher_from_environment() -> WechatPublisher | None:
    app_id = os.environ.get("WECHAT_APP_ID", "").strip()
    app_secret = os.environ.get("WECHAT_APP_SECRET", "").strip()
    if not app_id or not app_secret:
        return None
    direct = os.environ.get("WECHAT_ENABLE_DIRECT_PUBLISH", "").strip().lower() in {"1", "true", "yes", "on"}
    return WechatPublisher(WechatOpenAPI(app_id, app_secret), direct_publish_enabled=direct)


def load_environment_file(path: Path) -> None:
    """Load only the three documented WeChat settings from a local file."""
    allowed = {
        "WECHAT_APP_ID",
        "WECHAT_APP_SECRET",
        "WECHAT_ENABLE_DIRECT_PUBLISH",
    }
    if not path.is_file():
        return
    try:
        lines = path.read_text("utf-8").splitlines()
    except (OSError, UnicodeError):
        return
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        key = key.strip()
        if key not in allowed:
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
            value = value[1:-1]
        os.environ.setdefault(key, value)
