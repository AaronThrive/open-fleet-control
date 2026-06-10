# Windows Node Scripts

PowerShell helpers for onboarding a Windows machine as an OpenFleetControl
fleet node (gateway in WSL2, exposed via `tailscale serve`, polled by the
dashboard over tailnet HTTPS).

Full walkthrough: [docs/guides/windows-node.md](../../docs/guides/windows-node.md).
Both scripts run on Windows PowerShell 5.1 and PowerShell 7+, need no admin
rights for the default flow, and hardcode no tailnet names or URLs.

## install-node.ps1

One-shot (and safely re-runnable) setup check + serve configuration:

1. Verifies `tailscale.exe` is installed and logged in.
2. Verifies WSL2 is available.
3. Probes common gateway ports on `localhost` and reports which answer
   `/health`.
4. Runs `tailscale serve --bg <GatewayPort>` (default `18789`).
5. Verifies `https://<machine>.<suffix>.ts.net/health` returns 200
   (retries while the TLS certificate is issued).
6. Prints the exact registration command — or registers directly with
   `-Register`.

```powershell
# Checks + serve only; prints the registration command at the end
powershell -ExecutionPolicy Bypass -File .\install-node.ps1

# Custom gateway port
powershell -ExecutionPolicy Bypass -File .\install-node.ps1 -GatewayPort 18790

# Full setup including dashboard registration
powershell -ExecutionPolicy Bypass -File .\install-node.ps1 `
    -DashboardUrl "https://oc-bot-1.<tailnet>.ts.net:8443" -Register -Label "Office PC"
```

Other flags: `-SkipServe` (checks and verification only).

## register-node.ps1

Registers this machine in a dashboard's mesh
(`POST <DashboardUrl>/api/fleet/mesh/nodes`). Forwards your Tailscale login
as the `Tailscale-User-Login` header for the dashboard audit log when
available.

| Parameter | Default | Notes |
| --- | --- | --- |
| `-DashboardUrl` | (required) | e.g. `https://oc-bot-1.<tailnet>.ts.net:8443` |
| `-Hostname` | `$env:COMPUTERNAME` lowercased | Must match the tailnet machine name, `^[a-z0-9-]+$` |
| `-Port` | `443` | Port the dashboard polls (`tailscale serve` listens on 443) |
| `-Platform` | `windows-wsl` | One of `linux`, `windows-wsl`, `macos`, `unknown` |
| `-Label` | (none) | Optional, max 120 chars |
| `-HealthPath` | `/health` | Must start with `/` |

```powershell
powershell -ExecutionPolicy Bypass -File .\register-node.ps1 `
    -DashboardUrl "https://oc-bot-1.<tailnet>.ts.net:8443"
```

Success prints the dashboard's response and the URL it will poll; the node
should show **online** within one poll interval (~15 s).

## Getting help

```powershell
Get-Help .\install-node.ps1 -Full
Get-Help .\register-node.ps1 -Full
```
