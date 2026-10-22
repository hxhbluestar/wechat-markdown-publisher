function Get-PublisherEditorTarget {
    param([Parameter(Mandatory=$true)][string]$Root)
    $Path=Join-Path $Root 'data/private/server-target.json'
    if(-not (Test-Path -LiteralPath $Path -PathType Leaf)){return $null}
    $Config=Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
    $Parsed=$null
    if(-not [Uri]::TryCreate([string]$Config.url,[UriKind]::Absolute,[ref]$Parsed) -or $Parsed.Scheme -ne 'https' -or -not $Parsed.Host -or $Parsed.UserInfo -or $Parsed.Query -or $Parsed.Fragment){
        throw 'Remote editor configuration requires an HTTPS URL without credentials, query or fragment'
    }
    return $Parsed.AbsoluteUri
}
