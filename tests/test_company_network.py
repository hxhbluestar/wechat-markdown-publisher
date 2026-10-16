"""Company egress guard: real policy logic, external network operations doubled."""
import contextlib
import io
import json
import os
import struct
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'app' / 'web'))
from company_network import CompanyConfig, CompanyDirectTransport, CompanyNetworkError, connect_ipv4
from editor_service import WechatOpenAPI, EditorError

BINDING = {'interface_index': 14, 'source_ip': '192.0.2.23', 'gateway': '192.0.2.1', 'hardware': True}

class Response(io.BytesIO):
    status = 200

class FakeConnection:
    def __init__(self, host, *, timeout, binding):
        self.host = host
        self.binding = binding
        self.closed = False
        self.path = ''
        self.calls = []
    def request(self, method, path, body=None, headers=None):
        self.path = path
        self.calls.append((method, path, body, headers))
    def getresponse(self):
        payload = b'8.8.8.8' if self.host != 'api.weixin.qq.com' else b'{"ok":true}'
        return Response(payload)
    def close(self):
        self.closed = True

class CompanyNetworkTests(unittest.TestCase):
    def setUp(self):
        self.connections = []
        def factory(host, **kwargs):
            result = FakeConnection(host, **kwargs)
            self.connections.append(result)
            return result
        self.factory = factory
        self.config = CompanyConfig('8.8.8.8', 'WLAN', '192.0.2.1')
        self.network = CompanyDirectTransport(self.config, binding_provider=lambda config: dict(BINDING), connection_factory=factory)

    def test_matching_ip_allows_api_and_ignores_proxy_environment(self):
        import urllib.request
        with patch.dict(os.environ, {'HTTPS_PROXY':'http://127.0.0.1:9','ALL_PROXY':'http://127.0.0.1:9'}):
            with self.network.open(urllib.request.Request('https://api.weixin.qq.com/cgi-bin/stable_token', data=b'{}'), timeout=3) as response:
                self.assertEqual(json.loads(response.read()), {'ok':True})
        self.assertEqual(self.network.status()['state'], 'verified')
        self.assertEqual(self.network.status()['observed_public_ip'], '8.8.8.8')
        self.assertTrue(all(connection.closed for connection in self.connections))
        self.assertEqual(self.connections[-1].binding['interface_index'], 14)

    def test_wrong_egress_blocks_before_api_connection(self):
        import urllib.request
        original = FakeConnection.getresponse
        def different(connection):
            return Response(b'9.9.9.9') if connection.host != 'api.weixin.qq.com' else original(connection)
        with patch.object(FakeConnection, 'getresponse', different):
            with self.assertRaisesRegex(CompanyNetworkError, '9.9.9.9'):
                with self.network.open(urllib.request.Request('https://api.weixin.qq.com/cgi-bin/stable_token', data=b'secret'), timeout=3):
                    pass
        self.assertFalse(any(connection.host == 'api.weixin.qq.com' for connection in self.connections))
        self.assertEqual(self.network.status()['state'], 'blocked')

    def test_probe_failure_never_falls_back_to_system_proxy(self):
        import urllib.request
        with patch.object(FakeConnection, 'getresponse', side_effect=OSError('offline')):
            with patch('urllib.request.urlopen', side_effect=AssertionError('Proxy fallback forbidden')):
                with self.assertRaises(CompanyNetworkError):
                    with self.network.open(urllib.request.Request('https://api.weixin.qq.com/cgi-bin/stable_token'), timeout=3):
                        pass
        self.assertTrue(all(connection.closed for connection in self.connections))

    def test_route_change_is_checked_again_after_success(self):
        self.network.check(timeout=3)
        with patch.object(FakeConnection, 'getresponse', return_value=Response(b'1.1.1.1')):
            with self.assertRaises(CompanyNetworkError):
                self.network.check(timeout=3)
        self.assertEqual(self.network.status()['state'], 'blocked')

    def test_gateway_or_virtual_adapter_change_blocks_before_any_probe(self):
        for changes in ({'gateway':'10.0.0.1'}, {'hardware':False}):
            with self.subTest(changes=changes):
                network = CompanyDirectTransport(self.config, binding_provider=lambda config: {**BINDING, **changes}, connection_factory=self.factory)
                with self.assertRaises(CompanyNetworkError):
                    network.check(timeout=3)
        self.assertEqual(self.connections, [])

    def test_untrusted_destinations_and_redirects_are_rejected(self):
        import urllib.request
        for url in ('http://api.weixin.qq.com/a', 'https://evil.invalid/a', 'https://api.weixin.qq.com:444/a'):
            with self.subTest(url=url), self.assertRaises(CompanyNetworkError):
                with self.network.open(urllib.request.Request(url), timeout=3):
                    pass
        with patch.object(Response, 'status', 302):
            with self.assertRaises(CompanyNetworkError):
                self.network.check(timeout=3)

    def test_both_json_and_upload_use_guard_and_send_no_request_when_blocked(self):
        import tempfile
        blocked = CompanyDirectTransport(self.config, binding_provider=lambda config: {**BINDING, 'gateway':'10.0.0.1'}, connection_factory=self.factory)
        with patch('company_network.from_environment', return_value=blocked), patch('urllib.request.urlopen', side_effect=AssertionError('Legacy transport forbidden')):
            api = WechatOpenAPI('test-app-id', 'test-secret')
            with self.assertRaisesRegex(EditorError, '公司直连'):
                api.validate_credentials()
            with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as temp:
                image = Path(temp) / 'a.png'
                image.write_bytes(b'png')
                api._access_token = 'cached-token'
                api._token_deadline = float('inf')
                with self.assertRaisesRegex(EditorError, '公司直连'):
                    api.upload_content_image(image)
        self.assertEqual(self.connections, [])

    def test_socket_is_pinned_to_ipv4_interface_before_connection(self):
        import socket
        class Sock:
            def __init__(self): self.events=[]
            def settimeout(self, value): self.events.append(('timeout', value))
            def setsockopt(self, level, option, value): self.events.append(('option', level, option, value))
            def bind(self, address): self.events.append(('bind', address))
            def connect(self, address): self.events.append(('connect', address))
            def getsockname(self): return ('192.0.2.23', 50000)
            def close(self): self.events.append(('close',))
        sock = Sock()
        with patch('company_network.socket.socket', return_value=sock), patch('company_network.socket.getaddrinfo', return_value=[(socket.AF_INET,socket.SOCK_STREAM,0,'',('101.91.37.13',443))]):
            self.assertIs(connect_ipv4(('api.weixin.qq.com',443),3,BINDING),sock)
        self.assertIn(('option',socket.IPPROTO_IP,31,struct.pack('!I',14)),sock.events)
        self.assertLess(sock.events.index(('bind',('192.0.2.23',0))),sock.events.index(('connect',('101.91.37.13',443))))

    def test_private_or_vpn_fake_dns_answer_is_rejected(self):
        import socket
        for address in ('127.0.0.1','10.0.0.2','198.18.0.1'):
            with self.subTest(address=address), patch('company_network.socket.getaddrinfo', return_value=[(socket.AF_INET,socket.SOCK_STREAM,0,'',(address,443))]), patch('company_network.socket.socket') as factory:
                with self.assertRaises(CompanyNetworkError):
                    connect_ipv4(('api.weixin.qq.com',443),3,BINDING)
                factory.assert_not_called()

    def test_configuration_corruption_and_deletion_fail_closed(self):
        import tempfile
        import company_network
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as temp:
            config = Path(temp) / 'network.json'
            with patch.dict(os.environ, {'WECHAT_NETWORK_CONFIG':str(config)}):
                for content in ('[]', '{', '{"mode":"company_direct"}', '{"mode":"typo"}'):
                    config.write_text(content, encoding='utf-8')
                    with self.subTest(content=content), self.assertRaises(CompanyNetworkError):
                        company_network.from_environment()
                config.unlink()
                with self.assertRaises(CompanyNetworkError):
                    company_network.from_environment()

    def test_json_and_multipart_succeed_via_company_transport_with_cached_token(self):
        import tempfile
        with patch('company_network.from_environment', return_value=self.network), patch('urllib.request.urlopen', side_effect=AssertionError('Proxy forbidden')):
            api = WechatOpenAPI('test-app-id', 'test-secret')
            api._access_token, api._token_deadline = 'cached-token', float('inf')
            self.assertEqual(api._post('/cgi-bin/draft/add', {'articles':[]}), {'ok':True})
            with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as temp:
                image = Path(temp) / 'a.png'
                image.write_bytes(b'image-fixture')
                self.assertEqual(api._upload('/cgi-bin/media/uploadimg', image), {'ok':True})
        api_calls = [c.calls[0] for c in self.connections if c.host == 'api.weixin.qq.com']
        self.assertEqual(len(api_calls), 2)
        self.assertIn(b'image-fixture', api_calls[1][2])
        self.assertEqual(len([c for c in self.connections if c.host != 'api.weixin.qq.com']), 2)

    def test_api_tls_failure_closes_connection_and_never_falls_back(self):
        import ssl
        import urllib.request
        original = FakeConnection.getresponse
        def response(connection):
            if connection.host == 'api.weixin.qq.com':
                raise ssl.SSLCertVerificationError('certificate rejected')
            return original(connection)
        with patch.object(FakeConnection, 'getresponse', response), patch('urllib.request.urlopen', side_effect=AssertionError('Fallback forbidden')):
            with self.assertRaises(CompanyNetworkError):
                with self.network.open(urllib.request.Request('https://api.weixin.qq.com/cgi-bin/draft/add'), timeout=3):
                    pass
        self.assertTrue(all(c.closed for c in self.connections))
        self.assertEqual(self.network.status()['state'], 'blocked')

if __name__ == '__main__':
    unittest.main()
