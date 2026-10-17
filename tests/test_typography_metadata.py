"""Typography metadata and publishing contracts, using only a fake remote API."""

from __future__ import annotations

import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app" / "web"))
from editor_service import DraftStore, EditorError, WechatPublisher, content_sha256, normalize_metadata
from test_asset_sync import ACCOUNT_ID, PNG_BASE64, FakeWechatApi


class TypographyMetadataTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(prefix="publisher-typography-")
        self.addCleanup(self.temp_dir.cleanup)
        self.store = DraftStore(Path(self.temp_dir.name) / "drafts")

    def test_new_draft_persists_technical_typography_defaults(self) -> None:
        draft = self.store.create("# Technical article\n\nBody")

        self.assertEqual(draft["metadata"]["theme"], "technical")
        expected = {
            "font_family": "theme",
            "font_size": 17,
            "code_wrap": "scroll",
            "table_mode": "auto",
            "caption_font_size": 12,
            "table_font_size": 13,
        }
        for field, value in expected.items():
            self.assertEqual(draft["metadata"].get(field), value)
        record = json.loads((self.store.root / draft["id"] / "draft.json").read_text("utf-8"))
        self.assertEqual(record["metadata"], draft["metadata"])

    def test_old_records_keep_explicit_legacy_theme_and_default_styling(self) -> None:
        for theme in ("grace", "default", "simple"):
            with self.subTest(theme=theme):
                draft = self.store.create("# Legacy article\n\nBody")
                path = self.store.root / draft["id"] / "draft.json"
                record = json.loads(path.read_text("utf-8"))
                record["metadata"] = {"title": "Legacy article", "theme": theme}
                path.write_text(json.dumps(record), encoding="utf-8")

                loaded = self.store.get(draft["id"])

                self.assertEqual(loaded["metadata"]["theme"], theme)
                self.assertEqual(loaded["metadata"].get("font_family"), "theme")
                self.assertEqual(loaded["metadata"].get("font_size"), 16)
                self.assertEqual(loaded["metadata"].get("code_wrap"), "scroll")
                self.assertEqual(loaded["metadata"].get("table_mode"), "auto")
                self.assertEqual(loaded["metadata"].get("caption_font_size"), 13)
                self.assertEqual(loaded["metadata"].get("table_font_size"), 16)

    def legacy_record(self, theme: str) -> tuple[str, str]:
        content = "# Legacy article\n\nBody"
        draft = self.store.create(content)
        folder = self.store.root / draft["id"]
        record = json.loads((folder / "draft.json").read_text("utf-8"))
        legacy_metadata = {
            "title": "Legacy article",
            "author": "",
            "digest": "",
            "cover": "",
            "source_url": "",
            "need_open_comment": False,
            "only_fans_can_comment": False,
            "show_cover_pic": False,
            "theme": theme,
            "palette": "warm",
            "wechat_account_id": "",
        }
        record["metadata"] = legacy_metadata
        (folder / "draft.json").write_text(json.dumps(record), encoding="utf-8")
        # Compute the historical hash independently, using the old JSON shape.
        serialized = json.dumps(legacy_metadata, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        old_revision = hashlib.sha256(f"{content}\x00{serialized}".encode("utf-8")).hexdigest()
        (folder / "publish-state.json").write_text(json.dumps({
            "media_id": "historical-draft-media-id",
            "draft_revision": old_revision,
            "publish_status": "draft_synced",
        }), encoding="utf-8")
        return draft["id"], old_revision

    def test_legacy_default_typography_preserves_historical_revision_and_sync_state(self) -> None:
        for theme in ("grace", "default", "simple"):
            with self.subTest(theme=theme):
                draft_id, old_revision = self.legacy_record(theme)

                loaded = self.store.get(draft_id)

                self.assertEqual(loaded["revision"], old_revision)
                self.assertEqual(loaded["revision"], loaded["publish"]["draft_revision"])
                self.assertEqual(loaded["publish"]["media_id"], "historical-draft-media-id")

    def test_legacy_typography_edits_change_revision_and_restoring_defaults_restores_hash(self) -> None:
        changes = {
            "font_family": "sans",
            "font_size": 17,
            "code_wrap": "wrap",
            "table_mode": "cards",
        }
        for theme in ("grace", "default", "simple"):
            draft_id, old_revision = self.legacy_record(theme)
            for field, changed_value in changes.items():
                with self.subTest(theme=theme, field=field):
                    current = self.store.get(draft_id)
                    default_value = current["metadata"][field]
                    changed = self.store.save(
                        draft_id,
                        current["content"],
                        {**current["metadata"], field: changed_value},
                        current["revision"],
                    )
                    self.assertNotEqual(changed["revision"], old_revision)
                    self.assertEqual(changed["publish"]["draft_revision"], old_revision)

                    restored = self.store.save(
                        draft_id,
                        changed["content"],
                        {**changed["metadata"], field: default_value},
                        changed["revision"],
                    )

                    self.assertEqual(restored["revision"], old_revision)
                    self.assertEqual(restored["revision"], restored["publish"]["draft_revision"])

    def test_all_new_themes_and_custom_options_survive_save_reload(self) -> None:
        for theme in ("technical", "journal", "minimal", "obsidian", "deepsea", "teal"):
            with self.subTest(theme=theme):
                draft = self.store.create("# Article\n\nBody")
                metadata = {
                    **draft["metadata"],
                    "theme": theme,
                    "font_family": "serif",
                    "font_size": 18,
                    "code_wrap": "wrap",
                    "table_mode": "cards",
                    "caption_font_size": 14,
                    "table_font_size": 16,
                }
                saved = self.store.save(draft["id"], draft["content"], metadata, draft["revision"])
                loaded = self.store.get(draft["id"])

                self.assertEqual(loaded["metadata"], metadata)
                self.assertEqual(loaded["revision"], saved["revision"])
                self.assertNotEqual(saved["revision"], draft["revision"])

    def test_invalid_typography_values_fall_back_to_safe_theme_defaults(self) -> None:
        unsafe_values = (
            ("font_family", 'serif; background:url("https://invalid.example")', "theme"),
            ("font_family", ["sans"], "theme"),
            ("font_size", "17", 17),
            ("font_size", "18px; color:red", 17),
            ("font_size", 17.0, 17),
            ("font_size", True, 17),
            ("font_size", 999, 17),
            ("font_size", {"value": 18}, 17),
            ("code_wrap", "wrap; color:red", "scroll"),
            ("code_wrap", ["wrap"], "scroll"),
            ("table_mode", "cards; position:fixed", "auto"),
            ("table_mode", {"mode": "scroll"}, "auto"),
            ("caption_font_size", 11, 12),
            ("caption_font_size", 17, 12),
            ("caption_font_size", "14", 12),
            ("caption_font_size", 14.0, 12),
            ("caption_font_size", True, 12),
            ("caption_font_size", {"value": 14}, 12),
            ("caption_font_size", "14px; color:red", 12),
            ("table_font_size", 11, 13),
            ("table_font_size", 17, 13),
            ("table_font_size", "15", 13),
            ("table_font_size", 15.0, 13),
            ("table_font_size", False, 13),
            ("table_font_size", [15], 13),
            ("table_font_size", "15px; color:red", 13),
        )
        for field, value, expected in unsafe_values:
            with self.subTest(field=field, value=value):
                metadata = normalize_metadata({"theme": "technical", field: value})
                self.assertEqual(metadata.get(field), expected)
                self.assertIs(type(metadata.get(field)), type(expected))
        self.assertEqual(normalize_metadata({"theme": "grace", "font_size": "unsafe"}).get("font_size"), 16)

    def test_missing_or_unknown_theme_uses_new_default(self) -> None:
        for source in (None, {}, {"theme": "unknown"}, {"theme": "technical; color:red"}):
            with self.subTest(source=source):
                metadata = normalize_metadata(source)
                self.assertEqual(metadata["theme"], "technical")
                self.assertEqual(metadata.get("font_size"), 17)

    def test_all_whitelisted_typography_values_round_trip(self) -> None:
        for family in ("theme", "sans", "serif"):
            for size in (15, 16, 17, 18):
                for code in ("scroll", "wrap"):
                    for table in ("auto", "scroll", "cards"):
                        with self.subTest(family=family, size=size, code=code, table=table):
                            options = {
                                "font_family": family,
                                "font_size": size,
                                "code_wrap": code,
                                "table_mode": table,
                            }
                            metadata = normalize_metadata({"theme": "journal", **options})
                            for field, expected in options.items():
                                self.assertEqual(metadata.get(field), expected)

    def test_caption_and_table_font_sizes_accept_only_integer_12_through_16(self) -> None:
        for caption in (12, 13, 14, 15, 16):
            for table in (12, 13, 14, 15, 16):
                with self.subTest(caption=caption, table=table):
                    metadata = normalize_metadata({
                        "theme": "obsidian",
                        "caption_font_size": caption,
                        "table_font_size": table,
                    })
                    self.assertEqual(metadata.get("caption_font_size"), caption)
                    self.assertEqual(metadata.get("table_font_size"), table)
                    self.assertIs(type(metadata.get("caption_font_size")), int)
                    self.assertIs(type(metadata.get("table_font_size")), int)

    def four_field_record(self, theme: str) -> tuple[str, str]:
        draft_id, _ = self.legacy_record(theme)
        path = self.store.root / draft_id / "draft.json"
        record = json.loads(path.read_text("utf-8"))
        # These are nondefault legacy options, so the deployed four-field
        # release included them in its revision for all six historical themes.
        record["metadata"].update({
            "font_family": "serif",
            "font_size": 18,
            "code_wrap": "wrap",
            "table_mode": "cards",
        })
        path.write_text(json.dumps(record), encoding="utf-8")
        serialized = json.dumps(record["metadata"], ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        content = (path.parent / "article.md").read_text("utf-8")
        old_revision = hashlib.sha256(f"{content}\x00{serialized}".encode("utf-8")).hexdigest()
        (path.parent / "publish-state.json").write_text(json.dumps({
            "media_id": "four-field-draft-media-id",
            "draft_revision": old_revision,
            "publish_status": "draft_synced",
        }), encoding="utf-8")
        return draft_id, old_revision

    def test_old_four_field_records_retain_revision_with_new_size_defaults(self) -> None:
        themes = (("grace", 13, 16), ("default", 13, 16), ("simple", 13, 16),
                  ("technical", 12, 13), ("journal", 12, 13), ("minimal", 12, 13))
        for theme, caption, table in themes:
            with self.subTest(theme=theme):
                draft_id, old_revision = self.four_field_record(theme)

                loaded = self.store.get(draft_id)

                self.assertEqual(loaded["revision"], old_revision)
                self.assertEqual(loaded["revision"], loaded["publish"]["draft_revision"])
                self.assertEqual(loaded["metadata"].get("caption_font_size"), caption)
                self.assertEqual(loaded["metadata"].get("table_font_size"), table)

    def test_new_size_edits_change_four_field_revision_and_restoring_defaults_restores_it(self) -> None:
        for theme in ("grace", "default", "simple", "technical", "journal", "minimal"):
            draft_id, old_revision = self.four_field_record(theme)
            legacy = theme in ("grace", "default", "simple")
            changes = (("caption_font_size", 12, 13), ("table_font_size", 12, 16)) if legacy else (
                ("caption_font_size", 14, 12), ("table_font_size", 16, 13))
            for field, custom, default in changes:
                with self.subTest(theme=theme, field=field):
                    current = self.store.get(draft_id)
                    changed = self.store.save(
                        draft_id, current["content"], {**current["metadata"], field: custom}, current["revision"],
                    )
                    self.assertNotEqual(changed["revision"], old_revision)
                    self.assertEqual(changed["metadata"].get(field), custom)
                    self.assertEqual(changed["publish"]["draft_revision"], old_revision)

                    restored = self.store.save(
                        draft_id, changed["content"], {**changed["metadata"], field: default}, changed["revision"],
                    )

                    self.assertEqual(restored["revision"], old_revision)

    def test_legacy_twelve_pixel_sizes_change_historical_revision_and_restore_it(self) -> None:
        for theme in ("grace", "default", "simple"):
            for field, default in (("caption_font_size", 13), ("table_font_size", 16)):
                with self.subTest(theme=theme, field=field):
                    draft_id, old_revision = self.legacy_record(theme)
                    current = self.store.get(draft_id)

                    changed = self.store.save(
                        draft_id, current["content"], {**current["metadata"], field: 12}, current["revision"],
                    )

                    self.assertNotEqual(changed["revision"], old_revision)
                    self.assertEqual(changed["metadata"][field], 12)
                    restored = self.store.save(
                        draft_id, changed["content"], {**changed["metadata"], field: default}, changed["revision"],
                    )
                    self.assertEqual(restored["revision"], old_revision)


class TypographySyncTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(prefix="publisher-typography-sync-")
        self.addCleanup(self.temp_dir.cleanup)
        self.store = DraftStore(Path(self.temp_dir.name) / "drafts")
        self.draft = self.store.create("# Article\n\n![Photo](images/photo.png)\n")
        self.store.save_asset(self.draft["id"], "cover.png", PNG_BASE64)
        self.store.save_asset(self.draft["id"], "images/photo.png", PNG_BASE64)
        self.api = FakeWechatApi()
        self.publisher = WechatPublisher(self.api, account_id=ACCOUNT_ID)
        self.source_html = '<section><p>Body</p><img src="images/photo.png"></section>'

    def save_options(self, theme: str = "technical", **options) -> dict:
        current = self.store.get(self.draft["id"])
        metadata = {
            **current["metadata"],
            "theme": theme,
            "cover": "cover.png",
            "wechat_account_id": ACCOUNT_ID,
            "font_family": "theme",
            "font_size": 16 if theme in ("grace", "default", "simple") else 17,
            "code_wrap": "scroll",
            "table_mode": "auto",
            "caption_font_size": 13 if theme in ("grace", "default", "simple") else 12,
            "table_font_size": 16 if theme in ("grace", "default", "simple") else 13,
            **options,
        }
        return self.store.save(current["id"], current["content"], metadata, current["revision"])

    def sync(self, theme: str, **kwargs) -> tuple[dict, bool]:
        return self.publisher.sync(
            self.store,
            self.draft["id"],
            self.source_html,
            content_sha256(self.draft["content"]),
            theme,
            "warm",
            **kwargs,
        )

    def assert_no_remote_calls(self) -> None:
        self.assertEqual(self.api.content_uploads, [])
        self.assertEqual(self.api.thumb_uploads, [])
        self.assertEqual(self.api.added_articles, [])
        self.assertEqual(self.api.updated_articles, [])
        self.assertEqual(self.store.get(self.draft["id"])["publish"], {})

    def test_new_themes_require_typography_before_any_remote_call(self) -> None:
        for theme in ("technical", "journal", "minimal", "obsidian", "deepsea", "teal"):
            with self.subTest(theme=theme):
                self.save_options(theme)
                with self.assertRaises(EditorError):
                    self.sync(theme)
                self.assert_no_remote_calls()

    def test_custom_legacy_typography_requires_explicit_sync_options(self) -> None:
        options = (
            {"font_family": "sans"},
            {"font_size": 17},
            {"code_wrap": "wrap"},
            {"table_mode": "scroll"},
            {"caption_font_size": 14},
            {"caption_font_size": 12},
            {"table_font_size": 12},
        )
        for changed in options:
            with self.subTest(changed=changed):
                self.save_options("grace", **changed)
                with self.assertRaises(EditorError):
                    self.sync("grace")
                self.assert_no_remote_calls()

    def test_legacy_default_sync_can_omit_typography_and_records_effective_values(self) -> None:
        self.save_options("grace")

        synced, created = self.sync("grace")

        self.assertTrue(created)
        self.assertEqual(synced["publish"].get("typography"), {
            "font_family": "theme",
            "font_size": 16,
            "code_wrap": "scroll",
            "table_mode": "auto",
            "caption_font_size": 13,
            "table_font_size": 16,
        })
        self.assertEqual(synced["publish"]["publish_status"], "draft_synced")
        self.assertEqual(len(self.api.added_articles), 1)

    def test_stale_typography_is_rejected_before_any_remote_call(self) -> None:
        rendered_options = {
            "font_family": "theme",
            "font_size": 17,
            "code_wrap": "scroll",
            "table_mode": "auto",
            "caption_font_size": 12,
            "table_font_size": 13,
        }
        changes = (
            {"font_family": "sans"},
            {"font_size": 18},
            {"code_wrap": "wrap"},
            {"table_mode": "cards"},
            {"caption_font_size": 14},
            {"table_font_size": 16},
        )
        for changed in changes:
            with self.subTest(changed=changed):
                self.save_options("technical", **changed)
                with self.assertRaises(EditorError) as raised:
                    self.sync("technical", typography=rendered_options)
                self.assertEqual(raised.exception.status, 409)
                self.assert_no_remote_calls()

    def test_invalid_sync_typography_is_rejected_instead_of_silently_normalized(self) -> None:
        self.save_options()
        valid = {
            "font_family": "theme",
            "font_size": 17,
            "code_wrap": "scroll",
            "table_mode": "auto",
            "caption_font_size": 12,
            "table_font_size": 13,
        }
        invalid = (
            {},
            [],
            "theme",
            {"font_size": 17},
            {**valid, "extra_css": "color:red"},
            {**valid, "font_family": "serif; color:red"},
            {**valid, "font_family": ["theme"]},
            {**valid, "font_size": "17"},
            {**valid, "font_size": 17.0},
            {**valid, "font_size": True},
            {**valid, "font_size": 19},
            {**valid, "font_size": {"value": 17}},
            {**valid, "code_wrap": "wrap; overflow:visible"},
            {**valid, "code_wrap": ["scroll"]},
            {**valid, "table_mode": "cards; color:red"},
            {**valid, "table_mode": {"mode": "auto"}},
            {**valid, "caption_font_size": 11},
            {**valid, "caption_font_size": 17},
            {**valid, "caption_font_size": "12"},
            {**valid, "caption_font_size": 12.0},
            {**valid, "caption_font_size": True},
            {**valid, "caption_font_size": {"value": 12}},
            {**valid, "table_font_size": 11},
            {**valid, "table_font_size": 17},
            {**valid, "table_font_size": "13"},
            {**valid, "table_font_size": 13.0},
            {**valid, "table_font_size": False},
            {**valid, "table_font_size": [13]},
            {key: value for key, value in valid.items() if key != "table_font_size"},
            {key: value for key, value in valid.items() if key != "font_size"},
        )
        for typography in invalid:
            with self.subTest(typography=typography):
                with self.assertRaises(EditorError):
                    self.sync("technical", typography=typography)
                self.assert_no_remote_calls()

    def test_matching_custom_typography_syncs_all_new_themes_and_records_options(self) -> None:
        typography = {
            "font_family": "serif",
            "font_size": 18,
            "code_wrap": "wrap",
            "table_mode": "cards",
            "caption_font_size": 14,
            "table_font_size": 16,
        }
        for index, theme in enumerate(("technical", "journal", "minimal", "obsidian", "deepsea", "teal")):
            with self.subTest(theme=theme):
                current = self.save_options(theme, **typography)

                synced, created = self.sync(theme, typography=typography)

                self.assertEqual(created, index == 0)
                self.assertEqual(synced["publish"].get("typography"), typography)
                self.assertEqual(synced["publish"]["theme"], theme)
                self.assertEqual(synced["publish"]["draft_revision"], current["revision"])
                self.assertEqual(synced["publish"]["publish_status"], "draft_synced")
        self.assertEqual(len(self.api.added_articles), 1)
        self.assertEqual(len(self.api.updated_articles), 5)
        self.assertEqual(len(self.api.content_uploads), 1)
        self.assertEqual(len(self.api.thumb_uploads), 1)
        self.assertIn("https://mmbiz.qpic.cn/test/image-1.png", self.api.added_articles[0]["content"])

    def test_four_field_sync_is_compatible_with_default_new_sizes_and_records_all_six(self) -> None:
        for theme, size, caption, table in (("grace", 16, 13, 16), ("technical", 17, 12, 13), ("obsidian", 17, 12, 13)):
            with self.subTest(theme=theme):
                self.save_options(theme)
                old_options = {
                    "font_family": "theme", "font_size": size, "code_wrap": "scroll", "table_mode": "auto",
                }

                synced, _ = self.sync(theme, typography=old_options)

                self.assertEqual(synced["publish"].get("typography"), {
                    **old_options, "caption_font_size": caption, "table_font_size": table,
                })

    def test_four_field_sync_is_rejected_with_409_when_either_new_size_is_custom(self) -> None:
        old_options = {
            "font_family": "theme", "font_size": 17, "code_wrap": "scroll", "table_mode": "auto",
        }
        for changed in ({"caption_font_size": 14}, {"table_font_size": 16}):
            with self.subTest(changed=changed):
                self.save_options("technical", **changed)
                with self.assertRaises(EditorError) as raised:
                    self.sync("technical", typography=old_options)
                self.assertEqual(raised.exception.status, 409)
                self.assert_no_remote_calls()

    def test_legacy_custom_sizes_block_four_field_sync_but_accept_explicit_six(self) -> None:
        baseline = self.save_options("grace")
        changed = self.save_options("grace", caption_font_size=12, table_font_size=13)
        self.assertNotEqual(changed["revision"], baseline["revision"])
        old_options = {
            "font_family": "theme", "font_size": 16, "code_wrap": "scroll", "table_mode": "auto",
        }
        with self.assertRaises(EditorError) as raised:
            self.sync("grace", typography=old_options)
        self.assertEqual(raised.exception.status, 409)
        self.assert_no_remote_calls()

        complete = {**old_options, "caption_font_size": 12, "table_font_size": 13}
        synced, _ = self.sync("grace", typography=complete)
        self.assertEqual(synced["publish"]["typography"], complete)
        self.assertEqual(synced["publish"]["draft_revision"], changed["revision"])

        twelve = self.save_options("grace", caption_font_size=12, table_font_size=12)
        complete["table_font_size"] = 12
        synced, _ = self.sync("grace", typography=complete)
        self.assertNotEqual(twelve["revision"], baseline["revision"])
        self.assertEqual(synced["publish"]["typography"], complete)
        self.assertEqual(synced["publish"]["draft_revision"], twelve["revision"])


if __name__ == "__main__":
    unittest.main()
