export function normalizeRocmUrl(value) {
  let url;
  try { url=new URL(String(value).trim()); } catch { throw new Error('请输入完整的 ROCm 博客文章地址'); }
  if (url.protocol!=='https:' || url.hostname!=='rocm.blogs.amd.com' || url.port || url.username || url.password) {
    throw new Error('仅支持 https://rocm.blogs.amd.com/ 下的官方博客文章');
  }
  url.hash='';
  return url.href;
}

export function rocmImportMarkup() {
  return `<button class="quiet-action" id="importRocmBlog" type="button">导入 ROCm 博客</button>
  <dialog class="account-dialog rocm-import-dialog" id="rocmImportDialog" aria-labelledby="rocmImportTitle">
    <div class="dialog-heading"><div><strong id="rocmImportTitle">导入 ROCm 博客</strong><small>提取正文、代码与表格，并将配图保存到本机。</small></div><button id="closeRocmImport" type="button" aria-label="关闭博客导入">×</button></div>
    <form class="account-form rocm-import-form" id="rocmImportForm">
      <label><span>AMD ROCm 博客文章地址</span><input id="rocmBlogUrl" type="url" maxlength="2048" required autocomplete="off" placeholder="https://rocm.blogs.amd.com/…/README.html"></label>
      <p class="rocm-import-hint">导入为新稿，保留来源链接；当前修改会先保存到本地。仅支持官方 ROCm 博客。</p>
      <div class="account-form-error" id="rocmImportError" role="alert" hidden></div>
      <button class="primary-action" id="confirmRocmImport" type="submit">导入为新稿</button>
    </form>
  </dialog>`;
}

export function connectRocmImport(container,{request,beforeImport=async()=>{},onImported=async()=>{}}) {
  const get=id=>container.querySelector('#'+id);
  const dialog=get('rocmImportDialog'),button=get('confirmRocmImport'),error=get('rocmImportError');
  let busy=false,importedDraft=null;
  function open() { if(busy)return;error.hidden=true;dialog.showModal(); }
  async function submit() {
    if(busy)return;
    error.hidden=true;
    try {
      const url=importedDraft?null:normalizeRocmUrl(get('rocmBlogUrl').value);
      busy=true;button.disabled=true;button.textContent='正在导入正文与配图…';
      get('closeRocmImport').disabled=true;
      await beforeImport();
      if (!importedDraft) {
        const result=await request('/api/editor/import-rocm',{method:'POST',body:JSON.stringify({url})});
        importedDraft=result.draft;
        get('rocmBlogUrl').disabled=true;
      }
      await onImported(importedDraft);
      importedDraft=null;
      dialog.close();
    } catch(exc) {
      error.textContent=exc.message||'博客导入失败，请稍后重试';error.hidden=false;
    } finally {
      busy=false;button.disabled=false;button.textContent=importedDraft?'打开已导入稿件':'导入为新稿';get('closeRocmImport').disabled=false;get('rocmBlogUrl').disabled=!!importedDraft;
    }
  }
  get('importRocmBlog').addEventListener('click',open);
  get('closeRocmImport').addEventListener('click',()=>{if(!busy)dialog.close();});
  dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();});
  get('rocmImportForm').addEventListener('submit',event=>{event.preventDefault();void submit();});
  return {open,submit};
}
