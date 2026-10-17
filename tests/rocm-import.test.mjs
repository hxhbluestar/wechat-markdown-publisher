import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {rocmImportMarkup,connectRocmImport,normalizeRocmUrl} from '../frontend/rocm-import.mjs';

const URL='https://rocm.blogs.amd.com/tools/demo/README.html';
const preview=(duplicates=[])=>({title:'Synthetic ROCm article',duplicates,preview_content:'# Synthetic\n\n```bash\necho "<safe>"\n```',report:{before:{images:15,fences:6,tables:1},after:{images:15,fences:6,tables:1},asset_count:14,warnings:['检查原文排版'],conversions:['已保存本地图片']}});

test('the blog importer accepts only official HTTPS article addresses',()=>{
  assert.equal(normalizeRocmUrl(' '+URL+'#intro '),URL);
  for(const url of ['http://rocm.blogs.amd.com/a','https://rocm.blogs.amd.com.evil.example/a','https://user:pass@rocm.blogs.amd.com/a','https://rocm.blogs.amd.com:8080/a','https://127.0.0.1/a','https://rocm.blogs.amd.com/','https://rocm.blogs.amd.com/tools/index.html','https://rocm.blogs.amd.com/a\n.html']) assert.throws(()=>normalizeRocmUrl(url));
});

function fixture(request,adapters={}){
  const {document}=parseHTML(`<main><textarea id="currentArticle">Keep existing edits.</textarea>${rocmImportMarkup()}</main>`);
  const dialog=document.querySelector('#rocmImportDialog');
  dialog.showModal=()=>dialog.setAttribute('open','');
  dialog.close=()=>dialog.removeAttribute('open');
  const order=[];
  const controls=connectRocmImport(document,{
    request:async(path,options)=>{order.push(JSON.parse(options.body).preview_only?'preview':'create');return request(path,options);},
    beforeImport:async()=>order.push('save'),
    onImported:async draft=>order.push(draft.id),...adapters,
  });
  document.querySelector('#rocmBlogUrl').value=URL;
  return {document,dialog,order,controls};
}

test('preview is read-only; explicit second submit saves edits and creates a new draft',async()=>{
  const f=fixture(async(path,options)=>{assert.equal(path,'/api/editor/import-rocm');assert.equal(options.method,'POST');return JSON.parse(options.body).preview_only?preview():{draft:{id:'new-draft'}};});
  f.controls.open();await f.controls.submit();
  assert.deepEqual(f.order,['preview']);
  assert.equal(f.dialog.hasAttribute('open'),true);
  assert.equal(f.document.querySelector('#rocmImportReview').hidden,false);
  assert.match(f.document.querySelector('#rocmImportCounts').textContent,/15/);
  assert.match(f.document.querySelector('#rocmImportDetails').textContent,/检查原文/);
  assert.equal(f.document.querySelector('#rocmImportPreview').value,preview().preview_content);
  await f.controls.submit();
  assert.deepEqual(f.order,['preview','save','create','new-draft']);
  assert.equal(f.document.querySelector('#currentArticle').value,'Keep existing edits.');
  assert.equal(f.dialog.hasAttribute('open'),false);
});

test('preview errors remain visible and allow retry without switching or saving current article',async()=>{
  const f=fixture(async()=>{throw new Error('图片下载失败');});
  f.controls.open();await f.controls.submit();
  assert.deepEqual(f.order,['preview']);
  assert.equal(f.dialog.hasAttribute('open'),true);
  assert.equal(f.document.querySelector('#rocmImportError').textContent,'图片下载失败');
  assert.equal(f.document.querySelector('#confirmRocmImport').disabled,false);
});

test('duplicates require a separate explicit checkbox after showing title and quality report',async()=>{
  const f=fixture(async(path,options)=>{
    const payload=JSON.parse(options.body);
    if(payload.preview_only)return preview([{id:'old',title:'<img src=x onerror=evil()>'}]);
    assert.equal(payload.allow_duplicate,true);assert.equal(payload.preview_only,false);
    return {draft:{id:'new-copy'}};
  });
  await f.controls.submit();await f.controls.submit();
  assert.deepEqual(f.order,['preview']);
  assert.match(f.document.querySelector('#rocmImportError').textContent,/重复|副本/);
  assert.equal(f.document.querySelector('#rocmImportDuplicates img'),null);
  assert.match(f.document.querySelector('#rocmImportDuplicates').textContent,/<img/);
  f.document.querySelector('#allowRocmDuplicate').checked=true;await f.controls.submit();
  assert.deepEqual(f.order,['preview','save','create','new-copy']);
});

test('concurrent preview and concurrent confirmation cannot create duplicate drafts',async()=>{
  let finish;const f=fixture(()=>new Promise(resolve=>{finish=resolve;}));
  const first=f.controls.submit();await Promise.resolve();await Promise.resolve();
  await f.controls.submit();finish(preview());await first;
  const second=f.controls.submit();await Promise.resolve();await Promise.resolve();
  await f.controls.submit();finish({draft:{id:'once'}});await second;
  assert.deepEqual(f.order,['preview','save','create','once']);
});

test('retry after article-switch failure opens the already imported draft without importing again',async()=>{
  let opens=0,requests=0;
  const f=fixture(async(path,options)=>{requests++;return JSON.parse(options.body).preview_only?preview():{draft:{id:'already-created'}};}, {
    onImported:async()=>{if(++opens===1)throw new Error('列表暂不可用');},
  });
  await f.controls.submit();await f.controls.submit();
  assert.equal(f.document.querySelector('#rocmBlogUrl').disabled,true);
  assert.match(f.document.querySelector('#confirmRocmImport').textContent,/打开/);
  await f.controls.submit();assert.equal(requests,2);assert.equal(opens,2);
});

test('URL edits invalidate preview and duplicate consent; late preview cannot apply to another URL',async()=>{
  let finish;const f=fixture(()=>new Promise(resolve=>{finish=resolve;}));
  const pending=f.controls.submit();await Promise.resolve();
  const input=f.document.querySelector('#rocmBlogUrl');input.value='https://rocm.blogs.amd.com/tools/other/README.html';
  finish(preview([{id:'old',title:'Old title'}]));await pending;
  assert.equal(f.document.querySelector('#rocmImportReview').hidden,true);
  assert.deepEqual(f.order,['preview']);
  const next=f.controls.submit();await Promise.resolve();finish(preview());await next;
  input.value=URL;input.dispatchEvent(new f.document.defaultView.Event('input'));
  assert.equal(f.document.querySelector('#rocmImportReview').hidden,true);
  assert.equal(f.document.querySelector('#allowRocmDuplicate').checked,false);
});

test('cancelled pre-import save and failed create keep reviewed source and current edits',async()=>{
  let allow=false;
  const f=fixture(async(path,options)=>{if(JSON.parse(options.body).preview_only)return preview();throw new Error('保存失败');}, {beforeImport:async()=>allow});
  await f.controls.submit();await f.controls.submit();assert.deepEqual(f.order,['preview']);
  allow=true;await f.controls.submit();assert.deepEqual(f.order,['preview','create']);
  assert.equal(f.document.querySelector('#rocmImportReview').hidden,false);
  assert.equal(f.document.querySelector('#currentArticle').value,'Keep existing edits.');
});

test('preview content and quality strings remain inert text and incomplete preview never enables creation',async()=>{
  const payload=preview();payload.title='<script>unsafe()</script>';payload.report.warnings=['<img src=x onerror=unsafe()>'];
  const f=fixture(async()=>payload);await f.controls.submit();
  assert.equal(f.document.querySelector('#rocmImportReview script'),null);
  assert.equal(f.document.querySelector('#rocmImportReview img'),null);
  const invalid=fixture(async()=>({draft:{id:'unexpected-preview-create'}}));await invalid.controls.submit();
  assert.equal(invalid.document.querySelector('#rocmImportReview').hidden,true);
  assert.deepEqual(invalid.order,['preview']);
  assert.equal(invalid.document.querySelector('#rocmImportError').hidden,false);
});

test('a duplicate created after preview refreshes the confirmation choice without re-importing automatically',async()=>{
  let creates=0;
  const f=fixture(async(path,options)=>{
    const payload=JSON.parse(options.body);
    if(payload.preview_only)return preview();
    if(++creates===1) {
      const error=new Error('已有重复稿件');error.status=409;
      error.payload={duplicates:[{id:'late',title:'Late duplicate'}],report:preview().report};
      throw error;
    }
    assert.equal(payload.allow_duplicate,true);return {draft:{id:'confirmed-copy'}};
  });
  await f.controls.submit();await f.controls.submit();
  assert.equal(f.document.querySelector('#rocmDuplicateChoice').hidden,false);
  assert.equal(f.document.querySelector('#allowRocmDuplicate').checked,false);
  await f.controls.submit();assert.equal(creates,1);
  f.document.querySelector('#allowRocmDuplicate').checked=true;await f.controls.submit();
  assert.equal(creates,2);
});

test('an input event during asynchronous save cannot bypass a fresh preview even when URL is restored',async()=>{
  let saved;
  const save=new Promise(resolve=>{saved=resolve;});
  const f=fixture(async(path,options)=>JSON.parse(options.body).preview_only?preview():{draft:{id:'wrong'}},{beforeImport:()=>save});
  await f.controls.submit();const pending=f.controls.submit();await Promise.resolve();
  const input=f.document.querySelector('#rocmBlogUrl');
  input.dispatchEvent(new f.document.defaultView.Event('input'));
  saved(true);await pending;
  assert.deepEqual(f.order,['preview']);
  assert.equal(f.document.querySelector('#rocmImportReview').hidden,true);
});
