"""Bounded, offline article preparation; never creates drafts or opens source paths.

``prepare_import`` returns an in-memory dict. The caller must atomically stage
``assets`` and persist ``source_original`` privately, outside public metadata.
HTML requires explicit ``kind='html'``. Network images are retained as references
and require a separate, deliberate download operation before publishing.
"""
from __future__ import annotations

import hashlib
import html
import io
import posixpath
import re
import stat
import unicodedata
import warnings
import zipfile
from datetime import datetime, timezone
from pathlib import PurePosixPath
from urllib.parse import unquote, urljoin, urlsplit
from xml.etree import ElementTree as ET
from article_package import (
    HASH, MAX_METADATA_BYTES, MAX_MANIFEST_BYTES, PackageValidationError,
    package_asset_path, read_package_json, safe_package_metadata, validate_relations,
)


# 12 MiB base64 is 16 MiB, leaving headroom under the existing 18 MiB JSON cap.
MAX_INPUT_BYTES = 12 * 1024 * 1024
MAX_TEXT_BYTES = 6 * 1024 * 1024
MAX_MEMBER_BYTES = 12 * 1024 * 1024
MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_EXPANDED_BYTES = 64 * 1024 * 1024
MAX_ARCHIVE_FILES = 256
MAX_COMPRESSION_RATIO = 200
MAX_IMAGES = 128
IMAGE_FORMATS = {'PNG': ('image/png', '.png'), 'JPEG': ('image/jpeg', '.jpg'),
                 'GIF': ('image/gif', '.gif'), 'WEBP': ('image/webp', '.webp')}
W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
R = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'
A = '{http://schemas.openxmlformats.org/drawingml/2006/main}'
M = '{http://schemas.openxmlformats.org/officeDocument/2006/math}'


class ArticleImportError(ValueError):
    """A preparation failure with a JSON-safe report suitable for the UI."""
    def __init__(self, message, *, report=None):
        super().__init__(message)
        self.report = dict(report or {})
        self.report['status'] = 'blocked'
        self.report.setdefault('errors', []).append(message)


def _text(data):
    if len(data) > MAX_TEXT_BYTES:
        raise ArticleImportError('Article text exceeds the 6 MiB limit')
    try:
        result = data.decode('utf-8-sig')
    except UnicodeDecodeError as exc:
        raise ArticleImportError('Article text must be valid UTF-8') from exc
    if '\x00' in result or not result.strip():
        raise ArticleImportError('Article text is empty or contains NUL characters')
    return result


def _archive(data):
    """Read validated ZIP members into memory, without extracting to disk."""
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as package:
            members = package.infolist()
            if len(members) > MAX_ARCHIVE_FILES:
                raise ArticleImportError('Archive exceeds 256 entries')
            total, seen = 0, set()
            for member in members:
                name = member.filename
                clean = unicodedata.normalize('NFC', name.rstrip('/'))
                if (not clean or len(name) > 1024 or name.startswith('/') or '\\' in name
                        or ':' in name or any(ord(c) < 32 for c in name)
                        or any(part in ('', '.', '..') for part in clean.split('/'))
                        or clean.casefold() in seen or member.orig_filename != name):
                    raise ArticleImportError('Archive contains unsafe or ambiguous member names')
                seen.add(clean.casefold())
                mode = (member.external_attr >> 16) & 0xFFFF
                if stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR):
                    raise ArticleImportError('Archive links and special files are not allowed')
                if member.flag_bits & 1:
                    raise ArticleImportError('Encrypted archives are not supported')
                if member.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
                    raise ArticleImportError('Unsupported archive compression method')
                total += member.file_size
                if (member.file_size > MAX_MEMBER_BYTES or total > MAX_EXPANDED_BYTES
                        or member.file_size > max(1, member.compress_size) * MAX_COMPRESSION_RATIO):
                    raise ArticleImportError('Archive exceeds expanded size or compression ratio limits')
            result = {}
            for member in members:
                if member.is_dir():
                    continue
                with package.open(member) as stream:
                    value = stream.read(min(MAX_MEMBER_BYTES, member.file_size) + 1)
                    if len(value) != member.file_size:
                        raise ArticleImportError('Archive member size mismatch')
                result[unicodedata.normalize('NFC', member.filename)] = value
            return result
    except ArticleImportError:
        raise
    except (zipfile.BadZipFile, RuntimeError, ValueError, OSError, NotImplementedError, EOFError) as exc:
        raise ArticleImportError('Invalid or damaged ZIP archive') from exc


def _xml(data):
    # XML permits UTF-16/32. Removing NULs for this declaration check also catches
    # ASCII declaration tokens in those encodings before ElementTree can expand.
    if re.search(br'<!\s*(?:DOCTYPE|ENTITY)', data.replace(b'\x00', b''), re.I):
        raise ArticleImportError('XML document types and entities are not allowed')
    try:
        return ET.fromstring(data)
    except ET.ParseError as exc:
        raise ArticleImportError('Invalid DOCX XML') from exc


def _protected_markdown(text):
    """Mask code without changing offsets; image syntax inside code is inert."""
    parts, opened, count = [], None, 0
    for line in text.splitlines(keepends=True):
        logical = re.sub(r'^(?: {0,3}>[ \t]?)+', '', line)
        marker = re.match(r'^ {0,3}(`{3,}|~{3,})(.*?)(?:\r?\n)?$', logical)
        if opened:
            parts.append(re.sub(r'[^\r\n]', ' ', line))
            if marker and marker[1][0] == opened[0] and len(marker[1]) >= len(opened) and not marker[2].strip():
                opened = None
        elif marker:
            opened = marker[1]
            count += 1
            parts.append(re.sub(r'[^\r\n]', ' ', line))
        elif logical.startswith(('    ', '\t')):
            parts.append(re.sub(r'[^\r\n]', ' ', line))
        else:
            parts.append(line)
    masked = ''.join(parts)
    # Two linear passes avoid catastrophic regex backtracking on unclosed runs.
    remaining = {}
    for run in re.finditer(r'`+', masked):
        width = run.end() - run.start()
        remaining[width] = remaining.get(width, 0) + 1
    inline_parts, cursor = [], 0
    runs = iter(re.finditer(r'`+', masked))
    for run in runs:
        width = run.end() - run.start()
        remaining[width] -= 1
        if not remaining[width]:
            continue
        for close in runs:
            close_width = close.end() - close.start()
            remaining[close_width] -= 1
            if close_width == width:
                inline_parts.append(masked[cursor:run.start()])
                inline_parts.append(re.sub(r'[^\r\n]', ' ', masked[run.start():close.end()]))
                cursor = close.end()
                break
    inline_parts.append(masked[cursor:])
    return ''.join(inline_parts), count, opened is not None


def _destination(text, start, end):
    """Destination span, excluding optional angle brackets and image title."""
    while start < end and text[start].isspace():
        start += 1
    while end > start and text[end - 1].isspace():
        end -= 1
    if start < end and text[start] == '<':
        close = text.find('>', start + 1, end)
        if close != -1:
            return start + 1, close
    title = re.search(r'''\s+["'].*["']\s*$''', text[start:end], flags=re.S)
    if title:
        end = start + title.start()
    return start, end


def _image_references(text):
    masked, _, _ = _protected_markdown(text)
    if masked.count('![') + len(re.findall(r'<img\b', masked, re.I)) > MAX_IMAGES:
        raise ArticleImportError('Article exceeds 128 image references')
    definitions = {}
    for match in re.finditer(r'^ {0,3}\[([^\]\n]+)\]:[ \t]*(.+)$', masked, re.M):
        start, end = _destination(text, match.start(2), match.end(2))
        definitions[re.sub(r'\s+', ' ', match[1]).casefold()] = (start, end, text[start:end])
    references = []
    for match in re.finditer(r'(?<!\\)!\[((?:\\.|[^\]\\\n])*)\]', masked):
        pos = match.end()
        if pos < len(masked) and masked[pos] == '(':
            cursor, depth, angle = pos + 1, 1, False
            while cursor < len(masked) and depth:
                char = masked[cursor]
                if char == '\\':
                    cursor += 2
                    continue
                if char == '<':
                    angle = True
                elif char == '>':
                    angle = False
                elif not angle and char == '(':
                    depth += 1
                elif not angle and char == ')':
                    depth -= 1
                cursor += 1
            if depth:
                raise ArticleImportError('Unclosed Markdown image destination')
            start, end = _destination(text, pos + 1, cursor - 1)
            references.append((start, end, text[start:end]))
        else:
            ref = re.match(r'\[([^\]\n]*)\]', masked[pos:])
            key = (ref[1] or match[1]) if ref else match[1]
            definition = definitions.get(re.sub(r'\s+', ' ', key).casefold())
            if definition:
                references.append(definition)
            elif ref:
                raise ArticleImportError('Missing Markdown image reference: ' + key)
    for tag in re.finditer(r'<img\b[^>]*>', masked, re.I):
        source = re.search(r'''\bsrc\s*=\s*(["'])(.*?)\1''', tag[0], re.I | re.S)
        if source:
            start, end = tag.start() + source.start(2), tag.start() + source.end(2)
            references.append((start, end, html.unescape(text[start:end])))
        else:
            raise ArticleImportError('HTML image in Markdown is missing a quoted src')
    return references


def _counts(content):
    masked, fences, _ = _protected_markdown(content)
    tables = len(re.findall(r'^ {0,3}\|?\s*:?-{3,}:?\s*\|[\s|:\-]*$', masked, re.M))
    tables += len(re.findall(r'<table(?:\s|>)', masked, re.I))
    return {'images': len(_image_references(content)), 'fences': fences, 'tables': tables}


def _url_kind(target):
    if re.search(r'[\x00-\x1f\x7f\\]', target) or target.startswith('//'):
        raise ArticleImportError('Unsafe image address')
    try:
        parsed = urlsplit(target)
        if parsed.scheme:
            if parsed.scheme.lower() not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password:
                raise ArticleImportError('Unsupported image address: ' + target[:180])
            return 'remote'
    except ValueError as exc:
        raise ArticleImportError('Invalid image address') from exc
    return 'local'


def _image_asset(data):
    if not data or len(data) > MAX_IMAGE_BYTES:
        raise ArticleImportError('Image exceeds 10 MiB limit or is empty')
    try:
        from PIL import Image
    except ImportError as exc:
        raise ArticleImportError('Local image validation requires the bundled Pillow runtime') from exc
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('error', Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data)) as image:
                kind = image.format
                if kind not in IMAGE_FORMATS or image.width * image.height > 40_000_000:
                    raise ArticleImportError('Unsupported image format or image exceeds 40 million pixels')
                image.verify()
    except ArticleImportError:
        raise
    except Exception as exc:
        raise ArticleImportError('Invalid or damaged image material') from exc
    mime, extension = IMAGE_FORMATS[kind]
    digest = hashlib.sha256(data).hexdigest()
    return {'name': 'images/' + digest + extension, 'bytes': data, 'mime': mime, 'sha256': digest}


def _materials(content, files, article_path, base_url, report):
    references = _image_references(content)
    if len(references) > MAX_IMAGES:
        raise ArticleImportError('Article exceeds 128 image references', report=report)
    assets, replacements, remote, missing = {}, {}, [], []
    for start, end, target in references:
        target = target.strip()
        kind = _url_kind(target)
        if kind == 'local' and base_url:
            target = urljoin(base_url, target)
            kind = _url_kind(target)
        if kind == 'remote':
            if target not in remote:
                remote.append(target)
            if target != content[start:end]:
                replacements[(start, end)] = target.replace(' ', '%20')
            continue
        parsed = urlsplit(target)
        relative = unquote(parsed.path)
        if (not relative or relative.startswith(('/', '\\')) or '\\' in relative
                or ':' in relative or any(ord(c) < 32 for c in relative)):
            raise ArticleImportError('Unsafe local image reference: ' + target[:180], report=report)
        resolved = unicodedata.normalize('NFC', posixpath.normpath(posixpath.join(posixpath.dirname(article_path), relative)))
        if resolved == '..' or resolved.startswith('../'):
            raise ArticleImportError('Image reference escapes the archive root', report=report)
        if resolved not in files:
            missing.append(target)
            continue
        asset = _image_asset(files[resolved])
        assets[asset['name']] = asset
        replacements[(start, end)] = asset['name']
    report['remote_images'] = remote
    report['missing_images'] = list(dict.fromkeys(missing))
    if remote:
        report['warnings'].append('Remote images were retained; an explicit download action is required before publishing.')
    if missing:
        raise ArticleImportError('Missing local image material: ' + ', '.join(dict.fromkeys(missing))[:1200], report=report)
    for (start, end), value in sorted(replacements.items(), reverse=True):
        content = content[:start] + value + content[end:]
    if assets:
        report['conversions'].append('Relative image references rewritten to content-addressed images/ paths.')
    report['asset_count'] = len(assets)
    return content, list(assets.values())


def _fence(code, language=''):
    marker = '`' * max(3, 1 + max((len(m) for m in re.findall(r'`+', code)), default=0))
    return marker + language + '\n' + code + ('' if code.endswith('\n') else '\n') + marker


def _escape_prose(value):
    value = html.escape(value, quote=False)
    return re.sub(r'([\\`*_\[\]])', r'\\\1', value)


class _HtmlMarkdown:
    BLOCKS = {'p', 'div', 'section', 'article', 'figure', 'figcaption', 'pre', 'table',
              'ul', 'ol', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr'}

    def __init__(self, report):
        self.report = report

    def inline(self, node):
        if not getattr(node, 'name', None):
            return _escape_prose(re.sub(r'\s+', ' ', str(node)))
        name = node.name
        if name == 'img':
            alt = str(node.get('alt', '')).replace('[', r'\[').replace(']', r'\]')
            source = str(node.get('src') or node.get('data-src') or '')
            if not source:
                raise ArticleImportError('HTML image is missing src')
            return '![' + alt + '](<' + source.replace('>', '%3E').replace('<', '%3C') + '>)'
        if name == 'code':
            code = node.get_text('', strip=False)
            ticks = '`' * (1 + max((len(m) for m in re.findall(r'`+', code)), default=0))
            return ticks + ' ' + code + ' ' + ticks
        if name == 'br':
            return '  \n'
        value = ''.join(self.inline(child) for child in node.children)
        if name in ('strong', 'b'):
            return '**' + value + '**'
        if name in ('em', 'i'):
            return '*' + value + '*'
        if name == 'a' and node.get('href'):
            target = str(node['href'])
            try:
                if urlsplit(target).scheme.lower() not in ('', 'http', 'https', 'mailto'):
                    return value
            except ValueError:
                return value
            return '[' + value + '](<' + target.replace('>', '%3E') + '>)'
        return value

    def children(self, node):
        blocks, inline = [], []
        def flush():
            text = ''.join(inline).strip()
            if text:
                blocks.append(text)
            inline.clear()
        for child in node.children:
            if getattr(child, 'name', None) in self.BLOCKS:
                flush()
                value = self.block(child)
                if value.strip():
                    blocks.append(value)
            else:
                inline.append(self.inline(child))
        flush()
        return '\n\n'.join(blocks)

    def block(self, node):
        name = node.name
        if name == 'pre':
            code = node.get_text('', strip=False)
            language = ''
            for candidate in [node, *node.find_all('code')]:
                for token in candidate.get('class', []):
                    match = re.fullmatch(r'(?:language|lang)-([A-Za-z0-9_+#.-]{1,30})', token)
                    if match:
                        language = match[1]
            return _fence(code, language)
        if re.fullmatch(r'h[1-6]', name):
            return '#' * int(name[1]) + ' ' + self.inline(node).strip()
        if name == 'table':
            if node.find('table') or node.select('[rowspan], [colspan]'):
                self.report['warnings'].append('HTML merged or nested table flattened; check its cell relationships.')
            rows = [[self.children(cell).replace('\n', '<br>').replace('|', r'\|')
                     for cell in row.find_all(['th', 'td'], recursive=False)]
                    for row in node.find_all('tr') if row.find_parent('table') is node]
            caption = node.find('caption', recursive=False)
            return ((caption.get_text(' ', strip=True) + '\n\n') if caption else '') + _table(rows)
        if name in ('ul', 'ol'):
            return '\n'.join((f'{i}. ' if name == 'ol' else '- ') + self.children(child).replace('\n', '\n  ')
                             for i, child in enumerate(node.find_all('li', recursive=False), 1))
        if name == 'blockquote':
            return '\n'.join('> ' + line for line in self.children(node).splitlines())
        if name == 'hr':
            return '---'
        return self.children(node) if name in self.BLOCKS - {'p', 'figcaption'} else self.inline(node).strip()


def _table(rows):
    if not rows:
        return ''
    width = max(map(len, rows))
    if not width:
        return ''
    lines = ['| ' + ' | '.join(row + [''] * (width - len(row))) + ' |' for row in rows]
    lines.insert(1, '| ' + ' | '.join(['---'] * width) + ' |')
    return '\n'.join(lines)


def _html(data, base_url, report):
    try:
        from bs4 import BeautifulSoup, Comment
    except ImportError as exc:
        raise ArticleImportError('HTML conversion requires the bundled BeautifulSoup runtime') from exc
    soup = BeautifulSoup(_text(data), 'html.parser')
    metadata = {}
    for key, names in {'title': ('og:title',), 'author': ('author', 'article:author'),
                       'published_at': ('article:published_time', 'date'),
                       'digest': ('description', 'og:description'), 'source_url': ('og:url',)}.items():
        for name in names:
            match = soup.find('meta', attrs={'name': name}) or soup.find('meta', attrs={'property': name})
            if match and match.get('content'):
                metadata[key] = str(match['content']).strip()
                break
    canonical = soup.find('link', rel='canonical')
    if canonical and canonical.get('href'):
        metadata.setdefault('source_url', str(canonical['href']))
    body = soup.find('article') or soup.find('main') or soup.body or soup
    for comment in body.find_all(string=lambda value: isinstance(value, Comment)):
        comment.extract()
    removed = 0
    for node in list(body.select('script,style,iframe,object,embed,form,input,button,nav,header,footer,aside,base,link,meta,template')):
        if node.parent is not None:
            node.decompose()
            removed += 1
    if removed:
        report['conversions'].append('Removed active content and non-article HTML controls.')
    heading = body.find('h1')
    if heading:
        metadata.setdefault('title', heading.get_text(' ', strip=True))
    report['before'] = {'images': len(body.find_all('img')), 'fences': len(body.find_all('pre')), 'tables': len(body.find_all('table'))}
    renderer = _HtmlMarkdown(report)
    content = renderer.children(body) + '\n'
    if not content.strip():
        raise ArticleImportError('HTML has no importable article content')
    report['conversions'].append('HTML converted to Markdown; review layout and captions.')
    return content, metadata


def _docx(files, report):
    if 'word/document.xml' not in files:
        raise ArticleImportError('DOCX is missing word/document.xml')
    root = _xml(files['word/document.xml'])
    relations = {}
    if 'word/_rels/document.xml.rels' in files:
        for relation in _xml(files['word/_rels/document.xml.rels']):
            relations[relation.get('Id')] = relation.attrib
    metadata = {}
    if 'docProps/core.xml' in files:
        core = _xml(files['docProps/core.xml'])
        for tag, key in [('title', 'title'), ('creator', 'author'), ('created', 'published_at'), ('source', 'source_url')]:
            for value in core.iter():
                if value.tag.rsplit('}', 1)[-1] == tag and value.text:
                    metadata[key] = value.text
    seen_images, code_paragraphs = [], []

    def paragraph(node):
        style_node = node.find(W + 'pPr/' + W + 'pStyle')
        style = style_node.get(W + 'val', '') if style_node is not None else ''
        is_code = bool(re.search(r'code|source|代码|源码', style, re.I))

        def render(child):
            if child.tag in (W + 't', M + 't'):
                return (child.text or '') if is_code else _escape_prose(child.text or '')
            if child.tag == W + 'tab':
                return '\t'
            if child.tag in (W + 'br', W + 'cr'):
                return '\n'
            if child.tag == A + 'blip':
                key = child.get(R + 'embed') or child.get(R + 'link')
                relation = relations.get(key)
                if not relation or not relation.get('Type', '').endswith('/image'):
                    raise ArticleImportError('DOCX image has a missing or invalid relationship')
                target = relation.get('Target', '')
                if relation.get('TargetMode') == 'External':
                    if _url_kind(target) != 'remote':
                        raise ArticleImportError('DOCX external image is not an HTTP(S) reference')
                    source = target
                else:
                    if _url_kind(target) != 'local' or target.startswith('/'):
                        raise ArticleImportError('Unsafe DOCX embedded image relationship')
                    source = posixpath.normpath(posixpath.join('word', unquote(target)))
                    if source.startswith('../') or source == '..':
                        raise ArticleImportError('DOCX image relationship escapes archive root')
                seen_images.append(source)
                return '![](<'+ source.replace('>', '%3E').replace('<', '%3C') + '>)'
            value = ''.join(render(grandchild) for grandchild in child)
            if child.tag == W + 'hyperlink' and not is_code:
                relation = relations.get(child.get(R + 'id'), {})
                target = relation.get('Target', '')
                if target and relation.get('Type', '').endswith('/hyperlink'):
                    try:
                        if _url_kind(target) == 'remote':
                            return '[' + value + '](<' + target.replace('>', '%3E') + '>)'
                    except ArticleImportError:
                        report['warnings'].append('An unsafe DOCX hyperlink was retained as text only.')
            return value

        value = render(node)
        if is_code:
            code_paragraphs.append(node)
            return _fence(value)
        if style.lower() == 'title':
            metadata.setdefault('title', value.strip())
            return '# ' + value
        heading = re.fullmatch(r'(?:heading|标题)\s*([1-6])', style, re.I)
        if heading:
            if heading[1] == '1':
                metadata.setdefault('title', value.strip())
            return '#' * int(heading[1]) + ' ' + value
        return value.replace('\n', '  \n')

    def table(node):
        rows = []
        if node.find('.//' + W + 'gridSpan') is not None or node.find('.//' + W + 'vMerge') is not None:
            report['warnings'].append('DOCX merged cells converted to a simple table; verify cell relationships.')
        for row in node.findall(W + 'tr'):
            cells = []
            for cell in row.findall(W + 'tc'):
                blocks = [paragraph(child) if child.tag == W + 'p' else table(child)
                          for child in cell if child.tag in (W + 'p', W + 'tbl')]
                cells.append('<br>'.join(blocks).replace('|', r'\|'))
            rows.append(cells)
        return _table(rows)

    body = root.find(W + 'body')
    if body is None:
        raise ArticleImportError('DOCX has no document body')
    blocks = []
    def visit(parent):
        for child in parent:
            if child.tag == W + 'p':
                blocks.append(paragraph(child))
            elif child.tag == W + 'tbl':
                blocks.append(table(child))
            elif child.tag not in (W + 'sectPr',):
                visit(child)
    visit(body)
    if root.find('.//' + M + 'oMath') is not None or root.find('.//' + M + 'oMathPara') is not None:
        report['warnings'].append('DOCX formula text retained; complex formula layout requires review.')
    if root.find('.//' + W + 'del') is not None or root.find('.//' + W + 'ins') is not None:
        report['warnings'].append('DOCX contains tracked changes; review visible text against the original.')
    report['before'] = {'images': len(seen_images), 'fences': len(code_paragraphs), 'tables': len(root.findall('.//' + W + 'tbl'))}
    report['conversions'].append('DOCX paragraphs, simple tables and embedded images converted locally; review original layout.')
    content = '\n\n'.join(blocks) + '\n'
    if not content.strip():
        raise ArticleImportError('DOCX has no importable article content')
    return content, metadata


def _front_metadata(content):
    match = re.match(r'\A---\r?\n(.*?)\r?\n---(?:\r?\n|$)', content, re.S)
    if not match:
        return {}
    result = {}
    keys = {'title': 'title', 'author': 'author', 'source': 'source_url', 'source_url': 'source_url',
            'date': 'published_at', 'published_at': 'published_at', 'description': 'digest'}
    for line in match[1].splitlines():
        field = re.fullmatch(r'([a-z_]+):\s*(.+)', line)
        if field and field[1] in keys and field[2].strip() not in ('|', '>'):
            value = field[2].strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"):
                value = value[1:-1]
            result[keys[field[1]]] = value
    return result


def _package_bundle(files, article_path, report):
    """Recognize our format without applying unrelated ZIP metadata files."""
    raw_manifest = files.get('manifest.json')
    raw_metadata = files.get('metadata.json')
    candidate = {}
    if article_path == 'article.md' and raw_metadata and len(raw_metadata) <= MAX_METADATA_BYTES:
        try:
            candidate = read_package_json(raw_metadata, MAX_METADATA_BYTES)
        except PackageValidationError:
            pass
    publisher_metadata = {'title', 'cover', 'theme', 'font_size', 'code_wrap', 'table_mode'} <= candidate.keys()
    if raw_manifest is None:
        # A complete publisher metadata schema with its manifest removed must
        # not quietly become a generic ZIP and lose settings or unused images.
        if publisher_metadata:
            raise ArticleImportError('Publisher package is missing its manifest', report=report)
        return None
    try:
        try:
            manifest = read_package_json(raw_manifest, MAX_MANIFEST_BYTES)
        except PackageValidationError:
            if not publisher_metadata and not any(marker in raw_manifest for marker in (b'"render_version"', b'"content_sha256"', b'"asset_relations"')):
                return None
            raise
        is_package = any(key in manifest for key in ('render_version', 'content_sha256', 'asset_relations')) or (publisher_metadata and 'format' in manifest)
        if not is_package:
            return None
        if type(manifest.get('format')) is not int or manifest['format'] != 1:
            raise PackageValidationError('Unsupported publisher package format')
        if article_path != 'article.md' or 'metadata.json' not in files:
            raise PackageValidationError('Publisher package is missing article or metadata')
        digest = manifest.get('content_sha256')
        if not isinstance(digest, str) or not HASH.fullmatch(digest) or hashlib.sha256(files['article.md']).hexdigest() != digest:
            raise PackageValidationError('Publisher package article fingerprint does not match')
        if 'render_version' in manifest and (not isinstance(manifest['render_version'], str) or len(manifest['render_version']) > 512):
            raise PackageValidationError('Invalid publisher package renderer version')
        metadata = safe_package_metadata(read_package_json(files['metadata.json'], MAX_METADATA_BYTES))
        entries = manifest.get('assets')
        if not isinstance(entries, list) or len(entries) > MAX_ARCHIVE_FILES - 3:
            raise PackageValidationError('Invalid publisher package asset manifest')
        by_path = {}
        for entry in entries:
            if not isinstance(entry, dict):
                raise PackageValidationError('Invalid publisher package asset entry')
            path = package_asset_path(entry.get('path'))
            if path in by_path or path not in files:
                raise PackageValidationError('Package asset is missing or listed more than once')
            size, expected = entry.get('size'), entry.get('sha256')
            if type(size) is not int or size < 1 or size != len(files[path]) or not isinstance(expected, str) or not HASH.fullmatch(expected):
                raise PackageValidationError('Package image size or fingerprint is invalid')
            verified = _image_asset(files[path])
            if verified['sha256'] != expected:
                raise PackageValidationError('Package image fingerprint does not match material')
            by_path[path] = verified
        if set(files) != {'article.md', 'metadata.json', 'manifest.json'} | set(by_path):
            raise PackageValidationError('Publisher package has missing or unlisted files')
        cover = metadata.get('cover')
        if cover:
            if cover not in by_path:
                raise PackageValidationError('Publisher package cover image is missing')
            metadata['cover'] = by_path[cover]['name']
        validated = validate_relations(manifest.get('asset_relations', {}), by_path)
        remapped = {}
        for path, relation in validated.items():
            target = by_path[path]['name']
            relation = dict(relation)
            if relation.get('source_path'):
                relation['source_path'] = by_path[relation['source_path']]['name']
            elif relation.get('source_hash'):
                relation['source_path'] = next(asset['name'] for asset in by_path.values() if asset['sha256'] == relation['source_hash'])
            if target in remapped and remapped[target] != relation:
                raise PackageValidationError('Identical image bytes have conflicting provenance records')
            remapped[target] = relation
        assets = {asset['name']: asset for asset in by_path.values()}
        report['package'] = {'format': 1, 'render_version': manifest.get('render_version', ''), 'restored_assets': len(assets), 'restored_relations': len(remapped)}
        report['conversions'].append('Publisher package metadata, unused originals and cover restored; image relationships verified and remapped by SHA-256.')
        return {'metadata': metadata, 'assets': assets, 'asset_relations': remapped}
    except PackageValidationError as exc:
        raise ArticleImportError(str(exc), report=report) from exc


def prepare_import(filename, data, kind='auto', base_url='', metadata=None):
    """Prepare MD, ZIP(MD + images), DOCX, or explicitly selected HTML.

    Raises ArticleImportError on unsafe/incomplete input. No filesystem or network
    side effects. Returned asset names include ``images/``; bytes are raw bytes.
    Report counts describe image references, fenced blocks and table structures,
    not unique files. Fingerprint is SHA-256 of the complete original upload.
    """
    if not isinstance(filename, str) or not filename.strip() or len(filename) > 512 or re.search(r'[\x00-\x1f]', filename):
        raise ArticleImportError('Invalid source filename')
    if not isinstance(data, bytes) or not data or len(data) > MAX_INPUT_BYTES:
        raise ArticleImportError('Source must contain 1 byte to 12 MiB')
    if metadata is not None and not isinstance(metadata, dict):
        raise ArticleImportError('Metadata must be an object')
    if not isinstance(base_url, str) or (base_url and _url_kind(base_url) != 'remote'):
        raise ArticleImportError('Base URL must use HTTP(S)')
    if kind == 'auto':
        kind = {'.md': 'md', '.markdown': 'md', '.zip': 'zip', '.docx': 'docx'}.get(PurePosixPath(filename).suffix.lower())
    if kind == 'markdown':
        kind = 'md'
    if kind not in ('md', 'zip', 'docx', 'html'):
        raise ArticleImportError('Choose Markdown, ZIP, DOCX or explicit HTML import')
    fingerprint = hashlib.sha256(data).hexdigest()
    imported_at = datetime.now(timezone.utc).isoformat(timespec='seconds')
    report = {'status': 'ready', 'before': {}, 'after': {}, 'warnings': [], 'conversions': [],
              'remote_images': [], 'missing_images': [], 'fingerprint': fingerprint,
              'provenance': {'filename': filename, 'kind': kind, 'sha256': fingerprint, 'imported_at': imported_at}}
    files, article_path, extracted, bundle = {}, '', {}, None
    if kind == 'zip':
        files = _archive(data)
        candidates = [name for name in files if PurePosixPath(name).suffix.lower() in ('.md', '.markdown')]
        if len(candidates) != 1:
            raise ArticleImportError('ZIP must contain exactly one Markdown article', report=report)
        article_path = candidates[0]
        content = _text(files[article_path])
        extracted = _front_metadata(content)
        bundle = _package_bundle(files, article_path, report)
        if bundle:
            extracted.update(bundle['metadata'])
    elif kind == 'docx':
        files = _archive(data)
        content, extracted = _docx(files, report)
    elif kind == 'html':
        content, extracted = _html(data, base_url, report)
    else:
        content = _text(data)
        extracted = _front_metadata(content)
    if not report['before']:
        report['before'] = _counts(content)
    content, assets = _materials(content, files, article_path, base_url if kind == 'html' else '', report)
    if bundle:
        all_assets = {**bundle['assets'], **{asset['name']: asset for asset in assets}}
        assets = [all_assets[name] for name in sorted(all_assets)]
        report['asset_count'] = len(assets)
    report['after'] = _counts(content)
    _, _, unclosed = _protected_markdown(content)
    if unclosed:
        report['warnings'].append('Unclosed code fence: review the original Markdown.')
    if report['before'] != report['after']:
        report['warnings'].append('Structure counts changed during conversion; compare against the original source.')
    if metadata:
        for key in ('title', 'author', 'source_url', 'published_at', 'digest'):
            if key in metadata:
                if not isinstance(metadata[key], str) or len(metadata[key]) > 4096:
                    raise ArticleImportError('Invalid metadata field: ' + key, report=report)
                extracted[key] = metadata[key]
    if base_url:
        extracted.setdefault('source_url', base_url)
    source = extracted.get('source_url', '')
    if source:
        try:
            valid_source = _url_kind(source) == 'remote'
        except ArticleImportError:
            valid_source = False
        if not valid_source:
            report['warnings'].append('Source URL is not a valid HTTP(S) URL and was left empty for review.')
            extracted['source_url'] = ''
    heading = re.search(r'^ {0,3}#\s+(.+?)\s*#*\s*$', _protected_markdown(content)[0], re.M)
    title = extracted.get('title') or (heading[1] if heading else PurePosixPath(filename.replace('\\', '/')).stem)
    extracted['title'] = title
    for key, value in {'imported_at': imported_at, 'import_fingerprint': fingerprint, 'import_kind': kind}.items():
        if bundle:
            extracted.setdefault(key, value)
        else:
            extracted[key] = value
    if report['warnings']:
        report['status'] = 'needs_review'
    result = {'content': content, 'title': title, 'assets': assets, 'metadata': extracted, 'report': report,
            'source_original': {'filename': filename.replace('\\', '/').rsplit('/', 1)[-1], 'bytes': data,
                                'kind': kind, 'sha256': fingerprint}}
    if bundle:
        result['asset_relations'] = bundle['asset_relations']
    return result
