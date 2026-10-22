"""Validate the opt-in remote editor destination without opening any browser."""
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PS = shutil.which('pwsh') or shutil.which('powershell')

@unittest.skipUnless(PS, 'PowerShell unavailable')
class EditorTargetTests(unittest.TestCase):
    def resolve(self, value=None, raw=None):
        with tempfile.TemporaryDirectory(prefix='publisher-target-') as folder:
            root=Path(folder)
            if value is not None or raw is not None:
                p=root/'data/private/server-target.json';p.parent.mkdir(parents=True)
                p.write_text(raw if raw is not None else json.dumps(value),'utf-8')
            module=str(ROOT/'scripts/editor-target.ps1').replace("'","''")
            location=str(root).replace("'","''")
            code=f"$ErrorActionPreference='Stop'; . '{module}'; try {{ $v=Get-PublisherEditorTarget -Root '{location}'; ConvertTo-Json -InputObject $v -Compress }} catch {{ exit 17 }}"
            return subprocess.run([PS,'-NoLogo','-NoProfile','-NonInteractive','-Command',code],capture_output=True,text=True)

    def test_unconfigured_install_retains_local_default(self):
        r=self.resolve();self.assertEqual(r.returncode,0,r.stderr);self.assertIsNone(json.loads(r.stdout))

    def test_https_server_target_is_preserved(self):
        r=self.resolve({'url':'https://192.0.2.19:8899/editor/'})
        self.assertEqual(r.returncode,0,r.stderr);self.assertEqual(json.loads(r.stdout),'https://192.0.2.19:8899/editor/')

    def test_invalid_destinations_fail_without_local_fallback(self):
        for url in ['http://192.0.2.19/editor/','file:///C:/test','https://fake:fake@example.test/editor/','https://example.test/editor/?secret=fake','https://example.test/editor/#fake','not-a-url']:
            with self.subTest(url=url):self.assertEqual(self.resolve({'url':url}).returncode,17)

    def test_broken_configuration_fails_without_local_fallback(self):
        self.assertEqual(self.resolve(raw='{broken').returncode,17)
