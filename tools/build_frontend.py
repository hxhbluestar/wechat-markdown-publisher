"""Rebuild the preserved editor patch from the original shipped bundle."""

from pathlib import Path
import shutil


root = Path(__file__).resolve().parents[1]
assets = root / "app" / "web" / "editor" / "assets"
source = (assets / 'index-CIPbZpsp.js').read_text('utf-8')
changes = [
    ('const r=s6(n[1]||n[2]||"");r&&!e.includes(r)',
     'const r=canonicalAssetPath(s6(n[1]||n[2]||""),H.current?.id);r&&!e.includes(r)'),
    ('const n=e.replace(/^\\.\\//,"").replace(/\\\\/g,"/");return n.startsWith',
     'const n=canonicalAssetPath(e,t);return n.startsWith'),
    ('H.assets=e.items,jl()', 'H.assets=e.items,jl(),vo()'),
    ('H.assets=[],jl(),ct(e.message,!0)', 'H.assets=[],jl(),vo(),ct(e.message,!0)'),
    ('[!n.some(xf),"正文图片均为本地素材"]',
     '[!n.some(xf),"正文图片均为本地素材"],[missingImagePaths(n,H.assets,H.current.id).length===0,"正文图片素材已全部上传"]'),
    ('for(const i of n){const s=await WS(i,`images/${i.name}`);r.push(`![${i.name.replace(/\\.[^.]+$/,"")}](${s})`)}await yp(),US(r.join(`\n\n`))',
     'for(const i of n){const target=imageUploadTarget(i.name,TE(zo()));const s=await WS(i,target.path);if(target.insert)r.push(`![${i.name.replace(/\\.[^.]+$/,"")}](${s})`)}await yp(),Vo(),r.length&&US(r.join(`\n\n`))'),
]
for before, after in changes:
    count = source.count(before)
    if count != 1:
        raise RuntimeError(f'Expected exactly one frontend match, found {count}: {before[:100]}')
    source = source.replace(before, after, 1)
source = 'import { canonicalAssetPath, imageUploadTarget, missingImagePaths } from "./asset-paths-20261014.mjs";\n' + source
(assets / 'index-20261014-imagefix.js').write_text(source, encoding='utf-8', newline='')
page = (root / 'frontend' / 'index.template.html').read_text('utf-8')
if page.count('index-CIPbZpsp.js') != 1:
    raise RuntimeError('Unexpected editor entry point')
(root / 'app' / 'web' / 'editor' / 'index.html').write_text(
    page.replace('index-CIPbZpsp.js', 'index-20261014-imagefix.js'), encoding='utf-8', newline='\r\n'
)
shutil.copyfile(root / 'frontend' / 'asset-paths.mjs', assets / 'asset-paths-20261014.mjs')
for extension in ('mjs', 'css'):
    shutil.copyfile(root / 'frontend' / f'company-network.{extension}', assets / f'company-network-20261016.{extension}')
print('Frontend patch built with six unique replacements')
