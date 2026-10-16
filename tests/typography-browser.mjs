const report=document.getElementById('typography-report');
const results=[];
function check(condition,label) {
  if (!condition) throw new Error(label);
  results.push('PASS '+label);
}
try {
  const entry=await fetch('/editor/',{cache:'no-store'}).then(response=>response.text());
  const sourceDocument=new DOMParser().parseFromString(entry,'text/html');
  const script=sourceDocument.querySelector('script[type="module"][crossorigin]');
  const renderer=await import(script.getAttribute('src'));
  check(typeof renderer.previewWechatArticle==='function' && typeof renderer.exportWechatArticle==='function','real editor exposes its shared preview/export renderer');
  const python='if True:\n\tprint("<tag>&value")\n\n# 结尾';
  const markdown=['# 技术文章样张','','正文中的 `batch_size` 参数。','','> 引用中的中文说明。','','```python',python,'```','','```powershell','$env:PATH | Select-Object -First 1','```','','```diff','- old','+ new','```','','| 配置 | 说明 |','| --- | --- |','| A | **重点**与[链接](https://example.com/docs) |','| B | 第二行 |'].join('\n');
  for (const theme of ['technical','journal','minimal']) {
    const options={font_family:'theme',font_size:17,code_wrap:'wrap',table_mode:'cards'};
    const preview=renderer.previewWechatArticle(markdown,theme,'blue',options);
    const previewDocument=new DOMParser().parseFromString(preview.html,'text/html');
    check(!!previewDocument.querySelector('.wx-typography'),'new '+theme+' preview uses the typography layer');
    const exported=renderer.exportWechatArticle(markdown,theme,'blue',options);
    const doc=new DOMParser().parseFromString(exported,'text/html');
    check(!doc.querySelector('[class],style,script,button,iframe'),'export '+theme+' contains only publishing markup and inline styles');
    check(doc.querySelector('pre code')?.textContent===python,'export '+theme+' preserves tabs/newlines/angle brackets/ampersands');
    check(!!doc.querySelector('pre code span[style*="color"]'),'export '+theme+' keeps syntax colors after class removal');
    check(!doc.querySelector('table') && doc.body.textContent.includes('第二行'),'export '+theme+' cards keep every table row');
    check(!!doc.querySelector('strong') && !!doc.querySelector('a[href="https://example.com/docs"]'),'export '+theme+' preserves table emphasis and links');
    check(!exported.includes('var(--'),'export '+theme+' resolves CSS variables');
    check(!exported.includes('data-source-code='),'export '+theme+' removes temporary source metadata');
    const codeStyle=doc.querySelector('pre').getAttribute('style')||'';
    check(codeStyle.includes('pre-wrap'),'export '+theme+' applies reading wrap in the actual inliner');
    const host=document.createElement('div');
    host.style.width='272px';
    host.innerHTML=renderer.exportWechatArticle('| WWWWWWWWWWWWWWW | WWWWWWWWWWWWWWW |\n| --- | --- |\n| WWWWWWWWWWWWWWW | WWWWWWWWWWWWWWW |',theme,'warm',{...options,table_mode:'auto'});
    document.body.appendChild(host);
    check(host.scrollWidth<=host.clientWidth,'export '+theme+' short wide-letter table stays inside a 320px phone article');
    host.remove();
  }
  const settings={font_family:'theme',font_size:16,code_wrap:'scroll',table_mode:'auto'};
  check(!renderer.previewWechatArticle(markdown,'grace','warm',settings).html.includes('wx-typography'),'legacy style remains outside the new typography layer');
  const legacyHost=document.createElement('div');
  legacyHost.style.width='272px';
  legacyHost.innerHTML=renderer.exportWechatArticle('```plaintext\n'+('WW'.repeat(150))+'\n```','grace','warm',{...settings,code_wrap:'wrap'});
  document.body.appendChild(legacyHost);
  check(legacyHost.querySelector('pre').scrollWidth<=legacyHost.querySelector('pre').clientWidth,'legacy explicit reading wrap contains a very long code word');
  legacyHost.remove();
  const themeControl=document.querySelector('#themeSelect');
  await import('/editor/assets/mermaid.core-CgMKsg4i.js');
  check(document.querySelector('#themeSelect')===themeControl && themeControl.options.length===6,'lazy diagram components reuse the active editor without bootstrapping the old bundle');
  report.dataset.status='passed';
  report.textContent=results.join('\n');
} catch (error) {
  report.dataset.status='failed';
  report.textContent=results.join('\n')+'\nFAIL '+error.message;
}
