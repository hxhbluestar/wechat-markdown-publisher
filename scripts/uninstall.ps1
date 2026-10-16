$ErrorActionPreference = "Stop"

try {
    $InstallRoot = Split-Path -Parent $PSScriptRoot
    & (Join-Path $PSScriptRoot "stop-server.ps1")

    $DesktopShortcut = Join-Path ([Environment]::GetFolderPath("Desktop")) "WeChat Markdown Publisher.lnk"
    $StartMenuFolder = Join-Path ([Environment]::GetFolderPath("Programs")) "WeChat Markdown Publisher"
    $StartupShortcut = Join-Path ([Environment]::GetFolderPath("Startup")) "WeChat Markdown Publisher Server.lnk"
    Remove-Item -Force $DesktopShortcut -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force $StartMenuFolder -ErrorAction SilentlyContinue
    Remove-Item -Force $StartupShortcut -ErrorAction SilentlyContinue

    foreach ($FolderName in @("app", "runtime")) {
        Remove-Item -Recurse -Force (Join-Path $InstallRoot $FolderName) -ErrorAction SilentlyContinue
    }

    $DataRoot = Join-Path $InstallRoot "data"
    Write-Host "Application files were removed." -ForegroundColor Green
    Write-Host "Drafts and account credentials were retained at: $DataRoot"
    Write-Host "Delete that folder manually only if you also want to erase all local drafts and credentials."
    exit 0
} catch {
    Write-Error $_.Exception.Message
    exit 1
}
