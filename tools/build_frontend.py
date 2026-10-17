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
changes += [
    ('function eM(t,e,n="warm"){return{html:BS(t),css:MS(e,n)}}',
     'function eM(t,e,n="warm",o={}){const r=prepareTypography(BS(t),{...o,theme:e,palette:n});return{html:r.html,css:MS(["grace","default","simple"].includes(e)?e:"default",n)+"\\n"+r.css}}'),
    ('function tM(t,e,n="warm"){const i=`<section id="output">${BS(t)}</section>`;return J8.inlineContent(i,MS(e,n),',
     'function tM(t,e,n="warm",o={}){const r=eM(t,e,n,o),i=`<section id="output">${r.html}</section>`;return J8.inlineContent(i,r.css,'),
    ('.replace(/\\sid="output"/g,"")',
     '.replace(/\\sid="output"/g,"").replace(/\\sdata-(?:source-code|raw-code|language-pending|show-line-number)="[^"]*"/g,"")'),
    ('if(b.startsWith("diff-"))return ZD(O,b.slice(5));',
     'if(b.startsWith("diff-"))return ZD(O,b.slice(5)).replace("<code ",`<code data-source-code="${encodeURIComponent(O)}" `);'),
    ('const L=`<code class="language-${E}"${I}>${R}</code>`;',
     'const L=`<code data-source-code="${encodeURIComponent(O)}" class="language-${E}"${I}>${R}</code>`;'),
    ('previewMode:"wechat",theme:"grace",palette:', 'previewMode:"wechat",theme:"technical",palette:'),
    ('<select id="themeSelect"><option value="grace">',
     '<select id="themeSelect"><option value="technical">技术手册</option><option value="journal">纸感期刊</option><option value="minimal">极简墨色</option><option value="obsidian">曜石青</option><option value="deepsea">深海青</option><option value="teal">青绿实验室</option><option value="grace">'),
    ('<option value="warm">暖橙</option>', '<option value="warm">默认配色</option>'),
    ('          <div class="phone-stage">', '${typographyControlsMarkup()}\n          <div class="phone-stage">'),
    ('function kc(){return{',
     'const typographyControls=connectTypographyControls(document,()=>{ds(!0);Vo()});function kc(){return{...typographyControls.read(H.theme),'),
    ('function $S(t){', 'function $S(t){typographyControls.load(t);'),
    ('e=eM(t,H.theme,H.palette);', 'e=eM(t,H.theme,H.palette,typographyControls.read(H.theme));'),
    ('n=tM(e,H.theme,H.palette),', 'n=tM(e,H.theme,H.palette,typographyControls.read(H.theme)),'),
    ('source_hash:r,theme:H.theme,palette:H.palette,account_id:',
     'source_hash:r,theme:H.theme,palette:H.palette,typography:typographyControls.read(H.theme),account_id:'),
    ('H.theme=t.currentTarget.value,Vo(),ds(!0)',
     'H.theme=t.currentTarget.value,typographyControls.themeChanged(H.theme),Vo(),ds(!0)'),
    ('H.current.metadata.cover=await WS(n,`cover${r}`),$S(H.current.metadata)',
     'H.current.metadata.cover=await WS(n,`cover${r}`),H.current.metadata={...H.current.metadata,...kc()},$S(H.current.metadata)'),
]
for before, after in changes:
    count = source.count(before)
    if count != 1:
        raise RuntimeError(f'Expected exactly one frontend match, found {count}: {before[:100]}')
    source = source.replace(before, after, 1)
source = 'import { canonicalAssetPath, imageUploadTarget, missingImagePaths } from "./asset-paths-20261014.mjs";\n' + source
source = ('import { prepareTypography } from "./typography-20261017-lab.mjs";\n'
          'import { connectTypographyControls, typographyControlsMarkup } from "./typography-controls-20261017-lab.mjs";\n' + source)
source += '\nexport { eM as previewWechatArticle, tM as exportWechatArticle };\n'
(assets / 'index-20261017-lab.js').write_text(source, encoding='utf-8', newline='')
page = (root / 'frontend' / 'index.template.html').read_text('utf-8')
entry = 'src="/editor/assets/index-CIPbZpsp.js"'
if page.count(entry) != 1:
    raise RuntimeError('Unexpected editor entry point')
(root / 'app' / 'web' / 'editor' / 'index.html').write_text(
    page.replace(entry, 'src="/editor/assets/index-20261017-lab.js"'), encoding='utf-8', newline=''
)
shutil.copyfile(root / 'frontend' / 'asset-paths.mjs', assets / 'asset-paths-20261014.mjs')
for extension in ('mjs', 'css'):
    shutil.copyfile(root / 'frontend' / f'company-network.{extension}', assets / f'company-network-20261016.{extension}')
shutil.copyfile(root / 'frontend/typography.mjs', assets / 'typography-20261017-lab.mjs')
shutil.copyfile(root / 'frontend/typography-controls.css', assets / 'typography-controls-20261017-lab.css')
controls = (root / 'frontend/typography-controls.mjs').read_text('utf-8')
if controls.count("'./typography.mjs'") != 1:
    raise RuntimeError('Unexpected typography controls import')
(assets / 'typography-controls-20261017-lab.mjs').write_text(
    controls.replace("'./typography.mjs'", "'./typography-20261017-lab.mjs'"), encoding='utf-8', newline='')
print(f'Frontend patch built with {len(changes)} unique replacements')
