import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

// Exercise the shared function actually shipped to Save, Ctrl+S and proofreading.
const bundle=readFileSync(new URL('../app/web/editor/assets/index-20261017-scroll.js',import.meta.url),'utf8');
const start=bundle.includes('let pendingDraftSave=')?bundle.indexOf('let pendingDraftSave='):bundle.indexOf('async function wp()');
const code=bundle.slice(start,bundle.indexOf('async function WS(',start));
function harness(){
  const H={current:{id:'a',revision:'r0',content:'按装',metadata:{title:'A',cover:''}},dirty:true};
  let text='按装',metadata={title:'A',cover:''};const requests=[],errors=[];
  const sn=(url,options)=>new Promise((resolve,reject)=>requests.push({url,body:JSON.parse(options.body),resolve,reject}));
  const wp=Function('H','sn','zo','kc','le','ds','ia','_o','ct',code+';return wp;')(H,sn,()=>text,()=>({...metadata}),{title:{}},dirty=>H.dirty=dirty,async()=>{},()=>{},message=>errors.push(message));
  const resolve=(index=0)=>{const r=requests[index];r.resolve({id:r.url.split('/').at(-1),revision:'r'+(index+1),content:r.body.content,metadata:r.body.metadata});};
  return {H,wp,requests,errors,resolve,setText:value=>{text=value;H.dirty=true;},setMetadata:value=>{metadata={...metadata,...value};H.dirty=true;},getText:()=>text};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('an older save response cannot mark a newer correction as saved',async()=>{
  const h=harness(),saving=h.wp();await tick();h.setText('安装');h.resolve();assert.equal(await saving,null);assert.equal(h.H.dirty,true);assert.equal(h.getText(),'安装');assert.equal(h.H.current.revision,'r1');
});
test('metadata changed during save is retained and remains dirty',async()=>{
  const h=harness(),saving=h.wp();await tick();h.setMetadata({title:'新标题',cover:'cover-new.png'});h.resolve();assert.equal(await saving,null);assert.equal(h.H.dirty,true);assert.equal(h.H.current.metadata.cover,'cover-new.png');
});
test('queued saves use the latest visible content and the returned revision',async()=>{
  const h=harness(),first=h.wp();await tick();h.setText('安装');const second=h.wp();await tick();assert.equal(h.requests.length,1);h.resolve();await first;await tick();assert.equal(h.requests.length,2);assert.equal(h.requests[1].body.content,'安装');assert.equal(h.requests[1].body.revision,'r1');h.resolve(1);assert.ok(await second);assert.equal(h.H.dirty,false);
});
test('a response for a closed or switched draft cannot replace the current record',async()=>{
  const h=harness(),saving=h.wp();await tick();const other={id:'b',revision:'rb',metadata:{title:'B'}};h.H.current=other;h.setText('另一篇');h.resolve();assert.equal(await saving,null);assert.equal(h.H.current,other);assert.equal(h.H.dirty,true);
});
test('failure keeps edits and does not poison a later save',async()=>{
  const h=harness(),first=h.wp();await tick();h.requests[0].reject(new Error('offline'));assert.equal(await first,null);assert.equal(h.H.dirty,true);const retry=h.wp();await tick();h.resolve(1);assert.ok(await retry);assert.equal(h.H.dirty,false);
});
