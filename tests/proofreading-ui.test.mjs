import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {proofreadingMarkup,connectProofreading} from '../frontend/proofreading.mjs';
function setup(initial='请按装 ROCm，软件以经准备就绪。',storage=null,extra={}) {
  const {document}=parseHTML('<html><body>'+proofreadingMarkup()+'</body></html>');
  const dialog=document.querySelector('dialog');dialog.showModal=()=>dialog.setAttribute('open','');dialog.close=()=>dialog.removeAttribute('open');
  const state={text:initial,id:'test-draft',dirty:false,saves:0,fail:false};let control;
  control=connectProofreading(document,{storage,getText:()=>state.text,getDraftId:()=>state.id,getDirty:()=>state.dirty,
    replaceText:(next,expected,id)=>{assert.equal(state.text,expected);assert.equal(state.id,id);state.text=next;state.dirty=true;control.check(next);},
    select:()=>{},save:async()=>{state.saves++;if(state.fail)return null;state.dirty=false;return {id:state.id};},onMarksChanged:()=>{},...extra});
  control.check(initial);return {document,control,state};
}
test('checking and opening shows highlighted suggestions without changing or saving the article',()=>{
  const {document,control,state}=setup();control.open();
  assert.equal(state.dirty,false);assert.equal(state.saves,0);assert.ok(control.issues.length>=2);
  assert.ok(document.querySelector('#proofreadingList mark'));assert.ok(document.querySelector('dialog').hasAttribute('open'));
});
test('snapshot must complete before correction and newer text during snapshot is retained',async()=>{
 let release;const pending=new Promise(resolve=>release=resolve);
 const {control,state}=setup('请按装环境。',null,{beforeReplace:()=>pending});
 const applying=control.applySelected();assert.equal(state.text,'请按装环境。');
 state.text+='新输入';release();assert.equal(await applying,false);assert.equal(state.text,'请按装环境。新输入');
});
test('selected corrections remain undoable and save errors retain the edited text',async()=>{
  const {control,state,document}=setup();control.open();assert.equal(control.applySelected(),true);
  assert.match(state.text,/安装/);assert.match(state.text,/已经/);assert.equal(state.dirty,true);
  state.fail=true;assert.equal(await control.save(),false);assert.equal(state.dirty,true);assert.match(document.querySelector('#proofreadingMessage').textContent,/保存失败/);
  state.fail=false;assert.equal(await control.save(),true);assert.equal(state.dirty,false);
  assert.equal(control.undo(),true);assert.match(state.text,/按装/);assert.equal(state.dirty,true);
});
test('stale selections and undo after unrelated edits never overwrite newer text',()=>{
  const {control,state}=setup();control.open();state.text+='最新修改';
  assert.equal(control.applySelected(),false);assert.ok(state.text.endsWith('最新修改'));
  control.check(state.text);assert.equal(control.applySelected(),true);state.text+='新的句子';
  assert.equal(control.undo(),false);assert.ok(state.text.endsWith('新的句子'));
});
test('switching draft cannot apply old corrections or an old undo snapshot',()=>{
  const {control,state}=setup();control.open();state.id='other-draft';state.text='另一篇以经写好。';
  assert.equal(control.applySelected(),false);assert.equal(state.text,'另一篇以经写好。');
});
test('suspected typos remain visible suggestions without interrupting draft sync',async()=>{
  const source='请按装 ROCm。\n\n```python\nlabel="按装"\n```';
  const {control,state,document}=setup(source);
  assert.equal(control.beforeSync(),true);
  assert.equal(document.querySelector('dialog').hasAttribute('open'),false);
  assert.ok(control.issues.some(issue=>issue.confidence==='high'));
  assert.ok(document.querySelector('#proofreadingList mark'));
  assert.match(document.querySelector('#proofreadDraft').textContent,/错别字 · 1/);
  assert.equal(state.text,source);assert.equal(state.dirty,false);assert.equal(state.saves,0);

  // The optional correction flow still opens on request and saves edits safely.
  control.open();assert.equal(document.querySelector('dialog').hasAttribute('open'),true);
  assert.equal(control.applySelected(),true);assert.match(state.text,/请安装 ROCm/);
  assert.match(state.text,/label="按装"/);assert.equal(control.beforeSync(),true);
  assert.equal(await control.save(),true);assert.equal(state.dirty,false);assert.equal(state.saves,1);
});
