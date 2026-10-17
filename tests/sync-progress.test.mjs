import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
let syncProgressMarkup,connectSyncProgress;
try {({syncProgressMarkup,connectSyncProgress}=await import('../frontend/sync-progress.mjs'));}
catch(error) {if(error.code!=='ERR_MODULE_NOT_FOUND'||!error.message.includes('sync-progress.mjs'))throw error;}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const job=(id='job-one',state='running',extra={})=>({id,draft_id:'draft-a',account_id:'account-a',state,stage:'images',progress:{completed:3,total:15},error:null,result:null,...extra});

function harness() {
  assert.equal(typeof syncProgressMarkup,'function','sync progress implementation is missing');
  const {document}=parseHTML(`<html><body>${syncProgressMarkup()}</body></html>`);
  for(const dialog of document.querySelectorAll('dialog')) {dialog.showModal=()=>dialog.setAttribute('open','');dialog.close=()=>{dialog.removeAttribute('open');dialog.dispatchEvent(new document.defaultView.Event('close'));};}
  let time=0,next=0,draftId='draft-a',accountId='account-a';
  const requests=[],completed=[],choices=[],toasts=[],timers=new Map();
  const request=(url,options={})=>new Promise((resolve,reject)=>requests.push({url,options,resolve,reject}));
  const controller=connectSyncProgress(document,{
    request,getDraftId:()=>draftId,getAccountId:()=>accountId,onCompleted:value=>completed.push(value),
    onSyncWithChoice:value=>choices.push(value),toast:(...args)=>toasts.push(args),
    setTimer(fn,delay){const id=++next;timers.set(id,{fn,at:time+delay});return id;},clearTimer:id=>timers.delete(id),
  });
  const query=selector=>document.querySelector(selector);
  const event=(node,type)=>node.dispatchEvent(new document.defaultView.Event(type,{bubbles:true}));
  return {document,controller,requests,completed,choices,toasts,timers,query,event,
    click:selector=>{const node=query(selector);assert.ok(node,`Missing ${selector}`);event(node,'click');},
    switchDraft:(id,account=accountId)=>{draftId=id;accountId=account;},
    async advance(duration){const until=time+duration;while(true){const found=[...timers].filter(([,value])=>value.at<=until).sort((a,b)=>a[1].at-b[1].at)[0];if(!found)break;time=found[1].at;timers.delete(found[0]);found[1].fn();await tick();}time=until;await tick();},
    async resolve(index,value){requests[index].resolve(value);await tick();},
  };
}

test('active jobs show exact stage progress and only server success completes the watched snapshot',async()=>{
  const h=harness();h.controller.watch(job());assert.match(h.query('#syncJobDetail').textContent,/3\s*\/\s*15/);
  assert.equal(h.completed.length,0);await h.advance(999);assert.equal(h.requests.length,0);
  await h.advance(1);assert.equal(h.requests[0].url,'/api/editor/sync-jobs/job-one');
  await h.resolve(0,job('job-one','succeeded',{stage:'verify',result:{verified:true}}));
  assert.equal(h.completed.length,1);assert.equal(h.completed[0].id,'job-one');assert.equal(h.timers.size,0);
  h.controller.watch(job('job-one','succeeded'));assert.equal(h.completed.length,1);
});

test('closing the dialog still observes an active job once and then retires polling',async()=>{
  const h=harness();h.controller.watch(job());h.click('#closeSyncJobs');assert.equal(h.query('#syncJobsDialog').hasAttribute('open'),false);
  await h.advance(1000);await h.resolve(0,job('job-one','succeeded',{result:{verified:true}}));
  assert.equal(h.completed.length,1);assert.equal(h.timers.size,0);
});

test('a stale poll response cannot replace the job selected later',async()=>{
  const h=harness();h.controller.watch(job('job-old'));await h.advance(1000);h.controller.watch(job('job-new'));
  await h.resolve(0,job('job-old','succeeded'));assert.equal(h.completed.length,0);
  assert.match(h.query('#syncJobDetail').textContent,/job-new/);await h.advance(1000);
  assert.equal(h.requests[1].url,'/api/editor/sync-jobs/job-new');
});

test('destroy cancels timers and ignores an outstanding response and all later UI events',async()=>{
  const h=harness();h.controller.watch(job());await h.advance(1000);h.controller.destroy();
  await h.resolve(0,job('job-one','succeeded'));assert.equal(h.completed.length,0);assert.equal(h.timers.size,0);
  h.click('#openSyncJobs');await tick();assert.equal(h.requests.length,1);
});

test('opening history escapes server strings and ignores a response for a switched draft',async()=>{
  const h=harness(),opening=h.controller.open();await tick();assert.equal(h.requests[0].url,'/api/editor/sync-jobs?draft_id=draft-a');
  h.switchDraft('draft-b');await h.resolve(0,{items:[job('job-old','failed',{error:{message:'<img src=x onerror=evil()>'}})]});await opening;
  assert.ok(!h.query('#syncJobList').textContent.includes('job-old'));
  const current=h.controller.open();await tick();await h.resolve(1,{items:[job('job-safe','failed',{draft_id:'draft-b',error:{message:'<img src=x onerror=evil()>'}})]});await current;
  assert.ok(h.query('#syncJobList').textContent.includes('<img src=x onerror=evil()>'));assert.equal(h.query('#syncJobList img'),null);
});

test('failed and interrupted tasks retry only after an explicit click with the original snapshot warning',async()=>{
  for(const state of ['failed','interrupted']) {
  const h=harness();h.controller.watch(job('job-one',state));
  assert.match(h.query('#syncJobDetail').textContent,/原始快照/);await h.advance(5000);assert.equal(h.requests.length,0);
  h.click('[data-sync-action="retry"]');await tick();assert.equal(h.requests[0].url,'/api/editor/sync-jobs/job-one/retry');
  assert.equal(h.requests[0].options.method,'POST');assert.deepEqual(JSON.parse(h.requests[0].options.body),{});
  await h.resolve(0,{job:job('job-one','queued')});assert.equal(h.completed.length,0);assert.equal(h.timers.size,1);
  }
});

test('uncertain outcomes never auto-retry or create and manual resolution requires an explicit checkbox',async()=>{
  const h=harness();h.controller.watch(job('job-one','uncertain',{stage:'remote-write'}));await h.advance(10000);
  assert.equal(h.requests.length,0);assert.equal(h.query('[data-sync-action="retry"]'),null);
  assert.match(h.query('#syncJobDetail').textContent,/不要重建/);const link=h.query('[data-sync-backend-link]');assert.equal(link.getAttribute('href'),'https://mp.weixin.qq.com/');
  const resolve=h.query('[data-sync-action="resolve"]');assert.equal(resolve.disabled,true);
  h.click('[data-sync-action="resolve"]');await tick();assert.equal(h.requests.length,0);
  const checkbox=h.query('[data-sync-not-written]');checkbox.checked=true;h.event(checkbox,'change');h.click('[data-sync-action="resolve"]');await tick();
  assert.equal(h.requests[0].url,'/api/editor/sync-jobs/job-one/resolve');assert.deepEqual(JSON.parse(h.requests[0].options.body),{confirmed_not_written:true});
  await h.resolve(0,{job:job('job-one','failed')});assert.equal(h.requests.length,1);assert.ok(h.query('[data-sync-action="retry"]'));
});

test('verify is read-only server reconciliation and cannot report success from a boolean alone',async()=>{
  const h=harness();h.controller.watch(job('job-one','uncertain'));h.click('[data-sync-action="verify"]');await tick();
  assert.equal(h.requests[0].url,'/api/editor/sync-jobs/job-one/verify');
  await h.resolve(0,{job:job('job-one','uncertain'),verified:true});assert.equal(h.completed.length,0);
  assert.ok(h.query('[data-sync-not-written]'));assert.equal(h.requests.length,1);
});

test('remote comparison is read-only and explicit choices pass the server hash to a fresh sync callback',async()=>{
  const h=harness();h.controller.watch(job('job-one','failed',{error:{code:'remote-conflict',message:'Changed'}}));
  h.click('[data-sync-action="compare"]');await tick();assert.equal(h.requests[0].url,'/api/wechat/drafts/draft-a/remote-compare');assert.deepEqual(JSON.parse(h.requests[0].options.body),{account_id:'account-a'});
  await h.resolve(0,{changed:true,current_hash:'a'.repeat(64),fields:['articles.0.blocks'],baseline:{articles:[{title:'Old',blocks:[{type:'code',text:'<script>old</script>'}],images:['https://x.invalid/old.png']}]},current:{articles:[{title:'New',blocks:[{type:'paragraph',text:'<img src=x onerror=evil()>'}],images:['https://x.invalid/new.png']}]}});
  assert.match(h.query('[data-sync-comparison]').textContent,/https:\/\/x.invalid\/new.png/);assert.equal(h.query('[data-sync-comparison] script'),null);assert.equal(h.query('[data-sync-comparison] img'),null);
  h.click('[data-sync-action="overwrite"]');await tick();assert.deepEqual(h.choices,[{remote_action:'overwrite',expected_remote_hash:'a'.repeat(64)}]);
  assert.equal(h.requests.length,1);
});

test('keeping remote closes comparison without issuing an update or triggering another sync',async()=>{
  const h=harness();h.controller.watch(job('job-one','failed',{error:{code:'remote-conflict'}}));h.click('[data-sync-action="compare"]');await tick();
  await h.resolve(0,{current_hash:'b'.repeat(64),baseline:null,current:{articles:[]}});h.click('[data-sync-action="keep-remote"]');
  assert.equal(h.choices.length,0);assert.equal(h.requests.length,1);assert.equal(h.query('#syncJobsDialog').hasAttribute('open'),false);
});

test('switching draft during remote comparison prevents an old hash being applied to a new article',async()=>{
  const h=harness();h.controller.watch(job('job-one','failed',{error:{code:'remote-conflict'}}));h.click('[data-sync-action="compare"]');await tick();
  h.switchDraft('draft-b');await h.resolve(0,{current_hash:'a'.repeat(64),baseline:null,current:{articles:[]}});
  assert.equal(h.query('[data-sync-action="overwrite"]'),null);assert.equal(h.choices.length,0);
});

test('poll errors remain status errors without fabricating failure or triggering uploads',async()=>{
  const h=harness();h.controller.watch(job());await h.advance(1000);h.requests[0].reject(Error('offline'));await tick();
  assert.match(h.query('#syncJobsMessage').textContent,/offline/);assert.equal(h.completed.length,0);assert.equal(h.query('[data-sync-action="retry"]'),null);
  await h.advance(1000);assert.equal(h.requests.length,2);assert.equal(h.requests[1].options.method,undefined);
});

test('an older list response cannot replace the job list after a new job is watched',async()=>{
  const h=harness(),opening=h.controller.open();await tick();h.controller.watch(job('job-new'));
  await h.resolve(0,{items:[job('job-old','failed')]});await opening;
  assert.match(h.query('#syncJobList').textContent,/job-new/);assert.ok(!h.query('#syncJobList').textContent.includes('job-old'));
});

test('copy choice is explicit and a duplicate click cannot start a second fresh sync',async()=>{
  const h=harness();h.controller.watch(job('job-one','failed',{error:{code:'remote-conflict'}}));h.click('[data-sync-action="compare"]');await tick();
  await h.resolve(0,{current_hash:'c'.repeat(64),baseline:null,current:{articles:[]}});
  h.click('[data-sync-action="copy"]');h.click('[data-sync-action="copy"]');await tick();
  assert.deepEqual(h.choices,[{remote_action:'copy',expected_remote_hash:'c'.repeat(64)}]);assert.equal(h.requests.length,1);
});

test('uncertain create offers explicit recent draft lookup and projects only safe candidate text',async()=>{
  const h=harness();h.controller.watch(job('job-one','uncertain',{stage:'remote-write',progress:{operation:'create'}}));
  await h.advance(10000);assert.equal(h.requests.length,0);
  h.click('[data-sync-action="candidates"]');await tick();
  assert.equal(h.requests[0].url,'/api/editor/sync-jobs/job-one/candidates');
  assert.deepEqual(JSON.parse(h.requests[0].options.body),{});
  await h.resolve(0,{items:[{media_id:'media-match',title:'<img src=x onerror=evil()>',update_time:1234,matches_snapshot:true,content:'SYNTHETIC_FULL_HTML_SECRET',access_token:'SYNTHETIC_TOKEN'},{media_id:'media-other',title:'Other draft',update_time:2345,matches_snapshot:false}]});
  const candidates=h.query('[data-sync-candidates]');assert.ok(candidates);
  assert.match(candidates.textContent,/<img/);assert.equal(candidates.querySelector('img'),null);
  assert.equal(candidates.textContent.includes('SYNTHETIC_'),false);
  assert.equal(h.query('[data-sync-media-id="media-other"]').disabled,true);
  assert.equal(h.completed.length,0);assert.equal(h.requests.length,1);
});

test('matching candidate adoption requires a separate explicit verify and only server success completes it',async()=>{
  const h=harness();h.controller.watch(job('job-one','uncertain'));
  h.click('[data-sync-action="candidates"]');await tick();
  await h.resolve(0,{items:[{media_id:'media-match',title:'Match',matches_snapshot:true}]});
  assert.equal(h.completed.length,0);h.click('[data-sync-media-id="media-match"]');await tick();
  assert.equal(h.requests[1].url,'/api/editor/sync-jobs/job-one/verify');
  assert.deepEqual(JSON.parse(h.requests[1].options.body),{media_id:'media-match'});
  await h.resolve(1,{job:job('job-one','uncertain'),verified:true});assert.equal(h.completed.length,0);
  h.click('[data-sync-media-id="media-match"]');await tick();
  await h.resolve(2,{job:job('job-one','succeeded',{stage:'verify',result:{verified:true}})});
  assert.equal(h.completed.length,1);assert.equal(h.query('[data-sync-candidates]'),null);
});

test('mismatching candidates and nonboolean matches cannot be adopted even if DOM button is enabled',async()=>{
  const h=harness();h.controller.watch(job('job-one','uncertain'));
  h.click('[data-sync-action="candidates"]');await tick();
  await h.resolve(0,{items:[{media_id:'media-other',title:'Other',matches_snapshot:false},{media_id:'media-string',title:'String',matches_snapshot:'true'}]});
  for(const id of ['media-other','media-string']) {
    const node=h.query(`[data-sync-media-id="${id}"]`);assert.equal(node.disabled,true);
    node.disabled=false;h.event(node,'click');await tick();
  }
  assert.equal(h.requests.length,1);assert.equal(h.completed.length,0);
});

test('candidate lookup is bounded and does not auto-verify even with an optional succeeded job response',async()=>{
  const h=harness();h.controller.watch(job('job-one','uncertain'));
  h.click('[data-sync-action="candidates"]');await tick();
  await h.resolve(0,{job:job('job-one','succeeded'),items:Array.from({length:30},(_,index)=>({media_id:'media-'+index,title:'Candidate '+index,matches_snapshot:true}))});
  assert.equal(h.query('[data-sync-candidates]').querySelectorAll('[data-sync-action="adopt"]').length,20);
  assert.equal(h.completed.length,0);assert.equal(h.requests.length,1);
});

test('manual known media ID outside recent drafts requires explicit verification and is never rendered as HTML',async()=>{
  const h=harness();h.controller.watch(job('job-one','uncertain'));
  const input=h.query('[data-sync-known-media-id]');assert.ok(input);
  input.value=' manual-known ';h.event(input,'input');
  h.click('[data-sync-action="verify-manual"]');await tick();
  assert.equal(h.requests[0].url,'/api/editor/sync-jobs/job-one/verify');
  assert.deepEqual(JSON.parse(h.requests[0].options.body),{media_id:'manual-known'});
  await h.resolve(0,{job:job('job-one','uncertain')});assert.equal(h.completed.length,0);
  h.query('[data-sync-known-media-id]').value='<img src=x>';
  h.click('[data-sync-action="verify-manual"]');await tick();assert.equal(h.requests.length,1);
  h.query('[data-sync-known-media-id]').value='x'.repeat(257);
  h.click('[data-sync-action="verify-manual"]');await tick();assert.equal(h.requests.length,1);
});

test('lookup and verify actions do not overlap and ignore old job or destroyed responses',async()=>{
  const h=harness();h.controller.watch(job('job-one','uncertain'));
  h.click('[data-sync-action="candidates"]');h.click('[data-sync-action="candidates"]');await tick();assert.equal(h.requests.length,1);
  h.controller.watch(job('job-new','uncertain'));
  await h.resolve(0,{items:[{media_id:'old-match',title:'Old',matches_snapshot:true}]});
  assert.equal(h.query('[data-sync-candidates]'),null);assert.equal(h.completed.length,0);
  h.click('[data-sync-action="candidates"]');await tick();h.controller.destroy();
  await h.resolve(1,{items:[{media_id:'late-match',title:'Late',matches_snapshot:true}]});
  assert.equal(h.query('[data-sync-candidates]'),null);assert.equal(h.completed.length,0);
});

test('candidate lookup and adoption are bound to the selected draft and account before and after network requests',async()=>{
  const h=harness();h.controller.watch(job('job-one','uncertain'));
  h.switchDraft('draft-a','account-b');h.click('[data-sync-action="candidates"]');await tick();assert.equal(h.requests.length,0);
  h.switchDraft('draft-a','account-a');h.click('[data-sync-action="candidates"]');await tick();
  h.switchDraft('draft-b');await h.resolve(0,{items:[{media_id:'old',title:'Old',matches_snapshot:true}]});
  assert.equal(h.query('[data-sync-candidates]'),null);
  h.switchDraft('draft-a','account-a');h.click('[data-sync-action="candidates"]');await tick();
  await h.resolve(1,{items:[{media_id:'match',title:'Match',matches_snapshot:true}]});
  h.click('[data-sync-media-id="match"]');await tick();h.switchDraft('draft-b');
  await h.resolve(2,{job:job('job-one','succeeded',{result:{verified:true}})});
  assert.equal(h.completed.length,0);
});

test('candidate errors and empty results remain uncertain without retries or completion',async()=>{
  const h=harness();h.controller.watch(job('job-one','uncertain'));
  h.click('[data-sync-action="candidates"]');await tick();h.requests[0].reject(new Error('read failed'));await tick();
  assert.equal(h.completed.length,0);assert.match(h.query('#syncJobsMessage').textContent,/read failed/);
  h.click('[data-sync-action="candidates"]');await tick();await h.resolve(1,{items:[]});
  assert.match(h.query('[data-sync-candidates]').textContent,/未找到|没有/);await h.advance(10000);
  assert.equal(h.requests.length,2);assert.equal(h.completed.length,0);
});
