"""Export an allowlisted, sanitized source snapshot without local Git history.

Run with the destination checkout path. Existing public Git metadata is kept;
files removed upstream must be reviewed and removed from the public tree by hand.
"""
from pathlib import Path
import json
import shutil
import subprocess
import sys
import re


root = Path(__file__).resolve().parents[1]
if len(sys.argv) != 2:
    raise SystemExit('Usage: python tools/export-public.py <public-checkout-directory>')
destination = Path(sys.argv[1]).resolve()
if destination == root or root in destination.parents or destination in root.parents:
    raise SystemExit('Use a separate public checkout outside the private source tree')
if not (root / 'app/web/company_network.py').is_file():
    raise SystemExit('Unexpected source layout')
tracked = subprocess.check_output(['git', 'ls-files', '-z'], cwd=root).decode().split('\0')
prefixes = ('app/', 'frontend/', 'tests/', 'config/', 'packaging/', 'scripts/')
standalone_files = {
    'tools/build_frontend.py', 'tools/build-frontend.mjs', 'tools/deploy-typography.ps1', 'tools/export-public.py',
    'package.json', 'package-lock.json', '.github/workflows/ci.yml',
}
private_parts = {'private', 'data', 'logs', 'runtime', 'output', 'knowledge_base', '.cache',
                 'releases', 'snapshots', 'node_modules', '__pycache__', '.git', '.worktrees'}
editorial = {'article-type-overrides.json', 'article-image-exclusions.json',
             'article-image-placements.json', 'article-image-placements.generated.json'}


def public_path(relative):
    parts = Path(relative).parts
    if any(part.casefold() in private_parts for part in parts):
        return False
    if relative.startswith('config/') and relative not in {'config/company-network.example.json', 'config/deployment-files.json'}:
        return False
    name = Path(relative).name.casefold()
    if (name.startswith(('.env', 'private-')) or name.endswith(('.env', '.pem', '.key', '.pkl', '.db', '.log'))
            or re.search(r'cookie|wechat[-_]accounts?|app[-_]?secret', name)):
        return False
    if relative in {'app/config.yaml', 'app/config.yml', 'config.yaml', 'config.yml'}:
        return False
    return True


def target_path(relative):
    target = destination / relative
    if linked_path(target, destination) or destination not in target.resolve().parents:
        raise SystemExit('Refusing an export path outside the public checkout')
    target.parent.mkdir(parents=True, exist_ok=True)
    return target


def linked_path(path, boundary):
    for entry in (path, *path.parents):
        if entry == boundary:
            break
        if entry.is_symlink() or (hasattr(entry, 'is_junction') and entry.is_junction()):
            return True
    return False


def copy_public(source, relative):
    # Even a force-tracked symlink must not read user content outside source.
    if linked_path(source, root) or root not in source.resolve().parents:
        raise SystemExit('Refusing a linked source outside the export boundary')
    shutil.copyfile(source, target_path(relative))


copied = []
for relative in tracked:
    if not relative or not public_path(relative) or not (relative.startswith(prefixes) or relative in standalone_files):
        continue
    if (relative.startswith('app/web/') and Path(relative).name in editorial) or relative == 'config/company-network.example.json':
        continue
    source = root / relative
    if not source.is_file():
        raise SystemExit('Tracked export input is missing or not a file')
    copy_public(source, relative)
    copied.append(relative)

# Archive-specific editorial metadata is content, not application source.
for name in sorted(editorial):
    target_path('app/web/' + name).write_text('{}\n', encoding='utf-8')

# The tests use global IPv4 fixtures because policy rejects non-global egress.
public_markers = {
    # A documentation-only fixture remains stable after this script exports
    # itself, so privacy regressions can also run in the public checkout.
    '203.0.113.234': '8.8.8.8',
    '8.8.8.8':'8.8.8.8', '9.9.9.9':'9.9.9.9',
    '1.1.1.1':'1.1.1.1', '192.0.2.23':'192.0.2.23',
    '192.0.2.1':'192.0.2.1',
    'imported-assets': 'imported-assets', 'draft-20000101-': 'draft-20000101-',
}
for relative in ('tests/test_company_network.py', 'tools/export-public.py'):
    exported = destination / relative
    if not exported.is_file():
        continue
    text = exported.read_text('utf-8')
    for before, after in public_markers.items():
        if relative == 'tools/export-public.py' and before == '203.0.113.234':
            continue
        text = text.replace(before, after)
    exported.write_text(text, encoding='utf-8')
for name in ('test_asset_sync.py', 'asset-paths.test.mjs'):
    test = destination / 'tests' / name
    if not test.is_file():
        continue
    text = test.read_text('utf-8').replace('imported-assets', 'imported-assets')
    test.write_text(text.replace('draft-20000101-', 'draft-20000101-'), encoding='utf-8')
target_path('config/company-network.example.json').write_text(json.dumps({
    'mode':'company_direct', 'expected_public_ip':'YOUR_FIXED_PUBLIC_IPV4',
    'interface_alias':'WLAN', 'gateway':'YOUR_LOCAL_GATEWAY', 'interface_guid':''
}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

copy_public(root / '.gitignore', '.gitignore')
with (destination / '.gitignore').open('a', encoding='utf-8') as stream:
    stream.write('\n# Local archive, account configuration and generated content\n'
                 '**/knowledge_base/\n**/output/\n**/cookie_cache/\n'
                 '**/.cache/\n**/wechat.env\n'
                 'config.yaml\nconfig.yml\napp/config.yaml\napp/config.yml\n')
for path in (root / 'publication').rglob('*'):
    relative = path.relative_to(root / 'publication').as_posix()
    top = relative.split('/', 1)[0]
    allowed_doc = (top in {'docs', 'licenses'} and path.suffix.lower() in {'.md', '.txt'}) or (
        '/' not in relative and (relative in {'README.md', 'THIRD_PARTY_NOTICES.md', 'LICENSE', 'LICENSE.txt'}
                                or re.fullmatch(r'requirements[-\w]*\.txt', relative)))
    if path.is_file() and public_path(relative) and allowed_doc:
        copy_public(path, relative)
print(f'Exported {len(copied)} application/source files plus public documentation. No Git history copied.')
