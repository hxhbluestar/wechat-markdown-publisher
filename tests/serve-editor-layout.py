"""Run real editor APIs with disposable synthetic drafts, without WeChat writes.

Usage: python tests/serve-editor-layout.py
Open http://127.0.0.1:19020/tests/editor-layout-browser.html .
For direct Markdown import and advisory-sync acceptance, add --workflow-simple
and open http://127.0.0.1:19020/tests/workflow-simple-browser.html .
No installed data, account credential, or external synchronization is used.
"""
from pathlib import Path
import argparse
import json
import os
import re
import sys
import tempfile
from http.server import ThreadingHTTPServer

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'app/web'))
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--workflow-simple', action='store_true')
args=parser.parse_args()

with tempfile.TemporaryDirectory(prefix='publisher-layout-qa-') as data:
    folder=Path(data)
    (folder/'archive').mkdir()
    if args.workflow_simple:
        (folder/'private').mkdir()
        (folder/'private/accounts.json').write_text(json.dumps({
            'version':1,
            'accounts':[{'id':'account-123456789abc','name':'Synthetic workflow account',
                         'app_id':'wxsynthetic','app_secret':'synthetic-fixture-only'}],
        }),'utf-8')
    for key, value in {
        'WECHAT_DRAFTS_DIR':folder/'drafts', 'WECHAT_ACCOUNTS_FILE':folder/'private/accounts.json',
        'WECHAT_SYNC_JOBS_DIR':folder/'sync-jobs', 'WECHAT_ARCHIVE_DIR':folder/'archive',
        'WECHAT_NETWORK_CONFIG':'', 'WECHAT_ENABLE_DIRECT_PUBLISH':'',
    }.items(): os.environ[key]=str(value)
    import server
    content='# AI 技术文章排版验收\n\n'+('\n\n## 专业代码与技术引用\n\n这里测试编辑器的整页布局，不使用真实文章或公众号账号。\n\n```python\nimport torch\ndef inference(x):\n    return torch.softmax(x, dim=-1)\n```\n\n> 保留完整的编辑与预览空间。\n\n| 配置 | 值 |\n| --- | --- |\n| GPU | Example GPU |\n'*12)
    server.DRAFT_STORE.create(content, 'AI 技术文章 · 编辑布局验收')
    workflow_seed=None
    if args.workflow_simple:
        simple_content='# 建议不阻断同步验收\n\n这里有按装错字，以及 TODO 待检查项。来源留空，作者可以稍后处理建议。\n\n参阅 [ROCm 文档](https://rocm.docs.amd.com/)，正文链接应使用引用编号。\n\n```python\nprint("synthetic acceptance only")\n```'
        seed=server.DRAFT_STORE.create(simple_content, '建议不阻断同步验收')
        png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg=='
        server.DRAFT_STORE.save_asset(seed['id'], 'cover.png', png)
        seed=server.DRAFT_STORE.save(seed['id'], seed['content'], {
            **seed['metadata'],'cover':'cover.png','wechat_account_id':'account-123456789abc','source_url':'',
        }, seed['revision'])
        workflow_seed={'draft_id':seed['id'],'title':seed['metadata']['title'],
                       'content':simple_content,'account_id':'account-123456789abc'}
    mutations=[]
    sync_requests=[]
    class Handler(server.Handler):
        # Only this disposable QA server permits its same-origin test harness.
        # Production server.py keeps its DENY / frame-ancestors 'none' policy.
        def send_header(self,key,value):
            if key.lower()=='x-frame-options':value='SAMEORIGIN'
            if key.lower()=='content-security-policy':value=value.replace("frame-ancestors 'none'","frame-ancestors 'self'")
            if key.lower()=='content-security-policy' and self.path.startswith('/tests/'):
                # Match the real editor's inline-style policy for rendered articles.
                value=value.replace("style-src 'self';", "style-src 'self' 'unsafe-inline';")
                value=value.replace("script-src 'self';", f"script-src 'self'{server.EDITOR_IMPORT_MAP_CSP};")
            return super().send_header(key,value)
        def do_GET(self):
            if self.path=='/qa/state':
                state={'mutations':mutations}
                if args.workflow_simple:
                    state.update(workflow_seed=workflow_seed,sync_requests=sync_requests)
                return self.send_json(state)
            if self.path.startswith('/tests/'):
                name=self.path.split('?',1)[0].rsplit('/',1)[-1]
                if name in {'preview-paper-browser.html','preview-paper-browser.mjs','table-mobile-browser.html','table-mobile-browser.mjs','editor-layout-browser.html','editor-layout-browser.mjs','table-layout-browser.html','table-layout-browser.mjs','typography-browser.html','typography-browser.mjs','publishing-browser.html','publishing-browser.mjs','code-highlighting-browser.html','code-highlighting-browser.mjs','code-samples.mjs','published-code-text.mjs','workflow-simple-browser.html','workflow-simple-browser.mjs'}:
                    payload=(ROOT/'tests'/name).read_bytes()
                    if name.endswith('.html'):
                        payload=payload.replace(b'/editor/typography-browser.mjs',b'/tests/typography-browser.mjs').replace(b'/editor/code-highlighting-browser.mjs',b'/tests/code-highlighting-browser.mjs')
                        current_map=re.search(rb'<script type="importmap">.*?</script>',(ROOT/'app/web/editor/index.html').read_bytes(),re.S).group()
                        payload=re.sub(rb'<script type="importmap">.*?</script>',current_map,payload,flags=re.S)
                    self.send_response(200)
                    self.send_header('Content-Type','text/html; charset=utf-8' if name.endswith('.html') else 'text/javascript; charset=utf-8')
                    self.send_header('Content-Length',str(len(payload)))
                    self.end_headers();self.wfile.write(payload);return
            return super().do_GET()
        def do_POST(self):
            mutations.append(['POST',self.path])
            if self.path.startswith('/api/wechat/') and self.path.endswith('/sync'):
                if args.workflow_simple:
                    payload=self.read_json_body()
                    sync_requests.append({'path':self.path,'account_id':payload.get('account_id'),
                                          'acknowledged':payload.get('acknowledged'),
                                          'preflight_fingerprint':payload.get('preflight_fingerprint')})
                return self.send_error_json(403,'External sync disabled in layout acceptance')
            return super().do_POST()
        def do_PUT(self):
            mutations.append(['PUT',self.path]);return super().do_PUT()
        def do_DELETE(self):
            mutations.append(['DELETE',self.path]);return super().do_DELETE()
    http=ThreadingHTTPServer(('127.0.0.1',19020),Handler)
    acceptance='workflow-simple-browser.html' if args.workflow_simple else 'editor-layout-browser.html'
    print('Layout QA ready at http://127.0.0.1:19020/tests/'+acceptance,flush=True)
    try:http.serve_forever()
    except KeyboardInterrupt:pass
    finally:http.server_close()
