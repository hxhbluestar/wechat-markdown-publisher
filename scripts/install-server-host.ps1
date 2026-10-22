param([Parameter(Mandatory=$true)][string]$Root,[string[]]$RemoteScope=@('LocalSubnet'))
$ErrorActionPreference='Stop'
if(-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Run as administrator'}
$Root=(Resolve-Path -LiteralPath $Root).Path
foreach($file in @('runtime/python.exe','app/web/server.py','gateway/caddy.exe','gateway/Caddyfile','scripts/run-server-host.ps1','data/private/server-host.json','data/private/server.crt','data/private/server.key')){
    if(-not (Test-Path -LiteralPath (Join-Path $Root $file) -PathType Leaf)){throw "Missing server file: $file"}
}
$Config=Get-Content -LiteralPath (Join-Path $Root 'data/private/server-host.json') -Raw | ConvertFrom-Json
foreach($port in @($Config.https_port,$Config.backend_port)){
    if(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue){throw "Port already in use: $port"}
}
foreach($component in @('backend','gateway')){
    $name="WechatMarkdownPublisher-$component"
    if(Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue){throw "Task already exists; use maintenance restart: $name"}
}
foreach($component in @('backend','gateway')){
    $name="WechatMarkdownPublisher-$component"
    $runner=Join-Path $Root 'scripts/run-server-host.ps1'
    $action=New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument "-NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$runner`" -Component $component" -WorkingDirectory $Root
    $settings=New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName $name -Action $action -Trigger (New-ScheduledTaskTrigger -AtStartup) -Settings $settings -User 'SYSTEM' -RunLevel Highest | Out-Null
}
New-NetFirewallRule -Name 'WechatMarkdownPublisher-HTTPS' -DisplayName 'Wechat Markdown Publisher HTTPS (LAN)' -Direction Inbound -Action Allow -Protocol TCP -LocalAddress $Config.listen_ip -LocalPort $Config.https_port -RemoteAddress $RemoteScope -Profile Any | Out-Null
Start-ScheduledTask -TaskName 'WechatMarkdownPublisher-backend'
Start-ScheduledTask -TaskName 'WechatMarkdownPublisher-gateway'
Write-Output 'Server startup tasks and scoped HTTPS firewall rule installed'
