import {DEVICE_PRESETS,typographyControlsMarkup,connectTypographyControls,previewViewport} from '/editor/assets/typography-controls-20261017-proof.mjs';
import {prepareTypography} from '/editor/assets/typography-20261017-proof.mjs';
const report=document.querySelector('#device-report'),results=[];
const check=(condition,label)=>{if(!condition)throw new Error(label);results.push('PASS '+label);};
const tick=async()=>{for(let i=0;i<3;i++)await new Promise(requestAnimationFrame);};
try {
  const fixture=document.querySelector('#device-fixture');
  fixture.className='preview-check';
  fixture.innerHTML=typographyControlsMarkup()+'<div class="phone-stage"><article id="previewArticle" class="wechat-preview"></article></div>';
  const article=fixture.querySelector('#previewArticle'),stage=fixture.querySelector('.phone-stage');
  let dirty=0;const controls=connectTypographyControls(fixture,()=>dirty++);
  controls.load({theme:'technical'});
  const prepared=prepareTypography('<h1>AMD Lab</h1><blockquote><p>引用说明</p></blockquote><pre><code>'+('line\n'.repeat(80))+'</code></pre><table><tr><th>参数</th><th>说明</th></tr><tr><td>配置</td><td>完整内容</td></tr></table><p id="last-paragraph">ARTICLE-END</p>',{theme:'technical',font_size:17,code_wrap:'wrap',table_mode:'auto'});
  const style=document.createElement('style');style.textContent=prepared.css;document.head.append(style);
  article.innerHTML='<div id="output">'+prepared.html+'</div>';
  const select=(id,value)=>{const field=fixture.querySelector('#'+id);field.value=value;field.dispatchEvent(new Event('change',{bubbles:true}));};
  for(const device of DEVICE_PRESETS) {
    select('previewWidthSelect',device.id);
    for(const orientation of ['portrait','landscape']) {
      select('previewOrientationSelect',orientation);await tick();
      const expected=previewViewport(device.id,orientation);
      check(article.offsetWidth===expected.width,device.id+' '+orientation+' uses its native reference width');
      check(article.getBoundingClientRect().width<=stage.clientWidth-44+1,device.id+' '+orientation+' fits its preview panel');
      check(stage.scrollWidth<=stage.clientWidth+1,device.id+' '+orientation+' does not leave an unscaled horizontal overflow');
      check(getComputedStyle(article.querySelector('p')).fontSize==='17px',device.id+' '+orientation+' keeps the authored body font');
      stage.scrollTop=stage.scrollHeight;await tick();
      const last=article.querySelector('#last-paragraph');
      check(last.getBoundingClientRect().bottom<=stage.getBoundingClientRect().bottom-24+1,device.id+' '+orientation+' keeps the article end reachable');
    }
  }
  select('previewWidthSelect','ipad-air11');select('previewOrientationSelect','portrait');
  select('previewZoomSelect','actual');await tick();
  check(article.getBoundingClientRect().width===820&&stage.scrollWidth>stage.clientWidth,'100% mode deliberately allows horizontal scrolling for a full-size iPad');
  select('previewZoomSelect','fit');await tick();
  const oldHeight=fixture.querySelector('.device-preview-frame').offsetHeight;
  article.querySelector('#output').insertAdjacentHTML('beforeend','<p id="added-end">'+('新增内容 '.repeat(800))+'NEW-END</p>');await tick();
  check(fixture.querySelector('.device-preview-frame').offsetHeight>oldHeight,'rendering more content updates the scaled scroll height');
  stage.style.width='360px';await tick();
  check(article.getBoundingClientRect().width<=316+1&&stage.scrollWidth<=stage.clientWidth+1,'resizing the editor automatically refits the current device');
  check(dirty===0,'device, orientation, zoom and resize never dirty the publishing settings');
  report.dataset.status='passed';report.textContent=results.join('\n');
} catch(error) {report.dataset.status='failed';report.textContent=results.join('\n')+'\nFAIL '+error.message;}
