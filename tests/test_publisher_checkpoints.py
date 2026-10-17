import base64
import copy
import io
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'app/web'))
from PIL import Image
from editor_service import DraftStore,WechatPublisher,WechatOpenAPI,EditorError,content_sha256,TYPOGRAPHY_VALUES
from article_package import article_package
from article_import import prepare_import
from asset_service import derive_asset, relations
from sync_workflow import article_comparison
from sync_jobs import UnknownRemoteResult,DefinitiveSyncFailure

ACCOUNT='account-123456789abc'
class Context:
    def __init__(self):self.events=[];self.checkpoint_state={};self.snapshot={'render_version':'2026.10.18-workflow.1','preflight_fingerprint':'a'*64}
    def emit(self,stage,**data):self.events.append((stage,data))
    def checkpoint(self,**data):self.checkpoint_state.update(data)

class API:
    def __init__(self):self.uploads=[];self.fail_image=3;self.fail_add=False;self.article=None;self.adds=0;self.updates=0
    def upload_content_image(self,path):
        name=path.name;self.uploads.append(name)
        if self.fail_image and name==f'{self.fail_image}.png':self.fail_image=0;raise EditorError('fixture failure',502)
        return 'https://mmbiz.qpic.cn/test/'+name
    def upload_thumb(self,path):return 'thumb'
    def add_draft(self,article):
        self.adds+=1
        if self.fail_add:raise TimeoutError('response lost')
        self.article=dict(article);return 'media'
    def update_draft(self,media_id,article):self.updates+=1;self.article=dict(article)
    def get_draft(self,media_id):return {'news_item':[dict(self.article)]}

class PublisherCheckpointTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.store=DraftStore(Path(self.tmp.name)/'drafts');self.api=API();self.publisher=WechatPublisher(self.api,account_id=ACCOUNT)
        d=self.store.create('# Synthetic\n\n'+''.join(f'![图{i}](images/{i}.png)\n\n' for i in range(1,16)))
        for i in range(1,16):
            out=io.BytesIO();Image.new('RGB',(2,2),(i,0,0)).save(out,'PNG');self.store.save_asset(d['id'],f'images/{i}.png',base64.b64encode(out.getvalue()).decode())
        self.d=self.store.save(d['id'],d['content'],{**d['metadata'],'cover':'images/1.png','wechat_account_id':ACCOUNT},d['revision'])
        self.html=''.join(f'<img src="images/{i}.png">' for i in range(1,16))
    def sync(self,context,**kwargs):
        d=self.store.get(self.d['id']);return self.publisher.sync(self.store,d['id'],self.html,content_sha256(d['content']),d['metadata']['theme'],d['metadata']['palette'],typography={k:d['metadata'][k] for k in TYPOGRAPHY_VALUES},context=context,**kwargs)
    def test_first_sync_failure_checkpoints_confirmed_images_and_retry_reuses_them(self):
        ctx=Context()
        with self.assertRaises(EditorError):self.sync(ctx)
        self.assertEqual(len(self.store.get_publish_state(self.d['id'],ACCOUNT)['image_cache']),2)
        self.assertEqual(len(ctx.checkpoint_state['image_cache']),2)
        saved,created=self.sync(Context())
        self.assertTrue(created);self.assertEqual(self.api.uploads.count('1.png'),1);self.assertEqual(self.api.uploads.count('2.png'),1)
        self.assertEqual(self.api.uploads.count('3.png'),2);self.assertEqual(self.api.adds,1)
        self.assertTrue(saved['publish']['remote_verified'])
    def test_timeout_after_add_is_unknown_and_keeps_cover_and_images(self):
        self.api.fail_image=0;self.api.fail_add=True;ctx=Context()
        with self.assertRaises(UnknownRemoteResult):self.sync(ctx)
        self.assertEqual(ctx.events[-1][0],'remote-write')
        self.assertEqual(len(ctx.checkpoint_state['image_cache']),15)
        self.assertEqual(ctx.checkpoint_state['thumb_media_id'],'thumb')
        self.assertEqual(self.api.adds,1)
    def test_remote_manual_change_requires_explicit_hash_bound_choice(self):
        self.api.fail_image=0;self.sync(Context());before=len(self.api.uploads)
        self.api.article['title']='Remote edited'
        with self.assertRaises(DefinitiveSyncFailure) as caught:self.sync(Context())
        self.assertEqual(caught.exception.code,'remote-conflict')
        self.assertEqual(len(self.api.uploads),before)

    def test_remote_change_during_upload_blocks_update_and_retains_confirmed_cache(self):
        self.api.fail_image=0;self.sync(Context())
        publish=self.store.get_publish_state(self.d['id'],ACCOUNT)
        publish['image_cache']={};self.store.save_publish_state(self.d['id'],publish)
        accepted=copy.deepcopy(self.api.article)
        upload=self.api.upload_content_image
        def mutate_remote(path):
            self.api.article['title']='New manual edit while uploads run'
            return upload(path)
        self.api.upload_content_image=mutate_remote
        ctx=Context()
        with self.assertRaises(DefinitiveSyncFailure) as caught:self.sync(ctx)
        self.assertEqual(caught.exception.code,'remote-conflict')
        self.assertEqual(self.api.updates,0)
        self.assertNotEqual(self.api.article['title'],accepted['title'])
        self.assertEqual(len(ctx.checkpoint_state['image_cache']),15)
        self.assertEqual(len(self.store.get_publish_state(self.d['id'],ACCOUNT)['image_cache']),15)
        self.assertNotIn('remote-write',[stage for stage,_ in ctx.events])

    def test_explicit_overwrite_only_accepts_the_compared_remote_version(self):
        self.api.fail_image=0;self.sync(Context())
        self.api.article['title']='Compared manual edit'
        accepted=article_comparison(self.api.article,self.api.article)['current_hash']
        publish=self.store.get_publish_state(self.d['id'],ACCOUNT)
        publish['image_cache']={};self.store.save_publish_state(self.d['id'],publish)
        upload=self.api.upload_content_image
        def mutate_remote(path):
            self.api.article['digest']='Another edit after acceptance'
            return upload(path)
        self.api.upload_content_image=mutate_remote
        with self.assertRaises(DefinitiveSyncFailure) as caught:
            self.sync(Context(),remote_action='overwrite',expected_remote_hash=accepted)
        self.assertEqual(caught.exception.code,'remote-conflict')
        self.assertEqual(self.api.updates,0)

    def test_same_name_upload_preserves_original_derivation_and_new_cover_roundtrip(self):
        original=self.store.asset_path(self.d['id'],'images/1.png').read_bytes()
        self.store.save_asset(self.d['id'],'cover.png',base64.b64encode(original).decode())
        derived=derive_asset(self.store,self.d['id'],'cover.png','diagram',{})
        replacement=self.store.asset_path(self.d['id'],'images/2.png').read_bytes()
        new=self.store.save_asset(self.d['id'],'cover.png',base64.b64encode(replacement).decode())
        self.assertNotEqual(new['path'],'cover.png')
        self.assertEqual(self.store.asset_path(self.d['id'],'cover.png').read_bytes(),original)
        self.assertEqual(self.store.asset_path(self.d['id'],new['path']).read_bytes(),replacement)
        repeated=self.store.save_asset(self.d['id'],'cover.png',base64.b64encode(replacement).decode())
        self.assertEqual(repeated['path'],new['path'])
        current=self.store.get(self.d['id'])
        saved=self.store.save(current['id'],current['content'],{**current['metadata'],'cover':new['path']},current['revision'])
        prepared=prepare_import('preserved.zip',article_package(self.store,saved['id']))
        self.assertTrue(prepared['asset_relations'])
        self.assertEqual(relations(self.store,saved['id'])[derived['asset']['path']]['source_path'],'cover.png')
        self.api.fail_image=0;self.sync(Context())
        self.assertEqual(self.api.adds,1)

    def test_recent_draft_lookup_requests_read_only_first_twenty_full_articles(self):
        api=object.__new__(WechatOpenAPI)
        api._post=Mock(return_value={'item':[]})
        self.assertEqual(api.get_recent_drafts(),{'item':[]})
        api._post.assert_called_once_with('/cgi-bin/draft/batchget',{'offset':0,'count':20,'no_content':0})

if __name__=='__main__':unittest.main()
