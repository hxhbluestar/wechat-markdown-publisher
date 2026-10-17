"""Local, immutable draft snapshots and an explicitly managed recycle bin.

Keep ``root`` separate from live drafts. Callers hold the live store transaction
while capturing/moving a draft. Snapshots exclude publish/account state; trash
preserves the complete draft directory. No network calls. Permanent deletion
requires explicit confirmation of one trash identifier; nothing expires itself.

All methods raise ValueError for unsafe/corrupt data, FileNotFoundError for
missing records, FileExistsError for conflicts, and OSError for storage failure.
Restore assets into a caller-owned staging draft for crash-atomic publication.
Trash/restore uses atomic same-volume moves; cross-volume moves fail safely.
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
from datetime import datetime, timedelta, timezone
from pathlib import Path


_DRAFT_ID = re.compile(r"draft-[0-9]{8}-[a-f0-9]{8}\Z")
_SNAPSHOT_ID = re.compile(r"snapshot-[a-f0-9]{32}\Z")
_TRASH_ID = re.compile(r"trash-[a-f0-9]{32}\Z")
_SHA256 = re.compile(r"[a-f0-9]{64}\Z")
_RESERVED = re.compile(r"(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?\Z", re.I)
_LOCKS: dict[str, threading.RLock] = {}
_LOCKS_GUARD = threading.Lock()


def _json_bytes(value) -> bytes:
    try:
        return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
    except (ValueError, TypeError, UnicodeError) as exc:
        raise ValueError("History data must be valid JSON") from exc


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _identifier(value: str, pattern: re.Pattern) -> str:
    if not isinstance(value, str) or not pattern.fullmatch(value):
        raise ValueError("Invalid history identifier")
    return value


def _checked_path(path: Path) -> Path:
    """Check the lexical absolute path, before resolution can hide a link."""
    path = Path(os.path.abspath(path))
    for part in (*reversed(path.parents), path):
        if part.is_symlink() or part.is_junction():
            raise ValueError("History paths cannot contain symlinks or junctions")
    return path


def _asset_relative(value: str) -> str:
    if not isinstance(value, str) or not value or "\\" in value:
        raise ValueError("Invalid asset path")
    parts = value.split("/")
    if any(
        not part or part in (".", "..") or part[-1] in " ."
        or _RESERVED.fullmatch(part) or any(ord(c) < 32 or c in ':<>"|?*' for c in part)
        for part in parts
    ):
        raise ValueError("Unsafe asset path")
    if not (len(parts) >= 2 and parts[0] == "images") and not (
        len(parts) == 1 and re.fullmatch(r"cover\.(?:png|jpe?g|gif|webp)", value, re.I)
    ):
        raise ValueError("Assets must be images/ paths or cover images")
    return value


def _tree_files(folder: Path):
    folder = _checked_path(folder)
    if not folder.is_dir():
        raise FileNotFoundError(folder)
    for child in sorted(folder.iterdir()):
        _checked_path(child)
        if child.is_dir():
            yield from _tree_files(child)
        elif child.is_file():
            yield child
        else:
            raise ValueError("Unsupported draft filesystem entry")


def _install(path: Path, data: bytes) -> None:
    """Flush then install without overwriting; readers never see partial bytes."""
    _checked_path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".history-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        _checked_path(path)
        os.link(temporary, path)
    finally:
        os.unlink(temporary)


def _rename_no_replace(source: Path, destination: Path) -> None:
    """Windows rename and Linux renameat2 both reject an existing directory."""
    _checked_path(source)
    _checked_path(destination)
    if destination.exists():
        raise FileExistsError(destination)
    if os.name == "nt":
        os.rename(source, destination)
        return
    # Plain POSIX rename can replace an empty directory created by a racer.
    import ctypes
    import errno
    libc = ctypes.CDLL(None, use_errno=True)
    rename = getattr(libc, "renameat2", None)
    if rename is None:
        raise OSError(errno.ENOTSUP, "Safe no-replace directory moves are unavailable")
    if rename(-100, os.fsencode(source), -100, os.fsencode(destination), 1) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error), str(destination))


class DraftHistory:
    """Snapshots: capture/list/read/restore_assets. Trash: move/list/restore/purge.

    ``manifest.assets`` contains ``path``, ``sha256`` and ``size`` for each
    original local image, including unreferenced images and the cover. Text and
    metadata hashes are in the same manifest. Returned dictionaries are copies.
    ``retention_days=30`` is cleanup advice, never an automatic expiry action.
    """

    def __init__(self, root: Path):
        self.root = _checked_path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        with _LOCKS_GUARD:
            self._thread_lock = _LOCKS.setdefault(os.path.normcase(str(self.root)), threading.RLock())

    def _path(self, *parts: str) -> Path:
        _checked_path(self.root)
        path = _checked_path(self.root.joinpath(*parts))
        if not path.is_relative_to(self.root) or path == self.root:
            raise ValueError("History path escapes its root")
        return path

    def _separate(self, folder: Path) -> Path:
        folder = _checked_path(folder)
        _checked_path(self.root)
        if folder.is_relative_to(self.root) or self.root.is_relative_to(folder):
            raise ValueError("History and live draft directories must be separate")
        return folder

    @contextlib.contextmanager
    def _locked(self):
        """Serialize cooperating threads and processes; locks release on crash."""
        with self._thread_lock:
            lock_path = self._path(".lock")
            with lock_path.open("a+b") as stream:
                if stream.seek(0, os.SEEK_END) == 0:
                    stream.write(b"\0")
                    stream.flush()
                stream.seek(0)
                if os.name == "nt":
                    import msvcrt
                    deadline = time.monotonic() + 30
                    while True:
                        try:
                            msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
                            break
                        except OSError:
                            if time.monotonic() >= deadline:
                                raise TimeoutError("History storage is busy")
                            time.sleep(0.02)
                    try:
                        yield
                    finally:
                        stream.seek(0)
                        msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(stream.fileno(), fcntl.LOCK_EX)
                    try:
                        yield
                    finally:
                        fcntl.flock(stream.fileno(), fcntl.LOCK_UN)

    def _object_path(self, digest: str) -> Path:
        _identifier(digest, _SHA256)
        return self._path("objects", digest[:2], digest)

    def _object(self, entry: dict) -> bytes:
        data = self._object_path(entry["sha256"]).read_bytes()
        if len(data) != entry["size"] or _sha(data) != entry["sha256"]:
            raise ValueError("History asset object is corrupt")
        return data

    def _validate_snapshot(self, snapshot: dict) -> None:
        try:
            _identifier(snapshot["draft_id"], _DRAFT_ID)
            _identifier(snapshot["snapshot_id"], _SNAPSHOT_ID)
            if not isinstance(snapshot["content"], str) or not isinstance(snapshot["metadata"], dict):
                raise ValueError("Invalid snapshot content/metadata")
            manifest = snapshot["manifest"]
            if _sha(snapshot["content"].encode("utf-8")) != manifest["content_sha256"]:
                raise ValueError("Snapshot text is corrupt")
            if _sha(_json_bytes(snapshot["metadata"])) != manifest["metadata_sha256"]:
                raise ValueError("Snapshot metadata is corrupt")
            if not isinstance(manifest["assets"], list):
                raise ValueError("Invalid asset manifest")
            seen = set()
            for entry in manifest["assets"]:
                path = _asset_relative(entry["path"])
                # Case-fold even on POSIX so these snapshots remain Windows-safe.
                if path.casefold() in seen:
                    raise ValueError("Duplicate asset path")
                seen.add(path.casefold())
                _identifier(entry["sha256"], _SHA256)
                if type(entry["size"]) is not int or entry["size"] < 0:
                    raise ValueError("Invalid asset size")
            if 'asset_relations' in manifest:
                from article_package import MAX_MANIFEST_BYTES, json_bytes, validate_relations
                cleaned = validate_relations(manifest['asset_relations'], {entry['path']: entry for entry in manifest['assets']})
                json_bytes(cleaned, MAX_MANIFEST_BYTES)
                if cleaned != manifest['asset_relations']:
                    raise ValueError('Snapshot asset relationships are not canonical')
        except (KeyError, TypeError, AttributeError, UnicodeError) as exc:
            raise ValueError("Malformed history snapshot") from exc

    @staticmethod
    def _summary(snapshot: dict) -> dict:
        return {key: snapshot[key] for key in (
            "draft_id", "snapshot_id", "created_at", "reason", "revision", "title", "asset_count"
        )}

    def capture(self, draft: dict, folder: Path, reason: str) -> dict:
        """Capture the supplied store version and its current original assets."""
        draft_id = _identifier(draft.get("id"), _DRAFT_ID)
        folder = self._separate(folder)
        if folder.name != draft_id:
            raise ValueError("Draft identifier does not match its directory")
        if not isinstance(reason, str) or not reason.strip() or len(reason) > 128:
            raise ValueError("A concise snapshot reason is required")
        if not isinstance(draft.get("content"), str) or not isinstance(draft.get("metadata"), dict):
            raise ValueError("A complete draft is required")
        metadata = json.loads(_json_bytes(draft["metadata"]))
        with self._locked():
            assets = []
            for path in _tree_files(folder):
                relative = path.relative_to(folder).as_posix()
                if not relative.startswith("images/") and not re.fullmatch(r"cover\.(?:png|jpe?g|gif|webp)", relative, re.I):
                    continue
                _asset_relative(relative)
                data = path.read_bytes()
                entry = {"path": relative, "sha256": _sha(data), "size": len(data)}
                object_path = self._object_path(entry["sha256"])
                if object_path.exists():
                    self._object(entry)
                else:
                    _install(object_path, data)
                assets.append(entry)
            snapshot = {
                "draft_id": draft_id, "snapshot_id": "snapshot-" + secrets.token_hex(16),
                "created_at": datetime.now(timezone.utc).isoformat(), "reason": reason,
                "revision": str(draft.get("revision") or ""), "title": str(metadata.get("title") or ""),
                "source_name": str(draft.get("source_name") or ""), "asset_count": len(assets),
                "content": draft["content"], "metadata": metadata,
                "manifest": {"content_sha256": _sha(draft["content"].encode("utf-8")),
                             "metadata_sha256": _sha(_json_bytes(metadata)), "assets": assets},
            }
            relation_path = _checked_path(folder / '.asset-relations.json')
            if relation_path.exists():
                from article_package import MAX_MANIFEST_BYTES, read_package_json, validate_relations
                with relation_path.open('rb') as stream:
                    raw = read_package_json(stream.read(MAX_MANIFEST_BYTES + 1), MAX_MANIFEST_BYTES)
                snapshot['manifest']['asset_relations'] = validate_relations(raw, {entry['path']: entry for entry in assets})
            self._validate_snapshot(snapshot)
            envelope = {"snapshot": snapshot, "sha256": _sha(_json_bytes(snapshot))}
            _install(self._path("snapshots", draft_id, snapshot["snapshot_id"] + ".json"), _json_bytes(envelope))
            return self._summary(snapshot)

    def _read(self, draft_id: str, snapshot_id: str) -> dict:
        path = self._path("snapshots", draft_id, snapshot_id + ".json")
        try:
            envelope = json.loads(path.read_text("utf-8"))
            snapshot = envelope["snapshot"]
            if _sha(_json_bytes(snapshot)) != envelope["sha256"]:
                raise ValueError("History snapshot is corrupt")
            self._validate_snapshot(snapshot)
            if snapshot["draft_id"] != draft_id or snapshot["snapshot_id"] != snapshot_id:
                raise ValueError("Snapshot identity mismatch")
            return snapshot
        except (KeyError, TypeError, UnicodeError) as exc:
            raise ValueError("Malformed history record") from exc

    def read(self, draft_id: str, snapshot_id: str) -> dict:
        """Read and verify immutable text, metadata and manifest identities."""
        _identifier(draft_id, _DRAFT_ID)
        _identifier(snapshot_id, _SNAPSHOT_ID)
        with self._locked():
            return self._read(draft_id, snapshot_id)

    def list(self, draft_id: str) -> list[dict]:
        _identifier(draft_id, _DRAFT_ID)
        with self._locked():
            folder = self._path("snapshots", draft_id)
            if not folder.exists():
                return []
            summaries = [self._summary(self._read(draft_id, path.stem)) for path in folder.glob("snapshot-*.json")]
            return sorted(summaries, key=lambda item: (item["created_at"], item["snapshot_id"]), reverse=True)

    def restore_assets(self, snapshot: dict, folder: Path) -> None:
        """Validate every object before writes; never replace an existing file."""
        folder = self._separate(folder)
        with self._locked():
            self._validate_snapshot(snapshot)
            prepared = []
            for entry in snapshot["manifest"]["assets"]:
                path = _checked_path(folder / entry["path"])
                if not path.is_relative_to(folder):
                    raise ValueError("Asset path escapes destination")
                if path.exists():
                    raise FileExistsError(path)
                prepared.append((path, self._object(entry)))
            if 'asset_relations' in snapshot['manifest']:
                path = _checked_path(folder / '.asset-relations.json')
                if path.exists():
                    raise FileExistsError(path)
                prepared.append((path, _json_bytes(snapshot['manifest']['asset_relations'])))
            installed = []
            try:
                folder.mkdir(parents=True, exist_ok=True)
                for path, data in prepared:
                    _install(path, data)
                    installed.append(path)
            except Exception:
                for path in reversed(installed):
                    _checked_path(path).unlink()
                raise

    def trash(self, draft_id: str, folder: Path) -> dict:
        """Move exactly one checked directory; a prepared record survives crash."""
        _identifier(draft_id, _DRAFT_ID)
        folder = self._separate(folder)
        if folder.name != draft_id:
            raise ValueError("Draft identifier does not match its directory")
        with self._locked():
            # Materialize traversal before any recursive directory move.
            list(_tree_files(folder))
            now = datetime.now(timezone.utc)
            record = {
                "trash_id": "trash-" + secrets.token_hex(16), "draft_id": draft_id,
                "deleted_at": now.isoformat(), "cleanup_after": (now + timedelta(days=30)).isoformat(),
                "retention_days": 30, "automatic_delete": False,
            }
            entry = self._path("trash", record["trash_id"])
            entry.mkdir(parents=True)
            _install(entry / "record.json", _json_bytes(record))
            destination = self._path("trash", record["trash_id"], "draft")
            # Both absolute targets and all source descendants have been checked.
            _rename_no_replace(folder, destination)
            return record

    def _trash_record(self, trash_id: str) -> dict:
        _identifier(trash_id, _TRASH_ID)
        try:
            record = json.loads(self._path("trash", trash_id, "record.json").read_text("utf-8"))
            _identifier(record["draft_id"], _DRAFT_ID)
            if record["trash_id"] != trash_id:
                raise ValueError("Trash identity mismatch")
            return record
        except (KeyError, TypeError, UnicodeError) as exc:
            raise ValueError("Malformed trash record") from exc

    def list_trash(self) -> list[dict]:
        with self._locked():
            trash_root = self._path("trash")
            if not trash_root.exists():
                return []
            records = []
            for entry in trash_root.glob("trash-*"):
                record = self._trash_record(entry.name)
                if self._path("trash", entry.name, "draft").is_dir():
                    records.append(record)
            return sorted(records, key=lambda item: (item["deleted_at"], item["trash_id"]), reverse=True)

    def restore_trash(self, trash_id: str, destination_root: Path) -> str:
        """Return the original draft id; leave collisions and trash intact."""
        _identifier(trash_id, _TRASH_ID)
        destination_root = self._separate(destination_root)
        with self._locked():
            record = self._trash_record(trash_id)
            source = self._path("trash", trash_id, "draft")
            list(_tree_files(source))
            destination = _checked_path(destination_root / record["draft_id"])
            if destination.parent != destination_root:
                raise ValueError("Trash destination escapes live root")
            if destination.exists():
                raise FileExistsError(destination)
            destination_root.mkdir(parents=True, exist_ok=True)
            _rename_no_replace(source, destination)
            return record["draft_id"]

    def purge_trash(self, trash_id: str, confirmation: str = '') -> None:
        """Permanently remove exactly one explicitly confirmed trash directory.

        The caller supplies the exact trash id as confirmation. This shares the
        restore/process lock, rejects every link before removal, and never uses
        record-supplied paths as deletion targets. A restored record has no
        payload and is not purgeable. Snapshots and shared objects remain intact.

        Filesystem failure propagates; removal may be partial. Keep record.json
        until the payload has been removed. No successful return is produced
        when any file or directory removal fails.
        """
        _identifier(trash_id, _TRASH_ID)
        if not isinstance(confirmation, str) or confirmation != trash_id:
            raise ValueError('Permanent deletion requires the exact trash identifier')
        with self._locked():
            self._trash_record(trash_id)
            trash_root = self._path('trash')
            entry = self._path('trash', trash_id)
            payload = self._path('trash', trash_id, 'draft')
            if not payload.is_dir():
                raise FileNotFoundError('Trash payload is missing or has already been restored')
            # Verify lexical and resolved absolute targets before any recursive
            # deletion; neither a record field nor an original live path enters
            # this calculation. Materialize full traversal before the first write.
            if entry.parent != trash_root or entry.resolve().parent != trash_root.resolve():
                raise ValueError('Trash deletion target escapes the recycle bin')
            list(_tree_files(entry))

            def remove_checked(folder: Path) -> None:
                _checked_path(folder)
                for child in sorted(folder.iterdir(), key=lambda path: (folder == entry and path.name == 'record.json', path.name)):
                    child = _checked_path(child)
                    if child.parent != folder or not child.is_relative_to(entry):
                        raise ValueError('Trash deletion target escapes the confirmed record')
                    if child.is_dir():
                        remove_checked(child)
                    elif child.is_file():
                        _checked_path(child).unlink()
                    else:
                        raise ValueError('Unsupported trash filesystem entry')
                _checked_path(folder).rmdir()

            remove_checked(entry)
