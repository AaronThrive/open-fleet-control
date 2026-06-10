# Node Setup Guide

This guide walks through onboarding a machine ("node") so the OpenFleetControl
dashboard can monitor it over your tailnet. Follow it literally — every step
tells you exactly where to click or what to type.

## How node monitoring works

The dashboard polls every registered node at:

```
https://<hostname>.<your-magicdns-suffix>:<port><healthPath>
```

Defaults: port `443`, health path `/health`, protocol always HTTPS. A node is
therefore "ready" when:

1. It is joined to the **same tailnet** as the dashboard.
2. MagicDNS and HTTPS certificates are enabled on that tailnet.
3. Its OpenClaw gateway `/health` endpoint is reachable over tailnet HTTPS on
   port 443 (or a custom port you supply at registration time).

The dashboard discovers the MagicDNS suffix at runtime from Tailscale status —
nothing about your tailnet name is hardcoded anywhere.

## Before you start: one-time tailnet settings

1. Open `https://login.tailscale.com/admin/dns` in your browser.
2. Under **MagicDNS**, confirm it shows **Enabled**. If not, click
   **Enable MagicDNS**.
3. On the same page, under **HTTPS Certificates**, click
   **Enable HTTPS** and confirm.
4. Note your tailnet DNS name shown at the top of the page (it looks like
   `tail1234.ts.net` or `your-org.ts.net`). You will substitute it everywhere
   you see `<tailnet>` below.
5. To pre-authorize machines, create an auth key: go to
   `https://login.tailscale.com/admin/settings/keys`, click
   **Generate auth key**, toggle **Reusable** on, optionally add a tag such as
   `tag:openclaw`, click **Generate key**, and copy the `tskey-auth-...` value
   somewhere safe.

---

## Option A — Linux host node (gateway runs directly on the host)

Use this when the OpenClaw gateway runs as a normal process on a Linux box.

1. Install Tailscale:

   ```bash
   curl -fsSL https://tailscale.com/install.sh | sh
   ```

2. Join the tailnet (pick a lowercase, hyphenated hostname — the dashboard
   only accepts `a-z`, `0-9`, and `-`):

   ```bash
   sudo tailscale up --hostname my-node-1 --auth-key tskey-auth-XXXXXXXXXXXX
   ```

   If you omit `--auth-key`, a login URL is printed — open it in a browser and
   approve the machine.

3. Confirm the node is up:

   ```bash
   tailscale status
   ```

   You should see `my-node-1` in the first line of output.

4. Expose the gateway over tailnet HTTPS. If your gateway listens on port
   `18789` (the OpenClaw default), type:

   ```bash
   tailscale serve --bg 18789
   ```

   This proxies `https://my-node-1.<tailnet>.ts.net` (port 443) to
   `127.0.0.1:18789` and keeps doing so across reboots.

5. Verify the serve mapping:

   ```bash
   tailscale serve status
   ```

   Expected output includes a line like
   `https://my-node-1.<tailnet>.ts.net/ proxy http://127.0.0.1:18789`.

6. Verify end to end **from another machine on the tailnet**:

   ```bash
   curl https://my-node-1.<tailnet>.ts.net/health
   ```

   Expect an HTTP 200 with a small JSON body. The first request may take a few
   seconds while the TLS certificate is issued.

---

## Option B — Appliance node (openclaw-stack Tailscale sidecar)

Use this when the node is an `openclaw-stack` appliance instance. Each
instance runs its own `tailscale/tailscale` sidecar container, and the serve
configuration is **declarative**: it is rendered from a template and applied
automatically at sidecar startup via `TS_SERVE_CONFIG` — you never run
`tailscale serve` by hand.

How the flow works:

- `config/tailscale-serve.json.template` is rendered by
  `scripts/render-config.sh` into `$STATE_ROOT/tailscale-serve/serve.json`.
- That file is mounted read-only into the sidecar at
  `/config/serve/serve.json`.
- The sidecar's `TS_SERVE_CONFIG=/config/serve/serve.json` environment variable
  makes it apply the mapping (tailnet `443` to the loopback gateway port) every
  time it starts.

Steps:

1. In the `openclaw-stack` checkout, open `.env` (copied from
   `secrets/.env.example`) and set:

   ```bash
   TAILSCALE_HOSTNAME=openclaw-clientbox
   TAILSCALE_FQDN=openclaw-clientbox.<tailnet>.ts.net
   TAILSCALE_AUTHKEY_REF="op://<vault>/Tailscale/auth_key"   # or TAILSCALE_AUTHKEY=tskey-auth-...
   ```

2. Run the installer with the sidecar mode:

   ```bash
   ./scripts/install.sh --instance clientbox --tailscale sidecar
   ```

   Type `INSTALL` when prompted.

3. After the stack is up, verify the sidecar joined the tailnet:

   ```bash
   docker exec clientbox-tailscale tailscale status
   ```

4. Verify health over the tailnet from another machine:

   ```bash
   curl https://openclaw-clientbox.<tailnet>.ts.net/health
   ```

5. To change the serve mapping later: edit `.env`, re-run
   `./scripts/render-config.sh`, then restart the sidecar
   (`docker restart clientbox-tailscale`). Do not edit
   `$STATE_ROOT/tailscale-serve/serve.json` directly — it is overwritten on the
   next render.

---

## Option C — Windows node (gateway in WSL)

Use this when the OpenClaw gateway runs inside WSL2 on a Windows machine.

### C1. Join Windows to the tailnet

1. Download the Tailscale Windows client from
   `https://tailscale.com/download/windows` and run the installer.
2. Click the Tailscale icon in the system tray, click **Log in**, and sign in
   to the **same tailnet** as the dashboard.
3. Right-click the tray icon, open **Preferences**, and confirm the machine
   name. To change it, go to `https://login.tailscale.com/admin/machines`,
   click the **...** menu next to the machine, click **Edit machine name**,
   type a lowercase hyphenated name (for example `win-node-1`), and click
   **Update**.

### C2. Expose the WSL gateway (preferred: `tailscale serve` on Windows)

WSL2 forwards `localhost` ports to Windows by default, so the Windows-side
Tailscale can usually proxy straight to the WSL gateway:

1. Start the gateway inside WSL (it should listen on `0.0.0.0` or
   `localhost:18789`).
2. Open **PowerShell as Administrator** (press the Windows key, type
   `powershell`, right-click **Windows PowerShell**, click
   **Run as administrator**).
3. Type:

   ```powershell
   tailscale serve --bg 18789
   ```

4. Verify:

   ```powershell
   tailscale serve status
   ```

### C2-alternative. `netsh` port forward (when localhost forwarding fails)

If `curl http://localhost:18789/health` from Windows PowerShell does **not**
work (some WSL networking modes break localhost forwarding):

1. In PowerShell (Administrator), find the WSL IP:

   ```powershell
   wsl hostname -I
   ```

   Note the first address, for example `172.21.34.5`.

2. Add the port proxy:

   ```powershell
   netsh interface portproxy add v4tov4 listenport=18789 listenaddress=127.0.0.1 connectport=18789 connectaddress=172.21.34.5
   ```

3. Re-run `tailscale serve --bg 18789`.
4. Note: the WSL IP changes on reboot. Either re-run step 1-2 after each
   reboot, or create a logon Scheduled Task that refreshes the portproxy rule.

### C3. Verify

From another machine on the tailnet:

```bash
curl https://win-node-1.<tailnet>.ts.net/health
```

Expect HTTP 200.

### Windows Hub app note

The Windows Hub app (v2026.6.1 and later) connects to **remote** gateways
directly by URL + token: in the Hub app, open **Settings**, choose
**Remote gateway**, paste `https://<hostname>.<tailnet>.ts.net` as the URL and
your gateway token, and click **Connect**. A machine that only runs the Hub
app this way does not need any of the port-forwarding steps above — those are
only required when the Windows machine itself hosts a gateway that the fleet
dashboard should monitor.

---

## Register the node in Fleet Control

1. Open the dashboard in your browser:
   `https://<dashboard-hostname>.<tailnet>.ts.net`.
2. Go to the **Fleet** section and open the **Nodes** panel.
3. Click **Discover**. The dashboard lists every tailnet peer it can see, with
   a flag showing whether each is already registered.
4. Click **Register** next to your node (or add it manually) and fill in:
   - **Hostname**: the tailnet machine name, lowercase letters, digits, and
     hyphens only (for example `my-node-1`).
   - **Port**: `443` unless you serve health on a custom port.
   - **Health path**: `/health` (the default).
   - **Platform**: `linux`, `windows-wsl`, or `macos`.
5. Equivalent API call, if you prefer the terminal:

   ```bash
   curl -X POST https://<dashboard-hostname>.<tailnet>.ts.net/api/fleet/nodes \
     -H 'Content-Type: application/json' \
     -d '{"hostname":"my-node-1","port":443,"healthPath":"/health","platform":"linux"}'
   ```

6. Within one poll interval (15 seconds by default) the node should show
   **online** with a latency reading.

## Troubleshooting

| Symptom                                        | Check                                                                                                                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Node shows `unreachable`                       | `tailscale status` on the node — is it online in the tailnet? Is the dashboard on the same tailnet?                                                                |
| Node shows `offline` but Tailscale says online | `tailscale serve status` on the node — is 443 proxied to the gateway port? Is the gateway process actually running (`curl http://127.0.0.1:18789/health` locally)? |
| TLS errors on first request                    | HTTPS certificates not enabled on the tailnet, or first-issue delay — retry after 30 seconds.                                                                      |
| `Invalid hostname` at registration             | Hostname must match `^[a-z0-9-]+$` — rename the machine in the Tailscale admin console.                                                                            |
| Discover shows nothing                         | The dashboard cannot reach Tailscale status (CLI or local API). See the client install guide for the sidecar's `TAILSCALE_LOCAL_API_ENDPOINT` wiring.              |
