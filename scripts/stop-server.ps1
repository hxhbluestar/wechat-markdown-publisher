$ErrorActionPreference = "Stop"

$InstallRoot = Split-Path -Parent $PSScriptRoot
$PidFile = Join-Path $InstallRoot "data\server.pid"
if (-not (Test-Path $PidFile)) {
    exit 0
}

$PidText = (Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
$ServerPid = 0
if (-not [int]::TryParse([string]$PidText, [ref]$ServerPid)) {
    Remove-Item -Force $PidFile -ErrorAction SilentlyContinue
    exit 0
}

$ProcessInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $ServerPid" -ErrorAction SilentlyContinue
if ($null -ne $ProcessInfo -and [string]$ProcessInfo.CommandLine -like "*web*server.py*") {
    & taskkill.exe /PID $ServerPid /T /F 2>$null | Out-Null
}
Remove-Item -Force $PidFile -ErrorAction SilentlyContinue
exit 0
