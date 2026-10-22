"""Real Caddy route tests; set CADDY_EXE to an official verified binary.

Uses only loopback HTTP and disposable synthetic credentials. Production TLS
is verified separately against the deployed server certificate.
"""
import base64,json,os,secrets,socket,subprocess,tempfile,threading,time,unittest,urllib.request,urllib.error
from pathlib import Path
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
ROOT=Path(__file__).resolve().parents[1]
CADDY=os.environ.get('CADDY_EXE','')

def free_port():
    with socket.socket() as s:s.bind(('127.0.0.1',0));return s.getsockname()[1]

@unittest.skipUnless(CADDY and Path(CADDY).is_file(),'Set CADDY_EXE for real gateway integration')
class GatewayContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory(prefix='publisher-gateway-')
        cls.work=Path(cls.temp.name);cls.port=free_port();cls.password=secrets.token_urlsafe(18)
        class Backend(BaseHTTPRequestHandler):
            def do_GET(self):
                body=json.dumps({'host':self.headers.get('Host'),'origin':self.headers.get('Origin'),'authorization':self.headers.get('Authorization'),'token':self.headers.get('X-Editor-Token')}).encode()
                self.send_response(200);self.end_headers();self.wfile.write(body)
            def do_POST(self):self.do_GET()
            def log_message(self,*args):pass
        cls.backend=ThreadingHTTPServer(('127.0.0.1',0),Backend)
        threading.Thread(target=cls.backend.serve_forever,daemon=True).start()
        cls.origin=f'http://127.0.0.1:{cls.port}'
        h=subprocess.run([CADDY,'hash-password','--bcrypt-cost','4'],input=cls.password.encode()+b'\n',capture_output=True,check=True).stdout.decode().strip()
        env={**os.environ,'PUBLISHER_LISTEN_IP':'127.0.0.1','PUBLISHER_HTTPS_PORT':str(cls.port),'PUBLISHER_BACKEND_PORT':str(cls.backend.server_port),'PUBLISHER_LOGIN_USER':'synthetic','PUBLISHER_PASSWORD_HASH':h,'PUBLISHER_ORIGIN':cls.origin}
        adapted=subprocess.run([CADDY,'adapt','--config',str(ROOT/'packaging/server/Caddyfile'),'--adapter','caddyfile'],env=env,capture_output=True,check=True)
        config=json.loads(adapted.stdout);config['apps'].pop('tls',None)
        for srv in config['apps']['http']['servers'].values():
            srv.pop('tls_connection_policies',None);srv['automatic_https']={'disable':True}
        (cls.work/'config.json').write_text(json.dumps(config),'utf-8')
        cls.log=(cls.work/'gateway.log').open('wb')
        cls.proc=subprocess.Popen([CADDY,'run','--config',str(cls.work/'config.json')],stdout=cls.log,stderr=cls.log,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        for attempt in range(60):
            try:
                with socket.create_connection(('127.0.0.1',cls.port),timeout=.1):break
            except OSError:time.sleep(.05)
        else:raise RuntimeError('Synthetic Caddy fixture did not start')

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate();cls.proc.wait(timeout=10);cls.log.close();cls.backend.shutdown();cls.backend.server_close();cls.temp.cleanup()

    def call(self,method='GET',headers=None,auth=True):
        h={'X-Editor-Token':'synthetic-csrf'}
        if auth:h['Authorization']='Basic '+base64.b64encode(('synthetic:'+self.password).encode()).decode()
        h.update(headers or {})
        req=urllib.request.Request(self.origin+'/editor/',data=b'{}' if method=='POST' else None,method=method,headers=h)
        try:
            with urllib.request.urlopen(req,timeout=5) as r:return r.status,json.load(r)
        except urllib.error.HTTPError as e:return e.code,None

    def test_authentication_covers_all_paths(self):
        self.assertEqual(self.call(auth=False)[0],401)
        self.assertEqual(self.call(headers={'Authorization':'Basic '+base64.b64encode(b'synthetic:wrong').decode()})[0],401)

    def test_cross_site_navigation_allowed_but_mutations_rejected(self):
        self.assertEqual(self.call(headers={'Sec-Fetch-Site':'cross-site','Sec-Fetch-Mode':'navigate'})[0],200)
        self.assertEqual(self.call('POST',{'Sec-Fetch-Site':'cross-site'})[0],403)
        self.assertEqual(self.call('POST',{'Origin':'https://foreign.example'})[0],403)

    def test_same_origin_csrf_and_backend_headers_preserved(self):
        status,body=self.call('POST',{'Origin':self.origin})
        self.assertEqual(status,200)
        self.assertEqual(body['host'],f'127.0.0.1:{self.backend.server_port}')
        self.assertEqual(body['origin'],f'http://127.0.0.1:{self.backend.server_port}')
        self.assertEqual(body['token'],'synthetic-csrf');self.assertIsNone(body['authorization'])
