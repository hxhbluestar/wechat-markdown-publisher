"""Narrow CSP support for the editor's preserved module dependency graph."""
import base64
import hashlib
import re
from pathlib import Path


def import_map_csp(page: Path) -> str:
    """Allow only the exact static import map, never arbitrary inline scripts."""
    try:
        source = page.read_text(encoding='utf-8')
    except OSError:
        return ''
    match = re.search(r'<script type="importmap">([^<]*)</script>', source)
    if not match:
        return ''
    digest = base64.b64encode(hashlib.sha256(match[1].encode('utf-8')).digest()).decode('ascii')
    return f" 'sha256-{digest}'"
