const report=document.querySelector('#scroll-test-report'),summary=document.querySelector('#scroll-test-summary'),checks=[];
const check=(ok,message)=>{if(!ok)throw new Error(message);checks.push('PASS '+message);report.textContent=checks.join('\n');};
const frame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
const settle=async()=>{for(let i=0;i<6;i++)await frame();};
const wait=async(predicate)=>{const start=performance.now();while(!predicate()){if(performance.now()-start>10000)throw new Error('Timed out waiting for editor');await frame();}};
const scroll=async(element,top)=>{element.scrollTop=top;element.dispatchEvent(new Event('scroll'));await settle();};
const choose=async(id,value)=>{const select=document.getElementById(id);select.value=value;select.dispatchEvent(new Event('change',{bubbles:true}));await settle();};
try{
  const renderer=await import('/editor/assets/index-20261017-scroll.js');
  await wait(()=>document.querySelector('[data-draft-id]'));
  const row=[...document.querySelectorAll('[data-draft-id]')].find(el=>el.textContent.includes('双向滚动测试稿'));row.click();
  await wait(()=>document.querySelectorAll('[data-scroll-source-from]').length>20);await settle();
  const source=document.querySelector('.cm-scroller'),stage=document.querySelector('.phone-stage'),preview=document.querySelector('#previewArticle'),toggle=document.querySelector('#syncScrollToggle');
  const original=await fetch('/api/editor/drafts/'+row.dataset.draftId).then(r=>r.json());
  const cursorBefore=document.querySelector('.cm-activeLine')?.textContent;
  check(toggle.getAttribute('aria-pressed')==='true','双向滚动默认开启');
  check(source.scrollHeight>source.clientHeight&&stage.scrollHeight>stage.clientHeight,'长稿两侧均可滚动');
  async function alignSource(){
    await scroll(source,(source.scrollHeight-source.clientHeight)*0.32);
    const box=source.getBoundingClientRect();
    const line=[...source.querySelectorAll('.cm-line')].find(el=>/^(## 区段|实验段落)/.test(el.textContent)&&el.getBoundingClientRect().top>=box.top&&el.getBoundingClientRect().top<box.bottom);
    check(!!line,'源编辑器虚拟视口中有可定位正文块');
    const text=line.textContent.replace(/^#+\s*/,'').slice(0,22);
    await scroll(source,source.scrollTop+line.getBoundingClientRect().top-source.getBoundingClientRect().top);
    const target=[...preview.querySelectorAll('[data-scroll-source-from]')].find(el=>el.textContent.startsWith(text));
    check(!!target&&Math.abs(target.getBoundingClientRect().top-stage.getBoundingClientRect().top)<45,'左侧滚动对齐右侧相同正文块');
  }
  async function alignPreview(){
    const heading=[...preview.querySelectorAll('h2')].find(el=>el.textContent==='区段 8 · AMD GPU 实验');
    await scroll(stage,stage.scrollTop+heading.getBoundingClientRect().top-stage.getBoundingClientRect().top);
    const line=[...source.querySelectorAll('.cm-line')].find(el=>el.textContent==='## 区段 8 · AMD GPU 实验');
    check(!!line&&Math.abs(line.getBoundingClientRect().top-source.getBoundingClientRect().top)<45,'右侧滚动对齐左侧相同标题');
    const snapshot=[source.scrollTop,stage.scrollTop];await settle();check(Math.abs(source.scrollTop-snapshot[0])<2&&Math.abs(stage.scrollTop-snapshot[1])<2,'双向滚动稳定停止，没有反馈抖动');
  }
  for(const [device,zoom] of [['iphone16','fit'],['fold5-inner','fit'],['ipad-air11','fit'],['ipad-air11','actual']]){
    await choose('previewWidthSelect',device);await choose('previewZoomSelect',zoom);await alignSource();await alignPreview();
    check(true,device+'/'+zoom+' 支持设备缩放后的双向定位');
  }
  await scroll(source,source.scrollHeight);check(Math.abs(stage.scrollTop-(stage.scrollHeight-stage.clientHeight))<2,'左侧到底时右侧完整到末尾');
  await scroll(stage,0);check(source.scrollTop<2,'右侧回顶时左侧回顶');
  toggle.click();const before=stage.scrollTop;await scroll(source,500);check(stage.scrollTop===before,'关闭后左侧可独立滚动');
  const leftBefore=source.scrollTop;await scroll(stage,600);check(source.scrollTop===leftBefore,'关闭后右侧可独立滚动');
  toggle.click();await settle();check(toggle.getAttribute('aria-pressed')==='true','重新开启同步');
  const code=preview.querySelector('pre'),position=source.scrollTop;code.dispatchEvent(new Event('scroll',{bubbles:true}));await settle();check(source.scrollTop===position,'代码内部横向滚动不移动正文');
  document.querySelector('[data-preview="reader"]').click();await wait(()=>preview.classList.contains('reader-preview'));await settle();await alignPreview();
  document.querySelector('[data-preview="wechat"]').click();await settle();await alignPreview();
  check(document.querySelector('.cm-activeLine')?.textContent===cursorBefore,'同步不改变光标所在行');
  check(!document.querySelector('#saveState').textContent.includes('未保存'),'滚动与开关不会把稿件标为已修改');
  const html=renderer.exportWechatArticle(original.content,'technical');check(!html.includes('data-scroll-source')&&!html.includes('syncScrollToggle'),'同步标记与控件不进入公众号导出');
  const other=[...document.querySelectorAll('[data-draft-id]')].find(el=>el.textContent.includes('切换滚动测试稿'));other.click();
  await wait(()=>preview.textContent.includes('新的稿件从头开始'));await settle();check(stage.scrollTop<2&&document.querySelector('.cm-scroller').scrollTop<2,'切换稿件后两侧从顶部开始');
  const after=await fetch('/api/editor/drafts/'+row.dataset.draftId).then(r=>r.json());check(after.revision===original.revision&&after.content===original.content,'滚动未改写保存的正文与 revision');
  document.querySelector('[data-draft-id="'+row.dataset.draftId+'"]').click();await wait(()=>preview.textContent.includes('区段 8'));await settle();await choose('previewWidthSelect','iphone16');await choose('previewZoomSelect','fit');await alignPreview();
  summary.textContent=checks.length+' 项双向滚动检查通过';report.textContent=checks.join('\n')+'\n'+summary.textContent;
}catch(error){summary.textContent='FAIL '+error.message;report.textContent=checks.join('\n')+'\nFAIL '+error.stack;throw error;}
