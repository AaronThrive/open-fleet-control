<#
.SYNOPSIS
    Registers this Windows machine as a fleet node in an OpenFleetControl
    dashboard.

.DESCRIPTION
    POSTs to <DashboardUrl>/api/fleet/mesh/nodes with the node's hostname,
    port, health path, platform, and optional label.

    If the local Tailscale client is logged in, the operator identity
    (Self login name from `tailscale status --json`) is forwarded in the
    Tailscale-User-Login header so the dashboard audit log records who
    registered the node. If unavailable, the header is omitted and the
    dashboard records "anonymous".

    Compatible with Windows PowerShell 5.1 and PowerShell 7+.

.PARAMETER DashboardUrl
    Base URL of the dashboard, e.g. https://oc-bot-1.tail1234.ts.net:8443
    (no trailing slash required). Mandatory.

.PARAMETER Hostname
    Tailnet machine name of THIS node as the dashboard should poll it.
    Default: $env:COMPUTERNAME lowercased. Must match ^[a-z0-9-]+$ and must
    equal the machine name shown in `tailscale status` / the Tailscale admin
    console, or health polling will fail.

.PARAMETER Port
    Port the dashboard polls. Default 443 (the port `tailscale serve`
    listens on).

.PARAMETER Platform
    Node platform reported to the dashboard. Default: windows-wsl.
    Valid values: linux, windows-wsl, macos, unknown.

.PARAMETER Label
    Optional human-readable label (max 120 characters). Defaults to the
    hostname on the dashboard side when omitted.

.PARAMETER HealthPath
    Health endpoint path. Default: /health.

.EXAMPLE
    .\register-node.ps1 -DashboardUrl "https://oc-bot-1.tail1234.ts.net:8443"

.EXAMPLE
    .\register-node.ps1 -DashboardUrl "https://oc-bot-1.tail1234.ts.net:8443" -Hostname win-node-1 -Label "Office Windows PC"

.NOTES
    See docs/guides/windows-node.md for the full onboarding walkthrough.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$DashboardUrl,

    [string]$Hostname = "$env:COMPUTERNAME".ToLowerInvariant(),

    [ValidateRange(1, 65535)]
    [int]$Port = 443,

    [ValidateSet('linux', 'windows-wsl', 'macos', 'unknown')]
    [string]$Platform = 'windows-wsl',

    [ValidateLength(0, 120)]
    [string]$Label,

    [ValidatePattern('^/')]
    [string]$HealthPath = '/health'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Find-TailscaleExe {
    <# Returns the path to tailscale.exe, or $null when not installed. #>
    $cmd = Get-Command tailscale -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $default = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
    if (Test-Path $default) { return $default }
    return $null
}

function Get-TailscaleLogin {
    <# Best-effort Self login name from `tailscale status --json`. #>
    $exe = Find-TailscaleExe
    if (-not $exe) { return $null }
    try {
        $raw = & $exe status --json 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $raw) { return $null }
        $status = ($raw -join "`n") | ConvertFrom-Json
        $selfUserId = "$($status.Self.UserID)"
        if (-not $selfUserId) { return $null }
        $user = $status.User.$selfUserId
        if ($user -and $user.LoginName) { return [string]$user.LoginName }
    } catch {
        Write-Verbose "Could not read Tailscale identity: $($_.Exception.Message)"
    }
    return $null
}

function Read-HttpErrorBody {
    <# Extracts the response body from a web exception (PS 5.1 + 7). #>
    param([Parameter(Mandatory = $true)]$ErrorRecord)
    try {
        $response = $ErrorRecord.Exception.Response
        if (-not $response) { return $null }
        if ($response -is [System.Net.HttpWebResponse]) {
            $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
            return $reader.ReadToEnd()
        }
        # PowerShell 7: ErrorDetails usually carries the body.
        if ($ErrorRecord.ErrorDetails -and $ErrorRecord.ErrorDetails.Message) {
            return $ErrorRecord.ErrorDetails.Message
        }
    } catch { }
    return $null
}

# --- Validate inputs the dashboard would reject anyway -----------------------
if ($Hostname -cnotmatch '^[a-z0-9-]+$') {
    throw ("Invalid -Hostname '$Hostname': must be lowercase letters, digits, " +
           "and hyphens only. Rename the machine in the Tailscale admin " +
           "console (https://login.tailscale.com/admin/machines) or pass " +
           "-Hostname explicitly.")
}
$baseUrl = $DashboardUrl.TrimEnd('/')
if ($baseUrl -notmatch '^https?://') {
    throw "Invalid -DashboardUrl '$DashboardUrl': must start with http:// or https://"
}

# --- Build request ------------------------------------------------------------
$endpoint = "$baseUrl/api/fleet/mesh/nodes"
$bodyHash = @{
    hostname   = $Hostname
    port       = $Port
    healthPath = $HealthPath
    platform   = $Platform
}
if ($Label) { $bodyHash.label = $Label }
$body = $bodyHash | ConvertTo-Json -Compress

$headers = @{}
$login = Get-TailscaleLogin
if ($login) {
    $headers['Tailscale-User-Login'] = $login
    Write-Host "Registering as Tailscale user: $login"
} else {
    Write-Warning "Tailscale identity unavailable - registering without Tailscale-User-Login header (audited as 'anonymous')."
}

Write-Host "POST $endpoint"
Write-Host "Body: $body"

# --- Send ----------------------------------------------------------------------
try {
    $result = Invoke-RestMethod -Method Post -Uri $endpoint `
        -ContentType 'application/json' -Headers $headers -Body $body `
        -TimeoutSec 30
} catch {
    $detail = Read-HttpErrorBody -ErrorRecord $_
    Write-Error ("Registration failed: $($_.Exception.Message)" +
        $(if ($detail) { "`nDashboard response: $detail" } else { '' }))
    exit 1
}

# --- Report ----------------------------------------------------------------------
Write-Host ''
Write-Host 'Registration succeeded:' -ForegroundColor Green
$result | ConvertTo-Json -Depth 5 | Write-Host
Write-Host ''
Write-Host ("The dashboard will poll https://{0}.<your-magicdns-suffix>{1}{2} " -f `
    $Hostname, $(if ($Port -eq 443) { '' } else { ":$Port" }), $HealthPath)
Write-Host 'Expect the node to show online within one poll interval (~15 s).'
