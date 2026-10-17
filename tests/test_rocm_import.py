"""Original ROCm-shaped fixtures; all HTTP/DNS/socket operations are doubled."""

from __future__ import annotations

import base64
import builtins
import importlib
import io
import socket
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app/web"))
from editor_service import DraftStore, EditorError
from test_asset_sync import PNG_BASE64

try:
    import rocm_import
except ModuleNotFoundError:
    rocm_import = None


HOST = "rocm.blogs.amd.com"
PAGE = "https://rocm.blogs.amd.com/tools/original/README.html"
PNG = base64.b64decode(PNG_BASE64)
PUBLIC = [(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("8.8.8.8", 443))]
CODE = 'printf "<ready>&" \\\n\t--flag value\n\n# literal ``` marker\n\techo done\n'
HTML = '''<!doctype html><html><head>
<meta property="og:title" content="An original ROCm example">
<meta name="author" content="Example Author">
<meta name="description" content="A tiny original test article.">
<meta property="og:url" content="https://rocm.blogs.amd.com/tools/original/README.html">
<meta property="og:type" content="article">
<base href="https://untrusted.invalid/">
</head><body><nav>Outside navigation</nav><article class="bd-article">
<h1>Visible duplicate title<a class="headerlink" href="#top">#</a></h1>
<div class="author_row">Duplicated author UI</div>
<script>marker_evil()</script><style>.bad {color:red}</style>
<aside>Sidebar to remove</aside><h2>Original section<a class="headerlink">#</a></h2>
<p>Body with <strong>emphasis</strong>, <code>x &lt; y &amp; z</code>,
<a href="../next/README.html?view=1#item">relative link</a>,
<a href="javascript:marker_evil()">unsafe link</a>.</p>
<div align="center"><img alt="Figure 1: Original diagram." src="../../_images/figure.png?cache=1">
<p>Figure 1: Original diagram.</p></div>
<div class="highlight-bash notranslate"><div class="highlight"><pre><span></span>CODE_FIXTURE</pre></div></div>
<table><thead><tr><th>Option</th><th>Meaning</th></tr></thead>
<tbody><tr><td><p>alpha</p></td><td><p>one | two</p></td></tr></tbody></table>
<div class="admonition note"><p class="admonition-title">Note</p><p>Keep this note.</p></div>
<div class="admonition warning"><p class="admonition-title">Warning</p><p>Keep this warning.</p></div>
<div class="admonition tip"><p class="admonition-title">Tip</p><p>Keep this tip.</p></div>
</article><footer>Outside footer</footer></body></html>'''.replace(
    "CODE_FIXTURE", CODE.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
)


class Response(io.BytesIO):
    def __init__(self, body=b"", *, status=200, headers=None):
        super().__init__(body)
        self.status = status
        self.headers = headers or {"Content-Type": "text/html; charset=utf-8"}

    def getheader(self, name, default=None):
        return next((value for key, value in self.headers.items() if key.lower() == name.lower()), default)


class FakeNetwork:
    def __init__(self, routes=None, addresses=None):
        self.routes = routes or {
            "/tools/original/README.html": [Response(HTML.encode())],
            "/_images/figure.png?cache=1": [Response(PNG, headers={"Content-Type": "image/png"})],
        }
        self.addresses = PUBLIC if addresses is None else addresses
        self.requests = []
        self.connections = []
        self.dns_calls = []

    def resolver(self, host, port, *args, **kwargs):
        self.dns_calls.append((host, port))
        return self.addresses

    def factory(self, host, *, timeout, addresses):
        network = self

        class Connection:
            closed = False

            def request(self, method, path, headers):
                network.requests.append((host, path, headers))
                self.path = path

            def getresponse(self):
                return network.routes[self.path].pop(0)

            def close(self):
                self.closed = True

        connection = Connection()
        self.connections.append(connection)
        return connection

    def fetcher(self):
        return rocm_import.OfficialFetcher(connection_factory=self.factory, resolver=self.resolver)


class RocmImportTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(rocm_import, "The ROCm importer module is missing")
        self.temporary = tempfile.TemporaryDirectory(prefix="publisher-rocm-test-")
        self.addCleanup(self.temporary.cleanup)
        self.store = DraftStore(Path(self.temporary.name) / "drafts")
        self.existing = self.store.create("# Existing draft\n\nKeep exactly.")

    def test_import_creates_a_new_local_draft_with_official_metadata_and_local_image(self):
        network = FakeNetwork()

        draft = rocm_import.import_rocm(self.store, PAGE, fetcher=network.fetcher())

        self.assertNotEqual(draft["id"], self.existing["id"])
        self.assertEqual(self.store.get(self.existing["id"]), self.existing)
        self.assertEqual(draft["metadata"]["title"], "An original ROCm example")
        self.assertEqual(draft["metadata"]["author"], "Example Author")
        self.assertEqual(draft["metadata"]["source_url"], PAGE)
        self.assertEqual(draft["source_name"], "ROCm-An original ROCm example.md")
        self.assertEqual(draft["content"].count("# An original ROCm example"), 1)
        self.assertNotIn("Visible duplicate title", draft["content"])
        assets = self.store.list_assets(draft["id"])
        self.assertEqual(len(assets), 1)
        self.assertTrue(assets[0]["path"].startswith("images/"))
        self.assertEqual(self.store.asset_path(draft["id"], assets[0]["path"]).read_bytes(), PNG)
        self.assertEqual(draft["metadata"]["cover"], assets[0]["path"])
        self.assertNotIn("https://rocm.blogs.amd.com/_images/", draft["content"])
        self.assertEqual(network.dns_calls, [(HOST, 443), (HOST, 443)])
        self.assertTrue(all(connection.closed for connection in network.connections))

    def test_conversion_preserves_code_tables_links_alerts_and_one_caption(self):
        draft = rocm_import.import_rocm(self.store, PAGE, fetcher=FakeNetwork().fetcher())
        markdown = draft["content"]
        self.assertIn("````bash\n" + CODE + "````", markdown)
        self.assertIn("| Option | Meaning |", markdown)
        self.assertIn(r"one \| two", markdown)
        self.assertIn("https://rocm.blogs.amd.com/tools/next/README.html?view=1#item", markdown)
        for kind in ("NOTE", "TIP", "WARNING"):
            self.assertIn("> [!" + kind + "]", markdown)
        self.assertEqual(markdown.count("Figure 1: Original diagram."), 1)
        self.assertIn('"Figure 1: Original diagram."', markdown)
        for excluded in ("marker_evil", "Sidebar to remove", "Outside navigation", "Outside footer", "Duplicated author UI", "headerlink"):
            self.assertNotIn(excluded, markdown)

    def test_duplicate_images_are_downloaded_once_and_missing_article_h1_is_added(self):
        html = HTML.replace('<h1>Visible duplicate title<a class="headerlink" href="#top">#</a></h1>', "")
        html = html.replace("</article>", '<p><img src="../../_images/figure.png?cache=1" alt="second reference"></p></article>')
        network = FakeNetwork()
        network.routes["/tools/original/README.html"] = [Response(html.encode())]

        draft = rocm_import.import_rocm(self.store, PAGE, fetcher=network.fetcher())

        self.assertTrue(draft["content"].startswith("# An original ROCm example\n"))
        self.assertEqual(len(self.store.list_assets(draft["id"])), 1)
        self.assertEqual(len(network.requests), 2)

    def test_non_article_or_foreign_image_fails_without_creating_a_draft(self):
        cases = (
            '<html><nav>Only an index</nav></html>',
            HTML.replace("../../_images/figure.png?cache=1", "https://elsewhere.invalid/figure.png"),
            HTML.replace("../../_images/figure.png?cache=1", "data:image/png;base64," + PNG_BASE64),
            HTML.replace("../../_images/figure.png?cache=1", "../../_images/unsafe.svg"),
        )
        for html in cases:
            with self.subTest(html=html[:50]):
                network = FakeNetwork()
                network.routes["/tools/original/README.html"] = [Response(html.encode())]
                with self.assertRaises(EditorError):
                    rocm_import.import_rocm(self.store, PAGE, fetcher=network.fetcher())
                self.assertEqual([item["id"] for item in self.store.list()], [self.existing["id"]])
                self.assertEqual(len(network.requests), 1)

    def test_missing_image_or_invalid_raster_leaves_no_partial_draft(self):
        for response in (Response(b"missing", status=404), Response(b"not a PNG", headers={"Content-Type": "image/png"})):
            with self.subTest(status=response.status):
                network = FakeNetwork()
                network.routes["/_images/figure.png?cache=1"] = [response]
                with self.assertRaises(EditorError):
                    rocm_import.import_rocm(self.store, PAGE, fetcher=network.fetcher())
                self.assertEqual(self.store.get(self.existing["id"]), self.existing)
                self.assertEqual(len(self.store.list()), 1)

    def test_storage_failure_removes_only_the_new_draft(self):
        with patch.object(self.store, "save", side_effect=OSError("simulated disk failure")):
            with self.assertRaises(EditorError):
                rocm_import.import_rocm(self.store, PAGE, fetcher=FakeNetwork().fetcher())
        self.assertEqual(self.store.get(self.existing["id"]), self.existing)
        self.assertEqual(len(self.store.list()), 1)

    def test_optional_parser_dependency_is_lazy_and_missing_dependency_is_readable(self):
        original = builtins.__import__

        def without_bs4(name, *args, **kwargs):
            if name == "bs4" or name.startswith("bs4."):
                raise ImportError("simulated missing parser")
            return original(name, *args, **kwargs)

        network = FakeNetwork()
        with patch("builtins.__import__", side_effect=without_bs4):
            importlib.reload(rocm_import)
            with self.assertRaisesRegex(EditorError, "beautifulsoup4"):
                rocm_import.import_rocm(self.store, PAGE, fetcher=network.fetcher())
        self.assertEqual(network.requests, [])

    def test_inline_list_content_stays_in_one_item_and_nested_lists_remain_nested(self):
        addition = '<ul><li>First <strong>bold</strong> with <a href="../next/README.html">link</a> and <code>--flag</code>.<ul><li>Nested item</li></ul></li></ul>'
        network = FakeNetwork()
        network.routes["/tools/original/README.html"] = [Response(HTML.replace("</article>", addition + "</article>").encode())]

        draft = rocm_import.import_rocm(self.store, PAGE, fetcher=network.fetcher())

        self.assertIn("- First **bold** with [link](https://rocm.blogs.amd.com/tools/next/README.html) and `--flag`.", draft["content"])
        self.assertIn("  - Nested item", draft["content"])

    def test_merged_table_preserves_structure_and_only_safe_html_attributes(self):
        table = '<table onclick="marker_evil()"><tr><th colspan="2">Grouped</th></tr><tr><td rowspan="2"><a href="../next/README.html" onclick="marker_evil()">label</a></td><td>first</td></tr><tr><td>second</td></tr></table>'
        network = FakeNetwork()
        network.routes["/tools/original/README.html"] = [Response(HTML.replace("</article>", table + "</article>").encode())]

        markdown = rocm_import.import_rocm(self.store, PAGE, fetcher=network.fetcher())["content"]

        self.assertIn('<th colspan="2">Grouped</th>', markdown)
        self.assertIn('<td rowspan="2">', markdown)
        self.assertIn('href="https://rocm.blogs.amd.com/tools/next/README.html"', markdown)
        self.assertNotIn("onclick", markdown)
        self.assertNotIn("marker_evil", markdown)
        self.assertIn("second</td>", markdown)

    def test_table_cells_with_multiple_paragraphs_or_lists_keep_their_structure(self):
        table = '<table><tr><th>Details</th></tr><tr><td><p>First paragraph</p><p>Second paragraph</p></td></tr><tr><td><ul><li>First item</li><li>Second item</li></ul></td></tr></table>'
        network = FakeNetwork()
        network.routes["/tools/original/README.html"] = [Response(HTML.replace("</article>", table + "</article>").encode())]

        markdown = rocm_import.import_rocm(self.store, PAGE, fetcher=network.fetcher())["content"]

        self.assertIn("<p>First paragraph</p><p>Second paragraph</p>", markdown)
        self.assertIn("<ul><li>First item</li><li>Second item</li></ul>", markdown)

    def test_custom_sphinx_alert_title_is_preserved_while_standard_title_is_deduplicated(self):
        network = FakeNetwork()
        html = HTML.replace('<p class="admonition-title">Warning</p>', '<p class="admonition-title">Hardware caution</p>')
        network.routes["/tools/original/README.html"] = [Response(html.encode())]

        markdown = rocm_import.import_rocm(self.store, PAGE, fetcher=network.fetcher())["content"]

        self.assertIn("> [!WARNING]\n> **Hardware caution**", markdown)
        self.assertEqual(markdown.count("Hardware caution"), 1)
        self.assertNotIn("> Note\n", markdown)

    def test_literal_html_text_is_escaped_and_official_publication_date_is_retained(self):
        network = FakeNetwork()
        html = HTML.replace("</head>", '<meta property="article:published_time" content="2026-01-02"></head>')
        html = html.replace("</article>", '<p>Literal &lt;img src=x onerror=literalhandler()&gt; &amp; text.</p></article>')
        network.routes["/tools/original/README.html"] = [Response(html.encode())]

        markdown = rocm_import.import_rocm(self.store, PAGE, fetcher=network.fetcher())["content"]

        self.assertIn("&lt;img src=x onerror=literalhandler()&gt; &amp; text.", markdown)
        self.assertNotIn("<img src=x", markdown)
        self.assertIn("> 发布日期：2026-01-02", markdown)

    def test_image_count_and_total_download_budget_fail_before_draft_creation(self):
        network = FakeNetwork()
        html = HTML.replace("</article>", '<img src="../../_images/second.png"></article>')
        network.routes["/tools/original/README.html"] = [Response(html.encode())]
        with patch("rocm_import.MAX_IMAGES", 1):
            with self.assertRaises(EditorError):
                rocm_import.import_rocm(self.store, PAGE, fetcher=network.fetcher())
        self.assertEqual(len(network.requests), 1)
        with patch("rocm_import.MAX_TOTAL_BYTES", len(HTML.encode()) + len(PNG) - 1):
            with self.assertRaises(EditorError):
                rocm_import.import_rocm(self.store, PAGE, fetcher=FakeNetwork().fetcher())
        self.assertEqual(len(self.store.list()), 1)


class RocmNetworkTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(rocm_import, "The ROCm importer module is missing")

    def test_untrusted_urls_are_rejected_before_dns_or_http(self):
        urls = (
            "http://rocm.blogs.amd.com/a.html", "https://rocm.blogs.amd.com.evil.invalid/a.html",
            "https://rocm.blogs.amd.com@127.0.0.1/a.html", "https://user@rocm.blogs.amd.com/a.html",
            "https://rocm.blogs.amd.com:444/a.html", "https://127.0.0.1/a.html",
            "https://rocm.blogs.amd.com\\@evil.invalid/a.html", "https://rocm.blogs.amd.com/a.html\nX-Test: bad",
            "https://rocm.blogs.amd.com/", "file:///tmp/a.html",
        )
        for url in urls:
            with self.subTest(url=url):
                network = FakeNetwork()
                with self.assertRaises(EditorError):
                    network.fetcher().fetch(url, max_bytes=1024, kind="html")
                self.assertEqual(network.dns_calls, [])
                self.assertEqual(network.requests, [])

    def test_each_redirect_is_validated_before_following_it(self):
        for target in ("https://evil.invalid/page.html", "http://rocm.blogs.amd.com/a.html", "//127.0.0.1/a.html"):
            with self.subTest(target=target):
                network = FakeNetwork({"/tools/original/README.html": [Response(status=302, headers={"Location": target})]})
                with self.assertRaises(EditorError):
                    network.fetcher().fetch(PAGE, max_bytes=1024, kind="html")
                self.assertEqual(len(network.requests), 1)
                self.assertTrue(network.connections[0].closed)
        network = FakeNetwork({
            "/tools/original/README.html": [Response(status=302, headers={"Location": "../next/README.html?x=1"})],
            "/tools/next/README.html?x=1": [Response(b"<article>ok</article>")],
        })
        result = network.fetcher().fetch(PAGE, max_bytes=1024, kind="html")
        self.assertEqual(result.url, "https://rocm.blogs.amd.com/tools/next/README.html?x=1")
        self.assertEqual(len(network.dns_calls), 2)

    def test_private_or_mixed_dns_answers_are_rejected_without_http(self):
        for address in ("127.0.0.1", "10.0.0.1", "169.254.169.254", "100.64.0.1", "192.0.2.1", "224.0.0.1"):
            with self.subTest(address=address):
                rows = PUBLIC + [(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", (address, 443))]
                network = FakeNetwork(addresses=rows)
                with self.assertRaises(EditorError):
                    network.fetcher().fetch(PAGE, max_bytes=1024, kind="html")
                self.assertEqual(network.requests, [])

    def test_connection_uses_pinned_address_without_resolving_again(self):
        connected = []

        class Socket:
            def settimeout(self, value):
                pass
            def connect(self, address):
                connected.append(address)
            def close(self):
                pass

        with patch("rocm_import.socket.socket", return_value=Socket()):
            with patch("rocm_import.socket.getaddrinfo", side_effect=AssertionError("DNS must not repeat")):
                connection = rocm_import._https_connection(HOST, timeout=3, addresses=PUBLIC)
                connection._create_connection((HOST, 443), 3)
        self.assertEqual(connected, [("8.8.8.8", 443)])
        self.assertEqual(connection.host, HOST)

    def test_actual_response_bytes_and_content_encoding_are_limited(self):
        for response in (
            Response(b"0123456789", headers={"Content-Type": "text/html", "Content-Length": "1"}),
            Response(b"data", headers={"Content-Type": "text/html", "Content-Length": "99999999"}),
            Response(b"data", headers={"Content-Type": "text/html", "Content-Encoding": "gzip"}),
        ):
            with self.subTest(headers=response.headers):
                network = FakeNetwork({"/tools/original/README.html": [response]})
                with self.assertRaises(EditorError):
                    network.fetcher().fetch(PAGE, max_bytes=8, kind="html")
                self.assertTrue(network.connections[0].closed)

    def test_redirect_loops_and_network_failures_are_readable(self):
        network = FakeNetwork({"/tools/original/README.html": [Response(status=302, headers={"Location": PAGE}) for _ in range(6)]})
        with self.assertRaisesRegex(EditorError, "重定向"):
            network.fetcher().fetch(PAGE, max_bytes=1024, kind="html")
        with patch("rocm_import.socket.getaddrinfo", side_effect=TimeoutError("simulated DNS timeout")):
            with self.assertRaises(EditorError):
                rocm_import.OfficialFetcher().fetch(PAGE, max_bytes=1024, kind="html")

    def test_slow_stream_checks_deadline_between_single_reads(self):
        clock = [0.0]

        class SlowResponse(Response):
            def read1(self, size):
                clock[0] += 3
                return super().read1(min(size, 1))

        network = FakeNetwork({"/tools/original/README.html": [SlowResponse(b"slow response")]})
        with patch("rocm_import.time.monotonic", side_effect=lambda: clock[0]):
            with self.assertRaisesRegex(EditorError, "超时"):
                network.fetcher().fetch(PAGE, max_bytes=1024, kind="html", deadline=5)
        self.assertTrue(network.connections[0].closed)

    def test_multiple_ip_attempts_share_one_connection_deadline(self):
        clock, timeouts = [0.0], []

        class FailingSocket:
            def settimeout(self, timeout):
                timeouts.append(timeout)
            def connect(self, address):
                clock[0] += 2
                raise OSError("simulated connection timeout")
            def close(self):
                pass

        with patch("rocm_import.time.monotonic", side_effect=lambda: clock[0]):
            with patch("rocm_import.socket.socket", return_value=FailingSocket()):
                with self.assertRaises(OSError):
                    rocm_import._connect_pinned(PUBLIC * 3, 3)
        self.assertEqual(timeouts, [3, 1])


if __name__ == "__main__":
    unittest.main()
