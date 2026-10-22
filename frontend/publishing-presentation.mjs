/** Publishing-only presentation; never modifies the Markdown editor document. */
export function preparePublishingPresentation(html, {document = globalThis.document, linkColor = '#576b95', codeColors} = {}) {
  const root=document.createElement('div');
  root.innerHTML=html;
  for (const pre of root.querySelectorAll('pre')) {
    for (const node of [pre,...pre.querySelectorAll('*')]) node.style.setProperty('font-size','14px','important');
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
  for (const anchor of [...root.querySelectorAll('a[href]')]) {
    const href=anchor.getAttribute('href').trim();
    if (!href || href.startsWith('#') || anchor.closest('pre,code')) continue;
    const label=anchor.textContent.trim();
    const text=document.createElement('span');
    text.className='wx-external-link';
    text.style.cssText=anchor.style.cssText;
    text.style.setProperty('color',linkColor,'important');
    text.style.setProperty('text-decoration','underline','important');
    text.style.setProperty('overflow-wrap','anywhere','important');
    for (const attribute of ['title','lang','dir']) if(anchor.hasAttribute(attribute)) text.setAttribute(attribute,anchor.getAttribute(attribute));
    while(anchor.firstChild) text.append(anchor.firstChild);
    if(label !== href) text.append(document.createTextNode(`（${href}）`));
    anchor.replaceWith(text);
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
