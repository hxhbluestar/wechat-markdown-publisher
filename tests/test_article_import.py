"""Synthetic, offline fixtures for local article import preparation."""
from __future__ import annotations

import hashlib
import io
import struct
import sys
import unittest
import zipfile
import zlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'app/web'))
try:
    import article_import
except ModuleNotFoundError:
    article_import = None

def png_chunk(kind, data):
    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))


PNG = (b'\x89PNG\r\n\x1a\n' + png_chunk(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 2, 0, 0, 0))
       + png_chunk(b'IDAT', zlib.compress(b'\x00\x22\x44\x66')) + png_chunk(b'IEND', b''))
CODE = 'printf "<ready>&" \\\n\t--flag 中文\n\n# literal ``` marker\n\techo done\n'


def archive(entries):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, 'w', zipfile.ZIP_DEFLATED) as package:
        for name, data in entries:
            if isinstance(name, str):
                raw = zipfile.ZipInfo(name)
                # ZipInfo normalizes backslashes on Windows; hostile fixtures
                # must exercise the bytes the recipient actually receives.
                raw.filename = raw.orig_filename = name
                raw.compress_type = zipfile.ZIP_DEFLATED
                name = raw
            package.writestr(name, data)
    return stream.getvalue()


def docx(body, relations='', props=''):
    document = ('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
                'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
                'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
                '<w:body>' + body + '</w:body></w:document>')
    entries = [('word/document.xml', document)]
    if relations:
        entries.append(('word/_rels/document.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                        + relations + '</Relationships>'))
    if props:
        entries.append(('docProps/core.xml', '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
                        'xmlns:dc="http://purl.org/dc/elements/1.1/">' + props + '</cp:coreProperties>'))
    return archive(entries)


class ArticleImportTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(article_import, 'The local article preparation module is missing')

    def prepare(self, name, data, **kwargs):
        return article_import.prepare_import(name, data, **kwargs)

    def test_markdown_preserves_bytes_code_and_reports_quality(self):
        text = '# Synthetic article\n\n````bash\n' + CODE + '````\n\n| Metric | Value |\n| --- | --- |\n| TTFT | 12.30 ms |\n'
        result = self.prepare('sample.md', text.encode())
        self.assertEqual(result['content'], text)
        self.assertEqual(result['title'], 'Synthetic article')
        self.assertEqual(result['report']['before'], {'images': 0, 'fences': 1, 'tables': 1})
        self.assertEqual(result['report']['before'], result['report']['after'])
        self.assertEqual(result['source_original']['bytes'], text.encode())
        self.assertEqual(result['report']['fingerprint'], hashlib.sha256(text.encode()).hexdigest())
        self.assertEqual(result['assets'], [])

    def test_zip_keeps_fifteen_references_and_deduplicates_identical_images(self):
        text = '# Fifteen figures\n\n' + '\n'.join(f'![Figure {i}](assets/figure{i}.png)' for i in range(15))
        package = archive([('article.md', text)] + [(f'assets/figure{i}.png', PNG) for i in range(15)])
        result = self.prepare('article.zip', package)
        self.assertEqual(result['report']['before']['images'], 15)
        self.assertEqual(result['report']['after']['images'], 15)
        self.assertEqual(len(result['assets']), 1)
        self.assertEqual(result['assets'][0]['bytes'], PNG)
        self.assertEqual(result['assets'][0]['mime'], 'image/png')
        self.assertEqual(result['content'].count('](images/'), 15)
        self.assertEqual(result['source_original']['bytes'], package)

    def test_relative_unicode_spaces_and_parentheses_resolve_inside_package(self):
        text = '# Qwen example\n\n![图 1](<../配图 目录/图 (1).png>)\n![图 2](../配图%20目录/图%20%281%29.png "图注")'
        result = self.prepare('Qwen.zip', archive([('文章/README.md', text), ('配图 目录/图 (1).png', PNG)]))
        self.assertEqual(len(result['assets']), 1)
        self.assertEqual(result['report']['after']['images'], 2)
        self.assertIn('"图注"', result['content'])
        self.assertNotIn('../配图', result['content'])

    def test_reference_images_rewrite_destination_and_ignore_code_examples(self):
        text = '# Refs\n![图][figure]\n![again][figure]\n\n[figure]: <assets/a b.png> "Caption"\n\n```md\n![example](missing.png)\n```\n`![inline](missing.png)`\n'
        result = self.prepare('refs.zip', archive([('a.md', text), ('assets/a b.png', PNG)]))
        self.assertEqual(result['report']['after']['images'], 2)
        self.assertIn('![example](missing.png)', result['content'])
        self.assertIn('[figure]: <images/', result['content'])

    def test_missing_local_material_rejects_incomplete_prepare_with_report(self):
        for name, data in [('a.md', b'# Example\n![lost](missing.png)'),
                           ('a.zip', archive([('a.md', '# Example\n![lost](missing.png)')]))]:
            with self.subTest(name=name):
                with self.assertRaises(article_import.ArticleImportError) as caught:
                    self.prepare(name, data)
                self.assertEqual(caught.exception.report['status'], 'blocked')
                self.assertIn('missing.png', str(caught.exception))

    def test_remote_references_remain_and_require_explicit_download(self):
        text = '# Remote\n![web](https://example.invalid/a.png)'
        result = self.prepare('a.md', text.encode())
        self.assertEqual(result['content'], text)
        self.assertEqual(result['assets'], [])
        self.assertEqual(result['report']['remote_images'], ['https://example.invalid/a.png'])
        self.assertEqual(result['report']['status'], 'needs_review')
        self.assertTrue(any('download' in item.lower() for item in result['report']['warnings']))

    def test_front_matter_metadata_and_explicit_metadata_keep_provenance(self):
        text = '---\ntitle: "Original title"\nauthor: "Original author"\nsource_url: https://example.invalid/source\ndate: 2026-10-18\n---\n\n# Body\n'
        result = self.prepare('a.md', text.encode(), metadata={'author': 'Reviewed author'})
        self.assertEqual(result['title'], 'Original title')
        self.assertEqual(result['metadata']['author'], 'Reviewed author')
        self.assertEqual(result['metadata']['source_url'], 'https://example.invalid/source')
        self.assertEqual(result['metadata']['published_at'], '2026-10-18')
        self.assertIn('imported_at', result['metadata'])
        self.assertEqual(result['content'], text)

    def test_docx_table_numeric_values_caption_and_author_survive(self):
        body = '<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Original benchmark</w:t></w:r></w:p>'
        body += '<w:p><w:r><w:t>图 1：环境与口径</w:t></w:r></w:p>'
        body += '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Metric</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Value</w:t></w:r></w:p></w:tc></w:tr>'
        body += '<w:tr><w:tc><w:p><w:r><w:t>TTFT</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>12.30 ms / 99.9%</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
        result = self.prepare('metrics.docx', docx(body, props='<dc:creator>Example author</dc:creator>'))
        self.assertEqual(result['title'], 'Original benchmark')
        self.assertEqual(result['metadata']['author'], 'Example author')
        for value in ['图 1：环境与口径', 'Metric', 'Value', 'TTFT', '12.30 ms / 99.9%']:
            self.assertIn(value, result['content'])
        self.assertEqual(result['report']['before']['tables'], 1)
        self.assertEqual(result['report']['after']['tables'], 1)

    def test_docx_code_tabs_breaks_and_special_characters_remain(self):
        body = '<w:p><w:pPr><w:pStyle w:val="Code"/></w:pPr><w:r><w:t>if x &lt; y &amp; z:</w:t><w:br/><w:tab/><w:t>print("中文")</w:t><w:br/></w:r></w:p>'
        result = self.prepare('code.docx', docx(body))
        self.assertIn('if x < y & z:\n\tprint("中文")\n', result['content'])
        self.assertEqual(result['report']['after']['fences'], 1)

    def test_docx_complex_table_and_formula_are_reported(self):
        body = '<w:tbl><w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>Merged 42</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
        body += '<w:p><m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><m:r><m:t>x+y</m:t></m:r></m:oMath></w:p>'
        result = self.prepare('complex.docx', docx(body))
        self.assertIn('Merged 42', result['content'])
        self.assertIn('x+y', result['content'])
        self.assertTrue(any('merged' in item.lower() for item in result['report']['warnings']))
        self.assertTrue(any('formula' in item.lower() for item in result['report']['warnings']))

    def test_docx_embedded_images_and_external_relationship_are_never_read(self):
        body = '<w:p><w:r><w:drawing><a:blip r:embed="rId1"/></w:drawing></w:r></w:p>'
        rel = '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/pic.png"/>'
        package = docx(body, rel)
        with zipfile.ZipFile(io.BytesIO(package)) as source:
            entries = [(i.filename, source.read(i)) for i in source.infolist()]
        result = self.prepare('images.docx', archive(entries + [('word/media/pic.png', PNG)]))
        self.assertEqual(result['assets'][0]['bytes'], PNG)
        self.assertEqual(result['report']['after']['images'], 1)
        external = rel.replace('media/pic.png', 'file:///C:/Windows/win.ini').replace('/>', ' TargetMode="External"/>')
        with self.assertRaises(article_import.ArticleImportError):
            self.prepare('external.docx', docx(body, external))

    def test_explicit_html_preserves_code_caption_metadata_and_strips_active_content(self):
        import html
        page = '<html><head><meta name="author" content="Example Author"><link rel="canonical" href="https://example.invalid/post"></head><body><article><h1>Original title</h1>'
        page += '<script>EVIL()</script><style>EVIL CSS</style><iframe src="file:///C:/Windows/win.ini"></iframe>'
        page += '<figure><img src="/figure.png" alt="diagram"><figcaption>图 1：完整图注</figcaption></figure>'
        page += '<pre><code class="language-bash">' + html.escape(CODE) + '</code></pre></article></body></html>'
        result = self.prepare('paste.html', page.encode(), kind='html', base_url='https://example.invalid/post')
        self.assertIn(CODE, result['content'])
        self.assertIn('图 1：完整图注', result['content'])
        self.assertNotIn('EVIL', result['content'])
        self.assertNotIn('win.ini', result['content'])
        self.assertEqual(result['metadata']['author'], 'Example Author')
        self.assertEqual(result['metadata']['source_url'], 'https://example.invalid/post')
        self.assertEqual(result['report']['before'], result['report']['after'])

    def test_html_is_not_implicitly_imported_and_unsafe_urls_are_rejected(self):
        with self.assertRaises(article_import.ArticleImportError):
            self.prepare('paste.html', b'<h1>Explicit only</h1>')
        for uri in ['file:///C:/secret.png', 'data:image/png;base64,AAAA', 'javascript:alert(1)', '//127.0.0.1/a.png']:
            with self.subTest(uri=uri), self.assertRaises(article_import.ArticleImportError):
                self.prepare('a.md', ('# T\n![x](<' + uri + '>)').encode())

    def test_zip_traversal_symlink_duplicate_and_absolute_names_are_blocked(self):
        for name in ['../escape.png', '/absolute.png', 'C:/escape.png', 'assets\\escape.png', 'a:stream', 'x/../escape.png']:
            with self.subTest(name=name), self.assertRaises(article_import.ArticleImportError):
                self.prepare('bad.zip', archive([('a.md', '# Good'), (name, PNG)]))
        symlink = zipfile.ZipInfo('assets/link.png')
        symlink.create_system = 3
        symlink.external_attr = 0o120777 << 16
        with self.assertRaises(article_import.ArticleImportError):
            self.prepare('bad.zip', archive([('a.md', '# Good'), (symlink, b'/secret')]))
        with self.assertRaises(article_import.ArticleImportError):
            self.prepare('duplicate.zip', archive([('a.md', '# Good'), ('A.md', '# Ambiguous')]))

    def test_zip_encryption_decompression_bomb_and_too_many_members_are_blocked(self):
        package = bytearray(archive([('a.md', '# Good')]))
        for signature, offset in [(b'PK\x03\x04', 6), (b'PK\x01\x02', 8)]:
            index = package.index(signature) + offset
            flags = struct.unpack_from('<H', package, index)[0]
            struct.pack_into('<H', package, index, flags | 1)
        with self.assertRaises(article_import.ArticleImportError):
            self.prepare('encrypted.zip', bytes(package))
        with self.assertRaises(article_import.ArticleImportError):
            self.prepare('bomb.zip', archive([('a.md', '# Good'), ('bomb.txt', b'0' * (2 * 1024 * 1024))]))
        with self.assertRaises(article_import.ArticleImportError):
            self.prepare('many.zip', archive([('a.md', '# Good')] + [(f'a{i}.txt', 'x') for i in range(300)]))

    def test_oversize_empty_invalid_text_and_ambiguous_markdown_are_blocked(self):
        for name, value in [('big.md', b'x' * (13 * 1024 * 1024)), ('empty.md', b''), ('bad.md', b'\xff\xfe\x00'),
                            ('bad.zip', b'not a zip'), ('two.zip', archive([('a.md', '# A'), ('b.md', '# B')]))]:
            with self.subTest(name=name), self.assertRaises(article_import.ArticleImportError):
                self.prepare(name, value)

    def test_invalid_image_is_not_accepted_as_material(self):
        with self.assertRaises(article_import.ArticleImportError):
            self.prepare('bad.zip', archive([('a.md', '# A\n![bad](bad.png)'), ('bad.png', b'not actually a PNG')]))

    def test_docx_xml_entities_are_blocked_even_with_utf16_encoding(self):
        malicious = '<?xml version="1.0" encoding="UTF-16"?><!DOCTYPE doc [<!ENTITY text "EXPANDED">]><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>&text;</w:t></w:r></w:p></w:body></w:document>'
        with self.assertRaises(article_import.ArticleImportError):
            self.prepare('entity.docx', archive([('word/document.xml', malicious.encode('utf-16'))]))

    def test_html_literal_prose_cannot_invent_markdown_images_or_active_html(self):
        result = self.prepare('paste.html', b'<h1>Literal example</h1><p>![text](missing.png) &lt;script&gt;literal&lt;/script&gt;</p>', kind='html')
        self.assertEqual(result['report']['after']['images'], 0)
        self.assertIn(r'!\[text\]', result['content'])
        self.assertIn('&lt;script&gt;literal&lt;/script&gt;', result['content'])

    def test_docx_literal_markdown_syntax_is_text_and_hyperlinks_keep_targets(self):
        body = '<w:p><w:r><w:t>![literal](missing.png)</w:t></w:r></w:p><w:p><w:hyperlink r:id="source"><w:r><w:t>Original source</w:t></w:r></w:hyperlink></w:p>'
        relation = '<Relationship Id="source" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.invalid/original" TargetMode="External"/>'
        result = self.prepare('source.docx', docx(body, relation, '<dc:source>https://example.invalid/original</dc:source>'))
        self.assertEqual(result['report']['after']['images'], 0)
        self.assertIn('https://example.invalid/original', result['content'])
        self.assertEqual(result['metadata']['source_url'], 'https://example.invalid/original')

    def test_indented_and_quoted_code_images_are_inert_and_code_is_unchanged(self):
        text = '# Code examples\n\n    ![indented](missing.png)\n\n> ```md\n> ![quoted](missing.png)\n> ```\n'
        result = self.prepare('code.md', text.encode())
        self.assertEqual(result['content'], text)
        self.assertEqual(result['report']['after']['images'], 0)
        self.assertEqual(result['report']['after']['fences'], 1)

    def test_large_unclosed_inline_backtick_run_remains_literal(self):
        text = '# Code text\n\n' + 'prefix ' + '`' * 10000
        result = self.prepare('code.md', text.encode())
        self.assertEqual(result['content'], text)

    def test_docx_external_https_image_is_retained_for_deliberate_download(self):
        body = '<w:p><w:r><w:drawing><a:blip r:link="rId1"/></w:drawing></w:r></w:p>'
        rel = '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="https://example.invalid/image.png" TargetMode="External"/>'
        result = self.prepare('remote.docx', docx(body, rel))
        self.assertEqual(result['report']['remote_images'], ['https://example.invalid/image.png'])
        self.assertEqual(result['assets'], [])


if __name__ == '__main__':
    unittest.main()
