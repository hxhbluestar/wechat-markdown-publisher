import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {DEVICE_PRESETS,previewViewport,previewScale,typographyControlsMarkup,connectTypographyControls} from '../frontend/typography-controls.mjs';

test('device previews cover at least five phones, two foldable models in both states, and two iPads',()=>{
  const phones=new Set(DEVICE_PRESETS.filter(p=>p.kind!=='tablet').map(p=>p.model));
  const tablets=new Set(DEVICE_PRESETS.filter(p=>p.kind==='tablet').map(p=>p.model));
  const foldables=new Set(DEVICE_PRESETS.filter(p=>p.kind==='foldable').map(p=>p.model));
  assert.ok(phones.size>=5);assert.ok(tablets.size>=2);assert.ok(foldables.size>=2);
  for(const model of foldables)assert.deepEqual(DEVICE_PRESETS.filter(p=>p.model===model).map(p=>p.state).sort(),['inner','outer']);
  assert.equal(new Set(DEVICE_PRESETS.map(p=>p.id)).size,DEVICE_PRESETS.length);
});

test('reference portrait widths, rotation, and custom width have bounded predictable values',()=>{
  assert.equal(previewViewport('iphone16').width,393);
  assert.equal(previewViewport('ipad-air11').width,820);
  assert.equal(previewViewport('ipad-air11','landscape').width,1180);
  assert.equal(previewViewport('fold5-outer').width,344);
  assert.equal(previewViewport('fold5-inner').width,690);
  assert.equal(previewViewport('custom','portrait',1000).width,1000);
  for(const value of ['',NaN,Infinity,-1,2000,'440px',false])assert.equal(previewViewport('custom','portrait',value).width,375);
  assert.equal(previewViewport('unknown').width,393);
  assert.equal(previewViewport('320').width,320);
  assert.equal(previewViewport('430').width,430);
});

test('fitting a large screen preserves its layout width and never enlarges smaller previews',()=>{
  assert.equal(previewScale(820,410,'fit'),0.5);
  assert.equal(previewScale(393,500,'fit'),1);
  assert.equal(previewScale(1180,410,'actual'),1);
  assert.equal(previewScale(393,0,'fit'),1);
});

test('device selection, rotation, zoom and custom widths never change saved article typography',()=>{
  const {document,Event}=parseHTML(`<main>${typographyControlsMarkup()}<div class="phone-stage"><article id="previewArticle"><p>Body</p></article></div></main>`);
  const stage=document.querySelector('.phone-stage');
  Object.defineProperty(stage,'clientWidth',{value:410});
  const changes=[];const controls=connectTypographyControls(document,value=>changes.push(value));
  controls.load({theme:'journal',font_size:18,caption_font_size:12,table_font_size:12});
  const original=controls.read('journal');
  const select=(id,value)=>{
    const node=document.querySelector('#'+id);
    for(const option of node.options)option.selected=false;
    [...node.options].find(o=>o.value===value).selected=true;
    node.dispatchEvent(new Event('change'));
  };
  select('previewWidthSelect','ipad-air11');
  const article=document.querySelector('#previewArticle');
  assert.equal(article.style.width,'820px');assert.equal(article.style.transform,'scale(0.5)');
  assert.equal(document.querySelector('.device-preview-frame').style.width,'410px');
  select('previewOrientationSelect','landscape');assert.equal(article.style.width,'1180px');
  select('previewZoomSelect','actual');assert.equal(article.style.transform,'scale(1)');
  select('previewWidthSelect','custom');
  const custom=document.querySelector('#previewCustomWidth');custom.value='900';custom.dispatchEvent(new Event('input'));
  assert.equal(article.style.width,'900px');assert.equal(document.querySelector('#previewCustomWidthLabel').hidden,false);
  select('previewWidthSelect','iphone16');assert.equal(document.querySelector('#previewCustomWidthLabel').hidden,true);
  assert.equal(changes.length,0);assert.deepEqual(controls.read('journal'),original);
  assert.match(document.querySelector('#previewDeviceStatus').textContent,/iPhone 16/);
  assert.match(document.querySelector('#previewDeviceStatus').textContent,/100%/);
});
