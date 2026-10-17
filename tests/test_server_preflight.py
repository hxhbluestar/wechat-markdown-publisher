"""Local publication gates exercised with synthetic drafts and real raster bytes."""
from __future__ import annotations

import base64
import copy
import html
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'app/web'))
from article_package import RENDER_VERSION
from editor_service import DraftStore
try:
    import server_preflight
except ModuleNotFoundError:
    server_preflight = None

ACCOUNT = 'account-123456789abc'
CODE = 'printf "<ready>&" \\\n\t--flag 中文\n\n# literal ``` marker\n\techo done\n'


def png(color='blue'):
    stream = io.BytesIO()
    Image.new('RGB', (20, 12), color).save(stream, format='PNG')
    return stream.getvalue()


class ServerPreflightTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(server_preflight, 'The backend publication preflight module is missing')
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = DraftStore(Path(self.tmp.name) / 'drafts')
        self.draft = self.store.create('# Synthetic article\n\nOriginal body', title='Synthetic article')
        self.put('cover.png', png())
        metadata = {**self.draft['metadata'], 'cover': 'cover.png', 'source_url': 'https://example.invalid/source', 'wechat_account_id': ACCOUNT}
        self.draft = self.store.save(self.draft['id'], self.draft['content'], metadata, self.draft['revision'])

    def put(self, path, data):
        return self.store.save_asset(self.draft['id'], path, base64.b64encode(data).decode())

    def report(self, draft=None, source_html='<h1>Synthetic article</h1><p>Original body</p>', **kwargs):
        return server_preflight.preflight_article(self.store, draft or self.draft, source_html,
                                                  kwargs.get('render_version', RENDER_VERSION), kwargs.get('account_id', ACCOUNT))

    def codes(self, report):
        return {item['code'] for item in report['issues']}

    def test_complete_article_has_deterministic_bound_fingerprint_and_cover_hash(self):
        first, second = self.report(), self.report()
        self.assertTrue(first['can_sync'])
        self.assertEqual(first['counts']['blocker'], 0)
        self.assertEqual(first['fingerprint'], second['fingerprint'])
        self.assertEqual(len(first['fingerprint']), 64)
        self.assertEqual(first['assets'][0]['path'], 'cover.png')
        self.assertEqual(first['assets'][0]['size'], len(png()))

    def test_fifteen_images_locate_one_missing_asset_before_sync_can_run(self):
        content = '# Fifteen\n' + '\n'.join(f'![Figure {i}](images/{i}.png)' for i in range(15))
        draft = {**self.draft, 'content': content}
        for index in range(15):
            if index != 7:
                self.put(f'images/{index}.png', png())
        markup = ''.join(f'<img src="images/{i}.png">' for i in range(15))
        report = self.report(draft, markup)
        self.assertFalse(report['can_sync'])
        missing = [issue for issue in report['issues'] if issue['code'] == 'image-missing' and issue['field'] == 'content']
        self.assertEqual(len(missing), 1)
        self.assertEqual(content[missing[0]['from']:missing[0]['to']], 'images/7.png')
        self.assertNotIn('images/7.png', missing[0]['message'])

    def test_header_only_corrupt_material_blocks_network_capability(self):
        self.put('images/corrupt.png', b'\x89PNG\r\n\x1a\nfixture')
        draft = {**self.draft, 'content': '# Example\n![image](images/corrupt.png)'}
        report = self.report(draft, '<img src="images/corrupt.png">')
        calls = []
        if report['can_sync']:
            calls.append('would upload')
        self.assertEqual(calls, [])
        self.assertIn('image-corrupt', self.codes(report))

    def test_fences_inline_code_math_and_escaped_html_examples_do_not_create_images(self):
        content = '# Example\n\n```md\n![fence](missing.png)\n```\n`![inline](missing.png)`\n$![math](missing.png)$\n\n    ![indent](missing.png)\n'
        markup = '<h1>Example</h1><pre><code>![fence](missing.png)\n</code></pre><p><code>![inline](missing.png)</code> math example</p>'
        report = self.report({**self.draft, 'content': content}, markup)
        self.assertNotIn('image-missing', self.codes(report))
        self.assertNotIn('image-unsafe', self.codes(report))

    def test_markdown_reference_and_html_api_image_aliases_share_asset_hash(self):
        self.put('images/中文 one.png', png())
        content = '# Refs\n![figure][id]\n[id]: <images/中文 one.png> "Caption"\n'
        path = f'/api/editor/drafts/{self.draft["id"]}/assets/images/%E4%B8%AD%E6%96%87%20one.png'
        report = self.report({**self.draft, 'content': content}, '<img src="' + path + '">')
        self.assertTrue(report['can_sync'])
        self.assertEqual(len(report['assets']), 2)

    def test_remote_unsafe_cross_draft_and_svg_image_addresses_are_blockers(self):
        for source in ['https://example.invalid/a.png', 'data:image/png;base64,AAAA', 'file:///C:/private.png',
                       '/api/editor/drafts/draft-other/assets/images/x.png', '../secret.png', 'images/vector.svg']:
            with self.subTest(source=source):
                report = self.report({**self.draft, 'content': '# Body\n![x](<' + source + '>)'}, '<img src="' + source + '">')
                self.assertFalse(report['can_sync'])
                self.assertTrue(any(i['code'].startswith('image-') for i in report['issues']))

    def test_missing_title_body_cover_and_account_are_definite_blockers(self):
        draft = copy.deepcopy(self.draft)
        draft['content'] = ' \n'
        draft['metadata'].update({'title': '', 'cover': '', 'wechat_account_id': ''})
        report = self.report(draft, '', account_id='')
        self.assertTrue({'title-empty', 'body-empty', 'cover-missing', 'account-missing'} <= self.codes(report))
        self.assertFalse(report['can_sync'])

    def test_renderer_and_target_account_mismatch_cannot_be_acknowledged_away(self):
        report = self.report(render_version='old-renderer', account_id='account-aaaaaaaaaaaa')
        self.assertIn('render-version', self.codes(report))
        self.assertIn('account-mismatch', self.codes(report))
        self.assertFalse(report['can_sync'])

    def test_active_html_and_external_dependencies_block_with_generic_messages(self):
        for markup in ['<script>secret()</script>', '<p onclick="secret()">x</p>', '<iframe src="https://example.invalid"></iframe>',
                       '<svg><foreignObject>unsafe</foreignObject></svg>', '<img srcdata="https://example.invalid/a.png">',
                       '<p style="background-image:url(https://example.invalid/x.png)">x</p>', '<object data="file:///C:/secret">x</object>']:
            with self.subTest(markup=markup):
                report = self.report(source_html=markup)
                self.assertFalse(report['can_sync'])
                self.assertIn('html-unsafe', self.codes(report))
                self.assertNotIn('secret()', json.dumps(report['issues']))

    def test_unresolved_diagrams_formula_svg_and_known_clipping_are_blockers(self):
        cases = [('<pre class="mermaid">graph TD; A--&gt;B</pre>', 'diagram-unresolved'),
                 ('<p>$$x+y$$</p>', 'math-unresolved'), ('<svg viewBox="0 0 10 10"><path d="M0 0L1 1"/></svg>', 'svg-raster-required'),
                 ('<p style="height:10px;overflow:hidden;font-size:18px;line-height:1">text</p>', 'layout-clipping'),
                 ('<p style="font-size:18px;line-height:12px">text</p>', 'layout-line-height')]
        for markup, code in cases:
            with self.subTest(code=code):
                report = self.report(source_html=markup)
                self.assertIn(code, self.codes(report))
                self.assertFalse(report['can_sync'])

    def test_horizontal_code_scroll_and_rendered_math_are_not_false_clipping_blockers(self):
        markup = '<pre style="overflow-x:auto;max-width:100%;font-size:14px;line-height:1.5"><code>echo ok\n</code></pre><span class="katex"><math><mi>x</mi></math></span>'
        report = self.report(source_html=markup)
        self.assertNotIn('layout-clipping', self.codes(report))
        self.assertNotIn('math-unresolved', self.codes(report))
        self.assertTrue(report['can_sync'])

    def test_large_html_and_code_proven_changed_in_plain_nodes_block(self):
        with patch.object(server_preflight, 'MAX_HTML_BYTES', 40):
            report = self.report(source_html='<p>' + 'x' * 50 + '</p>')
            self.assertIn('html-oversize', self.codes(report))
        draft = {**self.draft, 'content': '# Code\n\n````bash\n' + CODE + '````\n'}
        exact = self.report(draft, '<pre><code>' + html.escape(CODE) + '</code></pre>')
        changed = self.report(draft, '<pre><code>' + html.escape(CODE.replace('中文', 'changed')) + '</code></pre>')
        self.assertNotIn('code-changed', self.codes(exact))
        self.assertIn('code-changed', self.codes(changed))

    def test_fingerprint_changes_with_metadata_asset_html_renderer_account_and_revision(self):
        baseline = self.report()['fingerprint']
        draft = copy.deepcopy(self.draft)
        draft['metadata']['digest'] = 'Edited summary'
        self.assertNotEqual(self.report(draft)['fingerprint'], baseline)
        draft = {**self.draft, 'revision': 'changed'}
        self.assertNotEqual(self.report(draft)['fingerprint'], baseline)
        self.assertNotEqual(self.report(source_html='<p>Changed rendered article</p>')['fingerprint'], baseline)
        self.assertNotEqual(self.report(render_version='different')['fingerprint'], baseline)
        self.assertNotEqual(self.report(account_id='account-aaaaaaaaaaaa')['fingerprint'], baseline)
        # External disk changes must invalidate an accepted preflight; normal
        # uploads now preserve the original and return a fresh content path.
        self.store.asset_path(self.draft['id'], 'cover.png').write_bytes(png('red'))
        self.assertNotEqual(self.report()['fingerprint'], baseline)

    def test_sensitive_findings_are_masked_and_issue_ids_do_not_hash_secret_values(self):
        draft = copy.deepcopy(self.draft)
        draft['metadata'].update({'title': 'TODO user 10.13.14.15', 'digest': 'API_KEY="verySecretValue12345"', 'source_url': ''})
        draft['content'] = '# Example\n\nTODO finish\n```sh\nssh real_person@10.20.30.40\ncd /home/real_person/work\nTOKEN="anotherSecretValue123"\n```\n'
        report = self.report(draft)
        self.assertTrue({'placeholder', 'source-empty', 'privacy-private-ip', 'privacy-secret', 'privacy-username'} <= self.codes(report))
        public_report = json.dumps(report, ensure_ascii=False)
        for secret in ['10.13.14.15', '10.20.30.40', 'real_person', 'verySecretValue12345', 'anotherSecretValue123']:
            self.assertNotIn(secret, public_report)
        second = copy.deepcopy(draft)
        second['metadata']['digest'] = 'API_KEY="otherSecretValue6789"'
        first_ids = [i['id'] for i in report['issues'] if i['field'] == 'digest']
        second_ids = [i['id'] for i in self.report(second)['issues'] if i['field'] == 'digest']
        self.assertEqual(first_ids, second_ids)
        self.assertTrue(all(i['id'].startswith('server-') for i in report['issues']))

    def test_symlinked_asset_outside_draft_cannot_be_read_or_hashed(self):
        external = Path(self.tmp.name) / 'outside.png'
        external.write_bytes(png())
        image_dir = self.store.root / self.draft['id'] / 'images'
        image_dir.mkdir(exist_ok=True)
        try:
            (image_dir / 'link.png').symlink_to(external)
        except OSError:
            self.skipTest('Host does not permit symlink fixture')
        report = self.report({**self.draft, 'content': '# Example\n![x](images/link.png)'}, '<img src="images/link.png">')
        self.assertFalse(report['can_sync'])
        self.assertNotIn('outside.png', json.dumps(report))

    def test_renderer_omission_and_duplicate_reference_counts_are_blockers(self):
        self.put('images/one.png', png())
        draft = {**self.draft, 'content': '# Example\n![first](images/one.png)\n![again](images/one.png)\n`![code](missing.png)`'}
        omitted = self.report(draft, '<img src="images/one.png">')
        self.assertIn('image-render-missing', self.codes(omitted))
        self.assertFalse(omitted['can_sync'])
        preserved = self.report(draft, '<img src="images/one.png"><img src="images/one.png"><img src="cover.png">')
        self.assertNotIn('image-render-missing', self.codes(preserved))
        self.assertTrue(preserved['can_sync'])

    def test_html_unquoted_image_cannot_bypass_publisher_image_replacement(self):
        self.put('images/one.png', png())
        report = self.report(source_html='<img src=images/one.png>')
        self.assertIn('html-unsafe', self.codes(report))
        self.assertFalse(report['can_sync'])

    def test_obfuscated_active_url_and_css_are_still_unsafe(self):
        for markup in ['<a href="java&#x0A;script:alert(1)">unsafe</a>',
                       '<p style="background-image:u\\72l(https://example.invalid/private)">unsafe</p>']:
            with self.subTest(markup=markup):
                self.assertIn('html-unsafe', self.codes(self.report(source_html=markup)))

    def test_known_small_line_height_percent_and_inherited_font_are_checked(self):
        for markup in ['<p style="font-size:18px;line-height:80%">text</p>',
                       '<section style="font-size:18px"><p style="line-height:12px">text</p></section>']:
            with self.subTest(markup=markup):
                self.assertIn('layout-line-height', self.codes(self.report(source_html=markup)))

    def test_fixed_height_that_fits_one_line_is_reviewable_not_proven_clipping(self):
        report = self.report(source_html='<p style="height:20px;overflow:hidden;font-size:16px;line-height:18px">One line</p>')
        self.assertNotIn('layout-clipping', self.codes(report))

    def test_unicode_issue_offsets_are_utf16_and_are_not_mutations(self):
        draft = {**self.draft, 'content': '# 😀 example\n![lost](images/missing.png)'}
        report = self.report(draft)
        finding = next(item for item in report['issues'] if item['code'] == 'image-missing' and item['field'] == 'content')
        offset = draft['content'].index('images/missing.png')
        self.assertEqual(finding['from'], offset + 1)
        self.assertEqual(draft['content'], '# 😀 example\n![lost](images/missing.png)')

    def test_html_code_examples_and_comments_in_markdown_are_not_body_images(self):
        content = '# Example\n\n<!-- ![comment](missing.png) -->\n<pre><code>![example](missing.png)</code></pre>\n'
        report = self.report({**self.draft, 'content': content}, '<h1>Example</h1><pre><code>![example](missing.png)</code></pre><!-- $$hidden$$ -->')
        self.assertNotIn('image-missing', self.codes(report))
        self.assertNotIn('image-render-missing', self.codes(report))
        self.assertNotIn('math-unresolved', self.codes(report))


if __name__ == '__main__':
    unittest.main()
