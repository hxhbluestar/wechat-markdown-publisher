// Exercise the actual editor on its disposable synthetic-draft QA server.
const frame=document.querySelector('#editor'),report=document.querySelector('#report');
const result={checks:0,failures:[],themes:[]};
const check=(ok,label)=>{result.checks++;if(!ok)result.failures.push(label);};
async function until(fn){const end=Date.now()+15000;while(!fn()){if(Date.now()>end)throw new Error('Editor render timed out');await new Promise(r=>setTimeout(r,30));}}
try {
  const loaded=new Promise(r=>frame.onload=r);frame.src='/editor/?paper-qa';await loaded;
  const doc=frame.contentDocument,win=frame.contentWindow;
  await until(()=>doc.querySelector('.draft-open'));
  [...doc.querySelectorAll('.draft-open')].find(b=>b.textContent.includes('编辑布局验收')).click();
  await until(()=>doc.querySelector('#output .wx-typography'));
  const article=doc.querySelector('#previewArticle'),select=doc.querySelector('#themeSelect');
  const paper={technical:'rgb(255, 255, 255)',journal:'rgb(255, 253, 248)',minimal:'rgb(255, 255, 255)',obsidian:'rgb(17, 27, 34)',deepsea:'rgb(241, 248, 248)',teal:'rgb(255, 255, 255)',nord:'rgb(236, 239, 244)',dracula:'rgb(40, 42, 54)',latte:'rgb(239, 241, 245)'};
  const bg=el=>win.getComputedStyle(el).backgroundColor;
  for(const [theme,color] of Object.entries(paper)) {
    // Saved layouts remain supported even if absent from the new-article chooser.
    if(![...select.options].some(o=>o.value===theme))select.add(new win.Option(theme,theme));
    for(const palette of ['warm','blue']) {
      select.value=theme;select.dispatchEvent(new win.Event('change',{bubbles:true}));
      const paletteSelect=doc.querySelector('#paletteSelect');paletteSelect.value=palette;paletteSelect.dispatchEvent(new win.Event('change',{bubbles:true}));
      await until(()=>doc.querySelector('.wx-theme-'+theme)&&article.dataset.richReady==='true');
      const root=doc.querySelector('#output .wx-typography');
      check(bg(root)===color,theme+'/'+palette+': article retains designed paper');
      check(bg(article)===color,theme+'/'+palette+': padding and article share one paper');
      check(bg(root.querySelector('p'))==='rgba(0, 0, 0, 0)',theme+'/'+palette+': body text has no separate background');
    }
    result.themes.push(theme);
  }
  doc.querySelector('[data-preview="reader"]').click();
  await until(()=>article.classList.contains('reader-preview'));
  check(article.style.background==='', 'reader preview clears the previous theme paper');
  doc.querySelector('[data-preview="wechat"]').click();
  await until(()=>article.classList.contains('wechat-preview'));
  check(bg(article)===paper.latte,'returning to WeChat restores its paper');
  if(![...select.options].some(o=>o.value==='default'))select.add(new win.Option('Legacy','default'));
  select.value='default';select.dispatchEvent(new win.Event('change',{bubbles:true}));
  await until(()=>doc.querySelector('.wx-theme-legacy'));
  check(article.style.background==='', 'legacy layouts clear the previous paper override');
}catch(error){result.failures.push(error.stack||String(error));}
document.body.dataset.results=JSON.stringify(result);
report.textContent=(result.failures.length?'FAIL':'PASS')+' · '+result.checks+' checks\n'+result.failures.join('\n');
