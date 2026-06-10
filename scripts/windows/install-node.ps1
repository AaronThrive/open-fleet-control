<#
.SYNOPSIS
    Idempotent helper that wires up a Windows machine as an OpenFleetControl
    fleet node: checks Tailscale and WSL2, configures `tailscale serve` for
    the gateway port, verifies tailnet HTTPS reachability, and prints (or
    runs) the dashboard registration call.

.DESCRIPTION
    Steps performed (all read-only checks unless noted):
      1. Locate tailscale.exe and confirm the client is logged in.
      2. Confirm WSL2 is available.
      3. Probe common local gateway ports and report which respond to /health.
      4. Configure `tailscale serve --bg <GatewayPort>` (idempotent - re-running
         with the same port is a no-op for Tailscale).
      5. Verify https://<machine>.<suffix>.ts.net/health responds.
      6. Print the exact registration curl for the dashboard, or - with
         -Register and -DashboardUrl - call register-node.ps1 directly.

    Safe to re-run at any time. No tailnet names, hostnames, or URLs are
    hardcoded. Compatible with Windows PowerShell 5.1 and PowerShell 7+.

.PARAMETER GatewayPort
    Local port the OpenClaw gateway listens on (as reachable from the
    Windows side - see docs/guides/windows-node.md step 4). Default 18789.

.PARAMETER DashboardUrl
    Base URL of the fleet dashboard, e.g.
    https://oc-bot-1.tail1234.ts.net:8443. Used to print the registration
    command, and required when -Register is set.

.PARAMETER Register
    When set (requires -DashboardUrl), invokes register-node.ps1 to register
    this node in the dashboard after verification passes.

.PARAMETER Label
    Optional node label forwarded to register-node.ps1 when -Register is set.

.PARAMETER SkipServe
    Skip the `tailscale serve` configuration step (checks and verification
    only).

.EXAMPLE
    .\install-node.ps1
    Checks everything and configures serve for port 18789.

.EXAMPLE
    .\install-node.ps1 -GatewayPort 18789 -DashboardUrl "https://oc-bot-1.tail1234.ts.net:8443" -Register
    Full setup plus registration in the dashboard.

.NOTES
    See docs/guides/windows-node.md for the full onboarding walkthrough.
#>
[CmdletBinding()]
param(
    [ValidateRange(1, 65535)]
    [int]$GatewayPort = 18789,

    [string]$DashboardUrl,

    [switch]$Register,

    [ValidateLength(0, 120)]
    [string]$Label,

    [switch]$SkipServe
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Ports the OpenClaw gateway commonly listens on (default first).
$script:CommonGatewayPorts = @(18789, 18788, 8787, 8080)

function Find-TailscaleExe {
    <# Returns the path to tailscale.exe, or $null when not installed. #>
    $cmd = Get-Command tailscale -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $default = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
    if (Test-Path $default) { return $default }
    return $null
}

function Get-TailscaleStatus {
    <# Parsed `tailscale status --json`, or $null on any failure. #>
    param([Parameter(Mandatory = $true)][string]$Exe)
    try {
        $raw = & $Exe status --json 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $raw) { return $null }
        return ($raw -join "`n") | ConvertFrom-Json
    } catch {
        return $null
    }
}

function Test-LocalHealth {
    <# True when http://localhost:<port>/health answers HTTP 200. #>
    param([Parameter(Mandatory = $true)][int]$Port)
    try {
        $resp = Invoke-WebRequest -Uri "http://localhost:$Port/health" `
            -UseBasicParsing -TimeoutSec 3
        return ($resp.StatusCode -eq 200)
    } catch {
        return $false
    }
}

function Test-Wsl2 {
    <# True when WSL is installed with default version 2. #>
    $wsl = Get-Command wsl.exe -ErrorAction SilentlyContinue
    if (-not $wsl) { return $false }
    try {
        # `wsl --status` output is UTF-16 on some builds; -split handles both.
        $out = (& wsl.exe --status 2>$null) -join "`n" -replace "`0", ''
        return ($out -match 'Default Version:\s*2' -or $out -match '2\s*$')
    } catch {
        return $false
    }
}

function Get-TsNetHostname {
    <# This machine's MagicDNS FQDN (no trailing dot), or $null. #>
    param([Parameter(Mandatory = $true)]$Status)
    if ($Status -and $Status.Self -and $Status.Self.DNSName) {
        return ([string]$Status.Self.DNSName).TrimEnd('.')
    }
    return $null
}

function Test-TsNetHealth {
    <# Polls https://<fqdn>/health, retrying while the TLS cert is issued. #>
    param(
        [Parameter(Mandatory = $true)][string]$Fqdn,
        [int]$Attempts = 4,
        [int]$DelaySeconds = 10
    )
    for ($i = 1; $i -le $Attempts; $i++) {
        try {
            $resp = Invoke-WebRequest -Uri "https://$Fqdn/health" `
                -UseBasicParsing -TimeoutSec 20
            if ($resp.StatusCode -eq 200) { return $true }
        } catch {
            Write-Host ("  attempt {0}/{1} failed ({2})" -f $i, $Attempts, `
                $_.Exception.Message)
        }
        if ($i -lt $Attempts) {
            Write-Host "  waiting ${DelaySeconds}s (first request may wait on TLS certificate issuance)..."
            Start-Sleep -Seconds $DelaySeconds
        }
    }
    return $false
}

function Write-Step {
    param([Parameter(Mandatory = $true)][string]$Message)
    Write-Host ''
    Write-Host "==> $Message" -ForegroundColor Cyan
}

if ($Register -and -not $DashboardUrl) {
    throw '-Register requires -DashboardUrl (e.g. https://oc-bot-1.<tailnet>.ts.net:8443)'
}

# --- 1. Tailscale present + logged in ----------------------------------------
Write-Step 'Checking Tailscale client'
$tailscaleExe = Find-TailscaleExe
if (-not $tailscaleExe) {
    Write-Error ('tailscale.exe not found. Install it from ' +
        'https://tailscale.com/download/windows, log in to the same tailnet ' +
        'as the dashboard, then re-run this script.')
    exit 1
}
Write-Host "  found: $tailscaleExe"

$tsStatus = Get-TailscaleStatus -Exe $tailscaleExe
if (-not $tsStatus -or $tsStatus.BackendState -ne 'Running') {
    $state = if ($tsStatus) { $tsStatus.BackendState } else { 'unavailable' }
    Write-Error ("Tailscale is installed but not running/logged in " +
        "(BackendState: $state). Click the tray icon, choose 'Log in...', " +
        "sign in to the SAME tailnet as the dashboard, then re-run.")
    exit 1
}
$fqdn = Get-TsNetHostname -Status $tsStatus
Write-Host "  logged in, machine FQDN: $fqdn"

# --- 2. WSL2 -------------------------------------------------------------------
Write-Step 'Checking WSL2'
if (Test-Wsl2) {
    Write-Host '  WSL2 available.'
} else {
    Write-Warning ('WSL2 not detected. The gateway normally runs inside ' +
        'WSL2 - see docs/guides/windows-node.md section 1, step 4 ' +
        '(`wsl --install` in an elevated PowerShell). Continuing checks anyway.')
}

# --- 3. Probe gateway ports ---------------------------------------------------
Write-Step 'Probing local gateway ports'
$portsToProbe = @($GatewayPort) + ($script:CommonGatewayPorts | Where-Object { $_ -ne $GatewayPort })
$reachablePorts = @()
foreach ($p in $portsToProbe) {
    if (Test-LocalHealth -Port $p) {
        $reachablePorts += $p
        Write-Host "  port ${p}: gateway /health OK" -ForegroundColor Green
    } else {
        Write-Host "  port ${p}: no response"
    }
}
if ($reachablePorts -notcontains $GatewayPort) {
    Write-Warning ("No gateway /health on localhost:$GatewayPort (Windows side). " +
        'Start the gateway (Hub app or WSL service) and fix WSL-to-Windows ' +
        'forwarding first - docs/guides/windows-node.md section 4 (mirrored ' +
        'networking or netsh portproxy).')
    if ($reachablePorts.Count -gt 0) {
        Write-Warning ("A gateway responded on port(s): $($reachablePorts -join ', '). " +
            'Re-run with -GatewayPort <port> if that is the right one.')
    }
    exit 1
}

# --- 4. tailscale serve --------------------------------------------------------
if ($SkipServe) {
    Write-Step 'Skipping tailscale serve configuration (-SkipServe)'
} else {
    Write-Step "Configuring tailscale serve --bg $GatewayPort"
    & $tailscaleExe serve --bg $GatewayPort
    if ($LASTEXITCODE -ne 0) {
        Write-Error ('`tailscale serve` failed. Common causes: HTTPS ' +
            'certificates not enabled on the tailnet ' +
            '(https://login.tailscale.com/admin/dns), or this user is not ' +
            'the Tailscale operator (retry in an elevated PowerShell).')
        exit 1
    }
    & $tailscaleExe serve status
}

# --- 5. Verify tailnet HTTPS ----------------------------------------------------
Write-Step "Verifying https://$fqdn/health"
if (-not $fqdn) {
    Write-Error ('Could not determine this machine''s MagicDNS name. Is ' +
        'MagicDNS enabled on the tailnet (https://login.tailscale.com/admin/dns)?')
    exit 1
}
if (-not (Test-TsNetHealth -Fqdn $fqdn)) {
    Write-Error ("https://$fqdn/health did not return 200. See the " +
        'troubleshooting table in docs/guides/windows-node.md section 9.')
    exit 1
}
Write-Host '  tailnet HTTPS health check passed.' -ForegroundColor Green

# --- 6. Registration --------------------------------------------------------------
$nodeHostname = ($fqdn -split '\.')[0]
$dashboardExample = if ($DashboardUrl) { $DashboardUrl.TrimEnd('/') } else { 'https://<dashboard-host>.<tailnet>.ts.net:8443' }

if ($Register) {
    Write-Step "Registering node '$nodeHostname' in $dashboardExample"
    $registerScript = Join-Path $PSScriptRoot 'register-node.ps1'
    $registerArgs = @{
        DashboardUrl = $DashboardUrl
        Hostname     = $nodeHostname
        Port         = 443
        Platform     = 'windows-wsl'
    }
    if ($Label) { $registerArgs.Label = $Label }
    & $registerScript @registerArgs
} else {
    Write-Step 'Node is reachable. Register it in the dashboard with either:'
    Write-Host ''
    Write-Host "  .\register-node.ps1 -DashboardUrl `"$dashboardExample`" -Hostname $nodeHostname"
    Write-Host ''
    Write-Host '  -- or the raw API call (from any tailnet machine): --'
    Write-Host ''
    Write-Host "  curl -X POST `"$dashboardExample/api/fleet/mesh/nodes`" \"
    Write-Host "    -H 'Content-Type: application/json' \"
    Write-Host "    -H 'Tailscale-User-Login: you@example.com' \"
    Write-Host "    -d '{`"hostname`":`"$nodeHostname`",`"port`":443,`"healthPath`":`"/health`",`"platform`":`"windows-wsl`"}'"
    Write-Host ''
    Write-Host '  -- or in the dashboard UI: Fleet -> Mesh -> Discover -> Register'
    Write-Host '     (platform: windows-wsl, port: 443, health path: /health)'
}
