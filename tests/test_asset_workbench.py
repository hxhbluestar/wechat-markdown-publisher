"""Original raster fixtures and fake HTTPS transport, with no real network."""
from __future__ import annotations

import hashlib
import io
import socket
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'app/web'))
try:
    import asset_workbench
except ModuleNotFoundError:
    asset_workbench = None


def raster(width=120, height=80, mode='RGBA', color=(30, 100, 200, 255), format='PNG'):
    stream = io.BytesIO()
    Image.new(mode, (width, height), color).save(stream, format=format)
    return stream.getvalue()


def gif(frames=305):
    images = []
    for index in range(frames):
        image = Image.new('P', (12, 8), 0)
        palette = [0, 0, 0, 255, 0, 0, 0, 255, 0] + [0] * (768 - 9)
        image.putpalette(palette)
        for dx in range(3):
            for dy in range(3):
                image.putpixel(((index + dx) % 12, ((index // 12) + dy) % 8), 1 + index % 2)
        images.append(image)
    stream = io.BytesIO()
    images[0].save(stream, format='GIF', save_all=True, append_images=images[1:],
                   duration=[20 + 10 * (i % 3) for i in range(frames)], loop=2,
                   transparency=0, disposal=2, optimize=False)
    return stream.getvalue()


class Response(io.BytesIO):
    def __init__(self, body=b'', *, status=200, headers=None):
        super().__init__(body)
        self.status = status
        self.headers = headers or {'Content-Type': 'image/png'}

    def getheader(self, name, default=None):
        return next((value for key, value in self.headers.items() if key.lower() == name.lower()), default)


PUBLIC = [(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, '', ('8.8.8.8', 443))]


class Network:
    def __init__(self, routes=None, answers=None):
        self.routes = routes or {('images.example.test', '/image.png'): Response(raster())}
        self.answers = answers or {'images.example.test': PUBLIC}
        self.resolutions, self.connections, self.requests = [], [], []
        self.response_reads = 0

    def resolve(self, host, port, **kwargs):
        self.resolutions.append((host, port))
        return self.answers[host]

    def connection(self, host, *, timeout, addresses):
        network = self
        class Connection:
            closed = False

            def request(self, method, path, headers):
                network.requests.append((host, method, path, headers))
                self.path = path

            def getresponse(self):
                network.response_reads += 1
                return network.routes[(host, self.path)]

            def close(self):
                self.closed = True
        connection = Connection()
        self.connections.append((host, timeout, addresses, connection))
        return connection


class AssetWorkbenchTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(asset_workbench, 'The image workbench module is missing')

    def test_inspection_identifies_dimensions_hash_and_duplicate_originals(self):
        data = raster()
        first = asset_workbench.inspect_image(data)
        second = asset_workbench.inspect_image(bytes(data))
        self.assertEqual((first['width'], first['height'], first['format'], first['frames']), (120, 80, 'PNG', 1))
        self.assertEqual(first['size'], len(data))
        self.assertEqual(first['sha256'], hashlib.sha256(data).hexdigest())
        self.assertEqual(first['sha256'], second['sha256'])

    def test_diagram_default_is_lossless_and_preserves_transparent_pixels(self):
        data = raster(color=(25, 150, 230, 80))
        result = asset_workbench.derive_image(data, mode='diagram')
        self.assertEqual((result['mime'], result['extension']), ('image/png', '.png'))
        with Image.open(io.BytesIO(data)) as original, Image.open(io.BytesIO(result['bytes'])) as derived:
            self.assertEqual(derived.size, original.size)
            self.assertEqual(derived.convert('RGBA').tobytes(), original.convert('RGBA').tobytes())
        self.assertEqual(result['metadata']['source_hash'], hashlib.sha256(data).hexdigest())
        self.assertEqual(result['metadata']['derived_hash'], hashlib.sha256(result['bytes']).hexdigest())

    def test_photo_compression_and_explicit_downsize_return_derived_bytes_only(self):
        data = raster(width=600, height=400)
        original = bytes(data)
        result = asset_workbench.derive_image(data, mode='photo', options={'quality': 75, 'max_width': 300})
        self.assertEqual((result['mime'], result['extension']), ('image/jpeg', '.jpg'))
        with Image.open(io.BytesIO(result['bytes'])) as derived:
            self.assertEqual(derived.size, (300, 200))
        self.assertEqual(data, original)
        self.assertTrue(result['metadata']['operations'])

    def test_cover_crop_obeys_ratio_focal_point_and_records_safe_area(self):
        source = Image.new('RGB', (400, 200), 'blue')
        for x in range(300, 400):
            for y in range(200):
                source.putpixel((x, y), (255, 0, 0))
        stream = io.BytesIO()
        source.save(stream, format='PNG')
        data = stream.getvalue()
        result = asset_workbench.derive_image(data, mode='cover', options={'ratio': 1, 'focal_point': [1, 0.5]})
        with Image.open(io.BytesIO(result['bytes'])) as derived:
            self.assertEqual(derived.size, (200, 200))
            self.assertEqual(derived.convert('RGB').getpixel((199, 100)), (255, 0, 0))
        self.assertEqual(result['metadata']['crop_box'], [200, 0, 400, 200])
        self.assertEqual(result['metadata']['safe_area']['normalized'], [0.1, 0.1, 0.9, 0.9])
        wide = asset_workbench.derive_image(data, mode='cover', options={'ratio': 2.35})
        with Image.open(io.BytesIO(wide['bytes'])) as derived:
            self.assertLess(abs(derived.width / derived.height - 2.35), 0.02)

    def test_gif_preset_limits_frames_and_preserves_duration_loop_and_transparency(self):
        data = gif()
        before = asset_workbench.inspect_image(data)
        result = asset_workbench.derive_image(data, mode='gif')
        after = asset_workbench.inspect_image(result['bytes'])
        self.assertEqual(before['frames'], 305)
        self.assertLessEqual(after['frames'], 300)
        self.assertEqual(after['duration_ms'], before['duration_ms'])
        self.assertEqual(after['loop'], 2)
        self.assertTrue(after['transparency'])
        self.assertEqual((result['mime'], result['extension']), ('image/gif', '.gif'))
        self.assertIn('compatibility', str(result['metadata']).lower())

    def test_gif_explicit_frame_target_does_not_flatten_animation(self):
        data = gif(20)
        result = asset_workbench.derive_image(data, mode='gif', options={'max_frames': 7, 'max_width': 6})
        after = asset_workbench.inspect_image(result['bytes'])
        self.assertGreater(after['frames'], 1)
        self.assertLessEqual(after['frames'], 7)
        self.assertEqual(after['width'], 6)
        self.assertEqual(after['duration_ms'], asset_workbench.inspect_image(data)['duration_ms'])

    def test_animated_input_cannot_accidentally_be_flattened_by_photo_or_diagram(self):
        for mode in ['photo', 'diagram', 'cover']:
            with self.subTest(mode=mode), self.assertRaises(asset_workbench.AssetWorkbenchError):
                asset_workbench.derive_image(gif(3), mode=mode)

    def test_invalid_image_svg_oversize_and_invalid_options_are_explicit_errors(self):
        for data in [b'not an image', b'<svg><script>unsafe()</script></svg>', b'x' * (11 * 1024 * 1024), b'']:
            with self.subTest(data=data[:20]), self.assertRaises(asset_workbench.AssetWorkbenchError):
                asset_workbench.inspect_image(data)
        data = raster()
        for mode, options in [('mystery', {}), ('photo', {'quality': 0}), ('gif', {'max_frames': 301}),
                              ('cover', {'focal_point': [-1, 0.5]}), ('cover', {'ratio': float('nan')}),
                              ('cover', {'ratio': 10 ** 1000}),
                              ('diagram', {'max_width': 0}), ('diagram', {'max_width': True})]:
            with self.subTest(mode=mode, options=options), self.assertRaises(asset_workbench.AssetWorkbenchError):
                asset_workbench.derive_image(data, mode=mode, options=options)

    def test_oversize_pixel_and_animation_budget_is_rejected_before_unbounded_decode(self):
        # A real small image with a stricter temporary budget proves validation
        # precedes allocating an unrestricted output frame collection.
        with patch.object(asset_workbench, 'MAX_IMAGE_PIXELS', 1000):
            with self.assertRaises(asset_workbench.AssetWorkbenchError):
                asset_workbench.inspect_image(raster())
        with patch.object(asset_workbench, 'MAX_DECODED_PIXELS', 500):
            with self.assertRaises(asset_workbench.AssetWorkbenchError):
                asset_workbench.derive_image(gif(20), mode='gif')

    def test_truncated_image_is_rejected_after_header_detection(self):
        data = raster(width=300, height=200)
        with self.assertRaises(asset_workbench.AssetWorkbenchError):
            asset_workbench.inspect_image(data[:len(data) // 2])

    def test_zero_duration_and_absent_loop_are_not_replaced_with_invented_defaults(self):
        images = [Image.new('RGB', (8, 8), color) for color in ('red', 'blue', 'green')]
        stream = io.BytesIO()
        images[0].save(stream, format='GIF', save_all=True, append_images=images[1:], duration=0)
        original = stream.getvalue()
        result = asset_workbench.derive_image(original, mode='gif', options={'max_frames': 2})
        self.assertEqual(result['metadata']['derived']['duration_ms'], 0)
        self.assertIsNone(result['metadata']['derived']['loop'])

    def test_processing_deadline_rejects_work_and_pixel_retention_is_bounded(self):
        with patch.object(asset_workbench, 'PROCESS_TIMEOUT', -1):
            with self.assertRaises(asset_workbench.AssetWorkbenchError):
                asset_workbench.derive_image(raster(), mode='diagram')
        with patch.object(asset_workbench, 'MAX_RETAINED_PIXELS', 100):
            with self.assertRaises(asset_workbench.AssetWorkbenchError):
                asset_workbench.derive_image(gif(10), mode='gif')


class PublicImageDownloadTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(asset_workbench, 'The image workbench module is missing')

    def fetch(self, network, url='https://images.example.test/image.png'):
        return asset_workbench.download_public_image(url, resolver=network.resolve, connection_factory=network.connection)

    def test_public_download_uses_pinned_answers_verifies_bytes_and_closes_transport(self):
        network = Network()
        with patch.dict('os.environ', {'HTTPS_PROXY': 'http://127.0.0.1:1234'}):
            result = self.fetch(network)
        self.assertEqual(result['bytes'], raster())
        self.assertEqual(result['mime'], 'image/png')
        self.assertEqual(result['metadata']['sha256'], hashlib.sha256(raster()).hexdigest())
        self.assertEqual(network.resolutions, [('images.example.test', 443)])
        self.assertEqual(network.connections[0][2], PUBLIC)
        self.assertTrue(network.connections[0][3].closed)

    def test_private_mixed_or_empty_dns_answers_make_zero_http_requests(self):
        for addresses in [[], [(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, '', ('127.0.0.1', 443))],
                          PUBLIC + [(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, '', ('10.1.2.3', 443))],
                          [(socket.AF_INET6, socket.SOCK_STREAM, socket.IPPROTO_TCP, '', ('::ffff:127.0.0.1', 443, 0, 0))]]:
            with self.subTest(addresses=addresses):
                network = Network(answers={'images.example.test': addresses})
                with self.assertRaises(asset_workbench.AssetWorkbenchError):
                    self.fetch(network)
                self.assertEqual(network.requests, [])
                self.assertEqual(network.connections, [])

    def test_unsafe_urls_fail_before_resolution(self):
        for url in ['http://images.example.test/image.png', 'https://images.example.test:444/a.png',
                    'https://user:secret@images.example.test/a.png', 'https://127.0.0.1/a.png',
                    'https://2130706433/a.png', 'https://0x7f000001/a.png', 'https://0177.0.0.1/a.png',
                    'https://%31%32%37.0.0.1/a.png', 'file:///C:/secret.png',
                    'https://localhost/a.png', 'https://images.example.test\\@127.0.0.1/a.png']:
            with self.subTest(url=url):
                network = Network()
                with self.assertRaises(asset_workbench.AssetWorkbenchError):
                    self.fetch(network, url)
                self.assertEqual(network.resolutions, [])

    def test_each_cross_host_redirect_is_validated_and_resolved_again(self):
        network = Network(routes={('images.example.test', '/image.png'): Response(status=302, headers={'Location': 'https://cdn.example.test/pic.png'}),
                                  ('cdn.example.test', '/pic.png'): Response(raster())},
                          answers={'images.example.test': PUBLIC, 'cdn.example.test': PUBLIC})
        result = self.fetch(network)
        self.assertEqual(result['metadata']['final_url'], 'https://cdn.example.test/pic.png')
        self.assertEqual(len(network.resolutions), 2)
        self.assertTrue(all(row[3].closed for row in network.connections))
        blocked = Network(routes={('images.example.test', '/image.png'): Response(status=302, headers={'Location': 'https://cdn.example.test/pic.png'})},
                          answers={'images.example.test': PUBLIC, 'cdn.example.test': [(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, '', ('169.254.169.254', 443))]})
        with self.assertRaises(asset_workbench.AssetWorkbenchError):
            self.fetch(blocked)
        self.assertEqual(len(blocked.requests), 1)

    def test_redirect_limit_declared_actual_size_encoding_and_fake_images_fail(self):
        cases = [Response(status=302, headers={'Location': '/image.png'}),
                 Response(b'fake', headers={'Content-Type': 'image/png'}),
                 Response(raster(), headers={'Content-Type': 'image/png', 'Content-Encoding': 'gzip'}),
                 Response(raster(), headers={'Content-Type': 'image/png', 'Content-Length': str(11 * 1024 * 1024)}),
                 Response(b'x' * (10 * 1024 * 1024 + 1), headers={'Content-Type': 'image/png'}),
                 Response(raster(), status=404)]
        for response in cases:
            with self.subTest(status=response.status, headers=response.headers):
                network = Network(routes={('images.example.test', '/image.png'): response})
                with self.assertRaises(asset_workbench.AssetWorkbenchError):
                    self.fetch(network)
                self.assertLessEqual(len(network.requests), 4)
                self.assertTrue(all(row[3].closed for row in network.connections))

    def test_default_connection_preserves_sni_and_pins_socket_without_second_dns(self):
        class Socket:
            def __init__(self):
                self.addresses, self.closed = [], False
            def settimeout(self, timeout):
                self.timeout = timeout
            def connect(self, address):
                self.addresses.append(address)
            def close(self):
                self.closed = True
        sock = Socket()
        with patch('socket.socket', return_value=sock), patch('socket.getaddrinfo', side_effect=AssertionError('second DNS lookup')):
            connection = asset_workbench._https_connection('images.example.test', timeout=4, addresses=PUBLIC)
            selected = connection._create_connection(('images.example.test', 443), timeout=4)
        self.assertIs(selected, sock)
        self.assertEqual(connection.host, 'images.example.test')
        self.assertEqual(sock.addresses, [('8.8.8.8', 443)])

    def test_ipv6_transition_encodings_cannot_smuggle_private_ipv4_targets(self):
        for encoded in ['64:ff9b::7f00:1', '64:ff9b:1::a00:1', '2002:7f00:1::', '2001:0:4136:e378:8000:63bf:3fff:fdd2']:
            with self.subTest(encoded=encoded):
                addresses = [(socket.AF_INET6, socket.SOCK_STREAM, socket.IPPROTO_TCP, '', (encoded, 443, 0, 0))]
                network = Network(answers={'images.example.test': addresses})
                with self.assertRaises(asset_workbench.AssetWorkbenchError):
                    self.fetch(network)
                self.assertEqual(network.requests, [])

    def test_response_declared_mime_and_declared_length_must_match_verified_bytes(self):
        for headers in [{'Content-Type': 'image/jpeg'}, {'Content-Type': 'image/png', 'Content-Length': '1'}]:
            network = Network(routes={('images.example.test', '/image.png'): Response(raster(), headers=headers)})
            with self.subTest(headers=headers), self.assertRaises(asset_workbench.AssetWorkbenchError):
                self.fetch(network)

    def test_download_deadline_is_checked_between_request_and_headers(self):
        current_time = [0]
        network = Network()
        original_connection = network.connection
        def delayed_request(*args, **kwargs):
            connection = original_connection(*args, **kwargs)
            original_request = connection.request
            def request(*request_args, **request_kwargs):
                original_request(*request_args, **request_kwargs)
                current_time[0] = 20
            connection.request = request
            return connection
        network.connection = delayed_request
        with patch.object(asset_workbench.time, 'monotonic', side_effect=lambda: current_time[0]):
            with self.assertRaises(asset_workbench.AssetWorkbenchError):
                self.fetch(network)
        self.assertEqual(network.response_reads, 0)
        self.assertTrue(all(row[3].closed for row in network.connections))


if __name__ == '__main__':
    unittest.main()
