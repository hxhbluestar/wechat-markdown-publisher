import {normalizeTypography} from './typography-20261017-scroll.mjs';

const MAIN_THEMES = {technical:'AMD 技术蓝',minimal:'极简墨色',journal:'纸感期刊',obsidian:'曜石青'};
const SAVED_THEMES = {deepsea:'深海青',teal:'青绿实验室',grace:'雅致',default:'简洁',simple:'留白'};

// Reference CSS viewports, not physical panel pixels or a WeChat device emulator.
// Sources and the pinned DevTools revision are documented in docs/typography.md.
export const DEVICE_PRESETS = Object.freeze([
  {id:'iphone16',model:'iPhone 16',label:'iPhone 16',kind:'phone',width:393,height:852},
  {id:'iphone16-pro',model:'iPhone 16 Pro',label:'iPhone 16 Pro',kind:'phone',width:402,height:874},
  {id:'iphone16-max',model:'iPhone 16 Pro Max',label:'iPhone 16 Pro Max',kind:'phone',width:440,height:956},
  {id:'pixel9',model:'Google Pixel 9',label:'Google Pixel 9',kind:'phone',width:412,height:924},
  {id:'fold5-outer',model:'Galaxy Z Fold5',label:'Galaxy Z Fold5 · 外屏',kind:'foldable',state:'outer',width:344,height:882},
  {id:'fold5-inner',model:'Galaxy Z Fold5',label:'Galaxy Z Fold5 · 展开内屏',kind:'foldable',state:'inner',width:690,height:829},
  {id:'pixel-fold-outer',model:'Pixel 9 Pro Fold',label:'Pixel 9 Pro Fold · 外屏',kind:'foldable',state:'outer',width:412,height:922},
  {id:'pixel-fold-inner',model:'Pixel 9 Pro Fold',label:'Pixel 9 Pro Fold · 展开内屏',kind:'foldable',state:'inner',width:836,height:842},
  {id:'ipad-mini',model:'iPad mini 8.3″',label:'iPad mini 8.3″',kind:'tablet',width:744,height:1133},
  {id:'ipad-air11',model:'iPad Air 11″',label:'iPad Air 11″',kind:'tablet',width:820,height:1180},
].map(Object.freeze));

export function previewViewport(id,orientation='portrait',customWidth=375) {
  const custom=typeof customWidth==='number'||typeof customWidth==='string'?Number(customWidth):NaN;
  const validCustom=Number.isInteger(custom)&&custom>=280&&custom<=1600?custom:375;
  let preset=DEVICE_PRESETS.find(item=>item.id===id);
  if (id==='custom') preset={id,model:'自定义',label:'自定义宽度',kind:'custom',width:validCustom,height:null};
  if (['320','375','430'].includes(id))preset={id,model:'通用',label:'通用宽度',kind:'custom',width:Number(id),height:null};
  preset=preset||DEVICE_PRESETS[0];
  const landscape=orientation==='landscape'&&preset.height!==null;
  return {...preset,width:landscape?preset.height:preset.width,height:landscape?preset.width:preset.height,orientation:landscape?'landscape':'portrait'};
}

export function previewScale(width,available,mode='fit') {
  return mode==='actual'||!Number.isFinite(available)||available<=0?1:Math.min(1,available/width);
}

function deviceOptionsMarkup() {
  const groups=[['phone','普通手机'],['foldable','折叠屏'],['tablet','iPad']];
  return groups.map(([kind,label])=>`<optgroup label="${label}">${DEVICE_PRESETS.filter(p=>p.kind===kind).map(p=>`<option value="${p.id}"${p.id==='iphone16'?' selected':''}>${p.label} · ${p.width}px</option>`).join('')}</optgroup>`).join('')+
    '<optgroup label="通用与自定义"><option value="320">通用窄屏 · 320px</option><option value="375">通用手机 · 375px</option><option value="430">通用大屏 · 430px</option><option value="custom">自定义宽度…</option></optgroup>';
}

export function themeOptionsMarkup() {
  return Object.entries(MAIN_THEMES).map(([id,label])=>`<option value="${id}">${label}</option>`).join('');
}

export function typographyControlsMarkup() {
  return `<div class="typography-options" aria-label="文章排版设置">
    <label>正文字体<select id="fontFamilySelect"><option value="theme">随版式</option><option value="sans">系统黑体</option><option value="serif">阅读宋体</option></select></label>
    <label>正文字号<select id="fontSizeSelect"><option value="15">15 px</option><option value="16">16 px</option><option value="17" selected>17 px</option><option value="18">18 px</option></select></label>
    <label>图片说明字号<select id="captionFontSizeSelect"><option value="12" selected>12 px</option><option value="13">13 px</option><option value="14">14 px</option><option value="15">15 px</option><option value="16">16 px</option></select></label>
    <label>表格字号<select id="tableFontSizeSelect"><option value="12">12 px</option><option value="13" selected>13 px</option><option value="14">14 px</option><option value="15">15 px</option><option value="16">16 px</option></select></label>
    <label>代码字号<select id="codeFontSizeSelect"><option value="12" selected>12 px</option><option value="14">14 px</option></select></label>
    <label>代码长行<select id="codeWrapSelect"><option value="wrap" selected>阅读换行</option><option value="scroll">横向滚动</option></select></label>
    <label>表格呈现<select id="tableModeSelect"><option value="auto">自动适配</option><option value="scroll">保留横滑</option><option value="cards">分行卡片</option></select></label>
    <div class="device-preview-controls" aria-label="设备排版预览">
      <label>设备预览<select id="previewWidthSelect">${deviceOptionsMarkup()}</select></label>
      <label>方向<select id="previewOrientationSelect"><option value="portrait" selected>竖屏</option><option value="landscape">横屏</option></select></label>
      <label>显示比例<select id="previewZoomSelect"><option value="fit" selected>适合面板</option><option value="actual">原大 100%</option></select></label>
      <label id="previewCustomWidthLabel" hidden>自定义宽度（px）<input id="previewCustomWidth" type="number" min="280" max="1600" step="1" value="375" inputmode="numeric"></label>
      <p id="previewDeviceStatus" class="device-preview-status" role="status" aria-live="polite">iPhone 16 · 393px · 竖屏</p>
    </div>
  </div>`;
}

export function connectTypographyControls(container, onChange = () => {}) {
  const ids = {font_family:'fontFamilySelect',font_size:'fontSizeSelect',caption_font_size:'captionFontSizeSelect',table_font_size:'tableFontSizeSelect',code_font_size:'codeFontSizeSelect',code_wrap:'codeWrapSelect',table_mode:'tableModeSelect'};
  const fields = Object.fromEntries(Object.entries(ids).map(([key,id]) => {
    const element=container.querySelector('#'+id);
    if (!element) throw new Error('Missing typography control: '+id);
    return [key,element];
  }));
  let currentTheme='technical';
  const width=container.querySelector('#previewWidthSelect');
  const orientation=container.querySelector('#previewOrientationSelect');
  const zoom=container.querySelector('#previewZoomSelect');
  const customWidth=container.querySelector('#previewCustomWidth');
  const preview=container.querySelector('#previewArticle');
  const stage=preview?.closest('.phone-stage');
  const document=container.ownerDocument||container;
  const view=document.defaultView||globalThis;
  let frame=preview?.parentElement?.classList.contains('device-preview-frame')?preview.parentElement:null;
  if (preview&&stage&&!frame) {
    frame=document.createElement('div');frame.className='device-preview-frame';
    preview.before(frame);frame.append(preview);
  }
  function read(theme=currentTheme) {
    return normalizeTypography(Object.fromEntries(Object.entries(fields).map(([key,element])=>[
      key,key.endsWith('_size')?Number(element.value):element.value
    ])),theme);
  }
  function applyWidth() {
    if (!width) return;
    const viewport=previewViewport(width.value,orientation?.value,customWidth?.value);
    const customLabel=container.querySelector('#previewCustomWidthLabel');
    if (customLabel) customLabel.hidden=width.value!=='custom';
    if (orientation) orientation.disabled=viewport.kind==='custom';
    const style=stage&&view.getComputedStyle?.(stage);
    const padding=style?(parseFloat(style.paddingLeft)||0)+(parseFloat(style.paddingRight)||0):0;
    const scale=previewScale(viewport.width,stage?stage.clientWidth-padding:0,zoom?.value);
    const status=container.querySelector('#previewDeviceStatus');
    if (status) status.textContent=`${viewport.label} · ${viewport.width}px${viewport.kind==='custom'?'':viewport.orientation==='landscape'?' · 横屏':' · 竖屏'} · 显示 ${Math.round(scale*100)}%（排版参考）`;
    if (!preview) return;
    preview.style.width=viewport.width+'px';
    preview.style.maxWidth='none';
    if (frame) {
      preview.style.minHeight='0';
      preview.style.transform=`scale(${scale})`;
      frame.style.width=Math.floor(viewport.width*scale)+'px';
      // Reserve the visual height after scaling, so the final paragraph stays
      // reachable and large iPad previews do not overflow the editor shell.
      const height=Math.ceil(Math.max(preview.offsetHeight||0,preview.scrollHeight||0)*scale);
      const next=height+'px';
      if (frame.style.height!==next)frame.style.height=next;
    }
  }
  function load(metadata={}) {
    currentTheme=metadata.theme||'technical';
    const blue=container.querySelector('#paletteSelect option[value="blue"]');
    if (blue) blue.textContent=['grace','default','simple'].includes(currentTheme)?'科技蓝（旧版）':'AMD 官网蓝';
    const themes=container.querySelector('#themeSelect');
    if (themes) {
      // A saved old ID is a compatibility choice, never a migration or alias.
      for (const option of [...themes.querySelectorAll('[data-saved-theme]')]) option.remove();
      if (Object.hasOwn(SAVED_THEMES,currentTheme)) {
        const option=themes.ownerDocument.createElement('option');
        option.value=currentTheme;
        option.textContent='已保存 · '+SAVED_THEMES[currentTheme];
        option.setAttribute('data-saved-theme','');
        themes.append(option);
      }
    }
    const values=normalizeTypography(metadata,currentTheme);
    for (const [key,element] of Object.entries(fields)) {
      for (const option of element.options) option.selected=false;
      const option=[...element.options].find(item=>item.value===String(values[key]));
      if (option) option.selected=true;
    }
    applyWidth();
  }
  function themeChanged(theme) {
    const profiles={
      technical:{font_size:17,code_wrap:'wrap',table_mode:'auto'},
      journal:{font_size:17,code_wrap:'wrap',table_mode:'cards'},
      minimal:{font_size:16,code_wrap:'wrap',table_mode:'auto'},
      obsidian:{font_size:17,code_wrap:'wrap',table_mode:'auto'},
      deepsea:{font_size:17,code_wrap:'wrap',table_mode:'auto'},
      teal:{font_size:17,code_wrap:'wrap',table_mode:'auto'}
    };
    load({theme,font_family:'theme',...profiles[theme]});
  }
  for (const element of Object.values(fields)) element.addEventListener('change',()=>onChange(read()));
  width?.addEventListener('change',applyWidth);
  orientation?.addEventListener('change',applyWidth);
  zoom?.addEventListener('change',applyWidth);
  customWidth?.addEventListener('input',applyWidth);
  if (stage&&view.ResizeObserver) {
    const observer=new view.ResizeObserver(applyWidth);observer.observe(stage);observer.observe(preview);
  }
  if (preview&&view.MutationObserver) {
    const observer=new view.MutationObserver(applyWidth);
    observer.observe(preview,{childList:true,subtree:true,characterData:true});
  }
  applyWidth();
  return {load,read,themeChanged};
}
