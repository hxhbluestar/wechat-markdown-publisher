import {addCodeLineNumbers} from './code-line-numbers.mjs';
/** Publishing-only presentation; never modifies the Markdown editor document. */
export function preparePublishingPresentation(html, {document = globalThis.document, linkColor = '#576b95', codeColors, codeFontSize = 12, codeWrap='wrap',lineNumberColor='#657082'} = {}) {
  const root=document.createElement('div');
  root.innerHTML=html;
  addCodeLineNumbers(root,document,{wrap:codeWrap!=='scroll',color:lineNumberColor});
  const size=(typeof codeFontSize==='number'||typeof codeFontSize==='string')&&[12,14].includes(Number(codeFontSize))?Number(codeFontSize):12;
  for (const pre of root.querySelectorAll('pre')) {
    for (const node of [pre,...pre.querySelectorAll('*')]) node.style.setProperty('font-size',size+'px','important');
    pre.style.setProperty('display','block','important');
    const code=pre.querySelector('code');
    if(code) code.style.setProperty('display','block','important');
  }
  for (const code of root.querySelectorAll('code')) {
    if (code.closest('pre')) continue;
    for (const node of [code,...code.querySelectorAll('*')]) node.style.setProperty('font-size','12px','important');
  }
  for (const node of root.querySelectorAll('.wx-code-caption,.wx-code-caption *')) node.style.setProperty('font-size','12px','important');
  if(codeColors) {
    const roles={comment:'.hljs-comment,.hljs-quote',keyword:'.hljs-keyword,.hljs-doctag',decorator:'.hljs-meta',string:'.hljs-string,.hljs-regexp',number:'.hljs-number,.hljs-symbol',literal:'.hljs-literal',fn:'.hljs-title,.hljs-name',type:'.hljs-type',api:'.hljs-built_in',attribute:'.hljs-attr,.hljs-attribute',variable:'.hljs-variable,.hljs-template-variable,.hljs-params',operator:'.hljs-operator,.hljs-punctuation',addition:'.hljs-addition',deletion:'.hljs-deletion'};
    for(const [role,selectors] of Object.entries(roles)) for(const node of root.querySelectorAll(selectors)) {
      if(node.closest('pre') && codeColors[role]) node.style.setProperty('color',codeColors[role],'important');
    }
  }
  const references=new Map();
  const compactAddress=href=>{
    try { return new URL(href, 'https://example.invalid').hostname || href.split(':')[0]; }
    catch { return '外部资料'; }
  };
  const setLabel=(element,value)=>{
    const clearText=node=>{
      for(const child of [...node.childNodes]) {
        if(child.nodeType===3) child.remove();
        else clearText(child);
      }
    };
    clearText(element);element.append(document.createTextNode(value));
  };
  // Document imports can carry plain URLs rather than Markdown anchors.
  // Limit recognition to prose text; code, existing labels and reference URLs
  // must never be rewritten or indexed a second time.
  const prose=[];
  const collect=node=>{
    for(const child of [...node.childNodes]) {
      if(child.nodeType===3) {
        if(!child.parentElement?.closest('a,pre,code,script,style,svg,math,.wx-external-link,[data-wx-link-references]')) prose.push(child);
      } else if(child.nodeType===1) collect(child);
    }
  };
  collect(root);
  for(const node of prose) {
    const value=node.nodeValue, fragment=document.createDocumentFragment();
    let cursor=0;
    for(const match of value.matchAll(/https?:\/\/[^\s<>"'，。；：、！？（）【】]+/g)) {
      let href=match[0].replace(/[.,;!?]+$/,'');
      const pairs={')':'(',']':'[','}':'{'};
      while(pairs[href.at(-1)]) {
        const closing=href.at(-1),opening=pairs[closing];
        if([...href].filter(c=>c===closing).length<=[...href].filter(c=>c===opening).length) break;
        href=href.slice(0,-1);
      }
      try { if(!new URL(href).hostname) continue; } catch { continue; }
      fragment.append(document.createTextNode(value.slice(cursor,match.index)));
      const anchor=document.createElement('a');
      anchor.setAttribute('href',href);anchor.textContent=href;fragment.append(anchor);
      cursor=match.index+href.length;
    }
    if(cursor) { fragment.append(document.createTextNode(value.slice(cursor)));node.replaceWith(fragment); }
  }
  for (const anchor of [...root.querySelectorAll('a[href]')]) {
    if(anchor.closest('svg,math')) { anchor.removeAttribute('href');continue; }
    const href=anchor.getAttribute('href').trim();
    if (!href || href.startsWith('#') || anchor.closest('pre,code')) continue;
    let label=anchor.textContent.trim();
    // Imported documents sometimes contain [label]URL without Markdown's ().
    // Repair the presentation only; never rewrite the author's source document.
    const previous=anchor.previousSibling;
    const shorthand=label===href&&previous?.nodeType===3&&/\[([^\[\]\n]+)\]$/.exec(previous.nodeValue);
    if(shorthand) {
      previous.nodeValue=previous.nodeValue.slice(0,-shorthand[0].length);
      label=shorthand[1];setLabel(anchor,label);
    }
    if(!references.has(href)) references.set(href,{number:references.size+1,label:label&&label!==href?label:compactAddress(href)});
    const reference=references.get(href);
    const text=document.createElement('span');
    text.className='wx-external-link';
    text.style.cssText=anchor.style.cssText;
    text.style.setProperty('color',linkColor,'important');
    text.style.setProperty('text-decoration','underline','important');
    text.style.setProperty('overflow-wrap','anywhere','important');
    for (const attribute of ['title','lang','dir']) if(anchor.hasAttribute(attribute)) text.setAttribute(attribute,anchor.getAttribute(attribute));
    while(anchor.firstChild) text.append(anchor.firstChild);
    if(label===href) setLabel(text,compactAddress(href));
    if(!label) text.append(document.createTextNode(text.querySelector('img')?.getAttribute('alt')||'图片来源'));
    for(const child of text.querySelectorAll('strong,em')) child.style.setProperty('color','inherit','important');
    const number=document.createElement('sup');
    number.textContent=`[${reference.number}]`;
    number.style.cssText=`font-size:10px!important;line-height:0;vertical-align:super;color:${linkColor}!important;text-decoration:none;white-space:nowrap`;
    text.append(number);
    anchor.replaceWith(text);
  }
  if(references.size) {
    const section=document.createElement('section');
    section.setAttribute('data-wx-link-references','true');
    section.style.cssText='margin:28px 0 0;padding:16px 0 0;border-top:1px solid #d8dee7;text-align:left;max-width:100%;box-sizing:border-box';
    const heading=document.createElement('section');
    heading.textContent='参考资料';
    heading.style.cssText=`font-size:14px!important;font-weight:600;line-height:1.6;color:${linkColor}!important;margin:0 0 12px;padding:0`;
    section.append(heading);
    for(const [href,{number,label}] of references) {
      const item=document.createElement('section');
      item.style.cssText='margin:0 0 12px;padding:0;max-width:100%;text-align:left';
      const title=document.createElement('section');
      title.textContent=`[${number}] ${label}`;
      title.style.cssText=`font-size:12px!important;line-height:1.65;color:${linkColor}!important;margin:0 0 3px;padding:0;font-weight:500`;
      const address=document.createElement('span');
      address.setAttribute('data-wx-reference-url','true');
      address.textContent=href;
      address.style.cssText=`display:block;font-size:12px!important;line-height:1.7;color:${linkColor}!important;text-decoration:underline;overflow-wrap:anywhere;word-break:break-all;white-space:normal;max-width:100%`;
      item.append(title,address);section.append(item);
    }
    (root.querySelector('.wx-typography')||root).append(section);
  }
  return root.innerHTML;
}

/** Explicit breaks survive CSS cleaning; code characters stay ASCII/Tab exact. */
export function preserveWechatCodeLayout(html, document = globalThis.document) {
  const root=document.createElement('div');
  root.innerHTML=html;
  for (const pre of root.querySelectorAll('pre')) {
    const code=pre.querySelector('code') || pre;
    const wrap=/pre-wrap|normal/.test(code.style.getPropertyValue('white-space') || pre.style.getPropertyValue('white-space'));
    let lineStart=true, column=0;
    const indentWidth=value=>{ const before=column; for(const char of value) column+=char==='\t'?4-column%4:1; return column-before; };
    const visit=node=>{
      if(node.nodeType===1&&node.hasAttribute('data-wx-code-line-number')) return;
      if(node.nodeType===1&&node.hasAttribute('data-wx-code-line-text')) { lineStart=true;column=0; }
      if(node.nodeType===3) {
        const value=node.nodeValue.replace(/\r\n?/g,'\n');
        const fragment=document.createDocumentFragment();
        value.split('\n').forEach((line,index)=>{
          if(index) { fragment.append(document.createElement('br')); lineStart=true; column=0; }
          const leading=lineStart?line.match(/^[ \t]+/)?.[0]:'';
          if(leading) {
            const indent=document.createElement('span');
            indent.setAttribute('data-wx-code-indent','true');
            indent.style.cssText=`display:inline-block;width:${indentWidth(leading)}ch;white-space:pre;tab-size:4`;
            indent.textContent=leading;
            fragment.append(indent);
          }
          const rest=line.slice(leading?.length||0);
          if(rest) { fragment.append(document.createTextNode(rest)); lineStart=false; }
        });
        node.replaceWith(fragment);
      } else if(node.nodeType===1 && node.tagName==='BR') { lineStart=true; column=0;
      } else if(node.nodeType===1 && node.hasAttribute('data-wx-code-indent')) { indentWidth(node.textContent);
      } else if(node.nodeType===1) {
        node.style.setProperty('white-space',wrap?'pre-wrap':'pre','important');
        for(const child of [...node.childNodes]) visit(child);
      }
    };
    visit(code);
  }
  return root.innerHTML;
}
