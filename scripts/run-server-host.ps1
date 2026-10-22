param([ValidateSet('backend','gateway')][string]$Component='backend')
$ErrorActionPreference='Stop'
$Root=Split-Path -Parent $PSScriptRoot
$Config=Get-Content -LiteralPath (Join-Path $Root 'data/private/server-host.json') -Raw | ConvertFrom-Json
Set-Location -LiteralPath $Root
if($Component -eq 'gateway') {
    $env:PUBLISHER_LISTEN_IP=$Config.listen_ip
    $env:PUBLISHER_HTTPS_PORT=[string]$Config.https_port
    $env:PUBLISHER_BACKEND_PORT=[string]$Config.backend_port
    $env:PUBLISHER_LOGIN_USER=$Config.login_user
    $env:PUBLISHER_PASSWORD_HASH=$Config.password_hash
    $env:PUBLISHER_ORIGIN="https://$($Config.listen_ip):$($Config.https_port)"
    & (Join-Path $Root 'gateway/caddy.exe') run --config (Join-Path $Root 'gateway/Caddyfile') --adapter caddyfile
} else {
    $Data=Join-Path $Root 'data'
    $env:WECHAT_DRAFTS_DIR=Join-Path $Data 'drafts'
    $env:WECHAT_ACCOUNTS_FILE=Join-Path $Data 'private/wechat-accounts.json'
    $env:WECHAT_NETWORK_CONFIG=Join-Path $Data 'private/company-network.json'
    $env:WECHAT_ARCHIVE_DIR=Join-Path $Data 'archive'
    $env:WECHAT_IMPORT_DIR=$env:WECHAT_ARCHIVE_DIR
    $env:WECHAT_ARCHIVE_JOB_DIR=Join-Path $Data 'private/archive-jobs'
    $env:WECHAT_ARCHIVE_LOG_DIR=Join-Path $Data 'logs'
    $env:WECHAT_COOKIE_FILE=Join-Path $Data 'private/wechat-cookies.pkl'
    $env:ARCHIVE_PORT=[string]$Config.backend_port
    $env:ARCHIVE_NO_OPEN='1'
    $env:PYTHONUTF8='1'
    $env:PYTHONUNBUFFERED='1'
    & (Join-Path $Root 'runtime/python.exe') -u -X utf8 (Join-Path $Root 'app/web/server.py')
}
if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}
