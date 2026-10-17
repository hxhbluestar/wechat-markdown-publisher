param()
$ErrorActionPreference = 'Stop'
$SourceRoot = Split-Path -Parent $PSScriptRoot
$PackageRoot = Split-Path -Parent $SourceRoot
$InstallRoot = Join-Path $env:LOCALAPPDATA 'WechatMarkdownPublisher'
$RuntimePython = Join-Path $InstallRoot 'runtime\python.exe'
$ServerScript = Join-Path $InstallRoot 'app\web\server.py'
$PidFile = Join-Path $InstallRoot 'data\server.pid'
$PowerShellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$BackupRoot = Join-Path $SourceRoot ('releases\typography-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))

function Get-OwnedServers {
    $Listeners = @(Get-NetTCPConnection -ErrorAction Stop | Where-Object {
        $_.LocalPort -eq 8899 -and $_.State -eq 'Listen'
    })
    $CandidateIds = @($Listeners | Select-Object -ExpandProperty OwningProcess)
    if (Test-Path -LiteralPath $PidFile -PathType Leaf) {
        $RecordedId = 0
        if (-not [int]::TryParse((Get-Content -LiteralPath $PidFile -Raw).Trim(), [ref]$RecordedId) -or $RecordedId -le 0) {
            throw 'Invalid publisher PID file; inspect it before deployment'
        }
        $CandidateIds += $RecordedId
    }
    $OwnedProcesses = @()
    $ScriptArgument = '(?:^|\s)"?' + [regex]::Escape($ServerScript) + '"?(?=\s|$)'
    foreach ($CandidateId in @($CandidateIds | Select-Object -Unique)) {
        $ServerProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $CandidateId" -ErrorAction Stop
        if ($null -eq $ServerProcess) { continue }
        if ($ServerProcess.ExecutablePath -ne $RuntimePython -or [string]$ServerProcess.CommandLine -notmatch $ScriptArgument) {
            throw "Refusing to stop an unrelated process: $CandidateId"
        }
        $OwnedProcesses += $ServerProcess
    }
    return $OwnedProcesses
}

function Assert-OwnedServerIdle {
    param([array]$OwnedProcesses)
    if ($OwnedProcesses.Count -eq 0) { return }
    $OwnedIds = @($OwnedProcesses | Select-Object -ExpandProperty ProcessId)
    # Observe both local requests and outbound uploads/API calls. Require three
    # quiet samples, then repeat this check immediately before stopping service.
    for ($Check = 0; $Check -lt 3; $Check++) {
        $Active = @(Get-NetTCPConnection -ErrorAction Stop | Where-Object {
            $_.OwningProcess -in $OwnedIds -and $_.State -notin @('Listen', 'Bound', 'Closed', 'TimeWait', 'DeleteTcb')
        })
        if ($Active.Count -gt 0) {
            throw 'Publisher has active connections; finish synchronization/archive tasks and close editor windows before deployment'
        }
        if ($Check -lt 2) { Start-Sleep -Seconds 1 }
    }
}

function Stop-OwnedServer {
    param([switch]$RequireIdle)
    $OwnedProcesses = @(Get-OwnedServers)
    if ($RequireIdle) { Assert-OwnedServerIdle -OwnedProcesses $OwnedProcesses }
    foreach ($OwnedProcess in $OwnedProcesses) {
        Stop-Process -Id $OwnedProcess.ProcessId -Force
        Wait-Process -Id $OwnedProcess.ProcessId -Timeout 10 -ErrorAction SilentlyContinue
        if ($null -ne (Get-CimInstance Win32_Process -Filter "ProcessId = $($OwnedProcess.ProcessId)" -ErrorAction Stop)) {
            throw "Publisher process did not stop: $($OwnedProcess.ProcessId)"
        }
    }
}

function Start-OwnedServer {
    & $PowerShellExe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $InstallRoot 'scripts\start-server.ps1')
    if ($LASTEXITCODE -ne 0) { throw 'Publisher startup failed' }
    $Response = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8899/editor/' -TimeoutSec 5
    if ($Response.StatusCode -ne 200) { throw 'Publisher editor health check failed' }
    $Listeners = @(Get-NetTCPConnection -ErrorAction Stop | Where-Object {
        $_.LocalPort -eq 8899 -and $_.State -eq 'Listen'
    })
    if ($Listeners.Count -ne 1 -or $Listeners[0].LocalAddress -ne '127.0.0.1') { throw 'Unexpected listener' }
    $null = @(Get-OwnedServers)
}

function New-TypographyChanges {
    # Only code/static resources and package version metadata are replaced.
    # Network configuration, credentials, cookies, drafts, and runtime stay out
    # of this release manifest. Existing startup scripts are reused unchanged.
    $Files = @(
        'app\web\server.py',
        'app\web\rocm_import.py',
        'app\web\editor_service.py',
        'app\web\editor_security.py',
        'app\web\editor\index.html',
        'app\web\editor\assets\index-20261017-colors.js',
        'app\web\editor\assets\typography-20261017-colors.mjs',
        'app\web\editor\assets\typography-controls-20261017-colors.mjs',
        'app\web\editor\assets\typography-controls-20261017-colors.css',
        'app\web\editor\assets\rocm-import-20261017.mjs',
        'app\web\vendor\highlight-powershell-11.11.1.min.js',
        'app\web\vendor\highlight-extras-11.11.1.js',
        'app\web\vendor\highlight-ai-20261017.js',
        'app\web\vendor\README.md'
    )
    $Changes = @()
    foreach ($Relative in $Files) {
        foreach ($DestinationRoot in @($InstallRoot, (Join-Path $PackageRoot 'payload'))) {
            $Changes += @{
                source = Join-Path $SourceRoot $Relative
                target = Join-Path $DestinationRoot $Relative
            }
        }
    }
    foreach ($Destination in @((Join-Path $InstallRoot 'version.json'), (Join-Path $PackageRoot 'payload\version.json'))) {
        $Changes += @{source = Join-Path $SourceRoot 'packaging\version.json'; target = $Destination}
    }
    foreach ($Change in $Changes) {
        if (-not (Test-Path -LiteralPath $Change.source -PathType Leaf)) { throw "Missing source: $($Change.source)" }
        if ((Test-Path -LiteralPath $Change.target) -and -not (Test-Path -LiteralPath $Change.target -PathType Leaf)) {
            throw "Target is not a regular file: $($Change.target)"
        }
        $Change.source_sha256 = (Get-FileHash -LiteralPath $Change.source -Algorithm SHA256).Hash
    }
    return $Changes
}

function Invoke-TypographyDeployment {
    if (-not (Test-Path -LiteralPath $RuntimePython -PathType Leaf)) { throw 'Installed Python runtime missing' }
    if (-not (Test-Path -LiteralPath (Join-Path $InstallRoot 'scripts\start-server.ps1') -PathType Leaf)) {
        throw 'Installed startup script missing'
    }
    $Changes = @(New-TypographyChanges)
    $OwnedProcesses = @(Get-OwnedServers)
    Assert-OwnedServerIdle -OwnedProcesses $OwnedProcesses
    New-Item -ItemType Directory -Path $BackupRoot | Out-Null
    $Number = 0
    foreach ($Change in $Changes) {
        $Change.existed = Test-Path -LiteralPath $Change.target -PathType Leaf
        $Change.backup = Join-Path $BackupRoot ("original-$Number")
        $Change.original_sha256 = ''
        if ($Change.existed) {
            $Change.original_sha256 = (Get-FileHash -LiteralPath $Change.target -Algorithm SHA256).Hash
            Copy-Item -LiteralPath $Change.target -Destination $Change.backup
            if ((Get-FileHash -LiteralPath $Change.backup -Algorithm SHA256).Hash -ne $Change.original_sha256) {
                throw 'Backup verification failed'
            }
        }
        $Number++
    }
    $Changes | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $BackupRoot 'manifest.json') -Encoding UTF8

    $Stopped = $false
    try {
        Stop-OwnedServer -RequireIdle
        $Stopped = $true
        foreach ($Change in $Changes) {
            if ((Get-FileHash -LiteralPath $Change.source -Algorithm SHA256).Hash -ne $Change.source_sha256) {
                throw "Source changed after preflight: $($Change.source)"
            }
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Change.target) | Out-Null
            Copy-Item -LiteralPath $Change.source -Destination $Change.target -Force
            if ((Get-FileHash -LiteralPath $Change.target -Algorithm SHA256).Hash -ne $Change.source_sha256) {
                throw 'Copy verification failed'
            }
        }
        Start-OwnedServer
        Write-Output "Deployment complete. Backup: $BackupRoot"
    } catch {
        $DeploymentError = $_
        if (-not $Stopped) { throw $DeploymentError }
        # Stop any replacement process before restoring modules it may use.
        Stop-OwnedServer
        foreach ($Change in $Changes) {
            if ($Change.existed) {
                Copy-Item -LiteralPath $Change.backup -Destination $Change.target -Force
                if ((Get-FileHash -LiteralPath $Change.target -Algorithm SHA256).Hash -ne $Change.original_sha256) {
                    throw "Rollback verification failed; backup: $BackupRoot"
                }
            } elseif (Test-Path -LiteralPath $Change.target -PathType Leaf) {
                Remove-Item -LiteralPath $Change.target -Force
            }
        }
        Start-OwnedServer
        throw $DeploymentError
    }
}

# Dot-sourcing exposes functions for isolated tests without deploying anything.
if ($MyInvocation.InvocationName -ne '.') { Invoke-TypographyDeployment }
