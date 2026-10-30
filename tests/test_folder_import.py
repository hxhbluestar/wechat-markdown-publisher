"""Folder imports preserve their selected Markdown and every original asset."""
import hashlib
import io
import http.client
import json
import os
import sys
import tempfile
import threading
import unittest
import zipfile
from pathlib import Path
from urllib.parse import quote,urlencode
from unittest.mock import patch
from http.server import ThreadingHTTPServer

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'app/web'))
from test_article_import import PNG
from article_import import ArticleImportError, prepare_import
from article_package import article_package
from editor_service import DraftStore,WechatPublisher,EditorError
try:
    import folder_import
except ModuleNotFoundError:
    folder_import = None

MP4 = b'\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom'

def archive(entries):
    stream=io.BytesIO()
    with zipfile.ZipFile(stream,'w',zipfile.ZIP_STORED) as z:
        for name,data in entries:
            info=zipfile.ZipInfo(name);info.filename=info.orig_filename=name
            z.writestr(info,data)
    return stream.getvalue()

class FolderImportTests(unittest.TestCase):
    def test_publisher_resolves_query_fragment_without_accepting_protocols(self):
        prepared=self.prepare()
        with tempfile.TemporaryDirectory() as tmp:
            store=DraftStore(Path(tmp)/'drafts');d=store.create_prepared(prepared['content'],prepared['metadata'],assets=prepared['assets'])
            publisher=WechatPublisher(object())
            expected=store.asset_path(d['id'],'assets/图 一.png')
            for source in ['assets/图%20一.png?v=1#figure',f'/api/editor/drafts/{d["id"]}/assets/assets/图%20一.png?v=1']:
                self.assertEqual(publisher._local_image(store,d['id'],source),expected)
            with self.assertRaises(EditorError):publisher._local_image(store,d['id'],'javascript:assets/图%20一.png')

    def prepare(self,content='# Article\n\n![图](assets/图%20一.png)',extras=()):
        self.assertIsNotNone(folder_import)
        return folder_import.prepare_folder_import(archive([('正文.md',content.encode()),('assets/图 一.png',PNG),*extras]),'正文.md','Folder')

    def test_preserves_markdown_and_all_original_files(self):
        prepared=self.prepare(extras=[('assets/unused.png',PNG),('assets/说明.md','仅附件'.encode()),('assets/demo.mp4',MP4)])
        self.assertEqual(prepared['content'],'# Article\n\n![图](assets/图%20一.png)')
        assets={a['name']:a['bytes'] for a in prepared['assets']}
        self.assertEqual(len(assets),4)
        self.assertEqual(assets['assets/demo.mp4'],MP4)
        self.assertEqual(prepared['metadata']['cover'],'assets/图 一.png')
        self.assertEqual(prepared['report']['video_count'],1)
        self.assertEqual(prepared['report']['attachment_count'],1)
        self.assertEqual(prepared['report']['image_count'],2)

    def test_references_handle_html_definitions_and_inert_code(self):
        content='# Ref\n\n![a][图]\n\n[图]: <assets/图 一.png>\n\n<img src="assets/图%20一.png">\n\n```md\n![missing](assets/not-here.png)\n```'
        self.assertEqual(self.prepare(content)['content'],content)
        with self.assertRaises(ArticleImportError):self.prepare('# Bad\n![x](assets/missing.png)')
        with self.assertRaises(ArticleImportError):self.prepare('# Bad\n![x](../outside.png)')
        with self.assertRaises(ArticleImportError):self.prepare('# Bad\n[video](assets/missing.mp4)')
        media=self.prepare('# Media\n![demo](assets/demo.mp4)',extras=[('assets/demo.mp4',MP4)])
        self.assertFalse(media['metadata'].get('cover'))
        with tempfile.TemporaryDirectory() as tmp:
            store=DraftStore(Path(tmp)/'drafts');d=store.create_prepared(media['content'],media['metadata'],assets=media['assets'])
            restored=prepare_import('video.zip',article_package(store,d['id']))
            self.assertEqual(restored['content'],media['content'])
            self.assertEqual(next(a['bytes'] for a in restored['assets'] if a['name']=='assets/demo.mp4'),MP4)
        for markup in ['<video src="assets/missing.mp4"></video>','<video><source src=assets/missing.mp4></video>',
                       '<video src="assets/demo.mp4" poster="assets/missing.png"></video>']:
            with self.subTest(markup=markup),self.assertRaises(ArticleImportError):self.prepare('# Missing\n'+markup,extras=[('assets/demo.mp4',MP4)])

    def test_rejects_unsafe_or_ambiguous_archives(self):
        self.assertIsNotNone(folder_import)
        for name in ['../escape.txt','assets/../escape.txt','assets/CON.txt','assets/nul/x','assets/a%2Fb.txt','assets/file.','assets/a\\b.txt','other.md']:
            with self.subTest(name=name),self.assertRaises(ArticleImportError):
                folder_import.prepare_folder_import(archive([('正文.md',b'# Body'),(name,b'x')]),'正文.md','Folder')
        with self.assertRaises(ArticleImportError):self.prepare(extras=[('assets/A.txt',b'a'),('assets/a.txt',b'b')])
        with self.assertRaises(ArticleImportError):self.prepare(extras=[('assets/fake.mp4',b'<html>not a video</html>')])

    def test_atomic_draft_history_copy_and_package_keep_attachments(self):
        prepared=self.prepare(extras=[('assets/说明.md',b'Notes'),('assets/demo.mp4',MP4)])
        with tempfile.TemporaryDirectory() as tmp:
            store=DraftStore(Path(tmp)/'drafts')
            d=store.create_prepared(prepared['content'],prepared['metadata'],'正文.md',assets=prepared['assets'],report=prepared['report'])
            original={a['name']:a['bytes'] for a in prepared['assets']}
            self.assertEqual({a['path'] for a in store.list_assets(d['id'])},set(original))
            copied=store.copy_draft(d['id'],d['content'],d['metadata'])
            for path,data in original.items():self.assertEqual(store.asset_path(copied['id'],path).read_bytes(),data)
            packed=article_package(store,d['id'])
            restored=prepare_import('publisher.zip',packed)
            restored_files={a['name']:a['bytes'] for a in restored['assets']}
            for path,data in original.items():self.assertEqual(restored_files[path],data)
            self.assertEqual(restored['content'],d['content'])
            before=len(store.list())
            with self.assertRaises(Exception):store.create_prepared('# Bad',{},assets=[{'name':'assets/fake.png','bytes':b'bad'}])
            self.assertEqual(len(store.list()),before)
            self.assertFalse(list(store.root.glob('.import-*')))
            store.delete(copied['id'])
            record=store.history.list_trash()[0]
            returned=store.history.restore_trash(record['trash_id'],store.root)
            for path,data in original.items():self.assertEqual(store.asset_path(returned,path).read_bytes(),data)

    def test_old_assets_reference_still_resolves_legacy_image(self):
        with tempfile.TemporaryDirectory() as tmp:
            store=DraftStore(Path(tmp)/'drafts');d=store.create('# Legacy\n![x](assets/old.png)')
            old=store._draft_dir(d['id'])/'images/assets/old.png';old.parent.mkdir(parents=True);old.write_bytes(PNG)
            self.assertEqual(store.asset_path(d['id'],'assets/old.png'),old.resolve())
            d=store.save(d['id'],d['content'],{**d['metadata'],'cover':'assets/old.png'},d['revision'])
            restored=prepare_import('legacy.zip',article_package(store,d['id']))
            self.assertEqual(len(restored['assets']),1)

    def test_file_count_boundary_and_empty_attachment_round_trip(self):
        prepared=self.prepare(extras=[(f'assets/n{i}.txt',b'') for i in range(510)])
        with tempfile.TemporaryDirectory() as tmp:
            store=DraftStore(Path(tmp)/'drafts')
            d=store.create_prepared(prepared['content'],prepared['metadata'],assets=prepared['assets'])
            restored=prepare_import('boundary.zip',article_package(store,d['id']))
            self.assertEqual(len(restored['assets']),511)
        with self.assertRaises(ArticleImportError):self.prepare(extras=[(f'assets/n{i}.txt',b'') for i in range(511)])

    def test_local_attachment_links_have_actionable_preflight_without_affecting_code(self):
        from server_preflight import preflight_article
        from article_package import RENDER_VERSION
        with tempfile.TemporaryDirectory() as tmp:
            store=DraftStore(Path(tmp)/'drafts')
            for source in ['[视频](assets/demo.mp4)','[说明][n]\n\n[n]: assets/notes.md','<video src="assets/demo.mp4"></video>']:
                d=store.create('# Media\n'+source)
                report=preflight_article(store,d,'<h1>Media</h1>',RENDER_VERSION,'')
                self.assertTrue(any(i['code'] in ('media-wechat-insert','attachment-local-link') for i in report['issues']),source)
            d=store.create('# Inert\n```md\n[视频](assets/demo.mp4)\n```')
            report=preflight_article(store,d,'<h1>Inert</h1>',RENDER_VERSION,'')
            self.assertFalse(any(i['code'] in ('media-wechat-insert','attachment-local-link') for i in report['issues']))
            p=self.prepare(extras=[('assets/notes.md',b'not a picture')]);d=store.create_prepared(p['content'],p['metadata'],assets=p['assets'])
            with self.assertRaises(EditorError):WechatPublisher(None)._local_image(store,d['id'],'assets/notes.md')


class FolderHTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp=tempfile.TemporaryDirectory();root=Path(cls.tmp.name)
        (root/'archive').mkdir()
        with patch.dict(os.environ,{'WECHAT_DRAFTS_DIR':str(root/'drafts'),'WECHAT_ARCHIVE_DIR':str(root/'archive'),'WECHAT_ACCOUNTS_FILE':str(root/'accounts.json'),'WECHAT_SYNC_JOBS_DIR':str(root/'jobs')}):
            import server
        cls.server=server
        cls.store=DraftStore(root/'drafts')
        cls.patchers=[patch.object(server,'DRAFT_STORE',cls.store),patch.object(server,'DRAFTS_DIR',cls.store.root),patch.object(server,'EDITOR_TOKEN','synthetic-folder-token')]
        for p in cls.patchers:p.start()
        class QuietHandler(server.Handler):
            def log_message(self,*args):pass
        cls.http=ThreadingHTTPServer(('127.0.0.1',0),QuietHandler)
        threading.Thread(target=cls.http.serve_forever,daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown();cls.http.server_close()
        for p in reversed(cls.patchers):p.stop()
        cls.tmp.cleanup()

    def call(self,method,path,data=None,headers=None):
        connection=http.client.HTTPConnection('127.0.0.1',self.http.server_port,timeout=5)
        connection.request(method,path,body=data,headers=headers or {})
        response=connection.getresponse();body=response.read();result=response.status,dict(response.getheaders()),body
        connection.close();return result

    def test_raw_folder_post_media_ranges_and_passive_download(self):
        data=archive([('article.md',b'# HTTP\n![x](assets/a.png)'),('assets/a.png',PNG),('assets/demo.mp4',MP4),('assets/notes.html',b'<script>alert(1)</script>')])
        path='/api/editor/import-folder?'+urlencode({'entry':'article.md','folder':'Folder'})
        status,headers,body=self.call('POST',path,data,{'Content-Type':'application/zip','X-Editor-Token':'synthetic-folder-token'})
        self.assertEqual(status,201,body);draft=json.loads(body)['draft'];base='/api/editor/drafts/'+draft['id']+'/assets/'
        status,headers,body=self.call('GET',base+'assets/demo.mp4',headers={'Range':'bytes=0-7'})
        self.assertEqual((status,body),(206,MP4[:8]));self.assertEqual(headers['Content-Range'],f'bytes 0-7/{len(MP4)}')
        status,headers,body=self.call('HEAD',base+'assets/demo.mp4')
        self.assertEqual((status,body),(200,b''));self.assertEqual(headers['Accept-Ranges'],'bytes')
        self.assertEqual(self.call('GET',base+'assets/demo.mp4',headers={'Range':'bytes=999-'})[0],416)
        status,headers,body=self.call('GET',base+'assets/notes.html')
        self.assertEqual(status,200);self.assertEqual(headers['Content-Type'],'application/octet-stream')
        self.assertTrue(headers['Content-Disposition'].startswith('attachment;'));self.assertEqual(headers['X-Content-Type-Options'],'nosniff')

    def test_raw_import_auth_limits_and_missing_files_are_atomic(self):
        data=archive([('article.md',b'# Missing\n![x](assets/missing.png)')]);path='/api/editor/import-folder?entry=article.md'
        before=len(self.store.list())
        self.assertEqual(self.call('POST',path,data,{'Content-Type':'application/zip'})[0],403)
        headers={'Content-Type':'application/zip','X-Editor-Token':'synthetic-folder-token'}
        self.assertEqual(self.call('POST',path,data,headers)[0],400)
        self.assertEqual(len(self.store.list()),before)
        self.assertEqual(self.call('POST',path,b'',{**headers,'Content-Length':str(folder_import.MAX_FOLDER_BYTES+1)})[0],413)

    def test_large_portable_package_uses_raw_transport_with_duplicate_guard(self):
        payload=hashlib.shake_256(b'synthetic-folder-transport').digest(14*1024*1024)
        data=archive([('article.md',b'# Large package\n![x](assets/a.png)'),('assets/a.png',PNG),('assets/data.bin',payload),('assets/empty.txt',b'')])
        prepared=folder_import.prepare_folder_import(data,'article.md','Large')
        with tempfile.TemporaryDirectory() as tmp:
            source=DraftStore(Path(tmp)/'drafts');draft=source.create_prepared(prepared['content'],prepared['metadata'],assets=prepared['assets'])
            packed=article_package(source,draft['id'])
        self.assertGreater(len(packed),14*1024*1024)
        headers={'Content-Type':'application/zip','X-Editor-Token':'synthetic-folder-token'}
        path='/api/editor/import-package?filename=article-package.zip'
        status,_,body=self.call('POST',path+'&preview_only=1',packed,headers)
        self.assertEqual(status,200,body);self.assertIn('report',json.loads(body))
        status,_,body=self.call('POST',path,packed,headers)
        self.assertEqual(status,201,body)
        imported=json.loads(body)['draft']
        self.assertEqual(self.store.asset_path(imported['id'],'assets/data.bin').stat().st_size,14*1024*1024)
        self.assertEqual(self.call('POST',path,packed,headers)[0],409)
        self.assertEqual(self.call('POST',path+'&allow_duplicate=1',packed,headers)[0],201)

if __name__=='__main__':unittest.main()
