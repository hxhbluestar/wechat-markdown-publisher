"""Local asset inventory and non-destructive derivative orchestration."""
import base64
import hashlib
import json
import re
from urllib.parse import unquote, urlsplit
from article_import import _image_references, ArticleImportError
from asset_workbench import inspect_image, derive_image, download_public_image, AssetWorkbenchError
from editor_service import safe_asset_path, atomic_json, utc_now, EditorError

def relations(store,draft_id):
    path=store._draft_dir(draft_id)/'.asset-relations.json'
    if not path.is_file():return {}
    try:
        data=json.loads(path.read_text('utf-8'))
        return data if isinstance(data,dict) else {}
    except (ValueError,OSError):return {}

def record_derivation(store,draft_id,path,details):
    # Only application-generated provenance fields; no arbitrary request keys.
    with store._lock:
        clean=safe_asset_path(path)
        allowed={'source_path','source_hash','derived_hash','operations','crop_box','safe_area','safe_area_pixels','mode','source','kind','source_url','final_url','width','height','format','frames','duration_ms'}
        safe={k:v for k,v in details.items() if k in allowed}
        encoded=json.dumps(safe,ensure_ascii=False,allow_nan=False)
        if len(encoded.encode())>128*1024:raise EditorError('素材来源记录过大')
        safe['created_at']=utc_now()
        all_relations=relations(store,draft_id)
        if clean not in all_relations and len(all_relations)>=2000:raise EditorError('素材派生记录已达保留上限')
        all_relations[clean]=safe
        atomic_json(store._draft_dir(draft_id)/'.asset-relations.json',all_relations)

def inventory(store,draft_id):
    with store._lock:
        draft=store.get(draft_id);content=draft['content'];linked=relations(store,draft_id)
        counts={};captions={}
        try:
            for start,end,src in _image_references(content):
                if urlsplit(src).scheme:continue
                prefix=f'/api/editor/drafts/{draft_id}/assets/'
                target=src[len(prefix):] if src.startswith(prefix) else src
                try:key=safe_asset_path(unquote(target))
                except EditorError:continue
                counts[key]=counts.get(key,0)+1
                context=content[max(0,start-500):start]
                alt=re.search(r'!\[((?:\\.|[^\]\\])*)\]\([^)]*$',context)
                if alt:captions.setdefault(key,[]).append(alt[1])
        except ArticleImportError:pass
        output=[];seen={}
        for asset in store.list_assets(draft_id):
            item={**asset,'reference_count':counts.get(asset['path'],0),'captions':captions.get(asset['path'],[])}
            try:
                details=inspect_image(store.asset_path(draft_id,asset['path']).read_bytes())
                item.update({k:v for k,v in details.items() if k!='frame_durations_ms'})
                digest=details['sha256']
                if digest in seen:item['duplicate_of']=seen[digest]
                else:seen[digest]=asset['path']
            except (AssetWorkbenchError,EditorError,OSError):item.update(status='broken',validation_error=True)
            if asset['path'] in linked:item['derivation']=linked[asset['path']]
            output.append(item)
        return output

def derive_asset(store,draft_id,path,mode,options):
    # Decode outside the live lock, then verify the source hash before staging a
    # new named derivative. Original bytes and Markdown are never overwritten.
    with store._lock:
        source_path=safe_asset_path(path)
        data=store.asset_path(draft_id,source_path).read_bytes()
    derived=derive_image(data,mode,options)
    digest=derived['metadata']['derived_hash']
    relative=f'images/derived-{digest}{derived["extension"]}'
    with store._lock:
        if hashlib.sha256(store.asset_path(draft_id,source_path).read_bytes()).digest()!=hashlib.sha256(data).digest():raise EditorError('原图已变化，请重新生成派生图',409)
        asset=store.save_asset(draft_id,relative,base64.b64encode(derived['bytes']).decode())
        details={**derived['metadata'],'source_path':source_path,'mode':mode}
        record_derivation(store,draft_id,relative,details)
    return {'asset':asset,'derivation':details}

def download_asset(store,draft_id,url):
    store.get(draft_id)
    result=download_public_image(url)
    digest=result['metadata']['sha256'];relative=f'images/download-{digest}{result["extension"]}'
    with store._lock:
        asset=store.save_asset(draft_id,relative,base64.b64encode(result['bytes']).decode())
        record_derivation(store,draft_id,relative,{**result['metadata'],'kind':'public-download'})
    return {'asset':asset,'source_url':url}
