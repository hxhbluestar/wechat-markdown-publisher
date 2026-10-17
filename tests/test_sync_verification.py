import tempfile
import sys
import base64
import hashlib
from pathlib import Path
from types import SimpleNamespace
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'app/web'))
from editor_service import DraftStore,EditorError,WechatPublisher,content_sha256,TYPOGRAPHY_VALUES
from sync_jobs import SyncJobs,UnknownRemoteResult
from sync_verification import verify_job,expected_article,reconciliation_candidates
from article_package import RENDER_VERSION

class VerificationTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);root=Path(self.temp.name)
  self.store=DraftStore(root/'drafts');d=self.store.create('# Check');self.account='account-123456789abc'
  self.d=self.store.save(d['id'],d['content'],{**d['metadata'],'wechat_account_id':self.account,'digest':'Explicit summary'},d['revision'])
  self.jobs=SyncJobs(root/'jobs')
  snapshot={'content':self.d['content'],'metadata':self.d['metadata'],'revision':self.d['revision'],'html':'<p>Check</p>','source_hash':'a'*64,'manifest':{'assets':[]},'render_version':RENDER_VERSION,'preflight_fingerprint':'b'*64}
  def interrupted(ctx):ctx.checkpoint(media_id='media',thumb_media_id='thumb',operation='create');ctx.emit('remote-write');raise UnknownRemoteResult()
  job=self.jobs.start(d['id'],self.account,snapshot,interrupted);self.job=self.jobs.wait_for(job['id']);self.raw=self.jobs.get(job['id'],True)
  self.api=SimpleNamespace(get_draft=lambda _: {'news_item':[expected_article(self.raw)]})
  self.workflow=SimpleNamespace(store=self.store,jobs=self.jobs,accounts=SimpleNamespace(publisher=lambda _:SimpleNamespace(api=self.api)))
 def test_readback_resolves_only_matching_snapshot_and_preserves_new_local_content(self):
  d=self.store.get(self.d['id']);self.store.save(d['id'],'# New input',d['metadata'],d['revision'])
  result=verify_job(self.workflow,self.job['id'])
  self.assertTrue(result['verified']);self.assertEqual(result['job']['state'],'succeeded')
  current=self.store.get(self.d['id']);self.assertEqual(current['content'],'# New input');self.assertEqual(current['publish']['draft_revision'],self.d['revision'])
 def test_changed_remote_and_read_failure_do_not_authorize_retry(self):
  self.api.get_draft=lambda _:{'news_item':[{**expected_article(self.raw),'content':'<p>Manual change</p>'}]}
  self.assertFalse(verify_job(self.workflow,self.job['id'])['verified'])
  self.assertEqual(self.jobs.get(self.job['id'])['state'],'uncertain')
  def fail(_):raise TimeoutError('secret request URL')
  self.api.get_draft=fail
  with self.assertRaises(EditorError) as error:verify_job(self.workflow,self.job['id'])
  self.assertNotIn('secret',str(error.exception));self.assertEqual(self.jobs.get(self.job['id'])['state'],'uncertain')

 def unknown_create(self):
  def interrupted(ctx):
   ctx.checkpoint(operation='create',thumb_media_id='thumb');ctx.emit('remote-write');raise UnknownRemoteResult()
  snapshot={**self.raw['snapshot'],'preflight_fingerprint':'d'*64}
  other=self.store.create('# Unknown create')
  job=self.jobs.start(other['id'],self.account,snapshot,interrupted);self.jobs.wait_for(job['id'])
  raw=self.jobs.get(job['id'],True)
  return job,raw

 def test_unknown_create_candidates_are_read_only_and_require_explicit_matching_media_id(self):
  job,raw=self.unknown_create();expected=expected_article(raw);reads=[]
  self.api.get_recent_drafts=lambda:{'item':[{'media_id':'candidate-id','update_time':123,'content':{'news_item':[expected]}},{'media_id':'changed-id','content':{'news_item':[{**expected,'title':'Another article'}]}}]}
  def get(media):
   reads.append(media);return {'news_item':[expected if media=='candidate-id' else {**expected,'title':'Changed'}]}
  self.api.get_draft=get
  candidates=reconciliation_candidates(self.workflow,job['id'])['items']
  self.assertEqual([c['matches_snapshot'] for c in candidates],[True,False])
  self.assertNotIn('content',candidates[0]);self.assertEqual(self.jobs.get(job['id'])['state'],'uncertain')
  self.assertFalse(verify_job(self.workflow,job['id'],media_id='changed-id')['verified'])
  self.assertEqual(self.jobs.get(job['id'])['state'],'uncertain')
  result=verify_job(self.workflow,job['id'],media_id='candidate-id')
  self.assertTrue(result['verified']);self.assertEqual(result['job']['state'],'succeeded')
  self.assertEqual(self.store.get_publish_state(job['draft_id'],self.account)['media_id'],'candidate-id')
  self.assertEqual(reads,['changed-id','candidate-id'])

 def test_known_remote_id_cannot_be_replaced_by_another_candidate(self):
  self.api.get_draft=lambda _:self.fail('Mismatched ID must fail before remote access')
  with self.assertRaises(EditorError):verify_job(self.workflow,self.job['id'],media_id='different-id')

 def test_resolution_race_never_changes_publish_state_after_a_job_was_resolved_elsewhere(self):
  def competing_resolution(_):
   self.jobs.resolve_uncertain(self.job['id'],outcome='failed')
   return {'news_item':[expected_article(self.raw)]}
  self.api.get_draft=competing_resolution
  from sync_jobs import SyncJobConflict
  with self.assertRaises(SyncJobConflict):verify_job(self.workflow,self.job['id'])
  self.assertFalse(self.store.get_publish_state(self.d['id'],self.account))

 def uncertain_with_assets(self):
  from test_asset_sync import PNG_BYTES
  draft=self.store.create('# Confirmed assets\n\n![figure](images/one.png)')
  for path in ('images/one.png','cover.png'):
   self.store.save_asset(draft['id'],path,base64.b64encode(PNG_BYTES).decode())
  draft=self.store.save(draft['id'],draft['content'],{**draft['metadata'],'wechat_account_id':self.account,'cover':'cover.png'},draft['revision'])
  digest=hashlib.sha256(PNG_BYTES).hexdigest();url='https://mmbiz.qpic.cn/test/confirmed.png'
  snapshot={'content':draft['content'],'metadata':draft['metadata'],'revision':draft['revision'],
            'html':'<p>Confirmed assets</p><img src="images/one.png">','source_hash':content_sha256(draft['content']),
            'manifest':{'assets':[{'path':path,'sha256':digest,'size':len(PNG_BYTES)} for path in ('images/one.png','cover.png')]},
            'render_version':RENDER_VERSION,'preflight_fingerprint':'c'*64}
  def interrupted(ctx):
   ctx.checkpoint(image_cache={digest:url},media_id='confirmed-media',thumb_media_id='confirmed-thumb',cover_sha256=digest,operation='create')
   ctx.emit('remote-write');raise UnknownRemoteResult()
  job=self.jobs.start(draft['id'],self.account,snapshot,interrupted);self.jobs.wait_for(job['id'])
  raw=self.jobs.get(job['id'],True)
  self.api.get_draft=lambda _:{'news_item':[expected_article(raw)]}
  return draft,job,raw,digest,url

 def test_verified_checkpoint_caches_survive_restart_and_prevent_material_reupload(self):
  draft,job,raw,digest,url=self.uncertain_with_assets()
  old_digest='e'*64;old_url='https://mmbiz.qpic.cn/test/older.png'
  self.store.save_publish_state(draft['id'],{'account_id':self.account,'image_cache':{old_digest:old_url},'thumb_media_id':'old-thumb','cover_sha256':'f'*64})
  writes=[]
  def forbidden_upload(*args):raise AssertionError('Confirmed material was uploaded again')
  self.api.upload_content_image=forbidden_upload;self.api.upload_thumb=forbidden_upload;self.api.add_draft=forbidden_upload
  self.api.update_draft=lambda media,article:writes.append((media,article))
  result=verify_job(self.workflow,job['id'])
  self.assertTrue(result['verified']);self.assertEqual(writes,[])
  restarted=DraftStore(self.store.root)
  persisted=restarted.get_publish_state(draft['id'],self.account)
  self.assertEqual(persisted['image_cache'],{old_digest:old_url,digest:url})
  self.assertEqual(persisted['thumb_media_id'],'confirmed-thumb')
  self.assertEqual(persisted['cover_sha256'],digest)
  current=restarted.get(draft['id'])
  WechatPublisher(self.api,account_id=self.account).sync(restarted,draft['id'],raw['snapshot']['html'],
    content_sha256(current['content']),current['metadata']['theme'],current['metadata']['palette'],
    typography={key:current['metadata'][key] for key in TYPOGRAPHY_VALUES})
  self.assertEqual(len(writes),1);self.assertEqual(writes[0][0],'confirmed-media')

 def test_verification_restores_only_original_account_progress_after_account_switch(self):
  draft,job,raw,digest,url=self.uncertain_with_assets()
  second='account-aaaaaaaaaaaa'
  self.store.save(draft['id'],'# New account draft',{**draft['metadata'],'wechat_account_id':second},draft['revision'])
  other={'account_id':second,'media_id':'other-media','image_cache':{'e'*64:'https://mmbiz.qpic.cn/test/other.png'},'thumb_media_id':'other-thumb','cover_sha256':'f'*64}
  self.store.save_publish_state(draft['id'],other)
  self.assertTrue(verify_job(self.workflow,job['id'])['verified'])
  current=self.store.get(draft['id'])
  self.assertEqual(current['content'],'# New account draft');self.assertEqual(current['publish'],other)
  restored=self.store.get_publish_state(draft['id'],self.account)
  self.assertEqual(restored['image_cache'],{digest:url});self.assertEqual(restored['thumb_media_id'],'confirmed-thumb')
  self.assertEqual(restored['cover_sha256'],digest)

 def test_changed_remote_does_not_install_checkpoint_caches_as_verified_state(self):
  draft,job,raw,digest,url=self.uncertain_with_assets()
  self.api.get_draft=lambda _:{'news_item':[{**expected_article(raw),'title':'Manual remote change'}]}
  self.assertFalse(verify_job(self.workflow,job['id'])['verified'])
  self.assertEqual(self.store.get_publish_state(draft['id'],self.account),{})
  self.assertEqual(self.jobs.get(job['id'])['state'],'uncertain')

 def test_incomplete_thumbnail_checkpoint_cannot_reuse_an_unrelated_old_cover_hash(self):
  self.store.save_publish_state(self.d['id'],{'account_id':self.account,'thumb_media_id':'unrelated-old-thumb','cover_sha256':'f'*64})
  self.assertTrue(verify_job(self.workflow,self.job['id'])['verified'])
  state=self.store.get_publish_state(self.d['id'],self.account)
  self.assertEqual(state['thumb_media_id'],'thumb')
  self.assertNotIn('cover_sha256',state)
if __name__=='__main__':unittest.main()
