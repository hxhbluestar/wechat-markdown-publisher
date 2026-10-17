param(
    [string]$SourceRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$PackageRoot = '',
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'WechatMarkdownPublisher')
)
$ErrorActionPreference = 'Stop'

function Assert-NoReparsePath {
    param([string]$Path)
    $Cursor = [IO.Path]::GetFullPath($Path)
    while ($Cursor) {
        if (Test-Path -LiteralPath $Cursor) {
            $Entry = Get-Item -LiteralPath $Cursor -Force -ErrorAction Stop
            if (($Entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'Deployment paths must not traverse symlinks or reparse points'
            }
        }
        $Parent = Split-Path -Parent $Cursor
        if (-not $Parent -or $Parent -eq $Cursor) { break }
        $Cursor = $Parent
    }
}

function Resolve-DeploymentRoot {
    param([string]$Value, [string]$Name)
    if (-not $Value -or -not [IO.Path]::IsPathRooted($Value) -or $Value -match '^[A-Za-z]:[^\\/]') { throw "$Name must be an absolute directory" }
    $Full = [IO.Path]::GetFullPath($Value).TrimEnd([char[]]@('\','/'))
    if ($Full -eq ([IO.Path]::GetPathRoot($Full)).TrimEnd([char[]]@('\','/'))) { throw "$Name must not be a filesystem root" }
    if (-not (Test-Path -LiteralPath $Full -PathType Container)) { throw "$Name directory does not exist" }
    Assert-NoReparsePath -Path $Full
    return $Full
}

function Assert-DeploymentChild {
    param([string]$Root, [string]$Path)
    $Full = [IO.Path]::GetFullPath($Path)
    $Prefix = $Root.TrimEnd([char[]]@('\','/')) + [IO.Path]::DirectorySeparatorChar
    if (-not $Full.StartsWith($Prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Deployment target escaped its validated root' }
    Assert-NoReparsePath -Path $Full
}

$SourceRoot = Resolve-DeploymentRoot -Value $SourceRoot -Name 'SourceRoot'
if (-not $PackageRoot) {
    if ($SourceRoot -match '(?i)[\\/](?:\.worktrees|worktrees)[\\/]') {
        throw 'An isolated worktree requires an explicit PackageRoot; no payload path was inferred'
    }
    $PackageRoot = Split-Path -Parent $SourceRoot
}
$PackageRoot = Resolve-DeploymentRoot -Value $PackageRoot -Name 'PackageRoot'
$InstallRoot = Resolve-DeploymentRoot -Value $InstallRoot -Name 'InstallRoot'
$PayloadRoot = Join-Path $PackageRoot 'payload'
if ($SourceRoot -eq $PackageRoot -or $SourceRoot -eq $InstallRoot -or $InstallRoot -eq $PackageRoot -or $InstallRoot -eq $PayloadRoot) {
    throw 'SourceRoot, PackageRoot and installation/payload roots must be distinct'
}
$SourcePrefix = $SourceRoot + [IO.Path]::DirectorySeparatorChar
if ($InstallRoot.StartsWith($SourcePrefix, [StringComparison]::OrdinalIgnoreCase) -or $PayloadRoot.StartsWith($SourcePrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Installation and payload destinations must be outside SourceRoot'
}
Assert-NoReparsePath -Path $PayloadRoot
$RuntimePython = Join-Path $InstallRoot 'runtime\python.exe'
$ServerScript = Join-Path $InstallRoot 'app\web\server.py'
$PidFile = Join-Path $InstallRoot 'data\server.pid'
$PowerShellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$BackupRoot = Join-Path $SourceRoot ('releases\typography-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '-' + [guid]::NewGuid().ToString('N').Substring(0,8))

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
    $ManifestPath = Join-Path $SourceRoot 'config\deployment-files.json'
    Assert-DeploymentChild -Root $SourceRoot -Path $ManifestPath
    $Release = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
    if ($Release.schema_version -ne 1 -or -not ($Release.release -match '^\d{4}\.\d{2}\.\d{2}-[a-z0-9.-]+$') -or -not $Release.files -or $Release.files.Count -gt 128) {
        throw 'Invalid deployment release manifest'
    }
    $Backend = @('server.py','rocm_import.py','editor_service.py','editor_security.py','draft_history.py','article_import.py','article_package.py','asset_workbench.py','asset_service.py','server_preflight.py','sync_jobs.py','sync_workflow.py','sync_verification.py')
    $Seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $Files = @()
    foreach ($Relative in $Release.files) {
        if ($Relative -isnot [string] -or $Relative -match '[\\:\x00-\x1f]' -or $Relative -match '(^|/)\.\.?(?:/|$)' -or -not $Seen.Add($Relative)) {
            throw 'Unsafe or duplicate deployment manifest path'
        }
        $Allowed = $false
        if ($Relative -match '^app/web/([^/]+\.py)$') { $Allowed = $Matches[1] -cin $Backend }
        if ($Relative -ceq 'app/web/editor/index.html' -or $Relative -cmatch '^app/web/editor/assets/[A-Za-z0-9_.-]+\.(?:js|mjs|css)$') { $Allowed = $true }
        if ($Relative -cin @('app/web/vendor/highlight-powershell-11.11.1.min.js','app/web/vendor/highlight-extras-11.11.1.js','app/web/vendor/highlight-ai-20261017.js','app/web/vendor/README.md','app/web/vendor/mathjax-3.2.2/tex-svg.js','app/web/vendor/mathjax-3.2.2/LICENSE')) { $Allowed = $true }
        if (-not $Allowed) { throw 'Deployment manifest includes a path outside the code/static allowlist' }
        $Files += $Relative
    }
    $Changes = @()
    foreach ($Relative in $Files) {
        foreach ($DestinationRoot in @($InstallRoot, $PayloadRoot)) {
            $Changes += @{
                source = Join-Path $SourceRoot $Relative
                target = Join-Path $DestinationRoot $Relative
                target_root = $DestinationRoot
            }
        }
    }
    foreach ($DestinationRoot in @($InstallRoot, $PayloadRoot)) {
        $Changes += @{source = Join-Path $SourceRoot 'packaging\version.json'; target = (Join-Path $DestinationRoot 'version.json'); target_root = $DestinationRoot}
    }
    foreach ($Change in $Changes) {
        Assert-DeploymentChild -Root $SourceRoot -Path $Change.source
        Assert-DeploymentChild -Root $Change.target_root -Path $Change.target
        if (-not (Test-Path -LiteralPath $Change.source -PathType Leaf)) { throw "Missing source: $($Change.source)" }
        if ((Test-Path -LiteralPath $Change.target) -and -not (Test-Path -LiteralPath $Change.target -PathType Leaf)) {
            throw "Target is not a regular file: $($Change.target)"
        }
        $Change.source_sha256 = (Get-FileHash -LiteralPath $Change.source -Algorithm SHA256).Hash
    }
    return $Changes
}

function Invoke-TypographyDeployment {
    Assert-NoReparsePath -Path $RuntimePython
    Assert-NoReparsePath -Path (Join-Path $InstallRoot 'scripts\start-server.ps1')
    if (-not (Test-Path -LiteralPath $RuntimePython -PathType Leaf)) { throw 'Installed Python runtime missing' }
    if (-not (Test-Path -LiteralPath (Join-Path $InstallRoot 'scripts\start-server.ps1') -PathType Leaf)) {
        throw 'Installed startup script missing'
    }
    $Changes = @(New-TypographyChanges)
    $OwnedProcesses = @(Get-OwnedServers)
    Assert-OwnedServerIdle -OwnedProcesses $OwnedProcesses
    Assert-DeploymentChild -Root $SourceRoot -Path $BackupRoot
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
            Assert-DeploymentChild -Root $SourceRoot -Path $Change.source
            Assert-DeploymentChild -Root $Change.target_root -Path $Change.target
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
            Assert-DeploymentChild -Root $Change.target_root -Path $Change.target
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
