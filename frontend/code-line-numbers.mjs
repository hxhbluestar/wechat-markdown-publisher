/** Number source lines without inserting digits into the source text cells. */
export function addCodeLineNumbers(root, document, {wrap=true,color='#657082'}={}) {
  for(const code of root.querySelectorAll('pre > code')) {
    if(code.hasAttribute('data-wx-code-numbered')) continue;
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
    for(const [index,fragment] of lines.entries()) {
      const row=document.createElement('span');
      row.setAttribute('data-wx-code-line','true');
      row.style.cssText='display:table!important;table-layout:fixed;width:100%;border:0;margin:0;padding:0;line-height:inherit';
      const number=document.createElement('span');
      number.className='line-numbers';
      number.setAttribute('data-wx-code-line-number','true');
      number.setAttribute('aria-hidden','true');
      number.textContent=String(index+1);
      number.style.cssText=`display:table-cell!important;width:${digits}ch;box-sizing:content-box;padding:0 10px 0 0;border-right:1px solid rgba(128,144,160,.3);color:${color}!important;text-align:right;vertical-align:top;white-space:pre!important;user-select:none!important;-webkit-user-select:none!important;font-weight:400;line-height:inherit`;
      number.style.setProperty('user-select','none','important');
      number.style.setProperty('-webkit-user-select','none','important');
      const text=document.createElement('span');
      text.setAttribute('data-wx-code-line-text','true');
      text.style.cssText=`display:table-cell!important;min-width:0;padding:0 0 0 10px;border:0;vertical-align:top;white-space:${wrap?'pre-wrap':'pre'}!important;overflow-wrap:${wrap?'anywhere':'normal'}!important;word-break:normal`;
      text.append(fragment);
      if(index<lines.length-1) text.append(document.createTextNode('\n'));
      row.append(number,text);code.append(row);
    }
  }
}
