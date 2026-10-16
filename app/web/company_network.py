"""Publisher-only, fail-closed Windows IPv4 transport. No global proxy/routes.

The probe verifies this interface's egress to its service. Routers may apply
destination-specific NAT; see docs/wechat-fixed-egress.md.
"""
from __future__ import annotations

import contextlib
import http.client
import ipaddress
import json
import os
import re
import socket
import struct
import subprocess
import threading
import urllib.parse
from dataclasses import dataclass
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path


class CompanyNetworkError(Exception):
    pass


@dataclass(frozen=True)
class CompanyConfig:
    expected_public_ip: str
    interface_alias: str
    gateway: str
    interface_guid: str = ""

    def __post_init__(self):
        try:
            if not ipaddress.IPv4Address(self.expected_public_ip).is_global:
                raise ValueError()
            ipaddress.IPv4Address(self.gateway)
            if not self.interface_alias or len(self.interface_alias) > 128:
                raise ValueError()
        except (ValueError, TypeError) as exc:
            raise CompanyNetworkError("公司直连配置无效，请检查固定公网 IP、网卡和网关") from exc


def windows_binding(config):
    # Pass the adapter name as data, not interpolated PowerShell code.
    script = r'''
$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new()
$a = @(Get-NetAdapter | Where-Object { $_.Name -eq $env:PUBLISHER_INTERFACE })
if ($a.Count -ne 1 -or $a[0].Status -ne 'Up') { throw 'Adapter unavailable' }
$a = $a[0]
$ip = @(Get-NetIPAddress -InterfaceIndex $a.ifIndex -AddressFamily IPv4 |
    Where-Object { $_.AddressState -eq 'Preferred' -and -not $_.SkipAsSource })
if ($ip.Count -ne 1) { throw 'Ambiguous IPv4 binding' }
$route = Get-NetRoute -InterfaceIndex $a.ifIndex -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' |
    Sort-Object RouteMetric | Select-Object -First 1
if (-not $route) { throw 'No gateway' }
@{interface_index=[int]$a.ifIndex;source_ip=$ip[0].IPAddress;gateway=$route.NextHop;
  hardware=[bool]$a.HardwareInterface;interface_guid=[string]$a.InterfaceGuid} | ConvertTo-Json -Compress
'''
    env = {**os.environ, "PUBLISHER_INTERFACE": config.interface_alias}
    exe = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32/WindowsPowerShell/v1.0/powershell.exe"
    result = subprocess.run(
        [str(exe), "-NoProfile", "-NonInteractive", "-Command", script],
        env=env, capture_output=True, encoding="utf-8", timeout=12,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0), check=True,
    )
    return json.loads(result.stdout)


def connect_ipv4(address, timeout, binding):
    """Pin Windows IP_UNICAST_IF (network byte order) and source IPv4."""
    answers = socket.getaddrinfo(address[0], address[1], socket.AF_INET, socket.SOCK_STREAM)
    if not answers or any(not ipaddress.IPv4Address(row[4][0]).is_global for row in answers):
        raise CompanyNetworkError("公司直连 DNS 返回了内网或 VPN 虚拟地址，已停止请求")
    for row in answers:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            sock.settimeout(timeout)
            sock.setsockopt(socket.IPPROTO_IP, 31, struct.pack("!I", binding["interface_index"]))
            sock.bind((binding["source_ip"], 0))
            sock.connect(row[4])
            if sock.getsockname()[0] != binding["source_ip"]:
                raise CompanyNetworkError("公司直连网卡绑定不一致，已停止请求")
            return sock
        except Exception:
            sock.close()
            # Other A records may be tried only on this same pinned interface.
            if row == answers[-1]:
                raise


def https_connection(host, *, timeout, binding):
    connection = http.client.HTTPSConnection(host, timeout=timeout)
    connection._create_connection = lambda address, timeout, source_address=None: connect_ipv4(address, timeout, binding)
    return connection


class CompanyDirectTransport:
    PROBE_HOST = "myip.ipip.net"

    def __init__(self, config, *, binding_provider=windows_binding, connection_factory=https_connection):
        self.config = config
        self.binding_provider = binding_provider
        self.connection_factory = connection_factory
        self._lock = threading.Lock()
        self._state = {"mode": "company_direct", "state": "unchecked",
                       "expected_public_ip": config.expected_public_ip,
                       "interface_alias": config.interface_alias,
                       "observed_public_ip": "", "checked_at": "", "last_error": ""}

    def status(self):
        with self._lock:
            return dict(self._state)

    def _record(self, **values):
        with self._lock:
            self._state.update(values)

    @contextlib.contextmanager
    def _response(self, host, method, path, binding, timeout, body=None, headers=None):
        connection = self.connection_factory(host, timeout=timeout, binding=binding)
        try:
            connection.request(method, path, body=body, headers=headers or {})
            response = connection.getresponse()
            if response.status != 200:
                raise CompanyNetworkError(f"公司直连返回 HTTP {response.status}，已停止请求")
            yield response
        finally:
            connection.close()

    def _checked_binding(self, timeout):
        self._record(state="checking", observed_public_ip="", last_error="")
        try:
            binding = self.binding_provider(self.config)
            if (binding.get("hardware") is not True or binding.get("gateway") != self.config.gateway
                or (self.config.interface_guid and binding.get("interface_guid", "").lower() != self.config.interface_guid.lower())
                or not 0 < int(binding.get("interface_index", 0)) < 2**32):
                raise CompanyNetworkError("公司直连网卡或网关发生变化，已停止同步")
            ipaddress.IPv4Address(binding["source_ip"])
            with self._response(self.PROBE_HOST, "GET", "/", binding, min(timeout, 8), headers={"Accept": "text/plain"}) as response:
                text = response.read(4096).decode("utf-8")
            addresses = re.findall(r"(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])", text)
            if len(addresses) != 1:
                raise CompanyNetworkError("公司直连无法识别公网出口，已停止同步")
            observed = str(ipaddress.IPv4Address(addresses[0]))
            self._record(observed_public_ip=observed)
            if observed != self.config.expected_public_ip:
                raise CompanyNetworkError(
                    f"公司直连出口不匹配：当前 {observed}，要求 {self.config.expected_public_ip}；"
                    "已停止同步，请检查公司路由器的出口或分流配置"
                )
            self._record(state="verified", last_error="", source_ip=binding["source_ip"])
            return binding
        except Exception as exc:
            message = str(exc) if isinstance(exc, CompanyNetworkError) else f"公司直连检查失败（{type(exc).__name__}），已停止同步"
            self._record(state="blocked", last_error=message)
            raise CompanyNetworkError(message) from exc
        finally:
            self._record(checked_at=datetime.now(timezone.utc).isoformat(timespec="seconds"))

    def check(self, *, timeout=10):
        self._checked_binding(timeout)
        return self.status()

    @contextlib.contextmanager
    def open(self, request, *, timeout=30):
        parsed = urllib.parse.urlsplit(request.full_url)
        if (parsed.scheme != "https" or parsed.hostname != "api.weixin.qq.com"
            or parsed.port not in (None, 443) or parsed.username or parsed.password or parsed.fragment):
            raise CompanyNetworkError("公司直连仅允许微信公众号 HTTPS 接口")
        binding = self._checked_binding(timeout)
        path = urllib.parse.urlunsplit(("", "", parsed.path or "/", parsed.query, ""))
        try:
            with self._response(parsed.hostname, request.get_method(), path, binding, timeout,
                                request.data, dict(request.header_items())) as response:
                yield response
        except (OSError, http.client.HTTPException, CompanyNetworkError) as exc:
            message = f"公司直连微信请求失败（{type(exc).__name__}），未切换其他出口"
            self._record(state="blocked", last_error=message)
            raise CompanyNetworkError(message) from exc


@lru_cache(maxsize=4)
def _configured_transport(raw):
    try:
        data = json.loads(raw)
        if not isinstance(data, dict):
            raise ValueError("Config must be an object")
        mode = data.get("mode", "")
        if mode == "system":
            return None
        if mode != "company_direct":
            raise ValueError("Unknown mode")
        return CompanyDirectTransport(CompanyConfig(
            data["expected_public_ip"], data["interface_alias"], data["gateway"], data.get("interface_guid", "")
        ))
    except (ValueError, KeyError, TypeError) as exc:
        raise CompanyNetworkError("公司直连配置文件无效，已停止微信请求") from exc


def from_environment():
    path = os.environ.get("WECHAT_NETWORK_CONFIG", "")
    if not path:
        return None
    try:
        return _configured_transport(Path(path).read_text("utf-8-sig"))
    except (OSError, UnicodeError) as exc:
        raise CompanyNetworkError("公司直连配置文件无法读取，已停止微信请求") from exc


def network_status():
    try:
        transport = from_environment()
        return transport.status() if transport else {"mode": "system", "state": "system"}
    except CompanyNetworkError as exc:
        return {"mode": "company_direct", "state": "blocked", "last_error": str(exc)}
