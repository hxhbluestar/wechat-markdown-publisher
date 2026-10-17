export function normalizeRocmUrl(value) {
  const text=String(value).trim();
  if(/[\s\x00-\x1f\x7f\\]/.test(text))throw new Error('ROCm 链接包含无效字符');
  let url;
  try { url=new URL(text); } catch { throw new Error('请输入完整的 ROCm 博客文章地址'); }
  if (url.protocol!=='https:' || url.hostname!=='rocm.blogs.amd.com' || url.port || url.username || url.password) {
    throw new Error('仅支持 https://rocm.blogs.amd.com/ 下的官方博客文章');
  }
  if(!url.pathname.toLowerCase().endsWith('.html')||/\/index\.html$/i.test(url.pathname))throw new Error('请填写 ROCm 博客正文的 HTML 链接');
  url.hash='';
  return url.href;
}

export function rocmImportMarkup() {
  return `<button class="quiet-action" id="importRocmBlog" type="button">导入 ROCm 博客</button>
  <dialog class="account-dialog rocm-import-dialog" id="rocmImportDialog" aria-labelledby="rocmImportTitle">
    <div class="dialog-heading"><div><strong id="rocmImportTitle">导入 ROCm 博客</strong><small>提取正文、代码与表格，并将配图保存到本机。</small></div><button id="closeRocmImport" type="button" aria-label="关闭博客导入">×</button></div>
    <form class="account-form rocm-import-form" id="rocmImportForm">
      <label><span>AMD ROCm 博客文章地址</span><input id="rocmBlogUrl" type="url" maxlength="2048" required autocomplete="off" placeholder="https://rocm.blogs.amd.com/…/README.html"></label>
      <p class="rocm-import-hint">先预览转换质量，再确认导入为新稿。保留来源与原始 HTML；确认导入前会保存当前修改。</p>
      <section id="rocmImportReview" aria-label="ROCm 导入质量预览" hidden>
        <strong id="rocmImportPreviewTitle"></strong>
        <p id="rocmImportCounts"></p>
        <ul id="rocmImportDetails"></ul>
        <ul id="rocmImportDuplicates" aria-label="已有相同来源或内容的稿件"></ul>
        <label id="rocmDuplicateChoice" hidden><input type="checkbox" id="allowRocmDuplicate">我已检查重复稿件，仍要创建新版本副本</label>
        <label><span>转换后的 Markdown 预览</span><textarea id="rocmImportPreview" readonly rows="8"></textarea></label>
        <button class="quiet-action" id="reviewRocmAgain" type="button">重新预览</button>
      </section>
      <div class="account-form-error" id="rocmImportError" role="alert" hidden></div>
      <button class="primary-action" id="confirmRocmImport" type="submit">预览导入质量</button>
    </form>
  </dialog>`;
}

export function connectRocmImport(container,{request,beforeImport=async()=>{},onImported=async()=>{}}) {
  const get=id=>container.querySelector('#'+id);
  const dialog=get('rocmImportDialog'),button=get('confirmRocmImport'),error=get('rocmImportError');
  const input=get('rocmBlogUrl'),review=get('rocmImportReview'),consent=get('allowRocmDuplicate');
  let busy=false,importedDraft=null,preview=null,previewUrl='';
  function controls() {
    button.disabled=busy;
    button.textContent=busy?'正在处理正文与配图…':importedDraft?'打开已导入稿件':preview?'确认导入为新稿':'预览导入质量';
    get('closeRocmImport').disabled=busy;
    get('reviewRocmAgain').disabled=busy||!!importedDraft;
    input.disabled=busy||!!importedDraft;
    consent.disabled=busy||!!importedDraft;
  }
  function resetPreview() {
    preview=null;previewUrl='';review.hidden=true;consent.checked=false;
    controls();
  }
  function showPreview(result,url) {
    if(!result||typeof result.title!=='string'||!result.report?.before||!result.report?.after||!Array.isArray(result.duplicates)||typeof result.preview_content!=='string')throw new Error('博客质量预览不完整，请重新预览');
    preview=result;previewUrl=url;
    get('rocmImportPreviewTitle').textContent=result.title;
    const count=value=>Number.isSafeInteger(value)&&value>=0?value:'待检查';
    const describe=counts=>`图片 ${count(counts.images)} / 代码块 ${count(counts.fences)} / 表格 ${count(counts.tables)}`;
    get('rocmImportCounts').textContent=`原文：${describe(result.report.before)}；转换后：${describe(result.report.after)}；本地图片 ${count(result.report.asset_count)} 个。`;
    const details=get('rocmImportDetails'),duplicates=get('rocmImportDuplicates');
    details.replaceChildren();duplicates.replaceChildren();
    const document=container.ownerDocument||container;
    for(const text of [...(Array.isArray(result.report.warnings)?result.report.warnings:[]),...(Array.isArray(result.report.conversions)?result.report.conversions:[])].slice(0,100)) {
      const item=document.createElement('li');item.textContent=String(text).slice(0,4096);details.appendChild(item);
    }
    for(const existing of result.duplicates.slice(0,200)) {
      const item=document.createElement('li');item.textContent=`已有稿件：${String(existing.title||existing.id||'未命名稿件').slice(0,512)}`;duplicates.appendChild(item);
    }
    get('rocmDuplicateChoice').hidden=result.duplicates.length===0;
    consent.checked=false;
    get('rocmImportPreview').value=result.preview_content.slice(0,512*1024);
    review.hidden=false;
  }
  function open() { if(busy)return;error.hidden=true;dialog.showModal(); }
  async function submit() {
    if(busy)return;
    error.hidden=true;
    try {
      const url=importedDraft?null:normalizeRocmUrl(input.value);
      if(preview&&previewUrl!==url)resetPreview();
      if(!importedDraft&&preview?.duplicates.length&&!consent.checked)throw new Error('请检查重复稿件，并勾选创建新版本副本');
      busy=true;controls();
      if(!importedDraft&&!preview) {
        const result=await request('/api/editor/import-rocm',{method:'POST',body:JSON.stringify({url,preview_only:true})});
        if(normalizeRocmUrl(input.value)!==url)throw new Error('博客地址已改变，请重新预览');
        showPreview(result,url);
        return;
      }
      const reviewed=preview,allowDuplicate=consent.checked===true;
      if(await beforeImport()===false)return;
      if(!importedDraft) {
        if(preview!==reviewed||normalizeRocmUrl(input.value)!==url) { resetPreview();throw new Error('博客地址或预览已改变，请重新预览'); }
        const result=await request('/api/editor/import-rocm',{method:'POST',body:JSON.stringify({url,preview_only:false,allow_duplicate:allowDuplicate})});
        if(!result?.draft?.id)throw new Error('博客导入结果不完整，请检查稿件列表后再重试');
        importedDraft=result.draft;
      }
      await onImported(importedDraft);
      importedDraft=null;
      resetPreview();
      dialog.close();
    } catch(exc) {
      if(!importedDraft&&preview&&exc.status===409&&Array.isArray(exc.payload?.duplicates)) {
        showPreview({...preview,duplicates:exc.payload.duplicates,report:exc.payload.report?.before&&exc.payload.report?.after?exc.payload.report:preview.report},previewUrl);
      }
      error.textContent=exc.message||'博客导入失败，请稍后重试';error.hidden=false;
    } finally {
      busy=false;controls();
    }
  }
  get('importRocmBlog').addEventListener('click',open);
  input.addEventListener('input',()=>{if(!importedDraft)resetPreview();});
  get('reviewRocmAgain').addEventListener('click',()=>{if(!busy&&!importedDraft)resetPreview();});
  get('closeRocmImport').addEventListener('click',()=>{if(!busy)dialog.close();});
  dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();});
  get('rocmImportForm').addEventListener('submit',event=>{event.preventDefault();void submit();});
  return {open,submit};
}
