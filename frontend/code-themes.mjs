/** Code palettes are independent of the article accent; all output is inlineable.
 * Inspired by VS Code Dark+, GitHub/Primer and Catppuccin Mocha.
 * Sources and font fallbacks are documented in docs/typography.md.
 */
export const CODE_FONT='"JetBrains Mono","Cascadia Code","SFMono-Regular",Consolas,"Liberation Mono",Menlo,"Courier New",monospace';
const THEMES={
  vscode:{
    background:'#1e1e1e',header:'#181818',text:'#d4d4d4',border:'#424242',label:'#c8d3e2',gutter:'#929ba8',accent:'#4fc1ff',
    tokens:{keyword:'#c586c0',decorator:'#e0a0cf',string:'#ce9178',number:'#b5cea8',literal:'#569cd6',fn:'#dcdcaa',type:'#4ec9b0',api:'#4fc1ff',variable:'#9cdcfe',attribute:'#d7ba7d',operator:'#c5cbd3',comment:'#8eaf85',addition:'#a8d5ad',deletion:'#f0a0a0'},
  },
  github:{
    background:'#f6f8fa',header:'#eaeef2',text:'#24292f',border:'#d0d7de',label:'#3d4754',gutter:'#59636e',accent:'#0969da',
    tokens:{keyword:'#a51d38',decorator:'#8250a5',string:'#0a3069',number:'#0550ae',literal:'#953f0b',fn:'#6639ba',type:'#116b63',api:'#006b75',variable:'#334e84',attribute:'#80571b',operator:'#57606a',comment:'#59636e',addition:'#116329',deletion:'#a40e26'},
  },
  catppuccin:{
    background:'#1e1e2e',header:'#181825',text:'#cdd6f4',border:'#45475a',label:'#bac2de',gutter:'#a6adc8',accent:'#89dceb',
    tokens:{keyword:'#cba6f7',decorator:'#f5c2e7',string:'#a6e3a1',number:'#fab387',literal:'#f38ba8',fn:'#89b4fa',type:'#f9e2af',api:'#94e2d5',variable:'#b4befe',attribute:'#f2cdcd',operator:'#89dceb',comment:'#a6adc8',addition:'#a6e3a1',deletion:'#f38ba8'},
  },
};
export function normalizeCodeTheme(value) {
  return typeof value==='string'&&['auto','vscode','github','catppuccin'].includes(value)?value:'auto';
}
export function codeTheme(articleTheme='technical',requested='auto') {
  const choice=normalizeCodeTheme(requested);
  const id=choice==='auto'?articleTheme==='dracula'?'catppuccin':['technical','obsidian','deepsea','nord'].includes(articleTheme)?'vscode':'github':choice;
  const theme=THEMES[id];
  return {...theme,id,tokens:{...theme.tokens}};
}
export const CODE_TOKEN_SELECTORS={
  comment:'.hljs-comment,.hljs-quote',keyword:'.hljs-keyword,.hljs-doctag,.hljs-selector-tag',decorator:'.hljs-meta',
  string:'.hljs-string,.hljs-regexp,.hljs-meta .hljs-string',number:'.hljs-number,.hljs-symbol,.hljs-bullet',literal:'.hljs-literal',
  fn:'.hljs-title,.hljs-name,.hljs-section,.hljs-selector-id,.hljs-selector-class,.hljs-link',type:'.hljs-type,.hljs-title.class_',
  api:'.hljs-built_in',attribute:'.hljs-attr,.hljs-attribute',variable:'.hljs-variable,.hljs-template-variable,.hljs-params',
  operator:'.hljs-operator,.hljs-punctuation',addition:'.hljs-addition',deletion:'.hljs-deletion',
};
export function codeThemeCSS(settings,articleTheme,rule) {
  const c=codeTheme(articleTheme,settings.code_theme),wrap=settings.code_wrap!=='scroll';
  const size=[12,14].includes(Number(settings.code_font_size))?Number(settings.code_font_size):12;
  let css=rule('.wx-code-block',{display:'block',margin:'22px 0',padding:'0',background:c.background,color:c.text,border:`1px solid ${c.border}`,'border-radius':'10px',overflow:'hidden','max-width':'100%','box-sizing':'border-box','text-align':'left'})+
    rule('.wx-code-caption',{display:'block',margin:'0',padding:'10px 14px',color:c.label,background:c.header,border:'0','font-family':CODE_FONT,'font-size':'12px','font-weight':'500','line-height':'1.5','letter-spacing':'.2px','text-align':'left','box-sizing':'border-box'})+
    rule('.wx-code-language',{display:'inline-block',margin:'0',padding:'0 0 0 9px','border-left':`3px solid ${c.accent}`,color:c.label,'font-family':CODE_FONT,'font-size':'12px','font-weight':'600','line-height':'1.2','vertical-align':'baseline'})+
    rule('.wx-code-pre',{display:'block',margin:'0',padding:'14px 12px 16px',background:c.background,color:c.text,border:'0','border-top':`1px solid ${c.border}`,'border-radius':'0','box-shadow':'none','box-sizing':'border-box',width:'auto','min-width':'0','max-width':'100%','overflow-x':wrap?'hidden':'auto','overflow-y':'hidden','font-family':CODE_FONT,'font-size':size+'px','line-height':'1.8','text-align':'left','white-space':wrap?'pre-wrap':'pre','overflow-wrap':wrap?'anywhere':'normal','word-break':'normal','tab-size':'4'})+
    rule('.wx-code-text',{display:'block',margin:'0',padding:'0',background:'transparent',color:c.text,border:'0','border-radius':'0','font-family':CODE_FONT,'font-size':size+'px','font-weight':'400','line-height':'1.8','letter-spacing':'0','font-variant-ligatures':'none','white-space':wrap?'pre-wrap':'pre','overflow-wrap':wrap?'anywhere':'normal','word-break':'normal','tab-size':'4','text-shadow':'none'});
  for(const [role,selectors] of Object.entries(CODE_TOKEN_SELECTORS)) css+=rule(selectors,{color:c.tokens[role],background:'transparent','font-style':'normal','text-decoration':'none'});
  css+=rule('.hljs-title.function_,.hljs-function .hljs-title',{'font-weight':'600'});
  css+=rule('.hljs-subst',{color:c.text});
  css+=rule('.hljs-emphasis',{'font-style':'italic'})+rule('.hljs-strong',{'font-weight':'700'});
  return css;
}
