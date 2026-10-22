import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {workflowMarkup,connectWorkflowUI} from '../frontend/workflow-ui.mjs';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};

test('account and cover blockers offer direct navigation to their editable controls',async()=>{
 const h=harness(),selected=[];h.a.selectIssue=issue=>selected.push(issue.field);
 const w=connectWorkflowUI(h.document,h.a);await w.showReport({fingerprint:'a',issues:[{id:'account',field:'account',severity:'blocker',message:'Choose account'},{id:'cover',field:'cover',severity:'blocker',message:'Choose cover'}]});
 const actions=[...h.document.querySelectorAll('#workflowBody button')];assert.equal(actions.length,2);
 actions.forEach(h.click);await tick();assert.deepEqual(selected,['account','cover']);w.destroy();
});

function harness(){
 const {document}=parseHTML('<html><body>'+workflowMarkup()+'</body></html>');
 for(const d of document.querySelectorAll('dialog')){d.showModal=()=>d.setAttribute('open','');d.close=()=>d.removeAttribute('open');}
 const draft={id:'draft-test',content:'# Text',revision:'r1',metadata:{title:'Text',wechat_account_id:'account-test'}};
 const requests=[];
 const a={request:async(url,p)=>{requests.push({url,p});return{items:[]}},getDraft:()=>draft,getContent:()=>draft.content,getMetadata:()=>draft.metadata,getAssets:()=>[],getHtml:()=>'<p>Text</p>',getRenderVersion:()=>'render-v1',recovery:{list:async()=>[],read:async()=>null},toast:()=>{},beforeImport:async()=>{},onImported:async()=>{}};
 const event=(node,type)=>node.dispatchEvent(new document.defaultView.Event(type,{bubbles:true}));
 return {document,requests,a,draft,event,click:node=>event(node,'click')};
}
test('workflow renders unsafe names as text in history and keeps recovery tools independent of a draft',async()=>{
 const h=harness();h.a.getDraft=()=>null;h.a.recovery.list=async()=>[{id:'r',metadata:{title:'<img src=x onerror=alert(1)>'},updatedAt:0}];
 const w=connectWorkflowUI(h.document,h.a);await w.open('recovery');
 assert.equal(h.document.querySelectorAll('#workflowBody img').length,0);
 assert.match(h.document.querySelector('#workflowBody').textContent,/<img src=x/);
 w.destroy();
});

test('manual preflight saves once before rendering and sends the captured saved account and renderer',async()=>{
 const h=harness(),gate=deferred(),order=[];h.a.beforeImport=async()=>{order.push('save');await gate.promise;h.draft.revision='r2';};
 h.a.getHtml=()=>{order.push('render');return '<h1>Text</h1>';};h.a.request=async(url,p)=>{order.push('request');h.requests.push({url,p});return {fingerprint:'a'.repeat(64),issues:[]};};
 const w=connectWorkflowUI(h.document,h.a),opened=w.open('preflight');await tick();assert.deepEqual(order,['save']);
 gate.resolve();await opened;assert.deepEqual(order,['save','render','request']);
 assert.deepEqual(JSON.parse(h.requests[0].p.body),{html:'<h1>Text</h1>',render_version:'render-v1',account_id:'account-test'});w.destroy();
});

test('a failed save stops manual preflight before HTML generation or server requests',async()=>{
 const h=harness();let rendered=false;h.a.beforeImport=async()=>{throw Error('save is offline');};h.a.getHtml=()=>{rendered=true;return '';};
 const w=connectWorkflowUI(h.document,h.a);await w.open('preflight');assert.equal(rendered,false);assert.equal(h.requests.length,0);
 assert.equal(h.document.querySelector('#workflowRecheck').disabled,true);assert.match(h.document.querySelector('#workflowMessage').textContent,/save is offline/);w.destroy();
});

test('input changed while rendering cannot produce a server preflight or an acceptable report',async()=>{
 const h=harness(),gate=deferred();h.a.getHtml=()=>gate.promise;const w=connectWorkflowUI(h.document,h.a),opening=w.open('preflight');await tick();
 h.draft.content='# New input';gate.resolve('<h1>Text</h1>');await opening;
 assert.equal(h.requests.length,0);assert.equal(h.document.querySelector('#workflowRecheck').disabled,true);assert.match(h.document.querySelector('#workflowMessage').textContent,/变化|重新/);w.destroy();
});

test('draft metadata account revision and renderer changes during the server request invalidate the response',async()=>{
 for(const change of [h=>h.draft.metadata.title='Changed',h=>h.draft.metadata.wechat_account_id='account-other',h=>h.draft.revision='r2',h=>h.a.getRenderVersion=()=>'render-v2',h=>h.draft.id='draft-other']) {
  const h=harness(),gate=deferred();h.a.request=()=>gate.promise;const w=connectWorkflowUI(h.document,h.a),opening=w.open('preflight');await tick();change(h);gate.resolve({fingerprint:'a'.repeat(64),issues:[]});await opening;
  assert.equal(h.document.querySelector('#workflowRecheck').disabled,true);assert.match(h.document.querySelector('#workflowMessage').textContent,/变化|切换|重新/);w.destroy();
 }
});

test('sync continues automatically with local and legacy server advice without a report modal or acknowledgement',{timeout:3000},async()=>{
 const h=harness();let saves=0;h.a.beforeImport=async()=>{saves++;};h.a.request=async()=>({fingerprint:'a'.repeat(64),issues:[{id:'server-source',code:'source-empty',field:'source_url',severity:'confirm',message:'Server review'}]});
 h.a.storage={getItem:()=>{throw Error('advice must not wait for preference storage');}};
 const w=connectWorkflowUI(h.document,h.a),result=await w.prepareSync();
 assert.equal(h.document.querySelector('#workflowDialog').hasAttribute('open'),false);assert.equal(h.document.querySelectorAll('[data-ack]').length,0);assert.equal(saves,1);
 assert.deepEqual(result.acknowledged,[]);assert.equal(result.fingerprint,'a'.repeat(64));assert.equal(result.html,'<p>Text</p>');w.destroy();
});

test('sync shows actual blockers and does not return an upload payload',{timeout:3000},async()=>{
 const h=harness();h.a.request=async()=>({fingerprint:'a'.repeat(64),issues:[{id:'missing-cover',field:'cover',severity:'blocker',message:'Missing cover'}]});
 const w=connectWorkflowUI(h.document,h.a),result=await w.prepareSync();
 assert.equal(result,null);assert.equal(h.document.querySelector('#workflowDialog').hasAttribute('open'),true);assert.match(h.document.querySelector('#workflowBody').textContent,/Missing cover/);w.destroy();
});

test('switching panes cancels a late automatic sync preflight',async()=>{
 const h=harness(),gate=deferred();h.a.request=()=>gate.promise;
 const w=connectWorkflowUI(h.document,h.a),pending=w.prepareSync();await tick();await w.open('recovery');gate.resolve({fingerprint:'a'.repeat(64),issues:[]});
 assert.equal(await pending,null);assert.match(h.document.querySelector('#workflowTitle').textContent,/自动恢复/);w.destroy();
});

test('input changed during automatic sync validation cannot return a stale upload payload',{timeout:3000},async()=>{
 const h=harness(),gate=deferred();h.a.request=()=>gate.promise;
 const w=connectWorkflowUI(h.document,h.a),pending=w.prepareSync();await tick();h.draft.content='# New input';gate.resolve({fingerprint:'a'.repeat(64),issues:[]});
 await assert.rejects(pending,/变化|重新/);w.destroy();
});

test('automatic sync fails closed when server validation is unavailable or lacks a fingerprint',async()=>{
 for(const request of [async()=>{throw Error('offline');},async()=>({issues:[]})]) {
  const h=harness();h.a.request=request;const w=connectWorkflowUI(h.document,h.a);
  assert.equal(await w.prepareSync(),null);assert.equal(h.document.querySelector('#workflowDialog').hasAttribute('open'),true);assert.ok(h.document.querySelector('.workflow-issue.blocker'));w.destroy();
 }
});

test('conflict copy uses its own captured input and callback while duplicate clicks cannot create two copies',{timeout:3000},async()=>{
 const h=harness(),gate=deferred(),copies=[],opened=[];h.a.onImported=async()=>{throw Error('generic import must not save the conflicted original');};
 h.a.onConflictCopy=async(draft,local)=>opened.push({draft,local});
 h.a.request=async(url,p={})=>{if(url.endsWith('/copy')){copies.push({url,p});return gate.promise;}return {content:'Saved original'};};
 const w=connectWorkflowUI(h.document,h.a),original={id:'draft-test',content:'Original captured input',metadata:{title:'Original'}};
 w.conflictSave({status:409},original);const button=h.document.querySelector('#saveConflictCopy');h.click(button);h.click(button);await tick();
 assert.equal(copies.length,1);assert.equal(button.disabled,true);w.conflictSave({status:409},{id:'draft-other',content:'New conflict',metadata:{title:'New'}});
 gate.resolve({draft:{id:'draft-copy',content:original.content,metadata:original.metadata}});await tick();
 assert.equal(opened.length,1);assert.equal(opened[0].local,original);assert.equal(opened[0].draft.id,'draft-copy');assert.equal(button.disabled,false);w.destroy();
});

test('manual preflight uses the existing author ignored-word preference',async()=>{
 const h=harness();h.draft.content='# Text\n\n按装方式';h.draft.metadata.source_url='https://example.invalid/source';h.a.ignoredWords=()=>['按装'];h.a.getHtml=()=>'<h1>Text</h1><p>按装方式</p>';h.a.request=async()=>({fingerprint:'a'.repeat(64),issues:[]});
 const w=connectWorkflowUI(h.document,h.a);await w.open('preflight');assert.equal(h.document.querySelectorAll('.workflow-issue').length,0);w.destroy();
});

test('permanent trash cleanup requires an irreversible confirmation and the exact trash id before DELETE',async()=>{
 const h=harness(),trash={trash_id:'trash-safe',draft_id:'draft-old',title:'<img src=x onerror=evil()>',deleted_at:'2026-10-18'},calls=[],prompts=[];let removed=false,confirmed=false;
 h.a.request=async(url,p={})=>{calls.push({url,p});if(p.method==='DELETE'){removed=true;return {};}return {items:removed?[]:[trash]};};
 h.a.confirmPermanent=async(message,record)=>{prompts.push({message,record});return confirmed;};
 const w=connectWorkflowUI(h.document,h.a);await w.open('trash');const cleanup=()=>[...h.document.querySelectorAll('#workflowBody button')].find(node=>node.textContent.includes('永久清理'));
 assert.ok(cleanup());assert.equal(h.document.querySelectorAll('#workflowBody img').length,0);h.click(cleanup());await tick();assert.equal(calls.filter(call=>call.p.method==='DELETE').length,0);
 confirmed=true;h.click(cleanup());await tick();await tick();const deletion=calls.find(call=>call.p.method==='DELETE');assert.equal(deletion.url,'/api/editor/trash/trash-safe');assert.deepEqual(JSON.parse(deletion.p.body),{confirmation:'trash-safe'});
 assert.match(prompts[1].message,/不可恢复/);assert.match(prompts[1].message,/原图|图片原件/);assert.equal(prompts[1].record.trash_id,'trash-safe');assert.match(h.document.querySelector('#workflowBody').textContent,/回收站为空/);w.destroy();
});
test('manual preflight separates blockers from optional advice and has no author confirmation gate',async()=>{
 const h=harness();const w=connectWorkflowUI(h.document,h.a);
 w.showReport({fingerprint:'a',issues:[{id:'broken',severity:'blocker',field:'content',message:'缺图'}]});
 assert.equal(h.document.querySelectorAll('.workflow-issue.blocker').length,1);
 w.showReport({fingerprint:'b',issues:[{id:'review',severity:'confirm',field:'content',message:'核对来源'}]});
 assert.equal(h.document.querySelectorAll('[data-ack]').length,0);
 assert.equal(h.document.querySelectorAll('.workflow-issue.info').length,1);
 assert.match(h.document.querySelector('#workflowBody').textContent,/建议/);
 assert.match(h.document.querySelector('#workflowMessage').textContent,/不影响同步/);
 w.destroy();
});
