// One queue for every explicit save path. Newer visible edits always win.
export function createDraftSaver({state,request,getContent,readMetadata,setDirty,refreshList,onAccepted=()=>{},onError=()=>{},onSaved=()=>{}}) {
  let pending=Promise.resolve();
  return function saveDraft(reason='manual-save') {
    const id=state.current?.id;
    if(!id)return Promise.resolve(null);
    const operation=async()=>{
      if(state.current?.id!==id)return null;
      const record=state.current,content=getContent(),metadata=readMetadata();
      const metadataJSON=JSON.stringify(metadata);
      const matches=()=>getContent()===content&&JSON.stringify(readMetadata())===metadataJSON;
      try {
        const saved=await request(`/api/editor/drafts/${encodeURIComponent(id)}`,{
          method:'PUT',body:JSON.stringify({content,metadata,revision:record.revision,reason:typeof reason==='string'?reason:'manual-save'})
        });
        // Recovery records belong to this exact saved generation even after a tab switch.
        await onSaved({id,content,metadata,saved});
        if(state.current!==record)return null;
        const unchanged=matches();
        state.current={...saved,metadata:unchanged?saved.metadata:readMetadata()};
        const accepted=state.current;
        setDirty(!unchanged);
        onAccepted(accepted);
        await refreshList();
        if(state.current!==accepted)return null;
        return unchanged&&matches()?saved:null;
      } catch(error) {
        onError(error,{id,content,metadata,revision:record.revision});
        return null;
      }
    };
    const result=pending.then(operation);
    pending=result.catch(()=>{});
    return result;
  };
}
