"""HTTP workflow tests run an isolated loopback server with synthetic drafts."""
import base64
import io
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
import zipfile

ROOT=Path(__file__).resolve().parents[1]

class WorkflowAPI(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp=tempfile.TemporaryDirectory()
        cls.data=Path(cls.tmp.name)
        (cls.data/'archive').mkdir()
        (cls.data/'accounts.json').write_text(json.dumps({'version':1,'accounts':[{'id':'account-123456789abc','name':'Synthetic fail-closed account','app_id':'wxsynthetic','app_secret':'synthetic-fixture-only'}]}),'utf-8')
        with socket.socket() as s:
            s.bind(('127.0.0.1',0));port=s.getsockname()[1]
        cls.url=f'http://127.0.0.1:{port}'
        env={**os.environ,'ARCHIVE_PORT':str(port),'ARCHIVE_NO_OPEN':'1','WECHAT_DRAFTS_DIR':str(cls.data/'drafts'),'WECHAT_ARCHIVE_DIR':str(cls.data/'archive'),'WECHAT_ACCOUNTS_FILE':str(cls.data/'accounts.json'),'WECHAT_NETWORK_CONFIG':str(cls.data/'disabled-network.json')}
        cls.proc=subprocess.Popen([sys.executable,'-X','utf8','-B',str(ROOT/'app/web/server.py')],cwd=ROOT,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        for _ in range(100):
            try:
                with urllib.request.urlopen(cls.url+'/api/editor/config',timeout=.5) as r: cls.token=json.load(r)['csrf_token']
                break
            except (OSError,ValueError):
                if cls.proc.poll() is not None:raise RuntimeError(cls.proc.communicate()[1].decode('utf-8'))
                time.sleep(.05)
        else:raise RuntimeError('isolated server did not start')

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate();cls.proc.communicate(timeout=10);cls.tmp.cleanup()

    def request(self,path,data=None,method=None,auth=True,binary=False):
        headers={'X-Editor-Token':self.token} if auth else {}
        if data is not None:headers['Content-Type']='application/json'
        req=urllib.request.Request(self.url+path,data=None if data is None else json.dumps(data).encode(),headers=headers,method=method)
        try:
            with urllib.request.urlopen(req,timeout=5) as r:return r.status,r.read() if binary else json.load(r)
        except urllib.error.HTTPError as e:return e.code,json.load(e)

    def test_history_routes_require_auth_restore_as_copy(self):
        _,d=self.request('/api/editor/drafts',{'content':'# Original'})
        _,saved=self.request('/api/editor/drafts/'+d['id'],{'content':'# Changed','metadata':d['metadata'],'revision':d['revision']},'PUT')
        path='/api/editor/drafts/'+d['id']+'/history'
        self.assertEqual(self.request(path,auth=False)[0],403)
        status,versions=self.request(path)
        self.assertEqual(status,200)
        sid=versions['items'][0]['snapshot_id']
        status,result=self.request(path+'/'+sid+'/restore',{'revision':saved['revision']})
        self.assertEqual(status,201)
        self.assertNotEqual(result['draft']['id'],d['id'])
        self.assertEqual(result['draft']['content'],'# Original')

    def test_frontend_get_and_head_ignore_stale_validators_and_disable_heuristic_cache(self):
        for path in ['/editor/','/editor/assets/index-20261018-workflow.js','/editor/assets/editor-layout-20261018.css','/md-content.css','/vendor/highlight-ai-20261017.js']:
            for method in ['GET','HEAD']:
                for validators in [
                    {'If-Modified-Since':'Wed, 01 Jan 2099 00:00:00 GMT'},
                    {'If-None-Match':'"old-editor"'},
                    {'If-Modified-Since':'Wed, 01 Jan 2099 00:00:00 GMT','If-None-Match':'"old-editor"'},
                ]:
                    with self.subTest(path=path,method=method,validators=list(validators)):
                        req=urllib.request.Request(self.url+path,method=method,headers=validators)
                        try:
                            with urllib.request.urlopen(req,timeout=5) as response:
                                self.assertEqual(response.status,200)
                                self.assertEqual(response.headers.get('Cache-Control'),'no-store')
                                body=response.read()
                                self.assertEqual(bool(body),method=='GET')
                        except urllib.error.HTTPError as error:
                            self.fail('Mutable frontend returned a cached response: '+str(error.code))

    def test_soft_delete_and_restore_trash(self):
        _,d=self.request('/api/editor/drafts',{'content':'# Recycle'})
        self.assertEqual(self.request('/api/editor/drafts/'+d['id'],method='DELETE')[0],200)
        status,records=self.request('/api/editor/trash')
        self.assertEqual(status,200)
        entry=next(t for t in records['items'] if t['draft_id']==d['id'])
        status,_=self.request('/api/editor/trash/'+entry['trash_id']+'/restore',{})
        self.assertEqual(status,200)
        self.assertEqual(self.request('/api/editor/drafts/'+d['id'])[1]['content'],'# Recycle')

    def test_import_report_duplicate_prompt_and_export_excludes_account(self):
        upload={'filename':'synthetic.md','data':base64.b64encode('# Imported\n\n```python\nprint(1)\n```'.encode()).decode()}
        status,result=self.request('/api/editor/import',upload)
        self.assertEqual(status,201)
        self.assertEqual(result['report']['after']['fences'],1)
        self.assertEqual(self.request('/api/editor/import',upload)[0],409)
        upload['allow_duplicate']=True
        self.assertEqual(self.request('/api/editor/import',upload)[0],201)
        status,package=self.request('/api/editor/drafts/'+result['draft']['id']+'/export',binary=True)
        self.assertEqual(status,200)
        with zipfile.ZipFile(io.BytesIO(package)) as z:
            self.assertIn('article.md',z.namelist())
            self.assertNotIn('wechat_account_id',json.loads(z.read('metadata.json')))
            self.assertFalse(any('secret' in name or 'accounts' in name for name in z.namelist()))

    def test_permanent_trash_cleanup_requires_exact_confirmation_and_auth(self):
        _,d=self.request('/api/editor/drafts',{'content':'# Synthetic cleanup'})
        self.request('/api/editor/drafts/'+d['id'],method='DELETE')
        _,records=self.request('/api/editor/trash')
        entry=next(t for t in records['items'] if t['draft_id']==d['id'])
        path='/api/editor/trash/'+entry['trash_id']
        self.assertEqual(self.request(path,{'confirmation':entry['trash_id']},'DELETE',auth=False)[0],403)
        self.assertEqual(self.request(path,{'confirmation':'wrong'},'DELETE')[0],400)
        self.assertEqual(self.request(path,{'confirmation':entry['trash_id']},'DELETE')[0],200)
        self.assertFalse(any(t['trash_id']==entry['trash_id'] for t in self.request('/api/editor/trash')[1]['items']))

    def test_async_sync_requires_bound_preflight_and_network_guard_blocks_fixture(self):
        import hashlib
        _,d=self.request('/api/editor/drafts',{'content':'# Synthetic\n\nBody\n\n![图](images/x.png)'})
        png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg=='
        self.assertEqual(self.request('/api/editor/drafts/'+d['id']+'/assets',{'path':'images/x.png','data':png})[0],201)
        _,d=self.request('/api/editor/drafts/'+d['id'],{'content':d['content'],'metadata':{**d['metadata'],'cover':'images/x.png','wechat_account_id':'account-123456789abc','source_url':'https://example.org/source'},'revision':d['revision']},'PUT')
        html='<h1>Synthetic</h1><p>Body</p><img src="images/x.png">'
        _,config=self.request('/api/editor/config')
        payload={'html':html,'account_id':'account-123456789abc','render_version':config['render_version']}
        status,report=self.request('/api/editor/drafts/'+d['id']+'/preflight',payload)
        self.assertEqual(status,200);self.assertTrue(report['can_sync'])
        payload.update(source_hash=hashlib.sha256(d['content'].encode()).hexdigest(),theme=d['metadata']['theme'],palette=d['metadata']['palette'],typography={k:d['metadata'][k] for k in ('font_family','font_size','code_wrap','table_mode','caption_font_size','table_font_size')})
        self.assertEqual(self.request('/api/wechat/drafts/'+d['id']+'/sync',payload)[0],409)
        payload.update(preflight_fingerprint=report['fingerprint'],acknowledged=[i['id'] for i in report['issues'] if i['severity']=='confirm'])
        status,result=self.request('/api/wechat/drafts/'+d['id']+'/sync',payload)
        self.assertEqual(status,202);job_id=result['job']['id']
        for _ in range(50):
            status,result=self.request('/api/editor/sync-jobs/'+job_id)
            if result['job']['state'] not in ('queued','running'):break
            time.sleep(.05)
        self.assertEqual(result['job']['state'],'failed')
        self.assertNotIn('snapshot',result['job'])
        self.assertEqual(self.request('/api/editor/sync-jobs/'+job_id,auth=False)[0],403)

    def test_snapshot_and_asset_derivation_endpoints_preserve_original(self):
        _,d=self.request('/api/editor/drafts',{'content':'# Before'})
        status,result=self.request('/api/editor/drafts/'+d['id']+'/snapshot',{'content':'# Visible input','metadata':d['metadata'],'revision':d['revision'],'reason':'before-proofreading'})
        self.assertEqual(status,201)
        self.assertEqual(self.request('/api/editor/drafts/'+d['id'])[1]['content'],'# Before')
        status,_=self.request('/api/editor/drafts/'+d['id']+'/assets/download-remote',{'url':'http://127.0.0.1/private.png'})
        self.assertEqual(status,400)

if __name__=='__main__':unittest.main()
