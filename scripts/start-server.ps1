$ErrorActionPreference = "Stop"

$InstallRoot = Split-Path -Parent $PSScriptRoot
$AppRoot = Join-Path $InstallRoot "app"
$DataRoot = Join-Path $InstallRoot "data"
$RuntimePython = Join-Path $InstallRoot "runtime\python.exe"
$ServerScript = Join-Path $AppRoot "web\server.py"
$LogRoot = Join-Path $DataRoot "logs"
$PidFile = Join-Path $DataRoot "server.pid"
$HealthUrl = "http://127.0.0.1:8899/api/editor/config"

function Test-PublisherServer {
    try {
        $Response = Invoke-WebRequest -UseBasicParsing -Uri $HealthUrl -TimeoutSec 2
        return $Response.StatusCode -eq 200
    } catch {
        return $false
    }
}

if (Test-PublisherServer) {
    exit 0
}
if (-not (Test-Path $RuntimePython)) {
    throw "Bundled Python runtime not found: $RuntimePython"
}
if (-not (Test-Path $ServerScript)) {
    throw "Application entry point not found: $ServerScript"
}

foreach ($DataFolder in @("archive", "drafts", "private", "logs")) {
    New-Item -ItemType Directory -Force -Path (Join-Path $DataRoot $DataFolder) | Out-Null
}

$env:WECHAT_ARCHIVE_DIR = Join-Path $DataRoot "archive"
$env:WECHAT_IMPORT_DIR = Join-Path $DataRoot "archive"
$env:WECHAT_ARCHIVE_JOB_DIR = Join-Path $DataRoot "private\archive-jobs"
$env:WECHAT_ARCHIVE_LOG_DIR = Join-Path $DataRoot "logs"
$env:WECHAT_COOKIE_FILE = Join-Path $DataRoot "private\wechat-cookies.pkl"
$env:WECHAT_DRAFTS_DIR = Join-Path $DataRoot "drafts"
$env:WECHAT_ACCOUNTS_FILE = Join-Path $DataRoot "private\wechat-accounts.json"
$NetworkConfig = Join-Path $DataRoot "private\company-network.json"
$env:WECHAT_NETWORK_CONFIG = $NetworkConfig
$env:ARCHIVE_PORT = "8899"
$env:ARCHIVE_NO_OPEN = "1"
$env:PYTHONUTF8 = "1"
$env:PYTHONUNBUFFERED = "1"

$OutputLog = Join-Path $LogRoot "server.out.log"
$ErrorLog = Join-Path $LogRoot "server.err.log"
$Process = Start-Process `
    -FilePath $RuntimePython `
    -ArgumentList @("`"$ServerScript`"") `
    -WorkingDirectory $AppRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $OutputLog `
    -RedirectStandardError $ErrorLog `
    -PassThru

Set-Content -Path $PidFile -Value $Process.Id -Encoding Ascii

for ($Attempt = 0; $Attempt -lt 40; $Attempt++) {
    Start-Sleep -Milliseconds 500
    if (Test-PublisherServer) {
        exit 0
    }
    if ($Process.HasExited) {
        break
    }
}

$Details = ""
if (Test-Path $ErrorLog) {
    $Details = (Get-Content $ErrorLog -Tail 30 | Out-String).Trim()
}
throw "Server startup failed. Check $ErrorLog`n$Details"
