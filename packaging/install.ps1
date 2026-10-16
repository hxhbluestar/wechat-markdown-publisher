$ErrorActionPreference = "Stop"

try {
    if ($env:OS -ne "Windows_NT") {
        throw "This installer can only run on Windows."
    }

    $PackageRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
    $PayloadRoot = Join-Path $PackageRoot "payload"
    $InstallRoot = Join-Path $env:LOCALAPPDATA "WechatMarkdownPublisher"
    $DataRoot = Join-Path $InstallRoot "data"

    if (-not (Test-Path (Join-Path $PayloadRoot "runtime\python.exe"))) {
        throw "The bundled Python runtime is missing. Please extract the complete ZIP package first."
    }
    if (-not (Test-Path (Join-Path $PayloadRoot "app\web\server.py"))) {
        throw "The application files are incomplete. Please extract the complete ZIP package first."
    }

    Write-Host "Installing WeChat Markdown Publisher..." -ForegroundColor Cyan
    New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null

    # Stop the previous server together with a stuck archive subprocess and
    # any Selenium browser it launched. Older installers stopped only the
    # parent server process, which could leave the QR task running during an upgrade.
    $ExistingPidFile = Join-Path $DataRoot "server.pid"
    if (Test-Path $ExistingPidFile) {
        $ExistingPidText = Get-Content $ExistingPidFile -ErrorAction SilentlyContinue | Select-Object -First 1
        $ExistingPid = 0
        if ([int]::TryParse([string]$ExistingPidText, [ref]$ExistingPid)) {
            & taskkill.exe /PID $ExistingPid /T /F 2>$null | Out-Null
        }
    }

    $OldStopScript = Join-Path $InstallRoot "scripts\stop-server.ps1"
    if (Test-Path $OldStopScript) {
        try { & $OldStopScript } catch { Write-Warning "The previous process could not be stopped: $($_.Exception.Message)" }
    }

    foreach ($FolderName in @("app", "runtime", "scripts")) {
        $Destination = Join-Path $InstallRoot $FolderName
        if (Test-Path $Destination) {
            Remove-Item -Recurse -Force $Destination
        }
        Copy-Item -Recurse -Force (Join-Path $PayloadRoot $FolderName) $Destination
    }
    Copy-Item -Force (Join-Path $PayloadRoot "version.json") (Join-Path $InstallRoot "version.json")

    foreach ($DataFolder in @("archive", "drafts", "private", "logs")) {
        New-Item -ItemType Directory -Force -Path (Join-Path $DataRoot $DataFolder) | Out-Null
    }

    # Preserve a configured company's egress policy across upgrades.
    $NetworkConfig = Join-Path $DataRoot "private\company-network.json"
    if (-not (Test-Path -LiteralPath $NetworkConfig)) {
        Set-Content -LiteralPath $NetworkConfig -Value '{"mode":"system"}' -Encoding UTF8
    }

    # AppSecret is stored only in this directory. Disable inherited NTFS rules
    # and grant access to the Windows account running the editor.
    $PrivateFolder = Join-Path $DataRoot "private"
    try {
        $CurrentIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
        $PrivateAcl = New-Object System.Security.AccessControl.DirectorySecurity
        $PrivateAcl.SetAccessRuleProtection($true, $false)
        $PrivateRule = New-Object System.Security.AccessControl.FileSystemAccessRule(
            $CurrentIdentity,
            "FullControl",
            "ContainerInherit,ObjectInherit",
            "None",
            "Allow"
        )
        $PrivateAcl.SetAccessRule($PrivateRule)
        Set-Acl -Path $PrivateFolder -AclObject $PrivateAcl
    } catch {
        Write-Warning "Could not tighten the private-folder ACL automatically. Ask IT to restrict: $PrivateFolder"
    }

    $PowerShellExe = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
    $OpenScript = Join-Path $InstallRoot "scripts\open-editor.ps1"
    $StartScript = Join-Path $InstallRoot "scripts\start-server.ps1"
    $UninstallScript = Join-Path $InstallRoot "scripts\uninstall.ps1"

    function New-PublisherShortcut {
        param(
            [string]$ShortcutPath,
            [string]$ScriptPath,
            [string]$Description,
            [int]$WindowStyle = 1
        )
        $ShortcutDirectory = Split-Path -Parent $ShortcutPath
        New-Item -ItemType Directory -Force -Path $ShortcutDirectory | Out-Null
        $Shell = New-Object -ComObject WScript.Shell
        $Shortcut = $Shell.CreateShortcut($ShortcutPath)
        $Shortcut.TargetPath = $PowerShellExe
        $Shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$ScriptPath`""
        $Shortcut.WorkingDirectory = $InstallRoot
        $Shortcut.Description = $Description
        $Shortcut.WindowStyle = $WindowStyle
        $Shortcut.Save()
    }

    $DesktopShortcut = Join-Path ([Environment]::GetFolderPath("Desktop")) "WeChat Markdown Publisher.lnk"
    New-PublisherShortcut $DesktopShortcut $OpenScript "Open WeChat Markdown Publisher"

    $StartMenuFolder = Join-Path ([Environment]::GetFolderPath("Programs")) "WeChat Markdown Publisher"
    New-PublisherShortcut (Join-Path $StartMenuFolder "Open Editor.lnk") $OpenScript "Open WeChat Markdown Publisher"
    New-PublisherShortcut (Join-Path $StartMenuFolder "Uninstall.lnk") $UninstallScript "Uninstall WeChat Markdown Publisher"

    # Start automatically when this Windows user logs on. The web service
    # remains bound to 127.0.0.1 and is never exposed to the LAN.
    $StartupShortcut = Join-Path ([Environment]::GetFolderPath("Startup")) "WeChat Markdown Publisher Server.lnk"
    New-PublisherShortcut $StartupShortcut $StartScript "Start WeChat Markdown Publisher Server" 7

    Write-Host "Installed to: $InstallRoot" -ForegroundColor Green
    Write-Host "Drafts and account credentials are stored under: $DataRoot"
    & $OpenScript
    exit 0
} catch {
    Write-Error $_.Exception.Message
    exit 1
}
