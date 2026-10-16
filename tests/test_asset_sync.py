"""Regression tests for imported image paths and safe draft synchronization.

The store and publisher are real. Only the external WeChat API is replaced,
so these tests never contact WeChat or create remote drafts.
"""

from __future__ import annotations

import base64
import hashlib
import sys
import tempfile
import unittest
from pathlib import Path
from urllib.parse import quote


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app" / "web"))
from editor_service import DraftStore, EditorError, WechatPublisher, safe_asset_path


# A complete 1 x 1 PNG, rather than a file with only an image magic header.
PNG_BASE64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNg"
    "YGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg=="
)
PNG_BYTES = base64.b64decode(PNG_BASE64)
ACCOUNT_ID = "account-123456789abc"


class FakeWechatApi:
    """Record the external operations caused by the real publisher."""

    def __init__(self) -> None:
        self.content_uploads: list[Path] = []
        self.thumb_uploads: list[Path] = []
        self.added_articles: list[dict] = []
        self.updated_articles: list[tuple[str, dict]] = []

    def upload_content_image(self, path: Path) -> str:
        self.content_uploads.append(path)
        return f"https://mmbiz.qpic.cn/test/image-{len(self.content_uploads)}.png"

    def upload_thumb(self, path: Path) -> str:
        self.thumb_uploads.append(path)
        return "fake-thumb-media-id"

    def add_draft(self, article: dict) -> str:
        self.added_articles.append(dict(article))
        return "fake-draft-media-id"

    def update_draft(self, media_id: str, article: dict) -> None:
        self.updated_articles.append((media_id, dict(article)))

    def submit_publish(self, media_id: str) -> str:
        raise AssertionError("Sync must never publish an article")

    def publish_status(self, publish_id: str) -> dict:
        raise AssertionError("Sync must never query publication status")


class AssetPathTests(unittest.TestCase):
    def test_imported_relative_paths_are_stored_below_images(self) -> None:
        cases = (
            ("pub/a.jpg", "images/pub/a.jpg"),
            ("imported-assets/节点.png", "images/imported-assets/节点.png"),
            ("./pub/a.jpg", "images/pub/a.jpg"),
            ("pub\\a.jpg", "images/pub/a.jpg"),
            ("images/a.jpg", "images/a.jpg"),
            ("images/pub/a.jpg", "images/pub/a.jpg"),
            ("cover.png", "cover.png"),
        )
        for source, expected in cases:
            with self.subTest(source=source):
                self.assertEqual(safe_asset_path(source), expected)

    def test_unsafe_paths_are_rejected_before_file_access(self) -> None:
        cases = (
            "../a.jpg",
            "pub/../a.jpg",
            "images/%2e%2e/a.jpg",
            "%2e%2e/a.jpg",
            "/tmp/a.jpg",
            "\\tmp\\a.jpg",
            "\\\\server\\share\\a.jpg",
            "C:/a.jpg",
            "C:\\a.jpg",
            "images/a:stream.jpg",
            "images/a%3Astream.jpg",
            "images/a.txt",
            "images/a.svg",
            "",
            "images/a\x00.jpg",
        )
        for source in cases:
            with self.subTest(source=source):
                with self.assertRaises(EditorError):
                    safe_asset_path(source)


class DraftAssetTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(
            prefix=".publisher-asset-test-", dir=Path(__file__).resolve().parent
        )
        self.addCleanup(self.temp_dir.cleanup)
        self.store = DraftStore(Path(self.temp_dir.name) / "drafts")
        self.draft = self.store.create("# Test article\n\nBody", title="Test article")
        self.draft_id = self.draft["id"]
        self.folder = self.store.root / self.draft_id
        self.api = FakeWechatApi()
        self.publisher = WechatPublisher(self.api)

    def test_save_legacy_asset_uses_canonical_path_and_inventory(self) -> None:
        result = self.store.save_asset(self.draft_id, "pub/a.png", PNG_BASE64)
        self.assertEqual(result["path"], "images/pub/a.png")
        self.assertEqual((self.folder / "images/pub/a.png").read_bytes(), PNG_BYTES)
        self.assertFalse((self.folder / "pub").exists())
        self.assertEqual(
            [item["path"] for item in self.store.list_assets(self.draft_id)],
            ["images/pub/a.png"],
        )

    def test_local_image_resolves_legacy_relative_and_asset_api_references(self) -> None:
        self.store.save_asset(self.draft_id, "images/pub/节点.png", PNG_BASE64)
        expected = (self.folder / "images/pub/节点.png").resolve()
        sources = (
            "pub/节点.png",
            "./pub/节点.png",
            f"/api/editor/drafts/{self.draft_id}/assets/pub/{quote('节点.png')}",
            f"/api/editor/drafts/{self.draft_id}/assets/images/pub/{quote('节点.png')}",
        )
        for source in sources:
            with self.subTest(source=source):
                self.assertEqual(
                    self.publisher._local_image(self.store, self.draft_id, source),
                    expected,
                )

    def test_missing_second_image_causes_zero_remote_uploads(self) -> None:
        self.store.save_asset(self.draft_id, "images/available.png", PNG_BASE64)
        source_html = (
            '<section><img src="images/available.png">'
            '<img src="images/missing.png"></section>'
        )
        with self.assertRaises(EditorError):
            self.publisher._replace_images(self.store, self.draft_id, source_html, {})
        self.assertEqual(self.api.content_uploads, [])

    def test_disallowed_later_image_causes_zero_remote_uploads(self) -> None:
        self.store.save_asset(self.draft_id, "images/available.png", PNG_BASE64)
        source_html = (
            '<section><img src="images/available.png">'
            '<img src="../outside.png"></section>'
        )
        with self.assertRaises(EditorError):
            self.publisher._replace_images(self.store, self.draft_id, source_html, {})
        self.assertEqual(self.api.content_uploads, [])

    def test_asset_access_cannot_escape_draft_even_when_image_exists_outside(self) -> None:
        outside = self.store.root / "outside.png"
        outside.write_bytes(PNG_BYTES)
        with self.assertRaises(EditorError):
            self.publisher._local_image(self.store, self.draft_id, "../outside.png")
        self.assertEqual(outside.read_bytes(), PNG_BYTES)
        self.assertEqual(self.api.content_uploads, [])

    def test_sync_replaces_legacy_images_and_reuses_remote_draft(self) -> None:
        markdown = "# Imported article\n\n![Photo](pub/a.png)\n"
        current = self.store.save(
            self.draft_id,
            markdown,
            {
                **self.draft["metadata"],
                "cover": "cover.png",
                "wechat_account_id": ACCOUNT_ID,
                "theme": "grace",
                "font_size": 16,
            },
            self.draft["revision"],
        )
        # Populate the canonical store as an import/upload would do.
        self.store.save_asset(self.draft_id, "images/pub/a.png", PNG_BASE64)
        self.store.save_asset(self.draft_id, "cover.png", PNG_BASE64)
        publisher = WechatPublisher(self.api, account_id=ACCOUNT_ID, account_name="Test account")
        source_html = '<section><p>Body</p><img src="pub/a.png"></section>'
        source_hash = hashlib.sha256(markdown.encode("utf-8")).hexdigest()

        synced, created = publisher.sync(
            self.store, self.draft_id, source_html, source_hash, "grace", "warm"
        )

        self.assertTrue(created)
        self.assertEqual(synced["publish"]["publish_status"], "draft_synced")
        self.assertEqual(synced["publish"]["media_id"], "fake-draft-media-id")
        self.assertEqual(synced["publish"]["draft_revision"], current["revision"])
        self.assertEqual(synced["publish"]["account_id"], ACCOUNT_ID)
        self.assertEqual(synced["content"], markdown)
        self.assertEqual(
            self.api.added_articles[0]["content"],
            '<section><p>Body</p><img src="https://mmbiz.qpic.cn/test/image-1.png"></section>',
        )
        self.assertEqual(self.api.added_articles[0]["thumb_media_id"], "fake-thumb-media-id")
        self.assertEqual(self.api.content_uploads, [(self.folder / "images/pub/a.png").resolve()])
        self.assertEqual(self.api.thumb_uploads, [(self.folder / "cover.png").resolve()])
        self.assertFalse((self.folder / "pub").exists())

        updated, created_again = publisher.sync(
            self.store, self.draft_id, source_html, source_hash, "grace", "warm"
        )
        self.assertFalse(created_again)
        self.assertEqual(updated["publish"]["media_id"], "fake-draft-media-id")
        self.assertEqual(len(self.api.added_articles), 1)
        self.assertEqual(self.api.updated_articles[0][0], "fake-draft-media-id")
        self.assertEqual(len(self.api.content_uploads), 1)
        self.assertEqual(len(self.api.thumb_uploads), 1)


if __name__ == "__main__":
    unittest.main()
