// Shared by Save, Ctrl+S, import, sync and the proofreading dialog.
// Queue requests so every PUT uses the revision from the previous response.
let pendingDraftSave=Promise.resolve();
async function wp(){
  const id=H.current?.id;
  if(!id)return null;
  const operation=async()=>{
    if(H.current?.id!==id)return null;
    const record=H.current,content=zo(),metadata=kc();
    const metadataJSON=JSON.stringify(metadata);
    const matches=()=>zo()===content&&JSON.stringify(kc())===metadataJSON;
    try{
      const saved=await sn(`/api/editor/drafts/${encodeURIComponent(id)}`,{
        method:"PUT",body:JSON.stringify({content,metadata,revision:record.revision})
      });
      if(H.current!==record)return null;
      const unchanged=matches();
      // A newer edit still needs saving, but its next PUT needs the new revision.
      H.current={...saved,metadata:unchanged?saved.metadata:kc()};
      const accepted=H.current;
      le.title.textContent=H.current.metadata.title||"未命名文章";
      ds(!unchanged);
      await ia();
      if(H.current!==accepted)return null;
      _o();
      return unchanged&&matches()?saved:null;
    }catch(error){ct(error.message,!0);return null;}
  };
  const result=pendingDraftSave.then(operation);
  pendingDraftSave=result.catch(()=>{});
  return result;
}
