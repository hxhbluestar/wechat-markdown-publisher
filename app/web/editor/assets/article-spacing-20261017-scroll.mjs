// Each block owns only its leading gap. Padding survives platform wrappers
// without relying on adjacent vertical margins collapsing in the same way.
const FLOW = 'p,h1,h2,h3,h4,h5,h6,figure,ul,ol,blockquote,pre,table,hr,.wx-code-block,.wx-table-block,.wx-table-cards,.wx-alert';
function resetVertical(element,padding=false) {
  for(const property of ['margin','margin-top','margin-bottom','line-height',...(padding?['padding','padding-top','padding-bottom']:[])])element.style.removeProperty(property);
}
function kind(element) {
  if(/^H[1-6]$/.test(element.tagName))return 'heading';
  if(element.tagName==='FIGURE')return 'figure';
  if(element.tagName==='PRE'||element.classList.contains('wx-code-block'))return 'code';
  return 'text';
}
export function prepareArticleSpacing(root) {
  for(const old of [...root.querySelectorAll('.wx-flow-block')])old.replaceWith(...old.childNodes);
  const containers=[root,...root.querySelectorAll('.container')];
  for(const container of containers) {
    if(container.closest('pre,code,table,blockquote,figure,li'))continue;
    let previous=null;
    for(const element of [...container.children]) {
      if(!element.matches(FLOW))continue;
      if(element.tagName==='P'&&!element.textContent.trim()&&[...element.querySelectorAll('*')].every(n=>['BR','SPAN','EM','STRONG'].includes(n.tagName))) {element.remove();continue;}
      const current=kind(element);
      let gap=!previous?0:current==='heading'?(previous==='heading'?16:element.tagName==='H2'?28:24):previous==='heading'?12:current==='figure'||previous==='figure'||current==='code'||previous==='code'?20:16;
      resetVertical(element,['P','FIGURE'].includes(element.tagName));
      if(element.tagName==='P'||current==='heading')for(const child of element.querySelectorAll('span,strong,em,a'))child.style.removeProperty('line-height');
      if(current==='figure')for(const child of element.querySelectorAll('img,p,figcaption,.md-figcaption'))resetVertical(child,true);
      const block=root.ownerDocument.createElement('section');
      block.className=`wx-flow-block wx-flow-gap-${gap}`;
      element.replaceWith(block);block.append(element);previous=current;
    }
  }
}
export function articleSpacingCSS(rule) {
  let css=rule('.wx-flow-block',{display:'block',margin:'0',padding:'0','max-width':'100%','box-sizing':'border-box'});
  for(const gap of [0,12,16,20,24,28])css+=rule('.wx-flow-gap-'+gap,{'padding-top':gap+'px'});
  css+=rule('.wx-flow-block > *',{ 'margin-top':'0','margin-bottom':'0' });
  css+=rule('.wx-flow-block > p',{margin:'0',padding:'0','line-height':'1.8'});
  css+=rule('.wx-flow-block li,.wx-flow-block li p',{'line-height':'1.8'});
  css+=rule('.wx-flow-block blockquote p:last-child',{'margin-bottom':'0'});
  css+=rule('.wx-flow-block > h1,.wx-flow-block > h2,.wx-flow-block > h3,.wx-flow-block > h4,.wx-flow-block > h5,.wx-flow-block > h6',{'line-height':'1.45'});
  css+=rule('.wx-flow-block > h1 *,.wx-flow-block > h2 *,.wx-flow-block > h3 *,.wx-flow-block > h4 *,.wx-flow-block > h5 *,.wx-flow-block > h6 *',{'line-height':'inherit'});
  css+=rule('.wx-flow-block > figure',{display:'block',margin:'0',padding:'0','max-width':'100%'});
  css+=rule('.wx-flow-block > figure img',{display:'block',margin:'0 auto','max-width':'100%',height:'auto','vertical-align':'middle'});
  css+=rule('.wx-flow-block > figure > p',{margin:'0',padding:'0'});
  css+=rule('.wx-flow-block figcaption,.wx-flow-block .md-figcaption',{display:'block',margin:'0',padding:'8px 0 0','line-height':'1.65'});
  css+=rule('.wx-flow-block figcaption *,.wx-flow-block .md-figcaption *',{'line-height':'inherit'});
  css+=rule('.wx-flow-block figcaption p,.wx-flow-block .md-figcaption p',{margin:'0',padding:'0'});
  return css;
}
