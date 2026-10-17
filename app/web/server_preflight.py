"""Server-verifiable publication gates, without mutation or network access.

The fingerprint binds private source/metadata, revision, complete referenced
asset bytes, rendered HTML, renderer and target account. It is an acknowledgement
token, not a substitute for locking and rechecking the same snapshot at sync.
``can_sync`` means no definite blockers; the caller must separately require each
confirmation issue to be acknowledged against this exact fingerprint.

Offsets are UTF-16 for browser editors. Public messages never quote matched
credentials, usernames, URLs or missing paths. This is structural validation,
not a replacement for the existing offline proofreading dictionary or a real
WeChat device preview. Inline SVG requires an explicit raster derivative.
"""
from __future__ import annotations

import hashlib
import html
import ipaddress
import json
import re
from collections import Counter
from itertools import chain
from pathlib import Path
from urllib.parse import unquote, urlsplit

from article_import import ArticleImportError, _image_references, _protected_markdown
from article_package import RENDER_VERSION
from asset_workbench import AssetWorkbenchError, MAX_IMAGE_BYTES, inspect_image


MAX_HTML_BYTES = 5 * 1024 * 1024
MAX_MARKDOWN_BYTES = 6 * 1024 * 1024
MAX_ISSUES = 512
MAX_HTML_NODES = 20000
FORBIDDEN_TAGS = {'script', 'iframe', 'object', 'embed', 'foreignobject', 'form', 'input',
                  'button', 'link', 'base', 'style', 'video', 'audio', 'source'}
MASKED = '[已脱敏]'


def _bytes(value):
    return value.encode('utf-8', errors='surrogatepass')


def _utf16(value, offset):
    return len(value[:offset].encode('utf-16-le', errors='surrogatepass')) // 2


def _mask_math(value):
    return re.sub(r'(?<!\\)\$\$.*?(?<!\\)\$\$|(?<![\\$])\$(?!\$)[^$\n]+(?<!\\)\$(?!\$)',
                  lambda match: re.sub(r'[^\r\n]', ' ', match[0]), value, flags=re.S)


def _private_findings(value):
    """Yield only category and offsets; never embed a matched value in a report."""
    for match in re.finditer(r'\b(?:\d{1,3}\.){3}\d{1,3}\b', value):
        try:
            address = ipaddress.ip_address(match[0])
        except ValueError:
            continue
        if any(address in network for network in (ipaddress.ip_network('10.0.0.0/8'), ipaddress.ip_network('172.16.0.0/12'),
                                                  ipaddress.ip_network('192.168.0.0/16'), ipaddress.ip_network('127.0.0.0/8'),
                                                  ipaddress.ip_network('169.254.0.0/16'))):
            yield 'privacy-private-ip', match.start(), match.end()
    for match in re.finditer(r'(?<![\w:])(?:f[cd][0-9a-f]{2}:[0-9a-f:]+|fe[89ab][0-9a-f]:[0-9a-f:]+|::1)(?![\w:])', value, re.I):
        yield 'privacy-private-ip', match.start(), match.end()
    credential = r'''\b[A-Z_]*(?:API[_-]?KEY|ACCESS[_-]?TOKEN|API[_-]?TOKEN|AUTH[_-]?TOKEN|SECRET|PASSWORD|PASSWD|TOKEN)[A-Z_]*\b["']?\s*[:=]\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s\r\n;,]+))'''
    for match in re.finditer(credential, value, re.I):
        secret = next((part for part in match.groups() if part is not None), '')
        if len(secret) < 8 or re.fullmatch(r'<[^>]*>|\$\{[^}]*\}|\$\w+|your[_-].*|example|placeholder|redacted|\*+|x+', secret, re.I):
            continue
        start = match.start() + match[0].rfind(secret)
        yield 'privacy-secret', start, start + len(secret)
    for match in re.finditer(r'\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bBearer[ \t]+[A-Za-z0-9_.~+/-]{12,}={0,2}', value):
        yield 'privacy-secret', match.start(), match.end()
    for match in re.finditer(r'''(?:\b[A-Za-z]:[\\/]Users[\\/]|/home/|/Users/)([^\s\\/<>"'`]+)|\b([A-Za-z_][\w.-]*)@(?=[A-Za-z0-9][A-Za-z0-9.-]*(?::|\b))''', value):
        username = match[1] or match[2]
        if re.fullmatch(r'user|username|example|your_user|your_username|root', username, re.I):
            continue
        start = match.start() + match[0].rfind(username)
        yield 'privacy-username', start, start + len(username)
    for match in re.finditer(r'''\b(?:hostname|host_name|主机名)\s*[:=]\s*["']?([A-Za-z][\w.-]{2,})''', value, re.I):
        if not re.fullmatch(r'localhost|example|your[-_]host', match[1], re.I):
            yield 'privacy-hostname', match.start(1), match.end(1)


def _fenced_blocks(content):
    opened, language, start, lines = None, '', 0, []
    for line in content.splitlines(keepends=True):
        logical = re.sub(r'^(?: {0,3}>[ \t]?)+', '', line)
        marker = re.match(r'^ {0,3}(`{3,}|~{3,})([^\r\n]*)(?:\r?\n)?$', logical)
        if opened:
            if marker and marker[1][0] == opened[0] and len(marker[1]) >= len(opened) and not marker[2].strip():
                yield language, ''.join(lines)
                opened, lines = None, []
            else:
                lines.append(logical)
        elif marker:
            opened, language = marker[1], marker[2].strip().split(' ', 1)[0].lower()


def _canonical_source(source, draft_id):
    source = html.unescape(str(source or '')).strip()
    parsed = urlsplit(source)
    if parsed.scheme.lower() in ('http', 'https') or source.startswith('//'):
        return None, 'image-remote'
    if parsed.scheme or source.startswith(('\\', '/')):
        prefix = '/api/editor/drafts/' + draft_id + '/assets/'
        if source.startswith(prefix):
            source = source[len(prefix):]
        else:
            return None, 'image-unsafe'
    if not source or '?' in source or '#' in source:
        return None, 'image-unsafe'
    source = unquote(source).replace('\\', '/')
    if source.startswith('/') or ':' in source or re.search(r'[\x00-\x1f\x7f]', source):
        return None, 'image-unsafe'
    parts = [part for part in source.split('/') if part not in ('', '.')]
    if not parts or '..' in parts:
        return None, 'image-unsafe'
    relative = '/'.join(parts)
    if not re.search(r'\.(?:png|jpe?g|gif|webp)$', relative, re.I):
        return None, 'image-unsupported'
    if not relative.startswith('images/') and not re.fullmatch(r'cover\.(?:png|jpe?g|gif|webp)', relative, re.I):
        relative = 'images/' + relative
    return relative, None


def _styles(value):
    return {key.strip().lower(): val.strip().lower() for declaration in value.split(';')
            if ':' in declaration for key, val in [declaration.split(':', 1)]}


def _css(value):
    value = re.sub(r'/\*.*?\*/', '', value, flags=re.S)
    return re.sub(r'\\([0-9a-fA-F]{1,6})\s?|\\(.)',
                  lambda match: chr(min(int(match[1], 16), 0x10FFFF)) if match[1] else match[2], value)


def _inline_font(node):
    for depth, ancestor in enumerate(chain((node,), node.parents)):
        if depth > 128:
            return None
        style = ancestor.get('style', '') if hasattr(ancestor, 'get') else ''
        if isinstance(style, str):
            font = _pixels(_styles(style).get('font-size', ''))
            if font is not None:
                return font
    return None


def _line_height(value, font):
    pixels = _pixels(value)
    if pixels is not None:
        return pixels
    relative = re.fullmatch(r'(\d+(?:\.\d+)?|\.\d+)(%|em)?(?:\s*!important)?', value or '')
    if relative and font is not None:
        return float(relative[1]) * font / (100 if relative[2] == '%' else 1)
    return None


def _pixels(value):
    match = re.fullmatch(r'(\d+(?:\.\d+)?)px(?:\s*!important)?', value or '')
    return float(match[1]) if match else None


def preflight_article(store, draft, source_html, render_version, account_id):
    """Inspect one immutable caller snapshot and referenced local image bytes.

    The caller should hold its draft/asset lock throughout preflight and use the
    same locked snapshot when scheduling sync. Report asset paths are canonical
    local paths only; suspicious names are omitted from the public inventory.
    """
    content = draft.get('content', '')
    metadata = draft.get('metadata') if isinstance(draft.get('metadata'), dict) else {}
    draft_id = str(draft.get('id', ''))
    content = content if isinstance(content, str) else ''
    valid_html = isinstance(source_html, str)
    source_html = source_html if valid_html else ''
    issues, issue_keys, assets, asset_state = [], set(), {}, {}
    reference_counts = {'content': Counter(), 'html': Counter()}
    truncated = False

    def issue(code, severity, field, message, start=None, end=None):
        nonlocal truncated
        original = content if field == 'content' else source_html if field == 'html' else str(metadata.get(field, ''))
        start16 = _utf16(original, start) if start is not None else None
        end16 = _utf16(original, end) if end is not None else None
        key = (code, field, start16)
        if key in issue_keys:
            return
        if len(issues) >= MAX_ISSUES:
            truncated = True
            return
        issue_keys.add(key)
        item = {'id': f'server-{code}-{field}-{start16 if start16 is not None else 0}',
                'code': code, 'severity': severity, 'field': field, 'message': message}
        if start16 is not None:
            item.update({'from': start16, 'to': end16})
        issues.append(item)

    def check_asset(source, field, start=None, end=None):
        try:
            relative, error = _canonical_source(source, draft_id)
        except (ValueError, TypeError):
            relative, error = None, 'image-unsafe'
        if error:
            issue(error, 'blocker', field, '图片引用不可发布；请使用已核对的本地 PNG、JPEG、GIF 或 WebP 素材。', start, end)
            asset_state[str(source)] = {'error': error}
            return
        if relative not in asset_state:
            try:
                # DraftStore validates canonical containment before this read.
                # Independently reject symlink ancestors, including links that
                # resolve back inside the draft; preflight never follows links.
                folder = Path(store.root) / draft_id
                candidate = folder / relative
                if any(part.is_symlink() for part in [candidate, *candidate.parents] if part != Path(store.root).parent):
                    raise ValueError('Linked asset')
                path = store.asset_path(draft_id, relative)
                if path.stat().st_size > MAX_IMAGE_BYTES:
                    asset_state[relative] = {'error': 'image-corrupt', 'size': path.stat().st_size}
                else:
                    with path.open('rb') as stream:
                        data = stream.read(MAX_IMAGE_BYTES + 1)
                    digest = hashlib.sha256(data).hexdigest()
                    asset_state[relative] = {'sha256': digest, 'size': len(data)}
                    try:
                        inspect_image(data)
                    except AssetWorkbenchError:
                        asset_state[relative]['error'] = 'image-corrupt'
            except Exception:
                asset_state[relative] = {'error': 'image-missing'}
        state = asset_state[relative]
        if state.get('error'):
            issue(state['error'], 'blocker', field, '图片缺失、损坏或超过本地验证限制；已停止同步。', start, end)
        elif list(_private_findings(relative)):
            issue('privacy-asset-name', 'confirm', field, '素材文件名包含潜在敏感信息 ' + MASKED + '，请确认或重命名。', start, end)
        else:
            assets[relative] = {'path': relative, 'sha256': state['sha256'], 'size': state['size']}
        if field in reference_counts and not state.get('error'):
            reference_counts[field][relative] += 1

    if not str(metadata.get('title', '')).strip():
        issue('title-empty', 'blocker', 'title', '文章标题不能为空。')
    if not content.strip():
        issue('body-empty', 'blocker', 'content', 'Markdown 正文不能为空。')
    if not metadata.get('cover'):
        issue('cover-missing', 'blocker', 'cover', '请先选择并核对封面图片。')
    else:
        check_asset(metadata['cover'], 'cover')
    if not account_id or not metadata.get('wechat_account_id'):
        issue('account-missing', 'blocker', 'account', '请保存要同步的公众号账号。')
    elif account_id != metadata.get('wechat_account_id'):
        issue('account-mismatch', 'blocker', 'account', '目标账号与稿件已保存的账号不一致，请重新核对。')
    if render_version != RENDER_VERSION:
        issue('render-version', 'blocker', 'renderer', '排版器版本已变化，请刷新并重新生成预检报告。')
    if not valid_html or not source_html.strip():
        issue('html-empty', 'blocker', 'html', '排版结果为空或无效。')
    html_oversize = len(_bytes(source_html)) > MAX_HTML_BYTES
    if html_oversize:
        issue('html-oversize', 'blocker', 'html', '排版结果超过本地 5 MiB 验证限制。')
    if len(_bytes(content)) > MAX_MARKDOWN_BYTES:
        issue('body-oversize', 'blocker', 'content', 'Markdown 正文超过本地验证限制。')
    else:
        masked, _, unclosed = _protected_markdown(content)
        masked = _mask_math(masked)
        masked = re.sub(r'<!--[\s\S]*?-->|<(pre|code)\b[^>]*>[\s\S]*?</\1\s*>',
                        lambda match: re.sub(r'[^\r\n]', ' ', match[0]), masked, flags=re.I)
        if unclosed:
            issue('code-fence-unclosed', 'confirm', 'content', '代码围栏未闭合，请核对原文。')
        try:
            for start, end, source in _image_references(masked):
                check_asset(html.unescape(content[start:end]), 'content', start, end)
        except ArticleImportError:
            issue('image-syntax', 'blocker', 'content', '图片引用不完整或数量超出验证限制，请修复后重新核对。')
    for field, value in [('content', content), ('title', str(metadata.get('title', ''))), ('digest', str(metadata.get('digest', ''))),
                         ('author', str(metadata.get('author', '')))]:
        for code, start, end in _private_findings(value):
            issue(code, 'confirm', field, '检测到潜在敏感信息 ' + MASKED + '，请确认是否适合公开。', start, end)
        prose = _protected_markdown(value)[0] if field == 'content' else value
        for match in re.finditer(r'\b(?:TODO|FIXME|TBD)\b|待补充|待完善|占位(?:符|内容)?|请在此填写', prose, re.I):
            issue('placeholder', 'confirm', field, '检测到待完成或占位内容，请逐项核对。', match.start(), match.end())
    if not str(metadata.get('source_url', '')).strip():
        issue('source-empty', 'confirm', 'source_url', '原文来源链接为空，请确认原创或补充转载来源。')

    if valid_html and source_html.strip() and not html_oversize:
        try:
            from bs4 import BeautifulSoup, Comment
            soup = BeautifulSoup(source_html, 'html.parser')
        except Exception:
            issue('html-parser', 'blocker', 'html', '无法安全核对排版结果，请检查本地解析组件。')
            soup = None
        if soup is not None:
            lines, running = [0], 0
            for line in source_html.splitlines(keepends=True):
                running += len(line)
                lines.append(running)

            def node_offset(node):
                line = getattr(node, 'sourceline', None)
                position = getattr(node, 'sourcepos', None)
                return lines[line - 1] + position if line and position is not None and line <= len(lines) else None

            for node_index, node in enumerate(soup.find_all(True)):
                if node_index >= MAX_HTML_NODES:
                    issue('html-analysis-limit', 'blocker', 'html', '排版节点过多，验证未完成，请简化结构后重试。')
                    break
                start = node_offset(node)
                end = source_html.find('>', start) + 1 if start is not None else None
                attrs = {str(key).lower(): value for key, value in node.attrs.items()}
                unsafe = node.name.lower() in FORBIDDEN_TAGS
                unsafe = unsafe or any(name.startswith('on') or name in ('srcdoc', 'srcdata', 'srcset', 'xlink:href') for name in attrs)
                for attr in ('href', 'action', 'poster', 'background'):
                    value = attrs.get(attr)
                    if isinstance(value, str) and re.match(r'(?:javascript|vbscript|data|file):', re.sub(r'[\x00-\x20]', '', value), re.I):
                        unsafe = True
                style = attrs.get('style', '')
                style = style if isinstance(style, str) else ''
                if re.search(r'url\s*\(|@import|expression\s*\(|-moz-binding|\bbehavior\s*:', _css(style), re.I):
                    unsafe = True
                if node.name == 'img' and start is not None and node.get('src') and not re.search(r'''\bsrc\s*=\s*["']''', source_html[start:end], re.I):
                    # The publisher rewrites quoted src attributes. An unquoted
                    # local path would otherwise survive as a broken remote img.
                    unsafe = True
                if unsafe:
                    issue('html-unsafe', 'blocker', 'html', '排版结果包含危险标签、属性或外部样式依赖，请先移除。', start, end)
                if node.name == 'img' and not node.find_parent(['pre', 'code']):
                    if not node.get('src'):
                        issue('image-missing', 'blocker', 'html', '排版图片缺少 src 地址。', start, end)
                    else:
                        check_asset(node['src'], 'html', start, end)
                if node.name == 'svg':
                    issue('svg-raster-required', 'blocker', 'html', 'SVG 图表需要明确转换为本地 PNG 素材后同步。', start, end)
                classes = set(node.get('class', []))
                if (classes & {'mermaid', 'language-mermaid'} and node.name in ('pre', 'code', 'div')) or node.get('data-language') == 'mermaid':
                    issue('diagram-unresolved', 'blocker', 'html', 'Mermaid 图表尚未转换为可发布的本地图片。', start, end)
                if classes & {'language-math', 'language-latex', 'language-tex'}:
                    issue('math-unresolved', 'blocker', 'html', '公式仍为源码，请先完成公式渲染或转换。', start, end)
                declarations = _styles(style)
                font = _inline_font(node)
                line_height = declarations.get('line-height', '')
                line_px = _line_height(line_height, font)
                if font and line_px is not None and line_px < font:
                    issue('layout-line-height', 'blocker', 'html', '文字行高低于字号，存在重叠风险。', start, end)
                hidden = any(declarations.get(key, '').split(' ')[0] in ('hidden', 'clip') for key in ('overflow', 'overflow-y'))
                fixed = _pixels(declarations.get('height', '')) or _pixels(declarations.get('max-height', ''))
                if hidden and fixed and node.get_text(strip=True):
                    minimum_lines = 1 + len(node.find_all('br'))
                    if font and fixed < max(font, line_px or font) * minimum_lines:
                        issue('layout-clipping', 'blocker', 'html', '文字容器高度低于已知文字高度并隐藏溢出，会裁掉正文。', start, end)
                    else:
                        issue('layout-fixed-height', 'confirm', 'html', '文字容器固定高度并隐藏溢出，请核对内容是否完整可见。', start, end)
            for relative, expected in reference_counts['content'].items():
                if reference_counts['html'][relative] < expected:
                    issue('image-render-missing', 'blocker', 'html', '正文图片未全部保留在排版结果中，请重新生成并核对。')
            for text in soup.find_all(string=True):
                if isinstance(text, Comment):
                    continue
                parent = text.parent
                if parent and not parent.find_parent(['pre', 'code', 'math', 'script', 'style']) and parent.name not in ('pre', 'code', 'math', 'script', 'style'):
                    if re.search(r'(?<!\\)\$\$.+?\$\$', str(text), re.S):
                        issue('math-unresolved', 'blocker', 'html', '排版结果仍含未渲染的公式源码。')
            source_blocks = list(_fenced_blocks(content))
            plain_source = [code for language, code in source_blocks if language not in ('mermaid', 'math', 'latex', 'tex')]
            rendered = soup.select('pre > code')
            if plain_source and len(plain_source) == len(rendered):
                for index, (original, node) in enumerate(zip(plain_source, rendered)):
                    raw = node.get('data-source-code')
                    reliable = isinstance(raw, str) or not node.find(True)
                    decoded = unquote(raw) if isinstance(raw, str) else node.get_text('', strip=False)
                    # Browsers normalize CRLF; the final code newline is a
                    # fence delimiter convention, not proof of changed code.
                    normalize = lambda value: value.replace('\r\n', '\n').removesuffix('\n')
                    if reliable and normalize(decoded) != normalize(original):
                        issue('code-changed', 'blocker', 'html', '可可靠比对的代码原文与排版结果不同，请修复后同步。', node_offset(node), None)
                    elif not reliable:
                        issue('code-comparison', 'info', 'html', '复杂代码排版无法静态证明原文一致，请核对可复制代码。', node_offset(node), None)
            elif plain_source:
                issue('code-comparison', 'info', 'html', '代码块结构变化，请核对可复制代码原文。')
            for language, code in source_blocks:
                if language in ('mermaid', 'math', 'latex', 'tex'):
                    if any(node.get_text('', strip=False).strip() == code.strip() for node in soup.find_all('pre')):
                        issue('diagram-unresolved' if language == 'mermaid' else 'math-unresolved', 'blocker', 'html', '图表或公式源码尚未转换为发布格式。')
            if soup.find('math') or soup.select_one('.katex'):
                issue('math-device-preview', 'info', 'html', '已渲染公式仍需在真实微信端核对显示。')
    if truncated:
        issues.append({'id': 'server-report-truncated', 'code': 'report-truncated', 'severity': 'blocker',
                       'field': 'content', 'message': '问题数量超出报告上限，验证未完成，请分批修复后重试。'})
    private_manifest = {'version': 1, 'draft_id': draft_id, 'revision': draft.get('revision'), 'content': content,
                        'metadata': metadata, 'assets': asset_state, 'html_sha256': hashlib.sha256(_bytes(source_html)).hexdigest(),
                        'render_version': render_version, 'expected_renderer': RENDER_VERSION, 'account_id': account_id}
    fingerprint = hashlib.sha256(json.dumps(private_manifest, ensure_ascii=True, sort_keys=True, separators=(',', ':'), default=str).encode()).hexdigest()
    counts = {severity: sum(item['severity'] == severity for item in issues) for severity in ('blocker', 'confirm', 'info')}
    return {'fingerprint': fingerprint, 'issues': issues, 'counts': counts, 'can_sync': counts['blocker'] == 0,
            'assets': [assets[key] for key in sorted(assets)], 'render_version': RENDER_VERSION}
