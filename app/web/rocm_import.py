"""Import one official ROCm blog into a new local draft, without browser code.

This intentionally supports the ROCm Sphinx article structure only. Optional
HTML parsing dependencies load on demand; the normal editor can start without
them. Its HTTPS transport is independent of the WeChat network policy.
"""

from __future__ import annotations

import base64
import hashlib
import html
import http.client
import ipaddress
import queue
import re
import socket
import threading
import time
import urllib.parse
from dataclasses import dataclass
from pathlib import PurePosixPath
from typing import Any

from editor_service import DraftStore, EditorError, MAX_IMAGE_BYTES


OFFICIAL_HOST = "rocm.blogs.amd.com"
MAX_HTML_BYTES = 6 * 1024 * 1024
MAX_TOTAL_BYTES = 50 * 1024 * 1024
MAX_IMAGES = 32
IMPORT_TIMEOUT = 90
REQUEST_TIMEOUT = 15
IMAGE_TYPES = {"image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp"}


def validate_rocm_url(value: Any, *, article: bool = False) -> str:
    if not isinstance(value, str) or not value or len(value) > 4096:
        raise EditorError("请填写 ROCm 官方博客正文链接")
    if re.search(r"[\s\x00-\x1f\x7f\\]", value):
        raise EditorError("ROCm 链接包含无效字符")
    try:
        parsed = urllib.parse.urlsplit(value)
        valid = (
            parsed.scheme == "https" and parsed.hostname == OFFICIAL_HOST
            and parsed.port in (None, 443) and not parsed.username and not parsed.password
        )
    except ValueError as exc:
        raise EditorError("ROCm 链接无效") from exc
    if not valid:
        raise EditorError("仅允许 https://rocm.blogs.amd.com 官方链接")
    path = parsed.path or "/"
    if article and (not path.lower().endswith(".html") or path.lower() == "/index.html"):
        raise EditorError("请填写 ROCm 博客正文的 HTML 链接")
    return urllib.parse.urlunsplit(("https", OFFICIAL_HOST, path, parsed.query, ""))


def _connect_pinned(addresses, timeout):
    last_error = None
    deadline = time.monotonic() + timeout
    for family, kind, protocol, _, address in addresses:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("ROCm connection deadline exceeded")
        connection = socket.socket(family, kind, protocol)
        try:
            connection.settimeout(remaining)
            connection.connect(address)
            return connection
        except OSError as exc:
            connection.close()
            last_error = exc
    raise last_error or OSError("No public address")


def _https_connection(host, *, timeout, addresses):
    connection = http.client.HTTPSConnection(host, timeout=timeout)
    # HTTPSConnection retains the official Host header, certificate hostname
    # verification and TLS SNI; only its TCP socket destination is pinned.
    connection._create_connection = lambda address, timeout, source_address=None: _connect_pinned(addresses, timeout)
    return connection


@dataclass(frozen=True)
class FetchResult:
    url: str
    data: bytes
    content_type: str


class OfficialFetcher:
    def __init__(self, *, connection_factory=None, resolver=None):
        self.connection_factory = connection_factory or _https_connection
        self.resolver = resolver or socket.getaddrinfo

    def _addresses(self, timeout):
        answers = queue.Queue(maxsize=1)

        def resolve():
            try:
                answers.put((self.resolver(OFFICIAL_HOST, 443, type=socket.SOCK_STREAM), None))
            except Exception as exc:
                answers.put((None, exc))

        threading.Thread(target=resolve, daemon=True).start()
        try:
            rows, error = answers.get(timeout=timeout)
        except queue.Empty as exc:
            raise EditorError("ROCm 域名解析超时，请稍后重试", 504) from exc
        if error is not None:
            raise EditorError("ROCm 域名解析失败，请检查网络", 502) from error
        try:
            addresses = [ipaddress.ip_address(row[4][0]) for row in rows]
            if not addresses or any(not address.is_global or address.is_multicast or address.is_reserved for address in addresses):
                raise ValueError("Nonpublic DNS answer")
        except (ValueError, IndexError, TypeError) as exc:
            raise EditorError("ROCm 域名返回非公网地址，已停止导入", 502) from exc
        return rows

    def fetch(self, url, *, max_bytes, kind="html", deadline=None):
        current = validate_rocm_url(url, article=kind == "html")
        deadline = deadline if deadline is not None else time.monotonic() + IMPORT_TIMEOUT
        for redirect in range(4):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise EditorError("ROCm 导入超时，请稍后重试", 504)
            timeout = min(REQUEST_TIMEOUT, remaining)
            addresses = self._addresses(timeout)
            timeout = min(REQUEST_TIMEOUT, deadline - time.monotonic())
            if timeout <= 0:
                raise EditorError("ROCm 导入超时，请稍后重试", 504)
            connection = self.connection_factory(OFFICIAL_HOST, timeout=timeout, addresses=addresses)
            try:
                parsed = urllib.parse.urlsplit(current)
                path = urllib.parse.urlunsplit(("", "", parsed.path, parsed.query, ""))
                connection.request("GET", path, headers={
                    "Host": OFFICIAL_HOST, "Accept-Encoding": "identity",
                    "User-Agent": "WechatMarkdownPublisher/ROCmImport",
                    "Accept": "text/html" if kind == "html" else "image/png,image/jpeg,image/gif,image/webp",
                    "Connection": "close",
                })
                response = connection.getresponse()
                if response.status in (301, 302, 303, 307, 308):
                    location = response.getheader("Location")
                    if not location or redirect == 3:
                        raise EditorError("ROCm 重定向次数过多或缺少目标", 502)
                    current = validate_rocm_url(urllib.parse.urljoin(current, location), article=kind == "html")
                    continue
                if response.status != 200:
                    raise EditorError(f"ROCm 下载失败：HTTP {response.status}", 502)
                if response.getheader("Content-Encoding", "identity").lower().strip() not in ("", "identity"):
                    raise EditorError("ROCm 返回不支持的压缩响应，已停止导入", 502)
                content_type = response.getheader("Content-Type", "").split(";", 1)[0].strip().lower()
                if (kind == "html" and content_type not in ("text/html", "application/xhtml+xml")) or (
                    kind == "image" and content_type not in IMAGE_TYPES
                ):
                    raise EditorError("ROCm 返回的文件类型不受支持", 502)
                length = response.getheader("Content-Length")
                if length is not None:
                    try:
                        if int(length) < 0 or int(length) > max_bytes:
                            raise ValueError("Oversize response")
                    except ValueError as exc:
                        raise EditorError("ROCm 文件过大或长度无效", 413) from exc
                parts, size = [], 0
                while True:
                    if time.monotonic() >= deadline:
                        raise EditorError("ROCm 导入超时，请稍后重试", 504)
                    chunk = response.read1(min(65536, max_bytes - size + 1))
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > max_bytes:
                        raise EditorError("ROCm 文件超过导入体积限制", 413)
                    parts.append(chunk)
                return FetchResult(current, b"".join(parts), content_type)
            except (OSError, http.client.HTTPException) as exc:
                raise EditorError("ROCm 网络请求失败，请检查网络后重试", 502) from exc
            finally:
                connection.close()
        raise EditorError("ROCm 重定向次数过多", 502)


def _parser():
    try:
        from bs4 import BeautifulSoup, Comment
    except ImportError as exc:
        raise EditorError("ROCm 导入缺少 beautifulsoup4；请安装 requirements-rocm.txt 或使用完整安装版", 503) from exc
    return BeautifulSoup, Comment


def _text(value):
    return re.sub(r"\s+", " ", str(value or "")).strip()


def _escape(value):
    return re.sub(r"([\\`*_\[\]])", r"\\\1", html.escape(value, quote=False))


class _Markdown:
    BLOCK_TAGS = {"p", "div", "section", "article", "pre", "table", "ul", "ol", "li", "blockquote",
                  "h1", "h2", "h3", "h4", "h5", "h6", "hr", "figure", "dl", "dt", "dd", "img"}

    def inline(self, node):
        name = getattr(node, "name", None)
        if name is None:
            return _escape(re.sub(r"\s+", " ", str(node)))
        if name == "img":
            alt = _escape(_text(node.get("alt")))
            title = _text(node.get("title"))
            quoted = ' "' + title.replace("\\", "\\\\").replace('"', '\\"') + '"' if title else ""
            return f'![{alt}]({node["src"]}{quoted})'
        if name == "code":
            value = node.get_text()
            ticks = "`" * max(1, 1 + max((len(run) for run in re.findall(r"`+", value)), default=0))
            padding = " " if value.startswith("`") or value.endswith("`") else ""
            return ticks + padding + value + padding + ticks
        if name == "br":
            return "  \n"
        content = "".join(self.inline(child) for child in node.children)
        if name in ("strong", "b"):
            return "**" + content + "**"
        if name in ("em", "i"):
            return "*" + content + "*"
        if name in ("del", "s"):
            return "~~" + content + "~~"
        if name == "a" and node.get("href"):
            target = node["href"].replace(" ", "%20").replace("(", "%28").replace(")", "%29")
            return "[" + content + "](" + target + ")"
        return content

    def children(self, node):
        parts, inline = [], []

        def flush():
            text = "".join(inline).strip()
            if text:
                parts.append(text)
            inline.clear()

        for child in node.children:
            if getattr(child, "name", None) in self.BLOCK_TAGS:
                flush()
                value = self.block(child)
                if value.strip():
                    parts.append(value)
            else:
                inline.append(self.inline(child))
        flush()
        return "\n\n".join(parts)

    def table_html(self, node):
        name = getattr(node, "name", None)
        if name is None:
            return html.escape(str(node), quote=False)
        children = "".join(self.table_html(child) for child in node.children)
        allowed = {"table", "caption", "thead", "tbody", "tfoot", "tr", "th", "td", "p", "br", "strong", "b",
                   "em", "i", "a", "code", "pre", "img", "ul", "ol", "li", "span", "del", "s"}
        if name not in allowed:
            return children
        attributes = {}
        for attribute in ("rowspan", "colspan") if name in ("th", "td") else ():
            value = str(node.get(attribute, ""))
            if value.isdigit() and (0 if attribute == "rowspan" else 1) <= int(value) <= 1000:
                attributes[attribute] = value
        for attribute in (("href",) if name == "a" else ("src", "alt", "title") if name == "img" else ()):
            if node.get(attribute) is not None:
                attributes[attribute] = str(node[attribute])
        serialized = "".join(f' {key}="{html.escape(value, quote=True)}"' for key, value in attributes.items())
        return f"<{name}{serialized}>" + ("" if name in ("img", "br") else children + f"</{name}>")

    def block(self, node):
        name = getattr(node, "name", None)
        if name is None:
            return self.inline(node).strip()
        if name == "pre":
            code = node.get_text("", strip=False)
            language = ""
            for candidate in [node, *node.parents]:
                for css_class in candidate.get("class", []):
                    match = re.fullmatch(r"(?:highlight|language|lang)-([A-Za-z0-9_+#.-]{1,30})", css_class)
                    if match:
                        language = match.group(1)
                        break
                if language:
                    break
            if not language and node.find("code"):
                for css_class in node.find("code").get("class", []):
                    if css_class.startswith("language-"):
                        language = css_class[9:]
            fence = "`" * max(3, 1 + max((len(run) for run in re.findall(r"`+", code)), default=0))
            return fence + language + "\n" + code + ("" if code.endswith("\n") else "\n") + fence
        if name == "table":
            own_rows = [row for row in node.find_all("tr") if row.find_parent("table") is node]
            counts = [len(row.find_all(["th", "td"], recursive=False)) for row in own_rows]
            complex_table = (node.find("table") is not None or node.find("tfoot") is not None
                             or len(set(counts)) > 1
                             or any(str(cell.get(span, "1")) != "1"
                                    for cell in node.find_all(["th", "td"]) for span in ("rowspan", "colspan"))
                             or any(len(cell.find_all("p")) > 1 or cell.find(["ul", "ol", "pre"]) is not None
                                    for cell in node.find_all(["th", "td"]))
                             or (node.find("thead") is not None and len(node.find("thead").find_all("tr")) > 1))
            if complex_table:
                return self.table_html(node)
            rows = []
            for row in node.find_all("tr"):
                if row.find_parent("table") is node:
                    rows.append([self.inline(cell).strip().replace("\n", "<br>").replace("|", r"\|")
                                 for cell in row.find_all(["th", "td"], recursive=False)])
            if not rows:
                return ""
            count = max(map(len, rows))
            rows = [row + [""] * (count - len(row)) for row in rows]
            lines = ["| " + " | ".join(row) + " |" for row in rows]
            lines.insert(1, "| " + " | ".join(["---"] * count) + " |")
            return "\n".join(lines)
        classes = set(node.get("class", []))
        alert = next((name.upper() for name in ("note", "tip", "warning", "important", "caution") if name in classes), None)
        if "admonition" in classes and alert:
            title = node.find(class_="admonition-title")
            custom_title = ""
            if title:
                label = _text(title.get_text(" ", strip=True))
                if label.lower().strip(" :：") not in {"note", "tip", "warning", "important", "caution", "提示", "建议", "注意", "重要", "警告"}:
                    custom_title = "**" + _escape(label) + "**\n\n"
                title.extract()
            content = custom_title + self.children(node)
            return "> [!" + alert + "]\n" + "\n".join("> " + line if line else ">" for line in content.splitlines())
        if name == "blockquote":
            return "\n".join("> " + line if line else ">" for line in self.children(node).splitlines())
        if name in ("ul", "ol"):
            result = []
            for index, item in enumerate(node.find_all("li", recursive=False), 1):
                prefix = f"{index}. " if name == "ol" else "- "
                value = self.children(item)
                result.append(prefix + value.replace("\n", "\n" + " " * len(prefix)))
            return "\n".join(result)
        if re.fullmatch(r"h[1-6]", name):
            return "#" * int(name[1]) + " " + self.inline(node).strip()
        if name == "hr":
            return "---"
        if name in ("p", "img"):
            return self.inline(node).strip()
        return self.children(node)


def _parse_article(data, page_url):
    BeautifulSoup, Comment = _parser()
    soup = BeautifulSoup(data.decode("utf-8-sig", errors="replace"), "html.parser")

    def meta(*names):
        for name in names:
            found = soup.find("meta", attrs={"property": name}) or soup.find("meta", attrs={"name": name})
            if found and _text(found.get("content")):
                return _text(found["content"])
        return ""

    article = soup.select_one("article.bd-article")
    if article is None or (meta("og:type") and meta("og:type").lower() != "article"):
        raise EditorError("该链接不是可识别的 ROCm 博客正文")
    first_heading = article.find("h1")
    title = meta("og:title", "twitter:title") or (first_heading.get_text(" ", strip=True) if first_heading else "")
    if not title:
        raise EditorError("ROCm 正文缺少文章标题")
    author = meta("author", "amd_blog_authors", "article:author")
    source_url = validate_rocm_url(meta("og:url") or page_url, article=True)
    digest = meta("description", "og:description")
    published = meta("article:published_time", "amd_release_date", "date")
    for comment in article.find_all(string=lambda text: isinstance(text, Comment)):
        comment.extract()
    for unwanted in article.select(
        "script,style,nav,header,footer,aside,iframe,object,embed,form,button,input,svg,"
        ".headerlink,.sidebar,.author_row,.author_string,.author_string_right,.author_right,.author_left,.admonition-title a"
    ):
        if unwanted.parent is not None:
            unwanted.decompose()
    headings = article.find_all("h1")
    for index, heading in enumerate(headings):
        if index == 0:
            heading.extract()
        else:
            heading.name = "h2"
    if not article.get_text(strip=True) and not article.find("img"):
        raise EditorError("ROCm 页面没有可导入的正文")

    for link in article.find_all("a", href=True):
        target = urllib.parse.urljoin(page_url, link["href"])
        if urllib.parse.urlsplit(target).scheme in ("http", "https", "mailto"):
            link["href"] = target
        else:
            del link["href"]
    for image in article.find_all("img"):
        parent = image.find_parent("figure")
        caption = parent.find("figcaption") if parent else None
        if caption is None and image.parent.get("align", "").lower() == "center":
            possible = image.parent.find("p", recursive=False)
            if possible and re.match(r"^(?:Figure|Fig\.?|图)\s*\d", possible.get_text(" ", strip=True), re.I):
                caption = possible
        if caption is not None:
            text = _text(caption.get_text(" ", strip=True))
            image["title"] = text
            if _text(image.get("alt")) == text:
                image["alt"] = ""
            caption.extract()

    assets = {}
    for image in article.find_all("img"):
        source = image.get("src") or image.get("data-src")
        if not source:
            raise EditorError("ROCm 正文包含缺少地址的图片")
        absolute = validate_rocm_url(urllib.parse.urljoin(page_url, source))
        extension = PurePosixPath(urllib.parse.urlsplit(absolute).path).suffix.lower()
        if extension not in (".png", ".jpg", ".jpeg", ".gif", ".webp"):
            raise EditorError("ROCm 导入仅支持 PNG、JPG、GIF、WebP 正文图片")
        relative = "images/rocm-" + hashlib.sha256(absolute.encode()).hexdigest()[:20] + extension
        assets[absolute] = relative
        image["src"] = relative
    if len(assets) > MAX_IMAGES:
        raise EditorError(f"ROCm 正文图片超过 {MAX_IMAGES} 张限制", 413)
    renderer = _Markdown()
    byline = "> 作者：" + _escape(author) + "\n\n" if author else ""
    if published:
        byline += "> 发布日期：" + _escape(published) + "\n\n"
    markdown = "# " + _escape(title) + "\n\n" + byline + renderer.children(article).strip() + "\n"
    source_name = "ROCm-" + re.sub(r'[<>:"/\\|?*\x00-\x1f]', "-", title).strip(" .")[:180] + ".md"
    return {"title": title, "author": author, "source_url": source_url, "digest": digest,
            "source_name": source_name, "content": markdown, "assets": assets}


def _validate_image(data, content_type):
    valid = (
        content_type == "image/png" and data.startswith(b"\x89PNG\r\n\x1a\n")
        or content_type == "image/jpeg" and data.startswith(b"\xff\xd8\xff")
        or content_type == "image/gif" and data.startswith((b"GIF87a", b"GIF89a"))
        or content_type == "image/webp" and len(data) > 12 and data.startswith(b"RIFF") and data[8:12] == b"WEBP"
    )
    if not valid:
        raise EditorError("ROCm 图片内容与格式不匹配，已停止导入", 502)


def import_rocm(store: DraftStore, url: Any, *, fetcher=None):
    page_url = validate_rocm_url(url, article=True)
    _parser()  # Fail before any download if the optional parser is missing.
    network = fetcher or OfficialFetcher()
    deadline = time.monotonic() + IMPORT_TIMEOUT
    page = network.fetch(page_url, max_bytes=MAX_HTML_BYTES, kind="html", deadline=deadline)
    page_url = validate_rocm_url(page.url, article=True)
    parsed = _parse_article(page.data, page_url)
    downloaded, total = {}, len(page.data)
    for source, relative in parsed["assets"].items():
        image = network.fetch(source, max_bytes=min(MAX_IMAGE_BYTES, MAX_TOTAL_BYTES - total), kind="image", deadline=deadline)
        validate_rocm_url(image.url)
        _validate_image(image.data, image.content_type)
        total += len(image.data)
        downloaded[relative] = image.data
    # No mutable draft exists until every network operation and conversion has
    # succeeded. Any later storage failure deletes only this newly created ID.
    draft = store.create(parsed["content"], title=parsed["title"], source_name=parsed["source_name"])
    try:
        for relative, data in downloaded.items():
            store.save_asset(draft["id"], relative, base64.b64encode(data).decode("ascii"))
        metadata = {**draft["metadata"], "author": parsed["author"], "digest": parsed["digest"],
                    "source_url": parsed["source_url"], "cover": next(iter(downloaded), "")}
        return store.save(draft["id"], parsed["content"], metadata, draft["revision"])
    except Exception as exc:
        store.delete(draft["id"])
        if isinstance(exc, EditorError):
            raise
        raise EditorError("ROCm 导入保存失败，已撤销本次新稿件", 500) from exc
