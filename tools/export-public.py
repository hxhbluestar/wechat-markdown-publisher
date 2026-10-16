"""Export an allowlisted, sanitized source snapshot without local Git history.

Run with the destination checkout path. Existing public Git metadata is kept;
files removed upstream must be reviewed and removed from the public tree by hand.
"""
from pathlib import Path
import json
import shutil
import subprocess
import sys


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
    'tools/build_frontend.py', 'tools/deploy-typography.ps1', 'tools/export-public.py',
    'package.json', 'package-lock.json',
}
copied = []
for relative in tracked:
    if not relative or not (relative.startswith(prefixes) or relative in standalone_files):
        continue
    target = destination / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(root / relative, target)
    copied.append(relative)

# Archive-specific editorial metadata is content, not application source.
for name in ('article-type-overrides.json', 'article-image-exclusions.json',
             'article-image-placements.json', 'article-image-placements.generated.json'):
    (destination / 'app/web' / name).write_text('{}\n', encoding='utf-8')

# The tests use global IPv4 fixtures because policy rejects non-global egress.
public_markers = {
    '8.8.8.8':'8.8.8.8', '9.9.9.9':'9.9.9.9',
    '1.1.1.1':'1.1.1.1', '192.0.2.23':'192.0.2.23',
    '192.0.2.1':'192.0.2.1',
    'imported-assets': 'imported-assets', 'draft-20000101-': 'draft-20000101-',
}
for relative in ('tests/test_company_network.py', 'tools/export-public.py'):
    exported = destination / relative
    text = exported.read_text('utf-8')
    for before, after in public_markers.items():
        text = text.replace(before, after)
    exported.write_text(text, encoding='utf-8')
for name in ('test_asset_sync.py', 'asset-paths.test.mjs'):
    test = destination / 'tests' / name
    text = test.read_text('utf-8').replace('imported-assets', 'imported-assets')
    test.write_text(text.replace('draft-20000101-', 'draft-20000101-'), encoding='utf-8')
(destination / 'config/company-network.example.json').write_text(json.dumps({
    'mode':'company_direct', 'expected_public_ip':'YOUR_FIXED_PUBLIC_IPV4',
    'interface_alias':'WLAN', 'gateway':'YOUR_LOCAL_GATEWAY', 'interface_guid':''
}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

shutil.copyfile(root / '.gitignore', destination / '.gitignore')
with (destination / '.gitignore').open('a', encoding='utf-8') as stream:
    stream.write('\n# Local archive, account configuration and generated content\n'
                 '**/knowledge_base/\n**/output/\n**/cookie_cache/\n'
                 '**/.cache/\n**/wechat.env\n'
                 'config.yaml\nconfig.yml\napp/config.yaml\napp/config.yml\n')
for path in (root / 'publication').rglob('*'):
    if path.is_file():
        target = destination / path.relative_to(root / 'publication')
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, target)
print(f'Exported {len(copied)} application/source files plus public documentation. No Git history copied.')
