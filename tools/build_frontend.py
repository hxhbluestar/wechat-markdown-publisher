"""Rebuild the preserved editor patch from the original shipped bundle."""

from pathlib import Path
import shutil


root = Path(__file__).resolve().parents[1]
assets = root / "app" / "web" / "editor" / "assets"
source = (assets / 'index-CIPbZpsp.js').read_text('utf-8')
changes = [
    ('async function wp(){if(!H.current)return null;try{const t=await sn(`/api/editor/drafts/${encodeURIComponent(H.current.id)}`,{method:"PUT",body:JSON.stringify({content:zo(),metadata:kc(),revision:H.current.revision})});return H.current=t,le.title.textContent=t.metadata.title||"未命名文章",ds(!1),await ia(),_o(),t}catch(t){return ct(t.message,!0),null}}',
     (root / 'frontend' / 'save-draft.js').read_text('utf-8')),
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
    ('          <button class="sync-button" id="syncDraft"', '${proofreadingMarkup()}\n          <button class="sync-button" id="syncDraft"'),
    ('extensions:[Tw(),nc.of(', 'extensions:[createProofreadingExtension({ViewPlugin:rs,Decoration:Bt},proofreading),Tw(),nc.of('),
    ('async function lM(){if(!H.accounts.length){vp();return}if(H.current){',
     'async function lM(){if(!H.accounts.length){vp();return}if(H.current){if(!proofreading.beforeSync())return;'),
    ('H.current=null,H.assets=[],H.dirty=!1,le.empty.hidden=!1', 'H.current=null,H.assets=[],H.dirty=!1,proofreading.check(""),le.empty.hidden=!1'),
    ('ee=E?` title="${E}"`:"";return`<figure><img src="${O}"${ee}${w}${k} alt="${R}"/>${L}</figure>`',
     'ee=E?` title="${escapeHtmlAttribute(E)}"`:"";return`<figure><img src="${escapeHtmlAttribute(O)}"${ee}${w}${k} alt="${escapeHtmlAttribute(R)}"/>${L}</figure>`'),
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
    ('<select id="themeSelect"><option value="grace">雅致</option><option value="default">简洁</option><option value="simple">留白</option></select>',
     '<select id="themeSelect">${themeOptionsMarkup()}</select>'),
    ('<option value="warm">暖橙</option>', '<option value="warm">默认配色</option>'),
    ('<option value="blue">科技蓝</option>', '<option value="blue">AMD 官网蓝</option>'),
    ('        <input id="markdownFile"', '${rocmImportMarkup()}\n        <input id="markdownFile"'),
    ('G("#importMarkdown").addEventListener("click",()=>G("#markdownFile").click());',
     'connectRocmImport(document,{request:sn,beforeImport:async()=>{if(H.dirty&&!await wp())throw new Error("当前修改保存失败，请先保存后再导入")},onImported:async draft=>{await ia();if(H.dirty&&!await wp())throw new Error("新稿已导入，当前修改保存失败；请保存后从稿件列表打开新稿");await YS(draft.id);ct("已导入 ROCm 博客，正文与配图已保存到本地")}});G("#importMarkdown").addEventListener("click",()=>G("#markdownFile").click());'),
    ('          <div class="phone-stage">', '${typographyControlsMarkup()}\n          <div class="phone-stage">'),
    ('function kc(){return{',
     'const proofreading=connectProofreading(document,{getText:zo,getDraftId:()=>H.current?.id||"",getDirty:()=>H.dirty,replaceText:(next,expected,id)=>{if(H.current?.id!==id||zo()!==expected)throw new Error("正文已变化，请重新检查");const view=H.editor;view.dispatch({changes:{from:0,to:view.state.doc.length,insert:next},selection:{anchor:Math.min(view.state.selection.main.head,next.length)}})},select:issue=>{xp("content");H.editor?.dispatch({selection:{anchor:issue.from,head:issue.to},scrollIntoView:true});H.editor?.focus()},save:wp,onMarksChanged:()=>H.editor?.dispatch({})});const typographyControls=connectTypographyControls(document,()=>{ds(!0);Vo()});function kc(){return{...typographyControls.read(H.theme),'),
    ('function $S(t){', 'function $S(t){typographyControls.load(t);'),
    ('e=eM(t,H.theme,H.palette);', 'e=eM(t,H.theme,H.palette,typographyControls.read(H.theme));'),
    ('function Vo(){if(!H.current)return;const', 'function Vo(){if(!H.current)return;G("#paletteSwatch").style.background=typographyAccent(H.theme,H.palette)||ql[H.palette].primary;const'),
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
source = ('import { prepareTypography, typographyAccent, escapeHtmlAttribute } from "./typography-20261017-proof.mjs";\n'
          'import { proofreadingMarkup, connectProofreading, createProofreadingExtension } from "./proofreading-20261017-proof.mjs";\n'
          'import { connectTypographyControls, typographyControlsMarkup, themeOptionsMarkup } from "./typography-controls-20261017-proof.mjs";\n'
          'import { connectRocmImport, rocmImportMarkup } from "./rocm-import-20261017.mjs";\n' + source)
source += '\nexport { eM as previewWechatArticle, tM as exportWechatArticle };\n'
(assets / 'index-20261017-proof.js').write_text(source, encoding='utf-8', newline='')
page = (root / 'frontend' / 'index.template.html').read_text('utf-8')
entry = 'src="/editor/assets/index-CIPbZpsp.js"'
if page.count(entry) != 1:
    raise RuntimeError('Unexpected editor entry point')
(root / 'app' / 'web' / 'editor' / 'index.html').write_text(
    page.replace(entry, 'src="/editor/assets/index-20261017-proof.js"'), encoding='utf-8', newline=''
)
shutil.copyfile(root / 'frontend' / 'asset-paths.mjs', assets / 'asset-paths-20261014.mjs')
for extension in ('mjs', 'css'):
    shutil.copyfile(root / 'frontend' / f'company-network.{extension}', assets / f'company-network-20261016.{extension}')
typography = (root / 'frontend/typography.mjs').read_text('utf-8')
if typography.count("'./article-spacing.mjs'") != 1:
    raise RuntimeError('Unexpected article spacing import')
(assets / 'typography-20261017-proof.mjs').write_text(typography.replace("'./article-spacing.mjs'", "'./article-spacing-20261017-proof.mjs'"), encoding='utf-8', newline='')
shutil.copyfile(root / 'frontend/article-spacing.mjs', assets / 'article-spacing-20261017-proof.mjs')
shutil.copyfile(root / 'frontend/proofreading.css', assets / 'proofreading-20261017-proof.css')
for module, dependency in [('proofreading','proofreading-core'), ('proofreading-core','proofreading-dictionary')]:
    content = (root / 'frontend' / f'{module}.mjs').read_text('utf-8')
    expected = f"'./{dependency}.mjs'"
    if content.count(expected) != 1:
        raise RuntimeError(f'Unexpected dependency in {module}')
    (assets / f'{module}-20261017-proof.mjs').write_text(content.replace(expected, f"'./{dependency}-20261017-proof.mjs'"), encoding='utf-8', newline='')
shutil.copyfile(root / 'frontend/proofreading-dictionary.mjs', assets / 'proofreading-dictionary-20261017-proof.mjs')
shutil.copyfile(root / 'frontend/typography-controls.css', assets / 'typography-controls-20261017-proof.css')
shutil.copyfile(root / 'frontend/rocm-import.mjs', assets / 'rocm-import-20261017.mjs')
controls = (root / 'frontend/typography-controls.mjs').read_text('utf-8')
if controls.count("'./typography.mjs'") != 1:
    raise RuntimeError('Unexpected typography controls import')
(assets / 'typography-controls-20261017-proof.mjs').write_text(
    controls.replace("'./typography.mjs'", "'./typography-20261017-proof.mjs'"), encoding='utf-8', newline='')
shutil.copyfile(root / 'frontend/code-languages.js', root / 'app/web/vendor/highlight-ai-20261017.js')
print(f'Frontend patch built with {len(changes)} unique replacements')
