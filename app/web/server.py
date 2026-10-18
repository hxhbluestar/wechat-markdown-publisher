#!/usr/bin/env python3
"""
星河炸鸡 · 本地内容归档阅读器

只读扫描既有归档目录，生成内存索引并提供分页、检索、结构化文章和
支持 Range 的本地媒体服务。编辑器按用户操作导入 ROCm 博客或调用微信接口。
"""

from __future__ import annotations

import csv
import company_network
import hashlib
import html
import json
import mimetypes
import os
import re
import secrets
import sys
import unicodedata
import urllib.parse
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime
from email.utils import formatdate
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from editor_service import (
    MAX_JSON_BYTES,
    DraftStore,
    EditorError,
    WechatAccountStore,
    load_environment_file,
)
from archive_service import ArchiveTaskError, ArchiveTaskManager
from editor_security import import_map_csp
from rocm_import import import_rocm
from article_import import prepare_import, ArticleImportError
from article_package import article_package, RENDER_VERSION
from server_preflight import preflight_article
from sync_jobs import SyncJobs,SyncJobConflict,SyncJobCapacityError
from sync_workflow import SyncWorkflow
from sync_verification import verify_job,reconciliation_candidates
from asset_service import inventory,derive_asset,download_asset,record_derivation
from asset_workbench import AssetWorkbenchError


PROJECT_DIR = Path(__file__).resolve().parent.parent
WEB_DIR = Path(__file__).resolve().parent
EDITOR_IMPORT_MAP_CSP = import_map_csp(WEB_DIR / 'editor' / 'index.html')
ARCHIVE_DIR = Path(
    os.environ.get(
        "WECHAT_ARCHIVE_DIR",
        PROJECT_DIR / "output" / "星河炸鸡_公众号全量归档",
    )
).resolve()
INDEX_CSV = ARCHIVE_DIR / "全量文章索引表.csv"
TYPE_OVERRIDES = WEB_DIR / "article-type-overrides.json"
IMAGE_PLACEMENTS = WEB_DIR / "article-image-placements.json"
GENERATED_IMAGE_PLACEMENTS = WEB_DIR / "article-image-placements.generated.json"
IMAGE_EXCLUSIONS = WEB_DIR / "article-image-exclusions.json"
DRAFTS_DIR = Path(
    os.environ.get("WECHAT_DRAFTS_DIR", PROJECT_DIR / "knowledge_base" / "drafts")
).resolve()

# Pure-Python wheels are shipped with the site so Markdown rendering works
# without pip or network access.
for wheel in sorted((WEB_DIR / "vendor" / "wheels").glob("*.whl")):
    sys.path.insert(0, str(wheel))

try:
    from markdown_it import MarkdownIt
except ImportError as exc:  # pragma: no cover - startup guard
    raise SystemExit(
        "缺少本地 Markdown 引擎，请确认 web/vendor/wheels 完整。"
    ) from exc

try:
    from PIL import Image
except ImportError:  # Pillow is optional at reader runtime.
    Image = None


IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif"}
AUDIO_EXTS = {".mp3", ".m4a", ".aac", ".wav", ".ogg", ".flac"}
VIDEO_EXTS = {".mp4", ".webm", ".mov", ".m4v"}
MEDIA_EXTS = IMAGE_EXTS | AUDIO_EXTS | VIDEO_EXTS
TYPE_LABELS = {"normal": "普通图文", "gallery": "图集", "media": "音视频"}
EXTERNAL_LINK = re.compile(r"^(?:https?://|mailto:)", re.I)
LOCAL_REF = re.compile(
    r"(!?\[[^\]]*?\])\((?P<target>(?:images|audio|video)[/\\][^)]+)\)"
)
IMAGE_REF = re.compile(r"!\[[^\]]*?\]\((?P<target>images[/\\][^)]+)\)")
MEDIA_LINK_LINE = re.compile(
    r"^\s*\[?\[[^\]]*(?:音频|视频)[^\]]*\]\]?\((?:audio|video)[/\\][^)]+\)\s*$",
    re.I,
)
WECHAT_PUNCTUATION_LINE = re.compile(r"^[：:，,。.、；;？！!?…·\s]+$")


def json_read(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text("utf-8"))
    except (OSError, ValueError, UnicodeError):
        return default


def normalize_text(value: str) -> str:
    value = unicodedata.normalize("NFC", value or "")
    return (
        value.replace("\ufeff", "")
        .replace("\u200b", "")
        .replace("\u2060", "")
        .replace("\xa0", " ")
        .replace("&nbsp;", " ")
        .replace("\r\n", "\n")
        .replace("\r", "\n")
    )


def strip_markdown(value: str) -> str:
    value = re.sub(r"```.*?```", " ", value, flags=re.S)
    value = re.sub(r"!\[[^\]]*]\([^)]+\)", " ", value)
    value = re.sub(r"\[([^\]]+)]\([^)]+\)", r"\1", value)
    value = re.sub(r"^[#>|*+\-\d.)\s]+", "", value, flags=re.M)
    value = re.sub(r"[`*_~]", "", value)
    return re.sub(r"\s+", " ", html.unescape(value)).strip()


def safe_rel(target: str) -> str | None:
    target = urllib.parse.unquote(target).strip().replace("\\", "/")
    target = target.split("#", 1)[0].split("?", 1)[0]
    if not target or target.startswith("/") or "\x00" in target:
        return None
    parts = [p for p in target.split("/") if p not in ("", ".")]
    if any(part == ".." for part in parts):
        return None
    return "/".join(parts)


def stable_hash(value: str, length: int = 16) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:length]


def image_dimensions(path: Path) -> tuple[int | None, int | None]:
    if Image is None:
        return None, None
    try:
        with Image.open(path) as image:
            return int(image.width), int(image.height)
    except Exception:
        return None, None


def tokenize(value: str) -> set[str]:
    value = unicodedata.normalize("NFKC", value or "").lower()
    result = set(re.findall(r"[a-z0-9][a-z0-9._+-]*", value))
    for run in re.findall(r"[\u3400-\u9fff]+", value):
        result.add(run)
        result.update(run[i : i + 2] for i in range(max(0, len(run) - 1)))
        if len(run) == 1:
            result.add(run)
    return {token for token in result if token}


def make_summary(value: str, limit: int = 118) -> str:
    value = strip_markdown(value)
    if len(value) <= limit:
        return value
    cut = value[:limit]
    boundary = max(cut.rfind(mark) for mark in "。！？；，")
    if boundary >= int(limit * 0.62):
        cut = cut[: boundary + 1]
    return cut.rstrip("，；、 ") + "…"


def strip_wechat_ui_footer(markdown: str) -> str:
    """Remove captured WeChat controls at the article tail, preserving galleries."""
    parts = re.split(r"(^##\s*图库\s*$)", markdown, maxsplit=1, flags=re.M)
    main = parts[0]
    gallery = "".join(parts[1:])
    lines = main.splitlines()
    meaningful = [(index, line.strip()) for index, line in enumerate(lines) if line.strip()]

    cutoff: int | None = None

    # Newer captures contain a complete mini-program permission overlay. Require
    # multiple distinctive phrases so a normal article mentioning WeChat is safe.
    for position, (index, value) in enumerate(meaningful):
        if value != "知道了":
            continue
        window = {item for _, item in meaningful[position : position + 28]}
        if "使用小程序" in window and any(
            item.startswith("微信扫一扫可打开此内容") for item in window
        ):
            cutoff = index
            break

    # Some captures start after the overlay's first button.
    if cutoff is None:
        for position, (index, value) in enumerate(meaningful):
            if value != "微信扫一扫":
                continue
            window = {item for _, item in meaningful[position : position + 28]}
            if "使用小程序" in window and any(
                "轻点两下取消赞" in item for item in window
            ):
                cutoff = index
                break

    # Older captures only retain the accessibility labels. Detect the exact
    # control sequence, then include the preceding punctuation-only OCR debris.
    if cutoff is None:
        values = [value for _, value in meaningful]
        for position in range(max(0, len(values) - 32), len(values)):
            if "轻点两下取消赞" not in values[position]:
                continue
            prefix = values[max(0, position - 5) : position]
            if not {"视频", "小程序", "赞"}.issubset(prefix):
                continue
            video_position = max(
                candidate
                for candidate in range(max(0, position - 5), position)
                if values[candidate] == "视频"
            )
            cutoff = meaningful[video_position][0]
            cursor = cutoff - 1
            while cursor >= 0 and (
                not lines[cursor].strip()
                or WECHAT_PUNCTUATION_LINE.fullmatch(lines[cursor].strip())
            ):
                cutoff = cursor
                cursor -= 1
            break

    if cutoff is None:
        return markdown

    kept = lines[:cutoff]
    while kept and not kept[-1].strip():
        kept.pop()
    if kept and re.fullmatch(r"\s*[-*_]{3,}\s*", kept[-1]):
        kept.pop()
    cleaned = "\n".join(kept).rstrip()
    if gallery:
        return f"{cleaned}\n\n{gallery.lstrip()}".strip()
    return cleaned


def strip_export_envelope(markdown: str, title: str) -> tuple[str, list[str]]:
    """Remove only the exporter-owned wrapper. Return body and warnings."""
    text = normalize_text(markdown)
    warnings: list[str] = []
    lines = text.splitlines()

    # Exact first H1 generated by the exporter.
    if lines and re.match(r"^#\s+", lines[0]):
        first_title = re.sub(r"^#\s+", "", lines[0]).strip()
        if not title or first_title == title.strip():
            lines.pop(0)

    while lines and not lines[0].strip():
        lines.pop(0)

    if lines and lines[0].startswith(">") and "本文由公众号归档工具自动导出" in lines[0]:
        while lines and lines[0].startswith(">"):
            lines.pop(0)
        while lines and not lines[0].strip():
            lines.pop(0)
        if lines and re.match(r"^\s*[-*_]{3,}\s*$", lines[0]):
            lines.pop(0)

    body = "\n".join(lines)

    # Remove the exact exporter footer, not arbitrary article sections.
    body = re.sub(
        r"\n---\s*\n\s*###\s+附件资源\s*\n.*?(?=\n---\s*\n|\n_归档时间:|\Z)",
        "\n",
        body,
        flags=re.S,
    )
    body = re.sub(r"\n---\s*\n\s*_归档时间:[^\n]*_\s*$", "\n", body, flags=re.S)
    body = re.sub(r"\n_归档时间:[^\n]*_\s*$", "\n", body)
    body = re.sub(
        r"^>\s*\*\*原文链接\*\*:\s*\S+\s*$", "", body, flags=re.M
    )
    body = strip_wechat_ui_footer(body)

    if "�" in body:
        warnings.append("正文包含 Unicode 替换字符")
    return re.sub(r"\n{3,}", "\n\n", body).strip(), warnings


def split_gallery(body: str) -> tuple[str, list[str]]:
    parts = re.split(r"^##\s*图库\s*$", body, maxsplit=1, flags=re.M)
    if len(parts) == 1:
        return body, []
    gallery = parts[1]
    refs = []
    for match in IMAGE_REF.finditer(gallery):
        rel = safe_rel(match.group("target"))
        if rel and rel not in refs:
            refs.append(rel)
    main = re.sub(r"\n?[-*_]{3,}\s*$", "", parts[0].rstrip())
    return main.strip(), refs


def workbody_code_cell(value: str) -> tuple[str, str] | None:
    """Recognize code blocks exported as empty-header, one-column tables."""
    value = value.strip()
    labelled = re.match(
        r"^(PowerShell|JSON|Plain Text)(?: {8,})(.*)$",
        value,
        flags=re.S | re.I,
    )
    if labelled:
        label = labelled.group(1).lower()
        language = {
            "powershell": "powershell",
            "json": "json",
            "plain text": "text",
        }[label]
        value = labelled.group(2).strip()
    elif re.match(
        r"^(?:node|npm|pnpm|openclaw|notepad|Set-ExecutionPolicy)\b",
        value,
        flags=re.I,
    ):
        language = "powershell"
    elif value.startswith("OpenClaw: access not configured."):
        language = "text"
    else:
        return None

    # Workbody flattens each original newline into a run of roughly 19 spaces.
    # Extra spaces beyond that base preserve the original indentation.
    parts = re.split(r"( {8,})", value)
    runs = [len(parts[index]) for index in range(1, len(parts), 2)]
    base = min(runs, default=19)
    rebuilt = [parts[0].strip()]
    for index in range(1, len(parts), 2):
        gap = len(parts[index])
        following = parts[index + 1].strip() if index + 1 < len(parts) else ""
        rebuilt.append(" " * max(0, gap - base) + following)
    code = "\n".join(line.rstrip() for line in rebuilt).strip()
    code = re.sub(r"\\([_*])", r"\1", code)
    return language, code


def normalize_workbody_code_blocks(body: str) -> str:
    """Convert exporter pseudo-tables to fenced code without editing source files."""
    lines = body.splitlines()
    rebuilt: list[str] = []
    index = 0
    while index < len(lines):
        if (
            index + 2 < len(lines)
            and re.fullmatch(r"\|\s*\|", lines[index].strip())
            and re.fullmatch(r"\|\s*:?-+:?\s*\|", lines[index + 1].strip())
        ):
            row = lines[index + 2].strip()
            if row.startswith("|") and row.endswith("|"):
                parsed = workbody_code_cell(row[1:-1].strip())
                if parsed:
                    language, code = parsed
                    rebuilt.extend((f"```{language}", code, "```"))
                    index += 3
                    continue
        rebuilt.append(lines[index])
        index += 1

    normalized = "\n".join(rebuilt)
    return re.sub(
        r"(?m)^```[A-Za-z0-9_-]*\s*\n[ \t]*```\s*(?:\n|$)",
        "",
        normalized,
    ).strip()


def apply_image_placements(
    body: str,
    placement_spec: Any,
    resources: dict[str, "Resource"],
    warnings: list[str],
) -> str:
    """Restore inline positions from reviewed text anchors without editing Markdown."""
    if isinstance(placement_spec, dict):
        expected_hash = str(placement_spec.get("body_sha256") or "")
        actual_hash = hashlib.sha256(body.encode("utf-8")).hexdigest()
        if expected_hash and expected_hash != actual_hash:
            warnings.append("行内图片定位已过期，已改用文末附件兜底")
            return body
        placements = placement_spec.get("placements") or []
    else:
        placements = placement_spec
    if not isinstance(placements, list):
        return body

    lines = body.splitlines()
    before_lines: dict[int, list[str]] = defaultdict(list)
    after_lines: dict[int, list[str]] = defaultdict(list)
    anchor_placements: list[dict[str, Any]] = []

    for placement in placements:
        if not isinstance(placement, dict):
            continue
        if "before_line" not in placement and "after_line" not in placement:
            anchor_placements.append(placement)
            continue

        line_key = "before_line" if "before_line" in placement else "after_line"
        try:
            line_index = int(placement[line_key])
        except (TypeError, ValueError):
            continue
        if not lines and line_key == "before_line" and line_index == 0:
            lines = [""]
        if (
            line_key == "before_line"
            and line_index >= 2
            and re.fullmatch(r"\|\s*\|", lines[line_index - 2].strip())
            and re.fullmatch(r"\|\s*:?-+:?\s*\|", lines[line_index - 1].strip())
        ):
            line_index -= 2
        if not 0 <= line_index < len(lines):
            warnings.append(f"行内图片定位行号失效：{line_index}")
            continue

        image_lines = []
        for target in placement.get("images") or []:
            rel = safe_rel(str(target))
            if not rel or rel not in resources:
                warnings.append(f"行内图片定位资源不存在：{target}")
                continue
            image_lines.append(f"![文章配图]({rel})")
        if image_lines:
            target_map = before_lines if line_key == "before_line" else after_lines
            target_map[line_index].extend(image_lines)

    if before_lines or after_lines:
        rebuilt = []
        for index, line in enumerate(lines):
            if before_lines.get(index):
                rebuilt.append("\n\n".join(before_lines[index]))
                rebuilt.append("")
            rebuilt.append(line)
            if after_lines.get(index):
                rebuilt.append("")
                rebuilt.append("\n\n".join(after_lines[index]))
        body = "\n".join(rebuilt)

    for placement in anchor_placements:
        before = str(placement.get("before") or "")
        after = str(placement.get("after") or "")
        anchor = before or after
        images = placement.get("images") or []
        if not anchor or not isinstance(images, list):
            continue

        image_lines = []
        for target in images:
            rel = safe_rel(str(target))
            if not rel or rel not in resources:
                warnings.append(f"行内图片定位资源不存在：{target}")
                continue
            image_lines.append(f"![文章配图]({rel})")
        if not image_lines:
            continue
        if anchor not in body:
            warnings.append(f"行内图片定位锚点失效：{anchor[:28]}")
            continue

        block = "\n\n".join(image_lines)
        replacement = f"{block}\n\n{anchor}" if before else f"{anchor}\n\n{block}"
        body = body.replace(anchor, replacement, 1)
    return body


def remove_excluded_image_refs(body: str, excluded: set[str]) -> str:
    if not excluded:
        return body

    def repl(match: re.Match[str]) -> str:
        rel = safe_rel(match.group("target"))
        return "" if rel in excluded else match.group(0)

    return IMAGE_REF.sub(repl, body)


@dataclass
class Resource:
    resource_id: str
    article_id: str
    kind: str
    rel: str
    path: Path
    name: str
    size: int
    width: int | None = None
    height: int | None = None

    def public(self, *, article: dict[str, Any] | None = None) -> dict[str, Any]:
        data = {
            "id": self.resource_id,
            "kind": self.kind,
            "name": self.name,
            "size": self.size,
            "url": f"/resource/{self.resource_id}",
            "download_url": f"/download/{self.resource_id}",
            "width": self.width,
            "height": self.height,
        }
        if article:
            data.update(
                article_id=article["id"],
                article_title=article["title"],
                year=article["year"],
                article_type=article["type"],
            )
        return data


class ArchiveCatalog:
    def __init__(self) -> None:
        self.articles: list[dict[str, Any]] = []
        self.article_by_id: dict[str, dict[str, Any]] = {}
        self.resources: dict[str, Resource] = {}
        self.postings: dict[str, set[str]] = defaultdict(set)
        self.render_cache: dict[str, dict[str, Any]] = {}
        self.csv_duplicates: list[str] = []
        generated_data = json_read(GENERATED_IMAGE_PLACEMENTS, {})
        manual_data = json_read(IMAGE_PLACEMENTS, {})
        self.image_placements = (
            generated_data if isinstance(generated_data, dict) else {}
        )
        if isinstance(manual_data, dict):
            self.image_placements.update(manual_data)
        exclusion_data = json_read(IMAGE_EXCLUSIONS, {})
        self.image_exclusions: dict[str, set[str]] = {}
        if isinstance(exclusion_data, dict):
            for article_id, spec in exclusion_data.items():
                values = spec.get("images", []) if isinstance(spec, dict) else spec
                if not isinstance(values, list):
                    continue
                cleaned = {
                    rel
                    for value in values
                    if (rel := safe_rel(str(value)))
                }
                if cleaned:
                    self.image_exclusions[str(article_id)] = cleaned
        self._load()

    def _csv_rows(self) -> dict[tuple[str, str], dict[str, str]]:
        if not INDEX_CSV.exists():
            return {}
        with INDEX_CSV.open("r", encoding="utf-8-sig", newline="") as stream:
            rows = list(csv.DictReader(stream))
        counts = Counter(
            (row.get("标题", "").strip(), row.get("发布日期", "")[:10])
            for row in rows
        )
        self.csv_duplicates = [
            title for (title, _), count in counts.items() if count > 1
        ]
        result = {}
        for row in rows:
            key = (row.get("标题", "").strip(), row.get("发布日期", "")[:10])
            result.setdefault(key, row)
        return result

    def _overrides(self) -> dict[str, str]:
        data = json_read(TYPE_OVERRIDES, {})
        if not isinstance(data, dict):
            return {}
        return {
            str(key): value
            for key, value in data.items()
            if value in TYPE_LABELS
        }

    def _article_id(self, meta: dict[str, Any], rel_dir: str) -> str:
        aid = str(meta.get("aid") or "").strip()
        if aid and re.fullmatch(r"[A-Za-z0-9_-]+", aid):
            return "wx-" + aid.replace("_", "-")
        return "local-" + stable_hash(rel_dir, 14)

    def _add_resource(
        self, article_id: str, article_dir: Path, path: Path, kind: str
    ) -> Resource:
        rel = path.relative_to(article_dir).as_posix()
        resource_id = stable_hash(f"{article_id}:{rel}", 20)
        width = height = None
        if kind == "image":
            width, height = image_dimensions(path)
        resource = Resource(
            resource_id=resource_id,
            article_id=article_id,
            kind=kind,
            rel=rel,
            path=path.resolve(),
            name=path.name,
            size=path.stat().st_size,
            width=width,
            height=height,
        )
        self.resources[resource_id] = resource
        return resource

    def _classify(
        self,
        article_id: str,
        title: str,
        meta: dict[str, Any],
        text_chars: int,
        image_count: int,
        audio_count: int,
        video_count: int,
        overrides: dict[str, str],
    ) -> tuple[str, str, list[str]]:
        if article_id in overrides:
            return overrides[article_id], "high", ["人工派生覆盖"]
        if audio_count or video_count:
            reasons = []
            if audio_count:
                reasons.append(f"含 {audio_count} 个音频")
            if video_count:
                reasons.append(f"含 {video_count} 个视频")
            return "media", "high", reasons
        if int(meta.get("show_type", 0) or 0) == 8:
            return "gallery", "high", ["微信 show_type=8"]

        score = 0
        reasons = []
        if image_count >= 20:
            score += 2
            reasons.append(f"图片数 {image_count}≥20")
        elif image_count >= 8:
            score += 1
            reasons.append(f"图片数 {image_count}≥8")
        density = text_chars / max(1, image_count)
        if image_count and density <= 160:
            score += 2
            reasons.append(f"图文密度 {density:.0f} 字/图")
        if re.search(r"图集|随手拍|多图|摄影|作品|拍摄|画作", title):
            score += 1
            reasons.append("标题含图集特征词")
        if score >= 3:
            return "gallery", "medium", reasons
        return "normal", "high" if image_count < 8 else "medium", reasons or ["默认图文"]

    def _load(self) -> None:
        if not ARCHIVE_DIR.is_dir():
            raise SystemExit(f"归档目录不存在：{ARCHIVE_DIR}")
        csv_rows = self._csv_rows()
        overrides = self._overrides()
        seen_ids: set[str] = set()

        for article_dir in sorted(ARCHIVE_DIR.glob("[0-9][0-9][0-9][0-9]/*")):
            md_path = article_dir / "article.md"
            if not article_dir.is_dir() or not md_path.is_file():
                continue
            meta = json_read(article_dir / "metadata.json", {})
            raw = md_path.read_text("utf-8")
            title = str(meta.get("title") or article_dir.name.split("_", 1)[-1]).strip()
            date = str(meta.get("pub_date") or "")
            year = str(meta.get("pub_year") or article_dir.parent.name)
            csv_row = csv_rows.get((title, date[:10]), {})
            if not date:
                date = csv_row.get("发布日期", "")

            rel_dir = article_dir.relative_to(ARCHIVE_DIR).as_posix()
            article_id = self._article_id(meta, rel_dir)
            if article_id in seen_ids:
                article_id = "local-" + stable_hash(rel_dir, 18)
            seen_ids.add(article_id)

            resource_map: dict[str, Resource] = {}
            by_kind: dict[str, list[Resource]] = {
                "image": [],
                "audio": [],
                "video": [],
            }
            for subdir, kind, exts in (
                ("images", "image", IMAGE_EXTS),
                ("audio", "audio", AUDIO_EXTS),
                ("video", "video", VIDEO_EXTS),
            ):
                folder = article_dir / subdir
                if not folder.is_dir():
                    continue
                for path in sorted(folder.iterdir()):
                    if path.is_file() and path.suffix.lower() in exts:
                        resource = self._add_resource(
                            article_id, article_dir, path, kind
                        )
                        resource_map[resource.rel] = resource
                        by_kind[kind].append(resource)

            clean_body, _ = strip_export_envelope(raw, title)
            main_body, gallery_refs = split_gallery(clean_body)
            excluded_image_rels = self.image_exclusions.get(article_id, set())
            excluded_images = [
                resource
                for resource in by_kind["image"]
                if resource.rel in excluded_image_rels
            ]
            by_kind["image"] = [
                resource
                for resource in by_kind["image"]
                if resource.rel not in excluded_image_rels
            ]
            gallery_refs = [
                rel for rel in gallery_refs if rel not in excluded_image_rels
            ]
            text_plain = strip_markdown(main_body)
            text_chars = len(re.sub(r"\s+", "", text_plain))
            article_type, confidence, reasons = self._classify(
                article_id,
                title,
                meta,
                text_chars,
                len(by_kind["image"]),
                len(by_kind["audio"]),
                len(by_kind["video"]),
                overrides,
            )

            digest = str(
                meta.get("digest")
                or csv_row.get("摘要")
                or make_summary(main_body)
            ).strip()
            summary = make_summary(digest or main_body)
            cover = article_dir / "cover.jpg"
            article = {
                "id": article_id,
                "title": title,
                "date": date,
                "year": year,
                "summary": summary,
                "type": article_type,
                "type_label": TYPE_LABELS[article_type],
                "type_confidence": confidence,
                "classification_reasons": reasons,
                "show_type": int(meta.get("show_type", 0) or 0),
                "cover": f"/cover/{article_id}" if cover.is_file() else "",
                "read_count": meta.get("read_count") or csv_row.get("阅读量") or None,
                "like_count": meta.get("like_count") or csv_row.get("在看数") or None,
                "url": str(meta.get("url") or csv_row.get("原文链接") or ""),
                "image_count": len(by_kind["image"]),
                "audio_count": len(by_kind["audio"]),
                "video_count": len(by_kind["video"]),
                "_dir": article_dir.resolve(),
                "_md": md_path.resolve(),
                "_meta": meta,
                "_cover": cover.resolve() if cover.is_file() else None,
                "_resources": resource_map,
                "_by_kind": by_kind,
                "_gallery_refs": gallery_refs,
                "_excluded_image_rels": excluded_image_rels,
                "_excluded_images": excluded_images,
                "_search_body": text_plain,
            }
            self.articles.append(article)
            self.article_by_id[article_id] = article

        self.articles.sort(
            key=lambda article: (article["date"], article["title"]), reverse=True
        )
        for article in self.articles:
            search_value = " ".join(
                (article["title"], article["summary"], article["_search_body"])
            )
            for token in tokenize(search_value):
                self.postings[token].add(article["id"])

    def public_article(self, article: dict[str, Any]) -> dict[str, Any]:
        return {key: value for key, value in article.items() if not key.startswith("_")}

    def stats(self) -> dict[str, Any]:
        type_counts = Counter(article["type"] for article in self.articles)
        years = Counter(article["year"] for article in self.articles)
        return {
            "articles": len(self.articles),
            "images": sum(article["image_count"] for article in self.articles),
            "audio": sum(article["audio_count"] for article in self.articles),
            "video": sum(article["video_count"] for article in self.articles),
            "comments": 0,
            "years": dict(sorted(years.items(), reverse=True)),
            "types": {key: type_counts.get(key, 0) for key in TYPE_LABELS},
            "duplicates_removed": len(self.csv_duplicates),
            "archive_updated": max(
                (article["date"] for article in self.articles), default=""
            ),
        }

    def _filtered(
        self,
        *,
        year: str = "all",
        article_type: str = "all",
        query: str = "",
        sort: str = "date_desc",
    ) -> list[dict[str, Any]]:
        items = self.articles
        if year != "all":
            items = [article for article in items if article["year"] == year]
        if article_type != "all":
            items = [
                article for article in items if article["type"] == article_type
            ]
        if query:
            ranked = self.search(query, year=year, article_type=article_type)
            return [self.article_by_id[item["id"]] for item in ranked]
        if sort == "date_asc":
            return list(reversed(items))
        if sort == "title":
            return sorted(items, key=lambda article: article["title"])
        return list(items)

    def article_page(
        self,
        *,
        page: int,
        page_size: int,
        year: str,
        article_type: str,
        query: str,
        sort: str,
    ) -> dict[str, Any]:
        items = self._filtered(
            year=year, article_type=article_type, query=query, sort=sort
        )
        total = len(items)
        total_pages = max(1, (total + page_size - 1) // page_size)
        page = min(max(1, page), total_pages)
        start = (page - 1) * page_size
        return {
            "items": [
                self.public_article(article)
                for article in items[start : start + page_size]
            ],
            "page": page,
            "page_size": page_size,
            "total": total,
            "total_pages": total_pages,
            "facets": self.stats(),
        }

    def search(
        self, query: str, *, year: str = "all", article_type: str = "all"
    ) -> list[dict[str, Any]]:
        normalized = unicodedata.normalize("NFKC", query).lower().strip()
        if not normalized:
            return []
        query_tokens = tokenize(normalized)
        candidate_ids: set[str] = set()
        for token in query_tokens:
            candidate_ids.update(self.postings.get(token, set()))
        if not candidate_ids:
            candidate_ids = set(self.article_by_id)

        results = []
        for article_id in candidate_ids:
            article = self.article_by_id[article_id]
            if year != "all" and article["year"] != year:
                continue
            if article_type != "all" and article["type"] != article_type:
                continue
            title = article["title"].lower()
            summary = article["summary"].lower()
            body = article["_search_body"].lower()
            score = 0
            if title == normalized:
                score += 120
            elif normalized in title:
                score += 70
            if normalized in summary:
                score += 30
            if normalized in body:
                score += 10 + min(20, body.count(normalized) * 2)
            score += sum(
                4 for token in query_tokens if token in tokenize(title)
            )
            if score <= 0:
                continue
            source = article["_search_body"]
            index = source.lower().find(normalized)
            if index < 0:
                snippet = article["summary"]
            else:
                start = max(0, index - 42)
                snippet = source[start : index + len(query) + 74].strip()
                if start:
                    snippet = "…" + snippet
                if index + len(query) + 74 < len(source):
                    snippet += "…"
            results.append(
                {
                    **self.public_article(article),
                    "score": score,
                    "snippet": snippet,
                }
            )
        results.sort(
            key=lambda item: (item["score"], item["date"]), reverse=True
        )
        return results

    def _replace_refs(
        self, markdown: str, article: dict[str, Any], warnings: list[str]
    ) -> str:
        resource_map: dict[str, Resource] = article["_resources"]

        def repl(match: re.Match[str]) -> str:
            rel = safe_rel(match.group("target"))
            resource = resource_map.get(rel or "")
            if not resource:
                warnings.append(f"资源不存在或路径非法：{match.group('target')}")
                return match.group(1) + "(#missing-resource)"
            return f"{match.group(1)}(/resource/{resource.resource_id})"

        return LOCAL_REF.sub(repl, markdown)

    def render_article(self, article_id: str) -> dict[str, Any] | None:
        article = self.article_by_id.get(article_id)
        if not article:
            return None
        if article_id in self.render_cache:
            return self.render_cache[article_id]

        raw = article["_md"].read_text("utf-8")
        body, warnings = strip_export_envelope(raw, article["title"])
        body, gallery_refs = split_gallery(body)
        excluded_image_rels: set[str] = article["_excluded_image_rels"]
        gallery_refs = [
            rel for rel in gallery_refs if rel not in excluded_image_rels
        ]
        body = apply_image_placements(
            body,
            self.image_placements.get(article_id, []),
            article["_resources"],
            warnings,
        )
        body = remove_excluded_image_refs(body, excluded_image_rels)
        body = normalize_workbody_code_blocks(body)
        body = "\n".join(
            line for line in body.splitlines() if not MEDIA_LINK_LINE.match(line)
        )
        body = self._replace_refs(body, article, warnings)

        parser = MarkdownIt(
            "js-default",
            {
                "html": False,
                "linkify": False,
                "typographer": False,
                "breaks": False,
            },
        )
        parser.enable(["table", "strikethrough"])
        tokens = parser.parse(body)
        headings = []
        used_slugs: Counter[str] = Counter()
        for index, token in enumerate(tokens):
            if token.type == "heading_open":
                inline = tokens[index + 1] if index + 1 < len(tokens) else None
                heading_text = inline.content.strip() if inline else ""
                base = re.sub(
                    r"-+", "-", re.sub(r"[^\w\u3400-\u9fff]+", "-", heading_text)
                ).strip("-").lower()
                base = base or f"section-{len(headings) + 1}"
                used_slugs[base] += 1
                slug = base if used_slugs[base] == 1 else f"{base}-{used_slugs[base]}"
                heading_id = f"{article_id}-{slug}"
                token.attrSet("id", heading_id)
                level = int(token.tag[1]) if token.tag.startswith("h") else 2
                if level in (2, 3):
                    headings.append(
                        {"id": heading_id, "text": heading_text, "level": level}
                    )
            if token.type == "inline" and token.children:
                for child in token.children:
                    if child.type == "image":
                        child.attrSet("loading", "lazy")
                        child.attrSet("decoding", "async")
                    elif child.type == "link_open":
                        href = child.attrGet("href") or ""
                        if EXTERNAL_LINK.match(href):
                            child.attrSet("target", "_blank")
                            child.attrSet("rel", "noopener noreferrer")
                            child.attrJoin("class", "external-link")

        content_html = parser.renderer.render(tokens, parser.options, {})
        resource_map: dict[str, Resource] = article["_resources"]
        image_resources = []
        referenced: set[str] = set()
        for rel in gallery_refs or article["_gallery_refs"]:
            resource = resource_map.get(rel)
            if resource and resource.resource_id not in referenced:
                image_resources.append(resource.public())
                referenced.add(resource.resource_id)
            elif not resource:
                warnings.append(f"图库引用不存在：{rel}")

        # Future archives may keep inline images. Do not append those again.
        inline_ids = set(re.findall(r"/resource/([a-f0-9]{20})", content_html))
        image_resources = [
            item for item in image_resources if item["id"] not in inline_ids
        ]
        all_images: list[Resource] = article["_by_kind"]["image"]
        all_image_ids = {resource.resource_id for resource in all_images}
        recovered_ids = all_image_ids - referenced - inline_ids
        if recovered_ids:
            # Some Workbody exports saved the image files but omitted one or all
            # Markdown gallery references. The filenames retain capture order,
            # so rebuild the appendix from the complete local sequence.
            image_resources = [
                resource.public()
                for resource in all_images
                if resource.resource_id not in inline_ids
            ]

        audio = [
            resource.public(article=article)
            for resource in article["_by_kind"]["audio"]
        ]
        video = [
            resource.public(article=article)
            for resource in article["_by_kind"]["video"]
        ]
        position = self.articles.index(article)
        newer = self.articles[position - 1] if position > 0 else None
        older = (
            self.articles[position + 1]
            if position + 1 < len(self.articles)
            else None
        )
        result = {
            **self.public_article(article),
            "content_html": content_html,
            "headings": headings,
            "images": image_resources,
            "recovered_image_count": len(recovered_ids),
            "hidden_image_count": len(article["_excluded_images"]),
            "audio": audio,
            "video": video,
            "warnings": sorted(set(warnings)),
            "neighbors": {
                "newer": self.public_article(newer) if newer else None,
                "older": self.public_article(older) if older else None,
            },
        }
        self.render_cache[article_id] = result
        return result

    def media_page(
        self,
        kind: str,
        *,
        page: int,
        page_size: int,
        year: str,
    ) -> dict[str, Any]:
        items: list[dict[str, Any]] = []
        for article in self.articles:
            if year != "all" and article["year"] != year:
                continue
            for resource in article["_by_kind"].get(kind, []):
                items.append(resource.public(article=article))
        total = len(items)
        total_pages = max(1, (total + page_size - 1) // page_size)
        page = min(max(1, page), total_pages)
        start = (page - 1) * page_size
        return {
            "items": items[start : start + page_size],
            "page": page,
            "page_size": page_size,
            "total": total,
            "total_pages": total_pages,
        }


CATALOG = ArchiveCatalog()
DRAFT_STORE = DraftStore(DRAFTS_DIR)
load_environment_file(WEB_DIR / "wechat.env")
WECHAT_ACCOUNTS_FILE = Path(
    os.environ.get(
        "WECHAT_ACCOUNTS_FILE",
        PROJECT_DIR / "knowledge_base" / "private" / "wechat-accounts.json",
    )
).resolve()
WECHAT_ACCOUNTS = WechatAccountStore(
    WECHAT_ACCOUNTS_FILE,
    direct_publish_enabled=os.environ.get("WECHAT_ENABLE_DIRECT_PUBLISH", "")
    .strip()
    .lower()
    in {"1", "true", "yes", "on"},
)
SYNC_JOBS=SyncJobs(Path(os.environ.get('WECHAT_SYNC_JOBS_DIR',DRAFTS_DIR.with_name(DRAFTS_DIR.name+'.sync-jobs'))))
SYNC_WORKFLOW=SyncWorkflow(DRAFT_STORE,SYNC_JOBS,WECHAT_ACCOUNTS)
ARCHIVE_MANAGER = ArchiveTaskManager(PROJECT_DIR)
EDITOR_TOKEN = secrets.token_urlsafe(32)


def query_int(query: dict[str, list[str]], key: str, default: int) -> int:
    try:
        return int(query.get(key, [str(default)])[0])
    except (TypeError, ValueError):
        return default


class Handler(SimpleHTTPRequestHandler):
    server_version = "StarArchive/1.0"

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(WEB_DIR), **kwargs)

    def send_head(self):
        # Mutable application files must never inherit the browser's heuristic
        # freshness or a stale If-Modified-Since validator. Archived media uses
        # its independent send_file_safe cache/range behavior.
        path = urllib.parse.unquote(urllib.parse.urlsplit(self.path).path).lower()
        self._fresh_frontend = path in {'/', '/editor', '/editor/'} or path.endswith(('.html', '.css', '.js', '.mjs'))
        if self._fresh_frontend:
            for header in ('If-Modified-Since', 'If-None-Match'):
                if header in self.headers:
                    del self.headers[header]
        try:
            return super().send_head()
        finally:
            self._fresh_frontend = False

    def end_headers(self) -> None:
        if getattr(self, '_fresh_frontend', False):
            self.send_header('Cache-Control', 'no-store')
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        if self.path.startswith("/editor"):
            policy = (
                "default-src 'self'; img-src 'self' data: blob:; media-src 'self'; "
                f"style-src 'self' 'unsafe-inline'; script-src 'self'{EDITOR_IMPORT_MAP_CSP}; connect-src 'self'; "
                "object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
            )
        else:
            policy = (
                "default-src 'self'; img-src 'self' data:; media-src 'self'; "
                "style-src 'self'; script-src 'self'; object-src 'none'; "
                "base-uri 'none'; frame-ancestors 'none'"
            )
        self.send_header("Content-Security-Policy", policy)
        super().end_headers()

    def do_GET(self) -> None:
        try:
            parsed = urllib.parse.urlparse(self.path)
            path = urllib.parse.unquote(parsed.path)
            query = urllib.parse.parse_qs(parsed.query)

            if path == "/api/editor/config":
                account_count = len(WECHAT_ACCOUNTS.list())
                return self.send_json(
                    {
                        "csrf_token": EDITOR_TOKEN,
                        "wechat_configured": account_count > 0,
                        "wechat_account_count": account_count,
                        "direct_publish_enabled": WECHAT_ACCOUNTS.direct_publish_enabled,
                        "drafts_dir": str(DRAFTS_DIR),
                        "render_version": RENDER_VERSION,
                        "network": company_network.network_status(),
                    }
                )
            if path == "/api/wechat/network":
                self.require_editor_auth()
                return self.send_json(company_network.network_status())
            if path == "/api/wechat/accounts":
                self.require_editor_auth()
                return self.send_json({"items": WECHAT_ACCOUNTS.list()})
            if path == "/api/wechat/archive/status":
                self.require_editor_auth()
                return self.send_json(ARCHIVE_MANAGER.snapshot())
            if path == "/api/editor/drafts":
                return self.send_json({"items": DRAFT_STORE.list()})
            if path=='/api/editor/sync-jobs':
                self.require_editor_auth()
                return self.send_json({'items':SYNC_JOBS.list(query.get('draft_id',[None])[0],limit=100)})
            job_match=re.fullmatch(r'/api/editor/sync-jobs/(?P<job>job-[a-f0-9]{32})',path)
            if job_match:
                self.require_editor_auth()
                try:job=SYNC_JOBS.get(job_match['job'])
                except FileNotFoundError:raise EditorError('同步任务不存在',404)
                return self.send_json({'job':job})
            if path == '/api/editor/trash':
                self.require_editor_auth()
                return self.send_json({'items': DRAFT_STORE.history.list_trash(), 'retention_days':30})
            report_match=re.fullmatch(r'/api/editor/drafts/(?P<draft>[^/]+)/import-report',path)
            if report_match:
                self.require_editor_auth()
                DRAFT_STORE.get(report_match['draft'])
                folder=DRAFT_STORE._draft_dir(report_match['draft'])
                report=json.loads((folder/'import-report.json').read_text('utf-8')) if (folder/'import-report.json').is_file() else None
                source=json.loads((folder/'source-provenance.json').read_text('utf-8')) if (folder/'source-provenance.json').is_file() else {}
                original=''
                if source.get('kind') in {'md','html'} and (folder/'source-original.bin').is_file():
                    original=(folder/'source-original.bin').read_bytes()[:1024*1024].decode('utf-8-sig',errors='replace')
                return self.send_json({'report':report,'source':source,'original_text':original})
            history_match = re.fullmatch(r'/api/editor/drafts/(?P<draft>[^/]+)/history(?:/(?P<snapshot>[^/]+))?', path)
            if history_match:
                self.require_editor_auth()
                DRAFT_STORE.get(history_match['draft'])
                if history_match['snapshot']:
                    return self.send_json(DRAFT_STORE.history.read(history_match['draft'],history_match['snapshot']))
                return self.send_json({'items':DRAFT_STORE.history.list(history_match['draft'])})
            export_match = re.fullmatch(r'/api/editor/drafts/(?P<draft>[^/]+)/export',path)
            if export_match:
                self.require_editor_auth()
                data=article_package(DRAFT_STORE,export_match['draft'])
                self.send_response(200)
                self.send_header('Content-Type','application/zip')
                self.send_header('Content-Disposition','attachment; filename="article-package.zip"')
                self.send_header('Content-Length',str(len(data)))
                self.send_header('Cache-Control','no-store')
                self.end_headers()
                self.wfile.write(data)
                return
            assets_match = re.fullmatch(
                r"/api/editor/drafts/(?P<draft>[^/]+)/assets", path
            )
            if assets_match:
                return self.send_json(
                    {"items": inventory(DRAFT_STORE,assets_match.group("draft"))}
                )
            asset_match = re.fullmatch(
                r"/api/editor/drafts/(?P<draft>[^/]+)/assets/(?P<asset>.+)", path
            )
            if asset_match:
                asset = DRAFT_STORE.asset_path(
                    asset_match.group("draft"), asset_match.group("asset")
                )
                return self.send_draft_asset(asset)
            draft_match = re.fullmatch(r"/api/editor/drafts/(?P<draft>[^/]+)", path)
            if draft_match:
                return self.send_json(DRAFT_STORE.get(draft_match.group("draft")))
            status_match = re.fullmatch(
                r"/api/wechat/drafts/(?P<draft>[^/]+)/status", path
            )
            if status_match:
                draft_id = status_match.group("draft")
                if query.get("refresh", [""])[0] in {"1", "true"}:
                    self.require_editor_auth()
                    publisher = self.publisher_for_draft(draft_id, prefer_publish=True)
                    return self.send_json({"draft": publisher.refresh_status(DRAFT_STORE, draft_id)})
                return self.send_json({"draft": DRAFT_STORE.get(draft_id)})
            if path == "/api/stats":
                return self.send_json(CATALOG.stats())
            if path == "/api/articles":
                return self.send_json(
                    CATALOG.article_page(
                        page=query_int(query, "page", 1),
                        page_size=min(48, max(1, query_int(query, "page_size", 24))),
                        year=query.get("year", ["all"])[0],
                        article_type=query.get("type", ["all"])[0],
                        query=query.get("q", [""])[0].strip(),
                        sort=query.get("sort", ["date_desc"])[0],
                    )
                )
            if path.startswith("/api/article/"):
                article_id = path.rsplit("/", 1)[-1]
                article = CATALOG.render_article(article_id)
                if not article:
                    return self.send_error_json(404, "文章不存在")
                return self.send_json(article)
            if path == "/api/search":
                term = query.get("q", [""])[0].strip()
                results = CATALOG.search(
                    term,
                    year=query.get("year", ["all"])[0],
                    article_type=query.get("type", ["all"])[0],
                )
                return self.send_json(
                    {"query": term, "items": results[:50], "total": len(results)}
                )
            if path == "/api/media":
                kind = query.get("kind", ["image"])[0]
                if kind not in ("image", "audio", "video"):
                    return self.send_error_json(400, "不支持的媒体类型")
                return self.send_json(
                    CATALOG.media_page(
                        kind,
                        page=query_int(query, "page", 1),
                        page_size=min(60, max(1, query_int(query, "page_size", 48))),
                        year=query.get("year", ["all"])[0],
                    )
                )
            if path.startswith("/resource/"):
                return self.send_resource(path.rsplit("/", 1)[-1])
            if path.startswith("/download/"):
                return self.send_resource(path.rsplit("/", 1)[-1], download=True)
            if path.startswith("/cover/"):
                article = CATALOG.article_by_id.get(path.rsplit("/", 1)[-1])
                if not article or not article["_cover"]:
                    return self.send_error_json(404, "封面不存在")
                return self.send_file_safe(article["_cover"])
            return super().do_GET()
        except EditorError as exc:
            return self.send_error_json(exc.status, str(exc))
        except (BrokenPipeError, ConnectionResetError):
            return
        except Exception as exc:
            if os.environ.get("ARCHIVE_DEBUG"):
                raise
            return self.send_error_json(500, f"本地服务异常：{type(exc).__name__}")

    def do_POST(self) -> None:
        try:
            parsed = urllib.parse.urlparse(self.path)
            path = urllib.parse.unquote(parsed.path)
            self.require_editor_auth()
            payload = self.read_json_body()

            if path == "/api/wechat/network/check":
                try:
                    transport = company_network.from_environment()
                    if transport:
                        transport.check()
                    return self.send_json(company_network.network_status())
                except company_network.CompanyNetworkError as exc:
                    return self.send_json({**company_network.network_status(), "last_error": str(exc)}, 503)

            if path == "/api/editor/drafts":
                if isinstance(payload.get('metadata'),dict):
                    draft=DRAFT_STORE.create_prepared(str(payload.get('content') or ''),payload['metadata'],str(payload.get('source_name') or ''))
                    return self.send_json(draft,201)
                draft = DRAFT_STORE.create(
                    str(payload.get("content") or ""),
                    title=str(payload.get("title") or ""),
                    source_name=str(payload.get("source_name") or ""),
                )
                return self.send_json(draft, 201)

            if path == "/api/editor/import-rocm":
                try:
                    draft = import_rocm(DRAFT_STORE, payload.get("url"), preview_only=payload.get('preview_only') is True, allow_duplicate=payload.get('allow_duplicate') is True)
                except EditorError as exc:
                    if exc.status==409 and hasattr(exc,'duplicates'):
                        return self.send_json({'error':str(exc),'duplicates':exc.duplicates,'report':getattr(exc,'report',{})},409)
                    raise
                if payload.get('preview_only') is True:
                    return self.send_json(draft)
                return self.send_json({"draft": draft}, 201)

            if path == '/api/editor/import':
                import base64
                try:
                    data=base64.b64decode(str(payload.get('data') or ''),validate=True)
                    prepared=prepare_import(str(payload.get('filename') or ''),data,kind=str(payload.get('kind') or 'auto'),base_url=str(payload.get('source_url') or ''),metadata=payload.get('metadata'))
                except (ValueError,TypeError) as exc:
                    return self.send_json({'error':str(exc),'report':getattr(exc,'report',{})},400)
                fingerprint=prepared['metadata']['import_fingerprint']
                source_url=prepared['metadata'].get('source_url')
                duplicates=[]
                for item in DRAFT_STORE.list():
                    existing=DRAFT_STORE.get(item['id'])
                    meta=existing['metadata']
                    if meta.get('import_fingerprint')==fingerprint or (source_url and meta.get('source_url')==source_url) or existing['content']==prepared['content']:
                        duplicates.append({'id':item['id'],'title':item['title']})
                if payload.get('preview_only') is True:
                    return self.send_json({'title':prepared['title'],'report':prepared['report'],'duplicates':duplicates,'preview_content':prepared['content'][:512*1024]})
                if duplicates and payload.get('allow_duplicate') is not True:
                    return self.send_json({'error':'已存在相同来源或内容的稿件；确认后可创建新版本副本','duplicates':duplicates,'report':prepared['report']},409)
                draft=DRAFT_STORE.create_prepared(prepared['content'],prepared['metadata'],str(payload.get('filename') or ''),assets=prepared['assets'],source_original=prepared['source_original'],report=prepared['report'],asset_relations=prepared.get('asset_relations',()))
                return self.send_json({'draft':draft,'report':prepared['report'],'duplicates':duplicates},201)

            copy_match=re.fullmatch(r'/api/editor/drafts/(?P<draft>[^/]+)/copy',path)
            if copy_match:
                draft=DRAFT_STORE.copy_draft(copy_match['draft'],str(payload.get('content') or ''),payload.get('metadata') or {})
                return self.send_json({'draft':draft},201)
            preflight_match=re.fullmatch(r'/api/editor/drafts/(?P<draft>[^/]+)/preflight',path)
            if preflight_match:
                with DRAFT_STORE._lock:
                    draft=DRAFT_STORE.get(preflight_match['draft'])
                    report=preflight_article(DRAFT_STORE,draft,str(payload.get('html') or ''),str(payload.get('render_version') or ''),str(payload.get('account_id') or ''))
                return self.send_json(report)
            snapshot_match=re.fullmatch(r'/api/editor/drafts/(?P<draft>[^/]+)/snapshot',path)
            if snapshot_match:
                with DRAFT_STORE._lock:
                    current=DRAFT_STORE.get(snapshot_match['draft'])
                    if payload.get('revision')!=current['revision']:
                        raise EditorError('稿件版本已变化，请先比较或另存副本',409)
                    from editor_service import normalize_metadata,content_sha256
                    content=str(payload.get('content') or '')
                    if len(content.encode('utf-8'))>MAX_JSON_BYTES:raise EditorError('快照正文过大')
                    metadata=normalize_metadata(payload.get('metadata'))
                    candidate={**current,'content':content,'metadata':metadata,'revision':DRAFT_STORE._revision(content,metadata)}
                    summary=DRAFT_STORE.history.capture(candidate,DRAFT_STORE._draft_dir(current['id']),str(payload.get('reason') or 'manual-snapshot')[:128])
                return self.send_json({'snapshot':summary},201)
            asset_action=re.fullmatch(r'/api/editor/drafts/(?P<draft>[^/]+)/assets/(?P<action>derive|download-remote)',path)
            if asset_action:
                try:
                    if asset_action['action']=='derive':
                        result=derive_asset(DRAFT_STORE,asset_action['draft'],str(payload.get('path') or ''),str(payload.get('mode') or 'diagram'),payload.get('options') or {})
                    else:result=download_asset(DRAFT_STORE,asset_action['draft'],str(payload.get('url') or ''))
                except AssetWorkbenchError as exc:
                    raise EditorError(str(exc),400) from None
                return self.send_json(result,201)
            job_action=re.fullmatch(r'/api/editor/sync-jobs/(?P<job>job-[a-f0-9]{32})/(?P<action>retry|verify|resolve|candidates)',path)
            if job_action:
                job_id=job_action['job']
                if job_action['action']=='retry':
                    return self.send_json({'job':SYNC_WORKFLOW.retry(job_id)},202)
                if job_action['action']=='verify':
                    return self.send_json(verify_job(SYNC_WORKFLOW,job_id,media_id=payload.get('media_id','')))
                if job_action['action']=='candidates':
                    return self.send_json(reconciliation_candidates(SYNC_WORKFLOW,job_id))
                if payload.get('confirmed_not_written') is not True:
                    raise EditorError('必须先在微信后台核实本次没有写入，再明确确认',409)
                return self.send_json({'job':SYNC_JOBS.resolve_uncertain(job_id,outcome='failed')})
            compare_match=re.fullmatch(r'/api/wechat/drafts/(?P<draft>[^/]+)/remote-compare',path)
            if compare_match:
                return self.send_json(SYNC_WORKFLOW.compare_remote(compare_match['draft'],str(payload.get('account_id') or '')))

            restore_match=re.fullmatch(r'/api/editor/drafts/(?P<draft>[^/]+)/history/(?P<snapshot>[^/]+)/restore',path)
            if restore_match:
                draft=DRAFT_STORE.restore_version(restore_match['draft'],restore_match['snapshot'],str(payload.get('revision') or ''))
                return self.send_json({'draft':draft},201)
            trash_restore=re.fullmatch(r'/api/editor/trash/(?P<trash>[^/]+)/restore',path)
            if trash_restore:
                try:
                    draft_id=DRAFT_STORE.history.restore_trash(trash_restore['trash'],DRAFT_STORE.root)
                except FileExistsError:
                    raise EditorError('同编号稿件已经存在，未覆盖当前稿件',409)
                return self.send_json({'draft':DRAFT_STORE.get(draft_id)})

            if path == "/api/wechat/accounts":
                account = WECHAT_ACCOUNTS.create(
                    payload.get("name"),
                    payload.get("app_id"),
                    payload.get("app_secret"),
                )
                return self.send_json(account, 201)

            if path == "/api/wechat/archive/start":
                return self.send_json(ARCHIVE_MANAGER.start(payload), 202)

            if path == "/api/wechat/archive/cancel":
                return self.send_json(ARCHIVE_MANAGER.cancel(), 202)

            if path == "/api/wechat/archive/open-folder":
                return self.send_json(ARCHIVE_MANAGER.open_output())

            asset_match = re.fullmatch(
                r"/api/editor/drafts/(?P<draft>[^/]+)/assets", path
            )
            if asset_match:
                result = DRAFT_STORE.save_asset(
                    asset_match.group("draft"),
                    str(payload.get("path") or ""),
                    str(payload.get("data") or ""),
                )
                if isinstance(payload.get('derivation'),dict):
                    record_derivation(DRAFT_STORE,asset_match['draft'],result['path'],payload['derivation'])
                return self.send_json(result, 201)

            sync_match = re.fullmatch(
                r"/api/wechat/drafts/(?P<draft>[^/]+)/sync", path
            )
            if sync_match:
                if not payload.get('preflight_fingerprint'):
                    raise EditorError('请刷新编辑器并完成新版发布检查后再同步',409)
                return self.send_json({'job':SYNC_WORKFLOW.start(sync_match['draft'],payload)},202)

            publish_match = re.fullmatch(
                r"/api/wechat/drafts/(?P<draft>[^/]+)/publish", path
            )
            if publish_match:
                publisher = self.publisher_for_draft(publish_match.group("draft"))
                draft = publisher.publish(DRAFT_STORE, publish_match.group("draft"))
                return self.send_json({"draft": draft}, 202)

            return self.send_error_json(404, "接口不存在")
        except EditorError as exc:
            return self.send_error_json(exc.status, str(exc))
        except ArchiveTaskError as exc:
            return self.send_error_json(exc.status, str(exc))
        except (SyncJobConflict,SyncJobCapacityError) as exc:
            return self.send_json({'error':str(exc),'job_id':getattr(exc,'job_id','')},409)
        except (BrokenPipeError, ConnectionResetError):
            return
        except Exception as exc:
            if os.environ.get("ARCHIVE_DEBUG"):
                raise
            return self.send_error_json(500, f"本地服务异常：{type(exc).__name__}")

    def do_PUT(self) -> None:
        try:
            path = urllib.parse.unquote(urllib.parse.urlparse(self.path).path)
            self.require_editor_auth()
            payload = self.read_json_body()
            account_match = re.fullmatch(r"/api/wechat/accounts/(?P<account>[^/]+)", path)
            if account_match:
                account = WECHAT_ACCOUNTS.update(
                    account_match.group("account"),
                    payload.get("name"),
                    payload.get("app_id"),
                    payload.get("app_secret"),
                )
                return self.send_json(account)
            draft_match = re.fullmatch(r"/api/editor/drafts/(?P<draft>[^/]+)", path)
            if draft_match:
                draft = DRAFT_STORE.save(
                    draft_match.group("draft"),
                    str(payload.get("content") or ""),
                    payload.get("metadata"),
                    str(payload.get("revision") or ""),
                    reason=str(payload.get('reason') or 'manual-save'),
                )
                return self.send_json(draft)
            return self.send_error_json(404, "接口不存在")
        except EditorError as exc:
            return self.send_error_json(exc.status, str(exc))
        except (BrokenPipeError, ConnectionResetError):
            return
        except Exception as exc:
            if os.environ.get("ARCHIVE_DEBUG"):
                raise
            return self.send_error_json(500, f"本地服务异常：{type(exc).__name__}")

    def do_DELETE(self) -> None:
        try:
            path = urllib.parse.unquote(urllib.parse.urlparse(self.path).path)
            self.require_editor_auth()
            if path == "/api/wechat/archive/session":
                return self.send_json(ARCHIVE_MANAGER.clear_session())
            trash_match = re.fullmatch(r'/api/editor/trash/(?P<trash>[^/]+)', path)
            if trash_match:
                payload = self.read_json_body()
                try:
                    DRAFT_STORE.history.purge_trash(trash_match.group('trash'), confirmation=str(payload.get('confirmation') or ''))
                except ValueError:
                    raise EditorError('永久清理需要确认当前回收站记录；路径或确认信息无效',400) from None
                except FileNotFoundError:
                    raise EditorError('回收站记录不存在或已恢复',404) from None
                return self.send_json({'deleted':True,'trash_id':trash_match.group('trash')})
            draft_match = re.fullmatch(r"/api/editor/drafts/(?P<draft>[^/]+)", path)
            if draft_match:
                draft_id = draft_match.group("draft")
                if any(job['state'] in {'queued','running','uncertain'} for job in SYNC_JOBS.list(draft_id,limit=200)):
                    raise EditorError('该稿件仍有进行中或待核实的同步任务，请先处理任务记录',409)
                DRAFT_STORE.delete(draft_id)
                return self.send_json({"deleted": True, "id": draft_id})
            account_match = re.fullmatch(r"/api/wechat/accounts/(?P<account>[^/]+)", path)
            if not account_match:
                return self.send_error_json(404, "接口不存在")
            WECHAT_ACCOUNTS.delete(account_match.group("account"))
            return self.send_json({"deleted": True})
        except EditorError as exc:
            return self.send_error_json(exc.status, str(exc))
        except ArchiveTaskError as exc:
            return self.send_error_json(exc.status, str(exc))
        except (BrokenPipeError, ConnectionResetError):
            return
        except Exception as exc:
            if os.environ.get("ARCHIVE_DEBUG"):
                raise
            return self.send_error_json(500, f"本地服务异常：{type(exc).__name__}")

    def do_HEAD(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path = urllib.parse.unquote(parsed.path)
        if path.startswith("/resource/"):
            return self.send_resource(path.rsplit("/", 1)[-1], head_only=True)
        if path.startswith("/cover/"):
            article = CATALOG.article_by_id.get(path.rsplit("/", 1)[-1])
            if article and article["_cover"]:
                return self.send_file_safe(article["_cover"], head_only=True)
        return super().do_HEAD()

    def require_editor_auth(self) -> None:
        host = self.headers.get("Host", "")
        if not re.fullmatch(r"(?:127\.0\.0\.1|localhost)(?::\d+)?", host, re.I):
            raise EditorError("仅允许从本机编辑器访问", 403)
        origin = self.headers.get("Origin", "")
        if origin and urllib.parse.urlparse(origin).netloc.lower() != host.lower():
            raise EditorError("请求来源无效", 403)
        token = self.headers.get("X-Editor-Token", "")
        if not token or not secrets.compare_digest(token, EDITOR_TOKEN):
            raise EditorError("编辑器会话已失效，请刷新页面", 403)

    def require_publisher(self, account_id: str):
        if not WECHAT_ACCOUNTS.list():
            raise EditorError("尚未绑定公众号，请先在账号管理中添加", 503)
        return WECHAT_ACCOUNTS.publisher(account_id)

    def publisher_for_draft(self, draft_id: str, *, prefer_publish: bool = False):
        draft = DRAFT_STORE.get(draft_id)
        account_id = ""
        if prefer_publish:
            account_id = str(draft["publish"].get("account_id") or "")
        if not account_id:
            account_id = str(draft["metadata"].get("wechat_account_id") or "")
        return self.require_publisher(account_id)

    def read_json_body(self) -> dict[str, Any]:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise EditorError("请求长度无效") from exc
        if length <= 0 or length > MAX_JSON_BYTES:
            raise EditorError("请求内容为空或过大", 413)
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeError, ValueError) as exc:
            raise EditorError("请求 JSON 无效") from exc
        if not isinstance(payload, dict):
            raise EditorError("请求 JSON 必须是对象")
        return payload

    def send_json(self, data: Any, status: int = 200) -> None:
        payload = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode(
            "utf-8"
        )
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(payload)

    def send_error_json(self, status: int, message: str) -> None:
        self.send_json({"error": message}, status)

    def send_resource(
        self, resource_id: str, *, download: bool = False, head_only: bool = False
    ) -> None:
        resource = CATALOG.resources.get(resource_id)
        if not resource:
            return self.send_error_json(404, "资源不存在")
        return self.send_file_safe(
            resource.path,
            download_name=resource.name if download else None,
            head_only=head_only,
        )

    def send_draft_asset(self, path: Path, *, head_only: bool = False) -> None:
        resolved = path.resolve()
        if not resolved.is_file() or DRAFTS_DIR not in resolved.parents:
            return self.send_error_json(404, "素材不存在")
        size = resolved.stat().st_size
        mime = mimetypes.guess_type(resolved.name)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(size))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if not head_only and self.command != "HEAD":
            with resolved.open("rb") as stream:
                while chunk := stream.read(128 * 1024):
                    self.wfile.write(chunk)

    def send_file_safe(
        self,
        path: Path,
        *,
        download_name: str | None = None,
        head_only: bool = False,
    ) -> None:
        resolved = path.resolve()
        if not resolved.is_file() or ARCHIVE_DIR not in resolved.parents:
            return self.send_error_json(404, "资源不存在")

        size = resolved.stat().st_size
        mime = mimetypes.guess_type(resolved.name)[0] or "application/octet-stream"
        start, end = 0, max(0, size - 1)
        status = 200
        range_header = self.headers.get("Range", "")
        match = re.fullmatch(r"bytes=(\d*)-(\d*)", range_header.strip())
        if match and size:
            first, last = match.groups()
            if first:
                start = int(first)
                end = int(last) if last else end
            elif last:
                length = min(size, int(last))
                start, end = size - length, size - 1
            if start >= size or end < start:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.end_headers()
                return
            end = min(end, size - 1)
            status = 206

        length = max(0, end - start + 1)
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(length))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header(
            "Last-Modified", formatdate(resolved.stat().st_mtime, usegmt=True)
        )
        self.send_header("Cache-Control", "public, max-age=86400")
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        if download_name:
            encoded = urllib.parse.quote(download_name)
            self.send_header(
                "Content-Disposition", f"attachment; filename*=UTF-8''{encoded}"
            )
        self.end_headers()
        if head_only or self.command == "HEAD":
            return

        with resolved.open("rb") as stream:
            stream.seek(start)
            remaining = length
            while remaining:
                chunk = stream.read(min(128 * 1024, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

    def log_message(self, fmt: str, *args: Any) -> None:
        if os.environ.get("ARCHIVE_DEBUG"):
            super().log_message(fmt, *args)


def main() -> None:
    port = int(os.environ.get("ARCHIVE_PORT", "8899"))
    url = f"http://127.0.0.1:{port}"
    print()
    print("  ✦ 星河炸鸡 · 本地内容归档")
    print(f"  阅读地址  {url}")
    print(f"  文章数量  {len(CATALOG.articles)}")
    print(f"  归档目录  {ARCHIVE_DIR}")
    print("  按 Ctrl+C 停止")
    print()
    if not os.environ.get("ARCHIVE_NO_OPEN"):
        try:
            import webbrowser

            webbrowser.open(url)
        except Exception:
            pass
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  已停止")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
