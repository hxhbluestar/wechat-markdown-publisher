import {normalizeTypography} from './typography.mjs';

const MAIN_THEMES = {technical:'AMD 技术蓝',minimal:'极简墨色',journal:'纸感期刊',obsidian:'曜石青'};
const SAVED_THEMES = {deepsea:'深海青',teal:'青绿实验室',grace:'雅致',default:'简洁',simple:'留白'};

export function themeOptionsMarkup() {
  return Object.entries(MAIN_THEMES).map(([id,label])=>`<option value="${id}">${label}</option>`).join('');
}

export function typographyControlsMarkup() {
  return `<div class="typography-options" aria-label="文章排版设置">
    <label>正文字体<select id="fontFamilySelect"><option value="theme">随版式</option><option value="sans">系统黑体</option><option value="serif">阅读宋体</option></select></label>
    <label>正文字号<select id="fontSizeSelect"><option value="15">15 px</option><option value="16">16 px</option><option value="17" selected>17 px</option><option value="18">18 px</option></select></label>
    <label>图片说明字号<select id="captionFontSizeSelect"><option value="12" selected>12 px</option><option value="13">13 px</option><option value="14">14 px</option><option value="15">15 px</option><option value="16">16 px</option></select></label>
    <label>表格字号<select id="tableFontSizeSelect"><option value="12">12 px</option><option value="13" selected>13 px</option><option value="14">14 px</option><option value="15">15 px</option><option value="16">16 px</option></select></label>
    <label>代码长行<select id="codeWrapSelect"><option value="scroll">横向滚动</option><option value="wrap">阅读换行</option></select></label>
    <label>表格呈现<select id="tableModeSelect"><option value="auto">自动适配</option><option value="scroll">保留横滑</option><option value="cards">分行卡片</option></select></label>
    <label>手机宽度<select id="previewWidthSelect"><option value="320">320 px</option><option value="375" selected>375 px</option><option value="430">430 px</option></select></label>
  </div>`;
}

export function connectTypographyControls(container, onChange = () => {}) {
  const ids = {font_family:'fontFamilySelect',font_size:'fontSizeSelect',caption_font_size:'captionFontSizeSelect',table_font_size:'tableFontSizeSelect',code_wrap:'codeWrapSelect',table_mode:'tableModeSelect'};
  const fields = Object.fromEntries(Object.entries(ids).map(([key,id]) => {
    const element=container.querySelector('#'+id);
    if (!element) throw new Error('Missing typography control: '+id);
    return [key,element];
  }));
  let currentTheme='technical';
  const width=container.querySelector('#previewWidthSelect');
  function read(theme=currentTheme) {
    return normalizeTypography(Object.fromEntries(Object.entries(fields).map(([key,element])=>[
      key,key.endsWith('_size')?Number(element.value):element.value
    ])),theme);
  }
  function applyWidth() {
    const preview=container.querySelector('#previewArticle');
    if (!preview || !width) return;
    const value=[320,375,430].includes(Number(width.value))?Number(width.value):375;
    preview.style.width=value+'px';
    preview.style.maxWidth='none';
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
      technical:{font_size:17,code_wrap:'scroll',table_mode:'auto'},
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
  return {load,read,themeChanged};
}
