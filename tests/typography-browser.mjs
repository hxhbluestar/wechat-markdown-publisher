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
  const image='data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
  const markdown=['# 技术文章样张','','正文中的 `batch_size` 参数。','','> 引用中的中文说明。','','```python',python,'```','','```powershell','$env:PATH | Select-Object -First 1','```','','```diff','- old','+ new','```','','![实验室拓扑]('+image+' "图1 AMD实验室拓扑")','','| 配置 | 说明 |','| --- | --- |','| A | **重点**与[链接](https://example.com/docs) |','| B | 第二行 |'].join('\n');
  for (const theme of ['technical','journal','minimal','obsidian','deepsea','teal']) {
    const options={font_family:'theme',font_size:17,code_wrap:'wrap',table_mode:'cards',caption_font_size:12,table_font_size:12};
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
    const caption=doc.querySelector('figcaption');
    check(caption?.textContent==='图1 AMD实验室拓扑' && /font-size:\s*12px/.test(caption.getAttribute('style')),'export '+theme+' keeps an explicit 12px image caption');
    const host=document.createElement('div');
    host.style.width='272px';
    host.innerHTML=renderer.exportWechatArticle('| WWWWWWWWWWWWWWW | WWWWWWWWWWWWWWW |\n| --- | --- |\n| WWWWWWWWWWWWWWW | WWWWWWWWWWWWWWW |',theme,'warm',{...options,table_mode:'auto'});
    document.body.appendChild(host);
    check(host.scrollWidth<=host.clientWidth,'export '+theme+' short wide-letter table stays inside a 320px phone article');
    host.remove();
    const wide='| GPU | 链接 | 配置 | 场景 | 最后一列 |\n| --- | --- | --- | --- | --- |\n| AMD | [完整链接](https://example.com/'+('long-path-'.repeat(12))+') | `'+('batch_'.repeat(20))+'` | '+('中英文实验室说明'.repeat(8))+' | LAST-CELL-Ω |\n| B | 第二行 | 全部保留 | 最后一行 | FINAL-ROW-END |';
    for (const width of [272,327,382]) {
      const wideHost=document.createElement('div');
      wideHost.style.width=width+'px';
      wideHost.innerHTML=renderer.exportWechatArticle(wide,theme,'warm',{...options,table_mode:'scroll'});
      document.body.appendChild(wideHost);
      const area=wideHost.querySelector('.wx-table-scroll')||[...wideHost.querySelectorAll('section')].find(section=>section.querySelector('table') && getComputedStyle(section).overflowX==='auto');
      check(!!area,'export '+theme+' wide table has a real scroll region at '+width);
      area.scrollLeft=area.scrollWidth;
      await new Promise(requestAnimationFrame);
      const last=area.querySelector('tr:last-child td:last-child');
      check(last?.textContent==='FINAL-ROW-END' && last.getBoundingClientRect().right<=area.getBoundingClientRect().right+1,'export '+theme+' reaches the complete last column at '+width);
      check(wideHost.scrollWidth<=wideHost.clientWidth,'export '+theme+' table stays inside the article at '+width);
      check([...wideHost.querySelectorAll('th,td,td code,td a,td p,td span')].every(node=>parseFloat(getComputedStyle(node).fontSize)>=12),'export '+theme+' table content never falls below 12px at '+width);
      wideHost.remove();
    }
  }
  const edgeCases=[
    '<section>表前必须保留<table><thead><tr><th>Key</th></tr></thead><tbody><tr><td>value</td></tr></tbody></table>表后必须保留</section>',
    '<table><colgroup><col width="800"><col width="800"></colgroup><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>LEFT</td><td>RIGHT-END</td></tr></tbody></table>',
    '<div style="height:32px;max-height:32px;overflow:hidden"><section style="height:32px;overflow:hidden"><table><thead><tr><th>Key</th><th>Value</th></tr></thead><tbody><tr><td>one</td><td>first</td></tr><tr><td>two</td><td>second</td></tr><tr><td>three</td><td>VISIBLE-LAST-ROW</td></tr></tbody></table></section></div>',
    '<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td><img width="1600" height="900" src="'+image+'" alt="diagram"></td><td>IMAGE-ROW-END</td></tr></tbody></table>'
  ];
  for (const [index,raw] of edgeCases.entries()) {
    const host=document.createElement('div');
    host.style.width='272px';
    host.innerHTML=renderer.exportWechatArticle(raw,'obsidian','blue',{font_family:'theme',font_size:17,code_wrap:'wrap',table_mode:'auto',caption_font_size:12,table_font_size:16});
    document.body.appendChild(host);
    check(host.scrollWidth<=host.clientWidth,'table edge fixture '+index+' stays inside a narrow article');
    const area=[...host.querySelectorAll('section,div')].find(node=>node.querySelector('table') && getComputedStyle(node).overflowX==='auto');
    if (area) area.scrollLeft=area.scrollWidth;
    await new Promise(requestAnimationFrame);
    if (index===0) check(host.textContent.includes('表前必须保留') && host.textContent.includes('表后必须保留'),'raw table keeps surrounding article text');
    if (index===1) check(!!area && host.querySelector('tr:last-child td:last-child').getBoundingClientRect().right<=area.getBoundingClientRect().right+1,'explicit col widths remain reachable in the scroll area');
    if (index===2) {
      const last=host.querySelector('tr:last-child td:last-child');
      let clipped=false;
      for (let parent=last.parentElement;parent && parent!==host;parent=parent.parentElement) {
        if (['hidden','clip'].includes(getComputedStyle(parent).overflowY) && parent.getBoundingClientRect().bottom+1<last.getBoundingClientRect().bottom) clipped=true;
      }
      check(last.textContent==='VISIBLE-LAST-ROW' && !clipped,'sole-table wrapper height cannot crop the final row');
    }
    host.remove();
  }
  const settings={font_family:'theme',font_size:16,code_wrap:'scroll',table_mode:'auto'};
  const authoredCaption=renderer.exportWechatArticle('![微信图片_12345678901234_01]('+image+')\n\n*图 1：实验室架构。*\n\n普通正文必须保留。','journal','warm',{...settings,caption_font_size:12,table_font_size:12});
  const authoredDoc=new DOMParser().parseFromString(authoredCaption,'text/html');
  check(authoredDoc.querySelector('figcaption')?.textContent==='图 1：实验室架构。','a handwritten italic image description becomes the controllable caption');
  check(/font-size:\s*12px/.test(authoredDoc.querySelector('figcaption').getAttribute('style')) && authoredDoc.body.textContent.includes('普通正文必须保留。') && !authoredDoc.body.textContent.includes('微信图片_'),'handwritten 12px captions preserve following body text and omit machine filename labels');
  check(!renderer.previewWechatArticle(markdown,'grace','warm',settings).html.includes('wx-typography'),'legacy style remains outside the new typography layer');
  const legacyHost=document.createElement('div');
  legacyHost.style.width='272px';
  legacyHost.innerHTML=renderer.exportWechatArticle('```plaintext\n'+('WW'.repeat(150))+'\n```','grace','warm',{...settings,code_wrap:'wrap'});
  document.body.appendChild(legacyHost);
  check(legacyHost.querySelector('pre').scrollWidth<=legacyHost.querySelector('pre').clientWidth,'legacy explicit reading wrap contains a very long code word');
  legacyHost.remove();
  const themeControl=document.querySelector('#themeSelect');
  await import('/editor/assets/mermaid.core-CgMKsg4i.js');
  check(document.querySelector('#themeSelect')===themeControl && themeControl.options.length===9,'lazy diagram components reuse the active editor without bootstrapping the old bundle');
  report.dataset.status='passed';
  report.textContent=results.join('\n');
} catch (error) {
  report.dataset.status='failed';
  report.textContent=results.join('\n')+'\nFAIL '+error.message;
}
