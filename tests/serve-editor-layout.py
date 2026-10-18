"""Run real editor APIs with disposable synthetic drafts, without WeChat writes.

Usage: python tests/serve-editor-layout.py
Open http://127.0.0.1:19020/tests/editor-layout-browser.html .
No installed data, account credential, or external synchronization is used.
"""
from pathlib import Path
import json
import os
import sys
import tempfile
from http.server import ThreadingHTTPServer

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'app/web'))

with tempfile.TemporaryDirectory(prefix='publisher-layout-qa-') as data:
    folder=Path(data)
    (folder/'archive').mkdir()
    for key, value in {
        'WECHAT_DRAFTS_DIR':folder/'drafts', 'WECHAT_ACCOUNTS_FILE':folder/'private/accounts.json',
        'WECHAT_SYNC_JOBS_DIR':folder/'sync-jobs', 'WECHAT_ARCHIVE_DIR':folder/'archive',
        'WECHAT_NETWORK_CONFIG':'', 'WECHAT_ENABLE_DIRECT_PUBLISH':'',
    }.items(): os.environ[key]=str(value)
    import server
    content='# AI 技术文章排版验收\n\n'+('\n\n## 专业代码与技术引用\n\n这里测试编辑器的整页布局，不使用真实文章或公众号账号。\n\n```python\nimport torch\ndef inference(x):\n    return torch.softmax(x, dim=-1)\n```\n\n> 保留完整的编辑与预览空间。\n\n| 配置 | 值 |\n| --- | --- |\n| GPU | Example GPU |\n'*12)
    server.DRAFT_STORE.create(content, 'AI 技术文章 · 编辑布局验收')
    mutations=[]
    class Handler(server.Handler):
        # Only this disposable QA server permits its same-origin test harness.
        # Production server.py keeps its DENY / frame-ancestors 'none' policy.
        def send_header(self,key,value):
            if key.lower()=='x-frame-options':value='SAMEORIGIN'
            if key.lower()=='content-security-policy':value=value.replace("frame-ancestors 'none'","frame-ancestors 'self'")
            return super().send_header(key,value)
        def do_GET(self):
            if self.path=='/qa/state':return self.send_json({'mutations':mutations})
            if self.path.startswith('/tests/editor-layout-browser.'):
                name=self.path.split('?',1)[0].rsplit('/',1)[-1]
                if name in {'editor-layout-browser.html','editor-layout-browser.mjs'}:
                    payload=(ROOT/'tests'/name).read_bytes()
                    self.send_response(200)
                    self.send_header('Content-Type','text/html; charset=utf-8' if name.endswith('.html') else 'text/javascript; charset=utf-8')
                    self.send_header('Content-Length',str(len(payload)))
                    self.end_headers();self.wfile.write(payload);return
            return super().do_GET()
        def do_POST(self):
            mutations.append(['POST',self.path])
            if self.path.startswith('/api/wechat/') and self.path.endswith('/sync'):
                return self.send_error_json(403,'External sync disabled in layout acceptance')
            return super().do_POST()
        def do_PUT(self):
            mutations.append(['PUT',self.path]);return super().do_PUT()
        def do_DELETE(self):
            mutations.append(['DELETE',self.path]);return super().do_DELETE()
    http=ThreadingHTTPServer(('127.0.0.1',19020),Handler)
    print('Layout QA ready at http://127.0.0.1:19020/tests/editor-layout-browser.html',flush=True)
    try:http.serve_forever()
    except KeyboardInterrupt:pass
    finally:http.server_close()
