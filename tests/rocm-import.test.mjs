import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {rocmImportMarkup,connectRocmImport,normalizeRocmUrl} from '../frontend/rocm-import.mjs';

test('the blog importer accepts only official HTTPS article addresses',()=>{
  assert.equal(normalizeRocmUrl(' https://rocm.blogs.amd.com/tools/demo/README.html#intro '),'https://rocm.blogs.amd.com/tools/demo/README.html');
  for(const url of ['http://rocm.blogs.amd.com/a','https://rocm.blogs.amd.com.evil.example/a','https://user:pass@rocm.blogs.amd.com/a','https://rocm.blogs.amd.com:8080/a','https://127.0.0.1/a']) assert.throws(()=>normalizeRocmUrl(url));
});

function fixture(request){
  const {document}=parseHTML(`<main>${rocmImportMarkup()}</main>`);
  const dialog=document.querySelector('#rocmImportDialog');
  dialog.showModal=()=>dialog.setAttribute('open','');
  dialog.close=()=>dialog.removeAttribute('open');
  const order=[];
  const controls=connectRocmImport(document,{
    request:async(...args)=>{order.push('request');return request(...args);},
    beforeImport:async()=>order.push('save'),
    onImported:async draft=>order.push(draft.id),
  });
  document.querySelector('#rocmBlogUrl').value='https://rocm.blogs.amd.com/tools/demo/README.html';
  return {document,dialog,order,controls};
}

test('import saves existing edits first, creates a new draft and opens it only on success',async()=>{
  const f=fixture(async(path,options)=>{assert.equal(path,'/api/editor/import-rocm');assert.equal(options.method,'POST');return {draft:{id:'new-draft'}};});
  f.controls.open();
  await f.controls.submit();
  assert.deepEqual(f.order,['save','request','new-draft']);
  assert.equal(f.dialog.hasAttribute('open'),false);
  assert.equal(f.document.querySelector('#confirmRocmImport').disabled,false);
});

test('import errors remain visible and allow retry without switching the current article',async()=>{
  const f=fixture(async()=>{throw new Error('图片下载失败');});
  f.controls.open();await f.controls.submit();
  assert.deepEqual(f.order,['save','request']);
  assert.equal(f.dialog.hasAttribute('open'),true);
  assert.equal(f.document.querySelector('#rocmImportError').textContent,'图片下载失败');
  assert.equal(f.document.querySelector('#rocmImportError').hidden,false);
  assert.equal(f.document.querySelector('#confirmRocmImport').disabled,false);
});

test('concurrent submit cannot create duplicate drafts',async()=>{
  let finish;const f=fixture(()=>new Promise(resolve=>{finish=resolve;}));
  const first=f.controls.submit();await Promise.resolve();await Promise.resolve();
  await f.controls.submit();finish({draft:{id:'once'}});await first;
  assert.deepEqual(f.order,['save','request','once']);
});

test('retry after an article-switch error opens the existing imported draft instead of importing twice',async()=>{
  const f=fixture(async()=>({draft:{id:'already-created'}}));
  let opens=0,requests=0;
  const controls=connectRocmImport(f.document,{
    request:async()=>{requests++;return {draft:{id:'already-created'}};},
    onImported:async()=>{if(++opens===1)throw new Error('列表暂不可用');},
  });
  await controls.submit();await controls.submit();
  assert.equal(requests,1);assert.equal(opens,2);
});
