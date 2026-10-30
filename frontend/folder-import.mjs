// Folder selection stays local until one complete Markdown + assets ZIP exists.
// A stored ZIP preserves original bytes without an external compression runtime.
const MIB=1024*1024,MAX_ZIP=256*MIB,MAX_FILE=128*MIB,MAX_TEXT=6*MIB,MAX_FILES=512;
const MARKDOWN=/\.(?:md|markdown)$/i,IMAGE=/\.(?:png|jpe?g|gif|webp)$/i,VIDEO=/\.(?:mp4|m4v|webm|mov)$/i;
const NOTE=/(?:不随正文|编辑核查|核查说明|图片来源说明|来源说明|校对说明)/i;
const RESERVED=/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;
const encoder=new TextEncoder();
const CRC_TABLE=Uint32Array.from({length:256},(_,value)=>{
  for(let bit=0;bit<8;bit++)value=(value>>>1)^((value&1)?0xedb88320:0);
  return value>>>0;
});

function safePath(value) {
  if(typeof value!=='string'||!value||value.startsWith('/')||/[\\\x00-\x1f\x7f:<>"|?*]/.test(value)||/%[\da-f]{2}/i.test(value))throw new Error('文件夹包含无效或不安全的路径');
  const clean=value.normalize('NFC'),parts=clean.split('/');
  if(parts.some(part=>!part||part==='.'||part==='..'||/[ .]$/.test(part)||RESERVED.test(part))||encoder.encode(clean).length>1024)throw new Error('文件夹包含无效或不安全的文件名称');
  return clean;
}

function folderFiles(input) {
  const source=Array.from(input||[]);
  if(!source.length)throw new Error('请选择包含 Markdown 和 assets 目录的文章文件夹');
  if(source.length>MAX_FILES)throw new Error('文章文件夹最多支持 512 个文件');
  const seen=new Set();let folderName;
  const files=source.map(file=>{
    const raw=safePath(file?.webkitRelativePath||'');
    const slash=raw.indexOf('/');
    if(slash<1)throw new Error('请选择文章文件夹，而不是逐个选择附件');
    const root=raw.slice(0,slash),path=raw.slice(slash+1);
    if(folderName&&folderName!==root)throw new Error('所有文件必须来自同一个文章文件夹');
    folderName=root;
    const key=path.toLowerCase();
    if(seen.has(key))throw new Error(`文件夹包含重复或大小写同名文件：${path}`);
    seen.add(key);
    return {file,path,name:path.split('/').at(-1),size:file.size};
  });
  return {files,folderName};
}

async function bytesOf(record) {
  const bytes=new Uint8Array(await record.file.arrayBuffer());
  if(bytes.length!==record.size)throw new Error(`文件读取时大小发生变化：${record.path}`);
  return bytes;
}

async function markdownText(record) {
  if(!Number.isSafeInteger(record.size)||record.size<1||record.size>MAX_TEXT)throw new Error(`Markdown 正文不能为空且不能超过 6 MiB：${record.path}`);
  let text;
  try{text=new TextDecoder('utf-8',{fatal:true}).decode(await bytesOf(record));}
  catch(error){if(error instanceof TypeError)throw new Error(`Markdown 正文必须使用 UTF-8 编码：${record.path}`);throw error;}
  if(!text.trim()||text.includes('\0'))throw new Error(`Markdown 正文为空或包含无效字符：${record.path}`);
  return text;
}

async function selectEntry(files,entry) {
  const candidates=files.filter(f=>!f.path.includes('/')&&MARKDOWN.test(f.path));
  if(!candidates.length)throw new Error('文章文件夹根目录没有 Markdown（.md 或 .markdown）正文');
  if(entry!==undefined&&entry!==null) {
    const selected=candidates.find(f=>f.path===entry);
    if(!selected)throw new Error('选择的 Markdown 正文不在文章文件夹根目录');
    return selected;
  }
  if(candidates.length===1)return candidates[0];
  const articleCandidates=candidates.filter(f=>!NOTE.test(f.name));
  if(articleCandidates.length===1)return articleCandidates[0];
  const eligible=articleCandidates.length?articleCandidates:candidates;
  const references=new Set(files.filter(f=>f.path.startsWith('assets/')).map(f=>f.path));
  const scores=[];
  for(const candidate of eligible) {
    const text=await markdownText(candidate);
    const linked=new Set();
    for(const match of text.matchAll(/(?:\.\/)?assets\/[^\s<>"'()\[\]]+/g)) {
      let path;
      try{path=decodeURIComponent(match[0].replace(/^\.\//,''));}catch{continue;}
      if(references.has(path))linked.add(path);
    }
    scores.push({candidate,score:linked.size});
  }
  scores.sort((a,b)=>b.score-a.score);
  if(scores[0].score>0&&scores[0].score>(scores[1]?.score??-1))return scores[0].candidate;
  const error=new Error('文件夹包含多份 Markdown，请选择要导入的正文');
  error.code='choose-markdown';
  error.candidates=candidates.map(({path,name,size})=>({path,name,size}));
  throw error;
}

async function crcAndPart(record) {
  let crc=0xffffffff,count=0;
  const update=bytes=>{
    count+=bytes.length;
    if(count>record.size)throw new Error(`文件读取时大小发生变化：${record.path}`);
    for(const byte of bytes)crc=(crc>>>8)^CRC_TABLE[(crc^byte)&255];
  };
  let part;
  if(typeof Blob!=='undefined'&&record.file instanceof Blob&&typeof record.file.stream==='function') {
    const reader=record.file.stream().getReader();
    try{for(;;){const next=await reader.read();if(next.done)break;update(next.value);}}
    finally{reader.releaseLock();}
    part=record.file;
  } else {part=await bytesOf(record);update(part);}
  if(count!==record.size)throw new Error(`文件读取时大小发生变化：${record.path}`);
  return {crc:(crc^0xffffffff)>>>0,part};
}

/** Return a bounded ZIP Blob. No unselected root document is transmitted. */
export async function buildFolderBundle(input,{entry}={}) {
  const {files,folderName}=folderFiles(input);
  const selected=await selectEntry(files,entry);
  const attachments=files.filter(file=>file.path.startsWith('assets/'));
  const members=[selected,...attachments];
  let total=22;
  for(const member of members) {
    if(!Number.isSafeInteger(member.size)||member.size<0||member.size>MAX_FILE)throw new Error(`单个附件不能超过 128 MiB：${member.path}`);
    if(member===selected&&member.size>MAX_TEXT)throw new Error('Markdown 正文不能超过 6 MiB');
    member.encodedName=encoder.encode(member.path);
    total+=member.size+76+member.encodedName.length*2;
  }
  if(total>MAX_ZIP)throw new Error('文章文件夹与打包信息合计不能超过 256 MiB');
  await markdownText(selected);
  const local=[],central=[];let offset=0,centralSize=0;
  for(const member of members) {
    const {crc,part}=await crcAndPart(member),name=member.encodedName;
    const header=new Uint8Array(30),h=new DataView(header.buffer);
    h.setUint32(0,0x04034b50,true);h.setUint16(4,20,true);h.setUint16(6,0x800,true);
    h.setUint16(12,33,true);h.setUint32(14,crc,true);h.setUint32(18,member.size,true);h.setUint32(22,member.size,true);h.setUint16(26,name.length,true);
    const directory=new Uint8Array(46),d=new DataView(directory.buffer);
    d.setUint32(0,0x02014b50,true);d.setUint16(4,20,true);d.setUint16(6,20,true);d.setUint16(8,0x800,true);
    d.setUint16(14,33,true);d.setUint32(16,crc,true);d.setUint32(20,member.size,true);d.setUint32(24,member.size,true);d.setUint16(28,name.length,true);d.setUint32(42,offset,true);
    local.push(header,name,part);central.push(directory,name);
    offset+=30+name.length+member.size;centralSize+=46+name.length;
  }
  const end=new Uint8Array(22),e=new DataView(end.buffer);
  e.setUint32(0,0x06054b50,true);e.setUint16(8,members.length,true);e.setUint16(10,members.length,true);e.setUint32(12,centralSize,true);e.setUint32(16,offset,true);
  const body=new Blob([...local,...central,end],{type:'application/zip'});
  if(body.size!==total)throw new Error('文章文件夹打包大小不一致，请重新选择');
  return {body,entry:selected.path,folderName,attachmentCount:attachments.length,imageCount:attachments.filter(f=>IMAGE.test(f.path)).length,videoCount:attachments.filter(f=>VIDEO.test(f.path)).length};
}

/** Preserve the visible draft across file IO, upload and deliberate switches. */
export function createFolderImporter({getDraftId,isDirty,saveDraft,uploadFolder,refreshDrafts,openDraft,chooseEntry}) {
  return async files=>{
    const originalId=getDraftId();
    const ensureCurrent=()=>{if(getDraftId()!==originalId)throw new Error('稿件已切换，请重新选择文章文件夹');};
    const saveVisible=async()=>{
      if(isDirty()&&(!(await saveDraft('before-folder-import'))||isDirty()))throw new Error('当前修改保存失败，请先保存后再导入');
      ensureCurrent();
    };
    let bundle;
    try{bundle=await buildFolderBundle(files);}
    catch(error) {
      if(error.code!=='choose-markdown'||!chooseEntry)throw error;
      ensureCurrent();
      const picked=await chooseEntry(error.candidates);
      if(!picked)return {cancelled:true,opened:false};
      ensureCurrent();bundle=await buildFolderBundle(files,{entry:typeof picked==='string'?picked:picked.path});
    }
    ensureCurrent();await saveVisible();
    const uploaded=await uploadFolder(bundle),{draft,report}=uploaded;
    if(!draft?.id)throw new Error('导入服务未返回完整稿件，请检查服务状态');
    await refreshDrafts();
    if(getDraftId()!==originalId)return {draft,report,bundle,opened:false};
    try{await saveVisible();await openDraft(draft.id,{preserveChanges:true});}
    catch(error){throw new Error('新稿已导入，当前修改尚未保存；请保存后从稿件列表打开新稿',{cause:error});}
    return {draft,report,bundle,opened:true};
  };
}

const PICKERS=new WeakMap();
export function connectFolderFilePicker(doc,{onFiles,onError=()=>{}}) {
  const input=doc.querySelector('#articleFolder'),entries=[...doc.querySelectorAll('#importFolder,[data-open-folder-import]')];
  if(!input)throw new Error('缺少文章文件夹选择控件');
  PICKERS.get(input)?.destroy();
  let busy=false,previousDisabled=[];
  const choose=()=>{if(!busy)input.click();};
  const changed=async()=>{
    const files=Array.from(input.files||[]);
    if(busy||!files.length)return;
    busy=true;previousDisabled=entries.map(entry=>entry.disabled);
    for(const entry of entries)entry.disabled=true;
    try{await onFiles(files);}catch(error){onError(error);}
    finally{if(PICKERS.get(input)===controller){input.value='';busy=false;entries.forEach((entry,index)=>entry.disabled=previousDisabled[index]);}}
  };
  const controller={destroy(){
    for(const entry of entries)entry.removeEventListener('click',choose);
    input.removeEventListener('change',changed);
    if(PICKERS.get(input)===controller){PICKERS.delete(input);if(busy)entries.forEach((entry,index)=>entry.disabled=previousDisabled[index]);}
  }};
  PICKERS.set(input,controller);
  for(const entry of entries)entry.addEventListener('click',choose);
  input.addEventListener('change',changed);
  return controller;
}

let chooserSequence=0;
/** Only ambiguous folders need this small native dialog; single articles skip it. */
export function chooseFolderEntry(doc,candidates) {
  return new Promise(resolve=>{
    const dialog=doc.createElement('dialog'),form=doc.createElement('form'),title=doc.createElement('h2'),help=doc.createElement('p'),select=doc.createElement('select'),actions=doc.createElement('div'),cancel=doc.createElement('button'),submit=doc.createElement('button');
    const id='folder-entry-choice-'+(++chooserSequence),previous=doc.activeElement;
    title.id=id;title.textContent='选择文章正文';help.textContent='文件夹中有多份 Markdown。仅所选正文与 assets 目录会一起导入，其他根目录说明文件不会进入正文。';
    dialog.setAttribute('aria-labelledby',id);dialog.style.cssText='width:480px;max-width:calc(100vw - 32px);box-sizing:border-box;padding:24px;border:1px solid #d8dee7;border-radius:12px;background:#fff;color:#263342';
    title.style.cssText='margin:0 0 12px;font:600 20px/1.4 system-ui';help.style.cssText='font:14px/1.7 system-ui';
    select.setAttribute('aria-label','Markdown 正文');select.style.cssText='display:block;width:100%;padding:10px;font:14px system-ui';
    for(const candidate of candidates){const option=doc.createElement('option');option.value=candidate.path;option.textContent=candidate.name||candidate.path;select.append(option);}
    actions.style.cssText='display:flex;gap:10px;justify-content:flex-end;margin-top:20px';
    cancel.type='button';cancel.setAttribute('data-folder-cancel','');cancel.textContent='取消';submit.type='submit';submit.textContent='导入这篇正文';
    for(const button of [cancel,submit])button.style.cssText='padding:8px 12px;border:1px solid #c9d2df;border-radius:6px;font:14px system-ui;cursor:pointer';
    actions.append(cancel,submit);form.append(title,help,select,actions);dialog.append(form);doc.body.append(dialog);
    let done=false;
    const finish=value=>{if(done)return;done=true;if(typeof dialog.close==='function'&&dialog.open)dialog.close();dialog.remove();previous?.focus?.();resolve(value);};
    cancel.addEventListener('click',()=>finish(null));
    dialog.addEventListener('cancel',event=>{event.preventDefault();finish(null);});dialog.addEventListener('close',()=>finish(null));
    form.addEventListener('submit',event=>{event.preventDefault();finish(select.value);});
    if(typeof dialog.showModal==='function')dialog.showModal();else dialog.setAttribute('open','');
    select.focus();
  });
}
