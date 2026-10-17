import {analyzeMarkdown,applyCorrections} from './proofreading-core.mjs';

export function proofreadingMarkup() {
  return `<button class="toolbar-button" id="proofreadDraft" type="button" disabled>错别字</button>
  <dialog class="proofreading-dialog" id="proofreadingDialog" aria-labelledby="proofreadingTitle">
    <header><div><strong id="proofreadingTitle">本地错别字校对</strong><p>检查常见易错词和标点，代码、链接及路径自动跳过。请核对建议后应用。</p></div><button id="closeProofreading" type="button" aria-label="关闭校对">×</button></header>
    <div class="proofreading-summary"><span id="proofreadingSummary" role="status"></span><button id="recheckProofreading" type="button">重新检查</button><button id="resetProofreadingIgnores" type="button">恢复忽略项</button></div>
    <div id="proofreadingList" class="proofreading-list"></div>
    <p id="proofreadingMessage" class="proofreading-message" role="status"></p>
    <footer><button id="applyProofreading" type="button">应用所选建议</button><button id="undoProofreading" type="button" disabled>撤销本次修改</button><button id="saveProofreading" type="button">保存修改</button></footer>
  </dialog>`;
}

export function connectProofreading(container,{getText,getDraftId,getDirty=()=>false,replaceText,select=()=>{},save,onMarksChanged=()=>{},storage}) {
  const doc=container.ownerDocument||container,get=id=>container.querySelector('#'+id);
  const dialog=get('proofreadingDialog'),list=get('proofreadingList'),selected=new Set();
  const storageKey='wechat-proofreading-ignored-v1';
  let ignored=new Set(),last=null,undoState=null,busy=false,version=0,ignoreVersion=0;
  try {storage=storage===undefined?globalThis.localStorage:storage;const saved=JSON.parse(storage?.getItem(storageKey)||'[]');if(Array.isArray(saved))ignored=new Set(saved.filter(w=>typeof w==='string'&&w.length>=2&&w.length<=64).slice(0,512));}catch{storage=null;}
  const message=(text,error=false)=>{get('proofreadingMessage').textContent=text;get('proofreadingMessage').classList.toggle('is-error',error);};
  function render() {
    const issues=last?.result.issues||[],active=!!getDraftId();
    get('proofreadDraft').disabled=!active;
    get('proofreadDraft').textContent='错别字'+(issues.length?' · '+issues.length:'');
    get('proofreadDraft').classList.toggle('has-proofreading-issues',issues.some(i=>i.confidence==='high'));
    get('proofreadingSummary').textContent=issues.length?`${issues.length} 处建议 · 选中 ${selected.size} 处${issues.length>200?'（先显示前 200 处）':''}`:last?.result.truncated?'已检查范围内未发现疑似错字':'未发现内置规则覆盖的疑似错字';
    get('resetProofreadingIgnores').disabled=busy||ignored.size===0;
    get('applyProofreading').disabled=busy||!selected.size;
    get('undoProofreading').disabled=busy||!undoState||undoState.id!==getDraftId()||undoState.after!==getText();
    get('saveProofreading').disabled=busy||!active||!getDirty();
    get('closeProofreading').disabled=busy;get('recheckProofreading').disabled=busy;
    list.replaceChildren();
    for(const issue of issues.slice(0,200)) {
      const card=doc.createElement('section');card.className='proofreading-issue';
      const label=doc.createElement('label'),checkbox=doc.createElement('input');checkbox.type='checkbox';checkbox.checked=selected.has(issue.id);checkbox.disabled=busy;checkbox.setAttribute('aria-label','选择修改：'+issue.original);
      checkbox.addEventListener('change',()=>{if(checkbox.checked)selected.add(issue.id);else selected.delete(issue.id);get('applyProofreading').disabled=!selected.size;get('proofreadingSummary').textContent=`${issues.length} 处建议 · 选中 ${selected.size} 处`;});
      const title=doc.createElement('strong');title.textContent=issue.original+' → '+issue.replacement;
      const level=doc.createElement('small');level.textContent=issue.confidence==='high'?'易错词':'请核对';label.append(checkbox,title,level);
      const excerpt=doc.createElement('p'),mark=doc.createElement('mark');mark.textContent=issue.original;
      const source=last.text;excerpt.append(doc.createTextNode(source.slice(Math.max(0,issue.from-24),issue.from).replace(/\r?\n/g,' ↵ ')),mark,doc.createTextNode(source.slice(issue.to,issue.to+24).replace(/\r?\n/g,' ↵ ')));
      const reason=doc.createElement('p');reason.className='proofreading-reason';reason.textContent=issue.message;
      const actions=doc.createElement('div');actions.className='proofreading-row-actions';
      for(const [text,action] of [['定位',()=>{if(validSnapshot()){dialog.close();select(issue);}}],['修改',()=>apply([issue])],['忽略此词',()=>ignore(issue.original)]]) {
        const button=doc.createElement('button');button.type='button';button.textContent=text;button.disabled=busy;button.addEventListener('click',action);actions.append(button);
      }
      card.append(label,excerpt,reason,actions);list.append(card);
    }
  }
  function check(text=getText()) {
    const id=getDraftId();
    if(last&&last.id===id&&last.text===text&&last.ignoreVersion===ignoreVersion)return last.result;
    const result=analyzeMarkdown(text,{ignoredWords:[...ignored]});
    last={id,text,result,ignoreVersion};selected.clear();for(const issue of result.issues.slice(0,200))if(issue.confidence==='high')selected.add(issue.id);
    version++;render();return result;
  }
  function validSnapshot() {
    if(last&&last.id===getDraftId()&&last.text===getText())return true;
    check();message('正文或稿件已变化，已重新检查；请重新选择建议。',true);return false;
  }
  function apply(issues) {
    if(busy||!validSnapshot())return false;
    try {
      const before=last.text,id=last.id,result=applyCorrections(before,issues);
      if(result.text===before)return false;
      replaceText(result.text,before,id);undoState={before,after:result.text,id};check(result.text);render();message(`已应用 ${issues.length} 处修改，尚未保存。`);return true;
    }catch(error){message(error.message||'修改失败，正文保持原样。',true);return false;}
  }
  function applySelected(){return apply((last?.result.issues||[]).filter(issue=>selected.has(issue.id)));}
  function undo() {
    if(busy||!undoState)return false;
    if(undoState.id!==getDraftId()||undoState.after!==getText()){message('正文已变化，请使用编辑器的撤销功能，避免覆盖新内容。',true);render();return false;}
    const item=undoState;replaceText(item.before,item.after,item.id);undoState=null;check(item.before);render();message('已撤销本次修改，尚未保存。');return true;
  }
  function ignore(word) {
    if(busy||!validSnapshot())return;
    ignored.add(word);ignoreVersion++;try{storage?.setItem(storageKey,JSON.stringify([...ignored].slice(-512)));}catch{/* A full browser store must not stop local editing. */}
    check();onMarksChanged();message('已加入本机忽略词；可用“恢复忽略项”重新检查。');
  }
  async function saveEdits() {
    if(busy||!getDraftId())return false;
    busy=true;render();message('正在保存…');
    try {const saved=await save();if(!saved)throw new Error('保存失败，修改仍保留在编辑器中，请重试。');message('修改已保存到本地稿件。');return true;}
    catch(error){message(error.message||'保存失败，修改仍保留在编辑器中。',true);return false;}
    finally{busy=false;check();render();}
  }
  function open(){if(!getDraftId())return;check();render();message(last.result.truncated?'文章较长或建议较多，本次结果存在检查范围限制，请分段核对。':'');if(!dialog.open)dialog.showModal();}
  function beforeSync(){if(!getDraftId())return true;check();if(last.result.issues.some(issue=>issue.confidence==='high')){open();message('同步前请先核对易错词：应用建议，或忽略确认无误的词。',true);return false;}return true;}
  get('proofreadDraft').addEventListener('click',open);
  get('closeProofreading').addEventListener('click',()=>{if(!busy)dialog.close();});
  dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();});
  get('recheckProofreading').addEventListener('click',()=>{last=null;check();onMarksChanged();message('已重新检查。');});
  get('resetProofreadingIgnores').addEventListener('click',()=>{if(busy)return;ignored.clear();ignoreVersion++;try{storage?.removeItem(storageKey);}catch{}check();onMarksChanged();message('已恢复全部忽略项。');});
  get('applyProofreading').addEventListener('click',applySelected);get('undoProofreading').addEventListener('click',undo);get('saveProofreading').addEventListener('click',()=>void saveEdits());
  render();
  return {check,open,applySelected,undo,save:saveEdits,beforeSync,get version(){return version;},get issues(){return last?.result.issues||[];}};
}

export function createProofreadingExtension({ViewPlugin,Decoration},controller) {
  return ViewPlugin.fromClass(class {
    constructor(view){this.view=view;this.build();}
    build(){const result=controller.check(this.view.state.doc.toString());this.version=controller.version;this.decorations=Decoration.set(result.issues.map(issue=>Decoration.mark({class:issue.confidence==='high'?'wx-proofreading-error':'wx-proofreading-review',attributes:{title:issue.message+'：'+issue.original+' → '+issue.replacement}}).range(issue.from,issue.to)),true);}
    update(update){if(update.docChanged||this.version!==controller.version)this.build();}
  },{decorations:plugin=>plugin.decorations});
}
