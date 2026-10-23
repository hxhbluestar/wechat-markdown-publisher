const PLAIN_DATA_LANGUAGES=new Set(['csv','tsv','text','txt','plaintext','plain']);

/** Number source lines without inserting digits into the source text cells. */
export function addCodeLineNumbers(root, document, {wrap=true,color='#657082'}={}) {
  for(const code of root.querySelectorAll('pre > code')) {
    if(code.hasAttribute('data-wx-code-numbered')) continue;
    const language=(code.getAttribute('data-language-pending')||code.getAttribute('data-language')||code.className.match(/(?:^|\s)(?:language|lang)-([^\s]+)/i)?.[1]||'').trim().split(/\s+/)[0].toLowerCase();
    if(PLAIN_DATA_LANGUAGES.has(language)) continue;
    const lines=[document.createDocumentFragment()];
    const append=(value,ancestors)=>{
      if(!value) return;
      let parent=lines.at(-1);
      for(const ancestor of ancestors) {
        const clone=ancestor.cloneNode(false);parent.append(clone);parent=clone;
      }
      parent.append(document.createTextNode(value));
    };
    const split=(node,ancestors=[])=>{
      if(node.nodeType===3) {
        node.nodeValue.split(/\r\n?|\n/).forEach((value,index)=>{
          if(index) lines.push(document.createDocumentFragment());
          append(value,ancestors);
        });
      } else if(node.nodeType===1) {
        if(node.tagName==='BR') lines.push(document.createDocumentFragment());
        else if(!node.hasAttribute('data-wx-code-line-number')) for(const child of [...node.childNodes]) split(child,[...ancestors,node]);
      }
    };
    for(const child of [...code.childNodes]) split(child);
    code.replaceChildren();
    code.setAttribute('data-wx-code-numbered','true');
    const digits=Math.max(2,String(lines.length).length);
    // A pixel gutter includes its padding and rule. A ch-sized table cell can
    // become too narrow when a rich editor normalizes its box sizing.
    const gutterWidth=digits*7+10;
    for(const [index,fragment] of lines.entries()) {
      const row=document.createElement('span');
      row.setAttribute('data-wx-code-line','true');
      row.style.cssText='display:table!important;table-layout:fixed;width:100%;border:0;margin:0;padding:0;line-height:inherit';
      const number=document.createElement('span');
      number.className='line-numbers';
      number.setAttribute('data-wx-code-line-number','true');
      number.setAttribute('aria-hidden','true');
      number.textContent=String(index+1);
      number.style.cssText=`display:table-cell!important;width:${gutterWidth}px;min-width:${gutterWidth}px;max-width:${gutterWidth}px;box-sizing:border-box;padding:0 8px 0 0;border-right:1px solid rgba(128,144,160,.3);color:${color}!important;text-align:right;vertical-align:top;white-space:nowrap!important;overflow-wrap:normal!important;word-break:keep-all!important;user-select:none!important;-webkit-user-select:none!important;font-size:10px!important;font-weight:400;letter-spacing:0;line-height:inherit`;
      number.style.setProperty('user-select','none','important');
      number.style.setProperty('-webkit-user-select','none','important');
      for(const [property,value] of Object.entries({'white-space':'nowrap','overflow-wrap':'normal','word-break':'keep-all'})) number.style.setProperty(property,value,'important');
      const text=document.createElement('span');
      text.setAttribute('data-wx-code-line-text','true');
      text.style.cssText=`display:table-cell!important;min-width:0;padding:0 0 0 8px;border:0;vertical-align:top;white-space:${wrap?'pre-wrap':'pre'}!important;overflow-wrap:${wrap?'anywhere':'normal'}!important;word-break:normal`;
      text.append(fragment);
      if(index<lines.length-1) text.append(document.createTextNode('\n'));
      row.append(number,text);code.append(row);
    }
  }
}
