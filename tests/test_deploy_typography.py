"""Exercise deployment file changes in temporary trees, with fake OS processes.

No installed application, live process, account, draft, or remote API is used.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "tools" / "deploy-typography.ps1"
FILES = (
    "app/web/server.py",
    "app/web/rocm_import.py",
    "app/web/editor_service.py",
    "app/web/editor_security.py",
    "app/web/editor/index.html",
    "app/web/editor/assets/index-20261017-scroll.js",
    "app/web/editor/assets/typography-20261017-scroll.mjs",
    "app/web/editor/assets/typography-controls-20261017-scroll.mjs",
    "app/web/editor/assets/typography-controls-20261017-scroll.css",
    "app/web/editor/assets/article-spacing-20261017-scroll.mjs",
    "app/web/editor/assets/scroll-sync-20261017-scroll.mjs",
    "app/web/editor/assets/proofreading-20261017-scroll.mjs",
    "app/web/editor/assets/proofreading-20261017-scroll.css",
    "app/web/editor/assets/proofreading-core-20261017-scroll.mjs",
    "app/web/editor/assets/proofreading-dictionary-20261017-scroll.mjs",
    "app/web/editor/assets/rocm-import-20261017.mjs",
    "app/web/vendor/highlight-powershell-11.11.1.min.js",
    "app/web/vendor/highlight-extras-11.11.1.js",
    "app/web/vendor/highlight-ai-20261017.js",
    "app/web/vendor/README.md",
)
POWERSHELL = shutil.which("powershell.exe") or shutil.which("pwsh")


HARNESS = r"""
param([string]$FixtureRoot, [string]$Scenario)
$ErrorActionPreference = 'Stop'
$env:LOCALAPPDATA = Join-Path $FixtureRoot 'profile'
. (Join-Path $FixtureRoot 'source\tools\deploy-typography.ps1')
$InstallRoot = Join-Path $FixtureRoot 'installed'
$RuntimePython = Join-Path $InstallRoot 'runtime\python.exe'
$ServerScript = Join-Path $InstallRoot 'app\web\server.py'
$PidFile = Join-Path $InstallRoot 'data\server.pid'
$script:Events = [System.Collections.Generic.List[string]]::new()
$script:Processes = @{
    111 = [pscustomobject]@{
        ProcessId=111; ExecutablePath=$RuntimePython;
        CommandLine=('"' + $RuntimePython + '" "' + $ServerScript + '"')
    }
}
$script:Connections = @([pscustomobject]@{
    LocalPort=8899; LocalAddress='127.0.0.1'; State='Listen'; OwningProcess=111
})
if ($Scenario -eq 'busy') {
    $script:Connections += [pscustomobject]@{
        LocalPort=50000; LocalAddress='127.0.0.1'; State='Established'; OwningProcess=111
    }
}
if ($Scenario -eq 'unrelated') { $script:Processes[111].ExecutablePath = 'C:\foreign\python.exe' }
$script:StartCalls = 0
$script:Corrupted = $false
function Get-NetTCPConnection { param($ErrorAction) return $script:Connections }
function Get-CimInstance {
    param($ClassName, $Filter, $ErrorAction)
    $CandidateId = [int]($Filter -replace '[^0-9]', '')
    return $script:Processes[$CandidateId]
}
function Stop-Process {
    param([int]$Id, [switch]$Force)
    $Content = [IO.File]::ReadAllText($ServerScript)
    $script:Events.Add("stop:${Id}:$Content")
    $script:Processes.Remove($Id)
    $script:Connections = @($script:Connections | Where-Object { $_.OwningProcess -ne $Id })
}
function Wait-Process { param($Id, $Timeout, $ErrorAction) }
function Start-Sleep { param($Milliseconds, $Seconds) }
function Start-OwnedServer {
    $script:StartCalls++
    $Content = [IO.File]::ReadAllText($ServerScript)
    $script:Events.Add("start:$($script:StartCalls):$Content")
    $NewId = 199 + $script:StartCalls
    $script:Processes[$NewId] = [pscustomobject]@{
        ProcessId=$NewId; ExecutablePath=$RuntimePython;
        CommandLine=('"' + $RuntimePython + '" "' + $ServerScript + '"')
    }
    $script:Connections = @([pscustomobject]@{
        LocalPort=8899; LocalAddress='127.0.0.1'; State='Listen'; OwningProcess=$NewId
    })
    [IO.File]::WriteAllText($PidFile, [string]$NewId)
    if ($Scenario -eq 'startup-failure' -and $script:StartCalls -eq 1) {
        throw 'Simulated startup failure'
    }
}
function Copy-Item {
    param($LiteralPath, $Destination, [switch]$Force)
    Microsoft.PowerShell.Management\Copy-Item -LiteralPath $LiteralPath -Destination $Destination -Force:$Force
    if ($Scenario -eq 'corrupt-copy' -and -not $script:Corrupted -and $Destination -eq $ServerScript) {
        [IO.File]::AppendAllText($Destination, ':corrupted')
        $script:Corrupted = $true
    }
}
$Failure = ''
try { Invoke-TypographyDeployment | Out-Null } catch { $Failure = $_.Exception.Message }
@{error=$Failure; events=@($script:Events); backup=$BackupRoot} |
    ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $FixtureRoot 'result.json') -Encoding UTF8
"""


@unittest.skipUnless(POWERSHELL, "PowerShell is required for isolated deployment tests")
class TypographyDeploymentTests(unittest.TestCase):
    def setUp(self) -> None:
        self.assertTrue(SCRIPT.is_file(), "The typography deployment script is missing")
        self.temp_dir = tempfile.TemporaryDirectory(prefix="publisher-deploy-test-")
        self.addCleanup(self.temp_dir.cleanup)
        self.root = Path(self.temp_dir.name)
        self.source = self.root / "source"
        (self.source / "tools").mkdir(parents=True)
        shutil.copyfile(SCRIPT, self.source / "tools" / SCRIPT.name)
        for relative in FILES:
            path = self.source / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("new:" + relative, encoding="utf-8")
        (self.source / "packaging").mkdir()
        (self.source / "packaging/version.json").write_text('{"version":"new"}', encoding="utf-8")
        self.originals = {}
        for target_root in (self.root / "installed", self.root / "payload"):
            for relative in ("app/web/server.py", "app/web/editor_service.py", "version.json"):
                path = target_root / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                original = "old:" + relative
                path.write_text(original, encoding="utf-8")
                self.originals[path] = original
            for relative in ("data/private/company-network.json", "data/private/wechat-accounts.json", "data/drafts/untouched.md"):
                path = target_root / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("untouched", encoding="utf-8")
                self.originals[path] = "untouched"
        (self.root / "installed/data/server.pid").write_text("111", encoding="ascii")
        for relative in ("runtime/python.exe", "scripts/start-server.ps1"):
            path = self.root / "installed" / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("fixture", encoding="utf-8")
        (self.root / "harness.ps1").write_text(HARNESS, encoding="utf-8-sig")

    def run_deployment(self, scenario: str) -> dict:
        runtime_env = dict(os.environ)
        if Path(POWERSHELL).name.lower() == "powershell.exe":
            # Python can inherit PowerShell 7 module paths; Windows PowerShell
            # must resolve its own built-in modules instead of incompatible ones.
            runtime_env = {key: value for key, value in runtime_env.items() if key.lower() != "psmodulepath"}
            runtime_env["PSModulePath"] = str(Path(os.environ["SystemRoot"]) / "System32/WindowsPowerShell/v1.0/Modules")
        result = subprocess.run([
            POWERSHELL, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
            "-File", str(self.root / "harness.ps1"), str(self.root), scenario,
        ], capture_output=True, text=True, timeout=30, env=runtime_env)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return json.loads((self.root / "result.json").read_text("utf-8-sig"))

    def assert_original_files(self) -> None:
        for path, expected in self.originals.items():
            self.assertEqual(path.read_text("utf-8"), expected, str(path))
        for target_root in (self.root / "installed", self.root / "payload"):
            for relative in FILES:
                target=target_root / relative
                if target not in self.originals:
                    self.assertFalse(target.exists(), str(target))

    def test_success_copies_only_allowlisted_files_and_records_verified_hashes(self) -> None:
        result = self.run_deployment("success")
        self.assertEqual(result["error"], "")
        manifest = json.loads((Path(result["backup"]) / "manifest.json").read_text("utf-8-sig"))
        self.assertEqual(len(manifest), 2 * (len(FILES) + 1))
        targets = {Path(change["target"]) for change in manifest}
        for target_root in (self.root / "installed", self.root / "payload"):
            for relative in FILES:
                target = target_root / relative
                self.assertIn(target, targets)
                self.assertEqual(target.read_text("utf-8"), "new:" + relative)
        for change in manifest:
            self.assertEqual(hashlib.sha256(Path(change["target"]).read_bytes()).hexdigest().upper(), change["source_sha256"])
        for path, original in self.originals.items():
            if "/data/" in path.as_posix():
                self.assertEqual(path.read_text("utf-8"), original)

    def test_active_sync_connection_refuses_deployment_without_stopping_service(self) -> None:
        result = self.run_deployment("busy")
        self.assertIn("active connections", result["error"])
        self.assertEqual(result["events"], [])
        self.assert_original_files()

    def test_unrelated_listener_is_never_stopped(self) -> None:
        result = self.run_deployment("unrelated")
        self.assertIn("unrelated process", result["error"])
        self.assertEqual(result["events"], [])
        self.assert_original_files()

    def test_startup_failure_stops_new_process_before_restoring_original_files(self) -> None:
        result = self.run_deployment("startup-failure")
        self.assertIn("Simulated startup failure", result["error"])
        self.assertEqual(result["events"], [
            "stop:111:old:app/web/server.py",
            "start:1:new:app/web/server.py",
            "stop:200:new:app/web/server.py",
            "start:2:old:app/web/server.py",
        ])
        self.assert_original_files()

    def test_copy_hash_mismatch_rolls_back_before_starting_old_server(self) -> None:
        result = self.run_deployment("corrupt-copy")
        self.assertIn("Copy verification failed", result["error"])
        self.assertEqual(result["events"], [
            "stop:111:old:app/web/server.py",
            "start:1:old:app/web/server.py",
        ])
        self.assert_original_files()


if __name__ == "__main__":
    unittest.main()
