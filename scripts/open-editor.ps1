$ErrorActionPreference = "Stop"

try {
    . (Join-Path $PSScriptRoot 'editor-target.ps1')
    $RemoteTarget=Get-PublisherEditorTarget -Root (Split-Path -Parent $PSScriptRoot)
    if($RemoteTarget){
        Start-Process $RemoteTarget
        exit 0
    }
    & (Join-Path $PSScriptRoot "start-server.ps1")
    Start-Process "http://127.0.0.1:8899/editor/"
    exit 0
} catch {
    $Message = "WeChat Markdown Publisher could not start.`n`n$($_.Exception.Message)"
    try {
        Add-Type -AssemblyName PresentationFramework
        [System.Windows.MessageBox]::Show($Message, "WeChat Markdown Publisher") | Out-Null
    } catch {
        Write-Error $Message
    }
    exit 1
}
