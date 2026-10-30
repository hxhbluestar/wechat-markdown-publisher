import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {buildFolderBundle,createFolderImporter,connectFolderFilePicker,chooseFolderEntry} from '../frontend/folder-import.mjs';

function file(path,content='data') {
  const f=new File([content],path.split('/').at(-1));
  Object.defineProperty(f,'webkitRelativePath',{value:path});
  return f;
}
const article=()=>[file('文章/main.md','# 标题\n\n![图](assets/图.png)'),file('文章/assets/图.png',new Uint8Array([137,80,78,71,0,255])),file('文章/assets/演示.mp4',new Uint8Array([0,1,2,3])),file('文章/assets/data/table.csv','a,b\n1,2'),file('文章/assets/图片来源说明.md','# 来源'),file('文章/编辑核查说明_不随正文发布.md','# 内部核查'),file('文章/阅读预览.html','<h1>preview</h1>')];
function readStoredZip(bytes) {
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),members=[];
  let offset=0;
  while(view.getUint32(offset,true)===0x04034b50) {
    assert.equal(view.getUint16(offset+6,true),0x800,'UTF-8 names');
    assert.equal(view.getUint16(offset+8,true),0,'stored method');
    const length=view.getUint32(offset+18,true),nameLength=view.getUint16(offset+26,true),extra=view.getUint16(offset+28,true);
    const name=new TextDecoder().decode(bytes.subarray(offset+30,offset+30+nameLength));
    const start=offset+30+nameLength+extra,data=bytes.slice(start,start+length);
    let crc=0xffffffff;
    for(const byte of data){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
    assert.equal(view.getUint32(offset+14,true),(crc^0xffffffff)>>>0,'CRC covers original bytes');
    members.push({name,data});offset=start+length;
  }
  assert.equal(view.getUint32(offset,true),0x02014b50,'central directory follows members');
  assert.equal(view.getUint32(bytes.length-22,true),0x06054b50,'end record');
  assert.equal(view.getUint16(bytes.length-12,true),members.length);
  return members;
}

test('folder bundles choose article rather than editorial notes and preserve every attachment byte',async()=>{
  const source=article(),bundle=await buildFolderBundle(source);
  assert.equal(bundle.entry,'main.md');assert.equal(bundle.folderName,'文章');
  assert.equal(bundle.attachmentCount,4);assert.equal(bundle.imageCount,1);assert.equal(bundle.videoCount,1);
  assert.equal(bundle.body.type,'application/zip');
  const members=readStoredZip(new Uint8Array(await bundle.body.arrayBuffer()));
  assert.deepEqual(members.map(v=>v.name),['main.md','assets/图.png','assets/演示.mp4','assets/data/table.csv','assets/图片来源说明.md']);
  for(const member of members)assert.deepEqual(member.data,new Uint8Array(await source.find(f=>f.webkitRelativePath==='文章/'+member.name).arrayBuffer()));
});

test('one file root works without assets, while multiple articles require a deliberate choice',async()=>{
  assert.equal((await buildFolderBundle([file('folder/ONE.MARKDOWN','# One')])).entry,'ONE.MARKDOWN');
  const source=[file('folder/a.md','# A'),file('folder/b.md','# B')];
  await assert.rejects(buildFolderBundle(source),error=>error.code==='choose-markdown'&&error.candidates.map(c=>c.path).join(',')==='a.md,b.md');
  const bundle=await buildFolderBundle(source,{entry:'b.md'});
  assert.deepEqual(readStoredZip(new Uint8Array(await bundle.body.arrayBuffer())).map(f=>f.name),['b.md']);
  await assert.rejects(buildFolderBundle(source,{entry:'missing.md'}),/正文/);
});

test('a unique article referencing existing assets can be distinguished from a README',async()=>{
  const bundle=await buildFolderBundle([file('folder/README.md','# 使用说明'),file('folder/article.md','# 正文\n![图片](assets/hello.png)'),file('folder/assets/hello.png','image')]);
  assert.equal(bundle.entry,'article.md');
});

test('invalid, mixed-root and case-colliding paths are refused before reading attachments',async()=>{
  for(const path of ['folder/../evil.md','/folder/main.md','folder/assets/../bad.png','folder/assets/COn.txt','folder/assets/a\\b.png','folder//main.md','folder/assets/evil:stream','folder/assets/%2e%2e/secret'])
    await assert.rejects(buildFolderBundle([file('folder/main.md','# 正文'),file(path)]),/路径|名称/);
  await assert.rejects(buildFolderBundle([file('a/main.md','# A'),file('b/assets/image.png')]),/同一个/);
  await assert.rejects(buildFolderBundle([file('a/main.md','# A'),file('a/assets/Image.png'),file('a/assets/image.png')]),/同名|重复/);
  await assert.rejects(buildFolderBundle([file('a/assets/image.png')]),/Markdown/);
  await assert.rejects(buildFolderBundle([]),/文件夹/);
});

test('folder budgets are enforced from declared sizes before reading large files',async()=>{
  const huge={name:'huge.mp4',webkitRelativePath:'folder/assets/huge.mp4',size:128*1024*1024+1,arrayBuffer(){throw new Error('must not read');}};
  await assert.rejects(buildFolderBundle([file('folder/main.md','# A'),huge]),/128/);
  const hugeText={...huge,name:'main.md',webkitRelativePath:'folder/main.md',size:6*1024*1024+1};
  await assert.rejects(buildFolderBundle([hugeText]),/6/);
  const many=Array.from({length:513},(_,i)=>file('folder/assets/'+i+'.txt'));
  await assert.rejects(buildFolderBundle([file('folder/main.md','# A'),...many]),/512/);
  const one={...huge,size:128*1024*1024},two={...one,name:'two.mp4',webkitRelativePath:'folder/assets/two.mp4'};
  await assert.rejects(buildFolderBundle([file('folder/main.md','# A'),one,two]),/256/);
});

test('changed byte length and unreadable Markdown abort package construction',async()=>{
  await assert.rejects(buildFolderBundle([{name:'main.md',webkitRelativePath:'folder/main.md',size:5,arrayBuffer:async()=>new Uint8Array([65]).buffer}]),/变化|大小/);
  await assert.rejects(buildFolderBundle([file('folder/main.md',new Uint8Array([0xff,0xfe,0x61]))]),/UTF-8/);
});

function fixture(overrides={}) {
  const state={id:'original',dirty:true},events=[];
  const config={getDraftId:()=>state.id,isDirty:()=>state.dirty,
    saveDraft:async reason=>{events.push(['save',reason]);state.dirty=false;return {id:state.id};},
    uploadFolder:async bundle=>{events.push(['upload',bundle.entry]);return {draft:{id:'imported'},report:{images:1}};},
    refreshDrafts:async()=>events.push(['refresh']),openDraft:async(id,options)=>{events.push(['open',id,options]);state.id=id;},...overrides};
  return {state,events,run:createFolderImporter(config)};
}
test('folder import saves before upload and opens only the complete draft',async()=>{
  const f=fixture(),result=await f.run(article());
  assert.equal(result.opened,true);assert.equal(result.draft.id,'imported');assert.equal(result.bundle.attachmentCount,4);
  assert.deepEqual(f.events.map(e=>e[0]),['save','upload','refresh','open']);
  assert.deepEqual(f.events.at(-1)[2],{preserveChanges:true});
});
test('failed current save aborts upload, and a switch while uploading keeps the new active article',async()=>{
  const failed=fixture({saveDraft:async()=>null});await assert.rejects(failed.run(article()),/当前修改保存失败/);assert.deepEqual(failed.events,[]);
  const f=fixture({uploadFolder:async()=>{f.state.id='other';return {draft:{id:'imported'},report:{}};}});
  const result=await f.run(article());assert.equal(result.opened,false);assert.equal(f.state.id,'other');
  assert.deepEqual(f.events.map(e=>e[0]),['save','refresh']);
});
test('ambiguous selection can be resolved without saving or uploading until a main document is picked',async()=>{
  let picks=0;const f=fixture({chooseEntry:async candidates=>{picks++;assert.equal(candidates.length,2);return 'b.md';}});
  const result=await f.run([file('folder/a.md','# A'),file('folder/b.md','# B')]);
  assert.equal(picks,1);assert.equal(result.bundle.entry,'b.md');
  const canceled=fixture({chooseEntry:async()=>null});
  assert.equal((await canceled.run([file('folder/a.md','# A'),file('folder/b.md','# B')])).cancelled,true);
  assert.deepEqual(canceled.events,[]);
});
test('edits arriving during upload are saved before switching and a late save failure keeps them visible',async()=>{
  const f=fixture({uploadFolder:async()=>{f.state.dirty=true;return {draft:{id:'imported'}};}});
  await f.run(article());assert.deepEqual(f.events.map(e=>e[0]),['save','refresh','save','open']);
  let calls=0;
  const failed=fixture({saveDraft:async()=>{calls++;if(calls===1){failed.state.dirty=false;return {id:'original'};}return null;},uploadFolder:async()=>{failed.state.dirty=true;return {draft:{id:'imported'}};}});
  await assert.rejects(failed.run(article()),/新稿已导入.*稿件列表/);assert.equal(failed.state.id,'original');assert.equal(failed.state.dirty,true);
});
test('switching while reading local bytes aborts before saving or uploading',async()=>{
  let finish;const bytes=new Promise(resolve=>finish=resolve);
  const source={name:'main.md',webkitRelativePath:'folder/main.md',size:3,arrayBuffer:()=>bytes};
  const f=fixture(),pending=f.run([source]);f.state.id='other';finish(new TextEncoder().encode('# A').buffer);
  await assert.rejects(pending,/稿件已切换/);assert.deepEqual(f.events,[]);
});
test('folder picker imports a file snapshot once and reconnecting removes earlier listeners',async()=>{
  const {document}=parseHTML('<button id="importFolder">文件夹</button><button data-open-folder-import>选择</button><input id="articleFolder" type="file" webkitdirectory multiple>');
  const input=document.querySelector('input'),errors=[];let imports=0,finish,picks=0;
  input.click=()=>picks++;
  connectFolderFilePicker(document,{onFiles:async()=>{throw new Error('stale');}});
  const connection=connectFolderFilePicker(document,{onFiles:files=>{assert.equal(files.length,7);imports++;return new Promise((_,reject)=>finish=reject);},onError:error=>errors.push(error.message)});
  document.querySelector('#importFolder').click();assert.equal(picks,1);
  input.files=article();input.dispatchEvent(new document.defaultView.Event('change'));
  assert.equal(document.querySelector('button').disabled,true);input.dispatchEvent(new document.defaultView.Event('change'));assert.equal(imports,1);
  finish(new Error('upload failed'));await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(errors,['upload failed']);assert.equal(input.value,'');assert.equal(document.querySelector('button').disabled,false);
  connection.destroy();document.querySelector('button').click();assert.equal(picks,1);
});
test('the optional document chooser displays file names as text and removes itself after cancel',async()=>{
  const {document}=parseHTML('<html><body></body></html>');
  document.defaultView.HTMLDialogElement=undefined;
  const pending=chooseFolderEntry(document,[{path:'a.md',name:'<b>notes</b>.md'},{path:'b.md',name:'正文.md'}]);
  const dialog=document.querySelector('dialog');assert.ok(dialog);assert.equal(dialog.querySelector('b'),null);
  dialog.querySelector('[data-folder-cancel]').click();assert.equal(await pending,null);assert.equal(document.querySelector('dialog'),null);
});
