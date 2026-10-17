"""Offline image derivatives and explicitly requested public HTTPS downloads.

All byte APIs leave the original unchanged. The caller owns storage and records
the returned source/derived hashes. SVG is explicitly unsupported: this module
does not invoke external/native rasterizers or load XML, paths, or image URLs.

GIF's 300 frame default is a compatibility preset, not a claimed platform rule.
Frames are sampled in chronological groups, assigning every source duration to
one output frame. GIF transparency is binary; alpha below 128 becomes transparent.
Very large animations are refused rather than allocating an unbounded frame list.
"""
from __future__ import annotations

import hashlib
import http.client
import io
import ipaddress
import math
import queue
import re
import socket
import threading
import time
import warnings
from urllib.parse import urljoin, urlsplit, urlunsplit


MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_IMAGE_PIXELS = 40_000_000
MAX_DECODED_PIXELS = 60_000_000
MAX_RETAINED_PIXELS = 20_000_000
MAX_SOURCE_FRAMES = 3000
PROCESS_TIMEOUT = 8
DOWNLOAD_TIMEOUT = 15
MAX_REDIRECTS = 3
FORMATS = {'PNG': ('image/png', '.png'), 'JPEG': ('image/jpeg', '.jpg'),
           'GIF': ('image/gif', '.gif'), 'WEBP': ('image/webp', '.webp')}


class AssetWorkbenchError(ValueError):
    """Invalid image, unsupported operation, resource limit, or unsafe fetch."""


def _pillow():
    try:
        from PIL import Image, ImageOps
        return Image, ImageOps
    except ImportError as exc:
        raise AssetWorkbenchError('Image processing requires the bundled Pillow runtime') from exc


def _deadline_check(deadline):
    if time.monotonic() >= deadline:
        raise AssetWorkbenchError('Image processing exceeded its time budget')


def _validate_bytes(data):
    if not isinstance(data, bytes) or not data or len(data) > MAX_IMAGE_BYTES:
        raise AssetWorkbenchError('Image must contain 1 byte to 10 MiB')
    if re.search(br'<svg\b', data[:2048], re.I):
        raise AssetWorkbenchError('SVG conversion is unsupported; provide a raster PNG, JPEG, GIF or WebP')


def _inspect(data, deadline):
    _validate_bytes(data)
    Image, _ = _pillow()
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('error', Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data)) as image:
                format_name, width, height = image.format, image.width, image.height
                if format_name not in FORMATS:
                    raise AssetWorkbenchError('Unsupported raster format')
                if width <= 0 or height <= 0 or width * height > MAX_IMAGE_PIXELS:
                    raise AssetWorkbenchError('Image dimensions exceed the pixel budget')
                image.verify()
            durations, frame_count, decoded_pixels, transparency = [], 0, 0, False
            with Image.open(io.BytesIO(data)) as image:
                loop = image.info.get('loop')
                while True:
                    _deadline_check(deadline)
                    try:
                        image.seek(frame_count)
                    except EOFError:
                        break
                    frame_count += 1
                    decoded_pixels += image.width * image.height
                    if (frame_count > MAX_SOURCE_FRAMES or decoded_pixels > MAX_DECODED_PIXELS
                            or image.width * image.height > MAX_IMAGE_PIXELS):
                        raise AssetWorkbenchError('Animation exceeds the frame or decoded pixel budget')
                    image.load()
                    duration = image.info.get('duration', 0)
                    if not isinstance(duration, (int, float)) or not math.isfinite(duration) or duration < 0:
                        raise AssetWorkbenchError('Invalid animation duration')
                    durations.append(int(duration))
                    transparency = transparency or 'transparency' in image.info or image.mode in ('RGBA', 'LA')
            _deadline_check(deadline)
            return {'width': width, 'height': height, 'format': format_name, 'frames': frame_count,
                    'size': len(data), 'sha256': hashlib.sha256(data).hexdigest(),
                    'duration_ms': sum(durations), 'loop': loop, 'transparency': transparency,
                    'frame_durations_ms': durations}
    except AssetWorkbenchError:
        raise
    except Exception as exc:
        raise AssetWorkbenchError('Invalid, damaged or excessive image data') from exc


def inspect_image(data):
    """Verify all frames and return size/dimensions/frame timing and byte hash."""
    return _inspect(data, time.monotonic() + PROCESS_TIMEOUT)


def _integer(value, name, low, high):
    if not isinstance(value, int) or isinstance(value, bool) or not low <= value <= high:
        raise AssetWorkbenchError(f'{name} must be an integer from {low} to {high}')
    return value


def _number(value, name, low, high):
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not low <= value <= high or not math.isfinite(value):
        raise AssetWorkbenchError(f'{name} must be a finite number from {low} to {high}')
    return float(value)


def _options(options):
    if options is None:
        options = {}
    if not isinstance(options, dict):
        raise AssetWorkbenchError('Image options must be an object')
    supported = {'quality', 'max_width', 'max_height', 'max_frames', 'ratio', 'focal_point', 'focal_x', 'focal_y'}
    if set(options) - supported:
        raise AssetWorkbenchError('Unsupported image option')
    result = {'quality': _integer(options.get('quality', 85), 'quality', 40, 95),
              'max_frames': _integer(options.get('max_frames', 300), 'max_frames', 1, 300),
              'ratio': _number(options.get('ratio', 2.35), 'ratio', 0.25, 4)}
    for key in ('max_width', 'max_height'):
        if key in options:
            result[key] = _integer(options[key], key, 1, 8192)
    point = options.get('focal_point', [options.get('focal_x', 0.5), options.get('focal_y', 0.5)])
    if not isinstance(point, (list, tuple)) or len(point) != 2:
        raise AssetWorkbenchError('focal_point must be [x, y] normalized coordinates')
    result['focal_point'] = [_number(point[0], 'focal x', 0, 1), _number(point[1], 'focal y', 0, 1)]
    return result


def _size(width, height, options):
    factor = min(1.0, options.get('max_width', width) / width, options.get('max_height', height) / height)
    return max(1, int(round(width * factor))), max(1, int(round(height * factor)))


class _BoundedOutput(io.BytesIO):
    def write(self, data):
        if self.tell() + len(data) > MAX_IMAGE_BYTES:
            raise AssetWorkbenchError('Derived image exceeds the 10 MiB output budget')
        return super().write(data)


def _save(image, *, format_name, deadline, **options):
    _deadline_check(deadline)
    stream = _BoundedOutput()
    image.save(stream, format=format_name, **options)
    _deadline_check(deadline)
    return stream.getvalue()


def _gif_palette(frame, Image):
    rgba = frame.convert('RGBA')
    alpha = rgba.getchannel('A')
    transparent = alpha.point(lambda value: 255 if value < 128 else 0)
    palette = rgba.convert('RGB').quantize(colors=255, method=Image.Quantize.MEDIANCUT)
    palette.paste(255, mask=transparent)
    values = palette.getpalette() or []
    palette.putpalette((values + [0] * 768)[:768])
    palette.info['transparency'] = 255
    return palette


def _derive_gif(data, inspection, options, metadata, deadline):
    Image, _ = _pillow()
    frame_count = inspection['frames']
    target = min(frame_count, options['max_frames'])
    dimensions = _size(inspection['width'], inspection['height'], options)
    if dimensions[0] * dimensions[1] * target > MAX_RETAINED_PIXELS:
        raise AssetWorkbenchError('Selected animation exceeds retained pixel budget; choose smaller dimensions or fewer frames')
    # Every source frame belongs to one contiguous output group. No duration is
    # dropped or invented; GIF duration granularity remains 10 ms.
    starts = [index * frame_count // target for index in range(target)] + [frame_count]
    durations = [sum(inspection['frame_durations_ms'][starts[i]:starts[i + 1]]) for i in range(target)]
    if any(duration > 655350 for duration in durations):
        raise AssetWorkbenchError('Grouped GIF frame duration exceeds GIF encoding limit; choose more frames')
    selected = []
    try:
        with Image.open(io.BytesIO(data)) as source:
            for index in starts[:-1]:
                _deadline_check(deadline)
                source.seek(index)
                frame = source.convert('RGBA')
                if frame.size != dimensions:
                    frame = frame.resize(dimensions, Image.Resampling.LANCZOS)
                selected.append(_gif_palette(frame, Image))
        save_options = {'save_all': True, 'append_images': selected[1:], 'duration': durations,
                        'disposal': 2, 'transparency': 255, 'optimize': False}
        if inspection['loop'] is not None:
            save_options['loop'] = inspection['loop']
        result = _save(selected[0], format_name='GIF', deadline=deadline, **save_options)
    finally:
        for frame in selected:
            frame.close()
    metadata['operations'].append({'operation': 'gif-compatibility-preset', 'source_frames': frame_count,
                                   'target_frames': target, 'duration_ms': inspection['duration_ms'],
                                   'transparency': 'binary alpha threshold 128', 'platform_limit_claim': False})
    if dimensions != (inspection['width'], inspection['height']):
        metadata['operations'].append({'operation': 'resize', 'size': list(dimensions)})
    return result


def derive_image(data, mode='diagram', options=None):
    """Return new image bytes and provenance; never overwrite the original.

    Modes: diagram -> lossless PNG; photo -> JPEG (white alpha background);
    cover -> PNG cropped to ratio around normalized focal_point; gif -> at most
    max_frames (default 300). Optional max_width/max_height only downscale.
    Source animation is accepted only in GIF mode to avoid accidental flattening.
    """
    if mode not in ('photo', 'diagram', 'gif', 'cover'):
        raise AssetWorkbenchError('Choose photo, diagram, gif or cover processing')
    config = _options(options)
    deadline = time.monotonic() + PROCESS_TIMEOUT
    inspection = _inspect(data, deadline)
    if inspection['frames'] > 1 and mode != 'gif':
        raise AssetWorkbenchError('Animated input requires GIF processing; a static conversion would discard frames')
    if mode == 'gif' and inspection['format'] != 'GIF':
        raise AssetWorkbenchError('GIF compatibility processing requires a GIF original')
    metadata = {'source_hash': inspection['sha256'], 'source': inspection, 'mode': mode, 'operations': []}
    Image, ImageOps = _pillow()
    try:
        if mode == 'gif':
            result = _derive_gif(data, inspection, config, metadata, deadline)
            format_name = 'GIF'
        else:
            with Image.open(io.BytesIO(data)) as original:
                image = ImageOps.exif_transpose(original).convert('RGBA')
                if original.getexif().get(274, 1) != 1:
                    metadata['operations'].append({'operation': 'apply-exif-orientation'})
                if mode == 'cover':
                    width, height = image.size
                    ratio = config['ratio']
                    crop_width = min(width, max(1, round(height * ratio)))
                    crop_height = min(height, max(1, round(width / ratio)))
                    focal_x, focal_y = config['focal_point']
                    left = min(width - crop_width, max(0, round(width * focal_x - crop_width / 2)))
                    top = min(height - crop_height, max(0, round(height * focal_y - crop_height / 2)))
                    box = [left, top, left + crop_width, top + crop_height]
                    image = image.crop(box)
                    metadata.update({'crop_box': box, 'focal_point': config['focal_point'], 'ratio': ratio})
                    metadata['operations'].append({'operation': 'cover-crop', 'box': box})
                dimensions = _size(image.width, image.height, config)
                if dimensions != image.size:
                    image = image.resize(dimensions, Image.Resampling.LANCZOS)
                    metadata['operations'].append({'operation': 'resize', 'size': list(dimensions)})
                if mode == 'cover':
                    metadata['safe_area'] = {'normalized': [0.1, 0.1, 0.9, 0.9],
                                             'pixels': [round(image.width * .1), round(image.height * .1),
                                                        round(image.width * .9), round(image.height * .9)],
                                             'note': 'Composition guidance; preview actual platform crops.'}
                if mode == 'photo':
                    flattened = Image.new('RGB', image.size, 'white')
                    flattened.paste(image, mask=image.getchannel('A'))
                    result = _save(flattened, format_name='JPEG', deadline=deadline, quality=config['quality'], optimize=True)
                    format_name = 'JPEG'
                    metadata['operations'].append({'operation': 'jpeg-compression', 'quality': config['quality'], 'alpha_background': 'white'})
                else:
                    result = _save(image, format_name='PNG', deadline=deadline, optimize=True)
                    format_name = 'PNG'
                    metadata['operations'].append({'operation': 'lossless-png'})
        metadata['derived_hash'] = hashlib.sha256(result).hexdigest()
        # Verify the actual encoded result instead of trusting encoder options.
        metadata['derived'] = _inspect(result, deadline)
        mime, extension = FORMATS[format_name]
        return {'bytes': result, 'mime': mime, 'extension': extension, 'metadata': metadata}
    except AssetWorkbenchError:
        raise
    except Exception as exc:
        raise AssetWorkbenchError('Unable to derive this image safely') from exc


def _public_https_url(value):
    if not isinstance(value, str) or not value or len(value) > 4096 or re.search(r'[\s\x00-\x1f\x7f\\]', value):
        raise AssetWorkbenchError('Invalid public image URL')
    try:
        parsed = urlsplit(value)
        hostname = parsed.hostname or ''
        if (parsed.scheme.lower() != 'https' or parsed.port not in (None, 443)
                or parsed.username is not None or parsed.password is not None or '%' in hostname):
            raise ValueError('Invalid URL authority')
        host = hostname.rstrip('.').encode('idna').decode('ascii').lower()
        # DNS names only; numeric, hexadecimal and legacy octal IP spellings
        # never reach DNS. A resolved hostname must still pass every IP check.
        if ('.' not in host or len(host) > 253 or not re.fullmatch(r'[a-z0-9.-]+', host)
                or not re.search(r'[a-z]', host.rsplit('.', 1)[-1])
                or any(not label or len(label) > 63 or label.startswith('-') or label.endswith('-') for label in host.split('.'))):
            raise ValueError('A full public DNS hostname is required')
        try:
            ipaddress.ip_address(host)
        except ValueError:
            pass
        else:
            raise ValueError('IP literal URLs are not accepted')
        return urlunsplit(('https', host, parsed.path or '/', parsed.query, ''))
    except (ValueError, UnicodeError) as exc:
        raise AssetWorkbenchError('Only credential-free public HTTPS DNS names on port 443 are accepted') from exc


def _public_addresses(host, resolver, deadline):
    result_queue = queue.Queue(maxsize=1)
    def resolve():
        try:
            result_queue.put((resolver(host, 443, type=socket.SOCK_STREAM), None))
        except Exception as exc:
            result_queue.put((None, exc))
    threading.Thread(target=resolve, daemon=True).start()
    try:
        rows, error = result_queue.get(timeout=max(0.001, deadline - time.monotonic()))
    except queue.Empty as exc:
        raise AssetWorkbenchError('Image hostname resolution timed out') from exc
    if error is not None:
        raise AssetWorkbenchError('Image hostname resolution failed') from error
    try:
        if not rows:
            raise ValueError('No addresses')
        for row in rows:
            address = ipaddress.ip_address(row[4][0])
            if (row[0] not in (socket.AF_INET, socket.AF_INET6) or row[1] != socket.SOCK_STREAM
                    or row[4][1] != 443 or not address.is_global or address.is_multicast
                    or address.is_reserved or address.is_unspecified or address.is_loopback
                    or (isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped is not None)):
                raise ValueError('Nonpublic or unsupported address')
    except (ValueError, TypeError, IndexError) as exc:
        raise AssetWorkbenchError('Image hostname returned a nonpublic or invalid address') from exc
    _deadline_check(deadline)
    return rows


def _connect_pinned(addresses, timeout):
    deadline, last_error = time.monotonic() + timeout, None
    for family, kind, protocol, _, address in addresses:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('Pinned image connection timed out')
        connection = socket.socket(family, kind, protocol)
        try:
            connection.settimeout(remaining)
            connection.connect(address)
            return connection
        except OSError as exc:
            connection.close()
            last_error = exc
    raise last_error or OSError('No usable public image address')


def _https_connection(host, *, timeout, addresses):
    connection = http.client.HTTPSConnection(host, timeout=timeout)
    # Keep host for TLS SNI, certificate validation and Host header; replace only
    # TCP destination creation, preventing a second DNS lookup after validation.
    connection._create_connection = lambda address, timeout, source_address=None: _connect_pinned(addresses, timeout)
    return connection


def download_public_image(url, *, resolver=None, connection_factory=None):
    """Download one explicitly requested HTTPS image, bypassing environment proxies.

    All DNS answers must be globally routable; every redirect is validated and
    pinned separately. At most 3 redirects, 10 MiB, identity content encoding,
    15 seconds across DNS/connect/stream/validation. No cookies or credentials.
    Injected connection_factory(host, timeout=..., addresses=...) must honor the
    same pinning contract and is intended for controlled tests only.
    """
    original = current = _public_https_url(url)
    resolve = resolver or socket.getaddrinfo
    connect = connection_factory or _https_connection
    deadline = time.monotonic() + DOWNLOAD_TIMEOUT
    for redirect in range(MAX_REDIRECTS + 1):
        _deadline_check(deadline)
        parsed = urlsplit(current)
        addresses = _public_addresses(parsed.hostname, resolve, deadline)
        connection = None
        try:
            connection = connect(parsed.hostname, timeout=max(0.001, deadline - time.monotonic()), addresses=addresses)
            path = urlunsplit(('', '', parsed.path, parsed.query, ''))
            connection.request('GET', path, headers={'Host': parsed.hostname, 'Accept-Encoding': 'identity',
                                                    'Accept': 'image/png,image/jpeg,image/gif,image/webp',
                                                    'User-Agent': 'WechatMarkdownPublisher/ImageWorkbench', 'Connection': 'close'})
            _deadline_check(deadline)
            if getattr(connection, 'sock', None) is not None:
                connection.sock.settimeout(max(0.001, deadline - time.monotonic()))
            response = connection.getresponse()
            _deadline_check(deadline)
            if response.status in (301, 302, 303, 307, 308):
                location = response.getheader('Location')
                if not location or redirect == MAX_REDIRECTS:
                    raise AssetWorkbenchError('Image download exceeded redirect limit or has no redirect target')
                current = _public_https_url(urljoin(current, location))
                continue
            if response.status != 200:
                raise AssetWorkbenchError(f'Image download failed: HTTP {response.status}')
            encoding = response.getheader('Content-Encoding', 'identity').strip().lower()
            if encoding not in ('', 'identity'):
                raise AssetWorkbenchError('Compressed HTTP image responses are not accepted')
            claimed_mime = response.getheader('Content-Type', '').split(';', 1)[0].strip().lower()
            if claimed_mime not in {row[0] for row in FORMATS.values()}:
                raise AssetWorkbenchError('Remote content type is not a supported raster image')
            length = response.getheader('Content-Length')
            if length is not None:
                try:
                    declared = int(length)
                    if not 0 < declared <= MAX_IMAGE_BYTES:
                        raise ValueError('Oversize or empty response')
                except ValueError as exc:
                    raise AssetWorkbenchError('Remote image length exceeds the limit or is invalid') from exc
            chunks, size = [], 0
            while True:
                _deadline_check(deadline)
                # Tighten each read to the remaining total budget, even after a
                # slow response. Injected test connections may have no socket.
                if getattr(connection, 'sock', None) is not None:
                    connection.sock.settimeout(max(0.001, deadline - time.monotonic()))
                chunk = response.read1(min(65536, MAX_IMAGE_BYTES - size + 1))
                if not chunk:
                    break
                size += len(chunk)
                if size > MAX_IMAGE_BYTES:
                    raise AssetWorkbenchError('Remote image exceeds the 10 MiB limit')
                chunks.append(chunk)
            data = b''.join(chunks)
            if length is not None and len(data) != declared:
                raise AssetWorkbenchError('Remote image body length does not match its declaration')
            inspection = _inspect(data, min(deadline, time.monotonic() + PROCESS_TIMEOUT))
            mime, extension = FORMATS[inspection['format']]
            if claimed_mime != mime:
                raise AssetWorkbenchError('Remote image bytes do not match their declared content type')
            return {'bytes': data, 'mime': mime, 'extension': extension,
                    'metadata': {**inspection, 'source_url': original, 'final_url': current}}
        except AssetWorkbenchError:
            raise
        except (OSError, http.client.HTTPException, ValueError) as exc:
            raise AssetWorkbenchError('Public image HTTPS download failed') from exc
        finally:
            if connection is not None:
                connection.close()
    raise AssetWorkbenchError('Image download did not complete')
