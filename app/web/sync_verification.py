"""Read-only remote reconciliation. Never add/update a draft or upload an image."""
import html
import re
from editor_service import EditorError, LOCAL_IMAGE_SRC, safe_asset_path, utc_now, TYPOGRAPHY_VALUES
from sync_workflow import normalized_remote_article,article_comparison

def expected_article(job):
    snapshot=job['snapshot'];metadata=snapshot['metadata'];checkpoint=job['checkpoint']
    hashes={a['path']:a['sha256'] for a in snapshot['manifest']['assets']}
    cache=checkpoint.get('image_cache') or {}
    def replace(match):
        source=html.unescape(match['src']);prefix=f'/api/editor/drafts/{job["draft_id"]}/assets/'
        path=safe_asset_path(source[len(prefix):] if source.startswith(prefix) else source)
        url=cache.get(hashes.get(path,''))
        if not url:raise EditorError('快照缺少已确认的图片上传记录，需在微信后台核实',409)
        return f'{match["prefix"]}{match["quote"]}{html.escape(url,quote=True)}{match["quote"]}'
    content=LOCAL_IMAGE_SRC.sub(replace,snapshot['html'])
    return {'title':metadata['title'],'author':metadata.get('author',''),'digest':metadata.get('digest',''),'content':content,'content_source_url':metadata.get('source_url',''),'thumb_media_id':checkpoint.get('thumb_media_id',''),'show_cover_pic':int(bool(metadata.get('show_cover_pic'))),'need_open_comment':int(bool(metadata.get('need_open_comment'))),'only_fans_can_comment':int(bool(metadata.get('only_fans_can_comment')))}

MEDIA_ID = re.compile(r'[A-Za-z0-9_-]{1,256}\Z')

def reconciliation_candidates(workflow,job_id):
    """Read one bounded recent page; selecting a match still requires a fresh get."""
    job=workflow.jobs.get(job_id,include_snapshot=True)
    if job['state']!='uncertain':raise EditorError('仅待核实的任务可以查找候选草稿',409)
    expected=normalized_remote_article(expected_article(job))
    try:
        response=workflow.accounts.publisher(job['account_id']).api.get_recent_drafts()
    except Exception:
        raise EditorError('读取最近微信草稿失败；本次没有写入或上传',502) from None
    items=response.get('item') if isinstance(response,dict) else None
    if not isinstance(items,list):raise EditorError('微信草稿列表格式无效',502)
    result=[];seen=set()
    for candidate in items[:20]:
        if not isinstance(candidate,dict):continue
        media_id=candidate.get('media_id')
        if not isinstance(media_id,str) or not MEDIA_ID.fullmatch(media_id) or media_id in seen:continue
        seen.add(media_id)
        content=candidate.get('content')
        try:
            normalized=normalized_remote_article(content)
            matched=not article_comparison(expected,normalized)['changed']
            title=str(normalized['articles'][0].get('title',''))[:200]
        except (EditorError,ValueError,TypeError,KeyError,IndexError):
            continue
        timestamp=candidate.get('update_time')
        result.append({'media_id':media_id,'title':title,'update_time':timestamp if type(timestamp) is int and timestamp>=0 else 0,'matches_snapshot':matched})
    return {'items':result,'job':workflow.jobs.get(job_id)}

def verify_job(workflow,job_id,media_id=''):
    job=workflow.jobs.get(job_id,include_snapshot=True)
    if job['state']=='succeeded':return {'job':workflow.jobs.get(job_id),'verified':True}
    if job['state']!='uncertain':raise EditorError('仅待核实的任务可以执行远端核对',409)
    if not isinstance(media_id,str) or media_id and not MEDIA_ID.fullmatch(media_id):raise EditorError('微信草稿标识无效',400)
    known_id=job['checkpoint'].get('media_id')
    if known_id and media_id and media_id!=known_id:raise EditorError('候选标识与已记录的微信草稿不一致',409)
    if media_id and not known_id and job['checkpoint'].get('operation')!='create':raise EditorError('只有未返回标识的新增任务可关联候选草稿',409)
    media_id=known_id or media_id
    if not media_id:return {'job':workflow.jobs.get(job_id),'verified':False,'message':'新增请求未返回草稿标识，请查找最近微信草稿并明确选择候选项。编辑器不会自动重建。'}
    expected=normalized_remote_article(expected_article(job))
    try:
        api=workflow.accounts.publisher(job['account_id']).api
        remote=normalized_remote_article(api.get_draft(media_id))
    except Exception:
        raise EditorError('远端核对未完成，请检查公众号连接后重试；本次没有写入或上传',502) from None
    comparison=article_comparison(expected,remote)
    if comparison['changed']:
        return {'job':workflow.jobs.get(job_id),'verified':False,'comparison':comparison,'message':'远端内容与本次快照存在可见差异，请在微信后台核对后决定。'}
    snapshot=job['snapshot'];metadata=snapshot['metadata']
    with workflow.store._lock:
        publish=workflow.store.get_publish_state(job['draft_id'],job['account_id'])
        checkpoint=job['checkpoint']
        cached=publish.get('image_cache')
        publish['image_cache']={**(cached if isinstance(cached,dict) else {}),**checkpoint.get('image_cache',{})}
        if 'thumb_media_id' in checkpoint:
            publish['thumb_media_id']=checkpoint['thumb_media_id']
            # A new confirmed thumbnail must never inherit an unrelated old
            # cover fingerprint. Missing proof forces a later cover upload.
            if 'cover_sha256' not in checkpoint:
                publish.pop('cover_sha256',None)
        if 'cover_sha256' in checkpoint:
            publish['cover_sha256']=checkpoint['cover_sha256']
            if 'thumb_media_id' not in checkpoint:
                publish.pop('thumb_media_id',None)
        publish.update(media_id=media_id,account_id=job['account_id'],content_sha256=snapshot['source_hash'],draft_revision=snapshot['revision'],theme=metadata['theme'],palette=metadata['palette'],typography={k:metadata[k] for k in TYPOGRAPHY_VALUES},synced_at=utc_now(),publish_status='draft_synced',remote_verified=True,remote_baseline=remote,remote_baseline_hash=comparison['current_hash'],render_version=snapshot['render_version'],render_fingerprint=snapshot['preflight_fingerprint'],synced_snapshot={'content':snapshot['content'],'metadata':metadata,'revision':snapshot['revision']},last_error='')
        # The job state is checked under its process lock before publishing the
        # verified baseline. A competing manual resolution must not change it.
        resolved=workflow.jobs.resolve_uncertain(job_id,outcome='succeeded',result={'verified':True,'media_id':media_id,'created':job['checkpoint'].get('operation')=='create','content_sha256':snapshot['source_hash'],'draft_revision':snapshot['revision'],'render_fingerprint':snapshot['preflight_fingerprint'],'publish_status':'draft_synced'},before_resolve=lambda:workflow.store.save_publish_state(job['draft_id'],publish))
    return {'job':resolved,'verified':True}
