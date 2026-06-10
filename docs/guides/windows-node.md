# Windows Fleet Node Guide

This guide onboards an Intel-based Windows computer as an **additional fleet
node** — a machine on your tailnet running an OpenClaw gateway that the main
dashboard (for example `https://oc-bot-1.<tailnet>.ts.net:8443`) polls over
HTTPS for health. It is written literally: every step tells you exactly where
to click or what to type.

This machine is a **node**, not the dashboard host. The dashboard already runs
elsewhere; here you only need a reachable gateway and one registration call.

Helper scripts for steps 4–6 live in
[`scripts/windows/`](../../scripts/windows/README.md)
([install-node.ps1](../../scripts/windows/install-node.ps1),
[register-node.ps1](../../scripts/windows/register-node.ps1)).
General (all-platform) onboarding background is in
[node-setup.md](node-setup.md).

---

## 1. Prerequisites

Check all of these before starting:

1. **Windows version**: Windows 10 version 20H2 or newer, or any Windows 11.
   - Press **Win + R**, type `winver`, press **Enter**. The dialog shows the
     version. Windows 11 22H2+ is required for the *mirrored networking* path
     in step 4A (older versions use the portproxy fallback in step 4B).
2. **Tailscale Windows client, signed into the SAME tailnet as the dashboard**:
   - Download from `https://tailscale.com/download/windows`, run the
     installer, accept defaults.
   - Click the Tailscale icon in the system tray (the chain-link icon; click
     the `^` arrow if it is hidden), click **Log in...**, and sign in with the
     **same account/tailnet** the dashboard uses. If the dashboard is
     `oc-bot-1.tailXXXX.ts.net`, this PC must appear in the same
     `https://login.tailscale.com/admin/machines` list as `oc-bot-1`.
   - Confirm: open PowerShell (Win key, type `powershell`, Enter) and type:

     ```powershell
     tailscale status
     ```

     The first line should show this PC's name and IP. If `tailscale` is not
     recognized, use the full path:
     `& "C:\Program Files\Tailscale\tailscale.exe" status`.
   - The machine name must be lowercase letters, digits, and hyphens only
     (the dashboard rejects anything else). To rename: open
     `https://login.tailscale.com/admin/machines`, click the **...** menu next
     to this PC, click **Edit machine name...**, type e.g. `win-node-1`,
     click **Update**.
3. **MagicDNS + HTTPS certificates enabled on the tailnet** (one-time,
   tailnet-wide): see the
   ["Before you start" section of node-setup.md](node-setup.md#before-you-start-one-time-tailnet-settings).
4. **WSL2 enabled**:
   - Open PowerShell and type:

     ```powershell
     wsl --status
     ```

   - If you see `Default Version: 2`, you are done with this step.
   - If WSL is not installed: open PowerShell **as Administrator**
     (Win key, type `powershell`, right-click **Windows PowerShell**, click
     **Run as administrator**) and type:

     ```powershell
     wsl --install
     ```

     Reboot when prompted, then re-check `wsl --status`.
   - If WSL is installed but defaults to version 1, type:

     ```powershell
     wsl --set-default-version 2
     ```

OpenClaw Windows support requires **OpenClaw v2026.6.1 or later**.

---

## 2. Path A — Windows Hub app, "Set up locally" (recommended)

The OpenClaw Windows Hub app (WinUI, no admin rights needed) can provision an
app-owned WSL2 gateway distro for you.

1. Open the OpenClaw releases page:
   `https://github.com/openclaw/openclaw/releases`.
2. Under the latest release (v2026.6.1 or newer), click the Windows Hub
   installer asset (the `.msix` / `OpenClaw-Hub-Setup-*.exe` file) to download
   it.
3. Double-click the downloaded file and click **Install**. No administrator
   prompt should appear — the Hub installs per-user.
4. Launch **OpenClaw Hub** from the Start menu.
5. On the first-run screen, click **Set up locally** (not *Remote gateway* —
   that mode only connects to a gateway hosted elsewhere and does not make
   this PC a fleet node).
6. The Hub provisions its own WSL2 distro and installs the gateway inside it.
   Wait for the progress screen to reach **Gateway running**.
7. When the pairing screen appears, follow it: it shows a pairing code /
   QR — confirm the same code in the Hub window and click **Approve** to pair
   the Hub UI with its local gateway.
8. Verify from PowerShell (not admin):

   ```powershell
   curl.exe http://localhost:18789/health
   ```

   Expect a small JSON body with HTTP 200. `18789` is the OpenClaw default
   gateway port; if you changed it in the Hub's **Settings → Gateway → Port**,
   use that number everywhere below.

> The gateway binds **loopback inside WSL**. That is correct and expected —
> steps 4 and 5 make it reachable from the tailnet.

Now continue at **step 4 (Networking)**.

---

## 3. Path B — Manual WSL2 gateway

Use this if you prefer a plain WSL distro you manage yourself (no Hub app).

1. Install a distro (skip if you already have one):

   ```powershell
   wsl --install -d Ubuntu
   ```

   Set a username/password when prompted.
2. Enable systemd inside the distro (needed so the gateway survives reboots).
   In the WSL shell:

   ```bash
   sudo tee /etc/wsl.conf >/dev/null <<'EOF'
   [boot]
   systemd=true
   EOF
   ```

   Then back in PowerShell:

   ```powershell
   wsl --shutdown
   ```

   and reopen the distro (Start menu → **Ubuntu**).
3. Inside the distro, run the OpenClaw Linux quickstart (per the official
   OpenClaw docs for your release):

   ```bash
   curl -fsSL https://openclaw.ai/install.sh | bash
   openclaw onboard --install-daemon
   ```

   The `--install-daemon` flag installs and enables the gateway as a systemd
   user service.
4. Make the user service start without an interactive login:

   ```bash
   loginctl enable-linger "$USER"
   systemctl --user status openclaw-gateway
   ```

   Expect `active (running)`.
5. Confirm the gateway answers inside WSL:

   ```bash
   curl http://127.0.0.1:18789/health
   ```

   Expect HTTP 200 with JSON.

Continue at **step 4 (Networking)**.

---

## 4. Networking — make the WSL gateway reachable from Windows

The gateway listens on loopback **inside** WSL. `tailscale serve` (step 5)
runs on the **Windows** side and proxies to `127.0.0.1:18789` **on Windows** —
so Windows must be able to reach the WSL port at its own localhost. Pick
**one** of the two options below. Test first — it may already work:

```powershell
curl.exe http://localhost:18789/health
```

If that returns JSON, networking is already fine — skip to step 5.

### 4A. Mirrored networking mode (preferred — Windows 11 22H2+, WSL 2.0+)

Mirrored mode makes WSL share the Windows network interfaces, so loopback is
genuinely shared in both directions and survives reboots with zero
maintenance.

1. Check your WSL version:

   ```powershell
   wsl --version
   ```

   `WSL version: 2.0.0` or higher is required. If lower, type
   `wsl --update` and check again.
2. Create or edit the WSL config file. In PowerShell, type:

   ```powershell
   notepad "$env:USERPROFILE\.wslconfig"
   ```

   Click **Yes** if Notepad asks to create the file. Make sure it contains:

   ```ini
   [wsl2]
   networkingMode=mirrored
   ```

   Save (**Ctrl + S**) and close Notepad.
3. Restart WSL:

   ```powershell
   wsl --shutdown
   ```

   Then reopen your distro (or relaunch the Hub app) so the gateway starts
   again.
4. Verify from PowerShell:

   ```powershell
   curl.exe http://localhost:18789/health
   ```

   Expect HTTP 200 JSON.

### 4B. `netsh portproxy` fallback (Windows 10, or NAT-mode WSL)

If mirrored mode is unavailable, forward the port manually.

1. Find the WSL IP. In PowerShell:

   ```powershell
   wsl hostname -I
   ```

   Note the **first** address, e.g. `172.21.34.5`.
2. In WSL, the gateway must listen on `0.0.0.0` (not only `127.0.0.1`) for
   the proxy to reach it — set the gateway bind address to `0.0.0.0` in its
   config (Hub: **Settings → Gateway → Bind address**; manual: the gateway
   config file) and restart it. Keep the tailnet as the only inbound path —
   do **not** open 18789 in Windows Defender Firewall to the LAN.
3. Open PowerShell **as Administrator** and add the proxy rule (substitute
   your WSL IP):

   ```powershell
   netsh interface portproxy add v4tov4 listenaddress=127.0.0.1 listenport=18789 connectaddress=172.21.34.5 connectport=18789
   ```

4. Verify (regular PowerShell):

   ```powershell
   curl.exe http://localhost:18789/health
   ```

5. **Important**: the WSL IP changes on every reboot. Re-run steps 1 and 3
   after each reboot, or create a logon Scheduled Task that refreshes the
   rule:

   ```powershell
   $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -WindowStyle Hidden -Command "$ip=(wsl hostname -I).Trim().Split('' '')[0]; netsh interface portproxy delete v4tov4 listenaddress=127.0.0.1 listenport=18789; netsh interface portproxy add v4tov4 listenaddress=127.0.0.1 listenport=18789 connectaddress=$ip connectport=18789"'
   $trigger = New-ScheduledTaskTrigger -AtLogOn
   Register-ScheduledTask -TaskName "OpenClaw WSL portproxy" -Action $action -Trigger $trigger -RunLevel Highest
   ```

---

## 5. Expose over the tailnet with `tailscale serve`

`tailscale serve` terminates HTTPS with a valid tailnet certificate and
proxies to the local port. Run this **on Windows** (PowerShell, no admin
needed if your user is the Tailscale operator; otherwise run as
Administrator):

```powershell
tailscale serve --bg 18789
```

If `tailscale` is not on PATH, use the full executable path (the Windows
client installs it at `C:\Program Files\Tailscale\tailscale.exe`):

```powershell
& "C:\Program Files\Tailscale\tailscale.exe" serve --bg 18789
```

This maps `https://<pcname>.<tailnet>.ts.net/` (tailnet port 443) to
`http://127.0.0.1:18789` and persists across reboots (`--bg`).

Check the mapping:

```powershell
tailscale serve status
```

Expected output includes a line like:

```text
https://win-node-1.tailXXXX.ts.net/
|-- / proxy http://127.0.0.1:18789
```

> Shortcut: [`scripts/windows/install-node.ps1`](../../scripts/windows/install-node.ps1)
> performs steps 4-check, 5, and 6 in one go:
>
> ```powershell
> powershell -ExecutionPolicy Bypass -File .\install-node.ps1 -GatewayPort 18789
> ```

---

## 6. Verify end to end

From **another machine on the tailnet** (for example the dashboard host):

```bash
curl https://<pcname>.<tailnet>.ts.net/health
```

Substitute your PC's tailnet machine name and your MagicDNS suffix, e.g.
`curl https://win-node-1.tail1234.ts.net/health`. Expect HTTP 200 with a
small JSON body. The **first** request can take 10–30 seconds while the TLS
certificate is issued — retry once before concluding anything is broken.

---

## 7. Register the node in the dashboard

### Option 1 — dashboard UI

1. Open the dashboard in a browser:
   `https://oc-bot-1.<tailnet>.ts.net:8443` (substitute your dashboard host).
2. Go to the **Fleet** section and open the **Mesh** / **Nodes** panel.
3. Click **Discover**. The dashboard lists every tailnet peer it can see and
   flags which are already registered.
4. Click **Register** next to this PC (or add it manually) and fill in:
   - **Hostname**: the tailnet machine name (e.g. `win-node-1`) — lowercase
     letters, digits, hyphens only.
   - **Port**: `443` (tailscale serve listens on 443; only change this if you
     used `tailscale serve --bg --https=<port> ...`).
   - **Health path**: `/health`.
   - **Platform**: `windows-wsl`.
5. Click **Register**. Within one poll interval (15 seconds by default) the
   node shows **online** with a latency reading.

### Option 2 — `register-node.ps1` (from this PC)

```powershell
powershell -ExecutionPolicy Bypass -File .\register-node.ps1 -DashboardUrl "https://oc-bot-1.<tailnet>.ts.net:8443"
```

Defaults: hostname = this PC's name lowercased, port `443`, platform
`windows-wsl`. See [`scripts/windows/README.md`](../../scripts/windows/README.md).

### Option 3 — raw API call (from any tailnet machine)

```bash
curl -X POST "https://oc-bot-1.<tailnet>.ts.net:8443/api/fleet/mesh/nodes" \
  -H 'Content-Type: application/json' \
  -H 'Tailscale-User-Login: you@example.com' \
  -d '{"hostname":"win-node-1","port":443,"healthPath":"/health","platform":"windows-wsl","label":"Office Windows PC"}'
```

---

## 8. Keep it always on (power settings)

A fleet node is only useful if it stays awake. In PowerShell **as
Administrator**:

```powershell
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /change monitor-timeout-ac 10
```

This disables sleep and hibernation on AC power (the monitor may still turn
off — that is fine). Also: **Settings → System → Power** → set
**When plugged in, put my device to sleep after** to **Never**.

WSL itself idles out by default only when no process is running; the systemd
gateway service (Path B) or the Hub-managed distro (Path A) keeps it alive.

---

## 9. Troubleshooting

| Symptom | Check / Fix |
| --- | --- |
| `curl https://<pcname>...ts.net/health` hangs or TLS error on first try | Tailnet certificate still being issued. Wait 30 s and retry. If it persists: HTTPS certificates not enabled on the tailnet — see [node-setup.md](node-setup.md#before-you-start-one-time-tailnet-settings). |
| `tailscale serve` prints `certificate ... pending` or serve status shows no HTTPS line | Same as above — MagicDNS + HTTPS certs must be enabled at `https://login.tailscale.com/admin/dns`. Re-run `tailscale serve status` after enabling. |
| `curl.exe http://localhost:18789/health` fails on Windows but works inside WSL | WSL networking mode issue. NAT-mode localhost forwarding is flaky — switch to mirrored mode (step 4A) or add the portproxy rule (step 4B). After editing `.wslconfig`, you must run `wsl --shutdown` for it to take effect. |
| Portproxy worked yesterday, dead today | WSL NAT IP changed on reboot. Re-run `wsl hostname -I` and recreate the rule, or install the Scheduled Task from step 4B.5. |
| Mirrored mode set but ports still unreachable | Confirm `wsl --version` reports 2.0.0+; confirm `.wslconfig` is in `%USERPROFILE%` (not inside WSL); run `wsl --shutdown` and relaunch. Some VPN clients conflict with mirrored mode — test with the VPN disconnected. |
| Works locally, unreachable from other tailnet machines | `tailscale serve status` — is the proxy line present? Is this PC shown as connected in `tailscale status`? Tailscale serve only accepts tailnet traffic, so no Windows Firewall rule is needed — but check that the **Tailscale** service is Running (`Get-Service Tailscale`). |
| Windows Defender Firewall prompt appeared during setup | Allow access for Tailscale. Do **not** add a public inbound rule for 18789 — the gateway should only be reachable via the tailnet. |
| Node registered but shows `offline` in the dashboard | The dashboard polls `https://<hostname>.<suffix>.ts.net:<port><healthPath>`. Verify port `443` (not `18789`) was registered, and that step 6 passes from the dashboard host itself. |
| Node goes offline overnight | PC slept. Apply step 8, and check **Settings → System → Power → Screen and sleep**. On laptops, also set the lid-close action to **Do nothing** (Control Panel → Power Options → Choose what closing the lid does). |
| `Invalid hostname` at registration | The tailnet machine name contains uppercase or other characters. Rename at `https://login.tailscale.com/admin/machines` to match `^[a-z0-9-]+$`. |
| `Invalid platform` at registration | Use exactly `windows-wsl` (valid values: `linux`, `windows-wsl`, `macos`, `unknown`). |
